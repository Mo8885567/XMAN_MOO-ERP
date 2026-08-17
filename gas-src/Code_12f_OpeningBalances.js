/**
 * ============================================================
 * Module: Code_12f_OpeningBalances.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * يقرأ كامل الرصيد الافتتاحي (OpeningStock) بصيغة استجابة موحّدة.
 * @returns {{success: Boolean, data: Array<Object>, message: String=}}
 */
function getOpeningStock() {
  try {
    const rows = readSheet("OpeningStock", OPENING_STOCK_HEADERS, {
      dateOnly: true,
    });
    return { success: true, data: rows };
  } catch (e) {
    return { success: false, message: e.message, data: [] };
  }
}

/**
 * يجمع كل صفوف الرصيد الافتتاحي (متعددة الألوان لكل صنف) في خريطة
 * إجمالي واحدة لكل item_id، لتُستخدم في حسابات لوحة التحكم والتقارير
 * التي لا تحتاج تفصيل الألوان.
 *
 * @param {Array<Object>} openingStock - صفوف OpeningStock الخام.
 * @returns {Object<String, Number>} خريطة { item_id: إجمالي_الكمية }.
 */
function _buildOpeningMap(openingStock) {
  // يجمع كل الألوان لكل صنف في رقم واحد (للتوافق مع التقارير ولوحة التحكم)
  const map = {};
  openingStock.forEach((os) => {
    map[os.item_id] = (map[os.item_id] || 0) + Number(os.quantity || 0);
  });
  return map;
}

/**
 * يحفظ (يضيف أو يحدّث) رصيدًا افتتاحيًا لصنف/لون معيّن.
 *
 * Business Rules:
 * - الكمية يجب أن تكون رقمًا غير سالب.
 * - تكلفة الوحدة (unit_cost) اختيارية: فارغة/غير مرسلة تعني استخدام
 *   تكلفة الصنف الحالية وقت الترحيل لاحقًا (السلوك القديم)، بينما
 *   القيمة المُدخلة صراحةً تُحفظ وتبقى ثابتة حتى لو تغيّرت cost_price
 *   الخاصة بالصنف مستقبلًا (MD-06 FIX).
 *
 * Throws:
 * - Permission Error إن لم يملك المستخدم صلاحية addOpeningStock.
 *
 * @param {String} item_id - معرّف الصنف.
 * @param {String} color - اللون.
 * @param {Number} qty - الكمية الافتتاحية.
 * @param {String} notes - ملاحظات اختيارية.
 * @param {String} user - اسم المستخدم المنفِّذ.
 * @param {String} sessionToken - توكن الجلسة.
 * @param {Number|String} [unit_cost] - تكلفة الوحدة الاختيارية.
 * @returns {{success: Boolean, message: String}}
 */
function saveOpeningStock(
  item_id,
  color,
  qty,
  notes,
  user,
  sessionToken,
  unit_cost,
) {
  try {
    var permErr = _checkPermission(user, "addOpeningStock", sessionToken);
    if (permErr) return permErr;
    if (!item_id) return errResponse("يجب تحديد الصنف");
    if (isNaN(Number(qty)) || Number(qty) < 0)
      return errResponse("الكمية غير صحيحة");
    // [MD-06 FIX] تكلفة وحدة افتتاحية اختيارية — فارغة/غير مرسلة = استخدم تكلفة
    // الصنف الحالية وقت الترحيل (السلوك القديم)، أما لو أُدخلت فهي تُحفظ صراحةً
    // ولا تتأثر لاحقًا بأي تغيير في cost_price الخاص بالصنف.
    var unitCost =
      unit_cost === "" || unit_cost === undefined || unit_cost === null
        ? ""
        : Number(unit_cost);
    if (unitCost !== "" && (isNaN(unitCost) || unitCost < 0))
      return errResponse("تكلفة الوحدة غير صحيحة");
    var sheet = getOpeningStockSheet();
    var rows = readSheet("OpeningStock", OPENING_STOCK_HEADERS, {
      dateOnly: true,
    });
    var colorStr = String(color || "").trim();
    var existing = rows.find(function (r) {
      return (
        String(r.item_id) === String(item_id) &&
        String(r.color || "").trim() === colorStr
      );
    });
    if (existing) {
      sheet
        .getRange(existing._row, 1, 1, 6)
        .setValues([
          [item_id, colorStr, Number(qty), notes || "", new Date(), unitCost],
        ]);
      _invalidateServerCacheOpeningBalances(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("✅ تم تعديل رصيد أول المدة");
    } else {
      sheet.appendRow([
        item_id,
        colorStr,
        Number(qty),
        notes || "",
        new Date(),
        unitCost,
      ]);
      _invalidateServerCacheOpeningBalances(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
      return okResponse("✅ تم إضافة رصيد أول المدة");
    }
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * يحذف صف رصيد افتتاحي لصنف/لون معيّن.
 *
 * @param {String} item_id - معرّف الصنف.
 * @param {String} color - اللون.
 * @param {String} user - اسم المستخدم المنفِّذ.
 * @param {String} sessionToken - توكن الجلسة.
 * @returns {{success: Boolean, message: String}}
 */
function deleteOpeningStock(item_id, color, user, sessionToken) {
  try {
    var permErr = _checkPermission(user, "deleteOpeningStock", sessionToken);
    if (permErr) return permErr;
    var rows = readSheet("OpeningStock", OPENING_STOCK_HEADERS, {
      dateOnly: true,
    });
    var colorStr = String(color || "").trim();
    var rec = rows.find(function (r) {
      return (
        String(r.item_id) === String(item_id) &&
        String(r.color || "").trim() === colorStr
      );
    });
    if (!rec) return errResponse("السجل غير موجود");
    getOpeningStockSheet().deleteRow(rec._row);
    _invalidateServerCacheOpeningBalances(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("✅ تم حذف رصيد أول المدة");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * postPartyOpeningBalance — [B4-FIX] قيد رصيد افتتاحي لعميل/مورد في الأستاذ العام.
 * قبل هذا الإصلاح: لا توجد أي آلية لإدخال أرصدة العملاء/الموردين القدامى — فالأستاذ العام
 * يبدأ من صفر لكل طرف حتى لو كانت عليه مديونية فعلية حقيقية قبل استخدام النظام.
 * عميل برصيد افتتاحي مدين (عليه مديونية): Dr. ذمم مدينة / Cr. حقوق ملكية (أرصدة افتتاحية)
 * مورد برصيد افتتاحي دائن (له مستحقات): Dr. حقوق ملكية (أرصدة افتتاحية) / Cr. ذمم دائنة
 */
function postPartyOpeningBalance(data, sessionToken) {
  var username = _getUsernameFromToken(sessionToken) || "system";
  var permErr = _checkPermission(username, "addJournalEntry", sessionToken);
  if (permErr) return permErr;
  try {
    if (!data) return errResponse("بيانات غير كافية");

    // [CUST-SETTINGS-WIRE-2026-08-08] enable_opening_balance —
    // كان الإعداد محفوظًا ومعروضًا بدون أي فحص فعلي، أي كان ممكن تُرحَّل
    // أرصدة افتتاحية حتى لو الميزة "معطّلة" من شاشة إعدادات العملاء.
    try {
      if (
        typeof CustomerSettingsEngine !== "undefined" &&
        CustomerSettingsEngine.get("enable_opening_balance") === false
      ) {
        return errResponse("ترحيل الأرصدة الافتتاحية معطّل حاليًا من إعدادات العملاء");
      }
    } catch (eOB) {
      // fail-open فقط لو تعذّرت قراءة الإعدادات نفسها
    }

    // [CUST-SETTINGS-WIRE-2026-08-08] opening_balance_requires_date —
    // نفس المبدأ: كان معروض بدون فحص فعلي.
    try {
      if (
        typeof CustomerSettingsEngine !== "undefined" &&
        CustomerSettingsEngine.get("opening_balance_requires_date") &&
        !String(data.date || "").trim()
      ) {
        return errResponse("تاريخ الرصيد الافتتاحي إلزامي حسب إعدادات العملاء");
      }
    } catch (eOBDate) {
      // fail-open فقط لو تعذّرت قراءة الإعدادات نفسها
    }

    var partyType = data.party_type === "supplier" ? "supplier" : "customer";
    var partyId = data.party_id;
    // [FIX-ISSUE-OB-1] كان بيفرض Math.abs ويثبّت اتجاه القيد دايمًا (عميل
    // مدين دايمًا / مورد دائن دايمًا)، فمفيش طريقة نظامية لتسجيل عميل دفع
    // مقدمًا (رصيد دائن له) أو مورد له مستحق لدينا (رصيد مدين له). دلوقتي
    // إشارة data.amount نفسها بتحدد الاتجاه: موجب = الحالة الطبيعية
    // (عميل مدين / مورد دائن)، سالب = الحالة المعاكسة (عميل دائن / مورد مدين).
    var signedAmount = Number(data.amount || 0);
    var amount = Math.abs(signedAmount);
    var isReversed = signedAmount < 0;
    if (!partyId) return errResponse("يجب تحديد الطرف");
    if (amount <= 0) return errResponse("القيمة يجب ألا تساوي صفر");

    var parties = _readParties(partyType);
    var party = parties.find(function (p) {
      return p.id === partyId;
    });
    if (!party) return errResponse("الطرف غير موجود");

    // منع تكرار ترحيل رصيد افتتاحي لنفس الطرف
    var reference = "OB-" + partyId;
    var existingEntries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    var alreadyPosted = existingEntries.some(function (e) {
      return (
        e.reference === reference &&
        e.status !== "CANCELLED" &&
        e.status !== "REVERSED"
      );
    });
    if (alreadyPosted) {
      return errResponse(
        "تم ترحيل رصيد افتتاحي لهذا الطرف من قبل — لتعديله استخدم قيد يدوي تسوية",
      );
    }

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var partyAccount =
      partyType === "supplier"
        ? _getDefaultAccount("ap_account", accounts, "LIABILITY", [
            "ذمم دائنة",
            "موردين",
            "accounts payable",
            "دائنة",
          ])
        : _getDefaultAccount("ar_account", accounts, "ASSET", [
            "ذمم مدينة",
            "عملاء",
            "accounts receivable",
            "مدينين",
          ]);
    var equityAccount = _getDefaultAccount(
      "opening_balance_equity_account",
      accounts,
      "EQUITY",
      ["الأرباح المرحلة", "أرباح مرحلة", "retained earnings", "رصيد افتتاحي"],
    );
    if (!partyAccount || !equityAccount) {
      return errResponse(
        "لا يوجد حساب ذمم مناسب أو حساب أرباح مرحلة (حقوق ملكية) في دليل الحسابات",
      );
    }

    // الحالة الطبيعية: عميل مدين (نحن الدائن له بخدمة/بضاعة) / مورد دائن
    // (نحن مدينون له). isReversed بيعكس اتجاه سطر حساب الطرف فقط — سطر
    // حقوق الملكية بيتعادل معاه تلقائيًا في الاتجاه المقابل، فالقيد يفضل
    // متوازن دايمًا بغض النظر عن الاتجاه.
    var partyIsDebit =
      partyType === "customer" ? !isReversed : isReversed;

    var partyLine = {
      account_id: partyAccount.id,
      debit: partyIsDebit ? amount : 0,
      credit: partyIsDebit ? 0 : amount,
      notes:
        "رصيد افتتاحي" +
        (isReversed ? " (دائن/معاكس)" : "") +
        " — " +
        party.name,
      party_type: partyType,
      party_id: partyId,
    };
    var equityLine = {
      account_id: equityAccount.id,
      debit: partyIsDebit ? 0 : amount,
      credit: partyIsDebit ? amount : 0,
      notes:
        "أرصدة افتتاحية " + (partyType === "supplier" ? "موردين" : "عملاء"),
    };
    // نفس ترتيب الأسطر القديم بالظبط لكل حالة طبيعية (مدين أولاً للعميل،
    // دائن أولاً للمورد) — الترتيب لا يؤثر محاسبيًا لكن نحافظ عليه لتفادي
    // أي فرق تنسيقي في شاشات لاحقة تعرض القيد.
    var lines =
      partyType === "customer"
        ? [partyLine, equityLine]
        : [equityLine, partyLine];

    var result = _addJournalEntryInternal({
      callerUser: username,
      date: data.date || new Date().toISOString().split("T")[0],
      reference: reference,
      description: "رصيد افتتاحي — " + party.name,
      source_type: "OPENING_BALANCE",
      lines: lines,
    });
    if (!result || !result.success) {
      return errResponse(
        "فشل ترحيل القيد: " + (result ? result.message : "خطأ غير معروف"),
      );
    }

    _addAuditLog(
      username,
      "POST_OPENING_BALANCE",
      partyType === "supplier" ? "Suppliers" : "Customers",
      partyId,
      "رصيد افتتاحي: " + amount,
    );
    _invalidateServerCacheOpeningBalances(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse("✅ تم ترحيل الرصيد الافتتاحي في الأستاذ العام");
  } catch (e) {
    return errResponse("خطأ في ترحيل الرصيد الافتتاحي: " + e.message);
  }
}

/**
 * postOpeningStockJournal — [B4-FIX] قيد محاسبي واحد يُثبت قيمة المخزون الافتتاحي بالكامل في GL.
 * قبل هذا الإصلاح: getOpeningStock() كانت تُرجع كميات افتتاحية بدون أي قيد محاسبي مرتبط،
 * فقيمة المخزون في الأستاذ العام لا تشمل أي بضاعة كانت موجودة قبل استخدام النظام.
 * القيد: Dr. حساب المخزون (qty × cost_price لكل صنف) / Cr. حقوق ملكية (أرصدة افتتاحية)
 */
function postOpeningStockJournal(date, sessionToken) {
  var username = _getUsernameFromToken(sessionToken) || "system";
  var permErr = _checkPermission(username, "addJournalEntry", sessionToken);
  if (permErr) return permErr;
  try {
    var reference = "OB-STOCK";
    var existingEntries = readSheet(
      "JournalEntries",
      ACCOUNTING_HR_HEADERS.JournalEntries,
      { trimStrings: true },
    );
    // [AUTO-OB-JOURNAL] بعد ما بقى الترحيل بيحصل أوتوماتيك مع كل إضافة رصيد
    // افتتاحي جديد (مش زرار يدوي مرة واحدة)، لازم الدالة تبقى Idempotent:
    // بدل ما نرفض الترحيل لو فيه قيد سابق بنفس المرجع، بنلغي (نعكس) القيد
    // القديم أولاً عبر cancelJournalEntry (بترجع أرصدة الحسابات صح) وبعدين
    // نرحّل قيد جديد بالإجمالي المحدّث الحالي. النتيجة: قيد واحد فعّال دايمًا
    // بيعكس آخر إجمالي للمخزون الافتتاحي، بدون تدخل يدوي من المستخدم.
    var existingActive = existingEntries.find(function (e) {
      return (
        e.reference === reference &&
        e.status !== "CANCELLED" &&
        e.status !== "REVERSED"
      );
    });
    if (existingActive) {
      var cancelRes = cancelJournalEntry(
        existingActive.id,
        username,
        sessionToken,
      );
      if (!cancelRes || !cancelRes.success) {
        return errResponse(
          "تعذّر تحديث قيد المخزون الافتتاحي (فشل إلغاء القيد القديم): " +
            (cancelRes ? cancelRes.message : "خطأ غير معروف"),
        );
      }
    }

    var openingRows = readSheet("OpeningStock", OPENING_STOCK_HEADERS, {
      dateOnly: true,
    });
    if (!openingRows.length) return errResponse("لا توجد بيانات مخزون افتتاحي");

    var items = readSheet("Items");
    var itemsById = {};
    items.forEach(function (i) {
      itemsById[i.id] = i;
    });

    var totalValue = 0;
    var skippedItems = [];
    openingRows.forEach(function (r) {
      var item = itemsById[r.item_id];
      var cost = Number((item && item.cost_price) || 0);
      var qty = Number(r.quantity || 0);
      if (cost <= 0) {
        skippedItems.push(r.item_id);
        return;
      }
      totalValue += qty * cost;
    });

    if (totalValue <= 0) {
      return errResponse(
        "قيمة المخزون الافتتاحي صفر — تأكد من وجود سعر تكلفة (cost_price) للأصناف",
      );
    }

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var inventoryAccount = _getDefaultAccount(
      "inventory_account",
      accounts,
      "ASSET",
      ["مخزون", "بضاعة", "inventory", "stock"],
    );
    var equityAccount = _getDefaultAccount(
      "opening_balance_equity_account",
      accounts,
      "EQUITY",
      ["الأرباح المرحلة", "أرباح مرحلة", "retained earnings", "رصيد افتتاحي"],
    );
    if (!inventoryAccount || !equityAccount) {
      return errResponse(
        "لا يوجد حساب مخزون أو حساب أرباح مرحلة (حقوق ملكية) في دليل الحسابات",
      );
    }

    var result = _addJournalEntryInternal({
      callerUser: username,
      date: date || new Date().toISOString().split("T")[0],
      reference: reference,
      description: "قيد مخزون افتتاحي",
      source_type: "OPENING_BALANCE",
      lines: [
        {
          account_id: inventoryAccount.id,
          debit: totalValue,
          credit: 0,
          notes: "مخزون افتتاحي",
        },
        {
          account_id: equityAccount.id,
          debit: 0,
          credit: totalValue,
          notes: "أرصدة افتتاحية مخزون",
        },
      ],
    });
    if (!result || !result.success) {
      return errResponse(
        "فشل ترحيل القيد: " + (result ? result.message : "خطأ غير معروف"),
      );
    }

    _addAuditLog(
      username,
      "POST_OPENING_STOCK_JOURNAL",
      "OpeningStock",
      reference,
      "قيمة: " +
        totalValue +
        (skippedItems.length
          ? " | تم تجاهل أصناف بدون cost_price: " + skippedItems.join(", ")
          : ""),
    );
    _invalidateServerCacheOpeningBalances(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return okResponse(
      "✅ تم ترحيل قيد المخزون الافتتاحي بقيمة " +
        totalValue.toFixed(2) +
        (skippedItems.length
          ? " (تم تجاهل " + skippedItems.length + " صنف بدون سعر تكلفة)"
          : ""),
    );
  } catch (e) {
    return errResponse("خطأ في ترحيل قيد المخزون الافتتاحي: " + e.message);
  }
}

function importOpeningStockBulk(rows, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(callerUser, "addOpeningStock", sessionToken);
    if (permErr) return permErr;

    if (!rows || !rows.length) return errResponse("لا توجد بيانات للاستيراد");
    if (rows.length > 5000)
      return errResponse("الحد الأقصى 5000 صف في الملف الواحد");

    var sheet = getOpeningStockSheet();
    var existing = readSheet("OpeningStock", OPENING_STOCK_HEADERS, {
      dateOnly: true,
    });

    // ✅ [VALIDATION-FIX] لازم نتحقق إن الصنف موجود فعلاً في شيت Items —
    // قبل كده كان أي item_id (حتى لو وهمي/كود مش موجود) بيتسجل عادي
    // ويعمل صف "يتيم" في الرصيد الافتتاحي بدون أي تحذير.
    var validItemIds = {};
    getSheetData("Items").forEach(function (it) {
      var id = String(it.id || "").trim();
      if (id) validItemIds[id] = true;
    });

    var added = 0,
      updated = 0,
      skipped = 0;
    var errors = [];
    var newRows = []; // [PERF-BATCH-1] صفوف جديدة نجمّعها ونكتبها دفعة واحدة
    var baseLastRow = sheet.getLastRow();

    rows.forEach(function (r, idx) {
      var rowNum = idx + 1;
      try {
        var itemId = String(r.item_id || "").trim();
        var colorStr = String(r.color || "").trim();
        var qtyRaw = r.qty;
        var qty = Number(qtyRaw);
        var notes = String(r.notes || "").trim();

        if (!itemId) {
          errors.push("صف " + rowNum + ": كود/معرف الصنف فارغ");
          skipped++;
          return;
        }
        if (!validItemIds[itemId]) {
          errors.push(
            "صف " +
              rowNum +
              ": الصنف (" +
              itemId +
              ") غير موجود في قائمة الأصناف",
          );
          skipped++;
          return;
        }
        if (
          qtyRaw === "" ||
          qtyRaw === null ||
          qtyRaw === undefined ||
          isNaN(qty)
        ) {
          errors.push("صف " + rowNum + ": الكمية غير صحيحة (" + qtyRaw + ")");
          skipped++;
          return;
        }
        if (qty < 0) {
          errors.push("صف " + rowNum + ": الكمية لا يمكن أن تكون سالبة");
          skipped++;
          return;
        }

        var rec = existing.find(function (e) {
          return (
            String(e.item_id) === itemId &&
            String(e.color || "").trim() === colorStr
          );
        });
        if (rec) {
          sheet
            .getRange(rec._row, 1, 1, 5)
            .setValues([[itemId, colorStr, qty, notes, new Date()]]);
          updated++;
        } else {
          newRows.push([itemId, colorStr, qty, notes, new Date()]);
          added++;
          // أضف السجل الجديد للـ existing عشان نتجنب التكرار في نفس الاستيراد
          // (رقم الصف الافتراضي = آخر صف حالي + عدد الصفوف الجديدة لحد دلوقتي)
          existing.push({
            item_id: itemId,
            color: colorStr,
            quantity: qty,
            notes: notes,
            _row: baseLastRow + newRows.length,
          });
        }
      } catch (rowErr) {
        errors.push(
          "صف " + rowNum + ": خطأ غير متوقع (" + rowErr.message + ")",
        );
        skipped++;
      }
    });
    appendRowsBatch("OpeningStock", newRows, OPENING_STOCK_HEADERS);

    _invalidateServerCacheOpeningBalances(); // [PERF-SCOPED-INVALIDATION] scoped (was blanket _invalidateServerCache)
    return {
      success: true,
      added: added,
      updated: updated,
      skipped: skipped,
      errors: errors,
      message:
        "✅ تم الاستيراد: " +
        added +
        " إضافة، " +
        updated +
        " تعديل" +
        (skipped ? "، " + skipped + " مُتخطى (راجع تفاصيل الأخطاء)" : ""),
    };
  } catch (e) {
    return errResponse("خطأ في الاستيراد: " + e.message);
  }
}

