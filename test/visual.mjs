// Visual タブのレンダラ(SVG / PPM / HTML)を、コンパイラ抜きで検証する。
//
//   node test/visual.mjs                              # ローカルの web/ を検証
//   node test/visual.mjs https://almide.github.io/playground/   # 本番を検証
//
// wasm コンパイラは CI ビルドなのでチェックアウトには無い。プログラムを走らせずに
// stdout だけ渡せるよう `__almidePlayground.renderVisual` を叩いている。
//
// HTML 出力の安全性(9発目のあとで追加):
//   共有されたコードが Visual タブで描かれる以上、SVG と同じ強さが要る。
//   SVG は <img> 経由なので secure static mode に入り、スクリプトも外部取得も
//   一切できない。iframe は素のままだとそれより弱いので、
//   sandbox="" (スクリプト無効・別生成元) と CSP (外部取得を全部拒否) で揃える。

import { spawn } from "node:child_process";
import { launch } from "./cdp.mjs";

const PORT = 8732;
// 引数で URL を渡せば本番をそのまま検証できる(その場合ローカルサーバは立てない)
const BASE = process.argv[2] || `http://127.0.0.1:${PORT}/`;
const server = process.argv[2]
  ? null
  : spawn("python3", ["-m", "http.server", String(PORT)], {
      cwd: new URL("../web/", import.meta.url).pathname,
      stdio: "ignore",
    });
await new Promise((r) => setTimeout(r, 800));

const chrome = await launch({ width: 1200, height: 800 });
const page = await chrome.page();
await page.goto(BASE);
for (let i = 0; i < 40; i++) {
  if (await page.eval(`Boolean(window.__almidePlayground?.renderVisual)`)) break;
  await new Promise((r) => setTimeout(r, 250));
}

let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "ok  " : "NG  "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};
const render = (stdout) =>
  page.eval(`window.__almidePlayground.renderVisual(${JSON.stringify(stdout)})`);
const probe = (expr) => page.eval(`(() => { ${expr} })()`);

console.log("SVG");
check(
  (await render(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 2'><rect width='2' height='2'/></svg>`)) === true,
  "受け付ける",
);
check((await probe(`return document.querySelectorAll('#visual img').length`)) === 1, "<img> で描く");

console.log("\nPPM");
check((await render(`P3\n2 1\n255\n255 0 0 0 0 255\n`)) === true, "受け付ける");
check(
  (await probe(`return document.querySelectorAll('#visual canvas').length`)) === 1,
  "canvas で描く",
);

console.log("\nHTML");
const DOC = `<!doctype html>\n<html><body style='margin:0;background:#111'>\n<i style='display:block;width:40px;height:40px;background:hsl(0 70% 60%)'></i>\n</body></html>`;
check((await render(DOC)) === true, "doctype 付きを受け付ける");
check(
  (await render(`<html><body><b>x</b></body></html>`)) === true,
  "doctype 無し(<html> 始まり)も受け付ける",
);
check(
  (await probe(`return document.querySelectorAll('#visual iframe').length`)) === 1,
  "iframe で描く",
);
check(
  (await probe(`return document.querySelector('#visual iframe').getAttribute('sandbox') === ''`)) === true,
  "sandbox が空(スクリプト無効・別生成元)",
);
check(
  (await probe(
    `const s = document.querySelector('#visual iframe').srcdoc;
     return /<head>.*Content-Security-Policy/s.test(s) && !/^<meta/i.test(s.trim())`,
  )) === true,
  "CSP を head の中に差し込む(doctype の前ではない)",
);

// 実際に描画されて、外部を取りに行かないこと
await render(DOC);
await new Promise((r) => setTimeout(r, 600));
check(
  (await probe(`const r = document.querySelector('#visual iframe').getBoundingClientRect();
                return r.width > 50 && r.height > 50`)) === true,
  "描画領域を持っている",
);

console.log("\nHTML でないもの");
check((await render(`hello`)) === false, "ただの文字列は Visual にしない");
check((await render(`<div>x</div>`)) === false, "断片(<div>)は Visual にしない");

await chrome.close();
server?.kill();
console.log(failed ? `\n${failed} 件失敗。` : "\nすべて通った。");
process.exit(failed ? 1 : 0);
