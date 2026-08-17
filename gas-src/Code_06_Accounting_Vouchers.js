// ════════════════════════════════════════════════════════════════
// Code_Accounting_Vouchers.gs — [REFACTOR-P4] نُقل من Code_Accounting.gs (نقل نصي بحت،
// صفر تغيير في المنطق أو الترتيب الداخلي بين الدوال). Apps Script يعامل
// كل ملفات .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء
// من أي ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// راجع تقرير Architecture Audit 2026-07-03 — المرحلة 4، قسم 4-ب.
//
// المسؤولية: سندات القبض والصرف والتحويل (Vouchers) + المصروفات (Expenses)
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-06  Accounting — Receipt Vouchers (سندات القبض)
// ═══════════════════════════════════════════════════════════════════════════════

// [AUDIT-FIX 2.1] _resolveVoucherChequeId — الربط الحقيقي بين سندات القبض/الصرف
// وموديول الشيكات (Cheques)، بدل حقلي check_number/due_date الحرّين اللي كانا
// بيسمحوا بتسجيل نفس الشيك مرتين في مكانين غير متزامنين. لو data.cheque_id
// مُرسَل، بيتحقق منه ويربطه مباشرة (لازم يكون PENDING وغير مربوط بسند تاني
// ومطابق للاتجاه الصحيح). لو مش مُرسَل بس فيه بيانات شيك خام (check_number/
// due_date قديمة من عميل واجهة لسه مش محدَّث)، بينشئ سجل Cheque جديد فعلي
// عبر addCheque() ويرجع الـ id بتاعه. لو مفيش أي بيانات شيك، بيرجع "" عادي
// (سند نقدي/بنكي عادي مش شيك).
function _resolveVoucherChequeId(data, direction, partyName) {
  if (data.cheque_id) {
    var existing = readSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques, {
      trimStrings: true,
    }).find(function (c) {
      return c.id === data.cheque_id;
    });
    if (!existing) return { ok: false, message: "الشيك المحدد غير موجود" };
    if (existing.type !== direction)
      return {
        ok: false,
        message:
          direction === "INCOMING"
            ? "الشيك المحدد ليس شيكًا واردًا"
            : "الشيك المحدد ليس شيكًا صادرًا",
      };
    if (existing.status !== "PENDING")
      return { ok: false, message: "الشيك المحدد ليس في حالة معلّقة (PENDING)" };
    var linkedElsewhere = readSheet(
      "ReceiptVouchers",
      ACCOUNTING_HR_HEADERS.ReceiptVouchers,
      { trimStrings: true },
    )
      .concat(
        readSheet("PaymentVouchers", ACCOUNTING_HR_HEADERS.PaymentVouchers, {
          trimStrings: true,
        }),
      )
      .some(function (v) {
        return v.cheque_id === data.cheque_id;
      });
    if (linkedElsewhere)
      return { ok: false, message: "الشيك ده مربوط بسند آخر بالفعل" };
    return { ok: true, cheque_id: data.cheque_id };
  }

  // لا يوجد cheque_id — لو فيه بيانات شيك خام (مسار توافقي)، أنشئ سجل Cheque فعلي
  if (data.check_number || data.due_date) {
    if (!data.due_date)
      return { ok: false, message: "تاريخ استحقاق الشيك مطلوب" };
    var chequeResult = addCheque({
      callerUser: data.callerUser,
      sessionToken: data.sessionToken,
      type: direction,
      bank_account_id: data.bank_account_id || "",
      cheque_number: data.check_number || "",
      party_type: data.party_type || "OTHER",
      party_id: data.party_id || "",
      party_name: partyName || data.check_number,
      amount: data.amount,
      currency: data.currency,
      due_date: data.due_date,
      notes: "أُنشئ تلقائيًا من سند " + (direction === "INCOMING" ? "قبض" : "صرف"),
    });
    if (!chequeResult || !chequeResult.success)
      return {
        ok: false,
        message:
          "تعذّر إنشاء سجل الشيك المرتبط: " +
          (chequeResult ? chequeResult.message : "خطأ غير معروف"),
      };
    return { ok: true, cheque_id: chequeResult.id };
  }

  return { ok: true, cheque_id: "" };
}

function getReceiptVouchers(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser) {
      var _permErr = _checkPermission(
        opts.callerUser,
        "viewReceiptVouchers",
        opts.sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet(
      "ReceiptVouchers",
      ACCOUNTING_HR_HEADERS.ReceiptVouchers,
      { trimStrings: true },
    );
    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });
    if (opts.from_date)
      rows = rows.filter(function (r) {
        return r.date >= opts.from_date;
      });
    if (opts.to_date)
      rows = rows.filter(function (r) {
        return r.date <= opts.to_date;
      });
    rows.sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب سندات القبض: " + e.message);
  }
}
function addReceiptVoucher(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addReceiptVoucher",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var _auditUser = data.callerUser;
    if (!data || !ValidationEngine.isRequired(data.date) || !ValidationEngine.isPositive(data.amount))
      return errResponse("التاريخ والمبلغ (أكبر من صفر) مطلوبان");
    // [FIX-AUDIT #2] تفعيل إعداد "الملاحظات إلزامية على الحركات"
    var _notesErr = _checkRequireNotesOnTx(data.description);
    if (_notesErr) return _notesErr;

    // تحقق من الرصيد لو نقدي
    if (data.payment_method === "CASH" && data.cash_box_id) {
      var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
      var box = cashBoxes.find(function (b) {
        return b.id === data.cash_box_id;
      });
      // سند قبض يزيد الرصيد — لا يحتاج تحقق
    }

    var id = makeId("RCV");
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]
    var voucherNum = _getNextVoucherNumber("RCV"); // [FIX-ISSUE-010]

    // [AUDIT-FIX 2.1] ربط حقيقي بـ Cheques بدل check_number/due_date الحرّين
    var _chequeLinkRCV = _resolveVoucherChequeId(
      data,
      "INCOMING",
      data.from_party,
    );
    if (!_chequeLinkRCV.ok) return errResponse(_chequeLinkRCV.message);

    var row = [
      id,
      data.date,
      voucherNum,
      data.from_party || "",
      data.party_type || "OTHER",
      data.party_id || "",
      Number(data.amount),
      data.currency || "EGP",
      data.payment_method || "CASH",
      data.cash_box_id || "",
      data.bank_account_id || "",
      "", // check_number [AUDIT-FIX 2.1 — DEPRECATED] — راجع cheque_id
      "", // due_date [AUDIT-FIX 2.1 — DEPRECATED] — راجع Cheques.due_date عبر cheque_id
      data.description || "",
      data.invoice_id || "", // [C4-FIX] ربط السند بفاتورة — ضروري لتقرير الأعمار (Aging)
      "DRAFT",
      user,
      now,
      "",
      "",
      "", // cancelled_by
      "", // cancelled_at
      _chequeLinkRCV.cheque_id || "", // [AUDIT-FIX 2.1] cheque_id
    ];

    var _rcvSheet = getSheet(
      "ReceiptVouchers",
      ACCOUNTING_HR_HEADERS.ReceiptVouchers,
    );
    _appendRowProtected(_rcvSheet, ACCOUNTING_HR_HEADERS.ReceiptVouchers, row);
    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إنشاء سند القبض بنجاح", {
      id: id,
      voucher_number: voucherNum,
    });
  } catch (e) {
    return errResponse("خطأ في إنشاء سند القبض: " + e.message);
  }
}
function updateReceiptVoucher(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [P5-A FIX] فحص الصلاحيات — كان مفقوداً تماماً، يسمح لأي طلب غير موثّق بتعديل سند
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateReceiptVoucher",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "ReceiptVouchers",
      ACCOUNTING_HR_HEADERS.ReceiptVouchers,
    );
    var rows = readSheet(
      "ReceiptVouchers",
      ACCOUNTING_HR_HEADERS.ReceiptVouchers,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("سند القبض غير موجود");
    if (rows[idx].status === "APPROVED")
      return errResponse("لا يمكن تعديل سند معتمد");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var fields = [
      "date",
      "from_party",
      "party_type",
      "party_id",
      "amount",
      "currency",
      "payment_method",
      "cash_box_id",
      "bank_account_id",
      "description",
    ];
    // [ENGINE-AUDIT / Update Engine] كان بيعمل نداء setValue منفصل لكل حقل
    // جوه loop (لحد 10 نداءات Sheets API لتعديل واحد) — استُبدل بـ
    // _applyRowUpdates الموحّدة (نداء قراءة واحد + نداء كتابة واحد).
    var _rvUpdates = {};
    fields.forEach(function (f) {
      if (data[f] !== undefined) _rvUpdates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, _rvUpdates);

    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم تحديث سند القبض بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث سند القبض: " + e.message);
  }
}
function deleteReceiptVoucher(id, callerUser, sessionToken) {
  // [P5-A FIX] كانت الدالة بدون أي فحص صلاحيات وبدون فحص حالة السند، وكانت مُدرجة
  // في DOPOST_ALLOWED_FUNCTIONS — أي طلب غير موثّق كان يمكنه حذف سند معتمد فعلياً
  // نهائياً من الشيت، تاركاً القيد المحاسبي المرتبط ورصيد الخزنة/البنك المحدَّث
  // دون أي عكس، فيختل التوازن بين الأستاذ العام والأرصدة الفعلية بصمت.
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "deleteReceiptVoucher",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet(
      "ReceiptVouchers",
      ACCOUNTING_HR_HEADERS.ReceiptVouchers,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("سند القبض غير موجود");
    var voucher = rows[idx];
    if (voucher.status === "APPROVED") {
      return errResponse(
        "لا يمكن حذف سند معتمد — استخدم إلغاء السند بدلاً من الحذف",
      );
    }

    var sheet = getSheet(
      "ReceiptVouchers",
      ACCOUNTING_HR_HEADERS.ReceiptVouchers,
    );
    sheet.deleteRow(idx + 2);
    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "ReceiptVouchers",
      record_id: id,
      details: "حذف سند قبض رقم " + (voucher.voucher_number || id)});
    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف سند القبض بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف سند القبض: " + e.message);
  }
}
function approveReceiptVoucher(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "approveReceiptVoucher",
      sessionToken,
    );
    if (_permErr) return _permErr;

    // [C-03 FIX] قفل إلزامي حول قراءة-تعديل-كتابة الرصيد لمنع تعارض اعتماد سندين متزامنين
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "ReceiptVouchers",
        ACCOUNTING_HR_HEADERS.ReceiptVouchers,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("سند القبض غير موجود");
      // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية — كان مفقوداً
      // في مسار السندات بالكامل (راجع تقرير المراجعة، ثغرة #1).
      var _periodErr = _blockIfPeriodClosed(rows[idx].date, "سند القبض");
      if (_periodErr) return _periodErr;
      // [WORKFLOW-ENGINE] التحقق عبر آلة الحالة الموحّدة "Voucher"
      // (Code_39_WorkflowEngine.gs) بدل الشرط اليدوي — نفس رسالة الرفض.
      if (!WorkflowEngine.canTransition("Voucher", rows[idx].status, "approve").allowed)
        return errResponse("لا يمكن اعتماد سند ليس مسودة");

      var sheet = getSheet(
        "ReceiptVouchers",
        ACCOUNTING_HR_HEADERS.ReceiptVouchers,
      );
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();
      var user =
        typeof _auditUser !== "undefined"
          ? _auditUser
          : typeof callerUser !== "undefined"
            ? callerUser
            : "system"; // [FIX-ISSUE-019]

      // تحديث الحالة
      var statusCol = headers.indexOf("status");
      var approvedAtCol = headers.indexOf("approved_at");
      var approvedByCol = headers.indexOf("approved_by");
      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("APPROVED");
      if (approvedAtCol !== -1)
        sheet.getRange(rowNum, approvedAtCol + 1).setValue(now);
      if (approvedByCol !== -1)
        sheet.getRange(rowNum, approvedByCol + 1).setValue(user);

      // [BUG-FIX-003] Create journal FIRST, then update balance
      // This ensures accounting integrity: if journal fails, balance stays unchanged
      var voucher = rows[idx];

      var journalCreated = false;
      try {
        _autoJournalFromReceiptVoucher(voucher, callerUser);
        journalCreated = true;
      } catch (je) {
        // [BUG-FIX-008] Log auto-journal failures instead of silently ignoring
        AuditEngine.log("AUTO_JOURNAL_FAILED", {
          user: callerUser || "SYSTEM",
          table: "JournalEntries",
          record_id: id,
          details:
            "فشل إنشاء قيد تلقائي لسند قبض " +
            voucher.voucher_number +
            ": " +
            (je.message || "خطأ غير معروف")});
        // [BUG-FIX-INTEGRITY-2026-07] كان الكود قبل كده بيكمّل ويحدّث الرصيد
        // حتى لو فشل القيد — يعني التعليق فوق ("balance stays unchanged")
        // كان غير صحيح فعليًا. دلوقتي: لو القيد فشل، نرجّع حالة السند
        // لمسودة (رول-باك) ونوقف قبل أي تحديث للرصيد أو تخصيص للفاتورة.
        if (statusCol !== -1) sheet.getRange(rowNum, statusCol + 1).setValue("DRAFT");
        if (approvedAtCol !== -1) sheet.getRange(rowNum, approvedAtCol + 1).setValue("");
        if (approvedByCol !== -1) sheet.getRange(rowNum, approvedByCol + 1).setValue("");
        return errResponse(
          "تعذر اعتماد سند القبض: فشل إنشاء القيد المحاسبي التلقائي (" +
            (je.message || "خطأ غير معروف") +
            ") — راجع ربط الحسابات في إعدادات المحاسبة (حساب الخزنة/البنك، حساب الذمم المدينة، حساب الإيرادات). السند رجع لحالة مسودة ولم يتغيّر أي رصيد.",
        );
      }

      // Update balance AFTER journal — الوصول هنا معناه القيد اتعمل بنجاح
      if (voucher.payment_method === "CASH" && voucher.cash_box_id) {
        _updateCashBoxBalance(voucher.cash_box_id, Number(voucher.amount));
      } else if (BANKLIKE_PAYMENT_METHODS.indexOf(voucher.payment_method) !== -1 && voucher.bank_account_id) {
        _updateBankAccountBalance(
          voucher.bank_account_id,
          Number(voucher.amount),
        );
      }

      // [PAYMENT-ENGINE] Payment Allocation — لو السند مرتبط بفاتورة بيع
      // محددة، حدّث paid_amount/remaining_amount عليها. اختياري تمامًا:
      // سند بدون invoice_id يفضل شغال بنفس سلوكه الحالي بدون أي تخصيص.
      if (voucher.invoice_id) {
        try {
          PaymentEngine.allocateToInvoice(
            "SaleInvoices",
            voucher.invoice_id,
            Number(voucher.amount),
          );
        } catch (allocErr) {
          console.warn("Payment allocation failed:", allocErr.message);
          // [AUDIT-FIX-PAYMENT-ALLOC-2026-08-08] فشل التخصيص هنا يعني إن
          // remaining_amount للفاتورة يفضل قديم رغم إن السند اتقبض واتعمد
          // فعليًا (القيد المحاسبي والرصيد النقدي اتحدثوا بالفعل قبل هنا) —
          // نفس نمط الظهور المرئي المطبَّق في باقي المشروع بدل console فقط.
          try {
            AuditEngine.log("PAYMENT_ALLOCATION_FAILED", {
              user: callerUser,
              table: "SaleInvoices",
              record_id: voucher.invoice_id,
              details:
                " فشل تحديث المبلغ المتبقي على الفاتورة بعد اعتماد سند القبض " +
                (voucher.voucher_number || "") +
                ": " +
                allocErr.message +
                " — يحتاج مراجعة يدوية لرصيد الفاتورة."});
          } catch (auditAllocErr) {
            console.warn("AuditLog failed:", auditAllocErr.message);
          }
        }
      }
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في اعتماد سند القبض: " + e.message);
  }
}
function cancelReceiptVoucher(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "cancelReceiptVoucher",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "ReceiptVouchers",
        ACCOUNTING_HR_HEADERS.ReceiptVouchers,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("سند القبض غير موجود");
      // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية.
      var _periodErr = _blockIfPeriodClosed(rows[idx].date, "سند القبض");
      if (_periodErr) return _periodErr;
      // [WORKFLOW-ENGINE] "cancel" غير مسموح إلا من DRAFT أو APPROVED —
      // فمن CANCELLED هيرجع false، وده بالظبط الشرط الأصلي "ملغي مسبقاً".
      if (!WorkflowEngine.canTransition("Voucher", rows[idx].status, "cancel").allowed)
        return errResponse("السند ملغي مسبقاً");

      var voucher = rows[idx];
      var sheet = getSheet(
        "ReceiptVouchers",
        ACCOUNTING_HR_HEADERS.ReceiptVouchers,
      );
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();

      // تحديث الحالة إلى CANCELLED
      var statusCol = headers.indexOf("status");
      var cancelledAtCol = headers.indexOf("cancelled_at");
      var cancelledByCol = headers.indexOf("cancelled_by");
      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("CANCELLED");
      if (cancelledAtCol !== -1)
        sheet.getRange(rowNum, cancelledAtCol + 1).setValue(now);
      if (cancelledByCol !== -1)
        sheet.getRange(rowNum, cancelledByCol + 1).setValue(callerUser);

      // لو كان معتمداً → نعكس الرصيد
      if (voucher.status === "APPROVED") {
        if (voucher.payment_method === "CASH" && voucher.cash_box_id) {
          _updateCashBoxBalance(voucher.cash_box_id, -Number(voucher.amount));
        } else if (
          BANKLIKE_PAYMENT_METHODS.indexOf(voucher.payment_method) !== -1 &&
          voucher.bank_account_id
        ) {
          _updateBankAccountBalance(
            voucher.bank_account_id,
            -Number(voucher.amount),
          );
        }

        // [P2-C FIX] إلغاء القيد المحاسبي المرتبط بالسند
        // القيد يُنشأ بـ reference = voucher_number عند الاعتماد
        _cancelJournalEntryByReference(
          voucher.voucher_number || id,
          callerUser,
        );

        // [PAYMENT-ENGINE] عكس Payment Allocation لو كان مخصَّصًا لفاتورة
        if (voucher.invoice_id) {
          try {
            PaymentEngine.allocateToInvoice(
              "SaleInvoices",
              voucher.invoice_id,
              -Number(voucher.amount),
            );
          } catch (allocErr) {
            console.warn("Payment allocation reversal failed:", allocErr.message);
            // [AUDIT-FIX-PAYMENT-ALLOC-2026-08-08] نفس مبدأ الاعتماد — فشل
            // عكس التخصيص عند الإلغاء يسيب remaining_amount غير مطابق لحالة
            // السند الملغى (القيد اتعكس بالفعل قبل هنا).
            try {
              AuditEngine.log("PAYMENT_ALLOCATION_FAILED", {
                user: callerUser,
                table: "SaleInvoices",
                record_id: voucher.invoice_id,
                details:
                  " فشل عكس المبلغ المتبقي على الفاتورة بعد إلغاء سند القبض " +
                  (voucher.voucher_number || id) +
                  ": " +
                  allocErr.message +
                  " — يحتاج مراجعة يدوية لرصيد الفاتورة."});
            } catch (auditAllocErr) {
              console.warn("AuditLog failed:", auditAllocErr.message);
            }
          }
        }
      }

      AuditEngine.log("CANCEL", {
        user: callerUser,
        table: "ReceiptVouchers",
        record_id: id,
        details: "إلغاء سند قبض رقم " + (voucher.voucher_number || id)});

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم إلغاء سند القبض بنجاح");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في إلغاء سند القبض: " + e.message);
  }
}
// [PAYMENT-ENGINE] غلاف توافق فوق PaymentEngine.adjustLedgerBalance — راجع
// Code_37_PaymentEngine.gs لسبب التوحيد. نفس الاسم/التوقيع/السلوك بالظبط،
// المنطق الفعلي بقى في مكان واحد بدل نسختين (هنا وفي CashBoxes).
function _updateBankAccountBalance(bankAccountId, amount) {
  PaymentEngine.adjustLedgerBalance("BankAccounts", bankAccountId, amount);
}
// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-07  Accounting — Payment Vouchers (سندات الصرف)
// ═══════════════════════════════════════════════════════════════════════════════

function getPaymentVouchers(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser) {
      var _permErr = _checkPermission(
        opts.callerUser,
        "viewPaymentVouchers",
        opts.sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet(
      "PaymentVouchers",
      ACCOUNTING_HR_HEADERS.PaymentVouchers,
      { trimStrings: true },
    );
    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });
    if (opts.from_date)
      rows = rows.filter(function (r) {
        return r.date >= opts.from_date;
      });
    if (opts.to_date)
      rows = rows.filter(function (r) {
        return r.date <= opts.to_date;
      });
    rows.sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب سندات الصرف: " + e.message);
  }
}
function addPaymentVoucher(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addPaymentVoucher",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var _auditUser = data.callerUser;
    if (!data || !ValidationEngine.isRequired(data.date) || !ValidationEngine.isPositive(data.amount))
      return errResponse("التاريخ والمبلغ (أكبر من صفر) مطلوبان");
    // [FIX-AUDIT #2] تفعيل إعداد "الملاحظات إلزامية على الحركات"
    var _notesErr = _checkRequireNotesOnTx(data.description);
    if (_notesErr) return _notesErr;

    // تحقق من الرصيد
    if (data.payment_method === "CASH" && data.cash_box_id) {
      var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
      var box = cashBoxes.find(function (b) {
        return b.id === data.cash_box_id;
      });
      if (box && Number(box.current_balance || 0) < Number(data.amount))
        return errResponse(
          "رصيد الخزنة غير كافي (الرصيد: " + box.current_balance + ")",
        );
    } else if (BANKLIKE_PAYMENT_METHODS.indexOf(data.payment_method) !== -1 && data.bank_account_id) {
      var banks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
      var bank = banks.find(function (b) {
        return b.id === data.bank_account_id;
      });
      if (bank && Number(bank.current_balance || 0) < Number(data.amount))
        return errResponse(
          "رصيد البنك غير كافي (الرصيد: " + bank.current_balance + ")",
        );
    }

    var id = makeId("PAY");
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]
    var voucherNum = _getNextVoucherNumber("PAY"); // [FIX-ISSUE-010]

    // [AUDIT-FIX 2.1] ربط حقيقي بـ Cheques بدل check_number/due_date الحرّين
    var _chequeLinkPAY = _resolveVoucherChequeId(data, "OUTGOING", data.to_party);
    if (!_chequeLinkPAY.ok) return errResponse(_chequeLinkPAY.message);

    var row = [
      id,
      data.date,
      voucherNum,
      data.to_party || "",
      data.party_type || "OTHER",
      data.party_id || "",
      Number(data.amount),
      data.currency || "EGP",
      data.payment_method || "CASH",
      data.cash_box_id || "",
      data.bank_account_id || "",
      "", // check_number [AUDIT-FIX 2.1 — DEPRECATED] — راجع cheque_id
      "", // due_date [AUDIT-FIX 2.1 — DEPRECATED]
      data.description || "",
      "DRAFT",
      user,
      now,
      "",
      "",
      data.invoice_id || "", // [PAYMENT-ENGINE] ربط اختياري بفاتورة شراء
      "", // cancelled_by
      "", // cancelled_at
      _chequeLinkPAY.cheque_id || "", // [AUDIT-FIX 2.1] cheque_id
    ];

    var _paySheet = getSheet(
      "PaymentVouchers",
      ACCOUNTING_HR_HEADERS.PaymentVouchers,
    );
    _appendRowProtected(_paySheet, ACCOUNTING_HR_HEADERS.PaymentVouchers, row);
    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إنشاء سند الصرف بنجاح", {
      id: id,
      voucher_number: voucherNum,
    });
  } catch (e) {
    return errResponse("خطأ في إنشاء سند الصرف: " + e.message);
  }
}
function updatePaymentVoucher(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [P5-A FIX] فحص الصلاحيات — كان مفقوداً تماماً
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updatePaymentVoucher",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "PaymentVouchers",
      ACCOUNTING_HR_HEADERS.PaymentVouchers,
    );
    var rows = readSheet(
      "PaymentVouchers",
      ACCOUNTING_HR_HEADERS.PaymentVouchers,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("سند الصرف غير موجود");
    if (rows[idx].status === "APPROVED")
      return errResponse("لا يمكن تعديل سند معتمد");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var fields = [
      "date",
      "to_party",
      "party_type",
      "party_id",
      "amount",
      "currency",
      "payment_method",
      "cash_box_id",
      "bank_account_id",
      "description",
    ];
    // [ENGINE-AUDIT / Update Engine] استُبدل loop الـ setValue المنفصل بـ
    // _applyRowUpdates الموحّدة — نفس مبدأ الإصلاح في updateReceiptVoucher.
    var _pvUpdates = {};
    fields.forEach(function (f) {
      if (data[f] !== undefined) _pvUpdates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, _pvUpdates);

    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم تحديث سند الصرف بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث سند الصرف: " + e.message);
  }
}
function deletePaymentVoucher(id, callerUser, sessionToken) {
  // [P5-A FIX] نفس مشكلة deleteReceiptVoucher: بدون فحص صلاحيات وبدون فحص حالة
  // السند رغم وجودها في DOPOST_ALLOWED_FUNCTIONS — تُصحَّح بنفس النمط.
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "deletePaymentVoucher",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet(
      "PaymentVouchers",
      ACCOUNTING_HR_HEADERS.PaymentVouchers,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("سند الصرف غير موجود");
    var voucher = rows[idx];
    if (voucher.status === "APPROVED") {
      return errResponse(
        "لا يمكن حذف سند معتمد — استخدم إلغاء السند بدلاً من الحذف",
      );
    }

    var sheet = getSheet(
      "PaymentVouchers",
      ACCOUNTING_HR_HEADERS.PaymentVouchers,
    );
    sheet.deleteRow(idx + 2);
    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "PaymentVouchers",
      record_id: id,
      details: "حذف سند صرف رقم " + (voucher.voucher_number || id)});
    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف سند الصرف بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف سند الصرف: " + e.message);
  }
}
function approvePaymentVoucher(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "approvePaymentVoucher",
      sessionToken,
    );
    if (_permErr) return _permErr;

    // [C-03 FIX] القفل يجب أن يشمل فحص الرصيد + التحديث معاً، وإلا فسندان متزامنان
    // قد يتجاوزا فحص "الرصيد كافي" قبل أن يخصم أي منهما
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "PaymentVouchers",
        ACCOUNTING_HR_HEADERS.PaymentVouchers,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("سند الصرف غير موجود");
      // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية.
      var _periodErr = _blockIfPeriodClosed(rows[idx].date, "سند الصرف");
      if (_periodErr) return _periodErr;
      // [WORKFLOW-ENGINE] التحقق عبر آلة الحالة الموحّدة "Voucher".
      if (!WorkflowEngine.canTransition("Voucher", rows[idx].status, "approve").allowed)
        return errResponse("لا يمكن اعتماد سند ليس مسودة");

      var voucher = rows[idx];

      // تحقق من الرصيد مرة أخرى (داخل القفل لضمان عدم تجاوزه من سند متزامن)
      if (voucher.payment_method === "CASH" && voucher.cash_box_id) {
        var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
        var box = cashBoxes.find(function (b) {
          return b.id === voucher.cash_box_id;
        });
        if (box && Number(box.current_balance || 0) < Number(voucher.amount))
          return errResponse("رصيد الخزنة غير كافي");
      } else if (BANKLIKE_PAYMENT_METHODS.indexOf(voucher.payment_method) !== -1 && voucher.bank_account_id) {
        var banks = readSheet(
          "BankAccounts",
          ACCOUNTING_HR_HEADERS.BankAccounts,
        );
        var bank = banks.find(function (b) {
          return b.id === voucher.bank_account_id;
        });
        if (bank && Number(bank.current_balance || 0) < Number(voucher.amount))
          return errResponse("رصيد البنك غير كافي");
      }

      var sheet = getSheet(
        "PaymentVouchers",
        ACCOUNTING_HR_HEADERS.PaymentVouchers,
      );
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();
      var user =
        typeof _auditUser !== "undefined"
          ? _auditUser
          : typeof callerUser !== "undefined"
            ? callerUser
            : "system"; // [FIX-ISSUE-019]

      var statusCol = headers.indexOf("status");
      var approvedAtCol = headers.indexOf("approved_at");
      var approvedByCol = headers.indexOf("approved_by");
      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("APPROVED");
      if (approvedAtCol !== -1)
        sheet.getRange(rowNum, approvedAtCol + 1).setValue(now);
      if (approvedByCol !== -1)
        sheet.getRange(rowNum, approvedByCol + 1).setValue(user);

      // [BUG-FIX-003] Create journal FIRST, then update balance
      try {
        _autoJournalFromPaymentVoucher(voucher, callerUser);
      } catch (je) {
        AuditEngine.log("AUTO_JOURNAL_FAILED", {
          user: callerUser || "SYSTEM",
          table: "JournalEntries",
          record_id: id,
          details:
            "فشل إنشاء قيد تلقائي لسند صرف " +
            voucher.voucher_number +
            ": " +
            (je.message || "خطأ غير معروف")});
        // [BUG-FIX-INTEGRITY-2026-07] نفس إصلاح سند القبض: لو القيد فشل،
        // نرجّع حالة السند لمسودة ونوقف قبل نقص الرصيد أو تخصيص الفاتورة —
        // بدل ما نكمل ونخصم الرصيد بدون قيد محاسبي مقابل.
        if (statusCol !== -1) sheet.getRange(rowNum, statusCol + 1).setValue("DRAFT");
        if (approvedAtCol !== -1) sheet.getRange(rowNum, approvedAtCol + 1).setValue("");
        if (approvedByCol !== -1) sheet.getRange(rowNum, approvedByCol + 1).setValue("");
        return errResponse(
          "تعذر اعتماد سند الصرف: فشل إنشاء القيد المحاسبي التلقائي (" +
            (je.message || "خطأ غير معروف") +
            ") — راجع ربط الحسابات في إعدادات المحاسبة. السند رجع لحالة مسودة ولم يتغيّر أي رصيد.",
        );
      }

      // نقص الرصيد AFTER journal — الوصول هنا معناه القيد اتعمل بنجاح
      if (voucher.payment_method === "CASH" && voucher.cash_box_id) {
        _updateCashBoxBalance(voucher.cash_box_id, -Number(voucher.amount));
      } else if (BANKLIKE_PAYMENT_METHODS.indexOf(voucher.payment_method) !== -1 && voucher.bank_account_id) {
        _updateBankAccountBalance(
          voucher.bank_account_id,
          -Number(voucher.amount),
        );
      }

      // [PAYMENT-ENGINE] Payment Allocation — لو السند مرتبط بفاتورة شراء
      if (voucher.invoice_id) {
        try {
          PaymentEngine.allocateToInvoice(
            "PurchaseInvoices",
            voucher.invoice_id,
            Number(voucher.amount),
          );
        } catch (allocErr) {
          console.warn("Payment allocation failed:", allocErr.message);
          try {
            AuditEngine.log("PAYMENT_ALLOCATION_FAILED", {
              user: callerUser,
              table: "PurchaseInvoices",
              record_id: voucher.invoice_id,
              details:
                " فشل تحديث المبلغ المتبقي على فاتورة الشراء بعد اعتماد سند الصرف " +
                (voucher.voucher_number || "") +
                ": " +
                allocErr.message +
                " — يحتاج مراجعة يدوية لرصيد الفاتورة."});
          } catch (auditAllocErr) {
            console.warn("AuditLog failed:", auditAllocErr.message);
          }
        }
      }

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم اعتماد سند الصرف بنجاح");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في اعتماد سند الصرف: " + e.message);
  }
}
function cancelPaymentVoucher(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "cancelPaymentVoucher",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "PaymentVouchers",
        ACCOUNTING_HR_HEADERS.PaymentVouchers,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("سند الصرف غير موجود");
      // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية.
      var _periodErr = _blockIfPeriodClosed(rows[idx].date, "سند الصرف");
      if (_periodErr) return _periodErr;
      // [WORKFLOW-ENGINE] "cancel" غير مسموح إلا من DRAFT أو APPROVED.
      if (!WorkflowEngine.canTransition("Voucher", rows[idx].status, "cancel").allowed)
        return errResponse("السند ملغي مسبقاً");

      var voucher = rows[idx];
      var sheet = getSheet(
        "PaymentVouchers",
        ACCOUNTING_HR_HEADERS.PaymentVouchers,
      );
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();

      var statusCol = headers.indexOf("status");
      var cancelledAtCol = headers.indexOf("cancelled_at");
      var cancelledByCol = headers.indexOf("cancelled_by");
      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("CANCELLED");
      if (cancelledAtCol !== -1)
        sheet.getRange(rowNum, cancelledAtCol + 1).setValue(now);
      if (cancelledByCol !== -1)
        sheet.getRange(rowNum, cancelledByCol + 1).setValue(callerUser);

      // لو كان معتمداً → نعكس الرصيد (نُرجع المبلغ للخزنة/البنك)
      if (voucher.status === "APPROVED") {
        if (voucher.payment_method === "CASH" && voucher.cash_box_id) {
          _updateCashBoxBalance(voucher.cash_box_id, Number(voucher.amount));
        } else if (
          BANKLIKE_PAYMENT_METHODS.indexOf(voucher.payment_method) !== -1 &&
          voucher.bank_account_id
        ) {
          _updateBankAccountBalance(
            voucher.bank_account_id,
            Number(voucher.amount),
          );
        }

        // [P2-C FIX] إلغاء القيد المحاسبي المرتبط بالسند
        _cancelJournalEntryByReference(
          voucher.voucher_number || id,
          callerUser,
        );

        // [PAYMENT-ENGINE] عكس Payment Allocation لو كان مخصَّصًا لفاتورة شراء
        if (voucher.invoice_id) {
          try {
            PaymentEngine.allocateToInvoice(
              "PurchaseInvoices",
              voucher.invoice_id,
              -Number(voucher.amount),
            );
          } catch (allocErr) {
            console.warn("Payment allocation reversal failed:", allocErr.message);
            try {
              AuditEngine.log("PAYMENT_ALLOCATION_FAILED", {
                user: callerUser,
                table: "PurchaseInvoices",
                record_id: voucher.invoice_id,
                details:
                  " فشل عكس المبلغ المتبقي على فاتورة الشراء بعد إلغاء سند الصرف " +
                  (voucher.voucher_number || id) +
                  ": " +
                  allocErr.message +
                  " — يحتاج مراجعة يدوية لرصيد الفاتورة."});
            } catch (auditAllocErr) {
              console.warn("AuditLog failed:", auditAllocErr.message);
            }
          }
        }
      }

      AuditEngine.log("CANCEL", {
        user: callerUser,
        table: "PaymentVouchers",
        record_id: id,
        details: "إلغاء سند صرف رقم " + (voucher.voucher_number || id)});

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم إلغاء سند الصرف بنجاح");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في إلغاء سند الصرف: " + e.message);
  }
}
// ═══════════════════════════════════════════════════════════════
// §AC-06b  Expenses — المصروفات
// ═══════════════════════════════════════════════════════════════

function getExpenses(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser) {
      var _permErr = _checkPermission(
        opts.callerUser,
        "viewExpenses",
        opts.sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses, {
      trimStrings: true,
    });
    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });
    if (opts.from_date)
      rows = rows.filter(function (r) {
        return r.date >= opts.from_date;
      });
    if (opts.to_date)
      rows = rows.filter(function (r) {
        return r.date <= opts.to_date;
      });
    rows.sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب المصروفات: " + e.message);
  }
}
function addExpense(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addExpense",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!ValidationEngine.isRequired(data.date) || !ValidationEngine.isPositive(data.amount) || !ValidationEngine.isRequired(data.account_id))
      return errResponse("التاريخ والحساب والمبلغ (أكبر من صفر) مطلوبون");

    // [ACCOUNTING-LOOKUP-UNIFY] فحص موحد: الحساب موجود/نشط/غير محذوف/غير تجميعي
    if (typeof validateAccountingFieldValue === "function") {
      var _accErr = validateAccountingFieldValue(data.account_id, {
        required: true,
      });
      if (_accErr) return errResponse(_accErr);
    }

    // تحقق من الرصيد
    if (data.payment_method === "CASH" && data.cash_box_id) {
      var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
      var box = cashBoxes.find(function (b) {
        return b.id === data.cash_box_id;
      });
      if (box && Number(box.current_balance || 0) < Number(data.amount))
        return errResponse(
          "رصيد الخزنة غير كافي (الرصيد: " + box.current_balance + ")",
        );
    } else if (BANKLIKE_PAYMENT_METHODS.indexOf(data.payment_method) !== -1 && data.bank_account_id) {
      var banks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
      var bank = banks.find(function (b) {
        return b.id === data.bank_account_id;
      });
      if (bank && Number(bank.current_balance || 0) < Number(data.amount))
        return errResponse(
          "رصيد البنك غير كافي (الرصيد: " + bank.current_balance + ")",
        );
    }

    var id = makeId("EXP");
    var now = new Date().toISOString();
    var voucherNum = _getNextVoucherNumber("EXP");

    var row = [
      id,
      data.date,
      voucherNum,
      data.account_id,
      Number(data.amount),
      data.currency || "EGP",
      data.payment_method || "CASH",
      data.cash_box_id || "",
      data.bank_account_id || "",
      data.description || "",
      "DRAFT",
      data.callerUser,
      now,
      "",
      "",
      "",
      "",
    ];

    var _expSheet = getSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses);
    _appendRowProtected(_expSheet, ACCOUNTING_HR_HEADERS.Expenses, row);
    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إنشاء المصروف بنجاح", {
      id: id,
      voucher_number: voucherNum,
    });
  } catch (e) {
    return errResponse("خطأ في إنشاء المصروف: " + e.message);
  }
}
function updateExpense(id, data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateExpense",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses);
    var rows = readSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("المصروف غير موجود");
    if (rows[idx].status === "APPROVED")
      return errResponse("لا يمكن تعديل مصروف معتمد");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var fields = [
      "date",
      "account_id",
      "amount",
      "currency",
      "payment_method",
      "cash_box_id",
      "bank_account_id",
      "description",
    ];
    // [ENGINE-AUDIT / Update Engine] استُبدل loop الـ setValue المنفصل بـ
    // _applyRowUpdates الموحّدة — نفس مبدأ إصلاح سندات القبض/الصرف فوق.
    var _expUpdates = {};
    fields.forEach(function (f) {
      if (data[f] !== undefined) _expUpdates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, _expUpdates);

    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم تحديث المصروف بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث المصروف: " + e.message);
  }
}
function deleteExpense(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "deleteExpense", sessionToken);
    if (_permErr) return _permErr;

    var rows = readSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("المصروف غير موجود");
    if (rows[idx].status === "APPROVED")
      return errResponse("لا يمكن حذف مصروف معتمد — قم بإلغائه أولاً");

    var sheet = getSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses);
    sheet.deleteRow(idx + 2);
    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف المصروف بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف المصروف: " + e.message);
  }
}
function approveExpense(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "approveExpense", sessionToken);
    if (_permErr) return _permErr;

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses, {
        trimStrings: true,
      });
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("المصروف غير موجود");
      // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية.
      var _periodErr = _blockIfPeriodClosed(rows[idx].date, "المصروف");
      if (_periodErr) return _periodErr;
      // [WORKFLOW-ENGINE] التحقق عبر آلة الحالة الموحّدة "Voucher".
      if (!WorkflowEngine.canTransition("Voucher", rows[idx].status, "approve").allowed)
        return errResponse("لا يمكن اعتماد مصروف ليس مسودة");

      var expense = rows[idx];

      // تحقق من الرصيد مرة أخرى (داخل القفل)
      if (expense.payment_method === "CASH" && expense.cash_box_id) {
        var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
        var box = cashBoxes.find(function (b) {
          return b.id === expense.cash_box_id;
        });
        if (box && Number(box.current_balance || 0) < Number(expense.amount))
          return errResponse("رصيد الخزنة غير كافي");
      } else if (BANKLIKE_PAYMENT_METHODS.indexOf(expense.payment_method) !== -1 && expense.bank_account_id) {
        var banks = readSheet(
          "BankAccounts",
          ACCOUNTING_HR_HEADERS.BankAccounts,
        );
        var bank = banks.find(function (b) {
          return b.id === expense.bank_account_id;
        });
        if (bank && Number(bank.current_balance || 0) < Number(expense.amount))
          return errResponse("رصيد البنك غير كافي");
      }

      var sheet = getSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses);
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();

      var statusCol = headers.indexOf("status");
      var approvedAtCol = headers.indexOf("approved_at");
      var approvedByCol = headers.indexOf("approved_by");
      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("APPROVED");
      if (approvedAtCol !== -1)
        sheet.getRange(rowNum, approvedAtCol + 1).setValue(now);
      if (approvedByCol !== -1)
        sheet.getRange(rowNum, approvedByCol + 1).setValue(callerUser);

      // إنشاء القيد التلقائي أولاً، ثم خصم الرصيد
      try {
        _autoJournalFromExpense(expense, callerUser);
      } catch (je) {
        AuditEngine.log("AUTO_JOURNAL_FAILED", {
          user: callerUser || "SYSTEM",
          table: "JournalEntries",
          record_id: id,
          details:
            "فشل إنشاء قيد تلقائي لمصروف " +
            expense.voucher_number +
            ": " +
            (je.message || "خطأ غير معروف")});
      }

      if (expense.payment_method === "CASH" && expense.cash_box_id) {
        _updateCashBoxBalance(expense.cash_box_id, -Number(expense.amount));
      } else if (BANKLIKE_PAYMENT_METHODS.indexOf(expense.payment_method) !== -1 && expense.bank_account_id) {
        _updateBankAccountBalance(
          expense.bank_account_id,
          -Number(expense.amount),
        );
      }

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم اعتماد المصروف بنجاح");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في اعتماد المصروف: " + e.message);
  }
}
function cancelExpense(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "cancelExpense", sessionToken);
    if (_permErr) return _permErr;

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses, {
        trimStrings: true,
      });
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("المصروف غير موجود");
      // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية.
      var _periodErr = _blockIfPeriodClosed(rows[idx].date, "المصروف");
      if (_periodErr) return _periodErr;
      // [WORKFLOW-ENGINE] "cancel" غير مسموح إلا من DRAFT أو APPROVED.
      if (!WorkflowEngine.canTransition("Voucher", rows[idx].status, "cancel").allowed)
        return errResponse("المصروف ملغي مسبقاً");

      var expense = rows[idx];
      var sheet = getSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses);
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();

      var statusCol = headers.indexOf("status");
      var cancelledAtCol = headers.indexOf("cancelled_at");
      var cancelledByCol = headers.indexOf("cancelled_by");
      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("CANCELLED");
      if (cancelledAtCol !== -1)
        sheet.getRange(rowNum, cancelledAtCol + 1).setValue(now);
      if (cancelledByCol !== -1)
        sheet.getRange(rowNum, cancelledByCol + 1).setValue(callerUser);

      // لو كان معتمداً → نعكس الرصيد
      if (expense.status === "APPROVED") {
        if (expense.payment_method === "CASH" && expense.cash_box_id) {
          _updateCashBoxBalance(expense.cash_box_id, Number(expense.amount));
        } else if (
          BANKLIKE_PAYMENT_METHODS.indexOf(expense.payment_method) !== -1 &&
          expense.bank_account_id
        ) {
          _updateBankAccountBalance(
            expense.bank_account_id,
            Number(expense.amount),
          );
        }
      }

      AuditEngine.log("CANCEL", {
        user: callerUser,
        table: "Expenses",
        record_id: id,
        details: "إلغاء مصروف رقم " + (expense.voucher_number || id)});

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم إلغاء المصروف بنجاح");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في إلغاء المصروف: " + e.message);
  }
}
/**
 * [NEW] _autoJournalFromTransferVoucher — creates automatic journal entry for transfer vouchers
 * Transfer: Debit "To" account, Credit "From" account
 */
function cancelTransferVoucher(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "cancelTransferVoucher",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "TransferVouchers",
        ACCOUNTING_HR_HEADERS.TransferVouchers,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("سند التحويل غير موجود");
      // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية.
      var _periodErr = _blockIfPeriodClosed(rows[idx].date, "سند التحويل");
      if (_periodErr) return _periodErr;
      if (rows[idx].status === "CANCELLED")
        return errResponse("السند ملغي مسبقاً");

      var voucher = rows[idx];
      var sheet = getSheet(
        "TransferVouchers",
        ACCOUNTING_HR_HEADERS.TransferVouchers,
      );
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();

      var statusCol = headers.indexOf("status");
      var cancelledAtCol = headers.indexOf("cancelled_at");
      var cancelledByCol = headers.indexOf("cancelled_by");
      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("CANCELLED");
      if (cancelledAtCol !== -1)
        sheet.getRange(rowNum, cancelledAtCol + 1).setValue(now);
      if (cancelledByCol !== -1)
        sheet.getRange(rowNum, cancelledByCol + 1).setValue(callerUser);

      // لو كان معتمداً → نعكس حركة الأرصدة
      if (voucher.status === "APPROVED") {
        // نرجع المبلغ للمصدر
        if (voucher.from_type === "CASHBOX") {
          _updateCashBoxBalance(voucher.from_id, Number(voucher.amount));
        } else if (voucher.from_type === "BANK") {
          _updateBankAccountBalance(voucher.from_id, Number(voucher.amount));
        }
        // ننقص من الهدف
        if (voucher.to_type === "CASHBOX") {
          _updateCashBoxBalance(voucher.to_id, -Number(voucher.amount));
        } else if (voucher.to_type === "BANK") {
          _updateBankAccountBalance(voucher.to_id, -Number(voucher.amount));
        }
      }

      AuditEngine.log("CANCEL", {
        user: callerUser,
        table: "TransferVouchers",
        record_id: id,
        details: "إلغاء سند تحويل رقم " + (voucher.voucher_number || id)});

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم إلغاء سند التحويل بنجاح");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في إلغاء سند التحويل: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// printVoucher — [VERCEL-MIGRATION][AUDIT-2] كانت متنادية من الفرونت
// (11_JS_Accounting.html → _printVoucher) بس مالهاش أي تعريف في الباك
// إند خالص — زر طباعة السند كان معطّل فعليًا حتى على نسخة الويب.
//
// بتاخد نفس الـ 3 dataKey اللي بيبعتها الفرونت ("receiptVouchers"،
// "paymentVouchers"، "expenses")، وبتولّد PDF حقيقي عبر نفس آلية
// Google Docs export الموجودة أصلاً في Code_21_Setup.js (_htmlToPdf +
// _uploadPdfToDrive) — بدون تكرار منطق جديد. الفرونت متوقع
// { success:true, data:{ url: "..." } } (راجع _printVoucher في
// 11_JS_Accounting.html: بيعمل window.open(res.url)).
// ─────────────────────────────────────────────────────────────
// [FIX] كانت معرّفة كـ object ثابت بيتنفذ فورًا وقت تحميل الملف
// (module scope) — ده كان بيسبب بالظبط نفس مشكلة FixedAssets الموثقة
// تحت في تعليق Code_14: ترتيب تحميل ملفات GAS أبجدي، وCode_06 بيتحمل
// قبل Code_12_Core.js اللي فيه تعريف ACCOUNTING_HR_HEADERS (const) —
// فكان بيرمي ReferenceError: ACCOUNTING_HR_HEADERS is not defined
// ويكسر تحميل المشروع كله. الحل: تحويلها لدالة (lazy) بتتنفذ وقت
// الاستدعاء الفعلي من printVoucher، مش وقت تحميل الملف.
function _getPrintVoucherConfig() {
  return {
    receiptVouchers: {
      sheet: "ReceiptVouchers",
      headers: ACCOUNTING_HR_HEADERS.ReceiptVouchers,
      perm: "viewReceiptVouchers",
      title: "سند قبض",
      partyLabel: "استلمنا من السيد/السادة",
      partyField: "from_party",
    },
    paymentVouchers: {
      sheet: "PaymentVouchers",
      headers: ACCOUNTING_HR_HEADERS.PaymentVouchers,
      perm: "viewPaymentVouchers",
      title: "سند صرف",
      partyLabel: "صرفنا إلى السيد/السادة",
      partyField: "to_party",
    },
    expenses: {
      sheet: "Expenses",
      headers: ACCOUNTING_HR_HEADERS.Expenses,
      perm: "viewExpenses",
      title: "سند مصروفات",
      partyLabel: "بيان المصروف",
      partyField: "description",
    },
  };
}

function _pvResolvePaymentSourceLabel(voucher) {
  // اسم الخزينة/البنك للعرض على السند — بدون كسر لو الحقل فاضي
  try {
    if (voucher.cash_box_id) {
      var boxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
      var box = boxes.find(function (b) {
        return b.id === voucher.cash_box_id;
      });
      if (box) return box.name || voucher.cash_box_id;
    }
    if (voucher.bank_account_id) {
      var banks = readSheet(
        "BankAccounts",
        ACCOUNTING_HR_HEADERS.BankAccounts,
      );
      var bank = banks.find(function (b) {
        return b.id === voucher.bank_account_id;
      });
      if (bank) return bank.name || voucher.bank_account_id;
    }
  } catch (e) {
    Logger.log("[silent-catch] _pvResolvePaymentSourceLabel: " + e.message);
  }
  return voucher.payment_method || "";
}

function _pvBuildVoucherHtml(cfg, voucher) {
  var co = {};
  try {
    co = _getCompanySettingsRaw() || {};
  } catch (e) {
    co = {};
  }
  var companyName = co.company_name || co.name || "MOO.ERP";
  var currency = voucher.currency || "EGP";
  var amountNum = Number(voucher.amount) || 0;
  var amountFmt = amountNum.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  var partyValue = voucher[cfg.partyField] || "-";
  var sourceLabel = _pvResolvePaymentSourceLabel(voucher);

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) {
      return (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c
      );
    });
  }

  return (
    '<html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>' +
    "body{font-family:Arial,Tahoma,sans-serif;padding:24px;color:#111}" +
    ".pv-head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:20px}" +
    ".pv-title{font-size:22px;font-weight:bold}" +
    ".pv-co{font-size:14px;color:#444}" +
    ".pv-row{display:flex;justify-content:space-between;margin:10px 0;font-size:14px}" +
    ".pv-amount{font-size:20px;font-weight:bold;margin:16px 0;padding:10px;border:1px solid #111;text-align:center}" +
    ".pv-desc{margin-top:16px;font-size:13px;line-height:1.8}" +
    ".pv-sign{display:flex;justify-content:space-between;margin-top:60px;font-size:13px}" +
    "</style></head><body>" +
    '<div class="pv-head"><div class="pv-title">' +
    esc(cfg.title) +
    '</div><div class="pv-co">' +
    esc(companyName) +
    "</div></div>" +
    '<div class="pv-row"><span>رقم السند: ' +
    esc(voucher.voucher_number || voucher.id) +
    "</span><span>التاريخ: " +
    esc(voucher.date) +
    "</span></div>" +
    '<div class="pv-row"><span>' +
    esc(cfg.partyLabel) +
    ": " +
    esc(partyValue) +
    "</span></div>" +
    '<div class="pv-amount">' +
    esc(amountFmt) +
    " " +
    esc(currency) +
    "</div>" +
    '<div class="pv-row"><span>طريقة الدفع/المصدر: ' +
    esc(sourceLabel) +
    "</span></div>" +
    '<div class="pv-desc">البيان: ' +
    esc(voucher.description || "-") +
    "</div>" +
    '<div class="pv-sign"><div>توقيع المستلم: ________________</div><div>توقيع المحاسب: ________________</div></div>' +
    "</body></html>"
  );
}

function printVoucher(id, dataKey, callerUser, sessionToken) {
  try {
    var cfg = _getPrintVoucherConfig()[dataKey];
    if (!cfg) return errResponse("نوع سند غير معروف: " + dataKey);

    var _permErr = _checkPermission(callerUser, cfg.perm, sessionToken);
    if (_permErr) return _permErr;

    var rows = readSheet(cfg.sheet, cfg.headers, { trimStrings: true });
    var voucher = rows.find(function (r) {
      return r.id === id;
    });
    if (!voucher) return errResponse("السند غير موجود");

    var html = _pvBuildVoucherHtml(cfg, voucher);
    var fileName = cfg.title + "-" + (voucher.voucher_number || voucher.id);
    var pdfBlob = _htmlToPdf(html, fileName);
    var driveFile = _uploadPdfToDrive(pdfBlob);

    AuditEngine.log("PRINT", {
      user: callerUser,
      table: cfg.sheet,
      record_id: id,
      details: "طباعة " + cfg.title + " رقم " + (voucher.voucher_number || id),
    });

    return okResponse("تم تجهيز السند للطباعة", {
      url: driveFile.getUrl(),
    });
  } catch (e) {
    return errResponse("خطأ في تجهيز السند للطباعة: " + e.message);
  }
}
