use wasm_bindgen::prelude::*;

use almide::lexer;
use almide::parser;
use almide::codegen::{self, CodegenOutput};
use almide::codegen::pass::Target;
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
    let mut checker = check::Checker::new();
    let diagnostics = checker.check_program(program);
    let errors: Vec<_> = diagnostics.iter()
        .filter(|d| d.level == diagnostic::Level::Error)
        .collect();
    if !errors.is_empty() {
        let msgs: Vec<String> = errors.iter()
            .map(|d| d.display_with_source(source))
            .collect();
        return Err(msgs.join("\n\n"));
    }
    let ir = lower::lower_program(program, &checker.expr_types, &checker.env);
    Ok(ir)
}

fn compile_to_target(source: &str, target: Target) -> Result<String, String> {
    let mut program = parse_source(source)?;
    let mut ir = check_and_lower(&mut program, source)?;
    mono::monomorphize(&mut ir);
    match codegen::codegen(&mut ir, target) {
        CodegenOutput::Source(code) => Ok(code),
        CodegenOutput::Binary(_) => Err("Unexpected binary output for text target".to_string()),
    }
}

#[wasm_bindgen]
pub fn compile_to_ts(source: &str) -> Result<String, String> {
    compile_to_target(source, Target::TypeScript)
}

#[wasm_bindgen]
pub fn compile_to_js(source: &str) -> Result<String, String> {
    compile_to_target(source, Target::TypeScript)
}

#[wasm_bindgen]
pub fn compile_to_wasm(source: &str) -> Result<Vec<u8>, String> {
    let mut program = parse_source(source)?;
    let mut ir = check_and_lower(&mut program, source)?;
    mono::monomorphize(&mut ir);
    match codegen::codegen(&mut ir, Target::Wasm) {
        CodegenOutput::Binary(bytes) => Ok(bytes),
        CodegenOutput::Source(_) => Err("Unexpected source output for WASM target".to_string()),
    }
}

#[wasm_bindgen]
pub fn compile_to_rust(source: &str) -> Result<String, String> {
    compile_to_target(source, Target::Rust)
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
        let source = r#"
let xs = [3, 1, 4, 1, 5]
let sorted = xs.sort()
let joined = ["hello", "world"].join(" ")
println(joined)
println(sorted.map(fn(x) => x * 2).join(", "))
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
let s = "hello world"
let upper = s.to_upper()
println(upper)
"#;
        let rust = compile_to_rust(source).unwrap();
        assert!(rust.contains("fn main"), "should contain main function");
    }

    // Keep TS compile tests for backward compatibility
    #[test]
    fn test_compile_to_ts_still_works() {
        let source = "println(\"hello\")";
        let ts = compile_to_ts(source).unwrap();
        assert!(!ts.is_empty(), "TS output should be non-empty");
    }
}
