// 首启隐私同意弹窗的端到端测试。
//
// 难点：弹窗只在「原生环境」里出现（window.Capacitor.isNativePlatform() 为真），
// 而这里是普通 Chrome。用 CDP 的 Page.addScriptToEvaluateOnNewDocument 在页面
// 任何脚本之前注入一个假的 Capacitor 桥，就等于在浏览器里模拟出了 APK 环境——
// 业务代码里不需要留任何测试开关。（desktop.mjs 拦截 window.alert 用的也是这一招。）
//
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

// 假的 Capacitor 桥 + alert 拦截。必须在页面自己的脚本之前跑。
const INJECT = `
  window.__alerts = [];
  window.alert = (m) => window.__alerts.push(String(m));
  window.confirm = () => true;
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {},
  };
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

// 先空跑一次，清掉 Service Worker 缓存和上一次留下的同意记录
await gotoAndWait('return document.readyState === "complete";');
await evaluate(`
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  localStorage.clear();
  return true;
`);

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

const openWithGate = () => gotoAndWait(
  'return document.readyState === "complete" && !!document.getElementById("consentGate") && !document.getElementById("consentGate").hidden;'
);

/* ---------- 1. 原生环境 + 首次打开 → 弹窗，且主界面没渲染 ---------- */
await openWithGate();
await check('首次打开弹出隐私窗，主界面一个输入框都没有', async () => {
  const v = await evaluate(`
    return {
      visible: !document.getElementById('consentGate').hidden,
      assets: document.querySelectorAll('.asset-item').length,
      stored: localStorage.getItem('assetRebalanceData_v1'),
      consent: localStorage.getItem('privacyConsent_v1'),
    };
  `);
  assert.equal(v.visible, true, '隐私窗没出现');
  assert.equal(v.assets, 0, '主界面渲染了：同意之前不该出现任何输入框');
  assert.equal(v.stored, null, '同意之前就把业务数据写进 localStorage 了');
  assert.equal(v.consent, null);
});

/* ---------- 2. 没勾选时「同意并继续」不可点 ---------- */
await check('没勾选时「同意并继续」是禁用的', async () => {
  const v = await evaluate(`
    const b = document.getElementById('consentAgree');
    const before = b.disabled;
    const c = document.getElementById('consentCheckbox');
    c.checked = true; c.dispatchEvent(new Event('change'));
    const after = b.disabled;
    c.checked = false; c.dispatchEvent(new Event('change'));
    return { before, after };
  `);
  assert.equal(v.before, true, '没勾选就能点');
  assert.equal(v.after, false, '勾选后按钮还是禁用');
});

/* ---------- 3. 点「不同意」→ 主界面仍然不出，显示说明 ---------- */
await check('点「不同意」：主界面不出现，并提示无法使用', async () => {
  const v = await evaluate(`
    document.getElementById('consentDecline').click();
    await new Promise(r => setTimeout(r, 50));
    return {
      assets: document.querySelectorAll('.asset-item').length,
      declinedShown: !document.getElementById('consentDeclined').hidden,
      buttonsHidden: document.getElementById('consentButtons').hidden,
      consent: localStorage.getItem('privacyConsent_v1'),
    };
  `);
  assert.equal(v.assets, 0, '点不同意后居然进了主界面');
  assert.equal(v.declinedShown, true, '没有提示「无法使用」');
  assert.equal(v.consent, null, '点不同意还写了同意记录');
});

/* ---------- 4. 重新打开 → 又弹（不同意不会被记住）→ 勾选并同意 ---------- */
await openWithGate();
await check('勾选并点「同意并继续」：主界面出现，同意记录已写下', async () => {
  const v = await evaluate(`
    const c = document.getElementById('consentCheckbox');
    c.checked = true; c.dispatchEvent(new Event('change'));
    document.getElementById('consentAgree').click();
    await new Promise(r => setTimeout(r, 200));
    return {
      gateHidden: document.getElementById('consentGate').hidden,
      assets: document.querySelectorAll('.asset-item').length,
      consent: localStorage.getItem('privacyConsent_v1'),
      alerts: window.__alerts,
    };
  `);
  assert.equal(v.gateHidden, true, '同意后弹窗没关');
  assert.equal(v.assets, 3, '同意后没渲染出默认的 3 个资产');
  assert.equal(v.consent, 'granted:v1');
  assert.deepEqual(v.alerts, []);
});

/* ---------- 5. 再次打开 → 不再弹，直接进主界面 ---------- */
await check('同意过之后再打开：不弹窗，数据直接恢复', async () => {
  const ok = await gotoAndWait(
    'return document.readyState === "complete" && document.querySelectorAll(".asset-item").length > 0;'
  );
  assert.ok(ok, '重开后主界面没出来');
  const v = await evaluate(`
    return {
      gateHidden: document.getElementById('consentGate').hidden,
      assets: document.querySelectorAll('.asset-item').length,
    };
  `);
  assert.equal(v.gateHidden, true, '同意过了还在弹');
  assert.equal(v.assets, 3);
});

// 清理
await evaluate(`localStorage.clear(); return true;`).catch(() => {});

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
