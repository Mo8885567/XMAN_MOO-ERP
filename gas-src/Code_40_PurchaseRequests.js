// ════════════════════════════════════════════════════════════════
// Code_40_PurchaseRequests.gs — طلبات الشراء الداخلية (Purchase Requests)
// ──────────────────────────────────────────────────────────────────
// الفجوة (راجع ERP_GAP_ANALYSIS_AND_IMPROVEMENT_PLAN.md — القسم 3،
// بند "High"): كان أي موظف يقدر ينشئ أمر شراء (Code_27) مباشرة بدون أي
// طلب داخلي معتمد من رئيسه — فجوة رقابة مالية حقيقية. الموديول ده بيضيف
// خطوة سابقة لأمر الشراء: طلب شراء داخلي (بدون أسعار/مورد ملزم) يحتاج
// اعتماد قبل ما يتحوّل لأمر شراء فعلي.
//
// [PURCHASE-REQUEST-DESIGN]
//   - دورة الحياة: مسودة → (اعتماد) معتمد → (تحويل) محوّل لأمر شراء
//                          → (رفض) مرفوض   |   → (إلغاء) ملغي
//   - التحويل لأمر شراء (convertPurchaseRequestToPO) بيستخدم دالة
//     savePurchaseOrder الموجودة فعلاً في Code_27_PurchaseOrders.gs بدل
//     ما يعيد كتابة منطق إنشاء أمر شراء من الصفر — نفس مبدأ "طوّر
//     الموجود بدل ما تستبدله".
//   - عكس Code_27 (اللي بيستخدم WorkflowEngine.canTransition للتحقق بس
//     ويكتب الحالة يدويًا)، الموديول ده جديد بالكامل فاستخدمنا
//     WorkflowEngine.transition() الكاملة من أول سطر — التحقق + الكتابة
//     عبر RepositoryLayer + تسجيل Audit Log، كلها في نداء واحد.
//   - الصلاحيات: بنعيد استخدام مستوى صلاحيات المشتريات الحالي فعليًا
//     ("addPurchaseInvoice" / "deletePurchaseInvoice" — نفس المستوى
//     المُستخدَم في Code_27_PurchaseOrders.gs وهو المُسجَّل فعليًا في
//     ALL_PERMISSIONS بـ Code_18_Permissions.gs ومفعّل لأي دور موجود
//     بالفعل) بدل تعريف صلاحيات جديدة تحتاج إعادة تهيئة الأدوار يدويًا
//     قبل ما حد يقدر يستخدم الموديول.
// ════════════════════════════════════════════════════════════════

var PURCHASE_REQUEST_HEADERS = [
  "id",
  "date",
  "requested_by",
  "department",
  "warehouse",
  "needed_by_date",
  "notes",
  "status",
  "reject_reason",
  "lines_count",
  "lines_json",
  "converted_po_id",
  "created_by",
  "created_at",
  "updated_at",
];

// getPurchaseRequests — جلب كل طلبات الشراء
function getPurchaseRequests() {
  try {
    var rows = readSheet("PurchaseRequests", PURCHASE_REQUEST_HEADERS, {
      parseJson: ["lines_json"],
    });
    rows.forEach(function (r) {
      if (!r.lines) r.lines = Array.isArray(r.lines_json) ? r.lines_json : [];
    });
    return { success: true, data: cleanArr(rows) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// savePurchaseRequest — إنشاء طلب شراء داخلي جديد (مسودة)
function savePurchaseRequest(data, sessionToken) {
  try {
    if (!data || !data.lines || !data.lines.length)
      return { success: false, message: "أضف بنداً واحداً على الأقل" };

    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "addPurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };

    var now = new Date().toISOString();
    var id = "PR-" + Date.now();

    var row = {
      id: id,
      date: data.date || now.split("T")[0],
      requested_by: data.requested_by || user,
      department: data.department || "",
      warehouse: data.warehouse || "",
      needed_by_date: data.needed_by_date || "",
      notes: data.notes || "",
      status: "مسودة",
      reject_reason: "",
      lines_count: (data.lines || []).length,
      lines_json: JSON.stringify(data.lines || []),
      converted_po_id: "",
      created_by: user,
      created_at: now,
      updated_at: now,
    };

    appendToSheet("PurchaseRequests", PURCHASE_REQUEST_HEADERS, row);
    logAudit(user, "إنشاء طلب شراء", "PurchaseRequests", id, null, row);

    var result = Object.assign({}, row, { lines: data.lines || [] });
    return { success: true, data: result, message: "تم حفظ طلب الشراء بنجاح" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// updatePurchaseRequest — تعديل طلب شراء (مسودة فقط)
function updatePurchaseRequest(data, sessionToken) {
  try {
    if (!data || !ValidationEngine.isRequired(data.id))
      return { success: false, message: "رقم الطلب مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "addPurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };

    var rows = readSheet("PurchaseRequests", PURCHASE_REQUEST_HEADERS);
    var order = rows.find(function (r) {
      return r.id === data.id;
    });
    if (!order) return { success: false, message: "طلب الشراء غير موجود" };
    if (order.status !== "مسودة")
      return {
        success: false,
        message: "لا يمكن تعديل طلب في حالة: " + order.status,
      };

    var now = new Date().toISOString();
    var updates = {
      department: data.department !== undefined ? data.department : order.department,
      warehouse: data.warehouse !== undefined ? data.warehouse : order.warehouse,
      needed_by_date:
        data.needed_by_date !== undefined ? data.needed_by_date : order.needed_by_date,
      notes: data.notes !== undefined ? data.notes : order.notes,
      lines_count: data.lines ? data.lines.length : order.lines_count,
      lines_json: data.lines ? JSON.stringify(data.lines) : order.lines_json,
      updated_at: now,
    };

    updateSheetRow("PurchaseRequests", PURCHASE_REQUEST_HEADERS, data.id, updates);
    logAudit(user, "تعديل طلب شراء", "PurchaseRequests", data.id, order, updates);
    return {
      success: true,
      data: Object.assign({}, order, updates),
      message: "تم تحديث الطلب",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// approvePurchaseRequest — اعتماد طلب الشراء (خطوة الرقابة الأساسية)
function approvePurchaseRequest(id, sessionToken) {
  try {
    if (!ValidationEngine.isRequired(id)) return { success: false, message: "رقم الطلب مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    // [رقابة] الاعتماد يحتاج نفس صلاحية إنشاء أمر شراء فعلي — منطقي إن
    // نفس المستوى اللي يقدر يعمل أمر شراء مباشر هو اللي يقدر يعتمد طلب.
    var permErr = _checkPermission(user, "addPurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };

    var rows = readSheet("PurchaseRequests", PURCHASE_REQUEST_HEADERS);
    var order = rows.find(function (r) {
      return r.id === id;
    });
    if (!order) return { success: false, message: "طلب الشراء غير موجود" };

    var wf = WorkflowEngine.canTransition("PurchaseRequest", order.status, "approve");
    if (!wf.allowed)
      return { success: false, message: "لا يمكن اعتماد طلب في حالة: " + order.status };

    var res = WorkflowEngine.transition({
      workflow: "PurchaseRequest",
      table: "PurchaseRequests",
      recordId: id,
      currentState: order.status,
      action: "approve",
      user: user,
      details: "اعتماد طلب شراء رقم: " + id,
    });
    if (!res.success) return res;

    return {
      success: true,
      data: { id: id, status: res.data.status },
      message: "تم اعتماد طلب الشراء",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// rejectPurchaseRequest — رفض طلب الشراء مع سبب إلزامي
function rejectPurchaseRequest(id, reason, sessionToken) {
  try {
    if (!ValidationEngine.isRequired(id)) return { success: false, message: "رقم الطلب مطلوب" };
    if (!ValidationEngine.isRequired(reason))
      return { success: false, message: "سبب الرفض مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "addPurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };

    var rows = readSheet("PurchaseRequests", PURCHASE_REQUEST_HEADERS);
    var order = rows.find(function (r) {
      return r.id === id;
    });
    if (!order) return { success: false, message: "طلب الشراء غير موجود" };

    var wf = WorkflowEngine.canTransition("PurchaseRequest", order.status, "reject");
    if (!wf.allowed)
      return { success: false, message: "لا يمكن رفض طلب في حالة: " + order.status };

    // نكتب سبب الرفض أولاً (transition بتكتب عمود status بس)، والانتقال
    // نفسه بعدين — لو التحديثين اتعملوا في نداء واحد ممكن نستخدم
    // RepositoryLayer.PurchaseRequests.update مباشرة، لكن الأوضح هنا إننا
    // نسيب WorkflowEngine مسؤول عن status/audit بس ونحدّث السبب بجانبه.
    updateSheetRow("PurchaseRequests", PURCHASE_REQUEST_HEADERS, id, {
      reject_reason: String(reason).trim(),
    });

    var res = WorkflowEngine.transition({
      workflow: "PurchaseRequest",
      table: "PurchaseRequests",
      recordId: id,
      currentState: order.status,
      action: "reject",
      user: user,
      details: "رفض طلب شراء رقم: " + id + " — السبب: " + reason,
    });
    if (!res.success) return res;

    return {
      success: true,
      data: { id: id, status: res.data.status },
      message: "تم رفض طلب الشراء",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// cancelPurchaseRequest — إلغاء طلب شراء (مسودة أو معتمد لم يُحوَّل بعد)
function cancelPurchaseRequest(id, sessionToken) {
  try {
    if (!ValidationEngine.isRequired(id)) return { success: false, message: "رقم الطلب مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "deletePurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };

    var rows = readSheet("PurchaseRequests", PURCHASE_REQUEST_HEADERS);
    var order = rows.find(function (r) {
      return r.id === id;
    });
    if (!order) return { success: false, message: "طلب الشراء غير موجود" };

    var wf = WorkflowEngine.canTransition("PurchaseRequest", order.status, "cancel");
    if (!wf.allowed) {
      var msg =
        order.status === "محوّل"
          ? "لا يمكن إلغاء طلب تم تحويله لأمر شراء بالفعل (" + (order.converted_po_id || "") + ")"
          : "لا يمكن إلغاء طلب في حالة: " + order.status;
      return { success: false, message: msg };
    }

    var res = WorkflowEngine.transition({
      workflow: "PurchaseRequest",
      table: "PurchaseRequests",
      recordId: id,
      currentState: order.status,
      action: "cancel",
      user: user,
      details: "إلغاء طلب شراء رقم: " + id,
    });
    if (!res.success) return res;

    return {
      success: true,
      data: { id: id, status: res.data.status },
      message: "تم إلغاء طلب الشراء",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// deletePurchaseRequest — حذف فعلي (مسودة/مرفوض/ملغي فقط)
function deletePurchaseRequest(id, sessionToken) {
  try {
    if (!ValidationEngine.isRequired(id)) return { success: false, message: "رقم الطلب مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    // [ENGINE-UNIFY-FIX] كانت هنا بتفحص صلاحية "deletePurchaseInvoice" غلط
    // بدل "deletePurchaseRequest" — رغم إن DeleteEngine نفسه مسجّل الصلاحية
    // الصح لنفس الـ entity (راجع purchaseRequest.permissionAction في
    // Code_44_DeleteEngine.js). كانت بتسمح لأي مستخدم عنده صلاحية حذف
    // فواتير الشراء بس إنه يحذف طلبات شراء بدون الصلاحية الفعلية المطلوبة.
    var permErr = _checkPermission(user, "deletePurchaseRequest", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };

    var rows = readSheet("PurchaseRequests", PURCHASE_REQUEST_HEADERS);
    var order = rows.find(function (r) {
      return r.id === id;
    });
    if (!order) return { success: false, message: "طلب الشراء غير موجود" };
    if (order.status === "معتمد" || order.status === "محوّل") {
      return { success: false, message: "لا يمكن حذف طلب معتمد أو تم تحويله" };
    }

    deleteFromSheet("PurchaseRequests", id);
    logAudit(user, "حذف طلب شراء", "PurchaseRequests", id, order, null);
    return { success: true, message: "تم الحذف" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// convertPurchaseRequestToPO — تحويل طلب معتمد لأمر شراء فعلي
// بيستخدم savePurchaseOrder الموجودة فعلاً في Code_27_PurchaseOrders.gs
// بدل تكرار منطق إنشاء أمر الشراء — المستخدم بيكمّل المورد/الأسعار على
// أمر الشراء الناتج (الطلب الداخلي مالوش سعر أو مورد ملزم أصلاً).
function convertPurchaseRequestToPO(data, sessionToken) {
  try {
    if (!data || !ValidationEngine.isRequired(data.id))
      return { success: false, message: "رقم الطلب مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "addPurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };

    var rows = readSheet("PurchaseRequests", PURCHASE_REQUEST_HEADERS, {
      parseJson: ["lines_json"],
    });
    var order = rows.find(function (r) {
      return r.id === data.id;
    });
    if (!order) return { success: false, message: "طلب الشراء غير موجود" };

    var wf = WorkflowEngine.canTransition("PurchaseRequest", order.status, "convert");
    if (!wf.allowed)
      return {
        success: false,
        message: "يجب اعتماد الطلب أولاً قبل تحويله لأمر شراء",
      };

    if (!ValidationEngine.isRequired(data.supplier))
      return { success: false, message: "اختر المورد لأمر الشراء" };

    var reqLines = Array.isArray(order.lines_json) ? order.lines_json : [];
    var poLines = (data.lines && data.lines.length ? data.lines : reqLines).map(
      function (l) {
        return {
          item_id: l.item_id,
          qty: Number(l.qty || 0),
          price: Number(l.price || 0),
          color: l.color || "",
        };
      },
    );
    if (!poLines.length)
      return { success: false, message: "لا يوجد بنود صالحة للتحويل" };

    var poResult = savePurchaseOrder(
      {
        date: data.date,
        supplier: data.supplier,
        warehouse: data.warehouse || order.warehouse,
        payment_terms: data.payment_terms || "",
        expected_date: data.expected_date || order.needed_by_date,
        notes:
          "مُحوَّل من طلب شراء رقم: " +
          order.id +
          (data.notes ? " — " + data.notes : ""),
        discount_value: Number(data.discount_value || 0),
        discount_type: data.discount_type || "percent",
        discount_amount: Number(data.discount_amount || 0),
        vat_percent: Number(data.vat_percent || 0),
        vat_amount: Number(data.vat_amount || 0),
        subtotal: Number(data.subtotal || 0),
        net_total: Number(data.net_total || 0),
        lines: poLines,
      },
      sessionToken,
    );
    if (!poResult.success) return poResult;

    var res = WorkflowEngine.transition({
      workflow: "PurchaseRequest",
      table: "PurchaseRequests",
      recordId: order.id,
      currentState: order.status,
      action: "convert",
      user: user,
      details: "تحويل طلب شراء رقم: " + order.id + " → أمر شراء " + poResult.data.id,
    });
    if (!res.success) return res;

    updateSheetRow("PurchaseRequests", PURCHASE_REQUEST_HEADERS, order.id, {
      converted_po_id: poResult.data.id,
    });

    return {
      success: true,
      data: { id: order.id, status: res.data.status, po: poResult.data },
      message: "تم تحويل الطلب لأمر شراء رقم: " + poResult.data.id,
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// نهاية §PURCHASE-REQUESTS
