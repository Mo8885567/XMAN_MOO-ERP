// ══════════════════════════════════════════════════════════════════════════
// Code_35_FileEngine.gs — محرك إدارة الملفات الموحّد (FileEngine)
// ──────────────────────────────────────────────────────────────────────────
// السبب: نفس منطق "تحقق من نوع/حجم الملف ثم أنشئ فولدر Drive إن لم يوجد ثم
// ارفع وشارك" كان مكرَّرًا حرفيًا (بفروق طفيفة) في 6 أماكن مختلفة:
//   - uploadFile()            في Code_21_Setup.gs
//   - uploadPartyDocument()   في Code_21_Setup.gs
//   - _uploadPdfToDrive()     في Code_21_Setup.gs
//   - uploadImageToDrive()    في Code_17_Manufacturing.gs
//   - uploadWAAttachment()    في Code_24_WhatsApp.gs
//   - أرشفة سجل التدقيق       في Code_12_Core.gs
//
// [FILE-ENGINE-DESIGN] المحرك:
//   - لا يغيّر أي دالة عامة (public function) مستخدَمة من الواجهة — كل
//     الدوال أعلاه لسه بنفس الاسم ونفس شكل القيمة المُرجعة بالظبط، وبقت
//     بس تستدعي FileEngine داخليًا بدل تكرار المنطق.
//   - getOrCreateFolder() العامة (المُعرَّفة أصلاً في Code_21_Setup.gs)
//     اتسابت بنفس الاسم لتوافق أي كود قديم بينادي عليها مباشرة، لكن
//     جسمها بقى يفوّض لـ FileEngine.getOrCreateFolder لمنع نسخة تالتة
//     من نفس المنطق.
//
// طريقة الاستخدام من أي ملف .gs في نفس المشروع:
//   var r = FileEngine.upload(base64Data, fileName, mimeType, {
//     allowedMap: FileEngine.DOCUMENT_MIME_MAP,   // أو IMAGE_MIME_MAP أو خريطة مخصّصة
//                                                  // أو null صراحةً = بدون قيود امتداد/نوع
//                                                  // (لمرفقات مفتوحة زي واتساب)
//     folderPath: ["مجلد رئيسي", "مجلد فرعي"],
//     newFileName: "اسم-اختياري-بديل" // لو مش موجود بيستخدم fileName الأصلي
//   });
//   if (!r.success) return errResponse(r.error);
//   // r.viewUrl / r.thumbUrl / r.downloadUrl / r.fileId
//
// لمشاركة ملف منشأ يدويًا خارج FileEngine.upload (مثلاً Blob جاهز من تقرير
// PDF داخلي) استخدم FileEngine.shareFile(file) بدل تكرار سطر setSharing.
//
// [FILE-ENGINE-EXCEPTIONS] استثناءات مقصودة (مش سهو) — مراجعة تُجرى دوريًا:
//   - أرشفة سجل التدقيق CSV (Code_12_Core.gs): فولدر الأرشفة فقط عبر
//     FileEngine.getOrCreateFolder، أما إنشاء ملف الـ CSV نفسه فيدوي عمدًا،
//     لأنه أرشفة داخلية للنظام مش رفع ملف مستخدم — منطق FileEngine.validate
//     (تحقق نوع/حجم) مش منطبق عليه من الأساس.
//   - _uploadPdfToDrive (Code_21_Setup.gs): الفولدر عبر FileEngine، والمشاركة
//     عبر FileEngine.shareFile، لكن إنشاء الملف نفسه يدوي عمدًا لأن الـ Blob
//     جاهز مُنشأ داخليًا من تقرير PDF مش رفع مستخدم يحتاج تحقق.
//
// [CODE-REVIEW-RULE] أي DriveApp.createFolder أو DriveApp.createFile /
// folder.createFile جديد يُضاف في أي ملف Code_*.gs لازم يمر عبر
// FileEngine (getOrCreateFolder / getOrCreateFolderPath / upload / shareFile)
// أو يُذكر صراحةً في وصف الـ PR سبب الاستثناء (زي حالتين CSV وPDF أعلاه).
// نفس القاعدة مطبّقة بالفعل على أي منطق DataLayer جديد خارج
// DataLayerEngine، وأي منطق حالة/انتقال جديد خارج WorkflowEngine —
// الهدف إن أي محرك موحّد ميتلفش تاني بتكرار يدوي في ملف جديد.
// ══════════════════════════════════════════════════════════════════════════

var FileEngine = (function () {
  "use strict";

  var DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB — نفس الحد المستخدم في كل نقاط الرفع الحالية

  // خرائط الامتداد ↔ mimeType. أي حالة مستقبلية جديدة (مثلاً مرفقات
  // Manufacturing أو مستقبلًا فواتير) تقدر تمرر خريطة مخصصة بدل الاثنين دول.
  var DOCUMENT_MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
  };

  var IMAGE_MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };

  function _ext(fileName) {
    var i = String(fileName || "").lastIndexOf(".");
    return i > 0 ? String(fileName).substring(i) : "";
  }

  // ── تنظيف مقطع اسم فولدر/ملف من محاولات Path Traversal — نفس الريجيكس
  // المستخدم أصلاً في uploadFile للـ userName/moduleName، عمّمناه هنا. ──
  function sanitizeSegment(value, fallback) {
    var out = String(value || "")
      .replace(/[^a-zA-Z0-9\u0600-\u06FF\s\-_]/g, "")
      .trim();
    return out || fallback || "عام";
  }

  // ── تحقق من نوع/امتداد/حجم الملف قبل الرفع ──────────────────────────
  // allowedMap === null صراحةً يعني "خريطة مفتوحة" (بدون قيود امتداد/نوع) —
  // للحالات اللي مفيش عليها قيود امتداد رسمية (مثل مرفقات واتساب)، بدل ما
  // نتخطى التحقق بالكامل ونفوّت الحد الأقصى للحجم كمان.
  // allowedMap === undefined (لم يُمرَّر) بيرجع للسلوك الافتراضي DOCUMENT_MIME_MAP.
  function validate(base64Data, fileName, mimeType, allowedMap, maxSizeBytes) {
    var openMap = allowedMap === null;
    if (allowedMap === undefined) allowedMap = DOCUMENT_MIME_MAP;
    maxSizeBytes = maxSizeBytes || DEFAULT_MAX_SIZE_BYTES;

    if (!base64Data || !fileName) {
      return { success: false, error: "بيانات الملف غير مكتملة" };
    }

    var ext = _ext(fileName).toLowerCase();
    var cleanMime = String(mimeType || "")
      .toLowerCase()
      .trim();
    var expectedMime;

    if (openMap) {
      expectedMime = cleanMime || "application/octet-stream";
    } else {
      expectedMime = allowedMap[ext];
      if (!expectedMime) {
        return { success: false, error: "امتداد الملف غير مسموح به: " + ext };
      }
      if (cleanMime) {
        var allowedMimes = [];
        for (var k in allowedMap) allowedMimes.push(allowedMap[k]);
        if (allowedMimes.indexOf(cleanMime) === -1) {
          return { success: false, error: "نوع الملف غير مسموح به: " + cleanMime };
        }
      }
    }

    var approxSize = Math.floor((base64Data.length * 3) / 4);
    if (approxSize > maxSizeBytes) {
      return {
        success: false,
        error:
          "حجم الملف يتجاوز الحد المسموح (" +
          Math.round(maxSizeBytes / (1024 * 1024)) +
          "MB)",
      };
    }

    return { success: true, ext: ext, mimeType: expectedMime };
  }

  // ── إيجاد فولدر أو إنشاؤه — نسخة واحدة موحّدة بدل التكرار في 4 أماكن ──
  function getOrCreateFolder(name, parentFolder) {
    var it = parentFolder
      ? parentFolder.getFoldersByName(name)
      : DriveApp.getFoldersByName(name);
    if (it.hasNext()) return it.next();
    return parentFolder ? parentFolder.createFolder(name) : DriveApp.createFolder(name);
  }

  // ── فولدر الشيت الحاوي — كل هيكل الفولدرات بيتبني جواه بدل ما يروح على
  // جذر Drive بتاع اللي شغّل الكود. Cache على مستوى الـ execution لتجنب
  // نداء Drive أكتر من مرة في نفس الطلب. ───────────────────────────────
  var _spreadsheetContainerFolder = undefined;
  function _getSpreadsheetContainerFolder() {
    if (_spreadsheetContainerFolder !== undefined) return _spreadsheetContainerFolder;
    try {
      var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
      var parents = DriveApp.getFileById(ssId).getParents();
      _spreadsheetContainerFolder = parents.hasNext() ? parents.next() : null;
    } catch (e) {
      Logger.log("[FileEngine._getSpreadsheetContainerFolder] خطأ: " + e.message);
      _spreadsheetContainerFolder = null;
    }
    return _spreadsheetContainerFolder;
  }

  // ── إنشاء مسار فولدرات متداخل دفعة واحدة، مثال:
  //    ["مستندات المخازن", "أحمد", "إذن وارد"] ── أول فولدر في المسار
  // بيتنشئ جوه فولدر الشيت نفسه (مش جذر Drive) لو مقدرناش نوصله بيتنشئ
  // على الجذر زي الأول (fallback آمن). ──────────────────────────────────
  function getOrCreateFolderPath(pathParts) {
    var folder = _getSpreadsheetContainerFolder();
    for (var i = 0; i < pathParts.length; i++) {
      folder = getOrCreateFolder(pathParts[i], folder);
    }
    return folder;
  }

  // ── ضبط مشاركة ملف بنفس المستوى المستخدم في كل نقاط الرفع (رابط عام
  // للعرض فقط) — بدل تكرار DriveApp.Access.ANYONE_WITH_LINK في كل ملف ──
  function shareFile(file, options) {
    options = options || {};
    if (options.public === true) {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }
    return file;
  }

  // ── رفع ملف كامل: تحقق + فولدرات متداخلة + رفع + مشاركة برابط ────────
  // options: { allowedMap, maxSizeBytes, folderPath: [...], newFileName }
  function upload(base64Data, fileName, mimeType, options) {
    options = options || {};

    var check = validate(
      base64Data,
      fileName,
      mimeType,
      options.allowedMap,
      options.maxSizeBytes,
    );
    if (!check.success) return check;

    var decoded = Utilities.base64Decode(base64Data);
    var blob = Utilities.newBlob(decoded, mimeType || check.mimeType, fileName);

    var finalName = options.newFileName || fileName;
    var folder =
      options.targetFolder || getOrCreateFolderPath(options.folderPath || ["ملفات عامة"]);
    var file = shareFile(folder.createFile(blob.setName(finalName)), options);

    return {
      success: true,
      fileName: finalName,
      fileId: file.getId(),
      viewUrl: "https://drive.google.com/file/d/" + file.getId() + "/view",
      thumbUrl:
        "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w800",
      downloadUrl:
        "https://drive.google.com/uc?export=download&id=" + file.getId(),
    };
  }

  return {
    validate: validate,
    sanitizeSegment: sanitizeSegment,
    getOrCreateFolder: getOrCreateFolder,
    getOrCreateFolderPath: getOrCreateFolderPath,
    getSpreadsheetContainerFolder: _getSpreadsheetContainerFolder,
    upload: upload,
    shareFile: shareFile,
    DOCUMENT_MIME_MAP: DOCUMENT_MIME_MAP,
    IMAGE_MIME_MAP: IMAGE_MIME_MAP,
  };
})();
