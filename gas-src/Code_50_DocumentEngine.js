// ══════════════════════════════════════════════════════════════════════════
// Code_50_DocumentEngine.gs — محرك إدارة المستندات المركزي (Document Management
// Engine) — Phase 1: Storage Engine + هيكل فولدرات تلقائي + توجيه ذكي +
// جدول ملفات موحّد.
// ──────────────────────────────────────────────────────────────────────────
// [DOC-ENGINE-DESIGN]
//  - StorageProvider: واجهة موحّدة (createFolder/upload/deleteFile/moveFile)
//    مستقلة عن Google Drive بالكامل. المزوّد الحالي DriveStorageProvider
//    (يستخدم FileEngine الموجود بالفعل في Code_35 للتحقق/المشاركة). لو
//    اتقرر مستقبلًا الانتقال لـ Supabase/S3/R2، المطلوب فقط كتابة
//    provider جديد بنفس الواجهة الأربعة وتغيير DocumentEngine.provider —
//    بدون أي تعديل في الشاشات أو منطق الأعمال.
//  - DocumentEngine: الطبقة اللي فعليًا بتستخدمها الشاشات — مسؤولة عن هيكل
//    الفولدرات لكل طرف (عميل/مورد)، والتوجيه الذكي لنوع الملف لمكانه
//    الصحيح، وتسجيل كل ملف في جدول "Files" الموحّد (metadata لا تعتمد على
//    الرابط فقط).
//  - لا تكرار: أي رفع جديد لازم يمر من هنا أو من FileEngine مباشرة (للحالات
//    البسيطة اللي مالهاش هيكل عميل/مورد، زي مرفقات واتساب) — نفس قاعدة
//    [CODE-REVIEW-RULE] المذكورة في أعلى Code_35_FileEngine.gs.
//
// المراحل القادمة (خارج نطاق هذا الملف حاليًا):
//   Phase 2: ✅ مكتمل — مراجعة كل حقول "رابط الصورة/المستند" في الواجهة
//            واستبدالها بمكوّن رفع موحّد (Upload Widget) يستخدم uploadPartyFile.
//   Phase 3: ✅ منفّذ جزئيًا (Opt-in) — CompressionEngine (Code_51) بيوفّر
//            مزوّدين (tinypng ضغط حقيقي / thumbnail_only بدون ضغط) عبر
//            options.compress في uploadPartyFile/uploadItemFile/
//            uploadProductionFile — مفيش تفعيل تلقائي، الاستدعاء الحالي
//            الوحيد المتصل فعليًا هو استيراد Excel بالجملة (راجع
//            Code_29_ImportEngine.js § opts.compressImages). ربط الضغط
//            بمسارات الرفع اليدوي الأخرى (صور الصنف/الإنتاج مباشرة من
//            الواجهة) لسه مش متصل بواجهة مستخدم — الـ API جاهز فقط.
//   Phase 4: ✅ مكتمل (لأطراف/عملاء وموردين) — رفع بنفس original_name لنفس
//            السجل/doc_type بيتعرّف كنسخة جديدة: القديمة تتنقل لفولدر
//            "07_Backup" تحت جذر الطرف (بدون حذف)، وعمود version في شيت
//            Files بقى حقيقي (مش ثابت 1). غير مفعّل لأصناف/إنتاج (مفيش
//            فولدر Backup مخصص لهم في الهيكل الحالي) — لسه بيرفعوا زي الأول.
//   Phase 5: ✅ مكتمل جزئيًا — عند حذف عميل/مورد (_deleteParty)، فولدر
//            الطرف بالكامل (مش السجل بس) بينتقل لـ ROOT/"Archive"/{النوع}/
//            عبر DocumentEngine.archivePartyFolder — فشل صامت، الحذف نفسه
//            ميتأثرش. + DocumentEngine.getStorageStats() (ومكشوفة كـ
//            getDocumentEngineStorageStats() لـ google.script.run) بترجع
//            إجمالي عدد/حجم الملفات + تفصيل حسب owner_module/doc_type +
//            عدد المضغوط والمؤرشف. الناقص فعليًا: ربط الدالة دي بواجهة
//            فعلية (شاشة/كارت إحصائيات) — الـ API جاهز فقط، ومفيش لوحة
//            مرئية بعد.
// ══════════════════════════════════════════════════════════════════════════

var FILES_SHEET = "Files";
var FILES_HEADERS = [
  "id",
  "drive_id",
  "folder_id",
  "owner_module", // "customer" | "supplier" | "item" | ... إلخ
  "record_id", // معرف السجل صاحب الملف (party id غالبًا في Phase 1)
  "doc_type", // مثال: "national_id" | "tax_card" | "contract" | "invoice_attachment"
  "file_name",
  "original_name",
  "extension",
  "mime_type",
  "file_size",
  "view_url",
  "thumb_url",
  "download_url",
  "uploaded_by",
  "version",
  "notes",
  "tags",
  "is_archived",
  "is_deleted",
  "created_at",
  "updated_at",
  "compression_provider", // [PHASE-3] "tinypng" لو اتضغط فعليًا، وإلا فاضي
  "original_size", // [PHASE-3] الحجم قبل الضغط (لو الضغط اتفعّل)، وإلا فاضي
];

// ── StorageProvider: واجهة موحّدة (Drive حاليًا، أي مزوّد تاني مستقبلًا) ──
var DriveStorageProvider = (function () {
  function createFolder(name, parentFolder) {
    return FileEngine.getOrCreateFolder(name, parentFolder || null);
  }

  function createFolderPath(pathParts) {
    return FileEngine.getOrCreateFolderPath(pathParts);
  }

  function upload(base64Data, fileName, mimeType, options) {
    return FileEngine.upload(base64Data, fileName, mimeType, options);
  }

  function deleteFile(fileId) {
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function moveFile(fileId, targetFolder) {
    try {
      var file = DriveApp.getFileById(fileId);
      var parents = file.getParents();
      while (parents.hasNext()) file.removeFolder(parents.next());
      targetFolder.addFile(file);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // [PHASE-5] نقل فولدر كامل (مش ملف) لأب تاني — مستخدم في أرشفة فولدر
  // الطرف بالكامل عند الحذف. نفس منطق moveFile لكن على مستوى Folder.
  function moveFolder(folder, targetParentFolder) {
    try {
      var parents = folder.getParents();
      while (parents.hasNext()) parents.next().removeFolder(folder);
      targetParentFolder.addFolder(folder);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return {
    createFolder: createFolder,
    createFolderPath: createFolderPath,
    upload: upload,
    deleteFile: deleteFile,
    moveFile: moveFile,
    moveFolder: moveFolder,
  };
})();

var DocumentEngine = (function () {
  "use strict";

  // مزوّد التخزين الحالي — التبديل المستقبلي (مثلاً Supabase) يتم بتغيير
  // هذا السطر فقط، بشرط إن المزوّد الجديد يوفّر نفس الدوال الأربعة.
  var provider = DriveStorageProvider;

  // اسم الفولدر الجذري لكل مستندات النظام في Drive — كل شيء تحته، مفيش
  // فولدرات متناثرة في جذر الدرايف.
  var ROOT_FOLDER_NAME = "MOO.ERP - المستندات";

  // هيكل الفولدرات الثابت لكل عميل/مورد (§ثانياً في الطلب)
  var PARTY_SUBFOLDERS = [
    "01_Profile",
    "02_Documents",
    "04_Invoices",
    "05_Payments",
    "06_Reports",
    "07_Backup",
    "Archive",
  ];
  var PARTY_IMAGE_SUBFOLDERS = [
    "Personal",
    "National ID",
    "Tax Card",
    "Commercial Register",
    "Contracts",
    "Attachments",
  ];

  // ── التوجيه الذكي: نوع المستند → مسار الفولدر تحت جذر الطرف ──────────
  var DOC_TYPE_ROUTING = {
    personal_photo: ["03_Images", "Personal"],
    national_id: ["03_Images", "National ID"],
    tax_card: ["03_Images", "Tax Card"],
    commercial_register: ["03_Images", "Commercial Register"],
    contract: ["03_Images", "Contracts"],
    attachment: ["03_Images", "Attachments"],
    invoice: ["04_Invoices"],
    payment: ["05_Payments"],
    report: ["06_Reports"],
    profile: ["01_Profile"],
    document: ["02_Documents"],
  };

  function _resolveDocTypePath(docType) {
    return DOC_TYPE_ROUTING[docType] || ["02_Documents"];
  }

  // ── إنشاء (أو إيجاد) هيكل فولدرات كامل لعميل/مورد — Idempotent: آمن
  // للاستدعاء أكثر من مرة، لن يُنشئ فولدرات مكررة. ──────────────────────
  function ensurePartyFolders(partyType, code, name) {
    var typeFolderName = partyType === "supplier" ? "الموردون" : "العملاء";
    var partyFolderName =
      FileEngine.sanitizeSegment(code, "بدون-كود") +
      " - " +
      FileEngine.sanitizeSegment(name, "بدون-اسم");

    var root = provider.createFolderPath([ROOT_FOLDER_NAME, typeFolderName, partyFolderName]);

    // ── الفولدرات الفرعية الثابتة ──
    PARTY_SUBFOLDERS.forEach(function (sub) {
      provider.createFolder(sub, root);
    });
    // ── 03_Images ومجلداتها الفرعية ──
    var imagesFolder = provider.createFolder("03_Images", root);
    PARTY_IMAGE_SUBFOLDERS.forEach(function (sub) {
      provider.createFolder(sub, imagesFolder);
    });

    return { success: true, folderId: root.getId(), folderUrl: root.getUrl() };
  }

  // ── إيجاد فولدر الطرف الجذري بدون إعادة إنشاء الهيكل الفرعي كل مرة
  // (يُستخدم وقت الرفع الفعلي، بعد ما يكون ensurePartyFolders اتنفذت أصلًا
  // عند إنشاء الطرف) — fallback: لو مش موجود (طرف قديم قبل هذا التحديث)
  // بينشئه عادي أول مرة. ──────────────────────────────────────────────
  function _getPartyRootFolder(partyType, code, name) {
    var typeFolderName = partyType === "supplier" ? "الموردون" : "العملاء";
    var partyFolderName =
      FileEngine.sanitizeSegment(code, "بدون-كود") +
      " - " +
      FileEngine.sanitizeSegment(name, "بدون-اسم");
    return provider.createFolderPath([ROOT_FOLDER_NAME, typeFolderName, partyFolderName]);
  }

  // ── تسجيل صف في جدول الملفات الموحّد — لا اعتماد على الرابط فقط ──────
  function _logFileRecord(entry) {
    try {
      var now = new Date().toISOString();
      var sheet = getSheet(FILES_SHEET, FILES_HEADERS);
      var row = FILES_HEADERS.map(function (h) {
        if (h === "id") return "FILE-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
        if (h === "created_at" || h === "updated_at") return now;
        if (h === "version") return entry.version !== undefined ? entry.version : 1;
        if (h === "is_archived" || h === "is_deleted") return false;
        return entry[h] !== undefined ? entry[h] : "";
      });
      _appendRowProtected(sheet, FILES_HEADERS, row);
    } catch (e) {
      // تسجيل الميتاداتا لا يجب أن يفشل عملية الرفع نفسها لو حصل خطأ هنا
      Logger.log("[DocumentEngine._logFileRecord] خطأ: " + e.message);
    }
  }

  // ── [PHASE-3] تطبيق الضغط (لو مفعّل صراحةً عبر options.compress) قبل
  // الرفع الفعلي — Opt-in بحت، مفيش أي سلوك افتراضي هنا. بترجع null لو
  // مفيش compress في الطلب أصلًا (السلوك القديم زي ما هو تمامًا)، أو نتيجة
  // CompressionEngine.compress اللي دايمًا success:true (فشل الضغط نفسه
  // مش استثناء، بيرجع للملف الأصلي). ──────────────────────────────────
  function _applyCompression(base64Data, fileName, mimeType, compressOpts) {
    if (!compressOpts) return null;
    if (typeof CompressionEngine === "undefined") return null;
    try {
      return CompressionEngine.compress(base64Data, fileName, mimeType, compressOpts);
    } catch (e) {
      var originalSize = Math.floor((String(base64Data || "").length * 3) / 4);
      return {
        success: true,
        base64Data: base64Data,
        mimeType: mimeType,
        compressed: false,
        provider: compressOpts.provider || "none",
        originalSize: originalSize,
        newSize: originalSize,
        skippedReason: "خطأ غير متوقع أثناء استدعاء محرك الضغط: " + e.message,
      };
    }
  }

  // ── [PHASE-4] Versioning + Backup ─────────────────────────────────────
  // نفس الاسم الأصلي (original_name) لنفس السجل/نوع المستند ⇒ يُعتبر نسخة
  // جديدة من نفس المستند: النسخة القديمة (ملف Drive الفعلي) تتنقل لفولدر
  // "07_Backup" تحت جذر الطرف (بدون حذفها)، وصف الـ Files القديم يتعلّم
  // is_archived=true (يفضل موجود للتاريخ لكن مش هو "الحالي" بعد كده)،
  // والنسخة الجديدة بتاخد version = آخر نسخة + 1. Opt-in ضمنيًا: بيشتغل
  // تلقائيًا فقط لمّا يكون فيه سجل سابق فعليًا بنفس original_name — رفع
  // ملف بأول مرة (مفيش نسخة قديمة) بيمشي بنفس السلوك القديم تمامًا
  // (version=1، من غير أي نقل فولدرات).
  function _findExistingFileVersions(ownerModule, recordId, docType, originalName) {
    try {
      var rows = readSheet(FILES_SHEET, FILES_HEADERS);
      return rows.filter(function (r) {
        return (
          r.owner_module === ownerModule &&
          String(r.record_id) === String(recordId) &&
          r.doc_type === (docType || "") &&
          r.original_name === originalName &&
          !r.is_deleted
        );
      });
    } catch (e) {
      Logger.log("[DocumentEngine._findExistingFileVersions] خطأ: " + e.message);
      return [];
    }
  }

  function _markFileArchived(rowNum) {
    try {
      var sheet = getSheet(FILES_SHEET, FILES_HEADERS);
      var col = FILES_HEADERS.indexOf("is_archived") + 1;
      var updCol = FILES_HEADERS.indexOf("updated_at") + 1;
      if (col) sheet.getRange(rowNum, col).setValue(true);
      if (updCol) sheet.getRange(rowNum, updCol).setValue(new Date().toISOString());
    } catch (e) {
      Logger.log("[DocumentEngine._markFileArchived] خطأ: " + e.message);
    }
  }

  // بيرجع { version, backupMoves: [previous file rows اتنقلت] } — لا يرمي
  // استثناء أبدًا؛ فشل نقل نسخة قديمة واحدة (مثلاً drive_id بقى invalid)
  // بيتسجل تحذير بس ومكملّش يوقف رفع النسخة الجديدة.
  function _applyVersioning(ownerModule, recordId, docType, originalName, backupFolder) {
    var existing = _findExistingFileVersions(ownerModule, recordId, docType, originalName);
    if (!existing.length) return { version: 1, movedCount: 0 };

    var maxVersion = existing.reduce(function (max, r) {
      var v = parseInt(r.version, 10);
      return isNaN(v) ? max : Math.max(max, v);
    }, 0);

    var movedCount = 0;
    if (backupFolder) {
      existing.forEach(function (r) {
        if (r.is_archived) return; // نُسخة قديمة اتنقلت بالفعل من رفعة سابقة
        try {
          if (r.drive_id) {
            var res = provider.moveFile(r.drive_id, backupFolder);
            if (!res.success) {
              Logger.log(
                "[DocumentEngine._applyVersioning] فشل نقل نسخة قديمة (" +
                  r.drive_id +
                  ") لفولدر Backup: " +
                  res.error,
              );
            } else {
              movedCount++;
            }
          }
          _markFileArchived(r._row);
        } catch (e) {
          Logger.log("[DocumentEngine._applyVersioning] خطأ غير متوقع: " + e.message);
        }
      });
    }

    return { version: maxVersion + 1, movedCount: movedCount };
  }

  // ── رفع ملف تابع لعميل/مورد مع توجيه تلقائي + تسجيل ميتاداتا ─────────
  // options: { partyType, partyId, code, name, docType, uploadedBy, allowedMap,
  //            compress: {enabled, provider, minSizeBytes} } — compress اختياري Opt-in
  function uploadPartyFile(base64Data, fileName, mimeType, options) {
    options = options || {};
    if (!options.partyId) {
      return { success: false, error: "معرف الطرف مطلوب لرفع المستند" };
    }
    var partyRoot = _getPartyRootFolder(options.partyType, options.code, options.name);
    var subPath = _resolveDocTypePath(options.docType);
    var targetFolder = subPath.reduce(function (parent, segment) {
      return provider.createFolder(segment, parent);
    }, partyRoot);

    var dateStr = Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd");
    var newFileName = dateStr + "_" + fileName;

    var compressionInfo = _applyCompression(base64Data, fileName, mimeType, options.compress);
    var uploadBase64 = compressionInfo && compressionInfo.compressed ? compressionInfo.base64Data : base64Data;
    var uploadMime = compressionInfo && compressionInfo.compressed ? compressionInfo.mimeType : mimeType;

    var result = provider.upload(uploadBase64, fileName, uploadMime, {
      allowedMap:
        options.allowedMap !== undefined ? options.allowedMap : FileEngine.DOCUMENT_MIME_MAP,
      newFileName: newFileName,
      targetFolder: targetFolder, // فولدر جاهز محسوب مسبقًا حسب التوجيه الذكي
    });

    if (!result.success) return result;

    // [PHASE-4] فحص نسخة سابقة بنفس الاسم الأصلي — لو موجودة، تتنقل
    // لـ 07_Backup تحت جذر الطرف والنسخة الجديدة بتاخد version تالي.
    var versionInfo = { version: 1, movedCount: 0 };
    try {
      var backupFolder = provider.createFolder("07_Backup", partyRoot);
      versionInfo = _applyVersioning(
        options.partyType || "party",
        options.partyId,
        options.docType || "document",
        fileName,
        backupFolder,
      );
    } catch (e) {
      Logger.log("[DocumentEngine.uploadPartyFile] فشل فحص/تطبيق versioning: " + e.message);
    }

    _logFileRecord({
      drive_id: result.fileId,
      folder_id: targetFolder.getId(),
      owner_module: options.partyType || "party",
      record_id: options.partyId,
      doc_type: options.docType || "document",
      file_name: result.fileName,
      original_name: fileName,
      extension: (result.fileName.match(/\.[^.]+$/) || [""])[0],
      mime_type: uploadMime || "",
      file_size: Math.floor((String(uploadBase64).length * 3) / 4),
      view_url: result.viewUrl,
      thumb_url: result.thumbUrl,
      download_url: result.downloadUrl,
      uploaded_by: options.uploadedBy || "",
      version: versionInfo.version,
      notes: "",
      tags: "",
      compression_provider: compressionInfo && compressionInfo.compressed ? compressionInfo.provider : "",
      original_size: compressionInfo ? compressionInfo.originalSize : "",
    });

    result.compression = compressionInfo;
    result.version = versionInfo.version;
    result.previousVersionsMoved = versionInfo.movedCount;
    return result;
  }

  // ── نفس فكرة _getPartyRootFolder لكن للأصناف (المخزون) — هيكل أبسط:
  // مفيش نفس تعقيد فولدرات العميل/المورد، بس فولدر لكل صنف فيه صور
  // ومستندات. Lazy: بيتعمل أول مرة يُرفع فيها ملف فعلي للصنف (مفيش hook
  // في addItem/updateItem عمدًا — الكتابة هناك بترتيب أعمدة ثابت وحساس،
  // إضافة استدعاء جديد فيها مخاطرة غير ضرورية طالما الرفع نفسه شغال
  // بدونها بنجاح). ─────────────────────────────────────────────────────
  // [PHASE-4-ITEMS] قرار التصميم المؤجّل سابقًا (راجع § 5.2 من التوثيق):
  // فولدر Backup مخصص لكل صنف (مش فولدر عام واحد تحت المخزون) — نفس منطق
  // الأطراف بالضبط، أبسط في التتبع ومفيش تعارض بين أصناف مختلفة.
  var ITEM_SUBFOLDERS = ["الصور", "المستندات", "نسخ احتياطية"];

  function _getItemRootFolder(code, name) {
    var itemFolderName =
      FileEngine.sanitizeSegment(code, "بدون-كود") +
      " - " +
      FileEngine.sanitizeSegment(name, "بدون-اسم");
    return provider.createFolderPath([ROOT_FOLDER_NAME, "المخزون", itemFolderName]);
  }

  function ensureItemFolders(code, name) {
    var root = _getItemRootFolder(code, name);
    ITEM_SUBFOLDERS.forEach(function (sub) {
      provider.createFolder(sub, root);
    });
    return { success: true, folderId: root.getId(), folderUrl: root.getUrl() };
  }

  // ── رفع ملف تابع لصنف (صورة رئيسية/صورة معرض/مستند) ──────────────────
  // options: { itemId, code, name, docType: "image"|"document", uploadedBy,
  //            compress: {enabled, provider, minSizeBytes} } — compress اختياري Opt-in،
  //            بيتجاهل تلقائيًا لو docType === "document" (TinyPNG صور بس)
  function uploadItemFile(base64Data, fileName, mimeType, options) {
    options = options || {};
    if (!options.itemId) {
      return { success: false, error: "معرف الصنف مطلوب لرفع الملف" };
    }
    var itemRoot = _getItemRootFolder(options.code, options.name);
    var subName = options.docType === "document" ? "المستندات" : "الصور";
    var targetFolder = provider.createFolder(subName, itemRoot);

    var dateStr = Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd");
    var newFileName = dateStr + "_" + fileName;

    var compressionInfo =
      options.docType === "document"
        ? null
        : _applyCompression(base64Data, fileName, mimeType, options.compress);
    var uploadBase64 = compressionInfo && compressionInfo.compressed ? compressionInfo.base64Data : base64Data;
    var uploadMime = compressionInfo && compressionInfo.compressed ? compressionInfo.mimeType : mimeType;

    var result = provider.upload(uploadBase64, fileName, uploadMime, {
      allowedMap:
        options.docType === "document" ? FileEngine.DOCUMENT_MIME_MAP : FileEngine.IMAGE_MIME_MAP,
      newFileName: newFileName,
      targetFolder: targetFolder,
    });
    if (!result.success) return result;

    // [PHASE-4-ITEMS] نفس منطق versioning الأطراف بالظبط — نفس original_name
    // لنفس itemId/docType ⇒ نسخة جديدة، القديمة تتنقل لفولدر "نسخ احتياطية"
    // تحت جذر الصنف. أول رفعة (مفيش نسخة قديمة) بتمشي زي الأول تمامًا.
    var versionInfo = { version: 1, movedCount: 0 };
    try {
      var itemBackupFolder = provider.createFolder("نسخ احتياطية", itemRoot);
      versionInfo = _applyVersioning(
        "item",
        options.itemId,
        options.docType || "image",
        fileName,
        itemBackupFolder,
      );
    } catch (e) {
      Logger.log("[DocumentEngine.uploadItemFile] فشل فحص/تطبيق versioning: " + e.message);
    }

    _logFileRecord({
      drive_id: result.fileId,
      folder_id: targetFolder.getId(),
      owner_module: "item",
      record_id: options.itemId,
      doc_type: options.docType || "image",
      file_name: result.fileName,
      original_name: fileName,
      extension: (result.fileName.match(/\.[^.]+$/) || [""])[0],
      mime_type: uploadMime || "",
      file_size: Math.floor((String(uploadBase64).length * 3) / 4),
      view_url: result.viewUrl,
      thumb_url: result.thumbUrl,
      download_url: result.downloadUrl,
      uploaded_by: options.uploadedBy || "",
      version: versionInfo.version,
      notes: "",
      tags: "",
      compression_provider: compressionInfo && compressionInfo.compressed ? compressionInfo.provider : "",
      original_size: compressionInfo ? compressionInfo.originalSize : "",
    });

    result.compression = compressionInfo;
    result.version = versionInfo.version;
    result.previousVersionsMoved = versionInfo.movedCount;
    return result;
  }

  // ── رفع صور عمليات الإنتاج (صرف للمصنع/مرتجع من المصنع/استلام إنتاج
  // تام) — كانت بترفع بفولدر مسطّح "صور الإنتاج/{context}" عبر FileEngine
  // مباشرة بدون تسجيل ميتاداتا. هنا بقت بتاخد هيكل ثابت تحت جذر النظام
  // + تتسجل في جدول Files زي باقي الملفات. ────────────────────────────
  var PRODUCTION_CONTEXT_LABELS = {
    dispatch: "صرف للمصنع",
    factory_return: "مرتجع من المصنع",
    fg_receive: "استلام إنتاج تام",
  };

  function _getProductionFolder(context) {
    var label = PRODUCTION_CONTEXT_LABELS[context] ||
      FileEngine.sanitizeSegment(context, "عام");
    return provider.createFolderPath([ROOT_FOLDER_NAME, "الإنتاج", label]);
  }

  // [PHASE-4-PRODUCTION] قرار تصميم صريح: مفيش versioning هنا (بعكس
  // الأطراف/الأصناف) — السبب: uploadImageToDrive (Code_17_Manufacturing)
  // بينادي هنا من غير recordId حقيقي أبدًا (راجع الاستدعاء الوحيد الموجود)،
  // فـ record_id بيبقى فاضي وبيقع على options.context (صرف/مرتجع/استلام)
  // اللي هو نفسه لعشرات عمليات الإنتاج المختلفة. لو فعّلنا versioning هنا
  // هيبقى معناه إن صورتين اتلقطوا من موبايلين مختلفين بنفس الاسم الافتراضي
  // من الكاميرا (زي IMG_0001.jpg) لعمليتين إنتاج مختلفتين تمامًا هيتعاملوا
  // كـ"نسخة جديدة من نفس المستند" وتتنقل واحدة للـ Backup غلط. لازم أول
  // ربط recordId حقيقي (رقم عملية الإنتاج) من الواجهة قبل تفعيل الميزة دي.
  // options: { context, recordId, uploadedBy, compress: {enabled, provider, minSizeBytes} }
  // compress اختياري Opt-in — مفيش أي تغيير في السلوك الافتراضي لو ملم يتمرر
  function uploadProductionFile(base64Data, fileName, mimeType, options) {
    options = options || {};
    var targetFolder = _getProductionFolder(options.context);

    var dateStr = Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd_HH-mm-ss");
    var newFileName = dateStr + "_" + fileName;

    var compressionInfo = _applyCompression(base64Data, fileName, mimeType, options.compress);
    var uploadBase64 = compressionInfo && compressionInfo.compressed ? compressionInfo.base64Data : base64Data;
    var uploadMime = compressionInfo && compressionInfo.compressed ? compressionInfo.mimeType : mimeType;

    var result = provider.upload(uploadBase64, fileName, uploadMime, {
      allowedMap: FileEngine.IMAGE_MIME_MAP,
      newFileName: newFileName,
      targetFolder: targetFolder,
    });
    if (!result.success) return result;

    _logFileRecord({
      drive_id: result.fileId,
      folder_id: targetFolder.getId(),
      owner_module: "production",
      record_id: options.recordId || options.context || "",
      doc_type: options.context || "production",
      file_name: result.fileName,
      original_name: fileName,
      extension: (result.fileName.match(/\.[^.]+$/) || [""])[0],
      mime_type: uploadMime || "",
      file_size: Math.floor((String(uploadBase64).length * 3) / 4),
      view_url: result.viewUrl,
      thumb_url: result.thumbUrl,
      download_url: result.downloadUrl,
      uploaded_by: options.uploadedBy || "",
      notes: "",
      tags: "",
      compression_provider: compressionInfo && compressionInfo.compressed ? compressionInfo.provider : "",
      original_size: compressionInfo ? compressionInfo.originalSize : "",
    });

    result.compression = compressionInfo;
    return result;
  }

  // ── رفع صورة انطلاقًا من رابط خارجي (مش من جهاز المستخدم) — مخصص
  // لاستيراد Excel بالجملة (عمود "رابط الصورة") لمّا يكون "رفع فعلي على
  // Drive" مفعّل صراحةً من المستخدم (خيار Opt-in، مش سلوك افتراضي).
  // بتحمّل الرابط عبر UrlFetchApp وترفع الـ bytes زي أي ملف عادي عبر
  // uploadItemFile. بترجع دايمًا { success, ... } وميرميش استثناء — عشان
  // فشل رابط واحد (مكسور/بطيء/مش صورة) ميوقفش باقي دفعة الاستيراد. ─────
  function _extFromMime(mimeType) {
    var map = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
    };
    return map[mimeType] || ".jpg";
  }

  function _isSafeExternalFetchUrl(url) {
    try {
      var u = new URL(String(url || "").trim());
      if (u.protocol !== "https:") return false;
      var host = String(u.hostname || "").toLowerCase();
      if (!host || host === "localhost" || host.endsWith(".local")) return false;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        var parts = host.split(".").map(function (x) { return Number(x); });
        if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return false;
        if (parts[0] === 169 && parts[1] === 254) return false;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
        if (parts[0] === 192 && parts[1] === 168) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  function uploadFromExternalUrl(url, fileNameHint, options) {
    try {
      // [ENGINE-AUDIT / Validation Engine] كان فيه regex محلي مطابق لنفس
      // فحص "هل ده رابط صالح؟" الموجود في ValidationEngine.isValidUrl —
      // اتوحّد بدل نسخة منفصلة (Code_36 بيتحمّل قبل هذا الملف أبجديًا).
      if (!ValidationEngine.isValidUrl(String(url || "").trim())) {
        return { success: false, error: "رابط غير صالح" };
      }
      if (!_isSafeExternalFetchUrl(url)) {
        return { success: false, error: "لا يُسمح إلا بروابط HTTPS عامة وآمنة" };
      }
      var resp = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        validateHttpsCertificates: true,
      });
      if (resp.getResponseCode() !== 200) {
        return {
          success: false,
          error: "فشل تحميل الرابط (HTTP " + resp.getResponseCode() + ")",
        };
      }
      var blob = resp.getBlob();
      var mimeType = blob.getContentType() || "";
      if (mimeType.indexOf("image/") !== 0) {
        return { success: false, error: "الرابط لا يشير لصورة فعلية" };
      }
      var bytes = blob.getBytes();
      if (bytes.length > 10 * 1024 * 1024) {
        return { success: false, error: "حجم الصورة يتجاوز 10MB" };
      }
      var base64 = Utilities.base64Encode(bytes);
      var fileName = fileNameHint || "imported_" + Date.now() + _extFromMime(mimeType);
      return uploadItemFile(base64, fileName, mimeType, options);
    } catch (e) {
      return { success: false, error: "تعذّر تحميل الصورة من الرابط: " + e.message };
    }
  }

  // ── [PHASE-5] أرشفة فولدر الطرف بالكامل عند الحذف ────────────────────
  // بتنقل فولدر الطرف الجذري (بكل محتوياته) من تحت "العملاء"/"الموردون"
  // إلى ROOT_FOLDER_NAME/"Archive"/{typeFolderName}/ — بدون حذف أي حاجة،
  // فقط نقل مكاني. Idempotent: لو الفولدر كان اتنقل بالفعل (مثلاً حذف
  // اتكرر لأي سبب)، createFolderPath/moveFolder هيلاقوا نفس الفولدر تاني
  // مكانه الجديد ومش هيعملوا نسخة تانية. لا يرمي استثناء أبدًا — فشل هنا
  // ميوقفش حذف السجل نفسه (راجع الاستدعاء في _deleteParty بـ Code_20).
  function archivePartyFolder(partyType, code, name) {
    try {
      var typeFolderName = partyType === "supplier" ? "الموردون" : "العملاء";
      var partyFolderName =
        FileEngine.sanitizeSegment(code, "بدون-كود") +
        " - " +
        FileEngine.sanitizeSegment(name, "بدون-اسم");

      var partyRoot = provider.createFolderPath([ROOT_FOLDER_NAME, typeFolderName, partyFolderName]);
      var archiveParent = provider.createFolderPath([ROOT_FOLDER_NAME, "Archive", typeFolderName]);

      var moveRes = provider.moveFolder(partyRoot, archiveParent);
      if (!moveRes.success) {
        Logger.log("[DocumentEngine.archivePartyFolder] فشل النقل: " + moveRes.error);
        return { success: false, error: moveRes.error };
      }
      return { success: true, folderId: partyRoot.getId(), folderUrl: partyRoot.getUrl() };
    } catch (e) {
      Logger.log("[DocumentEngine.archivePartyFolder] خطأ غير متوقع: " + e.message);
      return { success: false, error: e.message };
    }
  }

  // ── [PHASE-5-ITEMS] أرشفة فولدر الصنف بالكامل عند الحذف النهائي ──────
  // نفس فلسفة archivePartyFolder بالضبط لكن لهيكل فولدر الصنف (تحت
  // ROOT_FOLDER_NAME/"المخزون"/{code} - {name}) — بتنقله لـ
  // ROOT_FOLDER_NAME/"Archive"/"المخزون"/. مستخدمة فقط عند الحذف النهائي
  // (Hard Delete) للصنف — Soft Delete (الحالة الافتراضية) بيسيب الفولدر
  // مكانه لأن السجل نفسه قابل للاسترجاع. فشل صامت بالكامل — لا يرمي
  // استثناء، والحذف نفسه ميتأثرش.
  function archiveItemFolder(code, name) {
    try {
      var itemRoot = _getItemRootFolder(code, name);
      var archiveParent = provider.createFolderPath([ROOT_FOLDER_NAME, "Archive", "المخزون"]);
      var moveRes = provider.moveFolder(itemRoot, archiveParent);
      if (!moveRes.success) {
        Logger.log("[DocumentEngine.archiveItemFolder] فشل النقل: " + moveRes.error);
        return { success: false, error: moveRes.error };
      }
      return { success: true, folderId: itemRoot.getId(), folderUrl: itemRoot.getUrl() };
    } catch (e) {
      Logger.log("[DocumentEngine.archiveItemFolder] خطأ غير متوقع: " + e.message);
      return { success: false, error: e.message };
    }
  }

  // ── [PHASE-5] إحصائيات مساحة — قراءة من شيت Files الموحّد مباشرة، مفيش
  // استدعاء لـ Drive API (بطيء لو عدد الملفات كبير) — file_size المسجّل
  // وقت الرفع هو مصدر الحقيقة الوحيد هنا. بترجع تجميع عام + تفصيل حسب
  // owner_module و doc_type، بالإضافة لعدد الملفات اللي اتضغطت فعليًا. ──
  function getStorageStats() {
    var rows;
    try {
      rows = readSheet(FILES_SHEET, FILES_HEADERS);
    } catch (e) {
      return { success: false, error: e.message };
    }

    var active = rows.filter(function (r) { return !r.is_deleted; });

    var totalBytes = 0;
    var totalFiles = active.length;
    var archivedFiles = 0;
    var compressedFiles = 0;
    var byModule = {};
    var byDocType = {};

    active.forEach(function (r) {
      var size = parseInt(r.file_size, 10);
      if (isNaN(size)) size = 0;
      totalBytes += size;
      if (r.is_archived) archivedFiles++;
      if (r.compression_provider) compressedFiles++;

      var mod = r.owner_module || "غير محدد";
      byModule[mod] = byModule[mod] || { count: 0, bytes: 0 };
      byModule[mod].count++;
      byModule[mod].bytes += size;

      var dt = r.doc_type || "غير محدد";
      byDocType[dt] = byDocType[dt] || { count: 0, bytes: 0 };
      byDocType[dt].count++;
      byDocType[dt].bytes += size;
    });

    return {
      success: true,
      totalFiles: totalFiles,
      totalBytes: totalBytes,
      totalMB: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
      archivedFiles: archivedFiles,
      compressedFiles: compressedFiles,
      byModule: byModule,
      byDocType: byDocType,
    };
  }

  return {
    provider: provider,
    ROOT_FOLDER_NAME: ROOT_FOLDER_NAME,
    DOC_TYPE_ROUTING: DOC_TYPE_ROUTING,
    ensurePartyFolders: ensurePartyFolders,
    uploadPartyFile: uploadPartyFile,
    ensureItemFolders: ensureItemFolders,
    uploadItemFile: uploadItemFile,
    uploadProductionFile: uploadProductionFile,
    uploadFromExternalUrl: uploadFromExternalUrl,
    archivePartyFolder: archivePartyFolder,
    archiveItemFolder: archiveItemFolder,
    getStorageStats: getStorageStats,
  };
})();

// ── [PHASE-5] نقطة استدعاء عامة (google.script.run) من أي شاشة إعدادات
// تحتاج تعرض إحصائيات مساحة التخزين — مجرد wrapper رفيع فوق
// DocumentEngine.getStorageStats عشان تبقى قابلة للاستدعاء مباشرة من
// الواجهة بدون كشف DocumentEngine نفسه للـ client. صلاحيات: نفس صلاحية
// عرض الإعدادات العامة (مفيش بيانات حساسة هنا، مجرد أعداد/أحجام).
function getDocumentEngineStorageStats() {
  try {
    return DocumentEngine.getStorageStats();
  } catch (e) {
    return { success: false, error: e.message };
  }
}
