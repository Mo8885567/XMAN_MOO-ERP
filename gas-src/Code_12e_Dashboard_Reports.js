/**
 * ============================================================
 * Module: Code_12e_Dashboard_Reports.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * ✅ [FIX] getAllDataFresh — نسخة من getAllData() بتتخطى كاش السيرفر إجباريًا.
 * كانت بتتنادى من reloadAfterMutationFull() في الواجهة (زر "تحديث البيانات"
 * العام، واستيراد Excel، وتعديل الرصيد الافتتاحي) لكنها ماكانتش معرّفة هنا
 * أصلاً، فكانت بتدّي خطأ "getAllDataFresh is not a function" فورًا (قبل ما
 * توصل للسيرفر حتى)، وده كان بيخلي شاشة "جاري تحديث البيانات..." تفضل عالقة.
 * نمسح الكاش الأول، وبعدين getAllData() هتقرا بيانات Fresh من الـ Sheets
 * تلقائيًا (لأن الكاش بقى فاضي) وتعيد تخزينها من جديد للقراءات العادية بعد كده.
 */
function getAllDataFresh(callerUser, sessionToken) {
  _invalidateServerCache();
  return getAllData(callerUser, sessionToken);
}

function _buildStockQtyMap(stock) {
  var map = {};
  (stock || []).forEach(function (s) {
    var key = String(s.item_id);
    map[key] = (map[key] || 0) + Number(s.quantity || 0);
  });
  return map;
}

/**
 * يحسب الرصيد الحالي (من الحركات المرحّلة) والرصيد الإجمالي (مضافًا
 * إليه الرصيد الافتتاحي) لصنف واحد.
 * @param {Object} item - الصنف.
 * @param {Object<String, Number>} stockMap - خريطة رصيد الحركات لكل صنف.
 * @param {Object<String, Number>} openingMap - خريطة الرصيد الافتتاحي لكل صنف.
 * @returns {{currentQty: Number, totalQty: Number}}
 */
function _calcTotalQty(item, stockMap, openingMap) {
  const currentQty = stockMap[item.id] || 0;
  return { currentQty, totalQty: currentQty + (openingMap[item.id] || 0) };
}

/**
 * يبني إحصائيات لوحة التحكم الرئيسية (إجمالي الأصناف، المخزون
 * المنخفض، عدد أوامر الإنتاج الجارية، إلخ).
 *
 * NOTE: [PERF-FIX-2] تعتمد على كاش السيرفر (getAllData) بدل قراءة
 * الشيتات مباشرة؛ قبل هذا التحسين كان كل فتح للوحة التحكم يقرأ 5
 * شيتات منفصلة (تأخير 2-4 ثانية)، الآن تُقرأ من كاش جاهز في الذاكرة.
 *
 * @returns {Object} كائن إحصائيات لوحة التحكم.
 */
function getDashboardStats() {
  try {
    // ✅ [PERF-FIX-2] استخدام الكاش بدلاً من قراءة 5 شيتات منفصلة في كل طلب
    // قبل الإصلاح: كل فتح للداشبورد = 5 قراءات Sheets = 2-4 ثانية تأخير
    var cached = _loadServerCache();
    var items, stock, transactions, productionOrders, openingStock;

    if (cached) {
      items = cached.items || [];
      stock = cached.stock || [];
      transactions = cached.transactions || [];
      productionOrders = cached.productionOrders || [];
      openingStock = cached.openingStock || [];
    } else {
      // fallback: اقرأ من Sheets لو الكاش فارغ (نادر بعد تصحيح الـ trigger)
      items = getSheetData("Items");
      stock = getSheetData("Stock");
      transactions = getSheetData("Transactions");
      productionOrders = getSheetData("ProductionOrders");
      openingStock = getOpeningStock().data || [];
    }

    const openingMap = _buildOpeningMap(openingStock);
    const stockMap = _buildStockQtyMap(stock); // [H-02 FIX]

    let totalStock = 0,
      alerts = 0;
    items.forEach((item) => {
      const { totalQty } = _calcTotalQty(item, stockMap, openingMap);
      totalStock += totalQty;
      if (
        item.min_qty != null &&
        Number(item.min_qty) > 0 &&
        totalQty <= Number(item.min_qty)
      )
        alerts++;
    });

    const today = new Date().toDateString();
    const todayTx = transactions.filter(
      (t) => new Date(t.date).toDateString() === today,
    ).length;
    const pendingPO = productionOrders.filter(
      (o) => o.status === "pending",
    ).length;

    return {
      success: true,
      totalItems: items.length,
      totalStock,
      todayTx,
      alerts,
      pendingPO,
    };
  } catch (e) {
    console.error("getDashboardStats Error:", e);
    return errResponse(e.message);
  }
}

/**
 * يبني map للرصيد حسب (item_id + color) من Transactions + OpeningStock
 * شيت Stock مفيهوش color — الرصيد بالألوان يتحسب من الحركات فقط
 */
function _buildColorStockMap(transactions, openingStock) {
  var map = {};
  (openingStock || []).forEach(function (os) {
    var key =
      String(os.item_id).trim() +
      "||" +
      String(os.color || "")
        .trim()
        .toLowerCase();
    map[key] = (map[key] || 0) + Number(os.quantity || 0);
  });
  (transactions || []).forEach(function (tx) {
    var qty = Number(tx.quantity || 0);
    var type = String(tx.type || "").toUpperCase();
    var key =
      String(tx.item_id || "").trim() +
      "||" +
      String(tx.color || "")
        .trim()
        .toLowerCase();
    if (type === "IN" || type === "FG_IN" || type === "FACTORY_RETURN")
      map[key] = (map[key] || 0) + qty;
    if (type === "OUT" || type === "DISPATCH") map[key] = (map[key] || 0) - qty;
    // TRANSFER لا يغير الإجمالي
  });
  return map;
}

function getStockReport(callerUser, sessionToken) {
  try {
    if (callerUser) {
      var permErr = _checkPermission(
        callerUser,
        "addTransaction",
        sessionToken,
      );
      if (permErr) return permErr;
    }
    // ✅ [PERF-FIX-4] استخدام الكاش بدلاً من قراءة 4 شيتات كبيرة مباشرة
    // قبل الإصلاح: Items + Stock + OpeningStock + Transactions = أبطأ endpoint في السيستم (5-10s)
    // بعد الإصلاح: البيانات جاهزة من الكاش في <1s
    var _cached = _loadServerCache();
    var rawItems, stock, openingData, transactions;

    if (_cached) {
      // استخدام بيانات الكاش — نعمل deep copy عشان ما نعدّل الكاش الأصلي
      rawItems = (_cached.items || []).map(function (it) {
        var copy = JSON.parse(JSON.stringify(it));
        copy.colors_json = _normalizeColors(copy.colors_json);
        return copy;
      });
      stock = _cached.stock || [];
      openingData = _cached.openingStock || [];
      transactions = _cached.transactions || [];
    } else {
      // fallback: قراءة من Sheets لو الكاش فارغ
      rawItems = readSheet("Items", null, { parseJson: ["colors_json"] });
      rawItems = rawItems.map(function (it) {
        it.colors_json = _normalizeColors(it.colors_json);
        return it;
      });
      stock = getSheetData("Stock");
      openingData = getOpeningStock().data || [];
      transactions = getSheetData("Transactions");
    }

    const openingMap = _buildOpeningMap(openingData);
    const colorMap = _buildColorStockMap(transactions, openingData);
    const stockMap = _buildStockQtyMap(stock); // [H-02 FIX]

    // [PHASE-4-2026-08-07] بيتقرا مرة واحدة برة الـ loop (مش لكل صنف) —
    // نفس القيمة العامة بتتطبق على كل الأصناف. راجع الشرح أسفل داخل الـ map.
    const _reorderAlertDaysBeforeGlobal =
      typeof InventorySettingsEngine !== "undefined"
        ? Number(InventorySettingsEngine.get("reorder_alert_days_before") || 0)
        : null;

    const report = rawItems.map((item) => {
      const { currentQty, totalQty } = _calcTotalQty(
        item,
        stockMap,
        openingMap,
      );
      const minQ = Number(item.min_qty || 0);
      // [AUDIT-FIX Inventory §2.3] reorder_point/safety_stock كانا يُحفظان
      // ويُعرضان في تبويب "Inventory Policy" بدون أي استهلاك فعلي في منطق
      // التنبيه (العتبة الحقيقية كانت تعتمد حصريًا على min_qty القديم).
      // الآن: عتبة إعادة الطلب الفعلية = أكبر قيمة بين min_qty القديم و
      // (reorder_point + safety_stock) الجديدين، حتى لا تُفقَد أي إعدادات
      // سابقة معتمدة على min_qty، مع تفعيل الحقول الجديدة فعليًا.
      const reorderPoint = Number(item.reorder_point || 0);
      const safetyStock = Number(item.safety_stock || 0);
      const effectiveMinQ = Math.max(minQ, reorderPoint + safetyStock);
      // [PHASE-4-2026-08-07] item.lead_time_days كان حقل فردي لكل صنف
      // اتشال من فورم الصنف (03_JS_Dashboard_Items.html) وبقى إعداد عام
      // واحد بدله: reorder_alert_days_before (قسم 8 في شاشة إعدادات
      // المخزون). القيمة القديمة لسه موجودة في العمود بالشيت (للـ
      // migration) بس مبقاش بيتقرا منها — كل الأصناف بتاخد نفس القيمة
      // العامة دلوقتي. راجع README_HANDOFF.md §7.
      const reorderAlertDaysBefore =
        _reorderAlertDaysBeforeGlobal !== null
          ? _reorderAlertDaysBeforeGlobal
          : Number(item.lead_time_days || 0);

      var colorDetails = (item.colors_json || []).map(function (c) {
        var colorName = c.name || "";
        var colorCode = c.code || "";
        var subCode = colorCode
          ? (item.code || item.id) + "-" + colorCode
          : (item.code || item.id) + "-" + _resolveColorCodeBackend(colorName);

        // ✅ رصيد اللون من colorMap (Transactions + OpeningStock)
        var mapKey =
          String(item.id).trim() + "||" + colorName.trim().toLowerCase();
        var colorQty = Math.max(0, colorMap[mapKey] || 0);

        return {
          name: colorName,
          code: colorCode,
          subCode: subCode,
          quantity: colorQty,
          status:
            colorQty <= 0
              ? "نفد"
              : effectiveMinQ > 0 && colorQty <= effectiveMinQ
                ? "منخفض"
                : "متاح",
        };
      });

      return {
        id: item.id,
        name: item.name || "—",
        group: getGroupName(item.group) || "—",
        unit: item.unit || "—",
        quantity: totalQty,
        currentStock: currentQty,
        openingStock: openingMap[item.id] || 0,
        minQty: minQ,
        reorderPoint: reorderPoint,
        safetyStock: safetyStock,
        effectiveMinQty: effectiveMinQ,
        leadTimeDays: reorderAlertDaysBefore, // [PHASE-4] من الإعداد العام دلوقتي، مش من الصنف
        status:
          totalQty <= 0
            ? "نفد"
            : effectiveMinQ > 0 && totalQty <= effectiveMinQ
              ? "منخفض"
              : "متاح",
        colors: colorDetails,
      };
    });

    return { success: true, data: report };
  } catch (e) {
    console.error("getStockReport Error:", e);
    return errResponse(e.message);
  }
}

// [PERF-DIAG-2026-08] بيقيس زمن كل قسم لوحده (بالميلي ثانية) ويسجّله لو
// تعدّى حد معيّن — الهدف نعرف بالظبط أي قسم (attendance؟ employees؟
// journalEntries؟) هو اللي فعليًا بيسحب الوقت وبيوصّل getHRExtendedLazy/
// getAccountingExtendedLazy لحافة الـ 30 ثانية، بدل ما نفضل نخمّن.
// راجع Executions (Apps Script Editor → Executions) أو Logger.log لمتابعة
// الأرقام دي وقت التشخيص.
var _EXT_SECTION_SLOW_MS = 1500;
function _extSafeSection(callerLabel, fn) {
  var _t0 = Date.now();
  try {
    var _r = fn().data || [];
    var _dt = Date.now() - _t0;
    if (_dt >= _EXT_SECTION_SLOW_MS) {
      Logger.log("[PERF-EXT] " + callerLabel + ": " + _dt + "ms (بطيء)");
    }
    return _r;
  } catch (secErr) {
    try {
      Logger.log(
        callerLabel +
          ": فشل قسم '" +
          callerLabel +
          "' بعد " +
          (Date.now() - _t0) +
          "ms: " +
          secErr.message,
      );
    } catch (logErr) {
      Logger.log("[silent-catch] " + logErr);
    }
    return [];
  }
}

/**
 * ✅ [PERF-SPLIT] الجزء الأساسي (Core) من الحزمة الموسعة: قوائم بيانات
 * أساسية صغيرة نسبيًا (دليل حسابات، خزائن، بنوك، أقسام HR، مسميات
 * وظيفية...) + إعدادات محسوبة بدون قراءة شيت. الهدف: يرجع بسرعة كبيرة
 * (تنفيذ Apps Script واحد صغير) بدل ما ينتظر الفرونت الـ 24 قسم مع بعض.
 *
 * السبب الأصلي وراء هذا التقسيم: getAllDataExtended القديمة كانت بتقرأ
 * 24 قسم بالتتابع (محاسبة تفصيلية + HR تفصيلية) جوه تنفيذ واحد، وده كان
 * بياخد وقت كافي إنه يضرب الـ 30 ثانية (خصوصًا على /dev deployment)،
 * فيظهر "[DL] Core.getAllDataExtended → انتهت المهلة" في الكونسول رغم
 * إن الطلب ممكن يكون نجح فعليًا بعد اللحظة اللي ضرب فيها الـ timeout.
 *
 * الفرونت (01_JS_Core_Auth.html → _fetchExtendedDataFromServer) بينادي
 * الدالة دي وgetAllDataExtendedLazy مع بعض بالتوازي (نداءين منفصلين)،
 * فالزمن الكلي يبقى تقريبًا = أبطأ نداء من الاتنين، مش مجموعهم.
 */
function getAllDataExtendedCore(callerUser, sessionToken) {
  // [FIX-ISSUE-003] فحص المصادقة — هذه الدالة تُعيد بيانات مالية وHR حساسة
  if (!callerUser || !sessionToken)
    return errResponse("يجب تسجيل الدخول للوصول للبيانات الموسعة");
  var sess = validateSession(sessionToken);
  if (!sess || !sess.valid) return errResponse("جلسة منتهية أو غير صالحة");

  // [PERM-AUDIT-FIX-6] الكاش كان مفتاحًا ثابتًا واحدًا لكل المستخدمين —
  // بعد ما بقت الأقسام تحت فلترة صلاحيات فعلية، لازم كل دور يكون له
  // نسخة كاش مستقلة، وإلا أول مستخدم يملأ الكاش (بصلاحياته هو) هيفرض
  // نفس النتيجة على كل الأدوار التانية لمدة 30 دقيقة.
  var _callerRole = _getUserRole(callerUser) || "unknown";
  var _cacheKey = EXT_DATA_CORE_CACHE_KEY + "_role_" + _callerRole;
  try {
    var cached = _loadServerCache(_cacheKey);
    if (cached) {
      cached._from_cache = true;
      return cached;
    }
  } catch (e) {
    console.error("getAllDataExtendedCore - خطأ:", e.message || e);
  }

  try {
    var result = {
      // الشحن
      shippingCompanies: _extSafeSection("shippingCompanies", function () {
        return getShippingCompanies(callerUser, sessionToken);
      }),

      // المحاسبة — قوائم أساسية (دليل الحسابات/الخزائن/البنوك/دفاتر
      // الشيكات) عادة صغيرة العدد وقراءتها سريعة جدًا مقارنة بالمعاملات
      chartOfAccounts: _extSafeSection("chartOfAccounts", function () {
        return getChartAccounts(true, callerUser, sessionToken);
      }),
      cashBoxes: _extSafeSection("cashBoxes", function () {
        return getCashBoxes(callerUser, sessionToken);
      }),
      bankAccounts: _extSafeSection("bankAccounts", function () {
        return getBankAccounts(callerUser, sessionToken);
      }),
      banks: _extSafeSection("banks", function () {
        return getBanks();
      }),
      chequeBooks: _extSafeSection("chequeBooks", function () {
        return getChequeBooks();
      }),

      // HR — قوائم أساسية
      departments: _extSafeSection("departments", function () {
        return getDepartments(callerUser, sessionToken);
      }),
      jobTitles: _extSafeSection("jobTitles", function () {
        return getJobTitles(callerUser, sessionToken);
      }),
      leaveTypes: _extSafeSection("leaveTypes", function () {
        return getLeaveTypes();
      }),

      // الإعدادات — محسوبة مباشرة (بدون قراءة شيت معاملات)، فبقاؤها هنا
      // في القسم السريع منطقي ولا يضيف أي زمن
      // [P1-FIX] كانت هذه القيم Hardcoded بمفاتيح غير موجودة أصلاً في نموذج
      // الإعدادات الفعلي (default_currency / auto_journal غير مُستخدمين في
      // 10_JS_Settings_Search_Parties.html، والمفتاح الصحيح هو "currency" وليس
      // "default_currency")، وكانت تُعاد لأي مستخدم بنفس القيم الثابتة بصرف
      // النظر عمّا حفظه فعليًا في شاشة إعدادات الشركة. الآن تُقرأ من شيت
      // Settings الفعلي مع قيم افتراضية معقولة فقط عند عدم الحفظ بعد.
      accountingSettings: (function () {
        var co = _getCompanySettingsRaw();
        return {
          default_currency: co.currency || "EGP",
          fiscal_year_start: co.fiscal_year_start || "01/01",
          auto_journal: true,
        };
      })(),
      hrSettings: {
        work_hours_per_day: 8,
        overtime_rate: 1.5,
        social_insurance_rate: 0.11,
        grace_period_minutes: 15,
      },
    };

    var response = { success: true, data: result };
    try {
      _saveServerCache(response, _cacheKey, EXT_DATA_CACHE_TTL);
    } catch (e) {
      console.error("getAllDataExtendedCore - خطأ حفظ كاش:", e.message || e);
    }
    return response;
  } catch (e) {
    return errResponse("خطأ في جلب البيانات الأساسية الموسعة: " + e.message);
  }
}

/**
 * ✅ [PERF-SPLIT-2026-07-28] تقسيم جذري لـ getAllDataExtendedLazy: كانت
 * بتقرا 12 قسم معاملاتي (محاسبة + HR + إنتاج) بالتتابع في نداء واحد،
 * فحتى بعد تقسيمها عن Core كانت بتفضل تضرب مهلة الـ 30 ثانية مع نمو
 * البيانات (خصوصًا الحضور/القيود/الموظفين). المشكلة الحقيقية: أي صفحة
 * محاسبة كانت بتجيب أقسام HR اللي مش محتاجاها بالمرة (والعكس)، يعني
 * ضعف عدد القراءات الحقيقي المطلوب لكل صفحة.
 *
 * الحل الجذري: تقسيم الحزمة لتلاتة دوال مستقلة بكاش مستقل لكل واحدة:
 *   - getAccountingExtendedLazy: أقسام المحاسبة المعاملاتية فقط (8 أقسام)
 *   - getHRExtendedLazy: أقسام HR + الإنتاج فقط (6 أقسام)
 *   - getAllDataExtendedLazy: فضلت موجودة كـ wrapper (تجمع الاتنين) لأي
 *     كود قديم لسه بينادي الاسم القديم مباشرة (نفس فكرة legacy wrapper
 *     getAllDataExtended فوق getAllDataExtendedCore/Lazy).
 * الفرونت (01_JS_Core_Auth.html → _fetchExtendedDataFromServer) بقى
 * يقدر يطلب دومين واحد بس (acc/hr) حسب نوع الصفحة المفتوحة، فعدد
 * القراءات لكل نداء يقل للنصف تقريبًا بدون أي تأثير على الدوال أو
 * الشاشات اللي لسه بتنادي الاسم القديم أو مش عارفة الدومين.
 */
function getAccountingExtendedLazy(callerUser, sessionToken) {
  if (!callerUser || !sessionToken)
    return errResponse("يجب تسجيل الدخول للوصول للبيانات الموسعة");
  var sess = validateSession(sessionToken);
  if (!sess || !sess.valid) return errResponse("جلسة منتهية أو غير صالحة");

  var _callerRole = _getUserRole(callerUser) || "unknown";
  var _cacheKey = EXT_DATA_LAZY_ACC_CACHE_KEY + "_role_" + _callerRole;
  try {
    var cached = _loadServerCache(_cacheKey);
    if (cached) {
      cached._from_cache = true;
      return cached;
    }
  } catch (e) {
    console.error("getAccountingExtendedLazy - خطأ:", e.message || e);
  }

  try {
    var _auth = { callerUser: callerUser, sessionToken: sessionToken };
    var result = {
      cheques: _extSafeSection("cheques", function () {
        return getCheques();
      }),
      fixedAssets: _extSafeSection("fixedAssets", function () {
        return getFixedAssets(callerUser, sessionToken);
      }),
      journalEntries: _extSafeSection("journalEntries", function () {
        return getJournalEntries(_auth);
      }),
      receiptVouchers: _extSafeSection("receiptVouchers", function () {
        return getReceiptVouchers(_auth);
      }),
      paymentVouchers: _extSafeSection("paymentVouchers", function () {
        return getPaymentVouchers(_auth);
      }),
      expenses: _extSafeSection("expenses", function () {
        return getExpenses(_auth);
      }),
      transferVouchers: _extSafeSection("transferVouchers", function () {
        return getTransferVouchers(_auth);
      }),
      bankReconciliations: _extSafeSection("bankReconciliations", function () {
        return getBankReconciliations(_auth);
      }),
    };

    var response = { success: true, data: result };
    try {
      _saveServerCache(response, _cacheKey, EXT_DATA_CACHE_TTL);
    } catch (e) {
      console.error("getAccountingExtendedLazy - خطأ حفظ كاش:", e.message || e);
    }
    return response;
  } catch (e) {
    return errResponse("خطأ في جلب بيانات المحاسبة التفصيلية: " + e.message);
  }
}

/**
 * [PERF-FINANCE-LIGHT-2026-08-08] ملخّص خفيف جداً لفواتير البيع/الشراء
 * مخصوص لكروت الداشبورد بس (إيرادات/مبيعات اليوم، عدد الفواتير، أفضل
 * عميل، ذمم مدينة/دائنة). بيرجّع الحقول المطلوبة فعلياً بس:
 * date, net_total, status, payment_status, party — من غير lines_json
 * (أثقل حقل، بيتفكّ بـ JSON.parse لكل صف) ومن غير notes/created_by/
 * تفاصيل الشحن... إلخ. شاشة الفواتير نفسها لسه بتنادي
 * getSaleInvoices/getPurchaseInvoices الكاملة (ON_DEMAND) زي ما هي —
 * الدالة دي إضافية بس، صفر تأثير على أي مكان تاني.
 */
function getFinanceSummaryLight(callerUser, sessionToken) {
  if (!callerUser || !sessionToken)
    return errResponse("يجب تسجيل الدخول للوصول للبيانات الموسعة");
  var sess = validateSession(sessionToken);
  if (!sess || !sess.valid) return errResponse("جلسة منتهية أو غير صالحة");

  var _callerRole = _getUserRole(callerUser) || "unknown";
  var _cacheKey = EXT_DATA_LAZY_FIN_CACHE_KEY + "_role_" + _callerRole;
  try {
    var cached = _loadServerCache(_cacheKey);
    if (cached) {
      cached._from_cache = true;
      return cached;
    }
  } catch (e) {
    console.error("getFinanceSummaryLight - خطأ:", e.message || e);
  }

  function _lightRows(sheetName, headers) {
    try {
      // بدون parseJson لـ lines_json عمداً — أثقل جزء في القراءة/التفكيك
      var rows = readSheet(sheetName, headers, {});
      return rows.map(function (r) {
        return {
          id: r.id,
          date: r.date,
          party: r.party,
          net_total: Number(r.net_total || 0),
          status: r.status,
          payment_status: r.payment_status,
        };
      });
    } catch (e) {
      Logger.log("getFinanceSummaryLight - فشل قراءة " + sheetName + ": " + e.message);
      return [];
    }
  }

  try {
    var result = {
      saleInvoicesLight: _lightRows("SaleInvoices", SALE_INVOICE_HEADERS),
      purchaseInvoicesLight: _lightRows(
        "PurchaseInvoices",
        PURCHASE_INVOICE_HEADERS,
      ),
    };

    var response = { success: true, data: result };
    try {
      // ملحوظة: TTL قصير (180 ثانية) عمداً — راجع تعليق
      // EXT_DATA_LAZY_FIN_CACHE_TTL في Code_12_Core.js
      _saveServerCache(response, _cacheKey, EXT_DATA_LAZY_FIN_CACHE_TTL);
    } catch (e) {
      console.error("getFinanceSummaryLight - خطأ حفظ كاش:", e.message || e);
    }
    return response;
  } catch (e) {
    return errResponse("خطأ في جلب ملخص الفواتير الخفيف: " + e.message);
  }
}

function getHRExtendedLazy(callerUser, sessionToken) {
  if (!callerUser || !sessionToken)
    return errResponse("يجب تسجيل الدخول للوصول للبيانات الموسعة");
  var sess = validateSession(sessionToken);
  if (!sess || !sess.valid) return errResponse("جلسة منتهية أو غير صالحة");

  var _callerRole = _getUserRole(callerUser) || "unknown";
  var _cacheKey = EXT_DATA_LAZY_HR_CACHE_KEY + "_role_" + _callerRole;
  try {
    var cached = _loadServerCache(_cacheKey);
    if (cached) {
      cached._from_cache = true;
      return cached;
    }
  } catch (e) {
    console.error("getHRExtendedLazy - خطأ:", e.message || e);
  }

  try {
    var _auth = { callerUser: callerUser, sessionToken: sessionToken };
    var result = {
      employees: _extSafeSection("employees", function () {
        return getEmployees(_auth);
      }),
      leaveRequests: _extSafeSection("leaveRequests", function () {
        return getLeaveRequests(_auth);
      }),
      loanRequests: _extSafeSection("loanRequests", function () {
        return getLoanRequests(_auth);
      }),
      payrollPeriods: _extSafeSection("payrollPeriods", function () {
        return getPayrollPeriods();
      }),
      attendance: _extSafeSection("attendance", function () {
        return getAttendance(_auth);
      }),
      productionStages: _extSafeSection("productionStages", function () {
        return getProductionStages(callerUser, sessionToken);
      }),
    };

    var response = { success: true, data: result };
    try {
      _saveServerCache(response, _cacheKey, EXT_DATA_CACHE_TTL);
    } catch (e) {
      console.error("getHRExtendedLazy - خطأ حفظ كاش:", e.message || e);
    }
    return response;
  } catch (e) {
    return errResponse("خطأ في جلب بيانات HR التفصيلية: " + e.message);
  }
}

/**
 * ⚠️ [LEGACY-COMPAT] بعد تقسيم Lazy لدومينين (acc/hr)، هذه الدالة فضلت
 * موجودة كـ wrapper رفيع فوق الدالتين الجديدتين لأي كود قديم لسه بينادي
 * الاسم ده مباشرة (أو أي مكان في الفرونت مش عارف الدومين المطلوب بالتحديد
 * فبيطلب الاتنين مع بعض). لاحظ إنها برجع الزمن الكلي (acc + hr بالتتابع)
 * تمامًا زي getAllDataExtended فوق Core/Lazy — استخدم الدالتين الجديدتين
 * مباشرة من أي كود جديد عارف دومينه لتفادي هذا القيد.
 */
function getAllDataExtendedLazy(callerUser, sessionToken) {
  var acc = getAccountingExtendedLazy(callerUser, sessionToken);
  if (!acc.success) return acc;
  var hr = getHRExtendedLazy(callerUser, sessionToken);
  if (!hr.success) return hr;

  var merged = {};
  for (var k1 in acc.data) merged[k1] = acc.data[k1];
  for (var k2 in hr.data) merged[k2] = hr.data[k2];
  return { success: true, data: merged };
}

/**
 * ⚠️ [LEGACY-COMPAT] النسخة القديمة (كل شيء في نداء واحد). لم تعد
 * تُستخدم من الفرونت (01_JS_Core_Auth.html بقى بينادي Core/Lazy بالتوازي
 * مباشرة)، لكن مُبقاة كـ wrapper رفيع فوق الدالتين الجديدتين لأي كود
 * خارجي أو تكامل قديم لسه بينادي الاسم القديم مباشرة. لاحظ إنها بترجع
 * الزمن الكلي (Core + Lazy بالتتابع) لأنها بتنفذ الاتنين داخل نفس
 * التنفيذ — استخدم Core/Lazy مباشرة من أي كود جديد لتفادي هذا القيد.
 */
function getAllDataExtended(callerUser, sessionToken) {
  var core = getAllDataExtendedCore(callerUser, sessionToken);
  if (!core.success) return core;
  var lazy = getAllDataExtendedLazy(callerUser, sessionToken);
  if (!lazy.success) return lazy;

  var merged = {};
  for (var k1 in core.data) merged[k1] = core.data[k1];
  for (var k2 in lazy.data) merged[k2] = lazy.data[k2];
  return { success: true, data: merged };
}

function diagPartyMovements(callerUser, sessionToken) {
  try {
    if (callerUser) {
      var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
      if (permErr) return permErr;
    }
    var sheet = getSheet("Transactions");
    var values = sheet.getDataRange().getValues();
    var headers = (values[0] || []).map(function (h) {
      return String(h || "").trim();
    });
    var partyColIndex = headers.indexOf("party");
    var refColIndex = headers.indexOf("ref");
    var idColIndex = headers.indexOf("id");
    var typeColIndex = headers.indexOf("type");

    var dataRows = values.slice(1);
    var txWithParty = 0;
    var txWithRef = 0;
    var partySamples = [];

    dataRows.forEach(function (row, idx) {
      var partyVal = partyColIndex >= 0 ? row[partyColIndex] : "";
      var refVal = refColIndex >= 0 ? row[refColIndex] : "";
      if (String(partyVal || "").trim()) txWithParty++;
      if (String(refVal || "").trim()) txWithRef++;
      if (partySamples.length < 20) {
        partySamples.push({
          row: idx + 2,
          id: idColIndex >= 0 ? row[idColIndex] : "",
          type: typeColIndex >= 0 ? row[typeColIndex] : "",
          party_col_value: partyVal,
          ref_col_value: refVal,
        });
      }
    });

    var suppliersRes = getSuppliers(null);
    var customersRes = getCustomers(null);
    var suppliersSample = ((suppliersRes && suppliersRes.data) || [])
      .slice(0, 10)
      .map(function (s) {
        return { id: s.id, name: s.name || s.full_name || "" };
      });
    var customersSample = ((customersRes && customersRes.data) || [])
      .slice(0, 10)
      .map(function (c) {
        return { id: c.id, name: c.name || c.full_name || "" };
      });

    return okResponse("", {
      data: {
        tx_total: dataRows.length,
        tx_with_party: txWithParty,
        tx_with_ref: txWithRef,
        party_col_index: partyColIndex,
        tx_headers: headers,
        party_samples: partySamples,
        suppliers_sample: suppliersSample,
        customers_sample: customersSample,
      },
    });
  } catch (e) {
    return errResponse("خطأ في التشخيص: " + e.message);
  }
}

function getPartyLedger(params) {
  if (!params) return errResponse("params مطلوب");
  return getPartyMovements(
    params.callerUser,
    params.partyId,
    params.partyType || "customer",
  );
}

function getItemStatement(params) {
  if (!params) return errResponse("params مطلوب");
  return getTransactionStatement(
    params.callerUser,
    params.sessionToken,
    params.itemId,
    params.warehouseId,
    params.fromDate,
    params.toDate,
  );
}

function getTransactionStatement(
  callerUser,
  sessionToken,
  itemId,
  warehouseId,
  fromDate,
  toDate,
) {
  try {
    if (callerUser) {
      var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
      if (permErr) return permErr;
    }
    if (!itemId) return errResponse("يجب تحديد الصنف");

    var whName = warehouseId ? _resolveWhName(warehouseId) : "";
    var fromD = fromDate ? new Date(fromDate) : null;
    var toD = toDate ? new Date(toDate) : null;
    if (toD) toD.setHours(23, 59, 59, 999);

    var rows = readSheet("Transactions", null, { dateOnly: false });

    var filtered = rows.filter(function (r) {
      if (String(r.item_id) !== String(itemId)) return false;
      if (whName && r.from_warehouse !== whName && r.to_warehouse !== whName)
        return false;
      if (fromD || toD) {
        var d = r.date ? new Date(r.date) : null;
        if (!d || isNaN(d.getTime())) return false;
        if (fromD && d < fromD) return false;
        if (toD && d > toD) return false;
      }
      return true;
    });

    filtered.sort(function (a, b) {
      return new Date(a.date) - new Date(b.date);
    });

    var runningBalance = 0;
    var totalIn = 0;
    var totalOut = 0;
    var statement = filtered.map(function (r) {
      var qty = Number(r.quantity || 0);
      var isInbound = !!r.to_warehouse && !r.from_warehouse;
      var isOutbound = !!r.from_warehouse && !r.to_warehouse;
      var signedQty = isOutbound ? -qty : qty;
      if (signedQty >= 0) totalIn += signedQty;
      else totalOut += Math.abs(signedQty);
      runningBalance += signedQty;
      return {
        id: r.id,
        date: r.date,
        type: r.type,
        quantity: qty,
        signed_quantity: signedQty,
        from_warehouse: r.from_warehouse || "",
        to_warehouse: r.to_warehouse || "",
        color: r.color || "",
        notes: r.notes || "",
        user: r.user || "",
        ref: r.ref || "",
        party: r.party || "",
        permit_id: r.permit_id || "",
        running_balance: runningBalance,
      };
    });

    return okResponse("", {
      data: statement,
      summary: {
        total_in: totalIn,
        total_out: totalOut,
        net: totalIn - totalOut,
        count: statement.length,
      },
    });
  } catch (e) {
    return errResponse("خطأ في جلب كشف الحركة: " + e.message);
  }
}

function getAggregatedReport(params) {
  if (!params) return errResponse("params مطلوب");
  return getStockReport(params.callerUser, params.sessionToken);
}

