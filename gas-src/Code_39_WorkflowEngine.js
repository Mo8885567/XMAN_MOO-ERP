// ══════════════════════════════════════════════════════════════════════════
// MODULE: Code_39_WorkflowEngine.gs — WorkflowEngine (generic state machine)
// ──────────────────────────────────────────────────────────────────────────
// PURPOSE
//   Provide one reusable state-machine engine so document status flows
//   (draft → approved → received, etc.) don't need to be redefined and
//   manually re-validated inside every approve/cancel function across
//   modules (Purchase Orders, Sales, Vouchers, ...).
//
// RESPONSIBILITIES
//   - Register named state-machine definitions (define).
//   - Check whether a transition is currently allowed, with no side effects
//     (canTransition, canReachState).
//   - Execute a transition: validate it, persist the new status through the
//     unified Repository/DataLayer, and record an audit log entry
//     (transition).
//
// RELATED FILES
//   - Code_27_PurchaseOrders.gs, Code_06_Accounting_Vouchers.gs,
//     Code_40_PurchaseRequests.gs, Code_16_Inventory.gs, Code_15_HR.gs,
//     Code_09_Banking.gs — modules whose status flows are registered below.
//
// DEPENDS ON
//   - RepositoryLayer (Code_38) — used by transition() to read/write the
//     record whose status is changing.
//   - AuditEngine — used by transition() to log each state change.
//   - LockService — used by transition() to serialize concurrent
//     transitions on the same record.
//
// USED BY
//   - Any module that registers a workflow definition and calls
//     canTransition/transition instead of hand-rolling its own status
//     validation.
//
// ARCHITECTURAL NOTES
//   - This engine is opt-in. Registering a definition (WorkflowEngine.define)
//     and using it (WorkflowEngine.canTransition / .transition) does not
//     change any function currently in PurchaseOrders/Sales/Vouchers —
//     those keep running on their existing logic until a module is
//     deliberately wired to the engine. That is a per-module decision,
//     because each approval function also carries additional business
//     logic (inventory updates, accounting postings, ...), not just a
//     status field change.
//   - transition() only changes the status field through Repository/
//     DataLayer and writes the audit log — it does not include any of that
//     additional business logic. Callers are responsible for anything else
//     that needs to happen before or after calling transition(), exactly as
//     the existing approval functions do today.
//
// USAGE (from any .gs file in the same project):
//   WorkflowEngine.define("Invoice", {
//     initial: "مسودة",
//     states: ["مسودة", "معتمد", "ملغي"],
//     transitions: {
//       "مسودة":  { approve: "معتمد", cancel: "ملغي" },
//       "معتمد":  { cancel: "ملغي" },
//     },
//   });
//   var check = WorkflowEngine.canTransition("Invoice", order.status, "approve");
//   if (!check.allowed) return errResponse(check.message);
//
//   var res = WorkflowEngine.transition({
//     workflow: "Invoice",
//     table: "SaleInvoices",
//     recordId: id,
//     currentState: order.status,
//     action: "approve",
//     user: callerUser,
//     details: "اعتماد فاتورة بيع",
//   });
// ══════════════════════════════════════════════════════════════════════════

var WorkflowEngine = (function () {
  "use strict";

  var _definitions = {};

  /**
   * Registers a state machine under a given name.
   * @param {string} name - State machine name (e.g. "PurchaseOrder").
   * @param {{initial: string, states: string[], transitions: Object<string, Object<string,string>>}} config
   */
  function define(name, config) {
    if (!config || !config.initial || !config.states || !config.transitions) {
      throw new Error(
        "WorkflowEngine.define: تعريف ناقص لآلة الحالة '" + name + "'",
      );
    }
    _definitions[name] = config;
  }

  function _get(name) {
    var def = _definitions[name];
    if (!def) {
      throw new Error("WorkflowEngine: آلة حالة غير مُعرَّفة: " + name);
    }
    return def;
  }

  /**
   * Checks, with no side effects, whether `action` is allowed from
   * `currentState`.
   * @returns {{allowed: boolean, nextState: string|null, message: string}}
   */
  function canTransition(name, currentState, action) {
    try {
      var def = _get(name);
      var stateTransitions = def.transitions[currentState];
      if (!stateTransitions || !stateTransitions[action]) {
        return {
          allowed: false,
          nextState: null,
          message:
            "لا يمكن تنفيذ '" +
            action +
            "' من الحالة الحالية '" +
            currentState +
            "'",
        };
      }
      return {
        allowed: true,
        nextState: stateTransitions[action],
        message: "",
      };
    } catch (e) {
      return { allowed: false, nextState: null, message: e.message };
    }
  }

  /**
   * Executes a transition: validates it, writes the new status through the
   * unified RepositoryLayer (Code_38), and records an audit log entry.
   * Carries no additional business logic (accounting postings, inventory
   * updates, ...) — that remains the caller's responsibility before or
   * after calling transition(), exactly as the existing approval functions
   * do today.
   *
   * @param {Object} opts
   * @param {string} opts.workflow - Registered state machine name.
   * @param {string} opts.table - Table name understood by RepositoryLayer.
   * @param {string} opts.recordId
   * @param {string} opts.currentState - Caller's view of the current state;
   *   used only as a fallback if the fresh read below fails.
   * @param {string} opts.action
   * @param {string} [opts.user]
   * @param {string} [opts.details]
   * @param {string} [opts.statusField] - Defaults to "status"; set this if
   *   the table's status column has a different name.
   * @returns {{success: boolean, data?: Object, message: string, code?: string}}
   */
  function transition(opts) {
    opts = opts || {};

    // Concurrent approve/cancel calls on the same record (e.g. two open
    // tabs) could both pass canTransition() against the same stale state if
    // this function trusted opts.currentState as read by the caller before
    // the call, with no lock and no re-read from the source — duplicating
    // the transition and its audit entry. To prevent that, the read-check-
    // write sequence is wrapped in a lock, and the actual current state is
    // re-read from the Repository inside the lock before any write — the
    // same pattern used by generatePayroll/recordLoanPayment.
    var _wfLock = LockService.getScriptLock();
    try {
      _wfLock.waitLock(10000);
    } catch (lockErr) {
      return {
        success: false,
        message: "النظام مشغول بتنفيذ عملية أخرى على نفس السجل، حاول مرة أخرى",
        code: "WF_LOCK_TIMEOUT",
      };
    }
    try {
      var repo = RepositoryLayer.get(opts.table);
      var statusField = opts.statusField || "status";

      // Re-read the actual current state from source rather than relying on
      // opts.currentState, which may reflect a read taken before the lock
      // was acquired.
      var freshRes = repo.getById(opts.recordId);
      var freshRecord =
        freshRes && freshRes.success !== false
          ? freshRes.data || freshRes
          : null;
      var actualCurrentState = freshRecord
        ? freshRecord[statusField]
        : opts.currentState;

      var check = canTransition(opts.workflow, actualCurrentState, opts.action);
      if (!check.allowed) {
        return { success: false, message: check.message, code: "WF_INVALID_TRANSITION" };
      }

      var patch = {};
      patch[statusField] = check.nextState;

      var writeResult = repo.update(opts.recordId, patch);
      if (!writeResult || writeResult.success === false) {
        return (
          writeResult || {
            success: false,
            message: "فشل تحديث حالة السجل",
            code: "WF_WRITE_FAILED",
          }
        );
      }

      try {
        AuditEngine.log("WORKFLOW_" + opts.action, {
          user: opts.user || "SYSTEM",
          table: opts.table,
          record_id: opts.recordId,
          oldValue: actualCurrentState,
          newValue: check.nextState,
          details: opts.details || ""});
      } catch (e) {
        console.warn("WorkflowEngine: فشل تسجيل التدقيق:", e.message);
      }

      return {
        success: true,
        data: { id: opts.recordId, status: check.nextState },
        message: "تم الانتقال إلى: " + check.nextState,
      };
    } finally {
      _wfLock.releaseLock();
    }
  }

  function getDefinition(name) {
    return _definitions[name] || null;
  }

  /**
   * Same purpose as canTransition, but for callers that receive a target
   * state directly (rather than a named action) — e.g. a screen that sends
   * a full new status from the frontend instead of a named action (for
   * example, changing a production order's status). Searches
   * transitions[currentState] for whichever action leads to targetState.
   * @returns {{allowed: boolean, action: string|null, nextState: string|null, message: string}}
   */
  function canReachState(name, currentState, targetState) {
    try {
      var def = _get(name);
      var stateTransitions = def.transitions[currentState] || {};
      for (var action in stateTransitions) {
        if (stateTransitions[action] === targetState) {
          return {
            allowed: true,
            action: action,
            nextState: targetState,
            message: "",
          };
        }
      }
      return {
        allowed: false,
        action: null,
        nextState: null,
        message:
          "لا يمكن الانتقال من '" +
          currentState +
          "' إلى '" +
          targetState +
          "'",
      };
    } catch (e) {
      return { allowed: false, action: null, nextState: null, message: e.message };
    }
  }

  return {
    define: define,
    canTransition: canTransition,
    canReachState: canReachState,
    transition: transition,
    getDefinition: getDefinition,
  };
})();

// ── Definitions documenting state flows that already exist elsewhere ──────
// The definitions below document status flows whose real logic already
// lives in the referenced files. Registering them here does not change the
// behavior of those files; it makes the flows available to any new code
// (new screens, reports) that needs to ask "is this transition allowed?"
// without re-implementing the same conditional tree.

// See Code_27_PurchaseOrders.gs — addPurchaseOrder/approvePurchaseOrder/
// receivePurchaseOrder/deletePurchaseOrder for the matching real states.
WorkflowEngine.define("PurchaseOrder", {
  initial: "مسودة",
  states: ["مسودة", "معتمد", "مستلم", "ملغي"],
  transitions: {
    "مسودة": { approve: "معتمد", cancel: "ملغي" },
    "معتمد": { receive: "مستلم", cancel: "ملغي" },
  },
});

// See Code_06_Accounting_Vouchers.gs — approveReceiptVoucher/
// cancelReceiptVoucher, approvePaymentVoucher/cancelPaymentVoucher,
// approveExpense/cancelExpense. All three modules use exactly the same
// state machine (DRAFT/APPROVED/CANCELLED) with identical transition
// rules, so one shared definition covers all three instead of duplicating
// it per module. Note: "cancel" is allowed from both DRAFT and APPROVED
// (not from CANCELLED), matching the original per-function guard that
// rejected cancellation of an already-cancelled record.
WorkflowEngine.define("Voucher", {
  initial: "DRAFT",
  states: ["DRAFT", "APPROVED", "CANCELLED"],
  transitions: {
    "DRAFT": { approve: "APPROVED", cancel: "CANCELLED" },
    "APPROVED": { cancel: "CANCELLED" },
  },
});

// See Code_40_PurchaseRequests.gs — the first module built to use the full
// WorkflowEngine.transition() from the start (not just canTransition() for
// validation, as PurchaseOrder/Voucher above do). A purchase request is an
// internal approval gate ahead of the actual purchase order: it must be
// approved before converting to a real purchase order, and may be rejected
// on record, or cancelled before conversion.
WorkflowEngine.define("PurchaseRequest", {
  initial: "مسودة",
  states: ["مسودة", "معتمد", "مرفوض", "محوّل", "ملغي"],
  transitions: {
    "مسودة": { approve: "معتمد", reject: "مرفوض", cancel: "ملغي" },
    "معتمد": { convert: "محوّل", cancel: "ملغي" },
  },
});

// See Code_16_Inventory.gs — updateProductionOrderStatus(). Unlike the
// three documentation-only definitions above, the original function here
// did not validate the current state at all — it accepted any new status
// within its allow-list (pending/inprogress/done/cancelled) regardless of
// the current state, meaning an order could be moved from "done" back to
// "pending", for example. This definition closes that gap for real (this
// one is not merely documentation) — see the [WORKFLOW-ENGINE] comment in
// updateProductionOrderStatus for how it is wired in.
WorkflowEngine.define("ProductionOrder", {
  initial: "pending",
  states: ["pending", "inprogress", "done", "cancelled"],
  transitions: {
    "pending": { start: "inprogress", cancel: "cancelled" },
    "inprogress": { complete: "done", cancel: "cancelled" },
  },
});

// See Code_15_HR.gs — approveLeaveRequest/rejectLeaveRequest/
// deleteLeaveRequest. States were previously checked manually
// (rows[idx].status !== "PENDING"), with the same condition duplicated
// verbatim across both functions. This definition is now used as an
// additional canTransition guard inside approve/reject (same pattern as
// Voucher/PurchaseOrder above: validation only — the actual write and the
// extra fields approved_by/approved_at/rejection_reason remain in each
// function as-is, since they update more than the single status column
// that transition() currently supports).
WorkflowEngine.define("LeaveRequest", {
  initial: "PENDING",
  states: ["PENDING", "APPROVED", "REJECTED"],
  transitions: {
    "PENDING": { approve: "APPROVED", reject: "REJECTED" },
  },
});

// See Code_09_Banking.gs — CHEQUE_INCOMING_WORKFLOW_TRANSITIONS /
// CHEQUE_OUTGOING_WORKFLOW_TRANSITIONS and changeChequeStatus() (see the
// CHQ-WORKFLOW-V2 comments there). This is already a correctly type-aware
// state machine that validates itself properly inside changeChequeStatus
// (not a data gap like ProductionOrder above). The two definitions here are
// documentation only — they expose the same transitions through the
// WorkflowEngine.canReachState interface for any new code, instead of that
// code re-importing CHEQUE_*_WORKFLOW_TRANSITIONS itself — and they do not
// replace or modify Banking.js's actual logic. Fully consolidating onto one
// state machine implementation is a separate architectural decision outside
// the scope of this change (see the audit report, WorkflowEngine item).
WorkflowEngine.define("ChequeIncoming", {
  initial: "RECEIVED",
  states: [
    "PENDING", "RECEIVED", "DEPOSITED_FOR_COLLECTION", "ENDORSED",
    "RETURNED", "RETURNED_TO_OWNER", "CASHED", "BOUNCED", "COLLECTED",
    "CANCELLED", "REPLACED",
  ],
  transitions: {
    "PENDING": {
      deposit: "DEPOSITED_FOR_COLLECTION", endorse: "ENDORSED",
      collect: "COLLECTED", bounce: "BOUNCED", cancel: "CANCELLED",
    },
    "RECEIVED": { deposit: "DEPOSITED_FOR_COLLECTION", endorse: "ENDORSED", cancel: "CANCELLED" },
    "DEPOSITED_FOR_COLLECTION": { cash: "CASHED", return: "RETURNED" },
    "ENDORSED": { return: "RETURNED" },
    "RETURNED": { returnToOwner: "RETURNED_TO_OWNER", replace: "REPLACED" },
    "BOUNCED": { reReceive: "RECEIVED", cancel: "CANCELLED", replace: "REPLACED" },
  },
});
WorkflowEngine.define("ChequeOutgoing", {
  initial: "DRAFTED",
  states: [
    "PENDING", "DRAFTED", "PAID", "RETURNED_OUT", "BOUNCED",
    "COLLECTED", "CANCELLED", "REPLACED",
  ],
  transitions: {
    "PENDING": {
      pay: "PAID", returnOut: "RETURNED_OUT",
      collect: "COLLECTED", bounce: "BOUNCED", cancel: "CANCELLED",
    },
    "DRAFTED": { pay: "PAID", returnOut: "RETURNED_OUT", cancel: "CANCELLED" },
    "RETURNED_OUT": { redraft: "DRAFTED", cancel: "CANCELLED", replace: "REPLACED" },
    "BOUNCED": { redraft: "DRAFTED", cancel: "CANCELLED", replace: "REPLACED" },
  },
});
