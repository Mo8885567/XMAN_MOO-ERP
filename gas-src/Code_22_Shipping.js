// ════════════════════════════════════════════════════════════════
// Code_Shipping.gs — [REFACTOR-P4] نُقل/أُعيد تسميته من Code_Sales_Shipping.gs
// (نقل نصي بحت، صفر تغيير في المنطق). راجع تقرير Architecture Audit
// 2026-07-03 — المرحلة 4.
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// Code_Sales_Shipping.gs — جزء من MOO.ERP Code.js (مقسَّم تلقائيًا في 2026-06-30)
// تم الفصل من Code.js الأصلي مع الحفاظ الكامل على ترتيب وسلوك الكود.
// ════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 13089-14263] Shipments CRUD + Phases 3/4/5 ┄┄┄
// §19  Shipments CRUD — المرحلة 2: باك إند الشحنات الحقيقي
// ═══════════════════════════════════════════════════════════════════════════════

var SHIPMENTS_SHEET = "Shipments";

// الأعمدة الكاملة للشحنات (متوافقة مع الشيت الحالي + أعمدة جديدة)
var SHIPMENT_HEADERS_V2 = [
  "id", // SHP-DD-MS-XXXX
  "date", // تاريخ الشحن
  "customer", // اسم العميل
  "driver", // السائق / المندوب
  "company", // اسم شركة الشحن (نص حر — للتوافق القديم)
  "expected_date", // موعد التسليم المتوقع
  "status", // حالة الشحنة
  "notes", // ملاحظات
  "user", // المستخدم المُنشئ
  "items_json", // الأصناف JSON
  "receipt_url", // رابط إيصال / بوليصة الشحن
  "dispatch_permit_id", // رابط إذن الصادر (v4.2)
  "company_id", // ربط بـ ShippingCompanies (مرحلة 2)
  "tracking_number", // رقم التتبع (مرحلة 5)
  "tracking_url", // رابط التتبع
  "shipping_cost", // تكلفة الشحن
  "shipping_cost_on", // من يتحمل التكلفة: company | customer
  "actual_delivery_date", // تاريخ التسليم الفعلي
  "timeline_json", // سجل التغييرات (Timeline) JSON
  "created_at",
  "updated_at",
  "deleted_at", // soft-delete
  "invoice_id", // معرف الفاتورة المرتبطة (مرحلة 3)
];

// ── حالات الشحنة المسموحة ──
var VALID_SHIPMENT_STATUSES = [
  "بانتظار الشحن",
  "معلق",
  "جاهز للشحن",
  "في الطريق",
  "تم التسليم",
  "ملغي",
];

/**
 * _validateShipmentData — التحقق من البيانات قبل الحفظ
 */
function _validateShipmentData(data) {
  if (!ValidationEngine.isRequired(data.customer))
    return "اسم العميل مطلوب";
  if (!ValidationEngine.isRequired(data.items) || !data.items.length) return "يجب إضافة صنف واحد على الأقل";
  if (data.status && VALID_SHIPMENT_STATUSES.indexOf(data.status) === -1)
    return "حالة الشحنة غير صالحة";
  return null;
}

/**
 * _shipmentRowFromData — يبني صف الشيت من بيانات الفورم
 */
function _shipmentRowFromData(data, existing) {
  existing = existing || {};
  var now = new Date().toISOString();
  var timelineArr = [];

  // استرداد الـ timeline القديم لو موجود
  if (existing.timeline_json) {
    try {
      timelineArr =
        typeof existing.timeline_json === "string"
          ? JSON.parse(existing.timeline_json)
          : existing.timeline_json || [];
    } catch (e) {
      timelineArr = [];
    }
  }

  // إضافة حدث للـ timeline
  if (data._timelineEvent) {
    timelineArr.push(data._timelineEvent);
  }

  return [
    existing.id || data.id || "",
    data.date || existing.date || now.split("T")[0],
    String(data.customer || "").trim(),
    String(data.driver || "").trim(),
    String(data.company || "").trim(),
    data.expected_date || existing.expected_date || "",
    data.status || existing.status || "معلق",
    String(data.notes || "").trim(),
    data.user || existing.user || "",
    JSON.stringify(data.items || existing.items || []),
    String(data.receipt_url || existing.receipt_url || "").trim(),
    String(data.dispatch_permit_id || existing.dispatch_permit_id || "").trim(),
    String(data.company_id || existing.company_id || "").trim(),
    String(data.tracking_number || existing.tracking_number || "").trim(),
    String(data.tracking_url || existing.tracking_url || "").trim(),
    Number(data.shipping_cost || existing.shipping_cost || 0),
    String(
      data.shipping_cost_on || existing.shipping_cost_on || "company",
    ).trim(),
    data.actual_delivery_date || existing.actual_delivery_date || "",
    JSON.stringify(timelineArr),
    existing.created_at || now,
    now,
    existing.deleted_at || "",
    String(data.invoice_id || existing.invoice_id || "").trim(), // مرحلة 3
  ];
}

/**
 * addShipment — إضافة شحنة جديدة
 * @param {object} data — { customer, driver, company, date, expected_date,
 *                          status, notes, items[], receipt_url,
 *                          dispatch_permit_id, user, sessionToken }
 */
function addShipment(data) {
  data = data || {};
  try {
    var permErr = _checkPermission(data.user, "addShipment", data.sessionToken);
    if (permErr) return permErr;

    var vErr = _validateShipmentData(data);
    if (vErr) return errResponse(vErr);

    var sheet = getSheet(SHIPMENTS_SHEET, SHIPMENT_HEADERS_V2);
    var id = makeId("SHP");

    // حدث أول في الـ timeline
    data._timelineEvent = {
      at: new Date().toISOString(),
      by: data.user,
      status: data.status || "معلق",
      note: "تم إنشاء الشحنة",
    };

    var row = _shipmentRowFromData(data, { id: id });
    row[0] = id;
    _appendRowProtected(sheet, SHIPMENT_HEADERS_V2, row);

    AuditEngine.log("addShipment", {
      user: data.user,
      table: SHIPMENTS_SHEET,
      record_id: id,
      details: "إضافة شحنة للعميل: " + data.customer});
    _invalidateServerCacheShipping(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse(" تمت إضافة الشحنة بنجاح", { data: { id: id } });
  } catch (e) {
    return errResponse("خطأ في إضافة الشحنة: " + e.message);
  }
}

/**
 * updateShipment — تعديل شحنة موجودة
 * @param {object} data — { id, ...نفس حقول addShipment, user, sessionToken }
 */
function updateShipment(data) {
  data = data || {};
  try {
    var permErr = _checkPermission(
      data.user,
      "updateShipment",
      data.sessionToken,
    );
    if (permErr) return permErr;

    if (!ValidationEngine.isRequired(data.id)) return errResponse("معرف الشحنة مطلوب");

    var vErr = _validateShipmentData(data);
    if (vErr) return errResponse(vErr);

    var sheet = getSheet(SHIPMENTS_SHEET, SHIPMENT_HEADERS_V2);
    var vals = sheet.getDataRange().getValues();
    var idCol = SHIPMENT_HEADERS_V2.indexOf("id");
    var deletedCol = SHIPMENT_HEADERS_V2.indexOf("deleted_at");

    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][idCol] || "") === String(data.id)) {
        // لا نسمح بتعديل شحنة محذوفة
        if (vals[i][deletedCol])
          return errResponse("الشحنة محذوفة ولا يمكن تعديلها");

        // استرداد البيانات القديمة
        var existing = {};
        SHIPMENT_HEADERS_V2.forEach(function (h, idx) {
          existing[h] = vals[i][idx];
        });

        // حدث في الـ timeline لو تغيرت الحالة
        if (data.status && data.status !== existing.status) {
          data._timelineEvent = {
            at: new Date().toISOString(),
            by: data.user,
            status: data.status,
            note: data.notes || "تعديل الشحنة",
          };
        }

        var row = _shipmentRowFromData(data, existing);
        row[0] = data.id;
        // [ARCH-AUDIT-P3-2] getRange().setValues() خام → DataLayerEngine.update.
        // _shipmentRowFromData بتبني صف كامل (كل الحقول من data، مع fallback
        // لـ existing) فمفيش فرق سلوكي: بنحوّل نفس الصف لكائن مفاتيح=هيدرز
        // ونمرره كـ patch كامل، وupdate() بيكتب بنفس الطريقة (getRange+setValues)
        // لكن من مسار موحّد.
        var _shpPatch = {};
        SHIPMENT_HEADERS_V2.forEach(function (h, idx) {
          _shpPatch[h] = row[idx];
        });
        var _shpUpdateResult = DataLayerEngine.update(
          "Shipments",
          data.id,
          _shpPatch,
          { headers: SHIPMENT_HEADERS_V2 },
        );
        if (!_shpUpdateResult.ok)
          return errResponse(
            _shpUpdateResult.errorMessage || "تعذّر حفظ تعديلات الشحنة",
          );

        AuditEngine.log("updateShipment", {
          user: data.user,
          table: SHIPMENTS_SHEET,
          record_id: data.id,
          details: "تعديل شحنة: " + data.customer});
        _invalidateServerCacheShipping(); // [PERF-SCOPED-INVALIDATION] scoped
        return okResponse(" تم حفظ التعديلات بنجاح");
      }
    }
    return errResponse("الشحنة غير موجودة");
  } catch (e) {
    return errResponse("خطأ في تعديل الشحنة: " + e.message);
  }
}

/**
 * deleteShipment — حذف شحنة (soft-delete)
 * @param {string} callerUser
 * @param {string} id
 * @param {string} [sessionToken]
 */
function deleteShipment(callerUser, id, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "deleteShipment", sessionToken);
    if (permErr) return permErr;

    if (!ValidationEngine.isRequired(id)) return errResponse("معرف الشحنة مطلوب");

    var sheet = getSheet(SHIPMENTS_SHEET, SHIPMENT_HEADERS_V2);
    var vals = sheet.getDataRange().getValues();
    var idCol = SHIPMENT_HEADERS_V2.indexOf("id");
    var statusCol = SHIPMENT_HEADERS_V2.indexOf("status");
    var deletedCol = SHIPMENT_HEADERS_V2.indexOf("deleted_at");
    var updatedCol = SHIPMENT_HEADERS_V2.indexOf("updated_at");
    var timelineCol = SHIPMENT_HEADERS_V2.indexOf("timeline_json");

    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][idCol] || "") === String(id)) {
        if (vals[i][deletedCol]) return errResponse("الشحنة محذوفة بالفعل");

        // منع حذف شحنة في الطريق
        var currentStatus = String(vals[i][statusCol] || "");
        if (currentStatus === "في الطريق") {
          return errResponse(
            " لا يمكن حذف شحنة في الطريق — قم بتغيير حالتها أولاً",
          );
        }

        var now = new Date().toISOString();

        // تحديث timeline
        var timelineArr = [];
        try {
          timelineArr = JSON.parse(
            String(vals[i][timelineCol] || "[]") || "[]",
          );
        } catch (e) {
          timelineArr = [];
        }
        timelineArr.push({
          at: now,
          by: callerUser,
          status: "محذوف",
          note: "تم حذف الشحنة",
        });

        sheet.getRange(i + 1, deletedCol + 1).setValue(now);
        sheet.getRange(i + 1, updatedCol + 1).setValue(now);
        sheet
          .getRange(i + 1, timelineCol + 1)
          .setValue(JSON.stringify(timelineArr));

        AuditEngine.log("deleteShipment", {
          user: callerUser,
          table: SHIPMENTS_SHEET,
          record_id: id,
          details: "حذف شحنة"});
        _invalidateServerCacheShipping(); // [PERF-SCOPED-INVALIDATION] scoped
        return okResponse(" تم حذف الشحنة بنجاح");
      }
    }
    return errResponse("الشحنة غير موجودة");
  } catch (e) {
    return errResponse("خطأ في حذف الشحنة: " + e.message);
  }
}

/**
 * updateShipmentStatus — تحديث حالة شحنة مع Timeline كامل
 * @param {string} callerUser
 * @param {string} id — معرف الشحنة
 * @param {string} newStatus — الحالة الجديدة
 * @param {string} [notes] — ملاحظة اختيارية
 * @param {string} [sessionToken]
 */
function updateShipmentStatus(callerUser, id, newStatus, notes, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "updateShipment", sessionToken);
    if (permErr) return permErr;

    if (!ValidationEngine.isRequired(id)) return errResponse("معرف الشحنة مطلوب");
    if (!newStatus) return errResponse("الحالة الجديدة مطلوبة");
    if (VALID_SHIPMENT_STATUSES.indexOf(newStatus) === -1)
      return errResponse("حالة غير صالحة: " + newStatus);

    var sheet = getSheet(SHIPMENTS_SHEET, SHIPMENT_HEADERS_V2);
    var vals = sheet.getDataRange().getValues();
    var idCol = SHIPMENT_HEADERS_V2.indexOf("id");
    var statusCol = SHIPMENT_HEADERS_V2.indexOf("status");
    var timelineCol = SHIPMENT_HEADERS_V2.indexOf("timeline_json");
    var updatedCol = SHIPMENT_HEADERS_V2.indexOf("updated_at");
    var deliveryCol = SHIPMENT_HEADERS_V2.indexOf("actual_delivery_date");
    var deletedCol = SHIPMENT_HEADERS_V2.indexOf("deleted_at");

    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][idCol] || "") === String(id)) {
        if (vals[i][deletedCol]) return errResponse("الشحنة محذوفة");

        var oldStatus = String(vals[i][statusCol] || "");
        if (oldStatus === newStatus)
          return errResponse("الشحنة في نفس الحالة بالفعل");

        var now = new Date().toISOString();

        // تحديث الـ timeline
        var timelineArr = [];
        try {
          timelineArr = JSON.parse(
            String(vals[i][timelineCol] || "[]") || "[]",
          );
        } catch (e) {
          timelineArr = [];
        }
        timelineArr.push({
          at: now,
          by: callerUser,
          from: oldStatus,
          status: newStatus,
          note: notes || "",
        });

        // [ENGINE-AUDIT / Update Engine] كان بينادي setValue لحد 4 نداءات
        // منفصلة (status/updated_at/timeline_json/actual_delivery_date) —
        // استُبدل بـ _applyRowUpdates الموحّدة (نداء قراءة واحد + كتابة واحدة).
        var _shipUpdates = {
          status: newStatus,
          updated_at: now,
          timeline_json: JSON.stringify(timelineArr),
        };
        // لو تم التسليم، سجّل التاريخ الفعلي
        if (newStatus === "تم التسليم") {
          _shipUpdates.actual_delivery_date = now.split("T")[0];
        }
        _applyRowUpdates(sheet, i + 1, SHIPMENT_HEADERS_V2, _shipUpdates);

        AuditEngine.log("updateShipmentStatus", {
          user: callerUser,
          table: SHIPMENTS_SHEET,
          record_id: id,
          details: oldStatus + " ← " + newStatus + (notes ? " | " + notes : "")});
        _invalidateServerCacheShipping(); // [PERF-SCOPED-INVALIDATION] scoped
        return okResponse(" تم تحديث الحالة إلى: " + newStatus, {
          data: { id: id, oldStatus: oldStatus, newStatus: newStatus },
        });
      }
    }
    return errResponse("الشحنة غير موجودة");
  } catch (e) {
    return errResponse("خطأ في تحديث الحالة: " + e.message);
  }
}

/**
 * getShipments — جلب كل الشحنات (غير المحذوفة)
 * محدّثة لتقرأ الأعمدة الجديدة
 */
function getShipments() {
  try {
    var rows = readSheet(SHIPMENTS_SHEET, SHIPMENT_HEADERS_V2, {
      parseJson: ["items_json", "timeline_json"],
    });
    // فلترة المحذوفة
    rows = rows.filter(function (r) {
      return !r.deleted_at;
    });
    rows.forEach(function (r) {
      r.items = r.items_json || [];
      r.timeline = r.timeline_json || [];
    });
    return { success: true, data: rows };
  } catch (e) {
    // fallback: قراءة بدون headers محددة (شيت قديم بدون أعمدة جديدة)
    try {
      var oldRows = readSheet(SHIPMENTS_SHEET, null, {
        parseJson: ["items_json"],
      });
      oldRows = oldRows.filter(function (r) {
        return !r.deleted_at;
      });
      oldRows.forEach(function (r) {
        r.items = r.items_json || [];
      });
      return { success: true, data: oldRows };
    } catch (e2) {
      return { success: false, message: e2.message, data: [] };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §19-PHASE3  Shipping × Sales Integration — المرحلة 3: التكامل مع المبيعات
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * calcShippingCost — يحتسب تكلفة الشحن تلقائياً من إعدادات شركة الشحن
 *
 * @param {string} companyId    — معرف شركة الشحن
 * @param {number} invoiceTotal — إجمالي قيمة الفاتورة (للاحتساب بالنسبة)
 * @param {number} [weightKg]   — وزن الشحنة بالكيلوجرام (اختياري)
 * @param {number} [volumeM3]   — حجم الشحنة بالمتر مكعب (اختياري)
 * @param {number} [distanceKm] — المسافة بالكيلومتر (اختياري)
 * @returns {{ success:boolean, cost:number, method:string, message?:string }}
 */
function calcShippingCost(
  companyId,
  invoiceTotal,
  weightKg,
  volumeM3,
  distanceKm,
) {
  try {
    if (!ValidationEngine.isRequired(companyId))
      return { success: false, cost: 0, message: "معرف شركة الشحن مطلوب" };

    var rows = readSheet(SHIPPING_COMPANIES_SHEET, SHIPPING_COMPANY_HEADERS, {
      parseJson: ["pricing_tiers_json"],
    });
    var co = rows.find(function (r) {
      return r.id === companyId;
    });
    if (!co)
      return { success: false, cost: 0, message: "شركة الشحن غير موجودة" };
    if (co.active === false || co.active === "FALSE")
      return { success: false, cost: 0, message: "شركة الشحن موقوفة" };

    var method = co.costing_method || "fixed";
    var cost = 0;

    if (method === "fixed") {
      cost = Number(co.fixed_cost || 0);
    } else if (method === "by_weight") {
      if (!weightKg)
        return {
          success: false,
          cost: 0,
          message: "الوزن مطلوب لطريقة 'حسب الوزن'",
        };
      cost = Number(co.cost_per_kg || 0) * Number(weightKg);
    } else if (method === "by_volume") {
      if (!volumeM3)
        return {
          success: false,
          cost: 0,
          message: "الحجم مطلوب لطريقة 'حسب الحجم'",
        };
      cost = Number(co.cost_per_m3 || 0) * Number(volumeM3);
    } else if (method === "by_distance") {
      if (!distanceKm)
        return {
          success: false,
          cost: 0,
          message: "المسافة مطلوبة لطريقة 'حسب المسافة'",
        };
      cost = Number(co.cost_per_km || 0) * Number(distanceKm);
    } else if (method === "by_invoice_value") {
      cost =
        (Number(co.cost_percentage || 0) / 100) * Number(invoiceTotal || 0);
    } else if (method === "tiers") {
      // الشرائح: [{from:0,to:5,cost:30}, {from:5,to:20,cost:20}, ...]
      // نستخدم إجمالي الفاتورة كالمعيار الافتراضي للشرائح
      var tiers = Array.isArray(co.pricing_tiers_json)
        ? co.pricing_tiers_json
        : [];
      var val = Number(invoiceTotal || 0);
      var matched = false;
      for (var t = 0; t < tiers.length; t++) {
        var tier = tiers[t];
        var from = Number(tier.from || 0);
        var to = Number(tier.to || 0);
        var tierCost = Number(tier.cost || 0);
        if (val >= from && (to === 0 || val <= to)) {
          cost = tierCost;
          matched = true;
          break;
        }
      }
      if (!matched && tiers.length > 0) {
        // خارج كل الشرائح — استخدم آخر شريحة
        cost = Number(tiers[tiers.length - 1].cost || 0);
      }
    } else {
      // طريقة غير معروفة — نُرجع الأساسي
      cost = Number(co.fixed_cost || 0);
    }

    return {
      success: true,
      cost: Math.round(cost * 100) / 100,
      method: method,
      company_name: co.name,
    };
  } catch (e) {
    return {
      success: false,
      cost: 0,
      message: "خطأ في احتساب تكلفة الشحن: " + e.message,
    };
  }
}

/**
 * linkShipmentToInvoice — يربط شحنة بفاتورة مبيعات ويحدّث كلاً منهما
 *
 * @param {string} callerUser
 * @param {string} shipmentId
 * @param {string} invoiceId
 * @param {number} [shippingCost]   — تكلفة الشحن (إن لم تُحدد، يُحتسب تلقائياً)
 * @param {string} [shippingCostOn] — "company" | "customer"
 * @param {string} [sessionToken]
 */
function linkShipmentToInvoice(
  callerUser,
  shipmentId,
  invoiceId,
  shippingCost,
  shippingCostOn,
  sessionToken,
) {
  try {
    var permErr = _checkPermission(callerUser, "updateShipment", sessionToken);
    if (permErr) return permErr;

    if (!ValidationEngine.isRequired(shipmentId)) return errResponse("معرف الشحنة مطلوب");
    if (!ValidationEngine.isRequired(invoiceId)) return errResponse("معرف الفاتورة مطلوب");

    // ── جلب الشحنة ──
    var shSheet = getSheet(SHIPMENTS_SHEET, SHIPMENT_HEADERS_V2);
    var shVals = shSheet.getDataRange().getValues();
    var shIdCol = SHIPMENT_HEADERS_V2.indexOf("id");
    var shDeletedCol = SHIPMENT_HEADERS_V2.indexOf("deleted_at");
    var shInvoiceCol = SHIPMENT_HEADERS_V2.indexOf("company_id"); // نستخدم عمود موجود؟ — لا، نضيف invoice_id
    // ملاحظة: SHIPMENT_HEADERS_V2 ليس فيه invoice_id — نستخدم notes مؤقتاً؟ لا.
    // الأفضل: نحفظ على الفاتورة فقط (الفاتورة تُشير للشحنة)، والشحنة تُشير للفاتورة عبر عمود جديد.
    // لكن لتجنب تعديل الشيت دلوقتي، نحدّث الفاتورة فقط وهي الـ source of truth.

    var shipmentFound = false;
    var shipmentCustomer = "";
    for (var si = 1; si < shVals.length; si++) {
      if (String(shVals[si][shIdCol] || "") === String(shipmentId)) {
        if (shVals[si][shDeletedCol]) return errResponse("الشحنة محذوفة");
        shipmentFound = true;
        shipmentCustomer = String(
          shVals[si][SHIPMENT_HEADERS_V2.indexOf("customer")] || "",
        );
        break;
      }
    }
    if (!shipmentFound) return errResponse("الشحنة غير موجودة: " + shipmentId);

    // ── جلب الفاتورة وتحديثها ──
    var invSheet = getSheet("SaleInvoices");
    var invVals = invSheet.getDataRange().getValues();
    var invHeaders = invVals[0].map(function (h) {
      return String(h);
    });
    var invIdCol = invHeaders.indexOf("id");
    var invShipIdCol = invHeaders.indexOf("shipment_id");
    var invShipCostCol = invHeaders.indexOf("shipping_cost");
    var invShipOnCol = invHeaders.indexOf("shipping_cost_on");

    // لو الأعمدة الجديدة مش موجودة بعد (شيت قديم) — نُبلّغ بطريقة مفيدة
    if (invShipIdCol === -1) {
      return errResponse(
        "أعمدة الشحن غير موجودة في شيت الفواتير بعد — شغّل setupSaleInvoicesSheet() أولاً",
      );
    }

    var invoiceFound = false;
    for (var ii = 1; ii < invVals.length; ii++) {
      if (String(invVals[ii][invIdCol] || "") === String(invoiceId)) {
        invoiceFound = true;
        var finalCost = Number(shippingCost || 0);
        // [PERF] كانت 3 نداءات setValue منفصلة لنفس الصف (3 رحلات I/O).
        // بما إن الأعمدة الثلاثة (shipment_id, shipping_cost, shipping_cost_on)
        // متجاورة في الهيدر، نقرا القيم الحالية للصف مرة واحدة، نعدّلها في
        // الميموري، ونكتبها كلها بـ setValues نداء واحد.
        var invMinCol = Math.min(
          invShipIdCol,
          invShipCostCol,
          invShipOnCol,
        );
        var invMaxCol = Math.max(
          invShipIdCol,
          invShipCostCol,
          invShipOnCol,
        );
        var invRowRange = invSheet.getRange(
          ii + 1,
          invMinCol + 1,
          1,
          invMaxCol - invMinCol + 1,
        );
        var invRowValues = invRowRange.getValues();
        invRowValues[0][invShipIdCol - invMinCol] = shipmentId;
        if (finalCost > 0) {
          invRowValues[0][invShipCostCol - invMinCol] = finalCost;
        }
        invRowValues[0][invShipOnCol - invMinCol] =
          shippingCostOn || "company";
        invRowRange.setValues(invRowValues);
        break;
      }
    }
    if (!invoiceFound) return errResponse("الفاتورة غير موجودة: " + invoiceId);

    AuditEngine.log("linkShipmentToInvoice", {
      user: callerUser,
      table: "SaleInvoices",
      record_id: invoiceId,
      details: "ربط الشحنة " + shipmentId + " بالفاتورة " + invoiceId});
    _invalidateServerCacheShipping(); // [PERF-SCOPED-INVALIDATION] scoped
    return okResponse(" تم ربط الشحنة بالفاتورة بنجاح", {
      data: { shipmentId: shipmentId, invoiceId: invoiceId },
    });
  } catch (e) {
    return errResponse("خطأ في ربط الشحنة بالفاتورة: " + e.message);
  }
}

/**
 * getInvoicesForShipping — جلب الفواتير القابلة للشحن (مؤكدة وبدون شحنة مرتبطة بها)
 * تُستخدم لتعبئة dropdown اختيار الفاتورة في مودال الشحنة
 *
 * @param {string} callerUser
 * @param {string} [sessionToken]
 * @returns {Array<{id, date, party, net_total, shipment_id}>}
 */
function getInvoicesForShipping(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "viewSaleInvoices",
      sessionToken,
    );
    if (permErr) return permErr;

    var rows = readSheet("SaleInvoices", SALE_INVOICE_HEADERS, {
      trimStrings: true,
    });
    // فواتير مؤكدة (لم تُحذف) وليس عليها شحنة بعد
    var available = rows.filter(function (r) {
      return !r.deleted_at && r.status !== "cancelled" && !r.shipment_id;
    });
    // نرجع فقط الحقول الضرورية لتخفيف الحجم
    var light = available.map(function (r) {
      return {
        id: r.id,
        date: r.date,
        party: r.party,
        net_total: r.net_total,
        permit_id: r.permit_id,
      };
    });
    // ترتيب تنازلي حسب التاريخ
    light.sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
    return { success: true, data: light };
  } catch (e) {
    return { success: false, data: [], message: e.message };
  }
}

/**
 * setupSaleInvoicesSheet — يُضيف أعمدة الشحن للشيت الموجود بأمان
 * شغّلها مرة واحدة بعد رفع الكود
 */
function setupSaleInvoicesSheet() {
  try {
    getSheet("SaleInvoices", SALE_INVOICE_HEADERS);
    return " تم تحديث شيت الفواتير بأعمدة الشحن الجديدة";
  } catch (e) {
    return " خطأ: " + e.message;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §19-PHASE4  Shipping Accounting — المرحلة 4: القيود المحاسبية للشحن
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * autoJournalFromShipment — قيد محاسبي تلقائي عند تأكيد الشحنة
 *
 * سيناريوهان:
 *  1) shippingCostOn = "company"  → مدين: مصروف الشحن  |  دائن: ح/شركة الشحن (AP)
 *  2) shippingCostOn = "customer" → مدين: ح/العميل (AR) |  دائن: إيراد الشحن
 *
 * الحسابات تُقرأ من إعدادات شركة الشحن أولاً (expense_account_id / supplier_account_id / vat_account_id)
 * ثم fallback لدليل الحسابات العام بـ _getDefaultAccount.
 *
 * @param {object} p
 * @param {string} p.shipmentId
 * @param {number} p.shippingCost
 * @param {string} p.shippingCostOn  "company" | "customer"
 * @param {string} p.companyId       معرف شركة الشحن (اختياري)
 * @param {string} p.customerId      اسم العميل (للوصف)
 * @param {string} p.callerUser
 * @param {string} [p.date]
 * @returns {{ success:boolean, message?:string }}
 */
function autoJournalFromShipment(p) {
  try {
    var cost = Number(p.shippingCost || 0);
    if (!ValidationEngine.isPositive(cost))
      return { success: false, message: "لا توجد تكلفة شحن للتسجيل" };

    // [P9-FIX] حارس منع التكرار (idempotency guard) — كانت الدالة تُنشئ
    // قيد تكلفة شحن (وقيد VAT المرتبط) من غير أي فحص لوجود قيد سابق لنفس
    // الشحنة، فكان استدعاؤها مرتين لنفس الشحنة (تراجع/إعادة إرسال الحالة)
    // يُنشئ قيدًا مضاعَفًا. نفس منطق الحارس المستخدم في postDepreciation.
    var _existingShipmentEntries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var _alreadyPostedShipment = _existingShipmentEntries.some(function (e) {
      return (
        e.reference === (p.shipmentId || "") &&
        e.source_type === "SHIPMENT" &&
        e.status !== "CANCELLED" &&
        e.status !== "REVERSED"
      );
    });
    if (_alreadyPostedShipment)
      return {
        success: false,
        message: "تم تسجيل قيد شحن لهذه الشحنة مسبقاً",
      };

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    accounts = accounts.filter(function (a) {
      return !a.deleted_at;
    });

    // ── حسابات شركة الشحن (إن وُجدت) ──
    var co = null;
    if (p.companyId) {
      var coRows = readSheet(
        SHIPPING_COMPANIES_SHEET,
        SHIPPING_COMPANY_HEADERS,
        { trimStrings: true },
      );
      co =
        coRows.find(function (r) {
          return r.id === p.companyId;
        }) || null;
    }

    // ── حل الحسابات وفق تسلسل الأولويات: Entity Override (شركة الشحن) ثم Global Default ──
    var expenseResolved = resolvePostingAccount({
      accounts: accounts,
      key: "shipping_expense_account",
      type: "EXPENSE",
      hints: [
        "مصروف الشحن",
        "مصاريف شحن",
        "تكلفة الشحن",
        "مصاريف توصيل",
        "shipping expense",
      ],
      entityAccountId: co && co.expense_account_id,
    });
    var supplierResolved = resolvePostingAccount({
      accounts: accounts,
      key: "ap_account",
      type: "LIABILITY",
      hints: ["دائنون", "موردون", "حسابات دائنة", "accounts payable"],
      entityAccountId: co && co.supplier_account_id,
    });
    var vatAccId = co && co.vat_account_id ? co.vat_account_id : null;
    var expenseAccId = expenseResolved.account
      ? expenseResolved.account.id
      : null;
    var supplierAccId = supplierResolved.account
      ? supplierResolved.account.id
      : null;

    var lines = [];
    var desc =
      "تكلفة شحن — " + (p.customerId || "") + " — " + (co ? co.name : "");

    if (p.shippingCostOn === "customer") {
      // العميل يتحمل التكلفة → مدين: ح/العميل | دائن: إيراد خدمة شحن
      var arAcc = _getDefaultAccount("ar_account", accounts, "ASSET", [
        "مدينون",
        "عملاء",
        "حسابات مدينة",
        "accounts receivable",
      ]);
      var shRevAcc = _getDefaultAccount(
        "shipping_revenue_account",
        accounts,
        "REVENUE",
        ["إيراد الشحن", "إيرادات خدمات", "خدمات شحن", "shipping revenue"],
      );
      if (arAcc)
        lines.push({
          account_id: arAcc.id,
          debit: cost,
          credit: 0,
          notes: "تكلفة شحن على العميل",
        });
      if (shRevAcc)
        lines.push({
          account_id: shRevAcc.id,
          debit: 0,
          credit: cost,
          notes: "إيراد خدمة شحن",
        });
    } else {
      // الشركة تتحمل التكلفة → مدين: مصروف الشحن | دائن: ح/شركة الشحن
      if (expenseAccId)
        lines.push({
          account_id: expenseAccId,
          debit: cost,
          credit: 0,
          notes: "مصروف شحن",
        });
      if (supplierAccId)
        lines.push({
          account_id: supplierAccId,
          debit: 0,
          credit: cost,
          notes: "مستحق لشركة الشحن " + (co ? co.name : ""),
        });
    }

    if (lines.length < 2) {
      // حسابات ناقصة — لا نُوقف العملية، فقط نُسجّل تحذيراً
      console.warn(
        "[autoJournalFromShipment] حسابات غير مكتملة — القيد لم يُنشأ للشحنة: " +
          p.shipmentId,
      );
      return {
        success: false,
        message: "حسابات الشحن غير مكتملة في دليل الحسابات — القيد لم يُنشأ",
      };
    }

    _addJournalEntryInternal({
      callerUser: p.callerUser || "SYSTEM",
      date: p.date || new Date().toISOString().split("T")[0],
      reference: p.shipmentId || "",
      source_type: "SHIPMENT",
      description: desc,
      lines: lines,
    });

    // قيد VAT إن وُجد حساب ضريبة وكانت الشركة تتحمل التكلفة
    if (
      p.shippingCostOn !== "customer" &&
      vatAccId &&
      co &&
      Number(co.vat_percent || 0) > 0
    ) {
      // [P9-FIX] نفس حارس منع التكرار، مُطبَّق باستقلالية على قيد الـ VAT
      // (source_type مختلف عن القيد الرئيسي، فيحتاج فحصًا منفصلاً).
      var _alreadyPostedVat = _existingShipmentEntries.some(function (e) {
        return (
          e.reference === (p.shipmentId || "") &&
          e.source_type === "SHIPMENT_VAT" &&
          e.status !== "CANCELLED" &&
          e.status !== "REVERSED"
        );
      });
      var vatAmount =
        Math.round(((cost * Number(co.vat_percent)) / 100) * 100) / 100;
      if (supplierAccId && !_alreadyPostedVat) {
        _addJournalEntryInternal({
          callerUser: p.callerUser || "SYSTEM",
          date: p.date || new Date().toISOString().split("T")[0],
          reference: p.shipmentId || "",
          source_type: "SHIPMENT_VAT",
          description: "ضريبة قيمة مضافة على الشحن — " + (co ? co.name : ""),
          lines: [
            {
              account_id: vatAccId,
              debit: vatAmount,
              credit: 0,
              notes: "ضريبة شحن (مدخلات)",
            },
            {
              account_id: supplierAccId,
              debit: 0,
              credit: vatAmount,
              notes: "مستحق ضريبة شحن",
            },
          ],
        });
      }
    }

    return okResponse(" تم إنشاء القيد المحاسبي للشحنة بنجاح");
  } catch (e) {
    return errResponse("خطأ في قيد الشحن: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §19-PHASE5  Shipment Tracking & Notifications — المرحلة 5
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * SHIPMENT_NOTIFY_TEMPLATES — قوالب إشعارات الشحن لكل تغيير حالة
 * كل entry: { subject, body } — body يدعم placeholders بالشكل {{key}}
 */
var SHIPMENT_NOTIFY_TEMPLATES = {
  "جاهز للشحن": {
    subject: " شحنتك جاهزة للإرسال",
    body: "السلام عليكم ورحمة الله\nأستاذ/ة {{customer_name}}،\n\nيسعدنا إخطاركم بأن طلبكم جاهز للشحن:\n\n رقم الشحنة: {{shipment_id}}\n شركة الشحن: {{company_name}}\n تاريخ الشحن المتوقع: {{expected_date}}\n\nسنتواصل معكم فور بدء التوصيل.\nشكراً لثقتكم في {{shop_name}} ",
  },
  "في الطريق": {
    subject: " شحنتك في الطريق إليك",
    body: "السلام عليكم ورحمة الله\nأستاذ/ة {{customer_name}}،\n\nشحنتك الآن في الطريق إليكم \n\n رقم الشحنة: {{shipment_id}}\n السائق: {{driver_name}}\n{{tracking_line}}\n موعد التسليم المتوقع: {{expected_date}}\n\nللاستفسار تواصلوا معنا.\nشركة {{shop_name}} ",
  },
  "تم التسليم": {
    subject: " تم تسليم طلبكم بنجاح",
    body: "السلام عليكم ورحمة الله\nأستاذ/ة {{customer_name}}،\n\nيسعدنا إبلاغكم بأنه تم تسليم طلبكم بنجاح \n\n رقم الشحنة: {{shipment_id}}\n تاريخ التسليم: {{actual_date}}\n\nنأمل أن تكونوا راضين عن الخدمة.\nنتطلع لخدمتكم دائماً في {{shop_name}} ",
  },
  تأخر: {
    subject: " تأخر في تسليم شحنتك",
    body: "السلام عليكم ورحمة الله\nأستاذ/ة {{customer_name}}،\n\nنعتذر عن التأخر في تسليم شحنتكم:\n\n رقم الشحنة: {{shipment_id}}\n السبب: {{notes}}\n\nنعمل على حل المشكلة بأسرع وقت ممكن وسنتواصل معكم قريباً.\nنعتذر بشدة عن الإزعاج.\nشركة {{shop_name}} ",
  },
  مُعاد: {
    subject: " تم إرجاع شحنتك",
    body: "السلام عليكم ورحمة الله\nأستاذ/ة {{customer_name}}،\n\nنُحيطكم علماً بأنه تم إرجاع الشحنة:\n\n رقم الشحنة: {{shipment_id}}\n السبب: {{notes}}\n\nسيتواصل معكم فريقنا لترتيب إعادة الشحن أو الإرجاع.\nشركة {{shop_name}} ",
  },
};

/**
 * _resolveShipmentNotifyMsg — يُجهّز نص الإشعار بتعبئة الـ Placeholders
 */
function _resolveShipmentNotifyMsg(template, ctx) {
  var body = template.body || "";
  var keys = [
    "customer_name",
    "shipment_id",
    "company_name",
    "driver_name",
    "expected_date",
    "actual_date",
    "tracking_line",
    "notes",
    "shop_name",
  ];
  keys.forEach(function (k) {
    var val = ctx[k] !== undefined ? String(ctx[k]) : "";
    body = body.split("{{" + k + "}}").join(val);
  });
  return body;
}

/**
 * sendShipmentNotification — إرسال إشعار واتساب لتغيير حالة الشحنة
 *
 * يُستدعى تلقائياً من updateShipmentStatus وكذلك يمكن استدعاؤه يدوياً
 *
 * @param {string} callerUser
 * @param {string} shipmentId
 * @param {string} [sessionToken]
 * @returns {{ success:boolean, message?:string, wa_log_id?:string }}
 */
function sendShipmentNotification(callerUser, shipmentId, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(callerUser, "updateShipment", sessionToken);
    if (permErr) return permErr;

    // ── جلب بيانات الشحنة ──
    var shRows = readSheet(SHIPMENTS_SHEET, SHIPMENT_HEADERS_V2, {
      parseJson: ["items_json", "timeline_json"],
    });
    var ship = shRows.find(function (r) {
      return r.id === shipmentId && !r.deleted_at;
    });
    if (!ship) return errResponse("الشحنة غير موجودة: " + shipmentId);

    var status = String(ship.status || "");
    var tpl = SHIPMENT_NOTIFY_TEMPLATES[status];
    if (!tpl)
      return { success: false, message: "لا يوجد قالب إشعار لحالة: " + status };

    // ── جلب بيانات العميل (رقم الهاتف) ──
    var customerPhone = "";
    var customerName = ship.customer || "";
    if (ship.customer) {
      var parties = readSheet("Parties", null, { trimStrings: true });
      var party = parties.find(function (p) {
        return p.name === ship.customer || p.id === ship.customer;
      });
      if (party) {
        customerPhone = String(party.phone || party.mobile || "").trim();
        customerName = party.name || customerName;
      }
    }
    if (!customerPhone)
      return {
        success: false,
        message: "لا يوجد رقم هاتف مسجل للعميل «" + customerName + "»",
      };

    // ── جلب اسم شركة الشحن ──
    var coName = ship.company || "";
    if (ship.company_id) {
      var coRows = readSheet(
        SHIPPING_COMPANIES_SHEET,
        SHIPPING_COMPANY_HEADERS,
        { trimStrings: true },
      );
      var co = coRows.find(function (r) {
        return r.id === ship.company_id;
      });
      if (co) coName = co.name;
    }

    // ── إعدادات الشركة ──
    var settings = readSheet("Settings", null, { trimStrings: true });
    var shopName = "شركتنا";
    if (settings && settings.length > 0) {
      var nameSetting = settings.find(function (s) {
        return s.key === "company_name" || s.key === "shop_name";
      });
      if (nameSetting) shopName = nameSetting.value || shopName;
    }

    var trackingLine = "";
    if (ship.tracking_number) {
      trackingLine = " رقم التتبع: " + ship.tracking_number;
      if (ship.tracking_url)
        trackingLine += "\n تتبع شحنتك: " + ship.tracking_url;
    }

    var actualDate = ship.actual_delivery_date
      ? Utilities.formatDate(
          new Date(ship.actual_delivery_date),
          Session.getScriptTimeZone(),
          "dd/MM/yyyy",
        )
      : Utilities.formatDate(
          new Date(),
          Session.getScriptTimeZone(),
          "dd/MM/yyyy",
        );
    var expDate = ship.expected_date
      ? Utilities.formatDate(
          new Date(ship.expected_date),
          Session.getScriptTimeZone(),
          "dd/MM/yyyy",
        )
      : "—";

    var ctx = {
      customer_name: customerName,
      shipment_id: ship.id,
      company_name: coName,
      driver_name: ship.driver || "—",
      expected_date: expDate,
      actual_date: actualDate,
      tracking_line: trackingLine,
      notes: ship.notes || "—",
      shop_name: shopName,
    };

    var msgBody = _resolveShipmentNotifyMsg(tpl, ctx);

    // ── تسجيل الإرسال في WhatsAppLog ──
    var waLogId = _writeWhatsAppLog({
      sent_by: callerUser,
      customer_id: ship.customer || "",
      customer_name: customerName,
      phone_used: customerPhone,
      template_code: "shipment_" + status,
      template_name: "إشعار شحن — " + status,
      rendered_message: msgBody,
      source_type: "shipment",
      source_id: shipmentId,
      provider_mode: "direct",
      status: "opened",
    });

    AuditEngine.log("shipment_notify", {
      user: callerUser,
      table: SHIPMENTS_SHEET,
      record_id: shipmentId,
      details:
        "إرسال إشعار واتساب — حالة: " + status + " — عميل: " + customerName});

    return okResponse(" تم تجهيز الإشعار", {
      wa_log_id: waLogId,
      phone: customerPhone,
      customer: customerName,
      message: msgBody,
      status: status,
      // نُرجع الرابط الجاهز ليفتحه الفرونت إند مباشرة
      whatsapp_url:
        "https://wa.me/" +
        customerPhone.replace(/[^0-9]/g, "") +
        "?text=" +
        encodeURIComponent(msgBody),
    });
  } catch (e) {
    return errResponse("خطأ في إرسال الإشعار: " + e.message);
  }
}

/**
 * updateShipmentStatusWithAccounting — تحديث الحالة + قيد محاسبي + إشعار (كل شيء في استدعاء واحد)
 *
 * @param {string} callerUser
 * @param {string} id
 * @param {string} newStatus
 * @param {string} [notes]
 * @param {object} [opts]
 * @param {boolean} [opts.postJournal=true]   — هل تنشئ القيد المحاسبي؟
 * @param {boolean} [opts.sendNotif=true]     — هل ترسل إشعار واتساب؟
 * @param {string}  [opts.sessionToken]
 * @returns {{ success:boolean, message?:string, journal?:*, notification?:* }}
 */
function updateShipmentStatusWithAccounting(
  callerUser,
  id,
  newStatus,
  notes,
  opts,
) {
  try {
    var o = opts || {};
    var sessionToken = o.sessionToken || null;

    // ── 1) تحديث الحالة (المنطق الأصلي) ──
    var statusResult = updateShipmentStatus(
      callerUser,
      id,
      newStatus,
      notes,
      sessionToken,
    );
    if (!statusResult || !statusResult.success) return statusResult;

    // ── 2) القيد المحاسبي عند الشحن (في الطريق أو تأكيد الشحن) ──
    var journalResult = null;
    if (
      o.postJournal !== false &&
      (newStatus === "في الطريق" || newStatus === "جاهز للشحن")
    ) {
      var shRows = readSheet(SHIPMENTS_SHEET, SHIPMENT_HEADERS_V2, {
        parseJson: ["items_json"],
      });
      var ship = shRows.find(function (r) {
        return r.id === id && !r.deleted_at;
      });
      if (ship && Number(ship.shipping_cost || 0) > 0) {
        journalResult = autoJournalFromShipment({
          shipmentId: id,
          shippingCost: Number(ship.shipping_cost || 0),
          shippingCostOn: ship.shipping_cost_on || "company",
          companyId: ship.company_id || null,
          customerId: ship.customer || "",
          callerUser: callerUser,
          date: new Date().toISOString().split("T")[0],
        });
      }
    }

    // ── 3) إشعار واتساب ──
    var notifResult = null;
    if (o.sendNotif !== false && SHIPMENT_NOTIFY_TEMPLATES[newStatus]) {
      notifResult = sendShipmentNotification(callerUser, id, sessionToken);
    }

    return okResponse(
      " تم تحديث الحالة" +
        (journalResult && journalResult.success ? " + قيد محاسبي" : "") +
        (notifResult && notifResult.success ? " + إشعار واتساب" : ""),
      {
        journal: journalResult,
        notification: notifResult,
      },
    );
  } catch (e) {
    return errResponse("خطأ في تحديث الحالة: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 25386-25707] Shipping Companies ┄┄┄
// §EXT-23  Shipping Companies — شركات الشحن (المرحلة 1 من موديول الشحن)
//
// شيت مستقل لإدارة شركات الشحن بكل تفاصيلها: البيانات الأساسية، الربط
// المحاسبي (بدون أي حساب Hardcoded — كل الحسابات تُختار من دليل الحسابات
// الفعلي عبر account_id)، وإعدادات الشحن (مدة التوصيل، الحدود، طريقة
// احتساب التكلفة بما فيها شرائح الأسعار).
//
// مركز التكلفة: لا يوجد في النظام حالياً جدول "مراكز تكلفة" مستقل
// (CostCenters) — فقط حقل تفضيل نصي حر default_cost_center في
// UserPreferences. لذلك خزّنّا cost_center هنا كحقل نصي حر بدل ربطه
// بجدول غير موجود. لو لاحقاً اتعمل موديول مراكز تكلفة حقيقي، يسهل تحويل
// هذا الحقل لـ cost_center_id بربط فعلي.
// ═══════════════════════════════════════════════════════════════════════════════

var SHIPPING_COMPANIES_SHEET = "ShippingCompanies";

var SHIPPING_COMPANY_HEADERS = [
  "id",
  "code", // كود شركة الشحن (محمي كنص — لا يفقد الصفر الأول)
  "name",
  "logo_url",
  "shipping_type", // internal | external | international
  "phone",
  "email",
  "website",
  "address",
  "contact_person",
  "active", // true/false — نشط / موقوف
  "notes",
  // ── الربط المحاسبي (بدون Hardcoding — IDs فقط من دليل الحسابات) ──
  "supplier_account_id", // حساب المورد/الدائن الخاص بشركة الشحن
  "expense_account_id", // حساب مصروف الشحن
  "vat_account_id", // حساب ضريبة القيمة المضافة
  "cost_center", // مركز التكلفة الافتراضي (نصي حر — راجع الملاحظة أعلاه)
  // ── إعدادات الشحن ──
  "expected_delivery_days",
  "max_weight_kg",
  "max_volume_m3",
  "supported_currencies", // نص مفصول بفواصل: "EGP,USD"
  "service_areas_json", // JSON: ["القاهرة","الجيزة", ...]
  "costing_method", // fixed | by_weight | by_volume | by_distance | by_invoice_value | tiers
  "fixed_cost",
  "cost_per_kg",
  "cost_per_m3",
  "cost_per_km",
  "cost_percentage", // % من قيمة الفاتورة
  "pricing_tiers_json", // JSON: [{from:0,to:5,cost:30}, ...]
  "created_at",
  "updated_at",
  "created_by",
];

/** أنواع الشحن المسموحة (تستخدم في الفاليديشن بالباك إند) */
var SHIPPING_COMPANY_TYPES = ["internal", "external", "international"];
/** طرق احتساب تكلفة الشحن المسموحة */
var SHIPPING_COSTING_METHODS = [
  "fixed",
  "by_weight",
  "by_volume",
  "by_distance",
  "by_invoice_value",
  "tiers",
];

/**
 * getShippingCompanies — جلب كل شركات الشحن
 * @param {string} callerUser
 * @param {string} [sessionToken]
 */
function getShippingCompanies(callerUser, sessionToken) {
  try {
    if (callerUser) {
      var permErr = _checkPermission(
        callerUser,
        "viewShippingCompanies",
        sessionToken,
      );
      if (permErr) return permErr;
    }
    var rows = readSheet(SHIPPING_COMPANIES_SHEET, SHIPPING_COMPANY_HEADERS, {
      parseJson: ["service_areas_json", "pricing_tiers_json"],
    });
    rows = cleanArr(rows);
    rows.forEach(function (r) {
      r.service_areas = r.service_areas_json || [];
      r.pricing_tiers = r.pricing_tiers_json || [];
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب شركات الشحن: " + e.message);
  }
}

/**
 * _validateShippingCompanyData — فاليديشن مشترك للإضافة والتعديل
 */
function _validateShippingCompanyData(data) {
  if (!data || !ValidationEngine.isRequired(data.name)) return "اسم شركة الشحن مطلوب";
  if (
    data.shipping_type &&
    SHIPPING_COMPANY_TYPES.indexOf(data.shipping_type) === -1
  )
    return "نوع الشحن غير صحيح";
  if (
    data.costing_method &&
    SHIPPING_COSTING_METHODS.indexOf(data.costing_method) === -1
  )
    return "طريقة احتساب تكلفة الشحن غير صحيحة";
  // [VALIDATION-ENGINE-UNIFY] كان الفحص يدوي (indexOf("@")) وبيقبل صيغ
  // غير صحيحة كتير (مثلاً "a@" أو "@b.com"). دلوقتي بيمر على ValidationEngine
  // الموحّد (نفس المرجع المستخدم في BusinessRulesEngine._validatePartyFieldFormats)
  // بدل قاعدة محلية مختلفة عن باقي المشروع.
  if (
    data.email &&
    typeof ValidationEngine !== "undefined" &&
    !ValidationEngine.isValidEmail(data.email)
  )
    return "البريد الإلكتروني غير صحيح";

  // [ACCOUNTING-LOOKUP-UNIFY] فاليديشن موحد لحقول الحسابات الثلاثة —
  // كانت هذه الحقول تُحفظ بدون أي تحقق من وجودها/نشاطها/نوعها.
  if (typeof validateAccountingFieldValue === "function") {
    var accErr;
    accErr = validateAccountingFieldValue(data.supplier_account_id, {
      expectedType: "LIABILITY",
    });
    if (accErr) return "حساب المورد (الدائن): " + accErr;

    accErr = validateAccountingFieldValue(data.expense_account_id, {
      expectedType: "EXPENSE",
    });
    if (accErr) return "حساب مصروف الشحن: " + accErr;

    accErr = validateAccountingFieldValue(data.vat_account_id, {});
    if (accErr) return "حساب ضريبة القيمة المضافة: " + accErr;
  }
  return null;
}

/**
 * _shippingCompanyRowFromData — يبني صف الشيت من بيانات الفورم
 */
function _shippingCompanyRowFromData(data, existing) {
  existing = existing || {};
  var now = new Date().toISOString();
  var tiers = data.pricing_tiers;
  if (typeof tiers === "string") {
    try {
      tiers = JSON.parse(tiers);
    } catch (e) {
      tiers = [];
    }
  }
  var areas = data.service_areas;
  if (typeof areas === "string") {
    try {
      areas = JSON.parse(areas);
    } catch (e) {
      areas = [];
    }
  }
  return [
    existing.id || "", // id يُملأ خارج هذه الدالة عند الإضافة
    String(data.code || "").trim(),
    String(data.name || "").trim(),
    String(data.logo_url || "").trim(),
    String(data.shipping_type || "external").trim(),
    String(data.phone || "").trim(),
    String(data.email || "").trim(),
    String(data.website || "").trim(),
    String(data.address || "").trim(),
    String(data.contact_person || "").trim(),
    data.active === false || data.active === "false" ? false : true,
    String(data.notes || "").trim(),
    String(data.supplier_account_id || "").trim(),
    String(data.expense_account_id || "").trim(),
    String(data.vat_account_id || "").trim(),
    String(data.cost_center || "").trim(),
    Number(data.expected_delivery_days || 0),
    Number(data.max_weight_kg || 0),
    Number(data.max_volume_m3 || 0),
    String(data.supported_currencies || "EGP").trim(),
    JSON.stringify(Array.isArray(areas) ? areas : []),
    String(data.costing_method || "fixed").trim(),
    Number(data.fixed_cost || 0),
    Number(data.cost_per_kg || 0),
    Number(data.cost_per_m3 || 0),
    Number(data.cost_per_km || 0),
    Number(data.cost_percentage || 0),
    JSON.stringify(Array.isArray(tiers) ? tiers : []),
    existing.created_at || now,
    now,
    existing.created_by || data.callerUser || "",
  ];
}

/**
 * getNextShippingCompanyCode — [AUTO-CODE] معاينة الكود التسلسلي التالي
 * من الواجهة قبل الحفظ (الحقل يبقى قابلاً للتعديل يدويًا لأنه اختياري أصلاً).
 */
function getNextShippingCompanyCode() {
  return okResponse("", {
    data: _getNextSequentialCode("shippingcompany", function () {
      return readSheet(SHIPPING_COMPANIES_SHEET, SHIPPING_COMPANY_HEADERS).map(
        function (r) {
          return r.code;
        },
      );
    }),
  });
}

/**
 * addShippingCompany — إضافة شركة شحن جديدة
 * @param {object} payload — كل بيانات الفورم + callerUser + sessionToken
 */
function addShippingCompany(payload) {
  payload = payload || {};
  try {
    var permErr = _checkPermission(
      payload.callerUser,
      "addShippingCompany",
      payload.sessionToken,
    );
    if (permErr) return permErr;

    var vErr = _validateShippingCompanyData(payload);
    if (vErr) return errResponse(vErr);

    // [AUTO-CODE] كود شركة الشحن اختياري، لكن لو وصل فاضي نولّد له رقم
    // تسلسلي تلقائي (1، 2، 3...) كافتراضي بدل ما يتسجل فاضي.
    if (!payload.code || !String(payload.code).trim()) {
      payload.code = _getNextSequentialCode("shippingcompany", function () {
        return readSheet(SHIPPING_COMPANIES_SHEET, SHIPPING_COMPANY_HEADERS).map(
          function (r) {
            return r.code;
          },
        );
      });
    } else {
      // [AUTO-NUMBER-CENTRAL] فحص تكرار كان ناقصًا هنا (بخلاف الخزائن/
      // الأقسام/مراكز التكلفة اللي عندها الفحص ده بالفعل) — لو المستخدم
      // كتب كود يدويًا (سواء المقترح تلقائيًا أو كود مختلف تمامًا)، لازم
      // نتأكد إنه مش مستخدم قبل ما نسجّل الشركة.
      var _dupCheckExisting = readSheet(
        SHIPPING_COMPANIES_SHEET,
        SHIPPING_COMPANY_HEADERS,
      ).map(function (r) {
        return r.code;
      });
      if (AutoNumberService.isTaken(function () {
        return _dupCheckExisting;
      }, payload.code)) {
        return errResponse("كود شركة الشحن موجود مسبقاً — اختر كوداً آخر");
      }
    }

    var sheet = getSheet(SHIPPING_COMPANIES_SHEET, SHIPPING_COMPANY_HEADERS);
    var id = makeId("SHCO");
    var row = _shippingCompanyRowFromData(payload, { id: id });
    row[0] = id; // تأكيد الـ id في أول عمود
    _appendRowProtected(sheet, SHIPPING_COMPANY_HEADERS, row);

    AuditEngine.log("addShippingCompany", {
      user: payload.callerUser,
      table: SHIPPING_COMPANIES_SHEET,
      record_id: id,
      details: "إضافة شركة شحن: " + (payload.name || "")});
    _invalidateServerCache(EXT_DATA_CACHE_KEY);
    return {
      success: true,
      message: " تمت إضافة شركة الشحن بنجاح",
      data: { id: id },
    };
  } catch (e) {
    return errResponse("خطأ في إضافة شركة الشحن: " + e.message);
  }
}

/**
 * updateShippingCompany — تعديل شركة شحن موجودة
 * @param {object} payload — { id, ...بيانات الفورم, callerUser, sessionToken }
 */
function updateShippingCompany(payload) {
  payload = payload || {};
  try {
    var permErr = _checkPermission(
      payload.callerUser,
      "updateShippingCompany",
      payload.sessionToken,
    );
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(payload.id)) return errResponse("معرف شركة الشحن مطلوب");

    var vErr = _validateShippingCompanyData(payload);
    if (vErr) return errResponse(vErr);

    var sheet = getSheet(SHIPPING_COMPANIES_SHEET, SHIPPING_COMPANY_HEADERS);
    var vals = sheet.getDataRange().getValues();
    var idCol = SHIPPING_COMPANY_HEADERS.indexOf("id");
    var createdCol = SHIPPING_COMPANY_HEADERS.indexOf("created_at");
    var createdByCol = SHIPPING_COMPANY_HEADERS.indexOf("created_by");

    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][idCol] || "") === String(payload.id)) {
        var existing = {
          id: payload.id,
          created_at: vals[i][createdCol],
          created_by: vals[i][createdByCol],
        };
        var row = _shippingCompanyRowFromData(payload, existing);
        row[0] = payload.id;
        // [ARCH-AUDIT-P3-3] نفس تحويل updateShipment: صف كامل → patch
        // بمفاتيح الهيدرز → DataLayerEngine.update.
        var _scPatch = {};
        SHIPPING_COMPANY_HEADERS.forEach(function (h, idx) {
          _scPatch[h] = row[idx];
        });
        var _scUpdateResult = DataLayerEngine.update(
          "ShippingCompanies",
          payload.id,
          _scPatch,
          { headers: SHIPPING_COMPANY_HEADERS },
        );
        if (!_scUpdateResult.ok)
          return errResponse(
            _scUpdateResult.errorMessage || "تعذّر حفظ تعديلات شركة الشحن",
          );

        AuditEngine.log("updateShippingCompany", {
          user: payload.callerUser,
          table: SHIPPING_COMPANIES_SHEET,
          record_id: payload.id,
          details: "تعديل شركة شحن: " + (payload.name || "")});
        _invalidateServerCache(EXT_DATA_CACHE_KEY);
        return { success: true, message: " تم حفظ التعديلات بنجاح" };
      }
    }
    return errResponse("شركة الشحن غير موجودة");
  } catch (e) {
    return errResponse("خطأ في تعديل شركة الشحن: " + e.message);
  }
}

/**
 * deleteShippingCompany — حذف شركة شحن
 * [GUARD] يمنع الحذف لو الشركة مرتبطة بشحنات فعلية — يمنع كسر الربط
 * مع الشحنات القديمة (orphan references). يُقترح "إيقاف" الشركة (active=false)
 * بدل الحذف لو عندها سجل شحنات سابق.
 * @param {object} payload — { id, callerUser, sessionToken }
 */
function deleteShippingCompany(payload) {
  payload = payload || {};
  try {
    var permErr = _checkPermission(
      payload.callerUser,
      "deleteShippingCompany",
      payload.sessionToken,
    );
    if (permErr) return permErr;
    if (!ValidationEngine.isRequired(payload.id)) return errResponse("معرف شركة الشحن مطلوب");

    // تحقق من عدم وجود شحنات مرتبطة بهذه الشركة قبل الحذف النهائي
    try {
      var shipments = readSheet("Shipments", null, {});
      var inUse = shipments.some(function (s) {
        return String(s.shipping_company_id || "") === String(payload.id);
      });
      if (inUse) {
        return errResponse(
          " لا يمكن حذف هذه الشركة لوجود شحنات مرتبطة بها — يمكنك إيقافها (تعطيل) بدلاً من الحذف",
        );
      }
    } catch (e) {
      // الشيت Shipments ممكن يكون غير موجود لسه — تجاهل وامضِ في الحذف
    }

    var sheet = getSheet(SHIPPING_COMPANIES_SHEET, SHIPPING_COMPANY_HEADERS);
    var vals = sheet.getDataRange().getValues();
    var idCol = SHIPPING_COMPANY_HEADERS.indexOf("id");

    for (var i = vals.length - 1; i >= 1; i--) {
      if (String(vals[i][idCol] || "") === String(payload.id)) {
        sheet.deleteRow(i + 1);
        AuditEngine.log("deleteShippingCompany", {
          user: payload.callerUser,
          table: SHIPPING_COMPANIES_SHEET,
          record_id: payload.id,
          details: "حذف شركة شحن"});
        _invalidateServerCache(EXT_DATA_CACHE_KEY);
        return { success: true, message: " تم حذف شركة الشحن بنجاح" };
      }
    }
    return errResponse("شركة الشحن غير موجودة");
  } catch (e) {
    return errResponse("خطأ في حذف شركة الشحن: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// نهاية §EXT-23  Shipping Companies

// ============================================
// [منقولة من Code_Sales_Shipping.gs القديم عند حذفه - 2026-07-04]
// ملاحظة: هاتين الدالتين موثّقتين كـ Dead Code بتعليقات [FIX-AUDIT]
// (مش مستدعاتين من أي واجهة ولا مضافتين في DOPOST_ALLOWED_FUNCTIONS)
// اتحفظوا هنا بدل الحذف النهائي لحين قرارك بمصيرهم
// ============================================

function setupShipmentsSheet() {
  try {
    getSheet(SHIPMENTS_SHEET, SHIPMENT_HEADERS_V2);
    return " تم تحديث شيت الشحنات بالأعمدة الجديدة";
  } catch (e) {
    return " خطأ: " + e.message;
  }
}

function getWalletProviders() {
  return okResponse("OK", { providers: WALLET_PROVIDERS });
}
