/**
 * ============================================================
 * Module: Code_12c_WebEntry.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * نقطة الدخول الرئيسية لطلبات HTTP POST القادمة من الواجهة (عبر
 * google.script.run أو أي استدعاء HTTP مباشر للـ Web App).
 *
 * Workflow:
 * 1. قراءة اسم الدالة (fn) ووسائطها (args) من جسم الطلب (JSON).
 * 2. التحقق من أن الدالة موجودة ضمن DOPOST_ALLOWED_FUNCTIONS
 *    (Allowlist أمني، انظر SEC-FIX-1).
 * 3. إن لم تكن الدالة ضمن DOPOST_PUBLIC_FUNCTIONS، التحقق من وجود
 *    توكن جلسة صالح ضمن الوسائط (SEC-FIX-4)، وإلا رفض الطلب.
 * 4. تنفيذ الدالة ديناميكيًا عبر this[fn].apply(this, args) وإرجاع
 *    الناتج كـ JSON.
 *
 * Business Rules:
 * - أي خطأ أثناء التنفيذ يُلتقط ويُعاد كـ { error: message } بدل رمي
 *   استثناء غير معالج يوقف الاستجابة بالكامل.
 *
 * @param {Object} e - كائن الحدث القياسي من Google Apps Script، يحتوي
 *   e.postData.contents كنص JSON بالشكل { fn, args }.
 * @returns {ContentService.TextOutput} استجابة JSON بالشكل
 *   { result } عند النجاح أو { error } عند الفشل.
 */
function doPost(e) {
  var output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    var payload = JSON.parse(e.postData.contents);

    // [COMMHUB] مسار منفصل تماماً لـ Webhooks القادمة من Bridge خارجي
    // (WhatsApp Bridge وغيره مستقبلاً) — شكل الطلب مختلف عن {fn,args}
    // العادي ولا يحمل جلسة مستخدم؛ التوثيق هنا HMAC فقط (راجع
    // commHubHandleWebhook + ملاحظة GAS في Code_CommHub_Providers.gs).
    if (payload && payload.hub_event === true) {
      var hubResult = commHubHandleWebhook(payload);
      output.setContent(JSON.stringify(hubResult));
      return output;
    }

    var fn = payload.fn;
    var args = payload.args || [];

    // [SEC-FIX-1] التحقق من القائمة البيضاء قبل أي استدعاء
    if (!fn || DOPOST_ALLOWED_FUNCTIONS.indexOf(fn) === -1) {
      output.setContent(
        JSON.stringify({ error: "Function not permitted: " + fn }),
      );
      return output;
    }

    // [SEC-FIX-4] بوابة جلسة مركزية — أي دالة غير عامة تتطلب توكن جلسة صالح
    var authCtx = null;
    if (DOPOST_PUBLIC_FUNCTIONS.indexOf(fn) === -1) {
      authCtx = _doPostGetAuthContext(args);
    }
    if (DOPOST_PUBLIC_FUNCTIONS.indexOf(fn) === -1 && !authCtx) {
      output.setContent(
        JSON.stringify({
          error: "⛔ غير مصرح — يرجى تسجيل الدخول (session required)",
        }),
      );
      return output;
    }

    if (
      authCtx &&
      ["getAllData", "getAllDataLight", "getAllDataFresh"].indexOf(fn) !== -1
    ) {
      args = [authCtx.username, authCtx.token];
    }

    if (typeof this[fn] !== "function") {
      output.setContent(JSON.stringify({ error: "Unknown function: " + fn }));
    } else {
      var result = this[fn].apply(this, args);
      output.setContent(JSON.stringify({ result: result }));
    }
  } catch (err) {
    // [SEC-FIX-2] لا نكشف تفاصيل الخطأ الداخلية
    output.setContent(JSON.stringify({ error: "Internal server error" }));
    console.error("doPost error:", err.message);
  }

  return output;
}

function getMooLogoSVG(px, opts) {
  px = px || 100;
  opts = opts || {};
  var withBg = opts.bg !== false; // افتراضيًا: true
  var mono = !!opts.mono;
  var c1 = mono ? "#fff" : "#2563EB";
  var c2 = mono ? "#fff" : "#10B981";
  var bg = withBg
    ? '<rect width="100" height="100" rx="18" fill="#0F172A"/>'
    : "";
  return (
    '<svg width="' +
    px +
    '" height="' +
    px +
    '" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    bg +
    '<path d="M24 76 L24 22 L50 50" fill="none" stroke="' +
    c1 +
    '" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M50 50 L76 22 L76 76" fill="none" stroke="' +
    c2 +
    '" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>"
  );
}

/**
 * يحوّل شعار MOO الافتراضي (SVG) إلى Data URI جاهز للاستخدام مباشرة في
 * سمة src لعنصر <img>، دون الحاجة لملف مستقل.
 *
 * @param {Number} px - حجم الشعار بالبكسل (عرض = ارتفاع).
 * @param {Object} [opts] - خيارات الألوان، تُمرَّر كما هي لـ getMooLogoSVG.
 * @returns {String} Data URI بصيغة "data:image/svg+xml,...".
 */
function getMooLogoDataURI(px, opts) {
  return "data:image/svg+xml," + encodeURIComponent(getMooLogoSVG(px, opts));
}

function _fixDriveUrlServer(url) {
  if (!url) return url;
  if (String(url).indexOf("drive.google.com") === -1) return url;
  var m =
    String(url).match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
    String(url).match(/\/d\/([a-zA-Z0-9_-]+)/) ||
    String(url).match(/thumbnail\?id=([a-zA-Z0-9_-]+)/);
  if (m) return "https://drive.google.com/thumbnail?id=" + m[1] + "&sz=w400";
  return url;
}

/**
 * getCompanyLogoUrlForSplash — [FIX-FIXED-BRAND-ICON] كانت بترجع شعار
 * الشركة المخصص (logo_url) لو موجود، فيستخدمه Index.html كأيقونة تاب
 * المتصفح (favicon) وأيقونة الـ PWA/tile-image بدل شعار MOO-ERP
 * الثابت — يعني الأيقونة بتختلف من شركة لتانية حسب شعارها الداخلي.
 * بناءً على طلب إن أيقونة هيدر المتصفح تفضل ثابتة MOO-ERP دايمًا
 * وميتأثرش بأي شعار شركة داخلي، الدالة بترجع "" دايمًا الآن — فـ
 * Index.html يرجع دايمًا لـ fallback الشعار الافتراضي (getMooLogoDataURI).
 * ملحوظة: شعار الشركة المخصص (logo_url) لسه بيظهر في أماكنه التانية
 * (السايدبار، شاشة اللوجين... إلخ)؛ الدالة دي خاصة بأيقونة تاب
 * المتصفح فقط.
 */
function getCompanyLogoUrlForSplash() {
  return "";
}

/**
 * نقطة الدخول الرئيسية لطلبات HTTP GET — أي فتح لرابط الـ Web App
 * يمر من هنا. تخدم صفحتين مختلفتين حسب الباراميتر page:
 *
 * Workflow:
 * 1. page=catalog  → تُرجع صفحة الكتالوج العام (CatalogPublic.html)
 *    بدون أي مصادقة، مع فلترة اختيارية بالمجموعات/المخازن/الأسعار.
 * 2. أي قيمة أخرى (أو بدون page) → تُرجع تطبيق الـ SPA الرئيسي
 *    (Index.html) مع حقن بيانات الكاش الجاهزة (prefetchedItems) إن
 *    وُجدت لتسريع أول تحميل.
 *
 * Business Rules:
 * - لا يتم حقن بيانات المستخدمين (prefetchedUsers) أبدًا هنا؛ تُجلب
 *   فقط بعد تسجيل الدخول عبر getUsers مع sessionToken صالح
 *   (FIX-ISSUE-005 — منع كشف بيانات المستخدمين لزائر غير مسجّل).
 * - وضع الحماية من التضمين (X-Frame-Options) مختلف بين الصفحتين:
 *   ALLOWALL للكتالوج العام (قد يُضمَّن داخل موقع العميل)، وDEFAULT
 *   للتطبيق الرئيسي (يمنع التضمين الخارجي، SEC-FIX-10).
 *
 * @param {Object} e - كائن الحدث القياسي من Apps Script، يحتوي
 *   e.parameter بمعاملات الرابط (page, groups, wh, noprices...).
 * @returns {HtmlOutput} صفحة HTML جاهزة للعرض.
 */
function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || "app";

  if (page === "catalog") {
    var groups = (e.parameter.groups || "").trim();
    var whParam = (e.parameter.wh || "").trim();
    var noprices = (e.parameter.noprices || "").trim();
    var showzero = (e.parameter.showzero || "").trim(); // "1" = أظهر الأصناف رصيدها صفر
    var noqty = (e.parameter.noqty || "").trim(); // "1" = أخفِ الرصيد عن العميل
    var client = (e.parameter.client || "").trim(); // اسم العميل لرسالة الترحيب

    // حوّل warehouse ids لـ names (لأن stock.warehouse مخزون كـ name)
    var whNames = whParam;
    if (whParam) {
      try {
        var warehouses = readSheet("Warehouses");
        var whNamesArr = whParam.split(",").map(function (wid) {
          wid = wid.trim();
          var found = warehouses.filter(function (w) {
            return String(w.id).trim() === wid;
          });
          return found.length ? String(found[0].name).trim() : wid;
        });
        whNames = whNamesArr.join(",");
      } catch (err) {
        whNames = whParam; // fallback لو فشل
      }
    }

    var tpl = HtmlService.createTemplateFromFile("CatalogPublic");
    // [BUG-FIX] كانت القيم تُحقن خام بدون JSON.stringify داخل <?!= ?>
    // (raw/unescaped) — أي باراميتر فاضٍ في الرابط (وهي الحالة الأشيع،
    // زي ?page=catalog&client=محمد بدون groups/wh/noprices/noqty) كان
    // يُنتج مباشرة "var _URL_GROUPS = ;" وهو خطأ JS Syntax فوري يوقف كل
    // سكريبت الصفحة ويجعلها عالقة للأبد على "جاري تحميل الكتالوج...".
    // حتى القيم غير الفارغة (زي client=محمد) كانت تُحقن بدون علامات
    // اقتباس فتُنتج قيمة/متغيّر غير صالح. JSON.stringify يضمن دائماً نصاً
    // صالحاً (مثلاً "" أو "محمد") بغض النظر عن محتوى الباراميتر.
    tpl.urlGroups = JSON.stringify(groups);
    tpl.urlWh = JSON.stringify(whNames);
    tpl.urlNoprices = JSON.stringify(noprices);
    tpl.urlShowzero = JSON.stringify(showzero); // "1" → أظهر الأصناف رصيدها = الحد الأدنى أو صفر
    tpl.urlNoqty = JSON.stringify(noqty); // "1" → أخفِ الرصيد والحالة عن العميل
    tpl.urlClient = JSON.stringify(client); // اسم العميل لرسالة الترحيب

    return tpl
      .evaluate()
      .setTitle("كتالوج MOO.ERP")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .setSandboxMode(HtmlService.SandboxMode.IFRAME);
  }

  var tpl = HtmlService.createTemplateFromFile("Index");

  // لا نحقن أي بيانات ERP قبل تسجيل الدخول. تحميل البيانات يتم بعد إنشاء جلسة
  // صالحة عبر getAllData*/getAllDataByLevel مع callerUser/sessionToken.
  tpl.prefetchedItems = "null";

  // [FIX-ISSUE-005] لا نكشف بيانات المستخدمين قبل تسجيل الدخول
  // prefetch المستخدمين كان يُرسل أسماء وإيميلات وأدوار لأي زائر بدون مصادقة
  // الـ frontend يجلب المستخدمين بعد تسجيل الدخول عبر getUsers مع sessionToken
  tpl.prefetchedUsers = "null";
  // [FIX-VERSION-SYNC] كان بيقرأ APP_VERSION المحلي مباشرة (بيتحدّث
  // يدويًا بس) — بقى بيقرأ من _umDisplayVersionInfo() (Code_41_
  // UpdateManagement.gs) اللي بترجع آخر إصدار منشور من المركزي أولًا
  // (كاش-only، من غير أي اتصال شبكة متزامن يبطّئ doGet)، وترجع
  // APP_VERSION المحلي كـ fallback بس لو الكاش فاضي تمامًا.
  var _displayVer =
    typeof _umDisplayVersionInfo === "function"
      ? _umDisplayVersionInfo()
      : { version: typeof APP_VERSION !== "undefined" ? APP_VERSION : "" };
  tpl.appVersion = _displayVer.version || "";

  // [LICENSE-STATUS] حالة الترخيص/الاشتراك — بتتحقن هنا زي appVersion
  // بالظبط: من الكاش فقط (بدون أي اتصال شبكة متزامن يبطّئ doGet)،
  // عشان تظهر في شاشة اللوجين *قبل* تسجيل الدخول. التحديث الفعلي لهذا
  // الكاش بيحصل من warmCache() كل 15 دقيقة + بعد أي لوجين ناجح
  // (getLicenseStatusFresh عبر checkLicenseOnBoot في الفرونت) — راجع
  // Code_41_UpdateManagement.js. لو الكاش فاضي تمامًا (نشر أول مرة)،
  // بترجع null والفرونت هيتجاهل البانر بهدوء (مفيش رسالة أفضل من رسالة
  // خطأ مربكة على شاشة الدخول الأولى).
  tpl.licenseStatus =
    typeof _getLicenseStatusCacheOnly === "function"
      ? JSON.stringify(_getLicenseStatusCacheOnly())
      : "null";

  return (
    tpl
      .evaluate()
      .setTitle(
        "MOO.ERP v" +
          (_displayVer.version || "?") +
          " — Enterprise Resource Planning",
      )
      // [SEC-FIX-10] DEFAULT بدلاً من ALLOWALL — يمنع تضمين التطبيق في مواقع خارجية
      // ⚠️ ملاحظة: SAMEORIGIN لم تعد موجودة في enum الحالي (Apps Script الحديث)
      //    القيمتان المتاحتان فقط: ALLOWALL و DEFAULT.
      //    DEFAULT تحافظ على الحماية الطبيعية من X-Frame-Options (نفس الهدف الأمني)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT)
      .setSandboxMode(HtmlService.SandboxMode.IFRAME)
  );
}

/**
 * يقرأ محتوى ملف HTML آخر ويُرجعه كنص، لدمجه داخل قالب رئيسي عبر
 * `<?!= include('filename') ?>` (نمط التضمين القياسي في Apps Script
 * HtmlService لتقسيم واجهة الـ SPA الضخمة إلى عشرات الملفات).
 *
 * @param {String} filename - اسم ملف الـ HTML (بدون امتداد) داخل المشروع.
 * @returns {String} محتوى الملف كنص HTML خام.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * ping — دالة فحص اتصال خفيفة بدون أي بيانات حساسة أو اعتماد على
 * الجلسة، مُستخدَمة من:
 *   - client.js (GAS.ping()) — للتأكد إن رابط GAS_URL صحيح ومضبوط
 *     على "Anyone" من شاشة إعداد الاتصال في نسخة Vercel.
 *   - 31_JS_DataLayer.html (DL.debug.ping) — أداة تشخيص يدوية من
 *     الكونسول أثناء التطوير.
 * كانت مُستخدَمة من الفرونت من قبل بافتراض إنها موجودة، لكنها لم
 * تكن معرّفة إطلاقًا في الباك اند ولا في القائمة البيضاء — فشلت
 * صامتة تحت RPC المباشر القديم (google.script.run الحقيقي بيرجع
 * "TypeError: ... is not a function" بدل خطأ doPost واضح). بعد
 * التحويل لـ client.js كانت هترجع "Function not permitted: ping"
 * صراحة. تمت إضافتها هنا لإغلاق الفجوة.
 * @returns {Object} {ok: true, ts: <server epoch ms>}
 */
function ping() {
  // [FIX-VERSION-STATIC] ping() عامة (DOPOST_PUBLIC_FUNCTIONS) ومفيش
  // فيها أي بيانات حساسة، فبقت كمان قناة خفيفة (كاش-only، بدون أي
  // اتصال شبكة متزامن) لأي واجهة عايزة رقم الإصدار الحقيقي بعد التحميل
  // بدل placeholder — أساسًا نسخة Vercel الثابتة اللي مبيحصلش فيها
  // حقن appVersion وقت البناء (راجع scripts/build-static.js). نفس
  // المصدر الموحّد _umDisplayVersionInfo() المستخدم في كل مكان تاني.
  var version = "";
  try {
    version = _umDisplayVersionInfo().version || "";
  } catch (e) {
    // تجاهل — ping() يجب ألا يفشل أبدًا بسبب مشكلة في قراءة الإصدار
  }
  return { ok: true, ts: Date.now(), version: version };
}

function _lazyExtractInnerBlocks(html, tag) {
  var re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + "\\s*>", "gi");
  var out = [];
  var m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out.join("\n");
}

function _lazyExtractOuterBlocks(html, tag) {
  var re = new RegExp("<" + tag + "[^>]*>[\\s\\S]*?<\\/" + tag + "\\s*>", "gi");
  return html.match(re) || [];
}

/**
 * getLazyBundleCss — الجزء الأول اللي الفرونت-إند بينادّيه: كل الـ CSS
 * المؤجلة (شامل فونط Tabler Icons). بيتبعت لوحده لأنه مش كبير قد
 * الـ JS (لكن برضه بيتفصل عن باقي الأجزاء لتقليل حجم أي نداء واحد).
 * @returns {Object} {css: String}
 */
function getLazyBundleCss() {
  var css = _LAZY_STYLE_FILES.map(function (f) {
    // [FIX-LAZY-MISSING-FILE] لو ملف اتشال/اتغيّر اسمه من المشروع
    // ومتحدّثتش القايمة، HtmlService.createHtmlOutputFromFile كانت
    // بترمي استثناء بيفشّل الحزمة كلها (وبالتبعية كل الموديولات
    // المؤجلة، شامل الداشبورد نفسه). دلوقتي بنتجاهل الملف الناقص فقط
    // ونكمّل الباقي بدل ما نوقف تحميل النظام كله.
    try {
      var content = HtmlService.createHtmlOutputFromFile(f).getContent();
      return _lazyExtractInnerBlocks(content, "style");
    } catch (e) {
      console.error("getLazyBundleCss - ملف ناقص/اتغيّر اسمه: " + f + " — " + (e.message || e));
      return "";
    }
  }).join("\n");
  return { css: css };
}

/**
 * getLazyBundleMeta — بترجع عدد الأجزاء (chunks) اللي الفرونت-إند
 * لازم يطلبها بالترتيب عبر getLazyBundleChunk(i) عشان يجيب كل ملفات
 * الجافاسكريبت المؤجلة.
 * @returns {Object} {totalChunks: Number}
 */
function getLazyBundleMeta() {
  return {
    totalChunks: Math.ceil(_LAZY_SCRIPT_FILES.length / _LAZY_CHUNK_SIZE),
  };
}

/**
 * getLazyBundleChunk — بترجع جزء واحد بس من ملفات الجافاسكريبت
 * المؤجلة (بنفس ترتيبها الأصلي) بدل الحزمة كلها دفعة واحدة، عشان
 * نتفادى تقطّع نداء google.script.run الكبير اللي كان بيسبب
 * "Unexpected end of input".
 * @param {Number} chunkIndex - رقم الجزء (0-based)
 * @returns {Object} {js: String, html: String, isLast: Boolean}
 */
function getLazyBundleChunk(chunkIndex) {
  var idx = Number(chunkIndex) || 0;
  var start = idx * _LAZY_CHUNK_SIZE;
  var files = _LAZY_SCRIPT_FILES.slice(start, start + _LAZY_CHUNK_SIZE);
  var htmlFragments = [];

  var js = files
    .map(function (f) {
      // [FIX-LAZY-MISSING-FILE] نفس مبدأ getLazyBundleCss أعلاه — ملف
      // واحد ناقص ميوقفش تحميل باقي الموديولات المؤجلة كلها.
      try {
        var content = HtmlService.createHtmlOutputFromFile(f).getContent();
        var tpls = _lazyExtractOuterBlocks(content, "template");
        if (tpls.length) htmlFragments = htmlFragments.concat(tpls);
        return _lazyExtractInnerBlocks(content, "script");
      } catch (e) {
        console.error("getLazyBundleChunk#" + idx + " - ملف ناقص/اتغيّر اسمه: " + f + " — " + (e.message || e));
        return "";
      }
    })
    .join("\n;\n");

  return {
    js: js,
    html: htmlFragments.join("\n"),
    isLast: start + _LAZY_CHUNK_SIZE >= _LAZY_SCRIPT_FILES.length,
  };
}

/**
 * getLazyAppBundle — بترجع كل ملفات الـ Style/Templates/JS الخاصة
 * بموديولات النظام (المحاسبة، HR، التصنيع، الفواتير...) اللي
 * *مش* لازمة لعرض شاشة اللوجين نفسها، عشان الـ frontend يحمّلها
 * بشكل غير متزامن (async) في الخلفية بدل ما تتحقن كلها جوه
 * doGet/Index.html من الأول.
 *
 * ⚠️ [PERF-LAZY-LOAD] السبب: doGet القديم كان بيحقن ~6.5 ميجا نص
 * HTML/CSS/JS (كل الموديولات) في كل مرة حد يفتح رابط النظام، حتى
 * قبل ما يشوف شاشة اللوجين — HtmlService مبيعملش streaming، يعني
 * المتصفح ما بيستقبلش ولا بايت واحد لحد ما السيرفر يخلص بناء
 * الصفحة كاملة ويبعتها دفعة واحدة. ده كان بيسبب شاشة سودا لعدة
 * ثواني قبل ما حتى الـ Splash يظهر.
 *
 * الحل: doGet بقى بيحقن بس الملفات الضرورية لشاشة اللوجين (راجع
 * القايمة EAGER_ في Index.html)، وباقي الموديولات كلها بتتحمل من
 * هنا بعد أول رسم للصفحة (غالبًا وهي المستخدم لسه بيكتب بياناته)
 * عن طريق google.script.run من 01_JS_Core_Auth.html.
 *
 * ⚠️ لازم تفضل القايمتين (هنا و EAGER_ في Index.html) متطابقتين مع
 * بعض: أي ملف جديد يتضاف للنظام لازم يتحدد بوضوح إما Eager (لو
 * شاشة اللوجين محتاجاه) أو Lazy (يتضاف هنا).
 *
 * @returns {Object} {css: String, js: String} — النصوص الخام جاهزة
 *   للحقن مباشرة في <style>/<script> tags من الـ frontend.
 */
function getLazyAppBundle() {
  var lazyStyleFiles = [
    // [PERF-FIX-BLACKSCREEN] TablerIconsEmbedded كان بيتحقن Eager جوه
    // <head> في Index.html — وهو أكبر ملف في كل الحزمة (~891 KB نص خام،
    // فونط أيقونات Tabler كامل base64 لـ+5000 أيقونة). بما إن HtmlService
    // مبيعملش streaming، السيرفر كان لازم يبني ويبعت الصفحة كاملة (~1.7
    // ميجا شاملة الفونط ده) قبل ما المتصفح يستقبل ولا بايت — وده كان
    // السبب الرئيسي في الشاشة السودا لعدة ثواني قبل ظهور اللوجين.
    // الحل: نقلناه هنا (lazy) بدل Eager. الأيقونات هتظهر خلال جزء من
    // الثانية بعد أول رسم (نفس آلية باقي الموديولات المؤجلة) بدل ما
    // تُعطّل ظهور الصفحة كلها من الأول.
    "TablerIconsEmbedded",
    "Style_06_Dashboard",
    "Style_07_Accounting",
    "Style_08_Settings",
    "Style_09_Sidebar_Extra",
    "Style_10_Badges_Extra",
    "Style_11_Tail",
    "Style_12_InvoiceWorkspace",
    // ── [UPDATE-MGMT-MODULE] وحدة إدارة تحديثات النظام ──
    "Style_13_UpdateManagement",
    // ── [SELECTION-ENGINE] توكِنز/ستايل محرك الاختيار الموحّد AppSelect ──
    "Style_14_AppSelect",
  ];

  var lazyScriptFiles = [
    // [CONSOLE-FIX] SheetJS (xlsx) كانت بتتحمّل من CDN خارجي
    // (cdnjs.cloudflare.com) وده كان بيسبب رسائل "Tracking Prevention
    // blocked access to storage" في الكونسول. دلوقتي مضمّنة داخلياً
    // (SheetJS_Embedded.html) بنفس أسلوب TablerIconsEmbedded — وبنفس
    // السبب برضه لازم تفضل هنا (Lazy) مش Eager في Index.html، لأنها
    // ~880 KB (نفس حجم مشكلة الأيقونات اللي سبّبت الشاشة السودا).
    "SheetJS_Embedded",
    "SplitSelect",
    // ── [SELECTION-ENGINE] المحرك الموحّد — لازم يتحمّل قبل أي موديول
    //    شاشات (Templates_*, 03_JS_*...) عشان يبقى AppSelect متاح وقت
    //    ما الشاشات بتعمل init/upgrade لعناصرها ──
    "49_JS_SelectionEngine",
    // ── [TAB-ENGINE / المرحلة 7: Lazy Tabs] محرك التابات الموحّد — لازم
    //    يتحمّل قبل أي شاشة فيها تابات (HR, الفواتير, الموردين...) عشان
    //    يبقى TabEngine متاح وقت ما الشاشات بتعمل TabEngine.init() ──
    "50_JS_TabEngine",
    // ── [IMAGE-ENGINE / المرحلة 9] لازم يتحمّل قبل أي شاشة فيها أعمدة
    //    صور (الأصناف، المرفقات...) عشان ImageEngine يبقى متاح وقت
    //    ما ColumnEngine بينادّي init() تلقائيًا بعد كل رسم ──
    "51_JS_ImageEngine",
    "Templates_02",
    "Templates_03",
    "Templates_04",
    "Templates_05",
    "Templates_06",
    "Templates_07",
    "Templates_08",
    "Templates_09",
    "Templates_10",
    "03_JS_Dashboard_Items",
    "04_JS_Transactions",
    "05_JS_Production",
    "06_JS_Catalog_Stock",
    "07_JS_Shipping_Colors_Excel",
    "08_JS_Users_Branding",
    "09_JS_AIAssistant",
    "10_JS_Settings_Search_Parties",
    "11_JS_Accounting",
    "12_JS_HR",
    "13_JS_AttendanceImport",
    "14_JS_DeviceConnect",
    "15_JS_Invoices",
    "22_JS_PurchaseOrders",
    "40_JS_PurchaseRequests",
    "16_JS_VodafoneCash",
    "17_JS_ExecutiveDashboard",
    "18_JS_Reports",
    "21_JS_AudioService",
    "19_JS_WhatsApp",
    "20_JS_ContextMenu",
    "23_JS_PostingConfig_FixedAssets",
    "24_JS_UserPreferences",
    "25_JS_ReportsRouting",
    "26_JS_DashboardFramework",
    "27_JS_Manufacturing",
    "28_JS_WhatsAppGateway",
    "29_JS_InvoiceWorkspace",
    "30_JS_CommunicationHub",
    "34_JS_ColumnEngine",
    "35_JS_PartyCategories",
    "36_JS_WhatsAppHub",
    "37_JS_ImportWizard",
    // ── [UPDATE-MGMT-MODULE] وحدة إدارة تحديثات النظام ──
    "41_JS_UpdateManagement",
    // ── [DATA-LOADING-ENGINE / تدقيق المرحلة 15] الملفات دي كانت موجودة
    //    فعليًا في المشروع (مكتوبة ومُختبرة) لكن مش مُدرَجة هنا ولا في أي
    //    include ثابت في Index.html — يعني كانت "كود ميت" فعليًا: بتتحمّل
    //    على القرص بس الـ browser ما بيشوفهاش خالص. أُضيفت هنا الآن عشان
    //    تشتغل فعليًا؛ الإضافة أمنة (additive فقط) لأنها مش كانت متحمّلة
    //    من الأساس فمفيش سلوك حالي ممكن ينكسر.
    "42_JS_DateEngine",
    "43_JS_NumberEngine",
    "44_JS_NotificationEngine",
    "45_JS_SearchEngine",
    "46_JS_ReportEngine",
    "47_JS_PreferenceEngine",
    "33_JS_ReportDataLayer",
    // ── [ATTACHMENT-ENGINE / المرحلة 10] محرك المرفقات الكسول — يعتمد
    //    على ImageEngine (51) فلازم يتحمّل بعده ──
    "55_JS_AttachmentEngine",
    // [INV-SETTINGS-2026-08-07] شاشة إعدادات المخزون العامة — بتعتمد على
    // 50_JS_TabEngine (تابات) فلازم تتحمّل بعده، ومكانها هنا زي بقية
    // شاشات الإعدادات المتخصصة (23/24_JS_...).
    "57_JS_InventorySettings",
    // [CUST-SETTINGS-2026-08-07] / [INV2-SETTINGS-2026-08-07] شاشتا إعدادات
    // العملاء والفواتير العامة — بتعتمدوا على 50_JS_TabEngine (تابات) نفس
    // 57_JS_InventorySettings، فلازم يتحمّلوا بعده.
    "60_JS_CustomerSettings",
    "61_JS_InvoiceSettings",
    // ── [PERF-HARNESS / المرحلة 16] أداة قياس اختيارية (?perf=1) ──
    "56_JS_PerfHarness",
  ];

  // [FIX-AUDIT-2026] كانت الدالة بترجع محتوى الملف الخام زي ما هو، شامل
  // الـ wrapper tags الحرفية <script>...</script> / <style>...</style>،
  // وده شغال تمام لما بيتحقن كـ HTML حقيقي (زي include() في doGet)، لكن هنا
  // الناتج بيتحط كـ scriptEl.textContent / styleEl.textContent — يعني نص
  // الـ JS بيبقى فيه سلسلة حرفية "<script>" و"</script>" وسطه، وده كسر
  // syntax أكيد (رمى "Uncaught SyntaxError ... Unexpected token '>'" لكل
  // مستخدم فور تحميل شاشة اللوجين، وبيكسر كل الموديولات المؤجلة بالكامل:
  // الداشبورد، المحاسبة، HR، الفواتير... إلخ).
  //
  // الحل: نستخرج محتوى كل <script>/<style> بلوكات فعليًا (مش مجرد قص أول/آخر
  // تاج) عشان بعض الملفات فيها أكتر من بلوك واحد (Templates_05.html مثلاً
  // فيه بلوكين <script> وبينهم عنصر <template id="tpl-upload-modal"> حقيقي
  // بيتقرا لاحقًا بـ document.getElementById() من 07_JS_Shipping_Colors_Excel).
  // أي HTML حقيقي زي الـ <template> ده لازم يتحقن في الـ DOM الفعلي مش جوه
  // نص سكريبت، فبنجمّعه لوحده في bundle.html بدل ما يكسر الـ JS.
  function _extractInnerBlocks(html, tag) {
    var re = new RegExp(
      "<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + "\\s*>",
      "gi",
    );
    var out = [];
    var m;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out.join("\n");
  }
  function _extractOuterBlocks(html, tag) {
    var re = new RegExp(
      "<" + tag + "[^>]*>[\\s\\S]*?<\\/" + tag + "\\s*>",
      "gi",
    );
    return html.match(re) || [];
  }

  var htmlFragments = [];

  var css = lazyStyleFiles
    .map(function (f) {
      // [FIX-LAZY-MISSING-FILE] ملف واحد ناقص/اتغيّر اسمه كان بيرمي
      // استثناء يفشّل getLazyAppBundle بالكامل، وبالتبعية كل الموديولات
      // المؤجلة (branding, engines...) عمرها ما بتتحمّل خالص — بنتجاهل
      // الملف الناقص فقط ونكمّل الباقي.
      try {
        var content = HtmlService.createHtmlOutputFromFile(f).getContent();
        return _extractInnerBlocks(content, "style");
      } catch (e) {
        console.error("getLazyAppBundle(css) - ملف ناقص/اتغيّر اسمه: " + f + " — " + (e.message || e));
        return "";
      }
    })
    .join("\n");

  var js = lazyScriptFiles
    .map(function (f) {
      try {
        var content = HtmlService.createHtmlOutputFromFile(f).getContent();
        var tpls = _extractOuterBlocks(content, "template");
        if (tpls.length) htmlFragments = htmlFragments.concat(tpls);
        return _extractInnerBlocks(content, "script");
      } catch (e) {
        console.error("getLazyAppBundle(js) - ملف ناقص/اتغيّر اسمه: " + f + " — " + (e.message || e));
        return "";
      }
    })
    .join("\n;\n");

  return { css: css, js: js, html: htmlFragments.join("\n") };
}

/**
 * يُرجع رابط الـ Web App الحالي المنشور، تستخدمه الواجهة لبناء روابط
 * مطلقة (مثل روابط الكتالوج العام التي تُشارك مع العملاء).
 *
 * @returns {String} رابط الـ Web App.
 */
function getScriptUrl() {
  return ScriptApp.getService().getUrl();
}

/**
 * getCatalogPublicData — بيانات الكتالوج للعملاء الخارجيين.
 *
 * ما يُعرض:   id · name · description · group · unit ·
 *             image_url · colors_json · selling_price ·
 *             حالة المخزون · stockByWarehouse
 * ما يُحجب:  cost_price · بيانات المستخدمين · الحركات
 *
 * يُستدعى من CatalogPublic.html عبر:
 *   google.script.run.withSuccessHandler(fn).getCatalogPublicData();
 */
function getCatalogPublicData(urlGroupsParam, urlWhParam) {
  try {
    var items = readSheet("Items", null, {
      trimStrings: true,
      parseJson: ["colors_json"],
    });
    var stock = readSheet("Stock");
    var openingRaw = readSheet("OpeningStock", OPENING_STOCK_HEADERS);
    var groups = readSheet("Groups", null, { trimStrings: true });
    var colors = readSheet("Colors", null, { trimStrings: true });

    // ── تحليل فلاتر الـ URL ──────────────────────────────────
    var filterGroupIds = (urlGroupsParam || "")
      .split(",")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);

    // [VERCEL-MIGRATION] الفرع ده كان لوحده جوه doGet قبل كده (بيحوّل
    // IDs المخازن اللي جايين من الرابط لأسماء، لأن stock.warehouse
    // مخزّن كـ name مش id). بعد ما catalog.html بقت static ومبتمرش
    // على doGet، الدالة دي هي أول نقطة سيرفر بتشوف الفلتر، فنقلنا
    // نفس منطق التحويل لهنا حرفيًا عشان روابط الكتالوج القديمة
    // (اللي فيها IDs) تفضل شغالة زي ما هي بالظبط بدون كسر.
    var rawWhTokens = (urlWhParam || "")
      .split(",")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);

    var filterWhNames = rawWhTokens;
    if (rawWhTokens.length) {
      try {
        var warehousesForFilter = readSheet("Warehouses");
        filterWhNames = rawWhTokens.map(function (token) {
          var found = warehousesForFilter.filter(function (w) {
            return String(w.id).trim() === token;
          });
          // لو التوكن مطابق لـ id معروف → استخدم الاسم، وإلا سيبه
          // زي ما هو (يبقى غالبًا اسم مخزن اتبعت مباشرة أصلاً)
          return found.length ? String(found[0].name).trim() : token;
        });
      } catch (whErr) {
        filterWhNames = rawWhTokens; // fallback لو فشلت قراءة Warehouses
      }
    }

    // ── احسب الرصيد لكل صنف (إجمالي + تفصيل بالمخزن) ──────────
    var stockMap = {}; // { item_id: totalQty }
    var whMap = {}; // { item_id: { warehouse_name: qty } }

    stock.forEach(function (s) {
      var id = String(s.item_id || "").trim();
      var wh = String(s.warehouse || "").trim();
      var qty = Number(s.quantity || 0);
      if (!id) return;
      // لو في فلتر مخزن → احسب الإجمالي للمخازن المختارة فقط
      if (filterWhNames.length) {
        if (filterWhNames.indexOf(wh) !== -1) {
          stockMap[id] = (stockMap[id] || 0) + qty;
        }
      } else {
        stockMap[id] = (stockMap[id] || 0) + qty;
      }
      if (wh) {
        if (!whMap[id]) whMap[id] = {};
        whMap[id][wh] = (whMap[id][wh] || 0) + qty;
      }
    });

    // أضف Opening Stock للإجمالي (فقط لو مفيش فلتر مخزن)
    if (!filterWhNames.length) {
      openingRaw.forEach(function (o) {
        var id = String(o.item_id || "").trim();
        var qty = Number(o.quantity || 0);
        if (!id) return;
        stockMap[id] = (stockMap[id] || 0) + qty;
      });
    }

    // ── نقي بيانات الأصناف ───────────────────────────────────
    var pubItems = items.map(function (it) {
      var totalQty = stockMap[String(it.id || "").trim()] || 0;
      var minQty = Number(it.min_qty || 0);
      var status;
      if (totalQty <= 0) status = "out";
      else if (minQty > 0 && totalQty <= minQty) status = "low";
      else status = "available";

      return {
        id: String(it.id || ""),
        code: String(it.code || it.id || ""),
        name: String(it.name || ""),
        description: String(it.description || ""),
        group: String(it.group || ""),
        unit: String(it.unit || ""),
        image_url: String(it.image_url || ""),
        selling_price: Number(it.selling_price || 0),
        colors_json: it.colors_json || [],
        min_qty: minQty,
        pub_qty: totalQty,
        status: status,
      };
    });

    // ── فلتر المجموعات على السيرفر ───────────────────────────
    if (filterGroupIds.length) {
      pubItems = pubItems.filter(function (it) {
        return filterGroupIds.indexOf(String(it.group || "")) !== -1;
      });
    }

    // ── نقي بيانات المجموعات (فقط المجموعات المستخدمة) ──────
    var usedGroups = {};
    pubItems.forEach(function (it) {
      if (it.group) usedGroups[it.group] = true;
    });
    var pubGroups = groups
      .filter(function (g) {
        return usedGroups[String(g.id || "")];
      })
      .map(function (g) {
        return { id: String(g.id || ""), name: String(g.name || "") };
      });

    // ── نقي بيانات الألوان ───────────────────────────────────
    var pubColors = colors.map(function (c) {
      return {
        id: String(c.id || ""),
        name: String(c.name || ""),
        code: String(c.code || ""),
        hex: String(c.hex || ""),
      };
    });

    return {
      success: true,
      items: pubItems,
      groups: pubGroups,
      colors: pubColors,
      generated_at: new Date().toISOString(),
    };
  } catch (e) {
    console.error("getCatalogPublicData error:", e.message);
    return {
      success: false,
      message: "تعذّر تحميل الكتالوج — يرجى المحاولة لاحقاً",
    };
  }
}

