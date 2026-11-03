// 导出 Excel 的端到端测试。
//
// 背景（2026-11-03 真机实测）：在 APK 里点「导出」没有任何反应。
// 原因是 Capacitor 的 WebViewClient 没实现下载监听，XLSX.writeFile 那条
// Blob + 合成 <a download> 的路没人接。所以 app.js 里分了两条路：
//   网页版 → XLSX.writeFile（浏览器正常下载）
//   APK 里 → Filesystem 写进缓存目录 → Share 调系统分享面板
//
// 这里用 CDP 在页面脚本之前注入假的 Capacitor 桥，把两条路都跑一遍。
// 手机还没测的时候，这个测试就是唯一的证据。
// 跑法同 desktop.mjs：先起静态服务器 + 调试端口的 Chrome，见 e2e/README.md
import assert from 'node:assert/strict';

const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';
const URL_PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8123/index.html';

const t = await (await fetch(`${BASE}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const consoleErrors = [];

await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
  }
};

const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async function(){${expr}})()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// 假的 Capacitor 桥。是否生效由 sessionStorage 的 __e2eNative 决定，
// 这样一个标签页里能来回切「原生」和「网页」两种环境。
const INJECT = `
  window.__alerts = [];
  window.__calls = { filesystem: [], share: [] };
  window.alert = (m) => window.__alerts.push(String(m));
  window.confirm = () => true;
  if (sessionStorage.getItem('__e2eNative') !== '0') {
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        Filesystem: {
          writeFile: async (opts) => {
            window.__calls.filesystem.push({
              path: opts.path,
              directory: opts.directory,
              // 只留能证明「这真的是一个 xlsx」的片段，整串 base64 太大
              head: atob(opts.data).slice(0, 2),
              bytes: atob(opts.data).length,
            });
            return { uri: 'file:///data/user/0/com.niehuanhuan.rebalance/cache/' + opts.path };
          },
        },
        Share: {
          share: async (opts) => {
            window.__calls.share.push({ title: opts.title, url: opts.url, dialogTitle: opts.dialogTitle });
          },
        },
      },
    };
  }
`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });

async function gotoAndWait(predicate, tries = 100) {
  await send('Page.navigate', { url: URL_PAGE });
  for (let i = 0; i < tries; i++) {
    if (await evaluate(predicate).catch(() => false)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

// 先空跑一次：清 Service Worker 缓存，并预先「同意过隐私政策」，
// 免得每次都被首启弹窗挡住（弹窗本身由 consent.mjs 负责验）
await gotoAndWait('return document.readyState === "complete";');
await evaluate(`
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  localStorage.clear();
  localStorage.setItem('privacyConsent_v1', 'granted:v1');
  sessionStorage.setItem('__e2eNative', '1');
  return true;
`);

// 算出结果（默认那 3 个资产的默认值本身就是合法的，直接点计算）
async function runCalcThenExport(which = 'rebalance') {
  const ok = await gotoAndWait('return document.readyState === "complete" && document.querySelectorAll(".asset-item").length > 0;');
  if (!ok) throw new Error('主界面没出来');
  return evaluate(`
    calculateRebalance();
    await new Promise(r => setTimeout(r, 200));
    exportExcel('${which}');
    await new Promise(r => setTimeout(r, 400));
    return true;
  `);
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

/* ---------- 1. 原生环境：导出走 Filesystem + Share ---------- */
await runCalcThenExport('rebalance');
await check('APK 里导出：写进缓存目录一个真的 xlsx', async () => {
  const v = await evaluate(`return window.__calls.filesystem;`);
  assert.equal(v.length, 1, `Filesystem.writeFile 被调了 ${v.length} 次，应当正好 1 次`);
  assert.match(v[0].path, /^再平衡结果_\d{4}-\d{2}-\d{2}\.xlsx$/, `文件名不对：${v[0].path}`);
  assert.equal(v[0].directory, 'CACHE', '没写进 CACHE 目录（FileProvider 只放行了 cache-path）');
  assert.equal(v[0].head, 'PK', '内容不是 xlsx（xlsx 是 zip，开头必须是 PK）');
  assert.ok(v[0].bytes > 2000, `文件太小了：${v[0].bytes} 字节`);
});

await check('APK 里导出：调起系统分享面板，指向同一个文件', async () => {
  const v = await evaluate(`return window.__calls.share;`);
  assert.equal(v.length, 1, `Share.share 被调了 ${v.length} 次`);
  assert.match(v[0].url, /^file:\/\/.*再平衡结果_\d{4}-\d{2}-\d{2}\.xlsx$/, `分享的地址不对：${v[0].url}`);
  assert.equal(v[0].title, v[0].url.split('/').pop(), '标题和文件名不一致');
});

await check('APK 里导出：不再走浏览器那条死路，也没弹任何错误', async () => {
  const v = await evaluate(`return { alerts: window.__alerts };`);
  assert.deepEqual(v.alerts, [], '弹了提示：' + v.alerts.join(' | '));
});

/* ---------- 2. 分享面板点「取消」不该弹错误 ---------- */
await check('用户点取消分享：不弹「导出失败」', async () => {
  const v = await evaluate(`
    window.__alerts.length = 0;
    window.Capacitor.Plugins.Share.share = async () => { throw new Error('Share canceled'); };
    exportExcel('convert');
    await new Promise(r => setTimeout(r, 300));
    return { alerts: window.__alerts };
  `);
  assert.deepEqual(v.alerts, [], '点取消被当成错误弹出来了');
});

/* ---------- 3. 转换方案也能导出 ---------- */
await check('转换方案导出：文件名叫「转换方案_日期.xlsx」', async () => {
  const v = await evaluate(`
    window.__calls.filesystem.length = 0;
    window.__calls.share.length = 0;
    window.Capacitor.Plugins.Share.share = async (o) => { window.__calls.share.push(o); };
    exportExcel('convert');
    await new Promise(r => setTimeout(r, 300));
    return window.__calls;
  `);
  assert.equal(v.filesystem.length, 1);
  assert.match(v.filesystem[0].path, /^转换方案_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.equal(v.share.length, 1);
});

/* ---------- 4. 网页版：仍然走 XLSX.writeFile，不碰原生插件 ---------- */
await check('网页版导出：还走浏览器下载，不认识 Capacitor', async () => {
  await evaluate(`sessionStorage.setItem('__e2eNative', '0'); return true;`);
  const ok = await gotoAndWait('return document.readyState === "complete" && document.querySelectorAll(".asset-item").length > 0;');
  assert.ok(ok, '网页版主界面没出来');
  const v = await evaluate(`
    let saved = null;
    const real = XLSX.writeFile;
    XLSX.writeFile = (wb, name) => { saved = name; };
    calculateRebalance();
    await new Promise(r => setTimeout(r, 200));
    exportExcel('rebalance');
    await new Promise(r => setTimeout(r, 200));
    XLSX.writeFile = real;
    return { saved, hasCapacitor: !!window.Capacitor, alerts: window.__alerts };
  `);
  assert.match(String(v.saved), /^再平衡结果_\d{4}-\d{2}-\d{2}\.xlsx$/, `网页版没调 XLSX.writeFile：${v.saved}`);
  assert.equal(v.hasCapacitor, false, '网页版居然有 Capacitor 对象，测试环境没切干净');
  assert.deepEqual(v.alerts, []);
});

// 清理
await evaluate(`
  localStorage.clear();
  sessionStorage.clear();
  return true;
`).catch(() => {});

const bad = results.filter(r => r[0] === 'FAIL');
for (const r of results) console.log(r[0] === 'PASS' ? `PASS  ${r[1]}` : `FAIL  ${r[1]}\n      ${r[2]}`);
if (consoleErrors.length) {
  console.log('\n页面控制台报错：');
  consoleErrors.forEach(e => console.log('  ' + e));
}
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
ws.close();
await fetch(`${BASE}/json/close/${t.id}`);
process.exit(bad.length || consoleErrors.length ? 1 : 0);
