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
