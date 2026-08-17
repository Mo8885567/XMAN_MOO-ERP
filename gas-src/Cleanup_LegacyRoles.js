/**
 * cleanupLegacyCustomRoles — أداة تنظيف تُشغَّل مرة واحدة يدويًا من محرر
 * Apps Script (اختر الدالة من القائمة المنسدلة فوق ثم اضغط Run)، مش
 * مربوطة بأي زرار في الواجهة.
 *
 * بتحذف نهائيًا 4 أدوار مخصصة قديمة فاضلة في شيت Roles (باقية من نسخة
 * قديمة من مولّد البيانات التجريبية قبل ما يتصلّح):
 *   production_supervisor, sales_rep, warehouse_keeper, sales_manager
 *
 * قبل الحذف: أي مستخدم متعين بأي دور من دول بيتحوّل تلقائيًا لدور
 * "viewer" (مشاهد) — عشان الحذف يعدي من غير ما deleteRole يرفضه بسبب
 * "مستخدمون مرتبطون". كل تحويل وكل حذف بيتسجل في AuditLog.
 *
 * آمنة للتشغيل أكتر من مرة (idempotent) — لو الدور مش موجود أصلاً
 * بيتخطاه بهدوء.
 */
function cleanupLegacyCustomRoles() {
  var LEGACY_ROLE_NAMES = [
    "production_supervisor",
    "sales_rep",
    "warehouse_keeper",
    "sales_manager",
  ];
  var FALLBACK_ROLE = "viewer";
  var report = { reassignedUsers: [], deletedRoles: [], skipped: [] };

  try {
    var rolesSheet = getSheet("Roles", ROLES_HEADERS);
    var roleRows = readSheet("Roles", ROLES_HEADERS, { trimStrings: true });
    var usersSheet = getSheet("Users");
    var userRows = readSheet("Users", null, { trimStrings: true });

    LEGACY_ROLE_NAMES.forEach(function (roleName) {
      var roleRow = roleRows.find(function (r) {
        return r.name === roleName;
      });
      if (!roleRow) {
        report.skipped.push(roleName + " (غير موجود أصلاً)");
        return;
      }

      // 1) حوّل أي مستخدم مرتبط بالدور ده إلى viewer قبل الحذف
      userRows.forEach(function (u) {
        if (String(u.role || "").trim() === roleName) {
          var uRow = null;
          // نلاقي الصف الفعلي في الشيت بالـ username عشان نعدّل عمود role
          var allUsers = readSheet("Users", null, { trimStrings: true });
          for (var i = 0; i < allUsers.length; i++) {
            if (allUsers[i].username === u.username) {
              uRow = allUsers[i];
              break;
            }
          }
          if (uRow && uRow._row) {
            var headers = usersSheet
              .getRange(1, 1, 1, usersSheet.getLastColumn())
              .getValues()[0]
              .map(function (h) {
                return String(h || "").trim();
              });
            var roleColIdx = headers.indexOf("role");
            if (roleColIdx !== -1) {
              usersSheet.getRange(uRow._row, roleColIdx + 1).setValue(FALLBACK_ROLE);
              report.reassignedUsers.push(u.username + " (" + roleName + " → " + FALLBACK_ROLE + ")");
              _writeAuditLog({
                user: "SYSTEM",
                action: "REASSIGN_ROLE",
                table: "Users",
                record_id: u.username,
                details: "تحويل تلقائي من دور محذوف (" + roleName + ") إلى " + FALLBACK_ROLE,
              });
            }
          }
        }
      });

      // 2) احذف صف الدور نفسه من شيت Roles
      var freshRoleRows = readSheet("Roles", ROLES_HEADERS, { trimStrings: true });
      var freshRoleRow = freshRoleRows.find(function (r) {
        return r.name === roleName;
      });
      if (freshRoleRow && freshRoleRow._row) {
        rolesSheet.deleteRow(freshRoleRow._row);
        report.deletedRoles.push(roleName);
        _writeAuditLog({
          user: "SYSTEM",
          action: "DELETE_ROLE",
          table: "Roles",
          record_id: freshRoleRow.id,
          details: "حذف دور مخصص قديم فاضل (تنظيف): " + roleName,
        });
      }
    });

    _invalidateServerCache();
    Logger.log(JSON.stringify(report, null, 2));
    return report;
  } catch (e) {
    Logger.log("cleanupLegacyCustomRoles خطأ: " + e.message);
    throw e;
  }
}
