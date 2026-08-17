// ════════════════════════════════════════════════════════════════
// Code_WhatsApp.gs — [REFACTOR-P4] نُقل من Code_Modules.gs (نقل نصي بحت، صفر
// تغيير في المنطق أو الترتيب الداخلي). Apps Script يعامل كل ملفات .gs
// كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء طالما
// الأسماء لم تتغير (ولم تتغير). راجع تقرير Architecture Audit
// 2026-07-03 — قسم 2 (Code_Modules.gs احتاج فحص لتحديد محتواه الفعلي).
//
// المسؤولية: واتساب Backend + مركز المحادثات (سجلات الإرسال، المحادثات، الرسائل، بيانات العملاء)
// ════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 30483-31201] WhatsApp Backend + Center ┄┄┄
// §WA-BACKEND — وحدة واتساب (Backend)
// ═══════════════════════════════════════════════════════════════════

/**
 * _writeWhatsAppLog — يكتب صفّاً مُهيكَلاً في شيت WhatsAppLog
 * (دالة داخلية مشتركة بين الإرسال الداخلي المُصادَق عليه والمشاركة العامة من الكتالوج)
 */
function _writeWhatsAppLog(entry) {
  try {
    var id = "WA-LOG-" + Utilities.getUuid().split("-")[0].toUpperCase();
    // [ARCH-AUDIT-P3-20] appendRow خام -> DataLayerEngine.insert
    DataLayerEngine.insert(
      "WhatsAppLog",
      {
        id: id,
        created_at: new Date(),
        sent_by: entry.sent_by || "",
        customer_id: entry.customer_id || "",
        customer_name: entry.customer_name || "",
        phone_used: entry.phone_used || "",
        template_code: entry.template_code || "",
        template_name: entry.template_name || "",
        rendered_message: String(entry.rendered_message || "").substring(
          0,
          1000,
        ),
        source_type: entry.source_type || "manual",
        source_id: entry.source_id || "",
        provider_mode: entry.provider_mode || "direct",
        status: entry.status || "opened",
        is_public: entry.is_public ? "TRUE" : "FALSE",
      },
      { headers: HEADERS.WhatsAppLog },
    );
    return id;
  } catch (e) {
    console.warn("WhatsAppLog write failed:", e.message);
    return null;
  }
}
/**
 * logWhatsappSend — يُسجّل عملية إرسال واتساب (من داخل النظام — مستخدم مُسجَّل دخول)
 *
 * يكتب في مكانين:
 *  1) WhatsAppLog — السجل المُهيكَل الرسمي (مصدر شاشة سجل الواتساب وتايملاين العميل)
 *  2) AuditLog    — للحفاظ على التوافق مع شاشة سجل التدقيق العام للأدمن
 *
 * يُستدعى من الـ frontend عبر _gsr("logWhatsappSend", [data, callerUser, sessionToken])
 */
function logWhatsappSend(data, callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(callerUser, "sendWhatsapp", sessionToken);
    if (permErr) return permErr;

    var d = data || {};

    var logId = _writeWhatsAppLog({
      sent_by: callerUser,
      customer_id: d.customer_id || "",
      customer_name: d.customer_name || "",
      phone_used: d.phone || "",
      template_code: d.template_code || "",
      template_name: d.template_name || "",
      rendered_message: d.message || "",
      source_type: d.source_type || "manual",
      source_id: d.source_id || "",
      provider_mode: d.provider || "direct",
      status: "opened",
      is_public: false,
    });

    AuditEngine.log("whatsapp_send", {
      user: callerUser,
      table: d.source_type || "whatsapp",
      record_id: d.source_id || d.customer_id || "",
      details: JSON.stringify({
        customer_id: d.customer_id || "",
        customer_name: d.customer_name || "",
        phone: d.phone || "",
        template_code: d.template_code || "",
        template_name: d.template_name || "",
        message: (d.message || "").substring(0, 500),
        source_type: d.source_type || "",
        source_id: d.source_id || "",
        provider: d.provider || "direct",
        wa_log_id: logId,
      })});

    return okResponse("تم تسجيل الإرسال", { id: logId });
  } catch (e) {
    console.error("logWhatsappSend:", e);
    return errResponse("خطأ في التسجيل: " + e.message);
  }
}
/**
 * logPublicCatalogWhatsapp — تسجيل مشاركة واتساب من صفحة الكتالوج العامة (CatalogPublic.html)
 *
 * هذه الصفحة عامة وغير مُصادَق عليها (لا يوجد callerUser/sessionToken) — لذلك:
 *  - لا فحص صلاحيات (الصفحة نفسها عامة بالتعريف)
 *  - أفضل-مجهود فقط (best-effort): أي خطأ هنا يجب ألا يكسر تجربة العميل العام إطلاقاً
 *  - يُسجَّل دائماً بـ is_public = true وبدون أي ربط بمستخدم نظام
 */
function logPublicCatalogWhatsapp(data) {
  try {
    var d = data || {};
    var logId = _writeWhatsAppLog({
      sent_by: "عميل (كتالوج عام)",
      customer_id: "",
      customer_name: d.customer_name || "زائر الكتالوج",
      phone_used: "", // الكتالوج العام لا يحدد رقماً — يفتح واتساب على رقم الشركة فقط
      template_code: "catalog_public",
      template_name: "مشاركة كتالوج عام",
      rendered_message: d.message || "",
      source_type: d.source_type || "catalog_public",
      source_id: d.source_id || "",
      provider_mode: "direct",
      status: "opened",
      is_public: true,
    });
    return okResponse("تم التسجيل", { id: logId });
  } catch (e) {
    // صامت تماماً — لا نريد أي تأثير على تجربة العميل العام
    return errResponse("تعذّر التسجيل");
  }
}
/**
 * getWhatsappLogs — يجلب سجلات الواتساب المُهيكَلة مع فلاتر بحث/تصفية
 * يُستخدم من شاشة "سجل الواتساب" وتايملاين تواصل العميل.
 *
 * @param {string} callerUser
 * @param {Object} filters
 *   customer_id  {string}  فلترة بعميل محدد (تُستخدم في تايملاين العميل)
 *   source_type  {string}  فلترة بنوع المصدر (invoice|customer|statement|payment_reminder|catalog_share|...)
 *   sent_by      {string}  فلترة بالمستخدم الذي أرسل
 *   dateFrom     {string}  ISO date
 *   dateTo       {string}  ISO date
 *   search       {string}  بحث نصي حر (اسم العميل / الرقم / الرسالة)
 *   limit        {number}  الحد الأقصى (افتراضي 50، أقصى 300)
 * @param {string} [sessionToken]
 */
function getWhatsappLogs(callerUser, filters, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "viewWhatsappLogs",
      sessionToken,
    );
    if (permErr) return permErr;

    filters = filters || {};
    var limit = Math.min(Number(filters.limit) || 50, 300);

    var rows = readSheet("WhatsAppLog", HEADERS.WhatsAppLog, {
      trimStrings: true,
    });

    // الأحدث أولاً
    rows.sort(function (a, b) {
      return String(b.created_at || "").localeCompare(
        String(a.created_at || ""),
      );
    });

    if (filters.customer_id) {
      rows = rows.filter(function (r) {
        return String(r.customer_id || "") === String(filters.customer_id);
      });
    }
    if (filters.source_type) {
      rows = rows.filter(function (r) {
        return r.source_type === filters.source_type;
      });
    }
    if (filters.sent_by) {
      rows = rows.filter(function (r) {
        return r.sent_by === filters.sent_by;
      });
    }
    if (filters.dateFrom) {
      var from = new Date(filters.dateFrom);
      rows = rows.filter(function (r) {
        return new Date(r.created_at) >= from;
      });
    }
    if (filters.dateTo) {
      var to = new Date(filters.dateTo);
      to.setHours(23, 59, 59);
      rows = rows.filter(function (r) {
        return new Date(r.created_at) <= to;
      });
    }
    if (filters.search) {
      var q = String(filters.search).toLowerCase();
      rows = rows.filter(function (r) {
        return (
          String(r.customer_name || "")
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.phone_used || "")
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.rendered_message || "")
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.source_id || "")
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.sent_by || "")
            .toLowerCase()
            .indexOf(q) !== -1
        );
      });
    }

    var total = rows.length;
    var stats = { total: total, bySourceType: {} };
    rows.forEach(function (r) {
      var k = r.source_type || "manual";
      stats.bySourceType[k] = (stats.bySourceType[k] || 0) + 1;
    });

    rows = rows.slice(0, limit).map(function (r) {
      delete r._row;
      return r;
    });

    return { success: true, data: rows, total: total, stats: stats };
  } catch (e) {
    console.error("getWhatsappLogs:", e);
    return errResponse("خطأ في جلب سجل الواتساب: " + e.message);
  }
}
/**
 * deleteWhatsappLog — حذف نهائي لسجل واحد من WhatsAppLog (من قائمة السياق
 * في شاشة "سجل الواتساب" — ctx_deleteWALog في 19_JS_WhatsApp.html).
 * يتطلب صلاحية manageWhatsappTemplates (نفس صلاحية إدارة قوالب الواتساب،
 * لأنها الصلاحية "الإدارية" المتاحة أصلاً لهذا الموديول).
 * يُسجَّل الحذف في AuditLog للحفاظ على التتبع.
 */
function deleteWhatsappLog(id, callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "manageWhatsappTemplates",
      sessionToken,
    );
    if (permErr) return permErr;
    if (!id) return errResponse("معرّف السجل مطلوب");

    var sheet = getSheet("WhatsAppLog", HEADERS.WhatsAppLog);
    var rows = readSheet("WhatsAppLog", HEADERS.WhatsAppLog, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("السجل غير موجود");

    var target = rows[idx];
    sheet.deleteRow(idx + 2);

    AuditEngine.log("whatsapp_log_delete", {
      user: callerUser,
      table: "WhatsAppLog",
      record_id: id,
      details: JSON.stringify({
        customer_name: target.customer_name || "",
        phone_used: target.phone_used || "",
        source_type: target.source_type || "",
      })});

    return okResponse("تم حذف السجل بنجاح");
  } catch (e) {
    console.error("deleteWhatsappLog:", e);
    return errResponse("خطأ في حذف السجل: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// نهاية §WA-BACKEND
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// §WA-CENTER-BACKEND — Backend functions لمركز محادثات واتساب
// ═══════════════════════════════════════════════════════════════════

/**
 * getWAUnreadCount — عدد الرسائل غير المقروءة للمستخدم الحالي
 * يُستخدم لتحديث badge في Top Bar
 */
// ═══════════════════════════════════════════════════════════════════
// [UNIFY-COMMHUB-2026] توحيد مصدر البيانات — "مركز واتساب" القديم لم يعد
// له جدول بيانات خاص (WA_Conversations / WA_Messages). الشاشة القديمة
// (19_JS_WhatsApp.html) بقيت كما هي بدون أي تعديل في الواجهة، لكن كل
// الدوال تحتها بقت "غلاف توافقي" (compatibility wrapper) فوق نفس مصدر
// البيانات الحقيقي المستخدم في Communication Hub الجديد:
// CommHub_Conversations / CommHub_Messages (Code_11_CommunicationHub.js).
//
// السبب: كان عندنا 3 منظومات متوازية (راجع تقرير التدقيق) — اتنين منهم
// بيانات "شبح" (WA_Conversations لا يتغذى تلقائياً من أي مكان)، والثالثة
// (CommHub) هي الوحيدة المتصلة فعلياً بالـ Webhook/Bridge. توحيد الدوال
// هنا يعني: أي محادثة أو رسالة حقيقية (واردة عبر الـ Bridge، أو صادرة من
// أي شاشة) تظهر فوراً في كل الشاشات (القديمة والجديدة) لأنها بقيت نفس
// الصف في نفس الشيت — بدل تكرار وتفرّق البيانات.
//
// كمان: الإرسال (saveWAMessage) بقى يمر إجبارياً عبر _commHubSendReply
// (نفس مسار الإرسال الحقيقي في Communication Hub: Provider → Bridge،
// وعند الفشل يدخل صف في CommHub_Queue لإعادة المحاولة تلقائياً)، بدل ما
// كان بيكتفي بتسجيل الرسالة "كأنها اترسلت" في شيت محلي بدون إرسال فعلي.
// ═══════════════════════════════════════════════════════════════════

/** يحوّل صف CommHub_Conversations لشكل الحقول اللي شاشة "مركز واتساب" القديمة متوقّعاه */
function _waConvFromCommHub(r) {
  return {
    id: r.conversation_id,
    conversation_id: r.conversation_id,
    customer_id: r.customer_id || "",
    customer_name: r.contact_name || "",
    customer_phone: r.phone || "",
    assigned_to: r.assigned_to || "",
    status: r.status || "open",
    unread_count: Number(r.unread_count || 0),
    last_message: r.last_message_preview || "",
    last_message_time: r.last_message_at || "",
    pinned: r.pinned === true || r.pinned === "TRUE",
    updated_at: r.updated_at || "",
  };
}

/** يحوّل صف CommHub_Messages لشكل الحقول اللي شاشة "مركز واتساب" القديمة متوقّعاه */
function _waMsgFromCommHub(r) {
  return {
    id: r.message_id,
    conversation_id: r.conversation_id,
    direction: r.direction,
    content: r.content || "",
    type: r.type || "text",
    timestamp: r.created_at,
    status: r.status || "sent",
    sent_by: r.origin === "customer" ? "" : r.created_by || "",
    is_ai: r.origin === "ai",
    ai_confidence: r.ai_confidence || "",
    media_url: r.media_url || "",
    media_type: "",
  };
}

/**
 * getWAUnreadCount — عدد الرسائل غير المقروءة للمستخدم الحالي (badge Top Bar)
 * [UNIFY-COMMHUB-2026] المصدر الآن CommHub_Conversations.
 */
function getWAUnreadCount(callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "viewWhatsappCenter",
      sessionToken,
    );
    if (permErr) return { success: true, data: { count: 0 } }; // لا صلاحية → صفر هادئاً

    var role = _getUserRole(callerUser);
    var rows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS, {
      trimStrings: true,
    });
    var total = rows
      .filter(function (r) {
        if (!r.conversation_id) return false;
        if (role === "admin" || role === "supervisor") return true;
        return String(r.assigned_to || "") === callerUser;
      })
      .reduce(function (sum, r) {
        return sum + Number(r.unread_count || 0);
      }, 0);
    return { success: true, data: { count: total } };
  } catch (e) {
    console.error("getWAUnreadCount:", e);
    return { success: true, data: { count: 0 } };
  }
}
/**
 * getWAConversations — قائمة المحادثات مع فلاتر
 * [UNIFY-COMMHUB-2026] المصدر الآن CommHub_Conversations (نفس مصدر Communication Hub).
 */
function getWAConversations(callerUser, filters, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "viewWhatsappCenter",
      sessionToken,
    );
    if (permErr) return permErr;

    var role = _getUserRole(callerUser);
    var f = filters || {};
    var limit = Math.min(Number(f.limit) || 50, 200);

    var rows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS, {
      trimStrings: true,
    }).filter(function (r) {
      if (!r.conversation_id) return false;
      if (role !== "admin" && role !== "supervisor") {
        if (String(r.assigned_to || "") !== callerUser) return false;
      }
      if (f.status && r.status !== f.status) return false;
      if (f.search) {
        var q = String(f.search).toLowerCase();
        if (
          String(r.contact_name || "")
            .toLowerCase()
            .indexOf(q) < 0 &&
          String(r.phone || "").indexOf(q) < 0
        )
          return false;
      }
      return true;
    });

    rows.sort(function (a, b) {
      return (
        new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)
      );
    });

    var total = rows.length;
    rows = rows.slice(0, limit).map(_waConvFromCommHub);

    return { success: true, data: rows, total: total };
  } catch (e) {
    console.error("getWAConversations:", e);
    return errResponse("خطأ في جلب المحادثات: " + e.message);
  }
}
/**
 * getWAMessages — رسائل محادثة معينة مع Pagination
 * [UNIFY-COMMHUB-2026] المصدر الآن CommHub_Messages.
 */
function getWAMessages(callerUser, conversationId, page, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "viewWhatsappCenter",
      sessionToken,
    );
    if (permErr) return permErr;
    if (!conversationId) return errResponse("يجب تحديد رقم المحادثة");

    var pageNum = Math.max(1, Number(page) || 1);
    var limit = 30;

    var rows = readSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS, {
      trimStrings: true,
    }).filter(function (r) {
      return (
        String(r.conversation_id || "") === String(conversationId) &&
        r.message_id
      );
    });

    rows.sort(function (a, b) {
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });

    var total = rows.length;
    var start = Math.max(0, total - pageNum * limit);
    var end = total - (pageNum - 1) * limit;
    rows = rows.slice(start, end).map(_waMsgFromCommHub);

    return { success: true, data: rows, total: total, page: pageNum };
  } catch (e) {
    console.error("getWAMessages:", e);
    return errResponse("خطأ في جلب الرسائل: " + e.message);
  }
}
/**
 * saveWAMessage — حفظ وإرسال رسالة صادرة (من الموظف) من شاشة "مركز واتساب" القديمة
 * [UNIFY-COMMHUB-2026] بيمر إجبارياً على _commHubSendReply — نفس مسار الإرسال
 * الحقيقي (Provider → Bridge)، فهي دلوقتي بترسل فعلياً (مش مجرد تسجيل)،
 * ولو الإرسال فشل بتتسجل تلقائياً في CommHub_Queue لإعادة المحاولة
 * (Exponential Backoff) زي أي رسالة تانية من Communication Hub.
 */
function saveWAMessage(callerUser, data, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(callerUser, "replyWhatsapp", sessionToken);
    if (permErr) return permErr;

    var d = data || {};
    if (!d.conversation_id) return errResponse("يجب تحديد رقم المحادثة");
    if (!d.content) return errResponse("محتوى الرسالة مطلوب");

    var conv = _commHubGetConversationById(d.conversation_id);
    if (!conv) return errResponse("المحادثة غير موجودة");

    var result = _commHubSendReply(conv, {
      type: d.media_url ? "media" : "text",
      text: d.content,
      media_url: d.media_url || "",
      reply_to: null,
      origin: "human",
      created_by: callerUser,
    });

    // تسجيل في WhatsAppLog القديم (لسه مستخدم في تقارير/كشوف الحساب)
    _writeWhatsAppLog({
      sent_by: callerUser,
      customer_id: d.customer_id || conv.customer_id || "",
      customer_name: d.customer_name || conv.contact_name || "",
      phone_used: d.phone || conv.phone || "",
      rendered_message: d.content,
      source_type: "center",
      provider_mode: "commhub",
      status: result.success ? "sent" : "queued_retry",
      is_public: false,
    });

    if (!result.success) {
      // مش خطأ فادح — الرسالة اتحطت في طابور إعادة المحاولة تلقائياً
      return okResponse(
        "تعذّر الإرسال الفوري، تم وضع الرسالة في قائمة إعادة المحاولة",
        { id: result.message_id || "", queued: true },
      );
    }

    return okResponse("تم إرسال الرسالة", { id: result.message_id || "" });
  } catch (e) {
    console.error("saveWAMessage:", e);
    return errResponse("خطأ في حفظ الرسالة: " + e.message);
  }
}

/**
 * uploadWAAttachment — يرفع ملف مرفق (base64) على Google Drive في مجلد
 * "مرفقات واتساب" ويرجّع رابط مشاركة عام. يُستخدم من شاشة مركز واتساب
 * لإرفاق ملفات مع الرسائل — حل عملي يعمل مع أي مزوّد إرسال (direct wa.me
 * أو أي بوابة مستقبلية) لأن الملف يُشارَك كرابط داخل نص الرسالة، بدل
 * الاعتماد على إرسال وسائط ثنائي مباشر (غير متاح فعلياً مع wa.me).
 * @param {string} base64Data  محتوى الملف Base64 (بدون data: prefix)
 * @param {string} fileName
 * @param {string} mimeType
 */
function uploadWAAttachment(base64Data, fileName, mimeType, callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(callerUser, "sendWhatsappFiles", sessionToken);
    if (permErr) return permErr;

    if (!base64Data) return errResponse("لا يوجد ملف لرفعه");

    var safeName = String(fileName || "مرفق").replace(/[\\/:*?"<>|]/g, "_");

    // [FILE-ENGINE] موحّد الآن بالكامل عبر FileEngine.upload (تحقق + رفع +
    // فولدر + مشاركة) بدل رفع الفولدر بس. مرفقات واتساب مفيش عليها قيود
    // امتداد رسمية (قرار مقصود) — بنمرر allowedMap: null صراحةً عشان
    // FileEngine.validate يطبّق خريطة مفتوحة (بيتحقق من الحجم فقط) بدل ما
    // نتخطى التحقق يدويًا زي قبل كده.
    var result = FileEngine.upload(base64Data, safeName, mimeType, {
      allowedMap: FileEngine.DOCUMENT_MIME_MAP,
      folderPath: ["مرفقات واتساب"],
      public: true,
    });
    if (!result.success) return errResponse(result.error);

    AuditEngine.log("UPLOAD", {
      user: callerUser,
      table: "WA_Attachments",
      record_id: result.fileId,
      details: "رفع مرفق واتساب: " + safeName});

    return okResponse("تم رفع الملف بنجاح", {
      url: result.viewUrl,
      download_url: result.downloadUrl,
      name: result.fileName,
      mime_type: mimeType || "",
    });
  } catch (e) {
    return errResponse("خطأ في رفع الملف: " + e.message);
  }
}
/**
 * getWACustomerData — جلب بيانات ERP الكاملة لعميل من مركز الواتساب
 */
function getWACustomerData(callerUser, customerId, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "viewWhatsappCustomerData",
      sessionToken,
    );
    if (permErr) return permErr;
    if (!customerId) return errResponse("يجب تحديد رقم العميل");

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── بيانات العميل الأساسية ──
    var partiesSheet = ss.getSheetByName("Parties");
    var customer = null;
    if (partiesSheet) {
      var pData = partiesSheet.getDataRange().getValues();
      var pH = pData[0];
      var pColId = pH.indexOf("id");
      for (var i = 1; i < pData.length; i++) {
        if (String(pData[i][pColId]) === String(customerId)) {
          customer = {};
          pH.forEach(function (h, idx) {
            customer[h] = pData[i][idx];
          });
          break;
        }
      }
    }
    if (!customer) return errResponse("العميل غير موجود");

    // ── الرصيد من Journal ──
    var balance = _getPartyBalance(customerId);

    // ── آخر 5 فواتير ──
    var lastInvoices = [];
    var invSheet = ss.getSheetByName("Invoices");
    if (invSheet) {
      var invData = invSheet.getDataRange().getValues();
      var invH = invData[0];
      var invColParty = invH.indexOf("party_id");
      var invColDate = invH.indexOf("date");
      lastInvoices = invData
        .slice(1)
        .filter(function (r) {
          return String(r[invColParty] || "") === String(customerId);
        })
        .slice(-5)
        .map(function (r) {
          var obj = {};
          invH.forEach(function (h, idx) {
            obj[h] = r[idx];
          });
          return obj;
        })
        .reverse();
    }

    // ── آخر 3 معاملات (طلبات) ──
    var lastOrders = [];
    var txSheet = ss.getSheetByName("Transactions");
    if (txSheet) {
      var txData = txSheet.getDataRange().getValues();
      var txH = txData[0];
      var txColParty = txH.indexOf("party_id");
      lastOrders = txData
        .slice(1)
        .filter(function (r) {
          return String(r[txColParty] || "") === String(customerId);
        })
        .slice(-3)
        .map(function (r) {
          var obj = {};
          txH.forEach(function (h, idx) {
            obj[h] = r[idx];
          });
          return obj;
        })
        .reverse();
    }

    // ── تسجيل الوصول في AuditLog ──
    AuditEngine.log("wa_customer_data_viewed", {
      user: callerUser,
      table: "Parties",
      record_id: customerId,
      details: JSON.stringify({ screen: "wa_center" })});

    return {
      success: true,
      data: {
        id: customer.id,
        name: customer.name || customer.arabic_name || "",
        code: customer.code || "",
        phone: customer.phone || customer.mobile || "",
        balance: balance,
        lastInvoices: lastInvoices,
        lastOrders: lastOrders,
      },
    };
  } catch (e) {
    console.error("getWACustomerData:", e);
    return errResponse("خطأ في جلب بيانات العميل: " + e.message);
  }
}
/**
 * markWAMessagesRead — تحديد رسائل محادثة كمقروءة
 */
function markWAMessagesRead(callerUser, conversationId, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "viewWhatsappCenter",
      sessionToken,
    );
    if (permErr) return permErr;
    if (!conversationId) return errResponse("يجب تحديد رقم المحادثة");

    // [UNIFY-COMMHUB-2026] المصدر الآن CommHub_Conversations — نفس الدالة
    // المستخدمة من صندوق الوارد الجديد، فتصفير غير المقروء يظهر في الشاشتين معاً.
    _commHubTouchConversation(conversationId, { unread_count: 0 });
    return okResponse("تم تحديث حالة القراءة");
  } catch (e) {
    console.error("markWAMessagesRead:", e);
    return errResponse("خطأ: " + e.message);
  }
}
/**
 * deleteWAConversation — حذف محادثة (admin فقط)
 * [UNIFY-COMMHUB-2026] بيحذف من CommHub_Conversations/CommHub_Messages مباشرة
 * (نفس مصدر البيانات المستخدم في كل الشاشات) بدل الجداول القديمة الشبح.
 */
function deleteWAConversation(callerUser, conversationId, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "deleteWhatsappConversation",
      sessionToken,
    );
    if (permErr) return permErr;
    if (!conversationId) return errResponse("يجب تحديد رقم المحادثة");

    var convSheet = getSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS);
    var convRows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS);
    var convIdx = convRows.findIndex(function (r) {
      return String(r.conversation_id) === String(conversationId);
    });
    if (convIdx !== -1) convSheet.deleteRow(convIdx + 2);

    var msgSheet = getSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS);
    var msgRows = readSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS);
    // حذف بترتيب عكسي لتفادي انزلاق الفهارس عند deleteRow المتكرر
    for (var i = msgRows.length - 1; i >= 0; i--) {
      if (String(msgRows[i].conversation_id) === String(conversationId)) {
        msgSheet.deleteRow(i + 2);
      }
    }

    AuditEngine.log("wa_conversation_deleted", {
      user: callerUser,
      table: COMMHUB_CONV_SHEET,
      record_id: conversationId,
      details: JSON.stringify({ deleted_by: callerUser })});

    return okResponse("تم حذف المحادثة");
  } catch (e) {
    console.error("deleteWAConversation:", e);
    return errResponse("خطأ في حذف المحادثة: " + e.message);
  }
}
