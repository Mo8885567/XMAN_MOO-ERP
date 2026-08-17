/**
 * ============================================================
 * Module: Code_12a_Auth_Session.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * يفحص وسائط الطلب (args) بحثًا عن توكن جلسة صالح، ويتحقق منه فعليًا
 * عبر validateSession قبل السماح بتنفيذ الدالة المطلوبة.
 *
 * Business Rules:
 * - يقبل التوكن سواء كان مُمررًا كـ string مباشر (طول >= 10) أو كخاصية
 *   داخل object (sessionToken / token / _token).
 * - يكفي وجود وسيط واحد صالح من بين كل الوسائط لاعتبار الطلب موثّقًا.
 *
 * @param {Array} args - وسائط استدعاء الدالة كما وصلت من الواجهة.
 * @returns {Boolean} true إذا وُجد توكن جلسة صالح، وإلا false.
 */
function _doPostHasValidSession(args) {
  return !!_doPostGetAuthContext(args);
}

function _doPostGetAuthContext(args) {
  args = Array.isArray(args) ? args : [];
  for (var i = 0; i < args.length; i++) {
    var candidate = args[i];
    var token = null;
    if (typeof candidate === "string" && candidate.length >= 10) {
      token = candidate;
    } else if (candidate && typeof candidate === "object") {
      token =
        candidate.sessionToken || candidate.token || candidate._token || null;
    }
    if (token) {
      try {
        var check = validateSession(token);
        if (check && check.valid) {
          return {
            token: token,
            username: check.username || "",
            role: check.role || "",
          };
        }
      } catch (e) {
        // تجاهل وتابع فحص باقي الوسائط
      }
    }
  }
  return null;
}

/**
 * _loadUsersCache — يقرأ مصفوفة المستخدمين الخام من CacheEngine
 * يرجع null لو الكاش فارغ أو منتهي
 */
function _loadUsersCache() {
  try {
    return CacheEngine.get(CacheEngine.NAMESPACE.USERS, USERS_CACHE_KEY);
  } catch (e) {
    return null;
  }
}

/**
 * _saveUsersCache — يحفظ مصفوفة المستخدمين الخام عبر CacheEngine
 * @param {Array} users - المصفوفة الخام كما تُقرأ من readSheet("Users")
 */
function _saveUsersCache(users) {
  try {
    CacheEngine.set(
      CacheEngine.NAMESPACE.USERS,
      USERS_CACHE_KEY,
      users,
      USERS_CACHE_TTL,
    );
  } catch (e) {
    console.error("_saveUsersCache - خطأ:", e.message || e);
  }
}

/**
 * _invalidateUsersCache — يمسح كاش Users فوراً
 * يُستدعى بعد أي تعديل على شيت Users (addUser / updateUser / deleteUser / resetPassword)
 */
function _invalidateUsersCache() {
  try {
    CacheEngine.invalidateMany(CacheEngine.NAMESPACE.USERS, [
      USERS_CACHE_KEY,
      USERS_CACHE_FLAG_KEY,
    ]);
  } catch (e) {
    console.error("_invalidateUsersCache - خطأ:", e.message || e);
  }
}

/**
 * _getSheetUsers — يقرأ المستخدمين من الكاش أو من الشيت مباشرة
 * الدالة الوحيدة التي يجب استخدامها لقراءة Users في دوال الـ Auth
 * @param {boolean} [skipCache] - لو true يتجاهل الكاش ويقرأ من الشيت مباشرة
 * @returns {Array} مصفوفة المستخدمين الخام (تحتوي password)
 */
function _getSheetUsers(skipCache) {
  if (!skipCache) {
    var cached = _loadUsersCache();
    if (cached) return cached;
  }
  var users = getSheetData("Users");
  _saveUsersCache(users);
  return users;
}

/**
 * ✅ [FIX-1] تشفير كلمة المرور بـ SHA-256
 * يُستخدم عند الحفظ والمقارنة — لا تُخزَّن كلمات المرور كنص صريح بعد الآن.
 * الباسوردات القديمة (غير مشفرة) تبدأ بدون البادئة "sha256:" — يتم ترقيتها
 * تلقائياً عند أول تسجيل دخول ناجح.
 * [SEC-FIX-8] v4.2: ترقية للتشفير مع salt عشوائي لمنع Rainbow Table attacks
 * الصيغة الجديدة: "sha256s:<salt>:<hash>" حيث salt=16 حرف عشوائي
 */
function _generateSalt() {
  var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var salt = "";
  for (var i = 0; i < 16; i++) {
    salt += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return salt;
}

/**
 * يُشفّر كلمة مرور نصية باستخدام SHA-256 مع Salt عشوائي (SEC-FIX-8) لمنع
 * هجمات Rainbow Table.
 *
 * @param {String} plain - كلمة المرور الصريحة.
 * @param {String} [salt] - Salt موجود مسبقًا (يُمرَّر عند التحقق من كلمة
 *   مرور مخزَّنة)؛ إن لم يُمرَّر يُولَّد Salt جديد (عند إنشاء/تحديث كلمة مرور).
 * @returns {String} القيمة المخزَّنة بصيغة "sha256s:<salt>:<hash>".
 */
function _hashPassword(plain, salt) {
  // [SEC-FIX-8] إذا أُعطي salt → استخدمه (تحقق)، وإلا → أنشئ جديداً (تسجيل)
  var useSalt = salt || _generateSalt();
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    useSalt + String(plain),
    Utilities.Charset.UTF_8,
  );
  var hash = bytes
    .map(function (b) {
      return ("0" + (b & 0xff).toString(16)).slice(-2);
    })
    .join("");
  return "sha256s:" + useSalt + ":" + hash;
}

function _hashPasswordLegacy(plain) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(plain),
    Utilities.Charset.UTF_8,
  );
  return (
    "sha256:" +
    bytes
      .map(function (b) {
        return ("0" + (b & 0xff).toString(16)).slice(-2);
      })
      .join("")
  );
}

/**
 * ✅ [FIX-1 + SEC-FIX-8] مقارنة كلمة المرور — تدعم ثلاث حالات:
 * 1. sha256s:<salt>:<hash> → الصيغة الجديدة مع salt (آمنة)
 * 2. sha256:<hash>         → الصيغة القديمة بدون salt (تُرقَّى تلقائياً)
 * 3. plain text            → قديم جداً (تُرقَّى تلقائياً)
 * ترجع: { ok: bool, needsUpgrade: bool }
 */
function _checkPassword(inputPlain, storedValue) {
  var stored = String(storedValue || "");
  if (stored.startsWith("sha256s:")) {
    // صيغة جديدة مع salt
    var parts = stored.split(":");
    if (parts.length !== 3) return { ok: false, needsUpgrade: false };
    var salt = parts[1];
    return {
      ok: _hashPassword(inputPlain, salt) === stored,
      needsUpgrade: false,
    };
  }
  if (stored.startsWith("sha256:")) {
    // صيغة قديمة بدون salt — تُرقَّى
    return {
      ok: _hashPasswordLegacy(inputPlain) === stored,
      needsUpgrade: true, // يجب الترقية لـ sha256s عند أول تسجيل دخول
    };
  }
  // plain text قديم جداً — تُرقَّى
  return { ok: stored === String(inputPlain), needsUpgrade: true };
}

/**
 * ✅ دالة موحّدة للتحقق من أن المستخدم نشط
 * تُغني عن تكرار: user.active === true || String(user.active).toUpperCase() === "TRUE"
 */
function _isActiveUser(active) {
  return active === true || String(active).toUpperCase() === "TRUE";
}

/**
 * ✅ [FORCE-PW-1] دالة موحّدة للتحقق من علامة إجبار تغيير كلمة المرور
 * تُغني عن تكرار: force_password_change === true || String(...).toUpperCase() === "TRUE"
 */
function _isForceChange(flag) {
  return flag === true || String(flag).toUpperCase() === "TRUE";
}

/**
 * _getRateLimitKey — مفتاح ثابت بدون تاريخ (v4.2)
 *
 * ⚠️ الإصلاح: حُذف التاريخ اليومي من المفتاح.
 * الكود القديم كان يُغيّر المفتاح عند منتصف الليل،
 * مما كان يكسر القفل تلقائياً يومياً.
 * الإصلاح: مفتاح ثابت "rl_username" — انتهاء القفل
 * يُحسب من locked_until (timestamp مطلق) داخل الـ JSON.
 */
function _getRateLimitKey(username) {
  return (
    "rl_" +
    String(username)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
  );
}

/**
 * _checkRateLimit — تحقق هل المستخدم محظور حالياً؟ (v4.2)
 *
 * @returns {null|{blocked:true, remainingSeconds:number, remainingMinutes:number}}
 */
function _checkRateLimit(username) {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(_getRateLimitKey(username));
    if (!raw) return null;
    var rec = JSON.parse(raw);
    var now = Date.now();

    // ── هل القفل نشط؟ (locked_until = timestamp مطلق) ──────
    if (rec.locked_until) {
      if (now < rec.locked_until) {
        var remainingMs = rec.locked_until - now;
        return {
          blocked: true,
          remainingSeconds: Math.ceil(remainingMs / 1000),
          remainingMinutes: Math.ceil(remainingMs / 60000),
        };
      }
      // انتهى القفل → امسح السجل كاملاً
      props.deleteProperty(_getRateLimitKey(username));
      return null;
    }

    // ── انتهت نافذة العداد بدون قفل → امسح ─────────────────
    if (
      rec.window_start &&
      now - rec.window_start > RATE_LIMIT.WINDOW_MINUTES * 60 * 1000
    ) {
      props.deleteProperty(_getRateLimitKey(username));
      return null;
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * _recordFailedAttempt — سجّل محاولة فاشلة وأعد الحالة (v4.2)
 *
 * @returns {{attempts, locked, lockedUntil, remainingAttempts}}
 */
function _recordFailedAttempt(username) {
  try {
    var key = _getRateLimitKey(username);
    var props = PropertiesService.getScriptProperties();
    var now = Date.now();
    var rec = { attempts: 0, window_start: now, locked_until: null };
    try {
      var raw = props.getProperty(key);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (now - parsed.window_start < RATE_LIMIT.WINDOW_MINUTES * 60 * 1000)
          rec = parsed;
      }
    } catch (e) {
      console.error("_recordFailedAttempt - خطأ:", e.message || e);
    }
    rec.attempts++;
    rec.last_attempt = now;
    // عند الوصول للحد → احسب locked_until كـ timestamp مطلق
    if (rec.attempts >= RATE_LIMIT.MAX_ATTEMPTS) {
      rec.locked_until = now + RATE_LIMIT.LOCK_MINUTES * 60 * 1000;
    }
    props.setProperty(key, JSON.stringify(rec));
    return {
      attempts: rec.attempts,
      locked: !!rec.locked_until,
      lockedUntil: rec.locked_until || null,
      remainingAttempts: Math.max(0, RATE_LIMIT.MAX_ATTEMPTS - rec.attempts),
    };
  } catch (e) {
    return {
      attempts: 0,
      locked: false,
      lockedUntil: null,
      remainingAttempts: RATE_LIMIT.MAX_ATTEMPTS,
    };
  }
}

/**
 * يمسح سجل محاولات تسجيل الدخول الفاشلة لمستخدم معيّن (يُستدعى بعد
 * تسجيل دخول ناجح لإعادة عدّاد المحاولات للصفر).
 * @param {String} username - اسم المستخدم.
 */
function _clearRateLimit(username) {
  try {
    PropertiesService.getScriptProperties().deleteProperty(
      _getRateLimitKey(username),
    );
  } catch (e) {
    console.error("_clearRateLimit - خطأ:", e.message || e);
  }
}

/**
 * _buildAttemptsHint — صياغة عربية صحيحة للمحاولات المتبقية
 */
function _buildAttemptsHint(attempt) {
  var rem = attempt.remainingAttempts;
  if (rem <= 0) return "";
  var text = "";
  if (rem === 1) text = "تبقَّت محاولة واحدة";
  else if (rem === 2) text = "تبقَّت محاولتان";
  else text = "تبقَّت " + rem + " محاولات";
  return " (" + text + " قبل تأمين الحساب)";
}

/**
 * migrateRateLimitKeys — هجرة المفاتيح القديمة (v4.2)
 * شغّلها مرة واحدة من Apps Script Editor بعد النشر
 * لحذف مفاتيح rate_* القديمة التي تحتوي على التاريخ
 */
function migrateRateLimitKeys() {
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    var deleted = 0;
    Object.keys(all).forEach(function (k) {
      if (k.indexOf("rate_") === 0) {
        props.deleteProperty(k);
        deleted++;
      }
    });
    Logger.log("✅ حُذفت " + deleted + " مفاتيح rate_limit قديمة");
    return "✅ تم حذف " + deleted + " مفتاح قديم";
  } catch (e) {
    return "❌ خطأ: " + e.message;
  }
}

/**
 * يولّد توكن جلسة عشوائي وآمن (64 حرف) بدمج اثنين من UUID v4.
 * @returns {String} توكن الجلسة.
 */
function _generateSessionToken() {
  // UUID v4 آمن cryptographically من Google
  var uuid1 = Utilities.getUuid().replace(/-/g, "");
  var uuid2 = Utilities.getUuid().replace(/-/g, "");
  return uuid1 + uuid2; // 64 حرف
}

/**
 * ينشئ جلسة جديدة لمستخدم بعد نجاح تسجيل الدخول، ويخزّنها في
 * PropertiesService بمفتاح "sess_<token>".
 *
 * Business Rules:
 * - الجلسة تنتهي تلقائيًا بعد SESSION_CONFIG.TIMEOUT_HOURS ساعة من
 *   الإنشاء، أو بعد SESSION_CONFIG.IDLE_TIMEOUT_MINUTES دقيقة من عدم
 *   النشاط، أيهما أقرب.
 * - عند إنشاء جلسة جديدة، تُحذف أقدم الجلسات الزائدة عن الحد الأقصى
 *   (SESSION_CONFIG.MAX_SESSIONS_PER_USER) لنفس المستخدم عبر
 *   _cleanUserSessions.
 *
 * @param {String} username - اسم المستخدم.
 * @param {String} [role] - دور المستخدم (افتراضي "viewer").
 * @param {Number} [idleMinutesOverride] - [PREFS-WIRING] مدة خمول مخصصة
 *   بالدقائق (من تفضيلات المستخدم session_timeout)، تحل محل الثابت العام
 *   SESSION_CONFIG.IDLE_TIMEOUT_MINUTES لهذه الجلسة فقط. تُقيَّد بين
 *   5 و 480 دقيقة لمنع قيمة خاطئة (0 أو رقم ضخم) من تعطيل الجلسة.
 * @returns {{success: Boolean, token: String=, expiresAt: Number=, idleTimeout: Number=, message: String=}}
 */
function createSession(username, role, idleMinutesOverride) {
  try {
    var token = _generateSessionToken();
    var now = Date.now();
    var idleMinutes = SESSION_CONFIG.IDLE_TIMEOUT_MINUTES;
    if (idleMinutesOverride != null) {
      var n = parseInt(idleMinutesOverride, 10);
      if (!isNaN(n)) idleMinutes = Math.max(5, Math.min(480, n));
    }
    var expiresAt = now + SESSION_CONFIG.TIMEOUT_HOURS * 3600 * 1000;
    var idleExp = now + idleMinutes * 60 * 1000;
    var sessionData = {
      username: username,
      role: role || "viewer",
      token: token,
      created_at: now,
      expires_at: expiresAt,
      idle_expires_at: idleExp,
      idle_timeout_minutes: idleMinutes, // [PREFS-WIRING] يُستخدم في validateSession لتجديد المهلة بنفس القيمة
      last_activity: now,
    };
    var props = PropertiesService.getScriptProperties();
    props.setProperty("sess_" + token, JSON.stringify(sessionData));
    _cleanUserSessions(username, token, props);
    return {
      success: true,
      token: token,
      expiresAt: expiresAt,
      idleTimeout: idleMinutes,
    };
  } catch (e) {
    console.error("_createSession error:", e.message);
    return { success: false, message: "خطأ في إنشاء الجلسة — حاول مرة أخرى" };
  }
}

/**
 * يتحقق من صلاحية توكن جلسة معيّن، ويجدّد مهلة الخمول (idle timeout)
 * تلقائيًا عند كل استدعاء ناجح (Sliding Session).
 *
 * Edge Cases:
 * - جلسة منتهية بالكامل (expires_at) أو منتهية بالخمول
 *   (idle_expires_at) تُحذف فورًا من التخزين وتُعتبر غير صالحة.
 *
 * @param {String} token - توكن الجلسة.
 * @returns {{valid: Boolean, username: String=, role: String=, reason: String=}}
 */
function validateSession(token) {
  if (!token) return { valid: false, reason: "لا يوجد توكن" };
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty("sess_" + token);
    if (!raw) return { valid: false, reason: "الجلسة غير موجودة أو منتهية" };
    var sess = JSON.parse(raw);
    var now = Date.now();
    if (now > sess.expires_at) {
      props.deleteProperty("sess_" + token);
      return {
        valid: false,
        reason: "انتهت صلاحية الجلسة — يرجى تسجيل الدخول مجدداً",
      };
    }
    if (now > sess.idle_expires_at) {
      props.deleteProperty("sess_" + token);
      return {
        valid: false,
        reason: "انتهت الجلسة بسبب عدم النشاط — يرجى تسجيل الدخول مجدداً",
      };
    }
    // [PREFS-WIRING] استخدم idle_timeout_minutes المحفوظ في الجلسة نفسها
    // (لو موجود، من تفضيلات المستخدم وقت اللوجين) بدل الثابت العام دايمًا،
    // عشان تمديد الجلسة يفضل متسق مع القيمة اللي المستخدم اختارها.
    var sessIdleMin =
      sess.idle_timeout_minutes || SESSION_CONFIG.IDLE_TIMEOUT_MINUTES;
    // [FIX-ROOT-SLOWDOWN] كانت الدالة دي بتعمل props.setProperty (كتابة
    // فعلية) في كل استدعاء — أي طلب محمي في النظام كله (حتى القراءة
    // البسيطة زي جلب إشعار أو عنوان عميل) بيمر من هنا. الكتابة في
    // PropertiesService أبطأ نسبيًا من القراءة وبتتزاحم لما يوصل أكتر من
    // طلب في نفس اللحظة (الحالة الطبيعية عند فتح أي صفحة: إشعارات +
    // مستندات + عناوين + تحديث صامت كلهم بيتبعتوا مع بعض) — فبيحصل تكدّس
    // فعلي بيوصّل بعض الطلبات لحد المهلة (25 ثانية) في الواجهة، واللي
    // بيظهر بعد كده كـ"جلسة غير صالحة" رغم إن الجلسة سليمة فعليًا.
    // الحل: منكتبش تاني إلا لو فعلاً فات وقت معتبر (15 ثانية) من آخر
    // كتابة — فرق تافه جدًا بالنسبة لمهلة خمول بالدقايق، لكنه بيقلل حجم
    // الكتابة على PropertiesService بشكل كبير جدًا في الاستخدام العادي.
    var _lastWrite = sess.last_activity || 0;
    if (now - _lastWrite > 15000) {
      sess.last_activity = now;
      sess.idle_expires_at = now + sessIdleMin * 60 * 1000;
      props.setProperty("sess_" + token, JSON.stringify(sess));
    }
    return { valid: true, username: sess.username, role: sess.role };
  } catch (e) {
    return { valid: false, reason: "خطأ في التحقق من الجلسة" };
  }
}

/**
 * يتحقق من صلاحية التوكن — يُستدعى في بداية كل دالة حساسة
 * الاستخدام: var authErr = _requireSession(token); if (authErr) return authErr;
 */
function _requireSession(token) {
  if (!token) return errResponse("⛔ غير مصرح — يرجى تسجيل الدخول");
  var check = validateSession(token);
  if (!check.valid) return errResponse("⛔ " + check.reason);
  return null; // null = مسموح
}

/**
 * يحذف جلسة معيّنة نهائيًا من التخزين (تسجيل خروج فوري وغير قابل
 * للاسترجاع لهذا التوكن تحديدًا).
 * @param {String} token - توكن الجلسة المطلوب إنهاؤها.
 */
function destroySession(token) {
  if (!token) return;
  try {
    PropertiesService.getScriptProperties().deleteProperty("sess_" + token);
  } catch (e) {
    console.error("destroySession - خطأ:", e.message || e);
  }
}

/**
 * تُستدعى دوريًا من الواجهة (heartbeat) للتأكد من استمرار صلاحية
 * الجلسة وتحديث مهلة الخمول؛ غلاف مبسّط فوق validateSession.
 * @param {String} token - توكن الجلسة.
 * @returns {{valid: Boolean, username: String=, reason: String=}}
 */
function refreshSession(token) {
  var result = validateSession(token);
  return result.valid
    ? { valid: true, username: result.username }
    : { valid: false, reason: result.reason };
}

/**
 * ينفّذ تسجيل الخروج: يحذف الجلسة ويسجّل حدث LOGOUT في سجل التدقيق.
 * @param {String} token - توكن الجلسة الحالية.
 * @param {String} [username] - اسم المستخدم (لتسجيله في Audit Log).
 * @returns {{success: Boolean, message: String=}}
 */
function logout(token, username) {
  try {
    if (token) destroySession(token);
    if (username)
      _writeAuditLog({
        user: username,
        action: "LOGOUT",
        table: "Users",
        record_id: username,
        details: "تسجيل خروج",
      });
    return okResponse("تم تسجيل الخروج بنجاح");
  } catch (e) {
    return { success: true };
  }
}

/**
 * يفرض الحد الأقصى لعدد الجلسات المتزامنة لكل مستخدم
 * (SESSION_CONFIG.MAX_SESSIONS_PER_USER) بحذف أقدم الجلسات الزائدة،
 * مع الحرص على عدم حذف الجلسة الحالية التي أنشأها المستخدم للتو.
 *
 * @param {String} username - اسم المستخدم.
 * @param {String} currentToken - توكن الجلسة الجديدة التي يجب استثناؤها من الحذف.
 * @param {Properties} props - كائن PropertiesService.getScriptProperties() جاهز.
 */
function _cleanUserSessions(username, currentToken, props) {
  try {
    var allProps = props.getProperties();
    var userSessions = [];
    Object.keys(allProps).forEach(function (k) {
      if (k.indexOf("sess_") !== 0) return;
      try {
        var s = JSON.parse(allProps[k]);
        if (s.username === username)
          userSessions.push({
            key: k,
            created_at: s.created_at,
            token: s.token,
          });
      } catch (e) {
        console.error("_cleanUserSessions - خطأ:", e.message || e);
      }
    });
    userSessions.sort(function (a, b) {
      return a.created_at - b.created_at;
    });
    var toDelete = userSessions.length - SESSION_CONFIG.MAX_SESSIONS_PER_USER;
    for (var i = 0; i < toDelete; i++) {
      if (userSessions[i].token !== currentToken)
        props.deleteProperty(userSessions[i].key);
    }
  } catch (e) {
    console.error("_cleanUserSessions - خطأ:", e.message || e);
  }
}

/**
 * يمسح جميع الجلسات المنتهية (بالوقت الكلي أو بالخمول) من التخزين.
 * تُستدعى دوريًا عبر Trigger مجدول (انظر setupSessionCleanupTrigger)
 * لمنع تراكم مفاتيح "sess_*" غير المستخدمة في PropertiesService.
 * @returns {{success: Boolean, message: String}}
 */
function cleanExpiredSessions() {
  try {
    var props = PropertiesService.getScriptProperties();
    var allProps = props.getProperties();
    var now = Date.now();
    var cleaned = 0;
    Object.keys(allProps).forEach(function (k) {
      if (k.indexOf("sess_") !== 0) return;
      try {
        var s = JSON.parse(allProps[k]);
        if (now > s.expires_at || now > s.idle_expires_at) {
          props.deleteProperty(k);
          cleaned++;
        }
      } catch (e) {
        props.deleteProperty(k);
      }
    });
    return {
      success: true,
      message: "✅ تم تنظيف " + cleaned + " جلسة منتهية",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * يُنشئ (أو يُعيد إنشاء) Trigger مجدول يُشغّل cleanExpiredSessions كل
 * 6 ساعات تلقائيًا. يُشغَّل يدويًا مرة واحدة من محرر Apps Script بعد
 * النشر الأول أو بعد أي تحديث لمنطق التنظيف.
 *
 * NOTE: يحذف أي Trigger سابق لنفس الدالة أولًا لمنع تكرار التشغيل.
 *
 * @returns {{success: Boolean, message: String}}
 */
function setupSessionCleanupTrigger(existingTriggers) {
  try {
    // ✅ [PERF-TRIGGERS-1] لو setupEverything بعتلنا القايمة جاهزة، نستخدمها
    // بدل ما نعمل round-trip جديد لـ ScriptApp.getProjectTriggers() (كل
    // نداء منها بياخد ثانية+ لوحده — 6 دوال زي دي كانت بتكررها 6 مرات).
    (existingTriggers || ScriptApp.getProjectTriggers()).forEach(function (t) {
      if (t.getHandlerFunction() === "cleanExpiredSessions")
        ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger("cleanExpiredSessions")
      .timeBased()
      .everyHours(6)
      .create();
    return { success: true, message: "✅ تم إعداد تنظيف الجلسات كل 6 ساعات" };
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * يتحقق من قوة كلمة مرور جديدة وفق PASSWORD_POLICY (الطول الأدنى،
 * وجود رقم/حرف كبير/رمز خاص)، ويرفض قائمة كلمات مرور شائعة معروفة.
 *
 * @param {String} password - كلمة المرور الجديدة (نص صريح).
 * @returns {String|null} رسالة الخطأ الأولى المكتشفة، أو null لو
 *   كلمة المرور مستوفية للسياسة.
 */
function _validatePasswordStrength(password) {
  if (!password || password.length < PASSWORD_POLICY.MIN_LENGTH)
    return (
      "كلمة المرور يجب أن تكون " +
      PASSWORD_POLICY.MIN_LENGTH +
      " أحرف على الأقل"
    );
  if (PASSWORD_POLICY.REQUIRE_NUMBER && !/\d/.test(password))
    return "كلمة المرور يجب أن تحتوي على رقم واحد على الأقل";
  // [SEC-FIX-9] إضافة شرط الحرف الكبير والرمز الخاص
  if (PASSWORD_POLICY.REQUIRE_UPPER && !/[A-Z]/.test(password))
    return "كلمة المرور يجب أن تحتوي على حرف كبير (A-Z) واحد على الأقل";
  if (PASSWORD_POLICY.REQUIRE_LOWER && !/[a-z]/.test(password))
    return "كلمة المرور يجب أن تحتوي على حرف صغير (a-z) واحد على الأقل";
  if (
    PASSWORD_POLICY.REQUIRE_SPECIAL &&
    !/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password)
  )
    return "كلمة المرور يجب أن تحتوي على رمز خاص (!@#$%^&*...) واحد على الأقل";
  var BANNED = [
    "password",
    "Password1!",
    "123456",
    "admin123",
    "Admin123!",
    "12345678",
    "qwerty",
    "abc123",
    "Aa123456!",
  ];
  if (
    BANNED.indexOf(password) !== -1 ||
    BANNED.indexOf(password.toLowerCase()) !== -1
  )
    return "كلمة المرور ضعيفة جداً — اختر كلمة مرور أقوى";
  return null;
}

/**
 * _notifyAdminLoginBlock — v4.1: إرسال إيميل تنبيه للأدمين عند حظر حساب
 * يُستدعى تلقائياً من login() عند attempt.locked === true
 */
function _notifyAdminLoginBlock(lockedUsername, attemptsCount) {
  var now = Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd HH:mm:ss");
  var settings = {};
  try {
    settings = _getCompanySettingsRaw() || {};
  } catch (e) {
    console.error(
      "_notifyAdminLoginBlock - خطأ قراءة الإعدادات:",
      e.message || e,
    );
  }

  // ── (1) تنبيه بالإيميل — كما كان ────────────────────────────
  try {
    var adminEmail = settings.admin_alert_email || settings.company_email || "";
    if (!adminEmail) {
      // ✅ [PRIMARY-ADMIN-FLAG] بعد السماح بتغيير اسم المستخدم، البحث
      // بالاسم الحرفي "admin" لم يعد موثوقًا — نستخدم نفس فحص isMainAdmin
      // الموحّد (العلامة الثابتة، مع fallback للبيانات القديمة).
      var adminUser = readSheet("Users").find(function (u) {
        return (
          BusinessRulesEngine.rules.User.isMainAdmin(u.username) && u.email
        );
      });
      adminEmail = adminUser ? adminUser.email : "";
    }
    if (adminEmail) {
      MailApp.sendEmail({
        to: adminEmail,
        subject: "🔒 تنبيه أمني — حظر حساب بسبب محاولات دخول متكررة",
        body: [
          "تم حظر حساب مؤقتاً في MOO.ERP",
          "",
          "الحساب المحظور: " + lockedUsername,
          "عدد المحاولات الفاشلة: " + attemptsCount,
          "وقت الحظر: " + now,
          "مدة الحظر: " + (RATE_LIMIT.LOCK_MINUTES || 15) + " دقيقة",
          "",
          "إذا لم تكن أنت من حاول تسجيل الدخول، يُرجى مراجعة سجل العمليات فوراً.",
          "",
          "— MOO.ERP",
        ].join("\n"),
      });
    }
  } catch (e) {
    console.warn("_notifyAdminLoginBlock - فشل الإيميل:", e.message);
  }

  // ── (2) [SEC-WA-ALERT] تنبيه واتساب إضافي — لو فيه رقم أدمن مُعدّ
  // وقناة الواتساب (WhatsApp Communication Hub) شغّالة أصلاً. بيفشل
  // بصمت زي الإيميل بالظبط لو مفيش رقم أو القناة مش مُعدّة، فمفيش أي
  // كسر لتدفق تسجيل الدخول في كل الأحوال.
  try {
    var adminPhone = settings.admin_alert_phone || "";
    if (adminPhone) {
      var waText = [
        "🔒 تنبيه أمني — MOO.ERP",
        "تم حظر الحساب: " + lockedUsername,
        "عدد المحاولات الفاشلة: " + attemptsCount,
        "وقت الحظر: " + now,
        "مدة الحظر: " + (RATE_LIMIT.LOCK_MINUTES || 15) + " دقيقة",
        "لو مش أنت، راجع سجل العمليات فوراً.",
      ].join("\n");
      _sendSystemWhatsAppAlert(adminPhone, waText);
    }
  } catch (e) {
    console.warn("_notifyAdminLoginBlock - فشل تنبيه الواتساب:", e.message);
  }
}

/**
 * ينفّذ تسجيل الدخول: يتحقق من اسم المستخدم/كلمة المرور، يفرض
 * Rate Limiting على المحاولات الفاشلة، وينشئ جلسة عند النجاح.
 *
 * Workflow:
 * 1. فحص Rate Limit (_checkRateLimit) — رفض فوري لو الحساب محظور مؤقتًا.
 * 2. البحث عن المستخدم والتحقق من كلمة المرور (_checkPassword)، مع
 *    ترقية تلقائية لتشفير كلمات المرور القديمة (بدون salt) عند النجاح.
 * 3. عند الفشل: تسجيل المحاولة (_recordFailedAttempt)؛ لو وصل الحساب
 *    لحد الحظر يُرسل تنبيه بريدي للأدمن (_notifyAdminLoginBlock).
 * 4. عند النجاح: مسح Rate Limit، إنشاء جلسة جديدة (createSession)،
 *   وكتابة حدث LOGIN في سجل التدقيق.
 *
 * Business Rules:
 * - الحساب غير النشط (active=false) يُرفض حتى لو كانت بياناته صحيحة.
 *
 * @param {String} username - اسم المستخدم.
 * @param {String} password - كلمة المرور الصريحة كما أدخلها المستخدم.
 * @returns {Object} استجابة تحتوي success وبيانات الجلسة عند النجاح،
 *   أو success:false ورسالة الخطأ (بما فيها تلميح المحاولات المتبقية).
 */
function login(username, password) {
  try {
    if (!username || !password) return errResponse("يرجى إدخال جميع البيانات");

    var trimmedUser = String(username).trim().toLowerCase();

    // ── [SEC-1] Rate Limiting — Backend يفرض القفل (v4.2) ───
    var rateCheck = _checkRateLimit(trimmedUser);
    if (rateCheck && rateCheck.blocked) {
      _writeAuditLog({
        user: trimmedUser,
        action: "LOGIN_BLOCKED",
        table: "Users",
        record_id: trimmedUser,
        details: "محظور — متبقي " + rateCheck.remainingMinutes + " دقيقة",
      });
      // يُعاد lockedUntil كـ timestamp مطلق للفرونت
      return {
        success: false,
        message:
          "🔒 الحساب مقفل مؤقتاً بسبب محاولات دخول متكررة — يرجى الانتظار " +
          rateCheck.remainingMinutes +
          " دقيقة",
        locked: true,
        lockedUntil: Date.now() + rateCheck.remainingSeconds * 1000,
        remainingSeconds: rateCheck.remainingSeconds,
      };
    }

    // ── [LICENSE-STATUS] إنفاذ Backend لانتهاء الصلاحية ──────
    // بيقرأ من الكاش فقط (بدون أي اتصال شبكة متزامن يبطّئ اللوجين —
    // warmCache() بيحدّثه كل 15 دقيقة تلقائيًا، راجع Code_41_
    // UpdateManagement.js). لو مفيش أي حالة مخزّنة خالص (نشر أول مرة،
    // أو المركزي مقطوع من الأول)، بنسيب الدخول عادي (Fail-Open) عشان
    // المركزي ميبقاش نقطة فشل وحيدة توقف شغل الشركة اليومي — الإنفاذ
    // بيتطبق بس لما عندنا معرفة أكيدة إن الاشتراك منتهي/موقوف فعليًا.
    var _license =
      typeof _getLicenseStatusCacheOnly === "function"
        ? _getLicenseStatusCacheOnly()
        : null;
    if (_license && _license.status === "EXPIRED" && !_license.graceActive) {
      _writeAuditLog({
        user: trimmedUser,
        action: "LOGIN_BLOCKED_LICENSE_EXPIRED",
        table: "Users",
        record_id: trimmedUser,
        details: "محاولة دخول مرفوضة — انتهت صلاحية الاشتراك",
      });
      return {
        success: false,
        message:
          _license.message ||
          "انتهت صلاحية استخدام النظام. يرجى التواصل مع مسؤول النظام لتجديد الصلاحية.",
        code: "LICENSE_EXPIRED",
      };
    }
    if (_license && _license.status === "SUSPENDED") {
      _writeAuditLog({
        user: trimmedUser,
        action: "LOGIN_BLOCKED_LICENSE_SUSPENDED",
        table: "Users",
        record_id: trimmedUser,
        details: "محاولة دخول مرفوضة — الاشتراك موقوف",
      });
      return {
        success: false,
        message:
          _license.message ||
          "تم إيقاف هذا الاشتراك مؤقتًا. يرجى التواصل مع مسؤول النظام.",
        code: "LICENSE_SUSPENDED",
      };
    }

    // ✅ [PERF-LOGIN-3] ensureDefaultUsers بيستخدم الكاش الآن — بدون I/O لو الـ flag موجود
    ensureDefaultUsers();

    // ✅ [PERF-LOGIN-4] اقرأ Users من الكاش — تجنّب round-trip إضافي للشيت
    const users = _getSheetUsers();
    const user = users.find(
      (u) =>
        String(u.username || "")
          .trim()
          .toLowerCase() === trimmedUser,
    );

    if (!user) {
      var attempt = _recordFailedAttempt(trimmedUser);
      var hint = _buildAttemptsHint(attempt);
      return {
        success: false,
        message: "اسم المستخدم أو كلمة المرور غير صحيحة" + hint,
        locked: attempt.locked,
        lockedUntil: attempt.lockedUntil,
        remainingAttempts: attempt.remainingAttempts,
      };
    }
    if (!_isActiveUser(user.active))
      return errResponse("هذا الحساب موقوف — تواصل مع المدير");

    var pwCheck = _checkPassword(password, String(user.password || ""));
    if (!pwCheck.ok) {
      var attempt = _recordFailedAttempt(trimmedUser);
      _writeAuditLog({
        user: trimmedUser,
        action: "LOGIN_FAILED",
        table: "Users",
        record_id: trimmedUser,
        details:
          "محاولة فاشلة #" +
          attempt.attempts +
          (attempt.locked
            ? " — تم الحظر!"
            : " — متبقي " + attempt.remainingAttempts),
      });
      // ← v4.2: إرسال إيميل + إعادة lockedUntil للفرونت
      if (attempt.locked) {
        _notifyAdminLoginBlock(trimmedUser, attempt.attempts);
        return {
          success: false,
          message:
            "🔒 تم تعطيل الحساب مؤقتاً لمدة " +
            RATE_LIMIT.LOCK_MINUTES +
            " دقيقة بسبب تجاوز عدد المحاولات المسموحة",
          locked: true,
          lockedUntil: attempt.lockedUntil,
          remainingSeconds: RATE_LIMIT.LOCK_MINUTES * 60,
        };
      }
      var hint = _buildAttemptsHint(attempt);
      return {
        success: false,
        message: "اسم المستخدم أو كلمة المرور غير صحيحة" + hint,
        locked: false,
        remainingAttempts: attempt.remainingAttempts,
      };
    }

    // ── دخول ناجح ────────────────────────────────────────────
    _clearRateLimit(trimmedUser);
    const sheet = getSheet("Users");

    // ✅ [PERF-LOGIN-5] كتابة last_login وترقية الباسورد في batch واحد
    // بدلاً من setRange منفصلة لكل منهما — يوفّر round-trip واحد عند الترقية
    if (pwCheck.needsUpgrade) {
      // باسورد قديم → رقّيه وحدّث last_login في نفس العملية
      sheet.getRange(user._row, 2, 1, 5).setValues([
        [
          _hashPassword(password), // عمود 2: password
          user.role, // عمود 3: role (بدون تغيير)
          user.full_name, // عمود 4: full_name (بدون تغيير)
          user.active, // عمود 5: active (بدون تغيير)
          new Date(), // عمود 6: last_login
        ],
      ]);
      // مسح الكاش لأن الباسورد تغيّر
      _invalidateUsersCache();
    } else {
      // باسورد حديث → فقط حدّث last_login (كتابة واحدة)
      sheet.getRange(user._row, 6).setValue(new Date());
    }

    // ── [SEC-2] إنشاء Session Token ──────────────────────────
    // [PREFS-WIRING] نقرأ تفضيل session_timeout الخاص بالمستخدم (لو موجود)
    // ونمرره كـ override بدل الاعتماد على الثابت العام فقط. أي خطأ هنا
    // (شيت مش موجود، مستخدم جديد بدون تفضيلات...) لازم ما يوقفش اللوجين،
    // فبنسيبها تفشل بصمت وتستخدم الافتراضي العام.
    var _userIdleMinutes = null;
    try {
      var _prefs = _readUserPrefsRaw(user.username);
      if (_prefs && _prefs.session_timeout) {
        _userIdleMinutes = _prefs.session_timeout;
      }
    } catch (e) {}
    var sessionResult = createSession(
      user.username,
      user.role,
      _userIdleMinutes,
    );

    _writeAuditLog({
      user: user.username,
      displayName: user.full_name || user.username, // ✅ [PERF-2] متوفر بالفعل — يوفّر قراءة شيت Users إضافية
      action: "LOGIN",
      table: "Users",
      record_id: user.username,
      details: "تسجيل دخول ناجح | الدور: " + (user.role || "—"),
    });

    // ✅ [FORCE-PW-1] يُبنى من عمود force_password_change (يُقرأ طازج وقت
    // الدخول، وليس من كاش قديم) — الواجهة تستخدمه لمنع الدخول لأي شاشة
    // قبل إتمام تغيير كلمة المرور.
    var forcePwChange = _isForceChange(user.force_password_change);

    return okResponse("", {
      user: {
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        email: user.email || "",
        forcePasswordChange: forcePwChange,
      },
      forcePasswordChange: forcePwChange,
      sessionToken: sessionResult.token,
      sessionExpiresAt: sessionResult.expiresAt,
      idleTimeoutMinutes: sessionResult.idleTimeout,
    });
  } catch (e) {
    // [SEC-FIX-ERR] لا نكشف تفاصيل الخطأ للمستخدم
    console.error("login error:", e.message, e.stack);
    return errResponse("حدث خطأ داخلي — يرجى المحاولة مرة أخرى");
  }
}

/**
 * loginWithData — دمج login + getAllData + getUserPermissions في call واحد
 * يوفر ~2 طلبات إضافية ويسرّع أول تحميل بشكل كبير
 *
 * ✅ [PERF-3] بعد التحديث: بدل ما نعيد قراءة شيتات Users/Roles/UserPermissions
 * من الصفر لحساب الصلاحيات، بنحسبها مباشرة من نتيجة getAllData() اللي
 * اتقرت بالفعل لتوها (تحتوي users + roles + userOverrides). ده بيوفّر
 * 2-3 round-trips إضافية لنفس الشيتات في كل عملية تسجيل دخول.
 * في حالة فشل أو نقص بيانات غير متوقع، فيه fallback تلقائي للطريقة القديمة.
 *
 * ✅ [PERF-LOGIN-6] login() الآن يستخدم _getSheetUsers() (كاش مشترك) —
 * loginWithData لا يحتاج قراءة Users مجدداً لأن login() استخدم الكاش بالفعل.
 */
function loginWithData(username, password) {
  // 1. تسجيل الدخول أولاً
  // login() تستخدم _getSheetUsers() داخلياً — الكاش يُملأ هنا
  var loginResult = login(username, password);
  if (!loginResult || !loginResult.success) return loginResult;

  var uname = loginResult.user ? loginResult.user.username : username;

  // ✅ [FORCE-PW-1] لو المستخدم لازم يغيّر كلمة المرور أولاً، مفيش داعي
  // لتحميل بيانات النظام الآن (لا صلاحيات ولا بيانات عمل) — الواجهة
  // هتعرض شاشة تغيير كلمة المرور فقط، وهتُحمّل البيانات بعد نجاح التغيير.
  if (loginResult.forcePasswordChange) {
    return {
      success: true,
      user: loginResult.user,
      sessionToken: loginResult.sessionToken,
      sessionExpiresAt: loginResult.sessionExpiresAt,
      idleTimeoutMinutes: loginResult.idleTimeoutMinutes,
      forcePasswordChange: true,
      effectivePermissions: [],
      allRoles: [],
      data: null,
      extendedData: null,
    };
  }

  // 2. جلب البيانات الخفيفة فقط (لوحة التحكم) — البيانات الكاملة تتحمل lazy
  // [PERF-LOGIN-LIGHT] استبدلنا getAllData() الثقيلة بـ getAllDataLight()
  // اللي بترجع فقط: items - stock - openingStock - groups - warehouses
  // - colors - sizes - users - roles - companySettings
  // الباقي (transactions - invoices - customers - suppliers...) يتحمل
  // في الخلفية بعد رسم الداشبورد مباشرة.
  var allData = {};
  try {
    allData = getAllDataLight(uname, loginResult.sessionToken);
  } catch (e) {
    console.error("loginWithData - خطأ:", e.message || e);
  }

  // 3. حساب الصلاحيات من بيانات allData مباشرة بدون أي قراءة إضافية للشيتات
  var effectivePermissions = [];
  var allRoles = [];
  var computedFromCache = false;

  try {
    if (allData && allData.success && Array.isArray(allData.roles)) {
      var uRow = (allData.users || []).find(function (u) {
        return (
          String(u.username || "")
            .trim()
            .toLowerCase() === String(uname).trim().toLowerCase()
        );
      });
      var role = String(
        (uRow && uRow.role) || loginResult.user.role || "viewer",
      ).trim();

      // ✅ permissions الدور (builtin أو مخصص) موجودة بالفعل داخل allData.roles
      var roleObj = allData.roles.find(function (r) {
        return (
          String(r.name || "")
            .trim()
            .toLowerCase() === role.toLowerCase()
        );
      });
      var rolePerms = roleObj
        ? roleObj.permissions || []
        : _getRolePermissions(role); // fallback نادر فقط

      // ✅ overrides المستخدم موجودة بالفعل داخل allData.userOverrides
      var ov = { extra: [], denied: [] };
      if (allData.userOverrides) {
        var targetLower = String(uname).trim().toLowerCase();
        Object.keys(allData.userOverrides).forEach(function (k) {
          if (String(k).trim().toLowerCase() === targetLower) {
            ov = allData.userOverrides[k];
          }
        });
      }
      var extra = ov.extra || [];
      var denied = ov.denied || [];

      effectivePermissions = rolePerms
        .concat(
          extra.filter(function (p) {
            return rolePerms.indexOf(p) === -1;
          }),
        )
        .filter(function (p) {
          return denied.indexOf(p) === -1;
        });

      allRoles = allData.roles.map(function (r) {
        return { id: r.id, name: r.name, label: r.label, color: r.color };
      });

      computedFromCache = true;
    }
  } catch (e) {
    computedFromCache = false;
  }

  // 4. 🔁 Fallback: لو allData فشلت أو حصل أي خطأ غير متوقع، استخدم
  // الطريقة القديمة (تقرأ الشيتات مباشرة) لضمان عدم كسر تسجيل الدخول أبداً
  if (!computedFromCache) {
    try {
      var permsResult = getUserPermissions(uname);
      effectivePermissions = permsResult.effectivePermissions || [];
      allRoles = permsResult.allRoles || [];
    } catch (e) {
      console.error("unknown - خطأ:", e.message || e);
    }
  }

  // 5. إرجاع اللوجين + البيانات الخفيفة فقط
  // [PERF-LOGIN-LIGHT] شيلنا getAllDataExtended من هنا تماماً —
  // extendedData (محاسبة + HR) هتتحمل lazy عند أول فتح لأي شاشة
  // محاسبة أو HR عبر ensureExtendedData() المعتادة.
  return {
    success: true,
    user: loginResult.user,
    sessionToken: loginResult.sessionToken,
    sessionExpiresAt: loginResult.sessionExpiresAt,
    idleTimeoutMinutes: loginResult.idleTimeoutMinutes,
    forcePasswordChange: false,
    effectivePermissions: effectivePermissions,
    allRoles: allRoles,
    data: allData,
    extendedData: null,
  };
}

/**
 * loginLite — تسجيل دخول خفيف بالكامل: تحقق من بيانات المستخدم فقط
 * (login()) + الصلاحيات الفعّالة (مطلوبة لبناء الـ Sidebar/الصلاحيات)،
 * من غير أي تحميل لأي بيانات عمل (أصناف/مخزون/مجموعات/مخازن...).
 *
 * [PERF-LOGIN-INSTANT] الهدف: تفتح لوحة التحكم فورًا بعد التأكد من
 * صحة اسم المستخدم/كلمة المرور، وتُحمَّل كل بيانات العمل بعدين في
 * الخلفية عبر آلية الـ preload الموجودة أصلاً (_preloadAllAfterLogin
 * في 01_JS_Core_Auth.html) بمجرد ما الداشبورد يترسم — بدل ما ننتظر
 * getAllDataLight() قبل ما نرجّع رد اللوجين للفرونت زي loginWithData.
 */
function loginLite(username, password) {
  // 1. تسجيل الدخول أولاً — بدون أي قراءة لبيانات العمل
  var loginResult = login(username, password);
  if (!loginResult || !loginResult.success) return loginResult;

  var uname = loginResult.user ? loginResult.user.username : username;

  // [FORCE-PW-1] لو لازم يغيّر كلمة المرور أولاً، مفيش داعي لأي صلاحيات
  if (loginResult.forcePasswordChange) {
    return {
      success: true,
      user: loginResult.user,
      sessionToken: loginResult.sessionToken,
      sessionExpiresAt: loginResult.sessionExpiresAt,
      idleTimeoutMinutes: loginResult.idleTimeoutMinutes,
      forcePasswordChange: true,
      effectivePermissions: [],
      allRoles: [],
      data: null,
      extendedData: null,
    };
  }

  // 2. الصلاحيات فقط (لازمة لإظهار الـ Sidebar الصحيح) — بدون
  // أي بيانات عمل (getAllDataLight/getAllData) خالص
  var effectivePermissions = [];
  var allRoles = [];
  try {
    var permsResult = getUserPermissions(uname);
    effectivePermissions = permsResult.effectivePermissions || [];
    allRoles = permsResult.allRoles || [];
  } catch (e) {
    console.error("loginLite - خطأ في جلب الصلاحيات:", e.message || e);
  }

  // 3. إرجاع اللوجين + الصلاحيات فقط — data:null دايمًا. الفرونت هيفتح
  // لوحة التحكم فورًا ويجيب بيانات العمل بعدين في الخلفية.
  return {
    success: true,
    user: loginResult.user,
    sessionToken: loginResult.sessionToken,
    sessionExpiresAt: loginResult.sessionExpiresAt,
    idleTimeoutMinutes: loginResult.idleTimeoutMinutes,
    forcePasswordChange: false,
    effectivePermissions: effectivePermissions,
    allRoles: allRoles,
    data: null,
    extendedData: null,
  };
}

/**
 * ينفّذ تغيير كلمة المرور الإلزامي عند أول تسجيل دخول (أو بعد إعادة
 * تعيينها من المدير)، مع تطبيق كامل قواعد أمن كلمة المرور.
 *
 * @param {String} username - اسم المستخدم صاحب الجلسة.
 * @param {String} sessionToken - توكن الجلسة الحالية (من نتيجة login()).
 * @param {String} currentPassword - كلمة المرور الحالية (المؤقتة) كما أدخلها المستخدم.
 * @param {String} newPassword - كلمة المرور الجديدة المطلوبة.
 * @param {String} confirmPassword - تأكيد كلمة المرور الجديدة.
 * @returns {{success: Boolean, message: String, user: Object=}}
 */
function changeForcedPassword(
  username,
  sessionToken,
  currentPassword,
  newPassword,
  confirmPassword,
) {
  try {
    if (!username || !sessionToken) {
      return errResponse(
        "⛔ جلسة غير صالحة — يرجى تسجيل الدخول مجدداً",
        "SESSION_INVALID",
      );
    }
    var sessCheck = validateSession(sessionToken);
    if (!sessCheck || !sessCheck.valid) {
      return errResponse(
        "⛔ جلستك انتهت أو غير صالحة — يرجى تسجيل الدخول مجدداً",
        "SESSION_INVALID",
      );
    }
    if (
      String(sessCheck.username || "")
        .trim()
        .toLowerCase() !== String(username).trim().toLowerCase()
    ) {
      return errResponse("⛔ خطأ في التحقق من الهوية");
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      return errResponse("يرجى تعبئة جميع الحقول");
    }
    if (newPassword !== confirmPassword) {
      return errResponse("كلمتا المرور الجديدتان غير متطابقتين");
    }

    // ✅ قراءة طازجة من الشيت مباشرة (skipCache) لضمان أحدث بيانات
    var users = _getSheetUsers(true);
    var user = users.find(function (u) {
      return (
        String(u.username || "")
          .trim()
          .toLowerCase() === String(username).trim().toLowerCase()
      );
    });
    if (!user) return errResponse("المستخدم غير موجود");
    if (!_isActiveUser(user.active))
      return errResponse("هذا الحساب موقوف — تواصل مع المدير");

    var pwCheck = _checkPassword(currentPassword, String(user.password || ""));
    if (!pwCheck.ok) {
      _writeAuditLog({
        user: username,
        action: "FORCED_PW_CHANGE_FAILED",
        table: "Users",
        record_id: username,
        details: "كلمة المرور الحالية (المؤقتة) غير صحيحة",
      });
      return errResponse("كلمة المرور الحالية غير صحيحة");
    }

    var strengthErr = _validatePasswordStrength(newPassword);
    if (strengthErr) return errResponse(strengthErr);

    // ── منع احتواء كلمة المرور على اسم المستخدم أو البريد الإلكتروني ──
    var uLower = String(user.username || "").toLowerCase();
    var npLower = newPassword.toLowerCase();
    if (uLower && npLower.indexOf(uLower) !== -1) {
      return errResponse("كلمة المرور يجب ألا تحتوي على اسم المستخدم");
    }
    var emailLocal = String(user.email || "")
      .split("@")[0]
      .toLowerCase();
    if (
      emailLocal &&
      emailLocal.length >= 3 &&
      npLower.indexOf(emailLocal) !== -1
    ) {
      return errResponse(
        "كلمة المرور يجب ألا تحتوي على جزء من بريدك الإلكتروني",
      );
    }

    // ── منع إعادة استخدام كلمة المرور الحالية (المؤقتة) ──────────────
    if (_checkPassword(newPassword, String(user.password || "")).ok) {
      return errResponse(
        "لا يمكن استخدام كلمة المرور الحالية (المؤقتة) مرة أخرى — اختر كلمة مرور جديدة",
      );
    }

    // ── منع إعادة استخدام آخر كلمات مرور مخزّنة (يدعم سياسة "آخر N" مستقبلاً) ──
    var history = [];
    try {
      history = JSON.parse(user.password_history || "[]");
    } catch (e) {
      history = [];
    }
    var reused = history.some(function (oldHash) {
      return oldHash && _checkPassword(newPassword, String(oldHash)).ok;
    });
    if (reused) {
      return errResponse(
        "لا يمكن إعادة استخدام كلمة مرور سابقة — اختر كلمة مرور جديدة تمامًا",
      );
    }

    // ── الحفظ ─────────────────────────────────────────────────────
    var newHash = _hashPassword(newPassword);
    history.push(String(user.password || ""));
    if (history.length > 5) history = history.slice(history.length - 5);

    var sheet = getSheet("Users");
    // عمود password=2, force_password_change=8, password_changed_at=9, password_history=10
    sheet.getRange(user._row, 2, 1, 1).setValues([[newHash]]);
    sheet
      .getRange(user._row, 8, 1, 3)
      .setValues([[false, new Date(), JSON.stringify(history)]]);

    _invalidateUsersCache();
    _invalidateServerCache();

    _writeAuditLog({
      user: username,
      displayName: user.full_name || username,
      action: "FORCED_PASSWORD_CHANGED",
      table: "Users",
      record_id: username,
      details: "تم تغيير كلمة المرور بنجاح عند أول تسجيل دخول",
    });

    return okResponse("✅ تم تغيير كلمة المرور بنجاح", {
      user: {
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        email: user.email || "",
        forcePasswordChange: false,
      },
    });
  } catch (e) {
    console.error("changeForcedPassword error:", e.message, e.stack);
    return errResponse("حدث خطأ داخلي — يرجى المحاولة مرة أخرى");
  }
}


