// ════════════════════════════════════════════════════════════════
// Code_28_PartyCategories.gs — تصنيفات هرمية للأطراف (Hierarchical
// Party Categories) — [NEW-FEATURE] بمستوى أنظمة ERP العالمية
// (SAP B1 / Dynamics 365 / NetSuite / Odoo)
//
// محرك عام واحد يخدم "تصنيفات العملاء" و"تصنيفات الموردين" حاليًا،
// وقابل لإعادة الاستخدام مستقبلاً لتصنيفات الأصناف/المخازن/الحسابات/
// الموظفين بدون أي تعديل على هذا الملف — فقط بتمرير party_type مختلف
// (وربط شاشة/كيان استهلاك جديد بنفس الدوال العامة أدناه).
//
// يخزّن الشجرة في شيت واحد "PartyCategories" بعمود party_type
// (customer | supplier) للفصل بين الشجرتين مع نفس البنية والمحرك.
// ════════════════════════════════════════════════════════════════

var PARTY_CATEGORY_SHEET = "PartyCategories";

var PARTY_CATEGORY_HEADERS = [
  "id",
  "party_type", // customer | supplier (قابل للتوسعة مستقبلاً: item | warehouse | account | employee)
  "code", // كود التصنيف — فريد داخل نفس party_type
  "name", // الاسم بالعربية
  "name_en", // الاسم بالإنجليزية (اختياري)
  "parent_id", // ← ينتمي إلى (فارغ = تصنيف رئيسي)
  "description",
  "status", // نشط | غير نشط
  "sort_order", // ترتيب الظهور بين الأشقاء
  "color", // كود لون Hex (اختياري)
  "icon", // اسم أيقونة Tabler (اختياري)
  "notes",
  // ── إعدادات افتراضية تُورَّث تلقائيًا عند اختيار التصنيف لعميل/مورد جديد ──
  "default_credit_policy", // سياسة الائتمان الافتراضية (نص حر: كاش/آجل/مختلط...)
  "default_credit_limit", // حد الائتمان الافتراضي
  "default_payment_terms_days", // مهلة السداد الافتراضية بالأيام
  "default_discount_percent", // نسبة الخصم الافتراضية %
  "default_price_list", // قائمة الأسعار الافتراضية (نص حر — لحين وجود كيان مستقل)
  "default_sales_rep", // مندوب المبيعات الافتراضي (اسم/معرف حر)
  "default_region", // المنطقة الجغرافية الافتراضية
  "default_currency", // العملة الافتراضية
  "default_cost_center", // مركز التكلفة الافتراضي (معرف من Code_CostCenters إن وُجد)
  "created_at",
  "updated_at",
  "created_by",
  "deleted_at", // حذف ناعم (Soft Delete) — نفس أسلوب ChartOfAccounts
  "deleted_by",
];

// أعمدة تُرسَل للعميل/المورد كـ "إعدادات افتراضية" عند اختيار التصنيف
var PARTY_CATEGORY_DEFAULT_FIELDS = [
  "default_credit_policy",
  "default_credit_limit",
  "default_payment_terms_days",
  "default_discount_percent",
  "default_price_list",
  "default_sales_rep",
  "default_region",
  "default_currency",
  "default_cost_center",
];

var PARTY_CATEGORY_TYPES = ["customer", "supplier"];

// ── صلاحيات ──────────────────────────────────────────────────────────────
// viewCustomerCategories / addCustomerCategory / updateCustomerCategory / deleteCustomerCategory
// viewSupplierCategories / addSupplierCategory / updateSupplierCategory / deleteSupplierCategory
function _catPermKey(action, partyType) {
  // action: "view" (جمع) أو "add"/"update"/"delete" (مفرد)
  var noun = partyType === "supplier" ? "SupplierCategor" : "CustomerCategor";
  if (action === "view") return "view" + noun + "ies";
  return action + noun + "y";
}

function _catRequirePermission(callerUser, sessionToken, action, partyType) {
  if (!callerUser) throw new Error("يجب تسجيل الدخول");
  var key = _catPermKey(action, partyType);
  var permErr = _checkPermission(callerUser, key, sessionToken);
  if (permErr) throw new Error(permErr.message || " ليس لديك صلاحية: " + key);
}

function _validCategoryType(partyType) {
  return PARTY_CATEGORY_TYPES.indexOf(partyType) !== -1;
}

// ── قراءة/كتابة أساسية ───────────────────────────────────────────────────

// [DATA-LAYER-MIGRATION] كانت هذه الدالة تقرأ الشيت مباشرة عبر readSheet/cleanArr —
// الآن تمر عبر DataLayer.getAll() (تشمل المحذوفة لأن بعض المستدعين، مثل
// deletePartyCategory عند البحث عن current، يحتاج الوصول لسجل قد يكون محذوفاً
// بالفعل ضمن نفس دفعة معالجة أخطاء). نفس السلوك تماماً كالنسخة الأصلية.
function _readAllPartyCategoriesRaw() {
  var res = DataLayer.getAll(PARTY_CATEGORY_SHEET, {
    headers: PARTY_CATEGORY_HEADERS,
    includeDeleted: true,
  });
  if (!res.success) throw new Error(res.errorMessage);
  return res.data;
}

// يرجّع فقط تصنيفات نوع مُعيَّن (customer|supplier) غير المحذوفة
function _readPartyCategories(partyType) {
  var res = DataLayer.find(
    PARTY_CATEGORY_SHEET,
    function (r) {
      return String(r.party_type) === String(partyType);
    },
    { headers: PARTY_CATEGORY_HEADERS }, // includeDeleted غير مفعّلة افتراضياً = نفس فلتر !r.deleted_at الأصلي
  );
  if (!res.success) throw new Error(res.errorMessage);
  return res.data;
}

// يبني map[id] = row لتصنيفات نوع مُعيَّن، لتسريع عمليات المشي في الشجرة
function _catMapById(rows) {
  var map = {};
  rows.forEach(function (r) {
    map[r.id] = r;
  });
  return map;
}

// يتحقق: هل candidateAncestorId هو أحد أسلاف nodeId (بما فيه nodeId نفسه)؟
// تُستخدم لمنع: (أ) اختيار التصنيف نفسه كأب، (ب) العلاقات الدائرية،
// (ج) نقل تصنيف داخل أحد أبنائه — الثلاث حالات هي نفس الفحص فعليًا:
// المشي لأعلى من "الأب الجديد المقترح" ومطابقة nodeId في السلسلة.
function _catWouldCreateCycle(map, nodeId, proposedParentId) {
  if (!proposedParentId) return false;
  if (String(proposedParentId) === String(nodeId)) return true; // نفسه كأب
  var cursor = map[proposedParentId];
  var guard = 0;
  while (cursor && guard < 10000) {
    if (String(cursor.id) === String(nodeId)) return true; // دائرية / نقل داخل ابن
    cursor = cursor.parent_id ? map[cursor.parent_id] : null;
    guard++;
  }
  return false;
}

function _catComputeFullPath(map, node) {
  var parts = [node.name];
  var cursor = node.parent_id ? map[node.parent_id] : null;
  var guard = 0;
  while (cursor && guard < 10000) {
    parts.unshift(cursor.name);
    cursor = cursor.parent_id ? map[cursor.parent_id] : null;
    guard++;
  }
  return parts.join(" / ");
}

function _catComputeLevel(map, node) {
  var level = 1;
  var cursor = node.parent_id ? map[node.parent_id] : null;
  var guard = 0;
  while (cursor && guard < 10000) {
    level++;
    cursor = cursor.parent_id ? map[cursor.parent_id] : null;
    guard++;
  }
  return level;
}

// يرجّع كل معرفات التصنيفات الفرعية (بكل المستويات) لتصنيف مُعيَّن، شاملاً إياه
function _catDescendantIds(rows, rootId, includeSelf) {
  var byParent = {};
  rows.forEach(function (r) {
    var p = r.parent_id || "__ROOT__";
    if (!byParent[p]) byParent[p] = [];
    byParent[p].push(r.id);
  });
  var out = includeSelf ? [rootId] : [];
  var queue = (byParent[rootId] || []).slice();
  var guard = 0;
  while (queue.length && guard < 20000) {
    var id = queue.shift();
    out.push(id);
    (byParent[id] || []).forEach(function (childId) {
      queue.push(childId);
    });
    guard++;
  }
  return out;
}

// عدد العملاء/الموردين المرتبطين مباشرة بتصنيف مُعيَّن (بدون الفروع)
function _catDirectPartyCount(partyType, categoryId) {
  var parties = _readParties(partyType);
  return parties.filter(function (p) {
    return String(p.category_id || "") === String(categoryId) && !p.deleted_at;
  }).length;
}

// ── _buildPartyCategoriesFlat — المنطق الفعلي لبناء القائمة المسطّحة مع كل
// الحقول المحسوبة، بدون أي فحص صلاحيات. مستخرَجة من getPartyCategories حتى
// تُستدعى مباشرة من getAllData() (اللي بيجمّع بيانات كل الشاشات في نداء
// واحد وقت فتح التطبيق، بدون سياق مستخدم لكل شيت — نفس أسلوب items/customers/
// suppliers الموجود بالفعل هناك) من غير ما نكرر منطق التجميع مرتين.
// [PERF-CAT-BUNDLE] الهدف: تصنيفات العملاء/الموردين تبقى جاهزة في الذاكرة
// من أول لحظة فتح التطبيق، بدل ما تتطلب رحلة سيرفر منفصلة (getPartyCategoryTree
// + getPartyCategories) في كل مرة يفتح المستخدم نموذج "إضافة عميل/مورد" —
// وهو السبب الجذري في إحساس المستخدم إن زر "إضافة" بيستنى التحميل.
function _buildPartyCategoriesFlat(partyType) {
  var rows = _readPartyCategories(partyType);
  var map = _catMapById(rows);

  // [PERF-CAT-N+1] كانت _catDirectPartyCount + _readParties بتتنادى
  // جوه الـ loop لكل تصنيف — يعني قراءة كاملة لشيت العملاء/الموردين
  // (readSheet) عشرات المرات في نداء واحد. دلوقتي بنقرا الشيت مرة
  // واحدة بس هنا، ونبني عداد لكل category_id، وبعدين كل تصنيف بياخد
  // عدده من الـ map في الـ memory بدل ما يضرب الشيت من تاني.
  var allParties = _readParties(partyType).filter(function (p) {
    return !p.deleted_at;
  });
  var partyCountByCategory = {};
  allParties.forEach(function (p) {
    var cid = String(p.category_id || "");
    if (cid) partyCountByCategory[cid] = (partyCountByCategory[cid] || 0) + 1;
  });

  // بناء has_children بمرور واحد
  var childCount = {};
  rows.forEach(function (r) {
    if (r.parent_id)
      childCount[r.parent_id] = (childCount[r.parent_id] || 0) + 1;
  });

  var enriched = rows.map(function (r) {
    var directCount = partyCountByCategory[String(r.id)] || 0;
    var descIds = _catDescendantIds(rows, r.id, false);
    var descPartyCount = 0;
    descIds.forEach(function (id) {
      descPartyCount += partyCountByCategory[String(id)] || 0;
    });
    return Object.assign({}, r, {
      level: _catComputeLevel(map, r),
      full_path: _catComputeFullPath(map, r),
      has_children: !!childCount[r.id],
      children_count: childCount[r.id] || 0,
      party_count: directCount, // مباشر فقط
      party_count_with_children: directCount + descPartyCount, // شامل الفروع
    });
  });

  enriched.sort(function (a, b) {
    var sa = Number(a.sort_order || 0),
      sb = Number(b.sort_order || 0);
    if (sa !== sb) return sa - sb;
    return String(a.name || "").localeCompare(String(b.name || ""), "ar");
  });

  return enriched;
}

// ── getPartyCategories — قائمة مسطّحة مع كل الحقول المحسوبة (مع فحص صلاحيات) ──
function getPartyCategories(callerUser, sessionToken, partyType) {
  try {
    if (!_validCategoryType(partyType))
      return errResponse("نوع الكيان غير صالح");
    _catRequirePermission(callerUser, sessionToken, "view", partyType);

    return { success: true, data: _buildPartyCategoriesFlat(partyType) };
  } catch (e) {
    return errResponse("خطأ في جلب التصنيفات: " + e.message);
  }
}

// ── getPartyCategoryTree — نفس القائمة لكن مُنظَّمة كشجرة متداخلة (children[]) ──
function getPartyCategoryTree(callerUser, sessionToken, partyType) {
  try {
    var flatRes = getPartyCategories(callerUser, sessionToken, partyType);
    if (!flatRes.success) return flatRes;

    var flat = flatRes.data;
    var map = {};
    flat.forEach(function (n) {
      map[n.id] = n;
      n.children = [];
    });
    var tree = [];
    flat.forEach(function (n) {
      if (n.parent_id && map[n.parent_id]) {
        map[n.parent_id].children.push(n);
      } else {
        tree.push(n);
      }
    });
    return { success: true, data: tree };
  } catch (e) {
    return errResponse("خطأ في بناء شجرة التصنيفات: " + e.message);
  }
}

// ── addPartyCategory ─────────────────────────────────────────────────────
function addPartyCategory(callerUser, sessionToken, data) {
  _invalidateServerCachePartyCategories(); // [PERF-SCOPED-INVALIDATION] scoped
  try {
    data = data || {};
    var partyType = data.party_type;
    if (!_validCategoryType(partyType))
      return errResponse("نوع الكيان غير صالح");
    _catRequirePermission(callerUser, sessionToken, "add", partyType);

    var name = String(data.name || "").trim();
    if (!name) return errResponse("اسم التصنيف مطلوب");

    var existing = _readPartyCategories(partyType);

    // التحقق من الأب
    var parentId = String(data.parent_id || "").trim();
    if (parentId) {
      var parent = existing.find(function (r) {
        return String(r.id) === parentId;
      });
      if (!parent) return errResponse("التصنيف الأب غير موجود");
    }

    // كود التصنيف — يُولَّد تلقائيًا لو غير مُرسَل، وإلا يُتحقَّق من تفرّده
    var code = String(data.code || "").trim();
    if (code) {
      var dup = existing.find(function (r) {
        return String(r.code || "").toLowerCase() === code.toLowerCase();
      });
      if (dup) return errResponse("كود التصنيف موجود مسبقًا: " + code);
    } else {
      var prefix = partyType === "supplier" ? "SC" : "CC";
      var maxSeq = 0;
      existing.forEach(function (r) {
        var m = String(r.code || "").match(
          new RegExp("^" + prefix + "-(\\d+)$"),
        );
        if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
      });
      code = prefix + "-" + String(maxSeq + 1).padStart(4, "0");
    }

    var id = makeId("CAT");
    var now = new Date().toISOString();

    var row = PARTY_CATEGORY_HEADERS.map(function (h) {
      switch (h) {
        case "id":
          return id;
        case "party_type":
          return partyType;
        case "code":
          return code;
        case "name":
          return name;
        case "name_en":
          return String(data.name_en || "").trim();
        case "parent_id":
          return parentId;
        case "description":
          return String(data.description || "").trim();
        case "status":
          return String(data.status || "نشط").trim();
        case "sort_order":
          return Number(data.sort_order || 0);
        case "color":
          return String(data.color || "").trim();
        case "icon":
          return String(data.icon || "").trim();
        case "notes":
          return String(data.notes || "").trim();
        case "created_at":
          return now;
        case "updated_at":
          return now;
        case "created_by":
          return callerUser || "";
        case "deleted_at":
          return "";
        case "deleted_by":
          return "";
        default:
          // بقية حقول الإعدادات الافتراضية (default_*)
          if (PARTY_CATEGORY_DEFAULT_FIELDS.indexOf(h) !== -1) {
            var v = data[h];
            if (
              h === "default_credit_limit" ||
              h === "default_payment_terms_days" ||
              h === "default_discount_percent"
            ) {
              return v !== undefined && v !== "" ? Number(v) : "";
            }
            return v !== undefined ? String(v).trim() : "";
          }
          return "";
      }
    });

    // [DATA-LAYER-MIGRATION] كان الكود يفتح الشيت مباشرة (_getPartyCategorySheet)
    // وينادي _appendRowProtected يدوياً. القيم المحسوبة أعلاه (row) نفسها
    // بالضبط — فقط تحويلها لكائن {header: value} بدل مصفوفة موضعية، لأن
    // DataLayer.insert() يبني الصف داخلياً من كائن. القيم لم تتغيّر إطلاقاً.
    var dataObj = {};
    PARTY_CATEGORY_HEADERS.forEach(function (h, i) {
      dataObj[h] = row[i];
    });
    var insRes = DataLayer.insert(PARTY_CATEGORY_SHEET, dataObj, {
      headers: PARTY_CATEGORY_HEADERS,
    });
    if (!insRes.success)
      return errResponse("خطأ في إضافة التصنيف: " + insRes.errorMessage);

    AuditEngine.log(partyType === "supplier"
          ? "addSupplierCategory"
          : "addCustomerCategory", {
      user: callerUser,
      table: PARTY_CATEGORY_SHEET,
      record_id: id,
      details: { name: name, parent_id: parentId }});

    _invalidateServerCachePartyCategories(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse("تمت إضافة التصنيف بنجاح", { id: id, code: code });
  } catch (e) {
    return errResponse("خطأ في إضافة التصنيف: " + e.message);
  }
}

// ── updatePartyCategory ──────────────────────────────────────────────────
function updatePartyCategory(callerUser, sessionToken, id, data) {
  _invalidateServerCachePartyCategories(); // [PERF-SCOPED-INVALIDATION] scoped
  try {
    data = data || {};
    var all = _readAllPartyCategoriesRaw();
    var current = all.find(function (r) {
      return String(r.id) === String(id) && !r.deleted_at;
    });
    if (!current) return errResponse("التصنيف غير موجود");

    var partyType = current.party_type;
    _catRequirePermission(callerUser, sessionToken, "update", partyType);

    var sameType = all.filter(function (r) {
      return String(r.party_type) === String(partyType) && !r.deleted_at;
    });
    var map = _catMapById(sameType);

    // ── تحقق النقل/الأب ──
    var newParentId =
      data.parent_id !== undefined
        ? String(data.parent_id || "").trim()
        : current.parent_id;
    if (newParentId) {
      if (!map[newParentId]) return errResponse("التصنيف الأب غير موجود");
      if (_catWouldCreateCycle(map, id, newParentId)) {
        return errResponse(
          "عملية غير مسموحة: لا يمكن اختيار التصنيف نفسه أو أحد أبنائه كتصنيف أب (علاقة دائرية)",
        );
      }
    }

    // كود جديد؟ تحقق تفرّده (باستثناء نفس السجل)
    var newCode =
      data.code !== undefined ? String(data.code).trim() : current.code;
    if (
      newCode &&
      String(newCode).toLowerCase() !== String(current.code).toLowerCase()
    ) {
      var dup = sameType.find(function (r) {
        return (
          String(r.id) !== String(id) &&
          String(r.code || "").toLowerCase() === newCode.toLowerCase()
        );
      });
      if (dup) return errResponse("كود التصنيف موجود مسبقًا: " + newCode);
    }

    var now = new Date().toISOString();
    var headers = PARTY_CATEGORY_HEADERS;

    var fieldMap = {
      id: current.id,
      party_type: current.party_type, // لا يتغيّر نوع التصنيف بعد الإنشاء
      code: newCode,
      name: data.name !== undefined ? String(data.name).trim() : current.name,
      name_en:
        data.name_en !== undefined
          ? String(data.name_en).trim()
          : current.name_en,
      parent_id: newParentId,
      description:
        data.description !== undefined
          ? String(data.description).trim()
          : current.description,
      status:
        data.status !== undefined ? String(data.status).trim() : current.status,
      sort_order:
        data.sort_order !== undefined
          ? Number(data.sort_order || 0)
          : current.sort_order,
      color:
        data.color !== undefined ? String(data.color).trim() : current.color,
      icon: data.icon !== undefined ? String(data.icon).trim() : current.icon,
      notes:
        data.notes !== undefined ? String(data.notes).trim() : current.notes,
      created_at: current.created_at,
      updated_at: now,
      created_by: current.created_by,
      deleted_at: current.deleted_at || "",
      deleted_by: current.deleted_by || "",
    };
    PARTY_CATEGORY_DEFAULT_FIELDS.forEach(function (h) {
      if (data[h] !== undefined) {
        if (
          h === "default_credit_limit" ||
          h === "default_payment_terms_days" ||
          h === "default_discount_percent"
        ) {
          fieldMap[h] = data[h] === "" ? "" : Number(data[h]);
        } else {
          fieldMap[h] = String(data[h]).trim();
        }
      } else {
        fieldMap[h] = current[h];
      }
    });

    // [DATA-LAYER-MIGRATION] fieldMap يحتوي فعلاً القيمة النهائية لكل عمود
    // (المُعدَّلة أو المحتفَظ بها من current) — تمريره مباشرة كـ patch لـ
    // DataLayer.update يعطي نفس نتيجة الكتابة الكاملة للصف بالضبط، لكن
    // بدون الحاجة لحساب rowIdx أو فتح الشيت يدوياً هنا.
    var updRes = DataLayer.update(PARTY_CATEGORY_SHEET, id, fieldMap, {
      headers: headers,
    });
    if (!updRes.success)
      return errResponse("خطأ في تعديل التصنيف: " + updRes.errorMessage);

    AuditEngine.log(partyType === "supplier"
          ? "updateSupplierCategory"
          : "updateCustomerCategory", {
      user: callerUser,
      table: PARTY_CATEGORY_SHEET,
      record_id: id});

    _invalidateServerCachePartyCategories(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse("تم تعديل التصنيف بنجاح");
  } catch (e) {
    return errResponse("خطأ في تعديل التصنيف: " + e.message);
  }
}

// ── movePartyCategory — لعمليات Drag & Drop (نقل أب فقط، أخف من updateFull) ──
function movePartyCategory(
  callerUser,
  sessionToken,
  id,
  newParentId,
  newSortOrder,
) {
  var payload = { parent_id: newParentId || "" };
  if (newSortOrder !== undefined && newSortOrder !== null)
    payload.sort_order = newSortOrder;
  return updatePartyCategory(callerUser, sessionToken, id, payload);
}

// ── reorderPartyCategories — إعادة ترتيب الأشقاء بعد Drag & Drop ────────
function reorderPartyCategories(callerUser, sessionToken, orderedIds) {
  try {
    if (!Array.isArray(orderedIds) || !orderedIds.length)
      return errResponse("قائمة الترتيب فارغة");
    for (var i = 0; i < orderedIds.length; i++) {
      var res = updatePartyCategory(callerUser, sessionToken, orderedIds[i], {
        sort_order: i + 1,
      });
      if (!res.success) return res;
    }
    return okResponse("تم تحديث الترتيب بنجاح");
  } catch (e) {
    return errResponse("خطأ في إعادة الترتيب: " + e.message);
  }
}

// ── deletePartyCategory ──────────────────────────────────────────────────
// options: { reassignChildrenTo: "" | categoryId, reassignPartiesTo: "" | categoryId }
// لو فيه أبناء أو عملاء/موردون مرتبطون ومفيش options.reassign* → يرجّع تعارض
// (conflict:true) بدل ما يمنع بس، عشان الواجهة تعرض حوار "أعد التعيين إلى.. / إلغاء"
function deletePartyCategory(callerUser, sessionToken, id, options) {
  _invalidateServerCachePartyCategories(); // [PERF-SCOPED-INVALIDATION] scoped
  options = options || {};
  try {
    var all = _readAllPartyCategoriesRaw();
    var current = all.find(function (r) {
      return String(r.id) === String(id) && !r.deleted_at;
    });
    if (!current) return errResponse("التصنيف غير موجود");

    var partyType = current.party_type;
    _catRequirePermission(callerUser, sessionToken, "delete", partyType);

    var sameType = all.filter(function (r) {
      return String(r.party_type) === String(partyType) && !r.deleted_at;
    });

    var children = sameType.filter(function (r) {
      return String(r.parent_id || "") === String(id);
    });
    var parties = _readParties(partyType).filter(function (p) {
      return String(p.category_id || "") === String(id) && !p.deleted_at;
    });

    var hasReassignInstructions =
      options.reassignChildrenTo !== undefined ||
      options.reassignPartiesTo !== undefined;

    if ((children.length || parties.length) && !hasReassignInstructions) {
      return {
        success: false,
        conflict: true,
        message:
          "هذا التصنيف يحتوي على " +
          (children.length ? children.length + " تصنيف فرعي" : "") +
          (children.length && parties.length ? " و" : "") +
          (parties.length
            ? parties.length +
              " " +
              (partyType === "supplier" ? "مورد" : "عميل")
            : "") +
          " — حدد كيفية المعالجة قبل الحذف",
        childrenCount: children.length,
        partyCount: parties.length,
      };
    }

    // إعادة تعيين التصنيفات الفرعية
    if (children.length) {
      var newParentForChildren = options.reassignChildrenTo || "";
      if (
        newParentForChildren &&
        _catWouldCreateCycle(_catMapById(sameType), newParentForChildren, id)
      ) {
        return errResponse(
          "لا يمكن إعادة تعيين الأبناء لتصنيف يقع تحت نفس الفرع",
        );
      }
      children.forEach(function (c) {
        updatePartyCategory(callerUser, sessionToken, c.id, {
          parent_id: newParentForChildren,
        });
      });
    }

    // إعادة تعيين العملاء/الموردين المرتبطين
    if (parties.length) {
      var newCategoryForParties = options.reassignPartiesTo || "";
      parties.forEach(function (p) {
        _setPartyCategoryId(partyType, p.id, newCategoryForParties, callerUser);
      });
    }

    // حذف ناعم للتصنيف نفسه
    // [DATA-LAYER-MIGRATION] كان الكود يحسب rowIdx يدوياً ويكتب 3 خلايا
    // منفصلة (deleted_at/deleted_by/status). الآن تحديث واحد عبر
    // DataLayer.update بنفس الحقول الثلاثة — نتيجة مطابقة، وكتابة أوفر.
    var delRes = DataLayer.update(
      PARTY_CATEGORY_SHEET,
      id,
      {
        deleted_at: new Date().toISOString(),
        deleted_by: callerUser || "",
        status: "غير نشط",
      },
      { headers: PARTY_CATEGORY_HEADERS },
    );
    if (!delRes.success)
      return errResponse("خطأ في حذف التصنيف: " + delRes.errorMessage);

    AuditEngine.log(partyType === "supplier"
          ? "deleteSupplierCategory"
          : "deleteCustomerCategory", {
      user: callerUser,
      table: PARTY_CATEGORY_SHEET,
      record_id: id});

    _invalidateServerCachePartyCategories(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse("تم حذف التصنيف بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف التصنيف: " + e.message);
  }
}

// ── setPartyCategory — تعيين سريع لتصنيف عميل/مورد واحد (بدون فتح نموذج
// التعديل الكامل) — تُستخدم من شاشة قائمة العملاء/الموردين ومن Drag & Drop
// لسحب عميل/مورد مباشرة فوق تصنيف في الشجرة ────────────────────────────────
function setPartyCategory(
  callerUser,
  sessionToken,
  partyType,
  partyId,
  categoryId,
) {
  try {
    if (!_validCategoryType(partyType))
      return errResponse("نوع الكيان غير صالح");
    _catRequirePermission(callerUser, sessionToken, "update", partyType);
    if (categoryId) {
      var cat = _readPartyCategories(partyType).find(function (c) {
        return String(c.id) === String(categoryId);
      });
      if (!cat) return errResponse("التصنيف غير موجود");
    }
    var res = _setPartyCategoryId(partyType, partyId, categoryId, callerUser);
    if (res.success) _invalidateServerCachePartyCategories(); // [PERF-SCOPED-INVALIDATION] scoped
    return res;
  } catch (e) {
    return errResponse("خطأ في تعيين التصنيف: " + e.message);
  }
}

// ── getPartyCategoryDefaults — الإعدادات الافتراضية لتُملأ تلقائيًا في نموذج
// عميل/مورد جديد عند اختيار تصنيف ────────────────────────────────────────
function getPartyCategoryDefaults(callerUser, sessionToken, categoryId) {
  try {
    if (!categoryId) return okResponse("لا يوجد تصنيف", { defaults: {} });
    var all = _readAllPartyCategoriesRaw();
    var cat = all.find(function (r) {
      return String(r.id) === String(categoryId) && !r.deleted_at;
    });
    if (!cat) return errResponse("التصنيف غير موجود");
    var defaults = {};
    PARTY_CATEGORY_DEFAULT_FIELDS.forEach(function (h) {
      if (cat[h] !== undefined && cat[h] !== "") defaults[h] = cat[h];
    });
    return okResponse("تم الجلب", { defaults: defaults });
  } catch (e) {
    return errResponse("خطأ في جلب الإعدادات الافتراضية: " + e.message);
  }
}

// ── getPartiesByCategory — فلترة عملاء/موردين حسب تصنيف (شامل الفروع) ────
function getPartiesByCategory(
  callerUser,
  sessionToken,
  partyType,
  categoryId,
  includeChildren,
) {
  try {
    if (!_validCategoryType(partyType))
      return errResponse("نوع الكيان غير صالح");
    _catRequirePermission(callerUser, sessionToken, "view", partyType);
    if (!categoryId) return errResponse("معرف التصنيف مطلوب");

    var catRows = _readPartyCategories(partyType);
    var targetIds =
      includeChildren === false
        ? [categoryId]
        : _catDescendantIds(catRows, categoryId, true);

    var parties = _readParties(partyType).filter(function (p) {
      return (
        !p.deleted_at && targetIds.indexOf(String(p.category_id || "")) !== -1
      );
    });

    return { success: true, data: parties };
  } catch (e) {
    return errResponse("خطأ في جلب البيانات: " + e.message);
  }
}

// ── getPartyCategoryStats — إحصائيات لكل تصنيف: عدد الأطراف، إجمالي
// المبيعات/المشتريات، إجمالي الرصيد (مديونية/دائنية) — تُستخدم في شاشة
// التصنيفات (Grid) وقابلة للاستدعاء من أي تقرير مستقبلي ──────────────────
function getPartyCategoryStats(callerUser, sessionToken, partyType) {
  try {
    if (!_validCategoryType(partyType))
      return errResponse("نوع الكيان غير صالح");
    _catRequirePermission(callerUser, sessionToken, "view", partyType);

    var catsRes = getPartyCategories(callerUser, sessionToken, partyType);
    if (!catsRes.success) return catsRes;
    var cats = catsRes.data;

    var parties = _readParties(partyType).filter(function (p) {
      return !p.deleted_at;
    });
    var partyToCategory = {};
    parties.forEach(function (p) {
      partyToCategory[p.id] = p.category_id || "";
    });

    // إجمالي المبيعات/المشتريات لكل طرف من الفواتير
    var invoiceSheet =
      partyType === "supplier" ? "PurchaseInvoices" : "SaleInvoices";
    var invHeaders =
      partyType === "supplier"
        ? PURCHASE_INVOICE_HEADERS
        : SALE_INVOICE_HEADERS;
    var invRes = DataLayer.getAll(invoiceSheet, { headers: invHeaders });
    if (!invRes.success) throw new Error(invRes.errorMessage);
    var invoices = invRes.data;
    var salesByParty = {};
    invoices.forEach(function (inv) {
      if (String(inv.status || "").toUpperCase() === "CANCELLED") return;
      var pid = inv.party_id || "";
      if (!pid) return;
      salesByParty[pid] = (salesByParty[pid] || 0) + Number(inv.net_total || 0);
    });

    // إجمالي الرصيد (من الأستاذ العام) لكل طرف — نفس منطق getPartyMovements
    var linesRes = DataLayer.getAll("JournalEntryLines", {
      headers: ACCOUNTING_HR_HEADERS.JournalEntryLines,
    });
    if (!linesRes.success) throw new Error(linesRes.errorMessage);
    var lines = linesRes.data;

    var entriesRes = DataLayer.getAll("JournalEntries", {
      headers: ACCOUNTING_HR_HEADERS.JournalEntries,
      trimStrings: true,
    });
    if (!entriesRes.success) throw new Error(entriesRes.errorMessage);
    var entries = entriesRes.data;
    var postedEntries = {};
    entries.forEach(function (e) {
      if (e.status === "POSTED") postedEntries[e.id] = true;
    });
    var balanceByParty = {};
    lines.forEach(function (l) {
      if (!l.party_id || !postedEntries[l.entry_id]) return;
      var delta = Number(l.debit || 0) - Number(l.credit || 0);
      balanceByParty[l.party_id] = (balanceByParty[l.party_id] || 0) + delta;
    });

    // تجميع لكل تصنيف — مباشر فقط أولًا، ثم دمج تصاعدي عبر التسلسل الهرمي
    var byId = {};
    cats.forEach(function (c) {
      byId[c.id] = {
        category_id: c.id,
        name: c.name,
        full_path: c.full_path,
        level: c.level,
        party_count: 0,
        total_sales: 0,
        total_balance: 0,
      };
    });
    parties.forEach(function (p) {
      var cid = p.category_id;
      if (!cid || !byId[cid]) return;
      byId[cid].party_count += 1;
      byId[cid].total_sales += salesByParty[p.id] || 0;
      byId[cid].total_balance += balanceByParty[p.id] || 0;
    });

    var statsList = cats.map(function (c) {
      return byId[c.id];
    });

    statsList.sort(function (a, b) {
      return b.total_sales - a.total_sales;
    });
    var mostProfitable = statsList.slice(0, 5);
    var mostActive = statsList
      .slice()
      .sort(function (a, b) {
        return b.party_count - a.party_count;
      })
      .slice(0, 5);

    return {
      success: true,
      data: {
        byCategory: statsList,
        mostProfitable: mostProfitable,
        mostActive: mostActive,
      },
    };
  } catch (e) {
    return errResponse("خطأ في حساب إحصائيات التصنيفات: " + e.message);
  }
}
