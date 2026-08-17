// ══════════════════════════════════════════════════════════════════════════
// Code_21b_Migrations.js — دوال ترقية البيانات لمرة واحدة (One-off Migrations)
// ──────────────────────────────────────────────────────────────────────────
// [MAINT-FIX-4] استُخرجت من Code_21_Setup.js بناءً على TODO الأصلي
// ("نقل دوال الـ migration إلى ملف منفصل Migrations.js") المذكور في تقرير
// المراجعة (المشكلة #4 — Medium/Maintainability). كل الدوال هنا هي نسخة
// حرفية من غير أي تغيير في المنطق أو أسماء الدوال (Backward-compatible)،
// فأي استدعاء قديم لها (من الواجهة أو من Apps Script Editor) هيفضل شغال
// زي ما هو بالظبط.
//
// طبيعة الدوال هنا: كل دالة تُشغَّل مرة واحدة يدويًا (من Apps Script Editor
// → اختيار الدالة → Run) بعد رفع كود جديد بيغيّر بنية شيت معينة. آمنة
// التكرار (idempotent) في أغلبها، لكن دايمًا اتأكد من عمل نسخة احتياطية
// (Backup) قبل تشغيل أي migration على بيئة إنتاج فيها بيانات عميل حقيقية.
// ══════════════════════════════════════════════════════════════════════════

// ── [نُقل من §24 — System Setup & Migrations + File Upload + Excel Import + Weekly Reports + Color Resolution] ──

// ┄┄┄ [مصدر: Code.js سطور 9615-12586] System Setup/Migrations + File Upload + Excel Import + Weekly Reports + Color Resolution ┄┄┄
// §24  System Setup & Migrations
//
// initializeSystem()  — إعداد الشيتات والمستخدمين الافتراضيين
// [MAINT-FIX-4] تم بالفعل: دوال الـ migration اتنقلت لملف منفصل
// (هذا الملف نفسه) — راجع التعليق التوثيقي في أول الملف.
// ─────────────────────────────────────────────────────────────

/**
 * _seedDefaultCompanyIfEmpty — [DEFAULT-COMPANY-1] يضبط اسم الشركة
 * الافتراضي "الشركة الرئيسية" في شيت Settings (لو مفيش اسم متسجّل
 * أصلاً)، عبر _saveCompanySettings() الموجودة (Code_08_AIAssistant.js)
 * — نفس المسار اللي شاشة إعدادات الشركة في الواجهة بتستخدمه، فمفيش
 * منطق مكرر.
 *
 * Idempotent: لو company_name متسجّل بالفعل (بأي قيمة)، بيتخطاها
 * ومبيغيّرش قيمة موجودة بالغلط.
 */
function _seedDefaultCompanyIfEmpty() {
  try {
    var settings = readSheet("Settings", null, { trimStrings: true });
    var existing = (settings || []).find(function (s) {
      return s.key === "company_name" || s.key === "shop_name";
    });
    if (existing && String(existing.value || "").trim()) {
      return "↩️ اسم الشركة متسجّل أصلاً (" + existing.value + ") — تخطّي";
    }

    _saveCompanySettings({
      company_name: DEFAULT_COMPANY_NAME,
      shop_name: DEFAULT_COMPANY_NAME,
      default_branch: DEFAULT_BRANCH_NAME,
    });

    Logger.log(
      "[_seedDefaultCompanyIfEmpty] تم ضبط اسم الشركة الافتراضي: " +
        DEFAULT_COMPANY_NAME +
        " | الفرع: " +
        DEFAULT_BRANCH_NAME,
    );
    return " تم ضبط اسم الشركة الافتراضي: " + DEFAULT_COMPANY_NAME;
  } catch (e) {
    Logger.log("[_seedDefaultCompanyIfEmpty] خطأ: " + e.message);
    return " خطأ في ضبط اسم الشركة الافتراضي: " + e.message;
  }
}

/**
 * backfillPostingConfigChartAccounts — [PC-XMAN-SCREEN-2026-08-08]
 * دالة Migration لمرة واحدة: تُشغَّل يدويًا من Apps Script Editor بعد رفع
 * هذا التحديث على بيئة عندها بيانات فعلاً (دليل الحسابات اتعمل له seed
 * قبل كده). _seedDefaultChartIfEmpty() نفسها Idempotent أصلاً — بتتخطى
 * أي كود موجود بالفعل وتضيف بس الأكواد الجديدة الناقصة (زي "الفيزا"،
 * "الاشعارات البنكية"، "الزبائن"، "جهات أخرى"، "تأمينات من الغير"...)
 * فمفيش أي خطر تكرار أو مسح بيانات — الاسم "IfEmpty" بيصف حالة الاستخدام
 * الأصلية (أول تهيئة) بس، مش قيد فعلي على المنطق الداخلي.
 *
 * بعد تشغيلها: روح شاشة "ثوابت الحسابات" واضغط "كشف تلقائي" عشان
 * الحسابات الجديدة تترابط تلقائيًا بمفاتيح الترحيل المقابلة لها.
 */
function backfillPostingConfigChartAccounts() {
  _seedDefaultChartIfEmpty();
  return " تم إضافة أي حسابات ناقصة في دليل الحسابات — افتح شاشة \"ثوابت الحسابات\" واضغط \"كشف تلقائي\" لربطها.";
}

function initializeSystem() {
  Object.keys(HEADERS).forEach((name) => getSheet(name));
  getOpeningStockSheet();

  // [DEV-2] إعادة تفعيل إنشاء مخزن رئيسي افتراضي واحد تلقائيًا (بعد ما كان
  // معطّلاً سابقًا) — عبر _seedDefaultWarehouseIfEmpty() تحت. الشيت نفسه
  // بيتعمل هنا بالهيدرز فقط، والمخزن الفعلي بيتضاف لاحقًا في هذه الدالة
  // فقط لو الشيت لسه فاضي (عملاء عندهم مخازن بالفعل لا يتأثرون إطلاقاً).
  getSheet("Warehouses", WAREHOUSE_HEADERS);

  // [SIMPLIFIED-SINGLE-ADMIN-2026-08-03] ensureDefaultUsers بتنشئ مستخدم
  // admin واحد بس بكلمة مرور ثابتة معروفة (admin123) عند أول تشغيل —
  // مفيش قيمة راجعة لأن الباسورد ثابت ومعروف مسبقًا (مش عشوائي).
  ensureDefaultUsers();
  _seedDefaultCompanyIfEmpty();
  _seedDefaultChartIfEmpty();
  _seedDefaultCashBoxIfEmpty();
  _seedDefaultWarehouseIfEmpty();
  _seedDefaultCashCustomerIfEmpty();
  _seedDefaultCashSupplierIfEmpty();
  _seedDefaultFiscalYearIfEmpty();
  _seedDefaultBankIfEmpty();
  _seedDefaultPaymentMethodsIfEmpty();

  return " تم تهيئة النظام بنجاح — المستخدم الافتراضي: admin / admin123 (سيُطلب تغيير كلمة المرور عند أول دخول)";
}

function uploadFile(base64Data, fileName, mimeType, context) {
  try {
    // [SEC-FIX-4c] التحقق من صلاحية المستخدم
    if (context && context.callerUser) {
      var permErr = _checkPermission(
        context.callerUser,
        "addTransaction",
        context.sessionToken,
      );
      if (permErr)
        return JSON.stringify({ success: false, error: permErr.message });
    }

    const now = new Date();
    const dateStr = Utilities.formatDate(now, "GMT+2", "yyyy-MM-dd");
    const ext = getExtension(String(fileName || "")).toLowerCase();

    // ── اسم الموظف / اسم الموديول — تنظيف موحّد عبر FileEngine ──
    const userName = FileEngine.sanitizeSegment(
      context && context.userName,
      "مستخدم",
    );
    const moduleName = FileEngine.sanitizeSegment(
      context && context.moduleName,
      "عام",
    );

    // ── اسم الملف: تاريخ + موديول ──
    const newFileName = `${dateStr}_${moduleName}${ext}`;

    // [FILE-ENGINE] تحقق (نوع/امتداد/حجم) + فولدرات متداخلة + رفع + مشاركة
    // — كله موحّد الآن في FileEngine.upload بدل تكراره هنا.
    const result = FileEngine.upload(base64Data, fileName, mimeType, {
      allowedMap: FileEngine.DOCUMENT_MIME_MAP,
      newFileName: newFileName,
      folderPath: ["مستندات المخازن", userName, moduleName],
    });

    if (!result.success) return JSON.stringify(result);

    return JSON.stringify({
      success: true,
      fileName: result.fileName,
      viewUrl: result.viewUrl,
      thumbUrl: result.thumbUrl,
    });
  } catch (e) {
    console.error("Upload Error:", e);
    // [SEC-FIX-2] لا نكشف تفاصيل الخطأ الداخلية
    return JSON.stringify({
      success: false,
      error: "فشل رفع الملف — حاول مرة أخرى",
    });
  }
}

// [FILE-ENGINE] اتسابت بنفس الاسم والتوقيع لتوافق أي كود قديم بينادي عليها
// مباشرة، لكن جسمها بقى يفوّض لـ FileEngine.getOrCreateFolder بدل تكرار
// نفس منطق "إيجاد فولدر أو إنشاؤه" في نسخة تالتة. راجع Code_35_FileEngine.gs.
function getOrCreateFolder(name, parent = null) {
  return FileEngine.getOrCreateFolder(name, parent);
}

// ── uploadPartyDocument [§BP-P5] ─────────────────────────────────────────────
// نفس منطق التحقق (نوع/امتداد/حجم/صلاحية) الموجود في uploadFile() أعلاه
// بالظبط، لكن بهيكل فولدرات مختلف: PartyDocuments/{party_id} — فولدر منفصل
// لكل طرف (عميل/مورد) بدل مشاركة فولدر اللوجوهات "مستندات المخازن"، عشان
// التنظيم والفصل الواضح بين مستندات الشركة نفسها ومستندات الأطراف الخارجية.
// القرار ده اتحسم مع محمد في مرحلة P5 من BP-ROADMAP-REMAINING.md.

function uploadPartyDocument(base64Data, fileName, mimeType, partyId, context) {
  try {
    if (!partyId) {
      return JSON.stringify({
        success: false,
        error: "معرف الطرف مطلوب لرفع المستند",
      });
    }

    // [SEC] التحقق من صلاحية المستخدم — نفس صلاحية تعديل العميل/المورد
    if (context && context.callerUser) {
      var permErr = _checkPermission(
        context.callerUser,
        context.partyType === "supplier" ? "updateSupplier" : "updateCustomer",
        context.sessionToken,
      );
      if (permErr)
        return JSON.stringify({ success: false, error: permErr.message });
    }

    // [DOC-ENGINE] لو الواجهة بعتت partyType/code/name (بيانات كافية لبناء
    // هيكل الفولدرات الكامل)، بنمر عبر DocumentEngine للتوجيه الذكي حسب
    // docType + تسجيل الملف في جدول Files الموحّد. لو ناقصة (استدعاء قديم)
    // بنرجع للسلوك السابق (فولدر مسطّح PartyDocuments/{id}) بدون كسر أي شيء.
    if (context && context.partyType && context.code && context.name) {
      var engineResult = DocumentEngine.uploadPartyFile(base64Data, fileName, mimeType, {
        partyType: context.partyType,
        partyId: partyId,
        code: context.code,
        name: context.name,
        docType: context.docType || "document",
        uploadedBy: context.callerUser || "",
      });
      return JSON.stringify(engineResult);
    }

    const now = new Date();
    const dateStr = Utilities.formatDate(now, "GMT+2", "yyyy-MM-dd");
    const newFileName = dateStr + "_" + fileName;

    // [FILE-ENGINE] نفس قائمة الأنواع/الحجم المسموح المستخدمة في uploadFile،
    // موحّدة الآن في FileEngine بدل نسخة ثالثة من نفس المنطق.
    const result = FileEngine.upload(base64Data, fileName, mimeType, {
      allowedMap: FileEngine.DOCUMENT_MIME_MAP,
      newFileName: newFileName,
      folderPath: ["PartyDocuments", String(partyId)],
    });

    if (!result.success) return JSON.stringify(result);

    return JSON.stringify({
      success: true,
      fileName: result.fileName,
      viewUrl: result.viewUrl,
      thumbUrl: result.thumbUrl,
    });
  } catch (e) {
    console.error("uploadPartyDocument Error:", e);
    // [SEC-FIX-2] لا نكشف تفاصيل الخطأ الداخلية
    return JSON.stringify({
      success: false,
      error: "فشل رفع المستند — حاول مرة أخرى",
    });
  }
}

function getExtension(filename) {
  const ext = filename.lastIndexOf(".");
  return ext > 0 ? filename.substring(ext) : "";
}





