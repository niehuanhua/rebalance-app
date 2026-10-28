// 生成 Android 的启动图标和启动画面（splash），从 icons/icon.svg 的画法来。
//
// 为什么要有这个脚本：Capacitor 生成工程时塞的是它自己的默认图标（青绿色格子），
// 不换掉的话手机上就是个陌生 App 的样子。手改 PNG 不可复现，所以这里用 Chrome
// 无头模式把 SVG 渲染成各个尺寸，随时可以重跑。
//
// 用法：node scripts/make-android-icons.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(ROOT, 'android/app/src/main/res');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9333);

const BG = '#1b2430';
const GOLD = '#f2c14e';
const GREEN = '#5ec79b';
const PAPER = '#fbfaf7';

// 原图标里的两支箭头，坐标系 512×512，中心 (256,256)
const arrows = (k, cx = 256, cy = 256) => `
  <g fill="none" stroke-linecap="round" stroke-linejoin="round"
     transform="translate(${cx} ${cy}) scale(${k}) translate(-256 -256)">
    <g stroke="${GOLD}" stroke-width="48">
      <path d="M140 196 H340"/><path d="M316 156 L376 196 L316 236"/>
    </g>
    <g stroke="${GREEN}" stroke-width="48">
      <path d="M372 316 H172"/><path d="M196 276 L136 316 L196 356"/>
    </g>
  </g>`;

const iconSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <rect width="512" height="512" rx="112" fill="${BG}"/>${arrows(1)}</svg>`;

const roundIconSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <circle cx="256" cy="256" r="256" fill="${BG}"/>${arrows(1)}</svg>`;

// 自适应图标的前景：Android 只保证中间 66/108 的区域可见，四周会被裁掉，
// 所以箭头缩到 0.19 倍（原图宽 336 → 63.8，稳稳落在 66 里面），背景透明。
const foregroundSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="${size}" height="${size}">
  ${arrows(0.19, 54, 54)}</svg>`;

const splashSvg = (w, h) => {
  const m = Math.min(w, h);
  // 箭头原图（含 48 的线宽）宽 336、高 248。按目标宽度反推缩放倍率，整组居中。
  const artW = m * 0.26;
  const k = artW / 336;
  const artH = 248 * k;
  const title = m * 0.052;
  const gap = m * 0.055;
  const top = h / 2 - (artH + gap + title) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="${BG}"/>
  ${arrows(k, w / 2, top + artH / 2)}
  <text x="${w / 2}" y="${top + artH + gap + title * 0.78}" text-anchor="middle"
        font-family="PingFang SC, Heiti SC, sans-serif" font-size="${title}" fill="${PAPER}"
        letter-spacing="${title * 0.06}">资产再平衡</text>
</svg>`;
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'icon-gen-'));
let seq = 0;

// Chrome 的 --screenshot 参数在这台机器上截完图不会退出（后台更新进程一直挂着），
// 所以走和 e2e 一样的老路：开一个调试端口的 Chrome，用 CDP 逐张截图，截完杀掉。
const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(tmp, 'profile')}`,
  'about:blank',
], { stdio: 'ignore', detached: true });

const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; ; i++) {
  try { await fetch(`${BASE}/json/version`); break; }
  catch {
    if (i > 150) throw new Error('Chrome 调试端口没起来');
    await new Promise(r => setTimeout(r, 200));
  }
}

const target = await (await fetch(`${BASE}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method) {
    listeners.forEach(fn => fn(msg));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const once = (method) => new Promise(res => {
  const fn = (m) => { if (m.method === method) { listeners.delete(fn); res(m.params); } };
  listeners.add(fn);
});

await send('Page.enable');
// 背景透明，这样自适应图标的前景 PNG 才是透明的
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

async function render(svg, w, h, out) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}
    svg{display:block}</style>${svg}`;
  const file = path.join(tmp, `p${++seq}.html`);
  writeFileSync(file, html);
  mkdirSync(path.dirname(out), { recursive: true });

  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: 'file://' + file });
  await loaded;
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  if (!statSync(out).size) throw new Error(`截出来的图是空的：${out}`);
  written++;
}

let written = 0;

const MIPMAP = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [dpi, k] of Object.entries(MIPMAP)) {
  const dir = path.join(RES, `mipmap-${dpi}`);
  const legacy = Math.round(48 * k);
  // 必须逐个 await：同一个 Chrome 页面同时只能显示一个尺寸，
  // 不 await 的话 26 张图会一起排队导航，最后谁也等不到自己的加载事件，
  // 脚本还照样打印“完成”（踩过）。
  await render(iconSvg(legacy), legacy, legacy, path.join(dir, 'ic_launcher.png'));
  await render(roundIconSvg(legacy), legacy, legacy, path.join(dir, 'ic_launcher_round.png'));
  const fg = Math.round(108 * k);
  await render(foregroundSvg(fg), fg, fg, path.join(dir, 'ic_launcher_foreground.png'));
  console.log(`mipmap-${dpi}: ${legacy}px 图标 / ${fg}px 自适应前景`);
}

const SPLASH = {
  'drawable': [480, 320],
  'drawable-land-mdpi': [480, 320],
  'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280],
  'drawable-port-mdpi': [320, 480],
  'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920],
};

for (const [dir, [w, h]] of Object.entries(SPLASH)) {
  await render(splashSvg(w, h), w, h, path.join(RES, dir, 'splash.png'));
}
console.log(`启动画面：${Object.keys(SPLASH).length} 个尺寸`);

try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
rmSync(tmp, { recursive: true, force: true });

const EXPECTED = Object.keys(MIPMAP).length * 3 + Object.keys(SPLASH).length;
if (written !== EXPECTED) {
  throw new Error(`只写出 ${written} 张图，应该是 ${EXPECTED} 张 —— 有截图没落地，别打包。`);
}
console.log(`完成：${written} 张图全部落地。`);
