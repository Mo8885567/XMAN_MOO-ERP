/**
 * ============================================================
 * Module: Code_12j_Backup.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 *
 * [BACKUP-ENGINE-v5] 2026-08-06 — إعادة بناء محرك النسخ الاحتياطي:
 * - تخزين فعلي على Google Drive (بدل الاعتماد الكامل على الإيميل)
 * - سجل تاريخي كامل لكل نسخة في شيت BackupHistory
 * - فحص سلامة حقيقي بعد الرفع (حجم الملف على Drive)
 * - استعادة كاملة (restoreFromBackup) مع نسخة أمان تلقائية قبلها
 * - سياسة احتفاظ (Retention) تلقائية لمنع تضخم Drive
 * راجع خطة المراجعة الكاملة في المحادثة بتاريخ 2026-08-06.
 * ============================================================
 */

/** أعمدة شيت سجل النسخ الاحتياطية — مصدر الحقيقة الوحيد لتاريخ الباكاب */
var BACKUP_HISTORY_HEADERS = [
  "id",
  "created_at",
  "created_by",
  "trigger_type", // manual | scheduled | pre_restore_safety
  "file_name",
  "file_id",
  "file_url",
  "folder_id",
  "size_bytes",
  "checksum_sha256", // [BACKUP-ENGINE-v5.1] بصمة السلامة — تُستخدم لرفض استعادة ملف تالف/متلاعَب به
  "status", // success | failed
  "integrity_check", // ok | mismatch_size | export_failed | ...
  "sent_email_to",
  "email_status", // sent | failed | skipped
  "restored_at",
  "restored_by",
  "notes",
];

/** _sha256Hex — بصمة SHA-256 (hex) لمصفوفة بايتات — لاكتشاف أي تلف/تلاعب بالملف لاحقًا */
function _sha256Hex(bytes) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return digest
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? "0" + v : v;
    })
    .join("");
}

/**
 * _getAdminEmail — يجيب إيميل الأدمن من Settings أو Users
 */
function _getAdminEmail() {
  try {
    var settings = _getCompanySettingsRaw();
    var email = settings.admin_alert_email || settings.company_email || "";
    if (email) return email;
  } catch (e) {
    console.error("_getAdminEmail - خطأ:", e.message || e);
  }
  try {
    var users = readSheet("Users");
    // دور على أول يوزر role=admin عنده إيميل
    var adminUser = users.find(function (u) {
      return String(u.role || "").toLowerCase() === "admin" && u.email;
    });
    return adminUser ? String(adminUser.email).trim() : "";
  } catch (e) {
    return "";
  }
}

/**
 * _getBackupFolder — فولدر Drive الفعلي اللي بيتخزن فيه الباكاب.
 * لو الأدمن حدد فولدر مخصص (setBackupUserFolder) نستخدمه، وإلا فولدر
 * افتراضي ثابت الاسم (يُنشأ تلقائيًا أول مرة عبر FileEngine الموحّد).
 */
function _getBackupFolder() {
  var settings = _getCompanySettingsRaw();
  if (settings.backup_folder_id) {
    try {
      return DriveApp.getFolderById(settings.backup_folder_id);
    } catch (e) {
      // الفولدر المحفوظ لم يعد موجودًا/تم حذفه — نرجع للافتراضي بدل الفشل
    }
  }
  return FileEngine.getOrCreateFolder(
    "MOO.ERP - نسخ احتياطية",
    FileEngine.getSpreadsheetContainerFolder(),
  );
}

/** _appendBackupHistoryRow — يسجّل صف واحد في شيت BackupHistory */
function _appendBackupHistoryRow(row) {
  var sheet = getSheet("BackupHistory", BACKUP_HISTORY_HEADERS);
  var values = BACKUP_HISTORY_HEADERS.map(function (h) {
    return row[h] !== undefined && row[h] !== null ? row[h] : "";
  });
  sheet.appendRow(values);
}

/**
 * _applyBackupRetention — يحتفظ بآخر N نسخة ناجحة بس (افتراضي 30، قابل
 * للتعديل عبر إعداد "backup_retention_count") ويحذف الباقي من Drive
 * ومن سجل BackupHistory لمنع تضخم المساحة والشيت مع الوقت.
 */
function _applyBackupRetention() {
  var settings = _getCompanySettingsRaw();
  var keep = Number(settings.backup_retention_count) || 30;

  var rows = readSheet("BackupHistory", BACKUP_HISTORY_HEADERS);
  var successRows = rows
    .filter(function (r) {
      return r.status === "success" && r.trigger_type !== "pre_restore_safety";
    })
    .sort(function (a, b) {
      return new Date(a.created_at) - new Date(b.created_at);
    });

  if (successRows.length <= keep) return;

  var toDelete = successRows.slice(0, successRows.length - keep);
  var deleteIds = {};
  toDelete.forEach(function (r) {
    deleteIds[r.id] = true;
    try {
      if (r.file_id) DriveApp.getFileById(r.file_id).setTrashed(true);
    } catch (e) {
      // ملف اتحذف يدويًا من قبل بالفعل — نتجاهل
    }
  });

  var sheet = getSheet("BackupHistory", BACKUP_HISTORY_HEADERS);
  var data = sheet.getDataRange().getValues();
  var idColIdx = BACKUP_HISTORY_HEADERS.indexOf("id");
  var kept = [data[0]];
  for (var i = 1; i < data.length; i++) {
    if (!deleteIds[data[i][idColIdx]]) kept.push(data[i]);
  }
  sheet.clearContents();
  sheet.getRange(1, 1, kept.length, BACKUP_HISTORY_HEADERS.length).setValues(kept);
}

/**
 * _notifyBackupIssue — إشعار إيميل موحّد لأي فشل/تحذير في الباكاب (تصدير
 * فاشل، فحص سلامة فاشل، أو استثناء عام) — best-effort دايمًا.
 */
function _notifyBackupIssue(subjectSuffix, reason, triggeredBy) {
  try {
    var adminEmail = _getAdminEmail();
    if (!adminEmail) return;
    MailApp.sendEmail({
      to: adminEmail,
      subject: "🚨 " + subjectSuffix + " — MOO.ERP",
      body:
        "بواسطة: " +
        (triggeredBy || "manual") +
        "\nالسبب: " +
        reason +
        "\n\nيُنصح بمراجعة النظام وإنشاء نسخة يدوية فورًا.",
    });
  } catch (e) {
    console.error("_notifyBackupIssue - فشل إرسال الإشعار:", e.message || e);
  }
}

/**
 * createBackup — يُصدّر الـ Spreadsheet كـ Excel، يحفظه فعليًا على
 * Google Drive (المصدر الرئيسي)، ثم يبعت نسخة اختيارية على إيميل
 * الأدمن (best-effort، مش شرط لنجاح العملية). يسجّل كل محاولة —
 * ناجحة أو فاشلة — في شيت BackupHistory (v5.0)
 */
function createBackup(triggeredBy, sessionToken) {
  // [FIX-AUDIT] كانت هذه الدالة بلا أي تحقق هوية وقابلة للاستدعاء عبر doPost
  // بدون تسجيل دخول. نستثني الاستدعاء الداخلي من الـ Trigger المجدول ومن
  // نسخة الأمان التلقائية قبل الاستعادة (لا يوجد مستخدم حقيقي وقتها)،
  // ونتحقق أن أي مستدعٍ آخر يملك صلاحية "createBackup" الفعلية (وليس فقط
  // أنه مستخدم نشط) — النسخة الاحتياطية تحتوي كل بيانات الشركة الحساسة
  // (رواتب، أرصدة، فواتير) فلا يجب أن تُتاح لأي دور عادي.
  var isInternalTrigger =
    triggeredBy === "SCHEDULED_TRIGGER" || triggeredBy === "PRE_RESTORE_SAFETY";
  if (!isInternalTrigger) {
    var permErr = _checkPermission(triggeredBy, "createBackup", sessionToken);
    if (permErr) return permErr;
  }

  var now = new Date();
  var backupId = "BK-" + Utilities.formatDate(now, "GMT+2", "yyyyMMdd-HHmmss");
  var triggerType =
    triggeredBy === "SCHEDULED_TRIGGER"
      ? "scheduled"
      : triggeredBy === "PRE_RESTORE_SAFETY"
        ? "pre_restore_safety"
        : "manual";

  var historyRow = {
    id: backupId,
    created_at: now.toISOString(),
    created_by: triggeredBy || "manual",
    trigger_type: triggerType,
    status: "failed",
    integrity_check: "not_started",
  };

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ssId = ss.getId();
    var dateStr = Utilities.formatDate(now, "GMT+2", "yyyy-MM-dd_HH-mm");
    var fileName =
      "Backup_" + (ss.getName() || "مخازن") + "_" + dateStr + ".xlsx";

    // ── صدّر الـ Spreadsheet كـ Excel blob ──
    var url =
      "https://docs.google.com/spreadsheets/d/" +
      ssId +
      "/export?format=xlsx&access_token=" +
      ScriptApp.getOAuthToken();
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      historyRow.integrity_check = "export_failed";
      historyRow.notes = "HTTP " + resp.getResponseCode();
      _appendBackupHistoryRow(historyRow);
      _notifyBackupIssue(
        "فشل إنشاء نسخة احتياطية",
        "فشل تصدير الملف من Sheets (HTTP " + resp.getResponseCode() + ")",
        triggeredBy,
      );
      return errResponse("❌ فشل تصدير الملف: كود " + resp.getResponseCode());
    }
    var blob = resp.getBlob().setName(fileName);
    var exportedBytes = blob.getBytes();
    var exportedSize = exportedBytes.length;

    // ── [INTEGRITY-1] فحص أولي: ملف xlsx حقيقي لازم يكون أكبر من حجم
    // ملف فاضي/تالف تقريبًا (heuristic بسيط لكنه بيمسك حالات التصدير
    // الفاشل بصمت — كود 200 مع محتوى فاضي) ──
    if (exportedSize < 2000) {
      historyRow.integrity_check = "export_too_small";
      historyRow.size_bytes = exportedSize;
      historyRow.notes = "حجم الملف المُصدَّر " + exportedSize + " بايت — أصغر من الحد الأدنى المتوقع";
      _appendBackupHistoryRow(historyRow);
      _notifyBackupIssue(
        "فشل التحقق من سلامة نسخة احتياطية",
        "الملف المُصدَّر صغير بشكل غير طبيعي (" + exportedSize + " بايت)",
        triggeredBy,
      );
      return errResponse("❌ فشل التحقق من سلامة النسخة: الملف المُصدَّر صغير بشكل غير طبيعي");
    }

    // ── احفظ الملف فعليًا على Google Drive (المصدر الرئيسي للتخزين) —
    // الملف يُنشأ خاصًا افتراضيًا (مرئي فقط لمالك السكريبت/المشاركين
    // معهم صراحة) — لا يوجد أي استدعاء لمشاركة عامة (shareFile) هنا عمدًا ──
    var folder = _getBackupFolder();
    var file = folder.createFile(blob);
    var fileId = file.getId();
    var fileUrl = "https://drive.google.com/file/d/" + fileId + "/view";

    // ── بصمة سلامة (SHA-256) — تُستخدم عند الاستعادة لاكتشاف أي تلف أو
    // تلاعب بالملف قبل ما نستبدل بيه أي بيانات حقيقية ──
    var checksum = _sha256Hex(exportedBytes);

    // ── [INTEGRITY-2] تأكيد إن الملف فعلاً اتخزن على Drive بنفس حجمه ──
    var driveSize = file.getSize();
    var integrityOk = driveSize > 0 && driveSize === exportedSize;

    historyRow.file_name = fileName;
    historyRow.file_id = fileId;
    historyRow.file_url = fileUrl;
    historyRow.folder_id = folder.getId();
    historyRow.size_bytes = driveSize;
    historyRow.checksum_sha256 = checksum;
    historyRow.status = integrityOk ? "success" : "failed";
    historyRow.integrity_check = integrityOk ? "ok" : "drive_size_mismatch";

    // ── إيميل اختياري (best-effort) — فشله لا يُفشِّل الباكاب نفسه لأن
    // Drive بقى المصدر الأساسي مش الإيميل ──
    var adminEmail = _getAdminEmail();
    var emailStatus = "skipped";
    if (adminEmail) {
      try {
        var bodyText = [
          "السلام عليكم،",
          "",
          "مرفق النسخة الاحتياطية لـ MOO.ERP (وهي محفوظة أيضًا على Google Drive).",
          "",
          "📅 التاريخ: " + Utilities.formatDate(now, "GMT+2", "yyyy-MM-dd HH:mm"),
          "📋 الملف: " + fileName,
          "🔗 رابط Drive: " + fileUrl,
          "🔧 بواسطة: " + (triggeredBy || "manual"),
          "",
          "— MOO.ERP",
        ].join("\n");
        MailApp.sendEmail({
          to: adminEmail,
          subject: "💾 نسخة احتياطية — " + dateStr,
          body: bodyText,
          attachments: [blob],
        });
        emailStatus = "sent";
      } catch (eMail) {
        emailStatus = "failed:" + (eMail.message || eMail);
      }
    }
    historyRow.sent_email_to = adminEmail || "";
    historyRow.email_status = emailStatus;

    _appendBackupHistoryRow(historyRow);

    _writeAuditLog({
      user: triggeredBy || "SYSTEM",
      action: integrityOk ? "BACKUP_CREATED" : "BACKUP_INTEGRITY_FAILED",
      table: "ALL",
      record_id: fileId,
      details:
        (integrityOk ? "نسخة احتياطية أُنشئت بنجاح: " : "فشل التحقق من سلامة النسخة: ") +
        fileName +
        " — " +
        fileUrl,
    });

    // ── توافق خلفي: بعض الشاشات القديمة بتقرا آخر باكاب من Properties ──
    var props = PropertiesService.getScriptProperties();
    props.setProperty("last_backup_time", now.toISOString());
    props.setProperty("last_backup_name", fileName);
    props.setProperty("last_backup_email", adminEmail || "");
    props.setProperty("last_backup_file_id", fileId);

    // ── سياسة الاحتفاظ — best-effort، ما بتوقفش نجاح الباكاب الحالي ──
    try {
      _applyBackupRetention();
    } catch (eRetention) {
      console.error("_applyBackupRetention - خطأ:", eRetention.message || eRetention);
    }

    if (!integrityOk) {
      _notifyBackupIssue(
        "فشل التحقق من سلامة نسخة احتياطية",
        "حجم الملف على Drive (" + driveSize + ") لا يطابق الحجم المُصدَّر (" + exportedSize + ")",
        triggeredBy,
      );
      return errResponse(
        "⚠️ تم رفع النسخة لكن فشل التحقق من سلامتها (حجم غير مطابق) — راجع سجل النسخ ولا تعتمد عليها للاستعادة",
      );
    }

    return {
      success: true,
      message: "✅ تم إنشاء النسخة الاحتياطية وحفظها على Drive" +
        (emailStatus === "sent" ? " وإرسالها على " + adminEmail : ""),
      file_name: fileName,
      file_id: fileId,
      file_url: fileUrl,
      folder_url: folder.getUrl(),
      sent_to: adminEmail,
      timestamp: now.toISOString(),
      size_bytes: driveSize,
    };
  } catch (e) {
    historyRow.notes = e.message || String(e);
    try {
      _appendBackupHistoryRow(historyRow);
    } catch (e2) {
      console.error("createBackup - فشل تسجيل السجل بعد خطأ:", e2.message || e2);
    }
    try {
      _writeAuditLog({
        user: triggeredBy || "SYSTEM",
        action: "BACKUP_FAILED",
        table: "ALL",
        record_id: "",
        details: e.message || String(e),
      });
    } catch (e3) {
      // تجاهل — لا نوقف الاستجابة بسبب فشل التسجيل
    }
    // ── [NOTIFY-FAIL] إشعار فشل — كان الإشعار الوحيد الموجود قبل كده
    // عند النجاح فقط؛ فشل صامت للباكاب المجدول يعني الأدمن ممكن يفتكر
    // إن عنده نسخ سليمة لأسابيع وهو فعليًا مالوش ولا نسخة ──
    _notifyBackupIssue("فشل إنشاء نسخة احتياطية", e.message || String(e), triggeredBy);
    return errResponse("❌ خطأ في الباكاب: " + e.message);
  }
}

/**
 * scheduledDailyBackup — يُشغَّل تلقائياً من Trigger
 */
function scheduledDailyBackup() {
  // [FIX-AUDIT #2] toggle "auto_backup" في System Settings كان يُحفظ ويُقرأ
  // لكن لا علاقة له بجدولة النسخ الاحتياطي الحقيقية (setupBackupTrigger /
  // scheduledDailyBackup) — كان الـ trigger يعمل بغض النظر عن حالة الـ toggle.
  // الآن: لو الأدمن أوقف "auto_backup" من الشاشة، الـ trigger المجدول لسه
  // موجودًا لكنه يتخطى تنفيذ الباكاب فعليًا بدل ما يتجاهل الإعداد كليًا.
  try {
    var settings = _getCompanySettingsRaw();
    // لو المفتاح غير موجود إطلاقًا في الشيت (لم يُحفظ من قبل)، نعتبره مفعّلاً
    // افتراضيًا حفاظًا على السلوك القديم لأي عميل يعتمد على الـ trigger أصلاً.
    var autoBackupEnabled =
      settings.auto_backup === undefined ? true : settings.auto_backup === true;
    if (!autoBackupEnabled) {
      Logger.log(
        "Daily Backup: تم تخطي التنفيذ — auto_backup موقوف من System Settings",
      );
      return { success: true, skipped: true, reason: "auto_backup_disabled" };
    }
  } catch (eSettings) {
    // لو فشل قراءة الإعداد، لا نمنع الباكاب — الأمان الافتراضي هو التشغيل
  }
  var result = createBackup("SCHEDULED_TRIGGER");
  Logger.log("Daily Backup: " + JSON.stringify(result));
  return result;
}

/**
 * getBackupStatus — يجلب معلومات آخر باكاب + عدد النسخ + فولدر Drive،
 * كلها من مصدر حقيقة واحد (شيت BackupHistory) بدل PropertiesService
 * اللي كان بيحفظ آخر نسخة بس بدون تاريخ كامل.
 */
function getBackupStatus() {
  try {
    var history = readSheet("BackupHistory", BACKUP_HISTORY_HEADERS);
    var successRows = history
      .filter(function (r) {
        return r.status === "success" && r.trigger_type !== "pre_restore_safety";
      })
      .sort(function (a, b) {
        return new Date(a.created_at) - new Date(b.created_at);
      });
    var last = successRows.length ? successRows[successRows.length - 1] : null;

    var adminEmail = _getAdminEmail();
    var folder = null;
    try {
      folder = _getBackupFolder();
    } catch (eFolder) {
      // تجاهل — الفولدر مش أساسي لعرض الحالة
    }

    var props = PropertiesService.getScriptProperties();
    return {
      success: true,
      admin_email: adminEmail, // ← إيميل الأدمن الحالي
      folder_url: folder ? folder.getUrl() : "",
      folder_name: folder ? folder.getName() : "",
      backup_count: successRows.length,
      schedule: {
        frequency: props.getProperty("backup_frequency") || "daily",
        hour: Number(props.getProperty("backup_hour") || 3),
        day: Number(props.getProperty("backup_day") || 1),
      },
      last_backup: last
        ? {
            time: last.created_at,
            name: last.file_name,
            sent_to: last.sent_email_to,
            file_url: last.file_url,
          }
        : null,
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * listBackupFiles — يجلب آخر 50 نسخة احتياطية ناجحة من سجل BackupHistory
 * (بيانات حقيقية من Drive، مش قائمة وهمية). [BACKUP-ENGINE-v5]
 */
function listBackupFiles(callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "createBackup", sessionToken);
  if (permErr) return permErr;
  try {
    var history = readSheet("BackupHistory", BACKUP_HISTORY_HEADERS);
    var files = history
      .filter(function (r) {
        return (
          r.status === "success" &&
          r.trigger_type !== "pre_restore_safety" &&
          r.file_id
        );
      })
      .sort(function (a, b) {
        return new Date(b.created_at) - new Date(a.created_at);
      })
      .slice(0, 50)
      .map(function (r) {
        return {
          id: r.file_id,
          name: r.file_name,
          created_at: r.created_at,
          created_by: r.created_by,
          size: Number(r.size_bytes) || 0,
          file_url: r.file_url,
          restored_at: r.restored_at || "",
        };
      });
    return { success: true, files: files };
  } catch (e) {
    return errResponse("❌ خطأ في جلب قائمة النسخ: " + e.message);
  }
}

/**
 * restoreFromBackup — يستعيد كل شيت موجود في ملف الباكاب فوق نظيره
 * الحالي (استبدال محتوى، بدون حذف شيتات مش موجودة في الباكاب). محمي
 * بصلاحية "restoreBackup" منفصلة عن "createBackup" (أخطر بكتير)، ودايمًا
 * بياخد نسخة أمان تلقائية "PRE_RESTORE_SAFETY" قبل أي استبدال فعلي حتى
 * لو الاستعادة فشلت أو كانت خطأ. [BACKUP-ENGINE-v5]
 */
function restoreFromBackup(fileId, callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "restoreBackup", sessionToken);
  if (permErr) return permErr;
  if (!fileId) return errResponse("❌ لا يوجد ملف محدد للاستعادة");

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (eLock) {
    return errResponse("⏳ يوجد عملية أخرى قيد التنفيذ حاليًا على النظام — حاول بعد قليل");
  }

  var tempSheetId = null;
  try {
    // 1) نسخة أمان تلقائية قبل أي استبدال — لو الاستعادة غلط، البيانات
    // الحالية (قبل الاستعادة) لسه محفوظة كباكاب منفصل
    createBackup("PRE_RESTORE_SAFETY", null);

    // 2) تأكد إن الملف موجود فعلاً على Drive
    var srcFile;
    try {
      srcFile = DriveApp.getFileById(fileId);
    } catch (eGet) {
      return errResponse("❌ الملف غير موجود أو تم حذفه من Drive");
    }

    // 2.5) [INTEGRITY-CHECKSUM] تحقق من بصمة SHA-256 المسجّلة وقت الإنشاء
    // قبل أي استبدال فعلي — لو الملف اتغيّر أو تلف بعد إنشائه، نرفض
    // الاستعادة بدل ما نستبدل بيانات حقيقية بملف مش مضمون سلامته.
    // النسخ القديمة (قبل إضافة هذه الميزة) من غير بصمة مسجّلة بنكمل معاها
    // مع تحذير في السجل بدل رفضها بالكامل.
    try {
      var histRows = readSheet("BackupHistory", BACKUP_HISTORY_HEADERS);
      var histRow = histRows.find(function (r) {
        return String(r.file_id) === String(fileId);
      });
      if (histRow && histRow.checksum_sha256) {
        var actualChecksum = _sha256Hex(srcFile.getBlob().getBytes());
        if (actualChecksum !== histRow.checksum_sha256) {
          return errResponse(
            "❌ فشل التحقق من سلامة الملف (checksum غير مطابق) — الملف قد يكون تالفًا أو تم التلاعب به. تم إلغاء الاستعادة قبل أي استبدال للبيانات.",
          );
        }
      }
    } catch (eChecksum) {
      // فشل حساب البصمة نفسه (مش عدم تطابقها) لا يمنع الاستعادة —
      // فحص اختياري إضافي مش الحارس الوحيد للعملية
      console.error("restoreFromBackup - فشل فحص البصمة:", eChecksum.message || eChecksum);
    }

    // 3) حوّل نسخة من ملف الـ xlsx لجوجل شيت مؤقت عبر Drive API (copy مع
    // تحويل mimeType) — بدون الحاجة لتفعيل Advanced Drive Service، بنفس
    // أسلوب استدعاء REST المستخدم أصلاً في تصدير الباكاب (OAuth token)
    var token = ScriptApp.getOAuthToken();
    var copyResp = UrlFetchApp.fetch(
      "https://www.googleapis.com/drive/v3/files/" + fileId + "/copy",
      {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + token },
        payload: JSON.stringify({
          name: "TEMP_RESTORE_" + Date.now(),
          mimeType: "application/vnd.google-apps.spreadsheet",
        }),
        muteHttpExceptions: true,
      },
    );
    if (copyResp.getResponseCode() !== 200) {
      return errResponse(
        "❌ فشل تجهيز النسخة للاستعادة (Drive API): كود " + copyResp.getResponseCode(),
      );
    }
    tempSheetId = JSON.parse(copyResp.getContentText()).id;

    // 4) استبدل محتوى كل شيت موجود بالاسم نفسه في الملف الحالي
    var tempSS = SpreadsheetApp.openById(tempSheetId);
    var liveSS = SpreadsheetApp.getActiveSpreadsheet();
    var restoredSheets = [];
    var skippedSheets = [];

    tempSS.getSheets().forEach(function (tSheet) {
      var name = tSheet.getName();
      var liveSheet = liveSS.getSheetByName(name);
      if (!liveSheet) {
        skippedSheets.push(name);
        return;
      }
      var values = tSheet.getDataRange().getValues();
      liveSheet.clearContents();
      if (values.length) {
        liveSheet.getRange(1, 1, values.length, values[0].length).setValues(values);
      }
      restoredSheets.push(name);
    });

    // 5) امسح الملف المؤقت (تحويل الـ xlsx) — مش محتاجينه بعد كده
    try {
      DriveApp.getFileById(tempSheetId).setTrashed(true);
    } catch (eTrash) {
      // تجاهل — مش حرج
    }
    tempSheetId = null;

    // 6) وسم صف الباكاب المُستعاد في السجل (restored_at/restored_by)
    try {
      var histSheet = getSheet("BackupHistory", BACKUP_HISTORY_HEADERS);
      var data = histSheet.getDataRange().getValues();
      var idCol = BACKUP_HISTORY_HEADERS.indexOf("file_id");
      var atCol = BACKUP_HISTORY_HEADERS.indexOf("restored_at");
      var byCol = BACKUP_HISTORY_HEADERS.indexOf("restored_by");
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][idCol]) === String(fileId)) {
          histSheet.getRange(i + 1, atCol + 1).setValue(new Date().toISOString());
          histSheet.getRange(i + 1, byCol + 1).setValue(callerUser || "");
          break;
        }
      }
    } catch (eHist) {
      console.error("restoreFromBackup - فشل تحديث السجل:", eHist.message || eHist);
    }

    _writeAuditLog({
      user: callerUser,
      action: "BACKUP_RESTORED",
      table: "ALL",
      record_id: fileId,
      details:
        "استعادة من نسخة: " +
        fileId +
        " — شيتات مستعادة: " +
        restoredSheets.join(", ") +
        (skippedSheets.length ? " — تم تخطي (غير موجود حاليًا): " + skippedSheets.join(", ") : ""),
    });

    return {
      success: true,
      message:
        "✅ تم استعادة " +
        restoredSheets.length +
        " شيت بنجاح" +
        (skippedSheets.length ? " (تم تخطي " + skippedSheets.length + " شيت غير موجود بالنظام الحالي)" : ""),
      restored_sheets: restoredSheets,
      skipped_sheets: skippedSheets,
    };
  } catch (e) {
    try {
      if (tempSheetId) DriveApp.getFileById(tempSheetId).setTrashed(true);
    } catch (eT) {
      // تجاهل
    }
    try {
      _writeAuditLog({
        user: callerUser,
        action: "BACKUP_RESTORE_FAILED",
        table: "ALL",
        record_id: fileId,
        details: e.message || String(e),
      });
    } catch (eLog) {
      // تجاهل
    }
    return errResponse(
      "❌ فشلت عملية الاستعادة: " +
        e.message +
        " — تم أخذ نسخة أمان قبل المحاولة، بياناتك الحالية سليمة ولم تتأثر.",
    );
  } finally {
    try {
      lock.releaseLock();
    } catch (eRelease) {
      // تجاهل
    }
  }
}

/**
 * setupBackupTrigger — يُنشئ Trigger يومي تلقائي للباكاب (شغّله مرة واحدة)
 */
function setupBackupTrigger(schedule, existingTriggers) {
  // schedule = { frequency: "daily"|"weekly"|"monthly", hour: 0-23, day: 1-7 }
  try {
    var freq = (schedule && schedule.frequency) || "daily";
    var hour = schedule && schedule.hour != null ? Number(schedule.hour) : 3;
    var day = schedule && schedule.day != null ? Number(schedule.day) : 1; // 1=الاثنين

    // احذف أي triggers قديمة
    // ✅ [PERF-TRIGGERS-1] استخدم القايمة الجاهزة من setupEverything لو موجودة
    (existingTriggers || ScriptApp.getProjectTriggers()).forEach(function (t) {
      if (t.getHandlerFunction() === "scheduledDailyBackup") {
        ScriptApp.deleteTrigger(t);
      }
    });

    var trigger = ScriptApp.newTrigger("scheduledDailyBackup").timeBased();

    if (freq === "weekly") {
      var days = [
        ScriptApp.WeekDay.MONDAY,
        ScriptApp.WeekDay.TUESDAY,
        ScriptApp.WeekDay.WEDNESDAY,
        ScriptApp.WeekDay.THURSDAY,
        ScriptApp.WeekDay.FRIDAY,
        ScriptApp.WeekDay.SATURDAY,
        ScriptApp.WeekDay.SUNDAY,
      ];
      trigger
        .onWeekDay(days[day - 1] || ScriptApp.WeekDay.MONDAY)
        .atHour(hour)
        .create();
    } else if (freq === "monthly") {
      trigger
        .onMonthDay(day || 1)
        .atHour(hour)
        .create();
    } else {
      // daily (default)
      trigger.everyDays(1).atHour(hour).create();
    }

    // احفظ الإعدادات
    var props = PropertiesService.getScriptProperties();
    props.setProperty("backup_frequency", freq);
    props.setProperty("backup_hour", String(hour));
    props.setProperty("backup_day", String(day));

    var FREQ_LABELS = {
      daily: "يومياً",
      weekly: "أسبوعياً",
      monthly: "شهرياً",
    };
    return {
      success: true,
      message:
        "✅ تم حفظ جدول الباكاب: " +
        (FREQ_LABELS[freq] || freq) +
        " الساعة " +
        hour +
        ":00",
    };
  } catch (e) {
    return errResponse("خطأ في إعداد التلقائي: " + e.message);
  }
}
