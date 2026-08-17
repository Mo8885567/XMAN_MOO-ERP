/**
 * ============================================================
 * Module: Code_12l_GetAllData.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * الدالة المركزية التي تُغذّي الواجهة الأمامية بكل البيانات الأساسية
 * دفعة واحدة عند تحميل التطبيق (بدل عشرات الاستدعاءات المنفصلة لكل
 * شيت). تُعيد الأصناف، الألوان، المخازن، الحركات، أوامر الإنتاج،
 * المستخدمين (بدون كلمات مرور)، وغيرها من الكيانات الأساسية.
 *
 * Workflow:
 * 1. محاولة القراءة من كاش السيرفر (Server Cache) أولًا — أسرع بكثير
 *    من قراءة كل الشيتات من جديد.
 * 2. عند عدم وجود كاش صالح (منتهي أو مُفرَّغ): قراءة كل الشيتات
 *    المطلوبة، بناء الكائن الموحّد، ثم حفظه في الكاش لطلبات لاحقة.
 *
 * Dependencies:
 * - _loadServerCache / _saveServerCache (CacheService).
 * - SERVER_CACHE_KEY المُشتق من _permissionsFingerprint، بحيث يُبطَل
 *   الكاش تلقائيًا عند تغيّر بنية الصلاحيات.
 *
 * @returns {Object} كائن موحّد يضم كل مصفوفات البيانات الأساسية للنظام.
 */
function _getAllDataRaw(callerUser, sessionToken) {
  var shouldFilterForUser = !!(callerUser || sessionToken);
  if (shouldFilterForUser) {
    var authErr = _checkPermission(callerUser, "viewDashboard", sessionToken);
    if (authErr) return authErr;
  }
  // ✅ جرّب الكاش أول
  var cached = _loadServerCache();
  if (cached) {
    cached._from_cache = true;
    return shouldFilterForUser
      ? _filterAllDataForAuthenticatedUser(cached, callerUser, sessionToken)
      : cached;
  }

  // كاش فارغ → اقرأ من Sheets
  // ─────────────────────────────────────────────────────────────
  // [P1-REGISTRY] بدل تكرار منطق قراءة كل حقل هنا يدوياً، الحزمة كاملة
  // (كل المستويات 1..4) تُبنى الآن من مصدر الحقيقة الواحد DATA_REGISTRY
  // عبر _buildDataBundle (انظر Code_53_DataRegistryEngine.js). الشكل
  // الراجع لهذه الدالة ظلّ مطابقاً 100% لما كان عليه قبل هذا التعديل —
  // لا شاشة موجودة يجب أن تلاحظ أي فرق. الفرق الوحيد الحقيقي: أي حقل
  // جديد يُضاف مستقبلاً في DATA_REGISTRY يظهر هنا تلقائياً بدون أي
  // تعديل إضافي في هذه الدالة (هذا هو حل مشكلة "القائمة اليدوية
  // المتكررة" §3.2 من تقرير المرحلة الأولى).
  // ─────────────────────────────────────────────────────────────
  try {
    var bundle = _buildDataBundle([
      DATA_LEVEL.CRITICAL,
      DATA_LEVEL.ON_DEMAND,
      DATA_LEVEL.BACKGROUND,
      DATA_LEVEL.REFERENCE,
    ]);

    // حساب حالة الباكاب — ليس جزءاً من DATA_REGISTRY لأنه ليس "بيانات
    // شاشة" بل حالة نظام عامة، فبقي هنا كما كان بالضبط
    var props = PropertiesService.getScriptProperties();
    var lastBackup = props.getProperty("last_backup_time") || null;

    var result = Object.assign({ success: true }, bundle.data, {
      last_backup: lastBackup,
    });

    if (bundle._errors) {
      // لا نُفشل الحزمة كاملة بسبب حقل واحد — فقط نسجّل تحذيراً، تماماً
      // كما كانت كل try/catch الفردية تفعل سابقاً في الكود القديم
      console.error("getAllData: حقول فشلت جزئياً:", bundle._errors);
    }

    // ✅ احفظ في الكاش قبل الإرجاع
    _saveServerCache(result);
    return shouldFilterForUser
      ? _filterAllDataForAuthenticatedUser(result, callerUser, sessionToken)
      : result;
  } catch (e) {
    console.error("getAllData Error:", e);
    return {
      success: false,
      message: e.message,
      items: [],
      stock: [],
      transactions: [],
      productionOrders: [],
      warehouses: [],
      groups: [],
      users: [],
      openingStock: [],
      colors: [],
      sizes: [],
      sizeGroups: [],
      units: [], // [UNITS-2026-08-06]
      shipments: [],
      roles: [],
      permissions: [],
      userOverrides: {},
      customers: [],
      suppliers: [],
    };
  }
}

function getAllData(callerUser, sessionToken) {
  if (!callerUser || !sessionToken) {
    return errResponse("جلسة غير صالحة — يرجى تسجيل الدخول مجدداً", "SESSION_INVALID");
  }
  var authErr = _checkPermission(callerUser, "viewDashboard", sessionToken);
  if (authErr) return authErr;
  return _filterAllDataForAuthenticatedUser(
    _getAllDataRaw(),
    callerUser,
    sessionToken,
  );
}
function _getAllDataLightRaw(callerUser, sessionToken) {
  var shouldFilterForUser = !!(callerUser || sessionToken);
  if (shouldFilterForUser) {
    var authErr = _checkPermission(callerUser, "viewDashboard", sessionToken);
    if (authErr) return authErr;
  }
  try {
    // [PERF-LIGHT-CHUNK-FIX] كانت هذه القراءة بتعتمد على CacheEngine.get
    // (مفتاح واحد فقط، حد Google الفعلي 100KB) بافتراض إن الحزمة الخفيفة
    // "مصمَّمة تفضل تحت 100KB" — افتراض بيتكسر بصمت مع نمو البيانات
    // (أصناف/مخزون/مستخدمين/صلاحيات أكتر). لما الحزمة تتخطى الحد،
    // CacheEngine.set تحت كانت بترجع false بصمت (catch بيبلع الخطأ)
    // فالكاش عمليًا كان "ميت" وكل تحميل صفحة كان بيعيد قراءة كل الشيتات
    // من الصفر — وده السبب الجذري لبطء تحميل البيانات المتكرر. الحل:
    // نفس آلية التقسيم المُختبَرة فعليًا وبالفعل شغّالة لـ SERVER_CACHE_KEY/
    // AI_DATA_CACHE_KEY (_saveServerCache/_loadServerCache في
    // Code_12d_Cache.js) — بدل تكرارها هنا بمنطق جديد.
    var c = _loadServerCache(LIGHT_CACHE_KEY);
    if (c) {
      c._from_cache = true;
      c._light = true;
      return shouldFilterForUser
        ? _filterAllDataForAuthenticatedUser(c, callerUser, sessionToken)
        : c;
    }
  } catch (e) {
    Logger.log("[silent-catch] " + e);
  }

  // ─────────────────────────────────────────────────────────────
  // [P1-ب-REGISTRY] نفس مبدأ getAllData(): الحقول الفعلية المطلوبة في
  // حزمة اللوجين الخفيفة تُبنى الآن من DATA_REGISTRY (علامة
  // lightBundle:true لكل حقل)، بدل تكرار منطق القراءة يدوياً هنا بشكل
  // منفصل عن getAllData(). أي حقل يُضاف مستقبلاً ويُعلَّم lightBundle:true
  // في الـ registry يظهر هنا تلقائياً بدون أي تعديل إضافي في هذه الدالة.
  // الشكل الراجع (المفاتيح والقيم الفارغة الافتراضية للحقول الثقيلة)
  // ظلّ مطابقاً 100% لما كان عليه قبل هذا التعديل.
  // ─────────────────────────────────────────────────────────────
  try {
    var lightResult = _buildLightBundle();

    var props = PropertiesService.getScriptProperties();
    var lastBackup = props.getProperty("last_backup_time") || null;

    var result = Object.assign(
      {
        success: true,
        _light: true,
        // حقول فاضية عشان الـ frontend ما يكسرش — نفس القائمة القديمة
        // بالحرف؛ هذه الحقول عمداً *ليست* lightBundle في الـ registry
        // لأنها ثقيلة ومؤجَّلة قصداً لتحميل لاحق (transactions/invoices/
        // customers/suppliers/shipments/productionOrders)
        transactions: [],
        productionOrders: [],
        shipments: [],
        saleInvoices: [],
        purchaseInvoices: [],
        saleReturns: [],
        purchaseReturns: [],
        customers: [],
        suppliers: [],
      },
      lightResult.data,
      { last_backup: lastBackup },
    );

    if (lightResult._errors) {
      console.error(
        "getAllDataLight: حقول فشلت جزئياً:",
        lightResult._errors,
      );
    }

    try {
      // [PERF-LIGHT-CHUNK-FIX] _saveServerCache بتتقسّم تلقائيًا لعدة
      // مفاتيح لو تخطت 90KB (نفس آلية SERVER_CACHE_KEY) — عكس
      // CacheEngine.set القديمة اللي كانت بترمي/تفشل بصمت فوق 100KB.
      _saveServerCache(result, LIGHT_CACHE_KEY, CacheEngine.POLICY.LIGHT_BUNDLE);
    } catch (e) {
      Logger.log("[silent-catch] " + e);
    }

    return shouldFilterForUser
      ? _filterAllDataForAuthenticatedUser(result, callerUser, sessionToken)
      : result;
  } catch (e) {
    console.error("getAllDataLight Error:", e);
    return { success: false, message: e.message, _light: true };
  }
}


function getAllDataLight(callerUser, sessionToken) {
  if (!callerUser || !sessionToken) {
    return errResponse("جلسة غير صالحة — يرجى تسجيل الدخول مجدداً", "SESSION_INVALID");
  }
  var authErr = _checkPermission(callerUser, "viewDashboard", sessionToken);
  if (authErr) return authErr;
  return _filterAllDataForAuthenticatedUser(
    _getAllDataLightRaw(),
    callerUser,
    sessionToken,
  );
}
function _filterAllDataForAuthenticatedUser(data, callerUser, sessionToken) {
  if (!data || !callerUser || !sessionToken) return data;
  try {
    var filtered =
      typeof getAllDataForUser === "function"
        ? getAllDataForUser(callerUser, sessionToken, data)
        : data;
    if (typeof _filterSalaryFields === "function" && filtered.employees) {
      filtered.employees = _filterSalaryFields(
        filtered.employees,
        callerUser,
        sessionToken,
      );
    }
    return filtered;
  } catch (e) {
    AuditEngine.log("FILTER_ALL_DATA_ERROR", {
      user: callerUser,
      details: String((e && e.message) || e),
    });
    return {
      success: false,
      message: "تعذّر تطبيق قيود الوصول على البيانات",
      error: "DATA_FILTER_FAILED",
    };
  }
}
function _permissionsFingerprint() {
  try {
    var keys = ALL_PERMISSIONS.map(function (p) {
      return p.key;
    });
    return String(keys.length) + "_" + (keys[keys.length - 1] || "");
  } catch (e) {
    return "0";
  }
}

/**
 * [FIX-ROOT-CACHE] onEdit — Simple Trigger تلقائي من Google Apps Script.
 * يشتغل مع أي تعديل يدوي مباشر على أي شيت في المصنّف (سواء من المطوّر أو
 * من استيراد يدوي)، بعكس _invalidateServerCache/_invalidateExtCache اللي
 * كانت بتتنادى بس من دوال add/update/delete جوه التطبيق نفسه.
 *
 * المشكلة اللي كان بيسببها غياب الـ trigger ده: أي تعديل مباشر في الشيت
 * (زي إضافة صف بنك يدوياً) مايُبطلش كاش السيرفر (CacheService، حتى 30
 * دقيقة) ولا كاش المتصفح (sessionStorage، حتى 20 دقيقة) — فتفضل الشاشات
 * تعرض "لا توجد بيانات" رغم إن البيانات موجودة فعلاً في الشيت، لحد ما
 * الكاش ينتهي بنفسه بالصدفة.
 *
 * الحل: أي تعديل يدوي يمسح كاش السيرفر فوراً، فأول طلب جاي من أي متصفح
 * (حتى لو كان عنده كاش محلي منتهي أو خالي) هيقرا نسخة Fresh من الشيت.
 * (كاش المتصفح المفتوح فعلاً هيفضل قديم لحد انتهاء TTL بتاعه أو Refresh
 * يدوي، لأن onEdit بيشتغل على السيرفر بس ومقدرش يوصل لمتصفحات تانية).
 *
 * ملاحظة: onEdit(e) هنا Simple Trigger (مش Installable) — بيشتغل تلقائياً
 * بمجرد وجوده في المشروع من غير أي إعداد إضافي، لكنه محدود الصلاحيات
 * (زي كل الـ Simple Triggers) — CacheService.getScriptCache() مسموح
 * بيه فيها وده كل اللي محتاجينه هنا.
 */
function onEdit(e) {
  try {
    _invalidateServerCache();
    _invalidateExtCache();
  } catch (err) {
    // صامت عمداً — onEdit بيتنفذ مع كل ضغطة تعديل، أي خطأ هنا لازم
    // ميوقفش المستخدم عن التعديل العادي في الشيت.
  }

  // [NO-WHITE-FONT] شبكة أمان أخيرة: أي خلية بيانات (مش صف الهيدر) بتتعدل
  // — سواء يدويًا من المستخدم أو من أي كود تاني في المشروع (حتى لو مش
  // مغطى بإصلاحات insert/update/bulkInsert) — نمسح لون خطها فورًا لو
  // موروث كأبيض/فاتح، عشان القيمة الجديدة متفضلش "مخفية" بصريًا مهما كان
  // سبب اللون القديم.
  try {
    if (e && e.range && e.range.getRow() > 1) {
      e.range.setFontColor(null);
    }
  } catch (err2) {
    // صامت عمداً لنفس السبب أعلاه.
  }
}

/**
 * [NO-WHITE-FONT] scheduledFixWhiteFont — نسخة مجدولة (Time-driven Trigger)
 * من fixAllWhiteFontInSheets، تغطي أي كتابة برمجية بره onEdit (زي الـ 70+
 * مكان في المشروع اللي بيكتبوا بـ appendRow/setValues مباشرة من غير ما
 * يمروا على DataLayer المحمي). شغّلها مرة واحدة يدويًا من المحرر
 * (Run) عشان تربطها بـ Trigger يومي:
 *   ScriptApp.newTrigger('scheduledFixWhiteFont').timeBased().everyDays(1).create();
 */
function scheduledFixWhiteFont() {
  fixAllWhiteFontInSheets();
}

