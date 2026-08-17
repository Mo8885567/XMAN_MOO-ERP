/**
 * ============================================================
 * Module: Code_Permissions.gs
 *
 * Description:
 *   نظام الصلاحيات (RBAC — Role-Based Access Control) الكامل لـ
 *   MOO.ERP. يحتوي تعريف كل الصلاحيات المتاحة في النظام
 *   (ALL_PERMISSIONS)، الصلاحيات الافتراضية لكل دور مبني مسبقًا
 *   (BUILTIN_PERMISSIONS)، إدارة الأدوار المخصصة (Custom Roles)،
 *   الاستثناءات الفردية لكل مستخدم (User Permission Overrides)،
 *   الدالة المركزية لفحص الصلاحية (_checkPermission) المستخدمة في
 *   كل دالة CRUD تقريبًا عبر المشروع، وصلاحيات الوصول على مستوى
 *   المخزن (Warehouse Access).
 *
 * Responsibilities:
 *   - تعريف قاموس شامل لكل الصلاحيات الممكنة مصنّفة حسب الموديول
 *     (مخزون، محاسبة، HR، مبيعات...).
 *   - Custom Roles CRUD: إنشاء/تعديل/حذف أدوار مخصصة تُخزَّن في شيت Roles.
 *   - User Overrides: منح/سحب صلاحية معيّنة لمستخدم واحد بعينه، فوق
 *     صلاحيات دوره الأساسي.
 *   - _checkPermission: البوابة المركزية التي تستدعيها كل دالة تعديل
 *     في المشروع للتحقق من الجلسة والصلاحية معًا قبل التنفيذ.
 *   - Warehouse Access: تقييد وصول مستخدم معيّن لمخازن محددة فقط.
 *   - Permission Matrix: بناء مصفوفة (دور × صلاحية) لعرضها في شاشة
 *     إدارة الصلاحيات.
 *
 * Dependencies:
 *   - Code_Core.gs (getSheet/readSheet، validateSession، errResponse/
 *     okResponse، _writeAuditLog).
 *   - كل ملفات Code_*.gs الأخرى تعتمد على _checkPermission في بداية
 *     دوال الإضافة/التعديل/الحذف الخاصة بها.
 *
 * Used By:
 *   - كل موديولات الباك-إند (Code_*.gs) عبر _checkPermission.
 *   - شاشة إدارة الصلاحيات والأدوار في الواجهة (getPermissionMatrix،
 *     saveRole، saveUserPermissionOverrides).
 *
 * Author:
 *   MOO.ERP Development Team
 *
 * Last Refactored:
 *   2026-07-04 — إعادة تنظيم وتوثيق شامل للتعليقات (Comment Refactoring
 *   فقط). لم يتغير أي سلوك أو منطق برمجي — راجع "تقرير المراجعة
 *   الداخلي" في نهاية الملف. للسياق: هذا الملف نُقل بالكامل من
 *   Code_Core.gs بتاريخ 2026-07-03 (نقل نصي بحت بدون أي تغيير منطقي،
 *   [REFACTOR-P3])، وهذا التوثيق الحالي هو أول توثيق شامل له بعد النقل.
 *
 * ============================================================
 */

// ════════════════════════════════════════════════════════════════
// القسم 1: تعريف الصلاحيات والأدوار الافتراضية
// ════════════════════════════════════════════════════════════════
// [REFACTOR-P3] هذا الملف بأكمله نُقل من Code_Core.gs (نقل نصي بحت،
// صفر تغيير في المنطق أو الترتيب الداخلي). Apps Script يعامل كل ملفات
// .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء من أي
// ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// المصدر الأصلي: Code_Core.gs — راجع تقرير Architecture Audit بتاريخ
// 2026-07-03، المرحلة 3.

// ┄┄┄ [مصدر: Code.js سطور 5341-7772] Permissions System ┄┄┄
// المصدر الأصلي (قبل تقسيم Code.js): يضم تعريف الصلاحيات مع
// تصنيفاتها، الأدوار المخصصة، الاستثناءات الفردية لكل مستخدم،
// _checkPermission بكل سيناريوهاتها، وgetPermissionMatrix لواجهة
// الإدارة.

// ─────────────────────────────────────────────────────────────
// §18-A  تعريف كل الصلاحيات مع تصنيفاتها
// ─────────────────────────────────────────────────────────────

/**
 * القاموس الشامل لكل صلاحية موجودة في النظام. كل عنصر يمثّل صلاحية
 * واحدة قابلة للمنح/السحب لأي دور أو مستخدم.
 *
 * @property {String} key - المعرّف الفريد للصلاحية (يُستخدم في الكود
 *   كوسيط action لـ _checkPermission، مثل "addItem").
 * @property {String} label - الاسم المعروض للمستخدم بالعربية.
 * @property {String} cat - مفتاح تصنيف الصلاحية (مثل "inventory").
 * @property {String} catLabel - اسم التصنيف المعروض بالعربية.
 *
 * IMPORTANT:
 *   أي صلاحية يُستدعى بها _checkPermission في أي مكان بالمشروع
 *   ولا تكون موجودة هنا ستُرفض تلقائيًا لكل المستخدمين (بما فيهم
 *   admin أحيانًا حسب منطق _checkPermission) — هذا بالضبط ما اكتشفه
 *   تدقيق RBAC (Phase 9): 27 مفتاح صلاحية مُستخدَم في استدعاءات
 *   _checkPermission لكنه غير موجود هنا، ما أدى لمنع وحدة HR بالكامل
 *   ودوال إلغاء محاسبية عن كل المستخدمين بمن فيهم admin.
 */
var ALL_PERMISSIONS = [
  // ── المخزون ──
  {
    key: "addItem",
    labelKey: "PERM_ADD_ITEM",
    cat: "inventory",
    catLabelKey: "PERMCAT_INVENTORY",
  },
  {
    key: "updateItem",
    labelKey: "PERM_UPDATE_ITEM",
    cat: "inventory",
    catLabelKey: "PERMCAT_INVENTORY",
  },
  {
    key: "deleteItem",
    labelKey: "PERM_DELETE_ITEM",
    cat: "inventory",
    catLabelKey: "PERMCAT_INVENTORY",
  },
  {
    key: "saveItemWithColorSync",
    labelKey: "PERM_SAVE_ITEM_WITH_COLOR_SYNC",
    cat: "inventory",
    catLabelKey: "PERMCAT_INVENTORY",
  },
  {
    key: "importItems",
    labelKey: "PERM_IMPORT_ITEMS",
    cat: "inventory",
    catLabelKey: "PERMCAT_INVENTORY",
  },
  // [INV-SETTINGS-2026-08-07] صلاحية التحكم في شاشة إعدادات المخزون
  // العامة الجديدة (Code_56_InventorySettingsEngine.js) — منفصلة عن
  // addItem/updateItem لأنها صلاحية سياسات على مستوى النظام كله مش
  // على صنف واحد، فمينفعش نخلطها مع صلاحيات الأصناف العادية.
  {
    key: "manageInventorySettings",
    labelKey: "PERM_MANAGE_INVENTORY_SETTINGS",
    cat: "inventory",
    catLabelKey: "PERMCAT_INVENTORY",
  },
  // ── المجموعات ──
  {
    key: "addGroup",
    labelKey: "PERM_ADD_GROUP",
    cat: "groups",
    catLabelKey: "PERMCAT_GROUPS",
  },
  {
    key: "updateGroup",
    labelKey: "PERM_UPDATE_GROUP",
    cat: "groups",
    catLabelKey: "PERMCAT_GROUPS",
  },
  {
    key: "deleteGroup",
    labelKey: "PERM_DELETE_GROUP",
    cat: "groups",
    catLabelKey: "PERMCAT_GROUPS",
  },
  // ── المخازن ──
  {
    key: "addWarehouse",
    labelKey: "PERM_ADD_WAREHOUSE",
    cat: "warehouses",
    catLabelKey: "PERMCAT_WAREHOUSES",
  },
  {
    key: "updateWarehouse",
    labelKey: "PERM_UPDATE_WAREHOUSE",
    cat: "warehouses",
    catLabelKey: "PERMCAT_WAREHOUSES",
  },
  {
    key: "deleteWarehouse",
    labelKey: "PERM_DELETE_WAREHOUSE",
    cat: "warehouses",
    catLabelKey: "PERMCAT_WAREHOUSES",
  },
  // ── حركات المخزون ──
  {
    key: "addTransaction",
    labelKey: "PERM_ADD_TRANSACTION",
    cat: "transactions",
    catLabelKey: "PERMCAT_TRANSACTIONS",
  },
  {
    key: "addBatchTransaction",
    labelKey: "PERM_ADD_BATCH_TRANSACTION",
    cat: "transactions",
    catLabelKey: "PERMCAT_TRANSACTIONS",
  },
  {
    key: "updateTransaction",
    labelKey: "PERM_UPDATE_TRANSACTION",
    cat: "transactions",
    catLabelKey: "PERMCAT_TRANSACTIONS",
  },
  {
    key: "deleteTransaction",
    labelKey: "PERM_DELETE_TRANSACTION",
    cat: "transactions",
    catLabelKey: "PERMCAT_TRANSACTIONS",
  },
  {
    key: "addOpeningStock",
    labelKey: "PERM_ADD_OPENING_STOCK",
    cat: "transactions",
    catLabelKey: "PERMCAT_TRANSACTIONS",
  },
  {
    key: "deleteOpeningStock",
    labelKey: "PERM_DELETE_OPENING_STOCK",
    cat: "transactions",
    catLabelKey: "PERMCAT_TRANSACTIONS",
  },
  // ── الإنتاج ──
  {
    key: "addProductionOrder",
    labelKey: "PERM_ADD_PRODUCTION_ORDER",
    cat: "production",
    catLabelKey: "PERMCAT_PRODUCTION",
  },
  {
    key: "updateProductionOrder",
    labelKey: "PERM_UPDATE_PRODUCTION_ORDER",
    cat: "production",
    catLabelKey: "PERMCAT_PRODUCTION",
  },
  {
    key: "deleteProductionOrder",
    labelKey: "PERM_DELETE_PRODUCTION_ORDER",
    cat: "production",
    catLabelKey: "PERMCAT_PRODUCTION",
  },
  {
    key: "updateProductionOrderStatus",
    labelKey: "PERM_UPDATE_PRODUCTION_ORDER_STATUS",
    cat: "production",
    catLabelKey: "PERMCAT_PRODUCTION",
  },
  // ── التصنيع ──
  {
    key: "viewManufacturing",
    labelKey: "PERM_VIEW_MANUFACTURING",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "viewWorkCenters",
    labelKey: "PERM_VIEW_WORK_CENTERS",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "manageWorkCenters",
    labelKey: "PERM_MANAGE_WORK_CENTERS",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "viewBOM",
    labelKey: "PERM_VIEW_B_O_M",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "manageBOM",
    labelKey: "PERM_MANAGE_B_O_M",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "viewRouting",
    labelKey: "PERM_VIEW_ROUTING",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "manageRouting",
    labelKey: "PERM_MANAGE_ROUTING",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "viewManufacturingOrders",
    labelKey: "PERM_VIEW_MANUFACTURING_ORDERS",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "addManufacturingOrder",
    labelKey: "PERM_ADD_MANUFACTURING_ORDER",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "updateManufacturingOrder",
    labelKey: "PERM_UPDATE_MANUFACTURING_ORDER",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "deleteManufacturingOrder",
    labelKey: "PERM_DELETE_MANUFACTURING_ORDER",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "approveManufacturingOrder",
    labelKey: "PERM_APPROVE_MANUFACTURING_ORDER",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "releaseManufacturingOrder",
    labelKey: "PERM_RELEASE_MANUFACTURING_ORDER",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "closeManufacturingOrder",
    labelKey: "PERM_CLOSE_MANUFACTURING_ORDER",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "reopenManufacturingOrder",
    labelKey: "PERM_REOPEN_MANUFACTURING_ORDER",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "cancelManufacturingOrder",
    labelKey: "PERM_CANCEL_MANUFACTURING_ORDER",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "overrideMaterialLimit",
    labelKey: "PERM_OVERRIDE_MATERIAL_LIMIT",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "issueMaterial",
    labelKey: "PERM_ISSUE_MATERIAL",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "receiveFinishedGoods",
    labelKey: "PERM_RECEIVE_FINISHED_GOODS",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "viewQualityInspections",
    labelKey: "PERM_VIEW_QUALITY_INSPECTIONS",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "addQualityInspection",
    labelKey: "PERM_ADD_QUALITY_INSPECTION",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "approveQualityRejection",
    labelKey: "PERM_APPROVE_QUALITY_REJECTION",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "manageSubcontractors",
    labelKey: "PERM_MANAGE_SUBCONTRACTORS",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "manageSubcontractShipments",
    labelKey: "PERM_MANAGE_SUBCONTRACT_SHIPMENTS",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "viewManufacturingCosting",
    labelKey: "PERM_VIEW_MANUFACTURING_COSTING",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  {
    key: "manageManufacturingCostSettings",
    labelKey: "PERM_MANAGE_MANUFACTURING_COST_SETTINGS",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  // ── الإنتاج ──
  {
    key: "saveCuttingData",
    labelKey: "PERM_SAVE_CUTTING_DATA",
    cat: "production",
    catLabelKey: "PERMCAT_PRODUCTION",
  },
  {
    key: "addFgReceive",
    labelKey: "PERM_ADD_FG_RECEIVE",
    cat: "production",
    catLabelKey: "PERMCAT_PRODUCTION",
  },
  // ── الشحنات ──
  {
    key: "addShipment",
    labelKey: "PERM_ADD_SHIPMENT",
    cat: "shipping",
    catLabelKey: "PERMCAT_SHIPPING",
  },
  {
    key: "updateShipment",
    labelKey: "PERM_UPDATE_SHIPMENT",
    cat: "shipping",
    catLabelKey: "PERMCAT_SHIPPING",
  },
  {
    key: "deleteShipment",
    labelKey: "PERM_DELETE_SHIPMENT",
    cat: "shipping",
    catLabelKey: "PERMCAT_SHIPPING",
  },
  {
    key: "viewShippingCompanies",
    labelKey: "PERM_VIEW_SHIPPING_COMPANIES",
    cat: "shipping",
    catLabelKey: "PERMCAT_SHIPPING",
  },
  {
    // [FIX-ORPHAN-PERMS] بوابة تقرير الشحن في 18_JS_Reports.html بتستخدمها
    // كـ requiredPerms على مستوى الوحدة زي viewManufacturing/viewHR، لكن
    // كانت غير معرّفة في الكتالوج فمينفعش تُمنح لأي دور غير الأدمن.
    key: "viewShipping",
    labelKey: "PERM_VIEW_SHIPPING",
    cat: "shipping",
    catLabelKey: "PERMCAT_SHIPPING",
  },
  {
    key: "addShippingCompany",
    labelKey: "PERM_ADD_SHIPPING_COMPANY",
    cat: "shipping",
    catLabelKey: "PERMCAT_SHIPPING",
  },
  {
    key: "updateShippingCompany",
    labelKey: "PERM_UPDATE_SHIPPING_COMPANY",
    cat: "shipping",
    catLabelKey: "PERMCAT_SHIPPING",
  },
  {
    key: "deleteShippingCompany",
    labelKey: "PERM_DELETE_SHIPPING_COMPANY",
    cat: "shipping",
    catLabelKey: "PERMCAT_SHIPPING",
  },
  // ── الألوان ──
  {
    key: "addColor",
    labelKey: "PERM_ADD_COLOR",
    cat: "colors",
    catLabelKey: "PERMCAT_COLORS",
  },
  {
    key: "updateColor",
    labelKey: "PERM_UPDATE_COLOR",
    cat: "colors",
    catLabelKey: "PERMCAT_COLORS",
  },
  {
    key: "deleteColor",
    labelKey: "PERM_DELETE_COLOR",
    cat: "colors",
    catLabelKey: "PERMCAT_COLORS",
  },
  // ── المقاسات ──
  {
    key: "addSize",
    labelKey: "PERM_ADD_SIZE",
    cat: "sizes",
    catLabelKey: "PERMCAT_SIZES",
  },
  {
    key: "updateSize",
    labelKey: "PERM_UPDATE_SIZE",
    cat: "sizes",
    catLabelKey: "PERMCAT_SIZES",
  },
  {
    key: "deleteSize",
    labelKey: "PERM_DELETE_SIZE",
    cat: "sizes",
    catLabelKey: "PERMCAT_SIZES",
  },
  // ── الوحدات (UNITS-2026-08-06) ──
  {
    key: "addUnit",
    labelKey: "PERM_ADD_UNIT",
    cat: "units",
    catLabelKey: "PERMCAT_UNITS",
  },
  {
    key: "updateUnit",
    labelKey: "PERM_UPDATE_UNIT",
    cat: "units",
    catLabelKey: "PERMCAT_UNITS",
  },
  {
    key: "deleteUnit",
    labelKey: "PERM_DELETE_UNIT",
    cat: "units",
    catLabelKey: "PERMCAT_UNITS",
  },
  // ── المستخدمون ──
  {
    key: "addUser",
    labelKey: "PERM_ADD_USER",
    cat: "users",
    catLabelKey: "PERMCAT_USERS",
  },
  {
    key: "updateUser",
    labelKey: "PERM_UPDATE_USER",
    cat: "users",
    catLabelKey: "PERMCAT_USERS",
  },
  {
    key: "deleteUser",
    labelKey: "PERM_DELETE_USER",
    cat: "users",
    catLabelKey: "PERMCAT_USERS",
  },
  {
    key: "resetPassword",
    labelKey: "PERM_RESET_PASSWORD",
    cat: "users",
    catLabelKey: "PERMCAT_USERS",
  },
  {
    key: "manageRoles",
    labelKey: "PERM_MANAGE_ROLES",
    cat: "users",
    catLabelKey: "PERMCAT_USERS",
  },
  {
    key: "manageUsers",
    labelKey: "PERM_MANAGE_USERS",
    cat: "users",
    catLabelKey: "PERMCAT_USERS",
  },
  // ── النظام ──
  {
    key: "createBackup",
    labelKey: "PERM_CREATE_BACKUP",
    cat: "system",
    catLabelKey: "PERMCAT_SYSTEM",
  },
  {
    // [BACKUP-ENGINE-v5] صلاحية منفصلة عن createBackup — الاستعادة تستبدل
    // كل بيانات الشركة الحالية فلازم تكون أضيق نطاقًا (أدمن فقط افتراضيًا)
    key: "restoreBackup",
    labelKey: "PERM_RESTORE_BACKUP",
    cat: "system",
    catLabelKey: "PERMCAT_SYSTEM",
  },
  {
    key: "viewAuditLog",
    labelKey: "PERM_VIEW_AUDIT_LOG",
    cat: "system",
    catLabelKey: "PERMCAT_SYSTEM",
  },
  {
    key: "settings_manage",
    labelKey: "PERM_SETTINGS_MANAGE",
    cat: "system",
    catLabelKey: "PERMCAT_SYSTEM",
  },
  // ── المحاسبة ──
  {
    key: "viewAccounting",
    labelKey: "PERM_VIEW_ACCOUNTING",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewChartOfAccounts",
    labelKey: "PERM_VIEW_CHART_OF_ACCOUNTS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewCashBoxes",
    labelKey: "PERM_VIEW_CASH_BOXES",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewBankAccounts",
    labelKey: "PERM_VIEW_BANK_ACCOUNTS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewJournalEntries",
    labelKey: "PERM_VIEW_JOURNAL_ENTRIES",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewReceiptVouchers",
    labelKey: "PERM_VIEW_RECEIPT_VOUCHERS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewPaymentVouchers",
    labelKey: "PERM_VIEW_PAYMENT_VOUCHERS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewExpenses",
    labelKey: "PERM_VIEW_EXPENSES",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewTransferVouchers",
    labelKey: "PERM_VIEW_TRANSFER_VOUCHERS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewGeneralLedger",
    labelKey: "PERM_VIEW_GENERAL_LEDGER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewTrialBalance",
    labelKey: "PERM_VIEW_TRIAL_BALANCE",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewIncomeStatement",
    labelKey: "PERM_VIEW_INCOME_STATEMENT",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewBalanceSheet",
    labelKey: "PERM_VIEW_BALANCE_SHEET",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewAccountStatement",
    labelKey: "PERM_VIEW_ACCOUNT_STATEMENT",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  // ── الموارد البشرية ──
  {
    key: "viewHR",
    labelKey: "PERM_VIEW_H_R",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewDepartments",
    labelKey: "PERM_VIEW_DEPARTMENTS",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewJobTitles",
    labelKey: "PERM_VIEW_JOB_TITLES",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewEmployees",
    labelKey: "PERM_VIEW_EMPLOYEES",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewSalary",
    labelKey: "PERM_VIEW_SALARY",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewAttendance",
    labelKey: "PERM_VIEW_ATTENDANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  // [FIX-RBAC-1] الثلاثة دول مستخدمين فعليًا في _requirePermission بملفات
  // Code_15_HR.gs وCode_13_DeviceConnect.gs (استيراد حضور من الأجهزة/ملفات،
  // عرض/حذف سجل الاستيراد) لكنهم كانوا غير معرّفين هنا إطلاقًا — وبما إن
  // admin = ALL_PERMISSIONS.map(key)، كان معنى ده إن حتى الـ admin ممنوع من
  // الاستيراد بالكامل (نفس نمط باج RBAC Phase 9 القديم، هنا بـ 3 مفاتيح فقط).
  {
    key: "importAttendance",
    labelKey: "PERM_IMPORT_ATTENDANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewImportLog",
    labelKey: "PERM_VIEW_IMPORT_LOG",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteImport",
    labelKey: "PERM_DELETE_IMPORT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "manageLeaveTypes",
    labelKey: "PERM_MANAGE_LEAVE_TYPES",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewLeaveRequests",
    labelKey: "PERM_VIEW_LEAVE_REQUESTS",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewLoanRequests",
    labelKey: "PERM_VIEW_LOAN_REQUESTS",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewPayroll",
    labelKey: "PERM_VIEW_PAYROLL",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewPayslip",
    labelKey: "PERM_VIEW_PAYSLIP",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addDepartment",
    labelKey: "PERM_ADD_DEPARTMENT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "updateDepartment",
    labelKey: "PERM_UPDATE_DEPARTMENT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteDepartment",
    labelKey: "PERM_DELETE_DEPARTMENT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addJobTitle",
    labelKey: "PERM_ADD_JOB_TITLE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "updateJobTitle",
    labelKey: "PERM_UPDATE_JOB_TITLE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteJobTitle",
    labelKey: "PERM_DELETE_JOB_TITLE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addEmployee",
    labelKey: "PERM_ADD_EMPLOYEE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteEmployee",
    labelKey: "PERM_DELETE_EMPLOYEE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addProductionStage",
    labelKey: "PERM_ADD_PRODUCTION_STAGE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "updateProductionStage",
    labelKey: "PERM_UPDATE_PRODUCTION_STAGE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteProductionStage",
    labelKey: "PERM_DELETE_PRODUCTION_STAGE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addStageExecution",
    labelKey: "PERM_ADD_STAGE_EXECUTION",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteStageExecution",
    labelKey: "PERM_DELETE_STAGE_EXECUTION",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "approveStageExecution",
    labelKey: "PERM_APPROVE_STAGE_EXECUTION",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "recordAttendance",
    labelKey: "PERM_RECORD_ATTENDANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "editAttendance",
    labelKey: "PERM_EDIT_ATTENDANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addLeaveType",
    labelKey: "PERM_ADD_LEAVE_TYPE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "updateLeaveType",
    labelKey: "PERM_UPDATE_LEAVE_TYPE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "requestLeave",
    labelKey: "PERM_REQUEST_LEAVE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "approveLeaveRequest",
    labelKey: "PERM_APPROVE_LEAVE_REQUEST",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "requestLoan",
    labelKey: "PERM_REQUEST_LOAN",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "approveLoanRequest",
    labelKey: "PERM_APPROVE_LOAN_REQUEST",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "generatePayroll",
    labelKey: "PERM_GENERATE_PAYROLL",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addAttendance",
    labelKey: "PERM_ADD_ATTENDANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "updateAttendance",
    labelKey: "PERM_UPDATE_ATTENDANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteAttendance",
    labelKey: "PERM_DELETE_ATTENDANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addLeaveRequest",
    labelKey: "PERM_ADD_LEAVE_REQUEST",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "rejectLeaveRequest",
    labelKey: "PERM_REJECT_LEAVE_REQUEST",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteLeaveRequest",
    labelKey: "PERM_DELETE_LEAVE_REQUEST",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteLeaveType",
    labelKey: "PERM_DELETE_LEAVE_TYPE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addLoanRequest",
    labelKey: "PERM_ADD_LOAN_REQUEST",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "rejectLoanRequest",
    labelKey: "PERM_REJECT_LOAN_REQUEST",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteLoanRequest",
    labelKey: "PERM_DELETE_LOAN_REQUEST",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "recordLoanPayment",
    labelKey: "PERM_RECORD_LOAN_PAYMENT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addPayrollPeriod",
    labelKey: "PERM_ADD_PAYROLL_PERIOD",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deletePayrollPeriod",
    labelKey: "PERM_DELETE_PAYROLL_PERIOD",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewSalaryComponents",
    labelKey: "PERM_VIEW_SALARY_COMPONENTS",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addSalaryComponent",
    labelKey: "PERM_ADD_SALARY_COMPONENT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "updateSalaryComponent",
    labelKey: "PERM_UPDATE_SALARY_COMPONENT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteSalaryComponent",
    labelKey: "PERM_DELETE_SALARY_COMPONENT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addEmployeeAllowance",
    labelKey: "PERM_ADD_EMPLOYEE_ALLOWANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "updateEmployeeAllowance",
    labelKey: "PERM_UPDATE_EMPLOYEE_ALLOWANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteEmployeeAllowance",
    labelKey: "PERM_DELETE_EMPLOYEE_ALLOWANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "addEmployeeDeduction",
    labelKey: "PERM_ADD_EMPLOYEE_DEDUCTION",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "updateEmployeeDeduction",
    labelKey: "PERM_UPDATE_EMPLOYEE_DEDUCTION",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteEmployeeDeduction",
    labelKey: "PERM_DELETE_EMPLOYEE_DEDUCTION",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "uploadEmployeeDocument",
    labelKey: "PERM_UPLOAD_EMPLOYEE_DOCUMENT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteEmployeeDocument",
    labelKey: "PERM_DELETE_EMPLOYEE_DOCUMENT",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  // ── [HR-TABS-P1] المؤهلات والخبرات ──
  {
    key: "addEmployeeQualification",
    labelKey: "PERM_ADD_EMPLOYEE_QUALIFICATION",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "updateEmployeeQualification",
    labelKey: "PERM_UPDATE_EMPLOYEE_QUALIFICATION",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "deleteEmployeeQualification",
    labelKey: "PERM_DELETE_EMPLOYEE_QUALIFICATION",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  // ── [HR-TABS-P1] سياسة الموظف (Employee Policy) ──
  {
    key: "manageEmployeePolicy",
    labelKey: "PERM_MANAGE_EMPLOYEE_POLICY",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  // ── المحاسبة ──
  {
    key: "addChartAccount",
    labelKey: "PERM_ADD_CHART_ACCOUNT",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updateChartAccount",
    labelKey: "PERM_UPDATE_CHART_ACCOUNT",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteChartAccount",
    labelKey: "PERM_DELETE_CHART_ACCOUNT",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "manageChartOfAccounts",
    labelKey: "PERM_MANAGE_CHART_OF_ACCOUNTS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addCashBox",
    labelKey: "PERM_ADD_CASH_BOX",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updateCashBox",
    labelKey: "PERM_UPDATE_CASH_BOX",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteCashBox",
    labelKey: "PERM_DELETE_CASH_BOX",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addBankAccount",
    labelKey: "PERM_ADD_BANK_ACCOUNT",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updateBankAccount",
    labelKey: "PERM_UPDATE_BANK_ACCOUNT",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteBankAccount",
    labelKey: "PERM_DELETE_BANK_ACCOUNT",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewBanks",
    labelKey: "PERM_VIEW_BANKS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addBank",
    labelKey: "PERM_ADD_BANK",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updateBank",
    labelKey: "PERM_UPDATE_BANK",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteBank",
    labelKey: "PERM_DELETE_BANK",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  // [COST-CENTER-DIM] صلاحيات كيان مراكز التكلفة الجديد
  {
    key: "viewCostCenters",
    labelKey: "PERM_VIEW_COST_CENTERS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addCostCenter",
    labelKey: "PERM_ADD_COST_CENTER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updateCostCenter",
    labelKey: "PERM_UPDATE_COST_CENTER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteCostCenter",
    labelKey: "PERM_DELETE_COST_CENTER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  // [PAYMENT-METHODS-MASTER-1] صلاحيات كيان طرق الدفع الجديد
  {
    key: "viewPaymentMethods",
    labelKey: "PERM_VIEW_PAYMENT_METHODS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addPaymentMethod",
    labelKey: "PERM_ADD_PAYMENT_METHOD",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updatePaymentMethod",
    labelKey: "PERM_UPDATE_PAYMENT_METHOD",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deletePaymentMethod",
    labelKey: "PERM_DELETE_PAYMENT_METHOD",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  // [PERIOD-CLOSING] صلاحيات إغلاق/فتح الفترات المحاسبية
  {
    key: "viewAccountingPeriods",
    labelKey: "PERM_VIEW_ACCOUNTING_PERIODS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "closeAccountingPeriod",
    labelKey: "PERM_CLOSE_ACCOUNTING_PERIOD",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "reopenAccountingPeriod",
    labelKey: "PERM_REOPEN_ACCOUNTING_PERIOD",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewChequeBooks",
    labelKey: "PERM_VIEW_CHEQUE_BOOKS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addChequeBook",
    labelKey: "PERM_ADD_CHEQUE_BOOK",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updateChequeBook",
    labelKey: "PERM_UPDATE_CHEQUE_BOOK",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteChequeBook",
    labelKey: "PERM_DELETE_CHEQUE_BOOK",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewCheques",
    labelKey: "PERM_VIEW_CHEQUES",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addCheque",
    labelKey: "PERM_ADD_CHEQUE",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updateCheque",
    labelKey: "PERM_UPDATE_CHEQUE",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteCheque",
    labelKey: "PERM_DELETE_CHEQUE",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "changeChequeStatus",
    labelKey: "PERM_CHANGE_CHEQUE_STATUS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewBankReconciliation",
    labelKey: "PERM_VIEW_BANK_RECONCILIATION",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addBankReconciliation",
    labelKey: "PERM_ADD_BANK_RECONCILIATION",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "completeBankReconciliation",
    labelKey: "PERM_COMPLETE_BANK_RECONCILIATION",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteBankReconciliation",
    labelKey: "PERM_DELETE_BANK_RECONCILIATION",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addJournalEntry",
    labelKey: "PERM_ADD_JOURNAL_ENTRY",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "postJournalEntry",
    labelKey: "PERM_POST_JOURNAL_ENTRY",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "reverseJournalEntry",
    labelKey: "PERM_REVERSE_JOURNAL_ENTRY",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "exportJournalEntryPdf",
    labelKey: "PERM_EXPORT_JOURNAL_ENTRY_PDF",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteJournalEntry",
    labelKey: "PERM_DELETE_JOURNAL_ENTRY",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addReceiptVoucher",
    labelKey: "PERM_ADD_RECEIPT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "approveReceiptVoucher",
    labelKey: "PERM_APPROVE_RECEIPT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addPaymentVoucher",
    labelKey: "PERM_ADD_PAYMENT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "approvePaymentVoucher",
    labelKey: "PERM_APPROVE_PAYMENT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addExpense",
    labelKey: "PERM_ADD_EXPENSE",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "approveExpense",
    labelKey: "PERM_APPROVE_EXPENSE",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updateExpense",
    labelKey: "PERM_UPDATE_EXPENSE",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteExpense",
    labelKey: "PERM_DELETE_EXPENSE",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "cancelExpense",
    labelKey: "PERM_CANCEL_EXPENSE",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "addTransferVoucher",
    labelKey: "PERM_ADD_TRANSFER_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updateReceiptVoucher",
    labelKey: "PERM_UPDATE_RECEIPT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteReceiptVoucher",
    labelKey: "PERM_DELETE_RECEIPT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "updatePaymentVoucher",
    labelKey: "PERM_UPDATE_PAYMENT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deletePaymentVoucher",
    labelKey: "PERM_DELETE_PAYMENT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "deleteTransferVoucher",
    labelKey: "PERM_DELETE_TRANSFER_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "cancelJournalEntry",
    labelKey: "PERM_CANCEL_JOURNAL_ENTRY",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "cancelReceiptVoucher",
    labelKey: "PERM_CANCEL_RECEIPT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "cancelPaymentVoucher",
    labelKey: "PERM_CANCEL_PAYMENT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "cancelTransferVoucher",
    labelKey: "PERM_CANCEL_TRANSFER_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "viewReports",
    labelKey: "PERM_VIEW_REPORTS",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  // ── العملاء والموردون ──
  {
    key: "viewCustomers",
    labelKey: "PERM_VIEW_CUSTOMERS",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  // [CUST-SETTINGS-2026-08-07] صلاحية شاشة إعدادات العملاء العامة الجديدة
  // (Code_58_CustomerSettingsEngine.js) — منفصلة عن addCustomer/updateCustomer
  // لأنها سياسة نظام كله (ترقيم/ائتمان/حقول إلزامية...) مش عملية على عميل واحد.
  {
    key: "manageCustomerSettings",
    labelKey: "PERM_MANAGE_CUSTOMER_SETTINGS",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  // [CUST-SETTINGS-2026-08-07] صلاحية تجاوز حد الائتمان عند رفض فاتورة بيع
  // آجلة تتخطى credit_limit — نفس فلسفة overrideMinPrice تمامًا (راجع تحت
  // في قسم invoices)، لكن مربوطة بسياسة العملاء بدل الفواتير.
  {
    key: "overrideCreditLimit",
    labelKey: "PERM_OVERRIDE_CREDIT_LIMIT",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "viewSuppliers",
    labelKey: "PERM_VIEW_SUPPLIERS",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "addCustomer",
    labelKey: "PERM_ADD_CUSTOMER",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "addSupplier",
    labelKey: "PERM_ADD_SUPPLIER",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "updateCustomer",
    labelKey: "PERM_UPDATE_CUSTOMER",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "deleteCustomer",
    labelKey: "PERM_DELETE_CUSTOMER",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "updateSupplier",
    labelKey: "PERM_UPDATE_SUPPLIER",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "deleteSupplier",
    labelKey: "PERM_DELETE_SUPPLIER",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "viewCustomerCategories",
    labelKey: "PERM_VIEW_CUSTOMER_CATEGORIES",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "addCustomerCategory",
    labelKey: "PERM_ADD_CUSTOMER_CATEGORY",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "updateCustomerCategory",
    labelKey: "PERM_UPDATE_CUSTOMER_CATEGORY",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "deleteCustomerCategory",
    labelKey: "PERM_DELETE_CUSTOMER_CATEGORY",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "viewSupplierCategories",
    labelKey: "PERM_VIEW_SUPPLIER_CATEGORIES",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "addSupplierCategory",
    labelKey: "PERM_ADD_SUPPLIER_CATEGORY",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "updateSupplierCategory",
    labelKey: "PERM_UPDATE_SUPPLIER_CATEGORY",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  {
    key: "deleteSupplierCategory",
    labelKey: "PERM_DELETE_SUPPLIER_CATEGORY",
    cat: "parties",
    catLabelKey: "PERMCAT_PARTIES",
  },
  // ── فودافون كاش ──
  {
    key: "viewVodafoneCash",
    labelKey: "PERM_VIEW_VODAFONE_CASH",
    cat: "vodafone_cash",
    catLabelKey: "PERMCAT_VODAFONE_CASH",
  },
  {
    key: "addVodafoneCashLine",
    labelKey: "PERM_ADD_VODAFONE_CASH_LINE",
    cat: "vodafone_cash",
    catLabelKey: "PERMCAT_VODAFONE_CASH",
  },
  {
    key: "updateVodafoneCashLine",
    labelKey: "PERM_UPDATE_VODAFONE_CASH_LINE",
    cat: "vodafone_cash",
    catLabelKey: "PERMCAT_VODAFONE_CASH",
  },
  {
    key: "deleteVodafoneCashLine",
    labelKey: "PERM_DELETE_VODAFONE_CASH_LINE",
    cat: "vodafone_cash",
    catLabelKey: "PERMCAT_VODAFONE_CASH",
  },
  {
    key: "addVodafoneCashTransaction",
    labelKey: "PERM_ADD_VODAFONE_CASH_TRANSACTION",
    cat: "vodafone_cash",
    catLabelKey: "PERMCAT_VODAFONE_CASH",
  },
  {
    key: "updateVodafoneCashTransaction",
    labelKey: "PERM_UPDATE_VODAFONE_CASH_TRANSACTION",
    cat: "vodafone_cash",
    catLabelKey: "PERMCAT_VODAFONE_CASH",
  },
  {
    key: "deleteVodafoneCashTransaction",
    labelKey: "PERM_DELETE_VODAFONE_CASH_TRANSACTION",
    cat: "vodafone_cash",
    catLabelKey: "PERMCAT_VODAFONE_CASH",
  },
  // ── الموارد البشرية ──
  {
    key: "updateEmployee",
    labelKey: "PERM_UPDATE_EMPLOYEE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "approvePayroll",
    labelKey: "PERM_APPROVE_PAYROLL",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "payPayroll",
    labelKey: "PERM_PAY_PAYROLL",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  // ── المحاسبة ──
  {
    key: "updateJournalEntry",
    labelKey: "PERM_UPDATE_JOURNAL_ENTRY",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "approveTransferVoucher",
    labelKey: "PERM_APPROVE_TRANSFER_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "printReceiptVoucher",
    labelKey: "PERM_PRINT_RECEIPT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  {
    key: "printPaymentVoucher",
    labelKey: "PERM_PRINT_PAYMENT_VOUCHER",
    cat: "accounting",
    catLabelKey: "PERMCAT_ACCOUNTING",
  },
  // ── الفواتير ──
  {
    key: "viewSaleInvoices",
    labelKey: "PERM_VIEW_SALE_INVOICES",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "addSaleInvoice",
    labelKey: "PERM_ADD_SALE_INVOICE",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "updateSaleInvoice",
    labelKey: "PERM_UPDATE_SALE_INVOICE",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "deleteSaleInvoice",
    labelKey: "PERM_DELETE_SALE_INVOICE",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "viewPurchaseInvoices",
    labelKey: "PERM_VIEW_PURCHASE_INVOICES",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "addPurchaseInvoice",
    labelKey: "PERM_ADD_PURCHASE_INVOICE",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "updatePurchaseInvoice",
    labelKey: "PERM_UPDATE_PURCHASE_INVOICE",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "deletePurchaseInvoice",
    labelKey: "PERM_DELETE_PURCHASE_INVOICE",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  // ── أوامر الشراء (Purchase Orders) ──
  // [FIX-ORPHAN-PERMS] الصلاحيات دي كانت مستخدمة فعليًا في requiredPerms/canDo
  // وفي ROLE_PERMISSIONS الافتراضية، لكن غير موجودة في الكتالوج فكانت مستحيلة
  // المنح/السحب الفردي من شاشة إدارة الصلاحيات.
  {
    key: "viewPurchaseOrders",
    labelKey: "PERM_VIEW_PURCHASE_ORDERS",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "addPurchaseOrder",
    labelKey: "PERM_ADD_PURCHASE_ORDER",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "updatePurchaseOrder",
    labelKey: "PERM_UPDATE_PURCHASE_ORDER",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "deletePurchaseOrder",
    labelKey: "PERM_DELETE_PURCHASE_ORDER",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "approvePurchaseOrder",
    labelKey: "PERM_APPROVE_PURCHASE_ORDER",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "receivePurchaseOrder",
    labelKey: "PERM_RECEIVE_PURCHASE_ORDER",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  // ── الواتساب ──
  {
    key: "sendWhatsapp",
    labelKey: "PERM_SEND_WHATSAPP",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "manageWhatsappTemplates",
    labelKey: "PERM_MANAGE_WHATSAPP_TEMPLATES",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "viewWhatsappLogs",
    labelKey: "PERM_VIEW_WHATSAPP_LOGS",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "viewWhatsappCenter",
    labelKey: "PERM_VIEW_WHATSAPP_CENTER",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "replyWhatsapp",
    labelKey: "PERM_REPLY_WHATSAPP",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "deleteWhatsappConversation",
    labelKey: "PERM_DELETE_WHATSAPP_CONVERSATION",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "sendWhatsappFiles",
    labelKey: "PERM_SEND_WHATSAPP_FILES",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "viewWhatsappCustomerData",
    labelKey: "PERM_VIEW_WHATSAPP_CUSTOMER_DATA",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "viewWhatsappStatement",
    labelKey: "PERM_VIEW_WHATSAPP_STATEMENT",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "useWhatsappAutoReply",
    labelKey: "PERM_USE_WHATSAPP_AUTO_REPLY",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "manageWhatsappWorkflows",
    labelKey: "PERM_MANAGE_WHATSAPP_WORKFLOWS",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "manageWhatsappAccounts",
    labelKey: "PERM_MANAGE_WHATSAPP_ACCOUNTS",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "manageWhatsappGateway",
    labelKey: "PERM_MANAGE_WHATSAPP_GATEWAY",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "manageCommunicationHub",
    labelKey: "PERM_MANAGE_COMMUNICATION_HUB",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "viewCommunicationHub",
    labelKey: "PERM_VIEW_COMMUNICATION_HUB",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  {
    key: "replyCommunicationHub",
    labelKey: "PERM_REPLY_COMMUNICATION_HUB",
    cat: "whatsapp",
    catLabelKey: "PERMCAT_WHATSAPP",
  },
  // ── [PERM-AUDIT-FIX-1] صلاحيات كانت مُستخدَمة فعليًا في استدعاءات
  // _checkPermission بأماكن متفرقة من المشروع لكنها لم تكن معرَّفة هنا —
  // وبما أن admin نفسه = ALL_PERMISSIONS.map(key)، كانت هذه العمليات
  // مرفوضة تلقائيًا لكل المستخدمين بمن فيهم admin (نفس فئة الخطأ الموثّقة
  // في تعليق الملف عن "تدقيق RBAC Phase 9"، لكنها حالات لم تُغطَّ هناك):
  //   - overrideMinPrice  → Code_33_BusinessRulesEngine.gs (canOverrideMinPrice)
  //   - viewLeaveBalance  → Code_15_HR.gs (getEmployeeLeaveBalance)
  //   - viewProductionStages → معرَّفة سابقًا فقط داخل ERP_PERMISSIONS (بلا
  //     أثر فعلي)، وأضفناها هنا كتفعيل حقيقي لفحص جديد أضيف على
  //     getProductionStages (كانت بدون أي فحص صلاحية إطلاقًا — انظر
  //     Code_16_Inventory.gs).
  // [ARCH-AUDIT-P2-6] manageDemoData اتشالت — Code_26_DemoDataGenerator.gs
  // والشاشة المرتبطة بيه اتحذفوا بالكامل من النظام (قرار صريح: الأداة
  // مكانش لها استخدام فعلي في الإنتاج).
  {
    key: "overrideMinPrice",
    labelKey: "PERM_OVERRIDE_MIN_PRICE",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  // [INV2-SETTINGS-2026-08-07] صلاحية شاشة إعدادات الفواتير العامة الجديدة
  // (Code_59_InvoiceSettingsEngine.js) — سياسة نظام كله (ترقيم/خصومات/ضرائب
  // /دورة حياة...)، منفصلة عن addSaleInvoice/addPurchaseInvoice.
  {
    key: "manageInvoiceSettings",
    labelKey: "PERM_MANAGE_INVOICE_SETTINGS",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  // [INV2-SETTINGS-2026-08-07] صلاحية تجاوز الحد الأقصى للخصم على مستوى
  // الفاتورة (max_discount_percent في إعدادات الفواتير) — نفس فلسفة
  // overrideMinPrice تمامًا.
  {
    key: "overrideDiscountLimit",
    labelKey: "PERM_OVERRIDE_DISCOUNT_LIMIT",
    cat: "invoices",
    catLabelKey: "PERMCAT_INVOICES",
  },
  {
    key: "viewLeaveBalance",
    labelKey: "PERM_VIEW_LEAVE_BALANCE",
    cat: "hr",
    catLabelKey: "PERMCAT_HR",
  },
  {
    key: "viewProductionStages",
    labelKey: "PERM_VIEW_PRODUCTION_STAGES",
    cat: "manufacturing",
    catLabelKey: "PERMCAT_MANUFACTURING",
  },
  // ── [UPDATE-MGMT-MODULE] وحدة إدارة تحديثات النظام ──
  // [MOVED-TO-HUB] صلاحية manageUpdates اتشالت نهائيًا من هنا. إدارة
  // الإصدارات/الإعلانات بقت في بروجيكت مركزي منفصل (MOO-UpdatesHub)
  // بيتحكم فيه المطوّر بس، مش أي أدمن في نسخة العميل. راجع
  // CLIENT_SNIPPET_Code_41.gs و README الخاص بالـ Hub.
];

// ─────────────────────────────────────────────────────────────
// §18-B  الأدوار الأساسية (Built-in) — لا يمكن حذفها
//
//  NOTE: يجب أن يطابق BUILTIN_PERMISSIONS في Permissions_Frontend.html
// ─────────────────────────────────────────────────────────────

var BUILTIN_PERMISSIONS = {
  admin: ALL_PERMISSIONS.map(function (p) {
    return p.key;
  }), // كل شيء

  // [AUTH-AUDIT-2026-07-28] كانت هنا 26 صلاحية بس، بينما نسخة الفرونت إند
  // (01_JS_Core_Auth.html → ROLE_PERMISSIONS.supervisor) فيها 89 صلاحية —
  // يعني مشرف كان بيشوف أزرار/شاشات ظاهرة (View Customers/Suppliers/HR/
  // Accounting...إلخ) لكن أي نداء فعلي للسيرفر كان بيترفض بصمت لأن
  // _checkPermission (البوابة الحقيقية) كانت بتقرأ من هنا. اتعمل توحيد
  // (Union) للقائمتين هنا — القائمة دي بقت المرجع الوحيد الحقيقي، ومطلوب
  // بعد كده تحديث نسخة 01_JS_Core_Auth.html لتطابقها (شوف نفس الـ tag هناك).
  supervisor: [
    "addItem",
    "updateItem",
    "addGroup",
    "updateGroup",
    "addWarehouse",
    "updateWarehouse",
    "addTransaction",
    "addBatchTransaction",
    "updateTransaction",
    "addProductionOrder",
    "updateProductionOrder",
    "updateProductionOrderStatus",
    "saveCuttingData",
    "addFgReceive",
    "addOpeningStock",
    "addShipment",
    "updateShipment",
    "viewShippingCompanies",
    "addColor",
    "updateColor",
    "addSize",
    "updateSize",
    "deleteSize",
    "addUnit",
    "updateUnit",
    "deleteUnit",
    "viewAuditLog",
    "saveItemWithColorSync",
    "importItems",
    // ── فواتير البيع والشراء ──
    "viewSaleInvoices",
    "addSaleInvoice",
    "deleteSaleInvoice",
    "viewPurchaseInvoices",
    "addPurchaseInvoice",
    "deletePurchaseInvoice",
    // ── فودافون كاش ──
    "viewVodafoneCash",
    "addVodafoneCashLine",
    "updateVodafoneCashLine",
    "addVodafoneCashTransaction",
    "updateVodafoneCashTransaction",
    // ── واتساب ──
    "sendWhatsapp",
    "manageWhatsappTemplates",
    "viewWhatsappLogs",
    "viewWhatsappCenter",
    "replyWhatsapp",
    "sendWhatsappFiles",
    "viewWhatsappCustomerData",
    "viewWhatsappStatement",
    "useWhatsappAutoReply",
    "overrideMinPrice",
    // ── [AUTH-AUDIT-2026-07-28] عملاء/موردين ──
    "viewCustomers",
    "addCustomer",
    "updateCustomer",
    "viewSuppliers",
    "addSupplier",
    "updateSupplier",
    // ── [AUTH-AUDIT-2026-07-28] محاسبة (عرض) ──
    "viewAccounting",
    "viewCashBoxes",
    "viewBankAccounts",
    "viewReceiptVouchers",
    "addReceiptVoucher",
    "printReceiptVoucher",
    "viewPaymentVouchers",
    "addPaymentVoucher",
    "printPaymentVoucher",
    "viewTransferVouchers",
    "viewTrialBalance",
    "viewAccountStatement",
    "viewChartOfAccounts",
    "viewJournalEntries",
    "viewGeneralLedger",
    "viewIncomeStatement",
    "viewBalanceSheet",
    "approveReceiptVoucher",
    "approvePaymentVoucher",
    // ── [AUTH-AUDIT-2026-07-28] الموارد البشرية ──
    "viewHR",
    "viewEmployees",
    "viewAttendance",
    "recordAttendance",
    "editAttendance",
    "importAttendance",
    "viewImportLog",
    "viewDepartments",
    "viewJobTitles",
    "updateEmployee",
    "updateDepartment",
    "updateJobTitle",
    "viewLeaveRequests",
    "requestLeave",
    "approveLeaveRequest",
    "manageLeaveTypes",
    "viewLoanRequests",
    "requestLoan",
    "approveLoanRequest",
    "viewPayslip",
    "viewPayroll",
  ],

  // [AUTH-AUDIT-2026-07-28] نفس مشكلة supervisor بالظبط — 9 صلاحيات كانت
  // موجودة في نسخة الفرونت إند بس ومفقودة هنا (عملاء/موردين/فواتير/واتساب/
  // فودافون كاش)، اتضافت هنا للتوحيد.
  operator: [
    "addTransaction",
    "addBatchTransaction",
    "addProductionOrder",
    "updateProductionOrderStatus",
    "saveCuttingData",
    "addFgReceive",
    "addShipment",
    "saveItemWithColorSync",
    // ── فواتير البيع والشراء ──
    "viewCustomers",
    "viewSuppliers",
    "viewSaleInvoices",
    "addSaleInvoice",
    "viewPurchaseInvoices",
    "addPurchaseInvoice",
    // ── فودافون كاش ──
    "viewVodafoneCash",
    "addVodafoneCashTransaction",
    // ── واتساب ──
    "sendWhatsapp",
  ],

  viewer: ["viewVodafoneCash"], // عرض فقط
};

// ─────────────────────────────────────────────────────────────
// §18-C  Headers للشيتات الجديدة
// ─────────────────────────────────────────────────────────────

var ROLES_HEADERS = [
  "id",
  "name",
  "label",
  "color",
  "permissions_json",
  "is_builtin",
  "created_at",
  "created_by",
];

var USER_PERM_HEADERS = [
  "username",
  "extra_json",
  "denied_json",
  "updated_at",
  "updated_by",
];

// ─────────────────────────────────────────────────────────────
// §18-D  دوال الأدوار (CRUD)
// ─────────────────────────────────────────────────────────────

/**
 * _localizedPermissions — يحوّل ALL_PERMISSIONS (key/labelKey/cat/catLabelKey)
 * إلى الشكل القديم الذي تتوقعه الواجهة (key/label/cat/catLabel) بعد ترجمة
 * كل مفتاح للغة المطلوبة. لا يغيّر أي كود فرونت-إند مستهلك — فقط يضمن أن
 * label/catLabel يظهران باللغة الصحيحة بدل نص عربي ثابت.
 * @param {string} [lang] - كود اللغة؛ افتراضيًا I18N_DEFAULT_LANG
 */
function _localizedPermissions(lang) {
  return ALL_PERMISSIONS.map(function (p) {
    return {
      key: p.key,
      label: i18nT(p.labelKey, lang),
      cat: p.cat,
      catLabel: i18nT(p.catLabelKey, lang),
    };
  });
}

/**
 * getAllPermissions — يُعيد قائمة كل الصلاحيات للواجهة
 */
function getAllPermissions(callerUser, sessionToken) {
  var lang =
    typeof resolveUserLanguage === "function"
      ? resolveUserLanguage(callerUser, sessionToken)
      : undefined;
  return { success: true, data: _localizedPermissions(lang) };
}

/**
 * getRoles — يجلب كل الأدوار (أساسية + مخصصة)
 */
function getRoles() {
  var builtin = [
    {
      id: "admin",
      name: "admin",
      label: "مدير النظام",
      color: "#ef4444",
      permissions: BUILTIN_PERMISSIONS.admin,
      is_builtin: true,
    },
    {
      id: "supervisor",
      name: "supervisor",
      label: "مشرف",
      color: "#f59e0b",
      permissions: BUILTIN_PERMISSIONS.supervisor,
      is_builtin: true,
    },
    {
      id: "operator",
      name: "operator",
      label: "موظف",
      color: "#2563eb",
      permissions: BUILTIN_PERMISSIONS.operator,
      is_builtin: true,
    },
    {
      id: "viewer",
      name: "viewer",
      label: "مشاهد",
      color: "#6b7280",
      permissions: [],
      is_builtin: true,
    },
  ];

  var customRoles = [];
  try {
    var rows = readSheet("Roles", ROLES_HEADERS, { trimStrings: true });
    customRoles = rows.map(function (r) {
      var perms = [];
      try {
        perms = JSON.parse(r.permissions_json || "[]");
      } catch (e) {
        console.error("getRoles - خطأ:", e.message || e);
      }
      return {
        id: r.id,
        name: r.name,
        label: r.label || r.name,
        color: r.color || "#6b7280",
        permissions: perms,
        is_builtin: false,
        created_at: r.created_at,
        created_by: r.created_by,
      };
    });
  } catch (e) {
    Logger.log("getRoles custom error: " + e.message);
  }

  return { success: true, data: builtin.concat(customRoles) };
}

/**
 * saveRole — إنشاء أو تعديل دور مخصص
 */
function saveRole(role, callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
  if (permErr) return permErr;

  try {
    if (!role || !role.name || !role.name.trim())
      return errResponse("اسم الدور مطلوب");

    // حماية الأدوار الأساسية — ديناميكيًا من BUILTIN_PERMISSIONS بدل قائمة
    // ثابتة، عشان تشمل تلقائيًا أي دور بقى Built-in فعليًا (زي accountant/
    // hr_manager/hr_specialist/cashier/user بعد [PERM-AUDIT-FIX-2])
    var builtinNames = Object.keys(BUILTIN_PERMISSIONS);
    if (builtinNames.indexOf(role.name.trim().toLowerCase()) !== -1)
      return errResponse(" لا يمكن تعديل الأدوار الأساسية");

    // حماية: الاسم لا يحتوي مسافات أو حروف خاصة
    if (!/^[a-z0-9_\u0600-\u06FF]+$/i.test(role.name.trim()))
      return errResponse("اسم الدور يجب أن يحتوي حروف وأرقام فقط بدون مسافات");

    var sheet = getSheet("Roles", ROLES_HEADERS);
    var rows = readSheet("Roles", ROLES_HEADERS, { trimStrings: true });
    var existing = rows.find(function (r) {
      return (
        r.id === role.id ||
        String(r.name || "").toLowerCase() === role.name.trim().toLowerCase()
      );
    });

    var permsJson = JSON.stringify(
      Array.isArray(role.permissions) ? role.permissions : [],
    );
    var label = (role.label || role.name).trim();
    var color = role.color || "#6b7280";

    if (existing) {
      sheet
        .getRange(existing._row, 1, 1, 8)
        .setValues([
          [
            existing.id,
            role.name.trim(),
            label,
            color,
            permsJson,
            "FALSE",
            existing.created_at || new Date(),
            existing.created_by || callerUser,
          ],
        ]);
      AuditEngine.log("UPDATE_ROLE", {
        user: callerUser,
        table: "Roles",
        record_id: existing.id,
        details:
          "تعديل دور: " + role.name + " | صلاحيات: " + role.permissions.length});
      // [PERM-ENG-ROLLOUT-3] تعديل صلاحيات دور موجود بيأثر على كل
      // مستخدميه دفعة واحدة — نمسح كاش PermissionEngine لكل واحد فيهم
      // صراحةً بدل انتظار TTL (120 ثانية).
      if (typeof PermissionEngine !== "undefined") {
        PermissionEngine.invalidateAll(role.name.trim());
      }
      return okResponse(" تم تحديث الدور بنجاح", { id: existing.id });
    } else {
      var id = makeId("ROLE");
      var _roleRow = [
        id,
        role.name.trim(),
        label,
        color,
        permsJson,
        "FALSE",
        new Date(),
        callerUser,
      ];
      // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
      // _appendRowProtected).
      sheet
        .getRange(sheet.getLastRow() + 1, 1, 1, _roleRow.length)
        .setFontColor(null);
      sheet.appendRow(_roleRow);
      AuditEngine.log("ADD_ROLE", {
        user: callerUser,
        table: "Roles",
        record_id: id,
        details:
          "إضافة دور جديد: " +
          role.name +
          " | صلاحيات: " +
          role.permissions.length});
      return okResponse(" تم إنشاء الدور بنجاح", { id: id });
    }
  } catch (e) {
    return errResponse("خطأ في حفظ الدور: " + e.message);
  }
}

/**
 * deleteRole — حذف دور مخصص (يمنع حذف المستخدمين المرتبطين)
 */
function deleteRole(roleId, callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
  if (permErr) return permErr;

  try {
    var rows = readSheet("Roles", ROLES_HEADERS, { trimStrings: true });
    var row = rows.find(function (r) {
      return r.id === roleId;
    });
    if (!row)
      return errResponse("الدور غير موجود أو هو دور أساسي لا يمكن حذفه");

    // تحقق إن مفيش مستخدمين بهذا الدور
    var users = readSheet("Users");
    var inUse = users.some(function (u) {
      return String(u.role || "").trim() === row.name;
    });
    if (inUse)
      return errResponse(
        " لا يمكن حذف الدور — يوجد مستخدمون مرتبطون به. غيّر دورهم أولاً.",
      );

    getSheet("Roles", ROLES_HEADERS).deleteRow(row._row);
    AuditEngine.log("DELETE_ROLE", {
      user: callerUser,
      table: "Roles",
      record_id: roleId,
      details: "حذف دور: " + row.name});
    return okResponse(" تم حذف الدور بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف الدور: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §18-E  Override الصلاحيات لكل مستخدم
// ─────────────────────────────────────────────────────────────

/**
 * getUserPermissionOverrides — يجلب الصلاحيات الإضافية والمحجوبة لمستخدم
 */
function getUserPermissionOverrides(username) {
  try {
    var rows = readSheet("UserPermissions", USER_PERM_HEADERS, {
      trimStrings: true,
    });
    var row = rows.find(function (r) {
      return (
        String(r.username || "")
          .trim()
          .toLowerCase() === String(username).trim().toLowerCase()
      );
    });
    if (!row) return { success: true, extra: [], denied: [] };

    var extra = [],
      denied = [];
    try {
      extra = JSON.parse(row.extra_json || "[]");
    } catch (e) {
      console.error("getUserPermissionOverrides - خطأ:", e.message || e);
    }
    try {
      denied = JSON.parse(row.denied_json || "[]");
    } catch (e) {
      console.error("getUserPermissionOverrides - خطأ:", e.message || e);
    }
    return { success: true, extra: extra, denied: denied };
  } catch (e) {
    return { success: true, extra: [], denied: [] };
  }
}

/**
 * saveUserPermissionOverrides — يحفظ overrides مستخدم
 * @param {string}   username   - اسم المستخدم
 * @param {string[]} extras     - صلاحيات إضافية فوق دوره
 * @param {string[]} denied     - صلاحيات محجوبة (تتغلب حتى على الـ admin)
 * @param {string}   callerUser - من نفّذ التعديل
 */
function saveUserPermissionOverrides(
  username,
  extras,
  denied,
  callerUser,
  sessionToken,
) {
  var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
  if (permErr) return permErr;

  try {
    // لا يجوز حجب manageRoles عن نفسك
    if (
      String(username).trim().toLowerCase() ===
      String(callerUser).trim().toLowerCase()
    ) {
      if (Array.isArray(denied) && denied.indexOf("manageRoles") !== -1)
        return errResponse(" لا يمكنك حجب صلاحية إدارة الأدوار عن نفسك");
    }

    var sheet = getSheet("UserPermissions", USER_PERM_HEADERS);
    var rows = readSheet("UserPermissions", USER_PERM_HEADERS, {
      trimStrings: true,
    });
    var existing = rows.find(function (r) {
      return (
        String(r.username || "")
          .trim()
          .toLowerCase() === String(username).trim().toLowerCase()
      );
    });

    var extraJson = JSON.stringify(extras || []);
    var deniedJson = JSON.stringify(denied || []);
    var now = new Date();

    if (existing) {
      sheet
        .getRange(existing._row, 1, 1, 5)
        .setValues([[username, extraJson, deniedJson, now, callerUser]]);
    } else {
      var _permRow = [username, extraJson, deniedJson, now, callerUser];
      // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
      // _appendRowProtected).
      sheet
        .getRange(sheet.getLastRow() + 1, 1, 1, _permRow.length)
        .setFontColor(null);
      sheet.appendRow(_permRow);
    }

    AuditEngine.log("UPDATE_USER_PERMS", {
      user: callerUser,
      table: "UserPermissions",
      record_id: username,
      details: "extras:" + extras.length + " | denied:" + denied.length});
    // [PERM-ENG-ROLLOUT-2] بعد تعديل extra/denied لمستخدم معيّن، لازم نمسح
    // كاش PermissionEngine الخاص بيه فورًا — وإلا هيفضل شغال بالصلاحيات
    // القديمة لحد ما الـ TTL (120 ثانية) ينتهي من نفسه.
    if (typeof PermissionEngine !== "undefined") {
      PermissionEngine.invalidate(username);
    }
    return okResponse(" تم حفظ صلاحيات المستخدم بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §18-F  _getRolePermissions — يحل اسم الدور لقائمة صلاحيات
// ─────────────────────────────────────────────────────────────

/**
 * يحل اسم دور (Role) إلى قائمة مفاتيح الصلاحيات الممنوحة له.
 *
 * Business Rules:
 * - يبحث أولًا في الأدوار الأساسية المبنية مسبقًا (BUILTIN_PERMISSIONS:
 *   admin/supervisor/operator/viewer...).
 * - إن لم يكن الدور أساسيًا، يبحث في شيت Roles (الأدوار المخصصة التي
 *   أنشأها الأدمن عبر saveRole)، حيث تُخزَّن الصلاحيات كـ JSON string
 *   في عمود permissions_json.
 * - دور غير موجود في أي من المصدرين يُعامَل كأنه بلا صلاحيات إطلاقًا
 *   (مصفوفة فارغة)، وليس كخطأ.
 *
 * @param {String} roleName - اسم الدور (افتراضي "viewer" لو فارغ).
 * @returns {Array<String>} مصفوفة مفاتيح الصلاحيات الممنوحة لهذا الدور.
 */
function _getRolePermissions(roleName) {
  var name = String(roleName || "viewer")
    .trim()
    .toLowerCase();

  // أدوار أساسية
  if (BUILTIN_PERMISSIONS[name]) return BUILTIN_PERMISSIONS[name];

  // أدوار مخصصة من الشيت
  try {
    var rows = readSheet("Roles", ROLES_HEADERS, { trimStrings: true });
    var row = rows.find(function (r) {
      return (
        String(r.name || "")
          .trim()
          .toLowerCase() === name
      );
    });
    if (row) {
      try {
        return JSON.parse(row.permissions_json || "[]");
      } catch (e) {
        return [];
      }
    }
  } catch (e) {
    Logger.log("_getRolePermissions error: " + e.message);
  }

  return [];
}

// ─────────────────────────────────────────────────────────────
// §18-G  _checkPermission — التحقق الرئيسي (مُحدَّث)
//
// يستبدل النسخة القديمة بالكامل.
//
//  الأولوية:
//   1. denied (محجوب للمستخدم) → يرفض حتى لو admin
//   2. role permissions → أذونات الدور
//   3. extra (إضافة فردية) → يسمح حتى لو الدور لا يملكها
// ─────────────────────────────────────────────────────────────

// [SEC-FIX-3] _checkPermission with optional session token verification
// username وحده لا يكفي — المهاجم يمكنه إرسال username: "admin" بدون جلسة حقيقية
// للحماية: يُمرَّر sessionToken مع كل طلب تعديل ويُتحقق منه هنا
/**
 * [BUG-FIX] _requirePermission — كانت تُستدعى في عدة مواضع في الكود
 * (CRUD العملاء/الموردين، استيراد الحضور) بدون أي تعريف لها أصلاً، فكانت
 * تطلق ReferenceError فوراً عند أول استدعاء — يعني addCustomer/addSupplier/
 * importAttendanceBatch وغيرهم كانوا معطّلين تماماً (يفشلوا بصمت بخطأ
 * "_requirePermission is not defined" بدل رسالة صلاحيات واضحة).
 *
 * الدالة دي wrapper فوق _checkPermission() الشغّالة فعلياً، بترمي Exception
 * عند الرفض (تتماشى مع طريقة استخدامها الحالية داخل try/catch بدون فحص
 * القيمة المرجعة)، وتقبل الاستدعاء بصيغتين:
 *   1) _requirePermission("username", "action")
 *   2) _requirePermission(payloadObject, "action")  حيث payloadObject
 *      فيه .callerUser أو .user و .sessionToken أو .token
 *
 * @param {string|object} callerOrPayload
 * @param {string} action
 * @returns {{user:string, sessionToken:string}}
 */
function _requirePermission(callerOrPayload, action) {
  var username = "";
  var token = "";
  if (typeof callerOrPayload === "string") {
    username = callerOrPayload;
  } else if (callerOrPayload && typeof callerOrPayload === "object") {
    username =
      callerOrPayload.callerUser ||
      callerOrPayload.user ||
      callerOrPayload.username ||
      callerOrPayload._user ||
      "";
    token =
      callerOrPayload.sessionToken ||
      callerOrPayload.token ||
      callerOrPayload._token ||
      "";
  }
  var permErr = _checkPermission(username, action, token);
  if (permErr) {
    throw new Error(permErr.message || " ليس لديك صلاحية: " + action);
  }
  return { user: username, sessionToken: token };
}

/**
 * البوابة المركزية للتحقق من صلاحية مستخدم لتنفيذ عملية معيّنة.
 * تُستدعى في بداية كل دالة إضافة/تعديل/حذف تقريبًا عبر كل موديولات
 * المشروع (Code_*.gs).
 *
 * Workflow:
 * 1. التأكد من وجود username وsessionToken (كلاهما إلزامي، fail-closed).
 * 2. التحقق من صلاحية الجلسة (validateSession) وأن التوكن يخص نفس
 *    username المُرسَل (لمنع انتحال هوية عبر إرسال اسم مستخدم مختلف
 *    عن صاحب الجلسة الفعلي).
 * 3. التأكد أن المستخدم موجود وحسابه نشط (active).
 * 4. حساب الصلاحيات الفعلية: صلاحيات الدور (_getRolePermissions) زائد
 *    الاستثناءات الفردية الممنوحة (extra) وناقص المحجوبة (denied).
 *
 * Business Rules:
 * - صلاحية محجوبة صراحةً لمستخدم (denied) تُرفض حتى لو كانت ضمن
 *   صلاحيات دوره الأساسي.
 * - أي رفض أو عدم تطابق هوية يُسجَّل في سجل التدقيق (AUTH_MISMATCH /
 *   DENIED) لأغراض الأمان والتتبع.
 *
 * @param {String} username - اسم المستخدم المطلوب فحص صلاحيته.
 * @param {String} action - مفتاح الصلاحية المطلوبة (من ALL_PERMISSIONS).
 * @param {String} sessionToken - توكن جلسة المستخدم.
 * @returns {Object|null} استجابة خطأ موحّدة (errResponse) عند الرفض،
 *   أو null إذا كانت العملية مسموحة.
 */
/**
 * _getUserRole — [BUG-FIX] كانت تُستدعى في CommunicationHub و WhatsApp
 * (getCommHubConversations, getWAUnreadCount, getWAConversations) دون أي
 * تعريف لها في المشروع بالكامل (ReferenceError عند كل استدعاء). أُضيفت
 * هنا بنفس منطق قراءة role المستخدم المستخدم فعلياً داخل _checkPermission
 * و getUserPermissions أدناه.
 * @param {String} username
 * @returns {String} role المستخدم، أو "viewer" كقيمة افتراضية آمنة
 */
function _getUserRole(username) {
  if (!username) return "viewer";
  try {
    var users = readSheet("Users");
    var user = users.find(function (u) {
      return (
        String(u.username || "")
          .trim()
          .toLowerCase() === String(username).trim().toLowerCase()
      );
    });
    return user ? String(user.role || "viewer").trim() : "viewer";
  } catch (e) {
    return "viewer";
  }
}

function _checkPermission(username, action, sessionToken) {
  if (!username) return errResponse("يجب تسجيل الدخول أولاً");

  // [SEC-FIX-H3] sessionToken بقى إلزامي وليس اختياريًا — fail-closed دائمًا.
  // الكود القديم كان يتحقق من الـ session فقط لو "if (sessionToken)"، فلو الطلب
  // اتبعت من غير sessionToken إطلاقًا (وليس توكن باطل) كان بيتخطى خطوة
  // التحقق من الجلسة بالكامل ويكمّل بصلاحيات الـ username المُرسَل زي ما هو.
  // ده كان بيخلّي أي حساب اسمه "system" (لو اتعمل يومًا) قابل للانتحال بسهولة
  // من أي حد يقدر ينادي google.script.run مباشرة من غير ما يمر بـ doPost.
  if (!sessionToken) {
    return errResponse(
      " جلسة غير صالحة — يرجى تسجيل الدخول مجدداً",
      "SESSION_INVALID",
    );
  }
  var sessCheck = validateSession(sessionToken);
  if (!sessCheck || !sessCheck.valid) {
    return errResponse(
      " جلستك انتهت أو غير صالحة — يرجى تسجيل الدخول مجدداً",
      "SESSION_INVALID",
    );
  }
  // تأكد أن الـ token يخص نفس المستخدم
  if (
    String(sessCheck.username || "")
      .trim()
      .toLowerCase() !== String(username).trim().toLowerCase()
  ) {
    AuditEngine.log("AUTH_MISMATCH:" + action, {
      user: username,
      table: "",
      record_id: "",
      details: " عدم تطابق بين username والـ session token"});
    return errResponse(" خطأ في التحقق من الهوية");
  }

  var users = readSheet("Users");
  var user = users.find(function (u) {
    return (
      String(u.username || "")
        .trim()
        .toLowerCase() === String(username).trim().toLowerCase()
    );
  });

  if (!user) return errResponse("المستخدم غير موجود");
  if (!_isActiveUser(user.active)) return errResponse("هذا الحساب موقوف");

  // ── [FORCE-PW-1] كانت هنا بوابة إلزامية بترفض أي عملية للمستخدم قبل
  // تغيير كلمة المرور الإلزامي. تم تعطيلها بطلب المطوّر (2026-07-26) —
  // لو احتجت ترجّعها تاني، فك التعليق عن البلوك اللي تحت.
  // if (_isForceChange(user.force_password_change)) {
  //   AuditEngine.log("BLOCKED_FORCE_PW_CHANGE:" + action, {
  //     user: username,
  //     table: "",
  //     record_id: "",
  //     details: " محاولة تنفيذ عملية قبل إكمال تغيير كلمة المرور الإلزامي"});
  //   return errResponse(
  //     " يجب تغيير كلمة المرور أولاً قبل تنفيذ أي عملية أخرى في النظام",
  //   );
  // }

  var role = String(user.role || "viewer").trim();
  var roleLower = role.toLowerCase();
  var isAdminRole = roleLower === "admin";
  var rolePerms = _getRolePermissions(role);
  var overrides = getUserPermissionOverrides(user.username);
  var extra = overrides.extra || [];
  var denied = overrides.denied || [];

  // ── [AUTH-AUDIT-2026-07-28] Administrator محصّن ضد أي "denied" override
  // شخصي عالق (مثلاً override قديم اتحفظ للمستخدم قبل ما يترقّى لـ admin،
  // أو غلطة إدارية) — الحساب اللي دوره admin المفروض ميكونش عليه أي قيد
  // غير مقصود إطلاقًا، طبقًا لمتطلب "Administrator صلاحيات كاملة دون أي
  // قيود غير مقصودة". باقي الأدوار لسه بتحترم denied زي ما هي بالظبط.
  if (isAdminRole) {
    _permDebugLog({
      user: username,
      role: role,
      action: action,
      result: "ALLOWED",
      reason: "الدور admin — صلاحيات كاملة دائمًا (denied overrides متجاهلة)",
    });
    return null;
  }

  // ── 1. هل الصلاحية محجوبة لهذا المستخدم؟ ───────────────
  if (denied.indexOf(action) !== -1) {
    AuditEngine.log("DENIED:" + action, {
      user: username,
      table: "",
      record_id: "",
      details: " محجوب للمستخدم شخصياً"});
    _permDebugLog({
      user: username,
      role: role,
      action: action,
      result: "DENIED",
      reason: "الصلاحية محجوبة صراحةً لهذا المستخدم (denied override)",
    });
    return errResponse(" هذه الصلاحية محجوبة لحسابك (" + action + ")");
  }

  // ── 2. هل لديه الصلاحية من دوره أو override إضافي؟ ────
  var allowed =
    rolePerms.indexOf(action) !== -1 || extra.indexOf(action) !== -1;

  if (!allowed) {
    AuditEngine.log("DENIED:" + action, {
      user: username,
      table: "",
      record_id: "",
      details: " ليس في صلاحيات الدور: " + role});
    _permDebugLog({
      user: username,
      role: role,
      action: action,
      result: "DENIED",
      reason: "الصلاحية غير موجودة في صلاحيات الدور (" + role + ") ولا في extra overrides",
    });
    return errResponse(" ليس لديك صلاحية لهذه العملية (" + action + ")");
  }

  _permDebugLog({
    user: username,
    role: role,
    action: action,
    result: "ALLOWED",
    reason:
      rolePerms.indexOf(action) !== -1
        ? "ضمن صلاحيات الدور (" + role + ")"
        : "ممنوحة كاستثناء فردي (extra override)",
  });

  return null; // مسموح
}

// ─────────────────────────────────────────────────────────────
// [AUTH-AUDIT-2026-07-28] Permission Debug Mode
// ─────────────────────────────────────────────────────────────
// يُفعَّل بس للمطوّر (Script Property باسم PERMISSION_DEBUG_MODE = "true")
// — لما يكون مفعّل، كل قرار صلاحية (مسموح/مرفوض) بيتسجّل في Logger.log
// (سجل التنفيذ في Apps Script Editor: Executions/Logs) بتفاصيل كاملة:
// المستخدم، الدور، العملية، النتيجة، والسبب الدقيق. الهدف تسهيل اكتشاف
// سبب منع أي عملية بسرعة، خصوصًا لو ظهر إن admin ممنوع من حاجة كان
// المفروض تبقى متاحة له.
// التفعيل: PropertiesService.getScriptProperties().setProperty(
//            "PERMISSION_DEBUG_MODE", "true");
// التعطيل: نفس السطر بقيمة "false" (أو حذف الـ property خالص).
function _isPermDebugEnabled() {
  try {
    return (
      PropertiesService.getScriptProperties().getProperty(
        "PERMISSION_DEBUG_MODE",
      ) === "true"
    );
  } catch (e) {
    return false;
  }
}

function _permDebugLog(entry) {
  if (!_isPermDebugEnabled()) return;
  try {
    Logger.log(
      "[PERM-DEBUG] user=%s role=%s action=%s result=%s reason=%s",
      entry.user,
      entry.role,
      entry.action,
      entry.result,
      entry.reason,
    );
  } catch (e) {
    /* التسجيل تحسين تشخيصي فقط — لا يجب أن يكسر التحقق نفسه لو فشل */
  }
}

// ─────────────────────────────────────────────────────────────
// [REMEDIATION-8] صلاحية مستوى الحقل للراتب
// ─────────────────────────────────────────────────────────────
// تحذف/تصفّر basic_salary و salary_currency من كائن/مصفوفة موظف قبل
// إرجاعها للفرونت إند، إلا لو المستخدم عنده صلاحية "viewSalary" صراحةً.
// الفلترة هنا في السيرفر مقصودة — إخفاء العمود في الواجهة فقط لا يكفي
// لأن أي فحص لاستجابة الشبكة كان هيكشف القيمة الحقيقية.
// لو تعذّر التحقق من الهوية (مفيش callerUser) بنتعامل معاها بأمان (fail-safe)
// يعني: نخفي الراتب افتراضياً، مش نعرضه.
function _filterSalaryFields(empOrList, callerUser, sessionToken) {
  var canView = false;
  try {
    canView =
      !!callerUser &&
      _checkPermission(callerUser, "viewSalary", sessionToken) === null;
  } catch (e) {
    canView = false;
  }
  if (canView) return empOrList; // معه الصلاحية → يرجع زي ما هو من غير تعديل

  var strip = function (emp) {
    if (!emp || typeof emp !== "object") return emp;
    if ("basic_salary" in emp) emp.basic_salary = null;
    if ("salary_currency" in emp) emp.salary_currency = null;
    return emp;
  };
  if (Array.isArray(empOrList)) {
    empOrList.forEach(strip);
    return empOrList;
  }
  return strip(empOrList);
}

// ─────────────────────────────────────────────────────────────
// [REMEDIATION-6] Job History بسيط للموظف
// ─────────────────────────────────────────────────────────────
// يسجّل سطراً في EmployeeJobHistory *قبل* ما تُكتب القيمة الجديدة فوق القديمة
// في Employees. changeType متوقَّع تكون واحدة من: "SALARY" | "DEPARTMENT" | "JOB_TITLE"
// (أو أي نوع تغيير مستقبلي تحب تضيفه بنفس النمط).
// فشل التسجيل هنا (مثلاً مشكلة مؤقتة في الشيت) لا يجب أبداً أن يمنع
// تحديث بيانات الموظف نفسه — فبنبلع أي استثناء ونسجّله في الـ Logger فقط،
// نفس فلسفة الأمان المتّبعة في بقية دوال الـ audit/cache غير الحرجة.
function _logEmployeeJobHistory(
  employeeId,
  changeType,
  oldValue,
  newValue,
  changedBy,
  effectiveDate,
) {
  try {
    var sheet = getSheet(
      "EmployeeJobHistory",
      ACCOUNTING_HR_HEADERS.EmployeeJobHistory,
    );
    var now = new Date().toISOString();
    _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.EmployeeJobHistory, [
      makeId("JH"),
      employeeId,
      changeType,
      effectiveDate || now.split("T")[0],
      oldValue === undefined || oldValue === null
        ? ""
        : JSON.stringify(oldValue),
      newValue === undefined || newValue === null
        ? ""
        : JSON.stringify(newValue),
      changedBy || "SYSTEM",
      now,
    ]);
  } catch (e) {
    console.error("_logEmployeeJobHistory:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §18-H  getUserPermissions — للـ frontend
// ─────────────────────────────────────────────────────────────

/**
 * يجلب كل صلاحيات مستخدم (فعّالة + تفاصيل)
 * يُستدعى بعد تسجيل الدخول ليحفظ APP.currentUser.permissions
 */
function getUserPermissions(username) {
  try {
    if (!username) return errResponse("اسم المستخدم مطلوب");

    // [PERF-LOGIN-7] كانت readSheet("Users") — قراءة مباشرة بدون كاش،
    // بتعمل round-trip كامل لـ Sheets API حتى لو login() جاب نفس البيانات
    // لتوّه (عبر _getSheetUsers المكاشة). بما إن الاتنين بيرجّعوا نفس شكل
    // الصفوف بالظبط (نفس readSheet("Users") تحت الغطاء)، الاستبدال آمن
    // ومطابق تمامًا للسلوك القديم، وبيوفر استدعاء API كامل في كل تسجيل دخول.
    var users =
      typeof _getSheetUsers === "function" ? _getSheetUsers() : readSheet("Users");
    var user = users.find(function (u) {
      return (
        String(u.username || "")
          .trim()
          .toLowerCase() === String(username).trim().toLowerCase()
      );
    });
    if (!user) return errResponse("المستخدم غير موجود");

    var role = String(user.role || "viewer").trim();
    var rolePerms = _getRolePermissions(role);
    var overrides = getUserPermissionOverrides(username);
    var extra = overrides.extra || [];
    var denied = overrides.denied || [];

    // [AUTH-AUDIT-2026-07-28] admin محصّن ضد denied overrides هنا كمان —
    // effectivePermissions هي اللي بتبني بيها الواجهة القوائم/الأزرار
    // الظاهرة (PermissionEngine.canSeeMenu/canAccessScreen...) فلو استثنينا
    // admin من الفحص في _checkPermission بس وسبنا القائمة دي زي ما هي،
    // كانت هتفضل الشاشة/الزرار مخفيين في الواجهة حتى لو التنفيذ الفعلي
    // هيسمح — تناقض. فبالنسبة لـ admin: effective = كل صلاحياته (rolePerms
    // أصلاً = ALL_PERMISSIONS كاملة) من غير أي طرح denied.
    var isAdminUser = role.toLowerCase() === "admin";
    var effective = isAdminUser
      ? rolePerms.slice()
      : rolePerms
          .concat(
            extra.filter(function (p) {
              return rolePerms.indexOf(p) === -1;
            }),
          )
          .filter(function (p) {
            return denied.indexOf(p) === -1;
          });

    // جلب كل الأدوار المتاحة
    var rolesResult = getRoles();
    var allRoles = (
      rolesResult.success && rolesResult.data ? rolesResult.data : []
    ).map(function (r) {
      return { id: r.id, name: r.name, label: r.label, color: r.color };
    });

    return {
      success: true,
      role: role,
      rolePermissions: rolePerms,
      extraPermissions: extra,
      deniedPermissions: denied,
      effectivePermissions: effective,
      allRoles: allRoles,
    };
  } catch (e) {
    return errResponse("خطأ في جلب الصلاحيات: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §18-I  getPermissionMatrix — لواجهة إدارة الصلاحيات
// ─────────────────────────────────────────────────────────────

/**
 * يجلب المصفوفة الكاملة: أدوار × صلاحيات + overrides كل مستخدم
 * يُستخدم في صفحة "مدير الصلاحيات"
 */
function getPermissionMatrix(callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
  if (permErr) return permErr;

  try {
    var rolesResult = getRoles();

    // اجمع كل overrides المستخدمين
    var userOverrides = {};
    try {
      var overrideRows = readSheet("UserPermissions", USER_PERM_HEADERS, {
        trimStrings: true,
      });
      overrideRows.forEach(function (r) {
        var extra = [];
        var denied = [];
        try {
          extra = JSON.parse(r.extra_json || "[]");
        } catch (e) {
          console.error("getPermissionMatrix - خطأ:", e.message || e);
        }
        try {
          denied = JSON.parse(r.denied_json || "[]");
        } catch (e) {
          console.error("getPermissionMatrix - خطأ:", e.message || e);
        }
        userOverrides[String(r.username || "").trim()] = {
          extra: extra,
          denied: denied,
          updated_at: r.updated_at,
          updated_by: r.updated_by,
        };
      });
    } catch (e) {
      console.error("getPermissionMatrix - خطأ:", e.message || e);
    }

    // اجمع بيانات المستخدمين (بدون باسوردات)
    var usersData = readSheet("Users").map(function (u) {
      return {
        username: u.username,
        full_name: u.full_name,
        role: u.role,
        active: u.active,
        last_login: u.last_login,
      };
    });

    return {
      success: true,
      roles: rolesResult.data,
      permissions: _localizedPermissions(
        typeof resolveUserLanguage === "function"
          ? resolveUserLanguage(callerUser, sessionToken)
          : undefined,
      ),
      userOverrides: userOverrides,
      users: usersData,
    };
  } catch (e) {
    return errResponse("خطأ في جلب مصفوفة الصلاحيات: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// §18-J  ensurePermissionSheets — تأكد إن الشيتات موجودة
//         شغّلها مرة واحدة من Apps Script Editor
// ─────────────────────────────────────────────────────────────

/**
 * أداة إعداد يدوية: تتأكد من وجود شيتات Roles وUserPermissions
 * بترويستهما الصحيحة (تُنشئهما إن لم يكونا موجودَين). تُشغَّل مرة
 * واحدة من محرر Apps Script بعد أول نشر للنظام أو بعد ترقية تضيف
 * ميزة الأدوار المخصصة/الاستثناءات الفردية.
 *
 * @returns {String} رسالة تأكيد.
 */
function ensurePermissionSheets() {
  getSheet("Roles", ROLES_HEADERS);
  getSheet("UserPermissions", USER_PERM_HEADERS);
  return " تم إنشاء شيتات الصلاحيات بنجاح";
}

// ─────────────────────────────────────────────────────────────
// §18-K  تحديث PERMISSIONS القديم للتوافق مع الكود الموجود
//         (نفس القيمة من BUILTIN_PERMISSIONS)
// ─────────────────────────────────────────────────────────────

var PERMISSIONS = BUILTIN_PERMISSIONS; // backward compatibility

// ─────────────────────────────────────────────────────────────
// §18-L  ERP v5 — صلاحيات المحاسبة وHR
// ─────────────────────────────────────────────────────────────
var ERP_PERMISSIONS = {
  viewChartOfAccounts: ["admin", "accountant", "supervisor"],
  addChartAccount: ["admin", "accountant"],
  updateChartAccount: ["admin", "accountant"],
  deleteChartAccount: ["admin"],
  viewCashBoxes: ["admin", "accountant", "cashier", "supervisor"],
  addCashBox: ["admin", "accountant"],
  updateCashBox: ["admin", "accountant"],
  deleteCashBox: ["admin"],
  viewBankAccounts: ["admin", "accountant", "cashier", "supervisor"],
  addBankAccount: ["admin", "accountant"],
  updateBankAccount: ["admin", "accountant"],
  deleteBankAccount: ["admin"],
  viewJournalEntries: ["admin", "accountant", "cashier"],
  addJournalEntry: ["admin", "accountant"],
  updateJournalEntry: ["admin", "accountant"],
  deleteJournalEntry: ["admin", "accountant"],
  postJournalEntry: ["admin", "accountant"],
  reverseJournalEntry: ["admin", "accountant"],
  exportJournalEntryPdf: ["admin", "accountant", "cashier"],
  // [PERIOD-CLOSING] الإغلاق/الفتح admin بس عمدًا — قرار مالي حساس ومقصود
  // يتحصر في أعلى صلاحية بالنظام، مش المحاسب العادي (accountant)
  viewAccountingPeriods: ["admin", "accountant"],
  closeAccountingPeriod: ["admin"],
  reopenAccountingPeriod: ["admin"],
  viewReceiptVouchers: ["admin", "accountant", "cashier", "supervisor"],
  addReceiptVoucher: ["admin", "accountant", "cashier", "supervisor"],
  approveReceiptVoucher: ["admin", "accountant"],
  printReceiptVoucher: ["admin", "accountant", "cashier", "supervisor"],
  viewPaymentVouchers: ["admin", "accountant", "cashier", "supervisor"],
  addPaymentVoucher: ["admin", "accountant", "cashier", "supervisor"],
  approvePaymentVoucher: ["admin", "accountant"],
  printPaymentVoucher: ["admin", "accountant", "cashier", "supervisor"],
  viewExpenses: ["admin", "accountant", "cashier", "supervisor"],
  addExpense: ["admin", "accountant", "cashier", "supervisor"],
  updateExpense: ["admin", "accountant"],
  deleteExpense: ["admin", "accountant"],
  approveExpense: ["admin", "accountant"],
  cancelExpense: ["admin", "accountant"],
  viewTransferVouchers: ["admin", "accountant", "cashier"],
  addTransferVoucher: ["admin", "accountant"],
  approveTransferVoucher: ["admin", "accountant"],
  viewBankReconciliation: ["admin", "accountant"],
  addBankReconciliation: ["admin", "accountant"],
  completeBankReconciliation: ["admin", "accountant"],
  deleteBankReconciliation: ["admin"],
  viewGeneralLedger: ["admin", "accountant"],
  viewTrialBalance: ["admin", "accountant", "supervisor"],
  viewIncomeStatement: ["admin", "accountant", "supervisor"],
  viewBalanceSheet: ["admin", "accountant", "supervisor"],
  viewAccountStatement: ["admin", "accountant", "cashier", "supervisor"],
  viewAccounting: ["admin", "accountant", "cashier", "supervisor"],
  viewDepartments: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  addDepartment: ["admin", "hr_manager"],
  updateDepartment: ["admin", "hr_manager"],
  deleteDepartment: ["admin"],
  viewJobTitles: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  addJobTitle: ["admin", "hr_manager"],
  updateJobTitle: ["admin", "hr_manager"],
  deleteJobTitle: ["admin"],
  viewEmployees: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  addEmployee: ["admin", "hr_manager", "hr_specialist"],
  updateEmployee: ["admin", "hr_manager", "hr_specialist"],
  deleteEmployee: ["admin", "hr_manager"],
  viewAttendance: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  recordAttendance: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  editAttendance: ["admin", "hr_manager"],
  viewLeaveRequests: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  viewLeaveBalance: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  requestLeave: ["admin", "hr_manager", "hr_specialist", "supervisor", "user"],
  approveLeaveRequest: ["admin", "hr_manager", "supervisor"],
  deleteLeaveRequest: ["admin", "hr_manager"],
  manageLeaveTypes: ["admin", "hr_manager"],
  viewLoanRequests: ["admin", "hr_manager", "hr_specialist"],
  requestLoan: ["admin", "hr_manager", "hr_specialist", "supervisor", "user"],
  approveLoanRequest: ["admin", "hr_manager"],
  deleteLoanRequest: ["admin", "hr_manager"],
  viewPayroll: ["admin", "hr_manager"],
  generatePayroll: ["admin", "hr_manager"],
  approvePayroll: ["admin"],
  payPayroll: ["admin"],
  viewPayslip: ["admin", "hr_manager", "hr_specialist", "supervisor", "user"],
  viewHR: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  // ── [SALARY-COMPONENTS-P1] بنود الرواتب + البدلات والخصومات لكل موظف ──
  viewSalaryComponents: ["admin", "hr_manager", "hr_specialist"],
  addSalaryComponent: ["admin", "hr_manager"],
  updateSalaryComponent: ["admin", "hr_manager"],
  deleteSalaryComponent: ["admin"],
  addEmployeeAllowance: ["admin", "hr_manager"],
  updateEmployeeAllowance: ["admin", "hr_manager"],
  deleteEmployeeAllowance: ["admin", "hr_manager"],
  addEmployeeDeduction: ["admin", "hr_manager"],
  updateEmployeeDeduction: ["admin", "hr_manager"],
  deleteEmployeeDeduction: ["admin", "hr_manager"],
  // ── مراحل الإنتاج ──
  viewProductionStages: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  addProductionStage: ["admin", "hr_manager"],
  updateProductionStage: ["admin", "hr_manager"],
  deleteProductionStage: ["admin"],
  addStageExecution: ["admin", "hr_manager", "hr_specialist", "supervisor"],
  deleteStageExecution: ["admin", "hr_manager"],
  // ── §MFG-P0  موديول التصنيع الجديد ──
  viewManufacturing: ["admin", "supervisor", "accountant"],
  viewWorkCenters: ["admin", "supervisor"],
  manageWorkCenters: ["admin"],
  viewBOM: ["admin", "supervisor"],
  manageBOM: ["admin"],
  viewRouting: ["admin", "supervisor"],
  manageRouting: ["admin"],
  viewManufacturingOrders: ["admin", "supervisor"],
  addManufacturingOrder: ["admin", "supervisor"],
  updateManufacturingOrder: ["admin", "supervisor"],
  deleteManufacturingOrder: ["admin"],
  approveManufacturingOrder: ["admin"],
  releaseManufacturingOrder: ["admin", "supervisor"],
  closeManufacturingOrder: ["admin", "supervisor"],
  reopenManufacturingOrder: ["admin"],
  cancelManufacturingOrder: ["admin", "supervisor"],
  overrideMaterialLimit: ["admin"],
  issueMaterial: ["admin", "supervisor"],
  receiveFinishedGoods: ["admin", "supervisor"],
  viewQualityInspections: ["admin", "supervisor"],
  addQualityInspection: ["admin", "supervisor"],
  approveQualityRejection: ["admin"],
  manageSubcontractors: ["admin"],
  manageSubcontractShipments: ["admin", "supervisor"],
  viewManufacturingCosting: ["admin", "accountant"],
  manageManufacturingCostSettings: ["admin"],
};

// [PERM-AUDIT-FIX-2] الدمج القديم كان:
//   Object.keys(ERP_PERMISSIONS).forEach(k => PERMISSIONS[k] = ERP_PERMISSIONS[k]);
// وده كان بيحقن كل مفتاح صلاحية (زي viewChartOfAccounts) كمفتاح top-level
// جديد في BUILTIN_PERMISSIONS نفسه (لأن PERMISSIONS = BUILTIN_PERMISSIONS
// بنفس المرجع) — لكن _getRolePermissions(roleName) بتقرأ
// BUILTIN_PERMISSIONS[roleName] في الاتجاه المعاكس (اسم الدور ← صلاحياته).
// النتيجة: قاموس ERP_PERMISSIONS بالكامل (117 مفتاح، يغطي كل صلاحيات
// المحاسبة/HR/التصنيع) ما كانش بيتقرأ من أي مكان أبدًا — الدور الفعلي
// لأي مستخدم دوره "accountant"/"hr_manager"/"hr_specialist"/"cashier" كان
// بيعتمد كليًا على تعريفه اليدوي في شيت Roles (لو موجود أصلاً)، وليس على
// هذا القاموس رغم إنه بيوثّق نفسه كمصدر الحقيقة لصلاحيات هذه الأدوار.
//
// الإصلاح: نعكس الاتجاه فعليًا هنا — نبني لكل اسم دور مذكور كقيمة داخل
// ERP_PERMISSIONS مصفوفة صلاحياته الحقيقية، ونضيفها إلى BUILTIN_PERMISSIONS
// بشكل تراكمي (union مع أي قائمة موجودة مسبقًا لنفس الدور، بدل استبدالها) —
// فتصبح "accountant" و"hr_manager" و"hr_specialist" و"cashier" و"user" أدوارًا
// أساسية (Built-in) فعلية بنفس قوة admin/supervisor/operator/viewer، بدل ما
// تكون معتمدة على وجود صف مطابق في شيت Roles قد لا يكون أحد أنشأه أصلاً.
(function _wireErpPermissionsIntoBuiltinRoles() {
  var roleToPerms = {};
  Object.keys(ERP_PERMISSIONS).forEach(function (permKey) {
    var roles = ERP_PERMISSIONS[permKey] || [];
    roles.forEach(function (roleName) {
      if (!roleToPerms[roleName]) roleToPerms[roleName] = [];
      roleToPerms[roleName].push(permKey);
    });
  });
  Object.keys(roleToPerms).forEach(function (roleName) {
    var existing = BUILTIN_PERMISSIONS[roleName] || [];
    var merged = existing.slice();
    roleToPerms[roleName].forEach(function (p) {
      if (merged.indexOf(p) === -1) merged.push(p);
    });
    BUILTIN_PERMISSIONS[roleName] = merged;
  });
})();


// ── [نُقل من §18-WH — Warehouse-Level Access Control] ──

// ┄┄┄ [مصدر: Code.js سطور 12587-13088] Warehouse Access Control + Security Setup ┄┄┄
// §18-WH  Warehouse-Level Access Control  (v4.1 — جديد)
//
// saveWarehouseAccess()      — تعيين مخازن مستخدم
// getUserWarehouseAccess()   — جلب المخازن المسموح بها
// _checkWarehouseAccess()    — تحقق داخلي قبل أي عملية
// getAllDataForUser()         — getAllData مُفلتَر حسب مخازن المستخدم
// ─────────────────────────────────────────────────────────────

// WH_ACCESS_HEADERS مُعرَّفة في §01 — لا تكرار هنا

/**
 * saveWarehouseAccess — تعيين المخازن المسموح بها لمستخدم
 * @param {string}   username   - اسم المستخدم
 * @param {string[]} warehouses - أسماء المخازن (فارغة = كل المخازن مسموحة)
 * @param {string}   callerUser - المنفذ
 */
function saveWarehouseAccess(username, warehouses, callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
  if (permErr) return permErr;
  try {
    var sheet = getSheet("WarehouseAccess", WH_ACCESS_HEADERS);
    var rows = readSheet("WarehouseAccess", WH_ACCESS_HEADERS, {
      trimStrings: true,
    });
    var existing = rows.find(function (r) {
      return (
        String(r.username || "").toLowerCase() ===
        String(username).toLowerCase()
      );
    });
    var whJson = JSON.stringify(Array.isArray(warehouses) ? warehouses : []);
    var now = new Date();
    if (existing) {
      sheet
        .getRange(existing._row, 1, 1, 4)
        .setValues([[username, whJson, now, callerUser]]);
    } else {
      var _whPermRow = [username, whJson, now, callerUser];
      // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
      // _appendRowProtected).
      sheet
        .getRange(sheet.getLastRow() + 1, 1, 1, _whPermRow.length)
        .setFontColor(null);
      sheet.appendRow(_whPermRow);
    }
    AuditEngine.log("UPDATE_WH_ACCESS", {
      user: callerUser,
      table: "WarehouseAccess",
      record_id: username,
      details: "تعيين مخازن للمستخدم: " + warehouses.length + " مخزن",
      newValue: { warehouses: warehouses }});
    _invalidateServerCache();
    // [PERM-ENG-ROLLOUT-5] نفس نمط saveRole/saveUserPermissionOverrides —
    // تعديل صلاحيات المخازن لمستخدم لازم يمسح كاش PermissionEngine الخاص
    // بيه فورًا، وإلا هيفضل شغال بصلاحيات المخازن القديمة لحد ما الـ TTL
    // (120 ثانية) ينتهي من نفسه.
    if (typeof PermissionEngine !== "undefined") {
      PermissionEngine.invalidate(username);
    }
    return okResponse(" تم حفظ صلاحيات المخازن للمستخدم");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * getUserWarehouseAccess — جلب المخازن المسموح بها لمستخدم
 * @returns {string[]} فارغة = كل المخازن مسموحة
 */
function getUserWarehouseAccess(username) {
  try {
    var rows = readSheet("WarehouseAccess", WH_ACCESS_HEADERS, {
      trimStrings: true,
    });
    var row = rows.find(function (r) {
      return (
        String(r.username || "").toLowerCase() ===
        String(username || "").toLowerCase()
      );
    });
    if (!row || !row.allowed_warehouses) return [];
    var allowed = [];
    try {
      allowed = JSON.parse(row.allowed_warehouses);
    } catch (e) {
      console.error("getUserWarehouseAccess - خطأ:", e.message || e);
    }
    return Array.isArray(allowed) ? allowed : [];
  } catch (e) {
    return [];
  }
}

/**
 * _checkWarehouseAccess — تحقق داخلي: هل للمستخدم وصول لمخزن بعينه؟
 * @returns {object|null} null = مسموح، errResponse = مرفوض
 */
function _checkWarehouseAccess(username, warehouseName) {
  try {
    var users = readSheet("Users");
    var user = users.find(function (u) {
      return (
        String(u.username || "").toLowerCase() ===
        String(username || "").toLowerCase()
      );
    });
    if (user && user.role === "admin") return null; // admin دائماً مسموح

    var allowed = getUserWarehouseAccess(username);
    if (!allowed || allowed.length === 0) return null; // لا قيود

    var whNorm = String(warehouseName || "")
      .trim()
      .toLowerCase();
    var hasAccess = allowed.some(function (wh) {
      return (
        String(wh || "")
          .trim()
          .toLowerCase() === whNorm
      );
    });
    if (!hasAccess) {
      AuditEngine.log("DENIED:WAREHOUSE_ACCESS", {
        user: username,
        table: "Warehouses",
        record_id: warehouseName,
        details: " ليس له وصول لمخزن: " + warehouseName});
      return errResponse(" ليس لديك صلاحية الوصول لمخزن: " + warehouseName);
    }
    return null;
  } catch (e) {
    // [PERM-AUDIT-FIX-3] كانت هنا "return null" (فشل مفتوح — يسمح بصمت عند
    // أي استثناء)، بعكس نمط fail-closed المتّبع عمدًا في _checkPermission
    // بنفس الملف. لو فيه قيد مخزن فعلي مطلوب فحصه ولقينا خطأ غير متوقع أثناء
    // الفحص، الأصوب رفض العملية مع رسالة واضحة بدل السماح ضمنيًا.
    AuditEngine.log("ERROR:WAREHOUSE_ACCESS_CHECK", {
      user: username,
      table: "Warehouses",
      record_id: warehouseName,
      details: " خطأ أثناء فحص صلاحية المخزن: " + e.message});
    if (!warehouseName) return null; // لا يوجد مخزن محدد للفحص أصلاً
    return errResponse(
      " تعذّر التحقق من صلاحية الوصول لمخزن: " + warehouseName,
    );
  }
}


/**
 * getAllDataForUser — نسخة مُفلتَرة من getAllData
 * تُعيد فقط بيانات المخازن والرصيد والحركات المسموحة للمستخدم
 * استخدمها في الفرونت بدل getAllData() لصفحة الرصيد والتقارير
 */
function getAllDataForUser(callerUser, sessionToken, sourceData) {
  try {
    var authErr = _checkPermission(callerUser, "viewDashboard", sessionToken);
    if (authErr) return authErr;
    var fullData = sourceData || _getAllDataRaw();
    var allowed = getUserWarehouseAccess(callerUser);
    if (!allowed || allowed.length === 0) return fullData; // لا قيود

    var allowedLower = allowed.map(function (w) {
      return String(w).trim().toLowerCase();
    });

    if (fullData.warehouses) {
      fullData.warehouses = fullData.warehouses.filter(function (w) {
        return (
          allowedLower.indexOf(
            String(w.name || "")
              .trim()
              .toLowerCase(),
          ) !== -1
        );
      });
    }
    if (fullData.stock) {
      fullData.stock = fullData.stock.filter(function (s) {
        return (
          allowedLower.indexOf(
            String(s.warehouse || "")
              .trim()
              .toLowerCase(),
          ) !== -1
        );
      });
    }
    if (fullData.transactions) {
      fullData.transactions = fullData.transactions.filter(function (t) {
        var from = String(t.from_warehouse || "")
          .trim()
          .toLowerCase();
        var to = String(t.to_warehouse || "")
          .trim()
          .toLowerCase();
        return (
          !from ||
          allowedLower.indexOf(from) !== -1 ||
          !to ||
          allowedLower.indexOf(to) !== -1
        );
      });
    }
    return fullData;
  } catch (e) {
    // [SEC-FIX] fail-closed بدل fail-open: لو حصل استثناء أثناء الفلترة،
    // كان الكود القديم يرجع getAllData() الكاملة غير مُصفّاة (تسريب بيانات
    // كل المخازن). الآن نرجع بيانات مقيَّدة/فارغة ونسجّل الحادثة، بدل
    // المخاطرة بكشف بيانات مخازن غير مصرَّح للمستخدم برؤيتها.
    AuditEngine.log("GET_ALL_DATA_FOR_USER_FILTER_ERROR", {
      user: callerUser,
      details: String((e && e.message) || e)});
    return {
      warehouses: [],
      stock: [],
      transactions: [],
      error: "تعذّر تطبيق قيود الوصول للمخازن — تم رفض الطلب لأسباب أمنية",
    };
  }
}

/**
 * ============================================================
 * تقرير المراجعة الداخلي — Code_Permissions.gs
 * (Comment Refactoring فقط — بدون أي تغيير في المنطق أو السلوك)
 * ============================================================
 *
 * ما تم توثيقه:
 * - Header احترافي كامل لبداية الملف.
 * - JSDoc كامل للدوال الثلاث التي لم يكن لها أي تعليق سابق:
 *   _getRolePermissions (حل اسم الدور لصلاحياته)، _checkPermission
 *   (البوابة المركزية للتحقق من الصلاحيات — أهم دالة في الملف)،
 *   وensurePermissionSheets (أداة إعداد الشيتات).
 * - توثيق ALL_PERMISSIONS بشرح بنية كل عنصر (key/label/cat/catLabel)
 *   وربطها صراحةً باكتشاف تدقيق RBAC (Phase 9) الخاص بمفاتيح
 *   صلاحيات ناقصة، حتى يتنبّه أي مطور جديد لخطورة عدم مزامنة هذا
 *   القاموس مع كل استدعاءات _checkPermission في المشروع.
 * - الحفاظ الكامل على التوثيق التاريخي الممتاز الموجود أصلًا لمعظم
 *   دوال الملف (خاصة _requirePermission الذي يشرح BUG-FIX تاريخي
 *   مهم) دون المساس بأي كلمة منه.
 *
 * أجزاء تحتاج Refactoring مستقبلاً:
 * - [تدقيق RBAC — Phase 9، مُوثَّق في ذاكرة المشروع]: 27 مفتاح صلاحية
 *   مُستخدَم عبر المشروع في استدعاءات _checkPermission لكنه غير
 *   موجود في ALL_PERMISSIONS — يجب تدقيق القائمة الكاملة ومطابقتها
 *   مع كل استدعاءات _checkPermission في كل ملفات Code_*.gs، وهذا خارج
 *   نطاق هذه الجلسة (توثيق فقط).
 * - saveWarehouseAccess/getUserWarehouseAccess (صلاحيات على مستوى
 *   المخزن): معرَّفتان بالكامل هنا لكن — كما وثّق Code_Core.gs في
 *   DOPOST_ALLOWED_FUNCTIONS — لا يوجد أي استدعاء لهما من أي واجهة
 *   حاليًا. يستحق قرارًا صريحًا: تفعيل الميزة فعليًا أو حذفها.
 * - PERMISSIONS = BUILTIN_PERMISSIONS (سطر توافق قديم) وERP_PERMISSIONS
 *   يبدوان كطبقتين متوازيتين لتعريف صلاحيات الأدوار الافتراضية — يستحق
 *   فحص هل كلاهما مُستخدَم فعليًا أم أن أحدهما بقايا من مرحلة انتقالية
 *   سابقة يمكن توحيدها مستقبلًا.
 *
 * أجزاء معقدة تستحق انتباهًا خاصًا عند أي تعديل مستقبلي:
 * - _checkPermission: تسلسل التحقق (جلسة → تطابق هوية → نشاط الحساب →
 *   صلاحيات الدور → استثناءات extra/denied) يجب أن يبقى بهذا الترتيب
 *   تحديدًا؛ أي إعادة ترتيب قد تفتح ثغرة (مثلًا فحص الصلاحية قبل
 *   التأكد من تطابق username مع صاحب الجلسة الفعلي).
 * - _requirePermission: يقبل صيغتي استدعاء مختلفتين (username مباشر
 *   أو payload object) وهذا مصدر محتمل للالتباس عند إضافة استدعاءات
 *   جديدة له — يُفضَّل توحيد الصيغة مستقبلًا بدل دعم الاثنتين.
 * - getAllDataForUser: منطق فلترة البيانات حسب صلاحية الوصول للمخزن
 *   (fallback إلى getAllData() الكاملة عند أي خطأ) قد يُسرّب بيانات
 *   أكثر من المطلوب في حالات الفشل الصامت — يستحق مراجعة أمنية إن
 *   كانت ميزة Warehouse Access ستُفعَّل فعليًا مستقبلًا.
 *
 * أجزاء تحتاج اختبارات (لا توجد اختبارات آلية حاليًا في المشروع):
 * - _checkPermission: كل تركيبة من (دور أساسي/دور مخصص) × (صلاحية
 *   ضمن الدور/خارج الدور) × (extra/denied override) للتأكد أن
 *   denied يتغلّب دائمًا على صلاحيات الدور وextra معًا.
 * - _getRolePermissions: دور غير موجود لا في BUILTIN_PERMISSIONS ولا
 *   في شيت Roles — يجب أن يُعيد مصفوفة فارغة دائمًا وليس خطأ.
 * - saveUserPermissionOverrides وgetUserPermissionOverrides: تناسق
 *   البيانات عند وجود نفس الصلاحية في extra وdenied معًا لنفس المستخدم
 *   (حالة تناقض يجب تحديد أيهما يفوز بوضوح).
 */
