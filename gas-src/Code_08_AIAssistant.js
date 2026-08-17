// ════════════════════════════════════════════════════════════════
// Code_AIAssistant.gs — [REFACTOR-P3] نُقل من Code_Core.gs (نقل نصي بحت، صفر
// تغيير في المنطق أو الترتيب الداخلي). Apps Script يعامل كل ملفات
// .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء من
// أي ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// المصدر الأصلي: Code_Core.gs — راجع تقرير Architecture Audit
// بتاريخ 2026-07-03، المرحلة 3.
// ════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// §AI  المساعد الذكي المحلي — askWarehouseAI  (v3 — بدون API)
//
// يعمل 100% محلياً بدون أي API خارجي
// يفهم الأسئلة الطبيعية بالعربية ويجيب من بيانات الشيت مباشرة
// ─────────────────────────────────────────────────────────────

function askWarehouseAI(userMessage, conversationHistory) {
  try {
    var msg = String(userMessage || "")
      .trim()
      .toLowerCase();
    var data = _loadAllData();
    var reply = _processQuery(msg, userMessage, data);
    return okResponse("", { reply: reply });
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function askWarehouseAIAnalysis(reportType) {
  try {
    var data = _loadAllData();
    var reply = "";

    switch (reportType) {
      case "stock_alert":
        reply = _reportStockAlerts(data);
        break;
      case "top_items":
        reply = _reportTopItems(data);
        break;
      case "warehouse_compare":
        reply = _reportWarehouseCompare(data);
        break;
      case "movement_analysis":
        reply = _reportMovementAnalysis(data);
        break;
      case "production_summary":
        reply = _reportProductionSummary(data);
        break;
      case "full_report":
      default:
        reply = _reportFull(data);
        break;
    }

    return okResponse("", { reply: reply, reportType: reportType });
  } catch (e) {
    return errResponse("خطأ في التحليل: " + e.message);
  }
}

// ── تحميل كل البيانات مرة واحدة (لمساعد الـ AI) ──────────────
// مربوطة بكاش مستقل (AI_DATA_CACHE_KEY) لتقليل قراءات Sheets المتكررة
//    عند استخدام أزرار التحليل السريع (askWarehouseAIAnalysis) والمحادثة (askWarehouseAI)
function _loadAllData() {
  // جرّب الكاش أولاً
  var cached = _loadServerCache(AI_DATA_CACHE_KEY);
  if (cached) {
    cached._from_cache = true;
    return cached;
  }

  // كاش فارغ → اقرأ من Sheets كالمعتاد
  var items = readSheet("Items", null, { parseJson: ["colors_json"] });
  var stock = readSheet("Stock");
  var groups = readSheet("Groups");
  var warehouses = readSheet("Warehouses", WAREHOUSE_HEADERS);
  var txAll = readSheet("Transactions");
  var opening = readSheet("OpeningStock", OPENING_STOCK_HEADERS);
  var prodOrders = [];
  try {
    prodOrders = readSheet("ProductionOrders");
  } catch (e) {
    console.error("_loadAllData - خطأ:", e.message || e);
  }

  // خرائط المساعدة
  var groupNames = {};
  groups.forEach(function (g) {
    groupNames[String(g.id)] = g.name;
  });

  // رصيد إجمالي لكل صنف
  var stockMap = {};
  stock.forEach(function (s) {
    var id = String(s.item_id || "").trim();
    stockMap[id] = (stockMap[id] || 0) + Number(s.quantity || 0);
  });
  opening.forEach(function (o) {
    var id = String(o.item_id || "").trim();
    stockMap[id] = (stockMap[id] || 0) + Number(o.quantity || 0);
  });

  // رصيد لكل صنف × مخزن
  var stockByWarehouse = {};
  stock.forEach(function (s) {
    var id = String(s.item_id || "").trim();
    var wh = String(s.warehouse || "").trim();
    if (!stockByWarehouse[wh]) stockByWarehouse[wh] = {};
    stockByWarehouse[wh][id] =
      (stockByWarehouse[wh][id] || 0) + Number(s.quantity || 0);
  });

  var result = {
    items: items,
    stock: stock,
    groups: groups,
    warehouses: warehouses,
    txAll: txAll,
    opening: opening,
    prodOrders: prodOrders,
    groupNames: groupNames,
    stockMap: stockMap,
    stockByWarehouse: stockByWarehouse,
  };

  // احفظ في الكاش قبل الإرجاع
  _saveServerCache(result, AI_DATA_CACHE_KEY, AI_DATA_CACHE_TTL);
  return result;
}

// ── محرك فهم الأسئلة الطبيعية ────────────────────────────────
function _processQuery(msgLow, msgOrig, d) {
  var now = Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd HH:mm");

  // ── تحية ─────────────────────────────────────────────────
  if (/^(أهلا|مرحبا|هاي|هلو|السلام|صباح|مساء)/.test(msgLow))
    return "أهلاً! أنا مساعد MOO.ERP \nاسألني عن أي صنف أو رصيد أو تنبيهات أو تقارير النظام.";

  // ── ما هي الأصناف تحت الحد الأدنى / نقص ────────────────
  if (/نقص|تحت الحد|أدنى|نفذ|خلص|قليل/.test(msgLow))
    return _reportStockAlerts(d);

  // ── أعلى رصيد / أكثر ────────────────────────────────────
  if (
    /(أعلى|أكثر|أكبر).*(رصيد|كمية|صنف)|(رصيد|كمية).*(أعلى|أكثر|أكبر)/.test(
      msgLow,
    )
  )
    return _topByStock(d, 10, "desc");

  // ── أدنى رصيد / أقل ─────────────────────────────────────
  if (
    /(أدنى|أقل|أصغر).*(رصيد|كمية|صنف)|(رصيد|كمية).*(أدنى|أقل|أصغر)/.test(msgLow)
  )
    return _topByStock(d, 10, "asc");

  // ── مقارنة المخازن ───────────────────────────────────────
  if (/مقارن|مخازن|compare|كل المخازن/.test(msgLow))
    return _reportWarehouseCompare(d);

  // ── أوامر الإنتاج ────────────────────────────────────────
  if (/إنتاج|أوامر|production/.test(msgLow)) return _reportProductionSummary(d);

  // ── آخر الحركات ─────────────────────────────────────────
  if (/حركات|حركة|معاملات|transactions|آخر/.test(msgLow))
    return _reportMovementAnalysis(d);

  // ── تقرير شامل ──────────────────────────────────────────
  if (/تقرير|ملخص|شامل|عام|report/.test(msgLow)) return _reportFull(d);

  // ── البحث عن صنف بالاسم أو الكود ───────────────────────
  var itemResult = _searchItem(msgOrig, d);
  if (itemResult) return itemResult;

  // ── سؤال عن عدد الأصناف ─────────────────────────────────
  if (/كم|عدد/.test(msgLow) && /صنف|منتج/.test(msgLow))
    return "إجمالي الأصناف في المخزون: **" + d.items.length + " صنف**";

  // ── سؤال عن عدد المخازن ─────────────────────────────────
  if (/كم|عدد/.test(msgLow) && /مخزن/.test(msgLow))
    return (
      "عدد المخازن: **" +
      d.warehouses.length +
      " مخازن**\n" +
      d.warehouses
        .map(function (w) {
          return "• " + w.name;
        })
        .join("\n")
    );

  // ── سؤال عن التاريخ / الوقت ─────────────────────────────
  if (/تاريخ|وقت|الآن|كم الساعة/.test(msgLow))
    return "التاريخ والوقت الحالي: **" + now + "**";

  // ── ما تعرفه (fallback) ──────────────────────────────────
  return (
    "لم أفهم سؤالك تماماً \n\nيمكنك سؤالي عن:\n" +
    "• **رصيد صنف** — مثال: «كم رصيد القماش الأحمر؟»\n" +
    "• **تنبيهات النقص** — مثال: «ما الأصناف التي تحتاج شراء؟»\n" +
    "• **أعلى/أدنى رصيد** — مثال: «ما الصنف الأعلى رصيداً؟»\n" +
    "• **مقارنة المخازن** — مثال: «قارن بين المخازن»\n" +
    "• **أوامر الإنتاج** — مثال: «ما أوامر الإنتاج المفتوحة؟»\n" +
    "• **تقرير شامل** — مثال: «اعمل تقرير شامل»"
  );
}

// ── البحث عن صنف بالاسم ─────────────────────────────────────
function _searchItem(msg, d) {
  var msgNorm = msg.trim().replace(/[?؟]/g, "");
  var found = null;
  var bestScore = 0;

  d.items.forEach(function (it) {
    var score = 0;
    var name = (it.name || "").toLowerCase();
    var code = (it.code || "").toLowerCase();
    var msgL = msgNorm.toLowerCase();

    if (name === msgL || code === msgL) score = 100;
    else if (msgL.indexOf(name) !== -1 || name.indexOf(msgL) !== -1) score = 80;
    else if (code && msgL.indexOf(code) !== -1) score = 70;
    else {
      // مطابقة جزئية كلمة كلمة
      var words = name.split(/\s+/);
      words.forEach(function (w) {
        if (w.length > 2 && msgL.indexOf(w) !== -1) score += 30;
      });
    }

    if (score > bestScore) {
      bestScore = score;
      found = it;
    }
  });

  if (!found || bestScore < 30) return null;

  var qty = d.stockMap[String(found.id)] || 0;
  var grp = d.groupNames[String(found.group)] || found.group || "—";
  var colors = (found.colors_json || [])
    .map(function (c) {
      return c.name || c;
    })
    .join("، ");
  var min = Number(found.min_qty || 0);
  var status = min > 0 && qty <= min ? " تحت الحد الأدنى" : " رصيد كافٍ";

  var lines = [
    "**" + found.name + "**",
    "الكود: " + (found.code || found.id),
    "المجموعة: " + grp,
    "الرصيد الحالي: **" + qty + " " + (found.unit || "") + "**",
    "الحالة: " + status,
  ];
  if (min > 0)
    lines.push(
      "الحد الأدنى: " + min + (qty < min ? " (نقص: " + (min - qty) + ")" : ""),
    );
  if (colors) lines.push("الألوان المتاحة: " + colors);
  if (Number(found.selling_price) > 0)
    lines.push("سعر البيع: " + found.selling_price);

  // توزيع على المخازن
  var whLines = [];
  d.warehouses.forEach(function (w) {
    var whStock = d.stockByWarehouse[w.name] || {};
    var q = whStock[String(found.id)] || 0;
    if (q > 0)
      whLines.push("  • " + w.name + ": " + q + " " + (found.unit || ""));
  });
  if (whLines.length) {
    lines.push("التوزيع على المخازن:");
    lines = lines.concat(whLines);
  }

  return lines.join("\n");
}

// ── تقرير تنبيهات النقص ──────────────────────────────────────
function _reportStockAlerts(d) {
  var alerts = [];
  if (!d || !d.items) return alerts;
  d.items.forEach(function (it) {
    var qty = d.stockMap[String(it.id)] || 0;
    var min = Number(it.min_qty || 0);
    if (min > 0 && qty <= min) {
      alerts.push({
        name: it.name,
        code: it.code || it.id,
        qty: qty,
        min: min,
        diff: min - qty,
      });
    }
  });

  if (!alerts.length)
    return " لا توجد أصناف تحت الحد الأدنى حالياً. المخزون بخير!";

  alerts.sort(function (a, b) {
    return b.diff - a.diff;
  });

  var lines = [" **تنبيهات نقص المخزون** — " + alerts.length + " صنف\n"];
  alerts.forEach(function (a, i) {
    lines.push(i + 1 + ". **" + a.name + "** [" + a.code + "]");
    lines.push(
      "   الرصيد: " +
        a.qty +
        " | الحد الأدنى: " +
        a.min +
        " | النقص: " +
        a.diff,
    );
  });
  lines.push("\n**الإجمالي:** " + alerts.length + " صنف يحتاج إعادة توريد");
  return lines.join("\n");
}

// ── أعلى / أدنى الأصناف رصيداً ──────────────────────────────
function _topByStock(d, n, order) {
  var sorted = d.items.slice().sort(function (a, b) {
    var qa = d.stockMap[String(a.id)] || 0;
    var qb = d.stockMap[String(b.id)] || 0;
    return order === "desc" ? qb - qa : qa - qb;
  });

  var label = order === "desc" ? "أعلى" : "أدنى";
  var lines = [" **" + label + " " + n + " أصناف رصيداً:**\n"];
  sorted.slice(0, n).forEach(function (it, i) {
    var qty = d.stockMap[String(it.id)] || 0;
    lines.push(
      i + 1 + ". **" + it.name + "** — " + qty + " " + (it.unit || ""),
    );
  });
  return lines.join("\n");
}

// ── تقرير أعلى الأصناف رصيداً (top_items) ─────────────────────
// [BUG-FIX] كانت تُستدعى من askWarehouseAIAnalysis (case "top_items")
// دون أي تعريف لها إطلاقاً (ReferenceError عند اختيار هذا التقرير من
// الواجهة). أُعيد استخدام _topByStock الموجودة بالفعل لنفس الغرض.
function _reportTopItems(d) {
  return _topByStock(d, 10, "desc");
}

// ── تقرير مقارنة المخازن ─────────────────────────────────────
function _reportWarehouseCompare(d) {
  var lines = [" **مقارنة المخازن**\n"];
  d.warehouses.forEach(function (w) {
    var whStock = d.stockByWarehouse[w.name] || {};
    var totalQty = Object.keys(whStock).reduce(function (acc, k) {
      return acc + (whStock[k] || 0);
    }, 0);
    var itemCount = Object.keys(whStock).filter(function (k) {
      return whStock[k] > 0;
    }).length;

    // أعلى 3 أصناف في هذا المخزن
    var topItems = Object.keys(whStock)
      .filter(function (id) {
        return whStock[id] > 0;
      })
      .sort(function (a, b) {
        return whStock[b] - whStock[a];
      })
      .slice(0, 3)
      .map(function (id) {
        var it = d.items.filter(function (x) {
          return String(x.id) === id;
        })[0];
        return (it ? it.name : id) + " (" + whStock[id] + ")";
      });

    lines.push("**" + w.name + "** (" + (w.type || "—") + ")");
    lines.push("  • عدد الأصناف: " + itemCount);
    lines.push("  • إجمالي الكميات: " + totalQty);
    if (topItems.length) lines.push("  • أبرز الأصناف: " + topItems.join("، "));
    if (w.location) lines.push("  • الموقع: " + w.location);
    lines.push("");
  });
  return lines.join("\n");
}

// ── تقرير أوامر الإنتاج ──────────────────────────────────────
function _reportProductionSummary(d) {
  if (!d.prodOrders.length) return "لا توجد أوامر إنتاج مسجّلة حالياً.";

  var open = d.prodOrders.filter(function (p) {
    return p.status !== "مكتمل" && p.status !== "ملغي";
  });
  var done = d.prodOrders.filter(function (p) {
    return p.status === "مكتمل";
  });
  var cancel = d.prodOrders.filter(function (p) {
    return p.status === "ملغي";
  });

  var lines = [
    " **ملخص أوامر الإنتاج**\n",
    "الإجمالي: " + d.prodOrders.length + " أمر",
    "• مفتوح: " + open.length,
    "• مكتمل: " + done.length,
    "• ملغي: " + cancel.length,
    "",
  ];

  if (open.length) {
    lines.push("**الأوامر المفتوحة:**");
    open.slice(0, 10).forEach(function (p) {
      var it = d.items.filter(function (x) {
        return String(x.id) === String(p.product_id);
      })[0];
      var name = it ? it.name : p.product_id || "—";
      var dateStr = "";
      try {
        dateStr = Utilities.formatDate(new Date(p.date), "GMT+2", "yyyy-MM-dd");
      } catch (e) {
        console.error("_reportProductionSummary - خطأ:", e.message || e);
      }
      lines.push(
        "  • [" +
          p.id +
          "] " +
          name +
          " | كمية: " +
          (p.quantity || 0) +
          " | " +
          (p.status || "—") +
          (dateStr ? " | " + dateStr : ""),
      );
    });
  }
  return lines.join("\n");
}

// ── تقرير تحليل الحركات ──────────────────────────────────────
function _reportMovementAnalysis(d) {
  var recent = d.txAll.slice(-50);
  if (!recent.length) return "لا توجد حركات مسجّلة حتى الآن.";

  // عدّ الحركات لكل صنف
  var itemCount = {};
  var typeCount = {};
  recent.forEach(function (t) {
    var id = String(t.item_id || "");
    itemCount[id] = (itemCount[id] || 0) + 1;
    var type = t.type || "غير محدد";
    typeCount[type] = (typeCount[type] || 0) + 1;
  });

  // أكثر الأصناف حركة
  var topItems = Object.keys(itemCount)
    .sort(function (a, b) {
      return itemCount[b] - itemCount[a];
    })
    .slice(0, 5);

  var lines = [
    " **تحليل آخر " + recent.length + " حركة**\n",
    "**أنواع الحركات:**",
  ];
  Object.keys(typeCount).forEach(function (t) {
    lines.push("  • " + t + ": " + typeCount[t] + " مرة");
  });

  lines.push("\n**أكثر الأصناف حركةً:**");
  topItems.forEach(function (id, i) {
    var it = d.items.filter(function (x) {
      return String(x.id) === id;
    })[0];
    lines.push(
      i + 1 + ". " + (it ? it.name : id) + " — " + itemCount[id] + " حركة",
    );
  });

  lines.push("\n**آخر 10 حركات:**");
  recent
    .slice(-10)
    .reverse()
    .forEach(function (t) {
      var it = d.items.filter(function (x) {
        return String(x.id) === String(t.item_id);
      })[0];
      var dateStr = "";
      try {
        dateStr = Utilities.formatDate(new Date(t.date), "GMT+2", "yyyy-MM-dd");
      } catch (e) {
        console.error("unknown - خطأ:", e.message || e);
      }
      lines.push(
        "  • " +
          dateStr +
          " | " +
          (t.type || "—") +
          " | " +
          (it ? it.name : t.item_id) +
          " | كمية: " +
          (t.quantity || 0),
      );
    });

  return lines.join("\n");
}

// ── التقرير الشامل ────────────────────────────────────────────
function _reportFull(d) {
  var now = Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd HH:mm");
  var alerts = d.items.filter(function (it) {
    var qty = d.stockMap[String(it.id)] || 0;
    var min = Number(it.min_qty || 0);
    return min > 0 && qty <= min;
  });
  var zeroStock = d.items.filter(function (it) {
    return (d.stockMap[String(it.id)] || 0) === 0;
  });
  var totalQty = Object.keys(d.stockMap).reduce(function (acc, k) {
    return acc + d.stockMap[k];
  }, 0);

  var lines = [
    " **التقرير الشامل للمخزون**",
    "التاريخ: " + now,
    "",
    "## ملخص عام",
    "• إجمالي الأصناف: " + d.items.length,
    "• إجمالي الكميات في المخازن: " + totalQty,
    "• عدد المخازن: " + d.warehouses.length,
    "• إجمالي الحركات المسجّلة: " + d.txAll.length,
    "• أصناف تحت الحد الأدنى: " + alerts.length,
    "• أصناف رصيدها صفر: " + zeroStock.length,
    "",
  ];

  lines.push("## تنبيهات النقص");
  if (alerts.length) {
    alerts
      .sort(function (a, b) {
        var da = Number(a.min_qty || 0) - (d.stockMap[String(a.id)] || 0);
        var db = Number(b.min_qty || 0) - (d.stockMap[String(b.id)] || 0);
        return db - da;
      })
      .slice(0, 10)
      .forEach(function (it) {
        var qty = d.stockMap[String(it.id)] || 0;
        lines.push(
          " " + it.name + " — رصيد: " + qty + " / حد أدنى: " + it.min_qty,
        );
      });
    if (alerts.length > 10)
      lines.push("... و" + (alerts.length - 10) + " أصناف أخرى");
  } else {
    lines.push(" لا توجد تنبيهات نقص");
  }

  lines.push("");
  lines.push("## مقارنة المخازن");
  d.warehouses.forEach(function (w) {
    var whStock = d.stockByWarehouse[w.name] || {};
    var total = Object.keys(whStock).reduce(function (acc, k) {
      return acc + (whStock[k] || 0);
    }, 0);
    var count = Object.keys(whStock).filter(function (k) {
      return whStock[k] > 0;
    }).length;
    lines.push("• " + w.name + ": " + count + " صنف | " + total + " وحدة");
  });

  lines.push("");
  lines.push("## توصيات");
  if (alerts.length > 0)
    lines.push(" يوجد " + alerts.length + " صنف يحتاج إعادة توريد فوراً");
  if (zeroStock.length > 0)
    lines.push(" يوجد " + zeroStock.length + " صنف رصيده صفر تماماً");
  if (alerts.length === 0 && zeroStock.length === 0)
    lines.push(" المخزون في حالة جيدة");

  return lines.join("\n");
}

/**
 * _buildDataSnapshot — نسخة v2 المحسّنة
 * يشمل: تفاصيل لكل مخزن + أوامر إنتاج + توزيع ألوان
 */
function _buildDataSnapshot() {
  try {
    var items = readSheet("Items", null, { parseJson: ["colors_json"] });
    var stock = readSheet("Stock");
    var groups = readSheet("Groups");
    var warehouses = readSheet("Warehouses", WAREHOUSE_HEADERS);
    var txAll = readSheet("Transactions");
    var opening = readSheet("OpeningStock", OPENING_STOCK_HEADERS);
    var prodOrders = [];
    try {
      prodOrders = readSheet("ProductionOrders");
    } catch (e) {
      console.error("_buildDataSnapshot - خطأ:", e.message || e);
    }

    // خرائط المساعدة
    var groupNames = {};
    groups.forEach(function (g) {
      groupNames[String(g.id)] = g.name;
    });

    var warehouseNames = {};
    warehouses.forEach(function (w) {
      warehouseNames[String(w.id)] = w.name;
    });

    // ── رصيد لكل صنف (إجمالي) ──────────────────────────────
    var stockMap = {};
    stock.forEach(function (s) {
      var id = String(s.item_id || "").trim();
      stockMap[id] = (stockMap[id] || 0) + Number(s.quantity || 0);
    });
    opening.forEach(function (o) {
      var id = String(o.item_id || "").trim();
      stockMap[id] = (stockMap[id] || 0) + Number(o.quantity || 0);
    });

    // ── رصيد لكل صنف × مخزن ────────────────────────────────
    var stockByWarehouse = {};
    stock.forEach(function (s) {
      var id = String(s.item_id || "").trim();
      var wh = String(s.warehouse || "").trim();
      if (!stockByWarehouse[wh]) stockByWarehouse[wh] = {};
      stockByWarehouse[wh][id] =
        (stockByWarehouse[wh][id] || 0) + Number(s.quantity || 0);
    });

    // ── تنبيهات النقص ───────────────────────────────────────
    var alerts = [];
    items.forEach(function (it) {
      var qty = stockMap[String(it.id)] || 0;
      var min = Number(it.min_qty || 0);
      if (min > 0 && qty <= min) {
        alerts.push(
          it.name +
            " [" +
            (it.code || it.id) +
            "]" +
            " رصيد:" +
            qty +
            " / حد أدنى:" +
            min +
            " (نقص:" +
            Math.max(0, min - qty) +
            ")",
        );
      }
    });

    // ── آخر 50 حركة (محسّن) ─────────────────────────────────
    var recentTx = txAll.slice(-50).map(function (t) {
      var itemName = "";
      var found = items.filter(function (it) {
        return String(it.id) === String(t.item_id);
      });
      if (found.length) itemName = found[0].name;
      try {
        return (
          Utilities.formatDate(new Date(t.date), "GMT+2", "yyyy-MM-dd") +
          " | " +
          (t.type || "—") +
          " | " +
          (itemName || t.item_id || "—") +
          " | كمية:" +
          (t.quantity || 0) +
          (t.from_warehouse ? " | من:" + t.from_warehouse : "") +
          (t.to_warehouse ? " | إلى:" + t.to_warehouse : "") +
          (t.color ? " | لون:" + t.color : "") +
          (t.party ? " | طرف:" + t.party : "") +
          (t.notes ? " | ملاحظة:" + t.notes : "")
        );
      } catch (e) {
        return String(t.item_id) + " كمية:" + t.quantity;
      }
    });

    // ── سطور الأصناف (مُحسَّنة) ─────────────────────────────
    var itemLines = items.map(function (it) {
      var qty = stockMap[String(it.id)] || 0;
      var grp = groupNames[String(it.group)] || it.group || "—";
      var colors = (it.colors_json || [])
        .map(function (c) {
          return c.name || c;
        })
        .join("،");
      return (
        "- [" +
        (it.code || it.id) +
        "] " +
        it.name +
        " | مجموعة:" +
        grp +
        " | رصيد:" +
        qty +
        " " +
        (it.unit || "") +
        (colors ? " | ألوان:" + colors : "") +
        (Number(it.min_qty) > 0 ? " | حد أدنى:" + it.min_qty : "") +
        (Number(it.selling_price) > 0 ? " | سعر:" + it.selling_price : "")
      );
    });

    // ── تفاصيل المخازن ──────────────────────────────────────
    var warehouseLines = warehouses.map(function (w) {
      var whStock = stockByWarehouse[String(w.name)] || {};
      var totalQty = Object.keys(whStock).reduce(function (acc, k) {
        return acc + (whStock[k] || 0);
      }, 0);
      var itemCount = Object.keys(whStock).filter(function (k) {
        return whStock[k] > 0;
      }).length;
      return (
        "- " +
        w.name +
        " (" +
        (w.type || "—") +
        ")" +
        " | أصناف:" +
        itemCount +
        " | إجمالي كميات:" +
        totalQty +
        (w.location ? " | موقع:" + w.location : "")
      );
    });

    // ── أوامر الإنتاج ────────────────────────────────────────
    var prodLines = [];
    if (prodOrders.length) {
      var openOrders = prodOrders.filter(function (p) {
        return p.status !== "مكتمل" && p.status !== "ملغي";
      });
      var closedOrders = prodOrders.filter(function (p) {
        return p.status === "مكتمل";
      });
      prodLines.push(
        "إجمالي أوامر الإنتاج: " +
          prodOrders.length +
          " (مفتوح:" +
          openOrders.length +
          " / مكتمل:" +
          closedOrders.length +
          ")",
      );
      openOrders.slice(0, 10).forEach(function (p) {
        var productName = "";
        var found = items.filter(function (it) {
          return String(it.id) === String(p.product_id);
        });
        if (found.length) productName = found[0].name;
        try {
          prodLines.push(
            "  • [" +
              p.id +
              "] " +
              (productName || p.product_id) +
              " | كمية:" +
              (p.quantity || 0) +
              " | حالة:" +
              (p.status || "—") +
              " | تاريخ:" +
              Utilities.formatDate(new Date(p.date), "GMT+2", "yyyy-MM-dd"),
          );
        } catch (e) {
          prodLines.push("  • " + p.id);
        }
      });
    }

    // ── تجميع كل شيء ────────────────────────────────────────
    var lines = [
      "التاريخ: " +
        Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd HH:mm"),
      "إجمالي الأصناف: " + items.length,
      "المخازن (" +
        warehouses.length +
        "): " +
        warehouses
          .map(function (w) {
            return w.name;
          })
          .join("، "),
      "المجموعات (" +
        groups.length +
        "): " +
        groups
          .map(function (g) {
            return g.name;
          })
          .join("، "),
      "إجمالي حركات المخزون: " + txAll.length,
      "",
      "== تفاصيل المخازن ==",
    ].concat(warehouseLines);

    lines.push("");
    lines.push("== الأصناف والأرصدة (" + items.length + " صنف) ==");
    lines = lines.concat(itemLines);

    if (alerts.length) {
      lines.push("");
      lines.push("== تنبيهات نقص المخزون (" + alerts.length + " صنف) ==");
      lines = lines.concat(
        alerts.map(function (a) {
          return " " + a;
        }),
      );
    }

    if (prodLines.length) {
      lines.push("");
      lines.push("== أوامر الإنتاج ==");
      lines = lines.concat(prodLines);
    }

    if (recentTx.length) {
      lines.push("");
      lines.push("== آخر 50 حركة مخزون ==");
      lines = lines.concat(recentTx);
    }

    return lines.join("\n");
  } catch (e) {
    return "تعذّر تحميل بيانات المخزون: " + e.message;
  }
}
// [FIX-AUDIT #2] require_notes_on_tx كان يُحفظ ويُقرأ لكن لا شيء يتحقق منه —
// كان يوهم الأدمن أنه فرض سياسة "الملاحظات إلزامية على الحركات" بينما لا
// يوجد أي تطبيق فعلي لذلك. هذه دالة مشتركة تُستدعى من نقاط إنشاء الحركات
// الرئيسية (سندات القبض/الصرف، فواتير البيع/الشراء، القيود اليدوية، حركات
// المخزون) لترفض العملية فعليًا لو الإعداد مفعّل والملاحظة فارغة.
// (لم يُغطَّ بهذا الفحص كل نوع حركة في المشروع — راجع الفروقات في تقرير
// المراجعة لباقي الشاشات غير المدقَّقة في هذه الجولة.)
function _checkRequireNotesOnTx(noteValue) {
  try {
    var settings = _getCompanySettingsRaw();
    var required =
      settings.require_notes_on_tx === true ||
      settings.require_notes_on_tx === "true";
    if (!required) return null;
    if (!noteValue || String(noteValue).trim() === "") {
      return errResponse(
        " الملاحظات إلزامية على الحركات حسب إعدادات النظام — الرجاء إدخال ملاحظة",
      );
    }
    return null;
  } catch (e) {
    return null; // لا نمنع الحركة لو فشل فحص الإعداد نفسه
  }
}

function _getCompanySettingsRaw() {
  try {
    var sheet = SS.getSheetByName("Settings");
    if (!sheet) return {};
    var data = sheet.getDataRange().getValues();
    var settings = {};
    // نتخطى الصف الأول (headers)
    for (var i = 1; i < data.length; i++) {
      var key = String(data[i][0] || "").trim();
      if (!key) continue;
      var val = data[i][1];
      // Boolean values المحفوظة كـ string
      if (val === "true") val = true;
      if (val === "false") val = false;
      settings[key] = val;
    }
    return settings;
  } catch (e) {
    console.error("_getCompanySettingsRaw:", e);
    return {};
  }
}

/**
 * _getSystemSetupStatus — فحص جاهزية الإعدادات الأساسية قبل العمليات المالية
 * @returns {{ ready: boolean, missing: string[], warnings: string[], score: number }}
 */
function _getSystemSetupStatus() {
  var missing = [];
  var warnings = [];
  var settings = _getCompanySettingsRaw();
  var coa = [];

  if (!settings.company_name || String(settings.company_name).trim() === "") {
    missing.push("اسم الشركة");
  }
  if (!settings.currency || String(settings.currency).trim() === "") {
    missing.push("العملة الافتراضية");
  }
  if (!settings.fiscal_year_start) {
    warnings.push("بداية السنة المالية غير محددة");
  }

  try {
    var periods = readSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS, {
      trimStrings: true,
    });
    var openPeriods = periods.filter(function (p) {
      return p.status === "OPEN";
    });
    if (periods.length === 0) {
      warnings.push("لا توجد فترات محاسبية — أنشئ فترات السنة المالية");
    } else if (openPeriods.length === 0) {
      missing.push("فترة محاسبية مفتوحة واحدة على الأقل");
    }
  } catch (e) {
    warnings.push("جدول الفترات المحاسبية غير مهيأ — شغّل setupPhase2Sheets");
  }

  try {
    var wh = readSheet("Warehouses");
    var activeWh = (wh || []).filter(function (w) {
      return !w.deleted_at;
    });
    if (activeWh.length === 0) missing.push("مستودع واحد على الأقل");
  } catch (e) {
    missing.push("مستودعات");
  }

  try {
    coa = readSheet("ChartOfAccounts", ACCOUNTING_HR_HEADERS.ChartOfAccounts);
    var activeLeaves = coa.filter(function (a) {
      return (
        !a.deleted_at &&
        a.is_active !== false &&
        a.is_parent !== true &&
        a.is_parent !== "TRUE"
      );
    });
    if (activeLeaves.length < 5) {
      missing.push("دليل حسابات (5 حسابات فرعية على الأقل)");
    }

    var orphanCount = 0;
    var codeMap = {};
    var dupCodes = 0;
    coa.forEach(function (a) {
      if (a.deleted_at) return;
      if (a.parent_id) {
        var parent = coa.find(function (p) {
          return p.id === a.parent_id && !p.deleted_at;
        });
        if (!parent) orphanCount++;
      }
      var code = String(a.code || "").trim();
      if (code) {
        if (codeMap[code]) dupCodes++;
        else codeMap[code] = true;
      }
    });
    if (orphanCount > 0) {
      warnings.push(orphanCount + " حساب(ات) بدون أب صالح في دليل الحسابات");
    }
    if (dupCodes > 0) {
      warnings.push("أكواد حسابات مكررة في دليل الحسابات");
    }
  } catch (e) {
    missing.push("دليل الحسابات");
  }

  var criticalKeys = [
    "ar_account",
    "ap_account",
    "cash_account",
    "inventory_account",
    "revenue_account",
    "purchase_account",
    "cogs_account",
    "opening_balance_equity_account",
  ];
  var corePosting = verifyPostingSetupComplete(criticalKeys);
  corePosting.missing.forEach(function (m) {
    missing.push("حساب ترحيل: " + m.label);
  });

  try {
    var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    if (!cashBoxes || cashBoxes.length === 0) {
      warnings.push("لا توجد خزينة واحدة مُعرَّفة على الأقل");
    }
  } catch (e) {
    Logger.log("[silent-catch] " + e);
  }

  var score = Math.max(0, 100 - missing.length * 12 - warnings.length * 4);
  return {
    ready: missing.length === 0,
    missing: missing,
    warnings: warnings,
    score: score,
  };
}

/** _requireFinancialSetup — يمنع العمليات المالية قبل اكتمال الإعداد الأساسي */
function _requireFinancialSetup() {
  var status = _getSystemSetupStatus();
  if (!status.ready) {
    return errResponse(
      " لا يمكن تنفيذ العملية — الإعدادات الأساسية غير مكتملة: " +
        status.missing.join("، ") +
        ". أكمل: بيانات الشركة، الفترات المحاسبية، دليل الحسابات، وربط الحسابات.",
    );
  }
  return null;
}

/** getSystemSetupStatus — alias متوافق لـ getSystemReadinessStatus */
function getSystemSetupStatus(callerUser, sessionToken) {
  return getSystemReadinessStatus(callerUser, sessionToken);
}

/**
 * saveCompanySettings — حفظ إعدادات الشركة من الـ frontend
 * كل key-value يُحفظ كصف في شيت Settings
 */
/**
 * _saveCompanySettings — [BUG-FIX] الكتابة الفعلية لإعدادات الشركة، بدون
 * أي فحص صلاحية. كانت هذه الدالة تُستدعى من setBackupUserFolder دون أن
 * تكون معرّفة أصلاً (ReferenceError عند حفظ مجلد الباكاب). أُخرجت هنا
 * من منطق saveCompanySettings العامة (نفس المنطق تماماً بدون تغيير) لكي
 * تُستخدم داخلياً في أي مكان لا يمر بمسار المستخدم العادي (Frontend +
 * صلاحيات)، بينما تبقى saveCompanySettings هي البوابة المحمية بالصلاحية.
 */
function _saveCompanySettings(payload) {
  var sheet = SS.getSheetByName("Settings");
  if (!sheet) {
    sheet = SS.insertSheet("Settings");
    sheet.appendRow(["key", "value", "updated_at"]);
    // تنسيق header
    sheet
      .getRange(1, 1, 1, 3)
      .setFontWeight("bold")
      .setBackground("#2563eb")
      .setFontColor("#ffffff");
    sheet.setFrozenRows(1);
  }
  // عمود "value" قد يحتوي رقم هاتف الشركة أو أكواد — نحميه من فقدان
  // الصفر الأول دايمًا (شيت جديد أو قديم)، بصرف النظر عن باقي القيم
  // الرقمية الحقيقية (نسب/أرقام) التي تبقى تُقرأ صحيحة بنفس قيمتها.
  sheet
    .getRange(1, 2, Math.max(sheet.getMaxRows(), 5000), 1)
    .setNumberFormat("@");

  // ابني خريطة key → row number من البيانات الحالية
  var existing = sheet.getDataRange().getValues();
  var keyToRow = {};
  for (var i = 1; i < existing.length; i++) {
    var k = String(existing[i][0] || "").trim();
    if (k) keyToRow[k] = i + 1; // +1 لأن getValues 0-indexed
  }

  var now = new Date();
  Object.keys(payload).forEach(function (key) {
    // لو القيمة نص (زي رقم الهاتف) نحافظ عليها كنص خام بدون أي
    // تحويل رقمي؛ القيم غير النصية (boolean/number حقيقي) تُترك كما هي
    var raw = payload[key];
    var val = typeof raw === "string" ? preserveTextNumber(raw) : raw;
    if (keyToRow[key]) {
      // حدّث الصف الموجود
      sheet.getRange(keyToRow[key], 2).setValue(val);
      sheet.getRange(keyToRow[key], 3).setValue(now);
    } else {
      // أضف صف جديد
      sheet.appendRow([key, val, now]);
    }
  });

  // امسح الكاش عشان getAllData يقرأ القيم الجديدة
  _invalidateServerCache(); // BUG-2 FIX: كان _clearServerCache() (غير موجودة) → _invalidateServerCache()
}

function saveCompanySettings(payload, callerUser, sessionToken) {
  try {
    // BUG-3 FIX: كان _checkPermission("admin") وده غلط — "admin" string مش username
    // _checkPermission بتدور على المستخدم بالـ username، مش بالـ role
    // [ثغرة إضافية] الكود القديم if(callerUser){...} كان يتجاوز الفحص بالكامل لو لم
    // يُرسل callerUser — أي طلب بدون اسم مستخدم كان يمر بدون أي تحقق صلاحية
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
    if (permErr) return permErr;
    if (!payload || typeof payload !== "object") {
      return errResponse("payload غير صالح");
    }

    _saveCompanySettings(payload);

    return okResponse("تم حفظ الإعدادات بنجاح");
  } catch (e) {
    console.error("saveCompanySettings:", e);
    return errResponse("خطأ في الحفظ: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────

// ── [نُقل من §30 — GROQ AI Proxy] ──

// ─────────────────────────────────────────────────────────────
// §30  GROQ AI Proxy — [SEC-FIX-5] بديل آمن للـ API key في الفرونت
// ─────────────────────────────────────────────────────────────
/**
 * proxyGroqChat — وكيل آمن لـ Groq AI
 *
 * يُستدعى من الفرونت بدلاً من استدعاء Groq مباشرة.
 * المفتاح محفوظ في PropertiesService["GROQ_API_KEY"] على الـ server فقط.
 *
 * @param {string} callerUser  - اسم المستخدم للتحقق من الصلاحية
 * @param {string} sessionToken - رمز الجلسة للتحقق
 * @param {Array}  messages    - مصفوفة رسائل {role, content}
 * @returns {object} { success, reply } أو { success: false, message }
 */
function proxyGroqChat(callerUser, sessionToken, messages) {
  try {
    // التحقق من الجلسة أولاً
    if (!sessionToken)
      return errResponse(
        "يجب تسجيل الدخول لاستخدام المساعد",
        "SESSION_INVALID",
      );
    var sess = validateSession(sessionToken);
    if (!sess || !sess.valid)
      return errResponse(
        "جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        "SESSION_INVALID",
      );
    if (
      String(sess.username || "").toLowerCase() !==
      String(callerUser || "").toLowerCase()
    ) {
      return errResponse("خطأ في التحقق من الهوية");
    }

    // جلب المفتاح من PropertiesService (لا يُكشف للفرونت أبداً)
    var apiKey =
      PropertiesService.getScriptProperties().getProperty("GROQ_API_KEY");
    if (!apiKey)
      return errResponse("المساعد الذكي غير مفعّل — تواصل مع المدير");

    // تنظيف الرسائل من أي محتوى خطير
    if (!Array.isArray(messages) || messages.length === 0) {
      return errResponse("الرسائل مطلوبة");
    }
    var cleanMessages = messages
      .map(function (m) {
        return {
          role: String(m.role || "user").replace(/[^a-z]/g, ""),
          content: String(m.content || "").substring(0, 4000), // حد أقصى 4000 حرف
        };
      })
      .filter(function (m) {
        return (
          m.role === "user" || m.role === "assistant" || m.role === "system"
        );
      })
      .slice(-20); // آخر 20 رسالة فقط

    var payload = {
      model: "llama-3.3-70b-versatile",
      max_tokens: 1000,
      messages: cleanMessages,
    };

    var options = {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    var response = UrlFetchApp.fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      options,
    );
    var result = JSON.parse(response.getContentText());

    if (result.choices && result.choices[0] && result.choices[0].message) {
      return { success: true, reply: result.choices[0].message.content };
    }
    return errResponse("لم يرد المساعد — حاول مرة أخرى");
  } catch (e) {
    console.error("proxyGroqChat error:", e.message);
    return errResponse("خطأ في الاتصال بالمساعد");
  }
}

/**
 * [SEC-FIX-TTS-1] proxyElevenLabsTTS — وكيل آمن لـ ElevenLabs TTS
 * المفتاح محفوظ في PropertiesService["ELEVENLABS_KEY"] — لا يُكشف للفرونت
 * يُعيد الصوت كـ base64 ليُشغَّل في المتصفح
 */
function proxyElevenLabsTTS(callerUser, sessionToken, text, voiceId) {
  try {
    if (!sessionToken) return errResponse("يجب تسجيل الدخول لاستخدام TTS");
    var sess = validateSession(sessionToken);
    if (!sess || !sess.valid)
      return errResponse(
        "جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        "SESSION_INVALID",
      );
    if (
      String(sess.username || "").toLowerCase() !==
      String(callerUser || "").toLowerCase()
    ) {
      return errResponse("خطأ في التحقق من الهوية");
    }
    var apiKey =
      PropertiesService.getScriptProperties().getProperty("ELEVENLABS_KEY");
    if (!apiKey) return errResponse("خدمة TTS غير مفعّلة — تواصل مع المدير");

    var cleanText = String(text || "").substring(0, 2000);
    var cleanVoice = String(voiceId || "pqHfZKP75CvOlQylNhV4").replace(
      /[^a-zA-Z0-9]/g,
      "",
    );

    var response = UrlFetchApp.fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/" + cleanVoice,
      {
        method: "post",
        contentType: "application/json",
        headers: { "xi-api-key": apiKey },
        payload: JSON.stringify({
          text: cleanText,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        muteHttpExceptions: true,
      },
    );

    if (response.getResponseCode() !== 200) {
      console.error("ElevenLabs HTTP:", response.getResponseCode());
      return errResponse("فشل تحويل النص لصوت — حاول مرة أخرى");
    }

    var audioBytes = response.getContent();
    var audioBase64 = Utilities.base64Encode(audioBytes);
    return { success: true, audioBase64: audioBase64, mimeType: "audio/mpeg" };
  } catch (e) {
    console.error("proxyElevenLabsTTS error:", e.message);
    return errResponse("خطأ في خدمة TTS");
  }
}

/**
 * [SEC-FIX-TTS-1] proxyGeminiTTS — وكيل آمن لـ Google Gemini TTS
 * المفتاح محفوظ في PropertiesService["GEMINI_TTS_KEY"] — لا يُكشف للفرونت
 * يُعيد الصوت كـ base64
 */
function proxyGeminiTTS(callerUser, sessionToken, text, voiceName) {
  try {
    if (!sessionToken) return errResponse("يجب تسجيل الدخول لاستخدام TTS");
    var sess = validateSession(sessionToken);
    if (!sess || !sess.valid)
      return errResponse(
        "جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        "SESSION_INVALID",
      );
    if (
      String(sess.username || "").toLowerCase() !==
      String(callerUser || "").toLowerCase()
    ) {
      return errResponse("خطأ في التحقق من الهوية");
    }
    var apiKey =
      PropertiesService.getScriptProperties().getProperty("GEMINI_TTS_KEY");
    if (!apiKey)
      return errResponse("خدمة Gemini TTS غير مفعّلة — تواصل مع المدير");

    var cleanText = String(text || "").substring(0, 2000);
    var cleanVoice = String(voiceName || "Kore").replace(/[^a-zA-Z]/g, "");
    var model = "gemini-2.5-flash-preview-tts";

    var url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent?key=" +
      apiKey;

    var response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        contents: [{ parts: [{ text: cleanText }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: cleanVoice } },
          },
        },
      }),
      muteHttpExceptions: true,
    });

    if (response.getResponseCode() !== 200) {
      console.error("Gemini TTS HTTP:", response.getResponseCode());
      return errResponse("فشل Gemini TTS — حاول مرة أخرى");
    }

    var result = JSON.parse(response.getContentText());
    var part =
      result.candidates &&
      result.candidates[0] &&
      result.candidates[0].content &&
      result.candidates[0].content.parts &&
      result.candidates[0].content.parts[0];

    if (!part || !part.inlineData || !part.inlineData.data) {
      return errResponse("Gemini TTS: لا يوجد بيانات صوتية في الرد");
    }

    return {
      success: true,
      audioBase64: part.inlineData.data,
      mimeType: part.inlineData.mimeType || "",
    };
  } catch (e) {
    console.error("proxyGeminiTTS error:", e.message);
    return errResponse("خطأ في خدمة Gemini TTS");
  }
}

/**
 * setupSecurityUpgrades — تهيئة تطويرات الأمان v4.1
 *
 * تُنشئ / تُحدّث:
 *   • أعمدة AuditLog الجديدة (old_value + new_value)
 *   • شيت WarehouseAccess
 *   • أعمدة deleted_at + deleted_by في Items
 *
 * شغّلها مرة واحدة من: Apps Script Editor → Run → setupSecurityUpgrades
 */
function setupSecurityUpgrades() {
  var results = [];

  // [1] AuditLog — تحديث الأعمدة
  try {
    getSheet("AuditLog", AUDIT_HEADERS);
    results.push(" AuditLog: تم تحديث الأعمدة (old_value + new_value)");
  } catch (e) {
    results.push(" AuditLog: " + e.message);
  }

  // [1b] AuditLog — إعداد Trigger أسبوعي للأرشفة التلقائية [SEC-FIX-AUDIT]
  try {
    var auditTriggerResult = setupAuditLogTrimTrigger();
    results.push(
      auditTriggerResult.success
        ? " AuditLog Trigger: " + auditTriggerResult.message
        : " AuditLog Trigger: " + auditTriggerResult.message,
    );
  } catch (e) {
    results.push(" AuditLog Trigger: " + e.message);
  }

  // [4] WarehouseAccess — إنشاء شيت
  try {
    getSheet("WarehouseAccess", WH_ACCESS_HEADERS);
    results.push(" WarehouseAccess: تم إنشاء الشيت");
  } catch (e) {
    results.push(" WarehouseAccess: " + e.message);
  }

  // [3] Items — إضافة أعمدة Soft Delete
  try {
    var itemSheet = SS.getSheetByName("Items");
    if (itemSheet) {
      var lastCol = itemSheet.getLastColumn();
      var headers = itemSheet.getRange(1, 1, 1, lastCol).getValues()[0];
      if (headers.indexOf("deleted_at") === -1) {
        var nc = lastCol + 1;
        itemSheet
          .getRange(1, nc)
          .setValue("deleted_at")
          .setFontWeight("bold")
          .setBackground("#dc2626")
          .setFontColor("#ffffff");
        itemSheet
          .getRange(1, nc + 1)
          .setValue("deleted_by")
          .setFontWeight("bold")
          .setBackground("#dc2626")
          .setFontColor("#ffffff");
        results.push(" Items: أضيف deleted_at + deleted_by");
      } else {
        results.push("ℹ️ Items: أعمدة Soft Delete موجودة مسبقاً");
      }
    }
  } catch (e) {
    results.push(" Items soft-delete: " + e.message);
  }

  // سجّل في AuditLog
  try {
    AuditEngine.log("SETUP_SECURITY_v4.1", {
      user: "SYSTEM",
      table: "System",
      details: results.join(" | ")});
  } catch (e) {
    console.error("unknown - خطأ:", e.message || e);
  }

  Logger.log(results.join("\n"));
  return " نتائج إعداد الأمان v4.1:\n" + results.join("\n");
}
// في §20 Backup System
/**
 * setBackupUserFolder — [BACKUP-ENGINE-v5] كانت بلا أي تحقق صلاحية رغم إنها
 * تتحكم في وجهة تخزين كل النسخ الاحتياطية للشركة (بيانات حساسة جدًا لو
 * اتحوّلت لفولدر مش تابع للأدمن). أضفنا نفس صلاحية "createBackup" هنا.
 */
function setBackupUserFolder(folderId, callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "createBackup", sessionToken);
  if (permErr) return permErr;
  try {
    var settings = _getCompanySettingsRaw();
    settings.backup_folder_id = folderId;
    _saveCompanySettings(settings);
    return okResponse(" تم حفظ مجلد الباكاب");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}
