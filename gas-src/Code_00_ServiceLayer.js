// ════════════════════════════════════════════════════════════════
// Code_00_ServiceLayer.gs — الطبقة الموحّدة لتنفيذ عمليات CRUD
// (فحص صلاحية + قواعد عمل BusinessRulesEngine + تنفيذ الـ handler +
// تسجيل تدقيق Audit + إسقاط الكاش) في مكان واحد بدل تكرارها في كل دالة.
//
// [SL-FIX] هذا الملف كان مفقودًا بالكامل من المشروع رغم أن كلاً من
// Code_16_Inventory.gs و Code_20_Sales.gs ينادي ServiceLayer.register(...)
// و ServiceLayer.execute(...) — وبعض هذه النداءات (register) تتم في أعلى
// الملف مباشرة (top-level)، أي أنها تُنفَّذ فور تحميل المشروع (مع كل
// طلب من الواجهة)، فيسبب غياب تعريف ServiceLayer خطأ:
//     ReferenceError: ServiceLayer is not defined
// فورًا عند تحميل السكربت — وهو ما يفسّر ظهور الخطأ عند أي عملية
// (إضافة مستخدم، تفضيلات، أصناف، عملاء...) وليس فقط عند شاشة معيّنة.
//
// مهم جدًا: يجب أن يُحمَّل هذا الملف قبل Code_16_Inventory.gs و
// Code_20_Sales.gs. في محرر Apps Script رتّب الملفات (اسحبها في القائمة
// الجانبية) بحيث يكون هذا الملف أول ملف Code_ (اسمه يبدأ بـ 00 لضمان ذلك
// أبجديًا).
// ════════════════════════════════════════════════════════════════

var ServiceLayer = (function () {
  var _registry = {};

  function _key(entityType, action) {
    return String(entityType) + "::" + String(action);
  }

  // تسجيل عملية (entityType مثل "item"/"customer", action مثل "create"/"update"/"delete")
  function register(entityType, action, config) {
    _registry[_key(entityType, action)] = config || {};
  }

  // تنفيذ عملية مسجّلة مسبقًا
  function execute(request) {
    request = request || {};
    var entityType = request.entityType;
    var action = request.action;
    var payload = request.payload || {};
    var context = request.context || {};
    var username = context.username;
    var sessionToken = context.sessionToken;

    var config = _registry[_key(entityType, action)];
    if (!config) {
      return {
        success: false,
        message:
          "عملية غير مسجّلة في ServiceLayer: " + entityType + "/" + action,
        code: "SL_NOT_REGISTERED",
      };
    }

    // 1) فحص الصلاحية (نفس _checkPermission المستخدمة في باقي المشروع)
    if (config.permissionAction) {
      var permErr = _checkPermission(
        username,
        config.permissionAction,
        sessionToken,
      );
      if (permErr) return permErr;
    }

    // 2) فحص قواعد العمل (BusinessRulesEngine) إن وُجد
    if (typeof config.breCheck === "function") {
      var breResult;
      try {
        breResult = config.breCheck(payload, context);
      } catch (e) {
        return {
          success: false,
          message: "خطأ في فحص قواعد العمل: " + e.message,
          code: "SL_BRE_ERROR",
        };
      }
      if (breResult && breResult.success === false) {
        return {
          success: false,
          message: breResult.message,
          code: breResult.code,
        };
      }
    }

    // 3) تنفيذ الـ handler الفعلي (منطق الكتابة الخام)
    var result;
    try {
      result = config.handler(payload, context);
    } catch (e) {
      return {
        success: false,
        message: "خطأ أثناء التنفيذ: " + e.message,
        code: "SL_HANDLER_ERROR",
      };
    }
    if (!result || result.success === false) {
      return result || { success: false, message: "فشل غير معروف" };
    }

    // 4) إسقاط الكاش بعد أي تعديل ناجح
    try {
      _invalidateServerCache();
    } catch (e) {
      /* تجاهل */
    }

    // 5) تسجيل التدقيق (Audit Log)
    try {
      var recordId =
        payload.id ||
        (result.data && (result.data.id || result.data.generatedId)) ||
        "";
      var detailsRaw =
        typeof config.auditDetails === "function"
          ? config.auditDetails(payload, result)
          : result.message;
      var details =
        detailsRaw && typeof detailsRaw === "object"
          ? JSON.stringify(detailsRaw)
          : detailsRaw || "";
      AuditEngine.log(config.auditAction || entityType + ":" + action, {
        user: username || "SYSTEM",
        table: config.table || "",
        record_id: recordId,
        details: details,
        oldValue: result.oldValue,
        newValue: result.newValue});
    } catch (e) {
      console.warn("ServiceLayer: فشل تسجيل التدقيق: " + e.message);
    }

    return result;
  }

  return { register: register, execute: execute };
})();
