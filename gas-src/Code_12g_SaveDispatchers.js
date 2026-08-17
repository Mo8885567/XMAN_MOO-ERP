/**
 * ============================================================
 * Module: Code_12g_SaveDispatchers.js
 * (تم فصله تلقائيًا من Code_12_Core.js بتاريخ 2026-08-04 كجزء من
 * إعادة تنظيم الملف الضخم لتقسيمه حسب المسؤولية. نقل نصي فقط لنفس
 * أكواد الدوال بدون أي تعديل في المنطق أو السلوك.)
 * ============================================================
 */

/**
 * نمط موحّد لكل دوال saveX أدناه: DataLayer في الواجهة (00_JS_DataLayer.html)
 * يستدعي saveX(data) كدالة واحدة فقط بدل التفريق بين addX/updateX، فتقرر
 * كل دالة هنا داخليًا: وجود data.id يعني تحديث سجل موجود (update)، وغيابه
 * يعني إنشاء سجل جديد (add). هذا يبسّط منطق الحفظ في الواجهة (زر "حفظ"
 * واحد للفورم سواء كان إضافة أو تعديل) دون تكرار الشرط في كل شاشة.
 *
 * NOTE:
 *   بعض الكيانات (طلبات الإجازة/السلف، فواتير البيع/الشراء، فترات
 *   المرتبات، أوامر التحويل) لا تُعدَّل بعد الإنشاء لأسباب محاسبية أو
 *   تدقيقية (يجب إلغاؤها/عكسها بدل تعديلها)، لذلك دوالها هنا تستدعي
 *   addX دائمًا بغض النظر عن data.id.
 *
 * @param {Object} data - بيانات السجل؛ وجود data.id يفعّل مسار التحديث.
 * @returns {Object} نتيجة addX أو updateX المستدعاة (استجابة موحّدة success/message).
 */
function saveAttendance(data) {
  return data && data.id
    ? updateAttendance(data.id, data)
    : addAttendance(data);
}

function saveBankAccount(data) {
  return data && data.id
    ? updateBankAccount(data.id, data)
    : addBankAccount(data);
}

function saveCashBox(data) {
  return data && data.id ? updateCashBox(data.id, data) : addCashBox(data);
}

function saveChartAccount(data) {
  return data && data.id
    ? updateChartAccount(data.id, data)
    : addChartAccount(data);
}

function saveCustomer(callerUser, data) {
  // [BUG-002 FIX] إضافة callerUser
  return data && data.id
    ? updateCustomer(callerUser, data.id, data)
    : addCustomer(callerUser, data);
}

function saveDepartment(data) {
  return data && data.id
    ? updateDepartment(data.id, data)
    : addDepartment(data);
}

function saveEmployee(data) {
  return data && data.id ? updateEmployee(data.id, data) : addEmployee(data);
}

function saveExpense(data) {
  return data && data.id ? updateExpense(data.id, data) : addExpense(data);
}

function saveItem(data) {
  if (!data || !data.user || !data.sessionToken) return errResponse("جلسة غير صالحة");
  return data && data.id ? updateItem(data.id, data) : addItem(data);
}

function saveJobTitle(data) {
  return data && data.id ? updateJobTitle(data.id, data) : addJobTitle(data);
}

function saveJournalEntry(data) {
  if (!data || !data.callerUser || !data.sessionToken) return errResponse("جلسة غير صالحة");
  return data && data.id
    ? updateJournalEntry(data.id, data)
    : addJournalEntry(data);
}

function saveLeaveRequest(data) {
  return addLeaveRequest(data);
}

function saveLoanRequest(data) {
  return addLoanRequest(data);
}

function savePaymentVoucher(data) {
  return data && data.id
    ? updatePaymentVoucher(data.id, data)
    : addPaymentVoucher(data);
}

function savePayrollPeriod(data) {
  return addPayrollPeriod(data);
}

function saveProductionStage(data) {
  return data && data.id
    ? updateProductionStage(data.id, data)
    : addProductionStage(data);
}

function savePurchaseInvoice(data) {
  return addPurchaseInvoice(data, data && data.sessionToken);
}

function saveReceiptVoucher(data) {
  return data && data.id
    ? updateReceiptVoucher(data.id, data)
    : addReceiptVoucher(data);
}

function saveSaleInvoice(data) {
  return addSaleInvoice(data, data && data.sessionToken);
}

function saveSupplier(callerUser, data) {
  // [BUG-002 FIX] إضافة callerUser
  return data && data.id
    ? updateSupplier(callerUser, data.id, data)
    : addSupplier(callerUser, data);
}

function saveTransaction(data) {
  if (!data || !data.user || !data.sessionToken) return errResponse("جلسة غير صالحة");
  return data && data.id
    ? updateTransaction(data.id, data)
    : addTransaction(data);
}

function saveTransferVoucher(data) {
  return addTransferVoucher(data);
}

function saveUser(data) {
  return data && data.id ? updateUser(data.id, data) : addUser(data);
}

function approvePayrollPeriod(periodId, callerUser, sessionToken) {
  return approvePayroll(periodId, callerUser, sessionToken);
}

