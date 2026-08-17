// ════════════════════════════════════════════════════════════════
// MODULE: Code_34_DataLayerEngine.gs — DataLayer / DataLayerEngine
// ────────────────────────────────────────────────────────────────
// PURPOSE
//   Single entry point for all read/write operations against Google
//   Sheets, so no screen or business-logic module needs to touch
//   SpreadsheetApp / Sheet / Range directly.
//
// RESPONSIBILITIES
//   - Expose a uniform CRUD + bulk API (get/find/search/insert/update/
//     delete/bulk*) with a single response shape (DL_Result).
//   - Resolve table headers from the existing sources of truth
//     (HEADERS / ACCOUNTING_HR_HEADERS).
//   - Apply soft-delete semantics (deleted_at) automatically where a
//     table supports it, with an explicit hard-delete override.
//   - Invalidate the shared server cache after any write.
//
// RELATED FILES
//   - DATA_LAYER_ENGINE_REPORT.md — full migration map and rationale.
//
// DESIGN PRINCIPLE
//   This file does not replace the existing infrastructure in
//   Code_12_Core.gs (getSheet / readSheet / _appendRowProtected /
//   HEADERS / okResponse / errResponse / makeId) — it builds on top of
//   it and reuses it, following "extend what exists rather than
//   replace it wholesale". Any future migration to a different backing
//   store (e.g. Supabase) only requires changing the private helpers
//   (prefixed "_dl") in this file — the public interface (DataLayer.*)
//   stays stable.
//
// OUT OF SCOPE (by design)
//   - No business logic (permissions, accounting calculations, or
//     module-specific validation rules).
//   - No UI code.
//
// DEPENDS ON
//   - Code_12_Core.gs: getSheet, readSheet, _appendRowProtected,
//     HEADERS, makeId.
//   - _invalidateServerCache (cache layer), _addAuditLog (audit layer)
//     — both called defensively (only if defined).
//
// USED BY
//   - Nearly every CRUD path across modules, directly via DataLayer.*
//     or DataLayerEngine.* (same object, see naming note at the bottom
//     of this file), and indirectly via RepositoryLayer (Code_38).
// ════════════════════════════════════════════════════════════════

// ── §DLE-1 Standard error codes ─────────────────────────────────────────
var DL_ERROR_CODES = {
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  DUPLICATE: "DUPLICATE",
  UNKNOWN_TABLE: "UNKNOWN_TABLE",
  INTERNAL: "INTERNAL",
};

// ── §DLE-2 Unified response contract (DL_Result) ─────────────────────────
// Shape: { success, data, errorCode, errorMessage, details }
// Same philosophy as okResponse/errResponse in Code_12_Core.gs, but with a
// stricter, always-present shape so every DataLayer call can be handled
// identically by callers regardless of which method produced it.
function DL_Result(success, data, errorCode, errorMessage, details) {
  var r = { success: !!success, data: data !== undefined ? data : null };
  if (!success) {
    r.errorCode = errorCode || DL_ERROR_CODES.INTERNAL;
    r.errorMessage = errorMessage || "خطأ غير متوقع في طبقة البيانات";
    if (details !== undefined) r.details = details;
  }
  return r;
}
function _dlOk(data) {
  return DL_Result(true, data);
}
function _dlErr(code, message, details) {
  return DL_Result(false, null, code, message, details);
}

// Variant of _dlErr that also sets .ok = false. Used by update()/remove()
// so their failure shape carries both `success` and `ok`, matching the
// success shape those same functions return (see the [UNIFIED RESULT SHAPE]
// notes below) — avoiding the inconsistency where insert()/bulkInsert()
// exposed only `.success` while update()/remove() exposed only `.ok`.
function _dlErrU(code, message, details) {
  var r = _dlErr(code, message, details);
  r.ok = false;
  return r;
}

// ── §DLE-3 Centralized error logging ─────────────────────────────────────
function _dlLog(op, table, e) {
  try {
    var msg =
      "[DataLayer] " +
      op +
      "(" +
      table +
      ") فشل: " +
      (e && e.message ? e.message : e);
    Logger.log(msg);
    // Reuse the existing central audit log if available, instead of
    // introducing a separate logging mechanism.
    if (typeof _addAuditLog === "function") {
      try {
        _addAuditLog("system", "DL_ERROR", table, "", "", msg);
      } catch (ignored) {}
    }
  } catch (ignored) {}
}

// ── §DLE-4 DataLayer — the unified public API ────────────────────────────
var DataLayer = (function () {
  // Resolves a table's header list from the existing sources of truth.
  function _headersFor(table, customHeaders) {
    return (
      customHeaders ||
      (typeof HEADERS !== "undefined" && HEADERS[table]) ||
      (typeof ACCOUNTING_HR_HEADERS !== "undefined" &&
        ACCOUNTING_HR_HEADERS[table]) ||
      null
    );
  }

  // Reads the full sheet for `table`. Rows retain `_row` (the underlying
  // sheet row index) so update()/remove() can target the correct range.
  function _rawRows(table, opts) {
    var headers = _headersFor(table, opts && opts.headers);
    if (!headers) {
      throw {
        code: DL_ERROR_CODES.UNKNOWN_TABLE,
        message: "جدول غير معروف في HEADERS: " + table,
      };
    }
    return { headers: headers, rows: readSheet(table, headers, opts) };
  }

  function _excludeDeleted(rows, includeDeleted) {
    if (includeDeleted) return rows;
    return rows.filter(function (r) {
      return !r.deleted_at;
    });
  }

  // filter may be a plain object (exact-match on every key) or a predicate
  // function.
  function _matchFilter(row, filter) {
    if (!filter) return true;
    if (typeof filter === "function") return !!filter(row);
    return Object.keys(filter).every(function (k) {
      return String(row[k]) === String(filter[k]);
    });
  }

  // ── Read: get / getAll ──────────────────────────────────────────────
  function getAll(table, opts) {
    opts = opts || {};
    try {
      var loaded = _rawRows(table, opts);
      var rows = _excludeDeleted(loaded.rows, opts.includeDeleted);
      if (opts.filter) {
        rows = rows.filter(function (r) {
          return _matchFilter(r, opts.filter);
        });
      }
      if (opts.sortBy) rows = sortRows(rows, opts.sortBy, opts.sortDir);
      var clean = cleanArr(rows);
      return _dlOk(
        opts.page ? paginate(clean, opts.page, opts.pageSize) : clean,
      );
    } catch (e) {
      _dlLog("getAll", table, e);
      return _dlErr(e.code, e.message || String(e));
    }
  }

  // ── Read: getById ────────────────────────────────────────────────────
  function getById(table, id, opts) {
    opts = opts || {};
    try {
      if (id === undefined || id === null || id === "")
        return _dlErr(DL_ERROR_CODES.VALIDATION, "المعرف (id) مطلوب");
      var loaded = _rawRows(table, opts);
      var row = loaded.rows.find(function (r) {
        return (
          String(r.id) === String(id) && (opts.includeDeleted || !r.deleted_at)
        );
      });
      if (!row)
        return _dlErr(DL_ERROR_CODES.NOT_FOUND, "السجل غير موجود: " + id);
      var out = Object.assign({}, row);
      delete out._row;
      return _dlOk(out);
    } catch (e) {
      _dlLog("getById", table, e);
      return _dlErr(e.code, e.message || String(e));
    }
  }

  // ── Read: getByCode ──────────────────────────────────────────────────
  function getByCode(table, code, opts) {
    opts = opts || {};
    var codeField = opts.codeField || "code";
    try {
      if (!code) return _dlErr(DL_ERROR_CODES.VALIDATION, "الكود مطلوب");
      var loaded = _rawRows(table, opts);
      var row = loaded.rows.find(function (r) {
        return (
          String(r[codeField] || "").toLowerCase() ===
            String(code).toLowerCase() &&
          (opts.includeDeleted || !r.deleted_at)
        );
      });
      if (!row)
        return _dlErr(
          DL_ERROR_CODES.NOT_FOUND,
          "لا يوجد سجل بهذا الكود: " + code,
        );
      var out = Object.assign({}, row);
      delete out._row;
      return _dlOk(out);
    } catch (e) {
      _dlLog("getByCode", table, e);
      return _dlErr(e.code, e.message || String(e));
    }
  }

  // ── Read: find (generic filter query) ────────────────────────────────
  function find(table, filter, opts) {
    opts = opts || {};
    try {
      var loaded = _rawRows(table, opts);
      var rows = _excludeDeleted(loaded.rows, opts.includeDeleted);
      rows = rows.filter(function (r) {
        return _matchFilter(r, filter);
      });
      if (opts.sortBy) rows = sortRows(rows, opts.sortBy, opts.sortDir);
      var clean = cleanArr(rows);
      return _dlOk(
        opts.page ? paginate(clean, opts.page, opts.pageSize) : clean,
      );
    } catch (e) {
      _dlLog("find", table, e);
      return _dlErr(e.code, e.message || String(e));
    }
  }

  // ── Read: search (case-insensitive substring match over given fields) ──
  function search(table, query, fields, opts) {
    opts = opts || {};
    try {
      var loaded = _rawRows(table, opts);
      var rows = _excludeDeleted(loaded.rows, opts.includeDeleted);
      var q = String(query || "")
        .trim()
        .toLowerCase();
      if (q) {
        rows = rows.filter(function (r) {
          return (fields || []).some(function (f) {
            return (
              String(r[f] || "")
                .toLowerCase()
                .indexOf(q) !== -1
            );
          });
        });
      }
      if (opts.sortBy) rows = sortRows(rows, opts.sortBy, opts.sortDir);
      var clean = cleanArr(rows);
      return _dlOk(
        opts.page ? paginate(clean, opts.page, opts.pageSize) : clean,
      );
    } catch (e) {
      _dlLog("search", table, e);
      return _dlErr(e.code, e.message || String(e));
    }
  }

  // ── count / exists ───────────────────────────────────────────────────
  function count(table, filter, opts) {
    opts = opts || {};
    try {
      var loaded = _rawRows(table, opts);
      var rows = _excludeDeleted(loaded.rows, opts.includeDeleted);
      if (filter) {
        rows = rows.filter(function (r) {
          return _matchFilter(r, filter);
        });
      }
      return _dlOk(rows.length);
    } catch (e) {
      _dlLog("count", table, e);
      return _dlErr(e.code, e.message || String(e));
    }
  }

  function exists(table, filter, opts) {
    var res = count(table, filter, opts);
    if (!res.success) return res;
    return _dlOk(res.data > 0);
  }

  // ── pagination / sorting (generic utilities, also usable standalone) ──
  function paginate(rows, page, pageSize) {
    page = Math.max(1, Number(page || 1));
    pageSize = Math.max(1, Number(pageSize || 20));
    var total = rows.length;
    var start = (page - 1) * pageSize;
    return {
      items: rows.slice(start, start + pageSize),
      page: page,
      pageSize: pageSize,
      total: total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  // Sorts a copy of `rows`. Numeric fields sort numerically; everything
  // else sorts as a locale-aware ("ar") string comparison. Empty/undefined
  // values are always pushed to the end regardless of direction.
  function sortRows(rows, sortBy, sortDir) {
    var dir = String(sortDir || "asc").toLowerCase() === "desc" ? -1 : 1;
    return rows.slice().sort(function (a, b) {
      var av = a[sortBy],
        bv = b[sortBy];
      if (av === bv) return 0;
      if (av === undefined || av === null || av === "") return 1;
      if (bv === undefined || bv === null || bv === "") return -1;
      if (typeof av === "number" && typeof bv === "number")
        return (av - bv) * dir;
      return String(av).localeCompare(String(bv), "ar") * dir;
    });
  }

  // ── Write: insert ────────────────────────────────────────────────────
  /**
   * @param {string} table
   * @param {Object} data
   * @param {{idPrefix?: string, uniqueField?: string, headers?: string[]}} [opts]
   *   opts.idPrefix: prefix passed to makeId() (default: first 3 letters of
   *   the table name, upper case).
   *   opts.uniqueField: a field that must be unique — checked before insert.
   */
  function insert(table, data, opts) {
    opts = opts || {};
    try {
      var headers = _headersFor(table, opts.headers);
      if (!headers)
        return _dlErrU(DL_ERROR_CODES.UNKNOWN_TABLE, "جدول غير معروف: " + table);
      data = data || {};

      if (opts.uniqueField && data[opts.uniqueField]) {
        var dup = find(
          table,
          function (r) {
            return (
              String(r[opts.uniqueField] || "").toLowerCase() ===
              String(data[opts.uniqueField]).toLowerCase()
            );
          },
          { headers: headers },
        );
        if (dup.success && dup.data.length) {
          return _dlErrU(
            DL_ERROR_CODES.DUPLICATE,
            "القيمة مكررة في الحقل: " + opts.uniqueField,
          );
        }
      }

      var id = data.id;
      if (!id && headers.indexOf("id") !== -1) {
        id = makeId(opts.idPrefix || table.substr(0, 3).toUpperCase());
      }
      var now = new Date().toISOString();

      var row = headers.map(function (h) {
        if (h === "id") return id !== undefined ? id : "";
        if (h === "created_at") return data[h] !== undefined ? data[h] : now;
        if (h === "updated_at") return data[h] !== undefined ? data[h] : now;
        if (h === "deleted_at") return "";
        if (h === "deleted_by") return "";
        return data[h] !== undefined ? data[h] : "";
      });

      var sheet = getSheet(table, headers);
      if (typeof _appendRowProtected === "function") {
        _appendRowProtected(sheet, headers, row);
      } else {
        sheet.appendRow(row);
      }

      if (typeof _invalidateServerCache === "function")
        _invalidateServerCache();
      // [UNIFIED RESULT SHAPE] Exposes both `.success` and `.ok` — see the
      // note above _dlErrU for why both keys are kept in sync everywhere.
      var _insResult = _dlOk({ id: id });
      _insResult.ok = true;
      return _insResult;
    } catch (e) {
      _dlLog("insert", table, e);
      return _dlErrU(e.code, e.message || String(e));
    }
  }

  // ── Write: update (partial — merges the given patch onto the current row) ──
  function update(table, id, patch, opts) {
    opts = opts || {};
    try {
      var headers = _headersFor(table, opts.headers);
      if (!headers)
        return _dlErrU(DL_ERROR_CODES.UNKNOWN_TABLE, "جدول غير معروف: " + table);
      if (!id) return _dlErrU(DL_ERROR_CODES.VALIDATION, "المعرف (id) مطلوب");

      var rows = readSheet(table, headers);
      var current = rows.find(function (r) {
        return String(r.id) === String(id);
      });
      if (!current)
        return _dlErrU(DL_ERROR_CODES.NOT_FOUND, "السجل غير موجود: " + id);

      patch = patch || {};
      if (
        headers.indexOf("updated_at") !== -1 &&
        patch.updated_at === undefined
      ) {
        patch = Object.assign({}, patch, {
          updated_at: new Date().toISOString(),
        });
      }

      var row = headers.map(function (h) {
        return Object.prototype.hasOwnProperty.call(patch, h)
          ? patch[h]
          : current[h];
      });

      var sheet = getSheet(table, headers);
      var targetRange = sheet.getRange(current._row, 1, 1, headers.length);
      // Any leftover font color (e.g. white text left over from a row whose
      // content was cleared without also clearing formatting) must be reset
      // before writing — otherwise the updated row stays visually "hidden"
      // the same way stale rows do, not just newly inserted ones.
      targetRange.setFontColor(null);
      targetRange.setValues([row]);
      // Cache invalidation on update was previously missing here (it was
      // present in insert() and remove() but had been dropped from update()
      // by omission), which meant a record updated via update() could keep
      // serving stale cached data to any other read until something else
      // happened to trigger an insert/remove. See KNOWN_ISSUES.md.
      if (typeof _invalidateServerCache === "function")
        _invalidateServerCache();
      // [UNIFIED RESULT SHAPE] see the note above _dlErrU.
      return { ok: true, success: true, id: id };
    } catch (e) {
      return _dlErrU(e.code, e.message || String(e));
    }
  }

  // ── Write: delete (soft delete when the table supports it, else hard delete) ──
  // opts.hard = true forces a hard delete even when the table supports
  // deleted_at.
  function remove(table, id, opts) {
    opts = opts || {};
    try {
      var headers = _headersFor(table, opts.headers);
      if (!headers)
        return _dlErrU(DL_ERROR_CODES.UNKNOWN_TABLE, "جدول غير معروف: " + table);
      if (!id) return _dlErrU(DL_ERROR_CODES.VALIDATION, "المعرف (id) مطلوب");

      var supportsSoft = headers.indexOf("deleted_at") !== -1;
      var hard = !!opts.hard || !supportsSoft;

      var rows = readSheet(table, headers);
      var current = rows.find(function (r) {
        return String(r.id) === String(id);
      });
      if (!current)
        return _dlErrU(DL_ERROR_CODES.NOT_FOUND, "السجل غير موجود: " + id);

      var sheet = getSheet(table, headers);

      if (hard) {
        sheet.deleteRow(current._row);
      } else {
        var patch = {
          deleted_at: new Date().toISOString(),
          deleted_by: opts.deletedBy || "",
        };
        var row = headers.map(function (h) {
          return Object.prototype.hasOwnProperty.call(patch, h)
            ? patch[h]
            : current[h];
        });
        var targetRange2 = sheet.getRange(current._row, 1, 1, headers.length);
        // Same font-color reset as in update() — must happen before any
        // setValues call.
        targetRange2.setFontColor(null);
        targetRange2.setValues([row]);
      }

      if (typeof _invalidateServerCache === "function")
        _invalidateServerCache();
      // [UNIFIED RESULT SHAPE] see the note above _dlErrU.
      var _rmResult = _dlOk({ id: id, hardDeleted: hard });
      _rmResult.ok = true;
      return _rmResult;
    } catch (e) {
      _dlLog("delete", table, e);
      return _dlErrU(e.code, e.message || String(e));
    }
  }

  // ── Bulk: insert ─────────────────────────────────────────────────────
  function bulkInsert(table, rowsData, opts) {
    opts = opts || {};
    try {
      var headers = _headersFor(table, opts.headers);
      if (!headers)
        return _dlErrU(DL_ERROR_CODES.UNKNOWN_TABLE, "جدول غير معروف: " + table);
      if (!Array.isArray(rowsData) || !rowsData.length) {
        var _biEmpty = _dlOk({ ids: [], count: 0 });
        _biEmpty.ok = true;
        return _biEmpty;
      }

      var now = new Date().toISOString();
      var ids = [];
      var matrix = rowsData.map(function (data) {
        data = data || {};
        var id =
          data.id || makeId(opts.idPrefix || table.substr(0, 3).toUpperCase());
        ids.push(id);
        return headers.map(function (h) {
          if (h === "id") return id;
          if (h === "created_at") return data[h] !== undefined ? data[h] : now;
          if (h === "deleted_at") return "";
          return data[h] !== undefined ? data[h] : "";
        });
      });

      // Single bulk write (setValues) instead of writing row-by-row in a
      // loop — critical for performance on large batches.
      var sheet = getSheet(table, headers);
      var startRow = sheet.getLastRow() + 1;
      var bulkRange = sheet.getRange(
        startRow,
        1,
        matrix.length,
        headers.length,
      );
      // Same font-color reset as insert()/update() — before the bulk write.
      bulkRange.setFontColor(null);
      bulkRange.setValues(matrix);

      if (typeof _invalidateServerCache === "function")
        _invalidateServerCache();
      var _biResult = _dlOk({ ids: ids, count: ids.length });
      _biResult.ok = true;
      return _biResult;
    } catch (e) {
      _dlLog("bulkInsert", table, e);
      return _dlErrU(e.code, e.message || String(e));
    }
  }

  // ── Bulk: update ─────────────────────────────────────────────────────
  // patches: [{ id, patch }]
  // Performance note: each item goes through the same logic as update()
  // (a full read plus a single-row write), which is correct and safe but
  // not optimized for very large batches (1000+ records). A future
  // optimization would build an id→row map once and then write in
  // consolidated ranges — see "not yet migrated/optimized" in the final
  // report.
  function bulkUpdate(table, patches, opts) {
    opts = opts || {};
    try {
      if (!Array.isArray(patches) || !patches.length) {
        var _buEmpty = _dlOk({ updated: 0 });
        _buEmpty.ok = true;
        return _buEmpty;
      }
      var results = patches.map(function (p) {
        return update(table, p.id, p.patch, opts);
      });
      var failed = results.filter(function (r) {
        return !r.success;
      });
      if (failed.length) {
        return _dlErrU(
          DL_ERROR_CODES.INTERNAL,
          "فشل تحديث " + failed.length + " من أصل " + patches.length + " سجل",
          { failed: failed },
        );
      }
      var _buResult = _dlOk({ updated: results.length });
      _buResult.ok = true;
      return _buResult;
    } catch (e) {
      _dlLog("bulkUpdate", table, e);
      return _dlErrU(e.code, e.message || String(e));
    }
  }

  // ── Bulk: delete ─────────────────────────────────────────────────────
  function bulkDelete(table, ids, opts) {
    opts = opts || {};
    try {
      if (!Array.isArray(ids) || !ids.length) {
        var _bdEmpty = _dlOk({ deleted: 0 });
        _bdEmpty.ok = true;
        return _bdEmpty;
      }
      var results = ids.map(function (id) {
        return remove(table, id, opts);
      });
      var failed = results.filter(function (r) {
        return !r.success;
      });
      if (failed.length) {
        return _dlErrU(
          DL_ERROR_CODES.INTERNAL,
          "فشل حذف " + failed.length + " من أصل " + ids.length + " سجل",
          { failed: failed },
        );
      }
      var _bdResult = _dlOk({ deleted: results.length });
      _bdResult.ok = true;
      return _bdResult;
    } catch (e) {
      _dlLog("bulkDelete", table, e);
      return _dlErrU(e.code, e.message || String(e));
    }
  }

  return {
    // Read
    get: getAll,
    getAll: getAll,
    getById: getById,
    getByCode: getByCode,
    find: find,
    search: search,
    count: count,
    exists: exists,
    paginate: paginate,
    sort: sortRows,
    // Write
    insert: insert,
    update: update,
    delete: remove,
    // `remove` is exported as an alias of the same `delete` implementation.
    // The public interface originally exported the internal remove() only
    // as `delete`, but it turned out to be called in several modules as
    // DataLayer.remove(...) (Code_15_HR.js, Code_24_WhatsApp.js) and via
    // RepositoryLayer.remove() (Code_38 — used by Code_20_Sales.js for
    // PartyAddresses/PartyDocuments), which produced a
    // "DataLayer.remove is not a function" runtime error at every one of
    // those call sites. Rather than chasing and changing every call site
    // individually, both names now point to the same implementation.
    remove: remove,
    // Bulk
    bulkInsert: bulkInsert,
    bulkUpdate: bulkUpdate,
    bulkDelete: bulkDelete,
  };
})();

// [NAMING ALIAS] The file is named Code_34_DataLayerEngine.gs, but the
// exported object has historically been called DataLayer (without
// "Engine") — unlike every other engine in the project (BusinessRulesEngine
// / FileEngine / ValidationEngine / PaymentEngine / WorkflowEngine /
// ImportEngine / I18nEngine), which all match their filename exactly.
// DataLayerEngine here is only an alias (the exact same object, not a
// second copy), so new code can call DataLayerEngine.* consistent with the
// naming of the other engines, without touching any of the many existing
// DataLayer.* call sites (Code_28/Code_38/Code_12...).
var DataLayerEngine = DataLayer;
