// Chrome を CDP で操作する最小クライアント。
// (almide-insta/assets/cdp.mjs と同じもの。このリポジトリ単体で動くよう複製している)
//
// なぜ必要か: headless の `--screenshot` / `--dump-dom` は「読み込みが終わった瞬間」に
// 撮るだけで、待つ手段が `--virtual-time-budget` しかない。ところが仮想時間では
// wasm やフォントの読み込みが完了しないので、**通ったように見えて何も検証できていない**
// 画面が撮れてしまう(9発目で実際に騙されかけた)。実時間で待って測るには CDP がいる。
//
// 使う側:
//   const chrome = await launch();
//   const page = await chrome.page();
//   await page.goto(url);
//   const v = await page.eval(`document.title`);
//   await chrome.close();

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9222, width = 1080, height = 1350 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "almide-cdp-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch {}
  }
  if (!target) {
    proc.kill();
    throw new Error("Chrome が CDP を開かなかった");
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");

  const page = {
    send,
    /** JS を評価して値を返す。例外は { __error } で返す(投げない) */
    async eval(expression) {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.result?.exceptionDetails) {
        return { __error: r.result.exceptionDetails.exception?.description || "評価に失敗" };
      }
      return r.result?.result?.value;
    },
    /** 読み込み + フォント確定まで待って遷移する */
    async goto(url, { settle = 300 } = {}) {
      await send("Page.navigate", { url });
      for (let i = 0; i < 60; i++) {
        await sleep(200);
        const ready = await this.eval(`document.readyState === 'complete'`);
        if (ready === true) break;
      }
      // フォントが載る前に測ると桁幅がズレる
      await this.eval(`document.fonts ? document.fonts.ready.then(() => true) : true`);
      await sleep(settle);
    },
    async screenshot(path) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (!r.result?.data) return false;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, Buffer.from(r.result.data, "base64"));
      return true;
    },
  };

  return {
    page: async () => page,
    async close() {
      try {
        ws.close();
      } catch {}
      proc.kill();
      // Chrome が終わる前に消すとキャッシュが書き込み中で残る
      await sleep(300);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
  };
}
