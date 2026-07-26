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
// (Empty since C-160: pure-Almide bundled modules — path, args — link on wasm.)
const KNOWN_WASM_WALLS = new Set([]);

function run(args, cwd) {
  try {
    const stdout = execFileSync(ALMIDE_BIN, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      cwd,
      // The wasm leg derives the guest cwd from $PWD, not getcwd() — with a
      // stale PWD (execFileSync keeps the parent's), relative fs reads fail
      // with ENOENT on wasm only. Keep both in sync.
      env: cwd ? { ...process.env, PWD: cwd } : process.env,
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

// `--fixture` may name an example id instead of a fixture — the empty-match
// error is deferred until the example section below has had its chance.
if (fixtures.length === 0 && !only) {
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

// --- Example gallery (web/examples) ---
//
// Gallery samples are the storefront: every one must run and stay
// byte-identical across targets. There is NO wall ratchet here — a walled
// example is a broken example and fails the harness.
//
// Each example is materialized the way a local user would run it:
// almide.toml + src/<*.almd> (so `import self.<tab>` resolves) with data
// files at the project root (the runtime cwd, where fs.read_text looks).

import { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

const EXAMPLES_DIR = resolve(__dirname, "../web/examples");
const manifest = JSON.parse(
  readFileSync(join(EXAMPLES_DIR, "manifest.json"), "utf8"),
);
const examples = manifest.categories
  .flatMap((c) => c.examples)
  .filter((ex) => !only || only === ex.id);

let exampleFailures = 0;
// realpath: macOS tmpdir is a symlink (/var/folders → /private/var), and the
// wasm leg's preopen/cwd mapping resolves real paths — a symlinked cwd makes
// relative fs.read_text fail with ENOENT on wasm only.
const scratchRoot = join(
  realpathSync(tmpdir()),
  `almide-playground-examples-${process.pid}`,
);

for (const ex of examples) {
  const root = join(scratchRoot, ex.id);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "almide.toml"),
    `[package]\nname = "${ex.id.replace(/-/g, "_")}"\nversion = "0.1.0"\n`,
  );
  for (const name of ex.files) {
    const content = readFileSync(join(EXAMPLES_DIR, ex.id, name), "utf8");
    const dest = name.endsWith(".almd") ? join(root, "src", name) : join(root, name);
    writeFileSync(dest, content);
  }

  const native = run(["run", "src/main.almd"], root);
  if (!native.ok) {
    console.error(`✗ example ${ex.id} [native]`);
    console.error(native.stderr || native.stdout);
    exampleFailures++;
    continue;
  }
  const wasm = run(["run", "src/main.almd", "--target", "wasm"], root);
  if (!wasm.ok) {
    console.error(`✗ example ${ex.id} [wasm]`);
    console.error(wasm.stderr || wasm.stdout);
    exampleFailures++;
    continue;
  }
  if (wasm.stdout !== native.stdout) {
    console.error(`✗ example ${ex.id} [cross-target drift]`);
    console.error(`  native: ${JSON.stringify(native.stdout)}`);
    console.error(`  wasm:   ${JSON.stringify(wasm.stdout)}`);
    exampleFailures++;
    continue;
  }
  console.log(`✓ example ${ex.id} (native + wasm byte-identical)`);
}

rmSync(scratchRoot, { recursive: true, force: true });
console.log(
  `${examples.length - exampleFailures}/${examples.length} examples passed`,
);

if (only && fixtures.length === 0 && examples.length === 0) {
  console.error(`nothing matched '${only}'`);
  process.exit(1);
}
process.exit(failures || exampleFailures ? 1 : 0);
