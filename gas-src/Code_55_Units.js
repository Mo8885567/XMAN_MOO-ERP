// ═══════════════════════════════════════════════════════════════════
// Code_55_Units.js — وحدات القياس (Units) — [UNITS-2026-08-06]
// ═══════════════════════════════════════════════════════════════════
// كيان مرجعي حقيقي بديل عن القائمة الثابتة القديمة اللي كانت مكتوبة في
// كود الواجهة ["قطعة","كيلو","متر","لتر","علبة","طرد"] (03_JS_Dashboard_
// Items.html — حقل i-unit في فورم الصنف). بُني بالحرف على نفس نمط
// Sizes CRUD (Code_16_Inventory.js: getSizes/addSize/updateSize/
// deleteSize/_readSizesRaw) — كيان مسطّح (بدون شجرة/مجموعات) مناسب
// للوحدات لأنها مفيهاش تدرّج.
//
// الشيت: "Units" — أعمدة HEADERS.Units (راجع Code_12_Core.js):
//   [id, name, symbol, notes, created_at]
// التسجيل في DATA_REGISTRY (Code_53_DataRegistryEngine.js) بيخلي
// "units" يوصل تلقائيًا في حزمة getAllData (APP.data.units) من غير أي
// تعديل إضافي في محرك التحميل.
//
// الصلاحيات: addUnit / updateUnit / deleteUnit (Code_18_Permissions.js).
// ─────────────────────────────────────────────────────────────

function _readUnitsRaw() {
  return CacheEngine.getOrCompute(
    CacheEngine.NAMESPACE.REFERENCE,
    "units",
    function () {
      var r = DataLayer.getAll("Units", { trimStrings: true });
      return r.success ? r.data : [];
    },
    CacheEngine.POLICY.REFERENCE,
  );
}

function getUnits() {
  try {
    return { success: true, data: cleanArr(_readUnitsRaw()) };
  } catch (e) {
    return { success: false, data: [], message: e.message };
  }
}

function addUnit(unit) {
  try {
    var permErr = _checkPermission(unit.user, "addUnit", unit.sessionToken);
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(unit.name))
      return errResponse("اسم الوحدة مطلوب");
    var existing = _readUnitsRaw();
    if (ValidationEngine.isDuplicate(existing, "name", unit.name))
      return errResponse("اسم الوحدة موجود بالفعل");
    var insertRes = DataLayer.insert(
      "Units",
      {
        name: String(unit.name).trim(),
        symbol: String(unit.symbol || "").trim(),
        notes: String(unit.notes || "").trim(),
      },
      { idPrefix: "UNT" },
    );
    if (!insertRes.success)
      return errResponse(insertRes.errorMessage || "خطأ في إضافة الوحدة");
    var id = insertRes.data.id;
    AuditEngine.log("ADD_UNIT", {
      user: unit.user || "SYSTEM",
      table: "Units",
      record_id: id,
      details: "إضافة وحدة: " + unit.name});
    _invalidateServerCacheUnits(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "units");
    return okResponse("تم إضافة الوحدة بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateUnit(unit) {
  try {
    var permErr = _checkPermission(unit.user, "updateUnit", unit.sessionToken);
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(unit.id))
      return errResponse("معرف الوحدة مطلوب");
    if (!ValidationEngine.isRequired(unit.name))
      return errResponse("اسم الوحدة مطلوب");
    var existing = _readUnitsRaw();
    var row = findRow(existing, "id", unit.id);
    if (!row) return errResponse("الوحدة غير موجودة");
    if (
      ValidationEngine.isDuplicate(existing, "name", unit.name, {
        excludeId: unit.id,
      })
    )
      return errResponse("اسم الوحدة مستخدم بالفعل");
    var updateRes = DataLayer.update("Units", unit.id, {
      name: String(unit.name).trim(),
      symbol: String(unit.symbol || "").trim(),
      notes: String(unit.notes || "").trim(),
    });
    if (!updateRes.success)
      return errResponse(updateRes.errorMessage || "خطأ في تعديل الوحدة");
    AuditEngine.log("UPDATE_UNIT", {
      user: unit.user || "SYSTEM",
      table: "Units",
      record_id: unit.id,
      details: "تعديل وحدة: " + unit.name});
    _invalidateServerCacheUnits(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "units");
    return okResponse("تم تعديل الوحدة");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteUnit(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "deleteUnit", sessionToken);
    if (permErr) return permErr;
    var row = findRow(_readUnitsRaw(), "id", id);
    if (!row) return errResponse("الوحدة غير موجودة");
    AuditEngine.log("DELETE_UNIT", {
      user: user || "SYSTEM",
      table: "Units",
      record_id: id,
      details: "حذف وحدة ID: " + id});
    // Units مفيهاش deleted_at → حذف فعلي (زي Sizes)
    var deleteRes = DataLayer.delete("Units", id);
    if (!deleteRes.success)
      return errResponse(deleteRes.errorMessage || "خطأ في حذف الوحدة");
    _invalidateServerCacheUnits(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "units");
    return okResponse("تم حذف الوحدة");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}
