// ============================================================
//  §IMPORT-ENGINE  محرك التحقق العام للاستيراد من إكسيل
//  Enterprise Import Validation Engine (IMP-WIZARD-V1)
// ------------------------------------------------------------
//  الهدف: محرك تحقق مركزي واحد (Single Source of Truth) تُبنى
//  عليه كل شاشات الاستيراد الحالية والمستقبلية (أصناف، عملاء،
//  موردين، حسابات، مخازن...) بدل ما يتكرر منطق تحقق مختلف في كل
//  شاشة. كل ما تحتاجه شاشة جديدة هو تعريف "كونفيج" (IMPORT_ENTITY_CONFIGS)
//  يوصف أعمدتها وقواعدها فقط — بدون كتابة أي منطق تحقق جديد.
//
//  مراحل الاستيراد (تطابق الـ Wizard في الفرونت إند 37_JS_ImportWizard):
//   1) تحليل الملف           → يتم بالكامل في الفرونت إند (SheetJS)
//   2) تحقق بنية الملف        → analyzeImportStructure()
//   3+4) تحقق كل صف + تصحيح تلقائي → validateImportRows()
//   5-7) المعاينة/جدول الأخطاء/الملخص → عرض في الفرونت إند فقط
//   8) الاستيراد الفعلي (Batch) → commitImportBatch()
//   9) سجل العمليات           → logImportOperation() / getImportLogs()
// ============================================================

// ─────────────────────────────────────────────────────────────
// §IMP-0  إعدادات عامة + شيت سجل عمليات الاستيراد
// ─────────────────────────────────────────────────────────────

// ============================================================
//  التوحيد المعماري (Architecture Unification):
//  المحرك ده كان قبل كده مجرد دوال Global عادية بدل ما يكون namespace
//  موحّد زي باقي المحركات (BusinessRulesEngine / DataLayerEngine /
//  FileEngine / ValidationEngine / PaymentEngine / WorkflowEngine).
//  دلوقتي كل حاجة داخلية (IMPORT_ENTITY_CONFIGS + كل دوال _imp*) بقت
//  خاصة (private) جوه IIFE واحد، ومفيش استدعاء من أي ملف تاني في
//  المشروع غير عبر ImportEngine.<method>. الدوال العامة القديمة
//  (analyzeImportStructure/validateImportRows/commitImportBatch/
//  logImportOperation/getImportLogs) اتسابت بنفس الاسم بالظبط —
//  عشان القائمة البيضاء (Allowlist) في Code_12_Core.gs و google.script.run
//  من 37_JS_ImportWizard.html تفضل شغالة زي ما هي من غير أي تعديل —
//  لكن جسمها بقى مجرد تفويض (delegate) لـ ImportEngine.
// ============================================================

var ImportEngine = (function () {
  "use strict";

  var IMPORT_LOG_HEADERS = [
    "id",
    "entity_type", // items | customers | suppliers ...
    "entity_label", // اسم عربي مقروء
    "file_name",
    "user",
    "started_at",
    "finished_at",
    "duration_ms",
    "total_rows",
    "valid_rows",
    "corrected_rows",
    "warning_rows",
    "error_rows",
    "imported_rows",
    "excluded_rows",
    "status", // SUCCESS | PARTIAL | FAILED
    "details_json", // ملخص تفصيلي (أسباب الرفض...) — JSON
  ];

  function _impGetLogSheet() {
    return getSheet("ImportLog", IMPORT_LOG_HEADERS);
  }

  // حد أقصى لعدد الصفوف في الدفعة الواحدة أثناء الاستيراد الفعلي —
  // يمنع تجميد الواجهة ويحترم حدود تنفيذ Google Apps Script
  var IMPORT_BATCH_MAX_ROWS = 300;

  // [PHASE-3-IMPORT-LIMIT] حد أقصى منفصل وأصغر خاص بـ opts.rehostImages —
  // كل صف فيه رفع فعلي بيعمل UrlFetchApp.fetch (تحميل الصورة) + رفع Drive
  // فعلي، وممكن كمان نداء TinyPNG لو compressImages مفعّل. ده أبطأ بمراحل
  // من مجرد كتابة صف في الشيت، فلو سمحنا بنفس حد الـ 300 صف العام هنقابل
  // خطر تجاوز حد تنفيذ Apps Script (6 دقايق) بسهولة على دفعة كبيرة. الحد
  // ده بيتفعّل بس لو opts.rehostImages=true — الاستيراد العادي (بدون رفع
  // فعلي) لسه بياخد IMPORT_BATCH_MAX_ROWS العام زي ما هو بالظبط.
  var IMPORT_REHOST_MAX_ROWS = 50;

  // ─────────────────────────────────────────────────────────────
  // §IMP-1  سجل تعريف الكيانات القابلة للاستيراد (Entity Registry)
  // ------------------------------------------------------------
  //  كل كيان معرّف بـ:
  //   sheetName     : اسم الشيت في Google Sheets
  //   label         : الاسم العربي المعروض
  //   permission    : مفتاح الصلاحية المطلوبة (يُفحص عبر _checkPermission)
  //   idPrefix      : بادئة توليد id تلقائي (makeId)
  //   columns[]     : وصف كل عمود {key,label,required,type,aliases,...}
  //   uniqueFields  : حقول يجب ألا تتكرر (داخل الملف ومع النظام)
  //   relations[]   : علاقات يجب التحقق من وجودها في شيت آخر
  //   businessRules : دالة (row, ctx) → [ {field,label,reason,severity} ]
  //   buildRow      : دالة (validatedRecord, ctx) → مصفوفة أعمدة الشيت بالترتيب
  // ─────────────────────────────────────────────────────────────

  var IMPORT_ENTITY_CONFIGS = {
    items: {
      sheetName: "Items",
      label: "الأصناف",
      permission: "importItems",
      idPrefix: "ITM",
      columns: [
        {
          key: "code",
          label: "الكود",
          required: true,
          type: "text",
          maxLength: 40,
          aliases: ["كود", "الكود", "code", "item_code", "sku"],
        },
        {
          key: "name",
          label: "الاسم",
          required: true,
          type: "text",
          maxLength: 150,
          notNumericOnly: true,
          aliases: ["اسم", "الاسم", "اسم الصنف", "name", "item_name"],
        },
        {
          key: "group",
          label: "المجموعة",
          required: false,
          type: "relation",
          relation: "Groups",
          aliases: ["مجموعة", "المجموعة", "group", "group_name"],
        },
        {
          key: "warehouse",
          label: "المخزن",
          required: false,
          type: "relation",
          relation: "Warehouses",
          aliases: ["مخزن", "المخزن", "warehouse", "warehouse_name"],
        },
        {
          key: "unit",
          label: "الوحدة",
          required: false,
          type: "text",
          defaultValue: "قطعة",
          aliases: ["وحدة", "الوحدة", "unit"],
        },
        {
          key: "min_qty",
          label: "الحد الأدنى",
          required: false,
          type: "number",
          min: 0,
          defaultValue: 0,
          aliases: ["الحد الأدنى", "حد ادنى", "min", "min_qty", "reorder"],
        },
        {
          key: "cost_price",
          label: "سعر التكلفة",
          required: false,
          type: "number",
          min: 0,
          defaultValue: 0,
          aliases: ["سعر التكلفة", "تكلفة", "cost", "cost_price"],
        },
        {
          key: "selling_price",
          label: "سعر البيع",
          required: false,
          type: "number",
          min: 0,
          defaultValue: 0,
          aliases: ["سعر البيع", "بيع", "selling", "selling_price", "price"],
        },
        {
          key: "colors_json",
          label: "الألوان",
          required: false,
          type: "colorList",
          aliases: ["ألوان", "الألوان", "colors", "colors_json"],
        },
        {
          key: "image_url",
          label: "رابط الصورة",
          required: false,
          type: "url",
          aliases: ["رابط الصورة", "صورة", "image", "image_url"],
        },
        {
          key: "description",
          label: "الوصف",
          required: false,
          type: "text",
          maxLength: 1000,
          aliases: ["وصف", "الوصف", "ملاحظات", "notes", "description"],
        },
      ],
      uniqueFields: ["code"],
      relations: [
        {
          field: "group",
          sheetName: "Groups",
          idField: "id",
          nameField: "name",
          label: "المجموعة",
        },
        {
          field: "warehouse",
          sheetName: "Warehouses",
          idField: "id",
          nameField: "name",
          label: "المخزن",
        },
      ],
      businessRules: function (rec, ctx) {
        var issues = [];
        if (
          rec.cost_price != null &&
          rec.selling_price != null &&
          Number(rec.selling_price) > 0 &&
          Number(rec.selling_price) < Number(rec.cost_price)
        ) {
          issues.push({
            field: "selling_price",
            label: "سعر البيع",
            reason:
              "سعر البيع (" +
              rec.selling_price +
              ") أقل من سعر التكلفة (" +
              rec.cost_price +
              ") — تأكد إن ده مقصود",
            severity: "warning",
          });
        }
        // [WH-IMPORT] لو المستخدم كتب المجموعة والمخزن مع بعض، تأكد إن
        // المجموعة دي فعلاً تابعة لنفس المخزن المحدد — منعاً لتناقض بيانات
        // (مثال: كتابة مجموعة تخص مخزن الخامات مع اختيار مخزن الإكسسوار)
        if (rec.group && rec.warehouse) {
          var groupMap = ctx.relationMaps && ctx.relationMaps.group;
          var groupRow =
            groupMap && groupMap.byId[String(rec.group).toLowerCase()];
          if (
            groupRow &&
            String(groupRow.warehouse_id || "") !== String(rec.warehouse)
          ) {
            issues.push({
              field: "warehouse",
              label: "المخزن",
              reason: "المجموعة المحددة لا تنتمي إلى المخزن المكتوب في الصف",
              suggestion:
                "تأكد من مطابقة عمود المخزن لمخزن المجموعة، أو اترك عمود المخزن فارغاً",
              severity: "warning",
            });
          }
        }
        return issues;
      },
      buildRow: function (rec) {
        return [
          rec.id,
          rec.code,
          rec.name,
          rec.description || "",
          rec.group || "",
          rec.unit || "قطعة",
          rec.min_qty || 0,
          rec.image_url || "",
          rec.cost_price || 0,
          rec.selling_price || 0,
          new Date(),
          rec.colors_json || "[]",
        ];
      },
    },

    // [AUDIT-FIX M2] العملاء والموردون لم يكن لهما أي كونفيج استيراد رغم
    // أن التعليق أعلى الملف (entity_type: items | customers | suppliers)
    // كان يفترض دعمهما، ورغم وجود محرك استيراد عام جاهز — المستخدم كان
    // مضطرًا لإدخال كل عميل/مورد يدويًا واحدًا واحدًا. buildRow هنا يُبنى
    // ديناميكيًا من CUSTOMER_HEADERS/SUPPLIER_HEADERS (نفس مصفوفة الهيدرز
    // المستخدمة فعليًا في _addParty بـ Code_20_Sales.gs) بدل مصفوفة مواضع
    // ثابتة الطول، تفاديًا لتكرار نفس فئة الخطأ الموثقة في [MD-01 FIX]
    // (انزياح الأعمدة عن بعضها لو تغيّر عدد/ترتيب الهيدرز مستقبلاً).
    customers: {
      sheetName: CUSTOMERS_SHEET,
      label: "العملاء",
      permission: "addCustomer",
      idPrefix: "CUS",
      columns: [
        {
          key: "code",
          label: "الكود",
          required: true,
          type: "text",
          maxLength: 40,
          aliases: ["كود", "الكود", "code", "customer_code"],
        },
        {
          key: "name",
          label: "الاسم",
          required: true,
          type: "text",
          maxLength: 150,
          notNumericOnly: true,
          aliases: ["اسم", "الاسم", "اسم العميل", "name", "customer_name"],
        },
        {
          key: "phone",
          label: "الهاتف",
          required: false,
          type: "text",
          aliases: ["هاتف", "الهاتف", "تليفون", "phone", "mobile"],
        },
        {
          key: "email",
          label: "البريد الإلكتروني",
          required: false,
          type: "text",
          aliases: ["بريد", "البريد الإلكتروني", "email"],
        },
        {
          key: "tax_number",
          label: "الرقم الضريبي",
          required: false,
          type: "text",
          aliases: ["رقم ضريبي", "الرقم الضريبي", "tax_number", "tax"],
        },
        {
          key: "address",
          label: "العنوان",
          required: false,
          type: "text",
          maxLength: 300,
          aliases: ["عنوان", "العنوان", "address"],
        },
        {
          key: "account_id",
          label: "معرف حساب الذمم المدينة",
          required: false,
          type: "relation",
          relation: "ChartOfAccounts",
          aliases: ["حساب", "معرف الحساب", "account_id"],
        },
        {
          key: "credit_limit",
          label: "حد الائتمان",
          required: false,
          type: "number",
          min: 0,
          defaultValue: 0,
          aliases: ["حد الائتمان", "credit_limit"],
        },
        {
          key: "notes",
          label: "ملاحظات",
          required: false,
          type: "text",
          maxLength: 1000,
          aliases: ["ملاحظات", "notes"],
        },
      ],
      uniqueFields: ["code", "phone", "tax_number"],
      relations: [
        {
          field: "account_id",
          sheetName: "ChartOfAccounts",
          idField: "id",
          nameField: "id",
          label: "حساب الذمم المدينة",
        },
      ],
      businessRules: function (rec) {
        var issues = [];
        // [AUDIT-FIX H1/H2] نفس فحوصات BusinessRulesEngine المطبَّقة على
        // الحفظ الفردي (saveCustomer) — نعيد استخدامها هنا عبر
        // validateBeforeSave بدل تكرار منطق التحقق، حتى يبقى الاستيراد
        // خاضعًا لنفس قواعد صحة البيانات تمامًا (لا خط دفاع أضعف للاستيراد).
        var check = BusinessRulesEngine.validateBeforeSave("customer", rec);
        if (check && check.success === false) {
          issues.push({
            field: check.code === "INVALID_PHONE" ? "phone" : "name",
            label: "تحقق",
            reason: check.message,
            severity: "error",
          });
        }
        return issues;
      },
      buildRow: function (rec) {
        var now = new Date().toISOString();
        return CUSTOMER_HEADERS.map(function (h) {
          if (h === "id") return rec.id;
          if (h === "created_at" || h === "updated_at") return now;
          if (rec[h] !== undefined && rec[h] !== null) return rec[h];
          if (h === "status") return "نشط";
          if (h === "phone_whatsapp") return true;
          if (h === "invoice_sequence_next") return 1;
          if (
            [
              "is_blacklisted",
              "is_dual_party",
              "loyalty_enabled",
              "has_custom_invoice_sequence",
            ].indexOf(h) !== -1
          )
            return false;
          if (
            [
              "credit_limit",
              "payment_terms_days",
              "discount_percent",
              "loyalty_points",
            ].indexOf(h) !== -1
          )
            return 0;
          return "";
        });
      },
    },

    // [AUDIT-FIX M2] نفس منطق customers أعلاه بالضبط، لكن على شيت
    // Suppliers وحساب الذمم الدائنة بدل المدينة.
    suppliers: {
      sheetName: SUPPLIERS_SHEET,
      label: "الموردون",
      permission: "addSupplier",
      idPrefix: "SUP",
      columns: [
        {
          key: "code",
          label: "الكود",
          required: true,
          type: "text",
          maxLength: 40,
          aliases: ["كود", "الكود", "code", "supplier_code"],
        },
        {
          key: "name",
          label: "الاسم",
          required: true,
          type: "text",
          maxLength: 150,
          notNumericOnly: true,
          aliases: ["اسم", "الاسم", "اسم المورد", "name", "supplier_name"],
        },
        {
          key: "phone",
          label: "الهاتف",
          required: false,
          type: "text",
          aliases: ["هاتف", "الهاتف", "تليفون", "phone", "mobile"],
        },
        {
          key: "email",
          label: "البريد الإلكتروني",
          required: false,
          type: "text",
          aliases: ["بريد", "البريد الإلكتروني", "email"],
        },
        {
          key: "tax_number",
          label: "الرقم الضريبي",
          required: false,
          type: "text",
          aliases: ["رقم ضريبي", "الرقم الضريبي", "tax_number", "tax"],
        },
        {
          key: "address",
          label: "العنوان",
          required: false,
          type: "text",
          maxLength: 300,
          aliases: ["عنوان", "العنوان", "address"],
        },
        {
          key: "account_id",
          label: "معرف حساب الذمم الدائنة",
          required: false,
          type: "relation",
          relation: "ChartOfAccounts",
          aliases: ["حساب", "معرف الحساب", "account_id"],
        },
        {
          key: "notes",
          label: "ملاحظات",
          required: false,
          type: "text",
          maxLength: 1000,
          aliases: ["ملاحظات", "notes"],
        },
      ],
      uniqueFields: ["code", "phone", "tax_number"],
      relations: [
        {
          field: "account_id",
          sheetName: "ChartOfAccounts",
          idField: "id",
          nameField: "id",
          label: "حساب الذمم الدائنة",
        },
      ],
      businessRules: function (rec) {
        var issues = [];
        var check = BusinessRulesEngine.validateBeforeSave("supplier", rec);
        if (check && check.success === false) {
          issues.push({
            field: check.code === "INVALID_PHONE" ? "phone" : "name",
            label: "تحقق",
            reason: check.message,
            severity: "error",
          });
        }
        return issues;
      },
      buildRow: function (rec) {
        var now = new Date().toISOString();
        return SUPPLIER_HEADERS.map(function (h) {
          if (h === "id") return rec.id;
          if (h === "created_at" || h === "updated_at") return now;
          if (rec[h] !== undefined && rec[h] !== null) return rec[h];
          if (h === "status") return "نشط";
          if (h === "phone_whatsapp") return true;
          if (h === "invoice_sequence_next") return 1;
          if (
            [
              "is_blacklisted",
              "is_dual_party",
              "loyalty_enabled",
              "has_custom_invoice_sequence",
              "is_subcontractor",
            ].indexOf(h) !== -1
          )
            return false;
          if (
            [
              "payment_terms_days",
              "discount_percent",
              "loyalty_points",
              "avg_lead_time_days",
              "quality_rejection_rate",
            ].indexOf(h) !== -1
          )
            return 0;
          return "";
        });
      },
    },

    // [IMP-WIZARD-OS] أرصدة أول المدة — توحيد مسار الاستيراد على
    // ImportEngine زي الأصناف بالظبط. المطابقة مع الصنف بتتم عبر
    // كود الصنف (item.code) وليس المعرّف الداخلي (id) — العلاقة
    // بتاعة item_id هنا معكوسة (idField=id, nameField=code) عشان
    // المستخدم يكتب الكود في الملف والمحرك يحل محله الـ id الحقيقي.
    opening_stock: {
      sheetName: "OpeningStock",
      label: "أرصدة أول المدة",
      permission: "addOpeningStock",
      columns: [
        {
          key: "item_id",
          label: "كود الصنف",
          required: true,
          type: "relation",
          aliases: ["كود الصنف", "الكود", "كود", "code", "item_code", "sku"],
        },
        {
          key: "color",
          label: "اللون",
          required: false,
          type: "text",
          maxLength: 60,
          aliases: ["اللون", "لون", "color"],
        },
        {
          key: "qty",
          label: "الكمية",
          required: true,
          type: "number",
          min: 0,
          aliases: ["الكمية", "كمية", "qty", "quantity"],
        },
        {
          key: "unit_cost",
          label: "تكلفة الوحدة",
          required: false,
          type: "number",
          min: 0,
          aliases: [
            "تكلفة الوحدة",
            "سعر التكلفة الافتتاحي",
            "تكلفة",
            "unit_cost",
            "cost",
          ],
        },
        {
          key: "notes",
          label: "ملاحظات",
          required: false,
          type: "text",
          maxLength: 300,
          aliases: ["ملاحظات", "notes"],
        },
      ],
      // لا uniqueFields هنا عمداً — التكرار (نفس الصنف/اللون) مقصود
      // ومسموح به (Upsert)، مش خطأ. التحذير من التكرار *داخل نفس
      // الملف* بيتم يدويًا في businessRules تحت.
      relations: [
        {
          field: "item_id",
          sheetName: "Items",
          idField: "id",
          nameField: "code",
          label: "كود الصنف",
        },
      ],
      businessRules: function (rec, ctx) {
        var issues = [];
        if (!rec.item_id) return issues;
        if (!ctx._osSeen) ctx._osSeen = {};
        var key =
          String(rec.item_id).trim().toLowerCase() +
          "|" +
          String(rec.color || "").trim().toLowerCase();
        if (ctx._osSeen[key]) {
          issues.push({
            field: "color",
            label: "اللون",
            reason: "نفس الصنف بنفس اللون مكرر أكثر من مرة داخل نفس الملف",
            suggestion:
              "ادمج الصفوف المكررة في صف واحد أو احذف الصفوف الزائدة",
            severity: "warning",
          });
        } else {
          ctx._osSeen[key] = true;
        }
        return issues;
      },
      // [IMP-WIZARD-OS] استيراد أرصدة أول المدة مش "إضافة سجلات جديدة
      // فقط" زي باقي الكيانات — لازم Upsert (تحديث الموجود + إضافة
      // الجديد) بمفتاح مركّب (item_id + color)، والشيت مالوش عمود id.
      // فبنفوّض التنفيذ الفعلي كله لدالة مخصصة بدل commitImportBatch
      // العام (راجع commitImportBatch تحت لمعرفة نقطة التفويض).
      customCommit: function (records, user, sessionToken) {
        try {
          var lock = LockService.getScriptLock();
          lock.waitLock(20000);
          try {
            var sheet = getSheet("OpeningStock");
            var existing = readSheet("OpeningStock", OPENING_STOCK_HEADERS, {
              dateOnly: true,
            });

            var accepted = 0,
              rejected = 0;
            var rejectedDetails = [];
            var newRows = [];
            var baseLastRow = sheet.getLastRow();

            records.forEach(function (rec, i) {
              var itemId = String(rec.item_id || "").trim();
              var color = String(rec.color || "").trim();
              var qty = Number(rec.qty);
              var notes = String(rec.notes || "").trim();
              var unitCost =
                rec.unit_cost !== undefined &&
                rec.unit_cost !== null &&
                rec.unit_cost !== ""
                  ? Number(rec.unit_cost)
                  : "";

              if (!itemId || isNaN(qty) || qty < 0) {
                rejected++;
                rejectedDetails.push({
                  rowNum: rec._rowNum || i + 1,
                  reason: "كود الصنف أو الكمية غير صالحة",
                });
                return;
              }

              var found = existing.find(function (e) {
                return (
                  String(e.item_id) === itemId &&
                  String(e.color || "").trim() === color
                );
              });

              if (found) {
                sheet
                  .getRange(found._row, 1, 1, 6)
                  .setValues([
                    [itemId, color, qty, notes, new Date(), unitCost],
                  ]);
              } else {
                newRows.push([itemId, color, qty, notes, new Date(), unitCost]);
                existing.push({
                  item_id: itemId,
                  color: color,
                  quantity: qty,
                  notes: notes,
                  _row: baseLastRow + newRows.length,
                });
              }
              accepted++;
            });

            if (newRows.length) {
              var startRow = sheet.getLastRow() + 1;
              sheet
                .getRange(startRow, 1, newRows.length, newRows[0].length)
                .setValues(newRows);
            }

            _invalidateServerCache();

            return okResponse(
              "تم استيراد " + accepted + " سجل من هذه الدفعة",
              {
                data: {
                  accepted: accepted,
                  rejected: rejected,
                  rejectedDetails: rejectedDetails,
                },
              },
            );
          } finally {
            lock.releaseLock();
          }
        } catch (e) {
          return errResponse("خطأ أثناء الحفظ الفعلي: " + e.message);
        }
      },
    },
  };

  function _impGetEntityConfig(entityType) {
    var cfg = IMPORT_ENTITY_CONFIGS[entityType];
    if (!cfg) throw new Error("نوع بيانات استيراد غير معروف: " + entityType);
    return cfg;
  }

  // ─────────────────────────────────────────────────────────────
  // §IMP-2  أدوات مساعدة عامة (Normalization / Auto-Correction)
  // ─────────────────────────────────────────────────────────────

  // إزالة المسافات الزائدة + الأحرف المخفية (zero-width) + توحيد المسافات
  function _impCleanText(v) {
    if (v === undefined || v === null) return "";
    var s = String(v);
    s = s.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, " "); // أحرف مخفية → مسافة
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  // تحويل الأرقام العربية/الفارسية للأرقام اللاتينية قبل أي تحويل رقمي
  function _impNormalizeDigits(s) {
    var arabic = "٠١٢٣٤٥٦٧٨٩";
    var persian = "۰۱۲۳۴۵۶۷۸۹";
    return String(s).replace(/[٠-٩۰-۹]/g, function (ch) {
      var i = arabic.indexOf(ch);
      if (i > -1) return String(i);
      i = persian.indexOf(ch);
      return i > -1 ? String(i) : ch;
    });
  }

  // يحاول تحويل قيمة إلى رقم غير سالب صحيح — يرجع {ok, value, corrected}
  function _impCoerceNumber(raw, opts) {
    opts = opts || {};
    var original = raw;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return { ok: true, value: opts.defaultValue || 0, corrected: false };
    }
    var s = _impNormalizeDigits(_impCleanText(raw));
    // إزالة فواصل الآلاف الشائعة وأي رموز عملة
    s = s.replace(/[,٬]/g, "").replace(/[^\d.\-]/g, "");
    var n = Number(s);
    if (isNaN(n)) return { ok: false, value: null, corrected: false };
    if (opts.min !== undefined && n < opts.min)
      return { ok: false, value: n, corrected: false, belowMin: true };
    var corrected = String(original).trim() !== String(n);
    return { ok: true, value: n, corrected: corrected };
  }

  // Levenshtein مبسّطة — تُستخدم لاقتراح أقرب قيمة صحيحة (تصحيح ذكي لأسماء المجموعات/الوحدات)
  function _impLevenshtein(a, b) {
    a = String(a || "");
    b = String(b || "");
    var m = a.length,
      n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = [];
    for (var j = 0; j <= n; j++) prev[j] = j;
    for (var i = 1; i <= m; i++) {
      var cur = [i];
      for (var j2 = 1; j2 <= n; j2++) {
        var cost = a[i - 1] === b[j2 - 1] ? 0 : 1;
        cur[j2] = Math.min(prev[j2] + 1, cur[j2 - 1] + 1, prev[j2 - 1] + cost);
      }
      prev = cur;
    }
    return prev[n];
  }

  // يبحث عن أقرب تطابق نصي في قائمة مرشحين (لتصحيح أخطاء إملائية بسيطة)
  function _impFuzzyFind(value, candidates, maxDistance) {
    var v = String(value || "")
      .trim()
      .toLowerCase();
    if (!v) return null;
    var best = null,
      bestDist = Infinity;
    candidates.forEach(function (c) {
      var cl = String(c || "")
        .trim()
        .toLowerCase();
      if (!cl) return;
      if (cl === v) return; // تطابق تام مش محتاج تصحيح
      var d = _impLevenshtein(v, cl);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    });
    if (best !== null && bestDist <= (maxDistance || 2)) return best;
    return null;
  }

  // تطبيع صف خام (بمفاتيح = عناوين الأعمدة كما هي بالملف) إلى سجل بمفاتيح النظام
  // عبر مطابقة aliases المعرّفة في كونفيج الكيان
  function _impMapRowToRecord(rawRow, columns) {
    var out = {};
    var usedKeys = {};
    Object.keys(rawRow).forEach(function (originalHeader) {
      var clean = _impCleanText(originalHeader).replace(/\s+/g, " ");
      var matchedCol = null;
      for (var i = 0; i < columns.length; i++) {
        var col = columns[i];
        var aliases = col.aliases || [col.key];
        for (var j = 0; j < aliases.length; j++) {
          if (String(aliases[j]).trim().toLowerCase() === clean.toLowerCase()) {
            matchedCol = col;
            break;
          }
        }
        if (matchedCol) break;
      }
      if (matchedCol) {
        out[matchedCol.key] = rawRow[originalHeader];
        usedKeys[matchedCol.key] = true;
      }
    });
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // §IMP-3  المرحلة الثانية: تحقق بنية الملف
  // ─────────────────────────────────────────────────────────────

  /**
   * analyzeImportStructure — يفحص عناوين الأعمدة المرفوعة من الملف
   * مقابل الأعمدة المتوقعة للكيان، ويرجع أي أعمدة إلزامية ناقصة أو مكررة
   * أو غير معروفة (للعلم فقط).
   */
  function analyzeImportStructure(entityType, fileHeaders, user, sessionToken) {
    try {
      var cfg = _impGetEntityConfig(entityType);
      var permErr = _checkPermission(user, cfg.permission, sessionToken);
      if (permErr) return permErr;

      if (!Array.isArray(fileHeaders) || fileHeaders.length === 0) {
        return errResponse("الملف لا يحتوي على أي أعمدة قابلة للقراءة");
      }

      var cleanHeaders = fileHeaders.map(_impCleanText);

      // كشف الأعمدة المكررة في الملف نفسه
      var seen = {};
      var duplicateColumns = [];
      cleanHeaders.forEach(function (h) {
        var k = h.toLowerCase();
        if (!k) return;
        if (seen[k]) {
          if (duplicateColumns.indexOf(h) === -1) duplicateColumns.push(h);
        }
        seen[k] = true;
      });

      // مطابقة كل عمود بالملف مع تعريفات الكونفيج
      var matchedKeys = {};
      var unknownColumns = [];
      cleanHeaders.forEach(function (h) {
        var found = null;
        for (var i = 0; i < cfg.columns.length; i++) {
          var aliases = cfg.columns[i].aliases || [cfg.columns[i].key];
          if (
            aliases.some(function (a) {
              return String(a).trim().toLowerCase() === h.toLowerCase();
            })
          ) {
            found = cfg.columns[i].key;
            break;
          }
        }
        if (found) matchedKeys[found] = true;
        else if (h) unknownColumns.push(h);
      });

      var missingRequired = cfg.columns
        .filter(function (c) {
          return c.required && !matchedKeys[c.key];
        })
        .map(function (c) {
          return {
            key: c.key,
            label: c.label,
            suggestion:
              'أضف عموداً باسم "' +
              c.label +
              '" (أو أحد المسميات المقبولة: ' +
              (c.aliases || []).join("، ") +
              ")",
          };
        });

      var ok = missingRequired.length === 0 && duplicateColumns.length === 0;

      return okResponse(
        ok
          ? " بنية الملف متوافقة مع النظام"
          : " توجد مشاكل في بنية الملف يجب حلها قبل المتابعة",
        {
          data: {
            ok: ok,
            missingRequired: missingRequired,
            duplicateColumns: duplicateColumns,
            unknownColumns: unknownColumns,
            matchedCount: Object.keys(matchedKeys).length,
            totalExpected: cfg.columns.length,
            entityLabel: cfg.label,
          },
        },
      );
    } catch (e) {
      return errResponse("خطأ في تحليل بنية الملف: " + e.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // §IMP-4  المرحلة الثالثة/الرابعة: تحقق كل صف + تصحيح تلقائي
  // ─────────────────────────────────────────────────────────────

  // يبني سياق (ctx) مشتركاً لكل صفوف نفس عملية التحقق — لتجنّب قراءة
  // نفس الشيتات (Items/Groups...) مرة لكل صف (أداء)
  function _impBuildValidationContext(cfg) {
    var ctx = { existingByUnique: {}, relationMaps: {} };

    var existingRows = getSheetData(cfg.sheetName) || [];
    (cfg.uniqueFields || []).forEach(function (field) {
      var map = {};
      existingRows.forEach(function (r) {
        var v = String(r[field] || "")
          .trim()
          .toLowerCase();
        if (v) map[v] = true;
      });
      ctx.existingByUnique[field] = map;
    });

    var existingIds = {};
    existingRows.forEach(function (r) {
      var v = String(r.id || "")
        .trim()
        .toLowerCase();
      if (v) existingIds[v] = true;
    });
    ctx.existingIds = existingIds;

    (cfg.relations || []).forEach(function (rel) {
      var rows = getSheetData(rel.sheetName) || [];
      var byId = {},
        byName = {},
        names = [];
      rows.forEach(function (r) {
        var idV = String(r[rel.idField] || "").trim();
        var nameV = String(r[rel.nameField] || "").trim();
        if (idV) byId[idV.toLowerCase()] = r;
        if (nameV) {
          byName[nameV.toLowerCase()] = r;
          names.push(nameV);
        }
      });
      ctx.relationMaps[rel.field] = { byId: byId, byName: byName, names: names };
    });

    return ctx;
  }

  // تحقق + تصحيح عمود واحد حسب نوعه
  function _impValidateField(col, rawValue, ctx) {
    var result = { value: rawValue, corrected: false, issues: [] };
    var cleaned =
      typeof rawValue === "string" ? _impCleanText(rawValue) : rawValue;
    if (typeof rawValue === "string" && cleaned !== rawValue)
      result.corrected = true;

    var isEmpty =
      cleaned === undefined ||
      cleaned === null ||
      (typeof cleaned === "string" && cleaned === "");

    if (isEmpty) {
      if (col.required) {
        result.issues.push({
          field: col.key,
          label: col.label,
          reason: "حقل إلزامي فارغ",
          suggestion: "أدخل قيمة لـ " + col.label,
          severity: "error",
        });
        result.value = "";
        return result;
      }
      result.value = col.defaultValue !== undefined ? col.defaultValue : "";
      if (col.defaultValue !== undefined) result.corrected = true;
      return result;
    }

    switch (col.type) {
      case "number": {
        var n = _impCoerceNumber(cleaned, {
          min: col.min,
          defaultValue: col.defaultValue,
        });
        if (!n.ok) {
          result.issues.push({
            field: col.key,
            label: col.label,
            reason: n.belowMin
              ? col.label + " لا يمكن أن يكون سالباً (" + cleaned + ")"
              : col.label + ' قيمة غير رقمية ("' + cleaned + '")',
            suggestion:
              "أدخل رقماً صحيحاً" +
              (col.min !== undefined ? " ≥ " + col.min : ""),
            severity: "error",
          });
          result.value = cleaned;
          return result;
        }
        result.value = n.value;
        if (n.corrected) result.corrected = true;
        break;
      }
      case "url": {
        var s = String(cleaned).trim();
        // [VALIDATION-ENGINE-UNIFY] كان فيه regex محلي مطابق حرفيًا لـ
        // ValidationEngine.isValidUrl مكرر مرتين في نفس الملف (هنا وفي
        // فحص روابط صور الألوان تحت). دلوقتي الاثنان بيمروا على نفس
        // المرجع الموحّد بدل صيانة نسختين منفصلتين لنفس القاعدة.
        var urlOk =
          typeof ValidationEngine !== "undefined"
            ? ValidationEngine.isValidUrl(s)
            : /^https?:\/\/\S+$/i.test(s);
        if (s && !urlOk) {
          result.issues.push({
            field: col.key,
            label: col.label,
            reason: 'رابط غير صحيح ("' + s + '")',
            suggestion: "يجب أن يبدأ الرابط بـ http:// أو https://",
            severity: "warning",
          });
        }
        result.value = s;
        break;
      }
      case "colorList": {
        var s2 = String(cleaned).trim();
        var arr;
        try {
          // صيغة متقدمة: JSON كامل [{name,code,hex,image}]
          var parsed = JSON.parse(s2);
          arr = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          // صيغة بسيطة مناسبة لأي مستخدم (بدون JSON):
          //   اسم اللون فقط:            أحمر، أزرق
          //   أو اسم اللون + رابط صورته: أحمر:https://..jpg، أزرق:https://..jpg
          // الفاصل بين الألوان: فاصلة عادية أو عربية أو فاصلة منقوطة
          // الفاصل بين الاسم والرابط: ":" أو "|" (أول ظهور فقط، حتى لا يكسر روابط https)
          arr = s2
            .split(/[,،;]/)
            .map(function (c) {
              var part = _impCleanText(c);
              if (!part) return null;
              var sepIdx = -1;
              var sepChar = "";
              [":", "|"].forEach(function (sep) {
                var idx = part.indexOf(sep);
                if (idx > -1 && (sepIdx === -1 || idx < sepIdx)) {
                  sepIdx = idx;
                  sepChar = sep;
                }
              });
              if (sepIdx === -1) {
                return { name: part, code: "", hex: "", image: "" };
              }
              var colorName = _impCleanText(part.substring(0, sepIdx));
              var colorImage = _impCleanText(
                part.substring(sepIdx + sepChar.length),
              );
              return { name: colorName, code: "", hex: "", image: colorImage };
            })
            .filter(function (c) {
              return c && c.name;
            });
        }
        // تحقق بسيط (تحذير فقط) من روابط صور الألوان لو موجودة
        arr.forEach(function (c) {
          var imgUrlOk =
            typeof ValidationEngine !== "undefined"
              ? ValidationEngine.isValidUrl(String(c.image))
              : /^https?:\/\/\S+$/i.test(String(c.image));
          if (c.image && !imgUrlOk) {
            result.issues.push({
              field: col.key,
              label: col.label,
              reason:
                'رابط صورة اللون "' + c.name + '" غير صحيح ("' + c.image + '")',
              suggestion: "يجب أن يبدأ الرابط بـ http:// أو https://",
              severity: "warning",
            });
          }
        });
        result.value = JSON.stringify(arr);
        break;
      }
      case "relation": {
        result.value = cleaned;
        break; // العلاقات تُتحقق منفصلة في validateRow (تحتاج ctx + قد تحتاج تصحيحاً ذكياً)
      }
      case "text":
      default: {
        var t = String(cleaned).trim();
        if (col.maxLength && t.length > col.maxLength) {
          result.issues.push({
            field: col.key,
            label: col.label,
            reason:
              col.label + " أطول من الحد المسموح (" + col.maxLength + " حرف)",
            suggestion: "اختصر النص إلى " + col.maxLength + " حرف",
            severity: "warning",
          });
        }
        if (col.notNumericOnly && /^[\d٠-٩\s.\-]+$/.test(t)) {
          result.issues.push({
            field: col.key,
            label: col.label,
            reason: col.label + " لا يجب أن يكون أرقاماً فقط",
            suggestion: "تأكد أن " + col.label + " اسم نصي صحيح",
            severity: "warning",
          });
        }
        result.value = t;
        break;
      }
    }
    return result;
  }

  // تحقق العلاقة (مثال: المجموعة موجودة في شيت Groups) — مع اقتراح تصحيح ذكي
  function _impValidateRelation(rel, value, ctx) {
    var v = String(value || "").trim();
    if (!v) return { value: "", issues: [] };
    var map = ctx.relationMaps[rel.field];
    if (!map) return { value: v, issues: [] };
    var byId = map.byId[v.toLowerCase()];
    var byName = map.byName[v.toLowerCase()];
    if (byId) return { value: String(byId[rel.idField]), issues: [] };
    if (byName) return { value: String(byName[rel.idField]), issues: [] };

    // مش موجودة — حاول تصحيح ذكي بأقرب اسم
    var suggestion = _impFuzzyFind(v, map.names, 2);
    return {
      value: "",
      rawValue: v,
      issues: [
        {
          field: rel.field,
          label: rel.label,
          reason: rel.label + ' "' + v + '" غير موجودة في النظام',
          suggestion: suggestion
            ? 'هل تقصد "' + suggestion + '"؟'
            : "أضف " +
              rel.label +
              " أولاً من الشاشة الخاصة بها أو اترك الحقل فارغاً",
          suggestedValue: suggestion || "",
          severity: "warning",
        },
      ],
    };
  }

  /**
   * validateImportRows — التحقق الكامل (بنائي + منطقي + علاقات + تكرار)
   * لكل صفوف الملف، مع محاولة تصحيح تلقائي. لا يكتب أي شيء في الشيتات.
   *
   * @param {string} entityType
   * @param {Array<Object>} rawRows - صفوف كما قرأها SheetJS (مفاتيحها = عناوين الأعمدة الأصلية)
   * @returns {{success,data:{results:[...], summary:{...}}}}
   */
  function validateImportRows(entityType, rawRows, user, sessionToken) {
    try {
      var cfg = _impGetEntityConfig(entityType);
      var permErr = _checkPermission(user, cfg.permission, sessionToken);
      if (permErr) return permErr;
      if (!Array.isArray(rawRows) || rawRows.length === 0) {
        return errResponse("لا توجد صفوف للتحقق منها");
      }
      if (rawRows.length > 20000) {
        return errResponse(
          "عدد الصفوف كبير جداً (الحد الأقصى 20000 صف لكل عملية)",
        );
      }

      var ctx = _impBuildValidationContext(cfg);
      // خرائط لاكتشاف التكرار *داخل نفس الملف*
      var fileUniqueSeen = {};
      (cfg.uniqueFields || []).forEach(function (f) {
        fileUniqueSeen[f] = {};
      });

      var results = [];
      var summary = {
        total: 0,
        valid: 0,
        corrected: 0,
        warning: 0,
        error: 0,
        empty: 0,
      };

      rawRows.forEach(function (rawRow, idx) {
        var rowNum = idx + 2; // صف 1 = الهيدر

        // تجاهل الصفوف الفارغة تماماً
        var allEmpty = Object.keys(rawRow).every(function (k) {
          return _impCleanText(rawRow[k]) === "";
        });
        if (allEmpty) {
          summary.total++;
          summary.empty++;
          results.push({
            rowNum: rowNum,
            status: "empty",
            record: {},
            issues: [],
            corrected: false,
          });
          return;
        }

        var mapped = _impMapRowToRecord(rawRow, cfg.columns);
        var record = {};
        var issues = [];
        var rowCorrected = false;

        cfg.columns.forEach(function (col) {
          if (col.type === "relation") return; // تُعالج بعدين
          var fr = _impValidateField(col, mapped[col.key], ctx);
          record[col.key] = fr.value;
          if (fr.corrected) rowCorrected = true;
          issues = issues.concat(fr.issues);
        });

        // العلاقات
        (cfg.relations || []).forEach(function (rel) {
          var rr = _impValidateRelation(rel, mapped[rel.field], ctx);
          record[rel.field] = rr.value;
          if (rr.issues && rr.issues.length) issues = issues.concat(rr.issues);
        });

        // التكرار — داخل الملف
        (cfg.uniqueFields || []).forEach(function (f) {
          var v = String(record[f] || "")
            .trim()
            .toLowerCase();
          if (!v) return;
          if (fileUniqueSeen[f][v]) {
            issues.push({
              field: f,
              label:
                (
                  cfg.columns.filter(function (c) {
                    return c.key === f;
                  })[0] || {}
                ).label || f,
              reason:
                'القيمة "' + record[f] + '" مكررة أكثر من مرة داخل نفس الملف',
              suggestion: "تأكد من عدم تكرار " + f + " بين الصفوف",
              severity: "error",
            });
          } else {
            fileUniqueSeen[f][v] = rowNum;
          }
          // التكرار — مقابل النظام الحالي
          if (ctx.existingByUnique[f] && ctx.existingByUnique[f][v]) {
            issues.push({
              field: f,
              label:
                (
                  cfg.columns.filter(function (c) {
                    return c.key === f;
                  })[0] || {}
                ).label || f,
              reason: 'القيمة "' + record[f] + '" موجودة بالفعل في النظام',
              suggestion: "استخدم قيمة مختلفة أو احذف هذا الصف من الاستيراد",
              severity: "error",
            });
          }
        });

        // قواعد منطقية خاصة بالكيان (Business Rules)
        if (typeof cfg.businessRules === "function") {
          try {
            var extra = cfg.businessRules(record, ctx) || [];
            issues = issues.concat(extra);
          } catch (e) {
            // لا نكسر التحقق لو فيه خطأ في قاعدة عمل مخصصة
          }
        }

        var hasError = issues.some(function (i) {
          return i.severity === "error";
        });
        var hasWarning = issues.some(function (i) {
          return i.severity === "warning";
        });

        var status = hasError
          ? "error"
          : hasWarning
            ? "warning"
            : rowCorrected
              ? "corrected"
              : "valid";

        summary.total++;
        summary[status] = (summary[status] || 0) + 1;

        results.push({
          rowNum: rowNum,
          status: status,
          record: record,
          issues: issues,
          corrected: rowCorrected,
        });
      });

      return okResponse("تم التحقق من " + summary.total + " صف", {
        data: { results: results, summary: summary, entityLabel: cfg.label },
      });
    } catch (e) {
      return errResponse("خطأ في التحقق من البيانات: " + e.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // §IMP-5  المرحلة الثامنة: الاستيراد الفعلي (Batch Commit)
  // ─────────────────────────────────────────────────────────────

  /**
   * commitImportBatch — يكتب دفعة من السجلات المعتمدة فعلياً في الشيت.
   * يُعاد التحقق الأساسي دفاعاً في العمق (defense-in-depth) لأن حالة
   * النظام ممكن تكون اتغيّرت بين لحظة validateImportRows ولحظة الحفظ
   * الفعلي (مستخدم تاني ضاف نفس الكود مثلاً).
   *
   * @param {string} entityType
   * @param {Array<Object>} records - سجلات جاهزة (بمفاتيح النظام) بعد موافقة المستخدم
   */
  function commitImportBatch(entityType, records, user, sessionToken, opts) {
    try {
      opts = opts || {};
      var cfg = _impGetEntityConfig(entityType);
      var permErr = _checkPermission(user, cfg.permission, sessionToken);
      if (permErr) return permErr;
      if (!Array.isArray(records) || records.length === 0) {
        return errResponse("لا توجد سجلات للاستيراد");
      }
      if (records.length > IMPORT_BATCH_MAX_ROWS) {
        return errResponse(
          "حجم الدفعة كبير جداً (الحد الأقصى " +
            IMPORT_BATCH_MAX_ROWS +
            " صف لكل دفعة)",
        );
      }
      // [PHASE-3-IMPORT-LIMIT] حد أصغر ومنفصل لدفعات فيها رفع فعلي للصور
      // على Drive — راجع تعريف IMPORT_REHOST_MAX_ROWS أعلى الملف للسبب.
      if (opts.rehostImages && records.length > IMPORT_REHOST_MAX_ROWS) {
        return errResponse(
          "حجم الدفعة كبير جداً مع تفعيل رفع الصور فعليًا (الحد الأقصى " +
            IMPORT_REHOST_MAX_ROWS +
            " صف لكل دفعة عند تفعيل هذا الخيار — قسّم الملف لدفعات أصغر أو عطّل رفع الصور)",
        );
      }

      // [IMP-WIZARD-OS] كيانات فيها منطق حفظ خاص (Upsert بمفتاح مركّب،
      // شيت من غير عمود id...) بتفوّض التنفيذ بالكامل لدالتها الخاصة
      // بدل مسار "إضافة سجلات جديدة فقط" العام تحت.
      if (typeof cfg.customCommit === "function") {
        return cfg.customCommit(records, user, sessionToken);
      }

      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        var sheet = getSheet(cfg.sheetName);
        var existingRows = getSheetData(cfg.sheetName) || [];
        var existingIds = {};
        var existingUnique = {};
        (cfg.uniqueFields || []).forEach(function (f) {
          existingUnique[f] = {};
        });
        existingRows.forEach(function (r) {
          var idv = String(r.id || "")
            .trim()
            .toLowerCase();
          if (idv) existingIds[idv] = true;
          (cfg.uniqueFields || []).forEach(function (f) {
            var v = String(r[f] || "")
              .trim()
              .toLowerCase();
            if (v) existingUnique[f][v] = true;
          });
        });

        var rowsToWrite = [];
        var accepted = 0;
        var rejected = 0;
        var rejectedDetails = [];
        var imageRehostWarnings = [];

        // [DOC-ENGINE-IMPORT] رفع فعلي على Drive لصور الأصناف المستوردة من
        // رابط خارجي — Opt-in بحت (opts.rehostImages)، افتراضيًا مطفي. فشل
        // رفع صورة صف واحد ميرفضش الصف نفسه ولا يوقف باقي الدفعة، بس
        // بيسجَّل تحذير ويفضل الرابط الخارجي الأصلي زي ما هو (Fallback).
        var shouldRehostImages =
          !!opts.rehostImages &&
          entityType === "item" &&
          typeof DocumentEngine !== "undefined";

        // [PHASE-3-IMPORT] ضغط الصور المرفوعة فعليًا — Opt-in ثانٍ فوق
        // rehostImages (لا معنى لضغط صورة لو أصلًا مش هترفع على Drive).
        // provider="tinypng" يحتاج مفتاح TINYPNG_API_KEY في Script
        // Properties، وإلا هيرجع للرفع بدون ضغط تلقائيًا (تحذير مش رفض).
        var compressOpts =
          shouldRehostImages && opts.compressImages
            ? { enabled: true, provider: "tinypng" }
            : null;

        records.forEach(function (rec, i) {
          // إعادة تحقق سريعة من الإلزاميات والتكرار مقابل أحدث حالة للنظام
          var missing = cfg.columns.filter(function (c) {
            return c.required && !String(rec[c.key] || "").trim();
          });
          if (missing.length) {
            rejected++;
            rejectedDetails.push({
              rowNum: rec._rowNum || i + 1,
              reason:
                "حقول إلزامية ناقصة: " +
                missing
                  .map(function (m) {
                    return m.label;
                  })
                  .join("، "),
            });
            return;
          }

          var dup = (cfg.uniqueFields || []).some(function (f) {
            var v = String(rec[f] || "")
              .trim()
              .toLowerCase();
            return v && existingUnique[f][v];
          });
          if (dup) {
            rejected++;
            rejectedDetails.push({
              rowNum: rec._rowNum || i + 1,
              reason:
                "القيمة أصبحت مكررة في النظام (تمت إضافتها بين وقت المراجعة والحفظ)",
            });
            return;
          }

          // توليد id لو ناقص
          var id = String(rec.id || "").trim();
          if (!id) {
            var attempts = 0;
            do {
              id = makeId(cfg.idPrefix || "REC");
              attempts++;
            } while (existingIds[id.toLowerCase()] && attempts < 10);
          }
          if (existingIds[id.toLowerCase()]) {
            rejected++;
            rejectedDetails.push({
              rowNum: rec._rowNum || i + 1,
              reason: "معرّف مكرر",
            });
            return;
          }

          rec.id = id;
          existingIds[id.toLowerCase()] = true;
          (cfg.uniqueFields || []).forEach(function (f) {
            var v = String(rec[f] || "")
              .trim()
              .toLowerCase();
            if (v) existingUnique[f][v] = true;
          });

          // [ENGINE-AUDIT / Validation Engine] نفس فحص "هل ده رابط؟" الموحّد
          // المستخدم فوق مرتين بالفعل — اتوحّد هنا كمان بدل تكرار الـregex.
          if (
            shouldRehostImages &&
            rec.image_url &&
            ValidationEngine.isValidUrl(rec.image_url)
          ) {
            try {
              var rehostRes = DocumentEngine.uploadFromExternalUrl(rec.image_url, null, {
                itemId: rec.id,
                code: rec.code || "",
                name: rec.name || "",
                docType: "image",
                uploadedBy: user || "",
                compress: compressOpts,
              });
              if (rehostRes && rehostRes.success && rehostRes.viewUrl) {
                rec.image_url = rehostRes.viewUrl;
                // فشل الضغط نفسه (لا يوقف الرفع) بيتسجّل كتحذير منفصل خفيف —
                // الصورة اترفعت بنجاح على أي حال، بس من غير تصغير حجم فعلي
                if (
                  compressOpts &&
                  rehostRes.compression &&
                  !rehostRes.compression.compressed
                ) {
                  imageRehostWarnings.push({
                    rowNum: rec._rowNum || i + 1,
                    reason:
                      "تم رفع الصورة بدون ضغط (" +
                      (rehostRes.compression.skippedReason || "غير معروف") +
                      ")",
                  });
                }
              } else {
                imageRehostWarnings.push({
                  rowNum: rec._rowNum || i + 1,
                  reason:
                    "تعذّر رفع الصورة على Drive (" +
                    ((rehostRes && rehostRes.error) || "خطأ غير معروف") +
                    ") — تم الاحتفاظ بالرابط الخارجي كما هو",
                });
              }
            } catch (imgErr) {
              imageRehostWarnings.push({
                rowNum: rec._rowNum || i + 1,
                reason: "تعذّر رفع الصورة على Drive: " + imgErr.message,
              });
            }
          }

          // [PHASE-3-IMPORT-COLORS] كان رفع الصور الفعلي (rehostImages) بيتعامل
          // مع image_url الرئيسي بس — روابط صور الألوان جوه colors_json (لو
          // موجودة) كانت بتفضل روابط خارجية زي ما هي حتى لو المستخدم فعّل
          // "رفع فعلي على Drive". هنا بقى بيرفع كل صورة لون بنفس منطق الصورة
          // الرئيسية (نفس itemId/كود/اسم)، بفشل صامت لكل لون على حدة (رابط
          // لون واحد مكسور ميوقفش باقي الألوان ولا يرفض الصف نفسه).
          if (shouldRehostImages && rec.colors_json) {
            try {
              var colorsArr = JSON.parse(rec.colors_json);
              if (Array.isArray(colorsArr) && colorsArr.length) {
                var colorsChanged = false;
                colorsArr.forEach(function (c) {
                  // [ENGINE-AUDIT / Validation Engine] اتوحّد بدل نسخة محلية.
                  if (!c || !c.image || !ValidationEngine.isValidUrl(c.image)) return;
                  try {
                    var colorRehost = DocumentEngine.uploadFromExternalUrl(c.image, null, {
                      itemId: rec.id,
                      code: rec.code || "",
                      name: rec.name || "",
                      docType: "image",
                      uploadedBy: user || "",
                      compress: compressOpts,
                    });
                    if (colorRehost && colorRehost.success && colorRehost.viewUrl) {
                      c.image = colorRehost.viewUrl;
                      colorsChanged = true;
                    } else {
                      imageRehostWarnings.push({
                        rowNum: rec._rowNum || i + 1,
                        reason:
                          'تعذّر رفع صورة اللون "' +
                          (c.name || "") +
                          '" على Drive (' +
                          ((colorRehost && colorRehost.error) || "خطأ غير معروف") +
                          ") — تم الاحتفاظ بالرابط الخارجي كما هو",
                      });
                    }
                  } catch (colorImgErr) {
                    imageRehostWarnings.push({
                      rowNum: rec._rowNum || i + 1,
                      reason:
                        'تعذّر رفع صورة اللون "' + (c.name || "") + '": ' + colorImgErr.message,
                    });
                  }
                });
                if (colorsChanged) rec.colors_json = JSON.stringify(colorsArr);
              }
            } catch (colorsParseErr) {
              // colors_json مش JSON صالح لأي سبب — تجاهل بصمت، القيمة الأصلية
              // بتتكتب زي ما هي بدون رفع (نفس سلوك الحقول التانية غير الصالحة)
            }
          }

          rowsToWrite.push(cfg.buildRow(rec));
          accepted++;
        });

        if (rowsToWrite.length) {
          // كتابة دفعة واحدة (setValues) بدل appendRow لكل صف — أداء أفضل بكثير
          var startRow = sheet.getLastRow() + 1;
          var _importRange = sheet.getRange(
            startRow,
            1,
            rowsToWrite.length,
            rowsToWrite[0].length,
          );
          // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
          // _appendRowProtected).
          _importRange.setFontColor(null);
          _importRange.setValues(rowsToWrite);
        }

        _invalidateServerCache();

        return okResponse("تم استيراد " + accepted + " سجل من هذه الدفعة", {
          data: {
            accepted: accepted,
            rejected: rejected,
            rejectedDetails: rejectedDetails,
            imageRehostWarnings: imageRehostWarnings,
          },
        });
      } finally {
        lock.releaseLock();
      }
    } catch (e) {
      return errResponse("خطأ أثناء الحفظ الفعلي: " + e.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // §IMP-6  المرحلة العاشرة: سجل عمليات الاستيراد (Import Log)
  // ─────────────────────────────────────────────────────────────

  /**
   * logImportOperation — يُستدعى مرة واحدة في نهاية كل عملية استيراد كاملة
   * (بعد كل الدفعات) لتسجيل ملخص العملية في شيت ImportLog.
   */
  function logImportOperation(entityType, stats, user, sessionToken, meta) {
    try {
      var cfg = _impGetEntityConfig(entityType);
      var permErr = _checkPermission(user, cfg.permission, sessionToken);
      if (permErr) return permErr;

      meta = meta || {};
      stats = stats || {};
      var sheet = _impGetLogSheet();
      var id = makeId("IMPLOG");
      var status =
        (stats.imported || 0) === 0
          ? "FAILED"
          : (stats.errorRows || 0) > 0 || (stats.excludedRows || 0) > 0
            ? "PARTIAL"
            : "SUCCESS";

      var _logRow = [
        id,
        entityType,
        cfg.label,
        meta.fileName || "",
        user,
        meta.startedAt ? new Date(meta.startedAt) : new Date(),
        new Date(),
        meta.durationMs || 0,
        stats.total || 0,
        stats.validRows || 0,
        stats.correctedRows || 0,
        stats.warningRows || 0,
        stats.errorRows || 0,
        stats.imported || 0,
        stats.excludedRows || 0,
        status,
        JSON.stringify(meta.details || {}),
      ];
      // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
      // _appendRowProtected).
      sheet
        .getRange(sheet.getLastRow() + 1, 1, 1, _logRow.length)
        .setFontColor(null);
      sheet.appendRow(_logRow);

      AuditEngine.log("IMPORT_" + entityType.toUpperCase(), {
        user: user,
        table: cfg.sheetName,
        record_id: id,
        details:
          "استيراد " +
          cfg.label +
          " من ملف: " +
          (meta.fileName || "") +
          " | تم استيراد " +
          (stats.imported || 0) +
          " من أصل " +
          (stats.total || 0)});

      return okResponse("تم تسجيل عملية الاستيراد", {
        data: { id: id, status: status },
      });
    } catch (e) {
      return errResponse("خطأ في تسجيل سجل الاستيراد: " + e.message);
    }
  }

  /**
   * getImportLogs — يرجع أحدث عمليات الاستيراد (لعرضها في شاشة سجل الاستيراد)
   */
  function getImportLogs(user, sessionToken, limit) {
    try {
      var permErr = _checkPermission(user, "importItems", sessionToken);
      if (permErr) return permErr;
      var rows = getSheetData("ImportLog") || [];
      rows.sort(function (a, b) {
        return new Date(b.finished_at) - new Date(a.finished_at);
      });
      if (limit) rows = rows.slice(0, limit);
      return okResponse("تم الجلب", { data: rows });
    } catch (e) {
      return errResponse("خطأ في جلب سجل الاستيراد: " + e.message);
    }
  }

  return {
    analyzeImportStructure: analyzeImportStructure,
    validateImportRows: validateImportRows,
    commitImportBatch: commitImportBatch,
    logImportOperation: logImportOperation,
    getImportLogs: getImportLogs,
    // مُتاحة لو أي محرك/موديول تاني احتاج يقرأ تعريفات الكيانات مباشرة
    ENTITY_CONFIGS: IMPORT_ENTITY_CONFIGS,
    BATCH_MAX_ROWS: IMPORT_BATCH_MAX_ROWS,
    // [ARCH-AUDIT-P2-5] مُتاحة الآن للقراءة من خارج الموديول — كانت
    // خاصة بالكامل جوه الـ IIFE وغير مسجّلة في أي ثابت مركزي، فكان أي
    // فحص خارجي لهيكل شيتات النظام يفوّتها. التسجيل هنا (بدل نقلها لثابت
    // HEADERS في Code_12_Core.js) لتفادي مشكلة ترتيب تحميل الملفات —
    // Code_12 بيتحمّل قبل Code_29 فمكانش ممكن يشير لمتغيّر لسه مش موجود.
    IMPORT_LOG_HEADERS: IMPORT_LOG_HEADERS,
  };
})();

// ─────────────────────────────────────────────────────────────
// §IMP-7  دوال عامة (Global) للتوافق الخلفي — نفس الأسماء المسجّلة في
// القائمة البيضاء (Allowlist) بـ Code_12_Core.gs وفي google.script.run
// من 37_JS_ImportWizard.html. كل واحدة بس تفويض (delegate) لـ ImportEngine.
// ─────────────────────────────────────────────────────────────

function analyzeImportStructure(entityType, fileHeaders, user, sessionToken) {
  return ImportEngine.analyzeImportStructure(entityType, fileHeaders, user, sessionToken);
}

function validateImportRows(entityType, rawRows, user, sessionToken) {
  return ImportEngine.validateImportRows(entityType, rawRows, user, sessionToken);
}

function commitImportBatch(entityType, records, user, sessionToken, opts) {
  return ImportEngine.commitImportBatch(entityType, records, user, sessionToken, opts);
}

function logImportOperation(entityType, stats, user, sessionToken, meta) {
  return ImportEngine.logImportOperation(entityType, stats, user, sessionToken, meta);
}

function getImportLogs(user, sessionToken, limit) {
  return ImportEngine.getImportLogs(user, sessionToken, limit);
}
