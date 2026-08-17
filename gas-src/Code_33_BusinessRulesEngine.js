// ══════════════════════════════════════════════════════════════════════════
// Code_33_BusinessRulesEngine.gs — محرك قواعد الأعمال الموحّد (BusinessRulesEngine)
// ──────────────────────────────────────────────────────────────────────────
// الهدف: نقطة واحدة لكل "قاعدة عمل" (Business Rule) في MOO.ERP بدل تكرارها
// داخل كل دالة CRUD في كل موديول. هذا الملف لا يستبدل أي كود قائم تلقائيًا —
// راجع BUSINESS_RULES_ENGINE_REPORT.md لمعرفة أي القواعد منقولة فعليًا
// (استُبدل الكود القديم باستدعاء المحرك) وأيها موثّقة هنا فقط تمهيدًا للنقل
// التدريجي دون كسر أي سلوك حالي.
//
// [BRE-DESIGN] المحرك:
//   - لا يحتوي أي كود واجهة (UI). دوال Server-side خالصة (.gs).
//   - لا يعتمد على شاشة معيّنة — يُستدعى من أي Code_XX_*.gs.
//   - يعيد دائمًا نفس الشكل الموحّد (انظر _bre_result أدناه).
//   - كل قاعدة داخليًا تعيد الاستخدام (reuse) لأي دالة فحص موجودة فعلاً في
//     المشروع (مثل _accountHasTransactions, _partyHasUsage, _checkOutboundStock)
//     بدل إعادة كتابة نفس المنطق — تفاديًا لخلق نسخة ثالثة من نفس القاعدة.
//
// طريقة الاستخدام من أي ملف آخر في نفس مشروع Apps Script:
//   var r = BusinessRulesEngine.validateBeforeDelete('item', { id: itemId });
//   if (!r.success) return errResponse(r.message);
//
// ══════════════════════════════════════════════════════════════════════════

var BusinessRulesEngine = (function () {
  "use strict";

  // ── شكل النتيجة الموحّد ──────────────────────────────────────────────
  function _ok(details) {
    return {
      success: true,
      code: "OK",
      message: null,
      warning: null,
      details: details || null,
    };
  }

  function _fail(code, message, details) {
    return {
      success: false,
      code: code,
      message: message,
      warning: null,
      details: details || null,
    };
  }

  function _warn(code, message, details) {
    return {
      success: true, // لا يمنع العملية، لكنه يُرفق تحذيرًا يعرضه الاستدعاء
      code: code,
      message: null,
      warning: message,
      details: details || null,
    };
  }

  // ── أداة مساعدة: قراءة إعداد نظام اختياري بدون كسر شيء لو غير موجود ──
  function _safeCompanySetting(key, fallback) {
    try {
      var s =
        typeof _getCompanySettingsRaw === "function"
          ? _getCompanySettingsRaw()
          : null;
      if (s && s[key] !== undefined && s[key] !== null && s[key] !== "") {
        return s[key];
      }
    } catch (e) {
      // تجاهل — الإعداد اختياري، نرجع للقيمة الافتراضية
    }
    return fallback;
  }

  // ════════════════════════════════════════════════════════════════════
  // 1) قواعد الأصناف (Items)
  // ════════════════════════════════════════════════════════════════════
  var ItemRules = {
    // [موجود فعلاً] يعيد استخدام نفس فحص Code_16_Inventory.gs::deleteItem
    hasStockBalance: function (itemId) {
      try {
        return getSheetData("Stock").some(
          (s) => s.item_id === itemId && Number(s.quantity || 0) > 0,
        );
      } catch (e) {
        return true; // الأسلم عند الفشل: منع الحذف
      }
    },

    // [موجود فعلاً بشكل غير مباشر] هل للصنف حركات مخزون مسجّلة (Transactions)
    hasMovements: function (itemId) {
      try {
        return getSheetData("Transactions").some(
          (t) => String(t.item_id || "") === String(itemId),
        );
      } catch (e) {
        return true;
      }
    },

    // [قاعدة جديدة] هل للصنف رصيد افتتاحي مسجّل (OpeningStock)؟
    // بيمنع حذف صنف اتسجّل له رصيد أول مدة حتى لو اتصفّر الرصيد الحالي بعدين.
    hasOpeningBalance: function (itemId) {
      try {
        var rows =
          typeof OPENING_STOCK_HEADERS !== "undefined"
            ? readSheet("OpeningStock", OPENING_STOCK_HEADERS)
            : getSheetData("OpeningStock");
        return rows.some((r) => String(r.item_id || "") === String(itemId));
      } catch (e) {
        return true; // الأسلم عند الفشل: منع الحذف
      }
    },

    // [قاعدة جديدة] هل للصنف استخدام في فواتير أو مرتجعات (بيع/شراء)؟
    // بنود الفاتورة مخزّنة كـ lines_json داخل صف الفاتورة نفسه (لا يوجد
    // جدول بنود منفصل في المشروع)، فبنفحص كل صف فاتورة/مرتجع ونفكّك بنوده.
    hasInvoiceUsage: function (itemId) {
      try {
        var sources = [
          { table: "SaleInvoices", headers: typeof SALE_INVOICE_HEADERS !== "undefined" ? SALE_INVOICE_HEADERS : undefined },
          { table: "PurchaseInvoices", headers: typeof PURCHASE_INVOICE_HEADERS !== "undefined" ? PURCHASE_INVOICE_HEADERS : undefined },
          { table: "SaleReturns", headers: typeof SALE_RETURN_HEADERS !== "undefined" ? SALE_RETURN_HEADERS : undefined },
          { table: "PurchaseReturns", headers: typeof PURCHASE_RETURN_HEADERS !== "undefined" ? PURCHASE_RETURN_HEADERS : undefined },
        ];
        return sources.some(function (src) {
          var rows = src.headers
            ? readSheet(src.table, src.headers, { parseJson: ["lines_json"] })
            : getSheetData(src.table);
          return rows.some(function (doc) {
            var lines = doc.lines_json;
            if (typeof lines === "string") {
              try {
                lines = JSON.parse(lines);
              } catch (e2) {
                lines = [];
              }
            }
            if (!Array.isArray(lines)) return false;
            return lines.some(
              (l) => String((l && (l.item_id || l.id)) || "") === String(itemId),
            );
          });
        });
      } catch (e) {
        return true; // الأسلم عند الفشل: منع الحذف
      }
    },

    // [موجود فعلاً] فحص تكرار كود الصنف — نفس منطق addItem/updateItem الحالي
    isDuplicateCode: function (code, excludeId) {
      try {
        var items = getSheetData("Items");
        return items.some(
          (it) =>
            String(it.code || "").trim() === String(code || "").trim() &&
            String(it.id) !== String(excludeId || ""),
        );
      } catch (e) {
        return false;
      }
    },

    // [موجود فعلاً] فحص تكرار الباركود (لو العمود موجود في شيت الأصناف)
    isDuplicateBarcode: function (barcode, excludeId) {
      if (!barcode) return false;
      try {
        var items = getSheetData("Items");
        return items.some(
          (it) =>
            it.barcode &&
            String(it.barcode).trim() === String(barcode).trim() &&
            String(it.id) !== String(excludeId || ""),
        );
      } catch (e) {
        return false;
      }
    },

    // [قاعدة جديدة — غير مطبّقة حاليًا في أي شاشة] منع السعر السالب
    hasNegativePrice: function (data) {
      var fields = ["sale_price", "purchase_price", "min_price", "cost"];
      return fields.some((f) => data[f] !== undefined && Number(data[f]) < 0);
    },

    isUnitValid: function (unit) {
      if (!unit) return false;
      // لا يوجد جدول "وحدات" مستقل في المشروع الحالي (لم يُعثر على شيت Units)؛
      // الفحص الحالي في addItem/updateItem هو فقط required=true. هنا نضيف حدًّا
      // أدنى منطقيًا (نص غير فارغ) لحين وجود قائمة وحدات معتمدة رسميًا.
      return String(unit).trim().length > 0;
    },

    isCategoryValid: function (groupId) {
      if (!groupId) return false;
      try {
        var groups = getSheetData("Groups");
        return groups.some((g) => String(g.id) === String(groupId));
      } catch (e) {
        return true; // تفاديًا لكسر شاشات لا ترسل مجموعة إلزاميًا حاليًا
      }
    },

    // [ACC-FIELD-FILTER-2026-08-08] خط دفاع ثانٍ بالسيرفر — الفلترة في
    // شاشة الصنف (03_JS_Dashboard_Items.html) بتمنع الاختيار من الواجهة،
    // لكن أي مصدر تاني (استيراد صناف، AI Agent، نداء API مباشر) ممكن يبعت
    // account_id مباشرة من غير ما يعدّي على فلترة الواجهة. نفس فلسفة
    // _validatePartyAccountId (Customers/Suppliers) لكن لصناف بدل أطراف،
    // وبنفحص كل حقول الحسابات الثمانية مرة واحدة. حقل فاضي مقبول دايمًا
    // (يعني "استخدم الافتراضي من إعدادات الترحيل") — الفحص بس لو المستخدم
    // فعلاً اختار قيمة.
    ACCOUNT_FIELDS: [
      ["inventory_account_id", "حساب المخزون", "ASSET"],
      ["cogs_account_id", "حساب تكلفة البضاعة المباعة (COGS)", "EXPENSE"],
      ["sales_account_id", "حساب إيرادات المبيعات", "REVENUE"],
      ["purchase_account_id", "حساب المشتريات", "EXPENSE"],
      ["sales_return_account_id", "حساب مردودات المبيعات", "REVENUE"],
      ["purchase_return_account_id", "حساب مردودات المشتريات", "EXPENSE"],
      ["inventory_adjustment_account_id", "حساب تسوية/فروقات المخزون", "EXPENSE"],
      ["price_difference_account_id", "حساب فروقات السعر", "EXPENSE"],
    ],

    // بيرجع أول خطأ يلاقيه (code, message) أو null لو كل الحقول سليمة.
    findInvalidAccountField: function (payload) {
      try {
        var relevant = this.ACCOUNT_FIELDS.filter(function (f) {
          return payload[f[0]] !== undefined && payload[f[0]] !== null && String(payload[f[0]]).trim() !== "";
        });
        if (!relevant.length) return null;
        var accounts = readSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );
        for (var i = 0; i < relevant.length; i++) {
          var fieldKey = relevant[i][0];
          var fieldLabel = relevant[i][1];
          var expectedType = relevant[i][2];
          var accId = String(payload[fieldKey]).trim();
          var account = accounts.find(function (a) {
            return String(a.id) === accId;
          });
          if (!account) {
            return { code: "ACCOUNT_NOT_FOUND", message: fieldLabel + ": الحساب المحدد غير موجود في دليل الحسابات" };
          }
          if (!_isUsablePostingAccount(account, null)) {
            if (account.deleted_at) {
              return { code: "ACCOUNT_DELETED", message: fieldLabel + ": لا يمكن اختيار حساب محذوف" };
            }
            if (account.is_active === false || account.is_active === "FALSE") {
              return { code: "ACCOUNT_SUSPENDED", message: fieldLabel + ": لا يمكن اختيار حساب موقوف (غير نشط)" };
            }
            return { code: "ACCOUNT_IS_PARENT", message: fieldLabel + ": لا يمكن اختيار حساب رئيسي (أب) — اختر حسابًا فرعيًا قابلاً للترحيل عليه" };
          }
          if (account.type && !_isUsablePostingAccount(account, expectedType)) {
            return { code: "ACCOUNT_TYPE_MISMATCH", message: fieldLabel + ": نوع الحساب المختار (" + account.type + ") لا يتوافق مع الحقل — المتوقع " + expectedType };
          }
        }
        return null;
      } catch (e) {
        // فشل الفحص (نادر، زي عطل قراءة الشيت) — لا نمنع الحفظ بسببه، نفس
        // فلسفة باقي فحوصات ItemRules عند حدوث استثناء غير متوقع.
        return null;
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 2) قواعد العملاء (Customers)
  // ════════════════════════════════════════════════════════════════════
  var CustomerRules = {
    // [موجود فعلاً] يعيد استخدام Code_20_Sales.gs::_partyHasUsage
    hasBalanceOrMovements: function (customerId) {
      try {
        return _partyHasUsage("customer", customerId);
      } catch (e) {
        return true;
      }
    },

    // [قاعدة جديدة — لا يوجد حد ائتمان في المشروع حاليًا]
    // لا يوجد عمود credit_limit في شيت العملاء حسب الفحص الحالي — القاعدة هنا
    // جاهزة للتفعيل فور إضافة الحقل، وتتجاهل الفحص بأمان (ترجع OK) لو الحقل غير موجود
    // حتى لا تمنع أي عملية بيع حالية بدون سبب.
    exceedsCreditLimit: function (customer, invoiceTotal) {
      if (
        !customer ||
        customer.credit_limit === undefined ||
        customer.credit_limit === null ||
        customer.credit_limit === ""
      ) {
        return false; // لا يوجد حد ائتمان معرّف لهذا العميل — لا مانع
      }
      var limit = Number(customer.credit_limit || 0);
      if (limit <= 0) return false; // 0 أو فارغ = بدون حد
      var currentBalance = Number(customer.balance || 0);
      return currentBalance + Number(invoiceTotal || 0) > limit;
    },

    // [قاعدة جديدة] فحص تكرار كود العميل — نفس منطق ItemRules.isDuplicateCode
    // بالضبط، لكن على شيت Customers. الكود بقى إلزاميًا وأساسيًا (فريد) لكل عميل.
    isDuplicateCode: function (code, excludeId) {
      try {
        var customers = getSheetData("Customers");
        return customers.some(
          (c) =>
            String(c.code || "").trim() === String(code || "").trim() &&
            String(c.id) !== String(excludeId || ""),
        );
      } catch (e) {
        return false;
      }
    },

    // [AUDIT-FIX H2] لم يكن هناك أي منع لتكرار الهاتف أو الرقم الضريبي —
    // فقط الكود كان مفحوصًا. الرقم الضريبي والهاتف من طبيعتهما معرّفات
    // فريدة للطرف في ERP احترافي (خلافًا للاسم الذي قد يتكرر شرعًا بين
    // أطراف مختلفة، فلا يُمنع). فارغ = لا فحص (لا نغيّر سلوك الحقول
    // الاختيارية القديمة).
    isDuplicatePhone: function (phone, excludeId) {
      var v = String(phone || "").trim();
      if (!v) return false;
      try {
        var customers = getSheetData("Customers");
        return customers.some(
          (c) =>
            String(c.phone || "").trim() === v &&
            String(c.id) !== String(excludeId || ""),
        );
      } catch (e) {
        return false;
      }
    },

    isDuplicateTaxNumber: function (taxNumber, excludeId) {
      var v = String(taxNumber || "").trim();
      if (!v) return false;
      try {
        var customers = getSheetData("Customers");
        return customers.some(
          (c) =>
            String(c.tax_number || "").trim() === v &&
            String(c.id) !== String(excludeId || ""),
        );
      } catch (e) {
        return false;
      }
    },

    // [CUST-SETTINGS-2026-08-07] فحص تكرار اسم العميل — غير مفعّل افتراضيًا
    // (allow_duplicate_customer_name = true بشكل افتراضي، وهو نفس السلوك
    // القديم قبل هذا التعديل: مفيش فحص أصلاً). يتفعّل فقط لو الإعداد
    // مقفول من CustomerSettingsEngine. المقارنة case-insensitive وبعد trim
    // لتفادي "أحمد " و"أحمد" كاسمين مختلفين شكليًا.
    isDuplicateName: function (name, excludeId) {
      var v = String(name || "").trim().toLowerCase();
      if (!v) return false;
      try {
        var customers = getSheetData("Customers");
        return customers.some(
          (c) =>
            String(c.name || "").trim().toLowerCase() === v &&
            String(c.id) !== String(excludeId || ""),
        );
      } catch (e) {
        return false;
      }
    },

    // [قاعدة جديدة] منع تعديل البيانات الأساسية (الاسم/الرقم الضريبي) لعميل
    // له حركات فعلية — حاليًا updateCustomer لا يفرّق بين تعديل بيانات أساسية
    // أو ثانوية، فهذه القاعدة اختيارية (تُستدعى فقط لو الشاشة تريد تشديد الحماية)
    isSensitiveFieldChangeBlocked: function (customerId, changedFields) {
      var sensitive = ["name", "tax_number", "national_id"];
      var touchesSensitive = (changedFields || []).some(
        (f) => sensitive.indexOf(f) !== -1,
      );
      if (!touchesSensitive) return false;
      try {
        return _partyHasUsage("customer", customerId);
      } catch (e) {
        return false;
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 3) قواعد الموردين (Suppliers) — نفس منطق العملاء عبر _partyHasUsage
  // ════════════════════════════════════════════════════════════════════
  var SupplierRules = {
    hasBalanceOrMovements: function (supplierId) {
      try {
        return _partyHasUsage("supplier", supplierId);
      } catch (e) {
        return true;
      }
    },

    // [PARITY-CUST] فحص تكرار كود المورد — نفس منطق
    // CustomerRules.isDuplicateCode بالضبط، لكن على شيت Suppliers. الكود بقى
    // إلزاميًا وفريدًا لكل مورد بنفس مبدأ العميل.
    isDuplicateCode: function (code, excludeId) {
      try {
        var suppliers = getSheetData("Suppliers");
        return suppliers.some(
          (s) =>
            String(s.code || "").trim() === String(code || "").trim() &&
            String(s.id) !== String(excludeId || ""),
        );
      } catch (e) {
        return false;
      }
    },

    // [AUDIT-FIX H2] نفس منطق CustomerRules.isDuplicatePhone/isDuplicateTaxNumber
    // بالضبط، لكن على شيت Suppliers.
    isDuplicatePhone: function (phone, excludeId) {
      var v = String(phone || "").trim();
      if (!v) return false;
      try {
        var suppliers = getSheetData("Suppliers");
        return suppliers.some(
          (s) =>
            String(s.phone || "").trim() === v &&
            String(s.id) !== String(excludeId || ""),
        );
      } catch (e) {
        return false;
      }
    },

    isDuplicateTaxNumber: function (taxNumber, excludeId) {
      var v = String(taxNumber || "").trim();
      if (!v) return false;
      try {
        var suppliers = getSheetData("Suppliers");
        return suppliers.some(
          (s) =>
            String(s.tax_number || "").trim() === v &&
            String(s.id) !== String(excludeId || ""),
        );
      } catch (e) {
        return false;
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 4) قواعد المخزون (Inventory)
  // ════════════════════════════════════════════════════════════════════
  var InventoryRules = {
    // [موجود فعلاً] يعيد استخدام Code_16_Inventory.gs::_checkOutboundStock حرفيًا
    checkSufficientStock: function (tx, stockSnapshot) {
      try {
        return _checkOutboundStock(tx, stockSnapshot); // يعيد null أو رسالة خطأ — نفس العقد الحالي
      } catch (e) {
        return "تعذّر التحقق من رصيد المخزون: " + e.message;
      }
    },

    // [موجود جزئيًا] فحص صلاحية الوصول للمخزن — يعيد استخدام
    // Code_18_Permissions.gs::_checkWarehouseAccess
    isWarehouseTransferAllowed: function (username, warehouseId, sessionToken) {
      try {
        var err = _checkWarehouseAccess(username, warehouseId, sessionToken);
        return !err; // true = مسموح
      } catch (e) {
        return false;
      }
    },

    // [قاعدة جديدة — غير مطبّقة حاليًا] منع بدء جرد جديد أثناء وجود جلسة جرد
    // غير مكتملة لنفس المخزن (postStocktakeSession لا تفحص هذا حاليًا)
    hasOpenStocktakeSession: function (warehouseId) {
      try {
        var sessions = getSheetData("StocktakeSessions");
        return sessions.some(
          (s) =>
            String(s.warehouse_id) === String(warehouseId) &&
            s.status &&
            s.status !== "POSTED" &&
            s.status !== "CANCELLED",
        );
      } catch (e) {
        return false; // الشيت قد لا يكون موجودًا بهذا الاسم دائمًا — لا نمنع افتراضيًا
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 5) قواعد المحاسبة (Accounting)
  // ════════════════════════════════════════════════════════════════════
  var AccountingRules = {
    // [موجود فعلاً] نفس فحص Code_04_Accounting_JournalEntries.gs::updateJournalEntry/deleteJournalEntry
    isJournalPosted: function (entryId) {
      try {
        var rows = readSheet(
          "JournalEntries",
          ACCOUNTING_HR_HEADERS.JournalEntries,
        );
        var e = rows.find((r) => r.id === entryId);
        return !!(e && e.status === "POSTED");
      } catch (err) {
        return true; // الأسلم منع التعديل عند الفشل
      }
    },

    // [موجود فعلاً] يعيد استخدام Code_04_Accounting_JournalEntries.gs::_validateJournalAccountLines
    isJournalBalanced: function (lines) {
      var totalDebit = 0,
        totalCredit = 0;
      (lines || []).forEach(function (l) {
        totalDebit += Number(l.debit || 0);
        totalCredit += Number(l.credit || 0);
      });
      return Math.abs(totalDebit - totalCredit) < 0.01;
    },

    // [موجود فعلاً] يعيد استخدام Code_02_Accounting_ChartOfAccounts.gs::_accountHasTransactions
    accountHasTransactions: function (accountId) {
      try {
        return _accountHasTransactions(accountId);
      } catch (e) {
        return true;
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 6) قواعد المبيعات (Sales)
  // ════════════════════════════════════════════════════════════════════
  var SalesRules = {
    // ملاحظة معمارية: لا توجد دالة updateSaleInvoice في المشروع الحالي —
    // الفاتورة بعد إصدارها تُلغى/تُرتجع بدل التعديل المباشر، لذا هذه القاعدة
    // موثّقة هنا كضمان مستقبلي (Guard) لو أُضيف تعديل مباشر للفواتير لاحقًا.
    isInvoiceLocked: function (invoice) {
      return !!(invoice && invoice.status && invoice.status !== "DRAFT");
    },

    // [موجود فعلاً بشكل جزئي] يعيد استخدام hasStockBalance/hasMovements
    // لمنع بيع صنف غير متاح (لا يوجد رصيد كافٍ في المخزن المطلوب البيع منه)
    isItemAvailableForSale: function (itemId, warehouseId, qty) {
      try {
        var stockRows = getSheetData("Stock").filter(
          (s) =>
            s.item_id === itemId &&
            String(s.warehouse_id) === String(warehouseId),
        );
        var total = stockRows.reduce(
          (sum, r) => sum + Number(r.quantity || 0),
          0,
        );
        return total >= Number(qty || 0);
      } catch (e) {
        return true; // لا نمنع البيع لخطأ فحص غير متوقع — نفس فلسفة الأمان الحالية بالمشروع لمعظم الفحوصات غير الحرجة
      }
    },

    // [قاعدة جديدة — غير مطبّقة حاليًا] منع البيع بسعر أقل من الحد الأدنى
    // إلا بصلاحية خاصة override_min_price (الصلاحية غير موجودة بعد في
    // Code_18_Permissions.gs — يجب إضافتها قبل تفعيل هذه القاعدة فعليًا)
    isBelowMinPrice: function (item, sellPrice) {
      if (
        !item ||
        item.min_price === undefined ||
        item.min_price === null ||
        item.min_price === ""
      ) {
        return false; // لا يوجد حد أدنى معرّف لهذا الصنف
      }
      return Number(sellPrice) < Number(item.min_price);
    },

    canOverrideMinPrice: function (username, sessionToken) {
      try {
        // يعيد استخدام نفس آلية الصلاحيات — يتطلب إضافة مفتاح
        // 'overrideMinPrice' لجدول ROLE_PERMISSIONS لاحقًا ليعمل فعليًا
        var err = _checkPermission(username, "overrideMinPrice", sessionToken);
        return !err;
      } catch (e) {
        return false;
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 7) قواعد المشتريات (Purchases)
  // ════════════════════════════════════════════════════════════════════
  var PurchaseRules = {
    hasSupplier: function (data) {
      return !!(data && data.party);
    },
    hasLines: function (data) {
      return !!(data && Array.isArray(data.lines) && data.lines.length > 0);
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 8) قواعد التصنيع (Manufacturing) — نموذج أول لنقل موديول كامل للمحرك
  // [BRE-ROLLOUT] كل قاعدة هنا منقولة حرفيًا من الفحوصات inline الموجودة
  // فعليًا في Code_17_Manufacturing.gs (deleteWorkCenter / deleteBOM /
  // deleteRouting) — بدون تغيير أي رسالة أو شرط، فقط توحيد المكان.
  // ════════════════════════════════════════════════════════════════════
  var ManufacturingRules = {
    // [موجود فعلاً] من deleteWorkCenter — مركز عمل مرتبط بخطوات تشغيل نشطة
    workCenterHasLinkedOps: function (workCenterId) {
      var ops = readSheet(
        "RoutingOperations",
        ACCOUNTING_HR_HEADERS.RoutingOperations,
      );
      return ops.some(function (o) {
        return String(o.work_center_id) === String(workCenterId);
      });
    },

    // [موجود فعلاً] من deleteWorkCenter — مركز عمل مرتبط بآلات فعلية
    workCenterHasLinkedMachines: function (workCenterId) {
      var machines = readSheet("Machines", ACCOUNTING_HR_HEADERS.Machines);
      return machines.some(function (m) {
        return (
          String(m.work_center_id) === String(workCenterId) && !m.deleted_at
        );
      });
    },

    // [موجود فعلاً] من deleteBOM/deleteRouting — نفس منطق "أمر تصنيع غير مُغلق"
    // مستخدَم مرتين بنسختين منفصلتين (bom_id / routing_id) — دمجناه هنا بدالة
    // واحدة بفلتر مرن بدل تكرار حلقة .some() بنفس الشرط في كل ملف.
    hasOpenLinkedMO: function (linkField, entityId) {
      var mos = readSheet(
        "ManufacturingOrders",
        ACCOUNTING_HR_HEADERS.ManufacturingOrders,
      );
      return mos.some(function (m) {
        return (
          String(m[linkField]) === String(entityId) &&
          !m.deleted_at &&
          m.status !== "closed" &&
          m.status !== "cancelled"
        );
      });
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 9) قواعد المستخدمين (Users)
  // ════════════════════════════════════════════════════════════════════
  var UserRules = {
    // [موجود فعلاً] نفس الفحص الحرفي داخل Code_12_Core.gs::deleteUser
    // [PRIMARY-ADMIN-FLAG] بعد السماح بتغيير اسم المستخدم، الاعتماد على
    // username==="admin" الحرفي بقى غير كافٍ (الاسم ممكن يتغيّر). الفحص
    // بقى عبر عمود is_primary_admin الثابت في شيت Users، وبيرجع لفحص
    // الاسم الحرفي "admin" فقط كـ fallback للصفوف اللي لسه ما اتسجّلتش
    // فيها العلامة صراحةً (بيانات قديمة قبل هذا التحديث).
    isMainAdmin: function (username) {
      try {
        var u = getSheetData("Users").find(function (r) {
          return r.username === username;
        });
        if (!u) return false;
        if (
          u.is_primary_admin === true ||
          String(u.is_primary_admin).toUpperCase() === "TRUE"
        )
          return true;
        if (u.is_primary_admin === "" || u.is_primary_admin == null)
          return username === "admin"; // fallback للبيانات القديمة غير المهاجَرة
        return false;
      } catch (e) {
        return username === "admin"; // الأسلم عند فشل الفحص
      }
    },

    // [قاعدة جديدة — غير موجودة حاليًا في deleteUser] منع حذف المستخدم لنفسه
    isCurrentUser: function (username, callerUsername) {
      return String(username) === String(callerUsername);
    },

    // [قاعدة جديدة — غير موجودة حاليًا] منع إزالة آخر مستخدم نشط بدور admin
    isLastAdminUser: function (username) {
      try {
        var role = _getUserRole(username);
        if (role !== "admin") return false;
        var users = getSheetData("Users");
        // [BUG-FIX] كانت _isActiveUser(u) بتستقبل الـ object كله بدل
        // u.active، و_isActiveUser(active) بتتوقع القيمة الخام فقط
        // (true / "TRUE")؛ فكانت النتيجة دايمًا false لأي مستخدم، فتفضل
        // activeAdmins فاضية دايمًا وactiveAdmins.length<=1 بيرجع true —
        // يعني كان بيمنع حذف أي مستخدم بدور admin نهائيًا، حتى لو فيه
        // أدمنز نشطين كتير.
        var target = users.find((u) => u.username === username);
        // لو المستخدم المطلوب حذفه غير نشط أصلاً، حذفه لن يقلّل عدد
        // الأدمن النشطين — مسموح دايمًا في هذه الحالة.
        if (target && !_isActiveUser(target.active)) return false;
        var activeAdmins = users.filter(
          (u) => _getUserRole(u.username) === "admin" && _isActiveUser(u.active),
        );
        return activeAdmins.length <= 1;
      } catch (e) {
        return true; // الأسلم منع الحذف عند فشل الفحص
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 10) قواعد الخزائن النقدية (CashBoxes) — [BRE-UNIFY-1] منقولة حرفياً من
  // Code_01_Accounting_CashBoxes.gs::deleteCashBox (نفس المنطق، صفر تغيير)
  // ════════════════════════════════════════════════════════════════════
  var CashBoxRules = {
    hasNonZeroBalance: function (cashBoxId) {
      try {
        var rows = getSheetData("CashBoxes");
        var row = rows.find(function (r) {
          return String(r.id) === String(cashBoxId);
        });
        if (!row) return false;
        return Math.abs(Number(row.current_balance || 0)) > 0.001;
      } catch (e) {
        return true; // الأسلم عند الفشل: منع الحذف
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 11) قواعد مراكز التكلفة (CostCenters) — [BRE-UNIFY-1] منقولة حرفياً من
  // Code_43_CostCenters.gs::deleteCostCenter
  // ════════════════════════════════════════════════════════════════════
  var CostCenterRules = {
    hasActiveChildren: function (costCenterId) {
      try {
        var rows = getSheetData("CostCenters");
        return rows.some(function (r) {
          return (
            String(r.parent_id) === String(costCenterId) &&
            r.is_active !== "FALSE" &&
            r.is_active !== false
          );
        });
      } catch (e) {
        return true;
      }
    },
    // ملاحظة: الاستخدام في سطور القيود لا يمنع الحذف فعليًا (تعطيل فقط)،
    // لكنه معلومة تُرفق في رسالة الـ Audit — راجع _fail التعطيل أدناه.
    isUsedInJournalLines: function (costCenterId) {
      try {
        var lines = getSheetData("JournalEntryLines");
        return lines.some(function (l) {
          return l.cost_center_id === costCenterId;
        });
      } catch (e) {
        return false;
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 12) قواعد البنوك والحسابات البنكية — [BRE-UNIFY-1] منقولة حرفياً من
  // Code_09_Banking.gs::deleteBank / deleteBankAccount
  // ════════════════════════════════════════════════════════════════════
  var BankRules = {
    hasLinkedActiveAccounts: function (bankId) {
      try {
        var accounts = getSheetData("BankAccounts");
        return accounts.filter(function (a) {
          return (
            String(a.bank_id) === String(bankId) &&
            a.is_active !== "FALSE" &&
            a.is_active !== false
          );
        }).length;
      } catch (e) {
        return 1; // أي قيمة truthy تمنع الحذف احتياطًا عند الفشل
      }
    },
  };

  var BankAccountRules = {
    hasNonZeroBalance: function (bankAccountId) {
      try {
        var rows = getSheetData("BankAccounts");
        var row = rows.find(function (r) {
          return String(r.id) === String(bankAccountId);
        });
        if (!row) return false;
        return Math.abs(Number(row.current_balance || 0)) > 0.001;
      } catch (e) {
        return true;
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // 13) قواعد الأصول الثابتة (FixedAssets) — [BRE-UNIFY-1] منقولة حرفياً
  // من Code_14_FixedAssets.gs::deleteFixedAsset (فحص الإهلاك فقط — منطق
  // الحذف الفعلي وعكس القيد يبقى في مكانه، خارج نطاق "قاعدة عمل قابلة
  // للاستعلام" البحتة)
  // ════════════════════════════════════════════════════════════════════
  var FixedAssetRules = {
    hasAccumulatedDepreciation: function (assetId) {
      try {
        var rows = getSheetData("FixedAssets");
        var asset = rows.find(function (r) {
          return r.id === assetId && !r.deleted_at;
        });
        if (!asset) return false;
        if (Number(asset.accumulated_depreciation || 0) > 0) return true;
        var journalEntries = getSheetData("JournalEntries");
        var depSuffix = "-" + assetId;
        return journalEntries.some(function (e) {
          return (
            String(e.reference || "").indexOf(depSuffix) !== -1 &&
            String(e.reference || "").indexOf("DEP-") === 0 &&
            e.status !== "CANCELLED" &&
            e.status !== "REVERSED"
          );
        });
      } catch (e) {
        return true;
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  // نقاط الدخول العامة (Public API) — كل شاشة تستدعي هذه فقط
  // ════════════════════════════════════════════════════════════════════

  function validateBeforeDelete(entityType, payload) {
    payload = payload || {};
    switch (entityType) {
      case "item":
        if (ItemRules.hasStockBalance(payload.id)) {
          return _fail(
            "ITEM_HAS_STOCK",
            "لا يمكن حذف صنف له رصيد في المخزون — يرجى تصفير الرصيد أولاً",
          );
        }
        if (ItemRules.hasOpeningBalance(payload.id)) {
          return _fail(
            "ITEM_HAS_OPENING_BALANCE",
            "لا يمكن حذف صنف له رصيد افتتاحي (أول مدة) مسجّل",
          );
        }
        if (ItemRules.hasInvoiceUsage(payload.id)) {
          return _fail(
            "ITEM_HAS_INVOICES",
            "لا يمكن حذف صنف ظهر في فواتير أو مرتجعات بيع/شراء",
          );
        }
        if (ItemRules.hasMovements(payload.id)) {
          return _fail(
            "ITEM_HAS_MOVEMENTS",
            "لا يمكن حذف صنف له حركات مخزون مسجّلة",
          );
        }
        return _ok();

      case "customer":
        if (CustomerRules.hasBalanceOrMovements(payload.id)) {
          return _fail(
            "CUSTOMER_IN_USE",
            "لا يمكن حذف العميل — مرتبط بفواتير أو حركات محاسبية فعلية",
          );
        }
        return _ok();

      case "supplier":
        if (SupplierRules.hasBalanceOrMovements(payload.id)) {
          return _fail(
            "SUPPLIER_IN_USE",
            "لا يمكن حذف المورد — مرتبط بفواتير أو حركات محاسبية فعلية",
          );
        }
        return _ok();

      case "journalEntry":
        if (AccountingRules.isJournalPosted(payload.id)) {
          return _fail(
            "JOURNAL_POSTED",
            "لا يمكن حذف قيد معتمد — قم بإلغاء الاعتماد أولاً",
          );
        }
        // [PERIOD-CLOSING] فحص إغلاق الفترة — لازم بعد فحص POSTED عشان
        // رسالة الخطأ الأدق (قيد معتمد) تظهر الأول لو الاتنين صح
        try {
          if (typeof _blockIfPeriodClosed === "function") {
            var jeRows = readSheet("JournalEntries", ACCOUNTING_HR_HEADERS.JournalEntries, { trimStrings: true });
            var jeRow = jeRows.find(function (r) { return r.id === payload.id; });
            if (jeRow) {
              var jePeriodErr = _blockIfPeriodClosed(jeRow.date, "قيد اليومية");
              if (jePeriodErr) return _fail("PERIOD_CLOSED", jePeriodErr.message);
            }
          }
        } catch (ePeriod) {
          Logger.log("[PERIOD-CLOSING] journalEntry check: " + ePeriod.message);
        }
        return _ok();

      case "chartAccount":
        if (AccountingRules.accountHasTransactions(payload.id)) {
          return _fail(
            "ACCOUNT_HAS_TRANSACTIONS",
            "لا يمكن حذف حساب له حركات مالية",
          );
        }
        return _ok();

      case "workCenter":
        if (ManufacturingRules.workCenterHasLinkedOps(payload.id)) {
          return _fail(
            "WORK_CENTER_HAS_OPS",
            "لا يمكن حذف مركز العمل — مرتبط بخطوات تشغيل (Routing Operations) نشطة",
          );
        }
        if (ManufacturingRules.workCenterHasLinkedMachines(payload.id)) {
          return _fail(
            "WORK_CENTER_HAS_MACHINES",
            "لا يمكن حذف مركز العمل — توجد آلات مرتبطة به",
          );
        }
        return _ok();

      case "bom":
        if (ManufacturingRules.hasOpenLinkedMO("bom_id", payload.id)) {
          return _fail(
            "BOM_LINKED_TO_OPEN_MO",
            "لا يمكن حذف قائمة المكونات — مرتبطة بأمر تصنيع غير مُغلق",
          );
        }
        return _ok();

      case "routing":
        if (ManufacturingRules.hasOpenLinkedMO("routing_id", payload.id)) {
          return _fail(
            "ROUTING_LINKED_TO_OPEN_MO",
            "لا يمكن حذف مسار التصنيع — مرتبط بأمر تصنيع غير مُغلق",
          );
        }
        return _ok();

      case "user":
        if (UserRules.isMainAdmin(payload.username)) {
          return _fail(
            "MAIN_ADMIN_PROTECTED",
            "لا يمكن حذف حساب المدير الرئيسي",
          );
        }
        if (
          payload.callerUsername &&
          UserRules.isCurrentUser(payload.username, payload.callerUsername)
        ) {
          return _fail(
            "CANNOT_DELETE_SELF",
            "لا يمكنك حذف حسابك الحالي أثناء تسجيل الدخول به",
          );
        }
        if (UserRules.isLastAdminUser(payload.username)) {
          return _fail(
            "LAST_ADMIN_PROTECTED",
            "لا يمكن حذف آخر مستخدم يمتلك صلاحية الإدارة (admin) في النظام",
          );
        }
        return _ok();

      case "cashBox":
        if (CashBoxRules.hasNonZeroBalance(payload.id)) {
          return _fail(
            "CASHBOX_HAS_BALANCE",
            "لا يمكن حذف خزينة برصيد حالي — يرجى تصفير الرصيد أولاً عبر سند تحويل أو صرف",
          );
        }
        return _ok();

      case "costCenter":
        if (CostCenterRules.hasActiveChildren(payload.id)) {
          return _fail(
            "COST_CENTER_HAS_CHILDREN",
            "لا يمكن حذف هذا المركز — يوجد مركز تكلفة فرعي مرتبط به",
          );
        }
        // ملاحظة: الاستخدام في سطور القيود لا يمنع الحذف (تعطيل فقط)،
        // لكن details.usedInLines متاحة للاستدعاء ليضيفها للـ Audit Log.
        return _ok({
          usedInLines: CostCenterRules.isUsedInJournalLines(payload.id),
        });

      case "bank":
        var _linkedAccCount = BankRules.hasLinkedActiveAccounts(payload.id);
        if (_linkedAccCount) {
          return _fail(
            "BANK_HAS_LINKED_ACCOUNTS",
            "لا يمكن حذف هذا البنك — يوجد " +
              _linkedAccCount +
              " حساب بنكي مرتبط به. يرجى إلغاء ربط/حذف الحسابات أولاً",
          );
        }
        return _ok();

      case "bankAccount":
        if (BankAccountRules.hasNonZeroBalance(payload.id)) {
          return _fail(
            "BANK_ACCOUNT_HAS_BALANCE",
            "لا يمكن حذف حساب بنكي برصيد حالي — يرجى تصفير الرصيد أولاً",
          );
        }
        return _ok();

      case "fixedAsset":
        if (FixedAssetRules.hasAccumulatedDepreciation(payload.id)) {
          return _fail(
            "FIXED_ASSET_HAS_DEPRECIATION",
            " لا يمكن حذف هذا الأصل — يوجد إهلاك مُرحّل عليه بالفعل. " +
              "يجب عكس/إلغاء كل قيود الإهلاك المرتبطة به أولاً، ثم إعادة المحاولة.",
          );
        }
        return _ok();

      default:
        return _ok(); // كيان غير معروف للمحرك بعد — لا نمنع (توسّع تدريجي)
    }
  }

  // [PARTY-VALIDATION] فحص صيغة الحقول المشتركة بين العملاء والموردين
  // (بريد/رقم ضريبي/رقم قومي أو سجل تجاري حسب نوع الكيان/موقع إلكتروني/
  // نسبة خصم/حد ائتمان). كل الحقول هنا اختيارية بطبيعتها في النموذج — لو
  // القيمة فاضية بيتم تخطي فحصها (نفس فلسفة VF على العميل: "اختياري، لكن
  // لو اتملى لازم يكون بصيغة صحيحة"). صفر تكرار regex: كل التحقق الفعلي
  // مُفوَّض بالكامل لـ ValidationEngine (Code_36) — هذه الدالة فقط تربط
  // النتيجة برسالة عربية وكود ثابت (نفس أسلوب باقي هذا الملف)، وهي خط
  // الدفاع الأخير على السيرفر حتى لو تم تجاوز VF على العميل (نداء مباشر
  // للـ API مثلاً).
  // [ACCT-AUDIT] فحص الحساب المحاسبي المرتبط بالعميل/المورد (account_id) —
  // خط الدفاع الأخير على السيرفر حتى لو تم تجاوز <select> دليل الحسابات في
  // الواجهة (نداء مباشر للـ API مثلاً، أو استيراد جماعي عبر ImportEngine).
  // نفس فلسفة _isUsablePostingAccount (Code_19_PostingConfig.gs) — المستخدمة
  // فعليًا في محرك الترحيل الموحّد لحسابات الإعدادات العامة (ar_account/
  // ap_account...) — بدل تكرار نفس الفحوصات هنا بمنطق مختلف.
  // القواعد:
  //   • الحقل اختياري بطبيعته (فارغ = استخدام حساب الذمم العام من إعدادات
  //     الترحيل) — لو فاضي لا يوجد فحص.
  //   • لو مُدخَل: يجب أن يكون معرف حساب موجود فعليًا في دليل الحسابات.
  //   • يمنع اختيار حساب محذوف (deleted_at) أو موقوف (is_active=false)
  //     أو حساب أب/رئيسي (is_parent=true — الحسابات الرئيسية للعرض والتجميع
  //     فقط، لا يُرحَّل عليها مباشرة أبدًا في أي محرك ترحيل بالنظام).
  //   • يمنع اختيار حساب من نوع غير مناسب: نفس فلسفة الفلتر المستخدم في
  //     renderFinancialAccountSelector بالواجهة (Templates_07.html) —
  //     العميل: ASSET أو بدون نوع محدد. المورد: LIABILITY أو بدون نوع محدد.
  function _validatePartyAccountId(payload, partyType) {
    var accountId = String(payload.account_id || "").trim();
    if (!accountId) {
      // [AUDIT-FIX H3] الواجهة (10_JS_Settings_Search_Parties.html) تُلزم
      // باختيار حساب الذمم عبر requiredSelect، بينما السيرفر كان يقبل
      // account_id فارغ دائمًا — أي مسار حفظ لا يمر بالواجهة (API مباشر/
      // AI Agent) يمكنه إنشاء طرف بلا حساب مرتبط فيفشل الترحيل المحاسبي
      // لاحقًا بصمت. نُطابق الآن نفس إلزام الواجهة، لكن فقط عند الإنشاء
      // (لا يوجد payload.id) حتى لا نكسر حفظ/تعديل أي طرف قديم موجود
      // بالفعل بدون حساب مرتبط (توافق خلفي كامل مع البيانات الحالية).
      if (!payload.id) {
        return _fail(
          "ACCOUNT_REQUIRED",
          partyType === "supplier"
            ? "حساب الذمم الدائنة إلزامي عند إضافة مورد جديد"
            : "حساب الذمم المدينة إلزامي عند إضافة عميل جديد",
        );
      }
      return _ok(); // تعديل طرف قديم بدون حساب — يبقى مسموحًا كما كان
    }

    // [AUDIT-FIX] منع تغيير الحساب المحاسبي المرتبط بطرف له فواتير أو
    // حركات فعلية بالفعل — نفس مبدأ منع الحذف تمامًا (_partyHasUsage)،
    // لأن تغيير الحساب يقسّم تاريخ الطرف المحاسبي بين حسابين مختلفين
    // ويكسر كشف الحساب (getPartyMovements) وتقرير التقادم. يُسمح فقط
    // بإضافة حساب لأول مرة لطرف قديم لم يكن له حساب أصلاً (لا نمنع ذلك،
    // بل نشجعه)، أو تعديل أي حقل آخر بدون لمس account_id إطلاقًا.
    if (payload.id) {
      try {
        var _existing = (getSheetData(
          partyType === "supplier" ? "Suppliers" : "Customers",
        ) || []).find(function (p) {
          return String(p.id) === String(payload.id);
        });
        var _oldAccountId = _existing ? String(_existing.account_id || "").trim() : "";
        if (
          _oldAccountId &&
          _oldAccountId !== accountId &&
          _partyHasUsage(partyType, payload.id)
        ) {
          return _fail(
            "ACCOUNT_CHANGE_BLOCKED",
            "لا يمكن تغيير الحساب المحاسبي المرتبط — هذا الطرف له فواتير أو حركات محاسبية فعلية على الحساب الحالي. غيّر الحساب فقط بعد تصفية الحركات القديمة، أو راجع المحاسب.",
          );
        }
      } catch (e) {
        // فشل الفحص (نادر) — لا نمنع الحفظ بسببه، فقط نتجاهل هذه القاعدة
        // الإضافية ونكتفي بباقي الفحوصات.
      }
    }

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var account = accounts.find(function (a) {
      return String(a.id) === accountId;
    });

    if (!account) {
      return _fail(
        "ACCOUNT_NOT_FOUND",
        "الحساب المحاسبي المحدد غير موجود في دليل الحسابات",
      );
    }
    // فحص عام (محذوف / موقوف / حساب أب) — نفس الدالة المستخدمة فعليًا في
    // محرك إعدادات الترحيل (Code_19_PostingConfig.gs) بدون تكرار منطقها هنا.
    // بدون expectedType في هذه الخطوة لتمييز رسالة الخطأ لكل حالة على حدة
    // (تجربة مستخدم أوضح من رسالة "حساب غير صالح" عامة واحدة).
    if (!_isUsablePostingAccount(account, null)) {
      if (account.deleted_at) {
        return _fail(
          "ACCOUNT_DELETED",
          "لا يمكن اختيار حساب محذوف من دليل الحسابات",
        );
      }
      if (account.is_active === false || account.is_active === "FALSE") {
        return _fail(
          "ACCOUNT_SUSPENDED",
          "لا يمكن اختيار حساب موقوف (غير نشط) من دليل الحسابات",
        );
      }
      return _fail(
        "ACCOUNT_IS_PARENT",
        "لا يمكن اختيار حساب رئيسي (أب) — اختر حسابًا فرعيًا قابلاً للترحيل عليه",
      );
    }
    // فحص النوع: نفس فلسفة فلتر renderFinancialAccountSelector بالواجهة —
    // حساب بدون نوع محدد (NONE) مقبول لأي من الطرفين، وإلا يجب مطابقة
    // النوع المتوقع (ASSET للعميل / LIABILITY للمورد).
    var expectedType = partyType === "supplier" ? "LIABILITY" : "ASSET";
    if (account.type && !_isUsablePostingAccount(account, expectedType)) {
      return _fail(
        "ACCOUNT_TYPE_MISMATCH",
        partyType === "supplier"
          ? "حساب المورد يجب أن يكون من نوع الالتزامات (ذمم دائنة)"
          : "حساب العميل يجب أن يكون من نوع الأصول (ذمم مدينة)",
      );
    }
    return _ok();
  }

  function _validatePartyFieldFormats(payload, partyType) {
    payload = payload || {};
    var acctCheck = _validatePartyAccountId(payload, partyType);
    if (acctCheck.success === false) return acctCheck;
    // [AUDIT-FIX H1] لم يكن هناك أي تحقق من صيغة الهاتف على السيرفر —
    // الفحص كان موجودًا في الواجهة فقط (VF.RULES.phone في
    // 10_JS_Settings_Search_Parties.html)، أي أن أي استدعاء مباشر لـ
    // saveCustomer/saveSupplier (API خارجي، AI Agent، استيراد مستقبلي)
    // كان يتجاوز التحقق بالكامل. نفس مبدأ باقي الحقول تحت (خط دفاع أخير
    // على السيرفر). phone2/contact_phone اختياريان أصلاً فالفحص يتجاهلهما
    // لو فارغين دون تأثير على أي بيانات موجودة سابقًا.
    if (payload.phone && !ValidationEngine.isValidPhoneGeneric(payload.phone)) {
      return _fail("INVALID_PHONE", "صيغة رقم الهاتف غير صحيحة");
    }
    if (
      payload.phone2 &&
      !ValidationEngine.isValidPhoneGeneric(payload.phone2)
    ) {
      return _fail("INVALID_PHONE2", "صيغة الهاتف الإضافي غير صحيحة");
    }
    if (
      payload.contact_phone &&
      !ValidationEngine.isValidPhoneGeneric(payload.contact_phone)
    ) {
      return _fail(
        "INVALID_CONTACT_PHONE",
        "صيغة هاتف شخص الاتصال غير صحيحة",
      );
    }
    if (payload.email && !ValidationEngine.isValidEmail(payload.email)) {
      return _fail("INVALID_EMAIL", "صيغة البريد الإلكتروني غير صحيحة");
    }
    if (
      payload.tax_number &&
      !ValidationEngine.isValidTaxNumber(payload.tax_number)
    ) {
      return _fail(
        "INVALID_TAX_NUMBER",
        "الرقم الضريبي غير صحيح (يجب أن يكون 9 أرقام)",
      );
    }
    if (payload.national_id) {
      // national_id يحمل رقمًا قوميًا للأفراد أو رقم سجل تجاري للشركات —
      // النوع المطلوب يتحدد من entity_type (راجع تعليق PARTY_EXTRA_HEADERS_MD
      // في Code_20_Sales.gs).
      var isCompanyEntity = payload.entity_type === "شركة";
      var validNat = isCompanyEntity
        ? ValidationEngine.isValidCommercialRegistration(payload.national_id)
        : ValidationEngine.isValidNationalId(payload.national_id);
      if (!validNat) {
        return _fail(
          "INVALID_NATIONAL_ID",
          isCompanyEntity
            ? "رقم السجل التجاري غير صحيح"
            : "الرقم القومي غير صحيح",
        );
      }
    }
    if (payload.website && !ValidationEngine.isValidUrl(payload.website)) {
      return _fail(
        "INVALID_URL",
        "صيغة الموقع الإلكتروني غير صحيحة (يجب أن تبدأ بـ http:// أو https://)",
      );
    }
    if (
      payload.discount_percent !== undefined &&
      payload.discount_percent !== null &&
      payload.discount_percent !== "" &&
      !ValidationEngine.isValidPercentage(payload.discount_percent)
    ) {
      return _fail("INVALID_DISCOUNT", "نسبة الخصم يجب أن تكون بين 0 و100");
    }
    // حد الائتمان — عملاء فقط (لا يوجد عمود credit_limit للموردين أصلاً)،
    // لكن الفحص هنا عام وآمن حتى لو وصل الحقل لمورد بالخطأ (بيتجاهل ببساطة
    // لو undefined).
    if (
      payload.credit_limit !== undefined &&
      payload.credit_limit !== null &&
      payload.credit_limit !== "" &&
      !ValidationEngine.isValidCurrency(payload.credit_limit)
    ) {
      return _fail(
        "INVALID_CREDIT_LIMIT",
        "حد الائتمان يجب أن يكون رقمًا صحيحًا غير سالب",
      );
    }
    return _ok();
  }

  function validateBeforeSave(entityType, payload) {
    payload = payload || {};
    switch (entityType) {
      case "item":
        // [AUDIT-FIX NAME-REQ] updateItem كانت تعتمد فقط على هذا الفحص
        // ولم يكن يتحقق من الاسم إطلاقًا (كان الفحص موجودًا يدويًا فقط
        // داخل addItem) — تم توحيد الفحص هنا ليغطي الإضافة والتعديل معًا.
        if (!String(payload.name || "").trim()) {
          return _fail("NAME_REQUIRED", "اسم الصنف إلزامي");
        }
        if (ItemRules.hasNegativePrice(payload)) {
          return _fail(
            "NEGATIVE_PRICE",
            "لا يمكن أن يكون سعر الصنف قيمة سالبة",
          );
        }
        if (ItemRules.isDuplicateCode(payload.code, payload.id)) {
          return _fail("DUPLICATE_CODE", "كود الصنف موجود مسبقاً");
        }
        if (ItemRules.isDuplicateBarcode(payload.barcode, payload.id)) {
          return _fail("DUPLICATE_BARCODE", "الباركود مستخدم بالفعل لصنف آخر");
        }
        // [ACC-FIELD-FILTER-2026-08-08] فحص حسابات تبويب "الحسابات" —
        // خط دفاع بالسيرفر مقابل فلترة الواجهة (03_JS_Dashboard_Items.html).
        var _invalidAcc = ItemRules.findInvalidAccountField(payload);
        if (_invalidAcc) {
          return _fail(_invalidAcc.code, _invalidAcc.message);
        }
        return _ok();

      case "purchaseInvoice":
        if (!PurchaseRules.hasSupplier(payload)) {
          return _fail("NO_SUPPLIER", "لا يمكن اعتماد فاتورة شراء بدون مورد");
        }
        if (!PurchaseRules.hasLines(payload)) {
          return _fail("NO_LINES", "لا يمكن اعتماد فاتورة شراء بدون أصناف");
        }
        return _ok();

      // [CODE-REQUIRED] الكود بقى إلزاميًا وأساسيًا (فريد) لكل عميل — نفس
      // فلسفة ItemRules.isDuplicateCode أعلاه بالضبط (case "item").
      case "customer": {
        // [AUDIT-FIX NAME-REQ] لم يكن هناك أي تحقق من اسم العميل — كان
        // بالإمكان حفظ عميل باسم فارغ تمامًا طالما وُجد كود صالح.
        if (!String(payload.name || "").trim()) {
          return _fail("NAME_REQUIRED", "اسم العميل إلزامي");
        }
        if (!String(payload.code || "").trim()) {
          return _fail("CODE_REQUIRED", "كود العميل إلزامي");
        }
        if (CustomerRules.isDuplicateCode(payload.code, payload.id)) {
          return _fail(
            "DUPLICATE_CODE",
            "كود العميل مستخدم بالفعل لعميل آخر",
          );
        }
        // [AUDIT-FIX H2] منع تكرار الهاتف/الرقم الضريبي بين العملاء
        if (CustomerRules.isDuplicatePhone(payload.phone, payload.id)) {
          return _fail(
            "DUPLICATE_PHONE",
            "رقم الهاتف مستخدم بالفعل لعميل آخر",
          );
        }
        if (
          CustomerRules.isDuplicateTaxNumber(payload.tax_number, payload.id)
        ) {
          return _fail(
            "DUPLICATE_TAX_NUMBER",
            "الرقم الضريبي مستخدم بالفعل لعميل آخر",
          );
        }
        // ═══════════════════════════════════════════════════════════
        // [CUST-SETTINGS-2026-08-07] فحوصات مربوطة فعليًا بـ
        // CustomerSettingsEngine (Code_58_CustomerSettingsEngine.js) —
        // كل فحص هنا بيتفعّل/يتعطّل من شاشة "إعدادات العملاء" مباشرة،
        // بدون أي تعديل كود. لو الـ Engine غير متاح لأي سبب (فشل تحميل)،
        // كل الفحوصات دي بتتجاهل بأمان (نفس السلوك القديم قبل هذا التعديل).
        // ═══════════════════════════════════════════════════════════
        if (typeof CustomerSettingsEngine !== "undefined") {
          // [AUDIT-FIX CUST-29] customer_entry_require_phone كان مفتاح
          // منفصل معروض في تاب "الحقول الإجبارية" بس متجاهَل تمامًا —
          // الفحص القديم كان بيعتمد على allow_customer_without_phone
          // بس. دلوقتي نفس نمط المورد بالظبط (راجع case "supplier" تحت):
          // الهاتف بقى إجباري لو allow_customer_without_phone=false
          // *و* customer_entry_require_phone=true معًا.
          if (
            !CustomerSettingsEngine.get("allow_customer_without_phone") &&
            CustomerSettingsEngine.get("customer_entry_require_phone") &&
            !String(payload.phone || "").trim()
          ) {
            return _fail("PHONE_REQUIRED", "رقم الهاتف إلزامي لإنشاء عميل");
          }
          // [AUDIT-FIX CUST-29] فحص طول رقم الهاتف (customer_entry_phone_
          // digits) — كان مُعرَّفًا في الإعدادات ومعروضًا في الشاشة بدون
          // أي فحص فعلي. بيتفعّل فقط لو فيه رقم مُدخَل فعلاً (مش فحص
          // إلزامية، ده منفصل فوق).
          if (
            String(payload.phone || "").trim() &&
            Number(CustomerSettingsEngine.get("customer_entry_phone_digits") || 0) > 0 &&
            String(payload.phone).trim().length !==
              Number(CustomerSettingsEngine.get("customer_entry_phone_digits"))
          ) {
            return _fail(
              "PHONE_DIGITS_MISMATCH",
              "رقم الهاتف يجب أن يتكون من " +
                CustomerSettingsEngine.get("customer_entry_phone_digits") +
                " رقمًا",
            );
          }
          if (
            !CustomerSettingsEngine.get("allow_duplicate_customer_name") &&
            CustomerRules.isDuplicateName(payload.name, payload.id)
          ) {
            return _fail(
              "DUPLICATE_NAME",
              "اسم العميل مستخدم بالفعل لعميل آخر",
            );
          }
          if (
            CustomerSettingsEngine.get("require_email") &&
            !String(payload.email || "").trim()
          ) {
            return _fail("EMAIL_REQUIRED", "البريد الإلكتروني إلزامي لإنشاء عميل");
          }
          if (
            CustomerSettingsEngine.get("require_address") &&
            !String(payload.address || "").trim()
          ) {
            return _fail("ADDRESS_REQUIRED", "العنوان إلزامي لإنشاء عميل");
          }
          if (
            CustomerSettingsEngine.get("customer_entry_require_address") &&
            !String(payload.address || "").trim()
          ) {
            return _fail("ADDRESS_REQUIRED", "العنوان إلزامي لإنشاء عميل");
          }
          if (
            CustomerSettingsEngine.get("require_tax_number") &&
            !String(payload.tax_number || "").trim()
          ) {
            return _fail(
              "TAX_NUMBER_REQUIRED",
              "الرقم الضريبي إلزامي لإنشاء عميل",
            );
          }
          if (
            CustomerSettingsEngine.get("require_customer_type") &&
            !String(payload.entity_type || "").trim()
          ) {
            return _fail(
              "CUSTOMER_TYPE_REQUIRED",
              "نوع العميل إلزامي لإنشاء عميل",
            );
          }
          // ═══════════════════════════════════════════════════════════
          // [CUST-SETTINGS-2026-08-08] "الحقول الإجبارية للإدخال للعملاء"
          // — تاب customer_fields في شاشة إعدادات العملاء والموردين.
          // نفس مبدأ الفحوصات فوق بالضبط: كل واحد منها بيتفعّل/يتعطّل من
          // الشاشة مباشرة، بدون أي تعديل كود.
          // ═══════════════════════════════════════════════════════════
          if (
            CustomerSettingsEngine.get("customer_entry_require_group_name") &&
            !String(payload.group_name || "").trim()
          ) {
            return _fail("GROUP_NAME_REQUIRED", "اسم المجموعة إلزامي لإنشاء عميل");
          }
          // [CUST-SETTINGS-WIRE-2026-08-08] customer_groups / customer_types —
          // كانت القائمتين محفوظتين ومعروضتين في الشاشة (لملء قوائم Dropdown)
          // بدون أي تحقق فعلي إن القيمة المُرسَلة من الواجهة (أو أي API
          // مباشر) فعلاً ضمن القائمة المُعتمدة — يعني كان ممكن يتبعت
          // group_name/entity_type عشوائي مش موجود في تعريفات النظام.
          if (String(payload.group_name || "").trim()) {
            var _validGroupKeys = (CustomerSettingsEngine.get("customer_groups") || []).map(
              function (g) {
                return g && g.key;
              },
            );
            if (_validGroupKeys.indexOf(String(payload.group_name).trim()) === -1) {
              return _fail(
                "INVALID_GROUP_NAME",
                "مجموعة العميل غير معرّفة في إعدادات العملاء",
              );
            }
          }
          // [CUST-SETTINGS-AUDIT-NOTE-2026-08-08] customer_types — *لم*
          // يُضَف هنا فحص مطابقة entity_type لقائمة customer_types عمدًا.
          // اكتشفت أثناء الإصلاح تضاربًا موجودًا بالفعل في الكود: عمود
          // entity_type مُوثَّق في HEADERS (Code_20a_Parties.js:68) كـ
          // "فرد | شركة" (يعني المفروض يطابق مفاتيح customer_types زي
          // individual/company)، لكن fallback الإعداد الافتراضي الحالي
          // (default_new_customer_nature/default_new_supplier_nature،
          // سطر ~1411) بيملأ نفس الحقل بقيم "cash"/"credit" (طبيعة
          // العميل نقدي/آجل) لو المستخدم سابه فاضي. لو ضفت فحص هنا ضد
          // customer_types هيرفض أي عميل اتملى تلقائيًا بـ cash/credit
          // من الـ fallback ده — يعني هعطّل عملية الحفظ العادية بدل
          // ما أصلح Setting. القرار محتاج منك: هل entity_type المفروض
          // يبقى نوع العميل (فرد/شركة) ولا طبيعته (نقدي/آجل)؟ الحقلين
          // مختلفين فعليًا ومحتاجين عمود منفصل لكل واحد.
          if (
            CustomerSettingsEngine.get("customer_entry_require_party_category") &&
            !String(payload.category_id || "").trim()
          ) {
            return _fail("PARTY_CATEGORY_REQUIRED", "جهة التعامل إلزامية لإنشاء عميل");
          }
          if (
            CustomerSettingsEngine.get("customer_entry_require_photo") &&
            !String(payload.image_url || "").trim()
          ) {
            return _fail("PHOTO_REQUIRED", "صورة العميل إلزامية لإنشاء عميل");
          }
          if (
            CustomerSettingsEngine.get("customer_entry_require_id_number") &&
            !String(payload.national_id || "").trim()
          ) {
            return _fail("ID_NUMBER_REQUIRED", "رقم الهوية إلزامي لإنشاء عميل");
          }
          // [AUDIT-FIX CUST-29] فحص طول رقم الهوية (customer_entry_id_digits)
          if (
            String(payload.national_id || "").trim() &&
            Number(CustomerSettingsEngine.get("customer_entry_id_digits") || 0) > 0 &&
            String(payload.national_id).trim().length !==
              Number(CustomerSettingsEngine.get("customer_entry_id_digits"))
          ) {
            return _fail(
              "ID_DIGITS_MISMATCH",
              "رقم الهوية يجب أن يتكون من " +
                CustomerSettingsEngine.get("customer_entry_id_digits") +
                " رقمًا",
            );
          }
          if (
            CustomerSettingsEngine.get("customer_entry_require_shipping_company") &&
            !String(payload.default_shipping_company_id || "").trim()
          ) {
            return _fail("SHIPPING_COMPANY_REQUIRED", "شركة الشحن إلزامية لإنشاء عميل");
          }
        }
        // [PARTY-VALIDATION] فحص صيغة باقي الحقول (بريد/رقم ضريبي/رقم
        // قومي/موقع إلكتروني/نسبة خصم/حد ائتمان) — خط دفاع أخير على
        // السيرفر بعد VF على العميل.
        var custFieldCheck = _validatePartyFieldFormats(payload, "customer");
        if (custFieldCheck.success === false) return custFieldCheck;
        return _ok();
      }

      // [PARITY-CUST] كود المورد بقى إلزاميًا وفريدًا بنفس مبدأ كود العميل
      // تمامًا (SUPPLIER_HEADERS بقى فيه عمود code — راجع Code_20_Sales.gs).
      // مبدأ العمل المختلف: كود المورد بيتربط بحساب ذمم دائنة بدل مدينة.
      case "supplier": {
        // [AUDIT-FIX NAME-REQ] نفس الفجوة الموجودة في العميل: لا تحقق من
        // الاسم إطلاقًا قبل هذا الإصلاح.
        if (!String(payload.name || "").trim()) {
          return _fail("NAME_REQUIRED", "اسم المورد إلزامي");
        }
        if (!String(payload.code || "").trim()) {
          return _fail("CODE_REQUIRED", "كود المورد إلزامي");
        }
        if (SupplierRules.isDuplicateCode(payload.code, payload.id)) {
          return _fail(
            "DUPLICATE_CODE",
            "كود المورد مستخدم بالفعل لمورد آخر",
          );
        }
        // [AUDIT-FIX H2] منع تكرار الهاتف/الرقم الضريبي بين الموردين
        if (SupplierRules.isDuplicatePhone(payload.phone, payload.id)) {
          return _fail(
            "DUPLICATE_PHONE",
            "رقم الهاتف مستخدم بالفعل لمورد آخر",
          );
        }
        if (
          SupplierRules.isDuplicateTaxNumber(payload.tax_number, payload.id)
        ) {
          return _fail(
            "DUPLICATE_TAX_NUMBER",
            "الرقم الضريبي مستخدم بالفعل لمورد آخر",
          );
        }
        // ═══════════════════════════════════════════════════════════
        // [CUST-SETTINGS-2026-08-08] "الحقول الإجبارية للإدخال للموردين"
        // — تاب supplier_fields في شاشة إعدادات العملاء والموردين. نفس
        // مبدأ فحوصات العميل فوق بالضبط.
        // ═══════════════════════════════════════════════════════════
        if (typeof CustomerSettingsEngine !== "undefined") {
          if (
            !CustomerSettingsEngine.get("allow_customer_without_phone") &&
            CustomerSettingsEngine.get("supplier_entry_require_phone") &&
            !String(payload.phone || "").trim()
          ) {
            return _fail("PHONE_REQUIRED", "رقم الهاتف إلزامي لإنشاء مورد");
          }
          // [AUDIT-FIX CUST-29] فحص طول رقم الهاتف (supplier_entry_phone_digits)
          if (
            String(payload.phone || "").trim() &&
            Number(CustomerSettingsEngine.get("supplier_entry_phone_digits") || 0) > 0 &&
            String(payload.phone).trim().length !==
              Number(CustomerSettingsEngine.get("supplier_entry_phone_digits"))
          ) {
            return _fail(
              "PHONE_DIGITS_MISMATCH",
              "رقم الهاتف يجب أن يتكون من " +
                CustomerSettingsEngine.get("supplier_entry_phone_digits") +
                " رقمًا",
            );
          }
          if (
            CustomerSettingsEngine.get("supplier_entry_require_address") &&
            !String(payload.address || "").trim()
          ) {
            return _fail("ADDRESS_REQUIRED", "العنوان إلزامي لإنشاء مورد");
          }
          if (
            CustomerSettingsEngine.get("supplier_entry_require_group_name") &&
            !String(payload.group_name || "").trim()
          ) {
            return _fail("GROUP_NAME_REQUIRED", "اسم المجموعة إلزامي لإنشاء مورد");
          }
          if (
            CustomerSettingsEngine.get("supplier_entry_require_party_category") &&
            !String(payload.category_id || "").trim()
          ) {
            return _fail("PARTY_CATEGORY_REQUIRED", "جهة التعامل إلزامية لإنشاء مورد");
          }
          if (
            CustomerSettingsEngine.get("supplier_entry_require_photo") &&
            !String(payload.image_url || "").trim()
          ) {
            return _fail("PHOTO_REQUIRED", "صورة المورد إلزامية لإنشاء مورد");
          }
          if (
            CustomerSettingsEngine.get("supplier_entry_require_id_number") &&
            !String(payload.national_id || "").trim()
          ) {
            return _fail("ID_NUMBER_REQUIRED", "رقم الهوية إلزامي لإنشاء مورد");
          }
          // [AUDIT-FIX CUST-29] فحص طول رقم الهوية (supplier_entry_id_digits)
          if (
            String(payload.national_id || "").trim() &&
            Number(CustomerSettingsEngine.get("supplier_entry_id_digits") || 0) > 0 &&
            String(payload.national_id).trim().length !==
              Number(CustomerSettingsEngine.get("supplier_entry_id_digits"))
          ) {
            return _fail(
              "ID_DIGITS_MISMATCH",
              "رقم الهوية يجب أن يتكون من " +
                CustomerSettingsEngine.get("supplier_entry_id_digits") +
                " رقمًا",
            );
          }
        }
        return _validatePartyFieldFormats(payload, "supplier");
      }

      default:
        return _ok();
    }
  }

  function validateBeforeApprove(entityType, payload) {
    payload = payload || {};
    switch (entityType) {
      case "purchaseInvoice":
        return validateBeforeSave("purchaseInvoice", payload);
      default:
        return _ok();
    }
  }

  function validateBeforePost(entityType, payload) {
    payload = payload || {};
    switch (entityType) {
      case "journalEntry":
        if (!AccountingRules.isJournalBalanced(payload.lines)) {
          return _fail(
            "JOURNAL_UNBALANCED",
            "لا يمكن ترحيل قيد غير متوازن (مجموع المدين ≠ مجموع الدائن)",
          );
        }
        return _ok();
      default:
        return _ok();
    }
  }

  function validateBeforeInventoryIssue(payload) {
    payload = payload || {};
    var err = InventoryRules.checkSufficientStock(
      payload.tx,
      payload.stockSnapshot,
    );
    if (err) {
      return _fail("INSUFFICIENT_STOCK", err);
    }
    return _ok();
  }

  function validateBeforeJournalEntry(payload) {
    payload = payload || {};
    if (!AccountingRules.isJournalBalanced(payload.lines)) {
      return _fail(
        "JOURNAL_UNBALANCED",
        "لا يمكن حفظ قيد غير متوازن (مجموع المدين ≠ مجموع الدائن)",
      );
    }
    return _ok();
  }

  // ── واجهة عامة إضافية لقواعد لا تندرج تحت الأفعال الخمسة أعلاه مباشرة ──
  function checkCreditLimit(customer, invoiceTotal) {
    if (CustomerRules.exceedsCreditLimit(customer, invoiceTotal)) {
      return _fail(
        "CREDIT_LIMIT_EXCEEDED",
        "العملية تتجاوز حد الائتمان المسموح به لهذا العميل",
      );
    }
    return _ok();
  }

  function checkMinSalePrice(item, sellPrice, username, sessionToken) {
    if (!SalesRules.isBelowMinPrice(item, sellPrice)) return _ok();
    if (SalesRules.canOverrideMinPrice(username, sessionToken)) {
      return _warn(
        "MIN_PRICE_OVERRIDDEN",
        "تم البيع بسعر أقل من الحد الأدنى بصلاحية خاصة",
      );
    }
    return _fail(
      "BELOW_MIN_PRICE",
      "لا يمكن البيع بسعر أقل من الحد الأدنى المسموح به لهذا الصنف",
    );
  }

  return {
    // نقاط الدخول الأساسية المطلوبة في المهمة
    validateBeforeDelete: validateBeforeDelete,
    validateBeforeSave: validateBeforeSave,
    validateBeforeApprove: validateBeforeApprove,
    validateBeforePost: validateBeforePost,
    validateBeforeInventoryIssue: validateBeforeInventoryIssue,
    validateBeforeJournalEntry: validateBeforeJournalEntry,

    // نقاط دخول إضافية لقواعد لا تُشكّل حذف/حفظ/اعتماد/ترحيل مباشر
    checkCreditLimit: checkCreditLimit,
    checkMinSalePrice: checkMinSalePrice,

    // الوصول لمجموعات القواعد الخام — لاستخدامها مباشرة عند الحاجة لتفاصيل
    // أدق من نتيجة true/false الموحّدة (مثال: شاشة تريد تلوين تحذير وليس منعًا)
    rules: {
      Item: ItemRules,
      Customer: CustomerRules,
      Supplier: SupplierRules,
      Inventory: InventoryRules,
      Accounting: AccountingRules,
      Sales: SalesRules,
      Purchase: PurchaseRules,
      Manufacturing: ManufacturingRules,
      User: UserRules,
      CashBox: CashBoxRules,
      CostCenter: CostCenterRules,
      Bank: BankRules,
      BankAccount: BankAccountRules,
      FixedAsset: FixedAssetRules,
    },
  };
})();
