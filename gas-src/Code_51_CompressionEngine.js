// ══════════════════════════════════════════════════════════════════════════
// Code_51_CompressionEngine.gs — محرك الضغط (Phase 3 من DocumentEngine)
// ──────────────────────────────────────────────────────────────────────────
// [COMPRESSION-DESIGN]
//  - GAS مالوش مكتبة ضغط صور native، فمفيش "ضغط حقيقي" من غير API خارجي.
//    بالتالي المحرك ده بيدعم مزوّدين، الاتنين Opt-in بالكامل (مطفيين
//    افتراضيًا) وبيتفعّلوا بس عبر options.compress اللي بيتمرر صراحةً من
//    نقطة الاستدعاء (استيراد Excel حاليًا، وأي رفع تاني مستقبلًا):
//
//    1) provider: "tinypng"        → ضغط حقيقي فعلي عبر TinyPNG API
//       (https://tinify.com). يحتاج مفتاح API مخزّن في Script Properties
//       تحت اسم "TINYPNG_API_KEY" (Project Settings → Script Properties).
//       بدون المفتاح: بيرجع compressed:false + سبب واضح، وميرميش استثناء.
//
//    2) provider: "thumbnail_only" (أو مفيش provider أصلًا) → مفيش ضغط
//       حقيقي، اعتمادًا على thumbUrl التلقائي اللي Drive بيوفّره أصلًا
//       (FileEngine.upload بيرجعه دايمًا زي ما هو من غير أي تعديل هنا) —
//       ده "البديل المجاني" المذكور في التوثيق، بيغطي احتياج المعاينة
//       السريعة بس مش تقليل حجم الملف الأصلي المخزّن فعليًا.
//
//  - compress() بترجع دايمًا { success:true, ... } — فشل الضغط (مفتاح
//    ناقص، نوع ملف غير مدعوم، خطأ شبكة، حصة API خلصت...) مش استثناء ولا
//    سبب لرفض الرفع نفسه؛ الاستدعاء بيرجع للملف الأصلي زي ما هو مع
//    compressed:false + skippedReason واضح يتسجّل كتحذير للمستخدم.
//  - لا حد أقصى منفصل لعدد الصور اللي بتتضغط في الدفعة الواحدة (نفس
//    ملاحظة rehostImages في التوثيق) — لو حصل Timeout فعليًا في
//    الاستخدام الحقيقي مع دفعات كبيرة، الخطوة التالية المنطقية حد أصغر
//    (زي 30-50 صف) لما الضغط يكون مفعّل تحديدًا.
// ══════════════════════════════════════════════════════════════════════════

var CompressionEngine = (function () {
  "use strict";

  // تحت الحجم ده الفايدة من استهلاك حصة API ضئيلة جدًا، فبنتخطى الضغط
  var DEFAULT_MIN_SIZE_BYTES = 20 * 1024;

  var TINYPNG_SUPPORTED_MIME = {
    "image/jpeg": true,
    "image/png": true,
    "image/webp": true,
  };

  function _tinypngKey() {
    try {
      return PropertiesService.getScriptProperties().getProperty("TINYPNG_API_KEY") || "";
    } catch (e) {
      return "";
    }
  }

  function _compressViaTinyPng(bytes, mimeType) {
    var apiKey = _tinypngKey();
    if (!apiKey) {
      return {
        success: false,
        skippedReason: "لا يوجد مفتاح TINYPNG_API_KEY في Script Properties",
      };
    }

    var authHeader = "Basic " + Utilities.base64Encode("api:" + apiKey);

    var shrinkResp = UrlFetchApp.fetch("https://api.tinify.com/shrink", {
      method: "post",
      contentType: mimeType,
      payload: bytes,
      headers: { Authorization: authHeader },
      muteHttpExceptions: true,
    });

    var code = shrinkResp.getResponseCode();
    if (code !== 201) {
      var errMsg = "";
      try {
        errMsg = JSON.parse(shrinkResp.getContentText()).message || "";
      } catch (e2) {
        errMsg = shrinkResp.getContentText();
      }
      return { success: false, skippedReason: "فشل TinyPNG (HTTP " + code + ") " + errMsg };
    }

    var outputUrl;
    try {
      outputUrl = JSON.parse(shrinkResp.getContentText()).output.url;
    } catch (e3) {
      return { success: false, skippedReason: "استجابة TinyPNG غير متوقعة" };
    }

    var dlResp = UrlFetchApp.fetch(outputUrl, {
      headers: { Authorization: authHeader },
      muteHttpExceptions: true,
    });
    if (dlResp.getResponseCode() !== 200) {
      return { success: false, skippedReason: "فشل تحميل الصورة المضغوطة من TinyPNG" };
    }

    return { success: true, bytes: dlResp.getBlob().getBytes() };
  }

  // options: { enabled, provider: "tinypng" | "thumbnail_only", minSizeBytes }
  function compress(base64Data, fileName, mimeType, options) {
    options = options || {};
    var originalSize = Math.floor((String(base64Data || "").length * 3) / 4);

    var result = {
      success: true,
      base64Data: base64Data,
      mimeType: mimeType,
      compressed: false,
      provider: options.provider || "none",
      originalSize: originalSize,
      newSize: originalSize,
      skippedReason: "",
    };

    if (!options.enabled) {
      result.skippedReason = "الضغط غير مفعّل (Opt-in)";
      return result;
    }

    if (!options.provider || options.provider === "thumbnail_only") {
      result.provider = "thumbnail_only";
      result.skippedReason =
        "مفيش ضغط حقيقي مفعّل — الاعتماد على thumbnail التلقائي من Drive للمعاينة فقط";
      return result;
    }

    if (options.provider === "tinypng") {
      var cleanMime = String(mimeType || "").toLowerCase();
      if (!TINYPNG_SUPPORTED_MIME[cleanMime]) {
        result.skippedReason = "نوع الملف غير مدعوم من TinyPNG: " + mimeType;
        return result;
      }

      var minSize = options.minSizeBytes || DEFAULT_MIN_SIZE_BYTES;
      if (originalSize < minSize) {
        result.skippedReason =
          "الحجم أصلًا أقل من الحد الأدنى للضغط (" + minSize + " بايت)";
        return result;
      }

      try {
        var bytes = Utilities.base64Decode(base64Data);
        var tinyRes = _compressViaTinyPng(bytes, mimeType);
        if (!tinyRes.success) {
          result.skippedReason = tinyRes.skippedReason;
          return result;
        }
        result.base64Data = Utilities.base64Encode(tinyRes.bytes);
        result.compressed = true;
        result.newSize = tinyRes.bytes.length;
        return result;
      } catch (e) {
        result.skippedReason = "خطأ غير متوقع أثناء الضغط: " + e.message;
        return result;
      }
    }

    result.skippedReason = "مزوّد ضغط غير معروف: " + options.provider;
    return result;
  }

  return {
    compress: compress,
    DEFAULT_MIN_SIZE_BYTES: DEFAULT_MIN_SIZE_BYTES,
  };
})();
