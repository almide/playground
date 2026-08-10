// CodeMirror 6 editor for Almide. Build-less: packages resolve through the
// importmap in index.html (esm.sh `*` builds share one @codemirror/state).
//
// The Almide mode is a StreamLanguage port of the old character-scanner
// highlighter — keyword/module sets match the real lexer (see the 2026-07
// keyword audit commit). Tokyo-night-ish colors match the previous Shiki theme.

import { EditorState, Compartment, StateEffect } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
} from '@codemirror/view';
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentUnit,
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';

const KEYWORDS = new Set([
  'module', 'import', 'type', 'protocol', 'for', 'in', 'fn', 'let', 'var', 'mut',
  'if', 'then', 'else', 'match', 'ok', 'err', 'some', 'none', 'todo',
  'not', 'and', 'or', 'strict', 'pub', 'effect', 'test',
  'guard', 'break', 'continue', 'while', 'local', 'mod', 'fan',
]);
const BOOLS = new Set(['true', 'false']);
const BUILTINS = new Set(['println', 'eprintln', 'assert', 'assert_eq', 'assert_ne', 'unwrap_or']);
// Kept in sync with `support.module.almide` in almide.tmLanguage.json.
const MODULES = new Set([
  'string', 'list', 'map', 'set', 'int', 'float', 'math', 'datetime', 'error',
  'value', 'bytes', 'matrix', 'option', 'result', 'prim', 'fs', 'env', 'process',
  'io', 'json', 'random', 'regex', 'testing', 'log', 'path', 'args', 'http',
  'net', 'zlib', 'base64', 'hex', 'html', 'mem', 'time', 'encoding', 'hash', 'term',
]);

// Text between the quotes. Stops at `${` so the interpolated expression is
// lexed as real code, and at the closing quote. Only "…" and """…"""
// interpolate — '…' is literal, so `'${x}'` prints the braces.
function lexStringBody(stream, state) {
  const quote = state.str;
  const interpolates = quote !== "'";
  let consumed = false;
  while (!stream.eol()) {
    if (interpolates && stream.match('${', false)) {
      if (consumed) return 'string';
      stream.match('${');
      state.interp = 1;
      return 'interpolation';
    }
    if (quote === '"""') {
      if (stream.match('"""', false)) {
        if (consumed) return 'string';
        stream.match('"""');
        state.str = null;
        return 'string';
      }
      stream.next();
      consumed = true;
      continue;
    }
    const ch = stream.next();
    consumed = true;
    if (ch === '\\') {
      stream.next();
      continue;
    }
    if (ch === quote) {
      state.str = null;
      return 'string';
    }
  }
  // Only """ heredocs survive a line break.
  if (quote !== '"""') state.str = null;
  return 'string';
}

// Everything that is not a comment or string literal — also used for the
// expression inside `${ … }`, so interpolated code gets its ordinary colors.
function lexCode(stream, state) {
  if (stream.match(/^\d[\d_]*(\.\d+)?/)) return 'number';
  if (stream.match(/^[A-Z][A-Za-z0-9_]*/)) return 'typeName';
  if (stream.match(/^[a-z_][A-Za-z0-9_]*\??/)) {
    const word = stream.current().replace(/\?$/, '');
    if (word === 'import') {
      state.afterImport = true;
      return 'keyword';
    }
    if (state.afterImport) {
      // `import random`, `import self.spark`, `import self as pkg`
      if (word === 'self' || word === 'as') return 'keyword';
      state.mods.add(word);
      state.afterImport = false;
      return 'module';
    }
    if (KEYWORDS.has(word)) return 'keyword';
    if (BOOLS.has(word)) return 'number';
    // Module names only qualify a member access, so `map` the variable and
    // `map.get` the module keep their own colors.
    if ((MODULES.has(word) || state.mods.has(word)) && stream.match(/^\./, false)) {
      return 'module';
    }
    if (BUILTINS.has(word)) return 'builtin';
    // fn-call position → function color (cheap lookahead).
    if (stream.match(/^\s*\(/, false)) return 'function';
    return 'variableName';
  }
  if (stream.match('->') || stream.match('=>') || stream.match('|>') ||
      stream.match('==') || stream.match('!=') || stream.match('<=') ||
      stream.match('>=') || stream.match('..') || stream.match('??')) {
    return 'operator';
  }
  stream.next();
  return 'operator';
}

const almideMode = {
  name: 'almide',
  startState() {
    return { commentDepth: 0, str: null, interp: 0, mods: new Set(), afterImport: false };
  },
  // `mods` is mutable, so each parser state copy needs its own.
  copyState(state) {
    return { ...state, mods: new Set(state.mods) };
  },
  token(stream, state) {
    if (stream.sol()) state.afterImport = false;
    // Nested (* ... *) block comments, possibly spanning lines.
    if (state.commentDepth > 0) {
      while (!stream.eol()) {
        if (stream.match('(*')) state.commentDepth++;
        else if (stream.match('*)')) {
          state.commentDepth--;
          if (state.commentDepth === 0) return 'comment';
        } else stream.next();
      }
      return 'comment';
    }
    // Inside `${ … }`: ordinary code until the brace that closes it.
    if (state.str && state.interp > 0) {
      if (stream.peek() === '}') {
        stream.next();
        state.interp -= 1;
        return state.interp === 0 ? 'interpolation' : 'operator';
      }
      if (stream.peek() === '{') {
        stream.next();
        state.interp += 1;
        return 'operator';
      }
      if (stream.eatSpace()) return null;
      return lexCode(stream, state);
    }
    // Inside a string literal (incl. """ heredocs, which span lines).
    if (state.str) return lexStringBody(stream, state);

    if (stream.eatSpace()) return null;

    if (stream.match('(*')) {
      state.commentDepth = 1;
      while (!stream.eol()) {
        if (stream.match('(*')) state.commentDepth++;
        else if (stream.match('*)')) {
          state.commentDepth--;
          if (state.commentDepth === 0) return 'comment';
        } else stream.next();
      }
      return 'comment';
    }
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    // r"…" is raw: no interpolation, single line.
    if (stream.match(/^r"[^"]*"?/)) return 'string';
    if (stream.match('"""')) {
      state.str = '"""';
      return 'string';
    }
    if (stream.peek() === '"' || stream.peek() === "'") {
      state.str = stream.next();
      return 'string';
    }
    return lexCode(stream, state);
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '(*', close: '*)' } },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
  },
  tokenTable: {
    keyword: t.keyword,
    string: t.string,
    comment: t.comment,
    number: t.number,
    typeName: t.typeName,
    builtin: t.standard(t.variableName),
    module: t.namespace,
    interpolation: t.special(t.brace),
    function: t.function(t.variableName),
    variableName: t.variableName,
    operator: t.operator,
  },
};

const almide = StreamLanguage.define(almideMode);
// Plain-text tabs (csv/json/…) get no tokenizer at all.
const plainText = [];

const almideHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#bb9af7', fontWeight: '500' },
  { tag: t.string, color: '#9ece6a' },
  { tag: t.comment, color: '#565f89', fontStyle: 'italic' },
  { tag: t.number, color: '#ff9e64' },
  { tag: t.typeName, color: '#2ac3de' },
  { tag: t.standard(t.variableName), color: '#7aa2f7' },
  { tag: t.namespace, color: '#e0af68' },
  { tag: t.special(t.brace), color: '#89ddff', fontWeight: '600' },
  { tag: t.function(t.variableName), color: '#7dcfff' },
  { tag: t.variableName, color: '#c0caf5' },
  { tag: t.operator, color: '#89ddff' },
]);

const almideTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--bg-deep)',
      color: 'var(--text)',
      height: '100%',
      fontSize: '13px',
    },
    '.cm-scroller': {
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      lineHeight: '1.7',
    },
    '.cm-content': { caretColor: 'var(--accent-light)', padding: '14px 0' },
    '.cm-cursor': { borderLeftColor: 'var(--accent-light)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-deep)',
      color: 'var(--text-muted)',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(124, 92, 191, 0.07)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(124, 92, 191, 0.12)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(124, 92, 191, 0.35) !important',
    },
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy var(--error) 1px',
      textUnderlineOffset: '3px',
    },
    '.cm-lintRange-warning': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy var(--warn-text) 1px',
      textUnderlineOffset: '3px',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
      color: 'var(--text-secondary)',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: '12px',
      maxWidth: '560px',
    },
    '.cm-diagnostic': { borderLeft: 'none', padding: '6px 10px', whiteSpace: 'pre-wrap' },
    '.cm-diagnostic-error': { borderLeft: '3px solid var(--error)' },
    '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn-text)' },
  },
  { dark: true }
);

const languageCompartment = new Compartment();

/**
 * Create the editor.
 * @param {HTMLElement} parent
 * @param {{ onChange?: () => void, onRun?: () => void }} hooks
 */
export function createEditor(parent, hooks = {}) {
  const runKeymap = keymap.of([
    {
      key: 'Mod-Enter',
      preventDefault: true,
      run: () => {
        hooks.onRun?.();
        return true;
      },
    },
  ]);

  const baseExtensions = [
    runKeymap, // before defaultKeymap so Mod-Enter wins
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    lintGutter(),
    syntaxHighlighting(almideHighlight),
    almideTheme,
    // A phone can't comfortably pan a horizontal code viewport — wrap instead.
    ...(window.matchMedia('(max-width: 768px)').matches ? [EditorView.lineWrapping] : []),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) hooks.onChange?.();
    }),
  ];

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [...baseExtensions, languageCompartment.of(almide)],
    }),
  });

  /** Full document swap (tab switch / example load / share restore). */
  function setDoc(text, { almd = true } = {}) {
    view.setState(
      EditorState.create({
        doc: text,
        extensions: [...baseExtensions, languageCompartment.of(almd ? almide : plainText)],
      })
    );
  }

  function getDoc() {
    return view.state.doc.toString();
  }

  /** Replace the whole doc in place, keeping undo history (AI streaming). */
  function replaceDoc(text) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }

  function appendText(text) {
    const end = view.state.doc.length;
    view.dispatch({
      changes: { from: end, insert: text },
      scrollIntoView: true,
    });
  }

  /**
   * Apply compiler diagnostics (crate `check_project` JSON entries) to the view.
   * Positions are 1-indexed line/col with an exclusive endCol.
   */
  function applyDiagnostics(entries) {
    const doc = view.state.doc;
    const diags = [];
    for (const d of entries) {
      let from = 0;
      let to = 0;
      if (d.line != null && d.line >= 1 && d.line <= doc.lines) {
        const line = doc.line(d.line);
        if (d.col != null) {
          from = Math.min(line.from + d.col - 1, line.to);
          to = d.endCol != null ? Math.min(line.from + d.endCol - 1, line.to) : line.to;
          if (to <= from) to = Math.min(from + 1, line.to);
        } else {
          from = line.from;
          to = line.to;
        }
      }
      let message = d.message;
      if (d.hint) message += '\nhint: ' + d.hint;
      const diag = {
        from,
        to,
        severity: d.level === 'warning' ? 'warning' : 'error',
        message,
      };
      // Compiler-provided quick fix: `try_snippet` + its exact replace range.
      if (d.trySnippet && d.tryReplace && d.tryReplace.length === 3) {
        const [l, c, ec] = d.tryReplace;
        if (l >= 1 && l <= doc.lines) {
          const line = doc.line(l);
          const rFrom = Math.min(line.from + c - 1, line.to);
          const rTo = Math.min(line.from + ec - 1, line.to);
          const snippet = d.trySnippet;
          diag.actions = [
            {
              name: 'Apply fix',
              apply(v) {
                v.dispatch({ changes: { from: rFrom, to: rTo, insert: snippet } });
              },
            },
          ];
        }
      }
      diags.push(diag);
    }
    view.dispatch(setDiagnostics(view.state, diags));
  }

  return { view, setDoc, getDoc, replaceDoc, appendText, applyDiagnostics };
}
