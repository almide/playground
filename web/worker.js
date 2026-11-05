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

const ready = init({
  module_or_path: new URL('./pkg/almide_playground_bg.wasm' + self.location.search, import.meta.url),
});

function post(msg) {
  self.postMessage(msg);
}

const STDIN_TAB = 'stdin.txt';

function dataFileEntries(files) {
  const enc = new TextEncoder();
  const entries = new Map();
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('.almd') || name === STDIN_TAB) continue;
    entries.set(name, new File(enc.encode(content)));
  }
  return entries;
}

async function runWasm(id, wasmBytes, files) {
  const stdinBytes = new TextEncoder().encode(files[STDIN_TAB] ?? '');
  const fds = [
    new OpenFile(new File(stdinBytes)),
    ConsoleStdout.lineBuffered((line) => post({ id, event: 'stdout', line })),
    ConsoleStdout.lineBuffered((line) => post({ id, event: 'stderr', line })),
    new PreopenDirectory('.', dataFileEntries(files)),
  ];
  const wasi = new WASI([], [], fds);
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  return wasi.start(instance);
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
