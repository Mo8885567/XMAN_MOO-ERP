/**
 * ============================================================
 * Module: Code_12h_UsersCRUD.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/** setAdminAlertEmail — تعيين إيميل التنبيهات الأمنية (v4.1) */
function setAdminAlertEmail(email, callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
  if (permErr) return permErr;
  return saveCompanySettings(
    { admin_alert_email: email },
    callerUser,
    sessionToken,
  );
}

/**
 * [SEC-WA-ALERT] setAdminAlertPhone — تعيين رقم واتساب التنبيهات
 * الأمنية (بجانب الإيميل). يُستخدم في _notifyAdminLoginBlock لإرسال
 * تنبيه فوري عبر قناة الواتساب (WhatsApp Communication Hub) عند حظر
 * حساب بسبب محاولات دخول متكررة، بشرط أن تكون القناة مُعدّة أصلاً.
 * @param {String} phone - رقم دولي بدون + (مثال: 201025306678)
 */
function setAdminAlertPhone(phone, callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "manageRoles", sessionToken);
  if (permErr) return permErr;
  return saveCompanySettings(
    { admin_alert_phone: String(phone || "").replace(/[^0-9]/g, "") },
    callerUser,
    sessionToken,
  );
}

/**
 * ينشئ مستخدم "admin" الافتراضي الوحيد (بكلمة مرور ثابتة admin123) عند
 * أول تشغيل للنظام فقط — إذا كان شيت Users فارغًا تمامًا.
 *
 * [SIMPLIFIED-SINGLE-ADMIN-2026-08-03] بعد ما كانت الدالة بتزرع 4
 * مستخدمين تجريبيين (admin/ahmed/sara/viewer1)، اتبسّطت بطلب صريح
 * لمستخدم admin واحد بس — العميل بيضيف أي مستخدمين إضافيين بنفسه من
 * شاشة إدارة المستخدمين بعد أول دخول.
 *
 * NOTE: يستخدم علامة كاش (USERS_CACHE_FLAG_KEY) لتفادي قراءة الشيت في
 * كل تسجيل دخول (PERF-LOGIN-2)؛ كلمة المرور تُخزَّن مشفَّرة من اللحظة
 * الأولى (لا تُحفظ كنص صريح أبدًا).
 */
function ensureDefaultUsers() {
  // ✅ [PERF-LOGIN-2] تحقق من الكاش أولاً — لو الـ flag موجود يرجع فوراً
  // بدون أي I/O على الشيت (يوفّر 100-200ms في كل لوجين)
  try {
    if (CacheEngine.get(CacheEngine.NAMESPACE.USERS, USERS_CACHE_FLAG_KEY))
      return;
  } catch (e) {
    console.error("ensureDefaultUsers - خطأ:", e.message || e);
  }

  const sheet = getSheet("Users");
  if (sheet.getLastRow() > 1) {
    // المستخدمون موجودون — احفظ الـ flag لـ 10 دقائق
    try {
      CacheEngine.set(
        CacheEngine.NAMESPACE.USERS,
        USERS_CACHE_FLAG_KEY,
        "1",
        CacheEngine.POLICY.TRANSIENT_FLAG,
      );
    } catch (e) {
      console.error("ensureDefaultUsers - خطأ:", e.message || e);
    }
    return;
  }
  // ✅ [FIX-1] الباسورد الافتراضي يُخزَّن مشفرًا من اللحظة الأولى
  // ✅ [FORCE-PW-2]:
  //  - last_login يفضل فاضي ("") لحد ما يسجل دخول فعلي لأول مرة.
  //  - force_password_change = true عشان يتفرض عليه تغيير الباسورد
  //    الافتراضي أول ما يسجل دخول حقيقي.
  //  - password_changed_at يفضل فاضي لأن الباسورد الحالي لسه هو
  //    الافتراضي ولم يتغيّر فعليًا بعد.
  //  - is_primary_admin = true صراحةً (مش fallback على الاسم الحرفي)
  //    عشان يبقى محمي من الحذف ومن تغيير الاسم المتضارب من أول لحظة.
  var _adminRowRange = sheet.getRange(2, 1, 1, 11);
  // 🎨 [FIX] نفس إصلاح _appendRowProtected بالظبط — نمسح أي لون خط قديم
  // متبقٍّ (أبيض مثلاً) على الصف قبل الكتابة، عشان صف admin الجديد ميظهرش
  // "مخفي بصريًا" في الشيت رغم إن بياناته موجودة فعليًا.
  _adminRowRange.setFontColor(null);
  _adminRowRange.setValues([
    [
      "admin",
      _hashPassword("admin123"),
      "admin",
      "مدير النظام",
      true,
      "",
      "",
      true,
      "",
      "[]",
      true,
    ],
  ]);
  // احفظ الـ flag بعد الإنشاء
  try {
    CacheEngine.set(
      CacheEngine.NAMESPACE.USERS,
      USERS_CACHE_FLAG_KEY,
      "1",
      CacheEngine.POLICY.TRANSIENT_FLAG,
    );
    _invalidateUsersCache(); // المستخدم الجديد يجب أن يُعاد قراءته
  } catch (e) {
    console.error("ensureDefaultUsers - خطأ:", e.message || e);
  }
}

/**
 * يُرجع قائمة المستخدمين بدون كلمات المرور (لعرضها في شاشة إدارة
 * المستخدمين). [SEC-FIX-7] callerUser اختياري: يُترك فارغًا للاستدعاءات
 * الداخلية الشرعية (مثل prefetch عند doGet)، ويُفحص إذا أُرسل من الواجهة.
 *
 * @param {String} [callerUser] - اسم المستخدم الطالب (إن وُجد يُفحص جلسته).
 * @param {String} [sessionToken] - توكن الجلسة المرافق لـ callerUser.
 * @returns {{success: Boolean, users: Array<Object>, message: String=}}
 */
function getUsers(callerUser, sessionToken) {
  try {
    // إذا أُرسل callerUser من الـ frontend، نتحقق من الصلاحية
    if (callerUser) {
      var sessCheck = sessionToken ? validateSession(sessionToken) : null;
      if (sessCheck && !sessCheck.valid) {
        return { success: false, users: [], message: "جلستك انتهت" };
      }
    }
    var users = cleanArr(getSheetData("Users")).map(function (u) {
      return {
        username: u.username,
        full_name: u.full_name,
        role: u.role,
        active: _isActiveUser(u.active),
        email: u.email || "",
        last_login: u.last_login
          ? u.last_login instanceof Date
            ? u.last_login.toISOString()
            : u.last_login
          : "",
        // ✅ [FORCE-PW-1] لعرض حالة "بانتظار تغيير كلمة المرور" في شاشة إدارة المستخدمين
        forcePasswordChange: _isForceChange(u.force_password_change),
        password_changed_at: u.password_changed_at
          ? u.password_changed_at instanceof Date
            ? u.password_changed_at.toISOString()
            : u.password_changed_at
          : "",
      };
    });
    return { success: true, users: users };
  } catch (e) {
    return { success: false, users: [], message: "خطأ في جلب المستخدمين" };
  }
}

/**
 * يضيف مستخدمًا جديدًا للنظام بعد التحقق من الصلاحية وصحة البيانات.
 *
 * Business Rules:
 * - اسم المستخدم "system" محجوز داخليًا (fallback هوية عند غياب
 *   sessionToken في بعض الدوال) ولا يمكن استخدامه لحساب حقيقي
 *   (SEC-FIX-H3، يمنع انتحال صلاحية).
 * - اسم المستخدم يجب أن يكون فريدًا.
 * - كلمة المرور تُشفَّر قبل الحفظ دائمًا (لا تُخزَّن كنص صريح).
 *
 * Throws:
 * - Permission Error (عبر _checkPermission) إن لم يملك callerUser صلاحية addUser.
 *
 * @param {Object} user - بيانات المستخدم الجديد (username, password, role, full_name, email).
 * @param {String} callerUser - اسم المستخدم المنفِّذ للعملية.
 * @param {String} sessionToken - توكن جلسة callerUser.
 * @returns {{success: Boolean, message: String}}
 */
function addUser(user, callerUser, sessionToken) {
  // [SEC-FIX-PERM] التحقق من الجلسة والصلاحية إلزامي — لا يُتجاوز
  if (!callerUser) return errResponse("⛔ يجب تسجيل الدخول لإضافة مستخدم");
  var permErr = _checkPermission(callerUser, "addUser", sessionToken);
  if (permErr) return permErr;
  _writeAuditLog({
    user: callerUser,
    action: "ADD_USER",
    table: "Users",
    record_id: user.username || "",
    details: "إضافة مستخدم",
  });
  try {
    if (!user.username || !user.full_name || !user.password)
      return errResponse("جميع الحقول المطلوبة يجب ملؤها");

    // [SEC-FIX-H3] "system" اسم محجوز داخليًا كـ fallback هوية عند غياب
    // sessionToken في بعض الدوال — منع إنشاء حساب فعلي بنفس الاسم يقفل
    // احتمال انتحال صلاحية لو استُخدم يومًا كحساب حقيقي.
    if (user.username.trim().toLowerCase() === "system")
      return errResponse('⛔ اسم المستخدم "system" محجوز ولا يمكن استخدامه');

    if (getSheetData("Users").some((u) => u.username === user.username.trim()))
      return errResponse("اسم المستخدم موجود بالفعل");

    // ✅ [FORCE-PW-1] كل مستخدم جديد يُنشَأ بكلمة مرور مؤقتة من المدير
    // يُجبَر على تغييرها عند أول تسجيل دخول — هذا هو السلوك الافتراضي
    // ولا يمكن تعطيله إلا بتمرير user.force_password_change === false صراحةً
    // (مثال: استيراد بيانات تجريبية).
    var forceChangeOnCreate =
      user.force_password_change === false ? false : true;

    var _newUserRow = [
      user.username.trim(),
      _hashPassword(user.password), // ✅ [FIX-1] تشفير قبل الحفظ
      user.role || "operator",
      user.full_name.trim(),
      true,
      "",
      (user.email || "").trim(),
      forceChangeOnCreate,
      "", // password_changed_at — لم تتغيّر بعد (ما زالت المؤقتة)
      "[]", // password_history — فارغ عند الإنشاء
      false, // is_primary_admin — المستخدمون الجدد ليسوا الحساب الرئيسي أبدًا
    ];
    var _usersSheet = getSheet("Users");
    // 🎨 [FIX] نمسح أي لون خط قديم متبقٍّ قبل الكتابة (نفس إصلاح
    // _appendRowProtected).
    _usersSheet
      .getRange(_usersSheet.getLastRow() + 1, 1, 1, _newUserRow.length)
      .setFontColor(null);
    _usersSheet.appendRow(_newUserRow);
    // ✅ FIX: مسح السيرفر كاش عشان getAllData يرجع البيانات الجديدة
    _invalidateServerCache();
    // ✅ [PERF-LOGIN-7] مسح كاش Users — المستخدم الجديد يجب أن يُرى في اللوجين
    _invalidateUsersCache();
    return okResponse("✅ تم إضافة المستخدم بنجاح");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * يحدّث بيانات مستخدم موجود (الدور، الاسم، الحالة، البريد، وكلمة
 * المرور اختياريًا).
 *
 * Business Rules:
 * - كلمة المرور لا تتغير إلا إذا أُرسلت قيمة فعلية جديدة (user.password
 *   غير فارغة)؛ غير ذلك تبقى القيمة المخزَّنة كما هي.
 * - يُسجَّل الفرق بين القيم القديمة والجديدة (_diffObjects) في سجل
 *   التدقيق لتتبع من غيّر ماذا.
 *
 * Throws:
 * - Permission Error إن لم يملك user.callerUser صلاحية updateUser.
 *
 * @param {Object} user - يحتوي username (مفتاح البحث)، callerUser،
 *   sessionToken، وأي حقول يُراد تحديثها.
 * @returns {{success: Boolean, message: String}}
 */
function updateUser(user) {
  // [SEC-FIX-PERM] التحقق من الجلسة والصلاحية إلزامي
  if (!user.callerUser)
    return errResponse("⛔ يجب تسجيل الدخول لتعديل المستخدمين");
  var permErr = _checkPermission(
    user.callerUser,
    "updateUser",
    user.sessionToken,
  );
  if (permErr) return permErr;
  try {
    // ✅ [RENAME-USER] البحث يتم بـ original_username لو أُرسل (يدعم تغيير
    // اسم المستخدم نفسه)؛ وإلا يُستخدم username كالسابق (بدون تغيير سلوك
    // الشاشات القديمة التي لا ترسل original_username).
    var lookupUsername = String(
      user.original_username || user.username || "",
    ).trim();
    const row = findRow(getSheetData("Users"), "username", lookupUsername);
    if (!row) return errResponse("المستخدم غير موجود");

    var newUsername = String(user.username || "").trim() || row.username;
    var isRename = newUsername !== row.username;

    // ✅ [PRIMARY-ADMIN-FLAG] نحدد قبل أي تعديل هل هذا الصف هو "المدير
    // الرئيسي" المحمي — عبر العلامة الثابتة (أو fallback الاسم الحرفي
    // "admin" للبيانات القديمة اللي لسه ما تهاجرتش). النتيجة دي بتتبع
    // الحساب الفعلي مش الاسم، فتفضل صحيحة حتى بعد تغيير الاسم.
    var wasPrimaryAdmin = BusinessRulesEngine.rules.User.isMainAdmin(
      row.username,
    );

    if (isRename) {
      if (newUsername.toLowerCase() === "admin" && !wasPrimaryAdmin)
        return errResponse('⛔ اسم المستخدم "admin" محجوز للحساب الرئيسي فقط');
      if (!newUsername) return errResponse("اسم المستخدم مطلوب");
      if (newUsername.toLowerCase() === "system")
        return errResponse('⛔ اسم المستخدم "system" محجوز ولا يمكن استخدامه');
      if (
        getSheetData("Users").some(
          (u) => u.username === newUsername && u.username !== row.username,
        )
      )
        return errResponse("اسم المستخدم الجديد مستخدم بالفعل");
    }

    // ← v4.1: احفظ القيم القديمة قبل التعديل للـ Audit Log
    var oldValues = {
      username: row.username,
      role: row.role,
      full_name: row.full_name,
      active: row.active,
      email: row.email,
    };
    var newValues = {
      username: newUsername,
      role: user.role || row.role,
      full_name: user.full_name || row.full_name,
      active: _isActiveUser(user.active),
      email: (user.email !== undefined ? user.email : row.email) || "",
    };
    var diff = _diffObjects(oldValues, newValues);

    const sheet = getSheet("Users");
    const oldPass = sheet.getRange(row._row, 2).getValue();
    const oldLastLogin = sheet.getRange(row._row, 6).getValue();

    // ✅ [FORCE-PW-1] هل الأدمن بيغيّر كلمة المرور فعليًا في هذه العملية؟
    var isPasswordReset = !!(user.password && user.password.trim());

    var finalPass;
    var finalForceChange = _isForceChange(row.force_password_change);
    var finalPasswordChangedAt = row.password_changed_at || "";
    var history = [];
    try {
      history = JSON.parse(row.password_history || "[]");
    } catch (e) {
      history = [];
    }

    if (isPasswordReset) {
      // ✅ [FIX-1] باسورد جديد → شفّره قبل الحفظ
      finalPass = _hashPassword(user.password);
      // ← احفظ الباسورد القديم في السجل (لدعم منع إعادة الاستخدام مستقبلاً)
      history.push(String(oldPass || ""));
      if (history.length > 5) history = history.slice(history.length - 5);
      finalPasswordChangedAt = new Date();
      // 🔒 قاعدة عمل: إعادة تعيين كلمة مرور من المدير تفرض على المستخدم
      // تغييرها بنفسه عند أول دخول تالٍ — تمامًا مثل الأنظمة العالمية
      // (Dynamics 365 / SAP B1 / NetSuite / Odoo). يمكن للمدير تعطيل هذا
      // صراحةً عبر تمرير user.force_password_change === false.
      finalForceChange = user.force_password_change === false ? false : true;
    } else if (user.force_password_change !== undefined) {
      // الأدمن غيّر العلم فقط (مثال: زر "إجبار على تغيير كلمة المرور عند
      // الدخول القادم") من غير تغيير كلمة المرور نفسها.
      finalForceChange = _isForceChange(user.force_password_change);
      finalPass = oldPass;
    } else {
      // لا تغيير في الباسورد ولا في العلامة → احتفظ بكل القيم كما هي
      finalPass = oldPass;
    }

    const finalActive = _isActiveUser(user.active);

    // ✅ [PRIMARY-ADMIN-FLAG] لو الحساب ده كان هو "المدير الرئيسي" (سواء
    // بالعلامة الصريحة أو بـ fallback الاسم القديم "admin")، نسجّل العلامة
    // صراحةً = true عشان الحماية تفضل متبِّعة الحساب حتى بعد تغيير اسمه.
    // غير كده، بنحافظ على القيمة الحالية زي ما هي.
    var finalIsPrimaryAdmin = wasPrimaryAdmin
      ? true
      : row.is_primary_admin === true ||
        String(row.is_primary_admin).toUpperCase() === "TRUE";

    sheet
      .getRange(row._row, 1, 1, 11)
      .setValues([
        [
          newUsername,
          finalPass,
          user.role || row.role,
          user.full_name || row.full_name,
          finalActive,
          oldLastLogin || "",
          (user.email !== undefined ? user.email : row.email) || "",
          finalForceChange,
          finalPasswordChangedAt,
          JSON.stringify(history),
          finalIsPrimaryAdmin,
        ],
      ]);

    _writeAuditLog({
      user: user.callerUser || "SYSTEM",
      action: "UPDATE_USER",
      table: "Users",
      record_id: newUsername,
      details:
        "تعديل بيانات مستخدم" +
        (isRename
          ? ' | تم تغيير اسم المستخدم من "' +
            row.username +
            '" إلى "' +
            newUsername +
            '"'
          : "") +
        (isPasswordReset
          ? " | تمت إعادة تعيين كلمة المرور — سيُطلب من المستخدم تغييرها عند الدخول القادم: " +
            (finalForceChange ? "نعم" : "لا")
          : ""),
      old_value: diff.old,
      new_value: diff.new,
    });

    // ✅ FIX: مسح السيرفر كاش عشان getAllData يرجع البيانات الجديدة
    _invalidateServerCache();
    // ✅ [PERF-LOGIN-7] مسح كاش Users — التعديل يجب أن ينعكس فوراً في اللوجين
    _invalidateUsersCache();

    // ✅ NEW v4.2: إذا تغيّر الاسم الكامل → نشّر التغيير في جميع الجداول
    var oldFullName = oldValues.full_name;
    var newFullName = user.full_name || row.full_name;
    if (oldFullName && newFullName && oldFullName !== newFullName) {
      _propagateUserNameChange(
        newUsername,
        oldFullName,
        newFullName,
        user.callerUser || "SYSTEM",
      );
    }

    // ✅ [RENAME-USER] لو تغيّر اسم المستخدم نفسه: انشر التغيير في كل
    // الجداول التي تخزّن username كمرجع، وأنهِ كل جلساته النشطة (لازم
    // يسجّل دخول من جديد باسمه الجديد).
    if (isRename) {
      _propagateUserRename(
        row.username,
        newUsername,
        user.callerUser || "SYSTEM",
      );
    }

    return okResponse(
      isRename
        ? "✅ تم تعديل المستخدم وتغيير اسم المستخدم بنجاح — سيُطلب منه تسجيل الدخول باسمه الجديد"
        : "✅ تم تعديل المستخدم",
    );
  } catch (e) {
    Logger.log(
      "[updateUser] استثناء غير متوقع: " + e.message + " | " + e.stack,
    );
    return errResponse("خطأ: " + e.message);
  }
}

function _propagateUserRename(oldUsername, newUsername, callerUser) {
  try {
    // 1) UserPermissions.username
    try {
      var permSheet = getSheet("UserPermissions", USER_PERM_HEADERS);
      var permData = permSheet.getDataRange().getValues();
      if (permData.length > 1) {
        var permHeaders = permData[0];
        var unameIdx = permHeaders.indexOf("username");
        if (unameIdx !== -1) {
          for (var r = 1; r < permData.length; r++) {
            if (String(permData[r][unameIdx]) === String(oldUsername)) {
              permSheet.getRange(r + 1, unameIdx + 1).setValue(newUsername);
            }
          }
        }
      }
    } catch (e) {
      Logger.log("_propagateUserRename UserPermissions error: " + e.message);
    }

    // 2) عمود "user" في الجداول التشغيلية — إعادة استخدام نفس منطق
    // _propagateUserNameChange (تستبدل أي خلية تساوي oldUsername بالاسم
    // الجديد؛ الشرط الثاني على username غير مؤثر هنا لأن القيمة الجديدة
    // لم تكن موجودة أصلاً في البيانات القديمة).
    _propagateUserNameChange(newUsername, oldUsername, newUsername, callerUser);

    // 3) إنهاء كل الجلسات النشطة للاسم القديم — أي جلسة قائمة تحمل الاسم
    // القديم مخزّنة في PropertiesService ولن تعود تطابق سجل Users بعد
    // التغيير، فالأسلم إجبار إعادة تسجيل الدخول بدل ترك جلسة معلّقة.
    _destroyAllUserSessions(oldUsername);

    _writeAuditLog({
      user: callerUser,
      action: "RENAME_USERNAME",
      table: "Users",
      record_id: newUsername,
      details: "تغيير اسم المستخدم (username) ونشره في كل الجداول والجلسات",
      old_value: oldUsername,
      new_value: newUsername,
    });
  } catch (e) {
    Logger.log("_propagateUserRename error: " + e.message);
  }
}

function _destroyAllUserSessions(username) {
  try {
    var props = PropertiesService.getScriptProperties();
    var allProps = props.getProperties();
    Object.keys(allProps).forEach(function (k) {
      if (k.indexOf("sess_") !== 0) return;
      try {
        var s = JSON.parse(allProps[k]);
        if (s.username === username) props.deleteProperty(k);
      } catch (e) {
        // تجاهل خانة تالفة وتابع البقية
      }
    });
  } catch (e) {
    Logger.log("_destroyAllUserSessions error: " + e.message);
  }
}

function _propagateUserNameChange(username, oldName, newName, callerUser) {
  try {
    var sheetsToUpdate = [
      { name: "Transactions", col: "user" },
      { name: "ProductionOrders", col: "user" },
      { name: "Shipments", col: "user" },
    ];

    sheetsToUpdate.forEach(function (cfg) {
      try {
        var sh = SS.getSheetByName(cfg.name);
        if (!sh) return;
        var data = sh.getDataRange().getValues();
        if (data.length < 2) return;
        var headers = data[0];
        var colIdx = headers.indexOf(cfg.col);
        if (colIdx === -1) return;
        var updated = 0;
        // ✅ [PERF] تجميع التحديثات في batch بدل setValue فردي داخل الحلقة
        var batchUpdates = [];
        for (var r = 1; r < data.length; r++) {
          var cellVal = String(data[r][colIdx] || "");
          if (cellVal === oldName || cellVal === username) {
            data[r][colIdx] = newName; // تحديث الـ in-memory array
            updated++;
          }
        }
        if (updated > 0) {
          sh.getRange(2, colIdx + 1, data.length - 1, 1).setValues(
            data.slice(1).map(function (row) {
              return [row[colIdx]];
            }),
          );
        }
        if (updated > 0) {
          _writeAuditLog({
            user: callerUser,
            action: "RENAME_USER_PROPAGATE",
            table: cfg.name,
            record_id: username,
            details:
              "تحديث اسم المستخدم في " + cfg.name + " (" + updated + " سجل)",
            old_value: oldName,
            new_value: newName,
          });
        }
      } catch (e) {
        // تجاهل أخطاء الجداول الفردية — نكمل بقية الجداول
        Logger.log("propagate error in " + cfg.name + ": " + e.message);
      }
    });
  } catch (e) {
    Logger.log("_propagateUserNameChange error: " + e.message);
  }
}

function renameUser(payload) {
  try {
    // تحقق من الصلاحية: المدير فقط
    if (!payload || !payload.callerUser) return errResponse("غير مصرح");
    var caller = findRow(getSheetData("Users"), "username", payload.callerUser);
    if (!caller || caller.role !== "admin")
      return errResponse("هذه العملية متاحة للمدير فقط");

    if (!payload.username || !payload.new_name || !payload.new_name.trim())
      return errResponse("اسم المستخدم والاسم الجديد مطلوبان");

    var row = findRow(getSheetData("Users"), "username", payload.username);
    if (!row) return errResponse("المستخدم غير موجود");

    var oldName = row.full_name || "";
    var newName = payload.new_name.trim();

    if (oldName === newName) return okResponse("✅ الاسم لم يتغير");

    // حدّث في جدول Users
    var sheet = getSheet("Users");
    var fullNameColIdx =
      [
        "username",
        "password",
        "role",
        "full_name",
        "active",
        "last_login",
        "email",
      ].indexOf("full_name") + 1; // = 4
    sheet.getRange(row._row, fullNameColIdx).setValue(newName);

    _writeAuditLog({
      user: payload.callerUser,
      action: "RENAME_USER",
      table: "Users",
      record_id: payload.username,
      details: "تغيير الاسم الكامل للمستخدم",
      old_value: oldName,
      new_value: newName,
    });

    // نشر التغيير في الجداول الأخرى
    _propagateUserNameChange(
      payload.username,
      oldName,
      newName,
      payload.callerUser,
    );

    _invalidateServerCache();
    // ✅ [PERF-LOGIN-7] مسح كاش Users بعد تغيير الاسم
    _invalidateUsersCache();
    return {
      success: true,
      message: "✅ تم تغيير الاسم بنجاح",
      new_name: newName,
    };
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * يحذف مستخدمًا نهائيًا (Hard Delete) من شيت Users.
 *
 * Business Rules:
 * - حساب "admin" الرئيسي محمي من الحذف نهائيًا مهما كانت الصلاحيات.
 *
 * Throws:
 * - Permission Error إن لم يملك callerUser صلاحية deleteUser.
 *
 * @param {String} username - اسم المستخدم المطلوب حذفه.
 * @param {String} callerUser - اسم المستخدم المنفِّذ للعملية.
 * @param {String} sessionToken - توكن جلسة callerUser.
 * @returns {{success: Boolean, message: String}}
 */
function deleteUser(username, callerUser, sessionToken) {
  // [SEC-FIX-PERM] التحقق من الجلسة والصلاحية إلزامي — لا يُتجاوز
  if (!callerUser) return errResponse("⛔ يجب تسجيل الدخول لحذف مستخدم");
  var permErr = _checkPermission(callerUser, "deleteUser", sessionToken);
  if (permErr) return permErr;
  _writeAuditLog({
    user: callerUser,
    action: "DELETE_USER",
    table: "Users",
    record_id: username,
    details: "حذف مستخدم",
  });
  try {
    // [BRE-INTEGRATION] القواعد الثلاث التالية أصبحت تُدار من BusinessRulesEngine
    // بدل التكرار المحلي — راجع BUSINESS_RULES_ENGINE_REPORT.md (قسم "قواعد
    // المستخدمين"). فحص "المدير الرئيسي" كان موجودًا هنا أصلاً وتم نقله فقط،
    // أما "منع حذف المستخدم الحالي" و"منع إزالة آخر مستخدم admin" فهما قاعدتان
    // جديدتان أضيفتا هنا تنفيذًا صريحًا لمتطلبات محرك قواعد الأعمال.
    var _breCheck = BusinessRulesEngine.validateBeforeDelete("user", {
      username: username,
      callerUsername: callerUser,
    });
    if (!_breCheck.success) return errResponse(_breCheck.message);

    const row = findRow(getSheetData("Users"), "username", username);
    if (!row) return errResponse("المستخدم غير موجود");

    getSheet("Users").deleteRow(row._row);
    // ✅ [PERF-LOGIN-7] مسح كاش Users والسيرفر كاش بعد الحذف
    _invalidateUsersCache();
    _invalidateServerCache();
    return okResponse("✅ تم حذف المستخدم");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

