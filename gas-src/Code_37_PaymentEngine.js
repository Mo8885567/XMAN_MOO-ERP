// ══════════════════════════════════════════════════════════════════════════
// Code_37_PaymentEngine.gs — محرك الدفع الموحّد (PaymentEngine) — المرحلة 1 + 2
// ──────────────────────────────────────────────────────────────────────────
// المرحلة 1 (كانت هنا سابقًا): adjustLedgerBalance() الموحّدة لصناديق نقدية
// وحسابات بنكية + getMethodBalance() للقراءة. راجع تاريخ الملف للتفاصيل.
//
// [PAYMENT-ENGINE-DESIGN] المرحلة 2 (هذا التحديث):
//   1) Payment Allocation — allocateToInvoice() / getInvoicePaymentInfo():
//      تتبع الدفع الجزئي على مستوى الفاتورة نفسها عبر عمودين جديدين
//      (paid_amount, remaining_amount) أُضيفا في نهاية SALE_INVOICE_HEADERS
//      و PURCHASE_INVOICE_HEADERS (Code_20_Sales.gs) — قرار مقصود بدل شيت
//      Allocations منفصل، بما إن كل سند قبض/صرف مرتبط بفاتورة واحدة بالفعل
//      (عمود invoice_id، موجود أصلاً في ReceiptVouchers، وأُضيف الآن أيضًا
//      لـ PaymentVouchers). مربوطة من approve/cancel الخاصة بـ
//      ReceiptVoucher (السند بيسدد فاتورة بيع) وPaymentVoucher (السند بيسدد
//      فاتورة شراء) في Code_06_Accounting_Vouchers.gs — لو فيه invoice_id
//      بس، من غيره السند بيفضل شغال زي ما هو بدون أي تخصيص.
//   2) VFC للقراءة فقط — getMethodBalance("VFCLines", lineId) بترجع نفس
//      رصيد الخط المحسوب فعليًا في getVodafoneCashLineDetail (تجميع
//      المعاملات + الرصيد الافتتاحي) بدون أي لمس لمنطق الكتابة أو القيد
//      المحاسبي التلقائي بتاع VFC — ده قرار مقصود لأن VFC بنيتها مختلفة
//      جوهريًا (رصيد محسوب on-the-fly مش عمود current_balance مخزّن)، وأي
//      توحيد لمسار الكتابة يحتاج مراجعة منفصلة قبل تنفيذه.
//
// طريقة الاستخدام من أي ملف .gs في نفس المشروع:
//   PaymentEngine.adjustLedgerBalance("CashBoxes", cashBoxId, amount);
//   var bal = PaymentEngine.getMethodBalance("CashBoxes", cashBoxId);
//   var vfcBal = PaymentEngine.getMethodBalance("VFCLines", lineId); // قراءة فقط
//   PaymentEngine.allocateToInvoice("SaleInvoices", invoiceId, amount);
//   var info = PaymentEngine.getInvoicePaymentInfo("PurchaseInvoices", invoiceId);
// ══════════════════════════════════════════════════════════════════════════

var PaymentEngine = (function () {
  "use strict";

  // كل "دفتر رصيد" مدعوم حاليًا: اسم الشيت ↔ الهيدرز الصحيحة بتاعته.
  // إضافة دفتر جديد مستقبلًا (مثلاً Wallets) = سطر واحد هنا بدل ملف جديد.
  var LEDGER_HEADERS = {
    CashBoxes: ACCOUNTING_HR_HEADERS.CashBoxes,
    BankAccounts: ACCOUNTING_HR_HEADERS.BankAccounts,
  };

  function _headersFor(ledgerType) {
    var h = LEDGER_HEADERS[ledgerType];
    if (!h) throw new Error("PaymentEngine: دفتر رصيد غير معروف: " + ledgerType);
    return h;
  }

  /**
   * adjustLedgerBalance — النسخة الموحّدة الوحيدة من منطق تعديل رصيد
   * صندوق نقدي أو حساب بنكي، مع تزامن تلقائي مع دليل الحسابات.
   *
   * @param {String} ledgerType - "CashBoxes" أو "BankAccounts".
   * @param {String} recordId - معرّف الصندوق/الحساب.
   * @param {Number} amount - المبلغ (موجب = إضافة، سالب = خصم).
   * @returns {Boolean} true لو اتحدّث فعلاً، false لو السجل مش موجود أو
   *   حصل خطأ (يتم ابتلاع الخطأ بنفس سلوك الدالتين الأصليتين حتى لا
   *   يوقف عملية محاسبية أساسية بسبب فشل تحديث رصيد عرضي).
   */
  function adjustLedgerBalance(ledgerType, recordId, amount) {
    // [SEC-FIX-STAB2] إضافة LockService حول كامل مسار Read-Modify-Write
    // (قراءة current_balance القديم → حساب الجديد → كتابته) — بدون القفل،
    // دفعتين متزامنتين ممكن يقروا نفس القيمة القديمة فتكتب التانية فوق
    // نتيجة الأولى بدل التراكم عليها (رصيد عميل/صندوق غلط بفلوس حقيقية
    // ضايعة). نفس فلسفة القفل المستخدمة في DeleteEngine (BUG-009/010).
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      console.error(
        "PaymentEngine.adjustLedgerBalance(" + ledgerType + ") lock timeout:",
        lockErr && lockErr.message,
      );
      return false;
    }
    try {
      var headers = _headersFor(ledgerType);
      var sheet = getSheet(ledgerType, headers);
      var rows = readSheet(ledgerType, headers, { trimStrings: true });
      var idx = rows.findIndex(function (r) {
        return r.id === recordId;
      });
      if (idx === -1) return false;

      var sheetHeaders = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var balanceCol = sheetHeaders.indexOf("current_balance");
      if (balanceCol === -1) return false;

      var current = Number(rows[idx].current_balance || 0);
      var newBalance = current + Number(amount || 0);
      sheet.getRange(idx + 2, balanceCol + 1).setValue(newBalance);

      // تزامن مع دليل الحسابات — نفس سلوك [BUG-FIX-007] الأصلي بالضبط
      // (يتم استدعاؤها هنا جوه نفس القفل عشان تبقى العملية كلها متزنة
      // ذرّيًا؛ _updateChartAccountBalance لازم تكون آمنة لإعادة الدخول
      // أو غير مقفلة هي نفسها لتجنب deadlock — راجع تعليقها لو تغيّر).
      var accountId = rows[idx].account_id;
      if (accountId) {
        _updateChartAccountBalance(accountId, amount);
      }
      return true;
    } catch (e) {
      console.error(
        "PaymentEngine.adjustLedgerBalance(" + ledgerType + ") error:",
        e.message,
      );
      return false;
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * getMethodBalance — قراءة رصيد صندوق/حساب حالي بدون تعديل.
   * حالة خاصة: "VFCLines" — قراءة فقط، بنفس منطق الحساب الفعلي المستخدم في
   * getVodafoneCashLineDetail (Code_20_Sales.gs): تجميع كل المعاملات
   * الناجحة للخط + الرصيد الافتتاحي. لا كتابة هنا إطلاقًا.
   */
  function getMethodBalance(ledgerType, recordId) {
    if (ledgerType === "VFCLines") return _vfcLineBalanceReadOnly(recordId);
    try {
      var headers = _headersFor(ledgerType);
      var rows = readSheet(ledgerType, headers, { trimStrings: true });
      var found = rows.find(function (r) {
        return r.id === recordId;
      });
      return found ? Number(found.current_balance || 0) : 0;
    } catch (e) {
      console.error(
        "PaymentEngine.getMethodBalance(" + ledgerType + ") error:",
        e.message,
      );
      return 0;
    }
  }

  /**
   * _vfcLineBalanceReadOnly — يعتمد على الدوال المُعرَّفة أصلاً في
   * Code_20_Sales.gs (_vfcLines, _vfcTx, _vfcAggregateByLine) بدون تكرار
   * منطق التجميع هنا. لو الدوال دي مش محمّلة لأي سبب بيرجع 0 بدل ما يفشل.
   */
  function _vfcLineBalanceReadOnly(lineId) {
    try {
      if (
        typeof _vfcLines === "undefined" ||
        typeof _vfcTx === "undefined" ||
        typeof _vfcAggregateByLine === "undefined"
      ) {
        return 0;
      }
      var line = _vfcLines().find(function (l) {
        return l.id === lineId;
      });
      if (!line) return 0;
      var txs = _vfcTx().filter(function (t) {
        return t.line_id === lineId;
      });
      var agg = _vfcAggregateByLine(txs);
      var a = agg[lineId] || { balance: 0 };
      return (Number(line.opening_balance) || 0) + (a.balance || 0);
    } catch (e) {
      console.error("PaymentEngine._vfcLineBalanceReadOnly error:", e.message);
      return 0;
    }
  }

  // ── Payment Allocation ────────────────────────────────────────────────
  // خرائط هيدرز الفواتير — lazy resolution (نفس أسلوب RepositoryLayer،
  // Code_38) لتفادي أي مشكلة ترتيب تحميل ملفات.
  function _invoiceHeadersFor(invoiceTable) {
    if (invoiceTable === "SaleInvoices")
      return typeof SALE_INVOICE_HEADERS !== "undefined"
        ? SALE_INVOICE_HEADERS
        : null;
    if (invoiceTable === "PurchaseInvoices")
      return typeof PURCHASE_INVOICE_HEADERS !== "undefined"
        ? PURCHASE_INVOICE_HEADERS
        : null;
    return null;
  }

  /**
   * allocateToInvoice — يحدّث paid_amount/remaining_amount لفاتورة واحدة.
   * @param {String} invoiceTable - "SaleInvoices" أو "PurchaseInvoices".
   * @param {String} invoiceId - معرّف الفاتورة.
   * @param {Number} amount - المبلغ المُخصَّص (موجب = تحصيل/سداد جديد،
   *   سالب = عكس تخصيص سابق عند إلغاء سند معتمد).
   * @returns {{success:Boolean, paid_amount:Number, remaining_amount:Number,
   *   fully_paid:Boolean}|{success:false, message:String}}
   */
  function allocateToInvoice(invoiceTable, invoiceId, amount) {
    // [SEC-FIX-STAB2] نفس إصلاح adjustLedgerBalance أعلاه — تخصيص دفعتين
    // متزامنتين لنفس الفاتورة (مثلاً سندي قبض في نفس اللحظة) كان ممكن
    // يقرا الاتنين نفس paid_amount القديم فتضيع دفعة كاملة من السجل رغم
    // إنها فعليًا اتقبضت. القفل يغطي القراءة والحساب والكتابة سوا.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      console.error(
        "PaymentEngine.allocateToInvoice(" + invoiceTable + ") lock timeout:",
        lockErr && lockErr.message,
      );
      return {
        success: false,
        message: "النظام مشغول بعملية تخصيص دفعة أخرى لنفس الفاتورة، حاول مرة أخرى",
      };
    }
    try {
      var headers = _invoiceHeadersFor(invoiceTable);
      if (!headers)
        return { success: false, message: "جدول فواتير غير معروف: " + invoiceTable };
      if (!invoiceId) return { success: false, message: "معرّف الفاتورة مطلوب" };

      var sheet = getSheet(invoiceTable, headers);
      var rows = readSheet(invoiceTable, headers, { trimStrings: true });
      var idx = rows.findIndex(function (r) {
        return r.id === invoiceId;
      });
      if (idx === -1) return { success: false, message: "الفاتورة غير موجودة" };

      var sheetHeaders = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var paidCol = sheetHeaders.indexOf("paid_amount");
      var remainingCol = sheetHeaders.indexOf("remaining_amount");
      if (paidCol === -1 || remainingCol === -1) {
        return {
          success: false,
          message: "أعمدة paid_amount/remaining_amount غير موجودة في " + invoiceTable,
        };
      }

      var invoice = rows[idx];
      var netTotal = Number(invoice.net_total || 0);
      var currentPaid = Number(invoice.paid_amount || 0);
      var newPaid = currentPaid + Number(amount || 0);
      // لا نسمح بقيمة سالبة (مثلاً نتيجة إلغاء أكتر من مرة بالغلط)
      if (newPaid < 0) newPaid = 0;
      var newRemaining = netTotal - newPaid;

      sheet.getRange(idx + 2, paidCol + 1).setValue(newPaid);
      sheet.getRange(idx + 2, remainingCol + 1).setValue(newRemaining);

      return {
        success: true,
        paid_amount: newPaid,
        remaining_amount: newRemaining,
        fully_paid: newRemaining <= 0,
      };
    } catch (e) {
      console.error(
        "PaymentEngine.allocateToInvoice(" + invoiceTable + ") error:",
        e.message,
      );
      return { success: false, message: e.message };
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * getInvoicePaymentInfo — قراءة فقط لحالة السداد الحالية لفاتورة.
   */
  function getInvoicePaymentInfo(invoiceTable, invoiceId) {
    try {
      var headers = _invoiceHeadersFor(invoiceTable);
      if (!headers) return null;
      var rows = readSheet(invoiceTable, headers, { trimStrings: true });
      var invoice = rows.find(function (r) {
        return r.id === invoiceId;
      });
      if (!invoice) return null;
      var netTotal = Number(invoice.net_total || 0);
      var paid = Number(invoice.paid_amount || 0);
      var remaining =
        invoice.remaining_amount !== "" && invoice.remaining_amount !== undefined
          ? Number(invoice.remaining_amount)
          : netTotal - paid;
      return {
        net_total: netTotal,
        paid_amount: paid,
        remaining_amount: remaining,
        fully_paid: remaining <= 0,
      };
    } catch (e) {
      console.error(
        "PaymentEngine.getInvoicePaymentInfo(" + invoiceTable + ") error:",
        e.message,
      );
      return null;
    }
  }

  return {
    adjustLedgerBalance: adjustLedgerBalance,
    getMethodBalance: getMethodBalance,
    allocateToInvoice: allocateToInvoice,
    getInvoicePaymentInfo: getInvoicePaymentInfo,
    // للاستخدام المستقبلي لو احتجنا نضيف دفتر رصيد جديد من خارج الملف
    _LEDGER_HEADERS: LEDGER_HEADERS,
  };
})();
