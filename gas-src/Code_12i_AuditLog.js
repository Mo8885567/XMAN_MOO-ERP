/**
 * ============================================================
 * Module: Code_12i_AuditLog.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * archiveAndTrimAuditLog — يُنفَّذ أسبوعياً من Trigger
 *
 * الخوارزمية:
 *   1. إذا كان عدد الصفوف ≤ MAX_ROWS: لا شيء
 *   2. يأخذ الصفوف القديمة (ما فوق ARCHIVE_KEEP الأحدث)
 *   3. يكتبها في ملف CSV مؤرشَف على Google Drive
 *   4. يحذفها من شيت AuditLog
 *   5. يُسجّل عملية الأرشفة في AuditLog
 */
function archiveAndTrimAuditLog() {
  try {
    var sheet = getSheet("AuditLog", AUDIT_HEADERS);
    var lastRow = sheet.getLastRow();
    var dataRows = lastRow - 1; // بدون صف الـ headers

    if (dataRows <= AUDIT_LOG_CONFIG.MAX_ROWS) {
      Logger.log(
        "archiveAndTrimAuditLog: " + dataRows + " rows — لا حاجة للأرشفة",
      );
      return;
    }

    // الصفوف التي سنؤرشفها = كل ما قبل الـ ARCHIVE_KEEP الأحدث
    var rowsToArchive = dataRows - AUDIT_LOG_CONFIG.ARCHIVE_KEEP;
    if (rowsToArchive <= 0) return;

    // قراءة الصفوف المراد أرشفتها (من صف 2 إلى rowsToArchive+1)
    var archiveData = sheet
      .getRange(2, 1, rowsToArchive, AUDIT_HEADERS.length)
      .getValues();

    // بناء محتوى CSV
    var csvLines = [AUDIT_HEADERS.join(",")];
    archiveData.forEach(function (row) {
      var line = row
        .map(function (cell) {
          var v =
            cell instanceof Date
              ? Utilities.formatDate(
                  cell,
                  Session.getScriptTimeZone(),
                  "yyyy-MM-dd HH:mm:ss",
                )
              : String(cell).replace(/"/g, '""');
          return '"' + v + '"';
        })
        .join(",");
      csvLines.push(line);
    });
    var csvContent = csvLines.join("\n");

    // إيجاد أو إنشاء مجلد الأرشيف في Drive
    // [FILE-ENGINE] موحّد الآن عبر FileEngine.getOrCreateFolder بدل تكرار
    // نفس منطق "إيجاد فولدر أو إنشاؤه" في نسخة رابعة.
    var folder = FileEngine.getOrCreateFolder(
      AUDIT_LOG_CONFIG.ARCHIVE_FOLDER,
      FileEngine.getSpreadsheetContainerFolder(),
    );

    // اسم ملف الأرشيف: AuditLog_Archive_2026-01.csv
    var stamp = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM",
    );
    var fileName = "AuditLog_Archive_" + stamp + ".csv";

    // إذا الملف موجود لهذا الشهر: استبداله
    var existingFiles = folder.getFilesByName(fileName);
    if (existingFiles.hasNext()) existingFiles.next().setTrashed(true);

    folder.createFile(fileName, csvContent, MimeType.CSV);

    // حذف الصفوف المؤرشَفة من الشيت
    sheet.deleteRows(2, rowsToArchive);

    // تسجيل عملية الأرشفة
    _writeAuditLog({
      user: "SYSTEM",
      action: "AUDIT_ARCHIVE",
      table: "AuditLog",
      details:
        "تمت أرشفة " +
        rowsToArchive +
        " سجل → " +
        fileName +
        " | تبقى: " +
        AUDIT_LOG_CONFIG.ARCHIVE_KEEP,
    });

    Logger.log(
      "archiveAndTrimAuditLog: أُرشِفت " + rowsToArchive + " صف → " + fileName,
    );
  } catch (e) {
    console.warn("archiveAndTrimAuditLog error:", e.message);
  }
}

/**
 * setupAuditLogTrimTrigger — يُنشئ Trigger أسبوعي للأرشفة التلقائية
 * شغّلها مرة واحدة يدوياً من Apps Script Editor
 */
function setupAuditLogTrimTrigger(existingTriggers) {
  try {
    // إزالة أي Trigger سابق لنفس الدالة
    // ✅ [PERF-TRIGGERS-1] استخدم القايمة الجاهزة من setupEverything لو موجودة
    (existingTriggers || ScriptApp.getProjectTriggers()).forEach(function (t) {
      if (t.getHandlerFunction() === "archiveAndTrimAuditLog")
        ScriptApp.deleteTrigger(t);
    });
    // Trigger أسبوعي: كل أحد الساعة 2 صباحاً
    ScriptApp.newTrigger("archiveAndTrimAuditLog")
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.SUNDAY)
      .atHour(2)
      .create();
    _writeAuditLog({
      user: "SYSTEM",
      action: "SETUP_AUDIT_TRIGGER",
      table: "System",
      details: "تم إعداد Trigger أسبوعي لأرشفة AuditLog كل أحد 2 صباحاً",
    });
    return {
      success: true,
      message: "✅ تم إعداد أرشفة AuditLog أسبوعياً (كل أحد 2 صباحاً)",
    };
  } catch (e) {
    return { success: false, message: "خطأ: " + e.message };
  }
}

/**
 * _diffObjects — v4.1: يقارن كائنين ويُعيد فقط الحقول المختلفة
 * مفيد لتقليل حجم old/new value في الـ Audit Log
 *
 * مثال:
 *   _diffObjects({ price: 100, name: "قميص" }, { price: 150, name: "قميص" })
 *   → { old: { price: 100 }, new: { price: 150 } }
 */
function _diffObjects(oldObj, newObj) {
  var oldDiff = {};
  var newDiff = {};
  var allKeys = Object.keys(Object.assign({}, oldObj || {}, newObj || {}));
  allKeys.forEach(function (k) {
    if (k === "_row" || k === "password") return; // تجاهل حقول حساسة
    var ov = oldObj ? oldObj[k] : undefined;
    var nv = newObj ? newObj[k] : undefined;
    if (JSON.stringify(ov) !== JSON.stringify(nv)) {
      oldDiff[k] = ov;
      newDiff[k] = nv;
    }
  });
  return { old: oldDiff, new: newDiff };
}

/**
 * _addAuditLog — [BUG-FIX] غلاف توافق (compatibility wrapper) فوق
 * _writeAuditLog(entry). كانت هذه الدالة تُستدعى بالشكل القديم
 * (user, action, table, record_id, old_value, new_value) في 11 موضعاً
 * عبر المشروع (ChartOfAccounts, JournalEntries, Reports, Core, Sales)
 * دون أن تكون معرّفة في أي مكان إطلاقاً — ما كان يعني ReferenceError
 * فعلي عند تنفيذ أي عملية حذف/تعديل محاسبي أو بيع تمر بها.
 * التوقيع هنا مطابق تماماً لكل نقاط الاستدعاء الفعلية في الكود.
 */
function _addAuditLog(user, action, table, record_id, old_value, new_value) {
  _writeAuditLog({
    user: user,
    action: action,
    table: table,
    record_id: record_id,
    old_value: old_value,
    new_value: new_value,
  });
}

function _writeAuditLog(entry) {
  try {
    // ✅ [PERF-2] لو المستدعي عارف full_name مسبقاً (مثلاً login() بعد ما قرا
    // المستخدم بالفعل) بيبعته في entry.displayName فنستخدمه مباشرة بدل ما
    // نعيد قراءة شيت Users بالكامل فقط لترجمة username → full_name.
    var displayName = entry.displayName || entry.user || "";
    if (
      !entry.displayName &&
      displayName &&
      displayName !== "SYSTEM" &&
      displayName !== "SCHEDULED_TRIGGER"
    ) {
      try {
        var users = readSheet("Users");
        var found = users.find(function (u) {
          return (
            String(u.username || "")
              .trim()
              .toLowerCase() === displayName.trim().toLowerCase()
          );
        });
        if (found && found.full_name && String(found.full_name).trim()) {
          displayName = String(found.full_name).trim();
        }
      } catch (e) {
        /* تجاهل لو فشل البحث */
      }
    }

    // ← v4.1: تنسيق old_value / new_value
    var oldVal = "";
    var newVal = "";
    if (entry.old_value !== undefined && entry.old_value !== null) {
      oldVal =
        typeof entry.old_value === "object"
          ? JSON.stringify(entry.old_value)
          : String(entry.old_value);
    }
    if (entry.new_value !== undefined && entry.new_value !== null) {
      newVal =
        typeof entry.new_value === "object"
          ? JSON.stringify(entry.new_value)
          : String(entry.new_value);
    }

    var sheet = getSheet("AuditLog", AUDIT_HEADERS);
    var _auditRow = [
      new Date(),
      displayName,
      entry.action || "",
      entry.table || "",
      entry.record_id || "",
      entry.details || "",
      entry.ip || "",
      oldVal, // ← v4.1
      newVal, // ← v4.1
    ];
    // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
    // _appendRowProtected) — بدون قفل عمدًا هنا لتفادي إبطاء أعلى مسار
    // كتابة تكرارًا في النظام؛ التعارض النادر هنا (لون فقط، مش فقدان بيانات)
    // مقبول مقابل الأداء.
    var _auditNextRow = sheet.getLastRow() + 1;
    sheet.getRange(_auditNextRow, 1, 1, _auditRow.length).setFontColor(null);
    sheet.appendRow(_auditRow);
    // تنظيف السجلات القديمة يتم من trimAuditLog() المنفصلة — لا نبطّئ كل write
  } catch (e) {
    console.warn("AuditLog write failed:", e.message);
  }
}

/**
 * trimAuditLog — يحذف السجلات القديمة فوق 5000
 * شغّلها من trigger أسبوعي أو يدوياً
 */
function trimAuditLog() {
  try {
    var sheet = getSheet("AuditLog", AUDIT_HEADERS);
    var lastRow = sheet.getLastRow();
    if (lastRow > 5001) {
      sheet.deleteRows(2, lastRow - 5001);
      Logger.log("trimAuditLog: removed " + (lastRow - 5001) + " old rows");
    }
  } catch (e) {
    console.warn("trimAuditLog error:", e.message);
  }
}

/**
 * يقرأ سجل التدقيق (AuditLog) مع دعم الفلترة والحد الأقصى للنتائج.
 *
 * Business Rules:
 * - الحد الأقصى لعدد النتائج المُعادة هو 300 صف مهما طلب المستدعي أكثر
 *   (حماية من طلبات ثقيلة تُبطئ الواجهة).
 * - عند وجود فلاتر نشطة (user/action/table/dateFrom/dateTo/search)،
 *   تُقرأ كمية أكبر من الصفوف الخام ثم تُفلتر في الذاكرة؛ بدون فلاتر
 *   تُقرأ فقط العدد المطلوب مباشرة لتوفير الأداء.
 *
 * @param {Number} [limit=100] - أقصى عدد نتائج مطلوب (يُقص عند 300).
 * @param {Object} [filters] - { user, action, table, dateFrom, dateTo, search }.
 * @returns {{success: Boolean, data: Array<Object>, total: Number}}
 */
function getAuditLog(limit, filters) {
  try {
    limit = Math.min(Number(limit) || 100, 300); // ✅ FIX: قلّل الحد الأقصى من 1000 → 300
    filters = filters || {};

    var sheet = getSheet("AuditLog", AUDIT_HEADERS);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { success: true, data: [], total: 0 };

    // ✅ FIX: لو في فلاتر نشطة → اجلب أكثر للفلترة، وإلا اجلب بالضبط ما يحتاجه العرض
    var hasFilters =
      filters.user ||
      filters.action ||
      filters.table ||
      filters.dateFrom ||
      filters.dateTo ||
      filters.search;
    var fetchRows = hasFilters
      ? Math.min(lastRow - 1, limit * 2) // فلتر → ضعف اللميت كافٍ
      : Math.min(lastRow - 1, limit); // بدون فلتر → بالضبط اللميت

    var startRow = Math.max(2, lastRow - fetchRows + 1);
    var numRows = lastRow - startRow + 1;

    // ✅ FIX: اجلب 6 أعمدة فقط (بدون ip) لتقليل البيانات المنقولة
    var rawData = sheet.getRange(startRow, 1, numRows, 6).getValues();
    var headers = AUDIT_HEADERS.slice(0, 6); // timestamp,user,action,table,record_id,details

    var rows = rawData.reverse().map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) {
        obj[h] =
          row[i] instanceof Date ? row[i].toISOString() : String(row[i] || "");
      });
      return obj;
    });

    // ── تطبيق الفلاتر ──────────────────────────────────────────
    if (filters.user) {
      rows = rows.filter(function (r) {
        return r.user === filters.user;
      });
    }
    if (filters.action) {
      rows = rows.filter(function (r) {
        return (
          String(r.action || "")
            .toUpperCase()
            .indexOf(filters.action.toUpperCase()) !== -1
        );
      });
    }
    if (filters.table) {
      rows = rows.filter(function (r) {
        return r.table === filters.table;
      });
    }
    if (filters.dateFrom) {
      var from = new Date(filters.dateFrom);
      rows = rows.filter(function (r) {
        return new Date(r.timestamp) >= from;
      });
    }
    if (filters.dateTo) {
      var to = new Date(filters.dateTo);
      to.setHours(23, 59, 59);
      rows = rows.filter(function (r) {
        return new Date(r.timestamp) <= to;
      });
    }
    if (filters.search) {
      var q = filters.search.toLowerCase();
      rows = rows.filter(function (r) {
        return (
          String(r.user || "")
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.action || "")
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.details || "")
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.record_id || "")
            .toLowerCase()
            .indexOf(q) !== -1
        );
      });
    }

    var total = rows.length;
    rows = rows.slice(0, limit);

    // إحصائيات سريعة
    var stats = {
      total: total,
      byAction: {},
      byUser: {},
    };
    rows.forEach(function (r) {
      var actionType = String(r.action || "").split("_")[0];
      stats.byAction[actionType] = (stats.byAction[actionType] || 0) + 1;
      stats.byUser[r.user] = (stats.byUser[r.user] || 0) + 1;
    });

    return { success: true, data: rows, total: total, stats: stats };
  } catch (e) {
    return { success: false, data: [], message: e.message };
  }
}

/**
 * يمسح سجل التدقيق بالكامل (Hard Delete لكل الصفوف). عملية حساسة
 * تفقد كل تاريخ العمليات، لذا مقيّدة بدور "admin" فقط.
 *
 * Business Rules:
 * - يتطلب صلاحية "viewAuditLog" بالإضافة لدور admin صراحةً (فحص مزدوج).
 * - يُسجَّل حدث CLEAR_AUDIT_LOG في السجل الجديد فور المسح، فلا يبقى
 *   السجل فارغًا تمامًا من أي أثر لهذه العملية بالذات.
 *
 * @param {String} callerUser - اسم المستخدم المنفِّذ.
 * @param {String} sessionToken - توكن الجلسة.
 * @returns {{success: Boolean, message: String}}
 */
function clearAuditLog(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewAuditLog", sessionToken);
    if (permErr) return permErr;

    var user = getSheetData("Users").find(function (u) {
      return u.username === callerUser;
    });
    if (!user || user.role !== "admin")
      return errResponse("فقط الـ admin يمكنه مسح السجل");

    var sheet = getSheet("AuditLog", AUDIT_HEADERS);
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1);
    }

    _writeAuditLog({
      user: callerUser,
      action: "CLEAR_AUDIT_LOG",
      table: "AuditLog",
      record_id: "",
      details: "تم مسح سجل العمليات بالكامل",
    });

    return okResponse("✅ تم مسح سجل العمليات");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * يصدّر آخر 1000 سجل من سجل التدقيق كنص CSV بترويسة عربية، جاهز
 * للتنزيل من الواجهة.
 *
 * @param {String} callerUser - اسم المستخدم الطالب (لفحص صلاحية viewAuditLog).
 * @param {String} sessionToken - توكن الجلسة.
 * @returns {{success: Boolean, csv: String=, message: String=}}
 */
function exportAuditLogCSV(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "viewAuditLog", sessionToken);
    if (permErr) return permErr;

    var result = getAuditLog(1000);
    if (!result.success) return result;

    var csv = "التاريخ,المستخدم,العملية,الجدول,المعرف,التفاصيل\n";
    result.data.forEach(function (row) {
      csv +=
        [
          '"' + (row.timestamp || "") + '"',
          '"' + (row.user || "") + '"',
          '"' + (row.action || "") + '"',
          '"' + (row.table || "") + '"',
          '"' + (row.record_id || "") + '"',
          '"' + String(row.details || "").replace(/"/g, '""') + '"',
        ].join(",") + "\n";
    });

    return { success: true, csv: csv };
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

