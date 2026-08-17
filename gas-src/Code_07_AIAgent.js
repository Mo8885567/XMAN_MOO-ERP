// ════════════════════════════════════════════════════════════════
// Code_AIAgent.gs — [REFACTOR-P4] نُقل من Code_Modules.gs (نقل نصي بحت، صفر
// تغيير في المنطق أو الترتيب الداخلي). Apps Script يعامل كل ملفات .gs
// كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء طالما
// الأسماء لم تتغير (ولم تتغير). راجع تقرير Architecture Audit
// 2026-07-03 — قسم 2 (Code_Modules.gs احتاج فحص لتحديد محتواه الفعلي).
//
// المسؤولية: المساعد الذكي — AI Agent v6 (Rate Limiting، Audit Log، تنفيذ الأدوات Read/Write، proxyAIAgent)
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 33912-34980] AI Agent v6 ┄┄┄
// §AI-AGENT-v6  المساعد الذكي — AI Agent v6
// Tool Calling | Rate Limiting | Audit Logging | Permission-Aware
// ═══════════════════════════════════════════════════════════════════════════

var AI_RATE_LIMIT_CACHE_PREFIX = "ai_rate_";
var AI_RATE_LIMIT_MAX = 30;
// حد أقصى 30 طلب يومياً للمستخدم
var AI_RATE_LIMIT_WINDOW = 86400;
// نافذة يوم كامل بالثواني
var AI_AGENT_VERSION = "6.0";
// ── Helper: جلب حالة Rate Limit للمستخدم ──────────────────────────────────
function _getAIRateKey(username) {
  var today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return AI_RATE_LIMIT_CACHE_PREFIX + username + "_" + today;
}
// [CACHE-ENGINE / المرحلة 13 — P1] كان هنا CacheService.getScriptCache()
// مباشر (namespace/prefix يدوي عبر AI_RATE_LIMIT_CACHE_PREFIX). دلوقتي
// بيمر عبر CacheEngine الموحّد (CACHE_NAMESPACE.AI_AGENT) — بادئة المفتاح
// بقت موحّدة زي كل الموديولات التانية بدل ما تفضل مكتوبة يدويًا هنا بس.
// ملحوظة: AI_RATE_LIMIT_WINDOW (86400 = 24 ساعة) أكبر من الحد الأقصى
// الفعلي لـ CacheService (21600 ثانية = 6 ساعات — نفس حد CACHE_POLICY.REFERENCE)
// — ده سلوك موجود من قبل هذا التعديل ولم يتغيّر (صفر تغيير في Business
// Logic)، فقط موثّق هنا لأنه ظهر أثناء توحيد نقطة الوصول للكاش.
function _checkAIRateLimit(username) {
  try {
    var key = _getAIRateKey(username);
    var val = CacheEngine.get(CacheEngine.NAMESPACE.AI_AGENT, key);
    var count = val ? parseInt(val, 10) : 0;
    return {
      count: count,
      remaining: Math.max(0, AI_RATE_LIMIT_MAX - count),
      allowed: count < AI_RATE_LIMIT_MAX,
    };
  } catch (e) {
    return { count: 0, remaining: AI_RATE_LIMIT_MAX, allowed: true };
  }
}
function _incrementAIRateLimit(username) {
  try {
    var key = _getAIRateKey(username);
    var val = CacheEngine.get(CacheEngine.NAMESPACE.AI_AGENT, key);
    var count = val ? parseInt(val, 10) : 0;
    CacheEngine.set(
      CacheEngine.NAMESPACE.AI_AGENT,
      key,
      String(count + 1),
      AI_RATE_LIMIT_WINDOW,
    );
    return count + 1;
  } catch (e) {
    return 1;
  }
}
// ── API: حالة Rate Limit للمستخدم ─────────────────────────────────────────
function getAIRateLimitStatus(callerUser, sessionToken) {
  try {
    if (!sessionToken)
      return errResponse("يجب تسجيل الدخول", "SESSION_INVALID");
    var sess = validateSession(sessionToken);
    if (!sess || !sess.valid)
      return errResponse("جلسة غير صالحة", "SESSION_INVALID");
    var status = _checkAIRateLimit(callerUser);
    return { success: true, data: status };
  } catch (e) {
    return errResponse("خطأ في الاستعلام: " + e.message);
  }
}
// ── Audit Logging للمساعد الذكي ───────────────────────────────────────────
function _writeAIAuditLog(username, action, toolName, params, result) {
  try {
    var details = "[AI-AGENT] " + action;
    if (toolName) details += " | أداة: " + toolName;
    if (params) {
      try {
        details += " | مدخلات: " + JSON.stringify(params).substring(0, 200);
      } catch (e) {
        Logger.log("[silent-catch] " + e);
      }
    }
    if (result) {
      var status = result.success
        ? " نجح"
        : " فشل: " + (result.message || "");
      details += " | النتيجة: " + status;
    }
    AuditEngine.log("AI_AGENT:" + (toolName || action || "CHAT"), {
      user: username || "AI-Agent",
      table: "AI_Log",
      record_id: new Date().getTime().toString(),
      details: details});
  } catch (e) {
    console.warn("AI Audit Log فشل:", e.message);
  }
}
// ══════════════════════════════════════════════════════════════════════════
//  تعريف الأدوات المتاحة للمساعد (Tool Definitions)
// ══════════════════════════════════════════════════════════════════════════
var AI_TOOLS = [
  // ── قراءة (Read-Only) ──
  {
    name: "get_stock_report",
    description: "جلب تقرير المخزون الكامل مع الأرصدة لكل صنف ومخزن",
    category: "read",
    permission: "viewTransactions",
    params: ["warehouse_id"],
  },
  {
    name: "get_low_stock_items",
    description: "جلب الأصناف التي رصيدها تحت الحد الأدنى أو صفر",
    category: "read",
    permission: "viewTransactions",
    params: [],
  },
  {
    name: "get_financial_summary",
    description:
      "ملخص مالي: أرصدة الصناديق والبنوك، إجمالي القبض والصرف، المصروفات",
    category: "read",
    permission: "viewAccounting",
    params: [],
  },
  {
    name: "get_sales_analysis",
    description: "تحليل المبيعات: إجمالي الفواتير، أبرز العملاء، المرتجعات",
    category: "read",
    permission: "viewTransactions",
    params: ["date_from", "date_to"],
  },
  {
    name: "get_purchase_analysis",
    description: "تحليل المشتريات: إجمالي الفواتير، أبرز الموردين",
    category: "read",
    permission: "viewTransactions",
    params: ["date_from", "date_to"],
  },
  {
    name: "get_overdue_customers",
    description: "العملاء المتأخرون في السداد (أرصدة دائنة)",
    category: "read",
    permission: "viewCustomers",
    params: [],
  },
  {
    name: "get_hr_summary",
    description:
      "ملخص الموارد البشرية: الموظفون، الحضور، الرواتب، الطلبات المعلقة",
    category: "read",
    permission: "viewHR",
    params: [],
  },
  {
    name: "get_production_status",
    description: "حالة أوامر الإنتاج: المفتوحة والمتأخرة",
    category: "read",
    permission: "viewProduction",
    params: [],
  },
  {
    name: "get_kpi_dashboard",
    description:
      "مؤشرات الأداء الرئيسية: المبيعات، المخزون، التحصيل، الإنتاجية",
    category: "read",
    permission: "viewTransactions",
    params: [],
  },
  {
    name: "get_idle_items",
    description: "اكتشاف الأصناف الراكدة (لا حركة عليها خلال فترة)",
    category: "read",
    permission: "viewTransactions",
    params: ["days"],
  },
  {
    name: "get_unbalanced_entries",
    description: "اكتشاف القيود المحاسبية غير المتوازنة أو الشاذة",
    category: "read",
    permission: "viewAccounting",
    params: [],
  },
  // ── تنفيذ (Write — يستلزم موافقة المستخدم) ──
  {
    name: "create_customer",
    description: "إنشاء عميل جديد في النظام",
    category: "write",
    permission: "addCustomer",
    confirmMsg: "هل تريد إنشاء عميل جديد؟",
    params: ["name", "phone", "address", "credit_limit"],
  },
  {
    name: "create_supplier",
    description: "إنشاء مورد جديد في النظام",
    category: "write",
    permission: "addSupplier",
    confirmMsg: "هل تريد إنشاء مورد جديد؟",
    params: ["name", "phone", "address"],
  },
  {
    name: "create_item",
    description: "إنشاء صنف جديد في كتالوج المخزون",
    category: "write",
    permission: "addItem",
    confirmMsg: "هل تريد إنشاء صنف جديد في المخزون؟",
    params: ["name", "code", "unit", "group_id", "min_quantity"],
  },
  {
    name: "create_transaction_in",
    description: "إنشاء إذن إضافة (وارد) للمخزون",
    category: "write",
    permission: "addTransaction",
    confirmMsg: "هل تريد إنشاء إذن إضافة للمخزون؟",
    params: ["item_id", "quantity", "warehouse_id", "color", "party", "notes"],
  },
  {
    name: "create_transaction_out",
    description: "إنشاء إذن صرف (صادر) من المخزون",
    category: "write",
    permission: "addTransaction",
    confirmMsg: "هل تريد إنشاء إذن صرف من المخزون؟",
    params: ["item_id", "quantity", "warehouse_id", "color", "party", "notes"],
  },
  {
    name: "create_journal_entry",
    description: "إنشاء قيد يومية محاسبي",
    category: "write",
    permission: "addJournalEntry",
    confirmMsg: "هل تريد إنشاء قيد يومية محاسبي؟",
    params: ["date", "description", "lines"],
  },
  {
    name: "create_receipt_voucher",
    description: "إنشاء سند قبض (استلام مبلغ من عميل)",
    category: "write",
    permission: "addReceiptVoucher",
    confirmMsg: "هل تريد إنشاء سند قبض؟",
    params: ["date", "party_id", "amount", "cash_box_id", "notes"],
  },
  {
    name: "create_payment_voucher",
    description: "إنشاء سند صرف (دفع مبلغ لمورد)",
    category: "write",
    permission: "addPaymentVoucher",
    confirmMsg: "هل تريد إنشاء سند صرف؟",
    params: ["date", "party_id", "amount", "cash_box_id", "notes"],
  },
  {
    name: "create_expense",
    description: "إنشاء مصروف جديد",
    category: "write",
    permission: "addExpense",
    confirmMsg: "هل تريد تسجيل مصروف جديد؟",
    params: ["date", "description", "amount", "account_id", "cash_box_id"],
  },
  {
    name: "create_production_order",
    description: "إنشاء أمر إنتاج جديد",
    category: "write",
    permission: "addProductionOrder",
    confirmMsg: "هل تريد إنشاء أمر إنتاج جديد؟",
    params: ["item_id", "quantity", "target_date", "notes"],
  },
];
// ── تنفيذ الأداة على الـ Backend ──────────────────────────────────────────
function _executeAITool(toolName, params, callerUser, sessionToken) {
  switch (toolName) {
    // ══ Read Tools ══
    case "get_stock_report":
      return _aiTool_getStockReport(params, callerUser);
    case "get_low_stock_items":
      return _aiTool_getLowStock(callerUser);
    case "get_financial_summary":
      return _aiTool_getFinancialSummary(callerUser);
    case "get_sales_analysis":
      return _aiTool_getSalesAnalysis(params, callerUser);
    case "get_purchase_analysis":
      return _aiTool_getPurchaseAnalysis(params, callerUser);
    case "get_overdue_customers":
      return _aiTool_getOverdueCustomers(callerUser);
    case "get_hr_summary":
      return _aiTool_getHRSummary(callerUser);
    case "get_production_status":
      return _aiTool_getProductionStatus(callerUser);
    case "get_kpi_dashboard":
      return _aiTool_getKPIDashboard(callerUser);
    case "get_idle_items":
      return _aiTool_getIdleItems(params, callerUser);
    case "get_unbalanced_entries":
      return _aiTool_getUnbalancedEntries(callerUser);
    // ══ Write Tools ══
    case "create_customer":
      return _aiTool_createCustomer(params, callerUser, sessionToken);
    case "create_supplier":
      return _aiTool_createSupplier(params, callerUser, sessionToken);
    case "create_item":
      return _aiTool_createItem(params, callerUser, sessionToken);
    case "create_transaction_in":
      return _aiTool_createTransaction("IN", params, callerUser, sessionToken);
    case "create_transaction_out":
      return _aiTool_createTransaction("OUT", params, callerUser, sessionToken);
    case "create_journal_entry":
      return _aiTool_createJournalEntry(params, callerUser, sessionToken);
    case "create_receipt_voucher":
      return _aiTool_createReceiptVoucher(params, callerUser, sessionToken);
    case "create_payment_voucher":
      return _aiTool_createPaymentVoucher(params, callerUser, sessionToken);
    case "create_expense":
      return _aiTool_createExpense(params, callerUser, sessionToken);
    case "create_production_order":
      return _aiTool_createProductionOrder(params, callerUser, sessionToken);
    default:
      return { success: false, message: "أداة غير معروفة: " + toolName };
  }
}
// ══ Read Tool Implementations ══════════════════════════════════════════════

function _aiTool_getStockReport(params, callerUser) {
  try {
    var data = getStockReport ? getStockReport(callerUser, params) : null;
    if (data && data.success) return { success: true, data: data.data };
    // fallback: build from raw data
    var items = readSheet("Items");
    var stock = readSheet("Stock");
    var opening = readSheet("Opening_Stock");
    var stockMap = {};
    stock.forEach(function (s) {
      var k = s.item_id + "|" + (s.warehouse_id || s.warehouse || "");
      stockMap[k] = (stockMap[k] || 0) + Number(s.quantity || 0);
    });
    opening.forEach(function (o) {
      var k = o.item_id + "|";
      stockMap[k] = (stockMap[k] || 0) + Number(o.quantity || 0);
    });
    var result = items.map(function (it) {
      var total = 0;
      Object.keys(stockMap).forEach(function (k) {
        if (k.indexOf(it.id + "|") === 0) total += stockMap[k];
      });
      // [AUDIT-FIX Inventory §2.3] نفس منطق getStockReport — دمج
      // reorder_point/safety_stock مع min_quantity القديم
      var legacyMin = Number(it.min_quantity || 0);
      var reorderPoint = Number(it.reorder_point || 0);
      var safetyStock = Number(it.safety_stock || 0);
      return {
        id: it.id,
        name: it.name,
        code: it.code,
        qty: total,
        unit: it.unit,
        min: Math.max(legacyMin, reorderPoint + safetyStock),
      };
    });
    return { success: true, data: result, count: result.length };
  } catch (e) {
    return { success: false, message: "خطأ في تقرير المخزون: " + e.message };
  }
}
function _aiTool_getLowStock(callerUser) {
  try {
    var report = _aiTool_getStockReport({}, callerUser);
    if (!report.success) return report;
    // [FIX-AUDIT #3] sf-min_stock_alert_pct كان شريطًا تجميليًا فقط (يحرّك
    // progress bar داخل شاشة الإعدادات ولا يؤثر على منطق التنبيه الفعلي).
    // الآن نستخدمه كنسبة توسيع (buffer %) فوق حد الـ min الخاص بكل صنف:
    // العتبة الفعلية = min * (1 + pct/100)، بحيث الإدارة تقدر فعلاً تتحكم
    // في "حساسية" تنبيه نقص المخزون عالميًا زي ما الاسم بيوحي. لو الإعداد
    // = 0 (الافتراضي)، السلوك يبقى تمامًا كما كان: qty <= min.
    var alertPct = 0;
    try {
      var companySettings = _getCompanySettingsRaw();
      alertPct = Number(companySettings.min_stock_alert_pct || 0);
      if (!isFinite(alertPct) || alertPct < 0) alertPct = 0;
    } catch (eSettings) {
      alertPct = 0;
    }
    var alertFactor = 1 + alertPct / 100;
    var low = report.data.filter(function (it) {
      return it.min > 0 && it.qty <= it.min * alertFactor;
    });
    var zero = report.data.filter(function (it) {
      return it.qty === 0;
    });
    return {
      success: true,
      low_stock: low,
      zero_stock: zero,
      total_alerts: low.length,
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_getFinancialSummary(callerUser) {
  try {
    var cashBoxes = readSheet("Cash_Boxes");
    var banks = readSheet("Bank_Accounts");
    var receipts = readSheet("Receipt_Vouchers");
    var payments = readSheet("Payment_Vouchers");
    var expenses = readSheet("Expenses");
    var transferVouchers = readSheet("Transfer_Vouchers");
    var totalCash = cashBoxes.reduce(function (s, c) {
      return s + Number(c.balance || c.opening_balance || 0);
    }, 0);
    var totalBank = banks.reduce(function (s, b) {
      return s + Number(b.balance || b.opening_balance || 0);
    }, 0);
    var totalReceipts = receipts
      .filter(function (r) {
        return r.status !== "ملغي";
      })
      .reduce(function (s, r) {
        return s + Number(r.amount || 0);
      }, 0);
    var totalPayments = payments
      .filter(function (p) {
        return p.status !== "ملغي";
      })
      .reduce(function (s, p) {
        return s + Number(p.amount || 0);
      }, 0);
    var totalExpenses = expenses
      .filter(function (e) {
        return e.status !== "ملغي";
      })
      .reduce(function (s, e) {
        return s + Number(e.amount || 0);
      }, 0);
    return {
      success: true,
      data: {
        total_cash: totalCash,
        total_bank: totalBank,
        total_liquid: totalCash + totalBank,
        total_receipts: totalReceipts,
        total_payments: totalPayments,
        total_expenses: totalExpenses,
        net_flow: totalReceipts - totalPayments - totalExpenses,
        cash_boxes: cashBoxes.map(function (c) {
          return {
            name: c.name,
            balance: Number(c.balance || c.opening_balance || 0),
          };
        }),
        bank_accounts: banks.map(function (b) {
          return {
            name: b.name,
            balance: Number(b.balance || b.opening_balance || 0),
          };
        }),
      },
    };
  } catch (e) {
    return { success: false, message: "خطأ في الملخص المالي: " + e.message };
  }
}
function _aiTool_getSalesAnalysis(params, callerUser) {
  try {
    var customers = readSheet("Parties").filter(function (p) {
      return p.type === "customer";
    });
    var transactions = readSheet("Transactions");
    var dateFrom =
      params && params.date_from ? new Date(params.date_from) : null;
    var dateTo = params && params.date_to ? new Date(params.date_to) : null;
    var sales = transactions.filter(function (t) {
      if (t.type !== "OUT" && t.type !== "SALE") return false;
      if (dateFrom && new Date(t.date) < dateFrom) return false;
      if (dateTo && new Date(t.date) > dateTo) return false;
      return true;
    });
    var customerMap = {};
    sales.forEach(function (t) {
      var party = t.party || "غير محدد";
      customerMap[party] = (customerMap[party] || 0) + Number(t.quantity || 0);
    });
    var topCustomers = Object.keys(customerMap)
      .sort(function (a, b) {
        return customerMap[b] - customerMap[a];
      })
      .slice(0, 10)
      .map(function (k) {
        return { name: k, qty: customerMap[k] };
      });
    return {
      success: true,
      data: {
        total_transactions: sales.length,
        total_qty: sales.reduce(function (s, t) {
          return s + Number(t.quantity || 0);
        }, 0),
        customers_count: customers.length,
        top_customers: topCustomers,
      },
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_getPurchaseAnalysis(params, callerUser) {
  try {
    var suppliers = readSheet("Parties").filter(function (p) {
      return p.type === "supplier";
    });
    var transactions = readSheet("Transactions");
    var purchases = transactions.filter(function (t) {
      return t.type === "IN" || t.type === "PURCHASE";
    });
    var supplierMap = {};
    purchases.forEach(function (t) {
      var party = t.party || "غير محدد";
      supplierMap[party] = (supplierMap[party] || 0) + Number(t.quantity || 0);
    });
    var topSuppliers = Object.keys(supplierMap)
      .sort(function (a, b) {
        return supplierMap[b] - supplierMap[a];
      })
      .slice(0, 10)
      .map(function (k) {
        return { name: k, qty: supplierMap[k] };
      });
    return {
      success: true,
      data: {
        total_transactions: purchases.length,
        total_qty: purchases.reduce(function (s, t) {
          return s + Number(t.quantity || 0);
        }, 0),
        suppliers_count: suppliers.length,
        top_suppliers: topSuppliers,
      },
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_getOverdueCustomers(callerUser) {
  try {
    var parties = readSheet("Parties").filter(function (p) {
      return p.type === "customer" && Number(p.balance || 0) > 0;
    });
    return {
      success: true,
      data: parties
        .map(function (c) {
          return {
            name: c.name,
            balance: Number(c.balance || 0),
            phone: c.phone || "",
          };
        })
        .sort(function (a, b) {
          return b.balance - a.balance;
        }),
      count: parties.length,
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_getHRSummary(callerUser) {
  try {
    var employees = readSheet("Employees");
    var attendance = readSheet("Attendance");
    var leaveReqs = readSheet("Leave_Requests");
    var loanReqs = readSheet("Loan_Requests");
    var today = new Date().toISOString().slice(0, 10);
    var todayAttendance = attendance.filter(function (a) {
      return (a.date || "").slice(0, 10) === today;
    });
    var pendingLeaves = leaveReqs.filter(function (l) {
      return l.status === "معلق" || l.status === "pending";
    });
    var pendingLoans = loanReqs.filter(function (l) {
      return l.status === "معلق" || l.status === "pending";
    });
    var active = employees.filter(function (e) {
      return e.status === "نشط" || !e.status;
    });
    return {
      success: true,
      data: {
        total_employees: employees.length,
        active_employees: active.length,
        today_attendance: todayAttendance.length,
        absent_today: active.length - todayAttendance.length,
        pending_leaves: pendingLeaves.length,
        pending_loans: pendingLoans.length,
        leave_requests: pendingLeaves.slice(0, 5).map(function (l) {
          return {
            employee: l.employee_name || l.employee_id,
            type: l.leave_type,
            days: l.days_count || 1,
          };
        }),
      },
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_getProductionStatus(callerUser) {
  try {
    var orders = readSheet("Production_Orders");
    var today = new Date();
    var open = orders.filter(function (o) {
      return o.status !== "منتهي" && o.status !== "ملغي";
    });
    var overdue = open.filter(function (o) {
      if (!o.target_date) return false;
      return new Date(o.target_date) < today;
    });
    return {
      success: true,
      data: {
        total: orders.length,
        open: open.length,
        overdue: overdue.length,
        open_orders: open.slice(0, 10).map(function (o) {
          return {
            id: o.order_number || o.id,
            item: o.item_name || o.item_id,
            qty: o.quantity,
            status: o.status,
            target: o.target_date,
          };
        }),
      },
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_getKPIDashboard(callerUser) {
  try {
    var financial = _aiTool_getFinancialSummary(callerUser);
    var stockData = _aiTool_getLowStock(callerUser);
    var production = _aiTool_getProductionStatus(callerUser);
    var overdue = _aiTool_getOverdueCustomers(callerUser);
    return {
      success: true,
      data: {
        financial: financial.success ? financial.data : {},
        stock_alerts: stockData.success ? stockData.total_alerts : 0,
        production_open: production.success ? production.data.open : 0,
        production_overdue: production.success ? production.data.overdue : 0,
        overdue_customers: overdue.success ? overdue.count : 0,
        overdue_balance: overdue.success
          ? overdue.data.reduce(function (s, c) {
              return s + c.balance;
            }, 0)
          : 0,
      },
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_getIdleItems(params, callerUser) {
  try {
    var days = params && params.days ? parseInt(params.days) : 90;
    var transactions = readSheet("Transactions");
    var items = readSheet("Items");
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    var activeItems = {};
    transactions.forEach(function (t) {
      if (t.item_id && new Date(t.date) > cutoff) activeItems[t.item_id] = true;
    });
    var idle = items.filter(function (it) {
      return !activeItems[String(it.id)];
    });
    return {
      success: true,
      data: idle.map(function (it) {
        return { id: it.id, name: it.name, code: it.code };
      }),
      count: idle.length,
      days: days,
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_getUnbalancedEntries(callerUser) {
  try {
    var entries = readSheet("Journal_Entries");
    var lines = readSheet("Journal_Entry_Lines");
    var linesMap = {};
    lines.forEach(function (l) {
      var id = l.entry_id || l.journal_entry_id;
      if (!linesMap[id]) linesMap[id] = { debit: 0, credit: 0 };
      linesMap[id].debit += Number(l.debit || 0);
      linesMap[id].credit += Number(l.credit || 0);
    });
    var unbalanced = entries.filter(function (e) {
      var totals = linesMap[e.id];
      if (!totals) return true;
      return Math.abs(totals.debit - totals.credit) > 0.01;
    });
    return {
      success: true,
      data: unbalanced.slice(0, 20).map(function (e) {
        var totals = linesMap[e.id] || { debit: 0, credit: 0 };
        return {
          id: e.id,
          date: e.date,
          description: e.description,
          debit: totals.debit,
          credit: totals.credit,
          diff: Math.abs(totals.debit - totals.credit),
        };
      }),
      count: unbalanced.length,
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
// ══ Write Tool Implementations ══════════════════════════════════════════════

function _aiTool_createCustomer(params, callerUser, sessionToken) {
  try {
    if (!params || !params.name)
      return { success: false, message: "اسم العميل مطلوب" };
    var result = addCustomer(callerUser, {
      name: params.name,
      phone: params.phone || "",
      address: params.address || "",
      credit_limit: Number(params.credit_limit || 0),
      type: "customer",
      user: callerUser,
      sessionToken: sessionToken,
    });
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_createSupplier(params, callerUser, sessionToken) {
  try {
    if (!params || !params.name)
      return { success: false, message: "اسم المورد مطلوب" };
    var result = addSupplier(callerUser, {
      name: params.name,
      phone: params.phone || "",
      address: params.address || "",
      type: "supplier",
      user: callerUser,
      sessionToken: sessionToken,
    });
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_createItem(params, callerUser, sessionToken) {
  try {
    if (!params || !params.name)
      return { success: false, message: "اسم الصنف مطلوب" };
    var result = addItem({
      name: params.name,
      code: params.code || "",
      unit: params.unit || "وحدة",
      group: params.group_id || "",
      min_quantity: Number(params.min_quantity || 0),
      user: callerUser,
      sessionToken: sessionToken,
    });
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_createTransaction(type, params, callerUser, sessionToken) {
  try {
    if (!params || !params.item_id)
      return { success: false, message: "الصنف مطلوب" };
    if (!params.quantity || Number(params.quantity) <= 0)
      return { success: false, message: "الكمية يجب أن تكون أكبر من صفر" };
    var result = addTransaction({
      type: type,
      item_id: params.item_id,
      quantity: Number(params.quantity),
      warehouse_id: params.warehouse_id || "",
      warehouse: params.warehouse_id || "",
      color: params.color || "",
      party: params.party || "",
      notes: "[AI-Agent] " + (params.notes || "تمت بواسطة المساعد الذكي"),
      user: callerUser,
      sessionToken: sessionToken,
    });
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_createJournalEntry(params, callerUser, sessionToken) {
  try {
    if (
      !params ||
      !params.lines ||
      !Array.isArray(params.lines) ||
      params.lines.length < 2
    ) {
      return { success: false, message: "القيد يحتاج على الأقل سطرين" };
    }
    var result = addJournalEntry({
      callerUser: callerUser,
      sessionToken: sessionToken,
      date: params.date || new Date().toISOString().slice(0, 10),
      description: params.description || "قيد من المساعد الذكي",
      lines: params.lines,
      source_type: "AI_AGENT",
    });
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_createReceiptVoucher(params, callerUser, sessionToken) {
  try {
    if (!params || !params.amount || Number(params.amount) <= 0)
      return { success: false, message: "المبلغ مطلوب" };
    var result = addReceiptVoucher({
      callerUser: callerUser,
      sessionToken: sessionToken,
      date: params.date || new Date().toISOString().slice(0, 10),
      party_id: params.party_id || "",
      amount: Number(params.amount),
      cash_box_id: params.cash_box_id || "",
      notes: "[AI] " + (params.notes || ""),
    });
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_createPaymentVoucher(params, callerUser, sessionToken) {
  try {
    if (!params || !params.amount || Number(params.amount) <= 0)
      return { success: false, message: "المبلغ مطلوب" };
    var result = addPaymentVoucher({
      callerUser: callerUser,
      sessionToken: sessionToken,
      date: params.date || new Date().toISOString().slice(0, 10),
      party_id: params.party_id || "",
      amount: Number(params.amount),
      cash_box_id: params.cash_box_id || "",
      notes: "[AI] " + (params.notes || ""),
    });
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_createExpense(params, callerUser, sessionToken) {
  try {
    if (!params || !params.amount)
      return { success: false, message: "المبلغ مطلوب" };
    var result = addExpense({
      callerUser: callerUser,
      sessionToken: sessionToken,
      date: params.date || new Date().toISOString().slice(0, 10),
      description: params.description || "مصروف من المساعد الذكي",
      amount: Number(params.amount),
      account_id: params.account_id || "",
      cash_box_id: params.cash_box_id || "",
    });
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
function _aiTool_createProductionOrder(params, callerUser, sessionToken) {
  try {
    if (!params || !params.item_id)
      return { success: false, message: "الصنف مطلوب" };
    if (!params.quantity || Number(params.quantity) <= 0)
      return { success: false, message: "الكمية مطلوبة" };
    var result = addProductionOrder({
      item_id: params.item_id,
      quantity: Number(params.quantity),
      target_date: params.target_date || "",
      notes: "[AI] " + (params.notes || "أمر من المساعد الذكي"),
      user: callerUser,
      sessionToken: sessionToken,
    });
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
// ══════════════════════════════════════════════════════════════════════════
//  proxyAIAgent — النقطة المركزية للمساعد الذكي v6
//  يدعم: Tool Calling + Rate Limiting + Audit Logging + Permission Check
// ══════════════════════════════════════════════════════════════════════════
function proxyAIAgent(callerUser, sessionToken, payload) {
  var startTime = new Date().getTime();
  try {
    // 1. التحقق من الجلسة
    if (!sessionToken) return errResponse("يجب تسجيل الدخول لاستخدام المساعد");
    var sess = validateSession(sessionToken);
    if (!sess || !sess.valid)
      return errResponse("جلستك انتهت — يرجى تسجيل الدخول مجدداً");
    if (
      String(sess.username || "").toLowerCase() !==
      String(callerUser || "").toLowerCase()
    ) {
      return errResponse("خطأ في التحقق من الهوية");
    }

    // 2. Rate Limiting
    var rateStatus = _checkAIRateLimit(callerUser);
    if (!rateStatus.allowed) {
      _writeAIAuditLog(callerUser, "RATE_LIMITED", null, null, {
        success: false,
      });
      return {
        success: false,
        rate_limited: true,
        message:
          "تجاوزت الحد اليومي للمساعد (" +
          AI_RATE_LIMIT_MAX +
          " طلب/يوم). المتبقي يُجدَّد غداً.",
      };
    }

    // 3. جلب المفتاح
    var apiKey =
      PropertiesService.getScriptProperties().getProperty("GROQ_API_KEY");
    if (!apiKey)
      return errResponse("المساعد الذكي غير مفعّل — تواصل مع المدير");

    // 4. تحديد نوع الطلب
    var mode = (payload && payload.mode) || "chat";

    // ── Mode: execute_tool (تنفيذ أداة مؤكدة) ──
    if (mode === "execute_tool") {
      var toolName = payload.tool_name;
      var toolParams = payload.tool_params || {};
      if (!toolName) return errResponse("اسم الأداة مطلوب");

      // التحقق من وجود الأداة
      var toolDef = AI_TOOLS.find(function (t) {
        return t.name === toolName;
      });
      if (!toolDef)
        return { success: false, message: "أداة غير معروفة: " + toolName };

      // التحقق من الصلاحية
      var permErr = _checkPermission(
        callerUser,
        toolDef.permission,
        sessionToken,
      );
      if (permErr) {
        _writeAIAuditLog(callerUser, "TOOL_DENIED", toolName, toolParams, {
          success: false,
          message: "لا صلاحية",
        });
        return {
          success: false,
          message: " ليس لديك صلاحية تنفيذ هذه الأداة: " + toolDef.permission,
        };
      }

      // تنفيذ الأداة
      var toolResult = _executeAITool(
        toolName,
        toolParams,
        callerUser,
        sessionToken,
      );
      _writeAIAuditLog(
        callerUser,
        "TOOL_EXECUTED",
        toolName,
        toolParams,
        toolResult,
      );
      _incrementAIRateLimit(callerUser);

      var elapsed = new Date().getTime() - startTime;
      return {
        success: true,
        mode: "tool_result",
        tool_name: toolName,
        result: toolResult,
        elapsed_ms: elapsed,
      };
    }

    // ── Mode: chat (محادثة عادية مع LLM) ──
    var messages = payload && payload.messages ? payload.messages : [];
    if (!Array.isArray(messages) || messages.length === 0)
      return errResponse("الرسائل مطلوبة");

    // تنظيف الرسائل
    var cleanMessages = messages
      .map(function (m) {
        return {
          role: String(m.role || "user").replace(/[^a-z]/g, ""),
          content: String(m.content || "").substring(0, 6000),
        };
      })
      .filter(function (m) {
        return (
          m.role === "user" || m.role === "assistant" || m.role === "system"
        );
      })
      .slice(-25);

    // استدعاء Groq
    var groqPayload = {
      model: "llama-3.3-70b-versatile",
      max_tokens: 2000,
      temperature: 0.4,
      messages: cleanMessages,
    };

    var options = {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + apiKey },
      payload: JSON.stringify(groqPayload),
      muteHttpExceptions: true,
    };

    var response = UrlFetchApp.fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      options,
    );
    var result = JSON.parse(response.getContentText());

    if (!result.choices || !result.choices[0] || !result.choices[0].message) {
      var errMsg = result.error ? result.error.message : "لم يرد المساعد";
      _writeAIAuditLog(
        callerUser,
        "CHAT_ERROR",
        null,
        { msg_count: cleanMessages.length },
        { success: false, message: errMsg },
      );
      return errResponse(errMsg);
    }

    var reply = result.choices[0].message.content;
    _incrementAIRateLimit(callerUser);
    _writeAIAuditLog(
      callerUser,
      "CHAT",
      null,
      { msg_count: cleanMessages.length },
      { success: true },
    );

    var elapsed = new Date().getTime() - startTime;
    return {
      success: true,
      mode: "chat",
      reply: reply,
      usage: result.usage || {},
      elapsed_ms: elapsed,
      rate_remaining: rateStatus.remaining - 1,
    };
  } catch (e) {
    console.error("proxyAIAgent error:", e.message);
    _writeAIAuditLog(callerUser, "ERROR", null, null, {
      success: false,
      message: e.message,
    });
    return errResponse("خطأ في المساعد الذكي: " + e.message);
  }
}
