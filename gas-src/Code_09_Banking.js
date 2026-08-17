// ════════════════════════════════════════════════════════════════
// Code_Banking.gs — [REFACTOR-P4] نُقل من Code_Accounting.gs (نقل نصي بحت،
// صفر تغيير في المنطق). كل ملفات .gs في نفس الـ Global Scope فعليًا،
// فنقل الدوال هنا لا يكسر أي استدعاء طالما الأسماء لم تتغير.
// راجع تقرير Architecture Audit 2026-07-03 — المرحلة 4.
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-03B  Accounting — Banks (إدارة البنوك) — Banking Module Phase 1
// ═══════════════════════════════════════════════════════════════════════════════

function getBanks(callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewBanks"); // [RBAC-FIX]
    var rows = readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return r.status !== "DELETED";
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب البنوك: " + e.message);
  }
}

function addBank(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addBank",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!ValidationEngine.isRequired(data.name))
      return errResponse("اسم البنك مطلوب");

    var existing = readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
      trimStrings: true,
    });
    var dup = existing.find(function (r) {
      return (
        String(r.name).trim().toLowerCase() ===
          String(data.name).trim().toLowerCase() && r.status !== "DELETED"
      );
    });
    if (dup) return errResponse("يوجد بنك بنفس الاسم مسبقاً");

    var id = makeId("BNKCO");
    var now = new Date().toISOString();
    var row = [
      id,
      String(data.name).trim(),
      data.logo || "",
      data.country || "",
      data.city || "",
      data.branch || "",
      data.address || "",
      data.phone || "",
      data.customer_service || "",
      data.website || "",
      data.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
      data.notes || "",
      now,
      data.callerUser,
      now,
      data.callerUser,
    ];
    var sheet = getSheet("Banks", ACCOUNTING_HR_HEADERS.Banks);
    _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.Banks, row);

    AuditEngine.log("ADD", {
      user: data.callerUser,
      table: "Banks",
      record_id: id,
      details: "إضافة بنك: " + data.name,
      newValue: data});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إضافة البنك بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة البنك: " + e.message);
  }
}

/**
 * _seedDefaultBankIfEmpty — [DEFAULT-BANK-1] ينشئ بنكًا افتراضيًا
 * "البنك الرئيسي (Main Bank)" أول مرة النظام يتهيّأ، فقط لو شيت Banks
 * فاضي تمامًا من أي بنك (عميل عنده بنك واحد فأكتر بالفعل لا يتأثر
 * إطلاقاً). بتنادي addBank() القياسية فيبقى جاهزًا فورًا لإضافة أول
 * حساب بنكي عليه من شاشة الحسابات البنكية (addBankAccount)، بنفس
 * الطريقة تمامًا اللي أي بنك يتضاف بيها يدويًا. الاسم قابل للتعديل
 * لاحقًا من شاشة البنوك (updateBank).
 *
 * Idempotent وSelf-Healing زي باقي دوال seed الأخرى — أي تشغيل لاحق
 * لـ initializeSystem()/setupEverything() بيتخطاها لو فيه أي بنك موجود.
 *
 * بتتنادى من initializeSystem() في Code_21b_Migrations.js.
 */
function _seedDefaultBankIfEmpty() {
  try {
    var existing = readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
      trimStrings: true,
    });
    var activeExisting = (existing || []).filter(function (r) {
      return r.status !== "DELETED";
    });
    if (activeExisting.length > 0) {
      return "↩️ يوجد بنك واحد على الأقل بالفعل (" + activeExisting.length + ") — تخطّي";
    }

    var users = readSheet("Users", null, { trimStrings: true });
    var systemUser =
      users.find(function (u) {
        return String(u.username).trim().toLowerCase() === "admin";
      }) || users[0];
    if (!systemUser) {
      Logger.log(
        "[_seedDefaultBankIfEmpty] مفيش أي يوزر في النظام لسه — تخطّي إنشاء البنك الافتراضي",
      );
      return "⏭️ تخطّي — مفيش يوزر بعد لإنشاء الجلسة";
    }

    var sess = createSession(systemUser.username, systemUser.role);
    if (!sess || !sess.success) {
      Logger.log(
        "[_seedDefaultBankIfEmpty] فشل إنشاء جلسة مؤقتة: " + JSON.stringify(sess),
      );
      return " فشل إنشاء جلسة مؤقتة لإنشاء البنك الافتراضي";
    }

    var result = addBank({
      name: "البنك الرئيسي (Main Bank)",
      notes: "البنك الافتراضي الرئيسي للنظام",
      callerUser: systemUser.username,
      sessionToken: sess.token,
    });

    if (result && result.success) {
      Logger.log(
        "[_seedDefaultBankIfEmpty] تم إنشاء البنك الرئيسي — id: " + result.id,
      );
      return " تم إنشاء البنك الرئيسي (id: " + result.id + ")";
    }
    Logger.log(
      "[_seedDefaultBankIfEmpty] فشل إنشاء البنك الرئيسي: " + JSON.stringify(result),
    );
    return " فشل إنشاء البنك الرئيسي: " + (result && result.message);
  } catch (e) {
    Logger.log("[_seedDefaultBankIfEmpty] خطأ: " + e.message);
    return " خطأ في إنشاء البنك الافتراضي: " + e.message;
  }
}

function updateBank(id, data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateBank",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet("Banks", ACCOUNTING_HR_HEADERS.Banks);
    var rows = readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("البنك غير موجود");
    var before = rows[idx];

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var updates = {};
    [
      "name",
      "logo",
      "country",
      "city",
      "branch",
      "address",
      "phone",
      "customer_service",
      "website",
      "notes",
    ].forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    if (data.status !== undefined)
      updates.status = data.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE";
    updates.updated_at = new Date().toISOString();
    updates.updated_by = data.callerUser;

    _applyRowUpdates(sheet, rowNum, headers, updates);

    AuditEngine.log("UPDATE", {
      user: data.callerUser,
      table: "Banks",
      record_id: id,
      details: "تعديل بنك: " + (updates.name || before.name),
      oldValue: _diffObjects(before, updates).old,
      newValue: _diffObjects(before, updates).new});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم تحديث بيانات البنك بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث البنك: " + e.message);
  }
}

function deleteBank(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "deleteBank", sessionToken);
    if (_permErr) return _permErr;

    var rows = readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("البنك غير موجود");

    // [BRE-UNIFY-1] فحص الحسابات المرتبطة الآن مركزي عبر BusinessRulesEngine
    var linkedAccounts = readSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
      { trimStrings: true },
    ).filter(function (a) {
      return (
        String(a.bank_id) === String(id) &&
        a.is_active !== "FALSE" &&
        a.is_active !== false
      );
    });
    var _bre = BusinessRulesEngine.validateBeforeDelete("bank", { id: id });
    if (!_bre.success)
      return errResponse(
        "لا يمكن حذف هذا البنك — يوجد " +
          linkedAccounts.length +
          " حساب بنكي مرتبط به. يرجى إلغاء ربط/حذف الحسابات أولاً",
      );

    var sheet = getSheet("Banks", ACCOUNTING_HR_HEADERS.Banks);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var statusCol = headers.indexOf("status");
    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("DELETED");

    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "Banks",
      record_id: id,
      details: "حذف بنك: " + rows[idx].name});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف البنك بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف البنك: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-04  Accounting — Bank Accounts (الحسابات البنكية)
// ═══════════════════════════════════════════════════════════════════════════════

function getBankAccounts(callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewBankAccounts"); // [RBAC-FIX]
    var rows = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return r.is_active !== false && r.is_active !== "FALSE";
    });
    // [Phase1] إثراء كل حساب باسم/دولة/مدينة البنك المرتبط لعرضها مباشرة بالواجهة
    try {
      var banksMap = {};
      readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
        trimStrings: true,
      }).forEach(function (b) {
        banksMap[b.id] = b;
      });
      rows.forEach(function (r) {
        var b = r.bank_id ? banksMap[r.bank_id] : null;
        r.bank_name = b ? b.name : r.bank_name || "";
        r.bank_country = b ? b.country : "";
        r.bank_city = b ? b.city : "";
        r.bank_logo = b ? b.logo : "";
        // [PAY-METHOD-EXT] الحسابات المُنشأة قبل إضافة هذا الحقل تُعامَل كبنك عادي
        if (["BANK", "VISA", "WALLET"].indexOf(r.account_kind) === -1)
          r.account_kind = "BANK";
      });
    } catch (joinErr) {
      Logger.log("[getBankAccounts] فشل ربط بيانات البنك: " + joinErr.message);
    }
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب الحسابات البنكية: " + e.message);
  }
}

// ── getNextBankAccountCode ───────────────────────────────────────────────────
// [AUTO-CODE] معاينة الكود التسلسلي التالي فور فتح مودال "حساب بنكي جديد" —
// نفس مبدأ getNextCashBoxCode/getNextCustomerCode. التوليد الملزم الفعلي
// يتم مرة أخرى داخل addBankAccount وقت الحفظ.
function getNextBankAccountCode() {
  return okResponse("", {
    data: AutoNumberService.preview(function () {
      return readSheet(
        "BankAccounts",
        ACCOUNTING_HR_HEADERS.BankAccounts,
      ).map(function (r) {
        return r.code;
      });
    }),
  });
}

function addBankAccount(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addBankAccount",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var _auditUser = data.callerUser;
    // [PAY-METHOD-EXT] نوع الحساب: BANK (افتراضي) / VISA / WALLET — البنك
    // ورقم الحساب إلزاميان فقط لحساب بنكي عادي؛ حسابات فيزا/المحافظ
    // الإلكترونية لا ترتبط ببنك فعلي بالضرورة.
    var accountKind = ["BANK", "VISA", "WALLET"].indexOf(data.account_kind) !== -1
      ? data.account_kind
      : "BANK";
    if (!ValidationEngine.isRequired(data.name)) return errResponse("اسم الحساب مطلوب");
    if (accountKind === "BANK" && !ValidationEngine.isRequired(data.account_number))
      return errResponse("رقم الحساب مطلوب للحساب البنكي");

    var existing = readSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
    );
    // [AUTO-NUMBER-CENTRAL] كود الحساب كان إلزاميًا إدخاله يدويًا بالكامل —
    // بقى له اقتراح تلقائي (1، 2، 3...) لو الحقل وصل فاضي، بنفس آلية باقي
    // الكيانات عبر AutoNumberService المركزية. الفحص الملزم من عدم التكرار
    // تحت لسه شغال زي ما هو سواء الكود جاي تلقائي أو مكتوب يدويًا.
    if (!data.code || !String(data.code).trim()) {
      data.code = AutoNumberService.preview(function () {
        return existing.map(function (r) {
          return r.code;
        });
      });
    }

    // [Phase1] التحقق من البنك المرتبط إن وُجد
    var bankId = "";
    if (accountKind === "BANK") {
      if (!ValidationEngine.isRequired(data.bank_id)) return errResponse("يجب اختيار البنك");
      var bankRow = readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
        trimStrings: true,
      }).find(function (b) {
        return b.id === data.bank_id && b.status !== "DELETED";
      });
      if (!bankRow) return errResponse("البنك المختار غير موجود");
      bankId = bankRow.id;
    }

    var activeExistingAcc = existing.filter(function (r) {
      return r.is_active !== "FALSE";
    });
    if (ValidationEngine.isDuplicate(activeExistingAcc, "code", data.code))
      return errResponse("كود الحساب البنكي موجود مسبقاً");

    // [P7-FIX] استخدام الحساب المُختار من دليل الحسابات لو أُرسل صراحةً
    // (الواجهة تطلب من المستخدم اختيار حساب موجود) بدل تجاهله وإنشاء حساب
    // جديد دائماً، وهو ما كان يُنتج حساب GL مكرراً يتيماً مع كل عملية إضافة
    var accountId = "";
    if (data.account_id) {
      var existingAccForLink = readSheet(
        "ChartOfAccounts",
        ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      ).find(function (a) {
        return a.id === data.account_id && !a.deleted_at;
      });
      if (existingAccForLink) accountId = existingAccForLink.id;
    }
    if (!accountId) {
      try {
        var _glPrefix =
          accountKind === "VISA"
            ? "فيزا — "
            : accountKind === "WALLET"
              ? "محفظة إلكترونية — "
              : "بنك — ";
        var accResult = addChartAccount({
          code: "12" + data.code,
          name: _glPrefix + data.name,
          type: "ASSET",
          currency: data.currency || "EGP",
          branch: data.branch || "",
        });
        if (accResult.success) accountId = accResult.id;
      } catch (accErr) {
        Logger.log("[addBankAccount] فشل إنشاء حساب GL: " + accErr.message);
      }
    }

    var id = makeId("BNK");
    var now = new Date().toISOString();
    var openingBalance = Number(data.opening_balance || 0);

    var row = [
      id,
      data.code,
      data.name,
      data.branch || "",
      data.currency || "EGP",
      data.account_number,
      data.iban || "",
      data.swift || "",
      openingBalance,
      openingBalance,
      accountId,
      "TRUE",
      data.notes || "",
      now,
      bankId,
      data.opening_date || now.split("T")[0],
      data.default_cost_center || "",
      data.callerUser,
      now,
      data.callerUser,
      accountKind,
    ];

    var _bnkSheet = getSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
    );
    _appendRowProtected(_bnkSheet, ACCOUNTING_HR_HEADERS.BankAccounts, row);

    AuditEngine.log("ADD", {
      user: data.callerUser,
      table: "BankAccounts",
      record_id: id,
      details: "إضافة حساب بنكي: " + data.name,
      newValue: data});

    // [C-002b FIX] قيد الرصيد الافتتاحي في الأستاذ العام
    if (openingBalance > 0 && accountId) {
      try {
        var accounts = readSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );
        var equityAccount = _getDefaultAccount(
          "opening_balance_equity_account",
          accounts,
          "EQUITY",
          [
            "الأرباح المرحلة",
            "أرباح مرحلة",
            "retained earnings",
            "رصيد افتتاحي",
          ],
        );
        if (equityAccount) {
          var refKey = "OB-BNK-" + id;
          var existingEntries = readSheet(
            "JournalEntries",
            ACCOUNTING_HR_HEADERS.JournalEntries,
            { trimStrings: true },
          );
          var alreadyPosted = existingEntries.some(function (e) {
            return (
              e.reference === refKey &&
              e.status !== "CANCELLED" &&
              e.status !== "REVERSED"
            );
          });
          if (!alreadyPosted) {
            _addJournalEntryInternal({
              callerUser: data.callerUser || "SYSTEM",
              date: now.split("T")[0],
              reference: refKey,
              source_type: "OPENING_BALANCE",
              description: "رصيد افتتاحي — بنك: " + data.name,
              lines: [
                {
                  account_id: accountId,
                  debit: openingBalance,
                  credit: 0,
                  notes: "رصيد افتتاحي بنك — " + data.name,
                },
                {
                  account_id: equityAccount.id,
                  debit: 0,
                  credit: openingBalance,
                  notes: "أرصدة افتتاحية",
                },
              ],
            });
          }
        } else {
          Logger.log(
            "[C-002b] تحذير: لم يُعثر على حساب أرصدة افتتاحية — لم يُنشأ قيد افتتاحي للبنك " +
              data.name,
          );
        }
      } catch (jeErr) {
        Logger.log("[C-002b] خطأ في قيد رصيد افتتاحي البنك: " + jeErr.message);
      }
    }

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إضافة الحساب البنكي بنجاح", {
      id: id,
      account_id: accountId,
    });
  } catch (e) {
    return errResponse("خطأ في إضافة الحساب البنكي: " + e.message);
  }
}

function updateBankAccount(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateBankAccount",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
    var rows = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الحساب البنكي غير موجود");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    var updates = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.iban !== undefined) updates.iban = data.iban;
    if (data.swift !== undefined) updates.swift = data.swift;
    if (data.account_number !== undefined)
      updates.account_number = data.account_number;
    if (data.is_active !== undefined)
      updates.is_active = data.is_active ? "TRUE" : "FALSE";
    if (data.notes !== undefined) updates.notes = data.notes;
    if (data.account_id !== undefined && data.account_id) {
      var existingAccForLinkUpd = readSheet(
        "ChartOfAccounts",
        ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      ).find(function (a) {
        return a.id === data.account_id && !a.deleted_at;
      });
      if (existingAccForLinkUpd) updates.account_id = data.account_id;
    }
    if (data.bank_id !== undefined) {
      if (!data.bank_id) {
        updates.bank_id = "";
      } else {
        var bankRowUpd = readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
          trimStrings: true,
        }).find(function (b) {
          return b.id === data.bank_id && b.status !== "DELETED";
        });
        if (!bankRowUpd) return errResponse("البنك المختار غير موجود");
        updates.bank_id = bankRowUpd.id;
      }
    }
    if (data.opening_date !== undefined)
      updates.opening_date = data.opening_date;
    if (data.default_cost_center !== undefined)
      updates.default_cost_center = data.default_cost_center;
    if (
      data.account_kind !== undefined &&
      ["BANK", "VISA", "WALLET"].indexOf(data.account_kind) !== -1
    )
      updates.account_kind = data.account_kind;
    updates.updated_at = new Date().toISOString();
    updates.updated_by = data.callerUser;

    _applyRowUpdates(sheet, rowNum, headers, updates);

    AuditEngine.log("UPDATE", {
      user: data.callerUser,
      table: "BankAccounts",
      record_id: id,
      details: "تعديل حساب بنكي: " + (updates.name || rows[idx].name),
      newValue: updates});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم تحديث الحساب البنكي بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث الحساب البنكي: " + e.message);
  }
}

function deleteBankAccount(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "deleteBankAccount",
      sessionToken,
    );
    if (_permErr) return _permErr;
    var rows = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الحساب البنكي غير موجود");

    // [BRE-UNIFY-1] فحص الرصيد الآن مركزي عبر BusinessRulesEngine
    var _bre = BusinessRulesEngine.validateBeforeDelete("bankAccount", {
      id: id,
    });
    if (!_bre.success) {
      var bankBalance = Number(rows[idx].current_balance || 0);
      return errResponse(
        "لا يمكن حذف حساب بنكي برصيد حالي (" +
          bankBalance.toFixed(2) +
          ") — يرجى تصفير الرصيد أولاً",
      );
    }

    var sheet = getSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var isActiveCol = headers.indexOf("is_active");
    if (isActiveCol !== -1)
      sheet.getRange(rowNum, isActiveCol + 1).setValue("FALSE");

    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "BankAccounts",
      record_id: id,
      details: "حذف حساب بنكي: " + rows[idx].name});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف الحساب البنكي بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف الحساب البنكي: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-04B  Accounting — Cheque Books (دفاتر الشيكات) — Banking Module Phase 2
// ═══════════════════════════════════════════════════════════════════════════════

function getChequeBooks(callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewChequeBooks"); // [RBAC-FIX]
    var rows = readSheet("ChequeBooks", ACCOUNTING_HR_HEADERS.ChequeBooks, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return r.status !== "DELETED";
    });
    // إثراء كل دفتر باسم الحساب البنكي/البنك المرتبط + حساب المتبقي
    try {
      var bankAccMap = {};
      readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts, {
        trimStrings: true,
      }).forEach(function (a) {
        bankAccMap[a.id] = a;
      });
      var banksMap = {};
      readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
        trimStrings: true,
      }).forEach(function (b) {
        banksMap[b.id] = b;
      });
      rows.forEach(function (r) {
        var acc = bankAccMap[r.bank_account_id];
        r.bank_account_name = acc ? acc.name : "";
        r.bank_account_code = acc ? acc.code : "";
        var bank = acc && acc.bank_id ? banksMap[acc.bank_id] : null;
        r.bank_name = bank ? bank.name : "";
        var total = Number(r.total_count || 0);
        var used = Number(r.used_count || 0);
        r.remaining_count = Math.max(total - used, 0);
        // [Auto] الدفتر يتحول تلقائياً لحالة "منتهي" لو خلصت كل أرقامه
        if (r.status === "ACTIVE" && total > 0 && used >= total) {
          r.status = "FINISHED";
        }
      });
    } catch (joinErr) {
      Logger.log("[getChequeBooks] فشل إثراء البيانات: " + joinErr.message);
    }
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب دفاتر الشيكات: " + e.message);
  }
}

function addChequeBook(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addChequeBook",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    if (!ValidationEngine.isRequired(data.bank_account_id)) return errResponse("يجب اختيار الحساب البنكي");
    var bankAccount = readSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
      { trimStrings: true },
    ).find(function (a) {
      return (
        a.id === data.bank_account_id &&
        a.is_active !== "FALSE" &&
        a.is_active !== false
      );
    });
    if (!bankAccount) return errResponse("الحساب البنكي غير موجود");

    var firstNumber = parseInt(data.first_number, 10);
    var lastNumber = parseInt(data.last_number, 10);
    if (!ValidationEngine.isPositive(firstNumber) || !ValidationEngine.isPositive(lastNumber))
      return errResponse("أول رقم وآخر رقم شيك مطلوبان وصحيحان");
    if (lastNumber < firstNumber)
      return errResponse("آخر رقم شيك يجب أن يكون أكبر من أو يساوي أول رقم");

    // [P2] منع تداخل نطاقات أرقام الشيكات بين دفاتر نفس الحساب البنكي
    var existingBooks = readSheet(
      "ChequeBooks",
      ACCOUNTING_HR_HEADERS.ChequeBooks,
      { trimStrings: true },
    ).filter(function (b) {
      return (
        String(b.bank_account_id) === String(data.bank_account_id) &&
        b.status !== "DELETED" &&
        b.status !== "CANCELLED"
      );
    });
    var overlap = existingBooks.find(function (b) {
      var bFirst = Number(b.first_number || 0);
      var bLast = Number(b.last_number || 0);
      return firstNumber <= bLast && lastNumber >= bFirst;
    });
    if (overlap)
      return errResponse(
        "نطاق أرقام الشيكات يتداخل مع دفتر موجود بالفعل (" +
          overlap.code +
          ": " +
          overlap.first_number +
          " - " +
          overlap.last_number +
          ")",
      );

    var id = makeId("CHB");
    var now = new Date().toISOString();
    var totalCount = lastNumber - firstNumber + 1;
    var row = [
      id,
      data.code || "CHB-" + firstNumber + "-" + lastNumber,
      data.bank_account_id,
      data.issue_date || now.split("T")[0],
      firstNumber,
      lastNumber,
      totalCount,
      0, // used_count
      "ACTIVE",
      data.notes || "",
      now,
      data.callerUser,
      now,
      data.callerUser,
    ];
    var sheet = getSheet("ChequeBooks", ACCOUNTING_HR_HEADERS.ChequeBooks);
    _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.ChequeBooks, row);

    AuditEngine.log("ADD", {
      user: data.callerUser,
      table: "ChequeBooks",
      record_id: id,
      details:
        "إضافة دفتر شيكات (" +
        firstNumber +
        " - " +
        lastNumber +
        ") لحساب: " +
        bankAccount.name,
      newValue: data});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إضافة دفتر الشيكات بنجاح", {
      id: id,
      total_count: totalCount,
    });
  } catch (e) {
    return errResponse("خطأ في إضافة دفتر الشيكات: " + e.message);
  }
}

function updateChequeBook(id, data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateChequeBook",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet("ChequeBooks", ACCOUNTING_HR_HEADERS.ChequeBooks);
    var rows = readSheet("ChequeBooks", ACCOUNTING_HR_HEADERS.ChequeBooks, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("دفتر الشيكات غير موجود");
    var before = rows[idx];

    // [P2] لا يجوز تعديل نطاق الأرقام بعد استخدام أي شيك من الدفتر
    var usedCount = Number(before.used_count || 0);
    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var updates = {};

    if (
      (data.first_number !== undefined || data.last_number !== undefined) &&
      usedCount > 0
    ) {
      return errResponse(
        "لا يمكن تعديل نطاق أرقام الدفتر بعد استخدام شيكات منه",
      );
    }
    if (data.first_number !== undefined || data.last_number !== undefined) {
      var fNum =
        data.first_number !== undefined
          ? parseInt(data.first_number, 10)
          : Number(before.first_number);
      var lNum =
        data.last_number !== undefined
          ? parseInt(data.last_number, 10)
          : Number(before.last_number);
      if (!fNum || !lNum || lNum < fNum)
        return errResponse("نطاق أرقام الشيكات غير صحيح");
      updates.first_number = fNum;
      updates.last_number = lNum;
      updates.total_count = lNum - fNum + 1;
    }
    if (data.issue_date !== undefined) updates.issue_date = data.issue_date;
    if (data.notes !== undefined) updates.notes = data.notes;
    if (data.status !== undefined) {
      if (["ACTIVE", "FINISHED", "CANCELLED"].indexOf(data.status) === -1)
        return errResponse("حالة دفتر غير صحيحة");
      if (data.status === "CANCELLED" && usedCount > 0)
        return errResponse(
          "لا يمكن إلغاء دفتر تم استخدام شيكات منه — استخدم تعديل الحالة لكل شيك بدلاً من ذلك",
        );
      updates.status = data.status;
    }
    updates.updated_at = new Date().toISOString();
    updates.updated_by = data.callerUser;

    _applyRowUpdates(sheet, rowNum, headers, updates);

    AuditEngine.log("UPDATE", {
      user: data.callerUser,
      table: "ChequeBooks",
      record_id: id,
      details: "تعديل دفتر شيكات: " + before.code,
      oldValue: _diffObjects(before, updates).old,
      newValue: _diffObjects(before, updates).new});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم تحديث دفتر الشيكات بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث دفتر الشيكات: " + e.message);
  }
}

function deleteChequeBook(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "deleteChequeBook",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet("ChequeBooks", ACCOUNTING_HR_HEADERS.ChequeBooks, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("دفتر الشيكات غير موجود");

    var usedCount = Number(rows[idx].used_count || 0);
    if (usedCount > 0)
      return errResponse(
        "لا يمكن حذف دفتر تم استخدام " + usedCount + " شيك منه",
      );

    var sheet = getSheet("ChequeBooks", ACCOUNTING_HR_HEADERS.ChequeBooks);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var statusCol = headers.indexOf("status");
    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("DELETED");

    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "ChequeBooks",
      record_id: id,
      details: "حذف دفتر شيكات: " + rows[idx].code});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف دفتر الشيكات بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف دفتر الشيكات: " + e.message);
  }
}

/**
 * _reserveNextChequeNumber — [للاستخدام في المرحلة 3: إدارة الشيكات]
 * يحجز أول رقم شيك متاح في دفتر معيّن ويزوّد used_count.
 * مش مستخدمة حالياً (لسه مفيش شاشة إصدار شيكات) — جاهزة لمرحلة إدارة الشيكات.
 */
function _reserveNextChequeNumber(chequeBookId, callerUser) {
  // [BUG-014-FIX-2026-07] قفل ذري حول قراءة used_count وكتابتها — نفس نمط
  // [C-03-FIX-2026-07] المستخدم في changeChequeStatus/approveTransferVoucher.
  // بدون القفل، نداءان متزامنان لإصدار شيك من نفس الدفتر يقدروا يقرأوا نفس
  // used_count القديم قبل ما أي واحد يكتب القيمة الجديدة، فيتولد نفس رقم
  // الشيك التالي مرتين — وهو رقم هيتكتب فعليًا على ورقة شيك حقيقية.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    throw new Error("النظام مشغول بحجز رقم شيك آخر من نفس الدفتر، حاول مرة أخرى");
  }
  try {
    var sheet = getSheet("ChequeBooks", ACCOUNTING_HR_HEADERS.ChequeBooks);
    var rows = readSheet("ChequeBooks", ACCOUNTING_HR_HEADERS.ChequeBooks, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === chequeBookId;
    });
    if (idx === -1) throw new Error("دفتر الشيكات غير موجود");
    var book = rows[idx];
    var total = Number(book.total_count || 0);
    var used = Number(book.used_count || 0);
    if (book.status !== "ACTIVE" || used >= total)
      throw new Error("دفتر الشيكات منتهي أو غير نشط");
    var nextNumber = Number(book.first_number) + used;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var usedCol = headers.indexOf("used_count");
    sheet.getRange(rowNum, usedCol + 1).setValue(used + 1);
    return { number: nextNumber, bookId: chequeBookId };
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-04C  Accounting — Cheque Management (إدارة الشيكات) — Banking Module Phase 3
// ═══════════════════════════════════════════════════════════════════════════════
// ملاحظات نطاق المرحلة:
// - [محدّث بعد المرحلة 5] party_type/party_id بقوا مربوطين فعليًا بجدول
//   العملاء/الموردين (مستخدمين في أكثر من 15 موضع بالملف ده)؛ part_name
//   لسه بيتحفظ كنص حر كـ fallback للشيكات القديمة اللي اتسجلت قبل الربط.
// - القيود المحاسبية التلقائية (المرحلة 6) بقت مفعّلة — راجع §EXT-04E تحت
//   (_autoJournalFromChequeCollection)، بتُستدعى من changeChequeStatus لحظة
//   الوصول لحالة COLLECTED فقط (مفيش قيد عند الاستلام/الإصدار نفسه).
// - دورة حياة الحالة (PENDING → COLLECTED/BOUNCED/CANCELLED، وBOUNCED → ...)
//   اتنقلت بالكامل لـ §EXT-04D تحت — addCheque/updateCheque هنا بيتعاملوا بس
//   مع إنشاء الشيك وتعديل بياناته الأساسية وقت ما يكون لسه PENDING.

// [CHQ-WORKFLOW-V2 — Phase 1] إضافة حالات جديدة تمثل عُقد "دورة حياة الورقة
// المالية" الموسّعة (الشاشة الجديدة اللي هتحل محل شاشة الشيكات — تُبنى في
// Phase 2). الحالات القديمة (PENDING/COLLECTED/BOUNCED/CANCELLED/REPLACED)
// فضلت زي ما هي بدون أي حذف أو إعادة تسمية — الشيكات الحالية والشاشة الحالية
// (11_JS_Accounting.html) هتفضل شغالة بيها 100% لحد ما نوصل Phase 2 ونعمل
// التحويل والـ migration الكامل. الحالات الجديدة دلوقتي مُضافة وشغالة فعليًا
// في الـ state machine (انظر CHEQUE_INCOMING_WORKFLOW_TRANSITIONS/
// CHEQUE_OUTGOING_WORKFLOW_TRANSITIONS تحت) لكن محدش بينادي عليها لسه غير
// اختبارات مباشرة، لحد ما تُبنى الشاشة الجديدة.
var CHEQUE_STATUSES = [
  // ── الحالات القديمة (لسه شغالة زي ما هي) ──
  "PENDING",
  "COLLECTED",
  "BOUNCED",
  "CANCELLED",
  "REPLACED",
  // ── حالات الأوراق الواردة الجديدة ──
  "RECEIVED",
  "DEPOSITED_FOR_COLLECTION",
  "ENDORSED",
  "RETURNED",
  "RETURNED_TO_OWNER",
  "CASHED",
  // ── حالات الأوراق الصادرة الجديدة ──
  "DRAFTED",
  "PAID",
  "RETURNED_OUT",
];
var CHEQUE_TYPES = ["INCOMING", "OUTGOING"];

// [CHQ-WORKFLOW-V2 — Phase 2: التبديل النهائي] الحالة الابتدائية الفعلية لأي
// شيك جديد بقت type-aware (RECEIVED للوارد، DRAFTED للصادر) بدل PENDING
// المسطّحة القديمة. PENDING فضلت موجودة في CHEQUE_STATUSES وخرائط الانتقالات
// كـ"حالة إرث" فقط — بتتعرض وتتحرك زي ما هي لأي شيك قديم لسه ماتهاجرش
// (migrateChequeLegacyPendingStatuses تحت)، لكن مفيش شيك جديد هيتعمل بيها
// تاني، ومفيش انتقال في الـ state machine بيرجّع لها بعد النهاردة.
function _chequeInitialStatusFor(chequeType) {
  return chequeType === "OUTGOING" ? "DRAFTED" : "RECEIVED";
}

/** بيرجع true لو الحالة الحالية بتُعتبر لسه في "نقطة الدخول" القابلة للتعديل/
 * الحذف — إما الحالة الجديدة الصحيحة لنوع الشيك، أو PENDING القديمة (إرث). */
function _chequeIsInitialStatus(chequeType, status) {
  return status === "PENDING" || status === _chequeInitialStatusFor(chequeType);
}

function getCheques(callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewCheques"); // [RBAC-FIX]
    var rows = readSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return r.status !== "DELETED";
    });
    try {
      var bankAccMap = {};
      readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts, {
        trimStrings: true,
      }).forEach(function (a) {
        bankAccMap[a.id] = a;
      });
      var banksMap = {};
      readSheet("Banks", ACCOUNTING_HR_HEADERS.Banks, {
        trimStrings: true,
      }).forEach(function (b) {
        banksMap[b.id] = b;
      });
      var booksMap = {};
      readSheet("ChequeBooks", ACCOUNTING_HR_HEADERS.ChequeBooks, {
        trimStrings: true,
      }).forEach(function (b) {
        booksMap[b.id] = b;
      });
      var chequesMap = {};
      rows.forEach(function (r) {
        chequesMap[r.id] = r;
      });
      rows.forEach(function (r) {
        var acc = bankAccMap[r.bank_account_id];
        r.bank_account_name = acc ? acc.name : "";
        r.bank_account_code = acc ? acc.code : "";
        // لو الشيك مش له بنك متسجل مباشرة (الحالة الشائعة في الصادر) خد بنك الحساب
        var bankId = r.bank_id || (acc ? acc.bank_id : "");
        var bank = bankId ? banksMap[bankId] : null;
        r.bank_name = bank ? bank.name : "";
        var book = r.cheque_book_id ? booksMap[r.cheque_book_id] : null;
        r.cheque_book_code = book ? book.code : "";
        // ── Phase 4: روابط سلسلة الاستبدال (لو موجودة) ──
        if (r.replaces_cheque_id && chequesMap[r.replaces_cheque_id]) {
          r.replaces_cheque_number =
            chequesMap[r.replaces_cheque_id].cheque_number;
        }
        if (r.replaced_by_cheque_id && chequesMap[r.replaced_by_cheque_id]) {
          r.replaced_by_cheque_number =
            chequesMap[r.replaced_by_cheque_id].cheque_number;
        }
      });
    } catch (joinErr) {
      Logger.log("[getCheques] فشل إثراء البيانات: " + joinErr.message);
    }
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب الشيكات: " + e.message);
  }
}

function addCheque(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addCheque",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var type = data.type;
    if (CHEQUE_TYPES.indexOf(type) === -1)
      return errResponse("نوع الشيك يجب أن يكون وارد أو صادر");

    var amount = Number(data.amount);
    if (!ValidationEngine.isPositive(amount))
      return errResponse("قيمة الشيك مطلوبة ويجب أن تكون أكبر من صفر");

    if (!ValidationEngine.isRequired(data.party_name))
      return errResponse(
        type === "INCOMING" ? "اسم الساحب مطلوب" : "اسم المستفيد مطلوب",
      );

    if (!ValidationEngine.isRequired(data.due_date)) return errResponse("تاريخ الاستحقاق مطلوب");

    var chequeBook = null;
    var bankAccountId = data.bank_account_id || "";
    var chequeNumber = data.cheque_number
      ? String(data.cheque_number).trim()
      : "";

    if (type === "OUTGOING") {
      // الشيكات الصادرة لازم تتسحب من دفتر شيكاتنا (لو متاح) — الرقم بيتولد تلقائي
      if (data.cheque_book_id) {
        var books = readSheet(
          "ChequeBooks",
          ACCOUNTING_HR_HEADERS.ChequeBooks,
          { trimStrings: true },
        );
        chequeBook = books.find(function (b) {
          return b.id === data.cheque_book_id;
        });
        if (!chequeBook) return errResponse("دفتر الشيكات غير موجود");
        bankAccountId = chequeBook.bank_account_id; // الحساب البنكي مأخوذ من الدفتر دايماً
        try {
          var reserved = _reserveNextChequeNumber(
            chequeBook.id,
            data.callerUser,
          );
          chequeNumber = String(reserved.number);
        } catch (reserveErr) {
          return errResponse(reserveErr.message);
        }
      } else if (!chequeNumber) {
        return errResponse(
          "رقم الشيك مطلوب (أو اختر دفتر شيكات ليتولد تلقائياً)",
        );
      }
      if (!ValidationEngine.isRequired(bankAccountId))
        return errResponse("الحساب البنكي مطلوب للشيك الصادر");
    } else {
      // INCOMING — رقم الشيك بييجي من الشيك الورقي اللي استلمناه (نص حر)
      if (!ValidationEngine.isRequired(chequeNumber)) return errResponse("رقم الشيك مطلوب");
    }

    // فحص تكرار رقم الشيك لنفس الحساب البنكي (تحذيري — يمنع خطأ إدخال شائع)
    if (bankAccountId && chequeNumber) {
      var dup = readSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques, {
        trimStrings: true,
      }).find(function (c) {
        return (
          c.status !== "DELETED" &&
          String(c.bank_account_id) === String(bankAccountId) &&
          String(c.cheque_number) === String(chequeNumber) &&
          c.type === type
        );
      });
      if (dup)
        return errResponse("رقم الشيك ده مسجل بالفعل على نفس الحساب البنكي");
    }

    var id = makeId("CHQ");
    var now = new Date().toISOString();
    // [P5] حماية اتساق party_id/party_type — مايتسجلش party_id إلا لو
    // الطرف فعلاً عميل أو مورد (يمنع بيانات متضاربة لو حصل خلل بالفرونت).
    var partyType = data.party_type || "OTHER";
    var partyId =
      partyType === "CUSTOMER" || partyType === "SUPPLIER"
        ? data.party_id || ""
        : "";
    var row = [
      id,
      data.code || "CHQ-" + chequeNumber,
      type,
      bankAccountId,
      chequeBook ? chequeBook.id : "",
      chequeNumber,
      data.bank_id || "",
      partyType,
      partyId,
      String(data.party_name).trim(),
      amount,
      data.currency || "EGP",
      data.issue_date || now.split("T")[0],
      data.due_date,
      _chequeInitialStatusFor(type),
      data.notes || "",
      now,
      data.callerUser,
      now,
      data.callerUser,
      "", // replaces_cheque_id — يتحدد فقط للشيكات البديلة (عبر changeChequeStatus)
      "", // replaced_by_cheque_id
    ];
    var sheet = getSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques);
    _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.Cheques, row);

    AuditEngine.log("ADD", {
      user: data.callerUser,
      table: "Cheques",
      record_id: id,
      details:
        (type === "INCOMING" ? "إضافة شيك وارد رقم " : "إضافة شيك صادر رقم ") +
        chequeNumber +
        " بقيمة " +
        amount,
      newValue: data});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إضافة الشيك بنجاح", {
      id: id,
      cheque_number: chequeNumber,
    });
  } catch (e) {
    return errResponse("خطأ في إضافة الشيك: " + e.message);
  }
}

function updateCheque(id, data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateCheque",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques);
    var rows = readSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الشيك غير موجود");
    var before = rows[idx];
    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var updates = {};

    // [P3] بعد ما الشيك يتحصّل/يرتد/يتلغي — البيانات الجوهرية بتتقفل،
    // الملاحظات بس اللي تفضل قابلة للتعديل (نفس نمط دفاتر الشيكات).
    // [CHQ-WORKFLOW-V2 — التبديل النهائي] "نقطة الدخول القابلة للتعديل" بقت
    // type-aware (RECEIVED/DRAFTED) بدل PENDING بس — مع فضل قبول PENDING
    // كحالة إرث لأي شيك قديم لسه ماتهاجرش.
    var isLocked = !_chequeIsInitialStatus(before.type, before.status);
    var coreFields = [
      "amount",
      "party_name",
      "party_type",
      "party_id",
      "due_date",
      "issue_date",
      "bank_id",
    ];
    var triedCoreEdit = coreFields.some(function (f) {
      return data[f] !== undefined;
    });
    if (isLocked && triedCoreEdit)
      return errResponse(
        "لا يمكن تعديل بيانات الشيك الأساسية بعد تغيير حالته من (تحت التحصيل)",
      );

    if (!isLocked) {
      if (data.amount !== undefined) {
        var amt = Number(data.amount);
        if (!ValidationEngine.isPositive(amt)) return errResponse("قيمة الشيك غير صحيحة");
        updates.amount = amt;
      }
      if (data.party_name !== undefined) {
        if (!ValidationEngine.isRequired(data.party_name))
          return errResponse("اسم الطرف مطلوب");
        updates.party_name = String(data.party_name).trim();
      }
      if (data.party_type !== undefined) updates.party_type = data.party_type;
      // [P5] party_id — معرّف العميل/المورد المرتبط (لو الاسم طابق سجل
      // موجود فعلاً)؛ ييجي فاضي "" لو الطرف "أخرى" أو الاسم نص حر مايطابقش
      // أي سجل، بدون ما يمنع حفظ باقي بيانات الشيك.
      if (data.party_id !== undefined) {
        var effectivePartyType =
          updates.party_type !== undefined
            ? updates.party_type
            : before.party_type;
        updates.party_id =
          effectivePartyType === "CUSTOMER" || effectivePartyType === "SUPPLIER"
            ? data.party_id || ""
            : "";
      }
      if (data.due_date !== undefined) updates.due_date = data.due_date;
      if (data.issue_date !== undefined) updates.issue_date = data.issue_date;
      if (data.bank_id !== undefined) updates.bank_id = data.bank_id;
    }
    if (data.notes !== undefined) updates.notes = data.notes;

    // [P4] تغيير الحالة (تحصيل/ارتداد/إلغاء/استبدال...) بقى مسؤولية
    // دالة changeChequeStatus المخصصة (state machine + Timeline) بدل
    // ما يتغير زي أي حقل عادي هنا — أوضح في الـ audit وأأمن ضد تخطي القواعد.
    if (data.status !== undefined && data.status !== before.status) {
      return errResponse(
        "لتغيير حالة الشيك استخدم إجراءات دورة الحياة (تحصيل/ارتداد/إلغاء/استبدال)",
      );
    }

    updates.updated_at = new Date().toISOString();
    updates.updated_by = data.callerUser;

    _applyRowUpdates(sheet, rowNum, headers, updates);

    AuditEngine.log("UPDATE", {
      user: data.callerUser,
      table: "Cheques",
      record_id: id,
      details: "تعديل شيك: " + before.cheque_number,
      oldValue: _diffObjects(before, updates).old,
      newValue: _diffObjects(before, updates).new});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم تحديث الشيك بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث الشيك: " + e.message);
  }
}

function deleteCheque(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "deleteCheque", sessionToken);
    if (_permErr) return _permErr;

    var rows = readSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الشيك غير موجود");

    if (!_chequeIsInitialStatus(rows[idx].type, rows[idx].status))
      return errResponse("لا يمكن حذف شيك تم تحصيله أو ارتد أو أُلغي بالفعل");

    // [ملاحظة] لو الشيك صادر من دفتر، رقمه بيفضل "مستخدم" في الدفتر حتى
    // بعد الحذف (مش بنرجّع used_count) — نفس منطق الشيكات الورقية الموقوفة:
    // الرقم اتسحب فعلياً ومينفعش يتعاد استخدامه لشيك تاني.
    var sheet = getSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var statusCol = headers.indexOf("status");
    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("DELETED");

    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "Cheques",
      record_id: id,
      details: "حذف شيك: " + rows[idx].cheque_number});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف الشيك بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف الشيك: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-04D  Accounting — Cheque Lifecycle (دورة حياة الشيكات) — Banking Module Phase 4
// ═══════════════════════════════════════════════════════════════════════════════
// ملاحظات نطاق المرحلة:
// - state machine صريحة لانتقالات حالة الشيك (CHEQUE_TRANSITIONS) — أي انتقال
//   مش موجود في القائمة بيترفض برسالة واضحة. الحالات النهائية (COLLECTED/
//   CANCELLED/REPLACED) قافلة تماماً زي ما كانت في المرحلة 3.
// - BOUNCED → PENDING: "إعادة إيداع" نفس الشيك (الشيك اتقدّم تاني للبنك).
// - BOUNCED → REPLACED: إصدار شيك بديل. بيتعمل شيك جديد فعلي مرتبط بالأصلي عبر
//   replaces_cheque_id/replaced_by_cheque_id، وبيستخدم _reserveNextChequeNumber
//   لو الشيك الأصلي صادر من دفتر (نفس الدالة الجاهزة من المرحلة 2/3 — بدون أي
//   منطق حجز جديد). الشيك الأصلي يتقفل بحالة REPLACED ومايتلغيش رقمه من
//   الدفتر (نفس فلسفة عدم استرجاع used_count في deleteCheque).
// - Timeline الشيك = سجلات AuditLog بفلتر table=Cheques و record_id=معرّف
//   الشيك (getChequeTimeline) — نفس الخطة المنصوص عليها في تقرير المرحلة 3،
//   بدون أي جدول جديد أو تعديل على _writeAuditLog.
// - المرحلة 6: قيد محاسبي تلقائي واحد بس — لحظة COLLECTED (تحصيل وارد ضمن
//   حساب بنكي، أو صرف صادر من حساب بنكي). الاستلام/الإصدار (PENDING)،
//   الارتداد (BOUNCED)، الإلغاء (CANCELLED) كل دول بدون أي أثر نقدي فعلي طول
//   ما الشيك لسه ماتحصّلش، فمفيش قيد يتعمل أو يُعكس وقتهم. وبالتالي مفيش
//   حاجة لعكس قيد عند الارتداد لأنه أصلاً ماكان فيه قيد من الأساس (نفس مبدأ
//   الاستحقاق النقدي المطبّق في سندات القبض/الصرف). تفاصيل الدالة في §EXT-04E.

var CHEQUE_TRANSITIONS = {
  PENDING: ["COLLECTED", "BOUNCED", "CANCELLED"],
  BOUNCED: ["PENDING", "CANCELLED", "REPLACED"],
  COLLECTED: [],
  CANCELLED: [],
  REPLACED: [],
};

// [CHQ-WORKFLOW-V2 — Phase 1] state machine جديدة حسب اتجاه الورقة، تمثل
// عُقد الرسمة (الأوراق الواردة/الصادرة) بالظبط. مبنية "فوق" الحالات القديمة
// مش بدالها — PENDING/BOUNCED لسه بيوصلوا لنفس الحالات القديمة (COLLECTED/
// CANCELLED) عشان أي شيك حالي أو قديم يفضل شغال بدون أي كسر، وفي نفس الوقت
// بقى ممكن للشيك يتحرك على العُقد الجديدة (RECEIVED→DEPOSITED_FOR_COLLECTION
// →CASHED، إلخ).
// [تحديث] التبديل الكامل لاستخدام الحالات الجديدة فقط كحالة ابتدائية تم فعلاً:
// addCheque بقى يستخدم _chequeInitialStatusFor(type) (RECEIVED/DRAFTED) بدل
// PENDING لأي شيك جديد، وBOUNCED بقى بيرجّع لنفس الحالة الجديدة مش القديمة.
// [COA-V2 CLEANUP-2026-08] migrateChequeLegacyPendingStatuses() تم حذفها —
// كانت one-time migration للشيكات القديمة اللي حالتها PENDING، خلصت شغلها.
// PENDING فضلت مقبولة ومدعومة بالكامل في كل الخرائط والتحقق (fallback إرث
// لأي صف قديم لو ظهر مستقبلاً).
var CHEQUE_INCOMING_WORKFLOW_TRANSITIONS = {
  // PENDING = نقطة دخول قديمة، بتساوي RECEIVED فعليًا لأي شيك وارد حالي
  PENDING: [
    "DEPOSITED_FOR_COLLECTION",
    "ENDORSED",
    "COLLECTED",
    "BOUNCED",
    "CANCELLED",
  ],
  RECEIVED: ["DEPOSITED_FOR_COLLECTION", "ENDORSED", "CANCELLED"],
  DEPOSITED_FOR_COLLECTION: ["CASHED", "RETURNED"],
  ENDORSED: ["RETURNED"],
  RETURNED: ["RETURNED_TO_OWNER", "REPLACED"],
  RETURNED_TO_OWNER: [],
  CASHED: [],
  // [CHQ-WORKFLOW-V2 — التبديل النهائي] "إعادة إيداع" شيك ارتد بترجّعه لعقدة
  // RECEIVED الجديدة (مش PENDING القديمة) — أي شيك يترتد من دلوقتي هيدخل تاني
  // دورة الحياة الجديدة بحالتها الصحيحة. PENDING فضلت مقبولة كحالة دخول لأي
  // شيك قديم لسه ماتهاجرش (fromStatus يبقى PENDING أصلاً في السطر فوق).
  BOUNCED: ["RECEIVED", "CANCELLED", "REPLACED"],
  COLLECTED: [],
  CANCELLED: [],
  REPLACED: [],
};

var CHEQUE_OUTGOING_WORKFLOW_TRANSITIONS = {
  // PENDING = نقطة دخول قديمة، بتساوي DRAFTED فعليًا لأي شيك صادر حالي
  PENDING: ["PAID", "RETURNED_OUT", "COLLECTED", "BOUNCED", "CANCELLED"],
  DRAFTED: ["PAID", "RETURNED_OUT", "CANCELLED"],
  RETURNED_OUT: ["DRAFTED", "CANCELLED", "REPLACED"],
  PAID: [],
  // [CHQ-WORKFLOW-V2 — التبديل النهائي] نفس المنطق فوق — إعادة الإيداع بترجّع
  // لعقدة DRAFTED الجديدة بدل PENDING القديمة.
  BOUNCED: ["DRAFTED", "CANCELLED", "REPLACED"],
  COLLECTED: [],
  CANCELLED: [],
  REPLACED: [],
};

/** بيرجع خريطة الانتقالات المناسبة حسب نوع الشيك (وارد/صادر)، مع fallback
 * للخريطة القديمة المسطّحة لو النوع مش معروف لأي سبب — أمان إضافي بدون تغيير
 * سلوك أي كود قديم بينادي على CHEQUE_TRANSITIONS مباشرة. */
function _chequeWorkflowTransitionsFor(chequeType) {
  if (chequeType === "INCOMING") return CHEQUE_INCOMING_WORKFLOW_TRANSITIONS;
  if (chequeType === "OUTGOING") return CHEQUE_OUTGOING_WORKFLOW_TRANSITIONS;
  return CHEQUE_TRANSITIONS;
}

var CHEQUE_STATUS_LABELS = {
  // ── القديمة ──
  PENDING: "تحت التحصيل",
  COLLECTED: "تم التحصيل",
  BOUNCED: "مرتد",
  CANCELLED: "ملغي",
  REPLACED: "تم استبداله",
  // ── واردة جديدة ──
  RECEIVED: "تم الاستلام",
  DEPOSITED_FOR_COLLECTION: "إيداع للتحصيل",
  ENDORSED: "مظهّر لطرف آخر",
  RETURNED: "مرتجع",
  RETURNED_TO_OWNER: "تم رده لمالكه",
  CASHED: "تم الصرف",
  // ── صادرة جديدة ──
  DRAFTED: "محرَّر",
  PAID: "تم الصرف",
  RETURNED_OUT: "مرتجع",
};

// ───────────────────────────────────────────────────────────────────────────
// §CHQ-MIGRATION  ترحيل الشيكات القديمة (PENDING) للحالة الابتدائية الجديدة
// ───────────────────────────────────────────────────────────────────────────
/**
 * migrateChequeLegacyPendingStatuses — Migration مرة واحدة، تُشغَّل يدويًا من
 * محرر Apps Script (نفس فلسفة migratePhase2 في Code_Accounting_ChartOfAccounts.gs).
 *
 * بتحوّل كل شيك لسه status = "PENDING" فعليًا في شيت Cheques لحالته الابتدائية
 * الصحيحة الجديدة حسب نوعه: RECEIVED للوارد، DRAFTED للصادر — عن طريق
 * _chequeInitialStatusFor(type) بالظبط (نفس المنطق المستخدم في addCheque
 * للشيكات الجديدة من دلوقتي)، عشان الشاشة الجديدة والقديمة يبقوا شغالين
 * بنفس الحالات الحقيقية بدون أي دمج بصري مؤقت (legacyKeys) لازم بعد كده.
 *
 * آمنة: بتتجاهل أي شيك DELETED، بتسجل كل تغيير في AuditLog، وممكن تتشغل أكتر
 * من مرة من غير خطر (idempotent — تاني تشغيلة مش هتلاقي أي PENDING تحوّلها).
 *
 * [COA-V2 CLEANUP-2026-08] الدالة نفسها اتحذفت — راجع الملاحظة أعلى الملف.
 */

/**
 * changeChequeStatus — الدالة الوحيدة المسموح بها لتغيير حالة الشيك.
 * data: { new_status, reason (اختياري), replacement: {...} (لازم بس لـ REPLACED),
 *         callerUser, sessionToken }
 */
function changeChequeStatus(id, data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "changeChequeStatus",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    // [C-03-FIX-2026-07] قفل ذري يحمي تسلسل قراءة-الحالة/تحقّق/تعديل/قيد
    // من تعارض ضغطتين متزامنتين (نفس نمط approveReceiptVoucher) — كان
    // مفقوداً بالكامل، وسبق أن أُصلح نفس النمط في السندات المالية.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية أخرى على هذا الشيك، حاول مرة أخرى");
    }
    try {
    var newStatus = data.new_status;
    if (CHEQUE_STATUSES.indexOf(newStatus) === -1)
      return errResponse("حالة غير صحيحة");

    var sheet = getSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques);
    var rows = readSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الشيك غير موجود");
    var before = rows[idx];
    var fromStatus = before.status;

    var allowed = _chequeWorkflowTransitionsFor(before.type)[fromStatus] || [];
    if (allowed.indexOf(newStatus) === -1) {
      return errResponse(
        "لا يمكن تغيير حالة الشيك من (" +
          (CHEQUE_STATUS_LABELS[fromStatus] || fromStatus) +
          ") إلى (" +
          (CHEQUE_STATUS_LABELS[newStatus] || newStatus) +
          ")",
      );
    }

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var now = new Date().toISOString();
    var updates = {
      status: newStatus,
      updated_at: now,
      updated_by: data.callerUser,
    };

    // إلحاق سبب التغيير بالملاحظات — السجل التفصيلي الكامل موجود في AuditLog
    // (Timeline)، وده بس ملخص سريع يظهر في شاشة بيانات الشيك نفسها.
    if (data.reason && String(data.reason).trim()) {
      var reasonNote =
        "[" +
        (CHEQUE_STATUS_LABELS[newStatus] || newStatus) +
        " — " +
        now.split("T")[0] +
        "] " +
        String(data.reason).trim();
      updates.notes = before.notes
        ? before.notes + "\n" + reasonNote
        : reasonNote;
    }

    var replacementInfo = null;
    if (newStatus === "REPLACED") {
      var repl = data.replacement || {};
      if (!ValidationEngine.isRequired(repl.due_date))
        return errResponse("تاريخ استحقاق الشيك البديل مطلوب");
      var replAmount =
        repl.amount !== undefined && repl.amount !== null && repl.amount !== ""
          ? Number(repl.amount)
          : Number(before.amount);
      if (!ValidationEngine.isPositive(replAmount))
        return errResponse("قيمة الشيك البديل غير صحيحة");

      var replType = before.type;
      var replBankAccountId = "";
      var replChequeNumber = "";
      var replChequeBookId = "";

      if (replType === "OUTGOING") {
        if (repl.cheque_book_id) {
          var books = readSheet(
            "ChequeBooks",
            ACCOUNTING_HR_HEADERS.ChequeBooks,
            { trimStrings: true },
          );
          var book = books.find(function (b) {
            return b.id === repl.cheque_book_id;
          });
          if (!book) return errResponse("دفتر الشيكات غير موجود");
          replChequeBookId = book.id;
          replBankAccountId = book.bank_account_id;
          try {
            var reserved = _reserveNextChequeNumber(book.id, data.callerUser);
            replChequeNumber = String(reserved.number);
          } catch (reserveErr) {
            return errResponse(reserveErr.message);
          }
        } else {
          replChequeNumber = repl.cheque_number
            ? String(repl.cheque_number).trim()
            : "";
          replBankAccountId =
            repl.bank_account_id || before.bank_account_id || "";
          if (!replChequeNumber)
            return errResponse("رقم الشيك البديل مطلوب (أو اختر دفتر شيكات)");
          if (!replBankAccountId)
            return errResponse("الحساب البنكي مطلوب للشيك البديل");
        }
      } else {
        // INCOMING — شيك بديل من نفس الطرف (نص حر زي أي شيك وارد عادي)
        replChequeNumber = repl.cheque_number
          ? String(repl.cheque_number).trim()
          : "";
        if (!ValidationEngine.isRequired(replChequeNumber)) return errResponse("رقم الشيك البديل مطلوب");
        replBankAccountId =
          repl.bank_account_id || before.bank_account_id || "";
      }

      // فحص تكرار رقم الشيك البديل — نفس فحص addCheque
      if (replBankAccountId && replChequeNumber) {
        var dup = readSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques, {
          trimStrings: true,
        }).find(function (c) {
          return (
            c.status !== "DELETED" &&
            String(c.bank_account_id) === String(replBankAccountId) &&
            String(c.cheque_number) === String(replChequeNumber) &&
            c.type === replType
          );
        });
        if (dup)
          return errResponse(
            "رقم الشيك البديل مسجل بالفعل على نفس الحساب البنكي",
          );
      }

      var newId = makeId("CHQ");
      var newRow = [
        newId,
        "CHQ-" + replChequeNumber,
        replType,
        replBankAccountId,
        replChequeBookId,
        replChequeNumber,
        repl.bank_id || before.bank_id || "",
        before.party_type || "OTHER",
        before.party_id || "",
        before.party_name,
        replAmount,
        before.currency || "EGP",
        now.split("T")[0],
        repl.due_date,
        _chequeInitialStatusFor(replType),
        "شيك بديل عن الشيك المرتد رقم " + before.cheque_number,
        now,
        data.callerUser,
        now,
        data.callerUser,
        id, // replaces_cheque_id
        "", // replaced_by_cheque_id
      ];
      var chqSheet = getSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques);
      _appendRowProtected(chqSheet, ACCOUNTING_HR_HEADERS.Cheques, newRow);

      updates.replaced_by_cheque_id = newId;
      replacementInfo = { id: newId, cheque_number: replChequeNumber };

      AuditEngine.log("ADD", {
        user: data.callerUser,
        table: "Cheques",
        record_id: newId,
        details:
          "إصدار شيك بديل (" +
          replChequeNumber +
          ") عن الشيك المرتد " +
          before.cheque_number,
        newValue: {
          replaces_cheque_id: id,
          amount: replAmount,
          due_date: repl.due_date,
        }});
    }

    if (
      newStatus === "COLLECTED" ||
      newStatus === "CASHED" ||
      newStatus === "PAID"
    ) {
      // [PERIOD-CLOSING-2026-07] كان الملف بالكامل بدون أي فحص لقفل الفترة
      // (راجع تقرير المراجعة، المرحلة 3، ثغرة #4). الفحص هنا *قبل* أي كتابة
      // على حالة الشيك — بتاريخ اليوم لأن القيد التلقائي يُترحَّل بتاريخ
      // اليوم فعليًا (راجع _autoJournalFromChequeCollection)، فنتجنّب أن
      // يتغيّر الشيك لحالة "محصَّل" بينما يفشل القيد المقابل بصمت.
      var _periodErrChq = _blockIfPeriodClosed(
        new Date().toISOString().split("T")[0],
        "تحصيل/صرف الشيك",
      );
      if (_periodErrChq) return _periodErrChq;
    }

    _applyRowUpdates(sheet, rowNum, headers, updates);

    // [P6] القيد المحاسبي التلقائي — لحظة وصول الشيك لحالة "تحصيل/صرف نهائي"
    // فقط (الوحيدة اللي فيها حركة نقدية/بنكية فعلية). COLLECTED هي الحالة
    // القديمة (وارد وصادر مع بعض)، وCASHED/PAID هما نفس المعنى بالظبط في
    // نظام الحالات الجديد (CASHED = صرف شيك وارد محصَّل، PAID = صرف شيك
    // صادر) — [CHQ-WORKFLOW-V2 — Phase 1]. بيستخدم بيانات الشيك الأصلية
    // (before) لأن bank_account_id/party_*/amount مايتغيّروش هنا أصلاً.
    if (
      newStatus === "COLLECTED" ||
      newStatus === "CASHED" ||
      newStatus === "PAID"
    ) {
      try {
        _autoJournalFromChequeCollection(before, data.callerUser);
      } catch (je) {
        AuditEngine.log("AUTO_JOURNAL_FAILED", {
          user: data.callerUser || "SYSTEM",
          table: "JournalEntries",
          record_id: id,
          details:
            "فشل إنشاء قيد تلقائي لتحصيل شيك " +
            before.cheque_number +
            ": " +
            (je.message || "خطأ غير معروف")});
      }
    }

    AuditEngine.log("STATUS_CHANGE", {
      user: data.callerUser,
      table: "Cheques",
      record_id: id,
      details:
        "تغيير حالة شيك " +
        before.cheque_number +
        " من (" +
        (CHEQUE_STATUS_LABELS[fromStatus] || fromStatus) +
        ") إلى (" +
        (CHEQUE_STATUS_LABELS[newStatus] || newStatus) +
        ")" +
        (data.reason ? " — السبب: " + data.reason : ""),
      oldValue: { status: fromStatus },
      newValue: { status: newStatus }});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم تحديث حالة الشيك بنجاح", {
      status: newStatus,
      replacement: replacementInfo,
    });
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في تغيير حالة الشيك: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-04E  Accounting — Cheque Auto-Journal (القيود المحاسبية للشيكات)
// Banking Module Phase 6
// ═══════════════════════════════════════════════════════════════════════════════
// نفس فلسفة _autoJournalFromReceiptVoucher/_autoJournalFromPaymentVoucher
// بالحرف: بحث عن حساب خاص بالعميل/المورد (account_id) أولاً، ثم الرجوع لحساب
// الذمم العام (ar_account/ap_account) من إعدادات المحاسبة، ولو مفيش طرف
// مرتبط فعلياً (party_type=OTHER أو party_id فاضي — شيكات قديمة قبل المرحلة 5
// أو اسم نص حر مايطابقش عميل/مورد) → إيرادات/مصروفات متنوعة، تماماً زي
// الحالة "بدون طرف" في السندات.
//
// بيتنادى من changeChequeStatus لحظة الوصول لحالة COLLECTED فقط:
//   - INCOMING (شيك وارد تم تحصيله): مدين البنك (حساب الإيداع) | دائن ذمم
//     العميل (أو إيرادات متنوعة لو مفيش عميل مرتبط).
//   - OUTGOING (شيك صادر تم صرفه من حسابنا): مدين ذمم المورد (أو مصروفات
//     متنوعة لو مفيش مورد مرتبط) | دائن البنك (حساب السحب).
// مفيش قيد عند PENDING/BOUNCED/CANCELLED ومفيش حاجة لعكس أي قيد عندهم، لأن
// مفيش حركة نقدية فعلية حصلت أصلاً قبل التحصيل (نفس مبدأ الاستحقاق النقدي).
function _autoJournalFromChequeCollection(cheque, callerUser) {
  // ─── استخراج الحساب المحاسبي المرتبط بالحساب البنكي للشيك ───
  var bankAccountId = "";
  if (cheque.bank_account_id) {
    var banks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
    var bank = banks.find(function (b) {
      return b.id === cheque.bank_account_id;
    });
    if (bank) bankAccountId = bank.account_id;
  }
  if (!bankAccountId)
    throw new Error(
      "لا يوجد حساب محاسبي مرتبط بالحساب البنكي المحدد للشيك — لا يمكن ترحيل قيد التحصيل",
    );

  var accounts = readSheet(
    "ChartOfAccounts",
    ACCOUNTING_HR_HEADERS.ChartOfAccounts,
  );
  var amount = Number(cheque.amount);
  var lines, sourceType, description;

  if (cheque.type === "INCOMING") {
    // ─── شيك وارد تم تحصيله: مدين البنك | دائن ذمم العميل (أو إيرادات) ───
    var creditAccountId = "";
    var creditNotes = "";
    if (cheque.party_type === "CUSTOMER" && cheque.party_id) {
      var customers = readSheet("Customers", CUSTOMER_HEADERS);
      var custRec = customers.find(function (c) {
        return c.id === cheque.party_id;
      });
      var arResolved = resolvePostingAccount({
        accounts: accounts,
        key: "ar_account",
        type: "ASSET",
        hints: ["ذمم مدينة", "عملاء", "accounts receivable", "مدينين"],
        entityAccountId: custRec && custRec.account_id,
      });
      if (!arResolved.account)
        throw new Error(
          "لا يوجد حساب ذمم مدينة مناسب — يجب ضبط ar_account في إعدادات المحاسبة",
        );
      creditAccountId = arResolved.account.id;
      creditNotes =
        "تحصيل شيك من عميل: " + (cheque.party_name || cheque.party_id);
    } else {
      var revenueAccount = _getDefaultAccount(
        "revenue_account",
        accounts,
        "REVENUE",
        ["إيرادات المبيعات", "مبيعات", "إيرادات", "sales revenue"],
      );
      if (!revenueAccount)
        throw new Error("لا يوجد حساب إيرادات في دليل الحسابات");
      creditAccountId = revenueAccount.id;
      creditNotes = cheque.party_name || "إيرادات متنوعة";
    }

    sourceType = "CHEQUE_RECEIPT";
    description =
      "تحصيل شيك وارد رقم " +
      cheque.cheque_number +
      " — " +
      (cheque.party_name || "");
    lines = [
      {
        account_id: bankAccountId,
        debit: amount,
        credit: 0,
        notes: "تحصيل شيك بنكي",
      },
      {
        account_id: creditAccountId,
        debit: 0,
        credit: amount,
        notes: creditNotes,
        party_type: cheque.party_type || "NONE",
        party_id: cheque.party_id || "",
      },
    ];
  } else {
    // ─── شيك صادر تم صرفه من حسابنا: مدين ذمم المورد (أو مصروفات) | دائن البنك ───
    var debitAccountId = bankAccountId; // fallback لو مفيش حساب مورد/مصروفات مناسب
    var debitNotes = cheque.party_name || "مصروفات";
    if (cheque.party_type === "SUPPLIER" && cheque.party_id) {
      var suppliers = readSheet("Suppliers", SUPPLIER_HEADERS);
      var suppRec = suppliers.find(function (s) {
        return s.id === cheque.party_id;
      });
      var apResolved = resolvePostingAccount({
        accounts: accounts,
        key: "ap_account",
        type: "LIABILITY",
        hints: ["ذمم دائنة", "موردين", "accounts payable", "دائنة"],
        entityAccountId: suppRec && suppRec.account_id,
      });
      if (apResolved.account) {
        debitAccountId = apResolved.account.id;
        debitNotes = "صرف شيك لمورد: " + (cheque.party_name || cheque.party_id);
      }
    } else {
      // [ITEM-POSTING-WIRE-GAP-FIX-2026-08-08] كان بيختار عشوائياً "أول
      // حساب EXPENSE نشط" موجود في الشجرة (accounts.find بلا key ولا
      // hints ولا ترتيب محدد) — أي شيك صادر بدون مورد كان ممكن يترحّل
      // على أي حساب مصروف حسب ترتيب الصفوف في الشيت، بلا أي تحكم أو
      // إعداد من المستخدم. الحل: نفس نمط باقي الفروع — نستخدم مفتاح
      // ترحيل رسمي (general_expense_account) ونرفض الترحيل بوضوح لو
      // مش معرَّف، بدل اختيار عشوائي صامت.
      var expenseAcc = _getDefaultAccount(
        "general_expense_account",
        accounts,
        "EXPENSE",
        ["مصروفات عامة", "مصروفات متنوعة", "general expense", "misc expense"],
      );
      if (!expenseAcc)
        throw new Error(
          "لا يوجد حساب مصروفات عامة معرَّف (general_expense_account) — لا يمكن ترحيل صرف شيك بدون مورد محدد بدون ضبط هذا الحساب في إعدادات المحاسبة",
        );
      debitAccountId = expenseAcc.id;
      debitNotes = cheque.party_name || "مصروفات عامة";
    }

    sourceType = "CHEQUE_PAYMENT";
    description =
      "صرف شيك صادر رقم " +
      cheque.cheque_number +
      " — " +
      (cheque.party_name || "");
    lines = [
      {
        account_id: debitAccountId,
        debit: amount,
        credit: 0,
        notes: debitNotes,
        party_type: cheque.party_type || "NONE",
        party_id: cheque.party_id || "",
      },
      {
        account_id: bankAccountId,
        debit: 0,
        credit: amount,
        notes: "صرف شيك بنكي",
      },
    ];
  }

  var result = _addJournalEntryInternal({
    callerUser: callerUser || "SYSTEM",
    date: new Date().toISOString().split("T")[0],
    reference: cheque.code || cheque.id,
    source_type: sourceType,
    description: description,
    lines: lines,
  });

  if (!result || !result.success) {
    throw new Error(
      "فشل إنشاء القيد التلقائي لتحصيل/صرف الشيك: " +
        (result ? result.message : "خطأ غير معروف"),
    );
  }
}

/**
 * getChequeTimeline — سجل دورة حياة شيك معيّن (مستخرج من AuditLog بفلتر
 * table=Cheques و record_id=chequeId)، مرتب زمنياً من الأقدم للأحدث.
 */
function getChequeTimeline(chequeId, callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "viewCheques", sessionToken);
    if (_permErr) return _permErr;
    if (!ValidationEngine.isRequired(chequeId)) return errResponse("معرّف الشيك مطلوب");

    var sheet = getSheet("AuditLog", AUDIT_HEADERS);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { success: true, data: [] };

    var numRows = lastRow - 1;
    var raw = sheet.getRange(2, 1, numRows, AUDIT_HEADERS.length).getValues();
    var entries = raw
      .map(function (row) {
        var obj = {};
        AUDIT_HEADERS.forEach(function (h, i) {
          obj[h] = row[i] instanceof Date ? row[i].toISOString() : row[i];
        });
        return obj;
      })
      .filter(function (e) {
        return (
          e.table === "Cheques" && String(e.record_id) === String(chequeId)
        );
      });

    entries.sort(function (a, b) {
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    // فك old_value/new_value (JSON) عشان يبقوا سهلين للعرض في الفرونت
    entries.forEach(function (e) {
      try {
        e.old_value = e.old_value ? JSON.parse(e.old_value) : null;
      } catch (er) {
        /* تجاهل لو مش JSON صالح */
      }
      try {
        e.new_value = e.new_value ? JSON.parse(e.new_value) : null;
      } catch (er) {
        /* تجاهل لو مش JSON صالح */
      }
    });

    return { success: true, data: entries };
  } catch (e) {
    return errResponse("خطأ في جلب تايملاين الشيك: " + e.message);
  }
}

// ── [نُقل من §EXT-08 و §EXT-08B — Transfer Vouchers + Bank Reconciliation] ──

// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-08  Accounting — Transfer Vouchers (سندات التحويل)
// ═══════════════════════════════════════════════════════════════════════════════

function getTransferVouchers(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser)
      _requirePermission(opts.callerUser, "viewTransferVouchers"); // [RBAC-FIX]
    var rows = readSheet(
      "TransferVouchers",
      ACCOUNTING_HR_HEADERS.TransferVouchers,
      { trimStrings: true },
    );
    // [CB-05 FIX] استبعاد السندات المحذوفة (Soft Delete) من القوائم العادية
    rows = rows.filter(function (r) {
      return r.status !== "DELETED";
    });
    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });
    if (opts.from_date)
      rows = rows.filter(function (r) {
        return r.date >= opts.from_date;
      });
    if (opts.to_date)
      rows = rows.filter(function (r) {
        return r.date <= opts.to_date;
      });
    rows.sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });

    // [P7] إثراء البيانات بأسماء المصدر/الهدف الفعلية (خزينة أو حساب بنكي)
    // لعرضها بوضوح في الجدول بدل الـ id الخام — نفس فلسفة getCheques.
    try {
      var cashBoxMap = {};
      readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes, {
        trimStrings: true,
      }).forEach(function (b) {
        cashBoxMap[b.id] = b.name;
      });
      var bankAccMap2 = {};
      readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts, {
        trimStrings: true,
      }).forEach(function (b) {
        bankAccMap2[b.id] = b.name;
      });
      var nameOf = function (type, id) {
        return type === "CASHBOX"
          ? cashBoxMap[id] || ""
          : bankAccMap2[id] || "";
      };
      rows.forEach(function (r) {
        r.from_name = nameOf(r.from_type, r.from_id);
        r.to_name = nameOf(r.to_type, r.to_id);
      });
    } catch (joinErr) {
      Logger.log(
        "[getTransferVouchers] فشل إثراء البيانات: " + joinErr.message,
      );
    }

    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب سندات التحويل: " + e.message);
  }
}

function addTransferVoucher(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addTransferVoucher",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var _auditUser = data.callerUser;
    if (!data || !ValidationEngine.isRequired(data.date) || !ValidationEngine.isPositive(data.amount))
      return errResponse("التاريخ والمبلغ مطلوبان");
    if (!ValidationEngine.isRequired(data.from_id) || !ValidationEngine.isRequired(data.to_id))
      return errResponse("يجب تحديد المصدر والهدف");
    if (data.from_id === data.to_id && data.from_type === data.to_type)
      return errResponse("لا يمكن التحويل لنفس الحساب");

    // [P7] عمولة التحويل البنكي — اختيارية، بتُخصم من حساب المصدر زيادة على
    // المبلغ المحوَّل (المستفيد بياخد المبلغ بالكامل، والعمولة عليّنا كمصرف).
    var feeAmount = Number(data.fee_amount || 0);
    if (feeAmount < 0) return errResponse("قيمة العمولة غير صحيحة");
    var bankReference = data.bank_reference
      ? String(data.bank_reference).trim()
      : "";
    var totalDeduction = Number(data.amount) + feeAmount;

    // تحقق من الرصيد (المبلغ + العمولة معاً من حساب المصدر)
    if (data.from_type === "CASHBOX") {
      var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
      var box = cashBoxes.find(function (b) {
        return b.id === data.from_id;
      });
      if (box && Number(box.current_balance || 0) < totalDeduction)
        return errResponse("رصيد الخزنة المصدر غير كافي");
    } else if (data.from_type === "BANK") {
      var banks = readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts);
      var bank = banks.find(function (b) {
        return b.id === data.from_id;
      });
      if (bank && Number(bank.current_balance || 0) < totalDeduction)
        return errResponse("رصيد البنك المصدر غير كافي");
    }

    var id = makeId("TRF");
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]
    var voucherNum = _getNextVoucherNumber("TRF"); // [FIX-ISSUE-010]

    var row = [
      id,
      data.date,
      voucherNum,
      data.from_type,
      data.from_id,
      data.to_type,
      data.to_id,
      Number(data.amount),
      data.currency || "EGP",
      data.exchange_rate || 1,
      data.description || "",
      "DRAFT",
      user,
      now,
      "",
      "",
      feeAmount,
      bankReference,
    ];

    var _trfSheet = getSheet(
      "TransferVouchers",
      ACCOUNTING_HR_HEADERS.TransferVouchers,
    );
    _appendRowProtected(_trfSheet, ACCOUNTING_HR_HEADERS.TransferVouchers, row);
    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إنشاء سند التحويل بنجاح", {
      id: id,
      voucher_number: voucherNum,
    });
  } catch (e) {
    return errResponse("خطأ في إنشاء سند التحويل: " + e.message);
  }
}

function deleteTransferVoucher(id, callerUser, sessionToken) {
  // [CB-05 FIX] تحويل من Hard Delete إلى Soft Delete — لا يُحذف أي سجل مالي نهائياً
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    // [P5-B FIX] كانت تفحص صلاحية "deleteCashBox" بالخطأ بدل "deleteTransferVoucher" —
    // أي مستخدم له صلاحية حذف خزينة فقط (وليس حذف سندات تحويل) كان يستطيع حذف سندات تحويل
    var _permErr = _checkPermission(
      callerUser,
      "deleteTransferVoucher",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet(
      "TransferVouchers",
      ACCOUNTING_HR_HEADERS.TransferVouchers,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("سند التحويل غير موجود");

    var voucher = rows[idx];
    // [CB-05 FIX] منع حذف سندات معتمدة — يجب الإلغاء أولاً
    if (voucher.status === "APPROVED") {
      return errResponse(
        "لا يمكن حذف سند معتمد — استخدم إلغاء السند بدلاً من الحذف",
      );
    }

    var sheet = getSheet(
      "TransferVouchers",
      ACCOUNTING_HR_HEADERS.TransferVouchers,
    );
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var now = new Date().toISOString();

    // [CB-05 FIX] Soft Delete — تغيير الحالة بدلاً من حذف الصف
    var statusCol = headers.indexOf("status");
    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("DELETED");

    // تسجيل في Audit Log
    AuditEngine.log("SOFT_DELETE", {
      user: callerUser,
      table: "TransferVouchers",
      record_id: id,
      details: "حذف (ناعم) لسند تحويل رقم " + (voucher.voucher_number || id)});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف سند التحويل بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف سند التحويل: " + e.message);
  }
}

function approveTransferVoucher(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "approveTransferVoucher",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بعملية مالية أخرى، حاول مرة أخرى");
    }
    try {
      var rows = readSheet(
        "TransferVouchers",
        ACCOUNTING_HR_HEADERS.TransferVouchers,
        { trimStrings: true },
      );
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("سند التحويل غير موجود");
      if (rows[idx].status !== "DRAFT")
        return errResponse("لا يمكن اعتماد سند ليس مسودة");

      // [PERIOD-CLOSING-2026-07] فحص قفل الفترة المحاسبية — كان مفقوداً
      // في موديول البنوك بالكامل (راجع تقرير المراجعة، المرحلة 3، ثغرة #4).
      var _periodErrTV = _blockIfPeriodClosed(rows[idx].date, "سند التحويل");
      if (_periodErrTV) return _periodErrTV;

      var voucher = rows[idx];
      var feeAmount = Number(voucher.fee_amount || 0);
      var totalDeduction = Number(voucher.amount) + feeAmount;

      // تحقق من الرصيد (داخل القفل) — المبلغ + العمولة معاً من حساب المصدر
      if (voucher.from_type === "CASHBOX") {
        var cashBoxes = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
        var box = cashBoxes.find(function (b) {
          return b.id === voucher.from_id;
        });
        if (box && Number(box.current_balance || 0) < totalDeduction)
          return errResponse("رصيد الخزنة المصدر غير كافي");
      } else if (voucher.from_type === "BANK") {
        var banks = readSheet(
          "BankAccounts",
          ACCOUNTING_HR_HEADERS.BankAccounts,
        );
        var bank = banks.find(function (b) {
          return b.id === voucher.from_id;
        });
        if (bank && Number(bank.current_balance || 0) < totalDeduction)
          return errResponse("رصيد البنك المصدر غير كافي");
      }

      var sheet = getSheet(
        "TransferVouchers",
        ACCOUNTING_HR_HEADERS.TransferVouchers,
      );
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();
      var user =
        typeof _auditUser !== "undefined"
          ? _auditUser
          : typeof callerUser !== "undefined"
            ? callerUser
            : "system"; // [FIX-ISSUE-019]

      var statusCol = headers.indexOf("status");
      var approvedAtCol = headers.indexOf("approved_at");
      var approvedByCol = headers.indexOf("approved_by");
      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("APPROVED");
      if (approvedAtCol !== -1)
        sheet.getRange(rowNum, approvedAtCol + 1).setValue(now);
      if (approvedByCol !== -1)
        sheet.getRange(rowNum, approvedByCol + 1).setValue(user);

      // نقص من المصدر (المبلغ + العمولة معاً — العمولة مصرف علينا بالكامل)
      if (voucher.from_type === "CASHBOX") {
        _updateCashBoxBalance(voucher.from_id, -totalDeduction);
      } else {
        _updateBankAccountBalance(voucher.from_id, -totalDeduction);
      }

      // زيادة الهدف (المبلغ فقط — المستفيد بياخد المبلغ كامل بدون أي خصم)
      if (voucher.to_type === "CASHBOX") {
        _updateCashBoxBalance(voucher.to_id, Number(voucher.amount));
      } else {
        _updateBankAccountBalance(voucher.to_id, Number(voucher.amount));
      }

      // [INTEGRATED] Create auto-journal for transfer
      try {
        _autoJournalFromTransferVoucher(voucher, callerUser);
      } catch (je) {
        AuditEngine.log("AUTO_JOURNAL_FAILED", {
          user: callerUser || "SYSTEM",
          table: "JournalEntries",
          record_id: id,
          details:
            "فشل إنشاء قيد تلقائي لسند تحويل " +
            voucher.voucher_number +
            ": " +
            (je.message || "خطأ غير معروف")});
      }

      _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
      return okResponse("تم اعتماد سند التحويل بنجاح");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في اعتماد سند التحويل: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-08B  Accounting — Bank Reconciliation (المطابقة البنكية)
// Banking Module Phase 8
// ═══════════════════════════════════════════════════════════════════════════════
// فكرة الموديول: جلسة مطابقة واحدة = حساب بنكي + تاريخ كشف حساب. الجلسة
// بتحتوي على بنود كشف الحساب (BankStatementLines) — تُدخل يدوياً أو لصق دفعي
// — وبتتطابق (يدوي أو تلقائي) مع الحركات الفعلية المسجّلة فعلاً على نفس
// الحساب البنكي في النظام، واللي مصدرها 5 جداول مختلفة:
//   Cheques (COLLECTED) / TransferVouchers (APPROVED) / ReceiptVouchers
//   (APPROVED + BANK) / PaymentVouchers (APPROVED + BANK) / Expenses
//   (APPROVED + BANK).
// المطابقة نفسها لا تُنشئ أي قيد محاسبي ولا تُغيّر أي رصيد — هي أداة ضبط
// ومراجعة فقط (نفس فلسفة كشف حساب العميل/المورد، لكن للبنك).

var BANK_RECON_TX_TYPE_LABELS = {
  CHEQUE: "شيك",
  TRANSFER: "تحويل بنكي",
  RECEIPT: "سند قبض",
  PAYMENT: "سند صرف",
  EXPENSE: "مصروف",
};

/**
 * _collectBankTransactions — يجمع كل الحركات الفعلية المسجّلة على حساب بنكي
 * معيّن من كل المصادر الخمسة، في صيغة موحّدة:
 *   { type, id, date, description, reference, amount }
 * amount موجّه: موجب = إيداع/زيادة في رصيد البنك، سالب = سحب/نقص.
 * @param {string} bankAccountId
 * @param {string} [toDate] — استبعاد أي حركة بعد التاريخ ده (اختياري)
 */
function _collectBankTransactions(bankAccountId, toDate) {
  var out = [];
  if (!bankAccountId) return out;

  // ── Cheques (COLLECTED فقط — اللحظة الوحيدة اللي فيها حركة بنكية فعلية) ──
  try {
    readSheet("Cheques", ACCOUNTING_HR_HEADERS.Cheques, {
      trimStrings: true,
    }).forEach(function (c) {
      if (c.status !== "COLLECTED") return;
      if (String(c.bank_account_id) !== String(bankAccountId)) return;
      var d = (c.updated_at || c.due_date || "").toString().split("T")[0];
      if (toDate && d > toDate) return;
      out.push({
        type: "CHEQUE",
        id: c.id,
        date: d,
        description:
          (c.type === "INCOMING"
            ? "تحصيل شيك وارد رقم "
            : "صرف شيك صادر رقم ") +
          (c.cheque_number || "") +
          (c.party_name ? " — " + c.party_name : ""),
        reference: c.cheque_number || "",
        amount: c.type === "INCOMING" ? Number(c.amount) : -Number(c.amount),
      });
    });
  } catch (e) {
    Logger.log("_collectBankTransactions/Cheques: " + e.message);
  }

  // ── TransferVouchers (APPROVED فقط) ──
  try {
    readSheet("TransferVouchers", ACCOUNTING_HR_HEADERS.TransferVouchers, {
      trimStrings: true,
    }).forEach(function (t) {
      if (t.status !== "APPROVED") return;
      var d = (t.approved_at || t.date || "").toString().split("T")[0];
      if (toDate && d > toDate) return;
      var fee = Number(t.fee_amount || 0);
      if (
        t.from_type === "BANK" &&
        String(t.from_id) === String(bankAccountId)
      ) {
        out.push({
          type: "TRANSFER",
          id: t.id,
          date: d,
          description:
            "تحويل صادر (سند " +
            (t.voucher_number || t.id) +
            ")" +
            (fee ? " — شامل عمولة " + fee : ""),
          reference: t.bank_reference || t.voucher_number || "",
          amount: -(Number(t.amount) + fee),
        });
      }
      if (t.to_type === "BANK" && String(t.to_id) === String(bankAccountId)) {
        out.push({
          type: "TRANSFER",
          id: t.id,
          date: d,
          description: "تحويل وارد (سند " + (t.voucher_number || t.id) + ")",
          reference: t.bank_reference || t.voucher_number || "",
          amount: Number(t.amount),
        });
      }
    });
  } catch (e) {
    Logger.log("_collectBankTransactions/TransferVouchers: " + e.message);
  }

  // ── ReceiptVouchers (APPROVED + BANK فقط) ──
  try {
    readSheet("ReceiptVouchers", ACCOUNTING_HR_HEADERS.ReceiptVouchers, {
      trimStrings: true,
    }).forEach(function (r) {
      if (r.status !== "APPROVED" || r.payment_method !== "BANK") return;
      if (String(r.bank_account_id) !== String(bankAccountId)) return;
      var d = (r.approved_at || r.date || "").toString().split("T")[0];
      if (toDate && d > toDate) return;
      out.push({
        type: "RECEIPT",
        id: r.id,
        date: d,
        description:
          "سند قبض رقم " +
          (r.voucher_number || r.id) +
          (r.from_party ? " من " + r.from_party : ""),
        reference: r.voucher_number || "",
        amount: Number(r.amount),
      });
    });
  } catch (e) {
    Logger.log("_collectBankTransactions/ReceiptVouchers: " + e.message);
  }

  // ── PaymentVouchers (APPROVED + BANK فقط) ──
  try {
    readSheet("PaymentVouchers", ACCOUNTING_HR_HEADERS.PaymentVouchers, {
      trimStrings: true,
    }).forEach(function (p) {
      if (p.status !== "APPROVED" || p.payment_method !== "BANK") return;
      if (String(p.bank_account_id) !== String(bankAccountId)) return;
      var d = (p.approved_at || p.date || "").toString().split("T")[0];
      if (toDate && d > toDate) return;
      out.push({
        type: "PAYMENT",
        id: p.id,
        date: d,
        description:
          "سند صرف رقم " +
          (p.voucher_number || p.id) +
          (p.to_party ? " إلى " + p.to_party : ""),
        reference: p.voucher_number || "",
        amount: -Number(p.amount),
      });
    });
  } catch (e) {
    Logger.log("_collectBankTransactions/PaymentVouchers: " + e.message);
  }

  // ── Expenses (APPROVED + BANK فقط) ──
  try {
    readSheet("Expenses", ACCOUNTING_HR_HEADERS.Expenses, {
      trimStrings: true,
    }).forEach(function (x) {
      if (x.status !== "APPROVED" || x.payment_method !== "BANK") return;
      if (String(x.bank_account_id) !== String(bankAccountId)) return;
      var d = (x.approved_at || x.date || "").toString().split("T")[0];
      if (toDate && d > toDate) return;
      out.push({
        type: "EXPENSE",
        id: x.id,
        date: d,
        description:
          "مصروف رقم " +
          (x.voucher_number || x.id) +
          (x.description ? " — " + x.description : ""),
        reference: x.voucher_number || "",
        amount: -Number(x.amount),
      });
    });
  } catch (e) {
    Logger.log("_collectBankTransactions/Expenses: " + e.message);
  }

  out.sort(function (a, b) {
    return String(a.date).localeCompare(String(b.date));
  });
  return out;
}

/**
 * _getMatchedKeysForBankAccount — يبني Set بكل (type:id) سبق مطابقتها فعلاً
 * ضمن أي جلسة مطابقة غير محذوفة لنفس الحساب البنكي — يُستخدم لاستبعادها من
 * قوائم "الحركات غير المطابقة".
 */
function _getMatchedKeysForBankAccount(bankAccountId) {
  var map = {};
  try {
    var reconMap = {};
    readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      {
        trimStrings: true,
      },
    ).forEach(function (r) {
      reconMap[r.id] = r.status;
    });
    readSheet("BankStatementLines", ACCOUNTING_HR_HEADERS.BankStatementLines, {
      trimStrings: true,
    }).forEach(function (l) {
      if (String(l.bank_account_id) !== String(bankAccountId)) return;
      if (l.status !== "MATCHED" || !l.matched_type || !l.matched_id) return;
      // استبعاد بنود جلسات محذوفة — مطابقتها بقت بدون قيمة
      if (reconMap[l.reconciliation_id] === "DELETED") return;
      map[l.matched_type + ":" + l.matched_id] = l.reconciliation_id;
    });
  } catch (e) {
    Logger.log("_getMatchedKeysForBankAccount: " + e.message);
  }
  return map;
}

/**
 * getUnmatchedBankTransactions — الحركات الفعلية المسجّلة على حساب بنكي
 * ولسه ما اتطابقتش مع أي بند كشف حساب في أي جلسة (مفتوحة أو معتمدة).
 * تُستخدم في شاشة المطابقة لعرض "الحركات بانتظار المطابقة".
 */
function getUnmatchedBankTransactions(bankAccountId, asOfDate, callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewBankReconciliation"); // [RBAC-FIX]
    if (!ValidationEngine.isRequired(bankAccountId)) return errResponse("الحساب البنكي مطلوب");
    var all = _collectBankTransactions(bankAccountId, asOfDate || null);
    var matched = _getMatchedKeysForBankAccount(bankAccountId);
    var unmatched = all.filter(function (t) {
      return !matched[t.type + ":" + t.id];
    });
    return { success: true, data: unmatched };
  } catch (e) {
    return errResponse("خطأ في جلب الحركات غير المطابقة: " + e.message);
  }
}

/**
 * getBankReconciliations — قائمة جلسات المطابقة، مع إثراء باسم الحساب البنكي
 */
function getBankReconciliations(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser)
      _requirePermission(opts.callerUser, "viewBankReconciliation"); // [RBAC-FIX]
    var rows = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    );
    rows = rows.filter(function (r) {
      return r.status !== "DELETED";
    });
    if (opts.bank_account_id)
      rows = rows.filter(function (r) {
        return String(r.bank_account_id) === String(opts.bank_account_id);
      });
    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });
    rows.sort(function (a, b) {
      return String(b.statement_date).localeCompare(String(a.statement_date));
    });

    try {
      var bankAccMap = {};
      readSheet("BankAccounts", ACCOUNTING_HR_HEADERS.BankAccounts, {
        trimStrings: true,
      }).forEach(function (b) {
        bankAccMap[b.id] = b.name;
      });
      rows.forEach(function (r) {
        r.bank_account_name = bankAccMap[r.bank_account_id] || "";
      });
    } catch (joinErr) {
      Logger.log(
        "[getBankReconciliations] فشل إثراء البيانات: " + joinErr.message,
      );
    }

    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب جلسات المطابقة البنكية: " + e.message);
  }
}

/**
 * getBankReconciliationDetail — تفاصيل جلسة مطابقة واحدة: بيانات الجلسة +
 * بنود كشف الحساب + الحركات غير المطابقة المتاحة للمطابقة معها + ملخص أرقام.
 */
function getBankReconciliationDetail(id, callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewBankReconciliation"); // [RBAC-FIX]
    if (!ValidationEngine.isRequired(id)) return errResponse("معرف الجلسة مطلوب");
    var recon = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    ).find(function (r) {
      return r.id === id && r.status !== "DELETED";
    });
    if (!recon) return errResponse("جلسة المطابقة غير موجودة");

    var lines = readSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
      { trimStrings: true },
    )
      .filter(function (l) {
        return l.reconciliation_id === id;
      })
      .sort(function (a, b) {
        return String(a.line_date).localeCompare(String(b.line_date));
      });

    // إثراء البنود المطابقة بوصف الحركة الفعلية المرتبطة (لو موجودة)
    try {
      var allTx = _collectBankTransactions(recon.bank_account_id, null);
      var txMap = {};
      allTx.forEach(function (t) {
        txMap[t.type + ":" + t.id] = t;
      });
      lines.forEach(function (l) {
        if (l.status === "MATCHED" && l.matched_type && l.matched_id) {
          var tx = txMap[l.matched_type + ":" + l.matched_id];
          l.matched_description = tx ? tx.description : "";
          l.matched_type_label =
            BANK_RECON_TX_TYPE_LABELS[l.matched_type] || l.matched_type;
        }
      });
    } catch (e2) {
      Logger.log("[getBankReconciliationDetail] إثراء البنود: " + e2.message);
    }

    var unmatchedTx =
      getUnmatchedBankTransactions(recon.bank_account_id, null).data || [];
    // أضف حركات الجلسة دي نفسها المطابقة بالفعل (عشان لو فتح يشوفها ضمن
    // الخيارات لو عمل unmatch) — مش لازم هنا، الفرونت بيطلبها بشكل منفصل
    // عند الحاجة لإعادة المطابقة.

    var bankAcc = readSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
      {
        trimStrings: true,
      },
    ).find(function (b) {
      return b.id === recon.bank_account_id;
    });

    var matchedTotal = 0;
    lines.forEach(function (l) {
      if (l.status === "MATCHED") {
        matchedTotal += Number(l.credit || 0) - Number(l.debit || 0);
      }
    });
    var statementTotal = 0;
    lines.forEach(function (l) {
      statementTotal += Number(l.credit || 0) - Number(l.debit || 0);
    });

    return {
      success: true,
      data: {
        reconciliation: recon,
        bank_account_name: bankAcc ? bankAcc.name : "",
        current_book_balance: bankAcc
          ? Number(bankAcc.current_balance || 0)
          : 0,
        lines: lines,
        unmatched_transactions: unmatchedTx,
        matched_total: matchedTotal,
        statement_lines_total: statementTotal,
      },
    };
  } catch (e) {
    return errResponse("خطأ في جلب تفاصيل جلسة المطابقة: " + e.message);
  }
}

function createBankReconciliation(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addBankReconciliation",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!ValidationEngine.isRequired(data.bank_account_id) || !ValidationEngine.isRequired(data.statement_date))
      return errResponse("الحساب البنكي وتاريخ كشف الحساب مطلوبان");

    if (typeof validateEntityReference === "function") {
      var _bankErr = validateEntityReference(
        data.bank_account_id,
        "BankAccounts",
        ACCOUNTING_HR_HEADERS.BankAccounts,
        { required: true, label: "الحساب البنكي" },
      );
      if (_bankErr) return errResponse(_bankErr);
    }

    var bankAcc = readSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
      {
        trimStrings: true,
      },
    ).find(function (b) {
      return b.id === data.bank_account_id;
    });
    if (!bankAcc) return errResponse("الحساب البنكي غير موجود");

    // مفيش أكتر من جلسة DRAFT واحدة في نفس الوقت لنفس الحساب — لتفادي
    // تشتت المطابقة بين جلستين مفتوحتين على نفس الحساب البنكي
    var existing = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    ).find(function (r) {
      return (
        String(r.bank_account_id) === String(data.bank_account_id) &&
        r.status === "DRAFT"
      );
    });
    if (existing)
      return errResponse(
        "يوجد بالفعل جلسة مطابقة مفتوحة (مسودة) لنفس الحساب البنكي — أكملها أو احذفها أولاً",
      );

    var id = makeId("REC");
    var now = new Date().toISOString();
    var code = _getNextVoucherNumber("REC");

    var row = [
      id,
      code,
      data.bank_account_id,
      data.statement_date,
      data.period_start || "",
      Number(data.statement_opening_balance || 0),
      Number(data.statement_closing_balance || 0),
      Number(bankAcc.current_balance || 0), // book_balance snapshot
      0, // matched_total — يُحسب عند الاعتماد
      0, // difference — يُحسب عند الاعتماد
      "DRAFT",
      data.notes || "",
      data.callerUser,
      now,
      "",
      "",
    ];
    var sheet = getSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
    );
    _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.BankReconciliations, row);
    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إنشاء جلسة المطابقة البنكية بنجاح", {
      id: id,
      code: code,
    });
  } catch (e) {
    return errResponse("خطأ في إنشاء جلسة المطابقة: " + e.message);
  }
}

function _addOneStatementLine(
  sheet,
  reconciliationId,
  bankAccountId,
  line,
  user,
  now,
) {
  var id = makeId("RSL");
  var row = [
    id,
    reconciliationId,
    bankAccountId,
    line.line_date || "",
    line.description || "",
    line.reference || "",
    Number(line.debit || 0),
    Number(line.credit || 0),
    "UNMATCHED",
    "",
    "",
    "",
    "",
    user,
    now,
  ];
  _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.BankStatementLines, row);
  return id;
}

function addBankStatementLine(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addBankReconciliation",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!ValidationEngine.isRequired(data.reconciliation_id) || !ValidationEngine.isRequired(data.line_date))
      return errResponse("الجلسة وتاريخ البند مطلوبان");
    if (!Number(data.debit || 0) && !Number(data.credit || 0))
      return errResponse("يجب إدخال مبلغ مدين أو دائن");

    var recon = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    ).find(function (r) {
      return r.id === data.reconciliation_id;
    });
    if (!recon) return errResponse("جلسة المطابقة غير موجودة");
    if (recon.status !== "DRAFT")
      return errResponse("لا يمكن إضافة بنود لجلسة معتمدة أو محذوفة");

    var sheet = getSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
    );
    var now = new Date().toISOString();
    var id = _addOneStatementLine(
      sheet,
      recon.id,
      recon.bank_account_id,
      data,
      data.callerUser,
      now,
    );
    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إضافة بند كشف الحساب", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة بند كشف الحساب: " + e.message);
  }
}

/**
 * addBankStatementLinesBulk — إضافة عدة بنود دفعة واحدة (لصق من كشف حساب
 * Excel/PDF محوّل لجدول). data.lines = [{line_date, description, reference,
 * debit, credit}, ...]
 */
function addBankStatementLinesBulk(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addBankReconciliation",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (
      !data.reconciliation_id ||
      !Array.isArray(data.lines) ||
      !data.lines.length
    )
      return errResponse("الجلسة وقائمة البنود مطلوبة");

    var recon = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    ).find(function (r) {
      return r.id === data.reconciliation_id;
    });
    if (!recon) return errResponse("جلسة المطابقة غير موجودة");
    if (recon.status !== "DRAFT")
      return errResponse("لا يمكن إضافة بنود لجلسة معتمدة أو محذوفة");

    var sheet = getSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
    );
    var now = new Date().toISOString();
    var count = 0;
    data.lines.forEach(function (line) {
      if (!line.line_date) return;
      if (!Number(line.debit || 0) && !Number(line.credit || 0)) return;
      _addOneStatementLine(
        sheet,
        recon.id,
        recon.bank_account_id,
        line,
        data.callerUser,
        now,
      );
      count++;
    });
    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إضافة " + count + " بند بنجاح", { count: count });
  } catch (e) {
    return errResponse("خطأ في إضافة البنود الدفعية: " + e.message);
  }
}

function deleteBankStatementLine(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "addBankReconciliation",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
    );
    var rows = readSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("البند غير موجود");

    var recon = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    ).find(function (r) {
      return r.id === rows[idx].reconciliation_id;
    });
    if (recon && recon.status !== "DRAFT")
      return errResponse("لا يمكن حذف بند من جلسة معتمدة");

    sheet.deleteRow(idx + 2);
    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف البند بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف البند: " + e.message);
  }
}

function matchStatementLine(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addBankReconciliation",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (
      !data.statement_line_id ||
      !data.transaction_type ||
      !data.transaction_id
    )
      return errResponse("بند كشف الحساب ونوع ومعرف الحركة مطلوبون");

    var sheet = getSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
    );
    var rows = readSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === data.statement_line_id;
    });
    if (idx === -1) return errResponse("بند كشف الحساب غير موجود");
    var line = rows[idx];

    var recon = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    ).find(function (r) {
      return r.id === line.reconciliation_id;
    });
    if (!recon || recon.status !== "DRAFT")
      return errResponse("لا يمكن المطابقة إلا داخل جلسة مسودة مفتوحة");

    // منع مطابقة نفس الحركة الفعلية مرتين (في نفس الجلسة أو جلسة تانية)
    var matchedKeys = _getMatchedKeysForBankAccount(line.bank_account_id);
    if (matchedKeys[data.transaction_type + ":" + data.transaction_id])
      return errResponse("هذه الحركة مُطابقة بالفعل ببند آخر");

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var now = new Date().toISOString();
    var updates = {
      status: "MATCHED",
      matched_type: data.transaction_type,
      matched_id: data.transaction_id,
      matched_at: now,
      matched_by: data.callerUser,
    };
    _applyRowUpdates(sheet, rowNum, headers, updates);

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تمت المطابقة بنجاح");
  } catch (e) {
    return errResponse("خطأ في مطابقة البند: " + e.message);
  }
}

function unmatchStatementLine(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "addBankReconciliation",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
    );
    var rows = readSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("البند غير موجود");

    var recon = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    ).find(function (r) {
      return r.id === rows[idx].reconciliation_id;
    });
    if (!recon || recon.status !== "DRAFT")
      return errResponse("لا يمكن إلغاء المطابقة إلا داخل جلسة مسودة مفتوحة");

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var updates = {
      status: "UNMATCHED",
      matched_type: "",
      matched_id: "",
      matched_at: "",
      matched_by: "",
    };
    _applyRowUpdates(sheet, rowNum, headers, updates);

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إلغاء المطابقة بنجاح");
  } catch (e) {
    return errResponse("خطأ في إلغاء المطابقة: " + e.message);
  }
}

/**
 * autoMatchBankReconciliation — مطابقة تلقائية بالتقريب: لكل بند UNMATCHED،
 * دوّر على حركة غير مطابقة بنفس المبلغ بالظبط (فرق أقل من قرش) وتاريخ قريب
 * (≤ 5 أيام)، وفضّل اللي رقم مرجعها مطابق لو موجود. لو لقى مرشّح وحيد واضح
 * يطابقه تلقائياً، وبيسيب أي حالة فيها أكتر من مرشّح للمطابقة اليدوية.
 */
function autoMatchBankReconciliation(
  reconciliationId,
  callerUser,
  sessionToken,
) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "addBankReconciliation",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var recon = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    ).find(function (r) {
      return r.id === reconciliationId;
    });
    if (!recon) return errResponse("جلسة المطابقة غير موجودة");
    if (recon.status !== "DRAFT")
      return errResponse(
        "لا يمكن المطابقة التلقائية إلا داخل جلسة مسودة مفتوحة",
      );

    var sheet = getSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
    );
    var allLines = readSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
      { trimStrings: true },
    );
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    var matchedKeys = _getMatchedKeysForBankAccount(recon.bank_account_id);
    var allTx = _collectBankTransactions(recon.bank_account_id, null).filter(
      function (t) {
        return !matchedKeys[t.type + ":" + t.id];
      },
    );

    var now = new Date().toISOString();
    var matchedCount = 0;

    allLines.forEach(function (line, idx) {
      if (line.reconciliation_id !== reconciliationId) return;
      if (line.status !== "UNMATCHED") return;
      var lineAmount = Number(line.credit || 0) - Number(line.debit || 0);

      var candidates = allTx.filter(function (t) {
        if (matchedKeys[t.type + ":" + t.id]) return false; // اتطابق في نفس الدورة
        if (Math.abs(t.amount - lineAmount) > 0.01) return false;
        if (line.line_date && t.date) {
          var diffDays = Math.abs(
            (new Date(line.line_date) - new Date(t.date)) / 86400000,
          );
          if (diffDays > 5) return false;
        }
        return true;
      });

      // فضّل تطابق رقم المرجع لو فيه أكتر من مرشّح
      if (candidates.length > 1 && line.reference) {
        var refMatch = candidates.filter(function (t) {
          return (
            t.reference &&
            String(t.reference).trim() === String(line.reference).trim()
          );
        });
        if (refMatch.length === 1) candidates = refMatch;
      }

      if (candidates.length !== 1) return; // غامض أو مفيش تطابق — يُترك للمطابقة اليدوية

      var tx = candidates[0];
      var rowNum = idx + 2;
      var updates = {
        status: "MATCHED",
        matched_type: tx.type,
        matched_id: tx.id,
        matched_at: now,
        matched_by: callerUser,
      };
      _applyRowUpdates(sheet, rowNum, headers, updates);
      matchedKeys[tx.type + ":" + tx.id] = reconciliationId;
      matchedCount++;
    });

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تمت المطابقة التلقائية لـ " + matchedCount + " بند", {
      matched_count: matchedCount,
    });
  } catch (e) {
    return errResponse("خطأ في المطابقة التلقائية: " + e.message);
  }
}

/**
 * completeBankReconciliation — اعتماد/قفل الجلسة. بيحسب صافي البنود
 * المطابقة والفرق بين رصيد كشف الحساب الختامي ورصيد النظام الحالي، ويسجّلهم
 * في الجلسة كمرجع دائم. الاعتماد بيتم حتى لو فيه فرق (بنود معلّقة لسه ما
 * اتسوّتش في كشف الحساب — شيء طبيعي وشائع)، لكن الفرق بيفضل مسجَّل وواضح
 * للمراجعة بدل ما يتم تجاهله.
 */
function completeBankReconciliation(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "completeBankReconciliation",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
    );
    var rows = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("جلسة المطابقة غير موجودة");
    var recon = rows[idx];
    if (recon.status !== "DRAFT")
      return errResponse("الجلسة معتمدة بالفعل أو محذوفة");

    var bankAcc = readSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
      {
        trimStrings: true,
      },
    ).find(function (b) {
      return b.id === recon.bank_account_id;
    });
    var currentBookBalance = bankAcc ? Number(bankAcc.current_balance || 0) : 0;

    var lines = readSheet(
      "BankStatementLines",
      ACCOUNTING_HR_HEADERS.BankStatementLines,
      { trimStrings: true },
    ).filter(function (l) {
      return l.reconciliation_id === id;
    });
    var matchedTotal = 0;
    lines.forEach(function (l) {
      if (l.status === "MATCHED")
        matchedTotal += Number(l.credit || 0) - Number(l.debit || 0);
    });

    var difference =
      Number(recon.statement_closing_balance || 0) - currentBookBalance;

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var now = new Date().toISOString();
    var updates = {
      status: "COMPLETED",
      matched_total: matchedTotal,
      difference: difference,
      completed_by: callerUser,
      completed_at: now,
    };
    _applyRowUpdates(sheet, rowNum, headers, updates);

    AuditEngine.log("COMPLETE", {
      user: callerUser,
      table: "BankReconciliations",
      record_id: id,
      details:
        "اعتماد جلسة مطابقة بنكية " +
        (recon.code || id) +
        " — الفرق: " +
        difference.toFixed(2)});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse(
      difference === 0
        ? "تم اعتماد المطابقة بنجاح — مطابقة تامة"
        : "تم اعتماد المطابقة — يوجد فرق قدره " +
            difference.toFixed(2) +
            " يستحق المراجعة",
      { difference: difference, matched_total: matchedTotal },
    );
  } catch (e) {
    return errResponse("خطأ في اعتماد جلسة المطابقة: " + e.message);
  }
}

function reopenBankReconciliation(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "completeBankReconciliation",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
    );
    var rows = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("جلسة المطابقة غير موجودة");
    if (rows[idx].status !== "COMPLETED")
      return errResponse("لا يمكن إعادة فتح جلسة ليست معتمدة");

    // لازم مفيش جلسة DRAFT تانية مفتوحة لنفس الحساب البنكي حالياً
    var dup = rows.find(function (r) {
      return (
        r.id !== id &&
        String(r.bank_account_id) === String(rows[idx].bank_account_id) &&
        r.status === "DRAFT"
      );
    });
    if (dup)
      return errResponse(
        "يوجد جلسة مسودة مفتوحة بالفعل لنفس الحساب البنكي — أكملها أو احذفها أولاً",
      );

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var statusCol = headers.indexOf("status");
    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("DRAFT");

    AuditEngine.log("REOPEN", {
      user: callerUser,
      table: "BankReconciliations",
      record_id: id,
      details: "إعادة فتح جلسة مطابقة بنكية " + (rows[idx].code || id)});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إعادة فتح الجلسة للمراجعة");
  } catch (e) {
    return errResponse("خطأ في إعادة فتح الجلسة: " + e.message);
  }
}

function deleteBankReconciliation(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "deleteBankReconciliation",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
    );
    var rows = readSheet(
      "BankReconciliations",
      ACCOUNTING_HR_HEADERS.BankReconciliations,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("جلسة المطابقة غير موجودة");
    if (rows[idx].status === "COMPLETED")
      return errResponse(
        "لا يمكن حذف جلسة معتمدة — أعد فتحها أولاً لو محتاج تعدّل",
      );

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var statusCol = headers.indexOf("status");
    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("DELETED");

    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "BankReconciliations",
      record_id: id,
      details: "حذف جلسة مطابقة بنكية " + (rows[idx].code || id)});

    _invalidateServerCacheBanking(); // [PERF-SCOPED-INVALIDATION-BANKING] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف جلسة المطابقة بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف جلسة المطابقة: " + e.message);
  }
}

/**
 * getBankAccountStatement — كشف حساب بنكي مفصّل (Banking Module Phase 9)
 * بيجمع كل الحركات الفعلية المسجّلة على حساب بنكي معيّن من الخمس مصادر
 * (نفس منطق _collectBankTransactions من المرحلة 8)، وبيحسب رصيد جاري
 * (running balance) بدءاً من `opening_balance` المسجّل على الحساب نفسه —
 * مش بس من بداية الفترة المطلوبة، عشان يكون الرصيد الجاري صحيح فعلياً.
 * @param {string} bankAccountId
 * @param {string} fromDate — بداية الفترة المعروضة (الرصيد قبلها بيتحسب ك"رصيد افتتاحي للفترة")
 * @param {string} toDate — نهاية الفترة المعروضة
 */
function getBankAccountStatement(bankAccountId, fromDate, toDate, callerUser) {
  try {
    if (callerUser) _requirePermission(callerUser, "viewBankAccounts"); // [RBAC-FIX]
    if (!ValidationEngine.isRequired(bankAccountId)) return errResponse("الحساب البنكي مطلوب");
    var bankAcc = readSheet(
      "BankAccounts",
      ACCOUNTING_HR_HEADERS.BankAccounts,
      {
        trimStrings: true,
      },
    ).find(function (b) {
      return b.id === bankAccountId;
    });
    if (!bankAcc) return errResponse("الحساب البنكي غير موجود");

    // كل الحركات التاريخية للحساب حتى toDate (أو كل التاريخ لو مفيش toDate)،
    // مرتّبة تصاعدياً — عشان نقدر نحسب رصيد جاري صحيح خطوة بخطوة.
    var allTx = _collectBankTransactions(bankAccountId, toDate || null);

    var openingBalance = Number(bankAcc.opening_balance || 0);
    var running = openingBalance;
    var periodOpeningBalance = openingBalance;
    var rows = [];

    allTx.forEach(function (t) {
      running += t.amount;
      if (fromDate && t.date < fromDate) {
        periodOpeningBalance = running; // آخر رصيد قبل بداية الفترة المطلوبة
        return; // مش هيتعرض في الجدول، بس بيدخل في حساب الرصيد الافتتاحي للفترة
      }
      rows.push({
        type: t.type,
        id: t.id,
        date: t.date,
        description: t.description,
        reference: t.reference,
        debit: t.amount < 0 ? -t.amount : 0,
        credit: t.amount > 0 ? t.amount : 0,
        balance: running,
      });
    });

    return {
      success: true,
      data: {
        bank_account: bankAcc,
        opening_balance: openingBalance,
        period_opening_balance: periodOpeningBalance,
        closing_balance: running,
        rows: rows,
      },
    };
  } catch (e) {
    return errResponse("خطأ في جلب كشف الحساب البنكي: " + e.message);
  }
}
