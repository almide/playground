use wasm_bindgen::prelude::*;

use almide::lexer;
use almide::parser;
use almide::codegen::{self, CodegenOutput};
use almide::codegen::pass::Target;
use almide::canonicalize;
use almide::check;
use almide::lower;
use almide::mono;
use almide::diagnostic;

fn parse_source(source: &str) -> Result<almide::ast::Program, String> {
    let tokens = lexer::Lexer::tokenize(source);
    let mut parser = parser::Parser::new(tokens);
    let program = parser.parse().map_err(|e| format!("Parse error: {}", e))?;
    Ok(program)
}

fn check_and_lower(program: &mut almide::ast::Program, source: &str) -> Result<almide::ir::IrProgram, String> {
    let canon = canonicalize::canonicalize_program(program, std::iter::empty());
    let mut checker = check::Checker::from_env(canon.env);
    checker.diagnostics = canon.diagnostics;
    let diagnostics = checker.infer_program(program);
    let errors: Vec<_> = diagnostics.iter()
        .filter(|d| d.level == diagnostic::Level::Error)
        .collect();
    if !errors.is_empty() {
        let msgs: Vec<String> = errors.iter()
            .map(|d: &&diagnostic::Diagnostic| d.display())
            .collect();
        return Err(msgs.join("\n\n"));
    }
    let ir = lower::lower_program(program, &checker.env, &checker.type_map);
    Ok(ir)
}

#[wasm_bindgen]
pub fn compile_to_wasm(source: &str) -> Result<Vec<u8>, String> {
    // v0's Target::Wasm emitter was retired (almide#782) and now hits
    // `unreachable!()`. The only live wasm codegen path is the v1
    // trust-spine renderer in almide-mir, which does its own parse/check/
    // lower internally — same entry as almide's native `--target wasm` CLI
    // and its browser-ABI determinism harness (tools/wasmgen-harness-uu).
    let wat_text = almide_mir::pipeline::try_render_wasm_source(source, &[], false)
        .map_err(|e| format!("{e:?}"))?;
    wat::parse_str(&wat_text).map_err(|e| format!("wat: {e}"))
}

#[wasm_bindgen]
pub fn compile_to_rust(source: &str) -> Result<String, String> {
    let mut program = parse_source(source)?;
    let mut ir = check_and_lower(&mut program, source)?;
    mono::monomorphize(&mut ir);
    match codegen::codegen(&mut ir, Target::Rust) {
        CodegenOutput::Source(code) => Ok(code),
        CodegenOutput::Binary(_) => Err("Unexpected binary output for Rust target".to_string()),
    }
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

#[wasm_bindgen]
pub fn parse_to_ast(source: &str) -> Result<String, String> {
    let program = parse_source(source)?;
    serde_json::to_string_pretty(&program)
        .map_err(|e| format!("JSON error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

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
  for row in 0..5 {
    var line = ""
    for col in 0..20 {
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

}
