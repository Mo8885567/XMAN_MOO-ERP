#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * MOO.ERP — Audit Script: google.script.run calls vs DOPOST_ALLOWED_FUNCTIONS
 *
 * Compares every actual google.script.run.X(...) call found in the HTML
 * files against the DOPOST_ALLOWED_FUNCTIONS list in Code_12_Core.js,
 * and reports any function that's called from the frontend but is NOT
 * in the allowlist — meaning it would fail with "Function not permitted"
 * after the switch to client.js (because google.script.run now actually
 * goes through doPost instead of a direct RPC inside Apps Script).
 *
 * Run it after any frontend change (new screen, new function) before
 * deploying:
 *   node audit-allowlist.js
 *
 * Note: automatically excludes any name found inside a comment marked
 * as an "example" or similar (like the RULE1 illustrative comments
 * already present in 31_JS_DataLayer.html / 32_JS_SaveEngine.html) —
 * if you still see a false positive like that, review it manually;
 * this script is a warning tool, not 100% authoritative.
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = process.argv[2] || '.';
const CORE_FILE = 'Code_12_Core.js';
const HANDLER_NAMES = new Set(['withSuccessHandler', 'withFailureHandler', 'withUserObject']);
// generic names known to be placeholder examples in comments, not real calls
const KNOWN_PLACEHOLDER_NAMES = new Set(['addX', 'getFn', 'functionName', 'yourFunction']);

function extractList(coreContent, varName) {
  const re = new RegExp('var ' + varName + '\\s*=\\s*\\[([\\s\\S]*?)\\];');
  const m = coreContent.match(re);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/["']([A-Za-z0-9_]+)["']/g)].map((x) => x[1]));
}

// Known indirect-call patterns used instead of google.script.run.X()
// (wrapper functions that take the function name as a string argument
// and then call google.script.run[fnName] dynamically inside — like
// _gsr() in 31_JS_DataLayer.html). If you add a new wrapper like this
// to the project, add its pattern here too, or the audit won't catch
// functions called through it.
const INDIRECT_CALL_PATTERNS = [
  { name: '_gsr()', regex: /_gsr\(\s*["']([A-Za-z0-9_]+)["']/g },
];

function findIndirectCalls(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const callsByFn = {};
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const pattern of INDIRECT_CALL_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m;
      while ((m = pattern.regex.exec(content)) !== null) {
        const fn = m[1];
        if (KNOWN_PLACEHOLDER_NAMES.has(fn)) continue;
        if (!callsByFn[fn]) callsByFn[fn] = new Set();
        callsByFn[fn].add(`${f} (via ${pattern.name})`);
      }
    }
  }
  return callsByFn;
}

function findFunctionCalls(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const callsByFn = findIndirectCalls(dir);

  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    let idx = 0;
    while ((idx = content.indexOf('google.script.run', idx)) !== -1) {
      let pos = idx + 'google.script.run'.length;
      let foundFn = null;

      for (let hop = 0; hop < 6; hop++) {
        const m = content.slice(pos).match(/^\s*\.\s*([A-Za-z0-9_$]+)\s*\(/);
        if (!m) break;
        const name = m[1];
        pos += m[0].length;
        if (HANDLER_NAMES.has(name)) {
          let depth = 1;
          while (depth > 0 && pos < content.length) {
            if (content[pos] === '(') depth++;
            else if (content[pos] === ')') depth--;
            pos++;
          }
          continue;
        }
        foundFn = name;
        break;
      }

      if (foundFn && !KNOWN_PLACEHOLDER_NAMES.has(foundFn)) {
        if (!callsByFn[foundFn]) callsByFn[foundFn] = new Set();
        callsByFn[foundFn].add(f);
      }
      idx += 'google.script.run'.length;
    }
  }
  return callsByFn;
}

function main() {
  const corePath = path.join(SRC_DIR, CORE_FILE);
  if (!fs.existsSync(corePath)) {
    console.error(`Could not find ${corePath}. Run this script from inside the project folder, or pass the path as an argument.`);
    process.exit(1);
  }

  const core = fs.readFileSync(corePath, 'utf8');
  const allowed = extractList(core, 'DOPOST_ALLOWED_FUNCTIONS');
  const pub = extractList(core, 'DOPOST_PUBLIC_FUNCTIONS');
  const callsByFn = findFunctionCalls(SRC_DIR);
  const allFns = Object.keys(callsByFn).sort();

  console.log('Unique functions called from the frontend:', allFns.length);
  console.log('Functions in DOPOST_ALLOWED_FUNCTIONS:', allowed.size);
  console.log('Functions in DOPOST_PUBLIC_FUNCTIONS:', pub.size);

  const missing = allFns.filter((fn) => !allowed.has(fn));

  // cross-check: is the function actually defined as "function X(" in any .js file?
  // if not, it's probably a name in a comment/example, not a real call — not a
  // security issue, but worth a manual look instead of auto-adding it to the allowlist.
  const jsFiles = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'));
  const definedFns = new Set();
  for (const f of jsFiles) {
    const c = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    const re = /function\s+([A-Za-z0-9_]+)\s*\(/g;
    let m;
    while ((m = re.exec(c)) !== null) definedFns.add(m[1]);
  }

  const realGaps = missing.filter((fn) => definedFns.has(fn));
  const suspicious = missing.filter((fn) => !definedFns.has(fn));

  console.log(`\n=== Real gaps — function exists in the backend but is not permitted in doPost (${realGaps.length}) ===`);
  if (!realGaps.length) {
    console.log(' (none — all covered)');
  } else {
    realGaps.forEach((fn) => console.log(`  - ${fn}   [${[...callsByFn[fn]].join(', ')}]`));
  }

  if (suspicious.length) {
    console.log(`\n=== Names called from the frontend with no "function X(" definition found in any .js file (${suspicious.length}) ===`);
    console.log('    (likely placeholder examples in comments or aliases — review manually, these will NOT be auto-added)');
    suspicious.forEach((fn) => console.log(`  - ${fn}   [${[...callsByFn[fn]].join(', ')}]`));
  }

  const notPublicButNoTokenPatterns = allFns.filter(
    (fn) => allowed.has(fn) && !pub.has(fn)
  );
  console.log(
    `\n=== ℹ️  Functions that require a valid sessionToken in args (not public) — count: ${notPublicButNoTokenPatterns.length} ===`
  );
  console.log('   (client.js attaches the token automatically, so usually no action is needed here)');

  process.exit(realGaps.length ? 2 : 0);
}

main();
