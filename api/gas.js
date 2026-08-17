/**
 * ═══════════════════════════════════════════════════════════════
 * /api/gas — Server-side proxy لـ Google Apps Script Web App.
 *
 * السبب: Apps Script doPost() لا يمكنه إضافة Access-Control-Allow-Origin
 * في الرد (قيد من Google نفسها) — يعني أي fetch() من دومين تاني
 * (moo-erp.vercel.app) لـ /exec هيترفض دايمًا من المتصفح بـ CORS،
 * بغض النظر عن صحة الرابط أو إعدادات الـ deployment.
 *
 * الحل: الفرونت يبعت لنفس الدومين (/api/gas) فمفيش CORS أصلاً،
 * والفانكشن دي (سيرفر لسيرفر، بدون قيد CORS) بتعمل الـ fetch
 * الحقيقي لـ Apps Script وترجع الرد زي ما هو + header يفتح CORS
 * لو احتجناها من دومين تالت مستقبلًا.
 *
 * الإعداد المطلوب على Vercel (مرة واحدة):
 *   Project Settings → Environment Variables →
 *     GAS_URL = https://script.google.com/macros/s/XXXXX/exec
 *   (خد الرابط من Apps Script Editor → Deploy → Manage deployments
 *    → Active deployment → Web app URL. لازم يبدأ بـ
 *    https://script.google.com/macros/s/ وينتهي بـ /exec)
 * ═══════════════════════════════════════════════════════════════
 */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const GAS_URL = process.env.GAS_URL;
  if (!GAS_URL) {
    res.status(500).json({
      error:
        "GAS_URL غير مضبوطة في Environment Variables بتاعة Vercel — راجع تعليق الملف ده.",
    });
    return;
  }

  try {
    // Vercel بيوصّل body كـ object لو Content-Type كان JSON، أو كـ
    // string لو text/plain (زي ما client.js بيبعتها). بنطبّعها لـ string
    // موحّد قبل إعادة إرسالها لـ Apps Script (اللي بيتوقع نص خام في e.postData.contents).
    const bodyStr =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    const upstream = await fetch(GAS_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: bodyStr,
    });

    const text = await upstream.text();

    // لو Apps Script رجّع صفحة HTML (لوجين جوجل / خطأ نشر) بدل JSON —
    // نفس الفحص الموجود في client.js، بس هنا كمان عشان يوصل واضح
    // للفرونت بدل ما يوصله HTML خام يفشل يـ.parse()
    if (text.trimStart().startsWith("<")) {
      res.status(502).json({
        error:
          "Apps Script رجّع صفحة HTML بدل JSON — تأكد إن GAS_URL بتاع Deployment فعّال وإعداد النشر Anyone.",
      });
      return;
    }

    res.status(upstream.status).setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: "فشل الاتصال بالخادم: " + err.message });
  }
};
