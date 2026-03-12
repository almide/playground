use wasm_bindgen::prelude::*;

use almide::lexer;
use almide::parser;
use almide::emit_ts;
use almide::check;
use almide::diagnostic;

fn parse_source(source: &str) -> Result<almide::ast::Program, String> {
    let tokens = lexer::Lexer::tokenize(source);
    let mut parser = parser::Parser::new(tokens);
    let program = parser.parse().map_err(|e| format!("Parse error: {}", e))?;
    Ok(program)
}

fn check_program(program: &mut almide::ast::Program, source: &str) -> Result<(), String> {
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
    Ok(())
}

#[wasm_bindgen]
pub fn compile_to_ts(source: &str) -> Result<String, String> {
    let mut program = parse_source(source)?;
    check_program(&mut program, source)?;
    Ok(emit_ts::emit_with_modules(&program, &[], None))
}

#[wasm_bindgen]
pub fn compile_to_js(source: &str) -> Result<String, String> {
    let mut program = parse_source(source)?;
    check_program(&mut program, source)?;
    Ok(emit_ts::emit_js_with_modules(&program, &[], None))
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
