// ════════════════════════════════════════════════════════════════
// Code_17b_ProductionOrders.js — [CONSOLIDATE-2026-07-27] نُقل بالكامل من
// Code_16_Inventory.js (كان أمر الإنتاج ومراحل الإنتاج/تنفيذاتها موجودين
// هناك رغم إنهم مفهوميًا تصنيع، مش مخزون — راجع
// moo-erp-accounting-inventory-deepdive.md و moo-erp-manufacturing-deepdive.md).
// نقل نصي بحت — صفر تغيير في المنطق أو أسماء الدوال. كل ملفات .gs بتعمل في
// نفس الـ Global Scope في Apps Script فالاستدعاءات القديمة (مثل استدعاءات
// المخزون/الرواتب لمراحل الإنتاج) فضلت شغالة زي ما هي من غير أي تعديل.
//
// ⚠️ ملاحظة تسمية مهمة (من تقرير التصنيع): "PO" هنا تعني Production Order
// (أمر إنتاج)، وليس Purchase Order (أمر شراء، في Code_27_PurchaseOrders.js).
// اتفحص الملفان معًا عمدًا وتأكد إنه لا يوجد تصادم أسماء بينهما (كلاهما
// _buildPORow/_validatePO هنا مقابل أسماء مختلفة تمامًا هناك).
// ════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────
// §16  Production Orders CRUD
//
// _buildPORow()            — بناء صف أمر الإنتاج
// _validatePO()            — التحقق من صحة بيانات الأمر
// addProductionOrder()     — إضافة أمر جديد
// updateProductionOrder()  — تعديل أمر موجود
// updateProductionOrderStatus() — تحديث حالة الأمر
// deleteProductionOrder()  — حذف أمر
// ─────────────────────────────────────────────────────────────
function _buildPORow(order, id, date, status, closedAt) {
  // ── sizes_json: يحفظ الألوان + الكميات + جدول المقاسات + تسميات المقاسات ──
  var sizesData = {
    colors: order.sizes || [],
    sizes_table: order.sizes_table || [],
    sizes_labels: order.sizes_labels || [],
  };
  const sizesJson = JSON.stringify(sizesData);

  // ── notes: يحفظ نص الملاحظة فقط (منفصل عن بيانات القص) ──
  var notesVal = order.notes || "";
  // لو notes فيها JSON قديم من saveCuttingData، احتفظ بيه كما هو
  if (notesVal && notesVal.trim().startsWith("{")) {
    // لا تعدّله — بيانات القص محفوظة فيه
  }

  return [
    id,
    date,
    order.product_id,
    Number(order.quantity) || 0,
    status,
    notesVal,
    order.user || "",
    order.patron_number || "",
    Number(order.fabric_meters || 0),
    Number(order.lining_meters || 0),
    sizesJson,
    closedAt || "",
  ];
}

function _validatePO(order) {
  if (!order.product_id) return "يجب تحديد المنتج";
  // الكمية مقبولة من quantity أو target_quantity أو مجموع colors
  var qty =
    Number(order.quantity || 0) ||
    Number(order.target_quantity || 0) ||
    (Array.isArray(order.sizes)
      ? order.sizes.reduce(function (s, c) {
          return s + Number(c.qty || 0);
        }, 0)
      : 0);
  if (!qty || qty <= 0) return "الكمية يجب أن تكون أكبر من صفر";
  return null;
}

function addProductionOrder(order) {
  try {
    var permErr = _checkPermission(
      order.user,
      "addProductionOrder",
      order.sessionToken,
    );
    if (permErr) return permErr;
    // [FIX-AUDIT #2] enable_production كان يُحفظ ويُقرأ من System Settings
    // لكن وحدة الإنتاج كانت تعمل دائمًا بغض النظر عن قيمته (Dead Setting).
    // الآن: لو الأدمن أوقف الوحدة صراحة، إنشاء أمر إنتاج جديد يُرفض من
    // الـ backend (وليس فقط بإخفاء الزر في الواجهة). لا نمنع عرض/تعديل
    // الأوامر القائمة أصلاً، فقط إنشاء أوامر جديدة.
    try {
      var _prodSettings = _getCompanySettingsRaw();
      if (_prodSettings.enable_production === false) {
        return errResponse(
          " وحدة الإنتاج (Manufacturing) معطّلة من إعدادات النظام",
        );
      }
    } catch (eProdSettings) {
      Logger.log("[silent-catch] " + eProdSettings);
    }
    const err = _validatePO(order);
    if (err) return errResponse(err);

    // استخدم رقم الأمر من الفرونت لو موجود، وإلا ولّد واحد جديد
    var poId = (order.order_number || "").trim() || makeId("PO");

    // تأكد إن الرقم مش مكرر
    var existing = getSheetData("ProductionOrders");
    var duplicate = existing.some(function (r) {
      return String(r.id || "").trim() === poId;
    });
    if (duplicate) poId = makeId("PO"); // fallback لو مكرر

    var _poRow = _buildPORow(order, poId, new Date(), "pending", "");
    var _poSheet = getSheet("ProductionOrders");
    // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
    // _appendRowProtected).
    _poSheet
      .getRange(_poSheet.getLastRow() + 1, 1, 1, _poRow.length)
      .setFontColor(null);
    _poSheet.appendRow(_poRow);
    AuditEngine.log("ADD_PRODUCTION_ORDER", {
      user: order.user || "SYSTEM",
      table: "ProductionOrders",
      record_id: poId, // BUG-1 FIX: كان 'id' (undefined) → صحّح لـ 'poId'
      details:
        "أمر إنتاج جديد | صنف: " +
        order.product_id +
        " | كمية: " +
        order.quantity});
    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم إنشاء أمر الإنتاج بنجاح", { id: poId });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateProductionOrder(id, order) {
  try {
    var permErr = _checkPermission(
      order.user,
      "updateProductionOrder",
      order.sessionToken,
    );
    if (permErr) return permErr;
    const err = _validatePO(order);
    if (err) return errResponse(err);
    const row = findRow(getSheetData("ProductionOrders"), "id", id);
    if (!row) return errResponse("أمر الإنتاج غير موجود");

    getSheet("ProductionOrders")
      .getRange(row._row, 1, 1, 12)
      .setValues([
        _buildPORow(
          { ...order, user: row.user || "" },
          id,
          row.date,
          row.status,
          row.closed_at,
        ),
      ]);
    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم تعديل أمر الإنتاج بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// [P9-FIX] أُضيف callerUser و sessionToken — كانت الدالة مكشوفة بلا أي فحص صلاحية
// الـ frontend يُمرِّر: { fn: "updateProductionOrderStatus", args: [id, status, callerUser, sessionToken] }
function updateProductionOrderStatus(id, status, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "updateProductionOrderStatus",
      sessionToken,
    );
    if (permErr) return permErr;

    const VALID_STATUSES = ["pending", "inprogress", "done", "cancelled"];
    if (!VALID_STATUSES.includes(status)) return errResponse("حالة غير صالحة");

    const row = findRow(getSheetData("ProductionOrders"), "id", id);
    if (!row) return errResponse("أمر الإنتاج غير موجود");

    // [WORKFLOW-ENGINE / UNIFY-FIX] كانت الدالة قبل كده بتقبل أي status
    // جديد من القائمة البيضاء فوق بغض النظر عن الحالة الحالية للأمر (يعني
    // كان ينفع تنتقل من "done" لـ "pending"). دلوقتي التحقق من صحة الانتقال
    // بقى عبر آلة الحالة الموحّدة (Code_39_WorkflowEngine.gs، تعريف
    // "ProductionOrder") بدل ما يتقبل أي قيمة. ده تصحيح سلوك فعلي وليس
    // مجرد إعادة هيكلة — لو محتاج تسمح بانتقالات إضافية (رجوع لحالة سابقة
    // مثلاً)، عدّل التعريف في Code_39_WorkflowEngine.gs بدل ما تفكّ الربط هنا.
    var wf = WorkflowEngine.canReachState("ProductionOrder", row.status, status);
    if (!wf.allowed) return errResponse(wf.message);

    const closedAt = status === "done" ? new Date() : row.closed_at || "";
    var poSheet = getSheet("ProductionOrders");
    // [ENGINE-AUDIT / Update Engine] كان بينادي setValue مرتين منفصلتين
    // (status ثم closed_at) — استُبدل بـ _applyRowUpdates الموحّدة. الأعمدة
    // هنا بترتيب ثابت (5=status، 12=closed_at) بدل أسماء headers، فبنبني
    // مصفوفة headers-by-position بسيطة عشان _applyRowUpdates تلاقي أسماء.
    var _poStatusHeaders = [];
    _poStatusHeaders[4] = "status";
    _poStatusHeaders[11] = "closed_at";
    _applyRowUpdates(poSheet, row._row, _poStatusHeaders, {
      status: status,
      closed_at: closedAt,
    });

    const STATUS_LABELS = {
      pending: "معلق",
      inprogress: "قيد التنفيذ",
      done: "مكتمل",
      cancelled: "ملغي",
    };
    AuditEngine.log("UPDATE_PO_STATUS:" + status, {
      user: "SYSTEM",
      table: "ProductionOrders",
      record_id: id,
      details: "تغيير حالة أمر إنتاج إلى: " + status});
    return okResponse(
      " تم تحديث الحالة إلى: " + (STATUS_LABELS[status] || status),
    );
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteProductionOrder(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "deleteProductionOrder", sessionToken);
    if (permErr) return permErr;
    const row = findRow(getSheetData("ProductionOrders"), "id", id);
    if (!row) return errResponse("أمر الإنتاج غير موجود");

    // [DELETE-FIX-3] كانت الدالة بتحذف أمر الإنتاج بلا أي فحص لحالته —
    // أمر "قيد التنفيذ" أو "مكتمل" ممكن يكون له بيانات قص/مراحل مرتبطة
    // (راجع saveCuttingData وProductionStages)، فحذفه المباشر يسيب هذه
    // البيانات يتيمة بلا أي أمر أصلي تتبع له.
    if (row.status === "inprogress" || row.status === "done") {
      return errResponse(
        "لا يمكن حذف أمر إنتاج قيد التنفيذ أو مكتمل — قم بإلغائه أولاً (تغيير الحالة إلى ملغي) إن كان ذلك مسموحًا",
      );
    }

    getSheet("ProductionOrders").deleteRow(row._row);
    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم حذف أمر الإنتاج");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §17  Cutting Data
// ─────────────────────────────────────────────────────────────
/**
 * saveCuttingData
 * تحفظ بيانات القص (ثري/كسر لكل لون + متراج فعلي) على أمر الإنتاج.
 * يُخزَّن في عمود notes كـ JSON — ويحرّك الأمر من pending إلى inprogress تلقائياً.
 *
 * @param {string} poId        - رقم أمر الإنتاج (مثال: PO-0001)
 * @param {object} cuttingData - بيانات القص من الفرونت إند
 */
// [P9-FIX] أُضيف callerUser و sessionToken — كانت الدالة مكشوفة بلا أي فحص صلاحية
function saveCuttingData(poId, cuttingData, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "saveCuttingData", sessionToken);
    if (permErr) return permErr;

    if (!poId) return errResponse("يجب تحديد أمر الإنتاج");
    if (!cuttingData || !cuttingData.colors || !cuttingData.colors.length) {
      return errResponse("بيانات القص فارغة");
    }

    const rows = getSheetData("ProductionOrders");
    const row = findRow(rows, "id", poId);
    if (!row) return errResponse("أمر الإنتاج غير موجود: " + poId);

    // لو في notes قديمة كنص عادي، احتفظ بها داخل البيانات
    const existingNotes = String(row.notes || "").trim();
    if (existingNotes && !existingNotes.startsWith("{")) {
      cuttingData.user_notes = existingNotes;
    }

    // HEADERS.ProductionOrders:
    // id(1) date(2) product_id(3) quantity(4) status(5) notes(6)
    // user(7) patron_number(8) fabric_meters(9) lining_meters(10) sizes_json(11) closed_at(12)
    const NOTES_COL = 6;
    const STATUS_COL = 5;

    const poSheet = getSheet("ProductionOrders");
    poSheet.getRange(row._row, NOTES_COL).setValue(JSON.stringify(cuttingData));

    // حرّك الأمر لـ inprogress لو كان معلقاً
    if (row.status === "pending") {
      poSheet.getRange(row._row, STATUS_COL).setValue("inprogress");
    }

    const totalPieces = Number(cuttingData.total_pieces || 0);
    return okResponse(
      " تم حفظ بيانات القص بنجاح — إجمالي " + totalPieces + " قطعة",
    );
  } catch (e) {
    return errResponse("خطأ في حفظ بيانات القص: " + e.message);
  }
}

// ╔══════════════════════════════════════════════════════════════╗
// ║   نظام الصلاحيات المتكامل v3 — Permissions System           ║
// ║   ملف: Permissions_Backend.js                               ║
// ║                                                              ║

// ┄┄┄ [مصدر: Code.js سطور 23638-24079] Production Stages Piece Rates ┄┄┄
// §EXT-PS  مراحل الإنتاج (Production Stages) — أجور القطعة
//
// ProductionStages   — تعريف المراحل وأسعارها لكل وحدة
// StageExecutions    — سجل فعلي لكل عملية تنفيذ مرحلة بواسطة موظف
//
// كل أرقام "عدد التنفيذات" / "إجمالي الكمية" / "الموظفون المرتبطون" المعروضة
// في الشاشة تُحسب ديناميكياً من StageExecutions — لا تُخزَّن كأرقام ثابتة.
// ═══════════════════════════════════════════════════════════════════════════════

// ── قراءة كل مراحل الإنتاج مع إحصائياتها المحسوبة ──
function getProductionStages(callerUser, sessionToken) {
  try {
    if (callerUser) {
      var _permErr = _checkPermission(
        callerUser,
        "viewProductionStages",
        sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var stages = readSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
      { trimStrings: true },
    );
    var execs = readSheet(
      "StageExecutions",
      ACCOUNTING_HR_HEADERS.StageExecutions,
      { trimStrings: true },
    );
    var depts = readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments, {
      trimStrings: true,
    });
    var employees = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });

    var deptById = {};
    depts.forEach(function (d) {
      deptById[d.id] = d.name;
    });
    var empById = {};
    var empDeptById = {};
    employees.forEach(function (e) {
      empById[e.id] = e.full_name;
      empDeptById[e.id] = deptById[e.department_id] || "";
    });

    var data = stages.map(function (s) {
      var stageExecs = execs.filter(function (ex) {
        return String(ex.stage_id) === String(s.id);
      });

      var executions = stageExecs.length;
      var total_qty = stageExecs.reduce(function (a, ex) {
        return a + (Number(ex.qty) || 0);
      }, 0);

      // تجميع الموظفين المرتبطين بكمياتهم
      var empMap = {};
      stageExecs.forEach(function (ex) {
        var key = String(ex.employee_id);
        if (!empMap[key]) {
          empMap[key] = {
            employee_id: ex.employee_id,
            name: empById[ex.employee_id] || "غير معروف",
            initials: _psInitials(empById[ex.employee_id] || ""),
            dept: empDeptById[ex.employee_id] || "",
            qty: 0,
          };
        }
        empMap[key].qty += Number(ex.qty) || 0;
      });

      return {
        id: s.id,
        code: s.code,
        name: s.name,
        description: s.description || "",
        department_id: s.department_id,
        department: deptById[s.department_id] || "",
        unit: s.unit || "قطعة",
        price: Number(s.price) || 0,
        status: s.status || "active",
        notes: s.notes || "",
        created_at: s.created_at,
        updated_at: s.updated_at,
        executions: executions,
        total_qty: total_qty,
        linked_employees: Object.keys(empMap).map(function (k) {
          return empMap[k];
        }),
      };
    });

    return { success: true, data: data };
  } catch (e) {
    return errResponse("خطأ في جلب مراحل الإنتاج: " + e.message);
  }
}

function _psInitials(fullName) {
  var parts = String(fullName || "")
    .trim()
    .split(/\s+/);
  if (!parts.length || !parts[0]) return "؟";
  if (parts.length === 1) return parts[0].substr(0, 2);
  return parts[0].charAt(0) + parts[1].charAt(0);
}

function addProductionStage(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addProductionStage",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    if (!data.name || !String(data.name).trim())
      return errResponse("اسم المرحلة مطلوب");
    if (!data.department_id) return errResponse("القسم مطلوب");
    var price = Number(data.price);
    if (!price || price <= 0) return errResponse("يرجى إدخال سعر صحيح");

    var sheet = getSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
    );
    var existing = readSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
    );

    var id = makeId("PS");
    var now = new Date().toISOString();
    var code = data.code && String(data.code).trim();
    if (!code) {
      code = "PS-" + String(existing.length + 1).padStart(3, "0");
    }
    // ضمان عدم تكرار الكود
    var dupCode = existing.find(function (r) {
      return String(r.code) === String(code);
    });
    if (dupCode) return errResponse("كود المرحلة موجود مسبقاً");

    var _psRow = [
      id,
      code,
      String(data.name).trim(),
      data.description || "",
      data.department_id,
      data.unit || "قطعة",
      price,
      data.status || "active",
      data.notes || "",
      data.callerUser,
      now,
      now,
    ];
    // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
    // _appendRowProtected).
    sheet
      .getRange(sheet.getLastRow() + 1, 1, 1, _psRow.length)
      .setFontColor(null);
    sheet.appendRow(_psRow);

    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تمت إضافة المرحلة بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة المرحلة: " + e.message);
  }
}

function updateProductionStage(id, data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateProductionStage",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
    );
    var rows = readSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return String(r.id) === String(id);
    });
    if (idx === -1) return errResponse("المرحلة غير موجودة");

    if (data.price !== undefined && Number(data.price) <= 0)
      return errResponse("يرجى إدخال سعر صحيح");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    var fields = [
      "code",
      "name",
      "description",
      "department_id",
      "unit",
      "price",
      "status",
      "notes",
    ];
    var updates = {}; // [PERF-BATCH-1]
    fields.forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    var updatedAtCol = headers.indexOf("updated_at");
    if (updatedAtCol !== -1) updates["updated_at"] = new Date().toISOString();
    _applyRowUpdates(sheet, rowNum, headers, updates);

    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حفظ التغييرات بنجاح");
  } catch (e) {
    return errResponse("خطأ في تعديل المرحلة: " + e.message);
  }
}

function deleteProductionStage(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    var _permErr = _checkPermission(
      callerUser,
      "deleteProductionStage",
      sessionToken,
    );
    if (_permErr) return _permErr;

    // امنع الحذف لو مرتبطة بتنفيذات — حفاظاً على سلامة البيانات (نفس منطق الفرونت)
    var execs = readSheet(
      "StageExecutions",
      ACCOUNTING_HR_HEADERS.StageExecutions,
    );
    var hasExecs = execs.some(function (ex) {
      return String(ex.stage_id) === String(id);
    });
    if (hasExecs)
      return errResponse(
        "لا يمكن حذف هذه المرحلة لأنها مرتبطة بتنفيذات مسجلة. يمكنك إيقافها بدلاً من حذفها.",
      );

    var rows = readSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
    );
    var idx = rows.findIndex(function (r) {
      return String(r.id) === String(id);
    });
    if (idx === -1) return errResponse("المرحلة غير موجودة");

    getSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
    ).deleteRow(idx + 2);

    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف المرحلة بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف المرحلة: " + e.message);
  }
}

// ── تنفيذات المراحل (StageExecutions) — تسجيل عمل الموظف الفعلي على مرحلة ──

function getStageExecutions(filters) {
  try {
    filters = filters || {};
    // [DATALAYER-ENGINE-MIGRATION] قراءة فقط — DataLayer.getAll بيدعم
    // ACCOUNTING_HR_HEADERS تلقائيًا كـ fallback (راجع Code_34 §DLE-4 _headersFor)
    var res = DataLayer.getAll("StageExecutions", { trimStrings: true });
    var rows = res.success ? res.data : [];
    if (filters.stage_id) {
      rows = rows.filter(function (r) {
        return String(r.stage_id) === String(filters.stage_id);
      });
    }
    if (filters.employee_id) {
      rows = rows.filter(function (r) {
        return String(r.employee_id) === String(filters.employee_id);
      });
    }
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب سجل التنفيذات: " + e.message);
  }
}

function addStageExecution(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addStageExecution",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    // [VALIDATION-ENGINE-MIGRATION] فحص الحقول المطلوبة فقط — منطق الكمية/
    // الكمية المرفوضة تحته متروك زي ما هو لارتباطه المباشر بحساب الأجر
    // (generatePayroll)، خارج نطاق هذا التوحيد.
    if (!ValidationEngine.isRequired(data.stage_id))
      return errResponse("المرحلة مطلوبة");
    if (!ValidationEngine.isRequired(data.employee_id))
      return errResponse("الموظف مطلوب");
    var qty = Number(data.qty);
    if (!qty || qty <= 0) return errResponse("يرجى إدخال كمية صحيحة");

    // ── [REMEDIATION-4] الكمية المرفوضة — تُخصم من الكمية المحتسبة في الأجر ──
    var qtyRejected = Number(data.qty_rejected) || 0;
    if (qtyRejected < 0)
      return errResponse("الكمية المرفوضة لا يمكن أن تكون سالبة");
    if (qtyRejected > qty)
      return errResponse(
        "الكمية المرفوضة لا يمكن أن تتجاوز إجمالي الكمية المنفَّذة",
      );

    var stages = readSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
    );
    var stage = stages.find(function (s) {
      return String(s.id) === String(data.stage_id);
    });
    if (!stage) return errResponse("المرحلة غير موجودة");

    var unitPrice = Number(stage.price) || 0;
    // [REMEDIATION-4] الأجر يُحسَب على الكمية المقبولة فقط (qty - qty_rejected)
    var payableQty = qty - qtyRejected;
    var totalAmount = unitPrice * payableQty;

    var id = makeId("SX");
    var now = new Date().toISOString();

    // ── [REMEDIATION-1] + [REMEDIATION-2] ──
    // تم إلغاء الترحيل المحاسبي الفوري المنفصل الذي كان هنا سابقاً (قيد PRODUCTION_WAGES
    // لحظياً عند كل تنفيذ) لأنه كان يُنشئ مساراً مالياً مزدوجاً ومنعزلاً تماماً عن دورة
    // الرواتب الرسمية (راجع تقرير التدقيق — المرحلة 5: Production ↔ Payroll Integration).
    // بدلاً من ذلك: يُسجَّل التنفيذ بحالة أولية "PENDING_APPROVAL" [REMEDIATION-7]، وبعد
    // اعتماد مشرف/جودة (approveStageExecution) تتحول لـ "PENDING_PAYROLL"، ثم يتم تجميعه
    // وترحيله محاسبياً مرة واحدة فقط ضمن generatePayroll() + _autoJournalFromPayroll()
    // عند توليد مسير الرواتب للفترة التي يقع فيها exec_date — بنفس معاملة الضريبة/التأمين
    // المطبَّقة على باقي بنود الراتب. راجع أيضاً حقلي payroll_status/payroll_period_id.
    var _sxSheet = getSheet(
      "StageExecutions",
      ACCOUNTING_HR_HEADERS.StageExecutions,
    );
    var _sxRow = [
      id,
      data.stage_id,
      data.employee_id,
      qty,
      unitPrice,
      totalAmount,
      data.exec_date || now.split("T")[0],
      data.notes || "",
      data.callerUser,
      now,
      qtyRejected,
      "PENDING_APPROVAL", // [REMEDIATION-7] لازم اعتماد قبل ما يدخل دورة الرواتب
      "", // payroll_period_id — يُملأ عند تضمين التنفيذ ضمن مسير رواتب
      "", // approved_by — يُملأ بواسطة approveStageExecution
      "", // approved_at
    ];
    // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
    // _appendRowProtected).
    _sxSheet
      .getRange(_sxSheet.getLastRow() + 1, 1, 1, _sxRow.length)
      .setFontColor(null);
    _sxSheet.appendRow(_sxRow);

    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(
      "تم تسجيل التنفيذ بنجاح — بانتظار اعتماد المشرف/الجودة قبل دخوله مسير الرواتب",
      {
        id: id,
        qty: qty,
        qty_rejected: qtyRejected,
        payable_qty: payableQty,
        total_amount: totalAmount,
      },
    );
  } catch (e) {
    return errResponse("خطأ في تسجيل التنفيذ: " + e.message);
  }
}

// ── [REMEDIATION-7] اعتماد تنفيذ مرحلة إنتاج قبل دخوله دورة الرواتب ──
// صلاحية منفصلة عن addStageExecution عمداً: اللي بيسجّل التنفيذ (ممكن يكون operator/
// supervisor) مش بالضرورة نفس الشخص المخوَّل يعتمده مالياً. بعد الاعتماد فقط يتحول
// payroll_status إلى "PENDING_PAYROLL" فيصبح مؤهلاً للظهور في generatePayroll().
function approveStageExecution(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "approveStageExecution",
      sessionToken,
    );
    if (_permErr) return _permErr;

    if (!id) return errResponse("معرف التنفيذ مطلوب");

    var sheet = getSheet(
      "StageExecutions",
      ACCOUNTING_HR_HEADERS.StageExecutions,
    );
    var rows = readSheet(
      "StageExecutions",
      ACCOUNTING_HR_HEADERS.StageExecutions,
    );
    var idx = rows.findIndex(function (r) {
      return String(r.id) === String(id);
    });
    if (idx === -1) return errResponse("سجل التنفيذ غير موجود");

    var row = rows[idx];
    if (row.payroll_status !== "PENDING_APPROVAL") {
      return errResponse(
        "لا يمكن اعتماد هذا التنفيذ — حالته الحالية: " +
          (row.payroll_status || "غير معروفة") +
          " (متوقَّع: PENDING_APPROVAL)",
      );
    }

    var headers = ACCOUNTING_HR_HEADERS.StageExecutions;
    var statusCol = headers.indexOf("payroll_status") + 1;
    var approvedByCol = headers.indexOf("approved_by") + 1;
    var approvedAtCol = headers.indexOf("approved_at") + 1;
    var now = new Date().toISOString();

    sheet.getRange(idx + 2, statusCol).setValue("PENDING_PAYROLL");
    sheet.getRange(idx + 2, approvedByCol).setValue(callerUser);
    sheet.getRange(idx + 2, approvedAtCol).setValue(now);

    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم اعتماد التنفيذ — سيُضاف لمسير الرواتب القادم", {
      id: id,
      approved_by: callerUser,
      approved_at: now,
    });
  } catch (e) {
    return errResponse("خطأ في اعتماد التنفيذ: " + e.message);
  }
}

function deleteStageExecution(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    var _permErr = _checkPermission(
      callerUser,
      "deleteStageExecution",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet(
      "StageExecutions",
      ACCOUNTING_HR_HEADERS.StageExecutions,
    );
    var idx = rows.findIndex(function (r) {
      return String(r.id) === String(id);
    });
    if (idx === -1) return errResponse("سجل التنفيذ غير موجود");

    // [DELETE-FIX-2] كانت الدالة بتحذف أي سجل تنفيذ بلا أي فحص لحالته —
    // بمجرد اعتماد المشرف (approveStageExecution) يتحول السجل لـ
    // PENDING_PAYROLL تمهيدًا لدخوله مسير رواتب (generatePayroll)، ولو
    // اتضمّن فعليًا في مسير رواتب مُولَّد بيبقى مرتبط بقيد محاسبي فعلي.
    // حذفه في اللحظة دي كان بيسيب مسير الرواتب/القيد يشاور على سجل تنفيذ
    // محذوف (بيانات يتيمة) من غير ما يتغيّر أي رقم في الرواتب أو القيود
    // المرحّلة فعلاً — يعني تعارض صامت بين الأجر المدفوع والتنفيذ الفعلي.
    var execRow = rows[idx];
    if (
      execRow.payroll_status &&
      execRow.payroll_status !== "PENDING_APPROVAL"
    ) {
      return errResponse(
        "لا يمكن حذف سجل تنفيذ بعد اعتماده (الحالة الحالية: " +
          execRow.payroll_status +
          ") — يجب إلغاء الاعتماد أولاً، أو استبعاده من مسير الرواتب إن كان مُضمَّنًا فيه بالفعل",
      );
    }

    getSheet(
      "StageExecutions",
      ACCOUNTING_HR_HEADERS.StageExecutions,
    ).deleteRow(idx + 2);

    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف سجل التنفيذ بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف سجل التنفيذ: " + e.message);
  }
}
