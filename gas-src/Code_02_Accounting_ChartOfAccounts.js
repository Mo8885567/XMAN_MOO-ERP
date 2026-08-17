// ════════════════════════════════════════════════════════════════
// Code_Accounting_ChartOfAccounts.gs — [REFACTOR-P4] نُقل من Code_Accounting.gs (نقل نصي بحت،
// صفر تغيير في المنطق أو الترتيب الداخلي بين الدوال). Apps Script يعامل
// كل ملفات .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء
// من أي ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// راجع تقرير Architecture Audit 2026-07-03 — المرحلة 4، قسم 4-ب.
//
// المسؤولية: دليل الحسابات + إعدادات المحاسبة + الفترات المالية (Fiscal Periods) + Setup/Migration الخاصة بالمرحلة 2
// ════════════════════════════════════════════════════════════════

/**
 * Once the consolidated opening journal is posted, its affected accounts must
 * not also start reports from the legacy opening_balance column.  Keeping the
 * source value is useful for audit/history; this helper chooses the single
 * reporting source of truth without mutating historical setup data.
 */
function _coaReportingOpeningBalance(account, entries, lines, asOfDate) {
  var masterIds = {};
  (entries || []).forEach(function (entry) {
    if (
      entry.status === "POSTED" &&
      entry.reference === "OB-P2-MASTER" &&
      (!asOfDate || entry.date <= asOfDate)
    )
      masterIds[entry.id] = true;
  });
  var postedInMaster = (lines || []).some(function (line) {
    return line.account_id === account.id && masterIds[line.entry_id];
  });
  return postedInMaster ? 0 : Number(account.opening_balance || 0);
}

/**
 * [ACCOUNTING-LOOKUP-UNIFY] searchAccountsLookup — بحث سيرفر-سايد حقيقي
 * لدليل الحسابات، يُستخدم من initFinancialAccountSearcher في وضع الـ
 * Lazy Loading بدل تحميل كل الحسابات مرة واحدة في المتصفح.
 *
 * query        — نص البحث (كود أو اسم، جزئي)
 * expectedType — فلترة اختيارية حسب نوع الحساب (ASSET/LIABILITY/...)
 * limit        — أقصى عدد نتائج تُرجع (افتراضي 30)
 */
function searchAccountsLookup(query, expectedType, callerUser, sessionToken, limit) {
  try {
    if (callerUser) {
      var _permErr = _checkPermission(
        callerUser,
        "viewChartOfAccounts",
        sessionToken,
      );
      if (_permErr) return _permErr;
    }
    limit = limit && limit > 0 ? Math.min(limit, 100) : 30;
    var q = String(query || "").trim().toLowerCase();

    var rows = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    rows = rows.filter(function (a) {
      if (a.deleted_at) return false;
      if (a.is_active === false || a.is_active === "FALSE") return false;
      if (a.is_parent === true || a.is_parent === "TRUE") return false; // نعرض الحسابات القابلة للترحيل فقط
      if (expectedType && a.type !== expectedType) return false;
      if (!q) return true;
      var code = String(a.code || "").toLowerCase();
      var name = String(a.name || "").toLowerCase();
      return code.indexOf(q) !== -1 || name.indexOf(q) !== -1;
    });

    rows.sort(function (a, b) {
      return String(a.code).localeCompare(String(b.code));
    });

    var results = rows.slice(0, limit).map(function (a) {
      return { id: a.id, code: a.code, name: a.name, type: a.type };
    });

    return okResponse("", { results: results, total: rows.length });
  } catch (e) {
    return errResponse("خطأ في البحث بدليل الحسابات: " + e.message);
  }
}

function getChartAccounts(includeInactive, callerUser, sessionToken, asOfDate) {
  try {
    // [PERM-AUDIT-FIX-5] كانت هذه الدالة بلا أي فحص صلاحية إطلاقًا رغم
    // ظهورها خلف صلاحية "viewChartOfAccounts" في الشريط الجانبي (واجهة
    // فقط) — أي مستخدم مسجّل دخول (أي دور) كان يقدر يجلب شجرة الحسابات
    // كاملة سواء بنداء مباشر أو عبر getAllDataExtendedCore.
    if (callerUser) {
      var _permErr = _checkPermission(
        callerUser,
        "viewChartOfAccounts",
        sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      {
        trimStrings: true,
      },
    );
    // فلترة المحذوفة
    rows = rows.filter(function (r) {
      return !r.deleted_at;
    });
    if (!includeInactive) {
      rows = rows.filter(function (r) {
        return r.is_active !== false && r.is_active !== "FALSE";
      });
    }
    // ترتيب حسب الكود
    rows.sort(function (a, b) {
      return String(a.code).localeCompare(String(b.code));
    });

    // [FIX-COA-BAL] حساب الرصيد الديناميكي من القيود المعتمدة فعلياً
    // بدل الاعتماد على عمود current_balance المخزون (قد يكون stale)
    // [FIX-COA-ASOF] لو تم تمرير asOfDate، الرصيد يُحسب "حتى هذا التاريخ"
    // فقط بدل كل القيود المرحّلة على الإطلاق — نفس منطق
    // _coaReportingOpeningBalance بالظبط، عشان تقارير الفترة المغلقة
    // و"الرصيد كما في تاريخ" تطلع صحيحة بدل رقم إجمالي دايمًا.
    try {
      var allLines = readSheet(
        "JournalEntryLines",
        ACCOUNTING_HR_HEADERS.JournalEntryLines,
      );
      var allEntries = readSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
        { trimStrings: true },
      );

      // جمع IDs القيود المعتمدة فقط (وبحد أقصى asOfDate لو مُمرّر)
      var postedIds = {};
      allEntries.forEach(function (e) {
        if (e.status !== "POSTED") return;
        if (asOfDate && e.date > asOfDate) return;
        postedIds[e.id] = true;
      });

      // تجميع حركات كل حساب من القيود المعتمدة
      var movements = {}; // account_id → { debit, credit }
      allLines.forEach(function (line) {
        if (!postedIds[line.entry_id]) return;
        if (!movements[line.account_id]) {
          movements[line.account_id] = { debit: 0, credit: 0 };
        }
        movements[line.account_id].debit += Number(line.debit || 0);
        movements[line.account_id].credit += Number(line.credit || 0);
      });

      // حساب الرصيد الحالي لكل حساب مع إرجاع إجمالي المدين والدائن
      rows.forEach(function (acc) {
        var opening = _coaReportingOpeningBalance(
          acc,
          allEntries,
          allLines,
          asOfDate,
        );
        var mv = movements[acc.id] || { debit: 0, credit: 0 };
        var isDebitNature = ["ASSET", "EXPENSE"].indexOf(acc.type) !== -1;
        // إجمالي حركات المدين والدائن (للعرض في دليل الحسابات)
        acc.total_debit = mv.debit;
        acc.total_credit = mv.credit;
        if (isDebitNature) {
          acc.current_balance = opening + mv.debit - mv.credit;
        } else {
          // LIABILITY, EQUITY, REVENUE
          acc.current_balance = opening - mv.debit + mv.credit;
        }
        // طبيعة الرصيد: مدين أم دائن
        acc.balance_nature = isDebitNature ? "DEBIT" : "CREDIT";
      });
    } catch (balErr) {
      Logger.log("[FIX-COA-BAL] Balance calc error: " + balErr.message);
      // [FIX-AUDIT-2026 #9] كان الـ fallback صامتاً تماماً — لو فشل حساب
      // الرصيد الديناميكي، كل صف كان بيرجع لعمود current_balance المخزون
      // (ممكن يكون Stale) من غير أي إشارة للمستخدم أو للواجهة إن الرقم ده
      // مش محسوب لحظياً من القيود. دلوقتي نعلّم كل صف صراحةً بعلم
      // balance_is_stale + رسالة السبب، عشان الواجهة تقدر تعرض تحذير
      // بدل ما تعرض رقم قديم وكأنه مؤكد.
      rows.forEach(function (acc) {
        acc.balance_is_stale = true;
        acc.balance_stale_reason = balErr.message;
      });
    }

    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب دليل الحسابات: " + e.message);
  }
}
/**
 * seedDefaultChartOfAccounts — تحميل دليل الحسابات الافتراضي
 * يضيف دليلاً محاسبياً متكاملاً مناسب لشركات الملابس والتصنيع
 * لا يحذف الحسابات الموجودة — يتخطى أي كود موجود مسبقاً
 */
function _seedDefaultChartIfEmpty() {
  try {
    // تُستدعى تلقائياً من initializeSystem() — بدون فحص صلاحيات
    var callerUser = "system";

    var existing = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var existingCodes = {};
    existing.forEach(function (r) {
      if (!r.deleted_at) existingCodes[String(r.code)] = r.id;
    });

    var now = new Date().toISOString();
    var sheet = getSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );

    var DEFAULT_COA = [
      {
        code: "1",
        name: "الأصول",
        name_en: "",
        type: "ASSET",
        parent_code: null,
        is_parent: true,
      },
      {
        code: "2",
        name: "الخصوم و حقوق الملكية",
        name_en: "",
        type: "LIABILITY",
        parent_code: null,
        is_parent: true,
      },
      {
        code: "3",
        name: "المصروفات",
        name_en: "",
        type: "EXPENSE",
        parent_code: null,
        is_parent: true,
      },
      {
        code: "4",
        name: "الإيرادات",
        name_en: "",
        type: "REVENUE",
        parent_code: null,
        is_parent: true,
      },
      {
        code: "11",
        name: "الأصول طويلة الأجل",
        name_en: "",
        type: "ASSET",
        parent_code: "1",
        is_parent: true,
      },
      {
        code: "12",
        name: "الأصول المتداولة",
        name_en: "",
        type: "ASSET",
        parent_code: "1",
        is_parent: true,
      },
      {
        code: "13",
        name: "أصول أخرى",
        name_en: "",
        type: "ASSET",
        parent_code: "1",
        is_parent: true,
      },
      {
        code: "21",
        name: "الخصوم المتداولة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "2",
        is_parent: true,
      },
      {
        code: "22",
        name: "الخصوم طويلة الأجل",
        name_en: "",
        type: "LIABILITY",
        parent_code: "2",
        is_parent: true,
      },
      {
        code: "23",
        name: "مخصصات :",
        name_en: "",
        type: "LIABILITY",
        parent_code: "2",
        is_parent: true,
      },
      {
        code: "24",
        name: "حقوق الملكية",
        name_en: "",
        type: "EQUITY",
        parent_code: "2",
        is_parent: true,
      },
      {
        code: "31",
        name: "تكلفة البضاعة المباعة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3",
        is_parent: false,
      },
      {
        code: "32",
        name: "مصروفات النشاط",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3",
        is_parent: true,
      },
      {
        code: "33",
        name: "مصروفات أخرى",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3",
        is_parent: true,
      },
      {
        code: "41",
        name: "إيرادات النشاط",
        name_en: "",
        type: "REVENUE",
        parent_code: "4",
        is_parent: true,
      },
      {
        code: "42",
        name: "منح وإعانات",
        name_en: "",
        type: "REVENUE",
        parent_code: "4",
        is_parent: false,
      },
      {
        code: "43",
        name: "إيرادات استثمار وفوائد",
        name_en: "",
        type: "REVENUE",
        parent_code: "4",
        is_parent: true,
      },
      {
        code: "44",
        name: "إيرادات وأرباح أخرى",
        name_en: "",
        type: "REVENUE",
        parent_code: "4",
        is_parent: true,
      },
      {
        code: "111",
        name: "أصول ثابتة",
        name_en: "",
        type: "ASSET",
        parent_code: "11",
        is_parent: true,
      },
      {
        code: "112",
        name: "مشروعات تحت التنفيذ",
        name_en: "",
        type: "ASSET",
        parent_code: "11",
        is_parent: true,
      },
      {
        code: "113",
        name: "استثمارات طويلة الأجل",
        name_en: "",
        type: "ASSET",
        parent_code: "11",
        is_parent: true,
      },
      {
        code: "121",
        name: "نقدية بالخزينة و البنوك",
        name_en: "",
        type: "ASSET",
        parent_code: "12",
        is_parent: true,
      },
      {
        code: "122",
        name: "مخزون",
        name_en: "",
        type: "ASSET",
        parent_code: "12",
        is_parent: true,
      },
      {
        code: "123",
        name: "حسابات المدينون",
        name_en: "",
        type: "ASSET",
        parent_code: "12",
        is_parent: true,
      },
      {
        code: "124",
        name: "حسابات مدينة لدى المصالح والهيئات",
        name_en: "",
        type: "ASSET",
        parent_code: "12",
        is_parent: true,
      },
      {
        code: "127",
        name: "إيرادات مستحقة التحصيل",
        name_en: "",
        type: "ASSET",
        parent_code: "12",
        is_parent: false,
      },
      {
        code: "126",
        name: "مصروفات مدفوعة مقدما",
        name_en: "",
        type: "ASSET",
        parent_code: "12",
        is_parent: false,
      },
      {
        code: "128",
        name: "تحويلات النقدية بين الفروع",
        name_en: "",
        type: "ASSET",
        parent_code: "12",
        is_parent: false,
      },
      {
        code: "129",
        name: "استثمارات وأوراق مالية متداولة :",
        name_en: "",
        type: "ASSET",
        parent_code: "12",
        is_parent: true,
      },
      {
        code: "125",
        name: "حسابات مدينة لدى الموظفين",
        name_en: "",
        type: "ASSET",
        parent_code: "12",
        is_parent: true,
      },
      {
        code: "131",
        name: "أصول غير ملموسة",
        name_en: "",
        type: "ASSET",
        parent_code: "13",
        is_parent: true,
      },
      {
        code: "132",
        name: "نفقات مرسلة",
        name_en: "",
        type: "ASSET",
        parent_code: "13",
        is_parent: true,
      },
      {
        code: "133",
        name: "نفقات مؤجلة*",
        name_en: "",
        type: "ASSET",
        parent_code: "13",
        is_parent: true,
      },
      {
        code: "211",
        name: "حسابات الدائنون",
        name_en: "",
        type: "LIABILITY",
        parent_code: "21",
        is_parent: true,
      },
      {
        code: "212",
        name: "مصروفات مستحقة السداد",
        name_en: "",
        type: "LIABILITY",
        parent_code: "21",
        is_parent: true,
      },
      {
        code: "213",
        name: "حسابات دائنه للمصالح والهيئات",
        name_en: "",
        type: "LIABILITY",
        parent_code: "21",
        is_parent: true,
      },
      {
        code: "214",
        name: "حسابات دائنة أخرى",
        name_en: "",
        type: "LIABILITY",
        parent_code: "21",
        is_parent: true,
      },
      {
        code: "221",
        name: "قروض طويلة الأجل من شركات قابضة / تابعة / شقيقة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "22",
        is_parent: false,
      },
      {
        code: "222",
        name: "قروض طويلة الأجل من البنوك",
        name_en: "",
        type: "LIABILITY",
        parent_code: "22",
        is_parent: false,
      },
      {
        code: "223",
        name: "قروض طويلة الأجل من جهات أخرى",
        name_en: "",
        type: "LIABILITY",
        parent_code: "22",
        is_parent: false,
      },
      {
        code: "224",
        name: "سندات",
        name_en: "",
        type: "LIABILITY",
        parent_code: "22",
        is_parent: false,
      },
      {
        code: "231",
        name: "مخصص إهلاك أصول ثابتة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "23",
        is_parent: true,
      },
      {
        code: "232",
        name: "مخصص هبوط أسعار مخزون الإنتاج غير التام",
        name_en: "",
        type: "LIABILITY",
        parent_code: "23",
        is_parent: false,
      },
      {
        code: "233",
        name: "مخصص هبوط أسعار مخزون الإنتاج التام",
        name_en: "",
        type: "LIABILITY",
        parent_code: "23",
        is_parent: false,
      },
      {
        code: "234",
        name: "مخصص هبوط أسعار مخزون البضائع المشتراة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "23",
        is_parent: false,
      },
      {
        code: "235",
        name: "مخصص هبوط أسعار الأوراق المالية",
        name_en: "",
        type: "LIABILITY",
        parent_code: "23",
        is_parent: false,
      },
      {
        code: "236",
        name: "مخصص الديون المشكوك في تحصيلها",
        name_en: "",
        type: "LIABILITY",
        parent_code: "23",
        is_parent: false,
      },
      {
        code: "237",
        name: "مخصص الضرائب المتنازع عليها",
        name_en: "",
        type: "LIABILITY",
        parent_code: "23",
        is_parent: false,
      },
      {
        code: "238",
        name: "مخصص المطالبات والمنازعات",
        name_en: "",
        type: "LIABILITY",
        parent_code: "23",
        is_parent: false,
      },
      {
        code: "239",
        name: "مخصصات أخرى",
        name_en: "",
        type: "LIABILITY",
        parent_code: "23",
        is_parent: false,
      },
      {
        code: "241",
        name: "رأس المال",
        name_en: "",
        type: "EQUITY",
        parent_code: "24",
        is_parent: false,
      },
      {
        code: "242",
        name: "جاري الشركاء",
        name_en: "",
        type: "EQUITY",
        parent_code: "24",
        is_parent: false,
      },
      {
        code: "243",
        name: "أقساط متأخر سدادها",
        name_en: "",
        type: "EQUITY",
        parent_code: "24",
        is_parent: false,
      },
      {
        code: "244",
        name: "أرباح (خسائر) مرحلة",
        name_en: "",
        type: "EQUITY",
        parent_code: "24",
        is_parent: false,
      },
      {
        code: "245",
        name: "اسهم الخزينة",
        name_en: "",
        type: "EQUITY",
        parent_code: "24",
        is_parent: false,
      },
      {
        code: "246",
        name: "احتياطيات",
        name_en: "",
        type: "EQUITY",
        parent_code: "24",
        is_parent: true,
      },
      {
        code: "247",
        name: "الأرصدة الإفتتاحية",
        name_en: "",
        type: "EQUITY",
        parent_code: "24",
        is_parent: false,
      },
      {
        code: "321",
        name: "مصروفات ادارية وعمومية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "32",
        is_parent: true,
      },
      {
        code: "322",
        name: "مصروفات تسويقية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "32",
        is_parent: true,
      },
      {
        code: "323",
        name: "مصروفات تمويلية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "32",
        is_parent: true,
      },
      {
        code: "324",
        name: "مصروفات التشغيل والانتاج",
        name_en: "",
        type: "EXPENSE",
        parent_code: "32",
        is_parent: true,
      },
      {
        code: "331",
        name: "مخصصات (بخلاف الإهلاك)",
        name_en: "",
        type: "EXPENSE",
        parent_code: "33",
        is_parent: true,
      },
      {
        code: "332",
        name: "ديون معدومة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "33",
        is_parent: false,
      },
      {
        code: "333",
        name: "خسائر بيع أوراق مالية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "33",
        is_parent: false,
      },
      {
        code: "334",
        name: "أعباء وخسائر متنوعة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "33",
        is_parent: true,
      },
      {
        code: "335",
        name: "خسائر فروق العملة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "33",
        is_parent: false,
      },
      {
        code: "336",
        name: "مصروفات سنوات سابقة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "33",
        is_parent: false,
      },
      {
        code: "337",
        name: "خسائر رأسمالية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "33",
        is_parent: false,
      },
      {
        code: "338",
        name: "فروق تسويات مالية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "33",
        is_parent: false,
      },
      {
        code: "339",
        name: "ضرائب الدخل",
        name_en: "",
        type: "EXPENSE",
        parent_code: "33",
        is_parent: false,
      },
      {
        code: "411",
        name: "المبيعات",
        name_en: "",
        type: "REVENUE",
        parent_code: "41",
        is_parent: true,
      },
      {
        code: "412",
        name: "الخصومات",
        name_en: "",
        type: "REVENUE",
        parent_code: "41",
        is_parent: true,
      },
      {
        code: "413",
        name: "إيرادات النشاط الأخرى",
        name_en: "",
        type: "REVENUE",
        parent_code: "41",
        is_parent: true,
      },
      {
        code: "431",
        name: "إيرادات استثمارات مالية من شركات قابضة",
        name_en: "",
        type: "REVENUE",
        parent_code: "43",
        is_parent: false,
      },
      {
        code: "432",
        name: "إيرادات استثمارات مالية من شركات شقيقة",
        name_en: "",
        type: "REVENUE",
        parent_code: "43",
        is_parent: false,
      },
      {
        code: "433",
        name: "إيرادات استثمارات مالية أخرى",
        name_en: "",
        type: "REVENUE",
        parent_code: "43",
        is_parent: false,
      },
      {
        code: "434",
        name: "فوائد قروض لشركات قابضة / تابعة / شقيقة",
        name_en: "",
        type: "REVENUE",
        parent_code: "43",
        is_parent: false,
      },
      {
        code: "435",
        name: "فوائد دائنه أخرى",
        name_en: "",
        type: "REVENUE",
        parent_code: "43",
        is_parent: false,
      },
      {
        code: "441",
        name: "مخصصات وانتفى الغرض منها",
        name_en: "",
        type: "REVENUE",
        parent_code: "44",
        is_parent: false,
      },
      {
        code: "442",
        name: "ديون سبق إعدامها",
        name_en: "",
        type: "REVENUE",
        parent_code: "44",
        is_parent: false,
      },
      {
        code: "443",
        name: "أرباح بيع أوراق مالية",
        name_en: "",
        type: "REVENUE",
        parent_code: "44",
        is_parent: false,
      },
      {
        code: "444",
        name: "إيرادات وأرباح متنوعة",
        name_en: "",
        type: "REVENUE",
        parent_code: "44",
        is_parent: true,
      },
      {
        code: "445",
        name: "أرباح فروق العملة",
        name_en: "",
        type: "REVENUE",
        parent_code: "44",
        is_parent: false,
      },
      {
        code: "446",
        name: "إيرادات سنوية سابقة",
        name_en: "",
        type: "REVENUE",
        parent_code: "44",
        is_parent: false,
      },
      {
        code: "447",
        name: "أرباح رأسمالية",
        name_en: "",
        type: "REVENUE",
        parent_code: "44",
        is_parent: false,
      },
      {
        code: "448",
        name: "إيرادات وأرباح غير عادية",
        name_en: "",
        type: "REVENUE",
        parent_code: "44",
        is_parent: false,
      },
      {
        code: "1111",
        name: "أراضي",
        name_en: "",
        type: "ASSET",
        parent_code: "111",
        is_parent: false,
      },
      {
        code: "1112",
        name: "مباني وإنشاءات ومرافق وطرق",
        name_en: "",
        type: "ASSET",
        parent_code: "111",
        is_parent: false,
      },
      {
        code: "1113",
        name: "آلات ومعدات",
        name_en: "",
        type: "ASSET",
        parent_code: "111",
        is_parent: false,
      },
      {
        code: "1114",
        name: "وسائل نقل وانتقال",
        name_en: "",
        type: "ASSET",
        parent_code: "111",
        is_parent: false,
      },
      {
        code: "1115",
        name: "عدد وأدوات",
        name_en: "",
        type: "ASSET",
        parent_code: "111",
        is_parent: false,
      },
      {
        code: "1116",
        name: "ثروة حيوانية ومائية",
        name_en: "",
        type: "ASSET",
        parent_code: "111",
        is_parent: false,
      },
      {
        code: "1128",
        name: "إنفاق استثماري",
        name_en: "",
        type: "ASSET",
        parent_code: "112",
        is_parent: true,
      },
      {
        code: "1131",
        name: "استثمارات عقارية",
        name_en: "",
        type: "ASSET",
        parent_code: "113",
        is_parent: false,
      },
      {
        code: "1134",
        name: "استثمارات في أسهم في شركات أخرى",
        name_en: "",
        type: "ASSET",
        parent_code: "113",
        is_parent: false,
      },
      {
        code: "1135",
        name: "استثمارات في سندات",
        name_en: "",
        type: "ASSET",
        parent_code: "113",
        is_parent: false,
      },
      {
        code: "1136",
        name: "استثمارات في وثائق استثمار",
        name_en: "",
        type: "ASSET",
        parent_code: "113",
        is_parent: false,
      },
      {
        code: "1211",
        name: "الخزينة",
        name_en: "",
        type: "ASSET",
        parent_code: "121",
        is_parent: false,
      },
      {
        code: "1212",
        name: "البنوك",
        name_en: "",
        type: "ASSET",
        parent_code: "121",
        is_parent: false,
      },
      {
        code: "1213",
        name: "عهد الموظفين",
        name_en: "",
        type: "ASSET",
        parent_code: "121",
        is_parent: false,
      },
      {
        code: "1214",
        name: "ودائع بالبنوك لأجل أو بإخطار سابق",
        name_en: "",
        type: "ASSET",
        parent_code: "121",
        is_parent: false,
      },
      {
        code: "1215",
        name: "غطاء حسابات ضمان",
        name_en: "",
        type: "ASSET",
        parent_code: "121",
        is_parent: false,
      },
      {
        code: "1216",
        name: "بطاقات إئتمان",
        name_en: "",
        type: "ASSET",
        parent_code: "121",
        is_parent: false,
      },
      {
        code: "1221",
        name: "مخزون البضاعة",
        name_en: "",
        type: "ASSET",
        parent_code: "122",
        is_parent: false,
      },
      {
        code: "1222",
        name: "مخزون إنتاج غير تام",
        name_en: "",
        type: "ASSET",
        parent_code: "122",
        is_parent: false,
      },
      {
        code: "1223",
        name: "مخزون إنتاج تام",
        name_en: "",
        type: "ASSET",
        parent_code: "122",
        is_parent: false,
      },
      {
        code: "1224",
        name: "مخزون لدى الغير",
        name_en: "",
        type: "ASSET",
        parent_code: "122",
        is_parent: false,
      },
      {
        code: "1225",
        name: "اعتمادات مستنديه لشراء سلع وخدمات",
        name_en: "",
        type: "ASSET",
        parent_code: "122",
        is_parent: false,
      },
      {
        code: "1226",
        name: "مخزن خامات ومواد ووقود وقطع غيار",
        name_en: "",
        type: "ASSET",
        parent_code: "122",
        is_parent: false,
      },
      {
        code: "1227",
        name: "مخزون بضاعة على سبيل الأمانة",
        name_en: "",
        type: "ASSET",
        parent_code: "122",
        is_parent: false,
      },
      {
        code: "1228",
        name: "تحويلات المخازن",
        name_en: "",
        type: "ASSET",
        parent_code: "122",
        is_parent: false,
      },
      {
        code: "1231",
        name: "العملاء",
        name_en: "",
        type: "ASSET",
        parent_code: "123",
        is_parent: false,
      },
      {
        code: "1232",
        name: "أوراق قبض",
        name_en: "",
        type: "ASSET",
        parent_code: "123",
        is_parent: false,
      },
      {
        code: "1233",
        name: "أوراق تحت التحصيل",
        name_en: "",
        type: "ASSET",
        parent_code: "123",
        is_parent: false,
      },
      {
        code: "1234",
        name: "عملاء أجانب",
        name_en: "",
        type: "ASSET",
        parent_code: "123",
        is_parent: false,
      },
      {
        code: "1235",
        name: "الوكلاء",
        name_en: "",
        type: "ASSET",
        parent_code: "123",
        is_parent: false,
      },
      {
        code: "1236",
        name: "الموزعون",
        name_en: "",
        type: "ASSET",
        parent_code: "123",
        is_parent: false,
      },
      {
        code: "1237",
        name: "حافظة الشيكات المرتجعة",
        name_en: "",
        type: "ASSET",
        parent_code: "123",
        is_parent: false,
      },
      {
        code: "1241",
        name: "مصلحة الجمارك (أمانات)",
        name_en: "",
        type: "ASSET",
        parent_code: "124",
        is_parent: false,
      },
      {
        code: "1242",
        name: "الضرائب",
        name_en: "",
        type: "ASSET",
        parent_code: "124",
        is_parent: false,
      },
      {
        code: "1243",
        name: "مصلحة الضرائب العامة (مبالغ مخصومة من الشركة بمعرفة الغير)",
        name_en: "",
        type: "ASSET",
        parent_code: "124",
        is_parent: false,
      },
      {
        code: "1244",
        name: "الهيئة العامة للزكاة و الدخل",
        name_en: "",
        type: "ASSET",
        parent_code: "124",
        is_parent: false,
      },
      {
        code: "1291",
        name: "اسهم",
        name_en: "",
        type: "ASSET",
        parent_code: "129",
        is_parent: false,
      },
      {
        code: "1292",
        name: "سندات استثمار",
        name_en: "",
        type: "ASSET",
        parent_code: "129",
        is_parent: false,
      },
      {
        code: "1293",
        name: "وثائق استثمار",
        name_en: "",
        type: "ASSET",
        parent_code: "129",
        is_parent: false,
      },
      {
        code: "1294",
        name: "أذون خزانه",
        name_en: "",
        type: "ASSET",
        parent_code: "129",
        is_parent: false,
      },
      {
        code: "1251",
        name: "سلف الموظفين",
        name_en: "",
        type: "ASSET",
        parent_code: "125",
        is_parent: false,
      },
      {
        code: "1252",
        name: "مستحقات سداد الخدمات الالكترونية",
        name_en: "",
        type: "ASSET",
        parent_code: "125",
        is_parent: false,
      },
      {
        code: "1253",
        name: "عجز في إغلاق اليومية",
        name_en: "",
        type: "ASSET",
        parent_code: "125",
        is_parent: false,
      },
      {
        code: "1311",
        name: "شهرة",
        name_en: "",
        type: "ASSET",
        parent_code: "131",
        is_parent: false,
      },
      {
        code: "1312",
        name: "براءات اختراع/ علامات تجارية/ حقوق امتياز وتأليف",
        name_en: "",
        type: "ASSET",
        parent_code: "131",
        is_parent: false,
      },
      {
        code: "1313",
        name: "تكاليف التطوير",
        name_en: "",
        type: "ASSET",
        parent_code: "131",
        is_parent: false,
      },
      {
        code: "1321",
        name: "نفقات تحديث فروع ومعارض النشاط التجاري",
        name_en: "",
        type: "ASSET",
        parent_code: "132",
        is_parent: false,
      },
      {
        code: "1322",
        name: "مساهمة المنشأة في إنشاء أصول غير مملوكة لها وتخدم أغراضها",
        name_en: "",
        type: "ASSET",
        parent_code: "132",
        is_parent: false,
      },
      {
        code: "1323",
        name: "مقابل حق الانتفاع بمقار عن طريق الشراء بالجدك",
        name_en: "",
        type: "ASSET",
        parent_code: "132",
        is_parent: false,
      },
      {
        code: "1331",
        name: "نفقات تأسيس",
        name_en: "",
        type: "ASSET",
        parent_code: "133",
        is_parent: false,
      },
      {
        code: "1332",
        name: "نفقات ما قبل بدء الإنتاج/ التشغيل",
        name_en: "",
        type: "ASSET",
        parent_code: "133",
        is_parent: false,
      },
      {
        code: "1333",
        name: "حملة إعلانية",
        name_en: "",
        type: "ASSET",
        parent_code: "133",
        is_parent: false,
      },
      {
        code: "2111",
        name: "موردون",
        name_en: "",
        type: "LIABILITY",
        parent_code: "211",
        is_parent: false,
      },
      {
        code: "2112",
        name: "أوراق الدفع",
        name_en: "",
        type: "LIABILITY",
        parent_code: "211",
        is_parent: false,
      },
      {
        code: "2113",
        name: "دائنو التوزيعات",
        name_en: "",
        type: "LIABILITY",
        parent_code: "211",
        is_parent: false,
      },
      {
        code: "2114",
        name: "الزمم الدائنة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "211",
        is_parent: false,
      },
      {
        code: "2121",
        name: "مرتبات مستحقة السداد",
        name_en: "",
        type: "LIABILITY",
        parent_code: "212",
        is_parent: false,
      },
      {
        code: "2122",
        name: "إيرادات محصلة مقدما",
        name_en: "",
        type: "LIABILITY",
        parent_code: "212",
        is_parent: false,
      },
      {
        code: "2123",
        name: "حسابات دائنه أخرى",
        name_en: "",
        type: "LIABILITY",
        parent_code: "212",
        is_parent: false,
      },
      {
        code: "2131",
        name: "مصلحة الجمارك",
        name_en: "",
        type: "LIABILITY",
        parent_code: "213",
        is_parent: false,
      },
      {
        code: "2132",
        name: "ضريبة الفيمة المضافة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "213",
        is_parent: false,
      },
      {
        code: "2133",
        name: "مصلحة الضرائب العامة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "213",
        is_parent: false,
      },
      {
        code: "2134",
        name: "مصلحة الضرائب العقارية",
        name_en: "",
        type: "LIABILITY",
        parent_code: "213",
        is_parent: false,
      },
      {
        code: "2135",
        name: "جارى مصلحة التأمينات الاجتماعية",
        name_en: "",
        type: "LIABILITY",
        parent_code: "213",
        is_parent: false,
      },
      {
        code: "2136",
        name: "هيئات تأمينية أخرى",
        name_en: "",
        type: "LIABILITY",
        parent_code: "213",
        is_parent: false,
      },
      {
        code: "2137",
        name: "ضريبة الخصم و الإضافة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "213",
        is_parent: false,
      },
      {
        code: "2141",
        name: "سحب على المكشوف",
        name_en: "",
        type: "LIABILITY",
        parent_code: "214",
        is_parent: false,
      },
      {
        code: "2142",
        name: "تمويل اعتمادات مستنديه",
        name_en: "",
        type: "LIABILITY",
        parent_code: "214",
        is_parent: false,
      },
      {
        code: "2143",
        name: "قروض قصيرة الأجل",
        name_en: "",
        type: "LIABILITY",
        parent_code: "214",
        is_parent: false,
      },
      {
        code: "2144",
        name: "حسابات دائنه للشركات القابضة / التابعة / الشقيقة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "214",
        is_parent: false,
      },
      {
        code: "2145",
        name: "أرباح غير محققة",
        name_en: "",
        type: "LIABILITY",
        parent_code: "214",
        is_parent: false,
      },
      {
        code: "2146",
        name: "كوبونات الخصم",
        name_en: "",
        type: "LIABILITY",
        parent_code: "214",
        is_parent: false,
      },
      {
        code: "2311",
        name: "مخصص إهلاك مزروعات معمرة قابلة للإهلاك",
        name_en: "",
        type: "LIABILITY",
        parent_code: "231",
        is_parent: false,
      },
      {
        code: "2312",
        name: "مخصص إهلاك مباني وإنشاءات ومرافق وطرق",
        name_en: "",
        type: "LIABILITY",
        parent_code: "231",
        is_parent: false,
      },
      {
        code: "2313",
        name: "مخصص إهلاك آلات ومعدات",
        name_en: "",
        type: "LIABILITY",
        parent_code: "231",
        is_parent: false,
      },
      {
        code: "2314",
        name: "مخصص إهلاك وسائل نقل وانتقال",
        name_en: "",
        type: "LIABILITY",
        parent_code: "231",
        is_parent: false,
      },
      {
        code: "2315",
        name: "مخصص إهلاك عدد وأدوات",
        name_en: "",
        type: "LIABILITY",
        parent_code: "231",
        is_parent: false,
      },
      {
        code: "2316",
        name: "مخصص إهلاك أثاث وتجهيزات مكتبية",
        name_en: "",
        type: "LIABILITY",
        parent_code: "231",
        is_parent: false,
      },
      {
        code: "2317",
        name: "مخصص إهلاك ثروة حيوانية ومائية",
        name_en: "",
        type: "LIABILITY",
        parent_code: "231",
        is_parent: false,
      },
      {
        code: "2461",
        name: "احتياطي قانوني",
        name_en: "",
        type: "EQUITY",
        parent_code: "246",
        is_parent: false,
      },
      {
        code: "2462",
        name: "احتياطي نظامي",
        name_en: "",
        type: "EQUITY",
        parent_code: "246",
        is_parent: false,
      },
      {
        code: "2463",
        name: "احتياطي رأسمالي",
        name_en: "",
        type: "EQUITY",
        parent_code: "246",
        is_parent: false,
      },
      {
        code: "2464",
        name: "احتياطي أخرى",
        name_en: "",
        type: "EQUITY",
        parent_code: "246",
        is_parent: false,
      },
      {
        code: "3211",
        name: "مواد ووقود وقطع غيار",
        name_en: "",
        type: "EXPENSE",
        parent_code: "321",
        is_parent: true,
      },
      {
        code: "3212",
        name: "مصروفات نثرية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "321",
        is_parent: true,
      },
      {
        code: "3213",
        name: "أجور",
        name_en: "",
        type: "EXPENSE",
        parent_code: "321",
        is_parent: true,
      },
      {
        code: "3214",
        name: "مصروفات إدارية أخرى",
        name_en: "",
        type: "EXPENSE",
        parent_code: "321",
        is_parent: true,
      },
      {
        code: "3215",
        name: "مصروفات خدميه أخرى",
        name_en: "",
        type: "EXPENSE",
        parent_code: "321",
        is_parent: true,
      },
      {
        code: "3221",
        name: "اقامة فنادق",
        name_en: "",
        type: "EXPENSE",
        parent_code: "322",
        is_parent: false,
      },
      {
        code: "3222",
        name: "دعاية واعلان",
        name_en: "",
        type: "EXPENSE",
        parent_code: "322",
        is_parent: false,
      },
      {
        code: "3223",
        name: "هدايا وعينات تسويقية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "322",
        is_parent: false,
      },
      {
        code: "3224",
        name: "تألف إنتاج تالف / بضائع مشتراة (في مرحلة البيع)",
        name_en: "",
        type: "EXPENSE",
        parent_code: "322",
        is_parent: false,
      },
      {
        code: "3225",
        name: "غرامات التاخير",
        name_en: "",
        type: "EXPENSE",
        parent_code: "322",
        is_parent: false,
      },
      {
        code: "3226",
        name: "مؤتمرات",
        name_en: "",
        type: "EXPENSE",
        parent_code: "322",
        is_parent: false,
      },
      {
        code: "3227",
        name: "كراسات الشروط",
        name_en: "",
        type: "EXPENSE",
        parent_code: "322",
        is_parent: false,
      },
      {
        code: "3228",
        name: "اكراميات تسويقية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "322",
        is_parent: false,
      },
      {
        code: "3229",
        name: "عمولات المناديب و المسوقين",
        name_en: "",
        type: "EXPENSE",
        parent_code: "322",
        is_parent: false,
      },
      {
        code: "3231",
        name: "مصروفات بنكية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "323",
        is_parent: false,
      },
      {
        code: "3232",
        name: "مصروفات خطابات الضمان",
        name_en: "",
        type: "EXPENSE",
        parent_code: "323",
        is_parent: false,
      },
      {
        code: "3233",
        name: "مصروفات بنكية وعمولات",
        name_en: "",
        type: "EXPENSE",
        parent_code: "323",
        is_parent: false,
      },
      {
        code: "3234",
        name: "مصروفات كشف الحساب",
        name_en: "",
        type: "EXPENSE",
        parent_code: "323",
        is_parent: false,
      },
      {
        code: "3241",
        name: "اجور تشغيلية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "324",
        is_parent: false,
      },
      {
        code: "3242",
        name: "مصروفات تشغيلية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "324",
        is_parent: true,
      },
      {
        code: "3341",
        name: "خسائر بيع مخلفات",
        name_en: "",
        type: "EXPENSE",
        parent_code: "334",
        is_parent: false,
      },
      {
        code: "3342",
        name: "خسائر بيع خامات ومواد وقطع غيار",
        name_en: "",
        type: "EXPENSE",
        parent_code: "334",
        is_parent: false,
      },
      {
        code: "3343",
        name: "تعويضات وغرامات",
        name_en: "",
        type: "EXPENSE",
        parent_code: "334",
        is_parent: false,
      },
      {
        code: "3344",
        name: "تبرعات وإعانات",
        name_en: "",
        type: "EXPENSE",
        parent_code: "334",
        is_parent: false,
      },
      {
        code: "3345",
        name: "فروق تقريب الكسور العشرية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "334",
        is_parent: false,
      },
      {
        code: "3310",
        name: "فروق تسويات جردية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "331",
        is_parent: false,
      },
      {
        code: "4111",
        name: "مبيعات بضائع مشتراة",
        name_en: "",
        type: "REVENUE",
        parent_code: "411",
        is_parent: false,
      },
      {
        code: "4114",
        name: "مرتجعات مبيعات  (مدين)",
        name_en: "",
        type: "REVENUE",
        parent_code: "411",
        is_parent: false,
      },
      {
        code: "4112",
        name: "مبيعات منتج تام",
        name_en: "",
        type: "REVENUE",
        parent_code: "411",
        is_parent: false,
      },
      {
        code: "4115",
        name: "مسموحات مبيعات  (مدين)",
        name_en: "",
        type: "REVENUE",
        parent_code: "411",
        is_parent: false,
      },
      {
        code: "4113",
        name: "خدمات مباعة",
        name_en: "",
        type: "REVENUE",
        parent_code: "411",
        is_parent: false,
      },
      {
        code: "4116",
        name: "مبيعات بضاعة بغرض الأمانة",
        name_en: "",
        type: "REVENUE",
        parent_code: "411",
        is_parent: false,
      },
      {
        code: "4114",
        name: "مرتجعات مبيعات  بغرض الأمانة (مدين)",
        name_en: "",
        type: "REVENUE",
        parent_code: "411",
        is_parent: false,
      },
      {
        code: "4121",
        name: "خصم مكتسب",
        name_en: "",
        type: "REVENUE",
        parent_code: "412",
        is_parent: false,
      },
      {
        code: "4123",
        name: "خصم كميه مكتسب",
        name_en: "",
        type: "REVENUE",
        parent_code: "412",
        is_parent: false,
      },
      {
        code: "4124",
        name: "خصم كمية مسموح به ( مدين )",
        name_en: "",
        type: "REVENUE",
        parent_code: "412",
        is_parent: false,
      },
      {
        code: "4122",
        name: "خصم مسموح به ( مدين )",
        name_en: "",
        type: "REVENUE",
        parent_code: "412",
        is_parent: false,
      },
      {
        code: "4133",
        name: "ايرادات تشغيلية أخرى",
        name_en: "",
        type: "REVENUE",
        parent_code: "413",
        is_parent: false,
      },
      {
        code: "4132",
        name: "إيرادات تشغيل للغير",
        name_en: "",
        type: "REVENUE",
        parent_code: "413",
        is_parent: false,
      },
      {
        code: "4131",
        name: "عائد عقود تأجير تمويلي",
        name_en: "",
        type: "REVENUE",
        parent_code: "413",
        is_parent: false,
      },
      {
        code: "4134",
        name: "فائض إغلاق اليومية",
        name_en: "",
        type: "REVENUE",
        parent_code: "413",
        is_parent: false,
      },
      {
        code: "4135",
        name: "أرباح محققة",
        name_en: "",
        type: "REVENUE",
        parent_code: "413",
        is_parent: false,
      },
      {
        code: "4136",
        name: "ايرادات التوصيل",
        name_en: "",
        type: "REVENUE",
        parent_code: "413",
        is_parent: false,
      },
      {
        code: "4441",
        name: "أرباح بيع مخلفات",
        name_en: "",
        type: "REVENUE",
        parent_code: "444",
        is_parent: false,
      },
      {
        code: "4442",
        name: "أرباح بيع خدمات ومواد وقطع غيار",
        name_en: "",
        type: "REVENUE",
        parent_code: "444",
        is_parent: false,
      },
      {
        code: "4443",
        name: "إيرادات  تعويضات وغرامات",
        name_en: "",
        type: "REVENUE",
        parent_code: "444",
        is_parent: false,
      },
      {
        code: "4444",
        name: "عمولات",
        name_en: "",
        type: "REVENUE",
        parent_code: "444",
        is_parent: false,
      },
      {
        code: "4445",
        name: "إيجارات دائنه",
        name_en: "",
        type: "REVENUE",
        parent_code: "444",
        is_parent: false,
      },
      {
        code: "11281",
        name: "دفعات مقدمة",
        name_en: "",
        type: "ASSET",
        parent_code: "1128",
        is_parent: false,
      },
      {
        code: "11282",
        name: "اعتمادات مستنديه لشراء أصول ثابتة",
        name_en: "",
        type: "ASSET",
        parent_code: "1128",
        is_parent: false,
      },
      {
        code: "32111",
        name: "وقود وزيوت",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3211",
        is_parent: false,
      },
      {
        code: "32112",
        name: "قطع غيار ومهمات",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3211",
        is_parent: false,
      },
      {
        code: "32113",
        name: "كهرباء ومياه",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3211",
        is_parent: false,
      },
      {
        code: "32121",
        name: "تلفونات ومحمول وانترنت",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3212",
        is_parent: false,
      },
      {
        code: "32122",
        name: "ضيافة المكتب وخارجة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3212",
        is_parent: false,
      },
      {
        code: "32123",
        name: "اكراميات ادارية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3212",
        is_parent: false,
      },
      {
        code: "32124",
        name: "أدوات كتابية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3212",
        is_parent: false,
      },
      {
        code: "32131",
        name: "أجور نقدية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3213",
        is_parent: false,
      },
      {
        code: "32132",
        name: "مزايا عينية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3213",
        is_parent: false,
      },
      {
        code: "32133",
        name: "تأمينات اجتماعية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3213",
        is_parent: false,
      },
      {
        code: "32134",
        name: "مصروفات انتقالات",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3213",
        is_parent: false,
      },
      {
        code: "32135",
        name: "اتعاب محاميين ومحاسبيين",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3213",
        is_parent: false,
      },
      {
        code: "32136",
        name: "اجور نسب المناديب",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3213",
        is_parent: false,
      },
      {
        code: "32141",
        name: "خدمات مشتراة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3214",
        is_parent: false,
      },
      {
        code: "32142",
        name: "مصروفات صيانة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3214",
        is_parent: false,
      },
      {
        code: "32143",
        name: "مصروفات دعاية وإعلان ونشر وطبع وعلاقات عامة واستقبال",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3214",
        is_parent: false,
      },
      {
        code: "32144",
        name: "مصروفات نقل وانتقالات واتصالات",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3214",
        is_parent: false,
      },
      {
        code: "32145",
        name: "إيجار أصول ثابتة (بخلاف العقارات)",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3214",
        is_parent: false,
      },
      {
        code: "32146",
        name: "خدمات الجهات الحكومية والمؤسسات",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3214",
        is_parent: false,
      },
      {
        code: "32151",
        name: "الإهلاك والاستهلاك",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3215",
        is_parent: true,
      },
      {
        code: "32152",
        name: "فوائد",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3215",
        is_parent: false,
      },
      {
        code: "32153",
        name: "إيجار عقارات (أراضى ومباني)",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3215",
        is_parent: false,
      },
      {
        code: "32154",
        name: "ضرائب عقارية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3215",
        is_parent: false,
      },
      {
        code: "32155",
        name: "ضرائب غير مباشرة على النشاط",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3215",
        is_parent: false,
      },
      {
        code: "32421",
        name: "مصروف اهلاكات تشغيلية(الالات ومعدات)",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3242",
        is_parent: false,
      },
      {
        code: "32422",
        name: "مصروفات صيانة واصلاح",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3242",
        is_parent: false,
      },
      {
        code: "32423",
        name: "مصروفات تشغيل لدى الغير",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3242",
        is_parent: false,
      },
      {
        code: "32424",
        name: "مصروفات نقل تشغيلية",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3242",
        is_parent: false,
      },
      {
        code: "32425",
        name: "مصروفات استئجار الالات ومعدات للتشغيل",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3242",
        is_parent: false,
      },
      {
        code: "321511",
        name: "إهلاك الأصول الثابتة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "32151",
        is_parent: false,
      },
      {
        code: "321512",
        name: "استهلاك الأصول غير الملموسة والنفقات المرسملة",
        name_en: "",
        type: "EXPENSE",
        parent_code: "32151",
        is_parent: false,
      },

      // ── [PC-XMAN-SCREEN-2026-08-08] حسابات جديدة أُضيفت لسد الفجوات
      // اللي ظهرت بعد مطابقة شاشة "ثوابت الحسابات" مع التصميم المرجعي
      // (X-MAN) — كل حساب هنا مقابل مباشر لمفتاح ترحيل موجود في
      // POSTING_CONFIG_KEYS (Code_19_PostingConfig.js) ماكانش ليه حساب
      // افتراضي جاهز في الشجرة قبل كده، فكان السليكت بتاعه بيفضل فاضي.
      {
        code: "1218",
        name: "الفيزا",
        name_en: "",
        type: "ASSET",
        parent_code: "121",
        is_parent: false,
      },
      {
        code: "1217",
        name: "الاشعارات البنكية",
        name_en: "",
        type: "ASSET",
        parent_code: "121",
        is_parent: false,
      },
      {
        code: "1238",
        name: "الزبائن",
        name_en: "",
        type: "ASSET",
        parent_code: "123",
        is_parent: false,
      },
      {
        code: "1239",
        name: "جهات أخرى",
        name_en: "",
        type: "ASSET",
        parent_code: "123",
        is_parent: false,
      },
      {
        code: "1245",
        name: "الاشعارات",
        name_en: "",
        type: "ASSET",
        parent_code: "124",
        is_parent: false,
      },
      {
        code: "1246",
        name: "التسويات المالية",
        name_en: "",
        type: "ASSET",
        parent_code: "124",
        is_parent: false,
      },
      {
        code: "1117",
        name: "أصول مستبعدة",
        name_en: "",
        type: "ASSET",
        parent_code: "111",
        is_parent: false,
      },
      {
        code: "2138",
        name: "الضريبة الاضافية",
        name_en: "",
        type: "LIABILITY",
        parent_code: "213",
        is_parent: false,
      },
      {
        code: "2139",
        name: "ضريبة كسب العمل",
        name_en: "",
        type: "LIABILITY",
        parent_code: "213",
        is_parent: false,
      },
      {
        code: "2147",
        name: "تأمينات من الغير",
        name_en: "",
        type: "LIABILITY",
        parent_code: "214",
        is_parent: false,
      },
      {
        code: "2465",
        name: "فائض إعادة التقييم",
        name_en: "",
        type: "EQUITY",
        parent_code: "246",
        is_parent: false,
      },
      {
        code: "3235",
        name: "عمولات الفيزا",
        name_en: "",
        type: "EXPENSE",
        parent_code: "323",
        is_parent: false,
      },
      {
        code: "3346",
        name: "هالك المخزون",
        name_en: "",
        type: "EXPENSE",
        parent_code: "334",
        is_parent: false,
      },
      {
        code: "32137",
        name: "الحوافز",
        name_en: "",
        type: "EXPENSE",
        parent_code: "3213",
        is_parent: false,
      },
    ];

    var codeToId = {};
    existing.forEach(function (r) {
      if (!r.deleted_at) codeToId[String(r.code)] = r.id;
    });

    var added = 0;
    var skipped = 0;
    var errors = [];

    DEFAULT_COA.forEach(function (acc) {
      var code = String(acc.code);

      if (existingCodes[code]) {
        codeToId[code] = existingCodes[code];
        skipped++;
        return;
      }

      var parentId = "";
      if (acc.parent_code) {
        parentId = codeToId[String(acc.parent_code)] || "";
        if (!parentId) {
          errors.push(
            "الحساب " +
              code +
              " لم يُضَف: الحساب الأب " +
              acc.parent_code +
              " غير موجود",
          );
          return;
        }
      }

      // [COA-V2] المستوى بيتحدد بطول الكود مباشرة (بدل سقف ثابت عند 4)،
      // عشان الشجرة الجديدة عندها فروع بعمق يوصل لـ 6 مستويات
      // (مثلاً "321511" تحت "32151" تحت "3215"...).
      var level = String(acc.code).length;

      var id = makeId("CHA");
      codeToId[code] = id;

      if (parentId) {
        var parentSheet = getSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );
        var parentRows = readSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );
        var parentRow = parentRows.find(function (r) {
          return r.id === parentId;
        });
        if (
          parentRow &&
          parentRow.is_parent !== "TRUE" &&
          parentRow.is_parent !== true
        ) {
          var headers = parentSheet
            .getRange(1, 1, 1, parentSheet.getLastColumn())
            .getValues()[0];
          var isParentCol = headers.indexOf("is_parent") + 1;
          if (isParentCol > 0)
            parentSheet.getRange(parentRow._row, isParentCol).setValue("TRUE");
        }
      }

      var row = [
        id,
        code,
        acc.name,
        acc.name_en || "",
        acc.type,
        parentId,
        acc.is_parent ? "TRUE" : "FALSE",
        level,
        "EGP",
        typeof DEFAULT_BRANCH_NAME !== "undefined" ? DEFAULT_BRANCH_NAME : "",
        0,
        0,
        "",
        now,
        "TRUE",
        "",
        "",
      ];

      try {
        _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.ChartOfAccounts, row);
        added++;
      } catch (e2) {
        errors.push("خطأ في إضافة " + code + ": " + e2.message);
      }
    });

    _invalidateServerCacheChartOfAccounts(); // [PERF-SCOPED-INVALIDATION] scoped
    // [AUDIT-MIGRATE-FIX] كانت بتنادي _writeAuditLog بمعاملات موضعية بينما
    // توقيعها الفعلي كائن واحد entry={user,action,table,...} — يعني السطر
    // القديم ما كانش بيسجّل حاجة مفهومة فعليًا. تم التصحيح هنا كجزء من
    // الترحيل لـ AuditEngine.
    AuditEngine.log("SEED", {
      user: callerUser,
      table: "ChartOfAccounts",
      details: "تحميل الدليل الافتراضي تلقائياً",
    });

    var msg = " تم تحميل الدليل الافتراضي: " + added + " حساب جديد";
    if (skipped > 0) msg += "، " + skipped + " حساب موجود مسبقاً (تم تخطيه)";
    if (errors.length > 0) msg += "\n تحذيرات:\n" + errors.join("\n");

    return okResponse(msg, { added: added, skipped: skipped, errors: errors });
  } catch (e) {
    return errResponse("خطأ في تحميل الدليل الافتراضي: " + e.message);
  }
}
/**
 * addChartAccount — إضافة حساب جديد
 */
/**
 * _accountHasTransactions — [P2-ARCH] دالة مشتركة موحَّدة لفحص "هل لهذا
 * الحساب أي حركة مرحَّلة؟". كانت نفس منطق readSheet("JournalEntryLines")
 * + .some(account_id===id) مكررًا حرفيًا في updateChartAccount (فحص تغيير
 * النوع) و deleteChartAccount (فحص الحذف) — أي تعديل مستقبلي على معنى
 * "حركة مرحَّلة" (مثلاً استثناء قيود ملغاة CANCELLED) كان سيحتاج تعديل
 * مكانين منفصلين بخطر نسيان أحدهما. الآن مصدر حقيقة واحد.
 */
function _accountHasTransactions(accountId) {
  var lines = readSheet(
    "JournalEntryLines",
    ACCOUNTING_HR_HEADERS.JournalEntryLines,
  );
  return lines.some(function (l) {
    return l.account_id === accountId;
  });
}
function addChartAccount(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addChartAccount",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var _auditUser = data.callerUser;
    if (
      !data ||
      !ValidationEngine.isRequired(data.code) ||
      !ValidationEngine.isRequired(data.name) ||
      !ValidationEngine.isRequired(data.type)
    )
      return errResponse("كود الحساب، الاسم، والنوع مطلوبون");

    // التحقق من فريدة الكود
    var existing = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var nonDeletedExisting = existing.filter(function (r) {
      return !r.deleted_at;
    });
    if (ValidationEngine.isDuplicate(nonDeletedExisting, "code", data.code))
      return errResponse("كود الحساب موجود مسبقاً: " + data.code);

    // التحقق من نوع صالح
    var validTypes = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
    if (!ValidationEngine.isValidEnum(data.type, validTypes))
      return errResponse("نوع الحساب غير صالح: " + data.type);

    // حساب المستوى
    var level = 1;
    if (data.parent_id) {
      var parent = existing.find(function (r) {
        return r.id === data.parent_id && !r.deleted_at;
      });
      if (!parent) return errResponse("الحساب الأب غير موجود");
      if (parent.is_active === false || parent.is_active === "FALSE")
        return errResponse("لا يمكن إضافة حساب تحت حساب أب غير نشط");
      if (parent.type !== data.type)
        return errResponse(
          "يجب أن يتطابق نوع الحساب الفرعي مع نوع الحساب الأب",
        );
      level = Number(parent.level || 1) + 1;
      // تحديث is_parent للأب
      if (parent.is_parent !== true && parent.is_parent !== "TRUE") {
        var sheet = getSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );
        var headers = sheet
          .getRange(1, 1, 1, sheet.getLastColumn())
          .getValues()[0];
        var parentRow = existing.indexOf(parent) + 2;
        var isParentCol = headers.indexOf("is_parent") + 1;
        if (isParentCol > 0)
          sheet.getRange(parentRow, isParentCol).setValue("TRUE");
      }
    }

    var id = makeId("CHA");
    var now = new Date().toISOString();

    // [FIX-ISSUE-COA-4] حساب تجميعي (is_parent) منطقيًا لا يُرحَّل عليه
    // مباشرة، فرصيده الافتتاحي المفروض يكون 0 (رصيده الفعلي = مجموع
    // فروعه). هنا تحذير فقط وليس منعًا — الحساب ممكن يتحول لأب لاحقًا
    // بإضافة فرع تحته، فمينفعش نمنع الإدخال بصرامة دلوقتي.
    var _openingBalanceWarning = "";
    if (
      (data.is_parent === true || data.is_parent === "TRUE") &&
      Number(data.opening_balance || 0) !== 0
    ) {
      _openingBalanceWarning =
        " — تنبيه: تم إدخال رصيد افتتاحي لحساب تجميعي (أب)، والمفترض أن رصيد الحساب التجميعي هو مجموع فروعه فقط.";
    }

    var row = [
      id,
      data.code,
      data.name,
      data.name_en || "",
      data.type,
      data.parent_id || "",
      data.is_parent === true ? "TRUE" : "FALSE",
      level,
      data.currency || "EGP",
      data.branch || "",
      Number(data.opening_balance || 0),
      Number(data.opening_balance || 0), // current_balance = opening
      data.notes || "",
      now,
      "TRUE",
      "",
      "",
      data.subtype || "",
    ];

    var sheet = getSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.ChartOfAccounts, row);

    // Audit log
    // [AUDIT-MIGRATE-FIX] راجع نفس ملاحظة _seedDefaultChartIfEmpty أعلاه —
    // كانت بتنادي _writeAuditLog بمعاملات موضعية غلط الشكل.
    AuditEngine.logCreate({
      user:
        typeof _auditUser !== "undefined"
          ? _auditUser
          : typeof callerUser !== "undefined"
            ? callerUser
            : "system", // [FIX-ISSUE-019]
      table: "ChartOfAccounts",
      recordId: id,
      details: JSON.stringify(data),
    });

    _invalidateServerCacheChartOfAccounts(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse(
      "تم إضافة الحساب بنجاح" + _openingBalanceWarning,
      { id: id, warning: _openingBalanceWarning || undefined },
    );
  } catch (e) {
    return errResponse("خطأ في إضافة الحساب: " + e.message);
  }
}
/**
 * updateChartAccount — تعديل حساب
 */
function updateChartAccount(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateChartAccount",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var rows = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الحساب غير موجود");

    var oldRow = rows[idx];
    var rowNum = idx + 2;

    // لو غيّر الكود → تحقق من عدم التكرار
    if (data.code && data.code !== oldRow.code) {
      var nonDeletedRows = rows.filter(function (r) {
        return !r.deleted_at;
      });
      if (
        ValidationEngine.isDuplicate(nonDeletedRows, "code", data.code, {
          excludeId: id,
        })
      )
        return errResponse("كود الحساب موجود مسبقاً");
    }

    // [P2-FIX] كان التعليق يقول "لا يمكن تغيير النوع لو فيه حركات (مبسّط —
    // في الإنتاج نفحص JournalEntryLines)" لكن الفحص الفعلي لم يكن مُنفَّذًا
    // إطلاقًا — وبدلاً منه كان حقل "type" غير مدرَج في updates أصلاً، أي أن
    // أي محاولة تغيير نوع الحساب كانت تُقبَل ظاهريًا برسالة "تم التحديث
    // بنجاح" لكن دون أي تأثير فعلي، مما يضلل المستخدم. الآن: نسمح بتغيير
    // النوع فعليًا، لكن فقط إن لم يكن للحساب أي حركة مرحَّلة من قبل —
    // تمامًا كما كان مُخططًا له أصلاً، لمنع كسر تصنيف القيود التاريخية
    // (حساب مصنَّف كأصل ثم يُحوَّل فجأة لمصروف وكل القيود القديمة عليه
    // تصبح غير منطقية محاسبيًا).
    if (data.type !== undefined && data.type !== oldRow.type) {
      var validTypes = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
      if (validTypes.indexOf(data.type) === -1) {
        return errResponse("نوع الحساب غير صالح: " + data.type);
      }
      var typeHasTransactions = _accountHasTransactions(id);
      if (typeHasTransactions) {
        return errResponse(
          "لا يمكن تغيير نوع الحساب لوجود حركات مالية مرحَّلة عليه — " +
            "أنشئ حسابًا جديدًا بدلاً من ذلك إن لزم تغيير التصنيف.",
        );
      }
      var hasChildren = rows.some(function (r) {
        return r.parent_id === id && !r.deleted_at;
      });
      if (hasChildren) {
        return errResponse(
          "لا يمكن تغيير نوع حساب له حسابات فرعية — أنشئ شجرة جديدة أو انقل الحسابات الفرعية أولاً.",
        );
      }
    }

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var updates = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.name_en !== undefined) updates.name_en = data.name_en;
    if (data.code !== undefined) updates.code = data.code;
    if (data.type !== undefined) updates.type = data.type;
    if (data.notes !== undefined) updates.notes = data.notes;
    if (data.currency !== undefined) updates.currency = data.currency;
    if (data.branch !== undefined) updates.branch = data.branch;
    if (data.subtype !== undefined) updates.subtype = data.subtype;
    if (data.is_active !== undefined)
      updates.is_active = data.is_active ? "TRUE" : "FALSE";
    // [FIX-ISSUE-COA-2] "parent_id" مستبعد عمدًا من التعديل هنا — ولازم
    // يفضل كده. لو حد ضاف مستقبلاً `if (data.parent_id !== undefined)
    // updates.parent_id = data.parent_id;` لازم يسبقها فحص دورة دائرية
    // (parent_id الجديد لا يكون هو نفسه id، ولا أي حفيد من حفدة id) — وإلا
    // ينكسر حساب level/full_path وممكن تدخل الشجرة في حلقة لا نهائية.

    _applyRowUpdates(sheet, rowNum, headers, updates); // [PERF-BATCH-1]

    _invalidateServerCacheChartOfAccounts(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse("تم تحديث الحساب بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث الحساب: " + e.message);
  }
}
/**
 * deleteChartAccount — حذف حساب (حذف ناعم)
 */
function deleteChartAccount(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "deleteChartAccount",
      sessionToken,
    );
    if (_permErr) return _permErr;
    var rows = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الحساب غير موجود");

    // تحقق من عدم وجود أبناء
    var hasChildren = rows.some(function (r) {
      return r.parent_id === id && !r.deleted_at;
    });
    if (hasChildren) return errResponse("لا يمكن حذف حساب له حسابات فرعية");

    // تحقق من عدم وجود حركات
    // [BRE-INTEGRATION] كان الاستدعاء مباشرًا لـ _accountHasTransactions —
    // أصبح الآن يمر عبر BusinessRulesEngine.validateBeforeDelete('chartAccount', ...)
    // والتي تستدعي داخليًا نفس _accountHasTransactions بدون أي تغيير في السلوك.
    var _breCheck = BusinessRulesEngine.validateBeforeDelete("chartAccount", {
      id: id,
    });
    if (!_breCheck.success) return errResponse(_breCheck.message);

    // [P2-FIX] لم يكن هناك أي فحص لربط الحساب بمفتاح ترحيل في
    // AccountingSettings (مثل cash_account أو ar_account) — حذف حساب مربوط
    // كان يمر بنجاح ظاهريًا، لكنه يكسر كل القيود التلقائية المستقبلية التي
    // تعتمد عليه بصمت (راجع verifyPostingSetupComplete في §POSTING-CONFIG).
    // الآن نمنع الحذف ونوجّه المستخدم لفك الربط أولاً من شاشة إعدادات الترحيل.
    var pinnedKeys = [];
    var settingsMap = _getAccountSettingsMap();
    Object.keys(settingsMap).forEach(function (key) {
      if (settingsMap[key] === id) {
        var cfg = POSTING_CONFIG_KEYS.find(function (c) {
          return c.key === key;
        });
        pinnedKeys.push(cfg ? cfg.label : key);
      }
    });
    if (pinnedKeys.length > 0) {
      return errResponse(
        "لا يمكن حذف هذا الحساب — هو مربوط حاليًا في إعدادات الترحيل المحاسبي كـ: " +
          pinnedKeys.join("، ") +
          ". أعد ربط هذه المفاتيح بحساب آخر أولاً من شاشة إعدادات الترحيل.",
      );
    }

    var sheet = getSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var delAtCol = headers.indexOf("deleted_at");
    var delByCol = headers.indexOf("deleted_by");

    if (delAtCol !== -1)
      sheet.getRange(rowNum, delAtCol + 1).setValue(new Date().toISOString());
    if (delByCol !== -1)
      // [P2-FIX] كان مكتوبًا "system" حرفيًا دومًا بدل المستخدم الفعلي الذي
      // نفّذ الحذف — يفقد سجل التدقيق (Audit Trail) قيمته الحقيقية.
      sheet.getRange(rowNum, delByCol + 1).setValue(callerUser);
    // [P2-FIX] تأمين إضافي: تعطيل الحساب صراحة عند الحذف الناعم، بدل
    // الاعتماد فقط على فلترة deleted_at في كل قارئ — أي مسار قراءة مستقبلي
    // ينسى فلترة deleted_at سيظل على الأقل يرى الحساب كـ "غير نشط".
    var isActiveCol = headers.indexOf("is_active");
    if (isActiveCol !== -1)
      sheet.getRange(rowNum, isActiveCol + 1).setValue("FALSE");

    _invalidateServerCacheChartOfAccounts(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse("تم حذف الحساب بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف الحساب: " + e.message);
  }
}
/**
 * getAccountTree — بناء شجرة الحسابات
 */
function getAccountTree() {
  try {
    var result = getChartAccounts();
    if (!result.success) return result;

    var accounts = result.data;
    var tree = [];
    var map = {};

    // بناء map
    accounts.forEach(function (a) {
      map[a.id] = a;
      a.children = [];
    });

    // بناء الشجرة
    accounts.forEach(function (a) {
      if (a.parent_id && map[a.parent_id]) {
        map[a.parent_id].children.push(a);
      } else {
        tree.push(a);
      }
    });

    return { success: true, data: tree };
  } catch (e) {
    return errResponse("خطأ في بناء شجرة الحسابات: " + e.message);
  }
}
/**
 * [NEW] _updateChartAccountBalance — unified helper to update a chart account balance
 * Used by _updateCashBoxBalance, _updateBankAccountBalance
 */
function _updateChartAccountBalance(accountId, amount) {
  try {
    if (!accountId || !amount) return;
    var coaSheet = getSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var coaHeaders = coaSheet
      .getRange(1, 1, 1, coaSheet.getLastColumn())
      .getValues()[0];
    var balanceCol = coaHeaders.indexOf("current_balance");
    if (balanceCol === -1) return;

    var coaRows = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var coaIdx = coaRows.findIndex(function (r) {
      return r.id === accountId;
    });
    if (coaIdx === -1) return;

    var current = Number(coaRows[coaIdx].current_balance || 0);
    coaSheet.getRange(coaIdx + 2, balanceCol + 1).setValue(current + amount);
  } catch (e) {
    console.error("_updateChartAccountBalance error:", e.message);
  }
}
// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 22468-22567] B3-FIX Account Linking Engine ┄┄┄
// [B3-FIX] محرك ربط حسابات ثابت — يحل هشاشة البحث بالاسم النصي
// المشكلة الأصلية: كل القيود التلقائية كانت تبحث عن الحساب بالاسم في كل مرة،
// فإذا غيّر المستخدم اسم الحساب (مثلاً "مخزون" → "بضاعة") يتعطل القيد التلقائي صامتًا.
// الحل: جدول AccountingSettings يربط "مفتاح العملية" (ثابت لا يتغير، مثل "inventory_account")
// بـ account_id فعلي. أول مرة يُحل المفتاح بالبحث بالاسم (السلوك القديم) ثم يُثبَّت تلقائيًا.
// بعد ذلك أي تغيير لاسم الحساب لن يكسر القيود — لأن البحث بات بالـ ID لا بالاسم.
// ═══════════════════════════════════════════════════════════════════════════════
var ACCOUNTING_SETTINGS_HEADERS = [
  "key",
  "account_id",
  "updated_at",
  "updated_by",
];
/**
 * getDefaultPartyAccount — [ACC-REQUIRED] بيُستخدم من مودال إضافة/تعديل
 * عميل/مورد (10_JS_Settings_Search_Parties.html → _applyDefaultPartyAccount)
 * عشان يملي حقل "حساب الذمم المدينة/الدائنة" مبدئيًا وهو إلزامي. بيفوّض
 * لـ _getDefaultAccount (Code_19_PostingConfig.gs) بنفس مفاتيح/كلمات البحث
 * المستخدمة فعليًا في ترحيل الرصيد الافتتاحي (postPartyOpeningBalance) —
 * يعني لو الحساب اتلقّط أول مرة هنا هيُثبَّت تلقائيًا في AccountingSettings
 * (SYSTEM_AUTO_PIN) فمفيش داعي إن المستخدم يضبطه يدويًا من الإعدادات أولاً.
 * @param {String} partyType - "customer" | "supplier"
 * @returns {{success:true, account_id:String}|{success:false,message:String}}
 */
function getDefaultPartyAccount(partyType) {
  try {
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var acc =
      partyType === "supplier"
        ? _getDefaultAccount("ap_account", accounts, "LIABILITY", [
            "ذمم دائنة",
            "موردين",
            "accounts payable",
            "دائنة",
          ])
        : _getDefaultAccount("ar_account", accounts, "ASSET", [
            "ذمم مدينة",
            "عملاء",
            "accounts receivable",
            "مدينين",
          ]);
    return {
      success: true,
      account_id: acc ? acc.id : "",
      code: acc ? acc.code || "" : "",
      name: acc ? acc.name || "" : "",
    };
  } catch (e) {
    return errResponse("خطأ في تحديد الحساب الافتراضي: " + e.message);
  }
}

function _getAccountSettingsMap() {
  try {
    var rows = readSheet("AccountingSettings", ACCOUNTING_SETTINGS_HEADERS, {
      trimStrings: true,
    });
    var map = {};
    rows.forEach(function (r) {
      if (r.key) map[r.key] = r.account_id;
    });
    return map;
  } catch (e) {
    Logger.log("[_getAccountSettingsMap] خطأ: " + e.message);
    return {};
  }
}
function _setAccountSetting(key, accountId, username) {
  try {
    var sheet = getSheet("AccountingSettings", ACCOUNTING_SETTINGS_HEADERS);
    var rows = readSheet("AccountingSettings", ACCOUNTING_SETTINGS_HEADERS, {
      trimStrings: true,
    });
    var existingIdx = rows.findIndex(function (r) {
      return r.key === key;
    });
    var now = new Date().toISOString();
    if (existingIdx !== -1) {
      sheet
        .getRange(rows[existingIdx]._row, 2, 1, 3)
        .setValues([[accountId, now, username || "SYSTEM"]]);
    } else {
      sheet.appendRow([key, accountId, now, username || "SYSTEM"]);
    }
  } catch (e) {
    Logger.log("[_setAccountSetting] خطأ: " + e.message);
  }
}
/**
 * getAccountingSettings — يُرجع كل روابط الحسابات الثابتة الحالية (لعرضها/تعديلها من واجهة الإعدادات لاحقًا)
 */
function getAccountingSettings() {
  try {
    var rows = readSheet("AccountingSettings", ACCOUNTING_SETTINGS_HEADERS, {
      trimStrings: true,
    });
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var data = rows.map(function (r) {
      var acc = accounts.find(function (a) {
        return a.id === r.account_id;
      });
      return {
        key: r.key,
        account_id: r.account_id,
        account_name: acc ? acc.name : "(حساب محذوف)",
        updated_at: r.updated_at,
        updated_by: r.updated_by,
      };
    });
    return { success: true, data: data };
  } catch (e) {
    return errResponse("خطأ في جلب روابط الحسابات: " + e.message);
  }
}
/**
 * saveAccountingSetting — لتثبيت/تغيير ربط حساب يدويًا من واجهة الإعدادات (متاحة للاستخدام المستقبلي)
 */
function saveAccountingSetting(key, accountId, sessionToken) {
  var username = _getUsernameFromToken(sessionToken) || "system";
  var permErr = _checkPermission(
    username,
    "manageChartOfAccounts",
    sessionToken,
  );
  if (permErr) return permErr;
  if (!key || !accountId) return errResponse("المفتاح ومعرف الحساب مطلوبان");
  _setAccountSetting(key, accountId, username);
  _invalidateServerCacheChartOfAccounts(); // [PERF-SCOPED-INVALIDATION] scoped
  return okResponse(" تم حفظ ربط الحساب");
}
/**
 * AccountingPeriods — الفترات المحاسبية
 * تمنع الترحيل في الفترات المغلقة
 */
var ACCOUNTING_PERIODS_HEADERS = [
  "id", // PRD-YYYY-MM
  "name", // مثل "يناير 2026"
  "year",
  "month", // 1-12 أو 0 لفترة سنوية
  "start_date",
  "end_date",
  "status", // OPEN | CLOSED | LOCKED
  "closed_by",
  "closed_at",
  "locked_by",
  "locked_at",
  "notes",
  "created_at",
];
// ───────────────────────────────────────────────────────────────────────────
// §P2-01  SETUP: Register new sheets in setupSheets
// ───────────────────────────────────────────────────────────────────────────

/**
 * setupPhase2Sheets — يُنشئ أو يُحدّث الشيتات الجديدة
 * آمن تماماً للتشغيل على قاعدة بيانات موجودة — لا يمسح بيانات
 */
function setupPhase2Sheets() {
  getSheet("StockLots", STOCK_LOTS_HEADERS);
  getSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS);
  getSheet("FixedAssets", FIXED_ASSETS_HEADERS);
  getSheet("AccountingSettings", ACCOUNTING_SETTINGS_HEADERS);
  getSheet("UserPreferences", USER_PREFS_HEADERS);

  // [FIX-LOCK-TIMEOUT-1] الجذر الحقيقي لخطأ "مهلة التأمين: كانت هناك عملية
  // أخرى تؤجل التأمين لفترة طويلة جدًا" اللي بيظهر على getNotificationCenterFeed
  // (وشبهه) فور تسجيل الدخول: الشيتات دي (AnnouncementReads/UpdateVersionReads/
  // ImportLog/WeeklyReportConfig) مالهاش أي entry في HEADERS/ACCOUNTING_HR_HEADERS،
  // فبتتعمل بس Lazy أول مرة حد يستخدمها فعليًا عبر getSheet() — واللي بياخد
  // LockService.getScriptLock() (قفل واحد مشترك على مستوى السكريبت كله). بعد
  // اللوجين، الفرونت بيبعت كذا نداء متوازي (getNotificationCenterFeed +
  // getCommHubPendingAlerts + Core.getAllDataExtendedCore...) ولو أكتر من واحد
  // منهم محتاج ينشئ نفس الشيت الناقص في نفس اللحظة، بيتصفوا على نفس القفل
  // ويبدأ بعضهم ياخد أكتر من الـ 10 ثواني بتاعته وتفشل بمهلة القفل. الحل:
  // ننشئهم هنا مرة واحدة وقت الإعداد (تنفيذ واحد، من غير أي تزامن) عشان
  // أول استخدام فعلي بعد كده يلاقي الشيت موجود ومحتاجش أي قفل خالص.
  getSheet("AnnouncementReads", UM_ANN_READS_HEADERS);
  getSheet("UpdateVersionReads", UM_VERSION_READS_HEADERS);
  getSheet("ImportLog", ImportEngine.IMPORT_LOG_HEADERS);
  getReportConfigSheet(); // WeeklyReportConfig — self-healing لكن من غير قفل أصلاً، فبننشئه هنا وقائيًا برضه

  Logger.log(
    " Phase 2 sheets ready (incl. FixedAssets, AccountingSettings, UserPreferences, AnnouncementReads, UpdateVersionReads, ImportLog, WeeklyReportConfig)",
  );
  return " Phase 2 sheets ready";
}
// ───────────────────────────────────────────────────────────────────────────
// §P2-04  FISCAL PERIOD ENGINE
// ───────────────────────────────────────────────────────────────────────────

/**
 * _getFiscalPeriodForDate — يجلب الفترة المحاسبية لتاريخ معيّن
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {object|null} سجل الفترة أو null
 */
function _getFiscalPeriodForDate(dateStr) {
  try {
    var periods = readSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS, {
      trimStrings: true,
    });
    if (!periods || periods.length === 0) return null; // لا توجد فترات محاسبية = مفتوح

    var d = new Date(dateStr);
    return (
      periods.find(function (p) {
        var start = new Date(p.start_date);
        var end = new Date(p.end_date);
        return d >= start && d <= end;
      }) || null
    );
  } catch (e) {
    Logger.log("[P2-FP] _getFiscalPeriodForDate error: " + e.message);
    return null;
  }
}
/**
 * _validateFiscalPeriod — يتحقق من أن التاريخ في فترة مسموح بالترحيل فيها
 * يُستدعى من _addJournalEntryInternal قبل أي ترحيل
 * @throws {Error} إذا كانت الفترة مغلقة أو مقفلة
 */
function _validateFiscalPeriod(dateStr) {
  var period = _getFiscalPeriodForDate(dateStr);
  if (!period) return; // لا توجد فترات = كل التواريخ مسموحة

  if (period.status === "LOCKED") {
    throw new Error(
      "الفترة المحاسبية [" +
        period.name +
        "] مقفلة — لا يمكن الترحيل فيها. " +
        "يجب على مدير النظام فتح الفترة أولاً.",
    );
  }
  if (period.status === "CLOSED") {
    throw new Error(
      "الفترة المحاسبية [" +
        period.name +
        "] مغلقة. " +
        "استخدم الترحيل في فترة مفتوحة أو اطلب من المدير إعادة فتح الفترة.",
    );
  }
  // OPEN = مسموح
}
/** getAccountingPeriods — جلب كل الفترات المحاسبية */
function getAccountingPeriods(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
    if (permErr) return permErr;
    var rows = readSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS, {
      trimStrings: true,
    });
    return { success: true, data: rows };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
/** addAccountingPeriod — إنشاء فترة محاسبية */
function addAccountingPeriod(data, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
    if (permErr) return permErr;

    if (
      !ValidationEngine.isRequired(data.start_date) ||
      !ValidationEngine.isRequired(data.end_date)
    )
      return { success: false, message: "تاريخ البداية والنهاية مطلوبان" };

    var periods = readSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS, {
      trimStrings: true,
    });
    // تحقق من عدم التداخل
    var newStart = new Date(data.start_date);
    var newEnd = new Date(data.end_date);
    var overlap = periods.find(function (p) {
      var s = new Date(p.start_date);
      var e = new Date(p.end_date);
      return newStart <= e && newEnd >= s;
    });
    if (overlap) {
      return {
        success: false,
        message: "الفترة تتداخل مع فترة موجودة: " + overlap.name,
      };
    }

    var id =
      "PRD-" + data.year + "-" + String(data.month || 0).padStart(2, "0");
    var now = new Date().toISOString();
    var sheet = getSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS);
    sheet.appendRow([
      id,
      data.name || id,
      data.year || "",
      data.month || 0,
      data.start_date,
      data.end_date,
      "OPEN",
      "",
      "",
      "",
      "",
      data.notes || "",
      now,
    ]);
    return { success: true, message: "تم إنشاء الفترة المحاسبية", id: id };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
/** updateAccountingPeriodStatus — تغيير حالة الفترة */
function updateAccountingPeriodStatus(id, newStatus, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
    if (permErr) return permErr;

    var allowed = ["OPEN", "CLOSED", "LOCKED"];
    if (allowed.indexOf(newStatus) === -1)
      return { success: false, message: "حالة غير صالحة" };

    // [BUG-002/QS-01 FIX] إضافة LockService حول مسار "قراءة index الصف ثم
    // الكتابة عليه" — بدون قفل، لو اتغيّر ترتيب الصفوف بين القراءة والكتابة
    // (تعارض تزامن) ممكن يكتب حالة الفترة على صف غلط تمامًا.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return {
        success: false,
        message: "النظام مشغول بعملية أخرى على الفترات المحاسبية، حاول مرة أخرى",
      };
    }
    try {
      var periods = readSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS, {
        trimStrings: true,
      });
      var idx = periods.findIndex(function (p) {
        return p.id === id;
      });
      if (idx === -1) return { success: false, message: "الفترة غير موجودة" };

      var sheet = getSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS);
      var now = new Date().toISOString();

      // [ENGINE-AUDIT / Update Engine] كان بينادي setValue لحد 3 نداءات
      // منفصلة (status + closed_by/closed_at أو locked_by/locked_at) —
      // استُبدل بـ _applyRowUpdates الموحّدة (نداء قراءة واحد + كتابة واحدة)،
      // مع الحفاظ على نفس الـLockService المحيط بالمسار زي ما هو.
      var _periodUpdates = { status: newStatus };
      if (newStatus === "CLOSED") {
        _periodUpdates.closed_by = callerUser;
        _periodUpdates.closed_at = now;
      } else if (newStatus === "LOCKED") {
        _periodUpdates.locked_by = callerUser;
        _periodUpdates.locked_at = now;
      }
      _applyRowUpdates(
        sheet,
        idx + 2,
        ACCOUNTING_PERIODS_HEADERS,
        _periodUpdates,
      );

      _addAuditLog(
        callerUser,
        "UPDATE_PERIOD_STATUS",
        "AccountingPeriods",
        id,
        newStatus,
      );
      return { success: true, message: "تم تحديث حالة الفترة إلى " + newStatus };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * _seedDefaultFiscalYearIfEmpty — [DEFAULT-FISCAL-1] تهيئة أولى للسنة
 * المالية والفترات المحاسبية، فقط لو مش موجودة أصلاً:
 *
 *  1. لو Settings.fiscal_year_start فاضي → يضبطه على "01/01" (سنة مالية
 *     ميلادية قياسية). لو متسجّل بالفعل (أي قيمة) بيتخطاها.
 *  2. لو شيت AccountingPeriods فاضي تمامًا → ينشئ 12 فترة شهرية OPEN
 *     تغطي السنة الميلادية الحالية، عبر addAccountingPeriod() القياسية
 *     نفسها (نفس الـ id format PRD-YYYY-MM ونفس فحص التداخل)، فتتربط
 *     تلقائيًا بمحرك PeriodClosingEngine (_getFiscalPeriodForDate/
 *     _blockIfPeriodClosed) اللي كل موديولات الترحيل المحاسبي تعتمد
 *     عليه بالفعل — بدون أي محرك جديد.
 *
 * قابلة للتعديل لاحقًا بالكامل من شاشة الفترات المحاسبية (فتح/قفل/تعديل
 * تواريخ)، ولا تُنشئ فترات لو فيه أي فترة موجودة من قبل (Idempotent).
 *
 * بتتنادى من initializeSystem() في Code_21b_Migrations.js.
 */
function _seedDefaultFiscalYearIfEmpty() {
  var log = [];
  try {
    // ── 1. فترة السنة المالية (fiscal_year_start) ──
    var settings = _getCompanySettingsRaw();
    if (!settings.fiscal_year_start) {
      _saveCompanySettings({ fiscal_year_start: "01/01" });
      log.push(" تم ضبط بداية السنة المالية الافتراضية: 01/01");
    } else {
      log.push("↩️ بداية السنة المالية متسجّلة أصلاً (" + settings.fiscal_year_start + ") — تخطّي");
    }

    // ── 2. الفترات المحاسبية (12 فترة شهرية للسنة الحالية) ──
    var periods = readSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS, {
      trimStrings: true,
    });
    if (periods && periods.length > 0) {
      log.push("↩️ يوجد " + periods.length + " فترة محاسبية بالفعل — تخطّي");
      return log.join(" | ");
    }

    var users = readSheet("Users", null, { trimStrings: true });
    var systemUser =
      users.find(function (u) {
        return String(u.username).trim().toLowerCase() === "admin";
      }) || users[0];
    if (!systemUser) {
      log.push("⏭️ تخطّي إنشاء الفترات المحاسبية — مفيش يوزر بعد لإنشاء الجلسة");
      return log.join(" | ");
    }
    var sess = createSession(systemUser.username, systemUser.role);
    if (!sess || !sess.success) {
      log.push(" فشل إنشاء جلسة مؤقتة لإنشاء الفترات المحاسبية");
      return log.join(" | ");
    }

    var year = new Date().getFullYear();
    var monthNames = [
      "يناير", "فبراير", "مارس", "إبريل", "مايو", "يونيو",
      "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
    ];
    var created = 0;
    for (var m = 1; m <= 12; m++) {
      var startDate = new Date(year, m - 1, 1);
      var endDate = new Date(year, m, 0); // آخر يوم في الشهر
      var res = addAccountingPeriod(
        {
          name: monthNames[m - 1] + " " + year,
          year: year,
          month: m,
          start_date: Utilities.formatDate(startDate, "GMT+2", "yyyy-MM-dd"),
          end_date: Utilities.formatDate(endDate, "GMT+2", "yyyy-MM-dd"),
        },
        systemUser.username,
        sess.token,
      );
      if (res && res.success) created++;
      else
        Logger.log(
          "[_seedDefaultFiscalYearIfEmpty] فشل إنشاء فترة الشهر " + m + ": " +
            JSON.stringify(res),
        );
    }
    log.push(" تم إنشاء " + created + " فترة محاسبية لسنة " + year);
    return log.join(" | ");
  } catch (e) {
    Logger.log("[_seedDefaultFiscalYearIfEmpty] خطأ: " + e.message);
    return " خطأ في تهيئة السنة المالية/الفترات المحاسبية: " + e.message;
  }
}
/**
 * autoCreateFiscalPeriods — ينشئ فترات شهرية تلقائياً لسنة كاملة
 * يُشغَّل مرة واحدة لإعداد السنة
 */
function autoCreateFiscalPeriods(year, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
    if (permErr) return permErr;

    var created = 0;
    var monthNames = [
      "يناير",
      "فبراير",
      "مارس",
      "إبريل",
      "مايو",
      "يونيو",
      "يوليو",
      "أغسطس",
      "سبتمبر",
      "أكتوبر",
      "نوفمبر",
      "ديسمبر",
    ];

    for (var m = 1; m <= 12; m++) {
      var lastDay = new Date(year, m, 0).getDate(); // آخر يوم في الشهر
      var startStr = year + "-" + String(m).padStart(2, "0") + "-01";
      var endStr = year + "-" + String(m).padStart(2, "0") + "-" + lastDay;
      var result = addAccountingPeriod(
        {
          name: monthNames[m - 1] + " " + year,
          year: year,
          month: m,
          start_date: startStr,
          end_date: endStr,
        },
        callerUser,
        sessionToken,
      );
      if (result.success) created++;
    }
    return {
      success: true,
      message: "تم إنشاء " + created + " فترة محاسبية لعام " + year,
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
// ───────────────────────────────────────────────────────────────────────────
// §P2-08  ACCOUNTING INTEGRITY CHECKS
// ───────────────────────────────────────────────────────────────────────────

/**
 * runPhase2AccountingValidation — فحص شامل لسلامة البيانات المحاسبية
 * يتحقق من:
 * 1. ميزان المراجعة متوازن (مدين = دائن)
 * 2. قيمة المخزون = رصيد حساب المخزون في الأستاذ
 * 3. أرصدة العملاء = رصيد الذمم المدينة
 * 4. أرصدة الموردين = رصيد الذمم الدائنة
 * 5. الميزانية متوازنة (أصول = خصوم + حقوق ملكية)
 */
function runPhase2AccountingValidation(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
    if (permErr) return permErr;

    var results = { checks: [], passed: 0, failed: 0, warnings: 0 };

    function addCheck(name, passed, detail, isWarning) {
      results.checks.push({
        name: name,
        passed: passed,
        detail: detail,
        warning: isWarning || false,
      });
      if (passed) results.passed++;
      else if (isWarning) results.warnings++;
      else results.failed++;
    }

    // ── CHECK 1: Trial Balance ──
    try {
      var tb = getTrialBalance(null, null, callerUser, sessionToken); // [FIX-AUDIT] كانت callerUser/sessionToken بتتبعت غلط في مكان fromDate/toDate
      if (tb && tb.success) {
        var diff = Math.abs(
          (tb.totals || {}).total_debit - (tb.totals || {}).total_credit,
        );
        addCheck(
          "ميزان المراجعة",
          diff < 0.01,
          diff < 0.01 ? " متوازن" : " فرق = " + diff.toFixed(2),
        );
      }
    } catch (e) {
      addCheck("ميزان المراجعة", false, "خطأ: " + e.message);
    }

    // ── CHECK 2: Balance Sheet A = L + E ──
    try {
      var bs = getBalanceSheet(null, callerUser, sessionToken); // [FIX-AUDIT] كانت callerUser/sessionToken بتتبعت غلط في مكان asOfDate
      if (bs && bs.success && bs.data) {
        var bsData = bs.data;
        addCheck(
          "الميزانية العمومية (أصول = خصوم + حقوق ملكية)",
          bsData.is_balanced !== false,
          bsData.balance_check_message ||
            (bsData.is_balanced ? " متوازنة" : " غير متوازنة"),
        );
      }
    } catch (e) {
      addCheck("الميزانية العمومية", false, "خطأ: " + e.message);
    }

    // ── CHECK 3: Inventory Valuation vs GL ──
    try {
      var lots = readSheet("StockLots", STOCK_LOTS_HEADERS, {
        trimStrings: true,
      });
      if (lots && lots.length > 0) {
        var lotValue = lots.reduce(function (s, l) {
          return s + Number(l.qty_remaining) * Number(l.unit_cost);
        }, 0);

        // اقرأ رصيد حساب المخزون من الأستاذ
        var accounts = readSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );
        var invAcc = _getDefaultAccount(
          "inventory_account",
          accounts,
          "ASSET",
          ["مخزون", "بضاعة", "inventory", "stock"],
        );
        var glBalance = 0;
        if (invAcc) {
          var lines = readSheet(
            "JournalEntryLines",
            ACCOUNTING_HR_HEADERS.JournalEntryLines,
            { trimStrings: true },
          );
          var entries = readSheet(
            "JournalEntries",
            ACCOUNTING_HR_HEADERS.JournalEntries,
            { trimStrings: true },
          );
          var postedIds = {};
          entries
            .filter(function (e) {
              return e.status === "POSTED" && !e.deleted_at;
            })
            .forEach(function (e) {
              postedIds[e.id] = true;
            });
          lines
            .filter(function (l) {
              return l.account_id === invAcc.id && postedIds[l.entry_id];
            })
            .forEach(function (l) {
              glBalance += Number(l.debit || 0) - Number(l.credit || 0);
            });
        }

        var diff = Math.abs(lotValue - glBalance);
        addCheck(
          "قيمة المخزون (طبقات التكلفة) = رصيد حساب المخزون",
          diff < 1,
          "طبقات التكلفة: " +
            lotValue.toFixed(2) +
            " | الأستاذ: " +
            glBalance.toFixed(2) +
            " | فرق: " +
            diff.toFixed(2),
          diff >= 1 && diff < 100,
        );
      } else {
        addCheck(
          "قيمة المخزون",
          true,
          "⏭️ لا توجد طبقات تكلفة بعد — تفعّل بعد الـ Migration",
          true,
        );
      }
    } catch (e) {
      addCheck("قيمة المخزون", false, "خطأ: " + e.message);
    }

    // ── CHECK 4: Customer Balances vs AR Account ──
    try {
      var saleInv = readSheet("SaleInvoices", SALE_INVOICE_HEADERS, {
        parseJson: [],
      }).filter(function (r) {
        return !r.deleted_at;
      });
      var receipts = readSheet(
        "ReceiptVouchers",
        ACCOUNTING_HR_HEADERS.ReceiptVouchers,
      ).filter(function (r) {
        return !r.deleted_at;
      });
      var totalARFromInvoices = saleInv
        .filter(function (i) {
          return i.payment_status === "آجل" && i.status !== "CANCELLED";
        })
        .reduce(function (s, i) {
          return s + Number(i.net_total || 0);
        }, 0);
      var totalReceipts = receipts
        .filter(function (r) {
          return r.status === "APPROVED" || r.status === "POSTED";
        })
        .reduce(function (s, r) {
          return s + Number(r.amount || 0);
        }, 0);
      var netAR = totalARFromInvoices - totalReceipts;
      addCheck(
        "ذمم العملاء (فواتير آجلة - تحصيلات)",
        true,
        "فواتير آجلة: " +
          totalARFromInvoices.toFixed(2) +
          " | تحصيلات: " +
          totalReceipts.toFixed(2) +
          " | صافي: " +
          netAR.toFixed(2),
        true,
      );
    } catch (e) {
      addCheck("ذمم العملاء", false, "خطأ: " + e.message);
    }

    // ── CHECK 5: No unbalanced journal entries ──
    try {
      var entries = readSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
        { trimStrings: true },
      );
      var lines = readSheet(
        "JournalEntryLines",
        ACCOUNTING_HR_HEADERS.JournalEntryLines,
        { trimStrings: true },
      );
      var linesByEntry = {};
      lines.forEach(function (l) {
        if (!linesByEntry[l.entry_id])
          linesByEntry[l.entry_id] = { dr: 0, cr: 0 };
        linesByEntry[l.entry_id].dr += Number(l.debit || 0);
        linesByEntry[l.entry_id].cr += Number(l.credit || 0);
      });
      var unbalanced = entries.filter(function (e) {
        if (e.deleted_at || e.status === "CANCELLED") return false;
        var totals = linesByEntry[e.id] || { dr: 0, cr: 0 };
        return Math.abs(totals.dr - totals.cr) > 0.01;
      });
      addCheck(
        "القيود المحاسبية متوازنة (مدين = دائن)",
        unbalanced.length === 0,
        unbalanced.length === 0
          ? " جميع القيود متوازنة"
          : " " +
              unbalanced.length +
              " قيد غير متوازن: " +
              unbalanced
                .map(function (e) {
                  return e.id;
                })
                .join(", "),
      );
    } catch (e) {
      addCheck("القيود المحاسبية", false, "خطأ: " + e.message);
    }

    results.summary =
      results.failed === 0
        ? " جميع الفحوصات نجحت (" +
          results.passed +
          "/" +
          (results.passed + results.warnings) +
          ")"
        : " " +
          results.failed +
          " فحص(وص) فاشل + " +
          results.warnings +
          " تحذير";

    return { success: true, data: results };
  } catch (e) {
    return { success: false, message: "خطأ في فحص السلامة: " + e.message };
  }
}
// ───────────────────────────────────────────────────────────────────────────
// §P2-09  MIGRATION SCRIPTS
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// §P2-12  OPENING BALANCE IMPROVEMENTS — Full GL Reconciliation
// ───────────────────────────────────────────────────────────────────────────

/**
 * postOpeningBalanceJournalP2 — قيد أرصدة افتتاحية محسّن
 * يشمل: المخزون + الذمم المدينة + الذمم الدائنة + النقدية + البنوك + حقوق الملكية
 * يمنع التكرار بفحص reference
 */
function postOpeningBalanceJournalP2(callerUser, sessionToken) {
  try {
    // [FIX-ISSUE-OB-2] كانت هذه العملية المحاسبية تتطلب "manageRoles" (صلاحية
    // إدارية عامة لا علاقة لها بالمحاسبة) بينما نفس نوع العملية لطرف واحد
    // (postPartyOpeningBalance) يتطلب "addJournalEntry" — عدم اتساق يسمح
    // لمستخدم بصلاحية إدارة أدوار فقط بترحيل القيد الافتتاحي الموحّد لكل
    // الشركة. توحيد الاثنين على نفس الصلاحية المحاسبية المناسبة.
    var permErr = _checkPermission(callerUser, "addJournalEntry", sessionToken);
    if (permErr) return permErr;

    // تحقق من عدم وجود قيد افتتاحي سابق
    var existingEntries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var alreadyPosted = existingEntries.some(function (e) {
      return e.reference === "OB-P2-MASTER" && e.status === "POSTED";
    });
    if (alreadyPosted) {
      return {
        success: false,
        message: "القيد الافتتاحي الموحد موجود بالفعل (OB-P2-MASTER)",
      };
    }

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var lines = [];
    var totalDebit = 0;
    var today = new Date().toISOString().split("T")[0];

    // 1. المخزون — من OpeningStock × cost_price
    var openingRows = [];
    try {
      openingRows = readSheet("OpeningStock", OPENING_STOCK_HEADERS, {
        trimStrings: true,
      });
    } catch (e) {
      Logger.log("[silent-catch] " + e);
    }
    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var itemMap = {};
    items.forEach(function (it) {
      itemMap[it.id] = it;
    });

    var inventoryAccount = _getDefaultAccount(
      "inventory_account",
      accounts,
      "ASSET",
      ["مخزون", "بضاعة", "inventory"],
    );
    if (inventoryAccount) {
      var inventoryValue = openingRows.reduce(function (s, row) {
        var item = itemMap[row.item_id];
        // [MD-06 FIX] نفس أولوية unit_cost الصريح قبل cost_price الحالي
        var explicitCost = Number(row.unit_cost || 0);
        var cost =
          explicitCost > 0
            ? explicitCost
            : item
              ? Number(item.cost_price || 0)
              : 0;
        return s + Number(row.quantity || 0) * cost;
      }, 0);
      if (inventoryValue > 0) {
        lines.push({
          account_id: inventoryAccount.id,
          debit: inventoryValue,
          credit: 0,
          notes: "مخزون افتتاحي",
        });
        totalDebit += inventoryValue;
      }
    }

    // 2. حسابات الأصول والخصوم من ChartOfAccounts opening_balance
    var equityAccount = _getDefaultAccount(
      "equity_account",
      accounts,
      "EQUITY",
      ["رأس المال", "حقوق الملكية", "equity", "capital"],
    );
    var totalNonInventoryAssets = 0;
    var totalLiabilities = 0;

    // [MD-07 FIX] استبعاد حسابي الذمم المدينة/الدائنة العامّين من هذا الحلقة —
    // أرصدتهما الافتتاحية يجب أن تُرحَّل فقط عبر postPartyOpeningBalance لكل
    // عميل/مورد على حدة (بمرجع OB-<partyId> منفصل لكل طرف)، وليس كرقم إجمالي
    // واحد هنا. بدون هذا الاستبعاد، لو أحد ملأ حقل opening_balance على حساب
    // الذمم نفسه في دليل الحسابات (بالخطأ أو تقديرًا)، كان سيُرحَّل القيد
    // الموحّد هذا المبلغ **بالإضافة** لمجموع أرصدة الأطراف الفردية، فيتضاعف
    // رصيد الذمم في الأستاذ العام عن الحقيقة.
    var arAccountForExclusion = _getDefaultAccount(
      "ar_account",
      accounts,
      "ASSET",
      ["ذمم مدينة", "عملاء", "accounts receivable", "مدينين"],
    );
    var apAccountForExclusion = _getDefaultAccount(
      "ap_account",
      accounts,
      "LIABILITY",
      ["ذمم دائنة", "موردين", "accounts payable", "دائنة"],
    );

    accounts
      .filter(function (a) {
        return (
          !a.deleted_at &&
          a.is_active !== false &&
          !a.is_parent &&
          Number(a.opening_balance || 0) !== 0
        );
      })
      .forEach(function (acc) {
        var ob = Number(acc.opening_balance || 0);
        var accType = (acc.type || "").toUpperCase();
        if (acc.id === (inventoryAccount && inventoryAccount.id)) return; // سبق إضافته
        if (acc.id === (arAccountForExclusion && arAccountForExclusion.id))
          return; // [MD-07] يُرحَّل فقط عبر postPartyOpeningBalance لكل عميل
        if (acc.id === (apAccountForExclusion && apAccountForExclusion.id))
          return; // [MD-07] يُرحَّل فقط عبر postPartyOpeningBalance لكل مورد

        if (accType === "ASSET") {
          lines.push({
            account_id: acc.id,
            debit: Math.abs(ob),
            credit: 0,
            notes: "رصيد افتتاحي",
          });
          totalDebit += Math.abs(ob);
          totalNonInventoryAssets += Math.abs(ob);
        } else if (accType === "LIABILITY") {
          lines.push({
            account_id: acc.id,
            debit: 0,
            credit: Math.abs(ob),
            notes: "رصيد افتتاحي",
          });
          totalLiabilities += Math.abs(ob);
        }
        // EQUITY و INCOME و EXPENSE تُحسب في الطرف المعاكس
      });

    if (lines.length === 0) {
      return { success: false, message: "لا توجد أرصدة افتتاحية لترحيلها" };
    }

    // 3. حساب حقوق الملكية كرصيد موازن
    var totalCredit = lines.reduce(function (s, l) {
      return s + Number(l.credit || 0);
    }, 0);
    var equityNeeded = totalDebit - totalCredit;
    if (equityNeeded > 0.01 && equityAccount) {
      lines.push({
        account_id: equityAccount.id,
        debit: 0,
        credit: equityNeeded,
        notes: "حقوق الملكية الافتتاحية",
      });
    } else if (equityNeeded < -0.01 && equityAccount) {
      lines.push({
        account_id: equityAccount.id,
        debit: Math.abs(equityNeeded),
        credit: 0,
        notes: "حقوق الملكية الافتتاحية",
      });
    }

    var result = _addJournalEntryInternal({
      callerUser: callerUser,
      date: today,
      reference: "OB-P2-MASTER",
      description: "قيد الأرصدة الافتتاحية الموحد [Phase 2]",
      source_type: "OPENING_BALANCE",
      lines: lines,
    });

    // The internal posting routine updates the legacy current_balance snapshot
    // from its previous value. For accounts whose opening amount has now moved
    // into OB-P2-MASTER, refresh that snapshot from the same single-source
    // logic used by the reports so operational screens cannot show it twice.
    if (result && result.success) {
      try {
        var refreshed = getChartAccounts(true);
        if (refreshed && refreshed.success) {
          var balanceById = {};
          refreshed.data.forEach(function (account) {
            balanceById[account.id] = account.current_balance;
          });
          var coaSheet = getSheet(
            "ChartOfAccounts",
            ACCOUNTING_HR_HEADERS.ChartOfAccounts,
          );
          var coaHeaders = coaSheet
            .getRange(1, 1, 1, coaSheet.getLastColumn())
            .getValues()[0];
          var balanceCol = coaHeaders.indexOf("current_balance") + 1;
          if (balanceCol > 0) {
            accounts.forEach(function (account, index) {
              if (balanceById[account.id] !== undefined) {
                coaSheet
                  .getRange(index + 2, balanceCol)
                  .setValue(balanceById[account.id]);
              }
            });
          }
        }
      } catch (snapshotErr) {
        Logger.log(
          "[OB-P2] current_balance refresh failed: " + snapshotErr.message,
        );
      }
    }

    return result;
  } catch (e) {
    return {
      success: false,
      message: "خطأ في قيد الأرصدة الافتتاحية: " + e.message,
    };
  }
}
