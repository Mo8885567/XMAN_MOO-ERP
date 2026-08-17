// ════════════════════════════════════════════════════════════════
// Code_PostingConfig.gs — [REFACTOR-P4] نُقل من Code_Accounting.gs (نقل نصي بحت،
// صفر تغيير في المنطق). كل ملفات .gs في نفس الـ Global Scope فعليًا،
// فنقل الدوال هنا لا يكسر أي استدعاء طالما الأسماء لم تتغير.
// راجع تقرير Architecture Audit 2026-07-03 — المرحلة 4.
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 22568-23255] Posting Configuration Engine ┄┄┄
// §POSTING-CONFIG  محرك إعدادات الترحيل الموحد (Posting Configuration Engine)
// ────────────────────────────────────────────────────────────────────────────
// قائمة جامعة بجميع مفاتيح الحسابات المستخدمة في النظام.
// هذه القائمة هي المرجع الوحيد — لا يُسمح بكتابة أي رقم حساب داخل الكود.
// جميع القيود التلقائية تستدعي _getDefaultAccount(key, ...) بالرجوع لهذه المفاتيح.
// ════════════════════════════════════════════════════════════════════════════
var POSTING_CONFIG_KEYS = [
  // ── ذمم ونقديات ──
  {
    key: "ar_account",
    label: "حساب العملاء (ذمم مدينة)",
    type: "ASSET",
    hints: ["ذمم مدينة", "عملاء", "accounts receivable", "مدينين"],
  },
  {
    key: "ap_account",
    label: "حساب الموردين (ذمم دائنة)",
    type: "LIABILITY",
    hints: ["ذمم دائنة", "موردين", "accounts payable", "دائنة"],
  },
  {
    key: "grni_account",
    label: "حساب بضاعة مستلمة غير مفوترة (GRNI)",
    type: "LIABILITY",
    hints: [
      "بضاعة مستلمة غير مفوترة",
      "GRNI",
      "goods received not invoiced",
    ],
  },
  {
    key: "cash_account",
    label: "حساب الصندوق الرئيسي",
    type: "ASSET",
    hints: ["الصندوق", "خزينة رئيسية", "cash", "صندوق"],
  },
  {
    key: "mobile_wallet_account",
    label: "حساب المحافظ الإلكترونية (فودافون كاش/أورنج/انستاباي...)",
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
  },
  // ── مبيعات ومشتريات ──
  {
    key: "revenue_account",
    label: "حساب إيرادات المبيعات",
    type: "REVENUE",
    hints: ["إيرادات المبيعات", "مبيعات", "sales revenue", "إيرادات"],
  },
  {
    key: "purchase_account",
    label: "حساب المشتريات",
    type: "EXPENSE",
    hints: ["المشتريات", "مشتريات", "purchases", "تكلفة البضاعة"],
  },
  {
    key: "cogs_account",
    label: "حساب تكلفة البضاعة المباعة (COGS)",
    type: "EXPENSE",
    hints: ["تكلفة البضاعة المباعة", "تكلفة المبيعات", "تكلفة", "cogs"],
  },
  {
    key: "sales_return_account",
    label: "حساب مردودات المبيعات (خصم)",
    type: "REVENUE",
    hints: ["مردودات المبيعات", "مرتجع مبيعات", "sales return"],
  },
  // ── خصومات ──
  {
    key: "sales_discount_account",
    label: "حساب الخصم الممنوح (مبيعات)",
    type: "EXPENSE",
    hints: ["خصم مسموح به", "خصم ممنوح", "خصم مبيعات", "sales discount"],
  },
  {
    key: "purchase_discount_account",
    label: "حساب الخصم المكتسب (مشتريات)",
    type: "REVENUE",
    hints: ["خصم مكتسب", "خصم موردين", "purchase discount"],
  },
  // ── ضرائب ──
  {
    key: "vat_output_account",
    label: "ضريبة القيمة المضافة — مبيعات (دائن)",
    type: "LIABILITY",
    hints: ["ضريبة القيمة المضافة", "ضريبة مبيعات", "vat output", "VAT"],
  },
  {
    key: "vat_input_account",
    label: "ضريبة القيمة المضافة — مشتريات (مدين)",
    type: "ASSET",
    hints: ["ضريبة قيمة مضافة — مشتريات", "ضريبة مشتريات", "vat input"],
  },
  // ── مخزون ──
  {
    key: "inventory_account",
    label: "حساب المخزون",
    type: "ASSET",
    hints: ["مخزون", "بضاعة", "inventory", "stock"],
  },
  {
    // [FIX-POSTING-AUDIT §4 — 2026-08-10] هذا المفتاح كان مسجَّلاً هنا وظاهراً
    // بشاشة الإعدادات، لكن قيود فروق الجرد والتسويات المخزنية الفعلية كانت
    // تستخدم مفتاحين منفصلين غير مسجَّلين هنا (adjustment_account،
    // stocktake_variance_account) فلا يستطيع المستخدم تثبيتهما يدوياً — تم
    // توحيد الكل على هذا المفتاح (راجع Code_03_Accounting_Costing.js و
    // Code_20c_Invoices.js). الـ hints تغطي الآن الأسماء القديمة كذلك.
    key: "inventory_variance_account",
    label: "حساب فروقات الجرد والتسويات المخزنية",
    type: "EXPENSE",
    hints: [
      "فروقات جرد",
      "تسوية مخزون",
      "inventory variance",
      "عجز",
      "تسوية",
      "adjustment",
      "فروق",
      "stocktake variance",
    ],
  },
  {
    key: "wip_account",
    label: "حساب تحت التشغيل (WIP)",
    type: "ASSET",
    hints: ["تحت التشغيل", "wip", "إنتاج تحت التشغيل"],
  },
  // [FIX-POSTING-AUDIT §4 — 2026-08-10] كان مستخدَماً فعلياً في
  // Code_02_Accounting_ChartOfAccounts.js (ترحيل الأرصدة الافتتاحية) عبر
  // _getDefaultAccount مباشرة، لكنه لم يكن مسجَّلاً في هذه القائمة الرئيسية.
  {
    key: "equity_account",
    label: "حساب رأس المال / حقوق الملكية (للأرصدة الافتتاحية)",
    type: "EQUITY",
    hints: ["رأس المال", "حقوق الملكية", "equity", "capital"],
  },
  // [FIX-POSTING-AUDIT §4 — 2026-08-10] كان مستخدَماً فعلياً في
  // Code_04_Accounting_JournalEntries.js (عمولة التحويل البنكي) عبر
  // _getDefaultAccount مباشرة، وعند غيابه كانت العملية بالكامل تفشل بخطأ
  // (throw) بدل مجرد تجاهل — تسجيله هنا يسمح للمستخدم بتثبيته يدوياً.
  {
    key: "bank_fees_account",
    label: "حساب المصروفات/العمولات البنكية",
    type: "EXPENSE",
    hints: [
      "مصروفات بنكية",
      "عمولات بنكية",
      "رسوم بنكية",
      "bank charges",
      "bank fees",
    ],
  },
  // ── رواتب وموارد بشرية ──
  {
    key: "salary_expense_account",
    label: "حساب مصروف الرواتب والأجور",
    type: "EXPENSE",
    hints: ["رواتب", "أجور", "عمالة", "salary", "wages", "payroll"],
  },
  {
    key: "salary_payable_account",
    label: "حساب الرواتب المستحقة (التزام)",
    type: "LIABILITY",
    hints: [
      "رواتب مستحقة",
      "مستحقة الصرف",
      "salary payable",
      "payroll payable",
    ],
  },
  {
    key: "loan_account",
    label: "حساب السلف والقروض للموظفين",
    type: "ASSET",
    hints: ["سلف موظفين", "قروض موظفين", "employee loans", "advances"],
  },
  // [FIX-POSTING-AUDIT §3] كانت هذه المفاتيح الثلاثة مستخدَمة فعلياً داخل
  // محرك ترحيل الرواتب (_autoJournalFromPayroll) عبر _getDefaultAccount
  // مباشرة، لكنها لم تكن مسجَّلة في هذه القائمة الرئيسية — فلم تكن تظهر
  // إطلاقاً في شاشة "إعدادات الترحيل المحاسبي" ليثبّتها المستخدم يدوياً،
  // واعتمدت كلياً على الاكتشاف التلقائي بالاسم. تسجيلها هنا يجعلها قابلة
  // للمراجعة والتثبيت من نفس الشاشة الموحّدة كباقي مفاتيح النظام.
  {
    key: "tax_payable_account",
    label: "حساب الضرائب المستحقة على الرواتب",
    type: "LIABILITY",
    hints: ["ضرائب مستحقة", "ضريبة مستحقة", "tax payable"],
  },
  {
    key: "insurance_payable_account",
    label: "حساب التأمينات الاجتماعية المستحقة",
    type: "LIABILITY",
    hints: [
      "تأمينات مستحقة",
      "تأمين اجتماعي مستحق",
      "insurance payable",
      "social insurance payable",
    ],
  },
  {
    key: "other_payroll_deductions_account",
    label: "حساب استقطاعات الرواتب الأخرى المستحقة",
    type: "LIABILITY",
    hints: ["خصومات مستحقة", "استقطاعات مستحقة", "other payroll deductions"],
  },
  // [FIX-POSTING-AUDIT §4 — 2026-08-10] كانا مستخدَمين فعلياً داخل نفس هذا
  // الملف (_autoJournalFromPayroll، حصة صاحب العمل في التأمينات) عبر
  // _getDefaultAccount مباشرة، لكنهما لم يكونا مسجَّلين في هذه القائمة
  // الرئيسية — فلم يكونا يظهران بشاشة إعدادات الترحيل ليثبّتهما المستخدم.
  {
    key: "employer_insurance_expense_account",
    label: "حساب مصروف تأمينات صاحب العمل",
    type: "EXPENSE",
    hints: [
      "تأمينات صاحب العمل",
      "مصروف تأمينات",
      "employer social insurance",
      "employer insurance expense",
    ],
  },
  {
    key: "employer_insurance_payable_account",
    label: "حساب تأمينات صاحب العمل المستحقة",
    type: "LIABILITY",
    hints: [
      "تأمينات مستحقة - حصة صاحب عمل",
      "تأمينات مستحقة صاحب العمل",
      "employer insurance payable",
    ],
  },
  // ── شحن ──
  // [FIX-POSTING-AUDIT §3] كانت مستخدَمة في Code_22_Shipping.js عبر
  // resolvePostingAccount لكنها غائبة عن هذه القائمة لنفس السبب أعلاه.
  {
    key: "shipping_expense_account",
    label: "حساب مصروف الشحن (افتراضي)",
    type: "EXPENSE",
    hints: ["مصروف شحن", "مصاريف شحن", "shipping expense", "freight"],
  },
  {
    key: "shipping_revenue_account",
    label: "حساب إيراد الشحن المحمَّل على العميل",
    type: "REVENUE",
    hints: ["إيراد شحن", "شحن محمل على العميل", "shipping revenue"],
  },
  // ── أصول ثابتة وإهلاك ──
  {
    key: "fixed_asset_account",
    label: "حساب الأصول الثابتة",
    type: "ASSET",
    hints: ["أصول ثابتة", "fixed assets", "ممتلكات ومعدات"],
  },
  {
    key: "depreciation_expense_account",
    label: "حساب مصروف الإهلاك",
    type: "EXPENSE",
    hints: ["إهلاك", "اهتلاك", "depreciation expense"],
  },
  {
    key: "accumulated_depreciation_account",
    label: "حساب مجمع الإهلاك",
    type: "ASSET",
    hints: ["مجمع الإهلاك", "accumulated depreciation"],
  },
  // ── حقوق الملكية ──
  {
    key: "opening_balance_equity_account",
    label: "حساب الأرصدة الافتتاحية",
    type: "EQUITY",
    hints: [
      "الأرباح المرحلة",
      "أرباح مرحلة",
      "retained earnings",
      "رصيد افتتاحي",
      "الأرصدة الإفتتاحية",
    ],
  },
  {
    key: "retained_earnings_account",
    label: "حساب الأرباح المبقاة",
    type: "EQUITY",
    hints: ["أرباح مبقاة", "retained earnings", "أرباح مرحلة"],
  },
  // ── §MFG-P0  التصنيع (Manufacturing) — راجع تقرير التصميم للتفاصيل الكاملة ──
  {
    key: "manufacturing_overhead_account",
    label: "حساب مصاريف التصنيع غير المباشرة (Overhead)",
    type: "EXPENSE",
    hints: ["مصروفات تصنيع أخرى", "overhead", "أوفرهيد", "مصاريف غير مباشرة"],
  },
  {
    key: "production_labor_account",
    label: "حساب أجور الإنتاج (تحت التشغيل)",
    type: "EXPENSE",
    hints: ["أجور إنتاج", "production wages", "أجر قطعة"],
  },
  {
    key: "machine_cost_account",
    label: "حساب تكلفة تشغيل الآلات",
    type: "EXPENSE",
    hints: ["تكلفة آلات", "machine cost", "تشغيل معدات"],
  },
  {
    key: "subcontract_cost_account",
    label: "حساب تكلفة التصنيع لدى الغير",
    type: "EXPENSE",
    hints: ["تصنيع لدى الغير", "subcontract", "مقاولة تصنيع"],
  },
  {
    key: "finished_goods_account",
    label: "حساب مخزون البضاعة التامة الصنع",
    type: "ASSET",
    hints: ["بضاعة تامة", "منتج نهائي", "finished goods"],
  },
  {
    key: "scrap_waste_account",
    label: "حساب هالك/راكد الإنتاج",
    type: "EXPENSE",
    hints: ["هالك إنتاج", "راكد", "scrap", "waste"],
  },
  {
    key: "cost_variance_account",
    label: "حساب فروقات تكلفة التصنيع",
    type: "EXPENSE",
    hints: ["فروقات تكلفة", "cost variance", "انحراف تكلفة"],
  },
  {
    // [ITEM-POSTING-WIRE-GAP-FIX-2026-08-08] أُضيف لأن Code_09_Banking.js
    // كان بيختار "أول حساب EXPENSE نشط" عشوائياً (accounts.find بدون key/
    // hints) لصرف شيكات صادرة بدون مورد محدد — مخالفة صريحة لقاعدة "ممنوع
    // الاعتماد على أول نتيجة/اسم فقط". دلوقتي عندها مفتاح ترحيل رسمي زي
    // باقي الأدوار.
    key: "general_expense_account",
    label: "حساب المصروفات العامة (افتراضي لعمليات بدون تصنيف)",
    type: "EXPENSE",
    hints: ["مصروفات عامة", "مصروفات متنوعة", "general expense", "misc expense"],
  },

  // [PC-XMAN-SCREEN-2026-08-08] المفاتيح التالية أُضيفت لمطابقة شاشة
  // "ثوابت الحسابات" المرجعية (تصميم X-MAN) — نفس تقسيم الأقسام والترتيب
  // المستخدَم في الواجهة (راجع PC_GROUPS في 23_JS_PostingConfig_FixedAssets.html).

  // ── بيانات أساسية ──
  {
    key: "capital_account",
    label: "رأس المال",
    type: "EQUITY",
    hints: ["رأس المال", "capital"],
  },
  {
    key: "branch_cash_transfer_account",
    label: "تحويل النقدية بين الفروع",
    type: "ASSET",
    hints: ["النقدية بين الفروع", "branch transfer"],
  },

  // ── حسابات النقدية والبنوك ──
  {
    key: "treasury_account",
    label: "الخزينة",
    type: "ASSET",
    hints: ["الخزينة", "treasury"],
  },
  {
    key: "bank_account",
    label: "البنوك",
    type: "ASSET",
    hints: ["البنوك", "بنك", "bank"],
  },
  {
    key: "employee_cash_custody_account",
    label: "عهدة الموظفين النقدية",
    type: "ASSET",
    hints: ["عهد الموظفين", "employee custody"],
  },
  {
    key: "notes_receivable_account",
    label: "أوراق قبض",
    type: "ASSET",
    hints: ["أوراق قبض", "notes receivable"],
  },
  {
    key: "notes_payable_account",
    label: "أوراق دفع",
    type: "LIABILITY",
    hints: ["أوراق الدفع", "notes payable"],
  },
  {
    key: "checks_under_collection_account",
    label: "شيكات تحت التحصيل",
    type: "ASSET",
    hints: ["تحت التحصيل", "checks under collection"],
  },
  {
    key: "bank_notices_account",
    label: "الاشعارات البنكية",
    type: "ASSET",
    hints: ["اشعارات بنكية", "bank notices"],
  },
  {
    key: "documentary_credits_account",
    label: "الاعتمادات المستندية",
    type: "LIABILITY",
    hints: ["اعتمادات مستنديه", "documentary credits"],
  },
  {
    key: "visa_account",
    label: "الفيزا",
    type: "ASSET",
    hints: ["الفيزا", "visa"],
  },
  {
    key: "visa_commission_account",
    label: "عمولات الفيزا",
    type: "EXPENSE",
    hints: ["عمولات فيزا", "visa commission"],
  },
  {
    key: "returned_checks_portfolio_account",
    label: "حافظة الشيكات المرتجعة",
    type: "ASSET",
    hints: ["شيكات مرتجعة", "returned checks"],
  },
  {
    key: "accrued_collection_revenue_account",
    label: "إيرادات مستحقة التحصيل",
    type: "ASSET",
    hints: ["إيرادات مستحقة التحصيل", "accrued revenue"],
  },
  {
    key: "discount_coupons_account",
    label: "كوبونات الخصم",
    type: "LIABILITY",
    hints: ["كوبونات الخصم", "discount coupons"],
  },

  // ── العملاء والموردين ──
  {
    key: "customers_account",
    label: "العملاء",
    type: "ASSET",
    hints: ["العملاء", "customers"],
  },
  {
    key: "suppliers_account",
    label: "الموردين",
    type: "LIABILITY",
    hints: ["موردون", "suppliers"],
  },
  {
    key: "clients_account",
    label: "الزبائن",
    type: "ASSET",
    hints: ["الزبائن", "clients"],
  },
  {
    key: "other_parties_account",
    label: "جهات أخرى",
    type: "ASSET",
    hints: ["جهات أخرى", "other parties"],
  },
  {
    key: "notices_account",
    label: "الاشعارات",
    type: "ASSET",
    hints: ["الاشعارات", "notices"],
  },
  {
    key: "financial_settlements_account",
    label: "التسويات المالية",
    type: "ASSET",
    hints: ["التسويات المالية", "financial settlements"],
  },
  {
    key: "bad_debts_account",
    label: "ديون معدومة",
    type: "EXPENSE",
    hints: ["ديون معدومة", "bad debts"],
  },
  {
    key: "consignment_sales_ratio_account",
    label: "نسبة مبيعات بضاعة الأمانة",
    type: "REVENUE",
    hints: ["بغرض الأمانة", "consignment"],
  },
  {
    key: "unrealized_profit_account",
    label: "حساب أرباح غير محققة",
    type: "LIABILITY",
    hints: ["أرباح غير محققة", "unrealized profit"],
  },
  {
    key: "realized_profit_account",
    label: "حساب أرباح محققة",
    type: "REVENUE",
    hints: ["أرباح محققة", "realized profit"],
  },
  {
    key: "third_party_deposits_account",
    label: "تأمينات من الغير",
    type: "LIABILITY",
    hints: ["تأمينات من الغير", "third party deposits"],
  },

  // ── الأصناف ──
  {
    key: "goods_inventory_account",
    label: "مخزون البضاعة",
    type: "ASSET",
    hints: ["مخزون البضاعة", "goods inventory"],
  },
  {
    key: "sales_allowances_account",
    label: "مسموحات المبيعات",
    type: "REVENUE",
    hints: ["مسموحات مبيعات", "sales allowances"],
  },
  {
    key: "donations_grants_account",
    label: "تبرعات وإعانات",
    type: "EXPENSE",
    hints: ["تبرعات", "إعانات", "donations", "grants"],
  },
  {
    key: "marketing_gifts_samples_account",
    label: "هدايا وعينات تسويقية",
    type: "EXPENSE",
    hints: ["هدايا", "عينات تسويقية", "marketing gifts"],
  },
  {
    key: "inventory_waste_account",
    label: "هالك المخزون",
    type: "EXPENSE",
    hints: ["هالك المخزون", "inventory waste"],
  },
  {
    key: "warehouse_transfers_account",
    label: "تحويلات المخازن",
    type: "ASSET",
    hints: ["تحويلات المخازن", "warehouse transfers"],
  },

  // ── شئون العاملين ──
  {
    key: "incentives_account",
    label: "الحوافز",
    type: "EXPENSE",
    hints: ["الحوافز", "incentives"],
  },
  {
    key: "employee_service_dues_account",
    label: "المصروفات المستحقة على الموظف من الخدمات",
    type: "ASSET",
    hints: ["مستحقات سداد الخدمات", "employee service dues"],
  },
  {
    key: "company_paid_services_account",
    label: "المصروفات المدفوعة من الشركة للخدمات",
    type: "EXPENSE",
    hints: ["خدمات الجهات الحكومية", "company paid services"],
  },
  {
    key: "sales_rep_commission_ratio_account",
    label: "نسبة توزيع المناديب",
    type: "EXPENSE",
    hints: ["نسب المناديب", "sales rep commission"],
  },
  {
    key: "sales_rep_commission_clearing_account",
    label: "حساب وسيط نسبة المناديب",
    type: "LIABILITY",
    hints: ["دائنو التوزيعات", "commission clearing"],
  },
  {
    key: "delivery_revenue_account",
    label: "ايرادات التوصيل",
    type: "REVENUE",
    hints: ["ايرادات التوصيل", "delivery revenue"],
  },

  // ── الضرائب و التأمينات ──
  {
    key: "taxes_account",
    label: "الضرائب",
    type: "LIABILITY",
    hints: ["الضرائب", "taxes"],
  },
  {
    key: "additional_tax_account",
    label: "الضريبة الاضافية",
    type: "LIABILITY",
    hints: ["الضريبة الاضافية", "additional tax"],
  },
  {
    key: "labor_income_tax_account",
    label: "ضريبة كسب العمل",
    type: "LIABILITY",
    hints: ["ضريبة كسب العمل", "labor income tax"],
  },
  {
    key: "withholding_addition_tax_account",
    label: "ضريبة الخصم و الاضافة",
    type: "LIABILITY",
    hints: ["الخصم و الإضافة", "withholding tax"],
  },

  // ── الخصومات ──
  {
    key: "quantity_discount_earned_account",
    label: "خصم كمية مكتسب",
    type: "REVENUE",
    hints: ["خصم كميه مكتسب", "quantity discount earned"],
  },
  {
    key: "quantity_discount_allowed_account",
    label: "خصم كمية مسموح به (مدين)",
    type: "REVENUE",
    hints: ["خصم كمية مسموح به", "quantity discount allowed"],
  },

  // ── الأصول الثابتة ──
  {
    key: "depreciation_provision_account",
    label: "مخصص الإهلاك",
    type: "LIABILITY",
    hints: ["مخصص الإهلاك", "depreciation provision"],
  },
  {
    key: "maintenance_expense_account",
    label: "مصروفات صيانة واصلاح",
    type: "EXPENSE",
    hints: ["مصروفات صيانة", "maintenance expense"],
  },
  {
    key: "capital_gains_account",
    label: "ارباح رأسمالية",
    type: "REVENUE",
    hints: ["ارباح رأسمالية", "capital gains"],
  },
  {
    key: "capital_losses_account",
    label: "خسائر رأسمالية",
    type: "EXPENSE",
    hints: ["خسائر رأسمالية", "capital losses"],
  },
  {
    key: "disposed_assets_account",
    label: "أصول مستبعدة",
    type: "ASSET",
    hints: ["أصول مستبعدة", "disposed assets"],
  },
  {
    key: "revaluation_surplus_account",
    label: "فائض إعادة التقييم",
    type: "EQUITY",
    hints: ["فائض إعادة التقييم", "revaluation surplus"],
  },

  // ── فروق العملات ──
  {
    key: "fx_gain_account",
    label: "أرباح فروق عملة",
    type: "REVENUE",
    hints: ["أرباح فروق العملة", "fx gain"],
  },
  {
    key: "fx_loss_account",
    label: "خسائر فروق عملة",
    type: "EXPENSE",
    hints: ["خسائر فروق العملة", "fx loss"],
  },
  {
    key: "rounding_difference_account",
    label: "فروق تقريب الكسور العشرية",
    type: "EXPENSE",
    hints: ["فروق تقريب", "rounding difference"],
  },

  // ── إغلاق اليومية ──
  {
    key: "daily_closing_shortage_account",
    label: "العجز في إغلاق اليومية",
    type: "ASSET",
    hints: ["عجز في إغلاق اليومية", "daily closing shortage"],
  },
];

/** A posting account must be an active, non-deleted leaf of the required type. */
function _isUsablePostingAccount(account, expectedType) {
  if (!account || account.deleted_at) return false;
  if (account.is_active === false || account.is_active === "FALSE")
    return false;
  if (account.is_parent === true || account.is_parent === "TRUE") return false;
  return !expectedType || account.type === expectedType;
}

/**
 * [PC-DEFAULT-SELECT] احتياطي أخير لما الكشف بالاسم (_findAccountByNameHints)
 * يفشل — بدل ما يفضل السليكت فاضي تمامًا في شاشة إعدادات الترحيل، بنختار أول
 * حساب صالح (نشط/فرعي) بنفس نوع المفتاح (ASSET/LIABILITY/...) كقيمة افتراضية
 * مبدئية يقدر المستخدم يراجعها ويغيّرها. ده عرض فقط (لا يُحفظ تلقائيًا كـ
 * pinned) — الحفظ الفعلي بيحصل فقط لما المستخدم يضغط "حفظ جميع الإعدادات".
 */
function _findFirstUsableAccountByType(accounts, type) {
  return (
    (accounts || []).find(function (a) {
      return _isUsablePostingAccount(a, type);
    }) || null
  );
}

/**
 * [ACCOUNTING-LOOKUP-UNIFY] validateAccountingFieldValue — الفاليديشن الموحد
 * لأي حقل محاسبي في أي موديول (شحن، مبيعات، سندات، أصول...). يُستخدم بدل
 * كتابة فحوصات محلية متفرقة في كل ملف.
 *
 * opts:
 *   required     — هل الحقل إلزامي؟
 *   expectedType — نوع الحساب المطلوب (ASSET/LIABILITY/REVENUE/EXPENSE...) أو null لأي نوع
 *   accounts     — (اختياري) مصفوفة الحسابات المحمّلة مسبقاً لتفادي قراءة الشيت أكتر من مرة
 *
 * الإرجاع: null لو الحقل سليم، أو نص رسالة الخطأ بالعربي لعرضه تحت الحقل مباشرة.
 */
function validateAccountingFieldValue(accountId, opts) {
  opts = opts || {};
  accountId = accountId ? String(accountId).trim() : "";

  if (!accountId) {
    return opts.required
      ? "هذا الحقل المحاسبي إلزامي — يجب اختيار حساب من دليل الحسابات"
      : null;
  }

  var accounts =
    opts.accounts ||
    readSheet("ChartOfAccounts", ACCOUNTING_HR_HEADERS.ChartOfAccounts, {
      trimStrings: true,
    });
  var acc = accounts.find(function (a) {
    return String(a.id) === accountId;
  });

  if (!acc) return "الحساب المحدد غير موجود في دليل الحسابات";
  if (acc.deleted_at) return "الحساب المحدد محذوف من دليل الحسابات";
  if (acc.is_active === false || acc.is_active === "FALSE")
    return "الحساب المحدد غير نشط";
  if (acc.is_parent === true || acc.is_parent === "TRUE")
    return "لا يمكن استخدام حساب تجميعي (أب) في العمليات — اختر حساباً فرعياً";
  if (opts.expectedType && acc.type !== opts.expectedType)
    return (
      "نوع الحساب المختار (" +
      acc.type +
      ") لا يتوافق مع النوع المطلوب لهذا الحقل (" +
      opts.expectedType +
      ")"
    );

  return null;
}

/**
 * getItemAccountingDefaults — [ITEM-ACC-DEFAULTS-2026-07-27] بيرجع الحساب
 * الافتراضي الفعلي (من إعدادات الترحيل) لأهم مفاتيح الحسابات المستخدمة في
 * تاب "الحسابات" بشاشة الصنف — بيتعرض بس كنص توضيحي بدل "وراثة من الإعداد
 * الافتراضي" العام، والحقل بيفضل يتخزن فاضي (وراثة حقيقية). بدون Permission
 * Gate مخصوص لأن دليل الحسابات نفسه (chartOfAccounts) متاح بالفعل لأي
 * مستخدم بيفتح شاشة إضافة صنف من غير أي فلترة صلاحيات.
 */
/**
 * [ITEM-POSTING-WIRE-2026-08-07] resolveItemLevelAccount — يحل حساب الترحيل
 * لبند صنف بعينه حسب سلسلة الوراثة: حساب الصنف نفسه (item[fieldKey]) ←
 * الحساب الافتراضي العام (fallbackAccount) الممرَّر من _getDefaultAccount.
 *
 * قبل كده، الحقول دي (inventory_account_id, cogs_account_id, sales_account_id,
 * purchase_account_id, sales_return_account_id, purchase_return_account_id)
 * كانت موجودة في شيت Items (ITEM-MASTER-P4) لكن مفيش أي قيد محاسبي في
 * النظام كله بيقرأها فعليًا — كل الفواتير كانت بترحّل دايمًا على الحساب
 * العام بغض النظر عن قيمة هذه الحقول. الدالة دي هي نقطة الربط الموحّدة.
 *
 * accountsById: خريطة {id: accountRow} من ChartOfAccounts (لتفادي بحث خطي
 * متكرر لكل بند فاتورة).
 */
function resolveItemLevelAccount(itemRec, fieldKey, accountsById, expectedType, fallbackAccount) {
  var pinnedId = itemRec && itemRec[fieldKey];
  if (pinnedId) {
    var acc = accountsById[pinnedId];
    if (_isUsablePostingAccount(acc, expectedType)) return acc;
  }
  return fallbackAccount || null;
}

/**
 * [ITEM-POSTING-WIRE-2026-08-07] _buildAccountsByIdMap — تحويل مصفوفة
 * ChartOfAccounts لخريطة id→row مرة واحدة قبل حلقة بنود الفاتورة.
 */
function _buildAccountsByIdMap(accounts) {
  var map = {};
  (accounts || []).forEach(function (a) {
    map[a.id] = a;
  });
  return map;
}

function getItemAccountingDefaults(callerUser, sessionToken) {
  try {
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    accounts = accounts.filter(function (a) {
      return _isUsablePostingAccount(a);
    });
    var settingsMap = _getAccountSettingsMap();
    // خريطة مفاتيح الترحيل المرتبطة بحقول تاب الحسابات في شاشة الصنف —
    // "حساب المشتريات المرتجعة" و"حساب فروقات السعر" مفيش لهم مفتاح
    // ترحيل عام مخصص حالياً، فبتفضل بالنص العام.
    var neededKeys = [
      "inventory_account",
      "cogs_account",
      "revenue_account",
      "purchase_account",
      "sales_return_account",
      "inventory_variance_account",
    ];
    var result = {};
    POSTING_CONFIG_KEYS.forEach(function (cfg) {
      if (neededKeys.indexOf(cfg.key) === -1) return;
      var pinnedId = settingsMap[cfg.key];
      var acc = pinnedId
        ? accounts.find(function (a) {
            return a.id === pinnedId;
          })
        : null;
      if (!_isUsablePostingAccount(acc, cfg.type)) acc = null;
      if (!acc) acc = _findAccountByNameHints(accounts, cfg.type, cfg.hints);
      if (!acc) acc = _findFirstUsableAccountByType(accounts, cfg.type);
      result[cfg.key] = acc
        ? { id: acc.id, code: acc.code || "", name: acc.name || "" }
        : null;
    });
    return { success: true, data: result };
  } catch (e) {
    return errResponse("خطأ في جلب الحسابات الافتراضية: " + e.message);
  }
}

/**
 * getPostingConfigKeys — يُرجع قائمة مفاتيح الترحيل مع الحساب المربوط حالياً
 * تُستخدم من شاشة إعدادات الترحيل لعرض وتعديل الربط
 */
function getPostingConfigKeys(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "manageChartOfAccounts",
      sessionToken,
    );
    if (permErr) return permErr;

    var settingsMap = _getAccountSettingsMap();
    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    accounts = accounts.filter(function (a) {
      return _isUsablePostingAccount(a);
    });

    var result = POSTING_CONFIG_KEYS.map(function (cfg) {
      var pinnedId = settingsMap[cfg.key];
      var acc = pinnedId
        ? accounts.find(function (a) {
            return a.id === pinnedId;
          })
        : null;
      if (!_isUsablePostingAccount(acc, cfg.type)) acc = null;
      if (!acc) acc = _findAccountByNameHints(accounts, cfg.type, cfg.hints);
      // [PC-DEFAULT-SELECT] لسه مفيش ربط يدوي ولا كشف بالاسم — بدل ما
      // السليكت يفضل فاضي، بنختار أول حساب صالح بنفس النوع كقيمة افتراضية
      // مبدئية (غير محفوظة)، ونعلّمها is_type_fallback عشان الواجهة توضّح
      // للمستخدم إنها تخمين عام محتاج مراجعة، مش كشف دقيق بالاسم.
      var isTypeFallback = false;
      if (!acc) {
        acc = _findFirstUsableAccountByType(accounts, cfg.type);
        isTypeFallback = !!acc;
      }
      return {
        key: cfg.key,
        label: cfg.label,
        account_type: cfg.type,
        account_id: acc ? acc.id : "",
        account_code: acc ? acc.code : "",
        account_name: acc ? acc.name : "",
        is_pinned: !!pinnedId,
        is_type_fallback: isTypeFallback,
        is_missing: !acc,
      };
    });

    return { success: true, data: result, accounts: accounts };
  } catch (e) {
    return errResponse("خطأ في جلب مفاتيح الترحيل: " + e.message);
  }
}

/**
 * saveAllAccountingSettings — حفظ دفعي لجميع روابط الحسابات من شاشة إعدادات الترحيل
 */
function saveAllAccountingSettings(payload, sessionToken) {
  try {
    var callerUser =
      payload && payload.callerUser
        ? payload.callerUser
        : _getUsernameFromToken(sessionToken);
    var permErr = _checkPermission(
      callerUser,
      "manageChartOfAccounts",
      sessionToken,
    );
    if (permErr) return permErr;

    var settings = payload && payload.settings ? payload.settings : [];
    if (!Array.isArray(settings) || settings.length === 0)
      return errResponse("لا توجد إعدادات للحفظ");

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    var validated = [];
    var skipped = [];
    settings.forEach(function (s) {
      if (!s.key || !s.account_id) {
        skipped.push(s.key || "?");
        return;
      }
      var cfg = POSTING_CONFIG_KEYS.find(function (c) {
        return c.key === s.key;
      });
      if (!cfg) throw new Error("مفتاح ترحيل غير معرّف: " + s.key);
      var account = accounts.find(function (a) {
        return a.id === s.account_id;
      });
      var isParent =
        account && (account.is_parent === true || account.is_parent === "TRUE");
      if (!_isUsablePostingAccount(account))
        throw new Error(
          "الحساب المختار غير موجود أو غير نشط للمفتاح: " + cfg.label,
        );
      if (isParent)
        throw new Error("لا يجوز ربط حساب تجميعي بالمفتاح: " + cfg.label);
      if (account.type !== cfg.type)
        throw new Error(
          "نوع الحساب المختار لا يطابق نوع مفتاح الترحيل: " + cfg.label,
        );
      validated.push(s);
    });

    // [PC-AUDIT-LOG-2026-08-08] كانت saveAllAccountingSettings تكتفي بتحديث
    // updated_at/updated_by (آخر قيمة فقط، تُستبدَل في كل حفظ) بدون أي أثر
    // تاريخي — لا يمكن معرفة "من غيّر حساب المبيعات؟ من أي حساب؟ إلى أي
    // حساب؟" كما يتطلب قسم Audit Log في الشاشة. الحل: نلتقط القيمة القديمة
    // *قبل* الحفظ (settingsMap الحالي) ونسجّل سطر AuditEngine.log واحد لكل
    // مفتاح تغيّرت قيمته فعلياً (لا نسجّل شيئاً لو نفس الحساب أُعيد حفظه).
    var settingsMapBefore = _getAccountSettingsMap();
    validated.forEach(function (s) {
      var oldAccountId = settingsMapBefore[s.key] || "";
      _setAccountSetting(s.key, s.account_id, callerUser);
      if (oldAccountId !== s.account_id) {
        var cfg = POSTING_CONFIG_KEYS.find(function (c) {
          return c.key === s.key;
        });
        var oldAcc = accounts.find(function (a) {
          return a.id === oldAccountId;
        });
        var newAcc = accounts.find(function (a) {
          return a.id === s.account_id;
        });
        AuditEngine.log("SET_POSTING_DEFAULT", {
          user: callerUser,
          table: "AccountingSettings",
          record_id: s.key,
          oldValue: oldAcc
            ? (oldAcc.code ? "[" + oldAcc.code + "] " : "") + oldAcc.name
            : oldAccountId || "(غير مربوط)",
          newValue: newAcc
            ? (newAcc.code ? "[" + newAcc.code + "] " : "") + newAcc.name
            : s.account_id,
          details:
            "ثوابت الحسابات — " + (cfg ? cfg.label : s.key),
        });
      }
    });
    var saved = validated.length;

    _invalidateServerCache();
    var msg = " تم حفظ " + saved + " ربط حساب بنجاح";
    if (skipped.length) msg += " | تجاهل " + skipped.length + " فارغ";
    return okResponse(msg, { saved: saved, skipped: skipped });
  } catch (e) {
    return errResponse("خطأ في حفظ إعدادات الترحيل: " + e.message);
  }
}

/**
 * autoDetectAndPinAccounts — يُشغِّل الكشف التلقائي عن الحسابات بالاسم ويثبِّتها
 * يُستخدم مرة واحدة عند الإعداد الأول أو عند إعادة بناء روابط الحسابات
 */
function autoDetectAndPinAccounts(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "manageChartOfAccounts",
      sessionToken,
    );
    if (permErr) return permErr;

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      { trimStrings: true },
    );
    accounts = accounts.filter(function (a) {
      return !a.deleted_at;
    });

    // [PC-AUDIT-LOG-2026-08-08] نفس منطق التسجيل المضاف في
    // saveAllAccountingSettings — الكشف التلقائي بيغيّر روابط فعلية بنفس
    // درجة الخطورة (ويمكن يستبدل ربطاً يدوياً سابقاً)، فلازم يظهر في نفس
    // الأثر التدقيقي.
    var settingsMapBefore = _getAccountSettingsMap();
    var pinned = 0;
    var missing = [];
    POSTING_CONFIG_KEYS.forEach(function (cfg) {
      var found = _findAccountByNameHints(accounts, cfg.type, cfg.hints);
      if (found) {
        var oldAccountId = settingsMapBefore[cfg.key] || "";
        _setAccountSetting(cfg.key, found.id, callerUser || "AUTO_DETECT");
        pinned++;
        if (oldAccountId !== found.id) {
          var oldAcc = accounts.find(function (a) {
            return a.id === oldAccountId;
          });
          AuditEngine.log("SET_POSTING_DEFAULT", {
            user: callerUser || "AUTO_DETECT",
            table: "AccountingSettings",
            record_id: cfg.key,
            oldValue: oldAcc
              ? (oldAcc.code ? "[" + oldAcc.code + "] " : "") + oldAcc.name
              : oldAccountId || "(غير مربوط)",
            newValue: (found.code ? "[" + found.code + "] " : "") + found.name,
            details: "ثوابت الحسابات — كشف تلقائي — " + cfg.label,
          });
        }
      } else missing.push(cfg.label);
    });

    _invalidateServerCache();
    var msg = " تم تثبيت " + pinned + " حساب تلقائياً";
    if (missing.length) msg += " | لم يُعثر على: " + missing.join(", ");
    return okResponse(msg, { pinned: pinned, missing: missing });
  } catch (e) {
    return errResponse("خطأ في الكشف التلقائي: " + e.message);
  }
}

/**
 * _getDefaultAccount — نقطة الدخول الموحدة لكل القيود التلقائية لإيجاد حساب افتراضي [B3 FIX]
 * 1) يبحث أولاً عن ربط ثابت في AccountingSettings عبر "key" (لا يتأثر بتغيير اسم الحساب)
 * 2) لو غير موجود أو الحساب المثبّت محذوف: يبحث بالاسم (hints) كآلية fallback،
 *    ثم يُثبِّت النتيجة تلقائيًا في AccountingSettings لمنع تكرار المشكلة مستقبلاً
 */
/**
 * verifyPostingSetupComplete — [P1-GATE] يتحقق أن مفاتيح ترحيل محددة مربوطة
 * بحسابات فعلية في دليل الحسابات (إما مثبَّتة في AccountingSettings أو قابلة
 * للاكتشاف بالاسم) *قبل* السماح بإنشاء عملية مالية.
 *
 * لماذا هذه الدالة ضرورية:
 * _getDefaultAccount() كانت تعيد undefined بصمت (مع سطر Logger.log فقط) عند
 * عدم وجود حساب مربوط، وكانت دوال القيد التلقائي (_autoJournalSaleInvoice
 * وغيرها) تتجاهل السطر الناقص أو تُلغي القيد بالكامل دون أي تنبيه — بينما
 * الفاتورة وحركة المخزون كانتا تُحفظان بنجاح. النتيجة: عمليات بيع/شراء فعلية
 * بدون أي أثر محاسبي، وميزان مراجعة غير متوازن مع الواقع التشغيلي.
 * هذه الدالة تمنع وقوع المشكلة من الأساس بدل اكتشافها لاحقًا بالتدقيق.
 *
 * @param {string[]} requiredKeys - مفاتيح من POSTING_CONFIG_KEYS مطلوبة لهذه العملية
 * @returns {{complete:boolean, missing:Array<{key:string,label:string}>}}
 */
function verifyPostingSetupComplete(requiredKeys) {
  var accounts = readSheet(
    "ChartOfAccounts",
    ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    { trimStrings: true },
  );
  accounts = accounts.filter(function (a) {
    return _isUsablePostingAccount(a);
  });
  var settingsMap = _getAccountSettingsMap();
  var missing = [];
  (requiredKeys || []).forEach(function (key) {
    var cfg = POSTING_CONFIG_KEYS.find(function (c) {
      return c.key === key;
    });
    if (!cfg) return; // مفتاح غير معرّف فى القائمة المرجعية — يُتجاهل دفاعيًا
    var acc = null;
    var pinnedId = settingsMap[key];
    if (pinnedId) {
      acc = accounts.find(function (a) {
        return a.id === pinnedId;
      });
    }
    var isParent = acc && (acc.is_parent === true || acc.is_parent === "TRUE");
    if (!acc || isParent || acc.type !== cfg.type) {
      acc = _findAccountByNameHints(accounts, cfg.type, cfg.hints);
      isParent = acc && (acc.is_parent === true || acc.is_parent === "TRUE");
    }
    if (!acc || isParent || acc.type !== cfg.type)
      missing.push({ key: key, label: cfg.label });
  });
  return { complete: missing.length === 0, missing: missing };
}

/** _postingSetupErrorMessage — رسالة خطأ موحَّدة وواضحة لمستخدم/محاسب عند نقص الربط */
function _postingSetupErrorMessage(missing) {
  var labels = missing
    .map(function (m) {
      return "• " + m.label;
    })
    .join("\n");
  return (
    " لا يمكن إتمام العملية: إعدادات الترحيل المحاسبي غير مكتملة.\n" +
    "الحسابات التالية غير مربوطة في دليل الحسابات أو إعدادات الترحيل:\n" +
    labels +
    "\n\nمن فضلك أكمل الربط من: الإعدادات ← إعدادات الترحيل المحاسبي " +
    "(Posting Configuration)، ثم أعد المحاولة."
  );
}

/**
 * getSystemReadinessStatus — [P1] فحص جاهزية النظام الإجمالي للتشغيل الفعلي.
 * يُستخدم من شاشة الإعدادات/لوحة التحكم لعرض بانر "النظام غير جاهز" مع
 * تفاصيل ما هو ناقص، بدل اكتشاف النقص بعد وقوع عمليات بدون قيود.
 */
function getSystemReadinessStatus(callerUser, sessionToken) {
  try {
    if (callerUser) {
      var permErr = _checkPermission(callerUser, "viewReports", sessionToken);
      if (permErr) return permErr;
    }
    var status = _getSystemSetupStatus();
    return {
      success: true,
      data: {
        ready: status.ready,
        issues: status.missing.concat(status.warnings),
        missing: status.missing,
        warnings: status.warnings,
        score: status.score,
      },
    };
  } catch (e) {
    return errResponse("خطأ في فحص جاهزية النظام: " + e.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// §POSTING-RESOLUTION-SERVICE — خدمة حل الإعدادات الموحدة (Default + Override)
// ────────────────────────────────────────────────────────────────────────────
// نفس المبدأ المستخدم في SAP / Dynamics / Odoo:
//   المستوى 1: Transaction Override  (خاص بالمعاملة الحالية فقط، إن سُمح به)
//   المستوى 2: Entity Override       (خاص بالعميل/المورد/الصنف/البنك/الخزينة/
//                                      شركة الشحن... إلخ)
//   المستوى 3: Category Override     (خاص بفئة الكيان)
//   المستوى 4: Global Default        (AccountingSettings / POSTING_CONFIG_KEYS)
//   المستوى 5: منع العملية برسالة واضحة (لا قيد ناقص أبداً)
//
// كل الموديولات المفروض تستدعي resolvePostingAccount() بدل ما تكرر منطق
// "دوّر على حساب الكيان ولو مش موجود ارجع للعام" في كل ملف لوحده.
// ════════════════════════════════════════════════════════════════════════════

/**
 * resolvePostingAccount — نقطة الدخول الموحدة لحل أي حساب محاسبي وفق تسلسل الأولويات.
 *
 * @param {object} opts
 * @param {Array}  opts.accounts               دليل الحسابات (ChartOfAccounts) بعد فلترة deleted_at
 * @param {string} opts.key                    مفتاح POSTING_CONFIG_KEYS (المستوى 4)
 * @param {string} [opts.type]                 نوع الحساب (ASSET/LIABILITY/...) — يُستخدم في fallback البحث بالاسم
 * @param {string[]} [opts.hints]              كلمات مفتاحية للبحث بالاسم (fallback المستوى 4)
 * @param {string}  [opts.transactionAccountId] قيمة override على مستوى المعاملة (المستوى 1)
 * @param {boolean} [opts.allowTransactionOverride=false] هل مسموح لهذه العملية بتعديل المعاملة؟
 * @param {string}  [opts.entityAccountId]     قيمة override على مستوى الكيان (المستوى 2)
 * @param {string}  [opts.categoryAccountId]   قيمة override على مستوى الفئة (المستوى 3)
 * @returns {{account: object|null, source: 'transaction'|'entity'|'category'|'global'|null}}
 */
function resolvePostingAccount(opts) {
  opts = opts || {};
  var accounts = opts.accounts || [];

  function findById(id) {
    if (!id) return null;
    return (
      accounts.find(function (a) {
        return a.id === id && _isUsablePostingAccount(a, opts.type);
      }) || null
    );
  }

  // المستوى 1: Transaction Override — فقط لو مسموح بيه صراحة
  if (opts.allowTransactionOverride) {
    var txAcc = findById(opts.transactionAccountId);
    if (txAcc) return { account: txAcc, source: "transaction" };
  }

  // المستوى 2: Entity Override
  var entAcc = findById(opts.entityAccountId);
  if (entAcc) return { account: entAcc, source: "entity" };

  // المستوى 3: Category Override
  var catAcc = findById(opts.categoryAccountId);
  if (catAcc) return { account: catAcc, source: "category" };

  // المستوى 4: Global Default (AccountingSettings ← fallback بحث بالاسم)
  if (opts.key) {
    var globalAcc = _getDefaultAccount(
      opts.key,
      accounts,
      opts.type,
      opts.hints || [],
    );
    if (globalAcc) return { account: globalAcc, source: "global" };
  }

  // المستوى 5: لا يوجد إعداد على الإطلاق
  return { account: null, source: null };
}

/**
 * requirePostingAccount — زي resolvePostingAccount لكن يرمي رسالة خطأ جاهزة
 * (بنفس شكل _postingSetupErrorMessage) بدل ما يرجع null بصمت — يُستخدم مباشرة
 * داخل try/catch القيود التلقائية لمنع أي قيد ناقص.
 */
function requirePostingAccount(opts, labelForError) {
  var result = resolvePostingAccount(opts);
  if (!result.account) {
    throw new Error(
      " لا يمكن إتمام العملية: لا يوجد حساب محاسبي مربوط لـ " +
        (labelForError || opts.key || "هذا البند") +
        " (لا على مستوى المعاملة، ولا الكيان، ولا الفئة، ولا الإعداد العام).\n" +
        "من فضلك اربط الحساب من الإعدادات ← إعدادات الترحيل المحاسبي، أو من شاشة الكيان نفسه.",
    );
  }
  return result;
}

/**
 * setEntityAccountOverride — تعديل يدوي لحساب Override على مستوى كيان معيّن
 * (عميل/مورد/صنف/بنك/خزينة/شركة شحن...)، محمي بالصلاحيات، ومسجَّل بالكامل
 * في Audit Trail (المستخدم، التاريخ، القيمة القديمة، الجديدة، السبب).
 *
 * @param {object} p
 * @param {string} p.callerUser
 * @param {string} p.sessionToken
 * @param {string} p.permissionKey   صلاحية مطلوبة للتعديل (افتراضي: manageChartOfAccounts)
 * @param {string} p.sheetName       اسم الشيت (مثلاً "Customers")
 * @param {Array}  p.headers         Headers الشيت
 * @param {string} p.entityId        معرف الكيان
 * @param {string} p.fieldName       اسم عمود الحساب (مثلاً "revenue_account_id")
 * @param {string} p.newAccountId    القيمة الجديدة (فارغة = إلغاء الـ Override والعودة للافتراضي)
 * @param {string} [p.reason]        سبب التعديل (اختياري لكن يُسجَّل لو موجود)
 */
function setEntityAccountOverride(p) {
  var permErr = _requirePermission(
    p.callerUser,
    p.permissionKey || "manageChartOfAccounts",
    p.sessionToken,
  );
  if (permErr) return permErr;

  var sheet = getSheet(p.sheetName, p.headers);
  var rows = readSheet(p.sheetName, p.headers, { trimStrings: true });
  var idx = rows.findIndex(function (r) {
    return r.id === p.entityId;
  });
  if (idx === -1) return errResponse("الكيان غير موجود: " + p.entityId);

  var colIdx = p.headers.indexOf(p.fieldName);
  if (colIdx === -1)
    return errResponse("العمود غير موجود في الشيت: " + p.fieldName);

  var oldValue = rows[idx][p.fieldName] || "";
  var newValue = p.newAccountId || "";

  sheet.getRange(rows[idx]._row, colIdx + 1).setValue(newValue);
  _invalidateServerCache();
  _invalidateExtCache && _invalidateExtCache(p.sheetName);

  AuditEngine.log(newValue ? "SET_ACCOUNT_OVERRIDE" : "CLEAR_ACCOUNT_OVERRIDE", {
    user: p.callerUser,
    table: p.sheetName,
    record_id: p.entityId,
    oldValue: oldValue,
    newValue: newValue,
    details:
      "override لحقل " +
      p.fieldName +
      (p.reason ? " | السبب: " + p.reason : "")});

  return okResponse(
    newValue
      ? " تم حفظ الربط الخاص بهذا الكيان"
      : " تم إلغاء الربط الخاص وسيُستخدم الإعداد الافتراضي",
  );
}

function _getDefaultAccount(key, accounts, type, hints) {
  try {
    var settingsMap = _getAccountSettingsMap();
    var pinnedId = settingsMap[key];
    if (pinnedId) {
      var pinned = accounts.find(function (a) {
        return a.id === pinnedId && _isUsablePostingAccount(a, type);
      });
      if (pinned) return pinned;
    }
    var found = _findAccountByNameHints(accounts, type, hints);
    if (found) {
      _setAccountSetting(key, found.id, "SYSTEM_AUTO_PIN");
    }
    return found;
  } catch (e) {
    Logger.log("[_getDefaultAccount] خطأ: " + e.message);
    return _findAccountByNameHints(accounts, type, hints);
  }
}

function _findAccountByNameHints(accounts, type, hints) {
  var result = accounts.find(function (a) {
    if (type && a.type !== type) return false;
    if (a.deleted_at) return false;
    if (a.is_active === false || a.is_active === "FALSE") return false;
    if (a.is_parent === true || a.is_parent === "TRUE") return false;
    var name = String(a.name || "").toLowerCase();
    var nameEn = String(a.name_en || "").toLowerCase();
    return hints.some(function (h) {
      h = String(h).toLowerCase();
      return name.indexOf(h) !== -1 || nameEn.indexOf(h) !== -1;
    });
  });

  // [P3-C FIX] تسجيل حالة الفشل في Logger بدلاً من الصمت التام
  // يُساعد على اكتشاف حسابات مفقودة في دليل الحسابات
  if (!result) {
    Logger.log(
      "[ACCOUNT-LOOKUP-MISS] نوع: " +
        type +
        " | كلمات البحث: [" +
        hints.slice(0, 3).join(", ") +
        "]" +
        " | إجمالي الحسابات: " +
        accounts.length,
    );
  }
  return result;
}

function _autoJournalFromPayroll(period, records, callerUser, sessionToken) {
  // ── [REMEDIATION-3] القيد بالإجمالي بدل الصافي فقط ──
  // المشكلة القديمة: كان يُرحَّل totalNet فقط على الطرفين (Dr=Cr=صافي) — الضريبة
  // والتأمينات وكل الخصومات الأخرى المحسوبة بدقة داخل generatePayroll() كانت
  // "تختفي" من دفتر الأستاذ لأنها لا تظهر في أي حساب مستقل.
  //
  // الحل: تجميع كل مكوّن مخزَّن في PayrollRecords عبر كل السجلات، ثم تسجيل:
  //   Dr. مصروف رواتب  = الإجمالي قبل أي استقطاع (أساسي + بدلات + إضافي + أجر إنتاج)
  //   Cr. رواتب مستحقة الصرف = الصافي الفعلي المستحق للموظفين
  //   Cr. ضرائب مستحقة       = إجمالي الضريبة المحتجزة
  //   Cr. تأمينات مستحقة     = إجمالي التأمين الاجتماعي (حصة الموظف) المحتجز
  //   Cr. خصومات وسلف مستحقة = باقي الاستقطاعات (خصومات ثابتة + أقساط سلف + خصم تأخير
  //                             + خصم إجازة غير مدفوعة) — هذا السطر ضروري رياضياً
  //                             للتوازن، وليس مجرد تحسين اختياري: بدونه، أي فترة رواتب
  //                             فيها خصم تأخير أو قسط سلفة ستُنتج قيداً غير متوازن
  //                             ويرفضه _addJournalEntryInternal بالكامل (راجع
  //                             _validateJournalEntry — يرمي خطأ صريح عند أي فرق
  //                             أكبر من 0.001)، فيتوقف صرف الرواتب محاسبياً.
  //
  // بالتالي طرفا القيد متوازنان جبرياً لأي فترة، بصرف النظر عن أي مكوّن كان صفراً:
  //   Gross = Net + Tax + Insurance + (Deductions + Loan + Delay + UnpaidLeave)
  // وهي نفس معادلة صافي الراتب في generatePayroll() لكن مقلوبة.
  var sumBasic = 0,
    sumAllowances = 0,
    sumOvertime = 0,
    sumProduction = 0,
    sumNet = 0,
    sumTax = 0,
    sumInsurance = 0,
    sumDeductions = 0,
    sumLoan = 0,
    sumDelay = 0,
    sumUnpaidLeave = 0,
    sumEmployerInsurance = 0; // [REMEDIATION-5]

  records.forEach(function (r) {
    sumBasic += Number(r.basic_salary || 0);
    sumAllowances += Number(r.total_allowances || 0);
    sumOvertime += Number(r.overtime_amount || 0);
    sumProduction += Number(r.production_wage || 0); // [REMEDIATION-1]
    sumNet += Number(r.net_salary || 0);
    sumTax += Number(r.income_tax || 0);
    sumInsurance += Number(r.social_insurance || 0);
    sumDeductions += Number(r.total_deductions || 0);
    sumLoan += Number(r.loan_deduction || 0);
    sumDelay += Number(r.delay_deduction || 0); // [REMEDIATION-3]
    sumUnpaidLeave += Number(r.unpaid_leave_deduction || 0);
    sumEmployerInsurance += Number(r.employer_social_insurance || 0); // [REMEDIATION-5]
  });

  var round2 = function (n) {
    return Math.round(n * 100) / 100;
  };
  var grossExpense = round2(
    sumBasic + sumAllowances + sumOvertime + sumProduction,
  );
  var totalNet = round2(sumNet); // يُستخدم أيضاً في قيد الصرف الفعلي بالأسفل — بدون تغيير
  if (grossExpense <= 0) return null;

  var otherWithholdings = round2(sumDeductions + sumDelay + sumUnpaidLeave);
  // [FIX-AUDIT-2026 #1] قسط السلفة المخصوم من الراتب يُفصَل عن باقي الاستقطاعات:
  // كان يُضاف بالكامل إلى otherWithholdings ثم يُقيَّد كدائن في حساب التزام
  // ("خصومات وسلف مستحقة") — خطأ في الطبيعة المحاسبية لأن السلفة لم تُسجَّل
  // كالتزام بل كأصل (ذمة مدينة) عند صرفها. الصحيح: تخفيض حساب "ذمم سلف
  // موظفين" (أصل) مباشرة بنفس القسط المخصوم، تماماً كما لو حصّلنا جزءاً من
  // الذمة عبر الراتب بدل النقد. بدون هذا الفصل، حساب الالتزام كان يتراكم
  // بلا تصفية طبيعية أبداً (راجع تقرير المراجعة، المرحلة 4 و6 والخطأ #1).
  sumLoan = round2(sumLoan);
  sumTax = round2(sumTax);
  sumInsurance = round2(sumInsurance);

  var accounts = readSheet(
    "ChartOfAccounts",
    ACCOUNTING_HR_HEADERS.ChartOfAccounts,
  );

  // [POSTING-ENGINE-FIX] استخدام _getDefaultAccount بدل _findAccountByNameHints
  var salaryExpense = _getDefaultAccount(
    "salary_expense_account",
    accounts,
    "EXPENSE",
    ["رواتب", "أجور", "عمالة", "salary", "wages", "payroll"],
  );
  var salaryPayable = _getDefaultAccount(
    "salary_payable_account",
    accounts,
    "LIABILITY",
    ["رواتب مستحقة", "مستحقة الصرف", "salary payable", "payroll payable"],
  );

  if (!salaryExpense || !salaryPayable) {
    Logger.log("[PAYROLL] تجاوز القيد: حسابات الرواتب مفقودة في دليل الحسابات");
    return null;
  }

  // ── [REMEDIATION-3] حسابات جديدة — إن لم تكن موجودة/معرَّفة في دليل الحسابات،
  // نتدرَّج بأمان: يُضاف مبلغها كسطر إضافي على حساب "رواتب مستحقة الصرف" نفسه بدل
  // إسقاط القيد بالكامل أو رفضه — نفس فلسفة السلوك القديم (توازن مضمون دائماً)
  // لكن مع تفصيل أدق كل ما أُعِدَّت الحسابات المخصَّصة فعلياً في الإعدادات.
  var taxPayable = _getDefaultAccount(
    "tax_payable_account",
    accounts,
    "LIABILITY",
    ["ضرائب مستحقة", "ضريبة مستحقة", "tax payable"],
  );
  var insurancePayable = _getDefaultAccount(
    "insurance_payable_account",
    accounts,
    "LIABILITY",
    [
      "تأمينات مستحقة",
      "تأمين اجتماعي مستحق",
      "insurance payable",
      "social insurance payable",
    ],
  );
  var otherDeductionsPayable = _getDefaultAccount(
    "other_payroll_deductions_account",
    accounts,
    "LIABILITY",
    ["خصومات وسلف موظفين", "خصومات مستحقة", "other payroll deductions"],
  );

  // [FIX-AUDIT-2026 #1] حساب "ذمم سلف موظفين" (أصل) — يُستخدَم لتخفيض رصيد
  // السلفة عند خصم قسطها من الراتب، بدل تجميعه خطأً في حساب التزام
  var employeeLoanAccount = _getDefaultAccount(
    "loan_account",
    accounts,
    "ASSET",
    ["سلف موظفين", "قروض موظفين", "employee loans", "advances"],
  );

  if (!taxPayable || !insurancePayable || !otherDeductionsPayable) {
    Logger.log(
      "[REMEDIATION-3] تنبيه: حساب/حسابات (ضرائب مستحقة / تأمينات مستحقة / " +
        "خصومات وسلف مستحقة) غير موجودة في دليل الحسابات — سيتم تجميع أي مبلغ لحساب " +
        "مفقود تلقائياً داخل 'رواتب مستحقة الصرف' حتى يُضاف الحساب المخصَّص لاحقاً " +
        "(أضِفه ثم أعد الربط من إعدادات الترحيل — مفاتيح: tax_payable_account, " +
        "insurance_payable_account, other_payroll_deductions_account).",
    );
  }
  if (sumLoan > 0 && !employeeLoanAccount) {
    Logger.log(
      "[FIX-AUDIT-2026] تنبيه: حساب 'ذمم سلف موظفين' (loan_account) غير معرَّف " +
        "في إعدادات الترحيل — سيُقيَّد قسط السلفة المخصوم هذا الشهر (" +
        sumLoan +
        ") مؤقتاً ضمن 'خصومات وسلف مستحقة' (التزام) بدل تخفيض الأصل الصحيح. " +
        "أضِف الحساب (مفتاح: loan_account) لتصحيح المعالجة من الفترة القادمة.",
    );
  }

  // ── [REMEDIATION-5] حصة صاحب العمل في التأمينات — مصروف منفصل تماماً عن مصروف
  // الرواتب، وليس جزءاً من التزام تجاه الموظف (الموظف لا يشعر بيه في صافيه إطلاقاً).
  // لو sumEmployerInsurance = 0 (الإعداد غير مضبوط) مفيش أي قيد إضافي بيتسجَّل هنا.
  var employerInsuranceExpense = _getDefaultAccount(
    "employer_insurance_expense_account",
    accounts,
    "EXPENSE",
    [
      "تأمينات صاحب العمل",
      "مصروف تأمينات",
      "employer social insurance",
      "employer insurance expense",
    ],
  );
  var employerInsurancePayable = _getDefaultAccount(
    "employer_insurance_payable_account",
    accounts,
    "LIABILITY",
    [
      "تأمينات مستحقة - حصة صاحب عمل",
      "تأمينات مستحقة صاحب العمل",
      "employer insurance payable",
    ],
  );
  if (
    sumEmployerInsurance > 0 &&
    (!employerInsuranceExpense || !employerInsurancePayable)
  ) {
    Logger.log(
      "[REMEDIATION-5] تنبيه: حساب/حسابات (مصروف تأمينات صاحب العمل / تأمينات مستحقة - " +
        "حصة صاحب عمل) غير موجودة في دليل الحسابات — لن يُرحَّل مصروف حصة صاحب العمل " +
        "لهذا المسير حتى تُضاف الحسابات (مفاتيح: employer_insurance_expense_account, " +
        "employer_insurance_payable_account).",
    );
  }

  // تجميع الاستحقاقات على الحساب الفعلي (fallback إلى salaryPayable لو الحساب المخصَّص مفقود)
  var creditMap = {}; // account_id -> { amount, label }
  var addCredit = function (account, amount, label) {
    if (amount <= 0) return;
    var acc = account || salaryPayable;
    if (!creditMap[acc.id]) creditMap[acc.id] = { amount: 0, label: label };
    creditMap[acc.id].amount = round2(creditMap[acc.id].amount + amount);
  };
  addCredit(salaryPayable, totalNet, "رواتب مستحقة الصرف");
  addCredit(taxPayable, sumTax, "ضرائب مستحقة");
  addCredit(insurancePayable, sumInsurance, "تأمينات مستحقة — حصة موظف");
  addCredit(
    otherDeductionsPayable,
    otherWithholdings,
    "خصومات وسلف موظفين مستحقة",
  );
  // [FIX-AUDIT-2026 #1] قسط السلفة يُخفِّض حساب "ذمم سلف موظفين" (أصل)
  // مباشرة بدل التجميع في التزام. Fallback إلى otherDeductionsPayable فقط
  // لو حساب السلف غير مُعدّ بعد، حفاظاً على توازن القيد رياضياً في كل الأحوال.
  addCredit(
    employeeLoanAccount || otherDeductionsPayable,
    sumLoan,
    "تحصيل قسط سلفة من الراتب — تخفيض ذمم سلف موظفين",
  );

  var creditLines = Object.keys(creditMap).map(function (accId) {
    return {
      account_id: accId,
      debit: 0,
      credit: creditMap[accId].amount,
      notes: creditMap[accId].label,
    };
  });

  var payDate = period.paid_at
    ? String(period.paid_at).split("T")[0]
    : period.end_date || new Date().toISOString().split("T")[0];

  // ─── القيد الأول: الاعتراف بمصروف الرواتب بالإجمالي ───
  // Dr. رواتب وأجور (Gross) / Cr. رواتب مستحقة + ضرائب مستحقة + تأمينات مستحقة + خصومات أخرى
  // [C12-FIX] استبدال addJournalEntry (يُنشئ DRAFT) بـ _addJournalEntryInternal (يُنشئ POSTED)
  // القيود التلقائية للنظام يجب أن تكون POSTED مباشرة — وليس DRAFT يحتاج موافقة يدوية
  // اللاتماثل القديم: مصروف DRAFT + دفعة POSTED = ميزان غير مكتمل في الأستاذ العام
  var employerInsuranceLines = [];
  if (
    sumEmployerInsurance > 0 &&
    employerInsuranceExpense &&
    employerInsurancePayable
  ) {
    employerInsuranceLines.push(
      {
        account_id: employerInsuranceExpense.id,
        debit: sumEmployerInsurance,
        credit: 0,
        notes: "مصروف تأمينات اجتماعية — حصة صاحب العمل",
      },
      {
        account_id: employerInsurancePayable.id,
        debit: 0,
        credit: sumEmployerInsurance,
        notes: "تأمينات مستحقة — حصة صاحب عمل",
      },
    );
  }

  var result1 = _addJournalEntryInternal({
    callerUser: callerUser || "SYSTEM",
    date: payDate,
    reference: period.id + "-EXP",
    source_type: "PAYROLL",
    description: "مصروف رواتب — " + (period.name || period.id),
    notes: "قيد الاعتراف بمصروف الرواتب بالإجمالي (بند 3 — خطة الإصلاحات)",
    lines: [
      {
        account_id: salaryExpense.id,
        debit: grossExpense,
        credit: 0,
        notes: "مصروف رواتب (إجمالي)",
      },
    ]
      .concat(creditLines)
      .concat(employerInsuranceLines), // [REMEDIATION-5]
  });

  // ─── القيد الثاني: الصرف الفعلي من الخزينة / البنك ───
  // [C-003 FIX] هذا القيد كان مفقوداً تماماً
  // Dr. رواتب مستحقة / Cr. الصندوق أو البنك
  var cashAccountId = _getPayrollCashAccount(period, accounts);

  if (cashAccountId) {
    var result2 = _addJournalEntryInternal({
      callerUser: callerUser || "SYSTEM",
      date: payDate,
      reference: period.id + "-CASH",
      source_type: "PAYROLL_PAYMENT",
      description: "صرف رواتب نقداً — " + (period.name || period.id),
      notes: "قيد صرف الرواتب من الخزينة",
      lines: [
        {
          account_id: salaryPayable.id,
          debit: totalNet,
          credit: 0,
          notes: "تسوية رواتب مستحقة",
        },
        {
          account_id: cashAccountId,
          debit: 0,
          credit: totalNet,
          notes: "صرف من الخزينة / البنك",
        },
      ],
    });
    if (!result2 || !result2.success) {
      Logger.log(
        "[C-003] تحذير: فشل قيد الصرف الفعلي للرواتب: " +
          (result2 ? result2.message : "unknown"),
      );
    }
  } else {
    Logger.log(
      "[C-003] تحذير: لا خزينة/بنك مربوط بالمسير — تم تسجيل المصروف فقط بدون قيد الصرف الفعلي",
    );
  }

  return result1;
}

function payPayroll(periodId, callerUser, sessionToken) {
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "payPayroll", sessionToken);
    if (_permErr) return _permErr;
    var rows = readSheet(
      "PayrollPeriods",
      ACCOUNTING_HR_HEADERS.PayrollPeriods,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === periodId;
    });
    if (idx === -1) return errResponse("فترة الرواتب غير موجودة");
    if (rows[idx].status !== "APPROVED")
      return errResponse("يجب اعتماد المسير أولاً قبل الصرف");

    // [C-03-FIX-2026-07] قفل ذري يمنع صرف مسير الرواتب مرتين (وبالتالي
    // ازدواج _autoJournalFromPayroll) بسبب ضغطتين متزامنتين — نفس نمط
    // approveReceiptVoucher (راجع تقرير المراجعة، المرحلة 3، ثغرة #5).
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بصرف آخر لنفس المسير، حاول مرة أخرى");
    }
    try {
      var rowsLocked = readSheet(
        "PayrollPeriods",
        ACCOUNTING_HR_HEADERS.PayrollPeriods,
        { trimStrings: true },
      );
      var idxLocked = rowsLocked.findIndex(function (r) {
        return r.id === periodId;
      });
      if (idxLocked === -1) return errResponse("فترة الرواتب غير موجودة");
      if (rowsLocked[idxLocked].status !== "APPROVED")
        return errResponse("يجب اعتماد المسير أولاً قبل الصرف — أو تم صرفه بالفعل");

    // [FIX-POSTING-AUDIT §3] كانت الفترة والسجلات تُحدَّث إلى "PAID" أولاً،
    // ثم يُستدعى _autoJournalFromPayroll داخل try/catch يبتلع أي فشل (بما
    // فيها غياب حسابات الرواتب، التي تجعل الدالة ترجع null بصمت) — فيمكن
    // صرف مسير رواتب كامل "بنجاح" في النظام بدون أي قيد محاسبي. الحل: نتحقق
    // إلزامياً من الحسابين الجوهريين *قبل* أي تحديث لحالة الفترة.
    var _payrollAccountsPre = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    try {
      requirePostingAccount(
        {
          accounts: _payrollAccountsPre,
          key: "salary_expense_account",
          type: "EXPENSE",
          hints: ["رواتب", "أجور", "عمالة", "salary", "wages", "payroll"],
        },
        "حساب مصروف الرواتب والأجور",
      );
      requirePostingAccount(
        {
          accounts: _payrollAccountsPre,
          key: "salary_payable_account",
          type: "LIABILITY",
          hints: [
            "رواتب مستحقة",
            "مستحقة الصرف",
            "salary payable",
            "payroll payable",
          ],
        },
        "حساب الرواتب المستحقة",
      );
    } catch (payrollPostingErr) {
      return errResponse(payrollPostingErr.message);
    }

    // تحديث حالة الفترة
    var sheet = getSheet(
      "PayrollPeriods",
      ACCOUNTING_HR_HEADERS.PayrollPeriods,
    );
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idxLocked + 2;
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]

    var statusCol = headers.indexOf("status");
    var paidAtCol = headers.indexOf("paid_at");

    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("PAID");
    if (paidAtCol !== -1) sheet.getRange(rowNum, paidAtCol + 1).setValue(now);

    // تحديث حالة سجلات الرواتب
    var prSheet = getSheet(
      "PayrollRecords",
      ACCOUNTING_HR_HEADERS.PayrollRecords,
    );
    var prRows = readSheet(
      "PayrollRecords",
      ACCOUNTING_HR_HEADERS.PayrollRecords,
      { trimStrings: true },
    );
    var prHeaders = prSheet
      .getRange(1, 1, 1, prSheet.getLastColumn())
      .getValues()[0];

    prRows.forEach(function (r, i) {
      if (r.payroll_period_id === periodId) {
        var psCol = prHeaders.indexOf("payment_status");
        var pdCol = prHeaders.indexOf("payment_date");
        if (psCol !== -1) prSheet.getRange(i + 2, psCol + 1).setValue("PAID");
        if (pdCol !== -1) prSheet.getRange(i + 2, pdCol + 1).setValue(now);
      }
    });

    try {
      _autoJournalFromPayroll(
        rowsLocked[idxLocked],
        prRows.filter(function (r) {
          return r.payroll_period_id === periodId;
        }),
        callerUser,
        sessionToken,
      );
    } catch (je) {
      Logger.log("Payroll Journal Error: " + je.message);
    }

    _invalidateServerCache(); // [FIX-ISSUE-009]
    return okResponse("تم صرف رواتب الفترة بنجاح");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في صرف الرواتب: " + e.message);
  }
}

function _getPayrollRecordsRaw(periodId) {
  var rows = readSheet(
    "PayrollRecords",
    ACCOUNTING_HR_HEADERS.PayrollRecords,
    { trimStrings: true },
  );
  if (periodId)
    rows = rows.filter(function (r) {
      return r.payroll_period_id === periodId;
    });

  // إثراء
  var emps = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
    trimStrings: true,
  });
  rows.forEach(function (r) {
    var e = emps.find(function (emp) {
      return emp.id === r.employee_id;
    });
    r.employee_name = e ? e.full_name : "";
    r.employee_number = e ? e.employee_number : "";
  });

  return { success: true, data: rows };
}

function getPayrollRecords(periodId, callerUser, sessionToken) {
  try {
    // [PERM-AUDIT-FIX-5] الأخطر في هذا التدقيق: كانت هذه الدالة (البيانات
    // الفعلية للرواتب — الراتب الأساسي وكل البنود) بلا أي فحص صلاحية
    // وبلا استدعاء _filterSalaryFields، رغم كل المجهود الموثّق بالمشروع
    // لإخفاء الراتب خلف "viewSalary" في أماكن أخرى (getEmployees مثلاً).
    if (callerUser) {
      var _permErr = _checkPermission(callerUser, "viewPayroll", sessionToken);
      if (_permErr) return _permErr;
    }
    return _getPayrollRecordsRaw(periodId);
  } catch (e) {
    return errResponse("خطأ في جلب سجلات الرواتب: " + e.message);
  }
}

/**
 * getPayslip — كشف راتب فردي
 * [PERM-AUDIT-FIX-5 / ملاحظة متبقية] الفحص هنا مبني على صلاحية
 * "viewPayslip" (تشمل دور "user" ليقدر الموظف يشوف كشف راتبه)، لكن لا
 * يوجد حاليًا أي حقل يربط حساب المستخدم (Users) بسجل الموظف (Employees)
 * — فبالتالي مفيش تحقق فعلي إن "employeeId" المطلوب هو فعلاً موظف
 * المستخدم نفسه. أي مستخدم بدور "user" يقدر يطلب كشف راتب أي موظف تاني
 * بمجرد معرفة رقمه. الإصلاح الكامل لهذه النقطة يحتاج إضافة حقل ربط
 * (مثل employee_id في صف المستخدم) وهو تغيير في نموذج البيانات خارج
 * نطاق هذا التدقيق — تم توثيقه هنا صراحة بدل تجاهله.
 */
function getPayslip(periodId, employeeId, callerUser, sessionToken) {
  try {
    if (callerUser) {
      var _permErr = _checkPermission(
        callerUser,
        "viewPayslip",
        sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var records = _getPayrollRecordsRaw(periodId);
    if (!records.success) return records;

    var record = records.data.find(function (r) {
      return r.employee_id === employeeId;
    });
    if (!record)
      return errResponse(
        "لم يتم العثور على سجل راتب لهذا الموظف في هذه الفترة",
      );

    // إثراء بيانات الموظف
    var emp = getEmployee(employeeId);
    if (emp.success) {
      record.employee = emp.data;
    }

    // فترة الرواتب
    var periods = readSheet(
      "PayrollPeriods",
      ACCOUNTING_HR_HEADERS.PayrollPeriods,
      { trimStrings: true },
    );
    var period = periods.find(function (p) {
      return p.id === periodId;
    });
    if (period) {
      record.period_name = period.name;
      record.period_year = period.year;
      record.period_month = period.month;
    }

    return { success: true, data: record };
  } catch (e) {
    return errResponse("خطأ في جلب كشف الراتب: " + e.message);
  }
}
