// ════════════════════════════════════════════════════════════════
// Code_Accounting_Costing.gs — [REFACTOR-P4] نُقل من Code_Accounting.gs (نقل نصي بحت،
// صفر تغيير في المنطق أو الترتيب الداخلي بين الدوال). Apps Script يعامل
// كل ملفات .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء
// من أي ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// راجع تقرير Architecture Audit 2026-07-03 — المرحلة 4، قسم 4-ب.
//
// المسؤولية: تكلفة المخزون (Stock Lots / Costing) — FIFO/LIFO lots، تقييم المخزون، تسويات المخزون بالتكلفة
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 31913-33911] Phase 2 Accounting & Architecture Fixes (+ فاصل بداية) ┄┄┄
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// MOO.ERP — Phase 2 Accounting & Architecture Fixes
// Date: 2026-06-28
// Scope: Inventory Costing Engine, Fiscal Period Lock, Soft Delete,
//        Accounting Improvements, Validation, Migration Scripts
//
// DEPLOYMENT INSTRUCTIONS:
//   1. Open Code.js in Apps Script Editor
//   2. Paste this entire file at the END of Code.js (after the last line)
//   3. [COA-V2 CLEANUP-2026-08] migratePhase2() تم حذفها — كانت one-time
//      migration خلصت شغلها بالفعل ومفيش عملاء على السكيما القديمة تحتاجها.
//   4. Run: setupSheets() to add new sheet columns
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// §P2-00  NEW SCHEMA HEADERS
// ───────────────────────────────────────────────────────────────────────────

/**
 * StockLots — طبقات التكلفة لكل وحدة مخزون واردة
 * يُنشأ سجل لكل حركة IN (فاتورة شراء، مرتجع بيع، تسوية إيجابية)
 * يُستهلك تسلسلياً عند كل حركة OUT حسب طريقة التكلفة المختارة
 */
var STOCK_LOTS_HEADERS = [
  "id", // LOT-DD-MS-XXXX
  "item_id", // رابط الصنف
  "color", // اللون (أو "" للكل)
  "warehouse", // المخزن
  "qty_in", // الكمية الواردة الأصلية
  "qty_remaining", // الكمية المتبقية (تنقص مع كل OUT)
  "unit_cost", // تكلفة الوحدة الثابتة عند الدخول
  "total_cost", // qty_in * unit_cost
  "source_type", // PURCHASE_INVOICE | SALE_RETURN | ADJUSTMENT | OPENING
  "source_id", // id الفاتورة أو العملية المصدر
  "lot_date", // تاريخ الوارد (للـ FIFO)
  "created_at",
];
// ───────────────────────────────────────────────────────────────────────────
// §P2-02  HELPER: Read costing method from Settings
// ───────────────────────────────────────────────────────────────────────────

/**
 * _getCostingMethod — يقرأ طريقة التكلفة
 * [AUDIT-FIX] كان يتجاهل item.valuation_method بالكامل رغم إن الحقل معروض
 * للمستخدم في شاشة الصنف (وعد واجهة كاذب). دلوقتي: لو الصنف عنده قيمة
 * صريحة وصالحة (FIFO/AVCO) بيتم استخدامها، وإلا يرجع لإعداد المخزون العام.
 *
 * [PHASE-4-2026-08-07] ترتيب الأولوية اتغيّر:
 *   1) item.valuation_method الصريح لو صالح (FIFO/AVCO) — زي ما كان
 *   2) الإعداد العام الجديد InventorySettingsEngine.get("valuation_method")
 *      (قسم 2 في شاشة إعدادات المخزون — 57_JS_InventorySettings.html) —
 *      ده الافتراضي الجديد بدل company settings القديم، عشان يبقى
 *      InventorySettings هو الـ Single Source of Truth الفعلي لسياسة
 *      التقييم على مستوى النظام.
 *   3) fallback أخير لـ company settings القديم (costing_method) لو
 *      لأي سبب InventorySettingsEngine مش متاح (توافق خلفي بحت، الفرع
 *      ده متوقع ميتنفذش في التشغيل العادي).
 * [قرار معماري غير مؤكد من المستخدم — راجع README_HANDOFF.md §7]:
 * الصنف الفردي لسه بياخد الأولوية لو له قيمة صريحة (fallback فقط، مش
 * إجبار). لو المطلوب إن الإعداد العام يجبر كل الأصناف بدل ما يبقى
 * fallback، السطر `if (itemMethod === "FIFO" || itemMethod === "AVCO")`
 * تحت ده هو اللي لازم يتشال.
 * @param {string} [itemValuationMethod] - item.valuation_method لو متاح
 * @returns {"FIFO"|"AVCO"} افتراضي FIFO
 */
function _getCostingMethod(itemValuationMethod) {
  var itemMethod = String(itemValuationMethod || "").toUpperCase();
  if (itemMethod === "FIFO" || itemMethod === "AVCO") return itemMethod;

  try {
    if (typeof InventorySettingsEngine !== "undefined") {
      var globalMethod = String(
        InventorySettingsEngine.get("valuation_method") || "",
      ).toLowerCase();
      if (globalMethod === "fifo" || globalMethod === "lifo") return "FIFO";
      if (
        globalMethod === "average" ||
        globalMethod === "moving_average" ||
        globalMethod === "standard"
      ) {
        return "AVCO";
      }
      // [ملاحظة] LIFO مش متنفذة فعليًا في _consumeStockLots (مفيهاش إلا
      // فرعي FIFO/AVCO) — بترجع FIFO مؤقتًا لحد ما تتضاف طريقة LIFO حقيقية.
    }
  } catch (eInv) {
    Logger.log("[P2-LOT] InventorySettingsEngine lookup failed: " + eInv.message);
  }

  try {
    var settings = _getCompanySettingsRaw();
    var method = String(settings["costing_method"] || "FIFO").toUpperCase();
    return method === "AVCO" ? "AVCO" : "FIFO";
  } catch (e) {
    return "FIFO";
  }
}
// ───────────────────────────────────────────────────────────────────────────
// §P2-03  COSTING ENGINE — StockLots CRUD
// ───────────────────────────────────────────────────────────────────────────

/**
 * _createStockLot — ينشئ طبقة تكلفة عند كل وارد
 * يُستدعى من: addPurchaseInvoice, addSaleReturn, addTransaction(IN), openingStock
 */
function _createStockLot(params) {
  // params: { item_id, color, warehouse, qty, unit_cost, source_type, source_id, lot_date }
  try {
    if (!params.item_id || Number(params.qty) <= 0) return null;
    var unitCost = Number(params.unit_cost || 0);
    var qty = Number(params.qty);
    var sheet = getSheet("StockLots", STOCK_LOTS_HEADERS);
    var id = makeId("LOT");
    var now = new Date().toISOString();
    var _lotRow = [
      id,
      params.item_id,
      params.color || "",
      params.warehouse || "",
      qty,
      qty, // qty_remaining = qty_in at creation
      unitCost,
      qty * unitCost,
      params.source_type || "MANUAL",
      params.source_id || "",
      params.lot_date || now.split("T")[0],
      now,
    ];
    // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
    // _appendRowProtected) — يتنادى مع كل فاتورة شراء/مرتجع بيع/رصيد افتتاحي.
    sheet
      .getRange(sheet.getLastRow() + 1, 1, 1, _lotRow.length)
      .setFontColor(null);
    sheet.appendRow(_lotRow);
    return id;
  } catch (e) {
    Logger.log("[P2-LOT] _createStockLot error: " + e.message);
    return null;
  }
}
/**
 * _consumeStockLots — يستهلك طبقات التكلفة عند كل صادر
 * @param {object} params - { item_id, color, warehouse, qty_needed }
 * @returns {{ consumed: Array, total_cost: number, fully_consumed: boolean }}
 */
function _consumeStockLots(params) {
  try {
    // [AUDIT-FIX] تفعيل item.valuation_method الفعلي بدل تجاهله كليًا
    var itemValMethod = "";
    try {
      var itemsForMethod = readSheet("Items", ACCOUNTING_HR_HEADERS.Items, {
        trimStrings: true,
      });
      var itemRecForMethod = itemsForMethod.find(function (it) {
        return it.id === params.item_id;
      });
      if (itemRecForMethod) itemValMethod = itemRecForMethod.valuation_method;
    } catch (eLookup) {
      Logger.log("[P2-LOT] valuation_method lookup failed: " + eLookup.message);
    }
    var method = _getCostingMethod(itemValMethod);
    var lots = readSheet("StockLots", STOCK_LOTS_HEADERS, {
      trimStrings: true,
    });

    // فلترة الطبقات الخاصة بهذا الصنف في هذا المخزن
    var available = lots.filter(function (l) {
      return (
        l.item_id === params.item_id &&
        (params.color === "" ||
          !params.color ||
          l.color === "" ||
          l.color === params.color) &&
        (l.warehouse === "" ||
          !params.warehouse ||
          l.warehouse === params.warehouse) &&
        Number(l.qty_remaining) > 0
      );
    });

    if (method === "FIFO") {
      // ترتيب تصاعدي حسب تاريخ الوارد (الأقدم أولاً)
      available.sort(function (a, b) {
        return (a.lot_date || a.created_at) < (b.lot_date || b.created_at)
          ? -1
          : 1;
      });
    } else {
      // AVCO — احسب متوسط التكلفة من كل الطبقات المتاحة
      var totalQty = available.reduce(function (s, l) {
        return s + Number(l.qty_remaining);
      }, 0);
      var totalVal = available.reduce(function (s, l) {
        return s + Number(l.qty_remaining) * Number(l.unit_cost);
      }, 0);
      var avgCost = totalQty > 0 ? totalVal / totalQty : 0;
      // في AVCO نُعدّل كل الطبقات لتحمل متوسط التكلفة الحالي
      available.forEach(function (l) {
        l._avco_cost = avgCost;
      });
    }

    var qtyNeeded = Number(params.qty_needed);
    var consumed = [];
    var totalCost = 0;
    var sheet = getSheet("StockLots", STOCK_LOTS_HEADERS);
    var allLotsRaw = readSheet("StockLots", STOCK_LOTS_HEADERS);

    for (var i = 0; i < available.length && qtyNeeded > 0; i++) {
      var lot = available[i];
      var lotRemaining = Number(lot.qty_remaining);
      var takeQty = Math.min(qtyNeeded, lotRemaining);
      var effectiveCost =
        method === "AVCO"
          ? lot._avco_cost || Number(lot.unit_cost)
          : Number(lot.unit_cost);
      var lineCost = takeQty * effectiveCost;

      consumed.push({
        lot_id: lot.id,
        item_id: lot.item_id,
        color: lot.color,
        qty: takeQty,
        unit_cost: effectiveCost,
        line_cost: lineCost,
      });

      totalCost += lineCost;
      qtyNeeded -= takeQty;

      // تحديث qty_remaining في الشيت
      var lotIdx = allLotsRaw.findIndex(function (r) {
        return r.id === lot.id;
      });
      if (lotIdx !== -1) {
        var newRemaining = lotRemaining - takeQty;
        sheet
          .getRange(lotIdx + 2, STOCK_LOTS_HEADERS.indexOf("qty_remaining") + 1)
          .setValue(newRemaining);
      }
    }

    return {
      consumed: consumed,
      total_cost: totalCost,
      fully_consumed: qtyNeeded <= 0.001,
      qty_missing: Math.max(0, qtyNeeded),
    };
  } catch (e) {
    Logger.log("[P2-LOT] _consumeStockLots error: " + e.message);
    return {
      consumed: [],
      total_cost: 0,
      fully_consumed: false,
      qty_missing: params.qty_needed,
    };
  }
}
/**
 * _restoreStockLot — يُعيد كميات الطبقات عند مرتجع بيع
 * يُعيد الكميات للطبقات الأصلية التي استُهلكت عند البيع
 * إذا لم تُحدَّد الطبقات الأصلية، يُنشئ طبقة جديدة
 */
function _restoreStockLot(params) {
  // params: { item_id, color, warehouse, qty, unit_cost, source_id, source_type }
  // نُنشئ طبقة جديدة بالتكلفة الأصلية حسب سعر التكلفة في وقت الإرجاع
  return _createStockLot({
    item_id: params.item_id,
    color: params.color || "",
    warehouse: params.warehouse || "",
    qty: params.qty,
    unit_cost: params.unit_cost || 0,
    source_type: "SALE_RETURN",
    source_id: params.source_id || "",
    lot_date: params.lot_date || new Date().toISOString().split("T")[0],
  });
}
/**
 * _reverseStockLot — يُلغي طبقة مرتبطة بمصدر محدد (مرتجع شراء / حذف فاتورة شراء)
 * يُقلل qty_remaining من الطبقات المرتبطة بـ source_id
 *
 * [INV-FIX-2026-08-12 §LOT-XITEM] كانت الدالة تفلتر فقط بـ source_id، بدون
 * item_id/color. بما إن كل بنود فاتورة شراء متعددة الأصناف بتشترك في نفس
 * source_id (= معرّف الفاتورة نفسه — راجع _addPurchaseLots)، أي استدعاء لكل
 * بند (كما في softDeletePurchaseInvoice وكاتش فشل القيد في addPurchaseInvoice)
 * كان بيدور على "أي" طبقة بنفس source_id بغض النظر عن الصنف، فيقدر يعكس كمية
 * من طبقة صنف مختلف تمامًا بدل الصنف الصحيح. لو أحد الأصناف كان اتباع منه
 * جزئيًا بالفعل (مبيعات لاحقة استهلكت جزءًا من طبقته)، هذا الخلط كان يُنتج
 * إما: (أ) عكس كمية من طبقة صنف آخر لم يكن له علاقة بعملية العكس الحالية،
 * أو (ب) فشل عكس الكمية الصحيحة من الصنف المطلوب لأن الكمية المتاحة "بالخطأ"
 * اتاخدت من صنف تاني — يُفسد تتبع تكلفة FIFO/AVCO لصنفين مختلفين في نفس
 * العملية. الحل: نفلتر أيضًا بـ item_id (وبـ color لو مُرسل) قبل التطابق مع
 * source_id، بدل الاعتماد على source_id وحده.
 */
function _reverseStockLot(source_id, qty_to_reverse, item_id, color) {
  var remaining = Number(qty_to_reverse);
  try {
    var lots = readSheet("StockLots", STOCK_LOTS_HEADERS, {
      trimStrings: true,
    });
    var sheet = getSheet("StockLots", STOCK_LOTS_HEADERS);

    // نبحث عن الطبقات المرتبطة بهذا المصدر (مرتّبة من الأحدث للأقدم للتحوط)
    var linked = lots
      .filter(function (l) {
        if (l.source_id !== source_id) return false;
        if (Number(l.qty_remaining) <= 0) return false;
        if (item_id && String(l.item_id) !== String(item_id)) return false;
        if (color && String(l.color || "") !== String(color || ""))
          return false;
        return true;
      })
      .reverse();

    for (var i = 0; i < linked.length && remaining > 0; i++) {
      var lot = linked[i];
      var take = Math.min(remaining, Number(lot.qty_remaining));
      var lotIdx = lots.findIndex(function (r) {
        return r.id === lot.id;
      });
      if (lotIdx !== -1) {
        var newRem = Number(lot.qty_remaining) - take;
        sheet
          .getRange(lotIdx + 2, STOCK_LOTS_HEADERS.indexOf("qty_remaining") + 1)
          .setValue(newRem);
      }
      remaining -= take;
    }
    if (remaining > 0.001) {
      // [INV-FIX-2026-08-12 §LOT-XITEM] لم نجد كمية كافية للعكس بعد فرض
      // مطابقة الصنف — هذا يكشف حالة كانت مُخفاة سابقًا بالخلط بين الأصناف
      // (كان بيكمل العكس "بنجاح ظاهري" من صنف خاطئ). نُسجّلها بوضوح بدل
      // الفشل الصامت، لتبقى مرئية للمراجعة اليدوية/التسوية.
      Logger.log(
        "[P2-LOT][INV-FIX-2026-08-12] _reverseStockLot: لم تُعكس كامل الكمية لـ source_id=" +
          source_id +
          (item_id ? " item_id=" + item_id : "") +
          " — متبقٍ بدون طبقة مطابقة: " +
          remaining +
          " (قد يكون الصنف استُهلك بالكامل عبر مبيعات لاحقة؛ يحتاج مراجعة يدوية)",
      );
    }
  } catch (e) {
    Logger.log("[P2-LOT] _reverseStockLot error: " + e.message);
  }
  // [INV-FIX-2026-08-12 §PRET-LOT] نرجّع الكمية اللي اتعكست فعليًا والمتبقي
  // اللي مالقاش طبقة مطابقة كافية — عشان المستدعي (مثلاً مرتجع الشراء) يقدر
  // يكمّل الفرق بطريقة تانية (استهلاك FIFO عام) بدل ما يفترض إن العملية
  // اكتملت بالكامل بصمت. الاستدعاءات القديمة (softDeletePurchaseInvoice،
  // كاتش فشل قيد addPurchaseInvoice، deleteSaleReturn) لا تعتمد على القيمة
  // المُرجَعة أصلاً، فهذا التغيير متوافق خلفيًا (backward-compatible).
  return {
    reversed: Number(qty_to_reverse) - remaining,
    remaining: remaining,
  };
}
/**
 * _restoreConsumedStockLots — [JOURNAL-SYNC-2026-08-12 §COGS-SILENT-FAIL]
 *
 * يُعيد qty_remaining بالضبط لنفس الطبقات (بالـ lot_id) التي استهلكتها
 * _consumeStockLots في عملية سابقة فشلت بعد الاستهلاك (مثلاً: فشل إنشاء
 * قيد COGS بعد استهلاك الطبقات فعليًا). بخلاف _restoreStockLot (التي
 * تُنشئ طبقة SALE_RETURN جديدة بتاريخ اليوم)، هذه الدالة تعكس بدقة نفس
 * الطبقات الأصلية بنفس تكلفتها وتاريخها — أهم شيء هنا هو عدم كسر ترتيب
 * FIFO أو تلويث الطبقات بطبقة "مرتجع" وهمية لعملية لم تُرتجع فعليًا، وإنما
 * لم تكتمل من الأساس.
 * @param {Array<{lot_id:string, qty:number}>} consumedList - ناتج مجمّع من
 *   عدة استدعاءات _consumeStockLots (حقل consumed[].lot_id/qty)
 */
function _restoreConsumedStockLots(consumedList) {
  if (!consumedList || !consumedList.length) return;
  try {
    var sheet = getSheet("StockLots", STOCK_LOTS_HEADERS);
    var allLots = readSheet("StockLots", STOCK_LOTS_HEADERS, {
      trimStrings: true,
    });
    // نجمع الكمية المطلوب إعادتها لكل lot_id (قد يتكرر نفس lot_id عبر أكثر
    // من بند فاتورة استهلك من نفس الطبقة).
    var byLot = {};
    consumedList.forEach(function (c) {
      if (!c || !c.lot_id || !(Number(c.qty) > 0)) return;
      byLot[c.lot_id] = (byLot[c.lot_id] || 0) + Number(c.qty);
    });
    Object.keys(byLot).forEach(function (lotId) {
      var idx = allLots.findIndex(function (r) {
        return r.id === lotId;
      });
      if (idx === -1) return;
      var lot = allLots[idx];
      // [SAFETY] لا نُعيد أكثر من qty_in (لا يمكن أن يتجاوز qty_remaining
      // الكمية الأصلية الواردة، حتى لو حدث تداخل غير متوقع).
      var restored = Math.min(
        Number(lot.qty_in || 0),
        Number(lot.qty_remaining || 0) + byLot[lotId],
      );
      sheet
        .getRange(idx + 2, STOCK_LOTS_HEADERS.indexOf("qty_remaining") + 1)
        .setValue(restored);
    });
  } catch (e) {
    Logger.log("[P2-LOT] _restoreConsumedStockLots error: " + e.message);
  }
}
/**
 * getInventoryValuation — تقرير تقييم المخزون حسب طبقات التكلفة
 * يُستخدم للتحقق أن حساب المخزون في الأستاذ = قيمة طبقات التكلفة
 */
function getInventoryValuation(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
    if (permErr) return permErr;

    var lots = readSheet("StockLots", STOCK_LOTS_HEADERS, {
      trimStrings: true,
    });
    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var itemMap = {};
    items.forEach(function (it) {
      itemMap[it.id] = it;
    });

    // تجميع حسب item_id
    var byItem = {};
    lots.forEach(function (lot) {
      var rem = Number(lot.qty_remaining);
      if (rem <= 0) return;
      var key = lot.item_id + "|" + lot.color;
      if (!byItem[key]) {
        byItem[key] = {
          item_id: lot.item_id,
          item_name: (itemMap[lot.item_id] || {}).name || lot.item_id,
          color: lot.color,
          total_qty: 0,
          total_value: 0,
        };
      }
      byItem[key].total_qty += rem;
      byItem[key].total_value += rem * Number(lot.unit_cost);
    });

    var rows = Object.values(byItem);
    var grandTotal = rows.reduce(function (s, r) {
      return s + r.total_value;
    }, 0);

    return {
      success: true,
      data: rows,
      grand_total: grandTotal,
      costing_method: _getCostingMethod(),
    };
  } catch (e) {
    return { success: false, message: "خطأ في تقييم المخزون: " + e.message };
  }
}
// ───────────────────────────────────────────────────────────────────────────
// §P2-07  COSTING INTEGRATION — Patch addPurchaseInvoice COGS from Lots
// ───────────────────────────────────────────────────────────────────────────
// بعد Phase 2، تكلفة البضاعة المباعة تُحسب من طبقات التكلفة (StockLots)
// وليس من cost_price الثابت في Items.
// الدوال التالية تُغلّف العمليات الموجودة بإضافة طبقات التكلفة.

/**
 * _addPurchaseLots — يُنشئ طبقات تكلفة عند استلام فاتورة الشراء
 * يُستدعى بعد addPurchaseInvoice بنجاح
 */
function _addPurchaseLots(inv, lines) {
  if (!inv || !lines || !lines.length) return;
  lines.forEach(function (line) {
    var qty = Number(line.qty || line.quantity || 0);
    var itemId = _resolveInvoiceLineItemId(line);
    if (!itemId || qty <= 0) return;
    var unitCost = Number(
      line.unit_price || line.price || line.cost_price || 0,
    );
    _createStockLot({
      item_id: itemId,
      color: line.color || "",
      warehouse: inv.warehouse || "",
      qty: qty,
      unit_cost: unitCost,
      source_type: "PURCHASE_INVOICE",
      source_id: inv.id,
      lot_date: inv.date || new Date().toISOString().split("T")[0],
    });
  });
}
/**
 * _consumeLotForPurchaseReturn — [INV-FIX-2026-08-12 §PRET-LOT]
 *
 * يعكس أثر مرتجع شراء على طبقات التكلفة (StockLots). حتى هذا الإصلاح،
 * addPurchaseReturn كان يخصم من رصيد المخزون الإجمالي (updateStockBalance)
 * فقط، بدون أي أثر على StockLots — فتبقى طبقة التكلفة الأصلية (التي
 * أنشأتها addPurchaseInvoice عبر _addPurchaseLots) بكامل كميتها رغم إن
 * جزءًا (أو كل) هذه الكمية رجع فعليًا للمورد. النتيجة: مبيعات مستقبلية
 * يقدر _consumeStockLots يستهلك منها كمية بضاعة رجعت للمورد فعلاً ومش
 * موجودة، فيُحسب COGS من مخزون غير حقيقي.
 *
 * القرار المعماري (بدون أي إعادة تصميم — نفس النمط المستخدم فعلاً في
 * softDeletePurchaseInvoice لعكس طبقة فاتورة شراء بالكامل):
 *
 * 1) لو original_invoice_id متاح: نستهدف طبقة الفاتورة الأصلية بالتحديد
 *    (نفس الصنف/اللون) عبر _reverseStockLot، لأنها الطبقة الصحيحة محاسبيًا
 *    (بنفس تكلفة الشراء الأصلية) للكمية المرتجعة من هذه الفاتورة تحديدًا.
 * 2) لو الطبقة الأصلية استُهلكت جزئيًا أو كليًا بالفعل عبر مبيعات لاحقة
 *    (قبل تسجيل المرتجع)، مفيش طبقة كافية "تُلغى" — الكمية دي فعليًا سبق
 *    وخرجت من المخزون بتكلفة تلك الطبقة وتحوّلت لـ COGS بالفعل. لا يوجد
 *    "عكس" منطقي ممكن لكمية سبق بيعها. بدلاً من ترك الفرق صامتًا (كان كده
 *    قبل هذا الإصلاح)، نُكمّل الفرق باستهلاك عام (FIFO/AVCO حسب إعداد
 *    الصنف) من أي طبقات متبقية للصنف عبر _consumeStockLots — بنفس منطق
 *    استهلاك مبيعات عادية، لأن مرتجع الشراء فعليًا حركة OUT من المخزن
 *    (نفس ما تُعامله addPurchaseReturn أصلاً عبر _checkOutboundStock).
 *    هذا لا "يخترع" كمية غير موجودة؛ فقط يوزّع نقص طبقة الفاتورة الأصلية
 *    على ما هو متاح فعليًا، بنفس أسلوب معالجة نقص أي حركة OUT أخرى.
 * 3) لو original_invoice_id غير متاح أصلاً: نستهلك مباشرة بنفس أسلوب
 *    FIFO/AVCO العام (لا توجد طبقة محددة نستهدفها).
 *
 * ملاحظة: أي نقص متبقٍ حتى بعد (2) (لا توجد أي طبقة متاحة للصنف إطلاقًا)
 * يُسجَّل فقط للمراجعة اليدوية — بنفس نمط تعامل P8-FIX/COST_LOT_CREATE_FAILED
 * الموجود فعلاً مع فشل طبقات التكلفة، بدل رفض عملية مرتجع شراء ماليًا
 * ومحاسبيًا صحيحة بالكامل بسبب فجوة تكلفة ثانوية.
 */
function _consumeLotForPurchaseReturn(params) {
  // params: { item_id, color, warehouse, qty, original_invoice_id }
  var qty = Number(params.qty || 0);
  var result = { targeted_reversed: 0, fifo_consumed: 0, shortfall: 0 };
  if (!params.item_id || qty <= 0) return result;

  var remaining = qty;

  if (params.original_invoice_id) {
    var targeted = _reverseStockLot(
      params.original_invoice_id,
      remaining,
      params.item_id,
      params.color || "",
    );
    result.targeted_reversed = targeted.reversed;
    remaining = targeted.remaining;
  }

  if (remaining > 0.001) {
    var consumeRes = _consumeStockLots({
      item_id: params.item_id,
      color: params.color || "",
      warehouse: params.warehouse || "",
      qty_needed: remaining,
    });
    result.fifo_consumed = remaining - (consumeRes ? consumeRes.qty_missing || 0 : remaining);
    result.shortfall = consumeRes ? consumeRes.qty_missing || 0 : remaining;
    if (result.shortfall > 0.001) {
      Logger.log(
        "[P2-LOT][INV-FIX-2026-08-12][PRET-LOT] _consumeLotForPurchaseReturn: " +
          "لا توجد طبقة تكلفة كافية لعكس مرتجع شراء — item_id=" +
          params.item_id +
          " قيمة ناقصة=" +
          result.shortfall +
          " (لا يمنع حفظ المرتجع، لكن StockLots لن يعكس الكمية بالكامل — يحتاج مراجعة يدوية)",
      );
    }
  }

  return result;
}
/**
 * _migrateBuildStockLotsFromHistory — يبني طبقات التكلفة من فواتير الشراء التاريخية
 * يتحقق أولاً من عدم وجود طبقات لنفس المصدر (idempotent)
 */
function _migrateBuildStockLotsFromHistory() {
  var existingLots = readSheet("StockLots", STOCK_LOTS_HEADERS, {
    trimStrings: true,
  });
  var existingSources = {};
  existingLots.forEach(function (l) {
    if (l.source_id) existingSources[l.source_id] = true;
  });

  var invoices = [];
  try {
    invoices = readSheet("PurchaseInvoices", PURCHASE_INVOICE_HEADERS, {
      parseJson: ["lines_json"],
    });
  } catch (e) {
    return 0;
  }

  var created = 0;
  invoices.forEach(function (inv) {
    if (!inv.id || inv.status === "CANCELLED" || inv.deleted_at) return;
    if (existingSources[inv.id]) return; // سبق بناؤها

    var lines = inv.lines_json || [];
    if (typeof lines === "string") {
      try {
        lines = JSON.parse(lines);
      } catch (e) {
        lines = [];
      }
    }

    lines.forEach(function (line) {
      var qty = Number(line.qty || line.quantity || 0);
      var itemId = _resolveInvoiceLineItemId
        ? _resolveInvoiceLineItemId(line)
        : line.item_id || "";
      if (!itemId || qty <= 0) return;
      var unitCost = Number(
        line.unit_price || line.price || line.cost_price || 0,
      );
      _createStockLot({
        item_id: itemId,
        color: line.color || "",
        warehouse: inv.warehouse || "",
        qty: qty,
        unit_cost: unitCost,
        source_type: "PURCHASE_INVOICE",
        source_id: inv.id,
        lot_date: inv.date || new Date().toISOString().split("T")[0],
      });
      created++;
    });
  });

  return created;
}
/**
 * _migrateBuildOpeningStockLots — يبني طبقات التكلفة من المخزون الافتتاحي
 */
function _migrateBuildOpeningStockLots() {
  var existingLots = readSheet("StockLots", STOCK_LOTS_HEADERS, {
    trimStrings: true,
  });
  var hasOpening = existingLots.some(function (l) {
    return l.source_type === "OPENING";
  });
  if (hasOpening) return 0; // سبق بناؤها

  var openingRows = [];
  try {
    openingRows = readSheet("OpeningStock", OPENING_STOCK_HEADERS, {
      trimStrings: true,
    });
  } catch (e) {
    return 0;
  }

  var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
  var itemMap = {};
  items.forEach(function (it) {
    itemMap[it.id] = it;
  });

  var created = 0;
  openingRows.forEach(function (row) {
    var qty = Number(row.quantity || 0);
    if (!row.item_id || qty <= 0) return;
    var item = itemMap[row.item_id];
    // [MD-06 FIX] أولوية لتكلفة الوحدة الصريحة المُدخلة وقت الافتتاح، ثم fallback
    // على تكلفة الصنف الحالية (للسجلات القديمة التي لا تحتوي على unit_cost)
    var explicitCost = Number(row.unit_cost || 0);
    var unitCost =
      explicitCost > 0 ? explicitCost : item ? Number(item.cost_price || 0) : 0;
    _createStockLot({
      item_id: row.item_id,
      color: row.color || "",
      warehouse: "",
      qty: qty,
      unit_cost: unitCost,
      source_type: "OPENING",
      source_id: "OPENING-" + row.item_id,
      lot_date: row.date || "2024-01-01",
    });
    created++;
  });

  return created;
}
// ───────────────────────────────────────────────────────────────────────────
// §P2-13  INVENTORY ADJUSTMENT WITH COSTING
// ───────────────────────────────────────────────────────────────────────────

/**
 * addInventoryAdjustmentWithCosting — تسوية مخزنية مع تحديث طبقات التكلفة
 * يُنشئ طبقة تكلفة جديدة للزيادات ويستهلك للنقصان
 */
function addInventoryAdjustmentWithCosting(data, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "addTransaction", sessionToken);
    if (permErr) return permErr;

    var qty = Number(data.qty || 0);
    if (!data.item_id || qty === 0)
      return { success: false, message: "بيانات غير مكتملة" };

    var unitCost = Number(data.unit_cost || 0);
    // Fallback to Items.cost_price
    if (unitCost <= 0) {
      var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
      var item = items.find(function (i) {
        return i.id === data.item_id;
      });
      unitCost = item ? Number(item.cost_price || 0) : 0;
    }

    var adjustId = makeId("ADJ");
    var result = {
      id: adjustId,
      item_id: data.item_id,
      qty: qty,
      unit_cost: unitCost,
    };

    if (qty > 0) {
      // زيادة — أضف طبقة تكلفة جديدة
      _createStockLot({
        item_id: data.item_id,
        color: data.color || "",
        warehouse: data.warehouse || "",
        qty: qty,
        unit_cost: unitCost,
        source_type: "ADJUSTMENT",
        source_id: adjustId,
        lot_date: data.date || new Date().toISOString().split("T")[0],
      });

      // قيد محاسبي: Dr. مخزون / Cr. أرباح وخسائر تسويات
      var accounts = readSheet(
        "ChartOfAccounts",
        ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      );
      var invAcc = _getDefaultAccount("inventory_account", accounts, "ASSET", [
        "مخزون",
        "بضاعة",
      ]);
      // [FIX-POSTING-AUDIT §4 — 2026-08-10] كان "adjustment_account" مفتاحاً
      // غير مسجَّل بـ POSTING_CONFIG_KEYS (فلا يمكن تثبيته من شاشة إعدادات
      // الترحيل) — تم توحيده على المفتاح الرسمي inventory_variance_account.
      var adjAcc = _getDefaultAccount(
        "inventory_variance_account",
        accounts,
        "EXPENSE",
        ["تسوية", "adjustment", "فروق"],
      );
      if (invAcc && adjAcc && unitCost > 0) {
        _addJournalEntryInternal({
          callerUser: callerUser,
          date: data.date || new Date().toISOString().split("T")[0],
          reference: adjustId,
          description: "تسوية مخزنية زيادة — " + data.item_id,
          source_type: "INVENTORY_ADJUSTMENT",
          lines: [
            {
              account_id: invAcc.id,
              debit: qty * unitCost,
              credit: 0,
              notes: "تسوية مخزنية +",
            },
            {
              account_id: adjAcc.id,
              debit: 0,
              credit: qty * unitCost,
              notes: "فروق الجرد",
            },
          ],
        });
      }
    } else {
      // نقصان — استهلك طبقات التكلفة
      var consumed = _consumeStockLots({
        item_id: data.item_id,
        color: data.color || "",
        warehouse: data.warehouse || "",
        qty_needed: Math.abs(qty),
      });

      var accounts2 = readSheet(
        "ChartOfAccounts",
        ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      );
      var invAcc2 = _getDefaultAccount(
        "inventory_account",
        accounts2,
        "ASSET",
        ["مخزون", "بضاعة"],
      );
      // [FIX-POSTING-AUDIT §4 — 2026-08-10] راجع نفس الملاحظة أعلاه — توحيد
      // على المفتاح الرسمي inventory_variance_account.
      var adjAcc2 = _getDefaultAccount(
        "inventory_variance_account",
        accounts2,
        "EXPENSE",
        ["تسوية", "adjustment", "فروق"],
      );
      if (invAcc2 && adjAcc2 && consumed.total_cost > 0) {
        _addJournalEntryInternal({
          callerUser: callerUser,
          date: data.date || new Date().toISOString().split("T")[0],
          reference: adjustId,
          description: "تسوية مخزنية نقصان — " + data.item_id,
          source_type: "INVENTORY_ADJUSTMENT",
          lines: [
            {
              account_id: adjAcc2.id,
              debit: consumed.total_cost,
              credit: 0,
              notes: "فروق الجرد نقصان",
            },
            {
              account_id: invAcc2.id,
              debit: 0,
              credit: consumed.total_cost,
              notes: "تسوية مخزنية -",
            },
          ],
        });
      }
      result.actual_cost = consumed.total_cost;
    }

    return {
      success: true,
      message: "تم تسجيل التسوية المخزنية",
      data: result,
    };
  } catch (e) {
    return { success: false, message: "خطأ في التسوية: " + e.message };
  }
}
