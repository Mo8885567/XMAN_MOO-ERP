/**
 * ============================================================
 * Module: Code_12b_SheetHelpers.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * [SHEETS-RETRY-FIX] _withSheetsRetry — يلف أي نداء لخدمة Google Sheets
 * (SpreadsheetApp) بإعادة محاولة تلقائية مع exponential backoff.
 *
 * السبب: أخطاء زي "حدث خطأ أثناء وصول خدمة جداول البيانات إلى مستند
 * رقم تعريفه ..." هي أخطاء داخلية مؤقتة من جوجل نفسها (مش من منطق
 * الكود) بتحصل عادةً لما فيه أكتر من نداء بيوصل لنفس الملف بالتوازي
 * (زي الـ preloads اللي بتشتغل في الخلفية بعد اللوجين). قبل الإصلاح
 * ده، أي هبّة عابرة كانت بتفشل من أول مرة وتظهر كخطأ في الكونسول
 * فورًا، مع إن لو اتعادت المحاولة بعد جزء من الثانية كانت هتنجح.
 *
 * @param {Function} fn - الكود اللي بينادي SpreadsheetApp (بدون args)
 * @param {Number} [maxRetries] - عدد المحاولات الإضافية (افتراضي 3)
 * @returns {*} ناتج fn() لو نجح، أو يرمي آخر خطأ لو فشلت كل المحاولات
 */
function _withSheetsRetry(fn, maxRetries) {
  maxRetries = maxRetries == null ? 3 : maxRetries;
  var lastErr = null;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      var msg = String((e && e.message) || e || "");
      // نعيد المحاولة بس لو الخطأ من النوع المؤقت (وصول/خدمة جداول
      // البيانات)، مش لو كان خطأ منطقي حقيقي (زي "غير موجود"/صلاحيات).
      var isTransient =
        /حدث خطأ أثناء وصول خدمة جداول البيانات/.test(msg) ||
        /Service Spreadsheets failed/i.test(msg) ||
        /internal error/i.test(msg) ||
        /try again/i.test(msg);
      if (!isTransient || attempt === maxRetries) throw e;
      // exponential backoff: 300ms, 600ms, 1200ms...
      Utilities.sleep(300 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/**
 * preserveTextNumber — حوّل أي قيمة إلى نص نظيف بدون أي تحويل رقمي
 * استخدمها دايمًا قبل تخزين: هاتف / واتساب / كود / SKU / Barcode / رقم قومي ...إلخ
 * @param {*} value
 * @returns {string}
 */
function preserveTextNumber(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * _isTextProtectedColumn — هل اسم العمود ده محتاج صيغة نص إجبارية؟
 * @param {string} headerName
 * @returns {boolean}
 */
function _isTextProtectedColumn(headerName) {
  var h = String(headerName || "")
    .toLowerCase()
    .trim();
  if (!h) return false;
  return TEXT_PROTECTED_COLUMN_PATTERNS.some(function (re) {
    return re.test(h);
  });
}

/**
 * _protectTextColumns — يضبط صيغة الأعمدة المحمية في شيت معيّن على '@' (نص)
 * بحيث أي قيمة تُكتب فيها بعد ذلك (حتى لو شكلها رقم) تُحفظ كنص بدون
 * فقدان الصفر الأول. آمنة الاستدعاء المتكرر (idempotent) ولا تمسح أي بيانات.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string[]} headers
 */
function _protectTextColumns(sheet, headers) {
  try {
    if (!sheet || !headers || !headers.length) return;
    // نغطي عدد صفوف كبير بما يكفي لأي نمو مستقبلي للبيانات
    var maxRows = Math.max(sheet.getMaxRows(), 5000);
    headers.forEach(function (h, i) {
      if (_isTextProtectedColumn(h)) {
        sheet.getRange(1, i + 1, maxRows, 1).setNumberFormat("@");
      }
    });
  } catch (e) {
    // أي خطأ في التنسيق لا يجب أن يوقف العملية الأساسية (الحفظ/الإنشاء)
    console.error("_protectTextColumns:", e.message);
  }
}

/**
 * _appendRowProtected — بديل آمن لـ sheet.appendRow() للصفوف اللي فيها
 * أعمدة محمية (هاتف/كود/SKU...). نستخدمها بدل appendRow العادية لأن
 * appendRow بيتجاهل تنسيق '@' المُحدَّد على العمود من قبل في بعض الحالات
 * (خلل معروف في Google Apps Script) ويحوّل الرقم النصي لرقم فيفقد الصفر
 * الأول حتى لو العمود نفسه متنسّق كـ "نص" أصلاً.
 *
 * الحل: نحسب رقم الصف الجديد بنفسنا، نثبّت تنسيق '@' على خلايا الأعمدة
 * المحمية في هذا الصف بالذات *قبل* الكتابة، وبعدين نكتب بـ setValues()
 * (مش appendRow) لأن setValues بتحترم التنسيق المُحدَّد مسبقًا دايمًا.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string[]} headers
 * @param {Array} row
 */
function _appendRowProtected(sheet, headers, row) {
  // [SEC-FIX-STAB1] إضافة LockService حول كامل مسار Read-Then-Write
  // (getLastRow ثم setValues) — نفس نمط القفل المستخدم فعليًا في
  // DeleteEngine (BUG-009/BUG-010) لكنه كان غائبًا هنا رغم إن هذه الدالة
  // هي أكثر نقطة كتابة مستخدمة في النظام (14+ ملف). بدون القفل، نداءين
  // متزامنين ممكن ياخدوا نفس nextRow فيحصل استبدال صف بصف (فقدان بيانات
  // صامت) — خصوصًا في القيود المحاسبية والسندات. القفل هنا يغطي الحسبة
  // والكتابة سوا كـ Critical Section واحدة، بنفس فلسفة DeleteEngine.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    console.error("_appendRowProtected: lock timeout", lockErr && lockErr.message);
    // ✋ لا نستخدم fallback صامت هنا (زي الكود القديم) — النظام مشغول
    // بعملية كتابة أخرى، والأفضل رفع الخطأ للمستدعي في سياق مالي بدل
    // الكتابة بدون حماية أو تجاهل الخطأ.
    throw new Error("النظام مشغول بعملية حفظ أخرى، حاول مرة أخرى (appendRow lock timeout)");
  }
  try {
    var nextRow = sheet.getLastRow() + 1;
    if (headers && headers.length) {
      headers.forEach(function (h, i) {
        if (_isTextProtectedColumn(h)) {
          sheet.getRange(nextRow, i + 1).setNumberFormat("@");
        }
      });
    }
    var targetRange = sheet.getRange(nextRow, 1, 1, row.length);
    // 🎨 [FIX] إعادة ضبط لون الخط الافتراضي (أسود/تلقائي) على الصف الجديد
    // قبل الكتابة — يمنع وراثة تنسيق قديم متبقٍّ في الخلية (مثلاً خط أبيض
    // من صف اتمسح محتواه قبل كده بدون Clear Formatting) يخلي البيانات
    // الجديدة تظهر "مخفية" بصريًا رغم إنها موجودة فعليًا في الشيت.
    targetRange.setFontColor(null);
    targetRange.setValues([row]);
  } catch (e) {
    console.error("_appendRowProtected:", e.message);
    // ✋ [SEC-FIX-STAB1] تمت إزالة fallback الصامت لـ sheet.appendRow()
    // القديم — كان بيعيد نفس مشكلة الـ race من غير أي حماية لو حصل خطأ
    // غير متوقع جوه try. نرفع الخطأ للمستدعي بدل الكتابة غير المحمية.
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * fixAllWhiteFontInSheets — إصلاح لمرة واحدة (يدوي) لأي بيانات محفوظة
 * قبل كده بلون خط أبيض/فاتح فبقت "مخفية" بصريًا على خلفية بيضاء.
 * يمسح لون الخط (setFontColor(null) = تلقائي/أسود) من كل خلايا البيانات
 * (بعد صف الهيدر) في كل الشيتات، بدون ما يلمس أي قيم أو تنسيقات تانية
 * (خلفية، حدود، إلخ).
 *
 * طريقة التشغيل: من محرر Apps Script → اختار الفنكشن دي من القائمة
 * المنسدلة فوق → زرار Run. تشغيلها مرة كافي؛ آمنة التكرار (idempotent).
 */
function fixAllWhiteFontInSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var fixedCount = 0;
  sheets.forEach(function (sheet) {
    try {
      var lastRow = sheet.getLastRow();
      var lastCol = sheet.getLastColumn();
      if (lastRow <= 1 || lastCol < 1) return; // لا بيانات (غير صف الهيدر)
      // نبدأ من الصف 2 عشان منلمسش تنسيق الهيدر (أبيض على خلفية ملوّنة عادةً ومقصود)
      sheet.getRange(2, 1, lastRow - 1, lastCol).setFontColor(null);
      fixedCount++;
    } catch (e) {
      console.error("fixAllWhiteFontInSheets:", sheet.getName(), e.message);
    }
  });
  console.log("✅ تم فحص/إصلاح لون الخط في " + fixedCount + " شيت.");
}

/**
 * _ensureTextColumnsProtected — نفس وظيفة _protectTextColumns بالضبط، لكنها
 * "ذاتية الإصلاح" (self-healing) مرة واحدة فقط لكل شيت طوال عمر المشروع
 * (مش كل مرة بيتفتح فيها الشيت) — بنستخدم DocumentProperties كعلامة دائمة
 * (بتفضل محفوظة بين كل تنفيذ وتنفيذ، عكس الكاش العادي اللي بيُمسح كل مرة).
 *
 * ❗ السبب: شيتات زي "الموظفين"/"العملاء"/"خطوط فودافون كاش" كانت موجودة
 * بالفعل قبل تفعيل هذه الحماية، فـ getSheet() العادية بتحميها بس وقت
 * إنشاء شيت جديد أو إضافة عمود جديد — مش الأعمدة القديمة الموجودة فعليًا.
 * هذه الدالة تغطي بالضبط هذا السيناريو تلقائيًا من أول استخدام بعد التحديث،
 * بدون أي تكلفة أداء متكررة في كل تنفيذ بعد أول مرة.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string[]} headers
 */
function _ensureTextColumnsProtected(sheet, headers) {
  try {
    if (!sheet || !headers || !headers.length) return;
    var props = PropertiesService.getDocumentProperties();
    var marker = "TEXTPROTECT_v1_" + sheet.getSheetId();
    if (props.getProperty(marker) === "1") return; // تمت الحماية قبل كده فعليًا
    _protectTextColumns(sheet, headers);
    props.setProperty(marker, "1");
  } catch (e) {
    console.error("_ensureTextColumnsProtected:", e.message);
  }
}

/**
 * fixLeadingZeroFormatting — دالة صيانة تُشغَّل مرة واحدة يدويًا من
 * Apps Script Editor (Run → fixLeadingZeroFormatting) لتطبيق حماية
 * الصفر الأول بأثر رجعي على كل الشيتات الموجودة فعليًا في المشروع.
 *
 * ⚠️ ملاحظة مهمة: لو رقم فُقد صفره الأول *قبل* تشغيل هذه الدالة،
 * فهذا التابع لا يستطيع استرجاع البيانات المفقودة فعليًا (لأنها
 * أصلاً اتحفظت ناقصة) — هو فقط يمنع تكرار المشكلة في كل الإدخالات
 * الجديدة والتعديلات القادمة. لإصلاح بيانات قديمة تالفة لازم مراجعة
 * يدوية للأرقام (مثلاً موبايل مصري ١٠ خانات بادئ بـ ١/٢ غالبًا ناقصه صفر).
 *
 * @returns {string} ملخص نصي بنتيجة التنفيذ (يظهر في الـ Logger/الـ Alert)
 */
function fixLeadingZeroFormatting() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var allHeaderSets = [];

  // كل الـ headers المعروفة في النظام (المخزون/الإنتاج/الحركات...)
  Object.keys(HEADERS).forEach(function (name) {
    allHeaderSets.push({ name: name, headers: HEADERS[name] });
  });
  Object.keys(ACCOUNTING_HR_HEADERS).forEach(function (name) {
    allHeaderSets.push({ name: name, headers: ACCOUNTING_HR_HEADERS[name] });
  });
  allHeaderSets.push({ name: "Warehouses", headers: WAREHOUSE_HEADERS });
  allHeaderSets.push({ name: "WarehouseAccess", headers: WH_ACCESS_HEADERS });
  allHeaderSets.push({ name: "Roles", headers: ROLES_HEADERS });
  allHeaderSets.push({ name: "UserPermissions", headers: USER_PERM_HEADERS });
  allHeaderSets.push({ name: "AuditLog", headers: AUDIT_HEADERS });
  allHeaderSets.push({
    name: "WeeklyReportConfig",
    headers: WEEKLY_REPORT_HEADERS,
  });
  allHeaderSets.push({ name: "Customers", headers: CUSTOMER_HEADERS });
  allHeaderSets.push({ name: "Suppliers", headers: SUPPLIER_HEADERS });
  allHeaderSets.push({
    name: "SaleInvoices",
    headers: SALE_INVOICE_HEADERS,
  });
  allHeaderSets.push({
    name: "PurchaseInvoices",
    headers: PURCHASE_INVOICE_HEADERS,
  });
  allHeaderSets.push({
    name: "SaleReturns",
    headers: SALE_RETURN_HEADERS,
  });
  allHeaderSets.push({
    name: "PurchaseReturns",
    headers: PURCHASE_RETURN_HEADERS,
  });
  allHeaderSets.push({
    name: "VodafoneCashLines",
    headers: VFC_LINES_HEADERS,
  });
  allHeaderSets.push({
    name: "VodafoneCashTransactions",
    headers: VFC_TX_HEADERS,
  });

  var fixed = [];
  var skipped = [];
  var props = PropertiesService.getDocumentProperties();

  allHeaderSets.forEach(function (entry) {
    var sheet = ss.getSheetByName(entry.name);
    if (!sheet) {
      skipped.push(entry.name + " (الشيت غير موجود)");
      return;
    }
    var protectedCols = entry.headers.filter(_isTextProtectedColumn);
    if (!protectedCols.length) return; // مفيش أعمدة محتاجة حماية في هذا الشيت
    _protectTextColumns(sheet, entry.headers);
    // ✅ نسجّل علامة "تمت الحماية" بنفس آلية getSheet() الذاتية، عشان
    // متتكررش التهيئة تاني من غير فايدة في كل تنفيذ قادم
    try {
      props.setProperty("TEXTPROTECT_v1_" + sheet.getSheetId(), "1");
    } catch (e) {
      console.error("unknown - خطأ:", e.message || e);
    }
    fixed.push(entry.name + " → [" + protectedCols.join(", ") + "]");
  });

  // شيت الإعدادات العام (Settings) — عمود "value" قد يحتوي رقم هاتف الشركة
  var settingsSheet = ss.getSheetByName("Settings");
  if (settingsSheet) {
    settingsSheet
      .getRange(1, 2, Math.max(settingsSheet.getMaxRows(), 5000), 1)
      .setNumberFormat("@");
    fixed.push("Settings → [value]");
  }

  var summary =
    "✅ تم تطبيق حماية الصفر الأول على " +
    fixed.length +
    " شيت:\n" +
    fixed.join("\n") +
    (skipped.length ? "\n\n⏭️ تم تجاوز:\n" + skipped.join("\n") : "");
  Logger.log(summary);
  return summary;
}

/**
 * [PERF-BATCH-1] يطبّق تعديلات جزئية على صف واحد بأقل عدد ممكن من نداءات
 * Sheets API (نداء قراءة واحد + نداء كتابة واحد)، بدل حلقة تنادي
 * getRange().setValue() لكل عمود على حدة (نمط كان متكرر في ~13 موضع
 * بالمشروع: CashBoxes, Banking, CommunicationHub، إلخ).
 *
 * @param {Sheet} sheet - كائن الشيت.
 * @param {number} rowNum - رقم الصف (1-indexed، يشمل صف العناوين).
 * @param {Array<string>} headers - أسماء الأعمدة بترتيبها في الشيت.
 * @param {Object} updates - خريطة {اسم_العمود: القيمة_الجديدة}.
 */
function _applyRowUpdates(sheet, rowNum, headers, updates) {
  var colIndexes = Object.keys(updates)
    .map(function (key) {
      return headers.indexOf(key);
    })
    .filter(function (i) {
      return i !== -1;
    });
  if (colIndexes.length === 0) return;

  var minCol = Math.min.apply(null, colIndexes);
  var maxCol = Math.max.apply(null, colIndexes);
  var span = maxCol - minCol + 1;

  var range = sheet.getRange(rowNum, minCol + 1, 1, span);
  var rowValues = range.getValues()[0];

  Object.keys(updates).forEach(function (key) {
    var idx = headers.indexOf(key);
    if (idx !== -1) rowValues[idx - minCol] = updates[key];
  });

  range.setValues([rowValues]);
}

/**
 * [PERF-BATCH-1] appendRowsBatch — كتابة عدة صفوف بنداء واحد لـ setValues
 * بدل استدعاء appendRow() لكل صف على حدة داخل loop.
 * كل appendRow() هو رحلة اتصال منفصلة لـ Sheets API؛ فاتورة من 20 بند
 * كانت بتعمل 20 نداء appendRow (وأحيانًا أكتر مع updateStockBalance).
 * هنا بنجمع كل الصفوف في مصفوفة وبنكتبهم مرة واحدة فقط.
 *
 * @param {string} sheetName - اسم الشيت (زي "Transactions")
 * @param {Array<Array>} rows - مصفوفة صفوف، كل صف مصفوفة قيم (نفس ناتج _buildTxRow)
 * @param {Object} [customHeaders] - تمرر لـ getSheet لو محتاجة headers مخصصة
 * @returns {void}
 */
function appendRowsBatch(sheetName, rows, customHeaders) {
  if (!rows || !rows.length) return;
  const sheet = getSheet(sheetName, customHeaders);
  const startRow = sheet.getLastRow() + 1;
  const numCols = rows[0].length;
  const targetRange = sheet.getRange(startRow, 1, rows.length, numCols);
  // 🎨 [FIX] نفس إصلاح _appendRowProtected — نمسح أي لون خط قديم متبقٍّ
  // على الصفوف دي قبل الكتابة، عشان ما تطلعش بيانات "مخفية" بصريًا.
  targetRange.setFontColor(null);
  targetRange.setValues(rows);
}

function getSheet(name, customHeaders) {
  // ✅ [PERF-1] لو سبق وفحصنا نفس الشيت بنفس الـ headers في هذا التنفيذ
  // نرجّع نفس المرجع فوراً بدون أي round-trip لفحص الأعمدة من جديد
  const cacheKey = name + "|" + (customHeaders ? customHeaders.join(",") : "");
  if (_sheetCache[cacheKey]) return _sheetCache[cacheKey];

  let sheet = _withSheetsRetry(function () {
    return SS.getSheetByName(name);
  });
  if (!sheet) {
    // 🔒 [FIX-DUPLICATE-SHEET] لو أكتر من نداء وصلوا لـ getSheet لنفس الاسم
    // الجديد في نفس اللحظة (زي تحميل شاشة بتستدعي أكتر من دالة متوازية)،
    // ممكن الاتنين يشوفوا إن الشيت مش موجود ويحاولوا ينشئوه سوا، فتفشل
    // محاولة insertSheet الثانية بخطأ Google الأصلي "هناك ورقة موجودة
    // من قبل تحمل الاسم...". نحمي الإنشاء بقفل قصير + إعادة فحص بعد
    // القفل + fallback احتياطي لو حصل تعارض نادر رغم القفل.
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      sheet = SS.getSheetByName(name); // إعادة فحص بعد الحصول على القفل
      if (!sheet) {
        try {
          sheet = SS.insertSheet(name);
        } catch (creationErr) {
          // تعارض نادر جداً حصل رغم القفل (مثلاً استدعاء خارجي متزامن) —
          // نجرب نجيب الشيت اللي اتعمل فعلاً بدل ما نفشل بالكامل
          sheet = SS.getSheetByName(name);
          if (!sheet) throw creationErr;
        }
        const hdrs = customHeaders || HEADERS[name];
        if (hdrs && sheet.getLastRow() === 0) {
          sheet.appendRow(hdrs);
          styleHeaderRow(sheet, hdrs.length);
          _protectTextColumns(sheet, hdrs); // 🔒 حماية الصفر الأول من اللحظة الأولى
        }
      }
    } finally {
      lock.releaseLock();
    }
  } else {
    // ✅ تحقق إن الأعمدة الموجودة كاملة — أضف أي عمود ناقص في النهاية
    const hdrs = customHeaders || HEADERS[name];
    if (hdrs) {
      const existingHeaders = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0]
        .map(function (h) {
          return String(h || "").trim();
        });
      var addedAny = false;
      hdrs.forEach(function (h, i) {
        if (existingHeaders.indexOf(h) === -1) {
          const newCol = sheet.getLastColumn() + 1;
          sheet
            .getRange(1, newCol)
            .setValue(h)
            .setFontWeight(HEADER_STYLE.weight)
            .setBackground(HEADER_STYLE.bg)
            .setFontColor(HEADER_STYLE.color);
          addedAny = true;
        }
      });
      // 🔒 عمود جديد انضاف → نأمّنه فورًا. الأعمدة القديمة الموجودة فعليًا
      // (زي phone/code في شيتات شغّالة من قبل) تُؤمَّن مرة واحدة بس
      // تلقائيًا (self-healing) من غير أي تكلفة أداء متكررة بعد ذلك.
      if (addedAny) {
        _protectTextColumns(sheet, hdrs);
      } else {
        _ensureTextColumnsProtected(sheet, hdrs);
      }
    }
  }
  _sheetCache[cacheKey] = sheet;
  return sheet;
}

/**
 * fixProductionOrdersSheet — تصلح شيت ProductionOrders لو فيه أعمدة ناقصة أو مش في الترتيب الصح
 * شغّلها مرة واحدة من: Apps Script Editor → Run → fixProductionOrdersSheet
 */
function fixProductionOrdersSheet() {
  var sheet = SS.getSheetByName("ProductionOrders");
  if (!sheet) return "❌ شيت ProductionOrders مش موجود";

  var expectedHeaders = HEADERS.ProductionOrders;
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();

  if (lastRow < 1) return "الشيت فاضي";

  // قرا الهيدر الحالي
  var currentHeaders = sheet
    .getRange(1, 1, 1, lastCol)
    .getValues()[0]
    .map(function (h) {
      return String(h || "").trim();
    });

  // شيل الأعمدة الفاضية من النهاية
  while (currentHeaders.length && !currentHeaders[currentHeaders.length - 1])
    currentHeaders.pop();

  // لو الهيدر مطابق تماماً → مفيش مشكلة
  var same =
    expectedHeaders.every(function (h, i) {
      return currentHeaders[i] === h;
    }) && currentHeaders.length === expectedHeaders.length;
  if (same) return "✅ الشيت صح — مفيش تعديل مطلوب";

  // قرا كل البيانات الحالية
  var allData =
    lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  // امسح كل شيء وابني من أول
  sheet.clearContents();

  // اكتب الهيدر الجديد
  sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
  styleHeaderRow(sheet, expectedHeaders.length);

  if (!allData.length) return "✅ تم إصلاح الهيدر — لا توجد بيانات";

  // أعد كتابة البيانات بالتعيين الصح للأعمدة
  var newRows = allData.map(function (row) {
    var obj = {};
    currentHeaders.forEach(function (h, i) {
      if (h) obj[h] = row[i];
    });

    // sizes_json: لو اتحفظ في lining_meters خطأ، انقله
    var sizesVal = obj["sizes_json"] || "";
    var liningVal = obj["lining_meters"];
    if (!sizesVal && liningVal && String(liningVal).indexOf("{") !== -1) {
      sizesVal = liningVal;
      liningVal = 0;
    }
    // لو lining_meters فيه JSON جزئي → صفّره
    if (String(liningVal).indexOf(":") !== -1) liningVal = 0;

    return expectedHeaders.map(function (h) {
      if (h === "sizes_json") return sizesVal || "{}";
      if (h === "lining_meters") return Number(liningVal || 0);
      return obj[h] !== undefined ? obj[h] : "";
    });
  });

  if (newRows.length)
    sheet
      .getRange(2, 1, newRows.length, expectedHeaders.length)
      .setValues(newRows);

  return "✅ تم إصلاح الشيت — " + newRows.length + " صف تم ترتيبه";
}

/**
 * ✅ دالة موحّدة لقراءة بيانات أي شيت وتحويلها لـ array of objects
 */
function readSheet(sheetName, customHeaders, opts) {
  opts = opts || {};
  const sheet = getSheet(sheetName, customHeaders);
  const data = _withSheetsRetry(function () {
    return sheet.getDataRange().getValues();
  });
  if (data.length <= 1) return [];

  const headers = data[0].map((h) => String(h || "").trim());
  // ✅ يضيف permit_id مشتق من id لكل حركة بعد القراءة
  var rawRows = data.slice(1).map((row, idx) => {
    const obj = { _row: idx + 2 };
    headers.forEach((h, i) => {
      if (!h) return;
      const val = row[i];
      if (val instanceof Date) {
        obj[h] = opts.dateOnly
          ? val.toISOString().split("T")[0]
          : val.toISOString();
      } else {
        obj[h] = opts.trimStrings ? String(val ?? "").trim() : val;
      }
    });
    // parse أي عمود JSON محدد
    if (opts.parseJson) {
      opts.parseJson.forEach((col) => {
        try {
          obj[col] = obj[col] ? JSON.parse(obj[col]) : [];
        } catch (e) {
          obj[col] = [];
        }
      });
    }
    return obj;
  });
  // إضافة permit_id مشتق فقط لشيت Transactions
  if (sheetName === "Transactions") {
    rawRows.forEach(function (r) {
      r.permit_id = _getPermitId(r.id);
    });
  }
  return rawRows;
}

/**
 * دالة توافق قديمة (Legacy wrapper) — تُعيد توجيه القراءة إلى readSheet
 * مباشرة بدون خيارات إضافية. أُبقيت لأن بعض الكود القديم قد يستدعيها
 * بالاسم القديم.
 *
 * @param {String} sheetName - اسم الشيت المطلوب قراءته.
 * @returns {Array<Object>} صفوف الشيت كمصفوفة كائنات.
 */
function getSheetData(sheetName) {
  return readSheet(sheetName);
}

/**
 * يقرأ شيت المخازن (Warehouses) بالكامل مع تنسيق التواريخ والنصوص.
 * @returns {Array<Object>} قائمة المخازن.
 */
function getWarehouses() {
  return readSheet("Warehouses", WAREHOUSE_HEADERS, {
    dateOnly: true,
    trimStrings: true,
  });
}

/**
 * يُرجع مرجع شيت الرصيد الافتتاحي (OpeningStock)، مع إصلاح ذاتي
 * (self-healing) لأي شيت قديم أُنشئ قبل إضافة عمود unit_cost.
 *
 * NOTE:
 *   [MD-06 FIX] الشيتات المُنشأة قبل هذا الإصلاح كانت تحتوي 5 أعمدة
 *   فقط بدون unit_cost، مما يفقد بيانات تكلفة الوحدة تمامًا عند
 *   القراءة. هذه الدالة تتحقق من وجود العمود وتضيفه تلقائيًا إن لزم.
 *
 * @returns {Sheet} كائن الشيت (Google Sheets Sheet object).
 */
function getOpeningStockSheet() {
  var sheet = getSheet("OpeningStock", OPENING_STOCK_HEADERS);
  // [MD-06 FIX] self-healing — لو الشيت كان موجودًا من قبل بـ5 أعمدة فقط
  // (قبل إضافة unit_cost)، أضِف العمود الناقص بدل ما يضيع تمامًا عند القراءة.
  try {
    var lastCol = sheet.getLastColumn();
    var headerRow = sheet
      .getRange(1, 1, 1, Math.max(lastCol, 1))
      .getValues()[0];
    if (headerRow.indexOf("unit_cost") === -1) {
      sheet.getRange(1, lastCol + 1).setValue("unit_cost");
    }
  } catch (e) {
    // تجاهل لو تعذّر — لن يمنع باقي العملية
  }
  return sheet;
}

/**
 * يُرجع مرجع شيت الشحنات (Shipments) بترويسته القياسية الحالية (v2).
 * @returns {Sheet} كائن الشيت.
 */
function getShipmentSheet() {
  return getSheet("Shipments", SHIPMENT_HEADERS_V2);
}

/**
 * يُنظّف مصفوفة كائنات مقروءة عبر readSheet بإزالة الحقل الداخلي
 * `_row` (رقم الصف في Google Sheet) قبل إرسالها للواجهة، حتى لا
 * يُسرَّب تفصيل تخزين داخلي للـ frontend.
 *
 * @param {Array<Object>} arr - الصفوف كما تُعيدها readSheet.
 * @returns {Array<Object>} نفس البيانات بدون حقل _row.
 */
function cleanArr(arr) {
  return arr.map((item) => {
    const o = {};
    Object.keys(item).forEach((k) => {
      if (k !== "_row") o[k] = item[k];
    });
    return o;
  });
}

/**
 * ✅ makeId — يولّد ID مقروء وفريد بالصيغة:
 *   PREFIX-DD-mmm-XX
 *
 * مثال:
 *   IN-20-847-XK
 *   GRP-20-847-XK
 *
 * @param {string} prefix - البادئة (IN, OUT, TRF, GRP, WH, CLR, PO, B, T)
 * @returns {string}
 */
function makeId(prefix) {
  var now = new Date();
  var day = String(now.getDate()).padStart(2, "0");
  var ms = String(now.getMilliseconds()).padStart(3, "0");
  // [M-02 FIX] Utilities.getUuid() بدل Math.random().toString(36).substr(2,2)
  // Math.random كان يولّد فقط حرفين (36^2 = 1296 احتمال) → فرصة تصادم حقيقية
  // عند إضافة دفعات كبيرة من السجلات في نفس المللي ثانية. الجزء الأول من UUID
  // (8 أحرف hex) يعطي مساحة احتمالات أكبر بكثير مع نفس طول الـ id تقريباً
  var rand = Utilities.getUuid().split("-")[0].substr(0, 4).toUpperCase();
  return prefix + "-" + day + "-" + ms + "-" + rand;
}

function _getPermitId(txId) {
  if (!txId) return "";
  var str = String(txId);
  // لو id ينتهي بـ -رقم → شيل آخر جزء
  var match = str.match(/^(.+)-(\d+)$/);
  return match ? match[1] : str;
}

/**
 * يبحث عن أول صف تتطابق فيه قيمة الحقل key مع value (مقارنة نصية).
 * @param {Array<Object>} rows - مصفوفة الصفوف للبحث فيها.
 * @param {String} key - اسم الحقل.
 * @param {*} value - القيمة المطلوب مطابقتها.
 * @returns {Object|null} الصف المطابق أو null إن لم يوجد.
 */
function findRow(rows, key, value) {
  return rows.find((r) => String(r[key]) === String(value)) || null;
}

/**
 * يبني استجابة فشل موحّدة لإرسالها للواجهة.
 *
 * [SESSION-FIX] أُضيف حقل code اختياري بجانب message. الواجهة كانت تعتمد فقط
 * على مطابقة نص الرسالة (Arabic string matching) لاكتشاف أخطاء الجلسة، وهو
 * أسلوب هش يتكسر مع أي تعديل نصي مستقبلي. أي دالة ترفض الطلب بسبب جلسة غير
 * صالحة/منتهية يجب أن تمرر code:"SESSION_INVALID" هنا، والواجهة تعتمد على
 * الـ code وليس نص الرسالة (راجع _isSessionErrorResponse في
 * 02_JS_UI_Shell.html).
 *
 * @param {String} msg - رسالة الخطأ.
 * @param {String} [code] - كود خطأ ثابت يمكن للواجهة الاعتماد عليه برمجياً.
 * @returns {{success: false, message: String, code: (String|null)}}
 */
function errResponse(msg, code) {
  return { success: false, message: msg, code: code || null };
}

/**
 * يبني استجابة نجاح موحّدة، مع إمكانية دمج حقول إضافية (مثل data).
 * @param {String} msg - رسالة النجاح.
 * @param {Object} [extra] - حقول إضافية تُدمج في الاستجابة.
 * @returns {{success: true, message: String}}
 */
function okResponse(msg, extra) {
  return Object.assign({ success: true, message: msg }, extra || {});
}

function _getNextVoucherNumber(prefix) {
  try {
    var props = PropertiesService.getScriptProperties();
    var year = new Date().getFullYear();
    var key = "voucher_seq_" + prefix + "_" + year;
    var lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      var counter = parseInt(props.getProperty(key) || "0") + 1;
      props.setProperty(key, String(counter));
      return prefix + "-" + year + "-" + String(counter).padStart(5, "0");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    // fallback طارئ فقط — لا يُعتمد عليه في الإنتاج
    Logger.log("_getNextVoucherNumber fallback: " + e.message);
    return (
      prefix +
      "-" +
      new Date().getFullYear() +
      "-" +
      Date.now().toString().slice(-5)
    );
  }
}

function _getNextSequentialCode(counterKey, existingCodesFn) {
  return AutoNumberService.preview(existingCodesFn);
}

/**
 * يُنسّق صف الترويسة (Header Row) لأي شيت جديد بالنمط القياسي الموحّد
 * (خط عريض، خلفية زرقاء، نص أبيض) — راجع HEADER_STYLE.
 *
 * @param {Sheet} sheet - الشيت المطلوب تنسيقه.
 * @param {Number} colCount - عدد أعمدة الترويسة.
 */
function styleHeaderRow(sheet, colCount) {
  sheet
    .getRange(1, 1, 1, colCount)
    .setFontWeight(HEADER_STYLE.weight)
    .setBackground(HEADER_STYLE.bg)
    .setFontColor(HEADER_STYLE.color);
}

/** validateQty — يتحقق أن الكمية رقم موجب صحيح */
function validateQty(qty) {
  if (!qty || Number(qty) <= 0) return "الكمية يجب أن تكون أكبر من صفر";
  return null;
}

/**
 * يتحقق من وجود قيمة فعلية (غير فارغة) لكل حقل مطلوب في كائن معيّن.
 * يُستخدم في بداية دوال addXxx/updateXxx للتحقق من صحة المدخلات قبل
 * الكتابة على الشيت.
 *
 * @param {Object} obj - الكائن المطلوب فحصه (مثل بيانات فورم جديد).
 * @param {Array<String>} fields - أسماء الحقول الإلزامية.
 * @returns {String|null} رسالة الخطأ الخاصة بأول حقل ناقص، أو null لو
 *   كل الحقول موجودة.
 */
function validateRequired(obj, fields) {
  for (const f of fields) {
    if (!obj[f] || (typeof obj[f] === "string" && !obj[f].trim()))
      return `الحقل مطلوب: ${f}`;
  }
  return null;
}

/**
 * ✅ دالة موحّدة لحذف _row من object واحد
 * تُغني عن الـ inline forEach في getAllData
 */
function _stripRow(obj) {
  return cleanArr([obj])[0];
}

