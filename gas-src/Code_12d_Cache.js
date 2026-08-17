/**
 * ============================================================
 * Module: Code_12d_Cache.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * يحفظ البيانات في CacheService
 * CacheService محدودة بـ 100KB per key — يقسّم لو البيانات أكبر
 * @param {Object} data
 * @param {string} [cacheKey] مفتاح الكاش (افتراضياً SERVER_CACHE_KEY)
 * @param {number} [ttl] مدة الصلاحية بالثواني (افتراضياً SERVER_CACHE_TTL)
 */
function _saveServerCache(data, cacheKey, ttl) {
  try {
    cacheKey = cacheKey || SERVER_CACHE_KEY;
    ttl = ttl || SERVER_CACHE_TTL;
    var cache = CacheService.getScriptCache();
    var json = JSON.stringify(data);

    if (json.length < 90000) {
      cache.put(cacheKey, json, ttl);
      cache.put(cacheKey + "_chunks", "1", ttl);
      return;
    }

    var chunkSize = 85000;
    var chunks = [];
    for (var i = 0; i < json.length; i += chunkSize) {
      chunks.push(json.slice(i, i + chunkSize));
    }
    for (var j = 0; j < chunks.length; j++) {
      cache.put(cacheKey + "_" + j, chunks[j], ttl);
    }
    cache.put(cacheKey + "_chunks", String(chunks.length), ttl);
  } catch (e) {
    console.warn("_saveServerCache error: " + e.message);
  }
}

/**
 * يقرأ البيانات من CacheService
 * يرجع null لو الكاش فارغ أو منتهي
 * @param {string} [cacheKey] مفتاح الكاش (افتراضياً SERVER_CACHE_KEY)
 */
function _loadServerCache(cacheKey) {
  try {
    cacheKey = cacheKey || SERVER_CACHE_KEY;
    var cache = CacheService.getScriptCache();
    var chunksStr = cache.get(cacheKey + "_chunks");
    if (!chunksStr) return null;

    var numChunks = parseInt(chunksStr, 10);
    if (numChunks === 1) {
      var raw = cache.get(cacheKey);
      return raw ? JSON.parse(raw) : null;
    }

    var json = "";
    for (var i = 0; i < numChunks; i++) {
      var chunk = cache.get(cacheKey + "_" + i);
      if (!chunk) return null;
      json += chunk;
    }
    return JSON.parse(json);
  } catch (e) {
    console.warn("_loadServerCache error: " + e.message);
    return null;
  }
}

/**
 * 🛠️ forceFixPermissionsCacheNow — شغّلها يدوياً من محرر Apps Script
 * (اختر الدالة من القائمة المنسدلة جنب زرار ▶ Run) لو حد (حتى الأدمن)
 * شايف رسالة "ليس لديك صلاحية" لشاشة موجودة فعلاً في ALL_PERMISSIONS.
 * بتمسح كل كاش getAllData / AI القديم فوراً بدل انتظار 25 دقيقة.
 * بعد التحديث الحالي (مفتاح الكاش بقى مرتبط ببصمة الصلاحيات) المفروض
 * مش هتحتاجها غالباً، لكنها سايبها كحل سريع لو حصلت أي حالة مشابهة.
 */
function forceFixPermissionsCacheNow() {
  try {
    var cache = CacheService.getScriptCache();
    cache.removeAll([
      "wms_alldata_v1_chunks",
      "wms_alldata_v1",
      "wms_ai_snapshot_v1_chunks",
      "wms_ai_snapshot_v1",
    ]);
  } catch (e) {
    console.error("forceFixPermissionsCacheNow - خطأ:", e.message || e);
  }
  _invalidateServerCache();
  Logger.log("✅ تم مسح كاش getAllData القديم — جرّب تسجّل دخول تاني.");
}

/**
 * يُبطل (يمسح) كاش getAllData الرئيسي وكاش بيانات الذكاء الاصطناعي
 * معًا، بالإضافة لأي مفتاح كاش إضافي يُمرَّر صراحةً. يُستدعى بعد أي
 * عملية تعديل تؤثر على البيانات المُجمَّعة (إضافة/تعديل/حذف أي كيان
 * أساسي) حتى لا يرى المستخدمون بيانات قديمة من الكاش.
 *
 * @param {String} [cacheKey] - مفتاح كاش إضافي مطلوب مسحه (اختياري).
 */
function _invalidateServerCache(cacheKey) {
  _clearOneServerCache(SERVER_CACHE_KEY);
  _clearOneServerCache(AI_DATA_CACHE_KEY);
  // [PERF-FIX-BYLEVEL-CACHE] لازم نمسح كاش getAllDataByLevel كمان، وإلا
  // شاشات زي "الأصناف" (بتتغذى من level 2) هتفضل شايفة بيانات قديمة من
  // الكاش الجديد رغم إن getAllData الرئيسية بتتحدث صح. بنمسح كل
  // التركيبات الفعلية اللي بتُستدعى من الواجهة (شوف 01_JS_Core_Auth.html:
  // levels [2] و[3] و[3]+auth و[4]).
  try {
    var _fp = _permissionsFingerprint();
    ["2", "3", "3_auth", "4"].forEach(function (suffix) {
      _clearOneServerCache("wms_bylevel_v1_" + suffix + "_" + _fp);
    });
  } catch (e) {
    console.error("_invalidateServerCache - فشل مسح كاش getAllDataByLevel:", e.message || e);
  }
  // [FIX] كاش getAllDataLight (تسجيل الدخول السريع) كان بيتمسّح لوحده مش
  // بيتمسّح هنا — فأي حذف/تعديل كان بيفضل "مختفي" فوريًا (لأن getAllData
  // بيتحدّث صح) لكن يرجع تاني لو المستخدم عمل ريفريش للصفحة خلال 5 دقايق
  // (مدة صلاحية الكاش الخفيف)، لأنه كان بيرجّع لقطة قديمة قبل الحذف.
  // [PERF-LIGHT-CHUNK-FIX] wms_light_v1 دلوقتي بيُكتَب عبر _saveServerCache
  // (تقسيم تلقائي فوق 90KB — راجع _getAllDataLightRaw في
  // Code_12l_GetAllData.js)، يعني ممكن يكون متقسّم لعدة مفاتيح فعليًا.
  // لازم نمسحه بنفس أداة المسح المدركة للتقسيم (_clearOneServerCache)
  // بدل cache.remove() المباشرة القديمة اللي كانت بتمسح مفتاح واحد بس
  // وتسيب باقي الأجزاء (لو كان فيه تقسيم) قابعة كبيانات قديمة يتيمة.
  try {
    _clearOneServerCache(LIGHT_CACHE_KEY);
  } catch (e) {
    console.error("_invalidateServerCache - فشل مسح كاش getAllDataLight:", e.message || e);
  }
  // [FIX-REFRESH-BTN-GAP-2026-08-07] الحقول المرجعية (colors/sizes/
  // sizeGroups/units) بتتقرأ عبر CacheEngine.getOrCompute بمساحة أسماء
  // (namespace) REFERENCE منفصلة تمامًا عن SERVER_CACHE_KEY/LIGHT_CACHE_KEY
  // فوق — كل دالة إضافة/تعديل/حذف بتاعتها (addUnit/addColor/addSize...)
  // بتمسح مفتاحها الخاص صح، لكن زر "تحديث البيانات" العام (reloadAfterMutationFull
  // → getAllDataFresh → هنا) كان بيتجاهلها تمامًا: لو صف اتضاف يدويًا في
  // الشيت (بدون المرور على addUnit مثلاً) أو أي تضارب كاش حصل، الزر ده
  // كان بيرجّع كل حاجة Fresh إلا هي — تفضل عالقة على نسخة قديمة (تصل
  // لحد 6 ساعات) حتى بعد "تحديث كامل". دلوقتي بيتمسحوا هنا كمان.
  try {
    CacheEngine.invalidateMany(CacheEngine.NAMESPACE.REFERENCE, [
      "colors",
      "sizes",
      "sizeGroups",
      "units",
    ]);
  } catch (e) {
    console.error("_invalidateServerCache - فشل مسح كاش REFERENCE:", e.message || e);
  }
  if (
    cacheKey &&
    cacheKey !== SERVER_CACHE_KEY &&
    cacheKey !== AI_DATA_CACHE_KEY
  ) {
    _clearOneServerCache(cacheKey);
  }
}

/**
 * [PERF-SCOPED-INVALIDATION-HR] نسخة مُخصَّصة (Scoped) لموديول الـ HR من
 * _invalidateServerCache() العامة. الفرق: بدل مسح *كل* مفاتيح الكاش
 * الموحّد (بما فيها بيانات لا علاقة لها إطلاقاً بالـ HR — snapshot الذكاء
 * الاصطناعي، الحزمة الخفيفة لتسجيل الدخول، مراجع الألوان/الوحدات...)،
 * هذه الدالة تمسح فقط المفاتيح اللي فعلاً بتحتوي بيانات HR، بناءً على
 * فحص فعلي لكل مصدر (راجع DATA_REGISTRY في Code_53_DataRegistryEngine.js
 * و _loadAllData في Code_08_AIAssistant.js):
 *
 *   - wms_alldata_v1 (SERVER_CACHE_KEY) — ✅ يُمسح: يضم حقول HR
 *     (hrEmployees, hrAttendance, hrDepartments...) ضمن DATA_LEVEL.BACKGROUND.
 *   - wms_bylevel_v1_3 / _3_auth — ✅ يُمسح: هو بالضبط تخزين مستوى
 *     BACKGROUND (=3) اللي فيه كل حقول HR.
 *   - wms_ai_snapshot_v2 (AI_DATA_CACHE_KEY) — ❌ لا يُمسح: _loadAllData()
 *     تقرأ فقط Items/Stock/Groups/Warehouses/Transactions/ProductionOrders؛
 *     لا يوجد أي حقل HR فيها إطلاقاً.
 *   - wms_light_v1 (LIGHT_CACHE_KEY) — ❌ لا يُمسح: حقول HR غير معلَّمة
 *     بـ lightBundle:true في DATA_REGISTRY، فهي أصلاً غير موجودة في هذه
 *     الحزمة.
 *   - wms_bylevel_v1_2 / _4 (ON_DEMAND / REFERENCE) — ❌ لا يُمسح: كل
 *     حقول HR مُسجَّلة بمستوى BACKGROUND (3) فقط، مفيش أي منها في
 *     المستويين دول.
 *   - REFERENCE namespace (colors/sizes/sizeGroups/units) — ❌ لا يُمسح:
 *     لا علاقة لها بالـ HR.
 *
 * النتيجة: أي حفظ/تعديل/حذف في HR (موظف، حضور، إجازة، سلفة، راتب،
 * قسم...) لسه بيُبطل كل حاجة فيها بيانات HR فعليًا (زيرو مخاطرة على
 * صحة البيانات)، لكن من غير ما يجبر إعادة قراءة/بناء بيانات المخزون
 * والمبيعات والعملاء والموردين والمحاسبة من الشيتات في أول طلب getAllData
 * جاي من أي مستخدم تاني — وهو اللي كان بيحصل فعليًا مع _invalidateServerCache()
 * العامة قبل كده.
 *
 * ملاحظة: لو أي حقل HR جديد اتضاف مستقبلاً بمستوى غير BACKGROUND، أو
 * ظهر داخل AI snapshot أو الحزمة الخفيفة، لازم هذه الدالة تتحدّث معاه.
 */
function _invalidateServerCacheHR() {
  _invalidateServerCacheBackgroundOnly("_invalidateServerCacheHR");
}

/**
 * [PERF-SCOPED-INVALIDATION-BANKING] نفس مبدأ _invalidateServerCacheHR()
 * بالظبط، لكن لموديول البنوك/الخزينة (Code_09_Banking.js). تحقّقت من
 * DATA_REGISTRY: كل حقول البنوك (accCheques, accBankAccounts,
 * accBankReconciliations, accCashBoxes, accReceiptVouchers,
 * accPaymentVouchers, accExpenses, accTransferVouchers) مسجَّلة بمستوى
 * DATA_LEVEL.BACKGROUND (=3) فقط — زي HR بالضبط — وولا واحد فيها معلَّم
 * lightBundle:true، وولا واحد فيها ظاهر داخل AI snapshot (_loadAllData
 * في Code_08_AIAssistant.js بتقرأ Items/Stock/Groups/Warehouses/
 * Transactions/Opening/ProductionOrders بس). فنفس النطاق (SERVER_CACHE_KEY
 * + bylevel مستوى 3) كافٍ وآمن هنا كمان.
 */
function _invalidateServerCacheBanking() {
  _invalidateServerCacheBackgroundOnly("_invalidateServerCacheBanking");
}

/**
 * الدالة المشتركة الفعلية وراء كل الـ wrappers أعلاه (HR، Banking، وأي
 * موديول تاني بياناته كلها مسجَّلة بمستوى BACKGROUND فقط وغير موجودة في
 * AI snapshot أو الحزمة الخفيفة). لو أضفت wrapper جديد لموديول جديد،
 * تأكد أولاً (زي ما اتعمل هنا بالفحص الفعلي) إن كل حقوله فعلاً BACKGROUND
 * فقط قبل ما تربطه بنفس النطاق ده.
 *
 * @param {String} callerLabel - اسم الدالة المستدعية (للّوج فقط عند الخطأ)
 */
function _invalidateServerCacheBackgroundOnly(callerLabel) {
  _clearOneServerCache(SERVER_CACHE_KEY);
  try {
    var _fp = _permissionsFingerprint();
    ["3", "3_auth"].forEach(function (suffix) {
      _clearOneServerCache("wms_bylevel_v1_" + suffix + "_" + _fp);
    });
  } catch (e) {
    console.error(
      (callerLabel || "_invalidateServerCacheBackgroundOnly") +
        " - فشل مسح كاش getAllDataByLevel:",
      e.message || e,
    );
  }
}

/**
 * [PERF-SCOPED-INVALIDATION-INVENTORY] نسخة مُخصَّصة لموديول المخزون/الأصناف
 * (Code_16_Inventory.js). النطاق هنا مختلف عن HR/Banking لأن بيانات
 * الأصناف/المخزون منتشرة فعلاً في كل الكاشات دي (تحقّقت من كل مصدر قبل
 * الاستبعاد، مش افتراض):
 *
 *   - wms_alldata_v1 (SERVER_CACHE_KEY) — ✅ يُمسح: items/stock مسجَّلين
 *     DATA_LEVEL.ON_DEMAND وداخلين في بناء الحزمة الموحّدة.
 *   - wms_light_v1 (LIGHT_CACHE_KEY) — ✅ يُمسح: items/stock/warehouses/
 *     groups/openingStock كلهم معلَّمين صراحةً lightBundle:true (الداشبورد
 *     بيعرض عدد/قيمة الأصناف والمخزون فوراً عند تسجيل الدخول).
 *   - wms_ai_snapshot_v2 (AI_DATA_CACHE_KEY) — ✅ يُمسح: _loadAllData في
 *     Code_08_AIAssistant.js بتقرأ Items/Stock/Groups/Warehouses مباشرة.
 *   - wms_bylevel_v1_2 (ON_DEMAND) — ✅ يُمسح: نفس مستوى items/stock.
 *   - wms_bylevel_v1_3 / _3_auth (BACKGROUND — HR/محاسبة/بنوك) — ❌ لا
 *     يُمسح: لا علاقة لأي حقل مخزون بهذا المستوى.
 *   - wms_bylevel_v1_4 (REFERENCE) + REFERENCE namespace (colors/sizes/
 *     sizeGroups/units) — ❌ لا يُمسح: تعديل صنف لا يغيّر جدول الألوان/
 *     المقاسات/الوحدات نفسه (لها دوال إضافة/تعديل خاصة بها بالفعل تمسح
 *     كاشها بمفردها — راجع addColor/addUnit وغيرها).
 */
function _invalidateServerCacheInventory() {
  _clearOneServerCache(SERVER_CACHE_KEY);
  _clearOneServerCache(AI_DATA_CACHE_KEY);
  _clearOneServerCache(LIGHT_CACHE_KEY);
  try {
    var _fp = _permissionsFingerprint();
    _clearOneServerCache("wms_bylevel_v1_2_" + _fp);
  } catch (e) {
    console.error(
      "_invalidateServerCacheInventory - فشل مسح كاش getAllDataByLevel:",
      e.message || e,
    );
  }
}

/**
 * الدالة العامة وراء كل الـ scoped wrappers (HR/Banking/Inventory وما
 * بعدهم). كل باراميتر بوليان يقابل كاش محدد — الـ wrapper المستدعي هو
 * المسؤول عن التأكد (بفحص فعلي في DATA_REGISTRY / _loadAllData) إن
 * الكاش المطلوب مسحه فعلاً بيحتوي بيانات الموديول ده قبل ما يبعته true.
 *
 * @param {Object} opts
 * @param {Boolean} [opts.level2]  امسح wms_bylevel_v1_2 (ON_DEMAND)
 * @param {Boolean} [opts.level3]  امسح wms_bylevel_v1_3 / _3_auth (BACKGROUND)
 * @param {Boolean} [opts.ai]      امسح AI_DATA_CACHE_KEY
 * @param {Boolean} [opts.light]   امسح LIGHT_CACHE_KEY
 * @param {String}  [callerLabel]  اسم الدالة المستدعية (للّوج فقط)
 */
function _invalidateServerCacheScoped(opts, callerLabel) {
  opts = opts || {};
  _clearOneServerCache(SERVER_CACHE_KEY); // الحزمة الموحّدة دايماً بتتمسح
  if (opts.ai) _clearOneServerCache(AI_DATA_CACHE_KEY);
  if (opts.light) _clearOneServerCache(LIGHT_CACHE_KEY);
  try {
    var _fp = _permissionsFingerprint();
    var suffixes = [];
    if (opts.level2) suffixes.push("2");
    if (opts.level3) {
      suffixes.push("3");
      suffixes.push("3_auth");
    }
    suffixes.forEach(function (suffix) {
      _clearOneServerCache("wms_bylevel_v1_" + suffix + "_" + _fp);
    });
  } catch (e) {
    console.error(
      (callerLabel || "_invalidateServerCacheScoped") +
        " - فشل مسح كاش getAllDataByLevel:",
      e.message || e,
    );
  }
}

/**
 * [PERF-SCOPED-INVALIDATION-PARTIES] Code_20a_Parties.js (عملاء/موردين).
 * customers/suppliers مسجَّلين DATA_LEVEL.ON_DEMAND، بلا lightBundle،
 * وغير موجودين في AI snapshot (_loadAllData) → مستوى 2 بس + الحزمة
 * الموحّدة، من غير AI/light/BACKGROUND/REFERENCE.
 */
function _invalidateServerCacheParties() {
  _invalidateServerCacheScoped(
    { level2: true },
    "_invalidateServerCacheParties",
  );
}

/**
 * [PERF-SCOPED-INVALIDATION-INVOICES] Code_20c_Invoices.js (فواتير بيع/
 * شراء). saleInvoices/purchaseInvoices مسجَّلين ON_DEMAND، بلا
 * lightBundle، وغير موجودين في AI snapshot → نفس نطاق Parties بالضبط.
 */
function _invalidateServerCacheInvoices() {
  _invalidateServerCacheScoped(
    { level2: true },
    "_invalidateServerCacheInvoices",
  );
}

/**
 * [PERF-SCOPED-INVALIDATION-VOUCHERS] Code_06_Accounting_Vouchers.js
 * وCode_04_Accounting_JournalEntries.js (سندات قبض/صرف/تحويل، قيود
 * يومية). كلها accReceiptVouchers/accPaymentVouchers/accTransferVouchers/
 * accJournalEntries — مسجَّلين DATA_LEVEL.BACKGROUND بالظبط زي HR/Banking
 * (نفس الفحص)، فبتستخدم نفس النطاق المشترك مباشرة.
 */
function _invalidateServerCacheVouchers() {
  _invalidateServerCacheBackgroundOnly("_invalidateServerCacheVouchers");
}

/**
 * [PERF-SCOPED-INVALIDATION-PRODUCTION] Code_17_Manufacturing.js و
 * Code_17b_ProductionOrders.js. productionOrders مسجَّل ON_DEMAND، بلا
 * lightBundle، لكنه *موجود* داخل AI snapshot (_loadAllData بتقرأ
 * ProductionOrders مباشرة) → مستوى 2 + AI، من غير light/BACKGROUND/REFERENCE.
 */
function _invalidateServerCacheProduction() {
  _invalidateServerCacheScoped(
    { level2: true, ai: true },
    "_invalidateServerCacheProduction",
  );
}

/**
 * [PERF-SCOPED-INVALIDATION-OPENING-BALANCES] Code_12f_OpeningBalances.js.
 * بتكتب على شيت OpeningStock — يقابل حقل openingStock في DATA_REGISTRY:
 * ON_DEMAND + lightBundle:true (الداشبورد يعرض رصيد افتتاحي فوري)، وموجود
 * كمان داخل AI snapshot (_loadAllData بتقرأ OpeningStock كـ opening) →
 * نفس نطاق Inventory بالضبط (مستوى 2 + AI + light).
 */
function _invalidateServerCacheOpeningBalances() {
  _invalidateServerCacheScoped(
    { level2: true, ai: true, light: true },
    "_invalidateServerCacheOpeningBalances",
  );
}

/**
 * [PERF-SCOPED-INVALIDATION-UNITS] Code_55_Units.js. units مسجَّل
 * DATA_LEVEL.REFERENCE + lightBundle:true، وغير موجود في AI snapshot →
 * الحزمة الموحّدة + light + مستوى 4 فقط. ملحوظة: نداء
 * CacheEngine.invalidate(REFERENCE, "units") المجاور في نفس الدوال
 * (خارج هذه الدالة) هو آلية كاش منفصلة تمامًا وسايبها زي ما هي.
 */
function _invalidateServerCacheUnits() {
  _clearOneServerCache(SERVER_CACHE_KEY);
  _clearOneServerCache(LIGHT_CACHE_KEY);
  try {
    var _fp = _permissionsFingerprint();
    _clearOneServerCache("wms_bylevel_v1_4_" + _fp);
  } catch (e) {
    console.error(
      "_invalidateServerCacheUnits - فشل مسح كاش getAllDataByLevel:",
      e.message || e,
    );
  }
}

/**
 * [PERF-SCOPED-INVALIDATION-CASHBOXES] Code_01_Accounting_CashBoxes.js.
 * accCashBoxes مسجَّل DATA_LEVEL.BACKGROUND — نفس نطاق HR/Banking/Vouchers.
 */
function _invalidateServerCacheCashBoxes() {
  _invalidateServerCacheBackgroundOnly("_invalidateServerCacheCashBoxes");
}

/**
 * [PERF-SCOPED-INVALIDATION-ONDEMAND-ONLY] نطاق عام لأي موديول بياناته
 * ON_DEMAND فقط، بلا lightBundle، وغير موجودة في AI snapshot — تحقّقنا
 * من هذا الشرط لكل موديول قبل ربطه هنا:
 *   - PartyCategories (customerCategories/supplierCategories)
 *   - Shipping (shipments)
 * كلاهما ON_DEMAND بلا lightBundle وغير موجودين في _loadAllData.
 */
function _invalidateServerCacheOnDemandOnly(callerLabel) {
  _invalidateServerCacheScoped(
    { level2: true },
    callerLabel || "_invalidateServerCacheOnDemandOnly",
  );
}
function _invalidateServerCachePartyCategories() {
  _invalidateServerCacheOnDemandOnly("_invalidateServerCachePartyCategories");
}
function _invalidateServerCacheShipping() {
  _invalidateServerCacheOnDemandOnly("_invalidateServerCacheShipping");
}

/**
 * [PERF-SCOPED-INVALIDATION-CHART-OF-ACCOUNTS] Code_02_Accounting_ChartOfAccounts.js.
 * chartOfAccounts مسجَّل ON_DEMAND + lightBundle:true (معتمد عليه في
 * شاشات كتير من فتح التطبيق مباشرة حسب تعليق الـ registry نفسه)، وغير
 * موجود في AI snapshot → مستوى 2 + light.
 */
function _invalidateServerCacheChartOfAccounts() {
  _invalidateServerCacheScoped(
    { level2: true, light: true },
    "_invalidateServerCacheChartOfAccounts",
  );
}

/**
 * [PERF-SCOPED-INVALIDATION-FIXED-ASSETS] Code_14_FixedAssets.js.
 * accFixedAssets مسجَّل DATA_LEVEL.BACKGROUND — نفس نطاق HR/Banking.
 */
function _invalidateServerCacheFixedAssets() {
  _invalidateServerCacheBackgroundOnly("_invalidateServerCacheFixedAssets");
}

/** يمسح مفتاح كاش واحد (مع كل الأجزاء المقسّمة الخاصة به) */
function _clearOneServerCache(cacheKey) {
  try {
    var cache = CacheService.getScriptCache();
    var chunksStr = cache.get(cacheKey + "_chunks");
    if (!chunksStr) return;
    var numChunks = parseInt(chunksStr, 10);
    var keys = [cacheKey + "_chunks"];
    if (numChunks === 1) {
      keys.push(cacheKey);
    } else {
      for (var i = 0; i < numChunks; i++) {
        keys.push(cacheKey + "_" + i);
      }
    }
    cache.removeAll(keys);
  } catch (e) {
    console.error("_clearOneServerCache - خطأ:", e.message || e);
  }
}

/** يمسح الكاش يدوياً من الواجهة */
function clearServerCache() {
  _invalidateServerCache();
  return okResponse("✅ تم مسح كاش السيرفر");
}

/**
 * يجدد الكاش في الخلفية — يُستدعى من الـ trigger كل 4 دقائق
 * بيقرأ البيانات من Sheets ويحطها في CacheService
 */
function warmCache() {
  try {
    var data = _getAllDataRaw(); // بيقرأ من Sheets ويحفظ في الكاش تلقائياً
    Logger.log(
      "warmCache: cache refreshed, items=" + (data.items || []).length,
    );
  } catch (e) {
    console.warn("warmCache error: " + e.message);
  }

  // [FIX-VERSION-SYNC] تحديث كاش Updates Hub (المركزي) كل 15 دقيقة هنا
  // كمان، مش بس عند أول لوجين. قبل كده لو محدش سجّل دخول لفترة طويلة
  // (نظام هادي، أو نشر جديد حصل بالليل مثلًا)، كل أماكن عرض رقم
  // الإصدار (شاشة اللوجين تحديدًا، لأنها من غير تسجيل دخول) كانت
  // بتفضل عارضة آخر رقم اتحفظ من زمان بدل الرقم المنشور فعليًا —
  // دلوقتي بتتحدّث تلقائي بانتظام حتى من غير أي حركة مستخدمين.
  try {
    if (typeof getUpdatesFromHub === "function") {
      getUpdatesFromHub();
    }
  } catch (e2) {
    console.warn("warmCache: hub version refresh error: " + e2.message);
  }

  // [LICENSE-STATUS] نفس فكرة تحديث كاش الإصدار فوق، لكن لحالة
  // الترخيص/الاشتراك — عشان شاشة اللوجين (وأي إنفاذ في login()) يفضلوا
  // شايفين حالة محدّثة خلال آخر 15 دقيقة كحد أقصى حتى من غير أي حركة
  // مستخدمين (نظام هادي بالليل مثلًا واشتراك انتهى وقتها).
  try {
    if (typeof getLicenseStatusFromHub === "function") {
      getLicenseStatusFromHub();
    }
  } catch (e3) {
    console.warn("warmCache: license status refresh error: " + e3.message);
  }
}

/**
 * يركب trigger يشغّل warmCache كل 20 دقيقة
 * شغّلها مرة واحدة من Apps Script Editor
 */
function setupWarmCacheTrigger(existingTriggers) {
  // امسح أي trigger قديم عشان ما يتكرروش
  // ✅ [PERF-TRIGGERS-1] استخدم القايمة الجاهزة من setupEverything لو موجودة
  var triggers = existingTriggers || ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "warmCache") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // ركّب trigger جديد كل 15 دقيقة — [PERF-FIX-1] كان 20 دقيقة فكانت فجوة 5 دقائق
  // قبل انتهاء الـ TTL (25 دقيقة) يتجدد الكاش بأمان
  ScriptApp.newTrigger("warmCache").timeBased().everyMinutes(15).create();
  Logger.log("✅ warmCache trigger installed: every 15 minutes");
}

/**
 * يلغي الـ trigger لو محتاج تقفله
 */
function removeWarmCacheTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "warmCache") {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log("removeWarmCacheTrigger: removed " + removed + " trigger(s)");
}

function _invalidateExtCache() {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove(EXT_DATA_CACHE_KEY); // legacy key — تنظيف احتياطي فقط
    cache.remove(EXT_DATA_CORE_CACHE_KEY);
    cache.remove(EXT_DATA_LAZY_CACHE_KEY);
    cache.remove(EXT_DATA_LAZY_ACC_CACHE_KEY);
    cache.remove(EXT_DATA_LAZY_HR_CACHE_KEY);
    cache.remove(EXT_DATA_LAZY_FIN_CACHE_KEY); // [PERF-FINANCE-LIGHT-2026-08-08]
    cache.remove(EXT_DATA_CACHE_KEY + "_chunks");
    cache.remove(EXT_DATA_CORE_CACHE_KEY + "_chunks");
    cache.remove(EXT_DATA_LAZY_CACHE_KEY + "_chunks");
    cache.remove(EXT_DATA_LAZY_ACC_CACHE_KEY + "_chunks");
    cache.remove(EXT_DATA_LAZY_HR_CACHE_KEY + "_chunks");
    cache.remove(EXT_DATA_LAZY_FIN_CACHE_KEY + "_chunks");
    for (var i = 0; i < 10; i++) {
      cache.remove(EXT_DATA_CACHE_KEY + "_" + i);
      cache.remove(EXT_DATA_CORE_CACHE_KEY + "_" + i);
      cache.remove(EXT_DATA_LAZY_CACHE_KEY + "_" + i);
      cache.remove(EXT_DATA_LAZY_ACC_CACHE_KEY + "_" + i);
      cache.remove(EXT_DATA_LAZY_HR_CACHE_KEY + "_" + i);
      cache.remove(EXT_DATA_LAZY_FIN_CACHE_KEY + "_" + i);
    }
    // [PERF-HR-DASH] أي عملية تستدعي _invalidateExtCache (إضافة حضور، طلب
    // إجازة/سلفة، اعتماد/رفض...) لازم كمان تُسقط كاش لوحة HR لو موجود،
    // وإلا هتفضل اللوحة تعرض أرقام قديمة لمدة تصل لـ 90 ثانية.
    cache.remove(HR_DASH_CACHE_KEY);
  } catch (e) {
    console.error("_invalidateExtCache - خطأ:", e.message || e);
  }
}

