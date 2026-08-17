#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * MOO.ERP — Deploy All (one script that does everything)
 *
 * Order (stops immediately if any step fails — to avoid mistakes):
 *   1) Syntax check for every gas-src/*.js and *.gs file (like node --check)
 *   2) audit-allowlist: makes sure every google.script.run.X() used in the
 *      frontend exists in DOPOST_ALLOWED_FUNCTIONS (Code_12_Core.js)
 *   3) build-static: builds public/index.html + public/catalog.html
 *      from gas-src + copies client.js
 *   4) clasp push: uploads all gas-src files to the backend (Apps Script)
 *   5) clasp deploy -i <DEPLOYMENT_ID>: updates the *same* active
 *      deployment (does not create a new one) — meaning the URL (GAS_URL)
 *      stored in Vercel stays the same, untouched
 *   6) git add + commit + push: if the project is a Git repo connected to
 *      Vercel (auto-deploy on push), the built frontend gets pushed automatically
 *
 * One-time setup:
 *   - clasp: npm i -g @google/clasp && clasp login
 *   - fill in scripts/deploy-config.json (see deploy-config.example.json)
 *     with the deploymentId of the currently active deployment
 *     (get it with: clasp deployments  — from inside gas-src/)
 *
 * Usage:
 *   node scripts/deploy-all.js "commit message here"
 *   node scripts/deploy-all.js --skip-git      (build + deploy backend only)
 *   node scripts/deploy-all.js --skip-gas      (build + push frontend only)
 *   node scripts/deploy-all.js --dry-run        (check + build only, no real deploy)
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const GAS_SRC = path.join(ROOT, "gas-src");
const CONFIG_PATH = path.join(__dirname, "deploy-config.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP_GIT = args.includes("--skip-git") || DRY_RUN;
const SKIP_GAS = args.includes("--skip-gas") || DRY_RUN;
const commitMsgArg = args.find((a) => !a.startsWith("--"));
const COMMIT_MSG = commitMsgArg || "Automatic update via deploy-all.js";

// ── log file (kept in case mixed-direction text ever gets added
//    back; harmless to leave in with English-only output) ───────
const LOG_PATH = path.join(ROOT, "deploy-report.txt");
const logLines = [];
function stripAnsi(s) {
  // strip ANSI color codes before writing to the file
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function logToFile(msg) {
  logLines.push(stripAnsi(String(msg)));
}
function flushLog() {
  try {
    const header =
      `deploy-all.js run report\n` +
      `Date: ${new Date().toLocaleString("en-US")}\n` +
      `${"=".repeat(60)}\n\n`;
    fs.writeFileSync(LOG_PATH, header + logLines.join("\n") + "\n", {
      encoding: "utf8",
    });
  } catch (e) {
    console.error("⚠️  Could not write deploy-report.txt:", e.message);
  }
}
// make sure the file gets written even if the script exits early (fatal / crash)
process.on("exit", flushLog);

// ── print helpers (print to screen and log to file) ────────────
function step(n, title) {
  const bar = `------------------------------------------------------------`;
  console.log(`\n${bar}`);
  console.log(`  [${n}] ${title}`);
  console.log(bar);
  logToFile(`\n${bar}\n  [${n}] ${title}\n${bar}`);
}
function ok(msg) {
  console.log(`✅ ${msg}`);
  logToFile(`[OK] ${msg}`);
}
function fail(msg) {
  console.error(`❌ ${msg}`);
  logToFile(`[FAIL] ${msg}`);
}
function fatal(msg) {
  fail(msg);
  console.error("\n🛑 Stopping — fix this issue before deploying anything.");
  logToFile("\n[FATAL] Stopping — fix this issue before deploying anything.");
  process.exit(1);
}
function run(cmd, cmdArgs, opts = {}) {
  console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  logToFile(`$ ${cmd} ${cmdArgs.join(" ")}`);
  // Only use a shell for external commands looked up via PATH (clasp, git —
  // on Windows these are .cmd shims that need a shell to resolve). Running
  // node itself (process.execPath) never needs a shell, and turning shell
  // on for it breaks quoting when the path contains spaces (e.g.
  // "C:\Program Files\nodejs\node.exe" gets split at the space).
  const needsShell = process.platform === "win32" && cmd !== process.execPath;
  // On Windows, when shell:true is used, spawnSync hands the argv array to
  // cmd.exe as a single joined command line WITHOUT adding quotes around
  // arguments — so any argument containing a space (like a commit message)
  // gets split into several separate arguments by the shell. Quote any
  // argument that contains whitespace so it survives as one piece.
  const safeArgs = needsShell
    ? cmdArgs.map((a) =>
        /\s/.test(a) && !(a.startsWith('"') && a.endsWith('"'))
          ? `"${a.replace(/"/g, '\\"')}"`
          : a,
      )
    : cmdArgs;
  const res = spawnSync(cmd, safeArgs, {
    stdio: "inherit",
    shell: needsShell,
    ...opts,
  });
  return res;
}

// ── [1] Syntax check for all gas-src files ──────────────────────
function checkSyntax() {
  step(1, "Syntax check for all .js/.gs files in gas-src");
  const files = fs
    .readdirSync(GAS_SRC)
    .filter((f) => f.endsWith(".js") || f.endsWith(".gs"));

  let hadError = false;
  for (const f of files) {
    const full = path.join(GAS_SRC, f);
    // node --check rejects .gs (unknown extension) — make a temp .js copy
    let target = full;
    let tmp = null;
    if (f.endsWith(".gs")) {
      tmp = path.join(require("os").tmpdir(), `syntax_check_${Date.now()}_${f}.js`);
      fs.copyFileSync(full, tmp);
      target = tmp;
    }
    const res = spawnSync(process.execPath, ["--check", target], {
      encoding: "utf8",
    });
    if (tmp) fs.unlinkSync(tmp);
    if (res.status !== 0) {
      fail(`Syntax error in ${f}:`);
      console.error(res.stderr);
      hadError = true;
    }
  }

  if (hadError) fatal("Some files have syntax errors — check them above.");
  ok(`All ${files.length} files are syntax-clean.`);
}

// ── [2] audit-allowlist ───────────────────────────────────────
function auditAllowlist() {
  step(2, "Checking allowlist (google.script.run vs DOPOST_ALLOWED_FUNCTIONS)");
  const scriptPath = path.join(__dirname, "audit-allowlist.js");
  if (!fs.existsSync(scriptPath)) {
    console.warn("⚠️  audit-allowlist.js not found — skipping this check.");
    return;
  }
  const res = spawnSync(process.execPath, [scriptPath, GAS_SRC], {
    encoding: "utf8",
  });
  console.log(res.stdout);
  logToFile(res.stdout || "");
  if (res.stderr) {
    console.error(res.stderr);
    logToFile(res.stderr);
  }

  // audit-allowlist.js reports its verdict via exit code, not via text
  // patterns in stdout (the words "not permitted" etc. always appear in
  // the report's section headers even when the count is 0, so scanning
  // the text for those words was a false-positive trap — it flagged
  // every run, clean or not). The script's own exit code is authoritative:
  //   0  → no real gaps
  //   2  → real gaps found (function used from frontend but not allowed)
  //   1  → the script itself failed to run (e.g. Code_12_Core.js not found)
  const hasRealGaps = res.status === 2;
  const scriptCrashed = res.status !== 0 && res.status !== 2;

  if (scriptCrashed) {
    fatal(`audit-allowlist.js failed to run (exit code ${res.status}) — check the output above.`);
  } else if (hasRealGaps) {
    console.warn(
      "⚠️  The report above lists real gaps — functions called from the frontend that are missing from the allowlist.",
    );
    if (!args.includes("--force")) {
      fatal(
        "Fix the allowlist (or re-run with --force if you're sure this is intentional/a false positive).",
      );
    }
  } else {
    ok("No missing allowlist functions.");
  }
}

// ── [3] build-static ──────────────────────────────────────────
function buildStatic() {
  step(3, "Building the static frontend (public/index.html + catalog.html)");
  const res = run(process.execPath, [path.join(__dirname, "build-static.js")]);
  if (res.status !== 0) fatal("build-static.js failed.");
  ok("Frontend built successfully.");
}

// ── [4] clasp push ────────────────────────────────────────────
function claspPush() {
  step(4, "Pushing backend code to Apps Script (clasp push)");
  const claspCheck = spawnSync("clasp", ["--version"], {
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  if (claspCheck.status !== 0) {
    fatal(
      "clasp is not installed or not logged in. Install with: npm i -g @google/clasp then clasp login",
    );
  }
  const res = run("clasp", ["push", "--force"], { cwd: GAS_SRC });
  if (res.status !== 0) fatal("clasp push failed — check the message above.");
  ok("Backend pushed to Apps Script.");
}

// ── [5] clasp deploy (same deployment, not a new version) ──────
function claspDeploy() {
  step(5, "Updating the active deployment (clasp deploy -i)");
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(`Config file not found: ${CONFIG_PATH}`);
    console.error(
      "Copy deploy-config.example.json to deploy-config.json and put your deploymentId in it.\n" +
        "Get it with: clasp deployments   (from inside the gas-src/ folder)",
    );
    fatal("Cannot update the deployment without the ID.");
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!config.deploymentId) {
    fatal("deploy-config.json exists but has no deploymentId.");
  }
  // clasp changed its flag names across versions:
  //   older clasp:  clasp deploy -i <id> -d <description>
  //   newer clasp:  clasp deploy --deploymentId <id> --description <description>
  // Try the new syntax first (current clasp releases), then fall back to
  // the old one if that specific error shows up — so this works either way
  // without needing to know which clasp version is installed.
  const description = COMMIT_MSG.slice(0, 100);
  let res = run(
    "clasp",
    ["deploy", "--deploymentId", config.deploymentId, "--description", description],
    { cwd: GAS_SRC },
  );
  if (res.status !== 0) {
    console.warn("⚠️  New clasp flag syntax failed — retrying with the older -i/-d syntax...");
    res = run(
      "clasp",
      ["deploy", "-i", config.deploymentId, "-d", description],
      { cwd: GAS_SRC },
    );
  }
  if (res.status !== 0) fatal("clasp deploy failed — check the message above.");
  ok(`Deployment (${config.deploymentId}) updated — the URL (GAS_URL) stays the same.`);
}

// ── [6] git add + commit + push ────────────────────────────────
function gitPush() {
  step(6, "Pushing the built frontend via Git (will trigger auto-deploy on Vercel)");
  const isGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (isGit.status !== 0) {
    console.warn(
      "⚠️  This is not a Git repo — skipping push. If you have Vercel CLI, you can use: vercel --prod",
    );
    return;
  }
  run("git", ["add", "-A"], { cwd: ROOT });
  const commit = run("git", ["commit", "-m", COMMIT_MSG], { cwd: ROOT });
  if (commit.status !== 0) {
    console.warn("⚠️  Nothing new to commit (or something went wrong) — skipping.");
    return;
  }
  const push = run("git", ["push"], { cwd: ROOT });
  if (push.status !== 0) fatal("git push failed — check the message above.");
  ok("Pushed to Git — Vercel will start building and deploying automatically within a minute or two.");
}

// ── main ─────────────────────────────────────────────────────
function main() {
  console.log("🚀 MOO.ERP — Deploy All\n");
  if (DRY_RUN) console.log("🔎 Dry-run mode: check + build only, no real deploy.\n");

  checkSyntax();
  auditAllowlist();
  buildStatic();

  if (!SKIP_GAS) {
    claspPush();
    claspDeploy();
  } else {
    console.log("\n⏭  Skipped backend deploy (--skip-gas or --dry-run).");
  }

  if (!SKIP_GIT) {
    gitPush();
  } else {
    console.log("⏭  Skipped frontend push via Git (--skip-git or --dry-run).");
  }

  console.log("\n🎉 All steps completed successfully.");
  logToFile("\n🎉 All steps completed successfully.");
  console.log(`📄 Full report written to: ${LOG_PATH}`);
}

main();
