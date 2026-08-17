// ════════════════════════════════════════════════════════════════════
// MODULE: Code_44_DeleteEngine.gs — Unified Delete Engine
// ────────────────────────────────────────────────────────────────────
// PURPOSE
//   Single layer used by every screen in the system instead of each
//   module re-implementing its own delete logic (previously spread
//   across 78 functions in ~35 files).
//
// RESPONSIBILITIES
//   - Look up the delete policy for any entity type from one config map
//     (DeleteConfig) instead of hand-written per-screen logic.
//   - Scan dependent tables dynamically before allowing a delete
//     (DependencyChecker).
//   - Archive a full copy of a record before any delete, so it can be
//     restored later (ArchiveService).
//   - Restore any archived entity, not just Items.
//   - Return one unified delete result shape (SUCCESS/BLOCKED/
//     PERMISSION_DENIED/...).
//   - Record detailed audit logging (user/date/module/entity/oldData/
//     duration...) for every delete/restore.
//
// RELATED FILES
//   - Code_05b_InvoiceSoftDelete.js — owns the critical sale/purchase
//     invoice delete logic (inventory reversal, cost layers, journal
//     entry cancellation), delegated to via customDelete.
//   - The ~20 legacy per-entity delete functions across Code_12_Core.js,
//     Code_20_Sales.js, Code_09_Banking.gs, HR, Inventory, and
//     Manufacturing modules, each delegated to via customDelete without
//     any change to their internal logic.
//
// DEPENDS ON
//   - Code_00_ServiceLayer.js, Code_12_Core.js, Code_18_Permissions.js,
//     Code_33_BusinessRulesEngine.js, Code_34_DataLayerEngine.js — must
//     be loaded before this file.
//   - AuditEngine (logging), DocumentEngine (Drive folder archiving for
//     hard-deleted items), LockService (concurrency safety).
//
// USED BY
//   - Any screen, through the three unified entry points below.
//
// PUBLIC ENTRY POINTS
//   DeleteEngine.delete(entityType, id, callerUser, sessionToken, opts)
//   DeleteEngine.preview(entityType, id, callerUser, sessionToken)
//   DeleteEngine.restore(entityType, id, callerUser, sessionToken)
//
// ARCHITECTURAL NOTES
//   - This engine does not replace ServiceLayer / BusinessRulesEngine /
//     DataLayerEngine — it is a layer above them that coordinates
//     between them and adds what those didn't already provide (dynamic
//     dependency scanning, archive/restore, a unified result shape,
//     detailed logging).
//   - Adding a new entity = one new entry in DeleteConfig. No new delete
//     code should be written in any screen.
//   - Many entities below still route through their own long-standing
//     delete function via `customDelete` rather than through the
//     engine's generic soft/hard-delete path. That is intentional: those
//     functions already contain proven, entity-specific business logic
//     (accounting reversal, inventory reversal, protecting the last
//     admin account, etc.) that this engine does not re-implement — it
//     only unifies the entry point so any screen can call
//     DeleteEngine.delete(entityType, ...) without needing to know each
//     entity's original function name or parameter order.
// ════════════════════════════════════════════════════════════════════

// ── Unified delete result codes ────────────────────────────────────
var DELETE_RESULT = Object.freeze({
  SUCCESS: "SUCCESS",
  BLOCKED: "BLOCKED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  DEPENDENCY_FOUND: "DEPENDENCY_FOUND",
  BUSINESS_RULE_VIOLATION: "BUSINESS_RULE_VIOLATION",
  ALREADY_DELETED: "ALREADY_DELETED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
});

// ════════════════════════════════════════════════════════════════════
// DeleteConfig — per-entity delete policy
// ════════════════════════════════════════════════════════════════════
//
// Each entity is described by:
//   table             : underlying sheet name
//   idField           : id column name (default "id")
//   permissionAction  : permission key checked via _checkPermission
//   allowSoftDelete   : default true (soft delete is the system-wide default)
//   allowHardDelete   : default false — requires admin + zero dependencies
//   breEntityType     : name used in BusinessRulesEngine.validateBeforeDelete
//                       (if absent, only the `dependencies` scan below applies)
//   dependencies      : relations the engine scans dynamically before delete;
//                       each item: { table, field, label } where `field` is
//                       the column in the dependent table pointing back to
//                       this entity's id.
//   softField / softInactiveValue : for entities that mark "deleted" via a
//                       flag column (e.g. is_active = "FALSE") instead of
//                       deleted_at/deleted_by.
//   customValidate(record, id) : entity-specific business rule not yet
//                       migrated into BusinessRulesEngine (see note below).
//   customDelete(id, callerUser, sessionToken) : full delegation to an
//                       existing, already-proven delete function; when
//                       present, it is the entire delete implementation for
//                       that entity (see architectural notes above).
//   afterDelete(id, callerUser, record) : optional cascade run after a
//                       successful base-record delete; a cascade failure is
//                       only logged as a warning, it does not fail the
//                       overall delete (the base record is already deleted
//                       and archived by that point).
//
// Adding support for a new entity = one new entry here. No new delete code
// should be written in any screen.
var DeleteConfig = Object.freeze({
  // Customers/Suppliers sheets have no deleted_at column (see _deleteParty
  // in Code_20_Sales.js, which always performs a real hard delete via
  // Repositories.remove). DataLayerEngine.delete will detect the missing
  // column and automatically fall back to hard delete — identical to the
  // legacy behavior, with no regression. Real usage checks (invoices/
  // transactions) are enforced by BusinessRulesEngine.validateBeforeDelete
  // (which internally calls _partyHasUsage) — that is the actual guarantee;
  // the DependencyChecker below is advisory only, used for the preview
  // window, until every invoice/voucher sheet's exact column names are
  // confirmed (a later phase).
  customer: {
    table: "Customers",
    // "Customers" is not registered in the shared HEADERS/
    // ACCOUNTING_HR_HEADERS maps (CUSTOMER_HEADERS is a separate variable
    // in Code_20_Sales.js) — without this line, DataLayerEngine._headersFor
    // returns null and DataLayerEngine.delete fails immediately with
    // UNKNOWN_TABLE, regardless of whether the id is valid.
    headers: CUSTOMER_HEADERS,
    permissionAction: "deleteCustomer",
    breEntityType: "customer",
    allowHardDelete: false,
    dependencies: [
      { table: "SaleInvoices", field: "customer_id", label: "فواتير بيع" },
      { table: "SaleReturns", field: "customer_id", label: "مرتجعات بيع" },
    ],
  },

  supplier: {
    table: "Suppliers",
    // Same header-registration gap as customer.headers above.
    headers: SUPPLIER_HEADERS,
    permissionAction: "deleteSupplier",
    breEntityType: "supplier",
    allowHardDelete: false,
    dependencies: [
      { table: "PurchaseInvoices", field: "supplier_id", label: "فواتير شراء" },
      { table: "PurchaseReturns", field: "supplier_id", label: "مرتجعات شراء" },
    ],
  },

  item: {
    table: "Items",
    permissionAction: "deleteItem",
    breEntityType: "item",
    allowHardDelete: true, // forceDeleteItem — admin only + zero dependencies
    dependencies: [
      { table: "InventoryTransactions", field: "item_id", label: "حركات مخزون" },
      { table: "SaleInvoiceLines", field: "item_id", label: "بنود فواتير بيع" },
      { table: "PurchaseInvoiceLines", field: "item_id", label: "بنود فواتير شراء" },
      { table: "ProductionOrders", field: "item_id", label: "أوامر إنتاج" },
      { table: "BOM", field: "item_id", label: "قوائم مواد (BOM)" },
    ],
  },

  journalEntry: {
    table: "JournalEntries",
    permissionAction: "deleteJournalEntry",
    allowHardDelete: false,
    // [FIX-AUDIT-2026 #8] الحقل كان مكتوباً "journal_id" وهو غير موجود في
    // ChartOfAccounts HEADERS.JournalEntryLines أصلاً — الاسم الصحيح
    // "entry_id" (راجع Code_12_Core.js). كان هذا يخلي DependencyChecker.scan
    // يرجّع دايماً صفر بنود مرتبطة لأي قيد، فنافذة تأكيد الحذف كانت تعرض
    // "لا توجد بيانات مرتبطة" حتى لو القيد عليه عشرات السطور فعلياً —
    // تضليل مباشر للمستخدم في لحظة حذف حساسة.
    dependencies: [
      { table: "JournalEntryLines", field: "entry_id", label: "بنود القيد" },
    ],
    // Without this cascade, deleting the entry via DeleteEngine would leave
    // orphaned JournalEntryLines rows (the engine only deletes the base
    // table row — the dependency scan above is advisory only and does not
    // delete anything automatically). Matches the legacy
    // deleteJournalEntry behavior exactly (delete bottom-up).
    afterDelete: function (id) {
      var linesSheet = getSheet("JournalEntryLines", ACCOUNTING_HR_HEADERS.JournalEntryLines);
      var linesData = readSheet("JournalEntryLines", ACCOUNTING_HR_HEADERS.JournalEntryLines);
      var toDelete = [];
      linesData.forEach(function (l, i) {
        if (l.entry_id === id) toDelete.push(i + 2);
      });
      toDelete.reverse().forEach(function (rowNum) {
        linesSheet.deleteRow(rowNum);
      });
    },
  },

  warehouse: {
    table: "Warehouses",
    // Same header-registration gap as customer.headers above —
    // WAREHOUSE_HEADERS (defined in Code_12_Core.js) is also not
    // registered in the shared HEADERS map.
    headers: WAREHOUSE_HEADERS,
    permissionAction: "deleteWarehouse",
    breEntityType: null, // not yet covered in BusinessRulesEngine — to be added later
    allowHardDelete: false,
    dependencies: [
      { table: "InventoryTransactions", field: "warehouse_id", label: "حركات مخزون" },
      { table: "OpeningStock", field: "warehouse_id", label: "أرصدة افتتاحية" },
      { table: "WHAccess", field: "warehouse_id", label: "صلاحيات وصول مخزن" },
    ],
    // The `dependencies` above are advisory only in the default (soft)
    // mode and do not actually block deletion unless BRE rejects it — and
    // warehouse has no breEntityType. The checks below are carried over
    // verbatim from the legacy deleteWarehouse (Code_16) so real
    // protection isn't lost once this function is wired to the engine.
    customValidate: function (record, id) {
      if (id === "WH_MAIN") {
        return { success: false, message: "لا يمكن حذف المخزن الافتراضي" };
      }
      var whName = record.name || id;

      var linkedGroups = getSheetData("Groups").filter(function (g) {
        return String(g.warehouse_id || "") === String(id);
      });
      if (linkedGroups.length) {
        return {
          success: false,
          message:
            "لا يمكن حذف مخزن مرتبط بمجموعات — يوجد " +
            linkedGroups.length +
            " مجموعة مرتبطة به",
        };
      }

      var hasLinkedItemsStock = getSheetData("Stock").some(function (s) {
        return s.warehouse === whName || s.warehouse === id;
      });
      if (hasLinkedItemsStock) {
        return {
          success: false,
          message: "لا يمكن حذف مخزن مرتبط بأصناف — يوجد أصناف مسجّلة عليه",
        };
      }

      var hasMovements = getSheetData("Transactions").some(function (t) {
        return (
          t.from_warehouse === whName ||
          t.from_warehouse === id ||
          t.to_warehouse === whName ||
          t.to_warehouse === id
        );
      });
      if (hasMovements) {
        return {
          success: false,
          message: "لا يمكن حذف مخزن له حركات مخزون مسجّلة (نقل/توريد/صرف)",
        };
      }
      return { success: true };
    },
  },

  // ── HR module ────────────────────────────────────────────────────
  // Note: some HR sheets use a separate flag column (is_active) instead
  // of deleted_at/deleted_by as their soft-delete convention.
  // softField/softInactiveValue respect that existing per-entity
  // convention exactly rather than forcing deleted_at on them (which
  // would otherwise silently turn their delete into a hard delete).

  department: {
    table: "Departments",
    permissionAction: "deleteDepartment",
    allowHardDelete: false,
    softField: "is_active",
    softInactiveValue: "FALSE",
    dependencies: [{ table: "JobTitles", field: "department_id", label: "وظائف مرتبطة" }],
    customValidate: function (record) {
      var hasJobs = readSheet("JobTitles").some(function (j) {
        return j.department_id === record.id;
      });
      if (hasJobs) return { success: false, message: "لا يمكن حذف قسم له وظائف مرتبطة" };
      var hasChildren = readSheet("Departments").some(function (d) {
        return d.parent_id === record.id;
      });
      if (hasChildren) return { success: false, message: "لا يمكن حذف قسم له أقسام فرعية" };
      return { success: true };
    },
  },

  jobTitle: {
    table: "JobTitles",
    permissionAction: "deleteJobTitle",
    allowHardDelete: false,
    softField: "is_active",
    softInactiveValue: "FALSE",
    dependencies: [{ table: "Employees", field: "job_title_id", label: "موظفون" }],
    customValidate: function (record) {
      var hasEmps = readSheet("Employees").some(function (e) {
        return e.job_title_id === record.id && e.status !== "TERMINATED";
      });
      if (hasEmps) return { success: false, message: "لا يمكن حذف وظيفة لها موظفون نشطون" };
      return { success: true };
    },
  },

  salaryComponent: {
    table: "SalaryComponents",
    permissionAction: "deleteSalaryComponent",
    allowHardDelete: false,
    softField: "is_active",
    softInactiveValue: "FALSE",
    dependencies: [
      { table: "EmployeeAllowances", field: "component_id", label: "بدلات مرتبطة" },
      { table: "EmployeeDeductions", field: "component_id", label: "خصومات مرتبطة" },
    ],
    customValidate: function (record) {
      var linkedAllowances = readSheet("EmployeeAllowances").some(function (a) {
        return a.component_id === record.id && a.is_active !== "FALSE";
      });
      var linkedDeductions = readSheet("EmployeeDeductions").some(function (d) {
        return d.component_id === record.id && d.is_active !== "FALSE";
      });
      if (linkedAllowances || linkedDeductions)
        return { success: false, message: "لا يمكن حذف بند مستخدم حالياً مع موظفين" };
      return { success: true };
    },
  },

  employeeAllowance: {
    table: "EmployeeAllowances",
    permissionAction: "deleteEmployeeAllowance",
    allowHardDelete: false,
    softField: "is_active",
    softInactiveValue: "FALSE",
    dependencies: [],
  },

  employeeDeduction: {
    table: "EmployeeDeductions",
    permissionAction: "deleteEmployeeDeduction",
    allowHardDelete: false,
    softField: "is_active",
    softInactiveValue: "FALSE",
    dependencies: [],
  },

  attendance: {
    table: "Attendance",
    permissionAction: "deleteAttendance",
    allowHardDelete: false, // no deleted_at column — falls back to hard delete automatically (matches legacy behavior)
    dependencies: [],
  },

  leaveType: {
    table: "LeaveTypes",
    permissionAction: "deleteLeaveType",
    allowHardDelete: false,
    softField: "is_active",
    softInactiveValue: "FALSE",
    dependencies: [],
  },

  leaveRequest: {
    table: "LeaveRequests",
    permissionAction: "deleteLeaveRequest",
    allowHardDelete: false,
    dependencies: [],
    customValidate: function (record) {
      if (record.status === "APPROVED") {
        return {
          success: false,
          message:
            "لا يمكن حذف طلب إجازة معتمد لأنه يدخل في حساب رصيد الإجازات — " +
            "ارفض الطلب بدلاً من ذلك لو لسه ممكن، أو راجع الإدارة لإلغاء إجازة معتمدة بالفعل.",
        };
      }
      return { success: true };
    },
    afterDelete: function (id, callerUser, record) {
      _hrAuditLog(
        callerUser,
        "DELETE_LEAVE_REQUEST",
        "LeaveRequests",
        id,
        "حذف طلب إجازة للموظف " + record.employee_id,
      );
    },
  },

  loanRequest: {
    table: "LoanRequests",
    permissionAction: "deleteLoanRequest",
    allowHardDelete: false,
    dependencies: [],
    customValidate: function (record) {
      if (record.status === "APPROVED" || record.status === "PAID_OFF") {
        return {
          success: false,
          message:
            "لا يمكن حذف طلب سلفة معتمد أو مسدّد لأنه مرتبط بقيد محاسبي فعلي — " +
            "راجع المحاسبة لعمل قيد عكسي لو محتاج إلغاؤه.",
        };
      }
      return { success: true };
    },
    afterDelete: function (id, callerUser, record) {
      _hrAuditLog(
        callerUser,
        "DELETE_LOAN_REQUEST",
        "LoanRequests",
        id,
        "حذف طلب سلفة للموظف " + record.employee_id,
      );
    },
  },

  payrollPeriod: {
    table: "PayrollPeriods",
    permissionAction: "deletePayrollPeriod",
    allowHardDelete: false,
    dependencies: [],
    customValidate: function (record) {
      if (record.status !== "DRAFT") {
        return { success: false, message: "لا يمكن حذف فترة معتمدة أو مصروفة" };
      }
      return { success: true };
    },
    afterDelete: function (id) {
      // Cascade-delete related payroll records (identical to the legacy
      // cascade logic).
      var prSheet = getSheet("PayrollRecords");
      var prRows = readSheet("PayrollRecords");
      var toDelete = [];
      prRows.forEach(function (r) {
        if (r.payroll_period_id === id) toDelete.push(r._row);
      });
      toDelete.sort(function (a, b) { return b - a; }).forEach(function (r) {
        prSheet.deleteRow(r);
      });
    },
  },

  employeeDocument: {
    table: "EmployeeDocuments",
    permissionAction: "deleteEmployeeDocument",
    allowHardDelete: false,
    dependencies: [],
  },

  employeeQualification: {
    table: "EmployeeQualifications",
    permissionAction: "deleteEmployeeQualification",
    allowHardDelete: false,
    dependencies: [],
    afterDelete: function (id, callerUser) {
      _hrAuditLog(
        callerUser,
        "DELETE_EMPLOYEE_QUALIFICATION",
        "EmployeeQualifications",
        id,
        "حذف مؤهل/خبرة",
      );
    },
  },

  // Invoices carry critical delete logic (inventory reversal + cost-layer
  // reversal + journal entry cancellation) that already exists and is
  // proven in Code_05b_InvoiceSoftDelete.js. customDelete here delegates to
  // that exact function without any change to its logic — the goal is
  // only a unified entry point (DeleteEngine.delete("saleInvoice", ...)),
  // not reimplementing this sensitive logic.
  saleInvoice: {
    table: "SaleInvoices",
    permissionAction: "deleteSaleInvoice",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return _coreSoftDeleteSaleInvoice(id, callerUser, sessionToken);
    },
  },

  purchaseInvoice: {
    table: "PurchaseInvoices",
    permissionAction: "deletePurchaseInvoice",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return _coreSoftDeletePurchaseInvoice(id, callerUser, sessionToken);
    },
  },

  // The entities below (user/saleReturn/purchaseReturn/vodafoneCashLine/
  // vodafoneCashTransaction, and the larger batch further down) were
  // previously deleted through separate, already-proven functions
  // (deleteUser/deleteSaleReturn/deletePurchaseReturn/
  // deleteVodafoneCashLine/deleteVodafoneCashTransaction, etc., in
  // Code_12_Core.js and Code_20_Sales.js) carrying very specific logic
  // (journal entry reversal, inventory movement reversal, protecting the
  // last admin account, ...). Exactly like saleInvoice/purchaseInvoice
  // above: customDelete fully delegates to the same legacy function
  // verbatim, with no change to its logic — DeleteEngine here only unifies
  // the entry point (DeleteEngine.delete / unifiedDelete) so any new
  // screen can delete any entity the same way, without needing to know
  // each entity's original function name.
  user: {
    table: "Users",
    permissionAction: "deleteUser",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      // deleteUser(username, callerUser, sessionToken) — same signature;
      // already performs its own permission check + BusinessRulesEngine
      // check (protecting the last admin account) internally.
      return deleteUser(id, callerUser, sessionToken);
    },
  },

  saleReturn: {
    table: "SaleReturns",
    permissionAction: "deleteSaleInvoice", // same permission as deleting a sale invoice (as in the original function)
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      // deleteSaleReturn(id, sessionToken) — derives the username from the
      // token internally and performs its own permission check + lock +
      // inventory reversal + journal entry cancellation.
      return deleteSaleReturn(id, sessionToken);
    },
  },

  purchaseReturn: {
    table: "PurchaseReturns",
    permissionAction: "deletePurchaseInvoice",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deletePurchaseReturn(id, sessionToken);
    },
  },

  vodafoneCashLine: {
    table: "VodafoneCashLines",
    permissionAction: "deleteVodafoneCashLine",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      // deleteVodafoneCashLine(id, data) — the legacy signature takes one
      // data object instead of separate parameters, so it is wrapped here
      // with no change to the function's own logic (which already checks
      // "hasTx" to prevent deleting a line with recorded transactions).
      return deleteVodafoneCashLine(id, {
        callerUser: callerUser,
        sessionToken: sessionToken,
      });
    },
  },

  vodafoneCashTransaction: {
    table: "VodafoneCashTransactions",
    permissionAction: "deleteVodafoneCashTransaction",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteVodafoneCashTransaction(id, {
        callerUser: callerUser,
        sessionToken: sessionToken,
      });
    },
  },

  // ── Remaining customDelete-delegated entities ─────────────────────
  // Same delegation principle as above: full delegation to the existing,
  // proven delete function (which already enforces permissions + locking +
  // journal/balance reversal as appropriate to each entity), with no
  // change to its logic. Grouped roughly by domain: accounting vouchers
  // first (highest financial priority), then banking/cheques, then
  // inventory/manufacturing, then admin/settings.

  // — Accounting vouchers (highest priority per the audit report) —
  receiptVoucher: {
    table: "ReceiptVouchers",
    permissionAction: "deleteReceiptVoucher",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteReceiptVoucher(id, callerUser, sessionToken);
    },
  },
  paymentVoucher: {
    table: "PaymentVouchers",
    permissionAction: "deletePaymentVoucher",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deletePaymentVoucher(id, callerUser, sessionToken);
    },
  },
  expense: {
    table: "Expenses",
    permissionAction: "deleteExpense",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteExpense(id, callerUser, sessionToken);
    },
  },
  transferVoucher: {
    table: "TransferVouchers",
    permissionAction: "deleteTransferVoucher",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteTransferVoucher(id, callerUser, sessionToken);
    },
  },
  chartAccount: {
    table: "ChartOfAccounts",
    permissionAction: "deleteChartAccount",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteChartAccount(id, callerUser, sessionToken);
    },
  },

  // — Banking / Cheques —
  bank: {
    table: "Banks",
    permissionAction: "deleteBank",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteBank(id, callerUser, sessionToken);
    },
  },
  bankAccount: {
    table: "BankAccounts",
    permissionAction: "deleteBankAccount",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteBankAccount(id, callerUser, sessionToken);
    },
  },
  chequeBook: {
    table: "ChequeBooks",
    permissionAction: "deleteChequeBook",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteChequeBook(id, callerUser, sessionToken);
    },
  },
  cheque: {
    table: "Cheques",
    permissionAction: "deleteCheque",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteCheque(id, callerUser, sessionToken);
    },
  },
  bankStatementLine: {
    table: "BankStatementLines",
    // The original function checks the "addBankReconciliation" permission
    // (not "deleteBankStatementLine") — this predates this change and is
    // kept as-is here to avoid breaking any existing permission role; it
    // should be reviewed separately.
    permissionAction: "addBankReconciliation",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteBankStatementLine(id, callerUser, sessionToken);
    },
  },
  bankReconciliation: {
    table: "BankReconciliations",
    permissionAction: "deleteBankReconciliation",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteBankReconciliation(id, callerUser, sessionToken);
    },
  },

  // — Inventory / Manufacturing —
  fixedAsset: {
    table: "FixedAssets",
    permissionAction: "addJournalEntry", // matches the original function's permission check exactly — see note above on bankStatementLine
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteFixedAsset(id, callerUser, sessionToken);
    },
  },
  employee: {
    table: "Employees",
    permissionAction: "deleteEmployee",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteEmployee(id, callerUser, sessionToken);
    },
  },
  color: {
    table: "Colors",
    permissionAction: "deleteColor",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteColor(id, callerUser, sessionToken);
    },
  },
  // "group" and "sizeGroup" were previously missing from DeleteConfig
  // entirely (a registration gap, not a misuse) even though deleteGroup/
  // deleteSizeGroup already exist with the same signature as
  // deleteColor/deleteWarehouse. Registering them here is purely additive
  // and safe: it delegates to the same legacy function unchanged
  // (customDelete) and simply opens an additional unified entry point
  // (DeleteEngine.delete("group"/"sizeGroup", ...)) without altering any
  // current UI behavior.
  group: {
    table: "Groups",
    permissionAction: "deleteGroup",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteGroup(id, callerUser, sessionToken);
    },
  },
  sizeGroup: {
    table: "SizeGroups",
    permissionAction: "deleteSizeGroup",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteSizeGroup(id, callerUser, sessionToken);
    },
  },
  size: {
    table: "Sizes",
    permissionAction: "deleteSize",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteSize(id, callerUser, sessionToken);
    },
  },
  transaction: {
    table: "Transactions",
    permissionAction: "deleteTransaction",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteTransaction(id, callerUser, sessionToken);
    },
  },
  productionOrder: {
    table: "ProductionOrders",
    permissionAction: "deleteProductionOrder",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteProductionOrder(id, callerUser, sessionToken);
    },
  },
  productionStage: {
    table: "ProductionStages",
    permissionAction: "deleteProductionStage",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteProductionStage(id, callerUser, sessionToken);
    },
  },
  stageExecution: {
    table: "StageExecutions",
    permissionAction: "deleteStageExecution",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteStageExecution(id, callerUser, sessionToken);
    },
  },
  workCenter: {
    table: "WorkCenters",
    permissionAction: "manageWorkCenters",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteWorkCenter(id, callerUser, sessionToken);
    },
  },
  machine: {
    table: "Machines",
    permissionAction: "manageWorkCenters",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteMachine(id, callerUser, sessionToken);
    },
  },
  bom: {
    table: "BOM",
    permissionAction: "manageBOM",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteBOM(id, callerUser, sessionToken);
    },
  },
  routing: {
    table: "Routings",
    permissionAction: "manageRouting",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteRouting(id, callerUser, sessionToken);
    },
  },

  // — Admin / settings —
  role: {
    table: "Roles",
    permissionAction: "manageRoles",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteRole(id, callerUser, sessionToken);
    },
  },
  weeklyReportConfig: {
    table: "WeeklyReportConfig",
    permissionAction: "manageRoles",
    allowHardDelete: false,
    dependencies: [],
    // Preserves the original parameter order exactly:
    // deleteWeeklyReportConfig(username, callerUser, sessionToken) — `id`
    // here is actually the username.
    customDelete: function (id, callerUser, sessionToken) {
      return deleteWeeklyReportConfig(id, callerUser, sessionToken);
    },
  },
  waWorkflow: {
    table: "WAWorkflows",
    permissionAction: "manageWhatsappWorkflows",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteWAWorkflow(id, callerUser, sessionToken);
    },
  },
  whatsappLog: {
    table: "WhatsAppLog",
    permissionAction: "manageWhatsappTemplates",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteWhatsappLog(id, callerUser, sessionToken);
    },
  },
  costCenter: {
    table: "CostCenters",
    permissionAction: "deleteCostCenter",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deleteCostCenter(id, callerUser, sessionToken);
    },
  },
  purchaseOrder: {
    table: "PurchaseOrders",
    permissionAction: "deletePurchaseOrder",
    allowHardDelete: false,
    dependencies: [],
    // The original deletePurchaseOrder(id, sessionToken) derives username
    // from the token internally and does not take callerUser explicitly —
    // callerUser here is deliberately ignored to preserve the exact
    // original signature.
    customDelete: function (id, callerUser, sessionToken) {
      return deletePurchaseOrder(id, sessionToken);
    },
  },
  purchaseRequest: {
    table: "PurchaseRequests",
    permissionAction: "deletePurchaseRequest",
    allowHardDelete: false,
    dependencies: [],
    customDelete: function (id, callerUser, sessionToken) {
      return deletePurchaseRequest(id, sessionToken);
    },
  },
  shipment: {
    table: "Shipments",
    permissionAction: "deleteShipment",
    allowHardDelete: false,
    dependencies: [],
    // Original parameter order is reversed: deleteShipment(callerUser, id, sessionToken)
    customDelete: function (id, callerUser, sessionToken) {
      return deleteShipment(callerUser, id, sessionToken);
    },
  },
  shippingCompany: {
    table: "ShippingCompanies",
    permissionAction: "deleteShippingCompany",
    allowHardDelete: false,
    dependencies: [],
    // The original function takes a single payload object instead of
    // separate parameters.
    customDelete: function (id, callerUser, sessionToken) {
      return deleteShippingCompany({
        id: id,
        callerUser: callerUser,
        sessionToken: sessionToken,
      });
    },
  },
  partyCategory: {
    table: "PartyCategories",
    permissionAction: "deletePartyCategory",
    allowHardDelete: false,
    dependencies: [],
    // Original parameter order: deletePartyCategory(callerUser, sessionToken, id, options)
    customDelete: function (id, callerUser, sessionToken) {
      return deletePartyCategory(callerUser, sessionToken, id);
    },
  },
});

// ════════════════════════════════════════════════════════════════════
// DependencyChecker — dynamic scan of related records for a given entity
// ════════════════════════════════════════════════════════════════════
var DependencyChecker = (function () {
  // Returns [{ table, label, count }] for every related table with matching rows.
  function scan(entityType, id) {
    var cfg = DeleteConfig[entityType];
    if (!cfg || !cfg.dependencies || !cfg.dependencies.length) return [];

    var found = [];
    cfg.dependencies.forEach(function (dep) {
      try {
        var rows = readSheet(dep.table);
        var count = rows.filter(function (r) {
          return (
            String(r[dep.field]) === String(id) &&
            !r.deleted_at // soft-deleted rows don't count as a real reference
          );
        }).length;
        if (count > 0) {
          found.push({ table: dep.table, label: dep.label, count: count });
        }
      } catch (e) {
        // Table missing or read error — skipped rather than blocking the
        // whole delete flow.
        console.warn(
          "DependencyChecker: تعذّر فحص " + dep.table + ": " + e.message,
        );
      }
    });
    return found;
  }

  function hasAny(entityType, id) {
    return scan(entityType, id).length > 0;
  }

  return { scan: scan, hasAny: hasAny };
})();

// ════════════════════════════════════════════════════════════════════
// ArchiveService — stores a full copy of a record before it is deleted
// (so it can later be restored)
// ════════════════════════════════════════════════════════════════════
var ArchiveService = (function () {
  var ARCHIVE_SHEET = "DeleteArchive";
  var ARCHIVE_HEADERS = [
    "id",
    "entity_type",
    "record_id",
    "record_data",
    "dependencies_snapshot",
    "deleted_by",
    "deleted_at",
    "delete_type",
    "restored_at",
    "restored_by",
  ];

  function _newArchiveId() {
    return "ARCH-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1000);
  }

  function archive(entityType, record, dependencies, user, deleteType) {
    var sheet = getSheet(ARCHIVE_SHEET, ARCHIVE_HEADERS);
    // Uses _appendRowProtected (lock against concurrent writes + protects
    // a record_id with a leading zero) instead of a raw appendRow.
    _appendRowProtected(sheet, ARCHIVE_HEADERS, [
      _newArchiveId(),
      entityType,
      record.id,
      JSON.stringify(record),
      JSON.stringify(dependencies || []),
      user || "SYSTEM",
      new Date().toISOString(),
      deleteType,
      "",
      "",
    ]);
  }

  // Returns the most recent archived copy of a record, if any, for use by restore().
  function findLatest(entityType, recordId) {
    var rows = readSheet(ARCHIVE_SHEET, ARCHIVE_HEADERS);
    var matches = rows.filter(function (r) {
      return (
        r.entity_type === entityType &&
        String(r.record_id) === String(recordId) &&
        !r.restored_at
      );
    });
    if (!matches.length) return null;
    matches.sort(function (a, b) {
      return new Date(b.deleted_at) - new Date(a.deleted_at);
    });
    return matches[0];
  }

  function markRestored(archiveRow, user) {
    try {
      var sheet = getSheet(ARCHIVE_SHEET, ARCHIVE_HEADERS);
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var restoredAtCol = headers.indexOf("restored_at") + 1;
      var restoredByCol = headers.indexOf("restored_by") + 1;
      if (restoredAtCol) sheet.getRange(archiveRow._row, restoredAtCol).setValue(new Date().toISOString());
      if (restoredByCol) sheet.getRange(archiveRow._row, restoredByCol).setValue(user || "SYSTEM");
    } catch (e) {
      console.warn("ArchiveService.markRestored: " + e.message);
    }
  }

  return { archive: archive, findLatest: findLatest, markRestored: markRestored };
})();

// ════════════════════════════════════════════════════════════════════
// DeleteEngine — the unified entry point for every delete operation in the system
// ════════════════════════════════════════════════════════════════════
var DeleteEngine = (function () {
  function _fail(code, message, extra) {
    return Object.assign({ success: false, code: code, message: message }, extra || {});
  }
  function _ok(message, data) {
    return { success: true, code: DELETE_RESULT.SUCCESS, message: message, data: data };
  }

  // ── Preview: data for the pre-delete confirmation dialog (performs no delete) ──
  function preview(entityType, id, callerUser, sessionToken) {
    var cfg = DeleteConfig[entityType];
    if (!cfg) return _fail(DELETE_RESULT.VALIDATION_ERROR, "نوع بيانات غير معروف: " + entityType);

    var permErr = _checkPermission(callerUser, cfg.permissionAction, sessionToken);
    if (permErr) return _fail(DELETE_RESULT.PERMISSION_DENIED, permErr.message || "لا تملك صلاحية الحذف");

    var rows = readSheet(cfg.table);
    var record = rows.find(function (r) {
      return String(r[cfg.idField || "id"]) === String(id);
    });
    if (!record) return _fail(DELETE_RESULT.NOT_FOUND, "السجل غير موجود");
    if (record.deleted_at) return _fail(DELETE_RESULT.ALREADY_DELETED, "السجل محذوف بالفعل");

    var deps = DependencyChecker.scan(entityType, id);
    var supportsSoft = true; // system-wide default
    var willHardDelete = cfg.allowHardDelete && deps.length === 0 && false; // hard delete only ever happens on an explicit forceDelete=true request

    return _ok("preview", {
      entityName: record.name || record.title || record.code || id,
      entityType: entityType,
      dependencies: deps,
      totalDependencies: deps.reduce(function (s, d) { return s + d.count; }, 0),
      deleteMode: supportsSoft ? "soft" : "hard",
      canForceHardDelete: !!cfg.allowHardDelete && deps.length === 0,
    });
  }

  // ── Delete: runs every phase in order ──
  function deleteRecord(entityType, id, callerUser, sessionToken, opts) {
    opts = opts || {};
    var startedAt = new Date().getTime();
    var cfg = DeleteConfig[entityType];

    // Phase 1: Validate request
    if (!cfg) return _fail(DELETE_RESULT.VALIDATION_ERROR, "نوع بيانات غير معروف: " + entityType);
    if (!id) return _fail(DELETE_RESULT.VALIDATION_ERROR, "المعرف (id) مطلوب");

    // Some entities (invoices) carry critical business delete logic
    // (inventory movement reversal + cost-layer reversal + journal entry
    // reversal), not just a generic soft-delete flag — so this cannot be
    // handled through afterDelete (whose failure is only logged as a
    // warning and never blocks anything, which is inappropriate here since
    // this is critical logic, not an optional cascade). When
    // cfg.customDelete is defined, it is the complete and only
    // implementation (an already-proven, pre-existing function, with no
    // change to its logic) — DeleteEngine here only unifies the entry
    // point (DeleteEngine.delete / unifiedDelete) without rewriting or
    // risking that sensitive logic.
    if (typeof cfg.customDelete === "function") {
      return cfg.customDelete(id, callerUser, sessionToken);
    }

    // Wraps the entire check-then-act path (from reading the record through
    // performing the delete) in a LockService lock, added before any real
    // screen was wired to this engine, so this race condition never became
    // an active risk the first time a screen was actually connected. The
    // lock lives here (inside deleteRecord itself) rather than in the
    // wrapper (unifiedDelete) so it also covers direct call sites like
    // deleteJournalEntry, and so a double lock/deadlock is avoided if this
    // is invoked through more than one layer in the same execution.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return _fail(DELETE_RESULT.VALIDATION_ERROR, "النظام مشغول بعملية حذف أخرى، حاول مرة أخرى");
    }
    try {
      return _deleteRecordLocked(entityType, id, callerUser, sessionToken, opts, cfg, startedAt);
    } finally {
      lock.releaseLock();
    }
  }

  function _deleteRecordLocked(entityType, id, callerUser, sessionToken, opts, cfg, startedAt) {
    var rows = readSheet(cfg.table);
    var idField = cfg.idField || "id";
    var record = rows.find(function (r) { return String(r[idField]) === String(id); });
    if (!record) return _fail(DELETE_RESULT.NOT_FOUND, "السجل غير موجود");
    if (record.deleted_at) return _fail(DELETE_RESULT.ALREADY_DELETED, "السجل محذوف بالفعل");

    // Phase 2: Permission check
    var permErr = _checkPermission(callerUser, cfg.permissionAction, sessionToken);
    if (permErr) return _fail(DELETE_RESULT.PERMISSION_DENIED, permErr.message || "لا تملك صلاحية الحذف");

    // Phase 3: Dependency scan
    var deps = DependencyChecker.scan(entityType, id);

    // Phase 4: Business rules (via the existing BusinessRulesEngine, if defined for this entity)
    if (cfg.breEntityType && typeof BusinessRulesEngine !== "undefined") {
      try {
        var bre = BusinessRulesEngine.validateBeforeDelete(cfg.breEntityType, { id: id });
        if (bre && bre.success === false) {
          return _fail(DELETE_RESULT.BUSINESS_RULE_VIOLATION, bre.message, { code: bre.code });
        }
      } catch (e) {
        return _fail(DELETE_RESULT.BUSINESS_RULE_VIOLATION, "خطأ في فحص قواعد العمل: " + e.message);
      }
    }

    // Phase 4b: Entity-specific business rules not yet migrated into
    // BusinessRulesEngine (kept here temporarily until they are
    // consolidated into BRE in a future cleanup pass) — receives the full
    // record so it can inspect fields (status/is_active/...) the same way
    // each legacy function used to do on its own.
    if (typeof cfg.customValidate === "function") {
      try {
        var custom = cfg.customValidate(record, id);
        if (custom && custom.success === false) {
          return _fail(DELETE_RESULT.BUSINESS_RULE_VIOLATION, custom.message, { code: custom.code });
        }
      } catch (e) {
        return _fail(DELETE_RESULT.BUSINESS_RULE_VIOLATION, "خطأ في فحص قواعد العمل: " + e.message);
      }
    }

    var wantsHardDelete = !!opts.hard;
    if (wantsHardDelete) {
      if (!cfg.allowHardDelete) {
        return _fail(DELETE_RESULT.BLOCKED, "الحذف النهائي غير مسموح لهذا النوع من البيانات");
      }
      if (deps.length > 0) {
        return _fail(DELETE_RESULT.DEPENDENCY_FOUND, "لا يمكن الحذف النهائي — يوجد بيانات مرتبطة", {
          dependencies: deps,
        });
      }
    } else if (deps.length > 0 && !opts.force) {
      // In the default (soft delete) mode, dependencies alone do not block
      // the delete unless Business Rules above already rejected it — they
      // are only surfaced to the caller so the confirmation dialog can
      // display them.
    }

    // Phase 6: Archive (before any actual delete)
    try {
      ArchiveService.archive(entityType, record, deps, callerUser, wantsHardDelete ? "hard" : "soft");
    } catch (e) {
      console.warn("DeleteEngine: فشل الأرشفة قبل الحذف: " + e.message);
    }

    // On a hard delete of an item, move its Drive folder (if any) into a
    // general Archive folder — identical to _deleteParty's logic. This only
    // happens on an actual hard delete (not soft), since a soft-deleted
    // record is still restorable and its folder must stay in its original
    // location. Fails completely silently — the delete itself is
    // unaffected if the Drive operation fails for any reason.
    if (entityType === "item" && wantsHardDelete && typeof DocumentEngine !== "undefined") {
      try {
        DocumentEngine.archiveItemFolder(
          String(record.code || "").trim(),
          String(record.name || "").trim(),
        );
      } catch (e) {
        console.warn("DeleteEngine: فشل أرشفة فولدر Drive للصنف: " + e.message);
      }
    }

    // Phase 5/7: Soft delete (default) or hard delete (explicit only)
    var dl;
    if (!wantsHardDelete && cfg.softField) {
      // Some HR entities (JobTitle, SalaryComponent,
      // EmployeeAllowance/Deduction, LeaveType, Department, ...) use a
      // separate flag column (e.g. is_active = "FALSE") instead of
      // deleted_at/deleted_by. This respects that exact existing
      // convention rather than forcing deleted_at onto them (which would
      // otherwise silently turn their delete into a hard delete, since
      // those tables have no deleted_at column at all).
      try {
        var sheet2 = getSheet(cfg.table);
        var headers2 = sheet2.getRange(1, 1, 1, sheet2.getLastColumn()).getValues()[0];
        var fieldCol = headers2.indexOf(cfg.softField);
        if (fieldCol === -1) {
          return _fail(DELETE_RESULT.VALIDATION_ERROR, "عمود " + cfg.softField + " غير موجود في " + cfg.table);
        }
        sheet2.getRange(record._row, fieldCol + 1).setValue(
          cfg.softInactiveValue !== undefined ? cfg.softInactiveValue : "FALSE",
        );
        dl = { success: true, id: id, hardDeleted: false };
      } catch (e) {
        return _fail(DELETE_RESULT.VALIDATION_ERROR, "خطأ أثناء الحذف: " + e.message);
      }
    } else {
      try {
        dl = DataLayerEngine.delete(cfg.table, id, {
          hard: wantsHardDelete,
          deletedBy: callerUser,
          // cfg.headers must be passed explicitly when an entity defines
          // its own headers (customer/supplier/warehouse) — because
          // DataLayerEngine._headersFor cannot automatically discover every
          // table in the system.
          headers: cfg.headers,
        });
      } catch (e) {
        return _fail(DELETE_RESULT.VALIDATION_ERROR, "خطأ أثناء الحذف: " + e.message);
      }
    }
    if (!dl || !dl.success) {
      // DataLayerEngine returns its error message under "errorMessage", not
      // "message" — previously always ignored here, returning the generic
      // "فشل الحذف" regardless of the real cause (unregistered table, sheet
      // error, ...).
      return _fail(
        DELETE_RESULT.VALIDATION_ERROR,
        (dl && (dl.errorMessage || dl.message)) || "فشل الحذف",
      );
    }

    // Optional cascade after the base delete succeeds (e.g. deleting
    // PayrollRecords linked to a payroll period). A cascade failure does
    // not fail the delete for the user — the base record is already
    // deleted and archived — it is only logged as a warning.
    if (typeof cfg.afterDelete === "function") {
      try {
        cfg.afterDelete(id, callerUser, record);
      } catch (e) {
        console.warn("DeleteEngine.afterDelete (" + entityType + "): " + e.message);
      }
    }

    // Phase 8: Logging
    try {
      AuditEngine.log(wantsHardDelete ? "HARD_DELETE_" + entityType.toUpperCase() : "SOFT_DELETE_" + entityType.toUpperCase(), {
        user: callerUser || "SYSTEM",
        table: cfg.table,
        record_id: id,
        details:
          "حذف " + (wantsHardDelete ? "نهائي" : "ناعم") + " لـ " + entityType +
          " (" + (record.name || record.code || id) + ") — ارتباطات: " + deps.length +
          " — المدة: " + (new Date().getTime() - startedAt) + "ms",
        oldValue: record,
        newValue: wantsHardDelete ? null : { deleted_at: new Date().toISOString(), deleted_by: callerUser }});
    } catch (e) {
      console.warn("DeleteEngine: فشل تسجيل التدقيق: " + e.message);
    }

    try { _invalidateServerCache(); } catch (e) { /* ignored */ }

    return _ok(
      wantsHardDelete ? " تم الحذف النهائي بنجاح" : " تم الحذف بنجاح (يمكن استعادته)",
      { id: id, hardDeleted: wantsHardDelete, dependencies: deps },
    );
  }

  // ── Restore: restores a previously soft-deleted record ──
  function restore(entityType, id, callerUser, sessionToken) {
    var cfg = DeleteConfig[entityType];
    if (!cfg) return _fail(DELETE_RESULT.VALIDATION_ERROR, "نوع بيانات غير معروف: " + entityType);

    var permErr = _checkPermission(callerUser, cfg.permissionAction, sessionToken);
    if (permErr) return _fail(DELETE_RESULT.PERMISSION_DENIED, permErr.message || "لا تملك صلاحية الاستعادة");

    // Same locking pattern added to deleteRecord — this "read record._row
    // then write to it" path was also previously unlocked, before any real
    // screen was wired to this engine.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return _fail(DELETE_RESULT.VALIDATION_ERROR, "النظام مشغول بعملية أخرى، حاول مرة أخرى");
    }
    try {
      var sheet = getSheet(cfg.table);
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var rows = readSheet(cfg.table);
      var idField = cfg.idField || "id";
      var record = rows.find(function (r) { return String(r[idField]) === String(id); });

      var archived = ArchiveService.findLatest(entityType, id);

      if (record) {
        // The record still exists in the sheet (soft delete) — just clear
        // the delete flag.
        if (!record.deleted_at) return _fail(DELETE_RESULT.VALIDATION_ERROR, "السجل غير محذوف أصلاً");
        var delAtCol = headers.indexOf("deleted_at") + 1;
        var delByCol = headers.indexOf("deleted_by") + 1;
        if (delAtCol) sheet.getRange(record._row, delAtCol).clearContent();
        if (delByCol) sheet.getRange(record._row, delByCol).clearContent();
      } else {
        // The record was actually hard-deleted (tables with no deleted_at,
        // e.g. Customers/Suppliers) — the only possible restore is
        // re-inserting the archived copy as a new record with the same id.
        if (!archived) return _fail(DELETE_RESULT.NOT_FOUND, "السجل غير موجود ولا يوجد أرشيف له");
        var savedData = JSON.parse(archived.record_data);
        var row = headers.map(function (h) {
          return Object.prototype.hasOwnProperty.call(savedData, h) ? savedData[h] : "";
        });
        // Uses _appendRowProtected instead of a raw appendRow — this is the
        // riskiest point in the whole flow: it writes back archived data
        // (codes/phone numbers) as a new record without '@' format
        // protection, which could otherwise silently drop a leading zero
        // after restore.
        _appendRowProtected(sheet, headers, row);
      }

      if (archived) ArchiveService.markRestored(archived, callerUser);

      try {
        AuditEngine.log("RESTORE_" + entityType.toUpperCase(), {
          user: callerUser || "SYSTEM",
          table: cfg.table,
          record_id: id,
          details: "استعادة " + entityType + " محذوف: " + ((record && (record.name || record.code)) || id)});
      } catch (e) { /* ignored */ }

      try { _invalidateServerCache(); } catch (e) { /* ignored */ }

      return _ok(" تم الاستعادة بنجاح", { id: id });
    } finally {
      lock.releaseLock();
    }
  }

  return {
    delete: deleteRecord,
    preview: preview,
    restore: restore,
    config: DeleteConfig, // read-only reference — modify by editing DeleteConfig directly
  };
})();

// ════════════════════════════════════════════════════════════════════
// UI-facing entry points (google.script.run) — intended to gradually
// replace the many separate deleteX functions in a future phase. No
// screen currently calls these yet; this phase only builds the engine
// without touching any existing delete function.
// ════════════════════════════════════════════════════════════════════
function unifiedDeletePreview(entityType, id, callerUser, sessionToken) {
  try {
    return DeleteEngine.preview(entityType, id, callerUser, sessionToken);
  } catch (e) {
    return { success: false, code: "ENGINE_ERROR", message: "خطأ: " + e.message };
  }
}

function unifiedDelete(entityType, id, callerUser, sessionToken, opts) {
  try {
    return DeleteEngine.delete(entityType, id, callerUser, sessionToken, opts || {});
  } catch (e) {
    return { success: false, code: "ENGINE_ERROR", message: "خطأ: " + e.message };
  }
}

function unifiedRestore(entityType, id, callerUser, sessionToken) {
  try {
    return DeleteEngine.restore(entityType, id, callerUser, sessionToken);
  } catch (e) {
    return { success: false, code: "ENGINE_ERROR", message: "خطأ: " + e.message };
  }
}
