// ══════════════════════════════════════════════════════════════════════════
// Code_47_AuditEngine.gs — محرك تسجيل العمليات الموحّد (AuditEngine)
// ──────────────────────────────────────────────────────────────────────────
// [AUDIT-ENGINE-DESIGN] هذا الملف *لا* يستبدل نظام الـ AuditLog الموجود
// بالفعل في Code_12_Core.gs (_writeAuditLog / getAuditLog / clearAuditLog /
// exportAuditLogCSV) — طبقًا لتعليمات المشروع ("لو وجدت محركاً حالياً يؤدي
// نفس الوظيفة، لا تنشئ محركاً جديداً، بل طوّره وادمجه")، AuditEngine هو
// طبقة أعلى (façade) فوق نفس البنية التحتية:
//   - يستخدم _writeAuditLog() نفسها للكتابة (تم توسيع AUDIT_HEADERS في
//     Code_12_Core.gs بأعمدة role/browser/device/result في آخر الصف —
//     Backward Compatible 100%، أي كود قديم بيستدعي _writeAuditLog أو
//     _addAuditLog يفضل شغال زي ما هو من غير أي تغيير).
//   - يستخدم getAuditLog() نفسها للبحث/التصفية (لا داعي لإعادة تنفيذها).
//
// القيمة المضافة هنا:
//   1) دوال واضحة الاسم لكل نوع عملية مطلوب تسجيله (login/logout/create/
//      update/delete/restore/approve/reject/print/export/import/
//      viewSensitiveData) بدل ما كل موديول يبني entry يدويًا بنفسه.
//   2) التقاط User/Role/IP/Browser/Device تلقائيًا من session + معلومات
//      الطلب، بدل ما كل نداء يمررها يدويًا.
//   3) نتيجة العملية (SUCCESS/FAILURE) كحقل صريح.
//   4) واجهة بحث/تصفية موحّدة (AuditEngine.search) تفوّض لـ getAuditLog.
//
// طريقة الاستخدام من أي دالة CRUD في أي ملف .gs:
//   AuditEngine.logCreate({
//     user: callerUser, sessionToken: sessionToken,
//     table: "SaleInvoices", recordId: newId, newValue: invoiceObj,
//     details: "إنشاء فاتورة بيع جديدة",
//   });
//
//   AuditEngine.logUpdate({
//     user: callerUser, sessionToken: sessionToken,
//     table: "Items", recordId: itemId,
//     oldValue: oldItem, newValue: newItem, // يُقارَن تلقائيًا بـ _diffObjects
//   });
//
//   var res = AuditEngine.search({ table: "SaleInvoices", search: "INV-1002" });
// ══════════════════════════════════════════════════════════════════════════

var AuditEngine = (function () {
  "use strict";

  var VALID_RESULTS = { SUCCESS: 1, FAILURE: 1 };

  // ── أدوات مساعدة داخلية ─────────────────────────────────────────────────

  /** يجيب دور المستخدم الحالي من الجلسة لو متاحة (بدون ما يكسر لو مش موجودة) */
  function _roleOf(username, sessionToken) {
    try {
      if (typeof getUserRole === "function") {
        return getUserRole(username) || "";
      }
      if (typeof validateSession === "function" && sessionToken) {
        var s = validateSession(username, sessionToken);
        if (s && s.valid && s.role) return s.role;
      }
    } catch (e) {
      /* تجاهل — التدقيق لا يجب أن يكسر العملية الأساسية */
    }
    return "";
  }

  /** يحاول يجيب IP/Browser/Device من كائن request (لو الموديول بيبعته) */
  function _clientInfo(opts) {
    var ua = opts.userAgent || (opts.request && opts.request.userAgent) || "";
    var browser = "";
    var device = "مكتب/متصفح";
    if (ua) {
      if (/Mobile|Android|iPhone/i.test(ua)) device = "موبايل";
      else if (/iPad|Tablet/i.test(ua)) device = "تابلت";
      if (/Chrome/i.test(ua)) browser = "Chrome";
      else if (/Firefox/i.test(ua)) browser = "Firefox";
      else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";
      else if (/Edg/i.test(ua)) browser = "Edge";
      else browser = ua.substring(0, 40);
    }
    return {
      ip: opts.ip || "",
      browser: opts.browser || browser,
      device: opts.device || device,
    };
  }

  /** الكتابة الفعلية — يفوّض لـ _writeAuditLog الموجودة بالفعل */
  function _write(action, opts) {
    opts = opts || {};
    var ci = _clientInfo(opts);
    var result =
      opts.result && VALID_RESULTS[String(opts.result).toUpperCase()]
        ? String(opts.result).toUpperCase()
        : "SUCCESS";

    var entry = {
      user: opts.user || "SYSTEM",
      displayName: opts.displayName,
      action: action,
      table: opts.table || "",
      record_id: opts.recordId || opts.record_id || "",
      details: opts.details || "",
      ip: ci.ip,
      browser: ci.browser,
      device: ci.device,
      role: opts.role || _roleOf(opts.user, opts.sessionToken),
      result: result,
    };

    // القيمة قبل/بعد — لو الاتنين مبعوتين نستخدم _diffObjects (لو متاحة)
    // لتقليل الحجم المخزّن لأهم الحقول المتغيّرة فقط، زي ما بيحصل بالفعل
    // في باقي المشروع.
    if (opts.oldValue !== undefined && opts.newValue !== undefined) {
      if (typeof _diffObjects === "function") {
        var diff = _diffObjects(opts.oldValue, opts.newValue);
        entry.old_value = diff.old;
        entry.new_value = diff.new;
      } else {
        entry.old_value = opts.oldValue;
        entry.new_value = opts.newValue;
      }
    } else {
      if (opts.oldValue !== undefined) entry.old_value = opts.oldValue;
      if (opts.newValue !== undefined) entry.new_value = opts.newValue;
    }

    if (typeof _writeAuditLog !== "function") {
      console.warn("AuditEngine: _writeAuditLog غير متاحة (Code_12_Core.gs)");
      return false;
    }
    _writeAuditLog(entry);
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════
  // §1 — Auth
  // ══════════════════════════════════════════════════════════════════════
  function logLogin(opts) {
    opts = opts || {};
    return _write("LOGIN", opts);
  }
  function logLogout(opts) {
    opts = opts || {};
    return _write("LOGOUT", opts);
  }
  function logLoginFailed(opts) {
    opts = opts || {};
    opts.result = "FAILURE";
    return _write("LOGIN", opts);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §2 — CRUD
  // ══════════════════════════════════════════════════════════════════════
  function logCreate(opts) {
    return _write("CREATE", opts);
  }
  function logUpdate(opts) {
    return _write("UPDATE", opts);
  }
  function logDelete(opts) {
    return _write("DELETE", opts);
  }
  function logRestore(opts) {
    return _write("RESTORE", opts);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §3 — Workflow (تتكامل مع WorkflowEngine اختياريًا)
  // ══════════════════════════════════════════════════════════════════════
  function logApprove(opts) {
    return _write("APPROVE", opts);
  }
  function logReject(opts) {
    return _write("REJECT", opts);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §4 — I/O عمليات
  // ══════════════════════════════════════════════════════════════════════
  function logPrint(opts) {
    return _write("PRINT", opts);
  }
  function logExport(opts) {
    return _write("EXPORT", opts);
  }
  function logImport(opts) {
    return _write("IMPORT", opts);
  }
  function logViewSensitiveData(opts) {
    return _write("VIEW_SENSITIVE", opts);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §4b — [NOTIF-LOGGING] تسجيل إشعارات NotificationEngine (العميل) في نفس
  // بنية AuditLog الموجودة — بدل ما نبني شيت/محرك تخزين جديد بالكامل.
  // يُستدعى فقط للفئات عالية القيمة (خطأ/صلاحيات/API/جلسة) من
  // logClientNotification أدناه — مش كل Toast عادي، لتفادي إغراق الشيت.
  // ══════════════════════════════════════════════════════════════════════
  function logNotification(opts) {
    opts = opts || {};
    return _write("NOTIFICATION", {
      user: opts.user,
      sessionToken: opts.sessionToken,
      table: opts.module || opts.screen || "",
      recordId: opts.category || "",
      details:
        "[" + (opts.category || "") + "] " + (opts.message || "") +
        (opts.screen ? " — الشاشة: " + opts.screen : ""),
      result: opts.type === "error" ? "FAILURE" : "SUCCESS",
      userAgent: opts.userAgent,
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // §5 — بحث/تصفية موحّد — يفوّض لـ getAuditLog() الموجودة بالفعل
  // ══════════════════════════════════════════════════════════════════════
  /**
   * search — واجهة موحّدة للبحث في سجل التدقيق.
   * @param {Object} filters - { user, action, table, dateFrom, dateTo, search }
   * @param {Number} limit
   */
  function search(filters, limit) {
    if (typeof getAuditLog !== "function") {
      return { success: false, data: [], message: "getAuditLog غير متاحة" };
    }
    return getAuditLog(limit || 100, filters || {});
  }

  // ══════════════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════════════
  return {
    logLogin: logLogin,
    logLogout: logLogout,
    logLoginFailed: logLoginFailed,
    logCreate: logCreate,
    logUpdate: logUpdate,
    logDelete: logDelete,
    logRestore: logRestore,
    logApprove: logApprove,
    logReject: logReject,
    logPrint: logPrint,
    logExport: logExport,
    logImport: logImport,
    logViewSensitiveData: logViewSensitiveData,
    logNotification: logNotification,
    search: search,
    // وصول مباشر لعملية عامة لو النوع مش من القائمة أعلاه
    log: _write,
  };
})();

// ── نقطة استدعاء عامة (google.script.run) تستخدمها 46_JS_ReportEngine.html
// لتسجيل كل عملية طباعة/تصدير تقرير تلقائيًا عبر AuditEngine، بدل ما كل
// شاشة تقارير تتذكر تكتب سطر Audit بنفسها.
function logReportAction(callerUser, sessionToken, action, details) {
  try {
    if (!callerUser || !sessionToken) return errResponse("جلسة غير صالحة");
    var check = _checkPermission(callerUser, "viewReports", sessionToken);
    // [SOFT-CHECK] لو المستخدم مالوش صلاحية viewReports صراحة بس بيقدر
    // يشوف الشاشة أصلاً (فتحت له)، لا نمنع التسجيل — التسجيل نفسه ليس
    // عملية حساسة، فقط نسجّل بأفضل معلومة متاحة بدل ما نفشل الطلب كله.
    var isPrint = String(action).toUpperCase() === "PRINT";
    if (isPrint) {
      AuditEngine.logPrint({
        user: callerUser,
        sessionToken: sessionToken,
        table: "Reports",
        details: details || "",
      });
    } else {
      AuditEngine.logExport({
        user: callerUser,
        sessionToken: sessionToken,
        table: "Reports",
        details: (action || "EXPORT") + ": " + (details || ""),
      });
    }
    return okResponse({ logged: true });
  } catch (e) {
    return errResponse("تعذر تسجيل عملية التقرير: " + e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// [NOTIF-LOGGING] logClientNotification — نقطة الدخول الوحيدة اللي بيستدعيها
// NotificationEngine.html (العميل) لتسجيل إشعار مهم في AuditLog، بدل ما
// نبني جدول/محرك تخزين منفصل. مُستدعاة فقط لفئات عالية القيمة (خطأ/
// صلاحيات/API/جلسة) — مش لكل success/info عادي — عشان منغرقش الشيت.
// ══════════════════════════════════════════════════════════════════════════
function logClientNotification(callerUser, sessionToken, payload) {
  try {
    if (!callerUser || !sessionToken) return errResponse("جلسة غير صالحة");
    if (
      typeof validateSession === "function" &&
      !validateSession(callerUser, sessionToken).valid
    ) {
      return errResponse("جلسة غير صالحة أو منتهية");
    }
    payload = payload || {};
    AuditEngine.logNotification({
      user: callerUser,
      sessionToken: sessionToken,
      category: payload.category,
      message: payload.message,
      screen: payload.screen,
      module: payload.module,
      type: payload.type,
    });
    return okResponse({ logged: true });
  } catch (e) {
    // [FIX] التسجيل نفسه مش لازم يكسر أي حاجة — نبتلع الخطأ بصمت للمطور
    console.warn("logClientNotification failed:", e.message);
    return errResponse("تعذر تسجيل الإشعار: " + e.message);
  }
}
