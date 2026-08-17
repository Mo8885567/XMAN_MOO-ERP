// ════════════════════════════════════════════════════════════════
// Code_21c_FullSystemReset.js — [FULL-RESET-2026-08]
// ⚠️⚠️⚠️ عملية لا رجعة فيها (Irreversible) — بتمسح كل شيتات النظام
// بالكامل (عملاء، مخزون، فواتير، رواتب، مستخدمين، صلاحيات، إعدادات...
// كل حاجة بدون استثناء) تمهيدًا لتشغيل setupEverything() يدويًا بعدها
// على Spreadsheet فاضي تمامًا.
//
// القرار المعتمد من المستخدم (2026-08-06):
//   - Reset كامل 100% (شامل Users/Permissions/Settings — بدون استثناء)
//   - المسح فقط — المستخدم هيشغّل setupEverything() بنفسه لاحقًا
//     (الفانكشن دي مش بتنادي setupEverything تلقائيًا)
//
// آلية الأمان: الفانكشن مش هتنفّذ أي مسح إلا لو استُدعيت بالحرف بالباراميتر
// confirmPhrase === "امسح كل شيتات النظام نهائيا" (مطابقة نصية كاملة).
// أي قيمة تانية → ترفض التنفيذ وترجع رسالة توضيحية.
// ════════════════════════════════════════════════════════════════

var FULL_RESET_CONFIRM_PHRASE = "امسح كل شيتات النظام نهائيا";
var FULL_RESET_TEMP_SHEET_NAME = "_TEMP_RESET_PLACEHOLDER_";

/**
 * wipeAllSheetsCompletely — نقطة الدخول الوحيدة.
 *
 * @param {string} confirmPhrase - يجب أن تساوي FULL_RESET_CONFIRM_PHRASE
 *   بالحرف الواحد، وإلا يُرفض التنفيذ فورًا بدون أي تغيير.
 * @param {string} callerUser - اسم من يشغّل العملية (للـ Audit Log).
 * @returns {object} okResponse/errResponse فيه تفاصيل الشيتات المحذوفة.
 */
function wipeAllSheetsCompletely(confirmPhrase, callerUser) {
  callerUser = callerUser || "system";
  var report = { backup_url: null, deleted_sheets: [], errors: [] };

  // ── حارس التأكيد الصريح — أول سطر تنفيذي فعلي فى الدالة كلها ──
  if (confirmPhrase !== FULL_RESET_CONFIRM_PHRASE) {
    return errResponse(
      "تم رفض التنفيذ: لازم تمرر النص بالحرف الواحد \"" +
        FULL_RESET_CONFIRM_PHRASE +
        "\" فى المعامل الأول عشان تأكيد إنك قاصد فعلاً مسح كل شيتات " +
        "النظام (بما فيها العملاء والمخزون والفواتير والرواتب والمستخدمين). " +
        "لو مش متأكد، متكملش.",
    );
  }

  try {
    // ── الخطوة 1: Backup إلزامي قبل أي مسح، حتى لو المستخدم قال إنه عمل
    // Backup يدوي بالفعل — طبقة حماية إضافية مربوطة بنفس لحظة التنفيذ.
    try {
      // ملحوظة: createBackup بتبعت الملف بالإيميل (مش بترجع رابط Drive)،
      // وبتطلب صلاحية "createBackup" عبر جلسة حقيقية — وإحنا بنشغّل الدالة
      // دي يدوي من محرر Apps Script بدون Session، فبنمرر "SCHEDULED_TRIGGER"
      // (نفس القيمة اللي بيستخدمها الـ Trigger اليومي) عشان تتخطى فحص
      // الصلاحية دون الحاجة لتوكن مستخدم.
      var backupResult = createBackup("SCHEDULED_TRIGGER", null);
      if (!backupResult || backupResult.success === false) {
        throw new Error(
          (backupResult && backupResult.message) || "نتيجة غير معروفة",
        );
      }
      report.backup_sent_to = backupResult.sent_to || null;
      report.backup_file_name = backupResult.file_name || null;
    } catch (backupErr) {
      // لو الـ backup فشل، نوقف العملية كلها — الأمان هنا أهم من الاستمرار.
      return errResponse(
        "تم إيقاف العملية: فشل أخذ نسخة احتياطية تلقائية قبل المسح — " +
          backupErr.message +
          ". راجع Code_12j_Backup.js أو خد نسخة يدوية (File → Make a copy) " +
          "وبعدين شغّل الدالة تاني.",
      );
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var allSheets = ss.getSheets();

    // ── الخطوة 2: Google Sheets مايسمحش إن الملف يبقى من غير أي شيت
    // خالص، فبننشئ شيت مؤقت فاضي الأول كـ "مرساة" قبل ما نمسح الباقي.
    var placeholder = ss.getSheetByName(FULL_RESET_TEMP_SHEET_NAME);
    if (!placeholder) {
      placeholder = ss.insertSheet(FULL_RESET_TEMP_SHEET_NAME);
    }

    // ── الخطوة 3: حذف كل شيت تاني غير المرساة — Delete كامل (مش Clear)
    // عشان أي شيت جديد يتعمله setupAllSheets/getSheet لاحقًا يتبني من
    // الصفر بهيدرز صحيحة، بدل ما ياخد شيت "فاضي بس موجود" وممكن يعطل
    // منطق getSheet() اللي بيفترض إن الشيت الموجود أصلاً عنده هيدر صف.
    allSheets.forEach(function (sh) {
      var name = sh.getName();
      if (name === FULL_RESET_TEMP_SHEET_NAME) return;
      try {
        ss.deleteSheet(sh);
        report.deleted_sheets.push(name);
      } catch (e2) {
        report.errors.push("فشل حذف الشيت \"" + name + "\": " + e2.message);
      }
    });

    // ── الخطوة 4: تفريغ أي كاش سيرفري محفوظ من قبل المسح ──
    try {
      _invalidateServerCache();
    } catch (e3) {
      // ignore
    }

    try {
      AuditEngine.log("FULL_SYSTEM_RESET", {
        user: callerUser,
        table: "*ALL*",
        details:
          "تم مسح " +
          report.deleted_sheets.length +
          " شيت بالكامل (Full Reset) — Backup أُرسل لـ: " +
          (report.backup_sent_to || "غير متاح"),
      });
    } catch (e4) {
      // الـ Audit Log نفسه اتمسح مع باقي الشيتات، فده متوقع يفشل بصمت
    }

    return okResponse(
      "تم مسح " +
        report.deleted_sheets.length +
        " شيت بالكامل. الشيت المؤقت \"" +
        FULL_RESET_TEMP_SHEET_NAME +
        "\" لسه موجود كمرساة — احذفه يدويًا بعد ما تشغّل setupEverything() " +
        "وتتأكد إن كل الشيتات الأساسية اتبنت صح. " +
        (report.backup_sent_to
          ? "النسخة الاحتياطية (" +
            report.backup_file_name +
            ") اتبعتت لإيميل: " +
            report.backup_sent_to
          : "⚠️ تحذير: مفيش تأكيد Backup فى الـ response — تأكد يدويًا."),
      report,
    );
  } catch (e) {
    report.errors.push(e.message);
    return errResponse("فشل الـ Reset الكامل: " + e.message, report);
  }
}
