const RUN_TIMEOUT_MS = 30_000;

export class Runner {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.spawn();
  }

  spawn() {
    this.worker = new Worker('./worker.js', { type: 'module' });
    this.worker.onmessage = (e) => this.dispatch(e.data);
    this.worker.onerror = (e) => {
      const err = new Error('worker error: ' + (e.message || 'unknown'));
      this.rejectAll(err);
    };
  }

  dispatch(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.event) {
      entry.onEvent?.(msg);
      return;
    }
    if (msg.done) {
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      entry.resolve(msg);
    }
  }

  rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  request(msg, { onEvent, timeout } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onEvent, timer: null };
      if (timeout) {
        entry.timer = setTimeout(() => {
          this.cancel();
          reject(new Error('timed out after ' + timeout / 1000 + 's'));
        }, timeout);
      }
      this.pending.set(id, entry);
      this.worker.postMessage({ id, ...msg });
    });
  }

  cancel() {
    this.worker.terminate();
    this.rejectAll(new Error('cancelled'));
    this.spawn();
  }

  version() {
    return this.request({ op: 'version' });
  }

  check(files, entry) {
    return this.request({ op: 'check', files, entry });
  }

  compileRust(files, entry) {
    return this.request({ op: 'rust', files, entry }, { timeout: RUN_TIMEOUT_MS });
  }

  parseAst(source) {
    return this.request({ op: 'ast', source });
  }

  run(files, entry, onEvent) {
    return this.request({ op: 'run', files, entry }, { onEvent, timeout: RUN_TIMEOUT_MS });
  }
}
