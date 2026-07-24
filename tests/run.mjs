#!/usr/bin/env node
// Almide Playground — Behavioral Test Runner
//
// The playground compiles user code to WASM in the browser via the SAME v1
// trust-spine entry the CLI uses (`almide_mir::pipeline::try_render_wasm_source`,
// see crate/src/lib.rs) and executes it under a stock WASI preview1 shim.
// So the drift check is exactly the compiler's own cross-target promise:
// each fixture must produce byte-identical stdout on the native target and
// on `--target wasm` (compiled + executed through the CLI's wasmtime path).
//
// The old JS-runtime patching harness died with the TS backend (2026-03-28);
// there is nothing to patch anymore — WASI is WASI.
//
// Usage:
//   node tests/run.mjs              # Run all fixtures
//   node tests/run.mjs --fixture X  # Run single fixture (name without .almd)

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALMIDE_BIN =
  process.env.ALMIDE_BIN || join(homedir(), ".local/almide/almide");
const FIXTURES_DIR = resolve(__dirname, "fixtures");

// Fixtures that currently hit an honest v1 wall on the wasm target.
// This list is a RATCHET: an entry here must STILL wall (so the harness
// fails loudly when the compiler brick lands and the entry must be removed),
// and any fixture NOT listed here must pass on both targets.
//
// path_test: `import path` (bundled sibling module) is outside the
// MIR-lowering subset — the multi-module wasm linking gap.
const KNOWN_WASM_WALLS = new Set(["path_test.almd"]);

function run(args) {
  try {
    const stdout = execFileSync(ALMIDE_BIN, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { ok: true, stdout: stdout.trimEnd() };
  } catch (e) {
    return {
      ok: false,
      stdout: (e.stdout || "").toString().trimEnd(),
      stderr: (e.stderr || "").toString().trimEnd(),
    };
  }
}

const only = (() => {
  const i = process.argv.indexOf("--fixture");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const fixtures = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".almd"))
  .filter((f) => !only || f === `${only}.almd` || f === only)
  .sort();

if (fixtures.length === 0) {
  console.error("no fixtures matched");
  process.exit(1);
}

let failures = 0;

for (const f of fixtures) {
  const path = join(FIXTURES_DIR, f);
  const marker = `${f.replace(/_test\.almd$/, "")}: ok`;

  const native = run(["run", path]);
  if (!native.ok || !native.stdout.endsWith(marker)) {
    console.error(`✗ ${f} [native]`);
    console.error(native.stderr || native.stdout);
    failures++;
    continue;
  }

  const wasm = run(["run", path, "--target", "wasm"]);
  if (KNOWN_WASM_WALLS.has(f)) {
    if (wasm.ok) {
      console.error(
        `✗ ${f} [wasm] passed but is listed in KNOWN_WASM_WALLS — ` +
          `the compiler brick landed: remove it from the ratchet list`,
      );
      failures++;
    } else {
      console.log(`✓ ${f} (native ok; wasm wall — tracked)`);
    }
    continue;
  }

  if (!wasm.ok) {
    console.error(`✗ ${f} [wasm]`);
    console.error(wasm.stderr || wasm.stdout);
    failures++;
    continue;
  }
  if (wasm.stdout !== native.stdout) {
    console.error(`✗ ${f} [cross-target drift]`);
    console.error(`  native: ${JSON.stringify(native.stdout)}`);
    console.error(`  wasm:   ${JSON.stringify(wasm.stdout)}`);
    failures++;
    continue;
  }
  console.log(`✓ ${f} (native + wasm byte-identical)`);
}

console.log(
  `\n${fixtures.length - failures}/${fixtures.length} fixtures passed`,
);
process.exit(failures ? 1 : 0);
