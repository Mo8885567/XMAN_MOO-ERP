// ══════════════════════════════════════════════════════════════════════════
// Code_38_RepositoryLayer.gs — طبقة الـ Repository لكل موديول
// ──────────────────────────────────────────────────────────────────────────
// الفجوة (من تقرير المراجعة، القسم 1، بند 2): طبقة القراءة/الكتابة
// الموحّدة (Code_34_DataLayerEngine.gs) موجودة، لكنها "عامة" — بتاخد اسم
// الجدول كنص في كل نداء (DataLayer.getAll("Customers", ...)). المطلوب هو
// كائن Repository مُسمّى لكل كيان (Repositories.Customers.getAll()) بدل
// تكرار اسم الجدول والـ headers في كل نقطة استخدام عبر المشروع، ونقطة
// دخول واحدة موثّقة لكل الكيانات بدل ما يفتح كل ملف Sheet بنفسه.
//
// [REPOSITORY-DESIGN]
//   - هذا الملف لا يستبدل ولا يغيّر أي دالة قراءة/كتابة موجودة حاليًا في
//     أي موديول — الدوال الحالية (getCustomers, addPurchaseOrder...)
//     فيها منطق أعمال (صلاحيات، محاسبة، تحقق) أكتر من مجرد CRUD خام،
//     فمفيش داعي ولا فايدة من كسرها. الـ Repository طبقة إضافية اختيارية
//     لأي كود جديد (شاشات جديدة، تقارير، سكربتات صيانة) يحتاج وصول مباشر
//     ونظيف للبيانات الخام بدل ما يعيد اختراع readSheet(table, headers) في
//     كل مرة.
//   - كل Repository غلاف رفيع (thin wrapper) فوق DataLayer (Code_34) — مفيش
//     منطق قراءة/كتابة مكرر هنا إطلاقًا، فقط ربط (اسم الكيان ↔ اسم الجدول
//     + الـ headers الصحيحة بتاعته).
//   - حل الـ headers بيتم *وقت الاستدعاء الفعلي* مش وقت تحميل الملف
//     (lazy resolution)، لأن ترتيب تحميل ملفات Apps Script أبجدي، وبعض
//     الـ headers (زي CUSTOMER_HEADERS في Code_20_Sales.gs) بتتعرّف في
//     ملفات بترقيم أعلى من هذا الملف رقميًا لكن أبجديًا أول. الاعتماد على
//     typeof + دالة تُستدعى وقت التشغيل (مش وقت التحميل) يضمن عدم وجود
//     أي مشكلة ReferenceError مهما كان ترتيب الملفات.
//
// طريقة الاستخدام من أي ملف .gs في نفس المشروع:
//   var r = Repositories.Customers.getAll();          // { success, data }
//   var c = Repositories.Customers.getById("C-001");
//   var res = Repositories.CashBoxes.find({ branch: "الفرع الرئيسي" });
//   // أو لأي جدول مش من القائمة الجاهزة تحت:
//   var repo = RepositoryLayer.get("SomeOtherTable");
// ══════════════════════════════════════════════════════════════════════════

var RepositoryLayer = (function () {
  "use strict";

  // خرائط headers لكيانات لا تُحلّ تلقائيًا عبر HEADERS أو
  // ACCOUNTING_HR_HEADERS العامّتين (المُعرَّفتين في Code_12_Core.gs) —
  // كل هذه معرّفة بمتغيّرات var على مستوى الملف في موديولاتها الأصلية،
  // فبنرجع لها بالاسم وقت التشغيل بدل تكرار قائمة الأعمدة هنا.
  function _extraHeaders(table) {
    switch (table) {
      case "Customers":
        return typeof CUSTOMER_HEADERS !== "undefined" ? CUSTOMER_HEADERS : null;
      case "Suppliers":
        return typeof SUPPLIER_HEADERS !== "undefined" ? SUPPLIER_HEADERS : null;
      case "PartyAddresses":
        return typeof PARTY_ADDRESS_HEADERS !== "undefined" ? PARTY_ADDRESS_HEADERS : null;
      case "PartyDocuments":
        return typeof PARTY_DOCUMENT_HEADERS !== "undefined" ? PARTY_DOCUMENT_HEADERS : null;
      case "PartyCategories":
        return typeof PARTY_CATEGORY_HEADERS !== "undefined" ? PARTY_CATEGORY_HEADERS : null;
      case "SaleInvoices":
        return typeof SALE_INVOICE_HEADERS !== "undefined" ? SALE_INVOICE_HEADERS : null;
      case "PurchaseInvoices":
        return typeof PURCHASE_INVOICE_HEADERS !== "undefined" ? PURCHASE_INVOICE_HEADERS : null;
      case "SaleReturns":
        return typeof SALE_RETURN_HEADERS !== "undefined" ? SALE_RETURN_HEADERS : null;
      case "PurchaseReturns":
        return typeof PURCHASE_RETURN_HEADERS !== "undefined" ? PURCHASE_RETURN_HEADERS : null;
      case "PurchaseOrders":
        return typeof PURCHASE_ORDER_HEADERS !== "undefined" ? PURCHASE_ORDER_HEADERS : null;
      case "PurchaseRequests":
        return typeof PURCHASE_REQUEST_HEADERS !== "undefined" ? PURCHASE_REQUEST_HEADERS : null;
      case "FixedAssets":
        return typeof FIXED_ASSETS_HEADERS !== "undefined" ? FIXED_ASSETS_HEADERS : null;
      case "ShippingCompanies":
        return typeof SHIPPING_COMPANY_HEADERS !== "undefined" ? SHIPPING_COMPANY_HEADERS : null;
      case "StockLots":
        return typeof STOCK_LOTS_HEADERS !== "undefined" ? STOCK_LOTS_HEADERS : null;
      case "VFCLines":
        return typeof VFC_LINES_HEADERS !== "undefined" ? VFC_LINES_HEADERS : null;
      case "VFCTransactions":
        return typeof VFC_TX_HEADERS !== "undefined" ? VFC_TX_HEADERS : null;
      case "Roles":
        return typeof ROLES_HEADERS !== "undefined" ? ROLES_HEADERS : null;
      case "UserPermissions":
        return typeof USER_PERM_HEADERS !== "undefined" ? USER_PERM_HEADERS : null;
      default:
        return null;
    }
  }

  // ترتيب الحل: headers مُمرَّرة صراحة > HEADERS العامة > ACCOUNTING_HR_HEADERS > الخريطة الإضافية أعلاه
  function _resolveHeaders(table, explicitHeaders) {
    return (
      explicitHeaders ||
      (typeof HEADERS !== "undefined" && HEADERS[table]) ||
      (typeof ACCOUNTING_HR_HEADERS !== "undefined" &&
        ACCOUNTING_HR_HEADERS[table]) ||
      _extraHeaders(table) ||
      null
    );
  }

  function _withHeaders(table, extraOpts) {
    var o = {};
    if (extraOpts) {
      Object.keys(extraOpts).forEach(function (k) {
        o[k] = extraOpts[k];
      });
    }
    var h = _resolveHeaders(table, o.headers);
    if (h) o.headers = h;
    return o;
  }

  /**
   * create — يبني Repository لأي جدول بالاسم، حتى لو مش من القائمة
   * الجاهزة في Repositories تحت. مفيد لجداول جديدة أو نادرة الاستخدام
   * بدل ما تحتاج تضيف سطر هنا لكل جدول جديد.
   */
  function create(table) {
    return {
      table: table,
      getAll: function (opts) {
        return DataLayer.getAll(table, _withHeaders(table, opts));
      },
      getById: function (id, opts) {
        return DataLayer.getById(table, id, _withHeaders(table, opts));
      },
      getByCode: function (code, opts) {
        return DataLayer.getByCode(table, code, _withHeaders(table, opts));
      },
      find: function (filter, opts) {
        return DataLayer.find(table, filter, _withHeaders(table, opts));
      },
      search: function (query, fields, opts) {
        return DataLayer.search(table, query, fields, _withHeaders(table, opts));
      },
      count: function (filter, opts) {
        return DataLayer.count(table, filter, _withHeaders(table, opts));
      },
      exists: function (filter, opts) {
        return DataLayer.exists(table, filter, _withHeaders(table, opts));
      },
      create: function (data, opts) {
        return DataLayer.insert(table, data, _withHeaders(table, opts));
      },
      update: function (id, patch, opts) {
        return DataLayer.update(table, id, patch, _withHeaders(table, opts));
      },
      remove: function (id, opts) {
        return DataLayer.remove(table, id, _withHeaders(table, opts));
      },
      // [MERGE UNIFY] alias مطابق لـ DataLayer.delete/.remove الموحّدة —
      // عشان الاسمين يشتغلوا بنفس الاتساق على مستوى Repositories.* كمان،
      // مش بس على مستوى DataLayer المباشر.
      delete: function (id, opts) {
        return DataLayer.remove(table, id, _withHeaders(table, opts));
      },
      bulkInsert: function (rowsData, opts) {
        return DataLayer.bulkInsert(table, rowsData, _withHeaders(table, opts));
      },
      bulkUpdate: function (patches, opts) {
        return DataLayer.bulkUpdate(table, patches, _withHeaders(table, opts));
      },
      bulkDelete: function (ids, opts) {
        return DataLayer.bulkDelete(table, ids, _withHeaders(table, opts));
      },
    };
  }

  var _cache = {};
  function get(table) {
    if (!_cache[table]) _cache[table] = create(table);
    return _cache[table];
  }

  return { get: get, create: create };
})();

// ── واجهة مختصرة جاهزة: Repositories.<EntityName>.<method>() ──────────────
// كل خاصية هنا lazy getter — الـ Repository الفعلي بيتبني أول ما يُستخدم،
// مش وقت تحميل الملف، فمفيش أي اعتماد على ترتيب تحميل ملفات المشروع.
var Repositories = {
  get Items() { return RepositoryLayer.get("Items"); },
  get Groups() { return RepositoryLayer.get("Groups"); },
  get Stock() { return RepositoryLayer.get("Stock"); },
  get StockLots() { return RepositoryLayer.get("StockLots"); },
  get Colors() { return RepositoryLayer.get("Colors"); },
  get Sizes() { return RepositoryLayer.get("Sizes"); },
  get SizeGroups() { return RepositoryLayer.get("SizeGroups"); },
  get Users() { return RepositoryLayer.get("Users"); },
  get Shipments() { return RepositoryLayer.get("Shipments"); },
  get ShippingCompanies() { return RepositoryLayer.get("ShippingCompanies"); },

  get Customers() { return RepositoryLayer.get("Customers"); },
  get Suppliers() { return RepositoryLayer.get("Suppliers"); },
  get PartyAddresses() { return RepositoryLayer.get("PartyAddresses"); },
  get PartyDocuments() { return RepositoryLayer.get("PartyDocuments"); },
  get PartyCategories() { return RepositoryLayer.get("PartyCategories"); },

  get SaleInvoices() { return RepositoryLayer.get("SaleInvoices"); },
  get PurchaseInvoices() { return RepositoryLayer.get("PurchaseInvoices"); },
  get SaleReturns() { return RepositoryLayer.get("SaleReturns"); },
  get PurchaseReturns() { return RepositoryLayer.get("PurchaseReturns"); },
  get PurchaseOrders() { return RepositoryLayer.get("PurchaseOrders"); },
  get PurchaseRequests() { return RepositoryLayer.get("PurchaseRequests"); },

  get ChartOfAccounts() { return RepositoryLayer.get("ChartOfAccounts"); },
  get CashBoxes() { return RepositoryLayer.get("CashBoxes"); },
  get Banks() { return RepositoryLayer.get("Banks"); },
  get BankAccounts() { return RepositoryLayer.get("BankAccounts"); },
  get ChequeBooks() { return RepositoryLayer.get("ChequeBooks"); },
  get Cheques() { return RepositoryLayer.get("Cheques"); },
  get JournalEntries() { return RepositoryLayer.get("JournalEntries"); },
  get JournalEntryLines() { return RepositoryLayer.get("JournalEntryLines"); },
  get ReceiptVouchers() { return RepositoryLayer.get("ReceiptVouchers"); },
  get PaymentVouchers() { return RepositoryLayer.get("PaymentVouchers"); },
  get Expenses() { return RepositoryLayer.get("Expenses"); },
  get TransferVouchers() { return RepositoryLayer.get("TransferVouchers"); },
  get VFCLines() { return RepositoryLayer.get("VFCLines"); },
  get VFCTransactions() { return RepositoryLayer.get("VFCTransactions"); },
  get FixedAssets() { return RepositoryLayer.get("FixedAssets"); },

  get Departments() { return RepositoryLayer.get("Departments"); },
  get JobTitles() { return RepositoryLayer.get("JobTitles"); },
  get Employees() { return RepositoryLayer.get("Employees"); },
  get Attendance() { return RepositoryLayer.get("Attendance"); },
  get LeaveRequests() { return RepositoryLayer.get("LeaveRequests"); },
  get PayrollRecords() { return RepositoryLayer.get("PayrollRecords"); },

  get ManufacturingOrders() { return RepositoryLayer.get("ManufacturingOrders"); },
  get BillOfMaterials() { return RepositoryLayer.get("BillOfMaterials"); },
  get WorkCenters() { return RepositoryLayer.get("WorkCenters"); },
  // [REPO-UNIFY] كيانين تصنيع كانوا مفتقدين من القائمة مع إن عندهم headers
  // جاهزة في ACCOUNTING_HR_HEADERS (Code_12) — أُضيفوا هنا عشان يكتمل نفس
  // نمط WorkCenters/BillOfMaterials المجاورين لهم.
  get Machines() { return RepositoryLayer.get("Machines"); },
  get Routings() { return RepositoryLayer.get("Routings"); },

  get Roles() { return RepositoryLayer.get("Roles"); },
  get UserPermissions() { return RepositoryLayer.get("UserPermissions"); },
};
