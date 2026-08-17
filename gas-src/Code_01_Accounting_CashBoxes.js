// ════════════════════════════════════════════════════════════════
// Code_Accounting_CashBoxes.gs — [REFACTOR-P4] نُقل من Code_Accounting.gs (نقل نصي بحت،
// صفر تغيير في المنطق أو الترتيب الداخلي بين الدوال). Apps Script يعامل
// كل ملفات .gs كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء
// من أي ملف .gs أو .html آخر طالما الأسماء لم تتغير (ولم تتغير).
// راجع تقرير Architecture Audit 2026-07-03 — المرحلة 4، قسم 4-ب.
//
// المسؤولية: الخزائن النقدية (Cash Boxes) — إضافة/تعديل/حذف ورصيد
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-03  Accounting — Cash Boxes (الخزائن)
// ═══════════════════════════════════════════════════════════════════════════════

// ── getNextCashBoxCode ───────────────────────────────────────────────────────
// [AUTO-CODE] نسخة قابلة للاستدعاء من الواجهة (google.script.run) لعرض الكود
// التسلسلي التالي فور فتح مودال "خزينة جديدة" — نفس مبدأ getNextCustomerCode
// (Code_20_Sales.gs). التوليد الملزم الفعلي يتم مرة أخرى داخل addCashBox
// وقت الحفظ.
function getNextCashBoxCode() {
  return okResponse("", {
    data: _getNextSequentialCode("cashbox", function () {
      return readSheet(
        "CashBoxes",
        ACCOUNTING_HR_HEADERS.CashBoxes,
      ).map(function (r) {
        return r.code;
      });
    }),
  });
}

function getCashBoxes(callerUser, sessionToken) {
  try {
    if (callerUser) {
      var _permErr = _checkPermission(callerUser, "viewCashBoxes", sessionToken);
      if (_permErr) return _permErr;
    }
    var rows = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return r.is_active !== false && r.is_active !== "FALSE";
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب الخزائن: " + e.message);
  }
}
function addCashBox(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addCashBox",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var _auditUser = data.callerUser;
    // [AUTO-CODE] توليد كود تسلسلي (1، 2، 3...) إذا لم يُرسل من الفرونت —
    // بدل الكود العشوائي المبني على الوقت (Date.now) السابق.
    if (!data.code) {
      data.code = _getNextSequentialCode("cashbox", function () {
        return readSheet(
          "CashBoxes",
          ACCOUNTING_HR_HEADERS.CashBoxes,
        ).map(function (r) {
          return r.code;
        });
      });
    }
    if (!ValidationEngine.isRequired(data.name))
      return errResponse("اسم الخزنة مطلوب");

    var existing = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var activeExisting = existing.filter(function (r) {
      return r.is_active !== "FALSE";
    });
    if (ValidationEngine.isDuplicate(activeExisting, "code", data.code))
      return errResponse("كود الخزنة موجود مسبقاً");

    // إنشاء حساب GL تلقائياً
    // [CB-03 FIX] إنشاء حساب GL إلزامي — لا تُنشأ الخزينة بدون حساب محاسبي
    var accountId = "";
    try {
      var accResult = addChartAccount({
        code: "11" + data.code,
        name: "خزنة — " + data.name,
        type: "ASSET",
        currency: data.currency || "EGP",
        branch: data.branch || "",
        callerUser: data.callerUser,
        sessionToken: data.sessionToken,
      });
      if (accResult && accResult.success) {
        accountId = accResult.id;
      } else if (accResult && !accResult.success) {
        // لو الكود موجود مسبقاً نحاول نجيب الحساب الموجود
        var existingAccs = readSheet(
          "ChartOfAccounts",
          ACCOUNTING_HR_HEADERS.ChartOfAccounts,
        );
        var existingAcc = existingAccs.find(function (a) {
          return String(a.code) === String("11" + data.code) && !a.deleted_at;
        });
        if (existingAcc) {
          accountId = existingAcc.id;
          Logger.log(
            "[addCashBox] الحساب موجود مسبقاً — تم استخدام id: " + accountId,
          );
        } else {
          // [CB-03 FIX] فشل حقيقي — نوقف العملية
          return errResponse(
            "فشل إنشاء الحساب المحاسبي للخزينة: " +
              (accResult.message || "سبب غير معروف") +
              " — لم تُنشأ الخزينة",
          );
        }
      }
    } catch (accErr) {
      // [CB-03 FIX] استثناء أثناء إنشاء GL — نوقف العملية
      return errResponse(
        "خطأ في إنشاء الحساب المحاسبي: " +
          accErr.message +
          " — لم تُنشأ الخزينة",
      );
    }

    // [CB-03 FIX] تحقق نهائي — لا تكمل بدون account_id
    if (!accountId) {
      return errResponse(
        "لا يمكن إنشاء خزينة بدون حساب محاسبي مرتبط — يرجى التواصل مع المشرف",
      );
    }

    var id = makeId("CBX");
    var now = new Date().toISOString();
    var openingBalance = Number(data.opening_balance || 0);

    var row = [
      id,
      data.code,
      data.name,
      data.branch || "",
      data.currency || "EGP",
      openingBalance,
      openingBalance,
      accountId,
      data.responsible || "",
      "TRUE",
      data.notes || "",
      now,
      data.callerUser || "", // created_by [CB-01 FIX]
      "", // updated_at
      "", // updated_by
    ];

    var _cbxSheet = getSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    _appendRowProtected(_cbxSheet, ACCOUNTING_HR_HEADERS.CashBoxes, row);

    // [CB-04 FIX] قيد الرصيد الافتتاحي في الأستاذ العام — إلزامي إذا كان الرصيد > 0
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
            "opening balance equity",
          ],
        );
        // [AUTO-EQUITY] إذا لم يُعثر على حساب Equity — ننشئه تلقائياً
        if (!equityAccount) {
          Logger.log(
            "[addCashBox] حساب EQUITY غير موجود — سيتم إنشاؤه تلقائياً",
          );
          try {
            // البحث عن أي كود EQUITY متاح — نبدأ من 3001
            var existingAccsForEquity = readSheet(
              "ChartOfAccounts",
              ACCOUNTING_HR_HEADERS.ChartOfAccounts,
            );
            var equityCode = "3001";
            var equityCodeNum = 3001;
            while (
              existingAccsForEquity.find(function (a) {
                return (
                  String(a.code) === String(equityCodeNum) && !a.deleted_at
                );
              })
            ) {
              equityCodeNum++;
              equityCode = String(equityCodeNum);
            }
            var autoEquityResult = addChartAccount({
              code: equityCode,
              name: "رصيد افتتاحي",
              name_en: "Opening Balance Equity",
              type: "EQUITY",
              currency: data.currency || "EGP",
              branch: data.branch || "",
              callerUser: data.callerUser,
              sessionToken: data.sessionToken,
            });
            if (autoEquityResult && autoEquityResult.success) {
              // إعادة تحميل الحسابات وجلب الحساب الجديد
              var freshAccs = readSheet(
                "ChartOfAccounts",
                ACCOUNTING_HR_HEADERS.ChartOfAccounts,
              );
              equityAccount = freshAccs.find(function (a) {
                return a.id === autoEquityResult.id && !a.deleted_at;
              });
              Logger.log(
                "[addCashBox] تم إنشاء حساب EQUITY تلقائياً: " + equityCode,
              );
            } else {
              Logger.log(
                "[addCashBox] فشل إنشاء حساب EQUITY تلقائياً — سيتم تجاهل الرصيد الافتتاحي",
              );
            }
          } catch (equityErr) {
            Logger.log(
              "[addCashBox] خطأ في إنشاء EQUITY تلقائياً: " + equityErr.message,
            );
          }
        }

        // تحقق من عدم وجود قيد افتتاحي مسبق لنفس الخزينة
        var refKey = "OB-CBX-" + id;
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
          var jeResult = _addJournalEntryInternal({
            callerUser: data.callerUser || "SYSTEM",
            date: now.split("T")[0],
            reference: refKey,
            source_type: "OPENING_BALANCE",
            description: "رصيد افتتاحي — خزنة: " + data.name,
            lines: [
              {
                account_id: accountId,
                debit: openingBalance,
                credit: 0,
                notes: "رصيد افتتاحي خزنة — " + data.name,
              },
              {
                account_id: equityAccount.id,
                debit: 0,
                credit: openingBalance,
                notes: "أرصدة افتتاحية",
              },
            ],
          });
          // [CB-04 FIX] فشل القيد المحاسبي = فشل العملية كاملاً
          if (!jeResult || !jeResult.success) {
            var _cbxSheetRb2 = getSheet(
              "CashBoxes",
              ACCOUNTING_HR_HEADERS.CashBoxes,
            );
            var _rb2Rows = readSheet(
              "CashBoxes",
              ACCOUNTING_HR_HEADERS.CashBoxes,
              { trimStrings: true },
            );
            var _rb2Idx = _rb2Rows.findIndex(function (r) {
              return r.id === id;
            });
            if (_rb2Idx !== -1) _cbxSheetRb2.deleteRow(_rb2Idx + 2);
            try {
              deleteChartAccount(accountId, data.callerUser, data.sessionToken);
            } catch (e3) {
              // [BUG-003 FIX] كان catch فارغ تمامًا — لو فشل حذف الحساب هنا
              // (تنظيف Rollback بعد فشل القيد)، يبقى حساب "يتيم" غير مستخدم
              // في شجرة الحسابات بدون أي أثر قابل للتتبع. نسجّله الآن على
              // الأقل في Logger لأن العملية الرئيسية (رفض إنشاء الخزينة)
              // بتكمل بنجاح بغض النظر.
              Logger.log(
                "[CB-04 FIX] فشل حذف الحساب " +
                  accountId +
                  " أثناء Rollback إنشاء خزينة " +
                  id +
                  ": " +
                  e3.message,
              );
            }
            return errResponse(
              "فشل إنشاء القيد المحاسبي للرصيد الافتتاحي: " +
                ((jeResult && jeResult.message) || "سبب غير معروف") +
                " — لم تُنشأ الخزينة",
            );
          }
        }
      } catch (jeErr) {
        Logger.log("[CB-04] خطأ في قيد رصيد افتتاحي الخزنة: " + jeErr.message);
        return errResponse(
          "خطأ في إنشاء القيد الافتتاحي: " +
            jeErr.message +
            " — لم تُنشأ الخزينة",
        );
      }
    }

    // [CB-06 FIX] تسجيل العملية في Audit Log
    AuditEngine.log("CREATE", {
      user: data.callerUser || "SYSTEM",
      table: "CashBoxes",
      record_id: id,
      details:
        "إنشاء خزينة جديدة: " +
        data.name +
        " (كود: " +
        data.code +
        ")" +
        (openingBalance > 0 ? " — رصيد افتتاحي: " + openingBalance : "")});

    _invalidateServerCacheCashBoxes(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم إضافة الخزنة بنجاح", {
      id: id,
      account_id: accountId,
    });
  } catch (e) {
    return errResponse("خطأ في إضافة الخزنة: " + e.message);
  }
}
function updateCashBox(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateCashBox",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var rows = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الخزنة غير موجودة");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    var updates = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.branch !== undefined) updates.branch = data.branch;
    if (data.responsible !== undefined) updates.responsible = data.responsible;
    if (data.is_active !== undefined)
      updates.is_active = data.is_active ? "TRUE" : "FALSE";
    if (data.notes !== undefined) updates.notes = data.notes;
    // [CB-02 FIX] تسجيل وقت ومن قام بالتعديل
    updates.updated_at = new Date().toISOString();
    updates.updated_by = data.callerUser || "";

    _applyRowUpdates(sheet, rowNum, headers, updates);

    // [CB-06 FIX] تسجيل العملية في Audit Log
    AuditEngine.log("UPDATE", {
      user: data.callerUser || "SYSTEM",
      table: "CashBoxes",
      record_id: id,
      details: "تعديل بيانات الخزينة: " + (data.name || rows[idx].name || id)});

    _invalidateServerCacheCashBoxes(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم تحديث الخزنة بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث الخزنة: " + e.message);
  }
}
function deleteCashBox(id, callerUser, sessionToken) {
  try {
    // [FIX-ISSUE-001] فحص الصلاحيات — كان مفقوداً في وحدة المحاسبة
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "deleteCashBox", sessionToken);
    if (_permErr) return _permErr;
    var rows = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return String(r.id).trim() === String(id).trim();
    });
    if (idx === -1) {
      Logger.log(
        "deleteCashBox: id not found. Received=" +
          id +
          " | Available IDs=" +
          rows
            .map(function (r) {
              return r.id;
            })
            .join(","),
      );
      return errResponse("الخزنة غير موجودة (id: " + id + ")");
    }

    // [BRE-UNIFY-1] فحص الرصيد الآن مركزي عبر BusinessRulesEngine بدل تكراره هنا
    var _bre = BusinessRulesEngine.validateBeforeDelete("cashBox", { id: id });
    if (!_bre.success) {
      var balance = Number(rows[idx].current_balance || 0);
      return errResponse(
        "لا يمكن حذف خزينة برصيد حالي (" +
          balance.toFixed(2) +
          ") — يرجى تصفير الرصيد أولاً عبر سند تحويل أو صرف",
      );
    }

    var sheet = getSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = rows[idx]._row; // رقم الصف الفعلي من readSheet
    if (!rowNum) rowNum = idx + 2; // fallback
    var isActiveCol = headers.indexOf("is_active");
    if (isActiveCol !== -1) {
      // حذف ناعم — اتساقًا مع الحساب البنكي، يحافظ على السجل التاريخي لأي سندات قديمة
      sheet.getRange(rowNum, isActiveCol + 1).setValue("FALSE");
    } else {
      sheet.deleteRow(rowNum);
    }

    // تسجيل العملية في Audit Log
    AuditEngine.log("DELETE", {
      user: callerUser,
      table: "CashBoxes",
      record_id: id,
      details: "حذف خزينة (رصيد صفري): " + (rows[idx].name || id)});

    _invalidateExtCache(); // مسح كاش Extended بعد نجاح الحذف فقط
    _invalidateServerCacheCashBoxes(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("تم حذف الخزنة بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف الخزنة: " + e.message);
  }
}
// [PAYMENT-ENGINE] غلاف توافق فوق PaymentEngine.adjustLedgerBalance — راجع
// Code_37_PaymentEngine.gs لسبب التوحيد. نفس الاسم/التوقيع/السلوك بالظبط،
// المنطق الفعلي بقى في مكان واحد بدل نسختين (هنا وفي Vouchers).
function _updateCashBoxBalance(cashBoxId, amount) {
  PaymentEngine.adjustLedgerBalance("CashBoxes", cashBoxId, amount);
}

/**
 * _seedDefaultCashBoxIfEmpty — [DEFAULT-CASHBOX-1] ينشئ خزينة افتراضية
 * "الخزينة الرئيسية" أول مرة النظام يتهيّأ (لو مفيش خزينة بنفس الاسم
 * موجودة أصلاً)، مربوطة محاسبيًا بالكامل عبر addCashBox() القياسية:
 *   - حساب GL مخصوص جديد لها في دليل الحسابات (خزنة — الخزينة الرئيسية)
 *   - ربط account_id في شيت CashBoxes
 *   - رصيد افتتاحي = صفر (تقدر تضيف رصيد حقيقي لاحقًا من الواجهة عادي)
 *
 * عمدًا بتاخد حساب GL بكود جديد مستقل، ومش بتربط بحساب 1101
 * (الصندوق/النقدية) القديم من دليل الحسابات الافتراضي — لأن الحساب ده
 * ممكن يكون عليه current_balance غير مدعوم بأي قيد فعلي (Orphaned
 * Balance) في قواعد بيانات قديمة اتنشأت قبل هذا التحديث، فمنورّثش
 * المشكلة دي للخزينة الجديدة.
 *
 * Idempotent وSelf-Healing زي ensureDefaultUsers()/_seedDefaultChartIfEmpty():
 * أي تشغيل لاحق لـ initializeSystem()/setupEverything() بيتخطاها لو
 * الخزينة موجودة أصلاً، فمينفعش تتكرر.
 *
 * بتتنادى من initializeSystem() في Code_21_Setup.js.
 */
function _seedDefaultCashBoxIfEmpty() {
  try {
    var existing = readSheet("CashBoxes", ACCOUNTING_HR_HEADERS.CashBoxes, {
      trimStrings: true,
    });
    var already = existing.find(function (r) {
      return (
        String(r.name || "").trim() === "الخزينة الرئيسية" &&
        r.is_active !== "FALSE"
      );
    });
    if (already) {
      return "↩️ الخزينة الرئيسية موجودة أصلاً (id: " + already.id + ") — تخطّي";
    }

    // لازم يوزر فعّال (عادةً admin الافتراضي من ensureDefaultUsers) عشان
    // ننشئ جلسة نظام مؤقتة وننادي addCashBox العامة بكل حمايتها ومنطقها
    // المحاسبي بدل ما نكرر نفس المنطق هنا من الصفر.
    var users = readSheet("Users", null, { trimStrings: true });
    var systemUser =
      users.find(function (u) {
        return String(u.username).trim().toLowerCase() === "admin";
      }) || users[0];

    if (!systemUser) {
      Logger.log(
        "[_seedDefaultCashBoxIfEmpty] مفيش أي يوزر في النظام لسه — تخطّي إنشاء الخزينة الافتراضية",
      );
      return "⏭️ تخطّي — مفيش يوزر بعد لإنشاء الجلسة";
    }

    var sess = createSession(systemUser.username, systemUser.role);
    if (!sess || !sess.success) {
      Logger.log(
        "[_seedDefaultCashBoxIfEmpty] فشل إنشاء جلسة مؤقتة: " +
          JSON.stringify(sess),
      );
      return " فشل إنشاء جلسة مؤقتة لإنشاء الخزينة الافتراضية";
    }

    var result = addCashBox({
      name: "الخزينة الرئيسية",
      opening_balance: 0,
      currency: "EGP",
      branch: typeof DEFAULT_BRANCH_NAME !== "undefined" ? DEFAULT_BRANCH_NAME : "",
      responsible: "",
      notes: "خزينة النظام الافتراضية الرئيسية",
      callerUser: systemUser.username,
      sessionToken: sess.token,
    });

    if (result && result.success) {
      Logger.log(
        "[_seedDefaultCashBoxIfEmpty] تم إنشاء الخزينة الرئيسية — id: " +
          result.id +
          " | account_id: " +
          result.account_id,
      );
      return (
        " تم إنشاء الخزينة الرئيسية (id: " +
        result.id +
        ", account_id: " +
        result.account_id +
        ")"
      );
    }
    Logger.log(
      "[_seedDefaultCashBoxIfEmpty] فشل إنشاء الخزينة الرئيسية: " +
        JSON.stringify(result),
    );
    return " فشل إنشاء الخزينة الرئيسية: " + (result && result.message);
  } catch (e) {
    Logger.log("[_seedDefaultCashBoxIfEmpty] خطأ: " + e.message);
    return " خطأ في إنشاء الخزينة الافتراضية: " + e.message;
  }
}
