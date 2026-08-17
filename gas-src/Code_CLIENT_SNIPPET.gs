/**
 * ============================================================
 * هذا الكود يوضع في نسخة العميل (MOO.ERP) — Client Mode فقط
 * (قراءة بدون أي تعديل). يستبدل أي كود إدارة قديم بتاع Updates Hub.
 *
 * الإعداد المطلوب مرة واحدة لكل عميل (Project Settings → Script
 * Properties):
 *   UPDATES_HUB_URL        = رابط الـ Web App بتاع المركزي (/exec)
 *   UPDATES_HUB_CLIENT_ID  = الـ client_id من لوحة تحكم المركزي
 *   UPDATES_HUB_SECRET     = الـ raw secret (يظهر مرة واحدة بس)
 * ============================================================
 */

/**
 * ⚠️ ملحوظة توافق مهمة (تمت إضافتها بعد اكتشاف تعارض حقيقي):
 * الدوال getUpdatesFromHub() / pingUpdatesHub() / _updatesHubSignedRequest()
 * اللي كانت هنا في النسخة الأصلية من هذا الـ snippet اتشالت من هنا،
 * لأن نسخة العميل ده فيها فعلاً تنفيذ كامل وأحدث لنفس الدوال في
 * Code_41_UpdateManagement.gs (باسم _umSignedRequest بدل
 * _updatesHubSignedRequest، ونفس البروتوكول تمامًا مع المركزي).
 *
 * وجود نسختين بنفس اسم الدالة (getUpdatesFromHub / pingUpdatesHub) في
 * نفس مشروع Apps Script بيخلي آخر نسخة في ترتيب تحميل الملفات (أبجديًا
 * بالاسم) هي اللي "تكسب" وتشتغل فعليًا — وكانت النسخة القديمة هنا هي
 * اللي كسبت فعليًا، وهي فيها بق فعلي: `pingUpdatesHub()` كانت بترسل
 * `CURRENT_APP_VERSION` وهو متغير غير معرّف خالص في المشروع (المتغير
 * الصحيح اسمه `APP_VERSION` في Code_42_AppVersion.gs)، فكل نداء لل­ ping
 * كان بيفشل بصمت (متغطي بـ try/catch) — وده كان سبب ظهور "النسخة"
 * و"آخر ظهور" دايمًا "-" في لوحة تحكم المركزي لهذا العميل، بغض النظر
 * عن أي حاجة تانية.
 *
 * لو محتاج تتأكد إن التكامل شغال دلوقتي: بعد نشر التعديل ده، سجّل
 * دخول للنظام مرة، وبعدين افتح لوحة تحكم المركزي → العملاء → تفاصيل
 * هذا العميل، وشوف "النسخة" و"آخر ظهور" لو ظهر فيهم قيمة حقيقية بدل "-".
 */

/**
 * بيرجع الإصدارات + الإعلانات + حالة الاشتراك — بيستخدم كاش نص ساعة،
 * ولو المركزي مش متاح بيرجع آخر نسخة متخزنة بدل ما يفشل بالكامل.
 *
 * ملحوظة (وضع الصيانة): لو النتيجة .success === false و
 * .code === "MAINTENANCE"، فده معناه إن الأدمن حط نسخة العميل ده في
 * صيانة مؤقتة من لوحة التحكم المركزية — من المفضّل تعرض .message
 * (اللي بيبقى فيها رسالة مخصصة أحيانًا) للمستخدم كبانر واضح بدل ما
 * تتعامل معاه كخطأ اتصال عادي.
 *
 * (التنفيذ الفعلي موجود في Code_41_UpdateManagement.gs — الدالة هنا
 * بس تعليق توضيحي، مفيش تعريف تاني لمنع تكرار المشكلة).
 */


/**
 * ============================================================
 * إشعارات خاصة بأدوار معيّنة (مثلاً: تظهر للمديرين بس، مش لأي موظف)
 * ============================================================
 * المركزي (Updates Hub) مش عارف مستخدمين شركتك ولا أدوارهم — هو بس
 * عارف "الشركة" (client) نفسها. فكل إعلان بيرجع من `getUpdatesFromHub()`
 * ومعاه حقل `audience_roles` (مصفوفة نصوص، زي ["manager","supervisor"]،
 * أو [] فاضية = يظهر لكل الموظفين). الفلترة الفعلية حسب دور المستخدم
 * *الحالي* لازم تتم هنا، جوه نسخة العميل، لأن هنا بس فين معرفة مين
 * فاتح الجلسة دلوقتي ودوره في نظام الصلاحيات (RBAC) بتاعك.
 *
 * استخدمها كده بعد ما تجيب النتيجة من getUpdatesFromHub():
 *
 *   var result = getUpdatesFromHub();
 *   var myRole = getCurrentUserRoleKey_();               // دالتك انت
 *   var visibleAnnouncements = filterAnnouncementsForRole(
 *     result.announcements, myRole
 *   );
 *
 * لو عندك أكتر من دور للمستخدم الواحد (مثلاً "manager" و"hr" مع بعض)،
 * ابعت مصفوفة بدل نص واحد — الدالة بتقبل الاتنين.
 */
function filterAnnouncementsForRole(announcements, currentUserRoleOrRoles) {
  var myRoles = Array.isArray(currentUserRoleOrRoles)
    ? currentUserRoleOrRoles
    : [currentUserRoleOrRoles];
  myRoles = myRoles.filter(Boolean).map(function (r) { return String(r).toLowerCase(); });

  return (announcements || []).filter(function (ann) {
    var audience = ann.audience_roles || [];
    if (!audience.length) return true; // فاضي = يظهر للكل
    return audience.some(function (requiredRole) {
      return myRoles.indexOf(String(requiredRole).toLowerCase()) !== -1;
    });
  });
}

/**
 * ============================================================
 * Feature Flags — تفعيل/تعطيل ميزة لعميل بعينه بدون نشر إصدار جديد
 * ============================================================
 * استخدمها كده في أي مكان في نسخة العميل:
 *
 *   if (isFeatureEnabled("new_invoice_ui")) { ... }
 *
 * القيمة الافتراضية لو الـ flag مش موجود خالص في المركزي = false،
 * إلا لو اتبعت defaultValue صريحة كمعامل تاني.
 */
function isFeatureEnabled(flagKey, defaultValue) {
  var result = getUpdatesFromHub();
  var flags = (result && result.feature_flags) || {};
  if (Object.prototype.hasOwnProperty.call(flags, flagKey)) {
    return !!flags[flagKey];
  }
  return !!defaultValue;
}

/**
 * ============================================================
 * Module Management — تفعيل/تعطيل موديول كامل لعميل بعينه من المركزي
 * ============================================================
 * استخدمها وقت بناء الـ Sidebar في نسخة العميل عشان تخفي موديول
 * اتعطّل من لوحة تحكم المركزي، من غير ما تحتاج تنشر نسخة جديدة:
 *
 *   var result = getUpdatesFromHub();
 *   sidebarItems = sidebarItems.filter(function (item) {
 *     return isModuleEnabled(item.moduleKey, result);
 *   });
 *
 * أي موديول مش موجود في `disabled_modules` = مفعّل افتراضيًا (نفس
 * سلوك كل العملاء الحاليين قبل استخدام الميزة دي). القائمة الثابتة
 * لأسماء الموديولات (accounting, hr, inventory, manufacturing,
 * sales, purchasing, shipping, whatsapp, ai_agent, reports) معرّفة
 * في المركزي نفسه (MOO_MODULE_CATALOG بـ Code_01_Schema.gs).
 */
function isModuleEnabled(moduleKey, cachedResult) {
  var result = cachedResult || getUpdatesFromHub();
  var disabled = (result && result.disabled_modules) || [];
  return disabled.indexOf(moduleKey) === -1;
}

/**
 * مثال ربط بمحرّك الصلاحيات الموجود عندك (RBAC) — عدّل الاستدعاء
 * الداخلي هنا بما يطابق الدالة/الطريقة الحقيقية اللي بترجع دور
 * المستخدم الحالي في نظامك (مثلاً من PermissionsEngine أو من UserSession).
 */
function getCurrentUserRoleKey_() {
  // مثال: return PermissionsEngine.getCurrentUser().roleKey;
  // مثال بديل: return UserSession.get('role');
  throw new Error("اربط الدالة دي بمحرّك الصلاحيات الفعلي عندك قبل الاستخدام");
}
