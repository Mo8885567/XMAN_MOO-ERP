// ════════════════════════════════════════════════════════════════
// Code_43_CostCenters.gs — [COST-CENTER-MODULE] مراكز التكلفة كبُعد فعلي
// في القيود اليومية (JournalEntryLines.cost_center_id).
//
// راجع: تقرير مراجعة الربط المحاسبي — موديول العملاء/الموردين، البند 4.2
// ("عدم وجود مراكز تكلفة كبُعد في القيود"). هذا الملف يضيف الكيان المستقل
// (CostCenters) + دوال CRUD + دالة حل (resolve) تُستخدم من محرك القيود
// (Code_04) ومن دوال الترحيل التلقائي (Code_20 وغيرها) دون كسر أي سلوك
// قائم — الحقل اختياري افتراضيًا، ويُصبح إلزاميًا فقط لو فعّله المستخدم
// صراحة عبر إعداد الترحيل POSTING_CONFIG_KEYS.cost_center_required
// (راجع Code_19_PostingConfig.js).
//
// نطاق هذه الجلسة: الكيان + CRUD + الربط بمحرك القيود والترحيل التلقائي
// لفواتير البيع/الشراء. لم يُعدَّل تقرير الأستاذ العام/ميزان المراجعة هنا
// إلا بإضافة فلتر/تجميع اختياري بحسب مركز التكلفة (راجع Code_05).
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §CC-01  مراكز التكلفة — CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// ── getNextCostCenterCode ────────────────────────────────────────────────────
// [AUTO-CODE] معاينة الكود التسلسلي التالي من الواجهة قبل الحفظ.
function getNextCostCenterCode() {
  return okResponse("", {
    data: _getNextSequentialCode("costcenter", function () {
      return readSheet(
        "CostCenters",
        ACCOUNTING_HR_HEADERS.CostCenters,
      ).map(function (r) {
        return r.code;
      });
    }),
  });
}

function getCostCenters(callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewCostCenters");
    var rows = readSheet("CostCenters", ACCOUNTING_HR_HEADERS.CostCenters, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return r.is_active !== "FALSE" && r.is_active !== false;
    });
    // ترتيب هرمي بسيط: المراكز الرئيسية أولاً ثم الفرعية
    rows.sort(function (a, b) {
      return String(a.code || "").localeCompare(String(b.code || ""));
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب مراكز التكلفة: " + e.message);
  }
}

function addCostCenter(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addCostCenter",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!ValidationEngine.isRequired(data.name))
      return errResponse("اسم مركز التكلفة مطلوب");
    // [AUTO-CODE] كود تسلسلي تلقائي (1، 2، 3...) لو وصل فاضي — بدل الإلزام
    // بإدخاله يدويًا.
    if (!data.code || !String(data.code).trim()) {
      data.code = _getNextSequentialCode("costcenter", function () {
        return readSheet(
          "CostCenters",
          ACCOUNTING_HR_HEADERS.CostCenters,
        ).map(function (r) {
          return r.code;
        });
      });
    }

    var existing = readSheet("CostCenters", ACCOUNTING_HR_HEADERS.CostCenters, {
      trimStrings: true,
    });
    var activeExisting = existing.filter(function (r) {
      return r.is_active !== "FALSE" && r.is_active !== false;
    });
    if (ValidationEngine.isDuplicate(activeExisting, "code", data.code))
      return errResponse("يوجد مركز تكلفة بنفس الكود مسبقاً");

    if (
      data.parent_id &&
      !ValidationEngine.recordExists(existing, "id", data.parent_id)
    )
      return errResponse("مركز التكلفة الأب غير موجود");

    var id = makeId("CC");
    var now = new Date().toISOString();
    // [ARCH-AUDIT-P3-18] appendRow خام -> DataLayerEngine.insert
    DataLayerEngine.insert(
      "CostCenters",
      {
        id: id,
        code: String(data.code).trim(),
        name: String(data.name).trim(),
        name_en: data.name_en || "",
        parent_id: data.parent_id || "",
        is_active: data.is_active === false ? false : true,
        notes: data.notes || "",
        created_at: now,
        created_by: data.callerUser,
        updated_at: now,
        updated_by: data.callerUser,
      },
      { headers: ACCOUNTING_HR_HEADERS.CostCenters },
    );

    AuditEngine.log("ADD", {
      user: data.callerUser,
      table: "CostCenters",
      record_id: id,
      details: "إضافة مركز تكلفة: " + data.name,
      newValue: data});

    return okResponse("تم إضافة مركز التكلفة بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة مركز التكلفة: " + e.message);
  }
}

function updateCostCenter(id, data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateCostCenter",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet("CostCenters", ACCOUNTING_HR_HEADERS.CostCenters);
    var rows = readSheet("CostCenters", ACCOUNTING_HR_HEADERS.CostCenters, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("مركز التكلفة غير موجود");
    var before = rows[idx];

    if (data.parent_id === id)
      return errResponse("لا يمكن أن يكون مركز التكلفة أباً لنفسه");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var updates = {};
    ["code", "name", "name_en", "parent_id", "notes"].forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    if (data.is_active !== undefined) updates.is_active = !!data.is_active;
    updates.updated_at = new Date().toISOString();
    updates.updated_by = data.callerUser;

    _applyRowUpdates(sheet, rowNum, headers, updates);

    AuditEngine.log("UPDATE", {
      user: data.callerUser,
      table: "CostCenters",
      record_id: id,
      details: "تعديل مركز تكلفة: " + (updates.name || before.name),
      oldValue: _diffObjects(before, updates).old,
      newValue: _diffObjects(before, updates).new});

    return okResponse("تم تحديث مركز التكلفة بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث مركز التكلفة: " + e.message);
  }
}

function deleteCostCenter(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "deleteCostCenter",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet("CostCenters", ACCOUNTING_HR_HEADERS.CostCenters, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("مركز التكلفة غير موجود");

    // [BRE-UNIFY-1] فحص المراكز الفرعية الآن مركزي عبر BusinessRulesEngine
    var _bre = BusinessRulesEngine.validateBeforeDelete("costCenter", {
      id: id,
    });
    if (!_bre.success) return errResponse(_bre.message);
    var usedInLines = _bre.details && _bre.details.usedInLines;

    var sheet = getSheet("CostCenters", ACCOUNTING_HR_HEADERS.CostCenters);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var activeCol = headers.indexOf("is_active");
    if (activeCol !== -1) sheet.getRange(rowNum, activeCol + 1).setValue(false);

    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "CostCenters",
      record_id: id,
      details:
        "تعطيل مركز تكلفة: " +
        rows[idx].name +
        (usedInLines ? " (مستخدم في قيود قائمة — بقيت كما هي)" : "")});

    return okResponse("تم تعطيل مركز التكلفة بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف مركز التكلفة: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §CC-02  دالة حل موحّدة — تُستخدم من محرك القيود (Code_04) ومحركات
// الترحيل التلقائي (Code_20 وغيرها) للتحقق من صلاحية cost_center_id قبل
// الحفظ، بنفس أسلوب _isUsablePostingAccount في Code_19.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * _isCostCenterRequired()
 * يقرأ إعداد "مركز التكلفة إلزامي على كل سطر قيد" من نفس شيت Settings
 * العام (نفس نمط require_notes_on_tx في Code_08) — افتراضيًا false، أي
 * أن تفعيل الميزة إضافي بالكامل (Opt-in) ولا يُغيّر أي سلوك قائم تلقائياً.
 */
function _isCostCenterRequired() {
  try {
    var settings = _getCompanySettingsRaw();
    return (
      settings.cost_center_required === true ||
      settings.cost_center_required === "true"
    );
  } catch (e) {
    return false; // لا نمنع أي قيد لو فشل فحص الإعداد نفسه
  }
}

/**
 * _applyCostCenterToLines(lines, defaultCostCenterId)
 * تُستخدم من دوال الترحيل التلقائي (auto-journal) لتمرير مركز تكلفة
 * الفاتورة/المستند المصدر إلى كل سطور القيد الناتجة عنه، دون الكتابة فوق
 * أي cost_center_id مُحدَّد مسبقاً على سطر بعينه (لو احتاج سطر معيّن مركز
 * تكلفة مختلف عن باقي القيد مستقبلاً). لا تأثير إطلاقاً لو
 * defaultCostCenterId فارغ — القيد يُنشأ تمامًا كما كان قبل هذه الميزة.
 * @returns {Array} نفس مصفوفة lines بعد التعديل (in place أيضًا)
 */
function _applyCostCenterToLines(lines, defaultCostCenterId) {
  if (!defaultCostCenterId || !lines || !lines.length) return lines;
  lines.forEach(function (line) {
    if (!line.cost_center_id) line.cost_center_id = defaultCostCenterId;
  });
  return lines;
}

/**
 * _isUsableCostCenter(costCenterId, costCentersRows?)
 * @returns {object|null} سجل مركز التكلفة لو صالحاً (موجود ونشط)، أو null
 */
function _isUsableCostCenter(costCenterId, costCentersRows) {
  if (!costCenterId) return null;
  var rows =
    costCentersRows ||
    readSheet("CostCenters", ACCOUNTING_HR_HEADERS.CostCenters, {
      trimStrings: true,
    });
  var found = rows.find(function (c) {
    return c.id === costCenterId;
  });
  if (!found) return null;
  if (found.is_active === "FALSE" || found.is_active === false) return null;
  return found;
}
