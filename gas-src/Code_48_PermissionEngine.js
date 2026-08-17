// ══════════════════════════════════════════════════════════════════════════
// Code_48_PermissionEngine.gs — محرك الصلاحيات الموحّد (PermissionEngine)
// ──────────────────────────────────────────────────────────────────────────
// [PERMISSION-ENGINE-DESIGN] نظام RBAC الكامل موجود بالفعل وناضج في
// Code_18_Permissions.gs (_checkPermission، ALL_PERMISSIONS،
// BUILTIN_PERMISSIONS، Custom Roles، User Overrides، Warehouse Access).
// طبقًا لتعليمات المشروع، PermissionEngine *لا يعيد تنفيذ* أي من هذا —
// هو المرجع الموحّد الذي تستدعيه الشاشات لأي سؤال "هل مسموح لي..؟" على
// مستوى أدق من فحص الـ action الواحد اللي بيعمله _checkPermission، عن
// طريق تفويض (delegation) لـ getUserPermissions() + إضافة:
//   1) Cache (CacheService) للصلاحيات الفعّالة لكل مستخدم لمدة قصيرة، بدل
//      ما كل زرار/عمود/تبويب في نفس الشاشة يعمل نداء منفصل لقراءة شيت
//      Users + Roles + Overrides من جديد.
//   2) فحوصات جاهزة على مستوى: شاشة/زرار/قائمة/إجراء/حقل/عمود/تبويب/
//      موديول — كلها مبنية فوق effectivePermissions نفسها.
//   3) Dynamic Permission Check عام: PermissionEngine.can(username, key).
//
// أي عملية *تنفيذ فعلي* (إضافة/تعديل/حذف) تفضل تمر إلزاميًا عبر
// _checkPermission() في كل دالة CRUD كما هي الآن (بوابة السيرفر النهائية،
// fail-closed) — PermissionEngine مخصص لأسئلة العرض/الإخفاء (UI-level)
// وللفحوصات الديناميكية الإضافية، وليس بديلاً عن هذه البوابة.
//
// طريقة الاستخدام:
//   if (!PermissionEngine.canAccessScreen(user, "accounting.vouchers")) { ... }
//   if (!PermissionEngine.canClickButton(user, "invoice.delete")) { ... }
//   if (!PermissionEngine.can(user, "manageUsers")) { ... }
// ══════════════════════════════════════════════════════════════════════════

var PermissionEngine = (function () {
  "use strict";

  // [CACHE-ENGINE / المرحلة 13] كان هنا طبقة كاش مكتوبة يدويًا بالكامل
  // (CACHE_PREFIX + _cache() + try/catch مكرر في كل دالة). دلوقتي بتفوّض
  // كل ده لـ CacheEngine الموحّد — نفس TTL (120 ثانية) لكن كسياسة موثّقة
  // (CACHE_POLICY.PERMISSIONS_SHORT) بدل رقم مكتوب هنا بس.
  //
  // [FIX] لازم القراءة تكون كسولة (lazy) جوّه دالة، مش مباشرة هنا فوق.
  // Apps Script بيدمج كل ملفات الـ .gs في اسكريبت واحد وينفّذ الكود اللي
  // على المستوى الأعلى بترتيب أبجدي لاسم الملف. Code_48 بيتنفّذ قبل
  // Code_54_CacheEngine.js أبجديًا، فلو قرينا CacheEngine هنا فوق (وقت
  // تحميل الملف نفسه) هيكون لسه متعرفش، ونطلع ReferenceError. الحل:
  // نأجّل القراءة لحد أول استدعاء فعلي (وقتها كل الملفات كانت اتحمّلت).
  function _ns() {
    return CacheEngine.NAMESPACE.PERMISSIONS;
  }

  function _getEffectivePermissions(username) {
    if (!username) return [];
    var key = String(username).trim().toLowerCase();
    return CacheEngine.getOrCompute(
      _ns(),
      key,
      function () {
        if (typeof getUserPermissions !== "function") return [];
        var res = getUserPermissions(username);
        return res && res.success ? res.effectivePermissions || [] : [];
      },
      CacheEngine.POLICY.PERMISSIONS_SHORT,
    );
  }

  /** invalidate — تُستدعى بعد أي تعديل صلاحيات/دور/override لمستخدم معيّن */
  function invalidate(username) {
    if (!username) return;
    CacheEngine.invalidate(_ns(), String(username).trim().toLowerCase());
  }

  /**
   * invalidateAll — عند تعديل صلاحيات دور كامل (يأثر على كل مستخدميه).
   * [PERM-ENG-ROLLOUT-1] لو اتبعت roleName، بندوّر فعليًا على كل مستخدمي
   * هذا الدور في شيت Users ونمسح كاش كل واحد منهم صراحةً — بدل الاعتماد
   * على انتظار TTL (120 ثانية) بس. من غير roleName (استدعاء قديم بلا
   * معطيات) بنكتفي بالسلوك الأصلي: ترك TTL القصير يتكفل بالتحديث.
   * @param {string} [roleName] - اسم الدور اللي اتغيّرت صلاحياته
   */
  function invalidateAll(roleName) {
    if (!roleName) return; // بدون اسم دور، TTL القصير كافي (سلوك أصلي)
    try {
      if (typeof readSheet !== "function") return;
      var users = readSheet("Users");
      var target = String(roleName).trim().toLowerCase();
      var affected = users
        .filter(function (u) {
          return String(u.role || "").trim().toLowerCase() === target;
        })
        .map(function (u) {
          return String(u.username || "").trim().toLowerCase();
        });
      if (affected.length) CacheEngine.invalidateMany(_ns(), affected);
    } catch (e) {
      /* تجاهل — أسوأ حالة: نرجع لسلوك TTL الأصلي */
    }
    // CacheService مفيهوش "clear by prefix" — لذلك بنعتمد على قراءة
    // Users وتحديد المتأثرين فعليًا بدل مسح شامل غير موجود أصلاً.
    // للحالات الحرجة (تعديل دور admin مثلاً) استخدم invalidate(username)
    // صراحةً لكل مستخدم متأثر معروف.
  }

  // ── الفحص الديناميكي العام ─────────────────────────────────────────────
  /** can — هل يملك المستخدم صلاحية (action key) معيّنة من ALL_PERMISSIONS؟ */
  function can(username, permissionKey) {
    if (!username || !permissionKey) return false;
    var perms = _getEffectivePermissions(username);
    return perms.indexOf(permissionKey) !== -1;
  }

  /** canAny — يملك واحدة على الأقل من مجموعة صلاحيات */
  function canAny(username, permissionKeys) {
    var perms = _getEffectivePermissions(username);
    return (permissionKeys || []).some(function (k) {
      return perms.indexOf(k) !== -1;
    });
  }

  /** canAll — يملك كل الصلاحيات المطلوبة */
  function canAll(username, permissionKeys) {
    var perms = _getEffectivePermissions(username);
    return (permissionKeys || []).every(function (k) {
      return perms.indexOf(k) !== -1;
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // فحوصات جاهزة حسب نوع عنصر الواجهة — كلها تفويض لـ can() بنفس المفتاح.
  // الفكرة: توحيد الاسم اللي بيستخدمه المطوّر (canAccessScreen بدل can)
  // حتى لو المنطق الداخلي متطابق، عشان القراءة تبقى أوضح في كل شاشة.
  // ══════════════════════════════════════════════════════════════════════
  function canAccessScreen(username, screenKey) {
    return can(username, screenKey);
  }
  function canClickButton(username, buttonKey) {
    return can(username, buttonKey);
  }
  function canSeeMenu(username, menuKey) {
    return can(username, menuKey);
  }
  function canDoAction(username, actionKey) {
    return can(username, actionKey);
  }
  function canEditField(username, fieldKey) {
    return can(username, fieldKey);
  }
  function canSeeColumn(username, columnKey) {
    return can(username, columnKey);
  }
  function canSeeTab(username, tabKey) {
    return can(username, tabKey);
  }
  function canAccessModule(username, moduleKey) {
    return can(username, moduleKey);
  }

  /** getEffectivePermissions — للشاشات اللي محتاجة القائمة كاملة (زي بناء القوائم ديناميكيًا) */
  function getEffectivePermissions(username) {
    return _getEffectivePermissions(username);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════════════
  return {
    can: can,
    canAny: canAny,
    canAll: canAll,
    canAccessScreen: canAccessScreen,
    canClickButton: canClickButton,
    canSeeMenu: canSeeMenu,
    canDoAction: canDoAction,
    canEditField: canEditField,
    canSeeColumn: canSeeColumn,
    canSeeTab: canSeeTab,
    canAccessModule: canAccessModule,
    getEffectivePermissions: getEffectivePermissions,
    invalidate: invalidate,
    invalidateAll: invalidateAll,
  };
})();
