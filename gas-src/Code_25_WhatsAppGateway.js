// ════════════════════════════════════════════════════════════════
// Code_WhatsAppGateway.gs — [WA-GATEWAY-1] بوابة واتساب غير رسمية (Baileys)
//
// المسؤولية: التواصل مع سيرفر Baileys الخارجي (Node.js منفصل يديره
// المستخدم — راجع مجلد whatsapp-gateway/) عبر UrlFetchApp. لا يحتوي
// هذا الملف أي كود اتصال واتساب فعلي — GAS مش قادر يستضيف جلسة
// WebSocket مستمرة، فكل التواصل هنا REST بسيط (GET/POST) بالظبط زي
// تكامل sendTelegram الموجود في Code_Setup.gs.
//
// يضيف هذا الملف:
//   - شيت WhatsAppGatewayConfig (صف واحد حاليًا — نظام أحادي الفرع)
//   - getWhatsappGatewayConfig / saveWhatsappGatewayConfig
//   - getWhatsappGatewayStatus (حالة الاتصال + QR الحالي إن وُجد)
//   - logoutWhatsappGateway
//
// صلاحية جديدة مطلوبة: manageWhatsappGateway (أضِفها لـ ALL_PERMISSIONS
// في Code_Permissions.gs — راجع دليل التركيب INTEGRATION_GUIDE.md).
// ════════════════════════════════════════════════════════════════

var WA_GATEWAY_SHEET = "WhatsAppGatewayConfig";
var WA_GATEWAY_HEADERS = [
  "id",
  "gateway_url",
  "secret_key",
  "connected_number",
  "last_state",
  "updated_at",
  "updated_by",
];

// ── قراءة/تحديث داخلي ──────────────────────────────────────────

/**
 * _readWAGatewayConfig — يقرأ صف الإعدادات الوحيد (لو موجود)
 * @returns {Object|null}
 */
function _readWAGatewayConfig() {
  var rows = readSheet(WA_GATEWAY_SHEET, WA_GATEWAY_HEADERS, {
    trimStrings: true,
  });
  return rows.length ? rows[0] : null;
}

/**
 * _updateWAGatewayField — يحدّث عمود واحد في صف الإعدادات (بدون إعادة كتابة الصف كله)
 */
function _updateWAGatewayField(field, value) {
  try {
    var sheet = getSheet(WA_GATEWAY_SHEET, WA_GATEWAY_HEADERS);
    var rows = readSheet(WA_GATEWAY_SHEET, WA_GATEWAY_HEADERS);
    if (!rows.length) return;
    var colIdx = WA_GATEWAY_HEADERS.indexOf(field) + 1;
    if (colIdx <= 0) return;
    sheet.getRange(rows[0]._row, colIdx).setValue(value);
  } catch (e) {
    console.warn("_updateWAGatewayField failed:", e.message);
  }
}

// ── CRUD إعدادات (يُستدعى من شاشة الإدارة) ─────────────────────

/**
 * getWhatsappGatewayConfig — يجلب إعدادات البوابة الحالية (بدون كشف المفتاح كامل)
 * صلاحية: manageWhatsappGateway
 */
function getWhatsappGatewayConfig(callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "manageWhatsappGateway",
      sessionToken,
    );
    if (permErr) return permErr;

    var cfg = _readWAGatewayConfig();
    if (!cfg) {
      return okResponse("لا توجد إعدادات بعد", {
        gateway_url: "",
        has_secret: false,
        connected_number: "",
        last_state: "not_configured",
      });
    }

    return okResponse("تم الجلب", {
      gateway_url: cfg.gateway_url || "",
      has_secret: !!cfg.secret_key,
      connected_number: cfg.connected_number || "",
      last_state: cfg.last_state || "unknown",
    });
  } catch (e) {
    console.error("getWhatsappGatewayConfig:", e);
    return errResponse("خطأ: " + e.message);
  }
}

/**
 * saveWhatsappGatewayConfig — يحفظ رابط/مفتاح البوابة (Upsert لصف واحد)
 * صلاحية: manageWhatsappGateway
 *
 * ملاحظة: secret_key بيتحدّث فقط لو المستخدم بعت قيمة غير فاضية —
 * كده الفرونت إند يقدر يبعت الرابط لوحده لتحديثه من غير ما "يمسح"
 * المفتاح المحفوظ مسبقًا (الفرونت إند بيعرض المفتاح كـ **** دايمًا).
 */
function saveWhatsappGatewayConfig(data, callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "manageWhatsappGateway",
      sessionToken,
    );
    if (permErr) return permErr;

    var d = data || {};
    if (!d.gateway_url) return errResponse("رابط سيرفر البوابة مطلوب");

    var sheet = getSheet(WA_GATEWAY_SHEET, WA_GATEWAY_HEADERS);
    var rows = readSheet(WA_GATEWAY_SHEET, WA_GATEWAY_HEADERS);
    var now = new Date();

    if (!rows.length) {
      if (!d.secret_key)
        return errResponse("المفتاح السري مطلوب عند أول إعداد");
      sheet.appendRow([
        makeId("WAGW"),
        d.gateway_url,
        d.secret_key,
        "",
        "not_connected",
        now,
        callerUser,
      ]);
    } else {
      var row = rows[0];
      var urlCol = WA_GATEWAY_HEADERS.indexOf("gateway_url") + 1;
      var tsCol = WA_GATEWAY_HEADERS.indexOf("updated_at") + 1;
      var byCol = WA_GATEWAY_HEADERS.indexOf("updated_by") + 1;
      sheet.getRange(row._row, urlCol).setValue(d.gateway_url);
      sheet.getRange(row._row, tsCol).setValue(now);
      sheet.getRange(row._row, byCol).setValue(callerUser);
      if (d.secret_key) {
        var keyCol = WA_GATEWAY_HEADERS.indexOf("secret_key") + 1;
        sheet.getRange(row._row, keyCol).setValue(d.secret_key);
      }
    }

    AuditEngine.log("whatsapp_gateway_config_save", {
      user: callerUser,
      table: WA_GATEWAY_SHEET,
      record_id: "",
      details: JSON.stringify({
        gateway_url: d.gateway_url,
        secret_changed: !!d.secret_key,
      })});

    return okResponse("تم حفظ إعدادات البوابة بنجاح");
  } catch (e) {
    console.error("saveWhatsappGatewayConfig:", e);
    return errResponse("خطأ: " + e.message);
  }
}

// ── حالة الاتصال (Polling من شاشة الإدارة) ─────────────────────

/**
 * getWhatsappGatewayStatus — يستعلم من سيرفر Baileys الخارجي عن حالة
 * الاتصال الحالية (متصل / في انتظار مسح QR / غير متصل) + صورة QR
 * (base64) لو محتاجة تُعرض.
 * صلاحية: manageWhatsappGateway
 */
function getWhatsappGatewayStatus(callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "manageWhatsappGateway",
      sessionToken,
    );
    if (permErr) return permErr;

    var cfg = _readWAGatewayConfig();
    if (!cfg || !cfg.gateway_url || !cfg.secret_key) {
      return okResponse("لم يتم إعداد البوابة بعد", {
        state: "not_configured",
      });
    }

    var url = String(cfg.gateway_url).replace(/\/+$/, "") + "/status";
    var response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { "x-gateway-key": cfg.secret_key },
      muteHttpExceptions: true,
      followRedirects: true,
    });

    var code = response.getResponseCode();
    if (code !== 200) {
      return errResponse("تعذّر الاتصال بسيرفر البوابة (كود " + code + ")");
    }

    var body = JSON.parse(response.getContentText());
    if (!body.success) {
      return errResponse(body.message || "فشل الاستعلام عن الحالة");
    }

    // تحديث الحالة/الرقم في الشيت (للعرض السريع لاحقًا بدون نداء خارجي)
    _updateWAGatewayField("last_state", body.state || "unknown");
    _updateWAGatewayField("connected_number", body.connectedNumber || "");

    return okResponse("تم الجلب", {
      state: body.state,
      qr: body.qr || null,
      connectedNumber: body.connectedNumber || "",
      queueLength: body.queueLength || 0,
      dailyCount: body.dailyCount || 0,
      dailyLimit: body.dailyLimit || 0,
    });
  } catch (e) {
    console.error("getWhatsappGatewayStatus:", e);
    return errResponse("تعذّر الاتصال بسيرفر البوابة: " + e.message);
  }
}

/**
 * logoutWhatsappGateway — يسجّل خروج الجلسة الحالية من سيرفر البوابة
 * (لازم بعدها مسح QR جديد لربط نفس الرقم أو رقم مختلف).
 * صلاحية: manageWhatsappGateway
 */
function logoutWhatsappGateway(callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var permErr = _checkPermission(
      callerUser,
      "manageWhatsappGateway",
      sessionToken,
    );
    if (permErr) return permErr;

    var cfg = _readWAGatewayConfig();
    if (!cfg || !cfg.gateway_url || !cfg.secret_key) {
      return errResponse("البوابة غير مُعدّة بعد");
    }

    var url = String(cfg.gateway_url).replace(/\/+$/, "") + "/logout";
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      headers: { "x-gateway-key": cfg.secret_key },
      muteHttpExceptions: true,
    });

    var body = JSON.parse(response.getContentText());
    if (body.success) {
      _updateWAGatewayField("last_state", "disconnected");
      _updateWAGatewayField("connected_number", "");
      AuditEngine.log("whatsapp_gateway_logout", {
        user: callerUser,
        table: WA_GATEWAY_SHEET,
        record_id: "",
        details: ""});
    }

    return body.success
      ? okResponse(body.message || "تم تسجيل الخروج")
      : errResponse(body.message || "فشل تسجيل الخروج");
  } catch (e) {
    console.error("logoutWhatsappGateway:", e);
    return errResponse("خطأ: " + e.message);
  }
}
