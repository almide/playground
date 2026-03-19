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
│  │     JavaScript)             │                        │
│  └──────────┬───────────────────┘                       │
│             │                                           │
│             ▼                                           │
│  Plain JavaScript (no type annotations)                 │
│             │                                           │
│             ▼                                           │
│  new Function(code)  ← browser eval                     │
│             │                                           │
│             ▼                                           │
│  Output panel (captured println)                        │
└─────────────────────────────────────────────────────────┘
```

### Why WASM?

The Almide compiler is written in Rust. `wasm-pack` compiles it to WebAssembly, which runs natively in the browser. No server needed — compilation happens entirely client-side.

### Why Target::JavaScript (not TypeScript)?

The compiled code is executed via `new Function()` in the browser. The browser's JS engine cannot parse TypeScript type annotations (`: string`, `: number`, etc.), so the playground uses `Target::JavaScript` which emits the same semantics as `Target::TypeScript` but without any type annotations.

### Compilation pipeline in the browser

1. **Parse**: `.almd` source → AST (lexer + recursive descent parser)
2. **Check**: Type checking (Hindley-Milner with unification)
3. **Lower**: AST → typed IR (intermediate representation)
4. **Mono**: Monomorphize row-polymorphic functions
5. **Codegen**: IR → Nanopass pipeline → Template renderer → JavaScript source
6. **Runtime**: JS runtime (`runtime/js/*.js`) is prepended to the output
7. **Execute**: `new Function('__println__', code)` with captured output

### Key files

```
crate/
├── Cargo.toml        # Depends on almide (git, main branch)
├── build.rs          # Extracts version/commit from Cargo.lock
└── src/lib.rs        # wasm-bindgen exports:
                      #   compile_to_ts(source) → TypeScript
                      #   compile_to_js(source) → JavaScript
                      #   parse_to_ast(source)  → JSON AST
                      #   get_version_info()    → version string

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
- **Live output** — See program output immediately
- **Compiled JS view** — Inspect the generated code
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

- Only the JavaScript backend is available (no Rust codegen — can't run `rustc` in browser)
- File I/O (`fs.*`) is not available in the browser sandbox
- `env.args()` and `process.exec()` are stubbed out
- `Deno.test` is replaced with inline IIFE for test blocks

## License

MIT
