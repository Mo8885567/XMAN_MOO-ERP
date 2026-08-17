// ════════════════════════════════════════════════════════════════
// Code_27_PurchaseOrders.gs — [REFACTOR-P3] نُقلت من Code_Inventory.gs
// (نقل نصي بحت لموديول أوامر الشراء §PURCHASE-ORDERS بالكامل،
// صفر تغيير في المنطق أو أسماء الدوال — كل الاستدعاءات القديمة
// فضلت تعمل زي ما هي لأن كل ملفات .gs بتتحمّل في Global Scope واحد
// في Apps Script). راجع تقرير Architecture Audit 2026-07-03 — القسم 4-أ.
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 31332-31676] Purchase Orders ┄┄┄
// §PURCHASE-ORDERS — أوامر الشراء (Purchase Orders)
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// [BUG-FIX] appendToSheet / updateSheetRow / deleteFromSheet / logAudit
// — هذه الدوال الأربعة كانت مُستخدَمة في كل عملية بهذا الملف (حفظ/اعتماد/
// استلام/تعديل/حذف أمر شراء) دون أن تكون معرّفة في أي مكان بالمشروع
// بالكامل — أي عملية أوامر شراء كانت تفشل فوراً بـ ReferenceError.
// أُضيفت هنا فوق البنية التحتية الموجودة فعلاً ومُستخدَمة في باقي
// الموديولات (getSheet / readSheet / findRow / _appendRowProtected /
// _writeAuditLog) بدل اختراع منطق جديد.
// ─────────────────────────────────────────────────────────────────────

// appendToSheet — يضيف صفاً جديداً؛ headers=null يعني استخدام هيدرز
// الشيت الفعلية كما هي (مستخدم هنا مع "Transactions" التي لها هيدرز
// خاصة بها معرّفة في مكان آخر من المشروع)
function appendToSheet(sheetName, headers, rowObj) {
  var sheet = getSheet(sheetName, headers);
  var hdrs = headers;
  if (!hdrs || !hdrs.length) {
    hdrs = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map(function (h) {
        return String(h || "").trim();
      });
  }
  var row = hdrs.map(function (h) {
    return rowObj[h] !== undefined ? rowObj[h] : "";
  });
  _appendRowProtected(sheet, hdrs, row);
}

// updateSheetRow — يحدّث الحقول المذكورة فقط في updates لصف مطابق id
function updateSheetRow(sheetName, headers, id, updates) {
  // [ENGINE-UNIFY-FIX] كانت هنا بتعمل loop وتكتب خلية خلية بـ setValue()
  // منفصلة لكل حقل (منطق محلي مكرر ومختلف عن باقي النظام، وبدون القفل/
  // الكتابة الدفعية اللي موجودة في _applyRowUpdates الموحّدة). دلوقتي
  // بتستخدم _applyRowUpdates (Code_12_Core.js) زي باقي الـ 14+ ملف في
  // المشروع — نداء واحد بـ setValues() بدل نداء منفصل لكل حقل.
  var sheet = getSheet(sheetName, headers);
  var rows = readSheet(sheetName, headers);
  var target = findRow(rows, "id", id);
  if (!target) throw new Error("السجل غير موجود: " + id);
  _applyRowUpdates(sheet, target._row, headers, updates);
}

// deleteFromSheet — حذف فعلي لصف مطابق id (يُستخدم فقط هنا على مسودات
// أوامر شراء لم تُعتمد بعد — راجع الفحص في deletePurchaseOrder أعلاه)
function deleteFromSheet(sheetName, id) {
  var sheet = getSheet(sheetName);
  var rows = readSheet(sheetName);
  var target = findRow(rows, "id", id);
  if (!target) throw new Error("السجل غير موجود: " + id);
  sheet.deleteRow(target._row);
}

// logAudit — غلاف متوافق فوق _writeAuditLog الموحّدة بنفس ترتيب المعطيات
// المستخدم في هذا الملف: (user, action, table, record_id, old, new)
function logAudit(user, action, table, recordId, oldValue, newValue) {
  AuditEngine.log(action, {
    user: user,
    table: table,
    record_id: recordId,
    oldValue: oldValue,
    newValue: newValue});
}

var PURCHASE_ORDER_HEADERS = [
  "id",
  "date",
  "supplier",
  "warehouse",
  "payment_terms",
  "expected_date",
  "notes",
  "status",
  "discount_value",
  "discount_type",
  "discount_amount",
  "vat_percent",
  "vat_amount",
  "subtotal",
  "net_total",
  "lines_count",
  "lines_json",
  "created_by",
  "created_at",
  "updated_at",
  // ── [PO-INVOICE-LINK] ربط أمر الشراء بفاتورة/فواتير الشراء الناتجة عنه ──
  "invoiced_status", // لم يُفوتر | مفوتر جزئياً | مفوتر بالكامل
  "invoiced_amount", // إجمالي المفوتر فعلياً من قيمة الأمر
  "invoice_ids", // قائمة مفصولة بفاصلة بمعرّفات فواتير الشراء المرتبطة
  "last_receive_permit_id", // آخر رقم إذن استلام (RECV-...) — يُستخدم لتجهيز بنود فاتورة الشراء تلقائيًا
];

// getPurchaseOrders — جلب كل أوامر الشراء
function getPurchaseOrders() {
  try {
    var rows = readSheet("PurchaseOrders", PURCHASE_ORDER_HEADERS, {
      parseJson: ["lines_json"],
    });
    // نحوّل lines_json إلى lines في الـ response عشان الـ frontend
    rows.forEach(function (r) {
      if (!r.lines) r.lines = Array.isArray(r.lines_json) ? r.lines_json : [];
    });
    return { success: true, data: cleanArr(rows) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// savePurchaseOrder — إنشاء أمر شراء جديد (مسودة)
// [P9-FIX] إضافة _checkPermission فعلي — كان _getUserFromToken يُعيد username فقط دون فحص صلاحية
function savePurchaseOrder(data, sessionToken) {
  try {
    if (!data || !ValidationEngine.isRequired(data.supplier))
      return { success: false, message: "المورد مطلوب" };
    if (!ValidationEngine.isRequired(data.lines) || !data.lines.length)
      return { success: false, message: "أضف بنداً واحداً على الأقل" };

    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "addPurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };
    var now = new Date().toISOString();
    // [AUDIT-FIX] كان يعتمد على Date.now() مباشرة بدل المحرك المركزي —
    // نادر لكنه يفتح احتمال تصادم عند حفظ متزامن بنفس المللي ثانية.
    var id = makeId("PO");

    var row = {
      id: id,
      date: data.date || now.split("T")[0],
      supplier: data.supplier,
      warehouse: data.warehouse || "",
      payment_terms: data.payment_terms || "",
      expected_date: data.expected_date || "",
      notes: data.notes || "",
      status: "مسودة",
      discount_value: Number(data.discount_value || 0),
      discount_type: data.discount_type || "percent",
      discount_amount: Number(data.discount_amount || 0),
      vat_percent: Number(data.vat_percent || 0),
      vat_amount: Number(data.vat_amount || 0),
      subtotal: Number(data.subtotal || 0),
      net_total: Number(data.net_total || 0),
      lines_count: (data.lines || []).length,
      lines_json: JSON.stringify(data.lines || []),
      created_by: user,
      created_at: now,
      updated_at: now,
      invoiced_status: "لم يُفوتر",
      invoiced_amount: 0,
      invoice_ids: "",
    };

    appendToSheet("PurchaseOrders", PURCHASE_ORDER_HEADERS, row);
    logAudit(user, "إنشاء أمر شراء", "PurchaseOrders", id, null, row);

    var result = Object.assign({}, row, { lines: data.lines || [] });
    return { success: true, data: result, message: "تم حفظ أمر الشراء بنجاح" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// [P9-FIX] إضافة _checkPermission فعلي
function approvePurchaseOrder(id, sessionToken) {
  try {
    if (!ValidationEngine.isRequired(id)) return { success: false, message: "رقم الأمر مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "addPurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };
    var now = new Date().toISOString();

    var rows = readSheet("PurchaseOrders", PURCHASE_ORDER_HEADERS);
    var rowIdx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (rowIdx === -1)
      return { success: false, message: "أمر الشراء غير موجود" };

    var order = rows[rowIdx];
    // [WORKFLOW-ENGINE] التحقق من صحة الانتقال بقى عبر آلة الحالة الموحّدة
    // (Code_39_WorkflowEngine.gs) بدل الشرط اليدوي المكرر — نفس رسالة
    // "لا يمكن اعتماد أمر في حالة: ..." بالضبط، لأن الانتقال الوحيد المعرَّف
    // من "مسودة" فعليًا هو approve، فأي حالة تانية هترجع نفس الرفض.
    var wf = WorkflowEngine.canTransition("PurchaseOrder", order.status, "approve");
    if (!wf.allowed)
      return {
        success: false,
        message: "لا يمكن اعتماد أمر في حالة: " + order.status,
      };

    updateSheetRow("PurchaseOrders", PURCHASE_ORDER_HEADERS, id, {
      status: wf.nextState,
      updated_at: now,
    });

    logAudit(
      user,
      "اعتماد أمر شراء",
      "PurchaseOrders",
      id,
      { status: "مسودة" },
      { status: wf.nextState },
    );
    return {
      success: true,
      data: { id: id, status: "معتمد" },
      message: "تم اعتماد الأمر",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// receivePurchaseOrder — تسجيل استلام البضاعة (ينشئ حركات وارد IN)
function receivePurchaseOrder(data, sessionToken) {
  try {
    if (!data || !ValidationEngine.isRequired(data.po_id))
      return { success: false, message: "رقم أمر الشراء مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "addTransaction", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };
    var now = new Date().toISOString();
    var poId = data.po_id;

    // [FIX-PO-REVIEW-①] كانت الدالة تقرأ حالة الأمر، تتحقق أنها "معتمد"،
    // ثم تُنشئ حركات وارد + قيد GRNI، ثم تكتب الحالة الجديدة — كل ذلك بدون
    // أي قفل ذري وبدون إعادة قراءة الحالة من جوه القفل. ضغطتان متزامنتان
    // (تبويبان مفتوحان) على "استلام" لنفس الأمر كانتا تتجاوزان الفحص معًا
    // فينشأ استلام مزدوج (حركة وارد IN مكررة + قيد GRNI مكرر). الحل: قفل
    // ذري حول القراءة-الفحص، مع كتابة الحالة الجديدة فورًا جوه القفل قبل
    // إنشاء أي حركة، بحيث لا تمر أي محاولة ثانية متزامنة من الفحص إطلاقًا.
    var order, wfRecv, permitId;
    var _poReceiveLock = LockService.getScriptLock();
    try {
      _poReceiveLock.waitLock(10000);
    } catch (lockErr) {
      return {
        success: false,
        message: "النظام مشغول باستلام أمر آخر لنفس الطلب، حاول مرة أخرى",
      };
    }
    try {
      var rows = readSheet("PurchaseOrders", PURCHASE_ORDER_HEADERS);
      var rowIdx = rows.findIndex(function (r) {
        return r.id === poId;
      });
      if (rowIdx === -1)
        return { success: false, message: "أمر الشراء غير موجود" };

      order = rows[rowIdx];
      // [WORKFLOW-ENGINE] نفس مبدأ approvePurchaseOrder أعلاه — التحقق عبر
      // آلة الحالة الموحّدة بدل تكرار الشرط. رسالة الرفض اتسابت زي ما هي
      // بالضبط لأنها أوضح للمستخدم من رسالة WorkflowEngine العامة.
      wfRecv = WorkflowEngine.canTransition("PurchaseOrder", order.status, "receive");
      if (!wfRecv.allowed)
        return { success: false, message: "يجب اعتماد الأمر أولاً قبل الاستلام" };

      // [FIX-2026-07-21 / تقرير التدقيق §4] كانت هذه الشاشة الوحيدة التي
      // تُنشئ حركة مخزون فعلية دون فحص إغلاق الفترة المحاسبية — نفس النمط
      // المستخدم في Sales.js وInventory.js.
      var _periodErrRecv = _blockIfPeriodClosed(
        data.date || now.split("T")[0],
        "استلام أمر شراء",
      );
      if (_periodErrRecv) return _periodErrRecv;

      // [FIX-POSTING-AUDIT §1] كانت حركة الاستلام تُنفَّذ وتُحدَّث المخزون فعلياً
      // حتى لو غاب حساب المخزون أو حساب GRNI من دليل الحسابات — فينتج استلام
      // مخزون حقيقي بدون أي أثر في الدفاتر (قيد ناقص/غائب بصمت). الحل: نتحقق
      // إلزامياً من الحسابين *قبل* إنشاء أي حركة مخزون أو تحديث لحالة الأمر،
      // فإن غابا يُرفض الاستلام بالكامل برسالة واضحة، بدل حفظ جزئي.
      var _accountsForRecv = readSheet(
        "ChartOfAccounts",
        ACCOUNTING_HR_HEADERS.ChartOfAccounts,
      );
      var _recvInventoryAccount, _recvGrniAccount;
      try {
        _recvInventoryAccount = requirePostingAccount(
          {
            accounts: _accountsForRecv,
            key: "inventory_account",
            type: "ASSET",
            hints: ["مخزون", "بضاعة", "inventory", "stock"],
          },
          "حساب المخزون",
        ).account;
        _recvGrniAccount = requirePostingAccount(
          {
            accounts: _accountsForRecv,
            key: "grni_account",
            type: "LIABILITY",
            hints: [
              "بضاعة مستلمة غير مفوترة",
              "GRNI",
              "goods received not invoiced",
            ],
          },
          "حساب بضاعة مستلمة غير مفوترة (GRNI)",
        ).account;
      } catch (postingSetupErr) {
        return { success: false, message: postingSetupErr.message };
      }

      permitId = "RECV-" + poId + "-" + Date.now();

      // تحديث حالة الأمر إلى مستلم فورًا جوه القفل — قبل إنشاء أي حركة
      // مخزون أو قيد محاسبي — لضمان عدم مرور أي محاولة استلام ثانية متزامنة
      // من فحص الحالة أعلاه.
      updateSheetRow("PurchaseOrders", PURCHASE_ORDER_HEADERS, poId, {
        status: wfRecv.nextState,
        updated_at: now,
        last_receive_permit_id: permitId,
      });
    } finally {
      _poReceiveLock.releaseLock();
    }

    // إنشاء حركات وارد لكل بند
    var txns = [];
    var lines = data.lines || [];
    lines.forEach(function (line) {
      if (!ValidationEngine.isRequired(line.item_id) || !ValidationEngine.isPositive(line.qty)) return;
      var txId =
        "TX-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      var tx = {
        id: txId,
        type: "IN",
        date: data.date || now.split("T")[0],
        item_id: line.item_id,
        quantity: Number(line.qty),
        to_warehouse: data.warehouse || order.warehouse || "",
        party: data.supplier || order.supplier || "",
        permit_id: permitId,
        notes:
          "استلام من أمر شراء رقم: " +
          poId +
          (data.notes ? " — " + data.notes : ""),
        user: user,
        created_at: now,
        color: line.color || "",
      };
      appendToSheet("Transactions", null, tx);
      txns.push(tx);
    });

    // [FIX-2026-07-21 / تقرير التدقيق §4-المشكلة 2] قيد GRNI عند الاستلام —
    // البضاعة بقت أصلاً فعليًا مملوكاً للمنشأة رغم عدم وصول الفاتورة بعد،
    // فلازم يظهر أثرها في الميزانية فورًا: مدين مخزون (أصل حقيقي دخل)
    // / دائن GRNI (التزام مؤقت لحد ما توصل فاتورة المورد وتُقفله).
    // [FIX-POSTING-AUDIT §1] الحسابان تم التحقق منهما إلزامياً أعلاه (قبل إنشاء
    // أي حركة مخزون)، فلا حاجة لأي فرع "صامت" هنا — القيد يُنشأ دائماً متى
    // كانت هناك قيمة استلام، وأي خطأ غير متوقع يُرفع بوضوح بدل إخفائه.
    var _recvTotalValue = lines.reduce(function (sum, l) {
      return sum + Number(l.qty || 0) * Number(l.unit_price || 0);
    }, 0);
    if (_recvTotalValue > 0) {
      // [ITEM-POSTING-WIRE-GAP-FIX-2026-08-08] كان قيد GRNI بيترحّل بالكامل
      // على حساب المخزون العام (_recvInventoryAccount) بغض النظر عن كل
      // صنف — نفس فجوة autoJournalFromPurchase. الحل: نجمّع بنود الاستلام
      // حسب inventory_account_id الخاص بكل صنف (لو معرَّف)، ونولّد سطر
      // مدين مستقل لكل حساب مخزون مختلف ظهر، بنفس أسلوب تجميع COGS
      // المستخدم في مسار الفواتير.
      var _itemsForRecv = readSheet("Items", ACCOUNTING_HR_HEADERS.Items);
      var _itemsByIdRecv = {};
      _itemsForRecv.forEach(function (it) {
        _itemsByIdRecv[it.id] = it;
        if (it.code) _itemsByIdRecv[it.code] = it;
      });
      var _accountsByIdRecv = _buildAccountsByIdMap(_accountsForRecv);
      var _invLinesByAccount = {};
      lines.forEach(function (line) {
        if (!ValidationEngine.isRequired(line.item_id) || !ValidationEngine.isPositive(line.qty)) return;
        var lineValue = Number(line.qty || 0) * Number(line.unit_price || 0);
        if (lineValue <= 0) return;
        var itRec = _itemsByIdRecv[line.item_id];
        var resolvedInvAcc = resolveItemLevelAccount(
          itRec, "inventory_account_id", _accountsByIdRecv, "ASSET", _recvInventoryAccount,
        ) || _recvInventoryAccount;
        var k = resolvedInvAcc.id;
        _invLinesByAccount[k] = (_invLinesByAccount[k] || 0) + lineValue;
      });
      var _grniDebitLines = Object.keys(_invLinesByAccount).map(function (accId) {
        return {
          account_id: accId,
          debit: _invLinesByAccount[accId],
          credit: 0,
          notes: "بضاعة مستلمة — أمر شراء " + poId,
        };
      });
      // fallback دفاعي: لو لأي سبب مفيش بنود صالحة اتجمّعت (لا يفترض يحصل
      // طالما _recvTotalValue > 0)، نرجع لسطر واحد بالحساب العام بدل
      // فقدان توازن القيد صامتاً.
      if (_grniDebitLines.length === 0) {
        _grniDebitLines.push({
          account_id: _recvInventoryAccount.id,
          debit: _recvTotalValue,
          credit: 0,
          notes: "بضاعة مستلمة — أمر شراء " + poId,
        });
      }
      var _grniResult = _addJournalEntryInternal({
        callerUser: user,
        date: data.date || now.split("T")[0],
        reference: permitId,
        description: "استلام أمر شراء (GRNI) — " + (order.supplier || ""),
        source_type: "PO_RECEIPT_GRNI",
        lines: _grniDebitLines.concat([
          {
            account_id: _recvGrniAccount.id,
            debit: 0,
            credit: _recvTotalValue,
            notes: "التزام مؤقت لحد وصول فاتورة المورد",
            party_type: "supplier",
            party_id: _resolvePartyIdByName(order.supplier, "supplier"),
          },
        ]),
      });
      if (_grniResult && _grniResult.success === false) {
        // فشل الترحيل (مثلاً إغلاق فترة محاسبية) — لا نُكمِّل الاستلام صامتاً
        return {
          success: false,
          message:
            "تعذّر ترحيل قيد GRNI: " +
            (_grniResult.message || "خطأ غير معروف") +
            " — لم يتم حفظ الاستلام.",
        };
      }
    }

    logAudit(
      user,
      "استلام أمر شراء",
      "PurchaseOrders",
      poId,
      { status: "معتمد" },
      { status: wfRecv.nextState, permit: permitId },
    );
    return {
      success: true,
      data: { id: poId, status: "مستلم", transactions: txns },
      message: "تم تسجيل الاستلام وتحديث المخزن",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// cancelPurchaseOrder — إلغاء أمر شراء (من "مسودة" أو "معتمد" فقط —
// غير مسموح إلغاء أمر تم استلامه بالفعل لأن الاستلام أنشأ حركات مخزون
// فعلية "IN" بالفعل؛ لو محتاج تراجع عن أمر مُستلم فده يحتاج مردود شراء
// وليس إلغاء).
// [WORKFLOW-ENGINE] أول استخدام فعلي لـ WorkflowEngine.transition() في
// المشروع (approvePurchaseOrder/receivePurchaseOrder فوق بيكتفوا بـ
// canTransition للتحقق فقط ثم بيكتبوا الحالة يدويًا عبر updateSheetRow —
// انظر ERP_GAP_ANALYSIS_AND_IMPROVEMENT_PLAN.md القسم 3). هنا استخدمنا
// transition() كاملة: بتتحقق من صحة الانتقال، تكتب الحالة الجديدة عبر
// RepositoryLayer.PurchaseOrders (Code_38 → DataLayer Code_34)، وتسجّل
// Audit Log تلقائيًا — من غير ما نكرر أي من الخطوات التلاتة دي يدويًا.
function cancelPurchaseOrder(id, sessionToken) {
  try {
    if (!ValidationEngine.isRequired(id)) return { success: false, message: "رقم الأمر مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "deletePurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };

    var rows = readSheet("PurchaseOrders", PURCHASE_ORDER_HEADERS);
    var order = rows.find(function (r) {
      return r.id === id;
    });
    if (!order) return { success: false, message: "أمر الشراء غير موجود" };

    var wf = WorkflowEngine.canTransition("PurchaseOrder", order.status, "cancel");
    if (!wf.allowed) {
      var msg =
        order.status === "مستلم"
          ? "لا يمكن إلغاء أمر تم استلامه بالفعل — البضاعة دخلت المخزن فعلياً"
          : "لا يمكن إلغاء أمر في حالة: " + order.status;
      return { success: false, message: msg };
    }

    var res = WorkflowEngine.transition({
      workflow: "PurchaseOrder",
      table: "PurchaseOrders",
      recordId: id,
      currentState: order.status,
      action: "cancel",
      user: user,
      details: "إلغاء أمر شراء رقم: " + id,
    });
    if (!res.success) return res;

    return {
      success: true,
      data: { id: id, status: res.data.status },
      message: "تم إلغاء أمر الشراء",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// updatePurchaseOrder — تعديل أمر شراء (مسودة فقط)
function updatePurchaseOrder(data, sessionToken) {
  try {
    if (!data || !ValidationEngine.isRequired(data.id))
      return { success: false, message: "رقم الأمر مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };
    var permErr = _checkPermission(user, "addPurchaseInvoice", sessionToken);
    if (permErr)
      return { success: false, message: permErr.message, code: permErr.code };
    var now = new Date().toISOString();

    var rows = readSheet("PurchaseOrders", PURCHASE_ORDER_HEADERS);
    var order = rows.find(function (r) {
      return r.id === data.id;
    });
    if (!order) return { success: false, message: "أمر الشراء غير موجود" };
    if (order.status !== "مسودة")
      return {
        success: false,
        message: "لا يمكن تعديل أمر في حالة: " + order.status,
      };

    var updates = {
      supplier: data.supplier || order.supplier,
      warehouse: data.warehouse || order.warehouse,
      payment_terms: data.payment_terms || order.payment_terms,
      expected_date: data.expected_date || order.expected_date,
      notes: data.notes !== undefined ? data.notes : order.notes,
      discount_value: Number(
        data.discount_value !== undefined
          ? data.discount_value
          : order.discount_value,
      ),
      discount_type: data.discount_type || order.discount_type,
      discount_amount: Number(
        data.discount_amount !== undefined
          ? data.discount_amount
          : order.discount_amount,
      ),
      vat_percent: Number(
        data.vat_percent !== undefined ? data.vat_percent : order.vat_percent,
      ),
      vat_amount: Number(
        data.vat_amount !== undefined ? data.vat_amount : order.vat_amount,
      ),
      subtotal: Number(
        data.subtotal !== undefined ? data.subtotal : order.subtotal,
      ),
      net_total: Number(
        data.net_total !== undefined ? data.net_total : order.net_total,
      ),
      lines_count: data.lines ? data.lines.length : order.lines_count,
      lines_json: data.lines ? JSON.stringify(data.lines) : order.lines_json,
      updated_at: now,
    };

    updateSheetRow("PurchaseOrders", PURCHASE_ORDER_HEADERS, data.id, updates);
    logAudit(user, "تعديل أمر شراء", "PurchaseOrders", data.id, order, updates);
    return {
      success: true,
      data: Object.assign({}, order, updates),
      message: "تم تحديث الأمر",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// deletePurchaseOrder — حذف أمر شراء (مسودة أو ملغي فقط)
// [UNIFY-DELETE] نُقلت لتستخدم DeleteEngine الموحّد بدل الحذف اليدوي
// المباشر (deleteFromSheet). نفس فحص الصلاحية (deletePurchaseInvoice) ونفس
// فحص الحالة (معتمد/مستلم) موجودين الآن في DeleteConfig.purchaseOrder
// (Code_44_DeleteEngine.js) بدل ما يتكرروا هنا. صفر تغيير في السلوك
// الظاهر للمستخدم — رسائل الخطأ واللوجيك نفسه بالظبط.
function deletePurchaseOrder(id, sessionToken) {
  try {
    if (!ValidationEngine.isRequired(id)) return { success: false, message: "رقم الأمر مطلوب" };
    var user = _getUserFromToken(sessionToken);
    if (!user)
      return {
        success: false,
        message: " جلستك انتهت — يرجى تسجيل الدخول مجدداً",
        code: "SESSION_INVALID",
      };

    var r = DeleteEngine.delete("purchaseOrder", id, user, sessionToken);
    return { success: r.success, message: r.message, code: r.code };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// [PO-INVOICE-LINK] _applyInvoiceToPurchaseOrder — تُستدعى من
// addPurchaseInvoice (Code_20_Sales.js) بعد نجاح حفظ فاتورة شراء مرتبطة
// بأمر شراء (invoiceData.po_id). بتحدّث invoiced_status/invoiced_amount/
// invoice_ids على أمر الشراء نفسه — بدون أي تأثير على الفواتير القديمة
// التي لا ترسل po_id (الحقل اختياري بالكامل).
function _applyInvoiceToPurchaseOrder(poId, invoiceId, invoiceNetTotal) {
  if (!poId) return;
  try {
    var rows = readSheet("PurchaseOrders", PURCHASE_ORDER_HEADERS);
    var order = rows.find(function (r) {
      return r.id === poId;
    });
    if (!order) return;

    var prevAmount = Number(order.invoiced_amount || 0);
    var newAmount = prevAmount + Number(invoiceNetTotal || 0);
    var poTotal = Number(order.net_total || 0);
    var prevIds = String(order.invoice_ids || "")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    if (prevIds.indexOf(invoiceId) === -1) prevIds.push(invoiceId);

    var status = "مفوتر جزئياً";
    if (poTotal > 0 && newAmount >= poTotal) status = "مفوتر بالكامل";
    if (newAmount <= 0) status = "لم يُفوتر";

    updateSheetRow("PurchaseOrders", PURCHASE_ORDER_HEADERS, poId, {
      invoiced_status: status,
      invoiced_amount: newAmount,
      invoice_ids: prevIds.join(","),
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    Logger.log("[PO-INVOICE-LINK] فشل تحديث حالة فوترة الأمر " + poId + ": " + e.message);
  }
}

// ─── helper: استخراج المستخدم من الـ session token ──────────
function _getUserFromToken(token) {
  if (!token) return null;
  try {
    var sessions =
      PropertiesService.getScriptProperties().getProperty("SESSIONS");
    if (!sessions) return null;
    var obj = JSON.parse(sessions);
    for (var u in obj) {
      if (obj[u] && obj[u].token === token) return u;
    }
  } catch (e) {
    Logger.log("[silent-catch] " + e);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// نهاية §PURCHASE-ORDERS
