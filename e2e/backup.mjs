// 备份 / 恢复的端到端测试。
//
// 背景：APK 里 allowBackup="false"，数据只在本机 localStorage，换手机就全丢。
// 「导出 Excel」只能带走计算结果，带不回录入的数据，所以加了 .json 备份。
//
// 这里用真浏览器验两件事：
//   1. 网页版备份走浏览器下载，APK 里走 Filesystem + 分享面板（复用导出 Excel 那条路）
//   2. 备份 → 恢复是一个完整的往返：恢复后输入框里的值必须跟备份时一模一样
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

// 假 Capacitor 桥 + 拦截浏览器下载。是否算「原生」由 sessionStorage.__e2eNative 决定，
// 这样一个标签页里能来回切两种环境。
const INJECT = `
  window.__alerts = [];
  window.__calls = { filesystem: [], share: [] };
  window.__downloads = [];
  window.__confirmAnswer = true;
  window.alert = (m) => window.__alerts.push(String(m));
  window.confirm = () => window.__confirmAnswer;

  const realCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = (blob) => { window.__downloads.push(blob); return 'blob:e2e-fake'; };
  URL.revokeObjectURL = () => {};
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { window.__lastAnchor = { download: this.download }; };

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
              base64: opts.data,
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

// 清 Service Worker 缓存，预先同意隐私政策，并选定「网页版 / APK」环境
async function reset(native) {
  const ok = await gotoAndWait('return document.readyState === "complete";');
  if (!ok) throw new Error('页面打不开');
  await evaluate(`
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    localStorage.clear();
    localStorage.setItem('privacyConsent_v1', 'granted:v1');
    sessionStorage.setItem('__e2eNative', '${native ? '1' : '0'}');
    return true;
  `);
  const ok2 = await gotoAndWait('return document.readyState === "complete" && document.querySelectorAll(".asset-item").length > 0;');
  if (!ok2) throw new Error('主界面没出来');
}

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

/* ---------- 网页版：备份走浏览器下载 ---------- */
await reset(false);

await check('网页版备份：下载一个 .json，文件名带日期', async () => {
  const v = await evaluate(`
    exportBackup();
    await new Promise(r => setTimeout(r, 100));
    return { count: window.__downloads.length, anchor: window.__lastAnchor, alerts: window.__alerts };
  `);
  assert.equal(v.count, 1, `下载了 ${v.count} 个文件，应当正好 1 个`);
  assert.match(v.anchor.download, /^再平衡备份_\d{4}-\d{2}-\d{2}\.json$/, `文件名不对：${v.anchor.download}`);
  assert.deepEqual(v.alerts, [], '不该弹提示：' + v.alerts.join(' | '));
});

await check('网页版备份：内容是一份合法的备份，资产数与界面一致', async () => {
  const v = await evaluate(`
    const text = await window.__downloads[0].text();
    const data = JSON.parse(text);
    localStorage.setItem('__lastBackup', text);
    return { data, assetCount: document.querySelectorAll('.asset-item').length };
  `);
  assert.equal(v.data.format, 'rebalance-backup');
  assert.equal(v.data.app, '资产再平衡计算器');
  assert.equal(v.data.assets.length, v.assetCount, '备份里的资产数和界面对不上');
  assert.equal(v.data.assetCount, v.assetCount);
});

await check('网页版备份：名字和数字原样保留（不是四舍五入后的结果）', async () => {
  const v = await evaluate(`
    document.querySelectorAll('.assetName')[0].value = '沪深300「增强」&<测试>';
    document.querySelectorAll('.currentValue')[0].value = '123456.78';
    document.querySelectorAll('.currentPrice')[0].value = '4.1234';
    saveDataFromDom();
    window.__downloads.length = 0;
    exportBackup();
    await new Promise(r => setTimeout(r, 100));
    const text = await window.__downloads[0].text();
    // 下一组「恢复」测试就用这一份（带着刚改的名字）
    localStorage.setItem('__lastBackup', text);
    const data = JSON.parse(text);
    return { a0: data.assets[0], a1: data.assets[1] };
  `);
  assert.equal(v.a0.name, '沪深300「增强」&<测试>');
  assert.equal(v.a0.currentValue, '123456.78');
  assert.equal(v.a0.currentPrice, '4.1234');
  assert.ok(v.a1, '第二个资产丢了');
});

/* ---------- 网页版：恢复是一个完整的往返 ---------- */
await check('恢复：把备份喂回去，输入框的值跟备份时一模一样', async () => {
  const v = await evaluate(`
    // 先改掉界面上的数据，证明恢复真的起了作用
    document.querySelectorAll('.assetName')[0].value = '被改坏了';
    saveDataFromDom();

    const text = localStorage.getItem('__lastBackup');
    const file = new File([text], '再平衡备份.json', { type: 'application/json' });
    const fakeInput = { files: [file], value: 'x' };
    await importBackupFromInput(fakeInput);
    await new Promise(r => setTimeout(r, 100));

    const stored = JSON.parse(localStorage.getItem('assetRebalanceData_v1'));
    return {
      first: document.querySelectorAll('.assetName')[0].value,
      count: document.querySelectorAll('.asset-item').length,
      countInput: document.getElementById('assetCount').value,
      storedFirst: stored.assets[0].name,
      alerts: window.__alerts,
      inputCleared: fakeInput.value === '',
    };
  `);
  assert.equal(v.first, '沪深300「增强」&<测试>', '恢复后第一个资产名字不对');
  assert.equal(v.storedFirst, '沪深300「增强」&<测试>', '没写进 localStorage');
  assert.equal(String(v.countInput), String(v.count), '资产数量输入框没跟着改');
  assert.equal(v.inputCleared, true, '没清空 file input，同一个文件选第二次会没反应');
  assert.ok(v.alerts.some(a => a.includes('已恢复')), '恢复成功应当给一句提示：' + v.alerts.join(' | '));
});

await check('恢复：恢复后旧的计算结果被藏起来，不会拿旧结果误导人', async () => {
  const v = await evaluate(`
    calculateRebalance();
    await new Promise(r => setTimeout(r, 100));
    const before = document.getElementById('resultArea').style.display;
    const text = localStorage.getItem('__lastBackup');
    const file = new File([text], 'b.json', { type: 'application/json' });
    await importBackupFromInput({ files: [file], value: '' });
    await new Promise(r => setTimeout(r, 100));
    return { before, after: document.getElementById('resultArea').style.display };
  `);
  assert.equal(v.before, 'block', '前置条件不成立：算了之后结果区应当是显示的');
  assert.equal(v.after, 'none', '恢复后结果区还开着');
});

await check('恢复：选错文件（Excel / 照片）会明确拒绝，数据不动', async () => {
  const v = await evaluate(`
    const before = localStorage.getItem('assetRebalanceData_v1');
    window.__alerts.length = 0;
    const file = new File(['PK\\u0003\\u0004 这其实是个 xlsx'], '再平衡结果_2026-11-06.xlsx');
    await importBackupFromInput({ files: [file], value: '' });
    await new Promise(r => setTimeout(r, 100));
    return { before, after: localStorage.getItem('assetRebalanceData_v1'), alerts: window.__alerts };
  `);
  assert.equal(v.after, v.before, '选错文件居然把数据改了');
  assert.equal(v.alerts.length, 1, '应当只弹一条提示');
  assert.match(v.alerts[0], /恢复失败/);
  assert.match(v.alerts[0], /JSON/);
});

await check('恢复：用户点「取消」就不覆盖', async () => {
  const v = await evaluate(`
    window.__confirmAnswer = false;
    const before = localStorage.getItem('assetRebalanceData_v1');
    window.__alerts.length = 0;
    const text = JSON.stringify({ format: 'rebalance-backup', formatVersion: 1,
      assets: [{ name: '别动我', currentValue: '1', targetRatio: '100', buyFeeRate: '0', sellFeeRate: '0', currentPrice: '1' }] });
    await importBackupFromInput({ files: [new File([text], 'b.json')], value: '' });
    await new Promise(r => setTimeout(r, 100));
    window.__confirmAnswer = true;
    return { before, after: localStorage.getItem('assetRebalanceData_v1'), alerts: window.__alerts };
  `);
  assert.equal(v.after, v.before, '点了取消还是覆盖了');
  assert.deepEqual(v.alerts, [], '取消不该报错：' + v.alerts.join(' | '));
});

/* ---------- APK 里：走 Filesystem + 分享面板 ---------- */
await reset(true);

await check('APK 里备份：写进缓存目录一个真的 json（中文不乱码）', async () => {
  const v = await evaluate(`
    document.querySelectorAll('.assetName')[0].value = '债券基金·稳健';
    saveDataFromDom();
    exportBackup();
    await new Promise(r => setTimeout(r, 300));
    const call = window.__calls.filesystem[0];
    const text = new TextDecoder().decode(Uint8Array.from(atob(call.base64), c => c.charCodeAt(0)));
    return {
      call,
      data: JSON.parse(text),
      alerts: window.__alerts,
      inDom: document.querySelectorAll('.asset-item').length,
    };
  `);
  assert.equal(v.call.directory, 'CACHE', '没写进 CACHE（FileProvider 只放行 cache-path）');
  assert.match(v.call.path, /^再平衡备份_\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(v.data.format, 'rebalance-backup');
  assert.equal(v.data.assets[0].name, '债券基金·稳健', 'base64 编解码把中文弄坏了');
  assert.equal(v.data.assets.length, v.inDom, '备份里的资产数和界面对不上');
  assert.deepEqual(v.alerts, [], '不该弹提示：' + v.alerts.join(' | '));
});

await check('APK 里备份：调起分享面板，指向同一个文件', async () => {
  const v = await evaluate(`return window.__calls.share;`);
  assert.equal(v.length, 1, `Share.share 被调了 ${v.length} 次`);
  assert.match(v[0].url, /^file:\/\/.*再平衡备份_\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(v[0].title, v[0].url.split('/').pop(), '标题和文件名不一致');
});

await check('APK 里恢复：备份文件能原样读回来', async () => {
  const v = await evaluate(`
    const call = window.__calls.filesystem[0];
    const text = new TextDecoder().decode(Uint8Array.from(atob(call.base64), c => c.charCodeAt(0)));
    await importBackupFromInput({ files: [new File([text], 'b.json')], value: '' });
    await new Promise(r => setTimeout(r, 100));
    return { first: document.querySelectorAll('.assetName')[0].value };
  `);
  assert.equal(v.first, '债券基金·稳健');
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
