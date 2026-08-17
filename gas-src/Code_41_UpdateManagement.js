/**
 * ============================================================
 * Module: Code_41_UpdateManagement.gs  —  Client Mode
 *
 * [MOVED-TO-HUB] هذه الوحدة كانت فيها CRUD كامل لإدارة إصدارات/إعلانات
 * النظام محليًا داخل كل نسخة عميل. اتنقلت الإدارة بالكامل لبروجيكت
 * مركزي منفصل (MOO-UpdatesHub) بيتحكم فيه المطوّر فقط، عشان الشركة
 * العميلة متقدرش تعدّل/تشوف بيانات إصدارات عملاء تانيين ولا حتى بيانات
 * الإصدار قبل ما يتنشر ليها.
 *
 * الوحدة هنا بقت "Client فقط": بتسحب البيانات المنشورة من المركزي
 * عن طريق getUpdatesFromHub() (موجودة في نفس الملف ده تحت)، بتعمل
 * cache محلي، وبتحتفظ بتتبع "قرأه/مؤجل/مؤرشف" محليًا لكل مستخدم
 * (ده مايستلزمش أي اتصال بالمركزي، فضل محلي زي ما هو).
 *
 * لا يوجد هنا أي دالة تعديل بيانات إصدارات/إعلانات — أي محاولة نداء
 * دالة إدارة قديمة (createVersion/publishVersion/...) هترجع خطأ صريح
 * (راجع §41-I تحت).
 *
 * Dependencies:
 *   Code_12_Core.gs (getSheet/readSheet/_appendRowProtected/makeId/
 *   errResponse/okResponse/_requireSession).
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
// §41-A  Headers — جداول محلية (تتبع القراءة فقط؛ مفيش جداول إصدارات
// أو إعلانات محلية خالص، البيانات نفسها بتيجي من المركزي)
// ─────────────────────────────────────────────────────────────

var UM_VERSION_READS_HEADERS = [
  "id",
  "version_id",
  "username",
  "action", // seen | dismissed | remind_later | viewed_details
  "created_at",
];

var UM_ANN_READS_HEADERS = [
  "id",
  "announcement_id",
  "username",
  "status", // read | archived | dismissed
  "created_at",
];

// ─────────────────────────────────────────────────────────────
// §41-B  الاتصال بالمركزي (MOO-UpdatesHub) — HMAC signed requests
// ─────────────────────────────────────────────────────────────
//
// الإعداد المطلوب مرة واحدة (Project Settings → Script Properties):
//   UPDATES_HUB_URL        = رابط الـ Web App بتاع المركزي (/exec)
//   UPDATES_HUB_CLIENT_ID  = client_id اللي طلع من لوحة تحكم المركزي
//   UPDATES_HUB_SECRET     = الـ raw secret (يتحط مرة واحدة بس)
//
var UM_CACHE_KEY = "moo_updates_hub_cache_v1";
var UM_CACHE_TTL_SEC = 60 * 30; // نص ساعة

function _umHexDigest(bytes) {
  return bytes
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? "0" + v : v;
    })
    .join("");
}

function _umSignedRequest(action, payload) {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty("UPDATES_HUB_CLIENT_ID");
  var secret = props.getProperty("UPDATES_HUB_SECRET");
  var url = props.getProperty("UPDATES_HUB_URL");
  if (!clientId || !secret || !url) {
    throw new Error("إعدادات Updates Hub غير مكتملة في Script Properties");
  }

  var secretHash = _umHexDigest(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      secret,
      Utilities.Charset.UTF_8,
    ),
  );

  var timestamp = Date.now();
  var payloadObj = payload || {};
  var payloadHash = _umHexDigest(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      JSON.stringify(payloadObj),
      Utilities.Charset.UTF_8,
    ),
  );
  // التوقيع لازم يغطي action وhash(payload) مش بس client_id+timestamp،
  // عشان محدّش يقدر ياخد توقيع صالح لطلب معيّن ويعيد استخدامه لـ
  // action أو payload مختلف (لازم يطابق تمامًا نفس المنطق في
  // Code_01_ClientAuth.gs بالمركزي).
  var signable =
    clientId + "|" + timestamp + "|" + (action || "") + "|" + payloadHash;
  var signature = _umHexDigest(
    Utilities.computeHmacSha256Signature(
      signable,
      secretHash,
      Utilities.Charset.UTF_8,
    ),
  );

  var res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify({
      client_id: clientId,
      timestamp: timestamp,
      signature: signature,
      action: action,
      payload: payloadObj,
    }),
  });
  return JSON.parse(res.getContentText());
}

/**
 * getUpdatesFromHub — بيرجع { versions, announcements, categories } من
 * المركزي، بكاش نص ساعة. لو المركزي مش متاح (نت واقع...) بيرجع آخر
 * نسخة ناجحة اتخزنت بدل ما يفشل ويوقف شاشات المستخدم.
 */
// [CACHE-ENGINE / المرحلة 13 — P1] كان هنا CacheService.getScriptCache()
// مباشر بمفتاح/TTL محليين (UM_CACHE_KEY/UM_CACHE_TTL_SEC). دلوقتي بيمر
// عبر CacheEngine (CACHE_NAMESPACE.UPDATE_MGMT) — نفس المفتاح والـ TTL
// اتسابوا زي ما هما (نص ساعة) بدون أي تغيير في السلوك، بس البادئة بقت
// موحّدة مع باقي الموديولات بدل ما تتبني يدويًا هنا بس.
function getUpdatesFromHub() {
  var cached = CacheEngine.get(CacheEngine.NAMESPACE.UPDATE_MGMT, UM_CACHE_KEY);
  if (cached) return cached;

  try {
    var result = _umSignedRequest("getUpdates", {});
    if (result.success) {
      CacheEngine.set(
        CacheEngine.NAMESPACE.UPDATE_MGMT,
        UM_CACHE_KEY,
        result,
        UM_CACHE_TTL_SEC,
      );
      PropertiesService.getScriptProperties().setProperty(
        "um_last_good",
        JSON.stringify(result),
      );
    }
    return result;
  } catch (e) {
    var lastGood =
      PropertiesService.getScriptProperties().getProperty("um_last_good");
    if (lastGood) return JSON.parse(lastGood);
    return errResponse("تعذر الاتصال بخادم التحديثات حاليًا");
  }
}

/**
 * نفس بيانات getUpdatesFromHub لكن من الكاش/آخر نسخة محفوظة فقط —
 * من غير أي اتصال شبكة متزامن بالمركزي. تُستخدم في المسارات اللي
 * لازم تكون سريعة/فورية (زي شاشة About) وميستحملش تنتظر رد HTTP.
 * لو مفيش كاش ولا آخر نسخة محفوظة، بترجع success:false بهدوء.
 */
function _getUpdatesFromHubCacheOnly() {
  try {
    var cached = CacheEngine.get(CacheEngine.NAMESPACE.UPDATE_MGMT, UM_CACHE_KEY);
    if (cached) return cached;
    var lastGood =
      PropertiesService.getScriptProperties().getProperty("um_last_good");
    if (lastGood) return JSON.parse(lastGood);
  } catch (e) {
    // تجاهل — الفانكشن دي أصلًا best-effort
  }
  return { success: false };
}

// ─────────────────────────────────────────────────────────────
// §41-B2  حالة الترخيص/الاشتراك (License / Subscription Status)
// ─────────────────────────────────────────────────────────────
//
// المصدر الوحيد للحقيقة هو المركزي (MOO-UpdatesHub) — راجع
// _computeLicenseStatus() هناك (Code_22_LicenseEngine.gs). هنا بس
// اتصال + كاش، مفيش أي حساب لتواريخ أو أيام متبقية محليًا؛ الفرونت
// (41_JS_UpdateManagement.html / Templates_01.html renderLogin) بيعرض
// بس الحقول الجاهزة اللي المركزي بيرجعها (status/daysRemaining/
// warningLevel/message).
//
// action="checkLicense" هي القناة الوحيدة اللي بتتجاوز حجب
// status!==active على المركزي (راجع _verifyClientRequest هناك)، عشان
// كده هي المستخدمة هنا بدل getUpdatesFromHub العادية.

var UM_LICENSE_CACHE_KEY = "moo_license_status_cache_v1";
var UM_LICENSE_CACHE_TTL_SEC = 60 * 15; // ربع ساعة — يتجدد تلقائيًا مع warmCache()

/**
 * getLicenseStatusFromHub — نداء حي (مع كاش) لحالة الترخيص من المركزي.
 * تُستخدم من warmCache() (تحديث دوري كل 15 دقيقة) ومن checkOnLogin
 * (بعد نجاح تسجيل الدخول، لتحديث البانر داخل النظام فورًا لو محتاج).
 * لو المركزي مش متاح، بترجع آخر نسخة ناجحة اتخزنت بدل ما تفشل بالكامل
 * (نفس فلسفة getUpdatesFromHub بالظبط).
 */
function getLicenseStatusFromHub() {
  try {
    var result = _umSignedRequest("checkLicense", {});
    if (result && result.success && result.license) {
      CacheEngine.set(
        CacheEngine.NAMESPACE.UPDATE_MGMT,
        UM_LICENSE_CACHE_KEY,
        result.license,
        UM_LICENSE_CACHE_TTL_SEC,
      );
      PropertiesService.getScriptProperties().setProperty(
        "um_license_last_good",
        JSON.stringify(result.license),
      );
    }
    return result;
  } catch (e) {
    Logger.log("getLicenseStatusFromHub error: " + e.message);
    return errResponse("تعذر الاتصال بخادم التراخيص حاليًا");
  }
}

/**
 * _getLicenseStatusCacheOnly — بدون أي اتصال شبكة متزامن. تُستخدم في
 * doGet (قبل شاشة اللوجين) عشان ميبطّئش أول تحميل للصفحة أبدًا. لو
 * الكاش والـ last-good فاضيين تمامًا (نشر أول مرة قبل أي اتصال ناجح
 * بالمركزي)، بترجع null والبانر ببساطة ما بيظهرش (مش رسالة خطأ مربكة
 * على شاشة الدخول الأولى للنظام).
 */
function _getLicenseStatusCacheOnly() {
  try {
    var cached = CacheEngine.get(
      CacheEngine.NAMESPACE.UPDATE_MGMT,
      UM_LICENSE_CACHE_KEY,
    );
    if (cached) return cached;
    var lastGood = PropertiesService.getScriptProperties().getProperty(
      "um_license_last_good",
    );
    if (lastGood) return JSON.parse(lastGood);
  } catch (e) {
    // best-effort — لازم ميوقفش doGet
  }
  return null;
}

/**
 * checkLicenseOnBoot — الدالة اللي الفرونت (41_JS_UpdateManagement.html
 * / bindLogin في 02_JS_UI_Shell.html) بينادوها من google.script.run
 * لعرض بانر الترخيص فوق شاشة اللوجين. بترجع القيمة المحقونة أصلًا في
 * doGet (window.__PREFETCH__.license) عادةً — الدالة دي موجودة كـ
 * fallback/refresh يدوي بس (مثلاً بعد ما المستخدم يسيب الصفحة مفتوحة
 * لفترة طويلة قبل ما يسجّل دخول، ويحب يتأكد إن الحالة لسه محدّثة).
 * برضه cache-only — عشان ما تبطّئش الشاشة، بما إن warmCache بيحدّث كل
 * 15 دقيقة أصلًا.
 */
function checkLicenseOnBoot() {
  return okResponse("", { license: _getLicenseStatusCacheOnly() });
}

/** تُستدعى مرة عند بدء الجلسة — بتحدّث last_seen ورقم النسخة عند المركزي.
 * [PERF-PING-THROTTLE-2026-08-12] كانت بتعمل UrlFetchApp.fetch حي (بدون
 * أي Cache) مع كل login بلا استثناء — يعني كل مستخدم بيفتح النظام بيدفع
 * تكلفة اتصال HTTP خارجي كامل حتى لو فتح النظام 20 مرة في نفس الساعة.
 * لو المركزي بطيء/غير متاح (شائع في بيئة /dev)، الطلب ده كان بياخد لحد
 * 25-30 ثانية (مهلة _gsr الافتراضية بالفرونت) لكل مرة، ويستهلك Execution
 * Slot كامل من حصة Apps Script المتزامنة للمستخدم طول المدة دي. الحل:
 * throttle بسيط عبر CacheEngine — ping واحد فعلي كل 6 ساعات لكل مستخدم
 * كحد أقصى؛ باقي الـlogins بترجع فورًا من غير أي اتصال شبكة. */
var UM_PING_THROTTLE_SEC = 6 * 60 * 60; // 6 ساعات
function pingUpdatesHub(installedVersion, callerUser) {
  try {
    var throttleKey = "ping_" + (callerUser || "anon");
    if (CacheEngine.get(CacheEngine.NAMESPACE.UPDATE_MGMT, throttleKey)) {
      return; // اتعمل ping بالفعل مؤخرًا لنفس المستخدم — تجاهل بصمت
    }
    CacheEngine.set(
      CacheEngine.NAMESPACE.UPDATE_MGMT,
      throttleKey,
      { t: Date.now() },
      UM_PING_THROTTLE_SEC,
    );
    _umSignedRequest("ping", { installed_version: installedVersion || "" });
  } catch (e) {
    // ثانوية — تجاهل أي فشل
  }
}

/**
 * reportInstalledVersionOnLogin — تُستدعى من الفرونت-إند (checkOnLogin)
 * بعد كل دخول ناجح. بتبعت APP_VERSION (Code_42_AppVersion.js) للمركزي
 * عشان لوحة تحكم المطوّر تعرض "آخر ظهور" و"النسخة المثبتة" الحقيقية
 * لكل عميل. لا تنتظر ردها في الفرونت (fire-and-forget).
 */
function reportInstalledVersionOnLogin(callerUser, sessionToken) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  pingUpdatesHub(typeof APP_VERSION !== "undefined" ? APP_VERSION : "", callerUser);
  return okResponse("تم");
}

// ─────────────────────────────────────────────────────────────
// §41-C  Helpers
// ─────────────────────────────────────────────────────────────

function _umNow() {
  return new Date().toISOString();
}

// ═══════════════════════════════════════════════════════════════════
// §41-D  What's New + Release Notes (قراءة من كاش المركزي)
// ═══════════════════════════════════════════════════════════════════

/** getWhatsNew — آخر إصدار لسه المستخدم ده مشافوش
 * [PERF-GETWHATSNEW-CACHEONLY-2026-08-12] كانت بتنادي getUpdatesFromHub()
 * (اتصال حي متزامن بالمركزي لو كاش الـ30-دقيقة منتهي) رغم إن نفس الملف
 * فيه فعلًا _getUpdatesFromHubCacheOnly() اتعملت بالظبط عشان تحل نفس
 * المشكلة دي في دوال تانية (راجع تعليقات [FIX-TIMEOUT-2026-07] هنا تحت).
 * getWhatsNew اتنسيت من التحويل ده، فضلّت هي السبب الفعلي لـ25 ثانية
 * Timeout الظاهرة في الـconsole مع كل login. التحويل هنا بس — بدون أي
 * تغيير في شكل البيانات الراجعة أو منطق "مشافوش قبل كده". */
function getWhatsNew(callerUser, sessionToken) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  try {
    var hub = _getUpdatesFromHubCacheOnly();
    if (!hub.success) return okResponse("", { data: null });
    var versions = hub.versions || [];
    if (!versions.length) return okResponse("", { data: null });

    var latest = versions[0]; // المركزي بيرجعهم مرتبين الأحدث أولًا
    var reads = readSheet("UpdateVersionReads", UM_VERSION_READS_HEADERS, {
      trimStrings: true,
    }).filter(function (r) {
      return (
        r.version_id === latest.id &&
        String(r.username || "").toLowerCase() ===
          String(callerUser || "").toLowerCase()
      );
    });
    var dismissed = reads.some(function (r) {
      return r.action === "seen" || r.action === "dismissed";
    });
    if (dismissed) return okResponse("", { data: null });

    return okResponse("", { data: latest });
  } catch (e) {
    return errResponse("خطأ في جلب آخر تحديث: " + e.message);
  }
}

/** recordVersionAction — تسجيل تفاعل المستخدم مع نافذة What's New / Release Notes (محلي) */
function recordVersionAction(versionId, action, callerUser, sessionToken) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  if (!versionId || !action) return errResponse("بيانات ناقصة");
  var allowed = ["seen", "dismissed", "remind_later", "viewed_details"];
  if (allowed.indexOf(action) === -1) return errResponse("إجراء غير معروف");
  try {
    var sheet = getSheet("UpdateVersionReads", UM_VERSION_READS_HEADERS);
    _appendRowProtected(sheet, UM_VERSION_READS_HEADERS, [
      makeId("UVR"),
      versionId,
      callerUser,
      action,
      _umNow(),
    ]);
    return okResponse("تم الحفظ");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/** getReleaseNotes — كل الإصدارات المنشورة (من المركزي) مع بحث/تصفية محلية */
// [PERF-FIX-ABOUT-HANG-2026-08] هذه الدالة كانت المصدر الوحيد الفعلي
// لشاشة "حول النظام" (getAboutPageData ← getReleaseNotes، شوف تحت)،
// ومع ذلك كانت بتنادي getUpdatesFromHub() — النسخة اللي بتعمل
// UrlFetchApp.fetch حي (HTTP + توقيع HMAC) للمركزي المنفصل (MOO_HUB)
// وقت الطلب نفسه، رغم إن التعليق فوق _getUpdatesFromHubCacheOnly()
// بيقول صراحة إنها "مُعدّة لشاشة About" بالتحديد. النتيجة: أي بطء أو
// عدم استجابة من MOO_HUB (شبكة، cold-start بتاعه هو، أو حتى انقطاع
// مؤقت) كان بيوقف شاشة About بالكامل على الـ Skeleton لحد ما
// UrlFetchApp يرجع أو يضرب أقصى مهلة له (ممكن تدي دقايق، مش ثواني) —
// وده اللي كان ظاهر في اللقطة (شاشات لسه في Skeleton بعد 10 دقايق).
// الحل: استخدام النسخة الجاهزة من الكاش فقط (بدون أي اتصال شبكة
// متزامن) — بالظبط زي ما _umDisplayVersionInfo بيعمل بالفعل لنفس
// الصفحة. لو الكاش فاضي، بترجع مصفوفة فاضية بهدوء (زي المسار القديم
// وقت فشل hub.success) بدل ما تعلّق الشاشة.
function getReleaseNotes(filters, callerUser, sessionToken) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  filters = filters || {};
  try {
    var hub = _getUpdatesFromHubCacheOnly();
    if (!hub.success) return okResponse("", { data: [] });
    var rows = hub.versions || [];

    if (filters.search) {
      var q = String(filters.search).trim().toLowerCase();
      rows = rows.filter(function (r) {
        var hay =
          (r.title || "") +
          " " +
          (r.version || "") +
          " " +
          (r.short_desc || "") +
          " " +
          (r.full_desc || "") +
          " " +
          (r.changes || [])
            .map(function (c) {
              return c.text || "";
            })
            .join(" ");
        return hay.toLowerCase().indexOf(q) !== -1;
      });
    }
    if (filters.level) {
      rows = rows.filter(function (r) {
        return r.level === filters.level;
      });
    }
    if (filters.category) {
      rows = rows.filter(function (r) {
        return (r.changes || []).some(function (c) {
          return c.cat === filters.category;
        });
      });
    }
    return okResponse("", { data: rows });
  } catch (e) {
    return errResponse("خطأ في جلب سجل الإصدارات: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// §41-E  الإعلانات (Announcements) + البانر — من المركزي
// ═══════════════════════════════════════════════════════════════════

// [PERF-FIX-ANNOUNCEMENTS-HANG-2026-08] نفس علة [FIX-TIMEOUT-2026-07]
// اللي اتصلحت في getNotificationCenterFeed بالظبط، لكنها كانت لسه
// موجودة هنا: getActiveBanner() (بيتنادى في كل تسجيل دخول/فتح داشبورد)
// وgetNotificationCenterFeed نفسها (سطر 414 فوق) كانوا بيمرّوا من هنا
// وبيقعوا في نفس الـ UrlFetchApp الحي أول ما كاش المركزي (نص ساعة)
// ينتهي — رغم إن getNotificationCenterFeed كانت شكليًا "مُصلَّحة" (بتجيب
// hub من _getUpdatesFromHubCacheOnly في سطر فوق)، الدالة دي هنا كانت
// بتنقض الإصلاح وتعمل نداء حي تاني بنفسها. دلوقتي موحّدة: كاش فقط،
// بدون أي اتصال شبكة متزامن — المزامنة الحقيقية شغل warmCache().
function _umActiveAnnouncementsFor(displayTypes) {
  var hub = _getUpdatesFromHubCacheOnly();
  if (!hub.success) return [];
  return (hub.announcements || []).filter(function (a) {
    return displayTypes.indexOf(a.display_type) !== -1;
  });
}

/** getActiveBanner — أعلى بانر أولوية سارٍ ولم يُغلق بعد لهذا المستخدم */
function getActiveBanner(callerUser, sessionToken) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  try {
    var rows = _umActiveAnnouncementsFor(["banner"]);
    if (!rows.length) return okResponse("", { data: null });

    var reads = readSheet("AnnouncementReads", UM_ANN_READS_HEADERS, {
      trimStrings: true,
    }).filter(function (r) {
      return (
        String(r.username || "").toLowerCase() ===
          String(callerUser || "").toLowerCase() &&
        (r.status === "dismissed" || r.status === "archived")
      );
    });
    var dismissedIds = reads.map(function (r) {
      return r.announcement_id;
    });
    var candidate = rows.find(function (r) {
      return dismissedIds.indexOf(r.id) === -1;
    });
    return okResponse("", { data: candidate || null });
  } catch (e) {
    return errResponse("خطأ في جلب البانر: " + e.message);
  }
}

/** recordAnnouncementAction — تسجيل حالة قراءة/أرشفة/إغلاق إعلان لمستخدم (محلي) */
function recordAnnouncementAction(
  announcementId,
  status,
  callerUser,
  sessionToken,
) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  var allowed = ["read", "archived", "dismissed"];
  if (!announcementId || allowed.indexOf(status) === -1)
    return errResponse("بيانات غير صالحة");
  try {
    var sheet = getSheet("AnnouncementReads", UM_ANN_READS_HEADERS);
    _appendRowProtected(sheet, UM_ANN_READS_HEADERS, [
      makeId("AR"),
      announcementId,
      callerUser,
      status,
      _umNow(),
    ]);
    return okResponse("تم الحفظ");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// §41-F  مركز الإشعارات الموحّد (Notification Center Feed)
// ═══════════════════════════════════════════════════════════════════

function getNotificationCenterFeed(callerUser, sessionToken) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  try {
    // [FIX-TIMEOUT-2026-07] كانت هنا بتنادي getUpdatesFromHub() اللي لو
    // كاش المركزي (نص ساعة) منتهي بتعمل UrlFetchApp.fetch() حي ومتزامن
    // لسيرفر خارجي — لو السيرفر ده بطيء/واقع، الطلب بالكامل (وهو نداء
    // بيتكرر في الخلفية كل شوية من الفرونت) كان بيفضل معلّق ويعدي مهلة
    // الـ 25 ثانية بتاعة _gsr في الفرونت (Auth/UM console errors).
    // المزامنة الفعلية مع المركزي أصلاً بتحصل من warmCache() (trigger كل
    // 15 دقيقة)، فمركز الإشعارات مش محتاج ينتظر نت حي — بيكتفي بالكاش/آخر
    // نسخة ناجحة ويرجع فورًا.
    var hub = _getUpdatesFromHubCacheOnly();
    var versions = hub.success ? hub.versions || [] : [];
    var announcements = _umActiveAnnouncementsFor([
      "center",
      "modal",
      "banner",
    ]);

    var versionReads = readSheet(
      "UpdateVersionReads",
      UM_VERSION_READS_HEADERS,
      { trimStrings: true },
    ).filter(function (r) {
      return (
        String(r.username || "").toLowerCase() ===
        String(callerUser || "").toLowerCase()
      );
    });
    var annReads = readSheet("AnnouncementReads", UM_ANN_READS_HEADERS, {
      trimStrings: true,
    }).filter(function (r) {
      return (
        String(r.username || "").toLowerCase() ===
        String(callerUser || "").toLowerCase()
      );
    });

    var feed = [];
    versions.forEach(function (v) {
      var vReads = versionReads.filter(function (r) {
        return r.version_id === v.id;
      });
      var isArchived = vReads.some(function (r) {
        return r.action === "dismissed";
      });
      if (isArchived) return;
      var isRead = vReads.some(function (r) {
        return r.action === "seen" || r.action === "viewed_details";
      });
      feed.push({
        feed_type: "version",
        id: v.id,
        title: " " + v.title + " (v" + v.version + ")",
        desc: v.short_desc,
        date: v.published_at,
        status: isRead ? "read" : "unread",
        page: "release_notes",
      });
    });
    announcements.forEach(function (a) {
      var aReads = annReads.filter(function (r) {
        return r.announcement_id === a.id;
      });
      var isArchived = aReads.some(function (r) {
        return r.status === "archived" || r.status === "dismissed";
      });
      if (isArchived) return;
      var isRead = aReads.some(function (r) {
        return r.status === "read";
      });
      feed.push({
        feed_type: "announcement",
        id: a.id,
        title: (a.icon ? " " : "") + a.title,
        desc: a.message,
        date: a.created_at || "",
        status: isRead ? "read" : "unread",
        page: "update_notifications",
      });
    });

    feed.sort(function (a, b) {
      return new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
    });
    return okResponse("", { data: feed.slice(0, 30) });
  } catch (e) {
    return errResponse("خطأ في جلب مركز الإشعارات: " + e.message);
  }
}

/** setFeedItemStatus — تحديد عنصر في مركز الإشعارات كمقروء/مؤرشف */
function setFeedItemStatus(itemType, itemId, status, callerUser, sessionToken) {
  if (itemType === "version") {
    var action = status === "archived" ? "dismissed" : "seen";
    return recordVersionAction(itemId, action, callerUser, sessionToken);
  }
  if (itemType === "announcement") {
    return recordAnnouncementAction(itemId, status, callerUser, sessionToken);
  }
  return errResponse("نوع عنصر غير معروف");
}

// ═══════════════════════════════════════════════════════════════════
// §41-G  رقم الإصدار المعروض — مصدر واحد موحّد لكل أماكن الظهور
// ═══════════════════════════════════════════════════════════════════
//
// [FIX-VERSION-SYNC] قبل كده كان في مصدرين مختلفين للرقم بيتلخبطوا:
//   1) "رقم الإصدار" في شاشة About = APP_VERSION المحلي (بيتحدّث يدويًا
//      بس من المطوّر مع كل تسليم — لو نسي يحدّثه، الرقم بيفضل قديم).
//   2) "Build" في نفس الشاشة = بيجي من latest.build بتاع المركزي.
//   دول مفيش بينهم أي ضمان تطابق، فكان ممكن العميل يشوف "رقم الإصدار
//   v1.0.0" جنب "Build 540" مع بعض (رقمين من نسختين مختلفتين تمامًا) —
//   وده اللي كان بيحصل فعليًا. كمان الرقم في شاشة اللوجين/الداشبورد/
//   الإعدادات (appVersion المحقون من doGet) كان بيقرأ APP_VERSION
//   المحلي برضه، فمكانش بيتحدث أوتوماتيك أبدًا لو المطوّر نسي التحديث
//   اليدوي — ده هو الثغرة الحقيقية في الربط.
//
// الحل: _umDisplayVersionInfo() بقت المصدر الوحيد لكل أماكن عرض رقم
// الإصدار في الواجهة (شاشة اللوجين، الداشبورد، الإعدادات، About، عنوان
// الصفحة) — بتاخد "آخر إصدار منشور ومستهدف لهذا العميل تحديدًا" من
// كاش المركزي (نفس الكاش اللي بيتحدّث كل ping/getUpdatesFromHub، ومن
// دلوقتي كمان بيتحدث كل 15 دقيقة تلقائي من warmCache() حتى من غير أي
// لوجين — شوف Code_12_Core.gs). لو الكاش فاضي تمامًا (نشر أول مرة قبل
// أي اتصال ناجح بالمركزي)، بترجع APP_VERSION المحلي كـ fallback واضح
// (source: "local") بدل ما تفضل فاضية أو "?" في وش المستخدم.
//
// APP_VERSION المحلي (Code_42_AppVersion.gs) اتسابت زي ما هي —
// لسه بتتحدّث يدويًا وبتتبعت لـ pingUpdatesHub() عشان لوحة تحكم
// المطوّر تعرف "النسخة المثبتة فعليًا" لكل عميل (غرض تشخيصي/دعم فني
// داخلي للمطوّر بس). الفرق إنها بقت مستخدمة في مكان واحد بس (تقرير
// pingUpdatesHub) مش في أي حتة بتظهر للمستخدم النهائي.
function _umDisplayVersionInfo() {
  try {
    var hub = _getUpdatesFromHubCacheOnly();
    var latest =
      hub && hub.success && hub.versions && hub.versions[0]
        ? hub.versions[0]
        : null;
    if (latest && latest.version) {
      return {
        version: latest.version,
        build: latest.build || "—",
        release_date: latest.published_at || "",
        source: "hub",
      };
    }
  } catch (e) {
    // تجاهل وانزل على الـ fallback المحلي
  }
  return {
    version: typeof APP_VERSION !== "undefined" ? APP_VERSION : "—",
    build: "—",
    release_date: "",
    source: "local",
  };
}

// ═══════════════════════════════════════════════════════════════════
// §41-H  صفحة About
// ═══════════════════════════════════════════════════════════════════

function getAboutInfo(callerUser, sessionToken) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  try {
    var disp = _umDisplayVersionInfo();

    return okResponse("", {
      data: {
        system_name: "MOO.ERP",
        logo_url:
          typeof getCompanyLogoUrlForSplash === "function"
            ? getCompanyLogoUrlForSplash()
            : "",
        version: disp.version,
        build: disp.build,
        release_date: disp.release_date,
        // مفيدة للدعم الفني بس (مش بتتعرض حاليًا في الواجهة): تقول
        // الرقم ده جاي منين — "hub" = آخر إصدار منشور ومتزامن فعليًا،
        // "local" = fallback لحد ما أول اتصال بالمركزي ينجح.
        version_source: disp.source,
        environment:
          ScriptApp.getService().getUrl().indexOf("/exec") !== -1
            ? "Production"
            : "Development",
        developer: "MOO.ERP Development Team",
        script_url: getScriptUrl(),
      },
    });
  } catch (e) {
    return errResponse("خطأ في جلب بيانات النظام: " + e.message);
  }
}

/**
 * getAboutPageData — [FIX] الواجهة (41_JS_UpdateManagement.html) بتنادي
 * getAboutPageData(user, token) عشان تجيب بيانات صفحة "حول النظام" كاملة
 * (الهيدر + سجل الإصدارات) في نداء واحد، لكن الدالة دي ما كانتش موجودة
 * في الباك إند أصلًا — كان فيه بس getAboutInfo (بيانات الهيدر فقط) و
 * getReleaseNotes (سجل الإصدارات فقط) كل واحدة لوحدها. ده اللي كان بيسبب
 * خطأ "Cannot read properties of undefined (reading 'apply')" لأن
 * google.script.run مبيلاقيش أي دالة اسمها كده على السيرفر.
 * الدالة دي بتجمع الاتنين في شكل واحد: { about, release_notes }.
 */
function getAboutPageData(callerUser, sessionToken) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  try {
    var aboutRes = getAboutInfo(callerUser, sessionToken);
    if (!aboutRes || !aboutRes.success) {
      return aboutRes || errResponse("تعذر جلب بيانات النظام");
    }
    var rnRes = getReleaseNotes({}, callerUser, sessionToken);
    var releaseNotes = rnRes && rnRes.success ? rnRes.data : [];

    return okResponse("", {
      data: {
        about: aboutRes.data,
        release_notes: releaseNotes,
      },
    });
  } catch (e) {
    return errResponse("خطأ في جلب بيانات صفحة حول النظام: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// §41-H  تصنيفات — ثابتة محليًا (للأيقونات/الألوان في العرض فقط)
// ═══════════════════════════════════════════════════════════════════

var UM_DEFAULT_CATEGORIES = [
  {
    key: "feature",
    icon: "",
    color: "#2563eb",
    label_ar: "ميزات جديدة",
    label_en: "New Features",
  },
  {
    key: "improvement",
    icon: "",
    color: "#0891b2",
    label_ar: "تحسينات",
    label_en: "Improvements",
  },
  {
    key: "fix",
    icon: "",
    color: "#16a34a",
    label_ar: "إصلاح أخطاء",
    label_en: "Bug Fixes",
  },
  {
    key: "performance",
    icon: "",
    color: "#f59e0b",
    label_ar: "تحسين الأداء",
    label_en: "Performance",
  },
  {
    key: "security",
    icon: "",
    color: "#7c3aed",
    label_ar: "تحسينات أمنية",
    label_en: "Security",
  },
  {
    key: "breaking",
    icon: "",
    color: "#dc2626",
    label_ar: "تغييرات مهمة",
    label_en: "Breaking Changes",
  },
  {
    key: "announcement",
    icon: "",
    color: "#0ea5e9",
    label_ar: "إعلانات",
    label_en: "Announcements",
  },
  {
    key: "warning",
    icon: "",
    color: "#eab308",
    label_ar: "تنبيهات",
    label_en: "Warnings",
  },
];

function getUpdateCategories(callerUser, sessionToken) {
  var authErr = _requireSession(sessionToken);
  if (authErr) return authErr;
  // المركزي بيرجع تصنيفاته الخاصة كمان (hub.categories) لو حابب تدمجهم؛
  // افتراضيًا بنستخدم القائمة الثابتة دي كفولباك بسيط.
  return okResponse("", { data: UM_DEFAULT_CATEGORIES });
}

// ═══════════════════════════════════════════════════════════════════
// §41-I  دوال الإدارة القديمة — اتشالت نهائيًا (Fail-Fast بدل فشل صامت)
// ═══════════════════════════════════════════════════════════════════
// [MOVED-TO-HUB] إدارة الإصدارات/الإعلانات بقت حصريًا من لوحة تحكم
// المطوّر في MOO-UpdatesHub. أي نداء قديم لأي من الدوال دي من فرونت-إند
// قديم أو Trigger منسي هيرجع رسالة خطأ صريحة بدل ما يفشل بصمت.

function _umMovedToHub() {
  return errResponse(
    "هذه العملية متاحة فقط من لوحة تحكم المطوّر (MOO-UpdatesHub)",
    "MOVED_TO_HUB",
  );
}

function getVersionsAdmin() {
  return _umMovedToHub();
}
function getVersionById() {
  return _umMovedToHub();
}
function createVersion() {
  return _umMovedToHub();
}
function updateVersion() {
  return _umMovedToHub();
}
function publishVersion() {
  return _umMovedToHub();
}
function archiveVersion() {
  return _umMovedToHub();
}
function restoreVersion() {
  return _umMovedToHub();
}
function scheduleVersionPublish() {
  return _umMovedToHub();
}
function deleteVersion() {
  return _umMovedToHub();
}
function duplicateVersion() {
  return _umMovedToHub();
}
function saveUpdateCategory() {
  return _umMovedToHub();
}
function deleteUpdateCategory() {
  return _umMovedToHub();
}
function getAnnouncementsAdmin() {
  return _umMovedToHub();
}
function createAnnouncement() {
  return _umMovedToHub();
}
function updateAnnouncement() {
  return _umMovedToHub();
}
function archiveAnnouncement() {
  return _umMovedToHub();
}
function deleteAnnouncement() {
  return _umMovedToHub();
}