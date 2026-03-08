mod ast;
mod emit_ts;
mod lexer;
mod parser;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn compile_to_ts(source: &str) -> Result<String, String> {
    let tokens = lexer::Lexer::tokenize(source);
    let mut parser = parser::Parser::new(tokens);
    let program = parser.parse().map_err(|e| format!("Parse error: {}", e))?;
    Ok(emit_ts::emit(&program))
}

#[wasm_bindgen]
pub fn compile_to_js(source: &str) -> Result<String, String> {
    let tokens = lexer::Lexer::tokenize(source);
    let mut parser = parser::Parser::new(tokens);
    let program = parser.parse().map_err(|e| format!("Parse error: {}", e))?;
    Ok(emit_ts::emit_js(&program))
}

#[wasm_bindgen]
pub fn parse_to_ast(source: &str) -> Result<String, String> {
    let tokens = lexer::Lexer::tokenize(source);
    let mut parser = parser::Parser::new(tokens);
    let program = parser.parse().map_err(|e| format!("Parse error: {}", e))?;
    serde_json::to_string_pretty(&program)
        .map_err(|e| format!("JSON error: {}", e))
}
