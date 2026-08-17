// ════════════════════════════════════════════════════════════════
// Code_CommunicationHub.gs — [COMMHUB-P2] قلب Communication Hub.
// راجع COMMUNICATION_HUB_SPEC.md (Phase 0) للعقد الكامل قبل أي تعديل هنا.
//
// المسؤولية:
//   - استقبال Webhooks من الـ Bridge (رسائل واردة + أحداث اتصال) والتحقق
//     من توقيعها (HMAC — راجع ملاحظة GAS في Code_CommHub_Providers.gs)
//   - Conversations/Messages/Queue الموسّعة (فوق Code_WhatsApp.gs، بدون
//     كسره — هو لسه بيخدم شاشات الواتساب القديمة WA_Conversations/WA_Messages)
//   - Human Handover (AI/Human/Hybrid) + Escalation التلقائي
//   - Internal Inbox backend functions
//   - Dashboard backend functions
//
// قاعدة صارمة (من العقد): الـ Hub الوحيد اللي بيتكلم مع Providers، عن
// طريق _commHubGetProvider() فقط. مفيش أي تفاصيل واتساب هنا مباشرة.
// ════════════════════════════════════════════════════════════════

// ── تعريفات الشيتات ─────────────────────────────────────────────

var COMMHUB_CONV_SHEET = "CommHub_Conversations";
var COMMHUB_CONV_HEADERS = [
  "conversation_id",
  "provider",
  "chat_id",
  "customer_id",
  "contact_name",
  "phone",
  "mode", // ai_only / human_only / hybrid
  "assigned_to",
  "status", // open / pending / resolved / archived
  "labels",
  "pinned",
  "unread_count",
  "ai_reply_count",
  "last_message_at",
  "last_message_preview",
  "created_at",
  "updated_at",
  "pending_reason", // [PHASE4-NOTIF] آخر سبب تصعيد لتدخل بشري — Additive
];

var COMMHUB_MSG_SHEET = "CommHub_Messages";
var COMMHUB_MSG_HEADERS = [
  "message_id",
  "conversation_id",
  "direction", // in / out
  "origin", // customer / ai / human / system
  "type",
  "content",
  "media_url",
  "status", // sent/delivered/read/failed/suggested
  "ai_confidence",
  "provider_message_id",
  "reply_to",
  "created_by",
  "created_at",
];

var COMMHUB_QUEUE_SHEET = "CommHub_Queue";
var COMMHUB_QUEUE_HEADERS = [
  "queue_id",
  "queue_type", // incoming / outgoing / retry / dlq
  "payload", // JSON نصي
  "attempts",
  "next_retry_at",
  "status", // pending / processing / done / failed
  "last_error",
  "created_at",
  "updated_at",
];

var COMMHUB_SETTINGS_SHEET = "CommHub_Settings";
var COMMHUB_SETTINGS_HEADERS = [
  "id",
  "auto_reply_enabled",
  "working_hours_start",
  "working_hours_end",
  "greeting_message",
  "away_message",
  "max_ai_replies_per_conversation",
  "confidence_threshold",
  "escalation_keywords", // مفصولة بفاصلة
  "blacklist_numbers",
  "whitelist_numbers",
  "updated_at",
  "updated_by",
  "default_mode", // [FIX] لازم يفضل آخر عمود — getSheet بيضيف أي عمود جديد
  // فعليًا آخر الشيت، فلو اتحط في نص المصفوفة الكتابة الـ positional في
  // saveCommHubSettings هتتزاح وتبوّظ باقي الأعمدة على الشيتات الموجودة بالفعل
];

var COMMHUB_RETRY_BACKOFF_SECONDS = [30, 120, 600, 1800, 3600]; // 30ث، 2د، 10د، 30د، 60د — 5 محاولات

// ═══════════════════════════════════════════════════════════════════
// §1 — Webhook Entry Point (يُستدعى من doPost في Code_Core.gs)
// ═══════════════════════════════════════════════════════════════════

/**
 * commHubHandleWebhook — نقطة الدخول الوحيدة لأي حدث قادم من أي Bridge.
 * يُستدعى من doPost مباشرة (خارج آلية {fn,args} العادية) لأن الطلب
 * قادم من نظام خارجي بدون جلسة مستخدم — التوثيق هنا HMAC فقط.
 *
 * الشكل المتوقع لـ payload (راجع ملاحظة GAS في Code_CommHub_Providers.gs):
 * { hub_event: true, provider: "whatsapp", event: "message.incoming",
 *   timestamp: 1751700000, signature: "...", data: {...} }
 *
 * @returns {Object} يُحوَّل مباشرة إلى JSON في doPost — {success, ...}
 *   مع http_status اختياري يستخدمه doPost لتحديد كود HTTP الراجع.
 */
function commHubHandleWebhook(payload) {
  try {
    var p = payload || {};
    var providerKey = p.provider;
    var event = p.event;
    var timestamp = Number(p.timestamp || 0);
    var signature = p.signature;
    var data = p.data || {};

    if (!providerKey || !event || !signature || !timestamp) {
      return { success: false, http_status: 422, message: "Payload ناقص" };
    }

    var cfg = _commHubReadProviderConfig(providerKey);
    if (!cfg || !cfg.webhook_secret) {
      return { success: false, http_status: 401, message: "قناة غير مُعدّة" };
    }

    // منع Replay Attack — رفض أي timestamp أقدم من 5 دقايق
    var nowSeconds = Math.floor(new Date().getTime() / 1000);
    if (Math.abs(nowSeconds - timestamp) > 300) {
      return { success: false, http_status: 403, message: "Timestamp منتهي" };
    }

    // التحقق من التوقيع
    var expected = _commHubComputeSignature(
      timestamp,
      data,
      cfg.webhook_secret,
    );
    if (expected !== signature) {
      return { success: false, http_status: 403, message: "توقيع غير صحيح" };
    }

    // ── توزيع الحدث ──
    if (event === "message.incoming") {
      return _commHubProcessIncomingMessage(providerKey, data);
    }
    if (event === "message.status") {
      return _commHubProcessMessageStatus(providerKey, data);
    }
    if (
      event === "connection.qr" ||
      event === "connection.ready" ||
      event === "connection.disconnected" ||
      event === "connection.logged_out"
    ) {
      return _commHubProcessConnectionEvent(providerKey, event, data);
    }
    if (event === "queue.failed") {
      return _commHubProcessQueueFailed(providerKey, data);
    }

    return {
      success: false,
      http_status: 422,
      message: "Event غير معروف: " + event,
    };
  } catch (e) {
    console.error("commHubHandleWebhook:", e);
    return { success: false, http_status: 503, message: "خطأ داخلي" };
  }
}

/**
 * _commHubComputeSignature — HMAC-SHA256(timestamp + "." + JSON(data), secret) بصيغة hex
 */
function _commHubComputeSignature(timestamp, data, secret) {
  var base = timestamp + "." + JSON.stringify(data);
  var bytes = Utilities.computeHmacSha256Signature(base, secret);
  return bytes
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? "0" + v : v;
    })
    .join("");
}

// ═══════════════════════════════════════════════════════════════════
// §2 — استقبال رسالة واردة + Human Handover
// ═══════════════════════════════════════════════════════════════════

function _commHubProcessIncomingMessage(providerKey, rawData) {
  var provider = _commHubGetProvider(providerKey);
  var norm = provider.normalizeIncoming(rawData);

  // [SEC-FIX-STAB4] إضافة LockService حول كامل مسار Check-Then-Act —
  // كشف تكرار الرسالة (provider_message_id) وإيجاد/إنشاء المحادثة
  // (chat_id) كانا بدون أي قفل، فرسالتين واردتين متتاليتين بسرعة (شائع
  // جدًا في واتساب) أو retry من الـ webhook كانا ممكن يمروا الاتنين من
  // فحص "غير موجود" في نفس اللحظة، فيتعمل سجلين محادثة منفصلين لنفس
  // العميل أو تُقبل رسالة مكررة. نفس نمط القفل المستخدم في DeleteEngine.
  var commHubLock = LockService.getScriptLock();
  try {
    commHubLock.waitLock(15000);
  } catch (lockErr) {
    return {
      success: false,
      http_status: 429,
      message: "النظام مشغول بمعالجة رسالة أخرى، حاول مرة أخرى",
    };
  }
  try {
    // Duplicate Detection — نفس message_id اتبعت قبل كده
    var existingMsgs = readSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS);
    var dup = existingMsgs.find(function (m) {
      return String(m.provider_message_id || "") === String(norm.message_id);
    });
    if (dup) {
      return { success: false, http_status: 409, message: "رسالة مكررة" };
    }

    var conv = _commHubFindOrCreateConversation(providerKey, norm);

    var msgId = makeId("CMSG");
    // [ARCH-AUDIT-P3-4] appendRow خام → DataLayerEngine.insert. الجدول
    // مفتاحه الأساسي "message_id" مش "id"، فبنمرره صراحةً كحقل بيانات
    // عادي (insert بتكتب أي حقل موجود في data زي ما هو، والـ auto-id
    // بتاعتها بتتفعّل بس لو فيه عمود اسمه "id" حرفيًا).
    var _cmInsertResult = DataLayerEngine.insert(
      COMMHUB_MSG_SHEET,
      {
        message_id: msgId,
        conversation_id: conv.conversation_id,
        direction: "in",
        origin: "customer",
        type: norm.type,
        content: norm.content,
        media_url: norm.media_url,
        status: "received",
        ai_confidence: "",
        provider_message_id: norm.message_id,
        reply_to: norm.reply_to || "",
        created_by: "",
        created_at: norm.timestamp,
      },
      { headers: COMMHUB_MSG_HEADERS },
    );
    if (!_cmInsertResult.success)
      return {
        success: false,
        http_status: 500,
        message: _cmInsertResult.errorMessage || "تعذّر حفظ الرسالة",
      };

    _commHubTouchConversation(conv.conversation_id, {
      last_message_at: norm.timestamp,
      last_message_preview: String(norm.content || "").substring(0, 100),
      unread_count: Number(conv.unread_count || 0) + 1,
    });
  } finally {
    commHubLock.releaseLock();
  }

  // ── منطق الأوضاع الثلاثة (Human Handover) ──
  // [ملحوظة] بيتنفذ خارج القفل عمدًا (بعد إطلاقه) عشان نقلل مدة حجز
  // القفل لأقل وقت ممكن — التوجيه (Routing) مش جزء من Check-Then-Act
  // الحرج، وممكن ياخد وقت (استدعاء AI/قواعد توجيه) فمنعزله عن الـ lock.
  _commHubRouteMessage(conv, norm);

  return { success: true, queued: true, conversation_id: conv.conversation_id };
}

/**
 * _commHubFindOrCreateConversation — يبحث عن محادثة بنفس chat_id أو ينشئ واحدة جديدة
 */
function _commHubFindOrCreateConversation(providerKey, norm) {
  var sheet = getSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS);
  var rows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS);
  var found = rows.find(function (r) {
    return (
      String(r.provider || "") === String(providerKey) &&
      String(r.chat_id || "") === String(norm.chat_id)
    );
  });
  if (found) return found;

  var settings = _commHubGetSettingsRaw();
  var now = new Date();
  var convId = makeId("CONV");

  // محاولة ربط بعميل موجود عن طريق الهاتف
  var customerId = _commHubFindCustomerByPhone(norm.phone);

  var _cvInsertResult = DataLayerEngine.insert(
    COMMHUB_CONV_SHEET,
    {
      conversation_id: convId,
      provider: providerKey,
      chat_id: norm.chat_id,
      customer_id: customerId || "",
      contact_name: norm.contact_name || norm.phone,
      phone: norm.phone,
      mode: settings.default_mode || "hybrid",
      assigned_to: "",
      status: "open",
      labels: "",
      pinned: false,
      unread_count: 0,
      ai_reply_count: 0,
      last_message_at: now,
      last_message_preview: "",
      created_at: now,
      updated_at: now,
    },
    { headers: COMMHUB_CONV_HEADERS },
  );
  if (!_cvInsertResult.success) {
    Logger.log(
      "[_commHubFindOrCreateConversation] insert failed: " +
        _cvInsertResult.errorMessage,
    );
  }

  return {
    conversation_id: convId,
    provider: providerKey,
    chat_id: norm.chat_id,
    customer_id: customerId || "",
    contact_name: norm.contact_name || norm.phone,
    phone: norm.phone,
    mode: settings.default_mode || "hybrid",
    assigned_to: "",
    status: "open",
    unread_count: 0,
    ai_reply_count: 0,
  };
}

function _commHubFindCustomerByPhone(phone) {
  if (!phone) return "";
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Parties");
    if (!sheet) return "";
    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var colId = headers.indexOf("id");
    var colPhone = headers.indexOf("phone");
    var colMobile = headers.indexOf("mobile");
    var clean = String(phone).replace(/[^0-9]/g, "");
    for (var i = 1; i < data.length; i++) {
      var p1 = String(data[i][colPhone] || "").replace(/[^0-9]/g, "");
      var p2 =
        colMobile >= 0
          ? String(data[i][colMobile] || "").replace(/[^0-9]/g, "")
          : "";
      if (
        (p1 && clean.indexOf(p1) !== -1) ||
        (p2 && clean.indexOf(p2) !== -1)
      ) {
        return data[i][colId];
      }
    }
    return "";
  } catch (e) {
    console.warn("_commHubFindCustomerByPhone:", e.message);
    return "";
  }
}

function _commHubTouchConversation(conversationId, fields) {
  try {
    var sheet = getSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS);
    var rows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS);
    var row = rows.find(function (r) {
      return String(r.conversation_id || "") === String(conversationId);
    });
    if (!row) return;
    fields.updated_at = new Date();
    _applyRowUpdates(sheet, row._row, COMMHUB_CONV_HEADERS, fields); // [PERF-BATCH-1]
  } catch (e) {
    console.warn("_commHubTouchConversation:", e.message);
  }
}

/**
 * _commHubRouteMessage — منطق الأوضاع الثلاثة (§6 في SPEC.md)
 */
function _commHubRouteMessage(conv, norm) {
  var settings = _commHubGetSettingsRaw();
  var mode = conv.mode || "hybrid";

  // فحص Blacklist/Whitelist — قبل أي حاجة تانية، الرقم المحظور مايوصلوش
  // رد أصلاً (لا AI ولا حتى تنبيه بشري)، والـ Whitelist (لو مُفعّلة بوضع
  // أرقام) بتمنع الرد على أي رقم مش موجود فيها.
  var phoneDigits = String(conv.phone || "").replace(/\D/g, "");
  var blacklist = String(settings.blacklist_numbers || "")
    .split(",")
    .map(function (n) {
      return n.replace(/\D/g, "");
    })
    .filter(Boolean);
  if (phoneDigits && blacklist.indexOf(phoneDigits) !== -1) {
    AuditEngine.log("commhub_message_blocked_blacklist", {
      user: "system",
      table: COMMHUB_CONV_SHEET,
      record_id: conv.conversation_id,
      details: JSON.stringify({ phone: conv.phone })});
    return; // تجاهل تام — مفيش رد ولا تصعيد
  }

  var whitelist = String(settings.whitelist_numbers || "")
    .split(",")
    .map(function (n) {
      return n.replace(/\D/g, "");
    })
    .filter(Boolean);
  if (
    whitelist.length &&
    (!phoneDigits || whitelist.indexOf(phoneDigits) === -1)
  ) {
    // Whitelist مفعّلة وفيها أرقام، والرقم ده مش من ضمنها → يتحوّل لتدخل
    // بشري بدل ما نتجاهله تمامًا (ممكن يكون عميل حقيقي مش متسجل بعد)
    _commHubNotifyHumanIntervention(
      conv,
      "رقم خارج قائمة الأرقام المسموح بها (Whitelist)",
    );
    return;
  }

  if (mode === "human_only") {
    _commHubNotifyHumanIntervention(conv, "رسالة جديدة تحتاج رد يدوي");
    return;
  }

  // فحص working hours
  if (!_commHubIsWithinWorkingHours(settings)) {
    if (settings.away_message) {
      _commHubSendReply(conv, {
        type: "text",
        text: settings.away_message,
        origin: "system",
      });
    }
    _commHubNotifyHumanIntervention(conv, "رسالة وصلت خارج ساعات العمل");
    return;
  }

  // فحص Escalation keywords
  var keywords = String(settings.escalation_keywords || "")
    .split(",")
    .map(function (k) {
      return k.trim();
    })
    .filter(Boolean);
  var textLower = String(norm.content || "").toLowerCase();
  var hasEscalationKeyword = keywords.some(function (k) {
    return k && textLower.indexOf(k.toLowerCase()) !== -1;
  });

  // فحص الحد الأقصى لردود الـ AI في المحادثة
  var maxReplies = Number(settings.max_ai_replies_per_conversation) || 10;
  var reachedMax = Number(conv.ai_reply_count || 0) >= maxReplies;

  if (hasEscalationKeyword || reachedMax) {
    _commHubNotifyHumanIntervention(
      conv,
      hasEscalationKeyword
        ? "رسالة تحتوي كلمة تصعيد"
        : "تم تجاوز الحد الأقصى لردود المساعد",
    );
    if (mode === "ai_only") {
      _commHubTouchConversation(conv.conversation_id, {
        mode: "human_only",
        status: "pending",
      });
    }
    return;
  }

  // توليد رد الـ AI
  var aiResult = _commHubGenerateAIReply(conv, norm);
  if (!aiResult.success) {
    _commHubNotifyHumanIntervention(conv, "فشل توليد رد المساعد الذكي");
    return;
  }

  var confidence = aiResult.confidence != null ? aiResult.confidence : 1;
  if (confidence < Number(settings.confidence_threshold || 0.6)) {
    // ثقة منخفضة → تصعيد دائماً بغض النظر عن الوضع
    _commHubSaveMessage(conv.conversation_id, {
      direction: "out",
      origin: "ai",
      type: "text",
      content: aiResult.reply,
      status: "suggested",
      ai_confidence: confidence,
    });
    _commHubNotifyHumanIntervention(
      conv,
      "رد المساعد بثقة منخفضة — يحتاج مراجعة",
    );
    return;
  }

  if (mode === "ai_only") {
    _commHubSendReply(conv, {
      type: "text",
      text: aiResult.reply,
      origin: "ai",
    });
    _commHubTouchConversation(conv.conversation_id, {
      ai_reply_count: Number(conv.ai_reply_count || 0) + 1,
    });
  } else {
    // hybrid → رد مقترح فقط (status = suggested) لحد ما الموظف يوافق/يعدّل/يرفض
    _commHubSaveMessage(conv.conversation_id, {
      direction: "out",
      origin: "ai",
      type: "text",
      content: aiResult.reply,
      status: "suggested",
      ai_confidence: confidence,
    });
  }
}

function _commHubIsWithinWorkingHours(settings) {
  if (!settings.working_hours_start || !settings.working_hours_end) return true; // 24/7 لو مش مُعدّة
  try {
    var now = new Date();
    var tz = Session.getScriptTimeZone();
    var hhmm = Utilities.formatDate(now, tz, "HH:mm");
    return (
      hhmm >= settings.working_hours_start && hhmm <= settings.working_hours_end
    );
  } catch (e) {
    return true;
  }
}

function _commHubNotifyHumanIntervention(conv, reason) {
  try {
    // [PHASE4-NOTIF] بنسجّل السبب على المحادثة نفسها (pending_reason) —
    // ده هو المصدر اللي بتقرأ منه getCommHubPendingAlerts عشان تظهره في
    // جرس الإشعارات الداخلي (02_JS_UI_Shell.html)، بدل ما السبب يفضل
    // محبوس جوه Audit Log فقط وميظهرشِ لحد ما الموظف يفتح المحادثة بنفسه.
    _commHubTouchConversation(conv.conversation_id, {
      status: "pending",
      pending_reason: reason || "",
    });
    AuditEngine.log("commhub_human_intervention_required", {
      user: "system",
      table: COMMHUB_CONV_SHEET,
      record_id: conv.conversation_id,
      details: JSON.stringify({
        reason: reason,
        assigned_to: conv.assigned_to || "",
      })});
  } catch (e) {
    console.warn("_commHubNotifyHumanIntervention:", e.message);
  }
}

/**
 * getCommHubPendingAlerts — [PHASE4-NOTIF] نسخة خفيفة جداً من
 * getCommHubConversations مخصوصة لجرس الإشعارات الداخلي (_buildNotifications
 * في 02_JS_UI_Shell.html). بترجّع فقط المحادثات status=pending (بتحتاج
 * تدخل بشري فعلاً — أوضاع human_only/escalation/low-confidence)، بحد أقصى
 * صغير (8) لأنها بتتنادى بشكل متكرر (polling) على عكس شاشة الـ Inbox
 * الكاملة. نفس منطق تقييد الرؤية بالـ assigned_to المستخدم في
 * getCommHubConversations (موظف عادي يشوف بس المُخصّص له، admin/supervisor
 * يشوفوا الكل).
 * صلاحية: viewCommunicationHub (fallback: manageCommunicationHub)
 */
function getCommHubPendingAlerts(callerUser, sessionToken) {
  try {
    var permErr = _commHubCheckViewPermission(callerUser, sessionToken);
    if (permErr) return permErr;

    var role = _getUserRole(callerUser);
    var rows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS, {
      trimStrings: true,
    });

    rows = rows.filter(function (r) {
      if (!r.conversation_id || r.status !== "pending") return false;
      if (role !== "admin" && role !== "supervisor" && r.assigned_to) {
        if (String(r.assigned_to) !== callerUser) return false;
      }
      return true;
    });

    rows.sort(function (a, b) {
      return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
    });

    var total = rows.length;
    rows = rows.slice(0, 8).map(function (r) {
      return {
        conversation_id: r.conversation_id,
        contact_name: r.contact_name || r.phone || "—",
        phone: r.phone || "",
        pending_reason: r.pending_reason || "",
        updated_at: r.updated_at,
      };
    });

    return okResponse("تم الجلب", { data: rows, total: total });
  } catch (e) {
    console.error("getCommHubPendingAlerts:", e);
    return errResponse("خطأ في جلب تنبيهات Communication Hub: " + e.message);
  }
}

/**
 * _commHubGenerateAIReply — توليد رد عبر Groq بدون الحاجة لجلسة مستخدم بشري
 * (الحدث ده جاي من Webhook موثّق بالفعل عبر HMAC — مفيش "مستخدم" حرفياً هنا).
 * ملحوظة: هذه دالة منفصلة عن proxyGroqChat (اللي بيتطلب sessionToken بشري)
 * لتفادي أي تحايل بجلسات وهمية — نفس مفتاح GROQ_API_KEY يُعاد استخدامه.
 */
function _commHubGenerateAIReply(conv, norm) {
  try {
    var apiKey =
      PropertiesService.getScriptProperties().getProperty("GROQ_API_KEY");
    if (!apiKey) return { success: false, message: "GROQ_API_KEY غير مُعدّ" };

    var settings = _commHubGetSettingsRaw();
    var history = _commHubGetRecentMessages(conv.conversation_id, 10);

    var systemPrompt =
      (settings.greeting_message
        ? "رسالة ترحيب افتراضية للسياق: " + settings.greeting_message + ". "
        : "") +
      "أنت مساعد خدمة عملاء عبر واتساب لمتجر. رد بالعربية المصرية، بإيجاز ووضوح، وبأسلوب ودود.";

    var messages = [{ role: "system", content: systemPrompt }];
    history.forEach(function (m) {
      messages.push({
        role: m.direction === "in" ? "user" : "assistant",
        content: String(m.content || "").substring(0, 1000),
      });
    });
    messages.push({
      role: "user",
      content: String(norm.content || "").substring(0, 2000),
    });

    var payload = {
      model: "llama-3.3-70b-versatile",
      max_tokens: 500,
      messages: messages,
    };
    var response = UrlFetchApp.fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + apiKey },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      },
    );

    var result = JSON.parse(response.getContentText());
    if (result.choices && result.choices[0] && result.choices[0].message) {
      return {
        success: true,
        reply: result.choices[0].message.content,
        confidence: 1,
      };
    }
    return { success: false, message: "لم يرد المساعد" };
  } catch (e) {
    console.error("_commHubGenerateAIReply:", e);
    return { success: false, message: e.message };
  }
}

function _commHubGetRecentMessages(conversationId, limit) {
  var rows = readSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS);
  var filtered = rows.filter(function (r) {
    return (
      String(r.conversation_id || "") === String(conversationId) &&
      r.status !== "suggested"
    );
  });
  filtered.sort(function (a, b) {
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });
  return filtered.slice(-limit);
}

/**
 * _commHubSaveMessage — يحفظ رسالة (in/out) في CommHub_Messages
 */
function _commHubSaveMessage(conversationId, fields) {
  var msgId = makeId("CMSG");
  var now = new Date();
  DataLayerEngine.insert(
    COMMHUB_MSG_SHEET,
    {
      message_id: msgId,
      conversation_id: conversationId,
      direction: fields.direction,
      origin: fields.origin,
      type: fields.type || "text",
      content: fields.content || "",
      media_url: fields.media_url || "",
      status: fields.status || "sent",
      ai_confidence: fields.ai_confidence != null ? fields.ai_confidence : "",
      provider_message_id: fields.provider_message_id || "",
      reply_to: fields.reply_to || "",
      created_by: fields.created_by || "",
      created_at: now,
    },
    { headers: COMMHUB_MSG_HEADERS },
  );
  return msgId;
}

/**
 * _commHubSendReply — يرسل رد فعلي عبر الـ Provider + يحفظه + يحدّث المحادثة
 * (نقطة الإرسال المركزية الوحيدة — كل مسارات الإرسال تمر من هنا)
 */
function _commHubSendReply(conv, payload) {
  var provider = _commHubGetProvider(conv.provider || "whatsapp");
  var result = provider.sendMessage(conv, payload);

  var msgId = _commHubSaveMessage(conv.conversation_id, {
    direction: "out",
    origin: payload.origin || "system",
    type: payload.type || "text",
    content: payload.text || "",
    media_url: payload.media_url || "",
    status: result.success ? result.status || "sent" : "failed",
    provider_message_id: result.provider_message_id || "",
    created_by: payload.created_by || "",
  });

  if (!result.success) {
    _commHubEnqueue("outgoing", {
      conversation_id: conv.conversation_id,
      message_id: msgId,
      payload: payload,
    });
  } else {
    _commHubTouchConversation(conv.conversation_id, {
      last_message_at: new Date(),
      last_message_preview: String(payload.text || "").substring(0, 100),
    });
  }

  result.message_id = msgId; // [UNIFY-COMMHUB-2026] يسمح للمنادي بمعرفة الـ id المحلي دون إعادة قراءة الشيت
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// §3 — Queue System (Incoming/Outgoing/Retry/DLQ)
// ═══════════════════════════════════════════════════════════════════

function _commHubEnqueue(queueType, payload) {
  var now = new Date();
  var qId = makeId("CQ");
  DataLayerEngine.insert(
    COMMHUB_QUEUE_SHEET,
    {
      queue_id: qId,
      queue_type: queueType,
      payload: JSON.stringify(payload),
      attempts: 0,
      next_retry_at: now,
      status: "pending",
      last_error: "",
      created_at: now,
      updated_at: now,
    },
    { headers: COMMHUB_QUEUE_HEADERS },
  );
  return qId;
}

/**
 * commHubProcessRetryQueue — يُشغَّل بواسطة Trigger زمني (كل دقيقة مثلاً)
 * يعالج قائمة الانتظار retry/outgoing الفاشلة بـ Exponential Backoff.
 */
function commHubProcessRetryQueue() {
  var sheet = getSheet(COMMHUB_QUEUE_SHEET, COMMHUB_QUEUE_HEADERS);
  var rows = readSheet(COMMHUB_QUEUE_SHEET, COMMHUB_QUEUE_HEADERS);
  var now = new Date();

  rows
    .filter(function (r) {
      return (
        (r.queue_type === "outgoing" || r.queue_type === "retry") &&
        r.status === "pending" &&
        new Date(r.next_retry_at || 0) <= now
      );
    })
    .forEach(function (r) {
      try {
        var data = JSON.parse(r.payload);
        var convRows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS);
        var conv = convRows.find(function (c) {
          return (
            String(c.conversation_id || "") === String(data.conversation_id)
          );
        });
        if (!conv) {
          sheet
            .getRange(r._row, COMMHUB_QUEUE_HEADERS.indexOf("status") + 1)
            .setValue("failed");
          return;
        }

        var provider = _commHubGetProvider(conv.provider || "whatsapp");
        var result = provider.sendMessage(conv, data.payload);
        var attempts = Number(r.attempts || 0) + 1;

        if (result.success) {
          sheet
            .getRange(r._row, COMMHUB_QUEUE_HEADERS.indexOf("status") + 1)
            .setValue("done");
        } else if (attempts >= COMMHUB_RETRY_BACKOFF_SECONDS.length) {
          // فشلت كل المحاولات → DLQ
          sheet
            .getRange(r._row, COMMHUB_QUEUE_HEADERS.indexOf("queue_type") + 1)
            .setValue("dlq");
          sheet
            .getRange(r._row, COMMHUB_QUEUE_HEADERS.indexOf("status") + 1)
            .setValue("failed");
          sheet
            .getRange(r._row, COMMHUB_QUEUE_HEADERS.indexOf("last_error") + 1)
            .setValue(result.message || "فشل غير معروف");
          AuditEngine.log("commhub_queue_dlq", {
            user: "system",
            table: COMMHUB_QUEUE_SHEET,
            record_id: r.queue_id,
            details: JSON.stringify({ conversation_id: data.conversation_id })});
        } else {
          var backoff = COMMHUB_RETRY_BACKOFF_SECONDS[attempts] || 3600;
          var nextRetry = new Date(now.getTime() + backoff * 1000);
          sheet
            .getRange(r._row, COMMHUB_QUEUE_HEADERS.indexOf("attempts") + 1)
            .setValue(attempts);
          sheet
            .getRange(
              r._row,
              COMMHUB_QUEUE_HEADERS.indexOf("next_retry_at") + 1,
            )
            .setValue(nextRetry);
          sheet
            .getRange(r._row, COMMHUB_QUEUE_HEADERS.indexOf("last_error") + 1)
            .setValue(result.message || "");
        }
        sheet
          .getRange(r._row, COMMHUB_QUEUE_HEADERS.indexOf("updated_at") + 1)
          .setValue(new Date());
      } catch (e) {
        console.error("commHubProcessRetryQueue item:", e);
      }
    });
}

function _commHubProcessMessageStatus(providerKey, data) {
  try {
    var sheet = getSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS);
    var rows = readSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS);
    var row = rows.find(function (r) {
      return String(r.provider_message_id || "") === String(data.message_id);
    });
    if (row) {
      sheet
        .getRange(row._row, COMMHUB_MSG_HEADERS.indexOf("status") + 1)
        .setValue(data.status || "sent");
    }
    return { success: true };
  } catch (e) {
    console.error("_commHubProcessMessageStatus:", e);
    return { success: false, http_status: 503 };
  }
}

function _commHubProcessConnectionEvent(providerKey, event, data) {
  try {
    var stateMap = {
      "connection.qr": "qr_required",
      "connection.ready": "connected",
      "connection.disconnected": "disconnected",
      "connection.logged_out": "logged_out",
    };
    _commHubUpdateProviderField(
      providerKey,
      "last_state",
      stateMap[event] || "unknown",
    );
    if (data.connected_number) {
      _commHubUpdateProviderField(
        providerKey,
        "connected_number",
        data.connected_number,
      );
    }
    AuditEngine.log("commhub_connection_event", {
      user: "system",
      table: COMMHUB_PROVIDERS_SHEET,
      record_id: providerKey,
      details: JSON.stringify({ event: event })});
    return { success: true };
  } catch (e) {
    console.error("_commHubProcessConnectionEvent:", e);
    return { success: false, http_status: 503 };
  }
}

function _commHubProcessQueueFailed(providerKey, data) {
  try {
    AuditEngine.log("commhub_queue_failed_notification", {
      user: "system",
      table: COMMHUB_QUEUE_SHEET,
      record_id: "",
      details: JSON.stringify(data)});
    return { success: true };
  } catch (e) {
    return { success: false, http_status: 503 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// §4 — Settings (AI Controls)
// ═══════════════════════════════════════════════════════════════════

function _commHubGetSettingsRaw() {
  var rows = readSheet(COMMHUB_SETTINGS_SHEET, COMMHUB_SETTINGS_HEADERS, {
    trimStrings: true,
  });
  if (rows.length) return rows[0];
  return {
    auto_reply_enabled: true,
    working_hours_start: "",
    working_hours_end: "",
    greeting_message: "",
    away_message:
      "شكراً لتواصلك معنا، سيتم الرد عليك في أقرب وقت خلال ساعات العمل.",
    max_ai_replies_per_conversation: 10,
    confidence_threshold: 0.6,
    escalation_keywords: "شكوى,مدير,استرجاع فلوس,مشكلة كبيرة",
    blacklist_numbers: "",
    whitelist_numbers: "",
    default_mode: "hybrid",
  };
}

/**
 * getCommHubSettings — لشاشة إعدادات الـ Hub
 * صلاحية: manageCommunicationHub
 */
function getCommHubSettings(callerUser, sessionToken) {
  var permErr = _checkPermission(
    callerUser,
    "manageCommunicationHub",
    sessionToken,
  );
  if (permErr) return permErr;
  return okResponse("تم الجلب", { data: _commHubGetSettingsRaw() });
}

/**
 * saveCommHubSettings — Upsert لصف الإعدادات الوحيد
 * صلاحية: manageCommunicationHub
 */
function saveCommHubSettings(data, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "manageCommunicationHub",
      sessionToken,
    );
    if (permErr) return permErr;

    var d = data || {};
    var sheet = getSheet(COMMHUB_SETTINGS_SHEET, COMMHUB_SETTINGS_HEADERS);
    var rows = readSheet(COMMHUB_SETTINGS_SHEET, COMMHUB_SETTINGS_HEADERS);
    var now = new Date();

    var settingsId = rows.length ? rows[0].id : makeId("CSET");
    var settingsPatch = {
      id: settingsId,
      auto_reply_enabled: d.auto_reply_enabled !== false,
      working_hours_start: d.working_hours_start || "",
      working_hours_end: d.working_hours_end || "",
      greeting_message: d.greeting_message || "",
      away_message: d.away_message || "",
      max_ai_replies_per_conversation:
        Number(d.max_ai_replies_per_conversation) || 10,
      confidence_threshold: Number(d.confidence_threshold) || 0.6,
      escalation_keywords: d.escalation_keywords || "",
      blacklist_numbers: d.blacklist_numbers || "",
      whitelist_numbers: d.whitelist_numbers || "",
      updated_at: now,
      updated_by: callerUser,
      default_mode:
        ["ai_only", "human_only", "hybrid"].indexOf(d.default_mode) !== -1
          ? d.default_mode
          : "hybrid",
    };

    // [ARCH-AUDIT-P3-5] upsert خام (setValues/appendRow) → DataLayerEngine
    // (update لو الصف موجود، insert لو أول مرة) — الجدول ده فعليًا الوحيد
    // في CommHub اللي مفتاحه "id" حرفيًا فمتوافق مع الاتنين.
    if (rows.length) {
      var _csUpdateResult = DataLayerEngine.update(
        COMMHUB_SETTINGS_SHEET,
        settingsId,
        settingsPatch,
        { headers: COMMHUB_SETTINGS_HEADERS },
      );
      if (!_csUpdateResult.ok)
        return errResponse(
          _csUpdateResult.errorMessage || "تعذّر حفظ إعدادات CommHub",
        );
    } else {
      var _csInsertResult = DataLayerEngine.insert(
        COMMHUB_SETTINGS_SHEET,
        settingsPatch,
        { headers: COMMHUB_SETTINGS_HEADERS },
      );
      if (!_csInsertResult.success)
        return errResponse(
          _csInsertResult.errorMessage || "تعذّر حفظ إعدادات CommHub",
        );
    }

    AuditEngine.log("commhub_settings_save", {
      user: callerUser,
      table: COMMHUB_SETTINGS_SHEET,
      record_id: "",
      details: JSON.stringify(d)});

    return okResponse("تم حفظ الإعدادات بنجاح");
  } catch (e) {
    console.error("saveCommHubSettings:", e);
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// §5 — Internal Inbox Backend
// ═══════════════════════════════════════════════════════════════════

/**
 * getCommHubConversations — قائمة المحادثات مع فلاتر (بحث/غير مقروء/pinned/status)
 * صلاحية: viewCommunicationHub (fallback: manageCommunicationHub لو مش موجودة)
 */
function getCommHubConversations(callerUser, filters, sessionToken) {
  try {
    var permErr = _commHubCheckViewPermission(callerUser, sessionToken);
    if (permErr) return permErr;

    var f = filters || {};
    var role = _getUserRole(callerUser);
    var rows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS, {
      trimStrings: true,
    });

    rows = rows.filter(function (r) {
      if (!r.conversation_id) return false;
      if (role !== "admin" && role !== "supervisor" && r.assigned_to) {
        if (String(r.assigned_to) !== callerUser) return false;
      }
      if (f.status && r.status !== f.status) return false;
      if (f.pinned_only && !(r.pinned === true || r.pinned === "TRUE"))
        return false;
      if (f.unread_only && Number(r.unread_count || 0) <= 0) return false;
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
      var pinnedDiff =
        (b.pinned === true || b.pinned === "TRUE" ? 1 : 0) -
        (a.pinned === true || a.pinned === "TRUE" ? 1 : 0);
      if (pinnedDiff !== 0) return pinnedDiff;
      return (
        new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)
      );
    });

    var total = rows.length;
    var limit = Math.min(Number(f.limit) || 50, 200);
    rows = rows.slice(0, limit).map(function (r) {
      delete r._row;
      return r;
    });

    return okResponse("تم الجلب", { data: rows, total: total });
  } catch (e) {
    console.error("getCommHubConversations:", e);
    return errResponse("خطأ في جلب المحادثات: " + e.message);
  }
}

/**
 * getCommHubMessages — رسائل محادثة (بما فيها الردود المقترحة suggested)
 */
function getCommHubMessages(callerUser, conversationId, sessionToken) {
  try {
    var permErr = _commHubCheckViewPermission(callerUser, sessionToken);
    if (permErr) return permErr;
    if (!conversationId) return errResponse("يجب تحديد رقم المحادثة");

    var rows = readSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return (
        String(r.conversation_id || "") === String(conversationId) &&
        r.message_id
      );
    });
    rows.sort(function (a, b) {
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });
    rows.forEach(function (r) {
      delete r._row;
    });

    return okResponse("تم الجلب", { data: rows });
  } catch (e) {
    console.error("getCommHubMessages:", e);
    return errResponse("خطأ في جلب الرسائل: " + e.message);
  }
}

/**
 * commHubSendMessage — إرسال رد يدوي (الموظف من الـ Inbox)
 * صلاحية: replyCommunicationHub
 */
function commHubSendMessage(callerUser, conversationId, data, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "replyCommunicationHub",
      sessionToken,
    );
    if (permErr) return permErr;
    if (!conversationId) return errResponse("يجب تحديد رقم المحادثة");

    var conv = _commHubGetConversationById(conversationId);
    if (!conv) return errResponse("المحادثة غير موجودة");

    var d = data || {};
    if (!d.text) return errResponse("نص الرسالة مطلوب");

    var result = _commHubSendReply(conv, {
      type: d.type || "text",
      text: d.text,
      media_url: d.media_url || "",
      reply_to: d.reply_to || null,
      origin: "human",
      created_by: callerUser,
    });

    if (!result.success)
      return errResponse(
        result.message || "فشل الإرسال — تم وضعها في قائمة إعادة المحاولة",
      );
    return okResponse("تم الإرسال");
  } catch (e) {
    console.error("commHubSendMessage:", e);
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * commHubResolveSuggestedReply — Approve / Edit / Reject لرد الـ AI المقترح (Hybrid mode)
 * action: "approve" | "edit" | "reject"
 */
function commHubResolveSuggestedReply(
  callerUser,
  messageId,
  action,
  editedText,
  sessionToken,
) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "replyCommunicationHub",
      sessionToken,
    );
    if (permErr) return permErr;

    var msgSheet = getSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS);
    var rows = readSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS);
    var msg = rows.find(function (m) {
      return (
        String(m.message_id || "") === String(messageId) &&
        m.status === "suggested"
      );
    });
    if (!msg)
      return errResponse(
        "الرسالة المقترحة غير موجودة أو تم التعامل معها بالفعل",
      );

    var conv = _commHubGetConversationById(msg.conversation_id);
    if (!conv) return errResponse("المحادثة غير موجودة");

    if (action === "reject") {
      msgSheet
        .getRange(msg._row, COMMHUB_MSG_HEADERS.indexOf("status") + 1)
        .setValue("rejected");
      return okResponse("تم رفض الرد المقترح");
    }

    var finalText = action === "edit" ? editedText || msg.content : msg.content;
    var result = _commHubGetProvider(conv.provider || "whatsapp").sendMessage(
      conv,
      {
        type: "text",
        text: finalText,
        origin: action === "edit" ? "human" : "ai",
      },
    );

    msgSheet
      .getRange(msg._row, COMMHUB_MSG_HEADERS.indexOf("status") + 1)
      .setValue(result.success ? "sent" : "failed");
    msgSheet
      .getRange(msg._row, COMMHUB_MSG_HEADERS.indexOf("content") + 1)
      .setValue(finalText);
    msgSheet
      .getRange(
        msg._row,
        COMMHUB_MSG_HEADERS.indexOf("provider_message_id") + 1,
      )
      .setValue(result.provider_message_id || "");
    msgSheet
      .getRange(msg._row, COMMHUB_MSG_HEADERS.indexOf("created_by") + 1)
      .setValue(callerUser);

    if (result.success) {
      _commHubTouchConversation(conv.conversation_id, {
        last_message_at: new Date(),
        last_message_preview: String(finalText).substring(0, 100),
      });
    }

    return result.success
      ? okResponse(
          action === "approve"
            ? "تم اعتماد الرد وإرساله"
            : "تم تعديل الرد وإرساله",
        )
      : errResponse(result.message || "فشل الإرسال");
  } catch (e) {
    console.error("commHubResolveSuggestedReply:", e);
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * updateCommHubConversation — تحديث حالة/تعيين/pin/labels لمحادثة
 * صلاحية: manageCommunicationHub (تعيين موظف) أو replyCommunicationHub (تحديثات بسيطة)
 */
function updateCommHubConversation(
  callerUser,
  conversationId,
  fields,
  sessionToken,
) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "replyCommunicationHub",
      sessionToken,
    );
    if (permErr) return permErr;
    if (!conversationId) return errResponse("يجب تحديد رقم المحادثة");

    var allowed = ["status", "assigned_to", "labels", "pinned", "mode"];
    var safeFields = {};
    Object.keys(fields || {}).forEach(function (k) {
      if (allowed.indexOf(k) !== -1) safeFields[k] = fields[k];
    });
    if (!Object.keys(safeFields).length)
      return errResponse("لا توجد حقول صالحة للتحديث");

    _commHubTouchConversation(conversationId, safeFields);
    AuditEngine.log("commhub_conversation_update", {
      user: callerUser,
      table: COMMHUB_CONV_SHEET,
      record_id: conversationId,
      details: JSON.stringify(safeFields)});

    return okResponse("تم التحديث");
  } catch (e) {
    console.error("updateCommHubConversation:", e);
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * markCommHubConversationRead — تصفير unread_count
 */
function markCommHubConversationRead(callerUser, conversationId, sessionToken) {
  try {
    var permErr = _commHubCheckViewPermission(callerUser, sessionToken);
    if (permErr) return permErr;
    _commHubTouchConversation(conversationId, { unread_count: 0 });
    return okResponse("تم التحديث");
  } catch (e) {
    console.error("markCommHubConversationRead:", e);
    return errResponse("خطأ: " + e.message);
  }
}

function _commHubGetConversationById(conversationId) {
  var rows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS, {
    trimStrings: true,
  });
  return (
    rows.find(function (r) {
      return String(r.conversation_id || "") === String(conversationId);
    }) || null
  );
}

/**
 * _commHubCheckViewPermission — يقبل viewCommunicationHub أو manageCommunicationHub
 * (المدير/المشرف عندهم manage غالباً وممكن يستخدموا Inbox كمان)
 */
function _commHubCheckViewPermission(callerUser, sessionToken) {
  var err1 = _checkPermission(callerUser, "viewCommunicationHub", sessionToken);
  if (!err1) return null;
  var err2 = _checkPermission(
    callerUser,
    "manageCommunicationHub",
    sessionToken,
  );
  if (!err2) return null;
  return err1; // رفض الاثنين → رجّع رسالة الخطأ الأصلية
}

// ═══════════════════════════════════════════════════════════════════
// §6 — Dashboard Backend
// ═══════════════════════════════════════════════════════════════════

/**
 * getCommHubDashboard — بيانات شاشة المراقبة (حالة الاتصال، الطابور، إحصائيات اليوم)
 * صلاحية: manageCommunicationHub
 */
function getCommHubDashboard(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "manageCommunicationHub",
      sessionToken,
    );
    if (permErr) return permErr;

    var status = _commHubGetProvider("whatsapp").getStatus();

    var queueRows = readSheet(COMMHUB_QUEUE_SHEET, COMMHUB_QUEUE_HEADERS);
    var pending = queueRows.filter(function (r) {
      return r.status === "pending";
    }).length;
    var failed = queueRows.filter(function (r) {
      return r.queue_type === "dlq";
    }).length;

    var todayStr = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    var msgRows = readSheet(COMMHUB_MSG_SHEET, COMMHUB_MSG_HEADERS);
    var todayMsgs = msgRows.filter(function (r) {
      return (
        r.created_at &&
        Utilities.formatDate(
          new Date(r.created_at),
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        ) === todayStr
      );
    });
    var todaySent = todayMsgs.filter(function (r) {
      return (
        r.direction === "out" &&
        r.status !== "suggested" &&
        r.status !== "rejected"
      );
    }).length;
    var todayReceived = todayMsgs.filter(function (r) {
      return r.direction === "in";
    }).length;

    var convRows = readSheet(COMMHUB_CONV_SHEET, COMMHUB_CONV_HEADERS);
    var totalUnread = convRows.reduce(function (sum, r) {
      return sum + Number(r.unread_count || 0);
    }, 0);
    var pendingConversations = convRows.filter(function (r) {
      return r.status === "pending";
    }).length;

    return okResponse("تم الجلب", {
      status: status,
      queue: {
        pending: pending,
        failed: failed,
        today_sent: todaySent,
        today_received: todayReceived,
      },
      unread_total: totalUnread,
      pending_conversations: pendingConversations,
    });
  } catch (e) {
    console.error("getCommHubDashboard:", e);
    return errResponse("خطأ في جلب بيانات اللوحة: " + e.message);
  }
}

/**
 * commHubReconnectProvider — يطلب من الـ Bridge إعادة الاتصال (زر Reconnect بالـ Dashboard)
 */
function commHubReconnectProvider(callerUser, providerKey, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "manageCommunicationHub",
      sessionToken,
    );
    if (permErr) return permErr;

    var cfg = _commHubReadProviderConfig(providerKey || "whatsapp");
    if (!cfg || !cfg.bridge_url || !cfg.bridge_api_key) {
      return errResponse("القناة غير مُعدّة بعد");
    }
    var url = String(cfg.bridge_url).replace(/\/+$/, "") + "/api/reconnect";
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      headers: { "X-Bridge-Api-Key": cfg.bridge_api_key },
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    if (code !== 200)
      return errResponse("فشل طلب إعادة الاتصال (كود " + code + ")");

    AuditEngine.log("commhub_reconnect", {
      user: callerUser,
      table: COMMHUB_PROVIDERS_SHEET,
      record_id: providerKey || "whatsapp",
      details: ""});
    return okResponse("تم إرسال طلب إعادة الاتصال");
  } catch (e) {
    console.error("commHubReconnectProvider:", e);
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// §6 — تركيب الـ Trigger الزمني لمعالج الـ Retry Queue
// ═══════════════════════════════════════════════════════════════════

/**
 * setupCommHubRetryTrigger — [FIX] بدون الدالة دي، commHubProcessRetryQueue
 * موجودة في الكود لكن محدش بينادي عليها، فأي رسالة فشلت هتفضل "pending"
 * للأبد من غير أي إعادة محاولة فعلية. شغّلها مرة واحدة يدويًا من
 * Apps Script Editor (اختار الدالة دي واضغط Run) بعد أول نشر للملف ده.
 */
function setupCommHubRetryTrigger(existingTriggers) {
  // [PERF-TRIGGERS-1] استخدم القايمة الجاهزة من setupEverything لو موجودة
  var triggers = existingTriggers || ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "commHubProcessRetryQueue") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // [PERF-LOGIN-6] كانت everyMinutes(1) — بتتزاحم مع طلبات doPost (خصوصًا
  // loginLite) على نفس حصة Google Sheets API، وبتاخد بطئها (بسبب setValue()
  // منفصلة لكل صف) لأكتر من 20 ثانية أحيانًا وهو ده اللي بيسبب Timeout في
  // تسجيل الدخول من الفرونت. تقليلها لكل 5 دقايق بيقلل التصادم بشكل كبير
  // مع بقاء آلية إعادة المحاولة شغالة (تأخير أقصى إضافي 4 دقايق مقبول
  // لرسائل retry، مش حرج زي تسجيل الدخول).
  ScriptApp.newTrigger("commHubProcessRetryQueue")
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log(" commHubProcessRetryQueue trigger installed: every 5 minutes");
}

/**
 * removeCommHubRetryTrigger — لإيقاف المعالجة الدورية لو احتجت (صيانة مثلاً)
 */
function removeCommHubRetryTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "commHubProcessRetryQueue") {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log(" Removed " + removed + " commHubProcessRetryQueue trigger(s)");
}

// ═══════════════════════════════════════════════════════════════════════════════
// [FIX-AUDIT-2026] §WA-WORKFLOWS — أتمتة واتساب (Workflows)
// الشاشة (19_JS_WhatsApp.html → WA_WF_UI) كانت تنادي "saveWAWorkflow" ولم تكن
// موجودة إطلاقاً في الباك اند، والحذف والقراءة كانا محليين فقط (بدون تخزين حقيقي
// في شيت) فيضيع كل شيء بمجرد تحديث الصفحة. تم بناء الوحدة كاملة هنا.
// ═══════════════════════════════════════════════════════════════════════════════
var COMMHUB_WORKFLOWS_HEADERS = [
  "id",
  "name",
  "trigger_type",
  "actions",
  "is_active",
  "created_by",
  "updated_at",
  "last_run", // [WF-EXEC-2026] آخر وقت تنفيذ فعلي — تُملأ من _commHubExecuteWorkflowServer
];

/** يجلب كل قواعد الأتمتة (Workflows) */
function getWAWorkflows(callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "manageWhatsappWorkflows",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet("WAWorkflows", COMMHUB_WORKFLOWS_HEADERS, {
      trimStrings: true,
    });
    rows.forEach(function (r) {
      r.is_active = !(
        r.is_active === false ||
        r.is_active === "FALSE" ||
        r.is_active === ""
      );
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب قواعد الأتمتة: " + e.message);
  }
}

/** ينشئ أو يحدّث قاعدة أتمتة (Workflow) — upsert بالـ id */
function saveWAWorkflow(callerUser, wfData, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "manageWhatsappWorkflows",
      sessionToken,
    );
    if (_permErr) return _permErr;
    if (!wfData || !wfData.id || !String(wfData.name || "").trim())
      return errResponse("بيانات الـ Workflow غير مكتملة");

    var sheet = getSheet("WAWorkflows", COMMHUB_WORKFLOWS_HEADERS);
    var rows = readSheet("WAWorkflows", COMMHUB_WORKFLOWS_HEADERS, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === wfData.id;
    });
    var now = new Date().toISOString();
    var isUpdate = idx !== -1;

    var record = {
      id: wfData.id,
      name: String(wfData.name).trim(),
      trigger_type: wfData.trigger_type || "",
      actions: typeof wfData.actions === "string" ? wfData.actions : "[]",
      is_active: wfData.is_active === false ? false : true,
      created_by: isUpdate ? rows[idx].created_by : callerUser,
      updated_at: now,
    };

    // [ARCH-AUDIT-P3-6] appendRow/setValue خام → DataLayerEngine.insert/update.
    if (!isUpdate) {
      var _wfInsertResult = DataLayerEngine.insert("WAWorkflows", record, {
        headers: COMMHUB_WORKFLOWS_HEADERS,
      });
      if (!_wfInsertResult.success)
        return errResponse(
          _wfInsertResult.errorMessage || "تعذّر حفظ الـ Workflow",
        );
    } else {
      var _wfUpdateResult = DataLayerEngine.update(
        "WAWorkflows",
        record.id,
        record,
        { headers: COMMHUB_WORKFLOWS_HEADERS },
      );
      if (!_wfUpdateResult.ok)
        return errResponse(
          _wfUpdateResult.errorMessage || "تعذّر حفظ الـ Workflow",
        );
    }

    _invalidateServerCache();
    AuditEngine.log(isUpdate ? "wa_workflow_updated" : "wa_workflow_created", {
      user: callerUser,
      table: "WAWorkflows",
      record_id: record.id,
      details: JSON.stringify({
        name: record.name,
        trigger_type: record.trigger_type,
        is_active: record.is_active,
      })});
    return okResponse("تم حفظ الـ Workflow بنجاح", { data: record });
  } catch (e) {
    return errResponse("خطأ في حفظ الـ Workflow: " + e.message);
  }
}

/** يحذف قاعدة أتمتة (Workflow) */
function deleteWAWorkflow(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "manageWhatsappWorkflows",
      sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = readSheet("WAWorkflows", COMMHUB_WORKFLOWS_HEADERS, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الـ Workflow غير موجود");

    var sheet = getSheet("WAWorkflows", COMMHUB_WORKFLOWS_HEADERS);
    sheet.deleteRow(idx + 2);
    _invalidateServerCache();
    AuditEngine.log("wa_workflow_deleted", {
      user: callerUser,
      table: "WAWorkflows",
      record_id: id});
    return okResponse("تم حذف الـ Workflow بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف الـ Workflow: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// [WF-EXEC-2026] §WA-WORKFLOWS-EXEC — التنفيذ الفعلي لقواعد الأتمتة (المرحلة 3)
// ─────────────────────────────────────────────────────────────────────────────
// ملحوظة معمارية مهمة: trigger_type في WAWorkflows أحداث بيزنس حقيقية
// (new_invoice, payment_received, order_shipped, order_delivered, low_balance,
// manual, scheduled, birthday) — مش أحداث رسائل واتساب واردة. التنفيذ التفاعلي
// (send_statement, send_catalog, notify_internal داخل الجلسة...) يظل في العميل
// عبر WA_WORKFLOW_ENGINE (19_JS_WhatsApp.html). الدوال هنا هي المسار السيرفري
// المطلوب لحالتين لا يضمن فيهما وجود جلسة عميل مفتوحة وقت التنفيذ:
//   1) triggerWaWorkflows(): استدعاء RPC اختياري من العميل لضمان التنفيذ حتى
//      لو أُغلق المتصفح فورًا بعد نجاح الحدث (لا يُستخدم افتراضيًا حاليًا —
//      المسار الافتراضي المفعّل هو WA_WORKFLOW_ENGINE.trigger() في العميل).
//   2) commHubRunScheduledWorkflows(): Time-driven Trigger يومي لـ
//      "scheduled" و"birthday" اللذين لا يُطلقهما أي حدث عميل أصلاً.
// الإجراءات المدعومة سيرفريًا: send_text فقط. باقي الإجراءات (قوالب، فواتير،
// تعيين موظف، تاج...) تفاعلية بطبيعتها أو تعتمد على تخزين client-only حاليًا
// (القوالب مثلاً)، فتُنفَّذ فقط عبر المسار العميل.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * _commHubRunWorkflowsForTrigger — ينفّذ كل الـ Workflows الفعّالة لنوع trigger
 * معيّن على قائمة بيانات (كل عنصر = حدث/عميل مستقل، بيحتاج data.phone على الأقل).
 */
function _commHubRunWorkflowsForTrigger(triggerType, dataList) {
  var rows;
  try {
    rows = readSheet("WAWorkflows", COMMHUB_WORKFLOWS_HEADERS, {
      trimStrings: true,
    });
  } catch (e) {
    console.warn("_commHubRunWorkflowsForTrigger[read]:", e.message);
    return;
  }
  var workflows = rows.filter(function (r) {
    return (
      String(r.trigger_type || "") === String(triggerType) &&
      !(r.is_active === false || r.is_active === "FALSE" || r.is_active === "")
    );
  });
  if (!workflows.length) return;

  (dataList || []).forEach(function (data) {
    workflows.forEach(function (wf) {
      _commHubExecuteWorkflowServer(wf, data || {});
    });
  });
}

function _commHubExecuteWorkflowServer(wf, data) {
  var actions;
  try {
    actions = JSON.parse(wf.actions || "[]");
  } catch (e) {
    return;
  }

  var phone = data.phone || data.customer_phone || "";
  var sentAny = false;

  if (phone) {
    actions.forEach(function (action) {
      if (action.type !== "send_text") return; // باقي الأنواع تفاعلية/عميل فقط
      var text = _commHubResolvePlaceholders(action.content || "", data);
      if (!text) return;
      try {
        var conv = _commHubFindOrCreateConversation("whatsapp", {
          chat_id: phone,
          phone: phone,
          contact_name: data.customer_name || phone,
          message_id: "",
          type: "text",
          content: "",
          timestamp: new Date(),
        });
        _commHubSendReply(conv, {
          type: "text",
          text: text,
          origin: "system",
        });
        sentAny = true;
      } catch (e) {
        console.warn("_commHubExecuteWorkflowServer[send]:", e.message);
      }
    });
  }

  // [WF-EXEC-2026] تحديث last_run بغض النظر عن نجاح الإرسال — الهدف تتبّع آخر
  // مرة اتفحص فيها الـ Workflow ضد الحدث ده، مش سجل نجاح إرسال.
  try {
    var sheet = getSheet("WAWorkflows", COMMHUB_WORKFLOWS_HEADERS);
    var allRows = readSheet("WAWorkflows", COMMHUB_WORKFLOWS_HEADERS);
    var idx = allRows.findIndex(function (r) {
      return r.id === wf.id;
    });
    if (idx !== -1)
      _applyRowUpdates(sheet, allRows[idx]._row, COMMHUB_WORKFLOWS_HEADERS, {
        last_run: new Date(),
      });
  } catch (e) {
    console.warn("_commHubExecuteWorkflowServer[touch]:", e.message);
  }

  return sentAny;
}

function _commHubResolvePlaceholders(text, data) {
  return String(text || "").replace(/\{(\w+)\}/g, function (m, key) {
    return data[key] != null && data[key] !== "" ? String(data[key]) : m;
  });
}

/**
 * triggerWaWorkflows — نقطة استدعاء RPC اختيارية من العميل لتشغيل Workflows
 * حدث بيزنس معيّن سيرفريًا (بديل احتياطي لـ WA_WORKFLOW_ENGINE.trigger()
 * العميل — مفيد لو الحدث حساس ومحتاج ضمان تنفيذ حتى لو قفل المستخدم الصفحة).
 */
function triggerWaWorkflows(callerUser, triggerType, data, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "useWhatsappAutoReply",
      sessionToken,
    );
    if (permErr) return permErr;
    if (!triggerType) return errResponse("نوع الـ Trigger مطلوب");
    _commHubRunWorkflowsForTrigger(triggerType, [data || {}]);
    return okResponse("تم التشغيل");
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// جدولة يومية: scheduled + birthday (§WF-EXEC-2026)
// ─────────────────────────────────────────────────────────────

/**
 * commHubRunScheduledWorkflows — تُستدعى يوميًا عبر Time-driven Trigger
 * (فعّلها من Apps Script Editor بتشغيل setupWaWorkflowsDailyTrigger() مرة واحدة).
 *  - "scheduled": يُنفَّذ مرة يوميًا (بدون بيانات عميل محدد — أي إجراء يحتاج
 *    رقم هاتف فعلي هيتخطى نفسه صامتًا).
 *  - "birthday": لكل عميل في شيت Customers حقل "birth_date" = تاريخ النهارده
 *    (شهر/يوم). ملحوظة: عمود birth_date غير موجود افتراضيًا في نسخ العملاء
 *    الحالية — الدالة بترجع بهدوء لو العمود مش موجود؛ إضافته وربطه بشاشة
 *    بيانات العميل شغلة منفصلة (مش ضمن نطاق هذه المرحلة).
 */
function commHubRunScheduledWorkflows() {
  try {
    _commHubRunWorkflowsForTrigger("scheduled", [{}]);
  } catch (e) {
    console.warn("commHubRunScheduledWorkflows[scheduled]:", e.message);
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Customers");
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var colBirth = headers.indexOf("birth_date");
    if (colBirth === -1) return; // العمود لسه مش مضاف
    var colName = headers.indexOf("name");
    var colPhone = headers.indexOf("phone");
    var colId = headers.indexOf("id");
    var tz = Session.getScriptTimeZone();
    var todayKey = Utilities.formatDate(new Date(), tz, "MM-dd");
    var birthdayList = [];
    for (var i = 1; i < data.length; i++) {
      var raw = data[i][colBirth];
      if (!raw) continue;
      var d = raw instanceof Date ? raw : new Date(raw);
      if (isNaN(d.getTime())) continue;
      if (Utilities.formatDate(d, tz, "MM-dd") === todayKey) {
        birthdayList.push({
          customer_id: colId >= 0 ? data[i][colId] : "",
          customer_name: colName >= 0 ? data[i][colName] : "",
          phone: colPhone >= 0 ? data[i][colPhone] : "",
        });
      }
    }
    if (birthdayList.length)
      _commHubRunWorkflowsForTrigger("birthday", birthdayList);
  } catch (e) {
    console.warn("commHubRunScheduledWorkflows[birthday]:", e.message);
  }
}

/** setupWaWorkflowsDailyTrigger — يفعّل التشغيل اليومي (نادِها مرة واحدة يدويًا) */
function setupWaWorkflowsDailyTrigger() {
  removeWaWorkflowsDailyTrigger();
  ScriptApp.newTrigger("commHubRunScheduledWorkflows")
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();
  Logger.log("✅ تم تفعيل مُشغّل WAWorkflows اليومي (9 صباحًا)");
}

/** removeWaWorkflowsDailyTrigger — لإيقاف التشغيل اليومي لو احتجت (صيانة) */
function removeWaWorkflowsDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "commHubRunScheduledWorkflows") {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log("Removed " + removed + " commHubRunScheduledWorkflows trigger(s)");
}
