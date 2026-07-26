# Almide Playground

Online playground for the [Almide](https://github.com/almide/almide) programming language. Write `.almd` code and run it directly in your browser — no installation required.

**[Try it live →](https://almide.github.io/playground/)**

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│                                                              │
│  Main thread                        Web Worker (worker.js)   │
│  ┌──────────────────────┐          ┌───────────────────────┐ │
│  │ CodeMirror 6 editor  │  files   │ Almide Compiler (WASM)│ │
│  │ file tabs (app.js)   │ ───────▶ │ crate/src/lib.rs      │ │
│  │                      │          │  ├─ check_project     │ │
│  │ ◀─ diagnostics ───── │          │  ├─ compile_project_  │ │
│  │    (check-on-idle)   │          │  │    to_wasm (v1     │ │
│  │                      │          │  │    trust-spine)    │ │
│  │ ◀─ stdout stream ─── │          │  └─ …_to_rust (v0)    │ │
│  │    (Output panel)    │          │        │              │ │
│  └──────────────────────┘          │        ▼              │ │
│                                    │ WebAssembly.instantiate│ │
│   Stop = worker.terminate()        │ + browser_wasi_shim    │ │
│   (an infinite loop never          │   (in-memory preopen   │ │
│    freezes the page)               │    dir = data tabs)    │ │
│                                    └───────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Why WASM?

The Almide compiler is written in Rust. `wasm-pack` compiles it to WebAssembly, which runs natively in the browser. No server needed — compilation happens entirely client-side. The wasm codegen path is the v1 trust-spine renderer (`almide_mir::pipeline::try_render_wasm_source`) — the **same entry** the native CLI's `--target wasm` uses, so playground output is byte-identical to native (enforced by `tests/run.mjs`).

### Multi-file projects

Tabs are files. A tab named `util.almd` is importable as `import self.util` — the same module system as a local project (`src/main.almd` + `src/util.almd`). Non-`.almd` tabs (e.g. `data.csv`) are mounted into an in-memory WASI directory, so `fs.read_text("data.csv")` works in the browser exactly like it does natively.

### Execution model

Compilation **and** execution live in a Web Worker: an infinite loop or heavy compile never freezes the UI, Stop is `worker.terminate()` + respawn, and stdout/stderr stream line-by-line into the Output panel while the program runs. While you type, the worker runs `check_project` on idle and the editor shows compiler diagnostics inline (line/col precise, with the compiler's `hint:` attached; `try:` fixes surface as one-click actions).

### Key files

```
crate/
├── Cargo.toml        # Depends on almide + almide-mir (git, main branch)
├── build.rs          # Extracts version/commit from Cargo.lock
└── src/lib.rs        # wasm-bindgen exports:
                      #   compile_project_to_wasm(files, entry) → WASM binary
                      #   compile_project_to_rust(files, entry) → Rust source
                      #   check_project(files, entry)           → JSON diagnostics
                      #   parse_to_ast(source)                  → JSON AST
                      #   (+ single-file compile_to_* wrappers)

web/
├── index.html        # Markup, styles, CodeMirror importmap (esm.sh, build-less)
├── app.js            # Controller: tabs, run, share, gallery, persistence
├── editor.js         # CodeMirror 6 setup + Almide StreamLanguage + diagnostics
├── worker.js         # Compile + WASI execution in a Worker (stdout streaming)
├── runner.js         # Main-thread RPC wrapper (timeout, cancel = respawn)
├── share.js          # URL-hash sharing (deflate-raw + base64url, no server)
├── ai.js             # BYOK AI generation + auto-repair loop (3 providers)
├── examples/         # Gallery: manifest.json + one directory per example
└── pkg/              # wasm-pack output (auto-generated)
```

## Sharing

Share encodes **all tabs** into the URL hash (`#code=…`, CompressionStream
deflate + base64url) — no server, no expiry. Examples deep-link as
`?example=<id>` (e.g. [`?example=csv-report`](https://almide.github.io/playground/?example=csv-report)).

## Example gallery

`web/examples/` holds TS-Playground-style samples: the explanation lives in
code comments, each sample ends with a "try breaking this" nudge and a link to
the next one. Every sample is CI-verified byte-identical between native and
wasm (`node tests/run.mjs`) — a sample that walls or drifts fails the harness.

## Auto-deploy

The playground auto-deploys when the Almide compiler is updated:

```
almide/almide: push to main
    → CI: trigger-playground job
    → dispatches "compiler-updated" event to almide/playground
    → playground CI: cargo update almide → wasm-pack build → deploy to GitHub Pages
```

This means every release of the compiler automatically updates the playground.

## Features

- **Instant compilation** — No server round-trips, everything runs locally
- **Worker isolation** — Stop button kills runaway programs; the UI never freezes
- **Inline diagnostics** — compiler errors as you type, with hints and one-click fixes
- **Multi-file tabs** — `import self.<tab>` modules + data-file tabs for `fs.read_text`
- **Share URLs** — the whole tab set in the URL hash, serverless
- **Example gallery** — commented, categorized, CI-tested samples with deep links
- **Compiled view** — Inspect the generated Rust code
- **AST view** — See the parsed abstract syntax tree
- **AI code generation** — Generate + auto-repair Almide code via Claude/OpenAI/Gemini (client-side, BYOK)

## Development

```bash
# Prerequisites: Rust, wasm-pack
# Install wasm-pack: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# Build Wasm
cd crate && wasm-pack build --target web --out-dir ../web/pkg

# Serve locally
cd web && python3 -m http.server 8765
# Open http://localhost:8765

# Cross-target harness (fixtures + example gallery, native vs wasm byte-parity)
node tests/run.mjs
```

## Limitations

- `fs.*` can only read the data-file tabs mounted into the in-memory WASI dir (writes don't persist)
- `env.args()` and `process.exec()` are not available
- Network access (`http.*`) is not available from within WASM

## License

MIT
