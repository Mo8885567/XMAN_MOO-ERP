// ════════════════════════════════════════════════════════════════
// Code_32_ForgotPassword.gs — [FORGOT-PW-1] استعادة كلمة المرور ذاتيًا
//
// المسؤولية: يسمح لأي مستخدم نسي كلمة مروره باستعادة الدخول بنفسه من
// شاشة اللوجين، بدون تدخّل المدير، عبر 3 خطوات:
//   1) requestPasswordReset(username)        → يبعت كود تحقق (OTP) بالبريد
//   2) verifyPasswordResetOtp(username, otp) → يتحقق من الكود ويرجّع reset_token
//   3) resetPasswordWithToken(...)           → يحفظ كلمة المرور الجديدة
//
// قرارات أمنية مهمّة:
// - لا نكشف أبدًا هل اسم المستخدم موجود أم لا (رسالة عامة ثابتة في كل
//   الحالات) — منعًا لهجمات تخمين أسماء المستخدمين (username enumeration).
// - الكود يُخزَّن كـ hash فقط (زي كلمات المرور) — لو حد قرا الـ
//   PropertiesService مباشرة (نظريًا) ميقدرش ياخد الكود الصريح.
// - Rate limiting منفصل تمامًا عن rate limit تسجيل الدخول العادي
//   (RATE_LIMIT في Code_12_Core.gs) — طلبات كتير للكود ميقفلوش حساب اللوجين.
// - بعد نجاح إعادة التعيين: تُقفل كل جلسات المستخدم الحالية (لو حد كان
//   مسجّل دخول من جهاز غريب هيتم طرده)، ويتصفّر عداد محاولات اللوجين.
// - يُعاد استخدام نفس قواعد قوة كلمة المرور ومنع تكرارها المستخدمة في
//   changeForcedPassword (Code_12_Core.gs) حتى تكون كل مسارات تغيير
//   كلمة المرور بنفس مستوى الحماية.
// ════════════════════════════════════════════════════════════════

var PWRESET_CONFIG = {
  OTP_LENGTH: 6,
  OTP_EXPIRY_MINUTES: 10, // صلاحية كود التحقق
  RESET_TOKEN_EXPIRY_MINUTES: 15, // صلاحية توكن إعادة التعيين بعد التحقق من الكود
  MAX_VERIFY_ATTEMPTS: 5, // محاولات إدخال كود خاطئ قبل إلغاء الطلب
  MAX_REQUESTS_PER_WINDOW: 3, // أقصى عدد طلبات كود جديد
  REQUEST_WINDOW_MINUTES: 30, // خلال هذه المدة
  RESEND_COOLDOWN_SECONDS: 60, // أقل مدة بين طلب وطلب تاني لنفس المستخدم
};

// رسالة عامة ثابتة — نفس الرد سواء كان المستخدم موجود أو لا، عنده بريد أو لا
var PWRESET_GENERIC_MSG =
  "إذا كان الحساب موجودًا ومرتبطًا ببريد إلكتروني مسجّل، ستصلك رسالة تحتوي على كود التحقق خلال دقائق. تحقّق من صندوق الوارد (والرسائل غير المرغوبة).";

// ─────────────────────────────────────────────────────────────
// [MAIL-BRAND] قالب بريد إلكتروني موحّد وراقٍ لرسائل استعادة كلمة
// المرور — HTML/CSS مضمّن فقط (جدول HTML كلاسيكي) عشان يتوافق مع
// كل عملاء البريد الشائعة (Gmail, Outlook, Apple Mail, Yahoo)
// بدون الاعتماد على أي مورد خارجي إجباري. لو الشركة رفعت شعارها
// الخاص (company_settings.logo_url) نستخدمه في هيدر الرسالة، وإلا
// نعرض wordmark نصّي بنفس ألوان هوية النظام (أزرق/أخضر على كحلي).
// ─────────────────────────────────────────────────────────────

/** يهرّب النص قبل حقنه داخل HTML الإيميل (منع كسر التنسيق أو حقن كود) */
function _pwEscHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * [MAIL-LOGO-PNG] شعار MOO.ERP الافتراضي (نفس تصميم getMooLogoSVG في
 * Code_12_Core.gs — مربع كحلي بحواف دائرية + حرف M بخطين متدرجين
 * أزرق/أخضر) لكن كصورة PNG جاهزة بدل SVG.
 *
 * ليه PNG مش SVG أو data-URI؟ عملاء البريد (خصوصًا Outlook Desktop)
 * ميدعموش صور SVG إطلاقًا، وكتير منهم بيرفض data-URI حتى لو الصورة
 * PNG عادية. الحل المتوافق مع الكل (Gmail, Outlook, Apple Mail,
 * Yahoo...) هو إرفاق صورة PNG حقيقية "inline" وربطها بالـ HTML عبر
 * cid: — وده بالظبط اللي بيحصل هنا.
 */
var PWRESET_LOGO_PNG_BASE64 =
  "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";

/** يرجّع بيانات هوية الشركة (اسم + شعار) من إعدادات النظام لاستخدامها في البريد */
function _pwResetBrand() {
  var settings = {};
  try {
    settings = _getCompanySettingsRaw() || {};
  } catch (e) {
    settings = {};
  }
  var name =
    String(settings.company_name || settings.shop_name || "").trim() ||
    "MOO.ERP";
  var rawLogo = settings.logo_url || "";
  var logoUrl =
    rawLogo && typeof _fixDriveUrlServer === "function"
      ? _fixDriveUrlServer(rawLogo)
      : rawLogo;
  return { name: name, logoUrl: logoUrl };
}

/**
 * هيدر الشعار — يرجّع {html, inlineImages}:
 * - لو الشركة رافعة شعار مخصص (company_settings.logo_url): نستخدمه
 *   كـ <img> عادي (رابط مباشر، بيتوافق مع كل عملاء البريد).
 * - غير كده: شعار MOO.ERP الحقيقي (نفس شكل النظام تمامًا) كصورة PNG
 *   مرفقة inline عبر cid: — أضمن طريقة لظهور صورة حقيقية في كل
 *   عملاء البريد بما فيهم Outlook Desktop.
 */
function _pwResetLogoAssets(brand) {
  if (brand.logoUrl) {
    return {
      html:
        '<img src="' +
        _pwEscHtml(brand.logoUrl) +
        '" alt="' +
        _pwEscHtml(brand.name) +
        '" width="56" height="56" ' +
        'style="display:block;margin:0 auto;border-radius:14px;object-fit:contain;background:#ffffff;padding:4px" />',
      inlineImages: {},
    };
  }
  var logoBlob = Utilities.newBlob(
    Utilities.base64Decode(PWRESET_LOGO_PNG_BASE64),
    "image/png",
    "moo_logo.png",
  );
  return {
    html:
      '<img src="cid:pwreset_logo" alt="' +
      _pwEscHtml(brand.name) +
      '" width="56" height="56" style="display:block;margin:0 auto;border-radius:14px" />',
    inlineImages: { pwreset_logo: logoBlob },
  };
}

/**
 * _pwResetEmailShell — الهيكل العام (بطاقة بيضاء + هيدر كحلي + فوتر)
 * المستخدم في كل رسائل استعادة كلمة المرور.
 * @param {{brand:Object, bodyHtml:String, logoHtml:String}} opts
 * @returns {String} HTML كامل جاهز لحقل htmlBody في MailApp.sendEmail
 */
function _pwResetEmailShell(opts) {
  var brand = opts.brand;
  var year = new Date().getFullYear();
  return (
    '<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#F1F5F9;font-family:Tahoma,Arial,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:32px 12px">' +
    "<tr><td align=\"center\">" +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden">' +
    // هيدر
    '<tr><td style="background:#0F172A;padding:32px 24px;text-align:center">' +
    opts.logoHtml +
    "</td></tr>" +
    // محتوى
    '<tr><td style="padding:36px 32px 24px">' +
    opts.bodyHtml +
    "</td></tr>" +
    // فوتر
    '<tr><td style="padding:20px 32px 28px;border-top:1px solid #E2E8F0;text-align:center">' +
    '<div style="font-size:12px;color:#94A3B8;line-height:1.9">' +
    _pwEscHtml(brand.name) +
    " &copy; " +
    year +
    "<br>هذه رسالة آلية، برجاء عدم الرد عليها مباشرة." +
    "</div></td></tr>" +
    "</table>" +
    "</td></tr></table></body></html>"
  );
}

/** محتوى رسالة "كود التحقق" — الخطوة 1 */
function _pwResetOtpBodyHtml(displayName, username, otp, expiryMinutes) {
  return (
    '<div style="text-align:center;margin-bottom:4px">' +
    '<span style="display:inline-block;width:56px;height:56px;border-radius:50%;background:#EFF6FF;font-size:26px;line-height:56px"></span>' +
    "</div>" +
    '<h2 style="margin:18px 0 6px;text-align:center;color:#0F172A;font-size:20px">كود استعادة كلمة المرور</h2>' +
    '<p style="text-align:center;color:#64748B;font-size:14px;line-height:1.8;margin:0 0 24px">' +
    "مرحبًا <b style=\"color:#0F172A\">" +
    _pwEscHtml(displayName) +
    "</b>، طلبت استعادة كلمة المرور لحسابك <b>(" +
    _pwEscHtml(username) +
    ")</b>.</p>" +
    '<div style="background:#F8FAFC;border:1.5px dashed #CBD5E1;border-radius:12px;padding:22px 16px;text-align:center;margin-bottom:20px">' +
    '<div style="font-size:12px;color:#94A3B8;margin-bottom:10px;letter-spacing:1px">كود التحقق</div>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#2563EB;direction:ltr;font-family:Consolas,Menlo,monospace">' +
    _pwEscHtml(otp) +
    "</div></div>" +
    '<div style="background:#FFFBEB;border-radius:10px;padding:12px 16px;font-size:13px;color:#92400E;margin-bottom:20px">' +
    "⏳ الكود صالح لمدة <b>" +
    expiryMinutes +
    " دقائق</b> فقط من الآن، ولن يعمل بعدها.</div>" +
    '<p style="font-size:13px;color:#94A3B8;line-height:1.8;margin:0">' +
    "لو لم تطلب أنت هذا الكود، تجاهّل هذه الرسالة ولا داعي لاتخاذ أي إجراء — كلمة مرورك الحالية ستظل كما هي دون أي تغيير.</p>"
  );
}

/** محتوى رسالة "تم تغيير كلمة المرور بنجاح" — الخطوة 3 */
function _pwResetSuccessBodyHtml(displayName, username) {
  return (
    '<div style="text-align:center;margin-bottom:4px">' +
    '<span style="display:inline-block;width:56px;height:56px;border-radius:50%;background:#ECFDF5;font-size:26px;line-height:56px"></span>' +
    "</div>" +
    '<h2 style="margin:18px 0 6px;text-align:center;color:#0F172A;font-size:20px">تم تغيير كلمة المرور بنجاح</h2>' +
    '<p style="text-align:center;color:#64748B;font-size:14px;line-height:1.8;margin:0 0 24px">' +
    "مرحبًا <b style=\"color:#0F172A\">" +
    _pwEscHtml(displayName) +
    "</b>، تم للتو تغيير كلمة مرور حسابك <b>(" +
    _pwEscHtml(username) +
    ")</b> بنجاح.</p>" +
    '<div style="background:#F0FDF4;border-radius:10px;padding:14px 16px;font-size:13px;color:#166534;margin-bottom:20px">' +
    " تم تسجيل خروج أي جلسات أخرى مفتوحة على حسابك تلقائيًا كإجراء أمني.</div>" +
    '<p style="font-size:13px;color:#94A3B8;line-height:1.8;margin:0">' +
    "لو لم تكن أنت من قام بهذا التغيير، تواصل فورًا مع مدير النظام.</p>"
  );
}

// ─────────────────────────────────────────────────────────────
// أدوات داخلية
// ─────────────────────────────────────────────────────────────

function _pwResetKey(username) {
  return (
    "pwreset_" +
    String(username)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._@-]/g, "_")
  );
}

/** يولّد كود تحقق رقمي عشوائي بطول PWRESET_CONFIG.OTP_LENGTH */
function _generateOtp() {
  var max = Math.pow(10, PWRESET_CONFIG.OTP_LENGTH);
  var n = Math.floor(Math.random() * max);
  return ("0".repeat(PWRESET_CONFIG.OTP_LENGTH) + String(n)).slice(
    -PWRESET_CONFIG.OTP_LENGTH,
  );
}

/** hash بسيط بدون salt — كافٍ هنا لأن الكود قصير العمر (دقائق) ومحدود المحاولات */
function _hashOtp(otp) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    "pwreset:" + String(otp),
    Utilities.Charset.UTF_8,
  );
  return bytes
    .map(function (b) {
      return ("0" + (b & 0xff).toString(16)).slice(-2);
    })
    .join("");
}

function _generateResetToken() {
  return (
    Utilities.getUuid().replace(/-/g, "") +
    Utilities.getUuid().replace(/-/g, "")
  );
}

/**
 * يقفل نهائيًا كل الجلسات النشطة لمستخدم معيّن (يُستخدم بعد إعادة تعيين
 * كلمة المرور ذاتيًا — أي جهاز آخر داخل حاليًا هيتطرد تلقائيًا).
 * نفس منطق البحث المستخدم في _cleanUserSessions لكن بحذف الكل بدون استثناء.
 */
function _invalidateAllUserSessions(username) {
  try {
    var props = PropertiesService.getScriptProperties();
    var allProps = props.getProperties();
    var uLower = String(username || "")
      .trim()
      .toLowerCase();
    Object.keys(allProps).forEach(function (k) {
      if (k.indexOf("sess_") !== 0) return;
      try {
        var s = JSON.parse(allProps[k]);
        if (String(s.username || "").toLowerCase() === uLower) {
          props.deleteProperty(k);
        }
      } catch (e) {
        // تجاهل صف تالف
      }
    });
  } catch (e) {
    console.error("_invalidateAllUserSessions - خطأ:", e.message || e);
  }
}

// ─────────────────────────────────────────────────────────────
// الخطوة 1: طلب كود التحقق
// ─────────────────────────────────────────────────────────────

/**
 * requestPasswordReset — يبدأ مسار استعادة كلمة المرور بإرسال كود تحقق
 * على البريد الإلكتروني المسجّل للمستخدم (إن وُجد).
 *
 * يرجع نفس الرسالة العامة دائمًا (نجاح شكلي) بصرف النظر عن وجود
 * المستخدم من عدمه — لمنع كشف أسماء مستخدمين حقيقية لمهاجم.
 *
 * @param {String} username
 * @returns {{success:Boolean, message:String}}
 */
function requestPasswordReset(username) {
  try {
    if (!username || !String(username).trim()) {
      return errResponse("يرجى إدخال اسم المستخدم");
    }
    var uname = String(username).trim();
    var key = _pwResetKey(uname);
    var props = PropertiesService.getScriptProperties();
    var now = Date.now();

    // ── Rate limiting مستقل عن قفل تسجيل الدخول العادي ──────────
    var rec = null;
    try {
      var raw = props.getProperty(key);
      if (raw) rec = JSON.parse(raw);
    } catch (e) {
      rec = null;
    }
    if (
      rec &&
      rec.window_start &&
      now - rec.window_start < PWRESET_CONFIG.REQUEST_WINDOW_MINUTES * 60000
    ) {
      if (
        rec.last_request_at &&
        now - rec.last_request_at <
          PWRESET_CONFIG.RESEND_COOLDOWN_SECONDS * 1000
      ) {
        var waitSec = Math.ceil(
          (PWRESET_CONFIG.RESEND_COOLDOWN_SECONDS * 1000 -
            (now - rec.last_request_at)) /
            1000,
        );
        return errResponse(
          "يرجى الانتظار " + waitSec + " ثانية قبل طلب كود جديد",
        );
      }
      if (rec.request_count >= PWRESET_CONFIG.MAX_REQUESTS_PER_WINDOW) {
        return errResponse(
          "لقد تجاوزت الحد المسموح من طلبات الكود — حاول مرة أخرى بعد " +
            PWRESET_CONFIG.REQUEST_WINDOW_MINUTES +
            " دقيقة",
        );
      }
    } else {
      rec = { window_start: now, request_count: 0 };
    }

    // ── البحث عن المستخدم (بدون كشف أي شيء للفرونت إند) ──────────
    var users = _getSheetUsers(true);
    var user = users.find(function (u) {
      return (
        String(u.username || "")
          .trim()
          .toLowerCase() === uname.toLowerCase()
      );
    });

    var otp = _generateOtp();
    rec.request_count = (rec.request_count || 0) + 1;
    rec.last_request_at = now;
    rec.otp_hash = _hashOtp(otp);
    rec.otp_expires_at = now + PWRESET_CONFIG.OTP_EXPIRY_MINUTES * 60000;
    rec.attempts = 0;
    rec.reset_token = null;
    rec.reset_token_expires_at = null;
    props.setProperty(key, JSON.stringify(rec));

    if (user && _isActiveUser(user.active) && user.email) {
      try {
        var brand = _pwResetBrand();
        var logoAssets = _pwResetLogoAssets(brand);
        MailApp.sendEmail({
          to: user.email,
          subject: " كود استعادة كلمة المرور — " + brand.name,
          body: [
            "مرحبًا " + (user.full_name || user.username) + "،",
            "",
            "طلبت استعادة كلمة المرور لحسابك (" +
              user.username +
              ") في " +
              brand.name +
              ".",
            "",
            "كود التحقق: " + otp,
            "",
            "الكود صالح لمدة " +
              PWRESET_CONFIG.OTP_EXPIRY_MINUTES +
              " دقائق فقط، ولن يعمل بعدها.",
            "",
            "لو لم تطلب أنت هذا الكود، تجاهل هذه الرسالة ولا داعي لاتخاذ أي إجراء —",
            "كلمة مرورك الحالية ستظل كما هي دون أي تغيير.",
            "",
            "— " + brand.name,
          ].join("\n"),
          htmlBody: _pwResetEmailShell({
            brand: brand,
            logoHtml: logoAssets.html,
            bodyHtml: _pwResetOtpBodyHtml(
              user.full_name || user.username,
              user.username,
              otp,
              PWRESET_CONFIG.OTP_EXPIRY_MINUTES,
            ),
          }),
          inlineImages: logoAssets.inlineImages,
        });
        AuditEngine.log("PASSWORD_RESET_REQUESTED", {
          user: uname,
          displayName: user.full_name || uname,
          table: "Users",
          record_id: uname,
          details: "طلب كود استعادة كلمة مرور ذاتيًا (أُرسل بالبريد)"});
      } catch (mailErr) {
        console.error(
          "requestPasswordReset - فشل إرسال البريد:",
          mailErr.message,
        );
        AuditEngine.log("PASSWORD_RESET_MAIL_FAILED", {
          user: uname,
          displayName: user.full_name || uname,
          table: "Users",
          record_id: uname,
          details: "فشل إرسال بريد كود الاستعادة: " + mailErr.message});
      }
    } else if (user) {
      // المستخدم موجود لكن معندوش بريد مسجّل أو حسابه موقوف — نسجّل داخليًا بس
      AuditEngine.log("PASSWORD_RESET_UNAVAILABLE", {
        user: uname,
        displayName: user.full_name || uname,
        table: "Users",
        record_id: uname,
        details: user.email
          ? "طلب استعادة لحساب موقوف"
          : "طلب استعادة لمستخدم بدون بريد إلكتروني مسجّل"});
    }
    // لو المستخدم مش موجود أصلاً: لا نكتب Audit Log مربوط باسم مستخدم غير حقيقي،
    // ولا نرسل أي بريد — فقط نرجع نفس الرسالة العامة.

    return okResponse(PWRESET_GENERIC_MSG);
  } catch (e) {
    console.error("requestPasswordReset error:", e.message, e.stack);
    return errResponse("حدث خطأ داخلي — يرجى المحاولة مرة أخرى");
  }
}

// ─────────────────────────────────────────────────────────────
// الخطوة 2: التحقق من الكود
// ─────────────────────────────────────────────────────────────

/**
 * verifyPasswordResetOtp — يتحقق من كود التحقق المُرسَل بالبريد.
 * عند النجاح يرجّع reset_token قصير العمر يُستخدم في الخطوة الأخيرة
 * فقط (بدل إعادة إرسال الكود نفسه)، لتقليل فرصة إعادة استخدامه.
 *
 * @param {String} username
 * @param {String} otp
 * @returns {{success:Boolean, message:String, resetToken:String=}}
 */
function verifyPasswordResetOtp(username, otp) {
  try {
    if (!username || !otp) {
      return errResponse("يرجى إدخال اسم المستخدم والكود");
    }
    var uname = String(username).trim();
    var key = _pwResetKey(uname);
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(key);
    if (!raw) {
      return errResponse(
        "لا يوجد طلب استعادة نشط لهذا الحساب — اطلب كودًا جديدًا",
      );
    }
    var rec = JSON.parse(raw);
    var now = Date.now();

    if (!rec.otp_hash || !rec.otp_expires_at || now > rec.otp_expires_at) {
      props.deleteProperty(key);
      return errResponse("انتهت صلاحية الكود — يرجى طلب كود جديد");
    }
    if (rec.attempts >= PWRESET_CONFIG.MAX_VERIFY_ATTEMPTS) {
      props.deleteProperty(key);
      return errResponse(
        "تم تجاوز عدد المحاولات المسموح لهذا الكود — يرجى طلب كود جديد",
      );
    }

    var inputHash = _hashOtp(String(otp).trim());
    if (inputHash !== rec.otp_hash) {
      rec.attempts = (rec.attempts || 0) + 1;
      props.setProperty(key, JSON.stringify(rec));
      var remaining = PWRESET_CONFIG.MAX_VERIFY_ATTEMPTS - rec.attempts;
      return errResponse(
        remaining > 0
          ? "الكود غير صحيح — تبقّى لك " + remaining + " محاولة/محاولات"
          : "الكود غير صحيح — تم تجاوز عدد المحاولات المسموح، اطلب كودًا جديدًا",
      );
    }

    // الكود صحيح — نصدر reset_token ونمسح الـ OTP نفسه (استخدام لمرة واحدة)
    var resetToken = _generateResetToken();
    rec.otp_hash = null;
    rec.otp_expires_at = null;
    rec.attempts = 0;
    rec.reset_token = resetToken;
    rec.reset_token_expires_at =
      now + PWRESET_CONFIG.RESET_TOKEN_EXPIRY_MINUTES * 60000;
    props.setProperty(key, JSON.stringify(rec));

    return okResponse(" تم التحقق من الكود بنجاح", {
      resetToken: resetToken,
    });
  } catch (e) {
    console.error("verifyPasswordResetOtp error:", e.message, e.stack);
    return errResponse("حدث خطأ داخلي — يرجى المحاولة مرة أخرى");
  }
}

// ─────────────────────────────────────────────────────────────
// الخطوة 3: حفظ كلمة المرور الجديدة
// ─────────────────────────────────────────────────────────────

/**
 * resetPasswordWithToken — يحفظ كلمة مرور جديدة بعد التحقق الناجح من
 * الكود (يتطلّب resetToken صادر من verifyPasswordResetOtp).
 * يطبّق نفس قواعد قوة/عدم تكرار كلمة المرور المستخدمة في
 * changeForcedPassword، ثم يقفل كل الجلسات النشطة ويصفّر قفل اللوجين.
 *
 * @param {String} username
 * @param {String} resetToken
 * @param {String} newPassword
 * @param {String} confirmPassword
 * @returns {{success:Boolean, message:String}}
 */
function resetPasswordWithToken(
  username,
  resetToken,
  newPassword,
  confirmPassword,
) {
  try {
    if (!username || !resetToken || !newPassword || !confirmPassword) {
      return errResponse("يرجى تعبئة جميع الحقول");
    }
    if (newPassword !== confirmPassword) {
      return errResponse("كلمتا المرور الجديدتان غير متطابقتين");
    }

    var uname = String(username).trim();
    var key = _pwResetKey(uname);
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(key);
    if (!raw) {
      return errResponse(
        "انتهت صلاحية الطلب — يرجى البدء من جديد وطلب كود آخر",
      );
    }
    var rec = JSON.parse(raw);
    var now = Date.now();
    if (
      !rec.reset_token ||
      rec.reset_token !== resetToken ||
      !rec.reset_token_expires_at ||
      now > rec.reset_token_expires_at
    ) {
      props.deleteProperty(key);
      return errResponse(
        "انتهت صلاحية الطلب — يرجى البدء من جديد وطلب كود آخر",
      );
    }

    var users = _getSheetUsers(true);
    var user = users.find(function (u) {
      return (
        String(u.username || "")
          .trim()
          .toLowerCase() === uname.toLowerCase()
      );
    });
    if (!user) {
      props.deleteProperty(key);
      return errResponse("المستخدم غير موجود");
    }
    if (!_isActiveUser(user.active)) {
      props.deleteProperty(key);
      return errResponse("هذا الحساب موقوف — تواصل مع المدير");
    }

    var strengthErr = _validatePasswordStrength(newPassword);
    if (strengthErr) return errResponse(strengthErr);

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

    // ── منع إعادة استخدام كلمة المرور الحالية أو أي من آخر 5 كلمات مرور ──
    if (_checkPassword(newPassword, String(user.password || "")).ok) {
      return errResponse(
        "لا يمكن استخدام كلمة المرور الحالية مرة أخرى — اختر كلمة مرور جديدة",
      );
    }
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

    // ── الحفظ (بنفس ترتيب أعمدة changeForcedPassword) ─────────────
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
    props.deleteProperty(key);

    // أي جهاز آخر داخل حاليًا بنفس الحساب يتطرد فورًا — تدبير أمني
    _invalidateAllUserSessions(uname);
    // تصفير أي قفل سابق من محاولات لوجين فاشلة — بما إنه لسه أثبت ملكية الحساب بالبريد
    _clearRateLimit(uname);

    AuditEngine.log("PASSWORD_RESET_SELF_SERVICE", {
      user: uname,
      displayName: user.full_name || uname,
      table: "Users",
      record_id: uname,
      details: "تم تغيير كلمة المرور ذاتيًا عبر كود تحقق بالبريد"});

    if (user.email) {
      try {
        var brandOk = _pwResetBrand();
        var logoAssetsOk = _pwResetLogoAssets(brandOk);
        MailApp.sendEmail({
          to: user.email,
          subject: " تم تغيير كلمة مرورك — " + brandOk.name,
          body: [
            "مرحبًا " + (user.full_name || user.username) + "،",
            "",
            "تم للتو تغيير كلمة مرور حسابك (" +
              user.username +
              ") في " +
              brandOk.name +
              " بنجاح.",
            "تم تسجيل خروج أي جلسات أخرى مفتوحة لحسابك تلقائيًا.",
            "",
            "لو لم تكن أنت من قام بهذا التغيير، تواصل فورًا مع مدير النظام.",
            "",
            "— " + brandOk.name,
          ].join("\n"),
          htmlBody: _pwResetEmailShell({
            brand: brandOk,
            logoHtml: logoAssetsOk.html,
            bodyHtml: _pwResetSuccessBodyHtml(
              user.full_name || user.username,
              user.username,
            ),
          }),
          inlineImages: logoAssetsOk.inlineImages,
        });
      } catch (mailErr) {
        console.warn(
          "resetPasswordWithToken - فشل إرسال بريد التأكيد:",
          mailErr.message,
        );
      }
    }

    return okResponse(
      " تم تغيير كلمة المرور بنجاح — يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة",
    );
  } catch (e) {
    console.error("resetPasswordWithToken error:", e.message, e.stack);
    return errResponse("حدث خطأ داخلي — يرجى المحاولة مرة أخرى");
  }
}
