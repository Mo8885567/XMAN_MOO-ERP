// ════════════════════════════════════════════════════════════════
// Code_20d_VodafoneCash.js — مركز عمليات المحافظ الإلكترونية (فودافون كاش) — [SPLIT-2026-07-27] فُصل من Code_20_Sales.js الأصلي (7172 سطر)
// كجزء من إعادة تنظيم المبيعات/المشتريات حسب المجال الوظيفي الحقيقي بدل
// تجميع فواتير + أطراف + أدوات محاسبة + فودافون كاش في ملف واحد اسمه
// "Sales" (راجع تقرير moo-erp-sales-purchasing-deepdive.md، بند 7).
// نقل نصي بحت — صفر تغيير في المنطق أو أسماء الدوال. كل ملفات .gs بتعمل
// في نفس الـ Global Scope في Apps Script فالاستدعاءات القديمة فضلت شغالة.
// ════════════════════════════════════════════════════════════════

// §VFC  مركز عمليات المحافظ الإلكترونية (Wallets Operations Center)
// ─────────────────────────────────────────────────────────────────
//  شيتان مستقلان تماماً عن getAllData/getAllDataExtended (lazy-load
//  فقط عند فتح الصفحة) تجنباً لأي تأثير على أداء التحميل الأول
//  المعروف بالفعل في باقي الموديولات.
//  VodafoneCashLines        — سجل خطوط/عملاء المحافظ الإلكترونية (كل الشركات)
//  VodafoneCashTransactions — سجل العمليات المالية لكل خط
//  أسماء الشيتات والـ Permission keys اتسابت زي ما هي (Vodafone*) للحفاظ
//  على التوافق مع البيانات والصلاحيات القديمة — لكن البنية بقت تدعم
//  أي شركة محافظ إلكترونية عبر حقل "provider".
// ═══════════════════════════════════════════════════════════════════

// ── كتالوج شركات المحافظ الإلكترونية المدعومة ──────────────────────
var WALLET_PROVIDERS = [
  {
    key: "vodafone",
    name: "Vodafone Cash",
    shortName: "فودافون كاش",
    color: "#E60000",
    prefixes: ["010"],
  },
  {
    key: "orange",
    name: "Orange Cash",
    shortName: "أورانج كاش",
    color: "#FF7900",
    prefixes: ["012"],
  },
  {
    key: "etisalat",
    name: "Etisalat Cash",
    shortName: "اتصالات كاش",
    color: "#84BD00",
    prefixes: ["011"],
  },
  {
    key: "we",
    name: "WE Pay",
    shortName: "وي باي",
    color: "#6F2DA8",
    prefixes: ["015"],
  },
  {
    key: "instapay",
    name: "InstaPay",
    shortName: "إنستاباي",
    color: "#1D4ED8",
    prefixes: ["010", "011", "012", "015"],
  },
];

function _vfcProviderInfo(key) {
  return (
    WALLET_PROVIDERS.find(function (p) {
      return p.key === key;
    }) || WALLET_PROVIDERS[0]
  );
}

var VFC_LINES_HEADERS = [
  "id",
  "provider", // vodafone | orange | etisalat | we | instapay
  "customer_name",
  "vf_number",
  "branch",
  "employee",
  "party_id", // ربط اختياري بعميل من شيت Parties
  "status", // active | suspended
  "opening_balance",
  "daily_limit", // 0 = بدون حد
  "monthly_limit", // 0 = بدون حد
  "low_balance_threshold",
  "notes",
  "created_at",
  "updated_at",
  "created_by",
];

var VFC_TX_HEADERS = [
  "id",
  "line_id",
  "type", // deposit | withdraw | transfer_in | transfer_out | recharge
  "amount",
  "commission",
  "status", // success | failed | pending
  "ref_number",
  "counterparty",
  "date",
  "notes",
  "user",
  "created_at",
];

var VFC_IN_TYPES = ["deposit", "transfer_in", "recharge"];
var VFC_OUT_TYPES = ["withdraw", "transfer_out"];

// ── أدوات داخلية ─────────────────────────────────────────────────
function _vfcLines() {
  return readSheet("VodafoneCashLines", VFC_LINES_HEADERS, {
    trimStrings: true,
  });
}
function _vfcTx() {
  return readSheet("VodafoneCashTransactions", VFC_TX_HEADERS, {
    trimStrings: true,
  });
}

function _vfcDayKey(d) {
  var dt = new Date(d);
  if (isNaN(dt)) return "";
  return Utilities.formatDate(
    dt,
    Session.getScriptTimeZone() || "Africa/Cairo",
    "yyyy-MM-dd",
  );
}
function _vfcMonthKey(d) {
  var dt = new Date(d);
  if (isNaN(dt)) return "";
  return Utilities.formatDate(
    dt,
    Session.getScriptTimeZone() || "Africa/Cairo",
    "yyyy-MM",
  );
}

/**
 * يجمع كل العمليات حسب line_id في قراءة واحدة فقط (O(n))
 * ويحسب: الرصيد الحالي / إجمالي الإيداع / إجمالي السحب / العمولات /
 * عدد العمليات / آخر عملية / استهلاك اليوم والشهر الحاليين.
 */
function _vfcAggregateByLine(txs) {
  var agg = {};
  var todayKey = _vfcDayKey(new Date());
  var monthKey = _vfcMonthKey(new Date());
  txs.forEach(function (t) {
    if (t.status !== "success") return; // العمليات الفاشلة/المعلقة لا تؤثر على الرصيد
    if (!agg[t.line_id]) {
      agg[t.line_id] = {
        balance: 0,
        totalDeposit: 0,
        totalWithdraw: 0,
        totalCommission: 0,
        txCount: 0,
        lastTxDate: null,
        todayUsed: 0,
        monthUsed: 0,
        todayDeposit: 0,
        todayWithdraw: 0,
      };
    }
    var a = agg[t.line_id];
    var amt = Number(t.amount) || 0;
    var comm = Number(t.commission) || 0;
    a.txCount++;
    a.totalCommission += comm;
    if (VFC_IN_TYPES.indexOf(t.type) !== -1) {
      a.balance += amt;
      a.totalDeposit += amt;
    } else if (VFC_OUT_TYPES.indexOf(t.type) !== -1) {
      a.balance -= amt;
      a.totalWithdraw += amt;
    }
    if (!a.lastTxDate || new Date(t.date) > new Date(a.lastTxDate)) {
      a.lastTxDate = t.date;
    }
    var dKey = _vfcDayKey(t.date);
    var mKey = _vfcMonthKey(t.date);
    if (dKey === todayKey) {
      a.todayUsed += amt;
      if (VFC_IN_TYPES.indexOf(t.type) !== -1) a.todayDeposit += amt;
      if (VFC_OUT_TYPES.indexOf(t.type) !== -1) a.todayWithdraw += amt;
    }
    if (mKey === monthKey) a.monthUsed += amt;
  });
  return agg;
}

/** يحسب حالة الخط بالألوان: available | near_limit | needs_recharge | over_limit | suspended */
function _vfcLineStatus(line, a) {
  if (line.status === "suspended") return "suspended";
  var lowT = Number(line.low_balance_threshold) || 0;
  if (lowT > 0 && a.balance <= lowT) return "needs_recharge";
  var dailyL = Number(line.daily_limit) || 0;
  if (dailyL > 0) {
    var pct = a.todayUsed / dailyL;
    if (pct >= 1) return "over_limit";
    if (pct >= 0.85) return "near_limit";
  }
  var monthlyL = Number(line.monthly_limit) || 0;
  if (monthlyL > 0) {
    var pctM = a.monthUsed / monthlyL;
    if (pctM >= 1) return "over_limit";
    if (pctM >= 0.85) return "near_limit";
  }
  return "available";
}

var VFC_STATUS_META = {
  available: { label: "متاح", color: "#10B981", dot: "" },
  near_limit: { label: "اقترب من الحد", color: "#F59E0B", dot: "" },
  needs_recharge: { label: "يحتاج شحن", color: "#F97316", dot: "" },
  over_limit: { label: "تجاوز الحد", color: "#EF4444", dot: "" },
  suspended: { label: "موقوف", color: "#64748B", dot: "" },
};

function _vfcEnrichLine(line, a) {
  var status = _vfcLineStatus(line, a);
  var dailyL = Number(line.daily_limit) || 0;
  var monthlyL = Number(line.monthly_limit) || 0;
  var provider = _vfcProviderInfo(line.provider || "vodafone");
  return {
    id: line.id,
    provider: provider.key,
    providerName: provider.name,
    providerColor: provider.color,
    customer_name: line.customer_name,
    vf_number: line.vf_number,
    branch: line.branch || "",
    employee: line.employee || "",
    party_id: line.party_id || "",
    status: line.status,
    computedStatus: status,
    statusMeta: VFC_STATUS_META[status],
    balance: a.balance,
    dailyLimit: dailyL,
    dailyUsed: a.todayUsed,
    dailyRemaining: dailyL > 0 ? Math.max(0, dailyL - a.todayUsed) : null,
    dailyPct:
      dailyL > 0
        ? Math.min(100, Math.round((a.todayUsed / dailyL) * 100))
        : null,
    monthlyLimit: monthlyL,
    monthlyUsed: a.monthUsed,
    monthlyRemaining: monthlyL > 0 ? Math.max(0, monthlyL - a.monthUsed) : null,
    monthlyPct:
      monthlyL > 0
        ? Math.min(100, Math.round((a.monthUsed / monthlyL) * 100))
        : null,
    txCount: a.txCount,
    totalDeposit: a.totalDeposit,
    totalWithdraw: a.totalWithdraw,
    totalCommission: a.totalCommission,
    lastTxDate: a.lastTxDate,
    lowBalanceThreshold: Number(line.low_balance_threshold) || 0,
    notes: line.notes || "",
    created_at: line.created_at,
    updated_at: line.updated_at,
  };
}

// ── getVodafoneCashLines — قائمة الخطوط مع كل المؤشرات المحسوبة ──
function getVodafoneCashLines(filters) {
  try {
    filters = filters || {};
    var lines = _vfcLines();
    var txs = _vfcTx();
    var agg = _vfcAggregateByLine(txs);

    var result = lines.map(function (line) {
      var a = agg[line.id] || {
        balance: Number(line.opening_balance) || 0,
        totalDeposit: 0,
        totalWithdraw: 0,
        totalCommission: 0,
        txCount: 0,
        lastTxDate: null,
        todayUsed: 0,
        monthUsed: 0,
        todayDeposit: 0,
        todayWithdraw: 0,
      };
      if (agg[line.id]) {
        a = Object.assign({}, a, {
          balance: (Number(line.opening_balance) || 0) + a.balance,
        });
      }
      return _vfcEnrichLine(line, a);
    });

    if (filters.provider) {
      result = result.filter(function (l) {
        return l.provider === filters.provider;
      });
    }
    if (filters.status) {
      result = result.filter(function (l) {
        return l.computedStatus === filters.status;
      });
    }
    if (filters.branch) {
      result = result.filter(function (l) {
        return l.branch === filters.branch;
      });
    }
    if (filters.employee) {
      result = result.filter(function (l) {
        return l.employee === filters.employee;
      });
    }
    if (filters.search) {
      var q = String(filters.search).trim().toLowerCase();
      result = result.filter(function (l) {
        return (
          (l.customer_name || "").toLowerCase().indexOf(q) !== -1 ||
          (l.vf_number || "").indexOf(q) !== -1 ||
          (l.branch || "").toLowerCase().indexOf(q) !== -1 ||
          (l.employee || "").toLowerCase().indexOf(q) !== -1
        );
      });
    }

    result.sort(function (x, y) {
      return new Date(y.updated_at) - new Date(x.updated_at);
    });

    return okResponse("OK", { lines: result, providers: WALLET_PROVIDERS });
  } catch (e) {
    return errResponse("خطأ في جلب الخطوط: " + e.message);
  }
}

// ── getVodafoneCashLineDetail — صفحة تفاصيل خط واحد ──
function getVodafoneCashLineDetail(lineId) {
  try {
    var lines = _vfcLines();
    var line = lines.find(function (l) {
      return l.id === lineId;
    });
    if (!line) return errResponse("الخط غير موجود");

    var allTxs = _vfcTx().filter(function (t) {
      return t.line_id === lineId;
    });
    var agg = _vfcAggregateByLine(allTxs);
    var a = agg[lineId] || {
      balance: 0,
      totalDeposit: 0,
      totalWithdraw: 0,
      totalCommission: 0,
      txCount: 0,
      lastTxDate: null,
      todayUsed: 0,
      monthUsed: 0,
    };
    a.balance += Number(line.opening_balance) || 0;

    allTxs.sort(function (x, y) {
      return new Date(y.created_at) - new Date(x.created_at);
    });
    var last100 = allTxs.slice(0, 100);

    // سلسلة آخر 7 أيام (للرسم البياني)
    var series = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var key = _vfcDayKey(d);
      var dayTxs = allTxs.filter(function (t) {
        return t.status === "success" && _vfcDayKey(t.date) === key;
      });
      var dep = dayTxs
        .filter(function (t) {
          return VFC_IN_TYPES.indexOf(t.type) !== -1;
        })
        .reduce(function (s, t) {
          return s + (Number(t.amount) || 0);
        }, 0);
      var wd = dayTxs
        .filter(function (t) {
          return VFC_OUT_TYPES.indexOf(t.type) !== -1;
        })
        .reduce(function (s, t) {
          return s + (Number(t.amount) || 0);
        }, 0);
      series.push({ date: key, deposit: dep, withdraw: wd });
    }

    var auditLog = [];
    try {
      if (typeof readSheet === "function") {
        var auditRows = readSheet("AuditLog", AUDIT_HEADERS, {
          trimStrings: true,
        });
        auditLog = auditRows
          .filter(function (r) {
            return r.record_id === lineId;
          })
          .sort(function (x, y) {
            return new Date(y.timestamp || 0) - new Date(x.timestamp || 0);
          })
          .slice(0, 30);
      }
    } catch (eAudit) {
      auditLog = [];
    }

    return okResponse("OK", {
      line: _vfcEnrichLine(line, a),
      transactions: last100,
      series: series,
      auditLog: auditLog,
    });
  } catch (e) {
    return errResponse("خطأ في جلب تفاصيل الخط: " + e.message);
  }
}

// ── getVodafoneCashTransactions — سجل العمليات مع فلاتر ──
function getVodafoneCashTransactions(filters) {
  try {
    filters = filters || {};
    var txs = _vfcTx();
    var lines = _vfcLines();
    var lineMap = {};
    lines.forEach(function (l) {
      lineMap[l.id] = l;
    });

    var result = txs.map(function (t) {
      var line = lineMap[t.line_id] || {};
      var provider = _vfcProviderInfo(line.provider || "vodafone");
      return Object.assign({}, t, {
        customer_name: line.customer_name || "—",
        vf_number: line.vf_number || "",
        provider: provider.key,
        providerName: provider.name,
        providerColor: provider.color,
      });
    });

    if (filters.line_id) {
      result = result.filter(function (t) {
        return t.line_id === filters.line_id;
      });
    }
    if (filters.provider) {
      result = result.filter(function (t) {
        return t.provider === filters.provider;
      });
    }
    if (filters.type) {
      result = result.filter(function (t) {
        return t.type === filters.type;
      });
    }
    if (filters.status) {
      result = result.filter(function (t) {
        return t.status === filters.status;
      });
    }
    if (filters.dateFrom) {
      result = result.filter(function (t) {
        return new Date(t.date) >= new Date(filters.dateFrom);
      });
    }
    if (filters.dateTo) {
      result = result.filter(function (t) {
        return new Date(t.date) <= new Date(filters.dateTo);
      });
    }
    if (filters.search) {
      var q = String(filters.search).trim().toLowerCase();
      result = result.filter(function (t) {
        return (
          (t.customer_name || "").toLowerCase().indexOf(q) !== -1 ||
          (t.vf_number || "").indexOf(q) !== -1 ||
          (t.ref_number || "").toLowerCase().indexOf(q) !== -1 ||
          (t.counterparty || "").toLowerCase().indexOf(q) !== -1
        );
      });
    }

    result.sort(function (x, y) {
      return new Date(y.created_at) - new Date(x.created_at);
    });

    var limit = Number(filters.limit) || 200;
    return okResponse("OK", {
      transactions: result.slice(0, limit),
      total: result.length,
    });
  } catch (e) {
    return errResponse("خطأ في جلب العمليات: " + e.message);
  }
}

// ── getVodafoneCashDashboardStats — كل مؤشرات KPI + رسوم بيانية ──
function getVodafoneCashDashboardStats(provider) {
  try {
    var lines = _vfcLines();
    var txs = _vfcTx();
    if (provider) {
      lines = lines.filter(function (l) {
        return l.provider === provider;
      });
      txs = txs.filter(function (t) {
        return t.provider === provider;
      });
    }
    var agg = _vfcAggregateByLine(txs);
    var enriched = lines.map(function (line) {
      var a = agg[line.id] || {
        balance: 0,
        totalDeposit: 0,
        totalWithdraw: 0,
        totalCommission: 0,
        txCount: 0,
        lastTxDate: null,
        todayUsed: 0,
        monthUsed: 0,
        todayDeposit: 0,
        todayWithdraw: 0,
      };
      a.balance += Number(line.opening_balance) || 0;
      return _vfcEnrichLine(line, a);
    });

    var todayKey = _vfcDayKey(new Date());
    var yesterdayKey = _vfcDayKey(new Date(Date.now() - 86400000));
    var todayTxs = txs.filter(function (t) {
      return _vfcDayKey(t.date) === todayKey;
    });
    var yesterdayTxs = txs.filter(function (t) {
      return _vfcDayKey(t.date) === yesterdayKey;
    });

    var kpis = {
      activeLines: enriched.filter(function (l) {
        return l.status === "active";
      }).length,
      suspendedLines: enriched.filter(function (l) {
        return l.status === "suspended";
      }).length,
      totalBalance: enriched.reduce(function (s, l) {
        return s + l.balance;
      }, 0),
      todayTxCount: todayTxs.length,
      todayDeposits: todayTxs
        .filter(function (t) {
          return t.status === "success" && VFC_IN_TYPES.indexOf(t.type) !== -1;
        })
        .reduce(function (s, t) {
          return s + (Number(t.amount) || 0);
        }, 0),
      todayWithdrawals: todayTxs
        .filter(function (t) {
          return t.status === "success" && VFC_OUT_TYPES.indexOf(t.type) !== -1;
        })
        .reduce(function (s, t) {
          return s + (Number(t.amount) || 0);
        }, 0),
      todayCommission: todayTxs
        .filter(function (t) {
          return t.status === "success";
        })
        .reduce(function (s, t) {
          return s + (Number(t.commission) || 0);
        }, 0),
      pendingCount: txs.filter(function (t) {
        return t.status === "pending";
      }).length,
      failedCount: txs.filter(function (t) {
        return t.status === "failed";
      }).length,
      nearLimitCount: enriched.filter(function (l) {
        return l.computedStatus === "near_limit";
      }).length,
      overLimitCount: enriched.filter(function (l) {
        return l.computedStatus === "over_limit";
      }).length,
      needsRechargeCount: enriched.filter(function (l) {
        return l.computedStatus === "needs_recharge";
      }).length,
      vsYesterdayTxPct:
        yesterdayTxs.length > 0
          ? Math.round(
              ((todayTxs.length - yesterdayTxs.length) / yesterdayTxs.length) *
                100,
            )
          : null,
    };

    // رسم بياني: آخر 7 أيام إيداع/سحب
    var weekSeries = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var key = _vfcDayKey(d);
      var dayTxs = txs.filter(function (t) {
        return t.status === "success" && _vfcDayKey(t.date) === key;
      });
      weekSeries.push({
        date: key,
        deposit: dayTxs
          .filter(function (t) {
            return VFC_IN_TYPES.indexOf(t.type) !== -1;
          })
          .reduce(function (s, t) {
            return s + (Number(t.amount) || 0);
          }, 0),
        withdraw: dayTxs
          .filter(function (t) {
            return VFC_OUT_TYPES.indexOf(t.type) !== -1;
          })
          .reduce(function (s, t) {
            return s + (Number(t.amount) || 0);
          }, 0),
      });
    }

    // أكثر الخطوط استخداماً (Top 5)
    var topLines = enriched
      .slice()
      .sort(function (x, y) {
        return y.txCount - x.txCount;
      })
      .slice(0, 5)
      .map(function (l) {
        return {
          id: l.id,
          name: l.customer_name,
          vf_number: l.vf_number,
          txCount: l.txCount,
        };
      });

    // أكثر الموظفين تنفيذاً للعمليات
    var empCounts = {};
    txs.forEach(function (t) {
      if (!t.user) return;
      empCounts[t.user] = (empCounts[t.user] || 0) + 1;
    });
    var topEmployees = Object.keys(empCounts)
      .map(function (u) {
        return { user: u, count: empCounts[u] };
      })
      .sort(function (x, y) {
        return y.count - x.count;
      })
      .slice(0, 5);

    // نسبة استخدام الشركات
    var providerUsage = WALLET_PROVIDERS.map(function (p) {
      var pLines = enriched.filter(function (l) {
        return l.provider === p.key;
      });
      return {
        provider: p.key,
        name: p.name,
        color: p.color,
        linesCount: pLines.length,
        balance: pLines.reduce(function (s, l) {
          return s + l.balance;
        }, 0),
        txCount: pLines.reduce(function (s, l) {
          return s + l.txCount;
        }, 0),
      };
    });

    return okResponse("OK", {
      kpis: kpis,
      weekSeries: weekSeries,
      topLines: topLines,
      topEmployees: topEmployees,
      providerUsage: providerUsage,
    });
  } catch (e) {
    return errResponse("خطأ في جلب الإحصائيات: " + e.message);
  }
}

// ── getVodafoneCashInsights — ذكاء الأعمال (Business Insights) ──
function getVodafoneCashInsights(provider) {
  try {
    var lines = _vfcLines();
    var txs = _vfcTx();
    if (provider) {
      lines = lines.filter(function (l) {
        return l.provider === provider;
      });
      txs = txs.filter(function (t) {
        return t.provider === provider;
      });
    }
    var agg = _vfcAggregateByLine(txs);
    var enriched = lines.map(function (line) {
      var a = agg[line.id] || {
        balance: 0,
        totalDeposit: 0,
        totalWithdraw: 0,
        totalCommission: 0,
        txCount: 0,
        lastTxDate: null,
        todayUsed: 0,
        monthUsed: 0,
      };
      a.balance += Number(line.opening_balance) || 0;
      return _vfcEnrichLine(line, a);
    });

    var todayKey = _vfcDayKey(new Date());
    var todayTxByLine = {};
    txs.forEach(function (t) {
      if (t.status !== "success" || _vfcDayKey(t.date) !== todayKey) return;
      todayTxByLine[t.line_id] = (todayTxByLine[t.line_id] || 0) + 1;
    });

    var bestLineToday = null,
      bestCount = 0;
    Object.keys(todayTxByLine).forEach(function (lid) {
      if (todayTxByLine[lid] > bestCount) {
        bestCount = todayTxByLine[lid];
        bestLineToday = lid;
      }
    });
    var bestLine = enriched.find(function (l) {
      return l.id === bestLineToday;
    });

    var activeLines = enriched.filter(function (l) {
      return l.status === "active";
    });
    var leastUsed = activeLines.slice().sort(function (x, y) {
      return x.txCount - y.txCount;
    })[0];

    var needsLimitIncrease = enriched.filter(function (l) {
      return (
        l.computedStatus === "over_limit" || l.computedStatus === "near_limit"
      );
    });

    var shouldStop = enriched.filter(function (l) {
      if (l.status !== "active" || !l.lastTxDate) return false;
      var days = (Date.now() - new Date(l.lastTxDate).getTime()) / 86400000;
      return days >= 30 && l.txCount > 0;
    });

    var sevenDaysAgo = Date.now() - 7 * 86400000;
    var unusedWeek = enriched.filter(function (l) {
      if (l.status !== "active") return false;
      if (!l.lastTxDate) return true;
      return new Date(l.lastTxDate).getTime() < sevenDaysAgo;
    });

    return okResponse("OK", {
      bestLineToday: bestLine
        ? {
            id: bestLine.id,
            name: bestLine.customer_name,
            vf_number: bestLine.vf_number,
            count: bestCount,
          }
        : null,
      leastUsedLine: leastUsed
        ? {
            id: leastUsed.id,
            name: leastUsed.customer_name,
            vf_number: leastUsed.vf_number,
            txCount: leastUsed.txCount,
          }
        : null,
      needsLimitIncrease: needsLimitIncrease.map(function (l) {
        return {
          id: l.id,
          name: l.customer_name,
          vf_number: l.vf_number,
          status: l.computedStatus,
        };
      }),
      shouldStop: shouldStop.map(function (l) {
        return {
          id: l.id,
          name: l.customer_name,
          vf_number: l.vf_number,
          lastTxDate: l.lastTxDate,
        };
      }),
      unusedWeek: unusedWeek.map(function (l) {
        return {
          id: l.id,
          name: l.customer_name,
          vf_number: l.vf_number,
          lastTxDate: l.lastTxDate,
        };
      }),
    });
  } catch (e) {
    return errResponse("خطأ في جلب رؤى الأعمال: " + e.message);
  }
}

// ── getVodafoneCashAlerts — مركز التنبيهات ──
function getVodafoneCashAlerts(provider) {
  try {
    var lines = _vfcLines();
    var txs = _vfcTx();
    if (provider) {
      lines = lines.filter(function (l) {
        return l.provider === provider;
      });
      txs = txs.filter(function (t) {
        return t.provider === provider;
      });
    }
    var agg = _vfcAggregateByLine(txs);
    var alerts = [];

    lines.forEach(function (line) {
      var a = agg[line.id] || {
        balance: 0,
        totalDeposit: 0,
        totalWithdraw: 0,
        totalCommission: 0,
        txCount: 0,
        lastTxDate: null,
        todayUsed: 0,
        monthUsed: 0,
      };
      a.balance += Number(line.opening_balance) || 0;
      var enriched = _vfcEnrichLine(line, a);

      if (enriched.computedStatus === "over_limit") {
        alerts.push({
          type: "over_limit",
          severity: "critical",
          message:
            "الخط " +
            line.vf_number +
            " (" +
            line.customer_name +
            ") تجاوز الحد المسموح",
          lineId: line.id,
          date: new Date().toISOString(),
        });
      }
      if (enriched.computedStatus === "needs_recharge") {
        alerts.push({
          type: "low_balance",
          severity: "warning",
          message:
            "رصيد الخط " +
            line.vf_number +
            " (" +
            line.customer_name +
            ") منخفض",
          lineId: line.id,
          date: new Date().toISOString(),
        });
      }
      if (line.status === "active" && enriched.lastTxDate) {
        var days =
          (Date.now() - new Date(enriched.lastTxDate).getTime()) / 86400000;
        if (days >= 7) {
          alerts.push({
            type: "unused",
            severity: "info",
            message:
              "الخط " +
              line.vf_number +
              " (" +
              line.customer_name +
              ") غير مستخدم منذ " +
              Math.floor(days) +
              " يوم",
            lineId: line.id,
            date: new Date().toISOString(),
          });
        }
      }
    });

    var last24h = Date.now() - 86400000;
    txs.forEach(function (t) {
      if (
        t.status === "failed" &&
        new Date(t.created_at).getTime() >= last24h
      ) {
        alerts.push({
          type: "failed_tx",
          severity: "warning",
          message: "عملية فاشلة بقيمة " + (Number(t.amount) || 0) + " ج.م",
          lineId: t.line_id,
          date: t.created_at,
        });
      }
      if (t.status === "pending" && (Number(t.amount) || 0) >= 10000) {
        alerts.push({
          type: "large_pending",
          severity: "critical",
          message:
            "عملية معلقة كبيرة بقيمة " +
            (Number(t.amount) || 0) +
            " ج.م تحتاج مراجعة",
          lineId: t.line_id,
          date: t.created_at,
        });
      }
    });

    alerts.sort(function (x, y) {
      var order = { critical: 0, warning: 1, info: 2 };
      return order[x.severity] - order[y.severity];
    });

    return okResponse("OK", { alerts: alerts });
  } catch (e) {
    return errResponse("خطأ في جلب التنبيهات: " + e.message);
  }
}

// ── getVodafoneCashAllData — جلب كل بيانات الداشبورد في طلب واحد ──
function getVodafoneCashAllData(params) {
  try {
    var provider = (params && params.provider) || "";
    var filters = (params && params.filters) || {};

    // ── قراءة الشيت مرة واحدة فقط ───────────────────────────────
    var allLines = _vfcLines();
    var allTxs = _vfcTx();

    // ── فلترة بالشركة ────────────────────────────────────────────
    var lines = provider
      ? allLines.filter(function (l) {
          return l.provider === provider;
        })
      : allLines;
    var txs = provider
      ? allTxs.filter(function (t) {
          return t.provider === provider;
        })
      : allTxs;

    // ── STATS ─────────────────────────────────────────────────────
    var agg = _vfcAggregateByLine(txs);
    var enriched = lines.map(function (line) {
      var a = agg[line.id] || {
        balance: 0,
        totalDeposit: 0,
        totalWithdraw: 0,
        totalCommission: 0,
        txCount: 0,
        lastTxDate: null,
        todayUsed: 0,
        monthUsed: 0,
        todayDeposit: 0,
        todayWithdraw: 0,
      };
      a.balance += Number(line.opening_balance) || 0;
      return _vfcEnrichLine(line, a);
    });

    var todayKey = _vfcDayKey(new Date());
    var yesterdayKey = _vfcDayKey(new Date(Date.now() - 86400000));
    var todayTxs = txs.filter(function (t) {
      return _vfcDayKey(t.date) === todayKey;
    });

    // إعادة استخدام نفس منطق getVodafoneCashDashboardStats
    var statsResult = getVodafoneCashDashboardStats(provider);

    // ── LINES (مع فلاتر الجدول) ────────────────────────────────
    var linesResult = getVodafoneCashLines(
      Object.assign({ provider: provider }, filters),
    );

    // ── ALERTS ────────────────────────────────────────────────────
    var alertsResult = getVodafoneCashAlerts(provider);

    // ── INSIGHTS ──────────────────────────────────────────────────
    var insightsResult = getVodafoneCashInsights(provider);

    return {
      success: true,
      stats: statsResult,
      lines: linesResult,
      alerts: alertsResult,
      insights: insightsResult,
    };
  } catch (e) {
    return errResponse("خطأ في جلب بيانات الداشبورد: " + e.message);
  }
}

// ── addVodafoneCashLine — إضافة خط/عميل جديد ──
function addVodafoneCashLine(data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      data.callerUser,
      "addVodafoneCashLine",
      data.sessionToken,
    );
    if (permErr) return permErr;

    var name = String(data.customer_name || "").trim();
    var vf = String(data.vf_number || "").trim();
    var provider = String(data.provider || "vodafone").trim();
    if (
      !WALLET_PROVIDERS.some(function (p) {
        return p.key === provider;
      })
    )
      provider = "vodafone";
    if (!name) return errResponse("اسم العميل مطلوب");
    // [VALIDATION-ENGINE] كان regex محلي مكرر هنا وفي updateVodafoneCashLine
    // تحت — موحّد الآن عبر ValidationEngine.isValidEgyptPhone.
    if (!ValidationEngine.isValidEgyptPhone(vf))
      return errResponse(
        "رقم الهاتف غير صالح — يجب أن يكون 11 رقم ويبدأ بـ 01",
      );

    var existing = _vfcLines();
    var dup = existing.find(function (l) {
      return l.vf_number === vf && l.provider === provider;
    });
    if (dup)
      return errResponse(
        "هذا الرقم مسجل بالفعل على نفس الشركة لعميل: " + dup.customer_name,
      );

    var id = makeId("VFL");
    var now = new Date().toISOString();
    var sheet = getSheet("VodafoneCashLines", VFC_LINES_HEADERS);
    _appendRowProtected(sheet, VFC_LINES_HEADERS, [
      id,
      provider,
      name,
      vf,
      String(data.branch || "").trim(),
      String(data.employee || "").trim(),
      String(data.party_id || "").trim(),
      data.status === "suspended" ? "suspended" : "active",
      Number(data.opening_balance) || 0,
      Number(data.daily_limit) || 0,
      Number(data.monthly_limit) || 0,
      Number(data.low_balance_threshold) || 0,
      String(data.notes || "").trim(),
      now,
      now,
      data.callerUser,
    ]);

    AuditEngine.log("addVodafoneCashLine", {
      user: data.callerUser,
      table: "VodafoneCashLines",
      record_id: id,
      details: name + " — " + vf + " — " + provider});

    return okResponse("تمت إضافة العميل بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة العميل: " + e.message);
  }
}

// ── updateVodafoneCashLine — تعديل بيانات خط/عميل ──
function updateVodafoneCashLine(id, data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      data.callerUser,
      "updateVodafoneCashLine",
      data.sessionToken,
    );
    if (permErr) return permErr;

    var sheet = getSheet("VodafoneCashLines", VFC_LINES_HEADERS);
    var values = sheet.getDataRange().getValues();
    var idx = -1;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return errResponse("الخط غير موجود");

    var h = VFC_LINES_HEADERS;
    function col(name) {
      return h.indexOf(name);
    }
    // [ARCH-AUDIT-P3-12] كانت بتعدّل مصفوفة الصف الخام مباشرة (row[col(...)]
    // = value) بعد كده setValues خام. حوّلناها لكائن patch مباشرة (نفس شرط
    // "لو الحقل موجود جوه data" الأصلي)، وDataLayerEngine.update() بتعمل
    // نفس منطق "الحقل الموجود في patch يغلب current" تلقائيًا.
    var patch = {};
    if (data.customer_name !== undefined)
      patch.customer_name = String(data.customer_name).trim();
    if (data.vf_number !== undefined) {
      var vf = String(data.vf_number).trim();
      if (!ValidationEngine.isValidEgyptPhone(vf))
        return errResponse("رقم الهاتف غير صالح");
      patch.vf_number = vf;
    }
    if (
      data.provider !== undefined &&
      WALLET_PROVIDERS.some(function (p) {
        return p.key === data.provider;
      })
    )
      patch.provider = data.provider;
    if (data.branch !== undefined) patch.branch = String(data.branch).trim();
    if (data.employee !== undefined)
      patch.employee = String(data.employee).trim();
    if (data.low_balance_threshold !== undefined)
      patch.low_balance_threshold = Number(data.low_balance_threshold) || 0;
    if (data.daily_limit !== undefined)
      patch.daily_limit = Number(data.daily_limit) || 0;
    if (data.monthly_limit !== undefined)
      patch.monthly_limit = Number(data.monthly_limit) || 0;
    if (data.notes !== undefined) patch.notes = String(data.notes).trim();

    var _vfcUpdateResult = DataLayerEngine.update(
      "VodafoneCashLines",
      id,
      patch,
      { headers: VFC_LINES_HEADERS },
    );
    if (!_vfcUpdateResult.ok)
      return errResponse(
        _vfcUpdateResult.errorMessage || "تعذّر حفظ تعديلات الخط",
      );

    AuditEngine.log("updateVodafoneCashLine", {
      user: data.callerUser,
      table: "VodafoneCashLines",
      record_id: id,
      details: ""});

    return okResponse("تم تعديل بيانات العميل بنجاح");
  } catch (e) {
    return errResponse("خطأ في تعديل العميل: " + e.message);
  }
}

// ── setVodafoneCashLineLimits — تعديل الحدود اليومية/الشهرية فقط ──
function setVodafoneCashLineLimits(id, data) {
  return updateVodafoneCashLine(id, {
    callerUser: data.callerUser,
    sessionToken: data.sessionToken,
    daily_limit: data.daily_limit,
    monthly_limit: data.monthly_limit,
  });
}

// ── setVodafoneCashLineParty — ربط/فك ارتباط عميل من شيت العملاء ──
function setVodafoneCashLineParty(id, partyId, data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      data.callerUser,
      "updateVodafoneCashLine",
      data.sessionToken,
    );
    if (permErr) return permErr;

    var sheet = getSheet("VodafoneCashLines", VFC_LINES_HEADERS);
    var values = sheet.getDataRange().getValues();
    var idx = -1;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return errResponse("الخط غير موجود");

    // [ARCH-AUDIT-P3-13] setValues خام -> DataLayerEngine.update
    var _vfcPartyResult = DataLayerEngine.update(
      "VodafoneCashLines",
      id,
      { party_id: String(partyId || "").trim() },
      { headers: VFC_LINES_HEADERS },
    );
    if (!_vfcPartyResult.ok)
      return errResponse(
        _vfcPartyResult.errorMessage || "تعذّر تحديث ربط العميل",
      );

    AuditEngine.log(partyId
        ? "linkVodafoneCashCustomer"
        : "unlinkVodafoneCashCustomer", {
      user: data.callerUser,
      table: "VodafoneCashLines",
      record_id: id,
      details: String(partyId || "")});

    return okResponse(partyId ? "تم ربط العميل بالخط" : "تم فك ارتباط العميل");
  } catch (e) {
    return errResponse("خطأ في ربط العميل: " + e.message);
  }
}

// ── setVodafoneCashLineStatus — إيقاف/تشغيل الخط ──
function setVodafoneCashLineStatus(id, status, data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      data.callerUser,
      "updateVodafoneCashLine",
      data.sessionToken,
    );
    if (permErr) return permErr;
    if (["active", "suspended"].indexOf(status) === -1)
      return errResponse("حالة غير صالحة");

    var sheet = getSheet("VodafoneCashLines", VFC_LINES_HEADERS);
    var values = sheet.getDataRange().getValues();
    var idx = -1;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return errResponse("الخط غير موجود");

    // [ARCH-AUDIT-P3-14] setValues خام -> DataLayerEngine.update
    var _vfcStatusResult = DataLayerEngine.update(
      "VodafoneCashLines",
      id,
      { status: status },
      { headers: VFC_LINES_HEADERS },
    );
    if (!_vfcStatusResult.ok)
      return errResponse(
        _vfcStatusResult.errorMessage || "تعذّر تحديث حالة الخط",
      );

    AuditEngine.log("setVodafoneCashLineStatus", {
      user: data.callerUser,
      table: "VodafoneCashLines",
      record_id: id,
      details: status});

    return okResponse(
      status === "suspended" ? "تم إيقاف الخط" : "تم تشغيل الخط",
    );
  } catch (e) {
    return errResponse("خطأ في تغيير حالة الخط: " + e.message);
  }
}

// ── deleteVodafoneCashLine — حذف خط (يمنع الحذف لو له عمليات) ──
function deleteVodafoneCashLine(id, data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      data.callerUser,
      "deleteVodafoneCashLine",
      data.sessionToken,
    );
    if (permErr) return permErr;

    var hasTx = _vfcTx().some(function (t) {
      return t.line_id === id;
    });
    if (hasTx)
      return errResponse(
        "لا يمكن حذف هذا الخط لوجود عمليات مسجلة عليه — يمكنك إيقافه بدلاً من ذلك",
      );

    var sheet = getSheet("VodafoneCashLines", VFC_LINES_HEADERS);
    var values = sheet.getDataRange().getValues();
    var idx = -1;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return errResponse("الخط غير موجود");
    sheet.deleteRow(idx + 1);

    AuditEngine.log("deleteVodafoneCashLine", {
      user: data.callerUser,
      table: "VodafoneCashLines",
      record_id: id,
      details: ""});

    return okResponse("تم حذف الخط بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف الخط: " + e.message);
  }
}

// ── addVodafoneCashTransaction — تسجيل عملية (إيداع/سحب/تحويل/شحن) ──
function addVodafoneCashTransaction(data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      data.callerUser,
      "addVodafoneCashTransaction",
      data.sessionToken,
    );
    if (permErr) return permErr;

    var lineId = String(data.line_id || "").trim();
    var type = String(data.type || "").trim();
    var amount = Number(data.amount) || 0;
    var validTypes = VFC_IN_TYPES.concat(VFC_OUT_TYPES);
    if (!lineId) return errResponse("الخط مطلوب");
    if (validTypes.indexOf(type) === -1)
      return errResponse("نوع العملية غير صالح");
    if (amount <= 0) return errResponse("المبلغ يجب أن يكون أكبر من صفر");

    var line = _vfcLines().find(function (l) {
      return l.id === lineId;
    });
    if (!line) return errResponse("الخط غير موجود");
    if (line.status === "suspended")
      return errResponse("لا يمكن تسجيل عمليات على خط موقوف");

    var id = makeId("VFT");
    var now = new Date().toISOString();
    var sheet = getSheet("VodafoneCashTransactions", VFC_TX_HEADERS);
    _appendRowProtected(sheet, VFC_TX_HEADERS, [
      id,
      lineId,
      type,
      amount,
      Number(data.commission) || 0,
      ["success", "failed", "pending"].indexOf(data.status) !== -1
        ? data.status
        : "success",
      String(data.ref_number || "").trim(),
      String(data.counterparty || "").trim(),
      data.date || now,
      String(data.notes || "").trim(),
      data.callerUser,
      now,
    ]);

    // تحديث updated_at بتاع الخط عشان يظهر فوق في الترتيب
    // [ARCH-AUDIT-P3-15] setValues خام -> DataLayerEngine.update
    DataLayerEngine.update(
      "VodafoneCashLines",
      lineId,
      { updated_at: now },
      { headers: VFC_LINES_HEADERS },
    );

    AuditEngine.log("addVodafoneCashTransaction", {
      user: data.callerUser,
      table: "VodafoneCashTransactions",
      record_id: id,
      details: type + " — " + amount + " ج.م — خط " + line.vf_number});

    // ─── [C13-FIX] قيد محاسبي تلقائي لعمليات المحافظ الإلكترونية ───────────
    // قاعدة: كل حركة نقدية يجب أن تنعكس في الأستاذ العام (GL)
    // بدون هذا القيد: المحافظ الإلكترونية غير موجودة في القوائم المالية
    //
    // قيد الإيداع/التحويل الوارد (IN):
    //   مدين:  حساب المحفظة الإلكترونية (ASSET)
    //   دائن:  الصندوق أو البنك المصدر (أو حساب إيرادات إن وُجد)
    //
    // قيد السحب/التحويل الصادر (OUT):
    //   مدين:  المصروف أو الحساب المدين (أو ذمم)
    //   دائن:  حساب المحفظة الإلكترونية (ASSET)
    // ────────────────────────────────────────────────────────────────────────
    if (
      data.status !== "failed" &&
      data.status !== "pending" &&
      ["success", undefined, ""].indexOf(String(data.status || "success")) !==
        -1
    ) {
      try {
        var vfcAccounts = readSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );

        // ابحث عن حساب المحفظة المرتبط بهذا الخط
        // [FIX] كان الكود يبحث بالاسم مباشرة (_findAccountByNameHints) في كل
        // استدعاء بدل استخدام مفتاح عام مثبَّت في AccountingSettings — أضفنا
        // مفتاح "mobile_wallet_account" لـ POSTING_CONFIG_KEYS ليستفيد هذا
        // الموضع من نفس آلية التثبيت التلقائي المستخدمة في باقي النظام.
        var walletAccountId = line.account_id || null;

        if (!walletAccountId) {
          var walletResolved = resolvePostingAccount({
            accounts: vfcAccounts,
            key: "mobile_wallet_account",
            type: "ASSET",
            hints: [
              "محفظة",
              "فودافون",
              "أورنج",
              "اتصالات",
              "وي",
              "انستاباي",
              "vodafone",
              "mobile wallet",
              "wallet",
            ],
          });
          if (walletResolved.account)
            walletAccountId = walletResolved.account.id;
        }

        // الحساب المقابل (الصندوق أو حساب عام)
        var counterAccountId = null;
        var cashResolved = resolvePostingAccount({
          accounts: vfcAccounts,
          key: "cash_account",
          type: "ASSET",
          hints: ["الصندوق", "خزينة رئيسية", "cash", "صندوق"],
        });
        if (cashResolved.account) counterAccountId = cashResolved.account.id;

        if (walletAccountId && counterAccountId) {
          var isIn = VFC_IN_TYPES.indexOf(type) !== -1;
          var totalWithCommission = amount + Number(data.commission || 0);

          var glLines = isIn
            ? [
                // الإيداع الوارد: مدين المحفظة / دائن الصندوق
                {
                  account_id: walletAccountId,
                  debit: amount,
                  credit: 0,
                  notes: "إيداع محفظة — " + line.vf_number + " (" + type + ")",
                },
                {
                  account_id: counterAccountId,
                  debit: 0,
                  credit: amount,
                  notes: "مصدر التمويل — " + (data.counterparty || type),
                },
              ]
            : [
                // السحب الصادر: مدين الصندوق / دائن المحفظة
                {
                  account_id: counterAccountId,
                  debit: amount,
                  credit: 0,
                  notes: "سحب من محفظة — " + line.vf_number + " (" + type + ")",
                },
                {
                  account_id: walletAccountId,
                  debit: 0,
                  credit: amount,
                  notes: "خروج من المحفظة — " + (data.counterparty || type),
                },
              ];

          var txDate = data.date
            ? String(data.date).split("T")[0]
            : new Date().toISOString().split("T")[0];

          _addJournalEntryInternal({
            callerUser: data.callerUser || "SYSTEM",
            date: txDate,
            reference: id,
            source_type: "WALLET_" + (isIn ? "IN" : "OUT"),
            description:
              (isIn ? "إيداع" : "سحب") +
              " محفظة — " +
              (line.provider || "VFC") +
              " — " +
              line.vf_number,
            lines: glLines,
          });
        } else {
          Logger.log(
            "[C13-FIX] تحذير: لم يُعثر على حساب المحفظة أو الصندوق في دليل الحسابات — لن يُسجَّل قيد للعملية " +
              id,
          );
          Logger.log(
            "[C13-FIX] لتفعيل الدمج المحاسبي: أضف حساباً من نوع ASSET يحتوي على كلمة 'محفظة' في دليل الحسابات",
          );
        }
      } catch (glErr) {
        Logger.log("[C13-FIX] خطأ في قيد محفظة فودافون كاش: " + glErr.message);
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    return okResponse("تم تسجيل العملية بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في تسجيل العملية: " + e.message);
  }
}

// ── updateVodafoneCashTransactionStatus — تعديل حالة العملية ──
function updateVodafoneCashTransactionStatus(id, status, data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      data.callerUser,
      "updateVodafoneCashTransaction",
      data.sessionToken,
    );
    if (permErr) return permErr;
    if (["success", "failed", "pending"].indexOf(status) === -1)
      return errResponse("حالة غير صالحة");

    var sheet = getSheet("VodafoneCashTransactions", VFC_TX_HEADERS);
    var values = sheet.getDataRange().getValues();
    var idx = -1;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return errResponse("العملية غير موجودة");

    // [ARCH-AUDIT-P3-16] setValues خام -> DataLayerEngine.update
    var _vfcTxResult = DataLayerEngine.update(
      "VodafoneCashTransactions",
      id,
      { status: status },
      { headers: VFC_TX_HEADERS },
    );
    if (!_vfcTxResult.ok)
      return errResponse(
        _vfcTxResult.errorMessage || "تعذّر تحديث حالة العملية",
      );

    AuditEngine.log("updateVodafoneCashTransactionStatus", {
      user: data.callerUser,
      table: "VodafoneCashTransactions",
      record_id: id,
      details: status});

    return okResponse("تم تحديث حالة العملية");
  } catch (e) {
    return errResponse("خطأ في تحديث حالة العملية: " + e.message);
  }
}

// ── deleteVodafoneCashTransaction — حذف عملية ──
function deleteVodafoneCashTransaction(id, data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      data.callerUser,
      "deleteVodafoneCashTransaction",
      data.sessionToken,
    );
    if (permErr) return permErr;

    var sheet = getSheet("VodafoneCashTransactions", VFC_TX_HEADERS);
    var values = sheet.getDataRange().getValues();
    var idx = -1;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return errResponse("العملية غير موجودة");
    sheet.deleteRow(idx + 1);

    AuditEngine.log("deleteVodafoneCashTransaction", {
      user: data.callerUser,
      table: "VodafoneCashTransactions",
      record_id: id,
      details: ""});

    return okResponse("تم حذف العملية بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف العملية: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// نهاية §VFC — مركز عمليات المحافظ الإلكترونية
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════

