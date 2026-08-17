// ════════════════════════════════════════════════════════════════
// Code_HR.gs — جزء من MOO.ERP Code.js (مقسَّم تلقائيًا في 2026-06-30)
// تم الفصل من Code.js الأصلي مع الحفاظ الكامل على ترتيب وسلوك الكود.
// ════════════════════════════════════════════════════════════════

// [FIX-AUDIT-2026 #4] _hrAuditLog — سجل تدقيق موحّد لكل عمليات HR الحساسة
// ─────────────────────────────────────────────────────────────────────────
// تقرير المراجعة المحاسبية وجد أن Code_HR.gs (2,979 سطر) لا يستدعي
// _writeAuditLog إطلاقاً رغم أن باقي الموديولات (المحاسبة، المبيعات،
// المخزون) تستخدمها 27–46 مرة لكل منها. هذا يعني أن اعتماد/رفض سلفة،
// تعديل بيانات موظف، أو الموافقة على إجازة لا يُسجَّل في سجل التدقيق
// العام — وهي عمليات ذات حساسية مالية مباشرة. هذا الغلاف الرقيق يستدعي
// _writeAuditLog (المعرَّفة في Code_Core.gs) بنفس الصيغة الموحّدة، ولا
// يُفشل العملية الأصلية أبداً لو تعذّرت الكتابة (best-effort).
function _hrAuditLog(
  callerUser,
  action,
  table,
  recordId,
  details,
  oldVal,
  newVal,
) {
  try {
    AuditEngine.log(action, {
      user: callerUser || "SYSTEM",
      table: table,
      record_id: recordId || "",
      details: details || "",
      oldValue: oldVal,
      newValue: newVal});
  } catch (e) {
    Logger.log("[HR-AUDIT] تعذّرت كتابة سجل التدقيق: " + e.message);
  }
}

// ┄┄┄ [مصدر: Code.js سطور 20273-22467] Departments → Payroll ┄┄┄
// §EXT-11  HR — Departments (الأقسام)
// ═══════════════════════════════════════════════════════════════════════════════

// ── getNextEmployeeNumber / getNextDepartmentCode / getNextJobTitleCode ─────
// [AUTO-CODE] معاينة الكود التسلسلي التالي من الواجهة قبل الحفظ.
function getNextEmployeeNumber() {
  return okResponse("", {
    data: _getNextSequentialCode("employee", function () {
      return readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees).map(
        function (r) {
          return r.employee_number;
        },
      );
    }),
  });
}
function getNextDepartmentCode() {
  return okResponse("", {
    data: _getNextSequentialCode("department", function () {
      return readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments).map(
        function (r) {
          return r.code;
        },
      );
    }),
  });
}
function getNextJobTitleCode() {
  return okResponse("", {
    data: _getNextSequentialCode("jobtitle", function () {
      return readSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles).map(
        function (r) {
          return r.code;
        },
      );
    }),
  });
}

function getDepartments(callerUser, sessionToken) {
  try {
    if (callerUser) {
      var _permErr = _checkPermission(
        callerUser,
        "viewDepartments",
        sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return r.is_active !== false && r.is_active !== "FALSE";
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب الأقسام: " + e.message);
  }
}

function addDepartment(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addDepartment",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data || !data.name) return errResponse("اسم القسم مطلوب");
    // [AUTO-CODE] كود القسم تسلسلي تلقائي (1، 2، 3...) لو وصل فاضي.
    if (!data.code || !String(data.code).trim()) {
      data.code = _getNextSequentialCode("department", function () {
        return readSheet(
          "Departments",
          ACCOUNTING_HR_HEADERS.Departments,
        ).map(function (r) {
          return r.code;
        });
      });
    }

    var existing = readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments);
    var dup = existing.find(function (r) {
      return String(r.code) === String(data.code) && r.is_active !== "FALSE";
    });
    if (dup) return errResponse("كود القسم موجود مسبقاً");

    var id = makeId("DEP");
    var now = new Date().toISOString();

    var _depSheet = getSheet("Departments", ACCOUNTING_HR_HEADERS.Departments);
    _appendRowProtected(_depSheet, ACCOUNTING_HR_HEADERS.Departments, [
      id,
      data.code,
      data.name,
      data.parent_id || "",
      data.manager_id || "",
      data.branch || "",
      "TRUE",
      data.notes || "",
      now,
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم إضافة القسم بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة القسم: " + e.message);
  }
}

function updateDepartment(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateDepartment",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet("Departments", ACCOUNTING_HR_HEADERS.Departments);
    var rows = readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("القسم غير موجود");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var fields = ["name", "manager_id", "branch", "is_active", "notes"];
    var updates = {};
    fields.forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, updates); // [PERF-BATCH-1]

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم تحديث القسم بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث القسم: " + e.message);
  }
}

function deleteDepartment(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    // [DELETE-ENGINE-MIGRATION] بدل المنطق اليدوي — DeleteEngine بيعمل نفس
    // الفحص (وظائف مرتبطة) عبر customValidate + بيضيف Archive/Logging موحّد.
    var r = DeleteEngine.delete("department", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-12  HR — Job Titles (الوظائف)
// ═══════════════════════════════════════════════════════════════════════════════

function getJobTitles(callerUser, sessionToken) {
  try {
    if (callerUser) {
      var _permErr = _checkPermission(
        callerUser,
        "viewJobTitles",
        sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return r.is_active !== false && r.is_active !== "FALSE";
    });
    // إثراء باسم القسم
    var depts = readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments, {
      trimStrings: true,
    });
    rows.forEach(function (j) {
      var d = depts.find(function (d) {
        return d.id === j.department_id;
      });
      j.department_name = d ? d.name : "";
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب الوظائف: " + e.message);
  }
}

function addJobTitle(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addJobTitle",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data || !data.title) return errResponse("اسم الوظيفة مطلوب");
    // [AUTO-CODE] كود الوظيفة تسلسلي تلقائي (1، 2، 3...) لو وصل فاضي.
    if (!data.code || !String(data.code).trim()) {
      data.code = _getNextSequentialCode("jobtitle", function () {
        return readSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles).map(
          function (r) {
            return r.code;
          },
        );
      });
    }

    var existing = readSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles);
    var dup = existing.find(function (r) {
      return String(r.code) === String(data.code) && r.is_active !== "FALSE";
    });
    if (dup) return errResponse("كود الوظيفة موجود مسبقاً");

    var id = makeId("JOB");
    var now = new Date().toISOString();

    var _jobSheet = getSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles);
    _appendRowProtected(_jobSheet, ACCOUNTING_HR_HEADERS.JobTitles, [
      id,
      data.code,
      data.title,
      data.department_id || "",
      data.description || "",
      "TRUE",
      now,
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم إضافة الوظيفة بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة الوظيفة: " + e.message);
  }
}

function updateJobTitle(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateJobTitle",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles);
    var rows = readSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الوظيفة غير موجودة");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var fields = ["title", "department_id", "description", "is_active"];
    var updates = {};
    fields.forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, updates); // [PERF-BATCH-1]

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم تحديث الوظيفة بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث الوظيفة: " + e.message);
  }
}

function deleteJobTitle(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("jobTitle", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-13  HR — Employees (الموظفين)
// ═══════════════════════════════════════════════════════════════════════════════

function getEmployees(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser) {
      var _permErr = _checkPermission(
        opts.callerUser,
        "viewEmployees",
        opts.sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });

    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });
    if (opts.department_id)
      rows = rows.filter(function (r) {
        return r.department_id === opts.department_id;
      });
    if (opts.search) {
      var s = opts.search.toLowerCase();
      rows = rows.filter(function (r) {
        return (
          (r.full_name || "").toLowerCase().indexOf(s) !== -1 ||
          (r.employee_number || "").toLowerCase().indexOf(s) !== -1 ||
          (r.national_id || "").indexOf(s) !== -1
        );
      });
    }

    // إثراء
    var depts = readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments, {
      trimStrings: true,
    });
    var jobs = readSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles, {
      trimStrings: true,
    });
    rows.forEach(function (e) {
      var d = depts.find(function (d) {
        return d.id === e.department_id;
      });
      var j = jobs.find(function (j) {
        return j.id === e.job_title_id;
      });
      e.department_name = d ? d.name : "";
      e.job_title_name = j ? j.title : "";
    });

    // [REMEDIATION-8] إخفاء الراتب عن غير المصرَّح لهم — فحص سيرفر إجباري
    rows = _filterSalaryFields(rows, opts.callerUser, opts.sessionToken);

    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب الموظفين: " + e.message);
  }
}

function getEmployee(id, callerUser, sessionToken) {
  try {
    var rows = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    var emp = rows.find(function (r) {
      return r.id === id;
    });
    if (!emp) return errResponse("الموظف غير موجود");

    // إثراء
    var depts = readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments, {
      trimStrings: true,
    });
    var jobs = readSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles, {
      trimStrings: true,
    });
    var d = depts.find(function (d) {
      return d.id === emp.department_id;
    });
    var j = jobs.find(function (j) {
      return j.id === emp.job_title_id;
    });
    emp.department_name = d ? d.name : "";
    emp.job_title_name = j ? j.title : "";

    // البدلات والخصومات
    var allowances = readSheet(
      "EmployeeAllowances",
      ACCOUNTING_HR_HEADERS.EmployeeAllowances,
    );
    var deductions = readSheet(
      "EmployeeDeductions",
      ACCOUNTING_HR_HEADERS.EmployeeDeductions,
    );
    emp.allowances = allowances.filter(function (a) {
      return a.employee_id === id && a.is_active !== "FALSE";
    });
    emp.deductions = deductions.filter(function (d) {
      return d.employee_id === id && d.is_active !== "FALSE";
    });

    // ── [HR-TABS-P1] المستندات والمؤهلات ──
    var docs = readSheet(
      "EmployeeDocuments",
      ACCOUNTING_HR_HEADERS.EmployeeDocuments,
      { trimStrings: true },
    );
    emp.documents = docs
      .filter(function (d) {
        return d.employee_id === id;
      })
      .sort(function (a, b) {
        return String(b.uploaded_at).localeCompare(String(a.uploaded_at));
      });

    var quals = readSheet(
      "EmployeeQualifications",
      ACCOUNTING_HR_HEADERS.EmployeeQualifications,
      { trimStrings: true },
    );
    emp.qualifications = quals
      .filter(function (q) {
        return q.employee_id === id;
      })
      .sort(function (a, b) {
        return String(b.start_date || "").localeCompare(
          String(a.start_date || ""),
        );
      });

    // [REMEDIATION-8] إخفاء الراتب عن غير المصرَّح لهم — فحص سيرفر إجباري
    _filterSalaryFields(emp, callerUser, sessionToken);

    return { success: true, data: emp };
  } catch (e) {
    return errResponse("خطأ في جلب بيانات الموظف: " + e.message);
  }
}

function addEmployee(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addEmployee",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data || !data.full_name) return errResponse("اسم الموظف مطلوب");
    // [AUTO-CODE] كود/رقم الموظف تسلسلي تلقائي (1، 2، 3...) لو وصل فاضي.
    if (!data.employee_number || !String(data.employee_number).trim()) {
      data.employee_number = _getNextSequentialCode("employee", function () {
        return readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees).map(
          function (r) {
            return r.employee_number;
          },
        );
      });
    }

    var existing = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees);
    var dup = existing.find(function (r) {
      return String(r.employee_number) === String(data.employee_number);
    });
    if (dup) return errResponse("رقم الموظف موجود مسبقاً");

    var id = makeId("EMP");
    var now = new Date().toISOString();

    var _empSheet = getSheet("Employees", ACCOUNTING_HR_HEADERS.Employees);
    _appendRowProtected(_empSheet, ACCOUNTING_HR_HEADERS.Employees, [
      id,
      data.employee_number,
      data.full_name,
      data.photo_url || "",
      data.national_id || "",
      data.phone || "",
      data.email || "",
      data.address || "",
      data.department_id || "",
      data.job_title_id || "",
      data.branch || "",
      data.direct_manager_id || "",
      data.hire_date || now.split("T")[0],
      data.birth_date || "",
      data.gender || "MALE",
      data.marital_status || "SINGLE",
      Number(data.basic_salary || 0),
      data.salary_currency || "EGP",
      data.payroll_basis || "MONTHLY",
      data.payment_method || "CASH",
      data.bank_account || "",
      data.bank_name || "",
      "ACTIVE",
      "",
      "",
      now,
      now,
      data.notes || "",
      data.bank_iban || "",
      data.bank_swift || "",
      data.bank_branch || "",
      "FALSE",
      "",
      // ── [HR-TABS-P2] ──
      data.employment_type || "PERMANENT",
      data.probation_end_date || "",
      data.contract_end_date || "",
    ]);

    // إضافة البدلات لو موجودة
    if (data.allowances && data.allowances.length > 0) {
      data.allowances.forEach(function (a) {
        if (a.amount > 0) {
          addEmployeeAllowance({
            employee_id: id,
            allowance_type: a.allowance_type,
            amount: a.amount,
            is_percentage: a.is_percentage || false,
            percentage_value: a.percentage_value || 0,
            currency: a.currency || data.salary_currency || SmartDefaults.get("currency"),
            effective_date: a.effective_date || now.split("T")[0],
          });
        }
      });
    }

    // إضافة الخصومات لو موجودة
    if (data.deductions && data.deductions.length > 0) {
      data.deductions.forEach(function (d) {
        if (d.amount > 0) {
          addEmployeeDeduction({
            employee_id: id,
            deduction_type: d.deduction_type,
            amount: d.amount,
            is_percentage: d.is_percentage || false,
            currency: d.currency || data.salary_currency || SmartDefaults.get("currency"),
            effective_date: d.effective_date || now.split("T")[0],
          });
        }
      });
    }

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    // [FIX-AUDIT-2026 #4] تسجيل إضافة موظف جديد في سجل التدقيق
    _hrAuditLog(
      data.callerUser,
      "ADD_EMPLOYEE",
      "Employees",
      id,
      "إضافة موظف: " + data.full_name + " (" + data.employee_number + ")",
      null,
      {
        full_name: data.full_name,
        basic_salary: Number(data.basic_salary || 0),
      },
    );
    return okResponse("تم إضافة الموظف بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة الموظف: " + e.message);
  }
}

function updateEmployee(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateEmployee",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet("Employees", ACCOUNTING_HR_HEADERS.Employees);
    var rows = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الموظف غير موجود");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // [REMEDIATION-6] Job History بسيط — نسجّل القيمة القديمة *قبل* الكتابة
    // فوقها، لكل حقل من الثلاثة اللي بيؤثروا على تاريخ الموظف الوظيفي/المالي.
    // بنقارن كـ String عشان لا نسجّل "تغيير" وهمي لمجرد اختلاف النوع
    // (مثلاً 5000 رقم مقابل "5000" نص جاي من الفرونت إند).
    var _oldEmpRow = rows[idx];
    var _jobHistoryFields = {
      basic_salary: "SALARY",
      department_id: "DEPARTMENT",
      job_title_id: "JOB_TITLE",
    };
    Object.keys(_jobHistoryFields).forEach(function (f) {
      if (data[f] === undefined) return;
      var oldVal = _oldEmpRow[f];
      var newVal = data[f];
      if (String(oldVal || "") === String(newVal || "")) return; // مفيش تغيير فعلي
      _logEmployeeJobHistory(
        id,
        _jobHistoryFields[f],
        oldVal,
        newVal,
        data.callerUser,
        data.effective_date,
      );
    });

    var fields = [
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
      // ── [HR-TABS-P1] ──
      "notes",
      "bank_iban",
      "bank_swift",
      "bank_branch",
      // ── [HR-TABS-P2] ──
      "employment_type",
      "probation_end_date",
      "contract_end_date",
    ];

    var updates = {}; // [PERF-BATCH-1]
    fields.forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, updates);

    // تحديث updated_at
    var updatedAtCol = headers.indexOf("updated_at");
    if (updatedAtCol !== -1)
      sheet
        .getRange(rowNum, updatedAtCol + 1)
        .setValue(new Date().toISOString());

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    // [FIX-AUDIT-2026 #4] تسجيل تعديل بيانات الموظف في سجل التدقيق العام
    _hrAuditLog(
      data.callerUser,
      "UPDATE_EMPLOYEE",
      "Employees",
      id,
      "تحديث بيانات الموظف: " + (data.full_name || _oldEmpRow.full_name || id),
    );
    return okResponse("تم تحديث بيانات الموظف بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث بيانات الموظف: " + e.message);
  }
}

// [REMEDIATION-6] Job History بسيط — يرجّع سجل تعديلات الراتب/القسم/الوظيفة
// لموظف معيّن، الأحدث أولاً.
// سطور "SALARY" فيها القيمة الفعلية للراتب القديم/الجديد — نفس منطق
// _filterSalaryFields (بند 8) بالظبط: لو المستخدم عنده viewSalary صراحةً
// يشوفها، غير كده بتترجع null (مش تُحذف السطر، عشان يبان إن فيه تغيير حصل
// حتى لو القيمة مخفية). Fail-safe: بدون callerUser → تُخفى افتراضياً.
function getEmployeeJobHistory(employeeId, callerUser, sessionToken) {
  try {
    if (!employeeId) return errResponse("رقم الموظف مطلوب");
    var _permErr = _checkPermission(callerUser, "viewEmployees", sessionToken);
    if (_permErr) return _permErr;

    var canViewSalary = false;
    try {
      canViewSalary =
        !!callerUser &&
        _checkPermission(callerUser, "viewSalary", sessionToken) === null;
    } catch (e) {
      canViewSalary = false;
    }

    var rows = readSheet(
      "EmployeeJobHistory",
      ACCOUNTING_HR_HEADERS.EmployeeJobHistory,
      { trimStrings: true },
    );
    var history = rows
      .filter(function (r) {
        return r.employee_id === employeeId;
      })
      .map(function (r) {
        if (r.change_type === "SALARY" && !canViewSalary) {
          return Object.assign({}, r, {
            old_value_json: null,
            new_value_json: null,
          });
        }
        return r;
      })
      .sort(function (a, b) {
        return new Date(b.created_at) - new Date(a.created_at);
      });

    return { success: true, data: history };
  } catch (e) {
    return errResponse("خطأ في جلب تاريخ الموظف الوظيفي: " + e.message);
  }
}

function deleteEmployee(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "deleteEmployee", sessionToken);
    if (_permErr) return _permErr;
    var rows = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الموظف غير موجود");

    var sheet = getSheet("Employees", ACCOUNTING_HR_HEADERS.Employees);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var statusCol = headers.indexOf("status");
    var termDateCol = headers.indexOf("termination_date");
    var termReasonCol = headers.indexOf("termination_reason");

    if (statusCol !== -1)
      sheet.getRange(idx + 2, statusCol + 1).setValue("TERMINATED");
    if (termDateCol !== -1)
      sheet
        .getRange(idx + 2, termDateCol + 1)
        .setValue(new Date().toISOString().split("T")[0]);
    if (termReasonCol !== -1)
      sheet.getRange(idx + 2, termReasonCol + 1).setValue("تم الحذف يدوياً");

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    // [FIX-AUDIT-2026 #4] تسجيل إنهاء خدمة الموظف في سجل التدقيق
    _hrAuditLog(
      callerUser,
      "TERMINATE_EMPLOYEE",
      "Employees",
      id,
      "تم إنهاء خدمة الموظف " + id + " (تم الحذف يدوياً)",
    );
    return okResponse("تم حذف الموظف بنجاح");
  } catch (e) {
    return errResponse("خطأ في حذف الموظف: " + e.message);
  }
}

/**
 * importEmployeesBulk — استيراد موظفين بالجملة من ملف (CSV/Excel) تم تحليله
 * في الواجهة الأمامية وتحويله إلى مصفوفة كائنات بنفس مفاتيح addEmployee.
 * يدعم الربط بالاسم لكل من القسم (department_name) والوظيفة (job_title_name)
 * بالإضافة للربط المباشر بالـ id لو كانا متوفرين.
 *
 * @param {Object} data { callerUser, sessionToken, rows: [{employee_number, full_name, ...}] }
 */
function importEmployeesBulk(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addEmployee",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var rows = data.rows || [];
    if (!rows.length) return errResponse("لا توجد بيانات للاستيراد");
    if (rows.length > 1000)
      return errResponse("الحد الأقصى 1000 موظف في الملف الواحد");

    var existing = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    var existingNumbers = {};
    existing.forEach(function (r) {
      if (r.employee_number)
        existingNumbers[String(r.employee_number).trim()] = true;
    });

    var depts = readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments, {
      trimStrings: true,
    });
    var jobs = readSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles, {
      trimStrings: true,
    });
    function _findDeptId(name) {
      if (!name) return "";
      var n = String(name).trim();
      var d = depts.find(function (d) {
        return d.name && d.name.trim() === n;
      });
      return d ? d.id : "";
    }
    function _findJobId(name) {
      if (!name) return "";
      var n = String(name).trim();
      var j = jobs.find(function (j) {
        return j.title && j.title.trim() === n;
      });
      return j ? j.id : "";
    }

    var sheet = getSheet("Employees", ACCOUNTING_HR_HEADERS.Employees);
    var now = new Date().toISOString();
    var added = 0;
    var skipped = 0;
    var errors = [];
    var newRows = [];

    // [VALIDATION-FIX] دوال تحقق مشتركة — قبل كده كانت القيم بتتخزن
    // كما هي بدون أي فحص صيغة (إيميل غلط، تاريخ غلط، راتب نص بيتحول
    // لـ 0 بصمت، قيم gender/marital_status/payroll_basis/payment_method
    // خارج النطاق المسموح كانت بتتخزن زي ما هي وتكسر شاشات العرض بعدين)
    // [VALIDATION-ENGINE] موحّدة الآن عبر ValidationEngine بدل دوال محلية
    // هنا فقط — نفس المنطق بالظبط، لكن بقى متاح لأي موديول تاني. راجع
    // Code_36_ValidationEngine.gs.

    rows.forEach(function (r, idx) {
      try {
        var empNo = String(r.employee_number || "").trim();
        var fullName = String(r.full_name || "").trim();
        if (!empNo || !fullName) {
          errors.push({ row: idx + 1, reason: "رقم الموظف أو الاسم مفقود" });
          skipped++;
          return;
        }
        if (existingNumbers[empNo]) {
          errors.push({
            row: idx + 1,
            reason: "رقم الموظف " + empNo + " موجود مسبقاً (تم تخطيه)",
          });
          skipped++;
          return;
        }

        // التحقق من صيغة الإيميل (لو موجود)
        var emailVal = String(r.email || "").trim();
        if (emailVal && !ValidationEngine.isValidEmail(emailVal)) {
          errors.push({
            row: idx + 1,
            reason: "البريد الإلكتروني غير صحيح (" + emailVal + ")",
          });
          skipped++;
          return;
        }

        // التحقق من التواريخ
        if (!ValidationEngine.isValidDateStr(r.hire_date)) {
          errors.push({
            row: idx + 1,
            reason: "تاريخ التعيين غير صحيح (" + r.hire_date + ")",
          });
          skipped++;
          return;
        }
        if (!ValidationEngine.isValidDateStr(r.birth_date)) {
          errors.push({
            row: idx + 1,
            reason: "تاريخ الميلاد غير صحيح (" + r.birth_date + ")",
          });
          skipped++;
          return;
        }

        // التحقق من الراتب الأساسي
        var salaryVal = 0;
        if (
          r.basic_salary !== undefined &&
          r.basic_salary !== null &&
          String(r.basic_salary).trim() !== ""
        ) {
          salaryVal = Number(r.basic_salary);
          if (isNaN(salaryVal) || salaryVal < 0) {
            errors.push({
              row: idx + 1,
              reason: "الراتب الأساسي غير صحيح (" + r.basic_salary + ")",
            });
            skipped++;
            return;
          }
        }

        // التحقق من القوائم المسموحة
        if (!ValidationEngine.isValidEnum(r.gender, ["MALE", "FEMALE"])) {
          errors.push({
            row: idx + 1,
            reason: "النوع غير صحيح (يجب MALE أو FEMALE)",
          });
          skipped++;
          return;
        }
        if (
          !ValidationEngine.isValidEnum(r.marital_status, [
            "SINGLE",
            "MARRIED",
            "DIVORCED",
            "WIDOWED",
          ])
        ) {
          errors.push({
            row: idx + 1,
            reason:
              "الحالة الاجتماعية غير صحيحة (SINGLE/MARRIED/DIVORCED/WIDOWED)",
          });
          skipped++;
          return;
        }
        if (
          !ValidationEngine.isValidEnum(r.payroll_basis, [
            "MONTHLY",
            "PRODUCTION",
            "DAILY",
            "HOURLY",
          ])
        ) {
          errors.push({
            row: idx + 1,
            reason: "أساس الراتب غير صحيح (MONTHLY/PRODUCTION/DAILY/HOURLY)",
          });
          skipped++;
          return;
        }
        if (!ValidationEngine.isValidEnum(r.payment_method, ["CASH", "BANK", "VISA", "WALLET"])) {
          errors.push({
            row: idx + 1,
            reason: "طريقة الدفع غير صحيحة (CASH/BANK/VISA/WALLET)",
          });
          skipped++;
          return;
        }

        existingNumbers[empNo] = true; // يمنع التكرار داخل نفس الملف

        var id = makeId("EMP");
        newRows.push([
          id,
          empNo,
          fullName,
          r.photo_url || "",
          r.national_id || "",
          r.phone || "",
          emailVal,
          r.address || "",
          r.department_id || _findDeptId(r.department_name) || "",
          r.job_title_id || _findJobId(r.job_title_name) || "",
          r.branch || "",
          "",
          r.hire_date || now.split("T")[0],
          r.birth_date || "",
          r.gender ? String(r.gender).trim().toUpperCase() : "MALE",
          r.marital_status
            ? String(r.marital_status).trim().toUpperCase()
            : "SINGLE",
          salaryVal,
          r.salary_currency || "EGP",
          r.payroll_basis
            ? String(r.payroll_basis).trim().toUpperCase()
            : "MONTHLY",
          r.payment_method
            ? String(r.payment_method).trim().toUpperCase()
            : "CASH",
          r.bank_account || "",
          r.bank_name || "",
          "ACTIVE",
          "",
          "",
          now,
          now,
        ]);
        added++;
      } catch (rowErr) {
        errors.push({ row: idx + 1, reason: rowErr.message });
        skipped++;
      }
    });

    newRows.forEach(function (row) {
      _appendRowProtected(sheet, ACCOUNTING_HR_HEADERS.Employees, row);
    });

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse(
      "تم استيراد " +
        added +
        " موظف بنجاح" +
        (skipped ? " · تخطي " + skipped : ""),
      { added: added, skipped: skipped, errors: errors },
    );
  } catch (e) {
    return errResponse("خطأ في استيراد الموظفين: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-14  HR — Employee Allowances & Deductions (البدلات والخصومات)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-14B  HR — Salary Components (بنود الرواتب — إعداد مستقل)
// ═══════════════════════════════════════════════════════════════════════════════
// [SALARY-COMPONENTS-P1] بدلاً من كتابة نوع البدل/الخصم كنص حر مباشرة على الموظف،
// بنود الراتب تُدار هنا مركزياً من مدير النظام، وتُستخدَم كقائمة اختيار فقط.
// لا يوجد أي بند ثابت داخل الكود — كل الأنواع تأتي من هذا الجدول.

function getSalaryComponents(group) {
  try {
    var rows = readSheet(
      "SalaryComponents",
      ACCOUNTING_HR_HEADERS.SalaryComponents,
      { trimStrings: true },
    );
    rows = rows.filter(function (r) {
      return r.is_active !== "FALSE" && r.is_active !== false;
    });
    if (group)
      rows = rows.filter(function (r) {
        return r.component_group === group;
      });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب بنود الرواتب: " + e.message);
  }
}

function addSalaryComponent(data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addSalaryComponent",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data || !data.code || !data.name || !data.component_group)
      return errResponse("كود واسم ونوع البند مطلوبون");
    if (["ALLOWANCE", "DEDUCTION"].indexOf(data.component_group) === -1)
      return errResponse("نوع البند يجب أن يكون بدل أو خصم");

    var existing = readSheet(
      "SalaryComponents",
      ACCOUNTING_HR_HEADERS.SalaryComponents,
    );
    var dup = existing.find(function (r) {
      return String(r.code) === String(data.code) && r.is_active !== "FALSE";
    });
    if (dup) return errResponse("كود البند موجود مسبقاً");

    var id = makeId("SLC");
    var now = new Date().toISOString();

    var _sheet = getSheet(
      "SalaryComponents",
      ACCOUNTING_HR_HEADERS.SalaryComponents,
    );
    _appendRowProtected(_sheet, ACCOUNTING_HR_HEADERS.SalaryComponents, [
      id,
      data.code,
      data.name,
      data.component_group,
      data.default_is_percentage ? "TRUE" : "FALSE",
      "TRUE",
      data.notes || "",
      now,
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم إضافة بند الراتب بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة بند الراتب: " + e.message);
  }
}

function updateSalaryComponent(id, data) {
  _invalidateExtCache();
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateSalaryComponent",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet(
      "SalaryComponents",
      ACCOUNTING_HR_HEADERS.SalaryComponents,
    );
    var rows = readSheet(
      "SalaryComponents",
      ACCOUNTING_HR_HEADERS.SalaryComponents,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("بند الراتب غير موجود");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var fields = ["name", "default_is_percentage", "is_active", "notes"];
    var updates = {};
    fields.forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, updates);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم تحديث بند الراتب بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث بند الراتب: " + e.message);
  }
}

function deleteSalaryComponent(id, callerUser, sessionToken) {
  _invalidateExtCache();
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("salaryComponent", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function getEmployeeAllowances(employeeId) {
  try {
    var rows = readSheet(
      "EmployeeAllowances",
      ACCOUNTING_HR_HEADERS.EmployeeAllowances,
      { trimStrings: true },
    );
    if (employeeId)
      rows = rows.filter(function (r) {
        return r.employee_id === employeeId;
      });
    rows = rows.filter(function (r) {
      return r.is_active !== "FALSE" && r.is_active !== false;
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب البدلات: " + e.message);
  }
}

function addEmployeeAllowance(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addEmployeeAllowance",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    // [SALARY-COMPONENTS-P1] لو اتبعت component_id، نجيب اسم البند منه تلقائياً
    // بدل ما يتكتب كنص حر — allowance_type بيفضل موجود عشان التوافق مع الكود
    // القديم (عرض/تقارير/محرك الرواتب) لسه بيقرأ منه مباشرة.
    var _allowanceTypeName = data ? data.allowance_type : null;
    if (data && data.component_id) {
      var _comp = readSheet(
        "SalaryComponents",
        ACCOUNTING_HR_HEADERS.SalaryComponents,
        { trimStrings: true },
      ).find(function (c) {
        return c.id === data.component_id;
      });
      if (!_comp) return errResponse("بند الراتب المحدد غير موجود");
      if (_comp.component_group !== "ALLOWANCE")
        return errResponse("البند المحدد ليس من نوع البدلات");
      _allowanceTypeName = _comp.name;
    }
    if (!data || !data.employee_id || !_allowanceTypeName)
      return errResponse("الموظف ونوع البدل مطلوبان");

    var id = makeId("ALW");
    var now = new Date().toISOString();

    _appendRowProtected(
      getSheet("EmployeeAllowances", ACCOUNTING_HR_HEADERS.EmployeeAllowances),
      ACCOUNTING_HR_HEADERS.EmployeeAllowances,
      [
        id,
        data.employee_id,
        _allowanceTypeName,
        Number(data.amount || 0),
        data.is_percentage ? "TRUE" : "FALSE",
        Number(data.percentage_value || 0),
        data.currency || "EGP",
        data.effective_date || now.split("T")[0],
        "TRUE",
        now,
        data.component_id || "",
      ],
    );

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم إضافة البدل بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة البدل: " + e.message);
  }
}

function updateEmployeeAllowance(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateEmployeeAllowance",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet(
      "EmployeeAllowances",
      ACCOUNTING_HR_HEADERS.EmployeeAllowances,
    );
    var rows = readSheet(
      "EmployeeAllowances",
      ACCOUNTING_HR_HEADERS.EmployeeAllowances,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("البدل غير موجود");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var fields = [
      "allowance_type",
      "amount",
      "is_percentage",
      "percentage_value",
      "currency",
      "effective_date",
      "is_active",
    ];
    var updates = {}; // [PERF-BATCH-1]
    fields.forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, updates);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم تحديث البدل بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث البدل: " + e.message);
  }
}

function deleteEmployeeAllowance(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("employeeAllowance", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function getEmployeeDeductions(employeeId) {
  try {
    var rows = readSheet(
      "EmployeeDeductions",
      ACCOUNTING_HR_HEADERS.EmployeeDeductions,
      { trimStrings: true },
    );
    if (employeeId)
      rows = rows.filter(function (r) {
        return r.employee_id === employeeId;
      });
    rows = rows.filter(function (r) {
      return r.is_active !== "FALSE" && r.is_active !== false;
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب الخصومات: " + e.message);
  }
}

function addEmployeeDeduction(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addEmployeeDeduction",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    // [SALARY-COMPONENTS-P1] نفس منطق البدلات — component_id اختياري للتوافق
    var _deductionTypeName = data ? data.deduction_type : null;
    if (data && data.component_id) {
      var _comp = readSheet(
        "SalaryComponents",
        ACCOUNTING_HR_HEADERS.SalaryComponents,
        { trimStrings: true },
      ).find(function (c) {
        return c.id === data.component_id;
      });
      if (!_comp) return errResponse("بند الراتب المحدد غير موجود");
      if (_comp.component_group !== "DEDUCTION")
        return errResponse("البند المحدد ليس من نوع الخصومات");
      _deductionTypeName = _comp.name;
    }
    if (!data || !data.employee_id || !_deductionTypeName)
      return errResponse("الموظف ونوع الخصم مطلوبان");

    var id = makeId("DED");
    var now = new Date().toISOString();

    _appendRowProtected(
      getSheet("EmployeeDeductions", ACCOUNTING_HR_HEADERS.EmployeeDeductions),
      ACCOUNTING_HR_HEADERS.EmployeeDeductions,
      [
        id,
        data.employee_id,
        _deductionTypeName,
        Number(data.amount || 0),
        data.is_percentage ? "TRUE" : "FALSE",
        data.currency || "EGP",
        data.effective_date || now.split("T")[0],
        "TRUE",
        now,
        data.component_id || "",
      ],
    );

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم إضافة الخصم بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة الخصم: " + e.message);
  }
}

function updateEmployeeDeduction(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateEmployeeDeduction",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet(
      "EmployeeDeductions",
      ACCOUNTING_HR_HEADERS.EmployeeDeductions,
    );
    var rows = readSheet(
      "EmployeeDeductions",
      ACCOUNTING_HR_HEADERS.EmployeeDeductions,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("الخصم غير موجود");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var fields = [
      "deduction_type",
      "amount",
      "is_percentage",
      "currency",
      "effective_date",
      "is_active",
    ];
    var updates = {}; // [PERF-BATCH-1]
    fields.forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, updates);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم تحديث الخصم بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث الخصم: " + e.message);
  }
}

function deleteEmployeeDeduction(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("employeeDeduction", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-15  HR — Attendance (الحضور والانصراف)
// ═══════════════════════════════════════════════════════════════════════════════

function getAttendance(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser) {
      var _permErr = _checkPermission(
        opts.callerUser,
        "viewAttendance",
        opts.sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet("Attendance", ACCOUNTING_HR_HEADERS.Attendance, {
      trimStrings: true,
    });
    if (opts.employee_id)
      rows = rows.filter(function (r) {
        return r.employee_id === opts.employee_id;
      });
    if (opts.date)
      rows = rows.filter(function (r) {
        return r.date === opts.date;
      });
    if (opts.from_date)
      rows = rows.filter(function (r) {
        return r.date >= opts.from_date;
      });
    if (opts.to_date)
      rows = rows.filter(function (r) {
        return r.date <= opts.to_date;
      });
    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });

    // إثراء
    var emps = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    rows.forEach(function (a) {
      var e = emps.find(function (emp) {
        return emp.id === a.employee_id;
      });
      a.employee_name = e ? e.full_name : "";
      a.employee_number = e ? e.employee_number : "";
    });

    rows.sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب سجلات الحضور: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// getMonthlyAttendanceReport — [VERCEL-MIGRATION][AUDIT-3] كانت
// متنادية من الفرونت (12_JS_HR.html → _loadMonthlyAttendance) بدون
// أي تعريف في الباك إند — شاشة "تقرير الحضور الشهري" كانت معطّلة
// فعليًا حتى على نسخة الويب.
//
// المدخل: { year, month, employee_id } (employee_id اختياري = كل
// الموظفين). المخرج شكل مصفوفة واحدة لكل موظف بنفس الحقول اللي
// الفرونت بيتوقعها بالحرف (_renderMonthlyAttendanceReport في
// 12_JS_HR.html): employee_name, employee_number, working_days,
// present_days, absent_days, late_days, overtime_days, overtime_hours.
// ─────────────────────────────────────────────────────────────
function getMonthlyAttendanceReport(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser) {
      var _permErr = _checkPermission(
        opts.callerUser,
        "viewAttendance",
        opts.sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var year = Number(opts.year);
    var month = Number(opts.month);
    if (!year || !month) return errResponse("السنة والشهر مطلوبان");

    var monthStr = (month < 10 ? "0" : "") + month;
    var prefix = year + "-" + monthStr; // مطابق لصيغة تخزين date بالنظام (YYYY-MM-DD)

    var rows = readSheet("Attendance", ACCOUNTING_HR_HEADERS.Attendance, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return String(r.date || "").indexOf(prefix) === 0;
    });
    if (opts.employee_id)
      rows = rows.filter(function (r) {
        return r.employee_id === opts.employee_id;
      });

    var emps = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    if (opts.employee_id) {
      emps = emps.filter(function (e) {
        return e.id === opts.employee_id;
      });
    }

    // [FIX-ATT-REPORT] أسماء الحالة (status) في Attendance.js زي
    // addAttendance/_calcAttendanceStatus — بنطابق نفس القيم المستخدمة
    // فعليًا في النظام (PRESENT/ABSENT/LATE) بدل افتراض قيم جديدة.
    var byEmployee = {};
    emps.forEach(function (e) {
      byEmployee[e.id] = {
        employee_id: e.id,
        employee_name: e.full_name || "",
        employee_number: e.employee_number || "",
        working_days: 0,
        present_days: 0,
        absent_days: 0,
        late_days: 0,
        overtime_days: 0,
        overtime_hours: 0,
      };
    });

    rows.forEach(function (a) {
      var bucket = byEmployee[a.employee_id];
      if (!bucket) return; // موظف محذوف أو خارج فلتر employee_id
      bucket.working_days++;
      var status = String(a.status || "").toUpperCase();
      if (status === "ABSENT") {
        bucket.absent_days++;
      } else {
        // أي حالة تانية (PRESENT/LATE/...) تُحتسب حضورًا فعليًا
        bucket.present_days++;
        if (status === "LATE" || Number(a.delay_minutes) > 0) {
          bucket.late_days++;
        }
      }
      var ot = Number(a.overtime_hours) || 0;
      if (ot > 0) {
        bucket.overtime_days++;
        bucket.overtime_hours += ot;
      }
    });

    var result = Object.keys(byEmployee)
      .map(function (id) {
        return byEmployee[id];
      })
      .filter(function (r) {
        // [FIX-ATT-REPORT] استبعاد الموظفين اللي مالهمش أي سجل حضور
        // خالص في الشهر ده (بدل ما تظهر صفوف صفرية لكل الموظفين دايمًا)
        return r.working_days > 0;
      });

    result.sort(function (a, b) {
      return String(a.employee_name).localeCompare(String(b.employee_name), "ar");
    });

    return { success: true, data: result };
  } catch (e) {
    return errResponse("خطأ في تحميل تقرير الحضور الشهري: " + e.message);
  }
}

function addAttendance(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addAttendance",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data || !data.employee_id || !data.date)
      return errResponse("الموظف والتاريخ مطلوبان");

    // تحقق من عدم وجود سجل مكرر
    var existing = readSheet("Attendance", ACCOUNTING_HR_HEADERS.Attendance);
    var dup = existing.find(function (r) {
      return r.employee_id === data.employee_id && r.date === data.date;
    });
    if (dup)
      return errResponse("يوجد سجل حضور لهذا الموظف في هذا التاريخ مسبقاً");

    // حساب ساعات العمل والتأخير
    var workHours = 0,
      overtimeHours = 0,
      delayMinutes = 0;
    if (data.check_in && data.check_out) {
      var checkIn = new Date(data.date + "T" + data.check_in);
      var checkOut = new Date(data.date + "T" + data.check_out);
      if (checkOut < checkIn) checkOut.setDate(checkOut.getDate() + 1); // نوبة ليلية
      workHours = (checkOut - checkIn) / (1000 * 60 * 60);

      // حساب التأخير (افتراض بداية 9:00)
      var startTime = new Date(data.date + "T09:00");
      if (checkIn > startTime) {
        delayMinutes = Math.round((checkIn - startTime) / (1000 * 60));
      }

      // حساب الإضافي (أكثر من 8 ساعات)
      if (workHours > 8) {
        overtimeHours = Math.round((workHours - 8) * 100) / 100;
      }
    }

    var status = data.status || "PRESENT";
    if (delayMinutes > 0 && status === "PRESENT") status = "LATE";

    var id = makeId("ATT");
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]

    _appendRowProtected(getSheet("Attendance", ACCOUNTING_HR_HEADERS.Attendance), ACCOUNTING_HR_HEADERS.Attendance, [ // [ENGINE-UNIFY]
      id,
      data.employee_id,
      data.date,
      data.check_in || "",
      data.check_out || "",
      Math.round(workHours * 100) / 100,
      Math.round(overtimeHours * 100) / 100,
      delayMinutes,
      status,
      data.shift_type || "MORNING",
      data.notes || "",
      now,
      user,
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم تسجيل الحضور بنجاح", {
      id: id,
      work_hours: workHours,
      delay_minutes: delayMinutes,
    });
  } catch (e) {
    return errResponse("خطأ في تسجيل الحضور: " + e.message);
  }
}

function updateAttendance(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateAttendance",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    var sheet = getSheet("Attendance", ACCOUNTING_HR_HEADERS.Attendance);
    var rows = readSheet("Attendance", ACCOUNTING_HR_HEADERS.Attendance, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("سجل الحضور غير موجود");

    var rowNum = idx + 2;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var fields = [
      "check_in",
      "check_out",
      "work_hours",
      "overtime_hours",
      "delay_minutes",
      "status",
      "shift_type",
      "notes",
    ];
    var updates = {}; // [PERF-BATCH-1]
    fields.forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    _applyRowUpdates(sheet, rowNum, headers, updates);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم تحديث سجل الحضور بنجاح");
  } catch (e) {
    return errResponse("خطأ في تحديث سجل الحضور: " + e.message);
  }
}

function deleteAttendance(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("attendance", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-16  HR — Leave Types & Requests (أنواع الإجازات وطلباتها)
// ═══════════════════════════════════════════════════════════════════════════════

function getLeaveTypes() {
  try {
    var rows = readSheet("LeaveTypes", ACCOUNTING_HR_HEADERS.LeaveTypes, {
      trimStrings: true,
    });
    rows = rows.filter(function (r) {
      return r.is_active !== false && r.is_active !== "FALSE";
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب أنواع الإجازات: " + e.message);
  }
}

function addLeaveType(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addLeaveType",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data || !data.code || !data.name)
      return errResponse("كود واسم نوع الإجازة مطلوبان");

    // [AUTO-NUMBER-CENTRAL] فحص تكرار كان ناقصًا هنا بالكامل — أي مستخدم
    // كان يقدر يسجّل نوعي إجازة بنفس الكود بدون أي منع أو تنبيه.
    var _existingLeaveTypes = readSheet(
      "LeaveTypes",
      ACCOUNTING_HR_HEADERS.LeaveTypes,
    );
    if (
      AutoNumberService.isTaken(function () {
        return _existingLeaveTypes.map(function (r) {
          return r.code;
        });
      }, data.code)
    ) {
      return errResponse("كود نوع الإجازة موجود مسبقاً — اختر كوداً آخر");
    }

    var id = makeId("LVT");

    _appendRowProtected(getSheet("LeaveTypes", ACCOUNTING_HR_HEADERS.LeaveTypes), ACCOUNTING_HR_HEADERS.LeaveTypes, [ // [ENGINE-UNIFY]
      id,
      data.code,
      data.name,
      Number(data.max_days || 21),
      data.is_paid ? "TRUE" : "FALSE",
      data.requires_approval !== false ? "TRUE" : "FALSE",
      data.color || "#2563eb",
      "TRUE",
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم إضافة نوع الإجازة بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة نوع الإجازة: " + e.message);
  }
}

function updateLeaveType(id, data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-AUDIT] كانت مفقودة بالكامل من الباك إند رغم استدعائها من 12_JS_HR.html
    // عند تعديل نوع إجازة موجود — كانت بتفشل بـ "updateLeaveType is not a function"
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateLeaveType",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!id) return errResponse("معرّف نوع الإجازة مطلوب");
    if (!data.code || !data.name)
      return errResponse("كود واسم نوع الإجازة مطلوبان");

    var sheet = getSheet("LeaveTypes", ACCOUNTING_HR_HEADERS.LeaveTypes);
    var rows = readSheet("LeaveTypes", ACCOUNTING_HR_HEADERS.LeaveTypes, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("نوع الإجازة غير موجود");

    // [AUTO-NUMBER-CENTRAL] نفس فحص التكرار الناقص المضاف لـ addLeaveType،
    // مع استثناء السجل الحالي نفسه من الفحص (تعديل بدون تغيير الكود لازم
    // يفضل مسموح).
    if (
      AutoNumberService.isTaken(
        function () {
          return rows.map(function (r) {
            return r.code;
          });
        },
        data.code,
        rows[idx].code,
      )
    ) {
      return errResponse("كود نوع الإجازة موجود مسبقاً — اختر كوداً آخر");
    }

    var headers = ACCOUNTING_HR_HEADERS.LeaveTypes;
    var rowValues = [
      id,
      data.code,
      data.name,
      Number(data.max_days || 21),
      data.is_paid ? "TRUE" : "FALSE",
      data.requires_approval !== false ? "TRUE" : "FALSE",
      data.color || "#2563eb",
      "TRUE",
    ];
    sheet.getRange(idx + 2, 1, 1, headers.length).setValues([rowValues]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم تعديل نوع الإجازة بنجاح");
  } catch (e) {
    return errResponse("خطأ في تعديل نوع الإجازة: " + e.message);
  }
}

function deleteLeaveType(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("leaveType", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ: " + e.message);
  }
}

function getLeaveRequests(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser) {
      var _permErr = _checkPermission(
        opts.callerUser,
        "viewLeaveRequests",
        opts.sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet("LeaveRequests", ACCOUNTING_HR_HEADERS.LeaveRequests, {
      trimStrings: true,
    });
    if (opts.employee_id)
      rows = rows.filter(function (r) {
        return r.employee_id === opts.employee_id;
      });
    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });

    // إثراء
    var emps = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    var types = readSheet("LeaveTypes", ACCOUNTING_HR_HEADERS.LeaveTypes, {
      trimStrings: true,
    });
    rows.forEach(function (l) {
      var e = emps.find(function (emp) {
        return emp.id === l.employee_id;
      });
      var t = types.find(function (tp) {
        return tp.id === l.leave_type_id;
      });
      l.employee_name = e ? e.full_name : "";
      l.leave_type_name = t ? t.name : "";
    });

    rows.sort(function (a, b) {
      return String(b.requested_at).localeCompare(String(a.requested_at));
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب طلبات الإجازة: " + e.message);
  }
}

function addLeaveRequest(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addLeaveRequest",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (
      !data ||
      !data.employee_id ||
      !data.leave_type_id ||
      !data.start_date ||
      !data.end_date
    )
      return errResponse("الموظف ونوع الإجازة وتواريخ البدء والانتهاء مطلوبة");

    // حساب عدد الأيام
    var start = new Date(data.start_date);
    var end = new Date(data.end_date);
    if (end < start)
      return errResponse("تاريخ الانتهاء يجب أن يكون بعد تاريخ البدء");

    var daysCount = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    // تحقق من الحد الأقصى
    var types = readSheet("LeaveTypes", ACCOUNTING_HR_HEADERS.LeaveTypes);
    var lt = types.find(function (t) {
      return t.id === data.leave_type_id;
    });
    if (lt && daysCount > Number(lt.max_days || 999))
      return errResponse(
        "عدد الأيام يتجاوز الحد الأقصى المسموح (" + lt.max_days + " يوم)",
      );

    // [FIX-HR-REVIEW-③] الفحص السابق كان يتحقق فقط من هذا الطلب بمفرده،
    // فيمكن تجاوز الرصيد السنوي عبر عدة طلبات منفصلة كل واحد أقل من الحد.
    // نجمع هنا أيام كل الطلبات المعتمدة (APPROVED) ونضيف طلبات معلَّقة
    // (PENDING) أيضاً لنفس الموظف ونفس نوع الإجازة خلال نفس السنة — بنفس
    // منطق getEmployeeLeaveBalance() — ونرفض الطلب الجديد لو المجموع يتجاوز
    // max_days الخاص بنوع الإجازة.
    if (lt && Number(lt.max_days)) {
      var requestYear = start.getFullYear();
      var existingRequests = readSheet(
        "LeaveRequests",
        ACCOUNTING_HR_HEADERS.LeaveRequests,
        { trimStrings: true },
      ).filter(function (r) {
        return (
          r.employee_id === data.employee_id &&
          r.leave_type_id === data.leave_type_id &&
          (r.status === "APPROVED" || r.status === "PENDING") &&
          new Date(r.start_date).getFullYear() === requestYear
        );
      });
      var usedDays = existingRequests.reduce(function (sum, r) {
        return sum + (Number(r.days_count) || 0);
      }, 0);
      if (usedDays + daysCount > Number(lt.max_days)) {
        return errResponse(
          "الرصيد السنوي لهذا النوع من الإجازة غير كافٍ — المستخدم/المعلَّق حالياً " +
            usedDays +
            " يوم من أصل " +
            lt.max_days +
            " يوم، والطلب الحالي " +
            daysCount +
            " يوم",
        );
      }
    }

    var id = makeId("LEV");
    var now = new Date().toISOString();

    _appendRowProtected(getSheet("LeaveRequests", ACCOUNTING_HR_HEADERS.LeaveRequests), ACCOUNTING_HR_HEADERS.LeaveRequests, [ // [ENGINE-UNIFY]
      id,
      data.employee_id,
      data.leave_type_id,
      data.start_date,
      data.end_date,
      daysCount,
      data.reason || "",
      "PENDING",
      now,
      "",
      "",
      "",
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم تقديم طلب الإجازة بنجاح", {
      id: id,
      days_count: daysCount,
    });
  } catch (e) {
    return errResponse("خطأ في تقديم طلب الإجازة: " + e.message);
  }
}

function approveLeaveRequest(id, approverNotes, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "approveLeaveRequest",
      sessionToken,
    );
    if (_permErr) return _permErr;

    // [FIX-HR-REVIEW-④-EXT] نفس نمط الإصلاح المطبَّق في approveLoanRequest —
    // قفل ذري حول القراءة-الفحص-الكتابة، وإعادة قراءة الحالة من جوه القفل،
    // لمنع اعتماد مزدوج لنفس طلب الإجازة عبر ضغطتين متزامنتين (تسجيل تدقيق
    // مكرر على الأقل، واحتمال تعارض مع رصيد الإجازة المحسوب في نفس اللحظة).
    var _leaveApproveLock = LockService.getScriptLock();
    try {
      _leaveApproveLock.waitLock(10000);
    } catch (lockErr) {
      return errResponse(
        "النظام مشغول باعتماد طلب آخر لنفس الإجازة، حاول مرة أخرى",
      );
    }
    var rows, idx;
    try {
      rows = readSheet("LeaveRequests", ACCOUNTING_HR_HEADERS.LeaveRequests, {
        trimStrings: true,
      });
      idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("طلب الإجازة غير موجود");
      // [UNIFY-WF] استبدال الشرط اليدوي (status !== "PENDING") بحارس
      // WorkflowEngine.canTransition الموحّد (Code_39_WorkflowEngine.gs،
      // تعريف "LeaveRequest") — نفس رسالة الرفض ونفس السلوك، لكن قاعدة
      // الانتقال بقت معرّفة مرة واحدة بدل تكرارها هنا وفي rejectLeaveRequest.
      var _wfLeave = WorkflowEngine.canTransition(
        "LeaveRequest",
        rows[idx].status,
        "approve",
      );
      if (!_wfLeave.allowed)
        return errResponse("لا يمكن اعتماد طلب ليس معلقاً");

      var sheet = getSheet("LeaveRequests", ACCOUNTING_HR_HEADERS.LeaveRequests);
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();
      var user =
        typeof _auditUser !== "undefined"
          ? _auditUser
          : typeof callerUser !== "undefined"
            ? callerUser
            : "system"; // [FIX-ISSUE-019]

      var statusCol = headers.indexOf("status");
      var approvedByCol = headers.indexOf("approved_by");
      var approvedAtCol = headers.indexOf("approved_at");

      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("APPROVED");
      if (approvedByCol !== -1)
        sheet.getRange(rowNum, approvedByCol + 1).setValue(user);
      if (approvedAtCol !== -1)
        sheet.getRange(rowNum, approvedAtCol + 1).setValue(now);
    } finally {
      _leaveApproveLock.releaseLock();
    }

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    // [FIX-AUDIT-2026 #4] تسجيل اعتماد الإجازة في سجل التدقيق
    _hrAuditLog(
      callerUser,
      "APPROVE_LEAVE_REQUEST",
      "LeaveRequests",
      id,
      "اعتماد طلب إجازة للموظف " +
        rows[idx].employee_id +
        (approverNotes ? " — ملاحظات: " + approverNotes : ""),
    );
    return okResponse("تم اعتماد طلب الإجازة بنجاح");
  } catch (e) {
    return errResponse("خطأ في اعتماد طلب الإجازة: " + e.message);
  }
}

function rejectLeaveRequest(id, reason, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "rejectLeaveRequest",
      sessionToken,
    );
    if (_permErr) return _permErr;
    var rows = readSheet("LeaveRequests", ACCOUNTING_HR_HEADERS.LeaveRequests, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("طلب الإجازة غير موجود");
    // [UNIFY-WF] نفس الاستبدال المطبَّق في approveLeaveRequest — راجع
    // WorkflowEngine.define("LeaveRequest") في Code_39_WorkflowEngine.gs.
    var _wfLeaveReject = WorkflowEngine.canTransition(
      "LeaveRequest",
      rows[idx].status,
      "reject",
    );
    if (!_wfLeaveReject.allowed)
      return errResponse("لا يمكن رفض طلب ليس معلقاً");

    var sheet = getSheet("LeaveRequests", ACCOUNTING_HR_HEADERS.LeaveRequests);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]

    var statusCol = headers.indexOf("status");
    var approvedByCol = headers.indexOf("approved_by");
    var approvedAtCol = headers.indexOf("approved_at");
    var rejectionCol = headers.indexOf("rejection_reason");

    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("REJECTED");
    if (approvedByCol !== -1)
      sheet.getRange(rowNum, approvedByCol + 1).setValue(user);
    if (approvedAtCol !== -1)
      sheet.getRange(rowNum, approvedAtCol + 1).setValue(now);
    if (rejectionCol !== -1)
      sheet.getRange(rowNum, rejectionCol + 1).setValue(reason || "");

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    // [FIX-AUDIT-2026 #4] تسجيل رفض الإجازة في سجل التدقيق
    _hrAuditLog(
      callerUser,
      "REJECT_LEAVE_REQUEST",
      "LeaveRequests",
      id,
      "رفض طلب إجازة للموظف " +
        rows[idx].employee_id +
        (reason ? " — السبب: " + reason : ""),
    );
    return okResponse("تم رفض طلب الإجازة");
  } catch (e) {
    return errResponse("خطأ في رفض طلب الإجازة: " + e.message);
  }
}

// [FIX-2026-SALARY-COMP-AUDIT] deleteLeaveRequest — كانت الشاشة عندها زرار
// "حذف الطلب" في قائمة الزر اليمين، لكن الدالة لم تكن موجودة بالباك اند
// إطلاقاً (الفرونت اند كان يعرض "غير متاح حالياً" دايماً). بنفس نمط
// deletePayrollPeriod: نمنع حذف أي طلب معتمد (APPROVED) لأنه يدخل فعلياً
// في حساب رصيد الإجازات (getEmployeeLeaveBalance) — حذفه بصمت كان هيغيّر
// الرصيد المتاح للموظف من غير أثر تدقيق. يُسمح بحذف PENDING و REJECTED فقط.
function deleteLeaveRequest(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("leaveRequest", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ في حذف طلب الإجازة: " + e.message);
  }
}

// [FIX-AUDIT-2026] getEmployeeLeaveBalance — كانت شاشة "رصيد الإجازات" تنادي
// هذه الدالة ولم يكن لها أي تنفيذ في الباك اند إطلاقاً (الشاشة كانت تفشل دائماً
// برسالة "getEmployeeLeaveBalance is not a function"). تُبنى هنا بنفس نمط
// getEmployee() (الإثراء بالقسم/الوظيفة) وتُجمّع أيام الإجازات المعتمدة فقط
// لكل نوع إجازة لحساب المتبقي = max_days - used_days.
function getEmployeeLeaveBalance(empId, callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "viewLeaveBalance",
      sessionToken,
    );
    if (_permErr) return _permErr;
    if (!empId) return errResponse("رقم الموظف مطلوب");

    var employees = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    var emp = employees.find(function (e) {
      return e.id === empId;
    });
    if (!emp) return errResponse("الموظف غير موجود");

    var depts = readSheet("Departments", ACCOUNTING_HR_HEADERS.Departments, {
      trimStrings: true,
    });
    var jobs = readSheet("JobTitles", ACCOUNTING_HR_HEADERS.JobTitles, {
      trimStrings: true,
    });
    var d = depts.find(function (d) {
      return d.id === emp.department_id;
    });
    var j = jobs.find(function (j) {
      return j.id === emp.job_title_id;
    });

    var leaveTypes = readSheet("LeaveTypes", ACCOUNTING_HR_HEADERS.LeaveTypes, {
      trimStrings: true,
    }).filter(function (lt) {
      return lt.is_active !== false && lt.is_active !== "FALSE";
    });

    var currentYear = new Date().getFullYear();
    var requests = readSheet(
      "LeaveRequests",
      ACCOUNTING_HR_HEADERS.LeaveRequests,
      { trimStrings: true },
    ).filter(function (r) {
      return (
        r.employee_id === empId &&
        r.status === "APPROVED" &&
        new Date(r.start_date).getFullYear() === currentYear
      );
    });

    var balances = leaveTypes.map(function (lt) {
      var used = requests
        .filter(function (r) {
          return r.leave_type_id === lt.id;
        })
        .reduce(function (sum, r) {
          return sum + (Number(r.days_count) || 0);
        }, 0);
      return {
        leave_type_id: lt.id,
        leave_type_name: lt.name,
        is_paid: lt.is_paid,
        max_days: Number(lt.max_days) || 0,
        used_days: used,
      };
    });

    return {
      success: true,
      data: {
        employee: {
          id: emp.id,
          full_name: emp.full_name,
          department_name: d ? d.name : "",
          job_title_name: j ? j.title : "",
        },
        balances: balances,
      },
    };
  } catch (e) {
    return errResponse("خطأ في جلب رصيد الإجازات: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-17  HR — Loan Requests (طلبات السلف)
// ═══════════════════════════════════════════════════════════════════════════════

function getLoanRequests(opts) {
  try {
    opts = opts || {};
    if (opts.callerUser) {
      var _permErr = _checkPermission(
        opts.callerUser,
        "viewLoanRequests",
        opts.sessionToken,
      );
      if (_permErr) return _permErr;
    }
    var rows = readSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests, {
      trimStrings: true,
    });
    if (opts.employee_id)
      rows = rows.filter(function (r) {
        return r.employee_id === opts.employee_id;
      });
    if (opts.status)
      rows = rows.filter(function (r) {
        return r.status === opts.status;
      });

    // إثراء
    var emps = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    rows.forEach(function (l) {
      var e = emps.find(function (emp) {
        return emp.id === l.employee_id;
      });
      l.employee_name = e ? e.full_name : "";
    });

    rows.sort(function (a, b) {
      return String(b.requested_at).localeCompare(String(a.requested_at));
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب طلبات السلف: " + e.message);
  }
}

/**
 * [FIX-AUDIT-2026 #1] _postEmployeeLoanJournal
 * ─────────────────────────────────────────────────────────────────────────
 * تقرير المراجعة المحاسبية حدّد هذه كأخطر ثغرة في النظام: صرف السلف للموظفين
 * لم يكن يُقيَّد محاسبياً إطلاقاً عند الاعتماد (approveLoanRequest كانت تُغيّر
 * الحالة فقط)، وتحصيلها لاحقاً من الراتب كان يُقيَّد بطبيعة محاسبية خاطئة
 * (دائن في حساب التزام "خصومات وسلف مستحقة" بدل تخفيض حساب أصل "ذمم سلف
 * موظفين") — ما يعني أن رصيد السلف غائب كلياً عن الميزانية العمومية، وأن
 * حساب الالتزام يتراكم بلا تصفية طبيعية.
 *
 * هذه الدالة تُنشئ القيد الصحيح في الاتجاهين:
 *  - DISBURSE (الصرف):  مدين "ذمم سلف موظفين" (أصل) / دائن الصندوق أو البنك
 *  - REPAY   (التحصيل النقدي المباشر خارج الراتب): مدين الصندوق / دائن "ذمم سلف موظفين"
 * (تحصيل السلفة *من الراتب* له معالجة منفصلة داخل _autoJournalFromPayroll —
 * راجع التعليق [FIX-AUDIT-2026 #1] هناك — لأنه جزء من قيد الرواتب المُجمَّع
 * وليس قيداً مستقلاً).
 *
 * best-effort بتصميم: لو حساب "ذمم سلف موظفين" أو حساب الصندوق غير مُعرَّف
 * بعد في إعدادات الترحيل، لا نمنع العملية HR نفسها (اعتماد/تسجيل السداد)
 * حتى لا نُعطّل تدفق العمل، لكن نُرجع تحذيراً صريحاً في الاستجابة + سجل
 * تدقيق واضح، بدل الفشل الصامت الذي كان يحدث قبل هذا الإصلاح.
 *
 * @param {"DISBURSE"|"REPAY"} direction
 * @param {object} loan - سجل LoanRequests (id, employee_id, amount, reason, ...)
 * @param {number} amount - المبلغ المطلوب ترحيله
 * @param {string} callerUser
 * @param {string} [paymentAccountId] - حساب الصندوق/البنك (اختياري، افتراضياً cash_account)
 * @returns {{ posted: boolean, journal_id: string|null, warning: string|null }}
 */
function _postEmployeeLoanJournal(
  direction,
  loan,
  amount,
  callerUser,
  paymentAccountId,
) {
  try {
    if (!amount || amount <= 0)
      return { posted: false, journal_id: null, warning: null };

    var accounts = readSheet(
      "ChartOfAccounts",
      ACCOUNTING_HR_HEADERS.ChartOfAccounts,
    );
    var loanAccount = _getDefaultAccount("loan_account", accounts, "ASSET", [
      "سلف موظفين",
      "قروض موظفين",
      "employee loans",
      "advances",
    ]);
    var cashAccount = paymentAccountId
      ? accounts.find(function (a) {
          return a.id === paymentAccountId && !a.deleted_at;
        })
      : _getDefaultAccount("cash_account", accounts, "ASSET", [
          "الصندوق",
          "خزينة رئيسية",
          "cash",
          "صندوق",
        ]);

    if (!loanAccount || !cashAccount) {
      var missingWarning =
        "تعذّر إنشاء القيد المحاسبي لـ" +
        (direction === "DISBURSE" ? "صرف" : "تحصيل") +
        " السلفة " +
        loan.id +
        " — حساب/حسابات (ذمم سلف موظفين / الصندوق) غير مُعرَّفة في إعدادات " +
        "الترحيل (مفاتيح: loan_account, cash_account). تم تنفيذ العملية بدون " +
        "أثر محاسبي — يجب مراجعة هذا يدوياً وإضافة الحسابات ثم الترحيل يدوياً.";
      Logger.log("[LOAN-JOURNAL] " + missingWarning);
      _hrAuditLog(
        callerUser,
        "LOAN_JOURNAL_MISSING_ACCOUNTS",
        "LoanRequests",
        loan.id,
        missingWarning,
      );
      return { posted: false, journal_id: null, warning: missingWarning };
    }

    var isDisburse = direction === "DISBURSE";
    var lines = isDisburse
      ? [
          {
            account_id: loanAccount.id,
            debit: amount,
            credit: 0,
            notes: "صرف سلفة للموظف " + loan.employee_id,
            party_type: "EMPLOYEE",
            party_id: loan.employee_id,
          },
          {
            account_id: cashAccount.id,
            debit: 0,
            credit: amount,
            notes: "صرف سلفة نقداً/بنكاً",
          },
        ]
      : [
          {
            account_id: cashAccount.id,
            debit: amount,
            credit: 0,
            notes: "تحصيل سلفة نقداً من الموظف " + loan.employee_id,
          },
          {
            account_id: loanAccount.id,
            debit: 0,
            credit: amount,
            notes: "تخفيض رصيد ذمم سلف الموظف " + loan.employee_id,
            party_type: "EMPLOYEE",
            party_id: loan.employee_id,
          },
        ];

    var je = _addJournalEntryInternal({
      callerUser: callerUser || "SYSTEM",
      date: new Date().toISOString().split("T")[0],
      reference: loan.id + (isDisburse ? "-DISBURSE" : "-REPAY"),
      description:
        (isDisburse ? "صرف سلفة موظف — " : "تحصيل سلفة موظف — ") + loan.id,
      source_type: "EMPLOYEE_LOAN",
      lines: lines,
    });

    if (!je || !je.success) {
      var failWarning =
        "فشل ترحيل قيد " +
        (isDisburse ? "صرف" : "تحصيل") +
        " السلفة " +
        loan.id +
        ": " +
        (je ? je.message : "unknown error");
      Logger.log("[LOAN-JOURNAL] " + failWarning);
      _hrAuditLog(
        callerUser,
        "LOAN_JOURNAL_FAILED",
        "LoanRequests",
        loan.id,
        failWarning,
      );
      return { posted: false, journal_id: null, warning: failWarning };
    }

    _hrAuditLog(
      callerUser,
      isDisburse ? "LOAN_DISBURSEMENT_POSTED" : "LOAN_REPAYMENT_POSTED",
      "LoanRequests",
      loan.id,
      (isDisburse ? "تم ترحيل قيد صرف سلفة " : "تم ترحيل قيد تحصيل سلفة ") +
        "بمبلغ " +
        amount +
        " — قيد رقم " +
        je.id,
    );
    return { posted: true, journal_id: je.id, warning: null };
  } catch (e) {
    Logger.log("[LOAN-JOURNAL] خطأ غير متوقع: " + e.message);
    return { posted: false, journal_id: null, warning: e.message };
  }
}

function addLoanRequest(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addLoanRequest",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data || !data.employee_id || !data.amount || data.amount <= 0)
      return errResponse("الموظف والمبلغ (أكبر من صفر) مطلوبان");

    var monthlyAmount = Number(data.monthly_amount || 0);
    var installments = Number(data.installments || 1);
    if (monthlyAmount <= 0 && installments > 0) {
      monthlyAmount = Math.ceil((data.amount / installments) * 100) / 100;
    }

    var id = makeId("LOA");
    var now = new Date().toISOString();

    _appendRowProtected(getSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests), ACCOUNTING_HR_HEADERS.LoanRequests, [ // [ENGINE-UNIFY]
      id,
      data.employee_id,
      Number(data.amount),
      data.reason || "",
      installments,
      monthlyAmount,
      "PENDING",
      now,
      "",
      "",
      Number(data.amount),
      0,
      now,
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    // [FIX-AUDIT-2026 #4] تسجيل تقديم طلب السلفة في سجل التدقيق
    _hrAuditLog(
      data.callerUser,
      "ADD_LOAN_REQUEST",
      "LoanRequests",
      id,
      "طلب سلفة جديد للموظف " +
        data.employee_id +
        " بمبلغ " +
        Number(data.amount),
    );
    return okResponse("تم تقديم طلب السلفة بنجاح", {
      id: id,
      monthly_amount: monthlyAmount,
    });
  } catch (e) {
    return errResponse("خطأ في تقديم طلب السلفة: " + e.message);
  }
}

function approveLoanRequest(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "approveLoanRequest",
      sessionToken,
    );
    if (_permErr) return _permErr;

    // [FIX-HR-REVIEW-④] نفس نمط [BUG-012-FIX-2026-07]/[C-03-FIX-2026-07]
    // الموجود في recordLoanPayment/approvePayroll — قفل ذري حول مسار
    // القراءة-الفحص-الكتابة، وإعادة قراءة الحالة من جوه القفل، لمنع اعتماد
    // مزدوج لنفس طلب السلفة عبر ضغطتين متزامنتين (تبويبين مفتوحين مثلاً)
    // ينتج عنه قيد صرف سلفة مكرر عبر _postEmployeeLoanJournal.
    var _loanApproveLock = LockService.getScriptLock();
    try {
      _loanApproveLock.waitLock(10000);
    } catch (lockErr) {
      return errResponse(
        "النظام مشغول باعتماد طلب آخر لنفس السلفة، حاول مرة أخرى",
      );
    }
    var rows, idx;
    try {
      rows = readSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests, {
        trimStrings: true,
      });
      idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("طلب السلفة غير موجود");
      if (rows[idx].status !== "PENDING")
        return errResponse("لا يمكن اعتماد طلب ليس معلقاً");

      var sheet = getSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests);
      var headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      var rowNum = idx + 2;
      var now = new Date().toISOString();
      var user =
        typeof _auditUser !== "undefined"
          ? _auditUser
          : typeof callerUser !== "undefined"
            ? callerUser
            : "system"; // [FIX-ISSUE-019]

      var statusCol = headers.indexOf("status");
      var approvedByCol = headers.indexOf("approved_by");
      var approvedAtCol = headers.indexOf("approved_at");

      if (statusCol !== -1)
        sheet.getRange(rowNum, statusCol + 1).setValue("APPROVED");
      if (approvedByCol !== -1)
        sheet.getRange(rowNum, approvedByCol + 1).setValue(user);
      if (approvedAtCol !== -1)
        sheet.getRange(rowNum, approvedAtCol + 1).setValue(now);
    } finally {
      _loanApproveLock.releaseLock();
    }

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)

    // [FIX-AUDIT-2026 #1] إنشاء قيد صرف السلفة فعلياً — كان غائباً تماماً
    // (مدين ذمم سلف موظفين / دائن الصندوق). best-effort: لا يمنع الاعتماد
    // لو الحسابات غير مُعدّة، لكنه يُرجع تحذيراً واضحاً في الاستجابة.
    var journalResult = _postEmployeeLoanJournal(
      "DISBURSE",
      rows[idx],
      Number(rows[idx].amount || 0),
      callerUser,
    );

    if (journalResult.warning) {
      return okResponse(
        "تم اعتماد طلب السلفة، لكن تعذّر إنشاء القيد المحاسبي تلقائياً: " +
          journalResult.warning,
        { journal_posted: false },
      );
    }
    return okResponse("تم اعتماد طلب السلفة وترحيل قيد الصرف بنجاح", {
      journal_posted: true,
      journal_id: journalResult.journal_id,
    });
  } catch (e) {
    return errResponse("خطأ في اعتماد طلب السلفة: " + e.message);
  }
}

function rejectLoanRequest(id, reason, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "rejectLoanRequest",
      sessionToken,
    );
    if (_permErr) return _permErr;
    var rows = readSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("طلب السلفة غير موجود");
    if (rows[idx].status !== "PENDING")
      return errResponse("لا يمكن رفض طلب ليس معلقاً");

    var sheet = getSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idx + 2;
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]

    var statusCol = headers.indexOf("status");
    var approvedByCol = headers.indexOf("approved_by");
    var approvedAtCol = headers.indexOf("approved_at");

    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("REJECTED");
    if (approvedByCol !== -1)
      sheet.getRange(rowNum, approvedByCol + 1).setValue(user);
    if (approvedAtCol !== -1)
      sheet.getRange(rowNum, approvedAtCol + 1).setValue(now);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    // [FIX-AUDIT-2026 #4] تسجيل رفض طلب السلفة في سجل التدقيق
    _hrAuditLog(
      callerUser,
      "REJECT_LOAN_REQUEST",
      "LoanRequests",
      id,
      "رفض طلب سلفة" + (reason ? " — السبب: " + reason : ""),
    );
    return okResponse("تم رفض طلب السلفة");
  } catch (e) {
    return errResponse("خطأ في رفض طلب السلفة: " + e.message);
  }
}

// [FIX-2026-SALARY-COMP-AUDIT] deleteLoanRequest — نفس فجوة deleteLeaveRequest:
// زرار "حذف الطلب" كان ظاهر بقائمة الزر اليمين لكن بدون تنفيذ بالباك اند.
// السلف أخطر من الإجازات محاسبياً (راجع _postEmployeeLoanJournal) — أي طلب
// معتمد (APPROVED) له قيد صرف فعلي مرحّل، وأي طلب مسدد بالكامل (PAID_OFF)
// له قيود تحصيل مرتبطة. حذف السجل في الحالتين دول كان هيسيب قيود محاسبية
// يتيمة بدون سجل مصدرها. يُسمح بالحذف فقط لو الطلب لسه PENDING أو REJECTED
// (الحالتين اللي مفيش لهم أي أثر محاسبي).
function deleteLoanRequest(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("loanRequest", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ في حذف طلب السلفة: " + e.message);
  }
}

function recordLoanPayment(id, amount, callerUser, sessionToken) {
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "recordLoanPayment",
      sessionToken,
    );
    if (_permErr) return _permErr;
    if (!amount || amount <= 0) return errResponse("المبلغ مطلوب");

    // [BUG-012-FIX-2026-07] قفل ذري حول مسار القراءة-الحساب-الكتابة —
    // نفس نمط [C-03-FIX-2026-07]. يمنع تسجيلين متزامنين لسداد نفس السلفة
    // من الاعتماد على نفس remaining_amount القديم وإنتاج خصم مزدوج غير صحيح.
    var _loanPaymentLock = LockService.getScriptLock();
    try {
      _loanPaymentLock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول بتسجيل سداد آخر لنفس السلفة، حاول مرة أخرى");
    }
    var newRemaining, loan;
    try {
      var rows = readSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests, {
        trimStrings: true,
      });
      var idx = rows.findIndex(function (r) {
        return r.id === id;
      });
      if (idx === -1) return errResponse("طلب السلفة غير موجود");

      loan = rows[idx];
      var remaining = Number(loan.remaining_amount || 0);
      if (amount > remaining)
        return errResponse("المبلغ أكبر من المتبقي (" + remaining + ")");

      newRemaining = remaining - amount;
      var paidInst = Number(loan.paid_installments || 0) + 1;
      var status = newRemaining <= 0 ? "PAID_OFF" : loan.status;

      var sheet = getSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests);
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var rowNum = idx + 2;

      var remCol = headers.indexOf("remaining_amount");
      var paidCol = headers.indexOf("paid_installments");
      var statusCol = headers.indexOf("status");

      if (remCol !== -1)
        sheet.getRange(rowNum, remCol + 1).setValue(newRemaining);
      if (paidCol !== -1) sheet.getRange(rowNum, paidCol + 1).setValue(paidInst);
      if (statusCol !== -1 && newRemaining <= 0)
        sheet.getRange(rowNum, statusCol + 1).setValue("PAID_OFF");
    } finally {
      _loanPaymentLock.releaseLock();
    }

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)

    // [FIX-AUDIT-2026 #1] هذه الدالة تُستخدم لتسجيل سداد نقدي مباشر (وليس
    // خصماً تلقائياً من الراتب — ذاك له معالجة منفصلة في _autoJournalFromPayroll).
    // القيد الصحيح: مدين الصندوق (تحصيل نقدي) / دائن ذمم سلف موظفين (تخفيض الأصل).
    var journalResult = _postEmployeeLoanJournal(
      "REPAY",
      loan,
      Number(amount),
      callerUser,
    );

    var msg = "تم تسجيل السداد بنجاح — المتبقي: " + newRemaining.toFixed(2);
    if (journalResult.warning) {
      msg +=
        " (تنبيه: تعذّر ترحيل القيد المحاسبي تلقائياً — " +
        journalResult.warning +
        ")";
    }
    return okResponse(msg, {
      journal_posted: journalResult.posted,
      journal_id: journalResult.journal_id,
    });
  } catch (e) {
    return errResponse("خطأ في تسجيل السداد: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-18  HR — Payroll (الرواتب)
// ═══════════════════════════════════════════════════════════════════════════════

function getPayrollPeriods() {
  try {
    var rows = readSheet(
      "PayrollPeriods",
      ACCOUNTING_HR_HEADERS.PayrollPeriods,
      { trimStrings: true },
    );
    rows.sort(function (a, b) {
      return String(b.created_at).localeCompare(String(a.created_at));
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب فترات الرواتب: " + e.message);
  }
}

function addPayrollPeriod(data) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addPayrollPeriod",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data || !data.name || !data.year || !data.month)
      return errResponse("الاسم والسنة والشهر مطلوبة");

    var id = makeId("PRP");
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]

    _appendRowProtected(getSheet("PayrollPeriods", ACCOUNTING_HR_HEADERS.PayrollPeriods), ACCOUNTING_HR_HEADERS.PayrollPeriods, [ // [ENGINE-UNIFY]
      id,
      data.name,
      Number(data.year),
      Number(data.month),
      data.start_date || "",
      data.end_date || "",
      "DRAFT",
      user,
      now,
      "",
      "",
      "",
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم إنشاء فترة الرواتب بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إنشاء فترة الرواتب: " + e.message);
  }
}

function deletePayrollPeriod(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("payrollPeriod", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ في حذف فترة الرواتب: " + e.message);
  }
}

/**
 * generatePayroll — توليد مسير الرواتب
 * يحسب الرواتب لجميع الموظفين النشطين
 */
function generatePayroll(periodId, callerUser, sessionToken) {
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      callerUser,
      "generatePayroll",
      sessionToken,
    );
    if (_permErr) return _permErr;
    // جلب فترة الرواتب
    var periods = readSheet(
      "PayrollPeriods",
      ACCOUNTING_HR_HEADERS.PayrollPeriods,
      { trimStrings: true },
    );
    var period = periods.find(function (p) {
      return p.id === periodId;
    });
    if (!period) return errResponse("فترة الرواتب غير موجودة");
    if (period.status !== "DRAFT")
      return errResponse("لا يمكن توليد مسير لفترة ليست مسودة");

    // [BUG-011-FIX-2026-07] نفس نمط [C-03-FIX-2026-07] الموجود في approvePayroll —
    // قفل ذري يمنع توليد مسير الرواتب مرتين بسبب ضغطتين متزامنتين أو تبويبين
    // مفتوحين. إعادة فحص الحالة DRAFT من جوه القفل لضمان عدم تجاوز الفحص
    // الأول من عملية توليد متزامنة سبقتها.
    var _payrollGenLock = LockService.getScriptLock();
    try {
      _payrollGenLock.waitLock(10000);
    } catch (lockErr) {
      return errResponse(
        "النظام مشغول بتوليد مسير آخر لنفس الفترة، حاول مرة أخرى",
      );
    }
    try {
      var periodsLocked = readSheet(
        "PayrollPeriods",
        ACCOUNTING_HR_HEADERS.PayrollPeriods,
        { trimStrings: true },
      );
      var periodLocked = periodsLocked.find(function (p) {
        return p.id === periodId;
      });
      if (!periodLocked) return errResponse("فترة الرواتب غير موجودة");
      if (periodLocked.status !== "DRAFT")
        return errResponse("لا يمكن توليد مسير لفترة ليست مسودة");

    // ── [REMEDIATION-5] نسبة حصة صاحب العمل في التأمينات الاجتماعية ──
    // قرار محاسبي/قانوني وليس تقنياً — النسبة الفعلية لازم تُؤكَّد من محاسب مختص
    // ثم تُضبَط في إعدادات الشركة (Settings) تحت المفتاح employer_social_insurance_rate
    // (كنسبة عشرية، مثلاً 0.1875 لـ 18.75%). لو الإعداد غير موجود أو صفر، الكود هنا
    // بيتعامل معاها كـ 0 بأمان — يعني مفيش قيد لحصة صاحب العمل هيتسجَّل لحد ما تُضبَط
    // النسبة فعلياً (أفضل من اختراع رقم غير مؤكَّد).
    var _companySettings = _getCompanySettingsRaw();
    var employerInsuranceRate =
      Number(_companySettings.employer_social_insurance_rate) || 0;
    if (employerInsuranceRate <= 0) {
      Logger.log(
        "[REMEDIATION-5] تنبيه: employer_social_insurance_rate غير مضبوط في الإعدادات " +
          "— لن يُحتسَب أي مصروف لحصة صاحب العمل في التأمينات لهذا المسير.",
      );
    }

    // جلب الموظفين النشطين
    var employees = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    // [AUDIT-FIX] salary_currency كان يُحفظ ويُعرض لكن generatePayroll كانت
    // تجمع كل المبالغ كأرقام خام بدون أي تحويل عملة — لو فيه موظف بعملة غير
    // الجنيه المصري، المجموع كان هيبقى غلط رياضيًا بصمت (خلط عملات). بما إن
    // النظام لا يحتوي أسعار صرف فعلية حاليًا، الأصح هو رفض التوليد صراحةً
    // بدل حساب رقم خاطئ، وتوضيح المطلوب للمستخدم.
    var _mixedCurrencyEmployees = employees.filter(function (e) {
      return (
        e.status === "ACTIVE" &&
        e.salary_currency &&
        e.salary_currency !== "EGP"
      );
    });
    if (_mixedCurrencyEmployees.length > 0) {
      return errResponse(
        "لا يمكن توليد المسير: يوجد " +
          _mixedCurrencyEmployees.length +
          " موظف/موظفين براتب بعملة غير الجنيه المصري (" +
          _mixedCurrencyEmployees
            .map(function (e) {
              return e.full_name + ": " + e.salary_currency;
            })
            .join("، ") +
          "). النظام الحالي لا يدعم تحويل عملة فعلي في مسير الرواتب — يجب " +
          "تسوية هذه الحالات يدويًا (مسير منفصل، أو ضبط الراتب بالجنيه) قبل " +
          "المتابعة، تجنبًا لجمع أرقام بعملات مختلفة كأنها نفس العملة.",
      );
    }

    employees = employees.filter(function (e) {
      return e.status === "ACTIVE";
    });

    // جلب البدلات والخصومات
    var allAllowances = readSheet(
      "EmployeeAllowances",
      ACCOUNTING_HR_HEADERS.EmployeeAllowances,
      { trimStrings: true },
    );
    var allDeductions = readSheet(
      "EmployeeDeductions",
      ACCOUNTING_HR_HEADERS.EmployeeDeductions,
      { trimStrings: true },
    );

    // جلب سجلات الحضور للفترة
    var attendance = readSheet("Attendance", ACCOUNTING_HR_HEADERS.Attendance, {
      trimStrings: true,
    });
    if (period.start_date)
      attendance = attendance.filter(function (a) {
        return a.date >= period.start_date;
      });
    if (period.end_date)
      attendance = attendance.filter(function (a) {
        return a.date <= period.end_date;
      });

    // جلب سلف الموظفين المعتمدة
    var loans = readSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests, {
      trimStrings: true,
    });
    loans = loans.filter(function (l) {
      return l.status === "APPROVED" && Number(l.remaining_amount || 0) > 0;
    });

    // ── [REMEDIATION-1] جلب تنفيذات مراحل الإنتاج (أجر القطعة) المُعلَّقة لهذه الفترة ──
    // نفس منطق فلترة الحضور بالضبط: exec_date ضمن نطاق الفترة، وبحالة PENDING_PAYROLL
    // فقط (يستثني ما سبق تضمينه في مسير سابق، ويستثني ما لم يُعتمَد بعد إن وُجد اعتماد).
    var stageExecutions = readSheet(
      "StageExecutions",
      ACCOUNTING_HR_HEADERS.StageExecutions,
      { trimStrings: true },
    );
    stageExecutions = stageExecutions.filter(function (sx) {
      return sx.payroll_status === "PENDING_PAYROLL";
    });
    if (period.start_date)
      stageExecutions = stageExecutions.filter(function (sx) {
        return sx.exec_date >= period.start_date;
      });
    if (period.end_date)
      stageExecutions = stageExecutions.filter(function (sx) {
        return sx.exec_date <= period.end_date;
      });
    // قائمة بمعرّفات التنفيذات التي سيتم تضمينها فعلياً — تُستخدم لتحديث حالتها بعد نجاح التوليد
    var includedStageExecutionIds = [];

    // ── [REMEDIATION-10] جلب طلبات الإجازة غير المدفوعة المعتمدة والمتقاطعة مع فترة الرواتب ──
    // المطابقة بالتقاطع الزمني (overlap) وليس فقط "ضمن الفترة" مثل الحضور، لأن طلب
    // إجازة واحد قد يمتد قبل الفترة أو بعدها جزئياً؛ نحسب فقط الأيام المتقاطعة فعلياً
    // مع [period.start_date, period.end_date] حتى لا نخصم أيام من فترة رواتب أخرى.
    var unpaidLeaveTypeIds = {};
    readSheet("LeaveTypes", ACCOUNTING_HR_HEADERS.LeaveTypes, {
      trimStrings: true,
    }).forEach(function (lt) {
      if (lt.is_paid === "FALSE") unpaidLeaveTypeIds[lt.id] = true;
    });
    var leaveRequests = readSheet(
      "LeaveRequests",
      ACCOUNTING_HR_HEADERS.LeaveRequests,
      { trimStrings: true },
    );
    leaveRequests = leaveRequests.filter(function (lr) {
      return (
        lr.status === "APPROVED" &&
        unpaidLeaveTypeIds[lr.leave_type_id] &&
        (!period.start_date || lr.end_date >= period.start_date) &&
        (!period.end_date || lr.start_date <= period.end_date)
      );
    });
    // يحسب عدد أيام التقاطع (شامل الطرفين) بين مدى طلب الإجازة ومدى فترة الرواتب
    function _overlapDaysCount(reqStart, reqEnd, periodStart, periodEnd) {
      var s = periodStart && reqStart < periodStart ? periodStart : reqStart;
      var e = periodEnd && reqEnd > periodEnd ? periodEnd : reqEnd;
      var sDate = new Date(s);
      var eDate = new Date(e);
      if (eDate < sDate) return 0;
      return Math.round((eDate - sDate) / (1000 * 60 * 60 * 24)) + 1;
    }

    var prSheet = getSheet(
      "PayrollRecords",
      ACCOUNTING_HR_HEADERS.PayrollRecords,
    );
    var records = [];
    var prRows = []; // [PERF-BATCH-1] تجميع صفوف مسير الرواتب لكل الموظفين
    // [FIX-HR-REVIEW-①] يجمع القسط الفعلي المخصوم من الراتب لكل سلفة (loan.id)
    // عبر كل الموظفين في هذا المسير، ليُستخدم بعد appendRowsBatch لتحديث
    // remaining_amount/paid_installments/status في شيت LoanRequests نفسه.
    var loanActualDeductionsByLoanId = {};

    employees.forEach(function (emp) {
      var basicSalary = Number(emp.basic_salary || 0);
      var currency = emp.salary_currency || "EGP";

      // ── البدلات ──
      var empAllowances = allAllowances.filter(function (a) {
        return a.employee_id === emp.id && a.is_active !== "FALSE";
      });
      var totalAllowances = 0;
      empAllowances.forEach(function (a) {
        if (a.is_percentage === "TRUE" && a.percentage_value) {
          totalAllowances += basicSalary * (Number(a.percentage_value) / 100);
        } else {
          totalAllowances += Number(a.amount || 0);
        }
      });

      // ── الحضور والإضافي ──
      var empAttendance = attendance.filter(function (a) {
        return a.employee_id === emp.id;
      });
      var totalOvertimeHours = empAttendance.reduce(function (s, a) {
        return s + Number(a.overtime_hours || 0);
      }, 0);
      var totalDelayMinutes = empAttendance.reduce(function (s, a) {
        return s + Number(a.delay_minutes || 0);
      }, 0);
      var workDays = empAttendance.filter(function (a) {
        return a.status === "PRESENT" || a.status === "LATE";
      }).length;

      // حساب مبلغ الإضافي (افتراض: 1.5 × الراتب اليومي / 8)
      var dailyRate = basicSalary / 30;
      var hourlyRate = dailyRate / 8;
      var overtimeAmount =
        Math.round(totalOvertimeHours * hourlyRate * 1.5 * 100) / 100;

      // خصم التأخير (افتراض: كل 60 دقيقة = ساعة)
      var delayDeduction =
        Math.round((totalDelayMinutes / 60) * hourlyRate * 100) / 100;

      // ── [REMEDIATION-10] خصم الإجازة غير المدفوعة ──
      // نجمع أيام كل طلبات الإجازة غير المدفوعة المعتمدة لهذا الموظف والمتقاطعة مع
      // الفترة الحالية فقط (وليس days_count الأصلي للطلب كاملاً، حتى لا يُحتسَب يوم
      // يقع فعلياً في فترة رواتب مجاورة لو الطلب امتد عبر حدود الفترة).
      var empUnpaidLeaves = leaveRequests.filter(function (lr) {
        return lr.employee_id === emp.id;
      });
      var unpaidLeaveDays = 0;
      empUnpaidLeaves.forEach(function (lr) {
        unpaidLeaveDays += _overlapDaysCount(
          lr.start_date,
          lr.end_date,
          period.start_date,
          period.end_date,
        );
      });
      var unpaidLeaveDeduction =
        Math.round(unpaidLeaveDays * dailyRate * 100) / 100;

      // ── [REMEDIATION-1] أجر مراحل الإنتاج (Piece-Rate) المستحق لهذا الموظف في الفترة ──
      // قرار محاسبي/قانوني لم يُحسَم بعد: هل يخضع أجر الإنتاج لنفس معاملة الضريبة
      // والتأمين الاجتماعي المطبَّقة على الراتب الأساسي؟ الافتراضي هنا هو "نعم" (يُدرَج
      // ضمن الوعاء الخاضع) لأنه الأكثر تحفظاً واتفاقاً مع الممارسة الشائعة في معظم
      // التشريعات لأجر القطعة كجزء من الأجر الأساسي الخاضع — لكن يجب تأكيده من محاسب
      // مختص قبل الاعتماد على هذا الرقم في الإنتاج الفعلي (راجع خطة الإصلاحات، بند 1).
      var empStageExecs = stageExecutions.filter(function (sx) {
        return sx.employee_id === emp.id;
      });
      var productionWage = 0;
      empStageExecs.forEach(function (sx) {
        productionWage += Number(sx.total_amount || 0);
        includedStageExecutionIds.push(sx.id);
      });
      productionWage = Math.round(productionWage * 100) / 100;

      // ── التأمينات (افتراض: 11% من الراتب الأساسي + أجر الإنتاج) ──
      var insuranceBase = basicSalary + productionWage;
      var socialInsurance = Math.round(insuranceBase * 0.11 * 100) / 100;

      // ── [REMEDIATION-5] حصة صاحب العمل — مصروف على الشركة، لا يُخصَم من الموظف ولا
      // يؤثر على صافي راتبه إطلاقاً (بعكس social_insurance اللي فوق). نفس وعاء
      // الاحتساب (أساسي + أجر إنتاج) بافتراض تحفظي مبدئي إلى حين تأكيد المحاسب.
      var employerSocialInsurance =
        Math.round(insuranceBase * employerInsuranceRate * 100) / 100;

      // ── الضريبة (مبسطة — شرائح مصر) ──
      var taxableIncome =
        basicSalary + productionWage + totalAllowances - socialInsurance;
      var incomeTax = _calculateEgyptIncomeTax(taxableIncome);

      // ── الخصومات الثابتة ──
      var empDeductions = allDeductions.filter(function (d) {
        return d.employee_id === emp.id && d.is_active !== "FALSE";
      });
      var totalDeductions = 0;
      empDeductions.forEach(function (d) {
        if (d.is_percentage === "TRUE") {
          totalDeductions += basicSalary * (Number(d.amount || 0) / 100);
        } else {
          totalDeductions += Number(d.amount || 0);
        }
      });

      // ── استقطاع السلفة ──
      // [FIX-HR-REVIEW-①②] القسط المخصوم من الراتب لا يمكن أن يتجاوز المتبقي
      // الفعلي للسلفة (Math.min) — يمنع خصم زائد في القسط الأخير. كما نُسجّل
      // القسط المخصوم فعلياً لكل سلفة في loanActualDeductionsByLoanId حتى
      // نستخدمه بعد التوليد لتحديث remaining_amount/paid_installments/status
      // في شيت LoanRequests نفسه (كان غائباً تماماً — المشكلة ①).
      var empLoans = loans.filter(function (l) {
        return l.employee_id === emp.id;
      });
      var loanDeduction = 0;
      empLoans.forEach(function (l) {
        var remainingNow = Number(l.remaining_amount || 0);
        var installment = Math.min(Number(l.monthly_amount || 0), remainingNow);
        if (installment < 0) installment = 0;
        loanDeduction += installment;
        if (installment > 0) {
          loanActualDeductionsByLoanId[l.id] =
            (loanActualDeductionsByLoanId[l.id] || 0) + installment;
        }
      });

      // ── صافي الراتب ── (يشمل الآن أجر مراحل الإنتاج — [REMEDIATION-1] — وخصم
      // الإجازة غير المدفوعة — [REMEDIATION-10]) ──
      var netSalary =
        basicSalary +
        productionWage +
        totalAllowances +
        overtimeAmount -
        totalDeductions -
        socialInsurance -
        incomeTax -
        delayDeduction -
        loanDeduction -
        unpaidLeaveDeduction;
      netSalary = Math.round(netSalary * 100) / 100;
      if (netSalary < 0) netSalary = 0; // صافي الراتب لا يمكن أن يكون سالباً

      var recordId = makeId("PRL");
      prRows.push([
        recordId,
        periodId,
        emp.id,
        basicSalary,
        Math.round(totalAllowances * 100) / 100,
        Math.round(totalDeductions * 100) / 100,
        socialInsurance,
        incomeTax,
        overtimeAmount,
        Math.round(loanDeduction * 100) / 100,
        netSalary,
        "PENDING",
        "",
        emp.payment_method || "CASH",
        "",
        productionWage, // [REMEDIATION-1]
        unpaidLeaveDeduction, // [REMEDIATION-10]
        delayDeduction, // [REMEDIATION-3] كان يُطرَح من الصافي فقط بدون تخزين — الآن مُسجَّل
        employerSocialInsurance, // [REMEDIATION-5]
      ]);

      records.push({
        id: recordId,
        employee_name: emp.full_name,
        employee_number: emp.employee_number,
        basic_salary: basicSalary,
        production_wage: productionWage,
        total_allowances: totalAllowances,
        total_deductions: totalDeductions,
        social_insurance: socialInsurance,
        employer_social_insurance: employerSocialInsurance, // [REMEDIATION-5]
        income_tax: incomeTax,
        overtime_amount: overtimeAmount,
        loan_deduction: loanDeduction,
        delay_deduction: delayDeduction, // [REMEDIATION-3]
        unpaid_leave_days: unpaidLeaveDays, // [REMEDIATION-10]
        unpaid_leave_deduction: unpaidLeaveDeduction, // [REMEDIATION-10]
        net_salary: netSalary,
      });
    });
    appendRowsBatch(
      "PayrollRecords",
      prRows,
      ACCOUNTING_HR_HEADERS.PayrollRecords,
    );

    // ── [FIX-HR-REVIEW-①] تحديث رصيد السلف نفسه بعد خصم أقساطها فعلياً من الرواتب ──
    // كانت remaining_amount/paid_installments/status لا تُحدَّث إطلاقاً هنا —
    // فقط عبر recordLoanPayment() (السداد النقدي اليدوي المنفصل). بنفس منطق
    // recordLoanPayment، وداخل نفس القفل (_payrollGenLock) المستخدم أصلاً في
    // generatePayroll لضمان عدم تعارضه مع تسديد يدوي متزامن.
    var loanIdsToUpdate = Object.keys(loanActualDeductionsByLoanId);
    if (loanIdsToUpdate.length > 0) {
      try {
        var lrSheet = getSheet(
          "LoanRequests",
          ACCOUNTING_HR_HEADERS.LoanRequests,
        );
        var lrHeaders = lrSheet
          .getRange(1, 1, 1, lrSheet.getLastColumn())
          .getValues()[0];
        var lrIdCol = lrHeaders.indexOf("id");
        var lrRemCol = lrHeaders.indexOf("remaining_amount");
        var lrPaidCol = lrHeaders.indexOf("paid_installments");
        var lrStatusCol = lrHeaders.indexOf("status");
        var lrLastRow = lrSheet.getLastRow();
        if (
          lrIdCol !== -1 &&
          lrRemCol !== -1 &&
          lrLastRow > 1
        ) {
          // [PERF] بدل ما نقرا/نكتب كل خلية (remaining/paid/status) لوحدها
          // (لغاية 3 نداءات I/O لكل قرض متأثر)، بنقرا كل الأعمدة المطلوبة
          // دفعة واحدة، نعدّل القيم في الميموري، ونكتبهم كلهم بـ setValues
          // نداء واحد بعد نهاية اللوب.
          var lrMinCol = lrRemCol;
          var lrMaxCol = lrRemCol;
          if (lrPaidCol !== -1) {
            lrMinCol = Math.min(lrMinCol, lrPaidCol);
            lrMaxCol = Math.max(lrMaxCol, lrPaidCol);
          }
          if (lrStatusCol !== -1) {
            lrMinCol = Math.min(lrMinCol, lrStatusCol);
            lrMaxCol = Math.max(lrMaxCol, lrStatusCol);
          }
          var lrNumCols = lrMaxCol - lrMinCol + 1;

          var lrIds = lrSheet
            .getRange(2, lrIdCol + 1, lrLastRow - 1, 1)
            .getValues();
          var lrBlockRange = lrSheet.getRange(
            2,
            lrMinCol + 1,
            lrLastRow - 1,
            lrNumCols,
          );
          var lrBlockValues = lrBlockRange.getValues();
          var lrDirty = false;

          for (var lr = 0; lr < lrIds.length; lr++) {
            var lrId = lrIds[lr][0];
            var deducted = loanActualDeductionsByLoanId[lrId];
            if (deducted === undefined) continue;

            var lrRemIdx = lrRemCol - lrMinCol;
            var lrCurrentRemaining = Number(lrBlockValues[lr][lrRemIdx] || 0);
            var lrNewRemaining =
              Math.round((lrCurrentRemaining - deducted) * 100) / 100;
            if (lrNewRemaining < 0) lrNewRemaining = 0;
            lrBlockValues[lr][lrRemIdx] = lrNewRemaining;
            lrDirty = true;

            if (lrPaidCol !== -1) {
              var lrPaidIdx = lrPaidCol - lrMinCol;
              var lrCurrentPaid = Number(lrBlockValues[lr][lrPaidIdx] || 0);
              lrBlockValues[lr][lrPaidIdx] = lrCurrentPaid + 1;
            }
            if (lrStatusCol !== -1 && lrNewRemaining <= 0) {
              lrBlockValues[lr][lrStatusCol - lrMinCol] = "PAID_OFF";
            }
          }

          if (lrDirty) {
            lrBlockRange.setValues(lrBlockValues);
          }
        }
      } catch (lrErr) {
        // لا نُفشل توليد المسير كله بسبب خطأ في تحديث رصيد السلف —
        // لكن نسجّل الخطأ بوضوح لأنه يعني تعارضاً بين دفتر الأستاذ وشيت السلف
        Logger.log(
          "[FIX-HR-REVIEW-①] تحذير: فشل تحديث رصيد السلف بعد توليد المسير: " +
            lrErr.message,
        );
      }
    }

    // ── [REMEDIATION-1] تحديث حالة تنفيذات مراحل الإنتاج المُضمَّنة فعلياً في هذا المسير ──
    // يمنع احتساب نفس التنفيذ مرتين لو أُعيد تشغيل generatePayroll لأي سبب، ويسمح لاحقاً
    // بمعرفة أي فترة رواتب تحديداً شملت تنفيذاً معيناً عبر payroll_period_id.
    if (includedStageExecutionIds.length > 0) {
      try {
        var sxSheet = getSheet(
          "StageExecutions",
          ACCOUNTING_HR_HEADERS.StageExecutions,
        );
        var sxHeaders = sxSheet
          .getRange(1, 1, 1, sxSheet.getLastColumn())
          .getValues()[0];
        var sxIdCol = sxHeaders.indexOf("id");
        var sxStatusCol = sxHeaders.indexOf("payroll_status");
        var sxPeriodCol = sxHeaders.indexOf("payroll_period_id");
        if (sxIdCol !== -1 && sxStatusCol !== -1 && sxPeriodCol !== -1) {
          var sxLastRow = sxSheet.getLastRow();
          if (sxLastRow > 1) {
            var sxIds = sxSheet
              .getRange(2, sxIdCol + 1, sxLastRow - 1, 1)
              .getValues();
            // [PERF-BATCH-1] بدل نداءين setValue منفصلين لكل صف مطابق،
            // نجهّز فهرس الأعمدة المستهدفة (status/period) كـ block واحد
            // متجاور، نعدّل بس الصفوف المطابقة في الذاكرة، ونكتب مرة واحدة.
            var sxMinCol = Math.min(sxStatusCol, sxPeriodCol);
            var sxMaxCol = Math.max(sxStatusCol, sxPeriodCol);
            var sxSpan = sxMaxCol - sxMinCol + 1;
            var sxBlockRange = sxSheet.getRange(
              2,
              sxMinCol + 1,
              sxLastRow - 1,
              sxSpan,
            );
            var sxBlock = sxBlockRange.getValues();
            var sxStatusOffset = sxStatusCol - sxMinCol;
            var sxPeriodOffset = sxPeriodCol - sxMinCol;
            var sxChanged = false;
            for (var r = 0; r < sxIds.length; r++) {
              if (includedStageExecutionIds.indexOf(sxIds[r][0]) !== -1) {
                sxBlock[r][sxStatusOffset] = "INCLUDED_IN_PAYROLL";
                sxBlock[r][sxPeriodOffset] = periodId;
                sxChanged = true;
              }
            }
            if (sxChanged) sxBlockRange.setValues(sxBlock);
          }
        }
      } catch (sxErr) {
        // لا نُفشل توليد المسير كله بسبب خطأ في تحديث حالة StageExecutions —
        // لكن نسجّل الخطأ لأنه يعني احتمال احتساب نفس التنفيذات مرة أخرى لاحقاً
        Logger.log(
          "[REMEDIATION-1] تحذير: فشل تحديث حالة StageExecutions بعد التوليد: " +
            sxErr.message,
        );
      }
    }

    // تحديث حالة الفترة
    var ppSheet = getSheet(
      "PayrollPeriods",
      ACCOUNTING_HR_HEADERS.PayrollPeriods,
    );
    var ppRows = readSheet(
      "PayrollPeriods",
      ACCOUNTING_HR_HEADERS.PayrollPeriods,
      { trimStrings: true },
    );
    var ppIdx = ppRows.findIndex(function (p) {
      return p.id === periodId;
    });
    if (ppIdx !== -1) {
      var ppHeaders = ppSheet
        .getRange(1, 1, 1, ppSheet.getLastColumn())
        .getValues()[0];
      var statusCol = ppHeaders.indexOf("status");
      // [FIX-ISSUE-012] التوليد لا يعني الاعتماد — Segregation of Duties
      // approvePayroll() هي الدالة المسؤولة عن الاعتماد بصلاحية منفصلة
      if (statusCol !== -1)
        ppSheet.getRange(ppIdx + 2, statusCol + 1).setValue("GENERATED");
    }

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse(
      "تم توليد مسير الرواتب بنجاح — " + records.length + " موظف",
      { records: records },
    );
    } finally {
      _payrollGenLock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في توليد مسير الرواتب: " + e.message);
  }
}

/**
 * _calculateEgyptIncomeTax — حساب ضريبة الدخل المصرية (شرائح 2025)
 */
function _calculateEgyptIncomeTax(annualIncome) {
  // الشرائح السنوية (جنيه مصري)
  // حتى 30,000: معفى
  // 30,001 - 45,000: 10%
  // 45,001 - 60,000: 15%
  // 60,001 - 200,000: 20%
  // 200,001 - 400,000: 22.5%
  // 400,001+: 25%

  var monthlyIncome = annualIncome; // الدالة تستقبل دخلاً شهرياً
  var annual = monthlyIncome * 12;
  var tax = 0;
  var brackets = [
    { limit: 30000, rate: 0 },
    { limit: 45000, rate: 0.1 },
    { limit: 60000, rate: 0.15 },
    { limit: 200000, rate: 0.2 },
    { limit: 400000, rate: 0.225 },
    { limit: Infinity, rate: 0.25 },
  ];

  var previousLimit = 0;
  for (var i = 0; i < brackets.length; i++) {
    if (annual > previousLimit) {
      var taxableInBracket =
        Math.min(annual, brackets[i].limit) - previousLimit;
      tax += taxableInBracket * brackets[i].rate;
      previousLimit = brackets[i].limit;
    }
  }

  return Math.round((tax / 12) * 100) / 100; // رجوع شهري
}

function approvePayroll(periodId, callerUser, sessionToken) {
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(callerUser, "approvePayroll", sessionToken);
    if (_permErr) return _permErr;
    var rows = readSheet(
      "PayrollPeriods",
      ACCOUNTING_HR_HEADERS.PayrollPeriods,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === periodId;
    });
    if (idx === -1) return errResponse("فترة الرواتب غير موجودة");
    // [FIX-ISSUE-012] الاعتماد يقبل فقط المسيرات في حالة GENERATED (وليس DRAFT)
    if (rows[idx].status !== "GENERATED")
      return errResponse(
        "لا يمكن اعتماد مسير إلا بعد توليده — الحالة الحالية: " +
          rows[idx].status,
      );

    // [C-03-FIX-2026-07] قفل ذري يمنع اعتماد مسير الرواتب مرتين بسبب
    // ضغطتين متزامنتين (نفس نمط approveReceiptVoucher — راجع تقرير
    // المراجعة، المرحلة 3، ثغرة #5). إعادة قراءة الحالة داخل القفل لضمان
    // عدم تجاوز فحص GENERATED من عملية اعتماد متزامنة سبقتها.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      return errResponse("النظام مشغول باعتماد آخر لنفس المسير، حاول مرة أخرى");
    }
    try {
      var rowsLocked = readSheet(
        "PayrollPeriods",
        ACCOUNTING_HR_HEADERS.PayrollPeriods,
        { trimStrings: true },
      );
      var idxLocked = rowsLocked.findIndex(function (r) {
        return r.id === periodId;
      });
      if (idxLocked === -1) return errResponse("فترة الرواتب غير موجودة");
      if (rowsLocked[idxLocked].status !== "GENERATED")
        return errResponse(
          "لا يمكن اعتماد مسير إلا بعد توليده — الحالة الحالية: " +
            rowsLocked[idxLocked].status,
        );

    var sheet = getSheet(
      "PayrollPeriods",
      ACCOUNTING_HR_HEADERS.PayrollPeriods,
    );
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rowNum = idxLocked + 2;
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]

    var statusCol = headers.indexOf("status");
    var approvedByCol = headers.indexOf("approved_by");
    var approvedAtCol = headers.indexOf("approved_at");

    if (statusCol !== -1)
      sheet.getRange(rowNum, statusCol + 1).setValue("APPROVED");
    if (approvedByCol !== -1)
      sheet.getRange(rowNum, approvedByCol + 1).setValue(user);
    if (approvedAtCol !== -1)
      sheet.getRange(rowNum, approvedAtCol + 1).setValue(now);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    // [FIX-AUDIT-2026 #4] تسجيل اعتماد مسير الرواتب في سجل التدقيق
    _hrAuditLog(
      callerUser,
      "APPROVE_PAYROLL",
      "PayrollPeriods",
      periodId,
      "تم اعتماد مسير الرواتب لفترة " + periodId,
    );
    return okResponse("تم اعتماد مسير الرواتب بنجاح");
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return errResponse("خطأ في اعتماد مسير الرواتب: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 23256-23469] Employee Documents + HR Dashboard Stats ┄┄┄
// §EXT-19  HR — Employee Documents (مستندات الموظفين)
// ═══════════════════════════════════════════════════════════════════════════════

function getEmployeeDocuments(employeeId) {
  try {
    var rows = readSheet(
      "EmployeeDocuments",
      ACCOUNTING_HR_HEADERS.EmployeeDocuments,
      { trimStrings: true },
    );
    if (employeeId)
      rows = rows.filter(function (r) {
        return r.employee_id === employeeId;
      });
    rows.sort(function (a, b) {
      return String(b.uploaded_at).localeCompare(String(a.uploaded_at));
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب المستندات: " + e.message);
  }
}

function uploadEmployeeDocument(data) {
  try {
    // [FIX-ISSUE-002] فحص الصلاحيات — كان مفقوداً في وحدة HR
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "uploadEmployeeDocument",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data || !data.employee_id || !data.doc_type || !data.file_url)
      return errResponse("الموظف ونوع المستند والملف مطلوبان");

    var id = makeId("DOC");
    var now = new Date().toISOString();
    var user =
      typeof _auditUser !== "undefined"
        ? _auditUser
        : typeof callerUser !== "undefined"
          ? callerUser
          : "system"; // [FIX-ISSUE-019]

    // [ENGINE-UNIFY]
    _appendRowProtected(
      getSheet("EmployeeDocuments", ACCOUNTING_HR_HEADERS.EmployeeDocuments),
      ACCOUNTING_HR_HEADERS.EmployeeDocuments,
      [
      id,
      data.employee_id,
      data.doc_type,
      data.title || "",
      data.file_url,
      data.file_name || "",
      now,
      user,
      data.notes || "",
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    return okResponse("تم رفع المستند بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في رفع المستند: " + e.message);
  }
}

function deleteEmployeeDocument(id, callerUser, sessionToken) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("employeeDocument", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ في حذف المستند: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-19b  HR — Qualifications & Experience (Tab: Qualifications & Experience) [HR-TABS-P1]
// ═══════════════════════════════════════════════════════════════════════════════

function getEmployeeQualifications(employeeId) {
  try {
    var rows = readSheet(
      "EmployeeQualifications",
      ACCOUNTING_HR_HEADERS.EmployeeQualifications,
      { trimStrings: true },
    );
    if (employeeId)
      rows = rows.filter(function (r) {
        return r.employee_id === employeeId;
      });
    rows.sort(function (a, b) {
      return String(b.start_date || "").localeCompare(
        String(a.start_date || ""),
      );
    });
    return { success: true, data: rows };
  } catch (e) {
    return errResponse("خطأ في جلب المؤهلات والخبرات: " + e.message);
  }
}

function addEmployeeQualification(data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "addEmployeeQualification",
      data.sessionToken,
    );
    if (_permErr) return _permErr;
    if (!data.employee_id || !data.type || !data.title)
      return errResponse("الموظف والنوع والعنوان مطلوبون");

    var id = makeId("QUAL");
    var now = new Date().toISOString();

    // [ENGINE-UNIFY]
    _appendRowProtected(
      getSheet("EmployeeQualifications", ACCOUNTING_HR_HEADERS.EmployeeQualifications),
      ACCOUNTING_HR_HEADERS.EmployeeQualifications,
      [
      id,
      data.employee_id,
      data.type,
      data.title,
      data.institution || "",
      data.field || "",
      data.start_date || "",
      data.end_date || "",
      data.grade || "",
      data.notes || "",
      now,
      data.callerUser,
    ]);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    _hrAuditLog(
      data.callerUser,
      "ADD_EMPLOYEE_QUALIFICATION",
      "EmployeeQualifications",
      id,
      "إضافة مؤهل/خبرة: " + data.title,
    );
    return okResponse("تمت الإضافة بنجاح", { id: id });
  } catch (e) {
    return errResponse("خطأ في إضافة المؤهل: " + e.message);
  }
}

function updateEmployeeQualification(id, data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "updateEmployeeQualification",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    var sheet = getSheet(
      "EmployeeQualifications",
      ACCOUNTING_HR_HEADERS.EmployeeQualifications,
    );
    var rows = readSheet(
      "EmployeeQualifications",
      ACCOUNTING_HR_HEADERS.EmployeeQualifications,
      { trimStrings: true },
    );
    var idx = rows.findIndex(function (r) {
      return r.id === id;
    });
    if (idx === -1) return errResponse("السجل غير موجود");

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var updates = {};
    [
      "type",
      "title",
      "institution",
      "field",
      "start_date",
      "end_date",
      "grade",
      "notes",
    ].forEach(function (f) {
      if (data[f] !== undefined) updates[f] = data[f];
    });
    _applyRowUpdates(sheet, idx + 2, headers, updates);

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    _hrAuditLog(
      data.callerUser,
      "UPDATE_EMPLOYEE_QUALIFICATION",
      "EmployeeQualifications",
      id,
      "تعديل مؤهل/خبرة",
    );
    return okResponse("تم التحديث بنجاح");
  } catch (e) {
    return errResponse("خطأ في تعديل المؤهل: " + e.message);
  }
}

function deleteEmployeeQualification(id, callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    var r = DeleteEngine.delete("employeeQualification", id, callerUser, sessionToken);
    if (!r.success) return errResponse(r.message, r.code);
    return okResponse(r.message, r.data);
  } catch (e) {
    return errResponse("خطأ في حذف المؤهل: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-19c  HR — Employee Policy (Tab: Employee Policy) [HR-TABS-P1]
// ─────────────────────────────────────────────────────────────
// نص السياسة نفسه شركة-واحد (مش لكل موظف) ومُخزَّن في شيت Settings العام
// الموجود بالفعل (نفس محرك _getCompanySettingsRaw/_saveCompanySettings
// المستخدم في باقي المشروع — بدون إنشاء أي محرك إعدادات جديد).
// إقرار الموظف نفسه (هل قرأ/وافق) مُخزَّن على مستوى كل موظف في شيت
// Employees (policy_acknowledged / policy_acknowledged_at).
// ─────────────────────────────────────────────────────────────

function getEmployeePolicyContent() {
  try {
    var settings = _getCompanySettingsRaw();
    return {
      success: true,
      data: { content: settings.employee_policy_content || "" },
    };
  } catch (e) {
    return errResponse("خطأ في جلب نص السياسة: " + e.message);
  }
}

function saveEmployeePolicyContent(data) {
  try {
    if (!data || !data.callerUser) return errResponse("يجب تسجيل الدخول");
    var _permErr = _checkPermission(
      data.callerUser,
      "manageEmployeePolicy",
      data.sessionToken,
    );
    if (_permErr) return _permErr;

    _saveCompanySettings({
      employee_policy_content: data.content || "",
    });

    _hrAuditLog(
      data.callerUser,
      "UPDATE_EMPLOYEE_POLICY",
      "Settings",
      "employee_policy_content",
      "تعديل نص سياسة الموظفين",
    );
    return okResponse("تم حفظ نص السياسة بنجاح");
  } catch (e) {
    return errResponse("خطأ في حفظ نص السياسة: " + e.message);
  }
}

function acknowledgeEmployeePolicy(employeeId, callerUser, sessionToken) {
  try {
    if (!callerUser) return errResponse("يجب تسجيل الدخول");
    // إقرار الموظف بالسياسة يكفيه صلاحية عرض/تعديل بياناته الأساسية
    var _permErr = _checkPermission(callerUser, "updateEmployee", sessionToken);
    if (_permErr) return _permErr;

    var sheet = getSheet("Employees", ACCOUNTING_HR_HEADERS.Employees);
    var rows = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    var idx = rows.findIndex(function (r) {
      return r.id === employeeId;
    });
    if (idx === -1) return errResponse("الموظف غير موجود");

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    _applyRowUpdates(sheet, idx + 2, headers, {
      policy_acknowledged: "TRUE",
      policy_acknowledged_at: new Date().toISOString(),
    });

    _invalidateServerCacheHR(); // [PERF-SCOPED-INVALIDATION-HR] scoped (was blanket _invalidateServerCache — see Code_12d_Cache.js)
    _hrAuditLog(
      callerUser,
      "ACKNOWLEDGE_EMPLOYEE_POLICY",
      "Employees",
      employeeId,
      "إقرار الموظف بسياسة الشركة",
    );
    return okResponse("تم تسجيل الإقرار بنجاح");
  } catch (e) {
    return errResponse("خطأ في تسجيل الإقرار: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §EXT-20  HR — Dashboard Stats (إحصائيات HR)
// ═══════════════════════════════════════════════════════════════════════════════

// [PERF-HR-DASH] كاش قصير المدى لإحصائيات لوحة HR — كانت الدالة بتقرا 4 شيتات
// كاملة (Employees/Attendance/LeaveRequests/LoanRequests) من جديد في كل مرة
// يُفتح فيها HR Dashboard، وده السبب الجذري لتأخر ظهور اللوحة لعدة ثوانٍ.
// مدة الكاش قصيرة (90 ثانية) لأن "حاضر اليوم" بيانات شبه-حية ولازم تفضل طرية.
var HR_DASH_CACHE_KEY = "wms_hrdash_v1";
var HR_DASH_CACHE_TTL = 90; // ثانية

function getHRDashboardStats() {
  try {
    var cached = _loadServerCache(HR_DASH_CACHE_KEY);
    if (cached) {
      cached._from_cache = true;
      return cached;
    }
  } catch (e) {
    console.error("getHRDashboardStats - خطأ في قراءة الكاش:", e.message || e);
  }
  try {
    var employees = readSheet("Employees", ACCOUNTING_HR_HEADERS.Employees, {
      trimStrings: true,
    });
    var attendance = readSheet("Attendance", ACCOUNTING_HR_HEADERS.Attendance, {
      trimStrings: true,
    });
    var leaves = readSheet(
      "LeaveRequests",
      ACCOUNTING_HR_HEADERS.LeaveRequests,
      { trimStrings: true },
    );
    var loans = readSheet("LoanRequests", ACCOUNTING_HR_HEADERS.LoanRequests, {
      trimStrings: true,
    });

    var activeEmps = employees.filter(function (e) {
      return e.status === "ACTIVE";
    });
    var today = new Date().toISOString().split("T")[0];
    var todayAttendance = attendance.filter(function (a) {
      return a.date === today;
    });
    var presentToday = todayAttendance.filter(function (a) {
      return a.status === "PRESENT" || a.status === "LATE";
    }).length;

    // بناء تفاصيل سجلات الحضور اليوم مع اسم الموظف
    var empMap = {};
    employees.forEach(function (e) {
      empMap[e.id] = e.full_name || e.id;
    });
    var todayRows = todayAttendance.map(function (a) {
      return {
        employee_id: a.employee_id,
        employee_name: empMap[a.employee_id] || a.employee_id,
        check_in: a.check_in || "",
        check_out: a.check_out || "",
        status: a.status || "PRESENT",
      };
    });
    var absentToday = activeEmps.length - presentToday;
    var pendingLeaves = leaves.filter(function (l) {
      return l.status === "PENDING";
    }).length;
    var pendingLoans = loans.filter(function (l) {
      return l.status === "PENDING";
    }).length;

    var hrDashResponse = {
      success: true,
      data: {
        total_employees: employees.length,
        active_employees: activeEmps.length,
        terminated_employees: employees.filter(function (e) {
          return e.status === "TERMINATED";
        }).length,
        on_leave_employees: employees.filter(function (e) {
          return e.status === "ON_LEAVE";
        }).length,
        present_today: presentToday,
        absent_today: absentToday > 0 ? absentToday : 0,
        pending_leaves: pendingLeaves,
        pending_loans: pendingLoans,
        avg_basic_salary:
          activeEmps.length > 0
            ? Math.round(
                (activeEmps.reduce(function (s, e) {
                  return s + Number(e.basic_salary || 0);
                }, 0) /
                  activeEmps.length) *
                  100,
              ) / 100
            : 0,
        today: today,
        today_attendance: todayRows,
      },
    };
    try {
      _saveServerCache(hrDashResponse, HR_DASH_CACHE_KEY, HR_DASH_CACHE_TTL);
    } catch (cacheErr) {
      console.error(
        "getHRDashboardStats - فشل حفظ الكاش:",
        cacheErr.message || cacheErr,
      );
    }
    return hrDashResponse;
  } catch (e) {
    return errResponse("خطأ في جلب إحصائيات HR: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════

// ┄┄┄ [مصدر: Code.js سطور 25708-26019] Attendance Import Batch ┄┄┄
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * importAttendanceBatch — استيراد دُفعة من سجلات الحضور
 * @param {object} payload — { records: [...], meta: {...}, _user, _token }
 */
function importAttendanceBatch(payload) {
  try {
    var auth = _requirePermission(payload, "importAttendance");
    var records = payload.records || [];
    var meta = payload.meta || {};
    if (!records.length) return { success: false, message: "لا توجد سجلات" };

    // [ATTENDANCE-SCHEMA-UNIFY] كانت الدالة بتنشئ شيت Attendance بسكيمة
    // خاصة بيها مختلفة عن ACCOUNTING_HR_HEADERS.Attendance المستخدمة في
    // باقي شاشات الحضور — ده كان يسبب انزلاق أعمدة فعلي. الآن تمر بالكامل
    // عبر DataLayer وعلى نفس المصفوفة الموحّدة المسجّلة في Code_12_Core.js.
    var sessionId = "IMP-" + Date.now();
    var now = new Date().toISOString();
    var saved = 0,
      dupes = 0,
      errors = 0;

    // بناء فهرس السجلات الموجودة لاكتشاف التكرار (بالاسم لا بترتيب الأعمدة)
    var existingRes = DataLayer.getAll("Attendance");
    var existingKeys = {};
    if (existingRes.success) {
      existingRes.data.forEach(function (r) {
        existingKeys[String(r.employee_id) + "_" + String(r.date)] = true;
      });
    }

    var newRows = [];
    records.forEach(function (rec) {
      var dupKey = String(rec.employee_id) + "_" + String(rec.date);
      if (existingKeys[dupKey]) {
        dupes++;
        return;
      }
      existingKeys[dupKey] = true;

      var status = _calcAttendanceStatus(rec);

      newRows.push({
        id: "ATT-" + Date.now() + "-" + ++saved,
        employee_id: rec.employee_id,
        employee_number: rec.employee_number,
        date: rec.date,
        check_in: rec.check_in,
        check_out: rec.check_out,
        work_hours: rec.work_hours || 0,
        status: status,
        movement_type: rec.movement_type || "PUNCH",
        device_name: rec.device_name || "",
        badge_number: rec.badge_number || "",
        source: "import",
        import_session_id: sessionId,
        created_at: now,
        notes: "",
      });
    });

    if (newRows.length) {
      var insRes = DataLayer.bulkInsert("Attendance", newRows);
      if (!insRes.success)
        return { success: false, message: insRes.errorMessage };
    }

    // حفظ سجل الاستيراد
    var logStatus = errors > 0 ? "PARTIAL" : "SUCCESS";
    DataLayer.insert("AttendanceImportLog", {
      id: sessionId,
      user_id: auth.id,
      user_name: auth.full_name,
      file_name: meta.file_name || "",
      device_type: meta.device_type || "",
      total_in_file: meta.total_in_file || 0,
      valid_count: meta.valid_count || 0,
      saved_count: saved,
      duplicates: dupes,
      rejected_count: meta.rejected_count || 0,
      status: logStatus,
      rejected_details: JSON.stringify(
        (meta.rejected_details || []).slice(0, 100),
      ),
      created_at: now,
    });

    return {
      success: true,
      session_id: sessionId,
      saved: saved,
      duplicates: dupes,
      errors: errors,
      message: "تم استيراد " + saved + " سجل بنجاح",
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/** حساب حالة الحضور تلقائياً */
function _calcAttendanceStatus(rec) {
  if (!rec.check_in) return "ABSENT";
  // يمكن تعديل هذه القيم من إعدادات النظام
  var workStartHour = 8; // ساعة بداية العمل
  var lateAfterMin = 15; // دقائق السماح
  var earlyLeaveMin = 30; // دقائق مغادرة مبكرة
  var overtimeMin = 30; // دقائق للعمل الإضافي

  var inParts = rec.check_in.split(":");
  var inMin = parseInt(inParts[0]) * 60 + parseInt(inParts[1] || 0);
  var startMin = workStartHour * 60;

  if (inMin > startMin + lateAfterMin) return "LATE";

  if (rec.check_out) {
    var workEnd = 17 * 60; // 5 مساءً كإعداد افتراضي
    var outParts = rec.check_out.split(":");
    var outMin = parseInt(outParts[0]) * 60 + parseInt(outParts[1] || 0);
    if (outMin > workEnd + overtimeMin) return "OVERTIME";
    if (outMin < workEnd - earlyLeaveMin) return "EARLY_LEAVE";
  }
  return "PRESENT";
}

/** إنشاء الورقة إن لم تكن موجودة */
function _getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    _protectTextColumns(sheet, headers); // حماية الصفر الأول
  }
  return sheet;
}
function getAttendanceImportLog(payload) {
  try {
    _requirePermission(payload, "viewImportLog");
    var res = DataLayer.getAll("AttendanceImportLog", {
      sortBy: "created_at",
      sortDir: "desc",
    });
    if (!res.success) return { success: true, data: [] };
    var rows = res.data.slice(0, 200);
    // فلترة بالتاريخ إن وُجد
    if (payload.from)
      rows = rows.filter(function (r) {
        return r.created_at >= payload.from;
      });
    if (payload.to)
      rows = rows.filter(function (r) {
        return r.created_at <= payload.to + "T23:59:59";
      });
    return { success: true, data: rows };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function getAttendanceImportDetail(payload) {
  try {
    _requirePermission(payload, "viewImportLog");
    var res = DataLayer.getById("AttendanceImportLog", payload.id);
    if (!res.success) return { success: false, message: "لم يُعثر على السجل" };
    var obj = res.data;
    try {
      obj.rejected_details = JSON.parse(obj.rejected_details || "[]");
    } catch (e) {
      obj.rejected_details = [];
    }
    return { success: true, data: obj };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function deleteAttendanceImport(payload) {
  _invalidateExtCache(); // [DATA-UNIFY] إسقاط كاش الحزمة الموسعة فوراً بعد أي تعديل
  try {
    _requirePermission(payload, "deleteImport");

    // حذف من سجل الاستيرادات
    DataLayer.remove("AttendanceImportLog", payload.id, { hard: true });

    // حذف سجلات الحضور المرتبطة (بالاسم import_session_id، لا بترتيب عمود رقمي)
    var attRes = DataLayer.find("Attendance", function (r) {
      return String(r.import_session_id) === String(payload.id);
    });
    if (attRes.success && attRes.data.length) {
      DataLayer.bulkDelete(
        "Attendance",
        attRes.data.map(function (r) {
          return r.id;
        }),
        { hard: true },
      );
    }
    return { success: true, message: "تم الحذف بنجاح" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function getAttendanceImportStats(user, token) {
  try {
    // [BUG-FIX] كانت r[4] بتُقرأ كـ"status" لكنها فعليًا عمود national_id
    // في ترتيب HEADERS.Employees الحقيقي — العدّاد كان دايمًا يرجّع صفر.
    var empRes = DataLayer.getAll("Employees");
    var activeEmp = empRes.success
      ? empRes.data.filter(function (r) {
          return r.status === "ACTIVE";
        }).length
      : 0;

    var logRes = DataLayer.count("AttendanceImportLog");
    var totalImports = logRes.success ? logRes.data : 0;

    // [BUG-FIX] كانت r[3]/r[4]/r[5] بتُقرأ كـ date/check_in/check_out
    // بافتراض سكيمة الاستيراد القديمة (15 عمود) — تحت السكيمة الموحّدة
    // الحالية (ACCOUNTING_HR_HEADERS.Attendance) الفهارس دي مختلفة، فكانت
    // النتيجة إحصائيات خاطئة تمامًا. الآن بالاسم مباشرة عبر DataLayer.
    var now = new Date();
    var monthPrefix =
      now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    var attRes = DataLayer.getAll("Attendance");
    var monthRec = 0,
      errRec = 0;
    if (attRes.success) {
      attRes.data.forEach(function (r) {
        if (String(r.date).indexOf(monthPrefix) === 0) {
          monthRec++;
          if (!r.check_in && !r.check_out) errRec++;
        }
      });
    }

    return {
      success: true,
      data: {
        active_employees: activeEmp,
        total_imports: totalImports,
        month_records: monthRec,
        error_records: errRec,
      },
    };
  } catch (e) {
    return { success: true, data: {} };
  }
}
// ══════════════════════════════════════════════════════════════════════
