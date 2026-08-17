// ═══════════════════════════════════════════════════════════════════
// Code_26_ReportDataLayer.gs — طبقة الاستعلام الموحّدة للتقارير
// (Data Query Layer + Filter Engine — سيرفر-سايد)
// ═══════════════════════════════════════════════════════════════════
// [REPORTS-P1] المشكلة اللي بيحلها هذا الملف:
//   قبل كده، كل تقرير (renderSalesSummaryReport, renderStockValuationReport...)
//   كان بينده getSaleInvoices/getStock/... من غير أي فلتر، يجيب الشيت
//   كامل، وبعدين يفلتر بـ Array.filter() في المتصفح. ده معناه:
//     - نفس منطق الفلترة (بالتاريخ/العميل/الصنف...) مكرر في كل شاشة.
//     - أي تقرير جديد لازم يكتب فلترة/تجميع/ترتيب من الصفر.
//     - الشبكة بتنقل الشيت كامل حتى لو المطلوب صف واحد.
//
// الحل: دالة واحدة queryReportEntity(entityKey, filters, options, ...)
// بتاخد اسم الكيان (sale_invoices, purchase_invoices, stock, items...)
// ومجموعة فلاتر موحّدة الأسماء (dateFrom/dateTo/partyId/itemId/status/...)
// وترجع بيانات مفلترة + مرتّبة + Paginated من السيرفر — صفحة واحدة بس
// بترجع للمتصفح مش الشيت كامل.
//
// أي موديول جديد يضيف تقرير: يسجّل الكيان بتاعه في ENTITY_REGISTRY تحت
// (سطر واحد لكل حقل قابل للفلترة) — من غير ما يكتب أي منطق فلترة بنفسه.
// ═══════════════════════════════════════════════════════════════════

/**
 * ENTITY_REGISTRY — مصدر الحقيقة الوحيد لأي كيان يمكن الاستعلام عنه
 * من التقارير. كل مدخل يوصف:
 *   sheet         : اسم الشيت الفعلي
 *   headers       : الأعمدة (لو الشيت الأصلي بيستخدم *_HEADERS ثابتة استخدمها هنا)
 *   parseJson     : أعمدة JSON تتفك تلقائيًا (زي lines_json)
 *   permission    : اسم صلاحية viewReports/viewSaleInvoices... تتفحص قبل القراءة
 *   dateField     : اسم عمود التاريخ المستخدم لفلتر (من - إلى)
 *   filterFields  : خريطة filterKey -> اسم العمود الفعلي في الشيت
 *                   (ده اللي بيسمح بفلتر موحّد بنفس الأسماء لكل الكيانات
 *                   حتى لو أسماء الأعمدة الحقيقية مختلفة بين شيت وشيت)
 *   searchFields  : أعمدة نصية يشملها بحث نصي عام (q)
 */
var ENTITY_REGISTRY = {
  sale_invoices: {
    sheet: "SaleInvoices",
    headers: (typeof SALE_INVOICE_HEADERS !== "undefined") ? SALE_INVOICE_HEADERS : null,
    parseJson: ["lines_json"],
    permission: "viewSaleInvoices",
    dateField: "date",
    filterFields: {
      partyId: "party_id",
      status: "status",
      paymentStatus: "payment_status",
      shippingCompanyId: "shipping_company_id",
    },
    searchFields: ["party", "id", "permit_id"],
  },
  purchase_invoices: {
    sheet: "PurchaseInvoices",
    headers: (typeof PURCHASE_INVOICE_HEADERS !== "undefined") ? PURCHASE_INVOICE_HEADERS : null,
    parseJson: ["lines_json"],
    permission: "viewPurchaseInvoices",
    dateField: "date",
    filterFields: {
      partyId: "party_id",
      status: "status",
      paymentStatus: "payment_status",
    },
    searchFields: ["party", "id"],
  },
  journal_entries: {
    sheet: "JournalEntryLines",
    headers: null,
    parseJson: [],
    permission: "viewReports",
    dateField: "date",
    filterFields: {
      accountId: "account_id",
      costCenterId: "cost_center_id",
      branchId: "branch_id",
      projectId: "project_id",
    },
    searchFields: ["description", "entry_id"],
  },
};

/**
 * queryReportEntity — نقطة الدخول الموحّدة لأي تقرير.
 *
 * @param {string} entityKey   مفتاح الكيان من ENTITY_REGISTRY (مثال: "sale_invoices")
 * @param {object} filters     { dateFrom, dateTo, q, ...filterFields المسجّلة للكيان }
 * @param {object} options     { page (1-based), pageSize, sortBy, sortDir: "asc"|"desc" }
 * @param {string} callerUser
 * @param {string} sessionToken
 * @returns {{success:boolean, data:Array, total:number, page:number, pageSize:number, message?:string}}
 */
function queryReportEntity(entityKey, filters, options, callerUser, sessionToken) {
  try {
    var entity = ENTITY_REGISTRY[entityKey];
    if (!entity) {
      return { success: false, message: "كيان غير مسجّل: " + entityKey };
    }

    var permErr = _checkPermission(callerUser, entity.permission, sessionToken);
    if (permErr) return permErr;

    filters = filters || {};
    options = options || {};
    var page = Math.max(1, parseInt(options.page, 10) || 1);
    var pageSize = Math.min(1000, Math.max(1, parseInt(options.pageSize, 10) || 50));

    var readOpts = {};
    if (entity.parseJson && entity.parseJson.length) readOpts.parseJson = entity.parseJson;

    var rows = entity.headers
      ? readSheet(entity.sheet, entity.headers, readOpts)
      : readSheet(entity.sheet, undefined, readOpts);

    rows = cleanArr(rows);

    // استبعاد المحذوف Soft-delete (لو الكيان بيستخدم الحقل ده)
    rows = rows.filter(function (r) {
      return !r.deleted_at;
    });

    // ── فلتر الفترة الزمنية (موحّد لكل الكيانات) ──
    if (entity.dateField && (filters.dateFrom || filters.dateTo)) {
      rows = rows.filter(function (r) {
        var v = r[entity.dateField];
        if (!v) return true;
        var d = String(v).substring(0, 10);
        if (filters.dateFrom && d < filters.dateFrom) return false;
        if (filters.dateTo && d > filters.dateTo) return false;
        return true;
      });
    }

    // ── فلاتر الحقول المسجّلة للكيان (partyId/status/accountId/...) ──
    Object.keys(entity.filterFields || {}).forEach(function (filterKey) {
      var value = filters[filterKey];
      if (value === undefined || value === null || value === "") return;
      var column = entity.filterFields[filterKey];
      rows = rows.filter(function (r) {
        return String(r[column] === undefined || r[column] === null ? "" : r[column]) === String(value);
      });
    });

    // ── بحث نصي عام (q) عبر searchFields ──
    if (filters.q) {
      var needle = String(filters.q).trim().toLowerCase();
      if (needle) {
        rows = rows.filter(function (r) {
          return (entity.searchFields || []).some(function (f) {
            return String(r[f] || "").toLowerCase().indexOf(needle) !== -1;
          });
        });
      }
    }

    var total = rows.length;

    // ── الترتيب ──
    if (options.sortBy) {
      var sortDir = options.sortDir === "desc" ? -1 : 1;
      var sortBy = options.sortBy;
      rows.sort(function (a, b) {
        var av = a[sortBy], bv = b[sortBy];
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * sortDir;
      });
    }

    // ── Pagination (سيرفر-سايد — الصفحة المطلوبة بس هي اللي بترجع) ──
    var start = (page - 1) * pageSize;
    var pageRows = rows.slice(start, start + pageSize);

    return {
      success: true,
      data: pageRows,
      total: total,
      page: page,
      pageSize: pageSize,
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * queryReportAggregate — نفس فلاتر queryReportEntity لكن بترجع تجميع
 * (Group By + Sum) بدل الصفوف الخام — للاستخدام في تقارير الملخصات
 * (ملخص مبيعات، مبيعات حسب عميل/صنف...) بدل ما كل تقرير يكتب حلقة
 * تجميع بنفسه.
 *
 * @param {string} entityKey
 * @param {object} filters      نفس filters بتاعة queryReportEntity (بدون pagination)
 * @param {object} aggOptions   { groupBy: "party_id", sumFields: ["net_total"], countField: true }
 */
function queryReportAggregate(entityKey, filters, aggOptions, callerUser, sessionToken) {
  try {
    var full = queryReportEntity(
      entityKey,
      filters,
      { page: 1, pageSize: 100000 }, // كل الصفوف المطابقة للفلتر (بدون صفحات) للتجميع
      callerUser,
      sessionToken,
    );
    if (!full.success) return full;

    aggOptions = aggOptions || {};
    var groupBy = aggOptions.groupBy;
    var sumFields = aggOptions.sumFields || [];
    var groups = {};

    full.data.forEach(function (r) {
      var key = groupBy ? String(r[groupBy] === undefined ? "—" : r[groupBy]) : "_all_";
      if (!groups[key]) {
        groups[key] = { key: key, count: 0 };
        sumFields.forEach(function (f) {
          groups[key][f] = 0;
        });
      }
      groups[key].count++;
      sumFields.forEach(function (f) {
        groups[key][f] += parseFloat(r[f] || 0);
      });
    });

    return {
      success: true,
      data: Object.keys(groups).map(function (k) {
        return groups[k];
      }),
      totalRows: full.total,
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
