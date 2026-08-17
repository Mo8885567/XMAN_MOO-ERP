/**
 * ============================================================
 * Module: Code_Core.gs
 *
 * Description:
 *   The central backend core of MOO.ERP. Contains Google Apps Script
 *   entry points (doGet/doPost), the auth and session subsystem,
 *   user CRUD, audit logging, the backup system, the Google Sheets
 *   access layer (getSheet/readSheet), server-side caching, and the
 *   consolidated data aggregation (getAllData/getAllDataExtended)
 *   used as the frontend's primary data source.
 *
 * Responsibilities:
 *   - Bootstrap: global constants (per-sheet HEADERS), the allowlist
 *     of functions callable via HTTP POST.
 *   - Entry Points: doGet (page load) and doPost (action execution).
 *   - Auth: login, sessions (create/validate/refresh/destroy), rate
 *     limiting on failed login attempts, password policy.
 *   - Users CRUD: add/update/delete users, propagating name changes
 *     across related records.
 *   - Audit Log: write/read/export/archive of the audit trail.
 *   - Backup: manual and scheduled backups.
 *   - Sheet Utilities: safe read/write against Google Sheets
 *     (protecting text columns from leading-zero loss, sheet caching).
 *   - Server Cache: caching getAllData in CacheService to reduce
 *     load time.
 *   - Catalog Public: preparing public catalog data (no auth required).
 *
 * Dependencies:
 *   - Code_Permissions.gs (the _checkPermission check used by most
 *     functions here and across all other Code_*.gs modules).
 *   - Google Apps Script services: SpreadsheetApp, CacheService,
 *     PropertiesService, LockService, MailApp, Utilities.
 *
 * Used By:
 *   - All other Code_*.gs files (depend on getSheet/readSheet and
 *     sessions).
 *   - All frontend files (*.html) via doPost/doGet and getAllData.
 *
 * Author:
 *   MOO.ERP Development Team
 *
 * Last Refactored:
 *   2026-07-04 — Full comment reorganization and documentation
 *   (comment refactoring only). No behavior or logic changed — see
 *   the internal review report at the end of the file.
 *
 * ============================================================
 */

// ════════════════════════════════════════════════════════════════
// Section 1: Bootstrap — global constants and entry-point allowlist
// ════════════════════════════════════════════════════════════════
// Original source: Code.js lines 1-2071 (before the large file was
// split into separate modules). Covers: the list of functions
// allowed to be called over HTTP, the doGet/doPost functions, the
// per-sheet column header (HEADERS) definitions, safe read/write
// utilities against Sheets, validation functions, and auth helper
// utilities (hashing/salt).

/**
 * [SEC-FIX-1] An explicit allowlist of function names permitted to be
 * invoked via doPost (any HTTP POST request reaching the script,
 * including some google.script.run calls that route through this
 * path).
 *
 * IMPORTANT:
 *   Before this fix, doPost allowed execution of ANY function in the
 *   project, including sensitive internal ones (e.g. _hashPassword or
 *   setupSecurityUpgrades) — a critical security hole allowing
 *   unintended code execution just by knowing the function name. The
 *   fix: restrict execution to this list only.
 *
 * WARNING:
 *   Any new function meant to be callable via the doPost path must be
 *   added here explicitly, or the request will be rejected with an
 *   error.
 */
var DOPOST_ALLOWED_FUNCTIONS = [
  // [VERCEL-MIGRATION][AUDIT] These functions used to work before
  // because the original google.script.run is direct RPC (never
  // passes through doPost at all), so nobody noticed they were
  // missing from the allowlist. Surfaced by an audit script that
  // compared every actual google.script.run.X() call across the 22
  // HTML files against this list. Without them, these screens would
  // throw "Function not permitted" as soon as they were converted to
  // client.js:
  "getLazyAppBundle", // 01_JS_Core_Auth.html
  "getLazyBundleCss", // [PERF-CHUNK-FIX]
  "getLazyBundleMeta", // [PERF-CHUNK-FIX]
  "getLazyBundleChunk", // [PERF-CHUNK-FIX]
  "ping", // 31_JS_DataLayer.html (DL.debug.ping) + client.js (GAS.ping)
  // [VERCEL-MIGRATION][AUDIT-2] Additional gaps surfaced from
  // audit-allowlist.js after a full gas-src scan — all of these
  // functions are actually defined in the backend and are called
  // from the frontend via _gsr(), but were missing from the
  // allowlist (same reason: they used to work because the original
  // google.script.run is direct RPC, not routed through doPost):
  "addUnit", // Code_55_Units.js ← 03_JS_Dashboard_Items.html
  "deleteUnit", // Code_55_Units.js ← 03_JS_Dashboard_Items.html (via 07_JS_Shipping_Colors_Excel.html)
  "deleteSizeGroup", // Code_16_Inventory.js ← 07_JS_Shipping_Colors_Excel.html
  "getAllDataByLevel", // Code_53_DataRegistryEngine.js ← 31_JS_DataLayer.html, 52_JS_LoadingEngine.html
  "getDocumentEngineStorageStats", // Code_50_DocumentEngine.js ← 08_JS_Users_Branding.html
  "getItemAccountingDefaults", // Code_19_PostingConfig.js ← 03_JS_Dashboard_Items.html
  "getItemWarehouseIds", // Code_16_Inventory.js ← 03_JS_Dashboard_Items.html
  "getNextBankAccountCode", // Code_09_Banking.js ← 11_JS_Accounting.html
  "getNextCashBoxCode", // Code_01_Accounting_CashBoxes.js ← 11_JS_Accounting.html
  "getNextCustomerCode", // Code_20a_Parties.js ← 10_JS_Settings_Search_Parties.html
  "getNextDepartmentCode", // Code_15_HR.js ← 12_JS_HR.html
  "getNextEmployeeNumber", // Code_15_HR.js ← 12_JS_HR.html
  "getNextItemCode", // Code_16_Inventory.js ← 03_JS_Dashboard_Items.html
  "getNextJobTitleCode", // Code_15_HR.js ← 12_JS_HR.html
  "getNextShippingCompanyCode", // Code_22_Shipping.js ← 07_JS_Shipping_Colors_Excel.html
  "getNextSupplierCode", // Code_20a_Parties.js ← 10_JS_Settings_Search_Parties.html
  "getNextWarehouseCode", // Code_16_Inventory.js ← 07_JS_Shipping_Colors_Excel.html
  "logClientNotification", // Code_47_AuditEngine.js ← 44_JS_NotificationEngine.html
  "logReportAction", // Code_47_AuditEngine.js ← 46_JS_ReportEngine.html
  "queryReportAggregate", // Code_26_ReportDataLayer.js ← 33_JS_ReportDataLayer.html
  "queryReportEntity", // Code_26_ReportDataLayer.js ← 33_JS_ReportDataLayer.html
  "searchAccountsLookup", // Code_02_Accounting_ChartOfAccounts.js ← Templates_07.html
  "uploadItemImage", // Code_16_Inventory.js ← 03_JS_Dashboard_Items.html
  // [VERCEL-MIGRATION][AUDIT-3] These two functions were being called
  // from the frontend (11_JS_Accounting.html, 12_JS_HR.html) but were
  // never defined in the backend at all — they have now been built
  // (Code_06_Accounting_Vouchers.js, Code_15_HR.js) after explicit
  // review with the user:
  "printVoucher", // Code_06_Accounting_Vouchers.js ← 11_JS_Accounting.html (PDF حقيقي عبر _htmlToPdf/_uploadPdfToDrive)
  "getMonthlyAttendanceReport", // Code_15_HR.js ← 12_JS_HR.html
  "exportAuditLogCSV", // 08_JS_Users_Branding.html
  "getPermissionMatrix", // 08_JS_Users_Branding.html
  "getTriggerStatus", // 07_JS_Shipping_Colors_Excel.html
  "removeWeeklyTrigger", // 07_JS_Shipping_Colors_Excel.html
  "resolveColorsBatch", // 07_JS_Shipping_Colors_Excel.html
  "sendWeeklyReportsPDF", // 07_JS_Shipping_Colors_Excel.html
  "setupWeeklyTrigger", // 07_JS_Shipping_Colors_Excel.html
  "testWeeklyReportPDF", // 07_JS_Shipping_Colors_Excel.html
  "uploadImageToDrive", // 05_JS_Production.html
  // [VERCEL-MIGRATION][AUDIT-2] These functions surfaced from the
  // audit-allowlist.js script (updated after spotting the _gsr()
  // pattern in 31_JS_DataLayer.html, which was called dynamically and
  // slipped past the first audit). Each one actually exists as a
  // backend function (verified by matching "function X(" across every
  // .js file) — without them these screens (HR, PartyCategories,
  // WhatsApp Gateway, Backup, Update Management, Attendance Import,
  // Demo Data Generator...) would throw "Function not permitted" as
  // soon as they were converted to client.js:
  "acknowledgeEmployeePolicy",
  "addPartyAddress",
  "addPartyCategory",
  "addPartyDocument",
  "deleteAttendanceImport",
  "deleteEmployeeQualification",
  "deleteLeaveRequest",
  "deleteLoanRequest",
  "deletePartyAddress",
  "deletePartyCategory",
  "deletePartyDocument",
  "deletePayrollPeriod",
  "deleteSalaryComponent",
  "deleteWhatsappLog",
  "demoGen_createCollectionsAndPayments",
  "demoGen_createCustomers",
  "demoGen_createGroups",
  "demoGen_createItems",
  "demoGen_createOpeningStock",
  "demoGen_createProductionOrders",
  "demoGen_createPurchaseInvoices",
  "demoGen_createSalesInvoices",
  "demoGen_createSuppliers",
  "demoGen_createUsers",
  "demoGen_createWarehouses",
  "demoGen_finalize",
  "demoGen_listBatches",
  "demoGen_start",
  "demoGen_wipeAll",
  "exportJournalEntryPdf",
  "getAboutPageData",
  "getActiveBanner",
  "getAllDataFresh",
  "getAttendanceImportDetail",
  "getAttendanceImportLog",
  "getAttendanceImportStats",
  "getEmployeePolicyContent",
  "getEmployeeQualifications",
  "getNotificationCenterFeed",
  "getPartyAddresses",
  "getPartyCategories",
  "getPartyCategoryDefaults",
  "getPartyCategoryStats",
  "getPartyCategoryTree",
  "getPartyDocuments",
  "getSalaryComponents",
  "getUpdateCategories",
  "getWhatsNew",
  "getWhatsappGatewayConfig",
  "getWhatsappGatewayStatus",
  "importAttendanceBatch",
  "importEmployeesBulk",
  "logoutWhatsappGateway",
  "movePartyCategory",
  "postPartyOpeningBalance",
  "recordAnnouncementAction",
  "recordVersionAction",
  "renameUser",
  "reportInstalledVersionOnLogin",
  "requestPasswordReset",
  "resetPasswordWithToken",
  "reverseJournalEntry",
  "saveWhatsappGatewayConfig",
  "setBackupUserFolder",
  "setDefaultPartyAddress",
  "setupBackupTrigger",
  "updatePartyAddress",
  "updatePartyCategory",
  "uploadPartyDocument",
  "uploadWAAttachment",
  "verifyPasswordResetOtp",
  // Communication Hub — see Code_CommunicationHub.gs +
  // Code_CommHub_Providers.gs (note: the webhook receiver itself never
  // routes through here at all — it's intercepted in doPost via
  // payload.hub_event === true before reaching this list)
  "getCommHubProviders",
  "saveCommHubProvider",
  "getCommHubSettings",
  "saveCommHubSettings",
  "getCommHubConversations",
  "getCommHubMessages",
  "commHubSendMessage",
  "commHubResolveSuggestedReply",
  "updateCommHubConversation",
  "markCommHubConversationRead",
  "getCommHubDashboard",
  "commHubReconnectProvider",
  // [FIX-AUDIT-2026] WA Workflows — the screen was calling functions
  // that didn't exist at all
  "getWAWorkflows",
  "saveWAWorkflow",
  "deleteWAWorkflow",
  // Auth
  "login",
  "loginWithData",
  "loginLite",
  "logout",
  "validateSession",
  "refreshSession",
  "changeForcedPassword", // ← [FORCE-PW-1] requires a valid sessionToken among the args (not public)
  // Read - Public/Catalog
  "getCatalogPublicData",
  // Read - Data
  "getAllData",
  "getAllDataLight",
  "getUsers",
  "getUserPermissions",
  "getActiveSessions",
  "getScriptUrl",
  // Groups
  "addGroup",
  "updateGroup",
  "deleteGroup",
  "deleteGroupCascade", // GROUP-HIERARCHY P7
  "getGroupsTree", // GROUP-HIERARCHY P1
  // Warehouses
  "addWarehouse",
  "updateWarehouse",
  "deleteWarehouse",
  // [FIX-AUDIT] "getWarehouseAccess"/"setWarehouseAccess" removed — no functions with this
  // name exist. The actual functions getUserWarehouseAccess/saveWarehouseAccess exist in
  // Code_Core.gs but **have zero calls from any HTML file** — the "warehouse-level
  // permission control" feature (§18-WH) currently appears entirely disconnected from the UI.
  // Worth a decision: either wire it to a real screen or delete it if no longer needed.
  // Colors
  "addColor",
  "updateColor",
  "deleteColor",
  // [FIX-AUDIT] "resolveColorHexBatch" removed — no definition exists anywhere in the
  // project and no UI calls it. The actual function that exists and is used
  // is resolveColorHex (singular).
  // Sizes
  "getSizes",
  "addSize",
  "updateSize",
  "deleteSize",
  // Items
  "addItem",
  "updateItem",
  "deleteItem",
  "forceDeleteItem",
  "restoreItem",
  "getDeletedItems",
  "saveItemWithColorSync",
  "importItemsFromExcel",
  // ── §IMPORT-ENGINE — the professional import wizard (IMP-WIZARD-V1) ──
  "analyzeImportStructure",
  "validateImportRows",
  "commitImportBatch",
  "logImportOperation",
  "getImportLogs",
  // Transactions
  "addTransaction",
  "updateTransaction",
  "deleteTransaction",
  "addBatchTransaction", // [P9-FIX] was missing from the allowlist
  // [FIX-AUDIT] "batchAddTransactions" removed — no definition exists; the
  // actual function used to record a batch of transactions is addBatchTransaction (singular).
  // [FIX-AUDIT] "transferStock" removed — no function with this name exists in the project
  // (stock transfer between warehouses, if needed, is currently implemented via addTransaction
  // with movement type TRANSFER, not a standalone function).
  // Production
  "addProductionOrder",
  "updateProductionOrder",
  "deleteProductionOrder",
  "updateProductionOrderStatus", // [P9-FIX] was missing from the allowlist
  // ── §MFG-P0 Manufacturing module — Work Centers & Machines (Phase 1 Step 1) ──
  "getWorkCenters",
  "addWorkCenter",
  "updateWorkCenter",
  "deleteWorkCenter",
  "getMachines",
  "addMachine",
  "updateMachine",
  "deleteMachine",
  // ── §MFG-BOM Manufacturing module — Bills of Materials (BOM) — Phase 1 Step 2 ──
  "getBOMs",
  "getBOMLines",
  "addBOM",
  "updateBOM",
  "deleteBOM",
  // ── §MFG-ROUTING Manufacturing module — Routing — Phase 1 Step 3 ──
  "getRoutings",
  "getRoutingOperations",
  "addRouting",
  "updateRouting",
  "deleteRouting",
  // [FIX-AUDIT] "setupManufacturingSheets" removed from the allowlist — a one-time setup
  // function with no button or call from any UI. Runs manually from the
  // Apps Script Editor or as part of setupEverything() only (same logic as setupAllSheets
  // which was removed in the previous batch).
  "saveCuttingData", // [P9-FIX] was missing from the allowlist
  // [FIX-AUDIT] "closePO" removed — no function with this name exists. [Later update] Cancelling
  // a purchase order is now actually implemented via "cancelPurchaseOrder" (the first real use
  // of WorkflowEngine.transition() — see Code_27_PurchaseOrders.gs).
  // [FIX-AUDIT] "getCuttingData" removed — no definition exists; only
  // saveCuttingData actually exists (no matching read function yet).
  // Stock & Reports
  "getStockReport",
  // [FIX-AUDIT] "getStockValue" removed — no definition exists and no UI uses it.
  // [FIX-AUDIT] "getLowStockItems" removed — no public function with this name exists;
  // only the internal _aiTool_getLowStock used by the AI assistant exists.
  "getDashboardStats",
  "getTransactionStatement", // [FIX-AUDIT] was listed here as a phantom; now a real function (see getItemStatement)
  "postStocktakeSession",
  "importOpeningStockBulk", // [P9-FIX] was missing from the allowlist
  // Users
  "addUser",
  "updateUser",
  "deleteUser",
  // [FIX-AUDIT] "updateUserName" removed — no function with this name exists; changing a
  // user's name goes through updateUser itself (which calls _propagateUserNameChange internally).
  "setAdminAlertEmail",
  // [FIX-AUDIT] "setUserPermissionOverrides" was misspelled here and matched no function —
  // the correct name actually used by 08_JS_Users_Branding.html is:
  "saveUserPermissionOverrides",
  "getUserPermissionOverrides",
  // Audit & Backup
  "getAuditLog",
  "clearAuditLog",
  // [FIX-AUDIT] "exportAuditLog" removed — no function with this name exists. The actual
  // function exportAuditLogCSV is called from 08_JS_Users_Branding.html via direct
  // google.script.run (not through _gsr/doPost), so it doesn't need to be in this allowlist at all.
  // [FIX-AUDIT] "setupAuditLogTrimTrigger" removed from here — a one-time setup function
  // run manually from the Apps Script Editor only (no UI calls it at all),
  // and it had no permission check whatsoever, i.e. it was reachable via doPost by any external party with no login.
  "archiveAndTrimAuditLog",
  "createBackup",
  "getBackupStatus",
  "listBackupFiles", // [BACKUP-ENGINE-v5] was called from the UI with no definition at all
  "restoreFromBackup", // [BACKUP-ENGINE-v5] was called from the UI with no definition at all
  // File Upload
  "uploadFile",
  // Shipments
  "addShipment",
  "updateShipment",
  "deleteShipment",
  "updateShipmentStatus",
  // [FIX-AUDIT] "setupShipmentsSheet" and "setupSaleInvoicesSheet" were removed from
  // the allowlist for the same reason — one-time setup functions with no UI button.
  // 2026-07-04 update: confirmed (zero calls from any file) that "setupShipmentsSheet"
  // was genuine dead code, so it was permanently deleted from the code. "setupSaleInvoicesSheet"
  // is still an intentional manual setup function (documented in Code_Shipping.gs, run manually
  // from the Apps Script Editor when needed) — left as-is.
  // Shipping Phase 3 — Sales Integration
  "calcShippingCost",
  "linkShipmentToInvoice",
  "getInvoicesForShipping",
  // Shipping Phase 4 — Accounting
  "autoJournalFromShipment",
  // Shipping Phase 5 — Tracking & Notifications
  "sendShipmentNotification",
  "updateShipmentStatusWithAccounting",
  // Shipping Companies
  "getShippingCompanies",
  "addShippingCompany",
  "updateShippingCompany",
  "deleteShippingCompany",
  // Weekly Reports
  // [FIX-AUDIT] "buildWeeklyReport"/"sendWeeklyReport" removed — no functions
  // with these names exist. The actual function sendWeeklyReportsPDF is called from
  // 07_JS_Shipping_Colors_Excel.html via direct google.script.run.
  "saveWeeklyReportConfig", // [P9-FIX] was missing from the allowlist
  "deleteWeeklyReportConfig", // [P9-FIX] was missing from the allowlist
  "getWeeklyReportConfigs",
  // Misc
  "resolveColorHex",
  "getOpeningStock",
  "saveOpeningStock",
  "postOpeningStockJournal", // [OB-JOURNAL-UI] posts the opening-stock journal entry from the opening-balances screen button
  // AI Proxy (SEC-FIX-5)
  "proxyGroqChat",
  // AI Agent v6 — Tool Calling + Rate Limiting + Audit
  "proxyAIAgent",
  "getAIRateLimitStatus",
  // TTS Proxy (SEC-FIX-TTS-1) — keys stay server-side only
  "proxyElevenLabsTTS",
  "proxyGeminiTTS",
  // ── ERP v5: Accounting ──
  "getChartAccounts",
  "addChartAccount",
  "updateChartAccount",
  "deleteChartAccount",
  "getCashBoxes",
  "addCashBox",
  "updateCashBox",
  "deleteCashBox",
  "getBankAccounts",
  "addBankAccount",
  "updateBankAccount",
  "deleteBankAccount",
  // ── Banking Module — Phase 1: Banks ──
  "getBanks",
  "addBank",
  "updateBank",
  "deleteBank",
  // ── Banking Module — Phase 2: Cheque Books ──
  "getChequeBooks",
  "addChequeBook",
  "updateChequeBook",
  "deleteChequeBook",
  // ── Banking Module — Phase 3: Cheque Management ──
  "getCheques",
  "addCheque",
  "updateCheque",
  "deleteCheque",
  // ── Banking Module — Phase 4: Cheque Lifecycle ──
  "changeChequeStatus",
  "getChequeTimeline",
  "getJournalEntries",
  "addJournalEntry",
  "updateJournalEntry",
  "deleteJournalEntry",
  "postJournalEntry",
  "cancelJournalEntry", // [FIX-ISSUE-022] was missing — the journal-entry cancellation feature was disabled
  "getJournalEntryLines",
  "getReceiptVouchers",
  "addReceiptVoucher",
  "approveReceiptVoucher",
  "cancelReceiptVoucher",
  "getPaymentVouchers",
  "addPaymentVoucher",
  "approvePaymentVoucher",
  "cancelPaymentVoucher",
  "getTransferVouchers",
  "addTransferVoucher",
  "approveTransferVoucher",
  "cancelTransferVoucher",
  "getGeneralLedger",
  "getTrialBalance",
  "getIncomeStatement",
  "getBalanceSheet",
  "getAccountStatement",
  "getCashFlowStatement",
  // [FIX-AUDIT] "getAccountingDashboardStats" removed — no definition exists;
  // only the generic getDashboardStats exists currently (not accounting-specific).
  "getExpenses",
  "addExpense",
  "updateExpense",
  "deleteExpense",
  "approveExpense",
  "cancelExpense",
  // ── ERP v5: HR ──
  "getDepartments",
  "addDepartment",
  "updateDepartment",
  "deleteDepartment",
  "getJobTitles",
  "addJobTitle",
  "updateJobTitle",
  "deleteJobTitle",
  "getEmployees",
  "getEmployee",
  "addEmployee",
  "updateEmployee",
  "deleteEmployee",
  "getEmployeeAllowances",
  "addEmployeeAllowance",
  "updateEmployeeAllowance",
  "deleteEmployeeAllowance",
  "getEmployeeJobHistory", // [REMEDIATION-6]
  "getEmployeeDeductions",
  "addEmployeeDeduction",
  "updateEmployeeDeduction",
  "deleteEmployeeDeduction",
  "getAttendance",
  "addAttendance",
  "updateAttendance",
  "deleteAttendance",
  "getLeaveTypes",
  "addLeaveType",
  "updateLeaveType", // [FIX-AUDIT] was called from the UI with no backend function or whitelist entry
  // [FIX-ISSUE-026] "updateLeaveType" removed — the function wasn't defined in Code.js (gave "Unknown function")
  "deleteLeaveType",
  "getLeaveRequests",
  "addLeaveRequest",
  "approveLeaveRequest",
  "getEmployeeLeaveBalance", // [FIX-AUDIT-2026] the screen was calling it with no implementation
  "rejectLeaveRequest",
  "getLoanRequests",
  "addLoanRequest",
  "approveLoanRequest",
  "rejectLoanRequest",
  "recordLoanPayment", // [FIX-ISSUE-027] was missing — recording loan installments didn't work from the frontend
  "getPayrollPeriods",
  "addPayrollPeriod",
  "generatePayroll",
  "approvePayroll",
  "payPayroll",
  "getPayrollRecords",
  "getPayslip",
  "getEmployeeDocuments",
  "uploadEmployeeDocument",
  "deleteEmployeeDocument",
  "getHRDashboardStats",
  "getAllDataExtended",
  "getAllDataExtendedCore", // [PERF-SPLIT] the fast part of the extended data bundle
  "getAllDataExtendedLazy", // [LEGACY-COMPAT] wrapper over acc+hr (see the two functions below)
  "getAccountingExtendedLazy", // [PERF-SPLIT-2026-07-28] accounting domain only
  "getHRExtendedLazy", // [PERF-SPLIT-2026-07-28] HR/production domain only
  "getFinanceSummaryLight", // [FIX-2026-08-08] was missing from the whitelist, causing the finance cards on the executive dashboard to stay stuck loading forever
  // [FIX-AUDIT] "setupAllSheets" removed from here — a one-time setup function run
  // manually from the Apps Script Editor only (no UI calls it), and it had
  // no permission check whatsoever, i.e. reachable via doPost by any external party with no login.
  // ── Production Stages ──
  "getProductionStages",
  "addProductionStage",
  "updateProductionStage",
  "deleteProductionStage",
  "getStageExecutions",
  "addStageExecution",
  "deleteStageExecution",
  "approveStageExecution", // [REMEDIATION-7]
  // ── ERP v5: Parties — Customers & Suppliers ──
  "getCustomers",
  "addCustomer",
  "updateCustomer",
  "deleteCustomer",
  "isCustomerCodeDuplicate", // [PARTY-VALIDATION] real-time check for duplicate customer code (VF.checkDuplicate)
  "getSuppliers",
  "addSupplier",
  "updateSupplier",
  "deleteSupplier",
  "isSupplierCodeDuplicate", // [PARITY-CUST] real-time check for duplicate supplier code (VF.checkDuplicate)
  "getPartyMovements",
  "getPartyQuickCard",
  "linkPartyDualRole", // §BP-P5 — acts as both customer and supplier
  "adjustPartyLoyaltyPointsAPI", // §BP-P5 — loyalty points
  "getAgingReport",
  "getCashReconciliation",
  "runAccountingIntegrityCheck",
  // [FIX-AUDIT] "runERPReadinessAudit" removed — no definition exists; the
  // actual one is getSystemReadinessStatus (which also isn't used from any UI currently,
  // apparently run manually).
  "getSystemReadinessStatus",
  "getCashFlowStatementV2",
  "getUnpaidInvoicesForCustomer",
  "diagPartyMovements", // [FIX-AUDIT] was listed as a phantom; now a real function (see definition below)
  // ── Settings ──
  "clearServerCache",
  "saveCompanySettings",
  "testDeviceConnection",
  "fetchDeviceAttendance",
  "fetchDeviceEmployees",
  "setDeviceSchedule",
  "getSaleInvoices",
  "getPurchaseInvoices",
  "addSaleInvoice",
  "addPurchaseInvoice",
  "deleteSaleInvoice",
  "deletePurchaseInvoice",
  "getSaleReturns",
  "getPurchaseReturns",
  "addSaleReturn",
  "addPurchaseReturn",
  "deleteSaleReturn",
  "deletePurchaseReturn",
  // ── Purchase Orders ──
  "getPurchaseOrders",
  "savePurchaseOrder",
  "updatePurchaseOrder",
  "deletePurchaseOrder",
  "approvePurchaseOrder",
  "receivePurchaseOrder",
  "cancelPurchaseOrder",
  // ── Internal Purchase Requests ──
  "getPurchaseRequests",
  "savePurchaseRequest",
  "updatePurchaseRequest",
  "approvePurchaseRequest",
  "rejectPurchaseRequest",
  "cancelPurchaseRequest",
  "deletePurchaseRequest",
  "convertPurchaseRequestToPO",
  // ── Vodafone Cash / Wallets Operations Center ──
  // [FIX-AUDIT] "getWalletProviders" removed from the allowlist — leftover from an old
  // multi-provider wallet design, before the module moved to the current dedicated
  // Vodafone Cash screen (16_JS_VodafoneCash.html) which uses completely different
  // functions. 2026-07-04 update: confirmed (zero calls from any file) it was
  // genuine dead code, so the function itself was permanently deleted from the code (was in Code_Sales.gs).
  "getVodafoneCashLines",
  "getVodafoneCashLineDetail",
  "getVodafoneCashTransactions",
  "getVodafoneCashDashboardStats",
  "getVodafoneCashAllData",
  "getVodafoneCashInsights",
  "getVodafoneCashAlerts",
  "addVodafoneCashLine",
  "updateVodafoneCashLine",
  "deleteVodafoneCashLine",
  "setVodafoneCashLineStatus",
  "setVodafoneCashLineLimits",
  // [FIX-AUDIT] "setVodafoneCashLineParty" removed for the same reason — a function from the
  // old design linking a line to a customer/supplier (party) record. The current screen stores
  // the customer name and phone number directly as fields on the line itself (customer_name/vf_number),
  // with no link to the Parties table, so this function became unused.
  "addVodafoneCashTransaction",
  "updateVodafoneCashTransactionStatus",
  "deleteVodafoneCashTransaction",
  // ── [FIX-ALLOWLIST] functions the frontend needs but were missing from the allowlist ──
  "getRoles",
  "saveRole",
  "deleteRole",
  "deletePaymentVoucher",
  "deleteReceiptVoucher",
  "deleteTransferVoucher",
  "logWhatsappSend",
  "getWhatsappLogs",
  "logPublicCatalogWhatsapp",
  // ── WA Center ──
  "getWAUnreadCount",
  "getWAConversations",
  "getWAMessages",
  "saveWAMessage",
  "getWACustomerData",
  "markWAMessagesRead",
  "deleteWAConversation",
  // ── [FIX-SAVE-WRAPPERS] unified save wrappers (add+update) ──
  "saveAttendance",
  "saveBankAccount",
  "saveCashBox",
  "saveChartAccount",
  "saveCustomer",
  "saveDepartment",
  "saveEmployee",
  "saveExpense",
  "saveItem",
  "saveJobTitle",
  "saveJournalEntry",
  "saveLeaveRequest",
  "saveLoanRequest",
  "savePaymentVoucher",
  "savePayrollPeriod",
  "saveProductionStage",
  "savePurchaseInvoice",
  "saveReceiptVoucher",
  "saveSaleInvoice",
  "saveSupplier",
  "saveTransaction",
  "saveTransferVoucher",
  "saveUser",
  // ── [FIX-FUTURE] functions defined in DataLayer for future use ──
  "getPartyLedger",
  "getItemStatement",
  "getAggregatedReport",
  "approvePayrollPeriod",
  // ── Phase 2: Accounting Periods (Fiscal Periods) ──

  "getAccountingPeriods",

  "addAccountingPeriod",

  "updateAccountingPeriodStatus",

  "autoCreateFiscalPeriods",

  // ── Phase 2: Inventory Costing (StockLots) ──

  "getInventoryValuation",

  "addInventoryAdjustmentWithCosting",

  // ── Phase 2: Soft Delete ──

  "softDeleteSaleInvoice",

  "softDeletePurchaseInvoice",

  "softDeleteJournalEntry",

  // ── Phase 2: Reporting & Validation ──

  "getSaleInvoicesActive",

  "getPurchaseInvoicesActive",

  "runPhase2AccountingValidation",

  "postOpeningBalanceJournalP2",

  // [FIX-AUDIT] "migratePhase2" and "setupPhase2Sheets" removed from the allowlist —
  // one-time setup/migration functions; setupPhase2Sheets itself runs internally as a step
  // within setupEverything() (see step("setupPhase2Sheets"...)), and there's no need
  // to expose it directly over HTTP.

  // ── §POSTING-CONFIG: account-linking settings ──
  "getAccountingSettings",
  "saveAccountingSetting",
  "saveAllAccountingSettings",
  "getPostingConfigKeys",
  "autoDetectAndPinAccounts",
  // [ACC-REQUIRED] the default account for the receivables/payables field in the
  // add/edit customer/supplier modal — see Code_02_Accounting_ChartOfAccounts.gs
  "getDefaultPartyAccount",

  // ── §FIXED-ASSETS: fixed assets and depreciation ──
  "getFixedAssets",
  "addFixedAsset",
  "updateFixedAsset",
  "deleteFixedAsset",
  "postDepreciation",
  "disposeFixedAsset",

  // ── §USER-PREFS: user preferences ──
  "getUserPreferences",
  "saveUserPreference",
  "saveBulkUserPreferences",
  "resetUserPreferences",
  "getUserPreferencesAll",

  // ── §INV-SETTINGS: general inventory settings (Code_56_InventorySettingsEngine.gs) ──
  "getInventorySettings",
  "saveInventorySettings",
  "resetInventorySettings",

  // ── §CUST-SETTINGS: general customer settings (Code_58_CustomerSettingsEngine.gs) ──
  "getCustomerSettings",
  "saveCustomerSettings",
  "resetCustomerSettings",

  // ── §INV2-SETTINGS: general invoice settings (Code_59_InvoiceSettingsEngine.gs) ──
  "getInvoiceSettings",
  "saveInvoiceSettings",
  "resetInvoiceSettings",

  // ── §I18N: multi-language engine (Code_31_i18n_Engine.gs) ──
  "getI18nBootstrap",
  "setUserLanguage",
  "setSystemForcedLanguage",
  "setSystemDefaultLanguage",
  "getSystemLanguageSettings",
  "exportTranslationDictionary",
  "importTranslationDictionary",
  "translateLegacyUiText",

  // ── Banking Module — Phase 8: Bank Reconciliation ──
  "getBankReconciliations",
  "getBankReconciliationDetail",
  "createBankReconciliation",
  "addBankStatementLine",
  "addBankStatementLinesBulk",
  "deleteBankStatementLine",
  "getUnmatchedBankTransactions",
  "matchStatementLine",
  "unmatchStatementLine",
  "autoMatchBankReconciliation",
  "completeBankReconciliation",
  "reopenBankReconciliation",
  "deleteBankReconciliation",
  "getBankAccountStatement",
];

// [SEC-FIX-4] Functions allowed to be called via doPost without a prior valid session —
// these are only functions that verify identity themselves (login) or are genuinely public (customer catalog).
// Any function not listed here requires a valid session token among the args before it runs (see below).
var DOPOST_PUBLIC_FUNCTIONS = [
  // [VERCEL-MIGRATION] returns only static JS/CSS/HTML files (no user
  // or company data) — public so it doesn't get blocked while the token is still being stored.
  "getLazyAppBundle",
  "getLazyBundleCss",
  "getLazyBundleMeta",
  "getLazyBundleChunk",
  "ping",
  "getI18nBootstrap",
  "login",
  "loginWithData",
  "loginLite",
  "logout",
  "validateSession",
  "refreshSession",
  "getCatalogPublicData",
  "getScriptUrl",
];

// [SEC-FIX-4] Looks for a valid session token inside args and actually verifies it via validateSession.
// Central (fail-closed) defense: doPost used to allow executing any function from the allowlist with
// no session check at the doPost level itself, leaving protection entirely to each individual
// function — which is what allowed admin functions (createBackup, saveBulkUserPreferences ...) to be
// called with no login at all whenever a developer forgot to add _checkPermission inside them.


// ╔══════════════════════════════════════════════════════════════╗
// ║        MOO.ERP v5.0 — Enterprise Resource Planning                ║
// ║        Code.js — Google Apps Script Backend                 ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  File overview:                                                ║
// ║                                                              ║
// ║  §01  Constants & Sheet Headers                             ║
// ║  §02  Entry Points  (doGet · include · getScriptUrl)        ║
// ║  §03  Catalog Public  (getCatalogPublicData)                ║
// ║  §04  Sheet Utilities  (getSheet · readSheet · ...)         ║
// ║  §05  Validation Helpers                                     ║
// ║  §06  Password & Auth Helpers                               ║
// ║  §07  Color Utilities  (normalize · resolve · cache)        ║
// ║  §08  Groups CRUD                                           ║
// ║  §09  Warehouses CRUD                                       ║
// ║  §10  Colors CRUD                                           ║
// ║  §11  Authentication  (login · logout · ensureDefaults)     ║
// ║  §12  Users CRUD                                            ║
// ║  §13  Items CRUD  (+ saveItemWithColorSync)                 ║
// ║  §14  Stock  (getOrCreate · updateBalance)                  ║
// ║  §15  Transactions CRUD  (+ batch · transfer)              ║
// ║  §16  Production Orders CRUD                                ║
// ║  §17  Cutting Data                                          ║
// ║  §18  Permissions System                                    ║
// ║  §18-WH  Warehouse-Level Access Control (new in v4.1)        ║
// ║  §19  Audit Log  (write · read · export · clear)           ║
// ║  §20  Backup System  (create · schedule · status)          ║
// ║  §21  Color Map  (CSS_COLOR_MAP_MASTER)                     ║
// ║  §22  Dashboard Stats                                       ║
// ║  §23  Stock Reports                                         ║
// ║  §24  System Setup & Migrations                             ║
// ║  §25  File Upload                                           ║
// ║  §26  Items Excel Import                                    ║
// ║  §27  Weekly Reports  (build · send · triggers)            ║
// ║  §28  Color Hex Resolution  (resolveColorHex · batch)      ║
// ║  §29  Security Setup  (setupSecurityUpgrades)  (new in v4.1) ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  v4.1 improvements — security and permissions:                ║
// ║  [1] Audit Log with old_value + new_value + _diffObjects()   ║
// ║  [2] Instant email alert on any account being blocked (_notifyAdminBlock) ║
// ║  [3] Soft Delete for items (deleted_at + deleted_by)          ║
// ║  [4] Warehouse-level permissions (WarehouseAccess sheet)      ║
// ║  [5] Session Watchdog + session-expiry warning (Frontend)     ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  Notes for developers:                                        ║
// ║  • Functions starting with _ (underscore) are internal-only,  ║
// ║    never called directly from the frontend.                   ║
// ║  • All public functions return { success, message/data }.     ║
// ║  • errResponse() and okResponse() for unified responses.      ║
// ║  • _checkPermission() is called at the start of every write function. ║
// ║  • After deploying: run setupSecurityUpgrades() once           ║
// ╚══════════════════════════════════════════════════════════════╝

// ── §01  Constants & Spreadsheet Reference ────────────────────

/** Reference to the main Spreadsheet — used throughout the file */
const SS = SpreadsheetApp.getActiveSpreadsheet();

// ✅ [PERF-1] A cache scoped to a single execution only — automatically reset
// with each new HTTP request (GAS reinitializes global variables on every independent execution).
// Prevents getSheet() from repeating the "column completeness check" (reading the header) for the
// same sheet more than once per request — e.g. login() + getAllData() + getUserPermissions()
// used to each open and check the Users sheet from scratch every time. No effect on data
// freshness since the cached item is a reference to the sheet itself (a handle), not a copy of its data.
var _sheetCache = {};

// ─────────────────────────────────────────────────────────────
// §06-UCACHE  Users Cache — a standalone server-side cache for the Users sheet
//
// [PERF-LOGIN-1] Goal: avoid reading the Users sheet from scratch on every login.
// login() and ensureDefaultUsers() share the same cache.
// TTL = 5 minutes — automatically invalidated on addUser / updateUser / deleteUser.
//
// Key used: "wms_users_raw_v1"
// Value: JSON.stringify(array of raw user objects with passwords — internal only)
// ─────────────────────────────────────────────────────────────
var USERS_CACHE_KEY = "wms_users_raw_v1";
var USERS_CACHE_FLAG_KEY = "wms_default_users_ok"; // for ensureDefaultUsers
var USERS_CACHE_TTL = 1500; // 25 minutes in seconds

// [CACHE-ENGINE / Phase 13 — P1] Used to call CacheService.getScriptCache()
// directly with two local keys (USERS_CACHE_KEY/USERS_CACHE_FLAG_KEY). Now
// they go through CacheEngine (CACHE_NAMESPACE.USERS) — the same keys and TTL
// were kept exactly as-is (25 minutes for the user array, 10 minutes for the flag), with
// no change in behavior, just the prefix is now unified with the other modules.


// ─────────────────────────────────────────────────────────────
// §01-B  Sheet Headers
//
// Every sheet has its official headers array defined here.
// getSheet() uses it to auto-create columns and append
// any missing column when the system is upgraded.
// ─────────────────────────────────────────────────────────────

const HEADERS = {
  Items: [
    "id",
    "code",
    "name",
    "description",
    "group",
    "unit",
    "min_qty",
    "image_url",
    "cost_price",
    "selling_price",
    "created_at",
    "colors_json",
    "deleted_at", // ← v4.1 Soft Delete
    "deleted_by", // ← v4.1 Soft Delete
    // ── [ITEM-MASTER-P1] General tab (15..30) — see _buildItemExtraFieldsRow ──
    "name_en",
    "short_name",
    "barcode",
    "item_type",
    "status",
    "company_id",
    "branch_id",
    "category_main",
    "category_sub",
    "brand",
    "model",
    "season",
    "country_of_origin",
    "default_supplier",
    "tags",
    "notes",
    // ── [ITEM-MASTER-P2] Units and sizes (31..38) — see _buildItemUnitsFieldsRow ──
    "extra_units_json",
    "min_sale_qty",
    "min_purchase_qty",
    "length_cm",
    "width_cm",
    "height_cm",
    "weight_kg",
    "sizes_json",
    // ── [ITEM-MASTER-P3] Inventory policy (39..49) — see _buildItemInventoryFieldsRow ──
    "tracking_type",
    "shelf_life_days",
    "reorder_point",
    "max_qty",
    "safety_stock",
    "lead_time_days",
    "valuation_method",
    "default_warehouse_id",
    "shelf", // removed from UI - column kept empty to preserve column order
    "bin", // removed from UI
    "rack", // removed from UI
    // ── [ITEM-MASTER-P4] Purchasing (50..54) — see _buildItemPurchasingFieldsRow ──
    "moq",
    "purchase_currency",
    "order_policy",
    "supplier_item_code",
    "catalog_number",
    // ── [ITEM-MASTER-P4] Sales (55..59) — see _buildItemSalesFieldsRow ──
    "tax_rate",
    "price_includes_tax",
    "min_margin_percent",
    "max_discount_percent",
    "commission_percent",
    // ── [ITEM-MASTER-P4] Accounting (60..69) — see _buildItemAccountingFieldsRow ──
    "inventory_account_id",
    "cogs_account_id",
    "sales_account_id",
    "purchase_account_id",
    "sales_return_account_id",
    "purchase_return_account_id",
    "inventory_adjustment_account_id",
    "price_difference_account_id",
    "cost_center_id",
    "profit_center_id",
    // ── [ITEM-MASTER-P5] Manufacturing (70..73) — see _buildItemManufacturingFieldsRow ──
    "is_manufactured",
    "default_routing_id",
    "manufacturing_waste_percent",
    "operation_cost",
    // ── [ITEM-MASTER-P5] Quality (74..76) — see _buildItemQualityFieldsRow ──
    "requires_qc",
    "certificates_required",
    "qc_notes",
    // ── [ITEM-MASTER-P6] E-commerce (77..80) — see _buildItemEcommerceFieldsRow ──
    "meta_title",
    "meta_description",
    "slug",
    "gallery_json",
    // ── [ITEM-MASTER-P6] Documents (81) — see _buildItemDocumentsFieldsRow ──
    "documents_json",
    // ── [BUNDLE-COMPONENTS-2026-08-05] Bundle components (82) — see
    // _buildItemBundleFieldsRow. Tied to the "Bundle Components" tab on the item
    // screen (03_JS_Dashboard_Items.html); read by Code_20c_Invoices.js
    // at sale time to break a bundle item down into stock/cost movements for its components.
    "bundle_components_json",
  ],
  // [ITEM-WAREHOUSES-LINK] the item-to-warehouse link table (a true N:N) —
  // replaces the old "single warehouse per item" idea. Each record = one item↔warehouse relation.
  // The fields from min_qty to notes are proactive additions (optional) to support future
  // per-warehouse limits/reorder points/shelf locations without changing the table shape.
  ItemWarehouses: [
    "id",
    "item_id",
    "warehouse_id",
    "is_active",
    "min_qty",
    "max_qty",
    "reorder_point",
    "bin_location",
    "notes",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  Groups: [
    "id",
    "name",
    "prefix",
    "warehouse_id",
    "notes",
    "created_at",
    // ── GROUP-HIERARCHY P1: tree-structure fields (self-healing append) ──
    "parent_id", // parent group ID — empty = root group
    "level", // the group's level in the tree (0 = root)
    "full_path", // the full path separated by " / " — computed automatically
    "sort_order", // display order among siblings
    "has_children", // true/false — computed automatically, used for lazy loading
    // 🎨 [FIX] "seq" must always stay the last item — the self-healing column-append
    // (getSheet) appends any missing column as the last actual column in the sheet, not at its
    // position in the array. If it's placed in the middle as it was before, values get written
    // in the wrong order and shift every column after it (the real cause of column misalignment).
    "seq", // ← a unique sequence number for the group (used as a visual identifier alongside the code since the code can repeat)
  ],
  Stock: ["item_id", "warehouse", "color", "quantity", "batch_no", "serial_no", "expiry_date"],
  Transactions: [
    "id",
    "date",
    "type",
    "item_id",
    "quantity",
    "from_warehouse",
    "to_warehouse",
    "notes",
    "user",
    "attachment_url",
    "color",
    "ref",
    "party",
    // permit_id removed — derived automatically from id
    "batch_no",
    "serial_no",
    "expiry_date",
  ],
  ProductionOrders: [
    "id",
    "date",
    "product_id",
    "quantity",
    "status",
    "notes",
    "user",
    "patron_number",
    "fabric_meters",
    "lining_meters",
    "sizes_json",
    "closed_at",
  ],
  Users: [
    "username",
    "password",
    "role",
    "full_name",
    "active",
    "last_login",
    "email",
    // ── [FORCE-PW-1] Force Password Change on First Login ──────────
    // ⚠️ New columns must always be appended at the end of the array (the self-healing
    // column-append in getSheet appends any missing column as the last actual column
    // in the sheet, not at its position in the array). If placed in the middle, values
    // will be written in the wrong order and shift every column after it.
    "force_password_change", // true = the user must change their password before accessing any screen
    "password_changed_at", // date of the last actual password change
    "password_history", // JSON: last 5 hashed passwords (to prevent reuse in the future)
    // ✅ [PRIMARY-ADMIN-FLAG] a permanent flag marking the "primary admin", protected
    // from deletion and from name changes that would conflict with parts of the system
    // that depend on it — instead of relying on the literal username==="admin"
    // (which breaks if the username changes). For any old row predating this update
    // the value will be empty, so isMainAdmin() falls back to checking the literal
    // name "admin" as a temporary fallback until the name actually changes
    // (at which point the flag is set explicitly = true).
  ],
  Shipments: [
    "id",
    "date",
    "customer",
    "driver",
    "company",
    "expected_date",
    "status",
    "notes",
    "user",
    "items_json",
    "receipt_url",
  ],
  Colors: ["id", "name", "code", "hex", "notes", "created_at"],
  Sizes: ["id", "name", "code", "notes", "created_at"],
  // [FIX-2026-07-28] was completely missing from HEADERS, so DataLayer.getAll/insert
  // for "SizeGroups" silently returned UNKNOWN_TABLE, so size groups added
  // in the sheet (manually or even via addSizeGroup) weren't showing up in the app.
  // The exact same columns as addSizeGroup/updateSizeGroup (id, name, size_ids, notes).
  SizeGroups: ["id", "name", "size_ids", "notes", "created_at"],
  // [UNITS-2026-08-06] units of measure — a flat entity replacing the old
  // hardcoded list in the frontend code. See Code_55_Units.js.
  Units: ["id", "name", "symbol", "notes", "created_at"],
};

// ─────────────────────────────────────────────────────────────
// §01-C  ERP v5 — Accounting + HR Headers (merged from Code_Accounting_HR.js)
// ─────────────────────────────────────────────────────────────
// [PAY-METHOD-EXT] payment methods that post through a bank account (bank_account_id) —
// includes regular bank transfer as well as Visa and e-wallets, because all three are stored
// as rows in the same BankAccounts table (distinguished by the account_kind column). Using one
// shared constant instead of repeating the array in every function avoids forgetting to update one later.
var BANKLIKE_PAYMENT_METHODS = ["BANK", "VISA", "WALLET"];

/** A short Arabic label for the payment method — used in auto-generated journal-entry notes */
function _paymentMethodNoteLabel(method) {
  var map = {
    CASH: "نقدية",
    BANK: "بنك",
    VISA: "فيزا",
    WALLET: "محفظة إلكترونية",
    CHECK: "شيك",
  };
  return map[method] || "بنك";
}

const ACCOUNTING_HR_HEADERS = {
  ChartOfAccounts: [
    "id",
    "code",
    "name",
    "name_en",
    "type",
    "parent_id",
    "is_parent",
    "level",
    "currency",
    "branch",
    "opening_balance",
    "current_balance",
    "notes",
    "created_at",
    "is_active",
    "deleted_at",
    "deleted_by",
    // [ITEM-POSTING-WIRE-GAP-FIX-2026-08-08] new column — used by
    // getCashFlowStatement to classify fixed assets under "investing activities"
    // instead of relying on a text match on part of the account name (which violated item 6,
    // "must not rely on the account name alone"). Values: FIXED / NON_CURRENT
    // for fixed assets, empty = current (operating) asset.
    // ⚠️ The column needs to be added manually to the header row of the actual
    // ChartOfAccounts sheet on Google Sheets — adding the column here in the code does not
    // auto-create it in a sheet that already exists.
    "subtype",
  ],
  CashBoxes: [
    "id",
    "code",
    "name",
    "branch",
    "currency",
    "opening_balance",
    "current_balance",
    "account_id",
    "responsible",
    "is_active",
    "notes",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
  ],
  // ── Banking Module — Phase 1: Banks (standalone banks table) ──
  Banks: [
    "id",
    "name",
    "logo",
    "country",
    "city",
    "branch",
    "address",
    "phone",
    "customer_service",
    "website",
    "status", // ACTIVE / SUSPENDED
    "notes",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
  ],
  BankAccounts: [
    "id",
    "code",
    "name",
    "branch",
    "currency",
    "account_number",
    "iban",
    "swift",
    "opening_balance",
    "current_balance",
    "account_id",
    "is_active",
    "notes",
    "created_at",
    // ── Phase 1 additions ──
    "bank_id", // link to the Banks table
    "opening_date", // account opening date
    "default_cost_center", // default cost center (free text — no standalone cost-center table exists yet)
    "created_by",
    "updated_at",
    "updated_by",
    // ── [PAY-METHOD-EXT] account type: BANK (default) / VISA / WALLET ──
    // allows using the same bank-accounts table/screen/permissions for Visa
    // and e-wallet accounts (Vodafone Cash, InstaPay..), each type shown as a clear
    // entry in the "payment method" picker on vouchers, while reusing the same accounting
    // structure (auto GL account + balance + entries) without duplicating an entire new entity.
    "account_kind",
  ],
  // ── Banking Module — Phase 2: Cheque Books ──
  ChequeBooks: [
    "id",
    "code",
    "bank_account_id",
    "issue_date",
    "first_number",
    "last_number",
    "total_count",
    "used_count",
    "status", // ACTIVE / FINISHED / CANCELLED / DELETED
    "notes",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
  ],
  // ── Banking Module — Phase 3: Cheque Management ──
  Cheques: [
    "id",
    "code",
    "type", // INCOMING (received from a customer/party) / OUTGOING (issued by us)
    "bank_account_id", // OUTGOING: the withdrawal account | INCOMING: the target deposit account (optional)
    "cheque_book_id", // OUTGOING only — if drawn from our own cheque book (optional)
    "cheque_number",
    "bank_id", // INCOMING: the issuing bank on the cheque | OUTGOING: our account's bank (display enrichment only)
    "party_type", // CUSTOMER / SUPPLIER / OTHER — ready for Phase 5 (the actual link to the Parties table)
    "party_id", // not actually used before Phase 5 — present in advance to avoid a later schema change
    "party_name", // the drawer's name (incoming) or the payee's name (outgoing) — free text for now
    "amount",
    "currency",
    "issue_date",
    "due_date",
    "status", // PENDING / COLLECTED / BOUNCED / CANCELLED / REPLACED
    "notes",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
    // ── Banking Module — Phase 4: Cheque Lifecycle ──
    "replaces_cheque_id", // if this cheque was issued as a replacement for a bounced one — the original cheque's id
    "replaced_by_cheque_id", // if this cheque was replaced by another one — the new cheque's id
  ],
  JournalEntries: [
    "id",
    "date",
    "reference",
    "source_type",
    "description",
    "total_debit",
    "total_credit",
    "status",
    "notes",
    "created_by",
    "created_at",
    "posted_at",
    "posted_by",
    "reversed_by",
    "reversal_of",
  ],
  JournalEntryLines: [
    "id",
    "entry_id",
    "account_id",
    "debit",
    "credit",
    "line_number",
    "notes",
    "party_type",
    "party_id",
    // [COST-CENTER-DIM] the cost-center dimension at the entry-line level (not the
    // entry as a whole) — an extra column appended at the end of the table only (additive),
    // doesn't change the order or meaning of any existing column, so it doesn't break any
    // old entry or any code reading JournalEntryLines via readSheet (reads by name/object, not by index).
    // Always optional unless POSTING_CONFIG_KEYS.cost_center_required is enabled.
    "cost_center_id",
  ],
  // [AUDIT-FIX-2026-08-09 §RISK-7-RETURN-COST-BASIS] a detailed record of each
  // item's cost at the moment of an actual sale (from real FIFO/AVCO layer consumption),
  // linked to the invoice itself. Sole purpose: when a sales return happens later, we reverse COGS
  // using the same actual cost recorded at the time of the original sale instead of today's price
  // (item.cost_price), which may have changed due to price fluctuations under FIFO.
  // Purely additive — no old code path depends on it, so there's no risk of breakage.
  InvoiceCOGSBreakdown: [
    "id",
    "invoice_id",
    "item_id",
    "qty",
    "unit_cost",
    "total_cost",
    "date",
  ],
  // [COST-CENTER-MODULE] the standalone cost-centers entity — a simple hierarchy (parent_id)
  // following the same pattern as ChartOfAccounts, but with no direct financial effect on its own;
  // it's purely a classification dimension linked to entry lines via cost_center_id above.
  CostCenters: [
    "id",
    "code",
    "name",
    "name_en",
    "parent_id",
    "is_active",
    "notes",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
  ],
  // [PERIOD-CLOSING] accounting periods — to prevent any edit/delete on documents dated
  // within a closed period (see Code_45_PeriodClosingEngine.js)
  AccountingPeriods: [
    "id",
    "period_name", // example: "January 2026"
    "start_date",
    "end_date",
    "status", // OPEN / CLOSED
    "closed_by",
    "closed_at",
    "reopened_by",
    "reopened_at",
    "notes",
    "created_at",
    "created_by",
  ],
  ReceiptVouchers: [
    "id",
    "date",
    "voucher_number",
    "from_party",
    "party_type",
    "party_id",
    "amount",
    "currency",
    "payment_method",
    "cash_box_id",
    "bank_account_id",
    "check_number", // [AUDIT-FIX 2.1 — DEPRECATED] no longer written for any new voucher; the sole source of truth now is Cheques via cheque_id. Kept only to display old records.
    "due_date", // [AUDIT-FIX 2.1 — DEPRECATED] same thing — see Cheques.due_date via cheque_id
    "description",
    "invoice_id", // [C4-FIX] links the voucher to a specific invoice — required for the aging report
    "status",
    "created_by",
    "created_at",
    "approved_by",
    "approved_at",
    "cancelled_by", // [AUDIT-FIX 2.5] unified with Expenses — used to rely on self-healing column append alone
    "cancelled_at",
    "cheque_id", // [AUDIT-FIX 2.1] the real link to the Cheques table — replaces the free-text check_number/due_date
  ],
  PaymentVouchers: [
    "id",
    "date",
    "voucher_number",
    "to_party",
    "party_type",
    "party_id",
    "amount",
    "currency",
    "payment_method",
    "cash_box_id",
    "bank_account_id",
    "check_number", // [AUDIT-FIX 2.1 — DEPRECATED] no longer written for any new voucher; see Cheques via cheque_id
    "due_date", // [AUDIT-FIX 2.1 — DEPRECATED] same thing
    "description",
    "status",
    "created_by",
    "created_at",
    "approved_by",
    "approved_at",
    "invoice_id", // [PAYMENT-ENGINE] optional link to a purchase invoice — for payment allocation
    "cancelled_by", // [AUDIT-FIX 2.5] unified with Expenses
    "cancelled_at",
    "cheque_id", // [AUDIT-FIX 2.1] the real link to the Cheques table
  ],
  Expenses: [
    "id",
    "date",
    "voucher_number",
    "account_id",
    "amount",
    "currency",
    "payment_method",
    "cash_box_id",
    "bank_account_id",
    "description",
    "status",
    "created_by",
    "created_at",
    "approved_by",
    "approved_at",
    "cancelled_by",
    "cancelled_at",
  ],
  TransferVouchers: [
    "id",
    "date",
    "voucher_number",
    "from_type",
    "from_id",
    "to_type",
    "to_id",
    "amount",
    "currency",
    "exchange_rate",
    "description",
    "status",
    "created_by",
    "created_at",
    "approved_by",
    "approved_at",
    // ── Banking Module — Phase 7: Bank Transfers ──
    "fee_amount", // bank transfer fee/charges (optional — deducted from the source account in addition to the transferred amount)
    "bank_reference", // the bank's reference number for the transfer (SWIFT/IBAN ref or the operation number from the statement) — optional free text
  ],
  // ── Banking Module — Phase 8: Bank Reconciliation ──
  // One reconciliation session = a bank account + a specific statement date. Each session contains
  // statement line items (BankStatementLines) that are matched manually/automatically against
  // the actual movements recorded in the system (cheques/transfers/receipt & payment vouchers/expenses).
  // No journal entry is generated from the reconciliation itself — it's purely a reconciliation and review tool.
  BankReconciliations: [
    "id",
    "code", // REC-YYYYMM-XXX
    "bank_account_id",
    "statement_date", // the statement's end date (the end of the period being reconciled)
    "period_start", // the period's start (optional — display only)
    "statement_opening_balance",
    "statement_closing_balance",
    "book_balance", // the bank account's balance in the system at session creation time (a snapshot for reference)
    "matched_total", // the net total of matched items — computed and stored only at approval time
    "difference", // the difference at approval time = statement_closing_balance - the system balance at that time
    "status", // DRAFT (in progress) / COMPLETED (approved and closed) / DELETED
    "notes",
    "created_by",
    "created_at",
    "completed_by",
    "completed_at",
  ],
  BankStatementLines: [
    "id",
    "reconciliation_id", // the session this item belongs to
    "bank_account_id",
    "line_date",
    "description",
    "reference", // the operation number on the statement — the primary match point with bank_reference
    "debit", // debit from the statement's perspective (withdrawal/deduction)
    "credit", // credit from the statement's perspective (deposit)
    "status", // UNMATCHED / MATCHED
    "matched_type", // CHEQUE / TRANSFER / RECEIPT / PAYMENT / EXPENSE
    "matched_id",
    "matched_at",
    "matched_by",
    "created_by",
    "created_at",
  ],
  Departments: [
    "id",
    "code",
    "name",
    "parent_id",
    "manager_id",
    "branch",
    "is_active",
    "notes",
    "created_at",
  ],
  JobTitles: [
    "id",
    "code",
    "title",
    "department_id",
    "description",
    "is_active",
    "created_at",
  ],
  Employees: [
    "id",
    "employee_number",
    "full_name",
    "photo_url",
    "national_id",
    "phone",
    "email",
    "address",
    "department_id",
    "job_title_id",
    "branch",
    "direct_manager_id",
    "hire_date",
    "birth_date",
    "gender",
    "marital_status",
    "basic_salary",
    "salary_currency",
    "payroll_basis",
    "payment_method",
    "bank_account",
    "bank_name",
    "status",
    "termination_date",
    "termination_reason",
    "created_at",
    "updated_at",
    // ── [HR-TABS-P1] new columns — appended at the end of the array only (self-healing schema) ──
    "notes", // general notes about the employee (Tab: Notes)
    "bank_iban", // Tab: Bank Information
    "bank_swift",
    "bank_branch",
    "policy_acknowledged", // TRUE/FALSE — the employee's acknowledgment of the company policy (Tab: Employee Policy)
    "policy_acknowledged_at",
    // ── [HR-TABS-P2] new columns — appended at the end of the array only (self-healing schema) ──
    "employment_type", // Tab: Employment Information — PERMANENT/TEMPORARY/PROBATION/CONTRACTOR/PART_TIME
    "probation_end_date", // end of the probation period
    "contract_end_date", // contract end date (for fixed-term contracts)
  ],
  EmployeeAllowances: [
    "id",
    "employee_id",
    "allowance_type",
    "amount",
    "is_percentage",
    "percentage_value",
    "currency",
    "effective_date",
    "is_active",
    "created_at",
    // ── [SALARY-COMPONENTS-P1] — appended at the end of the array only (self-healing schema) ──
    "component_id", // link to the salary component from the settings screen (SalaryComponents) — may be empty for old records
  ],
  EmployeeDeductions: [
    "id",
    "employee_id",
    "deduction_type",
    "amount",
    "is_percentage",
    "currency",
    "effective_date",
    "is_active",
    "created_at",
    // ── [SALARY-COMPONENTS-P1] — appended at the end of the array only (self-healing schema) ──
    "component_id",
  ],
  // ── [SALARY-COMPONENTS-P1] salary components — a standalone setting managed by the system admin ──
  // Instead of writing the allowance/deduction name as free text on every transaction, the types are
  // managed centrally here, then used as a picklist in EmployeeAllowances/EmployeeDeductions.
  SalaryComponents: [
    "id",
    "code",
    "name",
    "component_group", // ALLOWANCE | DEDUCTION
    "default_is_percentage", // TRUE/FALSE — the suggested default value when assigning to an employee
    "is_active",
    "notes",
    "created_at",
  ],
  // [REMEDIATION-6] a simple Job History — a historical record of salary/department/job
  // changes for the employee, instead of an edit overwriting the old value and losing it forever.
  EmployeeJobHistory: [
    "id",
    "employee_id",
    "change_type",
    "effective_date",
    "old_value_json",
    "new_value_json",
    "changed_by",
    "created_at",
  ],
  Attendance: [
    "id",
    "employee_id",
    "date",
    "check_in",
    "check_out",
    "work_hours",
    "overtime_hours",
    "delay_minutes",
    "status",
    "shift_type",
    "notes",
    "created_at",
    "recorded_by",
  ],
  LeaveTypes: [
    "id",
    "code",
    "name",
    "max_days",
    "is_paid",
    "requires_approval",
    "color",
    "is_active",
  ],
  LeaveRequests: [
    "id",
    "employee_id",
    "leave_type_id",
    "start_date",
    "end_date",
    "days_count",
    "reason",
    "status",
    "requested_at",
    "approved_by",
    "approved_at",
    "rejection_reason",
  ],
  LoanRequests: [
    "id",
    "employee_id",
    "amount",
    "reason",
    "installments",
    "monthly_amount",
    "status",
    "requested_at",
    "approved_by",
    "approved_at",
    "remaining_amount",
    "paid_installments",
    "created_at",
  ],
  PayrollPeriods: [
    "id",
    "name",
    "year",
    "month",
    "start_date",
    "end_date",
    "status",
    "created_by",
    "created_at",
    "approved_by",
    "approved_at",
    "paid_at",
  ],
  PayrollRecords: [
    "id",
    "payroll_period_id",
    "employee_id",
    "basic_salary",
    "total_allowances",
    "total_deductions",
    "social_insurance",
    "income_tax",
    "overtime_amount",
    "loan_deduction",
    "net_salary",
    "payment_status",
    "payment_date",
    "payment_method",
    "notes",
    // ── [REMEDIATION-1] piece-rate pay aggregated from StageExecutions for this period ──
    "production_wage",
    // ── [REMEDIATION-10] unpaid-leave deduction — now actually computed inside
    // generatePayroll from approved LeaveRequests (is_paid = FALSE) overlapping the
    // payroll period, and posted within the "employee deductions and dues" line in _autoJournalFromPayroll (item 3).
    "unpaid_leave_deduction",
    // ── [REMEDIATION-3] lateness deduction — used to be computed and subtracted from net
    // salary with no field stored for it, so it disappeared from any accurate reconciliation or journal
    // entry. Added here so that the sum of (positive components) exactly matches the sum of (net +
    // all stored deductions) — a fundamental requirement for the new journal entry to balance in _autoJournalFromPayroll (item 3).
    "delay_deduction",
    // ── [REMEDIATION-5] the employer's share of social insurance — a real expense on
    // the company, entirely separate from the employee's share (social_insurance) deducted from their net pay.
    // ⚠️ The rate is read from the employer_social_insurance_rate setting and never assumed
    // in the code — if the setting is empty/zero, this value stays 0 (we never invent a rate).
    "employer_social_insurance",
  ],
  EmployeeDocuments: [
    "id",
    "employee_id",
    "doc_type",
    "title",
    "file_url",
    "file_name",
    "uploaded_at",
    "uploaded_by",
    "notes",
  ],
  // ── [HR-TABS-P1] Qualifications & Experience (Tab: Qualifications & Experience) ──
  EmployeeQualifications: [
    "id",
    "employee_id",
    "type", // EDUCATION / EXPERIENCE / CERTIFICATE
    "title", // the qualification/previous job title/certificate name
    "institution", // the issuing body/previous employer
    "field", // the specialization
    "start_date",
    "end_date",
    "grade", // grade/rating (optional)
    "notes",
    "created_at",
    "created_by",
  ],
  // ── §EXT-PS  Production Stages (piece-rate pay) ──
  ProductionStages: [
    "id",
    "code",
    "name",
    "description",
    "department_id",
    "unit",
    "price",
    "status",
    "notes",
    "created_by",
    "created_at",
    "updated_at",
  ],
  // A real log of every stage-execution operation performed by an employee — the basis for piece-rate pay calculation
  StageExecutions: [
    "id",
    "stage_id",
    "employee_id",
    "qty",
    "unit_price",
    "total_amount",
    "exec_date",
    "notes",
    "created_by",
    "created_at",
    // ── [REMEDIATION-1] linking stage execution to the payroll cycle — instead of a separate immediate accounting post ──
    "qty_rejected", // [REMEDIATION-4] the rejected quantity — deducted from the quantity counted toward pay
    "payroll_status", // PENDING_APPROVAL | APPROVED | PENDING_PAYROLL | INCLUDED_IN_PAYROLL
    "payroll_period_id", // filled only after the execution is included in a generated payroll run
    "approved_by", // [REMEDIATION-7] supervisor/quality approval before posting — used in a later item
    "approved_at",
    // ── §MFG-P0  linking stage execution to the new manufacturing order (additive — doesn't break any old data) ──
    // ⚠️ [NOT-IMPLEMENTED — DB-AUDIT] these five columns are reserved for the same inactive
    // "Manufacturing 2.0" schema (see the NOT-IMPLEMENTED comment above ManufacturingOrders
    // in this same file) — no function currently reads or writes them from any screen.
    "manufacturing_order_id", // optional link to the manufacturing order (ManufacturingOrders.id)
    "routing_operation_id", // optional link to the routing operation step (RoutingOperations.id)
    "machine_id", // the machine used for this execution (optional)
    "time_spent_minutes", // actual time spent (to compute the real machine/labor cost)
    "operation_status", // pending | in_progress | done
  ],

  // ═══════════════════════════════════════════════════════════════════════
  // §MFG-P0  the new Manufacturing Module — enterprise grade
  // Built on top of: BOM → Routing → Manufacturing Orders → Costing → Subcontract
  // See: MOO_ERP_Manufacturing_Module_Design_Report.md for the full design
  // ═══════════════════════════════════════════════════════════════════════

  // ── Layer 1: Master Data ──────────────────────────────────────────────
  WorkCenters: [
    "id", // WC-xxx
    "code",
    "name",
    "department_id", // optional link to the existing Departments table
    "capacity_per_day",
    "capacity_unit", // e.g. pieces/work-hour
    "cost_per_hour",
    "status", // active | inactive
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "deleted_at",
    "deleted_by",
  ],
  Machines: [
    "id", // MCH-xxx
    "code",
    "name",
    "work_center_id",
    "cost_per_hour",
    "fixed_asset_id", // optional link to the existing FixedAssets table (for depreciation)
    "status", // active | maintenance | idle
    "purchase_date",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "deleted_at",
    "deleted_by",
  ],
  BillOfMaterials: [
    "id", // BOM-xxx
    "product_id",
    "version",
    "is_active",
    "bom_type", // standard | alternate
    "output_qty",
    "output_unit",
    "routing_id",
    "status", // draft | approved | obsolete
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "deleted_at",
    "deleted_by",
  ],
  BOMLines: [
    "id", // BML-xxx
    "bom_id",
    "line_number",
    "component_item_id",
    "quantity",
    "unit",
    "scrap_percent",
    "is_optional",
    "notes",
  ],
  Routings: [
    "id", // RTG-xxx
    "product_id",
    "bom_id",
    "name",
    "version",
    "is_active",
    "status", // draft | approved | obsolete
    "notes",
    "created_by",
    "created_at",
    "deleted_at",
    "deleted_by",
  ],
  RoutingOperations: [
    "id", // ROP-xxx
    "routing_id",
    "sequence",
    "operation_name",
    "work_center_id",
    "standard_time_minutes",
    "labor_rate_type", // piece_rate | hourly
    "production_stage_id", // link to the existing ProductionStages table to reuse piece-rate prices
    "machine_id",
    "is_subcontract_operation",
    "notes",
  ],
  // ⚠️ [NOT-IMPLEMENTED — DB-AUDIT] from here to the end of ManufacturingCostSettings:
  // these nine tables (ManufacturingOrders, MOGarmentDetails, MOMaterialIssues,
  // QualityTemplates, QualityInspections, SubcontractShipments, WIPLedger,
  // CostVarianceLog, ManufacturingCostSettings) are an "advanced manufacturing" schema (Manufacturing
  // 2.0 — staged manufacturing orders/quality inspection/cost variance/subcontractors) that was designed
  // in advance but has no CRUD function or UI screen actually using it yet (verified: zero
  // real calls beyond the schema definition and the screen-organization list in Settings).
  // The manufacturing flow actually in use is ProductionOrders + ProductionStages + BOM/Routings.
  // Don't assume any code reads/writes these tables before actually confirming when the feature is activated.
  // ── Layer 3: Execution ───────────────────────────────────────────────
  ManufacturingOrders: [
    "id", // MO-xxx
    "order_type", // inhouse | subcontract
    "product_id",
    "bom_id", // a frozen snapshot copy at approval time
    "routing_id",
    "quantity_planned",
    "quantity_produced",
    "quantity_scrapped",
    "quantity_rejected",
    "warehouse_source",
    "warehouse_target",
    "status", // draft|approved|released|started|paused|completed|closed|cancelled|reopened
    "priority", // low|normal|high|urgent
    "planned_start",
    "planned_finish",
    "actual_start",
    "actual_finish",
    "subcontractor_id",
    "cost_method_used",
    "standard_cost_total",
    "actual_cost_total",
    "sales_order_ref",
    "parent_mo_id", // to support multi-level manufacturing
    "approved_by",
    "approved_at",
    "released_by",
    "released_at",
    "closed_by",
    "closed_at",
    "cancel_reason",
    "reopen_reason",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "deleted_at",
    "deleted_by",
  ],
  // An optional extension table — details specific to the garment industry only (not added to ManufacturingOrders itself)
  MOGarmentDetails: [
    "id",
    "mo_id",
    "patron_number",
    "fabric_meters",
    "lining_meters",
    "sizes_json",
  ],
  MOMaterialIssues: [
    "id", // MMI-xxx
    "mo_id",
    "item_id",
    "warehouse",
    "color",
    "quantity_planned",
    "quantity_issued",
    "quantity_returned",
    "issue_type", // auto | manual
    "unit_cost",
    "journal_entry_id",
    "transaction_id", // link to the actual Transactions movement created
    "issued_by",
    "issued_at",
    "notes",
  ],
  QualityTemplates: [
    "id",
    "name",
    "inspection_type", // incoming | in_process | final
    "criteria_json",
    "status",
    "created_by",
    "created_at",
  ],
  QualityInspections: [
    "id", // QC-xxx
    "mo_id",
    "inspection_type",
    "quality_template_id",
    "qty_inspected",
    "qty_accepted",
    "qty_rejected",
    "rejection_reason",
    "inspector_id",
    "capa_notes",
    "status",
    "inspected_at",
    "created_by",
    "created_at",
  ],
  SubcontractShipments: [
    "id", // SCS-xxx
    "mo_id",
    "subcontractor_id",
    "direction", // send_materials | receive_fg | receive_scrap | receive_remaining
    "items_json",
    "warehouse_from",
    "warehouse_to",
    "transport_cost",
    "expected_return_date",
    "actual_date",
    "status",
    "attachment_url",
    "created_by",
    "created_at",
  ],
  // ── Layer 2: Costing ────────────────────────────────────────────────
  WIPLedger: [
    "id", // WIP-xxx
    "mo_id",
    "transaction_type", // material_issue|labor|machine|overhead|subcontract|fg_receipt|variance
    "amount",
    "debit_account_id",
    "credit_account_id",
    "journal_entry_id",
    "transaction_date",
    "notes",
  ],
  CostVarianceLog: [
    "id",
    "mo_id",
    "variance_type", // material | labor | machine | overhead
    "standard_amount",
    "actual_amount",
    "variance_amount",
    "journal_entry_id",
    "created_at",
  ],
  ManufacturingCostSettings: [
    "id",
    "costing_method", // standard | actual | weighted_avg
    "default_overhead_rate",
    "overhead_allocation_base", // labor_hours | machine_hours | material_cost
    "branch_id",
    "updated_by",
    "updated_at",
  ],
  // ⚠️ [/NOT-IMPLEMENTED — DB-AUDIT] end of the inactive Manufacturing 2.0 tables block.
  // ── §WA-LOG-MODEL — the unified WhatsApp communication log ──
  // A dedicated, structured log for every WhatsApp send operation from the system (internal and public)
  // used in the "WhatsApp Log" screen and in the customer communication timeline.
  WhatsAppLog: [
    "id", // WA-LOG-xxxxx
    "created_at", // send date/time (ISO)
    "sent_by", // the username who performed the send (or "Customer (public catalog)")
    "customer_id", // the customer/party ID if one exists
    "customer_name", // the customer/party name as entered at send time
    "phone_used", // the normalized number actually used (may be empty for a share with no specific number)
    "template_code", // the template code used
    "template_name", // the template name (a snapshot at send time — unaffected by later template edits)
    "rendered_message", // the final message text after resolving placeholders (first 1000 characters)
    "source_type", // the call source: invoice | customer | statement | payment_reminder | catalog_share | catalog_public_cart | catalog_public_item | manual ...
    "source_id", // the source document/record ID (invoice number, etc.)
    "provider_mode", // direct | cloud_api | twilio (future)
    "status", // opened | sent | failed (defaults to "opened" since wa.me doesn't confirm delivery)
    "is_public", // TRUE if the send came from a public catalog page with no login
  ],
};

// ✅ SHIPMENT_HEADERS and WAREHOUSE_HEADERS are merged in here as direct references from HEADERS
const WAREHOUSE_HEADERS = [
  "id",
  "name",
  "code",
  "type",
  "manager",
  "location",
  "status",
  "notes",
  "account_id", // ← the general-ledger inventory account for this warehouse (optional)
  "created_at",
];
const OPENING_STOCK_HEADERS = [
  "item_id",
  "color",
  "quantity",
  "notes",
  "date",
  "unit_cost", // [MD-06 FIX] the explicit opening unit cost — optional, falls back to item.cost_price
];

// ← v4.1: warehouse-level permissions
const WH_ACCESS_HEADERS = [
  "username",
  "allowed_warehouses", // JSON array of allowed warehouse names (empty = all)
  "updated_at",
  "updated_by",
];

const HEADER_STYLE = { weight: "bold", bg: "#2563eb", color: "#ffffff" };

// ─────────────────────────────────────────────────────────────
// §02  Entry Points
// ─────────────────────────────────────────────────────────────

/**
 * doGet — نقطة دخول HTTP الوحيدة للتطبيق.
 *
 * المسارات:
 *   ?page=catalog  → عرض الكتالوج العام للعملاء (CatalogPublic.html)
 *   (default)      → تطبيق الإدارة الكامل       (Index.html)
 *
 * معاملات الكتالوج:
 *   groups   — معرّفات المجموعات مفصولة بفاصلة
 *   wh       — معرّفات المخازن مفصولة بفاصلة
 *   noprices — "1" لإخفاء الأسعار
 *   showzero — "1" لإظهار الأصناف ذات الرصيد الصفري
 *   noqty    — "1" لإخفاء الكميات عن العميل
 *   client   — اسم العميل لرسالة الترحيب
 */

// ─────────────────────────────────────────────────────────────
//  🎨  MOO.ERP Logo — the single source of truth for the logo design (server-side copy)
//  Used only in Index.html for assets that load before any JS:
//  favicon, apple-touch-icon, msapplication-TileImage, splash screen.
//  ⚠️ Exactly the same design as mooLogoSVG() in Templates.html — any change
//  to the shape must be mirrored in both.
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
//  [FIX-LOGIN-LOGO-2] the same _fixDriveUrl() as in 08_JS_Users_Branding.html
//  but a server-side copy — so we can resolve the custom company logo (if any) while
//  still inside doGet itself, before any JS, so the splash screen (which appears
//  instantly before the login page renders) uses the same real company logo that
//  appears inside the system (the sidebar) instead of always showing the default logo.
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
//  [VERCEL-MIGRATION][AUDIT] a simple connectivity check
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
//  [PERF-LAZY-LOAD] staged loading of the rest of the system's modules after login
// ─────────────────────────────────────────────────────────────


// ── the list of deferred CSS files (in the exact same order as the old list) ──
var _LAZY_STYLE_FILES = [
  "TablerIconsEmbedded",
  "Style_06_Dashboard",
  "Style_07_Accounting",
  "Style_08_Settings",
  "Style_09_Sidebar_Extra",
  "Style_10_Badges_Extra",
  "Style_11_Tail",
  "Style_12_InvoiceWorkspace",
  "Style_13_UpdateManagement",
  // ── [SELECTION-ENGINE] tokens/styles for the unified AppSelect selection engine ──
  "Style_14_AppSelect",
];

// ── the list of deferred JavaScript files (in the exact same order as the old
//    list — the order matters a lot here because of dependencies between files) ──
var _LAZY_SCRIPT_FILES = [
  "SheetJS_Embedded",
  "SplitSelect",
  // ── [SELECTION-ENGINE] the unified engine — must load before any screen
  //    module (Templates_*, 03_JS_*...) so that AppSelect is available when
  //    screens init/upgrade their elements ──
  "49_JS_SelectionEngine",
  // ── [TAB-ENGINE / Phase 7: Lazy Tabs] must load before any screen with
  //    tabs (same logic as AppSelect above) ──
  "50_JS_TabEngine",
  "51_JS_ImageEngine",
  "Templates_02",
  "Templates_03",
  "Templates_04",
  "Templates_05",
  "Templates_06",
  "Templates_07",
  "Templates_08",
  "Templates_09",
  "Templates_10",
  "03_JS_Dashboard_Items",
  "04_JS_Transactions",
  "05_JS_Production",
  "06_JS_Catalog_Stock",
  "07_JS_Shipping_Colors_Excel",
  "08_JS_Users_Branding",
  "09_JS_AIAssistant",
  "10_JS_Settings_Search_Parties",
  "11_JS_Accounting",
  "12_JS_HR",
  "13_JS_AttendanceImport",
  "14_JS_DeviceConnect",
  "15_JS_Invoices",
  "22_JS_PurchaseOrders",
  "40_JS_PurchaseRequests",
  "16_JS_VodafoneCash",
  "17_JS_ExecutiveDashboard",
  "18_JS_Reports",
  "21_JS_AudioService",
  "19_JS_WhatsApp",
  "20_JS_ContextMenu",
  "23_JS_PostingConfig_FixedAssets",
  "24_JS_UserPreferences",
  "25_JS_ReportsRouting",
  "26_JS_DashboardFramework",
  "27_JS_Manufacturing",
  "28_JS_WhatsAppGateway",
  "29_JS_InvoiceWorkspace",
  "30_JS_CommunicationHub",
  "34_JS_ColumnEngine",
  "35_JS_PartyCategories",
  "36_JS_WhatsAppHub",
  "37_JS_ImportWizard",
  "33_JS_DemoDataGenerator",
  "41_JS_UpdateManagement",
];

// The number of files per chunk — tuned so each RPC call stays small
// enough to travel safely (instead of the 5+ MB that used to be sent at once).
var _LAZY_CHUNK_SIZE = 6;


// ── Script URL ───────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §03  Catalog Public Data
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §03-Z  Leading Zero Protection
// ─────────────────────────────────────────────────────────────
//
// ❗ The real cause of the problem:
// Even if we write String(value) in the code, if the sheet cell is formatted as "General"
// then Google Sheets automatically interprets any number-looking text (like "01012345678")
// as a number — exactly as if you'd typed it into the cell yourself — dropping the leading zero.
// The only real fix: set the cell/column format itself to "Plain text" ('@')
// *before* writing to it — not after.
//
// All these columns are auto-detected by name and protected with the '@' format:
// any column whose name contains: phone / mobile / whatsapp / tel / code /
// sku / barcode / national_id / employee_number / account_number /
// iban / swift / check_number / voucher_number / vf_number /
// ref_number / tax_number / bank_account / postal_code / zip_code
// ─────────────────────────────────────────────────────────────


/** Patterns for protected column names (always text, never auto-converted to a number) */
var TEXT_PROTECTED_COLUMN_PATTERNS = [
  /phone/i,
  /mobile/i,
  /whatsapp/i,
  /\btel\b/i,
  /national_id/i,
  /\bcode\b/i,
  /sku/i,
  /barcode/i,
  /employee_number/i,
  /account_number/i,
  /\biban\b/i,
  /\bswift\b/i,
  /check_number/i,
  /voucher_number/i,
  /vf_number/i,
  /ref_number/i,
  /tax_number/i,
  /bank_account/i,
  /postal_code/i,
  /zip_code/i,
  /commercial_register/i,
  /id_number/i,
];


// ─────────────────────────────────────────────────────────────
// §04  Sheet Utilities
// ─────────────────────────────────────────────────────────────

/**
 * getSheet — يُنشئ أو يجلب شيتاً بالاسم.
 * يضمن وجود جميع الأعمدة المطلوبة (يضيف الناقص في النهاية).
 * كما يضمن حماية أي عمود رقم-نصي (هاتف/كود...) من فقدان الصفر الأول
 * عبر ضبط صيغته على '@' فور إنشاء الشيت أو إضافة العمود.
 *
 * @param {string}   name          اسم الشيت
 * @param {string[]} [customHeaders] headers مخصصة (اختياري)
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */


// For compatibility with old code — simple wrappers over readSheet


// [FIX-AUDIT] the old getShipments() was removed from here — it was defined twice in the
// project (here and in Code_Sales_Shipping.gs). Because GAS merges all .gs files into a single
// scope, one definition silently overrode the other depending on file load order, with no
// error or warning. The version kept (Code_Sales_Shipping.gs) is the newer one: it filters
// out deleted shipments (deleted_at) and reads timeline_json, and has a fallback to read
// old sheets without the new columns.


// ✅ extracts the voucher number from a movement's id
// IN-N4AUOIN2-1 → IN-N4AUOIN2  |  IN-N4AUOIN2 → IN-N4AUOIN2


// [FIX-ISSUE-010] guaranteed-unique sequential numbering via PropertiesService instead of Math.random()
// produces: RCV-2026-00001 / PAY-2026-00001 / TRF-2026-00001


// ── _getNextSequentialCode ──────────────────────────────────────────────────
// [AUTO-CODE] a generic sequential counter (1, 2, 3...) for any "code" field — cash box, cost
// center, employee, department, shipping company, party category... each entity has its own counterKey
// so its sequence is entirely independent of every other entity (cash box #1 is unrelated to employee #1).
//
// [FIX-ROOT-DRIFT] the old version of this function used to store a separate counter in
// PropertiesService and just increment it by 1 — without ever checking the sheet
// again. So if the last record was deleted, or its code was edited manually, the stored counter
// would keep incrementing from a number higher than what actually exists (a permanent gap instead
// of reusing the freed-up number) — the exact same problem as _getNextPartyCode that was fixed
// before. This function is now just a thin wrapper over the central
// AutoNumberService (Code_46_AutoNumberService.js) service, which always computes the next
// number from the highest code that actually exists in the sheet at call time — with no
// separate stored counter that could drift from reality.
//
// existingCodesFn (optional): called on every invocation (not just once) —
// returns the numeric codes that actually exist in the sheet right now.
// Note: the same function is used both for preview (when opening the "add new" modal) and for the
// default value at save time if the field arrives empty — but the binding duplicate check
// happens *afterward*, inside each addXxx handler, via a direct check against the sheet
// (not relying on the suggested value here), so there's no collision risk even if
// more than one user has the modal open at the same moment.


// ─────────────────────────────────────────────────────────────
// §05  Validation Helpers
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §06  Password & Auth Helpers  (private — prefix: _)
// ─────────────────────────────────────────────────────────────


// A helper function for compatibility with old code (SHA-256 without salt)
// ⚠️ [SEC-NOTE] this function is read-only — never used to save new passwords
// ✅ automatic upgrade to sha256s (with salt) happens in _checkPassword on first login
// 📌 [COA-V2 CLEANUP-2026-08] migrateLegacyPasswords() was removed (it was
// an optional manual tool) — the automatic upgrade on first login is sufficient and has
// always been the primary supported path.


// ─────────────────────────────────────────────────────────────

// ┄┄┄ [Source: Code.js lines 2698-4032] Authentication + Users CRUD ┄┄┄
// §11  Authentication
//
// login()             — verifies login credentials
// ensureDefaultUsers()— creates the default users if they don't exist
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// §SEC-1  Rate Limiting — protection against brute-force attacks
// ─────────────────────────────────────────────────────────────

var RATE_LIMIT = {
  MAX_ATTEMPTS: 5, // number of attempts allowed before lockout
  LOCK_MINUTES: 15, // lockout duration in minutes
  WINDOW_MINUTES: 30, // the counter window (attempts reset after this if not locked out)
};


// ─────────────────────────────────────────────────────────────
// §SEC-2  Session Token System — secure session management
// ─────────────────────────────────────────────────────────────

var SESSION_CONFIG = {
  TIMEOUT_HOURS: 8, // total session duration
  IDLE_TIMEOUT_MINUTES: 60, // expires after inactivity
  TOKEN_LENGTH: 32, // token length
  MAX_SESSIONS_PER_USER: 3, // max concurrent sessions
};


/**
 * يُرجع قائمة كل الجلسات النشطة حاليًا في النظام (لكل المستخدمين)،
 * لعرضها في شاشة إدارية (مراقبة من هو متصل الآن).
 *
 * @param {String} callerUser - اسم المستخدم الذي يطلب البيانات (لفحص الصلاحية).
 * @param {String} sessionToken - توكن جلسة المستخدم الحالي.
 * @returns {{success: Boolean, data: Array<Object>=, total: Number=, message: String=}}
 */
function getActiveSessions(callerUser, sessionToken) {
  var permErr = _checkPermission(callerUser, "viewAuditLog", sessionToken);
  if (permErr) return permErr;
  try {
    var props = PropertiesService.getScriptProperties();
    var allProps = props.getProperties();
    var now = Date.now();
    var sessions = [];
    Object.keys(allProps).forEach(function (k) {
      if (k.indexOf("sess_") !== 0) return;
      try {
        var s = JSON.parse(allProps[k]);
        if (now <= s.expires_at && now <= s.idle_expires_at) {
          sessions.push({
            username: s.username,
            created_at: new Date(s.created_at).toISOString(),
            expires_at: new Date(s.expires_at).toISOString(),
            last_activity: new Date(s.last_activity).toISOString(),
            idle_remaining_minutes: Math.ceil(
              (s.idle_expires_at - now) / 60000,
            ),
          });
        }
      } catch (e) {
        console.error("getActiveSessions - خطأ:", e.message || e);
      }
    });
    return { success: true, data: sessions, total: sessions.length };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * getSessionStatus — v4.1: يُعيد حالة الجلسة + وقت الانتهاء
 * يُستدعى من الـ frontend كل دقيقة لمراقبة الجلسة وتحذير المستخدم
 */
function getSessionStatus(token) {
  if (!token) return { valid: false, reason: "no_token" };
  try {
    var props = PropertiesService.getScriptProperties();
    var sessData = props.getProperty("sess_" + token);
    if (!sessData) return { valid: false, reason: "not_found" };
    var sess = JSON.parse(sessData);
    var now = Date.now();
    if (now > sess.expires_at) return { valid: false, reason: "expired" };
    if (now > sess.idle_expires_at) return { valid: false, reason: "idle" };

    var idleRemainingMs = sess.idle_expires_at - now;
    var totalRemainingMs = sess.expires_at - now;

    // update last_activity and extend the idle window
    sess.last_activity = now;
    sess.idle_expires_at =
      now + SESSION_CONFIG.IDLE_TIMEOUT_MINUTES * 60 * 1000;
    props.setProperty("sess_" + token, JSON.stringify(sess));

    return {
      valid: true,
      username: sess.username,
      idleRemainingMinutes: Math.ceil(idleRemainingMs / 60000),
      totalRemainingMinutes: Math.ceil(totalRemainingMs / 60000),
      // تحذير لو أقل من 5 دقائق
      showWarning:
        idleRemainingMs < 5 * 60 * 1000 || totalRemainingMs < 5 * 60 * 1000,
    };
  } catch (e) {
    return { valid: false, reason: "error" };
  }
}


// ─────────────────────────────────────────────────────────────
// [SEC-FIX-AUDIT] Audit Log — أرشفة وتنظيف أسبوعي تلقائي
// ─────────────────────────────────────────────────────────────

/**
 * AUDIT_LOG_CONFIG — إعدادات سياسة الاحتفاظ بسجلات التدقيق
 * MAX_ROWS        : الحد الأقصى للصفوف قبل الأرشفة (5000)
 * ARCHIVE_KEEP    : عدد الصفوف التي تبقى بعد الأرشفة (1000 الأحدث)
 * ARCHIVE_FOLDER  : اسم مجلد الأرشيف في Drive (يُنشأ تلقائياً إن لم يكن موجوداً)
 */
var AUDIT_LOG_CONFIG = {
  MAX_ROWS: 5000,
  ARCHIVE_KEEP: 1000,
  ARCHIVE_FOLDER: "MOO.ERP — AuditLog Archives",
};


// ─────────────────────────────────────────────────────────────
// §SEC-3  Password Strength Validation
// ─────────────────────────────────────────────────────────────

// [SEC-FIX-9] سياسة كلمة مرور أقوى
var PASSWORD_POLICY = {
  MIN_LENGTH: 8,
  REQUIRE_NUMBER: true,
  REQUIRE_UPPER: true,
  REQUIRE_LOWER: true, // ✅ [FORCE-PW-1] حرف صغير واحد على الأقل
  REQUIRE_SPECIAL: true,
};


// ─────────────────────────────────────────────────────────────
// §11  Authentication  (login مُحسَّنة بالحماية الأمنية)
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §FORCE-PW  Force Password Change on First Login
//
// changeForcedPassword() — الدالة الوحيدة المسموح استدعاؤها من شاشة
// "تغيير كلمة المرور الإلزامي" بعد أول تسجيل دخول (أو بعد إعادة تعيين
// كلمة المرور من المدير). لا تمر عبر _checkPermission (لا تحتاج
// صلاحية معيّنة) لأنها فعل ذاتي (self-service) يجب أن يبقى متاحًا
// حتى للمستخدم المحظور مؤقتًا من كل شيء آخر بسبب force_password_change.
//
// Workflow:
// 1. التحقق من الجلسة (validateSession) ومطابقتها لنفس username.
// 2. التحقق من كلمة المرور الحالية (المؤقتة) عبر _checkPassword.
// 3. التحقق من قوة كلمة المرور الجديدة (PASSWORD_POLICY).
// 4. رفض احتواء كلمة المرور الجديدة على اسم المستخدم أو البريد.
// 5. رفض إعادة استخدام كلمة المرور الحالية (المؤقتة) أو أي كلمة مرور
//    سابقة مخزّنة في password_history (يدعم سياسة "آخر N" مستقبلاً).
// 6. عند النجاح: تشفير كلمة المرور الجديدة، تصفير force_password_change،
//    تسجيل password_changed_at، تحديث password_history، وكتابة Audit Log.
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §12  Users CRUD
// ─────────────────────────────────────────────────────────────

// [SEC-FIX-7] getUsers تقبل الآن callerUser اختياري — إذا أُرسل يتحقق منه
// (الباكيند الداخلي يستدعيها بدون callerUser بشكل شرعي - مثل doGet prefetch)


// ─────────────────────────────────────────────────────────────
// §NEW  _propagateUserRename — نشر تغيير اسم المستخدم (username) في كل
// الأماكن التي تخزّنه كمرجع: UserPermissions، الجداول التشغيلية (عبر
// _propagateUserNameChange نفسها المستخدمة لتغيير الاسم الكامل)، وإنهاء
// كل الجلسات النشطة الخاصة بالاسم القديم.
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §NEW  _destroyAllUserSessions — يحذف كل الجلسات النشطة لمستخدم معيّن
// (يُستخدم عند تغيير اسم المستخدم لإجباره على تسجيل دخول جديد).
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §NEW  _propagateUserNameChange — نشر تغيير الاسم في كل الجداول
// يُحدّث عمود "user" في: Transactions، ProductionOrders، Shipments
// وعمود "details" في AuditLog لو ذُكر الاسم القديم
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §NEW  renameUser — واجهة مخصصة لتغيير الاسم الكامل فقط (للمدير)
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// ┄┄┄ [مصدر: Code.js سطور 7773-8087] Audit Log ┄┄┄
// §19  Audit Log
//
// _writeAuditLog()  — يكتب سجل عملية (private — استدعها في كل CRUD)
// getAuditLog()     — يجلب السجل مع فلترة
// clearAuditLog()   — يمسح السجل (admin فقط)
// exportAuditLogCSV()— تصدير CSV
//
// النظام يحتفظ بآخر 5000 سجل فقط لتجنب تضخم الشيت.
// ─────────────────────────────────────────────────────────────
// ← v4.1: أضفنا old_value + new_value لتتبع التغييرات بدقة
var AUDIT_HEADERS = [
  "timestamp",
  "user",
  "action",
  "table",
  "record_id",
  "details",
  "ip",
  "old_value", // ← v4.1: القيمة قبل التعديل (JSON)
  "new_value", // ← v4.1: القيمة بعد التعديل (JSON)
];


/**
 * يكتب سجلًا واحدًا في شيت AuditLog. تُستدعى من داخل كل دالة
 * إضافة/تعديل/حذف مهمة عبر المشروع لتوثيق من فعل ماذا ومتى.
 *
 * Business Rules:
 * - يترجم اسم المستخدم (username) إلى الاسم الكامل (full_name) للعرض،
 *   إلا إذا مُرِّر entry.displayName جاهزًا مسبقًا (PERF-2، لتفادي
 *   قراءة شيت Users بالكامل عند كل عملية تدقيق).
 * - القيم "SYSTEM" و"SCHEDULED_TRIGGER" تُعتبر مستخدمين نظاميين ولا
 *   تُترجَم.
 * - old_value/new_value تُحوَّل تلقائيًا إلى JSON إن كانت كائنات.
 *
 * Side Effects:
 * - أي خطأ أثناء الكتابة يُبتلع بصمت (console.warn فقط) حتى لا يوقف
 *   العملية الأساسية بسبب فشل التسجيل في سجل التدقيق.
 *
 * @param {Object} entry - { user, action, table, record_id, details,
 *   ip, old_value, new_value, displayName }.
 */


// ════════════════════════════════════════════════════════════════
//  15. دالة مسح السجل (للـ admin فقط)
// ════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════
//  16. تصدير السجل كـ CSV
// ════════════════════════════════════════════════════════════════


// ============================================================
//  💾  النسخ الاحتياطي التلقائي
// ============================================================

/**
 * createBackup — ينشئ نسخة من الـ Spreadsheet على Drive
 * يُجدول تلقائياً يومياً عبر Apps Script Triggers
 *
 * الإعداد: Apps Script → Triggers → Add Trigger:
 *   Function: scheduledDailyBackup
 *   Event: Time-driven → Day timer → 3am
 */
// ─────────────────────────────────────────────────────────────

// ┄┄┄ [مصدر: Code.js سطور 8088-8922] Backup System ┄┄┄
// §20  Backup System  (v4.2 — Backup via Admin Email)
//
// createBackup()         — يُنشئ نسخة احتياطية ويبعتها للأدمن
// scheduledDailyBackup() — يُستدعى من Trigger اليومي
// getBackupStatus()      — معلومات آخر باكاب
// setupBackupTrigger()   — يُنشئ Trigger يومي (شغّله مرة واحدة)
//
// v4.2: الباكاب بيتبعت على إيميل الأدمن مباشرةً
//        بدل ما يتحفظ على Drive بتاع الناشر
// ─────────────────────────────────────────────────────────────


// ============================================================
//  🎨  CSS_COLOR_MAP الموحّدة (نسخة واحدة مرجعية في الباكاند)
// ============================================================
//
//  هذه هي النسخة الرسمية الوحيدة — يجب أن تطابق CSS_COLOR_MAP
//  في JavaScript.html تماماً. القاعدة:
//    black → #111111 (وليس #000000 لأن الأسود الكامل قاسٍ على العين)
// ============================================================

var CSS_COLOR_MAP_MASTER = {
  // ── أحمر / ورد ────────────────────────────────────────────
  أحمر: "#ef4444",
  احمر: "#ef4444",
  red: "#ef4444",
  خمري: "#9b2335",
  خمرى: "#9b2335",
  maroon: "#800000",
  نبيذي: "#722f37",
  نبيتي: "#722f37",
  wine: "#722f37",
  وردي: "#f472b6",
  وردى: "#f472b6",
  ورده: "#f9a8d4",
  pink: "#ec4899",
  "وردي فاتح": "#f9a8d4",
  "باودر بينك": "#fce7f3",
  سلموني: "#fa8072",
  salmon: "#fa8072",
  مرجاني: "#ff6b6b",
  coral: "#ff7f50",
  بوردو: "#800020",
  فوشيا: "#ff00ff",
  fuchsia: "#ff00ff",
  // ── برتقالي / أصفر ────────────────────────────────────────
  برتقالي: "#f97316",
  برتقالى: "#f97316",
  orange: "#f97316",
  أصفر: "#eab308",
  اصفر: "#eab308",
  yellow: "#eab308",
  ذهبي: "#d97706",
  ذهبى: "#d97706",
  gold: "#d4af37",
  كريمي: "#f5f0dc",
  كريمى: "#f5f0dc",
  cream: "#fffdd0",
  بيج: "#f5deb3",
  beige: "#f5deb3",
  شامبين: "#f7e7ce",
  كاميل: "#c19a6b",
  خاكي: "#c3b091",
  خاكى: "#c3b091",
  khaki: "#c3b091",
  تيراكوتا: "#e2725b",
  terracotta: "#e2725b",
  ليموني: "#bef264",
  ليمونى: "#bef264",
  lime: "#84cc16",
  // ── أخضر ──────────────────────────────────────────────────
  أخضر: "#22c55e",
  اخضر: "#22c55e",
  green: "#22c55e",
  زيتي: "#6b7c3c",
  زيتى: "#6b7c3c",
  olive: "#808000",
  "أخضر زجاجي": "#2e8b57",
  "أخضر نعناع": "#98ff98",
  "أخضر غابة": "#228b22",
  سيدج: "#b2ac88",
  sage: "#b2ac88",
  // ── أزرق / سماوي ──────────────────────────────────────────
  أزرق: "#3b82f6",
  ازرق: "#3b82f6",
  blue: "#3b82f6",
  كحلي: "#1e3a5f",
  كحلى: "#1e3a5f",
  navy: "#001f5b",
  نيلي: "#4338ca",
  نيلى: "#4338ca",
  indigo: "#4f46e5",
  تيل: "#0d9488",
  teal: "#0d9488",
  فيروزي: "#06b6d4",
  فيروزى: "#06b6d4",
  cyan: "#06b6d4",
  تركوازي: "#40e0d0",
  تركواز: "#40e0d0",
  turquoise: "#40e0d0",
  سماوي: "#38bdf8",
  سماوى: "#38bdf8",
  // ── بنفسجي / لافندر ───────────────────────────────────────
  بنفسجي: "#a855f7",
  بنفسجى: "#a855f7",
  purple: "#9333ea",
  لافندر: "#e6e6fa",
  lavender: "#e6e6fa",
  موف: "#e0b0ff",
  mauve: "#e0b0ff",
  // ── أبيض / رمادي / أسود ───────────────────────────────────
  أبيض: "#f8fafc",
  ابيض: "#f8fafc",
  white: "#ffffff",
  "أوف وايت": "#f5f0e8",
  "اوف وايت": "#f5f0e8",
  فضي: "#94a3b8",
  فضى: "#94a3b8",
  silver: "#c0c0c0",
  رمادي: "#6b7280",
  رمادى: "#6b7280",
  grey: "#9ca3af",
  gray: "#9ca3af",
  أنثراسايت: "#374151",
  انثراسايت: "#374151",
  أسود: "#111111",
  اسود: "#111111",
  black: "#111111", // ← موحّد: #111111
  // ── بني ───────────────────────────────────────────────────
  بني: "#92400e",
  بنى: "#92400e",
  brown: "#7c3f00",
};

// ── كود مختصر (3 أحرف) لكل لون معروف — يطابق COLOR_CODE_MAP في
//    07_JS_Shipping_Colors_Excel.html (خريطة العرض السريع بالفرونت)
var COLOR_CODE_MAP_MASTER = {
  أحمر: "RED",
  احمر: "RED",
  red: "RED",
  أسود: "BLK",
  اسود: "BLK",
  black: "BLK",
  أبيض: "WHT",
  ابيض: "WHT",
  white: "WHT",
  أزرق: "BLU",
  ازرق: "BLU",
  blue: "BLU",
  أخضر: "GRN",
  اخضر: "GRN",
  green: "GRN",
  أصفر: "YEL",
  اصفر: "YEL",
  yellow: "YEL",
  بني: "BRN",
  بنى: "BRN",
  brown: "BRN",
  بيج: "BEI",
  beige: "BEI",
  رمادي: "GRY",
  رمادى: "GRY",
  grey: "GRY",
  gray: "GRY",
  كحلي: "NVY",
  كحلى: "NVY",
  navy: "NVY",
  زيتي: "OLV",
  زيتى: "OLV",
  olive: "OLV",
  بنفسجي: "PRP",
  بنفسجى: "PRP",
  purple: "PRP",
  وردي: "PNK",
  وردى: "PNK",
  ورده: "PNK",
  pink: "PNK",
  برتقالي: "ORG",
  برتقالى: "ORG",
  orange: "ORG",
  ذهبي: "GLD",
  ذهبى: "GLD",
  gold: "GLD",
  فضي: "SLV",
  فضى: "SLV",
  silver: "SLV",
  تركوازي: "TRQ",
  تركواز: "TRQ",
  turquoise: "TRQ",
  نبيتي: "WNE",
  نبيذي: "WNE",
  wine: "WNE",
  كريمي: "CRM",
  كريمى: "CRM",
  cream: "CRM",
  سلموني: "SAL",
  salmon: "SAL",
  تيل: "TEL",
  teal: "TEL",
  خمري: "MAR",
  خمرى: "MAR",
  maroon: "MAR",
  نيلي: "IND",
  نيلى: "IND",
  indigo: "IND",
  فيروزي: "CYN",
  فيروزى: "CYN",
  cyan: "CYN",
  سماوي: "SKY",
  سماوى: "SKY",
  ليموني: "LIM",
  ليمونى: "LIM",
  lime: "LIM",
  خاكي: "KHK",
  خاكى: "KHK",
  khaki: "KHK",
  تيراكوتا: "TER",
  terracotta: "TER",
  مرجاني: "COR",
  coral: "COR",
  بوردو: "BUR",
  فوشيا: "FUC",
  fuchsia: "FUC",
  لافندر: "LAV",
  lavender: "LAV",
  موف: "MAU",
  mauve: "MAU",
  سيدج: "SGE",
  sage: "SGE",
  أنثراسايت: "ANT",
  انثراسايت: "ANT",
  شامبين: "CHM",
  كاميل: "CAM",
};


// ── Get All Data ──────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// [PERF-LOGIN-LIGHT]  getAllDataLight — حزمة تسجيل الدخول الخفيفة
// ترجع فقط البيانات اللي لوحة التحكم محتاجاها:
//   items - stock - openingStock - groups - warehouses - colors - sizes
//   - companySettings - users - roles - permissions - userOverrides - last_backup
// البيانات التقيلة (transactions - invoices - customers - suppliers
//   - productionOrders - shipments) تتحمل lazy بعد رسم الداشبورد.
// ─────────────────────────────────────────────────────────────
var LIGHT_CACHE_KEY = "wms_light_v1"; // ← [FIX] رُفعت لمستوى الملف عشان _invalidateServerCache تقدر تمسحها
// [CACHE-ENGINE / المرحلة 13 — P1] LIGHT_CACHE_TTL (300 ثانية) هي بالظبط
// CACHE_POLICY.LIGHT_BUNDLE — دلوقتي بتستخدم القيمة الموحّدة من السياسة
// بدل ما تتكرر كرقم منفصل هنا. مفتاح واحد فقط (بدون تقسيم/chunking)
// زي ما كان بالظبط — الحزمة الخفيفة أصلاً مصمَّمة تفضل تحت حد الـ 100KB.


// ─────────────────────────────────────────────────────────────
// §CACHE  Server-Side Cache — CacheService لتسريع getAllData
// ✅ مُعمَّمة (cacheKey اختياري) — تُستخدم أيضاً لكاش _loadAllData (AI)
//
// [CACHE-ENGINE / المرحلة 13 — استثناء مقصود] هذا القسم (وحتى نهاية
// _clearOneServerCache وما يستخدمها) **لم يُدمَج** مع CacheEngine
// المركزي، وده قرار متعمد مش سهو: CacheEngine.get/set بيتعاملوا مع
// مفتاح واحد فقط (حد Google الفعلي 100KB/مفتاح)، بينما getAllData()
// هنا أكبر من كده فبيتقسّم يدوياً لعدة مفاتيح (chunking عبر
// cacheKey + "_chunks" + cacheKey + "_0"، "_1"...). فرض CacheEngine
// الحالي على البيانات دي كان هيقطع البيانات بصمت (silent truncation)
// أو يرمي خطأ عند أي getAllData حقيقي — وده يكسر لوحة التحكم بالكامل.
// لو حبينا ندمجها مستقبلاً، لازم أول حاجة نضيف دعم chunking فعلي
// جوه CacheEngine نفسه (namespace + get/setChunked)، مش نستخدم
// get/set العاديين زي ما هما.
// ─────────────────────────────────────────────────────────────

// ✅ [FIX-PERM-CACHE] بصمة (fingerprint) لقائمة الصلاحيات الحالية —
// بتتغيّر تلقائياً كل ما نضيف/نحذف/نعدّل صلاحية في ALL_PERMISSIONS.
// المشكلة اللي كانت بتحصل: getAllData() كانت بتتكاش لمدة 25 دقيقة،
// فلما نضيف صلاحية جديدة (زي viewWhatsappCenter) ونعمل Deploy، الكاش
// القديم (المحفوظ في CacheService، وده شيء منفصل عن الكود ولا يُمسح
// تلقائياً عند الـ Deploy) كان لسه شغّال وراجع roles.admin بدون
// الصلاحية الجديدة → الأدمن نفسه يظهر له "ليس لديك صلاحية" لحد ما
// الكاش يخلص (25 دقيقة) أو حد يمسحه يدوياً.
// الحل: مفتاح الكاش بقى يتضمن fingerprint الصلاحيات، فلو القائمة
// اتغيّرت، يتولّد مفتاح كاش جديد تلقائياً ويتجاهل القديم فوراً —
// بدون انتظار TTL وبدون أي تدخل يدوي.


// ✅ كاش getAllData الرئيسي — مفتاحه مرتبط ببصمة الصلاحيات (_permissionsFingerprint)
// حتى يُبطَل تلقائيًا عند أي تغيير في بنية الصلاحيات (ALL_PERMISSIONS)
var SERVER_CACHE_KEY = "wms_alldata_v2_" + _permissionsFingerprint();
var SERVER_CACHE_TTL = 1500; // 25 دقيقة (بالثواني)

// ✅ كاش مستقل لبيانات مساعد الـ AI (_loadAllData) — schema مختلف عن getAllData
var AI_DATA_CACHE_KEY = "wms_ai_snapshot_v2_" + _permissionsFingerprint();
var AI_DATA_CACHE_TTL = 1500; // 25 دقيقة (بالثواني) — نفس مدة كاش getAllData


/**
 * يمسح الكاش فوراً — يُستدعى بعد أي تعديل على البيانات
 * ✅ بتمسح كاش getAllData وكاش AI (_loadAllData) معاً دايماً،
 *    لأن أي تعديل بيانات يُبطل الاتنين في نفس الوقت
 * @param {string} [cacheKey] مفتاح كاش إضافي يُمسح أيضاً (نادراً يُستخدم — للتوافق المستقبلي)
 */


// ── Dashboard & Reports ───────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §  Opening Stock CRUD

// ┄┄┄ [مصدر: Code.js سطور 8923-9614] Color Map + Dashboard Stats + Stock Report ┄┄┄
// (Part of §15 Transaction-related data — consider merging)
// ─────────────────────────────────────────────────────────────


// ── استيراد مجمّع من Excel / CSV ─────────────────────────────
// [P9-FIX] أُضيف callerUser و sessionToken — كانت الدالة مكشوفة بلا أي فحص صلاحية


// [H-02 FIX] خريطة رصيد مسبقة الحساب: item_id → إجمالي الكمية في كل المخازن
// بدلاً من فلترة كل شيت Stock من جديد لكل صنف (كان O(عدد الأصناف × عدد صفوف Stock))


// [FIX-BUG-4] أُضيف تحقق من الصلاحية — يُفعَّل فقط لو callerUser مُمرَّر (استدعاء خارجي)
// الاستدعاءات الداخلية بدون params تمر بدون تحقق


// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// §WARMCACHE  Cache Warmer — يحافظ على الكاش ساخناً دايماً
//
// warmCache()         — يجدد الكاش يدوياً أو بـ trigger
// setupWarmCacheTrigger() — يركب trigger كل 4 دقائق (شغّلها مرة واحدة)
// removeWarmCacheTrigger() — يلغي الـ trigger
//
// الهدف: أي مستخدم يفتح الموقع يلاقي البيانات جاهزة في doGet
// بدون ما يستنى قراءة Sheets من الصفر
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// §29  Security Setup  (v4.1 — جديد)
//
// setupSecurityUpgrades() — تهيئة شيتات v4.1 (شغّلها مرة واحدة)
// ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 23470-23637] getAllData Extended ┄┄┄
// §EXT-21  دمج البيانات — getAllData Extended
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * يُستدعى هذه الدالة من loadAllData() في Frontend
 * تدمج البيانات الجديدة مع البيانات الحالية
 */
// [FIX] كل قسم له try/catch منفصل — لو قسم واحد فشل (مثلاً صف تالف في
// شيت معيّن) نرجّع له مصفوفة فاضية بدل ما نُسقط الحزمة بالكامل ونمنع كل
// شاشات المحاسبة/HR (بما فيها الموظفين) من عرض بياناتها.
// [PERF-SPLIT] كانت هذه الدالة نسخة داخلية مكرّرة جوه getAllDataExtended
// نفسها؛ دلوقتي مشتركة بين getAllDataExtendedCore/Lazy عشان الاتنين
// يستخدموا نفس منطق الحماية بدون تكرار كود.


/**
 * ✅ [PERF-SPLIT] الجزء التفصيلي (Lazy) من الحزمة الموسعة: كل القوائم
 * المعاملاتية الكبيرة اللي بتكبر مع الوقت (قيود، سندات، فواتير مرتبطة
 * بمحاسبة، حضور، موظفين، أصول ثابتة...). راجع تعليق getAllDataExtendedCore
 * أعلاه لشرح سبب التقسيم بالكامل.
 */


// ✅ [DATA-UNIFY] مفاتيح ومدة كاش الحزمة الموسعة (محاسبة + HR)
// [PERF-SPLIT] الاسم القديم EXT_DATA_CACHE_KEY مُبقى فقط عشان
// _invalidateExtCache تكنس أي كاش قديم متبقي من نسخة سابقة من الكود.
var EXT_DATA_CACHE_KEY = "wms_extdata_v1"; // legacy — لم تعد تُكتب من جديد
var EXT_DATA_CORE_CACHE_KEY = "wms_extdata_core_v1";
// [PERF-SPLIT-2026-07-28] الاسم القديم مُبقى فقط عشان _invalidateExtCache
// تكنس أي كاش قديم متبقي من نسخة سابقة (getAllDataExtendedLazy الموحّدة)
var EXT_DATA_LAZY_CACHE_KEY = "wms_extdata_lazy_v1"; // legacy
var EXT_DATA_LAZY_ACC_CACHE_KEY = "wms_extdata_lazy_acc_v1";
var EXT_DATA_LAZY_HR_CACHE_KEY = "wms_extdata_lazy_hr_v1";
// [PERF-FINANCE-LIGHT-2026-08-08] كروت الداشبورد (إيرادات/مبيعات اليوم،
// ذمم مدينة/دائنة) كانت بتعتمد على saleInvoices/purchaseInvoices الكاملة
// (ON_DEMAND، تشمل lines_json الثقيل) اللي أصلاً مش بتتحمّل غير لما
// المستخدم يفتح شاشة الفواتير نفسها — فالكروت دي كانت بتفضل صفر دايماً
// في الداشبورد. الحل: حزمة رابعة خفيفة جداً (بدون lines_json/notes)
// بتتحمّل بالتوازي مع Core/Lazy-Acc/Lazy-HR بدل ما نضيف الفواتير
// الكاملة (اللي كانت هي سبب الـ Timeout الأصلي قبل التقسيم — راجع
// [PERF-SPLIT] فوق).
var EXT_DATA_LAZY_FIN_CACHE_KEY = "wms_extdata_lazy_fin_v1";
// [PERF-FINANCE-LIGHT-2026-08-08] مدة أقصر بكثير من EXT_DATA_CACHE_TTL
// (30 دقيقة) عمداً: على عكس المحاسبة/HR، الفواتير بتتغيّر كتير خلال
// اليوم (بيع/شراء جديد)، وإضافة استدعاء _invalidateExtCache() في كل
// نقطة حفظ/تعديل/حذف فاتورة (منطق مالي حساس وطويل في Code_20c_Invoices.js)
// خطر أعلى من فايدته هنا. TTL قصير = أسوأ سيناريو إن كارت الداشبورد
// يتأخر لحد 3 دقائق عن آخر فاتورة، بدل ما يفضل صفر للأبد.
var EXT_DATA_LAZY_FIN_CACHE_TTL = 180;
var EXT_DATA_CACHE_TTL = 1800; // ✅ [PERF-FIX-4] زيادة إلى 30 دقيقة — بيانات المحاسبة/HR لا تتغير بشكل متكرر
// البيانات (HR + محاسبة) لا تتغير بشكل متكرر،
// وعند أي تعديل يُمسح الكاش تلقائياً عبر _invalidateExtCache

// ✅ [DATA-UNIFY] تُستدعى من أي دالة create/update/delete في المحاسبة أو الـ HR
// لإسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل، بدل انتظار انتهاء الـ TTL


// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 31202-31331] Save Wrappers (دوال الحفظ الموحدة) ┄┄┄
// نهاية §WA-CENTER-BACKEND
// ═══════════════════════════════════════════════════════════════════


// إضافة فقط — طلبات الإجازة لا تُعدَّل بعد الإنشاء


// إضافة فقط — طلبات السلف لا تُعدَّل بعد الإنشاء


// إضافة فقط — فترات المرتبات لا تُعدَّل بعد الإنشاء


// إضافة فقط — فواتير الشراء تُلغى لا تُعدَّل


// إضافة فقط — فواتير البيع تُلغى لا تُعدَّل


// إضافة فقط — أوامر التحويل تُلغى لا تُعدَّل


// ═══════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 31677-31844] Missing Aliases + Sheet Organizer ┄┄┄
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// §MISSING-ALIASES — دوال بمسمى مختلف بين DataLayer والـ backend
// ═══════════════════════════════════════════════════════════════════

// DataLayer يستدعي approvePayrollPeriod لكن Code.js يحتوي approvePayroll


// [FIX-AUDIT] diagPartyMovements كانت مذكورة في DOPOST_ALLOWED_FUNCTIONS
// ومستدعاة فعليًا من زرار "تشخيص" في 10_JS_Settings_Search_Parties.html، لكنها
// لم تكن معرَّفة في أي مكان بالمشروع — الزرار كان يفشل دائمًا. التنفيذ التالي
// يفحص شيت Transactions ويرجع نفس البنية اللي الواجهة بالفعل مجهزة تعرضها.


// DataLayer يستدعي getPartyLedger — يعيد حركات الطرف (موردين/عملاء)


// DataLayer يستدعي getItemStatement — يعيد كشف حركة صنف


// [FIX-AUDIT] getTransactionStatement كانت مذكورة في DOPOST_ALLOWED_FUNCTIONS
// ومستدعاة من getItemStatement أعلاه، لكنها لم تكن معرَّفة في أي مكان بالمشروع
// إطلاقًا — أي فتح لكشف حركة صنف من الواجهة كان يفشل فورًا بخطأ
// "getTransactionStatement is not defined". التنفيذ التالي يقرأ شيت
// Transactions ويفلتر بالصنف + المخزن (اختياري) + الفترة الزمنية (اختياري).


// DataLayer يستدعي getAggregatedReport — تقرير مجمّع بالصنف


// ═══════════════════════════════════════════════════════════════════
// نهاية §SAVE-WRAPPERS + §MISSING-ALIASES
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// §SHEET-ORGANIZER — ترتيب وتلوين شيتات الداتابيز حسب القسم
// ═══════════════════════════════════════════════════════════════════

/**
 * أداة صيانة يدوية (تُشغَّل من محرر Apps Script مباشرة، ليست مربوطة
 * بأي زر في الواجهة): ترتّب وتلوّن تبويبات (Tabs) شيتات قاعدة البيانات
 * في Google Sheets حسب مجموعتها المنطقية (مخزون، محاسبة، HR...)
 * لتسهيل التنقل اليدوي على المطوّر داخل ملف الـ Spreadsheet نفسه.
 *
 * [تم التوحيد] كانت هذه الدالة تحتوي قائمة GROUPS خاصة بها ناقصة
 * وغير مُحدَّثة (كانت تفتقد شيتات موديول التصنيع، البنوك، الشحن،
 * Communication Hub، العملاء/الموردين... إلخ)، منفصلة تماماً عن
 * SHEET_FORMAT_CONFIG في Code_Setup.gs. النتيجة: شيتات كتير من غير
 * ترتيب أو تلوين. دلوقتي organizeSheets() بقت مجرد اسم بديل (alias)
 * لـ applySheetFormatting() اللي بقت هي المصدر الوحيد للترتيب والتلوين
 * وتنسيق الخط لكل شيتات النظام — راجعها في Code_Setup.gs.
 *
 * NOTE: لا تأثير لها على بيانات أو سلوك التطبيق — تنظيم بصري فقط.
 */
function organizeSheets() {
  return applySheetFormatting();
}

/**
 * أداة صيانة يدوية: تمسح كل ألوان تبويبات الشيتات (تُرجعها للون
 * الافتراضي)، لعكس تأثير organizeSheets() عند الحاجة.
 */
function resetSheetColors() {
  SpreadsheetApp.getActiveSpreadsheet()
    .getSheets()
    .forEach((s) => s.setTabColor(null));
  Logger.log("🔄 تم مسح كل الألوان");
}

// ═══════════════════════════════════════════════════════════════════
// نهاية §SHEET-ORGANIZER

// ┄┄┄ [مصدر: Code.js سطور 31845-31912] Migration Passwords ┄┄┄
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// §MIGRATION-PASSWORDS — ترقية كلمات المرور القديمة
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// نهاية §MIGRATION-PASSWORDS

/**
 * ============================================================
 * تقرير المراجعة الداخلي — Code_Core.gs
 * (Comment Refactoring فقط — بدون أي تغيير في المنطق أو السلوك)
 * ============================================================
 *
 * ما تم توثيقه:
 * - Header احترافي كامل لبداية الملف (Module/Description/
 *   Responsibilities/Dependencies/Used By).
 * - JSDoc كامل (Params/Returns/Business Rules/Throws حيث ينطبق) لكل
 *   دالة كانت بدون أي تعليق سابق: من نقاط الدخول (doGet/doPost) مرورًا
 *   بمنظومة الجلسات الكاملة (create/validate/refresh/destroy/logout/
 *   cleanup)، سياسة كلمة المرور، Users CRUD (add/update/delete/
 *   ensureDefaultUsers)، Audit Log (write/read/clear/export)، الكاش
 *   على مستوى السيرفر (getAllData وأدوات إبطاله)، الرصيد الافتتاحي
 *   (save/delete)، إحصائيات لوحة التحكم، وأدوات صيانة الشيتات.
 * - JSDoc جماعي واحد يوضّح نمط "Save Dispatcher" الموحّد لعشرين دالة
 *   saveX في نهاية الملف بدل تكرار نفس الشرح 20 مرة (كل دالة سطر واحد
 *   واضح بذاته، لا يحتاج تكرار توثيق الشرط البديهي).
 * - الحفاظ الكامل على كل التعليقات التاريخية القيّمة الموجودة أصلًا
 *   (وسوم [SEC-FIX-N]، [FIX-AUDIT]، [PERF-N]...) لأنها توثّق قرارات
 *   وإصلاحات فعلية حدثت، وليست ضجيجًا يستحق الحذف.
 *
 * أجزاء تحتاج Refactoring مستقبلاً (ملاحظات موجودة أصلاً في الكود، لم
 * تُحل هنا لأن المطلوب توثيق فقط):
 * - ميزة "صلاحيات على مستوى المخزن" (getUserWarehouseAccess/
 *   saveWarehouseAccess) معرَّفة بالكامل في الباك-إند لكن غير موصولة
 *   بأي واجهة حاليًا — تستحق قرارًا: ربطها فعليًا أو حذفها.
 * - getShipments القديمة أُزيلت من هذا الملف سابقًا لوجود تعريف مكرر
 *   في Code_Shipping.gs — يستحق التأكد من عدم وجود تكرارات مشابهة
 *   أخرى بين موديولات Code_*.gs (تحميل GAS لكل الملفات في نطاق واحد
 *   يجعل هذا النوع من التكرار الصامت خطرًا حقيقيًا).
 * - migrateLegacyPasswords و migrateRateLimitKeys أدوات هجرة تُشغَّل
 *   يدويًا مرة واحدة؛ يُفضَّل نقلها لملف "Migrations" منفصل مستقبلًا
 *   بدل بقائها ضمن Core لتقليل حجم الملف الرئيسي (7100+ سطر حاليًا).
 *
 * أجزاء معقدة تستحق انتباهًا خاصًا عند أي تعديل مستقبلي:
 * - doPost: بوابتان أمنيتان متتاليتان (Allowlist ثم فحص الجلسة)
 *   (SEC-FIX-1 وSEC-FIX-4) — أي تعديل هنا له أثر أمني مباشر على كامل
 *   النظام، ويجب اختباره جيدًا قبل النشر.
 * - نظام الكاش المتداخل (SERVER_CACHE، AI_DATA_CACHE، USERS_CACHE)
 *   بمفاتيح مشتقة من _permissionsFingerprint — فهم علاقة الإبطال
 *   (invalidation) بين الثلاثة ضروري قبل تعديل أي منها لتفادي عرض
 *   بيانات قديمة أو صلاحيات غير محدَّثة.
 * - createSession/_cleanUserSessions: منطق فرض الحد الأقصى للجلسات
 *   المتزامنة يعتمد على ترتيب زمني دقيق (created_at) واستثناء صريح
 *   للتوكن الحالي؛ خطأ بسيط هنا قد يقفل جلسة المستخدم للتو بعد تسجيل دخوله.
 *
 * أجزاء تحتاج اختبارات (لا توجد اختبارات آلية حاليًا في المشروع):
 * - login(): كل مسارات الفشل (حساب محظور، كلمة مرور خاطئة، حساب غير
 *   نشط) والترقية التلقائية لتشفير كلمات المرور القديمة.
 * - _doPostHasValidSession + doPost: التأكد أن كل دالة غير عامة
 *   (غير موجودة في DOPOST_PUBLIC_FUNCTIONS) تُرفض فعليًا بدون جلسة صالحة.
 * - _cleanUserSessions: التأكد أن تجاوز الحد الأقصى للجلسات يحذف
 *   الأقدم فقط ولا يحذف الجلسة الحالية أبدًا.
 * - saveOpeningStock: حالة unit_cost فارغة مقابل قيمة صريحة (صفر)،
 *   للتأكد أن "" لا تُفسَّر خطأً كـ 0.
 */
