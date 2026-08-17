// ════════════════════════════════════════════════════════════════
// Code_20c_Invoices.js — فواتير البيع والشراء + المرتجعات — [SPLIT-2026-07-27] فُصل من Code_20_Sales.js الأصلي (7172 سطر)
// كجزء من إعادة تنظيم المبيعات/المشتريات حسب المجال الوظيفي الحقيقي بدل
// تجميع فواتير + أطراف + أدوات محاسبة + فودافون كاش في ملف واحد اسمه
// "Sales" (راجع تقرير moo-erp-sales-purchasing-deepdive.md، بند 7).
// نقل نصي بحت — صفر تغيير في المنطق أو أسماء الدوال. كل ملفات .gs بتعمل
// في نفس الـ Global Scope في Apps Script فالاستدعاءات القديمة فضلت شغالة.
// ════════════════════════════════════════════════════════════════

// [AUDIT-FIX-2026-08-08 §RISK-2b] حارس Idempotency عام مبني على
// CacheService — يُستخدم من addSaleInvoice/addPurchaseInvoice (ولاحقاً أي
// نقطة كتابة أخرى تحتاج نفس الحماية) لرفض أي طلب ثانٍ يحمل نفس
// client_request_id خلال فترة الصلاحية. مفيش تعديل Schema مطلوب —
// CacheService.getScriptCache() TTL أقصاه 6 ساعات، هنا بنستخدم دقيقتين
// فقط (كافية لتغطية Retry بعد Timeout شبكة، مش المفروض تُستخدم كقفل طويل).
// ملاحظة: CacheService غير مضمون 100% (best-effort من جوجل)، فهذا خط دفاع
// إضافي وليس الوحيد — الحارس الزمني بالمحتوى (نفس الطرف/البنود/الإجمالي
// خلال 20 ثانية) في addSaleInvoice/addPurchaseInvoice يبقى فعّالاً كخط
// دفاع ثانٍ حتى لو فشل الكاش أو لم ترسل الواجهة client_request_id.
function _requireIdempotencyKey(cacheKey) {
  try {
    var cache = CacheService.getScriptCache();
    var existing = cache.get(cacheKey);
    if (existing) {
      return {
        ok: false,
        error: {
          success: false,
          message:
            "تم استلام هذا الطلب بالفعل قبل قليل (نفس المعرّف) — لو كنت تنتظر رد الحفظ السابق، انتظر لحظة ثم تحقق من قائمة الفواتير قبل إعادة المحاولة",
        },
      };
    }
    cache.put(cacheKey, "1", 120); // ثانيتين × 60 = دقيقتين
    return { ok: true };
  } catch (e) {
    // فشل الكاش نفسه (نادر) لا يجب أن يمنع عملية حفظ حقيقية
    Logger.log("[RISK-2b-IDEMPOTENCY] فشل فحص/تخزين مفتاح الطلب: " + e.message);
    return { ok: true };
  }
}


// [ARCH-AUDIT-P3-7] هذه الدالة بتحوّل صف Transactions (خارج من _buildTxRow
// المشترك في Code_16_Inventory.js — نقصدًا مُبقّينه من غير تعديل عشان
// مُستخدَم في 10 أماكن عبر 3 ملفات) لكائن بمفاتيح HEADERS.Transactions،
// عشان يعدّي على DataLayerEngine.insert/bulkInsert بدل appendRow الخام —
// من غير أي تكرار أو انحراف محتمل عن منطق _buildTxRow الأصلي.
function _txRowToObject(row) {
  var obj = {};
  HEADERS.Transactions.forEach(function (h, i) {
    obj[h] = row[i];
  });
  return obj;
}

// ═══════════════════════════════════════════════════════════════════════════════

// §EXT-INVOICES  Invoices — فواتير البيع والشراء
// ═══════════════════════════════════════════════════════════════════

var SALE_INVOICE_HEADERS = [
  "id",
  // [INV2-SETTINGS-2026-08-07] رقم عرض منفصل عن id الداخلي — مُولَّد حسب
  // إعدادات قسم "ترقيم الفواتير" (InvoiceSettingsEngine). id يفضل المفتاح
  // الحقيقي المستخدم في كل مكان تاني (قيود، سندات قبض، حذف...)، عمود
  // invoice_no ده إضافي (additive) للعرض/الطباعة بس — راجع الشرح في
  // README عن سبب الفصل.
  "invoice_no",
  "date",
  "party", // اسم الطرف (للعرض والبحث النصي)
  "party_id", // [C7-FIX] معرف الطرف المستقر — لا يتأثر بتغيير الاسم. يُستخدم في كشف الحساب والربط المحاسبي
  "permit_id",
  "payment_status",
  "due_date",
  "subtotal",
  "discount_value",
  "discount_type",
  "discount_amount",
  "vat_percent",
  "vat_amount",
  "net_total",
  "lines_json",
  "notes",
  "created_by",
  "created_at",
  "status",
  // ── المرحلة 3: تكامل الشحن ──
  "shipment_id", // معرف الشحنة المرتبطة (اختياري)
  "shipping_cost", // تكلفة الشحن (مُحتسبة أو يدوية)
  "shipping_cost_on", // من يتحمل التكلفة: company | customer
  "shipping_company_id", // معرف شركة الشحن المختارة في الفاتورة
  // ── [PAYMENT-ENGINE] Payment Allocation: تتبع الدفع الجزئي ──
  "paid_amount", // إجمالي المُحصَّل فعليًا عبر سندات القبض المعتمدة المرتبطة
  "remaining_amount", // المتبقي = net_total - paid_amount (يُحسب ويُحدَّث تلقائيًا)
  "commission_amount", // [AUDIT-FIX Inventory §2.3] عمولة البيع المحسوبة من item.commission_percent — معلوماتي فقط، بدون أثر محاسبي
];

var PURCHASE_INVOICE_HEADERS = [
  "id",
  "invoice_no", // [INV2-SETTINGS-2026-08-07] نفس فكرة SALE_INVOICE_HEADERS.invoice_no
  "date",
  "party", // اسم الطرف (للعرض والبحث النصي)
  "party_id", // [C7-FIX] معرف الطرف المستقر — لا يتأثر بتغيير الاسم. يُستخدم في كشف الحساب والربط المحاسبي
  "permit_id",
  "payment_status",
  "due_date",
  "subtotal",
  "discount_value",
  "discount_type",
  "discount_amount",
  "vat_percent",
  "vat_amount",
  "net_total",
  "lines_json",
  "notes",
  "created_by",
  "created_at",
  "status",
  // ── [PAYMENT-ENGINE] Payment Allocation: تتبع الدفع الجزئي ──
  "paid_amount",
  "remaining_amount",
  // ── [PO-INVOICE-LINK] معرّف أمر الشراء المصدر — اختياري، فارغ للفواتير
  // التي تُنشأ مباشرة بدون المرور بأمر شراء (نفس النمط القديم يفضل شغّال) ──
  "po_id",
];

// ─────────────────────────────────────────────────────────────
// getSaleInvoices — جلب كل فواتير البيع
// ─────────────────────────────────────────────────────────────
// [FIX-BUG-4] أُضيف تحقق من الصلاحية — callerUser + sessionToken إلزاميان الآن
function getSaleInvoices(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "viewSaleInvoices",
      sessionToken,
    );
    if (permErr) return permErr;
    var rows = readSheet("SaleInvoices", SALE_INVOICE_HEADERS, {
      parseJson: ["lines_json"],
    });
    return { success: true, data: cleanArr(rows) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// getPurchaseInvoices — جلب كل فواتير الشراء
// ─────────────────────────────────────────────────────────────
function getPurchaseInvoices() {
  try {
    var rows = readSheet("PurchaseInvoices", PURCHASE_INVOICE_HEADERS, {
      parseJson: ["lines_json"],
    });
    return { success: true, data: cleanArr(rows) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function _invoiceHasExistingPermit(permitId, txType) {
  if (!permitId) return false;
  var rows = getSheetData("Transactions");
  return rows.some(function (tx) {
    return (
      tx.type === txType &&
      (String(tx.permit_id || "") === String(permitId) ||
        String(tx.id || "") === String(permitId))
    );
  });
}

function _resolveInvoiceLineItemId(line) {
  if (line.item_id) return line.item_id;
  var name = String(line.item_name || "").trim();
  if (!name) return "";
  var items = getSheetData("Items");
  var found = items.find(function (item) {
    return (
      String(item.name || "").trim() === name ||
      String(item.code || "").trim() === name ||
      String(item.id || "").trim() === name
    );
  });
  return found ? found.id : "";
}

// [AUDIT-FIX Inventory §2.3] _validateAndComputeLineItemPolicies —
// تفعيل حقول الصنف التي كانت "مكتملة شكليًا، ميتة وظيفيًا":
// max_discount_percent (حد أقصى للخصم على مستوى الصنف)، min_margin_percent
// (حد أدنى لهامش الربح فوق التكلفة)، commission_percent (عمولة بيع تُحسب
// كرقم معلوماتي على الفاتورة، بدون أي تأثير على القيد المحاسبي).
// ترجع { ok:false, error } عند مخالفة سياسة الصنف، أو { ok:true, commission_amount }.
function _validateAndComputeLineItemPolicies(lines) {
  var items = getSheetData("Items");
  var itemsById = {};
  items.forEach(function (it) {
    itemsById[it.id] = it;
  });

  // [AUDIT-FIX INVSET-05] allow_item_discount — قبل التعديل، كان ممكن تبعت
  // خصم على أي بند حتى لو الإعداد "السماح بخصم الصنف" معطّل من شاشة إعدادات
  // الفواتير؛ الإعداد كان معروض بس بلا أي فحص فعلي في السيرفر.
  var itemDiscountAllowed =
    typeof InvoiceSettingsEngine === "undefined" ||
    InvoiceSettingsEngine.get("allow_item_discount") !== false;

  var commissionTotal = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i] || {};
    var itemId = _resolveInvoiceLineItemId(line);
    var item = itemId ? itemsById[itemId] : null;
    if (!item) continue;

    var qty = Number(line.qty || 0);
    var price = Number(line.unit_price || 0);

    // [INVSET-WIRE-2026-08-08] prevent_price_edit — كان الإعداد محفوظًا
    // ومعروضًا في شاشة إعدادات الفواتير (قسم 3) بدون أي فحص فعلي؛ أي
    // مستخدم كان يقدر يبعت سعر بيع مختلف تمامًا عن سعر الصنف المسجّل
    // بغض النظر عن قيمة الإعداد. لو مفعّل، السعر لازم يطابق
    // selling_price المسجّل بالصنف (بفارق تقريب بسيط).
    if (
      typeof InvoiceSettingsEngine !== "undefined" &&
      InvoiceSettingsEngine.get("prevent_price_edit") === true
    ) {
      var _catalogPrice = Number(item.selling_price || item.sellingPrice || 0);
      if (_catalogPrice > 0 && Math.abs(price - _catalogPrice) > 0.01) {
        return {
          ok: false,
          error: {
            success: false,
            message:
              'تعديل سعر البيع معطّل من إعدادات الفواتير — سعر الصنف "' +
              (item.name || item.id) +
              '" يجب أن يكون ' +
              _catalogPrice.toFixed(2) +
              " (السعر المسجّل بالصنف)",
          },
        };
      }
    }

    var gross = qty * price;
    var discVal = Number(line.discount_value || 0);
    var discType = line.discount_type || "fixed";

    if (!itemDiscountAllowed && discVal > 0) {
      return {
        ok: false,
        error: {
          success: false,
          message:
            'خصم الأصناف معطّل حاليًا من إعدادات الفواتير — لا يمكن تطبيق خصم على الصنف "' +
            (item.name || item.id) +
            '"',
        },
      };
    }

    var discAmount =
      discVal > 0
        ? discType === "percent"
          ? gross * (discVal / 100)
          : discVal
        : 0;
    discAmount = Math.min(discAmount, gross);
    var netLine = gross - discAmount;
    var effectiveDiscPercent = gross > 0 ? (discAmount / gross) * 100 : 0;

    // حد أقصى للخصم لكل صنف
    var maxDisc = Number(item.max_discount_percent || 0);
    if (maxDisc > 0 && effectiveDiscPercent > maxDisc + 0.01) {
      return {
        ok: false,
        error: {
          success: false,
          message:
            'خصم الصنف "' +
            (item.name || item.id) +
            '" (' +
            effectiveDiscPercent.toFixed(1) +
            "%) يتجاوز الحد الأقصى المسموح به لهذا الصنف (" +
            maxDisc +
            "%)",
        },
      };
    }

    // حد أدنى لهامش الربح لكل صنف
    var minMargin = Number(item.min_margin_percent || 0);
    var cost = Number(item.cost_price || 0);
    if (minMargin > 0 && cost > 0 && qty > 0) {
      var unitNet = netLine / qty;
      var requiredMinPrice = cost * (1 + minMargin / 100);
      if (unitNet < requiredMinPrice - 0.01) {
        return {
          ok: false,
          error: {
            success: false,
            message:
              'سعر البيع الصافي للصنف "' +
              (item.name || item.id) +
              '" (' +
              unitNet.toFixed(2) +
              ") أقل من الحد الأدنى المسموح به (" +
              requiredMinPrice.toFixed(2) +
              ") لتحقيق هامش ربح " +
              minMargin +
              "% فوق التكلفة",
          },
        };
      }
    }

    // عمولة البيع — رقم معلوماتي فقط، لا يؤثر على صافي الفاتورة أو القيد
    var commissionPct = Number(item.commission_percent || 0);
    if (commissionPct > 0) {
      commissionTotal += netLine * (commissionPct / 100);
    }
  }

  return { ok: true, commission_amount: commissionTotal };
}

/** _prevalidateInvoiceStock — التحقق من المخزون قبل حفظ الفاتورة (OUT فقط) */
function _prevalidateInvoiceStock(invoiceData, txType) {
  if (txType !== "OUT") return null;
  var lines = invoiceData.lines || [];
  if (!lines.length) return null;
  var stockSnapshot = getSheetData("Stock");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var qty = Number(line.qty || line.quantity || 0);
    var itemId = _resolveInvoiceLineItemId(line);
    if (!itemId || qty <= 0) continue;
    var tx = {
      type: "OUT",
      item_id: itemId,
      quantity: qty,
      from_warehouse: invoiceData.warehouse || "الرئيسي",
      color: line.color || "",
    };
    var err = _checkOutboundStock(tx, stockSnapshot);
    if (err) return err;
  }
  return null;
}

/** _reverseInvoiceStockMovements — عكس حركات مخزون الفاتورة عند فشل الترحيل المحاسبي */
function _reverseInvoiceStockMovements(
  invoiceId,
  invoiceData,
  originalTxType,
  username,
  sessionToken,
) {
  var reverseType = originalTxType === "OUT" ? "IN" : "OUT";
  var lines = invoiceData.lines || [];
  // [PERF-BATCH-1] نجمع صفوف Transactions في مصفوفة ونكتبهم بنداء setValues
  // واحد بدل appendRow منفصل لكل بند فاتورة (كان بيعمل رحلة API لكل سطر).
  var txRows = [];
  lines.forEach(function (line, idx) {
    var qty = Number(line.qty || line.quantity || 0);
    var itemId = _resolveInvoiceLineItemId(line);
    if (!itemId || qty <= 0) return;
    var tx = {
      type: reverseType,
      item_id: itemId,
      quantity: qty,
      date: invoiceData.date || new Date(),
      from_warehouse:
        reverseType === "OUT" ? invoiceData.warehouse || "الرئيسي" : "",
      to_warehouse:
        reverseType === "IN" ? invoiceData.warehouse || "الرئيسي" : "",
      warehouse: invoiceData.warehouse || "الرئيسي",
      color: line.color || "",
      ref: invoiceId + "-ROLLBACK",
      permit_id: invoiceData.permit_id || invoiceId,
      party: invoiceData.party || "",
      notes: "عكس فاتورة " + invoiceId + " — فشل الترحيل المحاسبي",
      user: username,
      sessionToken: sessionToken,
    };
    var txId = invoiceId + "-RB-" + (idx + 1);
    txRows.push(_txRowToObject(_buildTxRow(tx, txId, new Date())));
    updateStockBalance(tx);
  });
  // [ARCH-AUDIT-P3-7] appendRowsBatch خام → DataLayerEngine.bulkInsert —
  // بيعمل setValues() واحدة برضه (نفس تحسين الأداء الأصلي [PERF-BATCH-1])
  // لكن من المسار الموحّد.
  DataLayerEngine.bulkInsert("Transactions", txRows, {
    headers: HEADERS.Transactions,
  });
}

/** _deleteInvoiceRowById — حذف صف الفاتورة من الشيت */
function _deleteInvoiceRowById(sheet, invoiceId) {
  if (!sheet || !invoiceId) return;
  var rows = sheet.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][0]) === String(invoiceId)) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
}

function _createInvoiceStockMovements(
  invoiceId,
  invoiceData,
  txType,
  username,
  sessionToken,
) {
  if (_invoiceHasExistingPermit(invoiceData.permit_id, txType)) return [];
  var lines = invoiceData.lines || [];

  // [BUNDLE-EXPLOSION-2026-08-05] الأصناف من نوع "مجموعة" (bundle) معندهاش
  // رصيد مخزني مستقل (flags.stock=false في _imItemTypeMeta بالفرونت-إند) —
  // فلازم بيعها "يتفكّك" لحركات مخزون على المكوّنات الفعلية (bundle_components_json)
  // بدل ما يتحط حركة على الصنف Bundle نفسه (اللي أصلاً مش متتبَّع في المخزون).
  // ده تحديدًا البند المذكور في توثيق محرك قواعد نوع الصنف تحت "Package
  // Explosion" كشغل ناقص. بيتطبق على البيع فقط (OUT) — الـ bundle مش بيتشترى
  // أصلاً (flags.purchase=false)، فمفيش داعي لمنطق مقابل في IN.
  var itemsForExplosion = readSheet("Items");
  function _findItemRec(itemId) {
    return itemsForExplosion.find(function (it) {
      return it.id === itemId || it.code === itemId;
    });
  }
  function _explodeBundleComponents(bundleItemRec, bundleQty) {
    var comps = [];
    try {
      comps = JSON.parse(bundleItemRec.bundle_components_json || "[]") || [];
    } catch (e) {
      comps = [];
    }
    return comps
      .map(function (c) {
        return { item_id: c.item_id, qty: Number(c.qty || 0) * bundleQty };
      })
      .filter(function (c) {
        return c.item_id && c.qty > 0;
      });
  }

  // [ATOMIC-STOCK-FIX] بناء كل معاملات البنود أولاً + التحقق من رصيد كل بند
  // (قراءة فقط، بدون أي كتابة) قبل تنفيذ أي appendRow/updateStockBalance.
  // السبب: النسخة القديمة كانت تكتب كل بند فور نجاح فحصه داخل نفس الحلقة —
  // فلو فشل فحص البند الثالث مثلاً (رصيد غير كافٍ)، كان البندان الأول والثاني
  // قد كُتبا فعلاً في Transactions وتم خصمهما من الرصيد قبل رمي الخطأ، فتبقى
  // حركات مخزون جزئية (يتيمة) رغم أن الفاتورة نفسها تُرفض/تُحذف بالكامل من
  // المستدعي. الآن: مرحلة تحقق كاملة أولاً — فإما تمر كل البنود فتُكتب كلها،
  // أو يفشل بند واحد فلا تُكتب أي حركة إطلاقاً (Atomic).
  var stockData = getSheetData("Stock");
  var txList = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var qty = Number(line.qty || line.quantity || 0);
    var itemId = _resolveInvoiceLineItemId(line);
    if (!itemId || qty <= 0) continue;

    var itemRec = _findItemRec(itemId);
    var isBundleLine = txType === "OUT" && itemRec && itemRec.item_type === "bundle";

    if (isBundleLine) {
      var expanded = _explodeBundleComponents(itemRec, qty);
      expanded.forEach(function (comp, cIdx) {
        var compTx = {
          type: txType,
          item_id: comp.item_id,
          quantity: comp.qty,
          date: invoiceData.date || new Date(),
          from_warehouse: invoiceData.warehouse || SmartDefaults.get("default_warehouse"),
          to_warehouse: "",
          warehouse: invoiceData.warehouse || SmartDefaults.get("default_warehouse"),
          color: "",
          ref: invoiceId,
          permit_id: invoiceData.permit_id || invoiceId,
          party: invoiceData.party || "",
          notes:
            "حركة مخزون تلقائية (تفكيك مجموعة " + itemId + ") من فاتورة " +
            invoiceId + " بند " + (i + 1) + "." + (cIdx + 1),
          user: username,
          sessionToken: sessionToken,
          _lineIdx: i + "." + cIdx,
        };
        var compErr = _checkOutboundStock(compTx, stockData);
        if (compErr) {
          throw new Error(
            "تعذّر بيع المجموعة \"" + itemId + "\" — رصيد المكوّن \"" +
              comp.item_id + "\" غير كافٍ: " + compErr,
          );
        }
        txList.push(compTx);
      });
      continue; // لا حركة على صنف الـ bundle نفسه — مفيش رصيد مخزني له
    }

    var tx = {
      type: txType,
      item_id: itemId,
      quantity: qty,
      date: invoiceData.date || new Date(),
      from_warehouse:
        txType === "OUT" ? invoiceData.warehouse || SmartDefaults.get("default_warehouse") : "",
      to_warehouse: txType === "IN" ? invoiceData.warehouse || SmartDefaults.get("default_warehouse") : "",
      warehouse: invoiceData.warehouse || SmartDefaults.get("default_warehouse"),
      color: line.color || "",
      ref: invoiceId,
      permit_id: invoiceData.permit_id || invoiceId,
      party: invoiceData.party || "",
      notes: "حركة مخزون تلقائية من فاتورة " + invoiceId + " بند " + (i + 1),
      user: username,
      sessionToken: sessionToken,
      _lineIdx: i,
    };
    var stockErr = _checkOutboundStock(tx, stockData);
    if (stockErr) throw new Error(stockErr);
    txList.push(tx);
  }

  // مرحلة الكتابة — كل البنود عدّت التحقق، فلا يجوز لأي منها أن يفشل الآن
  // لأسباب متعلقة بالرصيد (لكن نُبقي الكتابة معزولة بنداء لكل بند حفاظاً على
  // نفس منطق updateStockBalance/الـ audit log الحالي).
  var created = [];
  txList.forEach(function (tx) {
    // [BUNDLE-EXPLOSION-2026-08-05] _lineIdx ممكن يكون نص مركّب "i.cIdx" لبنود
    // المكونات المُفكَّكة من مجموعة (bundle) — نبني txId فريد يميّزهم عن بنود
    // الفاتورة العادية بدل الجمع الرقمي المباشر (اللي كان هيرجع نص غريب).
    var txId =
      typeof tx._lineIdx === "string" && tx._lineIdx.indexOf(".") !== -1
        ? invoiceId + "-b" + tx._lineIdx.replace(".", "-")
        : invoiceId + "-" + (tx._lineIdx + 1);
    // [ARCH-AUDIT-P3-7] appendRow خام -> DataLayerEngine.insert
    DataLayerEngine.insert(
      "Transactions",
      _txRowToObject(_buildTxRow(tx, txId, new Date())),
      { headers: HEADERS.Transactions },
    );
    updateStockBalance(tx);
    AuditEngine.log("ADD_INVOICE_STOCK_MOVEMENT:" + txType, {
      user: username || "system",
      table: "Transactions",
      record_id: txId,
      details:
        "فاتورة: " +
        invoiceId +
        " | صنف: " +
        tx.item_id +
        " | كمية: " +
        tx.quantity});
    created.push({
      id: txId,
      type: txType,
      item_id: tx.item_id,
      quantity: tx.quantity,
      date: invoiceData.date || new Date().toISOString(),
      from_warehouse: tx.from_warehouse || "",
      to_warehouse: tx.to_warehouse || "",
      warehouse: invoiceData.warehouse || "الرئيسي",
      color: tx.color || "",
      ref: invoiceId,
      permit_id: invoiceData.permit_id || invoiceId,
      party: invoiceData.party || "",
      notes: tx.notes,
      user: username,
    });
  });
  return created;
}

/**
 * _autoJournalFromStocktake — [B5-FIX] قيد محاسبي تلقائي لتسوية فرق الجرد.
 * زيادة فعلية عن المسجَّل في النظام: مدين مخزون / دائن حساب فروق الجرد.
 * عجز فعلي عن المسجَّل في النظام: مدين حساب فروق الجرد / دائن مخزون.
 * بدون هذا القيد تبقى قيمة المخزون في الأستاذ العام غير مطابقة للكمية الفعلية بعد كل جرد.
 */
function _autoJournalFromStocktake(
  itemId,
  qtyDiff,
  sessionId,
  txId,
  username,
  dateStr,
) {
  try {
    if (!qtyDiff) return;
    var items = readSheet("Items");
    var item = items.find(function (i) {
      return i.id === itemId || i.code === itemId;
    });
    var unitCost = Number((item && item.cost_price) || 0);
    if (unitCost <= 0) {
      Logger.log("[B5-FIX] تجاهل قيد جرد — لا يوجد cost_price للصنف " + itemId);
      return;
    }
    var amount = Math.abs(qtyDiff) * unitCost;
    if (amount <= 0) return;

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var inventoryAcc = _getDefaultAccount(
      "inventory_account",
      accounts,
      "ASSET",
      ["مخزون", "بضاعة", "inventory", "stock"],
    );
    // [FIX-POSTING-AUDIT §4 — 2026-08-10] كان "stocktake_variance_account"
    // مفتاحاً غير مسجَّل بـ POSTING_CONFIG_KEYS (فلا يمكن تثبيته من شاشة
    // إعدادات الترحيل، ولا هو نفس المفتاح الظاهر بالشاشة تحت اسم "حساب
    // فروقات الجرد") — تم توحيده على المفتاح الرسمي inventory_variance_account.
    var varianceAcc = _getDefaultAccount(
      "inventory_variance_account",
      accounts,
      "EXPENSE",
      [
        "فروق الجرد",
        "عجز ومخصص جرد",
        "فروق مخزون",
        "stocktake variance",
        "فروق",
      ],
    );
    if (!inventoryAcc || !varianceAcc) {
      Logger.log(
        "[B5-FIX] تجاهل قيد جرد — لا يوجد حساب مخزون أو حساب فروق جرد في دليل الحسابات",
      );
      return;
    }

    var lines;
    if (qtyDiff > 0) {
      // زيادة فعلية عن النظام
      lines = [
        {
          account_id: inventoryAcc.id,
          debit: amount,
          credit: 0,
          notes: "زيادة جرد — " + itemId,
        },
        {
          account_id: varianceAcc.id,
          debit: 0,
          credit: amount,
          notes: "فروق جرد (زيادة) — " + sessionId,
        },
      ];
    } else {
      // عجز فعلي عن النظام
      lines = [
        {
          account_id: varianceAcc.id,
          debit: amount,
          credit: 0,
          notes: "فروق جرد (عجز) — " + sessionId,
        },
        {
          account_id: inventoryAcc.id,
          debit: 0,
          credit: amount,
          notes: "عجز جرد — " + itemId,
        },
      ];
    }

    var result = _addJournalEntryInternal({
      callerUser: username || "SYSTEM",
      date: dateStr || new Date().toISOString().split("T")[0],
      reference: txId,
      description: "تسوية جرد " + sessionId + " — " + itemId,
      source_type: "STOCKTAKE",
      lines: lines,
    });
    if (!result || !result.success) {
      Logger.log(
        "[B5-FIX] فشل قيد جرد " +
          txId +
          ": " +
          (result ? result.message : "unknown"),
      );
    }
  } catch (e) {
    Logger.log("[B5-FIX] _autoJournalFromStocktake error: " + e.message);
  }
}

function postStocktakeSession(data, sessionToken) {
  try {
    var username =
      _getUsernameFromToken(sessionToken) || (data && data.user) || "system";
    var permErr = _checkPermission(username, "addTransaction", sessionToken);
    if (permErr) return permErr;

    var rows = (data && data.rows) || [];
    if (!rows.length) return errResponse("لا توجد فروق جرد للترحيل");

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول، حاول مرة أخرى");
    }

    var sessionId = makeId("STK");
    var now = new Date();
    var sheet = getSheet("Transactions");
    var created = [];
    // [AUDIT-FIX-STOCKTAKE-JOURNAL-2026-08-08] كانت الكمية تتحدث بنجاح حتى لو
    // فشل القيد المحاسبي المقابل (Logger.log فقط، بدون أثر مرئي) — فيظهر
    // للمستخدم "تمت التسوية" بنجاح بينما قيمة المخزون المالية في دفتر الأستاذ
    // تبقى غير مطابقة للكمية الفعلية من غير أي تنبيه. نجمع الإخفاقات هنا
    // ونرجّعها صراحةً في الـ response + AuditLog (نفس نمط COGS_JOURNAL_FAILED
    // الموجود أصلاً في هذا الملف) بدل ما تختفي بصمت.
    var journalFailures = [];

    // [P5-E FIX] التحقق المسبق من كل الفروق قبل أي كتابة فعلية في الشيت.
    // قبل الإصلاح: كان الفحص (`_checkOutboundStock`) يحدث أثناء حلقة الكتابة
    // نفسها — فلو فشل صنف في منتصف جلسة جرد متعددة الأصناف (مثلاً نقص مخزون
    // غير كافٍ)، كانت الأصناف السابقة في نفس الجلسة قد كُتبت فعلاً (حركة مخزون
    // + قيد محاسبي) بينما يُعاد للمستخدم رد "فشل" يوحي بعدم حفظ أي شيء — تسوية
    // جرد جزئية صامتة لا تُطابق ما يراه المستخدم في الواجهة.
    var preErr = null;
    rows.forEach(function (r) {
      var itemId = String(r.item_id || "").trim();
      var warehouse = String(r.warehouse || "").trim() || "الرئيسي";
      var systemQty = Number(r.system_qty || 0);
      var actualQty = Number(r.actual_qty || 0);
      var diff = actualQty - systemQty;
      if (!itemId || diff === 0 || preErr) return;
      if (diff < 0) {
        var stockErr = _checkOutboundStock({
          type: "OUT",
          item_id: itemId,
          quantity: Math.abs(diff),
          from_warehouse: warehouse,
          warehouse: warehouse,
          color: String(r.color || "").trim(),
        });
        if (stockErr) preErr = stockErr;
      }
    });
    if (preErr) {
      lock.releaseLock();
      return errResponse(preErr);
    }

    rows.forEach(function (r, idx) {
      var itemId = String(r.item_id || "").trim();
      var warehouse = String(r.warehouse || "").trim() || "الرئيسي";
      var color = String(r.color || "").trim();
      var systemQty = Number(r.system_qty || 0);
      var actualQty = Number(r.actual_qty || 0);
      var diff = actualQty - systemQty;
      if (!itemId || diff === 0) return;

      var txType = diff > 0 ? "IN" : "OUT";
      var qty = Math.abs(diff);
      var tx = {
        type: txType,
        item_id: itemId,
        quantity: qty,
        from_warehouse: txType === "OUT" ? warehouse : "",
        to_warehouse: txType === "IN" ? warehouse : "",
        warehouse: warehouse,
        color: color,
        ref: sessionId,
        party: "",
        user: username,
        notes:
          "تسوية جرد " +
          sessionId +
          " | النظام: " +
          systemQty +
          " | الفعلي: " +
          actualQty +
          (data.notes ? " | " + data.notes : ""),
      };
      var stockErr = _checkOutboundStock(tx);
      if (stockErr) throw new Error(stockErr);
      var txId = sessionId + "-" + (idx + 1);
      // [ARCH-AUDIT-P3-7] appendRow خام -> DataLayerEngine.insert
      DataLayerEngine.insert(
        "Transactions",
        _txRowToObject(_buildTxRow(tx, txId, now)),
        { headers: HEADERS.Transactions },
      );
      updateStockBalance(tx);

      // [B5-FIX] قيد محاسبي تلقائي لفرق الجرد — قبل الإصلاح: postStocktakeSession
      // كانت تُحدِّث رصيد المخزون الكمي فقط دون أي أثر في الأستاذ العام،
      // فتظل قيمة المخزون المالية في GL مختلفة عن الكمية الفعلية بعد كل جرد.
      try {
        _autoJournalFromStocktake(
          itemId,
          diff,
          sessionId,
          txId,
          username,
          now.toISOString().split("T")[0],
        );
      } catch (stkJournalErr) {
        Logger.log(
          "[B5-FIX] فشل قيد فرق الجرد " + txId + ": " + stkJournalErr.message,
        );
        // [AUDIT-FIX-STOCKTAKE-JOURNAL-2026-08-08] تنبيه مرئي في سجل التدقيق
        // (وليس Logger فقط) — تسوية جرد بدون قيد محاسبي مقابل يجب أن تظهر
        // للمحاسب، مش تختفي بصمت. الكمية اتحدثت بالفعل في Stock (سطر أعلى)
        // فمفيش rollback هنا عمداً — التراجع عن الكمية بعد الإعلان للمستخدم
        // إنها اتسوّت هيكون مربك أكتر وغير آمن؛ الحل الصحيح هو تتبّع القيد
        // الناقص وإنشاؤه يدويًا/تلقائيًا لاحقًا، مش إخفاء حركة المخزون.
        try {
          AuditEngine.log("STOCKTAKE_JOURNAL_FAILED", {
            user: username,
            table: "Transactions",
            record_id: txId,
            details:
              "لم يتم إنشاء قيد محاسبي لفرق جرد الصنف " +
              itemId +
              " (جلسة " +
              sessionId +
              ", الفرق: " +
              diff +
              ") — السبب: " +
              stkJournalErr.message +
              ". الكمية في المخزون تم تحديثها بالفعل. يجب مراجعة القيد وإنشاؤه يدويًا.",
          });
        } catch (auditErr) {
          Logger.log(
            "[AUDIT-FIX-STOCKTAKE-JOURNAL] فشل تسجيل تنبيه AuditLog: " +
              auditErr.message,
          );
        }
        journalFailures.push({
          item_id: itemId,
          tx_id: txId,
          diff: diff,
          reason: stkJournalErr.message,
        });
      }

      created.push({
        id: txId,
        type: txType,
        item_id: itemId,
        quantity: qty,
        from_warehouse: tx.from_warehouse,
        to_warehouse: tx.to_warehouse,
        warehouse: warehouse,
        color: color,
        ref: sessionId,
        permit_id: sessionId,
        notes: tx.notes,
        user: username,
        date: now.toISOString(),
      });
    });

    if (!created.length) {
      lock.releaseLock();
      return errResponse("لا توجد فروق جرد للترحيل");
    }

    AuditEngine.log("POST_STOCKTAKE", {
      user: username,
      table: "Transactions",
      record_id: sessionId,
      details:
        "عدد التسويات: " +
        created.length +
        (journalFailures.length
          ? " | قيود محاسبية فاشلة: " + journalFailures.length
          : "")});
    _invalidateServerCacheInvoices(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    lock.releaseLock();
    // [AUDIT-FIX-STOCKTAKE-JOURNAL-2026-08-08] لو فيه قيود فشلت، لازم يظهر
    // تحذير صريح للمستخدم بدل رسالة نجاح عامة توهم إن كل حاجة (كمية + قيد)
    // اتسوّت. بنستخدم نفس اتفاقية journal_warning الموجودة أصلاً في
    // SaveEngine (32_JS_SaveEngine.html، سطر ~513) واللي بتعرض توست تحذير
    // منفصل يفضل ظاهر تلقائيًا — من غير أي تعديل مطلوب في الواجهة.
    return {
      success: true,
      message: "تم ترحيل فروق الجرد",
      journal_warning: journalFailures.length
        ? journalFailures.length +
          " قيد محاسبي لفرق الجرد لم يُنشأ (الأصناف: " +
          journalFailures.map(function (f) { return f.item_id; }).join(", ") +
          ") — الكمية تم تحديثها، راجع سجل التدقيق وأنشئ القيد يدويًا"
        : undefined,
      data: {
        id: sessionId,
        movements: created,
        journal_failures: journalFailures,
      },
    };
  } catch (e) {
    try {
      lock.releaseLock();
    } catch (le) {
      Logger.log("[silent-catch] " + le);
    }
    return errResponse("خطأ في ترحيل الجرد: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// [BUG-007 FIX] _recomputeInvoiceTotalsFromLines — يعيد احتساب إجماليات
// الفاتورة (subtotal / discount_amount / vat_amount / net_total) من بنودها
// (lines) وقيم الخصم/الضريبة على مستوى الفاتورة، بنفس المنطق المستخدم في
// الواجهة (_calcInvoiceTotals / _collectInvoiceData في 15_JS_Invoices.html)،
// عشان السيرفر يبقى "مصدر الحقيقة الوحيد" لأي رقم مالي حرج بدل الثقة
// الكاملة في القيم المُرسَلة من المتصفح. راجع BUG-007 في تقرير الاستقرار.
function _recomputeInvoiceTotalsFromLines(invoiceData) {
  var lines = (invoiceData && invoiceData.lines) || [];
  var subtotal = 0;
  lines.forEach(function (l) {
    var qty = Number((l && l.qty) || 0);
    var price = Number((l && l.unit_price) || 0);
    var gross = qty * price;
    var lineDiscVal = Number((l && l.discount_value) || 0);
    var lineDiscType = (l && l.discount_type) || "fixed";
    var lineDiscAmount =
      lineDiscVal > 0
        ? lineDiscType === "percent"
          ? gross * (lineDiscVal / 100)
          : lineDiscVal
        : 0;
    lineDiscAmount = Math.min(lineDiscAmount, gross);
    subtotal += gross - lineDiscAmount;
  });

  var discVal = Number((invoiceData && invoiceData.discount_value) || 0);
  var discType = (invoiceData && invoiceData.discount_type) || "percent";
  var discAmount =
    discType === "percent" ? subtotal * (discVal / 100) : discVal;
  discAmount = Math.min(discAmount, subtotal);
  var afterDisc = subtotal - discAmount;

  // [AUDIT-FIX INVSET-02] قبل هذا التعديل، كانت الفاتورة تحسب الضريبة دايمًا
  // من vat_percent المرسل من الواجهة بدون أي رجوع لإعدادات الفواتير —
  // يعني: tax_enabled كان تفعيله/تعطيله من الشاشة بلا أي أثر فعلي (لو
  // العميل (المتصفح) بعت vat_percent، بتتحسب برضه حتى لو الضريبة "معطّلة"
  // من الإعدادات)، وكذلك prices_include_tax مكنش له أي معالجة أصلاً
  // (السعر كان يُعامل دايمًا كسعر غير شامل للضريبة). التعديل ده يخلي
  // السيرفر (مش الواجهة) هو مصدر الحقيقة لسياسة الضريبة، تمشيًا مع قاعدة
  // "الفرض في الـ Backend مش بس الـ Frontend".
  var taxEnabled =
    typeof InvoiceSettingsEngine === "undefined" ||
    InvoiceSettingsEngine.get("tax_enabled") !== false; // افتراضي: مفعّلة
  var vatPct = 0;
  if (taxEnabled) {
    var sentVatPct = invoiceData && invoiceData.vat_percent;
    // لو الواجهة مبعتش نسبة ضريبة صراحة، نرجع لنسبة الضريبة الافتراضية
    // من الإعدادات (default_tax_rate) بدل الصفر الصامت.
    vatPct =
      sentVatPct !== undefined && sentVatPct !== null && sentVatPct !== ""
        ? Number(sentVatPct)
        : Number(
            (typeof InvoiceSettingsEngine !== "undefined" &&
              InvoiceSettingsEngine.get("default_tax_rate")) ||
              0,
          );
  }

  var pricesIncludeTax =
    taxEnabled &&
    typeof InvoiceSettingsEngine !== "undefined" &&
    InvoiceSettingsEngine.get("prices_include_tax") === true;

  var vatAmount, netTotal;
  if (pricesIncludeTax && vatPct > 0) {
    // الأسعار المُدخلة شاملة الضريبة بالفعل: afterDisc هو الصافي الشامل،
    // ونستخرج مبلغ الضريبة منه (Tax Extraction) بدل إضافته فوقه.
    netTotal = afterDisc;
    vatAmount = afterDisc - afterDisc / (1 + vatPct / 100);
  } else {
    vatAmount = afterDisc * (vatPct / 100);
    netTotal = afterDisc + vatAmount;
  }

  return {
    subtotal: subtotal,
    discount_amount: discAmount,
    vat_amount: vatAmount,
    net_total: netTotal,
    vat_percent_applied: vatPct,
    prices_include_tax: pricesIncludeTax,
  };
}

// [BUG-007 FIX] _validateInvoiceTotalsOrReject — يقارن الإجماليات المُرسَلة
// من العميل بالإجماليات المحسوبة فعليًا على السيرفر من البنود، بهامش تسامح
// بسيط لفروق التقريب (0.02). لو في اختلاف حقيقي، بيرجع رسالة رفض بدل حفظ
// الفاتورة بأرقام قد تكون مُتلاعَبًا بها أو ناتجة عن خطأ حساب في الواجهة.
// النتيجة الناجحة تتضمن أيضًا القيم المحسوبة (computed) عشان تُستخدم كمصدر
// الحقيقة الوحيد عند بناء صف الفاتورة، بدل القيم المُرسَلة من المتصفح.
function _validateInvoiceTotalsOrReject(invoiceData, invoiceLabel) {
  var TOL = 0.02; // هامش تسامح لفروق التقريب
  var computed = _recomputeInvoiceTotalsFromLines(invoiceData);

  var sentSubtotal = Number((invoiceData && invoiceData.subtotal) || 0);
  var sentDiscAmount = Number(
    (invoiceData && invoiceData.discount_amount) || 0,
  );
  var sentVatAmount = Number((invoiceData && invoiceData.vat_amount) || 0);
  var sentNetTotal = Number((invoiceData && invoiceData.net_total) || 0);

  var mismatched =
    Math.abs(sentSubtotal - computed.subtotal) > TOL ||
    Math.abs(sentDiscAmount - computed.discount_amount) > TOL ||
    Math.abs(sentVatAmount - computed.vat_amount) > TOL ||
    Math.abs(sentNetTotal - computed.net_total) > TOL;

  if (mismatched) {
    return {
      ok: false,
      error: {
        success: false,
        message:
          " إجمالي " +
          (invoiceLabel || "الفاتورة") +
          " لا يطابق مجموع البنود المحسوب من السيرفر — الصافي المتوقع " +
          computed.net_total.toFixed(2) +
          " مقابل " +
          sentNetTotal.toFixed(2) +
          " مُرسَل. يرجى إعادة تحميل الشاشة والمحاولة مجددًا، ولو تكرر الخطأ برجاء مراجعة الدعم الفني.",
      },
    };
  }
  return { ok: true, computed: computed };
}

// addSaleInvoice — إضافة فاتورة بيع جديدة
// ─────────────────────────────────────────────────────────────
function addSaleInvoice(invoiceData, sessionToken) {
  // [C-02 FIX] استخراج اسم المستخدم من التوكن أولاً، والتحقق الفعلي من نتيجة الصلاحية
  // كان الكود القديم يضع _checkPermission في try بدون فحص الإرجاع — فلا يُرفض أي استدعاء أبداً
  var username = _getUsernameFromToken(sessionToken) || "system";
  var permErr = _checkPermission(username, "addSaleInvoice", sessionToken);
  if (permErr) return permErr;

  // [TRACK1-FIX-2026-08-12] حارس الـ idempotency (client_request_id) كان
  // بيُطالَب بالمفتاح هنا فوق قبل كل الفحوصات (posting setup / stock
  // prevalidate / max items / totals / min amount / item policies /
  // notes / discount limit / blacklist / period lock) — أي رفض مشروع في
  // أي فحص من دول كان "يحرق" client_request_id لمدة دقيقتين (TTL في
  // _requireIdempotencyKey) رغم إن الفاتورة لم تُنشأ إطلاقاً. فلو المستخدم
  // صلّح البيانات (مثلاً أضاف ملاحظة إلزامية أو غيّر الكمية) وأعاد الإرسال
  // بنفس client_request_id (وهو المتوقع من الواجهة عند retry لنفس محاولة
  // الحفظ)، كان يُرفض خطأً باعتباره "طلب مكرر" رغم عدم وجود أي فاتورة
  // فعلية. الحل: نقل المطالبة بالمفتاح لتكون آخر خطوة قبل بدء الكتابة
  // الفعلية (قبل أخذ الـ lock مباشرة)، بحيث لا تُستهلك إلا لو الطلب فعلاً
  // اجتاز كل الفحوصات وعلى وشك الكتابة — راجع نفس التعليق المنقول أسفل.
  var _crIdSaleKey =
    invoiceData && invoiceData.client_request_id
      ? "sinv_" + String(invoiceData.client_request_id)
      : null;

  // [P1-GATE] منع إنشاء فاتورة بيع إن لم تكن حسابات الترحيل الأساسية مربوطة —
  // بدل السماح بحفظ الفاتورة وخصم المخزون دون أي قيد محاسبي مقابل (راجع
  // verifyPostingSetupComplete أعلاه لشرح سبب هذا الفحص).
  var requiredSaleKeys = [
    "cash_account",
    "ar_account",
    "revenue_account",
    "inventory_account",
    "cogs_account",
  ];
  if (Number(invoiceData && invoiceData.vat_amount) > 0) {
    requiredSaleKeys.push("vat_output_account");
  }
  // [AUDIT-FIX-2026-08-08 §RISK-3] كان الخصم على مستوى الفاتورة، عند غياب
  // sales_discount_account، يُدمج بصمت في صافي الإيراد (راجع
  // _pushRevenueLinesForInvoice / تعليق [DISCOUNT-FIX] أسفل) — قرار آمن
  // لتوازن القيد لكنه يُخفي "إجمالي الخصومات الممنوحة" عن قائمة الدخل.
  // الآن: لو فيه خصم فعلي مُرسَل مع الفاتورة، نفرض وجود حساب الخصم صراحة
  // بنفس فلسفة vat_output_account أعلاه، بدل ترك الدمج الصامت يحدث دائماً.
  if (Number(invoiceData && invoiceData.discount_value) > 0) {
    requiredSaleKeys.push("sales_discount_account");
  }
  var saleSetup = verifyPostingSetupComplete(requiredSaleKeys);
  if (!saleSetup.complete) {
    return {
      success: false,
      message: _postingSetupErrorMessage(saleSetup.missing),
    };
  }

  var preStockErr = _prevalidateInvoiceStock(invoiceData, "OUT");
  if (preStockErr) return { success: false, message: preStockErr };

  // [AUDIT-FIX INVSET-06] sale_max_items_per_invoice — قبل التعديل، الإعداد
  // كان معروض في شاشة إعدادات الفواتير بدون أي فحص فعلي؛ ممكن تضيف أي عدد
  // من البنود لفاتورة البيع بغض النظر عن القيمة المحددة. 0 = بدون حد.
  if (typeof InvoiceSettingsEngine !== "undefined") {
    var _maxItemsPerInv = Number(
      InvoiceSettingsEngine.get("sale_max_items_per_invoice") || 0,
    );
    var _linesCountSale = (invoiceData && invoiceData.lines) || [];
    if (_maxItemsPerInv > 0 && _linesCountSale.length > _maxItemsPerInv) {
      return {
        success: false,
        message:
          "عدد الأصناف في فاتورة البيع (" +
          _linesCountSale.length +
          ") يتجاوز الحد الأقصى المسموح به (" +
          _maxItemsPerInv +
          " صنف) حسب إعدادات الفواتير",
      };
    }
  }

  // [BUG-007 FIX] رفض حفظ الفاتورة لو الإجماليات المُرسَلة من المتصفح
  // (subtotal/الخصم/الضريبة/net_total) لا تطابق الاحتساب الفعلي من بنود
  // الفاتورة — بدل الثقة الكاملة في القيمة المُرسَلة (كانت تُستخدم مباشرة
  // في القيد المحاسبي وفحص حد الائتمان بدون أي تحقق من السيرفر).
  var _totalsCheckSale = _validateInvoiceTotalsOrReject(
    invoiceData,
    "فاتورة البيع",
  );
  if (!_totalsCheckSale.ok) return _totalsCheckSale.error;
  var _computedTotalsSale = _totalsCheckSale.computed;

  // [INVSET-WIRE-2026-08-08] min_sale_request_amount — كان الإعداد محفوظًا
  // بدون أي فحص فعلي؛ لو مضبوط بقيمة > 0 يمنع حفظ فاتورة بيع إجماليها
  // الصافي أقل من الحد الأدنى.
  if (typeof InvoiceSettingsEngine !== "undefined") {
    var _minSaleAmt = Number(InvoiceSettingsEngine.get("min_sale_request_amount") || 0);
    var _netTotalForMin = Number(
      (_computedTotalsSale && _computedTotalsSale.net_total) || 0,
    );
    if (_minSaleAmt > 0 && _netTotalForMin < _minSaleAmt) {
      return {
        success: false,
        message:
          "إجمالي الفاتورة (" +
          _netTotalForMin.toFixed(2) +
          ") أقل من الحد الأدنى المسموح به لفواتير البيع (" +
          _minSaleAmt.toFixed(2) +
          ") حسب إعدادات الفواتير",
      };
    }
  }

  // [AUDIT-FIX Inventory §2.3] تفعيل سياسات الصنف (حد الخصم، حد أدنى للهامش،
  // العمولة) بدل ما تفضل حقول معروضة بدون أي أثر فعلي
  var _itemPolicyCheck = _validateAndComputeLineItemPolicies(
    invoiceData.lines || [],
  );
  if (!_itemPolicyCheck.ok) return _itemPolicyCheck.error;

  // [FIX-AUDIT #2] تفعيل إعداد "الملاحظات إلزامية على الحركات"
  var _notesErrSale = _checkRequireNotesOnTx(invoiceData && invoiceData.notes);
  if (_notesErrSale) return _notesErrSale;

  // ═══════════════════════════════════════════════════════════════
  // [INV2-SETTINGS-2026-08-07] الحد الأقصى للخصم على مستوى الفاتورة
  // (max_discount_percent من InvoiceSettingsEngine) — يُفحص فقط لو نوع
  // الخصم "percent" (خصم بمبلغ ثابت مش له نسبة تتقارن بحد أقصى %).
  // 0 = بدون حد أقصى. لو تجاوز الحد ومطلوب موافقة (require_approval_
  // over_max_discount)، بيتفحص صلاحية overrideDiscountLimit للمستخدم
  // الحالي — بنفس فلسفة تجاوز حد الائتمان بالظبط.
  // ═══════════════════════════════════════════════════════════════
  if (typeof InvoiceSettingsEngine !== "undefined") {
    var _discType = invoiceData.discount_type || "percent";
    var _discVal = Number(invoiceData.discount_value || 0);
    // [AUDIT-FIX INVSET-05] allow_invoice_discount — قبل التعديل كان
    // ممكن تبعت خصم إجمالي على الفاتورة حتى لو الإعداد معطّل، لأن الفحص
    // الوحيد الموجود كان لحد "أقصى" للخصم (max_discount_percent) وليس
    // لمنع الخصم بالكامل. الآن: لو الإعداد false ووصل خصم فعلي (> 0)،
    // تُرفض الفاتورة من السيرفر مباشرة.
    if (
      _discVal > 0 &&
      InvoiceSettingsEngine.get("allow_invoice_discount") === false
    ) {
      return {
        success: false,
        message: "الخصم على مستوى الفاتورة معطّل حاليًا من إعدادات الفواتير",
      };
    }
    var _maxDiscPct = Number(InvoiceSettingsEngine.get("max_discount_percent") || 0);
    if (_discType === "percent" && _maxDiscPct > 0 && _discVal > _maxDiscPct) {
      var _requireApproval = InvoiceSettingsEngine.get(
        "require_approval_over_max_discount",
      );
      var _canOverrideDiscount =
        _checkPermission(username, "overrideDiscountLimit", sessionToken) ===
        null;
      if (_requireApproval && !_canOverrideDiscount) {
        return {
          success: false,
          message:
            "نسبة الخصم (" +
            _discVal +
            "%) تتجاوز الحد الأقصى المسموح (" +
            _maxDiscPct +
            "%) — يحتاج موافقة مستخدم لديه صلاحية تجاوز حد الخصم",
        };
      }
    }
  }

  // §BP-P5 — منع إنشاء فاتورة بيع لعميل على القائمة السوداء (فحص مبكر
  // قبل أخذ الـ lock، نفس أسلوب preStockErr/_notesErrSale أعلاه)
  var _blCustomerId =
    invoiceData.party_id ||
    _resolvePartyIdByName(invoiceData.party, "customer") ||
    "";
  if (_blCustomerId) {
    var _blCustomer = _getPartyById("customer", _blCustomerId);
    if (_blCustomer && _blCustomer.is_blacklisted) {
      return {
        success: false,
        message:
          'لا يمكن إنشاء فاتورة بيع — العميل "' +
          (_blCustomer.name || "") +
          '" مُدرَج في القائمة السوداء',
      };
    }
  }

  // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية — كان مفقوداً في
  // مسار الإنشاء رغم وجوده في الحذف (راجع تقرير المراجعة، المرحلة 2، ثغرة #3).
  var _invDateForPeriod = invoiceData.date || new Date().toISOString().split("T")[0];
  var _periodErrSale = _blockIfPeriodClosed(_invDateForPeriod, "فاتورة البيع");
  if (_periodErrSale) return _periodErrSale;

  // [TRACK1-FIX-2026-08-12] راجع تعليق [TRACK1-FIX-2026-08-12] فوق — هذه
  // آخر نقطة ممكنة قبل الكتابة الفعلية، فهي المكان الصحيح لاستهلاك مفتاح
  // الـ idempotency (بدل أعلى الدالة).
  if (_crIdSaleKey) {
    var _crIdSale = _requireIdempotencyKey(_crIdSaleKey);
    if (!_crIdSale.ok) return _crIdSale.error;
  }

  try {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);

    var id = makeId("SINV");
    var now = new Date().toISOString();
    var linesJson = JSON.stringify(invoiceData.lines || []);

    // [INV2-SETTINGS-2026-08-07] توليد رقم العرض حسب إعدادات ترقيم
    // الفواتير — منفصل عن id، راجع الشرح أعلى SALE_INVOICE_HEADERS.
    var invoiceNo = id;
    if (typeof InvoiceNumberingService !== "undefined") {
      try {
        var _isetForNo = InvoiceSettingsEngine.getAll();
        var _existingSaleInvoicesForNo = readSheet(
          "SaleInvoices",
          SALE_INVOICE_HEADERS,
          { trimStrings: true },
        );
        if (_isetForNo.numbering_reset_yearly) {
          var _yr = new Date().getFullYear();
          _existingSaleInvoicesForNo = _existingSaleInvoicesForNo.filter(
            function (r) {
              var d = new Date(r.date || r.created_at);
              return !isNaN(d.getTime()) && d.getFullYear() === _yr;
            },
          );
        }
        invoiceNo = InvoiceNumberingService.next("sale", function () {
          return _existingSaleInvoicesForNo.map(function (r) {
            return r.invoice_no;
          });
        });
      } catch (numErr) {
        Logger.log("[INV2-SETTINGS] فشل توليد invoice_no: " + numErr.message);
        invoiceNo = id; // fallback آمن — الفاتورة متتوقفش بسبب فشل الترقيم
      }
    }

    // [C7-FIX] حل party_id من اسم العميل إن لم يُرسل صراحة
    var resolvedCustomerPartyId =
      invoiceData.party_id ||
      _resolvePartyIdByName(invoiceData.party, "customer") ||
      "";

    // [AUDIT-FIX-2026-08-08 §RISK-2] حارس منع التكرار (idempotency guard)
    // — لم يكن هناك أي حماية من Double-submit/Retry حقيقي (طلبين متتاليين
    // فعليين، وليس تزامناً يمنعه LockService وحده). نرفض إن وُجدت فاتورة
    // بنفس العميل + نفس صافي الإجمالي + نفس بنود الفاتورة (lines_json) خلال
    // آخر 20 ثانية — نفس فلسفة الحارس المطبَّق فعلاً في autoJournalFromShipment
    // (Code_22_Shipping.js، [P9-FIX])، لكن هنا على مستوى الفاتورة كاملة.
    // ملاحظة: لا يمنع فاتورتين متعمّدتين متطابقتين تماماً بفارق أكثر من
    // 20 ثانية — هذا حارس ضد Double-click/Retry فقط، وليس بديلاً عن رقم
    // مرجعي (client_request_id) لو احتاج النظام لاحقاً حماية أقوى.
    try {
      var _dedupWindowMs = 20000;
      var _dedupNowTs = Date.now();
      var _recentSaleInvoices = readSheet(
        "SaleInvoices",
        SALE_INVOICE_HEADERS,
        { trimStrings: true },
      );
      var _dupSaleInv = _recentSaleInvoices.find(function (r) {
        if (String(r.party_id || "") !== String(resolvedCustomerPartyId || ""))
          return false;
        if (
          Math.abs(
            Number(r.net_total || 0) - Number(_computedTotalsSale.net_total || 0),
          ) > 0.01
        )
          return false;
        if (String(r.lines_json || "") !== linesJson) return false;
        var _createdTs = new Date(r.created_at || 0).getTime();
        return (
          !isNaN(_createdTs) &&
          _dedupNowTs - _createdTs >= 0 &&
          _dedupNowTs - _createdTs < _dedupWindowMs
        );
      });
      if (_dupSaleInv) {
        lock.releaseLock();
        return {
          success: false,
          message:
            "يبدو أن هذه الفاتورة أُرسِلت للتو (خلال آخر 20 ثانية) بنفس العميل والبنود والإجمالي — الفاتورة رقم " +
            (_dupSaleInv.invoice_no || _dupSaleInv.id) +
            ". لو كانت فاتورة جديدة فعلاً، انتظر لحظة وأعد المحاولة",
        };
      }
    } catch (_dedupErrSale) {
      // فشل فحص التكرار نفسه لا يجب أن يمنع الفاتورة الحقيقية — نُسجّل فقط
      Logger.log(
        "[RISK-2-DEDUP] فشل فحص تكرار فاتورة البيع: " + _dedupErrSale.message,
      );
    }

    var sheet = getSheet("SaleInvoices");

    // [ARCH-AUDIT-P3-8] appendRow خام (25 حقل positional) -> DataLayerEngine.insert
    // بكائن بمفاتيح صريحة (اتفحصت مطابقة الترتيب لـ SALE_INVOICE_HEADERS
    // حقل بحقل قبل التحويل) — أوضح وأأمن من مصفوفة positional لفاتورة
    // بيع، أخطر نقطة كتابة في المشروع كله.
    DataLayerEngine.insert(
      "SaleInvoices",
      {
        id: id,
        invoice_no: invoiceNo,
        date: invoiceData.date || now.split("T")[0],
        party: invoiceData.party || "",
        party_id: resolvedCustomerPartyId,
        permit_id: invoiceData.permit_id || "",
        payment_status: invoiceData.payment_status || "كاش",
        due_date: invoiceData.due_date || "",
        subtotal: Number(_computedTotalsSale.subtotal || 0),
        discount_value: Number(invoiceData.discount_value || 0),
        discount_type: invoiceData.discount_type || "percent",
        discount_amount: Number(_computedTotalsSale.discount_amount || 0),
        vat_percent: Number(invoiceData.vat_percent || 0),
        vat_amount: Number(_computedTotalsSale.vat_amount || 0),
        net_total: Number(_computedTotalsSale.net_total || 0),
        lines_json: linesJson,
        notes: invoiceData.notes || "",
        created_by: username,
        created_at: now,
        status: "confirmed",
        shipment_id: invoiceData.shipment_id || "",
        shipping_cost: Number(invoiceData.shipping_cost || 0),
        shipping_cost_on: invoiceData.shipping_cost_on || "company",
        shipping_company_id: invoiceData.shipping_company_id || "",
        paid_amount: 0,
        remaining_amount: Number(_computedTotalsSale.net_total || 0),
        commission_amount: Number(_itemPolicyCheck.commission_amount || 0),
      },
      { headers: SALE_INVOICE_HEADERS },
    );

    // ─── [C10-FIX] التحقق من حد الائتمان قبل إتمام الفاتورة الآجلة ─────────
    // قاعدة: الفواتير النقدية (كاش) لا تخضع لحد الائتمان
    // فقط الفواتير الآجلة تُراكم رصيد الذمم وتُقارَن بالحد المسموح
    // ملاحظة: الصف أُضيف مسبقاً — إن تجاوز الحد، يُحذف ويُرجع خطأ
    // ────────────────────────────────────────────────────────────────────────
    var _creditLimitWarningForResponse = null;
    if (
      String(invoiceData.payment_status || "").trim() === "آجل" &&
      invoiceData.party
    ) {
      try {
        var customersForLimit = readSheet("Customers", CUSTOMER_HEADERS, {
          trimStrings: true,
        });
        // [AUDIT-FIX M1] نفس عائلة خطأ C1: كانت تطابق العميل بالاسم النصي
        // (c.name === invoiceData.party) بدل المعرف المستقر. لو تغيّر اسم
        // العميل بعد وجود فواتير سابقة، هذا الفحص كان يفقد تلك الفواتير
        // القديمة من حساب "الرصيد القائم" فيسمح بتجاوز حد الائتمان فعليًا.
        // نطابق الآن أولًا بـ resolvedCustomerPartyId (نفس المعرف المكتوب
        // في عمود party_id بالفاتورة الحالية)، مع الإبقاء على المطابقة
        // بالاسم كـ fallback لو تعذّر تحديد معرف مستقر (توافق خلفي).
        var customerRec = resolvedCustomerPartyId
          ? customersForLimit.find(function (c) {
              return String(c.id) === String(resolvedCustomerPartyId);
            })
          : customersForLimit.find(function (c) {
              return c.name === invoiceData.party || c.id === invoiceData.party;
            });
        var creditLimit = Number(
          (customerRec && customerRec.credit_limit) || 0,
        );
        // [CUST-SETTINGS-2026-08-07] لو العميل مفهوش حد ائتمان خاص بيه
        // (0 أو فاضي)، نرجع للحد الافتراضي العام من إعدادات العملاء
        // (default_credit_limit) لو محدد. القيمة الخاصة بالعميل، لو
        // موجودة، بتفضل هي الأولوية دايمًا (زي منطق fallback الأسعار).
        if (
          creditLimit <= 0 &&
          typeof CustomerSettingsEngine !== "undefined"
        ) {
          var _defaultLimit = Number(
            CustomerSettingsEngine.get("default_credit_limit") || 0,
          );
          if (_defaultLimit > 0) creditLimit = _defaultLimit;
        }
        if (creditLimit > 0) {
          var allSaleInvoices = readSheet(
            "SaleInvoices",
            SALE_INVOICE_HEADERS,
            { trimStrings: true },
          );
          // [AUDIT-FIX CREDITLIMIT-2026-08-08] كان بيجمع net_total الكامل
          // لكل فاتورة "آجل" من غير خصم أي سداد سابق عليها — payment_status
          // فعليًا لا يتغيّر بعد الإنشاء ولا remaining_amount يتحدّث تلقائيًا
          // في أي مكان بالمشروع (راجع التعليق القديم المضلِّل على الحقل)،
          // فكل فاتورة آجلة كانت تُحسب بكامل قيمتها للأبد حتى لو اتسددت
          // بالكامل بسندات قبض — يخلي فحص حد الائتمان يتضخّم تدريجيًا ويمنع
          // مبيعات مشروعة لعملاء سدّدوا فعليًا. نفس نمط الخصم المستخدم أصلاً
          // وبشكل صحيح في getAgingReport (Code_20a_Parties.js) — نجمع
          // المسدَّد فعليًا لكل فاتورة من سندات القبض المرتبطة (غير الملغاة/
          // المعكوسة) ونخصمه من net_total قبل الجمع.
          var _receiptVouchersForLimit = readSheet(
            "ReceiptVouchers",
            ACCOUNTING_HR_HEADERS.ReceiptVouchers,
            { trimStrings: true },
          );
          var _paidByInvoiceForLimit = {};
          _receiptVouchersForLimit.forEach(function (v) {
            if (v.status === "CANCELLED" || v.status === "REVERSED") return;
            if (!v.invoice_id) return;
            var amt = Number(v.applied_amount || v.amount || 0);
            _paidByInvoiceForLimit[v.invoice_id] =
              (_paidByInvoiceForLimit[v.invoice_id] || 0) + amt;
          });
          var existingDebt = allSaleInvoices.reduce(function (sum, inv) {
            // [AUDIT-FIX M1] نفس التصحيح: مطابقة party_id أولًا بدل الاسم
            var matches = resolvedCustomerPartyId
              ? String(inv.party_id || "") === String(resolvedCustomerPartyId)
              : inv.party === invoiceData.party;
            if (
              matches &&
              inv.payment_status === "آجل" &&
              inv.id !== id
            ) {
              var _paid = _paidByInvoiceForLimit[inv.id] || 0;
              var _rem = Number(inv.net_total || 0) - _paid;
              return sum + (_rem > 0 ? _rem : 0);
            }
            return sum;
          }, 0);
          // [BUG-007 FIX] استخدام الصافي المحسوب على السيرفر لفحص حد
          // الائتمان، بدل القيمة المُرسَلة من المتصفح (كانت قابلة للتحايل
          // بإرسال net_total أقل من الحقيقي لتجاوز الحد).
          var invoiceAmount = Number(_computedTotalsSale.net_total || 0);
          if (existingDebt + invoiceAmount > creditLimit) {
            // ═══════════════════════════════════════════════════════
            // [CUST-SETTINGS-2026-08-07] بدل المنع الثابت دايمًا، السلوك
            // دلوقتي بيتحكم فيه CustomerSettingsEngine:
            //   - block_sale_over_credit_limit = false → يُسمح بالفاتورة
            //     مع تحذير في اللوج بس (بدون منع)
            //   - allow_manager_override_credit_limit = true + المستخدم
            //     الحالي عنده صلاحية overrideCreditLimit → يُسمح بالتجاوز
            //     (بدل ما يكون المنع مطلق زي ما كان قبل كده)
            // لو CustomerSettingsEngine مش متاح لأي سبب، السلوك القديم
            // (منع مطلق دايمًا) يفضل شغّال زي ما هو — أمان أولاً.
            // ═══════════════════════════════════════════════════════
            // [AUDIT-FIX CUST-29] كان فيه مفتاحين بيتحكموا في نفس القرار
            // بتعارض فعلي: block_sale_over_credit_limit (Boolean، مربوط
            // فعليًا هنا) وcredit_limit_exceed_behavior (Enum بـ3 حالات،
            // معروض في الشاشة بس مش مقروء خالص). دلوقتي credit_limit_
            // exceed_behavior هو مصدر الحقيقة الوحيد، وsaveCustomerSettings
            // بتزامن القيمتين تلقائيًا عند الحفظ (راجع Code_58) عشان أي
            // كود قديم لسه بيقرا block_sale_over_credit_limit يفضل صحيح.
            var _blockOverLimit = true;
            var _allowManagerOverride = false;
            var _exceedBehavior = "block";
            if (typeof CustomerSettingsEngine !== "undefined") {
              _exceedBehavior =
                CustomerSettingsEngine.get("credit_limit_exceed_behavior") ||
                "block";
              _blockOverLimit = _exceedBehavior === "block";
              _allowManagerOverride = CustomerSettingsEngine.get(
                "allow_manager_override_credit_limit",
              );
            }
            var _userCanOverride =
              _allowManagerOverride &&
              _checkPermission(username, "overrideCreditLimit", sessionToken) ===
                null;

            if (_blockOverLimit && !_userCanOverride) {
              var lastRow = sheet.getLastRow();
              if (lastRow > 1) sheet.deleteRow(lastRow);
              lock.releaseLock();
              return {
                success: false,
                message:
                  " تجاوز حد الائتمان: الرصيد القائم " +
                  existingDebt.toFixed(2) +
                  " + هذه الفاتورة " +
                  invoiceAmount.toFixed(2) +
                  " = " +
                  (existingDebt + invoiceAmount).toFixed(2) +
                  " يتجاوز الحد المسموح به (" +
                  creditLimit.toFixed(2) +
                  ")" +
                  " — راجع المحاسب للحصول على موافقة استثنائية",
              };
            }
            // إما السلوك المختار "تنبيه فقط"/"تنبيه عند الإنهاء"، أو
            // المستخدم عنده صلاحية تجاوز — الفاتورة بتكمل، لكن بيتسجّل
            // تحذير في اللوج للتتبع دايمًا. لو السلوك "warn_on_finish"
            // بالتحديد، بنرفع علم creditLimitWarning في نتيجة الحفظ عشان
            // أي واجهة تقدر تعرض تنبيه فعلي للمستخدم (بدل ما يكون توثيقي بس).
            if (_exceedBehavior === "warn_on_finish") {
              _creditLimitWarningForResponse = {
                message:
                  "تنبيه: هذه الفاتورة تجاوزت حد الائتمان المسموح به (" +
                  creditLimit.toFixed(2) +
                  ")",
                existingDebt: existingDebt,
                invoiceAmount: invoiceAmount,
                creditLimit: creditLimit,
              };
            }
            Logger.log(
              "[CUST-SETTINGS] فاتورة بيع آجلة تجاوزت حد الائتمان وتم " +
                "السماح بها (exceed_behavior=" +
                _exceedBehavior +
                ", user_override=" +
                _userCanOverride +
                ") — العميل: " +
                (resolvedCustomerPartyId || invoiceData.party) +
                "، الفاتورة: " +
                id,
            );
          }
        }
      } catch (creditErr) {
        Logger.log(
          "[C10-FIX] تحذير: فشل فحص حد الائتمان — الفاتورة مُقبلة بدون فحص: " +
            creditErr.message,
        );
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // [AUDIT-FIX INVSET-03] deduct_stock_on_sale_confirm — قبل هذا التعديل
    // كان تعطيل هذا الإعداد من الشاشة بلا أي أثر: حركة صرف المخزون كانت
    // تُنشأ دايمًا مهما كانت قيمة الإعداد. الافتراضي (لو الإعداد مش موجود
    // أو true) هو نفس السلوك القديم بالضبط — الفرق فقط لو الإعداد صراحة
    // false، حينها الفاتورة تُحفظ بدون خصم كمية من المخزون (مفيد لحالات
    // الفوترة بدون تتبع كمي، أو ترحيل المخزون يدويًا لاحقًا).
    var _deductStockOnConfirm =
      typeof InvoiceSettingsEngine === "undefined" ||
      InvoiceSettingsEngine.get("deduct_stock_on_sale_confirm") !== false;

    var stockMovements = [];
    if (_deductStockOnConfirm) {
      try {
        stockMovements = _createInvoiceStockMovements(
          id,
          invoiceData,
          "OUT",
          username,
          sessionToken,
        );
      } catch (stockErr) {
        // [ATOMIC-INVOICE-FIX] كان الخطأ القديم يُرمى برسالة "تم حفظ الفاتورة
        // لكن فشل تحديث المخزون" دون حذف صف الفاتورة الذي أُضيف بالفعل أعلاه —
        // فتبقى فاتورة "مؤكدة" بلا حركة مخزون ولا قيد محاسبي (بيانات يتيمة،
        // مخالفة صريحة لمبدأ Atomic Transaction). الآن: نحذف صف الفاتورة قبل
        // الرجوع، بنفس المنطق المستخدم عند تجاوز حد الائتمان/فشل الترحيل أدناه.
        _deleteInvoiceRowById(sheet, id);
        lock.releaseLock();
        return {
          success: false,
          message: "فشل حفظ فاتورة البيع — تعذّر تحديث المخزون: " + stockErr.message,
        };
      }
    }

    // [AUDIT-FIX INVSET-03] create_journal_on_sale_confirm — نفس المبدأ:
    // الافتراضي (true أو الإعداد غير موجود) = السلوك القديم (قيد إلزامي).
    // لو الإعداد صراحة false، الفاتورة تُحفظ بدون قيد محاسبي تلقائي (يُترك
    // للترحيل اليدوي لاحقًا)، وبالتبعية بدون قيد COGS المرتبط به (لأنه جزء
    // من نفس دالة القيد، ولا معنى لتسجيل تكلفة بضاعة مباعة بدون القيد
    // الرئيسي للفاتورة أصلًا).
    var _createJournalOnConfirm =
      typeof InvoiceSettingsEngine === "undefined" ||
      InvoiceSettingsEngine.get("create_journal_on_sale_confirm") !== false;

    if (_createJournalOnConfirm) {
      // قيد محاسبي تلقائي — إلزامي؛ فشله يُلغي الفاتورة وحركات المخزون
      try {
        _autoJournalSaleInvoice({
          id: id,
          party: invoiceData.party,
          // [BUG-007 FIX] القيد المحاسبي لازم يطابق المبلغ المحسوب فعليًا
          // وليس المُرسَل من المتصفح (نفس القيم المكتوبة في صف الفاتورة).
          net_total: Number(_computedTotalsSale.net_total || 0),
          vat_amount: Number(_computedTotalsSale.vat_amount || 0),
          discount_amount: Number(_computedTotalsSale.discount_amount || 0),
          payment_status: invoiceData.payment_status,
          lines_json: invoiceData.lines || [],
          warehouse: invoiceData.warehouse,
          date: invoiceData.date,
          callerUser: username,
          // [COST-CENTER-DIM] اختياري — لو الفاتورة مرتبطة بمركز تكلفة (فرع/قسم)
          // يُمرَّر لكل سطور القيد التلقائي الناتج عنها (راجع Code_43_CostCenters.js)
          cost_center_id: invoiceData.cost_center_id || "",
        });
      } catch (je) {
        _reverseInvoiceStockMovements(
          id,
          invoiceData,
          "OUT",
          username,
          sessionToken,
        );
        _deleteInvoiceRowById(sheet, id);
        lock.releaseLock();
        return { success: false, message: je.message };
      }
    }

    // [TRACK1-FIX-2026-08-12] الفاتورة + المخزون + القيد اتحفظوا فعلاً في
    // هذه النقطة (كل نقاط الفشل الحقيقية قبل كده بترجع مباشرة). لو
    // _addAuditLog أو _invalidateServerCacheInvoices رمى استثناء (مثلاً
    // شيت الـ AuditLog ممتلئ/محمي)، كان الكود القديم يسقط في catch
    // الخارجي للدالة ويرجّع success:false — رغم إن الفاتورة والمخزون
    // والقيد المحاسبي اتسجلوا بنجاح فعلي (بيانات "يتيمة" في نظرة العميل:
    // الفاتورة موجودة لكن الرد يقول فشل، فيعيد المحاولة ويحتمل يعمل فاتورة
    // مكررة). دلوقتي: فشل التدقيق/الكاش لا يُسقط نجاح العملية — يُسجَّل في
    // اللوج فقط ولا يوقف إرجاع النتيجة الناجحة.
    try {
      _addAuditLog(
        username,
        "ADD_SALE_INVOICE",
        "SaleInvoices",
        id,
        JSON.stringify(invoiceData),
      );
    } catch (auditErr) {
      Logger.log(
        "[TRACK1-FIX] فشل تسجيل Audit Log لفاتورة بيع محفوظة فعلاً (" +
          id + "): " + auditErr.message,
      );
    }
    try {
      _invalidateServerCacheInvoices(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    } catch (cacheErr) {
      Logger.log(
        "[TRACK1-FIX] فشل إبطال الكاش بعد حفظ فاتورة بيع (" +
          id + "): " + cacheErr.message,
      );
    }
    lock.releaseLock();

    var saved = {
      id: id,
      date: invoiceData.date,
      party: invoiceData.party,
      permit_id: invoiceData.permit_id,
      payment_status: invoiceData.payment_status,
      due_date: invoiceData.due_date,
      subtotal: Number(invoiceData.subtotal || 0),
      discount_amount: Number(invoiceData.discount_amount || 0),
      vat_percent: Number(invoiceData.vat_percent || 0),
      vat_amount: Number(invoiceData.vat_amount || 0),
      net_total: Number(invoiceData.net_total || 0),
      lines: invoiceData.lines || [],
      stock_movements: stockMovements,
      notes: invoiceData.notes || "",
      created_by: username,
      created_at: now,
      status: "confirmed",
    };
    // [AUDIT-FIX CUST-29] تفعيل فعلي لـ credit_limit_exceed_behavior=
    // "warn_on_finish" بدل ما يفضل توثيقي بس — بيتضاف كحقل إضافي في
    // الاستجابة، أي واجهة تقدر تعرضه كتنبيه للمستخدم بعد الحفظ.
    if (_creditLimitWarningForResponse) {
      saved.creditLimitWarning = _creditLimitWarningForResponse;
    }

    return {
      success: true,
      message: "تم حفظ فاتورة البيع",
      data: saved,
      creditLimitWarning: _creditLimitWarningForResponse || undefined,
    };
  } catch (e) {
    try {
      lock.releaseLock();
    } catch (le) {
      Logger.log("[silent-catch] " + le);
    }
    return { success: false, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// addPurchaseInvoice — إضافة فاتورة شراء جديدة
// ─────────────────────────────────────────────────────────────
function addPurchaseInvoice(invoiceData, sessionToken) {
  var username = _getUsernameFromToken(sessionToken) || "system";
  var permErr = _checkPermission(username, "addPurchaseInvoice", sessionToken);
  if (permErr) return permErr;

  // [TRACK2-FIX-2026-08-12] نفس عيب addSaleInvoice قبل إصلاحه في Track 1:
  // المفتاح كان بيتحرق هنا فوق قبل ٦ فحوصات validation (posting setup،
  // totals, notes, discount limit, blacklist, period lock) — أي رفض
  // مشروع كان يحجز client_request_id لمدة دقيقتين رغم عدم إنشاء أي
  // فاتورة، فيمنع retry شرعي بنفس المعرّف بعد تصحيح البيانات. نفس
  // الإصلاح: تأجيل الاستهلاك لآخر نقطة قبل الكتابة الفعلية.
  var _crIdPurchKey =
    invoiceData && invoiceData.client_request_id
      ? "pinv_" + String(invoiceData.client_request_id)
      : null;

  // [P1-GATE] نفس فحص فاتورة البيع — راجع تعليق verifyPostingSetupComplete
  var requiredPurchaseKeys = [
    "cash_account",
    "ap_account",
    "purchase_account",
    "inventory_account",
  ];
  if (Number(invoiceData && invoiceData.vat_amount) > 0) {
    requiredPurchaseKeys.push("vat_input_account");
  }
  // [AUDIT-FIX-2026-08-08 §RISK-3 — ملاحظة تصحيح] بعكس فاتورة البيع، خصم
  // الشراء لا يحتاج حساباً منفصلاً: راجعت _autoJournalPurchaseInvoice —
  // الخصم مطروح بالفعل ضمن net_total فيُقيَّد كجزء من تخفيض تكلفة المخزون
  // مباشرة (ممارسة محاسبية صحيحة: خصم المشتريات يخفّض تكلفة الأصل، وليس
  // بند دخل/مصروف منفصل مثل خصم المبيعات). لذلك لم أفرض هنا
  // purchase_discount_account رغم وجوده كمفتاح في POSTING_CONFIG_KEYS —
  // المفتاح موجود للاستخدام المستقبلي لكن غير مُستهلَك فعلياً في القيد
  // الحالي، وفرضه كان سيمنع فواتير شراء صحيحة بلا داعٍ.
  var purchaseSetup = verifyPostingSetupComplete(requiredPurchaseKeys);
  if (!purchaseSetup.complete) {
    return {
      success: false,
      message: _postingSetupErrorMessage(purchaseSetup.missing),
    };
  }

  // [BUG-007 FIX] نفس تحقق فاتورة البيع — رفض حفظ فاتورة الشراء لو
  // الإجماليات المُرسَلة من المتصفح لا تطابق الاحتساب الفعلي من البنود.
  var _totalsCheckPurch = _validateInvoiceTotalsOrReject(
    invoiceData,
    "فاتورة الشراء",
  );
  if (!_totalsCheckPurch.ok) return _totalsCheckPurch.error;
  var _computedTotalsPurch = _totalsCheckPurch.computed;

  // [FIX-AUDIT #2] تفعيل إعداد "الملاحظات إلزامية على الحركات"
  var _notesErrPurch = _checkRequireNotesOnTx(invoiceData && invoiceData.notes);
  if (_notesErrPurch) return _notesErrPurch;

  // [INV2-SETTINGS-2026-08-07] نفس فحص الحد الأقصى للخصم المطبّق في
  // addSaleInvoice — سياسة واحدة موحّدة لكل الفواتير (بيع/شراء).
  if (typeof InvoiceSettingsEngine !== "undefined") {
    var _discTypeP = invoiceData.discount_type || "percent";
    var _discValP = Number(invoiceData.discount_value || 0);
    // [AUDIT-FIX INVSET-05] راجع نفس الشرح في addSaleInvoice أعلاه.
    if (
      _discValP > 0 &&
      InvoiceSettingsEngine.get("allow_invoice_discount") === false
    ) {
      return {
        success: false,
        message: "الخصم على مستوى الفاتورة معطّل حاليًا من إعدادات الفواتير",
      };
    }
    var _maxDiscPctP = Number(InvoiceSettingsEngine.get("max_discount_percent") || 0);
    if (_discTypeP === "percent" && _maxDiscPctP > 0 && _discValP > _maxDiscPctP) {
      var _requireApprovalP = InvoiceSettingsEngine.get(
        "require_approval_over_max_discount",
      );
      var _canOverrideDiscountP =
        _checkPermission(username, "overrideDiscountLimit", sessionToken) ===
        null;
      if (_requireApprovalP && !_canOverrideDiscountP) {
        return {
          success: false,
          message:
            "نسبة الخصم (" +
            _discValP +
            "%) تتجاوز الحد الأقصى المسموح (" +
            _maxDiscPctP +
            "%) — يحتاج موافقة مستخدم لديه صلاحية تجاوز حد الخصم",
        };
      }
    }
  }

  // §BP-P5 — منع إنشاء فاتورة شراء من مورد على القائمة السوداء (نفس منطق
  // فحص العميل في addSaleInvoice)
  var _blSupplierId =
    invoiceData.party_id ||
    _resolvePartyIdByName(invoiceData.party, "supplier") ||
    "";
  if (_blSupplierId) {
    var _blSupplier = _getPartyById("supplier", _blSupplierId);
    if (_blSupplier && _blSupplier.is_blacklisted) {
      return {
        success: false,
        message:
          'لا يمكن إنشاء فاتورة شراء — المورد "' +
          (_blSupplier.name || "") +
          '" مُدرَج في القائمة السوداء',
      };
    }
  }

  // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية.
  var _invDateForPeriodP = invoiceData.date || new Date().toISOString().split("T")[0];
  var _periodErrPurch = _blockIfPeriodClosed(_invDateForPeriodP, "فاتورة الشراء");
  if (_periodErrPurch) return _periodErrPurch;

  // [TRACK2-FIX-2026-08-12] راجع تعليق [TRACK2-FIX-2026-08-12] فوق.
  if (_crIdPurchKey) {
    var _crIdPurch = _requireIdempotencyKey(_crIdPurchKey);
    if (!_crIdPurch.ok) return _crIdPurch.error;
  }

  try {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);

    var id = makeId("PINV");
    var now = new Date().toISOString();
    var linesJson = JSON.stringify(invoiceData.lines || []);

    // [INV2-SETTINGS-2026-08-07] نفس منطق توليد invoice_no في addSaleInvoice
    // بالظبط، لكن مقروء من نوع "purchase" (تسلسل منفصل لو numbering_
    // reset_per_type مفعّل — الفلترة هنا بالفعل بتقرا PurchaseInvoices
    // بس، فده متحقق تلقائيًا بغض النظر عن الإعداد).
    var invoiceNo = id;
    if (typeof InvoiceNumberingService !== "undefined") {
      try {
        var _isetForNoP = InvoiceSettingsEngine.getAll();
        var _existingPurchInvoicesForNo = readSheet(
          "PurchaseInvoices",
          PURCHASE_INVOICE_HEADERS,
          { trimStrings: true },
        );
        if (_isetForNoP.numbering_reset_yearly) {
          var _yrP = new Date().getFullYear();
          _existingPurchInvoicesForNo = _existingPurchInvoicesForNo.filter(
            function (r) {
              var d = new Date(r.date || r.created_at);
              return !isNaN(d.getTime()) && d.getFullYear() === _yrP;
            },
          );
        }
        invoiceNo = InvoiceNumberingService.next("purchase", function () {
          return _existingPurchInvoicesForNo.map(function (r) {
            return r.invoice_no;
          });
        });
      } catch (numErrP) {
        Logger.log("[INV2-SETTINGS] فشل توليد invoice_no للشراء: " + numErrP.message);
        invoiceNo = id;
      }
    }

    // [C7-FIX] حل party_id من اسم المورد إن لم يُرسل صراحة
    var resolvedSupplierPartyId =
      invoiceData.party_id ||
      _resolvePartyIdByName(invoiceData.party, "supplier") ||
      "";

    // [AUDIT-FIX-2026-08-08 §RISK-2] حارس منع التكرار — نفس منطق
    // addSaleInvoice أعلاه، على فواتير الشراء.
    try {
      var _dedupWindowMsP = 20000;
      var _dedupNowTsP = Date.now();
      var _recentPurchInvoices = readSheet(
        "PurchaseInvoices",
        PURCHASE_INVOICE_HEADERS,
        { trimStrings: true },
      );
      var _dupPurchInv = _recentPurchInvoices.find(function (r) {
        if (
          String(r.party_id || "") !== String(resolvedSupplierPartyId || "")
        )
          return false;
        if (
          Math.abs(
            Number(r.net_total || 0) -
              Number(_computedTotalsPurch.net_total || 0),
          ) > 0.01
        )
          return false;
        if (String(r.lines_json || "") !== linesJson) return false;
        var _createdTsP = new Date(r.created_at || 0).getTime();
        return (
          !isNaN(_createdTsP) &&
          _dedupNowTsP - _createdTsP >= 0 &&
          _dedupNowTsP - _createdTsP < _dedupWindowMsP
        );
      });
      if (_dupPurchInv) {
        lock.releaseLock();
        return {
          success: false,
          message:
            "يبدو أن هذه الفاتورة أُرسِلت للتو (خلال آخر 20 ثانية) بنفس المورد والبنود والإجمالي — الفاتورة رقم " +
            (_dupPurchInv.invoice_no || _dupPurchInv.id) +
            ". لو كانت فاتورة جديدة فعلاً، انتظر لحظة وأعد المحاولة",
        };
      }
    } catch (_dedupErrPurch) {
      Logger.log(
        "[RISK-2-DEDUP] فشل فحص تكرار فاتورة الشراء: " + _dedupErrPurch.message,
      );
    }

    var sheet = getSheet("PurchaseInvoices");

    // [ARCH-AUDIT-P3-9] نفس تحويل SaleInvoices — appendRow خام -> insert
    DataLayerEngine.insert(
      "PurchaseInvoices",
      {
        id: id,
        invoice_no: invoiceNo,
        date: invoiceData.date || now.split("T")[0],
        party: invoiceData.party || "",
        party_id: resolvedSupplierPartyId,
        permit_id: invoiceData.permit_id || "",
        payment_status: invoiceData.payment_status || "كاش",
        due_date: invoiceData.due_date || "",
        subtotal: Number(_computedTotalsPurch.subtotal || 0),
        discount_value: Number(invoiceData.discount_value || 0),
        discount_type: invoiceData.discount_type || "percent",
        discount_amount: Number(_computedTotalsPurch.discount_amount || 0),
        vat_percent: Number(invoiceData.vat_percent || 0),
        vat_amount: Number(_computedTotalsPurch.vat_amount || 0),
        net_total: Number(_computedTotalsPurch.net_total || 0),
        lines_json: linesJson,
        notes: invoiceData.notes || "",
        created_by: username,
        created_at: now,
        status: "confirmed",
        paid_amount: 0,
        remaining_amount: Number(_computedTotalsPurch.net_total || 0),
        po_id: invoiceData.po_id || "",
      },
      { headers: PURCHASE_INVOICE_HEADERS },
    );

    var stockMovements = [];
    try {
      stockMovements = _createInvoiceStockMovements(
        id,
        invoiceData,
        "IN",
        username,
        sessionToken,
      );
    } catch (stockErr) {
      // [ATOMIC-INVOICE-FIX] نفس تصحيح فاتورة البيع — حذف صف الفاتورة الذي
      // أُضيف بالفعل بدل تركه بلا حركة مخزون ولا قيد محاسبي.
      _deleteInvoiceRowById(sheet, id);
      lock.releaseLock();
      return {
        success: false,
        message: "فشل حفظ فاتورة الشراء — تعذّر تحديث المخزون: " + stockErr.message,
      };
    }

    // [P8-FIX] إنشاء طبقة تكلفة (StockLot) لكل بند — كانت _addPurchaseLots
    // معرّفة في الكود لكن لا تُستدعى من أي مكان إطلاقاً، فلم تكن أي فاتورة
    // شراء جديدة تُنشئ طبقة تكلفة على الإطلاق منذ بداية تشغيل النظام. النتيجة:
    // محرك FIFO/AVCO كان يعمل فقط على طبقات الرصيد الافتتاحي (إن وُجدت)، وبمجرد
    // استهلاكها بالكامل عبر المبيعات يرجع COGS تلقائياً لاستخدام cost_price
    // الثابت (الذي لا يُحدَّث تلقائياً أصلاً عند أي شراء) — أي أن "الإهلاك
    // الزمني" لطبقات التكلفة الافتتاحية كان يُسقط النظام بالكامل في تقييم
    // تكلفة ثابتة غير دقيقة بعد فترة قصيرة من الاستخدام الفعلي. كذلك بدون هذه
    // الطبقات، كانت دالة عكس فاتورة الشراء (`softDeletePurchaseInvoice`) تستدعي
    // `_reverseStockLot` على طبقة غير موجودة أصلاً (no-op صامت).
    var _purchaseInvoiceLotWarning = undefined;
    try {
      _addPurchaseLots(
        { id: id, warehouse: invoiceData.warehouse, date: invoiceData.date },
        invoiceData.lines || [],
      );
    } catch (lotErr) {
      Logger.log(
        "[P8-FIX] فشل إنشاء طبقة التكلفة لفاتورة الشراء " +
          id +
          ": " +
          lotErr.message,
      );
      // [AUDIT-FIX-COSTLOT-2026-08-08] كان بيتسجل في Logger فقط ويختفي —
      // فشل هنا لا يمنع حفظ الفاتورة (مقصود، أقل خطورة من فشل القيد نفسه)
      // لكنه بيأثر على دقة COGS المستقبلية (FIFO/AVCO) لهذا الصنف، فلازم
      // يبقى مرئي في AuditLog + تحذير للمستخدم، نفس نمط باقي الإصلاحات.
      try {
        AuditEngine.log("COST_LOT_CREATE_FAILED", {
          user: username,
          table: "PurchaseInvoices",
          record_id: id,
          details:
            " فشل إنشاء طبقة التكلفة (StockLot) لفاتورة الشراء " +
            id +
            ": " +
            lotErr.message +
            " — قد يؤثر على دقة تكلفة البضاعة المباعة (COGS) لهذا الصنف مستقبلاً، يحتاج مراجعة يدوية."});
      } catch (auditErr6) {
        Logger.log(
          "[CostLot] فشل تسجيل تنبيه AuditLog: " + auditErr6.message,
        );
      }
      _purchaseInvoiceLotWarning =
        "تم حفظ فاتورة الشراء، لكن طبقة تكلفة المخزون لم تُنشأ (" +
        lotErr.message +
        ") — قد يؤثر على دقة تكلفة البضاعة المباعة مستقبلاً، راجع سجل التدقيق";
    }

    // القيد المحاسبي جزء إلزامي من فاتورة الشراء. لا يجوز ترك مخزون أو
    // فاتورة مؤكدة بلا أثر في الأستاذ العام عند فشل الترحيل.
    try {
      _autoJournalPurchaseInvoice({
        id: id,
        party: invoiceData.party,
        // [TRACK2-FIX-2026-08-12] كان القيد بيتقفل على net_total/vat_amount
        // المُرسَلين من المتصفح مباشرة، بينما صف الفاتورة نفسه (DataLayerEngine
        // .insert فوق) بيتكتب بالقيم المحسوبة من السيرفر (_computedTotalsPurch)
        // — نفس فئة عيب BUG-007 اللي اتصلح في addSaleInvoice للقيد هناك، لكنه
        // فات هنا. الفرق بينهم كان محدود بهامش التسامح (0.02) في
        // _validateInvoiceTotalsOrReject، لكن يبقى القيد ممكن يختلف عن صف
        // الفاتورة بأي قيمة داخل الهامش ده — يكسر مبدأ "الفاتورة والقيد لازم
        // يتطابقوا تمامًا" ويصعّب المطابقة الآلية لاحقًا (Track 4). الحل: نفس
        // مصدر القيم المستخدم في كتابة صف الفاتورة بالظبط.
        net_total: Number(_computedTotalsPurch.net_total || 0),
        vat_amount: Number(_computedTotalsPurch.vat_amount || 0),
        payment_status: invoiceData.payment_status, // [A3-FIX] لتمييز فاتورة كاش/آجل
        date: invoiceData.date,
        callerUser: username,
        // [COST-CENTER-DIM] اختياري — راجع نفس الحقل في _autoJournalSaleInvoice
        cost_center_id: invoiceData.cost_center_id || "",
      });
    } catch (je) {
      Logger.log("Purchase Invoice Journal Error: " + je.message);
      _reverseInvoiceStockMovements(
        id,
        invoiceData,
        "IN",
        username,
        sessionToken,
      );
      (invoiceData.lines || []).forEach(function (line) {
        var qty = Number(line.qty || line.quantity || 0);
        // [INV-FIX-2026-08-12 §LOT-XITEM] تمرير item_id/color صراحة بدل
        // الاعتماد على source_id وحده — راجع تعليق _reverseStockLot.
        var _lineItemId = _resolveInvoiceLineItemId(line);
        if (qty > 0)
          _reverseStockLot(id, qty, _lineItemId, line.color || "");
      });
      _deleteInvoiceRowById(sheet, id);
      lock.releaseLock();
      return {
        success: false,
        message:
          "فشل الترحيل المحاسبي لفاتورة الشراء وتم التراجع عن الفاتورة وحركة المخزون: " +
          je.message,
      };
    }

    // [TRACK2-FIX-2026-08-12] نفس إصلاح Track 1: الفاتورة + المخزون +
    // طبقة التكلفة + القيد اتحفظوا فعلاً في هذه النقطة. فشل أي خطوة
    // best-effort تالية (audit log / ربط أمر الشراء / إبطال الكاش) ما
    // ينفعش يقلب نتيجة عملية ناجحة فعليًا إلى success:false.
    try {
      _addAuditLog(
        username,
        "ADD_PURCHASE_INVOICE",
        "PurchaseInvoices",
        id,
        JSON.stringify(invoiceData),
      );
    } catch (auditErrP) {
      Logger.log(
        "[TRACK2-FIX] فشل تسجيل Audit Log لفاتورة شراء محفوظة فعلاً (" +
          id + "): " + auditErrP.message,
      );
    }

    // [PO-INVOICE-LINK] لو الفاتورة اتعملت من أمر شراء (po_id)، نحدّث حالة
    // فوترة الأمر نفسه. Best-effort — أي فشل هنا ميرجعش الفاتورة اللي
    // اتحفظت وترحّلت محاسبياً بالفعل بنجاح. (كان already isolated)
    if (invoiceData.po_id) {
      try {
        _applyInvoiceToPurchaseOrder(
          invoiceData.po_id,
          id,
          Number(_computedTotalsPurch.net_total || 0),
        );
      } catch (poLinkErr) {
        Logger.log(
          "[PO-INVOICE-LINK] فشل تحديث أمر الشراء " +
            invoiceData.po_id +
            ": " +
            poLinkErr.message,
        );
      }
    }

    try {
      _invalidateServerCacheInvoices(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    } catch (cacheErrP) {
      Logger.log(
        "[TRACK2-FIX] فشل إبطال الكاش بعد حفظ فاتورة شراء (" +
          id + "): " + cacheErrP.message,
      );
    }
    lock.releaseLock();

    var saved = {
      id: id,
      date: invoiceData.date,
      party: invoiceData.party,
      permit_id: invoiceData.permit_id,
      payment_status: invoiceData.payment_status,
      due_date: invoiceData.due_date,
      subtotal: Number(invoiceData.subtotal || 0),
      discount_amount: Number(invoiceData.discount_amount || 0),
      vat_percent: Number(invoiceData.vat_percent || 0),
      vat_amount: Number(invoiceData.vat_amount || 0),
      net_total: Number(invoiceData.net_total || 0),
      lines: invoiceData.lines || [],
      stock_movements: stockMovements,
      notes: invoiceData.notes || "",
      created_by: username,
      created_at: now,
      status: "confirmed",
    };

    return {
      success: true,
      message: "تم حفظ فاتورة الشراء",
      journal_warning: _purchaseInvoiceLotWarning,
      data: saved,
    };
  } catch (e) {
    try {
      lock.releaseLock();
    } catch (le) {
      Logger.log("[silent-catch] " + le);
    }
    return { success: false, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// deleteSaleInvoice — حذف فاتورة بيع
// [UNIFY-INVOICE-DELETE] بقت غلاف رفيع بينادي DeleteEngine.delete("saleInvoice", ...)
// بدل تكرار منطق عكس المخزون/التكلفة/القيد (اللي كان مكرر هنا وفي
// _coreSoftDeleteSaleInvoice في Code_05b_InvoiceSoftDelete.js). المنطق
// التفصيلي الحرج بقى مصدر واحد فقط (_coreSoftDeleteSaleInvoice)، وأصبحت
// الفاتورة تُحذف حذفًا ناعمًا (deleted_at) بدل حذف الصف نهائيًا — بما
// يطابق سلوك بقية النظام ويسمح بالاسترجاع عبر DeleteEngine.restore.
// اسم الدالة والتوقيع (id, sessionToken) ثابتان لعدم كسر أي استدعاء قديم
// من الواجهة أو DOPOST Allowlist.
// ─────────────────────────────────────────────────────────────
function deleteSaleInvoice(id, sessionToken, reason) {
  var username = _getUsernameFromToken(sessionToken) || "system";
  // [INV2-SETTINGS-2026-08-07] إعداد "السماح بحذف الفاتورة" — منع مركزي
  // قبل أي منطق عكس مخزون/قيود داخل DeleteEngine. لو InvoiceSettingsEngine
  // مش متاح لأي سبب، السلوك القديم (السماح دايمًا) يفضل زي ما هو.
  if (
    typeof InvoiceSettingsEngine !== "undefined" &&
    !InvoiceSettingsEngine.get("allow_delete")
  ) {
    return {
      success: false,
      message: "حذف الفواتير معطّل حاليًا من إعدادات الفواتير العامة",
    };
  }
  // [AUDIT-FIX INVSET-01] لا يوجد في النظام حاليًا مسار "إلغاء" منفصل عن
  // الحذف — عملية إلغاء الفاتورة تتم فعليًا عبر نفس مسار الحذف الناعم
  // (عكس المخزون + عكس القيد المحاسبي). لذلك تم ربط allow_cancel و
  // require_cancel_reason بهذه العملية نفسها، بدل تركهما بلا أي تأثير
  // كما كانا (Dead Setting): كلاهما يُفرضان هنا في الـ Backend، وليس فقط
  // كنافذة تأكيد في الواجهة — أي API Client مباشر سيُمنع أيضًا.
  if (
    typeof InvoiceSettingsEngine !== "undefined" &&
    !InvoiceSettingsEngine.get("allow_cancel")
  ) {
    return {
      success: false,
      message: "إلغاء/حذف الفواتير معطّل حاليًا من إعدادات الفواتير العامة",
    };
  }
  if (
    typeof InvoiceSettingsEngine !== "undefined" &&
    InvoiceSettingsEngine.get("require_cancel_reason") &&
    !String(reason || "").trim()
  ) {
    return {
      success: false,
      message: "سبب الإلغاء/الحذف إلزامي حسب إعدادات الفواتير — الرجاء إدخال السبب",
    };
  }
  var result = DeleteEngine.delete("saleInvoice", id, username, sessionToken);
  if (result && result.success && String(reason || "").trim()) {
    try {
      _addAuditLog(username, "cancel_reason", "saleInvoice", String(id), null, {
        reason: String(reason).trim(),
      });
    } catch (e) {
      // لا نفشل عملية الحذف الناجحة بسبب فشل تسجيل السبب في الـ Audit
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// deletePurchaseInvoice — حذف فاتورة شراء
// [UNIFY-INVOICE-DELETE] نفس مبدأ deleteSaleInvoice أعلاه — تفويض كامل
// لـ DeleteEngine.delete("purchaseInvoice", ...) بدل تكرار منطق عكس
// المخزون/التكلفة/القيد المحاسبي محليًا.
// ─────────────────────────────────────────────────────────────
function deletePurchaseInvoice(id, sessionToken, reason) {
  var username = _getUsernameFromToken(sessionToken) || "system";
  // [INV2-SETTINGS-2026-08-07] نفس فحص deleteSaleInvoice — سياسة واحدة
  // موحّدة لكل الفواتير (بيع/شراء).
  if (
    typeof InvoiceSettingsEngine !== "undefined" &&
    !InvoiceSettingsEngine.get("allow_delete")
  ) {
    return {
      success: false,
      message: "حذف الفواتير معطّل حاليًا من إعدادات الفواتير العامة",
    };
  }
  // [AUDIT-FIX INVSET-01] نفس منطق deleteSaleInvoice أعلاه — راجع الشرح هناك.
  if (
    typeof InvoiceSettingsEngine !== "undefined" &&
    !InvoiceSettingsEngine.get("allow_cancel")
  ) {
    return {
      success: false,
      message: "إلغاء/حذف الفواتير معطّل حاليًا من إعدادات الفواتير العامة",
    };
  }
  if (
    typeof InvoiceSettingsEngine !== "undefined" &&
    InvoiceSettingsEngine.get("require_cancel_reason") &&
    !String(reason || "").trim()
  ) {
    return {
      success: false,
      message: "سبب الإلغاء/الحذف إلزامي حسب إعدادات الفواتير — الرجاء إدخال السبب",
    };
  }
  var result = DeleteEngine.delete("purchaseInvoice", id, username, sessionToken);
  if (result && result.success && String(reason || "").trim()) {
    try {
      _addAuditLog(username, "cancel_reason", "purchaseInvoice", String(id), null, {
        reason: String(reason).trim(),
      });
    } catch (e) {}
  }
  return result;
}


// ─────────────────────────────────────────────────────────────
// _cancelJournalEntryByReference — helper داخلي لإلغاء قيد بـ reference
// يُستخدم عند حذف الفواتير والمرتجعات لإلغاء القيود المرتبطة
// ─────────────────────────────────────────────────────────────
function _cancelJournalEntryByReference(referenceId, username) {
  try {
    var entries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var matched = entries.filter(function (e) {
      return (
        String(e.reference || "").trim() === String(referenceId).trim() &&
        e.status !== "CANCELLED" &&
        e.status !== "REVERSED" &&
        // [AUDIT-FIX-2026-08-09 §RISK-CROSS-REVERSAL] لو القيد اتعمله
        // Reverse بالفعل يدويًا عبر reverseJournalEntry، الحالة (status)
        // بتفضل POSTED (الدالة دي بتحط reversed_by بس، ما بتغيّرش status) —
        // فمن غير الفحص ده كان _cancelJournalEntryByReference بيلاقي نفس
        // القيد "لسه POSTED" ويعمله عكس تاني، فيرجع الأثر على الأرصدة
        // مرتين من مسارين مختلفين (إلغاء يدوي للقيد + إلغاء السند المرتبط
        // به). نفس فئة الخطر اللي اتصلح في cancelJournalEntry، لكن هنا عبر
        // مسار مختلف تمامًا (حذف/إلغاء المستند المصدر بدل القيد نفسه).
        !e.reversed_by
      );
    });
    if (!matched.length) return;

    var sheet = getSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
    );
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var statusCol = headers.indexOf("status");

    matched.forEach(function (entry) {
      var idx = entries.findIndex(function (e) {
        return e.id === entry.id;
      });
      if (idx === -1) return;

      // [M-002 FIX] إنشاء قيد عكسي حقيقي بدلاً من تغيير الحالة فقط
      if (entry.status === "POSTED") {
        var lines = readSheet(
          "JournalEntryLines",
          ACCOUNTING_HR_HEADERS.JournalEntryLines,
        );
        var entryLines = lines.filter(function (l) {
          return l.entry_id === entry.id;
        });

        if (entryLines.length > 0) {
          // إنشاء القيد العكسي — يعكس المدين والدائن
          var reverseResult = _addJournalEntryInternal({
            callerUser: username || "SYSTEM",
            date: new Date().toISOString().split("T")[0],
            reference: "REV-" + entry.reference,
            source_type: "REVERSAL",
            description:
              "قيد عكسي لـ: " + (entry.description || entry.reference),
            lines: entryLines.map(function (line) {
              return {
                account_id: line.account_id,
                debit: Number(line.credit || 0), // عكس المدين والدائن
                credit: Number(line.debit || 0),
                notes: "عكس: " + (line.notes || ""),
                party_type: line.party_type || "NONE",
                party_id: line.party_id || "",
              };
            }),
          });

          if (!reverseResult || !reverseResult.success) {
            Logger.log(
              "[M-002] فشل إنشاء القيد العكسي: " +
                (reverseResult ? reverseResult.message : "unknown"),
            );
            // fallback: تغيير الحالة مع عكس الأرصدة يدوياً (الأسلوب القديم)
            _reverseBalancesManually(entry, entries, idx);
          }
        }
      }

      // تغيير حالة القيد الأصلي إلى REVERSED
      if (statusCol !== -1) {
        sheet.getRange(idx + 2, statusCol + 1).setValue("REVERSED");
      }

      AuditEngine.log("REVERSE_JOURNAL", {
        user: username || "SYSTEM",
        table: "JournalEntries",
        record_id: entry.id,
        details: "قيد عكسي عند حذف المستند: " + referenceId});
    });
  } catch (e) {
    Logger.log("[_cancelJournalEntryByReference] خطأ: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// [DELETE-ENGINE-UNIFY] _deleteRowById اتشالت من هنا — كانت دالة عامة
// (hard delete + audit) غير مستخدمة في أي مكان بالمشروع كله (تأكيد: صفر
// نداء خارج تعريفها)، وبتكرر بالظبط نفس مسؤولية DeleteEngine.delete()
// (Code_44) لكن بدون فحص الاعتماديات (dependencies) ولا سياسة
// soft-delete الموحّدة. إبقاؤها كانت بتمثل "طريقة حذف بديلة جاهزة" ممكن
// أي كود مستقبلي يستخدمها بالغلط ويتجاوز المحرك الموحّد بالكامل. أي حذف
// جديد لازم يمر عبر DeleteEngine.delete(entityType, id, callerUser,
// sessionToken, opts) — راجع Code_44_DeleteEngine.js.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// _autoJournalSaleInvoice — قيد تلقائي من فاتورة البيع
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// [ITEM-POSTING-WIRE-2026-08-07] _pushRevenueLinesForInvoice — يوزّع مبلغ
// الإيراد على سطر واحد أو أكتر حسب حساب المبيعات الخاص بكل صنف
// (sales_account_id) بدل ما يترحل دايمًا على حساب الإيرادات العام. لو صنف
// معين مالوش حساب مخصص، بيرجع لحساب الترحيل الافتراضي العام تلقائيًا
// (سلسلة الوراثة: الصنف ← الافتراضي العام). أي فشل في القراءة/الحساب
// (بيانات بند ناقصة، JSON تالف...) بيرجع فورًا لسلوك القديم (سطر واحد
// إجمالي على الحساب العام) لضمان عدم كسر ترحيل الفاتورة أبدًا.
// ─────────────────────────────────────────────────────────────
function _pushRevenueLinesForInvoice(lines, inv, accounts, fallbackRevenueAccount, totalToDistribute, noteLabel, partyId) {
  function pushFallbackSingleLine() {
    if (fallbackRevenueAccount && totalToDistribute > 0) {
      lines.push({
        account_id: fallbackRevenueAccount.id,
        debit: 0,
        credit: totalToDistribute,
        notes: noteLabel,
        party_type: "customer",
        party_id: partyId,
      });
    }
  }
  if (!totalToDistribute || totalToDistribute <= 0) return;
  try {
    var invLines = inv.lines_json;
    if (typeof invLines === "string") {
      try {
        invLines = JSON.parse(invLines);
      } catch (e) {
        invLines = [];
      }
    }
    if (!Array.isArray(invLines) || !invLines.length) {
      pushFallbackSingleLine();
      return;
    }

    var itemsData = readSheet("Items");
    var accountsById = _buildAccountsByIdMap(accounts);
    var lineShares = invLines
      .map(function (l) {
        var qty = Number(l.qty || l.quantity || 0);
        var price = Number(l.price || l.unit_price || 0);
        var amt = qty * price;
        if (!amt) amt = Number(l.total || l.line_total || 0);
        return { item_id: l.item_id || l.id || "", amount: amt };
      })
      .filter(function (l) {
        return l.amount > 0;
      });
    var grossSum = lineShares.reduce(function (s, l) {
      return s + l.amount;
    }, 0);
    if (!grossSum) {
      pushFallbackSingleLine();
      return;
    }

    // تجميع كل بند على حساب المبيعات المحلول له (الصنف أو الافتراضي العام)
    var order = [];
    var groups = {}; // accountId -> amount
    lineShares.forEach(function (l) {
      var itemRec = itemsData.find(function (it) {
        return it.id === l.item_id || it.code === l.item_id;
      });
      var acc = resolveItemLevelAccount(
        itemRec,
        "sales_account_id",
        accountsById,
        "REVENUE",
        fallbackRevenueAccount,
      );
      if (!acc) return;
      if (!groups.hasOwnProperty(acc.id)) {
        groups[acc.id] = 0;
        order.push(acc.id);
      }
      groups[acc.id] += totalToDistribute * (l.amount / grossSum);
    });

    if (!order.length) {
      pushFallbackSingleLine();
      return;
    }

    // [ROUNDING-SAFE] تقريب كل مجموعة لأقرب قرش، وتوزيع أي فرق تقريب على
    // آخر مجموعة، عشان مجموع الأسطر يساوي totalToDistribute تمامًا ولا
    // يكسر توازن القيد (هامش تسامح _validateJournalAccountLines = 0.001)
    var runningTotal = 0;
    order.forEach(function (accId, idx) {
      var amt;
      if (idx === order.length - 1) {
        amt = Math.round((totalToDistribute - runningTotal) * 100) / 100;
      } else {
        amt = Math.round(groups[accId] * 100) / 100;
        runningTotal += amt;
      }
      if (amt > 0.0001) {
        lines.push({
          account_id: accId,
          debit: 0,
          credit: amt,
          notes: noteLabel,
          party_type: "customer",
          party_id: partyId,
        });
      }
    });
  } catch (e) {
    Logger.log(
      "[ITEM-POSTING-WIRE] فشل توزيع الإيراد حسب حساب الصنف، رجوع لسطر عام: " +
        e.message,
    );
    lines.length && null; // no-op, keep lint quiet
    pushFallbackSingleLine();
  }
}

function _autoJournalSaleInvoice(inv) {
  if (!inv || !inv.net_total || inv.net_total <= 0)
    throw new Error("فاتورة البيع لا تحتوي على صافي صالح للترحيل");

  var accounts = readSheet(
    "ChartOfAccounts",
    ACCOUNTING_HR_HEADERS.ChartOfAccounts,
  );

  // [ACCOUNT-MAP] حساب الذمم المدينة: Entity Override (العميل) ← Global Default
  // نحلّه هنا مباشرة عبر resolvePostingAccount بدل حل الحساب العام أولاً ثم
  // البحث عن override للعميل لاحقاً في مكان منفصل من الكود.
  var isCreditInvoice = String(inv.payment_status || "").trim() === "آجل";
  var resolvedPartyId = _resolvePartyIdByName(inv.party, "customer");
  var customerRecForAr = null;
  if (isCreditInvoice && resolvedPartyId) {
    var customersForAr = readSheet("Customers", CUSTOMER_HEADERS);
    customerRecForAr = customersForAr.find(function (c) {
      return c.id === resolvedPartyId;
    });
  }
  var arResolvedInv = resolvePostingAccount({
    accounts: accounts,
    key: "ar_account",
    type: "ASSET",
    hints: ["ذمم مدينة", "عملاء", "accounts receivable", "مدينين"],
    entityAccountId: customerRecForAr && customerRecForAr.account_id,
  });
  var arAccount = arResolvedInv.account;
  var cashAccount = _getDefaultAccount("cash_account", accounts, "ASSET", [
    "الصندوق",
    "خزينة رئيسية",
    "cash",
    "صندوق",
  ]);
  var revenueAccount = _getDefaultAccount(
    "revenue_account",
    accounts,
    "REVENUE",
    ["إيرادات المبيعات", "مبيعات", "sales revenue", "إيرادات"],
  );
  var vatAccount = _getDefaultAccount(
    "vat_output_account",
    accounts,
    "LIABILITY",
    ["ضريبة القيمة المضافة", "ضريبة مبيعات", "vat", "VAT"],
  );

  // [H-002 FIX] حساب خصم الفاتورة
  var discountAccount = _getDefaultAccount(
    "sales_discount_account",
    accounts,
    "EXPENSE",
    ["خصم مسموح به", "خصم ممنوح", "خصم مبيعات", "sales discount"],
  );

  var lines = [];
  var totalAmount = Number(inv.net_total || 0);
  var vatAmount = Number(inv.vat_amount || 0);
  var discountAmount = Number(inv.discount_amount || 0);
  var revenueAmount = totalAmount - vatAmount; // الإيراد الصافي بعد الخصم + قبل الضريبة

  var isCredit = isCreditInvoice;

  var debitAccount = isCredit
    ? arAccount || cashAccount
    : cashAccount || arAccount;
  if (!debitAccount)
    throw new Error("لا يوجد حساب صندوق أو ذمم مدينة صالح لترحيل فاتورة البيع");

  // ─── سطر المدين: الصندوق أو الذمم المدينة (بالمبلغ الكامل شامل الضريبة) ───
  lines.push({
    account_id: debitAccount.id,
    debit: totalAmount,
    credit: 0,
    notes: inv.party ? "فاتورة بيع — " + inv.party : "فاتورة بيع",
    party_type: "customer",
    party_id: resolvedPartyId,
  });

  // ─── [DISCOUNT-FIX] سطر الخصم + الإيراد ───
  // الإيراد الإجمالي قبل الخصم = revenueAmount + discountAmount
  var grossRevenue = revenueAmount + discountAmount;

  if (discountAmount > 0 && discountAccount) {
    // حساب خصم مخصص موجود — نُسجِّل الخصم منفصلاً والإيراد إجمالياً
    lines.push({
      account_id: discountAccount.id,
      debit: discountAmount,
      credit: 0,
      notes: "خصم ممنوح للعميل",
    });
    _pushRevenueLinesForInvoice(lines, inv, accounts, revenueAccount, grossRevenue, "إيرادات المبيعات (قبل الخصم)", resolvedPartyId);
  } else {
    // [DISCOUNT-FIX] لا يوجد حساب خصم — نُسجِّل الإيراد بالمبلغ الصافي
    // لضمان توازن القيد بدل ما الخصم يتسقط بصمت ويكسر ميزان المراجعة
    if (discountAmount > 0) {
      Logger.log(
        "[DISCOUNT-FIX] فاتورة " +
          (inv.id || "") +
          " — خصم " +
          discountAmount +
          " مُدمج في الإيراد الصافي (لا يوجد sales_discount_account)." +
          " أضف حساب خصم مسموح به وارتبطه بـ sales_discount_account لتسجيله منفصلاً.",
      );
    }
    var revenueNote =
      discountAmount > 0
        ? "إيرادات المبيعات (صافي بعد خصم " + discountAmount + ")"
        : "إيرادات المبيعات";
    _pushRevenueLinesForInvoice(lines, inv, accounts, revenueAccount, revenueAmount, revenueNote, resolvedPartyId);
  }

  // ─── سطر الضريبة ───
  if (vatAccount && vatAmount > 0) {
    lines.push({
      account_id: vatAccount.id,
      debit: 0,
      credit: vatAmount,
      notes: "ضريبة القيمة المضافة — مبيعات",
    });
  }

  if (lines.length < 2)
    throw new Error(
      "تعذر تكوين قيد مكتمل لفاتورة البيع؛ راجع إعدادات الإيرادات والضرائب",
    );

  // [COST-CENTER-DIM] اختياري — لو الفاتورة مرتبطة بمركز تكلفة
  _applyCostCenterToLines(lines, inv.cost_center_id);

  var result = _addJournalEntryInternal({
    callerUser: inv.callerUser || "SYSTEM",
    date: inv.date || new Date().toISOString().split("T")[0],
    reference: inv.id,
    description: "فاتورة بيع — " + (inv.party || ""),
    source_type: "SALE_INVOICE",
    lines: lines,
  });
  if (!result || !result.success) {
    throw new Error(
      "فشل قيد فاتورة البيع: " + (result ? result.message : "unknown"),
    );
  }

  _autoJournalCOGS(inv);
}

// _autoJournalCOGS — قيد تكلفة البضاعة المباعة من بنود الفاتورة
// [COGS-FIX] يستخدم _consumeStockLots (FIFO/AVCO) بدلاً من cost_price الثابت
// لضمان أن التكلفة المُسجَّلة تعكس الطريقة المحاسبية الفعلية للمخزون
function _autoJournalCOGS(inv) {
  try {
    if (!inv || !inv.lines_json) return;

    // lines_json قد تصل كمصفوفة فعلية أو كنص JSON
    var lines = inv.lines_json;
    if (typeof lines === "string") {
      try {
        lines = JSON.parse(lines);
      } catch (e) {
        lines = [];
      }
    }
    if (!Array.isArray(lines) || !lines.length) return;

    var warehouse = inv.warehouse || "الرئيسي";
    var totalCost = 0;
    // [ITEM-POSTING-WIRE-2026-08-07] تكلفة كل صنف مباع على حدة (بمفتاح
    // item_id الخاص ببند الفاتورة نفسه — البضاعة داخل bundle بتترحّل تحت
    // حساب الـ bundle الأب نفسه، مش حسابات مكوناته) — تُستخدم لاحقًا لتوزيع
    // قيد COGS على حساب المخزون/التكلفة الخاص بكل صنف بدل حساب عام واحد.
    var itemCostMap = {}; // item_id -> accumulated cost
    // [AUDIT-FIX-2026-08-09 §RISK-7-RETURN-COST-BASIS] كمية مصاحبة لكل
    // itemCostMap عشان نقدر نحسب متوسط تكلفة الوحدة الفعلية ونسجلها في
    // InvoiceCOGSBreakdown لاستخدامها لاحقًا عند المرتجع.
    var itemQtyMap = {};
    var missingLots = []; // أصناف مش عندها طبقات تكلفة إطلاقاً
    // [FIX-AUDIT-2026] أصناف نفدت طبقات تكلفتها جزئياً أثناء البيع — كانت
    // هذه الحالة تُسقِط تكلفة الكمية الناقصة بصمت (راجع تقرير المراجعة،
    // المرحلة 4 والمرحلة 5 — الخطأ الجوهري #2: COGS يُحتسَب أقل من الحقيقة)
    var partialShortfalls = [];
    // [JOURNAL-SYNC-2026-08-12 §COGS-SILENT-FAIL] نجمع كل طبقة استُهلكت
    // فعليًا في هذه الدعوة (عبر _consumeStockLots) — لو فشل قيد COGS بعد
    // كده (حسابات ناقصة أو استثناء)، لازم نعكس بالضبط نفس الطبقات دي قبل
    // الرجوع، وإلا يفضل المخزون (StockLots) مخصوم فعليًا بدون أي قيد
    // محاسبي مقابل — عدم تطابق بين طبقة المخزون وطبقة المحاسبة (Rule 5).
    var _lotsConsumedThisCall = [];

    // [COGS-FIX] استهلاك طبقات التكلفة لكل بند بالـ FIFO/AVCO الفعلي
    var itemsForCogs = readSheet("Items");
    function _findItemRecForCogs(itemId) {
      return itemsForCogs.find(function (it) {
        return it.id === itemId || it.code === itemId;
      });
    }
    // [CONSIGNMENT-COGS-SKIP-2026-08-05] بضاعة الأمانة (consignment) مش
    // مملوكة للشركة، فمفروض ما يترحلش لها قيد تكلفة بضاعة مباعة ولا إخراج
    // مخزون بالقيمة — ده بالظبط اللي كان محذّر منه في توثيق محرك قواعد نوع
    // الصنف (قسم "منطق محاسبي مخصص لبضاعة أمانة"، أولوية ثانية). أي بند تاني
    // بيفضل يترحل عادي كالسابق.
    lines.forEach(function (line) {
      var qty = Number(line.qty || line.quantity || 0);
      var itemId = line.item_id || line.id || "";
      if (!itemId || qty <= 0) return;

      var itemRecForCogs = _findItemRecForCogs(itemId);
      if (itemRecForCogs && itemRecForCogs.item_type === "consignment") {
        return; // لا COGS ولا إخراج مخزون بالقيمة لبضاعة الأمانة
      }

      // [BUNDLE-EXPLOSION-2026-08-05] المجموعة (bundle) نفسها مالهاش طبقات
      // تكلفة مستقلة (مش متتبَّعة في المخزون) — تكلفتها = مجموع تكلفة مكوناتها
      // مضروبة في كمية المجموعة المباعة.
      if (itemRecForCogs && itemRecForCogs.item_type === "bundle") {
        var bundleComps = [];
        try {
          bundleComps = JSON.parse(itemRecForCogs.bundle_components_json || "[]") || [];
        } catch (e) {
          bundleComps = [];
        }
        bundleComps.forEach(function (comp) {
          var compQty = Number(comp.qty || 0) * qty;
          if (!comp.item_id || compQty <= 0) return;
          var compRec = _findItemRecForCogs(comp.item_id);
          if (compRec && compRec.item_type === "consignment") return;
          var compConsumed = _consumeStockLots({
            item_id: comp.item_id,
            color: "",
            warehouse: warehouse,
            qty_needed: compQty,
          });
          totalCost += compConsumed.total_cost;
          if (compConsumed.consumed && compConsumed.consumed.length) {
            _lotsConsumedThisCall = _lotsConsumedThisCall.concat(compConsumed.consumed);
          }
          // تُنسب تكلفة المكوّنات لحساب الـ bundle الأب نفسه، مش لحسابات
          // المكوّنات، لأن العميل اشترى الـ bundle كصنف واحد.
          itemCostMap[itemId] = (itemCostMap[itemId] || 0) + compConsumed.total_cost;
        });
        itemQtyMap[itemId] = (itemQtyMap[itemId] || 0) + qty;
        return;
      }

      var consumed = _consumeStockLots({
        item_id: itemId,
        color: line.color || "",
        warehouse: warehouse,
        qty_needed: qty,
      });

      totalCost += consumed.total_cost;
      if (consumed.consumed && consumed.consumed.length) {
        _lotsConsumedThisCall = _lotsConsumedThisCall.concat(consumed.consumed);
      }
      itemCostMap[itemId] = (itemCostMap[itemId] || 0) + consumed.total_cost;
      itemQtyMap[itemId] = (itemQtyMap[itemId] || 0) + qty;

      // [FIX-AUDIT-2026] لو الطبقات المتاحة غطّت الكمية بالكامل، لا شيء إضافي.
      // لو نفدت الطبقات جزئياً (consumed.qty_missing > 0) — سواء كان
      // consumed.total_cost صفراً (مفيش طبقات إطلاقاً) أو أكبر من صفر (نفاد
      // جزئي أثناء البيع) — لازم نغطي الكمية الناقصة بـ cost_price fallback
      // بدل تجاهلها، حتى لا يُحتسَب COGS أقل من الحقيقة.
      var qtyMissing = Number(consumed.qty_missing || 0);
      if (qtyMissing > 0.0001) {
        var itemsData = readSheet("Items");
        var itemRec = itemsData.find(function (it) {
          return it.id === itemId || it.code === itemId;
        });
        var fallbackCost = Number(
          (itemRec && itemRec.cost_price) || line.cost_price || 0,
        );
        var fallbackLineCost = qtyMissing * fallbackCost;
        if (fallbackCost > 0) {
          totalCost += fallbackLineCost;
          itemCostMap[itemId] = (itemCostMap[itemId] || 0) + fallbackLineCost;
        }
        if (consumed.total_cost > 0) {
          // نفاد جزئي: جزء من الكمية له تكلفة فعلية من الطبقات، والباقي fallback
          partialShortfalls.push({
            item_id: itemId,
            qty_from_lots: qty - qtyMissing,
            qty_missing: qtyMissing,
            fallback_cost_used: fallbackLineCost,
          });
        } else {
          // نفاد كامل: لا توجد طبقات إطلاقاً لهذا الصنف
          missingLots.push(itemId);
        }
      }
    });

    if (totalCost <= 0) {
      Logger.log(
        "[COGS-FIX] " +
          inv.id +
          " — التكلفة = 0 (لا طبقات ولا cost_price) — تم تجاهل القيد",
      );
      return;
    }

    // [AUDIT-FIX-2026-08-09 §RISK-7-RETURN-COST-BASIS] تسجيل تكلفة الوحدة
    // الفعلية لكل صنف في هذه الفاتورة، عشان مرتجع البيع لاحقًا يعكس COGS
    // بنفس التكلفة الحقيقية وقت البيع مش بسعر اليوم. فشل الكتابة هنا لا
    // يوقف قيد COGS نفسه (best-effort) — أسوأ ما يحصل هو رجوع مرتجع هذه
    // الفاتورة تحديدًا لسلوك fallback القديم (سعر اليوم).
    try {
      var _cogsBreakdownSheet = getSheet(
        "InvoiceCOGSBreakdown",
        ACCOUNTING_HR_HEADERS.InvoiceCOGSBreakdown,
      );
      var _cogsBreakdownRows = [];
      Object.keys(itemCostMap).forEach(function (itemId) {
        var _qty = Number(itemQtyMap[itemId] || 0);
        var _cost = Number(itemCostMap[itemId] || 0);
        if (_qty <= 0 || _cost <= 0) return;
        _cogsBreakdownRows.push([
          Utilities.getUuid ? Utilities.getUuid() : "cb_" + Date.now() + "_" + itemId,
          inv.id,
          itemId,
          _qty,
          Math.round((_cost / _qty) * 100) / 100,
          _cost,
          inv.date || new Date().toISOString().split("T")[0],
        ]);
      });
      if (_cogsBreakdownRows.length) {
        _cogsBreakdownSheet
          .getRange(
            _cogsBreakdownSheet.getLastRow() + 1,
            1,
            _cogsBreakdownRows.length,
            ACCOUNTING_HR_HEADERS.InvoiceCOGSBreakdown.length,
          )
          .setValues(_cogsBreakdownRows);
      }
    } catch (breakdownErr) {
      Logger.log(
        "[COGS-BREAKDOWN] فشل تسجيل تفاصيل تكلفة الفاتورة " +
          inv.id + ": " + breakdownErr.message,
      );
    }

    if (missingLots.length > 0) {
      Logger.log(
        "[COGS-FIX] " +
          inv.id +
          " — أصناف بدون طبقات StockLots (استُخدم cost_price fallback): " +
          missingLots.join(", "),
      );
    }

    // [FIX-AUDIT-2026] تنبيه صريح ومرئي للمحاسب (وليس فقط Logger.log غير
    // المرئي) عند نفاد طبقات التكلفة جزئياً أو كلياً — يُكتب في سجل التدقيق
    // العام (AuditLog) الظاهر في واجهة النظام، ليتمكن المحاسب من مراجعة دقة
    // تكلفة البضاعة المباعة لهذه الفاتورة بدل اكتشافها لاحقاً في قائمة الدخل.
    if (partialShortfalls.length > 0 || missingLots.length > 0) {
      try {
        AuditEngine.log("COGS_STOCK_LOTS_SHORTFALL_WARNING", {
          user: (inv && inv.callerUser) || "SYSTEM",
          table: "SaleInvoices",
          record_id: inv.id,
          details:
            "تنبيه: فاتورة " +
            inv.id +
            " — تم استخدام cost_price كبديل (fallback) لأن طبقات التكلفة " +
            (missingLots.length > 0
              ? "غير موجودة إطلاقاً للأصناف: " + missingLots.join(", ") + ". "
              : "") +
            (partialShortfalls.length > 0
              ? "نفدت جزئياً أثناء البيع للأصناف: " +
                partialShortfalls
                  .map(function (p) {
                    return (
                      p.item_id +
                      " (ناقص " +
                      p.qty_missing +
                      " وحدة، تكلفة fallback = " +
                      p.fallback_cost_used.toFixed(2) +
                      ")"
                    );
                  })
                  .join(", ") +
                ". "
              : "") +
            "يُرجى مراجعة أرصدة المخزون لهذا الصنف/الأصناف."});
      } catch (alertErr) {
        Logger.log(
          "[COGS-FIX] تعذّر كتابة تنبيه سجل التدقيق: " + alertErr.message,
        );
      }
    }

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );

    var cogsAccount = _getDefaultAccount("cogs_account", accounts, "EXPENSE", [
      "تكلفة البضاعة المباعة",
      "تكلفة المبيعات",
      "تكلفة",
      "cogs",
    ]);
    var inventoryAccount = _getDefaultAccount(
      "inventory_account",
      accounts,
      "ASSET",
      ["مخزون", "بضاعة", "inventory", "stock"],
    );

    if (!cogsAccount || !inventoryAccount) {
      Logger.log(
        "[COGS-FIX] COGS skip — لم يُعثر على حساب COGS أو مخزون في دليل الحسابات",
      );
      // [BUG-001/BUG-005 FIX] تنبيه مرئي في سجل التدقيق (وليس Logger فقط)
      // — فاتورة بيع بدون قيد تكلفة يجب أن تظهر للمحاسب، مش تختفي بصمت.
      try {
        AuditEngine.log("COGS_JOURNAL_FAILED", {
          user: (inv && inv.callerUser) || "SYSTEM",
          table: "SaleInvoices",
          record_id: inv.id,
          details:
            " لم يتم إنشاء قيد تكلفة البضاعة المباعة لفاتورة " +
            inv.id +
            " — حساب تكلفة البضاعة المباعة أو حساب المخزون غير مُعرَّف في دليل الحسابات. " +
            "يجب مراجعة إعدادات الترحيل وإنشاء القيد يدويًا."});
      } catch (auditErr) {
        Logger.log(
          "[COGS-FIX] فشل تسجيل تنبيه AuditLog: " + auditErr.message,
        );
      }
      // [JOURNAL-SYNC-2026-08-12 §COGS-SILENT-FAIL] لا قيد = لا استهلاك.
      // نعكس الطبقات اللي اتخصمت فعلاً قبل ما نرجع فشل، وإلا يفضل المخزون
      // منقوص بدون أي أثر محاسبي مقابل.
      _restoreConsumedStockLots(_lotsConsumedThisCall);
      return { success: false, message: "COGS accounts missing" };
    }

    // [ITEM-POSTING-WIRE-2026-08-07] توزيع قيد COGS على حساب المخزون/تكلفة
    // البضاعة المباعة الخاص بكل صنف (inventory_account_id/cogs_account_id)
    // بدل حساب عام واحد للفاتورة كلها. أي صنف مالوش حساب مخصص بيرجع
    // للحساب العام الافتراضي تلقائيًا. لو حصل أي خطأ أو مفيش تفصيل بالصنف،
    // بيرجع فورًا لسلوك القديم (سطرين إجماليين) لضمان عدم كسر القيد.
    var cogsLines = [];
    try {
      var itemsForAcctMap = readSheet("Items");
      var accountsById = _buildAccountsByIdMap(accounts);
      var cogsOrder = [];
      var cogsGroups = {}; // cogsAccountId -> amount
      var invOrder = [];
      var invGroups = {}; // inventoryAccountId -> amount
      Object.keys(itemCostMap).forEach(function (itemId) {
        var cost = itemCostMap[itemId];
        if (!cost || cost <= 0) return;
        var itemRec = itemsForAcctMap.find(function (it) {
          return it.id === itemId || it.code === itemId;
        });
        var itemCogsAcc = resolveItemLevelAccount(
          itemRec, "cogs_account_id", accountsById, "EXPENSE", cogsAccount,
        );
        var itemInvAcc = resolveItemLevelAccount(
          itemRec, "inventory_account_id", accountsById, "ASSET", inventoryAccount,
        );
        if (itemCogsAcc) {
          if (!cogsGroups.hasOwnProperty(itemCogsAcc.id)) { cogsGroups[itemCogsAcc.id] = 0; cogsOrder.push(itemCogsAcc.id); }
          cogsGroups[itemCogsAcc.id] += cost;
        }
        if (itemInvAcc) {
          if (!invGroups.hasOwnProperty(itemInvAcc.id)) { invGroups[itemInvAcc.id] = 0; invOrder.push(itemInvAcc.id); }
          invGroups[itemInvAcc.id] += cost;
        }
      });
      // [MAPPED-COST-COVERAGE] لو مجموع التكلفة المصنّفة بالصنف مش مطابق
      // لـ totalCost (فرق تقريب بسيط أو بند لم يُنسب)، الفرق يترحّل على
      // الحساب العام الافتراضي بدل ما يتسقط بصمت ويكسر توازن القيد.
      var mappedCogsSum = cogsOrder.reduce(function (s, id) { return s + cogsGroups[id]; }, 0);
      var mappedInvSum = invOrder.reduce(function (s, id) { return s + invGroups[id]; }, 0);
      var cogsRemainder = Math.round((totalCost - mappedCogsSum) * 100) / 100;
      var invRemainder = Math.round((totalCost - mappedInvSum) * 100) / 100;
      if (Math.abs(cogsRemainder) > 0.001 && cogsAccount) {
        if (!cogsGroups.hasOwnProperty(cogsAccount.id)) { cogsGroups[cogsAccount.id] = 0; cogsOrder.push(cogsAccount.id); }
        cogsGroups[cogsAccount.id] += cogsRemainder;
      }
      if (Math.abs(invRemainder) > 0.001 && inventoryAccount) {
        if (!invGroups.hasOwnProperty(inventoryAccount.id)) { invGroups[inventoryAccount.id] = 0; invOrder.push(inventoryAccount.id); }
        invGroups[inventoryAccount.id] += invRemainder;
      }
      if (!cogsOrder.length || !invOrder.length) throw new Error("no item-level mapping");
      cogsOrder.forEach(function (accId) {
        var amt = Math.round(cogsGroups[accId] * 100) / 100;
        if (amt > 0.0001) {
          cogsLines.push({ account_id: accId, debit: amt, credit: 0, notes: "تكلفة البضاعة المباعة (" + _getCostingMethod() + ")" });
        }
      });
      invOrder.forEach(function (accId) {
        var amt = Math.round(invGroups[accId] * 100) / 100;
        if (amt > 0.0001) {
          cogsLines.push({ account_id: accId, debit: 0, credit: amt, notes: "إخراج المخزون بالتكلفة الفعلية" });
        }
      });
      if (!cogsLines.length) throw new Error("empty item-level cogs lines");
    } catch (mapErr) {
      Logger.log("[ITEM-POSTING-WIRE] فشل توزيع COGS حسب حساب الصنف، رجوع للحسابين العامين: " + mapErr.message);
      cogsLines = [
        {
          account_id: cogsAccount.id,
          debit: totalCost,
          credit: 0,
          notes: "تكلفة البضاعة المباعة (" + _getCostingMethod() + ")",
        },
        {
          account_id: inventoryAccount.id,
          debit: 0,
          credit: totalCost,
          notes: "إخراج المخزون بالتكلفة الفعلية",
        },
      ];
    }
    // [COST-CENTER-DIM] اختياري — نفس مركز تكلفة فاتورة البيع الأصلية
    _applyCostCenterToLines(cogsLines, inv.cost_center_id);

    var cogsResult = _addJournalEntryInternal({
      callerUser: inv.callerUser || "SYSTEM",
      date: inv.date || new Date().toISOString().split("T")[0],
      reference: inv.id + "-COGS",
      description: "تكلفة البضاعة المباعة — " + (inv.party || ""),
      source_type: "COGS",
      lines: cogsLines,
    });

    if (!cogsResult || !cogsResult.success) {
      var _cogsFailMsg = cogsResult ? cogsResult.message : "unknown";
      Logger.log(
        "[COGS-FIX] COGS journal failed for " + inv.id + ": " + _cogsFailMsg,
      );
      // [BUG-001/BUG-005 FIX] تنبيه مرئي في سجل التدقيق العام بدل الاكتفاء
      // بـ Logger.log الخلفي — عشان يظهر للمحاسب إن الفاتورة اتحفظت بدون
      // قيد تكلفة مقابل، ويقدر يعالجها يدويًا بدل ما تختفي بصمت.
      try {
        AuditEngine.log("COGS_JOURNAL_FAILED", {
          user: (inv && inv.callerUser) || "SYSTEM",
          table: "SaleInvoices",
          record_id: inv.id,
          details:
            " فشل إنشاء قيد تكلفة البضاعة المباعة لفاتورة " +
            inv.id +
            ": " +
            _cogsFailMsg +
            " — يحتاج مراجعة يدوية من المحاسب."});
      } catch (auditErr) {
        Logger.log(
          "[COGS-FIX] فشل تسجيل تنبيه AuditLog: " + auditErr.message,
        );
      }
      // [JOURNAL-SYNC-2026-08-12 §COGS-SILENT-FAIL] قيد COGS فشل فعليًا —
      // نعكس استهلاك الطبقات بدل ترك المخزون منقوصًا بلا قيد مقابل.
      _restoreConsumedStockLots(_lotsConsumedThisCall);
      return { success: false, message: _cogsFailMsg };
    }
    return { success: true };
  } catch (e) {
    Logger.log("[COGS-FIX] _autoJournalCOGS error: " + e.message);
    // [BUG-001/BUG-005 FIX] نفس التنبيه المرئي حتى لو الفشل كان نتيجة
    // استثناء غير متوقع (مش بس فشل منطقي في _addJournalEntryInternal).
    try {
      AuditEngine.log("COGS_JOURNAL_FAILED", {
        user: (inv && inv.callerUser) || "SYSTEM",
        table: "SaleInvoices",
        record_id: (inv && inv.id) || "",
        details:
          " استثناء أثناء إنشاء قيد تكلفة البضاعة المباعة لفاتورة " +
          ((inv && inv.id) || "") +
          ": " +
          e.message +
          " — يحتاج مراجعة يدوية من المحاسب."});
    } catch (auditErr) {
      Logger.log("[COGS-FIX] فشل تسجيل تنبيه AuditLog: " + auditErr.message);
    }
    // [JOURNAL-SYNC-2026-08-12 §COGS-SILENT-FAIL] استثناء غير متوقع بعد
    // استهلاك الطبقات (مثلاً فشل قراءة/كتابة شيت أثناء بناء سطور القيد) —
    // نفس مبدأ العكس أعلاه، بأفضل جهد (best-effort؛ لو فشل العكس نفسه،
    // الخطأ يُسجَّل داخل _restoreConsumedStockLots نفسها).
    _restoreConsumedStockLots(_lotsConsumedThisCall);
    return { success: false, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// [ITEM-POSTING-WIRE-2026-08-07] _pushPurchaseDebitLinesByItem — نفس مبدأ
// _pushRevenueLinesForInvoice لكن لمدين فاتورة الشراء: يوزّع المبلغ على
// حساب inventory_account_id الخاص بكل صنف (أو purchase_account_id لو
// الصنف من نوع خدمة/مصروف وليس له حساب مخزون مخصص)، مع رجوع فوري لسطر
// واحد على الحساب العام عند أي خطأ أو نقص بيانات.
// ─────────────────────────────────────────────────────────────
function _pushPurchaseDebitLinesByItem(lines, inv, accounts, fallbackAccount, totalToDistribute, noteLabel, partyId) {
  function pushFallbackSingleLine() {
    if (fallbackAccount && totalToDistribute > 0) {
      lines.push({
        account_id: fallbackAccount.id,
        debit: totalToDistribute,
        credit: 0,
        notes: noteLabel,
        party_type: "supplier",
        party_id: partyId,
      });
    }
  }
  if (!totalToDistribute || totalToDistribute <= 0) return;
  try {
    var invLines = inv.lines_json;
    if (typeof invLines === "string") {
      try { invLines = JSON.parse(invLines); } catch (e) { invLines = []; }
    }
    if (!Array.isArray(invLines) || !invLines.length) { pushFallbackSingleLine(); return; }

    var itemsData = readSheet("Items");
    var accountsById = _buildAccountsByIdMap(accounts);
    var lineShares = invLines
      .map(function (l) {
        var qty = Number(l.qty || l.quantity || 0);
        var price = Number(l.price || l.unit_price || l.cost_price || 0);
        var amt = qty * price;
        if (!amt) amt = Number(l.total || l.line_total || 0);
        return { item_id: l.item_id || l.id || "", amount: amt };
      })
      .filter(function (l) { return l.amount > 0; });
    var grossSum = lineShares.reduce(function (s, l) { return s + l.amount; }, 0);
    if (!grossSum) { pushFallbackSingleLine(); return; }

    var order = [];
    var groups = {};
    lineShares.forEach(function (l) {
      var itemRec = itemsData.find(function (it) { return it.id === l.item_id || it.code === l.item_id; });
      var acc = resolveItemLevelAccount(itemRec, "inventory_account_id", accountsById, "ASSET", null)
        || resolveItemLevelAccount(itemRec, "purchase_account_id", accountsById, null, null)
        || fallbackAccount;
      if (!acc) return;
      if (!groups.hasOwnProperty(acc.id)) { groups[acc.id] = 0; order.push(acc.id); }
      groups[acc.id] += totalToDistribute * (l.amount / grossSum);
    });
    if (!order.length) { pushFallbackSingleLine(); return; }

    var runningTotal = 0;
    order.forEach(function (accId, idx) {
      var amt;
      if (idx === order.length - 1) {
        amt = Math.round((totalToDistribute - runningTotal) * 100) / 100;
      } else {
        amt = Math.round(groups[accId] * 100) / 100;
        runningTotal += amt;
      }
      if (amt > 0.0001) {
        lines.push({ account_id: accId, debit: amt, credit: 0, notes: noteLabel, party_type: "supplier", party_id: partyId });
      }
    });
  } catch (e) {
    Logger.log("[ITEM-POSTING-WIRE] فشل توزيع مدين المشتريات حسب حساب الصنف، رجوع لسطر عام: " + e.message);
    pushFallbackSingleLine();
  }
}

// ─────────────────────────────────────────────────────────────
// _autoJournalPurchaseInvoice — قيد تلقائي من فاتورة الشراء
// ─────────────────────────────────────────────────────────────
function _autoJournalPurchaseInvoice(inv) {
  if (!inv || !inv.net_total || inv.net_total <= 0)
    throw new Error("فاتورة الشراء لا تحتوي على صافي صالح للترحيل");

  var accounts = readSheet(
    "ChartOfAccounts",
    ACCOUNTING_HR_HEADERS.ChartOfAccounts,
  );

  // [ACCOUNT-MAP] حساب الذمم الدائنة: Entity Override (المورد) ← Global Default
  var isCreditPurchase = String(inv.payment_status || "").trim() === "آجل";
  var resolvedSupplierId = _resolvePartyIdByName(inv.party, "supplier");
  var supplierRecForAp = null;
  if (isCreditPurchase && resolvedSupplierId) {
    var suppliersForAp = readSheet("Suppliers", SUPPLIER_HEADERS);
    supplierRecForAp = suppliersForAp.find(function (s) {
      return s.id === resolvedSupplierId;
    });
  }
  var apResolvedInv = resolvePostingAccount({
    accounts: accounts,
    key: "ap_account",
    type: "LIABILITY",
    hints: ["ذمم دائنة", "موردين", "accounts payable", "دائنة"],
    entityAccountId: supplierRecForAp && supplierRecForAp.account_id,
  });
  var apAccount = apResolvedInv.account;
  var cashAccount = _getDefaultAccount("cash_account", accounts, "ASSET", [
    "الصندوق",
    "خزينة رئيسية",
    "cash",
    "صندوق",
  ]);
  var inventoryAccount = _getDefaultAccount(
    "inventory_account",
    accounts,
    "ASSET",
    ["مخزون", "بضاعة", "inventory", "stock"],
  );
  // [FIX-2026-07-21 / GRNI] لو الفاتورة مرتبطة بأمر شراء (po_id) سبق
  // استلامه فعليًا — المخزون بالفعل اتزاد في قيد GRNI وقت الاستلام
  // (receivePurchaseOrder)، فمدين الفاتورة هنا لازم يُقفل GRNI بدل ما
  // يعيد مدين المخزون تاني (كان هيضاعف رصيد المخزون).
  var grniAccount = inv.po_id
    ? _getDefaultAccount("grni_account", accounts, "LIABILITY", [
        "بضاعة مستلمة غير مفوترة",
        "GRNI",
        "goods received not invoiced",
      ])
    : null;
  var invoiceDebitAccount = grniAccount || inventoryAccount;
  var invoiceDebitNotes = grniAccount
    ? "إقفال GRNI — فاتورة شراء لأمر مستلم"
    : "مشتريات — مخزون";
  var vatAccount = _getDefaultAccount("vat_input_account", accounts, "ASSET", [
    "ضريبة قيمة مضافة — مشتريات",
    "ضريبة مشتريات",
    "vat input",
  ]);
  if (!vatAccount) {
    Logger.log(
      "[VAT-INPUT] تحذير: لا حساب ضريبة مدخلات — لن تُسجَّل الضريبة في هذه الفاتورة",
    );
  }

  var lines = [];
  var totalAmount = Number(inv.net_total || 0);
  var vatAmount = Number(inv.vat_amount || 0);
  var purchasesAmount = totalAmount - vatAmount;

  var resolvedPartyId = resolvedSupplierId;
  var isCredit = isCreditPurchase;

  if (invoiceDebitAccount && purchasesAmount > 0) {
    if (grniAccount) {
      // [GRNI] إقفال بضاعة مستلمة غير مفوترة — حساب واحد ثابت دايمًا، مش
      // له علاقة بحساب المخزون الخاص بالصنف (المخزون اتزاد فعليًا وقت
      // الاستلام مش وقت الفاتورة دي).
      lines.push({
        account_id: invoiceDebitAccount.id,
        debit: purchasesAmount,
        credit: 0,
        notes: invoiceDebitNotes,
        party_type: "supplier",
        party_id: resolvedPartyId,
      });
    } else {
      // [ITEM-POSTING-WIRE-2026-08-07] توزيع مدين المخزون على حساب
      // inventory_account_id الخاص بكل صنف بدل حساب مخزون عام واحد.
      _pushPurchaseDebitLinesByItem(lines, inv, accounts, invoiceDebitAccount, purchasesAmount, invoiceDebitNotes, resolvedPartyId);
    }
  }

  if (vatAccount && vatAmount > 0) {
    lines.push({
      account_id: vatAccount.id,
      debit: vatAmount,
      credit: 0,
      notes: "ضريبة مشتريات",
    });
  }

  // [A3-FIX التوافقي للمشتريات] فاتورة "كاش" تُقيَّد في الصندوق، والآجلة فقط في الذمم الدائنة
  // [C4-DUP-FIX] أُزيل التصريح المكرر لـ isCredit — كان مُصرَّحاً به مرتين في نفس النطاق
  var creditAccount = isCredit
    ? apAccount || cashAccount
    : cashAccount || apAccount;
  if (!creditAccount)
    throw new Error(
      "لا يوجد حساب صندوق أو ذمم دائنة صالح لترحيل فاتورة الشراء",
    );

  lines.push({
    account_id: creditAccount.id,
    debit: 0,
    credit: totalAmount,
    notes: inv.party ? "فاتورة شراء — " + inv.party : "فاتورة شراء",
    party_type: "supplier",
    party_id: resolvedPartyId,
  });

  if (lines.length < 2)
    throw new Error(
      "تعذر تكوين قيد مكتمل لفاتورة الشراء؛ راجع إعدادات المشتريات والضرائب",
    );

  // [COST-CENTER-DIM] اختياري — لو الفاتورة مرتبطة بمركز تكلفة
  _applyCostCenterToLines(lines, inv.cost_center_id);

  // [ACCOUNTING-ENGINE-FIX] استخدام الدالة الداخلية مع callerUser من inv
  var result = _addJournalEntryInternal({
    callerUser: inv.callerUser || "SYSTEM",
    date: inv.date || new Date().toISOString().split("T")[0],
    reference: inv.id,
    description: "فاتورة شراء — " + (inv.party || ""),
    source_type: "PURCHASE_INVOICE",
    lines: lines,
  });
  if (!result || !result.success) {
    throw new Error(
      "فشل قيد فاتورة الشراء: " + (result ? result.message : "unknown"),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// _getUsernameFromToken — helper لاستخراج اسم المستخدم من الـ token
// ─────────────────────────────────────────────────────────────
function _getUsernameFromToken(token) {
  if (!token) return null;
  try {
    // [BUGFIX-SESSION-STORE] كانت الدالة دي بتقرا من مفتاح "active_sessions"
    // (blob واحد مجمّع لكل الجلسات) — ده مخزن قديم مبقاش بيتكتب فيه أي حاجة
    // من زمان؛ كل النظام (login/validateSession/refreshSession/logout في
    // Code_12_Core.js) بيستخدم مفتاح منفصل لكل توكن: "sess_" + token.
    // النتيجة: الدالة كانت بترجع null دايمًا لأي توكن حقيقي، فأي دالة سيرفر
    // بتعتمد عليها (postPartyOpeningBalance وحوالي 20 دالة تانية) كانت
    // بتاخد اسم المستخدم الحقيقي، تفشل، وترجع "system" كـ fallback بدلها.
    // بعدين _checkPermission بيتحقق من الجلسة تاني بالطريقة الصح
    // (validateSession)، يلاقي اسم المستخدم الحقيقي مش "system" → يعتبرها
    // "عدم تطابق هوية" (AUTH_MISMATCH) ويرفض الطلب برسالة "خطأ في التحقق من
    // الهوية" — وده كمان كان بيخلي الواجهة تعتقد إن الجلسة نفسها باطلة
    // وتسجّل خروج المستخدم فجأة رغم إن جلسته سليمة 100%.
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty("sess_" + token);
    if (!raw) return null;
    var sess = JSON.parse(raw);
    return sess && sess.username ? sess.username : null;
  } catch (e) {
    console.error("_getUsernameFromToken - خطأ:", e.message || e);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// setupInvoiceSheets — إنشاء شيتات الفواتير (شغّلها مرة واحدة)
// ─────────────────────────────────────────────────────────────
function setupInvoiceSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var saleSheet = ss.getSheetByName("SaleInvoices");
  if (!saleSheet) {
    saleSheet = ss.insertSheet("SaleInvoices");
    saleSheet.appendRow(SALE_INVOICE_HEADERS);
    saleSheet
      .getRange(1, 1, 1, SALE_INVOICE_HEADERS.length)
      .setFontWeight("bold")
      .setBackground("#2563EB")
      .setFontColor("#fff");
  }

  var purchSheet = ss.getSheetByName("PurchaseInvoices");
  if (!purchSheet) {
    purchSheet = ss.insertSheet("PurchaseInvoices");
    purchSheet.appendRow(PURCHASE_INVOICE_HEADERS);
    purchSheet
      .getRange(1, 1, 1, PURCHASE_INVOICE_HEADERS.length)
      .setFontWeight("bold")
      .setBackground("#5B21B6")
      .setFontColor("#fff");
  }

  return { success: true, message: "تم إنشاء شيتات الفواتير" };
}

// ─────────────────────────────────────────────────────────────
// تسجيل الدوال في DOPOST_ALLOWED_FUNCTIONS
// أضف هذه الأسطر في قائمة DOPOST_ALLOWED_FUNCTIONS الموجودة:
// 'getSaleInvoices', 'getPurchaseInvoices',
// 'addSaleInvoice', 'addPurchaseInvoice',
// 'deleteSaleInvoice', 'deletePurchaseInvoice'
// ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════
// نهاية §EXT-INVOICES
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// §EXT-RETURNS  مرتجع البيع ومرتجع الشراء
// ═══════════════════════════════════════════════════════════════════

var SALE_RETURN_HEADERS = [
  "id",
  "date",
  "party",
  "original_invoice_id",
  "reason",
  "subtotal",
  "discount_value",
  "discount_type",
  "discount_amount",
  "vat_percent",
  "vat_amount",
  "net_total",
  "lines_json",
  "notes",
  "created_by",
  "created_at",
  "status",
];

var PURCHASE_RETURN_HEADERS = [
  "id",
  "date",
  "party",
  "original_invoice_id",
  "reason",
  "subtotal",
  "discount_value",
  "discount_type",
  "discount_amount",
  "vat_percent",
  "vat_amount",
  "net_total",
  "lines_json",
  "notes",
  "created_by",
  "created_at",
  "status",
];

// ─────────────────────────────────────────────────────────────
// getSaleReturns — جلب كل مرتجعات البيع
// ─────────────────────────────────────────────────────────────
function getSaleReturns() {
  try {
    var rows = readSheet("SaleReturns", SALE_RETURN_HEADERS, {
      parseJson: ["lines_json"],
    });
    return { success: true, data: cleanArr(rows) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// getPurchaseReturns — جلب كل مرتجعات الشراء
// ─────────────────────────────────────────────────────────────
function getPurchaseReturns() {
  try {
    var rows = readSheet("PurchaseReturns", PURCHASE_RETURN_HEADERS, {
      parseJson: ["lines_json"],
    });
    return { success: true, data: cleanArr(rows) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// addSaleReturn — إضافة مرتجع بيع جديد
// ─────────────────────────────────────────────────────────────
// [BUG-008 FIX] _recomputeReturnSubtotalFromLines — يعيد احتساب subtotal
// مرتجع البيع/الشراء من بنوده (qty × unit_price لكل بند) بدل الثقة في
// القيمة المُرسَلة من المتصفح، والتي كانت نقطة البداية غير المُتحقَّق منها
// لكل معادلة الخصم/الضريبة/الصافي رغم إن باقيها بالفعل يُعاد حسابه سيرفريًا.
// راجع BUG-008 في تقرير الاستقرار (دفعة 6).
function _recomputeReturnSubtotalFromLines(lines) {
  return (lines || []).reduce(function (sum, l) {
    var qty = Number((l && (l.qty || l.quantity)) || 0);
    var price = Number((l && l.unit_price) || 0);
    return sum + qty * price;
  }, 0);
}

// [TRACK2-FIX-2026-08-12] addSaleReturn/addPurchaseReturn لم يكن فيهم أي
// حماية من:
//  (أ) طلب مكرر (double-click/retry) — بعكس addSaleInvoice/addPurchaseInvoice
//      اللي فيهم حارس محتوى 20 ثانية. أضفنا نفس النمط هنا حرفيًا.
//  (ب) كمية مرتجع تتجاوز الكمية المباعة/المشتراة فعليًا على الفاتورة
//      الأصلية (original_invoice_id) — لو الفاتورة الأصلية معروفة، ممكن
//      قبل الإصلاح تسجّل مرتجع بكمية أكبر من اللي بيعت/اتشترت أصلاً، وده
//      بيولّد مخزون/عكس محاسبي وهمي (Track 2، Phase 2B بند 5 / Phase 2C).
//      الفحص هنا تراكمي: بيجمع كل المرتجعات السابقة المرتبطة بنفس الفاتورة
//      لكل صنف ويتأكد إن (المرتجعات السابقة + المرتجع الحالي) ما يتجاوزش
//      الكمية الأصلية بالفاتورة. لو الفاتورة الأصلية مش متاحة (بند غير
//      مرتبط، أو original_invoice_id فاضي)، الفحص بيتخطى بصمت (نفس فلسفة
//      "الإعداد يتحكم بإلزامية original_invoice_id" الموجودة بالفعل فوق) —
//      مفيش داعي لمنع مرتجعات مسموح بيها صراحة بدون فاتورة مرجعية.
function _validateReturnQtyAgainstOriginal(
  originalInvoiceId,
  returnLines,
  invoiceSheetName,
  invoiceHeaders,
  returnSheetName,
  returnHeaders,
  excludeReturnId,
) {
  var oid = String(originalInvoiceId || "").trim();
  if (!oid) return { ok: true };
  try {
    var origInv = readSheet(invoiceSheetName, invoiceHeaders, {
      trimStrings: true,
    }).find(function (r) {
      return String(r.id) === oid;
    });
    if (!origInv) return { ok: true }; // مفيش فاتورة أصلية نتحقق مقابلها — نتخطى بأمان
    var origLines = [];
    try {
      origLines = JSON.parse(origInv.lines_json || "[]");
    } catch (pe) {
      return { ok: true };
    }
    var soldQtyByItem = {};
    origLines.forEach(function (l) {
      var itemId = _resolveInvoiceLineItemId(l);
      if (!itemId) return;
      soldQtyByItem[itemId] =
        (soldQtyByItem[itemId] || 0) + Number(l.qty || l.quantity || 0);
    });

    var priorReturns = readSheet(returnSheetName, returnHeaders, {
      trimStrings: true,
    }).filter(function (r) {
      return (
        String(r.original_invoice_id || "") === oid &&
        String(r.id) !== String(excludeReturnId || "") &&
        r.status !== "cancelled" &&
        r.status !== "reversed"
      );
    });
    var priorReturnedByItem = {};
    priorReturns.forEach(function (r) {
      var lines = [];
      try {
        lines = JSON.parse(r.lines_json || "[]");
      } catch (pe2) {
        return;
      }
      lines.forEach(function (l) {
        var itemId = _resolveInvoiceLineItemId(l);
        if (!itemId) return;
        priorReturnedByItem[itemId] =
          (priorReturnedByItem[itemId] || 0) + Number(l.qty || l.quantity || 0);
      });
    });

    for (var i = 0; i < (returnLines || []).length; i++) {
      var line = returnLines[i];
      var itemId = _resolveInvoiceLineItemId(line);
      if (!itemId) continue;
      var qty = Number(line.qty || line.quantity || 0);
      if (qty <= 0) continue;
      var sold = soldQtyByItem[itemId] || 0;
      var priorReturned = priorReturnedByItem[itemId] || 0;
      if (priorReturned + qty > sold + 0.0001) {
        return {
          ok: false,
          error: {
            success: false,
            message:
              "كمية المرتجع للصنف تتجاوز الكمية الموجودة بالفاتورة الأصلية " +
              oid +
              " (الكمية الأصلية: " +
              sold +
              "، المرتجَع سابقًا: " +
              priorReturned +
              "، المطلوب الآن: " +
              qty +
              ")",
          },
        };
      }
    }
    return { ok: true };
  } catch (e) {
    // فشل الفحص نفسه (شيت غير متاح، إلخ) لا يجب أن يمنع مرتجع مشروع —
    // نُسجّل فقط، نفس فلسفة بقية الحراس الثانوية في هذا الملف.
    Logger.log("[TRACK2-FIX] فشل فحص كمية المرتجع مقابل الأصل: " + e.message);
    return { ok: true };
  }
}

function addSaleReturn(data, sessionToken) {
  try {
    var username = _getUsernameFromToken(sessionToken) || "system";
    var permErr = _checkPermission(username, "addSaleInvoice", sessionToken);
    if (permErr) return permErr;

    // [INV-SETTINGS-WIRE-2026-08-08] sales_return_enabled — كان الإعداد
    // محفوظ ومعروض في شاشة إعدادات المخزون بدون أي فحص فعلي؛ لو معطّل
    // من المفروض يمنع تسجيل أي مرتجع بيع جديد من الأساس.
    try {
      if (InventorySettingsEngine.get("sales_return_enabled") === false) {
        return errResponse("مرتجعات البيع معطّلة حاليًا من إعدادات المخزون");
      }
    } catch (eSRetSetting) {
      // لو الإعدادات مش متاحة، منمنعش العملية بسبب فحص ثانوي (fail-open هنا فقط)
    }

    // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية.
    var _periodErrSRet = _blockIfPeriodClosed(
      data.date || new Date().toISOString().split("T")[0],
      "مرتجع البيع",
    );
    if (_periodErrSRet) return _periodErrSRet;

    // [AUDIT-FIX INVSET-07] block_sale_return_without_original_invoice —
    // قبل التعديل كان ممكن تسجّل مرتجع بيع بدون ربطه بأي فاتورة أصلية،
    // حتى لو الإعداد ده مفعّل من شاشة إعدادات الفواتير (كان معروض بس بلا
    // أي فحص فعلي في السيرفر).
    if (
      typeof InvoiceSettingsEngine !== "undefined" &&
      InvoiceSettingsEngine.get("block_sale_return_without_original_invoice") &&
      !String(data.original_invoice_id || "").trim()
    ) {
      return {
        success: false,
        message:
          "لا يمكن تسجيل مرتجع بيع بدون ربطه بفاتورة بيع أصلية — حسب إعدادات الفواتير",
      };
    }

    // [AUDIT-FIX INVSET-07] return_block_after_days — منع تسجيل مرتجع لو
    // مر على تاريخ الفاتورة الأصلية أكتر من عدد الأيام المسموح به في
    // الإعدادات (0 = بدون حد). قبل التعديل، الإعداد ده كان بلا أي فحص.
    if (
      typeof InvoiceSettingsEngine !== "undefined" &&
      String(data.original_invoice_id || "").trim()
    ) {
      var _retBlockDays = Number(
        InvoiceSettingsEngine.get("return_block_after_days") || 0,
      );
      if (_retBlockDays > 0) {
        try {
          var _origInvForReturn = readSheet(
            "SaleInvoices",
            SALE_INVOICE_HEADERS,
            { trimStrings: true },
          ).find(function (r) {
            return String(r.id) === String(data.original_invoice_id).trim();
          });
          if (_origInvForReturn && _origInvForReturn.date) {
            var _origDateForReturn = new Date(_origInvForReturn.date);
            var _daysSinceInvoice =
              (new Date().getTime() - _origDateForReturn.getTime()) /
              (1000 * 60 * 60 * 24);
            if (
              !isNaN(_daysSinceInvoice) &&
              _daysSinceInvoice > _retBlockDays
            ) {
              return {
                success: false,
                message:
                  "لا يمكن تسجيل مرتجع بعد مرور " +
                  _retBlockDays +
                  " يومًا من تاريخ الفاتورة الأصلية (مر عليها " +
                  Math.floor(_daysSinceInvoice) +
                  " يومًا) — حسب إعدادات الفواتير",
              };
            }
          }
        } catch (eRetDays) {
          Logger.log(
            "[INVSET-07] فشل فحص return_block_after_days: " + eRetDays.message,
          );
        }
      }
    }

    // [TRACK2-FIX-2026-08-12] كمية المرتجع مقابل الأصل — قبل أخذ القفل،
    // نفس ترتيب فحوصات addSaleInvoice (قبل الكتابة، بدون حجز موارد).
    var _qtyCheckSRet = _validateReturnQtyAgainstOriginal(
      data.original_invoice_id,
      data.lines || [],
      "SaleInvoices",
      SALE_INVOICE_HEADERS,
      "SaleReturns",
      SALE_RETURN_HEADERS,
      null,
    );
    if (!_qtyCheckSRet.ok) return _qtyCheckSRet.error;

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);

    var id = makeId("SRET");
    var now = new Date().toISOString();
    var linesJson = JSON.stringify(data.lines || []);

    // [BUG-008 FIX] subtotal محسوب من البنود على السيرفر بدل الثقة في
    // القيمة المُرسَلة من المتصفح.
    var subtotal = _recomputeReturnSubtotalFromLines(data.lines);
    var discountValue = Number(data.discount_value || 0);
    var discountType = data.discount_type || "fixed";
    var discountAmount =
      discountType === "percent"
        ? (subtotal * discountValue) / 100
        : discountValue;
    var afterDiscount = subtotal - discountAmount;
    var vatPercent = Number(data.vat_percent || 0);
    var vatAmount = (afterDiscount * vatPercent) / 100;
    var netTotal = afterDiscount + vatAmount;

    // [TRACK2-FIX-2026-08-12] حارس تكرار بالمحتوى — نفس نمط 20 ثانية
    // المطبّق في addSaleInvoice/addPurchaseInvoice، غير موجود هنا قبل كده.
    try {
      var _dedupWindowMsSRet = 20000;
      var _dedupNowTsSRet = Date.now();
      var _dupSRet = readSheet("SaleReturns", SALE_RETURN_HEADERS, {
        trimStrings: true,
      }).find(function (r) {
        if (String(r.party || "") !== String(data.party || "")) return false;
        if (Math.abs(Number(r.net_total || 0) - netTotal) > 0.01) return false;
        if (String(r.lines_json || "") !== linesJson) return false;
        var _createdTs = new Date(r.created_at || 0).getTime();
        return (
          !isNaN(_createdTs) &&
          _dedupNowTsSRet - _createdTs >= 0 &&
          _dedupNowTsSRet - _createdTs < _dedupWindowMsSRet
        );
      });
      if (_dupSRet) {
        lock.releaseLock();
        return {
          success: false,
          message:
            "يبدو أن هذا المرتجع أُرسِل للتو (خلال آخر 20 ثانية) بنفس الطرف والبنود والإجمالي — رقم " +
            _dupSRet.id +
            ". لو كان مرتجعًا جديدًا فعلاً، انتظر لحظة وأعد المحاولة",
        };
      }
    } catch (_dedupErrSRet) {
      Logger.log("[TRACK2-DEDUP] فشل فحص تكرار مرتجع البيع: " + _dedupErrSRet.message);
    }

    // [REPO-MIGRATION] getSheet() بتعمل الإنشاء + الحماية + ترحيل الأعمدة +
    // قفل ضد التعارض تلقائيًا. بنحتفظ بنفس تنسيق صف العناوين المميز (أحمر)
    // بس لو الشيت لسه جديد (صف واحد بس = العناوين فقط).
    var sheet = getSheet("SaleReturns", SALE_RETURN_HEADERS);
    if (sheet.getLastRow() <= 1) {
      sheet
        .getRange(1, 1, 1, SALE_RETURN_HEADERS.length)
        .setFontWeight("bold")
        .setBackground("#DC2626")
        .setFontColor("#fff");
    }

    // [ARCH-AUDIT-P3-10] appendRow خام -> DataLayerEngine.insert
    DataLayerEngine.insert(
      "SaleReturns",
      {
        id: id,
        date: data.date || now.split("T")[0],
        party: data.party || "",
        original_invoice_id: data.original_invoice_id || "",
        reason: data.reason || "",
        subtotal: subtotal,
        discount_value: discountValue,
        discount_type: discountType,
        discount_amount: discountAmount,
        vat_percent: vatPercent,
        vat_amount: vatAmount,
        net_total: netTotal,
        lines_json: linesJson,
        notes: data.notes || "",
        created_by: username,
        created_at: now,
        status: data.status || "confirmed",
      },
      { headers: SALE_RETURN_HEADERS },
    );

    // حركة مخزون عكسية: المرتجع يضيف للمخزن (IN)
    (data.lines || []).forEach(function (line, idx) {
      var qty = Number(line.qty || line.quantity || 0);
      var itemId = _resolveInvoiceLineItemId(line);
      if (!itemId || qty <= 0) return;
      var tx = {
        type: "IN",
        item_id: itemId,
        quantity: qty,
        date: data.date || now.split("T")[0],
        to_warehouse: data.warehouse || "الرئيسي",
        warehouse: data.warehouse || "الرئيسي",
        from_warehouse: "",
        color: line.color || "",
        ref: id,
        permit_id: id,
        party: data.party || "",
        notes: "مرتجع بيع " + id + " | بند " + (idx + 1),
        user: username,
        sessionToken: sessionToken,
      };
      var txId = id + "-" + (idx + 1);
      // [ARCH-AUDIT-P3-7] appendRow خام -> DataLayerEngine.insert
      DataLayerEngine.insert(
        "Transactions",
        _txRowToObject(_buildTxRow(tx, txId, new Date())),
        { headers: HEADERS.Transactions },
      );
      updateStockBalance(tx);
    });

    // [ACCOUNTING-ENGINE] قيد تلقائي لمرتجع المبيعات
    var _saleReturnJournalWarning = undefined;
    try {
      _autoJournalSaleReturn(
        {
          id: id,
          party: data.party,
          net_total: netTotal,
          vat_amount: vatAmount,
          date: data.date || new Date().toISOString().split("T")[0],
          created_by: username,
          lines_json: data.lines || [], // [C2-FIX] مطلوب لحساب عكس تكلفة المرتجع
        },
        username,
      );
    } catch (je) {
      Logger.log("Sale Return Journal Error: " + je.message);
      // [BUG-005 FIX] نفس نمط تنبيه فشل القيود التلقائية المُطبَّق في
      // فاتورة البيع/حركات المخزون — تنبيه مرئي في AuditLog بدل Logger فقط.
      try {
        AuditEngine.log("AUTO_JOURNAL_FAILED", {
          user: username,
          table: "SaleReturns",
          record_id: id,
          details:
            " فشل إنشاء القيد المحاسبي لمرتجع البيع " +
            id +
            ": " +
            je.message +
            " — يحتاج مراجعة يدوية من المحاسب."});
      } catch (auditErr4) {
        Logger.log(
          "[SaleReturn] فشل تسجيل تنبيه AuditLog: " + auditErr4.message,
        );
      }
      // [AUDIT-FIX-RETURNS-JOURNAL-2026-08-08] كان بيتسجّل في AuditLog بس
      // الـ response بيرجع success:true من غير أي إشارة — المستخدم مكنش
      // هيعرف إلا لو فتح سجل التدقيق يدويًا. نفس اتفاقية journal_warning
      // المستخدمة في postStocktakeSession وبتتعرض تلقائيًا عبر SaveEngine.
      _saleReturnJournalWarning =
        "تم حفظ مرتجع البيع، لكن القيد المحاسبي لم يُنشأ (" +
        je.message +
        ") — راجع سجل التدقيق وأنشئه يدويًا";
    }

    // [TRACK2-FIX-2026-08-12] نفس عزل فشل الـ audit/cache بعد نجاح الحفظ
    // فعليًا (المرتجع + حركة المخزون) المطبَّق في addSaleInvoice — راجع
    // تعليق [TRACK1-FIX-2026-08-12] هناك.
    try {
      AuditEngine.log("ADD_SALE_RETURN", {
        user: username,
        table: "SaleReturns",
        record_id: id,
        details:
          "طرف: " + (data.party || "") + " | الإجمالي: " + netTotal.toFixed(2)});
    } catch (auditErrSRet) {
      Logger.log(
        "[TRACK2-FIX] فشل تسجيل Audit Log لمرتجع بيع محفوظ فعلاً (" +
          id + "): " + auditErrSRet.message,
      );
    }
    try {
      _invalidateServerCacheInvoices(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    } catch (cacheErrSRet) {
      Logger.log(
        "[TRACK2-FIX] فشل إبطال الكاش بعد حفظ مرتجع بيع (" +
          id + "): " + cacheErrSRet.message,
      );
    }
    lock.releaseLock();

    return {
      success: true,
      message: "تم حفظ مرتجع البيع بنجاح",
      journal_warning: _saleReturnJournalWarning,
      data: { id: id, net_total: netTotal },
    };
  } catch (e) {
    try {
      lock.releaseLock();
    } catch (le) {
      Logger.log("[silent-catch] " + le);
    }
    return { success: false, message: "خطأ: " + e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// addPurchaseReturn — إضافة مرتجع شراء جديد
// ─────────────────────────────────────────────────────────────
function addPurchaseReturn(data, sessionToken) {
  try {
    var username = _getUsernameFromToken(sessionToken) || "system";
    var permErr = _checkPermission(
      username,
      "addPurchaseInvoice",
      sessionToken,
    );
    if (permErr) return permErr;

    // [INV-SETTINGS-WIRE-2026-08-08] purchase_return_enabled — نفس مبدأ
    // sales_return_enabled في addSaleReturn أعلاه.
    try {
      if (InventorySettingsEngine.get("purchase_return_enabled") === false) {
        return errResponse("مرتجعات الشراء معطّلة حاليًا من إعدادات المخزون");
      }
    } catch (ePRetSetting) {
      // fail-open فقط لو تعذّرت قراءة الإعدادات نفسها
    }

    // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية.
    var _periodErrPRet = _blockIfPeriodClosed(
      data.date || new Date().toISOString().split("T")[0],
      "مرتجع الشراء",
    );
    if (_periodErrPRet) return _periodErrPRet;

    // [AUDIT-FIX INVSET-07] require_original_purchase_invoice_for_return —
    // نفس مبدأ block_sale_return_without_original_invoice في addSaleReturn.
    if (
      typeof InvoiceSettingsEngine !== "undefined" &&
      InvoiceSettingsEngine.get("require_original_purchase_invoice_for_return") &&
      !String(data.original_invoice_id || "").trim()
    ) {
      return {
        success: false,
        message:
          "لا يمكن تسجيل مرتجع شراء بدون ربطه بفاتورة شراء أصلية — حسب إعدادات الفواتير",
      };
    }

    // [TRACK2-FIX-2026-08-12] نفس فحص كمية المرتجع مقابل الأصل المطبَّق في
    // addSaleReturn — راجع تعليق _validateReturnQtyAgainstOriginal فوق.
    var _qtyCheckPRet = _validateReturnQtyAgainstOriginal(
      data.original_invoice_id,
      data.lines || [],
      "PurchaseInvoices",
      PURCHASE_INVOICE_HEADERS,
      "PurchaseReturns",
      PURCHASE_RETURN_HEADERS,
      null,
    );
    if (!_qtyCheckPRet.ok) return _qtyCheckPRet.error;

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);

    var id = makeId("PRET");
    var now = new Date().toISOString();
    var linesJson = JSON.stringify(data.lines || []);

    // [BUG-008 FIX] subtotal محسوب من البنود على السيرفر بدل الثقة في
    // القيمة المُرسَلة من المتصفح.
    var subtotal = _recomputeReturnSubtotalFromLines(data.lines);
    var discountValue = Number(data.discount_value || 0);
    var discountType = data.discount_type || "fixed";
    var discountAmount =
      discountType === "percent"
        ? (subtotal * discountValue) / 100
        : discountValue;
    var afterDiscount = subtotal - discountAmount;
    var vatPercent = Number(data.vat_percent || 0);
    var vatAmount = (afterDiscount * vatPercent) / 100;
    var netTotal = afterDiscount + vatAmount;

    // [TRACK2-FIX-2026-08-12] حارس تكرار بالمحتوى — نفس نمط addSaleReturn.
    try {
      var _dedupWindowMsPRet = 20000;
      var _dedupNowTsPRet = Date.now();
      var _dupPRet = readSheet("PurchaseReturns", PURCHASE_RETURN_HEADERS, {
        trimStrings: true,
      }).find(function (r) {
        if (String(r.party || "") !== String(data.party || "")) return false;
        if (Math.abs(Number(r.net_total || 0) - netTotal) > 0.01) return false;
        if (String(r.lines_json || "") !== linesJson) return false;
        var _createdTs = new Date(r.created_at || 0).getTime();
        return (
          !isNaN(_createdTs) &&
          _dedupNowTsPRet - _createdTs >= 0 &&
          _dedupNowTsPRet - _createdTs < _dedupWindowMsPRet
        );
      });
      if (_dupPRet) {
        lock.releaseLock();
        return {
          success: false,
          message:
            "يبدو أن هذا المرتجع أُرسِل للتو (خلال آخر 20 ثانية) بنفس الطرف والبنود والإجمالي — رقم " +
            _dupPRet.id +
            ". لو كان مرتجعًا جديدًا فعلاً، انتظر لحظة وأعد المحاولة",
        };
      }
    } catch (_dedupErrPRet) {
      Logger.log("[TRACK2-DEDUP] فشل فحص تكرار مرتجع الشراء: " + _dedupErrPRet.message);
    }

    // [REPO-MIGRATION] راجع نفس ملاحظة SaleReturns أعلاه.
    var sheet = getSheet("PurchaseReturns", PURCHASE_RETURN_HEADERS);
    if (sheet.getLastRow() <= 1) {
      sheet
        .getRange(1, 1, 1, PURCHASE_RETURN_HEADERS.length)
        .setFontWeight("bold")
        .setBackground("#7C3AED")
        .setFontColor("#fff");
    }

    // [ARCH-AUDIT-P3-11] appendRow خام -> DataLayerEngine.insert
    DataLayerEngine.insert(
      "PurchaseReturns",
      {
        id: id,
        date: data.date || now.split("T")[0],
        party: data.party || "",
        original_invoice_id: data.original_invoice_id || "",
        reason: data.reason || "",
        subtotal: subtotal,
        discount_value: discountValue,
        discount_type: discountType,
        discount_amount: discountAmount,
        vat_percent: vatPercent,
        vat_amount: vatAmount,
        net_total: netTotal,
        lines_json: linesJson,
        notes: data.notes || "",
        created_by: username,
        created_at: now,
        status: data.status || "confirmed",
      },
      { headers: PURCHASE_RETURN_HEADERS },
    );

    // [TRACK2-FIX-PREVALIDATE-2026-08-12] فحص توفر المخزون لكل بنود مرتجع
    // الشراء قبل أي كتابة إطلاقًا — قبل التعديل، الفحص (_checkOutboundStock)
    // كان بيحصل داخل نفس حلقة الكتابة (DataLayerEngine.insert +
    // updateStockBalance)؛ فلو صنف رقم N (من أصل عدة بنود) فشل فيه الفحص
    // بعد ما بنود سابقة 1..N-1 خصمت من المخزون فعليًا وكُتبت حركاتها، كان
    // الاستثناء بيهرب مباشرة لـ catch الخارجي للدالة كاملة فيرجّع
    // success:false — لكن صف PurchaseReturns وحركات المخزون الجزئية
    // السابقة تفضل موجودة فعليًا بلا rollback (بيانات جزئية صامتة، نفس
    // فئة عيب ATOMIC-INVOICE-FIX). الحل: نفحص كل البنود أولًا، ولو أي بند
    // فشل نحذف صف المرتجع ونرجع فورًا — قبل أي حركة مخزون واحدة تتكتب.
    for (var _pvi = 0; _pvi < (data.lines || []).length; _pvi++) {
      var _pvLine = data.lines[_pvi];
      var _pvQty = Number(_pvLine.qty || _pvLine.quantity || 0);
      var _pvItemId = _resolveInvoiceLineItemId(_pvLine);
      if (!_pvItemId || _pvQty <= 0) continue;
      var _pvErr = _checkOutboundStock({
        type: "OUT",
        item_id: _pvItemId,
        quantity: _pvQty,
        warehouse: data.warehouse || "الرئيسي",
        from_warehouse: data.warehouse || "الرئيسي",
      });
      if (_pvErr) {
        _deleteInvoiceRowById(sheet, id);
        lock.releaseLock();
        return {
          success: false,
          message: "فشل حفظ مرتجع الشراء — تعذّر تحديث المخزون: " + _pvErr,
        };
      }
    }

    // حركة مخزون عكسية: المرتجع للمورد يُخرج من المخزن (OUT)
    (data.lines || []).forEach(function (line, idx) {
      var qty = Number(line.qty || line.quantity || 0);
      var itemId = _resolveInvoiceLineItemId(line);
      if (!itemId || qty <= 0) return;
      var tx = {
        type: "OUT",
        item_id: itemId,
        quantity: qty,
        date: data.date || now.split("T")[0],
        from_warehouse: data.warehouse || "الرئيسي",
        warehouse: data.warehouse || "الرئيسي",
        to_warehouse: "",
        color: line.color || "",
        ref: id,
        permit_id: id,
        party: data.party || "",
        notes: "مرتجع شراء " + id + " | بند " + (idx + 1),
        user: username,
        sessionToken: sessionToken,
      };
      var txId = id + "-" + (idx + 1);
      // [ARCH-AUDIT-P3-7] appendRow خام -> DataLayerEngine.insert
      DataLayerEngine.insert(
        "Transactions",
        _txRowToObject(_buildTxRow(tx, txId, new Date())),
        { headers: HEADERS.Transactions },
      );
      updateStockBalance(tx);
      // [INV-FIX-2026-08-12 §PRET-LOT] راجع تعليق _consumeLotForPurchaseReturn
      // (Code_03_Accounting_Costing.js) — قبل هذا الإصلاح كان مرتجع الشراء
      // يخصم من رصيد المخزون الإجمالي فقط بدون أي أثر على StockLots، فتبقى
      // طبقة تكلفة الفاتورة الأصلية بكامل كميتها رغم رجوع البضاعة للمورد.
      try {
        _consumeLotForPurchaseReturn({
          item_id: itemId,
          color: line.color || "",
          warehouse: data.warehouse || "الرئيسي",
          qty: qty,
          original_invoice_id: data.original_invoice_id || "",
        });
      } catch (lotErrPRet) {
        Logger.log(
          "[PRET-LOT] فشل عكس/استهلاك طبقة تكلفة لمرتجع شراء " +
            id + " بند " + (idx + 1) + ": " + lotErrPRet.message,
        );
      }
    });
    // [TRACK2-FIX-2026-08-12] الحلقة فوق (خصم مخزون OUT لكل بند) لم تكن
    // محمية بـ try/catch محلي: لو صنف في نص القائمة فشل فيه _checkOutboundStock
    // (رصيد غير كافٍ) بعد ما بنود سابقة نجحت فعلاً وخصمت من المخزون، الاستثناء
    // كان بيوصل مباشرة لـ catch الخارجي للدالة كلها فيرجّع success:false —
    // لكن صف PurchaseReturns وحركات المخزون الجزئية السابقة كانت فضلت
    // موجودة فعليًا بدون أي rollback ولا تنبيه (بيانات جزئية صامتة، نفس
    // فئة عيب ATOMIC-INVOICE-FIX). لا يوجد fix هنا لأن الاستثناء بيتقفل
    // مباشرة عبر catch الخارجي؛ الإصلاح الفعلي منقول لأعلى الحلقة (فحص
    // توفر كل الكميات لكل البنود قبل أي كتابة إطلاقًا) — راجع
    // [TRACK2-FIX-PREVALIDATE] فوق حلقة forEach.

    // [ACCOUNTING-ENGINE] قيد تلقائي لمرتجع المشتريات
    var _purchaseReturnJournalWarning = undefined;
    try {
      _autoJournalPurchaseReturn(
        {
          id: id,
          party: data.party,
          net_total: netTotal,
          vat_amount: vatAmount,
          date: data.date || new Date().toISOString().split("T")[0],
          created_by: username,
          lines_json: data.lines || [], // [C3-FIX] مطلوب لحساب قيد تخفيض المخزون
        },
        username,
      );
    } catch (je) {
      Logger.log("Purchase Return Journal Error: " + je.message);
      // [BUG-005 FIX] نفس نمط التنبيه المرئي في AuditLog.
      try {
        AuditEngine.log("AUTO_JOURNAL_FAILED", {
          user: username,
          table: "PurchaseReturns",
          record_id: id,
          details:
            " فشل إنشاء القيد المحاسبي لمرتجع الشراء " +
            id +
            ": " +
            je.message +
            " — يحتاج مراجعة يدوية من المحاسب."});
      } catch (auditErr5) {
        Logger.log(
          "[PurchaseReturn] فشل تسجيل تنبيه AuditLog: " + auditErr5.message,
        );
      }
      // [AUDIT-FIX-RETURNS-JOURNAL-2026-08-08] نفس إصلاح مرتجع البيع —
      // التنبيه كان بيتسجّل في AuditLog بس من غير أي إشارة في الـ response.
      _purchaseReturnJournalWarning =
        "تم حفظ مرتجع الشراء، لكن القيد المحاسبي لم يُنشأ (" +
        je.message +
        ") — راجع سجل التدقيق وأنشئه يدويًا";
    }

    // [TRACK2-FIX-2026-08-12] نفس عزل فشل الـ audit عن نتيجة عملية ناجحة.
    try {
      AuditEngine.log("ADD_PURCHASE_RETURN", {
        user: username,
        table: "PurchaseReturns",
        record_id: id,
        details:
          "طرف: " + (data.party || "") + " | الإجمالي: " + netTotal.toFixed(2)});
    } catch (auditErrPRet) {
      Logger.log(
        "[TRACK2-FIX] فشل تسجيل Audit Log لمرتجع شراء محفوظ فعلاً (" +
          id + "): " + auditErrPRet.message,
      );
    }

    try {
      _invalidateServerCacheInvoices(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    } catch (cacheErrPRet) {
      Logger.log(
        "[TRACK2-FIX] فشل إبطال الكاش بعد حفظ مرتجع شراء (" +
          id + "): " + cacheErrPRet.message,
      );
    }
    lock.releaseLock();

    return {
      success: true,
      message: "تم حفظ مرتجع الشراء بنجاح",
      journal_warning: _purchaseReturnJournalWarning,
      data: { id: id, net_total: netTotal },
    };
  } catch (e) {
    try {
      lock.releaseLock();
    } catch (le) {
      Logger.log("[silent-catch] " + le);
    }
    return { success: false, message: "خطأ: " + e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// deleteSaleReturn — حذف مرتجع بيع
// ─────────────────────────────────────────────────────────────
function deleteSaleReturn(id, sessionToken) {
  // [P1-C FIX] حذف آمن: عكس حركة المخزون (OUT عكس IN المرتجع) + إلغاء القيد
  try {
    var username = _getUsernameFromToken(sessionToken) || "system";
    var permErr = _checkPermission(username, "deleteSaleInvoice", sessionToken);
    if (permErr) return permErr;

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      // 1. جلب المرتجع
      var returns = readSheet("SaleReturns", SALE_RETURN_HEADERS, {
        parseJson: ["lines_json"],
      });
      var ret = returns.find(function (r) {
        return r.id === id;
      });
      if (!ret) return { success: false, message: "مرتجع البيع غير موجود" };

      // [PERIOD-CLOSING]
      var _periodErr = _blockIfPeriodClosed(ret.date, "مرتجع البيع");
      if (_periodErr) return _periodErr;

      // [P0-FIX-DELETE-RETURN-PARTIAL-RETRY-2026-08-12] تحقّق فعلي أثبت أن
      // هذه الحلقة (forEach على بنود المرتجع) لم تكن آمنة لإعادة المحاولة:
      // DataLayerEngine.insert لا يفرض تفرّد id افتراضيًا (فقط لو تم تمرير
      // opts.uniqueField، وهو غير مُمرَّر هنا)، وقيمته أصلاً غير مفحوصة هنا
      // (return value متجاهلة تمامًا). لو فشل أي بند في منتصف الحلقة
      // (مثلاً updateStockBalance أو _reverseStockLot رمت استثناءً غير
      // متوقع)، الاستثناء كان بيهرب للـ catch الخارجي فيرجّع success:false
      // — لكن صف PurchaseReturns/SaleReturns لسه موجود (الحذف بيحصل بعد
      // الحلقة، وهو ترتيب صحيح أصلاً). المشكلة تظهر عند إعادة المحاولة:
      // البنود التي نجح عكسها بالفعل قبل الفشل (insert + updateStockBalance +
      // _reverseStockLot/_restoreStockLot) هتتنفذ تاني من الصفر، فيتكرر
      // عكس المخزون وطبقة التكلفة مرتين لنفس البند رغم إن txId ثابت
      // ومحسوب سلفًا (id + "-REV-" + idx). الحل: نتحقق أولاً هل txId ده
      // موجود بالفعل في Transactions (يعني البند ده اتعكس في محاولة سابقة)
      // ونتخطاه فورًا لو موجود — يخلي الحلقة idempotent فعليًا تحت إعادة
      // المحاولة، بدون تغيير في المنطق المحاسبي/المخزني للحالة العادية
      // (أول تنفيذ ناجح).
      var _existingRevTxIds = {};
      try {
        getSheetData("Transactions").forEach(function (r) {
          if (r.ref === id && String(r.id || "").indexOf(id + "-REV-") === 0) {
            _existingRevTxIds[r.id] = true;
          }
        });
      } catch (eScanRev) {
        Logger.log("[DELETE-RETURN-RETRY-GUARD] فشل فحص حركات العكس الموجودة: " + eScanRev.message);
      }

      // 2. عكس حركات المخزون (المرتجع أضاف IN، الحذف يُخرج OUT)
      var lines = ret.lines_json || [];
      lines.forEach(function (line, idx) {
        var qty = Number(line.qty || line.quantity || 0);
        var itemId = _resolveInvoiceLineItemId(line);
        if (!itemId || qty <= 0) return;
        var tx = {
          type: "OUT",
          item_id: itemId,
          quantity: qty,
          date: ret.date || new Date().toISOString().split("T")[0],
          from_warehouse: ret.warehouse || "الرئيسي",
          warehouse: ret.warehouse || "الرئيسي",
          to_warehouse: "",
          color: line.color || "",
          ref: id,
          permit_id: id,
          party: ret.party || "",
          notes: "عكس حذف مرتجع بيع " + id + " | بند " + (idx + 1),
          user: username,
          sessionToken: sessionToken,
        };
        var txId = id + "-REV-" + (idx + 1);
        if (_existingRevTxIds[txId]) {
          // [P0-FIX-DELETE-RETURN-PARTIAL-RETRY-2026-08-12] البند ده اتعكس
          // بالفعل في محاولة حذف سابقة فشلت في منتصفها — نتخطاه لمنع عكس
          // مضاعف للمخزون/طبقة التكلفة.
          Logger.log("[DELETE-RETURN-RETRY-GUARD] تخطّي بند مُعاد عكسه بالفعل: " + txId);
          return;
        }
        // [ARCH-AUDIT-P3-7] appendRow خام -> DataLayerEngine.insert
        DataLayerEngine.insert(
          "Transactions",
          _txRowToObject(_buildTxRow(tx, txId, new Date())),
          { headers: HEADERS.Transactions },
        );
        updateStockBalance(tx);
        // [INV-FIX-2026-08-12 §LOT-GAP-DELETE-RETURN] _autoJournalSaleReturn
        // (Code_04_Accounting_JournalEntries.js) يُنشئ StockLot فعلي لكل
        // مرتجع بيع عبر _restoreStockLot (source_type=SALE_RETURN,
        // source_id=ret.id) — راجع تعليق [AUDIT-FIX-2026-08-08
        // §RISK-LOT-GAP-CRITICAL-2] هناك. لكن هذه الدالة (حذف مرتجع البيع)
        // كانت تعكس فقط حركة رصيد المخزون (updateStockBalance) بدون عكس
        // تلك الطبقة إطلاقاً — فتبقى الطبقة "شبح" في StockLots بكامل
        // qty_remaining، ويقدر _consumeStockLots يستهلك منها لاحقًا رغم
        // إن المرتجع الذي أنشأها اتحذف فعليًا، منتجًا COGS من مخزون غير
        // موجود فعليًا في الرصيد. الحل: عكس نفس الطبقة هنا بنفس الكمية،
        // مفلترة بالصنف/اللون (راجع تعليق _reverseStockLot لشرح خطر
        // الخلط بين أصناف متعددة تشترك في نفس source_id).
        _reverseStockLot(id, qty, itemId, line.color || "");
      });

      // 3. إلغاء القيد المحاسبي المرتبط
      _cancelJournalEntryByReference(id, username);

      // 4. حذف الصف
      var sheet = getSheet("SaleReturns");
      if (ret._row) sheet.deleteRow(ret._row);

      _invalidateServerCacheInvoices(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      AuditEngine.log("DELETE_SALE_RETURN", {
        user: username,
        table: "SaleReturns",
        record_id: id,
        details: "حذف مع عكس مخزون وإلغاء قيد | صافي: " + (ret.net_total || 0)});
      return { success: true, message: "تم حذف مرتجع البيع وعكس آثاره" };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    try {
      lock.releaseLock();
    } catch (le) {
      Logger.log("[silent-catch] " + le);
    }
    return { success: false, message: "خطأ في حذف مرتجع البيع: " + e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// deletePurchaseReturn — حذف مرتجع شراء
// ─────────────────────────────────────────────────────────────
function deletePurchaseReturn(id, sessionToken) {
  // [P1-C FIX] حذف آمن: عكس حركة المخزون (IN عكس OUT المرتجع) + إلغاء القيد
  try {
    var username = _getUsernameFromToken(sessionToken) || "system";
    var permErr = _checkPermission(
      username,
      "deletePurchaseInvoice",
      sessionToken,
    );
    if (permErr) return permErr;

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      // 1. جلب المرتجع
      var returns = readSheet("PurchaseReturns", PURCHASE_RETURN_HEADERS, {
        parseJson: ["lines_json"],
      });
      var ret = returns.find(function (r) {
        return r.id === id;
      });
      if (!ret) return { success: false, message: "مرتجع الشراء غير موجود" };

      // [PERIOD-CLOSING]
      var _periodErr = _blockIfPeriodClosed(ret.date, "مرتجع الشراء");
      if (_periodErr) return _periodErr;

      // [P0-FIX-DELETE-RETURN-PARTIAL-RETRY-2026-08-12] نفس إصلاح
      // deleteSaleReturn — راجع تعليق [P0-FIX-DELETE-RETURN-PARTIAL-RETRY-2026-08-12]
      // هناك لشرح كامل السبب. الحلقة أدناه لم تكن آمنة لإعادة المحاولة بعد
      // فشل جزئي في المنتصف؛ نتحقق من txId المحسوب سلفًا مقابل الحركات
      // الموجودة فعليًا قبل أي عكس لتفادي عكس مضاعف عند الـ retry.
      var _existingRevTxIdsPRet = {};
      try {
        getSheetData("Transactions").forEach(function (r) {
          if (r.ref === id && String(r.id || "").indexOf(id + "-REV-") === 0) {
            _existingRevTxIdsPRet[r.id] = true;
          }
        });
      } catch (eScanRevPRet) {
        Logger.log("[DELETE-RETURN-RETRY-GUARD] فشل فحص حركات العكس الموجودة: " + eScanRevPRet.message);
      }

      // 2. عكس حركات المخزون (المرتجع أخرج OUT، الحذف يُدخل IN)
      var lines = ret.lines_json || [];
      lines.forEach(function (line, idx) {
        var qty = Number(line.qty || line.quantity || 0);
        var itemId = _resolveInvoiceLineItemId(line);
        if (!itemId || qty <= 0) return;
        var tx = {
          type: "IN",
          item_id: itemId,
          quantity: qty,
          date: ret.date || new Date().toISOString().split("T")[0],
          to_warehouse: ret.warehouse || "الرئيسي",
          warehouse: ret.warehouse || "الرئيسي",
          from_warehouse: "",
          color: line.color || "",
          ref: id,
          permit_id: id,
          party: ret.party || "",
          notes: "عكس حذف مرتجع شراء " + id + " | بند " + (idx + 1),
          user: username,
          sessionToken: sessionToken,
        };
        var txId = id + "-REV-" + (idx + 1);
        if (_existingRevTxIdsPRet[txId]) {
          Logger.log("[DELETE-RETURN-RETRY-GUARD] تخطّي بند مُعاد عكسه بالفعل: " + txId);
          return;
        }
        // [ARCH-AUDIT-P3-7] appendRow خام -> DataLayerEngine.insert
        DataLayerEngine.insert(
          "Transactions",
          _txRowToObject(_buildTxRow(tx, txId, new Date())),
          { headers: HEADERS.Transactions },
        );
        updateStockBalance(tx);
        // [INV-FIX-2026-08-12 §PRET-LOT-DELETE] عكسٌ متماثل لإصلاح
        // §PRET-LOT في addPurchaseReturn: بما إن حفظ مرتجع الشراء بقى
        // يستهلك من StockLots (طبقة الفاتورة الأصلية أو FIFO عام)، حذف
        // المرتجع لازم يُعيد نفس الكمية لطبقات التكلفة، وإلا هتفضل
        // StockLots ناقصة كمية "رجعت فعليًا" للمخزون بحذف المرتجع.
        // نستخدم _restoreStockLot (نفس أداة استرجاع مرتجع البيع) لأن
        // النظام لا يسجّل حاليًا أي طبقات مصدر بعينها استُهلكت وقت حفظ
        // المرتجع (نفس الفجوة المعمارية الموثقة في updateTransaction
        // بخصوص عدم ربط استهلاك الطبقات بمعرّف الحركة) — فننشئ طبقة
        // جديدة بتكلفة سعر بند المرتجع نفسه (نفس القيمة المستخدمة أصلاً
        // في القيد المحاسبي عبر _recomputeReturnSubtotalFromLines)، بدل
        // محاولة تخمين الطبقة الأصلية بالتحديد.
        try {
          var _pretDelUnitCost = Number(line.unit_price || line.price || 0);
          if (_pretDelUnitCost > 0) {
            _restoreStockLot({
              item_id: itemId,
              color: line.color || "",
              warehouse: ret.warehouse || "الرئيسي",
              qty: qty,
              unit_cost: _pretDelUnitCost,
              source_id: id,
              lot_date: ret.date || new Date().toISOString().split("T")[0],
            });
          }
        } catch (lotErrPRetDel) {
          Logger.log(
            "[PRET-LOT-DELETE] فشل استرجاع طبقة تكلفة عند حذف مرتجع شراء " +
              id + " بند " + (idx + 1) + ": " + lotErrPRetDel.message,
          );
        }
      });

      // 3. إلغاء القيد المحاسبي المرتبط
      _cancelJournalEntryByReference(id, username);

      // 4. حذف الصف
      var sheet = getSheet("PurchaseReturns");
      if (ret._row) sheet.deleteRow(ret._row);

      _invalidateServerCacheInvoices(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      AuditEngine.log("DELETE_PURCHASE_RETURN", {
        user: username,
        table: "PurchaseReturns",
        record_id: id,
        details: "حذف مع عكس مخزون وإلغاء قيد | صافي: " + (ret.net_total || 0)});
      return { success: true, message: "تم حذف مرتجع الشراء وعكس آثاره" };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    try {
      lock.releaseLock();
    } catch (le) {
      Logger.log("[silent-catch] " + le);
    }
    return { success: false, message: "خطأ في حذف مرتجع الشراء: " + e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 28914-30482] (فاصل) + Vodafone Cash / Wallets ┄┄┄
// نهاية §EXT-RETURNS
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
