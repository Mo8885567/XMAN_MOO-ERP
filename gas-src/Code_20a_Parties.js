// ════════════════════════════════════════════════════════════════
// Code_20a_Parties.js — العملاء والموردون (Parties) — [SPLIT-2026-07-27] فُصل من Code_20_Sales.js الأصلي (7172 سطر)
// كجزء من إعادة تنظيم المبيعات/المشتريات حسب المجال الوظيفي الحقيقي بدل
// تجميع فواتير + أطراف + أدوات محاسبة + فودافون كاش في ملف واحد اسمه
// "Sales" (راجع تقرير moo-erp-sales-purchasing-deepdive.md، بند 7).
// نقل نصي بحت — صفر تغيير في المنطق أو أسماء الدوال. كل ملفات .gs بتعمل
// في نفس الـ Global Scope في Apps Script فالاستدعاءات القديمة فضلت شغالة.
// ════════════════════════════════════════════════════════════════

// §EXT-22  Parties — Customers & Suppliers (العملاء والموردون)
// ═══════════════════════════════════════════════════════════════════════════════

var CUSTOMERS_SHEET = "Customers";
var SUPPLIERS_SHEET = "Suppliers";

// ── §BP-P2 حقول موسّعة (Business Partner - Phase 2: بيانات أساسية وسريعة) ──
// أُضيفت في نهاية المصفوفة عمدًا (additive) حتى تتوافق مع الأعمدة الفعلية في
// الشيتات القديمة بعد الترحيل التلقائي في _ensurePartyNewColumns أدناه.
var PARTY_EXTRA_HEADERS_P2 = [
  "status", // نشط | موقوف — افتراضيًا نشط
  "classification", // تصنيف حر (A/B/C أو أي تصنيف داخلي)
  "group_name", // مجموعة العميل/المورد (نص حر حاليًا — لحين إنشاء كيان مجموعات مستقل)
  "contact_person", // شخص الاتصال الرئيسي
  "contact_job_title", // المسمى الوظيفي لشخص الاتصال
  "phone2", // هاتف إضافي
  "website", // الموقع الإلكتروني
  "fax", // الفاكس
];

// ── §BP-P4 بيانات مالية موسّعة (Business Partner - Phase 4) ──────────────────
// أُضيفت في نهاية المصفوفة عمدًا (additive) — نفس أسلوب PARTY_EXTRA_HEADERS_P2،
// وتُرحَّل تلقائيًا للشيتات القديمة عبر _ensurePartyNewColumns (بدون كود ترحيل
// إضافي — الآلية عامة بالفعل).
//
// ملاحظة معمارية (قرار من BP-ROADMAP.md P4): "طريقة الدفع الافتراضية" حقل
// مستقل (select بقيم ثابتة) وليس رابطًا لكيان PaymentMethods — تم التأكد
// بالفحص إنه مفيش شيت/CRUD فعلي لكيان كده في الكود، الموجود بس هو enum حر
// (payment_method = CASH/BANK) جوه القيود والسندات. لو اتعمل كيان PaymentMethods
// مستقل مستقبلاً، يبقى محتاج مرحلة migration منفصلة لتحويل هذا الحقل لـ FK.
// نفس المنطق ينطبق على "قائمة الأسعار الافتراضية" (default_price_list) —
// نص حر حاليًا لحين وجود كيان قوائم أسعار مستقل (لا يوجد بالكود حاليًا).
var PARTY_EXTRA_HEADERS_P4 = [
  "bank_name", // اسم البنك
  "bank_account_number", // رقم الحساب البنكي
  "iban", // رقم الآيبان
  "swift_code", // كود السويفت/BIC
  "currency", // عملة التعامل الافتراضية (فارغ = العملة الافتراضية للنظام)
  "default_payment_method", // طريقة الدفع الافتراضية — قيمة حرة من مجموعة موحّدة بالواجهة (كاش/آجل/تحويل بنكي/شيك)
  "payment_terms_days", // مهلة السداد بالأيام (صافي X يوم)
  "discount_percent", // نسبة خصم افتراضية % — يُقترَح تطبيقها كخصم أولي عند الفواتير مستقبلاً (غير مُفعَّل تلقائيًا في P4)
  "default_price_list", // قائمة الأسعار الافتراضية — نص حر حاليًا لحين إنشاء كيان قوائم أسعار مستقل
];

// ── §CAT-P1 تصنيفات هرمية (Hierarchical Categories) — Additive ──────────────
// راجع Code_28_PartyCategories.gs — نفس أسلوب PARTY_EXTRA_HEADERS_P2/P4:
// عمود واحد يُضاف آخر المصفوفة ويُرحَّل تلقائيًا للشيتات القديمة عبر
// _ensurePartyNewColumns بدون أي كود ترحيل إضافي.
var PARTY_EXTRA_HEADERS_CAT = [
  "category_id", // ← معرف تصنيف العميل/المورد (PartyCategories.id) — فارغ = بدون تصنيف
];

// ── [NEW-FIELDS] بيانات موجودة في الأنظمة الكبرى وناقصة — additive، نفس
// أسلوب المصفوفات فوق: تُرحَّل تلقائيًا للشيتات القديمة عبر
// _ensurePartyNewColumns بدون أي كود ترحيل إضافي.
// sales_rep (عملاء فقط) و purchase_rep (موردين فقط) مش هنا — بيتضافوا في
// نهاية كل مصفوفة على حدة تحت لأنهم خاصين بنوع طرف واحد بس.
var PARTY_EXTRA_HEADERS_MD = [
  "entity_type", // فرد | شركة
  "national_id", // رقم قومي (فرد) أو رقم سجل تجاري (شركة)
];

// ── §BP-P5 حقول موسّعة إضافية (Business Partner - Phase 5) ───────────────────
// نفس أسلوب PARTY_EXTRA_HEADERS_P2/P4 تمامًا: مصفوفة إضافية additive تُرحَّل
// تلقائيًا للشيتات القديمة عبر _ensurePartyNewColumns بدون أي كود ترحيل إضافي.
// مشتركة بين العملاء والموردين (بدل تكرار نفس الحقول في مصفوفتين منفصلتين).
var PARTY_EXTRA_HEADERS_P5 = [
  "cost_center", // مركز التكلفة الافتراضي لهذا الطرف — نص حر (نفس فلسفة default_cost_center في دليل الحسابات، لا يوجد كيان مراكز تكلفة مستقل حاليًا)
  "is_blacklisted", // Boolean — الطرف على القائمة السوداء؟ يمنع إنشاء فواتير بيع/شراء جديدة معه (راجع الفحص في addSaleInvoice/addPurchaseInvoice)
  "employer", // جهة العمل (غالبًا للأفراد)
  "guarantor1", // الضامن الأول — بيانات حرة (اسم/هاتف في سطر واحد)
  "guarantor2", // الضامن الثاني
  "ledger_page_number", // رقم الصفحة (مرجع دفتر أستاذ ورقي قديم إن وُجد)
  "is_dual_party", // Boolean — يتعامل كـ عميل ومورد في نفس الوقت (راجع linkOrCreateDualParty)
  "dual_party_id", // معرف السجل المقابل في الجدول الآخر (عميل↔مورد) — فارغ ما لم يُفعَّل is_dual_party
  "default_shipping_company_id", // شركة الشحن الافتراضية — معرف من كيان ShippingCompanies (Code_22_Shipping.gs)
  "loyalty_enabled", // Boolean — يتعامل بنظام نقاط الولاء
  "loyalty_points", // رصيد النقاط الحالي — يُعدَّل عبر adjustPartyLoyaltyPoints
  "has_custom_invoice_sequence", // Boolean — له مسلسل ترقيم فواتير خاص (بادئة + عداد) بدل الاعتماد على مسلسل النظام العام فقط
  "invoice_sequence_prefix", // بادئة الترقيم الخاص (مثال: "C-312-")
  "invoice_sequence_next", // الرقم التالي في المسلسل الخاص — يُزاد تلقائيًا مع كل استخدام عبر _getNextPartyInvoiceNumber
];

// ── §BP-P6 حقول موسّعة إضافية (Business Partner - Phase 6) ───────────────────
// نفس أسلوب PARTY_EXTRA_HEADERS_P2/P4/P5 تمامًا: مصفوفة إضافية additive
// تُرحَّل تلقائيًا للشيتات القديمة عبر _ensurePartyNewColumns بدون أي كود
// ترحيل إضافي. مشتركة بين العملاء والموردين.
var PARTY_EXTRA_HEADERS_P6 = [
  "contact_phone", // هاتف شخص الاتصال (منفصل عن أرقام هاتف الطرف نفسه)
  // [WA-FLAG] Boolean — هل "رقم الهاتف" الأساسي (phone) مفعّل عليه واتساب؟
  // بيتحكم في اعتماد هذا الرقم للربط التلقائي مع رسائل واتساب الواردة
  // (راجع _commHubFindCustomerByPhone في Code_11_CommunicationHub.gs).
  // فارغ/غير موجود = يُعامَل كـ true (توافقًا مع البيانات القديمة قبل هذا الحقل).
  "phone_whatsapp",
];

// ── §BP-P7 حقل صورة الطرف (Business Partner - Phase 7) ───────────────────────
// نفس أسلوب PARTY_EXTRA_HEADERS_P2/P4/P5/P6 تمامًا: مصفوفة إضافية additive
// تُرحَّل تلقائيًا للشيتات القديمة عبر _ensurePartyNewColumns بدون أي كود
// ترحيل إضافي. مشتركة بين العملاء والموردين — رابط صورة الطرف (يُدخَل يدويًا
// كرابط، لا يوجد رفع فعلي للملف حاليًا).
var PARTY_EXTRA_HEADERS_P7 = [
  "image_url", // رابط صورة العميل/المورد (Avatar) — نص حر (URL)
];

var CUSTOMER_HEADERS = [
  "id",
  "name",
  "phone",
  "email",
  "tax_number",
  "address",
  "notes",
  "account_id", // ← حساب الذمم المدينة الخاص بهذا العميل (اختياري — يُستخدم كـ fallback على ar_account)
  "credit_limit", // [C10-FIX] حد الائتمان — 0 أو فارغ = بدون حد. يُطبَّق عند إنشاء فاتورة بيع آجلة
  "created_at",
  "updated_at",
]
  .concat(PARTY_EXTRA_HEADERS_P2)
  .concat(PARTY_EXTRA_HEADERS_P4)
  .concat(PARTY_EXTRA_HEADERS_CAT)
  .concat(PARTY_EXTRA_HEADERS_MD)
  .concat(["sales_rep", "code"]) // مندوب المبيعات المسؤول، كود العميل — نفس بنية الموردين تحت
  .concat(PARTY_EXTRA_HEADERS_P5)
  .concat(PARTY_EXTRA_HEADERS_P6)
  .concat(PARTY_EXTRA_HEADERS_P7)
  .concat(["drive_folder_id"]); // [DOC-ENGINE] معرف فولدر Drive الجذري الخاص بالعميل
var SUPPLIER_HEADERS = [
  "id",
  "name",
  "phone",
  "email",
  "tax_number",
  "address",
  "notes",
  "account_id", // ← حساب الذمم الدائنة الخاص بهذا المورد (اختياري — يُستخدم كـ fallback على ap_account)
  "created_at",
  "updated_at",
  // ── §MFG-P0  امتداد التصنيع لدى الغير (Subcontract Manufacturing) — Additive ──
  "is_subcontractor", // Boolean — هل هذا المورد يقوم بتصنيع لدى الغير؟
  "subcontract_specialties", // نص/JSON حر — التخصصات (قص/خياطة/تطريز...)
  "avg_lead_time_days", // متوسط مدة التسليم بالأيام
  "quality_rejection_rate", // نسبة الرفض — تُحسب تلقائياً، لا تُدخَل يدوياً
]
  .concat(PARTY_EXTRA_HEADERS_P2)
  .concat(PARTY_EXTRA_HEADERS_P4)
  .concat(PARTY_EXTRA_HEADERS_CAT)
  .concat(PARTY_EXTRA_HEADERS_MD)
  // [PARITY-CUST] كود المورد أضيف هنا ليطابق كود العميل تمامًا — نفس مبدأ
  // التفرد والإلزام، فقط الحساب المحاسبي المرتبط ذمم دائنة بدل مدينة.
  .concat(["purchase_rep", "code"]) // مسؤول المشتريات المتابع، كود المورد
  .concat(PARTY_EXTRA_HEADERS_P5)
  .concat(PARTY_EXTRA_HEADERS_P6)
  .concat(PARTY_EXTRA_HEADERS_P7)
  .concat(["drive_folder_id"]); // [DOC-ENGINE] معرف فولدر Drive الجذري الخاص بالمورد

/**
 * _getPartyBalance — [BUG-FIX] كانت تُستدعى في Code_24_WhatsApp.gs (شاشة
 * ملف العميل) دون أي تعريف لها في المشروع بالكامل (ReferenceError).
 * الرصيد الفعلي غير مخزَّن على سجل العميل/المورد نفسه، بل على حساب
 * الذمم المرتبط به (account_id) داخل ChartOfAccounts (عمود current_balance
 * الذي يُحدَّث تلقائياً مع كل قيد محاسبي عبر _updateChartAccountBalance).
 * @param {String} partyId - معرّف العميل أو المورد.
 * @returns {Number} الرصيد الحالي، أو 0 إن لم يوجد حساب مرتبط.
 */
// [FIX-ISSUE-PARTY-1] ازدواجية مصدر الرصيد — كان _getPartyBalance يقرأ
// ChartOfAccounts.current_balance المخزَّن مباشرة، بينما getPartyMovements
// (كشف الحساب الفعلي) يحسب الرصيد حيًا من JournalEntryLines المرحّلة. أي
// مسار ترحيل مستقبلي (أو تصحيح يدوي) لا يحدّث current_balance بشكل متسق
// كان يُنتج رقمين مختلفين لنفس العميل في نفس اللحظة (قائمة العملاء/البطاقة
// السريعة مقابل كشف الحساب). دلوقتي الاتنين بيحسبوا من نفس المصدر الحي.
function _computePartyLiveBalance(type, partyId) {
  var allLines = readSheet(
    "JournalEntryLines",
    ACCOUNTING_HR_HEADERS.JournalEntryLines,
  );
  var allEntries = readSheet(
    "JournalEntries",
    ACCOUNTING_HR_HEADERS.JournalEntries,
    { trimStrings: true },
  );
  var postedEntries = {};
  allEntries.forEach(function (e) {
    if (e.status === "POSTED") postedEntries[e.id] = e;
  });
  var partyLines = allLines.filter(function (l) {
    return (
      String(l.party_id || "").trim() === String(partyId).trim() &&
      postedEntries[l.entry_id]
    );
  });
  if (!partyLines.length) return null; // مفيش بيانات GL — استخدم fallback
  var balance = 0;
  partyLines.forEach(function (line) {
    var debit = Number(line.debit || 0);
    var credit = Number(line.credit || 0);
    balance += type === "supplier" ? credit - debit : debit - credit;
  });
  return balance;
}

function _getPartyBalance(partyId) {
  try {
    if (!partyId) return 0;
    var customers = readSheet("Customers", CUSTOMER_HEADERS);
    var type = "customer";
    var party = customers.find(function (c) {
      return c.id === partyId;
    });
    if (!party) {
      var suppliers = readSheet("Suppliers", SUPPLIER_HEADERS);
      party = suppliers.find(function (s) {
        return s.id === partyId;
      });
      type = "supplier";
    }
    if (!party) return 0;

    // المصدر الأساسي: حساب حي من الأستاذ العام (نفس منطق getPartyMovements بالظبط)
    var liveBalance = _computePartyLiveBalance(type, partyId);
    if (liveBalance !== null) return liveBalance;

    // Fallback: مفيش سطور GL لهذا الطرف بعد (نظام قديم/بيانات لم تُرحَّل) —
    // نرجع للعمود المخزَّن بدل ما نعرض صفر مضلِّل.
    if (!party.account_id) return 0;
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var account = accounts.find(function (a) {
      return a.id === party.account_id;
    });
    return account ? Number(account.current_balance || 0) : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * getPartyQuickCard — [IW-SIDEBAR-PARTY-CARD] بطاقة العميل/المورد السريعة
 * في سايد بار شاشة الفاتورة (فكرة من شاشة X-MAN المرجعية). بتجمع في نداء
 * واحد: الرصيد الحالي، حد الائتمان، حالة الحساب، آخر فاتورة، وآخر دفعة/سند
 * قبض أو صرف — بدل ما الكلاينت يعمل عدة نداءات منفصلة.
 * [BP-P5] نظام نقاط الولاء بقى له حقول فعلية على سجل الطرف (loyalty_enabled/
 * loyalty_points) — لو مش مفعّل بيرجع loyalty_points بقيمة null والواجهة
 * بتعرض "غير مفعّلة" بدل رقم وهمي، بالظبط زي قبل كده.
 * @param {String} partyId
 * @param {String} partyType - "customer" | "supplier"
 * @returns {Object} { success, data }
 */
function getPartyQuickCard(partyId, partyType) {
  try {
    if (!partyId) return errResponse("معرف الطرف مطلوب");
    var isCustomer = partyType !== "supplier";

    var party = isCustomer
      ? readSheet("Customers", CUSTOMER_HEADERS).find(function (c) {
          return c.id === partyId;
        })
      : readSheet("Suppliers", SUPPLIER_HEADERS).find(function (s) {
          return s.id === partyId;
        });
    if (!party) return errResponse("الطرف غير موجود");

    // آخر فاتورة
    var invoices = readSheet(
      isCustomer ? "SaleInvoices" : "PurchaseInvoices",
      isCustomer ? SALE_INVOICE_HEADERS : PURCHASE_INVOICE_HEADERS,
    ).filter(function (inv) {
      return (
        String(inv.party_id || "") === String(partyId) &&
        inv.status !== "CANCELLED"
      );
    });
    invoices.sort(function (a, b) {
      return String(b.date || "").localeCompare(String(a.date || ""));
    });
    var lastInvoice = invoices[0]
      ? {
          number: invoices[0].invoice_number || invoices[0].id,
          date: invoices[0].date,
          total: Number(invoices[0].total || invoices[0].grand_total || 0),
        }
      : null;

    // آخر سند (قبض للعميل / صرف للمورد)
    var vouchers = readSheet(
      isCustomer ? "ReceiptVouchers" : "PaymentVouchers",
      isCustomer
        ? ACCOUNTING_HR_HEADERS.ReceiptVouchers
        : ACCOUNTING_HR_HEADERS.PaymentVouchers,
    ).filter(function (v) {
      return (
        String(v.party_id || "") === String(partyId) &&
        v.status !== "CANCELLED"
      );
    });
    vouchers.sort(function (a, b) {
      return String(b.date || "").localeCompare(String(a.date || ""));
    });
    var lastPayment = vouchers[0]
      ? {
          number: vouchers[0].voucher_number || vouchers[0].id,
          date: vouchers[0].date,
          amount: Number(vouchers[0].amount || 0),
        }
      : null;

    return {
      success: true,
      data: {
        party_id: partyId,
        name: party.name || "",
        balance: _getPartyBalance(partyId),
        credit_limit: Number(party.credit_limit || 0),
        status: party.status || "نشط",
        last_invoice: lastInvoice,
        last_payment: lastPayment,
        // §BP-P5 — لو التطبيق غير مفعّل على الطرف تُرجَع null (نفس السلوك
        // القديم) بدل صفر وهمي قد يُفهَم كرصيد فعلي
        loyalty_points: party.loyalty_enabled
          ? Number(party.loyalty_points || 0)
          : null,
        is_blacklisted: !!party.is_blacklisted,
      },
    };
  } catch (e) {
    return errResponse("خطأ في جلب بطاقة الطرف: " + e.message);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function _getPartySheet(type) {
  // type: "customer" | "supplier"
  return type === "supplier" ? SUPPLIERS_SHEET : CUSTOMERS_SHEET;
}

function _getPartyHeaders(type) {
  return type === "supplier" ? SUPPLIER_HEADERS : CUSTOMER_HEADERS;
}

function _genPartyId(type) {
  return (type === "supplier" ? "SUP-" : "CUS-") + Date.now();
}

// ── _attachPartyBalances ──────────────────────────────────────────────────────
// [BALANCE-COLUMN-FIX] عمود "الرصيد" في جدول العملاء/الموردين (ColumnEngine،
// key: "balance") كان دايمًا بيرجع صفر — لأن getCustomers/getSuppliers كانا
// بيرجّعوا صفوف Sheet الخام (_readParties) واللي مفيهاش عمود "balance" أصلاً
// (الرصيد الحقيقي مخزّن في ChartOfAccounts.current_balance ومرتبط بالطرف عبر
// account_id، ويُقرأ فقط لسجل واحد في كل مرة عبر _getPartyBalance — لم يكن
// يُدمَج (join) دفعة واحدة مع كل صفوف الجدول). هذه الدالة بتعمل الدمج ده
// مرة واحدة لكل الصفوف (قراءة واحدة لـ ChartOfAccounts بدل قراءة لكل عميل).
function _attachPartyBalances(rows, partyType) {
  // [FIX-ISSUE-PARTY-1] راجع نفس ملاحظة _computePartyLiveBalance أعلاه —
  // كانت هذه الدالة تقرأ ChartOfAccounts.current_balance المخزَّن مباشرة،
  // فتتعارض محتمَلاً مع كشف الحساب الحي (getPartyMovements). دلوقتي بتحسب
  // من JournalEntryLines/JournalEntries حيًا (قراءة واحدة لكل الصفوف بدل
  // قراءة لكل عميل — نفس فلسفة الأداء الأصلية) مع fallback للعمود المخزَّن
  // فقط للأطراف اللي لسه معهاش سطور GL (بيانات لم تُرحَّل/قديمة).
  var type = partyType === "supplier" ? "supplier" : "customer";
  try {
    var allLines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
    );
    var allEntries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var postedEntries = {};
    allEntries.forEach(function (e) {
      if (e.status === "POSTED") postedEntries[e.id] = e;
    });

    // تجميع رصيد كل partyId من سطور الأستاذ العام المرحّلة في مسحة واحدة
    var glBalanceByParty = {};
    var hasGLLines = {};
    allLines.forEach(function (line) {
      var pid = String(line.party_id || "").trim();
      if (!pid || !postedEntries[line.entry_id]) return;
      hasGLLines[pid] = true;
      var debit = Number(line.debit || 0);
      var credit = Number(line.credit || 0);
      glBalanceByParty[pid] =
        (glBalanceByParty[pid] || 0) +
        (type === "supplier" ? credit - debit : debit - credit);
    });

    // Fallback map للأطراف اللي مالهاش سطور GL — العمود المخزَّن القديم
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var storedBalanceByAccount = {};
    accounts.forEach(function (a) {
      storedBalanceByAccount[a.id] = Number(a.current_balance || 0);
    });

    rows.forEach(function (row) {
      var pid = String(row.id || "");
      if (hasGLLines[pid]) {
        row.balance = glBalanceByParty[pid] || 0;
      } else if (row.account_id) {
        row.balance = storedBalanceByAccount[row.account_id] || 0;
      } else {
        row.balance = 0;
      }
    });
  } catch (e) {
    // [AUDIT-FIX L1] فشل قراءة الأستاذ العام/دليل الحسابات (نادر) — لا نمنع
    // عرض قائمة العملاء/الموردين، لكن نُعلم الواجهة أن الرصيد "غير متاح"
    // بدل عرض 0 صامت قد يُفهم خطأً كرصيد فعلي صفري (balance_unavailable
    // اختياري، الواجهات القديمة التي لا تفحصه ستستمر بعرض 0 كما كانت بالظبط).
    rows.forEach(function (row) {
      if (row.balance === undefined) row.balance = 0;
      row.balance_unavailable = true;
    });
  }
  return rows;
}

// ── getCustomers ─────────────────────────────────────────────────────────────

function getCustomers(callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewCustomers"); // [BUG-003 FIX]
    var rows = _readParties("customer");
    _attachPartyBalances(rows, "customer"); // [BALANCE-COLUMN-FIX]
    return { success: true, data: rows };
  } catch (e) {
    return errResponse(i18nT("ERR_FETCH_CUSTOMERS") + ": " + e.message);
  }
}

// ── getSuppliers ─────────────────────────────────────────────────────────────

function getSuppliers(callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewSuppliers"); // [BUG-003 FIX]
    var rows = _readParties("supplier");
    _attachPartyBalances(rows, "supplier"); // [BALANCE-COLUMN-FIX]
    return { success: true, data: rows };
  } catch (e) {
    return errResponse(i18nT("ERR_FETCH_SUPPLIERS") + ": " + e.message);
  }
}

// ── isCustomerCodeDuplicate ──────────────────────────────────────────────────
// [PARTY-VALIDATION] نسخة قابلة للاستدعاء من العميل (google.script.run) لفحص
// تكرار كود العميل أثناء الكتابة (VF.checkDuplicate — تحقق فوري Debounced في
// 10_JS_Settings_Search_Parties.html)، بدل انتظار محاولة الحفظ الفعلية. لا
// تكرر أي منطق: تفوّض المقارنة نفسها لـ ValidationEngine.isDuplicate (Code_36)
// على نفس بيانات _readParties المستخدمة في كل مكان آخر بالملف. فحص الحفظ
// الفعلي والملزم يبقى عبر BusinessRulesEngine.validateBeforeSave("customer",..)
// (CustomerRules.isDuplicateCode) كما هو — هذه فقط للـ UX الفوري على الشاشة.
function isCustomerCodeDuplicate(code, excludeId) {
  try {
    var customers = _readParties("customer");
    return ValidationEngine.isDuplicate(customers, "code", code, {
      excludeId: excludeId,
    });
  } catch (e) {
    // فشل الفحص المحلي (شيت غير موجود مثلاً) — لا نمنع الكتابة، الفحص
    // الملزم وقت الحفظ الفعلي (BusinessRulesEngine) يبقى هو الحاسم دائمًا.
    return false;
  }
}

// ── isSupplierCodeDuplicate ───────────────────────────────────────────────────
// [PARITY-CUST] نفس منطق isCustomerCodeDuplicate أعلاه بالضبط، لكن على شيت
// الموردين — كود المورد بقى إلزاميًا وفريدًا بنفس مبدأ كود العميل.
function isSupplierCodeDuplicate(code, excludeId) {
  try {
    var suppliers = _readParties("supplier");
    return ValidationEngine.isDuplicate(suppliers, "code", code, {
      excludeId: excludeId,
    });
  } catch (e) {
    return false;
  }
}

// ── _getNextPartyCode ─────────────────────────────────────────────────────────
// [AUTO-CODE] كود تسلسلي (1، 2، 3...) للعميل/المورد الجديد.
// [AUTO-NUMBER-CENTRAL] بقت غلاف رفيع فوق AutoNumberService.preview()
// (Code_46_AutoNumberService.js) — نفس المنطق اللي كان هنا بالظبط (يحسب
// من أعلى كود موجود فعليًا في الشيت وقت كل نداء)، لكن دلوقتي من مصدر
// واحد مشترك مع كل الكيانات التانية (خزائن، مراكز تكلفة، أقسام، موظفين،
// شركات شحن، مخازن...) بدل تكرار نفس المنطق في كل ملف.
// عدادات العميل والمورد منفصلة (كل نوع له تسلسله الخاص) لأن كل واحد
// بيستدعي AutoNumberService.preview() بقايمة أكواد مختلفة (شيت مختلف).
// [ملحوظة تزامن] الفحص الملزم النهائي لمنع التكرار موجود بالفعل في
// BusinessRulesEngine.isDuplicateCode وقت الحفظ الفعلي، فأي تصادم نادر
// (مستخدمان بيضيفوا في نفس اللحظة) هيتمسك هناك.
function _getNextPartyCode(type) {
  // [CUST-SETTINGS-2026-08-07] العملاء بقى ليهم ترقيم مُعرَّف من إعدادات
  // العملاء العامة (Prefix / عدد أرقام / بداية التسلسل / إعادة الترقيم
  // سنويًا) بدل ما يفضل يعتمد على استنتاج الـ prefix من الكود القديم
  // زي ما بيحصل افتراضيًا. الموردين مش متأثرين — لسه بيستخدموا الاستنتاج
  // التلقائي القديم زي ما هو (خارج نطاق طلب المستخدم الحالي).
  if (type === "customer" && typeof CustomerSettingsEngine !== "undefined") {
    return _getNextCustomerCodeFromSettings();
  }
  return AutoNumberService.preview(function () {
    return _readParties(type).map(function (r) {
      return r.code;
    });
  });
}

// ── _getNextCustomerCodeFromSettings ──────────────────────────────────────────
// [CUST-SETTINGS-2026-08-07] نفس فكرة AutoNumberService.preview بالظبط، لكن
// الـ prefix/padding بييجوا من CustomerSettingsEngine بدل استنتاجهم من آخر
// كود، وبيضيف دعم "إعادة الترقيم سنويًا" (لو مفعّل، بيحسب أعلى رقم من عملاء
// اتعملوا فعليًا في السنة الحالية بس — created_at — مش من كل التاريخ).
// بداية التسلسل (numbering_start_from) بتُطبَّق لو الشيت فاضي أو لسه مفيش
// أي كود يطابق نفس الـ prefix/السنة الحالية.
function _getNextCustomerCodeFromSettings() {
  var s = CustomerSettingsEngine.getAll();
  var prefix = s.numbering_prefix || "";
  var digits = Number(s.numbering_digits || 0);
  var startFrom = Number(s.numbering_start_from || 1);
  var resetYearly = !!s.numbering_reset_yearly;
  var currentYear = new Date().getFullYear();

  var customers = _readParties("customer");
  if (resetYearly) {
    customers = customers.filter(function (c) {
      if (!c.created_at) return false;
      var d = new Date(c.created_at);
      return !isNaN(d.getTime()) && d.getFullYear() === currentYear;
    });
    // [ملحوظة] لو التصفية بالسنة رجّعت مفيش عملاء (أول عميل في سنة جديدة)،
    // AutoNumberService.preview هيرجع startFrom-1 + 1 = startFrom تلقائيًا
    // لأن maxNumber هيفضل 0.
  }

  var codes = customers.map(function (c) {
    return c.code;
  });
  var next = AutoNumberService.preview(
    function () {
      return codes;
    },
    { prefix: prefix, padding: digits },
  );

  // لو مفيش أي كود مطابق للـ prefix أصلاً (أول عميل، أو أول عميل بعد
  // إعادة ترقيم سنوية) وبداية التسلسل المطلوبة أكبر من 1، نفرض القيمة يدويًا.
  var hasAnyMatchingPrefix = codes.some(function (c) {
    return String(c || "").indexOf(prefix) === 0;
  });
  if (!hasAnyMatchingPrefix && startFrom > 1) {
    return _formatCodeWithStart(prefix, startFrom, digits);
  }
  return next;
}

function _formatCodeWithStart(prefix, startFrom, digits) {
  var numStr = String(startFrom);
  if (digits && numStr.length < digits) {
    numStr = new Array(digits - numStr.length + 1).join("0") + numStr;
  }
  return (prefix || "") + numStr;
}

// ── getNextCustomerCode / getNextSupplierCode ─────────────────────────────────
// [AUTO-CODE] نسخة قابلة للاستدعاء من الواجهة (google.script.run) — تُستخدم
// لعرض الكود التسلسلي التالي على المستخدم فور فتح مودال "إضافة جديد" (قبل
// الحفظ الفعلي). الكود النهائي الملزم يُولَّد مرة أخرى (نفس القيمة عادةً)
// داخل _partyCreateCodeCheck وقت الحفظ الحقيقي، فمفيش اعتماد على قيمة
// الواجهة وحدها.
function getNextCustomerCode() {
  return okResponse("", { data: _getNextPartyCode("customer") });
}
function getNextSupplierCode() {
  return okResponse("", { data: _getNextPartyCode("supplier") });
}

// ── addCustomer ──────────────────────────────────────────────────────────────

// [SL-MIGRATION] الدوال الست التالية (add/update/delete × customer/supplier)
// تُفوِّض الآن تنفيذها الفعلي لـ ServiceLayer.execute (سجّل التسجيل أعلاه)
// بدل تكرار _requirePermission + استدعاء _addParty/_updateParty/_deleteParty
// مباشرة. التوقيع الخارجي وسلوك الاستجابة (okResponse/errResponse) لم يتغيّرا.
// ملاحظة: نداء _invalidateServerCache() في أول كل دالة كان موجودًا في الكود
// الأصلي قبل أي فحص صلاحية — أُبقي عليه كما هو حرفيًا (خارج نطاق هذه الهجرة).

function addCustomer(callerUser, data) {
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  var r = ServiceLayer.execute({
    entityType: "customer",
    action: "create",
    payload: data,
    context: { username: callerUser, sessionToken: data && data.sessionToken },
  });
  if (!r.success) return errResponse(r.message, r.code);
  return okResponse(r.message, r.data);
}

// ── updateCustomer ───────────────────────────────────────────────────────────

function updateCustomer(callerUser, id, data) {
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  var payload = Object.assign({}, data, { id: id });
  var r = ServiceLayer.execute({
    entityType: "customer",
    action: "update",
    payload: payload,
    context: { username: callerUser, sessionToken: data && data.sessionToken },
  });
  if (!r.success) return errResponse(r.message, r.code);
  return okResponse(r.message, r.data);
}

// ── deleteCustomer ───────────────────────────────────────────────────────────

function deleteCustomer(callerUser, id, sessionToken) {
  // [DELETE-ENGINE-MIGRATION] بدل الاستدعاء المباشر لـ ServiceLayer.execute،
  // بقينا نمر عبر DeleteEngine الموحّد (Code_44) اللي بيضيف Dependency Scan +
  // Archive + Logging تفصيلي فوق نفس فحوصات الصلاحية/قواعد العمل القديمة
  // (BusinessRulesEngine.validateBeforeDelete("customer",...) لسه بتتفّذ من
  // جوه المحرك). نفس شكل الرد بالظبط (errResponse/okResponse) — الواجهة
  // الأمامية مش محتاجة أي تعديل.
  var r = DeleteEngine.delete("customer", id, callerUser, sessionToken);
  if (!r.success) return errResponse(r.message, r.code);
  return okResponse(r.message, r.data);
}

// ── addSupplier ──────────────────────────────────────────────────────────────

function addSupplier(callerUser, data) {
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  var r = ServiceLayer.execute({
    entityType: "supplier",
    action: "create",
    payload: data,
    context: { username: callerUser, sessionToken: data && data.sessionToken },
  });
  if (!r.success) return errResponse(r.message, r.code);
  return okResponse(r.message, r.data);
}

// ── updateSupplier ───────────────────────────────────────────────────────────

function updateSupplier(callerUser, id, data) {
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  var payload = Object.assign({}, data, { id: id });
  var r = ServiceLayer.execute({
    entityType: "supplier",
    action: "update",
    payload: payload,
    context: { username: callerUser, sessionToken: data && data.sessionToken },
  });
  if (!r.success) return errResponse(r.message, r.code);
  return okResponse(r.message, r.data);
}

// ── deleteSupplier ───────────────────────────────────────────────────────────

function deleteSupplier(callerUser, id, sessionToken) {
  // [DELETE-ENGINE-MIGRATION] راجع نفس ملاحظة deleteCustomer أعلاه.
  var r = DeleteEngine.delete("supplier", id, callerUser, sessionToken);
  if (!r.success) return errResponse(r.message, r.code);
  return okResponse(r.message, r.data);
}

/**
 * _seedDefaultCashCustomerIfEmpty / _seedDefaultCashSupplierIfEmpty —
 * [DEFAULT-CASH-PARTY-1] بينشئوا طرفًا افتراضيًا واحدًا ("عميل نقدي" /
 * "مورد نقدي") أول مرة النظام يتهيّأ، فقط لو شيت العملاء/الموردين فاضي
 * تمامًا (عميل عنده طرف واحد فأكتر بالفعل لا يتأثر إطلاقاً — الدالة
 * بترجع فورًا بدون أي إضافة). بينادوا addCustomer/addSupplier القياسية
 * بدل تكرار منطقهم، فأي علاقة داخل النظام (كود تلقائي، AuditLog، إبطال
 * الكاش...) بتتربط بنفس الطريقة تمامًا زي أي طرف يتضاف يدويًا من الواجهة.
 * الاسم قابل للتعديل لاحقًا عادي من شاشة العملاء/الموردين.
 *
 * Idempotent وSelf-Healing زي باقي دوال seed الأخرى: أي تشغيل لاحق لـ
 * initializeSystem()/setupEverything() بيتخطاها لو فيه أي طرف موجود
 * بالفعل، فمينفعش تتكرر.
 *
 * بتتنادى من initializeSystem() في Code_21b_Migrations.js.
 */
function _seedDefaultCashCustomerIfEmpty() {
  return _seedDefaultCashPartyIfEmpty("customer", "عميل نقدي");
}

function _seedDefaultCashSupplierIfEmpty() {
  return _seedDefaultCashPartyIfEmpty("supplier", "مورد نقدي");
}

function _seedDefaultCashPartyIfEmpty(type, defaultName) {
  var fnTag =
    type === "customer"
      ? "_seedDefaultCashCustomerIfEmpty"
      : "_seedDefaultCashSupplierIfEmpty";
  try {
    var existing = _readParties(type);
    if (existing && existing.length > 0) {
      return "↩️ يوجد " + (type === "customer" ? "عميل" : "مورد") +
        " واحد على الأقل بالفعل (" + existing.length + ") — تخطّي";
    }

    // لازم يوزر فعّال (عادةً admin الافتراضي من ensureDefaultUsers) عشان
    // ننشئ جلسة نظام مؤقتة وننادي addCustomer/addSupplier العامة بكل حمايتها.
    var users = readSheet("Users", null, { trimStrings: true });
    var systemUser =
      users.find(function (u) {
        return String(u.username).trim().toLowerCase() === "admin";
      }) || users[0];

    if (!systemUser) {
      Logger.log("[" + fnTag + "] مفيش أي يوزر في النظام لسه — تخطّي إنشاء الطرف الافتراضي");
      return "⏭️ تخطّي — مفيش يوزر بعد لإنشاء الجلسة";
    }

    var sess = createSession(systemUser.username, systemUser.role);
    if (!sess || !sess.success) {
      Logger.log("[" + fnTag + "] فشل إنشاء جلسة مؤقتة: " + JSON.stringify(sess));
      return " فشل إنشاء جلسة مؤقتة لإنشاء الطرف الافتراضي";
    }

    var data = {
      name: defaultName,
      status: "نشط",
      notes: type === "customer" ? "طرف افتراضي للبيع النقدي" : "طرف افتراضي للشراء النقدي",
      sessionToken: sess.token,
    };

    var result =
      type === "customer"
        ? addCustomer(systemUser.username, data)
        : addSupplier(systemUser.username, data);

    if (result && result.success) {
      Logger.log("[" + fnTag + "] تم إنشاء " + defaultName + " — id: " + result.data.id);
      return " تم إنشاء " + defaultName + " (id: " + result.data.id + ")";
    }
    Logger.log("[" + fnTag + "] فشل إنشاء الطرف الافتراضي: " + (result && result.message));
    return " فشل إنشاء " + defaultName + ": " + (result && result.message);
  } catch (e) {
    Logger.log("[" + fnTag + "] خطأ: " + e.message);
    return " خطأ: " + e.message;
  }
}

// ── linkPartyDualRole — §BP-P5 "يتعامل كـ عميل ومورد" ──────────────────────

/**
 * linkPartyDualRole — نقطة الدخول العامة (تُستدعى من الواجهة) لربط/إنشاء
 * السجل المقابل لطرف كـ عميل ومورد في نفس الوقت. راجع linkOrCreateDualParty
 * أعلاه للمنطق الفعلي.
 * @param {String} callerUser
 * @param {String} type - "customer" | "supplier" (نوع السجل الأصلي)
 * @param {String} id - معرف السجل الأصلي
 * @param {String} sessionToken
 */
function linkPartyDualRole(callerUser, type, id, sessionToken) {
  var username = _getUsernameFromToken(sessionToken) || callerUser || "system";
  var permAction = type === "supplier" ? "updateSupplier" : "updateCustomer";
  var permErr = _checkPermission(username, permAction, sessionToken);
  if (permErr) return permErr;
  var res = linkOrCreateDualParty(type, id, username);
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  return res;
}

// ── adjustPartyLoyaltyPointsAPI — §BP-P5 تعديل رصيد نقاط الولاء ─────────────

/**
 * adjustPartyLoyaltyPointsAPI — نقطة الدخول العامة لتعديل رصيد نقاط الولاء
 * يدويًا من شاشة العميل/المورد. راجع adjustPartyLoyaltyPoints أعلاه للمنطق.
 * @param {String} callerUser
 * @param {String} type - "customer" | "supplier"
 * @param {String} id
 * @param {Number} delta - موجب للإضافة، سالب للخصم
 * @param {String} sessionToken
 */
function adjustPartyLoyaltyPointsAPI(callerUser, type, id, delta, sessionToken) {
  var username = _getUsernameFromToken(sessionToken) || callerUser || "system";
  var permAction = type === "supplier" ? "updateSupplier" : "updateCustomer";
  var permErr = _checkPermission(username, permAction, sessionToken);
  if (permErr) return permErr;
  var res = adjustPartyLoyaltyPoints(type, id, delta, username);
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  return res;
}

// ── getPartyMovements ────────────────────────────────────────────────────────

function getPartyMovements(callerUser, partyId, partyType) {
  // [P2-A FIX] إعادة كتابة الدالة لتقرأ من الأستاذ العام (JournalEntryLines)
  // بدلاً من جدول Transactions المخزني — لضمان اتساق الأرقام مع التقارير المالية
  try {
    if (!partyId) return errResponse("معرف الطرف مطلوب");
    var type = partyType === "supplier" ? "supplier" : "customer";

    // اقرأ بيانات الطرف
    var parties = _readParties(type);
    var party = parties.find(function (p) {
      return p.id === partyId;
    });
    if (!party) return errResponse("الطرف غير موجود");

    // [P2-A] المصدر الأول: الأستاذ العام — JournalEntryLines مع party_id
    var allLines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
    );
    var allEntries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );

    // بناء map للقيود المرحَّلة فقط (POSTED) للبحث السريع
    var postedEntries = {};
    allEntries.forEach(function (e) {
      if (e.status === "POSTED") postedEntries[e.id] = e;
    });

    // تصفية السطور المرتبطة بهذا الطرف من القيود المرحَّلة
    var partyLines = allLines.filter(function (l) {
      return (
        String(l.party_id || "").trim() === String(partyId).trim() &&
        postedEntries[l.entry_id]
      );
    });

    var hasGLData = partyLines.length > 0;

    var movArr = [];
    var balance = 0;

    if (hasGLData) {
      // ترتيب حسب تاريخ القيد
      partyLines.sort(function (a, b) {
        var dateA = postedEntries[a.entry_id]
          ? postedEntries[a.entry_id].date
          : "";
        var dateB = postedEntries[b.entry_id]
          ? postedEntries[b.entry_id].date
          : "";
        return String(dateA).localeCompare(String(dateB));
      });

      partyLines.forEach(function (line) {
        var entry = postedEntries[line.entry_id];
        var debit = Number(line.debit || 0);
        var credit = Number(line.credit || 0);

        // للعملاء: المدين يزيد ما يستحق (مبيعات)، الدائن يُقلل (مدفوعات/مرتجعات)
        // للموردين: الدائن يزيد ما يستحق (مشتريات)، المدين يُقلل (مدفوعات/مرتجعات)
        var signedAmount;
        if (type === "customer") {
          signedAmount = debit - credit;
        } else {
          signedAmount = credit - debit;
        }
        balance += signedAmount;

        movArr.push({
          id: line.id,
          entry_id: line.entry_id,
          date: entry ? entry.date : "",
          reference: entry ? entry.reference || entry.id : "",
          description: entry ? entry.description : "",
          source_type: entry ? entry.source_type : "",
          debit: debit,
          credit: credit,
          amount: signedAmount,
          running_balance: balance,
          notes: line.notes || "",
          source: "GL",
        });
      });
    } else {
      // [P2-A FALLBACK] إذا لم تكن هناك بيانات في الأستاذ العام بعد
      // (مثلاً نظام قديم لم يُرحَّل بعد) → نرجع للمصدر القديم مع إشعار
      var txSheet = getSheetData("Transactions");
      var movements = cleanArr(txSheet).filter(function (t) {
        return String(t.party || "").trim() === partyId;
      });
      movements.sort(function (a, b) {
        return String(a.date || "").localeCompare(String(b.date || ""));
      });

      movements.forEach(function (t) {
        var unitPrice = parseFloat(t.price || t.unit_price || 0);
        var qty = parseFloat(t.quantity || 0);
        var amount = unitPrice * qty;
        var signedAmount;
        if (type === "customer") {
          signedAmount =
            t.type === "OUT" || t.type === "SELL" ? amount : -amount;
        } else {
          signedAmount = t.type === "IN" || t.type === "BUY" ? amount : -amount;
        }
        balance += signedAmount;
        movArr.push({
          id: t.id,
          date: t.date,
          reference: t.permit_id || t.id,
          description: t.notes || "",
          source_type: t.type,
          debit: signedAmount > 0 ? signedAmount : 0,
          credit: signedAmount < 0 ? -signedAmount : 0,
          amount: signedAmount,
          running_balance: balance,
          notes: t.notes || "",
          source: "TX_FALLBACK",
        });
      });
    }

    return {
      success: true,
      data: {
        party: party,
        movements: movArr,
        balance: balance,
        source: hasGLData ? "general_ledger" : "transactions_fallback",
      },
    };
  } catch (e) {
    return errResponse("خطأ في جلب حركات الطرف: " + e.message);
  }
}

// ── getAgingReport ───────────────────────────────────────────────────────────

function getAgingReport(partyType, callerUser, sessionToken) {
  // partyType: "CUSTOMER" | "SUPPLIER"
  // [AGING-FIX] يقرأ الأرصدة من الأستاذ العام (JournalEntryLines) بدل الفواتير مباشرة
  // لضمان أن القيود اليدوية وتسويات الحسابات تنعكس في تقرير عمر الديون
  try {
    var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
    if (permErr) return permErr;

    var today = new Date();
    var todayStr = today.toISOString().split("T")[0];
    var isCustomer = partyType !== "SUPPLIER";

    // ── المصدر الأساسي: الفواتير الآجلة ──────────────────────────────────
    var invoiceSheet = isCustomer ? "SaleInvoices" : "PurchaseInvoices";
    var voucherSheet = isCustomer ? "ReceiptVouchers" : "PaymentVouchers";

    var invoices = readSheet(invoiceSheet, []);
    var vouchers = readSheet(
      voucherSheet,
      ACCOUNTING_HR_HEADERS[isCustomer ? "ReceiptVouchers" : "PaymentVouchers"],
    );

    // إجمالي السداد لكل فاتورة عبر سندات القبض/الصرف المرتبطة بـ invoice_id
    var paidByInvoice = {};
    // [FIX-ISSUE-PARTY-AGING-1] دفعات "على الحساب" (بلا invoice_id) لكل طرف —
    // كانت تُتجاهل بالكامل هنا فيتضخّم عمر الديون. راجع تفصيل التوزيع تحت.
    var unassignedPaidByParty = {};
    vouchers.forEach(function (v) {
      if (v.status === "CANCELLED" || v.status === "REVERSED") return;
      var amt = Number(v.applied_amount || v.amount || 0);
      if (v.invoice_id) {
        paidByInvoice[v.invoice_id] = (paidByInvoice[v.invoice_id] || 0) + amt;
      } else if (v.party_id) {
        unassignedPaidByParty[v.party_id] =
          (unassignedPaidByParty[v.party_id] || 0) + amt;
      }
    });

    // ── المصدر التكميلي: الأستاذ العام (POSTED فقط) ──────────────────────
    // نحسب صافي رصيد كل طرف من القيود لاكتشاف تسويات يدوية خارج الفواتير
    var arApAccountKey = isCustomer ? "ar_account" : "ap_account";
    var arApHints = isCustomer
      ? ["ذمم مدينة", "عملاء", "accounts receivable"]
      : ["ذمم دائنة", "موردون", "accounts payable"];

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var arApAccount = _getDefaultAccount(
      arApAccountKey,
      accounts,
      isCustomer ? "ASSET" : "LIABILITY",
      arApHints,
    );

    var glBalanceByParty = {};
    var glLastDateByParty = {}; // [FIX-ISSUE-PARTY-AGING-2] آخر تاريخ قيد فعلي لكل طرف
    if (arApAccount) {
      var jeEntries = readSheet(
        "JournalEntries",
        ACCOUNTING_HR_HEADERS.JournalEntries,
        { trimStrings: true },
      );
      var jeLines = readSheet(
        "JournalEntryLines",
        ACCOUNTING_HR_HEADERS.JournalEntryLines,
        { trimStrings: true },
      );
      var postedEntryMap = {};
      jeEntries.forEach(function (e) {
        if (e.status === "POSTED") postedEntryMap[e.id] = e;
      });

      jeLines.forEach(function (l) {
        var entry = postedEntryMap[l.entry_id];
        if (!entry) return;
        if (l.account_id !== arApAccount.id) return;
        if (!l.party_id) return;
        var net = isCustomer
          ? Number(l.debit || 0) - Number(l.credit || 0) // عميل: مدين = مديونية
          : Number(l.credit || 0) - Number(l.debit || 0); // مورد: دائن = مديونية
        glBalanceByParty[l.party_id] =
          (glBalanceByParty[l.party_id] || 0) + net;
        if (
          entry.date &&
          (!glLastDateByParty[l.party_id] ||
            entry.date > glLastDateByParty[l.party_id])
        ) {
          glLastDateByParty[l.party_id] = entry.date;
        }
      });
    }

    // ── بناء تقرير الـ Aging من الفواتير الآجلة ─────────────────────────
    var aging = {
      current: 0,
      days30: 0,
      days60: 0,
      days90: 0,
      over90: 0,
      total: 0,
    };
    var items = [];
    var coveredParties = {};

    function _bucketOf(daysPast) {
      return daysPast <= 30
        ? "current"
        : daysPast <= 60
          ? "days30"
          : daysPast <= 90
            ? "days60"
            : daysPast <= 120
              ? "days90"
              : "over90";
    }

    // [FIX-ISSUE-PARTY-AGING-1] كل الفواتير الآجلة مجمّعة حسب الطرف، مرتّبة
    // من الأقدم للأحدث — عشان نقدر نوزّع عليها أي دفعة "على الحساب" أو أي
    // فرق بينها وبين رصيد الأستاذ العام الفعلي (FIFO: أقدم فاتورة أولاً).
    var invoicesByParty = {};
    invoices.forEach(function (inv) {
      if (inv.payment_status !== "آجل") return;
      var paid = paidByInvoice[inv.id] || 0;
      var remaining = Number(inv.net_total || 0) - paid;
      if (remaining <= 0.01) return;
      var pid = inv.party_id || "";
      if (!invoicesByParty[pid]) invoicesByParty[pid] = [];
      invoicesByParty[pid].push({ inv: inv, remaining: remaining });
    });

    Object.keys(invoicesByParty).forEach(function (pid) {
      var list = invoicesByParty[pid];
      list.sort(function (a, b) {
        return String(a.inv.date).localeCompare(String(b.inv.date));
      });

      var invoiceBasedTotal = list.reduce(function (s, x) {
        return s + x.remaining;
      }, 0);

      // الرصيد الفعلي الحقيقي لهذا الطرف = رصيد الأستاذ العام (لو متاح)،
      // وإلا إجمالي الفواتير كما كان قبل الإصلاح. رصيد الأستاذ العام هو
      // المرجع النهائي (يشمل أي دفعة على الحساب/تسوية يدوية)، وتوزيع
      // الفواتير يُستخدم فقط لتوزيع هذا الإجمالي على شرائح الأعمار.
      var pidGlKnown = pid && glBalanceByParty[pid] !== undefined;
      var trueTotal =
        arApAccount && pidGlKnown ? Math.max(glBalanceByParty[pid], 0) : invoiceBasedTotal;
      // خصم الدفعات على الحساب من إجمالي الفواتير مباشرة لو مفيش بيانات GL
      // متاحة لهذا الطرف تحديدًا (نادر — يعني حساب AR/AP مش مربوط أو فيه
      // خطأ قراءة) بدل ما نتجاهلها بالكامل.
      if (!arApAccount || !pidGlKnown) {
        trueTotal = Math.max(
          invoiceBasedTotal - (unassignedPaidByParty[pid] || 0),
          0,
        );
      }

      var remainingToAllocate = trueTotal;
      list.forEach(function (x) {
        var alloc = Math.min(x.remaining, remainingToAllocate);
        remainingToAllocate -= alloc;
        if (alloc <= 0.01) return; // اتغطّت بالكامل بدفعة على الحساب/تسوية

        var invoiceDate = new Date(x.inv.date);
        var daysPast = Math.floor(
          (today - invoiceDate) / (1000 * 60 * 60 * 24),
        );
        var bucket = _bucketOf(daysPast);

        aging[bucket] += alloc;
        aging.total += alloc;

        items.push({
          invoice_id: x.inv.id,
          party: x.inv.party,
          party_id: pid,
          date: x.inv.date,
          days_past: daysPast,
          total: Number(x.inv.net_total || 0),
          paid: Number(x.inv.net_total || 0) - alloc,
          remaining: alloc,
          bucket: bucket,
          source: "invoice",
        });
      });

      if (pid) coveredParties[pid] = true;
    });

    // ── إضافة أرصدة GL التي ليس لها فواتير مرتبطة (قيود يدوية) ──────────
    Object.keys(glBalanceByParty).forEach(function (partyId) {
      if (coveredParties[partyId]) return; // مغطى بالكامل من الفواتير فوق
      var glBalance = glBalanceByParty[partyId];
      if (glBalance <= 0.01) return;
      // [FIX-ISSUE-PARTY-AGING-2] كان بيتحط دايمًا في over90 بتاريخ وهمي
      // (days_past: 999) بغض النظر عن حداثة التسوية. دلوقتي بنستخدم آخر
      // تاريخ قيد فعلي مؤثر على رصيد الطرف لحساب العمر الحقيقي.
      var lastDate = glLastDateByParty[partyId];
      var daysPast = 999; // fallback لو تعذّر إيجاد تاريخ لأي سبب
      if (lastDate) {
        daysPast = Math.floor(
          (today - new Date(lastDate)) / (1000 * 60 * 60 * 24),
        );
      }
      var bucket = _bucketOf(daysPast);
      aging[bucket] += glBalance;
      aging.total += glBalance;
      items.push({
        invoice_id: "",
        party: partyId,
        party_id: partyId,
        date: lastDate || "",
        days_past: daysPast,
        total: glBalance,
        paid: 0,
        remaining: glBalance,
        bucket: bucket,
        source: "gl_manual",
      });
    });

    return {
      success: true,
      data: {
        summary: aging,
        items: items.sort(function (a, b) {
          return b.days_past - a.days_past;
        }),
        party_type: partyType,
        as_of: todayStr,
        gl_reconciled: !!arApAccount,
      },
    };
  } catch (e) {
    return { success: false, message: "خطأ في تقرير عمر الديون: " + e.message };
  }
}

// ── Private helpers ──────────────────────────────────────────────────────────

function _readParties(type) {
  var sheetName = _getPartySheet(type);
  var headers = _getPartyHeaders(type);
  try {
    return cleanArr(readSheet(sheetName, headers));
  } catch (e) {
    // الشيت مش موجودة — أنشئها
    _ensurePartySheet(type);
    return [];
  }
}

/**
 * _resolvePartyIdByName — [B1-FIX] إيجاد معرف العميل/المورد من اسمه النصي.
 * الفواتير حاليًا تحتفظ باسم الطرف كنص حر (لا يوجد dropdown مرتبط بمعرف العميل/المورد)،
 * فهذه الدالة تحاول مطابقة الاسم مع سجل عميل/مورد موجود لملء party_id في سطور القيد،
 * بحيث يصبح كشف الحساب وتقرير التقادم موثوقين عبر الأستاذ العام بدلاً من النص الحر فقط.
 * تُرجع "" إذا لم يوجد تطابق (الاسم يبقى في notes كما كان، بدون كسر أي شيء).
 */
function _resolvePartyIdByName(name, type) {
  try {
    var trimmedName = String(name || "")
      .trim()
      .toLowerCase();
    if (!trimmedName) return "";
    var parties = _readParties(type);
    var match = parties.find(function (p) {
      return (
        String(p.name || "")
          .trim()
          .toLowerCase() === trimmedName
      );
    });
    return match ? match.id : "";
  } catch (e) {
    Logger.log("[_resolvePartyIdByName] خطأ: " + e.message);
    return "";
  }
}

function _ensurePartySheet(type) {
  var sheetName = _getPartySheet(type);
  var headers = _getPartyHeaders(type);
  try {
    // [REPO-MIGRATION] getSheet() (Code_12_Core.js) بتعمل بالظبط نفس هذا
    // المنطق (إنشاء + حماية + ترحيل أعمدة) لكن بقفل ضد التعارض (LockService)
    // كانت ناقصة هنا. استدعاؤها هنا بديل رفيع بدل تكرار نفس الخطوات محليًا.
    getSheet(sheetName, headers);
  } catch (e) {
    // تجاهل لو مش قادر ينشئ
  }
}

// §BP-P2 — يضيف أي header موجود في المصفوفة البرمجية وغير موجود فعليًا في
// صف العناوين بالشيت، في آخر عمود، دون لمس أي بيانات موجودة. آمن للتكرار
// (idempotent) — لو الأعمدة كلها موجودة بالفعل مش بيعمل حاجة.
function _ensurePartyNewColumns(sheet, headers) {
  try {
    var lastCol = sheet.getLastColumn();
    var existing = lastCol
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      : [];
    var existingStr = existing.map(function (h) {
      return String(h || "").trim();
    });
    var missing = headers.filter(function (h) {
      return existingStr.indexOf(h) === -1;
    });
    if (!missing.length) return;
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  } catch (e) {
    // تجاهل — لن يمنع الإضافة/التعديل من الاستمرار حتى لو فشل الترحيل
  }
}

// [SL-MIGRATION] منطق الكتابة الخام فقط (بدون صلاحية/قواعد عمل/تدقيق/كاش —
// هذه الأربعة أصبحت مسؤولية ServiceLayer.execute بشكل موحّد). نفس السطور
// الحرفية التي كانت داخل _addParty، فقط بدون استدعاء _writeAuditLog/_invalidateServerCache
// محليًا (ServiceLayer ينفّذهما بعد نجاح الـ handler).
function _partyCreateHandler(type) {
  return function (data /*, context */) {
    return _addParty(type, data, null, true);
  };
}

function _partyUpdateHandler(type) {
  return function (payload /*, context */) {
    return _updateParty(type, payload.id, payload, null, true);
  };
}

function _partyDeleteHandler(type) {
  return function (payload /*, context */) {
    return _deleteParty(type, payload.id, null, true);
  };
}

["customer", "supplier"].forEach(function (partyType) {
  var isCustomer = partyType === "customer";
  // [PARTY-VALIDATION] الكود الفريد إلزامي للعملاء فقط (الموردين مالهمش
  // عمود code أصلاً في SUPPLIER_HEADERS). لكن فحص صيغة باقي الحقول
  // (بريد/رقم ضريبي/رقم قومي/موقع إلكتروني...) بقى مطلوبًا للطرفين، فبقينا
  // نمرر entityType الصحيح لكل نوع بدل تجاهل الموردين بالكامل كما كان
  // سابقًا (كان بيرجع {success:true} دايمًا للموردين — أي تحقق شكلي كان
  // بيعتمد فقط على VF على العميل، بدون أي حماية من السيرفر).
  var _partyCodeCheck = function (payload) {
    return BusinessRulesEngine.validateBeforeSave(
      isCustomer ? "customer" : "supplier",
      payload,
    );
  };
  // [AUTO-CODE] عند الإضافة فقط: لو الكود وصل فاضي (الحالة الطبيعية بعد
  // التحويل للترقيم التلقائي) نولّده هنا تسلسليًا (1، 2، 3...) قبل فحص
  // قواعد العمل — بيضمن إن كود كل عميل/مورد جديد دايمًا متسلسل بغض النظر
  // عمّا وصل فعليًا من الواجهة. لو المستخدم بعت كودًا يدويًا (توافقًا مع
  // بيانات قديمة/استيراد) بنحترمه ونسيبه كما هو.
  var _partyCreateCodeCheck = function (payload) {
    if (!String(payload.code || "").trim()) {
      payload.code = _getNextPartyCode(partyType);
    }
    return _partyCodeCheck(payload);
  };
  ServiceLayer.register(partyType, "create", {
    permissionAction: isCustomer ? "addCustomer" : "addSupplier",
    breCheck: _partyCreateCodeCheck,
    handler: _partyCreateHandler(partyType),
    auditAction: isCustomer ? "addCustomer" : "addSupplier",
    table: isCustomer ? CUSTOMERS_SHEET : SUPPLIERS_SHEET,
    auditDetails: function (payload) {
      return { name: payload.name };
    },
  });

  ServiceLayer.register(partyType, "update", {
    permissionAction: isCustomer ? "updateCustomer" : "updateSupplier",
    breCheck: _partyCodeCheck,
    handler: _partyUpdateHandler(partyType),
    auditAction: isCustomer ? "updateCustomer" : "updateSupplier",
    table: isCustomer ? CUSTOMERS_SHEET : SUPPLIERS_SHEET,
  });

  // [BRE-INTEGRATION] فحص الاستخدام قبل الحذف أصبح عبر
  // BusinessRulesEngine.validateBeforeDelete('customer'|'supplier', {id}) —
  // نفس منطق _partyHasUsage تمامًا (المحرك يعيد استخدامها داخليًا)، بدل تكراره هنا.
  ServiceLayer.register(partyType, "delete", {
    permissionAction: isCustomer ? "deleteCustomer" : "deleteSupplier",
    breCheck: function (payload) {
      return BusinessRulesEngine.validateBeforeDelete(partyType, payload);
    },
    handler: _partyDeleteHandler(partyType),
    auditAction: isCustomer ? "deleteCustomer" : "deleteSupplier",
    table: isCustomer ? CUSTOMERS_SHEET : SUPPLIERS_SHEET,
  });
});

// [SL-MIGRATION] أُضيف باراميتر رابع _skipSideEffects (اختياري، افتراضي false)
// حتى تبقى _addParty قابلة للاستدعاء المباشر بسلوكها القديم الكامل (تستخدمها
// أماكن أخرى محتملة في المشروع خارج addCustomer/addSupplier) بينما تتفادى
// ServiceLayer.execute ازدواج التدقيق/الكاش (يُنفَّذان مركزيًا بعد الـ handler).
function _addParty(type, data, callerUser, _skipSideEffects) {
  // [FIX-ISSUE-PARTY-3] حد ائتمان سالب كان يُقبل بصمت وقد يُفسَّر لاحقًا
  // بشكل غير متوقع في منطق الموافقة على البيع الآجل.
  if (data && data.credit_limit !== undefined && Number(data.credit_limit) < 0) {
    return { success: false, message: "حد الائتمان لا يمكن أن يكون رقمًا سالبًا" };
  }
  _ensurePartySheet(type);
  var sheetName = _getPartySheet(type);
  var now = new Date().toISOString();
  var id = _genPartyId(type);
  var headers = _getPartyHeaders(type);
  // [MD-01 FIX] بناء الصف ديناميكيًا من الـ headers بدل مصفوفة ثابتة الطول.
  // المصفوفة الثابتة كانت تفترض 10 أعمدة دائمًا، بينما CUSTOMER_HEADERS فيها 11 عمودًا
  // (حد الائتمان credit_limit مُضاف بعد account_id) — فكان created_at/updated_at
  // ينزاحان عمودًا لليسار، وعمود credit_limit يُكتب فيه تاريخ الإنشاء بدل الحد الفعلي،
  // مما يُعطّل فحص حد الائتمان بالكامل عند فواتير البيع الآجلة (يقرأ NaN→0 دائمًا).
  var fieldMap = {
    id: id,
    name: String(data.name || "").trim(),
    phone: String(data.phone || "").trim(),
    email: String(data.email || "").trim(),
    tax_number: String(data.tax_number || "").trim(),
    address: String(data.address || "").trim(),
    notes: String(data.notes || "").trim(),
    account_id: String(data.account_id || "").trim(), // ← حساب الطرف في دليل الحسابات
    credit_limit: Number(data.credit_limit || 0), // عملاء فقط — يُتجاهل لو العمود غير موجود
    created_at: now,
    updated_at: now,
    // §BP-P2 — حقول أساسية وسريعة
    status: String(data.status || "نشط").trim(),
    classification: String(data.classification || "").trim(),
    group_name: String(data.group_name || "").trim(),
    contact_person: String(data.contact_person || "").trim(),
    contact_job_title: String(data.contact_job_title || "").trim(),
    phone2: String(data.phone2 || "").trim(),
    website: String(data.website || "").trim(),
    fax: String(data.fax || "").trim(),
    // §BP-P4 — بيانات مالية موسّعة
    bank_name: String(data.bank_name || "").trim(),
    bank_account_number: String(data.bank_account_number || "").trim(),
    iban: String(data.iban || "").trim(),
    swift_code: String(data.swift_code || "").trim(),
    currency: String(data.currency || "").trim(),
    default_payment_method: String(data.default_payment_method || "").trim(),
    payment_terms_days:
      data.payment_terms_days !== undefined && data.payment_terms_days !== null && data.payment_terms_days !== ""
        ? Number(data.payment_terms_days)
        : // [CUST-SETTINGS-WIRE-2026-08-08] default_payment_term_days — كان
          // محفوظًا في CustomerSettingsEngine بدون أي استخدام؛ يُطبَّق الآن
          // كقيمة افتراضية فقط عند عدم إرسال المستخدم قيمة صريحة (0 صريح
          // من المستخدم يفضل 0، مش يتبدّل بالإعداد).
          Number(
            (typeof CustomerSettingsEngine !== "undefined" &&
              CustomerSettingsEngine.get("default_payment_term_days")) ||
              0,
          ),
    discount_percent: Number(data.discount_percent || 0),
    default_price_list: String(data.default_price_list || "").trim(),
    // §CAT-P1 — تصنيف هرمي (Code_28_PartyCategories.gs)
    category_id: String(data.category_id || "").trim(),
    // [NEW-FIELDS] بيانات موجودة في الأنظمة الكبرى وناقصة سابقًا
    // [AUDIT-FIX INVSET-04] default_new_customer_nature / default_new_supplier_nature
    // — قبل التعديل: لو الشاشة بعتت entity_type فاضي، كان يتسجل فاضي في
    // السجل بلا أي رجوع للإعداد الافتراضي رغم وجوده في شاشة إعدادات
    // العملاء/الموردين (Dead Setting). الآن: لو مفيش قيمة صريحة من
    // المستخدم، نرجع لقيمة الإعداد المناسبة (فرد | شركة) بدل الفراغ.
    entity_type: (function () {
      var explicit = String(data.entity_type || "").trim();
      if (explicit) return explicit;
      if (typeof CustomerSettingsEngine === "undefined") return "";
      var settingKey =
        type === "customer"
          ? "default_new_customer_nature"
          : "default_new_supplier_nature";
      return String(CustomerSettingsEngine.get(settingKey) || "").trim();
    })(),
    national_id: String(data.national_id || "").trim(),
    sales_rep: type === "customer" ? String(data.sales_rep || "").trim() : "",
    purchase_rep: type === "supplier" ? String(data.purchase_rep || "").trim() : "",
    // [PARITY-CUST] الكود بقى موحّد لكل من العميل والمورد (نفس المبدأ:
    // فريد وإلزامي)، بس مبدأ العمل يختلف: عند العميل بيتربط بذمم مدينة
    // وعند المورد بيتربط بذمم دائنة.
    code: String(data.code || "").trim(),
    // [DOC-ENGINE] إنشاء هيكل فولدرات Drive تلقائيًا لهذا الطرف عند أول
    // إنشاء له — لا يمنع إنشاء الطرف نفسه لو فشل الاتصال بـ Drive لأي سبب
    // (فشل صامت هنا، والفولدر هيتعمل لاحقًا تلقائيًا أول مرة يُرفع فيها ملف).
    drive_folder_id: (function () {
      try {
        var fr = DocumentEngine.ensurePartyFolders(
          type,
          String(data.code || "").trim(),
          String(data.name || "").trim(),
        );
        return fr && fr.success ? fr.folderId : "";
      } catch (e) {
        Logger.log("[_addParty] فشل إنشاء فولدر Drive: " + e.message);
        return "";
      }
    })(),
    // §BP-P5 — حقول موسّعة إضافية (مشتركة بين العملاء والموردين)
    cost_center: String(data.cost_center || "").trim(),
    is_blacklisted: !!data.is_blacklisted,
    employer: String(data.employer || "").trim(),
    guarantor1: String(data.guarantor1 || "").trim(),
    guarantor2: String(data.guarantor2 || "").trim(),
    ledger_page_number: String(data.ledger_page_number || "").trim(),
    is_dual_party: !!data.is_dual_party,
    dual_party_id: String(data.dual_party_id || "").trim(),
    default_shipping_company_id: String(
      data.default_shipping_company_id || "",
    ).trim(),
    loyalty_enabled: !!data.loyalty_enabled,
    loyalty_points: Number(data.loyalty_points || 0),
    has_custom_invoice_sequence: !!data.has_custom_invoice_sequence,
    invoice_sequence_prefix: String(
      data.invoice_sequence_prefix || "",
    ).trim(),
    invoice_sequence_next: Number(data.invoice_sequence_next || 1),
    // §BP-P6 — هاتف شخص الاتصال + علم تفعيل واتساب على الرقم الأساسي
    // (افتراضيًا مفعّل عند الإضافة، مطابقة لحالة الـ checkbox الافتراضية بالواجهة)
    contact_phone: String(data.contact_phone || "").trim(),
    phone_whatsapp:
      data.phone_whatsapp !== undefined ? !!data.phone_whatsapp : true,
  };
  // [REPO-MIGRATION] كان بيبني الصف يدويًا بالـ headers.map ثم
  // _appendRowProtected مباشرة على الشيت. RepositoryLayer.create بيعمل
  // بالظبط نفس المنطق داخليًا (id/created_at/updated_at already محددين في
  // fieldMap فبتتاخد كما هي) لكن عبر getSheet() الموحّدة (حماية + ترحيل
  // أعمدة + قفل ضد التعارض).
  var repo = Repositories[type === "supplier" ? "Suppliers" : "Customers"];
  // [BUGFIX-SILENT-WRITE-FAIL] قبل كده كان بينادي repo.create من غير ما
  // يتحقق من نتيجتها خالص — لو الكتابة الفعلية في الشيت فشلت (تعارض قفل/
  // خطأ مؤقت من Google Sheets API)، الدالة كانت بترجع "نجاح" ومعاها id
  // رغم إن الصف اتكتبش فعليًا في الشيت. النتيجة: العميل/المورد يظهر في
  // الواجهة (إضافة محلية متفائلة)، لكن أي عملية تالية بتدوّر عليه في
  // الشيت الحقيقي (زي ترحيل الرصيد الافتتاحي) بتفشل بـ"الطرف غير موجود"
  // لأنه مش موجود فعلًا. دلوقتي بنتحقق من النتيجة ونوقف فورًا لو فشلت.
  var createRes = repo.create(fieldMap, { headers: headers });
  if (!createRes || createRes.success === false) {
    return {
      success: false,
      message:
        "فشل حفظ " +
        (type === "supplier" ? "المورد" : "العميل") +
        " في الشيت: " +
        ((createRes && createRes.message) || "خطأ غير معروف — حاول مرة أخرى"),
    };
  }
  if (_skipSideEffects) {
    // [SL-MIGRATION] الاستدعاء جاي من ServiceLayer.execute — التدقيق والكاش
    // يُنفَّذان مركزيًا هناك بعد نجاح الـ handler، فادي التكرار هنا.
    return { success: true, message: "تمت الإضافة بنجاح", data: { id: id } };
  }
  // [AUDIT-FIX] كان بينادي _writeAuditLog بثلاث معاملات (callerUser, action, details)
  // بينما توقيع الدالة الفعلي كائن واحد entry={user, action, table, record_id, details, ...}
  // — يعني المستخدم كان بيتسجل غلط (الـ action بتتحط في مكان user، وهكذا). راجع
  // ملاحظة BP-ROADMAP.md P3 "جانبية مُكتشَفة" — تم إصلاحه هنا لأن الدالة كانت
  // بتتعدّل أصلاً ضمن P4.
  AuditEngine.log(type === "customer" ? "addCustomer" : "addSupplier", {
    user: callerUser,
    table: sheetName,
    record_id: id,
    details: { name: data.name }});
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  return { success: true, message: "تمت الإضافة بنجاح", data: { id: id } };
}

function _updateParty(type, id, data, callerUser, _skipSideEffects) {
  // [FIX-ISSUE-PARTY-3] راجع نفس الملاحظة في _addParty أعلاه.
  if (data && data.credit_limit !== undefined && Number(data.credit_limit) < 0) {
    return { success: false, message: "حد الائتمان لا يمكن أن يكون رقمًا سالبًا" };
  }
  var sheetName = _getPartySheet(type);
  var repFieldName = type === "customer" ? "sales_rep" : "purchase_rep";
  var repo = Repositories[type === "supplier" ? "Suppliers" : "Customers"];

  // [REPO-MIGRATION] كل أعمدة الـ fallback اليدوي (p2Cols/p4Cols/catCol/
  // mdCols/repCol/codeCol/p5Cols/p6Cols/baseCol) اللي كانت بتتبنى هنا
  // بغرض قراءة القيمة القديمة عند عدم إرسال حقل معيّن — بقت غير لازمة.
  // RepositoryLayer.update (Code_38) بيحافظ تلقائيًا على القيمة القديمة
  // لأي حقل مش موجود في الـ patch (نفس الضمانة، لكن مركزية للجداول كلها
  // بدل تكرارها يدويًا هنا). محتاجين بس السجل الحالي للحالة الخاصة
  // الوحيدة تحت (phone_whatsapp) اللي فيها منطق تحويل أكتر من مجرد fallback.
  var currentRes = repo.getById(id);
  if (!currentRes.success || !currentRes.data) {
    return errResponse("السجل غير موجود");
  }
  var current = currentRes.data;

  var patch = {};
  function setIfDefined(field, transform) {
    if (data[field] !== undefined) patch[field] = transform(data[field]);
  }
  var str = function (v) {
    return String(v || "").trim();
  };

  // الحقول الأساسية [BUG-FIX سابق: كانت بدون fallback فتُمسح لو مش مُرسَلة]
  setIfDefined("name", str);
  setIfDefined("phone", str);
  setIfDefined("email", str);
  setIfDefined("tax_number", str);
  setIfDefined("address", str);
  setIfDefined("notes", str);
  setIfDefined("account_id", str);
  if (data.credit_limit !== undefined)
    patch.credit_limit = Number(data.credit_limit || 0);
  if (data.status !== undefined)
    patch.status = String(data.status || "نشط").trim();
  // §BP-P2
  setIfDefined("classification", str);
  setIfDefined("group_name", str);
  setIfDefined("contact_person", str);
  setIfDefined("contact_job_title", str);
  setIfDefined("phone2", str);
  setIfDefined("website", str);
  setIfDefined("fax", str);
  // §BP-P4 — بيانات مالية موسّعة
  setIfDefined("bank_name", str);
  setIfDefined("bank_account_number", str);
  setIfDefined("iban", str);
  setIfDefined("swift_code", str);
  setIfDefined("currency", str);
  setIfDefined("default_payment_method", str);
  if (data.payment_terms_days !== undefined)
    patch.payment_terms_days = Number(data.payment_terms_days || 0);
  if (data.discount_percent !== undefined)
    patch.discount_percent = Number(data.discount_percent || 0);
  setIfDefined("default_price_list", str);
  // §CAT-P1
  setIfDefined("category_id", str);
  // [NEW-FIELDS]
  setIfDefined("entity_type", str);
  setIfDefined("national_id", str);
  if (data[repFieldName] !== undefined)
    patch[repFieldName] = String(data[repFieldName] || "").trim();
  // [PARITY-CUST] الكود بقى قابل للتحديث لكل من العميل والمورد
  if (data.code !== undefined) {
    patch.code = String(data.code || "").trim();
  }
  // §BP-P5 — حقول موسّعة إضافية
  setIfDefined("cost_center", str);
  if (data.is_blacklisted !== undefined)
    patch.is_blacklisted = !!data.is_blacklisted;
  setIfDefined("employer", str);
  setIfDefined("guarantor1", str);
  setIfDefined("guarantor2", str);
  setIfDefined("ledger_page_number", str);
  if (data.is_dual_party !== undefined)
    patch.is_dual_party = !!data.is_dual_party;
  setIfDefined("dual_party_id", str);
  setIfDefined("default_shipping_company_id", str);
  if (data.loyalty_enabled !== undefined)
    patch.loyalty_enabled = !!data.loyalty_enabled;
  if (data.loyalty_points !== undefined)
    patch.loyalty_points = Number(data.loyalty_points || 0);
  if (data.has_custom_invoice_sequence !== undefined)
    patch.has_custom_invoice_sequence = !!data.has_custom_invoice_sequence;
  setIfDefined("invoice_sequence_prefix", str);
  if (data.invoice_sequence_next !== undefined)
    patch.invoice_sequence_next = Number(data.invoice_sequence_next || 1);
  // §BP-P6 — هاتف شخص الاتصال + علم واتساب
  setIfDefined("contact_phone", str);
  // [WA-FLAG] فارغ/غير موجود = true (توافقًا مع العملاء/الموردين اللي
  // اتضافوا قبل وجود هذا الحقل) — الحالة الوحيدة اللي محتاجة القيمة
  // الحالية صراحة لأنها أكتر من مجرد "حافظ على القديم".
  if (data.phone_whatsapp !== undefined) {
    patch.phone_whatsapp = !!data.phone_whatsapp;
  } else if (current.phone_whatsapp === "" || current.phone_whatsapp === undefined) {
    patch.phone_whatsapp = true;
  }

  var res = repo.update(id, patch);
  if (!res.success) return errResponse("السجل غير موجود");

  // [AUDIT-FIX M3] كان الـ Audit Log لا يسجّل القيمة القديمة/الجديدة إطلاقًا
  // عند تعديل عميل/مورد رغم أن ServiceLayer.execute (Code_00) يدعم ذلك
  // فعليًا (result.oldValue/newValue) — راجع تعليق BusinessRulesEngine
  // CustomerRules.isSensitiveFieldChangeBlocked (قاعدة موجودة ومتروكة
  // اختيارية عمدًا، لا نغيّر ذلك). هنا فقط نضيف تتبعًا لمن غيّر الحقول
  // الحساسة (الاسم/الرقم الضريبي/الرقم القومي/الكود) ومتى — بدون منع
  // أي عملية تعديل، حتى لا نكسر أي سير عمل حالي.
  var _sensitiveFields = ["name", "tax_number", "national_id", "code"];
  var _sensitiveDiff = null;
  _sensitiveFields.forEach(function (f) {
    if (patch[f] !== undefined && String(patch[f]) !== String(current[f] || "")) {
      _sensitiveDiff = _sensitiveDiff || { old: {}, new: {} };
      _sensitiveDiff.old[f] = current[f] || "";
      _sensitiveDiff.new[f] = patch[f];
    }
  });

  if (_skipSideEffects) {
    // [SL-MIGRATION] راجع نفس الملاحظة في _addParty أعلاه.
    return {
      success: true,
      message: "تم التعديل بنجاح",
      oldValue: _sensitiveDiff ? _sensitiveDiff.old : undefined,
      newValue: _sensitiveDiff ? _sensitiveDiff.new : undefined,
    };
  }
  // [AUDIT-FIX] راجع نفس الملاحظة في _addParty أعلاه.
  AuditEngine.log(type === "customer" ? "updateCustomer" : "updateSupplier", {
    user: callerUser,
    table: sheetName,
    record_id: id,
    oldValue: _sensitiveDiff ? _sensitiveDiff.old : undefined,
    newValue: _sensitiveDiff ? _sensitiveDiff.new : undefined});
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  return { success: true, message: "تم التعديل بنجاح" };
}

/**
 * _getPartyById — [BP-P5] جلب سجل عميل/مورد واحد بمعرفه. مطلوب لفحوصات
 * القائمة السوداء ومسلسل الفواتير الخاص ونقاط الولاء بدون قراءة كل الجدول
 * يدويًا في كل مكان.
 * @param {String} type - "customer" | "supplier"
 * @param {String} id - معرف الطرف
 * @returns {Object|null}
 */
function _getPartyById(type, id) {
  if (!id) return null;
  var parties = _readParties(type);
  var match = parties.find(function (p) {
    return String(p.id || "") === String(id);
  });
  return match || null;
}

/**
 * linkOrCreateDualParty — §BP-P5 "يتعامل كـ عميل ومورد في نفس الوقت".
 * بدل تغيير معمارية الجداول المنفصلة (Customers/Suppliers)، الحل هنا هو
 * ربط تبادلي: لو مفعّل is_dual_party وملوش dual_party_id لسه، بننشئ سجل
 * مقابل في الجدول التاني بنفس البيانات الأساسية (الاسم، الهاتف، الإيميل،
 * الرقم الضريبي، العنوان، البيانات البنكية، نوع الكيان، الرقم القومي)
 * ونربط الاتنين ببعض عبر dual_party_id في الاتجاهين. لو already linked،
 * بترجع المعرف الموجود من غير تكرار.
 * @param {String} type - نوع السجل الأصلي "customer" | "supplier"
 * @param {String} id - معرف السجل الأصلي
 * @param {String} callerUser
 * @returns {{success:Boolean, message:String, data:Object}}
 */
function linkOrCreateDualParty(type, id, callerUser) {
  var source = _getPartyById(type, id);
  if (!source) return errResponse("السجل غير موجود");
  if (source.dual_party_id) {
    return {
      success: true,
      message: "مربوط بالفعل",
      data: { linkedId: source.dual_party_id },
    };
  }
  var otherType = type === "customer" ? "supplier" : "customer";
  var counterpartData = {
    name: source.name || "",
    phone: source.phone || "",
    phone2: source.phone2 || "",
    email: source.email || "",
    tax_number: source.tax_number || "",
    address: source.address || "",
    notes: "تم إنشاؤه تلقائيًا كسجل مقابل لـ " + (source.name || ""),
    entity_type: source.entity_type || "",
    national_id: source.national_id || "",
    bank_name: source.bank_name || "",
    bank_account_number: source.bank_account_number || "",
    iban: source.iban || "",
    swift_code: source.swift_code || "",
    is_dual_party: true,
    dual_party_id: id,
  };
  var created = _addParty(otherType, counterpartData, callerUser, true);
  if (!created || !created.success) {
    return errResponse("تعذّر إنشاء السجل المقابل");
  }
  var newId = created.data.id;
  _updateParty(
    type,
    id,
    { is_dual_party: true, dual_party_id: newId },
    callerUser,
    true,
  );
  AuditEngine.log("linkOrCreateDualParty", {
    user: callerUser,
    table: type === "customer" ? CUSTOMERS_SHEET : SUPPLIERS_SHEET,
    record_id: id,
    details: { linkedId: newId, linkedType: otherType }});
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  return { success: true, message: "تم الربط بنجاح", data: { linkedId: newId } };
}

/**
 * adjustPartyLoyaltyPoints — §BP-P5 تعديل رصيد نقاط الولاء لعميل/مورد.
 * دالة مستقلة (لا تُستدعى تلقائيًا من محرك الفواتير حاليًا — دي نقطة توسّع
 * لاحقة عند ربط برنامج النقاط فعليًا بمنطق البيع) تسمح بإضافة/خصم نقاط
 * يدويًا أو من أي موديول آخر يستدعيها مستقبلاً.
 * @param {String} type
 * @param {String} id
 * @param {Number} delta - موجب للإضافة، سالب للخصم
 * @param {String} callerUser
 */
function adjustPartyLoyaltyPoints(type, id, delta, callerUser) {
  var party = _getPartyById(type, id);
  if (!party) return errResponse("السجل غير موجود");
  if (!party.loyalty_enabled) {
    return errResponse("نظام النقاط غير مفعّل لهذا الطرف");
  }
  var newBalance = Number(party.loyalty_points || 0) + Number(delta || 0);
  if (newBalance < 0) newBalance = 0;
  var res = _updateParty(
    type,
    id,
    { loyalty_points: newBalance },
    callerUser,
    true,
  );
  if (!res || !res.success) return res;
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  return { success: true, message: "تم تحديث رصيد النقاط", data: { loyalty_points: newBalance } };
}

/**
 * _getNextPartyInvoiceNumber — §BP-P5 توليد رقم الفاتورة التالي من المسلسل
 * الخاص بالعميل/المورد (بادئة + عداد) لو مفعّل has_custom_invoice_sequence.
 * ملحوظة: الدالة دي بترجع رقم منسّق للعرض/الطباعة فقط ولا تُستخدم حاليًا
 * كمعرف السجل الداخلي (id) — الفواتير لسه بتتعرّف داخليًا عبر makeId("SINV"/"PINV")
 * زي ما هي، تفاديًا لأي كسر في محرك الفواتير الحالي. ربطها الفعلي بشاشة
 * إنشاء الفاتورة (لعرض الرقم المخصص على الفاتورة المطبوعة) خطوة توسّع تالية.
 * @param {String} type
 * @param {String} id
 * @param {String} callerUser
 * @returns {String|null} الرقم المنسّق، أو null لو المسلسل الخاص غير مفعّل
 */
function _getNextPartyInvoiceNumber(type, id, callerUser) {
  var party = _getPartyById(type, id);
  if (!party || !party.has_custom_invoice_sequence) return null;
  var next = Number(party.invoice_sequence_next || 1);
  var formatted = String(party.invoice_sequence_prefix || "") + next;
  _updateParty(
    type,
    id,
    { invoice_sequence_next: next + 1 },
    callerUser,
    true,
  );
  return formatted;
}

function _partyHasUsage(type, id) {
  // [MD-02 FIX] فحص قبل الحذف: هل للطرف فواتير أو حركات في الأستاذ العام؟
  // كان _deleteParty يحذف الصف فعليًا (deleteRow) بدون أي فحص، مما يكسر
  // مرجعية الفواتير القديمة (party يشير لمعرف غير موجود) وكشف الحساب وتقرير
  // تقادم الديون وتكامل الحسابات — بخلاف باقي الكيانات (أصناف/مخازن/أصول) التي
  // كلها تستخدم حذف ناعم أو فحص استخدام قبل الحذف الفعلي.
  try {
    var invoiceSheet =
      type === "supplier" ? "PurchaseInvoices" : "SaleInvoices";
    var invoices = readSheet(invoiceSheet, []);
    // [AUDIT-FIX C1] كانت تقارن id الطرف بعمود "party" (اسم الطرف كنص حر
    // للعرض/البحث) بدل "party_id" (المعرف المستقر) — راجع تعريف الهيدرز
    // (SALE_INVOICE_HEADERS/PURCHASE_INVOICE_HEADERS) حيث "party" = اسم
    // للعرض و"party_id" = المعرف الفعلي. المقارنة الخاطئة كانت تجعل هذا
    // الفحص يرجع false دائمًا تقريبًا (id لا يساوي اسمًا نصيًا أبدًا إلا
    // صدفة)، فيسمح بحذف عميل/مورد له فواتير فعلية ويكسر مرجعيتها. نقارن
    // الآن على party_id (المعرف)، مع الإبقاء على مقارنة party (الاسم) كـ
    // fallback احتياطي لفواتير قديمة جدًا قد لا تحمل party_id.
    var hasInvoices = invoices.some(function (inv) {
      if (inv.party_id) return String(inv.party_id) === String(id);
      return String(inv.party || "") === String(id);
    });
    if (hasInvoices) return true;

    var lines = readSheet(
      "JournalEntryLines",
      ACCOUNTING_HR_HEADERS.JournalEntryLines,
    );
    var hasGLLines = lines.some(function (l) {
      return String(l.party_id || "") === String(id);
    });
    if (hasGLLines) return true;

    // [FIX-ISSUE-PARTY-2] الفحص السابق (فواتير + سطور GL) بيفترض إن أي سند
    // قبض/صرف بيولّد قيدًا تلقائيًا فيه party_id دايمًا. لو فشل إنشاء القيد
    // التلقائي لأي سبب (فترة مالية مغلقة، خطأ مؤقت...) بينما السند نفسه
    // اتحفظ، يبقى السند "يتيم" بلا قيد ولا يظهر في الفحص فوق — فيسمح بحذف
    // طرف له سند مرتبط فعليًا. هنا فحص مباشر إضافي على جداول السندات نفسها.
    var voucherChecks =
      type === "supplier"
        ? [{ sheet: "PaymentVouchers", headers: ACCOUNTING_HR_HEADERS.PaymentVouchers }]
        : [{ sheet: "ReceiptVouchers", headers: ACCOUNTING_HR_HEADERS.ReceiptVouchers }];
    var hasVouchers = voucherChecks.some(function (v) {
      var rows = readSheet(v.sheet, v.headers);
      return rows.some(function (r) {
        return (
          String(r.party_id || "") === String(id) && r.status !== "CANCELLED"
        );
      });
    });
    return hasVouchers;
  } catch (e) {
    // لو تعذّر الفحص لأي سبب، الأسلم اعتبار أن فيه استخدام ومنع الحذف الفعلي
    return true;
  }
}

function _deleteParty(type, id, callerUser, _skipSideEffects) {
  var sheetName = _getPartySheet(type);
  var repo = Repositories[type === "supplier" ? "Suppliers" : "Customers"];

  // [SL-MIGRATION] لو الاستدعاء جاي من ServiceLayer، فحص الاستخدام تم بالفعل
  // عبر BusinessRulesEngine.validateBeforeDelete (breCheck) قبل الوصول هنا —
  // لا داعي لتكرار _partyHasUsage. الاستدعاء المباشر القديم يظل يفحصها بنفسه.
  if (!_skipSideEffects && _partyHasUsage(type, id)) {
    return errResponse(
      "لا يمكن حذف " +
        (type === "supplier" ? "المورد" : "العميل") +
        " — مرتبط بفواتير أو حركات محاسبية فعلية. يمكن الإبقاء عليه بدون استخدامه مستقبلاً.",
    );
  }

  // [DOC-ENGINE][PHASE-5] قبل الحذف الفعلي، ننقل فولدر الطرف في Drive
  // (لو موجود) لفولدر Archive عام — بدل ما يفضل معلّق تحت "العملاء"/
  // "الموردون" بعد ما السجل نفسه بقى محذوف. فشل صامت تمامًا (نفس فلسفة
  // ensurePartyFolders في _addParty) — الحذف نفسه ميتأثرش لو Drive فشل
  // لأي سبب.
  if (!_skipSideEffects) {
    try {
      var partyRecordForArchive = readSheet(sheetName).find(function (r) {
        return String(r.id) === String(id);
      });
      if (partyRecordForArchive) {
        DocumentEngine.archivePartyFolder(
          type,
          String(partyRecordForArchive.code || "").trim(),
          String(partyRecordForArchive.name || "").trim(),
        );
      }
    } catch (e) {
      Logger.log("[_deleteParty] فشل أرشفة فولدر Drive: " + e.message);
    }
  }

  // [REPO-MIGRATION] كان بيعمل getDataRange + لوب يدوي بحثًا عن idCol —
  // RepositoryLayer.remove بيعمل نفس الحذف الفعلي (hard delete، لأن
  // Customers/Suppliers مالهمش deleted_at) لكن عبر getSheet() الموحّدة
  // (حماية + ترحيل أعمدة + قفل ضد التعارض) بدل الوصول المباشر للشيت.
  var res = repo.remove(id);
  if (!res.success) {
    return errResponse(
      res.errorCode === "NOT_FOUND" ? "السجل غير موجود" : "ورقة البيانات غير موجودة",
    );
  }
  if (_skipSideEffects) {
    // [SL-MIGRATION] راجع نفس الملاحظة في _addParty أعلاه.
    return { success: true, message: "تم الحذف بنجاح" };
  }
  // [AUDIT-FIX] راجع نفس الملاحظة في _addParty أعلاه.
  AuditEngine.log(type === "customer" ? "deleteCustomer" : "deleteSupplier", {
    user: callerUser,
    table: sheetName,
    record_id: id});
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  return { success: true, message: "تم الحذف بنجاح" };
}

// §CAT-P1 — كتابة مباشرة لعمود category_id فقط (بدون إعادة بناء باقي الحقول)
// تُستخدم من Code_28_PartyCategories.gs عند حذف تصنيف وإعادة تعيين
// العملاء/الموردين المرتبطين به لتصنيف آخر (أو تفريغه) — تبسيطًا وتفاديًا
// لأي مخاطر لاحقة، رغم أن _updateParty بقى فيها الآن fallback للحقول
// الأساسية (name/phone/email/...) بعد [BUG-FIX] أعلاه.
function _setPartyCategoryId(type, partyId, categoryId, callerUser) {
  var headers = _getPartyHeaders(type);
  if (headers.indexOf("category_id") === -1) {
    return errResponse("عمود التصنيف غير موجود");
  }
  var repo = Repositories[type === "supplier" ? "Suppliers" : "Customers"];
  // [REPO-MIGRATION] كان بيعمل getDataRange + لوب يدوي على idCol/catCol —
  // RepositoryLayer.update بيعمل نفس التحديث الجزئي (fallback تلقائي لكل
  // حقل تاني غير مرسل) عبر getSheet() الموحّدة.
  var res = repo.update(partyId, { category_id: categoryId || "" });
  if (!res.success) return errResponse("السجل غير موجود");
  _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
  return { success: true, message: "تم تحديث تصنيف الطرف" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// §BP-P3  عناوين متعددة للأطراف (Multiple Addresses) — Customers & Suppliers
// ═══════════════════════════════════════════════════════════════════════════════
// شيت مشترك واحد PartyAddresses (بدل شيت منفصل لكل نوع) — كل صف مرتبط بـ
// party_id + party_type. الحقل النصي الحر "address" الموجود بالفعل في شيت
// العميل/المورد نفسه يبقى كما هو (fallback/توافق خلفي) — لا يُحذف ولا يُمس.
// ملاحظة: مُصمَّمة لتُستخدم لاحقًا من شاشة الشحن (عنوان شحن) والفواتير
// (عنوان فاتورة) عبر getDefaultPartyAddress — الربط الفعلي في تلك الشاشتين
// خارج نطاق هذه المرحلة (P3) نفسها.

var PARTY_ADDRESSES_SHEET = "PartyAddresses";
var PARTY_ADDRESS_TYPES = ["رئيسي", "شحن", "فواتير", "آخر"];

var PARTY_ADDRESS_HEADERS = [
  "id",
  "party_id",
  "party_type", // customer | supplier
  "name", // اسم مميز للعنوان (اختياري) — مثال: "الفرع الرئيسي"
  "address_type", // رئيسي | شحن | فواتير | آخر
  "country",
  "governorate",
  "city",
  "district",
  "street",
  "building",
  "floor",
  "postal_code",
  "maps_url", // رابط خرائط جوجل
  "notes",
  "is_default", // Boolean — افتراضي لنوعه (address_type) لدى هذا الطرف
  "created_at",
  "updated_at",
];

function _ensurePartyAddressesSheet() {
  try {
    // [REPO-MIGRATION] راجع نفس ملاحظة _ensurePartySheet أعلاه.
    getSheet(PARTY_ADDRESSES_SHEET, PARTY_ADDRESS_HEADERS);
  } catch (e) {
    // تجاهل لو مش قادر ينشئ — نفس نمط _ensurePartySheet
  }
}

function _genPartyAddressId() {
  return "ADDR-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
}

function _readPartyAddresses(partyId, partyType) {
  try {
    var rows = cleanArr(
      readSheet(PARTY_ADDRESSES_SHEET, PARTY_ADDRESS_HEADERS),
    );
    return rows.filter(function (r) {
      return (
        String(r.party_id || "") === String(partyId) &&
        (!partyType || String(r.party_type || "") === String(partyType))
      );
    });
  } catch (e) {
    _ensurePartyAddressesSheet();
    return [];
  }
}

// ── getPartyAddresses ────────────────────────────────────────────────────────

function getPartyAddresses(callerUser, partyId, partyType) {
  try {
    if (!partyId) return errResponse("معرف الطرف مطلوب");
    var type = partyType === "supplier" ? "supplier" : "customer";
    if (callerUser)
      _requirePermission(
        callerUser,
        type === "supplier" ? "viewSuppliers" : "viewCustomers",
      );
    var rows = _readPartyAddresses(partyId, type);
    // ترتيب: الافتراضي أولاً، ثم الأحدث
    rows.sort(function (a, b) {
      if (!!a.is_default !== !!b.is_default) return a.is_default ? -1 : 1;
      return String(b.created_at || "").localeCompare(
        String(a.created_at || ""),
      );
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب العناوين: " + e.message);
  }
}

// ── addPartyAddress ──────────────────────────────────────────────────────────

function addPartyAddress(callerUser, data) {
  try {
    data = data || {};
    var type = data.party_type === "supplier" ? "supplier" : "customer";
    _requirePermission(
      callerUser,
      type === "supplier" ? "updateSupplier" : "updateCustomer",
    );
    if (!data.party_id) return errResponse("معرف الطرف مطلوب");

    _ensurePartyAddressesSheet();
    var now = new Date().toISOString();
    var id = _genPartyAddressId();
    var addrType =
      PARTY_ADDRESS_TYPES.indexOf(data.address_type) !== -1
        ? data.address_type
        : "آخر";

    var fieldMap = {
      id: id,
      party_id: String(data.party_id),
      party_type: type,
      name: String(data.name || "").trim(),
      address_type: addrType,
      country: String(data.country || "").trim(),
      governorate: String(data.governorate || "").trim(),
      city: String(data.city || "").trim(),
      district: String(data.district || "").trim(),
      street: String(data.street || "").trim(),
      building: String(data.building || "").trim(),
      floor: String(data.floor || "").trim(),
      postal_code: String(data.postal_code || "").trim(),
      maps_url: String(data.maps_url || "").trim(),
      notes: String(data.notes || "").trim(),
      is_default: !!data.is_default,
      created_at: now,
      updated_at: now,
    };
    // [REPO-MIGRATION] كان بيبني الصف يدويًا ويستدعي _appendRowProtected
    // مباشرة — دلوقتي عبر RepositoryLayer.create (نفس القيم، نفس الحماية،
    // زائد قفل ضد التعارض من getSheet() الموحّدة).
    Repositories.PartyAddresses.create(fieldMap);

    if (fieldMap.is_default) {
      _clearOtherDefaultAddresses(data.party_id, type, addrType, id);
    }

    AuditEngine.log("addPartyAddress", {
      user: callerUser,
      table: PARTY_ADDRESSES_SHEET,
      record_id: id,
      details: "عنوان جديد (" + addrType + ") لـ " + data.party_id});
    _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return {
      success: true,
      message: "تمت إضافة العنوان بنجاح",
      data: { id: id },
    };
  } catch (e) {
    return errResponse(e.message);
  }
}

// ── updatePartyAddress ───────────────────────────────────────────────────────

function updatePartyAddress(callerUser, id, data) {
  try {
    data = data || {};
    var type = data.party_type === "supplier" ? "supplier" : "customer";
    _requirePermission(
      callerUser,
      type === "supplier" ? "updateSupplier" : "updateCustomer",
    );

    _ensurePartyAddressesSheet();
    var currentRes = Repositories.PartyAddresses.getById(id);
    if (!currentRes.success || !currentRes.data) {
      return errResponse("العنوان غير موجود");
    }
    var now = new Date().toISOString();
    var addrType =
      PARTY_ADDRESS_TYPES.indexOf(data.address_type) !== -1
        ? data.address_type
        : "آخر";
    // [REPO-MIGRATION] id/party_id/created_at مش موجودين في الـ patch —
    // RepositoryLayer.update بيحافظ عليهم تلقائيًا من السجل الحالي، بالظبط
    // زي ما كان بيحصل يدويًا (vals[i][partyIdCol], vals[i][createdAtCol]).
    var patch = {
      party_type: type,
      name: String(data.name || "").trim(),
      address_type: addrType,
      country: String(data.country || "").trim(),
      governorate: String(data.governorate || "").trim(),
      city: String(data.city || "").trim(),
      district: String(data.district || "").trim(),
      street: String(data.street || "").trim(),
      building: String(data.building || "").trim(),
      floor: String(data.floor || "").trim(),
      postal_code: String(data.postal_code || "").trim(),
      maps_url: String(data.maps_url || "").trim(),
      notes: String(data.notes || "").trim(),
      is_default: !!data.is_default,
      updated_at: now,
    };
    var upRes = Repositories.PartyAddresses.update(id, patch);
    if (!upRes.success) return errResponse("العنوان غير موجود");

    if (patch.is_default) {
      _clearOtherDefaultAddresses(currentRes.data.party_id, type, addrType, id);
    }

    AuditEngine.log("updatePartyAddress", {
      user: callerUser,
      table: PARTY_ADDRESSES_SHEET,
      record_id: id});
    _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return { success: true, message: "تم تعديل العنوان بنجاح" };
  } catch (e) {
    return errResponse(e.message);
  }
}

// ── deletePartyAddress ───────────────────────────────────────────────────────

function deletePartyAddress(callerUser, id, partyType) {
  try {
    var type = partyType === "supplier" ? "supplier" : "customer";
    _requirePermission(
      callerUser,
      type === "supplier" ? "updateSupplier" : "updateCustomer",
    );

    _ensurePartyAddressesSheet();
    // [REPO-MIGRATION] PartyAddresses مالهاش deleted_at في الـ headers، يعني
    // RepositoryLayer.remove هيعمل hard delete فعلي — نفس سلوك deleteRow القديم.
    var res = Repositories.PartyAddresses.remove(id);
    if (!res.success) return errResponse("العنوان غير موجود");
    AuditEngine.log("deletePartyAddress", {
      user: callerUser,
      table: PARTY_ADDRESSES_SHEET,
      record_id: id});
    _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return { success: true, message: "تم حذف العنوان بنجاح" };
  } catch (e) {
    return errResponse(e.message);
  }
}

// ── setDefaultPartyAddress ───────────────────────────────────────────────────
// تعيين عنوان كافتراضي لنوعه (address_type) لدى نفس الطرف، وإلغاء الافتراضي
// عن أي عنوان آخر بنفس النوع لنفس الطرف تلقائيًا (اتساق: افتراضي واحد فقط
// لكل نوع عنوان لكل طرف).

function setDefaultPartyAddress(
  callerUser,
  id,
  partyId,
  partyType,
  addressType,
) {
  try {
    var type = partyType === "supplier" ? "supplier" : "customer";
    _requirePermission(
      callerUser,
      type === "supplier" ? "updateSupplier" : "updateCustomer",
    );
    _ensurePartyAddressesSheet();
    var matches = Repositories.PartyAddresses.find({
      party_id: String(partyId),
      address_type: String(addressType),
    });
    var rows = (matches.success && matches.data) || [];
    var found = rows.some(function (r) {
      return String(r.id) === String(id);
    });

    var patches = rows.map(function (r) {
      return { id: r.id, patch: { is_default: String(r.id) === String(id) } };
    });
    if (patches.length) Repositories.PartyAddresses.bulkUpdate(patches);

    if (!found) return errResponse("العنوان غير موجود");

    AuditEngine.log("setDefaultPartyAddress", {
      user: callerUser,
      table: PARTY_ADDRESSES_SHEET,
      record_id: id});
    _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return { success: true, message: "تم تعيين العنوان الافتراضي" };
  } catch (e) {
    return errResponse(e.message);
  }
}

function _clearOtherDefaultAddresses(partyId, partyType, addressType, keepId) {
  try {
    // [REPO-MIGRATION] كان بيعمل getDataRange + لوب يدوي — دلوقتي find()
    // على العناوين المطابقة (باستثناء keepId) وbulkUpdate لمسح is_default عنها.
    var matches = Repositories.PartyAddresses.find({
      party_id: String(partyId),
      address_type: String(addressType),
    });
    var rows = (matches.success && matches.data) || [];
    var patches = rows
      .filter(function (r) {
        return String(r.id) !== String(keepId);
      })
      .map(function (r) {
        return { id: r.id, patch: { is_default: false } };
      });
    if (patches.length) Repositories.PartyAddresses.bulkUpdate(patches);
  } catch (e) {
    // تجاهل — لن يمنع الحفظ الأساسي من النجاح
  }
}

// ── getDefaultPartyAddress ───────────────────────────────────────────────────
// Hook جاهز لاستخدام لاحق من شاشة الشحن (عنوان شحن افتراضي) والفواتير
// (عنوان فاتورة افتراضي) — راجع ملاحظة "يمس" في خريطة الطريق BP-ROADMAP.md.
// لو مفيش عنوان افتراضي محدَّد صراحةً، يرجع أول عنوان من نفس النوع كـ fallback.

function getDefaultPartyAddress(partyId, partyType, addressType) {
  try {
    var wanted =
      PARTY_ADDRESS_TYPES.indexOf(addressType) !== -1 ? addressType : "شحن";
    var rows = _readPartyAddresses(partyId, partyType);
    var sameType = rows.filter(function (r) {
      return r.address_type === wanted;
    });
    var match = sameType.find(function (r) {
      return r.is_default === true;
    });
    return match || sameType[0] || null;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// نهاية §BP-P3  عناوين متعددة للأطراف
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §BP-P5  مستندات الأطراف (Party Documents) — Customers & Suppliers
// ═══════════════════════════════════════════════════════════════════════════════
// شيت مشترك واحد PartyDocuments (بنفس منطق PartyAddresses في P3) — كل صف
// مرتبط بـ party_id + party_type، فيبقى متوافق تلقائيًا مع أي توحيد مستقبلي
// لـ BusinessPartners (P8) بدون أي تعديل بنيوي، غير تحديث party_id.
// التخزين الفعلي للملف يتم على Google Drive عبر uploadPartyDocument()
// (Code_21_Setup.gs) في فولدر منفصل PartyDocuments/{party_id} — قرار اتحسم
// مع محمد بدل مشاركة نفس فولدر اللوجوهات، عشان التنظيم.

var PARTY_DOCUMENTS_SHEET = "PartyDocuments";
var PARTY_DOCUMENT_TYPES = [
  "سجل تجاري",
  "بطاقة ضريبية",
  "هوية/بطاقة",
  "عقد",
  "آخر",
];

var PARTY_DOCUMENT_HEADERS = [
  "id",
  "party_id",
  "party_type", // customer | supplier
  "doc_type", // سجل تجاري | بطاقة ضريبية | هوية/بطاقة | عقد | آخر
  "file_name",
  "file_url",
  "uploaded_by",
  "uploaded_at",
  "notes",
];

function _ensurePartyDocumentsSheet() {
  try {
    // [REPO-MIGRATION] راجع نفس ملاحظة _ensurePartySheet أعلاه.
    getSheet(PARTY_DOCUMENTS_SHEET, PARTY_DOCUMENT_HEADERS);
  } catch (e) {
    // تجاهل لو مش قادر ينشئ — نفس نمط _ensurePartyAddressesSheet
  }
}

function _genPartyDocumentId() {
  return "PDOC-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
}

function _readPartyDocuments(partyId, partyType) {
  try {
    var rows = cleanArr(
      readSheet(PARTY_DOCUMENTS_SHEET, PARTY_DOCUMENT_HEADERS),
    );
    return rows.filter(function (r) {
      return (
        String(r.party_id || "") === String(partyId) &&
        (!partyType || String(r.party_type || "") === String(partyType))
      );
    });
  } catch (e) {
    _ensurePartyDocumentsSheet();
    return [];
  }
}

// ── getPartyDocuments ────────────────────────────────────────────────────────

function getPartyDocuments(callerUser, partyId, partyType) {
  try {
    if (!partyId) return errResponse("معرف الطرف مطلوب");
    var type = partyType === "supplier" ? "supplier" : "customer";
    if (callerUser)
      _requirePermission(
        callerUser,
        type === "supplier" ? "viewSuppliers" : "viewCustomers",
      );
    var rows = _readPartyDocuments(partyId, type);
    // الأحدث أولاً
    rows.sort(function (a, b) {
      return String(b.uploaded_at || "").localeCompare(
        String(a.uploaded_at || ""),
      );
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب المستندات: " + e.message);
  }
}

// ── addPartyDocument ─────────────────────────────────────────────────────────
// يُستدعى بعد نجاح الرفع الفعلي على Drive عبر uploadPartyDocument() — هذه
// الدالة بترجّل سجل الميتاداتا في الشيت بس (نفس تقسيم مسؤوليات uploadFile
// و addPartyAddress في الأنماط الحالية).

function addPartyDocument(callerUser, data) {
  try {
    data = data || {};
    var type = data.party_type === "supplier" ? "supplier" : "customer";
    _requirePermission(
      callerUser,
      type === "supplier" ? "updateSupplier" : "updateCustomer",
    );
    if (!data.party_id) return errResponse("معرف الطرف مطلوب");
    if (!data.file_url) return errResponse("رابط الملف مطلوب");

    _ensurePartyDocumentsSheet();
    var now = new Date().toISOString();
    var id = _genPartyDocumentId();
    var docType =
      PARTY_DOCUMENT_TYPES.indexOf(data.doc_type) !== -1
        ? data.doc_type
        : "آخر";

    var fieldMap = {
      id: id,
      party_id: String(data.party_id),
      party_type: type,
      doc_type: docType,
      file_name: String(data.file_name || "").trim(),
      file_url: String(data.file_url || "").trim(),
      uploaded_by: String(callerUser || ""),
      uploaded_at: now,
      notes: String(data.notes || "").trim(),
    };
    // [REPO-MIGRATION] استبدال بناء الصف اليدوي + _appendRowProtected
    // المباشر بـ RepositoryLayer.create.
    Repositories.PartyDocuments.create(fieldMap);

    AuditEngine.log("addPartyDocument", {
      user: callerUser,
      table: PARTY_DOCUMENTS_SHEET,
      record_id: id,
      details: "مستند جديد (" + docType + ") لـ " + data.party_id});
    _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return {
      success: true,
      message: "تمت إضافة المستند بنجاح",
      data: { id: id },
    };
  } catch (e) {
    return errResponse(e.message);
  }
}

// ── deletePartyDocument ──────────────────────────────────────────────────────
// بتحذف سجل الميتاداتا من الشيت فقط (نفس نمط deletePartyAddress) — ملف
// Drive نفسه بيفضل موجود (نفس سلوك حذف اللوجو الحالي، مفيش حذف تلقائي من
// Drive حاليًا في أي مكان بالنظام).

function deletePartyDocument(callerUser, id, partyType) {
  try {
    var type = partyType === "supplier" ? "supplier" : "customer";
    _requirePermission(
      callerUser,
      type === "supplier" ? "updateSupplier" : "updateCustomer",
    );

    _ensurePartyDocumentsSheet();
    // [REPO-MIGRATION] PartyDocuments مالهاش deleted_at، يعني hard delete
    // فعلي زي deleteRow القديم بالظبط.
    var res = Repositories.PartyDocuments.remove(id);
    if (!res.success) return errResponse("المستند غير موجود");
    AuditEngine.log("deletePartyDocument", {
      user: callerUser,
      table: PARTY_DOCUMENTS_SHEET,
      record_id: id});
    _invalidateServerCacheParties(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return { success: true, message: "تم حذف المستند بنجاح" };
  } catch (e) {
    return errResponse(e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// نهاية §BP-P5  مستندات الأطراف
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// نهاية §EXT-22  Parties
// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 26742-28913] Invoices + Returns ┄┄┄
