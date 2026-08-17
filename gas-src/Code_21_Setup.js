// ════════════════════════════════════════════════════════════════
// Code_Setup.gs — [REFACTOR-P3] نُقل من Code_Core.gs (نقل نصي بحت، صفر
// تغيير في المنطق أو الترتيب الداخلي). Apps Script يعامل كل ملفات
// .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء من
// أي ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// المصدر الأصلي: Code_Core.gs — راجع تقرير Architecture Audit
// بتاريخ 2026-07-03، المرحلة 3.
// ════════════════════════════════════════════════════════════════

/**
 * [DEFAULT-COMPANY-1] الثوابت الافتراضية لاسم الشركة والفرع الرئيسي —
 * تُستخدم عند تهيئة النظام لأول مرة (initializeSystem) عشان أي سجل
 * افتراضي يتنشئ (حسابات، خزائن، ...) ياخد نفس اسم الفرع الموحّد بدل
 * ما يتسيب فاضي. غيّرهم هنا لو عايز اسم مختلف قبل أول تشغيل.
 */
var DEFAULT_COMPANY_NAME = "الشركة الرئيسية";
var DEFAULT_BRANCH_NAME = "الفرع الرئيسي";

// ─────────────────────────────────────────────────────────────
// §ERP-SETUP  setupAllSheets — ينشئ جميع الشيتات دفعة واحدة
// شغّله مرة واحدة بعد رفع الكود
// ─────────────────────────────────────────────────────────────
function setupAllSheets() {
  var results = [];
  var original = [
    "Items",
    "Groups",
    "Stock",
    "Transactions",
    "ProductionOrders",
    "Users",
    "Shipments",
    "Colors",
    "Sizes",
    "SizeGroups",
    "Units", // [UNITS-2026-08-06]
    "OpeningStock",
    "Warehouses",
    "WarehouseAccess",
    "AuditLog",
    "Roles",
    "UserPermissions",
    "BackupLog",
  ];
  // [PERF-MERGE-1] كل شيت بيتلوّن/يتنسّق فورًا بعد إنشائه هنا (بدون ترتيب
  // التبويب — ده لسه شغل applySheetFormatting بس لأنه محتاج كل الشيتات
  // موجودة الأول). كده applySheetFormatting بعد كده بيبقى مرور خفيف
  // (فحص لون + ترتيب فقط) بدل ما يعيد كل خطوات التنسيق التقيلة من الصفر
  // على كل الشيتات دي تاني — تقليل واضح في وقت التنفيذ الكلي.
  original.forEach(function (name) {
    try {
      var sh = getSheet(name, HEADERS[name] || WAREHOUSE_HEADERS);
      var fmtErrors = _formatSingleSheet(sh, name);
      results.push(
        " " + name + (fmtErrors.length ? " | " + fmtErrors.join(" | ") : ""),
      );
    } catch (e) {
      results.push(" " + name + ": " + e.message);
    }
  });
  Object.keys(ACCOUNTING_HR_HEADERS).forEach(function (name) {
    try {
      var sh2 = getSheet(name, ACCOUNTING_HR_HEADERS[name]);
      var fmtErrors2 = _formatSingleSheet(sh2, name);
      results.push(
        " " + name + (fmtErrors2.length ? " | " + fmtErrors2.join(" | ") : ""),
      );
    } catch (e) {
      results.push(" " + name + ": " + e.message);
    }
  });
  var summary = results.join("\n");
  Logger.log("setupAllSheets:\n" + summary);
  return summary;
}

// ─────────────────────────────────────────────────────────────
// §SETUP_ALL  الإعداد الكامل للنظام من الصفر — شغّلها مرة واحدة فقط
// ─────────────────────────────────────────────────────────────

/**
 * setupEverything — تهيئة كاملة للنظام من الصفر
 *
 * شغّلها مرة واحدة فقط في أي Google Apps Script جديد (أو أعد تشغيلها
 * بأمان في أي وقت لاحق — كل خطواتها Self-Healing/Idempotent: بتضيف
 * أي شيت أو عمود أو Trigger ناقص من غير ما تمسح أي بيانات موجودة).
 *
 * تعمل بالترتيب:
 *  1. الشيتات الأساسية (المخزن + المستخدمين + الصلاحيات)
 *  2. شيتات الفواتير والمرتجعات (+ أعمدة الشحن في SaleInvoices/Shipments)
 *  3. شيتات المرحلة الثانية (StockLots + محاسبة + أصول)
 *  4. شيتات موديول التصنيع (Work Centers, BOM, Routing, أوامر التصنيع...)
 *  5. البيانات الافتراضية (مخازن + يوزرز + دليل حسابات)
 *  6. ترقيات الأمان (Soft Delete + AuditLog columns)
 *  7. الـ Triggers التلقائية (جلسات + كاش + أرشفة + باكاب يومي +
 *     Retry Queue لواتساب Communication Hub + التقارير الأسبوعية)
 *  8. تنسيق وترتيب وتلوين كل تبويبات الشيتات + توحيد شكل الخط
 *     (applySheetFormatting — يشمل الترتيب حسب أقسام السايد بار)
 */
function setupEverything() {
  var execStartTime = Date.now(); // [FIX-TIMEOUT-2] لقياس الوقت الحقيقي المتبقي قبل حد الـ 6 دقايق
  var log = [];
  var errors = 0;

  function step(label, fn) {
    try {
      var result = fn();
      log.push(" " + label + (result ? ": " + result : ""));
    } catch (e) {
      errors++;
      log.push(" " + label + ": " + (e.message || e));
    }
  }

  Logger.log("═══════════════════════════════════════");
  Logger.log("  MOO.ERP — بدء الإعداد الكامل للنظام ");
  Logger.log("═══════════════════════════════════════");

  // المرحلة 1: الشيتات الأساسية
  step("setupAllSheets", function () {
    return setupAllSheets();
  });

  // المرحلة 2: شيتات الفواتير
  step("setupInvoiceSheets", function () {
    var r = setupInvoiceSheets();
    return r && r.message ? r.message : "";
  });

  // المرحلة 2ب: أعمدة الشحن في فواتير البيع + شيت الشحنات (Self-Healing)
  step("setupSaleInvoicesSheet", function () {
    return setupSaleInvoicesSheet();
  });

  step("setupShipmentsSheet", function () {
    return setupShipmentsSheet();
  });

  // المرحلة 3: شيتات Phase 2
  step("setupPhase2Sheets", function () {
    return setupPhase2Sheets();
  });

  // المرحلة 3ب: شيتات موديول التصنيع الجديد (Work Centers/BOM/Routing/MO...)
  step("setupManufacturingSheets", function () {
    return setupManufacturingSheets();
  });

  // المرحلة 4: البيانات الافتراضية (مخازن + يوزرز + دليل حسابات)
  step("initializeSystem", function () {
    return initializeSystem();
  });

  // المرحلة 5: ترقيات الأمان
  step("setupSecurityUpgrades", function () {
    var r = setupSecurityUpgrades();
    return r && r.success ? r.message : r ? JSON.stringify(r) : "";
  });

  // المرحلة 6: Triggers تلقائية
  // [PERF-TRIGGERS-1] نجيب قايمة الـ Triggers الحالية مرة واحدة بس هنا
  // ونمررها لكل دالة setup*Trigger بدل ما كل دالة تعمل نداء منفصل لـ
  // ScriptApp.getProjectTriggers() (كل نداء منها بياخد ثانية+ لوحده على
  // سيرفرات جوجل — كانت بتتكرر 6 مرات فتضيف ~10-15 ثانية زيادة بلا داعي).
  var existingTriggersSnapshot = [];
  try {
    existingTriggersSnapshot = ScriptApp.getProjectTriggers();
  } catch (e) {
    Logger.log(" فشل جلب قايمة الـ Triggers مسبقًا: " + (e.message || e));
  }

  step("setupSessionCleanupTrigger", function () {
    var r = setupSessionCleanupTrigger(existingTriggersSnapshot);
    return r && r.message ? r.message : "";
  });

  step("setupAuditLogTrimTrigger", function () {
    var r = setupAuditLogTrimTrigger(existingTriggersSnapshot);
    return r && r.message ? r.message : "";
  });

  step("setupWarmCacheTrigger", function () {
    var r = setupWarmCacheTrigger(existingTriggersSnapshot);
    return r && r.message ? r.message : "";
  });

  // باكاب يومي تلقائي (افتراضي: كل يوم الساعة 3 صباحًا — عدّلها لاحقًا
  // بمناداة setupBackupTrigger({frequency, hour, day}) بإعدادات مختلفة)
  step("setupBackupTrigger", function () {
    setupBackupTrigger(null, existingTriggersSnapshot);
    return "تم جدولة الباكاب اليومي (3 صباحًا)";
  });

  // معالجة قائمة إعادة المحاولة لرسائل Communication Hub (كل دقيقة)
  step("setupCommHubRetryTrigger", function () {
    setupCommHubRetryTrigger(existingTriggersSnapshot);
    return "تم تفعيل Retry Queue لواتساب Communication Hub";
  });

  // التقارير الأسبوعية المجدولة (افتراضي: الأحد + الأربعاء الساعة 8
  // صباحًا — عدّلها لاحقًا بمناداة setupWeeklyTrigger(config) بإعداداتك)
  step("setupWeeklyTrigger", function () {
    var r = setupWeeklyTrigger(null, existingTriggersSnapshot);
    return r && r.message ? r.message : "تم جدولة التقارير الأسبوعية";
  });

  // المرحلة 7: ترتيب كل تبويبات الشيتات حسب أقسام السايد بار + تلوينها
  // + توحيد شكل الخط (هيدر عريض أبيض / بيانات أسود عادي) — راجع
  // SHEET_FORMAT_CONFIG أعلى هذا الملف لإضافة أي شيت جديد مستقبلاً.
  step("applySheetFormatting", function () {
    return applySheetFormatting(execStartTime);
  });

  // المرحلة 8: دوال إصلاح/صيانة آمنة (idempotent، سريعة، بدون أي أثر جانبي
  // على بيانات حقيقية) — بُنيت بعد مراجعة كل دوال fix*/migrate* الموجودة
  // في النظام. [COA-V2 CLEANUP-2026-08] الدوال اللي كانت one-time migrations
  // خلصت شغلها بالفعل (migratePhase2, migrateGroupsHierarchy,
  // repairGroupsSheetSchema, migrateChequeLegacyPendingStatuses,
  // migrateLegacyPasswords, fixColorsColumn, migrateStockAddColorColumn,
  // migrateColorsToNewFormat, mergeMoqAndMinPurchaseQty, removePermitIdColumn,
  // addAttachmentColumnToTransactions, cleanupLegacyCustomRoles) اتحذفت
  // نهائيًا من السورس (مفيش عملاء على السكيما القديمة تحتاجها). باقي:
  //  (ب) fixProductionOrdersSheet — بتاخد وقت طويل نسبيًا (بناء StockLots
  //      من التاريخ الكامل)، لسه يدوية عمدًا.
  //  (د) بالفعل مؤتمتة عبر Trigger منفصل (fixAllWhiteFontInSheets عبر
  //      scheduledFixWhiteFont). تلقائيتها هنا كانت هتزوّد وقت التنفيذ
  //      ومخاطر بيانات من غير داعي حقيقي.
  step("migrateRateLimitKeys", function () {
    return migrateRateLimitKeys();
  });

  step("forceFixPermissionsCacheNow", function () {
    forceFixPermissionsCacheNow();
    return "تم مسح كاش getAllData/AI القديم";
  });

  // النتيجة النهائية
  var summary = log.join("\n");
  Logger.log("\n" + summary);
  Logger.log("═══════════════════════════════════════");
  Logger.log(
    errors === 0
      ? " تم الإعداد بنجاح — النظام جاهز للاستخدام"
      : " اكتمل الإعداد مع " + errors + " خطأ — راجع السجل فوق",
  );
  Logger.log("═══════════════════════════════════════");

  return summary;
}

// ─────────────────────────────────────────────────────────────
// §SETUP_FORMAT  تنسيق وتلوين الشيتات — تُستدعى من setupEverything
// يمكن تشغيلها منفردة في أي وقت لإعادة التنسيق بدون مسح البيانات
// ─────────────────────────────────────────────────────────────

/**
 * SHEET_FORMAT_CONFIG — إعدادات كل شيت
 *
 * tabColor     : لون تبويب الشيت (hex)
 * freezeRows   : عدد الصفوف المثبّتة (عادةً 1 للهيدر)
 * colWidths     : { رقم_العمود: العرض_بالبكسل } — اختياري
 * rowHeight     : ارتفاع صف البيانات بالبكسل — اختياري
 * banding       : true = تلوين صفوف متبادل
 * bandingColors : { header, first, second } — اختياري (يرث من الافتراضي)
 * dir           : "rtl" | "ltr" — اتجاه النص (افتراضي rtl)
 */
var SHEET_FORMAT_CONFIG = {
  // ══════════════════════════════════════════════════════════════
  //  1) المخزون  (أخضر) — نفس ترتيب قسم "المخزون" في السايد بار
  // ══════════════════════════════════════════════════════════════
  Items: {
    tabColor: "#1D6F42",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 2: 80, 3: 180, 4: 200, 5: 120, 9: 90, 10: 90 },
    rowHeight: 24,
  },
  Groups: {
    tabColor: "#2E7D32",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 2: 150, 3: 60, 4: 120 },
    rowHeight: 24,
  },
  Warehouses: {
    tabColor: "#00838F",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 100, 2: 160, 3: 80, 4: 80 },
    rowHeight: 24,
  },
  WarehouseAccess: {
    tabColor: "#00695C",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Stock: {
    tabColor: "#388E3C",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 150, 2: 120, 3: 100, 4: 90 },
    rowHeight: 24,
  },
  StockLots: {
    tabColor: "#1D9E75",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  OpeningStock: {
    tabColor: "#558B2F",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Colors: {
    tabColor: "#AD1457",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 100, 2: 120, 3: 60, 4: 80 },
    rowHeight: 24,
  },
  Sizes: {
    tabColor: "#C62828",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 100, 2: 120, 3: 60 },
    rowHeight: 24,
  },
  SizeGroups: {
    tabColor: "#B71C1C",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 100, 2: 160, 3: 200 },
    rowHeight: 24,
  },
  // [UNITS-2026-08-06]
  Units: {
    tabColor: "#00695C",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 100, 2: 120, 3: 80 },
    rowHeight: 24,
  },

  // ══════════════════════════════════════════════════════════════
  //  2) الحركات  (أزرق)
  // ══════════════════════════════════════════════════════════════
  Transactions: {
    tabColor: "#1565C0",
    freezeRows: 1,
    banding: true,
    colWidths: {
      1: 140,
      2: 100,
      3: 100,
      4: 150,
      5: 70,
      6: 120,
      7: 120,
      8: 180,
      9: 80,
    },
    rowHeight: 24,
  },

  // ══════════════════════════════════════════════════════════════
  //  3) المشتريات  (بنفسجي)
  // ══════════════════════════════════════════════════════════════
  PurchaseOrders: {
    tabColor: "#8E24AA",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  PurchaseInvoices: {
    tabColor: "#5E35B1",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 140, 2: 100, 3: 150, 5: 100, 6: 100, 7: 80 },
    rowHeight: 24,
  },
  PurchaseReturns: {
    tabColor: "#7B1FA2",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },

  // ══════════════════════════════════════════════════════════════
  //  4) المبيعات  (زمردي)
  // ══════════════════════════════════════════════════════════════
  SaleInvoices: {
    tabColor: "#00695C",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 140, 2: 100, 3: 150, 5: 100, 6: 100, 7: 80 },
    rowHeight: 24,
  },
  SaleReturns: {
    tabColor: "#00897B",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },

  // ══════════════════════════════════════════════════════════════
  //  5) العملاء  (أزرق نيلي) + واتساب/تواصل
  // ══════════════════════════════════════════════════════════════
  Customers: {
    tabColor: "#1E88E5",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 2: 180, 3: 120, 4: 160, 6: 200 },
    rowHeight: 24,
  },
  PartyCategories: {
    tabColor: "#1E88E5",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 2: 160, 3: 100, 4: 100 },
    rowHeight: 22,
  },
  WhatsAppLog: {
    tabColor: "#1B5E20",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 100, 2: 120, 3: 150, 4: 300 },
    rowHeight: 22,
  },
  WhatsAppGatewayConfig: {
    tabColor: "#128C7E",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  // [UNIFY-COMMHUB-2026] WA_Conversations / WA_Messages اتشالوا من هنا —
  // بقوا شيتات شبح مالهاش أي كتابة فعلية بعد ما مصدر بيانات "مركز واتساب"
  // القديم اتوحّد مع CommHub_Conversations/CommHub_Messages (راجع التعليق
  // التوضيحي في Code_24_WhatsApp.js). أي بيانات قديمة فيهم (لو موجودة في
  // شيت فعلي بالفعل) بتفضل موجودة زي ما هي — الحذف هنا بس بيمنع إنشاء
  // نسخة جديدة منهم لو حد شغّل initializeSystem() تاني على بيئة جديدة.
  CommHub_Providers: {
    tabColor: "#3949AB",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  CommHub_Conversations: {
    tabColor: "#3F51B5",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  CommHub_Messages: {
    tabColor: "#5C6BC0",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  CommHub_Queue: {
    tabColor: "#7986CB",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  CommHub_Settings: {
    tabColor: "#303F9F",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  WAWorkflows: {
    tabColor: "#1E88E5",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },

  // ══════════════════════════════════════════════════════════════
  //  6) الموردين  (بنفسجي فاتح)
  // ══════════════════════════════════════════════════════════════
  Suppliers: {
    tabColor: "#7C3AED",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 2: 180, 3: 120, 4: 160, 6: 200 },
    rowHeight: 24,
  },

  // ══════════════════════════════════════════════════════════════
  //  7) الإنتاج + التصنيع  (كهرماني/بني)
  // ══════════════════════════════════════════════════════════════
  ProductionOrders: {
    tabColor: "#6A1B9A",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 140, 2: 100, 3: 150, 4: 70, 5: 80, 8: 80, 9: 80 },
    rowHeight: 24,
  },
  ProductionStages: {
    // ملاحظة: انتقل موضعه للسايد بار تحت "الموارد البشرية"، لكنه بقي هنا
    // في التصنيف المنطقي — راجع SHEET_GROUPS لترتيب التبويبات الفعلي
    tabColor: "#6A1B9A",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  StageExecutions: {
    tabColor: "#7B1FA2",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  WorkCenters: {
    tabColor: "#92400E",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Machines: {
    tabColor: "#9A3412",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  BillOfMaterials: {
    tabColor: "#B45309",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  BOMLines: {
    tabColor: "#C2410C",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Routings: {
    tabColor: "#D97706",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  RoutingOperations: {
    tabColor: "#EA580C",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  ManufacturingOrders: {
    tabColor: "#A16207",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  MOGarmentDetails: {
    tabColor: "#78350F",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  MOMaterialIssues: {
    tabColor: "#854D0E",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  QualityTemplates: {
    tabColor: "#B45309",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  QualityInspections: {
    tabColor: "#CA8A04",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  SubcontractShipments: {
    tabColor: "#A3701A",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  WIPLedger: {
    tabColor: "#8B5E10",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  CostVarianceLog: {
    tabColor: "#7C4A03",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  ManufacturingCostSettings: {
    tabColor: "#6B4226",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },

  // ══════════════════════════════════════════════════════════════
  //  8) الشحن  (برتقالي محروق)
  // ══════════════════════════════════════════════════════════════
  ShippingCompanies: {
    tabColor: "#9A3412",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Shipments: {
    tabColor: "#0277BD",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 140, 2: 100, 3: 150, 4: 120, 5: 120, 6: 100, 7: 90 },
    rowHeight: 24,
  },

  // ══════════════════════════════════════════════════════════════
  //  9) المحاسبة  (نيلي/ذهبي)
  // ══════════════════════════════════════════════════════════════
  ChartOfAccounts: {
    tabColor: "#1A237E",
    freezeRows: 1,
    banding: true,
    colWidths: {
      1: 120,
      2: 80,
      3: 180,
      4: 180,
      5: 90,
      6: 110,
      11: 110,
      12: 110,
    },
    rowHeight: 24,
  },
  AccountingSettings: {
    tabColor: "#283593",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  AccountingPeriods: {
    tabColor: "#303F9F",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  JournalEntries: {
    tabColor: "#283593",
    freezeRows: 1,
    banding: true,
    colWidths: {
      1: 140,
      2: 100,
      3: 110,
      4: 100,
      5: 220,
      6: 110,
      7: 110,
      8: 80,
    },
    rowHeight: 24,
  },
  JournalEntryLines: {
    tabColor: "#303F9F",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 130, 2: 130, 3: 120, 4: 100, 5: 100 },
    rowHeight: 22,
  },
  ReceiptVouchers: {
    tabColor: "#2E7D32",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 130, 2: 100, 3: 110, 4: 150, 7: 100, 8: 70 },
    rowHeight: 24,
  },
  PaymentVouchers: {
    tabColor: "#B71C1C",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 130, 2: 100, 3: 110, 4: 150, 7: 100, 8: 70 },
    rowHeight: 24,
  },
  TransferVouchers: {
    tabColor: "#4527A0",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Expenses: {
    tabColor: "#880E4F",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 140, 2: 100, 3: 180, 4: 100, 5: 100 },
    rowHeight: 24,
  },
  CashBoxes: {
    tabColor: "#F57F17",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 2: 80, 3: 150, 5: 70, 6: 110, 7: 110 },
    rowHeight: 24,
  },
  Banks: {
    tabColor: "#F9A825",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  BankAccounts: {
    tabColor: "#F9A825",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 2: 80, 3: 160, 6: 140, 7: 140, 8: 100 },
    rowHeight: 24,
  },
  ChequeBooks: {
    tabColor: "#FB8C00",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Cheques: {
    tabColor: "#EF6C00",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  BankReconciliations: {
    tabColor: "#FF8F00",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  BankStatementLines: {
    tabColor: "#FF6F00",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  VodafoneCashTransactions: {
    tabColor: "#6D28D9",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  VodafoneCashLines: {
    tabColor: "#7C3AED",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  FixedAssets: {
    tabColor: "#3730A3",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  CostCenters: {
    tabColor: "#283593",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 2: 160, 3: 100 },
    rowHeight: 22,
  },
  PaymentMethods: {
    tabColor: "#283593",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 2: 100, 3: 150, 4: 150, 5: 80, 7: 180 },
    rowHeight: 22,
  },

  // ══════════════════════════════════════════════════════════════
  //  10) الموارد البشرية  (برتقالي محروق)
  // ══════════════════════════════════════════════════════════════
  Departments: {
    tabColor: "#E64A19",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  JobTitles: {
    tabColor: "#F4511E",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Employees: {
    tabColor: "#BF360C",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 130, 2: 80, 3: 160, 4: 120, 5: 120, 6: 100, 9: 100 },
    rowHeight: 24,
  },
  EmployeeAllowances: {
    tabColor: "#BF360C",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  EmployeeDeductions: {
    tabColor: "#870000",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  EmployeeJobHistory: {
    tabColor: "#A0522D",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  EmployeeDocuments: {
    tabColor: "#4E342E",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  EmployeeQualifications: {
    tabColor: "#EF6C00",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  SalaryComponents: {
    tabColor: "#EF6C00",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Attendance: {
    tabColor: "#EF6C00",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 130, 2: 100, 3: 100, 4: 100, 5: 100, 6: 80 },
    rowHeight: 22,
  },
  AttendanceImportLog: {
    tabColor: "#E65100",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  LeaveTypes: {
    tabColor: "#F57C00",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  LeaveRequests: {
    tabColor: "#FB8C00",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 130, 2: 130, 3: 100, 4: 100, 5: 80, 6: 80 },
    rowHeight: 22,
  },
  LoanRequests: {
    tabColor: "#FF8F00",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  PayrollPeriods: {
    tabColor: "#FF6F00",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  PayrollRecords: {
    tabColor: "#E65100",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 130, 2: 130, 3: 100, 4: 100, 5: 100, 6: 100 },
    rowHeight: 22,
  },

  // ══════════════════════════════════════════════════════════════
  //  11) التقارير  (رمادي مزرق)
  // ══════════════════════════════════════════════════════════════
  WeeklyReportConfig: {
    tabColor: "#607D8B",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },

  // ══════════════════════════════════════════════════════════════
  //  12) الإدارة  (رمادي أردوازي)
  // ══════════════════════════════════════════════════════════════
  Users: {
    tabColor: "#37474F",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 120, 3: 100, 4: 160, 6: 120, 7: 180 },
    rowHeight: 24,
  },
  Roles: {
    tabColor: "#455A64",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  UserPermissions: {
    tabColor: "#546E7A",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  Settings: {
    tabColor: "#546E7A",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 160, 2: 300 },
    rowHeight: 22,
  },
  AuditLog: {
    tabColor: "#455A64",
    freezeRows: 1,
    banding: true,
    colWidths: { 1: 130, 2: 90, 3: 120, 4: 100, 5: 110, 6: 300 },
    rowHeight: 22,
  },
  BackupLog: {
    tabColor: "#607D8B",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  UserPreferences: {
    tabColor: "#78909C",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  ImportLog: {
    tabColor: "#455A64",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  AnnouncementReads: {
    tabColor: "#546E7A",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
  UpdateVersionReads: {
    tabColor: "#546E7A",
    freezeRows: 1,
    banding: true,
    rowHeight: 22,
  },
};

/**
 * SHEET_GROUPS — [GROUP-COLOR-UNIFY] المصدر الوحيد (Single Source of
 * Truth) لتجميع الشيتات في أقسام منطقية، بنفس ترتيب أقسام القائمة
 * الجانبية (NAV_GROUPS في 02_JS_UI_Shell.html):
 * المخزون ← الحركات ← المشتريات ← المبيعات ← العملاء ← الموردين ←
 * الإنتاج/التصنيع ← الشحن ← المحاسبة ← الموارد البشرية ← التقارير ← الإدارة.
 *
 * كل شيتات نفس القسم بتاخد **نفس لون التبويب بالظبط** (color)، وبترتب
 * تبويباتها جنب بعضها بنفس ترتيب المصفوفة sheets هنا — بدل ما كل شيت
 * كان له درجة لون مختلفة شوية عن جاره في نفس القسم.
 *
 * لو أضفت شيت جديد: ضيفه في مصفوفة sheets الخاصة بقسمه هنا (وفي
 * SHEET_FORMAT_CONFIG فوق لو محتاج ضبط عرض أعمدة/ارتفاع صفوف خاص به)
 * وهيتّرتّب ويتلوّن تلقائيًا بدون أي كود إضافي.
 */
var SHEET_GROUPS = [
  {
    name: "المخزون",
    color: "#1D6F42",
    sheets: [
      "Items",
      "Groups",
      "Warehouses",
      "WarehouseAccess",
      "Stock",
      "StockLots",
      "OpeningStock",
      "Colors",
      "Sizes",
      "SizeGroups",
      "Units", // [UNITS-2026-08-06]
    ],
  },
  {
    name: "الحركات",
    color: "#1565C0",
    sheets: ["Transactions"],
  },
  {
    name: "المشتريات",
    color: "#6A1B9A",
    sheets: ["PurchaseOrders", "PurchaseInvoices", "PurchaseReturns"],
  },
  {
    name: "المبيعات",
    color: "#00695C",
    sheets: ["SaleInvoices", "SaleReturns"],
  },
  {
    name: "العملاء",
    color: "#1E88E5",
    sheets: [
      "Customers",
      "PartyCategories",
      "WhatsAppLog",
      "WhatsAppGatewayConfig",
      // [UNIFY-COMMHUB-2026] WA_Conversations/WA_Messages شبح — اتشالوا
      // من قائمة الإنشاء (راجع تعليق CommHub_Providers فوق)
      "CommHub_Providers",
      "CommHub_Conversations",
      "CommHub_Messages",
      "CommHub_Queue",
      "CommHub_Settings",
      "WAWorkflows",
    ],
  },
  {
    name: "الموردين",
    color: "#7C3AED",
    sheets: ["Suppliers"],
  },
  {
    name: "الإنتاج والتصنيع",
    color: "#B45309",
    sheets: [
      "ProductionOrders",
      "ProductionStages",
      "StageExecutions",
      "WorkCenters",
      "Machines",
      "BillOfMaterials",
      "BOMLines",
      "Routings",
      "RoutingOperations",
      "ManufacturingOrders",
      "MOGarmentDetails",
      "MOMaterialIssues",
      "QualityTemplates",
      "QualityInspections",
      "SubcontractShipments",
      "WIPLedger",
      "CostVarianceLog",
      "ManufacturingCostSettings",
    ],
  },
  {
    name: "الشحن",
    color: "#9A3412",
    sheets: ["ShippingCompanies", "Shipments"],
  },
  {
    name: "المحاسبة",
    color: "#283593",
    sheets: [
      "ChartOfAccounts",
      "AccountingSettings",
      "AccountingPeriods",
      "JournalEntries",
      "JournalEntryLines",
      "ReceiptVouchers",
      "PaymentVouchers",
      "TransferVouchers",
      "Expenses",
      "CashBoxes",
      "Banks",
      "BankAccounts",
      "ChequeBooks",
      "Cheques",
      "BankReconciliations",
      "BankStatementLines",
      "VodafoneCashTransactions",
      "VodafoneCashLines",
      "FixedAssets",
      "CostCenters",
      "PaymentMethods",
    ],
  },
  {
    name: "الموارد البشرية",
    color: "#EF6C00",
    sheets: [
      "Departments",
      "JobTitles",
      "Employees",
      "EmployeeAllowances",
      "EmployeeDeductions",
      "EmployeeJobHistory",
      "EmployeeDocuments",
      "EmployeeQualifications",
      "SalaryComponents",
      "Attendance",
      "AttendanceImportLog",
      "LeaveTypes",
      "LeaveRequests",
      "LoanRequests",
      "PayrollPeriods",
      "PayrollRecords",
    ],
  },
  {
    name: "التقارير",
    color: "#607D8B",
    sheets: ["WeeklyReportConfig"],
  },
  {
    name: "الإدارة",
    color: "#455A64",
    sheets: [
      "Users",
      "Roles",
      "UserPermissions",
      "Settings",
      "AuditLog",
      "BackupLog",
      "UserPreferences",
      "ImportLog",
      "AnnouncementReads",
      "UpdateVersionReads",
    ],
  },
];

/**
 * _getSheetGroupColor — يرجّع لون القسم الموحّد لأي اسم شيت حسب
 * SHEET_GROUPS. لو الشيت مش موجود في أي قسم (شيت جديد لسه متضافش)،
 * بيرجع null فيرجع الكود لسلوكه القديم (لون الشيت الفردي من
 * SHEET_FORMAT_CONFIG لو موجود، أو من غير تلوين لو مفيش).
 */
function _getSheetGroupColor(sheetName) {
  for (var i = 0; i < SHEET_GROUPS.length; i++) {
    if (SHEET_GROUPS[i].sheets.indexOf(sheetName) !== -1) {
      return SHEET_GROUPS[i].color;
    }
  }
  return null;
}

/**
 * SHEET_ORDER — ترتيب التبويبات الفعلي داخل ملف الـ Spreadsheet.
 *
 * المصدر الوحيد للترتيب (Single Source of Truth) = SHEET_GROUPS فوق
 * (كل أقسامها بترتيبها، وكل شيتات القسم الواحد بترتيبها بره بعض) —
 * وهو نفس ترتيب أقسام القائمة الجانبية (NAV_GROUPS في
 * 02_JS_UI_Shell.html):
 * الرئيسية ← المخزون ← الحركات ← المشتريات ← المبيعات ← العملاء ←
 * الموردين ← الإنتاج/التصنيع ← الشحن ← المحاسبة ← الموارد البشرية ←
 * التقارير ← الإدارة.
 *
 * لو أضفت شيت جديد للنظام: ضيفه في SHEET_FORMAT_CONFIG في مكانه
 * المنطقي حسب القسم، وهيتّرتّب تلقائياً بدون أي كود إضافي هنا.
 */
function _getSheetOrder() {
  var order = [];
  SHEET_GROUPS.forEach(function (group) {
    group.sheets.forEach(function (name) {
      order.push(name);
    });
  });
  // [SAFETY-NET] أي شيت موجود في SHEET_FORMAT_CONFIG بس اتنسى إضافته
  // في SHEET_GROUPS (مثلاً شيت جديد اتضاف هنا ونُسي هناك) — يتضاف في
  // الآخر بدل ما يختفي من الترتيب تمامًا.
  Object.keys(SHEET_FORMAT_CONFIG).forEach(function (name) {
    if (order.indexOf(name) === -1) order.push(name);
  });
  return order;
}

/**
 * applySheetFormatting — [PERF-CHUNK-1] يطبّق التنسيق والترتيب الكامل على
 * كل شيتات النظام — نسخة قابلة للاستئناف التلقائي (Chunked/Resumable).
 *
 * - ترتيب تبويبات الشيتات حسب القسم (نفس ترتيب القائمة الجانبية) — أي شيت
 *   تابع لقسم معيّن (مثلاً كل شيتات "المخزون") بيبقى جنب بعضه في التابات
 * - تثبيت صف الهيدر (Freeze row 1)
 * - تلوين تبويب الشيت بلون القسم الموحّد (SHEET_GROUPS)
 * - تلوين صفوف متبادل (Banding)
 * - ضبط عرض الأعمدة (Column widths)
 * - ضبط ارتفاع صفوف البيانات (Row height)
 * - ضبط اتجاه النص RTL
 * - توحيد شكل الخط: صف الهيدر (Bold أبيض)، وصفوف البيانات (أسود عادي)
 *
 * [PERF-CHUNK-1] السبب: عندنا ~90 شيت، وكل شيت بياخد كذا نداء API
 * (نقل تبويب + Banding + تنسيق خط)، وكل نداء منها Round-trip حقيقي
 * لسيرفرات جوجل — فالتنفيذ اليدوي (حده 6 دقايق) كان بيضرب
 * "Exceeded maximum execution time" قبل ما يخلّص كل الشيتات.
 *
 * الحل:
 *  1) بنسجّل تقدّم التنفيذ (آخر شيت اتعالج) في PropertiesService، فلو
 *     الوقت خلص، بنوقف بأمان من غير ما نضيع اللي خلصناه.
 *  2) بنجدول Trigger تلقائي يشتغل بعد كام ثانية يكمّل من نفس النقطة —
 *     يعني تشغّلها مرة واحدة بس وهي بتكمل نفسها لحد ما تخلّص كل الشيتات،
 *     من غير ما تحتاج تدوس Run تاني يدوي.
 *  3) بعد أول تشغيل كامل ناجح، أي تشغيل لاحق بيبقى سريع جدًا لأننا
 *     بنتخطى نقل التبويب (moveActiveSheet) لو الشيت أصلاً في مكانه الصح
 *     — وده كان أغلى نداء في اللوب.
 *
 * يمكن تشغيلها منفردة في أي وقت من Editor → Run → applySheetFormatting.
 * لو حابب تتابع تقدّمها وسط التنفيذ: getFormattingProgress().
 * لو عايز تلغي أي استكمال مجدول وتبدأ من الصفر: resetFormattingProgress().
 */
var SHEET_FORMAT_PROGRESS_KEY = "sheet_format_progress_index";
var SHEET_FORMAT_CONTINUE_HANDLER = "applySheetFormattingAutoContinue";
var SHEET_FORMAT_MAX_RUNTIME_MS = 4.5 * 60 * 1000; // هامش أمان تحت حد الـ 6 دقايق

// ألوان الـ Banding الافتراضية — نفس القيم اللي كانت جوه applySheetFormatting
var DEFAULT_BAND_COLORS = {
  header: "#2563eb",
  first: "#EFF6FF",
  second: "#FFFFFF",
};

/**
 * _formatSingleSheet — [PERF-MERGE-1] كل خطوات تنسيق شيت واحد (تجميد،
 * لون التبويب، RTL، عرض الأعمدة، ارتفاع الصفوف، Banding، خط الهيدر/
 * البيانات) — بدون خطوة *ترتيب* التبويب (moveActiveSheet)، لأن دي محتاجة
 * سياق كل الشيتات مجتمعة فمتسيّبة لـ applySheetFormatting وحدها.
 *
 * استُخلصت من applySheetFormatting عشان تُستخدم في مكانين:
 *  1) applySheetFormatting نفسها (المرور الشامل + الترتيب).
 *  2) setupAllSheets فور إنشاء كل شيت — عشان الإنشاء والتنسيق يحصلوا في
 *     مرور واحد بدل ما ننشئ كل الشيتات الأول، وبعدين نرجع نمر عليهم
 *     تاني من الصفر بس عشان التلوين (ده كان بيضاعف وقت التنفيذ).
 *
 * [PERF-SKIP-1] لو الشيت لونه أصلاً مطابق للمطلوب (يعني اتنسّق قبل كده
 * في نفس التشغيلة عبر setupAllSheets مثلاً)، بتتخطى كل الخطوات التقيلة
 * (Banding + خط) وترجّع فورًا — كده applySheetFormatting بعد كده بيبقى
 * سريع جدًا حتى لو مرّ على نفس الشيتات تاني لأجل الترتيب بس.
 *
 * @param {Sheet} sheet
 * @param {String} name
 * @returns {String[]} errors — قايمة فاضية لو كل خطوة نجحت
 */
function _formatSingleSheet(sheet, name) {
  var cfg = SHEET_FORMAT_CONFIG[name];
  var errors = [];
  if (!cfg) return errors; // مفيش cfg تنسيق لهذا الشيت — عادي

  var groupColor = _getSheetGroupColor(name);
  var resolvedTabColor = groupColor || cfg.tabColor;

  // [PERF-SKIP-1] فحص رخيص: لو التبويب أصلاً بلونه الصحيح، افترض إن
  // الشيت اتنسّق قبل كده في نفس التشغيلة وتخطّى باقي الخطوات التقيلة.
  if (resolvedTabColor && sheet.getTabColor() === resolvedTabColor) {
    return errors;
  }

  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var lastRow = Math.max(sheet.getLastRow(), 1);

  try {
    if (cfg.freezeRows) sheet.setFrozenRows(cfg.freezeRows);
  } catch (e1) {
    errors.push("تجميد الهيدر: " + e1.message);
  }

  try {
    if (resolvedTabColor) sheet.setTabColor(resolvedTabColor);
  } catch (e2) {
    errors.push("لون التبويب: " + e2.message);
  }

  try {
    sheet
      .getRange(1, 1, lastRow, lastCol)
      .setTextDirection(SpreadsheetApp.TextDirection.RIGHT_TO_LEFT);
  } catch (e3) {
    errors.push("اتجاه RTL: " + e3.message);
  }

  try {
    if (cfg.colWidths) {
      Object.keys(cfg.colWidths).forEach(function (col) {
        var c = Number(col);
        if (c <= lastCol) sheet.setColumnWidth(c, cfg.colWidths[col]);
      });
    }
  } catch (e4) {
    errors.push("عرض الأعمدة: " + e4.message);
  }

  try {
    if (cfg.rowHeight && lastRow > 1) {
      var maxRows = sheet.getMaxRows();
      var numRows = Math.min(lastRow - 1, maxRows - 1);
      if (numRows > 0) sheet.setRowHeightsForced(2, numRows, cfg.rowHeight);
    }
  } catch (e5) {
    errors.push("ارتفاع الصفوف: " + e5.message);
  }

  try {
    if (cfg.banding) {
      var bandColors = cfg.bandingColors || DEFAULT_BAND_COLORS;
      sheet.getBandings().forEach(function (b) {
        b.remove();
      });
      if (lastRow >= 1 && lastCol >= 1 && !(lastRow === 1 && lastCol === 1)) {
        sheet
          .getRange(1, 1, lastRow, lastCol)
          .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY)
          .setHeaderRowColor(bandColors.header)
          .setFirstRowColor(bandColors.first)
          .setSecondRowColor(bandColors.second)
          .setFooterRowColor(null);
      }
    }
  } catch (e6) {
    errors.push("التلوين المتبادل (Banding): " + e6.message);
  }

  try {
    sheet
      .getRange(1, 1, 1, lastCol)
      .setFontWeight(HEADER_STYLE.weight)
      .setBackground(HEADER_STYLE.bg)
      .setFontColor(HEADER_STYLE.color);
  } catch (e7) {
    errors.push("خط الهيدر: " + e7.message);
  }

  try {
    if (lastRow > 1) {
      sheet
        .getRange(2, 1, lastRow - 1, lastCol)
        .setFontColor("#000000")
        .setFontWeight("normal")
        .setFontStyle("normal");
    }
  } catch (e8) {
    errors.push("خط صفوف البيانات: " + e8.message);
  }

  return errors;
}

function applySheetFormatting(execStartTime) {
  var results = [];
  var errors = 0;
  var movedCount = 0;
  var skippedMoveCount = 0;

  // [FIX-TIMEOUT-1] الجذر الحقيقي لـ "Exceeded maximum execution time": آلية
  // الـ Checkpoint/Resume الموصوفة في التعليق أعلى الملف (PERF-CHUNK-1) كانت
  // مكتوبة بس في التوثيق وفي دوال مساعدة (getFormattingProgress،
  // resetFormattingProgress، _scheduleFormattingContinuation) من غير ما
  // تتفعّل فعليًا جوه اللوب هنا: startIndex كان دايمًا صفر (مش بيقرأ من
  // PropertiesService)، ومفيش أي فحص لوقت التنفيذ (Date.now() قبال
  // SHEET_FORMAT_MAX_RUNTIME_MS) داخل اللوب، ومفيش نداء لـ
  // _scheduleFormattingContinuation() قبل ما نوقف. يعني الدالة كانت بتحاول
  // تنسّق كل ~90 شيت في نداء واحد لحد ما جوجل يقفلها بعد 6 دقايق، من غير
  // ما تحفظ أي تقدّم أو تجدول استكمال — فبترجع لنفس النقطة تاني كل مرة.
  // الحل: نفعّل فعليًا القراءة من الـ Property + فحص الوقت جوه اللوب.
  var props = PropertiesService.getScriptProperties();
  var startIndex = Number(props.getProperty(SHEET_FORMAT_PROGRESS_KEY) || 0);
  // [FIX-TIMEOUT-2] لو الدالة اتنادت من setupEverything (اللي بتعمل شغل
  // تقيل قبلها في نفس التنفيذ)، بنستخدم وقت بداية setupEverything نفسه
  // مش وقت دخولنا هنا فقط — عشان الميزانية (4.5 دقيقة) تتحسب من إجمالي
  // وقت التنفيذ الحقيقي المتبقي قبل حد جوجل الـ 6 دقايق، مش من صفر تاني.
  var startTime = execStartTime || Date.now();
  var timedOut = false;

  // [FIX-INVALID-ARG-1] الجذر الحقيقي لخطأ "ترتيب التبويب: Invalid argument"
  // على آخر ~9 شيتات: desiredIndex كان بيتحسب من ترتيب i الخام في
  // sheetOrder الكامل (اللي بيشمل شيتات لسه مش موجودة فعليًا زي
  // PurchaseOrders/WA_*/CommHub_*/WeeklyReportConfig...)، فبيوصل لرقم
  // أكبر من إجمالي عدد الشيتات الحقيقي في الملف، وmoveActiveSheet()
  // بترفض أي index أكبر من عدد الشيتات الفعلي فعلاً. الحل: نعدّ بس
  // الشيتات اللي *موجودة فعليًا* لحد النقطة دي، مش كل عناصر sheetOrder.
  // ملحوظة: لو استكملنا (startIndex > 0) بنعيد حساب placedCount بسرعة (من
  // غير أي نداء API تقيل) عشان desiredIndex يفضل صحيح من بداية العملية.
  var placedCount = 0;

  var sheetOrder = _getSheetOrder();
  var total = sheetOrder.length;

  if (startIndex > 0) {
    for (var p = 0; p < startIndex; p++) {
      if (SS.getSheetByName(sheetOrder[p])) placedCount++;
    }
  }

  var i;
  for (i = startIndex; i < total; i++) {
    if (Date.now() - startTime > SHEET_FORMAT_MAX_RUNTIME_MS) {
      timedOut = true;
      break;
    }
    var name = sheetOrder[i];
    try {
      var cfg = SHEET_FORMAT_CONFIG[name];
      var sheet = SS.getSheetByName(name);
      if (!sheet) {
        results.push("⏭️ " + name + ": غير موجود — تخطّي");
        continue;
      }

      var sheetErrors = [];

      // ── ترتيب التبويب — [PERF-CHUNK-1] بنتخطى moveActiveSheet خالص
      // لو الشيت أصلاً في مكانه الصح (أغلى نداء في اللوب) ──
      placedCount++;
      try {
        var desiredIndex = placedCount; // 1-based، مبني على الشيتات الموجودة فعليًا بس
        if (sheet.getIndex() !== desiredIndex) {
          SS.setActiveSheet(sheet);
          SS.moveActiveSheet(desiredIndex);
          movedCount++;
        } else {
          skippedMoveCount++;
        }
      } catch (eMove) {
        sheetErrors.push("ترتيب التبويب: " + eMove.message);
      }

      if (!cfg) {
        results.push(
          " " +
            name +
            ": مرتّب بس بلا cfg تنسيق" +
            (sheetErrors.length ? " | " + sheetErrors.join(" | ") : ""),
        );
        continue;
      }

      // ── [PERF-MERGE-1] باقي خطوات التنسيق (تجميد/لون/RTL/عرض/ارتفاع/
      // Banding/خط) بقت في _formatSingleSheet — وبتتخطّى نفسها تلقائيًا
      // لو الشيت اتنسّق قبل كده في نفس التشغيلة (مثلاً عبر setupAllSheets) ──
      sheetErrors = sheetErrors.concat(_formatSingleSheet(sheet, name));

      if (sheetErrors.length === 0) {
        results.push(" " + name);
      } else {
        errors++;
        results.push(" " + name + ": " + sheetErrors.join(" | "));
      }
    } catch (eOuter) {
      // [DIAG-8ERR-2] أي خطأ غير متوقّع خارج الـ try/catch الفردية
      // (مثلاً في قراءة الشيت نفسه) — بنسجّله باسم الشيت ونكمّل، بدل ما
      // يوقف applySheetFormatting بالكامل من غير ما نعرف الشيت المسؤول.
      errors++;
      results.push(" " + name + ": خطأ غير متوقع — " + (eOuter && eOuter.message));
    }
  }

  // ── [FIX-TIMEOUT-1] لو وقفنا بسبب الوقت — نحفظ التقدّم ونجدول استكمال
  // تلقائي بدل ما نضيع اللي خلصناه ونرجّع "Exceeded maximum execution time" ──
  if (timedOut) {
    try {
      props.setProperty(SHEET_FORMAT_PROGRESS_KEY, String(i));
    } catch (eSave) {
      Logger.log(" فشل حفظ تقدّم التنسيق: " + (eSave.message || eSave));
    }
    try {
      _scheduleFormattingContinuation();
    } catch (eSched) {
      Logger.log(" فشل جدولة استكمال التنسيق: " + (eSched.message || eSched));
    }
    var partialSummary =
      "applySheetFormatting (جزئي):\n" +
      results.join("\n") +
      "\n⏸️ اتوقف مؤقتًا عند الشيت " +
      i +
      "/" +
      total +
      " (قارب على حد وقت التنفيذ) — هيكمل تلقائيًا خلال ثوانٍ عبر Trigger مجدول";
    Logger.log(partialSummary);
    return (
      " تنسيق جزئي (" +
      i +
      "/" +
      total +
      ") — هيكمل تلقائيًا خلال ثوانٍ | نُقل: " +
      movedCount +
      " | كان مرتّب أصلاً: " +
      skippedMoveCount
    );
  }

  // ── خلّصنا كل الشيتات ──
  // تنظيف أي بقايا من آلية التقسيم القديمة (لو موجودة من نسخة سابقة)
  try {
    props.deleteProperty(SHEET_FORMAT_PROGRESS_KEY);
  } catch (eCleanup) {
    /* تجاهل */
  }
  _removeFormattingContinuationTrigger();

  var summary = "applySheetFormatting:\n" + results.join("\n");
  Logger.log(summary);
  Logger.log(
    errors === 0
      ? " تم ترتيب وتنسيق كل الشيتات بنجاح (نُقل فعليًا: " +
          movedCount +
          " | كان مرتّب أصلاً: " +
          skippedMoveCount +
          ")"
      : " " + errors + " خطأ في التنسيق",
  );
  return errors === 0
    ? " تم ترتيب وتنسيق كل الشيتات (" +
        total +
        ") — نُقل: " +
        movedCount +
        " | كان مرتّب أصلاً: " +
        skippedMoveCount
    : " " + errors + " خطأ — راجع اللوج";
}

/**
 * applySheetFormattingAutoContinue — [PERF-CHUNK-1] الدالة اللي بينادي
 * عليها الـ Trigger المؤقّت لاستكمال التنسيق تلقائيًا. مجرد wrapper
 * رقيق فوق applySheetFormatting نفسها.
 */
function applySheetFormattingAutoContinue() {
  applySheetFormatting();
}

/**
 * _scheduleFormattingContinuation — [PERF-CHUNK-1] بيجدول Trigger
 * مؤقّت (بعد 10 ثواني) يكمّل التنسيق تلقائيًا. لو فيه Trigger مجدول
 * أصلاً، مبيكررش (يمنع تراكم Triggers لو applySheetFormatting اتنادت
 * أكتر من مرة وهي شغالة).
 */
function _scheduleFormattingContinuation() {
  var already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === SHEET_FORMAT_CONTINUE_HANDLER;
  });
  if (already) return;
  ScriptApp.newTrigger(SHEET_FORMAT_CONTINUE_HANDLER)
    .timeBased()
    .after(10 * 1000)
    .create();
}

/**
 * _removeFormattingContinuationTrigger — [PERF-CHUNK-1] بتشيل أي
 * Trigger استكمال متبقي بعد ما التنسيق يخلص بالكامل، عشان ملفضلش
 * Trigger يتيم شغال من غير داعي.
 */
function _removeFormattingContinuationTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === SHEET_FORMAT_CONTINUE_HANDLER) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/**
 * getFormattingProgress — [PERF-CHUNK-1] لمتابعة تقدّم التنسيق وسط
 * التنفيذ (مفيدة لو حابب تعرف وصل لفين من غير ما تدخل الـ Logs).
 */
function getFormattingProgress() {
  var props = PropertiesService.getScriptProperties();
  var idx = Number(props.getProperty(SHEET_FORMAT_PROGRESS_KEY) || 0);
  var total = _getSheetOrder().length;
  var hasScheduledContinuation = ScriptApp.getProjectTriggers().some(
    function (t) {
      return t.getHandlerFunction() === SHEET_FORMAT_CONTINUE_HANDLER;
    },
  );
  if (idx === 0 && !hasScheduledContinuation) {
    return " مفيش تنسيق شغال أو متوقف حاليًا (إما خلص أو لسه ما بدأش)";
  }
  return (
    " آخر نقطة محفوظة: الشيت " +
    idx +
    "/" +
    total +
    (hasScheduledContinuation
      ? " — فيه Trigger استكمال مجدول هيشتغل قريب"
      : " — مفيش Trigger استكمال مجدول حاليًا (شغّل applySheetFormatting يدوي عشان يكمل)")
  );
}

/**
 * resetFormattingProgress — [PERF-CHUNK-1] لإلغاء أي استئناف مجدول
 * والبدء من الشيت الأول تاني في المرة الجاية اللي applySheetFormatting
 * هتتنفذ فيها.
 */
function resetFormattingProgress() {
  PropertiesService.getScriptProperties().deleteProperty(
    SHEET_FORMAT_PROGRESS_KEY,
  );
  _removeFormattingContinuationTrigger();
  return " اتصفّر تقدّم التنسيق — applySheetFormatting الجاية هتبدأ من الشيت الأول";
}

// ─────────────────────────────────────────────────────────────

// ── [MAINT-FIX-4] دوال الـ Migration كانت هنا، نُقلت إلى Code_21b_Migrations.js
// ثم اتحذفت نهائيًا فى [COA-V2 CLEANUP-2026-08] (migrateStockAddColorColumn,
// migrateColorsToNewFormat, removePermitIdColumn — خلصوا شغلهم بالفعل).

// ============================================================
//— واتساب أوتوماتيك
//  أضف هذا الكود في نهاية Code.js
//  يعتمد على CallMeBot API (مجاني) لإرسال واتساب
// ============================================================

// ── إعدادات التقارير ──────────────────────────────────────────

/**
 * WEEKLY_REPORT_SHEET_HEADERS
 * أعمدة شيت WeeklyReportConfig:
 *   username      → اسم المستخدم في النظام
 *   full_name     → الاسم الكامل
 *   phone         → رقم الواتساب بالصيغة الدولية: 201001234567
 *   apikey        → المفتاح من CallMeBot (كل رقم بمفتاحه)
 *   active        → TRUE / FALSE
 *   report_types  → all | stock,transactions,alerts (مفصولة بفاصلة)
 *   last_sent     → تاريخ آخر إرسال (يتعبأ تلقائياً)
 */
var WEEKLY_REPORT_HEADERS = [
  "username",
  "full_name",
  "phone",
  "apikey",
  "active",
  "report_types",
  "last_sent",
];

// ── قراءة/تهيئة شيت إعدادات التقارير ──────────────────────────

function getReportConfigSheet() {
  var sheet = SS.getSheetByName("WeeklyReportConfig");
  if (!sheet) {
    sheet = SS.insertSheet("WeeklyReportConfig");
    sheet
      .getRange(1, 1, 1, WEEKLY_REPORT_HEADERS.length)
      .setValues([WEEKLY_REPORT_HEADERS]);
    styleHeaderRow(sheet, WEEKLY_REPORT_HEADERS.length);
    _protectTextColumns(sheet, WEEKLY_REPORT_HEADERS); // حماية رقم الهاتف
    // صف مثال
    sheet.appendRow([
      "admin",
      "مدير النظام",
      "201001234567",
      "YOUR_CALLMEBOT_APIKEY",
      "TRUE",
      "all",
      "",
    ]);
  }
  return sheet;
}

function getReportConfigs() {
  var sheet = getReportConfigSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var headers = data[0];
  return data.slice(1).map(function (row, i) {
    var obj = { _row: i + 2 };
    headers.forEach(function (h, j) {
      obj[h] = row[j];
    });
    return obj;
  });
}

// ── CRUD إعدادات التقارير (يُستدعى من الـ frontend) ──────────

function getWeeklyReportConfigs() {
  try {
    var configs = getReportConfigs().map(function (c) {
      return {
        username: c.username,
        full_name: c.full_name,
        phone: c.phone,
        apikey: c.apikey ? "****" + String(c.apikey).slice(-4) : "", // أخفِ المفتاح
        active: _isActiveUser(c.active),
        report_types: c.report_types || "all",
        last_sent: c.last_sent
          ? c.last_sent instanceof Date
            ? c.last_sent.toISOString()
            : c.last_sent
          : "",
      };
    });
    return { success: true, data: configs };
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// [P9-FIX] أُضيف sessionToken — كانت تقبل أي username بدون التحقق أنه جلسة حقيقية
function saveWeeklyReportConfig(cfg, callerUser, sessionToken) {
  try {
    // فقط admin يحق له تعديل إعدادات التقارير الأسبوعية
    var permErr = _checkPermission(
      callerUser || (cfg && cfg.username),
      "manageRoles",
      sessionToken,
    );
    if (permErr) return permErr;

    if (!cfg.username) return errResponse("اسم المستخدم مطلوب");
    if (!cfg.phone) return errResponse("رقم الواتساب مطلوب");
    if (!cfg.apikey || cfg.apikey.startsWith("****"))
      return errResponse("يجب إدخال API Key كامل");

    var sheet = getReportConfigSheet();
    var configs = getReportConfigs();
    var existing = configs.find(function (c) {
      return String(c.username) === String(cfg.username);
    });

    var row = [
      cfg.username,
      cfg.full_name || cfg.username,
      String(cfg.phone).replace(/\D/g, ""), // أرقام فقط
      cfg.apikey,
      cfg.active !== false ? "TRUE" : "FALSE",
      cfg.report_types || "all",
      existing ? existing.last_sent || "" : "",
    ];

    if (existing) {
      sheet.getRange(existing._row, 1, 1, 7).setValues([row]);
      return okResponse(" تم تعديل إعدادات التقرير");
    } else {
      _appendRowProtected(sheet, WEEKLY_REPORT_HEADERS, row);
      return okResponse(" تم إضافة المستخدم للتقارير الأسبوعية");
    }
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// [P9-FIX] أُضيف callerUser و sessionToken — كانت تقبل حذف أي مستخدم بدون تحقق
function deleteWeeklyReportConfig(username, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
    if (permErr) return permErr;

    var configs = getReportConfigs();
    var rec = configs.find(function (c) {
      return String(c.username) === String(username);
    });
    if (!rec) return errResponse("المستخدم غير موجود في قائمة التقارير");
    getReportConfigSheet().deleteRow(rec._row);
    return okResponse(" تم حذف المستخدم من التقارير الأسبوعية");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ── بناء التقرير الأسبوعي ────────────────────────────────────

/**
 * buildWeeklyReportText
 * يبني نص التقرير الأسبوعي بناءً على أنواع التقارير المطلوبة
 * @param {string} reportTypes - "all" أو قائمة مفصولة: "stock,alerts"
 * @param {string} recipientName - اسم المستلم للتخصيص
 * @returns {string} نص الرسالة
 */
function buildWeeklyReportText(reportTypes, recipientName) {
  var types =
    reportTypes === "all"
      ? ["summary", "stock", "transactions", "alerts", "production"]
      : String(reportTypes)
          .split(",")
          .map(function (t) {
            return t.trim();
          });

  var now = new Date();
  var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  var dateStr = Utilities.formatDate(now, "GMT+2", "dd/MM/yyyy");
  var weekAgoStr = Utilities.formatDate(weekAgo, "GMT+2", "dd/MM/yyyy");

  var lines = [];
  lines.push(" *تقرير أسبوعي — MOO.ERP*");
  lines.push(" الفترة: " + weekAgoStr + " ← " + dateStr);
  lines.push(" " + (recipientName || "مدير النظام"));
  lines.push("─────────────────────");

  // ── ملخص عام ──
  if (types.indexOf("summary") !== -1 || types.indexOf("all") !== -1) {
    try {
      var stats = getDashboardStats();
      lines.push("");
      lines.push(" *ملخص عام*");
      lines.push("• إجمالي الأصناف: " + (stats.totalItems || 0));
      lines.push("• إجمالي المخزون: " + (stats.totalStock || 0) + " وحدة");
      lines.push("• حركات اليوم: " + (stats.todayTx || 0));
      lines.push("• أوامر إنتاج معلقة: " + (stats.pendingPO || 0));
      if (stats.alerts > 0) {
        lines.push(" أصناف تحت الحد الأدنى: " + stats.alerts);
      }
    } catch (e) {
      lines.push(" تعذّر جلب الملخص: " + e.message);
    }
  }

  // ── حركات الأسبوع ──
  if (types.indexOf("transactions") !== -1 || types.indexOf("all") !== -1) {
    try {
      var txAll = getSheetData("Transactions");
      var weekTx = txAll.filter(function (t) {
        var d = t.date ? new Date(t.date) : null;
        return d && d >= weekAgo && d <= now;
      });

      var txIn = weekTx.filter(function (t) {
        return (
          t.type === "IN" || t.type === "FG_IN" || t.type === "FACTORY_RETURN"
        );
      });
      var txOut = weekTx.filter(function (t) {
        return t.type === "OUT" || t.type === "DISPATCH";
      });
      var txTrf = weekTx.filter(function (t) {
        return t.type === "TRANSFER";
      });

      var totalQtyIn = txIn.reduce(function (s, t) {
        return s + Number(t.quantity || 0);
      }, 0);
      var totalQtyOut = txOut.reduce(function (s, t) {
        return s + Number(t.quantity || 0);
      }, 0);

      lines.push("");
      lines.push(" *حركات الأسبوع*");
      lines.push("• وارد: " + txIn.length + " حركة (" + totalQtyIn + " وحدة)");
      lines.push(
        "• صادر: " + txOut.length + " حركة (" + totalQtyOut + " وحدة)",
      );
      lines.push("• تحويلات: " + txTrf.length + " حركة");
      lines.push("• إجمالي الحركات: " + weekTx.length);
    } catch (e) {
      lines.push(" تعذّر جلب الحركات: " + e.message);
    }
  }

  // ── تنبيهات المخزون ──
  if (types.indexOf("alerts") !== -1 || types.indexOf("all") !== -1) {
    try {
      var stockReport = getStockReport();
      if (stockReport.success) {
        var lowItems = stockReport.data.filter(function (item) {
          return item.status === "منخفض" || item.status === "نفد";
        });

        lines.push("");
        lines.push(" *تنبيهات المخزون*");
        if (lowItems.length === 0) {
          lines.push(" جميع الأصناف في المستوى الطبيعي");
        } else {
          lines.push("الأصناف التي تحتاج انتباه (" + lowItems.length + "):");
          lowItems.slice(0, 10).forEach(function (item) {
            var icon = item.status === "نفد" ? "" : "";
            lines.push(
              icon +
                " " +
                item.name +
                " — الكمية: " +
                item.quantity +
                " | الحد: " +
                item.minQty,
            );
          });
          if (lowItems.length > 10) {
            lines.push("... و " + (lowItems.length - 10) + " صنف آخر");
          }
        }
      }
    } catch (e) {
      lines.push(" تعذّر جلب تنبيهات المخزون: " + e.message);
    }
  }

  // ── الأصناف الأعلى حركةً ──
  if (types.indexOf("stock") !== -1 || types.indexOf("all") !== -1) {
    try {
      var allTx2 = getSheetData("Transactions");
      var weekTx2 = allTx2.filter(function (t) {
        var d = t.date ? new Date(t.date) : null;
        return d && d >= weekAgo && d <= now;
      });

      var itemMovement = {};
      weekTx2.forEach(function (t) {
        var id = t.item_id;
        if (!id) return;
        itemMovement[id] = (itemMovement[id] || 0) + Number(t.quantity || 0);
      });

      var topItems = Object.keys(itemMovement)
        .map(function (id) {
          return { id: id, qty: itemMovement[id] };
        })
        .sort(function (a, b) {
          return b.qty - a.qty;
        })
        .slice(0, 5);

      if (topItems.length > 0) {
        var allItems = getSheetData("Items");
        lines.push("");
        lines.push(" *أعلى 5 أصناف حركةً هذا الأسبوع*");
        topItems.forEach(function (t, i) {
          var itemObj = allItems.find(function (it) {
            return String(it.id) === String(t.id);
          });
          var name = itemObj ? itemObj.name : t.id;
          lines.push(i + 1 + ". " + name + " — " + t.qty + " وحدة");
        });
      }
    } catch (e) {
      lines.push(" تعذّر جلب أعلى الأصناف: " + e.message);
    }
  }

  // ── أوامر الإنتاج ──
  if (types.indexOf("production") !== -1 || types.indexOf("all") !== -1) {
    try {
      var allPO = getSheetData("ProductionOrders");
      var weekPO = allPO.filter(function (po) {
        var d = po.date ? new Date(po.date) : null;
        return d && d >= weekAgo && d <= now;
      });
      var pendingPO2 = allPO.filter(function (po) {
        return po.status === "pending";
      });
      var donePO = weekPO.filter(function (po) {
        return po.status === "done";
      });

      lines.push("");
      lines.push(" *أوامر الإنتاج*");
      lines.push("• أوامر هذا الأسبوع: " + weekPO.length);
      lines.push("• مكتملة هذا الأسبوع: " + donePO.length);
      lines.push("• معلقة (إجمالي): " + pendingPO2.length);
    } catch (e) {
      lines.push(" تعذّر جلب أوامر الإنتاج: " + e.message);
    }
  }

  lines.push("");
  lines.push("─────────────────────");
  lines.push(
    " تم الإرسال تلقائياً — " +
      Utilities.formatDate(now, "GMT+2", "dd/MM/yyyy HH:mm"),
  );

  return lines.join("\n");
}
// ── إرسال تيليجرام ──────────────────────────────────────────

function sendTelegram(chatId, botToken, message) {
  try {
    var url = "https://api.telegram.org/bot" + botToken + "/sendMessage";
    var payload = {
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown",
    };
    var options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };
    var response = UrlFetchApp.fetch(url, options);
    var status = response.getResponseCode();
    var body = JSON.parse(response.getContentText());
    if (status === 200 && body.ok) {
      return { success: true, message: "تم الإرسال بنجاح" };
    } else {
      Logger.log("TELEGRAM ERROR: " + status + " | " + JSON.stringify(body));
      return {
        success: false,
        message: "فشل: " + status + " - " + JSON.stringify(body),
      };
    }
  } catch (e) {
    return { success: false, message: "خطأ: " + e.message };
  }
}

// ── إعداد/حذف Trigger المرن ──────────────────────────────────
//
// config = {
//   frequency  : "weekly" | "twice_weekly" | "monthly"
//   day1       : "MONDAY"|"TUESDAY"|"WEDNESDAY"|"THURSDAY"|"FRIDAY"|"SATURDAY"|"SUNDAY"
//   day2       : (نفس القيم — للتكرار مرتين فقط)
//   hour       : 0-23
//   dayOfMonth : 1-28  (للتكرار الشهري فقط)
// }

function setupWeeklyTrigger(config, existingTriggers) {
  config = config || {};
  var frequency = config.frequency || "weekly";
  var day1 = config.day1 || "SUNDAY";
  var day2 = config.day2 || "WEDNESDAY";
  var hour = Number(config.hour) || 8;
  var dayOfMonth = Number(config.dayOfMonth) || 1;

  // احذف كل الـ Triggers القديمة
  // [PERF-TRIGGERS-1] استخدم القايمة الجاهزة من setupEverything لو موجودة
  // (existingTriggers جايه من ScriptApp.getProjectTriggers() في هذه الحالة،
  // لكنها تُرجع نفس مجموعة الـ Triggers الخاصة بهذا المشروع مثل getUserTriggers(SS))
  (existingTriggers || ScriptApp.getUserTriggers(SS)).forEach(function (t) {
    if (t.getHandlerFunction() === "sendWeeklyReportsPDF") {
      ScriptApp.deleteTrigger(t);
    }
  });

  var DAY_MAP = {
    MONDAY: ScriptApp.WeekDay.MONDAY,
    TUESDAY: ScriptApp.WeekDay.TUESDAY,
    WEDNESDAY: ScriptApp.WeekDay.WEDNESDAY,
    THURSDAY: ScriptApp.WeekDay.THURSDAY,
    FRIDAY: ScriptApp.WeekDay.FRIDAY,
    SATURDAY: ScriptApp.WeekDay.SATURDAY,
    SUNDAY: ScriptApp.WeekDay.SUNDAY,
  };

  var DAY_AR = {
    MONDAY: "الاثنين",
    TUESDAY: "الثلاثاء",
    WEDNESDAY: "الأربعاء",
    THURSDAY: "الخميس",
    FRIDAY: "الجمعة",
    SATURDAY: "السبت",
    SUNDAY: "الأحد",
  };

  var label = "";

  if (frequency === "monthly") {
    ScriptApp.newTrigger("sendWeeklyReportsPDF")
      .timeBased()
      .onMonthDay(dayOfMonth)
      .atHour(hour)
      .create();
    label = "كل شهر يوم " + dayOfMonth + " الساعة " + hour + ":00";
  } else if (frequency === "twice_weekly") {
    ScriptApp.newTrigger("sendWeeklyReportsPDF")
      .timeBased()
      .everyWeeks(1)
      .onWeekDay(DAY_MAP[day1] || DAY_MAP.SUNDAY)
      .atHour(hour)
      .create();
    ScriptApp.newTrigger("sendWeeklyReportsPDF")
      .timeBased()
      .everyWeeks(1)
      .onWeekDay(DAY_MAP[day2] || DAY_MAP.WEDNESDAY)
      .atHour(hour)
      .create();
    label =
      "مرتين أسبوعياً — " +
      (DAY_AR[day1] || day1) +
      " و" +
      (DAY_AR[day2] || day2) +
      " الساعة " +
      hour +
      ":00";
  } else {
    // weekly (default)
    ScriptApp.newTrigger("sendWeeklyReportsPDF")
      .timeBased()
      .everyWeeks(1)
      .onWeekDay(DAY_MAP[day1] || DAY_MAP.SUNDAY)
      .atHour(hour)
      .create();
    label = "كل " + (DAY_AR[day1] || day1) + " الساعة " + hour + ":00";
  }

  // حفظ الإعدادات في PropertiesService
  try {
    PropertiesService.getScriptProperties().setProperties({
      trigger_frequency: frequency,
      trigger_day1: day1,
      trigger_day2: day2,
      trigger_hour: String(hour),
      trigger_dayOfMonth: String(dayOfMonth),
      trigger_label: label,
    });
  } catch (e) {
    /* تجاهل لو فشل الحفظ */
  }

  return { success: true, message: " تم ضبط الجدولة — " + label };
}

function removeWeeklyTrigger(callerUser, sessionToken) {
  // [BUG-006 FIX] كانت الدالة دي بتتنفذ بدون أي فحص صلاحية رغم ارتباطها
  // بزر فعلي في واجهة إعدادات التقارير الأسبوعية — أي مستخدم مسجّل دخول
  // كان يقدر يوقف الجدولة. نفس صلاحية saveWeeklyReportConfig/
  // deleteWeeklyReportConfig ("manageRoles") المستخدمة في نفس الملف.
  var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
  if (permErr) return permErr;

  var count = 0;
  ScriptApp.getUserTriggers(SS).forEach(function (t) {
    if (t.getHandlerFunction() === "sendWeeklyReportsPDF") {
      ScriptApp.deleteTrigger(t);
      count++;
    }
  });
  try {
    PropertiesService.getScriptProperties().deleteProperty("trigger_label");
  } catch (e) {
    console.error("removeWeeklyTrigger - خطأ:", e.message || e);
  }
  return {
    success: true,
    message: count > 0 ? " تم حذف الـ Trigger" : "ℹ️ لا يوجد Trigger مفعّل",
  };
}

function getTriggerStatus(callerUser, sessionToken) {
  // [BUG-006 FIX] نفس فحص الصلاحية — دالة قراءة لحالة الجدولة لكنها ما
  // كانتش محمية هي كمان رغم إنها في نفس مسار الشاشة الإدارية.
  var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
  if (permErr) return permErr;
  try {
    var triggers = ScriptApp.getUserTriggers(SS).filter(function (t) {
      return t.getHandlerFunction() === "sendWeeklyReportsPDF";
    });

    var props = {};
    try {
      props = PropertiesService.getScriptProperties().getProperties();
    } catch (e) {
      console.error("getTriggerStatus - خطأ:", e.message || e);
    }

    var label = props.trigger_label || "يُرسل تلقائياً";

    return {
      success: true,
      active: triggers.length > 0,
      count: triggers.length,
      message: triggers.length > 0 ? " " + label : " الجدولة غير مفعّلة",
      frequency: props.trigger_frequency || "weekly",
      day1: props.trigger_day1 || "SUNDAY",
      day2: props.trigger_day2 || "WEDNESDAY",
      hour: Number(props.trigger_hour) || 8,
      dayOfMonth: Number(props.trigger_dayOfMonth) || 1,
    };
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}
// ============================================================
//  نظام التقارير الأسبوعية — PDF مرفق على تيليجرام
//  أضف هذا الكود في نهاية Code.js
//  يولّد PDF احترافي من HTML ويبعته على تيليجرام
// ============================================================

// ── بناء HTML التقرير الاحترافي ──────────────────────────────

function buildReportHTML(reportTypes, recipientName) {
  var types =
    reportTypes === "all"
      ? ["summary", "stock", "transactions", "alerts", "production"]
      : String(reportTypes)
          .split(",")
          .map(function (t) {
            return t.trim();
          });

  var now = new Date();
  var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  var dateStr = Utilities.formatDate(now, "GMT+2", "dd/MM/yyyy");
  var weekAgoStr = Utilities.formatDate(weekAgo, "GMT+2", "dd/MM/yyyy");
  var timeStr = Utilities.formatDate(now, "GMT+2", "dd/MM/yyyy HH:mm");

  // ── جمع البيانات ──────────────────────────────────────────
  var stats = {};
  var txData = {
    in_count: 0,
    in_qty: 0,
    out_count: 0,
    out_qty: 0,
    transfer_count: 0,
    total: 0,
  };
  var alertItems = [];
  var topItems = [];
  var prodData = { week_count: 0, done_count: 0, pending_count: 0 };

  // ملخص عام
  if (types.indexOf("summary") !== -1) {
    try {
      stats = getDashboardStats();
    } catch (e) {
      stats = {};
    }
  }

  // حركات الأسبوع
  if (types.indexOf("transactions") !== -1) {
    try {
      var allTx = getSheetData("Transactions");
      var weekTx = allTx.filter(function (t) {
        var d = t.date ? new Date(t.date) : null;
        return d && d >= weekAgo && d <= now;
      });
      var txIn = weekTx.filter(function (t) {
        return (
          t.type === "IN" || t.type === "FG_IN" || t.type === "FACTORY_RETURN"
        );
      });
      var txOut = weekTx.filter(function (t) {
        return t.type === "OUT" || t.type === "DISPATCH";
      });
      var txTrf = weekTx.filter(function (t) {
        return t.type === "TRANSFER";
      });
      txData.in_count = txIn.length;
      txData.in_qty = txIn.reduce(function (s, t) {
        return s + Number(t.quantity || 0);
      }, 0);
      txData.out_count = txOut.length;
      txData.out_qty = txOut.reduce(function (s, t) {
        return s + Number(t.quantity || 0);
      }, 0);
      txData.transfer_count = txTrf.length;
      txData.total = weekTx.length;
    } catch (e) {
      console.error("unknown - خطأ:", e.message || e);
    }
  }

  // تنبيهات المخزون
  if (types.indexOf("alerts") !== -1) {
    try {
      var sr = getStockReport();
      if (sr.success) {
        alertItems = sr.data.filter(function (it) {
          return it.status === "منخفض" || it.status === "نفد";
        });
      }
    } catch (e) {
      console.error("unknown - خطأ:", e.message || e);
    }
  }

  // أعلى الأصناف
  if (types.indexOf("stock") !== -1) {
    try {
      var allTx2 = getSheetData("Transactions");
      var weekTx2 = allTx2.filter(function (t) {
        var d = t.date ? new Date(t.date) : null;
        return d && d >= weekAgo && d <= now;
      });
      var mvMap = {};
      weekTx2.forEach(function (t) {
        var id = t.item_id;
        if (!id) return;
        mvMap[id] = (mvMap[id] || 0) + Number(t.quantity || 0);
      });
      var allItems = getSheetData("Items");
      topItems = Object.keys(mvMap)
        .map(function (id) {
          var it = allItems.find(function (x) {
            return String(x.id) === String(id);
          });
          return { name: it ? it.name : id, qty: mvMap[id] };
        })
        .sort(function (a, b) {
          return b.qty - a.qty;
        })
        .slice(0, 5);
    } catch (e) {
      console.error("unknown - خطأ:", e.message || e);
    }
  }

  // أوامر الإنتاج
  if (types.indexOf("production") !== -1) {
    try {
      var allPO = getSheetData("ProductionOrders");
      var weekPO = allPO.filter(function (po) {
        var d = po.date ? new Date(po.date) : null;
        return d && d >= weekAgo && d <= now;
      });
      prodData.week_count = weekPO.length;
      prodData.done_count = weekPO.filter(function (po) {
        return po.status === "done";
      }).length;
      prodData.pending_count = allPO.filter(function (po) {
        return po.status === "pending";
      }).length;
    } catch (e) {
      console.error("unknown - خطأ:", e.message || e);
    }
  }

  // ── بناء HTML — تصميم راقي صفحة واحدة ────────────────────
  var S = {
    page: "@page{margin:8mm 10mm} * {margin:0;padding:0;box-sizing:border-box} body{font-family:Arial,sans-serif;font-size:10px;color:#1e293b;direction:rtl;background:#fff}",
    hdr: ".hdr{background:#0f2544;padding:10px 14px;margin-bottom:8px} .hdr-title{font-size:15px;font-weight:bold;color:#fff;margin-bottom:3px} .hdr-meta{font-size:9px;color:#93c5fd}",
    kpi: ".kpi{width:100%;border-collapse:collapse;margin-bottom:8px;table-layout:fixed} .kpi td{width:25%;padding:8px 6px;text-align:center;border:2px solid #fff} .ki{font-size:16px;display:block;margin-bottom:2px} .kn{font-size:16px;font-weight:bold;display:block;margin-bottom:1px} .kl{font-size:8px;color:#6b7280} .kb{background:#dbeafe} .kb .kn{color:#1d4ed8} .kg{background:#d1fae5} .kg .kn{color:#059669} .ky{background:#fef3c7} .ky .kn{color:#d97706} .kr{background:#fee2e2} .kr .kn{color:#dc2626}",
    layout:
      ".two{width:100%;border-collapse:collapse;margin-bottom:8px} .two td{vertical-align:top;padding:0} .two td:first-child{width:55%;padding-left:6px} .two td:last-child{width:45%}",
    sec: ".sec{font-size:10px;font-weight:bold;color:#0f2544;margin:8px 0 5px 0;padding-bottom:3px;border-bottom:2px solid #2563eb}",
    tbl: "table.dt{width:100%;border-collapse:collapse} table.dt th{background:#2563eb;color:#fff;padding:5px 7px;text-align:center;font-size:9px;font-weight:bold} table.dt td{padding:5px 7px;text-align:center;font-size:9px;border-bottom:1px solid #f1f5f9} table.dt tr:nth-child(even) td{background:#f8fafc} table.dt td.nc{text-align:right;font-weight:bold}",
    alert:
      "table.at th{background:#dc2626} .so{color:#dc2626;font-weight:bold} .sl{color:#d97706;font-weight:bold}",
    prod: ".pc{background:#dbeafe;border:1px solid #93c5fd;padding:10px;text-align:center;margin-bottom:6px} .pt{font-size:10px;font-weight:bold;color:#0f2544;margin-bottom:6px} .pb{font-size:20px;font-weight:bold;color:#1d4ed8} .ps{font-size:8px;color:#6b7280;margin-bottom:6px} .pmt{width:90%;margin:0 auto;border-collapse:collapse;table-layout:fixed} .pmt td{width:50%;padding:6px;text-align:center;border:1px solid #e5e7eb;font-size:9px} .pmg{background:#d1fae5} .pmg .pmn{color:#059669} .pmy{background:#fef3c7} .pmy .pmn{color:#d97706} .pmn{font-size:14px;font-weight:bold;display:block} .pml{font-size:8px;color:#6b7280}",
    misc: ".ok{background:#d1fae5;border:1px solid #6ee7b7;padding:8px;text-align:center;color:#065f46;font-weight:bold;font-size:9px;margin-bottom:6px} .ftr{margin-top:8px;padding-top:6px;border-top:1px solid #e5e7eb;text-align:center;color:#9ca3af;font-size:8px}",
  };

  var css =
    S.page +
    S.hdr +
    S.kpi +
    S.layout +
    S.sec +
    S.tbl +
    S.alert +
    S.prod +
    S.misc;

  var html =
    '<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><style>' +
    css +
    "</style></head><body>";

  // ── Header ────────────────────────────────────────────────
  html += '<div class="hdr">';
  html += '<div class="hdr-title"> التقرير الأسبوعي — MOO.ERP</div>';
  html +=
    '<div class="hdr-meta"> الفترة: ' +
    weekAgoStr +
    " ← " +
    dateStr +
    " &nbsp;|&nbsp; " +
    (recipientName || "مدير النظام") +
    "</div>";
  html += "</div>";

  // ── KPI ───────────────────────────────────────────────────
  html += '<table class="kpi"><tr>';
  html += _kpiCard("", _fmt(stats.totalItems || 0), "إجمالي الأصناف", "kb");
  html += _kpiCard("", _fmt(stats.totalStock || 0), "إجمالي المخزون", "kg");
  html += _kpiCard("", _fmt(txData.total), "حركات الأسبوع", "ky");
  html += _kpiCard("", _fmt(alertItems.length), "تنبيهات المخزون", "kr");
  html += "</tr></table>";

  // ── حركات + إنتاج جنب بعض ────────────────────────────────
  html += '<div class="sec"> حركات الأسبوع وأوامر الإنتاج</div>';
  html += '<table class="two"><tr>';

  // العمود الأيمن: جدول الحركات
  html += "<td>";
  html += '<table class="dt">';
  html += "<tr><th>النوع</th><th>حركات</th><th>كميات</th></tr>";
  html +=
    '<tr><td class="nc"> وارد</td><td>' +
    _fmt(txData.in_count) +
    "</td><td>" +
    _fmt(txData.in_qty) +
    " و</td></tr>";
  html +=
    '<tr><td class="nc"> صادر</td><td>' +
    _fmt(txData.out_count) +
    "</td><td>" +
    _fmt(txData.out_qty) +
    " و</td></tr>";
  html +=
    '<tr><td class="nc"> تحويل</td><td>' +
    _fmt(txData.transfer_count) +
    "</td><td>—</td></tr>";
  html +=
    '<tr style="background:#dbeafe;font-weight:bold"><td class="nc"> الإجمالي</td><td>' +
    _fmt(txData.total) +
    "</td><td>—</td></tr>";
  html += "</table></td>";

  // العمود الأيسر: أوامر الإنتاج
  html += "<td>";
  html += '<div class="pc">';
  html += '<div class="pt"> أوامر الإنتاج</div>';
  html += '<div class="pb">' + _fmt(prodData.week_count) + "</div>";
  html += '<div class="ps">أمر هذا الأسبوع</div>';
  html += '<table class="pmt"><tr>';
  html +=
    '<td class="pmg"><span class="pmn">' +
    _fmt(prodData.done_count) +
    '</span><span class="pml"> مكتملة</span></td>';
  html +=
    '<td class="pmy"><span class="pmn">' +
    _fmt(prodData.pending_count) +
    '</span><span class="pml">⏳ معلقة</span></td>';
  html += "</tr></table></div>";
  html += "</td></tr></table>";

  // ── تنبيهات المخزون ───────────────────────────────────────
  html += '<div class="sec"> تنبيهات المخزون</div>';
  if (!alertItems.length) {
    html +=
      '<div class="ok"> جميع الأصناف في المستوى الطبيعي — لا توجد تنبيهات</div>';
  } else {
    html += '<table class="dt at">';
    html +=
      "<tr><th>الصنف</th><th>الكمية</th><th>الحد الأدنى</th><th>الحالة</th></tr>";
    alertItems.slice(0, 10).forEach(function (item) {
      var isOut = item.status === "نفد";
      html += "<tr>";
      html += '<td class="nc">' + _esc(item.name || "—") + "</td>";
      html += "<td>" + _fmt(item.quantity || 0) + "</td>";
      html += "<td>" + _fmt(item.minQty || 0) + "</td>";
      html +=
        '<td><span class="' +
        (isOut ? "so" : "sl") +
        '">' +
        _esc(item.status || "—") +
        "</span></td>";
      html += "</tr>";
    });
    if (alertItems.length > 10) {
      html +=
        '<tr><td colspan="4" style="text-align:center;color:#6b7280;font-size:8px;">... و ' +
        (alertItems.length - 10) +
        " صنف آخر</td></tr>";
    }
    html += "</table>";
  }

  // ── أعلى الأصناف ──────────────────────────────────────────
  if (topItems.length) {
    html += '<div class="sec"> أعلى الأصناف حركةً هذا الأسبوع</div>';
    html += '<table class="dt">';
    html += "<tr><th>#</th><th>اسم الصنف</th><th>الكمية</th></tr>";
    var medals = ["", "", "", "4", "5"];
    topItems.forEach(function (item, i) {
      html += "<tr><td>" + medals[i] + "</td>";
      html += '<td class="nc">' + _esc(item.name || "—") + "</td>";
      html += "<td><strong>" + _fmt(item.qty || 0) + "</strong> و</td></tr>";
    });
    html += "</table>";
  }

  // ── Footer ────────────────────────────────────────────────
  html +=
    '<div class="ftr"> تم الإنشاء تلقائياً بواسطة MOO.ERP — ' +
    timeStr +
    "</div>";
  html += "</body></html>";
  return html;
}

// ── دوال مساعدة ──────────────────────────────────────────────

function _kpiCard(icon, num, label, cls) {
  return (
    '<td class="' +
    cls +
    '">' +
    '<span class="ki">' +
    icon +
    "</span>" +
    '<span class="kn">' +
    num +
    "</span>" +
    '<span class="kl">' +
    label +
    "</span>" +
    "</td>"
  );
}

function _fmt(n) {
  var num = Number(n || 0);
  // [FIX-AUDIT] كان "ar-EG" بيرجّع أرقام هندية (١٢٣) مخالفة لتوحيد الأرقام
  // system-wide اللي اتعمل (ar-EG → en-US) — هنا نُسيت وقت التوحيد.
  return num.toLocaleString("en-US");
}

function _esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── تحويل HTML لـ PDF ────────────────────────────────────────
// بيستخدم Puppeteer عبر خدمة خارجية أو أسلوب بديل

function _htmlToPdf(htmlContent, fileName) {
  var token = ScriptApp.getOAuthToken();

  // 1. ارفع HTML كـ Google Doc
  var boundary = "BOUNDARY_XYZ_123";
  var metadata = JSON.stringify({
    name: fileName,
    mimeType: "application/vnd.google-apps.document",
  });

  var body =
    "--" +
    boundary +
    "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    metadata +
    "\r\n" +
    "--" +
    boundary +
    "\r\n" +
    "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
    htmlContent +
    "\r\n" +
    "--" +
    boundary +
    "--";

  var uploadRes = UrlFetchApp.fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "post",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "multipart/related; boundary=" + boundary,
      },
      payload: body,
      muteHttpExceptions: true,
    },
  );

  // [FIX-AUDIT] كان JSON.parse هنا بدون أي حماية — لو Drive API رجّع خطأ
  // (auth/quota/غيره) بيرجع صفحة HTML أو نص عادي مش JSON، وكان هيرمي
  // exception غامض "Unexpected token" بدل رسالة واضحة تدل على السبب الحقيقي.
  var uploadStatus = uploadRes.getResponseCode();
  var uploadBody;
  try {
    uploadBody = JSON.parse(uploadRes.getContentText());
  } catch (e) {
    throw new Error(
      "فشل رفع HTML لـ Google Drive (كود " +
        uploadStatus +
        ") — استجابة غير صالحة، تأكد من صلاحيات Drive API",
    );
  }
  var docId = uploadBody.id;
  if (!docId)
    throw new Error(
      "فشل رفع HTML (كود " + uploadStatus + "): " + uploadRes.getContentText(),
    );

  // 2. صدّر PDF عبر export URL مباشرة
  var pdfRes = UrlFetchApp.fetch(
    "https://www.googleapis.com/drive/v3/files/" +
      docId +
      "/export?mimeType=application/pdf",
    {
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true,
    },
  );

  // [FIX-AUDIT] تحقق من كود الاستجابة قبل التعامل مع المحتوى كـ PDF صالح —
  // بدون هذا الفحص، فشل التصدير كان بيرجع blob لصفحة خطأ HTML بدل PDF فعلي
  // وتنبعت لتيليجرام أو تتخزن على Drive كأنها تقرير سليم.
  if (pdfRes.getResponseCode() !== 200) {
    // حاول تنضيف الـ Doc المؤقت حتى لو فشل التصدير
    try {
      UrlFetchApp.fetch("https://www.googleapis.com/drive/v3/files/" + docId, {
        method: "delete",
        headers: { Authorization: "Bearer " + token },
        muteHttpExceptions: true,
      });
    } catch (e) {
      Logger.log("[silent-catch] " + e);
    }
    throw new Error(
      "فشل تصدير PDF من Google Drive (كود " + pdfRes.getResponseCode() + ")",
    );
  }

  var pdfBlob = pdfRes.getBlob();
  pdfBlob.setName(fileName + ".pdf");
  pdfBlob.setContentType("application/pdf");

  // 3. احذف الـ Doc المؤقت
  UrlFetchApp.fetch("https://www.googleapis.com/drive/v3/files/" + docId, {
    method: "delete",
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true,
  });

  return pdfBlob;
}

// ── رفع PDF على Drive ────────────────────────────────────────

function _uploadPdfToDrive(pdfBlob) {
  // [FILE-ENGINE] كان بيكرر نفس منطق "إيجاد فولدر أو إنشاؤه" بدل استخدام
  // getOrCreateFolder الموجودة أصلاً — موحّد الآن عبر FileEngine.
  // ملاحظة: هذا Blob جاهز مُنشأ داخليًا من تقرير PDF (مش رفع مستخدم)، فمنطق
  // FileEngine.validate (تحقق نوع/حجم) مش منطبق هنا عمدًا — الاستثناء
  // مقصود ومُوثَّق، وليس سهوًا. سطر المشاركة موحّد الآن عبر FileEngine.shareFile
  // بدل تكرار DriveApp.Access.ANYONE_WITH_LINK يدويًا.
  var folder = FileEngine.getOrCreateFolder(
    "تقارير MOO.ERP",
    FileEngine.getSpreadsheetContainerFolder(),
  );
  var file = FileEngine.shareFile(folder.createFile(pdfBlob));
  return file;
}

// ── إرسال PDF على تيليجرام ───────────────────────────────────

function _sendTelegramDocument(chatId, botToken, fileBlob, caption) {
  try {
    var url = "https://api.telegram.org/bot" + botToken + "/sendDocument";
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      payload: {
        chat_id: String(chatId),
        caption: caption || " التقرير الأسبوعي",
        document: fileBlob,
      },
      muteHttpExceptions: true,
    });
    var status = response.getResponseCode();
    var body = JSON.parse(response.getContentText());
    if (status === 200 && body.ok) {
      return { success: true, message: "تم إرسال PDF بنجاح" };
    } else {
      // fallback: ابعت رابط Drive
      return {
        success: false,
        message: "فشل PDF: " + (body.description || status),
        fallback: true,
      };
    }
  } catch (e) {
    return { success: false, message: "خطأ: " + e.message, fallback: true };
  }
}

// ── الدالة الرئيسية: إرسال التقرير PDF ──────────────────────

function sendWeeklyReportsPDF() {
  var configs = getReportConfigs();
  var sheet = getReportConfigSheet();
  var sentCount = 0;
  var failCount = 0;
  var results = [];
  var now = new Date();
  var dateLabel = Utilities.formatDate(now, "GMT+2", "dd-MM-yyyy");

  configs.forEach(function (cfg) {
    if (!_isActiveUser(cfg.active)) return;
    if (!cfg.phone || !cfg.apikey) return;
    if (cfg.apikey === "YOUR_TELEGRAM_BOT_TOKEN") return;

    try {
      // 1. بناء HTML
      var html = buildReportHTML(
        cfg.report_types || "all",
        cfg.full_name || cfg.username,
      );

      // 2. تحويل لـ PDF
      var fileName = "تقرير-اسبوعي-" + dateLabel;
      var pdfBlob = _htmlToPdf(html, fileName);

      // 3. إرسال PDF مباشرة على تيليجرام
      var caption =
        " *التقرير الأسبوعي — MOO.ERP*\n" +
        " " +
        dateLabel +
        "\n" +
        " " +
        (cfg.full_name || cfg.username);

      var result = _sendTelegramDocument(
        String(cfg.phone).trim(),
        String(cfg.apikey).trim(),
        pdfBlob,
        caption,
      );

      if (result.success) {
        sheet.getRange(cfg._row, 7).setValue(now);
        sentCount++;
      } else if (result.fallback) {
        // Fallback: ارفع على Drive وابعت الرابط كـ text
        var driveFile = _uploadPdfToDrive(pdfBlob);
        var driveUrl = driveFile.getUrl();
        var textMsg = caption + "\n\n رابط التقرير:\n" + driveUrl;
        var txtResult = sendTelegram(
          String(cfg.phone).trim(),
          String(cfg.apikey).trim(),
          textMsg,
        );
        if (txtResult.success) {
          sheet.getRange(cfg._row, 7).setValue(now);
          sentCount++;
        } else {
          failCount++;
        }
      } else {
        failCount++;
      }

      results.push({
        username: cfg.username,
        success: result.success,
        message: result.message,
      });
    } catch (e) {
      failCount++;
      results.push({
        username: cfg.username,
        success: false,
        message: e.message,
      });
    }

    Utilities.sleep(800);
  });

  Logger.log(
    " تقارير PDF: تم إرسال " + sentCount + " | فشل " + failCount + " ",
  );

  return {
    success: true,
    sent: sentCount,
    failed: failCount,
    details: results,
    message:
      "تم إرسال " +
      sentCount +
      " تقرير PDF بنجاح" +
      (failCount > 0 ? " | فشل " + failCount : ""),
  };
}

// ── اختبار PDF لمستخدم واحد ──────────────────────────────────

function testWeeklyReportPDF(username) {
  try {
    var configs = getReportConfigs();
    var cfg = configs.find(function (c) {
      return String(c.username) === String(username);
    });
    if (!cfg) return errResponse("المستخدم غير موجود");
    if (!cfg.phone) return errResponse("Chat ID غير محدد");
    if (!cfg.apikey || cfg.apikey === "YOUR_TELEGRAM_BOT_TOKEN")
      return errResponse("يجب إدخال Bot Token");

    var html = buildReportHTML(
      cfg.report_types || "all",
      cfg.full_name || cfg.username,
    );
    var now = new Date();
    var dateLabel = Utilities.formatDate(now, "GMT+2", "dd-MM-yyyy");
    var pdfBlob = _htmlToPdf(html, "تجربة-تقرير-" + dateLabel);

    var caption =
      " *[تقرير تجريبي PDF]*\n " +
      dateLabel +
      "\n " +
      (cfg.full_name || cfg.username);
    var result = _sendTelegramDocument(
      String(cfg.phone).trim(),
      String(cfg.apikey).trim(),
      pdfBlob,
      caption,
    );

    if (result.success)
      return okResponse(" تم إرسال التقرير التجريبي PDF بنجاح");

    // Fallback رابط Drive
    var driveFile = _uploadPdfToDrive(pdfBlob);
    var driveUrl = driveFile.getUrl();
    var txtResult = sendTelegram(
      String(cfg.phone).trim(),
      String(cfg.apikey).trim(),
      caption + "\n\n رابط PDF:\n" + driveUrl,
    );
    return txtResult.success
      ? okResponse(" تم إرسال رابط PDF على تيليجرام")
      : errResponse("فشل الإرسال: " + result.message);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// نظام تحليل الألوان الذكي — يبحث عن hex لأي لون مش معروف
// ════════════════════════════════════════════════════════════════

/**
 * كود قصير (3-4 حروف EN) لكل اسم لون معروف — يُستخدم كاقتراح جاهز
 * لحقل "الكود" في شاشة إضافة لون جديد، بنفس منطق COLOR_CODE_MAP
 * الموجودة في العميل (07_JS_Shipping_Colors_Excel.html) حتى تتطابق.
 */
var _COLOR_CODE_MAP_SERVER = {
  أبيض: "WHT",
  ابيض: "WHT",
  white: "WHT",
  أسود: "BLK",
  اسود: "BLK",
  black: "BLK",
  أحمر: "RED",
  احمر: "RED",
  red: "RED",
  أزرق: "BLU",
  ازرق: "BLU",
  blue: "BLU",
  أخضر: "GRN",
  اخضر: "GRN",
  green: "GRN",
  أصفر: "YEL",
  اصفر: "YEL",
  yellow: "YEL",
  برتقالي: "ORG",
  برتقالى: "ORG",
  orange: "ORG",
  بنفسجي: "PRP",
  بنفسجى: "PRP",
  purple: "PRP",
  وردي: "PNK",
  وردى: "PNK",
  pink: "PNK",
  بني: "BRN",
  بنى: "BRN",
  brown: "BRN",
  رمادي: "GRY",
  رمادى: "GRY",
  grey: "GRY",
  gray: "GRY",
  ذهبي: "GLD",
  ذهبى: "GLD",
  gold: "GLD",
  فضي: "SLV",
  فضى: "SLV",
  silver: "SLV",
  كحلي: "NVY",
  كحلى: "NVY",
  navy: "NVY",
  سماوي: "CYN",
  سماوى: "CYN",
  cyan: "CYN",
  تيل: "TEL",
  teal: "TEL",
  زيتي: "OLV",
  زيتى: "OLV",
  olive: "OLV",
  خمري: "MAR",
  خمرى: "MAR",
  maroon: "MAR",
  بيج: "BEI",
  beige: "BEI",
  كريمي: "CRM",
  كريمى: "CRM",
  cream: "CRM",
  نيلي: "IND",
  نيلى: "IND",
  indigo: "IND",
  فيروزي: "TRQ",
  فيروزى: "TRQ",
  turquoise: "TRQ",
  بوردو: "WNE",
};

/** كود احتياطي مبني من الاسم نفسه لو مش موجود في الخريطة ولا رجع الذكاء الاصطناعي كود */
function _fallbackColorCode(name) {
  var n = (name || "").trim();
  if (!n) return "";
  var lower = n.toLowerCase();
  if (_COLOR_CODE_MAP_SERVER[n]) return _COLOR_CODE_MAP_SERVER[n];
  if (_COLOR_CODE_MAP_SERVER[lower]) return _COLOR_CODE_MAP_SERVER[lower];
  // لو الاسم لاتيني (إنجليزي) خُد أول 3 حروف
  // [ENGINE-AUDIT / Validation Engine] نفس الـ regex بالظبط الموجود في
  // ValidationEngine.isLettersOnly — اتوحّدت بدل نسخة محلية.
  if (ValidationEngine.isLettersOnly(n)) {
    return n.replace(/\s+/g, "").substring(0, 3).toUpperCase();
  }
  // لو عربي وملوش مقابل معروف — رجّع فاضي، الذكاء الاصطناعي هو اللي هيقترح كود مناسب
  return "";
}

/**
 * يحوّل اسم لون (عربي أو إنجليزي) لـ hex code + كود مقترح
 * الأولوية:
 *  1. خريطة الألوان المدمجة (QUICK_MAP)
 *  2. كاش Script Properties
 *  3. الذكاء الاصطناعي (Groq) — يفهم العربي والإنجليزي والمصطلحات الغريبة،
 *     ويقترح كود قصير للون كمان لو مش موجود بالخريطة المدمجة
 *  4. Fallback: لون + كود مبنيين من hash الاسم
 *
 * مخزّن في Script Properties عشان ما يطلب API كل مرة.
 */
function resolveColorHex(colorName) {
  if (!colorName || !colorName.trim())
    return { hex: "#94a3b8", code: "", source: "default" };

  var name = colorName.trim();
  var nameLower = name.toLowerCase();

  // ── 1. خريطة مدمجة سريعة ─────────────────────────────────────
  var QUICK_MAP = {
    أبيض: "#ffffff",
    ابيض: "#ffffff",
    white: "#ffffff",
    أسود: "#1a1a1a",
    اسود: "#1a1a1a",
    black: "#1a1a1a",
    أحمر: "#ef4444",
    احمر: "#ef4444",
    red: "#ef4444",
    أزرق: "#3b82f6",
    ازرق: "#3b82f6",
    blue: "#3b82f6",
    أخضر: "#22c55e",
    اخضر: "#22c55e",
    green: "#22c55e",
    أصفر: "#eab308",
    اصفر: "#eab308",
    yellow: "#eab308",
    برتقالي: "#f97316",
    برتقالى: "#f97316",
    orange: "#f97316",
    بنفسجي: "#9333ea",
    بنفسجى: "#9333ea",
    purple: "#9333ea",
    وردي: "#f472b6",
    وردى: "#f472b6",
    pink: "#ec4899",
    بني: "#92400e",
    بنى: "#92400e",
    brown: "#7c3f00",
    رمادي: "#6b7280",
    رمادى: "#6b7280",
    grey: "#9ca3af",
    gray: "#9ca3af",
    ذهبي: "#d97706",
    ذهبى: "#d97706",
    gold: "#d4af37",
    فضي: "#94a3b8",
    فضى: "#94a3b8",
    silver: "#c0c0c0",
    كحلي: "#1e3a5f",
    كحلى: "#1e3a5f",
    navy: "#001f5b",
    سماوي: "#38bdf8",
    سماوى: "#38bdf8",
    cyan: "#06b6d4",
    تيل: "#0d9488",
    teal: "#0d9488",
    زيتي: "#6b7c3c",
    زيتى: "#6b7c3c",
    olive: "#808000",
    خمري: "#9b2335",
    خمرى: "#9b2335",
    maroon: "#800000",
    بيج: "#f5deb3",
    beige: "#f5deb3",
    كريمي: "#f5f0dc",
    كريمى: "#f5f0dc",
    cream: "#fffdd0",
    نيلي: "#4338ca",
    نيلى: "#4338ca",
    indigo: "#4f46e5",
    فيروزي: "#06b6d4",
    فيروزى: "#06b6d4",
    turquoise: "#40e0d0",
    بوردو: "#800020",
  };
  if (QUICK_MAP[name])
    return {
      hex: QUICK_MAP[name],
      code: _fallbackColorCode(name),
      source: "map",
    };
  if (QUICK_MAP[nameLower])
    return {
      hex: QUICK_MAP[nameLower],
      code: _fallbackColorCode(name),
      source: "map",
    };

  // ── 2. كاش Script Properties ──────────────────────────────────
  var props = PropertiesService.getScriptProperties();
  var cacheKey = "color_hex_" + nameLower.replace(/[^a-z0-9أ-ي]/g, "_");
  var cached = props.getProperty(cacheKey);
  if (cached) {
    // الكاش ممكن يكون بالشكل القديم (hex نص عادي) أو الجديد (JSON فيه hex+code)
    try {
      var parsedCache = JSON.parse(cached);
      if (parsedCache && parsedCache.hex) {
        return {
          hex: parsedCache.hex,
          code: parsedCache.code || _fallbackColorCode(name),
          source: "cache",
        };
      }
    } catch (e) {
      /* كاش قديم عبارة عن hex نص فقط */
    }
    return { hex: cached, code: _fallbackColorCode(name), source: "cache" };
  }

  // ── 3. بحث حقيقي في الإنترنت (Color Name API) للأسماء الإنجليزية ──────
  //    مصدر مفتوح ومجاني بيرجع أقرب لون مسجّل عالمياً لاسم اللون المكتوب
  if (/^[a-zA-Z\s\-]+$/.test(name)) {
    try {
      var apiUrl =
        "https://api.color.pizza/v1/names/?name=" +
        encodeURIComponent(name.trim());
      var apiRes = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true });
      if (apiRes.getResponseCode() === 200) {
        var apiData = JSON.parse(apiRes.getContentText());
        var best = apiData && apiData.colors && apiData.colors[0];
        // نقبل بس نتيجة قريبة بما فيه الكفاية من الاسم المكتوب
        if (best && best.hex && best.similarity >= 0.55) {
          var webCode = _fallbackColorCode(name);
          props.setProperty(
            cacheKey,
            JSON.stringify({ hex: best.hex, code: webCode }),
          );
          return { hex: best.hex, code: webCode, source: "web" };
        }
      }
    } catch (e) {
      console.warn("resolveColorHex web lookup error: " + e.message);
      /* لو فشل البحث في الإنترنت، كمل على الذكاء الاصطناعي تحت */
    }
  }

  // ── 4. Groq AI (مجاني — نفس GROQ_API_KEY الموجود في النظام) ──────────
  //    بيغطي الأسماء العربية أو العامية اللي مفيهاش نتيجة من البحث فوق
  try {
    var apiKey = props.getProperty("GROQ_API_KEY");
    if (!apiKey) {
      // إذا مفيش API key → رجّع لون + كود مبنيين على hash
      return {
        hex: _hashColor(name),
        code: _fallbackColorCode(name),
        source: "hash",
      };
    }

    var prompt =
      "أنت خبير ألوان لنظام ERP لتجارة الملابس. سأعطيك اسم لون (عربي أو إنجليزي، حتى لو عامي أو غير شائع) " +
      "وأريد منك اقتراح:\n" +
      "1) hex code يمثله بدقة\n" +
      "2) كود قصير مختصر (3-4 حروف إنجليزية كبيرة فقط، بدون أرقام أو مسافات) يميزه عن باقي الألوان\n\n" +
      "رد بصيغة JSON فقط بدون أي كلام إضافي وبدون Markdown، بالشكل التالي بالظبط:\n" +
      '{"hex":"#RRGGBB","code":"XXX"}\n\n' +
      'اسم اللون: "' +
      name +
      '"';

    var payload = {
      model: "llama-3.3-70b-versatile",
      max_tokens: 60,
      messages: [{ role: "user", content: prompt }],
    };

    var options = {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + apiKey,
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    var response = UrlFetchApp.fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      options,
    );
    var data = JSON.parse(response.getContentText());
    var text =
      (data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content) ||
      "";

    var hex = null;
    var code = null;

    // حاول تفسّر رد الذكاء الاصطناعي كـ JSON أولاً
    try {
      var jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        var aiObj = JSON.parse(jsonMatch[0]);
        if (aiObj.hex && /^#[0-9a-fA-F]{3,6}$/.test(aiObj.hex)) {
          hex = aiObj.hex;
        }
        if (aiObj.code && /^[A-Za-z]{2,6}$/.test(aiObj.code)) {
          code = aiObj.code.toUpperCase();
        }
      }
    } catch (e) {
      /* هنرجع لطريقة الـ regex القديمة تحت */
    }

    // Fallback: استخرج الـ hex بالـ regex القديم لو الـ JSON فشل
    if (!hex) {
      var match = text.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
      if (match) {
        hex =
          match[0].length === 4
            ? "#" +
              match[1]
                .split("")
                .map(function (c) {
                  return c + c;
                })
                .join("")
            : match[0];
      }
    }

    if (hex) {
      if (!code) code = _fallbackColorCode(name);
      // حفظ في الكاش (hex + code مع بعض)
      props.setProperty(cacheKey, JSON.stringify({ hex: hex, code: code }));
      return { hex: hex, code: code, source: "ai" };
    }
  } catch (e) {
    console.warn("resolveColorHex AI error: " + e.message);
  }

  // ── 4. Hash fallback ──────────────────────────────────────────
  return {
    hex: _hashColor(name),
    code: _fallbackColorCode(name),
    source: "hash",
  };
}

// [FIX-AUDIT] resolveColorsBatch (plural/batch) أُزيلت من هنا — كانت نسخة
// مكررة بمنطق مختلف تمامًا عن النسخة الفعلية في Code_12_Core.js (§28)،
// وبما أن الاثنتين معرَّفتين globally بنفس الاسم فواحدة بس كانت شغالة
// فعليًا في وقت التشغيل والتانية كود ميت. النسخة في Core.js هي الصحيحة
// والموثّقة (بتطابق بالظبط استدعاءات الفرونت من 03_JS_Dashboard_Items.html
// و07_JS_Shipping_Colors_Excel.html، وبتستخدم CSS_COLOR_MAP_MASTER
// بمطابقة جزئية للأسماء المركبة). resolveColorHex (المفردة، تحت) لسه
// موجودة زي ما هي — دالة منفصلة شرعية بمنطق AI/web lookup خاص بيها،
// مش لها علاقة بالتكرار ده.

/** توليد لون ثابت من hash الاسم */
function _hashColor(name) {
  var hash = 0;
  for (var i = 0; i < name.length; i++)
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  var h = Math.abs(hash) % 360;
  // تحويل HSL → Hex تقريبي
  var s = 0.6,
    l = 0.55;
  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  var m = l - c / 2;
  var r, g, b;
  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }
  function toHex(v) {
    var h = Math.round((v + m) * 255).toString(16);
    return h.length < 2 ? "0" + h : h;
  }
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

/** ── واجهة لإدارة كاش الألوان من السيستم ── */
function getColorCache() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var cache = {};
  Object.keys(props).forEach(function (k) {
    if (k.indexOf("color_hex_") === 0) {
      cache[k.replace("color_hex_", "")] = props[k];
    }
  });
  return cache;
}

function clearColorCache() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf("color_hex_") === 0) props.deleteProperty(k);
  });
  return { success: true, message: "تم مسح كاش الألوان" };
}
