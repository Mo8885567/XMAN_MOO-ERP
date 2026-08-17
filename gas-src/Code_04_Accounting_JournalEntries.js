// ════════════════════════════════════════════════════════════════
// Code_Accounting_JournalEntries.gs — [REFACTOR-P4] نُقل من Code_Accounting.gs (نقل نصي بحت،
// صفر تغيير في المنطق أو الترتيب الداخلي بين الدوال). Apps Script يعامل
// كل ملفات .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء
// من أي ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// راجع تقرير Architecture Audit 2026-07-03 — المرحلة 4، قسم 4-ب.
//
// المسؤولية: القيود اليومية (Journal Entries) — CRUD + الترحيل + كل دوال auto-journal (القيد التلقائي من مبيعات/مشتريات/إنتاج/تحويل مخزون/مرتجعات/سندات/مصروفات/تكلفة بضاعة مباعة)
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-05  Accounting — Journal Entries (القيود اليومية)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * validateJournalEntry — التحقق من القيد المزدوج
 */
function _validateJournalEntry(entry) {
  if (!entry.lines || entry.lines.length < 2)
    return "القيد يجب أن يحتوي على سطرين على الأقل";

  // لا تسمح بتحويل القيم غير الرقمية إلى صفر بصمت عبر Number()؛ فهذا كان
  // يسمح بحفظ قيد صفري أو قيد يحتوي NaN ثم تمريره إلى الترحيل.
  var invalidAmount = entry.lines.some(function (l) {
    var debit = Number(l.debit || 0);
    var credit = Number(l.credit || 0);
    return !isFinite(debit) || !isFinite(credit) || debit < 0 || credit < 0;
  });
  if (invalidAmount)
    return "يجب أن تكون مبالغ المدين والدائن أرقاماً موجبة أو صفراً";

  var totalDebit = entry.lines.reduce(function (a, l) {
    return a + Number(l.debit || 0);
  }, 0);
  var totalCredit = entry.lines.reduce(function (a, l) {
    return a + Number(l.credit || 0);
  }, 0);

  if (Math.abs(totalDebit - totalCredit) > 0.001)
    return (
      "إجمالي المدين (" +
      totalDebit.toFixed(2) +
      ") لا يساوي إجمالي الدائن (" +
      totalCredit.toFixed(2) +
      ")"
    );

  if (totalDebit <= 0)
    return "لا يجوز إنشاء قيد صفري؛ يجب أن يكون إجمالي المدين والدائن أكبر من صفر";

  // تحقق من عدم وجود سطر بدون حساب
  var emptyAccount = entry.lines.some(function (l) {
    return !l.account_id;
  });
  if (emptyAccount) return "جميع سطور القيد يجب أن تحتوي على حساب";

  // تحقق من عدم وجود سطر مدين ودائن معاً
  var invalidLine = entry.lines.some(function (l) {
    var debit = Number(l.debit || 0);
    var credit = Number(l.credit || 0);
    return (debit > 0 && credit > 0) || (debit <= 0 && credit <= 0);
  });
  if (invalidLine)
    return "كل سطر يجب أن يكون إما مديناً أو دائناً بمبلغ أكبر من صفر، وليس صفراً أو كليهما";

  return null;
}
function getJournalEntries(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser) {
      var _permErr = _checkPermission(
        opts.callerUser,
        "viewJournalEntries",
        opts.sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );

    // فلترة
    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });
    if (opts.source_type)
      rows = rows.filter(function (r) {
        return r.source_type === opts.source_type;
      });
    if (opts.from_date) {
      rows = rows.filter(function (r) {
        return r.date >= opts.from_date;
      });
    }
    if (opts.to_date) {
      rows = rows.filter(function (r) {
        return r.date <= opts.to_date;
      });
    }

    // ترتيب حسب التاريخ تنازلي
    rows.sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });

    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب القيود: " + e.message);
  }
}
/**
 * [ACCOUNTING-ENGINE] _addJournalEntryInternalOriginal
 * دالة داخلية لإنشاء قيود يومية تلقائية من داخل النظام (بدون auth check).
 * تُستخدم فقط من قِبل دوال autoJournal الداخلية — لا تُكشف للـ API.
 * المستخدم يُخزَّن كـ "SYSTEM:callerUser" أو "SYSTEM" للقيود التلقائية.
 *
 * [FIX-RECURSION] هذه الدالة كانت معرّفة باسم _addJournalEntryInternal،
 * وبسبب تكرار اسم الدالة مع الـ wrapper الموجود في §P2-05 (hoisting في JS
 * يجعل آخر تعريف بنفس الاسم في الملف هو الفعلي)، كان السطر:
 *   var _addJournalEntryInternalOriginal = _addJournalEntryInternal;
 * يُنشئ مرجعاً ذاتياً (self-reference) لنفس الـ wrapper بدل الدالة الأصلية،
 * مما يتسبب في recursion لا نهائي ("Maximum call stack size exceeded")
 * عند كل استدعاء — أي أن كل قيد تلقائي في النظام (أرصدة افتتاحية للخزائن
 * والبنوك، تكلفة البضاعة المباعة COGS، ترحيل الفواتير، تسويات الجرد، ...)
 * كان يفشل بصمت (يُمسَك الخطأ في try/catch المستدعي ولا يظهر للمستخدم).
 * الحل: تسمية هذه الدالة باسمها الصريح مباشرةً بدل الاعتماد على var capture.
 */
/**
 * [FIX-AUDIT-2026 #2/#3/#6] _validateJournalAccountLines
 * فحص موحّد لسطور القيد يُستخدم من كل مسارات الإنشاء/التعديل (يدوية وتلقائية):
 *  - كل سطر يحتوي على account_id
 *  - الحساب موجود وغير محذوف (Soft Delete)
 *  - [FIX جديد] الحساب ليس حساباً تجميعياً (is_parent) — الترحيل ممنوع على
 *    الحسابات الأب لأن ذلك يكسر منطقياً هيكلة شجرة الحسابات (راجع تقرير
 *    المراجعة المحاسبية — المرحلة 2 والمرحلة 3، الثغرة #2)
 * كانت هذه الفحوصات مكررة بشكل منفصل (وغير متطابق) في addJournalEntry،
 * _addJournalEntryInternalOriginal، وكانت غائبة تماماً من updateJournalEntry.
 * توحيدها هنا يضمن نفس مستوى التحقق في كل مكان.
 * @returns {string|null} أول رسالة خطأ، أو null لو كل السطور سليمة
 */
function _validateJournalAccountLines(lines) {
  var accounts = readSheet(
    "ChartOfAccounts",
    ACCOUNTING_HR_HEADERS.ChartOfAccounts,
  );
  var controlSettings = _getAccountSettingsMap();
  // [COST-CENTER-DIM] نقرأ مراكز التكلفة مرة واحدة فقط لكل استدعاء (وليس
  // لكل سطر) لتفادي أي أثر ملحوظ على الأداء في القيود متعددة السطور.
  var costCentersRows = readSheet(
    "CostCenters",
    ACCOUNTING_HR_HEADERS.CostCenters,
    { trimStrings: true },
  );
  var costCenterRequired = _isCostCenterRequired();
  for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    var line = lines[lineIdx];
    // [COST-CENTER-DIM] فحص مركز التكلفة: إلزامي فقط لو مُفعَّل صراحةً عبر
    // إعداد النظام (Opt-in) — لا يغيّر سلوك أي منشأة لم تُفعِّل الميزة.
    // لو أُرسل cost_center_id (سواء كان الحقل إلزاميًا أم لا) يجب أن يكون
    // صالحاً (موجوداً ونشطاً)، وإلا يُرفض القيد بدل تجاهل قيمة غير صحيحة بصمت.
    if (line.cost_center_id) {
      var ccFound = _isUsableCostCenter(line.cost_center_id, costCentersRows);
      if (!ccFound)
        return (
          "السطر " +
          (lineIdx + 1) +
          ": مركز التكلفة " +
          line.cost_center_id +
          " غير موجود أو غير نشط"
        );
    } else if (costCenterRequired) {
      return (
        "السطر " +
        (lineIdx + 1) +
        ": مركز التكلفة إلزامي على كل سطر قيد حسب إعدادات النظام"
      );
    }
    if (!line.account_id)
      return "السطر " + (lineIdx + 1) + " لا يحتوي على حساب";
    var foundAcc = accounts.find(function (a) {
      return a.id === line.account_id && !a.deleted_at;
    });
    if (!foundAcc)
      return (
        "السطر " +
        (lineIdx + 1) +
        ": الحساب " +
        line.account_id +
        " غير موجود أو محذوف"
      );
    // [ACCOUNTING-LOOKUP-UNIFY] كان الفحص هنا يتجاهل حالة "غير نشط" —
    // أي حساب متوقف (is_active=false) كان لسه ممكن يترحّل عليه قيد يدوي.
    if (foundAcc.is_active === false || foundAcc.is_active === "FALSE")
      return (
        "السطر " +
        (lineIdx + 1) +
        ': الحساب "' +
        (foundAcc.name || foundAcc.code || foundAcc.id) +
        '" غير نشط — لا يمكن الترحيل عليه'
      );
    var isParentAccount =
      foundAcc.is_parent === true ||
      foundAcc.is_parent === "TRUE" ||
      foundAcc.is_parent === "true";
    if (isParentAccount)
      return (
        "السطر " +
        (lineIdx + 1) +
        ': الحساب "' +
        (foundAcc.name || foundAcc.code || foundAcc.id) +
        '" حساب تجميعي (رئيسي) — لا يجوز الترحيل عليه مباشرة، ' +
        "اختر أحد الحسابات الفرعية التابعة له"
      );

    // حسابا العملاء والموردين حسابان رقابيان: لا يجوز ترحيل مبلغ عليهما من
    // دون طرف محدد، وإلا اختلف رصيد الأستاذ العام عن الأستاذ المساعد.
    var partyType = String(line.party_type || "").toUpperCase();
    var partyId = String(line.party_id || "").trim();
    if (foundAcc.id === controlSettings.ar_account) {
      if (partyType !== "CUSTOMER" || !partyId)
        return (
          "السطر " +
          (lineIdx + 1) +
          ": حساب العملاء الرقابي يتطلب party_type=CUSTOMER و party_id صالحاً"
        );
    }
    if (foundAcc.id === controlSettings.ap_account) {
      if (partyType !== "SUPPLIER" || !partyId)
        return (
          "السطر " +
          (lineIdx + 1) +
          ": حساب الموردين الرقابي يتطلب party_type=SUPPLIER و party_id صالحاً"
        );
    }
  }
  return null;
}
function _addJournalEntryInternalOriginal(data) {
  _invalidateExtCache();
  // [BUG-002/QS-01 FIX] إضافة LockService حول مسار كتابة القيد المحاسبي
  // (كان مفقوداً هنا رغم استخدامه في باقي موديولات الكتابة الحساسة مثل
  // المبيعات والمخزون) — لمنع تعارض كتابة متزامن بين مستخدمين على نفس
  // الشيتات (JournalEntries/JournalEntryLines/ChartOfAccounts).
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return {
      success: false,
      message: "النظام مشغول بعملية أخرى على القيود المحاسبية، حاول مرة أخرى",
    };
  }
  try {
    if (!data || !data.date || !data.lines || data.lines.length === 0)
      throw new Error("التاريخ وسطور القيد مطلوبة");

    var validationError = _validateJournalEntry(data);
    if (validationError) throw new Error(validationError);

    var id = makeId("JE");
    var now = new Date().toISOString();
    var user = data.callerUser ? "SYSTEM:" + data.callerUser : "SYSTEM";

    var totalDebit = data.lines.reduce(function (a, l) {
      return a + Number(l.debit || 0);
    }, 0);
    var totalCredit = data.lines.reduce(function (a, l) {
      return a + Number(l.credit || 0);
    }, 0);

    // [ENGINE-UNIFY-JE-1] فحص التوازن بقى عبر ValidationEngine.business
    // (تفويض إلى BusinessRulesEngine.validateBeforeJournalEntry) بدل شرط
    // محلي مكرر، عشان يبقى القيد المحاسبي مرجع واحد لقاعدة "التوازن" في
    // كل نقاط الحفظ (تلقائي/يدوي) بدل نسختين منفصلتين ممكن يتفرقوا لاحقًا.
    var jeBalanceCheck = ValidationEngine.business.beforeJournalEntry({
      lines: data.lines,
    });
    if (!jeBalanceCheck.success) {
      throw new Error(
        jeBalanceCheck.message ||
          "القيد غير متوازن: مجموع المدين = " +
            totalDebit.toFixed(2) +
            " ≠ مجموع الدائن = " +
            totalCredit.toFixed(2),
      );
    }

    // [FIX-AUDIT-2026] فحص موحّد: وجود الحساب + عدم حذفه + عدم كونه تجميعياً
    var accountsLineError = _validateJournalAccountLines(data.lines);
    if (accountsLineError) throw new Error(accountsLineError);

    var sheet = getSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
    );
    // [P1-A FIX] القيود التلقائية تُنشأ مباشرةً بحالة POSTED بدلاً من DRAFT
    // لضمان ظهورها في جميع التقارير المالية (getGeneralLedger, getTrialBalance, إلخ)
    // [ENGINE-UNIFY] appendRow الخام بدّلناه بـ appendRowProtected — يضمن
    // القفل ضد التزامن (قيود مالية) وحماية أي عمود نصي محمي زي reference.
    _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.JournalEntries, [
      id,
      data.date,
      data.reference || "",
      data.source_type || "AUTO",
      data.description || "",
      totalDebit,
      totalCredit,
      "POSTED",
      data.notes || "",
      user,
      now,
      now, // posted_at
      user, // posted_by
    ]);

    var linesSheet = getSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
    );
    var jelRows1 = data.lines.map(function (line, i) {
      return [
        makeId("JEL"),
        id,
        line.account_id,
        Number(line.debit || 0),
        Number(line.credit || 0),
        i + 1,
        line.notes || "",
        line.party_type || "NONE",
        line.party_id || "",
        line.cost_center_id || "",
      ];
    });
    appendRowsBatch(
      "JournalEntryLines",
      jelRows1,
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
    ); // [PERF-BATCH-1]

    // [P1-A FIX] تحديث أرصدة الحسابات فوراً عند إنشاء القيد التلقائي
    // نفس منطق postJournalEntry — الأصول والمصروفات: مدين+ دائن- / الخصوم والإيرادات وحقوق الملكية: مدين- دائن+
    // [SEC-FIX-STAB3] إضافة LockService حول كامل مسار Read-Modify-Write
    // لرصيد الحساب (current_balance) — نفس فئة المشكلة #1/#2 لكن هنا في
    // قلب مسار ترحيل أي قيد محاسبي (بيع/شراء/دفعة/مصروف...). بدون القفل،
    // قيدين متزامنين على نفس الحساب ممكن يقروا نفس oldBalance فيضيع تأثير
    // أحدهما صامتًا، ويظهر فرق بين مجموع القيود الفعلي ورصيد الحساب
    // المعروض (يحتاج Reconciliation يدوي لاكتشافه لاحقًا).
    try {
      var coaSheet = getSheet(
        "ChartOfAccounts",
        ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      );
      var coaHeaders = coaSheet
        .getRange(1, 1, 1, coaSheet.getLastColumn())
        .getValues()[0];
      var balanceCol = coaHeaders.indexOf("current_balance");

      if (balanceCol !== -1) {
        var coaBalanceLock = LockService.getScriptLock();
        coaBalanceLock.waitLock(15000);
        try {
          var coaRows = readSheet(
            "ChartOfAccounts",
            ACCOUNTING_HR_HEADERS.ChartOfAccounts,
          );
          data.lines.forEach(function (line) {
            var coaIdx = coaRows.findIndex(function (r) {
              return r.id === line.account_id;
            });
            if (coaIdx !== -1) {
              var oldBalance = Number(coaRows[coaIdx].current_balance || 0);
              var accountType = coaRows[coaIdx].type;
              var debitEffect =
                ["ASSET", "EXPENSE"].indexOf(accountType) !== -1 ? 1 : -1;
              var creditEffect =
                ["ASSET", "EXPENSE"].indexOf(accountType) !== -1 ? -1 : 1;
              var newBalance =
                oldBalance +
                Number(line.debit || 0) * debitEffect +
                Number(line.credit || 0) * creditEffect;
              coaSheet.getRange(coaIdx + 2, balanceCol + 1).setValue(newBalance);
              // تحديث snapshot لمنع تعارض الأرصدة في سطور القيد الواحد
              coaRows[coaIdx].current_balance = newBalance;
            }
          });
        } finally {
          coaBalanceLock.releaseLock();
        }
      }
    } catch (balErr) {
      Logger.log(
        "[P1-A] Balance update error for entry " + id + ": " + balErr.message,
      );
    }

    _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return {
      success: true,
      id: id,
      total_debit: totalDebit,
      total_credit: totalCredit,
    };
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    lock.releaseLock();
  }
}
function addJournalEntry(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addJournalEntry",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var _auditUser = data.callerUser;
    if (!data || !data.date || !data.lines || data.lines.length === 0)
      return errResponse("التاريخ وسطور القيد مطلوبة");
    // [FIX-AUDIT #2] تفعيل إعداد "الملاحظات إلزامية على الحركات"
    var _notesErr = _checkRequireNotesOnTx(data.notes);
    if (_notesErr) return _notesErr;

    var validationError = _validateJournalEntry(data);
    if (validationError) return errResponse(validationError);

    // [FIX-AUDIT-2026 #3] تطبيق فحص قفل الفترة المحاسبية على القيود اليدوية
    // أيضاً — كان مُطبَّقاً فقط على القيود التلقائية (_addJournalEntryInternal)
    // مما كان يسمح بترحيل قيود يدوية بتاريخ في فترة CLOSED/LOCKED رغم رفض
    // نفس التاريخ لو جاء تلقائياً من فاتورة (راجع تقرير المراجعة، المرحلة 3،
    // الثغرة #1). التحقق هنا يمنع حتى إنشاء المسودة بتاريخ في فترة مقفلة.
    try {
      _validateFiscalPeriod(data.date);
    } catch (periodErr) {
      return errResponse(periodErr.message);
    }

    var id = makeId("JE");
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]

    var totalDebit = data.lines.reduce(function (a, l) {
      return a + Number(l.debit || 0);
    }, 0);
    var totalCredit = data.lines.reduce(function (a, l) {
      return a + Number(l.credit || 0);
    }, 0);

    // [ENGINE-UNIFY-JE-2] نفس فحص التوازن المركزي المستخدم في المسار
    // التلقائي (_addJournalEntryInternalOriginal) — عبر ValidationEngine.business
    // بدل شرط محلي منفصل، لضمان نفس السلوك في القيود اليدوية والتلقائية.
    var jeBalanceCheckManual = ValidationEngine.business.beforeJournalEntry({
      lines: data.lines,
    });
    if (!jeBalanceCheckManual.success) {
      return errResponse(
        jeBalanceCheckManual.message ||
          "القيد غير متوازن: مجموع المدين = " +
            totalDebit.toFixed(2) +
            " ≠ مجموع الدائن = " +
            totalCredit.toFixed(2),
      );
    }

    // [BUG-FIX-001 + FIX-AUDIT-2026 #2] فحص موحّد: وجود الحساب + عدم حذفه
    // + عدم كونه حساباً تجميعياً (is_parent)
    var accountsLineError = _validateJournalAccountLines(data.lines);
    if (accountsLineError) return errResponse(accountsLineError);

    // [BUG-002/QS-01 FIX] إضافة LockService حول مسار كتابة القيد اليدوي —
    // كان غائباً هنا رغم إنه أخطر نقطة كتابة محاسبية (القيود اليدوية)،
    // ومطبّق بالفعل في موديولات أخرى مثل المبيعات والمخزون.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية أخرى على القيود، حاول مرة أخرى");
    }
    try {
      // إضافة القيد
      var sheet = getSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
      );
      // [ENGINE-UNIFY] appendRow الخام → appendRowProtected (تحمي reference/id
      // من مشكلة تحويل النص لرقم؛ القفل الداخلي بتاعها متوافق مع القفل
      // الخارجي هنا لأنهما في نفس الـ execution).
      _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.JournalEntries, [
        id,
        data.date,
        data.reference || "",
        data.source_type || "MANUAL",
        data.description || "",
        totalDebit,
        totalCredit,
        "DRAFT",
        data.notes || "",
        user,
        now,
        "",
        "",
      ]);

      // إضافة سطور القيد
      var linesSheet = getSheet(
        "JournalEntryLines",
        ACCOUNTING_HR_HEADERS.JournalEntryLines,
      );
      var jelRows2 = data.lines.map(function (line, i) {
        return [
          makeId("JEL"),
          id,
          line.account_id,
          Number(line.debit || 0),
          Number(line.credit || 0),
          i + 1,
          line.notes || "",
          line.party_type || "NONE",
          line.party_id || "",
          line.cost_center_id || "",
        ];
      });
      appendRowsBatch(
        "JournalEntryLines",
        jelRows2,
        ACCOUNTING_HR_HEADERS.JournalEntryLines,
      ); // [PERF-BATCH-1]

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم إنشاء القيد بنجاح", {
        id: id,
        total_debit: totalDebit,
        total_credit: totalCredit,
      });
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في إنشاء القيد: " + e.message);
  }
}
function updateJournalEntry(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateJournalEntry",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    // [JOURNAL-AUDIT-2026-08-12 §UPDATE-RACE] كانت updateJournalEntry بدون
    // أي LockService خالص — عكس postJournalEntry/cancelJournalEntry/
    // reverseJournalEntry اللي بقوا محميين بقفل عام كامل من الفحص لحد آخر
    // كتابة. غياب القفل هنا كان بيسمح بـ: (أ) تنفيذين متزامنين من
    // updateJournalEntry على نفس القيد يحذفوا صفوف غلط في JournalEntryLines
    // (أرقام الصفوف بتتزاح لما أي تنفيذ تاني يحذف/يضيف صفوف في نفس الوقت)،
    // (ب) update تتنفذ وسط postJournalEntry (لسه ماسكة القفل العام) من غير
    // ما تتعطل، فتغيّر سطور القيد بينما post بتحسب الأرصدة على نسخة قديمة
    // من نفس السطور. الحل: نفس القفل العام (LockService.getScriptLock())
    // المستخدم في التلاتة التانيين، بياخد قبل أي قراءة/فحص وبيتغطى بيه
    // المسار كله لحد آخر كتابة، فيسلسل update مع نفسها ومع post/cancel/reverse.
    var updateLock = LockService.getScriptLock();
    try {
      updateLock.waitLock(15000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية تعديل قيد أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("القيد غير موجود");

      if (rows[idx].status === "POSTED")
        return errResponse("لا يمكن تعديل قيد معتمد — قم بإلغاء الاعتماد أولاً");

      // [FIX-AUDIT-2026 #3] فحص قفل الفترة المحاسبية على التعديل أيضاً —
      // نتحقق من التاريخ الجديد لو تغيّر، وإلا من التاريخ الحالي المخزَّن،
      // لمنع تعديل/إعادة حفظ قيد مسودة بتاريخ داخل فترة CLOSED/LOCKED.
      var _effectiveDate = data.date !== undefined ? data.date : rows[idx].date;
      try {
        _validateFiscalPeriod(_effectiveDate);
      } catch (periodErr) {
        return errResponse(periodErr.message);
      }

      var sheet = getSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
      );
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var rowNum = idx + 2;

      // تحديث الوصف والتاريخ
      // [ENGINE-AUDIT / Update Engine] كان بينادي setValue لكل عمود على حدة
      // (نداءين Sheets API منفصلين) بدل _applyRowUpdates الموحّدة (المُعرَّفة
      // في Code_12_Core.js وتُستخدم في ~11 ملف/34 موضع بالمشروع تحديدًا عشان
      // تجمع أي تعديل جزئي في نداء قراءة واحد + نداء كتابة واحد).
      var _jeUpdates = {};
      if (data.description !== undefined) _jeUpdates.description = data.description;
      if (data.date !== undefined) _jeUpdates.date = data.date;
      if (Object.keys(_jeUpdates).length) {
        _applyRowUpdates(sheet, rowNum, headers, _jeUpdates);
      }

      // [JOURNAL-AUDIT-2026-08-12 §UPDATE-DATA-LOSS] كان الترتيب القديم:
      // (1) حذف كل JournalEntryLines الخاصة بالقيد بالكامل، (2) appendRowsBatch
      // للسطور الجديدة. لو (2) فشلت (quota/timeout في Sheets API) بعد ما (1)
      // نجحت فعليًا (مفيش rollback في Google Sheets)، القيد كان يفضل بصفر
      // سطور نهائيًا — فقدان بيانات دائم رغم إن المستخدم شايف رسالة "فشل".
      // الحل: بدل "احذف الكل ثم أضف الكل"، بنعمل "استبدال مكاني" (in-place
      // overwrite):
      //  - أول قد ما نقدر من الصفوف الجديدة بيتكتب فوق الصفوف الموجودة فعليًا
      //    لنفس entry_id (بنفس الـ id — مفيش JEL id جديد يتولد للصفوف المُعاد
      //    استخدامها، زي ما مطلوب في ثبات الـ IDs).
      //  - لو السطور الجديدة أكتر من القديمة → الزيادة بس هي اللي بتتضاف
      //    (append آمن وإضافي، مبيمسحش حاجة).
      //  - لو السطور الجديدة أقل من القديمة → الصفوف الزيادة من القديمة
      //    بتتحذف في الآخر فقط، بعد ما الكتابة الجديدة تنجح بالكامل.
      // النتيجة: لو أي خطوة كتابة فشلت قبل مرحلة الحذف الأخيرة، السطور
      // القديمة (أو جزء منها) بتفضل موجودة — مفيش نافذة "صفر سطور" تانية.
      // ملحوظة صدق (Sheets مش transactional): لو الفشل حصل *وسط* حلقة
      // الاستبدال المكاني نفسها (مش قبلها ولا بعدها) ممكن يفضل مزيج من
      // قيم قديمة/جديدة على بعض صفوف *نفس القيد فقط* — ده موثّق تحت
      // REMAINING RISKS، مش بندّعي transactional كاملة.
      if (data.lines && data.lines.length > 0) {
        var valError = _validateJournalEntry(data);
        if (valError) return errResponse(valError);

        // [FIX-AUDIT-2026 #2/#3] updateJournalEntry لم يكن يتحقق إطلاقاً من
        // وجود الحساب/عدم حذفه عند تحديث السطور (بخلاف addJournalEntry) —
        // نفس الفحص الموحّد المستخدم في الإنشاء يُطبَّق هنا الآن
        var updAccountsLineError = _validateJournalAccountLines(data.lines);
        if (updAccountsLineError) return errResponse(updAccountsLineError);

        var linesSheet = getSheet(
          "JournalEntryLines",
          ACCOUNTING_HR_HEADERS.JournalEntryLines,
        );
        var allLines = readSheet(
          "JournalEntryLines",
          ACCOUNTING_HR_HEADERS.JournalEntryLines,
        );
        // الصفوف الحالية الخاصة بهذا القيد بس (لا نلمس أي صف يخص قيد آخر
        // إطلاقاً)، بترتيب رقم الصف في الشيت (أقدم أولاً) لضمان استبدال
        // متسق ومتوقع.
        var existingLineRows = [];
        allLines.forEach(function (l, i) {
          if (l.entry_id === id)
            existingLineRows.push({ rowNum: i + 2, record: l });
        });
        existingLineRows.sort(function (a, b) {
          return a.rowNum - b.rowNum;
        });

        // بناء وتحقق السطور الجديدة كاملة في الذاكرة أولاً — قبل أي لمس
        // فعلي للشيت.
        var totalDebit = 0,
          totalCredit = 0;
        var newLineValues = data.lines.map(function (line, i) {
          var d = Number(line.debit || 0);
          var c = Number(line.credit || 0);
          totalDebit += d;
          totalCredit += c;
          return {
            account_id: line.account_id,
            debit: d,
            credit: c,
            line_number: i + 1,
            notes: line.notes || "",
            party_type: line.party_type || "NONE",
            party_id: line.party_id || "",
            cost_center_id: line.cost_center_id || "",
          };
        });

        var commonCount = Math.min(
          existingLineRows.length,
          newLineValues.length,
        );

        // (1) استبدال مكاني: نكتب فوق أول commonCount صف موجود بالقيم
        // الجديدة، مع الحفاظ على نفس الـ JEL id الأصلي لكل صف (مفيش
        // توليد id جديد للصفوف المُعاد استخدامها).
        for (var _i = 0; _i < commonCount; _i++) {
          var _target = existingLineRows[_i];
          var _nv = newLineValues[_i];
          linesSheet
            .getRange(_target.rowNum, 1, 1, 10)
            .setValues([
              [
                _target.record.id,
                id,
                _nv.account_id,
                _nv.debit,
                _nv.credit,
                _nv.line_number,
                _nv.notes,
                _nv.party_type,
                _nv.party_id,
                _nv.cost_center_id,
              ],
            ]);
        }

        // (2) لو فيه سطور جديدة زيادة عن الموجود → إضافة آمنة (additive
        // بحتة، ما بتمسحش أي حاجة قديمة).
        if (newLineValues.length > existingLineRows.length) {
          var extraNewRows = newLineValues
            .slice(commonCount)
            .map(function (_nv) {
              return [
                makeId("JEL"),
                id,
                _nv.account_id,
                _nv.debit,
                _nv.credit,
                _nv.line_number,
                _nv.notes,
                _nv.party_type,
                _nv.party_id,
                _nv.cost_center_id,
              ];
            });
          appendRowsBatch(
            "JournalEntryLines",
            extraNewRows,
            ACCOUNTING_HR_HEADERS.JournalEntryLines,
          );
        }

        // (3) لو السطور القديمة أكتر من الجديدة → نحذف الزيادة القديمة
        // **بعد** ما الكتابة الجديدة (الاستبدال + أي إضافة) نجحت بالكامل،
        // بترتيب عكسي (من الأسفل للأعلى) عشان أرقام الصفوف متتزحزحش لبعضها
        // جوه نفس الحلقة. لو السطر ده اتنفذ، يبقى معنى كده إن كل السطور
        // الجديدة اتكتبت فعلاً بنجاح — مفيش خطر إننا نحذف قبل ما الكتابة
        // الجديدة تخلص.
        if (existingLineRows.length > newLineValues.length) {
          var rowsToRemove = existingLineRows
            .slice(commonCount)
            .map(function (r) {
              return r.rowNum;
            })
            .sort(function (a, b) {
              return b - a;
            });
          rowsToRemove.forEach(function (r) {
            linesSheet.deleteRow(r);
          });
        }

        // تحديث الإجمالي
        var tdCol = headers.indexOf("total_debit");
        var tcCol = headers.indexOf("total_credit");
        if (tdCol !== -1) sheet.getRange(rowNum, tdCol + 1).setValue(totalDebit);
        if (tcCol !== -1) sheet.getRange(rowNum, tcCol + 1).setValue(totalCredit);
      }

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم تحديث القيد بنجاح");
    } finally {
      updateLock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في تحديث القيد: " + e.message);
  }
}
function postJournalEntry(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "postJournalEntry",
      sessionToken,
    );
    if (_permErr) return _permErr;

    // [JOURNAL-AUDIT-2026-08-12 §POST-RACE] كان فحص الحالة (POSTED/CANCELLED)
    // وكتابتها كـ POSTED بيحصلوا بالكامل قبل أي LockService — القفل الوحيد
    // الموجود (coaBalanceLock) كان بيغطي بس حلقة تحديث ChartOfAccounts. طلبين
    // postJournalEntry متزامنين على نفس القيد الـ DRAFT كانوا الاتنين بيعدّوا
    // فحص الحالة، الاتنين يكتبوا status="POSTED" (قيمة متطابقة فمفيش تعارض
    // ظاهر)، وبعدين الاتنين (مسلسلين بقفل الأرصدة) يطبّقوا تأثير الأرصدة كامل
    // بشكل منفصل → الرصيد يتأثر مرتين لنفس القيد الواحد. القفل هنا بياخد قبل
    // فحص الحالة وبيتغطى بيه المسار كله لحد نهاية تحديث الأرصدة (قابل لإعادة
    // الدخول ضمن نفس الـ execution، فمفيش تعارض مع القفل الداخلي في
    // addJournalEntry/postJournalEntry لما reverseJournalEntry تناديها متداخلة).
    var postLock = LockService.getScriptLock();
    try {
      postLock.waitLock(15000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية اعتماد قيد أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("القيد غير موجود");

      if (rows[idx].status === "POSTED") return errResponse("القيد معتمد مسبقاً");
      if (rows[idx].status === "CANCELLED")
        return errResponse("لا يمكن اعتماد قيد ملغي");

      // [FIX-AUDIT-2026 #3] فحص قفل الفترة المحاسبية قبل الاعتماد الفعلي —
      // هذه هي اللحظة التي يتأثر فيها رصيد الحسابات فعلياً، لذا التحقق هنا
      // إلزامي حتى لو مرّ القيد من مرحلة الإنشاء بتاريخ كان وقتها ضمن فترة
      // مفتوحة ثم أُغلقت الفترة قبل الاعتماد.
      try {
        _validateFiscalPeriod(rows[idx].date);
      } catch (periodErr) {
        return errResponse(periodErr.message);
      }

      // أعد التحقق عند الاعتماد، لا عند إنشاء المسودة فقط. يحمي ذلك من أي
      // تعديل مباشر في Google Sheet أو بيانات قديمة لم تمر على التحقق الحالي.
      var allLines = readSheet(
        "JournalEntryLines",
        ACCOUNTING_HR_HEADERS.JournalEntryLines,
      );
      var entryLines = allLines.filter(function (l) {
        return l.entry_id === id;
      });
      var entryValidationError = _validateJournalEntry({ lines: entryLines });
      if (entryValidationError) return errResponse(entryValidationError);
      var entryAccountsError = _validateJournalAccountLines(entryLines);
      if (entryAccountsError) return errResponse(entryAccountsError);

      var sheet = getSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
      );
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();
      var user =
        typeof _auditUser !== "undefined"
          ? _auditUser
          : typeof callerUser !== "undefined"
            ? callerUser
            : "system"; // [FIX-ISSUE-019]

      var statusCol = headers.indexOf("status");
      var postedAtCol = headers.indexOf("posted_at");
      var postedByCol = headers.indexOf("posted_by");

      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("POSTED");
      if (postedAtCol !== -1)
        sheet.getRange(rowNum, postedAtCol + 1).setValue(now);
      if (postedByCol !== -1)
        sheet.getRange(rowNum, postedByCol + 1).setValue(user);

      // تحديث أرصدة الحسابات
      // [SEC-FIX-STAB3] إضافة LockService حول كامل مسار Read-Modify-Write —
      // نفس الإصلاح المطبّق في مسار الترحيل التلقائي أعلى في هذا الملف.
      // postJournalEntry هي مسار الترحيل اليدوي الأساسي، فأولويتها نفس أولوية
      // المسار التلقائي — بدون القفل، اعتماد قيدين متزامنين على نفس الحساب
      // يفقد تأثير أحدهما صامتًا. (القفل الخارجي postLock أعلاه بيمنع أصلاً
      // دخول تنفيذين متزامنين للدالة كلها؛ القفل الداخلي هنا اتسيب زي ما هو
      // لضمان نفس الحماية لو اتنودى الكود من مكان تاني مستقبلاً بدون المرور
      // من أول الدالة.)
      var coaSheet = getSheet(
        "ChartOfAccounts",
        ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      );
      var coaHeaders = coaSheet
        .getRange(1, 1, 1, coaSheet.getLastColumn())
        .getValues()[0];
      var balanceCol = coaHeaders.indexOf("current_balance");

      var coaBalanceLock = LockService.getScriptLock();
      coaBalanceLock.waitLock(15000);
      try {
        // [BUG-FIX-POST-001] قراءة ChartOfAccounts مرة واحدة قبل الحلقة
        // (كانت تُقرأ داخل forEach فيُفقد أثر السطور السابقة لنفس الحساب)
        var coaRows = readSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );
        entryLines.forEach(function (line) {
          var coaIdx = coaRows.findIndex(function (r) {
            return r.id === line.account_id;
          });
          if (coaIdx !== -1 && balanceCol !== -1) {
            var oldBalance = Number(coaRows[coaIdx].current_balance || 0);
            var accountType = coaRows[coaIdx].type;
            var newBalance = oldBalance;

            // منطق الأرصدة حسب نوع الحساب
            // الأصول: مدين + ، دائن -
            // الخصوم وحقوق الملكية: مدين - ، دائن +
            // الإيرادات: مدين - ، دائن +
            // المصروفات: مدين + ، دائن -
            var debitEffect =
              ["ASSET", "EXPENSE"].indexOf(accountType) !== -1 ? 1 : -1;
            var creditEffect =
              ["ASSET", "EXPENSE"].indexOf(accountType) !== -1 ? -1 : 1;

            newBalance =
              oldBalance +
              Number(line.debit || 0) * debitEffect +
              Number(line.credit || 0) * creditEffect;

            coaSheet.getRange(coaIdx + 2, balanceCol + 1).setValue(newBalance);
            // [BUG-FIX-POST-001] تحديث الـ snapshot لمنع قراءة رصيد قديم في السطر التالي
            coaRows[coaIdx].current_balance = newBalance;
          }
        });
      } finally {
        coaBalanceLock.releaseLock();
      }

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم اعتماد القيد بنجاح");
    } finally {
      postLock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في اعتماد القيد: " + e.message);
  }
}
/**
 * reverseJournalEntry — عكس قيد معتمد (Reversing Entry)
 * بينشئ قيد جديد بنفس السطور لكن مع تبديل المدين/الدائن، يعتمده فوراً
 * (فيرجع تأثير القيد الأصلي على الأرصدة لحظياً)، ويربط القيدين ببعض
 * عبر عمودي reversed_by/reversal_of — بدون التلاعب في القيد الأصلي أو
 * حذفه، حفاظاً على السجل المحاسبي (audit trail) زي الأصول المحاسبية.
 */
function reverseJournalEntry(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "reverseJournalEntry",
      sessionToken,
    );
    if (_permErr) return _permErr;

    // [JOURNAL-AUDIT-2026-08-12 §REVERSE-RACE] كان الفحص (status===POSTED،
    // reversed_by فارغ) بيتعمل من غير أي قفل، وده مكان الكتابة الوحيد اللي
    // بيثبت إن القيد "اتعكس" (تعيين reversed_by) كان بعد كل ده بمسافة كبيرة
    // (بعد addJournalEntry + postJournalEntry). طلبين reverseJournalEntry
    // متزامنين على نفس id كانوا الاتنين بيعدّوا من الفحص (لسه ولا واحد كتب
    // reversed_by)، فيتولّد قيدين عكسيين منفصلين ويترحّلوا الاتنين، فيرجع
    // تأثير القيد الأصلي على الأرصدة مرتين (Double Reversal) بدل مرة واحدة،
    // وآخر كتابة على reversed_by بس اللي بتفضل (يبقى فيه قيد عكسي "يتيم" غير
    // مرتبط بالقيد الأصلي بينما هو فعليًا أثّر على الأرصدة). القفل هنا بياخد
    // من قبل الفحص لحد بعد كتابة reversed_by، فيمنع أي تنفيذ متزامن تاني من
    // الدخول لحد ما التنفيذ الحالي يخلص بالكامل (lock قابل لإعادة الدخول
    // ضمن نفس الـ execution، فمش هيعمل deadlock مع القفل الداخلي في
    // addJournalEntry/postJournalEntry).
    var reverseLock = LockService.getScriptLock();
    try {
      reverseLock.waitLock(15000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية عكس قيد أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("القيد غير موجود");
      var original = rows[idx];

      if (original.status !== "POSTED")
        return errResponse("لا يمكن عكس إلا قيد معتمد (POSTED)");
      if (original.reversed_by)
        return errResponse("هذا القيد معكوس بالفعل (القيد العكسي: " + original.reversed_by + ")");

      var allLines = readSheet(
        "JournalEntryLines",
        ACCOUNTING_HR_HEADERS.JournalEntryLines,
        { trimStrings: true },
      );
      var entryLines = allLines
        .filter(function (l) {
          return l.entry_id === id;
        })
        .sort(function (a, b) {
          return Number(a.line_number || 0) - Number(b.line_number || 0);
        });
      if (!entryLines.length) return errResponse("القيد لا يحتوي على سطور");

      // فترة محاسبية مفتوحة لتاريخ اليوم (تاريخ قيد العكس هو اليوم دائماً)
      var today = new Date().toISOString().split("T")[0];
      try {
        _validateFiscalPeriod(today);
      } catch (periodErr) {
        return errResponse(periodErr.message);
      }

      // بناء سطور القيد العكسي (تبديل مدين/دائن لكل سطر)
      var reversedLines = entryLines.map(function (l) {
        return {
          account_id: l.account_id,
          debit: Number(l.credit || 0),
          credit: Number(l.debit || 0),
          notes: "عكس: " + (l.notes || ""),
          party_type: l.party_type || "NONE",
          party_id: l.party_id || "",
        };
      });

      var addResult = addJournalEntry({
        callerUser: callerUser,
        sessionToken: sessionToken,
        date: today,
        reference: original.reference || id,
        source_type: "REVERSAL",
        description:
          "قيد عكسي للقيد " + (original.reference || id) + " — " + (original.description || ""),
        notes: "عكس تلقائي للقيد " + id,
        lines: reversedLines,
      });
      if (!addResult || !addResult.success) return addResult;

      var newId = addResult.data.id;
      // اعتماد القيد العكسي فوراً حتى يرجع تأثير القيد الأصلي على الأرصدة
      var postResult = postJournalEntry(newId, callerUser, sessionToken);
      if (!postResult || !postResult.success) return postResult;

      // ربط القيدين ببعض
      var sheet = getSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
      );
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var reversedByCol = headers.indexOf("reversed_by");
      var reversalOfCol = headers.indexOf("reversal_of");
      if (reversedByCol !== -1)
        sheet.getRange(idx + 2, reversedByCol + 1).setValue(newId);

      var newRows = readSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
        { trimStrings: true },
      );
      var newIdx = newRows.findIndex(function (r) {
        return r.id === newId;
      });
      if (newIdx !== -1 && reversalOfCol !== -1)
        sheet.getRange(newIdx + 2, reversalOfCol + 1).setValue(id);

      AuditEngine.log("REVERSE", {
        user: callerUser,
        table: "JournalEntries",
        record_id: id,
        details: "عكس القيد " + id + " بالقيد الجديد " + newId});

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم عكس القيد بنجاح — القيد العكسي رقم " + newId, {
        original_id: id,
        reversal_id: newId,
      });
    } finally {
      reverseLock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في عكس القيد: " + e.message);
  }
}

/**
 * exportJournalEntryPdf — يبني HTML للقيد ويحوّله PDF عبر Google Drive
 * (نفس آلية _htmlToPdf المستخدمة في التقارير الأسبوعية)، يرفعه على
 * Drive برابط مشاركة، ويرجّع الرابط للواجهة لفتحه في تبويب جديد.
 */
function exportJournalEntryPdf(id, callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "exportJournalEntryPdf",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var entry = rows.find(function (r) {
      return r.id === id;
    });
    if (!entry) return errResponse("القيد غير موجود");

    var linesRes = getJournalEntryLines(id);
    if (!linesRes.success) return linesRes;
    var lines = linesRes.data;

    var shopName = "MOO.ERP";
    try {
      var settingsRows = readSheet("Settings");
      var shopSetting = settingsRows.find(function (s) {
        return s.key === "shop_name" || s.key === "company_name";
      });
      if (shopSetting && shopSetting.value) shopName = shopSetting.value;
    } catch (eSettings) {
      Logger.log("[silent-catch] " + eSettings);
    }

    var rowsHtml = lines
      .map(function (l) {
        return (
          "<tr>" +
          "<td>" +
          _esc(l.account_code || "") +
          " — " +
          _esc(l.account_name || l.account_id) +
          "</td>" +
          "<td>" +
          _esc(l.notes || "") +
          "</td>" +
          "<td>" +
          (Number(l.debit || 0) ? _fmt(l.debit) : "") +
          "</td>" +
          "<td>" +
          (Number(l.credit || 0) ? _fmt(l.credit) : "") +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    var statusLabel =
      { DRAFT: "مسودة", POSTED: "معتمد", CANCELLED: "ملغي" }[entry.status] ||
      entry.status;

    var html =
      '<div dir="rtl" style="font-family:Arial,sans-serif;padding:24px">' +
      '<h2 style="margin-bottom:4px">' +
      _esc(shopName) +
      "</h2>" +
      '<h3 style="margin-top:0;color:#444">قيد يومية رقم ' +
      _esc(entry.id) +
      "</h3>" +
      '<table style="width:100%;margin-bottom:16px;font-size:13px">' +
      "<tr><td><strong>التاريخ:</strong> " +
      _esc(entry.date) +
      "</td><td><strong>الحالة:</strong> " +
      _esc(statusLabel) +
      "</td></tr>" +
      "<tr><td><strong>المرجع:</strong> " +
      _esc(entry.reference || "-") +
      "</td><td><strong>نوع المصدر:</strong> " +
      _esc(entry.source_type || "MANUAL") +
      "</td></tr>" +
      "<tr><td colspan='2'><strong>البيان:</strong> " +
      _esc(entry.description || "") +
      "</td></tr>" +
      "</table>" +
      '<table style="width:100%;border-collapse:collapse;font-size:13px" border="1" cellpadding="6">' +
      "<thead style='background:#f0f0f0'><tr><th>الحساب</th><th>ملاحظات</th><th>مدين</th><th>دائن</th></tr></thead>" +
      "<tbody>" +
      rowsHtml +
      "</tbody>" +
      "<tfoot><tr style='font-weight:bold'><td colspan='2'>الإجمالي</td><td>" +
      _fmt(entry.total_debit) +
      "</td><td>" +
      _fmt(entry.total_credit) +
      "</td></tr></tfoot>" +
      "</table>" +
      '<p style="margin-top:20px;font-size:11px;color:#888">تم الإنشاء بواسطة: ' +
      _esc(entry.created_by || "") +
      " — " +
      _esc(entry.created_at || "") +
      "</p>" +
      "</div>";

    var pdfBlob = _htmlToPdf(html, "قيد-" + entry.id);
    var file = _uploadPdfToDrive(pdfBlob);

    AuditEngine.log("EXPORT_PDF", {
      user: callerUser,
      table: "JournalEntries",
      record_id: id,
      details: "تصدير القيد PDF"});

    return okResponse("تم إنشاء ملف PDF بنجاح", {
      url: file.getUrl(),
      download_url:
        "https://drive.google.com/uc?export=download&id=" + file.getId(),
    });
  } catch (e) {
    return errResponse("خطأ في تصدير القيد PDF: " + e.message);
  }
}

function cancelJournalEntry(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "cancelJournalEntry",
      sessionToken,
    );
    if (_permErr) return _permErr;

    // [JOURNAL-AUDIT-2026-08-12 §CANCEL-RACE] كان فحص الحالة (CANCELLED)
    // وفحص reversed_by وكتابة status="CANCELLED" النهائية كلهم من غير أي
    // LockService — القفل الوحيد (coaBalanceLock) كان بيغطي بس حلقة تحديث
    // ChartOfAccounts وبيتفك قبل كتابة status بمسافة. ده كان بيسمح بـ:
    // (أ) طلبين cancel متزامنين على نفس القيد يرجّعوا تأثير الأرصدة مرتين،
    // (ب) سباق بين cancel و reverseJournalEntry على نفس القيد — cancel كان
    // بيقرأ reversed_by فاضي وينفّذ بالكامل وهو reverseJournalEntry (اللي
    // بقت بتاخد قفل عام طول تنفيذها) لسه في النص، فيأثروا الاتنين على نفس
    // الأرصدة بشكل متعارض. القفل هنا بياخد قبل أي فحص وبيتغطى بيه المسار كله
    // لحد كتابة status النهائية، بنفس الـ LockService.getScriptLock() العام
    // المستخدم في postJournalEntry/reverseJournalEntry، فبيمنع التداخل مع
    // الاتنين كمان (قفل عام واحد على مستوى السكريبت).
    var cancelLock = LockService.getScriptLock();
    try {
      cancelLock.waitLock(15000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية إلغاء قيد أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("القيد غير موجود");

      if (rows[idx].status === "CANCELLED")
        return errResponse("القيد ملغي مسبقاً");

      // [FIX-AUDIT-2026 #7 / CANCEL-DOUBLE-REVERSAL] كان cancelJournalEntry
      // يرجّع أثر القيد على الأرصدة مباشرة دون أي تحقق من كون القيد اتعمله
      // Reverse بالفعل (reverseJournalEntry بيتحقق من reversed_by، لكن هذا
      // الفحص كان غائباً هنا تماماً). لو قيد POSTED اتعمله reverse (فيتولد
      // قيد عكسي جديد يرجع الأثر) وبعدين نفس القيد الأصلي (لسه POSTED) يتم
      // إلغاؤه هنا، كان الأثر بيترجع مرة تانية (Double Reversal) فيبقى رصيد
      // الحساب منقوصاً أكتر من الحقيقة بدون أي رسالة خطأ. الحل: امنع الإلغاء
      // لو القيد معكوس بالفعل، ووجّه المستخدم لإلغاء القيد العكسي نفسه أولاً
      // لو أراد التراجع الكامل.
      if (rows[idx].reversed_by)
        return errResponse(
          "هذا القيد معكوس بالفعل (القيد العكسي: " +
            rows[idx].reversed_by +
            ") — إلغاؤه الآن سيرجّع الأثر على الأرصدة مرتين. " +
            "لإلغاء التأثير الكامل، ألغِ القيد العكسي رقم " +
            rows[idx].reversed_by +
            " بدلاً من ذلك.",
        );

      // [FIX-AUDIT-2026 #3 / PERIOD-CLOSING-2026-07] كانت post/update بتفحص
      // قفل الفترة (راجع أعلى الملف) لكن cancel اتنسيت رغم إنها بتعكس نفس
      // الأرصدة تمامًا — نفس تأثير الحذف/الترحيل.
      try {
        _validateFiscalPeriod(rows[idx].date);
      } catch (periodErr) {
        return errResponse(periodErr.message);
      }

      var sheet = getSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
      );
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var rowNum = idx + 2;

      // لو كان معتمد → نرجع الأرصدة
      if (rows[idx].status === "POSTED") {
        var lines = readSheet(
          "JournalEntryLines",
          ACCOUNTING_HR_HEADERS.JournalEntryLines,
        );
        var entryLines = lines.filter(function (l) {
          return l.entry_id === id;
        });
        var coaSheet = getSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );
        var coaHeaders = coaSheet
          .getRange(1, 1, 1, coaSheet.getLastColumn())
          .getValues()[0];
        var balanceCol = coaHeaders.indexOf("current_balance");

        // [SEC-FIX-STAB3] إضافة LockService حول كامل مسار Read-Modify-Write —
        // نفس الإصلاح المطبّق في مسارات الترحيل أعلى في هذا الملف. مسار
        // الإلغاء/العكس بيقرأ ويكتب current_balance بنفس النمط غير المحمي.
        // (القفل الخارجي cancelLock أعلاه بيمنع أصلاً دخول تنفيذين متزامنين
        // للدالة كلها؛ القفل الداخلي هنا اتسيب زي ما هو كطبقة حماية إضافية.)
        var coaBalanceLock = LockService.getScriptLock();
        coaBalanceLock.waitLock(15000);
        try {
          // [BUG-FIX-002] Read ChartOfAccounts ONCE before the loop — not inside it
          var coaRows = readSheet(
            "ChartOfAccounts",
            ACCOUNTING_HR_HEADERS.ChartOfAccounts,
          );
          entryLines.forEach(function (line) {
            var coaIdx = coaRows.findIndex(function (r) {
              return r.id === line.account_id;
            });
            if (coaIdx !== -1 && balanceCol !== -1) {
              var oldBalance = Number(coaRows[coaIdx].current_balance || 0);
              var accountType = coaRows[coaIdx].type;
              // [BUG-FIX-004] Correct reversal: ASSET/EXPENSE reverse is opposite
              var debitEffect =
                ["ASSET", "EXPENSE"].indexOf(accountType) !== -1 ? -1 : 1;
              var creditEffect =
                ["ASSET", "EXPENSE"].indexOf(accountType) !== -1 ? 1 : -1;
              var newBalance =
                oldBalance +
                Number(line.debit || 0) * debitEffect +
                Number(line.credit || 0) * creditEffect;
              coaSheet.getRange(coaIdx + 2, balanceCol + 1).setValue(newBalance);
              // [BUG-FIX-002] Update snapshot for subsequent lines in same entry
              coaRows[coaIdx].current_balance = newBalance;
            }
          });
        } finally {
          coaBalanceLock.releaseLock();
        }
      }

      var statusCol = headers.indexOf("status");
      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("CANCELLED");

      _invalidateServerCacheVouchers(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("تم إلغاء القيد بنجاح");
    } finally {
      cancelLock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في إلغاء القيد: " + e.message);
  }
}
function deleteJournalEntry(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    // [WIRE-FIX] بقت بتتوصّل بـ DeleteEngine الموحّد بدل منطق منفصل هنا —
    // BusinessRulesEngine.validateBeforeDelete("journalEntry") بيعمل نفس فحص
    // "لا يمكن حذف قيد معتمد" اللي كان هنا يدويًا، وDeleteConfig.journalEntry
    // فيه afterDelete بيحذف JournalEntryLines المرتبطة زي ما كانت الدالة
    // القديمة بتعمل بالظبط (نفس الترتيب: من الأسفل للأعلى).
    var r = DeleteEngine.delete("journalEntry", id, callerUser, sessionToken, {
      // ملاحظة: DeleteConfig.journalEntry.allowHardDelete = false، فتمرير
      // hard:true هنا كان هيترفض فورًا بـ BLOCKED. الجدول أصلًا مفيهوش عمود
      // deleted_at، فـ DataLayerEngine.delete هيكتشف غيابه ويرجع تلقائيًا
      // لحذف فعلي (سلوك مطابق لـ sheet.deleteRow القديم) بدون أي opts هنا.
    });
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message);
  } catch (e) {
    return errResponse("خطأ في حذف القيد: " + e.message);
  }
}
function getJournalEntryLines(entryId) {
  try {
    var rows = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
      { trimStrings: true },
    );
    rows = rows.filter(function (l) {
      return l.entry_id === entryId;
    });
    rows.sort(function (a, b) {
      return Number(a.line_number || 0) - Number(b.line_number || 0);
    });

    // إثراء بأسماء الحسابات
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    // [COST-CENTER-DIM] إثراء بأسماء مراكز التكلفة (اختيارية — قد تكون فارغة)
    var costCenters = readSheet(
      "CostCenters",
      ACCOUNTING_HR_HEADERS.CostCenters,
      { trimStrings: true },
    );
    rows.forEach(function (line) {
      var acc = accounts.find(function (a) {
        return a.id === line.account_id;
      });
      line.account_name = acc ? acc.name : "";
      line.account_code = acc ? acc.code : "";

      var cc = line.cost_center_id
        ? costCenters.find(function (c) {
            return c.id === line.cost_center_id;
          })
        : null;
      line.cost_center_name = cc ? cc.name : "";
      line.cost_center_code = cc ? cc.code : "";
    });

    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب سطور القيد: " + e.message);
  }
}
function _autoJournalFromReceiptVoucher(voucher, callerUser) {
  // قيد تلقائي لسند قبض:
  // مدين: الخزنة/البنك (أصل)
  // دائن: ذمم مدينة / عملاء — دائماً، ليس الإيرادات

  // ─── استخراج حساب الصندوق / البنك ───
  var cashAccountId = "";
  // [AUDIT-FIX] default_cost_center كان يُحفظ ويُعرض على BankAccounts لكن
  // غير مقروء إطلاقًا في ترحيل القيود — تفعيله هنا: لو الحساب البنكي عليه
  // مركز تكلفة افتراضي، بيتحط تلقائيًا على سطر القيد المقابل له.
  var cashCostCenterId = "";
  if (voucher.payment_method === "CASH" && voucher.cash_box_id) {
    var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var box = cashBoxes.find(function (b) {
      return b.id === voucher.cash_box_id;
    });
    if (box) cashAccountId = box.account_id;
  } else if (
    BANKLIKE_PAYMENT_METHODS.indexOf(voucher.payment_method) !== -1 &&
    voucher.bank_account_id
  ) {
    var banks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
    var bank = banks.find(function (b) {
      return b.id === voucher.bank_account_id;
    });
    if (bank) {
      cashAccountId = bank.account_id;
      cashCostCenterId = bank.default_cost_center || "";
    }
  }
  if (!cashAccountId) throw new Error("لا يوجد حساب مقابل مرتبط بالخزنة/البنك");

  var accounts = readSheet(
    "ChartOfAccounts",
    ACCOUNTING_HR_HEADERS.ChartOfAccounts,
  );

  // ─── تحديد حساب الدائن ───
  var creditAccountId = "";
  var creditNotes = "";

  if (voucher.party_type === "CUSTOMER" && voucher.party_id) {
    // [H-001 FIX] الدائن هو حساب الذمم المدينة دائماً عند التحصيل من عميل
    // [ACCOUNT-MAP] نستخدم resolvePostingAccount: Entity Override (العميل) ← Global Default
    var customers = readSheet("Customers", CUSTOMER_HEADERS);
    var custRec = customers.find(function (c) {
      return c.id === voucher.party_id;
    });
    var arResolved = resolvePostingAccount({
      accounts: accounts,
      key: "ar_account",
      type: "ASSET",
      hints: ["ذمم مدينة", "عملاء", "accounts receivable", "مدينين"],
      entityAccountId: custRec && custRec.account_id,
    });
    var arAccount = arResolved.account;
    if (arAccount) {
      creditAccountId = arAccount.id;
      creditNotes =
        "تحصيل من عميل: " + (voucher.from_party || voucher.party_id);
    } else {
      Logger.log(
        "[H-001] خطأ: لا يوجد حساب ذمم مدينة في دليل الحسابات — " +
          "يجب إضافة حساب 'عملاء / ذمم مدينة' وربطه بـ ar_account في الإعدادات",
      );
      throw new Error(
        "لا يوجد حساب ذمم مدينة مناسب — يجب ضبط ar_account في إعدادات المحاسبة",
      );
    }
  } else {
    // إيراد آخر (غير مرتبط بعميل محدد) — هنا يُقبَل الإيراد
    var revenueAccount = _getDefaultAccount(
      "revenue_account",
      accounts,
      "REVENUE",
      ["إيرادات المبيعات", "مبيعات", "إيرادات", "sales revenue"],
    );
    if (!revenueAccount)
      throw new Error("لا يوجد حساب إيرادات في دليل الحسابات");
    creditAccountId = revenueAccount.id;
    creditNotes = voucher.from_party || "إيرادات متنوعة";
  }

  var result = _addJournalEntryInternal({
    callerUser: callerUser || "SYSTEM",
    date: voucher.date,
    reference: voucher.voucher_number,
    source_type: "RECEIPT",
    description:
      "سند قبض رقم " +
      voucher.voucher_number +
      " — " +
      (voucher.description || ""),
    lines: [
      {
        account_id: cashAccountId,
        debit: Number(voucher.amount),
        credit: 0,
        notes: _paymentMethodNoteLabel(voucher.payment_method),
        cost_center_id: voucher.cost_center_id || cashCostCenterId || "",
      },
      {
        account_id: creditAccountId,
        debit: 0,
        credit: Number(voucher.amount),
        notes: creditNotes,
        party_type: voucher.party_type || "NONE",
        party_id: voucher.party_id || "",
      },
    ],
  });

  if (!result || !result.success) {
    throw new Error(
      "فشل إنشاء القيد التلقائي لسند القبض: " +
        (result ? result.message : "خطأ غير معروف"),
    );
  }
}
function _autoJournalFromPaymentVoucher(voucher, callerUser) {
  var cashAccountId = "";
  // [AUDIT-FIX] تفعيل BankAccounts.default_cost_center (كان غير مقروء إطلاقًا)
  var cashCostCenterId = "";
  if (voucher.payment_method === "CASH" && voucher.cash_box_id) {
    var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var box = cashBoxes.find(function (b) {
      return b.id === voucher.cash_box_id;
    });
    if (box) cashAccountId = box.account_id;
  } else if (
    BANKLIKE_PAYMENT_METHODS.indexOf(voucher.payment_method) !== -1 &&
    voucher.bank_account_id
  ) {
    var banks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
    var bank = banks.find(function (b) {
      return b.id === voucher.bank_account_id;
    });
    if (bank) {
      cashAccountId = bank.account_id;
      cashCostCenterId = bank.default_cost_center || "";
    }
  }

  if (!cashAccountId) {
    throw new Error("لا يوجد حساب مقابل مرتبط بالخزنة/البنك");
  }

  // [BUG-FIX-005] Find the BEST expense/payable account based on party type
  var accounts = readSheet(
    "ChartOfAccounts",
    ACCOUNTING_HR_HEADERS.ChartOfAccounts,
  );
  var debitAccountId = cashAccountId; // fallback
  var debitNotes = voucher.to_party || "مصروفات";

  if (voucher.party_type === "SUPPLIER" && voucher.party_id) {
    // [ACCOUNT-MAP] نبحث أولاً عن حساب خاص بالمورد، ثم الحساب العام من الإعدادات
    var suppliers = readSheet("Suppliers", SUPPLIER_HEADERS);
    var suppRec = suppliers.find(function (s) {
      return s.id === voucher.party_id;
    });
    var apResolved = resolvePostingAccount({
      accounts: accounts,
      key: "ap_account",
      type: "LIABILITY",
      hints: ["ذمم دائنة", "موردين", "accounts payable", "دائنة"],
      entityAccountId: suppRec && suppRec.account_id,
    });
    if (apResolved.account) {
      debitAccountId = apResolved.account.id;
      debitNotes = "مورد: " + voucher.to_party;
    }
  } else {
    var expenseAcc = accounts.find(function (a) {
      return (
        a.type === "EXPENSE" &&
        !a.deleted_at &&
        a.is_active !== "FALSE" &&
        a.is_active !== false
      );
    });
    if (expenseAcc) {
      debitAccountId = expenseAcc.id;
    }
  }

  // [ACCOUNTING-ENGINE-FIX] استخدام الدالة الداخلية لتجاوز auth check في القيود التلقائية
  var result = _addJournalEntryInternal({
    callerUser: callerUser || "SYSTEM",
    date: voucher.date,
    reference: voucher.voucher_number,
    source_type: "PAYMENT",
    description:
      "سند صرف رقم " + voucher.voucher_number + " — " + voucher.description,
    lines: [
      {
        account_id: debitAccountId,
        debit: Number(voucher.amount),
        credit: 0,
        notes: debitNotes,
      },
      {
        account_id: cashAccountId,
        debit: 0,
        credit: Number(voucher.amount),
        notes: _paymentMethodNoteLabel(voucher.payment_method),
        cost_center_id: voucher.cost_center_id || cashCostCenterId || "",
      },
    ],
  });

  if (!result || !result.success) {
    throw new Error(
      "فشل إنشاء القيد التلقائي: " +
        (result ? result.message : "خطأ غير معروف"),
    );
  }
}
function _autoJournalFromExpense(expense, callerUser) {
  var cashAccountId = "";
  if (expense.payment_method === "CASH" && expense.cash_box_id) {
    var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var box = cashBoxes.find(function (b) {
      return b.id === expense.cash_box_id;
    });
    if (box) cashAccountId = box.account_id;
  } else if (
    BANKLIKE_PAYMENT_METHODS.indexOf(expense.payment_method) !== -1 &&
    expense.bank_account_id
  ) {
    var banks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
    var bank = banks.find(function (b) {
      return b.id === expense.bank_account_id;
    });
    if (bank) cashAccountId = bank.account_id;
  }

  if (!cashAccountId) {
    throw new Error("لا يوجد حساب مقابل مرتبط بالخزنة/البنك");
  }

  // [ACCOUNTING-ENGINE-FIX] استخدام الدالة الداخلية لتجاوز auth check في القيود التلقائية
  var result = _addJournalEntryInternal({
    callerUser: callerUser || "SYSTEM",
    date: expense.date,
    reference: expense.voucher_number,
    source_type: "EXPENSE",
    description:
      "مصروف رقم " +
      expense.voucher_number +
      " — " +
      (expense.description || ""),
    lines: [
      {
        account_id: expense.account_id,
        debit: Number(expense.amount),
        credit: 0,
        notes: expense.description || "مصروف",
      },
      {
        account_id: cashAccountId,
        debit: 0,
        credit: Number(expense.amount),
        notes: _paymentMethodNoteLabel(expense.payment_method),
      },
    ],
  });

  if (!result || !result.success) {
    throw new Error(
      "فشل إنشاء القيد التلقائي: " +
        (result ? result.message : "خطأ غير معروف"),
    );
  }
}
function _autoJournalFromTransferVoucher(voucher, callerUser) {
  var fromAccountId = "";
  var toAccountId = "";

  if (voucher.from_type === "CASHBOX") {
    var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var box = cashBoxes.find(function (b) {
      return b.id === voucher.from_id;
    });
    if (box) fromAccountId = box.account_id;
  } else if (voucher.from_type === "BANK") {
    var banks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
    var bank = banks.find(function (b) {
      return b.id === voucher.from_id;
    });
    if (bank) fromAccountId = bank.account_id;
  }

  if (voucher.to_type === "CASHBOX") {
    var toCashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var toBox = toCashBoxes.find(function (b) {
      return b.id === voucher.to_id;
    });
    if (toBox) toAccountId = toBox.account_id;
  } else if (voucher.to_type === "BANK") {
    var toBanks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
    var toBank = toBanks.find(function (b) {
      return b.id === voucher.to_id;
    });
    if (toBank) toAccountId = toBank.account_id;
  }

  if (!fromAccountId || !toAccountId) {
    throw new Error("لا يوجد حساب مقابل مرتبط بأحد طرفي التحويل");
  }

  // [P7] عمولة التحويل البنكي (اختيارية) — لو موجودة، بتتسجل كمصروف بنكي
  // مستقل ضمن نفس القيد، وحساب المصدر يُقيَّد كاملاً (مبلغ + عمولة).
  var feeAmount = Number(voucher.fee_amount || 0);
  var feeAccountId = "";
  if (feeAmount > 0) {
    var accountsForFee = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var feeAccount = _getDefaultAccount(
      "bank_fees_account",
      accountsForFee,
      "EXPENSE",
      [
        "مصروفات بنكية",
        "عمولات بنكية",
        "رسوم بنكية",
        "bank charges",
        "bank fees",
      ],
    );
    if (!feeAccount)
      throw new Error(
        "لا يوجد حساب مصروفات بنكية في دليل الحسابات — يجب ضبط bank_fees_account في إعدادات المحاسبة",
      );
    feeAccountId = feeAccount.id;
  }

  var lines = [
    {
      account_id: toAccountId,
      debit: Number(voucher.amount),
      credit: 0,
      notes: "إلى: " + voucher.to_type + " — " + voucher.to_id,
    },
    {
      account_id: fromAccountId,
      debit: 0,
      credit: Number(voucher.amount) + feeAmount,
      notes: "من: " + voucher.from_type + " — " + voucher.from_id,
    },
  ];
  if (feeAmount > 0) {
    lines.push({
      account_id: feeAccountId,
      debit: feeAmount,
      credit: 0,
      notes:
        "عمولة تحويل بنكي" +
        (voucher.bank_reference ? " — مرجع: " + voucher.bank_reference : ""),
    });
  }

  // [ACCOUNTING-ENGINE-FIX] استخدام الدالة الداخلية لتجاوز auth check في القيود التلقائية
  var result = _addJournalEntryInternal({
    callerUser: callerUser || "SYSTEM",
    date: voucher.date,
    reference: voucher.voucher_number,
    source_type: "TRANSFER",
    description:
      "سند تحويل رقم " +
      voucher.voucher_number +
      " — من " +
      voucher.from_type +
      " إلى " +
      voucher.to_type +
      (voucher.bank_reference
        ? " — مرجع بنكي: " + voucher.bank_reference
        : "") +
      (voucher.description ? " — " + voucher.description : ""),
    lines: lines,
  });

  if (!result || !result.success) {
    throw new Error(
      "فشل إنشاء القيد التلقائي: " +
        (result ? result.message : "خطأ غير معروف"),
    );
  }
}
// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-10  Accounting — Auto-Journal Integration (الربط التلقائي)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * autoJournalFromSale — قيد تلقائي من المبيعات (صادر)
 * يُستدعى عند إنشاء حركة صادر
 */
function autoJournalFromSale(txData) {
  try {
    if (!txData || !txData.item_id || !txData.quantity)
      return { success: false, message: "بيانات غير كافية" };

    // [AUDIT-FIX-2026-08-08 §RISK-1] كانت هذه الدالة (مسار حركات المخزون
    // المباشرة OUT/DISPATCH بدون فاتورة) لا تفرض نفس بوابة الفحص المُسبق
    // المطبَّقة في addSaleInvoice (verifyPostingSetupComplete)، فلو لم تكن
    // الحسابات الأساسية مربوطة صراحة كانت تعتمد بالكامل على fallback
    // بالاسم (hints) وقد تُكمل بصمت بقيد ناقص. الآن تُرفض الحركة صراحةً
    // بدل قبولها بقيد غير مكتمل — راجع تقرير المراجعة، Risk Register #1.
    var _saleReqKeys = [
      "cash_account",
      "ar_account",
      "revenue_account",
      "inventory_account",
      "cogs_account",
    ];
    var _saleSetupCheck =
      typeof verifyPostingSetupComplete === "function"
        ? verifyPostingSetupComplete(_saleReqKeys)
        : { complete: true };
    if (!_saleSetupCheck.complete) {
      return {
        success: false,
        message:
          typeof _postingSetupErrorMessage === "function"
            ? _postingSetupErrorMessage(_saleSetupCheck.missing)
            : "إعدادات ربط الحسابات المحاسبية غير مكتملة: " +
              (_saleSetupCheck.missing || []).join(", "),
      };
    }

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var item = items.find(function (i) {
      return i.id === txData.item_id || i.code === txData.item_id;
    });

    // [B3-FIX] البحث عن الحسابات المناسبة عبر محرك الربط الثابت بدل البحث الهش بالاسم/النوع فقط
    var revenueAcc = _getDefaultAccount(
      "revenue_account",
      accounts,
      "REVENUE",
      ["إيرادات المبيعات", "مبيعات", "sales revenue", "إيرادات"],
    );
    var cashAcc = _getDefaultAccount("cash_account", accounts, "ASSET", [
      "الصندوق",
      "خزينة رئيسية",
      "خزنة",
      "نقدية",
      "cash",
    ]);
    var cogsAcc = _getDefaultAccount("cogs_account", accounts, "EXPENSE", [
      "تكلفة البضاعة المباعة",
      "تكلفة المبيعات",
      "تكلفة",
      "cogs",
    ]);
    var inventoryAcc = _getDefaultAccount(
      "inventory_account",
      accounts,
      "ASSET",
      ["مخزون", "بضاعة", "inventory", "stock"],
    );

    // [ITEM-POSTING-WIRE-GAP-FIX-2026-08-08] كانت autoJournalFromSale
    // (تُستخدم لحركات OUT/DISPATCH المباشرة غير المرتبطة بفاتورة) تتجاهل
    // حسابات الصنف الخاصة (sales_account_id/cogs_account_id/
    // inventory_account_id) وتستخدم الحساب العام دائماً — على عكس مسار
    // الفواتير في Code_20c_Invoices.js الذي يطبّق override على مستوى
    // الصنف. النتيجة: صنف له حساب إيراد/مخزون مختلف (مثلاً فئة منتجات
    // لها حساب مبيعات فرعي) كان يُرحَّل خطأ على الحساب العام لو خرج
    // كحركة مخزون مباشرة بدل فاتورة.
    var accountsByIdSale = _buildAccountsByIdMap(accounts);
    revenueAcc = resolveItemLevelAccount(
      item, "sales_account_id", accountsByIdSale, "REVENUE", revenueAcc,
    );
    cogsAcc = resolveItemLevelAccount(
      item, "cogs_account_id", accountsByIdSale, "EXPENSE", cogsAcc,
    );
    inventoryAcc = resolveItemLevelAccount(
      item, "inventory_account_id", accountsByIdSale, "ASSET", inventoryAcc,
    );

    // [FIX-AR-INVENTORY-SALE] كانت الدالة تفترض دائماً أن البيع نقدي وتُقيّد
    // على حساب الصندوق حتى لو كانت الحركة مرتبطة بعميل (tx.party) — على
    // عكس autoJournalFromPurchase التي تفرّق صح بين مورد (AP) ونقدية.
    // النتيجة: صندوق وهمي أعلى من الحقيقي، وذمم مدينة (AR) للعميل لا تُسجَّل
    // إطلاقاً لأي عملية بيع مباشرة من المخزون (OUT/DISPATCH) بدون فاتورة.
    var arAcc = null;
    var resolvedCustomerId = null;
    if (txData.party) {
      resolvedCustomerId = _resolvePartyIdByName(txData.party, "customer");
      var customersForAr = readSheet("Customers", CUSTOMER_HEADERS);
      var custRecForAr = customersForAr.find(function (c) {
        return c.id === resolvedCustomerId;
      });
      var arResolved = resolvePostingAccount({
        accounts: accounts,
        key: "ar_account",
        type: "ASSET",
        hints: ["ذمم مدينة", "عملاء", "accounts receivable", "مدينين"],
        entityAccountId: custRecForAr && custRecForAr.account_id,
      });
      arAcc = arResolved.account;
    }

    var lines = [];
    var sellingPrice =
      Number(item ? item.selling_price : 0) * Number(txData.quantity);
    // [AUDIT-FIX-2026-08-08 §RISK-COGS-CONSISTENCY] كانت هذه الدالة (مسار
    // حركة الصادر المباشرة بدون فاتورة) تحسب تكلفة البضاعة المباعة بسعر
    // ثابت من كارت الصنف (item.cost_price × الكمية)، بينما مسار الفاتورة
    // (_autoJournalCOGS في Code_20c_Invoices.js) يستهلك طبقات التكلفة
    // الفعلية عبر FIFO/AVCO الحقيقي (_consumeStockLots). النتيجة: نفس
    // الصنف بيتقيّم بطريقتين مختلفتين حسب مساره فقط (فاتورة أم لأ)، فيختلف
    // رصيد المخزون في الأستاذ العام عن قيمته الفعلية بطريقة التقييم
    // الرسمية للشركة مع تراكم الحركات. الحل: نستهلك نفس الطبقات هنا بنفس
    // الآلية المستخدمة في الفاتورة، بدل السعر الثابت.
    var _lotConsumption = _consumeStockLots({
      item_id: txData.item_id,
      color: txData.color || "",
      warehouse: txData.warehouse || "",
      qty_needed: Number(txData.quantity),
    });
    var costPrice = _lotConsumption.total_cost;
    if (!_lotConsumption.fully_consumed) {
      Logger.log(
        "[COGS-LOT-FIX] تحذير: طبقات التكلفة المتاحة للصنف " +
          txData.item_id +
          " لم تغطِّ الكمية المطلوبة بالكامل — القيد سيُسجَّل بتكلفة الجزء المُستهلَك فعلياً فقط.",
      );
    }

    // مدين: ذمم مدينة (عميل آجل) لو فيه طرف محدد، وإلا الصندوق (بيع نقدي)
    var debitAcc = txData.party ? arAcc || cashAcc : cashAcc || arAcc;
    if (debitAcc)
      lines.push({
        account_id: debitAcc.id,
        debit: sellingPrice,
        credit: 0,
        notes:
          (txData.party ? "بيع آجل — " : "بيع نقدي — ") +
          (item ? item.name : txData.item_id),
        party_type: txData.party ? "customer" : undefined,
        party_id: txData.party ? resolvedCustomerId : undefined,
      });
    // دائن: الإيرادات
    if (revenueAcc)
      lines.push({
        account_id: revenueAcc.id,
        debit: 0,
        credit: sellingPrice,
        notes: "إيراد مبيعات",
        party_type: txData.party ? "customer" : undefined,
        party_id: txData.party ? resolvedCustomerId : undefined,
      });

    // [ACCOUNTING-ENGINE-FIX] استخدام الدالة الداخلية مع user من txData
    // [AUDIT-FIX-2026-08-08 §RISK-1] كانت الدالة تُكمل بـ okResponse حتى
    // لو نقص حساب واحد (lines.length < 2) فيُفقَد القيد بصمت. بعد فرض
    // verifyPostingSetupComplete أعلاه هذا الاحتمال أصبح مستبعداً عملياً،
    // لكن نُبقي الفحص الصريح كـ defense-in-depth ونرفض الحركة بدل تجاهلها
    // إن حدث أي عطب غير متوقع في قراءة الحسابات.
    var _saleUser = txData.user || txData.callerUser || "SYSTEM";
    if (lines.length < 2) {
      return {
        success: false,
        message:
          "تعذّر بناء قيد مكتمل لحركة البيع — راجع ربط حسابات الصندوق/الذمم/الإيرادات",
      };
    }
    var _saleJournalResult = _addJournalEntryInternal({
      callerUser: _saleUser,
      date: txData.date || new Date().toISOString().split("T")[0],
      reference: txData.id || "",
      source_type: "SALE",
      description:
        "قيد تلقائي — صادر " +
        (item ? item.name : txData.item_id) +
        " (" +
        txData.quantity +
        " " +
        (item ? item.unit : "") +
        ")",
      lines: lines,
    });
    if (!_saleJournalResult || !_saleJournalResult.success) {
      return {
        success: false,
        message:
          "فشل ترحيل قيد البيع: " +
          (_saleJournalResult ? _saleJournalResult.message : "unknown"),
      };
    }

    // قيد تكلفة البضاعة المباعة (COGS)
    if (!cogsAcc || !inventoryAcc) {
      return {
        success: false,
        message:
          "قيد الإيراد تم ترحيله لكن تعذّر ترحيل قيد تكلفة البضاعة المباعة (COGS) — حساب COGS أو المخزون غير مربوط. راجع إعدادات ربط الحسابات",
      };
    }
    if (costPrice > 0) {
      var _cogsJournalResult = _addJournalEntryInternal({
        callerUser: _saleUser,
        date: txData.date || new Date().toISOString().split("T")[0],
        reference: txData.id || "",
        source_type: "COGS",
        description:
          "تكلفة بضاعة مباعة — " + (item ? item.name : txData.item_id),
        lines: [
          {
            account_id: cogsAcc.id,
            debit: costPrice,
            credit: 0,
            notes: "تكلفة بضاعة مباعة",
          },
          {
            account_id: inventoryAcc.id,
            debit: 0,
            credit: costPrice,
            notes: "مخزون — صادر",
          },
        ],
      });
      if (!_cogsJournalResult || !_cogsJournalResult.success) {
        return {
          success: false,
          message:
            "قيد الإيراد تم ترحيله لكن فشل ترحيل قيد COGS: " +
            (_cogsJournalResult ? _cogsJournalResult.message : "unknown"),
        };
      }
    }

    return okResponse("تم إنشاء القيد التلقائي بنجاح");
  } catch (e) {
    return errResponse("خطأ في القيد التلقائي من المبيعات: " + e.message);
  }
}
/**
 * autoJournalFromPurchase — قيد تلقائي من المشتريات (وارد)
 */
function autoJournalFromPurchase(txData) {
  try {
    if (!txData || !txData.item_id || !txData.quantity)
      return { success: false, message: "بيانات غير كافية" };

    // [AUDIT-FIX-2026-08-08 §RISK-1] نفس الفجوة الموجودة في autoJournalFromSale
    // — راجع تقرير المراجعة، Risk Register #1.
    var _purchReqKeys = ["cash_account", "ap_account", "inventory_account"];
    var _purchSetupCheck =
      typeof verifyPostingSetupComplete === "function"
        ? verifyPostingSetupComplete(_purchReqKeys)
        : { complete: true };
    if (!_purchSetupCheck.complete) {
      return {
        success: false,
        message:
          typeof _postingSetupErrorMessage === "function"
            ? _postingSetupErrorMessage(_purchSetupCheck.missing)
            : "إعدادات ربط الحسابات المحاسبية غير مكتملة: " +
              (_purchSetupCheck.missing || []).join(", "),
      };
    }

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var item = items.find(function (i) {
      return i.id === txData.item_id || i.code === txData.item_id;
    });

    var inventoryAcc = _getDefaultAccount(
      "inventory_account",
      accounts,
      "ASSET",
      ["مخزون", "بضاعة", "inventory", "stock"],
    );
    var payableAcc = _getDefaultAccount("ap_account", accounts, "LIABILITY", [
      "ذمم دائنة",
      "موردين",
      "accounts payable",
      "دائنة",
      "مورد",
    ]);
    var cashAcc = _getDefaultAccount("cash_account", accounts, "ASSET", [
      "الصندوق",
      "خزينة رئيسية",
      "خزنة",
      "نقدية",
      "بنك",
      "cash",
    ]);

    // [ITEM-POSTING-WIRE-GAP-FIX-2026-08-08] نفس فجوة autoJournalFromSale
    // — حركات IN المباشرة (غير مرتبطة بفاتورة شراء) كانت تتجاهل
    // inventory_account_id/purchase_account_id الخاص بالصنف.
    var accountsByIdPurch = _buildAccountsByIdMap(accounts);
    inventoryAcc = resolveItemLevelAccount(
      item, "inventory_account_id", accountsByIdPurch, "ASSET", inventoryAcc,
    );

    var costPrice =
      Number(item ? item.cost_price : 0) * Number(txData.quantity);
    if (!inventoryAcc || costPrice <= 0)
      return { success: false, message: "لا يوجد حساب مخزون أو سعر تكلفة" };

    var lines = [];
    lines.push({
      account_id: inventoryAcc.id,
      debit: costPrice,
      credit: 0,
      notes: "مشتريات — " + (item ? item.name : txData.item_id),
    });

    // دائن: الموردين أو النقدية
    if (txData.party && payableAcc) {
      lines.push({
        account_id: payableAcc.id,
        debit: 0,
        credit: costPrice,
        notes: "مورد — " + txData.party,
        party_type: "supplier",
        party_id: _resolvePartyIdByName(txData.party, "supplier"),
      });
    } else if (cashAcc) {
      lines.push({
        account_id: cashAcc.id,
        debit: 0,
        credit: costPrice,
        notes: "نقدية",
      });
    }

    // [ACCOUNTING-ENGINE-FIX] استخدام الدالة الداخلية مع user من txData
    // [AUDIT-FIX-2026-08-08 §RISK-1] رفض صريح بدل تجاهل القيد بصمت.
    if (lines.length < 2) {
      return {
        success: false,
        message:
          "تعذّر بناء قيد مكتمل لحركة الشراء — راجع ربط حسابات المخزون/الموردين/الصندوق",
      };
    }
    var _purchJournalResult = _addJournalEntryInternal({
      callerUser: txData.user || txData.callerUser || "SYSTEM",
      date: txData.date || new Date().toISOString().split("T")[0],
      reference: txData.id || "",
      source_type: "PURCHASE",
      description:
        "قيد تلقائي — وارد " +
        (item ? item.name : txData.item_id) +
        " (" +
        txData.quantity +
        " " +
        (item ? item.unit : "") +
        ")",
      lines: lines,
    });
    if (!_purchJournalResult || !_purchJournalResult.success) {
      return {
        success: false,
        message:
          "فشل ترحيل قيد الشراء: " +
          (_purchJournalResult ? _purchJournalResult.message : "unknown"),
      };
    }

    return okResponse("تم إنشاء القيد التلقائي بنجاح");
  } catch (e) {
    return errResponse("خطأ في القيد التلقائي من المشتريات: " + e.message);
  }
}
/**
 * autoJournalFromProduction — قيد تلقائي من الإنتاج (دالة قديمة).
 * [ملاحظة FIX-POSTING-AUDIT §4] هذه الدالة غير مستدعاة من أي مسار تنفيذي
 * حالياً — المسار الفعلي (حركات DISPATCH/FG_IN/FACTORY_RETURN في
 * Code_16_Inventory.js) يستخدم الآن _autoJournalFromProductionDispatch
 * و_autoJournalFromProductionReceipt أعلاه. تُركت هذه الدالة كما هي
 * (بدون حذف) تفادياً لكسر أي استدعاء خارجي محتمل غير مرصود بالبحث.
 */
function autoJournalFromProduction(poData) {
  try {
    if (!poData || !poData.product_id)
      return { success: false, message: "بيانات غير كافية" };

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    var wipAcc = _getDefaultAccount("wip_account", accounts, "ASSET", [
      "تشغيل",
      "WIP",
      "تحت التشغيل",
    ]);
    var inventoryAcc = _getDefaultAccount(
      "inventory_account",
      accounts,
      "ASSET",
      ["مخزون", "بضاعة", "inventory", "stock"],
    );
    var cogsAcc = _getDefaultAccount("cogs_account", accounts, "EXPENSE", [
      "تكلفة البضاعة المباعة",
      "تكلفة المبيعات",
      "تكلفة",
      "cogs",
    ]);

    // [A2-FIX] تكلفة حقيقية من Items.cost_price بدل القيمة الثابتة الخيالية (qty × 100)
    // التي كانت تُسجِّل أرقامًا لا صلة لها بالتكلفة الفعلية في الأستاذ العام.
    var products = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var product = products.find(function (p) {
      return p.id === poData.product_id || p.code === poData.product_id;
    });
    var unitCost = Number((product && product.cost_price) || 0);
    if (unitCost <= 0) {
      // لا يوجد سعر تكلفة معروف للمنتج — تجاهل القيد بدل تسجيل رقم خيالي
      Logger.log(
        "[A2-FIX] تجاهل قيد إنتاج — لا يوجد cost_price للمنتج " +
          poData.product_id,
      );
      return {
        success: false,
        message: "لا يوجد سعر تكلفة (cost_price) محدد لهذا المنتج",
      };
    }
    var estCost = Number(poData.quantity || 0) * unitCost;

    var lines = [];
    if (wipAcc)
      lines.push({
        account_id: wipAcc.id,
        debit: estCost,
        credit: 0,
        notes: "إنتاج — " + poData.product_id,
      });
    if (inventoryAcc && !wipAcc)
      lines.push({
        account_id: inventoryAcc.id,
        debit: estCost,
        credit: 0,
        notes: "إنتاج — " + poData.product_id,
      });
    if (cogsAcc)
      lines.push({
        account_id: cogsAcc.id,
        debit: 0,
        credit: estCost,
        notes: "تكلفة إنتاج",
      });

    // [ACCOUNTING-ENGINE-FIX] استخدام الدالة الداخلية مع user من poData
    if (lines.length >= 2) {
      _addJournalEntryInternal({
        callerUser: poData.user || poData.callerUser || "SYSTEM",
        date: poData.date || new Date().toISOString().split("T")[0],
        reference: poData.id || "",
        source_type: "PRODUCTION",
        description:
          "قيد تلقائي — إنتاج " +
          poData.product_id +
          " (كمية: " +
          poData.quantity +
          ")",
        lines: lines,
      });
    }

    return okResponse("تم إنشاء القيد التلقائي بنجاح");
  } catch (e) {
    return errResponse("خطأ في القيد التلقائي من الإنتاج: " + e.message);
  }
}
// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 19865-20272] Accounting Engine Extras ┄┄┄
// [ACCOUNTING-ENGINE] دوال قيود تلقائية إضافية — تحويل مخزون / مرتجعات
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * [FIX-POSTING-AUDIT §4] _autoJournalFromProductionDispatch / _autoJournalFromProductionReceipt
 * ─────────────────────────────────────────────────────────────────────────
 * كانت حركتا DISPATCH (صرف خام للمصنع) وFG_IN/FACTORY_RETURN (استلام
 * منتج تام أو مرتجع خام من المصنع) تُمرَّران عبر autoJournalFromSale/
 * autoJournalFromPurchase — أي أن كل صرف خام للمصنع كان يُنشئ قيد "بيع"
 * وهمي (مدين ذمم/صندوق، دائن إيرادات بسعر البيع!) وكل استلام منتج تام
 * كان يُنشئ قيد "شراء" وهمي (دائن موردين/صندوق) — قيود لا علاقة لها
 * بحركة داخلية بين حالتي مخزون (خام ↔ تحت التشغيل)، تُضخّم الإيرادات
 * والذمم بلا مبرر. الدالتان هنا تستخدمان حساب "تحت التشغيل" (WIP)
 * الصحيح محاسبياً بدلاً من ذلك، وتماماً بنفس فلسفة autoJournalFromProduction
 * الموجودة (لكنها كانت غير مستخدَمة إطلاقاً في أي مسار تنفيذي).
 */
function _autoJournalFromProductionDispatch(txData) {
  try {
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    var wipAcc = _getDefaultAccount("wip_account", accounts, "ASSET", [
      "تحت التشغيل",
      "wip",
      "إنتاج تحت التشغيل",
    ]);
    var inventoryAcc = _getDefaultAccount(
      "inventory_account",
      accounts,
      "ASSET",
      ["مخزون", "بضاعة", "inventory", "stock"],
    );
    if (!wipAcc || !inventoryAcc) {
      Logger.log(
        "[PRODUCTION-DISPATCH] تجاوز القيد: حساب WIP أو المخزون غير مربوط",
      );
      return { success: false, message: "حساب WIP أو المخزون غير مربوط" };
    }
    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var item = items.find(function (i) {
      return i.id === txData.item_id || i.code === txData.item_id;
    });
    // [ITEM-POSTING-WIRE-GAP-FIX-2026-08-08] نفس نمط الفجوة: حساب المخزون
    // الخاص بالصنف (خام) كان بيتجاهل — نطبّق override زي باقي المسارات.
    inventoryAcc = resolveItemLevelAccount(
      item, "inventory_account_id", _buildAccountsByIdMap(accounts), "ASSET", inventoryAcc,
    );
    // [AUDIT-FIX-2026-08-09 §RISK-COGS-CONSISTENCY-3] كانت هذه الدالة
    // بتحسب تكلفة صرف الخام للمصنع بسعر ثابت (item.cost_price) من غير أي
    // استهلاك فعلي لطبقات StockLots — يعني طبقة تكلفة الخام دي كانت تفضل
    // "متاحة" في الجدول رغم إنها اتصرفت فعليًا للمصنع، وممكن تتاح تاني
    // غلط لعملية بيع أو صرف تاني لاحقًا لنفس الصنف (استهلاك مضاعف لنفس
    // الطبقة). الحل: نفس محرك الاستهلاك المستخدم في البيع والوارد.
    var _lotConsumptionWip = _consumeStockLots({
      item_id: txData.item_id,
      color: txData.color || "",
      warehouse: txData.warehouse || "",
      qty_needed: Number(txData.quantity),
    });
    var costPrice = _lotConsumptionWip.total_cost;
    if (!_lotConsumptionWip.fully_consumed) {
      Logger.log(
        "[COGS-LOT-FIX] تحذير: طبقات التكلفة المتاحة لخام " +
          txData.item_id +
          " لم تغطِّ كمية الصرف للمصنع بالكامل.",
      );
    }
    if (costPrice <= 0) return { success: false, message: "لا توجد تكلفة" };

    return _addJournalEntryInternal({
      callerUser: txData.user || txData.callerUser || "SYSTEM",
      date: txData.date || new Date().toISOString().split("T")[0],
      reference: txData.id || "",
      source_type: "PRODUCTION_DISPATCH",
      description:
        "صرف خام للمصنع (تحت التشغيل) — " +
        (item ? item.name : txData.item_id),
      lines: [
        {
          account_id: wipAcc.id,
          debit: costPrice,
          credit: 0,
          notes: "تحت التشغيل — استلام خام",
        },
        {
          account_id: inventoryAcc.id,
          debit: 0,
          credit: costPrice,
          notes: "مخزون — صرف للمصنع",
        },
      ],
    });
  } catch (e) {
    Logger.log("[PRODUCTION-DISPATCH] خطأ: " + e.message);
    return { success: false, message: e.message };
  }
}

function _autoJournalFromProductionReceipt(txData) {
  try {
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    var wipAcc = _getDefaultAccount("wip_account", accounts, "ASSET", [
      "تحت التشغيل",
      "wip",
      "إنتاج تحت التشغيل",
    ]);
    // FG_IN (منتج تام) يُقيَّد أولاً وأخيراً على حساب "بضاعة تامة الصنع"
    // المخصَّص إن وُجد، وإلا فعلى حساب المخزون العام (fallback يحافظ على
    // التوازن حتى لو لم يُفعَّل حساب مخصص للمنتج التام).
    var isFinishedGoods = String(txData.type || "").toUpperCase() === "FG_IN";
    var destAcc = isFinishedGoods
      ? _getDefaultAccount("finished_goods_account", accounts, "ASSET", [
          "بضاعة تامة",
          "منتج نهائي",
          "finished goods",
        ]) ||
        _getDefaultAccount("inventory_account", accounts, "ASSET", [
          "مخزون",
          "بضاعة",
          "inventory",
          "stock",
        ])
      : _getDefaultAccount("inventory_account", accounts, "ASSET", [
          "مخزون",
          "بضاعة",
          "inventory",
          "stock",
        ]);
    if (!wipAcc || !destAcc) {
      Logger.log(
        "[PRODUCTION-RECEIPT] تجاوز القيد: حساب WIP أو المخزون/البضاعة التامة غير مربوط",
      );
      return {
        success: false,
        message: "حساب WIP أو المخزون/البضاعة التامة غير مربوط",
      };
    }
    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var item = items.find(function (i) {
      return i.id === txData.item_id || i.code === txData.item_id;
    });
    // [ITEM-POSTING-WIRE-GAP-FIX-2026-08-08] مرتجع الخام (غير FG) لازم
    // يحترم inventory_account_id الخاص بصنف الخام لو معرَّف. البضاعة
    // التامة الصنع مالهاش حقل حساب مستقل على مستوى الصنف حالياً فتفضل
    // على finished_goods_account العام.
    if (!isFinishedGoods) {
      destAcc = resolveItemLevelAccount(
        item, "inventory_account_id", _buildAccountsByIdMap(accounts), "ASSET", destAcc,
      );
    }
    var costPrice =
      Number(item ? item.cost_price : 0) * Number(txData.quantity);
    if (costPrice <= 0) return { success: false, message: "لا توجد تكلفة" };

    var _journalPayload = {
      callerUser: txData.user || txData.callerUser || "SYSTEM",
      date: txData.date || new Date().toISOString().split("T")[0],
      reference: txData.id || "",
      source_type: isFinishedGoods
        ? "PRODUCTION_FG_RECEIPT"
        : "PRODUCTION_MATERIAL_RETURN",
      description:
        (isFinishedGoods
          ? "استلام منتج تام من المصنع — "
          : "مرتجع خام من المصنع — ") + (item ? item.name : txData.item_id),
      lines: [
        {
          account_id: destAcc.id,
          debit: costPrice,
          credit: 0,
          notes: isFinishedGoods ? "بضاعة تامة الصنع" : "مخزون — مرتجع خام",
        },
        {
          account_id: wipAcc.id,
          debit: 0,
          credit: costPrice,
          notes: "تحت التشغيل — تصفية",
        },
      ],
    };
    var _jRes = _addJournalEntryInternal(_journalPayload);
    if (_jRes && _jRes.success) {
      // [AUDIT-FIX-2026-08-09 §RISK-LOT-GAP-CRITICAL-3] بدون هذا، أي
      // منتج تام خارج من المصنع (أو خام مُرتجع منه) كان يدخل الأستاذ
      // العام والمخزون بالكمية فقط من غير طبقة تكلفة — فبيعه لاحقًا كان
      // هيحسب COGS ناقص/صفر بصمت، بالظبط زي فجوة الوارد المباشر ومرتجع
      // البيع اللي اتصلحت قبل كده.
      try {
        _createStockLot({
          item_id: txData.item_id,
          color: txData.color || "",
          warehouse: txData.warehouse || "",
          qty: Number(txData.quantity),
          unit_cost: Number(txData.quantity) > 0 ? costPrice / Number(txData.quantity) : 0,
          source_type: isFinishedGoods ? "PRODUCTION_FG_RECEIPT" : "PRODUCTION_MATERIAL_RETURN",
          source_id: txData.id || "",
          lot_date: txData.date || new Date().toISOString().split("T")[0],
        });
      } catch (lotErr3) {
        Logger.log(
          "[COGS-LOT-FIX] فشل إنشاء طبقة تكلفة لاستلام إنتاج " +
            (txData.id || "") + ": " + lotErr3.message,
        );
      }
    }
    return _jRes;
  } catch (e) {
    Logger.log("[PRODUCTION-RECEIPT] خطأ: " + e.message);
    return { success: false, message: e.message };
  }
}

/**
 * _autoJournalFromInventoryTransfer
 * تحويل بين مستودعات: القيد داخلي — مدين مخزون مستودع الوصول، دائن مخزون مستودع المصدر.
 * كلا الحسابين هما نفس حساب المخزون (Asset) في معظم الحالات، لذا القيد محايد ماليًا
 * لكنه ضروري لإظهار الحركة في دفتر الأستاذ وكشوف المخزون.
 */
// ─────────────────────────────────────────────────────────────
// [WASTE-FEATURE-2026-08-07] _autoJournalFromWaste — قيد تلقائي لحركة هالك
// المخزون (تلف/فقد/راكد اتقرر شطبه). محاسبيًا:
//   مدين:  مصروف الهالك (scrap_waste_account) — أو حساب فروق تسوية
//          المخزون الخاص بالصنف (inventory_adjustment_account_id) لو معرَّف
//   دائن:  المخزون (inventory_account_id الخاص بالصنف ← الافتراضي العام)
// بالتكلفة الفعلية (cost_price) وقت الحركة — لا يوجد أي إيراد أو ذمم
// عميل، لأنها ليست عملية بيع.
// ─────────────────────────────────────────────────────────────
function _autoJournalFromWaste(txData) {
  try {
    var qty = Number(txData.quantity || 0);
    if (qty <= 0) return;

    var items = readSheet("Items");
    var item = items.find(function (i) {
      return i.id === txData.item_id || i.code === txData.item_id;
    });
    var unitCost = Number((item && item.cost_price) || 0);
    var amount = qty * unitCost;
    if (amount <= 0) {
      Logger.log(
        "[WASTE-FEATURE] تجاهل قيد هالك — لا يوجد cost_price للصنف " +
          txData.item_id,
      );
      return;
    }

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var accountsByIdW = _buildAccountsByIdMap(accounts);

    var inventoryAcc = _getDefaultAccount(
      "inventory_account",
      accounts,
      "ASSET",
      ["مخزون", "بضاعة", "inventory", "stock"],
    );
    inventoryAcc = resolveItemLevelAccount(
      item, "inventory_account_id", accountsByIdW, "ASSET", inventoryAcc,
    );

    var wasteAcc = _getDefaultAccount(
      "scrap_waste_account",
      accounts,
      "EXPENSE",
      ["هالك إنتاج", "راكد", "scrap", "waste", "هالك"],
    );
    // [ITEM-POSTING-WIRE] حساب فروق/تسوية المخزون الخاص بالصنف كبديل أولوية
    // لو معرَّف، وإلا حساب الهالك العام
    wasteAcc = resolveItemLevelAccount(
      item, "inventory_adjustment_account_id", accountsByIdW, "EXPENSE", wasteAcc,
    );

    if (!inventoryAcc || !wasteAcc) {
      Logger.log(
        "[WASTE-FEATURE] تجاهل قيد هالك — لا يوجد حساب مخزون أو حساب هالك في دليل الحسابات (راجع إعدادات الترحيل: scrap_waste_account)",
      );
      try {
        AuditEngine.log("WASTE_JOURNAL_FAILED", {
          user: (txData && txData.callerUser) || "SYSTEM",
          table: "Transactions",
          record_id: txData.id || "",
          details:
            "لم يتم إنشاء قيد هالك للحركة " +
            (txData.id || "") +
            " — حساب الهالك أو حساب المخزون غير مُعرَّف في دليل الحسابات.",
        });
      } catch (auditErr) {
        Logger.log("[WASTE-FEATURE] فشل تسجيل تنبيه AuditLog: " + auditErr.message);
      }
      return;
    }

    var lines = [
      {
        account_id: wasteAcc.id,
        debit: amount,
        credit: 0,
        notes: "هالك/تلف مخزون — " + (item ? item.name : txData.item_id),
      },
      {
        account_id: inventoryAcc.id,
        debit: 0,
        credit: amount,
        notes: "خروج المخزون بالتكلفة — هالك",
      },
    ];
    _applyCostCenterToLines(lines, txData.cost_center_id);

    var result = _addJournalEntryInternal({
      callerUser: txData.callerUser || txData.user || "SYSTEM",
      date: txData.date || new Date().toISOString().split("T")[0],
      reference: txData.id || "",
      description:
        "هالك مخزون — " + (item ? item.name : txData.item_id) + " (" + (txData.notes || "") + ")",
      source_type: "WASTE",
      lines: lines,
    });
    if (!result || !result.success) {
      Logger.log(
        "[WASTE-FEATURE] فشل قيد هالك " + (txData.id || "") + ": " +
          (result ? result.message : "unknown"),
      );
    }
  } catch (e) {
    Logger.log("[WASTE-FEATURE] _autoJournalFromWaste error: " + e.message);
  }
}

function _autoJournalFromInventoryTransfer(txData) {
  try {
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );

    // [FIX] كانت هذه الدالة تبحث عن "حساب مخزون" واحد بالاسم يدوياً وتتجاهل
    // تماماً عمود Warehouses.account_id الموجود بالفعل في هيكل البيانات لهذا
    // الغرض بالضبط، وكانت تستخدم نفس الحساب للمدين والدائن حتى لو المخزنين
    // لهما حسابات GL مختلفة (خطأ محاسبي: قيمة المخزون في كل مخزن لا تُفصل).
    // الحل: نحلّ حساب كل مخزن على حدة عبر resolvePostingAccount
    // (Entity Override الخاص بالمخزن ← Global Default "inventory_account").
    var warehouses = readSheet("Warehouses", WAREHOUSE_HEADERS, {
      trimStrings: true,
    });
    var fromWh = warehouses.find(function (w) {
      return w.name === txData.from_warehouse || w.id === txData.from_warehouse;
    });
    var toWh = warehouses.find(function (w) {
      return w.name === txData.to_warehouse || w.id === txData.to_warehouse;
    });

    var invHints = ["مخزون", "بضاعة", "inventory"];
    var fromResolved = resolvePostingAccount({
      accounts: accounts,
      key: "inventory_account",
      type: "ASSET",
      hints: invHints,
      entityAccountId: fromWh && fromWh.account_id,
    });
    var toResolved = resolvePostingAccount({
      accounts: accounts,
      key: "inventory_account",
      type: "ASSET",
      hints: invHints,
      entityAccountId: toWh && toWh.account_id,
    });
    var fromInventoryAcc = fromResolved.account;
    var toInventoryAcc = toResolved.account;
    if (!fromInventoryAcc || !toInventoryAcc) return; // لا قيد بدون حساب مخزون معروف لكل طرف

    var items = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
    var item = items.find(function (i) {
      return i.id === txData.item_id || i.code === txData.item_id;
    });
    var costPrice =
      Number(item ? item.cost_price : 0) * Number(txData.quantity);
    if (costPrice <= 0) return;

    _addJournalEntryInternal({
      callerUser: txData.user || txData.callerUser || "SYSTEM",
      date: txData.date || new Date().toISOString().split("T")[0],
      reference: txData.id || "",
      source_type: "INVENTORY_TRANSFER",
      description:
        "تحويل مخزون — " +
        (txData.from_warehouse || "") +
        " → " +
        (txData.to_warehouse || "") +
        " | " +
        (item ? item.name : txData.item_id),
      lines: [
        {
          account_id: toInventoryAcc.id,
          debit: costPrice,
          credit: 0,
          notes: "وصول — " + (txData.to_warehouse || ""),
        },
        {
          account_id: fromInventoryAcc.id,
          debit: 0,
          credit: costPrice,
          notes: "مصدر — " + (txData.from_warehouse || ""),
        },
      ],
    });
  } catch (e) {
    Logger.log("[autoJournal] خطأ في قيد تحويل المخزون: " + e.message);
  }
}
/**
 * _autoJournalSaleReturn
 * مرتجع مبيعات: عكس قيد فاتورة البيع
 * مدين: إيرادات المبيعات (عكس) + ضريبة القيمة المضافة
 * دائن: ذمم مدينة / نقدية
 */
// ─────────────────────────────────────────────────────────────
// [ITEM-POSTING-WIRE-2026-08-07] _pushReturnLinesByItem — يوزّع مبلغ سطر
// واحد (إيراد مرتجع مبيعات أو مخزون مرتجع مشتريات) على حساب كل صنف حسب
// itemFieldKey (sales_return_account_id / purchase_return_account_id /
// inventory_account_id)، بدل حساب عام واحد للمرتجع كله. side تحدد هل
// السطر الناتج مدين أم دائن. أي خطأ أو نقص بيانات → رجوع فوري لسطر واحد
// عام (نفس السلوك القديم) لضمان عدم كسر توازن القيد.
// ─────────────────────────────────────────────────────────────
function _pushReturnLinesByItem(lines, ret, accounts, fallbackAccount, itemFieldKey, expectedType, totalToDistribute, noteLabel, side) {
  function pushFallbackSingleLine() {
    if (!fallbackAccount || totalToDistribute <= 0) return;
    var line = { account_id: fallbackAccount.id, debit: 0, credit: 0, notes: noteLabel };
    line[side] = totalToDistribute;
    lines.push(line);
  }
  if (!totalToDistribute || totalToDistribute <= 0) return;
  try {
    var retLines = ret.lines_json;
    if (typeof retLines === "string") {
      try { retLines = JSON.parse(retLines); } catch (e) { retLines = []; }
    }
    if (!Array.isArray(retLines) || !retLines.length) { pushFallbackSingleLine(); return; }

    var itemsData = readSheet("Items");
    var accountsById = _buildAccountsByIdMap(accounts);
    var lineShares = retLines
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
      var acc = resolveItemLevelAccount(itemRec, itemFieldKey, accountsById, expectedType, fallbackAccount);
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
        var line = { account_id: accId, debit: 0, credit: 0, notes: noteLabel };
        line[side] = amt;
        lines.push(line);
      }
    });
  } catch (e) {
    Logger.log("[ITEM-POSTING-WIRE] فشل توزيع سطر المرتجع حسب حساب الصنف، رجوع لسطر عام: " + e.message);
    pushFallbackSingleLine();
  }
}

function _autoJournalSaleReturn(ret, callerUser) {
  try {
    if (!ret || !ret.net_total || Number(ret.net_total) <= 0) return;
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );

    // [POSTING-ENGINE-FIX] استخدام _getDefaultAccount بدل _findAccountByNameHints
    // يضمن أن تغيير اسم الحساب لا يكسر القيود التلقائية
    // [ACCOUNT-MAP] حساب الذمم المدينة: Entity Override (العميل) ← Global Default
    // [FIX] كانت هذه الدالة تستخدم _getDefaultAccount مباشرة بدون المرور على
    // Customers.account_id — فلو عميل معيّن له حساب ذمم خاص، فاتورته الأصلية
    // كانت تُرحَّل على حسابه الخاص لكن مرتجعه يُرحَّل على الحساب العام —
    // تناقض محاسبي (رصيد العميل الخاص لا يتأثر بالمرتجع الذي يخصه).
    var returnCustomerId = _resolvePartyIdByName(ret.party, "customer");
    var returnCustomerRec = null;
    if (returnCustomerId) {
      var customersForReturn = readSheet("Customers", CUSTOMER_HEADERS);
      returnCustomerRec = customersForReturn.find(function (c) {
        return c.id === returnCustomerId;
      });
    }
    var arResolvedReturn = resolvePostingAccount({
      accounts: accounts,
      key: "ar_account",
      type: "ASSET",
      hints: ["ذمم مدينة", "عملاء", "accounts receivable", "مدينين"],
      entityAccountId: returnCustomerRec && returnCustomerRec.account_id,
    });
    var arAccount = arResolvedReturn.account;
    var cashAccount = _getDefaultAccount("cash_account", accounts, "ASSET", [
      "الصندوق",
      "خزينة رئيسية",
      "cash",
      "صندوق",
    ]);
    var revenueAccount = _getDefaultAccount(
      "sales_return_account",
      accounts,
      "REVENUE",
      ["مردودات المبيعات", "مرتجع مبيعات", "sales return"],
    );
    var vatAccount = _getDefaultAccount(
      "vat_output_account",
      accounts,
      "LIABILITY",
      ["ضريبة القيمة المضافة", "ضريبة مبيعات", "vat"],
    );

    var totalAmount = Number(ret.net_total || 0);
    var vatAmount = Number(ret.vat_amount || 0);
    var revenueAmount = totalAmount - vatAmount;
    var creditAccount = arAccount || cashAccount;
    if (!creditAccount || !revenueAccount) return;

    var lines = [];
    if (revenueAmount > 0) {
      // [ITEM-POSTING-WIRE-2026-08-07] توزيع عكس الإيراد على حساب
      // sales_return_account_id الخاص بكل صنف بدل حساب مردودات عام واحد —
      // نفس مبدأ _pushRevenueLinesForInvoice في فاتورة البيع الأصلية.
      _pushReturnLinesByItem(
        lines, ret, accounts, revenueAccount, "sales_return_account_id",
        "REVENUE", revenueAmount, "مرتجع مبيعات — عكس إيراد", "debit",
      );
    }
    if (vatAccount && vatAmount > 0)
      lines.push({
        account_id: vatAccount.id,
        debit: vatAmount,
        credit: 0,
        notes: "عكس ضريبة مبيعات",
      });
    lines.push({
      account_id: creditAccount.id,
      debit: 0,
      credit: totalAmount,
      notes: ret.party ? "مرتجع من عميل: " + ret.party : "مرتجع مبيعات",
    });
    if (lines.length < 2) return;

    var mainReturnJeResult = _addJournalEntryInternal({
      callerUser: callerUser || ret.created_by || "SYSTEM",
      date: ret.date || new Date().toISOString().split("T")[0],
      reference: ret.id,
      source_type: "SALE_RETURN",
      description: "مرتجع مبيعات — " + (ret.party || ""),
      lines: lines,
    });
    // [JOURNAL-SYNC-2026-08-12 §RETURN-JE-SILENT-FAIL] كان الرد من
    // _addJournalEntryInternal (لا يرمي استثناء أبداً — يرجع
    // {success:false} دايمًا عند الفشل: فترة محاسبية مقفولة، حساب غير
    // موجود، قفل مشغول...) بيتجاهَل بالكامل هنا، فيستمر تنفيذ الدالة
    // (بما فيه عكس StockLot تحت) رغم إن القيد الرئيسي (تخفيض ذمم العميل/
    // عكس الإيراد) لم يُرحَّل إطلاقاً. النتيجة: مرتجع بيع "مكتمل" في نظر
    // المستخدم (المخزون رجع، الطبقة اتعملت) بدون أي أثر في حساب العميل —
    // تناقض محاسبي صامت بدون أي تنبيه مرئي. نسجّل تحذيرًا واضحًا في سجل
    // التدقيق (نفس نمط COGS_JOURNAL_FAILED) بدل الصمت الكامل، مع الإبقاء
    // على نفس سلوك عدم إيقاف العملية (نفس القرار المعماري المتبع في إصلاح
    // _autoJournalCOGS — تغيير success/failure على مستوى المستند نفسه
    // يتطلب عكس حركة المخزون/الفاتورة كاملة، وهو تغيير أوسع لم يُطلب هنا).
    if (!mainReturnJeResult || !mainReturnJeResult.success) {
      Logger.log(
        "[RETURN-JE-FIX] فشل ترحيل القيد الرئيسي لمرتجع مبيعات " +
          (ret.id || "") +
          ": " +
          (mainReturnJeResult ? mainReturnJeResult.message : "unknown"),
      );
      try {
        AuditEngine.log("SALE_RETURN_JOURNAL_FAILED", {
          user: callerUser || ret.created_by || "SYSTEM",
          table: "SaleReturns",
          record_id: ret.id,
          details:
            " فشل ترحيل القيد الرئيسي لمرتجع مبيعات " +
            (ret.id || "") +
            ": " +
            (mainReturnJeResult ? mainReturnJeResult.message : "unknown") +
            " — رصيد العميل لم يتأثر رغم تسجيل المرتجع. يحتاج مراجعة يدوية من المحاسب."});
      } catch (auditErrRet) {
        Logger.log(
          "[RETURN-JE-FIX] فشل تسجيل تنبيه AuditLog: " + auditErrRet.message,
        );
      }
    }

    // ─── [C2-FIX] عكس قيد التكلفة (COGS) عند مرتجع المبيعات ───────────────
    // قاعدة محاسبية: عند رجوع البضاعة من العميل:
    //   مدين:  المخزون (Inventory)  ← البضاعة عادت للمخزن
    //   دائن:  تكلفة البضاعة المباعة (COGS)  ← عكس التكلفة المُسجَّلة
    // بدون هذا القيد: المخزون مُقلَّل بصورة دائمة والتكلفة مُضخَّمة
    // ────────────────────────────────────────────────────────────────────────
    try {
      // احسب التكلفة من بنود المرتجع (إن أُرسلت) أو من فاتورة الأصل
      var returnLines = ret.lines_json;
      if (typeof returnLines === "string") {
        try {
          returnLines = JSON.parse(returnLines);
        } catch (e) {
          returnLines = [];
        }
      }
      var totalCost = 0;
      var returnItemCostMap = {}; // [ITEM-POSTING-WIRE-2026-08-07] item_id -> cost
      if (Array.isArray(returnLines) && returnLines.length > 0) {
        // جلب أسعار التكلفة من Items (سيرفر-سايد لمنع التلاعب) — يُستخدم
        // كـ fallback فقط الآن (راجع التعليق التالي).
        var itemsForCost = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
        var itemsByIdForCost = {};
        itemsForCost.forEach(function (it) {
          itemsByIdForCost[it.id] = it;
          if (it.code) itemsByIdForCost[it.code] = it;
        });
        // [AUDIT-FIX-2026-08-09 §RISK-7-RETURN-COST-BASIS] لو المرتجع مربوط
        // بفاتورة بيع أصلية (ret.original_invoice_id)، نجيب التكلفة الفعلية
        // اللي اتسجلت وقت البيع الحقيقي (InvoiceCOGSBreakdown، مكتوبة من
        // _autoJournalCOGS عبر استهلاك FIFO/AVCO الفعلي) بدل سعر اليوم —
        // بيحل التناقض المحاسبي تحت تقلبات أسعار FIFO. لو الفاتورة قديمة
        // من قبل هذا التحديث (مفيش سجل)، أو المرتجع مش مربوط بفاتورة، بنرجع
        // لسلوك fallback القديم (سعر اليوم) بدل ما نفشل العملية.
        var originalCostByItem = {};
        if (String(ret.original_invoice_id || "").trim()) {
          try {
            var _breakdownRows = readSheet(
              "InvoiceCOGSBreakdown",
              ACCOUNTING_HR_HEADERS.InvoiceCOGSBreakdown,
              { trimStrings: true },
            );
            _breakdownRows.forEach(function (r) {
              if (String(r.invoice_id) === String(ret.original_invoice_id).trim()) {
                originalCostByItem[r.item_id] = Number(r.unit_cost || 0);
              }
            });
          } catch (bkErr) {
            Logger.log(
              "[COGS-BREAKDOWN] فشل قراءة تكلفة الفاتورة الأصلية للمرتجع " +
                (ret.id || "") + ": " + bkErr.message,
            );
          }
        }
        totalCost = returnLines.reduce(function (sum, line) {
          var qty = Number(line.qty || line.quantity || 0);
          var itemRef = itemsByIdForCost[line.item_id];
          var originalCost = originalCostByItem[line.item_id];
          var cost =
            originalCost > 0
              ? originalCost
              : Number((itemRef && itemRef.cost_price) || line.cost_price || 0);
          var lineCost = qty * cost;
          if (line.item_id) {
            returnItemCostMap[line.item_id] = (returnItemCostMap[line.item_id] || 0) + lineCost;
          }
          // [AUDIT-FIX-2026-08-08 §RISK-LOT-GAP-CRITICAL-2] _restoreStockLot
          // (Code_03_Accounting_Costing.js) موجودة بالضبط لهذا الغرض —
          // "ننشئ طبقة جديدة بالتكلفة الأصلية حسب سعر التكلفة في وقت
          // الإرجاع" — لكنها لم تكن مُستدعاة من أي مكان في المشروع كله
          // (Dead Code)، بعكس _reverseStockLot المستخدمة فعلياً في مرتجع
          // الشراء. الأثر: مرتجع البيع كان يعمل القيد المحاسبي (Dr مخزون /
          // Cr COGS) صح، لكن من غير طبقة تكلفة فعلية في StockLots — فلو
          // الصنف اتباع تاني بعد المرتجع، _consumeStockLots ما بيلاقيش
          // طبقة كافية ويحسب COGS ناقص/صفر بصمت (نفس فئة الخطر الحرج
          // اللي اتصلح في autoJournalFromPurchase للحركة المباشرة IN).
          if (qty > 0 && cost > 0 && line.item_id) {
            try {
              _restoreStockLot({
                item_id: line.item_id,
                color: line.color || "",
                warehouse: line.warehouse || ret.warehouse || "",
                qty: qty,
                unit_cost: cost,
                source_id: ret.id,
                lot_date: ret.date || new Date().toISOString().split("T")[0],
              });
            } catch (lotErr2) {
              Logger.log(
                "[COGS-LOT-FIX] فشل إنشاء طبقة تكلفة لمرتجع البيع " +
                  (ret.id || "") + " صنف " + line.item_id + ": " +
                  lotErr2.message,
              );
            }
          }
          return sum + lineCost;
        }, 0);
      }

      if (totalCost > 0) {
        var cogsAccount = _getDefaultAccount(
          "cogs_account",
          accounts,
          "EXPENSE",
          ["تكلفة البضاعة المباعة", "تكلفة المبيعات", "تكلفة", "cogs"],
        );
        var inventoryAccount = _getDefaultAccount(
          "inventory_account",
          accounts,
          "ASSET",
          ["مخزون", "بضاعة", "inventory", "stock"],
        );
        if (cogsAccount && inventoryAccount) {
          // [ITEM-POSTING-WIRE-2026-08-07] توزيع عكس COGS على حساب
          // inventory_account_id/cogs_account_id الخاص بكل صنف — نفس مبدأ
          // _autoJournalCOGS في فاتورة البيع الأصلية.
          var revCogsLines = [];
          try {
            var accountsById2 = _buildAccountsByIdMap(accounts);
            var invOrder2 = [], invGroups2 = {}, cogsOrder2 = [], cogsGroups2 = {};
            Object.keys(returnItemCostMap).forEach(function (itemId) {
              var cost = returnItemCostMap[itemId];
              if (!cost || cost <= 0) return;
              var itemRec2 = itemsByIdForCost[itemId];
              var itemInvAcc = resolveItemLevelAccount(itemRec2, "inventory_account_id", accountsById2, "ASSET", inventoryAccount);
              var itemCogsAcc = resolveItemLevelAccount(itemRec2, "cogs_account_id", accountsById2, "EXPENSE", cogsAccount);
              if (itemInvAcc) { if (!invGroups2.hasOwnProperty(itemInvAcc.id)) { invGroups2[itemInvAcc.id] = 0; invOrder2.push(itemInvAcc.id); } invGroups2[itemInvAcc.id] += cost; }
              if (itemCogsAcc) { if (!cogsGroups2.hasOwnProperty(itemCogsAcc.id)) { cogsGroups2[itemCogsAcc.id] = 0; cogsOrder2.push(itemCogsAcc.id); } cogsGroups2[itemCogsAcc.id] += cost; }
            });
            var mappedInv2 = invOrder2.reduce(function (s, id) { return s + invGroups2[id]; }, 0);
            var mappedCogs2 = cogsOrder2.reduce(function (s, id) { return s + cogsGroups2[id]; }, 0);
            var invRem2 = Math.round((totalCost - mappedInv2) * 100) / 100;
            var cogsRem2 = Math.round((totalCost - mappedCogs2) * 100) / 100;
            if (Math.abs(invRem2) > 0.001) { if (!invGroups2.hasOwnProperty(inventoryAccount.id)) { invGroups2[inventoryAccount.id] = 0; invOrder2.push(inventoryAccount.id); } invGroups2[inventoryAccount.id] += invRem2; }
            if (Math.abs(cogsRem2) > 0.001) { if (!cogsGroups2.hasOwnProperty(cogsAccount.id)) { cogsGroups2[cogsAccount.id] = 0; cogsOrder2.push(cogsAccount.id); } cogsGroups2[cogsAccount.id] += cogsRem2; }
            if (!invOrder2.length || !cogsOrder2.length) throw new Error("no item-level mapping");
            invOrder2.forEach(function (id) { var amt = Math.round(invGroups2[id] * 100) / 100; if (amt > 0.0001) revCogsLines.push({ account_id: id, debit: amt, credit: 0, notes: "إعادة البضاعة للمخزون بالتكلفة" }); });
            cogsOrder2.forEach(function (id) { var amt = Math.round(cogsGroups2[id] * 100) / 100; if (amt > 0.0001) revCogsLines.push({ account_id: id, debit: 0, credit: amt, notes: "عكس تكلفة البضاعة المباعة" }); });
            if (!revCogsLines.length) throw new Error("empty lines");
          } catch (mapErr2) {
            Logger.log("[ITEM-POSTING-WIRE] فشل توزيع عكس COGS حسب حساب الصنف، رجوع للحسابين العامين: " + mapErr2.message);
            revCogsLines = [
              { account_id: inventoryAccount.id, debit: totalCost, credit: 0, notes: "إعادة البضاعة للمخزون بالتكلفة" },
              { account_id: cogsAccount.id, debit: 0, credit: totalCost, notes: "عكس تكلفة البضاعة المباعة" },
            ];
          }
          var cogsRevJeResult = _addJournalEntryInternal({
            callerUser: callerUser || ret.created_by || "SYSTEM",
            date: ret.date || new Date().toISOString().split("T")[0],
            reference: ret.id + "-COGS-REV",
            source_type: "SALE_RETURN_COGS",
            description: "عكس تكلفة مرتجع مبيعات — " + (ret.party || ""),
            lines: revCogsLines,
          });
          // [JOURNAL-SYNC-2026-08-12 §RETURN-JE-SILENT-FAIL] نفس الفحص
          // المضاف فوق للقيد الرئيسي — الرد كان يُتجاهَل هنا كذلك، رغم
          // إن _restoreStockLot فوق نفّذت فعلاً (الطبقة اتعملت)، فلو قيد
          // عكس COGS فشل، تبقى الطبقة مسجّلة بدون أي أثر محاسبي مقابل لها
          // (نفس فئة عيب _autoJournalCOGS الأصلي، لكن هنا في اتجاه المرتجع).
          if (!cogsRevJeResult || !cogsRevJeResult.success) {
            Logger.log(
              "[C2-FIX] فشل ترحيل قيد عكس COGS لمرتجع مبيعات " +
                (ret.id || "") +
                ": " +
                (cogsRevJeResult ? cogsRevJeResult.message : "unknown"),
            );
            try {
              AuditEngine.log("SALE_RETURN_COGS_JOURNAL_FAILED", {
                user: callerUser || ret.created_by || "SYSTEM",
                table: "SaleReturns",
                record_id: ret.id,
                details:
                  " فشل ترحيل قيد عكس تكلفة البضاعة لمرتجع مبيعات " +
                  (ret.id || "") +
                  ": " +
                  (cogsRevJeResult ? cogsRevJeResult.message : "unknown") +
                  " — تم إنشاء طبقة تكلفة (StockLot) للبضاعة المرتجعة بدون قيد محاسبي مقابل. يحتاج مراجعة يدوية."});
            } catch (auditErrCogsRet) {
              Logger.log(
                "[C2-FIX] فشل تسجيل تنبيه AuditLog: " + auditErrCogsRet.message,
              );
            }
          }
        } else {
          Logger.log(
            "[C2-FIX] تحذير: لم يُعثر على حساب COGS أو مخزون — لن يُسجَّل عكس التكلفة للمرتجع " +
              ret.id,
          );
        }
      } else {
        Logger.log(
          "[C2-FIX] تنبيه: لا يمكن حساب التكلفة للمرتجع " +
            ret.id +
            " — تحقق من cost_price في Items",
        );
      }
    } catch (cogsErr) {
      Logger.log(
        "[C2-FIX] خطأ في عكس COGS لمرتجع المبيعات: " + cogsErr.message,
      );
    }
    // ────────────────────────────────────────────────────────────────────────
  } catch (e) {
    Logger.log("[autoJournal] خطأ في قيد مرتجع المبيعات: " + e.message);
  }
}
/**
 * _autoJournalPurchaseReturn
 * مرتجع مشتريات: عكس قيد فاتورة الشراء
 * مدين: ذمم دائنة / نقدية (عكس)
 * دائن: حساب المشتريات / المخزون + ضريبة المشتريات
 *
 * [C3-FIX] إضافة قيد تخفيض المخزون:
 * قاعدة محاسبية: عند إرجاع البضاعة للمورد:
 *   مدين:  المشتريات / ذمم دائنة  ← عكس الشراء
 *   دائن:  المخزون (Inventory)     ← البضاعة خرجت من المخزن
 * بدون هذا القيد: المخزون مُضخَّم ولا يعكس الكميات الفعلية
 */
function _autoJournalPurchaseReturn(ret, callerUser) {
  try {
    if (!ret || !ret.net_total || Number(ret.net_total) <= 0) return;
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );

    // [POSTING-ENGINE-FIX] استخدام _getDefaultAccount بدل _findAccountByNameHints
    // [ACCOUNT-MAP] حساب الذمم الدائنة: Entity Override (المورد) ← Global Default
    // [FIX] نفس فجوة مرتجع المبيعات لكن هنا للمورد — بدون هذا الإصلاح كان
    // مرتجع المشتريات يُرحَّل دائماً على الحساب العام حتى لو المورد له حساب خاص.
    var returnSupplierId = _resolvePartyIdByName(ret.party, "supplier");
    var returnSupplierRec = null;
    if (returnSupplierId) {
      var suppliersForReturn = readSheet("Suppliers", SUPPLIER_HEADERS);
      returnSupplierRec = suppliersForReturn.find(function (s) {
        return s.id === returnSupplierId;
      });
    }
    var apResolvedReturn = resolvePostingAccount({
      accounts: accounts,
      key: "ap_account",
      type: "LIABILITY",
      hints: ["ذمم دائنة", "موردين", "accounts payable", "دائنة"],
      entityAccountId: returnSupplierRec && returnSupplierRec.account_id,
    });
    var apAccount = apResolvedReturn.account;
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
    var vatAccount = _getDefaultAccount(
      "vat_input_account",
      accounts,
      "ASSET",
      ["ضريبة قيمة مضافة — مشتريات", "ضريبة مشتريات", "vat input"],
    );

    var totalAmount = Number(ret.net_total || 0);
    var vatAmount = Number(ret.vat_amount || 0);
    var purchasesAmount = totalAmount - vatAmount;
    var debitAccount = apAccount || cashAccount;
    if (!debitAccount || !inventoryAccount) return;

    var lines = [];
    lines.push({
      account_id: debitAccount.id,
      debit: totalAmount,
      credit: 0,
      notes: ret.party ? "مرتجع إلى مورد: " + ret.party : "مرتجع مشتريات",
    });
    if (purchasesAmount > 0) {
      // [ITEM-POSTING-WIRE-2026-08-07] توزيع خروج المخزون على حساب
      // inventory_account_id الخاص بكل صنف بدل حساب مخزون عام واحد.
      _pushReturnLinesByItem(
        lines, ret, accounts, inventoryAccount, "inventory_account_id",
        "ASSET", purchasesAmount, "خروج البضاعة من المخزون — مرتجع مشتريات", "credit",
      );
    }
    if (vatAccount && vatAmount > 0)
      lines.push({
        account_id: vatAccount.id,
        debit: 0,
        credit: vatAmount,
        notes: "عكس ضريبة مشتريات",
      });
    if (lines.length < 2) return;

    var purchaseReturnJeResult = _addJournalEntryInternal({
      callerUser: callerUser || ret.created_by || "SYSTEM",
      date: ret.date || new Date().toISOString().split("T")[0],
      reference: ret.id,
      source_type: "PURCHASE_RETURN",
      description: "مرتجع مشتريات — " + (ret.party || ""),
      lines: lines,
    });
    // [JOURNAL-SYNC-2026-08-12 §RETURN-JE-SILENT-FAIL] نفس فحص مرتجع
    // المبيعات — الرد من _addJournalEntryInternal (لا يرمي استثناء أبداً)
    // كان يُتجاهَل بالكامل، فلو فشل (فترة مقفولة، حساب ناقص، قفل مشغول)
    // يفضل مرتجع الشراء "مكتمل" في نظر المستخدم (المخزون خُصم فعليًا عبر
    // _consumeLotForPurchaseReturn المُستدعاة من addPurchaseReturn) بدون
    // أي أثر على ذمم المورد الدائنة ولا تنبيه مرئي.
    if (!purchaseReturnJeResult || !purchaseReturnJeResult.success) {
      Logger.log(
        "[RETURN-JE-FIX] فشل ترحيل قيد مرتجع مشتريات " +
          (ret.id || "") +
          ": " +
          (purchaseReturnJeResult ? purchaseReturnJeResult.message : "unknown"),
      );
      try {
        AuditEngine.log("PURCHASE_RETURN_JOURNAL_FAILED", {
          user: callerUser || ret.created_by || "SYSTEM",
          table: "PurchaseReturns",
          record_id: ret.id,
          details:
            " فشل ترحيل قيد مرتجع مشتريات " +
            (ret.id || "") +
            ": " +
            (purchaseReturnJeResult ? purchaseReturnJeResult.message : "unknown") +
            " — رصيد المورد لم يتأثر رغم خصم المخزون فعليًا. يحتاج مراجعة يدوية من المحاسب."});
      } catch (auditErrPRet) {
        Logger.log(
          "[RETURN-JE-FIX] فشل تسجيل تنبيه AuditLog: " + auditErrPRet.message,
        );
      }
    }

    // ─── [FIX-2026-07-21] القيد الثانوي المنفصل لتخفيض المخزون بالتكلفة
    // (كان يعوّض عن غياب أي أثر على المخزون في القيد الرئيسي أعلاه) أُزيل
    // لأن القيد الرئيسي بقى يُرحَّل مباشرة على inventory_account بقيمة
    // الفاتورة — إبقاؤه كان سيُخفِّض المخزون مرتين لكل مرتجع مشتريات.
  } catch (e) {
    Logger.log("[autoJournal] خطأ في قيد مرتجع المشتريات: " + e.message);
  }
}
// ───────────────────────────────────────────────────────────────────────────
// §P2-05  PATCH: _addJournalEntryInternal — Add Fiscal Period Validation
// ───────────────────────────────────────────────────────────────────────────
// هذا التصحيح يُعدّل _addJournalEntryInternal الموجود بحقن التحقق من الفترة
// نستخدم نمط الـ Monkey-Patch المتوافق مع GAS (لا يوجد prototype.wrap)

// [FIX-RECURSION] لم يعد هناك حاجة لسطر var capture هنا — الدالة الأصلية
// تم تسميتها مباشرةً _addJournalEntryInternalOriginal أعلى الملف (راجع التعليق هناك)
function _addJournalEntryInternal(data) {
  // [P2-FP] التحقق من الفترة المحاسبية قبل الترحيل
  if (data && data.date) {
    try {
      _validateFiscalPeriod(data.date);
    } catch (periodErr) {
      Logger.log(
        "[P2-FP] Blocked journal for date " +
          data.date +
          ": " +
          periodErr.message,
      );
      return { success: false, message: periodErr.message };
    }
  }
  return _addJournalEntryInternalOriginal(data);
}
/**
 * softDeleteJournalEntry — حذف ناعم للقيد المحاسبي
 * يستبدل deleteJournalEntry الذي يحذف الصف فعلياً للقيود غير المعتمدة
 */
function softDeleteJournalEntry(id, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "deleteJournalEntry",
      sessionToken,
    );
    if (permErr) return permErr;

    var rows = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id && !r.deleted_at;
    });
    if (idx === -1)
      return { success: false, message: "القيد غير موجود أو محذوف بالفعل" };

    if (rows[idx].status === "POSTED") {
      return {
        success: false,
        message: "لا يمكن حذف قيد معتمد — قم بإلغائه أولاً ثم احذفه",
      };
    }

    var sheet = getSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
    );
    var now = new Date().toISOString();
    // أضف حقل deleted_at في آخر عمود + 1 أو في عمود مخصص
    _ensureSoftDeleteColumns(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      sheet,
      idx + 2,
      callerUser,
      now,
    );

    _addAuditLog(
      callerUser,
      "SOFT_DELETE_JOURNAL",
      "JournalEntries",
      id,
      "حذف ناعم",
    );
    _invalidateExtCache();
    return { success: true, message: "تم حذف القيد وحفظ السجل التاريخي" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
// [FIX-2026-07-21 / تقرير التدقيق §5-المشكلة 5] _autoJournalCOGSFromLots
// اتحذفت — كانت نسخة موازية غير مستخدمة من أي مسار تنفيذي في المشروع
// (تأكّد بالبحث الشامل عن كل استدعاء لاسمها قبل الحذف). مسار البيع الفعلي
// يعتمد حصريًا على _autoJournalCOGS في Code_20_Sales.js.
