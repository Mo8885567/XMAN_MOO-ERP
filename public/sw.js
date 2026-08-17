/* ============================================================
   MOO.ERP — Service Worker
   يوفر تجربة أوفلاين أساسية:
   - يخزّن الصفحة الرئيسية والملفات الأساسية عند أول زيارة (install)
   - عند فقدان الاتصال، يرجّع النسخة المخزّنة بدل شاشة الخطأ
   - يستخدم استراتيجية "Network First" للصفحات (لضمان آخر تحديث)
     و"Cache First" للأصول الثابتة (أيقونات/مانيفست)
   ============================================================ */

const CACHE_VERSION = "moo-erp-v1";
const CACHE_NAME = `moo-erp-cache-${CACHE_VERSION}`;

// الملفات التي يجب تخزينها فور تثبيت الـ Service Worker
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/catalog.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

// صفحة بديلة تظهر عند فقدان الاتصال ولو الصفحة المطلوبة غير مخزّنة
const OFFLINE_FALLBACK_URL = "/index.html";

// ---------- INSTALL ----------
// تخزين الملفات الأساسية مسبقًا
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          PRECACHE_URLS.map((url) =>
            cache.add(url).catch((err) => {
              // تجاهل أي ملف غير موجود بدون إيقاف باقي التخزين
              console.warn("[SW] فشل تخزين:", url, err);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

// ---------- ACTIVATE ----------
// حذف أي نسخ كاش قديمة من إصدارات سابقة
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("moo-erp-cache-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------- FETCH ----------
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // تجاهل أي طلب غير GET (POST/PUT مثلاً) — سيبها تعدي زي ما هي (API calls)
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // تجاهل طلبات النطاقات الخارجية أو الـ API (زي /api/gas) — لازم تكون Live دايمًا
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  // التنقل بين الصفحات (HTML) → Network First مع Fallback للكاش/الأوفلاين
  if (request.mode === "navigate" || request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(networkFirst(request));
    return;
  }

  // باقي الأصول الثابتة (manifest, icons, css, js...) → Cache First
  event.respondWith(cacheFirst(request));
});

// استراتيجية Network First: يجرّب الشبكة، ولو فشلت يرجع للكاش
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const networkResponse = await fetch(request);
    // تحديث الكاش بأحدث نسخة صحيحة
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cachedResponse = await cache.match(request);
    return (
      cachedResponse ||
      (await cache.match(OFFLINE_FALLBACK_URL)) ||
      new Response("أنت غير متصل بالإنترنت حاليًا.", {
        status: 503,
        statusText: "Offline",
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
      })
    );
  }
}

// استراتيجية Cache First: يرجع من الكاش فورًا، ولو غير موجود يجيبه من الشبكة ويخزّنه
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) return cachedResponse;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    return new Response("", { status: 504, statusText: "Offline" });
  }
}
