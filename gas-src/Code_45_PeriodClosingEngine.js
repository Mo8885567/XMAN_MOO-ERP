// ════════════════════════════════════════════════════════════════════
// Code_45_PeriodClosingEngine.gs — إغلاق الفترات المحاسبية
// (Accounting Period Closing)
//
// [MERGE-2026-07] كان في هذا الملف محرّك ثانٍ كامل (getAccountingPeriods
// مكرر + closeAccountingPeriod + _findClosedPeriodForDate) بيكتب/يقرأ من
// نفس شيت AccountingPeriods بس بترتيب أعمدة مختلف تمامًا عن المحرك
// الأساسي في Code_02_Accounting_ChartOfAccounts.js (_getFiscalPeriodForDate /
// _validateFiscalPeriod / getAccountingPeriods / addAccountingPeriod /
// updateAccountingPeriodStatus، حالات OPEN/CLOSED/LOCKED). النسختين كانتا
// بتتصادما على نفس الشيت (تعارض ترتيب أعمدة) وكان فيه تعريف مكرر تمامًا
// لدالة getAccountingPeriods (بيفوز التعريف اللي في الملف ده بترتيب تحميل
// الملفات، فتُصبح نسخة Code_02 كود ميت بصمت) — رغم إن مفيش أي شاشة HTML
// بتستخدم أي من الاثنين أصلًا حتى الآن.
//
// القرار: Code_02 هو المحرك الأساسي الوحيد من الآن فصاعدًا (الأشمل: حالات
// OPEN/CLOSED/LOCKED). اتشالت من هنا: getAccountingPeriods المكررة،
// closeAccountingPeriod (schema قديم)، _findClosedPeriodForDate.
// بقيت _blockIfPeriodClosed و reopenAccountingPeriod بس — كـ wrapper
// توافقي فوق محرك Code_02 مباشرة، بدون ما نغيّر توقيعهم (signature) فمفيش
// داعي نلمس أي نقطة استدعاء منهم.
//
// [MERGE-2026-07 UNIFY — تحديث] _blockIfPeriodClosed بقت دلوقتي نقطة الفحص
// الموحّدة الوحيدة في كل الموديولات اللي بتلمس مستندات مؤرَّخة: Code_20_Sales.js
// (فواتير بيع/شراء + مرتجعات، عدة مواضع)، Code_16_Inventory.js (حركات مخزون
// وتسويات، عدة مواضع)، Code_06_Accounting_Vouchers.js (سندات قبض/صرف/تحويل
// ومصروفات)، Code_09_Banking.js (شيكات + سند تحويل)، Code_05b_InvoiceSoftDelete.js
// (حذف ناعم لفواتير البيع/الشراء)، Code_14_FixedAssets.js (قيود إهلاك/تصرف
// في أصل)، Code_27_PurchaseOrders.js (استلام أمر شراء)، و
// Code_33_BusinessRulesEngine.js (قيد يومية). أي موديول جديد يحتاج يفحص
// الفترة المحاسبية لازم ينادي _blockIfPeriodClosed بنفس التوقيع بدل ما
// يعمل فحص خاص بيه.
//
// نقطة الدخول المشتركة لأي دالة حذف/تعديل/اعتماد/إلغاء عايزة تفحص الفترة:
//     var pErr = _blockIfPeriodClosed(doc.date, "اسم المستند بالعربي");
//     if (pErr) return pErr;
//
// ترتيب التحميل: لازم يتحمّل بعد Code_02_Accounting_ChartOfAccounts.js
// (محتاج _getFiscalPeriodForDate و ACCOUNTING_PERIODS_HEADERS).
// ════════════════════════════════════════════════════════════════════

/**
 * _blockIfPeriodClosed — الفحص المشترك اللي بتستخدمه دوال الحذف/التعديل/
 * الاعتماد/الإلغاء في كل الموديولات (محاسبة، مبيعات، مخزون). [MERGE-2026-07]
 * بقت wrapper فوق محرك Code_02 (_getFiscalPeriodForDate) بدل الشيت المكرر
 * القديم اللي كان بيتعارض معاه على نفس الأعمدة.
 * @param {string} dateStr - تاريخ المستند المطلوب حذفه/تعديله/اعتماده/إلغاؤه
 * @param {string} [docLabel] - اسم نوع المستند بالعربي (للرسالة بس)
 * @returns {null|{success:false,message:string,code:string}} - null لو مسموح
 */
function _blockIfPeriodClosed(dateStr, docLabel) {
  try {
    var period = _getFiscalPeriodForDate(dateStr);
    if (!period || period.status === "OPEN") return null;
    return {
      success: false,
      code: "PERIOD_CLOSED",
      message:
        "لا يمكن حذف/تعديل/اعتماد/إلغاء " +
        (docLabel || "هذا المستند") +
        " — تاريخه (" +
        String(dateStr).split("T")[0] +
        ") يقع داخل فترة محاسبية " +
        (period.status === "LOCKED" ? "مُقفلة (LOCKED)" : "مُغلقة") +
        " (" +
        (period.name || period.id) +
        "). لازم فتح الفترة أولاً من إعدادات المحاسبة.",
    };
  } catch (e) {
    // لو حصل خطأ في الفحص نفسه (مثلاً الشيت لسه مش موجود) ما نمنعش
    // المستخدم — fail-open، نفس سلوك _getFiscalPeriodForDate الأصلي.
    Logger.log("[PERIOD-CLOSING] _blockIfPeriodClosed: " + e.message);
    return null;
  }
}

/**
 * reopenAccountingPeriod — فتح فترة مقفولة/مُقفلة تاني (admin فقط)، مسجَّلة
 * بالكامل في Audit Log لأنها قرار حساس.
 *
 * [MERGE-2026-07 UNIFY] كانت الدالة دي بتكرر (تقرأ الشيت + LockService +
 * تكتب عمود status + Audit Log) بنفس بالضبط منطق updateAccountingPeriodStatus
 * (Code_02_Accounting_ChartOfAccounts.js) — يعني نقطتين مختلفتين بتكتبوا على
 * نفس الشيت بنفس الـ schema. اتوحّدت دلوقتي: reopenAccountingPeriod بقت
 * مجرد "بوابة صلاحية" (permission gate) بصلاحية admin أشد
 * (reopenAccountingPeriod) + رسالة تنبيه مخصصة، وبتفوّض الكتابة الفعلية
 * (lock + سطر الشيت + Audit Log الأساسي) بالكامل لمحرك Code_02 الموحّد،
 * عشان يفضل مكان واحد بس بيكتب حالة الفترة.
 *
 * [FIX] كانت كمان غير موجودة في DOPOST_ALLOWED_FUNCTIONS (Code_12_Core.js)
 * فمفيش أي طريقة تستدعيها بيها الواجهة أو أي عميل خارجي رغم اكتمال تنفيذها
 * — اتضافت للـ whitelist كجزء من نفس التوحيد.
 */
function reopenAccountingPeriod(id, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "reopenAccountingPeriod",
      sessionToken,
    );
    if (permErr) return permErr;

    var periods = readSheet("AccountingPeriods", ACCOUNTING_PERIODS_HEADERS, {
      trimStrings: true,
    });
    var current = periods.find(function (r) {
      return r.id === id;
    });
    if (!current) return errResponse("الفترة غير موجودة");
    if (current.status === "OPEN") {
      return errResponse("الفترة دي مفتوحة أصلًا");
    }

    // التفويض الكامل لمحرك Code_02 الموحّد — هو الوحيد اللي بيكتب على شيت
    // AccountingPeriods (lock + تحديث status + Audit Log UPDATE_PERIOD_STATUS).
    var result = updateAccountingPeriodStatus(
      id,
      "OPEN",
      callerUser,
      sessionToken,
    );
    if (!result || !result.success) return result;

    // Audit إضافي خاص بحساسية "إعادة الفتح" تحديدًا (تنبيه صريح إن مستندات
    // الفترة بقت قابلة للتعديل/الحذف/الاعتماد تاني)، فوق الـ Audit العام
    // اللي كتبه updateAccountingPeriodStatus.
    AuditEngine.log("REOPEN_ACCOUNTING_PERIOD", {
      user: callerUser,
      table: "AccountingPeriods",
      record_id: id,
      details:
        "إعادة فتح فترة محاسبية: " +
        (current.name || id) +
        " — تنبيه: أي حذف/تعديل/اعتماد هيُسمح بيه دلوقتي على مستندات الفترة دي",
    });
    return okResponse(" تم فتح الفترة تاني");
  } catch (e) {
    return errResponse("خطأ في فتح الفترة: " + e.message);
  }
}
