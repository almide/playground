// BYOK AI generation + auto-repair loop (Anthropic / OpenAI / Gemini, SSE
// streaming straight into the editor). Ported unchanged in behavior from the
// pre-revamp playground; the only structural change is that compilation now
// happens through the Worker runner (ctx.compileAndRun) and the editor is
// CodeMirror (ctx.setActiveCode / ctx.appendActiveCode).
//
// The AI operates on the ACTIVE tab: generated / repaired code replaces the
// active tab's content, and every compile uses the full tab set.

export const MODELS = {
  anthropic: [
    // `extra` is merged into the request body: effort keeps Opus/Sonnet 5's
    // adaptive thinking shallow so the first token lands fast. Haiku 4.5 has
    // no effort knob and rejects the field, so it carries no extra.
    { value: 'claude-opus-5', label: 'Claude Opus 5', extra: { output_config: { effort: 'low' } } },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', extra: { output_config: { effort: 'low' } } },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
  ],
  gemini: [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  ],
};

const ALMIDE_SYSTEM = `You are an Almide (.almd) code generator. Output ONLY valid .almd source code. Do NOT wrap in markdown code fences. No explanations.

## Syntax

Types:      Int String Bool Unit Float List[T] Map[K,V] Option[T] Result[T,E]
Fn:         fn name(x: Type) -> RetType = expr
Effect:     effect fn name(x: Type) -> Result[T, E] = expr
If:         if cond then a else b                  (* else is MANDATORY *)
Match:      match x { some(v) => v, none => "" }
For:        for x in xs { ... }
            for (i, x) in list.enumerate(xs) { ... }
Range:      0..<5 = [0,1,2,3,4]   1...5 = [1,2,3,4,5]
Do loop:    do { guard cond else ok(()) ... }      (* dynamic break only *)
Guard:      guard cond else err(msg)               (* early exit *)
Lambda:     (x) => expr
Concat:     "a" + "b"   [1] + [2]               (* + for string AND list *)
XOR:        a ^ b
Interp:     "hello \${name}"
Heredoc:    """\\n  multi-line \${expr}\\n"""
Raw str:    r"\\d+"                                 (* no escape processing *)
Let/Var:    let x = 1    var y = 2    y = 3
Tuple:      (1, "a")
Pipe:       xs |> list.filter((x) => x > 0)
Variant:    type Color = | Red | Blue | Custom(Int, Int, Int)
Record:     type User = { name: String, age: Int }
Operators:  + - * / % ^ == != < > <= >= + and or not |>

## Stdlib (auto-imported)

string: trim split join len lines chars pad_start pad_end slice contains
  starts_with ends_with to_upper to_lower replace replace_first
  get index_of last_index_of repeat from_bytes to_bytes reverse
  is_empty is_digit is_alpha is_alphanumeric is_whitespace
  strip_prefix strip_suffix count capitalize codepoint from_codepoint
  trim_start trim_end

list: len get get_or set swap first last sort sort_by reverse contains index_of
  any all map flat_map filter find fold enumerate zip flatten
  take drop chunk unique join sum product min max is_empty
  filter_map take_while drop_while count partition reduce group_by
  insert remove_at find_index update scan intersperse windows dedup zip_with repeat

map: new get get_or set contains remove merge keys values len
  entries from_list is_empty map filter from_entries

int: to_string to_hex band bor bxor bshl bshr bnot clamp
     wrap_add wrap_mul rotate_right rotate_left to_u32 to_u8

float: to_string to_int from_int round floor ceil abs sqrt parse min max clamp

fs (effect): read_text write read_lines append mkdir_p exists is_dir
  is_file remove list_dir copy rename

path: join dirname basename extension is_absolute

env (effect): unix_timestamp millis args get set cwd sleep_ms

process (effect): exec exec_status exit stdin_lines

io (effect): read_line print read_all

## Import-required modules

import json   — parse stringify get get_string get_int get_bool get_array
                keys to_string to_int from_string from_int from_bool
                null array from_map get_float from_float stringify_pretty
import math   — min max abs pow pi e sin cos tan log exp sqrt
import random — int float choice shuffle
import time   — now millis sleep year month day hour minute second
                weekday to_iso from_parts
import regex  — match full_match find find_all replace replace_first
                split captures
import encoding — hex_encode hex_decode base64_encode base64_decode
import args   — flag option option_or positional

## Built-in functions (no prefix)

println(s) eprintln(s) assert_eq(a,b) assert_ne(a,b) assert(cond) unwrap_or(opt,default)

## Rules
- if-then-else for expressions. else is optional only when then-branch is Unit
- for...in for iteration (preferred over do+guard)
- + for string/list concat, ^ for XOR, not for boolean negation
- effect fn for side effects, Result[T,E] for errors, Option[T] for nullable
- All stdlib calls need module prefix: list.map(xs, f), NOT map(xs, f)
- println only takes String. Use int.to_string(n) or float.to_string(n)
- Empty list = [], empty map = map.new()
- _ is ONLY for match wildcard and for _ in loop, never as variable name
- Heredoc: """....""" with \${expr} interpolation, strips common indent
- Raw string: r"..." — no escape processing (for regex patterns etc.)
- UFCS: f(x, y) = x.f(y) — compiler resolves automatically
- fn parameters are IMMUTABLE. Use var to create a mutable copy
- Lists are immutable: list.set/list.swap return NEW lists

## Immutable list patterns
- list.get(xs, i) returns nullable. Use list.get_or(xs, i, default) for non-null
- list.set(xs, i, v) returns a new list. Assign: var a = xs; a = list.set(a, i, v)
- list.swap(xs, i, j) returns a new list with elements swapped
- For algorithms (sort, etc): use var + tuple return:
    fn partition(arr, lo, hi) -> (List[Int], Int) = {
      var a = arr  // mutable copy
      a = list.swap(a, i, j)  // returns new list
      (a, pivot_index)  // return modified list + result
    }

## Common mistakes — DO NOT
- list[1,2,3] → WRONG. Write [1,2,3]
- each(xs,f) → WRONG. Use for loop: for x in xs { f(x) }
- map[K,V] as value → WRONG. Write map.new()
- println(42) → WRONG. Write println(int.to_string(42))
- List.new() → WRONG. Write []. No new() for List
- arr = list.set(arr, i, v) where arr is a parameter → WRONG. Parameters are immutable. Declare var a = arr first

## Note: This runs in a browser playground
- process, io, env.args are NOT available (will throw errors)
- fs can only read data-file tabs that exist in the playground (e.g. fs.read_text("data.csv"))
- Keep examples focused on pure computation, string/list/math operations
- Use println for output

## Example
type Color = | Red | Green | Blue | Custom(Int, Int, Int)

fn describe(c: Color) -> String =
  match c {
    Red => "red"
    Green => "green"
    Blue => "blue"
    Custom(r, g, b) => "rgb(\${int.to_string(r)},\${int.to_string(g)},\${int.to_string(b)})"
  }

fn fibonacci(n: Int) -> List[Int] = {
  var a = 0
  var b = 1
  var result: List[Int] = []
  for _ in 0..<n {
    result = result + [a]
    let next = a + b
    a = b
    b = next
  }
  result
}

effect fn main() -> Result[Unit, String] = {
  let fibs = fibonacci(10)
  let visual = fibs
    |> list.map((n) => int.to_string(n))
    |> string.join(", ")
  println("Fibonacci: \${visual}")

  let colors = [Red, Green, Custom(255, 128, 0)]
  for c in colors {
    println(describe(c))
  }
}`;

function stripCodeFences(text) {
  return text.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

// --- Provider-specific streaming ---

async function streamAnthropic(apiKey, model, messages, signal, onText) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model, max_tokens: 16000, system: ALMIDE_SYSTEM, stream: true,
      messages,
      ...(MODELS.anthropic.find((m) => m.value === model)?.extra || {}),
    }),
    signal,
  });
  if (!resp.ok) throw new Error('API error ' + resp.status + ': ' + (await resp.text()));
  await readSSE(resp, (evt) => {
    if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
      onText(evt.delta.text);
    }
  });
}

async function streamOpenAI(apiKey, model, messages, signal, onText) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model, max_tokens: 4096, stream: true,
      messages: [
        { role: 'system', content: ALMIDE_SYSTEM },
        ...messages,
      ],
    }),
    signal,
  });
  if (!resp.ok) throw new Error('API error ' + resp.status + ': ' + (await resp.text()));
  await readSSE(resp, (evt) => {
    if (evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content) {
      onText(evt.choices[0].delta.content);
    }
  });
}

async function streamGemini(apiKey, model, messages, signal, onText) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':streamGenerateContent?key=' + apiKey + '&alt=sse';
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: ALMIDE_SYSTEM }] },
      contents,
    }),
    signal,
  });
  if (!resp.ok) throw new Error('API error ' + resp.status + ': ' + (await resp.text()));
  await readSSE(resp, (evt) => {
    if (evt.candidates && evt.candidates[0] && evt.candidates[0].content) {
      const parts = evt.candidates[0].content.parts;
      if (parts) for (const p of parts) { if (p.text) onText(p.text); }
    }
  });
}

async function readSSE(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try { onEvent(JSON.parse(data)); } catch (e) { /* skip */ }
    }
  }
}

const STREAMS = { anthropic: streamAnthropic, openai: streamOpenAI, gemini: streamGemini };

// --- Inline diff for the repair log ---

function simpleDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const lines = [];
  let ai = 0, bi = 0;
  while (ai < a.length || bi < b.length) {
    if (ai < a.length && bi < b.length && a[ai] === b[bi]) {
      lines.push({ type: 'ctx', text: a[ai] }); ai++; bi++;
    } else if (bi < b.length && (ai >= a.length || !a.includes(b[bi]))) {
      lines.push({ type: 'add', text: b[bi] }); bi++;
    } else if (ai < a.length && (bi >= b.length || !b.includes(a[ai]))) {
      lines.push({ type: 'del', text: a[ai] }); ai++;
    } else {
      lines.push({ type: 'del', text: a[ai] }); ai++;
      lines.push({ type: 'add', text: b[bi] }); bi++;
    }
  }
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'ctx') { result.push(lines[i]); continue; }
    const isNearChange = (j) => j >= 0 && j < lines.length && lines[j].type !== 'ctx';
    if (isNearChange(i - 1) || isNearChange(i + 1) || isNearChange(i - 2) || isNearChange(i + 2)) {
      result.push(lines[i]);
    } else if (result.length === 0 || result[result.length - 1].type !== 'skip') {
      result.push({ type: 'skip', text: '...' });
    }
  }
  return result;
}

function renderDiffHtml(diffLines) {
  return diffLines.map(l => {
    const cls = l.type === 'add' ? 'diff-add' : l.type === 'del' ? 'diff-del' : 'diff-ctx';
    const prefix = l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  ';
    const escaped = l.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return '<div class="' + cls + '">' + prefix + escaped + '</div>';
  }).join('');
}

const MAX_REPAIR_ATTEMPTS = 3;

const REPAIR_INSTRUCTION =
  '\n\nFix the code and output ONLY the corrected .almd source. No explanations.';

/**
 * Wire the AI bar. `ctx` is the app-side surface:
 *   getActiveCode(), setActiveCode(text), appendActiveCode(text),
 *   compileAndRun(code) → Promise<{ok, output, error, phase}>,
 *   setStatus(text), renderRepairLog(entries), setStreaming(bool)
 */
export function initAI(ctx) {
  const els = {
    provider: document.getElementById('ai-provider'),
    key: document.getElementById('ai-key'),
    model: document.getElementById('ai-model'),
    prompt: document.getElementById('ai-prompt'),
    btn: document.getElementById('ai-btn'),
  };
  let abortController = null;

  function populateModels(provider) {
    els.model.innerHTML = '';
    for (const m of MODELS[provider]) {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      els.model.appendChild(opt);
    }
    // A model id saved before MODELS changed no longer exists as an <option>;
    // assigning it would blank the select and send an empty model to the API.
    const savedModel = localStorage.getItem('almide-ai-model-' + provider);
    if (savedModel && MODELS[provider].some((m) => m.value === savedModel)) {
      els.model.value = savedModel;
    } else {
      localStorage.setItem('almide-ai-model-' + provider, els.model.value);
    }
  }

  function onProviderChange() {
    const provider = els.provider.value;
    localStorage.setItem('almide-ai-provider', provider);
    populateModels(provider);
    const saved = localStorage.getItem('almide-api-key-' + provider);
    els.key.value = saved || '';
    const placeholders = { anthropic: 'sk-ant-...', openai: 'sk-...', gemini: 'AIza...' };
    els.key.placeholder = placeholders[provider] || 'API Key';
  }

  els.provider.addEventListener('change', onProviderChange);
  els.key.addEventListener('change', (e) => {
    localStorage.setItem('almide-api-key-' + els.provider.value, e.target.value);
  });
  els.model.addEventListener('change', (e) => {
    localStorage.setItem('almide-ai-model-' + els.provider.value, e.target.value);
  });
  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      generate();
    }
  });
  els.btn.addEventListener('click', generate);

  const savedProvider = localStorage.getItem('almide-ai-provider') || 'anthropic';
  els.provider.value = savedProvider;
  onProviderChange();

  function hasKey() {
    return els.key.value.trim().length > 0;
  }

  async function streamIntoEditor(streamFn, apiKey, model, messages, signal) {
    ctx.setActiveCode('');
    await streamFn(apiKey, model, messages, signal, (text) => {
      ctx.appendActiveCode(text);
    });
    const cleaned = stripCodeFences(ctx.getActiveCode());
    ctx.setActiveCode(cleaned);
    return cleaned;
  }

  /**
   * Shared repair loop: compile-check `code`, stream fixes until it runs or
   * attempts are exhausted. `messages` must already contain the conversation
   * up to (and including) the assistant turn that produced `code`.
   */
  async function repairLoop(streamFn, apiKey, model, messages, code, result, repairLog, signal) {
    let totalFixes = 0;
    let prevCode = code;
    while (!result.ok && totalFixes < MAX_REPAIR_ATTEMPTS) {
      totalFixes++;
      const phase = result.phase === 'runtime' ? 'Runtime error' : 'Compile error';
      ctx.setStatus('Repairing (' + totalFixes + '/' + MAX_REPAIR_ATTEMPTS + ')...');
      repairLog.push({ cls: 'log-fix', label: 'Repair ' + totalFixes + '/' + MAX_REPAIR_ATTEMPTS + ' — fixing ' + phase.toLowerCase() });
      ctx.renderRepairLog(repairLog);

      messages.push({ role: 'user', content: phase + ':\n' + result.error + REPAIR_INSTRUCTION });

      prevCode = code;
      code = await streamIntoEditor(streamFn, apiKey, model, messages, signal);
      messages.push({ role: 'assistant', content: code });

      result = await ctx.compileAndRun(code);

      if (result.ok) {
        const diff = simpleDiff(prevCode, code);
        repairLog.push({ cls: 'log-ok', label: 'Fixed — compile & run OK', diffHtml: renderDiffHtml(diff) });
        if (result.output) {
          repairLog.push({ cls: 'log-ok', label: 'Output', detail: result.output });
        }
        ctx.setStatus('Repaired (' + totalFixes + ') & running');
      } else {
        const newPhase = result.phase === 'runtime' ? 'Runtime error' : 'Compile error';
        const prevError = repairLog.filter(e => e.cls === 'log-error').pop();
        const same = prevError && result.error === prevError.detail;
        repairLog.push({
          cls: 'log-error',
          label: same ? 'Same error persists' : 'New ' + newPhase.toLowerCase(),
          detail: result.error,
        });
      }
      ctx.renderRepairLog(repairLog);
    }
    if (!result.ok) {
      repairLog.push({ cls: 'log-fail', label: 'Failed after ' + MAX_REPAIR_ATTEMPTS + ' attempts', detail: result.error });
      ctx.renderRepairLog(repairLog);
      ctx.setStatus('Failed');
    }
    return result;
  }

  async function generate() {
    if (abortController) {
      abortController.abort();
      abortController = null;
      els.btn.textContent = 'Generate';
      ctx.setStatus('Cancelled');
      return;
    }
    const provider = els.provider.value;
    const apiKey = els.key.value.trim();
    if (!apiKey) { ctx.setStatus('Enter your API key first'); els.key.focus(); return; }
    const prompt = els.prompt.value.trim();
    if (!prompt) { ctx.setStatus('Describe what to generate'); els.prompt.focus(); return; }
    els.prompt.value = '';
    const model = els.model.value;
    const streamFn = STREAMS[provider];

    abortController = new AbortController();
    els.btn.textContent = 'Stop';
    ctx.setStreaming(true);
    ctx.setStatus('Generating...');

    const messages = [{ role: 'user', content: prompt }];
    const repairLog = [];
    try {
      const code = await streamIntoEditor(streamFn, apiKey, model, messages, abortController.signal);
      messages.push({ role: 'assistant', content: code });

      let result = await ctx.compileAndRun(code);
      if (result.ok) {
        repairLog.push({ cls: 'log-ok', label: 'Compile & run OK' });
        if (result.output) repairLog.push({ cls: 'log-ok', label: 'Output', detail: result.output });
        ctx.setStatus('Running');
      } else {
        const phase = result.phase === 'runtime' ? 'Runtime error' : 'Compile error';
        repairLog.push({ cls: 'log-error', label: phase + ' detected', detail: result.error });
      }
      ctx.renderRepairLog(repairLog);
      await repairLoop(streamFn, apiKey, model, messages, code, result, repairLog, abortController.signal);
    } catch (e) {
      if (e.name !== 'AbortError') ctx.setStatus('Error: ' + e.message);
    } finally {
      abortController = null;
      els.btn.textContent = 'Generate';
      ctx.setStreaming(false);
    }
  }

  /** "Fix with AI" from a failed manual Run. */
  async function repairFromRun(originalCode, initialResult) {
    if (!hasKey() || abortController) return;
    const provider = els.provider.value;
    const apiKey = els.key.value.trim();
    const model = els.model.value;
    const streamFn = STREAMS[provider];

    abortController = new AbortController();
    els.btn.textContent = 'Stop';
    ctx.setStreaming(true);

    const phase = initialResult.phase === 'runtime' ? 'Runtime error' : 'Compile error';
    const repairLog = [{ cls: 'log-error', label: phase + ' detected', detail: initialResult.error }];
    ctx.renderRepairLog(repairLog);

    const messages = [
      { role: 'user', content: 'Write this Almide program:\n\n```\n' + originalCode + '\n```' },
      { role: 'assistant', content: originalCode },
    ];
    try {
      await repairLoop(streamFn, apiKey, model, messages, originalCode, initialResult, repairLog, abortController.signal);
    } catch (e) {
      if (e.name !== 'AbortError') ctx.setStatus('Error: ' + e.message);
    } finally {
      abortController = null;
      els.btn.textContent = 'Generate';
      ctx.setStreaming(false);
    }
  }

  return { repairFromRun, hasKey };
}
