/**
 * ============================================================
 * Module: Code_31_i18n_Engine.gs
 *
 * Description:
 *   محرك الترجمة المركزي (Translation Engine) لنظام MOO.ERP.
 *   يوفر طبقة موحّدة لجلب قواميس الترجمة، تحديد لغة المستخدم
 *   الحالية، تبديل اللغة، وإدارة إعداد "فرض لغة موحّدة على كل
 *   المستخدمين" على مستوى النظام.
 *
 *   القواميس نفسها (النصوص الفعلية) لا توجد في هذا الملف — هي
 *   موجودة في ملفات منفصلة بمسمى Data_i18n_<lang>.gs (كل لغة في
 *   ملف مستقل)، ويتم تجميعها هنا في I18N_REGISTRY. هذا يحاكي
 *   فكرة مجلد /i18n/*.json في أنظمة الويب العادية — لكن بما أن
 *   Google Apps Script لا يدعم مجلدات فرعية أو قراءة ملفات JSON
 *   من القرص مباشرة، الحل المعتمد في بيئة GAS هو: كل لغة = ملف
 *   .gs منفصل يحتوي على متغيّر عام واحد (كائن Key→Text)، ويُحمَّل
 *   بالكامل مع باقي الكود تلقائيًا (لا حاجة لأي "تحميل" يدوي على
 *   الباك-إند). التحميل الكسول (Lazy Loading) الحقيقي يحدث على
 *   الفرونت-إند: المتصفح يطلب قاموس لغة واحدة فقط في كل مرة عبر
 *   google.script.run، وليس كل اللغات معًا.
 *
 * Responsibilities:
 *   - تسجيل اللغات المدعومة ومعلوماتها (اسم، اتجاه، علم).
 *   - جلب قاموس ترجمة كامل للغة واحدة + Fallback التلقائي.
 *   - تحديد لغة المستخدم الحالية (تفضيل شخصي أو لغة مفروضة من
 *     النظام أو اللغة الافتراضية).
 *   - حفظ اختيار المستخدم للغة (تُبنى فوق USER_PREFS الموجودة
 *     أصلاً في Code_23_UserPreferences.gs — لا تكرار).
 *   - إدارة إعداد "فرض لغة واحدة على الجميع" (System Setting عبر
 *     PropertiesService — لا يتطلب شيت جديد).
 *
 * Dependencies:
 *   - Data_i18n_ar.gs / Data_i18n_en.gs (وأي لغة تُضاف لاحقًا).
 *   - Code_23_UserPreferences.gs (getUserPreferences/saveUserPreference).
 *   - Code_12_Core.gs (يجب إضافة أسماء الدوال هنا إلى Allowlist
 *     الخاص بـ doPost — راجع قسم "خطوات الدمج" أسفل الملف).
 *
 * Used By:
 *   - جميع ملفات الواجهة عبر 32_JS_i18n_Client.html.
 *
 * ============================================================
 */

// ════════════════════════════════════════════════════════════════
// القسم 1: تسجيل اللغات المدعومة (Language Registry)
// ════════════════════════════════════════════════════════════════
// لإضافة لغة جديدة مستقبلاً (فرنسي/تركي/ألماني/إسباني):
//   1) أنشئ ملف Data_i18n_<code>.gs جديد على نفس نمط Data_i18n_en.gs
//      (كائن باسم I18N_DICT_<CODE> يحتوي كل المفاتيح).
//   2) أضف سطر واحد هنا في I18N_LANGUAGES.
//   3) أضف اسم القاموس داخل I18N_REGISTRY أسفل هذا القسم.
// لا حاجة لتعديل أي شاشة أو أي كود آخر في النظام.

// ============================================================
//  التوحيد المعماري (Architecture Unification):
//  المحرك ده كان قبل كده مجرد دوال Global بدل namespace موحّد زي باقي
//  المحركات (BusinessRulesEngine / DataLayerEngine / FileEngine /
//  ValidationEngine / PaymentEngine / WorkflowEngine). دلوقتي كل حاجة
//  داخلية (I18N_LANGUAGES + _i18nRegistry + كل الثوابت) بقت خاصة (private)
//  جوه IIFE واحد، والوصول ليها بس عبر I18nEngine.<method>. الدوال العامة
//  القديمة (getTranslationDictionary/i18nT/...) اتسابت بنفس الاسم بالظبط
//  عشان أي كود موجود فعلاً في Code_18_Permissions.gs أو Code_20_Sales.gs
//  أو 38_JS_i18n_Client.html يفضل شغال من غير أي تعديل — لكن جسمها بقى
//  مجرد تفويض (delegate) لـ I18nEngine.
// ============================================================

var I18nEngine = (function () {
  "use strict";

  var I18N_LANGUAGES = {
    ar: { code: "ar", label: "العربية", flag: "", dir: "rtl" },
    en: { code: "en", label: "English", flag: "", dir: "ltr" },
    // أمثلة جاهزة للتوسع المستقبلي (معلّقة حتى تُبنى قواميسها):
    // fr: { code: "fr", label: "Français", flag: "", dir: "ltr" },
    // tr: { code: "tr", label: "Türkçe", flag: "", dir: "ltr" },
    // de: { code: "de", label: "Deutsch", flag: "", dir: "ltr" },
    // es: { code: "es", label: "Español", flag: "", dir: "ltr" }
  };

  var I18N_DEFAULT_LANG = "ar";
  var I18N_FALLBACK_LANG = "ar"; // إذا نقص مفتاح في أي لغة يُستخدم منها

  // مفتاح PropertiesService لإعداد "فرض لغة واحدة على الجميع"
  var I18N_PROP_FORCE_LANG = "I18N_FORCE_LANGUAGE"; // "" = غير مفروض
  var I18N_PROP_DEFAULT_LANG = "I18N_SYSTEM_DEFAULT_LANGUAGE";

  /**
   * سجل القواميس: يربط كود اللغة بالمتغيّر العام الذي يحمل نصوصها.
   * كل قاموس يُضاف في ملف Data_i18n_<lang>.gs مستقل (راجع رأس الملف).
   */
  function _i18nRegistry() {
    return {
      ar: typeof I18N_DICT_AR !== "undefined" ? I18N_DICT_AR : {},
      en: typeof I18N_DICT_EN !== "undefined" ? I18N_DICT_EN : {},
      // fr: typeof I18N_DICT_FR !== 'undefined' ? I18N_DICT_FR : {},
    };
  }

  // ════════════════════════════════════════════════════════════════
  // القسم 2: جلب القاموس (مع Fallback تلقائي بدون نصوص فاضية)
  // ════════════════════════════════════════════════════════════════

  /**
   * يرجّع قاموس لغة واحدة فقط (Lazy Loading الحقيقي: الفرونت بيطلب
   * لغة واحدة، مش كل اللغات). أي مفتاح ناقص في اللغة المطلوبة يتم
   * سحبه تلقائيًا من لغة الـ Fallback عشان محدش يشوف مفتاح فاضي
   * أو نص خطأ في الواجهة.
   *
   * @param {string} lang - كود اللغة المطلوبة (مثال: "ar", "en")
   * @return {{lang:string, dir:string, label:string, dict:Object, meta:Object}}
   */
  function getTranslationDictionary(lang) {
    var registry = _i18nRegistry();
    var langInfo = I18N_LANGUAGES[lang]
      ? I18N_LANGUAGES[lang]
      : I18N_LANGUAGES[I18N_DEFAULT_LANG];
    var code = langInfo.code;

    var primary = registry[code] || {};
    var fallback = registry[I18N_FALLBACK_LANG] || {};

    // دمج: القاموس الأساسي أولاً، وأي مفتاح ناقص فيه يُستكمل من الـ Fallback
    var merged = {};
    for (var fk in fallback) merged[fk] = fallback[fk];
    for (var pk in primary) merged[pk] = primary[pk];

    // Compatibility map for legacy templates which still contain a literal UI
    // label. It maps only known fallback UI text to its selected-language value;
    // it never touches database fields or internal identifiers.
    var legacyTextMap = {};
    if (code !== I18N_FALLBACK_LANG) {
      for (var lk in fallback) {
        if (
          typeof fallback[lk] === "string" &&
          typeof merged[lk] === "string" &&
          fallback[lk] !== merged[lk]
        ) {
          legacyTextMap[fallback[lk]] = merged[lk];
        }
      }
    }

    return {
      lang: code,
      dir: langInfo.dir,
      label: langInfo.label,
      dict: merged,
      meta: {
        availableLanguages: getAvailableLanguages(),
        legacyTextMap: legacyTextMap,
      },
    };
  }

  /** قائمة اللغات المتاحة للعرض في قائمة اختيار اللغة بالواجهة */
  function getAvailableLanguages() {
    var list = [];
    for (var code in I18N_LANGUAGES) {
      list.push(I18N_LANGUAGES[code]);
    }
    return list;
  }

  // ════════════════════════════════════════════════════════════════
  // القسم 3: تحديد لغة المستخدم الحالية + الفرض على مستوى النظام
  // ════════════════════════════════════════════════════════════════

  /**
   * يحدد اللغة الفعلية التي يجب عرضها للمستخدم الحالي، بالأولوية:
   *   1) لغة مفروضة على مستوى النظام (I18N_PROP_FORCE_LANG) إن وُجدت
   *      → تتجاوز اختيار المستخدم الشخصي (سيناريو "لغة موحّدة إجبارية").
   *   2) تفضيل المستخدم الشخصي المحفوظ (UserPreferences.language).
   *   3) اللغة الافتراضية للنظام (I18N_PROP_DEFAULT_LANG أو I18N_DEFAULT_LANG).
   *
   * @param {string} callerUser
   * @param {string} sessionToken
   */
  function resolveUserLanguage(callerUser, sessionToken) {
    var props = PropertiesService.getScriptProperties();
    var forced = props.getProperty(I18N_PROP_FORCE_LANG);
    if (forced && I18N_LANGUAGES[forced]) return forced;

    try {
      var prefs = getUserPreferences(callerUser, sessionToken);
      var userLang = prefs && prefs.data && prefs.data.language;
      if (userLang && I18N_LANGUAGES[userLang]) return userLang;
    } catch (e) {
      // مستخدم غير مسجل دخول بعد (شاشة اللوجن) — نكمل باللغة الافتراضية
    }

    var sysDefault = props.getProperty(I18N_PROP_DEFAULT_LANG);
    if (sysDefault && I18N_LANGUAGES[sysDefault]) return sysDefault;

    return I18N_DEFAULT_LANG;
  }

  /**
   * نقطة الدخول الرئيسية التي تستدعيها الواجهة عند الإقلاع (bootstrap)
   * وعند كل تغيير لغة: ترجع اللغة الفعّالة + اتجاهها + قاموسها كاملاً
   * دفعة واحدة (استدعاء شبكة واحد بدل استدعاءين).
   */
  function getI18nBootstrap(callerUser, sessionToken) {
    var lang = resolveUserLanguage(callerUser, sessionToken);
    var result = getTranslationDictionary(lang);
    var props = PropertiesService.getScriptProperties();
    result.forced = !!props.getProperty(I18N_PROP_FORCE_LANG);
    return result;
  }

  /**
   * يغيّر لغة المستخدم الحالي ويحفظها كتفضيل شخصي (يبني فوق
   * saveUserPreference الموجودة أصلاً — بدون تخزين جديد).
   * يرجع القاموس الجديد مباشرة لتفادي رحلة شبكة إضافية من الواجهة.
   */
  function setUserLanguage(callerUser, lang, sessionToken) {
    if (!I18N_LANGUAGES[lang]) {
      throw new Error("اللغة المطلوبة غير مدعومة: " + lang);
    }
    var props = PropertiesService.getScriptProperties();
    var forced = props.getProperty(I18N_PROP_FORCE_LANG);
    if (forced) {
      throw new Error(
        "لا يمكن تغيير اللغة: مسؤول النظام فرض لغة موحّدة على جميع المستخدمين.",
      );
    }
    saveUserPreference({ key: "language", value: lang }, sessionToken);
    return getTranslationDictionary(lang);
  }

  // ════════════════════════════════════════════════════════════════
  // القسم 4: إعدادات النظام العامة للّغة (لوحة تحكم المسؤول)
  // ════════════════════════════════════════════════════════════════

  /**
   * يفرض لغة واحدة على جميع المستخدمين (أو يلغي الفرض بتمرير "").
   * يجب حماية هذه الدالة بصلاحية إدارية عند ربطها بشاشة الإعدادات
   * (استخدم _checkPermission الموجودة في Code_18_Permissions.gs).
   */
  function setSystemForcedLanguage(callerUser, lang, sessionToken) {
    // [FAIL-CLOSED] لازم _checkPermission موجودة فعلاً — أي حالة غير متوقعة
    // (ملف الصلاحيات غير محمّل) توقف التنفيذ بدل ما تتجاوزه بصمت.
    if (typeof _checkPermission !== "function") {
      throw new Error("تعذر التحقق من الصلاحيات — نظام الصلاحيات غير محمّل");
    }
    var permErr = _checkPermission(callerUser, "settings_manage", sessionToken);
    if (permErr) throw new Error(permErr.message);
    var props = PropertiesService.getScriptProperties();
    if (!lang) {
      props.deleteProperty(I18N_PROP_FORCE_LANG);
    } else {
      if (!I18N_LANGUAGES[lang]) throw new Error("لغة غير مدعومة: " + lang);
      props.setProperty(I18N_PROP_FORCE_LANG, lang);
    }
    return { ok: true, forced: lang || null };
  }

  /** يحدد اللغة الافتراضية للنظام (تُستخدم لأي مستخدم بدون تفضيل شخصي محفوظ) */
  function setSystemDefaultLanguage(callerUser, lang, sessionToken) {
    // [FAIL-CLOSED] لازم _checkPermission موجودة فعلاً — أي حالة غير متوقعة
    // (ملف الصلاحيات غير محمّل) توقف التنفيذ بدل ما تتجاوزه بصمت.
    if (typeof _checkPermission !== "function") {
      throw new Error("تعذر التحقق من الصلاحيات — نظام الصلاحيات غير محمّل");
    }
    var permErr = _checkPermission(callerUser, "settings_manage", sessionToken);
    if (permErr) throw new Error(permErr.message);
    if (!I18N_LANGUAGES[lang]) throw new Error("لغة غير مدعومة: " + lang);
    PropertiesService.getScriptProperties().setProperty(
      I18N_PROP_DEFAULT_LANG,
      lang,
    );
    return { ok: true, defaultLanguage: lang };
  }

  function getSystemLanguageSettings(callerUser, sessionToken) {
    var props = PropertiesService.getScriptProperties();
    return {
      forced: props.getProperty(I18N_PROP_FORCE_LANG) || null,
      systemDefault:
        props.getProperty(I18N_PROP_DEFAULT_LANG) || I18N_DEFAULT_LANG,
      available: getAvailableLanguages(),
    };
  }

  /**
   * Exports one catalogue as portable JSON.  This is deliberately an API
   * response (rather than a browser-generated file) so administrators can put
   * it under translation management/version control without exposing all
   * catalogues to normal users.
   */
  function exportTranslationDictionary(callerUser, lang, sessionToken) {
    // [FAIL-CLOSED] لازم _checkPermission موجودة فعلاً — أي حالة غير متوقعة
    // (ملف الصلاحيات غير محمّل) توقف التنفيذ بدل ما تتجاوزه بصمت.
    if (typeof _checkPermission !== "function") {
      throw new Error("تعذر التحقق من الصلاحيات — نظام الصلاحيات غير محمّل");
    }
    var permErr = _checkPermission(callerUser, "settings_manage", sessionToken);
    if (permErr) throw new Error(permErr.message);
    if (!I18N_LANGUAGES[lang]) throw new Error(i18nT("ERR_UNSUPPORTED_LANGUAGE"));
    return {
      language: lang,
      direction: I18N_LANGUAGES[lang].dir,
      translations: getTranslationDictionary(lang).dict,
      json: JSON.stringify(getTranslationDictionary(lang).dict, null, 2),
    };
  }

  /**
   * Validates an imported catalogue before it is accepted by an integration.
   * Runtime dictionaries in this Apps Script deployment are source-controlled
   * Data_i18n_<lang>.gs files; this endpoint is intentionally validation-only
   * so an uploaded file can never overwrite executable project code.
   */
  function importTranslationDictionary(callerUser, lang, jsonText, sessionToken) {
    // [FAIL-CLOSED] لازم _checkPermission موجودة فعلاً — أي حالة غير متوقعة
    // (ملف الصلاحيات غير محمّل) توقف التنفيذ بدل ما تتجاوزه بصمت.
    if (typeof _checkPermission !== "function") {
      throw new Error("تعذر التحقق من الصلاحيات — نظام الصلاحيات غير محمّل");
    }
    var permErr = _checkPermission(callerUser, "settings_manage", sessionToken);
    if (permErr) throw new Error(permErr.message);
    if (!I18N_LANGUAGES[lang]) throw new Error(i18nT("ERR_UNSUPPORTED_LANGUAGE"));
    var parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(i18nT("ERR_INVALID_TRANSLATION_JSON"));
    }
    if (!parsed || Object.prototype.toString.call(parsed) !== "[object Object]") {
      throw new Error(i18nT("ERR_INVALID_TRANSLATION_JSON"));
    }
    var invalid = [],
      source = _i18nRegistry()[I18N_FALLBACK_LANG] || {};
    for (var key in parsed) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof parsed[key] !== "string")
        invalid.push(key);
    }
    if (invalid.length)
      throw new Error(
        i18nT("ERR_INVALID_TRANSLATION_KEYS", { count: invalid.length }),
      );
    var missing = [];
    for (var sourceKey in source)
      if (parsed[sourceKey] === undefined) missing.push(sourceKey);
    return {
      ok: true,
      language: lang,
      importedKeys: Object.keys(parsed).length,
      missingKeys: missing,
    };
  }

  /**
   * Controlled migration fallback for legacy UI literals not yet represented by
   * a catalogue key. Results are cached and returned in batches; no database
   * identifiers or data fields are supplied by the browser client.
   */
  function translateLegacyUiText(callerUser, texts, sessionToken) {
    var session =
      typeof validateSession === "function"
        ? validateSession(sessionToken)
        : null;
    if (
      !session ||
      !session.valid ||
      String(session.username || "").toLowerCase() !==
        String(callerUser || "").toLowerCase()
    ) {
      throw new Error(i18nT("MSG_MUST_LOGIN"));
    }
    if (!Array.isArray(texts)) return { translations: {} };
    // [CACHE-ENGINE / المرحلة 13] كان هنا CacheService.getScriptCache()
    // مباشرة برقم TTL ثابت (21600) مكتوب يدويًا. دلوقتي بيمر عبر
    // CacheEngine الموحّد: namespace واحد معروف (CACHE_NAMESPACE.I18N)
    // + TTL من سياسة موحّدة (CACHE_POLICY.TRANSLATION) بدل رقم سايب —
    // لو حد غيّر سياسة كل الترجمات مستقبلاً، بيتغيّر من مكان واحد بس.
    var result = {},
      unique = {};
    texts.slice(0, 25).forEach(function (text) {
      if (typeof text !== "string") return;
      text = text.trim();
      if (text.length < 2 || text.length > 180 || unique[text]) return;
      unique[text] = true;
      var digest = Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        text,
      );
      var cacheKey =
        "en_" +
        Utilities.base64EncodeWebSafe(digest)
          .replace(/[^A-Za-z0-9]/g, "")
          .slice(0, 32);
      var cached = CacheEngine.get(CacheEngine.NAMESPACE.I18N, cacheKey);
      if (cached) {
        result[text] = cached;
        return;
      }
      try {
        var translated = LanguageApp.translate(text, "ar", "en");
        if (translated && translated !== text) {
          result[text] = translated;
          CacheEngine.set(
            CacheEngine.NAMESPACE.I18N,
            cacheKey,
            translated,
            CacheEngine.POLICY.TRANSLATION,
          );
        }
      } catch (e) {
        // A quota/transient failure must never block the current screen.
      }
    });
    return { translations: result };
  }

  // ════════════════════════════════════════════════════════════════
  // القسم 5: ترجمة من الباك-إند مباشرة (لرسائل الأخطاء/النجاح التي
  // تُبنى داخل ملفات Code_*.gs قبل إرسالها للفرونت-إند عبر errResponse
  // أو return {message: ...}). يُستخدم فقط عندما يكون توليد الرسالة
  // من طرف السيرفر ضروريًا (مثال: رسالة خطأ تحتوي على تفاصيل ديناميكية
  // من e.message). الشاشات نفسها يجب أن تعتمد على I18N.t() في الفرونت.
  // ════════════════════════════════════════════════════════════════

  /**
   * يترجم مفتاحًا واحدًا مباشرة من الباك-إند بلغة مُحدَّدة (أو لغة
   * المستخدم الحالي إذا لم تُمرَّر). يُستخدم داخل try/catch في ملفات
   * Code_*.gs بدلاً من كتابة رسالة عربية ثابتة مباشرة.
   * مثال: i18nT("ERR_FETCH_CUSTOMERS", lang) + ": " + e.message
   * @param {string} key
   * @param {string} [lang] - كود اللغة؛ افتراضيًا I18N_DEFAULT_LANG
   * @param {Object} [vars] - قيم لاستبدال {{var}} داخل النص
   */
  function i18nT(key, lang, vars) {
    var registry = _i18nRegistry();
    var code = lang && I18N_LANGUAGES[lang] ? lang : I18N_DEFAULT_LANG;
    var primary = registry[code] || {};
    var fallback = registry[I18N_FALLBACK_LANG] || {};
    var text = primary[key] !== undefined ? primary[key] : fallback[key];
    if (text === undefined) return "⟦" + key + "⟧";
    if (vars) {
      for (var k in vars) {
        text = text.replace(new RegExp("{{\\s*" + k + "\\s*}}", "g"), vars[k]);
      }
    }
    return text;
  }

  return {
    getTranslationDictionary: getTranslationDictionary,
    getAvailableLanguages: getAvailableLanguages,
    resolveUserLanguage: resolveUserLanguage,
    getI18nBootstrap: getI18nBootstrap,
    setUserLanguage: setUserLanguage,
    setSystemForcedLanguage: setSystemForcedLanguage,
    setSystemDefaultLanguage: setSystemDefaultLanguage,
    getSystemLanguageSettings: getSystemLanguageSettings,
    exportTranslationDictionary: exportTranslationDictionary,
    importTranslationDictionary: importTranslationDictionary,
    translateLegacyUiText: translateLegacyUiText,
    t: i18nT,
    LANGUAGES: I18N_LANGUAGES,
    DEFAULT_LANG: I18N_DEFAULT_LANG,
  };
})();

// ─────────────────────────────────────────────────────────────
// §I18N-6  دوال عامة (Global) للتوافق الخلفي — نفس الأسماء المستخدَمة
// فعليًا في Code_18_Permissions.gs / Code_20_Sales.gs / 38_JS_i18n_Client.html
// وفي القائمة البيضاء (Allowlist) بـ Code_12_Core.gs. كل واحدة بس تفويض
// (delegate) لـ I18nEngine.
// ─────────────────────────────────────────────────────────────

function getTranslationDictionary(lang) {
  return I18nEngine.getTranslationDictionary(lang);
}

function getAvailableLanguages() {
  return I18nEngine.getAvailableLanguages();
}

function resolveUserLanguage(callerUser, sessionToken) {
  return I18nEngine.resolveUserLanguage(callerUser, sessionToken);
}

function getI18nBootstrap(callerUser, sessionToken) {
  return I18nEngine.getI18nBootstrap(callerUser, sessionToken);
}

function setUserLanguage(callerUser, lang, sessionToken) {
  return I18nEngine.setUserLanguage(callerUser, lang, sessionToken);
}

function setSystemForcedLanguage(callerUser, lang, sessionToken) {
  return I18nEngine.setSystemForcedLanguage(callerUser, lang, sessionToken);
}

function setSystemDefaultLanguage(callerUser, lang, sessionToken) {
  return I18nEngine.setSystemDefaultLanguage(callerUser, lang, sessionToken);
}

function getSystemLanguageSettings(callerUser, sessionToken) {
  return I18nEngine.getSystemLanguageSettings(callerUser, sessionToken);
}

function exportTranslationDictionary(callerUser, lang, sessionToken) {
  return I18nEngine.exportTranslationDictionary(callerUser, lang, sessionToken);
}

function importTranslationDictionary(callerUser, lang, jsonText, sessionToken) {
  return I18nEngine.importTranslationDictionary(callerUser, lang, jsonText, sessionToken);
}

function translateLegacyUiText(callerUser, texts, sessionToken) {
  return I18nEngine.translateLegacyUiText(callerUser, texts, sessionToken);
}

function i18nT(key, lang, vars) {
  return I18nEngine.t(key, lang, vars);
}

// ════════════════════════════════════════════════════════════════
// خطوات الدمج المطلوبة يدويًا (لم تُنفَّذ تلقائيًا لتجنّب أي كسر):
// ════════════════════════════════════════════════════════════════
// 1) أضف أسماء الدوال التالية إلى الـ Allowlist الموجود في أعلى
//    Code_12_Core.gs (بجانب "getUserPreferences" وغيرها):
//      "getI18nBootstrap", "setUserLanguage",
//      "setSystemForcedLanguage", "setSystemDefaultLanguage",
//      "getSystemLanguageSettings"
// 2) أضف "i18n" (اسمه المتفق عليه هنا: "translation_manage" أو
//    استخدم "settings_manage" الموجودة) لو حبيت صلاحية مستقلة لشاشة
//    إعدادات اللغة داخل Code_18_Permissions.gs / ALL_PERMISSIONS.
// 3) أدرج <?!= include('32_JS_i18n_Client'); ?> داخل Index.html قبل
//    إغلاق </body> (بعد تحميل باقي ملفات الـ JS الأساسية).
