// ════════════════════════════════════════════════════════════════
// Code_20b_AccountingTools.js — أدوات محاسبية عامة (Cash Flow, Aging GL, Integrity Check) — [SPLIT-2026-07-27] فُصل من Code_20_Sales.js الأصلي (7172 سطر)
// كجزء من إعادة تنظيم المبيعات/المشتريات حسب المجال الوظيفي الحقيقي بدل
// تجميع فواتير + أطراف + أدوات محاسبة + فودافون كاش في ملف واحد اسمه
// "Sales" (راجع تقرير moo-erp-sales-purchasing-deepdive.md، بند 7).
// نقل نصي بحت — صفر تغيير في المنطق أو أسماء الدوال. كل ملفات .gs بتعمل
// في نفس الـ Global Scope في Apps Script فالاستدعاءات القديمة فضلت شغالة.
// ════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════
// [AUTO-PATCHED] دوال محاسبية مضافة — MOO_ERP_Accounting_Fixes.js
// ═══════════════════════════════════════════════════════════════════════════

function _getPayrollCashAccount(period, accounts) {
  try {
    // الأولوية: cash_box_id في سجل الفترة → ثم bank_account_id → ثم الخزينة الافتراضية
    if (period.cash_box_id) {
      var boxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
      var box = boxes.find(function (b) {
        return b.id === period.cash_box_id;
      });
      if (box && box.account_id) return box.account_id;
    }
    if (period.bank_account_id) {
      var banks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
      var bank = banks.find(function (b) {
        return b.id === period.bank_account_id;
      });
      if (bank && bank.account_id) return bank.account_id;
    }
    // fallback: أول خزينة نشطة لها حساب GL
    var allBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var defaultBox = allBoxes.find(function (b) {
      return b.is_active !== "FALSE" && b.account_id;
    });
    if (defaultBox) return defaultBox.account_id;
    return null;
  } catch (e) {
    Logger.log("[_getPayrollCashAccount] خطأ: " + e.message);
    return null;
  }
}

function _getVatInputAccount(accounts) {
  var vatInput = _getDefaultAccount("vat_input_account", accounts, "ASSET", [
    "ضريبة قيمة مضافة — مشتريات",
    "ضريبة مشتريات",
    "vat input",
    "مدخلات",
    "1141",
  ]);
  if (!vatInput) {
    Logger.log(
      "[C-004] تحذير: لم يُعثر على حساب ضريبة مدخلات (VAT Input) — " +
        "يجب إضافة حساب 1141 في دليل الحسابات وربطه بـ vat_input_account في الإعدادات. " +
        "لن تُسجَّل الضريبة في هذه الفاتورة.",
    );
    return null; // NULL بدلاً من حساب الضريبة الخاطئ
  }
  return vatInput;
}

function getUnpaidInvoicesForCustomer(customerId, sessionToken) {
  try {
    var invoices = readSheet("SaleInvoices", /* SALE_INVOICE_HEADERS */ []);
    var receipts = readSheet(
      "ReceiptVouchers",
      ACCOUNTING_HR_HEADERS.ReceiptVouchers,
    );

    // إجمالي المحصَّل لكل فاتورة
    var paidByInvoice = {};
    receipts.forEach(function (r) {
      if (r.invoice_id && r.status !== "CANCELLED" && r.status !== "REVERSED") {
        paidByInvoice[r.invoice_id] =
          (paidByInvoice[r.invoice_id] || 0) +
          Number(r.applied_amount || r.amount || 0);
      }
    });

    var unpaid = invoices
      .filter(function (inv) {
        if (inv.party_id !== customerId && inv.party !== customerId)
          return false;
        if (inv.payment_status !== "آجل") return false;
        var paid = paidByInvoice[inv.id] || 0;
        var remaining = Number(inv.net_total || 0) - paid;
        return remaining > 0.01;
      })
      .map(function (inv) {
        var paid = paidByInvoice[inv.id] || 0;
        return {
          id: inv.id,
          ref: inv.invoice_ref || inv.id,
          date: inv.date,
          total: Number(inv.net_total || 0),
          paid: paid,
          remaining: Number(inv.net_total || 0) - paid,
        };
      });

    return { success: true, data: unpaid };
  } catch (e) {
    return { success: false, message: "خطأ في جلب الفواتير: " + e.message };
  }
}

function _getPurchaseDiscountJournalLine(inv, accounts) {
  var discountAmount = Number(inv.discount_amount || 0);
  if (discountAmount <= 0) return null;

  var discountAccount = _getDefaultAccount(
    "purchase_discount_account",
    accounts,
    "REVENUE", // الخصم المكتسب من الموردين = إيراد
    ["خصم مكتسب", "خصم مكتسب من الموردين", "purchase discount", "خصم مشتريات"],
  );
  if (!discountAccount) {
    Logger.log(
      "[H-004] تحذير: خصم شراء " +
        discountAmount +
        " غير مُسجَّل — " +
        "يجب إضافة حساب 'خصم مكتسب من الموردين' في دليل الحسابات",
    );
    return null;
  }

  return {
    account_id: discountAccount.id,
    debit: 0,
    credit: discountAmount,
    notes: "خصم مكتسب من المورد",
  };
}

function getCashFlowStatementV2(fromDate, toDate, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
    if (permErr) return permErr;

    var entries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var lines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
    );
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );

    // فلترة القيود المرحَّلة في الفترة
    var periodEntries = entries.filter(function (e) {
      return (
        e.status === "POSTED" &&
        (!fromDate || e.date >= fromDate) &&
        (!toDate || e.date <= toDate)
      );
    });
    var entryIds = periodEntries.map(function (e) {
      return e.id;
    });

    var accountsById = {};
    accounts.forEach(function (a) {
      accountsById[a.id] = a;
    });

    var categories = {
      OPERATING: 0,
      INVESTING: 0,
      FINANCING: 0,
      UNCATEGORIZED: 0,
    };

    lines.forEach(function (line) {
      if (entryIds.indexOf(line.entry_id) === -1) return;
      var acc = accountsById[line.account_id];
      if (!acc) return;

      // [M-004 FIX] استخدام cash_flow_category أولاً — ثم التصنيف التلقائي القديم كـ fallback
      var cat = acc.cash_flow_category || _inferCashFlowCategory(acc);
      var debit = Number(line.debit || 0);
      var credit = Number(line.credit || 0);
      var netEffect =
        acc.type === "ASSET" || acc.type === "EXPENSE"
          ? debit - credit
          : credit - debit;

      if (cat in categories) {
        categories[cat] += netEffect;
      } else {
        categories.UNCATEGORIZED += netEffect;
      }
    });

    return {
      success: true,
      data: {
        operating: categories.OPERATING,
        investing: categories.INVESTING,
        financing: categories.FINANCING,
        uncategorized: categories.UNCATEGORIZED,
        net_change:
          categories.OPERATING + categories.INVESTING + categories.FINANCING,
        from_date: fromDate,
        to_date: toDate,
      },
    };
  } catch (e) {
    return { success: false, message: "خطأ في قائمة التدفقات: " + e.message };
  }
}

function _inferCashFlowCategory(account) {
  var name = String(account.name || "").toLowerCase();
  var nameEn = String(account.name_en || "").toLowerCase();
  var combined = name + " " + nameEn;
  if (
    combined.match(
      /أصل ثابت|معدات|سيارات|مباني|fixed asset|machinery|vehicle|building|equipment/,
    )
  ) {
    return "INVESTING";
  }
  if (combined.match(/رأس مال|قرض|توزيع|capital|loan|dividend|borrowing/)) {
    return "FINANCING";
  }
  return "OPERATING"; // الافتراضي
}

function getCashReconciliation(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
    if (permErr) return permErr;

    var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var bankAccounts = readSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
    );
    var allItems = cashBoxes
      .map(function (b) {
        return {
          type: "cashbox",
          id: b.id,
          name: b.name,
          account_id: b.account_id,
          book_balance: Number(b.current_balance || 0),
        };
      })
      .concat(
        bankAccounts.map(function (b) {
          return {
            type: "bank",
            id: b.id,
            name: b.name,
            account_id: b.account_id,
            book_balance: Number(b.current_balance || 0),
          };
        }),
      );

    var entries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var lines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
    );
    var postedIds = entries
      .filter(function (e) {
        return e.status === "POSTED";
      })
      .map(function (e) {
        return e.id;
      });

    // احسب الرصيد من الأستاذ لكل حساب
    var glBalanceByAccount = {};
    lines.forEach(function (line) {
      if (postedIds.indexOf(line.entry_id) === -1) return;
      var accId = line.account_id;
      if (!glBalanceByAccount[accId]) glBalanceByAccount[accId] = 0;
      glBalanceByAccount[accId] +=
        Number(line.debit || 0) - Number(line.credit || 0);
    });

    var result = allItems.map(function (item) {
      var glBalance = item.account_id
        ? glBalanceByAccount[item.account_id] || 0
        : null;
      var diff = glBalance !== null ? item.book_balance - glBalance : null;
      return {
        type: item.type,
        name: item.name,
        account_id: item.account_id || "—",
        book_balance: item.book_balance, // الرصيد في CashBoxes / BankAccounts
        gl_balance: glBalance, // الرصيد المحسوب من القيود
        difference: diff, // الفرق — يجب أن يكون 0
        status: Math.abs(diff || 0) < 0.01 ? " متطابق" : " فرق",
      };
    });

    return { success: true, data: result };
  } catch (e) {
    return { success: false, message: "خطأ في تقرير المطابقة: " + e.message };
  }
}

function _reverseBalancesManually(entry, entries, idx) {
  try {
    var coaSheet = getSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var coaHeaders = coaSheet
      .getRange(1, 1, 1, coaSheet.getLastColumn())
      .getValues()[0];
    var balanceCol = coaHeaders.indexOf("current_balance");
    if (balanceCol === -1) return;

    var lines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
    );
    var entryLines = lines.filter(function (l) {
      return l.entry_id === entry.id;
    });
    var coaRows = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );

    entryLines.forEach(function (line) {
      var coaIdx = coaRows.findIndex(function (r) {
        return r.id === line.account_id;
      });
      if (coaIdx === -1) return;
      var oldBalance = Number(coaRows[coaIdx].current_balance || 0);
      var accountType = coaRows[coaIdx].type;
      var debitEffect =
        ["ASSET", "EXPENSE"].indexOf(accountType) !== -1 ? -1 : 1;
      var creditEffect =
        ["ASSET", "EXPENSE"].indexOf(accountType) !== -1 ? 1 : -1;
      var newBalance =
        oldBalance +
        Number(line.debit || 0) * debitEffect +
        Number(line.credit || 0) * creditEffect;
      coaSheet.getRange(coaIdx + 2, balanceCol + 1).setValue(newBalance);
      coaRows[coaIdx].current_balance = newBalance;
    });
  } catch (e) {
    Logger.log("[_reverseBalancesManually] خطأ: " + e.message);
  }
}

function runAccountingIntegrityCheck(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
    if (permErr) return permErr;

    var issues = [];
    var warnings = [];

    // ─── 0. [P2-FIX] سلامة بنية دليل الحسابات (كانت غير مفحوصة هنا إطلاقًا) ───
    // addChartAccount يمنع تكرار الكود عند الإضافة، لكن لا يوجد أي فحص دوري
    // يكتشف بيانات أُدخلت مباشرة في شيت Google Sheets (لصق يدوي، استيراد،
    // تعديل خارج النظام) — وهو احتمال حقيقي بما أن قاعدة البيانات شيت مفتوح.
    // هذا الفحص يكمل (لا يكرر) منطق addChartAccount الموجود بالفعل.
    try {
      var coaAll = readSheet(
        "ChartOfAccounts",
        ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        { trimStrings: true },
      );
      var coaActive = coaAll.filter(function (a) {
        return !a.deleted_at;
      });
      var codeMap = {};
      var nameMap = {};
      coaActive.forEach(function (a) {
        var codeKey = String(a.code || "").trim();
        if (codeKey) {
          if (codeMap[codeKey]) {
            issues.push({
              type: "DUPLICATE_ACCOUNT_CODE",
              severity: "Critical",
              detail:
                "كود حساب مكرر: " +
                codeKey +
                " (" +
                codeMap[codeKey] +
                " ، " +
                a.id +
                ")",
            });
          } else codeMap[codeKey] = a.id;
        }
        var nameKey = String(a.name || "")
          .trim()
          .toLowerCase();
        if (nameKey) {
          if (nameMap[nameKey]) {
            warnings.push({
              type: "DUPLICATE_ACCOUNT_NAME",
              severity: "Medium",
              detail:
                'اسم حساب مكرر: "' +
                a.name +
                '" (' +
                nameMap[nameKey] +
                " ، " +
                a.id +
                ")",
            });
          } else nameMap[nameKey] = a.id;
        }
        if (a.parent_id) {
          var parentExists = coaActive.some(function (p) {
            return p.id === a.parent_id;
          });
          if (!parentExists) {
            issues.push({
              type: "ORPHAN_ACCOUNT",
              severity: "High",
              detail:
                'حساب "' +
                a.name +
                '" (' +
                a.id +
                ") يشير لحساب أب غير موجود أو محذوف: " +
                a.parent_id,
            });
          }
        }
      });
    } catch (e) {
      Logger.log("[COA-INTEGRITY] خطأ: " + e.message);
    }

    // ─── 1. فحص توازن القيود المرحَّلة ───
    var entries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var lines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
    );

    var linesByEntry = {};
    lines.forEach(function (line) {
      if (!linesByEntry[line.entry_id]) linesByEntry[line.entry_id] = [];
      linesByEntry[line.entry_id].push(line);
    });

    entries.forEach(function (entry) {
      if (entry.status !== "POSTED") return;
      var entryLines = linesByEntry[entry.id] || [];
      var totalDebit = entryLines.reduce(function (s, l) {
        return s + Number(l.debit || 0);
      }, 0);
      var totalCredit = entryLines.reduce(function (s, l) {
        return s + Number(l.credit || 0);
      }, 0);
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        issues.push({
          type: "UNBALANCED_ENTRY",
          severity: "Critical",
          entry_id: entry.id,
          reference: entry.reference,
          detail:
            "قيد غير متوازن: مدين=" +
            totalDebit.toFixed(2) +
            " ≠ دائن=" +
            totalCredit.toFixed(2),
        });
      }
      if (entryLines.length === 0) {
        issues.push({
          type: "EMPTY_ENTRY",
          severity: "High",
          entry_id: entry.id,
          reference: entry.reference,
          detail: "قيد مرحَّل بدون سطور",
        });
      }
    });

    // ─── 2. فحص مطابقة أرصدة الخزائن مع الأستاذ ───
    var reconciliation = getCashReconciliation(callerUser, sessionToken);
    if (reconciliation.success) {
      reconciliation.data.forEach(function (item) {
        if (!item.account_id || item.account_id === "—") {
          warnings.push({
            type: "NO_GL_ACCOUNT",
            severity: "High",
            detail:
              item.type +
              " '" +
              item.name +
              "' لا يملك حساباً في الأستاذ العام",
          });
        } else if (Math.abs(item.difference || 0) > 0.01) {
          issues.push({
            type: "BALANCE_MISMATCH",
            severity: "High",
            detail:
              item.type +
              " '" +
              item.name +
              "': رصيد الجدول=" +
              item.book_balance +
              " ≠ رصيد الأستاذ=" +
              item.gl_balance +
              " (فرق=" +
              item.difference +
              ")",
          });
        }
      });
    }

    // ─── 3. فحص الحسابات الأساسية في AccountingSettings ───
    var requiredKeys = [
      "ar_account",
      "ap_account",
      "cash_account",
      "inventory_account",
      "revenue_account",
      "purchase_account",
      "cogs_account",
      "vat_output_account",
      "vat_input_account",
      "opening_balance_equity_account",
      "salary_expense_account",
      "salary_payable_account",
      "depreciation_expense_account",
      "accumulated_depreciation_account",
    ];
    var settingsMap = _getAccountSettingsMap();
    var accountsAll = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    requiredKeys.forEach(function (key) {
      if (!settingsMap[key]) {
        warnings.push({
          type: "MISSING_ACCOUNT_SETTING",
          severity: "Medium",
          detail:
            "الحساب المفتاح '" + key + "' غير مربوط في AccountingSettings",
        });
      } else {
        var acc = accountsAll.find(function (a) {
          return a.id === settingsMap[key] && !a.deleted_at;
        });
        if (!acc) {
          issues.push({
            type: "INVALID_ACCOUNT_SETTING",
            severity: "Critical",
            detail:
              "الحساب المربوط بـ '" +
              key +
              "' (id=" +
              settingsMap[key] +
              ") غير موجود أو محذوف",
          });
        }
      }
    });

    // ─── 4. فحص الخزائن والبنوك بدون أرصدة افتتاحية ───
    var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var bankAccts = readSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
    );
    var allCashItems = cashBoxes.concat(bankAccts);
    var entryRefs = entries.map(function (e) {
      return e.reference;
    });

    allCashItems.forEach(function (item) {
      var openingBal = Number(item.opening_balance || 0);
      if (openingBal > 0) {
        var type =
          item.code.toString().startsWith("CBX") || item.id.startsWith("CBX")
            ? "CBX"
            : "BNK";
        var refKey = "OB-" + type + "-" + item.id;
        var hasJournal = entryRefs.some(function (r) {
          return r === refKey;
        });
        if (!hasJournal) {
          warnings.push({
            type: "MISSING_OPENING_BALANCE_JOURNAL",
            severity: "Critical",
            detail:
              "'" +
              item.name +
              "' لها رصيد افتتاحي " +
              openingBal +
              " بدون قيد في الأستاذ العام",
          });
        }
      }
    });

    var score = Math.max(0, 100 - issues.length * 10 - warnings.length * 3);

    return {
      success: true,
      data: {
        integrity_score: score,
        total_issues: issues.length,
        total_warnings: warnings.length,
        issues: issues,
        warnings: warnings,
        summary:
          issues.length === 0 && warnings.length === 0
            ? " النظام محاسبياً سليم"
            : " يوجد " +
              issues.length +
              " مشكلة و" +
              warnings.length +
              " تحذير",
      },
    };
  } catch (e) {
    return { success: false, message: "خطأ في فحص التكامل: " + e.message };
  }
}
