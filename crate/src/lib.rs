use wasm_bindgen::prelude::*;

use almide::lexer;
use almide::parser;
use almide::codegen;
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

#[wasm_bindgen]
pub fn compile_to_ts(source: &str) -> Result<String, String> {
    let mut program = parse_source(source)?;
    let mut ir = check_and_lower(&mut program, source)?;
    mono::monomorphize(&mut ir);
    Ok(codegen::emit(&mut ir, Target::TypeScript))
}

#[wasm_bindgen]
pub fn compile_to_js(source: &str) -> Result<String, String> {
    let mut program = parse_source(source)?;
    let mut ir = check_and_lower(&mut program, source)?;
    mono::monomorphize(&mut ir);
    Ok(codegen::emit(&mut ir, Target::JavaScript))
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
    fn test_stdlib_compiles() {
        let source = r#"
let xs = [3, 1, 4, 1, 5]
let sorted = xs.sort()
let joined = ["hello", "world"].join(" ")
println(joined)
println(sorted.map(fn(x) => x * 2).join(", "))
"#;
        let js = compile_to_js(source).unwrap();
        assert!(js.contains("__almd_list"), "should contain list runtime: {}", &js[..200.min(js.len())]);
    }

    #[test]
    fn test_import_stdlib() {
        let source = r#"
import math

let pi = math.pi()
let abs = math.abs(-42)
println(pi)
println(abs)
"#;
        let js = compile_to_js(source).unwrap();
        assert!(js.contains("__almd_math"), "should contain math runtime");
    }

    #[test]
    fn test_wave_ascii_art() {
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
        let js = compile_to_js(source).unwrap();
        assert!(js.contains("Math.sin"), "should use Math.sin");
        assert!(js.contains("Math.sqrt"), "should use Math.sqrt");
    }

    #[test]
    fn test_string_stdlib() {
        let source = r#"
let s = "hello world"
let upper = s.to_upper()
let parts = s.split(" ")
println(upper)
"#;
        let js = compile_to_js(source).unwrap();
        assert!(js.contains("__almd_string"), "should contain string runtime");
    }
}
