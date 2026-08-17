// ════════════════════════════════════════════════════════════════════════════
// Code_54_InventorySettingsEngine.js — [INV-SETTINGS-2026-08-07] Phase 1
// المصدر المركزي الوحيد لكل إعدادات وسياسات المخزون في النظام (Single Source
// of Truth). أي مكان في الكود بيستخدم قيمة سياسة مخزون ثابتة (Hardcoded)
// المفروض ينتقل يقرأها من هنا بدل ما تتكرر أو تتعارض بين الملفات.
//
// البنية (زي نمط UserPreferences في Code_23_UserPreferences.js بالظبط):
//   شيت InventorySettings: صف واحد فقط للنظام كله —
//   id | settings_json | updated_by | updated_at
//   الإعدادات كلها JSON واحد جوه عمود settings_json، فإضافة إعداد جديد
//   مستقبلاً = إضافة مفتاح في INVENTORY_SETTINGS_DEFAULTS بس، من غير أي
//   تعديل في الـ schema أو أعمدة الشيت.
//
// هذا الملف بيغطي Phase 1 بس (الأساس): الشيت + get/save + كاش + Audit.
// الـ UI (Tabs) والربط الفعلي مع باقي الملفات (Code_16_Inventory.js إلخ)
// هيتوا في المراحل الجاية بعد المراجعة.
// ════════════════════════════════════════════════════════════════════════════

var INVENTORY_SETTINGS_SHEET = "InventorySettings";
var INVENTORY_SETTINGS_HEADERS = ["id", "settings_json", "updated_by", "updated_at"];
var INVENTORY_SETTINGS_CACHE_KEY = "inv_settings_v1";
var INVENTORY_SETTINGS_CACHE_TTL = 21600; // 6 ساعات — زي باقي إعدادات النظام شبه الثابتة

// ── القيم الافتراضية لكل الأقسام الـ15 ───────────────────────────────────
// كل مفتاح هنا = إعداد قابل للتعديل من شاشة الإعدادات. الأقسام مقسّمة
// بتعليقات بس (مفيش nesting) عشان تبسيط القراءة/الكتابة والـ diff في
// الـ Audit. لما نبني الـ UI (Phase 2/3) هيتقرا نفس المفاتيح دي بالظبط.
var INVENTORY_SETTINGS_DEFAULTS = {
  // ── 1) الإعدادات العامة ──
  // [INV-SETTINGS-BUGFIX-2026-08-08] "allow_negative_stock" اتشال من هنا
  // عمدًا. المصدر الحقيقي الوحيد للإعداد ده هو شيت "Settings" القديم
  // (_getCompanySettingsRaw / saveCompanySettings — شاشة الإعدادات العامة
  // > تاب "العمليات" في Templates_06.html)، وده اللي فعليًا بيتقرا في نقطة
  // التنفيذ (Code_16_Inventory.js §validateTransaction، مرتين). كان فيه
  // مفتاح تاني باسم مطابق هنا في InventorySettings الجديد له شاشة/سويتش
  // منفصل تمامًا (57_JS_InventorySettings.html) بيتخزن في شيت مختلف —
  // فكان تغيير السويتش ده بيتحفظ بنجاح لكن من غير أي تأثير فعلي على
  // السلوك، لأن التنفيذ مكانش بيقرا منه. راجع InventorySettingsEngine.get
  // تحت — بيرجّع القيمة الحقيقية من المصدر القديم لأي كود يطلب المفتاح ده
  // بدل ما يرجّع نسخة تانية مالهاش تأثير.
  block_sale_if_unavailable: true,
  allow_reserve_before_available: false,
  enable_qty_tracking: true,
  enable_value_tracking: true,
  enable_multi_warehouse: true,
  enable_bins: false,
  enable_batches: false,
  enable_serial_numbers: false,
  enable_expiry_dates: false,
  enable_multi_units: true,
  enable_bundle_items: true,
  enable_service_items: true,
  enable_non_stock_items: true,

  // ── 2) سياسة تقييم المخزون ──
  valuation_method: "average", // fifo | lifo | average | moving_average | standard

  // ── 3) سياسة التكلفة ──
  auto_update_cost: true,
  cost_source: "last_purchase", // last_purchase | average | fixed | manual

  // ── 4) سياسة الحجز ──
  reserve_on: "order_create", // order_create | order_approve | invoice
  auto_release_reservation: true,
  reservation_expiry_hours: 48,

  // ── 5) سياسة الجرد ──
  stocktake_mode: "periodic", // periodic | continuous
  allow_sale_during_stocktake: false,
  freeze_ops_during_stocktake: true,
  stocktake_requires_approval: true,

  // ── 6) سياسة التحويل بين المخازن ──
  transfer_requires_approval: true,
  transfer_approval_type: "electronic", // electronic | direct
  transfer_mode: "two_step", // direct | two_step
  transfer_requires_receipt_confirm: true,

  // ── 7) سياسة المرتجعات ──
  sales_return_enabled: true,
  purchase_return_enabled: true,
  return_default_action: "restock", // restock | scrap | quarantine

  // ── 8) الحد الأدنى والأقصى / إعادة الطلب ──
  default_min_qty: 0,
  default_max_qty: 0,
  default_reorder_point: 0,
  default_reorder_qty: 0,
  reorder_alert_days_before: 3, // ← الإعداد اللي طلبه المستخدم بدل حقل Lead Time لكل صنف
  low_stock_notify: true,

  // ── 9) سياسة الوحدات ──
  allow_sell_any_unit: true,

  // ── 10) سياسة الباركود ──
  barcode_auto_generate: true,
  barcode_prevent_duplicate: true,
  barcode_multi_per_item: false,
  barcode_auto_print: false,

  // ── 11) سياسة الترقيم (Prefix/Suffix/عدد الأرقام لكل نوع مستند) ──
  numbering: {
    items: { prefix: "ITM-", suffix: "", digits: 5 },
    movements: { prefix: "MOV-", suffix: "", digits: 6 },
    transfer_orders: { prefix: "TRF-", suffix: "", digits: 5 },
    stocktake_orders: { prefix: "STK-", suffix: "", digits: 5 },
    receipt_orders: { prefix: "RCV-", suffix: "", digits: 5 },
    issue_orders: { prefix: "ISU-", suffix: "", digits: 5 },
  },

  // ── 12) صلاحيات المستخدمين (مفاتيح فوقية — التفعيل الفعلي عبر
  // ALL_PERMISSIONS في Code_18_Permissions.js، دي بس سياسة افتراضية) ──
  restrict_qty_edit: true,
  restrict_cost_edit: true,
  restrict_valuation_edit: true,
  restrict_movement_delete: true,
  restrict_movement_cancel: true,
  restrict_movement_reopen: true,

  // ── 13) الربط المحاسبي ──
  // [ملاحظة معمارية] القرار: مانكررش تخزين حسابات جديدة هنا — دي
  // بترتبط بمفاتيح POSTING_CONFIG_KEYS الموجودة فعلاً في
  // Code_19_PostingConfig.js (inventory_account, cogs_account,
  // inventory_adjustment_account... إلخ) بدل ما نعمل نظام تخزين
  // موازي. هنضيف أي مفتاح حساب ناقص هناك في Phase 5.

  // ── 14) الإشعارات ──
  notify_near_stockout: true,
  notify_expiry: true,
  notify_low_stock: true,
  notify_overstock: false,
  notify_stocktake_variance: true,
  notify_po_arrival: true,

  // ═══════════════════════════════════════════════════════════════════
  // [INV-SETTINGS-2026-08-08] الإضافات الجديدة (عام موسّع + خصائص
  // المخزون + وحدات القياس + إذون الإضافة/الصرف + معادلة الأسعار)
  // ═══════════════════════════════════════════════════════════════════

  // ── عام (موسّع) ──
  bonus_qty_calc_method: "smallest_unit", // smallest_unit | invoice_unit
  barcode_print_repeat_mode: "once", // once | per_qty | custom
  serial_require_party_name: false,
  serial_allow_manual_pick_on_sale: true,
  serial_invalid_use_action: "warn_password", // block | warn_password | allow
  serial_override_password: "",
  expiry_unknown_batch_on_purchase: "create_auto", // create_auto | block | ask
  expiry_receive_policy: "always_ask_date", // always_ask_date | nearest_expiry
  expiry_issue_policy: "fefo", // fefo | manual
  expiry_min_accept_days: 0,
  expiry_block_batch_edit_on_purchase: true,
  expiry_qr_unknown_action: "open_expiry_screen", // open_expiry_screen | ignore

  // ── خصائص المخزون (الخصائص الافتراضية لتعريف الأصناف) ──
  item_default_valuation_method: "fifo", // fifo | lifo | average
  item_code_generation_method: "auto_increment", // auto_increment | manual
  item_default_inventory_type: "stock", // stock | service | non_stock
  item_default_unit: "قطعة",
  item_default_min_qty: 0,
  item_default_max_qty: 0,
  item_stagnation_period_days: 0,
  item_expiry_alert_days: 0,
  item_tax_handling: "no", // no | sales_only | purchases_only | both
  item_tax_rate_sales: 0,
  item_tax_rate_purchases: 0,
  item_price_includes_tax: false,
  item_discount_tax_handling: "as_invoice", // as_invoice | fixed | none
  item_discount_tax_account: "",
  item_discount_tax_rate: 0,

  // ── وحدات القياس (اسم + عدد وحدات) ──
  measurement_units: [{ name: "قطعة", count: 1 }],

  // ── إذون الإضافة / إذون الصرف (اسم + حساب مرتبط + نشط) ──
  receipt_permits: [],
  issue_permits: [],

  // ── معادلة الأسعار ──
  price_formulas: [],
};

// ════════════════════════════════════════════════════════════════════════
// §INV-SET-01 — قراءة الإعدادات (مع كاش + دمج تلقائي لأي مفتاح جديد
// لسه معملوش migration للصف المخزّن، عشان إضافة إعداد مستقبلاً متطلبش
// أي كود migration يدوي — أي مفتاح ناقص في الصف القديم بياخد الـ default)
// ════════════════════════════════════════════════════════════════════════
function getInventorySettings(callerUser, sessionToken) {
  try {
    var cached = _loadServerCache(INVENTORY_SETTINGS_CACHE_KEY);
    if (cached) return { success: true, data: cached };

    var merged = _readInventorySettingsRaw();
    _saveServerCache(merged, INVENTORY_SETTINGS_CACHE_KEY, INVENTORY_SETTINGS_CACHE_TTL);
    return { success: true, data: merged };
  } catch (e) {
    return errResponse("خطأ في جلب إعدادات المخزون: " + e.message);
  }
}

// قراءة خام من الشيت + دمج مع الـ defaults (بدون كاش) — تُستخدم داخليًا
// من أي نقطة في الكود محتاجة تقرأ إعداد واحد فورًا (Phase 4 لاحقًا)
function _readInventorySettingsRaw() {
  var sheet = getSheet(INVENTORY_SETTINGS_SHEET, INVENTORY_SETTINGS_HEADERS);
  var lastRow = sheet.getLastRow();
  var stored = {};
  if (lastRow >= 2) {
    var row = sheet.getRange(2, 1, 1, INVENTORY_SETTINGS_HEADERS.length).getValues()[0];
    var rawJson = row[1]; // settings_json
    if (rawJson) {
      try {
        stored = JSON.parse(rawJson);
      } catch (parseErr) {
        stored = {};
      }
    }
  }
  // دمج ضحل (shallow) كافٍ هنا لأن كل مفتاح مستقل، ما عدا "numbering"
  // اللي هي كائن متداخل — بندمجها هي كمان shallow على مستوى نوع المستند
  var merged = Object.assign({}, INVENTORY_SETTINGS_DEFAULTS, stored);
  merged.numbering = Object.assign(
    {},
    INVENTORY_SETTINGS_DEFAULTS.numbering,
    stored.numbering || {},
  );
  merged.measurement_units = Array.isArray(stored.measurement_units)
    ? stored.measurement_units
    : INVENTORY_SETTINGS_DEFAULTS.measurement_units;
  merged.receipt_permits = Array.isArray(stored.receipt_permits)
    ? stored.receipt_permits
    : INVENTORY_SETTINGS_DEFAULTS.receipt_permits;
  merged.issue_permits = Array.isArray(stored.issue_permits)
    ? stored.issue_permits
    : INVENTORY_SETTINGS_DEFAULTS.issue_permits;
  merged.price_formulas = Array.isArray(stored.price_formulas)
    ? stored.price_formulas
    : INVENTORY_SETTINGS_DEFAULTS.price_formulas;
  return merged;
}

// ════════════════════════════════════════════════════════════════════════
// §INV-SET-02 — حفظ الإعدادات (دفعي بالكامل من شاشة الإعدادات)
// نفس نمط saveAllAccountingSettings في Code_19_PostingConfig.js: فحص
// صلاحية، قفل، قراءة القديم لعمل diff، كتابة الجديد، تسجيل Audit، إبطال
// الكاش.
// ════════════════════════════════════════════════════════════════════════
function saveInventorySettings(payload, sessionToken) {
  var lock = LockService.getScriptLock();
  try {
    var callerUser =
      payload && payload.callerUser
        ? payload.callerUser
        : _getUsernameFromToken(sessionToken);
    if (!callerUser) return errResponse("اسم المستخدم مطلوب");

    var permErr = _checkPermission(callerUser, "manageInventorySettings", sessionToken);
    if (permErr) return permErr;

    var incoming = (payload && payload.settings) || {};
    if (!incoming || typeof incoming !== "object") {
      return errResponse("صيغة الإعدادات غير صحيحة");
    }
    // [INV-SETTINGS-BUGFIX-2026-08-08] منع تخزين نسخة ميتة تانية من
    // allow_negative_stock هنا — مصدرها الوحيد شيت الإعدادات القديم.
    if ("allow_negative_stock" in incoming) delete incoming.allow_negative_stock;

    lock.waitLock(10000);

    var oldMerged = _readInventorySettingsRaw();
    // ندمج فوق القديم مش فوق الـ defaults بس، عشان أي مفتاح متبعتش من
    // الواجهة (تاب لسه معمول عليه focus من غير حفظ) يفضل زي ما كان
    var newMerged = Object.assign({}, oldMerged, incoming);
    if (incoming.numbering) {
      newMerged.numbering = Object.assign({}, oldMerged.numbering, incoming.numbering);
    }
    if (Array.isArray(incoming.measurement_units)) {
      newMerged.measurement_units = incoming.measurement_units;
    }
    if (Array.isArray(incoming.receipt_permits)) {
      newMerged.receipt_permits = incoming.receipt_permits;
    }
    if (Array.isArray(incoming.issue_permits)) {
      newMerged.issue_permits = incoming.issue_permits;
    }
    if (Array.isArray(incoming.price_formulas)) {
      newMerged.price_formulas = incoming.price_formulas;
    }

    var sheet = getSheet(INVENTORY_SETTINGS_SHEET, INVENTORY_SETTINGS_HEADERS);
    var now = new Date();
    var jsonStr = JSON.stringify(newMerged);
    if (sheet.getLastRow() >= 2) {
      sheet.getRange(2, 1, 1, INVENTORY_SETTINGS_HEADERS.length).setValues([
        [1, jsonStr, callerUser, now],
      ]);
    } else {
      sheet.appendRow([1, jsonStr, callerUser, now]);
    }

    _invalidateServerCache(INVENTORY_SETTINGS_CACHE_KEY);

    var diff = _diffObjects(oldMerged, newMerged);
    if (Object.keys(diff.new).length > 0) {
      _addAuditLog(
        callerUser,
        "update",
        "InventorySettings",
        "1",
        diff.old,
        diff.new,
      );
    }

    return okResponse(" تم حفظ إعدادات المخزون", { data: newMerged });
  } catch (e) {
    return errResponse("خطأ في حفظ إعدادات المخزون: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

// ════════════════════════════════════════════════════════════════════════
// §INV-SET-03 — إرجاع كل الإعدادات (أو مفتاح واحد) للقيم الافتراضية
// ════════════════════════════════════════════════════════════════════════
function resetInventorySettings(payload, sessionToken) {
  try {
    var callerUser =
      payload && payload.callerUser
        ? payload.callerUser
        : _getUsernameFromToken(sessionToken);
    if (!callerUser) return errResponse("اسم المستخدم مطلوب");

    var permErr = _checkPermission(callerUser, "manageInventorySettings", sessionToken);
    if (permErr) return permErr;

    var oldMerged = _readInventorySettingsRaw();
    var keys = payload && payload.keys; // لو اتبعتت array معينة، رجّع دول بس

    var resetTo;
    if (keys && keys.length) {
      resetTo = Object.assign({}, oldMerged);
      keys.forEach(function (k) {
        if (k in INVENTORY_SETTINGS_DEFAULTS) resetTo[k] = INVENTORY_SETTINGS_DEFAULTS[k];
      });
    } else {
      resetTo = Object.assign({}, INVENTORY_SETTINGS_DEFAULTS);
    }

    return saveInventorySettings(
      { callerUser: callerUser, settings: resetTo },
      sessionToken,
    );
  } catch (e) {
    return errResponse("خطأ في إرجاع إعدادات المخزون للافتراضي: " + e.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// §INV-SET-04 — دالة مساعدة داخلية لقراءة إعداد واحد بسرعة من أي نقطة
// تانية في الكود (Phase 4 هتستخدمها بدل القيم الـ Hardcoded). بترجع
// من الكاش لو موجود، وإلا بتقرا خام وتكاش النتيجة.
// مثال استخدام لاحقًا: var days = InventorySettingsEngine.get("reorder_alert_days_before");
// ════════════════════════════════════════════════════════════════════════
var InventorySettingsEngine = {
  get: function (key) {
    // [INV-SETTINGS-BUGFIX-2026-08-08] "allow_negative_stock" مصدره
    // الحقيقي الوحيد شيت الإعدادات العامة القديم، مش شيت InventorySettings
    // ده. أي كود يطلبه من هنا لازم ياخد نفس القيمة اللي بتتطبق فعليًا.
    if (key === "allow_negative_stock") {
      try {
        var legacy =
          typeof _getCompanySettingsRaw === "function" ? _getCompanySettingsRaw() : {};
        return legacy.allow_negative_stock === true || legacy.allow_negative_stock === "true";
      } catch (eLegacy) {
        return false;
      }
    }
    var all = _loadServerCache(INVENTORY_SETTINGS_CACHE_KEY) || _readInventorySettingsRaw();
    if (!_loadServerCache(INVENTORY_SETTINGS_CACHE_KEY)) {
      _saveServerCache(all, INVENTORY_SETTINGS_CACHE_KEY, INVENTORY_SETTINGS_CACHE_TTL);
    }
    return key in all ? all[key] : INVENTORY_SETTINGS_DEFAULTS[key];
  },
  getAll: function () {
    var merged = _readInventorySettingsRaw();
    // ما نرجّعش نسخة ميتة من allow_negative_stock ضمن الكل — نستبدلها
    // بالقيمة الحقيقية عشان أي شاشة تستخدم getAll() تعرض القيمة الصح.
    merged.allow_negative_stock = InventorySettingsEngine.get("allow_negative_stock");
    return merged;
  },
};
