// ════════════════════════════════════════════════════════════════════════════
// Code_58_CustomerSettingsEngine.js — [CUST-SETTINGS-2026-08-07]
// المصدر المركزي الوحيد لكل سياسات العملاء في النظام (Single Source of Truth).
// نفس البنية والمنطق بالظبط زي Code_56_InventorySettingsEngine.js (المرجع
// المعماري المعتمد في المشروع لأي شاشة "إعدادات عامة" جديدة):
//   شيت CustomerSettings: صف واحد فقط للنظام كله —
//   id | settings_json | updated_by | updated_at
//   كل الإعدادات JSON واحد جوه settings_json، فإضافة إعداد جديد مستقبلاً =
//   إضافة مفتاح في CUSTOMER_SETTINGS_DEFAULTS بس، بدون أي migration للشيت.
//
// هذا الملف الأساس (Backend + get/save/reset + كاش + Audit) + الربط الفعلي
// مع Code_20a_Parties.js / Code_33_BusinessRulesEngine.js / Code_20c_Invoices.js
// (فحوصات حقيقية بتتنفذ فعليًا عند إضافة/تعديل عميل وعند فاتورة بيع آجلة —
// مش إعدادات شكلية). راجع README_CUSTOMERS_INVOICES_SETTINGS.md للتفاصيل
// الكاملة عن كل نقطة ربط ومكانها بالظبط.
// ════════════════════════════════════════════════════════════════════════════

var CUSTOMER_SETTINGS_SHEET = "CustomerSettings";
var CUSTOMER_SETTINGS_HEADERS = ["id", "settings_json", "updated_by", "updated_at"];
var CUSTOMER_SETTINGS_CACHE_KEY = "cust_settings_v1";
var CUSTOMER_SETTINGS_CACHE_TTL = 21600; // 6 ساعات — نفس نمط InventorySettings/UserPreferences

// ── القيم الافتراضية لكل أقسام إعدادات العملاء ────────────────────────────
var CUSTOMER_SETTINGS_DEFAULTS = {
  // ── 1) الإعدادات العامة ──
  allow_customer_without_phone: true,
  allow_duplicate_customer_name: true, // true = السلوك الحالي (مفيش فحص تكرار اسم أصلاً)
  require_email: false,
  require_address: false,
  require_tax_number: false,
  require_customer_type: false,

  // ── (أنواع العملاء) — قائمة قابلة للتعديل من الشاشة، بدل Hardcoded enum.
  // القيمة "key" هي اللي بتتخزن فعليًا في عمود customer_type بالعميل.
  customer_types: [
    { key: "individual", label: "فرد" },
    { key: "company", label: "شركة" },
    { key: "merchant", label: "تاجر" },
    { key: "distributor", label: "موزع" },
    { key: "cash_customer", label: "عميل نقدي" },
  ],

  // ── 2) ترقيم العملاء ──
  numbering_prefix: "CUS-",
  numbering_digits: 5,
  numbering_start_from: 1,
  numbering_reset_yearly: false,

  // ── 3) تصنيف العملاء (مجموعات) — كل مجموعة سياستها الخاصة. المجموعات
  // نفسها بتتحدد هنا (بدل كيان Sheet منفصل) عشان تبقى إعداد بحت يتغيّر من
  // الشاشة مباشرة. الحقل group_name الموجود فعلاً في CUSTOMER_HEADERS
  // (Code_20a_Parties.js) بيخزن الـ "key" بتاع المجموعة دي.
  customer_groups: [
    {
      key: "wholesale",
      label: "جملة",
      price_list: "",
      default_discount_percent: 0,
      payment_terms_days: 30,
      credit_limit: 0,
    },
    {
      key: "retail",
      label: "قطاعي",
      price_list: "",
      default_discount_percent: 0,
      payment_terms_days: 0,
      credit_limit: 0,
    },
    {
      key: "vip",
      label: "VIP",
      price_list: "",
      default_discount_percent: 5,
      payment_terms_days: 30,
      credit_limit: 0,
    },
    {
      key: "distributors",
      label: "موزعين",
      price_list: "",
      default_discount_percent: 10,
      payment_terms_days: 45,
      credit_limit: 0,
    },
  ],

  // ── 4) سياسة الائتمان ──
  default_credit_limit: 0, // 0 = بدون حد افتراضي (لسه ينفع يتحدد لكل عميل/مجموعة)
  default_payment_term_days: 0,
  block_sale_over_credit_limit: true, // لو false: يُسمح بالفاتورة مع تحذير بس (بدون منع)
  allow_manager_override_credit_limit: true, // صلاحية overrideCreditLimit تتحكم في مين يقدر يتجاوز
  near_term_alert_days: 3, // تنبيه قبل انتهاء مهلة السداد بعدد الأيام دي

  // ── 5) أرصدة العملاء ──
  enable_opening_balance: true,
  opening_balance_requires_date: true,
  opening_balance_account_key: "ar_account", // مفتاح POSTING_CONFIG_KEYS المستخدم كـ fallback لحساب الرصيد الافتتاحي
  auto_update_balance_from_journal: true, // منعكس بالفعل في _computePartyLiveBalance — إعداد توثيقي/تبديل مستقبلي

  // ═══════════════════════════════════════════════════════════════════
  // [CUST-SETTINGS-2026-08-08] الإضافات الجديدة (تاب خصائص عامة موسّع +
  // جهات التعامل + الحقول الإجبارية للإدخال + مناطق العملاء). كل مفتاح
  // منها متفعّل فعليًا في التحقق (راجع Code_33_BusinessRulesEngine.js
  // §validateBeforeSave customer/supplier) — مش إعدادات شكلية.
  // ═══════════════════════════════════════════════════════════════════

  // ── أعمار الديون ──
  debt_aging_show_after_operation: false,
  debt_aging_period_1: 30,
  debt_aging_period_2: 60,
  debt_aging_period_3: 90,
  debt_aging_period_4: 180,

  // ── خصائص عامة موسّعة ──
  default_customer_on_invoice_open: "",
  default_supplier_on_invoice_open: "",
  credit_limit_exceed_behavior: "warn_on_finish", // warn_on_finish | warn_only | block
  default_new_customer_nature: "cash", // cash | credit
  default_new_supplier_nature: "credit", // cash | credit
  allow_supplier_cross_branch: false,

  // ── جهات التعامل (تصنيف موحّد عملاء/موردين بعملة وحد ائتمان وحساب أستاذ) ──
  party_categories: [],

  // ── الحقول الإجبارية للإدخال — عملاء ──
  customer_entry_require_party_category: false,
  customer_entry_require_group_name: false,
  customer_entry_require_zone: false,
  customer_entry_require_address: false,
  customer_entry_require_phone: true,
  customer_entry_phone_digits: 11,
  customer_entry_require_photo: false,
  customer_entry_require_id_number: false,
  customer_entry_id_digits: 14,
  customer_entry_require_blacklist: false,
  customer_entry_require_shipping_company: false,

  // ── الحقول الإجبارية للإدخال — موردين ──
  supplier_entry_require_party_category: false,
  supplier_entry_require_group_name: false,
  supplier_entry_require_zone: false,
  supplier_entry_require_address: false,
  supplier_entry_require_phone: false,
  supplier_entry_phone_digits: 11,
  supplier_entry_require_photo: false,
  supplier_entry_require_id_number: false,
  supplier_entry_id_digits: 14,

  // ── مناطق العملاء (مناطق الزيارات) ──
  customer_zones: [],
};

// ════════════════════════════════════════════════════════════════════════
// قراءة/حفظ/استرجاع — نفس بنية Code_56_InventorySettingsEngine.js حرفيًا
// ════════════════════════════════════════════════════════════════════════
function getCustomerSettings(callerUser, sessionToken) {
  try {
    var cached = _loadServerCache(CUSTOMER_SETTINGS_CACHE_KEY);
    if (cached) return { success: true, data: cached };

    var merged = _readCustomerSettingsRaw();
    _saveServerCache(merged, CUSTOMER_SETTINGS_CACHE_KEY, CUSTOMER_SETTINGS_CACHE_TTL);
    return { success: true, data: merged };
  } catch (e) {
    return errResponse("خطأ في جلب إعدادات العملاء: " + e.message);
  }
}

function _readCustomerSettingsRaw() {
  var sheet = getSheet(CUSTOMER_SETTINGS_SHEET, CUSTOMER_SETTINGS_HEADERS);
  var lastRow = sheet.getLastRow();
  var stored = {};
  if (lastRow >= 2) {
    var row = sheet.getRange(2, 1, 1, CUSTOMER_SETTINGS_HEADERS.length).getValues()[0];
    var rawJson = row[1];
    if (rawJson) {
      try {
        stored = JSON.parse(rawJson);
      } catch (parseErr) {
        stored = {};
      }
    }
  }
  // دمج ضحل كافٍ لكل المفاتيح العادية. customer_types و customer_groups
  // مصفوفات (arrays) — لو محفوظة فعليًا في stored بتحل محل الافتراضي
  // بالكامل (مش دمج عنصر بعنصر)، لأن ده المتوقع من واجهة تعدّل قائمة كاملة.
  var merged = Object.assign({}, CUSTOMER_SETTINGS_DEFAULTS, stored);
  merged.customer_types = Array.isArray(stored.customer_types)
    ? stored.customer_types
    : CUSTOMER_SETTINGS_DEFAULTS.customer_types;
  merged.customer_groups = Array.isArray(stored.customer_groups)
    ? stored.customer_groups
    : CUSTOMER_SETTINGS_DEFAULTS.customer_groups;
  merged.party_categories = Array.isArray(stored.party_categories)
    ? stored.party_categories
    : CUSTOMER_SETTINGS_DEFAULTS.party_categories;
  merged.customer_zones = Array.isArray(stored.customer_zones)
    ? stored.customer_zones
    : CUSTOMER_SETTINGS_DEFAULTS.customer_zones;
  return merged;
}

function saveCustomerSettings(payload, sessionToken) {
  var lock = LockService.getScriptLock();
  try {
    var callerUser =
      payload && payload.callerUser
        ? payload.callerUser
        : _getUsernameFromToken(sessionToken);
    if (!callerUser) return errResponse("اسم المستخدم مطلوب");

    var permErr = _checkPermission(callerUser, "manageCustomerSettings", sessionToken);
    if (permErr) return permErr;

    var incoming = (payload && payload.settings) || {};
    if (!incoming || typeof incoming !== "object") {
      return errResponse("صيغة الإعدادات غير صحيحة");
    }

    lock.waitLock(10000);

    var oldMerged = _readCustomerSettingsRaw();
    var newMerged = Object.assign({}, oldMerged, incoming);

    // [AUDIT-FIX CUST-29] block_sale_over_credit_limit (Boolean، مربوط
    // فعليًا في addSaleInvoice) وcredit_limit_exceed_behavior (Enum بـ3
    // حالات) كانا بيتحكموا في نفس القرار بشكل متعارض — الأول شغال
    // والتاني كان معروض بس متجاهَل. دلوقتي بيتزامنوا دايمًا عند كل حفظ
    // عشان الشاشتين (سياسة الائتمان / خصائص عامة) يفضلوا متطابقين مهما
    // اتغيّر أي منهم لوحده، وBusiness Logic في addSaleInvoice بتقرا
    // credit_limit_exceed_behavior كمصدر الحقيقة الوحيد.
    if (
      Object.prototype.hasOwnProperty.call(incoming, "credit_limit_exceed_behavior") &&
      !Object.prototype.hasOwnProperty.call(incoming, "block_sale_over_credit_limit")
    ) {
      newMerged.block_sale_over_credit_limit =
        incoming.credit_limit_exceed_behavior === "block";
    } else if (
      Object.prototype.hasOwnProperty.call(incoming, "block_sale_over_credit_limit") &&
      !Object.prototype.hasOwnProperty.call(incoming, "credit_limit_exceed_behavior")
    ) {
      newMerged.credit_limit_exceed_behavior = incoming.block_sale_over_credit_limit
        ? "block"
        : "warn_only";
    }

    if (Array.isArray(incoming.customer_types)) {
      newMerged.customer_types = incoming.customer_types;
    }
    if (Array.isArray(incoming.customer_groups)) {
      newMerged.customer_groups = incoming.customer_groups;
    }
    if (Array.isArray(incoming.party_categories)) {
      newMerged.party_categories = incoming.party_categories;
    }
    if (Array.isArray(incoming.customer_zones)) {
      newMerged.customer_zones = incoming.customer_zones;
    }

    var sheet = getSheet(CUSTOMER_SETTINGS_SHEET, CUSTOMER_SETTINGS_HEADERS);
    var now = new Date();
    var jsonStr = JSON.stringify(newMerged);
    if (sheet.getLastRow() >= 2) {
      sheet.getRange(2, 1, 1, CUSTOMER_SETTINGS_HEADERS.length).setValues([
        [1, jsonStr, callerUser, now],
      ]);
    } else {
      sheet.appendRow([1, jsonStr, callerUser, now]);
    }

    _invalidateServerCache(CUSTOMER_SETTINGS_CACHE_KEY);

    var diff = _diffObjects(oldMerged, newMerged);
    if (Object.keys(diff.new).length > 0) {
      _addAuditLog(callerUser, "update", "CustomerSettings", "1", diff.old, diff.new);
    }

    return okResponse("تم حفظ إعدادات العملاء", { data: newMerged });
  } catch (e) {
    return errResponse("خطأ في حفظ إعدادات العملاء: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

function resetCustomerSettings(payload, sessionToken) {
  try {
    var callerUser =
      payload && payload.callerUser
        ? payload.callerUser
        : _getUsernameFromToken(sessionToken);
    if (!callerUser) return errResponse("اسم المستخدم مطلوب");

    var permErr = _checkPermission(callerUser, "manageCustomerSettings", sessionToken);
    if (permErr) return permErr;

    var oldMerged = _readCustomerSettingsRaw();
    var keys = payload && payload.keys;

    var resetTo;
    if (keys && keys.length) {
      resetTo = Object.assign({}, oldMerged);
      keys.forEach(function (k) {
        if (k in CUSTOMER_SETTINGS_DEFAULTS) resetTo[k] = CUSTOMER_SETTINGS_DEFAULTS[k];
      });
    } else {
      resetTo = Object.assign({}, CUSTOMER_SETTINGS_DEFAULTS);
    }

    return saveCustomerSettings({ callerUser: callerUser, settings: resetTo }, sessionToken);
  } catch (e) {
    return errResponse("خطأ في إرجاع إعدادات العملاء للافتراضي: " + e.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// CustomerSettingsEngine.get(key) — قراءة سريعة من أي نقطة في الكود
// (Code_20a_Parties.js، Code_33_BusinessRulesEngine.js، Code_20c_Invoices.js)
// ════════════════════════════════════════════════════════════════════════
var CustomerSettingsEngine = {
  get: function (key) {
    var all =
      _loadServerCache(CUSTOMER_SETTINGS_CACHE_KEY) || _readCustomerSettingsRaw();
    if (!_loadServerCache(CUSTOMER_SETTINGS_CACHE_KEY)) {
      _saveServerCache(all, CUSTOMER_SETTINGS_CACHE_KEY, CUSTOMER_SETTINGS_CACHE_TTL);
    }
    return key in all ? all[key] : CUSTOMER_SETTINGS_DEFAULTS[key];
  },
  getAll: function () {
    return _readCustomerSettingsRaw();
  },
  // يرجع تعريف مجموعة عميل بمفتاحها (أو null لو مش موجودة) — تُستخدم
  // من نقاط تانية محتاجة سياسة المجموعة (خصم افتراضي/حد ائتمان/شروط دفع)
  getGroup: function (groupKey) {
    if (!groupKey) return null;
    var groups = this.get("customer_groups") || [];
    var found = null;
    groups.forEach(function (g) {
      if (g && g.key === groupKey) found = g;
    });
    return found;
  },
};
