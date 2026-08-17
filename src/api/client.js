/**
 * ═══════════════════════════════════════════════════════════════
 * MOO.ERP — API Client (google.script.run Polyfill)
 *
 * يستبدل google.script.run بـ fetch() يتصل بـ Google Apps Script
 * عبر URL خارجي (Web App /exec) — يحافظ على نفس الـ API تمامًا
 * (withSuccessHandler / withFailureHandler / نداء مباشر) بدون
 * تعديل أي كود فرونت قديم.
 *
 * متوافق مع doPost() في Code_12_Core.js:
 *   - يبعت { fn, args } كـ JSON في body
 *   - Backend يرد { result: ... } عند النجاح أو { error: "..." } عند الفشل
 *   - أي دالة مش في DOPOST_ALLOWED_FUNCTIONS بترجع
 *     "Function not permitted: X" → بنحولها لـ Error عادي
 *   - أي دالة مش في DOPOST_PUBLIC_FUNCTIONS ومفيش sessionToken صالح
 * في الـ args بترجع " غير مصرح — يرجى تسجيل الدخول (session required)"
 *     → بنطلق حدث `moo:session-invalid` عشان الشاشة تقدر تعمل logout/redirect
 *     تلقائي، بالإضافة لرفض الـ promise عادي.
 *
 * الإعداد: ضع رابط النشر (Web App URL, ينتهي بـ /exec) في:
 *   1. window.GAS_URL قبل تحميل هذا الملف، أو
 *   2. localStorage['moo_gas_url']، أو
 *   3. window.GAS.setUrl('...') من شاشة إعداد الاتصال
 *
 * ملحوظة عن الجلسة: نفس مفتاح localStorage اللي بيستخدمه الفرونت
 * الحالي (02_JS_UI_Shell.html): "wms_session_token" — الجسر هنا
 * بيقرأه تلقائيًا ويحقنه في أول argument لو الدالة مش عامة ومفيش
 * توكن متبعت أصلاً ضمن args (توافق رجعي مع الكود القديم اللي كان
 * بيبعت التوكن يدويًا كـ argument زي ما هو).
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  var SESSION_TOKEN_KEY = 'wms_session_token';
  var GAS_URL_KEY = 'moo_gas_url';

  // ── قراءة GAS URL ─────────────────────────────────────────────
  // [CORS-FIX] Apps Script doPost() ما بيرجّعش Access-Control-Allow-Origin
  // في الرد أبدًا (قيد من جوجل، مش إعداد قابل للتغيير) — يعني أي fetch()
  // من دومين تاني (Vercel) لـ /exec هيترفض دايمًا بـ CORS بغض النظر عن
  // صحة الرابط. الحل: بنمرّ دايمًا عبر /api/gas (نفس الدومين، بروكسي
  // سيرفر-لسيرفر بيعمل الاتصال الحقيقي بـ Apps Script من غير قيد CORS).
  // شاشة إعداد GAS_URL القديمة (لو ظهرت) بقت بلا فايدة فعليًا؛ الرابط
  // الحقيقي دلوقتي بيتضبط كـ Environment Variable "GAS_URL" في Vercel
  // نفسه (يقرأه api/gas.js على السيرفر)، مش من المتصفح.
  var PROXY_PATH = '/api/gas';
  function _getGasUrl() {
    return PROXY_PATH;
  }

  function _getSessionToken() {
    try {
      return localStorage.getItem(SESSION_TOKEN_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  // بيدور جوه args لو فيه توكن جلسة متبعت بالفعل (نص أو داخل object)
  function _argsAlreadyHaveToken(args) {
    // ملحوظة إصلاح: كنا هنا بنعتبر أي نص عادي طوله >= 10 حرف "توكن جلسة
    // موجود بالفعل" ونتجاهل إلحاق التوكن الحقيقي — ده كان بيتفعّل غلط مع
    // أي باراميتر نصي عادي (زي اسم مجموعة/صنف بالعربي طوله أكتر من 10
    // حرف)، فيوصل الطلب للسيرفر من غير توكن حقيقي ويترفض بـ
    // "session required" حتى لو المستخدم مسجل دخول فعليًا وجلسته سليمة.
    // دلوقتي بنكتفي بفحص التوكن كخاصية داخل object فقط، ونسيب المطابقة
    // النصية للسيرفر نفسه (_doPostHasValidSession بيجرب كل args ويقبل
    // أي توكن صالح من بينها).
    for (var i = 0; i < args.length; i++) {
      var c = args[i];
      if (c && typeof c === 'object' && (c.sessionToken || c.token || c._token)) {
        return true;
      }
    }
    return false;
  }

  // الدوال العامة اللي معروف إننا مش محتاجين نلحق لها توكن أوتوماتيك
  // (بتتبعت من شاشة اللوجين نفسها قبل ما يبقى فيه جلسة أصلًا)
  var _NO_AUTO_TOKEN_FNS = [
    'login', 'adminLogin', 'ping', 'getCatalogPublicData',
    'logPublicCatalogWhatsapp', 'resolveLinkedCatalog',
    'requestPasswordReset', 'resetPasswordWithCode',
  ];

  // ── استدعاء Apps Script عبر fetch ─────────────────────────────
  function _callGAS(fnName, args) {
    var url = _getGasUrl();
    if (!url) {
      return Promise.reject(new Error(
        'GAS_URL غير مضبوطة. من فضلك اضبط رابط الـ Web App أولاً.'
      ));
    }

    args = args || [];

    // توافق رجعي: لو الدالة مش من ضمن اللي بتتبعت من غير توكن، ومفيش
    // توكن متبعت أصلاً ضمن args، نلحقه تلقائيًا كـ argument أخير —
    // نفس شكل الاستدعاء القديم اللي كان بيبعت sessionToken يدويًا.
    if (_NO_AUTO_TOKEN_FNS.indexOf(fnName) === -1 && !_argsAlreadyHaveToken(args)) {
      var tok = _getSessionToken();
      if (tok) args = args.concat([tok]);
    }

    var payload = JSON.stringify({ fn: fnName, args: args });

    return fetch(url, {
      method: 'POST',
      mode: 'cors',
      redirect: 'follow',
      // text/plain لتجنّب CORS preflight (نفس تعامل GAS مع body كنص خام)
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payload,
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('خطأ HTTP ' + res.status + ' عند استدعاء: ' + fnName);
        }
        return res.text();
      })
      .then(function (text) {
        if (text && text.trimStart().startsWith('<')) {
          throw new Error(
            'الخادم أعاد صفحة HTML بدل JSON — تأكد إن رابط الـ Web App صحيح' +
            ' وإن النشر (Deploy) مضبوط على "Anyone"'
          );
        }

        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error('استجابة غير صالحة من السيرفر: ' + text.substring(0, 150));
        }

        if (data && typeof data === 'object' && 'error' in data) {
          var msg = String(data.error || '');
          // نفس نص الرفض اللي بيطلعه doPost عند فشل بوابة الجلسة (SEC-FIX-4)
          if (msg.indexOf('session required') !== -1 || msg.indexOf('غير مصرح') !== -1) {
            try {
              window.dispatchEvent(new CustomEvent('moo:session-invalid', {
                detail: { fn: fnName },
              }));
            } catch (e) { /* older browsers: تجاهل */ }
          }
          throw new Error(msg);
        }

        if (data && typeof data === 'object' && 'result' in data) {
          return data.result;
        }
        return data;
      });
  }

  // ── Runner Builder (يقلد كائن google.script.run.Runner الحقيقي) ──
  function _makeRunner(fnName, args) {
    var _onSuccess = null;
    var _onFailure = null;
    var _scheduled = false;

    function _exec() {
      _callGAS(fnName, args)
        .then(function (result) {
          if (typeof _onSuccess === 'function') _onSuccess(result);
        })
        .catch(function (err) {
          var e = err instanceof Error ? err : new Error(String(err));
          if (typeof _onFailure === 'function') {
            _onFailure(e);
          } else {
            console.error('[GAS] ' + fnName + ':', e.message);
          }
        });
    }

    var runner = {
      withSuccessHandler: function (fn) { _onSuccess = fn; return runner; },
      withFailureHandler: function (fn) { _onFailure = fn; return runner; },
      withUserObject: function () { return runner; }, // no-op للتوافق
    };

    if (!_scheduled) {
      _scheduled = true;
      setTimeout(_exec, 0);
    }

    return runner;
  }

  function _makePartialRunner(successFn, failureFn) {
    var handler = {};
    var proxy; // مرجع للـ Proxy نفسه عشان نرجعه من withSuccessHandler/withFailureHandler
               // بدل ما نرجع الـ handler الخام (وده كان سبب الأعطال)

    function _addMethod(name) {
      handler[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        var runner = _makeRunner(name, args);
        if (successFn) runner.withSuccessHandler(successFn);
        if (failureFn) runner.withFailureHandler(failureFn);
        return runner;
      };
    }

    if (typeof Proxy !== 'undefined') {
      proxy = new Proxy(handler, {
        get: function (target, prop) {
          if (prop in target) return target[prop];
          if (prop === 'withSuccessHandler') {
            return function (fn) { successFn = fn; return proxy; };
          }
          if (prop === 'withFailureHandler') {
            return function (fn) { failureFn = fn; return proxy; };
          }
          _addMethod(prop);
          return target[prop];
        },
      });
      return proxy;
    }
    return handler;
  }

  // ── Proxy رئيسي لـ google.script.run ─────────────────────────
  var _runProxy;
  if (typeof Proxy !== 'undefined') {
    _runProxy = new Proxy({}, {
      get: function (target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (fn) { return _makePartialRunner(fn, null); };
        }
        if (prop === 'withFailureHandler') {
          return function (fn) { return _makePartialRunner(null, fn); };
        }
        return function () {
          return _makeRunner(prop, Array.prototype.slice.call(arguments));
        };
      },
    });
  } else {
    // fallback بدون Proxy — بيغطي أشهر الدوال يدويًا لو احتجنا مستقبلًا
    _runProxy = _makePartialRunner(null, null);
  }

  // ── تركيب الكائن العالمي (بديل تام لـ google.script.run) ──────
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = _runProxy;

  // ── أداة مساعدة عامة ────────────────────────────────────────
  window.GAS = {
    setUrl: function (url) {
      window.GAS_URL = url;
      try { localStorage.setItem(GAS_URL_KEY, url); } catch (e) {}
    },
    getUrl: _getGasUrl,
    ping: function () { return _callGAS('ping', []); },
    call: _callGAS,
    getSessionToken: _getSessionToken,
  };

  // [SEC] اتشال طباعة رابط الـ Web App (GAS_URL) في الـ console عمدًا —
  // كان بيظهر لأي حد يفتح Developer Tools، وده معلومة حساسة عن الباك إند
  // الحقيقي مفيش داعي إنها تكون ظاهرة. لو محتاج تتأكد من الرابط المضبوط
  // وقت التطوير، استخدم window.GAS.getUrl() يدويًا من الـ console.
})();