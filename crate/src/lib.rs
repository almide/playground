use std::collections::{BTreeMap, HashSet};

use wasm_bindgen::prelude::*;

use almide::ast;
use almide::canonicalize;
use almide::check;
use almide::codegen::pass::Target;
use almide::codegen::{self, CodegenOutput};
use almide::diagnostic::{self, Diagnostic};
use almide::import_table;
use almide::ir_link;
use almide::lexer;
use almide::lower;
use almide::mono;
use almide::parser;

/// Tab set sent by the frontend: file name → source text. `.almd` tabs are
/// candidate modules for `import self.<name>`; anything else (data files the
/// runner preopens into the WASI FS) is ignored here.
type Files = BTreeMap<String, String>;
/// Same shape `almide_mir::pipeline::try_render_wasm_source` and
/// `canonicalize_program` take: (module name, parsed program, is_self).
type SelfModules = Vec<(String, ast::Program, bool)>;

fn parse_files_json(files_json: &str) -> Result<Files, String> {
    serde_json::from_str(files_json).map_err(|e| format!("invalid files payload: {e}"))
}

fn entry_source<'a>(files: &'a Files, entry: &str) -> Result<&'a String, String> {
    files
        .get(entry)
        .ok_or_else(|| format!("entry file '{entry}' not found"))
}

/// Parse one tab. The parser recovers (it can return `Ok` with a truncated
/// program while recording failures in `.errors`), so both channels are
/// checked — same gate as the CLI's `parse_file` and the v1 pipeline.
fn parse_strict(source: &str, label: &str) -> Result<ast::Program, String> {
    let tokens = lexer::Lexer::tokenize(source);
    let mut parser = parser::Parser::new(tokens);
    let program = parser
        .parse()
        .map_err(|e| format!("Parse error in {label}: {e}"))?;
    if !parser.errors.is_empty() {
        let msgs: Vec<String> = parser.errors.iter().map(|d| d.display()).collect();
        return Err(format!("Parse error in {label}:\n{}", msgs.join("\n\n")));
    }
    Ok(program)
}

/// In-memory `import self.<name>` resolution over the tab set — the browser
/// counterpart of `resolve.rs`'s `resolve_self_import` (which reads
/// `src/<name>.almd` off disk). Same naming rule (module name = last path
/// segment), same dependency order (leaves first), cycle-checked.
fn resolve_self_modules(files: &Files, entry_prog: &ast::Program) -> Result<SelfModules, String> {
    let mut out: SelfModules = Vec::new();
    let mut loaded: HashSet<String> = HashSet::new();
    let mut loading: HashSet<String> = HashSet::new();
    collect_self_imports(files, entry_prog, &mut out, &mut loaded, &mut loading)?;
    Ok(out)
}

fn collect_self_imports(
    files: &Files,
    prog: &ast::Program,
    out: &mut SelfModules,
    loaded: &mut HashSet<String>,
    loading: &mut HashSet<String>,
) -> Result<(), String> {
    for decl in &prog.imports {
        let ast::Decl::Import { path, .. } = decl else { continue };
        if path.first().map(|s| s.as_str()) != Some("self") {
            continue;
        }
        if path.len() < 2 {
            return Err(
                "'import self' (package entry point) is not supported in the playground — \
                 use 'import self.<module>' with a matching <module>.almd tab"
                    .to_string(),
            );
        }
        let mod_name = path.last().expect("guarded by len >= 2").as_str();
        if loaded.contains(mod_name) {
            continue;
        }
        if loading.contains(mod_name) {
            return Err(format!("circular import through module '{mod_name}'"));
        }
        let file_name = format!("{mod_name}.almd");
        let Some(src) = files.get(&file_name) else {
            return Err(format!(
                "cannot resolve 'import self.{mod_name}': no tab named '{file_name}'"
            ));
        };
        loading.insert(mod_name.to_string());
        let sub_prog = parse_strict(src, &file_name)?;
        collect_self_imports(files, &sub_prog, out, loaded, loading)?;
        loading.remove(mod_name);
        loaded.insert(mod_name.to_string());
        out.push((mod_name.to_string(), sub_prog, true));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// WASM target (Run)
// ---------------------------------------------------------------------------

/// The module list every compile entry needs: the bundled stdlib modules whose
/// definitions live in `.almd` source (the sized numeric types, `error`,
/// `datetime`, `value`, …) followed by the user's own tabs.
///
/// The CLI gets these from `resolve`, which loads `AUTO_IMPORT_BUNDLED` plus
/// whatever the program imports. Passing only the user tabs — as this crate did
/// before — leaves those modules undefined: `x.to_string()` on an `Int8`
/// reports "undefined method" in the playground while the very same program
/// compiles natively.
fn modules_for(source: &str, self_modules: SelfModules) -> SelfModules {
    let mut modules = almide_mir::pipeline::bundled_self_modules(source);
    modules.extend(self_modules);
    modules
}

/// Compile a tab set to a WASI module. The wasm path is the v1 trust-spine
/// renderer — the SAME entry as the native CLI's `--target wasm`
/// (`almide#782` retired the v0 wasm emitter). Sibling modules ride in via
/// `self_modules`, exactly like `compile_to_wasm_bytes` in the CLI.
#[wasm_bindgen]
pub fn compile_project_to_wasm(files_json: &str, entry: &str) -> Result<Vec<u8>, String> {
    let files = parse_files_json(files_json)?;
    let source = entry_source(&files, entry)?;
    let entry_prog = parse_strict(source, entry)?;
    let self_modules = resolve_self_modules(&files, &entry_prog)?;
    let modules = modules_for(source, self_modules);
    let wat_text = almide_mir::pipeline::try_render_wasm_source(source, &modules, false)
        .map_err(|e| format!("{e:?}"))?;
    wat::parse_str(&wat_text).map_err(|e| format!("wat: {e}"))
}

/// Single-file compatibility wrapper (crate tests, older callers).
#[wasm_bindgen]
pub fn compile_to_wasm(source: &str) -> Result<Vec<u8>, String> {
    let entry_prog = parse_strict(source, "main.almd")?;
    let _ = entry_prog; // parse gate only; the renderer re-parses internally
    let modules = modules_for(source, Vec::new());
    let wat_text = almide_mir::pipeline::try_render_wasm_source(source, &modules, false)
        .map_err(|e| format!("{e:?}"))?;
    wat::parse_str(&wat_text).map_err(|e| format!("wat: {e}"))
}

// ---------------------------------------------------------------------------
// Rust target (Compiled tab)
// ---------------------------------------------------------------------------

/// Emit Rust source for a tab set — mirrors the CLI's `cmd_emit` driver
/// (`src/cli/emit.rs`): canonicalize with siblings → refresh module top-lets
/// → infer entry → lower → per-module infer + import-table swap + lower_module
/// → monomorphize → ir_link → codegen.
#[wasm_bindgen]
pub fn compile_project_to_rust(files_json: &str, entry: &str) -> Result<String, String> {
    let files = parse_files_json(files_json)?;
    let source = entry_source(&files, entry)?;
    let mut program = parse_strict(source, entry)?;
    let self_modules = modules_for(source, resolve_self_modules(&files, &program)?);

    let canon = canonicalize::canonicalize_program(
        &program,
        self_modules.iter().map(|(n, p, s)| (n.as_str(), p, *s)),
    );
    let mut checker = check::Checker::from_env(canon.env);
    checker.set_source(entry, source);
    checker.diagnostics = canon.diagnostics;
    for (name, mod_prog, _) in &self_modules {
        if almide::stdlib_info::is_stdlib_module(name) && !almide::stdlib_info::is_bundled_module(name) {
            continue;
        }
        checker.refresh_module_top_lets(mod_prog, name);
    }
    let diagnostics = checker.infer_program(&mut program);
    let errors: Vec<String> = diagnostics
        .iter()
        .filter(|d| d.level == diagnostic::Level::Error)
        .map(|d| d.display())
        .collect();
    if !errors.is_empty() {
        return Err(errors.join("\n\n"));
    }

    let mut ir = lower::lower_program(&program, &checker.env, &checker.type_map);
    for (name, mod_prog, _) in &self_modules {
        if almide::stdlib_info::is_stdlib_module(name) && !almide::stdlib_info::is_bundled_module(name) {
            continue;
        }
        let mut mod_prog = mod_prog.clone();
        let before = checker.diagnostics.len();
        checker.infer_module(&mut mod_prog, name);
        let module_errors: Vec<String> = checker.diagnostics[before..]
            .iter()
            .filter(|d| d.level == diagnostic::Level::Error)
            .map(|d| d.display())
            .collect();
        if !module_errors.is_empty() {
            // A bundled stdlib module is CI-gated upstream; a diagnostic there
            // is a compiler bug, not something the user can act on.
            if !almide::stdlib_info::is_bundled_module(name) {
                return Err(format!("in {name}.almd:\n{}", module_errors.join("\n\n")));
            }
        }
        let self_name = checker.env.self_module_name.map(|s| s.to_string());
        let import_table_name = self_name.as_deref().unwrap_or(name.as_str());
        let (mod_table, _) = import_table::build_import_table(
            &mod_prog,
            Some(import_table_name),
            &checker.env.user_modules,
        );
        let saved_table = std::mem::replace(&mut checker.env.import_table, mod_table);
        let mod_ir = lower::lower_module(name, &mod_prog, &checker.env, &checker.type_map, None);
        checker.env.import_table = saved_table;
        ir.modules.push(mod_ir);
    }

    mono::monomorphize(&mut ir);
    ir_link::ir_link(&mut ir);
    match codegen::codegen(&mut ir, Target::Rust) {
        CodegenOutput::Source(code) => Ok(code),
        CodegenOutput::Binary(_) => Err("Unexpected binary output for Rust target".to_string()),
    }
}

/// Single-file compatibility wrapper.
#[wasm_bindgen]
pub fn compile_to_rust(source: &str) -> Result<String, String> {
    let files_json = serde_json::json!({ "main.almd": source }).to_string();
    compile_project_to_rust(&files_json, "main.almd")
}

// ---------------------------------------------------------------------------
// Check (editor diagnostics)
// ---------------------------------------------------------------------------

fn diag_to_json(d: &Diagnostic, default_file: &str) -> serde_json::Value {
    serde_json::json!({
        "file": d.file.clone().unwrap_or_else(|| default_file.to_string()),
        "line": d.line,
        "col": d.col,
        "endCol": d.end_col,
        "level": if d.level == diagnostic::Level::Error { "error" } else { "warning" },
        "code": d.code,
        "message": d.message,
        "hint": d.hint,
        "here": d.here_snippet,
        "trySnippet": d.try_snippet,
        "tryReplace": d.try_replace_span.map(|(l, c, ec)| serde_json::json!([l, c, ec])),
    })
}

/// One diagnostic with no source position — carries resolver/parse-level
/// failures into the same JSON channel the editor consumes.
fn plain_error_json(file: &str, message: String) -> serde_json::Value {
    serde_json::json!({
        "file": file,
        "line": null, "col": null, "endCol": null,
        "level": "error", "code": null,
        "message": message,
        "hint": "", "here": null, "trySnippet": null, "tryReplace": null,
    })
}

/// Type-check a tab set WITHOUT running codegen — fast enough for
/// check-on-idle in the editor. Never throws: the result is always a JSON
/// array of diagnostics (empty = clean), each attributed to its tab.
#[wasm_bindgen]
pub fn check_project(files_json: &str, entry: &str) -> String {
    let mut out: Vec<serde_json::Value> = Vec::new();
    check_project_inner(files_json, entry, &mut out);
    serde_json::Value::Array(out).to_string()
}

fn check_project_inner(files_json: &str, entry: &str, out: &mut Vec<serde_json::Value>) {
    let files = match parse_files_json(files_json) {
        Ok(f) => f,
        Err(e) => return out.push(plain_error_json(entry, e)),
    };
    let Some(source) = files.get(entry) else {
        return out.push(plain_error_json(entry, format!("entry file '{entry}' not found")));
    };

    // Parse every .almd tab first so a broken sibling reports against its own
    // tab (not as an opaque resolver failure on the entry).
    let mut parsed_ok = true;
    for (name, text) in &files {
        if !name.ends_with(".almd") {
            continue;
        }
        let tokens = lexer::Lexer::tokenize(text);
        let mut parser = parser::Parser::new(tokens);
        match parser.parse() {
            Ok(_) => {
                for d in &parser.errors {
                    parsed_ok = false;
                    out.push(diag_to_json(d, name));
                }
            }
            Err(e) => {
                parsed_ok = false;
                out.push(plain_error_json(name, format!("Parse error: {e}")));
            }
        }
    }
    if !parsed_ok {
        return;
    }

    let entry_prog = match parse_strict(source, entry) {
        Ok(p) => p,
        Err(e) => return out.push(plain_error_json(entry, e)),
    };
    let user_modules = match resolve_self_modules(&files, &entry_prog) {
        Ok(m) => m,
        Err(e) => return out.push(plain_error_json(entry, e)),
    };
    let self_modules = modules_for(source, user_modules);

    let mut program = entry_prog;
    let canon = canonicalize::canonicalize_program(
        &program,
        self_modules.iter().map(|(n, p, s)| (n.as_str(), p, *s)),
    );
    let mut checker = check::Checker::from_env(canon.env);
    checker.set_source(entry, source);
    checker.diagnostics = canon.diagnostics;
    for (name, mod_prog, _) in &self_modules {
        if almide::stdlib_info::is_stdlib_module(name) && !almide::stdlib_info::is_bundled_module(name) {
            continue;
        }
        checker.refresh_module_top_lets(mod_prog, name);
    }
    let diagnostics = checker.infer_program(&mut program);
    for d in &diagnostics {
        out.push(diag_to_json(d, entry));
    }

    // Only the user's own tabs get an attributed pass — same before/after slice
    // technique as the CLI's `infer_module_capturing`. Bundled stdlib modules
    // are CI-gated upstream and have no user file to blame.
    for (name, mod_prog, _) in &self_modules {
        let file_name = format!("{name}.almd");
        if !files.contains_key(&file_name) {
            continue;
        }
        let mut mod_prog = mod_prog.clone();
        let before = checker.diagnostics.len();
        if let Some(text) = files.get(&file_name) {
            checker.set_source(&file_name, text);
        }
        checker.infer_module(&mut mod_prog, name);
        for d in &checker.diagnostics[before..] {
            out.push(diag_to_json(d, &file_name));
        }
    }
}

// ---------------------------------------------------------------------------
// AST view / version
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn parse_to_ast(source: &str) -> Result<String, String> {
    let program = parse_strict(source, "source")?;
    serde_json::to_string_pretty(&program).map_err(|e| format!("JSON error: {}", e))
}

#[wasm_bindgen]
pub fn get_version_info() -> String {
    format!(
        "almide v{} ({}), playground ({})",
        env!("ALMIDE_VERSION"),
        env!("ALMIDE_COMMIT"),
        env!("PLAYGROUND_COMMIT"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files_json(files: &[(&str, &str)]) -> String {
        let map: BTreeMap<&str, &str> = files.iter().copied().collect();
        serde_json::to_string(&map).unwrap()
    }

    #[test]
    fn test_compile_to_wasm() {
        // v1's wasm subset requires an explicit `fn main`; bare top-level
        // statements were never valid Almide grammar (verified against the
        // native CLI), and `List[Int].join` needs an explicit to_string map.
        let source = r#"
fn main() -> Unit = {
  let xs = [3, 1, 4, 1, 5]
  let sorted = xs.sort()
  let joined = ["hello", "world"].join(" ")
  println(joined)
  println(sorted.map((x) => int.to_string(x * 2)).join(", "))
}
"#;
        let wasm = compile_to_wasm(source).unwrap();
        // WASM magic number: \0asm
        assert!(wasm.len() > 8, "WASM output should be non-trivial");
        assert_eq!(&wasm[0..4], b"\0asm", "should start with WASM magic");
    }

    #[test]
    fn test_compile_to_wasm_with_math() {
        let source = r##"
import math

fn wave(x: Float, y: Float) -> Float = {
  math.sin(math.sqrt(x * x + y * y) * 2.0) + math.sin(x * 2.5 + y) + math.cos(y * 3.0 - x * 0.5)
}

fn main() -> Unit = {
  for row in 0..<5 {
    var line = ""
    for col in 0..<20 {
      let v = wave(col.to_float() / 5.0, row.to_float() / 3.0)
      line = line + if v > 0.0 then "#" else "."
    }
    println(line)
  }
}
"##;
        let wasm = compile_to_wasm(source).unwrap();
        assert_eq!(&wasm[0..4], b"\0asm");
    }

    #[test]
    fn test_compile_to_rust() {
        let source = r#"
fn main() -> Unit = {
  let s = "hello world";
  let upper = s.to_upper();
  println(upper)
}
"#;
        let rust = compile_to_rust(source).unwrap();
        assert!(rust.contains("fn main"), "should contain main function");
    }

    #[test]
    fn test_multi_file_wasm() {
        // Verified against the native CLI: `almide run src/main.almd` and
        // `--target wasm` both print "Hello, Almide!" for this project shape.
        let json = files_json(&[
            (
                "main.almd",
                "import self.util\n\nfn main() -> Unit = {\n  println(util.greet(\"Almide\"))\n}\n",
            ),
            (
                "util.almd",
                "fn greet(name: String) -> String = \"Hello, ${name}!\"\n",
            ),
        ]);
        let wasm = compile_project_to_wasm(&json, "main.almd").unwrap();
        assert_eq!(&wasm[0..4], b"\0asm");
    }

    #[test]
    fn test_multi_file_rust() {
        let json = files_json(&[
            (
                "main.almd",
                "import self.util\n\nfn main() -> Unit = {\n  println(util.greet(\"Almide\"))\n}\n",
            ),
            (
                "util.almd",
                "fn greet(name: String) -> String = \"Hello, ${name}!\"\n",
            ),
        ]);
        let rust = compile_project_to_rust(&json, "main.almd").unwrap();
        assert!(rust.contains("fn main"), "should contain main function");
        assert!(rust.contains("greet"), "should contain the module fn");
    }

    #[test]
    fn test_missing_module_tab() {
        let json = files_json(&[(
            "main.almd",
            "import self.nope\n\nfn main() -> Unit = println(\"x\")\n",
        )]);
        let err = compile_project_to_wasm(&json, "main.almd").unwrap_err();
        assert!(err.contains("no tab named 'nope.almd'"), "got: {err}");
    }

    #[test]
    fn test_check_project_reports_type_error_with_line() {
        let json = files_json(&[(
            "main.almd",
            "fn main() -> Unit = {\n  let x: Int = \"oops\"\n  println(int.to_string(x))\n}\n",
        )]);
        let out = check_project(&json, "main.almd");
        let diags: Vec<serde_json::Value> = serde_json::from_str(&out).unwrap();
        assert!(!diags.is_empty(), "expected at least one diagnostic");
        let first = &diags[0];
        assert_eq!(first["level"], "error");
        assert_eq!(first["file"], "main.almd");
        assert!(first["line"].is_number(), "diagnostic should carry a line: {first}");
    }

    /// Bundled stdlib modules (the sized numeric types, `datetime`, `value`, …)
    /// are defined in `.almd` source and must be handed to the compiler, or the
    /// playground rejects programs that build fine natively. This locks the fix
    /// for that gap: `x.to_string()` on a sized value is a method that only
    /// exists in `stdlib/uint8.almd`.
    #[test]
    fn test_bundled_stdlib_modules_are_linked() {
        let source = "fn main() -> Unit = {\n  let b: UInt8 = 255\n  println(b.to_string())\n  println(datetime.to_iso(0))\n}\n";
        let json = files_json(&[("main.almd", source)]);

        let check = check_project(&json, "main.almd");
        let diags: Vec<serde_json::Value> = serde_json::from_str(&check).unwrap();
        let errors: Vec<_> = diags.iter().filter(|d| d["level"] == "error").collect();
        assert!(errors.is_empty(), "check rejected bundled stdlib use: {check}");

        let wasm = compile_project_to_wasm(&json, "main.almd")
            .unwrap_or_else(|e| panic!("wasm compile rejected bundled stdlib use: {e}"));
        assert_eq!(&wasm[0..4], b"\0asm");

        let rust = compile_project_to_rust(&json, "main.almd")
            .unwrap_or_else(|e| panic!("rust compile rejected bundled stdlib use: {e}"));
        assert!(rust.contains("fn main"));
    }

    #[test]
    fn test_check_project_clean() {
        let json = files_json(&[(
            "main.almd",
            "fn main() -> Unit = println(\"ok\")\n",
        )]);
        let out = check_project(&json, "main.almd");
        let diags: Vec<serde_json::Value> = serde_json::from_str(&out).unwrap();
        let errors: Vec<_> = diags.iter().filter(|d| d["level"] == "error").collect();
        assert!(errors.is_empty(), "clean program produced errors: {out}");
    }

    #[test]
    fn test_check_project_attributes_module_parse_error() {
        let json = files_json(&[
            (
                "main.almd",
                "import self.bad\n\nfn main() -> Unit = println(\"x\")\n",
            ),
            ("bad.almd", "fn broken( -> String = \"x\"\n"),
        ]);
        let out = check_project(&json, "main.almd");
        let diags: Vec<serde_json::Value> = serde_json::from_str(&out).unwrap();
        assert!(
            diags.iter().any(|d| d["file"] == "bad.almd"),
            "parse error should be attributed to bad.almd: {out}"
        );
    }
}
