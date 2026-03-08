use wasm_bindgen::prelude::*;

use almide::lexer;
use almide::parser;
use almide::emit_ts;

fn parse_source(source: &str) -> Result<almide::ast::Program, String> {
    let tokens = lexer::Lexer::tokenize(source);
    let mut parser = parser::Parser::new(tokens);
    let program = parser.parse().map_err(|e| format!("Parse error: {}", e))?;
    if !parser.errors.is_empty() {
        return Err(format!("Parse error: {}", parser.errors.join("\n")));
    }
    Ok(program)
}

#[wasm_bindgen]
pub fn compile_to_ts(source: &str) -> Result<String, String> {
    let program = parse_source(source)?;
    Ok(emit_ts::emit_with_modules(&program, &[]))
}

#[wasm_bindgen]
pub fn compile_to_js(source: &str) -> Result<String, String> {
    let program = parse_source(source)?;
    Ok(emit_ts::emit_js_with_modules(&program, &[]))
}

#[wasm_bindgen]
pub fn parse_to_ast(source: &str) -> Result<String, String> {
    let program = parse_source(source)?;
    serde_json::to_string_pretty(&program)
        .map_err(|e| format!("JSON error: {}", e))
}
