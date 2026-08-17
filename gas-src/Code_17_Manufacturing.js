// ═══════════════════════════════════════════════════════════════════════════
// §MFG  موديول التصنيع الجديد (Manufacturing Module) — Enterprise Grade
// راجع: MOO_ERP_Manufacturing_Module_Design_Report.md للتصميم الهندسي الكامل
//
// هذا الملف يُبنى تدريجياً حسب خطة التنفيذ (القسم 10 من التقرير):
// Phase 0 تعريف الجداول + الصلاحيات + مفاتيح الترحيل (في Code_Core.gs / Code_Accounting.gs)
// Phase 1 Step 1 Work Centers + Machines (هذا الملف)
// Phase 1 Step 2 BOM + BOM Lines (هذا الملف)
// Phase 1 Step 3 Routing + Routing Operations (هذا الملف)
//   Phase 1 Step 4..  Manufacturing Orders (الكيان المركزي + الـ Workflow الكامل) (لاحقاً)
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// §MFG-SETUP  إنشاء كل شيتات التصنيع الجديدة دفعة واحدة
// شغّلها مرة واحدة من: Apps Script Editor → Run → setupManufacturingSheets
// (نفس فلسفة setupAllSheets الموجودة — Self-Healing عبر getSheet)
// ─────────────────────────────────────────────────────────────
function setupManufacturingSheets() {
  // [PERF-DEDUP-1] كل شيتات التصنيع دي أصلاً بتُنشأ من setupAllSheets()
  // عبر لوب Object.keys(ACCOUNTING_HR_HEADERS) — كانت بتتكرر هنا تاني
  // بنفس الأسماء بالضبط، يعني ~16 نداء getSheet() زيادة بلا أي فايدة
  // في كل تشغيلة setupEverything (كل نداء بياخد وقت شبكة حتى لو الشيت
  // موجود ومفيش تغيير). مسيبين الدالة موجودة (بترجع رسالة بس) عشان أي
  // كود قديم بينادي عليها لوحده يفضل يشتغل من غير كسر، لكن من غير ما
  // تكرر الإنشاء.
  var summary = "تخطّي — شيتات التصنيع بالفعل مُنشأة ضمن setupAllSheets";
  Logger.log("setupManufacturingSheets:\n" + summary);
  return summary;
}

// ═══════════════════════════════════════════════════════════════════════
// §MFG-WC  مراكز العمل — Work Centers
// ═══════════════════════════════════════════════════════════════════════

function _validateWorkCenter(wc) {
  if (!wc || !String(wc.name || "").trim()) return "اسم مركز العمل مطلوب";
  if (wc.cost_per_hour != null && Number(wc.cost_per_hour) < 0)
    return "تكلفة الساعة لا يمكن أن تكون سالبة";
  return null;
}

function getWorkCenters(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewWorkCenters", sessionToken);
    if (permErr) return permErr;
    var rows = readSheet("WorkCenters", ACCOUNTING_HR_HEADERS.WorkCenters, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return !r.deleted_at;
    });
    return okResponse("", { data: rows });
  } catch (e) {
    return errResponse("خطأ في قراءة مراكز العمل: " + e.message);
  }
}

function addWorkCenter(data) {
  try {
    var permErr = _checkPermission(
      data.user,
      "manageWorkCenters",
      data.sessionToken,
    );
    if (permErr) return permErr;
    var err = _validateWorkCenter(data);
    if (err) return errResponse(err);

    // [DL-MIGRATE] كان appendRow مباشر — دلوقتي عبر DataLayer.insert (نفس
    // ترتيب الأعمدة بالضبط، مع فايدة إضافية: _appendRowProtected تلقائيًا).
    var dl = Repositories.WorkCenters.create(
      {
        code: data.code || "",
        name: data.name,
        department_id: data.department_id || "",
        capacity_per_day: Number(data.capacity_per_day || 0),
        capacity_unit: data.capacity_unit || "",
        cost_per_hour: Number(data.cost_per_hour || 0),
        status: data.status || "active",
        notes: data.notes || "",
        created_by: data.user || "SYSTEM",
        updated_by: data.user || "SYSTEM",
      },
      { idPrefix: "WC" },
    );
    if (!dl.success) return errResponse(dl.errorMessage);
    var id = dl.data.id;
    AuditEngine.log("ADD_WORK_CENTER", {
      user: data.user || "SYSTEM",
      table: "WorkCenters",
      record_id: id,
      details: "مركز عمل جديد: " + data.name});
    return okResponse(" تم إضافة مركز العمل بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateWorkCenter(id, data) {
  try {
    var permErr = _checkPermission(
      data.user,
      "manageWorkCenters",
      data.sessionToken,
    );
    if (permErr) return permErr;
    var err = _validateWorkCenter(data);
    if (err) return errResponse(err);

    // [DL-MIGRATE] كان getRange/setValues بصف كامل مُعاد بناؤه يدويًا —
    // دلوقتي عبر DataLayer.update بتحديث جزئي (نفس النتيجة تمامًا: أي حقل
    // غير مُرسَل يفضل بقيمته الحالية)، مع فايدة إضافية: تنضيف اللون الأبيض
    // القديم للخط تلقائيًا (NO-WHITE-FONT) وهو ما لم يكن يحصل هنا سابقًا.
    var patch = {
      name: data.name,
      status: data.status || "active",
      updated_by: data.user || "SYSTEM",
    };
    if (data.code != null) patch.code = data.code;
    if (data.department_id != null) patch.department_id = data.department_id;
    if (data.capacity_per_day != null)
      patch.capacity_per_day = Number(data.capacity_per_day);
    if (data.capacity_unit != null) patch.capacity_unit = data.capacity_unit;
    if (data.cost_per_hour != null)
      patch.cost_per_hour = Number(data.cost_per_hour);
    if (data.notes != null) patch.notes = data.notes;

    var dl = Repositories.WorkCenters.update(id, patch);
    if (!dl.success)
      return errResponse(
        dl.errorCode === "NOT_FOUND" ? "مركز العمل غير موجود" : dl.errorMessage,
      );

    AuditEngine.log("UPDATE_WORK_CENTER", {
      user: data.user || "SYSTEM",
      table: "WorkCenters",
      record_id: id,
      details: "تعديل مركز عمل: " + data.name});
    return okResponse(" تم تعديل مركز العمل بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteWorkCenter(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "manageWorkCenters", sessionToken);
    if (permErr) return permErr;

    // منع الحذف لو مرتبط بخطوات Routing نشطة أو آلات — Soft Delete فقط بعد التأكد
    // [BRE-ROLLOUT] عبر BusinessRulesEngine.validateBeforeDelete('workCenter', ...)
    // بدل الفحص المباشر هنا — نفس الشروط والرسائل بالظبط، منقولة للمحرك الموحّد.
    var _breCheck = BusinessRulesEngine.validateBeforeDelete("workCenter", {
      id: id,
    });
    if (!_breCheck.success) return errResponse(_breCheck.message);

    // [DL-MIGRATE] كان getRange/setValue على عمودين منفصلين — دلوقتي عبر
    // DataLayer.remove (Soft Delete تلقائي لأن الجدول فيه deleted_at).
    var dl = Repositories.WorkCenters.remove(id, { deletedBy: user || "SYSTEM" });
    if (!dl.success)
      return errResponse(
        dl.errorCode === "NOT_FOUND" ? "مركز العمل غير موجود" : dl.errorMessage,
      );

    AuditEngine.log("DELETE_WORK_CENTER", {
      user: user || "SYSTEM",
      table: "WorkCenters",
      record_id: id,
      details: "حذف مركز عمل (Soft Delete)"});
    return okResponse(" تم حذف مركز العمل بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// §MFG-MCH  الآلات — Machines
// ═══════════════════════════════════════════════════════════════════════

function _validateMachine(m) {
  if (!m || !String(m.name || "").trim()) return "اسم الآلة مطلوب";
  if (!m.work_center_id) return "يجب تحديد مركز العمل التابعة له الآلة";
  if (m.cost_per_hour != null && Number(m.cost_per_hour) < 0)
    return "تكلفة الساعة لا يمكن أن تكون سالبة";
  return null;
}

function getMachines(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewWorkCenters", sessionToken);
    if (permErr) return permErr;
    var rows = readSheet("Machines", ACCOUNTING_HR_HEADERS.Machines, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return !r.deleted_at;
    });
    return okResponse("", { data: rows });
  } catch (e) {
    return errResponse("خطأ في قراءة الآلات: " + e.message);
  }
}

function addMachine(data) {
  try {
    var permErr = _checkPermission(
      data.user,
      "manageWorkCenters",
      data.sessionToken,
    );
    if (permErr) return permErr;
    var err = _validateMachine(data);
    if (err) return errResponse(err);

    // تأكد إن مركز العمل موجود فعلاً
    var centers = readSheet("WorkCenters", ACCOUNTING_HR_HEADERS.WorkCenters);
    var wc = findRow(centers, "id", data.work_center_id);
    if (!wc || wc.deleted_at) return errResponse("مركز العمل المحدد غير موجود");

    // [DL-MIGRATE] appendRow → DataLayer.insert
    var dl = Repositories.Machines.create(
      {
        code: data.code || "",
        name: data.name,
        work_center_id: data.work_center_id,
        cost_per_hour: Number(data.cost_per_hour || 0),
        fixed_asset_id: data.fixed_asset_id || "",
        status: data.status || "active",
        purchase_date: data.purchase_date || "",
        notes: data.notes || "",
        created_by: data.user || "SYSTEM",
        updated_by: data.user || "SYSTEM",
      },
      { idPrefix: "MCH" },
    );
    if (!dl.success) return errResponse(dl.errorMessage);
    var id = dl.data.id;
    AuditEngine.log("ADD_MACHINE", {
      user: data.user || "SYSTEM",
      table: "Machines",
      record_id: id,
      details:
        "آلة جديدة: " + data.name + " | مركز عمل: " + data.work_center_id});
    return okResponse(" تم إضافة الآلة بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateMachine(id, data) {
  try {
    var permErr = _checkPermission(
      data.user,
      "manageWorkCenters",
      data.sessionToken,
    );
    if (permErr) return permErr;
    var err = _validateMachine(data);
    if (err) return errResponse(err);

    // [DL-MIGRATE] getRange/setValues → DataLayer.update (تحديث جزئي)
    var patch = {
      name: data.name,
      status: data.status || "active",
      updated_by: data.user || "SYSTEM",
    };
    if (data.code != null) patch.code = data.code;
    if (data.work_center_id) patch.work_center_id = data.work_center_id;
    if (data.cost_per_hour != null)
      patch.cost_per_hour = Number(data.cost_per_hour);
    if (data.fixed_asset_id != null) patch.fixed_asset_id = data.fixed_asset_id;
    if (data.purchase_date != null) patch.purchase_date = data.purchase_date;
    if (data.notes != null) patch.notes = data.notes;

    var dl = Repositories.Machines.update(id, patch);
    if (!dl.success)
      return errResponse(
        dl.errorCode === "NOT_FOUND" ? "الآلة غير موجودة" : dl.errorMessage,
      );

    AuditEngine.log("UPDATE_MACHINE", {
      user: data.user || "SYSTEM",
      table: "Machines",
      record_id: id,
      details: "تعديل آلة: " + data.name});
    return okResponse(" تم تعديل الآلة بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteMachine(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "manageWorkCenters", sessionToken);
    if (permErr) return permErr;

    // منع الحذف لو مرتبطة بخطوات Routing أو تنفيذات فعلية موثقة
    var ops = readSheet(
      "RoutingOperations",
      ACCOUNTING_HR_HEADERS.RoutingOperations,
    );
    var linked = ops.some(function (o) {
      return String(o.machine_id) === String(id);
    });
    if (linked)
      return errResponse("لا يمكن حذف الآلة — مرتبطة بخطوات تشغيل (Routing)");

    // [DL-MIGRATE] getRange/setValue → DataLayer.remove (Soft Delete)
    var dl = Repositories.Machines.remove(id, { deletedBy: user || "SYSTEM" });
    if (!dl.success)
      return errResponse(
        dl.errorCode === "NOT_FOUND" ? "الآلة غير موجودة" : dl.errorMessage,
      );

    AuditEngine.log("DELETE_MACHINE", {
      user: user || "SYSTEM",
      table: "Machines",
      record_id: id,
      details: "حذف آلة (Soft Delete)"});
    return okResponse(" تم حذف الآلة بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// §MFG-BOM  قوائم المكونات — Bill of Materials (BOM + BOM Lines)
// راجع القسم 4.1/4.2/6.1 من التقرير الهندسي للقواعد الكاملة
// ═══════════════════════════════════════════════════════════════════════

function _isTruthyFlag(v) {
  return v === true || v === "true" || v === "TRUE" || v === 1 || v === "1";
}

function _validateBOMHeader(data) {
  if (!data || !String(data.product_id || "").trim())
    return "الصنف المُصنَّع (Product) مطلوب";
  if (data.output_qty == null || Number(data.output_qty) <= 0)
    return "كمية الإنتاج (Output Qty) يجب أن تكون أكبر من صفر";
  return null;
}

function _validateBOMLines(lines, productId) {
  if (!lines || !lines.length) return "يجب إضافة مكوّن واحد على الأقل";
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!l || !String(l.component_item_id || "").trim())
      return "المكوّن مطلوب في السطر " + (i + 1);
    if (String(l.component_item_id) === String(productId))
      return (
        "لا يمكن أن يكون المكوّن هو نفس الصنف المُصنَّع (السطر " + (i + 1) + ")"
      );
    if (l.quantity == null || Number(l.quantity) <= 0)
      return "الكمية يجب أن تكون أكبر من صفر في السطر " + (i + 1);
    if (l.scrap_percent != null && Number(l.scrap_percent) < 0)
      return "نسبة الهالك لا يمكن أن تكون سالبة في السطر " + (i + 1);
  }
  return null;
}

/**
 * فحص استباقي لمنع BOM دائري (Circular BOM): هل استخدام componentId كمكوّن
 * داخل BOM الخاص بـ productId يمكن أن يؤدي —عبر مستويات Multi-Level— لدورة
 * ترجع لنفس productId؟ محدود بعمق أقصى (راجع BOM_MAX_CYCLE_CHECK_DEPTH)
 * تفادياً لأي حلقة تنفيذ لا نهائية على منصة GAS.
 *
 * [MAINT-FIX-6] كان الحد الأقصى القديم 5 مستويات فقط، وكان يرجّع `false`
 * (يعني "مفيش حلقة") بمجرد تجاوز العمق ده — يعني تسلسل تصنيع حقيقي أعمق
 * من 5 مستويات (زي منتجات الأثاث/الإلكترونيات متعددة المراحل) كان ممكن
 * يقبل BOM فيه حلقة دائرية فعلية عند مستوى أعمق من غير أي تحذير. الإصلاح:
 * (أ) رفع الحد الأقصى ليغطي تسلسلات تصنيع واقعية أعمق، و(ب) لو البحث
 * لسه وصل لأقصى عمق من غير ما يوصل لقرار قاطع، نرجّع `true` (fail-closed
 * — نرفض الحفظ وناخد رأي المستخدم) بدل `false` (fail-open — نقبل بصمت).
 * رفض صف شكّه فيه Circular BOM أرخص بكتير من قبول حلقة فعلية بصمت.
 */
var BOM_MAX_CYCLE_CHECK_DEPTH = 20; // كان 5 — يغطي تسلسلات تصنيع أعمق واقعياً

function _bomHasCycle(productId, componentId, depth, allBoms, allLines) {
  if (depth > BOM_MAX_CYCLE_CHECK_DEPTH) return true; // fail-closed: نرفض بدل القبول الصامت
  if (String(componentId) === String(productId)) return true;

  var compBom = allBoms.filter(function (b) {
    return (
      String(b.product_id) === String(componentId) &&
      !b.deleted_at &&
      _isTruthyFlag(b.is_active)
    );
  })[0];
  if (!compBom) return false;

  var compLines = allLines.filter(function (l) {
    return String(l.bom_id) === String(compBom.id);
  });
  return compLines.some(function (l) {
    return _bomHasCycle(
      productId,
      l.component_item_id,
      depth + 1,
      allBoms,
      allLines,
    );
  });
}

/** فرض قاعدة: نسخة نشطة (is_active=true) واحدة فقط لكل product_id + bom_type=standard */
function _deactivateOtherBOMs(productId, bomType, excludeBomId) {
  var sheet = getSheet(
    "BillOfMaterials",
    ACCOUNTING_HR_HEADERS.BillOfMaterials,
  );
  var rows = readSheet(
    "BillOfMaterials",
    ACCOUNTING_HR_HEADERS.BillOfMaterials,
  );
  var activeCol =
    ACCOUNTING_HR_HEADERS.BillOfMaterials.indexOf("is_active") + 1;
  rows.forEach(function (r) {
    if (
      String(r.product_id) === String(productId) &&
      (r.bom_type || "standard") === bomType &&
      String(r.id) !== String(excludeBomId) &&
      !r.deleted_at &&
      _isTruthyFlag(r.is_active)
    ) {
      sheet.getRange(r._row, activeCol).setValue(false);
    }
  });
}

/** يستبدل كل سطور BOM معيّن بالسطور الجديدة (Delete then Re-insert — نفس نمط JournalEntryLines) */
function _saveBOMLines(bomId, lines) {
  var linesSheet = getSheet("BOMLines", ACCOUNTING_HR_HEADERS.BOMLines);
  var allLines = readSheet("BOMLines", ACCOUNTING_HR_HEADERS.BOMLines);
  var toDelete = [];
  allLines.forEach(function (l, i) {
    if (String(l.bom_id) === String(bomId)) toDelete.push(i + 2);
  });
  toDelete.reverse().forEach(function (r) {
    linesSheet.deleteRow(r);
  });

  var bomRows = (lines || []).map(function (l, i) {
    return [
      makeId("BML"),
      bomId,
      i + 1,
      l.component_item_id,
      Number(l.quantity || 0),
      l.unit || "",
      Number(l.scrap_percent || 0),
      _isTruthyFlag(l.is_optional),
      l.notes || "",
    ];
  });
  appendRowsBatch("BOMLines", bomRows, ACCOUNTING_HR_HEADERS.BOMLines); // [PERF-BATCH-1]
}

function getBOMs(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewBOM", sessionToken);
    if (permErr) return permErr;
    var boms = readSheet(
      "BillOfMaterials",
      ACCOUNTING_HR_HEADERS.BillOfMaterials,
      { trimStrings: true },
    );
    boms = boms.filter(function (b) {
      return !b.deleted_at;
    });
    var lines = readSheet("BOMLines", ACCOUNTING_HR_HEADERS.BOMLines);
    var countMap = {};
    lines.forEach(function (l) {
      countMap[l.bom_id] = (countMap[l.bom_id] || 0) + 1;
    });
    boms.forEach(function (b) {
      b.lines_count = countMap[b.id] || 0;
    });
    return okResponse("", { data: boms });
  } catch (e) {
    return errResponse("خطأ في قراءة قوائم المكونات: " + e.message);
  }
}

function getBOMLines(callerUser, sessionToken, bomId) {
  try {
    var permErr = _checkPermission(callerUser, "viewBOM", sessionToken);
    if (permErr) return permErr;
    var lines = readSheet("BOMLines", ACCOUNTING_HR_HEADERS.BOMLines, {
      trimStrings: true,
    });
    if (bomId) {
      lines = lines.filter(function (l) {
        return String(l.bom_id) === String(bomId);
      });
    }
    lines.sort(function (a, b) {
      return Number(a.line_number || 0) - Number(b.line_number || 0);
    });
    return okResponse("", { data: lines });
  } catch (e) {
    return errResponse("خطأ في قراءة مكونات القائمة: " + e.message);
  }
}

function addBOM(data) {
  try {
    var permErr = _checkPermission(data.user, "manageBOM", data.sessionToken);
    if (permErr) return permErr;

    var err = _validateBOMHeader(data);
    if (err) return errResponse(err);
    var linesErr = _validateBOMLines(data.lines, data.product_id);
    if (linesErr) return errResponse(linesErr);

    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var product = findRow(items, "id", data.product_id);
    if (!product || product.deleted_at)
      return errResponse("الصنف المُصنَّع المحدد غير موجود");

    // [BUG-013-FIX-2026-07] قفل ذري حول مسار فحص-الدورة + تعطيل النسخ
    // الأخرى + الحفظ. يمنع نداءين متزامنين لإضافة BOM "نشِط" لنفس المنتج
    // من قراءة نفس قائمة BOMs القديمة قبل تعطيلها، والانتهاء بأكتر من
    // BOM نشِط واحد لنفس المنتج في نفس الوقت.
    var _bomLock = LockService.getScriptLock();
    try {
      _bomLock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بحفظ قائمة مكونات أخرى، حاول مرة أخرى");
    }
    var id;
    try {
      var allBoms = readSheet(
        "BillOfMaterials",
        ACCOUNTING_HR_HEADERS.BillOfMaterials,
      );
      var allLines = readSheet("BOMLines", ACCOUNTING_HR_HEADERS.BOMLines);

      for (var i = 0; i < data.lines.length; i++) {
        var l = data.lines[i];
        var comp = findRow(items, "id", l.component_item_id);
        if (!comp || comp.deleted_at)
          return errResponse("المكوّن في السطر " + (i + 1) + " غير موجود");
        if (
          _bomHasCycle(data.product_id, l.component_item_id, 1, allBoms, allLines)
        ) {
          return errResponse(
            " لا يمكن الحفظ — تم اكتشاف حلقة دائرية (Circular BOM) عبر المكوّن: " +
              (comp.name || l.component_item_id),
          );
        }
      }

      var isActive = _isTruthyFlag(data.is_active);
      var bomType = data.bom_type || "standard";

      // [DL-MIGRATE] appendRow → DataLayer.insert (لسه داخل نفس القفل الذري)
      var dlBom = Repositories.BillOfMaterials.create(
        {
          product_id: data.product_id,
          version: data.version || "v1",
          is_active: isActive,
          bom_type: bomType,
          output_qty: Number(data.output_qty || 1),
          output_unit: data.output_unit || "",
          routing_id: data.routing_id || "",
          status: data.status || "draft",
          notes: data.notes || "",
          created_by: data.user || "SYSTEM",
          updated_by: data.user || "SYSTEM",
        },
        { idPrefix: "BOM" },
      );
      if (!dlBom.success) return errResponse(dlBom.errorMessage);
      id = dlBom.data.id;

      if (isActive && bomType === "standard") {
        _deactivateOtherBOMs(data.product_id, bomType, id);
      }

      _saveBOMLines(id, data.lines);
    } finally {
      _bomLock.releaseLock();
    }

    AuditEngine.log("ADD_BOM", {
      user: data.user || "SYSTEM",
      table: "BillOfMaterials",
      record_id: id,
      details:
        "BOM جديد للصنف: " +
        data.product_id +
        " (نسخة " +
        (data.version || "v1") +
        ")"});
    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم إضافة قائمة المكونات بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateBOM(id, data) {
  try {
    var permErr = _checkPermission(data.user, "manageBOM", data.sessionToken);
    if (permErr) return permErr;

    var err = _validateBOMHeader(data);
    if (err) return errResponse(err);
    var linesErr = _validateBOMLines(data.lines, data.product_id);
    if (linesErr) return errResponse(linesErr);

    var rows = readSheet(
      "BillOfMaterials",
      ACCOUNTING_HR_HEADERS.BillOfMaterials,
    );
    var row = findRow(rows, "id", id);
    if (!row) return errResponse("قائمة المكونات غير موجودة");

    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var product = findRow(items, "id", data.product_id);
    if (!product || product.deleted_at)
      return errResponse("الصنف المُصنَّع المحدد غير موجود");

    // [BUG-013-FIX-2026-07] قفل ذري حول مسار فحص-الدورة + تعطيل النسخ
    // الأخرى + الحفظ — نفس نمط addBOM. يمنع تعديلين متزامنين على BOMs
    // لنفس المنتج من إنتاج أكتر من BOM نشِط واحد في نفس الوقت.
    var _bomLock = LockService.getScriptLock();
    try {
      _bomLock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بحفظ قائمة مكونات أخرى، حاول مرة أخرى");
    }
    try {
      var allBoms = readSheet(
        "BillOfMaterials",
        ACCOUNTING_HR_HEADERS.BillOfMaterials,
      );
      var allLines = readSheet("BOMLines", ACCOUNTING_HR_HEADERS.BOMLines);

      for (var i = 0; i < data.lines.length; i++) {
        var l = data.lines[i];
        var comp = findRow(items, "id", l.component_item_id);
        if (!comp || comp.deleted_at)
          return errResponse("المكوّن في السطر " + (i + 1) + " غير موجود");
        // تجاهل BOM الحالي نفسه أثناء فحص الدورة (بيانه لسه القديمة في allBoms/allLines وقت الفحص)
        if (
          _bomHasCycle(data.product_id, l.component_item_id, 1, allBoms, allLines)
        ) {
          return errResponse(
            " لا يمكن الحفظ — تم اكتشاف حلقة دائرية (Circular BOM) عبر المكوّن: " +
              (comp.name || l.component_item_id),
          );
        }
      }

      var isActive = _isTruthyFlag(data.is_active);
      var bomType = data.bom_type || row.bom_type || "standard";

      // [DL-MIGRATE] getRange/setValues → DataLayer.update (تحديث جزئي، لسه داخل نفس القفل)
      var patch = {
        product_id: data.product_id,
        is_active: isActive,
        bom_type: bomType,
        output_qty: Number(data.output_qty || 1),
        status: data.status || row.status || "draft",
        updated_by: data.user || "SYSTEM",
      };
      if (data.version != null) patch.version = data.version;
      if (data.output_unit != null) patch.output_unit = data.output_unit;
      if (data.routing_id != null) patch.routing_id = data.routing_id;
      if (data.notes != null) patch.notes = data.notes;

      var dlBom = Repositories.BillOfMaterials.update(id, patch);
      if (!dlBom.success)
        return errResponse(
          dlBom.errorCode === "NOT_FOUND"
            ? "قائمة المكونات غير موجودة"
            : dlBom.errorMessage,
        );

      if (isActive && bomType === "standard") {
        _deactivateOtherBOMs(data.product_id, bomType, id);
      }

      _saveBOMLines(id, data.lines);
    } finally {
      _bomLock.releaseLock();
    }

    AuditEngine.log("UPDATE_BOM", {
      user: data.user || "SYSTEM",
      table: "BillOfMaterials",
      record_id: id,
      details: "تعديل BOM للصنف: " + data.product_id});
    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم تعديل قائمة المكونات بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteBOM(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "manageBOM", sessionToken);
    if (permErr) return permErr;

    // منع الحذف لو مرتبط بأمر تصنيع غير مُغلق (القسم 6.1 من التقرير)
    // [BRE-ROLLOUT] عبر BusinessRulesEngine.validateBeforeDelete('bom', ...)
    var _breCheck = BusinessRulesEngine.validateBeforeDelete("bom", { id: id });
    if (!_breCheck.success) return errResponse(_breCheck.message);

    // [DL-MIGRATE] getRange/setValue → DataLayer.remove (Soft Delete)
    var dl = Repositories.BillOfMaterials.remove(id, {
      deletedBy: user || "SYSTEM",
    });
    if (!dl.success)
      return errResponse(
        dl.errorCode === "NOT_FOUND" ? "قائمة المكونات غير موجودة" : dl.errorMessage,
      );

    AuditEngine.log("DELETE_BOM", {
      user: user || "SYSTEM",
      table: "BillOfMaterials",
      record_id: id,
      details: "حذف قائمة مكونات (Soft Delete)"});
    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم حذف قائمة المكونات بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// §MFG-ROUTING  مسارات التصنيع — Routing + Routing Operations
// راجع القسم 4.3/4.4/6.1 من التقرير الهندسي للقواعد الكاملة
// ═══════════════════════════════════════════════════════════════════════

var MFG_LABOR_RATE_TYPES = ["piece_rate", "hourly"];

function _validateRoutingHeader(data) {
  if (!data || !String(data.product_id || "").trim())
    return "الصنف المُصنَّع (Product) مطلوب";
  return null;
}

function _validateRoutingOperations(ops) {
  if (!ops || !ops.length) return "يجب إضافة خطوة تشغيل واحدة على الأقل";
  for (var i = 0; i < ops.length; i++) {
    var o = ops[i];
    if (!o || !String(o.operation_name || "").trim())
      return "اسم العملية مطلوب في الخطوة " + (i + 1);
    if (!o || !String(o.work_center_id || "").trim())
      return "مركز العمل مطلوب في الخطوة " + (i + 1);
    if (
      o.standard_time_minutes != null &&
      o.standard_time_minutes !== "" &&
      Number(o.standard_time_minutes) < 0
    )
      return "الزمن المعياري لا يمكن أن يكون سالباً في الخطوة " + (i + 1);
    if (
      o.labor_rate_type &&
      MFG_LABOR_RATE_TYPES.indexOf(o.labor_rate_type) === -1
    )
      return "نوع احتساب الأجر غير صحيح في الخطوة " + (i + 1);
  }
  return null;
}

/** فرض قاعدة: نسخة نشطة (is_active=true) واحدة فقط لكل product_id (نفس قاعدة BOM 6.1) */
function _deactivateOtherRoutings(productId, excludeRoutingId) {
  var sheet = getSheet("Routings", ACCOUNTING_HR_HEADERS.Routings);
  var rows = readSheet("Routings", ACCOUNTING_HR_HEADERS.Routings);
  var activeCol = ACCOUNTING_HR_HEADERS.Routings.indexOf("is_active") + 1;
  rows.forEach(function (r) {
    if (
      String(r.product_id) === String(productId) &&
      String(r.id) !== String(excludeRoutingId) &&
      !r.deleted_at &&
      _isTruthyFlag(r.is_active)
    ) {
      sheet.getRange(r._row, activeCol).setValue(false);
    }
  });
}

/** يستبدل كل خطوات Routing معيّن بالخطوات الجديدة (Delete then Re-insert — نفس نمط _saveBOMLines) */
function _saveRoutingOperations(routingId, ops) {
  var opsSheet = getSheet(
    "RoutingOperations",
    ACCOUNTING_HR_HEADERS.RoutingOperations,
  );
  var allOps = readSheet(
    "RoutingOperations",
    ACCOUNTING_HR_HEADERS.RoutingOperations,
  );
  var toDelete = [];
  allOps.forEach(function (o, i) {
    if (String(o.routing_id) === String(routingId)) toDelete.push(i + 2);
  });
  toDelete.reverse().forEach(function (r) {
    opsSheet.deleteRow(r);
  });

  var opRows = (ops || []).map(function (o, i) {
    return [
      makeId("ROP"),
      routingId,
      (i + 1) * 10, // ترتيب تلقائي بمضاعفات 10 (10, 20, 30...) حسب ترتيب الصفوف في الفرونت إند
      o.operation_name,
      o.work_center_id,
      Number(o.standard_time_minutes || 0),
      o.labor_rate_type || "piece_rate",
      o.production_stage_id || "",
      o.machine_id || "",
      _isTruthyFlag(o.is_subcontract_operation),
      o.notes || "",
    ];
  });
  appendRowsBatch(
    "RoutingOperations",
    opRows,
    ACCOUNTING_HR_HEADERS.RoutingOperations,
  ); // [PERF-BATCH-1]
}

function getRoutings(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewRouting", sessionToken);
    if (permErr) return permErr;
    var routings = readSheet("Routings", ACCOUNTING_HR_HEADERS.Routings, {
      trimStrings: true,
    });
    routings = routings.filter(function (r) {
      return !r.deleted_at;
    });
    var ops = readSheet(
      "RoutingOperations",
      ACCOUNTING_HR_HEADERS.RoutingOperations,
    );
    var countMap = {};
    ops.forEach(function (o) {
      countMap[o.routing_id] = (countMap[o.routing_id] || 0) + 1;
    });
    routings.forEach(function (r) {
      r.operations_count = countMap[r.id] || 0;
    });
    return okResponse("", { data: routings });
  } catch (e) {
    return errResponse("خطأ في قراءة مسارات التصنيع: " + e.message);
  }
}

function getRoutingOperations(callerUser, sessionToken, routingId) {
  try {
    var permErr = _checkPermission(callerUser, "viewRouting", sessionToken);
    if (permErr) return permErr;
    var ops = readSheet(
      "RoutingOperations",
      ACCOUNTING_HR_HEADERS.RoutingOperations,
      { trimStrings: true },
    );
    if (routingId) {
      ops = ops.filter(function (o) {
        return String(o.routing_id) === String(routingId);
      });
    }
    ops.sort(function (a, b) {
      return Number(a.sequence || 0) - Number(b.sequence || 0);
    });
    return okResponse("", { data: ops });
  } catch (e) {
    return errResponse("خطأ في قراءة خطوات المسار: " + e.message);
  }
}

function addRouting(data) {
  try {
    var permErr = _checkPermission(
      data.user,
      "manageRouting",
      data.sessionToken,
    );
    if (permErr) return permErr;

    var err = _validateRoutingHeader(data);
    if (err) return errResponse(err);
    var opsErr = _validateRoutingOperations(data.operations);
    if (opsErr) return errResponse(opsErr);

    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var product = findRow(items, "id", data.product_id);
    if (!product || product.deleted_at)
      return errResponse("الصنف المُصنَّع المحدد غير موجود");

    if (data.bom_id) {
      var boms = readSheet(
        "BillOfMaterials",
        ACCOUNTING_HR_HEADERS.BillOfMaterials,
      );
      var bom = findRow(boms, "id", data.bom_id);
      if (!bom || bom.deleted_at)
        return errResponse("قائمة المكونات (BOM) المرتبطة غير موجودة");
      if (String(bom.product_id) !== String(data.product_id))
        return errResponse(
          "قائمة المكونات المرتبطة لا تخص نفس الصنف المُصنَّع",
        );
    }

    var workCenters = readSheet(
      "WorkCenters",
      ACCOUNTING_HR_HEADERS.WorkCenters,
    );
    var machines = readSheet("Machines", ACCOUNTING_HR_HEADERS.Machines);
    var stages = readSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
    );

    for (var i = 0; i < data.operations.length; i++) {
      var o = data.operations[i];
      var wc = findRow(workCenters, "id", o.work_center_id);
      if (!wc || wc.deleted_at)
        return errResponse("مركز العمل في الخطوة " + (i + 1) + " غير موجود");
      if (o.machine_id) {
        var mch = findRow(machines, "id", o.machine_id);
        if (!mch || mch.deleted_at)
          return errResponse("الآلة في الخطوة " + (i + 1) + " غير موجودة");
        if (
          mch.work_center_id &&
          String(mch.work_center_id) !== String(o.work_center_id)
        )
          return errResponse(
            "الآلة المختارة في الخطوة " +
              (i + 1) +
              " لا تتبع مركز العمل المحدد لنفس الخطوة",
          );
      }
      if (o.production_stage_id) {
        var stage = findRow(stages, "id", o.production_stage_id);
        if (!stage || stage.deleted_at)
          return errResponse(
            "مرحلة الإنتاج (Production Stage) في الخطوة " +
              (i + 1) +
              " غير موجودة",
          );
      }
    }

    var isActive = _isTruthyFlag(data.is_active);

    // [DL-MIGRATE] appendRow → DataLayer.insert
    var dlRtg = Repositories.Routings.create(
      {
        product_id: data.product_id,
        bom_id: data.bom_id || "",
        name: data.name || "",
        version: data.version || "v1",
        is_active: isActive,
        status: data.status || "draft",
        notes: data.notes || "",
        created_by: data.user || "SYSTEM",
      },
      { idPrefix: "RTG" },
    );
    if (!dlRtg.success) return errResponse(dlRtg.errorMessage);
    var id = dlRtg.data.id;

    if (isActive) {
      _deactivateOtherRoutings(data.product_id, id);
    }

    _saveRoutingOperations(id, data.operations);

    AuditEngine.log("ADD_ROUTING", {
      user: data.user || "SYSTEM",
      table: "Routings",
      record_id: id,
      details:
        "مسار تصنيع جديد للصنف: " +
        data.product_id +
        " (نسخة " +
        (data.version || "v1") +
        ")"});
    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم إضافة مسار التصنيع بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateRouting(id, data) {
  try {
    var permErr = _checkPermission(
      data.user,
      "manageRouting",
      data.sessionToken,
    );
    if (permErr) return permErr;

    var err = _validateRoutingHeader(data);
    if (err) return errResponse(err);
    var opsErr = _validateRoutingOperations(data.operations);
    if (opsErr) return errResponse(opsErr);

    var rows = readSheet("Routings", ACCOUNTING_HR_HEADERS.Routings);
    var row = findRow(rows, "id", id);
    if (!row) return errResponse("مسار التصنيع غير موجود");

    if (data.bom_id) {
      var boms = readSheet(
        "BillOfMaterials",
        ACCOUNTING_HR_HEADERS.BillOfMaterials,
      );
      var bom = findRow(boms, "id", data.bom_id);
      if (!bom || bom.deleted_at)
        return errResponse("قائمة المكونات (BOM) المرتبطة غير موجودة");
      if (String(bom.product_id) !== String(row.product_id))
        return errResponse(
          "قائمة المكونات المرتبطة لا تخص نفس الصنف المُصنَّع",
        );
    }

    var workCenters = readSheet(
      "WorkCenters",
      ACCOUNTING_HR_HEADERS.WorkCenters,
    );
    var machines = readSheet("Machines", ACCOUNTING_HR_HEADERS.Machines);
    var stages = readSheet(
      "ProductionStages",
      ACCOUNTING_HR_HEADERS.ProductionStages,
    );

    for (var i = 0; i < data.operations.length; i++) {
      var o = data.operations[i];
      var wc = findRow(workCenters, "id", o.work_center_id);
      if (!wc || wc.deleted_at)
        return errResponse("مركز العمل في الخطوة " + (i + 1) + " غير موجود");
      if (o.machine_id) {
        var mch = findRow(machines, "id", o.machine_id);
        if (!mch || mch.deleted_at)
          return errResponse("الآلة في الخطوة " + (i + 1) + " غير موجودة");
        if (
          mch.work_center_id &&
          String(mch.work_center_id) !== String(o.work_center_id)
        )
          return errResponse(
            "الآلة المختارة في الخطوة " +
              (i + 1) +
              " لا تتبع مركز العمل المحدد لنفس الخطوة",
          );
      }
      if (o.production_stage_id) {
        var stage = findRow(stages, "id", o.production_stage_id);
        if (!stage || stage.deleted_at)
          return errResponse(
            "مرحلة الإنتاج (Production Stage) في الخطوة " +
              (i + 1) +
              " غير موجودة",
          );
      }
    }

    var isActive = _isTruthyFlag(data.is_active);

    // [DL-MIGRATE] getRange/setValues → DataLayer.update (تحديث جزئي).
    // product_id غير قابل للتعديل بعد الإنشاء (نفس منطق BOM) — لا يُرسَل في patch.
    var patch = {
      is_active: isActive,
      status: data.status || row.status || "draft",
      version: data.version || row.version || "v1",
    };
    if (data.bom_id != null) patch.bom_id = data.bom_id;
    if (data.name != null) patch.name = data.name;
    if (data.notes != null) patch.notes = data.notes;

    var dlRtg = Repositories.Routings.update(id, patch);
    if (!dlRtg.success)
      return errResponse(
        dlRtg.errorCode === "NOT_FOUND" ? "مسار التصنيع غير موجود" : dlRtg.errorMessage,
      );

    if (isActive) {
      _deactivateOtherRoutings(row.product_id, id);
    }

    _saveRoutingOperations(id, data.operations);

    AuditEngine.log("UPDATE_ROUTING", {
      user: data.user || "SYSTEM",
      table: "Routings",
      record_id: id,
      details: "تعديل مسار تصنيع للصنف: " + row.product_id});
    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم تعديل مسار التصنيع بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteRouting(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "manageRouting", sessionToken);
    if (permErr) return permErr;

    // منع الحذف لو مرتبط بأمر تصنيع غير مُغلق (نفس قاعدة BOM في القسم 6.1)
    // [BRE-ROLLOUT] عبر BusinessRulesEngine.validateBeforeDelete('routing', ...)
    var _breCheck = BusinessRulesEngine.validateBeforeDelete("routing", {
      id: id,
    });
    if (!_breCheck.success) return errResponse(_breCheck.message);

    // [DL-MIGRATE] getRange/setValue → DataLayer.remove (Soft Delete)
    var dl = Repositories.Routings.remove(id, { deletedBy: user || "SYSTEM" });
    if (!dl.success)
      return errResponse(
        dl.errorCode === "NOT_FOUND" ? "مسار التصنيع غير موجود" : dl.errorMessage,
      );

    AuditEngine.log("DELETE_ROUTING", {
      user: user || "SYSTEM",
      table: "Routings",
      record_id: id,
      details: "حذف مسار تصنيع (Soft Delete)"});
    _invalidateServerCacheProduction(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم حذف مسار التصنيع بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §MFG-IMG  رفع صور الإنتاج (Dispatch / Factory Return / FG Receive)
// [FIX] كانت 05_JS_Production.html تستدعي uploadImageToDrive() وهي
// دالة غير موجودة أصلاً في الباك اند — تمت إضافتها هنا.
// [DOC-ENGINE] بقت بتمرّ عبر DocumentEngine.uploadProductionFile بدل
// FileEngine مباشرة — نفس التوقيع والقيمة الراجعة بالظبط (توافقية خلفية
// كاملة مع 05_JS_Production.html) لكن دلوقتي الملف بيترفع تحت هيكل ثابت
// (المستندات/الإنتاج/{صرف للمصنع|مرتجع من المصنع|استلام إنتاج تام})
// وبيتسجل في جدول Files الموحّد بدل ما يضيع كمجرد رابط.
// يُستدعى من: 05_JS_Production.html (رفع صور الصرف / المرتجع من المصنع / استلام الإنتاج التام)
// ─────────────────────────────────────────────────────────────
// [PHASE-3] إضافة باراميتر رابع اختياري compressOpts — التوقيع القديم
// بثلاث باراميترات فضل شغال بدون أي تغيير (JS بيتعامل مع الباراميتر
// الناقص كـ undefined تلقائيًا، و DocumentEngine.uploadProductionFile
// بيتجاهل options.compress لو null/undefined — نفس السلوك القديم بالظبط).
function uploadImageToDrive(base64Data, fileName, context, compressOpts) {
  if (!base64Data || !fileName) {
    throw new Error("بيانات الصورة غير مكتملة");
  }

  var result = DocumentEngine.uploadProductionFile(base64Data, fileName, null, {
    context: context,
    compress: compressOpts || null,
  });

  if (!result.success) {
    throw new Error(result.error);
  }

  return result.thumbUrl;
}
