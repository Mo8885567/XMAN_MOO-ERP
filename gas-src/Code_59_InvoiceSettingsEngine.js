// ════════════════════════════════════════════════════════════════════════════
// Code_59_InvoiceSettingsEngine.js — [INV2-SETTINGS-2026-08-07]
// المصدر المركزي الوحيد لكل سياسات الفواتير (بيع/شراء/مرتجعات) في النظام.
// نفس بنية Code_56_InventorySettingsEngine.js / Code_58_CustomerSettingsEngine.js
// بالظبط — شيت InvoiceSettings: صف واحد، id | settings_json | updated_by | updated_at.
//
// قسم "الربط المحاسبي" (بند 11 في طلب المستخدم) — نفس قرار قسم 13 في
// إعدادات المخزون: بيترابط بمفاتيح POSTING_CONFIG_KEYS الموجودة فعلاً
// (Code_19_PostingConfig.js: ar_account, revenue_account, vat_output_account,
// vat_input_account, sales_discount_account, purchase_discount_account,
// cogs_account, inventory_account, cash_account, mobile_wallet_account) —
// كلها موجودة بالفعل، مفيش مفاتيح ناقصة احتاجت إضافة.
// ════════════════════════════════════════════════════════════════════════════

var INVOICE_SETTINGS_SHEET = "InvoiceSettings";
var INVOICE_SETTINGS_HEADERS = ["id", "settings_json", "updated_by", "updated_at"];
var INVOICE_SETTINGS_CACHE_KEY = "invoice_settings_v1";
var INVOICE_SETTINGS_CACHE_TTL = 21600;

var INVOICE_SETTINGS_DEFAULTS = {
  // ── 0) خصائص عامة [SETTINGS-MOVE-2026-08-08] مأخوذة من شاشة إعدادات
  // فواتير مرجعية (لقطات شاشة المستخدم) — كل الحقول توثيقية إلى أن
  // يُربط كل مفتاح بمنطق فعلي في addSaleInvoice/addPurchaseInvoice.
  allow_dispense_on_negative_stock: false,
  show_cash_payment_screen_before_save: false,
  allow_multi_warehouse_per_invoice: true,
  default_qty_always_one: true,
  allow_edit_invoice_total: true,
  edit_total_adjusts: "price", // price | discount
  allow_returns_inside_invoice: false,
  overpayment_action: "ask_decision", // ask_decision | return_change | credit_balance
  donation_points_screen_on_cash: "none", // none | always | if_available
  items_left_on_close_action: "close_anyway", // close_anyway | warn_before_close | block_close
  allow_edit_item_name_in_invoice: true,
  warn_if_item_price_not_profitable: true,
  warn_on_price_level_switch: false,
  invoice_total_rounding: "none", // none | nearest_integer | nearest_half
  use_touch_screen_in_cashier: true,

  // ── 0b) فواتير المشتريات ──
  purchase_always_cashier_transactions: true,
  purchase_allow_repeat_item: true,
  purchase_repeat_item_increase_qty: true,
  purchase_allow_edit_sale_price: false,
  purchase_show_preferred_vendor_items_only: false,
  purchase_item_show_balance: true,
  purchase_item_show_prices: true,
  purchase_item_show_alternatives: true,
  purchase_item_show_balance_all_warehouses: true,
  purchase_vendor_show_balance: true,
  purchase_vendor_show_credit_limit: true,
  purchase_vendor_show_last_transactions: true,
  purchase_vendor_show_personal_data: true,

  // ── 0c) فواتير المبيعات ──
  sale_loss_items_policy: "ask_decision", // ask_decision | block | allow
  sale_always_cashier_transactions: true,
  sale_allow_repeat_item: true,
  sale_repeat_item_increase_qty: true,
  sale_block_repeat_if_same_qty_unit: false,
  sale_auto_order_if_balance_insufficient: false,
  sale_max_items_per_invoice: 900,
  sale_price_validity_days: 10,
  sale_item_show_balance: true,
  sale_item_show_prices: true,
  sale_item_show_alternatives: true,
  sale_item_show_balance_all_warehouses: true,
  sale_customer_show_balance: true,
  sale_customer_show_credit_limit: true,
  sale_customer_show_last_transactions: true,
  sale_customer_show_personal_data: true,

  // ── 0d) المرتجعات والتحويلات ──
  block_sale_return_without_original_invoice: false,
  return_block_after_days: 14,
  require_original_purchase_invoice_for_return: false,
  accept_expired_item_in_return: false,
  warehouse_transfer_price_basis: "cost_price", // cost_price | sale_price | last_purchase_price
  min_sale_request_amount: 0,

  // ── 1) أنواع الفواتير — قائمة قابلة للتوسيع من الشاشة. "key" هو نفس
  // القيمة المستخدمة داخليًا (sale/purchase/sale_return/purchase_return
  // بالفعل كيانات/شيتات منفصلة في الكود — "enabled" هنا بيتحكم في ظهورها
  // كخيار متاح في الواجهة بس، مش بيحذف أي شيت أو كود موجود).
  invoice_types: [
    { key: "sale", label: "فاتورة بيع", enabled: true },
    { key: "purchase", label: "فاتورة شراء", enabled: true },
    { key: "sale_return", label: "فاتورة مرتجع بيع", enabled: true },
    { key: "purchase_return", label: "فاتورة مرتجع شراء", enabled: true },
    { key: "cash", label: "فاتورة نقدية", enabled: true },
    { key: "credit", label: "فاتورة آجلة", enabled: true },
  ],

  // ── 2) ترقيم الفواتير (invoice_no — عمود عرض منفصل عن id الداخلي،
  // راجع الشرح في README عن سبب الفصل: id هو المفتاح المرجعي في القيود
  // والمرفقات ومنطق الحذف/الإلغاء، تغييره كسر كبير جدًا خارج نطاق آمن) ──
  numbering_prefix: "INV-",
  numbering_digits: 6,
  numbering_include_year: true, // مثال: INV-2026-000001
  numbering_reset_yearly: true,
  numbering_reset_per_branch: false, // لا يوجد كيان "فرع" مستقل حاليًا في المشروع — إعداد جاهز لمستقبل الفروع
  numbering_reset_per_type: true, // كل نوع فاتورة (بيع/شراء/مرتجع) له تسلسل منفصل

  // ── 3) إعدادات إنشاء الفاتورة ──
  allow_edit_after_save: false, // [ملاحظة] لا توجد دالة updateSaleInvoice في الكود حاليًا — التعديل غير منفَّذ أصلاً، الإعداد جاهز لأي تنفيذ مستقبلي
  allow_delete: true, // مربوط فعليًا بـ deleteSaleInvoice/deletePurchaseInvoice
  allow_cancel: true,
  require_cancel_reason: true,
  require_approval_before_post: false,
  prevent_price_edit: false,
  prevent_discount_edit: false,

  // ── 4) سياسة الأسعار — أولوية التطبيق (الأول أعلى أولوية)
  price_priority: ["customer_price", "group_price", "price_list", "last_sale_price", "general_price"],
  default_price_list: "",

  // ── 5) الخصومات ──
  allow_item_discount: true,
  allow_invoice_discount: true,
  default_discount_type: "percent", // percent | fixed
  max_discount_percent: 0, // 0 = بدون حد أقصى
  require_approval_over_max_discount: true, // صلاحية overrideDiscountLimit

  // ── 6) الضرائب ──
  tax_enabled: true,
  default_tax_rate: 14,
  prices_include_tax: false,
  multiple_tax_types_enabled: false,

  // ── 7) طرق الدفع — كل طريقة مربوطة بمفتاح حساب من POSTING_CONFIG_KEYS
  payment_methods: [
    { key: "cash", label: "نقدي", account_key: "cash_account", enabled: true },
    { key: "bank_transfer", label: "تحويل بنكي", account_key: "cash_account", enabled: true },
    { key: "card", label: "بطاقة", account_key: "cash_account", enabled: true },
    { key: "credit", label: "آجل", account_key: "ar_account", enabled: true },
    { key: "installment", label: "أقساط", account_key: "ar_account", enabled: false },
  ],

  // ── 8) حالة الفاتورة (دورة الحياة) — تعريفي هنا (التنفيذ الفعلي لمنع
  // الانتقال العشوائي يحتاج state machine جديد كليًا فوق عمود status
  // الحالي، راجع README §"غير مربوط بعد")
  status_flow: ["draft", "review", "approved", "posted", "paid"],

  // ── 9) ربط الفواتير بالمخزون — منعكسة بالفعل في الكود الحالي
  // (addSaleInvoice بيخصم مخزون وينشئ قيد وتكلفة دايمًا عند أي فاتورة
  // بيع معتمدة؛ deleteSaleInvoice/DeleteEngine بيعكسهم عند الحذف). الحقول
  // هنا توثيقية بمعنى إنها مطابقة للسلوك الفعلي الثابت حاليًا — التبديل
  // الفعلي (تعطيل خصم المخزون مثلاً) يحتاج تعديل addSaleInvoice نفسها،
  // خارج نطاق آمن لهذه الجولة (خطر كسر التكامل المحاسبي/المخزني).
  deduct_stock_on_sale_confirm: true,
  create_journal_on_sale_confirm: true,
  update_cost_on_sale_confirm: true,
  restock_on_return: true,
  reverse_journal_on_return: true,

  // ── 10) الطباعة — تعريف قوالب (الأسماء/العناصر الظاهرة). التوليد
  // الفعلي (PDF/HTML) يحتاج محرك طباعة مستقل غير موجود بعد.
  use_fast_print_method: false,
  print_use_qty_tracking: false,
  print_show_bundle_without_components: true,
  print_show_installments: true,
  print_show_payment_method: true,
  print_show_serial_numbers: true,
  print_show_qr_code: true,
  print_show_thank_you_message: false,
  print_show_terms_message: true,
  print_show_dealing_policy: false,
  print_show_company_address: true,
  print_show_company_phone: true,
  print_show_company_tax_number: true,
  print_thank_you_message_text: "",
  print_terms_message_text: "",
  print_templates: [
    {
      key: "default",
      label: "القالب الافتراضي",
      show_logo: true,
      show_company_info: true,
      show_customer_info: true,
      show_qr: false,
      show_barcode: false,
      show_signature: false,
      show_notes: true,
      show_terms: false,
    },
  ],

  // ── 11) الربط المحاسبي — لا تخزين مستقل (نفس قرار قسم 13 بإعدادات
  // المخزون)، بيترابط مع POSTING_CONFIG_KEYS الموجودة فعلاً.
};

function getInvoiceSettings(callerUser, sessionToken) {
  try {
    var cached = _loadServerCache(INVOICE_SETTINGS_CACHE_KEY);
    if (cached) return { success: true, data: cached };

    var merged = _readInvoiceSettingsRaw();
    _saveServerCache(merged, INVOICE_SETTINGS_CACHE_KEY, INVOICE_SETTINGS_CACHE_TTL);
    return { success: true, data: merged };
  } catch (e) {
    return errResponse("خطأ في جلب إعدادات الفواتير: " + e.message);
  }
}

function _readInvoiceSettingsRaw() {
  var sheet = getSheet(INVOICE_SETTINGS_SHEET, INVOICE_SETTINGS_HEADERS);
  var lastRow = sheet.getLastRow();
  var stored = {};
  if (lastRow >= 2) {
    var row = sheet.getRange(2, 1, 1, INVOICE_SETTINGS_HEADERS.length).getValues()[0];
    var rawJson = row[1];
    if (rawJson) {
      try {
        stored = JSON.parse(rawJson);
      } catch (parseErr) {
        stored = {};
      }
    }
  }
  var arrayKeys = [
    "invoice_types",
    "price_priority",
    "payment_methods",
    "status_flow",
    "print_templates",
  ];
  var merged = Object.assign({}, INVOICE_SETTINGS_DEFAULTS, stored);
  arrayKeys.forEach(function (k) {
    merged[k] = Array.isArray(stored[k]) ? stored[k] : INVOICE_SETTINGS_DEFAULTS[k];
  });
  return merged;
}

function saveInvoiceSettings(payload, sessionToken) {
  var lock = LockService.getScriptLock();
  try {
    var callerUser =
      payload && payload.callerUser
        ? payload.callerUser
        : _getUsernameFromToken(sessionToken);
    if (!callerUser) return errResponse("اسم المستخدم مطلوب");

    var permErr = _checkPermission(callerUser, "manageInvoiceSettings", sessionToken);
    if (permErr) return permErr;

    var incoming = (payload && payload.settings) || {};
    if (!incoming || typeof incoming !== "object") {
      return errResponse("صيغة الإعدادات غير صحيحة");
    }

    lock.waitLock(10000);

    var oldMerged = _readInvoiceSettingsRaw();
    var newMerged = Object.assign({}, oldMerged, incoming);
    ["invoice_types", "price_priority", "payment_methods", "status_flow", "print_templates"].forEach(
      function (k) {
        if (Array.isArray(incoming[k])) newMerged[k] = incoming[k];
      },
    );

    var sheet = getSheet(INVOICE_SETTINGS_SHEET, INVOICE_SETTINGS_HEADERS);
    var now = new Date();
    var jsonStr = JSON.stringify(newMerged);
    if (sheet.getLastRow() >= 2) {
      sheet.getRange(2, 1, 1, INVOICE_SETTINGS_HEADERS.length).setValues([
        [1, jsonStr, callerUser, now],
      ]);
    } else {
      sheet.appendRow([1, jsonStr, callerUser, now]);
    }

    _invalidateServerCache(INVOICE_SETTINGS_CACHE_KEY);

    var diff = _diffObjects(oldMerged, newMerged);
    if (Object.keys(diff.new).length > 0) {
      _addAuditLog(callerUser, "update", "InvoiceSettings", "1", diff.old, diff.new);
    }

    return okResponse("تم حفظ إعدادات الفواتير", { data: newMerged });
  } catch (e) {
    return errResponse("خطأ في حفظ إعدادات الفواتير: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

function resetInvoiceSettings(payload, sessionToken) {
  try {
    var callerUser =
      payload && payload.callerUser
        ? payload.callerUser
        : _getUsernameFromToken(sessionToken);
    if (!callerUser) return errResponse("اسم المستخدم مطلوب");

    var permErr = _checkPermission(callerUser, "manageInvoiceSettings", sessionToken);
    if (permErr) return permErr;

    var oldMerged = _readInvoiceSettingsRaw();
    var keys = payload && payload.keys;

    var resetTo;
    if (keys && keys.length) {
      resetTo = Object.assign({}, oldMerged);
      keys.forEach(function (k) {
        if (k in INVOICE_SETTINGS_DEFAULTS) resetTo[k] = INVOICE_SETTINGS_DEFAULTS[k];
      });
    } else {
      resetTo = Object.assign({}, INVOICE_SETTINGS_DEFAULTS);
    }

    return saveInvoiceSettings({ callerUser: callerUser, settings: resetTo }, sessionToken);
  } catch (e) {
    return errResponse("خطأ في إرجاع إعدادات الفواتير للافتراضي: " + e.message);
  }
}

var InvoiceSettingsEngine = {
  get: function (key) {
    var all =
      _loadServerCache(INVOICE_SETTINGS_CACHE_KEY) || _readInvoiceSettingsRaw();
    if (!_loadServerCache(INVOICE_SETTINGS_CACHE_KEY)) {
      _saveServerCache(all, INVOICE_SETTINGS_CACHE_KEY, INVOICE_SETTINGS_CACHE_TTL);
    }
    return key in all ? all[key] : INVOICE_SETTINGS_DEFAULTS[key];
  },
  getAll: function () {
    return _readInvoiceSettingsRaw();
  },
};

// ════════════════════════════════════════════════════════════════════════
// InvoiceNumberingService — [PHASE-4] توليد "invoice_no" (رقم العرض) حسب
// إعدادات قسم 2. منفصل عمدًا عن makeId()/"id" الداخلي (المفتاح الحقيقي في
// كل مكان: القيود المحاسبية، سندات القبض، DeleteEngine...) — الفصل ده
// آمن (additive) بدل تغيير id نفسه في كل الأماكن اللي بتعتمد عليه.
// ════════════════════════════════════════════════════════════════════════
var InvoiceNumberingService = {
  /**
   * @param {"sale"|"purchase"|"sale_return"|"purchase_return"} typeKey
   * @param {Function} existingNumbersFn - دالة ترجع مصفوفة أرقام invoice_no
   *   الموجودة فعليًا (لنفس النوع لو reset_per_type مفعّل، ولنفس السنة لو
   *   reset_yearly مفعّل — الفلترة مسؤولية الـ caller قبل تمرير المصفوفة).
   * @returns {String}
   */
  next: function (typeKey, existingNumbersFn) {
    var s = InvoiceSettingsEngine.getAll();
    var year = new Date().getFullYear();
    var prefix = s.numbering_prefix || "";
    if (s.numbering_include_year) prefix += year + "-";
    return AutoNumberService.preview(existingNumbersFn, {
      prefix: prefix,
      padding: Number(s.numbering_digits || 0),
    });
  },
};
