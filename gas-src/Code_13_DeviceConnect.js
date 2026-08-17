// ════════════════════════════════════════════════════════════════
// Code_DeviceConnect.gs — [REFACTOR-P4] نُقل من Code_Modules.gs (نقل نصي بحت، صفر
// تغيير في المنطق أو الترتيب الداخلي). Apps Script يعامل كل ملفات .gs
// كـ Global Scope واحد، فنقل الدوال هنا لا يكسر أي استدعاء طالما
// الأسماء لم تتغير (ولم تتغير). راجع تقرير Architecture Audit
// 2026-07-03 — قسم 2 (Code_Modules.gs احتاج فحص لتحديد محتواه الفعلي).
//
// المسؤولية: Device Direct Connect Backend — الاتصال المباشر بأجهزة البصمة/الحضور (جلب حضور/موظفين، جدولة، Adapters)
// ════════════════════════════════════════════════════════════════

function testDeviceConnection(payload) {
  try {
    var auth = _requirePermission(payload, "importAttendance");
    var adapter = _ddcBuildAdapter(payload);
    var result = adapter.test();
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
/**
 * fetchDeviceAttendance — جلب سجلات الحضور من الجهاز مباشرة
 * @param {object} payload — { host, port, ssl, brand, username, password, api_key,
 *                             endpoint, from_date, to_date, sync_employees, _user, _token }
 */
function fetchDeviceAttendance(payload) {
  try {
    var auth = _requirePermission(payload, "importAttendance");
    var adapter = _ddcBuildAdapter(payload);
    var raw = adapter.getAttendance(payload.from_date, payload.to_date);
    if (!raw.success) return raw;

    // تحويل السجلات لصيغة النظام
    var employees = readSheet("Employees", null) || [];
    var empByBadge = {};
    var empByNum = {};
    employees.forEach(function (e) {
      if (e.badge_number) empByBadge[String(e.badge_number).trim()] = e;
      if (e.employee_number) empByNum[String(e.employee_number).trim()] = e;
    });

    var records = _ddcParseAttendance(
      raw.raw_records || [],
      payload.brand,
      empByBadge,
      empByNum,
      auth,
    );
    return { success: true, records: records, total: records.length };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
/**
 * fetchDeviceEmployees — جلب قائمة موظفي الجهاز
 */
function fetchDeviceEmployees(payload) {
  try {
    var auth = _requirePermission(payload, "importAttendance");
    var adapter = _ddcBuildAdapter(payload);
    var result = adapter.getEmployees();
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}
/**
 * setDeviceSchedule — إعداد/إلغاء Trigger تلقائي لجلب الحضور
 */
function setDeviceSchedule(payload) {
  try {
    var auth = _requirePermission(payload, "importAttendance");
    var deviceId = payload.device_id;
    var enabled = payload.enabled;
    var minutes = parseInt(payload.interval_minutes) || 60;

    // حذف أي trigger قديم لهذا الجهاز
    var triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(function (t) {
      if (t.getHandlerFunction() === "_ddcAutoFetch_" + deviceId) {
        ScriptApp.deleteTrigger(t);
      }
    });

    if (enabled) {
      // حفظ config الجهاز في PropertiesService
      PropertiesService.getScriptProperties().setProperty(
        "ddc_device_" + deviceId,
        JSON.stringify(payload.device_config || {}),
      );
      // إنشاء trigger جديد
      ScriptApp.newTrigger("_ddcAutoFetchDevice")
        .timeBased()
        .everyMinutes(minutes >= 15 ? minutes : 15)
        .create();
      // تخزين device_id المرتبط
      PropertiesService.getScriptProperties().setProperty(
        "ddc_trigger_device_" + deviceId,
        JSON.stringify({
          device_id: deviceId,
          interval: minutes,
          created_by: auth.full_name,
          created_at: new Date().toISOString(),
        }),
      );
    } else {
      PropertiesService.getScriptProperties().deleteProperty(
        "ddc_device_" + deviceId,
      );
      PropertiesService.getScriptProperties().deleteProperty(
        "ddc_trigger_device_" + deviceId,
      );
    }

    return {
      success: true,
      message: enabled ? "تم تفعيل الجدولة" : "تم إلغاء الجدولة",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
/**
 * _ddcAutoFetchDevice — يُستدعى من الـ Trigger التلقائي
 * تلقائياً يجلب آخر ساعتين من كل جهاز مُجدوَل
 */
function _ddcAutoFetchDevice() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var now = new Date();
  var today = Utilities.formatDate(
    now,
    Session.getScriptTimeZone(),
    "yyyy-MM-dd",
  );

  Object.keys(props).forEach(function (key) {
    if (!key.startsWith("ddc_device_")) return;
    try {
      var device = JSON.parse(props[key] || "{}");
      if (!device.host) return;

      var adapter = _ddcBuildAdapter(device);
      var raw = adapter.getAttendance(today, today);
      if (!raw.success || !raw.raw_records || !raw.raw_records.length) return;

      var employees = readSheet("Employees", null) || [];
      var empByBadge = {};
      var empByNum = {};
      employees.forEach(function (e) {
        if (e.badge_number) empByBadge[String(e.badge_number).trim()] = e;
        if (e.employee_number) empByNum[String(e.employee_number).trim()] = e;
      });

      var records = _ddcParseAttendance(
        raw.raw_records,
        device.brand,
        empByBadge,
        empByNum,
        { full_name: "Auto-Trigger" },
      );
      if (!records.length) return;

      importAttendanceBatch({
        records: records,
        meta: {
          file_name: (device.name || device.host) + " — Auto",
          device_type: device.brand || "generic",
          total_in_file: records.length,
          valid_count: records.length,
          rejected_count: 0,
          rejected_details: [],
          source: "auto_trigger",
        },
        _user: "system",
        _token: "system",
      });
    } catch (e) {
      Logger.log("DDC Auto-fetch error for key " + key + ": " + e.message);
    }
  });
}
// ──────────────────────────────────────────────────────────────────────
// _ddcBuildAdapter — بناء محوّل HTTP حسب الماركة
// ──────────────────────────────────────────────────────────────────────
/**
 * يتحقق من هدف جهاز الحضور قبل تمريره إلى UrlFetchApp.
 * يقبل عنوان IPv4 أو اسم مضيف/DNS فقط، ويرفض عناوين loopback والـ metadata
 * أو أي صيغة URL كاملة قد تتحول إلى SSRF عبر تركيب الرابط أدناه.
 */
function _ddcValidateEndpoint(cfg) {
  cfg = cfg || {};
  var host = String(cfg.host || "").trim();
  if (!host) throw new Error("عنوان الجهاز مطلوب");
  if (
    host.indexOf("://") !== -1 ||
    /[\\/@?#\s]/.test(host) ||
    host.toLowerCase() === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^0\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    throw new Error("عنوان الجهاز غير صالح");
  }
  if (
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\d{1,3}(?:\.\d{1,3}){3})$/.test(
      host,
    )
  )
    throw new Error("عنوان الجهاز غير صالح");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    var octets = host.split(".");
    if (
      octets.some(function (octet) {
        return Number(octet) > 255;
      })
    )
      throw new Error("عنوان الجهاز غير صالح");
  }

  var port =
    cfg.port === undefined || cfg.port === null || cfg.port === ""
      ? cfg.ssl
        ? 443
        : 80
      : Number(cfg.port);
  if (!isFinite(port) || Math.floor(port) !== port || port < 1 || port > 65535)
    throw new Error("منفذ الجهاز غير صالح");
  return { host: host, port: port };
}

function _ddcBuildAdapter(cfg) {
  var endpoint = _ddcValidateEndpoint(cfg);
  var base =
    (cfg.ssl ? "https" : "http") + "://" + endpoint.host + ":" + endpoint.port;
  var timeout = (cfg.timeout || 15) * 1000;

  // دالة مساعدة لإرسال HTTP
  function _fetch(path, method, body, extraHeaders) {
    var opts = {
      method: method || "GET",
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false,
      headers: Object.assign(
        { "Content-Type": "application/json", Accept: "application/json" },
        extraHeaders || {},
      ),
    };
    if (body) opts.payload = JSON.stringify(body);
    try {
      var resp = UrlFetchApp.fetch(base + path, opts);
      var code = resp.getResponseCode();
      var text = resp.getContentText("UTF-8");
      return {
        ok: code >= 200 && code < 300,
        code: code,
        text: text,
        json: _tryParseJSON(text),
      };
    } catch (e) {
      return { ok: false, code: 0, text: e.message, json: null };
    }
  }

  function _tryParseJSON(str) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  // ── محوّل ZKTeco (ADMS / WebAPI) ──
  if (cfg.brand === "zkteco") {
    // Buffer ليس متاحاً في Google Apps Script؛ استخدامه كان يرمي
    // ReferenceError قبل محاولة الاتصال. Utilities.base64Encode متاح دائماً.
    var zkAuth =
      "Basic " +
      Utilities.base64Encode(
        String(cfg.username || "") + ":" + String(cfg.password || ""),
      );
    var zkHeaders = { Authorization: zkAuth };

    return {
      test: function () {
        var r = _fetch("/iclock/data/CPTIME", "GET", null, zkHeaders);
        if (r.ok)
          return {
            success: true,
            device_info: {
              model: "ZKTeco",
              firmware: r.text.split("\n")[0] || "—",
            },
          };
        // محاولة ثانية — endpoint بديل
        var r2 = _fetch("/", "GET", null, zkHeaders);
        if (r2.ok)
          return {
            success: true,
            device_info: { model: "ZKTeco", firmware: "—" },
          };
        return {
          success: false,
          message: "فشل الاتصال (كود: " + r.code + "). تحقق من IP وكلمة المرور",
        };
      },
      getAttendance: function (from, to) {
        // ZKTeco ADMS: /iclock/data/ATTLOG  أو  /att/api/attrecords
        var r = _fetch(
          "/iclock/data/ATTLOG?from=" +
            encodeURIComponent(String(from || "") + " 00:00:00") +
            "&to=" +
            encodeURIComponent(String(to || "") + " 23:59:59"),
          "GET",
          null,
          zkHeaders,
        );
        if (!r.ok)
          return {
            success: false,
            message: "فشل جلب السجلات (كود: " + r.code + ")",
          };
        // ATTLOG format: "EmpID\tDate Time\tStatus\tVerify\tWorkCode\n"
        var lines = (r.text || "").split("\n").filter(function (l) {
          return l.trim();
        });
        var raw = lines.map(function (line) {
          var parts = line.split("\t");
          return {
            badge_number: parts[0],
            datetime: parts[1],
            status: parts[2],
            verify: parts[3],
          };
        });
        return { success: true, raw_records: raw };
      },
      getEmployees: function () {
        var r = _fetch("/iclock/data/USERINFO", "GET", null, zkHeaders);
        if (!r.ok) return { success: false, message: "فشل جلب الموظفين" };
        var lines = (r.text || "").split("\n").filter(function (l) {
          return l.trim();
        });
        var employees = lines.map(function (line) {
          var parts = line.split("\t");
          return {
            badge_number: parts[0],
            name: parts[1],
            department: parts[2] || "",
          };
        });
        return { success: true, employees: employees };
      },
    };
  }

  // ── محوّل Hikvision (ISAPI) ──
  if (cfg.brand === "hikvision") {
    var hikAuth =
      "Basic " +
      Utilities.base64Encode(
        (cfg.username || "admin") + ":" + (cfg.password || "admin"),
      );
    var hikHeaders = { Authorization: hikAuth };

    return {
      test: function () {
        var r = _fetch("/ISAPI/System/deviceInfo", "GET", null, hikHeaders);
        if (r.ok && r.json) {
          var info = r.json.DeviceInfo || {};
          return {
            success: true,
            device_info: {
              model: info.model || "Hikvision",
              firmware: info.firmwareVersion || "—",
            },
          };
        }
        return {
          success: false,
          message: "فشل الاتصال (كود: " + r.code + "). تحقق من IP وكلمة المرور",
        };
      },
      getAttendance: function (from, to) {
        var body = {
          AcsEventCond: {
            searchID: "1",
            searchResultPosition: 0,
            maxResults: 5000,
            major: 5,
            minor: 75,
            startTime: from + "T00:00:00+03:00",
            endTime: to + "T23:59:59+03:00",
          },
        };
        var r = _fetch(
          "/ISAPI/ACS/access/accessCardSwipeRecord/search",
          "POST",
          body,
          hikHeaders,
        );
        if (!r.ok || !r.json)
          return { success: false, message: "فشل جلب السجلات Hikvision" };
        var events = r.json.AcsEventInfo || [];
        var raw = events.map(function (ev) {
          return {
            badge_number: String(ev.cardNo || ev.employeeNoString || ""),
            employee_name: ev.name || "",
            datetime: ev.time || "",
            direction: ev.type === 0 ? "IN" : "OUT",
          };
        });
        return { success: true, raw_records: raw };
      },
      getEmployees: function () {
        var r = _fetch(
          "/ISAPI/AccessControl/UserInfo/Search",
          "POST",
          {
            UserInfoSearchCond: {
              searchID: "1",
              searchResultPosition: 0,
              maxResults: 1000,
            },
          },
          hikHeaders,
        );
        if (!r.ok || !r.json)
          return { success: false, message: "فشل جلب الموظفين" };
        var users = r.json.UserInfo || [];
        return {
          success: true,
          employees: users.map(function (u) {
            return {
              badge_number: u.employeeNo || "",
              name: u.name || "",
              department: u.departmentNo || "",
            };
          }),
        };
      },
    };
  }

  // ── محوّل Suprema BioStar 2 ──
  if (cfg.brand === "suprema") {
    var bsHeaders = {
      "bs-session-id": cfg.api_key || "",
      "Content-Type": "application/json",
    };
    // إذا لم يوجد api_key، نحاول تسجيل الدخول أولاً
    function _bsLogin() {
      var r = _fetch("/api/v1.0/login", "POST", {
        User: {
          login_id: cfg.username || "admin",
          password: cfg.password || "",
        },
      });
      if (r.ok && r.json && r.json.Response && r.json.Response.session_id) {
        bsHeaders["bs-session-id"] = r.json.Response.session_id;
        return true;
      }
      return false;
    }

    return {
      test: function () {
        if (!cfg.api_key) _bsLogin();
        var r = _fetch("/api/v1.0/status", "GET", null, bsHeaders);
        if (r.ok)
          return {
            success: true,
            device_info: { model: "Suprema BioStar 2", firmware: "—" },
          };
        return {
          success: false,
          message: "فشل الاتصال BioStar 2 (كود: " + r.code + ")",
        };
      },
      getAttendance: function (from, to) {
        if (!cfg.api_key) _bsLogin();
        var r = _fetch(
          "/api/v1.0/events/search",
          "POST",
          {
            Query: {
              limit: 5000,
              event_type_id: [0x1000, 0x2000],
              from: from + "T00:00:00+03:00",
              to: to + "T23:59:59+03:00",
            },
          },
          bsHeaders,
        );
        if (!r.ok || !r.json)
          return { success: false, message: "فشل جلب السجلات Suprema" };
        var evts =
          (r.json.EventCollection && r.json.EventCollection.rows) || [];
        var raw = evts.map(function (ev) {
          return {
            badge_number: String(ev.user_id || ""),
            employee_name: ev.user_name || "",
            datetime: ev.datetime || "",
            direction: ev.event_type_id === 0x1000 ? "IN" : "OUT",
          };
        });
        return { success: true, raw_records: raw };
      },
      getEmployees: function () {
        if (!cfg.api_key) _bsLogin();
        var r = _fetch("/api/v1.0/users", "GET", null, bsHeaders);
        if (!r.ok || !r.json)
          return { success: false, message: "فشل جلب الموظفين" };
        var users = (r.json.UserCollection && r.json.UserCollection.rows) || [];
        return {
          success: true,
          employees: users.map(function (u) {
            return {
              badge_number: u.user_id || "",
              name: u.name || "",
              department: u.department || "",
            };
          }),
        };
      },
    };
  }

  // ── محوّل Dahua ──
  if (cfg.brand === "dahua") {
    var daHeaders = {
      Authorization:
        "Basic " +
        Utilities.base64Encode(
          (cfg.username || "admin") + ":" + (cfg.password || "admin"),
        ),
    };
    return {
      test: function () {
        var r = _fetch(
          "/cgi-bin/magicBox.cgi?action=getSystemInfo",
          "GET",
          null,
          daHeaders,
        );
        if (r.ok)
          return {
            success: true,
            device_info: { model: "Dahua", firmware: "—" },
          };
        return {
          success: false,
          message: "فشل الاتصال Dahua (كود: " + r.code + ")",
        };
      },
      getAttendance: function (from, to) {
        var r = _fetch(
          "/cgi-bin/recordUpdater.cgi?action=find&name=AccessControlCarLot" +
            "&startTime=" +
            from +
            "+00:00:00&endTime=" +
            to +
            "+23:59:59&count=5000",
          "GET",
          null,
          daHeaders,
        );
        if (!r.ok) return { success: false, message: "فشل جلب السجلات Dahua" };
        // Dahua format: key=value lines
        var raw = [];
        var entries = (r.text || "").split("items[");
        entries.forEach(function (entry) {
          var badge = (entry.match(/CardNumber=([^\r\n]+)/) || [])[1] || "";
          var dt = (entry.match(/Time=([^\r\n]+)/) || [])[1] || "";
          var type = (entry.match(/Direction=([^\r\n]+)/) || [])[1] || "";
          if (badge && dt)
            raw.push({
              badge_number: badge.trim(),
              datetime: dt.trim(),
              direction: type.trim(),
            });
        });
        return { success: true, raw_records: raw };
      },
      getEmployees: function () {
        var r = _fetch(
          "/cgi-bin/AccessUser.cgi?action=list&count=1000",
          "GET",
          null,
          daHeaders,
        );
        if (!r.ok) return { success: false, message: "فشل جلب الموظفين Dahua" };
        var employees = [];
        (r.text || "").split("\n").forEach(function (line) {
          var badge = (line.match(/CardNumber=([^\r\n]+)/) || [])[1];
          var name = (line.match(/Name=([^\r\n]+)/) || [])[1];
          if (badge)
            employees.push({
              badge_number: badge.trim(),
              name: (name || "").trim(),
            });
        });
        return { success: true, employees: employees };
      },
    };
  }

  // ── محوّل Generic HTTP API ──
  var genAuth = cfg.api_key
    ? { Authorization: "Bearer " + cfg.api_key }
    : {
        Authorization:
          "Basic " +
          Utilities.base64Encode(
            (cfg.username || "") + ":" + (cfg.password || ""),
          ),
      };
  var apiBase = cfg.endpoint || "/api/";

  return {
    test: function () {
      var r = _fetch(apiBase + "status", "GET", null, genAuth);
      if (r.ok)
        return {
          success: true,
          device_info: { model: "Generic HTTP", firmware: "—" },
        };
      var r2 = _fetch(apiBase, "GET", null, genAuth);
      if (r2.ok)
        return {
          success: true,
          device_info: { model: "Generic HTTP", firmware: "—" },
        };
      return { success: false, message: "فشل الاتصال (كود: " + r.code + ")" };
    },
    getAttendance: function (from, to) {
      var r = _fetch(
        apiBase + "attendance?from=" + from + "&to=" + to,
        "GET",
        null,
        genAuth,
      );
      if (!r.ok || !r.json)
        return {
          success: false,
          message: "فشل جلب السجلات (كود: " + r.code + ")",
        };
      var data = Array.isArray(r.json)
        ? r.json
        : r.json.data || r.json.records || r.json.results || [];
      return { success: true, raw_records: data };
    },
    getEmployees: function () {
      var r = _fetch(apiBase + "employees", "GET", null, genAuth);
      if (!r.ok || !r.json)
        return { success: false, message: "فشل جلب الموظفين" };
      var data = Array.isArray(r.json)
        ? r.json
        : r.json.data || r.json.results || [];
      return { success: true, employees: data };
    },
  };
}
// ──────────────────────────────────────────────────────────────────────
// _ddcParseAttendance — تحويل سجلات الجهاز لصيغة النظام
// ──────────────────────────────────────────────────────────────────────
function _ddcParseAttendance(rawRecords, brand, empByBadge, empByNum, auth) {
  var grouped = {}; // { empId_date: { in: time, out: time } }

  rawRecords.forEach(function (rec) {
    // استخراج badge_number / datetime / direction
    var badge = String(
      rec.badge_number || rec.card_no || rec.user_id || "",
    ).trim();
    var dtStr = String(rec.datetime || rec.time || rec.date_time || "").trim();
    var direction = String(
      rec.direction || rec.status || rec.type || "",
    ).toUpperCase();

    if (!badge || !dtStr) return;

    // تحليل datetime
    var dt = new Date(
      dtStr
        .replace(/(\d{4})-(\d{2})-(\d{2}) /, "$1-$2-$3T")
        .replace(/\+\d{2}:\d{2}$/, ""),
    );
    if (isNaN(dt.getTime())) return;

    var dateStr = Utilities.formatDate(
      dt,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    var timeStr = Utilities.formatDate(
      dt,
      Session.getScriptTimeZone(),
      "HH:mm",
    );

    // ربط الموظف
    var emp = empByBadge[badge] || empByNum[badge];
    if (!emp) return; // موظف غير موجود في النظام

    var key = emp.id + "_" + dateStr;
    if (!grouped[key]) {
      grouped[key] = {
        employee_id: emp.id,
        employee_number: emp.employee_number || "",
        badge_number: badge,
        date: dateStr,
        check_in: "",
        check_out: "",
        work_hours: 0,
        times: [],
      };
    }
    grouped[key].times.push(timeStr);
  });

  // تحديد check_in = أول وقت ، check_out = آخر وقت
  var records = [];
  Object.keys(grouped).forEach(function (key) {
    var r = grouped[key];
    r.times.sort();
    r.check_in = r.times[0] || "";
    r.check_out = r.times.length > 1 ? r.times[r.times.length - 1] : "";

    if (r.check_in && r.check_out) {
      var inMin = _timeToMin(r.check_in);
      var outMin = _timeToMin(r.check_out);
      var diff = outMin - inMin;
      if (diff < 0) diff += 24 * 60;
      r.work_hours = Math.round((diff / 60) * 100) / 100;
    }

    delete r.times;
    r.movement_type = "PUNCH";
    r.device_name = brand || "device";
    r.source = "direct_connect";
    records.push(r);
  });

  return records;
}
function _timeToMin(t) {
  var p = String(t || "").split(":");
  return parseInt(p[0] || 0) * 60 + parseInt(p[1] || 0);
}
