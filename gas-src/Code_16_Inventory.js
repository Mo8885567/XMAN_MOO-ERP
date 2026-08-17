// ════════════════════════════════════════════════════════════════
// Code_Inventory.gs — جزء من MOO.ERP Code.js (مقسَّم تلقائيًا في 2026-06-30)
// تم الفصل من Code.js الأصلي مع الحفاظ الكامل على ترتيب وسلوك الكود.
// ════════════════════════════════════════════════════════════════

// [PERF-FIX] يحوّل رقم عمود (1-based) لحرف/حروف A1 notation (1→A, 27→AA).
// مستخدمة في تجميع كتابات متفرقة عبر getRangeList بدل نداء getRange منفصل
// لكل صف داخل loop (كل getRange/setValue هو نداء API له تكلفة زمن استجابة
// ثابتة تقريبًا، فتجميعها في نداء واحد بيقلل الزمن بشكل كبير مع كثرة الصفوف).
function _colToA1Letter(col) {
  var letter = "";
  while (col > 0) {
    var rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// ┄┄┄ [مصدر: Code.js سطور 2072-2697] Color Utilities + Groups + Warehouses + Colors + Sizes CRUD ┄┄┄
// §07  Color Utilities  (Backend)
//
// NOTE: CSS_COLOR_MAP_MASTER (§21) هو المرجع الرسمي الوحيد
//       للألوان. هذه الدوال تعتمد عليه.
// ─────────────────────────────────────────────────────────────

/** COLOR_MAP_AR — نسخة مختصرة للاستخدام المحلي داخل الشيت */
var COLOR_MAP_AR = {
  أحمر: "RED",
  احمر: "RED",
  أسود: "BLK",
  اسود: "BLK",
  أبيض: "WHT",
  ابيض: "WHT",
  أزرق: "BLU",
  ازرق: "BLU",
  أخضر: "GRN",
  اخضر: "GRN",
  أصفر: "YEL",
  اصفر: "YEL",
  بني: "BRN",
  بنى: "BRN",
  بيج: "BEI",
  رمادي: "GRY",
  رمادى: "GRY",
  كحلي: "NVY",
  كحلى: "NVY",
  زيتي: "OLV",
  زيتى: "OLV",
  بنفسجي: "PRP",
  بنفسجى: "PRP",
  وردي: "PNK",
  ورده: "PNK",
  وردى: "PNK",
  برتقالي: "ORG",
  برتقالى: "ORG",
  ذهبي: "GLD",
  ذهبى: "GLD",
  فضي: "SLV",
  فضى: "SLV",
  تركوازي: "TRQ",
  تركواز: "TRQ",
  نبيتي: "WNE",
  نبيذي: "WNE",
  كريمي: "CRM",
  كريمى: "CRM",
  سكري: "SAL",
  سلموني: "SAL",
  تيل: "TEL",
  خمري: "MAR",
  خمرى: "MAR",
  نيلي: "IND",
  نيلى: "IND",
  فيروزي: "CYN",
  فيروزى: "CYN",
};

function _resolveColorCodeBackend(name) {
  var trimmed = String(name || "").trim();
  return (
    COLOR_MAP_AR[trimmed] ||
    trimmed.replace(/\s+/g, "").substring(0, 3).toUpperCase()
  );
}

/**
 * توحيد اسم اللون في الـ backend: يشيل الهمزات والتشكيل ويعمل lowercase
 * يحل مشكلة "أسود" != "اسود" عند البحث في Stock
 */
function _normalizeColorName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[\u0623\u0625\u0622]/g, "\u0627") // أ إ آ → ا
    .replace(/\u0629/g, "\u0647") // ة → ه
    .replace(/\u0649/g, "\u064A") // ى → ي
    .replace(/[\u064B-\u065F]/g, ""); // حذف التشكيل
}

/**
 * يحوّل colors_json من أي صيغة قديمة أو جديدة لمصفوفة موحّدة
 * الصيغة القديمة: ["أحمر", "أزرق"]
 * الصيغة الجديدة: [{"name":"أحمر","code":"RED","hex":"#ef4444","image":"https://..."}]
 * النتيجة دايماً: [{"name":"...","code":"...","hex":"...","image":"..."}]
 */
function _normalizeColors(colorsJson) {
  if (!colorsJson) return [];
  try {
    var arr =
      typeof colorsJson === "string" ? JSON.parse(colorsJson) : colorsJson;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(Boolean)
      .map(function (c) {
        if (typeof c === "object" && c !== null && c.name) {
          return {
            name: String(c.name).trim(),
            code: String(c.code || "").trim(),
            hex: String(c.hex || "").trim(),
            image: String(c.image || "").trim(),
          };
        }
        // صيغة قديمة: string فقط
        return { name: String(c).trim(), code: "", hex: "", image: "" };
      })
      .filter(function (c) {
        return c.name;
      });
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// §08  Groups CRUD  (+ GROUP-HIERARCHY P1: هيكل شجري لعدد غير محدود من المستويات)
//
// حقول الشجرة: parent_id · level · full_path · sort_order · has_children
// كلها تُحسب وتُحدَّث تلقائيًا داخل هذا القسم — الفرونت إند لا يرسلها
// مباشرة (عدا parent_id اللي بيختاره المستخدم).
// ─────────────────────────────────────────────────────────────

const GROUPS_COL_COUNT = HEADERS.Groups.length;

/**
 * _groupRowArray — يبني مصفوفة الصف الكاملة لشيت Groups بترتيب HEADERS.Groups
 * (بيضمن إننا دايمًا نكتب كل الأعمدة حتى لو اتزود عمود جديد مستقبلًا)
 */
function _groupRowArray(obj) {
  return HEADERS.Groups.map(function (h) {
    return obj[h] !== undefined ? obj[h] : "";
  });
}

/**
 * _isDescendantGroup — هل candidateId من أحفاد groupId (أو نفسه)؟
 * أساس منع الحلقات الدائرية (Circular Reference) عند اختيار المجموعة الأم.
 */
function _isDescendantGroup(allGroups, groupId, candidateId) {
  if (!candidateId) return false;
  if (String(candidateId) === String(groupId)) return true;
  var byId = {};
  allGroups.forEach(function (g) {
    byId[g.id] = g;
  });
  var cur = byId[candidateId];
  var guard = 0; // حماية من أي حلقة موجودة مسبقًا بالخطأ
  while (cur && cur.parent_id && guard < 500) {
    if (String(cur.parent_id) === String(groupId)) return true;
    cur = byId[cur.parent_id];
    guard++;
  }
  return false;
}

/**
 * _computeGroupLevelPath — يحسب level و full_path لمجموعة اعتمادًا على أبيها
 */
function _computeGroupLevelPath(allGroups, name, parentId) {
  if (!parentId) return { level: 0, full_path: name };
  var byId = {};
  allGroups.forEach(function (g) {
    byId[g.id] = g;
  });
  var parent = byId[parentId];
  if (!parent) return { level: 0, full_path: name };
  return {
    level: (Number(parent.level) || 0) + 1,
    full_path: (parent.full_path || parent.name) + " / " + name,
  };
}

/**
 * _cascadeRecomputeGroupDescendants — بعد نقل/تعديل مجموعة، لازم كل
 * أحفادها يعيدوا حساب level و full_path لأن مسار الأب اتغيّر.
 */
function _cascadeRecomputeGroupDescendants(groupId) {
  var sheet = getSheet("Groups");
  var all = getSheetData("Groups");
  var byParent = {};
  all.forEach(function (g) {
    var pid = g.parent_id || "__root__";
    (byParent[pid] = byParent[pid] || []).push(g);
  });
  var byId = {};
  all.forEach(function (g) {
    byId[g.id] = g;
  });

  function walk(id) {
    var children = byParent[id] || [];
    children.forEach(function (child) {
      var parent = byId[child.parent_id];
      var level = ((parent && Number(parent.level)) || 0) + 1;
      var fullPath =
        ((parent && (parent.full_path || parent.name)) || "") +
        " / " +
        child.name;
      child.level = level;
      child.full_path = fullPath;
      // [PERF-BATCH-1] نداء واحد بدل اتنين لكل عقدة في الشجرة
      _applyRowUpdates(sheet, child._row, HEADERS.Groups, {
        level: level,
        full_path: fullPath,
      });
      walk(child.id); // نزول لأحفاد الأحفاد
    });
  }
  walk(groupId);
}

/**
 * _refreshGroupHasChildren — يحدّث علم has_children لمجموعة معيّنة
 * اعتمادًا على وجود مجموعات فرعية فعلية تحتها.
 */
function _refreshGroupHasChildren(groupId) {
  if (!groupId) return;
  var sheet = getSheet("Groups");
  var all = getSheetData("Groups");
  var row = findRow(all, "id", groupId);
  if (!row) return;
  var hasChildren = all.some(function (g) {
    return String(g.parent_id || "") === String(groupId);
  });
  sheet
    .getRange(row._row, HEADERS.Groups.indexOf("has_children") + 1)
    .setValue(hasChildren);
}

function addGroup(g) {
  // [FIX] قفل إلزامي حول "فحص تكرار الرمز + الإضافة" معاً — قبل الإصلاح
  // كان ممكن طلبين addGroup (مثلاً من نقرة دبل على زرار الحفظ، أو إعادة
  // محاولة بسبب بطء الشبكة) يقروا الشيت في نفس اللحظة *قبل* ما أي منهم
  // يكتب صفه، فيعدّي الاتنين فحص "الرمز مستخدم بالفعل" وتتكرر المجموعة.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return errResponse("النظام مشغول، حاول مرة أخرى");
  }
  try {
    var permErr = _checkPermission(g.user, "addGroup", g.sessionToken);
    if (permErr) return permErr;
    // [VALIDATION-ENGINE-MIGRATION] فحص الحقول المطلوبة موحّد الآن عبر
    // ValidationEngine.isRequired بدل شرط `!g.name` الخام (نفس السلوك، بالإضافة
    // لرفض القيم اللي مسافات فاضية بس زي "   ").
    if (!ValidationEngine.isRequired(g.name))
      return errResponse("اسم المجموعة مطلوب");
    if (!ValidationEngine.isRequired(g.prefix))
      return errResponse("رمز المجموعة (Prefix) مطلوب");
    if (!ValidationEngine.isRequired(g.warehouse_id))
      return errResponse("يجب اختيار المخزن");

    const existing = getSheetData("Groups");
    // [FIX] الرمز (prefix) بقى ممكن يتكرر عمدًا — المعرّف الحقيقي والفريد
    // للمجموعة بقى هو المسلسل (seq) مش الرمز، فمفيش داعي لمنع تكرار الرمز هنا.

    var parentId = (g.parent_id || "").trim ? g.parent_id.trim() : g.parent_id;
    if (parentId && !ValidationEngine.recordExists(existing, "id", parentId))
      return errResponse("المجموعة الأم المختارة غير موجودة");

    const id = makeId("GRP");
    const name = g.name.trim();
    const lp = _computeGroupLevelPath(existing, name, parentId);
    // مسلسل تسلسلي فريد (seq) — أعلى مسلسل موجود + 1، محمي بالـ Lock
    // اللي فوق عشان لو طلبين إضافة جم مع بعض ما ياخدوش نفس الرقم.
    const seq =
      existing.reduce(function (max, r) {
        var n = Number(r.seq) || 0;
        return n > max ? n : max;
      }, 0) + 1;

    // [DATALAYER-ENGINE-MIGRATION] DataLayer.insert بيستدعي _appendRowProtected
    // داخليًا تلقائيًا (نفس إصلاح لون الخط اللي كان هنا صراحةً) — مفيش أي
    // فقدان سلوك، وبيكتب كل حقل بالاسم مش بالترتيب (أأمن من _groupRowArray
    // اليدوية لو اتزود عمود جديد مستقبلًا).
    var insertRes = DataLayer.insert("Groups", {
      id: id,
      seq: seq,
      name: name,
      prefix: g.prefix.trim().toUpperCase(),
      warehouse_id: g.warehouse_id,
      notes: g.notes || "",
      parent_id: parentId || "",
      level: lp.level,
      full_path: lp.full_path,
      sort_order: g.sort_order || 0,
      has_children: false,
    });
    if (!insertRes.success)
      return errResponse(insertRes.errorMessage || "خطأ في إضافة المجموعة");

    if (parentId) _refreshGroupHasChildren(parentId);

    AuditEngine.log("ADD_GROUP", {
      user: g.user || "SYSTEM",
      table: "Groups",
      record_id: id,
      details:
        "إضافة مجموعة: " +
        name +
        " | مسلسل: #" +
        seq +
        " | رمز: " +
        g.prefix.trim().toUpperCase() +
        (parentId ? " | تحت: " + parentId : " | مجموعة رئيسية")});
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم إضافة المجموعة بنجاح", { id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

function updateGroup(g) {
  try {
    var permErr = _checkPermission(g.user, "updateGroup", g.sessionToken);
    if (permErr) return permErr;
    const rows = getSheetData("Groups");
    const row = findRow(rows, "id", g.id);
    if (!row) return errResponse("المجموعة غير موجودة");

    var parentId = (g.parent_id || "").trim ? g.parent_id.trim() : g.parent_id;

    // ── منع الأخطاء (رابعًا في المتطلبات) ──
    if (parentId && String(parentId) === String(g.id))
      return errResponse("لا يمكن أن تكون المجموعة أبًا لنفسها");
    if (parentId && !ValidationEngine.recordExists(rows, "id", parentId))
      return errResponse("المجموعة الأم المختارة غير موجودة");
    if (parentId && _isDescendantGroup(rows, g.id, parentId))
      return errResponse(
        " علاقة دائرية: لا يمكن نقل المجموعة داخل أحد أبنائها",
      );

    // [VALIDATION-ENGINE-MIGRATION] نفس فحص addGroup — موحّد عبر isRequired.
    // (كانت هذه الحقول تعتمد على تحقق الفرونت إند فقط قبل التوحيد)
    if (!ValidationEngine.isRequired(g.name))
      return errResponse("اسم المجموعة مطلوب");
    if (!ValidationEngine.isRequired(g.prefix))
      return errResponse("رمز المجموعة (Prefix) مطلوب");
    if (!ValidationEngine.isRequired(g.warehouse_id))
      return errResponse("يجب اختيار المخزن");

    const name = g.name.trim();
    const oldParentId = row.parent_id || "";
    const lp = _computeGroupLevelPath(rows, name, parentId);

    // [ENGINE-SKIP] الكتابة هنا متروكة عمدًا بدون DataLayer.update: (1) إصلاح
    // لون الخط (setFontColor(null)) قبل الكتابة مباشرة — DataLayer.update
    // مالوش الخطوة دي، فاستبدالها كان هيرجّع باغ "البيانات المختفية بصريًا"
    // اللي اتصلح قبل كده. (2) _cascadeRecomputeGroupDescendants تحت بتعتمد
    // على نفس نسخة `rows`/`byId` المحمّلة في الميموري لعمل تحديث دفعة واحدة
    // لكل الأحفاد — لو استبدلناها بـ DataLayer.update لكل عقدة، كل نداء هيعمل
    // readSheet كامل للجدول من جديد (أداء أسوأ بكتير على شجرة كبيرة).
    var _groupsUpdRange = getSheet("Groups").getRange(
      row._row,
      1,
      1,
      GROUPS_COL_COUNT,
    );
    // [FIX] نفس منطق _appendRowProtected — إعادة ضبط لون الخط الافتراضي
    // (أسود/تلقائي) قبل التعديل عشان أي تنسيق قديم متبقٍّ (خط أبيض) ميفضلش
    // موروثًا في الصف بعد التحديث.
    _groupsUpdRange.setFontColor(null);
    _groupsUpdRange.setValues([
      _groupRowArray({
        id: g.id,
        seq: row.seq, // ← المسلسل ثابت مدى عمر المجموعة، ميتغيرش عند التعديل
        name: name,
        prefix: g.prefix.trim().toUpperCase(),
        warehouse_id: g.warehouse_id,
        notes: g.notes || "",
        created_at: row.created_at,
        parent_id: parentId || "",
        level: lp.level,
        full_path: lp.full_path,
        sort_order:
          g.sort_order !== undefined ? g.sort_order : row.sort_order || 0,
        has_children: row.has_children || false,
      }),
    ]);

    // لو الاسم أو الأب اتغيّر، الأحفاد كلهم لازم يتحدّث فيهم full_path/level
    _cascadeRecomputeGroupDescendants(g.id);

    // تحديث has_children للأب القديم والجديد
    if (oldParentId && String(oldParentId) !== String(parentId || ""))
      _refreshGroupHasChildren(oldParentId);
    if (parentId) _refreshGroupHasChildren(parentId);

    AuditEngine.log("UPDATE_GROUP", {
      user: g.user || "SYSTEM",
      table: "Groups",
      record_id: g.id,
      details: "تعديل مجموعة: " + name});
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم تعديل المجموعة");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteGroup(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "deleteGroup", sessionToken);
    if (permErr) return permErr;
    if (getSheetData("Items").some((it) => it.group === id))
      return errResponse("لا يمكن حذف مجموعة مرتبطة بأصناف");

    const allGroups = getSheetData("Groups");
    const row = findRow(allGroups, "id", id);
    if (!row) return errResponse("المجموعة غير موجودة");

    const hasChildren = allGroups.some(function (g) {
      return String(g.parent_id || "") === String(id);
    });
    if (hasChildren)
      return errResponse(
        "لا يمكن حذف مجموعة تحتوي على مجموعات فرعية — انقل أو احذف الفرعيات أولًا",
      );

    AuditEngine.log("DELETE_GROUP", {
      user: "SYSTEM",
      table: "Groups",
      record_id: id,
      details: "حذف مجموعة ID: " + id});
    // [DATALAYER-ENGINE-MIGRATION] Groups مفيهاش deleted_at → حذف فعلي تلقائي،
    // نفس سلوك deleteRow القديم بالظبط.
    var deleteRes = DataLayer.delete("Groups", id);
    if (!deleteRes.success)
      return errResponse(deleteRes.errorMessage || "خطأ في حذف المجموعة");
    if (row.parent_id) _refreshGroupHasChildren(row.parent_id);
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم حذف المجموعة");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}



/**
 * deleteGroupCascade — [GROUP-HIERARCHY P7] حذف آمن لمجموعة عندها فرعيات
 * و/أو أصناف مرتبطة. بيدّي خيارين مستقلّين قبل الحذف:
 *   moveChildrenTo: معرّف مجموعة تستقبل كل الفرعيات المباشرة (فاضي = تترقّى لتصبح جذور)
 *   moveItemsTo:    معرّف مجموعة تستقبل كل الأصناف المرتبطة (مطلوب لو فيه أصناف)
 * @param {Object} payload {id, moveChildrenTo, moveItemsTo, user, sessionToken}
 */
function deleteGroupCascade(payload) {
  try {
    var id = payload.id;
    var permErr = _checkPermission(
      payload.user,
      "deleteGroup",
      payload.sessionToken,
    );
    if (permErr) return permErr;

    var allGroups = getSheetData("Groups");
    var row = findRow(allGroups, "id", id);
    if (!row) return errResponse("المجموعة غير موجودة");

    var directChildren = allGroups.filter(function (g) {
      return String(g.parent_id || "") === String(id);
    });
    var linkedItems = getSheetData("Items").filter(function (it) {
      return it.group === id;
    });

    var moveChildrenTo = (payload.moveChildrenTo || "").trim();
    var moveItemsTo = (payload.moveItemsTo || "").trim();

    if (directChildren.length && moveChildrenTo) {
      if (String(moveChildrenTo) === String(id))
        return errResponse("لا يمكن نقل الفرعيات إلى نفس المجموعة المحذوفة");
      if (moveChildrenTo && !findRow(allGroups, "id", moveChildrenTo))
        return errResponse("المجموعة المستهدفة لنقل الفرعيات غير موجودة");
    }
    if (linkedItems.length && !moveItemsTo)
      return errResponse(
        "يجب اختيار مجموعة بديلة لنقل الأصناف المرتبطة قبل الحذف",
      );
    if (linkedItems.length && !findRow(allGroups, "id", moveItemsTo))
      return errResponse("المجموعة المستهدفة لنقل الأصناف غير موجودة");

    // ── 1) نقل الفرعيات المباشرة ──
    var groupsSheet = getSheet("Groups");
    directChildren.forEach(function (child) {
      var freshRow = findRow(getSheetData("Groups"), "id", child.id);
      var lp = _computeGroupLevelPath(
        getSheetData("Groups"),
        child.name,
        moveChildrenTo || "",
      );
      // [PERF-BATCH-1] نداء واحد بدل 3 لكل فرع منقول
      _applyRowUpdates(groupsSheet, freshRow._row, HEADERS.Groups, {
        parent_id: moveChildrenTo || "",
        level: lp.level,
        full_path: lp.full_path,
      });
      _cascadeRecomputeGroupDescendants(child.id);
    });

    // ── 2) نقل الأصناف المرتبطة ──
    // [PERF-FIX] كان بينادي getRange().setValue() مرة لكل صنف منقول (نداء
    // API منفصل لكل صف). القيمة الجديدة (moveItemsTo) واحدة لكل الأصناف،
    // فبنجمع كل الخلايا في getRangeList ونكتب عليها مرة واحدة.
    if (linkedItems.length) {
      var itemsSheet = getSheet("Items");
      var groupColLetter = _colToA1Letter(HEADERS.Items.indexOf("group") + 1);
      var itemsFreshData = getSheetData("Items");
      var groupA1Cells = linkedItems
        .map(function (it) {
          var freshItemRow = findRow(itemsFreshData, "id", it.id);
          return freshItemRow ? groupColLetter + freshItemRow._row : null;
        })
        .filter(Boolean);
      if (groupA1Cells.length) {
        itemsSheet.getRangeList(groupA1Cells).setValue(moveItemsTo);
      }
    }

    // ── 3) الحذف نفسه ──
    var finalRow = findRow(getSheetData("Groups"), "id", id);
    AuditEngine.log("DELETE_GROUP_CASCADE", {
      user: payload.user || "SYSTEM",
      table: "Groups",
      record_id: id,
      details:
        "حذف مجموعة ID: " +
        id +
        " | فرعيات منقولة: " +
        directChildren.length +
        " → " +
        (moveChildrenTo || "جذر") +
        " | أصناف منقولة: " +
        linkedItems.length +
        " → " +
        (moveItemsTo || "—")});
    groupsSheet.deleteRow(finalRow._row);

    if (moveChildrenTo) _refreshGroupHasChildren(moveChildrenTo);
    if (finalRow.parent_id) _refreshGroupHasChildren(finalRow.parent_id);

    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    return okResponse(
      " تم حذف المجموعة" +
        (directChildren.length
          ? " ونقل " + directChildren.length + " فرعية"
          : "") +
        (linkedItems.length ? " ونقل " + linkedItems.length + " صنف" : ""),
    );
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function getGroupName(groupId) {
  return group ? group.name : null;
}

/**
 * getGroupsTree — يرجّع كل المجموعات مبنية كشجرة (children متداخلة)
 * تُستخدم في P3 (Tree View) وP2 (Tree Select dropdown).
 * كل عقدة: { id, name, prefix, parent_id, level, full_path, has_children, item_count, children: [...] }
 */
function getGroupsTree() {
  try {
    var all = getSheetData("Groups");
    var items = getSheetData("Items");
    var itemCountByGroup = {};
    items.forEach(function (it) {
      if (!it.group) return;
      itemCountByGroup[it.group] = (itemCountByGroup[it.group] || 0) + 1;
    });

    var byId = {};
    all.forEach(function (g) {
      byId[g.id] = {
        id: g.id,
        name: g.name,
        prefix: g.prefix,
        warehouse_id: g.warehouse_id,
        notes: g.notes,
        parent_id: g.parent_id || "",
        level: Number(g.level) || 0,
        full_path: g.full_path || g.name,
        sort_order: Number(g.sort_order) || 0,
        has_children: !!g.has_children,
        item_count: itemCountByGroup[g.id] || 0,
        children: [],
      };
    });

    var roots = [];
    all.forEach(function (g) {
      var node = byId[g.id];
      if (g.parent_id && byId[g.parent_id]) {
        byId[g.parent_id].children.push(node);
      } else {
        roots.push(node);
      }
    });

    function sortChildren(list) {
      list.sort(function (a, b) {
        return (
          a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ar")
        );
      });
      list.forEach(function (n) {
        if (n.children.length) sortChildren(n.children);
      });
    }
    sortChildren(roots);

    return okResponse("", { tree: roots, flat: Object.values(byId) });
  } catch (e) {
    return errResponse("خطأ في بناء شجرة المجموعات: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §09  Warehouses CRUD
// ─────────────────────────────────────────────────────────────

// ── getNextWarehouseCode ─────────────────────────────────────────────────────
// [AUTO-CODE] نسخة قابلة للاستدعاء من الواجهة (google.script.run) لعرض الكود
// التسلسلي التالي فور فتح مودال "مخزن جديد" — نفس مبدأ getNextCashBoxCode/
// getNextCustomerCode. التوليد الملزم الفعلي يتم مرة أخرى داخل addWarehouse
// وقت الحفظ.
function getNextWarehouseCode() {
  return okResponse("", {
    data: AutoNumberService.preview(function () {
      return getWarehouses().map(function (r) {
        return r.code;
      });
    }),
  });
}

function addWarehouse(wh) {
  try {
    var permErr = _checkPermission(wh.user, "addWarehouse", wh.sessionToken);
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(wh.name))
      return errResponse("اسم المخزن مطلوب");

    const existing = getWarehouses();
    // [AUTO-NUMBER-CENTRAL] كود المخزن كان بالكامل يدوي/اختياري — بقى له
    // اقتراح تلقائي (1، 2، 3...) لو الحقل وصل فاضي، بنفس آلية باقي
    // الكيانات (خزائن/أقسام/عملاء...) عبر AutoNumberService المركزية.
    if (!wh.code || !String(wh.code).trim()) {
      wh.code = AutoNumberService.preview(function () {
        return existing.map(function (r) {
          return r.code;
        });
      });
    }
    // [VALIDATION-ENGINE-MIGRATION] موحّد عبر ValidationEngine.isDuplicate
    // (نفس المنطق: تكرار الاسم أو الكود — بمقارنة غير حساسة لحالة الأحرف الآن،
    // بما يتفق مع باقي المشروع مثل Code_20_Sales.js)
    if (
      ValidationEngine.isDuplicate(existing, "name", wh.name) ||
      (wh.code && ValidationEngine.isDuplicate(existing, "code", wh.code))
    )
      return errResponse("هذا المخزن موجود بالفعل");

    // [DATALAYER-ENGINE-MIGRATION] الكود القديم كان بيكتب مصفوفة بـ9 قيم فقط
    // بينما WAREHOUSE_HEADERS فيها 10 عمود (...notes, account_id, created_at) —
    // يعني created_at الفعلي كان بيتكتب غلط في عمود account_id، وعمود created_at
    // كان بيفضل فاضي دايمًا. DataLayer.insert بيكتب بالاسم مش بالترتيب، فالمشكلة
    // دي بتتصلح تلقائيًا هنا (account_id هيفضل فاضي لحد ما يُربط لاحقًا من
    // شاشة الحسابات، وcreated_at هيتسجل صح).
    var insertRes = DataLayer.insert(
      "Warehouses",
      {
        name: wh.name.trim(),
        code: (wh.code || "").trim(),
        type: wh.type || "مختلط",
        manager: (wh.manager || "").trim(),
        location: (wh.location || "").trim(),
        status: wh.status || "نشط",
        notes: wh.notes || "",
      },
      { headers: WAREHOUSE_HEADERS, idPrefix: "WH" },
    );
    if (!insertRes.success)
      return errResponse(insertRes.errorMessage || "خطأ في إضافة المخزن");
    const id = insertRes.data.id;
    AuditEngine.log("ADD_WAREHOUSE", {
      user: wh.user || "SYSTEM",
      table: "Warehouses",
      record_id: id,
      details:
        "إضافة مخزن: " + wh.name.trim() + " | نوع: " + (wh.type || "مختلط")});
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم إضافة المخزن بنجاح", { id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateWarehouse(wh) {
  try {
    var permErr = _checkPermission(wh.user, "updateWarehouse", wh.sessionToken);
    if (permErr) return permErr;
    const row = findRow(getWarehouses(), "id", wh.id);
    if (!row) return errResponse("المخزن غير موجود");
    // [VALIDATION-ENGINE-MIGRATION] كان الاسم يعتمد على تحقق الفرونت إند فقط
    if (!ValidationEngine.isRequired(wh.name))
      return errResponse("اسم المخزن مطلوب");

    // [DATALAYER-ENGINE-MIGRATION] نفس باغ addWarehouse: getRange(...,9)
    // كان بيكتب في عمود account_id بدل ما يسيبه — DataLayer.update بيدمج
    // بالاسم فقط الحقول المُرسَلة، فـ account_id/created_at الحاليين بيفضلوا
    // زي ما هم بدون أي مساس.
    var updateRes = DataLayer.update(
      "Warehouses",
      wh.id,
      {
        name: wh.name.trim(),
        code: (wh.code || "").trim(),
        type: wh.type || "مختلط",
        manager: (wh.manager || "").trim(),
        location: (wh.location || "").trim(),
        status: wh.status || "نشط",
        notes: wh.notes || "",
      },
      { headers: WAREHOUSE_HEADERS },
    );
    if (!updateRes.success)
      return errResponse(updateRes.errorMessage || "خطأ في تعديل المخزن");
    AuditEngine.log("UPDATE_WAREHOUSE", {
      user: wh.user || "SYSTEM",
      table: "Warehouses",
      record_id: wh.id,
      details: "تعديل مخزن: " + wh.name.trim()});
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم تعديل المخزن");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * _seedDefaultWarehouseIfEmpty — [DEFAULT-WAREHOUSE-1] ينشئ مخزنًا
 * افتراضيًا "المخزن الرئيسي (Main Warehouse)" أول مرة النظام يتهيّأ،
 * فقط لو شيت Warehouses فاضي تمامًا من أي مخزن (عميل عنده مخزن واحد
 * فأكتر بالفعل لا يتأثر إطلاقاً — الدالة بترجع فورًا بدون أي إضافة).
 *
 * بتنادي addWarehouse() القياسية بدل تكرار منطقها، فأي علاقة داخل
 * النظام (كود تلقائي، AuditLog، إبطال الكاش...) بتتربط بنفس الطريقة
 * تمامًا زي أي مخزن يتضاف يدويًا من الواجهة. الاسم قابل للتعديل لاحقًا
 * عادي من شاشة المخازن (updateWarehouse).
 *
 * Idempotent وSelf-Healing زي باقي دوال seed الأخرى (_seedDefaultCashBoxIfEmpty
 * إلخ): أي تشغيل لاحق لـ initializeSystem()/setupEverything() بيتخطاها
 * لو فيه أي مخزن موجود بالفعل، فمينفعش تتكرر.
 *
 * بتتنادى من initializeSystem() في Code_21b_Migrations.js.
 */
function _seedDefaultWarehouseIfEmpty() {
  try {
    var existing = readSheet("Warehouses", WAREHOUSE_HEADERS, {
      trimStrings: true,
    });
    if (existing && existing.length > 0) {
      return "↩️ يوجد مخزن واحد على الأقل بالفعل (" + existing.length + ") — تخطّي";
    }

    // لازم يوزر فعّال (عادةً admin الافتراضي من ensureDefaultUsers) عشان
    // ننشئ جلسة نظام مؤقتة وننادي addWarehouse العامة بكل حمايتها.
    var users = readSheet("Users", null, { trimStrings: true });
    var systemUser =
      users.find(function (u) {
        return String(u.username).trim().toLowerCase() === "admin";
      }) || users[0];

    if (!systemUser) {
      Logger.log(
        "[_seedDefaultWarehouseIfEmpty] مفيش أي يوزر في النظام لسه — تخطّي إنشاء المخزن الافتراضي",
      );
      return "⏭️ تخطّي — مفيش يوزر بعد لإنشاء الجلسة";
    }

    var sess = createSession(systemUser.username, systemUser.role);
    if (!sess || !sess.success) {
      Logger.log(
        "[_seedDefaultWarehouseIfEmpty] فشل إنشاء جلسة مؤقتة: " +
          JSON.stringify(sess),
      );
      return " فشل إنشاء جلسة مؤقتة لإنشاء المخزن الافتراضي";
    }

    var result = addWarehouse({
      name: "المخزن الافتراضي",
      type: "مختلط",
      status: "نشط",
      notes: "المخزن الافتراضي الرئيسي للنظام",
      user: systemUser.username,
      sessionToken: sess.token,
    });

    if (result && result.success) {
      Logger.log(
        "[_seedDefaultWarehouseIfEmpty] تم إنشاء المخزن الافتراضي — id: " +
          result.id,
      );
      return " تم إنشاء المخزن الافتراضي (id: " + result.id + ")";
    }
    Logger.log(
      "[_seedDefaultWarehouseIfEmpty] فشل إنشاء المخزن الافتراضي: " +
        JSON.stringify(result),
    );
    return " فشل إنشاء المخزن الافتراضي: " + (result && result.message);
  } catch (e) {
    Logger.log("[_seedDefaultWarehouseIfEmpty] خطأ: " + e.message);
    return " خطأ في إنشاء المخزن الافتراضي: " + e.message;
  }
}

function deleteWarehouse(id, user, sessionToken) {
  try {
    // [WIRE-FIX] بقت بتتوصّل بـ DeleteEngine الموحّد — كل الفحوصات القديمة
    // (WH_MAIN، مجموعات مرتبطة، أصناف مسجّلة، حركات مخزون تاريخية) اتنقلت
    // حرفيًا لـ DeleteConfig.warehouse.customValidate بدل ما تتفقد هنا،
    // فمفيش أي تغيير فعلي في مستوى الحماية.
    var r = DeleteEngine.delete("warehouse", id, user, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(" تم حذف المخزن");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §10  Colors CRUD
// ─────────────────────────────────────────────────────────────

function getColors() {
  try {
    return { success: true, data: cleanArr(_readColorsRaw()) };
  } catch (e) {
    return { success: false, data: [], message: e.message };
  }
}

function addColor(color) {
  try {
    var permErr = _checkPermission(color.user, "addColor", color.sessionToken);
    if (permErr) return permErr;
    // [VALIDATION-ENGINE-MIGRATION]
    if (!ValidationEngine.isRequired(color.name))
      return errResponse("اسم اللون مطلوب");
    if (!ValidationEngine.isRequired(color.code))
      return errResponse("كود اللون مطلوب");
    var existing = _readColorsRaw();
    if (ValidationEngine.isDuplicate(existing, "code", color.code))
      return errResponse("كود اللون موجود بالفعل");
    // [DATALAYER-ENGINE-MIGRATION] DataLayer.insert بيستدعي _appendRowProtected
    // داخليًا تلقائيًا (نفس تنسيق الأعمدة المحمية + إعادة ضبط لون الخط)،
    // فمفيش أي فقدان سلوك عن الكود القديم.
    var insertRes = DataLayer.insert(
      "Colors",
      {
        name: String(color.name).trim(),
        code: String(color.code).trim().toUpperCase(),
        hex: String(color.hex || "").trim(),
        notes: String(color.notes || "").trim(),
      },
      { idPrefix: "CLR" },
    );
    if (!insertRes.success)
      return errResponse(insertRes.errorMessage || "خطأ في إضافة اللون");
    var id = insertRes.data.id;
    AuditEngine.log("ADD_COLOR", {
      user: color.user || "SYSTEM",
      table: "Colors",
      record_id: id,
      details: "إضافة لون: " + color.name + " | hex: " + (color.hex || "—")});
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "colors");
    return okResponse("تم إضافة اللون بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateColor(color) {
  try {
    var permErr = _checkPermission(
      color.user,
      "updateColor",
      color.sessionToken,
    );
    if (permErr) return permErr;
    // [VALIDATION-ENGINE-MIGRATION]
    if (!ValidationEngine.isRequired(color.id))
      return errResponse("معرف اللون مطلوب");
    if (!ValidationEngine.isRequired(color.name))
      return errResponse("اسم اللون مطلوب");
    if (!ValidationEngine.isRequired(color.code))
      return errResponse("كود اللون مطلوب");
    var existing = _readColorsRaw();
    var row = findRow(existing, "id", color.id);
    if (!row) return errResponse("اللون غير موجود");
    if (
      ValidationEngine.isDuplicate(existing, "name", color.name, {
        excludeId: color.id,
      })
    )
      return errResponse("اسم اللون مستخدم بالفعل");
    if (
      ValidationEngine.isDuplicate(existing, "code", color.code, {
        excludeId: color.id,
      })
    )
      return errResponse("كود اللون مستخدم بالفعل");
    // [DATALAYER-ENGINE-MIGRATION] بدل getRange(row._row,...).setValues — 
    // DataLayer.update بيدمج الحقول المُرسَلة فوق السجل الحالي بالـ id مباشرة.
    var updateRes = DataLayer.update("Colors", color.id, {
      name: String(color.name).trim(),
      code: String(color.code).trim().toUpperCase(),
      hex: String(color.hex || "").trim(),
      notes: String(color.notes || "").trim(),
    });
    if (!updateRes.success)
      return errResponse(updateRes.errorMessage || "خطأ في تعديل اللون");
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "colors");
    return okResponse("تم تعديل اللون");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteColor(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "deleteColor", sessionToken);
    if (permErr) return permErr;
    var row = findRow(_readColorsRaw(), "id", id);
    if (!row) return errResponse("اللون غير موجود");
    // [MD-05 FIX] فحص استخدام قبل الحذف الفعلي — كانت الدالة تحذف نهائيًا بدون
    // أي فحص، فلو فيه رصيد مخزون فعلي بهذا اللون (Stock.color يخزن الاسم نصًا)
    // كان الصنف يفقد ربط اسمه ولونه (hex/code) في كل شاشات المخزون والتقارير.
    var colorName = String(row.name || "")
      .trim()
      .toLowerCase();
    var inUse = getSheetData("Stock").some(function (s) {
      return (
        String(s.color || "")
          .trim()
          .toLowerCase() === colorName && Number(s.quantity || 0) > 0
      );
    });
    if (inUse)
      return errResponse(
        "لا يمكن حذف لون له رصيد مخزون فعلي — يرجى تصفير الرصيد أولاً",
      );
    AuditEngine.log("DELETE_COLOR", {
      user: user || "SYSTEM",
      table: "Colors",
      record_id: id,
      details: "حذف لون ID: " + id});
    // [DATALAYER-ENGINE-MIGRATION] Colors مفيهاش عمود deleted_at → DataLayer.delete
    // بيعمل حذف فعلي (Hard Delete) تلقائيًا، بنفس سلوك deleteRow القديم بالظبط.
    var deleteRes = DataLayer.delete("Colors", id);
    if (!deleteRes.success)
      return errResponse(deleteRes.errorMessage || "خطأ في حذف اللون");
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "colors");
    return okResponse("تم حذف اللون");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * دالة مساعدة موحّدة لقراءة شيت Colors الخام
 * تُغني عن تكرار readSheet("Colors"...) في getColors / addColor / updateColor
 *
 * [PHASE-6 / محرك تحميل البيانات] Colors بيانات مرجعية نادراً ما تتغيّر
 * (DATA_LEVEL.REFERENCE) — كانت بتتقرأ من Sheets في كل مرة يتبطّل فيها
 * كاش حزمة getAllData العام (كل عملية كتابة على أي شيت في النظام، حتى
 * لو مالهاش علاقة بالألوان إطلاقًا). دلوقتي بتتخزّن في CacheEngine على
 * حدة بـ TTL طويل (6 ساعات) ولا تتبطّل إلا لو Colors نفسها اتغيّرت
 * (شوف addColor/updateColor/deleteColor تحت).
 */
function _readColorsRaw() {
  return CacheEngine.getOrCompute(
    CacheEngine.NAMESPACE.REFERENCE,
    "colors",
    function () {
      // [DATALAYER-ENGINE-MIGRATION] الكتابة (add/update/delete) بقت كلها عبر
      // DataLayer.insert/update/delete بالـ id، فمعادش محتاجين _row من القراءة
      // الخام هنا — آمن نستخدم DataLayer.getAll (بيرجع بيانات نضيفة بالفعل).
      var r = DataLayer.getAll("Colors", { trimStrings: true });
      return r.success ? r.data : [];
    },
    CacheEngine.POLICY.REFERENCE,
  );
}

// ─────────────────────────────────────────────────────────────
// §10-B  Size Definitions (CRUD)
// getSizes / addSize / updateSize / deleteSize / _readSizesRaw
// ─────────────────────────────────────────────────────────────

function getSizes() {
  try {
    return { success: true, data: cleanArr(_readSizesRaw()) };
  } catch (e) {
    return { success: false, data: [], message: e.message };
  }
}

function addSize(size) {
  try {
    var permErr = _checkPermission(size.user, "addSize", size.sessionToken);
    if (permErr) return permErr;
    // [VALIDATION-ENGINE-MIGRATION]
    if (!ValidationEngine.isRequired(size.name))
      return errResponse("اسم المقاس مطلوب");
    if (!ValidationEngine.isRequired(size.code))
      return errResponse("كود المقاس مطلوب");
    var existing = _readSizesRaw();
    if (ValidationEngine.isDuplicate(existing, "code", size.code))
      return errResponse("كود المقاس موجود بالفعل");
    // [DATALAYER-ENGINE-MIGRATION]
    var insertRes = DataLayer.insert(
      "Sizes",
      {
        name: String(size.name).trim(),
        code: String(size.code).trim().toUpperCase(),
        notes: String(size.notes || "").trim(),
      },
      { idPrefix: "SZ" },
    );
    if (!insertRes.success)
      return errResponse(insertRes.errorMessage || "خطأ في إضافة المقاس");
    var id = insertRes.data.id;
    AuditEngine.log("ADD_SIZE", {
      user: size.user || "SYSTEM",
      table: "Sizes",
      record_id: id,
      details: "إضافة مقاس: " + size.name + " | كود: " + size.code});
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "sizes");
    return okResponse("تم إضافة المقاس بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * addSizesBulk — [REMOVED] كان بيضيف مجموعات مقاسات جاهزة ثابتة (Presets)،
 * لكن اتلغى بطلب المستخدم لصالح مفهوم "مجموعات" مبنية على المقاسات
 * المُضافة فعلاً في النظام (شوف getSizeGroups/addSizeGroup تحت).
 */

// ─────────────────────────────────────────────────────────────
// §10-C  Size Groups (CRUD) — مجموعات مقاسات مبنية على مقاسات
// مُضافة فعلاً (زي "مجموعة رجالي" = S,M,L,XL من المقاسات الموجودة)
// getSizeGroups / addSizeGroup / updateSizeGroup / deleteSizeGroup
// ─────────────────────────────────────────────────────────────

// [PHASE-6 / محرك تحميل البيانات] نفس مبدأ _readColorsRaw فوق — بيانات
// مرجعية نادراً ما تتغيّر، كاش خاص 6 ساعات مستقل عن كاش الحزمة العام.
function _readSizeGroupsRaw() {
  return CacheEngine.getOrCompute(
    CacheEngine.NAMESPACE.REFERENCE,
    "sizeGroups",
    function () {
      var r = DataLayer.getAll("SizeGroups", { trimStrings: true });
      return r.success ? r.data : [];
    },
    CacheEngine.POLICY.REFERENCE,
  );
}

function getSizeGroups() {
  try {
    return { success: true, data: cleanArr(_readSizeGroupsRaw()) };
  } catch (e) {
    return { success: false, data: [], message: e.message };
  }
}

/**
 * addSizeGroup
 * @param {Object} group
 * @param {string} group.name         اسم المجموعة (مثال: "مقاسات رجالي")
 * @param {Array}  group.size_ids     مصفوفة IDs لمقاسات موجودة فعلاً في شيت Sizes
 * @param {string} [group.notes]
 */
function addSizeGroup(group) {
  try {
    var permErr = _checkPermission(group.user, "addSize", group.sessionToken);
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(group.name))
      return errResponse("اسم المجموعة مطلوب");

    var sizeIds = Array.isArray(group.size_ids) ? group.size_ids : [];
    if (!sizeIds.length)
      return errResponse("اختر مقاساً واحداً على الأقل للمجموعة");

    // [VALIDATE] تأكد إن كل الـ IDs المُرسلة فعلاً موجودة في شيت Sizes —
    // منعًا لحفظ مجموعة بمقاسات محذوفة/غير موجودة.
    var existingSizes = _readSizesRaw();
    var validIds = {};
    existingSizes.forEach(function (s) {
      validIds[String(s.id)] = true;
    });
    var cleanIds = sizeIds
      .map(function (id) {
        return String(id);
      })
      .filter(function (id) {
        return validIds[id];
      });
    if (!cleanIds.length)
      return errResponse("المقاسات المختارة غير موجودة، حدّث الصفحة وحاول تاني");

    var existingGroups = _readSizeGroupsRaw();
    if (ValidationEngine.isDuplicate(existingGroups, "name", group.name))
      return errResponse("اسم المجموعة موجود بالفعل");

    var insertRes = DataLayer.insert(
      "SizeGroups",
      {
        name: String(group.name).trim(),
        size_ids: cleanIds.join(","),
        notes: String(group.notes || "").trim(),
      },
      { idPrefix: "SG" },
    );
    if (!insertRes.success)
      return errResponse(insertRes.errorMessage || "خطأ في إضافة المجموعة");
    var id = insertRes.data.id;
    AuditEngine.log("ADD_SIZE_GROUP", {
      user: group.user || "SYSTEM",
      table: "SizeGroups",
      record_id: id,
      details: "إضافة مجموعة مقاسات: " + group.name + " (" + cleanIds.length + " مقاس)"});
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "sizeGroups");
    return okResponse("تم إضافة مجموعة المقاسات بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateSizeGroup(group) {
  try {
    var permErr = _checkPermission(group.user, "updateSize", group.sessionToken);
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(group.id))
      return errResponse("معرف المجموعة مطلوب");
    if (!ValidationEngine.isRequired(group.name))
      return errResponse("اسم المجموعة مطلوب");

    var sizeIds = Array.isArray(group.size_ids) ? group.size_ids : [];
    if (!sizeIds.length)
      return errResponse("اختر مقاساً واحداً على الأقل للمجموعة");

    var existingSizes = _readSizesRaw();
    var validIds = {};
    existingSizes.forEach(function (s) {
      validIds[String(s.id)] = true;
    });
    var cleanIds = sizeIds
      .map(function (id) {
        return String(id);
      })
      .filter(function (id) {
        return validIds[id];
      });
    if (!cleanIds.length)
      return errResponse("المقاسات المختارة غير موجودة، حدّث الصفحة وحاول تاني");

    var existingGroups = _readSizeGroupsRaw();
    var row = findRow(existingGroups, "id", group.id);
    if (!row) return errResponse("المجموعة غير موجودة");
    if (
      ValidationEngine.isDuplicate(existingGroups, "name", group.name, {
        excludeId: group.id,
      })
    )
      return errResponse("اسم المجموعة مستخدم بالفعل");

    var updateRes = DataLayer.update("SizeGroups", group.id, {
      name: String(group.name).trim(),
      size_ids: cleanIds.join(","),
      notes: String(group.notes || "").trim(),
    });
    if (!updateRes.success)
      return errResponse(updateRes.errorMessage || "خطأ في تعديل المجموعة");
    AuditEngine.log("UPDATE_SIZE_GROUP", {
      user: group.user || "SYSTEM",
      table: "SizeGroups",
      record_id: group.id,
      details: "تعديل مجموعة مقاسات: " + group.name});
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "sizeGroups");
    return okResponse("تم تعديل المجموعة");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteSizeGroup(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "deleteSize", sessionToken);
    if (permErr) return permErr;
    var row = findRow(_readSizeGroupsRaw(), "id", id);
    if (!row) return errResponse("المجموعة غير موجودة");
    AuditEngine.log("DELETE_SIZE_GROUP", {
      user: user || "SYSTEM",
      table: "SizeGroups",
      record_id: id,
      details: "حذف مجموعة مقاسات ID: " + id});
    var deleteRes = DataLayer.delete("SizeGroups", id);
    if (!deleteRes.success)
      return errResponse(deleteRes.errorMessage || "خطأ في حذف المجموعة");
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "sizeGroups");
    return okResponse("تم حذف المجموعة");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function updateSize(size) {
  try {
    var permErr = _checkPermission(size.user, "updateSize", size.sessionToken);
    if (permErr) return permErr;
    // [VALIDATION-ENGINE-MIGRATION]
    if (!ValidationEngine.isRequired(size.id))
      return errResponse("معرف المقاس مطلوب");
    if (!ValidationEngine.isRequired(size.name))
      return errResponse("اسم المقاس مطلوب");
    if (!ValidationEngine.isRequired(size.code))
      return errResponse("كود المقاس مطلوب");
    var existing = _readSizesRaw();
    var row = findRow(existing, "id", size.id);
    if (!row) return errResponse("المقاس غير موجود");
    if (
      ValidationEngine.isDuplicate(existing, "name", size.name, {
        excludeId: size.id,
      })
    )
      return errResponse("اسم المقاس مستخدم بالفعل");
    if (
      ValidationEngine.isDuplicate(existing, "code", size.code, {
        excludeId: size.id,
      })
    )
      return errResponse("كود المقاس مستخدم بالفعل");
    // [DATALAYER-ENGINE-MIGRATION]
    var updateRes = DataLayer.update("Sizes", size.id, {
      name: String(size.name).trim(),
      code: String(size.code).trim().toUpperCase(),
      notes: String(size.notes || "").trim(),
    });
    if (!updateRes.success)
      return errResponse(updateRes.errorMessage || "خطأ في تعديل المقاس");
    AuditEngine.log("UPDATE_SIZE", {
      user: size.user || "SYSTEM",
      table: "Sizes",
      record_id: size.id,
      details: "تعديل مقاس: " + size.name});
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "sizes");
    return okResponse("تم تعديل المقاس");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteSize(id, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "deleteSize", sessionToken);
    if (permErr) return permErr;
    var row = findRow(_readSizesRaw(), "id", id);
    if (!row) return errResponse("المقاس غير موجود");
    AuditEngine.log("DELETE_SIZE", {
      user: "SYSTEM",
      table: "Sizes",
      record_id: id,
      details: "حذف مقاس ID: " + id});
    // [DATALAYER-ENGINE-MIGRATION] Sizes مفيهاش deleted_at → حذف فعلي تلقائي
    var deleteRes = DataLayer.delete("Sizes", id);
    if (!deleteRes.success)
      return errResponse(deleteRes.errorMessage || "خطأ في حذف المقاس");
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    CacheEngine.invalidate(CacheEngine.NAMESPACE.REFERENCE, "sizes");
    return okResponse("تم حذف المقاس");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// [PHASE-6 / محرك تحميل البيانات] نفس مبدأ _readColorsRaw أعلاه
function _readSizesRaw() {
  return CacheEngine.getOrCompute(
    CacheEngine.NAMESPACE.REFERENCE,
    "sizes",
    function () {
      var r = DataLayer.getAll("Sizes", { trimStrings: true });
      return r.success ? r.data : [];
    },
    CacheEngine.POLICY.REFERENCE,
  );
}

// ─────────────────────────────────────────────────────────────

// ┄┄┄ [مصدر: Code.js سطور 4033-5340] Items CRUD + Stock + Transactions + Production Orders + Cutting Data ┄┄┄
// §13  Items CRUD
//
// _buildItemRow()         — بناء صف الصنف للكتابة في الشيت
// addItem()               — إضافة صنف جديد
// updateItem()            — تعديل صنف موجود
// saveItemWithColorSync() — حفظ + مزامنة الألوان مع شيت Colors
// deleteItem()            — حذف صنف (مع التحقق من عدم وجود حركات)
// ─────────────────────────────────────────────────────────────

/**
 * دالة مساعدة مشتركة لبناء صف الصنف
 * colors يجب أن تكون بالصيغة الجديدة: [{name, code}, ...]
 */
// [ITEM-COLUMN-MAP] بدل الاعتماد على أرقام أعمدة ثابتة (Positional Writes)
// لكتابة أعمدة Items 15..81 — كل نداء getRange(row, N, ...) كان بيعتمد على
// إن ترتيب HEADERS.Items ثابت ومطابق يدويًا لترتيب هذه الدوال، وأي تعديل
// مستقبلي (يدوي على الشيت أو كود) كان بيكسر الكتابة بصمت (بيانات محاسبية
// زي inventory_account_id ممكن تتكتب في عمود غلط من غير أي خطأ ظاهر).
// دلوقتي HEADERS.Items بقى فيه كل الـ81 عمود بالاسم (راجع Code_12_Core.js)،
// فبنشتق رقم العمود من الاسم وقت التشغيل بدل ما نكتبه رقم ثابت. لو حد شال
// أو غيّر اسم عمود من HEADERS.Items بالغلط، هنا هيطلع خطأ واضح فورًا بدل
// كتابة صامتة في مكان غلط.
// [ITEM-COLUMN-MAP-SAFETY] لازم تشغّل الدالة دي يدويًا من محرر Apps Script
// (Run > validateItemsSheetSchema) وتراجع الـ Log قبل ما ترفع أي تحديث فيه
// توسيع HEADERS.Items — لأن getSheet() بيتعرّف على الأعمدة بالاسم مش
// بالترتيب: لو نص عنوان أي عمود فعلي في الشيت الحقيقي (مثلاً العمود 15)
// مش مطابق حرفيًا للاسم المتوقع هنا ("name_en")، getSheet() هيفتكر إن
// العمود مش موجود ويضيف عمود جديد بنفس الاسم في آخر الشيت — يعني نسخة
// مكررة فاضية بدل العمود القديم اللي فيه البيانات الحقيقية. الدالة دي
// قراءة فقط (مفيش أي كتابة) وبتقارن رأس كل عمود فعلي مع HEADERS.Items
// موضع بموضع، وبتطلع تقرير واضح بأي اختلاف قبل ما تحصل أي مشكلة.
function validateItemsSheetSchema() {
  var sheet = SS.getSheetByName("Items");
  if (!sheet) {
    Logger.log("⚠️ شيت Items مش موجود أصلاً — مفيش حاجة نتحقق منها.");
    return { ok: true, sheetMissing: true };
  }
  var lastCol = sheet.getLastColumn();
  var actualHeaders = lastCol
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
        return String(h || "").trim();
      })
    : [];
  var expected = HEADERS.Items;
  var mismatches = [];
  var maxLen = Math.max(actualHeaders.length, expected.length);
  for (var i = 0; i < maxLen; i++) {
    var actual = actualHeaders[i] !== undefined ? actualHeaders[i] : "(لا يوجد عمود)";
    var exp = expected[i] !== undefined ? expected[i] : "(لا يوجد في HEADERS.Items)";
    if (actual !== exp) {
      mismatches.push({
        column: i + 1,
        expected: exp,
        actualInSheet: actual,
      });
    }
  }
  if (!mismatches.length) {
    Logger.log(
      "✅ مطابق تمامًا — كل الـ" + expected.length + " عمود في الشيت الفعلي بنفس ترتيب HEADERS.Items بالاسم. آمن تنشر التحديث."
    );
    return { ok: true, mismatches: [] };
  }
  Logger.log(
    "❌ فيه " + mismatches.length + " اختلاف بين الشيت الفعلي وHEADERS.Items — " +
    "لازم تصلّح ده الأول قبل النشر (إما تعدّل نص عنوان العمود في الشيت الحقيقي عشان يطابق، أو تعدّل ترتيب HEADERS.Items لو العمود موجود لكن في مكان تاني):"
  );
  mismatches.forEach(function (m) {
    Logger.log(
      "  عمود " + m.column + ": المتوقع=\"" + m.expected + "\" — الموجود فعليًا=\"" + m.actualInSheet + "\""
    );
  });
  return { ok: false, mismatches: mismatches };
}

function _itemColStart(fieldName) {
  var idx = HEADERS.Items.indexOf(fieldName);
  if (idx === -1) {
    throw new Error(
      "_itemColStart: عمود \"" + fieldName + "\" غير موجود في HEADERS.Items — " +
      "الكتابة على شيت Items اتوقفت لمنع تلف بيانات صامت. راجع HEADERS.Items في Code_12_Core.js."
    );
  }
  return idx + 1; // 1-based column لـ getRange
}

function _buildItemRow(item, createdAt) {
  var colorsJson = "";
  if (Array.isArray(item.colors)) {
    // الألوان جت من الـ frontend بالصيغة الجديدة [{name,code,hex,image}] أو القديمة [string]
    var normalized = item.colors
      .filter(Boolean)
      .map(function (c) {
        if (typeof c === "object" && c !== null && c.name) {
          return {
            name: String(c.name).trim(),
            code: String(c.code || "").trim(),
            hex: String(c.hex || "").trim(),
            image: String(c.image || "").trim(),
          };
        }
        return { name: String(c).trim(), code: "", hex: "", image: "" };
      })
      .filter(function (c) {
        return c.name;
      });
    colorsJson = normalized.length ? JSON.stringify(normalized) : "";
  } else if (item.colors_json !== undefined && item.colors_json !== null) {
    // fallback: خد colors_json مباشرة (بعد normalize)
    var normalizedFallback = _normalizeColors(item.colors_json);
    colorsJson = normalizedFallback.length
      ? JSON.stringify(normalizedFallback)
      : "";
  }
  return [
    item.id.trim(),
    (item.code || "").trim(),
    item.name.trim(),
    (item.description || "").trim(),
    item.group || "",
    item.unit || "",
    Number(item.min_qty || 0),
    item.image_url || "",
    Number(item.costPrice || item.cost_price || 0),
    Number(item.sellingPrice || item.selling_price || 0),
    createdAt,
    colorsJson,
  ];
}

// [ITEM-MASTER-P1] بناء صف الحقول الـ16 الجديدة الخاصة بتبويب General —
// منفصلة تمامًا عن _buildItemRow (الـ12 عمود القديمة) حتى لا نغيّر سلوك
// الكتابة الحالي إطلاقًا. هذه الأعمدة فعليًا تقع في الشيت بعد عمودي
// deleted_at/deleted_by (أي تبدأ من العمود 15) — راجع HEADERS.Items.
function _buildItemExtraFieldsRow(item) {
  return [
    (item.name_en || "").trim(),
    (item.short_name || "").trim(),
    (item.barcode || "").trim(),
    item.item_type || "",
    item.status || "active",
    item.company_id || "",
    item.branch_id || "",
    item.category_main || "",
    item.category_sub || "",
    (item.brand || "").trim(),
    (item.model || "").trim(),
    (item.season || "").trim(),
    (item.country_of_origin || "").trim(),
    item.default_supplier || "",
    (item.tags || "").trim(),
    (item.notes || "").trim(),
  ];
}

// [ITEM-MASTER-P2] بناء صف حقول "الوحدات والمقاسات" الـ8 الجديدة — منفصلة
// عن _buildItemExtraFieldsRow (P1) وعن _buildItemRow (الأصلية)، بنفس فلسفة
// الفصل: كل مرحلة بتكتب في نطاق أعمدة خاص بيها فقط.
function _buildItemUnitsFieldsRow(item) {
  var extraUnits = Array.isArray(item.extra_units)
    ? item.extra_units.filter(function (u) {
        return u && u.unit;
      })
    : [];
  var sizes = Array.isArray(item.sizes)
    ? item.sizes.filter(Boolean)
    : String(item.sizes_text || "")
        .split(",")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
  return [
    extraUnits.length ? JSON.stringify(extraUnits) : "",
    Number(item.min_sale_qty || 0),
    Number(item.min_purchase_qty || 0),
    Number(item.length_cm || 0),
    Number(item.width_cm || 0),
    Number(item.height_cm || 0),
    Number(item.weight_kg || 0),
    sizes.length ? JSON.stringify(sizes) : "",
  ];
}

// [ITEM-MASTER-P3] بناء صف حقول "المخزون" الـ11 الجديدة (سياسة/إعدادات فقط —
// لا علاقة لها بحركات المخزون الفعلية في شيتي Stock/Transactions). منفصلة
// عن كل الدوال السابقة بنفس فلسفة الفصل بين المراحل.
function _buildItemInventoryFieldsRow(item) {
  return [
    item.tracking_type || "normal",
    Number(item.shelf_life_days || 0),
    Number(item.reorder_point || 0),
    Number(item.max_qty || 0),
    Number(item.safety_stock || 0),
    Number(item.lead_time_days || 0),
    item.valuation_method || "average",
    item.default_warehouse_id || "",
    "", // shelf - حقل ملغى من الواجهة (تم إبقاء العمود فارغًا للحفاظ على ترتيب الأعمدة)
    "", // bin - حقل ملغى من الواجهة
    "", // rack - حقل ملغى من الواجهة
  ];
}


// [ITEM-MASTER-P4] بناء صف حقول "المشتريات" الـ5 الجديدة. default_supplier
// نفسه عمود قديم من P1 (تبويب General) — بيتعرض دلوقتي في تبويب Purchasing
// بس مش عمود جديد، فمش موجود هنا. لاحظ: "آخر سعر شراء/أفضل مورد" في
// المواصفات الأصلية مش أعمدة تُخزَّن هنا — دي قيم مُشتقة من حركات الشراء
// الفعلية (PurchaseOrders) وبتُعرض في الواجهة كقراءة فقط من cost_price/سجل
// المشتريات، بدل ما تتكرر كبيانات ثابتة ممكن تتقادم.
function _buildItemPurchasingFieldsRow(item) {
  return [
    Number(item.moq || 0),
    (item.purchase_currency || "").trim(),
    item.order_policy || "reorder_point",
    (item.supplier_item_code || "").trim(),
    (item.catalog_number || "").trim(),
  ];
}

// [ITEM-MASTER-P4] بناء صف حقول "المبيعات" الـ5 الجديدة. سعر البيع الأساسي
// نفسه عمود قديم (selling_price) — يُدار من تبويب General زي ما هو. قوائم
// الأسعار/الخصومات متعددة المستويات تحتاج شيت PriceLists مستقل (غير موجود
// في المشروع حاليًا) فهي خارج نطاق P4 — سيتم تناولها في مرحلة تالية لو
// طُلبت.
function _buildItemSalesFieldsRow(item) {
  return [
    Number(item.tax_rate || 0),
    item.price_includes_tax ? "true" : "false",
    Number(item.min_margin_percent || 0),
    Number(item.max_discount_percent || 0),
    Number(item.commission_percent || 0),
  ];
}

// [ITEM-MASTER-P4] بناء صف حقول "الحسابات" الـ10 الجديدة — تخزّن id الحساب
// من ChartOfAccounts (أو id مركز التكلفة من CostCenters). القيمة الفاضية
// تعني "وراثة الحساب الافتراضي من إعدادات الترحيل" (PostingConfig) بدل
// تكرار رقم الحساب على كل صنف — هذا هو نمط "الوراثة القابلة للتعديل"
// المطلوب في المواصفات، بس مطبّق فوق PostingConfig مباشرة (المرجع الوحيد
// لأرقام الحسابات في النظام كله) بدل شيت Groups، لأن Groups نفسه لا يحمل
// حاليًا أي أعمدة محاسبية فعلية.
function _buildItemAccountingFieldsRow(item) {
  return [
    item.inventory_account_id || "",
    item.cogs_account_id || "",
    item.sales_account_id || "",
    item.purchase_account_id || "",
    item.sales_return_account_id || "",
    item.purchase_return_account_id || "",
    item.inventory_adjustment_account_id || "",
    item.price_difference_account_id || "",
    item.cost_center_id || "",
    item.profit_center_id || "",
  ];
}

// [ITEM-MASTER-P5] بناء صف حقول "التصنيع" الـ4 الجديدة — إعدادات/سياسة
// فقط. قائمة المكونات (BOM) الفعلية بتُدار بالكامل عبر addBOM/updateBOM/
// getBOMs/getBOMLines الموجودين بالفعل في هذا الملف (لا تكرار لمنطقهم هنا)
// — تبويب Manufacturing في شاشة الصنف بيستدعيهم مباشرة من الواجهة.
function _buildItemManufacturingFieldsRow(item) {
  return [
    item.is_manufactured ? "true" : "false",
    item.default_routing_id || "",
    Number(item.manufacturing_waste_percent || 0),
    Number(item.operation_cost || 0),
  ];
}

// [ITEM-MASTER-P5] بناء صف حقول "الجودة" الـ3 الجديدة. لا يوجد حاليًا
// موديول Checklists/Certificates كامل (شيت QualityTemplates معرّف في
// السكيمة بس بدون أي دوال getter/CRUD خلفه)، فالحقول هنا سياسة بسيطة على
// مستوى الصنف بدل الربط بشيء غير مُنفَّذ فعليًا.
function _buildItemQualityFieldsRow(item) {
  return [
    item.requires_qc ? "true" : "false",
    (item.certificates_required || "").trim(),
    (item.qc_notes || "").trim(),
  ];
}

// [ITEM-MASTER-P6] بناء صف حقول "المتجر الإلكتروني" الـ4 الجديدة —
// SEO أساسي + معرض صور إضافي. gallery مخزّنة كـ JSON بنفس فلسفة
// colors_json/extra_units_json (قائمة متغيرة الطول).
function _buildItemEcommerceFieldsRow(item) {
  var gallery = Array.isArray(item.gallery)
    ? item.gallery
        .map(function (u) {
          return String(u || "").trim();
        })
        .filter(Boolean)
    : [];
  return [
    (item.meta_title || "").trim(),
    (item.meta_description || "").trim(),
    (item.slug || "").trim(),
    JSON.stringify(gallery),
  ];
}

// [ITEM-MASTER-P6] بناء صف حقول "المستندات" — قائمة مرفقات (اسم/رابط/نوع)
// مخزّنة كـ JSON واحد، بنفس فلسفة gallery_json أعلاه.
function _buildItemDocumentsFieldsRow(item) {
  var docs = Array.isArray(item.documents)
    ? item.documents
        .filter(function (d) {
          return d && (d.url || "").trim();
        })
        .map(function (d) {
          return {
            name: String(d.name || "").trim(),
            url: String(d.url || "").trim(),
            type: String(d.type || "").trim(),
          };
        })
    : [];
  return [JSON.stringify(docs)];
}

// [BUNDLE-COMPONENTS-2026-08-05] بناء صف عمود "مكونات المجموعة" — قائمة
// (صنف/كمية) مخزّنة كـ JSON واحد، بنفس فلسفة documents_json فوق. بتتقرا
// وقت البيع (Code_20c_Invoices.js: _createInvoiceStockMovements و
// _autoJournalCOGS) لتفكيك بيع صنف الـ bundle لحركات/تكلفة مكوناته.
function _buildItemBundleFieldsRow(item) {
  var comps = Array.isArray(item.bundle_components)
    ? item.bundle_components
        .filter(function (c) {
          return c && c.item_id && Number(c.qty || 0) > 0;
        })
        .map(function (c) {
          return {
            item_id: String(c.item_id || "").trim(),
            qty: Number(c.qty || 0),
          };
        })
    : [];
  return [JSON.stringify(comps)];
}

// [ITEM-MASTER-P2] توليد/تحديث مصفوفة Variants (لون × مقاس) تلقائيًا —
// بنمط "Delete then Re-insert" (نفس فلسفة BOMLines/JournalEntryLines
// الموجودة بالفعل في النظام) حتى لا تتراكم صفوف قديمة عند كل حفظ.
// لا تُستدعى إلا لو الصنف عنده ألوان ومقاسات معًا (حسب نص المواصفات).
function _syncItemVariants(itemId, colors, sizes) {
  try {
    if (!itemId || !Array.isArray(colors) || !colors.length) return;
    if (!Array.isArray(sizes) || !sizes.length) return;

    var sheet = getSheet("ItemVariants");
    var allRows = getSheetData("ItemVariants");
    // امسح الصفوف القديمة الخاصة بهذا الصنف (soft — نعلّم deleted_at)
    // [PERF-FIX] نفس القيمة (now) لكل الصفوف المتأثرة، فبنجمعها في
    // getRangeList بدل نداء getRange/setValues منفصل لكل صف.
    var now = new Date();
    var deletedCellsH = allRows
      .filter(function (r) {
        return String(r.item_id) === String(itemId) && !r.deleted_at;
      })
      .map(function (r) {
        return "H" + r._row; // العمود 8 = deleted_at
      });
    if (deletedCellsH.length) {
      sheet.getRangeList(deletedCellsH).setValue(now);
    }

    var newRows = [];
    colors.forEach(function (c) {
      var cName = typeof c === "object" ? c.name : c;
      var cCode = typeof c === "object" ? c.code || "" : "";
      if (!cName) return;
      sizes.forEach(function (sz) {
        if (!sz) return;
        newRows.push([
          makeId("VAR"),
          itemId,
          String(cName).trim(),
          String(cCode).trim(),
          String(sz).trim(),
          "", // barcode يُملأ لاحقًا يدويًا أو من تبويب Units (خارج نطاق P2)
          now,
          "",
        ]);
      });
    });
    if (newRows.length) appendRowsBatch("ItemVariants", newRows, HEADERS.ItemVariants);
  } catch (e) {
    console.error("_syncItemVariants:", e.message);
  }
}


// [ITEM-WAREHOUSES-LINK] يقرأ كل المخازن المرتبطة حاليًا بصنف معيّن من جدول
// الربط ItemWarehouses (بدون السجلات المحذوفة ناعمًا عبر deleted_at).
// تُستخدم عند فتح شاشة التعديل لتحديد الـ checkboxes تلقائيًا.
function getItemWarehouseIds(itemId) {
  if (!itemId) return [];
  var rows = getSheetData("ItemWarehouses");
  return rows
    .filter(function (r) {
      return (
        String(r.item_id) === String(itemId) &&
        !r.deleted_at &&
        r.is_active !== false &&
        r.is_active !== "false"
      );
    })
    .map(function (r) {
      return String(r.warehouse_id);
    });
}

// [ITEM-WAREHOUSES-LINK] يزامن جدول الربط ItemWarehouses مع قائمة معرّفات
// المخازن القادمة من الواجهة، بنفس فلسفة _syncItemVariants (Delete-soft
// then Re-insert) — بدون بيانات يتيمة وبدون تكرار لنفس المخزن على نفس
// الصنف. لا تُنشئ منطق حفظ خاص بالشاشة: تُستدعى فقط من داخل
// _itemCreateHandler/_itemUpdateHandler، أي من نفس "محرك الحفظ" الموحّد
// (ServiceLayer.execute) المستخدم لكل عمليات الصنف.
function _syncItemWarehouses(itemId, warehouseIds) {
  try {
    if (!itemId) return;
    var ids = Array.isArray(warehouseIds) ? warehouseIds : [];
    // إزالة التكرار وأي قيم فاضية
    var uniqueIds = [];
    ids.forEach(function (id) {
      var v = String(id || "").trim();
      if (v && uniqueIds.indexOf(v) === -1) uniqueIds.push(v);
    });

    var sheet = getSheet("ItemWarehouses", HEADERS.ItemWarehouses);
    var allRows = getSheetData("ItemWarehouses");
    var now = new Date();
    var deletedAtCol = HEADERS.ItemWarehouses.indexOf("deleted_at") + 1;

    // امسح (soft) كل روابط الصنف القديمة — نعيد بناء العلاقة بالكامل من
    // القائمة الجديدة، بنفس نمط _syncItemVariants، فلا تبقى بيانات يتيمة.
    // [PERF-FIX] getRangeList بدل نداء منفصل لكل صف (نفس القيمة now للكل).
    var deletedAtColLetter = _colToA1Letter(deletedAtCol);
    var deletedLinkCells = allRows
      .filter(function (r) {
        return String(r.item_id) === String(itemId) && !r.deleted_at;
      })
      .map(function (r) {
        return deletedAtColLetter + r._row;
      });
    if (deletedLinkCells.length) {
      sheet.getRangeList(deletedLinkCells).setValue(now);
    }

    var newRows = uniqueIds.map(function (whId) {
      return [
        makeId("IWH"),
        itemId,
        whId,
        true, // is_active
        0, // min_qty
        0, // max_qty
        0, // reorder_point
        "", // bin_location
        "", // notes
        now, // created_at
        now, // updated_at
        "", // deleted_at
      ];
    });
    if (newRows.length)
      appendRowsBatch("ItemWarehouses", newRows, HEADERS.ItemWarehouses);
  } catch (e) {
    console.error("_syncItemWarehouses:", e.message);
  }
}

// [SL-MIGRATION] منطق الكتابة الخام فقط (بدون صلاحية/قواعد عمل/تدقيق/كاش —
// هذه الأربعة أصبحت مسؤولية ServiceLayer.execute بشكل موحّد). نفس السطور
// الحرفية التي كانت داخل addItem سابقًا، فقط بدون التكرار.
function _itemCreateHandler(item /*, context */) {
  var existingIds = getSheetData("Items").map(function (it) {
    return String(it.id || "");
  });
  var newId;
  var attempts = 0;
  do {
    newId = makeId("ITM");
    attempts++;
  } while (existingIds.indexOf(newId) !== -1 && attempts < 10);

  item.id = newId;

  var _itemsSheet = getSheet("Items");
  // [PERF-FIX] استخدام رقم الصف المُرجع مباشرة من _appendRowProtected بدل
  // إعادة قراءة شيت Items بالكامل مرة ثانية (findRow(getSheetData(...)))
  // فقط لإيجاد الصف اللي اتكتب للتو — كانت هذه القراءة الثانية غير ضرورية
  // ومكلفة مع آلاف الأصناف.
  var _insertedRow = _appendRowProtected(
    _itemsSheet,
    HEADERS.Items,
    _buildItemRow(item, new Date()),
  );

  // [ITEM-MASTER-P1] كتابة أعمدة تبويب General الجديدة (15..30) بشكل منفصل
  // عن الـ12 عمود القديمة أعلاه — لا تعدّل عرض الصف المكتوب سابقًا إطلاقًا.
  try {
    if (_insertedRow) {
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("name_en"), 1, 16)
        .setValues([_buildItemExtraFieldsRow(item)]);
      // [ITEM-MASTER-P2] أعمدة الوحدات والمقاسات (31..38)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("extra_units_json"), 1, 8)
        .setValues([_buildItemUnitsFieldsRow(item)]);
      // [ITEM-MASTER-P3] أعمدة سياسة المخزون (39..49)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("tracking_type"), 1, 11)
        .setValues([_buildItemInventoryFieldsRow(item)]);
      // [ITEM-MASTER-P4] أعمدة المشتريات (50..54)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("moq"), 1, 5)
        .setValues([_buildItemPurchasingFieldsRow(item)]);
      // [ITEM-MASTER-P4] أعمدة المبيعات (55..59)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("tax_rate"), 1, 5)
        .setValues([_buildItemSalesFieldsRow(item)]);
      // [ITEM-MASTER-P4] أعمدة الحسابات (60..69)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("inventory_account_id"), 1, 10)
        .setValues([_buildItemAccountingFieldsRow(item)]);
      // [ITEM-MASTER-P5] أعمدة التصنيع (70..73)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("is_manufactured"), 1, 4)
        .setValues([_buildItemManufacturingFieldsRow(item)]);
      // [ITEM-MASTER-P5] أعمدة الجودة (74..76)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("requires_qc"), 1, 3)
        .setValues([_buildItemQualityFieldsRow(item)]);
      // [ITEM-MASTER-P6] أعمدة المتجر الإلكتروني (77..80)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("meta_title"), 1, 4)
        .setValues([_buildItemEcommerceFieldsRow(item)]);
      // [ITEM-MASTER-P6] أعمدة المستندات (81)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("documents_json"), 1, 1)
        .setValues([_buildItemDocumentsFieldsRow(item)]);
      // [BUNDLE-COMPONENTS-2026-08-05] عمود مكونات المجموعة (82)
      getSheet("Items")
        .getRange(_insertedRow, _itemColStart("bundle_components_json"), 1, 1)
        .setValues([_buildItemBundleFieldsRow(item)]);
    }
  } catch (extraErr) {
    console.error("_itemCreateHandler extra fields:", extraErr.message);
  }

  // [ITEM-MASTER-P2] توليد مصفوفة Variants لو فيه ألوان + مقاسات معًا
  try {
    var _sizesForVariants = Array.isArray(item.sizes)
      ? item.sizes
      : String(item.sizes_text || "")
          .split(",")
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean);
    _syncItemVariants(newId, item.colors, _sizesForVariants);
  } catch (varErr) {
    console.error("_itemCreateHandler variants sync:", varErr.message);
  }

  // [ITEM-WAREHOUSES-LINK] مزامنة روابط المخازن المتعددة (checkboxes) —
  // item.warehouse_ids = مصفوفة ids قادمة من الواجهة. لو "كل المخازن"
  // كانت مفعّلة، الواجهة ترسل كل الـ ids فعليًا (بدون تخزين نص "كل
  // المخازن" في أي مكان، حسب المطلوب).
  try {
    _syncItemWarehouses(newId, item.warehouse_ids);
  } catch (whErr) {
    console.error("_itemCreateHandler warehouses sync:", whErr.message);
  }

  return {
    success: true,
    data: { generatedId: newId },
    message: " تم إضافة الصنف بنجاح",
  };
}

// [SL-REGISTER] تسجيل عملية إنشاء الصنف في ServiceLayer — الصلاحية وفحص
// قواعد العمل (تكرار الكود/الباركود/السعر السالب) ينفَّذان الآن من داخل
// ServiceLayer.execute بدل التكرار المحلي هنا.
ServiceLayer.register("item", "create", {
  permissionAction: "addItem",
  breCheck: function (payload) {
    return BusinessRulesEngine.validateBeforeSave("item", payload);
  },
  handler: _itemCreateHandler,
  auditAction: "ADD_ITEM",
  table: "Items",
  auditDetails: function (payload, result) {
    return (
      "إضافة صنف: " +
      payload.name +
      " | كود: " +
      (payload.code || (result.data && result.data.generatedId))
    );
  },
});

// [DOC-ENGINE] رفع صورة/مستند صنف عبر DocumentEngine — بيرفع فعليًا على
// Drive جوه فولدر الصنف (المخزون/[كود]-[اسم]/الصور أو المستندات) بدل
// الاعتماد على رابط نصي حر فقط. الحقل i-img في الواجهة بيتملأ تلقائيًا
// بالرابط الراجع من هنا (اللصق اليدوي لسه شغال كـ fallback).
function uploadItemImage(base64Data, fileName, mimeType, itemId, context) {
  try {
    context = context || {};
    if (context.callerUser) {
      var permErr = _checkPermission(
        context.callerUser,
        itemId ? "updateItem" : "addItem",
        context.sessionToken,
      );
      if (permErr)
        return JSON.stringify({ success: false, error: permErr.message });
    }
    var result = DocumentEngine.uploadItemFile(base64Data, fileName, mimeType, {
      itemId: itemId || "NEW-" + Date.now(),
      code: context.code || "",
      name: context.name || "",
      docType: context.docType || "image",
      uploadedBy: context.callerUser || "",
      compress: context.compress || null, // [PHASE-3] Opt-in — {enabled, provider} من الواجهة
    });
    return JSON.stringify(result);
  } catch (e) {
    console.error("uploadItemImage Error:", e);
    return JSON.stringify({
      success: false,
      error: "فشل رفع الملف — حاول مرة أخرى",
    });
  }
}

// ── _getLastItemCode ─────────────────────────────────────────────────────
// [AUTO-NUMBER-CENTRAL][PERF] بيرجع كود آخر صف موجود فعليًا في شيت
// "Items" بس — مش كل الأكواد. قراءة واحدة (getRange لخلية واحدة) بدل
// getSheetData() اللي بتحمّل الشيت كله في الميموري، وده فرق مهم مع شاشة
// الأصناف تحديدًا لأنها ممكن توصل لآلاف الصفوف.
function _getLastItemCode() {
  var sheet = getSheet("Items");
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return ""; // مفيش صفوف بيانات لسه (صف 1 = الهيدر)
  var codeCol = HEADERS.Items.indexOf("code") + 1; // 1-based
  return sheet.getRange(lastRow, codeCol, 1, 1).getValue();
}

// ── getNextItemCode ──────────────────────────────────────────────────────
// [AUTO-CODE] نسخة قابلة للاستدعاء من الواجهة (google.script.run) لعرض
// الكود التسلسلي التالي فور فتح مودال/شاشة "صنف جديد" — نفس مبدأ
// getNextWarehouseCode لكن بالنسخة السريعة (previewFromLast) لأن شيت
// الأصناف أكبر بكتير من الخزائن.
function getNextItemCode() {
  return okResponse("", {
    data: AutoNumberService.previewFromLast(_getLastItemCode()),
  });
}

// [INV-SETTINGS-WIRE-2026-08-08] يطبّق كل الإعدادات الافتراضية الخاصة
// بإنشاء صنف جديد (item_default_*) على الـ payload *قبل* الحفظ — فقط
// للحقول اللي المستخدم سابها فاضية، عشان القيمة الصريحة من الواجهة
// تفضل لها الأولوية دايمًا. كانت الإعدادات دي محفوظة في
// InventorySettingsEngine بدون أي قراءة فعلية (Dead Settings).
function _applyItemCreationDefaults(item) {
  var s;
  try {
    s = InventorySettingsEngine.getAll();
  } catch (eSet) {
    return item; // لو الإعدادات مش متاحة لأي سبب، سيب الصنف زي ما هو (fail-open على المستوى ده فقط، مفيش قرار مالي هنا)
  }

  if (item.min_qty === undefined || item.min_qty === null || item.min_qty === "")
    item.min_qty = s.item_default_min_qty;
  if (item.max_qty === undefined || item.max_qty === null || item.max_qty === "")
    item.max_qty = s.item_default_max_qty;
  if (!item.valuation_method) item.valuation_method = s.item_default_valuation_method;
  if (!item.item_type) item.item_type = s.item_default_inventory_type;
  if (!item.unit) item.unit = s.item_default_unit;
  if (item.shelf_life_days === undefined || item.shelf_life_days === null || item.shelf_life_days === "")
    item.shelf_life_days = s.item_expiry_alert_days;
  if (item.price_includes_tax === undefined) item.price_includes_tax = s.item_price_includes_tax;

  // [INV-SETTINGS-AUDIT-NOTE-2026-08-08] item_tax_handling / item_tax_rate_sales /
  // item_tax_rate_purchases / item_discount_tax_handling / item_discount_tax_account /
  // item_discount_tax_rate — قصدًا متطبّقتش هنا. مفيش أعمدة لها في شيت Items
  // إطلاقًا (لا في _buildItemRow ولا أي من _buildItemExtraFieldsRow/
  // _buildItemUnitsFieldsRow/_buildItemInventoryFieldsRow/_buildItemPurchasingFieldsRow).
  // لو ضفتها هنا هتتحط على object في الذاكرة وتتمسح بصمت عند الحفظ —
  // فيبان إنها اتصلحت وهي لسه Dead فعليًا. دي محتاجة قرار Schema (إضافة
  // أعمدة جديدة في شيت Items + تحديث كل الـ row builders) قبل أي ربط.
  // متروكة في القائمة النهائية تحت "Missing Logic".

  return item;
}

function addItem(item) {
  try {
    // [VALIDATION-ENGINE-MIGRATION] فحص الحقل الأساسي فقط هنا — باقي قواعد
    // العمل (تكرار الكود/الباركود/السعر السالب) مسؤولية BusinessRulesEngine
    // عبر ServiceLayer.execute (breCheck) تحت، مفيش داعي لتكرارها هنا.
    if (!ValidationEngine.isRequired(item.name))
      return errResponse("اسم الصنف مطلوب");

    item = _applyItemCreationDefaults(item);

    // [INV-SETTINGS-WIRE-2026-08-08] item_code_generation_method — لو
    // الإعداد "manual" لازم المستخدم يبعت كود صريح، من غير توليد تلقائي.
    // كان الإعداد ده محفوظ بس متجاهَل تمامًا (auto-generate دايمًا بغض
    // النظر عن قيمته).
    var codeGenMethod;
    try {
      codeGenMethod = InventorySettingsEngine.get("item_code_generation_method");
    } catch (eGen) {
      codeGenMethod = "auto_increment";
    }
    if (codeGenMethod === "manual") {
      if (!item.code || !String(item.code).trim())
        return errResponse("كود الصنف مطلوب — إعداد ترقيم الأصناف مضبوط على إدخال يدوي");
    } else if (!item.code || !String(item.code).trim()) {
      // [AUTO-NUMBER-CENTRAL] كود الصنف لو وصل فاضي من الواجهة، بيتولّد
      // تلقائي تسلسلي (1، 2، 3...) *قبل* ما نبعت الـ payload لـ
      // ServiceLayer.execute — لازم يحصل هنا بالظبط قبل breCheck، عشان فحص
      // تكرار الكود (ItemRules.isDuplicateCode) يتحقق من الكود المولّد نفسه
      // مش من قيمة فاضية.
      // [INV-SETTINGS-WIRE-2026-08-08] Prefix/digits الجدد بييجوا من
      // numbering.items بدل ما يفضلوا كانوا متجاهَلين بالكامل.
      var lastCode = _getLastItemCode();
      if (!lastCode) {
        try {
          var numCfg = InventorySettingsEngine.get("numbering").items;
          item.code = AutoNumberService.previewFromLast("", {
            prefix: numCfg.prefix,
            padding: numCfg.digits,
          });
        } catch (eNum) {
          item.code = AutoNumberService.previewFromLast(lastCode);
        }
      } else {
        item.code = AutoNumberService.previewFromLast(lastCode);
      }
    }

    // [INV-SETTINGS-WIRE-2026-08-08] الباركود — auto_generate يولّد لو
    // فاضي، prevent_duplicate يمنع الحفظ لو نفس الباركود مستخدم لصنف تاني.
    // الإعدادين دول كانوا محفوظين بدون أي تأثير فعلي.
    try {
      var s2 = InventorySettingsEngine.getAll();
      if (s2.barcode_auto_generate && (!item.barcode || !String(item.barcode).trim())) {
        item.barcode = "BC" + new Date().getTime();
      }
      if (s2.barcode_prevent_duplicate && item.barcode && String(item.barcode).trim()) {
        var dupBarcode = getSheetData("Items").find(function (it) {
          return (
            String(it.barcode || "").trim() === String(item.barcode).trim() &&
            !it.deleted_at
          );
        });
        if (dupBarcode) return errResponse("الباركود مستخدم بالفعل لصنف آخر");
      }
    } catch (eBc) {
      // لو الإعدادات مش متاحة، منمنعش إنشاء الصنف بسبب فحص ثانوي
    }

    var r = ServiceLayer.execute({
      entityType: "item",
      action: "create",
      payload: item,
      context: { username: item.user, sessionToken: item.sessionToken },
    });
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// [SL-MIGRATION] منطق الكتابة الخام فقط — نفس فلسفة _itemCreateHandler أعلاه.
// الصلاحية + BusinessRulesEngine + Audit + Cache أصبحوا مسؤولية ServiceLayer.execute.
function _itemUpdateHandler(item, context) {
  const row = findRow(getSheetData("Items"), "id", item.id);
  if (!row) return { success: false, message: "الصنف غير موجود" };

  // [INV-SETTINGS-WIRE-2026-08-08] restrict_qty_edit / restrict_cost_edit /
  // restrict_valuation_edit — كانت محفوظة في InventorySettingsEngine بدون
  // أي إنفاذ فعلي (أي مستخدم عنده صلاحية "editItem" العامة كان يقدر يعدّل
  // الكمية/التكلفة/سياسة التقييم بغض النظر عن الإعداد). الإنفاذ هنا:
  // لو الإعداد مفعّل، الحقول دي محجوزة على admin بس — أي مستخدم تاني
  // بيتم تجاهل قيمته الجديدة للحقل ده بصمت والاحتفاظ بالقيمة القديمة
  // (مش رفض كل التعديل، عشان باقي حقول الصنف تفضل قابلة للتعديل عادي).
  try {
    var _invS = InventorySettingsEngine.getAll();
    var _editorRole = context && context.username ? _getUserRole(context.username) : "";
    var _isAdminEditor = String(_editorRole || "").toLowerCase() === "admin";
    if (!_isAdminEditor) {
      if (_invS.restrict_qty_edit && item.min_qty !== undefined) {
        item.min_qty = row.min_qty;
      }
      if (_invS.restrict_cost_edit) {
        item.costPrice = row.cost_price;
        item.cost_price = row.cost_price;
      }
      if (_invS.restrict_valuation_edit && item.valuation_method !== undefined) {
        item.valuation_method = row.valuation_method;
      }
    }
  } catch (eRestrict) {
    // لو الإعدادات مش متاحة، منمنعش التعديل بسبب فحص ثانوي (fail-open هنا فقط)
  }

  // ← v4.1: احفظ الفرق قبل التعديل (يُستخدم في auditDetails/oldValue/newValue)
  var oldValues = {
    name: row.name,
    code: row.code,
    selling_price: row.selling_price,
    cost_price: row.cost_price,
    min_qty: row.min_qty,
    group: row.group,
    unit: row.unit,
  };
  var newValues = {
    name: item.name,
    code: item.code,
    selling_price: item.sellingPrice || item.selling_price,
    cost_price: item.costPrice || item.cost_price,
    min_qty: item.min_qty,
    group: item.group,
    unit: item.unit,
  };
  var diff = _diffObjects(oldValues, newValues);

  getSheet("Items")
    .getRange(row._row, 1, 1, 12)
    .setValues([_buildItemRow(item, row.created_at || new Date())]);

  // [ITEM-MASTER-P1] تحديث أعمدة تبويب General الجديدة (15..30) في نداء
  // منفصل — بيتخطى عمودي deleted_at/deleted_by (13/14) عمداً حتى لا تُمس
  // حالة الأرشفة الفعلية للصنف.
  try {
    getSheet("Items")
      .getRange(row._row, _itemColStart("name_en"), 1, 16)
      .setValues([_buildItemExtraFieldsRow(item)]);
    // [ITEM-MASTER-P2] أعمدة الوحدات والمقاسات (31..38)
    getSheet("Items")
      .getRange(row._row, _itemColStart("extra_units_json"), 1, 8)
      .setValues([_buildItemUnitsFieldsRow(item)]);
    // [ITEM-MASTER-P3] أعمدة سياسة المخزون (39..49)
    getSheet("Items")
      .getRange(row._row, _itemColStart("tracking_type"), 1, 11)
      .setValues([_buildItemInventoryFieldsRow(item)]);
    // [ITEM-MASTER-P4] أعمدة المشتريات (50..54)
    getSheet("Items")
      .getRange(row._row, _itemColStart("moq"), 1, 5)
      .setValues([_buildItemPurchasingFieldsRow(item)]);
    // [ITEM-MASTER-P4] أعمدة المبيعات (55..59)
    getSheet("Items")
      .getRange(row._row, _itemColStart("tax_rate"), 1, 5)
      .setValues([_buildItemSalesFieldsRow(item)]);
    // [ITEM-MASTER-P4] أعمدة الحسابات (60..69)
    getSheet("Items")
      .getRange(row._row, _itemColStart("inventory_account_id"), 1, 10)
      .setValues([_buildItemAccountingFieldsRow(item)]);
    // [ITEM-MASTER-P5] أعمدة التصنيع (70..73)
    getSheet("Items")
      .getRange(row._row, _itemColStart("is_manufactured"), 1, 4)
      .setValues([_buildItemManufacturingFieldsRow(item)]);
    // [ITEM-MASTER-P5] أعمدة الجودة (74..76)
    getSheet("Items")
      .getRange(row._row, _itemColStart("requires_qc"), 1, 3)
      .setValues([_buildItemQualityFieldsRow(item)]);
    // [ITEM-MASTER-P6] أعمدة المتجر الإلكتروني (77..80)
    getSheet("Items")
      .getRange(row._row, _itemColStart("meta_title"), 1, 4)
      .setValues([_buildItemEcommerceFieldsRow(item)]);
    // [ITEM-MASTER-P6] أعمدة المستندات (81)
    getSheet("Items")
      .getRange(row._row, _itemColStart("documents_json"), 1, 1)
      .setValues([_buildItemDocumentsFieldsRow(item)]);
    // [BUNDLE-COMPONENTS-2026-08-05] عمود مكونات المجموعة (82)
    getSheet("Items")
      .getRange(row._row, _itemColStart("bundle_components_json"), 1, 1)
      .setValues([_buildItemBundleFieldsRow(item)]);
  } catch (extraErr) {
    console.error("_itemUpdateHandler extra fields:", extraErr.message);
  }

  // [ITEM-MASTER-P2] إعادة توليد مصفوفة Variants لو فيه ألوان + مقاسات معًا
  try {
    var _sizesForVariantsUpd = Array.isArray(item.sizes)
      ? item.sizes
      : String(item.sizes_text || "")
          .split(",")
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean);
    _syncItemVariants(item.id, item.colors, _sizesForVariantsUpd);
  } catch (varErr) {
    console.error("_itemUpdateHandler variants sync:", varErr.message);
  }

  // [ITEM-WAREHOUSES-LINK] نفس منطق الحفظ الموحّد أعلاه، عند التعديل.
  try {
    _syncItemWarehouses(item.id, item.warehouse_ids);
  } catch (whErr) {
    console.error("_itemUpdateHandler warehouses sync:", whErr.message);
  }

  return {
    success: true,
    message: " تم تعديل الصنف",
    oldValue: diff.old,
    newValue: diff.new,
  };
}

ServiceLayer.register("item", "update", {
  permissionAction: "updateItem",
  breCheck: function (payload) {
    return BusinessRulesEngine.validateBeforeSave("item", payload);
  },
  handler: _itemUpdateHandler,
  auditAction: "UPDATE_ITEM",
  table: "Items",
  auditDetails: function (payload) {
    return "تعديل صنف: " + (payload.name || payload.id);
  },
});

function updateItem(item) {
  try {
    var r = ServiceLayer.execute({
      entityType: "item",
      action: "update",
      payload: item,
      context: { username: item.user, sessionToken: item.sessionToken },
    });
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * saveItemWithColorSync
 * يحفظ الصنف (إضافة أو تعديل) ويضيف الألوان الجديدة تلقائياً لشيت Colors
 * الفرق عن addItem/updateItem: يفحص كل لون في الصنف — لو مش موجود في Colors يضيفه
 * يُرجع: { success, message, newColors: [{name, code, id}] }
 */
// [P9-FIX] أُضيف callerUser و sessionToken — كانت الدالة تعتمد على أن addItem/updateItem
// محميتان داخلياً، لكن تبقى ثغرة: كود ثابت يستدعي saveItemWithColorSync مباشرة
// يتجاوز _checkPermission لأن item.user في الـ sub-calls هو ما يُفحص، لا الـ wrapper نفسه.
// الإصلاح: فحص مبكر بالـ wrapper يضمن رفض الطلب قبل أي عملية.
function saveItemWithColorSync(item) {
  try {
    // فحص صلاحية مبكر بناءً على نوع العملية (إضافة أو تعديل)
    var syncAction = item._isEdit ? "updateItem" : "addItem";
    var permErr = _checkPermission(
      item.user || item.callerUser,
      syncAction,
      item.sessionToken || item.token,
    );
    if (permErr) return permErr;

    // ── 1. حفظ الصنف (إضافة أو تعديل) ──────────────────────
    var isEdit = !!item._isEdit;
    var saveResult = isEdit ? updateItem(item) : addItem(item);
    if (!saveResult.success) return saveResult;

    // لو إضافة جديدة: استخدم الـ ID المولّد تلقائياً في باقي العمليات
    if (!isEdit && saveResult.generatedId) {
      item.id = saveResult.generatedId;
    }
    if (!saveResult.success) return saveResult;

    // ── 2. اكتشاف الألوان الجديدة وإضافتها ──────────────────
    var colors = Array.isArray(item.colors) ? item.colors : [];
    if (!colors.length) return Object.assign(saveResult, { newColors: [] });

    var existingColors = _readColorsRaw();
    // فهرسة الألوان الموجودة: name (normalized) + code
    var existingNames = existingColors.map(function (c) {
      return _normalizeColorName(c.name);
    });
    var existingCodes = existingColors.map(function (c) {
      return String(c.code || "")
        .trim()
        .toUpperCase();
    });

    var newColors = [];
    colors.forEach(function (c) {
      var name = String(c.name || "").trim();
      var code = String(c.code || "")
        .trim()
        .toUpperCase();
      if (!name) return;

      var normName = _normalizeColorName(name);
      // لو الاسم أو الكود موجود → تجاهل
      if (existingNames.indexOf(normName) !== -1) return;
      if (code && existingCodes.indexOf(code) !== -1) return;

      // ولّد كود لو مش موجود
      if (!code) code = _resolveColorCodeBackend(name);
      // تأكد إن الكود مش مكرر بعد التوليد
      if (existingCodes.indexOf(code) !== -1) {
        // أضف suffix مميز
        code = code + String(Math.floor(Math.random() * 90 + 10));
      }

      var colorId = makeId("CLR");
      _appendRowProtected(getSheet("Colors"), HEADERS.Colors, [
        colorId,
        name,
        code,
        c.hex || "",
        "أضيف تلقائياً من الصنف",
        new Date(),
      ]);
      newColors.push({ id: colorId, name: name, code: code });
      // حدّث الفهارس المحلية لتفادي التكرار في نفس الدفعة
      existingNames.push(normName);
      existingCodes.push(code);
    });

    return Object.assign(saveResult, {
      newColors: newColors,
      message:
        saveResult.message +
        (newColors.length
          ? " — تم تعريف " + newColors.length + " لون جديد تلقائياً"
          : ""),
    });
  } catch (e) {
    return errResponse("خطأ في الحفظ: " + e.message);
  }
}

/**
 * deleteItem — v4.1: Soft Delete بدل الحذف الفعلي
 * يُضيف deleted_at + deleted_by بدل حذف الصف
 * استخدم forceDeleteItem() للحذف النهائي (admin فقط)
 */
// [SL-MIGRATION] منطق الكتابة الخام فقط (Soft Delete) — نفس فلسفة
// _itemCreateHandler/_itemUpdateHandler أعلاه. فحص الرصيد نُقل بالكامل إلى
// BusinessRulesEngine.rules.Item.hasStockBalance عبر validateBeforeDelete
// (كان مكررًا هنا محليًا رغم وجوده أصلاً في المحرك).
function _itemDeleteHandler(payload, context) {
  const allItems = getSheetData("Items");
  const row = findRow(allItems, "id", payload.id);
  if (!row) return { success: false, message: "الصنف غير موجود" };

  var user = (context && context.username) || "SYSTEM";

  // ← v4.1: Soft Delete — اكتب في عمودَي deleted_at / deleted_by
  var sheet = getSheet("Items");
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var delAtCol = headers.indexOf("deleted_at") + 1;
  var delByCol = headers.indexOf("deleted_by") + 1;
  if (delAtCol) sheet.getRange(row._row, delAtCol).setValue(new Date());
  if (delByCol) sheet.getRange(row._row, delByCol).setValue(user);

  return {
    success: true,
    message: " تم حذف الصنف (يمكن استعادته من سلة المهملات)",
    oldValue: { name: row.name, code: row.code, status: "active" },
    newValue: { status: "deleted", deleted_by: user },
  };
}

ServiceLayer.register("item", "delete", {
  permissionAction: "deleteItem",
  breCheck: function (payload) {
    return BusinessRulesEngine.validateBeforeDelete("item", payload);
  },
  handler: _itemDeleteHandler,
  auditAction: "SOFT_DELETE_ITEM",
  table: "Items",
  auditDetails: function (payload, result) {
    return (
      "حذف ناعم للصنف: " +
      ((result.oldValue && result.oldValue.name) || payload.id) +
      " — يمكن الاستعادة"
    );
  },
});

function deleteItem(id, user, sessionToken) {
  // [C-01 FIX + ثغرة إضافية] الفحص إلزامي دائماً (لسه محتفظين بيه هنا لأن
  // id وحده لا يكفي بدون user في هذه الدالة تحديدًا).
  if (!user) return errResponse("يجب تسجيل الدخول");
  try {
    // [HARD-DELETE-BY-DEFAULT] بطلب المستخدم: زرار حذف الصنف العادي بقى بيعمل
    // حذف نهائي (hard) مباشرة بدل الـ Soft Delete الافتراضي — يعني الصف
    // بيتمسح فعليًا من الشيت ومفيش رسالة "يمكن استعادته". لو فيه ارتباطات
    // (حركات مخزون/فواتير/BOM...) DeleteEngine هيرفض الحذف برسالة واضحة
    // بدل ما يسيب بيانات يتيمة — نفس فحص forceDeleteItem تمامًا، لكن بدون
    // اشتراط أن يكون المستخدم admin (زي زرار الحذف العادي القديم).
    var r = DeleteEngine.delete("item", id, user, sessionToken, { hard: true });
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/** forceDeleteItem — حذف نهائي لا رجعة فيه (admin فقط) */
function forceDeleteItem(id, callerUser, sessionToken) {
  // [DATALAYER-ENGINE-MIGRATION] قراءة فقط، بدون أي كتابة تالية تعتمد على _row
  var usersRes = DataLayer.getAll("Users");
  var users = usersRes.success ? usersRes.data : [];
  var caller = users.find(function (u) {
    return u.username === callerUser;
  });
  if (!caller || caller.role !== "admin")
    return errResponse("فقط المدير يمكنه الحذف النهائي");
  try {
    // [DELETE-ENGINE-MIGRATION] بدل الحذف المباشر (deleteRow) — DeleteEngine
    // بيعمل الآن فحص Dependencies فعليًا قبل الحذف النهائي (كان مفقود تمامًا
    // في الكود القديم — كان ممكن تتحذف أصناف عليها حركات/فواتير نهائيًا بدون
    // أي تحذير)، وبيؤرشف نسخة كاملة قبل الحذف تحسبًا.
    var r = DeleteEngine.delete("item", id, callerUser, sessionToken, { hard: true });
    if (!r.success) return errResponse(r.message, r.code);
    // [ITEM-WAREHOUSES-LINK] حذف نهائي = لا تترك أي رابط مخزن يتيم خلفه.
    try {
      _syncItemWarehouses(id, []);
    } catch (whErr) {
      console.error("forceDeleteItem warehouses cleanup:", whErr.message);
    }
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/** restoreItem — استعادة صنف محذوف ناعماً */
function restoreItem(id, callerUser, sessionToken) {
  try {
    // [DELETE-ENGINE-MIGRATION] بدل المنطق اليدوي — DeleteEngine.restore
    // بيعمل نفس الحاجة بالظبط + بيحدّث سجل الأرشيف المرتبط.
    var r = DeleteEngine.restore("item", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/** getDeletedItems — جلب الأصناف المحذوفة ناعماً (admin/supervisor) */
function getDeletedItems(callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "deleteItem", sessionToken);
  if (permErr) return permErr;
  try {
    // [DATALAYER-ENGINE-MIGRATION] includeDeleted:true عشان نقدر نجيب
    // العناصر المحذوفة ناعمًا (DataLayer.getAll بيستبعدها افتراضيًا)
    var allRes = DataLayer.getAll("Items", { includeDeleted: true });
    var all = allRes.success ? allRes.data : [];
    var deleted = all.filter(function (it) {
      return it.deleted_at && String(it.deleted_at).trim();
    });
    return { success: true, data: deleted, total: deleted.length };
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §14  Stock  (Balance Management)
//
// getOrCreateStockRow() — يجلب أو يُنشئ صف الرصيد
// updateStockBalance()  — يحدّث الرصيد بعد كل حركة
// ─────────────────────────────────────────────────────────────

function getOrCreateStockRow(item_id, warehouse, color, batchNo, serialNo, stockData) {
  var colorStr = String(color || "").trim();
  // normalize يحل مشكلة أسود/اسود عند البحث
  var colorNorm = _normalizeColorName(colorStr);
  var batchNorm = String(batchNo || "").trim();
  var serialNorm = String(serialNo || "").trim();
  // [PERF-FIX-5] يقبل stockData جاهزة من الخارج لتجنب قراءة Stock مرتين
  var data = stockData || getSheetData("Stock");
  const sheet = getSheet("Stock", HEADERS.Stock);
  const existing = data.find(
    (s) =>
      String(s.item_id) === String(item_id) &&
      s.warehouse === warehouse &&
      _normalizeColorName(s.color) === colorNorm &&
      String(s.batch_no || "").trim() === batchNorm &&
      String(s.serial_no || "").trim() === serialNorm,
  );

  if (existing)
    return {
      sheet,
      sheetRow: existing._row,
      currentQty: Number(existing.quantity || 0),
    };

  // Stock: item_id | warehouse | color | quantity | batch_no | serial_no | expiry_date
  var _stockRow = [item_id, warehouse, colorStr, 0, batchNorm, serialNorm, ""];
  // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
  // _appendRowProtected) — رصيد Stock جديد يُنشأ لكل صنف/مخزن/لون/دفعة/سيريال جديد.
  sheet
    .getRange(sheet.getLastRow() + 1, 1, 1, _stockRow.length)
    .setFontColor(null);
  sheet.appendRow(_stockRow);
  return { sheet, sheetRow: sheet.getLastRow(), currentQty: 0 };
}

function updateStockBalance(tx, stockData) {
  // [PERF-FIX-5] يقبل stockData جاهزة من الخارج لتجنب قراءة Stock مرة ثانية
  const qty = Number(tx.quantity);
  const color = tx.color || "";

  if (tx.type === "IN") {
    const whName = _resolveWhName(tx.to_warehouse || "الرئيسي");
    const res = getOrCreateStockRow(tx.item_id, whName, color, tx.batch_no || "", tx.serial_no || "", stockData);
    res.sheet.getRange(res.sheetRow, 4).setValue(res.currentQty + qty);
    if (tx.expiry_date) res.sheet.getRange(res.sheetRow, 7).setValue(tx.expiry_date);
  } else if (tx.type === "FACTORY_RETURN") {
    // مرتجع من المصنع → يُضاف للمخزن المستهدف (to_warehouse)
    const whName = _resolveWhName(tx.to_warehouse || "الرئيسي");
    const res = getOrCreateStockRow(tx.item_id, whName, color, tx.batch_no || "", tx.serial_no || "", stockData);
    res.sheet.getRange(res.sheetRow, 4).setValue(res.currentQty + qty);
  } else if (tx.type === "OUT") {
    const whName = _resolveWhName(tx.from_warehouse || "الرئيسي");
    const res = getOrCreateStockRow(tx.item_id, whName, color, tx.batch_no || "", tx.serial_no || "", stockData);
    res.sheet
      .getRange(res.sheetRow, 4)
      .setValue(res.currentQty - qty);
  } else if (tx.type === "WASTE") {
    // [WASTE-FEATURE-2026-08-07] هالك/تلف — يُخصم من المستودع المصدر تمامًا
    // زي الصرف (OUT)، لكن بدون أي إيراد أو ذمم عميل (مش بيع).
    const whName = _resolveWhName(tx.from_warehouse || "الرئيسي");
    const res = getOrCreateStockRow(tx.item_id, whName, color, tx.batch_no || "", tx.serial_no || "", stockData);
    res.sheet
      .getRange(res.sheetRow, 4)
      .setValue(res.currentQty - qty);
  } else if (tx.type === "TRANSFER") {
    if (tx.from_warehouse) {
      const fromName = _resolveWhName(tx.from_warehouse);
      const from = getOrCreateStockRow(tx.item_id, fromName, color, tx.batch_no || "", tx.serial_no || "", stockData);
      from.sheet
        .getRange(from.sheetRow, 4)
        .setValue(from.currentQty - qty);
    }
    if (tx.to_warehouse) {
      const toName = _resolveWhName(tx.to_warehouse);
      const to = getOrCreateStockRow(tx.item_id, toName, color, tx.batch_no || "", tx.serial_no || "", stockData);
      to.sheet.getRange(to.sheetRow, 4).setValue(to.currentQty + qty);
    }
  } else if (tx.type === "DISPATCH") {
    // [FIX-ISSUE-006] صرف للمصنع — يُخصم من المستودع المصدر فوراً
    const whName = _resolveWhName(tx.from_warehouse || "الرئيسي");
    const res = getOrCreateStockRow(tx.item_id, whName, color, tx.batch_no || "", tx.serial_no || "", stockData);
    res.sheet
      .getRange(res.sheetRow, 4)
      .setValue(res.currentQty - qty);
  } else if (tx.type === "FG_IN") {
    // [FIX-ISSUE-006] استلام منتج تام من المصنع — يُضاف للمستودع المستهدف
    const whName = _resolveWhName(tx.to_warehouse || "الرئيسي");
    const res = getOrCreateStockRow(tx.item_id, whName, color, tx.batch_no || "", tx.serial_no || "", stockData);
    res.sheet.getRange(res.sheetRow, 4).setValue(res.currentQty + qty);
  }
}

// ─────────────────────────────────────────────────────────────
// §15  Transactions CRUD
//
// _buildTxRow()           — بناء صف الحركة
// _checkOutboundStock()   — التحقق من كفاية الرصيد قبل الصرف
// addTransaction()        — إضافة حركة واحدة
// addBatchTransaction()   — إضافة دفعة من الحركات
// updateTransaction()     — تعديل حركة موجودة
// deleteTransaction()     — حذف حركة وإعادة حساب الرصيد
// reloadStockFromAllTransactions() — إعادة بناء الأرصدة من الصفر
// ─────────────────────────────────────────────────────────────

function _buildTxRow(tx, id, date) {
  return [
    id,
    date,
    tx.type,
    tx.item_id,
    Number(tx.quantity),
    tx.from_warehouse ? _resolveWhName(tx.from_warehouse) : "",
    tx.to_warehouse ? _resolveWhName(tx.to_warehouse) : "",
    tx.notes || "",
    tx.user || "System",
    tx.attachment_url || "",
    tx.color || "",
    tx.ref || "",
    tx.party || "",
    tx.batch_no || "",
    tx.serial_no || "",
    tx.expiry_date || "",
  ];
}

/**
 * يحوّل warehouse id أو name لـ name فقط
 * يحل مشكلة إرسال id من الـ frontend بينما الـ Stock مخزّن بالـ name
 */
function _resolveWhName(idOrName) {
  if (!idOrName) return "";
  var whs = getWarehouses();
  var found = whs.find(function (w) {
    return w.id === idOrName || w.name === idOrName;
  });
  return found ? found.name : idOrName;
}

function _checkOutboundStock(tx, stockData) {
  // [P8-FIX] DISPATCH (صرف للمصنع) كانت مستثناة تماماً من هذا الفحص رغم أنها
  // تخصم من رصيد المخزن تماماً مثل OUT — أي كمية يمكن صرفها للمصنع بصرف النظر
  // عن الرصيد الفعلي، وبما أن updateStockBalance تستخدم Math.max(0, ...) عند
  // الخصم، كانت النتيجة عجزاً حقيقياً يُمحى صامتاً (يظهر الرصيد صفراً بدل رسالة
  // خطأ توضح أن الكمية المطلوبة غير متوفرة فعلياً).
  if (tx.type !== "OUT" && tx.type !== "TRANSFER" && tx.type !== "DISPATCH" && tx.type !== "WASTE")
    return null;

  // اللون إلزامي لأن كل لون رصيد مستقل
  if (!tx.color || !String(tx.color).trim())
    return ` يجب تحديد اللون للصنف "${tx.item_id}" — كل لون رصيده مستقل`;

  const fromWH = _resolveWhName(tx.from_warehouse || "الرئيسي");
  const colorNorm = _normalizeColorName(tx.color);
  // [PERF-FIX-5] يقبل stockData جاهزة من الخارج لتجنب قراءة Stock مرتين في نفس الطلب
  const allStock = stockData || getSheetData("Stock");

  const stockRow = allStock.find(
    (s) =>
      String(s.item_id) === String(tx.item_id) &&
      s.warehouse === fromWH &&
      _normalizeColorName(s.color) === colorNorm,
  );
  const available = stockRow ? Number(stockRow.quantity || 0) : 0;

  var settings = _getCompanySettingsRaw();
  var allowNegative =
    settings.allow_negative_stock === true ||
    settings.allow_negative_stock === "true";

  if (!allowNegative && available < Number(tx.quantity))
    return ` الكمية المطلوبة (${tx.quantity}) أكبر من الرصيد المتاح (${available}) في مستودع "${fromWH}" للون "${tx.color}"`;

  return null;
}

// [TRACKING-SETTINGS-WIRE-2026-08-08] يربط enable_batches/enable_serial_numbers/
// enable_expiry_dates (InventorySettingsEngine) بسلوك فعلي مُلزم في الـ Backend.
// المصدر الحقيقي لنوع تتبع الصنف نفسه هو item.tracking_type (يُشتق من "نوع
// الصنف" وقت إنشائه — normal | batch | serial)، فلو الإعداد العام للنظام
// مقفول، الفحص كله بيتجاوَز حتى لو الصنف متعلّم كـ batch/serial (الإعداد
// العام هو المفتاح الرئيسي).
function _checkTrackingRequirements(tx) {
  // الأنواع اللي بتحرك رصيد فعلي بس — الحركات المحاسبية الصرفة مستثناة
  if (
    tx.type !== "IN" &&
    tx.type !== "OUT" &&
    tx.type !== "TRANSFER" &&
    tx.type !== "DISPATCH" &&
    tx.type !== "FG_IN" &&
    tx.type !== "FACTORY_RETURN" &&
    tx.type !== "WASTE"
  )
    return null;

  var itemRow = findRow(getSheetData("Items"), "id", tx.item_id);
  var trackingType = itemRow ? String(itemRow.tracking_type || "normal") : "normal";
  if (trackingType !== "batch" && trackingType !== "serial") return null;

  var invSettings;
  try {
    invSettings = InventorySettingsEngine.getAll();
  } catch (eSet) {
    invSettings = {};
  }

  if (trackingType === "batch") {
    if (invSettings.enable_batches && !String(tx.batch_no || "").trim())
      return `يجب تحديد رقم الدفعة (Batch) للصنف "${tx.item_id}" — الصنف مُفعّل عليه تتبع الدفعات`;

    if (
      invSettings.enable_expiry_dates &&
      (tx.type === "IN" || tx.type === "FACTORY_RETURN") &&
      !String(tx.expiry_date || "").trim()
    )
      return `يجب تحديد تاريخ الصلاحية عند استلام الصنف "${tx.item_id}" — تتبع الصلاحية مفعّل لهذا الصنف`;

    // [INV-SETTINGS-WIRE-2026-08-08] expiry_min_accept_days — كان الإعداد
    // محفوظ بدون أي فحص فعلي؛ لو مضبوط بعدد أيام > 0، يمنع استلام دفعة
    // باقيلها على الانتهاء أقل من العدد ده (سياسة جودة استلام قياسية).
    if (
      invSettings.enable_expiry_dates &&
      Number(invSettings.expiry_min_accept_days) > 0 &&
      (tx.type === "IN" || tx.type === "FACTORY_RETURN") &&
      String(tx.expiry_date || "").trim()
    ) {
      var _expDateCheck = new Date(tx.expiry_date);
      if (!isNaN(_expDateCheck.getTime())) {
        var _minAcceptDate = new Date();
        _minAcceptDate.setDate(
          _minAcceptDate.getDate() + Number(invSettings.expiry_min_accept_days),
        );
        if (_expDateCheck < _minAcceptDate)
          return `لا يمكن استلام الصنف "${tx.item_id}" — تاريخ الصلاحية أقرب من الحد الأدنى المسموح به (${invSettings.expiry_min_accept_days} يوم من إعدادات المخزون)`;
      }
    }

    // منع الصرف من دفعة منتهية الصلاحية لو الإعداد مفعّل ورقم الدفعة محدد
    if (
      invSettings.enable_expiry_dates &&
      (tx.type === "OUT" || tx.type === "TRANSFER" || tx.type === "DISPATCH") &&
      tx.batch_no
    ) {
      var whForCheck = _resolveWhName(tx.from_warehouse || "الرئيسي");
      var batchStock = getSheetData("Stock").find(
        (s) =>
          String(s.item_id) === String(tx.item_id) &&
          s.warehouse === whForCheck &&
          String(s.batch_no || "").trim() === String(tx.batch_no).trim(),
      );
      if (batchStock && batchStock.expiry_date) {
        var expDate = new Date(batchStock.expiry_date);
        if (!isNaN(expDate.getTime()) && expDate < new Date())
          return `لا يمكن صرف الدفعة "${tx.batch_no}" للصنف "${tx.item_id}" — منتهية الصلاحية بتاريخ ${batchStock.expiry_date}`;
      }
    }
  }

  if (trackingType === "serial") {
    if (invSettings.enable_serial_numbers) {
      if (!String(tx.serial_no || "").trim())
        return `يجب تحديد الرقم التسلسلي (Serial) للصنف "${tx.item_id}" — الصنف مُفعّل عليه تتبع الأرقام التسلسلية`;
      if (Number(tx.quantity) !== 1)
        return `الصنف "${tx.item_id}" مُتتبَّع بالأرقام التسلسلية — يجب أن تكون كمية الحركة 1 بالضبط لكل رقم تسلسلي`;
    }
  }

  return null;
}

function addTransaction(tx) {
  // [SEC-FIX-6] التحقق من الصلاحيات إلزامي — لا يجوز تجاوزه بإرسال tx بدون user
  if (!tx.user) return errResponse("يجب تسجيل الدخول لتسجيل الحركات");
  var permErr = _checkPermission(tx.user, "addTransaction", tx.sessionToken);
  if (permErr) return permErr;

  // [PERM-AUDIT-FIX-4] فحص صلاحية الوصول لكل مخزن مذكور في الحركة (كان
  // البناء التحتي لصلاحيات المخازن — Code_18_Permissions.gs §18-WH — موجودًا
  // لكن غير مُستدعى من أي دالة كتابة فعلية في المشروع كله؛ كان يُطبَّق فقط
  // على تصفية القراءة في getAllDataForUser، وليس على الكتابة هنا)
  var _whToCheck = [tx.warehouse, tx.from_warehouse, tx.to_warehouse].filter(
    function (w) {
      return !!w;
    },
  );
  for (var _wi = 0; _wi < _whToCheck.length; _wi++) {
    var _whErr = _checkWarehouseAccess(tx.user, _whToCheck[_wi]);
    if (_whErr) return _whErr;
  }

  // [FIX-PERM] سجّل في Audit Log
  AuditEngine.log("ADD_TRANSACTION:" + (tx.type || ""), {
    user: tx.user || "Unknown",
    table: "Transactions",
    record_id: tx.item_id || "",
    details: "كمية: " + tx.quantity + " | لون: " + (tx.color || "—")});

  // [FIX-3] LockService يمنع تعارض طلبين متزامنين يؤديان لرصيد سالب
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000); // [PERF-FIX-6] قلّل من 10s إلى 5s — تجربة أفضل عند التعارض
  } catch (lockErr) {
    return errResponse(
      "النظام مشغول بتسجيل حركة أخرى، انتظر لحظة وحاول مرة ثانية",
    );
  }
  try {
    // [VALIDATION-ENGINE-MIGRATION] الصنف/النوع عبر isRequired — الكمية تبقى
    // عبر validateQty() الخاصة (Code_12_Core.js) لأنها منطق أعمال خاص بحركات
    // المخزون (حدود عشرية/سالب) خارج نطاق هذا التوحيد.
    if (!ValidationEngine.isRequired(tx.item_id))
      return errResponse("يجب تحديد الصنف");
    const qErr = validateQty(tx.quantity);
    if (qErr) return errResponse(qErr);
    if (!ValidationEngine.isRequired(tx.type))
      return errResponse("يجب تحديد نوع الحركة");
    // [FIX-AUDIT #2] تفعيل إعداد "الملاحظات إلزامية على الحركات"
    const _notesErrTx = _checkRequireNotesOnTx(tx.notes);
    if (_notesErrTx) return _notesErrTx;

    // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية — كان مفقوداً في
    // مسار الإنشاء رغم وجوده في deleteTransaction (راجع تقرير المراجعة، المرحلة 2).
    const _periodErrTx = _blockIfPeriodClosed(
      tx.date || new Date().toISOString().split("T")[0],
      "حركة المخزون",
    );
    if (_periodErrTx) return _periodErrTx;

    // [PERF-FIX-5] اقرأ Stock مرة واحدة — مررها لـ _checkOutboundStock و updateStockBalance
    // قبل الإصلاح: كانت تُقرأ مرتين (مرة في _checkOutboundStock + مرة في getOrCreateStockRow)
    var _stockSnapshot = getSheetData("Stock");

    const stockErr = _checkOutboundStock(tx, _stockSnapshot);
    if (stockErr) return errResponse(stockErr);

    // [TRACKING-SETTINGS-WIRE-2026-08-08] فحص إلزامي لـ batch/serial/expiry
    const trackingErr = _checkTrackingRequirements(tx);
    if (trackingErr) return errResponse(trackingErr);

    // [P1-FIX-ADDTX-DEDUP-2026-08-12] تحقّق فعلي أثبت أن addTransaction لا
    // تملك أي حماية من التكرار إطلاقاً — لا مفتاح client_request_id ولا
    // حارس محتوى، بخلاف addBatchTransaction (بعد إصلاحها) وaddSaleInvoice/
    // addPurchaseInvoice/addSaleReturn/addPurchaseReturn (كلها فيها حماية).
    // LockService هنا يمنع فقط race condition بين طلبين متزامنين تمامًا؛ لا
    // يمنع طلب retry حقيقي (نفس المستخدم يعيد إرسال نفس الحركة بعد timeout
    // شبكة) من إنشاء صف Transactions + تحديث Stock + قيد محاسبي مكرر بالكامل
    // بصمت. الحل: نفس آلية client_request_id المستخدمة فعليًا في هذا
    // المشروع (CacheService عبر _requireIdempotencyKey، Code_20c_Invoices.js) —
    // اختيارية (فقط لو الواجهة أرسلت المفتاح)، فلا تُغيّر أي سلوك للواجهات
    // التي لم تُحدَّث بعد لإرساله.
    var _crIdTxKey =
      tx && tx.client_request_id
        ? "addtx_" + String(tx.client_request_id)
        : null;
    if (_crIdTxKey) {
      var _crIdTx = _requireIdempotencyKey(_crIdTxKey);
      if (!_crIdTx.ok) return _crIdTx.error;
    }

    const txId = makeId(tx.type || "T");
    _appendRowProtected(getSheet("Transactions"), HEADERS.Transactions, _buildTxRow(tx, txId, new Date())); // [ENGINE-UNIFY]
    updateStockBalance(tx, _stockSnapshot);

    // ── تحويل حالة أمر الإنتاج تلقائياً عند أول صرف للمصنع ──
    if (tx.type === "DISPATCH" && tx.production_order_id) {
      try {
        var poRows = getSheetData("ProductionOrders");
        var poRow = findRow(poRows, "id", tx.production_order_id);
        if (poRow && poRow.status === "pending") {
          getSheet("ProductionOrders")
            .getRange(poRow._row, 5)
            .setValue("inprogress");
        }
      } catch (poErr) {
        Logger.log("PO status update error: " + poErr.message);
      }
    }

    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)

    // [FIX-ISSUE-008] تفعيل القيود المحاسبية التلقائية عند تسجيل الحركات
    // الدوال كانت معرّفة لكن لا تُستدعى — الآن مُفعّلة مع error isolation
    // [ACCOUNTING-ENGINE] قيود تلقائية لجميع أنواع الحركات
    //
    // [P3-A FIX] منع ازدواجية القيود:
    // إذا كانت الحركة مرتبطة بفاتورة (permit_id يُشير لـ INV-xxxx أو PI-xxxx)
    // فالفاتورة أنشأت قيدها بالفعل — لا نُنشئ قيداً مكرراً هنا
    var permitId = String(tx.permit_id || "").trim();
    var isLinkedToInvoice =
      permitId.indexOf("INV-") === 0 || // فاتورة بيع
      permitId.indexOf("PI-") === 0 || // فاتورة شراء
      permitId.indexOf("SR-") === 0 || // مرتجع بيع
      permitId.indexOf("PR-") === 0; // مرتجع شراء

    try {
      if (isLinkedToInvoice) {
        // [P3-A] تخطّي القيد التلقائي — الفاتورة المرتبطة أنشأت القيد بالفعل
        Logger.log("[P3-A] تخطّي قيد Tx — مرتبط بفاتورة: " + permitId);
      } else if (tx.type === "OUT") {
        // [AUDIT-FIX-2026-08-08 §RISK-1] autoJournalFromSale بقت ترجع
        // {success:false} صراحة بدل إكمال بصمت بقيد ناقص — لازم نفحص
        // النتيجة هنا ونرميها كـ throw عشان الـ catch أسفل يمسكها ويسجّلها
        // في AuditLog بنفس آلية BUG-005 (وإلا هيفشل القيد بصمت تماماً).
        var _ajRes1 = autoJournalFromSale({ ...tx, id: txId });
        if (!_ajRes1 || !_ajRes1.success) {
          throw new Error(
            (_ajRes1 && _ajRes1.message) ||
              "فشل إنشاء القيد التلقائي لحركة صادر",
          );
        }
      } else if (tx.type === "DISPATCH") {
        // [FIX-POSTING-AUDIT §4] كان يُعامَل كبيع فعلي (إيراد + ذمم/صندوق!)
        // رغم أنها حركة داخلية بحتة (خام → تحت التشغيل). الصحيح: مدين WIP،
        // دائن المخزون — بدون أي أثر على الإيرادات أو الذمم.
        _autoJournalFromProductionDispatch({ ...tx, id: txId });
      } else if (tx.type === "IN") {
        // [AUDIT-FIX-2026-08-08 §RISK-1] نفس المنطق أعلاه لحركة الوارد.
        var _ajRes2 = autoJournalFromPurchase({ ...tx, id: txId });
        if (!_ajRes2 || !_ajRes2.success) {
          throw new Error(
            (_ajRes2 && _ajRes2.message) ||
              "فشل إنشاء القيد التلقائي لحركة وارد",
          );
        }
        // [AUDIT-FIX-2026-08-08 §RISK-LOT-GAP-CRITICAL] كان توثيق
        // _createStockLot نفسه (Code_03_Accounting_Costing.js) يقول صراحة
        // إنها تُستدعى من "addPurchaseInvoice, addSaleReturn,
        // addTransaction(IN), openingStock" — لكن هذا الاستدعاء لم يكن
        // موجوداً فعلياً هنا إطلاقاً. الأثر: أي بضاعة داخلة بحركة IN
        // مباشرة (بدون فاتورة شراء) كانت بتدخل للـ Stock بالكمية فقط، من
        // غير أي طبقة تكلفة (StockLot) مقابلة. فلما تُباع لاحقاً،
        // _consumeStockLots ما بيلاقيش طبقات كافية لهذا الصنف فيحسب COGS
        // ناقصاً أو صفراً بصمت (fully_consumed=false) — ربح المبيعات يظهر
        // أعلى من الحقيقة وقيمة المخزون بالأستاذ العام تختلف عن الفعلية.
        // الحل: ننشئ طبقة تكلفة هنا بنفس الأساس المستخدم فعلاً في القيد
        // المحاسبي أعلاه (item.cost_price × الكمية) فور نجاح القيد.
        try {
          var _itemsForLot = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
          var _itemForLot = _itemsForLot.find(function (i) {
            return i.id === tx.item_id || i.code === tx.item_id;
          });
          _createStockLot({
            item_id: tx.item_id,
            color: tx.color || "",
            warehouse: tx.warehouse || "",
            qty: Number(tx.quantity),
            unit_cost: Number(_itemForLot ? _itemForLot.cost_price : 0),
            source_type: "DIRECT_IN_TX",
            source_id: txId,
            lot_date: tx.date || new Date().toISOString().split("T")[0],
          });
        } catch (lotErr) {
          Logger.log(
            "[COGS-LOT-FIX] فشل إنشاء طبقة تكلفة لحركة الوارد " +
              txId +
              ": " +
              lotErr.message,
          );
        }
      } else if (tx.type === "FG_IN" || tx.type === "FACTORY_RETURN") {
        // [FIX-POSTING-AUDIT §4] كان يُعامَل كشراء فعلي من مورد (دائن ذمم
        // دائنة/صندوق!) رغم أنه استلام منتج تام أو مرتجع خام من المصنع نفسه.
        // الصحيح: مدين البضاعة التامة/المخزون، دائن WIP (تصفية الحساب).
        _autoJournalFromProductionReceipt({ ...tx, id: txId });
      } else if (tx.type === "TRANSFER") {
        // تحويل بين مستودعات — قيد محايد داخلي: يُسجَّل كحركة مخزون بلا تأثير مالي خارجي
        _autoJournalFromInventoryTransfer({ ...tx, id: txId });
      } else if (tx.type === "WASTE") {
        // [WASTE-FEATURE-2026-08-07] هالك/تلف — قيد مصروف هالك مقابل خروج
        // المخزون بالتكلفة، بدون أي إيراد أو ذمم.
        _autoJournalFromWaste({ ...tx, id: txId });
      }
    } catch (ajErr) {
      // لا نفشل الحركة بسبب خطأ في القيد التلقائي — نُسجّل فقط
      Logger.log("[autoJournal] خطأ في إنشاء القيد التلقائي: " + ajErr.message);
      // [BUG-005 FIX] تنبيه مرئي في سجل التدقيق (AuditLog) بدل الاكتفاء
      // بـ Logger.log الخلفي — عشان انفصال المخزون عن المحاسبة ميفضلش
      // صامت لحد ما حد يكتشفه في جرد أو تسوية لاحقة. راجع BUG-005.
      try {
        AuditEngine.log("AUTO_JOURNAL_FAILED", {
          user: (tx && tx.callerUser) || "SYSTEM",
          table: "Transactions",
          record_id: txId,
          details:
            " فشل إنشاء القيد المحاسبي التلقائي لحركة المخزون " +
            txId +
            " (نوع: " +
            (tx.type || "") +
            "): " +
            ajErr.message +
            " — يحتاج مراجعة يدوية من المحاسب."});
      } catch (auditErr2) {
        Logger.log(
          "[autoJournal] فشل تسجيل تنبيه AuditLog: " + auditErr2.message,
        );
      }
    }

    return okResponse(" تم تسجيل الحركة بنجاح", { id: txId });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

function addBatchTransaction(batch) {
  // [P9-FIX] التحقق من الصلاحية قبل أي عملية — كان مفقوداً بالكامل
  // addBatchTransaction كانت مكشوفة: أي جلسة صالحة (حتى viewer) تستطيع
  // إضافة حركات مخزنية متعددة بدون أي فحص صلاحية
  var permErr = _checkPermission(
    batch && (batch.user || batch.callerUser),
    "addBatchTransaction",
    batch && (batch.sessionToken || batch.token),
  );
  if (permErr) return permErr;

  // [PERM-AUDIT-FIX-4] فحص صلاحية المخزن لكل مخزن مذكور على مستوى الدفعة
  // أو مستوى كل عنصر بداخلها (نفس السبب الموثّق في addTransaction)
  (function () {
    var _u = batch && (batch.user || batch.callerUser);
    var _whSet = {};
    if (batch && batch.warehouse) _whSet[batch.warehouse] = true;
    if (batch && batch.from_warehouse) _whSet[batch.from_warehouse] = true;
    if (batch && batch.to_warehouse) _whSet[batch.to_warehouse] = true;
    (batch && batch.items ? batch.items : []).forEach(function (it) {
      if (it.from_warehouse) _whSet[it.from_warehouse] = true;
      if (it.to_warehouse) _whSet[it.to_warehouse] = true;
    });
    Object.keys(_whSet).forEach(function (w) {
      var e = _checkWarehouseAccess(_u, w);
      if (e) permErr = e;
    });
  })();
  if (permErr) return permErr;

  // [FIX-3] LockService يمنع تعارض طلبين متزامنين يؤديان لرصيد سالب
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // batch يحتاج وقت أطول — 10s كافية (كانت 15s)
  } catch (lockErr) {
    return errResponse(
      "النظام مشغول بتسجيل دفعة أخرى، انتظر لحظة وحاول مرة ثانية",
    );
  }
  try {
    if (!batch || !batch.type) return errResponse("نوع الحركة مطلوب");
    var items = batch.items || [];
    if (!items.length) return errResponse("يجب إضافة صنف واحد على الأقل");

    // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية — تأكيدًا لملحوظة
    // تقرير المراجعة (المرحلة 2). الواجهة الحالية لا ترسل batch.date (تُسجَّل
    // دائمًا بتاريخ اليوم عبر `now` أدناه)، فالفحص هنا احترازي بحت حاليًا،
    // لكنه ضروري لو أُضيف مستقبلاً حقل تاريخ للدفعة من الواجهة.
    var _periodErrBatch = _blockIfPeriodClosed(
      batch.date || new Date().toISOString().split("T")[0],
      "حركة مخزون (دفعة)",
    );
    if (_periodErrBatch) return _periodErrBatch;

    // [PERF-FIX-5] اقرأ Stock مرة واحدة للدفعة كلها بدلاً من قراءة لكل صنف
    var _stockSnapshot = getSheetData("Stock");

    // [TRACK2-PHASE2D-FIX-2026-08-12] الفحص القديم كان يتحقق من كل صنف في
    // الدفعة مقابل _stockSnapshot الثابت وحده — لو نفس الصنف/المخزن/اللون
    // تكرر في أكتر من سطر بنفس الدفعة (مثلاً صرف نفس الصنف مرتين بواقع 8
    // وحدة، والرصيد الفعلي 10)، كل سطر كان يُفحص بمعزل عن التاني مقابل
    // نفس الرصيد الأصلي (10 ≥ 8 لكل سطر على حدة) فيعدي الاثنين رغم إن
    // مجموعهم (16) يتجاوز الرصيد الفعلي — عجز حقيقي (over-commit) كان
    // بيتحول لرصيد سالب رغم وجود فحص allow_negative_stock=false. الحل:
    // نتتبّع الكمية المحجوزة تراكميًا لكل (صنف+مخزن+لون) أثناء حلقة الفحص
    // نفسها، ونطرحها من الرصيد المتاح قبل فحص كل سطر لاحق لنفس المفتاح.
    var _reservedInBatch = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var qErr = validateQty(it.quantity);
      if (qErr) return errResponse("الصنف " + it.item_id + ": " + qErr);
      if (batch.type === "OUT" || batch.type === "TRANSFER")
        if (!it.color || !String(it.color).trim())
          return errResponse(
            `الصنف "${it.item_id}": اللون مطلوب — كل لون رصيده مستقل`,
          );
      var _fromWhForKey = it.from_warehouse || batch.from_warehouse || "";
      var _batchKey =
        String(it.item_id) + "||" + String(_fromWhForKey) + "||" +
        _normalizeColorName(it.color || "");
      var stockErr = _checkOutboundStock(
        {
          type: batch.type,
          item_id: it.item_id,
          quantity: Number(it.quantity) + (_reservedInBatch[_batchKey] || 0),
          from_warehouse: _fromWhForKey,
          color: it.color || "",
        },
        _stockSnapshot,
      );
      if (stockErr) return errResponse(stockErr);
      _reservedInBatch[_batchKey] =
        (_reservedInBatch[_batchKey] || 0) + Number(it.quantity || 0);

      var trackingErr = _checkTrackingRequirements({
        type: batch.type,
        item_id: it.item_id,
        quantity: it.quantity,
        from_warehouse: it.from_warehouse || batch.from_warehouse || "",
        batch_no: it.batch_no || "",
        serial_no: it.serial_no || "",
        expiry_date: it.expiry_date || "",
      });
      if (trackingErr) return errResponse(trackingErr);
    }

    // [P0-FIX-BATCH-DEDUP-2026-08-12] addBatchTransaction لم يكن لها أي حماية
    // من التكرار (لا مفتاح idempotency ولا حارس محتوى)، بخلاف addTransaction
    // (التي عبورها عبر lock فقط لا يمنع طلبين متتاليين حقيقيين بنفس المحتوى)
    // وaddSaleReturn/addPurchaseReturn/addSaleInvoice/addPurchaseInvoice (التي
    // فيها الاثنين معًا). دفعة مخزون مكرَّرة (مثلاً retry بعد timeout شبكة من
    // شاشة الجرد أو الصرف الجماعي) كانت تُنشئ صفوف Transactions + خصم/إضافة
    // Stock + قيود محاسبية مكررة بالكامل، بصمت. الحل: نفس الطبقتين
    // المستخدمتين فعليًا في نقاط الكتابة الأخرى في هذا المشروع —
    // (أ) مفتاح idempotency عبر CacheService لو الواجهة أرسلت
    // batch.client_request_id، (ب) حارس محتوى (نفس النوع/المستخدم/المخزن(ات)/
    // بنود الدفعة خلال 20 ثانية) كخط دفاع ثانٍ حتى لو الواجهة لم ترسل مفتاحاً
    // أو فشل الكاش. نُنفّذها هنا (تحت الـ lock، بعد اجتياز كل فحوصات الرفض
    // المشروعة أعلاه) بنفس فلسفة [TRACK1-FIX-2026-08-12] في addSaleInvoice —
    // لا نستهلك مفتاح idempotency إلا قبل الكتابة الفعلية مباشرة.
    var _batchItemsJson = JSON.stringify(items);
    var _crIdBatchKey =
      batch && batch.client_request_id
        ? "batchtx_" + String(batch.client_request_id)
        : null;
    if (_crIdBatchKey) {
      var _crIdBatch = _requireIdempotencyKey(_crIdBatchKey);
      if (!_crIdBatch.ok) return _crIdBatch.error;
    }
    try {
      var _dedupWindowMsBatch = 20000;
      var _dedupNowTsBatch = Date.now();
      var _existingTxForDedup = getSheetData("Transactions");
      var _dupBatch = _existingTxForDedup.find(function (r) {
        if (String(r.type || "") !== String(batch.type || "")) return false;
        if (String(r.user || "") !== String(batch.user || "")) return false;
        // نطابق على نفس بادئة معرّف الدفعة المحتملة غير كافٍ (batchId لسه ما
        // اتحسبش) — بدلاً من ذلك نطابق ref/notes التي تحمل نفس بصمة المحتوى
        // عبر مقارنة الكمية/الصنف الإجمالية أولاً كفلتر سريع، ثم البنود.
        var _rDate = new Date(r.date || 0).getTime();
        return (
          !isNaN(_rDate) &&
          _dedupNowTsBatch - _rDate >= 0 &&
          _dedupNowTsBatch - _rDate < _dedupWindowMsBatch &&
          String(r.notes || "").indexOf("إذن: ") === 0
        );
      });
      // [ملاحظة] الفحص أعلاه بيرصد فقط "هل فيه حركة بنفس النوع/المستخدم
      // خلال 20 ثانية من دفعة" كإشارة أولية — التطابق الدقيق على كامل بنود
      // الدفعة (items) غير ممكن هنا لأن كل صف Transactions يمثل بند واحد لا
      // الدفعة كلها. الحماية الفعلية الأقوى هي مفتاح client_request_id أعلاه؛
      // هذا الفحص الثانوي فقط لتنبيه احترازي إضافي عند غياب المفتاح — لا
      // يرفض الطلب لتفادي false-positive (نفس مستخدم يسجّل نوعين متتاليين
      // فعليين خلال 20 ثانية أمر شائع ومشروع في شاشات الجرد السريع).
      if (_dupBatch) {
        Logger.log(
          "[BATCH-DEDUP] تنبيه: حركة دفعة أخرى بنفس النوع/المستخدم خلال 20 ثانية — لم تُرفض (فحص ثانوي فقط، لا مفتاح client_request_id مُرسَل)",
        );
      }
    } catch (_dedupErrBatch) {
      Logger.log("[BATCH-DEDUP] فشل فحص تكرار الدفعة: " + _dedupErrBatch.message);
    }

    var batchId =
      batch.permit_id && batch.permit_id.trim()
        ? batch.permit_id.trim()
        : makeId(batch.type || "B");
    var now = new Date();
    var sheet = getSheet("Transactions");
    var rows = [];

    items.forEach(function (it, idx) {
      var txId = items.length === 1 ? batchId : batchId + "-" + (idx + 1);
      var itNotes = [it.notes || "", batch.notes || ""]
        .filter(Boolean)
        .join(" | ");
      var fullNote = "إذن: " + batchId + (itNotes ? " | " + itNotes : "");
      rows.push([
        txId,
        now,
        batch.type,
        it.item_id,
        Number(it.quantity),
        _resolveWhName(it.from_warehouse || batch.from_warehouse || ""),
        _resolveWhName(it.to_warehouse || batch.to_warehouse || ""),
        fullNote,
        batch.user || "System",
        it.attachment_url || batch.attachment_url || "",
        it.color || "",
        batch.ref || "",
        batch.party || "",
        it.batch_no || "",
        it.serial_no || "",
        it.expiry_date || "",
      ]);
    });

    if (rows.length) {
      sheet
        .getRange(sheet.getLastRow() + 1, 1, rows.length, 16)
        .setValues(rows);
    }

    items.forEach(function (it) {
      updateStockBalance(
        {
          type: batch.type,
          item_id: it.item_id,
          quantity: it.quantity,
          from_warehouse: it.from_warehouse || batch.from_warehouse || "",
          to_warehouse: it.to_warehouse || batch.to_warehouse || "",
          color: it.color || "",
          batch_no: it.batch_no || "",
          serial_no: it.serial_no || "",
          expiry_date: it.expiry_date || "",
        },
        _stockSnapshot,
      ); // [PERF-FIX-5] نفس الـ snapshot — لا قراءة جديدة لكل صنف
    });

    // [P0-FIX-BATCH-JOURNAL-2026-08-12] addBatchTransaction لم تكن تستدعي أي
    // قيد محاسبي تلقائي إطلاقاً (تحقّق من الكود الفعلي — الادعاء السابق بأن
    // هذا "تم إصلاحه" كان خاطئاً). النتيجة: حركات الدفعة (OUT/IN/DISPATCH/
    // TRANSFER/WASTE/FG_IN/FACTORY_RETURN) كانت تُحدّث Stock والـ Transactions
    // فقط بدون أي أثر محاسبي — STOCK ≠ ACCOUNTING.
    // الإصلاح: نطبّق بالضبط نفس منطق addTransaction (نفس دوال autoJournal
    // المشتركة، نفس فحص isLinkedToInvoice لمنع الازدواجية، ونفس نمط
    // best-effort + AuditLog عند الفشل) — لكل صنف في الدفعة على حدة، لأن كل
    // صنف قد يكون له سعر تكلفة/طبقة FIFO مختلفة، فلا يصح تجميعها في قيد واحد.
    // نحافظ على نفس فلسفة addTransaction القائمة فعلاً في هذا الكود: فشل
    // القيد لا يُسقط الحركة المخزنية (التي التزمت فعلياً في الشيتات) بل يُسجَّل
    // بصوت عالٍ في AuditLog ليراجعه المحاسب — نفس الالتزام المعماري الموجود
    // بالفعل في addTransaction وdeleteTransaction (راجع BUG-005 FIX)، فتوحيد
    // هذا السلوك بين المسارين (فردي/دفعة) أسلم من كسر الاتساق بينهما.
    var _batchPermitId = String(batch.permit_id || batch.ref || "").trim();
    var _batchIsLinkedToInvoice =
      _batchPermitId.indexOf("INV-") === 0 ||
      _batchPermitId.indexOf("PI-") === 0 ||
      _batchPermitId.indexOf("SR-") === 0 ||
      _batchPermitId.indexOf("PR-") === 0;

    if (!_batchIsLinkedToInvoice) {
      items.forEach(function (it, idx) {
        var _itTxId = items.length === 1 ? batchId : batchId + "-" + (idx + 1);
        var _itTx = {
          id: _itTxId,
          type: batch.type,
          item_id: it.item_id,
          quantity: it.quantity,
          from_warehouse: it.from_warehouse || batch.from_warehouse || "",
          to_warehouse: it.to_warehouse || batch.to_warehouse || "",
          color: it.color || "",
          date: batch.date || new Date().toISOString().split("T")[0],
          party: batch.party || "",
          notes: it.notes || batch.notes || "",
          callerUser: batch.user || batch.callerUser || "SYSTEM",
        };
        try {
          if (batch.type === "OUT") {
            var _ajB1 = autoJournalFromSale(_itTx);
            if (!_ajB1 || !_ajB1.success) {
              throw new Error(
                (_ajB1 && _ajB1.message) ||
                  "فشل إنشاء القيد التلقائي لحركة صادر (دفعة)",
              );
            }
          } else if (batch.type === "DISPATCH") {
            _autoJournalFromProductionDispatch(_itTx);
          } else if (batch.type === "IN") {
            var _ajB2 = autoJournalFromPurchase(_itTx);
            if (!_ajB2 || !_ajB2.success) {
              throw new Error(
                (_ajB2 && _ajB2.message) ||
                  "فشل إنشاء القيد التلقائي لحركة وارد (دفعة)",
              );
            }
            // [COGS-LOT-FIX] نفس منطق addTransaction(IN) — ننشئ طبقة تكلفة
            // FIFO لكل صنف في الدفعة، وإلا سيُحسب COGS ناقصاً عند البيع لاحقاً.
            try {
              var _itemsForLotB = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
              var _itemForLotB = _itemsForLotB.find(function (i2) {
                return i2.id === it.item_id || i2.code === it.item_id;
              });
              _createStockLot({
                item_id: it.item_id,
                color: it.color || "",
                warehouse: it.to_warehouse || batch.to_warehouse || "",
                qty: Number(it.quantity),
                unit_cost: Number(_itemForLotB ? _itemForLotB.cost_price : 0),
                source_type: "DIRECT_IN_TX",
                source_id: _itTxId,
                lot_date: _itTx.date,
              });
            } catch (lotErrB) {
              Logger.log(
                "[COGS-LOT-FIX] فشل إنشاء طبقة تكلفة لحركة الوارد (دفعة) " +
                  _itTxId + ": " + lotErrB.message,
              );
            }
          } else if (batch.type === "FG_IN" || batch.type === "FACTORY_RETURN") {
            _autoJournalFromProductionReceipt(_itTx);
          } else if (batch.type === "TRANSFER") {
            _autoJournalFromInventoryTransfer(_itTx);
          } else if (batch.type === "WASTE") {
            _autoJournalFromWaste(_itTx);
          }
        } catch (ajErrB) {
          Logger.log(
            "[autoJournal-batch] خطأ في إنشاء القيد التلقائي: " + ajErrB.message,
          );
          try {
            AuditEngine.log("AUTO_JOURNAL_FAILED", {
              user: (batch && (batch.user || batch.callerUser)) || "SYSTEM",
              table: "Transactions",
              record_id: _itTxId,
              details:
                " فشل إنشاء القيد المحاسبي التلقائي لحركة المخزون (دفعة) " +
                _itTxId + " (نوع: " + (batch.type || "") + "): " +
                ajErrB.message + " — يحتاج مراجعة يدوية من المحاسب."});
          } catch (auditErrB) {
            Logger.log(
              "[autoJournal-batch] فشل تسجيل تنبيه AuditLog: " + auditErrB.message,
            );
          }
        }
      });
    } else {
      Logger.log("[P3-A] تخطّي قيد Batch — مرتبط بفاتورة: " + _batchPermitId);
    }

    _invalidateServerCacheInventory(); // [P0-FIX-BATCH-JOURNAL-2026-08-12] كان مفقوداً أيضاً في هذا المسار

    return okResponse(
      " تم تسجيل " +
        items.length +
        " " +
        (items.length === 1 ? "صنف" : "أصناف") +
        " بنجاح",
      { permitId: batchId, batchId: batchId, count: items.length },
    );
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

// [P8-FIX] يحسب تأثير حركة واحدة على أرصدة المخزون كقائمة {key, delta}
// key بصيغة item_id||warehouse||colorNorm — يُستخدم لمحاكاة الرصيد الناتج
// قبل تنفيذ تعديل فعلي على حركة موجودة (راجع updateTransaction)
function _txStockEffects(tx) {
  var qty = Number(tx.quantity || 0);
  var colorNorm = _normalizeColorName(tx.color || "");
  var effects = [];
  var type = String(tx.type || "").toUpperCase();
  if (
    (type === "IN" || type === "FG_IN" || type === "FACTORY_RETURN") &&
    tx.to_warehouse
  ) {
    effects.push({
      key:
        tx.item_id + "||" + _resolveWhName(tx.to_warehouse) + "||" + colorNorm,
      delta: qty,
    });
  } else if ((type === "OUT" || type === "DISPATCH" || type === "WASTE") && tx.from_warehouse) {
    effects.push({
      key:
        tx.item_id +
        "||" +
        _resolveWhName(tx.from_warehouse) +
        "||" +
        colorNorm,
      delta: -qty,
    });
  } else if (type === "TRANSFER") {
    if (tx.from_warehouse)
      effects.push({
        key:
          tx.item_id +
          "||" +
          _resolveWhName(tx.from_warehouse) +
          "||" +
          colorNorm,
        delta: -qty,
      });
    if (tx.to_warehouse)
      effects.push({
        key:
          tx.item_id +
          "||" +
          _resolveWhName(tx.to_warehouse) +
          "||" +
          colorNorm,
        delta: qty,
      });
  }
  return effects;
}

function updateTransaction(tx) {
  try {
    // [FIX-ISSUE-011] إضافة sessionToken لمنع Username Spoofing — مطابقاً لـ addTransaction
    if (!tx.user) return errResponse("يجب تسجيل الدخول لتعديل الحركات");
    var permErr = _checkPermission(
      tx.user,
      "updateTransaction",
      tx.sessionToken,
    );
    if (permErr) return permErr;
    // [VALIDATION-ENGINE-MIGRATION]
    if (!ValidationEngine.isRequired(tx.id))
      return errResponse("معرف الحركة مطلوب");
    if (!ValidationEngine.isRequired(tx.item_id))
      return errResponse("يجب تحديد الصنف");
    const qErr = validateQty(tx.quantity);
    if (qErr) return errResponse(qErr);
    if (!ValidationEngine.isRequired(tx.type))
      return errResponse("يجب تحديد نوع الحركة");

    const row = findRow(getSheetData("Transactions"), "id", tx.id);
    if (!row) return errResponse("الحركة غير موجودة");

    // [P0-FIX-UPDATE-LOT-JOURNAL-GAP-2026-08-12] تحقّق فعلي أثبت أن
    // updateTransaction تعدّل شيت Stock فقط (عبر الكتابة أدناه +
    // reloadStockFromAllTransactions) ولا تلمس StockLots ولا JournalEntries
    // إطلاقاً. الحركات من نوع IN/OUT/DISPATCH/WASTE/FG_IN/FACTORY_RETURN
    // تُنشئ عند الإضافة طبقة تكلفة (IN) أو تستهلك طبقات FIFO (OUT/DISPATCH/
    // WASTE) وقيداً محاسبياً (autoJournalFromSale/Purchase/... — ما لم تكن
    // مرتبطة بفاتورة). لا يوجد أي ربط مُسجَّل بين الحركة ومعرّف الطبقات التي
    // استهلكتها فعلاً (_consumeStockLots لا تُعيد/تُخزِّن lot_id مرتبطة
    // بمعرّف الحركة)، فلا توجد طريقة آمنة لعكس الاستهلاك القديم بدقة أو
    // لإعادة حساب القيد بفارق الكمية القديمة/الجديدة. تعديل الكمية/الصنف/
    // اللون/المخزن/النوع هنا كان يُنتج مباشرة: Stock = الحالة الجديدة، بينما
    // StockLots و JournalEntries تبقيان على الحالة القديمة تمامًا —
    // انفصال محاسبي/مخزني صامت لا تنبيه بشأنه إطلاقاً.
    // الحل الآمن الوحيد بدون بنية تحتية جديدة (ربط lot_id/journal_id
    // بمعرّف الحركة، غير موجودة حاليًا): منع أي تعديل يُغيّر الأثر الفعلي
    // على المخزون/التكلفة/المحاسبة لأي حركة من هذه الأنواع، وإجبار المستخدم
    // على مسار الحذف (deleteTransaction — يعكس Stock فعليًا ويُلغي القيد عبر
    // _cancelJournalEntryByReference) ثم إعادة الإنشاء (addTransaction —
    // يُنشئ طبقة/يستهلك طبقات وقيداً جديدين متسقين مع القيمة الجديدة).
    // نسمح فقط بتعديل الحقول التي لا أثر مخزني/محاسبي لها (notes,
    // attachment_url, party, ref) طالما النوع/الصنف/الكمية/اللون/المخزن(ات)
    // لم تتغيّر عن القيمة المخزّنة فعليًا في الصف الحالي.
    // [P0-FIX-UPDATE-LOT-JOURNAL-GAP-2026-08-12] TRANSFER مُضافة أيضًا —
    // تحقّق فعلي (_autoJournalFromInventoryTransfer، Code_04) أثبت أنها
    // تُنشئ قيداً محاسبياً فعلياً لو للمخزنين حسابات GL مختلفة (وليست
    // "محايدة" دائماً كما قد يُفترض)، فنفس فجوة عدم إعادة الاحتساب عند
    // التعديل تنطبق عليها.
    var _lotJournalTypes = {
      IN: 1, OUT: 1, DISPATCH: 1, WASTE: 1, FG_IN: 1, FACTORY_RETURN: 1,
      TRANSFER: 1,
    };
    if (_lotJournalTypes[String(row.type || "").toUpperCase()] ||
        _lotJournalTypes[String(tx.type || "").toUpperCase()]) {
      var _oldQtyU = Number(row.quantity || 0);
      var _newQtyU = Number(tx.quantity || 0);
      var _effectChanged =
        String(tx.type || "") !== String(row.type || "") ||
        String(tx.item_id || "") !== String(row.item_id || "") ||
        Math.abs(_newQtyU - _oldQtyU) > 0.0001 ||
        _normalizeColorName(tx.color || "") !== _normalizeColorName(row.color || "") ||
        _resolveWhName(tx.from_warehouse || "") !== _resolveWhName(row.from_warehouse || "") ||
        _resolveWhName(tx.to_warehouse || "") !== _resolveWhName(row.to_warehouse || "");
      if (_effectChanged) {
        return errResponse(
          " لا يمكن تعديل الصنف/الكمية/اللون/المخزن/النوع لحركة من نوع " +
            (row.type || "") +
            " لأن ذلك سيفصل رصيد المخزون عن طبقات التكلفة (FIFO) والقيد " +
            "المحاسبي المرتبطين بها. من فضلك احذف الحركة ثم أعد تسجيلها " +
            "بالقيم الصحيحة (الحذف يعكس المخزون والقيد تلقائيًا).",
        );
      }
    }

    // [BUG-004 FIX] LockService حول مسار "فحص الرصيد الناتج ثم الكتابة"
    // (نفس نمط addTransaction/deleteTransaction — [FIX-3]/[C-04 FIX]) —
    // كان مفقوداً هنا رغم وجود نفس منطق محاكاة الرصيد، ففتح نافذة تزامن
    // (race window) بين القراءة والكتابة يمكن أن تنتج رصيداً سالباً فعلياً
    // رغم وجود كود الفحص. نُحرِّر القفل *قبل* استدعاء
    // reloadStockFromAllTransactions لأن لها قفلها الخاص (C-04 FIX) ولتجنّب
    // deadlock (نفس التنفيذ لا يمكنه الانتظار على نفسه).
    var _updTxLock = LockService.getScriptLock();
    try {
      _updTxLock.waitLock(5000);
    } catch (lockErr) {
      return errResponse(
        "النظام مشغول بتعديل حركة أخرى، انتظر لحظة وحاول مرة ثانية",
      );
    }
    try {
      // [P8-FIX] قبل الآن لم يكن هناك أي فحص لكفاية الرصيد عند تعديل حركة
      // موجودة — كان بالإمكان مثلاً رفع كمية حركة "صادر" لأي رقم فيُعاد بناء
      // شيت Stock بالكامل عبر reloadStockFromAllTransactions التي لا تُقيِّد
      // النتيجة بصفر (بخلاف updateStockBalance)، فينتج رصيد سالب حقيقي في
      // الشيت بصمت دون أي رسالة تحذير للمستخدم.
      var settingsForEdit = _getCompanySettingsRaw();
      var allowNegativeForEdit =
        settingsForEdit.allow_negative_stock === true ||
        settingsForEdit.allow_negative_stock === "true";
      if (!allowNegativeForEdit) {
        var oldEffects = _txStockEffects(row);
        var newEffects = _txStockEffects(tx);
        var currentStockForEdit = getSheetData("Stock");
        var affectedKeys = {};
        oldEffects.concat(newEffects).forEach(function (e) {
          affectedKeys[e.key] = true;
        });
        for (var k in affectedKeys) {
          var parts = k.split("||");
          var curRow = currentStockForEdit.find(function (s) {
            return (
              String(s.item_id) === parts[0] &&
              s.warehouse === parts[1] &&
              _normalizeColorName(s.color) === parts[2]
            );
          });
          var curQty = curRow ? Number(curRow.quantity || 0) : 0;
          var oldDelta = oldEffects
            .filter(function (e) {
              return e.key === k;
            })
            .reduce(function (s, e) {
              return s + e.delta;
            }, 0);
          var newDelta = newEffects
            .filter(function (e) {
              return e.key === k;
            })
            .reduce(function (s, e) {
              return s + e.delta;
            }, 0);
          var simulatedQty = curQty - oldDelta + newDelta;
          if (simulatedQty < -0.0001) {
            return errResponse(
              " لا يمكن حفظ التعديل — الرصيد الناتج سيكون سالباً (" +
                simulatedQty.toFixed(2) +
                ') للصنف "' +
                parts[0] +
                '" في مستودع "' +
                parts[1] +
                '"',
            );
          }
        }
      }

      const dateVal = tx.date ? new Date(tx.date) : new Date(row.date);
      // [TRACK2-PHASE2D-FIX-2026-08-12 — P0] كان العرض هنا مكتوب 13 عمود
      // ثابت بينما _buildTxRow/HEADERS.Transactions فيهم فعليًا 16 عمود
      // (batch_no/serial_no/expiry_date اتضافوا لاحقًا ولم يُحدَّث هذا
      // الاستدعاء) — Range width 13 مقابل مصفوفة 16 عمود يرمي استثناء
      // Apps Script فورًا ("Incorrect range width") عند أي تعديل حركة،
      // فالدالة كانت مكسورة بالكامل عمليًا. الإصلاح: استخدام طول
      // HEADERS.Transactions الفعلي بدل رقم ثابت، عشان ميتكررش لو الأعمدة
      // اتغيرت مستقبلاً.
      getSheet("Transactions")
        .getRange(row._row, 1, 1, HEADERS.Transactions.length)
        .setValues([
          _buildTxRow({ ...tx, user: tx.user || row.user }, tx.id, dateVal),
        ]);
    } finally {
      _updTxLock.releaseLock();
    }

    // ملحوظة: reloadStockFromAllTransactions تحمل قفلها الخاص (C-04 FIX) —
    // لا تُضف قفلاً هنا فوقها لتجنّب deadlock (نفس التنفيذ لا يمكنه الانتظار على نفسه)
    reloadStockFromAllTransactions();
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم تعديل الحركة وتحديث الرصيد");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function deleteTransaction(id, user, sessionToken) {
  // [FIX-ISSUE-007] user إلزامي — الشرط القديم if(user) كان يسمح بالحذف بدون مصادقة
  // [C-01 FIX] إضافة sessionToken لمنع تزييف اسم المستخدم من الفرونت إند
  if (!user) return errResponse("يجب تسجيل الدخول لحذف الحركات");
  var permErr = _checkPermission(user, "deleteTransaction", sessionToken);
  if (permErr) return permErr;

  // [C-04 FIX] قفل إلزامي حول حذف الحركة + تحديث المخزون معاً
  // يمنع تعارض حذف/إضافة حركات على نفس الصنف في نفس اللحظة
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return errResponse("النظام مشغول، حاول مرة أخرى");
  }
  try {
    const row = findRow(getSheetData("Transactions"), "id", id);
    if (!row) return errResponse("الحركة غير موجودة");

    // [SEC-FIX-STAB5] منع حذف حركة مرتبطة بفاتورة عبر هذا المسار العام.
    // تتبّع فعلي (Call Graph) أثبت وجود نظامين منفصلين لتقييم المخزون:
    // (1) شيت Stock — كمية مباشرة، بيتحدّث هنا عبر _reverseTransactionStockEffect.
    // (2) StockLots — طبقات تكلفة FIFO (Code_03_Accounting_Costing.js)، بتتحدّث
    // فقط عبر مسارات الفواتير المخصصة (إضافة/إلغاء فاتورة بيع أو شراء)، اللي
    // بتعكس الاتنين معًا بشكل صريح (راجع _reverseInvoiceStockMovements +
    // _reverseStockLot سوا في نفس كتلة التراجع بـ Code_20_Sales.js).
    // deleteTransaction ده (المسار العام لحذف أي حركة) بيعكس نظام (1) بس ومفيش
    // فيه أي لمس لـ StockLots إطلاقًا — يعني لو حُذفت حركة مرتبطة بفاتورة من
    // هنا، الكمية الفعلية (Stock) تتصحح لكن طبقة التكلفة (StockLots/COGS)
    // تفضل زي ما هي، وده بيخلق فرق حقيقي بين الكمية والتقييم المحاسبي مع مرور
    // الوقت. الحل: نمنع الحذف من هنا لو الحركة مرتبطة بفاتورة (عبر ref) ونوجّه
    // المستخدم لإلغاء/حذف الفاتورة نفسها من شاشتها (اللي بتعكس الاتنين معًا).
    if (row.ref) {
      var _linkedSaleInv = null;
      var _linkedPurchaseInv = null;
      try {
        _linkedSaleInv = findRow(
          getSheetData("SaleInvoices"),
          "id",
          row.ref,
        );
      } catch (e1) {}
      try {
        _linkedPurchaseInv = findRow(
          getSheetData("PurchaseInvoices"),
          "id",
          row.ref,
        );
      } catch (e2) {}
      if (_linkedSaleInv || _linkedPurchaseInv) {
        return errResponse(
          " هذه الحركة مرتبطة بفاتورة (" +
            row.ref +
            ") ولا يمكن حذفها من هنا مباشرة — دي هتخلي كمية المخزون تتصحح لكن " +
            "تكلفة المخزون (FIFO) تفضل غير متزنة. من فضلك احذف/ألغِ الفاتورة نفسها " +
            "من شاشة الفواتير بدل حذف الحركة مباشرة.",
        );
      }
    }

    // [PERIOD-CLOSING]
    var _periodErr = _blockIfPeriodClosed(row.date, "حركة المخزون");
    if (_periodErr) return _periodErr;

    AuditEngine.log("DELETE_TX", {
      user: user,
      table: "Transactions",
      record_id: id,
      details: "حذف حركة"});

    // [P0-FIX-DELETE-TX-ORDER-2026-08-12] كان الترتيب القديم: حذف صف
    // Transactions أولاً، ثم عكس أثره على Stock (_reverseTransactionStockEffect)
    // بدون أي try/catch حولها. لو _reverseTransactionStockEffect رمت استثناء
    // (مثلاً getOrCreateStockRow فشلت لأي سبب — مشكلة في الشيت، تعارض
    // مؤقت، إلخ)، الاستثناء كان يهرب مباشرة لـ catch الخارجي للدالة فيرجّع
    // success:false — لكن صف الحركة كان قد اتحذف بالفعل من Transactions في
    // السطر السابق مباشرة! النتيجة: سجل الحركة يختفي نهائيًا، لكن Stock
    // يفضل يعكس أثرها القديم (غير مُعكوس)، وبما إن الصف اتحذف فعليًا،
    // لا توجد طريقة لإعادة المحاولة (retry) لاستكمال العكس — حالة غير
    // متسقة دائمة بين Stock والتاريخ الفعلي للحركات. الحل: نعكس أثر
    // المخزون أولاً (باستخدام بيانات `row` المقروءة بالفعل)، ثم نحذف صف
    // الحركة فقط لو نجح العكس. getRange/setValue في _reverseTransactionStockEffect
    // أخف وأوثق من حذف صف كامل من ناحية احتمال الفشل، فتقليل نافذة الفشل
    // بعد نقطة اللاعودة (point of no return) هو الأصوب هنا.
    _reverseTransactionStockEffect(row);
    // [C-04 FIX] تحديث تفاضلي لرصيد هذه الحركة فقط بدل إعادة بناء كامل شيت Stock
    // من كل الحركات (كان عملية O(N) ثقيلة ومعرّضة لـ race condition مع حركات أخرى)
    getSheet("Transactions").deleteRow(row._row);
    // [A1-FIX] إلغاء القيد المحاسبي المرتبط بهذه الحركة (إن وُجد) — قبل الإصلاح كان
    // deleteTransaction يعكس المخزون فقط ويترك القيد في JournalEntries يتيمًا،
    // فيُلوِّث الأستاذ العام بقيد لحركة محذوفة فعليًا.
    try {
      _cancelJournalEntryByReference(id, user);
    } catch (jcErr) {
      Logger.log(
        "[A1-FIX] فشل إلغاء قيد الحركة المحذوفة " + id + ": " + jcErr.message,
      );
      // [BUG-005 FIX] تنبيه مرئي — لو فشل إلغاء القيد، القيد المحاسبي
      // بيفضل "يتيم" لحركة اتحذفت فعليًا من المخزون، وده لازم يظهر
      // للمحاسب بدل ما يختفي في Logger فقط.
      try {
        AuditEngine.log("JOURNAL_CANCEL_FAILED", {
          user: user || "SYSTEM",
          table: "Transactions",
          record_id: id,
          details:
            " تم حذف حركة المخزون " +
            id +
            " لكن فشل إلغاء القيد المحاسبي المرتبط بها: " +
            jcErr.message +
            " — يوجد قيد يتيم في دفتر اليومية يحتاج مراجعة يدوية."});
      } catch (auditErr3) {
        Logger.log(
          "[A1-FIX] فشل تسجيل تنبيه AuditLog: " + auditErr3.message,
        );
      }
    }
    _invalidateServerCacheInventory(); // [PERF-SCOPED-INVALIDATION-INVENTORY] scoped (was blanket _invalidateServerCache)
    return okResponse(" تم حذف الحركة وتحديث الرصيد");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

// [C-04 FIX] يعكس تأثير حركة واحدة على شيت Stock — نفس منطق updateStockBalance بالعكس
// يُستخدم عند حذف حركة، بدل إعادة بناء كامل شيت Stock من الصفر عبر reloadStockFromAllTransactions
function _reverseTransactionStockEffect(tx) {
  const qty = Number(tx.quantity);
  const color = tx.color || "";

  if (tx.type === "IN" || tx.type === "FACTORY_RETURN" || tx.type === "FG_IN") {
    const whName = _resolveWhName(tx.to_warehouse || "الرئيسي");
    const res = getOrCreateStockRow(tx.item_id, whName, color, tx.batch_no || "", tx.serial_no || "");
    res.sheet
      .getRange(res.sheetRow, 4)
      .setValue(res.currentQty - qty);
  } else if (tx.type === "OUT" || tx.type === "DISPATCH" || tx.type === "WASTE") {
    const whName = _resolveWhName(tx.from_warehouse || "الرئيسي");
    const res = getOrCreateStockRow(tx.item_id, whName, color, tx.batch_no || "", tx.serial_no || "");
    res.sheet.getRange(res.sheetRow, 4).setValue(res.currentQty + qty);
  } else if (tx.type === "TRANSFER") {
    // [P0-FIX-DELETE-TX-TRANSFER-ATOMICITY-2026-08-12] كان الكود القديم
    // يستدعي getOrCreateStockRow + setValue لكل مخزن على حدة بالتتابع. لو
    // نجح تعديل مخزن المصدر (from) ثم فشل getOrCreateStockRow لمخزن الوجهة
    // (to)، وبعد إصلاح ترتيب deleteTransaction أعلاه (عكس المخزون قبل حذف
    // الصف)، الصف مش هيتحذف فيصير قابل لإعادة المحاولة — فإعادة المحاولة
    // كانت هتُطبّق عكس "from" مرتين. الحل: نجهّز (getOrCreateStockRow) كل
    // المخازن المطلوبة أولاً بدون أي كتابة، ثم نكتب الاتنين معًا — فلو أي
    // lookup فشل، مفيش أي setValue اتنفذ إطلاقًا (فشل نظيف قابل لإعادة
    // المحاولة بأمان).
    var _fromResRev = null, _toResRev = null;
    if (tx.from_warehouse) {
      _fromResRev = getOrCreateStockRow(tx.item_id, _resolveWhName(tx.from_warehouse), color, tx.batch_no || "", tx.serial_no || "");
    }
    if (tx.to_warehouse) {
      _toResRev = getOrCreateStockRow(tx.item_id, _resolveWhName(tx.to_warehouse), color, tx.batch_no || "", tx.serial_no || "");
    }
    if (_fromResRev) {
      _fromResRev.sheet.getRange(_fromResRev.sheetRow, 4).setValue(_fromResRev.currentQty + qty);
    }
    if (_toResRev) {
      _toResRev.sheet.getRange(_toResRev.sheetRow, 4).setValue(_toResRev.currentQty - qty);
    }
  }
}

function reloadStockFromAllTransactions() {
  // [C-04 FIX] قفل إلزامي — هذه أداة صيانة يدوية (تُستخدم من fixStockColors) وتحذف
  // وتعيد بناء شيت Stock بالكامل، فيجب ألا تتزامن مع أي حركة إضافة/حذف أخرى
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return { success: false, message: "النظام مشغول، حاول مرة أخرى" };
  }
  try {
    const txs = getSheetData("Transactions");
    const stockSheet = getSheet("Stock");

    const lastRow = stockSheet.getLastRow();
    if (lastRow > 1) stockSheet.deleteRows(2, lastRow - 1);

    // المفتاح: item_id || warehouse || colorNorm (normalized للدمج الصحيح)
    const map = {};
    // نحتفظ بأول اسم أصلي لكل color normalized
    const colorOriginal = {};

    txs.forEach(function (tx) {
      const qty = Number(tx.quantity || 0);
      const type = String(tx.type || "").toUpperCase();
      const colorStr = String(tx.color || "").trim();
      // normalize يحل مشكلة أسود/اسود عند دمج السجلات
      const colorNorm = _normalizeColorName(colorStr);

      if (
        (type === "IN" || type === "FG_IN" || type === "FACTORY_RETURN") &&
        tx.to_warehouse
      ) {
        const k =
          String(tx.item_id) + "||" + tx.to_warehouse + "||" + colorNorm;
        map[k] = (map[k] || 0) + qty;
        if (!colorOriginal[colorNorm] && colorStr)
          colorOriginal[colorNorm] = colorStr;
      }
      if ((type === "OUT" || type === "DISPATCH" || type === "WASTE") && tx.from_warehouse) {
        const k = tx.item_id + "||" + tx.from_warehouse + "||" + colorNorm;
        map[k] = (map[k] || 0) - qty;
        if (!colorOriginal[colorNorm] && colorStr)
          colorOriginal[colorNorm] = colorStr;
      }
      if (type === "TRANSFER") {
        if (tx.from_warehouse) {
          const kf = tx.item_id + "||" + tx.from_warehouse + "||" + colorNorm;
          map[kf] = (map[kf] || 0) - qty;
          if (!colorOriginal[colorNorm] && colorStr)
            colorOriginal[colorNorm] = colorStr;
        }
        if (tx.to_warehouse) {
          const kt = tx.item_id + "||" + tx.to_warehouse + "||" + colorNorm;
          map[kt] = (map[kt] || 0) + qty;
          if (!colorOriginal[colorNorm] && colorStr)
            colorOriginal[colorNorm] = colorStr;
        }
      }
    });

    // كتابة 4 أعمدة: item_id | warehouse | color (الاسم الأصلي) | quantity
    const newRows = Object.keys(map).map(function (k) {
      const parts = k.split("||");
      const colorNorm = parts[2] || "";
      const originalName = colorOriginal[colorNorm] || colorNorm;
      return [parts[0], parts[1], originalName, map[k]];
    });
    if (newRows.length > 0)
      stockSheet.getRange(2, 1, newRows.length, 4).setValues(newRows);
  } catch (e) {
    console.error("reloadStockFromAllTransactions Error:", e.message);
  } finally {
    lock.releaseLock();
  }
}

// ── إصلاح رصيد الألوان (شغّلها مرة واحدة من Apps Script Editor) ──
/**
 * fixStockColors — تُعيد بناء شيت Stock بالكامل من الـ Transactions
 * تحل مشكلة السجلات القديمة التي تسجلت بدون لون
 * شغّلها مرة واحدة من: Apps Script Editor → Run → fixStockColors
 */
function fixStockColors() {
  try {
    reloadStockFromAllTransactions();
    return (
      " تم إعادة بناء رصيد الألوان بنجاح من " +
      getSheetData("Transactions").length +
      " حركة"
    );
  } catch (e) {
    return " خطأ: " + e.message;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// نهاية ملف Code_Accounting_HR.js
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// [REFACTOR-P3] موديول أوامر الشراء (§PURCHASE-ORDERS) اتنقل لملف Code_27_PurchaseOrders.gs مستقل
// راجع تقرير Architecture Audit 2026-07-03 — القسم 4-أ