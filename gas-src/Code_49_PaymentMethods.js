// ════════════════════════════════════════════════════════════════
// Code_49_PaymentMethods.gs — [PAYMENT-METHODS-MASTER-1] طرق الدفع كـ
// Master Data بدل قيم ثابتة بالكود.
//
// خلفية: قبل هذا الملف، طرق الدفع كانت enum حر (CASH/BANK/VISA/WALLET)
// مُعرَّف في نقطتين: BANKLIKE_PAYMENT_METHODS (Code_12_Core.js) للفحص
// الخلفي، و PAYMENT_METHODS (31_JS_DataLayer.html) للعرض في الواجهة —
// راجع تعليق "SYSTEM-UNIFY" هناك وتعليق BP-ROADMAP في Code_20_Sales.js
// (PARTY_EXTRA_HEADERS_P4) اللي وثّق الفجوة دي مسبقاً وتوقّع الحاجة
// لكيان مستقل مستقبلاً.
//
// هذا الملف يضيف الكيان المستقل (PaymentMethods) + CRUD كامل، بنفس
// أسلوب Code_43_CostCenters.js تمامًا (بدون أي تسلسل هرمي هنا). حقل
// "code" هو نفس المفتاح الثابت المستخدم قديمًا في الكود، فأي مستند قديم
// (فواتير/سندات/موظفين) فيه payment_method = CASH/BANK/VISA/WALLET
// يفضل صالحًا 100% بدون أي Migration على البيانات القديمة نفسها —
// هذا الملف يضيف طبقة Master Data فوق نفس القيم، ولا يغيّرها.
//
// الربط بالواجهة: getAllData() (Code_12_Core.js) بيرجّع paymentMethods
// ضمن الحزمة الأساسية، و PAYMENT_METHODS في 31_JS_DataLayer.html بتتملى
// منها عند التحميل (راجع applyServerPaymentMethods هناك) بدل القيم
// الثابتة، فكل الشاشات اللي بتستخدم buildPaymentMethodOptions()/
// paymentMethodLabel() (المبيعات، المشتريات، التحصيل، السداد، الرواتب)
// بتاخد القائمة الجديدة تلقائيًا من غير أي تعديل في كل شاشة على حدة.
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §PM-01  طرق الدفع — CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function getPaymentMethods(callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewPaymentMethods");
    var rows = readSheet(
      "PaymentMethods",
      ACCOUNTING_HR_HEADERS.PaymentMethods,
      { trimStrings: true },
    );
    rows = rows.filter(function (r) {
      return r.is_active !== "FALSE" && r.is_active !== false;
    });
    rows.sort(function (a, b) {
      return Number(a.sort_order || 0) - Number(b.sort_order || 0);
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب طرق الدفع: " + e.message);
  }
}

function addPaymentMethod(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addPaymentMethod",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!ValidationEngine.isRequired(data.name))
      return errResponse("اسم طريقة الدفع مطلوب");
    if (!ValidationEngine.isRequired(data.code))
      return errResponse("كود طريقة الدفع مطلوب");

    var existing = readSheet(
      "PaymentMethods",
      ACCOUNTING_HR_HEADERS.PaymentMethods,
      { trimStrings: true },
    );
    var activeExisting = existing.filter(function (r) {
      return r.is_active !== "FALSE" && r.is_active !== false;
    });
    var code = String(data.code).trim().toUpperCase();
    if (ValidationEngine.isDuplicate(activeExisting, "code", code))
      return errResponse("يوجد طريقة دفع بنفس الكود مسبقاً");

    var id = makeId("PM");
    var now = new Date().toISOString();
    var nextOrder =
      activeExisting.reduce(function (max, r) {
        return Math.max(max, Number(r.sort_order || 0));
      }, 0) + 1;

    DataLayerEngine.insert(
      "PaymentMethods",
      {
        id: id,
        code: code,
        name: String(data.name).trim(),
        name_en: data.name_en || "",
        is_active: data.is_active === false ? false : true,
        sort_order:
          data.sort_order !== undefined && data.sort_order !== ""
            ? Number(data.sort_order)
            : nextOrder,
        notes: data.notes || "",
        created_at: now,
        created_by: data.callerUser,
        updated_at: now,
        updated_by: data.callerUser,
      },
      { headers: ACCOUNTING_HR_HEADERS.PaymentMethods },
    );

    AuditEngine.log("ADD", {
      user: data.callerUser,
      table: "PaymentMethods",
      record_id: id,
      details: "إضافة طريقة دفع: " + data.name,
      newValue: data});

    return okResponse("تم إضافة طريقة الدفع بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة طريقة الدفع: " + e.message);
  }
}

function updatePaymentMethod(id, data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updatePaymentMethod",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "PaymentMethods",
      ACCOUNTING_HR_HEADERS.PaymentMethods,
    );
    var rows = readSheet(
      "PaymentMethods",
      ACCOUNTING_HR_HEADERS.PaymentMethods,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("طريقة الدفع غير موجودة");
    var before = rows[idx];

    // [BACKWARD-COMPAT] عمداً لا نسمح بتعديل "code" بعد الإنشاء — القيمة
    // دي هي نفسها المخزّنة في مستندات قديمة (فواتير/سندات)، فتغييرها
    // يكسر الربط مع البيانات التاريخية. الاسم المعروض فقط قابل للتعديل.
    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var updates = {};
    ["name", "name_en", "notes", "sort_order"].forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    if (data.is_active !== undefined) updates.is_active = !!data.is_active;
    updates.updated_at = new Date().toISOString();
    updates.updated_by = data.callerUser;

    _applyRowUpdates(sheet, rowNum, headers, updates);

    AuditEngine.log("UPDATE", {
      user: data.callerUser,
      table: "PaymentMethods",
      record_id: id,
      details: "تعديل طريقة دفع: " + (updates.name || before.name),
      oldValue: _diffObjects(before, updates).old,
      newValue: _diffObjects(before, updates).new});

    return okResponse("تم تحديث طريقة الدفع بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث طريقة الدفع: " + e.message);
  }
}

function deletePaymentMethod(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "deletePaymentMethod",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet(
      "PaymentMethods",
      ACCOUNTING_HR_HEADERS.PaymentMethods,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("طريقة الدفع غير موجودة");

    // [SAFETY] تعطيل فقط (Soft) بدل الحذف الفعلي — نفس نمط CostCenters —
    // عشان المستندات القديمة اللي فيها نفس الكود تفضل قابلة للقراءة.
    var sheet = getSheet(
      "PaymentMethods",
      ACCOUNTING_HR_HEADERS.PaymentMethods,
    );
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var activeCol = headers.indexOf("is_active");
    if (activeCol !== -1) sheet.getRange(rowNum, activeCol + 1).setValue(false);

    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "PaymentMethods",
      record_id: id,
      details: "تعطيل طريقة دفع: " + rows[idx].name});

    return okResponse("تم تعطيل طريقة الدفع بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف طريقة الدفع: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §PM-02  Seed افتراضي — يُستدعى من initializeSystem() فقط
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * _seedDefaultPaymentMethodsIfEmpty — [PAYMENT-METHODS-MASTER-1] ينشئ
 * القائمة الافتراضية لطرق الدفع أول مرة النظام يتهيّأ، فقط لو شيت
 * PaymentMethods فاضي تمامًا. القيم مطابقة تمامًا لنفس الأكواد
 * المستخدمة فعليًا في المحاسبة (CASH/BANK/VISA/WALLET عبر
 * BANKLIKE_PAYMENT_METHODS في Code_12_Core.js) + إضافة CREDIT وCHECK
 * (آجل/شيك) المطلوبين. لا يوجد أي Migration على بيانات قديمة لأن
 * الأكواد نفسها لم تتغيّر إطلاقاً — هذا فقط طبقة Master Data فوقها.
 *
 * Idempotent: لو فيه أي طريقة دفع مسجّلة بالفعل (بأي كود)، بيتخطاها
 * بالكامل ومبيضيفش أو يكرر أي صف.
 *
 * بتتنادى من initializeSystem() في Code_21b_Migrations.js.
 */
function _seedDefaultPaymentMethodsIfEmpty() {
  try {
    var existing = readSheet(
      "PaymentMethods",
      ACCOUNTING_HR_HEADERS.PaymentMethods,
      { trimStrings: true },
    );
    if (existing && existing.length > 0) {
      return "↩️ يوجد " + existing.length + " طريقة دفع بالفعل — تخطّي";
    }

    var users = readSheet("Users", null, { trimStrings: true });
    var systemUser =
      users.find(function (u) {
        return String(u.username).trim().toLowerCase() === "admin";
      }) || users[0];
    if (!systemUser) {
      Logger.log(
        "[_seedDefaultPaymentMethodsIfEmpty] مفيش أي يوزر في النظام لسه — تخطّي",
      );
      return "⏭️ تخطّي — مفيش يوزر بعد لإنشاء الجلسة";
    }
    var sess = createSession(systemUser.username, systemUser.role);
    if (!sess || !sess.success) {
      Logger.log(
        "[_seedDefaultPaymentMethodsIfEmpty] فشل إنشاء جلسة مؤقتة: " +
          JSON.stringify(sess),
      );
      return " فشل إنشاء جلسة مؤقتة لإنشاء طرق الدفع الافتراضية";
    }

    // [BACKWARD-COMPAT] نفس الأكواد المستخدمة فعليًا في الكود القديم
    // (CASH/BANK/VISA/WALLET) + CREDIT/CHECK الجديدين المطلوبين. VISA
    // اتسمّى هنا "بطاقة ائتمان" (نفس المعنى المطلوب) بدل إنشاء كود مكرر.
    var defaults = [
      { code: "CASH", name: "نقداً", name_en: "Cash" },
      { code: "CREDIT", name: "آجل", name_en: "Credit (Deferred)" },
      { code: "BANK", name: "تحويل بنكي", name_en: "Bank Transfer" },
      { code: "CHECK", name: "شيك", name_en: "Check" },
      { code: "VISA", name: "بطاقة ائتمان", name_en: "Credit Card" },
      { code: "WALLET", name: "محفظة إلكترونية", name_en: "E-Wallet" },
    ];

    var created = 0;
    defaults.forEach(function (pm, i) {
      var res = addPaymentMethod({
        code: pm.code,
        name: pm.name,
        name_en: pm.name_en,
        sort_order: i + 1,
        callerUser: systemUser.username,
        sessionToken: sess.token,
      });
      if (res && res.success) created++;
      else
        Logger.log(
          "[_seedDefaultPaymentMethodsIfEmpty] فشل إنشاء " + pm.code + ": " +
            JSON.stringify(res),
        );
    });

    return " تم إنشاء " + created + " طريقة دفع افتراضية";
  } catch (e) {
    Logger.log("[_seedDefaultPaymentMethodsIfEmpty] خطأ: " + e.message);
    return " خطأ في إنشاء طرق الدفع الافتراضية: " + e.message;
  }
}
