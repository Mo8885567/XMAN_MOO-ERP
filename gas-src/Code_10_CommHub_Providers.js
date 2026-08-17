// ════════════════════════════════════════════════════════════════
// Code_CommHub_Providers.gs — [COMMHUB-P2] سجل مزوّدي القنوات (Provider
// Registry) + مزوّد الواتساب (أول قناة).
//
// يستبدل هذا الملف Code_WhatsAppGateway.gs بالكامل (راجع
// COMMUNICATION_HUB_SPEC.md §2). النمط: كل Provider (واتساب، تليجرام
// مستقبلاً...) يوفّر ثلاث دوال بنفس التوقيع دائماً:
//
//   sendMessage(conversation, payload)  → {success, provider_message_id}
//   getStatus()                          → حالة الاتصال الموحّدة
//   normalizeIncoming(rawPayload)        → شكل CommHub_Messages الموحّد
//
// الـ Hub Core (Code_CommunicationHub.gs) بيتعامل فقط مع الـ Interface
// ده عن طريق _commHubGetProvider(providerKey) — صفر معرفة بتفاصيل
// واتساب أو أي قناة تانية جوه الـ Hub نفسه.
// ════════════════════════════════════════════════════════════════

var COMMHUB_PROVIDERS_SHEET = "CommHub_Providers";
var COMMHUB_PROVIDERS_HEADERS = [
  "provider_key", // whatsapp / telegram / email...
  "display_name",
  "bridge_url", // رابط سيرفر الـ Bridge (Node.js)
  "hub_api_key", // المفتاح اللي الـ Bridge لازم يبعته للـ ERP (X-Hub-Api-Key) — نخزنه عشان نقارن بيه
  "bridge_api_key", // المفتاح اللي الـ ERP بيبعته للـ Bridge (X-Bridge-Api-Key)
  "webhook_secret", // سر توقيع HMAC للـ Webhook (بديل X-Hub-Signature — راجع ملاحظة GAS أسفل)
  "is_active",
  "last_state", // connected / disconnected / qr_required / not_configured
  "connected_number",
  "config_json",
  "updated_at",
  "updated_by",
];

// ─────────────────────────────────────────────────────────────
// ملاحظة معمارية مهمة (انحراف واعٍ عن SPEC.md §3.1):
//
// Google Apps Script's doPost(e) **لا يعرض أي HTTP Headers للطلب
// الوارد** — مفيش e.headers ولا أي طريقة تانية لقراءة X-Hub-Signature
// كـ Header فعلي زي ما مكتوب في العقد. القيد ده بتاع GAS نفسه، مش
// قرار تصميم.
//
// الحل: بدل ما يبعت الـ Bridge التوقيع كـ Header، يبعته كـ حقل داخل
// جسم الـ JSON نفسه: { hub_event, provider, timestamp, signature, data }
// حيث signature = HMAC-SHA256(timestamp + "." + JSON.stringify(data), webhook_secret)
// بنفس مبدأ Stripe لكن الحمل موجود في الـ Body مش في الـ Header.
// الاتجاه التاني (ERP → Bridge) فيه GAS هو اللي بيبعت الطلب، فبيقدر
// يحط X-Bridge-Api-Key كـ Header عادي بدون أي مشكلة (UrlFetchApp
// بيدعم Headers فعلياً للطلبات الصادرة).
//
// **لازم تحديث whatsapp-bridge (Node.js) عشان يبعت التوقيع جوه الـ
// body مش كـ Header** — التفصيلة دي لازم تتراجع مع كود الـ Bridge
// الموجود فعلاً قبل التفعيل الفعلي.
// ─────────────────────────────────────────────────────────────

function _commHubReadProviderConfig(providerKey) {
  var rows = readSheet(COMMHUB_PROVIDERS_SHEET, COMMHUB_PROVIDERS_HEADERS, {
    trimStrings: true,
  });
  return (
    rows.find(function (r) {
      return String(r.provider_key || "") === String(providerKey);
    }) || null
  );
}

function _commHubUpdateProviderField(providerKey, field, value) {
  try {
    var sheet = getSheet(COMMHUB_PROVIDERS_SHEET, COMMHUB_PROVIDERS_HEADERS);
    var rows = readSheet(COMMHUB_PROVIDERS_SHEET, COMMHUB_PROVIDERS_HEADERS);
    var row = rows.find(function (r) {
      return String(r.provider_key || "") === String(providerKey);
    });
    if (!row) return;
    var colIdx = COMMHUB_PROVIDERS_HEADERS.indexOf(field) + 1;
    if (colIdx <= 0) return;
    sheet.getRange(row._row, colIdx).setValue(value);
  } catch (e) {
    console.warn("_commHubUpdateProviderField failed:", e.message);
  }
}

/**
 * getCommHubProviders — يجلب كل القنوات المسجّلة (بدون كشف المفاتيح كاملة)
 * صلاحية: manageCommunicationHub
 */
function getCommHubProviders(callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "manageCommunicationHub",
      sessionToken,
    );
    if (permErr) return permErr;

    var rows = readSheet(COMMHUB_PROVIDERS_SHEET, COMMHUB_PROVIDERS_HEADERS, {
      trimStrings: true,
    });
    var data = rows.map(function (r) {
      return {
        provider_key: r.provider_key,
        display_name: r.display_name,
        bridge_url: r.bridge_url,
        has_hub_api_key: !!r.hub_api_key,
        has_bridge_api_key: !!r.bridge_api_key,
        has_webhook_secret: !!r.webhook_secret,
        is_active: r.is_active === true || r.is_active === "TRUE",
        last_state: r.last_state || "not_configured",
        connected_number: r.connected_number || "",
      };
    });
    return okResponse("تم الجلب", { data: data });
  } catch (e) {
    console.error("getCommHubProviders:", e);
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * saveCommHubProvider — Upsert لإعدادات قناة (رابط الـ Bridge + المفاتيح)
 * المفاتيح تتحدّث فقط لو اتبعتت قيمة غير فاضية (نفس نمط WhatsAppGatewayConfig).
 * صلاحية: manageCommunicationHub
 */
function saveCommHubProvider(data, callerUser, sessionToken) {
  try {
    var permErr = _checkPermission(
      callerUser,
      "manageCommunicationHub",
      sessionToken,
    );
    if (permErr) return permErr;

    var d = data || {};
    if (!d.provider_key)
      return errResponse("مفتاح القناة (provider_key) مطلوب");
    if (!d.bridge_url) return errResponse("رابط الـ Bridge مطلوب");

    var sheet = getSheet(COMMHUB_PROVIDERS_SHEET, COMMHUB_PROVIDERS_HEADERS);
    var rows = readSheet(COMMHUB_PROVIDERS_SHEET, COMMHUB_PROVIDERS_HEADERS);
    var existing = rows.find(function (r) {
      return String(r.provider_key || "") === String(d.provider_key);
    });
    var now = new Date();

    if (!existing) {
      if (!d.hub_api_key || !d.bridge_api_key || !d.webhook_secret) {
        return errResponse(
          "المفاتيح الثلاثة (hub_api_key, bridge_api_key, webhook_secret) مطلوبة عند أول إعداد",
        );
      }
      sheet.appendRow([
        d.provider_key,
        d.display_name || d.provider_key,
        d.bridge_url,
        d.hub_api_key,
        d.bridge_api_key,
        d.webhook_secret,
        d.is_active === false ? false : true,
        "not_connected",
        "",
        JSON.stringify(d.config || {}),
        now,
        callerUser,
      ]);
    } else {
      var col = function (name) {
        return COMMHUB_PROVIDERS_HEADERS.indexOf(name) + 1;
      };
      sheet
        .getRange(existing._row, col("display_name"))
        .setValue(d.display_name || existing.display_name);
      sheet.getRange(existing._row, col("bridge_url")).setValue(d.bridge_url);
      if (typeof d.is_active === "boolean") {
        sheet.getRange(existing._row, col("is_active")).setValue(d.is_active);
      }
      if (d.hub_api_key)
        sheet
          .getRange(existing._row, col("hub_api_key"))
          .setValue(d.hub_api_key);
      if (d.bridge_api_key)
        sheet
          .getRange(existing._row, col("bridge_api_key"))
          .setValue(d.bridge_api_key);
      if (d.webhook_secret)
        sheet
          .getRange(existing._row, col("webhook_secret"))
          .setValue(d.webhook_secret);
      if (d.config)
        sheet
          .getRange(existing._row, col("config_json"))
          .setValue(JSON.stringify(d.config));
      sheet.getRange(existing._row, col("updated_at")).setValue(now);
      sheet.getRange(existing._row, col("updated_by")).setValue(callerUser);
    }

    AuditEngine.log("commhub_provider_save", {
      user: callerUser,
      table: COMMHUB_PROVIDERS_SHEET,
      record_id: d.provider_key,
      details: JSON.stringify({
        bridge_url: d.bridge_url,
        keys_changed: !!(d.hub_api_key || d.bridge_api_key || d.webhook_secret),
      })});

    return okResponse("تم حفظ إعدادات القناة بنجاح");
  } catch (e) {
    console.error("saveCommHubProvider:", e);
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// §PROVIDER-INTERFACE — الواجهة الموحّدة لكل Provider
// ═══════════════════════════════════════════════════════════════════

/**
 * _commHubGetProvider — يرجّع كائن Provider جاهز حسب المفتاح.
 * الـ Hub Core بينادي الدالة دي بس ومش عارف حاجة عن التفاصيل جوه.
 */
function _commHubGetProvider(providerKey) {
  if (providerKey === "whatsapp") return _WhatsAppCommHubProvider;
  throw new Error("Provider غير مدعوم: " + providerKey);
}

/**
 * [SEC-WA-ALERT] _sendSystemWhatsAppAlert — إرسال رسالة نظامية مباشرة
 * (زي تنبيهات الأمان) لرقم إداري عبر نفس Bridge بتاع قناة الواتساب،
 * من غير الحاجة لمحادثة (conversation) موجودة أصلاً. تُستخدم حالياً
 * من _notifyAdminLoginBlock في Code_12_Core.gs كقناة إضافية بجانب
 * الإيميل — تفشل بصمت لو القناة غير مُعدّة (نفس سلوك الإيميل).
 *
 * @param {String} phone - رقم الأدمن بصيغة دولية بدون +  (مثال: 201025306678)
 * @param {String} text - نص التنبيه
 * @returns {{success:boolean, message?:string}}
 */
function _sendSystemWhatsAppAlert(phone, text) {
  try {
    if (!phone) return { success: false, message: "لا يوجد رقم أدمن مُعدّ" };
    var cfg = _commHubReadProviderConfig("whatsapp");
    if (!cfg || !cfg.bridge_url || !cfg.bridge_api_key) {
      return { success: false, message: "قناة الواتساب غير مُعدّة بعد" };
    }
    var cleanPhone = String(phone).replace(/[^0-9]/g, "");
    var url = String(cfg.bridge_url).replace(/\/+$/, "") + "/api/send";
    var body = {
      chat_id: cleanPhone,
      type: "text",
      text: text,
      media_url: "",
      reply_to: null,
      origin: "system_alert",
      conversation_id: "system-alert",
    };
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { "X-Bridge-Api-Key": cfg.bridge_api_key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() !== 200) {
      return {
        success: false,
        message:
          "فشل إرسال تنبيه واتساب (كود " + response.getResponseCode() + ")",
      };
    }
    var result = JSON.parse(response.getContentText());
    return { success: !!result.success, message: result.message || "" };
  } catch (e) {
    console.warn("_sendSystemWhatsAppAlert:", e.message);
    return { success: false, message: e.message };
  }
}

// ── WhatsApp Provider (أول قناة) ───────────────────────────────

var _WhatsAppCommHubProvider = {
  key: "whatsapp",

  /**
   * sendMessage(conversation, payload) → {success, provider_message_id, status}
   * payload: {type, text, media_url, reply_to, origin, conversation_id}
   */
  sendMessage: function (conversation, payload) {
    var cfg = _commHubReadProviderConfig("whatsapp");
    if (!cfg || !cfg.bridge_url || !cfg.bridge_api_key) {
      return { success: false, message: "قناة الواتساب غير مُعدّة بعد" };
    }

    var url = String(cfg.bridge_url).replace(/\/+$/, "") + "/api/send";
    var body = {
      chat_id: conversation.chat_id,
      type: payload.type || "text",
      text: payload.text || "",
      media_url: payload.media_url || "",
      reply_to: payload.reply_to || null,
      origin: payload.origin || "system",
      conversation_id: conversation.conversation_id,
    };

    try {
      var response = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { "X-Bridge-Api-Key": cfg.bridge_api_key },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      });
      var code = response.getResponseCode();
      if (code !== 200) {
        return {
          success: false,
          message: "فشل إرسال Bridge (كود " + code + ")",
          http_status: code,
        };
      }
      var result = JSON.parse(response.getContentText());
      return {
        success: !!result.success,
        provider_message_id: result.bridge_message_id || "",
        status: result.status || "queued",
      };
    } catch (e) {
      console.error("_WhatsAppCommHubProvider.sendMessage:", e);
      return {
        success: false,
        message: "تعذّر الاتصال بالـ Bridge: " + e.message,
      };
    }
  },

  /**
   * getStatus() → حالة الاتصال الموحّدة (يُستخدم في الـ Dashboard)
   */
  getStatus: function () {
    var cfg = _commHubReadProviderConfig("whatsapp");
    if (!cfg || !cfg.bridge_url || !cfg.bridge_api_key) {
      return { connected: false, state: "not_configured" };
    }
    var url = String(cfg.bridge_url).replace(/\/+$/, "") + "/api/status";
    try {
      var response = UrlFetchApp.fetch(url, {
        method: "get",
        headers: { "X-Bridge-Api-Key": cfg.bridge_api_key },
        muteHttpExceptions: true,
      });
      if (response.getResponseCode() !== 200) {
        return { connected: false, state: "unreachable" };
      }
      var body = JSON.parse(response.getContentText());
      _commHubUpdateProviderField(
        "whatsapp",
        "last_state",
        body.connected
          ? "connected"
          : body.qr_required
            ? "qr_required"
            : "disconnected",
      );
      _commHubUpdateProviderField(
        "whatsapp",
        "connected_number",
        body.connected_number || "",
      );
      return body;
    } catch (e) {
      console.error("_WhatsAppCommHubProvider.getStatus:", e);
      return { connected: false, state: "error", message: e.message };
    }
  },

  /**
   * normalizeIncoming(rawPayload) → شكل CommHub_Messages/Conversations الموحّد
   * rawPayload بيوصل بالشكل الموضّح في SPEC.md §3.2
   */
  normalizeIncoming: function (raw) {
    return {
      provider: "whatsapp",
      chat_id: raw.chat_id,
      phone: raw.phone || String(raw.chat_id || "").split("@")[0],
      contact_name: raw.contact_name || raw.phone || "",
      message_id: raw.message_id,
      type: raw.type || "text",
      content:
        raw.type === "text"
          ? raw.text || ""
          : (raw.media && raw.media.caption) || "",
      media_url: (raw.media && raw.media.url) || "",
      media_type: (raw.media && raw.media.mime_type) || "",
      reply_to: raw.reply_to || null,
      is_forwarded: !!raw.is_forwarded,
      timestamp: raw.timestamp ? new Date(raw.timestamp * 1000) : new Date(),
    };
  },
};
