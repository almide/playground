# Almide Playground

Online playground for the [Almide](https://github.com/almide/almide) programming language. Write `.almd` code and run it directly in your browser — no installation required.

**[Try it live →](https://almide.github.io/playground/)**

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│                                                         │
│  .almd source                                           │
│      │                                                  │
│      ▼                                                  │
│  ┌──────────────────────────────┐                       │
│  │  Almide Compiler (WASM)     │                        │
│  │                             │                        │
│  │  crate/src/lib.rs           │                        │
│  │  ├─ parse (lexer → parser)  │                        │
│  │  ├─ check (type checker)    │                        │
│  │  ├─ lower (AST → IR)       │                        │
│  │  ├─ mono (monomorphize)    │                        │
│  │  └─ codegen::emit(Target::  │                        │
│  │     Wasm)                   │                        │
│  └──────────┬───────────────────┘                       │
│             │                                           │
│             ▼                                           │
│  WASM binary (user program)                             │
│             │                                           │
│             ▼                                           │
│  WebAssembly.instantiate()                              │
│  + browser_wasi_shim (WASI runtime)                     │
│             │                                           │
│             ▼                                           │
│  Output panel (captured stdout/stderr)                  │
└─────────────────────────────────────────────────────────┘
```

### Why WASM?

The Almide compiler is written in Rust. `wasm-pack` compiles it to WebAssembly, which runs natively in the browser. No server needed — compilation happens entirely client-side.

### Execution model

The compiler targets `Target::Wasm`, producing a WASM binary from user code. This binary is instantiated via `WebAssembly.instantiate()` with [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) providing the `wasi_snapshot_preview1` imports. stdout/stderr output is captured via `ConsoleStdout.lineBuffered` and displayed in the output panel.

WASI gives user programs access to:
- **stdout/stderr** — `println`, `eprintln`
- **Clock** — `datetime.now()` returns the real wall clock time
- **Random** — `crypto.getRandomValues()` backed randomness

### Compilation pipeline in the browser

1. **Parse**: `.almd` source → AST (lexer + recursive descent parser)
2. **Check**: Type checking (Hindley-Milner with unification)
3. **Lower**: AST → typed IR (intermediate representation)
4. **Mono**: Monomorphize row-polymorphic functions
5. **Codegen**: IR → Nanopass pipeline → WASM binary
6. **Execute**: `WebAssembly.instantiate()` + WASI → `_start()`

### Key files

```
crate/
├── Cargo.toml        # Depends on almide (git, main branch)
├── build.rs          # Extracts version/commit from Cargo.lock
└── src/lib.rs        # wasm-bindgen exports:
                      #   compile_to_wasm(source) → WASM binary
                      #   compile_to_ts(source)   → TypeScript
                      #   compile_to_rust(source)  → Rust
                      #   parse_to_ast(source)     → JSON AST
                      #   get_version_info()       → version string

web/
├── index.html        # Single-file app (editor, output, compiled view)
└── pkg/              # wasm-pack output (auto-generated)
    ├── almide_playground.js      # JS glue
    └── almide_playground_bg.wasm # Compiled compiler
```

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
- **Native WASM execution** — User programs compile to WASM and run via browser_wasi_shim
- **Live output** — See program output immediately
- **Compiled view** — Inspect the generated Rust / TypeScript code
- **AST view** — See the parsed abstract syntax tree
- **AI code generation** — Generate Almide code via Claude/OpenAI/Gemini API (client-side, BYOK)

## Development

```bash
# Prerequisites: Rust, wasm-pack
# Install wasm-pack: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# Build Wasm
cd crate && wasm-pack build --target web --out-dir ../web/pkg

# Serve locally
cd web && python3 -m http.server 8765
# Open http://localhost:8765
```

## Limitations

- File I/O (`fs.*`) is not available in the browser sandbox (WASI stubs return errors)
- `env.args()` and `process.exec()` are not available
- Network access (`http.*`) is not available from within WASM

## License

MIT
