// ════════════════════════════════════════════════════════════════
// Code_Accounting_Reports.gs — [REFACTOR-P4] نُقل من Code_Accounting.gs (نقل نصي بحت،
// صفر تغيير في المنطق أو الترتيب الداخلي بين الدوال). Apps Script يعامل
// كل ملفات .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء
// من أي ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// راجع تقرير Architecture Audit 2026-07-03 — المرحلة 4، قسم 4-ب.
//
// المسؤولية: التقارير المالية (دفتر الأستاذ، ميزان المراجعة، قائمة الدخل، الميزانية، التدفقات النقدية) + قوائم الفواتير النشطة (Soft Delete)
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-09  Accounting — Reports (التقارير المالية)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * getGeneralLedger — الأستاذ العام
 * @param {string} accountId — معرف الحساب (اختياري، لو فاضي = كل الحسابات)
 * @param {string} fromDate
 * @param {string} toDate
 */
function getGeneralLedger(
  accountId,
  fromDate,
  toDate,
  callerUser,
  sessionToken,
) {
  try {
    // [RBAC-FIX] الواجهة كانت بتبعت callerUser/sessionToken من زمان لكن الدالة
    // ما كانتش بتستقبلهم ولا بتتحقق من الصلاحية — أي مستخدم مسجّل دخول (بأي
    // دور) كان يقدر يفتح دفتر الأستاذ كامل. الفحص اختياري (زي getCustomers)
    // عشان النداءات الداخلية (getIncomeStatement/getAccountStatement) تفضل شغالة.
    if (callerUser) {
      _requirePermission(callerUser, "viewGeneralLedger");
    }
    var entries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var lines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
      { trimStrings: true },
    );
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );

    // فلترة القيود المعتمدة فقط
    entries = entries.filter(function (e) {
      return e.status === "POSTED";
    });

    // [P6-A FIX] قبل تطبيق فلتر fromDate على قائمة الفترة، نحتفظ بكل القيود
    // المعتمدة (بدون أي فلتر تاريخ) لحساب "الرصيد الافتتاحي الفعلي اعتباراً من
    // fromDate" — أي opening_balance الأصلي + كل الحركات المعتمدة قبل fromDate.
    var allPostedEntries = entries;
    if (toDate)
      allPostedEntries = allPostedEntries.filter(function (e) {
        return e.date <= toDate;
      });

    var periodEntries = entries;
    if (fromDate)
      periodEntries = periodEntries.filter(function (e) {
        return e.date >= fromDate;
      });
    if (toDate)
      periodEntries = periodEntries.filter(function (e) {
        return e.date <= toDate;
      });
    entries = periodEntries;

    var accountIds = accountId
      ? [accountId]
      : accounts.map(function (a) {
          return a.id;
        });
    var ledger = [];

    accountIds.forEach(function (aid) {
      var account = accounts.find(function (a) {
        return a.id === aid;
      });
      if (!account || account.deleted_at) return;

      var isDebitType = ["ASSET", "EXPENSE"].indexOf(account.type) !== -1;

      // [P6-A FIX] الرصيد الفعلي اعتباراً من بداية الفترة المطلوبة (fromDate):
      // opening_balance الأصلي للحساب + كل الحركات المعتمدة قبل fromDate.
      // قبل الإصلاح كان الرصيد يبدأ دائماً من opening_balance الأصلي فقط، حتى
      // لو كان fromDate في منتصف السنة — فيُسقِط كل نشاط الحساب من بداية
      // التشغيل وحتى fromDate من حساب الرصيد المعروض، ويُظهر "رصيد افتتاحي"
      // و"رصيد ختامي" خاطئين تماماً لكشف الحساب/الأستاذ العام/ميزان المراجعة
      // لأي فترة لا تبدأ من أول يوم تشغيل فعلي للنظام.
      var balanceAsOfFromDate = _coaReportingOpeningBalance(
        account,
        allPostedEntries,
        lines,
        toDate || "",
      );
      if (fromDate) {
        var priorLines = lines.filter(function (l) {
          return l.account_id === aid;
        });
        priorLines.forEach(function (line) {
          var entry = allPostedEntries.find(function (e) {
            return e.id === line.entry_id && e.date < fromDate;
          });
          if (!entry) return;
          var debitEffect = isDebitType ? 1 : -1;
          var creditEffect = isDebitType ? -1 : 1;
          balanceAsOfFromDate +=
            Number(line.debit || 0) * debitEffect +
            Number(line.credit || 0) * creditEffect;
        });
      }

      var accountLines = lines.filter(function (l) {
        return l.account_id === aid;
      });
      var accountEntries = [];

      accountLines.forEach(function (line) {
        var entry = entries.find(function (e) {
          return e.id === line.entry_id;
        });
        if (!entry) return;
        accountEntries.push({
          date: entry.date,
          reference: entry.reference,
          description: entry.description,
          debit: Number(line.debit || 0),
          credit: Number(line.credit || 0),
          entry_id: entry.id,
          source_type: entry.source_type,
        });
      });

      if (accountEntries.length > 0) {
        // ترتيب حسب التاريخ
        accountEntries.sort(function (a, b) {
          return String(a.date).localeCompare(String(b.date));
        });

        // حساب الرصيد التراكمي بدءاً من رصيد بداية الفترة الفعلي
        var runningBalance = balanceAsOfFromDate;

        accountEntries.forEach(function (e) {
          var debitEffect = isDebitType ? 1 : -1;
          var creditEffect = isDebitType ? -1 : 1;
          runningBalance += e.debit * debitEffect + e.credit * creditEffect;
          e.balance = runningBalance;
        });

        ledger.push({
          account: {
            id: account.id,
            code: account.code,
            name: account.name,
            type: account.type,
          },
          opening_balance: balanceAsOfFromDate,
          entries: accountEntries,
          total_debit: accountEntries.reduce(function (s, e) {
            return s + e.debit;
          }, 0),
          total_credit: accountEntries.reduce(function (s, e) {
            return s + e.credit;
          }, 0),
          closing_balance: runningBalance,
        });
      }
    });

    return { success: true, data: ledger };
  } catch (e) {
    return errResponse("خطأ في جلب الأستاذ العام: " + e.message);
  }
}
/**
 * [COST-CENTER-DIM] getCostCenterActivity — تقرير مستقل لحركة مركز تكلفة
 * معيّن (أو كل المراكز مُجمَّعة) خلال فترة. تقرير إضافي جديد بالكامل — لم
 * يُعدَّل getGeneralLedger/getTrialBalance/getIncomeStatement/getBalanceSheet
 * أنفسهم عمداً؛ فتلك التقارير تعتمد على منطق "رصيد افتتاحي" مبني على
 * opening_balance على مستوى الحساب ككل (راجع _coaReportingOpeningBalance)،
 * وهو منطق لا معنى محاسبياً لتقسيمه بحسب مركز التكلفة بدون قرار عمل صريح
 * (هل الرصيد الافتتاحي نفسه له مركز تكلفة؟ هذا سؤال Business Decision لم
 * يُطرح في التكليف). بدل المخاطرة بكسر حسابات الأرصدة الافتتاحية لكل
 * التقارير المالية الحالية، هذا تقرير حركة (Activity) فقط: يجمع سطور
 * القيود المعتمدة (POSTED) خلال الفترة المطلوبة حسب مركز التكلفة — يعرض
 * إجمالي المدين/الدائن لكل حساب ضمن كل مركز تكلفة.
 */
function getCostCenterActivity(
  costCenterId,
  fromDate,
  toDate,
  callerUser,
  sessionToken,
) {
  try {
    if (callerUser) {
      _requirePermission(callerUser, "viewGeneralLedger", sessionToken);
    }
    var entries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    ).filter(function (e) {
      return e.status === "POSTED";
    });
    if (fromDate)
      entries = entries.filter(function (e) {
        return e.date >= fromDate;
      });
    if (toDate)
      entries = entries.filter(function (e) {
        return e.date <= toDate;
      });
    var entryIds = {};
    entries.forEach(function (e) {
      entryIds[e.id] = e;
    });

    var lines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
      { trimStrings: true },
    ).filter(function (l) {
      if (!entryIds[l.entry_id]) return false;
      if (costCenterId) return l.cost_center_id === costCenterId;
      return !!l.cost_center_id; // بدون تحديد مركز → كل السطور التي لها مركز تكلفة فقط
    });

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    var costCenters = readSheet(
      "CostCenters",
      ACCOUNTING_HR_HEADERS.CostCenters,
      { trimStrings: true },
    );
    var accMap = {},
      ccMap = {};
    accounts.forEach(function (a) {
      accMap[a.id] = a;
    });
    costCenters.forEach(function (c) {
      ccMap[c.id] = c;
    });

    // تجميع حسب مركز التكلفة ثم الحساب
    var groups = {}; // costCenterId -> { cost_center, accounts: { accountId -> {debit,credit} } }
    lines.forEach(function (line) {
      var ccId = line.cost_center_id;
      if (!groups[ccId]) {
        groups[ccId] = {
          cost_center_id: ccId,
          cost_center: ccMap[ccId]
            ? { id: ccId, code: ccMap[ccId].code, name: ccMap[ccId].name }
            : { id: ccId, code: "", name: "(غير معروف/محذوف)" },
          total_debit: 0,
          total_credit: 0,
          by_account: {},
        };
      }
      var g = groups[ccId];
      var d = Number(line.debit || 0);
      var c = Number(line.credit || 0);
      g.total_debit += d;
      g.total_credit += c;
      if (!g.by_account[line.account_id]) {
        var acc = accMap[line.account_id];
        g.by_account[line.account_id] = {
          account_id: line.account_id,
          account_code: acc ? acc.code : "",
          account_name: acc ? acc.name : "",
          debit: 0,
          credit: 0,
        };
      }
      g.by_account[line.account_id].debit += d;
      g.by_account[line.account_id].credit += c;
    });

    var result = Object.keys(groups).map(function (ccId) {
      var g = groups[ccId];
      return {
        cost_center_id: g.cost_center_id,
        cost_center: g.cost_center,
        total_debit: g.total_debit,
        total_credit: g.total_credit,
        accounts: Object.keys(g.by_account).map(function (aid) {
          return g.by_account[aid];
        }),
      };
    });
    result.sort(function (a, b) {
      return String(a.cost_center.code || "").localeCompare(
        String(b.cost_center.code || ""),
      );
    });

    return { success: true, data: result };
  } catch (e) {
    return errResponse("خطأ في جلب تقرير مراكز التكلفة: " + e.message);
  }
}

/**
 * getTrialBalance — ميزان المراجعة
 */
function getTrialBalance(fromDate, toDate, callerUser, sessionToken) {
  try {
    if (callerUser) {
      _requirePermission(callerUser, "viewTrialBalance"); // [RBAC-FIX]
    }
    // [P6-C FIX] عمود "الرصيد" في ميزان المراجعة يجب أن يكون الرصيد التراكمي
    // الفعلي حتى toDate (بداية التشغيل وحتى نهاية الفترة)، وليس فقط نشاط
    // الفترة [fromDate..toDate] — وإلا فحساب لم تطرأ عليه أي حركة خلال الفترة
    // المختارة تحديداً (شائع جداً، مثل خزينة بلا حركة هذا الشهر) كان يظهر
    // برصيده الافتتاحي الخام (وقت تأسيس الحساب) بدل رصيده الحقيقي المتراكم.
    var fullLedger = getGeneralLedger("", "", toDate);
    if (!fullLedger.success) return fullLedger;
    var periodLedger = fromDate
      ? getGeneralLedger("", fromDate, toDate)
      : fullLedger;
    if (!periodLedger.success) return periodLedger;

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    accounts = accounts.filter(function (a) {
      return !a.deleted_at && a.is_active !== "FALSE" && a.is_active !== false;
    });

    var trialBalance = accounts
      .map(function (acc) {
        var fullEntry = fullLedger.data.find(function (l) {
          return l.account.id === acc.id;
        });
        var periodEntry = periodLedger.data.find(function (l) {
          return l.account.id === acc.id;
        });
        var totalDebit = periodEntry ? periodEntry.total_debit : 0;
        var totalCredit = periodEntry ? periodEntry.total_credit : 0;

        // الرصيد الختامي الفعلي حتى toDate (وليس فقط نشاط الفترة)
        var isDebitType = ["ASSET", "EXPENSE"].indexOf(acc.type) !== -1;
        var balance = fullEntry
          ? fullEntry.closing_balance
          : Number(acc.opening_balance || 0);

        return {
          account_id: acc.id,
          account_code: acc.code,
          account_name: acc.name,
          account_type: acc.type,
          opening_balance: Number(acc.opening_balance || 0),
          total_debit: totalDebit,
          total_credit: totalCredit,
          balance: balance,
          balance_type:
            balance >= 0
              ? isDebitType
                ? "DEBIT"
                : "CREDIT"
              : isDebitType
                ? "CREDIT"
                : "DEBIT",
        };
      })
      .filter(function (a) {
        // إظهار الحسابات التي لها حركات في الفترة أو رصيد فعلي حتى توداتي
        return (
          a.total_debit > 0 || a.total_credit > 0 || Math.abs(a.balance) > 0.001
        );
      });

    var grandTotalDebit = trialBalance.reduce(function (s, a) {
      return s + a.total_debit;
    }, 0);
    var grandTotalCredit = trialBalance.reduce(function (s, a) {
      return s + a.total_credit;
    }, 0);

    return {
      success: true,
      data: trialBalance,
      totals: { debit: grandTotalDebit, credit: grandTotalCredit },
    };
  } catch (e) {
    return errResponse("خطأ في ميزان المراجعة: " + e.message);
  }
}
/**
 * getIncomeStatement — قائمة الدخل
 */
function getIncomeStatement(fromDate, toDate, callerUser, sessionToken) {
  try {
    if (callerUser) {
      _requirePermission(callerUser, "viewIncomeStatement"); // [RBAC-FIX]
    }
    var ledger = getGeneralLedger("", fromDate, toDate);
    if (!ledger.success) return ledger;

    // الإيرادات
    var revenueAccounts = ledger.data.filter(function (l) {
      return l.account.type === "REVENUE";
    });
    var totalRevenue = revenueAccounts.reduce(function (s, a) {
      return (
        s +
        a.entries.reduce(function (es, e) {
          return es + e.credit - e.debit;
        }, 0)
      );
    }, 0);

    // المصروفات
    var expenseAccounts = ledger.data.filter(function (l) {
      return l.account.type === "EXPENSE";
    });
    var totalExpenses = expenseAccounts.reduce(function (s, a) {
      return (
        s +
        a.entries.reduce(function (es, e) {
          return es + e.debit - e.credit;
        }, 0)
      );
    }, 0);

    var netIncome = totalRevenue - totalExpenses;

    var revenuesList = revenueAccounts.map(function (a) {
      return {
        name: a.account.name,
        code: a.account.code,
        amount: a.entries.reduce(function (s, e) {
          return s + e.credit - e.debit;
        }, 0),
      };
    });
    var expensesList = expenseAccounts.map(function (a) {
      return {
        name: a.account.name,
        code: a.account.code,
        amount: a.entries.reduce(function (s, e) {
          return s + e.debit - e.credit;
        }, 0),
      };
    });

    return {
      success: true,
      data: {
        revenues: revenuesList,
        expenses_list: expensesList,
        // aliases للتوافق مع أي كود قديم
        revenue: totalRevenue,
        total_revenue: totalRevenue,
        total_expenses: totalExpenses,
        net_income: netIncome,
        net: netIncome,
        from_date: fromDate,
        to_date: toDate,
      },
    };
  } catch (e) {
    return errResponse("خطأ في قائمة الدخل: " + e.message);
  }
}
/**
 * getBalanceSheet — الميزانية العمومية
 */
function getBalanceSheet(asOfDate, callerUser, sessionToken) {
  try {
    if (callerUser) {
      _requirePermission(callerUser, "viewBalanceSheet"); // [RBAC-FIX]
    }
    // ── 1. قراءة دليل الحسابات الكامل (بما فيها parent_id) ──
    var allAccounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    allAccounts = allAccounts.filter(function (a) {
      return !a.deleted_at;
    });

    // ── 2. قراءة كل قيود اليومية المعتمدة حتى تاريخ الميزانية ──
    var entries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var lines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
      { trimStrings: true },
    );

    entries = entries.filter(function (e) {
      return e.status === "POSTED" && (!asOfDate || e.date <= asOfDate);
    });

    // ── 3. احسب الرصيد الختامي لكل حساب ──
    var balanceMap = {};
    allAccounts.forEach(function (a) {
      balanceMap[a.id] = _coaReportingOpeningBalance(
        a,
        entries,
        lines,
        asOfDate || "",
      );
    });

    var postedIds = {};
    entries.forEach(function (e) {
      postedIds[e.id] = true;
    });

    lines.forEach(function (l) {
      if (!postedIds[l.entry_id]) return;
      var acc = allAccounts.find(function (a) {
        return a.id === l.account_id;
      });
      if (!acc) return;
      var isDebitType = ["ASSET", "EXPENSE"].indexOf(acc.type) !== -1;
      var effect = isDebitType
        ? Number(l.debit || 0) - Number(l.credit || 0)
        : Number(l.credit || 0) - Number(l.debit || 0);
      balanceMap[acc.id] = (balanceMap[acc.id] || 0) + effect;
    });

    // ── 4. بناء مصفوفة items الغنية (مع parent_id) لكل نوع ──
    function buildItems(type) {
      return allAccounts
        .filter(function (a) {
          return a.type === type;
        })
        .map(function (a) {
          return {
            id: a.id,
            code: a.code || "",
            name: a.name || "",
            parent_id: a.parent_id || "",
            balance: balanceMap[a.id] || 0,
            is_parent: a.is_parent === true || a.is_parent === "TRUE",
          };
        });
    }

    var assetItems = buildItems("ASSET");
    var liabilityItems = buildItems("LIABILITY");
    var equityItems = buildItems("EQUITY");

    // مجاميع الحسابات الورقية فقط (leaf) لتجنّب تكرار المجموعات
    function leafTotal(items) {
      return items
        .filter(function (a) {
          return !a.is_parent;
        })
        .reduce(function (s, a) {
          return s + a.balance;
        }, 0);
    }

    var totalAssets = leafTotal(assetItems);
    var totalLiabilities = leafTotal(liabilityItems);
    var totalEquity = leafTotal(equityItems);

    // صافي الدخل يُضاف تلقائياً لحقوق الملكية
    var incomeStmt = getIncomeStatement("", asOfDate);
    if (incomeStmt.success && incomeStmt.data && incomeStmt.data.net_income) {
      totalEquity += Number(incomeStmt.data.net_income || 0);
    }

    return {
      success: true,
      data: {
        assets: { items: assetItems, total: totalAssets },
        liabilities: { items: liabilityItems, total: totalLiabilities },
        equity: { items: equityItems, total: totalEquity },
        total_liabilities_equity: totalLiabilities + totalEquity,
        as_of_date: asOfDate,
        // [C8-FIX] فحص توازن الميزانية: الأصول = الالتزامات + حقوق الملكية
        // هذا المبدأ الأساسي للمحاسبة — أي اختلاف يدل على خطأ في القيود
        is_balanced:
          Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
        balance_difference: totalAssets - (totalLiabilities + totalEquity),
        balance_check_message:
          Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
            ? " الميزانية متوازنة: الأصول = الالتزامات + حقوق الملكية"
            : " تحذير: الميزانية غير متوازنة بمقدار " +
              (totalAssets - (totalLiabilities + totalEquity)).toFixed(2) +
              " — يرجى مراجعة القيود",
      },
    };
  } catch (e) {
    return errResponse("خطأ في الميزانية العمومية: " + e.message);
  }
}
/**
 * getAccountStatement — كشف حساب (لعميل، مورد، خزنة، بنك، أي حساب)
 */
function getAccountStatement(
  accountId,
  fromDate,
  toDate,
  callerUser,
  sessionToken,
) {
  try {
    if (callerUser) {
      _requirePermission(callerUser, "viewAccountStatement"); // [RBAC-FIX]
    }
    if (!accountId) return errResponse("معرف الحساب مطلوب");
    var ledger = getGeneralLedger(accountId, fromDate, toDate);
    if (!ledger.success) return ledger;
    return { success: true, data: ledger.data[0] || null };
  } catch (e) {
    return errResponse("خطأ في كشف الحساب: " + e.message);
  }
}
/**
 * getCashFlowStatement — قائمة التدفقات النقدية (غير مباشرة)
 * تُصنِّف الحركات إلى: تشغيل / استثمار / تمويل بناءً على نوع الحساب
 */
function getCashFlowStatement(fromDate, toDate, callerUser, sessionToken) {
  try {
    // [P6-D FIX] كانت _checkPermission تُستدعى بترتيب معطيات خاطئ
    // (sessionToken في مكان action، والنص الحرفي "viewReports" في مكان
    // sessionToken)، والنتيجة المُعادة لم تكن تُفحص إطلاقاً — أي أن فحص
    // الصلاحية لم يكن يمنع أي استدعاء فعلياً مهما كانت النتيجة، وكان فقط
    // يُلوِّث سجل التدقيق بمحاولات تحقق جلسة فاشلة على كل استدعاء.
    var _permErr = _checkPermission(callerUser, "viewReports", sessionToken);
    if (_permErr) return _permErr;

    var ledger = getGeneralLedger("", fromDate, toDate);
    if (!ledger.success) return ledger;

    var operating = []; // تشغيل
    var investing = []; // استثمار
    var financing = []; // تمويل

    var operatingNet = 0,
      investingNet = 0,
      financingNet = 0;

    ledger.data.forEach(function (a) {
      var type = (a.account.type || "").toUpperCase();
      var subtype = (
        a.account.subtype ||
        a.account.sub_type ||
        ""
      ).toUpperCase();
      var name = a.account.name || "";
      var net = a.entries.reduce(function (s, e) {
        return s + (e.credit - e.debit);
      }, 0);
      if (net === 0) return;

      var item = { name: name, code: a.account.code, amount: net };

      // [ITEM-POSTING-WIRE-GAP-FIX-2026-08-08 / البند-6-مخالفة] كان التصنيف
      // بين أنشطة الاستثمار والتشغيل يعتمد جزئياً على مطابقة نصية لجزء من
      // اسم الحساب (name.indexOf("أصل ثابت")، "معدات"، "آلات"...) — مخالفة
      // مباشرة لقاعدة "ممنوع الاعتماد على اسم الحساب فقط" (البند 6). حساب
      // اسمه بيحتوي كلمة "معدات" في وصف غير متعلق (أو العكس: حساب أصل ثابت
      // فعلي باسم مختلف) كان يُصنَّف غلط. الحل: نعتمد حصراً على الحقل
      // البنيوي subtype/sub_type من دليل الحسابات. لو مش معرَّف، الأصل
      // المتداول (بلا subtype) يفضل يُصنَّف تشغيل (fallback آمن ومحافظ)
      // بدل تخمين من الاسم.
      if (type === "REVENUE" || type === "EXPENSE") {
        // أنشطة التشغيل
        operating.push(item);
        operatingNet += net;
      } else if (
        type === "ASSET" &&
        (subtype === "FIXED" || subtype === "NON_CURRENT")
      ) {
        // أنشطة الاستثمار
        investing.push(item);
        investingNet += net;
      } else if (type === "LIABILITY" || type === "EQUITY") {
        // أنشطة التمويل
        financing.push(item);
        financingNet += net;
      } else {
        // الأصول المتداولة → تشغيل
        operating.push(item);
        operatingNet += net;
      }
    });

    return {
      success: true,
      data: {
        operating: operating,
        investing: investing,
        financing: financing,
        operating_net: operatingNet,
        investing_net: investingNet,
        financing_net: financingNet,
        total_net: operatingNet + investingNet + financingNet,
        from_date: fromDate,
        to_date: toDate,
      },
    };
  } catch (e) {
    return errResponse("خطأ في قائمة التدفقات النقدية: " + e.message);
  }
}
// ── [MAINT-FIX-7] دوال الحذف الناعم للفواتير (كانت هنا) نُقلت إلى ملف مستقل ──
// راجع Code_05b_InvoiceSoftDelete.js — نفس الدوال وبنفس الأسماء
// (softDeleteSaleInvoice, softDeletePurchaseInvoice, _ensureSoftDeleteColumns,
// _migrateAddSoftDeleteColumns) فأي استدعاء قديم يفضل شغال زي ما هو.
// السبب: هذا الملف (Reports) لازم يفضل read-only فقط.

// ───────────────────────────────────────────────────────────────────────────
// §P2-10  DOPOST ALLOWLIST — New Phase 2 functions
// ───────────────────────────────────────────────────────────────────────────
// أضف هذه الدوال إلى DOPOST_ALLOWED_FUNCTIONS في أول Code.js:
//
//  "getAccountingPeriods",
//  "addAccountingPeriod",
//  "updateAccountingPeriodStatus",
//  "autoCreateFiscalPeriods",
//  "getInventoryValuation",
//  "softDeleteSaleInvoice",
//  "softDeletePurchaseInvoice",
//  "softDeleteJournalEntry",
//  "runPhase2AccountingValidation",
//  "migratePhase2",
//  "setupPhase2Sheets",

// ───────────────────────────────────────────────────────────────────────────
// §P2-11  ENHANCED REPORTS — Filter deleted records
// ───────────────────────────────────────────────────────────────────────────

/**
 * _filterDeleted — يُفلتر السجلات المحذوفة ناعماً
 * يُستخدم في كل دوال القراءة للتقارير
 */
function _filterDeleted(rows) {
  if (!rows || !rows.length) return rows;
  return rows.filter(function (r) {
    return !r.deleted_at;
  });
}
/**
 * getSaleInvoicesActive — جلب فواتير البيع النشطة (بدون المحذوفة)
 * تحل محل getSaleInvoices في التقارير
 */
function getSaleInvoicesActive(callerUser, sessionToken) {
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
    return { success: true, data: _filterDeleted(rows) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
/**
 * getPurchaseInvoicesActive — جلب فواتير الشراء النشطة (بدون المحذوفة)
 */
function getPurchaseInvoicesActive(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "viewPurchaseInvoices",
      sessionToken,
    );
    if (permErr) return permErr;
    var rows = readSheet("PurchaseInvoices", PURCHASE_INVOICE_HEADERS, {
      parseJson: ["lines_json"],
    });
    return { success: true, data: _filterDeleted(rows) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
