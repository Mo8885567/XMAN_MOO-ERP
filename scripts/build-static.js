#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * MOO.ERP — Build Script (Apps Script HTML → Static index.html)
 *
 * What it does: reads Index.html, which used to be served via
 * HtmlService.evaluate() inside Apps Script, resolves all the
 * dependencies that used to be resolved at request time on the
 * server, and produces a single static file ready to deploy on
 * Vercel.
 *
 * It does two things:
 *
 * 1) Resolves <?!= include('filename') ?> recursively — exactly
 *    what include() in Code_12_Core.js used to do, just at build
 *    time instead of on every request.
 *    Important note: this only covers the "eager" files (loaded
 *    with the first page open: base styles + Templates_01 + JS
 *    core). The other files (03_JS_Dashboard_Items, 12_JS_HR,
 *    Templates_02 through 10... etc, ~40 files) are "lazy" —
 *    fetched at runtime via google.script.run.getLazyAppBundle(),
 *    meaning they'll still be fetched via a normal API call just
 *    like now, no changes needed for this build.
 *    (But getLazyAppBundle DOES need to be added to
 *    DOPOST_ALLOWED_FUNCTIONS — see the "IMPORTANT" note at the
 *    end of this file.)
 *
 * 2) Replaces GAS templating expressions (<?!= ... ?> and
 *    <? ... ?>) that used to be evaluated on the server at
 *    request time with fixed/default values suitable for a
 *    static site (see GAS_EXPR_REPLACEMENTS below).
 *
 * Usage:
 *   node scripts/build-static.js
 *
 * Expected inputs (adjust paths if yours differ):
 *   ./gas-src/Index.html        (and all its related include files)
 * Output:
 *   ./public/index.html
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "gas-src");
const OUT_DIR = path.join(__dirname, "..", "public");

// [BUILD-FIX] The real version number — this used to always come out
// blank here, showing "v?" on the login screen (instead of the actual
// version next to "server running"). Now we read it automatically from
// the single source of truth (Code_42_AppVersion.js:
// var APP_VERSION = "X.Y.Z";) so the number always stays in sync when
// updated there, without anyone needing to edit two numbers in two
// different places.
function _readAppVersionFromSource() {
  try {
    var src = fs.readFileSync(
      path.join(SRC_DIR, "Code_42_AppVersion.js"),
      "utf8",
    );
    var m = src.match(/var\s+APP_VERSION\s*=\s*["']([^"']+)["']/);
    if (m) return m[1];
  } catch (e) {
    console.warn(
      "[build-static] Could not read APP_VERSION, falling back to empty value:",
      e.message,
    );
  }
  return "";
}
const APP_VERSION = _readAppVersionFromSource();

// each page has its own output + its own replacement function (defined below)
const PAGES = [
  {
    entry: "Index.html",
    out: "index.html",
    applyExtra: applyIndexReplacements,
  },
  {
    entry: "CatalogPublic.html",
    out: "catalog.html",
    applyExtra: applyCatalogReplacements,
  },
];

// ── same logic as getMooLogoSVG / getMooLogoDataURI in Code_12_Core.js
//    (pure functions with no Sheets dependency — safe to run at build time) ──
function getMooLogoSVG(px, opts) {
  px = px || 100;
  opts = opts || {};
  const withBg = opts.bg !== false;
  const mono = !!opts.mono;
  const c1 = mono ? "#fff" : "#2563EB";
  const c2 = mono ? "#fff" : "#10B981";
  const bg = withBg
    ? '<rect width="100" height="100" rx="18" fill="#0F172A"/>'
    : "";
  return (
    `<svg width="${px}" height="${px}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">` +
    bg +
    `<path d="M24 76 L24 22 L50 50" fill="none" stroke="${c1}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M50 50 L76 22 L76 76" fill="none" stroke="${c2}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}
function getMooLogoDataURI(px, opts) {
  return "data:image/svg+xml," + encodeURIComponent(getMooLogoSVG(px, opts));
}

// ── resolve include() recursively ───────────────────────────────
// looks up the file by name inside SRC_DIR (tries .html if the name has no extension)
const _includeCache = {};
function resolveIncludes(content, seenStack) {
  return content.replace(
    /<\?!=\s*include\(\s*['"]([^'"]+)['"]\s*\)\s*\?>/g,
    (match, name) => {
      if (seenStack.includes(name)) {
        throw new Error(
          `Circular include detected: ${seenStack.join(" -> ")} -> ${name}`,
        );
      }
      let fileContent = _includeCache[name];
      if (fileContent === undefined) {
        const filePath = path.join(
          SRC_DIR,
          name.endsWith(".html") ? name : `${name}.html`,
        );
        if (!fs.existsSync(filePath)) {
          console.warn(
            ` Missing include file: ${name} (${filePath}) — leaving it empty`,
          );
          return `<!-- MISSING INCLUDE: ${name} -->`;
        }
        fileContent = fs.readFileSync(filePath, "utf8");
        _includeCache[name] = fileContent;
      }
      return resolveIncludes(fileContent, seenStack.concat(name));
    },
  );
}

// ── GAS expression replacements specific to Index.html only (line by line, not generic) ──
// each one below was manually reviewed against the original Index.html (see each comment).
function applyIndexReplacements(html) {
  let out = html;

  // <? var _brandLogoUrl = getCompanyLogoUrlForSplash(); ?>
  // getCompanyLogoUrlForSplash() reads the server cache (a custom logo
  // from Settings) — not available at static build time. We always
  // assume it's "" (i.e. fallback to the default splash-screen logo);
  // the real logo will still load normally afterward from the screen
  // itself once the JS fetches companySettings.
  out = out.replace(
    /<\?\s*var _brandLogoUrl = getCompanyLogoUrlForSplash\(\);\s*\?>/,
    "",
  );

  // <? if (_brandLogoUrl) { ?> ... <? } else { ?> ... <? } ?>
  // Since _brandLogoUrl is always "" (falsy) in the static build, we
  // keep only the else branch and drop the condition entirely.
  out = out.replace(
    /<\?\s*if\s*\(_brandLogoUrl\)\s*\{\s*\?>[\s\S]*?<\?\s*\}\s*else\s*\{\s*\?>([\s\S]*?)<\?\s*\}\s*\?>/,
    "$1",
  );

  // other places that use _brandLogoUrl (always "" → falls back to getMooLogo*)
  out = out.replace(/<\?!=\s*_brandLogoUrl\s*\?\?\s*''\s*\?>/g, "");
  out = out.replace(
    /<\?!=\s*_brandLogoUrl\s*\?\s*''\s*:\s*'image\/svg\+xml'\s*\?>/g,
    "image/svg+xml",
  );
  out = out.replace(
    /<\?!=\s*_brandLogoUrl\s*\|\|\s*getMooLogoDataURI\((\d+)\)\s*\?>/g,
    (m, px) => getMooLogoDataURI(Number(px)),
  );
  out = out.replace(
    /<\?!=\s*getMooLogoSVG\((\d+)\)\.replace\(\/'\/g,\s*'&#39;'\)\s*\?>/g,
    (m, px) => getMooLogoSVG(Number(px)).replace(/'/g, "&#39;"),
  );
  out = out.replace(/<\?!=\s*getMooLogoSVG\((\d+)\)\s*\?>/g, (m, px) =>
    getMooLogoSVG(Number(px)),
  );

  // users: <?!= prefetchedUsers ?>,  → was always null on the server anyway
  // (FIX-ISSUE-005) — the frontend fetches them normally after login via getUsers.
  out = out.replace(/<\?!=\s*prefetchedUsers\s*\?>/g, "null");

  // items: <?!= prefetchedItems ?>, → no server cache ready at static
  // build time, so we leave it null and the frontend (as already
  // written in the doGet comment itself) will fetch it normally via
  // google.script.run if it finds it null.
  out = out.replace(/<\?!=\s*prefetchedItems\s*\?>/g, "null");

  // license: <?!= licenseStatus ?>, → normally computed server-side by
  // doGet via _getLicenseStatusCacheOnly() (Code_41_UpdateManagement.js),
  // used only to show a small "license expiring soon" banner above the
  // login form (_renderLicenseBanner() in Templates_01.html). Not
  // available at static build time. Safe to leave as null: the banner
  // code already guards for this — `var lic = (...&&...license) || null;
  // if (!lic || !lic.message) return "";` — so the banner is simply
  // skipped instead of breaking anything.
  out = out.replace(/<\?!=\s*licenseStatus\s*\?>/g, "null");

  // appVersion: <?!= JSON.stringify(appVersion) ?>
  // [BUILD-FIX] injecting the real version number, read automatically
  // from Code_42_AppVersion.js (instead of the blank value that used
  // to show up as "v?" on the login screen next to "server running").
  // If the file gets removed or the format changes, this falls back to
  // empty like before (safe fallback, nothing breaks).
  out = out.replace(
    /<\?!=\s*JSON\.stringify\(appVersion\)\s*\?>/g,
    JSON.stringify(APP_VERSION),
  );

  return out;
}

// ── CatalogPublic.html replacements ─────────────────────────────
// doGet(page=catalog) used to read e.parameter and inject the values
// as ready-made JSON. In the static version there's no doGet at all,
// so instead of the injection we put a small script that reads the
// same values directly from window.location.search — the exact same
// names and parameters (groups/wh/noprices/showzero/noqty/client) so
// any old catalog link already shared with customers keeps working
// as-is.
function applyCatalogReplacements(html) {
  let out = html;

  out = out.replace(
    /<\?!=\s*include\(\s*['"]TablerIconsEmbedded['"]\s*\)\s*\?>/,
    (m) => m, // already resolved in resolveIncludes before we get here
  );

  // replace the whole block (6 lines) at once with the shim, to keep
  // the same order and avoid a partial replace leaving conflicting
  // variable names.
  out = out.replace(
    /var _URL_GROUPS = <\?!= urlGroups\s*\?>;\s*\n\s*var _URL_WH = <\?!= urlWh\s*\?>;\s*\n\s*var _URL_NOPRICES = <\?!= urlNoprices\s*\?>;\s*\n\s*var _URL_SHOWZERO = <\?!= urlShowzero\s*\?>;[^\n]*\n\s*var _URL_NOQTY = <\?!= urlNoqty\s*\?>;[^\n]*\n\s*var _URL_CLIENT = <\?!= urlClient\s*\?>;[^\n]*/,
    [
      "var _qs = new URLSearchParams(window.location.search);",
      "var _URL_GROUPS = JSON.stringify((_qs.get('groups') || '').trim());",
      "var _URL_WH = JSON.stringify((_qs.get('wh') || '').trim());",
      "var _URL_NOPRICES = JSON.stringify((_qs.get('noprices') || '').trim());",
      "var _URL_SHOWZERO = JSON.stringify((_qs.get('showzero') || '').trim()); // \"1\" = show zero-stock items",
      "var _URL_NOQTY = JSON.stringify((_qs.get('noqty') || '').trim()); // \"1\" = hide stock from the customer",
      "var _URL_CLIENT = JSON.stringify((_qs.get('client') || '').trim()); // customer name for the welcome message",
    ].join("\n      "),
  );

  return out;
}

function warnUnresolvedTags(html) {
  const remaining = html.match(/<\?[\s\S]*?\?>/g);
  if (remaining && remaining.length) {
    console.warn(
      `\n ${remaining.length} GAS expression(s) still unresolved — these need to be handled manually:`,
    );
    remaining.forEach((tag) =>
      console.warn("   " + tag.replace(/\n/g, " ").slice(0, 120)),
    );
  } else {
    console.log(" All <? ... ?> expressions resolved.");
  }
}

// ── inject client.js + first-run GAS_URL setup screen ────────────
// [VERCEL-MIGRATION][FIX] The two output pages had no loading of
// src/api/client.js (the google.script.run replacement) and no UI to
// set GAS_URL at all, even though the README refers to it in
// deployment step 5. Without it, google.script.run doesn't exist and
// the first call on the page would immediately throw
// "google is not defined".
// The fix here does two things at build time:
//   1) copies src/api/client.js into public/src/api/client.js (it has
//      to be inside public/ so Vercel can actually serve it in the
//      default static deploy — anything outside public/ isn't
//      uploaded as a URL-accessible static asset).
//   2) injects <script src="/src/api/client.js"> + a small setup
//      screen that asks for the /exec URL the first time and stores
//      it via GAS.setUrl(), right after <body> opens (before any
//      other code calls google.script.run).
// [BUILD-FIX] The old path used to point at
// moo-erp-vercel/src/api/client.js, but the file was actually in a
// completely separate folder (moo-erp-vercel-deploy-ready/src/api/client.js),
// so it was never found, and the script would just print a warning and
// return false without stopping the rest of the build. Now we check
// several candidate paths in order and use whichever one actually
// exists — so it works whether the file got moved to the right place
// (src/api/) or is still in the old folder
// (moo-erp-vercel-deploy-ready/src/api/).
const CLIENT_JS_CANDIDATES = [
  path.join(__dirname, "..", "src", "api", "client.js"),
  path.join(
    __dirname,
    "..",
    "moo-erp-vercel-deploy-ready",
    "src",
    "api",
    "client.js",
  ),
];
const CLIENT_JS_SRC =
  CLIENT_JS_CANDIDATES.find((p) => fs.existsSync(p)) || CLIENT_JS_CANDIDATES[0];
const CLIENT_JS_PUBLIC_REL = "src/api/client.js";

// ── build-time fixed GAS_URL (optional) ──────────────────────────
// [VERCEL-MIGRATION][FIX] The interactive setup screen is fine for
// index.html (the admin opens it once in their browser and it gets
// stored in their localStorage). But catalog.html is a public page
// opened by outside customers (a link shared over WhatsApp/email) —
// it wouldn't make sense to ask every customer to "know" your Apps
// Script URL and enter it manually. It needs to be injected as a
// fixed value at deploy time.
// Usage (option 1 — environment variable, no file edits needed):
//   MOO_GAS_URL="https://script.google.com/macros/s/AKfx.../exec" node scripts/build-static.js
//
// Usage (option 2 — easier if you'd rather write the link inside the
// file once and just keep running this command without typing the
// link every time):
//   Paste the deployment URL (must start with
//   https://script.google.com/macros/s/ and end with /exec) between
//   the quotes below. If left empty '', the script automatically
//   falls back to the MOO_GAS_URL environment variable (option 1), or
//   to the interactive setup screen if both are empty.
// [CORS-FIX] The real URL now lives as the "GAS_URL" Environment
// Variable on Vercel itself, read server-to-server inside api/gas.js
// — neither the frontend nor this build step need to know it anymore.
// The old setup screen (which used to inject the script.google.com
// URL directly into the browser) has been removed entirely, since it
// led to a CORS call that could never succeed in the first place.
function buildSetupOverlayScript() {
  return `
    <!-- [VERCEL-MIGRATION] google.script.run replacement — talks to /api/gas on the same domain -->
    <script src="/${CLIENT_JS_PUBLIC_REL}"></script>`;
}

function injectClientBootstrap(html) {
  if (!/<body[^>]*>/.test(html)) {
    console.warn(
      " No <body> tag found in the page — client.js will not be injected. Review the file manually.",
    );
    return html;
  }
  return html.replace(/<body([^>]*)>/, `<body$1>${buildSetupOverlayScript()}`);
}

function copyClientJsIntoPublic() {
  if (!fs.existsSync(CLIENT_JS_SRC)) {
    console.error(` Could not find ${CLIENT_JS_SRC} — client.js will not be injected correctly.`);
    return false;
  }
  const destDir = path.join(OUT_DIR, "src", "api");
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(CLIENT_JS_SRC, path.join(destDir, "client.js"));
  console.log(
    ` Copied client.js to ${path.join("public", CLIENT_JS_PUBLIC_REL)}`,
  );
  return true;
}

function buildPage({ entry, out, applyExtra }) {
  const entryPath = path.join(SRC_DIR, entry);
  if (!fs.existsSync(entryPath)) {
    console.error(` Could not find ${entryPath} — skipping.`);
    return false;
  }

  console.log(`\n--- ${entry} → ${out} ---`);
  let html = fs.readFileSync(entryPath, "utf8");

  console.log("▶ Resolving include() recursively...");
  html = resolveIncludes(html, [entry]);

  console.log("▶ Replacing dynamic GAS expressions with fixed values...");
  html = applyExtra(html);

  console.log("▶ Injecting client.js + GAS_URL setup screen...");
  html = injectClientBootstrap(html);

  warnUnresolvedTags(html);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, out);
  fs.writeFileSync(outPath, html, "utf8");
  console.log(` Done: ${outPath} (${(html.length / 1024).toFixed(0)} KB)`);
  return true;
}

function main() {
  console.log(
    "\n GAS_URL is now an Environment Variable on Vercel (read server-to-server inside api/gas.js) — nothing to configure here at build time.",
  );
  let allOk = copyClientJsIntoPublic();
  for (const page of PAGES) {
    // separate include() cache per page (some files may differ between pages)
    Object.keys(_includeCache).forEach((k) => delete _includeCache[k]);
    const ok = buildPage(page);
    allOk = allOk && ok;
  }
  if (!allOk) process.exit(1);
}

main();

/**
 * ═══════════════════════════════════════════════════════════════
 * IMPORTANT — must be done on the backend before deploying, or the
 * new frontend (after the switch to client.js) won't work correctly:
 *
 * getLazyAppBundle() (which returns all the Dashboard/HR/Accounting/
 * Invoices... modules, ~40 files) is currently called from the
 * frontend via google.script.run.getLazyAppBundle()
 * (01_JS_Core_Auth.html:99). Inside the original Apps Script
 * HtmlService, this worked because a real google.script.run does a
 * direct RPC, never going through doPost at all.
 *
 * But after the migration, client.js routes every call (including
 * this one) through doPost — and getLazyAppBundle is *not currently*
 * in DOPOST_ALLOWED_FUNCTIONS (Code_12_Core.js, around line
 * 74-626). That means if we deploy as-is without adding it, the
 * first thing that happens right after login is that every module in
 * the system (practically every screen) will refuse to load, with
 * "Function not permitted: getLazyAppBundle".
 *
 * Fix: add "getLazyAppBundle" to the DOPOST_ALLOWED_FUNCTIONS list.
 * And since it's called right after login (before the rest of the
 * screens load), it's also best to add it to
 * DOPOST_PUBLIC_FUNCTIONS (it holds no sensitive data anyway — it's
 * just static JS/CSS/HTML files), so it can still be fetched even if
 * there's a brief delay loading the token right after login.
 * ═══════════════════════════════════════════════════════════════
 */
