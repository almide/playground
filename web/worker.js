// Compile + execute in a dedicated Worker so an infinite loop or a heavy
// compile never freezes the UI. The main thread talks to this file through
// runner.js; cancellation is worker.terminate() + respawn (no cooperative
// cancellation needed — the whole isolate is disposable).
//
// Protocol (all messages carry the request `id`):
//   → { id, op: 'version' }                          ← { id, done, ok, version }
//   → { id, op: 'check', files, entry }              ← { id, done, ok, diagnostics }
//   → { id, op: 'rust',  files, entry }              ← { id, done, ok, code }
//   → { id, op: 'ast',   source }                    ← { id, done, ok, ast }
//   → { id, op: 'run',   files, entry }              ← { id, event: 'compiled', ms }
//                                                    ← { id, event: 'stdout'|'stderr', line }  (streamed)
//                                                    ← { id, done, ok, exitCode, compileMs, runMs }
//                                                    ← { id, done, ok: false, phase, error }

import init, {
  compile_project_to_wasm,
  compile_project_to_rust,
  check_project,
  parse_to_ast,
  get_version_info,
} from './pkg/almide_playground.js';
import {
  WASI,
  File,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
} from 'https://esm.sh/@bjorn3/browser_wasi_shim@0.4.2';

const ready = init();

function post(msg) {
  self.postMessage(msg);
}

// Non-.almd tabs become an in-memory WASI directory, so `fs.read_text("data.csv")`
// works in the browser exactly like it does natively next to the source file.
function dataFileEntries(files) {
  const enc = new TextEncoder();
  const entries = new Map();
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('.almd')) continue;
    entries.set(name, new File(enc.encode(content)));
  }
  return entries;
}

async function runWasm(id, wasmBytes, files) {
  const fds = [
    new OpenFile(new File([])), // fd 0: stdin (empty)
    ConsoleStdout.lineBuffered((line) => post({ id, event: 'stdout', line })),
    ConsoleStdout.lineBuffered((line) => post({ id, event: 'stderr', line })),
    new PreopenDirectory('.', dataFileEntries(files)),
  ];
  const wasi = new WASI([], [], fds);
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  return wasi.start(instance); // returns the exit code (0 on clean exit)
}

self.onmessage = async (e) => {
  const msg = e.data;
  const { id, op } = msg;
  try {
    await ready;
  } catch (err) {
    post({ id, done: true, ok: false, phase: 'boot', error: 'Wasm load failed: ' + err });
    return;
  }

  try {
    switch (op) {
      case 'version': {
        post({ id, done: true, ok: true, version: get_version_info() });
        break;
      }
      case 'check': {
        const json = check_project(JSON.stringify(msg.files), msg.entry);
        post({ id, done: true, ok: true, diagnostics: JSON.parse(json) });
        break;
      }
      case 'rust': {
        try {
          const code = compile_project_to_rust(JSON.stringify(msg.files), msg.entry);
          post({ id, done: true, ok: true, code });
        } catch (err) {
          post({ id, done: true, ok: false, phase: 'compile', error: String(err) });
        }
        break;
      }
      case 'ast': {
        try {
          const ast = parse_to_ast(msg.source);
          post({ id, done: true, ok: true, ast });
        } catch (err) {
          post({ id, done: true, ok: false, phase: 'parse', error: String(err) });
        }
        break;
      }
      case 'run': {
        let wasmBytes;
        const t0 = performance.now();
        try {
          wasmBytes = compile_project_to_wasm(JSON.stringify(msg.files), msg.entry);
        } catch (err) {
          post({ id, done: true, ok: false, phase: 'compile', error: String(err) });
          break;
        }
        const compileMs = performance.now() - t0;
        post({ id, event: 'compiled', ms: compileMs });
        const t1 = performance.now();
        try {
          const exitCode = await runWasm(id, wasmBytes, msg.files);
          post({
            id,
            done: true,
            ok: true,
            exitCode: exitCode ?? 0,
            compileMs,
            runMs: performance.now() - t1,
          });
        } catch (err) {
          post({ id, done: true, ok: false, phase: 'runtime', error: String(err), compileMs });
        }
        break;
      }
      default:
        post({ id, done: true, ok: false, phase: 'protocol', error: 'unknown op: ' + op });
    }
  } catch (err) {
    post({ id, done: true, ok: false, phase: op, error: String(err) });
  }
};
