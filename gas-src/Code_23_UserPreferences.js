// ════════════════════════════════════════════════════════════════
// Code_UserPreferences.gs — [REFACTOR-P3] نُقل من Code_Core.gs (نقل نصي بحت، صفر
// تغيير في المنطق أو الترتيب الداخلي). Apps Script يعامل كل ملفات
// .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء من
// أي ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// المصدر الأصلي: Code_Core.gs — راجع تقرير Architecture Audit
// بتاريخ 2026-07-03، المرحلة 3.
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 35557-35788] User Preferences ┄┄┄
// §UP  نظام تفضيلات المستخدم (User Preferences System)
// ═══════════════════════════════════════════════════════════════════════════
// البنية:
//   شيت UserPreferences: id | username | pref_key | pref_value | updated_at
//   JSON monorow: username → { key: value, ... } مخزّن في عمود pref_value
//   الاستراتيجية: صف واحد لكل مستخدم — القيمة JSON بالكامل (أداء أفضل)
// ═══════════════════════════════════════════════════════════════════════════

var USER_PREFS_HEADERS = ["id", "username", "pref_json", "updated_at"];

// ─── قيم افتراضية لتفضيلات المستخدم ────────────────────────────────────────
var USER_PREFS_DEFAULTS = {
  // General
  language: "ar",
  timezone: "Africa/Cairo",
  date_format: "DD/MM/YYYY",
  time_format: "12h",
  currency: "EGP",
  items_per_page: 25,
  default_page: "dashboard",
  // Appearance
  theme: "light", // light | dark | auto
  accent_color: "#2563eb",
  font_size: "medium", // small | medium | large
  ui_density: "comfortable", // comfortable | compact
  // Accounting defaults
  default_warehouse: "",
  default_cashbox: "",
  default_bank: "",
  default_cost_center: "",
  default_branch: "",
  // Notifications
  notif_system: true,
  notif_email: false,
  notif_financial: true,
  notif_inventory: true,
  notif_customers: true,
  notif_suppliers: true,
  notif_approvals: true,
  notif_commhub_pending: true, // [PHASE4-NOTIF]
  // Security
  session_timeout: 60,
  confirm_sensitive: true,
  hide_balances: false,
  hide_prices: false,
  // Print
  paper_size: "A4",
  print_orientation: "portrait",
  print_copies: 1,
  // [FIX-AUDIT #4] ai_voice كان يُحفظ فقط في localStorage للمتصفح (غير متسق
  // مع باقي الشاشة التي تحفظ كل شيء على شيت Settings/UserPreferences).
  // الآن هو تفضيل مستخدم حقيقي مخزّن على السيرفر مثل بقية الحقول، فيتزامن
  // بين الأجهزة ولا يُفقد عند مسح الكاش.
  ai_voice: "Kore",
  // Tables (per-screen prefs are stored dynamically)
  tables: {},
  // Dashboard widget order/visibility
  dashboard_layout: {},
  // Favorites & recent
  favorites: [],
  recent_pages: [],
  recent_searches: [],
  // Shortcuts
  shortcuts: {},
};

// §UP-01 جلب تفضيلات مستخدم واحد (مع fallback للقيم الافتراضية)
function getUserPreferences(callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("اسم المستخدم مطلوب");
    // لا نشترط permission خاصة — كل مستخدم يقرأ تفضيلاته فقط
    var tokenUser = _getUsernameFromToken(sessionToken);
    if (tokenUser && tokenUser !== callerUser) {
      var permErr = _checkPermission(tokenUser, "manageUsers", sessionToken);
      if (permErr) return errResponse("لا يمكنك قراءة تفضيلات مستخدم آخر");
    }
    var prefs = _readUserPrefsRaw(callerUser);
    return { success: true, data: prefs, username: callerUser };
  } catch (e) {
    return errResponse("خطأ في جلب تفضيلات المستخدم: " + e.message);
  }
}

// §UP-02 حفظ تفضيل واحد
function saveUserPreference(payload, sessionToken) {
  try {
    var callerUser =
      payload && payload.callerUser
        ? payload.callerUser
        : _getUsernameFromToken(sessionToken);
    if (!callerUser || !payload.key)
      return errResponse("اسم المستخدم والمفتاح مطلوبان");
    // [FIX-AUDIT-2] نفس فحص saveBulkUserPreferences المجاورة — كانت هذه الدالة
    // بلا تحقق من تطابق sessionToken مع callerUser، ما يسمح لأي مستخدم مسجّل
    // بإرسال username شخص آخر في payload.callerUser وتعديل تفضيلاته بدلاً منه.
    var sessCheck = validateSession(sessionToken);
    if (
      !sessCheck ||
      !sessCheck.valid ||
      String(sessCheck.username || "")
        .trim()
        .toLowerCase() !== String(callerUser).trim().toLowerCase()
    ) {
      return errResponse(
        " جلستك انتهت أو غير صالحة — يرجى تسجيل الدخول مجدداً",
        "SESSION_INVALID",
      );
    }
    var current = _readUserPrefsRaw(callerUser);
    // دعم nested keys مثل "tables.Customers.sort"
    _setNestedPref(current, payload.key, payload.value);
    _writeUserPrefs(callerUser, current);
    return okResponse(" تم حفظ التفضيل", { key: payload.key });
  } catch (e) {
    return errResponse("خطأ في حفظ التفضيل: " + e.message);
  }
}

// §UP-03 حفظ دفعي (من شاشة التفضيلات بعد تعديل متعدد)
function saveBulkUserPreferences(payload, sessionToken) {
  try {
    var callerUser =
      payload && payload.callerUser
        ? payload.callerUser
        : _getUsernameFromToken(sessionToken);
    if (!callerUser) return errResponse("اسم المستخدم مطلوب");
    // [FIX-AUDIT] تحقق أن التوكن فعلاً يخص callerUser المُرسل — يمنع مستخدمًا من
    // انتحال username شخص آخر في payload.callerUser وكتابة تفضيلاته بدلاً منه.
    var sessCheck = validateSession(sessionToken);
    if (
      !sessCheck ||
      !sessCheck.valid ||
      String(sessCheck.username || "")
        .trim()
        .toLowerCase() !== String(callerUser).trim().toLowerCase()
    ) {
      return errResponse(
        " جلستك انتهت أو غير صالحة — يرجى تسجيل الدخول مجدداً",
        "SESSION_INVALID",
      );
    }
    var prefs = payload && payload.prefs ? payload.prefs : {};
    if (!Object.keys(prefs).length) return errResponse("لا توجد تفضيلات للحفظ");
    var current = _readUserPrefsRaw(callerUser);
    Object.keys(prefs).forEach(function (k) {
      _setNestedPref(current, k, prefs[k]);
    });
    _writeUserPrefs(callerUser, current);
    return okResponse(" تم حفظ " + Object.keys(prefs).length + " تفضيل", {
      count: Object.keys(prefs).length,
    });
  } catch (e) {
    return errResponse("خطأ في الحفظ الدفعي: " + e.message);
  }
}

// §UP-04 إعادة تعيين تفضيلات مستخدم للافتراضي
function resetUserPreferences(callerUser, sessionToken) {
  try {
    var tokenUser = _getUsernameFromToken(sessionToken);
    if (tokenUser !== callerUser) {
      var permErr = _checkPermission(tokenUser, "manageUsers", sessionToken);
      if (permErr)
        return errResponse("لا يمكنك إعادة تعيين تفضيلات مستخدم آخر");
    }
    _writeUserPrefs(
      callerUser,
      JSON.parse(JSON.stringify(USER_PREFS_DEFAULTS)),
    );
    return okResponse(" تمت إعادة التعيين للقيم الافتراضية");
  } catch (e) {
    return errResponse("خطأ في إعادة التعيين: " + e.message);
  }
}

// §UP-05 جلب تفضيلات جميع المستخدمين (للأدمن فقط)
function getUserPreferencesAll(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "manageUsers", sessionToken);
    if (permErr) return permErr;
    var rows = readSheet("UserPreferences", USER_PREFS_HEADERS, {
      trimStrings: true,
    });
    var result = rows
      .filter(function (r) {
        return !r.deleted_at;
      })
      .map(function (r) {
        return { username: r.username, updated_at: r.updated_at };
      });
    return { success: true, data: result };
  } catch (e) {
    return errResponse("خطأ في جلب تفضيلات المستخدمين: " + e.message);
  }
}

// ─── Helpers داخلية ─────────────────────────────────────────────────────────

// [FIX-AUDIT #1] currency / timezone / default_warehouse كانت لها "توأم"
// على مستوى الشركة (Settings sheet) يُحفظ ويُقرأ لكن لا أحد يستخدمه، لأن كل
// مكان في التطبيق يقرأ فقط تفضيل المستخدم بقيمته الثابتة الافتراضية
// (USER_PREFS_DEFAULTS) حتى لو المستخدم لم يضبط تفضيله الشخصي إطلاقًا.
// الحل: لو المستخدم لم يحدد تفضيلًا شخصيًا لأحد هذه المفاتيح، استخدم قيمة
// الشركة كافتراضي فعلي بدل الثابت المكتوب بالكود. المستخدم لسه يقدر يفضّل
// قيمة شخصية مختلفة عن الشركة (override) وهي اللي بتفوز دايمًا.
var COMPANY_FALLBACK_PREF_KEYS = {
  currency: "currency",
  timezone: "timezone",
  default_warehouse: "default_warehouse",
};

function _getCompanyFallbackDefaults() {
  var defaults = JSON.parse(JSON.stringify(USER_PREFS_DEFAULTS));
  try {
    var companySettings =
      typeof _getCompanySettingsRaw === "function"
        ? _getCompanySettingsRaw()
        : {};
    Object.keys(COMPANY_FALLBACK_PREF_KEYS).forEach(function (prefKey) {
      var companyKey = COMPANY_FALLBACK_PREF_KEYS[prefKey];
      var companyVal = companySettings[companyKey];
      if (
        companyVal !== undefined &&
        companyVal !== null &&
        companyVal !== ""
      ) {
        defaults[prefKey] = companyVal;
      }
    });
  } catch (e) {
    console.error("_getCompanyFallbackDefaults:", e);
  }
  return defaults;
}

function _readUserPrefsRaw(username) {
  try {
    var rows = readSheet("UserPreferences", USER_PREFS_HEADERS, {
      trimStrings: true,
    });
    var row = rows.find(function (r) {
      return r.username === username;
    });
    // الافتراضي هنا لم يعد الثابت وحده، بل الثابت مع overrides من إعدادات
    // الشركة (لو موجودة) — راجع التعليق أعلاه.
    var baseDefaults = _getCompanyFallbackDefaults();
    if (!row || !row.pref_json) return baseDefaults;
    var parsed = JSON.parse(row.pref_json);
    // دمج مع الافتراضي (شركة + ثابت) لضمان وجود أي مفاتيح جديدة، مع بقاء
    // أي تفضيل شخصي صرّح به المستخدم فعليًا هو الفائز (parsed تُدمج فوق).
    return _mergeDeep(baseDefaults, parsed);
  } catch (e) {
    return JSON.parse(JSON.stringify(USER_PREFS_DEFAULTS));
  }
}

function _writeUserPrefs(username, prefsObj) {
  var rows = readSheet("UserPreferences", USER_PREFS_HEADERS, {
    trimStrings: true,
  });
  var row = rows.find(function (r) {
    return r.username === username;
  });
  var now = new Date().toISOString();
  var json = JSON.stringify(prefsObj);

  // [ARCH-AUDIT-P3-19] setValue/appendRow خام -> DataLayerEngine.update/insert
  if (row) {
    DataLayerEngine.update(
      "UserPreferences",
      row.id,
      { pref_json: json, updated_at: now },
      { headers: USER_PREFS_HEADERS },
    );
  } else {
    DataLayerEngine.insert(
      "UserPreferences",
      { id: makeId("UP"), username: username, pref_json: json, updated_at: now },
      { headers: USER_PREFS_HEADERS },
    );
  }
}

function _setNestedPref(obj, key, value) {
  var parts = key.split(".");
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null)
      cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function _mergeDeep(target, source) {
  Object.keys(source).forEach(function (k) {
    if (
      source[k] &&
      typeof source[k] === "object" &&
      !Array.isArray(source[k])
    ) {
      if (!target[k] || typeof target[k] !== "object") target[k] = {};
      _mergeDeep(target[k], source[k]);
    } else {
      target[k] = source[k];
    }
  });
  return target;
}

// تسجيل الـ headers
ACCOUNTING_HR_HEADERS["UserPreferences"] = USER_PREFS_HEADERS;
// نُقل من Code_Accounting.gs: لازم يتنفذ بعد تعريف ACCOUNTING_HR_HEADERS
// (وبما أن ترتيب تحميل ملفات GAS أبجدي، Code_Accounting.gs بيتنفذ قبل
// هذا الملف، فـ FIXED_ASSETS_HEADERS هيكون معرّف بالفعل هنا)
ACCOUNTING_HR_HEADERS["FixedAssets"] = FIXED_ASSETS_HEADERS;

// ═══════════════════════════════════════════════════════════════════════════
// §UP-END  نهاية نظام تفضيلات المستخدم

// ┄┄┄ [مصدر: Code.js سطور 35789-35789] (خاتمة) ┄┄┄
// ═══════════════════════════════════════════════════════════════════════════
