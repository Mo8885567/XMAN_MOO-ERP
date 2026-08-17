// ════════════════════════════════════════════════════════════════
// Code_FixedAssets.gs — [REFACTOR-P4] نُقل من Code_Accounting.gs (نقل نصي بحت،
// صفر تغيير في المنطق). كل ملفات .gs في نفس الـ Global Scope فعليًا،
// فنقل الدوال هنا لا يكسر أي استدعاء طالما الأسماء لم تتغير.
// راجع تقرير Architecture Audit 2026-07-03 — المرحلة 4.
// ════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 34981-35550] Fixed Assets & Depreciation (شامل سطر تسجيل الـ headers) ┄┄┄
// §FA  الأصول الثابتة والإهلاك (Fixed Assets & Depreciation)
// ═══════════════════════════════════════════════════════════════════════════
// دورة العمل:
//   addFixedAsset    → Dr. الأصل / Cr. الصندوق أو الذمم الدائنة
//   postDepreciation → Dr. مصروف الإهلاك / Cr. مجمع الإهلاك
//   disposeFixedAsset→ عكس الأصل ومجمعه + أرباح/خسائر التصرف
// ═══════════════════════════════════════════════════════════════════════════

var FIXED_ASSETS_HEADERS = [
  "id",
  "name",
  "description",
  "category",
  "purchase_date",
  "purchase_cost",
  "useful_life_years",
  "salvage_value",
  "depreciation_method",
  "accumulated_depreciation",
  "book_value",
  "account_id",
  "status",
  "created_at",
  "created_by",
  "deleted_at",
];

// §FA-01 جلب الأصول الثابتة
function getFixedAssets(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
    if (permErr) return permErr;
    var rows = readSheet("FixedAssets", FIXED_ASSETS_HEADERS, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return !r.deleted_at;
    });
    rows = rows.map(function (r) {
      r.book_value =
        Number(r.purchase_cost || 0) - Number(r.accumulated_depreciation || 0);
      return r;
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب الأصول الثابتة: " + e.message);
  }
}

// §FA-02 إضافة أصل ثابت + قيد محاسبي تلقائي
function addFixedAsset(data, sessionToken) {
  try {
    var callerUser =
      data && data.callerUser
        ? data.callerUser
        : _getUsernameFromToken(sessionToken);
    var permErr = _checkPermission(callerUser, "addJournalEntry", sessionToken);
    if (permErr) return permErr;

    var cost = Number(data.purchase_cost);
    if (!ValidationEngine.isRequired(data.name)) return errResponse("اسم الأصل مطلوب");
    if (!ValidationEngine.isPositive(cost)) return errResponse("تكلفة الشراء يجب أن تكون أكبر من صفر");
    if (!ValidationEngine.isRequired(data.purchase_date)) return errResponse("تاريخ الشراء مطلوب");

    // [ACCOUNTING-LOOKUP-UNIFY] لو المستخدم حدد حساب الأصل يدوياً، لازم يكون صالح
    if (data.account_id && typeof validateAccountingFieldValue === "function") {
      var _faAccErr = validateAccountingFieldValue(data.account_id, {
        expectedType: "ASSET",
      });
      if (_faAccErr) return errResponse("حساب الأصل الثابت: " + _faAccErr);
    }

    // [FIX-POSTING-AUDIT §2] كان التحقق من الحسابات يتم *بعد* كتابة صف الأصل
    // في الشيت، عبر _getDefaultAccount الصامتة (ترجع null بدل رفع خطأ)، فكان
    // يمكن حفظ أصل ثابت كامل بدون أي قيد محاسبي إذا غابت الحسابات. الحل:
    // نتحقق إلزامياً هنا *قبل* أي كتابة، وباستخدام requirePostingAccount التي
    // ترفض العملية كاملة بدل تمريرها بصمت.
    var _faAccountsPre = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var _faAccountPre, _faCounterAccountPre;
    var _faIsCreditPre = String(data.payment_type || "").trim() === "آجل";
    try {
      _faAccountPre = data.account_id
        ? _faAccountsPre.find(function (a) {
            return a.id === data.account_id && !a.deleted_at;
          })
        : null;
      if (!_faAccountPre) {
        _faAccountPre = requirePostingAccount(
          {
            accounts: _faAccountsPre,
            key: "fixed_asset_account",
            type: "ASSET",
            hints: ["أصول ثابتة", "fixed assets", "ممتلكات ومعدات"],
          },
          "حساب الأصول الثابتة",
        ).account;
      }
      _faCounterAccountPre = _faIsCreditPre
        ? requirePostingAccount(
            {
              accounts: _faAccountsPre,
              key: "ap_account",
              type: "LIABILITY",
              hints: ["ذمم دائنة", "موردين", "accounts payable"],
            },
            "حساب الذمم الدائنة",
          ).account
        : requirePostingAccount(
            {
              accounts: _faAccountsPre,
              key: "cash_account",
              type: "ASSET",
              hints: ["الصندوق", "خزينة رئيسية", "cash", "صندوق"],
            },
            "حساب الصندوق",
          ).account;
    } catch (faPostingErr) {
      return errResponse(faPostingErr.message);
    }

    var id = makeId("FA");
    var now = new Date().toISOString();
    // [ARCH-AUDIT-P3-1] appendRow خام → DataLayerEngine.insert، عشان
    // FixedAssets ينضم لباقي الموديولات المتوحّدة (نفس مسار الكتابة +
    // invalidateServerCache التلقائي). الـ id بيتحدد هنا صراحةً (مش
    // بمعرّف DataLayerEngine التلقائي) لأنه مُستخدم كـ reference في
    // القيد المحاسبي تحت مباشرة.
    var _faInsertResult = DataLayerEngine.insert(
      "FixedAssets",
      {
        id: id,
        name: data.name,
        description: data.description || "",
        category: data.category || "",
        purchase_date: data.purchase_date,
        purchase_cost: cost,
        useful_life_years: Number(data.useful_life_years || 1),
        salvage_value: Number(data.salvage_value || 0),
        depreciation_method: data.depreciation_method || "STRAIGHT_LINE",
        accumulated_depreciation: 0,
        book_value: cost,
        account_id: data.account_id || "",
        status: "ACTIVE",
        created_at: now,
        created_by: callerUser,
        deleted_at: "",
      },
      { headers: FIXED_ASSETS_HEADERS },
    );
    if (!_faInsertResult.success)
      return errResponse(
        _faInsertResult.errorMessage || "تعذّر حفظ الأصل الثابت",
      );

    // ── قيد: Dr. الأصل الثابت / Cr. الصندوق أو الذمم الدائنة ──
    // الحسابان تم التحقق منهما إلزامياً أعلاه قبل كتابة صف الأصل، فلا يوجد
    // فرع "بدون قيد" هنا بعد الآن.
    var _faJournalResult = _addJournalEntryInternal({
      callerUser: callerUser,
      date: data.purchase_date,
      reference: id,
      source_type: "FIXED_ASSET_PURCHASE",
      description: "شراء أصل ثابت — " + data.name,
      lines: [
        {
          account_id: _faAccountPre.id,
          debit: cost,
          credit: 0,
          notes: "شراء: " + data.name,
        },
        {
          account_id: _faCounterAccountPre.id,
          debit: 0,
          credit: cost,
          notes: _faIsCreditPre ? "ذمم دائنة" : "صرف نقدي",
        },
      ],
    });
    if (_faJournalResult && _faJournalResult.success === false) {
      // فشل الترحيل (مثلاً إغلاق فترة محاسبية) — نتراجع عن صف الأصل بدل
      // تركه بدون أي أثر محاسبي.
      sheet.deleteRow(sheet.getLastRow());
      return errResponse(
        "تعذّر ترحيل قيد شراء الأصل: " +
          (_faJournalResult.message || "خطأ غير معروف") +
          " — لم يتم حفظ الأصل.",
      );
    }

    AuditEngine.logCreate({
      user: callerUser,
      table: "FixedAssets",
      recordId: id,
      details: data.name,
    });
    _invalidateServerCacheFixedAssets(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse(" تم إضافة الأصل الثابت بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة الأصل الثابت: " + e.message);
  }
}

// §FA-03 تحديث بيانات أصل ثابت
function updateFixedAsset(data, sessionToken) {
  try {
    var callerUser =
      data && data.callerUser
        ? data.callerUser
        : _getUsernameFromToken(sessionToken);
    var permErr = _checkPermission(callerUser, "addJournalEntry", sessionToken);
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(data.id)) return errResponse("معرف الأصل مطلوب");

    var rows = readSheet("FixedAssets", FIXED_ASSETS_HEADERS, {
      trimStrings: true,
    });
    var asset = rows.find(function (r) {
      return r.id === data.id && !r.deleted_at;
    });
    if (!asset) return errResponse("الأصل غير موجود");

    var sheet = getSheet("FixedAssets", FIXED_ASSETS_HEADERS);
    var fields = [
      "name",
      "description",
      "category",
      "useful_life_years",
      "salvage_value",
      "depreciation_method",
      "account_id",
      "status",
    ];
    // [ENGINE-AUDIT / Update Engine] استُبدل loop الـ setValue المنفصل بـ
    // _applyRowUpdates الموحّدة (نداء قراءة واحد + نداء كتابة واحد بدل نداء
    // منفصل لكل حقل من الـ8 حقول القابلة للتعديل).
    var _faUpdates = {};
    fields.forEach(function (f) {
      if (data[f] !== undefined) _faUpdates[f] = data[f];
    });
    _applyRowUpdates(sheet, asset._row, FIXED_ASSETS_HEADERS, _faUpdates);

    AuditEngine.logUpdate({
      user: callerUser,
      table: "FixedAssets",
      recordId: data.id,
      details: data.name || "",
    });
    _invalidateServerCacheFixedAssets(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse(" تم تحديث بيانات الأصل");
  } catch (e) {
    return errResponse("خطأ في تحديث الأصل: " + e.message);
  }
}

// §FA-04 حذف ناعم (Soft Delete)
// [BUGFIX-FA-DELETE] قبل الإصلاح ده، الدالة كانت بتعمل Soft Delete بس
// (تعليم deleted_at) من غير أي فحص أو عكس للأثر المحاسبي — لا قيد الشراء
// الأصلي (reference = id، source_type=FIXED_ASSET_PURCHASE من addFixedAsset)
// ولا قيود الإهلاك الدورية (reference = "DEP-<date>-<id>" من postDepreciation)
// كانت بتتلغي أو تتعكس، فيفضل الأستاذ العام فيه قيود سارية لأصل "محذوف".
// دلوقتي: لو فيه إهلاك مُرحّل بالفعل، الحذف يُمنع (لازم إلغاء الإهلاك أولاً —
// نفس مبدأ "امنع حذف مستند معتمد" المطبّق على السندات والقيود في باقي
// المشروع). لو لسه مفيش إهلاك، بنعكس قيد الشراء تلقائيًا بنفس الآلية
// المستخدمة في حذف الفواتير (_cancelJournalEntryByReference) قبل الحذف.
function deleteFixedAsset(id, callerUser, sessionToken) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
  }
  try {
    var permErr = _checkPermission(callerUser, "addJournalEntry", sessionToken);
    if (permErr) return permErr;
    var rows = readSheet("FixedAssets", FIXED_ASSETS_HEADERS, {
      trimStrings: true,
    });
    var asset = rows.find(function (r) {
      return r.id === id && !r.deleted_at;
    });
    if (!asset) return errResponse("الأصل غير موجود");

    // [BRE-UNIFY-1] فحص الإهلاك المرحّل الآن مركزي عبر BusinessRulesEngine
    var _bre = BusinessRulesEngine.validateBeforeDelete("fixedAsset", {
      id: id,
    });
    if (!_bre.success) return errResponse(_bre.message);

    // 2) مفيش إهلاك — نعكس قيد الشراء الأصلي (لو موجود وسارٍ) قبل الحذف،
    // بنفس الآلية المستخدمة في حذف الفواتير/المرتجعات/الحركات المخزنية.
    _cancelJournalEntryByReference(id, callerUser);

    var sheet = getSheet("FixedAssets", FIXED_ASSETS_HEADERS);
    var col = FIXED_ASSETS_HEADERS.indexOf("deleted_at");
    if (col !== -1)
      sheet.getRange(asset._row, col + 1).setValue(new Date().toISOString());

    AuditEngine.logDelete({
      user: callerUser,
      table: "FixedAssets",
      recordId: id,
      details: "حذف مع عكس قيد الشراء (لا يوجد إهلاك مُرحّل)",
    });
    _invalidateServerCacheFixedAssets(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse(" تم حذف الأصل الثابت وعكس قيد الشراء المرتبط");
  } catch (e) {
    return errResponse("خطأ في حذف الأصل: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

// §FA-05 ترحيل الإهلاك الدوري
// Dr. مصروف الإهلاك / Cr. مجمع الإهلاك
function postDepreciation(data, sessionToken) {
  // [P8-FIX] قفل ذري (LockService) يمنع دخول طلبين متزامنين (مثلاً نقرة
  // مزدوجة على "ترحيل الإهلاك") معًا إلى فحص "هل يوجد قيد سابق؟" قبل أن
  // يكتب أيٌّ منهما النتيجة — كان هذا يسمح بقيد إهلاك مكرر لنفس التاريخ.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
  }
  try {
    var callerUser =
      data && data.callerUser
        ? data.callerUser
        : _getUsernameFromToken(sessionToken);
    var permErr = _checkPermission(callerUser, "addJournalEntry", sessionToken);
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(data.date)) return errResponse("تاريخ الإهلاك مطلوب");

    // [P8-FIX] فحص قفل الفترة المحاسبية — كان مفقودًا هنا مثل باقي
    // موديولات المشروع (راجع تقرير المراجعة، ثغرة #8).
    var _periodErr = _blockIfPeriodClosed(data.date, "قيد الإهلاك");
    if (_periodErr) return _periodErr;

    // [P7-FIX] منع تكرار ترحيل الإهلاك لنفس التاريخ/النطاق
    // كانت الدالة بلا أي حماية: تشغيلها مرتين لنفس التاريخ كان يُنشئ
    // قيداً مكرراً ويُضاعف "مجمع الإهلاك" لكل أصل فعلياً في الشيت.
    var depReference =
      "DEP-" +
      String(data.date).replace(/-/g, "") +
      (data.asset_id ? "-" + data.asset_id : "-BATCH");
    var existingDepEntries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var alreadyPostedDep = existingDepEntries.some(function (e) {
      return (
        e.reference === depReference &&
        e.status !== "CANCELLED" &&
        e.status !== "REVERSED"
      );
    });
    if (alreadyPostedDep)
      return errResponse(
        "تم ترحيل إهلاك هذا التاريخ مسبقاً (" +
          data.date +
          ") — لا يمكن الترحيل مرتين لنفس الفترة",
      );

    var rows = readSheet("FixedAssets", FIXED_ASSETS_HEADERS, {
      trimStrings: true,
    });
    var activeAssets = rows.filter(function (r) {
      return !r.deleted_at && r.status === "ACTIVE";
    });
    if (data.asset_id)
      activeAssets = activeAssets.filter(function (r) {
        return r.id === data.asset_id;
      });
    if (!activeAssets.length) return errResponse("لا توجد أصول نشطة للإهلاك");

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var depExpAcc = _getDefaultAccount(
      "depreciation_expense_account",
      accounts,
      "EXPENSE",
      ["إهلاك", "اهتلاك", "depreciation expense"],
    );
    var accumAcc = _getDefaultAccount(
      "accumulated_depreciation_account",
      accounts,
      "ASSET",
      ["مجمع الإهلاك", "accumulated depreciation"],
    );

    if (!depExpAcc || !accumAcc)
      return errResponse(
        " حسابات الإهلاك غير مربوطة — اذهب لإعدادات ربط الحسابات وحدد حساب مصروف الإهلاك ومجمع الإهلاك",
      );

    var sheet = getSheet("FixedAssets", FIXED_ASSETS_HEADERS);
    var faRows = readSheet("FixedAssets", FIXED_ASSETS_HEADERS, {
      trimStrings: true,
    });
    var lines = [];
    var totalDep = 0;
    var processed = 0;
    var months = Number(data.period_months || 12);
    // [AUDIT-FIX-2026-08-09 §RISK-DEP-ORDER-CRITICAL] كانت كتابة
    // accumulated_depreciation/book_value/status على شيت FixedAssets
    // بتحصل داخل الحلقة دي مباشرة — يعني *قبل* إنشاء القيد المحاسبي
    // وقبل التأكد من نجاحه. لو _addJournalEntryInternal فشل بعد كده (مثلاً
    // حسابات الإهلاك مش مربوطة صح وقت التشغيل، أو خطأ شبكة)، الدالة كانت
    // ترجع خطأ للمستخدم، لكن سجل الأصول الثابتة يكون *اتغيّر بالفعل* —
    // مجمع الإهلاك زاد والقيمة الدفترية اتقلّت من غير أي قيد فعلي يقابلها
    // في الأستاذ العام (بالظبط عكس مبدأ "القيد أولاً، ثم الرصيد" المطبّق في
    // اعتماد السندات — راجع BUG-FIX-003 في Code_06). الحل: نجمع التحديثات
    // في مصفوفة مؤقتة (pendingUpdates) بدل الكتابة الفورية، ونطبّقها على
    // الشيت فقط بعد نجاح القيد.
    var pendingUpdates = [];

    activeAssets.forEach(function (asset) {
      var cost = Number(asset.purchase_cost || 0);
      var salvage = Number(asset.salvage_value || 0);
      var life = Number(asset.useful_life_years || 1);
      var accum = Number(asset.accumulated_depreciation || 0);
      var bookVal = cost - accum;
      if (bookVal <= salvage) return;

      var method = String(
        asset.depreciation_method || "STRAIGHT_LINE",
      ).toUpperCase();
      var annualDep;
      if (method === "DOUBLE_DECLINING") annualDep = bookVal * (2 / life);
      else if (method === "DECLINING_BALANCE") annualDep = bookVal * (1 / life);
      else annualDep = (cost - salvage) / life;

      var periodDep = Math.min(
        (annualDep * months) / 12,
        Math.max(0, bookVal - salvage),
      );
      if (periodDep <= 0.001) return;

      totalDep += periodDep;
      lines.push({
        account_id: depExpAcc.id,
        debit: periodDep,
        credit: 0,
        notes: "إهلاك — " + asset.name,
      });
      lines.push({
        account_id: accumAcc.id,
        debit: 0,
        credit: periodDep,
        notes: "مجمع إهلاك — " + asset.name,
      });

      // نجمّع التحديث المطلوب فقط، من غير كتابة فعلية على الشيت دلوقتي
      var ai = faRows.findIndex(function (r) {
        return r.id === asset.id;
      });
      if (ai !== -1) {
        var newAccum = accum + periodDep;
        pendingUpdates.push({
          rowNum: faRows[ai]._row,
          newAccum: newAccum,
          newBookVal: cost - newAccum,
          fullyDepreciated: cost - newAccum <= salvage + 0.001,
        });
      }
      processed++;
    });

    if (!lines.length)
      return okResponse("لا توجد أصول تحتاج إهلاكاً في هذه الفترة");

    var result = _addJournalEntryInternal({
      callerUser: callerUser,
      date: data.date,
      reference: depReference,
      source_type: "DEPRECIATION",
      description: "قيد إهلاك دوري — " + data.date + " (" + processed + " أصل)",
      lines: lines,
    });
    if (!result || !result.success)
      return errResponse(
        "فشل قيد الإهلاك: " + (result ? result.message : "خطأ غير معروف"),
      );

    // القيد اتعمل ونجح — دلوقتي بس نطبّق تحديثات سجل الأصول الثابتة
    var accumCol = FIXED_ASSETS_HEADERS.indexOf("accumulated_depreciation");
    var bookCol = FIXED_ASSETS_HEADERS.indexOf("book_value");
    var statusCol = FIXED_ASSETS_HEADERS.indexOf("status");
    pendingUpdates.forEach(function (u) {
      if (accumCol !== -1) sheet.getRange(u.rowNum, accumCol + 1).setValue(u.newAccum);
      if (bookCol !== -1) sheet.getRange(u.rowNum, bookCol + 1).setValue(u.newBookVal);
      if (statusCol !== -1 && u.fullyDepreciated)
        sheet.getRange(u.rowNum, statusCol + 1).setValue("FULLY_DEPRECIATED");
    });

    AuditEngine.log("POST_DEPRECIATION", {
      user: callerUser,
      table: "FixedAssets",
      recordId: "BATCH",
      details: processed + " أصل | إجمالي: " + totalDep.toFixed(2),
    });
    _invalidateServerCacheFixedAssets(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse(
      " تم ترحيل الإهلاك | " +
        processed +
        " أصل | إجمالي: " +
        totalDep.toFixed(2),
      {
        total_depreciation: totalDep,
        assets_processed: processed,
        journal_entry_id: result.id,
      },
    );
  } catch (e) {
    return errResponse("خطأ في ترحيل الإهلاك: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

// §FA-06 التصرف في الأصل (بيع أو إتلاف)
// Dr. مجمع الإهلاك + Dr. النقدية / Cr. الأصل + Cr/Dr. أرباح/خسائر
function disposeFixedAsset(data, sessionToken) {
  // [P8-FIX] قفل ذري يمنع تصرفين متزامنين في نفس الأصل من المرور معًا من
  // فحص "غير محذوف" قبل أن يكتب أيٌّ منهما DISPOSED/deleted_at.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
  }
  try {
    var callerUser =
      data && data.callerUser
        ? data.callerUser
        : _getUsernameFromToken(sessionToken);
    var permErr = _checkPermission(callerUser, "addJournalEntry", sessionToken);
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(data.id) || !ValidationEngine.isRequired(data.date))
      return errResponse("معرف الأصل وتاريخ التصرف مطلوبان");

    // [P8-FIX] فحص قفل الفترة المحاسبية.
    var _periodErr = _blockIfPeriodClosed(data.date, "قيد التصرف في أصل");
    if (_periodErr) return _periodErr;

    var rows = readSheet("FixedAssets", FIXED_ASSETS_HEADERS, {
      trimStrings: true,
    });
    var asset = rows.find(function (r) {
      return r.id === data.id && !r.deleted_at;
    });
    if (!asset) return errResponse("الأصل غير موجود");

    var cost = Number(asset.purchase_cost || 0);
    var accum = Number(asset.accumulated_depreciation || 0);
    var bookVal = cost - accum;
    var salePrice = Number(data.sale_price || 0);
    var gainLoss = salePrice - bookVal;

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var faAcc = asset.account_id
      ? accounts.find(function (a) {
          return a.id === asset.account_id && !a.deleted_at;
        })
      : _getDefaultAccount("fixed_asset_account", accounts, "ASSET", [
          "أصول ثابتة",
          "fixed assets",
        ]);
    var accumAcc = _getDefaultAccount(
      "accumulated_depreciation_account",
      accounts,
      "ASSET",
      ["مجمع الإهلاك", "accumulated depreciation"],
    );
    var cashAcc = _getDefaultAccount("cash_account", accounts, "ASSET", [
      "الصندوق",
      "خزينة رئيسية",
      "cash",
    ]);

    if (!faAcc || !accumAcc)
      return errResponse(
        "حسابات الأصول الثابتة أو مجمع الإهلاك غير مربوطة في إعدادات الترحيل",
      );

    // [FIX-POSTING-AUDIT §2] كانت هذه الحسابات "اختيارية" فعلياً: لو غابت،
    // يتم حذف سطرها من القيد بصمت بينما باقي السطور (المحسوبة على أساس
    // gainLoss = salePrice - bookVal) تفترض وجودها — فينتج قيد غير متوازن
    // فعلياً (مدين ≠ دائن) بدل رفض العملية. الحل: نطلبها إلزامياً متى كانت
    // القيمة المرتبطة بها أكبر من صفر.
    if (Number(data.sale_price || 0) > 0 && !cashAcc) {
      return errResponse(
        "حساب الصندوق غير مربوط في إعدادات الترحيل — مطلوب لتسجيل عائد بيع الأصل",
      );
    }

    var lines = [];
    if (accum > 0)
      lines.push({
        account_id: accumAcc.id,
        debit: accum,
        credit: 0,
        notes: "إزالة مجمع الإهلاك — " + asset.name,
      });
    if (salePrice > 0 && cashAcc)
      lines.push({
        account_id: cashAcc.id,
        debit: salePrice,
        credit: 0,
        notes: "عائد بيع الأصل",
      });
    lines.push({
      account_id: faAcc.id,
      debit: 0,
      credit: cost,
      notes: "شطب أصل ثابت — " + asset.name,
    });
    if (Math.abs(gainLoss) > 0.001) {
      var plAcc =
        gainLoss > 0
          ? _getDefaultAccount("revenue_account", accounts, "REVENUE", [
              "أرباح بيع أصول",
              "gains on disposal",
              "إيرادات",
            ])
          : _getDefaultAccount(
              "depreciation_expense_account",
              accounts,
              "EXPENSE",
              ["خسائر بيع أصول", "losses on disposal"],
            );
      if (!plAcc) {
        // [FIX-POSTING-AUDIT §2] بدون هذا الحساب سيكون القيد غير متوازن
        // (مدين ≠ دائن) لأن باقي السطور مبنية على افتراض وجود هذا الفرق —
        // نرفض العملية بوضوح بدل حفظ قيد غير متوازن.
        return errResponse(
          gainLoss > 0
            ? "حساب أرباح التصرف في الأصول غير مربوط في إعدادات الترحيل (revenue_account)"
            : "حساب خسائر التصرف في الأصول غير مربوط في إعدادات الترحيل (depreciation_expense_account)",
        );
      }
      if (gainLoss > 0)
        lines.push({
          account_id: plAcc.id,
          debit: 0,
          credit: gainLoss,
          notes: "ربح التصرف في أصل ثابت",
        });
      else
        lines.push({
          account_id: plAcc.id,
          debit: -gainLoss,
          credit: 0,
          notes: "خسارة التصرف في أصل ثابت",
        });
    }

    var result = _addJournalEntryInternal({
      callerUser: callerUser,
      date: data.date,
      reference: data.id + "-DISP",
      source_type: "FIXED_ASSET_DISPOSAL",
      description: "التصرف في أصل ثابت — " + asset.name,
      lines: lines,
    });
    if (!result || !result.success)
      return errResponse(
        "فشل قيد التصرف: " + (result ? result.message : "خطأ غير معروف"),
      );

    // تحديث حالة الأصل → DISPOSED
    var sheet = getSheet("FixedAssets", FIXED_ASSETS_HEADERS);
    var statusCol = FIXED_ASSETS_HEADERS.indexOf("status");
    var delCol = FIXED_ASSETS_HEADERS.indexOf("deleted_at");
    if (statusCol !== -1)
      sheet.getRange(asset._row, statusCol + 1).setValue("DISPOSED");
    if (delCol !== -1)
      sheet.getRange(asset._row, delCol + 1).setValue(new Date().toISOString());

    AuditEngine.log("DISPOSE_FIXED_ASSET", {
      user: callerUser,
      table: "FixedAssets",
      recordId: data.id,
      details:
        "ثمن البيع: " +
        salePrice +
        " | " +
        (gainLoss >= 0 ? "ربح: " : "خسارة: ") +
        Math.abs(gainLoss).toFixed(2),
    });
    _invalidateServerCacheFixedAssets(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse(
      " التصرف في الأصل بنجاح | " +
        (gainLoss >= 0 ? "ربح: " : "خسارة: ") +
        Math.abs(gainLoss).toFixed(2),
      {
        book_value: bookVal,
        sale_price: salePrice,
        gain_loss: gainLoss,
        journal_entry_id: result.id,
      },
    );
  } catch (e) {
    return errResponse("خطأ في التصرف في الأصل: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

// ملحوظة: تسجيل FixedAssets في ACCOUNTING_HR_HEADERS تم نقله إلى Code_Core.gs
// لأن ACCOUNTING_HR_HEADERS معرّف هناك، وترتيب تحميل ملفات GAS أبجدي
// (Code_Accounting.gs يُنفَّذ قبل Code_Core.gs)، فكان هذا السطر يسبب
// ReferenceError: ACCOUNTING_HR_HEADERS is not defined.
