# Almide Playground

Online playground for the [Almide](https://github.com/almide/almide) programming language. Write `.almd` code and run it directly in your browser — no installation required.

**[Try it live →](https://almide.github.io/playground/)**

## How it Works

```
.almd source → Almide compiler (Wasm) → TypeScript → JS eval in browser
```

1. The Almide compiler (written in Rust) is compiled to WebAssembly
2. Your `.almd` code is compiled to TypeScript in the browser
3. Type annotations are stripped and the resulting JS is executed via `eval`

## Features

- **Instant compilation** — No server round-trips, everything runs locally
- **Live output** — See program output immediately
- **Compiled JS view** — Inspect the generated code
- **AST view** — See the parsed abstract syntax tree

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

## Deployment

Push to `main` triggers GitHub Actions which builds the Wasm and deploys to GitHub Pages.

## Limitations

- Only the TypeScript backend is available (no Rust codegen — can't run `rustc` in browser)
- File I/O (`fs.*`) is not available in the browser sandbox
- `env.unix_timestamp()` uses browser's `Date.now()`

## License

MIT
