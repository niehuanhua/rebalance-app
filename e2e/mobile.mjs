// 手机布局冒烟测试：把浏览器窗口模拟成 390x844 的手机，检查"看得见的东西"。
// 断言的不是 CSS 文本，而是浏览器实际算出来的样式和有没有横向滚动条。
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
    expression: `(async function(){${expr}})()`, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const HIJACK = `
  window.__alerts = [];
  window.alert = (m) => window.__alerts.push(String(m));
  window.confirm = () => true;
`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: HIJACK });

// 先清掉 service worker 的老缓存，否则测到的是旧版 index.html / app.js
await send('Page.navigate', { url: URL_PAGE });
for (let i = 0; i < 100; i++) {
  if (await evaluate('return document.readyState === "complete";').catch(() => false)) break;
  await new Promise(r => setTimeout(r, 100));
}
await evaluate(`
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  localStorage.clear();
  return true;
`);

async function gotoMobile() {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: URL_PAGE });
  for (let i = 0; i < 100; i++) {
    const ok = await evaluate('return document.readyState === "complete" && document.querySelectorAll(".asset-item").length > 0;').catch(() => false);
    if (ok) break;
    await new Promise(r => setTimeout(r, 100));
  }
}
await gotoMobile();

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

/* ---------- 1. 手机上不该横向滚动 ---------- */
await check('390 宽：页面没有横向滚动', async () => {
  const v = await evaluate(`return { sw: document.documentElement.scrollWidth, iw: window.innerWidth };`);
  assert.ok(v.sw <= v.iw + 1, `scrollWidth=${v.sw} > innerWidth=${v.iw}`);
});

/* ---------- 2. 输入框 16px、够高好点 ---------- */
await check('输入框字号 ≥16px（避免手机自动放大）', async () => {
  const v = await evaluate(`
    const inp = document.querySelector('.assetName');
    return { size: parseFloat(getComputedStyle(inp).fontSize), w: inp.getBoundingClientRect().width };
  `);
  assert.ok(v.size >= 16, `字号只有 ${v.size}px`);
  assert.ok(v.w > 280, `输入框没占满一行，只有 ${v.w}px`);
});

await check('主要按钮高度 ≥44px（手指点得到）', async () => {
  const v = await evaluate(`
    const btn = document.querySelector('.primary-action button');
    return btn.getBoundingClientRect().height;
  `);
  assert.ok(v >= 44, `按钮高只有 ${v}px`);
});

/* ---------- 3. 算完之后，表格变成卡片 ---------- */
const CARDS = `
  window.__alerts = [];
  calculateRebalance();
  const tr = document.querySelectorAll('#resultTable tr')[1];
  const tds = [...tr.querySelectorAll('td')];
  return {
    alerts: window.__alerts,
    headHidden: getComputedStyle(document.querySelector('#resultTable .head-row')).display === 'none',
    tdDisplay: getComputedStyle(tds[1]).display,
    label: getComputedStyle(tds[1], '::before').content,
    firstDisplay: getComputedStyle(tds[0]).display,
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    rowHeight: tds[0].parentElement.getBoundingClientRect().height,
  };
`;
await check('结果表在手机上变成卡片（带标签），表头隐藏', async () => {
  const v = await evaluate(CARDS);
  assert.deepEqual(v.alerts, []);
  assert.equal(v.headHidden, true, '表头行没隐藏');
  assert.equal(v.tdDisplay, 'flex', `单元格 display=${v.tdDisplay}`);
  assert.match(v.label, /当前市值/, `data-label 没生效：${v.label}`);
  assert.equal(v.firstDisplay, 'block', '资产名那格没变成标题块');
  assert.ok(v.sw <= v.iw + 1, `出结果后横向溢出 ${v.sw} > ${v.iw}`);
  assert.ok(v.rowHeight > 100, `卡片太矮，可能还是表格布局：${v.rowHeight}`);
});

await check('转换方案表也变成卡片', async () => {
  const v = await evaluate(`
    const tr = document.querySelectorAll('#convertTable tr')[1];
    const tds = [...tr.querySelectorAll('td')];
    return {
      n: tds.length,
      headHidden: getComputedStyle(document.querySelector('#convertTable .head-row')).display === 'none',
      tdDisplay: getComputedStyle(tds[1]).display,
      label: getComputedStyle(tds[2], '::before').content,
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    };
  `);
  assert.equal(v.n, 6);
  assert.equal(v.headHidden, true);
  assert.equal(v.tdDisplay, 'flex');
  assert.match(v.label, /卖出份额/, `data-label 没生效：${v.label}`);
  assert.ok(v.sw <= v.iw + 1, `横向溢出 ${v.sw} > ${v.iw}`);
});

/* ---------- 4. 桌面端不受影响：还是表格 ---------- */
await check('切回 1280 宽：恢复成表格，表头可见', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 200));
  const v = await evaluate(`
    const tr = document.querySelectorAll('#resultTable tr')[1];
    const tds = [...tr.querySelectorAll('td')];
    return {
      head: getComputedStyle(document.querySelector('#resultTable .head-row')).display,
      td: getComputedStyle(tds[1]).display,
      size: parseFloat(getComputedStyle(document.querySelector('.assetName')).fontSize),
    };
  `);
  assert.notEqual(v.head, 'none', '桌面端表头不该隐藏');
  assert.equal(v.td, 'table-cell', `桌面端单元格 display=${v.td}`);
  assert.ok(v.size < 16, `桌面端输入框不该被撑到 ${v.size}px`);
});

await evaluate('localStorage.clear(); return true;').catch(() => {});

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
