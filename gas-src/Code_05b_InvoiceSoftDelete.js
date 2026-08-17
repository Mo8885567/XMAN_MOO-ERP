// ══════════════════════════════════════════════════════════════════════════
// Code_05b_InvoiceSoftDelete.js — عمليات حذف ناعم للفواتير (Write Operations)
// ──────────────────────────────────────────────────────────────────────────
// [MAINT-FIX-7] استُخرجت من Code_05_Accounting_Reports.js بناءً على ملاحظة
// المراجعة: ملف اسمه "Reports" كان فعليًا يحتوي على دوال كتابة/تعديل بيانات
// (appendRow على Transactions، وتعديل أعمدة Soft-Delete) بجانب دوال القراءة
// الفعلية (getGeneralLedger, getTrialBalance, ...) — ده بيكسر مبدأ إن ملف
// "Reports" المفروض read-only، ويصعّب على أي مطوّر جديد يتوقع إن فيه Side
// Effects على البيانات جوه ملف بهذا الاسم.
//
// الدوال هنا نسخة حرفية من غير أي تغيير في المنطق أو أسماء الدوال
// (Backward-compatible)، فأي استدعاء قديم لها (من الواجهة أو DOPOST
// Allowlist) هيفضل شغال زي ما هو بالظبط.
// ══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// §P2-06  SOFT DELETE — Invoice & Journal Entry
// ───────────────────────────────────────────────────────────────────────────

/**
 * softDeleteSaleInvoice — نقطة الدخول العامة (Backward-compatible، نفس اسم
 * الدالة القديم مسجّل في DOPOST Allowlist بـ Code_12_Core.js).
 * [UNIFY-INVOICE-DELETE] بقت غلاف رفيع بينادي DeleteEngine.delete("saleInvoice", ...)
 * بنفس نمط deleteCustomer/deleteItem/deleteWarehouse — المنطق التفصيلي
 * الحرج (عكس مخزون/تكلفة/قيود) اتنقل لـ _coreSoftDeleteSaleInvoice بدون
 * أي تغيير في خطوة واحدة منه.
 */
function softDeleteSaleInvoice(id, callerUser, sessionToken) {
  return DeleteEngine.delete("saleInvoice", id, callerUser, sessionToken);
}

/**
 * _coreSoftDeleteSaleInvoice — حذف ناعم لفاتورة البيع (يُبقي الصف + يُلغي الآثار)
 * يحل محل deleteSaleInvoice الذي يحذف الصف فعلياً
 * الفاتورة تبقى في الشيت بحقل deleted_at + deleted_by
 * جميع التقارير تُفلتر is_deleted/deleted_at تلقائياً
 */
function _coreSoftDeleteSaleInvoice(id, callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "deleteSaleInvoice", sessionToken);
  if (permErr) return permErr;

  try {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var invoices = readSheet("SaleInvoices", SALE_INVOICE_HEADERS, {
        parseJson: ["lines_json"],
      });
      var inv = invoices.find(function (r) {
        return r.id === id && !r.deleted_at;
      });
      if (!inv)
        return {
          success: false,
          message: "فاتورة البيع غير موجودة أو محذوفة بالفعل",
        };

      // [UNIFY-INVOICE-DELETE / PERIOD-CLOSING] كانت دالة deleteSaleInvoice
      // القديمة (Code_20_Sales.js) بتفحص إقفال الفترة قبل الحذف، لكن هذا
      // الفحص كان ناقصًا هنا في مسار الحذف الناعم الموحّد — أُضيف الآن حتى
      // لا يفوت أي فرق سلوك بعد ما deleteSaleInvoice بقت تفوّض لهذا المسار.
      var _periodErr = _blockIfPeriodClosed(inv.date, "فاتورة البيع");
      if (_periodErr) return _periodErr;

      // 1. عكس حركات المخزون
      var lines = inv.lines_json || [];
      lines.forEach(function (line, idx) {
        var qty = Number(line.qty || line.quantity || 0);
        var itemId = _resolveInvoiceLineItemId(line);
        if (!itemId || qty <= 0) return;
        // استعادة الكميات في Stock
        var tx = {
          type: "IN",
          item_id: itemId,
          quantity: qty,
          date: inv.date || new Date().toISOString().split("T")[0],
          to_warehouse: inv.warehouse || "الرئيسي",
          warehouse: inv.warehouse || "الرئيسي",
          from_warehouse: "",
          color: line.color || "",
          ref: id,
          permit_id: id,
          party: inv.party || "",
          notes: "عكس حذف ناعم فاتورة بيع " + id + " | بند " + (idx + 1),
          user: callerUser,
          sessionToken: sessionToken,
        };
        var txId = id + "-SDEL-" + (idx + 1);
        try {
          _appendRowProtected(getSheet("Transactions"), HEADERS.Transactions, _buildTxRow(tx, txId, new Date())); // [ENGINE-UNIFY]
          updateStockBalance(tx);
        } catch (txErr) {
          Logger.log(
            "[P2-SD] Stock reversal error line " +
              (idx + 1) +
              ": " +
              txErr.message,
          );
        }
        // عكس طبقات التكلفة — يُعاد الصنف بتكلفة من Items
        var itemData = null;
        try {
          var allItems = readSheet("Items");
          itemData = allItems.find(function (it) {
            return it.id === itemId;
          });
        } catch (e2) {}
        _createStockLot({
          item_id: itemId,
          color: line.color || "",
          warehouse: inv.warehouse || "",
          qty: qty,
          unit_cost: (itemData && itemData.cost_price) || 0,
          source_type: "SALE_RETURN",
          source_id: id + "-SDEL",
          lot_date: inv.date || new Date().toISOString().split("T")[0],
        });
      });

      // 2. إلغاء القيود المحاسبية
      _cancelJournalEntryByReference(id, callerUser);
      _cancelJournalEntryByReference(id + "-COGS", callerUser);

      // 3. تمييز الفاتورة كمحذوفة ناعماً (لا نحذف الصف)
      var sheet = getSheet("SaleInvoices");
      var rowIdx = inv._row;
      if (rowIdx) {
        var now = new Date().toISOString();
        // نُضيف حقلي deleted_at و deleted_by في آخر عمودين إن لم يكونا موجودَين
        _ensureSoftDeleteColumns(
          "SaleInvoices",
          SALE_INVOICE_HEADERS,
          sheet,
          rowIdx,
          callerUser,
          now,
        );
      }

      _addAuditLog(
        callerUser,
        "SOFT_DELETE_SALE_INVOICE",
        "SaleInvoices",
        id,
        "حذف ناعم | صافي: " + (inv.net_total || 0),
      );
      _invalidateServerCacheInvoices(); // [PERF-SCOPED-INVALIDATION] scoped
      return {
        success: true,
        message: "تم حذف فاتورة البيع وحفظ السجل التاريخي",
      };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return { success: false, message: "خطأ في الحذف: " + e.message };
  }
}
/**
 * softDeletePurchaseInvoice — نقطة الدخول العامة (Backward-compatible).
 * [UNIFY-INVOICE-DELETE] غلاف رفيع بينادي DeleteEngine.delete("purchaseInvoice", ...)
 */
function softDeletePurchaseInvoice(id, callerUser, sessionToken) {
  return DeleteEngine.delete("purchaseInvoice", id, callerUser, sessionToken);
}

/**
 * _coreSoftDeletePurchaseInvoice — حذف ناعم لفاتورة الشراء
 */
function _coreSoftDeletePurchaseInvoice(id, callerUser, sessionToken) {
  var permErr = _checkPermission(
    callerUser,
    "deletePurchaseInvoice",
    sessionToken,
  );
  if (permErr) return permErr;

  try {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var invoices = readSheet("PurchaseInvoices", PURCHASE_INVOICE_HEADERS, {
        parseJson: ["lines_json"],
      });
      var inv = invoices.find(function (r) {
        return r.id === id && !r.deleted_at;
      });
      if (!inv)
        return {
          success: false,
          message: "فاتورة الشراء غير موجودة أو محذوفة بالفعل",
        };

      // [UNIFY-INVOICE-DELETE / PERIOD-CLOSING] نفس الفحص الموجود في
      // deletePurchaseInvoice القديمة (Code_20_Sales.js)، مُضاف هنا حتى لا
      // يفوت أي فرق سلوك بعد التوحيد.
      var _periodErr = _blockIfPeriodClosed(inv.date, "فاتورة الشراء");
      if (_periodErr) return _periodErr;

      var lines = inv.lines_json || [];
      lines.forEach(function (line, idx) {
        var qty = Number(line.qty || line.quantity || 0);
        var itemId = _resolveInvoiceLineItemId(line);
        if (!itemId || qty <= 0) return;
        // عكس الكمية من المخزون (OUT)
        var tx = {
          type: "OUT",
          item_id: itemId,
          quantity: qty,
          date: inv.date || new Date().toISOString().split("T")[0],
          from_warehouse: inv.warehouse || "الرئيسي",
          warehouse: inv.warehouse || "الرئيسي",
          to_warehouse: "",
          color: line.color || "",
          ref: id,
          permit_id: id,
          party: inv.party || "",
          notes: "عكس حذف ناعم فاتورة شراء " + id + " | بند " + (idx + 1),
          user: callerUser,
          sessionToken: sessionToken,
        };
        var txId = id + "-SDEL-" + (idx + 1);
        try {
          _appendRowProtected(getSheet("Transactions"), HEADERS.Transactions, _buildTxRow(tx, txId, new Date())); // [ENGINE-UNIFY]
          updateStockBalance(tx);
        } catch (txErr) {
          Logger.log("[P2-SD] Purchase stock reversal error: " + txErr.message);
        }
        // عكس طبقات التكلفة
        // [INV-FIX-2026-08-12 §LOT-XITEM] تمرير item_id/color صراحة —
        // راجع تعليق _reverseStockLot لشرح خطر الخلط بين أصناف فاتورة
        // شراء متعددة البنود تشترك في نفس source_id.
        _reverseStockLot(id, qty, itemId, line.color || "");
      });

      _cancelJournalEntryByReference(id, callerUser);
      _cancelJournalEntryByReference(id + "-INV", callerUser);

      var sheet = getSheet("PurchaseInvoices");
      if (inv._row) {
        _ensureSoftDeleteColumns(
          "PurchaseInvoices",
          PURCHASE_INVOICE_HEADERS,
          sheet,
          inv._row,
          callerUser,
          new Date().toISOString(),
        );
      }
      _addAuditLog(
        callerUser,
        "SOFT_DELETE_PURCHASE_INVOICE",
        "PurchaseInvoices",
        id,
        "حذف ناعم",
      );
      _invalidateServerCacheInvoices(); // [PERF-SCOPED-INVALIDATION] scoped
      return {
        success: true,
        message: "تم حذف فاتورة الشراء وحفظ السجل التاريخي",
      };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return { success: false, message: e.message };
  }
}
/**
 * _ensureSoftDeleteColumns — يكتب deleted_at + deleted_by في الشيت
 * إذا لم تكن الأعمدة موجودة في الـ header يُضيفها في النهاية
 */
function _ensureSoftDeleteColumns(
  sheetName,
  headers,
  sheet,
  rowNum,
  callerUser,
  now,
) {
  try {
    // نحدد موضع deleted_at و deleted_by في الـ headers
    var dtCol = headers.indexOf("deleted_at") + 1;
    var byCol = headers.indexOf("deleted_by") + 1;

    if (dtCol > 0) {
      sheet.getRange(rowNum, dtCol).setValue(now);
    } else {
      // العمود غير موجود في الـ headers — نكتب في آخر عمود + 1 و +2
      var lastCol = sheet.getLastColumn();
      // تحقق من أن العنوان موجود
      var headerRow = sheet.getRange(1, lastCol - 1, 1, 2).getValues()[0];
      if (headerRow[0] !== "deleted_at") {
        sheet.getRange(1, lastCol + 1).setValue("deleted_at");
        sheet.getRange(1, lastCol + 2).setValue("deleted_by");
        dtCol = lastCol + 1;
        byCol = lastCol + 2;
      } else {
        dtCol = lastCol - 1;
        byCol = lastCol;
      }
      sheet.getRange(rowNum, dtCol).setValue(now);
    }
    if (byCol > 0) {
      sheet.getRange(rowNum, byCol).setValue(callerUser);
    }
  } catch (e) {
    Logger.log("[P2-SD] _ensureSoftDeleteColumns error: " + e.message);
  }
}
/**
 * _migrateAddSoftDeleteColumns — يُضيف أعمدة deleted_at و deleted_by لشيت موجود
 */
function _migrateAddSoftDeleteColumns(sheetName, headers) {
  var sheet = SS.getSheetByName(sheetName);
  if (!sheet) return;

  var existingHeaders = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0];
  var existingStr = existingHeaders.join(",");

  if (existingStr.indexOf("deleted_at") === -1) {
    var nextCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, nextCol).setValue("deleted_at");
    sheet.getRange(1, nextCol + 1).setValue("deleted_by");
    // حماية من إزالة الصفر الأول
    sheet.getRange(1, nextCol, sheet.getMaxRows(), 1).setNumberFormat("@");
  }
}
