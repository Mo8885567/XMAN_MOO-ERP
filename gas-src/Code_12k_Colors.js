/**
 * ============================================================
 * Module: Code_12k_Colors.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * ✅ توحيد اسم اللون (عربي/إنجليزي): يشيل الهمزات والتشكيل ويعمل lowercase
 * نفس منطق _normalizeColor في الفرونت (03_JS_Dashboard_Items.html) —
 * لازم يفضل متطابق مع النسخة دي لو اتعدلت.
 */
function _normalizeColorKeyServer(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[\u0623\u0625\u0622]/g, "\u0627") // أ إ آ → ا
    .replace(/\u0629/g, "\u0647") // ة → ه
    .replace(/\u0649/g, "\u064A") // ى → ي
    .replace(/[\u064B-\u065F]/g, ""); // حذف التشكيل
}

/** توليد كود مختصر (3 أحرف) لاسم لون مش موجود في COLOR_CODE_MAP_MASTER */
function _generateColorCodeServer(name) {
  var clean = String(name || "").trim();
  if (!clean) return "COL";
  // إنجليزي: أول 3 أحرف
  // [ENGINE-AUDIT / Validation Engine] كان فيه نسخة محلية مطابقة حرفيًا
  // لـ ValidationEngine.isLettersOnly (نفس الـ regex بالظبط) — اتوحّدت.
  if (ValidationEngine.isLettersOnly(clean)) {
    var letters = clean.replace(/\s+/g, "");
    return letters.substring(0, 3).toUpperCase() || "COL";
  }
  // عربي بدون قاموس: كود مشتق من hash الاسم (ثابت لنفس الاسم دايمًا)
  var h = 0;
  for (var i = 0; i < clean.length; i++) {
    h = (h << 5) - h + clean.charCodeAt(i);
    h |= 0;
  }
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  h = Math.abs(h);
  return "C" + alphabet[h % 26] + alphabet[Math.floor(h / 26) % 26];
}

/**
 * 🤖 resolveColorsBatch — الدالة اللي بيناديها الفرونت (google.script.run)
 * علشان يملأ HEX + الكود تلقائيًا وهو بيكتب اسم اللون، سواء في:
 *   - نموذج "إضافة لون جديد" (07_JS_Shipping_Colors_Excel.html → openColorDefModal)
 *   - نظام تحليل الألوان الذكي في شاشة الأصناف (03_JS_Dashboard_Items.html)
 *
 * الاستراتيجية:
 * 1. مطابقة تامة (بعد التطبيع) مع CSS_COLOR_MAP_MASTER → hex معروف ودقيق.
 * 2. لو الاسم مركّب (مثال: "أحمر غامق") → دوّر على أطول كلمة لون معروفة
 *    جوه النص وطابقها.
 * 3. لو مفيش تطابق خالص → من غير hex (يسيب المستخدم يختاره يدوي من الـ picker).
 * 4. الكود: من COLOR_CODE_MAP_MASTER، وإلا يتولّد تلقائيًا.
 *
 * @param {string[]} names - أسماء الألوان المطلوب حلها (batch واحد للسرعة)
 * @returns {Object} { "اسم اللون": { hex, code, source } }
 */
function resolveColorsBatch(names) {
  var result = {};
  try {
    if (!names || !names.length) return result;

    // كاش أطوال المفاتيح المطبّعة من CSS_COLOR_MAP_MASTER (لمطابقة جزئية)
    var normalizedKeys = Object.keys(CSS_COLOR_MAP_MASTER)
      .map(function (k) {
        return { raw: k, norm: _normalizeColorKeyServer(k) };
      })
      .sort(function (a, b) {
        return b.norm.length - a.norm.length; // الأطول أولًا (أدق تطابق)
      });

    names.forEach(function (rawName) {
      var name = String(rawName || "").trim();
      if (!name) return;
      var lower = name.toLowerCase();
      var key = _normalizeColorKeyServer(name);

      var hex =
        CSS_COLOR_MAP_MASTER[name] ||
        CSS_COLOR_MAP_MASTER[lower] ||
        CSS_COLOR_MAP_MASTER[key];
      var source = hex ? "exact" : null;

      // مطابقة جزئية للأسماء المركبة ("أحمر غامق"، "أزرق فاتح"...)
      if (!hex) {
        for (var i = 0; i < normalizedKeys.length; i++) {
          if (key.indexOf(normalizedKeys[i].norm) !== -1) {
            hex = CSS_COLOR_MAP_MASTER[normalizedKeys[i].raw];
            source = "partial";
            break;
          }
        }
      }

      var code =
        COLOR_CODE_MAP_MASTER[name] ||
        COLOR_CODE_MAP_MASTER[lower] ||
        COLOR_CODE_MAP_MASTER[key];
      if (!code) code = _generateColorCodeServer(name);

      result[name] = {
        hex: hex || null,
        code: code || null,
        source: source || "generated",
      };
    });
  } catch (e) {
    // ما نكسرش الفرونت — رجّع أي نتايج اتحسبت قبل الخطأ
  }
  return result;
}

