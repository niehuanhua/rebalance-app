// 端到端冒烟测试：用 CDP 在真浏览器里开页面，填数、点按钮、读表格。
// 断言的是"用户看得见的东西"，不是内部的 Core。
import assert from 'node:assert/strict';

const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';
const URL_PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8123/index.html';

async function newTarget() {
  const r = await fetch(`${BASE}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  return r.json();
}

const t = await newTarget();
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

// 把 alert 拦下来，记进数组（页面里大量用 alert 报错）
const HIJACK = `
  window.__alerts = [];
  window.alert = (m) => window.__alerts.push(String(m));
  window.confirm = () => true;
`;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: HIJACK });

// sw.js 对静态资源是缓存优先：不先清掉，测的就是上一版 app.js / index.html。
// 所以先空跑一次 → 注销 SW + 删缓存 → 再正式打开。
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

await send('Page.navigate', { url: URL_PAGE });
// 等 load + app.js 的 window.onload 跑完
for (let i = 0; i < 100; i++) {
  const ready = await evaluate(`return document.readyState === 'complete' && document.querySelectorAll('.asset-item').length > 0;`).catch(() => false);
  if (ready) break;
  await new Promise(r => setTimeout(r, 100));
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

/* ---------- 1. 默认状态：3 个资产，比例合计正好 100% ---------- */
await check('默认 3 个资产，目标比例 34/33/33，合计 100%', async () => {
  const v = await evaluate(`
    const rs = [...document.querySelectorAll('.targetRatio')].map(i => i.value);
    return { rs, sum: rs.reduce((a,b)=>a+Number(b),0), n: document.querySelectorAll('.asset-item').length };
  `);
  assert.equal(v.n, 3);
  assert.deepEqual(v.rs, ['34', '33', '33']);
  assert.equal(v.sum, 100);
});

await check('有「卖出费率」输入框，默认 0', async () => {
  const v = await evaluate(`return [...document.querySelectorAll('.sellFeeRate')].map(i => i.value);`);
  assert.deepEqual(v, ['0', '0', '0']);
});

await check('第一次点计算就能出结果，不弹任何错误', async () => {
  const v = await evaluate(`
    window.__alerts = [];
    calculateRebalance();
    return { alerts: window.__alerts, shown: getComputedStyle(document.getElementById('resultArea')).display };
  `);
  assert.deepEqual(v.alerts, []);
  assert.notEqual(v.shown, 'none');
});

/* ---------- 2. 五五开局：卖出 == 买入，不再多出 0.01 ---------- */
await check('242992.69 / 688939.38 五五开：两边都是 222,973.35，没有注资行', async () => {
  const v = await evaluate(`
    document.getElementById('assetCount').value = 2;
    createAssetInputs();
    const items = document.querySelectorAll('.asset-item');
    const set = (i, name, cur, ratio, price, sell) => {
      const it = items[i];
      it.querySelector('.assetName').value = name;
      it.querySelector('.currentValue').value = cur;
      it.querySelector('.targetRatio').value = ratio;
      it.querySelector('.currentPrice').value = price;
      it.querySelector('.sellFeeRate').value = sell;
      it.querySelector('.buyFeeRate').value = '0';
    };
    set(0, 'A', '242992.69', '50', '1.2345', '0');
    set(1, 'B', '688939.38', '50', '2.3456', '0');
    window.__alerts = [];
    calculateRebalance();
    const rows = [...document.querySelectorAll('#resultTable tr')].slice(1).map(tr =>
      [...tr.children].map(td => td.textContent.trim()));
    const plan = [...document.querySelectorAll('#convertTable tr')].slice(1).map(tr =>
      [...tr.children].map(td => td.textContent.trim()));
    return { alerts: window.__alerts, rows, plan };
  `);
  assert.deepEqual(v.alerts, []);
  const sell = v.rows.find(r => r[3] === '卖出');
  const buy = v.rows.find(r => r[3] === '买入');
  assert.equal(sell[4], '222,973.35', `卖出金额渲染成了 ${sell[4]}`);
  assert.equal(buy[4], '222,973.35', `买入金额渲染成了 ${buy[4]}`);
  assert.ok(!v.plan.some(p => p.includes('需额外注入资金')), '不该出现注资行：' + JSON.stringify(v.plan));
  assert.ok(!v.plan.some(p => p.includes('剩余卖出资金')), '不该出现剩余行：' + JSON.stringify(v.plan));
});

/* ---------- 3. 卖出费率真的生效 ---------- */
await check('卖出费率 0.5%：到账少 50，且提示还差 50', async () => {
  const v = await evaluate(`
    document.getElementById('assetCount').value = 2;
    createAssetInputs();
    const items = document.querySelectorAll('.asset-item');
    const set = (i, name, cur, ratio, price, sell, buy) => {
      const it = items[i];
      it.querySelector('.assetName').value = name;
      it.querySelector('.currentValue').value = cur;
      it.querySelector('.targetRatio').value = ratio;
      it.querySelector('.currentPrice').value = price;
      it.querySelector('.sellFeeRate').value = sell;
      it.querySelector('.buyFeeRate').value = buy;
    };
    set(0, '卖', '20000', '50', '10', '0.5', '0');
    set(1, '买', '0', '50', '10', '0', '0');
    window.__alerts = [];
    calculateRebalance();
    const rows = [...document.querySelectorAll('#resultTable tr')].slice(1).map(tr =>
      [...tr.children].map(td => td.textContent.trim()));
    const summary = document.getElementById('cashSummary').textContent;
    const plan = [...document.querySelectorAll('#convertTable tr')].slice(1).map(tr =>
      [...tr.children].map(td => td.textContent.trim()));
    return { alerts: window.__alerts, rows, summary, plan };
  `);
  assert.deepEqual(v.alerts, []);
  const sellRow = v.rows.find(r => r[3] === '卖出');
  // 交易金额 10,000 / 手续费 50 / 到账 9,950
  assert.equal(sellRow[4], '10,000.00');
  assert.equal(sellRow[5], '50.00');
  assert.equal(sellRow[6], '9,950.00');
  assert.match(v.summary, /还差 50\.00 元/);
  const inject = v.plan.find(p => p.includes('需额外注入资金'));
  assert.ok(inject, '应该有一行注资：' + JSON.stringify(v.plan));
});

/* ---------- 4. 名字里的 HTML 不会被执行 ---------- */
await check('资产名里的 HTML 被转义，不会变成真标签', async () => {
  const v = await evaluate(`
    document.getElementById('assetCount').value = 1;
    createAssetInputs();
    const it = document.querySelector('.asset-item');
    it.querySelector('.assetName').value = '<img src=x onerror="window.__xss=1">';
    it.querySelector('.currentValue').value = '100';
    it.querySelector('.targetRatio').value = '100';
    it.querySelector('.currentPrice').value = '10';
    window.__xss = 0;
    calculateRebalance();
    return {
      xss: window.__xss,
      imgs: document.querySelectorAll('#resultTable img').length,
      text: document.querySelector('#resultTable tr:nth-child(2) td').textContent,
    };
  `);
  assert.equal(v.xss, 0, 'XSS 被执行了');
  assert.equal(v.imgs, 0, '结果表里出现了真的 <img> 标签');
  assert.match(v.text, /<img/, '名字应该原样显示成文字');
});

/* ---------- 5. 输入校验报出具体行号 ---------- */
await check('价格填 0 → 报「第 1 行」并指出价格', async () => {
  const v = await evaluate(`
    document.getElementById('assetCount').value = 1;
    createAssetInputs();
    const it = document.querySelector('.asset-item');
    it.querySelector('.currentValue').value = '100';
    it.querySelector('.targetRatio').value = '100';
    it.querySelector('.currentPrice').value = '0';
    window.__alerts = [];
    calculateRebalance();
    return window.__alerts;
  `);
  assert.equal(v.length, 1);
  assert.match(v[0], /第 1 行.*价格/);
});

await check('资产数量输入 999 会被夹到 50', async () => {
  const v = await evaluate(`
    document.getElementById('assetCount').value = 999;
    createAssetInputs();
    return { shown: document.getElementById('assetCount').value, n: document.querySelectorAll('.asset-item').length };
  `);
  assert.equal(v.n, 50);
  assert.equal(v.shown, '50');
});

/* ---------- 6. 存盘：刷新后还能拿回来 ---------- */
await check('填的东西刷新后还在（含卖出费率）', async () => {
  await evaluate(`
    document.getElementById('assetCount').value = 2;
    createAssetInputs();
    const items = document.querySelectorAll('.asset-item');
    items[0].querySelector('.assetName').value = '股票';
    items[0].querySelector('.sellFeeRate').value = '0.15';
    items[1].querySelector('.assetName').value = '债券';
    items[1].querySelector('.currentPrice').value = '3.1415';
    saveDataFromDom();
    return true;
  `);
  await send('Page.navigate', { url: URL_PAGE });
  for (let i = 0; i < 100; i++) {
    const ready = await evaluate(`return document.querySelectorAll('.asset-item').length === 2;`).catch(() => false);
    if (ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const v = await evaluate(`
    const items = document.querySelectorAll('.asset-item');
    return {
      names: [...items].map(i => i.querySelector('.assetName').value),
      sell: [...items].map(i => i.querySelector('.sellFeeRate').value),
      price: [...items].map(i => i.querySelector('.currentPrice').value),
    };
  `);
  assert.deepEqual(v.names, ['股票', '债券']);
  assert.deepEqual(v.sell, ['0.15', '0']);
  assert.equal(v.price[1], '3.1415');
});

// 清理测试留下的本地数据
await evaluate(`localStorage.clear(); return true;`).catch(() => {});

/* ---------- 汇总 ---------- */
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
