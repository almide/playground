#!/usr/bin/env node
// Almide Playground — Behavioral Test Runner
//
// Compiles .almd fixtures with the real compiler, then runs the output
// through the same browser-patching logic as the playground.
// This catches any drift between compiler runtime and playground execution.
//
// Usage:
//   node tests/run.mjs              # Run all fixtures
//   node tests/run.mjs --fixture X  # Run single fixture

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALMIDE_BIN =
  process.env.ALMIDE_BIN || join(homedir(), ".local/almide/almide");
const FIXTURES_DIR = resolve(__dirname, "fixtures");

// ── Browser patching (mirrors patchRuntimeForBrowser in index.html) ──

const BROWSER_OVERRIDES = {
  __almd_fs:
    '{ exists(p){throw new Error("fs: not available in browser")}, read_text(p){throw new Error("fs: not available in browser")}, read_bytes(p){throw new Error("fs: not available in browser")}, write(p,s){throw new Error("fs: not available in browser")}, write_bytes(p,b){throw new Error("fs: not available in browser")}, append(p,s){throw new Error("fs: not available in browser")}, mkdir_p(p){throw new Error("fs: not available in browser")}, exists_hdlm_qm_(p){throw new Error("fs: not available in browser")}, read_lines(p){throw new Error("fs: not available in browser")}, remove(p){throw new Error("fs: not available in browser")}, list_dir(p){throw new Error("fs: not available in browser")} }',
  __almd_env:
    '{ unix_timestamp(){return Math.floor(Date.now()/1000)}, args(){return["playground"]}, get(name){return null}, set(name,value){}, cwd(){return "/"}, millis(){return Date.now()}, sleep_ms(ms){} }',
  __almd_process:
    '{ exec(cmd,args){throw new Error("process: not available in browser")}, exit(code){throw new Error("process: not available in browser")}, stdin_lines(){throw new Error("process: not available in browser")} }',
  __almd_io:
    '{ read_line(){throw new Error("io: not available in browser")}, print(s){}, read_all(){throw new Error("io: not available in browser")} }',
  __almd_http:
    '{ async serve(){throw new Error("http: not available in browser")}, response(s,b){return{status:s,body:b,headers:{}}}, json(s,b){return{status:s,body:b,headers:{}}}, with_headers(s,b,h){return{status:s,body:b,headers:h}}, async get(u){throw new Error("http: not available in browser")}, async post(u,b){throw new Error("http: not available in browser")} }',
};

function patchRuntimeForBrowser(js) {
  let code = js;
  for (const [mod, stub] of Object.entries(BROWSER_OVERRIDES)) {
    const prefix = "const " + mod + " = ";
    const start = code.indexOf(prefix);
    if (start === -1) continue;
    const objStart = start + prefix.length;
    let depth = 0,
      i = objStart;
    while (i < code.length) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) break;
      } else if (code[i] === '"' || code[i] === "'") {
        const q = code[i];
        i++;
        while (i < code.length && code[i] !== q) {
          if (code[i] === "\\") i++;
          i++;
        }
      }
      i++;
    }
    code = code.substring(0, objStart) + stub + code.substring(i + 1);
  }
  code = code.replace(
    /function println\(s\)\s*\{[^}]*\}/,
    "function println(s) { __println__(s); }",
  );
  code = code.replace(
    /function eprintln\(s\)\s*\{[^}]*\}/,
    "function eprintln(s) { __println__(s); }",
  );
  const entryPoint = code.indexOf("// ---- Entry Point ----");
  if (entryPoint !== -1) code = code.substring(0, entryPoint);
  return code;
}

// ── Test runner ──────────────────────────────────────────────────────

function compileToJs(almdFile) {
  return execFileSync(ALMIDE_BIN, [almdFile, "--target", "js"], {
    encoding: "utf-8",
    timeout: 30000,
  });
}

function runWithBrowserPatching(compiledJs) {
  const lines = [];
  const fakePrintln = (s) => lines.push(String(s));
  const patched = patchRuntimeForBrowser(compiledJs);
  const wrappedCode =
    patched + '\nif (typeof main === "function") { main(["playground"]); }';
  const fn = new Function("__println__", wrappedCode);
  fn(fakePrintln);
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fixtureIdx = args.indexOf("--fixture");
const filterFixture = fixtureIdx >= 0 ? args[fixtureIdx + 1] : null;

console.log(
  "\n━━━ Playground Behavioral Tests: Compile → Patch → Run ━━━\n",
);

let files = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".almd"))
  .sort();

if (filterFixture) {
  files = files.filter((f) => f.includes(filterFixture));
}

if (files.length === 0) {
  console.log("  No fixtures found.");
  process.exit(0);
}

let passed = 0;
let failed = 0;
let skipped = 0;

for (const file of files) {
  const filePath = join(FIXTURES_DIR, file);
  const name = file.replace(".almd", "");
  const source = readFileSync(filePath, "utf-8");
  const knownIssue = source.match(/^\/\/\s*known-issue:\s*(.+)/m);

  try {
    const compiledJs = compileToJs(filePath);
    const output = runWithBrowserPatching(compiledJs);
    console.log(`  ✓  ${name}`);
    if (output) {
      for (const line of output.split("\n")) {
        console.log(`     ${line}`);
      }
    }
    passed++;
  } catch (e) {
    if (knownIssue) {
      console.log(`  ⊘  ${name} (known issue: ${knownIssue[1]})`);
      skipped++;
    } else {
      console.log(`  ✗  ${name}`);
      const msg = e.stderr ? e.stderr.toString() : e.message || String(e);
      for (const line of msg.split("\n").slice(0, 8)) {
        console.log(`     ${line}`);
      }
      failed++;
    }
  }
}

const parts = [`${passed} passed`];
if (skipped > 0) parts.push(`${skipped} skipped`);
if (failed > 0) parts.push(`${failed} failed`);
console.log(`\n  ${parts.join(", ")}\n`);

if (failed > 0) {
  console.log("✗ Some tests failed");
  process.exit(1);
} else {
  console.log("✓ All checks passed");
}
