// ═════════════════════════════════════════════════════════════════════════
// Code_53_DataRegistryEngine.js  —  P0: محرك تحميل البيانات المركزي
// ─────────────────────────────────────────────────────────────────────────
// الهدف من هذا الملف (ولا شيء غيره في هذه المرحلة):
//
//   1) مصدر حقيقة واحد (Single Source of Truth) لكل "نوع بيانات" في النظام:
//      اسمه، الشيت اللي بييجي منه، الـ headers، أعمدة الـ JSON اللي لازم
//      تتفكّ، أي getter مخصص (لو مش قراءة شيت مباشرة زي customers/suppliers)،
//      ومستواه (1..4) حسب تصنيف الأربع مستويات المتفق عليه.
//
//   2) دالة building واحدة (_buildDataBundle) بتبني أي حزمة بيانات من
//      الـ registry، فبدل ما إضافة نوع بيانات جديد تحتاج تعديل يدوي في
//      5 أماكن منفصلة (HEADERS, getAllData, getAllDataLight, _parseData,
//      cache) — تحتاج سطر واحد فقط هنا. هذا هو الحل الجذري لمشكلة §3.2
//      في تقرير المرحلة الأولى (بج sizeGroups وأي بج مشابه له مستقبلاً).
//
//   3) نقطة نهاية جديدة getAllDataByLevel(levels) تسمح للواجهة تطلب
//      "بس مستوى 1" وقت فتح الشاشة، ثم تطلب باقي المستويات لاحقاً في
//      الخلفية — بدون ما تنتظر الحزمة الكاملة زي getAllData() الحالية.
//
// ⚠️ إلزامي: هذا الملف "إضافي" فقط. getAllData() و getAllDataLight()
//    الحاليتين في Code_12_Core.js لم تُلمَسا ولن تتغيرا في هذه المرحلة —
//    كل الشاشات الحالية تستمر تشتغل زي ما هي بالظبط. الدمج التدريجي معهم
//    هو P1 (مرحلة منفصلة) بعد الموافقة على هذا الملف.
// ═════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// §1  تعريف المستويات الأربعة (نفس تعريفك بالحرف)
// ─────────────────────────────────────────────────────────────
const DATA_LEVEL = Object.freeze({
  CRITICAL: 1, // يُحمَّل فور فتح الشاشة (مستخدم، شركة، فرع، افتراضيات، كود جديد)
  ON_DEMAND: 2, // يُحمَّل فقط لما المستخدم يحتاجه (قوائم كبيرة، حسابات، عملاء...)
  BACKGROUND: 3, // يُحمَّل في الخلفية بعد ما الشاشة تبقى جاهزة (صور، مرفقات، سجل)
  REFERENCE: 4, // يُحمَّل مرة واحدة ونادراً ما يتغيّر (وحدات، عملات، ضرائب، إعدادات)
});

// ─────────────────────────────────────────────────────────────
// §2  DATA_REGISTRY  —  مصدر الحقيقة الواحد
// ─────────────────────────────────────────────────────────────
// كل مفتاح هنا = نفس اسم الحقل اللي راجع حالياً من getAllData() تمامًا،
// عشان أي دمج مستقبلي مع الكود الحالي يكون بدون كسر أي شاشة.
//
//   sheet      : اسم الشيت (لو القراءة قراءة شيت مباشرة عبر readSheet)
//   headers    : مصفوفة الأعمدة الرسمية (تُستخدم أيضاً كمرجع لـ getSheet)
//   parseJson  : أعمدة الـ JSON اللي محتاجة JSON.parse تلقائي
//   custom     : اسم دالة بديلة (getter) لو المصدر مش قراءة شيت مباشرة
//                (زي getChartAccounts, getCustomers, getWarehouses...)
//   level      : أحد قيم DATA_LEVEL
//   note       : سبب التصنيف (توثيق، مش منطق)
// ─────────────────────────────────────────────────────────────
// ملاحظة تصميمية مهمة (اكتُشفت أثناء P1-ب):
// `level` يحدد "متى يُسمح بتأجيل هذا الحقل نظرياً" حسب تصنيف المستويات
// الأربعة. لكن `getAllDataLight()` — حزمة اللوجين الخفيفة الفعلية
// المستخدمة بالفعل في `01_JS_Core_Auth.html` لرسم لوحة التحكم فور
// الدخول — تحتاج عملياً مجموعة حقول أوسع من "Critical" الصارم (مثل
// items/stock/chartOfAccounts/colors/sizes) لأن الداشبورد يعرض أرقامها
// فوراً. بدل ما نُجبر `level` يخدم غرضين مختلفين (تصنيف نظري + حزمة
// لوجين فعلية) ونكسر أحدهما، أضفنا علامة صريحة منفصلة `lightBundle:true`
// على أي حقل تحتاجه `getAllDataLight()` فعلياً بغض النظر عن مستواه.
const DATA_REGISTRY = {
  // ===== المستوى 1 — Critical =====
  companySettings: {
    custom: "_getCompanySettingsRaw",
    level: DATA_LEVEL.CRITICAL,
    lightBundle: true,
    note: "إعدادات الشركة/الفرع — لازمة لرسم أي واجهة",
  },
  users: {
    custom: "_getSafeUsersList",
    level: DATA_LEVEL.CRITICAL,
    lightBundle: true,
    note: "بيانات المستخدم الحالي والصلاحيات المرتبطة به",
  },
  roles: {
    custom: "_getRolesList",
    level: DATA_LEVEL.CRITICAL,
    lightBundle: true,
  },
  permissions: {
    custom: "_getAllPermissionsList",
    level: DATA_LEVEL.CRITICAL,
    lightBundle: true,
  },
  userOverrides: {
    custom: "_getUserOverridesMap",
    level: DATA_LEVEL.CRITICAL,
    lightBundle: true,
  },
  warehouses: {
    custom: "getWarehouses",
    level: DATA_LEVEL.CRITICAL,
    lightBundle: true,
    note: "مطلوبة كقيمة افتراضية في شاشات كتير (فرع/مخزن افتراضي)",
  },
  groups: {
    sheet: "Groups",
    level: DATA_LEVEL.CRITICAL,
    lightBundle: true,
    note: "شجرة تصنيف الأصناف — تُستخدم في القوائم الافتراضية",
  },

  // ===== المستوى 2 — On Demand =====
  items: {
    sheet: "Items",
    parseJson: ["colors_json"],
    postProcess: "_postProcessItems", // normalize colors + استبعاد المحذوف ناعماً
    level: DATA_LEVEL.ON_DEMAND,
    lightBundle: true, // الداشبورد يعرض عدد/قيمة الأصناف فوراً
    note: "قائمة كبيرة نسبياً — تُطلب عند فتح شاشة الأصناف/القوائم المنسدلة",
  },
  stock: {
    sheet: "Stock",
    level: DATA_LEVEL.ON_DEMAND,
    lightBundle: true, // الداشبورد يعرض قيمة المخزون فوراً
  },
  chartOfAccounts: {
    custom: "_getChartAccountsList",
    level: DATA_LEVEL.ON_DEMAND,
    lightBundle: true, // معتمد عليه في شاشات كتير من فتح التطبيق مباشرة
    note: "كانت جزءاً من المستوى الحرج سابقاً (§3.1) — منقولة هنا؛ الدمج الفعلي في getAllData يتم في P1",
  },
  customers: {
    custom: "_getCustomersList",
    level: DATA_LEVEL.ON_DEMAND,
  },
  suppliers: {
    custom: "_getSuppliersList",
    level: DATA_LEVEL.ON_DEMAND,
  },
  customerCategories: {
    custom: "_getCustomerCategoriesList",
    level: DATA_LEVEL.ON_DEMAND,
  },
  supplierCategories: {
    custom: "_getSupplierCategoriesList",
    level: DATA_LEVEL.ON_DEMAND,
  },
  saleInvoices: {
    sheet: "SaleInvoices",
    headersConst: "SALE_INVOICE_HEADERS",
    parseJson: ["lines_json"],
    level: DATA_LEVEL.ON_DEMAND,
    note: "بنود الفواتير مفكوكة بالكامل — أثقل عنصر في الحزمة الحالية (§3.1)",
  },
  purchaseInvoices: {
    sheet: "PurchaseInvoices",
    headersConst: "PURCHASE_INVOICE_HEADERS",
    parseJson: ["lines_json"],
    level: DATA_LEVEL.ON_DEMAND,
  },
  saleReturns: {
    sheet: "SaleReturns",
    headersConst: "SALE_RETURN_HEADERS",
    parseJson: ["lines_json"],
    level: DATA_LEVEL.ON_DEMAND,
  },
  purchaseReturns: {
    sheet: "PurchaseReturns",
    headersConst: "PURCHASE_RETURN_HEADERS",
    parseJson: ["lines_json"],
    level: DATA_LEVEL.ON_DEMAND,
  },
  productionOrders: {
    sheet: "ProductionOrders",
    level: DATA_LEVEL.ON_DEMAND,
  },
  shipments: {
    custom: "_getShipmentsList",
    level: DATA_LEVEL.ON_DEMAND,
  },
  openingStock: {
    custom: "_getOpeningStockList",
    level: DATA_LEVEL.ON_DEMAND,
    lightBundle: true,
  },
  transactions: {
    sheet: "Transactions",
    level: DATA_LEVEL.ON_DEMAND,
    note: "سجل حركات — يكبر مع الوقت، مرشّح لاحقاً لـ pagination (خارج نطاق P0)",
  },

  // ===== المستوى 3 — Background (P2 — مُكتمل) =====
  // ⚠️ ملاحظة أمان حاسمة قبل قراءة هذا القسم: كل حقل هنا `requiresAuth:true`
  // بيستدعي بالضبط نفس دالة الأعمال الأصلية (getEmployees, getCheques...)
  // بنفس (callerUser, sessionToken) اللي كانت بتتبعت لها من جوه
  // getAllDataExtendedCore/Lazy. الفحص الأمني الحقيقي (_checkPermission +
  // validateSession fail-closed) موجود *داخل* كل دالة أعمال بنفسها، مش في
  // طبقة الكاش الخارجية لـ getAllDataExtendedLazy — فاستدعاؤها هنا مباشرة
  // بنفس البارامترات آمن 100% ولا يتخطى أي فحص صلاحيات كان موجودًا.
  //
  // الفرق الوحيد: مفيش هنا كاش "حزمة كاملة لكل دور" زي
  // _cacheKey = ..._role_ + role الموجود في getAllDataExtendedLazy —
  // ده مقصود: getAllDataByLevel([BACKGROUND], auth) مسار إضافي جديد
  // موازٍ (وليس بديلاً) لـ getAllDataExtendedCore/Lazy القديمتين، واللي
  // فضلتا كما هما بدون أي تعديل. لو شاشة جديدة استخدمت هذا المسار بكثافة
  // مستقبلاً، إضافة كاش لكل حقل بمفرده (بدل حزمة كاملة) قرار P3 منفصل.
  hrEmployees: {
    custom: "_bgGetEmployees",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
    note: "مطابق لحقل employees في getHRExtendedLazy — نفس getEmployees()",
  },
  hrLeaveRequests: {
    custom: "_bgGetLeaveRequests",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  hrLoanRequests: {
    custom: "_bgGetLoanRequests",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  hrPayrollPeriods: {
    custom: "_bgGetPayrollPeriods",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
    note: "getPayrollPeriods() الأصلية بلا باراميترات — wrapper يتجاهل auth بأمان",
  },
  hrDepartments: {
    custom: "_bgGetDepartments",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  hrAttendance: {
    custom: "_bgGetAttendance",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  hrProductionStages: {
    custom: "_bgGetProductionStages",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  accCheques: {
    custom: "_bgGetCheques",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  accFixedAssets: {
    custom: "_bgGetFixedAssets",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  accJournalEntries: {
    custom: "_bgGetJournalEntries",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  accCashBoxes: {
    custom: "_bgGetCashBoxes",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  accBankAccounts: {
    custom: "_bgGetBankAccounts",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
    note: "getBankAccounts() الأصلية توقيعها (callerUser) فقط بدون sessionToken",
  },
  accReceiptVouchers: {
    custom: "_bgGetReceiptVouchers",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  accPaymentVouchers: {
    custom: "_bgGetPaymentVouchers",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  accExpenses: {
    custom: "_bgGetExpenses",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  accTransferVouchers: {
    custom: "_bgGetTransferVouchers",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  accBankReconciliations: {
    custom: "_bgGetBankReconciliations",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  // [REBUILD-ACC-HR-2026] الأربعة حقول دي كانت بس جوه getAllDataExtendedCore
  // القديمة (المسار المهجور دلوقتي) — بننقلها هنا عشان تبقى جزء من نفس
  // محرك التحميل الحديث الموحّد، ومفيش أي حقل يضيع أو يفضل معتمد على
  // مسار قديم منفصل.
  hrJobTitles: {
    custom: "_bgGetJobTitles",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: true,
  },
  hrLeaveTypes: {
    custom: "_bgGetLeaveTypes",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: false,
    note: "getLeaveTypes() الأصلية بلا أي معامِلات",
  },
  accSettings: {
    custom: "_bgGetAccountingSettings",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: false,
    note: "قيمة محسوبة من companySettings — مفيش قراءة شيت إضافية",
  },
  hrSettingsBundle: {
    custom: "_bgGetHrSettings",
    level: DATA_LEVEL.BACKGROUND,
    requiresAuth: false,
    note: "ثوابت إعداد HR — مفيش قراءة شيت، بترجع كائن ثابت",
  },

  // ===== المستوى 4 — Reference / Cache دائم =====
  colors: {
    custom: "_readColorsRaw",
    level: DATA_LEVEL.REFERENCE,
    lightBundle: true,
  },
  sizes: {
    custom: "_readSizesRaw",
    level: DATA_LEVEL.REFERENCE,
    lightBundle: true,
  },
  // ✅ هذا بالظبط الحقل اللي كان بيضيع (§3.2 في التقرير). دلوقتي وجوده في
  // الـ registry يضمن وصوله لأي دالة تبني حزمة بيانات من هنا تلقائياً —
  // بدل ما يعتمد على تذكّر تعديله في كل مكان بشكل منفصل.
  sizeGroups: {
    custom: "_readSizeGroupsRaw",
    level: DATA_LEVEL.REFERENCE,
    lightBundle: true,
  },
  // [UNITS-2026-08-06] وحدات القياس — راجع Code_55_Units.js.
  units: {
    custom: "_readUnitsRaw",
    level: DATA_LEVEL.REFERENCE,
    lightBundle: true,
  },
};

// ─────────────────────────────────────────────────────────────
// §3  دوال مساعدة خفيفة (Wrappers) لموحّدة استدعاء الـ custom getters
// ─────────────────────────────────────────────────────────────
// هذه wrappers فقط حول دوال موجودة بالفعل في الكود الحالي (Code_12_Core،
// Code_20a_Parties، إلخ) — لا تغيّر أي منطق، فقط تعيد تشكيل الشكل الراجع
// ليكون متوافقاً مع نفس بنية getAllData() الحالية دون تكرار الكود.
// ─────────────────────────────────────────────────────────────

function _getSafeUsersList() {
  return cleanArr(getSheetData("Users")).map(function (u) {
    return {
      username: u.username,
      full_name: u.full_name,
      role: u.role,
      active: _isActiveUser(u.active),
      email: u.email || "",
      last_login: u.last_login
        ? u.last_login instanceof Date
          ? u.last_login.toISOString()
          : u.last_login
        : "",
      forcePasswordChange: _isForceChange(u.force_password_change),
    };
  });
}

function _getRolesList() {
  try {
    return (getRoles().data || []);
  } catch (e) {
    return [];
  }
}

function _getAllPermissionsList() {
  return typeof ALL_PERMISSIONS !== "undefined" ? ALL_PERMISSIONS : [];
}

function _getUserOverridesMap() {
  var userOverrides = {};
  try {
    var overrideRows = readSheet("UserPermissions", USER_PERM_HEADERS, {
      trimStrings: true,
    });
    overrideRows.forEach(function (r) {
      var extra = [];
      var denied = [];
      try {
        extra = JSON.parse(r.extra_json || "[]");
      } catch (e) {}
      try {
        denied = JSON.parse(r.denied_json || "[]");
      } catch (e) {}
      userOverrides[String(r.username || "").trim()] = {
        extra: extra,
        denied: denied,
      };
    });
  } catch (e) {
    console.error("_getUserOverridesMap:", e.message || e);
  }
  return userOverrides;
}

function _getChartAccountsList() {
  try {
    return cleanArr(getChartAccounts(true).data || []);
  } catch (e) {
    return [];
  }
}

function _getCustomersList() {
  try {
    return cleanArr(getCustomers().data || []);
  } catch (e) {
    return [];
  }
}

function _getSuppliersList() {
  try {
    return cleanArr(getSuppliers().data || []);
  } catch (e) {
    return [];
  }
}

function _getCustomerCategoriesList() {
  try {
    return cleanArr(_buildPartyCategoriesFlat("customer"));
  } catch (e) {
    return [];
  }
}

function _getSupplierCategoriesList() {
  try {
    return cleanArr(_buildPartyCategoriesFlat("supplier"));
  } catch (e) {
    return [];
  }
}

function _getShipmentsList() {
  try {
    return cleanArr(getShipments().data || []);
  } catch (e) {
    return [];
  }
}

function _getOpeningStockList() {
  try {
    return cleanArr(getOpeningStock().data || []);
  } catch (e) {
    return [];
  }
}

function _postProcessItems(items) {
  // [ITEM-WAREHOUSES-LINK] نقرأ جدول الربط مرة واحدة فقط هنا (مش لكل صنف
  // على حدة) ونبنيه كخريطة { item_id: [warehouse_id, ...] } — نفس فلسفة
  // _buildStockQtyMap/_buildColorStockMap الموجودة بالفعل في المشروع.
  // النتيجة: أي شاشة تقرأ items من الحزمة العامة (مبيعات/مشتريات/تحويلات/
  // تقارير/بحث) تلاقي item.warehouse_ids جاهزة بدون أي كود إضافي فيها،
  // وبدون أي round-trip جديد للسيرفر.
  var _whMap = {};
  try {
    getSheetData("ItemWarehouses").forEach(function (r) {
      if (r.deleted_at) return;
      if (r.is_active === false || r.is_active === "false") return;
      var k = String(r.item_id);
      if (!_whMap[k]) _whMap[k] = [];
      _whMap[k].push(String(r.warehouse_id));
    });
  } catch (e) {
    console.error("_postProcessItems ItemWarehouses map:", e.message);
  }

  items = items.map(function (it) {
    it.colors_json = _normalizeColors(it.colors_json);
    // فارغة = "غير مقيّد بمخازن معيّنة" (توافق كامل مع الأصناف القديمة
    // التي لم تُربط بعد بأي مخزن عبر الشاشة الجديدة) — لا حظر افتراضي.
    it.warehouse_ids = _whMap[String(it.id)] || [];
    return it;
  });
  return items.filter(function (it) {
    return !it.deleted_at || String(it.deleted_at).trim() === "";
  });
}

// ─────────────────────────────────────────────────────────────
// §3-ب  Wrappers لحقول BACKGROUND (auth-aware) — كل دالة هنا مجرد تمرير
// مباشر (pass-through) لدالة الأعمال الأصلية بنفس التوقيع بالضبط. لا يوجد
// أي منطق إضافي هنا عن قصد — أي فحص صلاحيات يحدث داخل الدالة الأصلية نفسها.
// ─────────────────────────────────────────────────────────────
function _bgGetEmployees(callerUser, sessionToken) {
  return getEmployees({ callerUser: callerUser, sessionToken: sessionToken });
}
function _bgGetLeaveRequests(callerUser, sessionToken) {
  return getLeaveRequests({ callerUser: callerUser, sessionToken: sessionToken });
}
function _bgGetLoanRequests(callerUser, sessionToken) {
  return getLoanRequests({ callerUser: callerUser, sessionToken: sessionToken });
}
function _bgGetPayrollPeriods(callerUser, sessionToken) {
  // getPayrollPeriods() الأصلية لا تأخذ auth أصلاً (راجع Code_15_HR.js) —
  // الـ wrapper يستقبل الباراميترين لتوحيد التوقيع فقط، ولا يستخدمهما.
  return getPayrollPeriods();
}
function _bgGetAttendance(callerUser, sessionToken) {
  return getAttendance({ callerUser: callerUser, sessionToken: sessionToken });
}
function _bgGetProductionStages(callerUser, sessionToken) {
  return getProductionStages(callerUser, sessionToken);
}
function _bgGetCheques(callerUser, sessionToken) {
  // getCheques() الأصلية توقيعها (callerUser) فقط بدون sessionToken —
  // مطابق تمامًا لما كانت getAccountingExtendedLazy بتستدعيها به.
  return getCheques(callerUser);
}
function _bgGetFixedAssets(callerUser, sessionToken) {
  return getFixedAssets(callerUser, sessionToken);
}
function _bgGetJournalEntries(callerUser, sessionToken) {
  return getJournalEntries({ callerUser: callerUser, sessionToken: sessionToken });
}
function _bgGetDepartments(callerUser, sessionToken) {
  return getDepartments(callerUser, sessionToken);
}
function _bgGetCashBoxes(callerUser, sessionToken) {
  return getCashBoxes(callerUser, sessionToken);
}
function _bgGetBankAccounts(callerUser, sessionToken) {
  // getBankAccounts() الأصلية توقيعها (callerUser) فقط — الـ wrapper يستقبل
  // sessionToken لتوحيد التوقيع فقط، ولا يستخدمه.
  return getBankAccounts(callerUser);
}
function _bgGetReceiptVouchers(callerUser, sessionToken) {
  return getReceiptVouchers({ callerUser: callerUser, sessionToken: sessionToken });
}
function _bgGetPaymentVouchers(callerUser, sessionToken) {
  return getPaymentVouchers({ callerUser: callerUser, sessionToken: sessionToken });
}
function _bgGetExpenses(callerUser, sessionToken) {
  return getExpenses({ callerUser: callerUser, sessionToken: sessionToken });
}
function _bgGetTransferVouchers(callerUser, sessionToken) {
  return getTransferVouchers({ callerUser: callerUser, sessionToken: sessionToken });
}
function _bgGetBankReconciliations(callerUser, sessionToken) {
  return getBankReconciliations({ callerUser: callerUser, sessionToken: sessionToken });
}
// [REBUILD-ACC-HR-2026] wrappers للحقول المنقولة من getAllDataExtendedCore القديمة
function _bgGetJobTitles(callerUser, sessionToken) {
  return getJobTitles(callerUser, sessionToken);
}
function _bgGetLeaveTypes(callerUser, sessionToken) {
  // getLeaveTypes() الأصلية بلا معامِلات — الـ wrapper يستقبلهم لتوحيد
  // التوقيع فقط، ولا يستخدمهم.
  return getLeaveTypes();
}
function _bgGetAccountingSettings(callerUser, sessionToken) {
  var co = _getCompanySettingsRaw();
  return {
    default_currency: co.currency || "EGP",
    fiscal_year_start: co.fiscal_year_start || "01/01",
    auto_journal: true,
  };
}
function _bgGetHrSettings(callerUser, sessionToken) {
  return {
    work_hours_per_day: 8,
    overtime_rate: 1.5,
    social_insurance_rate: 0.11,
    grace_period_minutes: 15,
  };
}

// ─────────────────────────────────────────────────────────────
// §4  _buildDataBundle(levels)  —  البنّاء المركزي
// ─────────────────────────────────────────────────────────────
/**
 * يبني كائن بيانات يحتوي فقط على مفاتيح الـ registry اللي مستواها ضمن
 * `levels` المطلوبة. هذه هي الدالة الوحيدة اللي "تعرف" إزاي تُقرأ كل نوع
 * بيانات — أي دالة نداء (getAllData, getAllDataLight, أو أي شاشة مستقبلاً)
 * تستخدمها بدل ما تكرر منطق القراءة.
 *
 * @param {number[]} levels - مصفوفة من DATA_LEVEL المطلوب تحميلها، مثال:
 *                             [DATA_LEVEL.CRITICAL] أو [1,2,4]
 * @returns {Object} { success, data: {...}, _levels_loaded: [...] }
 */
function _buildDataBundle(levels, authCtx) {
  var wantedLevels = {};
  (levels || [1, 2, 3, 4]).forEach(function (l) {
    wantedLevels[l] = true;
  });
  return _buildDataBundleFiltered(function (def) {
    return !!wantedLevels[def.level];
  }, authCtx);
}

/**
 * _buildLightBundle — يبني فقط الحقول المعلَّمة صراحةً بـ `lightBundle:true`
 * في الـ registry، بغض النظر عن `level` النظري لكل حقل. هذا هو نفس مبدأ
 * `_buildDataBundle` تماماً، لكن بمعيار اختيار مختلف — الغرض العملي
 * ("محتاجة فوراً في حزمة اللوجين الخفيفة") بدل التصنيف النظري.
 * @returns {Object} { success, data, _errors }
 */
function _buildLightBundle() {
  return _buildDataBundleFiltered(function (def) {
    return !!def.lightBundle;
  });
}

/**
 * _buildDataBundleFiltered(predicate) — المُنفِّذ المشترك الفعلي. يقرأ كل
 * حقل من DATA_REGISTRY الذي يحقق `predicate(def)`، عبر نفس منطق القراءة
 * الموحّد (sheet / custom getter / postProcess) مع عزل الأخطاء حقلاً حقلاً.
 * @param {function(Object): boolean} predicate
 */
function _buildDataBundleFiltered(predicate, authCtx) {
  var out = {};
  var errors = {};

  Object.keys(DATA_REGISTRY).forEach(function (key) {
    var def = DATA_REGISTRY[key];
    if (!predicate(def)) return; // لا يحقق شرط الاختيار — تخطَّ

    // [BACKGROUND-AUTH] حقول requiresAuth:true بدون authCtx صالح تُستبعد
    // بأمان (fail-closed) بدل ما تُستدعى بـ undefined/undefined وتفشل
    // داخليًا بشكل غامض — نفس مبدأ getAllDataExtendedLazy الأصلية بالضبط.
    if (
      def.requiresAuth &&
      (!authCtx || !authCtx.callerUser || !authCtx.sessionToken)
    ) {
      return;
    }

    try {
      var value;
      if (def.custom) {
        // getter مخصص (دالة موجودة بالفعل في الكود الحالي)
        var fn = this[def.custom]; // GAS: كل الدوال global
        if (typeof fn !== "function") {
          throw new Error("دالة غير موجودة: " + def.custom);
        }
        value = def.requiresAuth
          ? fn(authCtx.callerUser, authCtx.sessionToken)
          : fn();
      } else if (def.sheet) {
        var headers = def.headersConst
          ? this[def.headersConst]
          : undefined;
        value = readSheet(def.sheet, headers, {
          parseJson: def.parseJson || undefined,
        });
        value = cleanArr(value);
      } else {
        throw new Error("تعريف registry ناقص لـ " + key);
      }

      if (def.postProcess) {
        var ppFn = this[def.postProcess];
        if (typeof ppFn === "function") value = ppFn(value);
      }

      out[key] = value;
    } catch (e) {
      console.error("_buildDataBundle[" + key + "]:", e.message || e);
      errors[key] = e.message || String(e);
      out[key] = def.sheet || def.custom ? [] : null; // fallback آمن، بدون تعطيل باقي الحزمة
    }
  }, this);

  return {
    success: true,
    data: out,
    _keys_loaded: Object.keys(out),
    _errors: Object.keys(errors).length ? errors : undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// §5  نقطة النهاية الجديدة (إضافية — لا تستبدل أي شيء حالي)
// ─────────────────────────────────────────────────────────────
/**
 * getAllDataByLevel — تُستدعى من الواجهة عبر _gsr بدلاً من getAllData()
 * الحالية عندما تكون الشاشة جاهزة للتدرّج.
 *
 * مثال استخدام من الواجهة:
 *   Level 1 عند فتح الشاشة:   getAllDataByLevel([1])
 *   Level 2 عند أول تفاعل:    getAllDataByLevel([2])
 *   Level 4 مرة واحدة session: getAllDataByLevel([4])  ← يُخزَّن محلياً بلا TTL قصير
 *
 * [P2] Level 3 (BACKGROUND) يحتوي الآن حقول محاسبة/HR حساسة تتطلب صلاحيات
 * (راجع §3-ب) — لازم تمرير callerUser/sessionToken، وإلا الحقول دي تُستبعد
 * تلقائيًا من الحزمة (fail-closed، مش خطأ) بدل ما تتسرّب بلا فحص:
 *   getAllDataByLevel([3], callerUser, sessionToken)
 *
 * @param {number[]} levels
 * @param {string} [callerUser] - مطلوب فقط لو من ضمن levels مستوى BACKGROUND
 * @param {string} [sessionToken]
 * @returns {Object}
 */
function getAllDataByLevel(levels, callerUser, sessionToken) {
  var authCtx =
    callerUser && sessionToken
      ? { callerUser: callerUser, sessionToken: sessionToken }
      : null;

  // [PERF-FIX-BYLEVEL-CACHE] كانت هذه الدالة بتقرا الشيتات من الصفر في
  // كل نداء بدون أي كاش خالص (بعكس getAllData اللي بتتحقق من الكاش
  // أولاً) — وهي المسار الفعلي اللي بيغذي شاشات زي "الأصناف" عند كل
  // تسجيل دخول (level 2 = ON_DEMAND). ده كان سبب البطء المتكرر رغم وجود
  // نظام كاش جاهز في المشروع. الحل: نفس آلية _loadServerCache/
  // _saveServerCache المستخدمة في getAllData، بمفتاح خاص لكل تركيبة
  // مستويات + حالة auth، ومربوط ببصمة الصلاحيات زي SERVER_CACHE_KEY
  // بالظبط عشان يتبطل تلقائيًا لو بنية الصلاحيات اتغيرت.
  var cacheKey =
    "wms_bylevel_v1_" +
    (levels || [])
      .slice()
      .sort()
      .join("_") +
    (authCtx ? "_auth" : "") +
    "_" +
    _permissionsFingerprint();

  var cached = _loadServerCache(cacheKey);
  if (cached) {
    cached._from_cache = true;
    return cached;
  }

  var bundle = _buildDataBundle(levels, authCtx);
  if (bundle && bundle.success) {
    _saveServerCache(bundle, cacheKey);
  }
  return bundle;
}

/**
 * يسرد كل مفاتيح الـ registry مع مستوياتها — أداة تشخيص/توثيق حيّة،
 * تجعل السؤال "هل هذا الحقل مصنّف صح؟" قابل للفحص بنداء واحد بدل البحث
 * اليدوي في 5 ملفات.
 */
function debugListDataRegistry() {
  var rows = Object.keys(DATA_REGISTRY).map(function (key) {
    var def = DATA_REGISTRY[key];
    var levelName = Object.keys(DATA_LEVEL).find(function (n) {
      return DATA_LEVEL[n] === def.level;
    });
    return {
      key: key,
      level: def.level,
      levelName: levelName,
      source: def.custom ? "custom:" + def.custom : "sheet:" + def.sheet,
      note: def.note || "",
    };
  });
  rows.sort(function (a, b) {
    return a.level - b.level;
  });
  return rows;
}
