// ═════════════════════════════════════════════════════════════════════════
// Code_54_CacheEngine.js  —  محرك الـ Cache المركزي (المرحلة 13)
// ─────────────────────────────────────────────────────────────────────────
// المشكلة اللي هذا الملف بيحلّها:
//
//   حاليًا CacheService مستخدَم مباشرة في 7 ملفات مختلفة (Code_12_Core،
//   Code_31_i18n_Engine، Code_07_AIAgent، Code_48_PermissionEngine،
//   Code_41_UpdateManagement...) وكل واحد فيهم:
//     - بيختار TTL مختلف بشكل عشوائي (600، 21600، 5*60...) من غير سياسة
//       واحدة موثّقة.
//     - بيبني مفتاح الـ cache بطريقته الخاصة (بادئة مختلفة، أحيانًا hash
//       يدوي زي في i18n).
//     - مفيش نقطة واحدة تقدر تعرف منها "كل حاجة متخزنة دلوقتي إيه ولمدة
//       قد إيه" أو تنظّف كل الكاش بأمر واحد.
//
//   الحل: CacheEngine.get/set/getOrCompute — غلاف واحد فوق CacheService
//   (Script Cache، الحد الأقصى فعليًا 6 ساعات لكل مفتاح فرديًا حسب حدود
//   Google، والقيمة القصوى 100 كيلوبايت لكل مفتاح) بيوحّد:
//     1) بادئة موحدة لكل مفتاح (namespace) — تمنع تصادم المفاتيح بين
//        الموديولات المختلفة.
//     2) TTL موحّد حسب "نوع البيانات" (CACHE_POLICY تحت) بدل أرقام سايبة.
//     3) getOrCompute() — نمط "هات من الكاش، لو مش موجود احسب واحفظ"
//        اللي كل الاستخدامات الحالية بتعيد كتابته يدويًا في كل ملف.
//     4) invalidate/clearNamespace — تنظيف منظّم بدل ما كل ملف يمسح
//        مفاتيحه بطريقته.
//
// ⚠️ [تحديث P1 — الدمج التدريجي] لا شيء من الاستخدامات الحالية لـ
//    CacheService اتشال أو اتغيّر سلوكه (نفس المفاتيح ونفس مدد الـ TTL
//    بالحرف) — بس نقطة الوصول اتوحّدت. حالة الدمج الفعلية دلوقتي:
//      ✅ Code_31_i18n_Engine.js         — مُدمَج (المرجع الأصلي)
//      ✅ Code_48_PermissionEngine.js    — كان بالفعل مبني فوق CacheEngine
//      ✅ Code_07_AIAgent.js             — مُدمَج (rate limiting)
//      ✅ Code_41_UpdateManagement.js    — مُدمَج (getUpdatesFromHub)
//      ⚠️ Code_12_Core.js                — مُدمَج جزئيًا: USERS_CACHE +
//         USERS_CACHE_FLAG_KEY + LIGHT_CACHE (getAllDataLight) مُدمَجين.
//         الكاش المُجزَّأ الكبير (SERVER_CACHE_KEY لـ getAllData الكامل،
//         مبني على chunking متعدد المفاتيح) استُبعِد عمدًا — راجع تعليق
//         [CACHE-ENGINE / المرحلة 13 — استثناء مقصود] فوق §CACHE في
//         Code_12_Core.js لسبب الاستبعاد وشرط دمجه مستقبلاً.
// ═════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// §1  سياسة الـ TTL الموحّدة — كل "نوع بيانات" له مدة تخزين واحدة معروفة
//     بدل أرقام متفرقة داخل كل ملف. القيم بالثواني (حدود CacheService).
// ─────────────────────────────────────────────────────────────
const CACHE_POLICY = Object.freeze({
  // بيانات مرجعية نادراً ما تتغيّر (وحدات، عملات، دول، ضرائب...)
  // المستوى الرابع (REFERENCE) في Code_53_DataRegistryEngine — أطول TTL مسموح
  REFERENCE: 21600, // 6 ساعات — أقصى حد فعلي لـ CacheService

  // ترجمات آلية (i18n) — النص الأصلي ثابت عمليًا، فلا داعي لإعادة حساب متكرر
  TRANSLATION: 21600,

  // بيانات شبه ثابتة لكن ممكن تتغيّر خلال اليوم (صلاحيات، إعدادات عامة)
  SEMI_STATIC: 3600, // ساعة

  // حزمة اللوجين الخفيفة (getAllDataLight) — تتغيّر مع أي عملية بيع/شراء،
  // فمش منطقي تتخزّن طويل، لكن تسريع الفتح المتكرر خلال دقايق قليلة يستاهل
  LIGHT_BUNDLE: 300, // 5 دقايق

  // Flags/Locks مؤقتة (منع تكرار عملية، Debounce على مستوى السيرفر)
  TRANSIENT_FLAG: 600, // 10 دقايق

  // صلاحيات المستخدم الفعّالة — TTL قصير عمدًا: أي تعديل صلاحية/دور
  // لازم يتفعّل بسرعة نسبيًا حتى بدون invalidate صريح (حماية fail-safe)
  PERMISSIONS_SHORT: 120,
});

// ─────────────────────────────────────────────────────────────
// §2  Namespaces — بادئة موحدة لكل موديول لمنع تصادم المفاتيح
// ─────────────────────────────────────────────────────────────
const CACHE_NAMESPACE = Object.freeze({
  I18N: "i18n",
  USERS: "users",
  LIGHT_BUNDLE: "lightbundle",
  PERMISSIONS: "perm",
  AI_AGENT: "ai",
  UPDATE_MGMT: "update",
  // [PHASE-6 / محرك تحميل البيانات — المرحلة 6] بيانات مرجعية نادراً ما
  // تتغيّر (Colors/Sizes/SizeGroups — DATA_LEVEL.REFERENCE في
  // Code_53_DataRegistryEngine.js). كانت بتتقرأ من Sheets كل مرة يتبطّل
  // فيها الكاش العام لحزمة getAllData بالكامل (كل 25 دقيقة، أو فور أي
  // عملية كتابة على أي شيت في النظام) رغم إنها نادراً ما تتغيّر فعليًا.
  // دلوقتي عندها namespace وTTL خاص بيها (CACHE_POLICY.REFERENCE = 6
  // ساعات) مستقل تمامًا عن كاش الحزمة العامة، ومفيش إبطال ليها إلا عند
  // تعديل/إضافة/حذف فعلي على نفس الكيان (شوف invalidate calls في
  // addColor/updateColor/deleteColor وما يقابلها لـ Sizes/SizeGroups).
  REFERENCE: "ref",
});

// ─────────────────────────────────────────────────────────────
// §3  CacheEngine — الواجهة العامة
// ─────────────────────────────────────────────────────────────
const CacheEngine = (function () {
  function _key(namespace, key) {
    return namespace + ":" + key;
  }

  /**
   * get — يرجع القيمة (اتفكّت من JSON تلقائيًا لو كانت مخزّنة كـ JSON)
   * أو null لو مش موجودة/انتهت صلاحيتها.
   */
  function get(namespace, key) {
    try {
      var raw = CacheService.getScriptCache().get(_key(namespace, key));
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return raw; // كانت مخزّنة كنص خام (زي ترجمة i18n) مش JSON
      }
    } catch (e) {
      // فشل الاتصال بـ CacheService (نادر) — لا يجب أبدًا أن يُسقط الشاشة،
      // فقط نتعامل معه كأن القيمة مش موجودة في الكاش
      console.warn("[CacheEngine] get failed: " + e.message);
      return null;
    }
  }

  /**
   * set — يخزّن القيمة (أي نوع — بيتحوّل لـ JSON تلقائيًا لو مش نص)
   * @param {string} namespace  أحد قيم CACHE_NAMESPACE
   * @param {string} key
   * @param {*}      value
   * @param {number} ttlSeconds أحد قيم CACHE_POLICY — إلزامي وليس اختياريًا
   *                            عشان نمنع رجوع أرقام TTL عشوائية جديدة
   */
  function set(namespace, key, value, ttlSeconds) {
    try {
      var raw = typeof value === "string" ? value : JSON.stringify(value);
      CacheService.getScriptCache().put(_key(namespace, key), raw, ttlSeconds);
      return true;
    } catch (e) {
      console.warn("[CacheEngine] set failed: " + e.message);
      return false;
    }
  }

  /**
   * getOrCompute — النمط الأكثر استخدامًا في كل الملفات الحالية:
   * "هات من الكاش، لو مش موجودة احسبها واحفظها". بيغني عن إعادة كتابة
   * نفس if/else يدويًا في كل دالة.
   *
   *   var perms = CacheEngine.getOrCompute(
   *     CACHE_NAMESPACE.PERMISSIONS, userId,
   *     function () { return _computeUserPermissions(userId); },
   *     CACHE_POLICY.SEMI_STATIC
   *   );
   */
  function getOrCompute(namespace, key, computeFn, ttlSeconds) {
    var cached = get(namespace, key);
    if (cached !== null) return cached;
    var fresh = computeFn();
    if (fresh !== undefined && fresh !== null) {
      set(namespace, key, fresh, ttlSeconds);
    }
    return fresh;
  }

  /** invalidate — يمسح مفتاح واحد بعينه (بعد تعديل/حذف يخص السجل ده) */
  function invalidate(namespace, key) {
    try {
      CacheService.getScriptCache().remove(_key(namespace, key));
    } catch (e) {
      console.warn("[CacheEngine] invalidate failed: " + e.message);
    }
  }

  /**
   * invalidateMany — لمسح دفعة مفاتيح مرة واحدة (أوفر من استدعاء remove
   * بشكل منفصل لكل مفتاح — CacheService بيدعم removeAll لمصفوفة مفاتيح)
   */
  function invalidateMany(namespace, keys) {
    try {
      CacheService.getScriptCache().removeAll(
        keys.map(function (k) {
          return _key(namespace, k);
        }),
      );
    } catch (e) {
      console.warn("[CacheEngine] invalidateMany failed: " + e.message);
    }
  }

  return {
    POLICY: CACHE_POLICY,
    NAMESPACE: CACHE_NAMESPACE,
    get: get,
    set: set,
    getOrCompute: getOrCompute,
    invalidate: invalidate,
    invalidateMany: invalidateMany,
  };
})();
