/* tslint:disable */
/* eslint-disable */

/**
 * Type-check a tab set WITHOUT running codegen — fast enough for
 * check-on-idle in the editor. Never throws: the result is always a JSON
 * array of diagnostics (empty = clean), each attributed to its tab.
 */
export function check_project(files_json: string, entry: string): string;

/**
 * Emit Rust source for a tab set — mirrors the CLI's `cmd_emit` driver
 * (`src/cli/emit.rs`): canonicalize with siblings → refresh module top-lets
 * → infer entry → lower → per-module infer + import-table swap + lower_module
 * → monomorphize → ir_link → codegen.
 */
export function compile_project_to_rust(files_json: string, entry: string): string;

/**
 * Compile a tab set to a WASI module. The wasm path is the v1 trust-spine
 * renderer — the SAME entry as the native CLI's `--target wasm`
 * (`almide#782` retired the v0 wasm emitter). Sibling modules ride in via
 * `self_modules`, exactly like `compile_to_wasm_bytes` in the CLI.
 */
export function compile_project_to_wasm(files_json: string, entry: string): Uint8Array;

/**
 * Single-file compatibility wrapper.
 */
export function compile_to_rust(source: string): string;

/**
 * Single-file compatibility wrapper (crate tests, older callers).
 */
export function compile_to_wasm(source: string): Uint8Array;

export function get_version_info(): string;

export function parse_to_ast(source: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly check_project: (a: number, b: number, c: number, d: number) => [number, number];
    readonly compile_project_to_rust: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly compile_project_to_wasm: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly compile_to_rust: (a: number, b: number) => [number, number, number, number];
    readonly compile_to_wasm: (a: number, b: number) => [number, number, number, number];
    readonly get_version_info: () => [number, number];
    readonly parse_to_ast: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
