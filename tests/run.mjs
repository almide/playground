#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALMIDE_BIN =
  process.env.ALMIDE_BIN || join(homedir(), ".local/almide/almide");
const FIXTURES_DIR = resolve(__dirname, "fixtures");

const KNOWN_WASM_WALLS = new Set([]);

function run(args, cwd, extraEnv = {}) {
  try {
    const stdout = execFileSync(ALMIDE_BIN, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      cwd,
      env: { ...process.env, ...(cwd ? { PWD: cwd } : {}), ...extraEnv },
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

  const isRandom = ex.files.some(
    (name) =>
      name.endsWith(".almd") &&
      /^\s*import\s+random\b/m.test(
        readFileSync(join(EXAMPLES_DIR, ex.id, name), "utf8"),
      ),
  );
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
  if (!isRandom && wasm.stdout !== native.stdout) {
    console.error(`✗ example ${ex.id} [cross-target drift]`);
    console.error(`  native: ${JSON.stringify(native.stdout)}`);
    console.error(`  wasm:   ${JSON.stringify(wasm.stdout)}`);
    exampleFailures++;
    continue;
  }
  const incumbent = run(["run", "src/main.almd", "--target", "wasm"], root, {
    ALMIDE_WASM_INCUMBENT: "1",
  });
  if (!incumbent.ok) {
    console.error(`✗ example ${ex.id} [incumbent wasm — the playground's leg]`);
    console.error(incumbent.stderr || incumbent.stdout);
    exampleFailures++;
    continue;
  }
  if (!isRandom && incumbent.stdout !== native.stdout) {
    console.error(`✗ example ${ex.id} [incumbent drift]`);
    console.error(`  native:    ${JSON.stringify(native.stdout)}`);
    console.error(`  incumbent: ${JSON.stringify(incumbent.stdout)}`);
    exampleFailures++;
    continue;
  }
  console.log(
    isRandom
      ? `✓ example ${ex.id} (native + wasm + incumbent run; random output not compared)`
      : `✓ example ${ex.id} (native + wasm + incumbent byte-identical)`,
  );
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
