/**
 * ============================================================
 *  Code_52_SmartDefaultEngine.js — [SMART-DEFAULTS-2026-07-28]
 * ============================================================
 * محرك مركزي واحد لكل القيم الافتراضية في MOO.ERP.
 *
 * ملحوظة مهمة (اتأكدنا منها بالمراجعة الكاملة للكود قبل الكتابة):
 * النظام حاليًا شركة واحدة وبدون كيان "فروع" منفصل (مفيش Sheet
 * اسمه Branches ولا أي منطق multi-branch) — كل إعدادات الشركة
 * مخزّنة صف واحد لكل مفتاح في شيت "Settings" (اتقرأ عن طريق
 * _getCompanySettingsRaw() الموجودة أصلاً في Code_08_AIAssistant.js،
 * وبتتحفظ عن طريق saveCompanySettings() لنفس الشيت). فالمحرك ده
 * بيستخدم نفس الشيت والمفاتيح الموجودة فعلاً (default_warehouse,
 * currency, ...) بدل ما ينشئ تخزين جديد — تنفيذًا لتعليمة "لا تغيّر
 * قاعدة البيانات إلا للضرورة".
 *
 * أي شاشة/كود عايز قيمة افتراضية لازم يمر من هنا فقط
 * (SmartDefaults.get / SmartDefaults.pickSingle) — ممنوع كتابة
 * "قيمة ثابتة" (Hardcoded) داخل أي شاشة أو موديول تاني.
 * ============================================================
 */

var SmartDefaults = (function () {
  // ── خريطة المفاتيح المدعومة: كل مفتاح بيقول مصدره في شيت
  // Settings + قيمة احتياطية (fallback) تُستخدم فقط لو المفتاح
  // فاضي تمامًا في الإعدادات (أول تشغيل للنظام قبل أي تهيئة). ──
  var REGISTRY = {
    default_warehouse: { settingsKey: "default_warehouse", fallback: "الرئيسي" },
    currency: { settingsKey: "currency", fallback: "EGP" },
    fiscal_year_start: { settingsKey: "fiscal_year_start", fallback: "01/01" },
    item_status: { settingsKey: null, fallback: "active" }, // مفيش مفتاح إعدادات مخصص له حاليًا؛ قيمة نظامية ثابتة بمعنى "الحالة الافتراضية عند الإنشاء"
    allow_negative_stock: { settingsKey: "allow_negative_stock", fallback: false },
  };

  /** سجل خفيف لأي مفتاح اتطلب ومالوش قيمة في الإعدادات ولا Fallback واضح — يساعد وقت المراجعة/التوسّع مستقبلاً بدل ما يفشل بصمت. */
  var _missingLog = [];

  /**
   * SmartDefaults.get(key)
   * بيرجع القيمة الافتراضية لمفتاح معيّن حسب الترتيب:
   * 1) قيمة محفوظة فعليًا في شيت الإعدادات (لو المستخدم/مدير النظام حددها).
   * 2) قيمة Fallback مسجّلة بالمحرك (توثّق كنص صريح هنا، مش متفرقة جوه الشاشات).
   * القيمة دي "افتراضية" بس — المستخدم لسه يقدر يغيّرها يدويًا في أي فورم.
   */
  function get(key) {
    var def = REGISTRY[key];
    if (!def) {
      _missingLog.push({ key: key, at: new Date().toISOString(), reason: "unregistered_key" });
      return "";
    }
    if (def.settingsKey) {
      try {
        var settings = _getCompanySettingsRaw();
        var val = settings ? settings[def.settingsKey] : undefined;
        if (val !== undefined && val !== null && String(val).trim() !== "") {
          return val;
        }
      } catch (e) {
        console.error("SmartDefaults.get(" + key + "):", e);
      }
    }
    if (def.fallback === undefined) {
      _missingLog.push({ key: key, at: new Date().toISOString(), reason: "no_fallback" });
    }
    return def.fallback;
  }

  /**
   * SmartDefaults.pickSingle(list, valueField)
   * قاعدة "إذا كان هناك خيار واحد فقط يُختار تلقائيًا" — بيرجع القيمة
   * لو القائمة فيها عنصر واحد بالظبط، وإلا يرجع "" (يسيب الاختيار
   * للمستخدم أو لقيمة SmartDefaults.get العادية).
   */
  function pickSingle(list, valueField) {
    if (!list || list.length !== 1) return "";
    var only = list[0];
    return valueField ? only[valueField] : only;
  }

  /**
   * SmartDefaults.resolveWarehouse(explicitValue, warehousesList)
   * دالة مساعدة جاهزة لأكتر سيناريو متكرر بالنظام: تحديد مخزن افتراضي.
   * الأولوية: قيمة صريحة اتبعتت (المستخدم اختارها) > مخزن وحيد متاح >
   * المخزن الافتراضي من الإعدادات > "" (نسيب الفورم يطلب من المستخدم
   * صراحة بدل ما نجبره على قيمة قد تكون غلط).
   */
  function resolveWarehouse(explicitValue, warehousesList) {
    if (explicitValue && String(explicitValue).trim() !== "") return explicitValue;
    var single = pickSingle(warehousesList, "id");
    if (single) return single;
    var configured = get("default_warehouse");
    if (warehousesList && warehousesList.length) {
      var exists = warehousesList.some(function (w) {
        return String(w.id) === String(configured);
      });
      if (exists) return configured;
      return ""; // القيمة المُعدة مش موجودة فعليًا كمخزن حالي — أمان أهم من إجبار قيمة خاطئة
    }
    return configured || "";
  }

  /** SmartDefaults.getMissingLog() — للمراجعة فقط، مفاتيح اتطلبت وملهاش قيمة واضحة. */
  function getMissingLog() {
    return _missingLog.slice();
  }

  return {
    get: get,
    pickSingle: pickSingle,
    resolveWarehouse: resolveWarehouse,
    getMissingLog: getMissingLog,
  };
})();
