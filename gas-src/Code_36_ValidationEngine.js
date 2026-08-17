// ══════════════════════════════════════════════════════════════════════════
// MODULE: Code_36_ValidationEngine.gs — ValidationEngine (v2)
// ──────────────────────────────────────────────────────────────────────────
// PURPOSE
//   Single, centralized source of truth for field-level validation on the
//   server (.gs) side. Any CRUD function in any module must call into
//   ValidationEngine instead of writing its own regex or ad-hoc condition.
//
// RESPONSIBILITIES
//   - Provide pure, stateless validators for text, contact info, dates,
//     numbers, enums, Egypt-specific identity/tax formats, passwords, files,
//     and duplicate/uniqueness/foreign-key checks.
//   - Provide a generic rule runner (runField/runFields) that maps a
//     declarative "rule" object to a validation result with a message code.
//   - Provide a thin, delegating façade (`business`) over BusinessRulesEngine
//     so callers only need to know one validation namespace.
//
// RELATED FILES
//   - VF_JS_Validation.html — client-side mirror of the same rule types, so
//     server and client agree on validation semantics and message codes.
//   - Code_33_BusinessRulesEngine.js — owns all business-level validation
//     (balances, credit limits, fiscal period state, etc.).
//
// DEPENDS ON
//   - BusinessRulesEngine (Code_33), accessed only through the `business`
//     façade below (no direct duplication of its logic here).
//
// USED BY
//   - CRUD/save handlers across modules (Inventory, HR, Accounting, BP, ...)
//     via ValidationEngine.runField / runFields, or individual validators
//     directly for one-off checks.
//
// ARCHITECTURAL NOTES
//   1. Every function here is a pure function — it returns true/false or a
//      plain result object, with no I/O and no ready-to-display messages.
//      The caller (or VF on the client) owns message rendering. The only
//      exceptions are `runField()` and `runFields()`, which return message
//      *codes* by design (see §10 below).
//   2. Business validation (balances, credit limits, grace periods, fiscal
//      year state, etc.) is never reimplemented here — it is delegated to
//      BusinessRulesEngine (Code_33) through `ValidationEngine.business`,
//      keeping exactly one implementation per business rule.
//   3. Adding a new validation type means: add a function here, register it
//      in TYPE_VALIDATORS, and mirror the same type in VF (client-side) if a
//      client copy is needed.
// ══════════════════════════════════════════════════════════════════════════

var ValidationEngine = (function () {
  "use strict";

  // ── Regex constants ────────────────────────────────────────────────────
  var EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var EG_PHONE_RX = /^01[0125][0-9]{8}$/; // Egyptian mobile number, 11 digits
  var EG_TEL_RX = /^0[2-9][0-9]{6,8}$/; // Egyptian landline, with area code
  var GENERIC_PHONE_RX = /^[\d\s\-\+\(\)]{7,20}$/;
  var URL_RX = /^https?:\/\/\S+$/i;
  var NUMBERS_ONLY_RX = /^[0-9]+$/;
  var LETTERS_ONLY_RX = /^[A-Za-z\s]+$/;
  var ARABIC_ONLY_RX = /^[\u0600-\u06FF\s]+$/;
  var ENGLISH_ONLY_RX = /^[A-Za-z0-9\s.,'\-]+$/;
  var DECIMAL_RX = /^-?\d+(\.\d+)?$/;
  var EG_NATIONAL_ID_RX = /^[23][0-9]{13}$/; // 14 digits, starts with 2 or 3
  var EG_TAX_NUMBER_RX = /^[0-9]{9}$/; // Egyptian tax registration number: 9 digits
  var EG_COMMERCIAL_REG_RX = /^[0-9]{2,10}$/; // Commercial register: digits only, reasonable length

  // ── Internal helpers ────────────────────────────────────────────────────

  // Normalizes any input to a trimmed string; null/undefined become "".
  function _s(v) {
    return v === null || v === undefined ? "" : String(v).trim();
  }

  // Treats null/undefined, empty arrays, and blank/whitespace strings as empty.
  function _isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    return _s(v) === "";
  }

  // ══════════════════════════════════════════════════════════════════════
  // §1 — Basic / Text validators
  // ══════════════════════════════════════════════════════════════════════
  function isRequired(value) {
    return !_isEmpty(value);
  }

  function minLength(value, min) {
    return _s(value).length >= min;
  }

  function maxLength(value, max) {
    return _s(value).length <= max;
  }

  function exactLength(value, len) {
    return _s(value).length === len;
  }

  function isNumbersOnly(value) {
    return NUMBERS_ONLY_RX.test(_s(value));
  }

  function isLettersOnly(value) {
    return LETTERS_ONLY_RX.test(_s(value));
  }

  function isArabicOnly(value) {
    return ARABIC_ONLY_RX.test(_s(value));
  }

  function isEnglishOnly(value) {
    return ENGLISH_ONLY_RX.test(_s(value));
  }

  // ══════════════════════════════════════════════════════════════════════
  // §2 — Contact / format validators
  // ══════════════════════════════════════════════════════════════════════
  function isValidEmail(value) {
    return EMAIL_RX.test(_s(value));
  }

  function isValidEgyptPhone(value) {
    return EG_PHONE_RX.test(_s(value));
  }

  function isValidEgyptTelephone(value) {
    return EG_TEL_RX.test(_s(value).replace(/[\s\-]/g, ""));
  }

  function isValidPhoneGeneric(value) {
    return GENERIC_PHONE_RX.test(_s(value));
  }

  function isValidUrl(value) {
    return URL_RX.test(_s(value));
  }

  // ══════════════════════════════════════════════════════════════════════
  // §3 — Date / Time validators
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Validates a date-like value.
   * @param {*} value - Date string, Date object, or empty value.
   * @param {{required?: boolean}} [opts] - opts.required: if true, an empty
   *   value is rejected. Default: empty is accepted.
   * @returns {boolean}
   */
  function isValidDateStr(value, opts) {
    opts = opts || {};
    if (_isEmpty(value)) return !opts.required;
    var d = new Date(value);
    return !isNaN(d.getTime());
  }

  /**
   * Validates a time string in HH:MM or HH:MM:SS (24h) format.
   * @param {{required?: boolean}} [opts] - see isValidDateStr.
   */
  function isValidTimeStr(value, opts) {
    opts = opts || {};
    if (_isEmpty(value)) return !opts.required;
    return /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/.test(_s(value));
  }

  /**
   * Validates that fromDate <= toDate. Either side may be a string or Date.
   * An empty fromDate or toDate is treated as a valid (open-ended) range.
   */
  function isValidDateRange(fromDate, toDate) {
    if (_isEmpty(fromDate) || _isEmpty(toDate)) return true;
    var f = new Date(fromDate),
      t = new Date(toDate);
    if (isNaN(f.getTime()) || isNaN(t.getTime())) return false;
    return f.getTime() <= t.getTime();
  }

  // ══════════════════════════════════════════════════════════════════════
  // §4 — Number validators
  // ══════════════════════════════════════════════════════════════════════
  function isValidNumber(value) {
    var v = _s(value);
    return v !== "" && !isNaN(+v);
  }

  function isDecimal(value) {
    return DECIMAL_RX.test(_s(value));
  }

  function isPositive(value) {
    return isValidNumber(value) && +value > 0;
  }

  function isNegative(value) {
    return isValidNumber(value) && +value < 0;
  }

  function isNumberInRange(value, min, max) {
    if (!isValidNumber(value)) return false;
    var n = +value;
    if (min !== undefined && n < min) return false;
    if (max !== undefined && n > max) return false;
    return true;
  }

  /**
   * Validates a monetary amount: a valid number, non-negative by default,
   * with at most `opts.decimals` decimal places (default 2).
   * @param {{allowNegative?: boolean, decimals?: number}} [opts]
   */
  function isValidCurrency(value, opts) {
    opts = opts || {};
    if (!isValidNumber(value)) return false;
    var n = +value;
    if (!opts.allowNegative && n < 0) return false;
    var decimals = opts.decimals !== undefined ? opts.decimals : 2;
    var re = new RegExp("^-?\\d+(\\.\\d{1," + decimals + "})?$");
    return re.test(_s(value));
  }

  /**
   * Validates a percentage value within [opts.min, opts.max] (default 0-100).
   */
  function isValidPercentage(value, opts) {
    opts = opts || {};
    if (!isValidNumber(value)) return false;
    var n = +value;
    var min = opts.min !== undefined ? opts.min : 0;
    var max = opts.max !== undefined ? opts.max : 100;
    return n >= min && n <= max;
  }

  // ══════════════════════════════════════════════════════════════════════
  // §5 — Enum / Selection validators
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Checks value against an allow-list. Comparison is case-insensitive;
   * allowedList entries are expected in upper case.
   * @param {{required?: boolean}} [opts]
   */
  function isValidEnum(value, allowedList, opts) {
    opts = opts || {};
    if (_isEmpty(value)) return !opts.required;
    return allowedList.indexOf(_s(value).toUpperCase()) !== -1;
  }

  // Rejects both "empty" and the placeholder value "0" used by unselected
  // dropdowns across the UI.
  function isRequiredSelection(value) {
    return !_isEmpty(value) && value !== "0";
  }

  /**
   * Validates a multi-select array against optional required/min/max bounds.
   */
  function isValidMultiSelect(values, opts) {
    opts = opts || {};
    var arr = Array.isArray(values) ? values : [];
    if (opts.required && arr.length === 0) return false;
    if (opts.min !== undefined && arr.length < opts.min) return false;
    if (opts.max !== undefined && arr.length > opts.max) return false;
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════
  // §6 — Egypt-specific identity / tax validators
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Validates an Egyptian National ID: format (14 digits, starts with 2/3)
   * plus a real-date check on the birth date encoded in digits 2-7
   * (century flag, year, month, day).
   */
  function isValidNationalId(value) {
    var v = _s(value);
    if (!EG_NATIONAL_ID_RX.test(v)) return false;
    var century = v.charAt(0) === "2" ? 1900 : 2000;
    var year = century + parseInt(v.substr(1, 2), 10);
    var month = parseInt(v.substr(3, 2), 10);
    var day = parseInt(v.substr(5, 2), 10);
    if (month < 1 || month > 12) return false;
    var d = new Date(year, month - 1, day);
    return d.getMonth() === month - 1 && d.getDate() === day;
  }

  function isValidTaxNumber(value) {
    return EG_TAX_NUMBER_RX.test(_s(value).replace(/[\s\-]/g, ""));
  }

  function isValidCommercialRegistration(value) {
    return EG_COMMERCIAL_REG_RX.test(_s(value).replace(/[\s\-]/g, ""));
  }

  // Accepts EAN-8, EAN-12/13, UPC-A, or an internal alphanumeric code
  // (4-30 characters).
  function isValidBarcode(value) {
    var v = _s(value);
    return /^[0-9]{8}$|^[0-9]{12,13}$|^[A-Za-z0-9\-_]{4,30}$/.test(v);
  }

  function isValidQR(value) {
    var v = _s(value);
    return v.length >= 4 && v.length <= 2000;
  }

  // ══════════════════════════════════════════════════════════════════════
  // §7 — Password validators
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Checks a password against a policy object. If no policy is supplied, a
   * reasonable default is used. When the system defines PASSWORD_POLICY
   * centrally (Code_12_Core.gs), callers should pass it explicitly.
   * @returns {{valid: boolean, errors: string[]}} errors are policy-violation
   *   codes (e.g. "REQUIRE_UPPER"), not display messages.
   */
  function passwordStrength(password, policy) {
    policy = policy || {
      MIN_LENGTH: 8,
      REQUIRE_NUMBER: true,
      REQUIRE_UPPER: true,
      REQUIRE_LOWER: true,
      REQUIRE_SPECIAL: true,
    };
    var pw = password || "";
    var errors = [];
    if (pw.length < policy.MIN_LENGTH)
      errors.push("MIN_LENGTH:" + policy.MIN_LENGTH);
    if (policy.REQUIRE_NUMBER && !/\d/.test(pw)) errors.push("REQUIRE_NUMBER");
    if (policy.REQUIRE_UPPER && !/[A-Z]/.test(pw)) errors.push("REQUIRE_UPPER");
    if (policy.REQUIRE_LOWER && !/[a-z]/.test(pw)) errors.push("REQUIRE_LOWER");
    if (
      policy.REQUIRE_SPECIAL &&
      !/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(pw)
    )
      errors.push("REQUIRE_SPECIAL");
    return { valid: errors.length === 0, errors: errors };
  }

  function passwordsMatch(password, confirmPassword) {
    return _s(password) !== "" && password === confirmPassword;
  }

  // ══════════════════════════════════════════════════════════════════════
  // §8 — File / Attachment validators
  // ══════════════════════════════════════════════════════════════════════
  // Expected file shape: { name, size (bytes), mimeType } — the normalized
  // shape produced by FileEngine.

  function isValidFileSize(fileSizeBytes, maxSizeMB) {
    if (!fileSizeBytes || isNaN(fileSizeBytes)) return false;
    return fileSizeBytes <= maxSizeMB * 1024 * 1024;
  }

  function isValidFileExtension(fileName, allowedExtensions) {
    var name = _s(fileName).toLowerCase();
    var ext = name.substring(name.lastIndexOf(".") + 1);
    return (
      allowedExtensions
        .map(function (e) {
          return String(e).toLowerCase().replace(/^\./, "");
        })
        .indexOf(ext) !== -1
    );
  }

  function isValidImageFile(fileName, mimeType) {
    var okExt = isValidFileExtension(fileName, [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "bmp",
    ]);
    var okMime = !mimeType || /^image\//i.test(mimeType);
    return okExt && okMime;
  }

  function isRequiredAttachment(files) {
    return Array.isArray(files) ? files.length > 0 : !_isEmpty(files);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §9 — Duplicate / Uniqueness / Foreign-Key validators
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Checks whether `value` already exists under `field` among `records`.
   * @param {Array<Object>} records - Existing records (from Sheet or cache).
   * @param {string} field - Field name being checked for uniqueness.
   * @param {*} value - Candidate value.
   * @param {{idField?: string, excludeId?: *}} [opts] - excludeId/idField let
   *   the current record be ignored during an Update (as opposed to an
   *   Insert), so a record doesn't collide with itself.
   * @returns {boolean} true if a conflicting record exists.
   *
   * Note: excludeId only takes effect when it is a real, non-empty value.
   * A falsy-but-defined excludeId (e.g. "" sent deliberately for "new
   * record, no id yet") must NOT exclude any row — otherwise a legitimate
   * duplicate against a record with a blank id column (e.g. manually
   * entered sheet data) would be missed.
   */
  function isDuplicate(records, field, value, opts) {
    opts = opts || {};
    var idField = opts.idField || "id";
    var excludeId = opts.excludeId;
    var hasExcludeId = excludeId !== undefined && excludeId !== null && String(excludeId) !== "";
    var normalizedValue = _s(value).toLowerCase();
    if (normalizedValue === "") return false;
    return (records || []).some(function (r) {
      if (hasExcludeId && String(r[idField]) === String(excludeId))
        return false;
      return _s(r[field]).toLowerCase() === normalizedValue;
    });
  }

  function isUniqueCode(records, codeField, value, opts) {
    return !isDuplicate(records, codeField, value, opts);
  }

  // Checks that a value exists as a record id (e.g. partyId exists in the
  // customers table).
  function recordExists(records, idField, value) {
    if (_isEmpty(value)) return false;
    return (records || []).some(function (r) {
      return String(r[idField]) === String(value);
    });
  }

  // Same as recordExists, but treats an empty value as valid (optional
  // relationship) unless opts.required is set.
  function isValidForeignKey(records, idField, value, opts) {
    opts = opts || {};
    if (_isEmpty(value)) return !opts.required;
    return recordExists(records, idField, value);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §10 — Generic rule runner
  // ══════════════════════════════════════════════════════════════════════
  // Mirrors VF.validate on the client, so any server function can run the
  // same declarative "rule" object sent from a form instead of hand-coding
  // per-field checks.
  //
  // Supported rule.type values: numbersOnly, lettersOnly, arabicOnly,
  // englishOnly, email, egyptPhone, egyptTelephone, phone, url, decimal,
  // positive, negative, nationalId, taxNumber, commercialRegistration,
  // barcode, qr, currency, percentage, date, time.
  // Additional rule keys: rule.enum (allow-list), rule.min/max (numbers),
  // rule.minLength/maxLength/exactLength (text).

  /**
   * Validates a single value against a rule object.
   * @param {*} value
   * @param {Object} rule
   * @returns {{valid: boolean, code: string}} code is a VF_MSG_* key —
   *   translated to a display message by the calling layer, using the same
   *   keys as VF_MSG_* on the client so server and client never diverge on
   *   wording for the same error.
   */
  function runField(value, rule) {
    rule = rule || {};
    if (rule.required && _isEmpty(value))
      return { valid: false, code: "VF_MSG_REQUIRED" };
    if (_isEmpty(value) && !rule.required) return { valid: true, code: "OK" };

    if (rule.minLength !== undefined && !minLength(value, rule.minLength))
      return { valid: false, code: "VF_MSG_MIN_LENGTH" };
    if (rule.maxLength !== undefined && !maxLength(value, rule.maxLength))
      return { valid: false, code: "VF_MSG_MAX_LENGTH" };
    if (
      rule.exactLength !== undefined &&
      !exactLength(value, rule.exactLength)
    )
      return { valid: false, code: "VF_MSG_EXACT_LENGTH" };

    if (rule.min !== undefined || rule.max !== undefined) {
      if (!isNumberInRange(value, rule.min, rule.max))
        return { valid: false, code: "VF_MSG_OUT_OF_RANGE" };
    }

    if (rule.type && TYPE_VALIDATORS[rule.type]) {
      if (!TYPE_VALIDATORS[rule.type](value))
        return {
          valid: false,
          code: "VF_MSG_INVALID_" + rule.type.toUpperCase(),
        };
    }

    if (rule.type === "currency" && !isValidCurrency(value, rule))
      return { valid: false, code: "VF_MSG_INVALID_CURRENCY" };
    if (rule.type === "percentage" && !isValidPercentage(value, rule))
      return { valid: false, code: "VF_MSG_INVALID_PERCENTAGE" };
    if (rule.type === "date" && !isValidDateStr(value, rule))
      return { valid: false, code: "VF_MSG_INVALID_DATE" };
    if (rule.type === "time" && !isValidTimeStr(value, rule))
      return { valid: false, code: "VF_MSG_INVALID_TIME" };
    if (rule.enum && !isValidEnum(value, rule.enum, rule))
      return { valid: false, code: "VF_MSG_INVALID_SELECTION" };

    return { valid: true, code: "OK" };
  }

  /**
   * Validates a map of fields, each shaped as { value, rule }.
   * @param {Object<string, {value:*, rule:Object}>} fields
   * @returns {{valid: boolean, errors: Object<string,string>, firstErrorField: ?string}}
   */
  function runFields(fields) {
    var errors = {};
    var firstErrorField = null;
    Object.keys(fields || {}).forEach(function (name) {
      var f = fields[name];
      var res = runField(f.value, f.rule);
      if (!res.valid) {
        errors[name] = res.code;
        if (!firstErrorField) firstErrorField = name;
      }
    });
    return {
      valid: Object.keys(errors).length === 0,
      errors: errors,
      firstErrorField: firstErrorField,
    };
  }

  // Registry mapping rule.type strings to their validator functions, used
  // by runField(). Adding a new type requires adding it both here and to
  // the public API below.
  var TYPE_VALIDATORS = {
    numbersOnly: isNumbersOnly,
    lettersOnly: isLettersOnly,
    arabicOnly: isArabicOnly,
    englishOnly: isEnglishOnly,
    email: isValidEmail,
    egyptPhone: isValidEgyptPhone,
    egyptTelephone: isValidEgyptTelephone,
    phone: isValidPhoneGeneric,
    url: isValidUrl,
    decimal: isDecimal,
    positive: isPositive,
    negative: isNegative,
    nationalId: isValidNationalId,
    taxNumber: isValidTaxNumber,
    commercialRegistration: isValidCommercialRegistration,
    barcode: isValidBarcode,
    qr: isValidQR,
  };

  // ══════════════════════════════════════════════════════════════════════
  // §11 — Business Validation façade (delegates to BusinessRulesEngine)
  // ══════════════════════════════════════════════════════════════════════
  // No business logic is duplicated here — this is only a unified namespace
  // so callers can use ValidationEngine.business.* without needing to know
  // BusinessRulesEngine exists as a separate engine. If BusinessRulesEngine
  // is not loaded (e.g. accidentally excluded from a deployment), each
  // method returns an explicit failure instead of throwing an opaque
  // exception.
  //
  // Business rules covered via delegation: customer/supplier/cash/bank/
  // warehouse balances, credit limits, grace periods, account/branch/
  // fiscal-year/warehouse status, not issuing more stock than available,
  // not saving an unbalanced invoice, not deleting a record with active
  // references. The actual logic for all of these lives in
  // BusinessRulesEngine (Code_33); the names here are only a clearer,
  // unified interface.

  function _bre() {
    return typeof BusinessRulesEngine === "undefined" ? null : BusinessRulesEngine;
  }

  function _breMissing() {
    return {
      success: false,
      code: "BRE_MISSING",
      message: "محرك قواعد الأعمال غير محمّل",
    };
  }

  var business = {
    beforeSave: function (entityType, payload) {
      var bre = _bre();
      return bre ? bre.validateBeforeSave(entityType, payload) : _breMissing();
    },
    beforeDelete: function (entityType, payload) {
      var bre = _bre();
      return bre
        ? bre.validateBeforeDelete(entityType, payload)
        : _breMissing();
    },
    beforeApprove: function (entityType, payload) {
      var bre = _bre();
      return bre
        ? bre.validateBeforeApprove(entityType, payload)
        : _breMissing();
    },
    beforePost: function (entityType, payload) {
      var bre = _bre();
      return bre ? bre.validateBeforePost(entityType, payload) : _breMissing();
    },
    beforeInventoryIssue: function (payload) {
      var bre = _bre();
      return bre
        ? bre.validateBeforeInventoryIssue(payload)
        : _breMissing();
    },
    beforeJournalEntry: function (payload) {
      var bre = _bre();
      return bre ? bre.validateBeforeJournalEntry(payload) : _breMissing();
    },
    checkCreditLimit: function (customer, invoiceTotal) {
      var bre = _bre();
      return bre
        ? bre.checkCreditLimit(customer, invoiceTotal)
        : _breMissing();
    },
    checkMinSalePrice: function (item, sellPrice, username, sessionToken) {
      var bre = _bre();
      return bre
        ? bre.checkMinSalePrice(item, sellPrice, username, sessionToken)
        : _breMissing();
    },
  };

  // ══════════════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════════════
  return {
    // basic/text
    isRequired: isRequired,
    minLength: minLength,
    maxLength: maxLength,
    exactLength: exactLength,
    isNumbersOnly: isNumbersOnly,
    isLettersOnly: isLettersOnly,
    isArabicOnly: isArabicOnly,
    isEnglishOnly: isEnglishOnly,
    // contact/format
    isValidEmail: isValidEmail,
    isValidEgyptPhone: isValidEgyptPhone,
    isValidEgyptTelephone: isValidEgyptTelephone,
    isValidPhoneGeneric: isValidPhoneGeneric,
    isValidUrl: isValidUrl,
    // date/time
    isValidDateStr: isValidDateStr,
    isValidTimeStr: isValidTimeStr,
    isValidDateRange: isValidDateRange,
    // numbers
    isValidNumber: isValidNumber,
    isDecimal: isDecimal,
    isPositive: isPositive,
    isNegative: isNegative,
    isNumberInRange: isNumberInRange,
    isValidCurrency: isValidCurrency,
    isValidPercentage: isValidPercentage,
    // enum/selection
    isValidEnum: isValidEnum,
    isRequiredSelection: isRequiredSelection,
    isValidMultiSelect: isValidMultiSelect,
    // Egypt identity
    isValidNationalId: isValidNationalId,
    isValidTaxNumber: isValidTaxNumber,
    isValidCommercialRegistration: isValidCommercialRegistration,
    isValidBarcode: isValidBarcode,
    isValidQR: isValidQR,
    // password
    passwordStrength: passwordStrength,
    passwordsMatch: passwordsMatch,
    // file
    isValidFileSize: isValidFileSize,
    isValidFileExtension: isValidFileExtension,
    isValidImageFile: isValidImageFile,
    isRequiredAttachment: isRequiredAttachment,
    // duplicate/unique/FK
    isDuplicate: isDuplicate,
    isUniqueCode: isUniqueCode,
    recordExists: recordExists,
    isValidForeignKey: isValidForeignKey,
    // generic rule runner
    runField: runField,
    runFields: runFields,
    // business rules (delegated to BusinessRulesEngine)
    business: business,
  };
})();
