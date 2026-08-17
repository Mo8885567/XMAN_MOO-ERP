// ════════════════════════════════════════════════════════════════
// Code_46_AutoNumberService.js — [AUTO-NUMBER-CENTRAL] خدمة الترقيم
// التلقائي المركزية لكل حقول "الكود" في المشروع.
//
// المشكلة اللي كانت موجودة قبل الملف ده:
//   كل موديول (عملاء/موردين، خزائن، مراكز تكلفة، أقسام HR، موظفين،
//   شركات شحن...) كان عنده نسخته الخاصة من نفس الفكرة بالظبط
//   (_getNextPartyCode في Code_20_Sales.js، _getNextSequentialCode في
//   Code_12_Core.js) — منطق متكرر، وكان بيعتمد على عداد مخزّن في
//   PropertiesService بيتزاد بس (+1) من غير ما يرجع يتأكد من الشيت
//   الفعلي، فلو اتحذف آخر سجل أو اتعدّل كوده يدويًا كان العداد المحفوظ
//   بيفضل يكمل من رقم أعلى من الموجود فعليًا (فجوة دايمة بدل إعادة
//   استخدام الرقم اللي اتفضّى).
//
// الحل هنا:
//   1) مصدر واحد للحقيقة: AutoNumberService.preview() بيحسب الرقم
//      التالي دايمًا من أعلى كود *موجود فعليًا* في الشيت وقت النداء —
//      مفيش عداد منفصل يتخزن ويتنسى يتزامن.
//   2) دعم Prefix + Padding (مثال: CUS-0099 → CUS-0100) بشكل موحّد.
//   3) AutoNumberService.isTaken() — فحص تكرار مباشر يُستخدم وقت
//      الحفظ الفعلي (بعد ما القيمة المقترحة ممكن تتغيّر يدويًا من
//      المستخدم، أو يتصادم مع مستخدم تاني ضاف في نفس اللحظة).
//
// ملحوظة عن التزامن (مستخدمان في نفس اللحظة):
//   الفحص الحاسم الوحيد اللي يُعتمد عليه فعليًا هو اللي بيحصل *وقت
//   الحفظ* داخل كل addXxx handler (بعد قراءة الشيت من جديد تحت
//   LockService) — مش الرقم المقترح وقت فتح المودال. المعاينة
//   (preview) هدفها UX بس: تدّي المستخدم رقم افتراضي معقول يقدر
//   يعدّله، وليست حجزًا ملزمًا للرقم.
// ════════════════════════════════════════════════════════════════

var AutoNumberService = (function () {
  /**
   * يفصل الكود لجزء بادئة (prefix) وجزء رقمي، لو فيه نمط "PREFIX-000123".
   * لو الكود رقم صافي (زي "34")، الـ prefix بيرجع "" والرقم زي ما هو.
   * @private
   */
  function _splitCode(raw) {
    var s = String(raw == null ? "" : raw).trim();
    // نمط: أي بادئة نصية (حروف/رموز) يتبعها فاصل اختياري وبعده أرقام فقط
    // في نهاية النص — عشان "CUS-0099" أو "ITM0099" أو حتى "34" العادي.
    var m = s.match(/^(.*?)(\d+)$/);
    if (!m) return { prefix: s, number: null, padding: 0 };
    return {
      prefix: m[1],
      number: parseInt(m[2], 10),
      padding: m[2].length, // عدد الأرقام الأصلي (للحفاظ على الـ Padding)
    };
  }

  /**
   * يبني الكود النهائي من prefix + رقم + padding مطلوب.
   * @private
   */
  function _formatCode(prefix, number, padding) {
    var numStr = String(number);
    if (padding && numStr.length < padding) {
      numStr = new Array(padding - numStr.length + 1).join("0") + numStr;
    }
    return (prefix || "") + numStr;
  }

  /**
   * AutoNumberService.preview — يحسب الرقم التالي المقترح لكيان معيّن.
   *
   * @param {Function} existingCodesFn - دالة ترجع مصفوفة الأكواد الخام
   *   الموجودة فعليًا في الشيت الآن (بتتنادى في كل مرة — مفيش كاش هنا
   *   عمدًا، عشان الرقم يفضل متزامن مع الحالة الحقيقية للبيانات).
   * @param {Object} [opts]
   * @param {String} [opts.prefix] - بادئة ثابتة (مثال: "CUS-"). لو
   *   اتحددت، بيتجاهل أي بادئة موجودة فعليًا في البيانات ويستخدمها هي.
   * @param {Number} [opts.padding] - أقل عدد أرقام (مثال: 4 → "0100").
   *   لو مش محدد، بيستخدم نفس عدد أرقام أكبر كود موجود.
   * @returns {String} الكود التالي المقترح (نص).
   */
  function preview(existingCodesFn, opts) {
    opts = opts || {};
    var maxNumber = 0;
    var maxPadding = 0;
    var detectedPrefix = opts.prefix || "";
    try {
      (existingCodesFn ? existingCodesFn() : []).forEach(function (raw) {
        var parsed = _splitCode(raw);
        if (parsed.number === null) return; // كود بدون جزء رقمي — يُتجاهل من الحساب
        // لو فيه prefix محدد صراحة، اهتم بس بالأكواد اللي بتبدأ بنفس الـ prefix
        if (opts.prefix && parsed.prefix !== opts.prefix) return;
        if (parsed.number > maxNumber) {
          maxNumber = parsed.number;
          maxPadding = parsed.padding;
          if (!opts.prefix) detectedPrefix = parsed.prefix;
        }
      });
    } catch (e) {
      // تجاهل — نبدأ من 1 لو فشلت القراءة لأي سبب
    }
    var nextNumber = maxNumber + 1;
    var padding = opts.padding || maxPadding || 0;
    return _formatCode(detectedPrefix, nextNumber, padding);
  }

  /**
   * AutoNumberService.isTaken — فحص تكرار مباشر (case-insensitive) —
   * يُستخدم وقت الحفظ الفعلي لمنع أي تصادم (خصوصًا لو فتح أكتر من
   * مستخدم شاشة الإضافة في نفس اللحظة).
   *
   * @param {Function} existingCodesFn - دالة ترجع مصفوفة الأكواد الخام
   *   الحالية (تُقرأ Fresh من الشيت هنا، مش من أي كاش).
   * @param {String} code - الكود المطلوب التأكد إنه غير مُستخدم.
   * @param {String} [excludeCode] - كود استثناء (مفيد وقت التعديل —
   *   عشان السجل الحالي نفسه ما يتحسبش تكرار مع نفسه).
   * @returns {Boolean}
   */
  function isTaken(existingCodesFn, code, excludeCode) {
    var target = String(code == null ? "" : code)
      .trim()
      .toLowerCase();
    if (!target) return false; // كود فاضي مش مسؤولية الفحص ده
    var excl =
      excludeCode == null ? null : String(excludeCode).trim().toLowerCase();
    var list = [];
    try {
      list = existingCodesFn ? existingCodesFn() : [];
    } catch (e) {
      return false; // فشل القراءة — لا نمنع الحفظ بسبب خطأ فني هنا
    }
    return list.some(function (raw) {
      var s = String(raw == null ? "" : raw)
        .trim()
        .toLowerCase();
      if (!s) return false;
      if (excl !== null && s === excl) return false;
      return s === target;
    });
  }

  /**
   * AutoNumberService.previewFromLast — نسخة سريعة من preview() لترقيم
   * تسلسلي بسيط (1، 2، 3...). بدل ما تقرأ *كل* الأكواد الموجودة وتدور على
   * الأكبر (O(n) قراءة + مسح)، بتاخد كود آخر صف موجود بس (اللي المفروض
   * يبقى هو الأكبر أصلاً طالما الترقيم بيتم تسلسليًا من غير تعديل يدوي
   * يكسر الترتيب) وتزوّد عليه واحد. الهدف: سرعة مع شيتات فيها آلاف الصفوف
   * (مثال: شاشة الأصناف) — القراءة نفسها المفروض تبقى getRange لصف واحد
   * بس من عند الـ caller، مش قراءة الشيت كله.
   *
   * ملحوظة: زي preview بالظبط، ده رقم *مقترح* لغرض الـ UX/الحفظ الأولي —
   * الفحص الحاسم ضد التكرار الفعلي (isTaken/BusinessRulesEngine) لازم
   * يفضل شغّال وقت الحفظ الحقيقي، لأنه لو حد عدّل كود آخر صف يدويًا لرقم
   * أصغر، آخر صف مش هيبقى هو الأكبر فعليًا.
   *
   * @param {String|Number|null} lastCode - الكود الخام لآخر صف موجود حاليًا
   *   في العمود (أو null/"" لو الشيت لسه فاضي — هيبدأ من 1).
   * @param {Object} [opts] - نفس opts بتاعة preview (prefix/padding).
   * @returns {String} الكود التالي المقترح.
   */
  function previewFromLast(lastCode, opts) {
    opts = opts || {};
    var parsed = _splitCode(lastCode);
    var lastNumber = parsed.number === null ? 0 : parsed.number;
    var padding = opts.padding || parsed.padding || 0;
    var prefix = opts.prefix != null ? opts.prefix : parsed.prefix || "";
    return _formatCode(prefix, lastNumber + 1, padding);
  }

  return {
    preview: preview,
    previewFromLast: previewFromLast,
    isTaken: isTaken,
  };
})();
