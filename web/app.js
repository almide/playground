// Playground controller: file tabs, worker-backed run, check-on-idle
// diagnostics, URL-hash sharing, example gallery, AI bar.

import { createEditor } from './editor.js';
import { Runner } from './runner.js';
import { encodeShare, decodeShare } from './share.js';
import { initAI } from './ai.js';
import { buildZip } from './zip.js';

// Embed mode (?embed=1): minimal chrome for iframes. ?hide=a.almd,b.almd
// hides tabs from the strip while still compiling them (Kotlin-style
// hidden setup code).
const BOOT_PARAMS = new URLSearchParams(location.search);
const EMBED = BOOT_PARAMS.get('embed') === '1';
const HIDDEN_TABS = new Set((BOOT_PARAMS.get('hide') || '').split(',').filter(Boolean));

const ENTRY = 'main.almd';
const STORAGE_KEY = 'almide-playground-files-v2';
const CHECK_DEBOUNCE_MS = 500;
const MAX_OUTPUT_LINES = 5000;

const DEFAULT_MAIN = `// Mini Markdown → HTML — ADT + pattern match + pipes + string interp

type Block =
  | Heading(Int, String)
  | Bullet(String)
  | Para(String)
  | Blank

fn parse_line(line: String) -> Block =
  if string.starts_with(line, "### ") then Heading(3, string.drop(line, 4))
  else if string.starts_with(line, "## ") then Heading(2, string.drop(line, 3))
  else if string.starts_with(line, "# ") then Heading(1, string.drop(line, 2))
  else if string.starts_with(line, "- ") then Bullet(string.drop(line, 2))
  else if string.is_empty(string.trim(line)) then Blank
  else Para(line)

fn bold(s: String) -> String =
  string.split(s, "**") |> list.enumerate |> list.map((e) => {
    let (i, chunk) = e
    if i % 2 == 1 then "<strong>\${chunk}</strong>" else chunk
  }) |> list.join("")

fn render(block: Block) -> String =
  match block {
    Heading(n, text) => {
      let tag = "h" + int.to_string(n)
      "<\${tag}>\${bold(text)}</\${tag}>"
    }
    Bullet(text) => "<li>\${bold(text)}</li>"
    Para(text)   => "<p>\${bold(text)}</p>"
    Blank        => ""
  }

fn wrap_lists(blocks: List[Block]) -> List[String] = {
  let result = blocks |> list.fold({ out: [], in_ul: false }, (st, b) => {
    let is_bullet = match b { Bullet(_) => true, _ => false }
    let opened =
      if is_bullet and not st.in_ul then st.out + ["<ul>"]
      else if not is_bullet and st.in_ul then st.out + ["</ul>"]
      else st.out
    { out: opened + [render(b)], in_ul: is_bullet }
  })
  if result.in_ul then result.out + ["</ul>"] else result.out
}

fn main() -> Unit = {
  let md = """
# Almide Playground

A **tiny** Markdown to HTML converter in ~50 lines.

## Features

- ADT with **variants**
- Pattern matching
- Pipe-based list ops

It's **compact** and **expressive**.
"""
  md
    |> string.lines
    |> list.map(parse_line)
    |> wrap_lists
    |> list.filter((s) => not string.is_empty(s))
    |> list.join("\\n")
    |> println
}`;

// --- State ---

let files = [{ name: ENTRY, content: DEFAULT_MAIN }];
let active = 0;
let running = false;
let diagnosticsByFile = new Map();
let checkTimer = null;
let saveTimer = null;
let checkGeneration = 0;

const runner = new Runner();

const $ = (id) => document.getElementById(id);
const statusEl = $('status-text');

function setStatus(text) {
  statusEl.textContent = text;
}

// --- Editor ---

const editor = createEditor($('editor-host'), {
  onChange() {
    scheduleCheck();
    scheduleSave();
  },
  onRun() {
    runCode();
  },
});

function isAlmd(name) {
  return name.endsWith('.almd');
}

function syncActive() {
  files[active].content = editor.getDoc();
}

function filesPayload() {
  const map = {};
  for (const f of files) map[f.name] = f.content;
  return map;
}

// --- File tabs ---

const tabsEl = $('file-tabs');

function renderTabs() {
  tabsEl.innerHTML = '';
  files.forEach((f, i) => {
    if (HIDDEN_TABS.has(f.name)) return;
    const tab = document.createElement('span');
    tab.className = 'file-tab' + (i === active ? ' active' : '');
    if ((diagnosticsByFile.get(f.name) || []).some((d) => d.level === 'error')) {
      tab.classList.add('has-error');
    }
    const label = document.createElement('span');
    label.textContent = f.name;
    tab.appendChild(label);
    tab.addEventListener('click', () => switchTab(i));
    if (f.name !== ENTRY && !EMBED) {
      tab.title = 'Double-click to rename';
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(i, tab, label);
      });
      const close = document.createElement('span');
      close.className = 'file-tab-close';
      close.textContent = '×';
      close.title = 'Remove file';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTab(i);
      });
      tab.appendChild(close);
    }
    tabsEl.appendChild(tab);
  });
  if (EMBED) return;
  const add = document.createElement('button');
  add.className = 'file-tab-add';
  add.textContent = '+';
  add.title = 'Add file (util.almd → import self.util, data.csv → fs.read_text, stdin.txt → stdin)';
  add.addEventListener('click', addTab);
  tabsEl.appendChild(add);
}

function switchTab(i, { skipSync = false } = {}) {
  if (i === active && !skipSync) return;
  if (!skipSync) syncActive();
  active = i;
  const f = files[i];
  editor.setDoc(f.content, { almd: isAlmd(f.name) });
  renderTabs();
  applyStoredDiagnostics();
}

function validTabName(name, exceptIndex) {
  if (!/^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(name)) return false;
  return !files.some((f, i) => i !== exceptIndex && f.name === name);
}

function nextFreeName() {
  for (const base of ['util', 'helpers', 'extra']) {
    const name = base + '.almd';
    if (!files.some((f) => f.name === name)) return name;
  }
  let n = 2;
  while (files.some((f) => f.name === 'mod' + n + '.almd')) n++;
  return 'mod' + n + '.almd';
}

function addTab() {
  syncActive();
  const name = nextFreeName();
  files.push({ name, content: '// import self.' + name.replace(/\.almd$/, '') + ' from main.almd to use this module\n' });
  switchTab(files.length - 1, { skipSync: true });
  scheduleSave();
}

function removeTab(i) {
  if (files[i].name === ENTRY) return;
  const wasActive = active === i;
  files.splice(i, 1);
  if (active > i) active--;
  if (active >= files.length) active = files.length - 1;
  if (wasActive) {
    const f = files[active];
    editor.setDoc(f.content, { almd: isAlmd(f.name) });
  }
  renderTabs();
  scheduleCheck();
  scheduleSave();
}

function startRename(i, tab, label) {
  const input = document.createElement('input');
  input.className = 'file-tab-rename';
  input.value = files[i].name;
  tab.replaceChild(input, label);
  input.focus();
  input.select();
  const commit = () => {
    const name = input.value.trim();
    if (validTabName(name, i)) {
      files[i].name = name;
      scheduleCheck();
      scheduleSave();
    } else if (name !== files[i].name) {
      setStatus('Invalid or duplicate file name: ' + name);
    }
    renderTabs();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = files[i].name;
      input.blur();
    }
  });
}

function setFiles(newFiles, { activeName = ENTRY } = {}) {
  files = newFiles.map((f) => ({ name: f.name, content: f.content }));
  if (!files.some((f) => f.name === ENTRY)) {
    files.unshift({ name: ENTRY, content: '' });
  }
  diagnosticsByFile = new Map();
  active = Math.max(0, files.findIndex((f) => f.name === activeName));
  if (HIDDEN_TABS.has(files[active].name)) {
    const visible = files.findIndex((f) => !HIDDEN_TABS.has(f.name));
    if (visible >= 0) active = visible;
  }
  const f = files[active];
  editor.setDoc(f.content, { almd: isAlmd(f.name) });
  renderTabs();
  scheduleCheck();
  scheduleSave();
}

// --- Diagnostics (check-on-idle) ---

function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, CHECK_DEBOUNCE_MS);
}

async function runCheck() {
  syncActive();
  const generation = ++checkGeneration;
  try {
    const res = await runner.check(filesPayload(), ENTRY);
    if (generation !== checkGeneration) return; // a newer check superseded us
    diagnosticsByFile = new Map();
    for (const d of res.diagnostics) {
      if (!diagnosticsByFile.has(d.file)) diagnosticsByFile.set(d.file, []);
      diagnosticsByFile.get(d.file).push(d);
    }
    applyStoredDiagnostics();
    renderTabs();
  } catch (e) {
    // check is best-effort; a cancelled worker mid-check is fine
  }
}

function applyStoredDiagnostics() {
  editor.applyDiagnostics(diagnosticsByFile.get(files[active].name) || []);
}

// --- Persistence ---

function scheduleSave() {
  if (EMBED) return; // an embedded snippet must not clobber the user's playground state
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    syncActive();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ files, active }));
    } catch (e) { /* storage full/blocked — non-fatal */ }
  }, 800);
}

function restoreFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.files) || data.files.length === 0) return false;
    setFiles(data.files, { activeName: data.files[data.active]?.name });
    return true;
  } catch (e) {
    return false;
  }
}

// --- Output pane ---

const outputEl = $('output');
let outputLineCount = 0;

function clearOutput() {
  outputEl.innerHTML = '';
  outputEl.className = 'output-area';
  outputLineCount = 0;
}

function appendOutputLine(line, cls) {
  if (outputLineCount >= MAX_OUTPUT_LINES) {
    if (outputLineCount === MAX_OUTPUT_LINES) {
      const div = document.createElement('div');
      div.textContent = '… output truncated (' + MAX_OUTPUT_LINES + ' lines) …';
      div.className = 'out-line err-line';
      outputEl.appendChild(div);
      outputLineCount++;
    }
    return;
  }
  const div = document.createElement('div');
  div.textContent = line.length ? line : ' ';
  div.className = 'out-line' + (cls ? ' ' + cls : '');
  outputEl.appendChild(div);
  outputLineCount++;
  outputEl.scrollTop = outputEl.scrollHeight;
}

function showError(error, phase, sourceForFix) {
  outputEl.className = 'output-area error';
  outputEl.innerHTML = '';
  const pre = document.createElement('pre');
  pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:0 0 12px';
  pre.textContent = error;
  outputEl.appendChild(pre);
  if (ai.hasKey() && sourceForFix != null) {
    const fixBtn = document.createElement('button');
    fixBtn.textContent = 'Fix with AI';
    fixBtn.className = 'fix-btn';
    fixBtn.onclick = () => ai.repairFromRun(sourceForFix, { ok: false, error, phase });
    outputEl.appendChild(fixBtn);
  }
  showTab('output');
}

function renderRepairLog(entries) {
  outputEl.className = 'output-area';
  outputEl.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'repair-log';
  for (const entry of entries) {
    const step = document.createElement('div');
    step.className = 'log-step ' + entry.cls;
    const label = document.createElement('div');
    label.className = 'log-label';
    label.textContent = entry.label;
    step.appendChild(label);
    if (entry.detail) {
      const detail = document.createElement('div');
      detail.className = 'log-detail';
      detail.textContent = entry.detail;
      step.appendChild(detail);
    }
    if (entry.diffHtml) {
      const diff = document.createElement('div');
      diff.className = 'log-diff';
      diff.innerHTML = entry.diffHtml;
      step.appendChild(diff);
    }
    container.appendChild(step);
  }
  outputEl.appendChild(container);
  outputEl.scrollTop = outputEl.scrollHeight;
  showTab('output');
}

// --- Visual tab (SVG / PPM rendered from stdout) ---

const visualEl = $('visual');
const VISUAL_HINT_HTML = visualEl.innerHTML;

function parsePPM(text) {
  // P3 (ASCII) only; '#' comments stripped per spec.
  const tokens = text
    .split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join(' ')
    .trim()
    .split(/\s+/);
  if (tokens[0] !== 'P3') return null;
  const w = parseInt(tokens[1], 10);
  const h = parseInt(tokens[2], 10);
  const max = parseInt(tokens[3], 10);
  if (!(w > 0 && h > 0 && max > 0) || w * h > 4_000_000) return null;
  const need = w * h * 3;
  if (tokens.length < 4 + need) return null;
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const r = parseInt(tokens[4 + i * 3], 10);
    const g = parseInt(tokens[5 + i * 3], 10);
    const b = parseInt(tokens[6 + i * 3], 10);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    img.data[i * 4] = (r * 255) / max;
    img.data[i * 4 + 1] = (g * 255) / max;
    img.data[i * 4 + 2] = (b * 255) / max;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

let visualBlobUrl = null;

/** Returns true when stdout rendered as an image (and fills the Visual tab). */
function renderVisual(stdout) {
  const text = stdout.trim();
  visualEl.innerHTML = VISUAL_HINT_HTML;
  if (visualBlobUrl) {
    URL.revokeObjectURL(visualBlobUrl);
    visualBlobUrl = null;
  }
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) {
    // Blob-URL <img> renders SVG with scripts disabled — safe for shared code.
    const img = document.createElement('img');
    img.alt = 'SVG output';
    visualBlobUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    img.src = visualBlobUrl;
    visualEl.innerHTML = '';
    visualEl.appendChild(img);
    return true;
  }
  if (text.startsWith('P3')) {
    const parsed = parsePPM(text);
    if (!parsed) return false;
    const canvas = document.createElement('canvas');
    canvas.width = parsed.width;
    canvas.height = parsed.height;
    canvas.className = 'pixelated';
    canvas.getContext('2d').putImageData(parsed, 0, 0);
    visualEl.innerHTML = '';
    visualEl.appendChild(canvas);
    return true;
  }
  return false;
}

// --- Right pane tabs ---

function showTab(name) {
  for (const t of ['output', 'visual', 'compiled', 'ast']) {
    $(t).style.display = t === name ? '' : 'none'; // '' → stylesheet display (block / flex for #visual)
    $('tab-' + t).className = t === name ? 'tab active' : 'tab';
  }
  if (name === 'compiled') refreshCompiled();
  if (name === 'ast') refreshAst();
}

async function refreshCompiled() {
  const el = $('compiled');
  syncActive();
  el.textContent = 'Compiling…';
  el.className = 'output-area';
  try {
    const res = await runner.compileRust(filesPayload(), ENTRY);
    if (res.ok) {
      el.textContent = res.code;
    } else {
      el.textContent = res.error;
      el.className = 'output-area error';
    }
  } catch (e) {
    el.textContent = String(e);
    el.className = 'output-area error';
  }
}

async function refreshAst() {
  const el = $('ast');
  syncActive();
  const f = isAlmd(files[active].name) ? files[active] : files.find((x) => x.name === ENTRY);
  try {
    const res = await runner.parseAst(f.content);
    if (res.ok) {
      el.textContent = res.ast;
      el.className = 'output-area';
    } else {
      el.textContent = res.error;
      el.className = 'output-area error';
    }
  } catch (e) {
    el.textContent = String(e);
    el.className = 'output-area error';
  }
}

// --- Run ---

const runBtn = $('run-btn');
const embedRunBtn = $('embed-run-btn');
const mobileRunBtn = $('mobile-run-btn');

function setRunning(state) {
  running = state;
  for (const btn of [runBtn, embedRunBtn, mobileRunBtn]) {
    btn.textContent = state ? 'Stop' : 'Run';
    btn.classList.toggle('running', state);
  }
}

// --- Mobile chrome: single-pane view flip + AI bottom sheet ---

const MOBILE = window.matchMedia('(max-width: 768px)');

function setMobileView(output) {
  document.body.classList.toggle('view-output', output);
  // The flip button always names the pane it would take you to.
  $('mobile-view-btn').textContent = output ? 'Code' : 'Output';
}

async function runCode() {
  if (running) {
    runner.cancel();
    setRunning(false);
    setStatus('Stopped');
    return;
  }
  syncActive();
  setRunning(true);
  clearOutput();
  showTab('output');
  if (MOBILE.matches) setMobileView(true);
  setStatus('Compiling…');
  const payload = filesPayload();
  const stdoutLines = [];
  try {
    const res = await runner.run(payload, ENTRY, (evt) => {
      if (evt.event === 'compiled') {
        setStatus('Running… (compiled in ' + evt.ms.toFixed(0) + 'ms)');
      } else if (evt.event === 'stdout') {
        if (stdoutLines.length < 200_000) stdoutLines.push(evt.line);
        appendOutputLine(evt.line);
      } else if (evt.event === 'stderr') {
        appendOutputLine(evt.line, 'err-line');
      }
    });
    if (res.ok) {
      if (outputLineCount === 0) appendOutputLine('(no output)');
      outputEl.classList.add('success');
      const exitNote = res.exitCode ? ' · exit ' + res.exitCode : '';
      setStatus('Ran in ' + res.runMs.toFixed(0) + 'ms · compiled in ' + res.compileMs.toFixed(0) + 'ms' + exitNote);
      if (res.exitCode) outputEl.classList.remove('success');
      if (!res.exitCode && renderVisual(stdoutLines.join('\n'))) showTab('visual');
    } else {
      const phase = res.phase === 'runtime' ? 'Runtime error' : 'Compile error';
      if (res.phase === 'runtime' && outputLineCount > 0) {
        // keep streamed output, append the error below it
        appendOutputLine('— ' + phase + ': ' + res.error, 'err-line');
      } else {
        showError(res.error, res.phase, files[active].content);
      }
      setStatus(phase);
    }
  } catch (e) {
    if (String(e.message).includes('cancelled')) {
      setStatus('Stopped');
    } else {
      showError(String(e.message || e), 'runtime', null);
      setStatus('Error');
    }
  } finally {
    setRunning(false);
  }
}

// --- Share ---

async function shareCode() {
  syncActive();
  try {
    const encoded = await encodeShare(files.map((f) => ({ name: f.name, content: f.content })));
    const url = new URL(location.href);
    url.search = '';
    url.hash = 'code=' + encoded;
    history.replaceState(null, '', url);
    setStatus('Share URL ready in the address bar (' + url.toString().length + ' chars)');
    try {
      await navigator.clipboard.writeText(url.toString());
      setStatus('Share URL copied to clipboard (' + url.toString().length + ' chars)');
    } catch (e) {
      // clipboard needs focus/permission; the address bar already has the URL
    }
  } catch (e) {
    setStatus('Share failed: ' + e.message);
  }
}

// --- Export (download as a runnable project) ---

function exportZip() {
  syncActive();
  // Mirror the layout `almide run src/main.almd` expects locally: .almd files
  // under src/, data files at the project root (the runtime cwd).
  const entries = [
    { name: 'almide-playground/almide.toml', text: '[package]\nname = "playground_export"\nversion = "0.1.0"\n' },
  ];
  for (const f of files) {
    const path = f.name.endsWith('.almd') ? 'src/' + f.name : f.name;
    entries.push({ name: 'almide-playground/' + path, text: f.content });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(buildZip(entries));
  a.download = 'almide-playground.zip';
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('Exported almide-playground.zip — unzip and `almide run src/main.almd`');
}

// --- Examples gallery ---

const examplesBtn = $('examples-btn');
const examplesMenu = $('examples-menu');
let manifest = null;

async function loadManifest() {
  try {
    const resp = await fetch('./examples/manifest.json');
    manifest = await resp.json();
    buildExamplesMenu();
  } catch (e) {
    examplesBtn.disabled = true;
  }
}

function buildExamplesMenu() {
  examplesMenu.innerHTML = '';
  for (const cat of manifest.categories) {
    const head = document.createElement('div');
    head.className = 'menu-category';
    head.textContent = cat.title;
    examplesMenu.appendChild(head);
    for (const ex of cat.examples) {
      const item = document.createElement('button');
      item.className = 'menu-item';
      item.innerHTML = '<span>' + ex.title + '</span>' +
        (ex.files.length > 1 ? '<span class="menu-badge">' + ex.files.length + ' files</span>' : '');
      item.addEventListener('click', () => {
        toggleExamplesMenu(false);
        loadExample(ex.id);
      });
      examplesMenu.appendChild(item);
    }
  }
}

function findExample(id) {
  for (const cat of manifest?.categories || []) {
    for (const ex of cat.examples) if (ex.id === id) return ex;
  }
  return null;
}

async function loadExample(id) {
  if (!manifest) await loadManifest();
  const ex = findExample(id);
  if (!ex) {
    setStatus('Unknown example: ' + id);
    return false;
  }
  setStatus('Loading example…');
  try {
    const loaded = await Promise.all(
      ex.files.map(async (name) => {
        const resp = await fetch('./examples/' + id + '/' + name);
        if (!resp.ok) throw new Error(name + ': HTTP ' + resp.status);
        return { name, content: await resp.text() };
      })
    );
    setFiles(loaded);
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.set('example', id); // keep embed/hide params intact
    history.replaceState(null, '', url);
    setStatus('Loaded example: ' + ex.title);
    // Picking an example is a request to READ it — leave the output view.
    if (MOBILE.matches) setMobileView(false);
    return true;
  } catch (e) {
    setStatus('Failed to load example: ' + e.message);
    return false;
  }
}

function toggleExamplesMenu(force) {
  const show = force !== undefined ? force : examplesMenu.hidden;
  examplesMenu.hidden = !show;
}

examplesBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleExamplesMenu();
});
document.addEventListener('click', (e) => {
  if (!examplesMenu.hidden && !examplesMenu.contains(e.target)) toggleExamplesMenu(false);
});

// --- AI ---

const ai = initAI({
  getActiveCode: () => {
    syncActive();
    return files[active].content;
  },
  setActiveCode: (text) => {
    files[active].content = text;
    editor.setDoc(text, { almd: isAlmd(files[active].name) });
  },
  appendActiveCode: (text) => {
    editor.appendText(text);
    files[active].content = editor.getDoc();
  },
  compileAndRun: async (code) => {
    const payload = filesPayload();
    payload[files[active].name] = code;
    clearOutput();
    const lines = [];
    try {
      const res = await runner.run(payload, ENTRY, (evt) => {
        if (evt.event === 'stdout' || evt.event === 'stderr') {
          lines.push(evt.line);
          appendOutputLine(evt.line, evt.event === 'stderr' ? 'err-line' : undefined);
        }
      });
      if (res.ok && !res.exitCode) return { ok: true, output: lines.join('\n') };
      if (res.ok) return { ok: false, phase: 'runtime', error: 'exited with code ' + res.exitCode + '\n' + lines.join('\n') };
      return { ok: false, phase: res.phase, error: res.error };
    } catch (e) {
      return { ok: false, phase: 'runtime', error: String(e.message || e) };
    }
  },
  setStatus,
  renderRepairLog,
  setStreaming: (on) => {
    $('editor-host').classList.toggle('ai-streaming', on);
  },
});

// --- GitHub star count in the header ---
// Pure decoration: the link works without it, so every failure path just
// leaves the badge hidden. Cached for an hour to stay far inside the
// unauthenticated API rate limit.

(async () => {
  const el = $('gh-star-count');
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
  try {
    const cached = JSON.parse(localStorage.getItem('gh-stars') || 'null');
    if (cached && Date.now() - cached.t < 3_600_000) {
      el.textContent = fmt(cached.n);
      el.hidden = false;
      return;
    }
    const resp = await fetch('https://api.github.com/repos/almide/almide');
    if (!resp.ok) return;
    const n = (await resp.json()).stargazers_count;
    if (typeof n !== 'number') return;
    localStorage.setItem('gh-stars', JSON.stringify({ n, t: Date.now() }));
    el.textContent = fmt(n);
    el.hidden = false;
  } catch (e) {
    /* offline, ad-blocked, rate-limited — the badge stays hidden */
  }
})();

// --- Wire header buttons & boot ---

runBtn.addEventListener('click', runCode);
embedRunBtn.addEventListener('click', runCode);
$('share-btn').addEventListener('click', shareCode);
$('export-btn').addEventListener('click', exportZip);
$('tab-output').addEventListener('click', () => showTab('output'));
$('tab-visual').addEventListener('click', () => showTab('visual'));
$('tab-compiled').addEventListener('click', () => showTab('compiled'));
$('tab-ast').addEventListener('click', () => showTab('ast'));

// Mobile bottom bar. The elements exist on desktop too (display: none),
// so the wiring is unconditional.
mobileRunBtn.addEventListener('click', runCode);
$('mobile-view-btn').addEventListener('click', () =>
  setMobileView(!document.body.classList.contains('view-output')));
$('mobile-ai-btn').addEventListener('click', () => document.body.classList.add('ai-open'));
$('ai-backdrop').addEventListener('click', () => document.body.classList.remove('ai-open'));
$('ai-close').addEventListener('click', () => document.body.classList.remove('ai-open'));
// Generating replaces the active tab's code — close the sheet and show
// the editor so you watch it stream in.
$('ai-btn').addEventListener('click', () => {
  document.body.classList.remove('ai-open');
  if (MOBILE.matches) setMobileView(false);
});

if (EMBED) {
  document.body.classList.add('embed');
  $('embed-bar').hidden = false;
  $('embed-open').addEventListener('click', (e) => {
    e.preventDefault();
    const url = new URL(location.href);
    url.searchParams.delete('embed');
    url.searchParams.delete('hide');
    window.open(url, '_blank', 'noopener');
  });
}

async function boot() {
  renderTabs();
  loadManifest();

  // Initial content: share hash > ?example= > localStorage > default.
  const hashMatch = location.hash.match(/^#code=(.+)$/);
  const exampleId = new URLSearchParams(location.search).get('example');
  let restored = false;
  if (hashMatch) {
    try {
      setFiles(await decodeShare(hashMatch[1]));
      setStatus('Loaded shared code');
      restored = true;
    } catch (e) {
      setStatus('Could not decode share link: ' + e.message);
    }
  }
  if (!restored && exampleId) {
    restored = await loadExample(exampleId);
  }
  if (!restored && !EMBED) restored = restoreFromStorage();
  if (!restored) {
    editor.setDoc(DEFAULT_MAIN);
    scheduleCheck();
  }

  try {
    const res = await runner.version();
    $('version-text').textContent = res.version;
  } catch (e) {
    setStatus('Wasm load failed: ' + e);
    return;
  }

  // `?autorun=1` — an embedder (docs page, article) that already asked for
  // this snippet should not make the reader press Run again.
  if (BOOT_PARAMS.get('autorun') === '1') runCode();
}

boot();

// Debug/E2E handle (not a public API).
window.__almidePlayground = {
  getFiles: () => {
    syncActive();
    return files.map((f) => ({ ...f }));
  },
  setFiles,
  loadExample,
  getDiagnostics: () => Object.fromEntries(diagnosticsByFile),
  setActiveDoc: (text) => {
    editor.setDoc(text, { almd: isAlmd(files[active].name) });
    scheduleCheck();
  },
};
