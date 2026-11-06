/* app.js —— 界面层。只管读写页面、存本地、导 Excel。
 *
 * 所有算数都在 core.js 里，这里一律调 Core.xxx，
 * 不许自己再写一遍公式——两份实现迟早会跑偏。
 */
const STORAGE_KEY = 'assetRebalanceData_v1';
// 上下限只写一份，放在 backup.js 里：备份解析也要按同一个上限把关
const MIN_ASSETS = Backup.MIN_ASSETS;
const MAX_ASSETS = Backup.MAX_ASSETS;

let rebalanceResults = [];
let convertResults = [];

const fmtMoney = x => Number(x).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 把用户输入的名字安全地塞进 innerHTML（名字里可能有 < > " &）
const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// localStorage 降级封装：隐私模式下不崩溃
const safeStorage = {
    get(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, val) {
        try { localStorage.setItem(key, val); } catch (e) {}
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    },
};

/* ---- 首启隐私同意 ----
 * 只在 APK 里弹（网页版 / PWA / e2e 拿不到 Capacitor，直接走 startApp）。
 * 必须在 loadStoredData() / createAssetInputs() 之前判定：
 * createAssetInputs() 一进来就会把默认数据写进 localStorage（第 91 行），
 * 门放在它后面等于「只是打开了一次」就已经落盘了数据。
 */
const CONSENT_KEY = 'privacyConsent_v1';
const CONSENT_VALUE = 'granted:v1';   // 隐私政策改版时改成 v2，老用户会被重新问一次

function isNativeApp() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform
        && window.Capacitor.isNativePlatform());
}

window.onload = function () {
    if (isNativeApp() && safeStorage.get(CONSENT_KEY) !== CONSENT_VALUE) {
        showConsentGate();   // 只显示弹层，不读也不写任何业务数据
        return;
    }
    startApp();
};

function startApp() {
    document.documentElement.classList.remove('capacitor-native');
    if (typeof XLSX === 'undefined') {
        alert('Excel 导出库加载失败');
    }
    loadStoredData();
    const container = document.getElementById('assetInputs');
    if (!container || container.innerHTML.trim() === '') createAssetInputs();
}

function showConsentGate() {
    const gate = document.getElementById('consentGate');
    const check = document.getElementById('consentCheckbox');
    const agree = document.getElementById('consentAgree');
    const decline = document.getElementById('consentDecline');
    const declined = document.getElementById('consentDeclined');
    const buttons = document.getElementById('consentButtons');
    if (!gate || !check || !agree || !decline) { startApp(); return; }   // 兜底：DOM 没跟上别把人锁死

    gate.hidden = false;
    check.addEventListener('change', () => { agree.disabled = !check.checked; });
    agree.addEventListener('click', () => {
        if (!check.checked) return;
        safeStorage.set(CONSENT_KEY, CONSENT_VALUE);
        gate.hidden = true;
        startApp();
    });
    decline.addEventListener('click', () => {
        // Capacitor 没有内置退出 API，为这个装插件不值得：
        // 挡住主界面并说明原因，效果等同于「不能用」。
        buttons.hidden = true;
        check.disabled = true;
        if (declined) declined.hidden = false;
    });
}

function createAssetInputs(savedAssets) {
    const countInput = document.getElementById('assetCount');
    let count = parseInt(countInput.value, 10);
    if (!Number.isFinite(count)) count = 1;
    count = Math.min(MAX_ASSETS, Math.max(MIN_ASSETS, count));
    countInput.value = count;
    countInput.min = MIN_ASSETS;
    countInput.max = MAX_ASSETS;

    const container = document.getElementById('assetInputs');
    container.innerHTML = '';

    // 默认比例合计必须正好 100%，否则第一次点计算就报错
    const defaultRatios = Core.defaultRatioBp(count);
    const saveArr = [];

    for (let i = 0; i < count; i++) {
        // 有存过就用存的原样（包括她清空成空白的情况），没有才给默认值
        const saved = savedAssets && savedAssets[i] ? savedAssets[i] : {};
        const pick = (key, fallback) =>
            (saved[key] === undefined || saved[key] === null) ? fallback : String(saved[key]);

        const name = pick('name', `资产${i + 1}`);
        const currentValue = pick('currentValue', String(10000 + i * 5000));
        const targetRatio = pick('targetRatio', String(defaultRatios[i] / 100));
        const buyFeeRate = pick('buyFeeRate', '0.50');
        const sellFeeRate = pick('sellFeeRate', '0');
        const currentPrice = pick('currentPrice', (1 + i * 0.5).toFixed(4));

        saveArr.push({ name, currentValue, targetRatio, buyFeeRate, sellFeeRate, currentPrice });

        const div = document.createElement('div');
        div.className = 'asset-item';
        div.innerHTML = `
            <h4 style="margin:0 0 8px 0;">第 ${i + 1} 类资产</h4>
            <label>资产名称：</label><input type="text" class="assetName" value="${esc(name)}">
            <label>当前市值（元）：</label><input type="number" class="currentValue" min="0" step="0.01" value="${esc(currentValue)}">
            <label>目标配置比例（%）：</label><input type="number" class="targetRatio" min="0" max="100" step="0.01" value="${esc(targetRatio)}">
            <label>买入手续费率（%）：</label><input type="number" class="buyFeeRate" min="0" step="0.01" value="${esc(buyFeeRate)}">
            <label>卖出费率（%）：</label><input type="number" class="sellFeeRate" min="0" step="0.01" value="${esc(sellFeeRate)}">
            <label>当前价格（元/份）：</label><input type="number" class="currentPrice" min="0.0001" step="0.0001" value="${esc(currentPrice)}">
            <div class="tip">费率填百分数：0.50 表示 0.50%。卖出费率多数情况下填 0，卖出不收费就留 0。</div>
        `;
        container.appendChild(div);
    }

    saveDataToStorage(saveArr);

    // 改了任何一格就顺手存一下，下次打开还是这些值
    document.querySelectorAll('.asset-item input').forEach((inp) => {
        inp.addEventListener('input', () => saveDataFromDom());
    });
}

// 重新生成输入时，保留当前已填的全部数值
function regenerateAssets() {
    createAssetInputs(collectAssetsFromDom());
}

function collectAssetsFromDom() {
    return Array.from(document.querySelectorAll('.asset-item')).map((item, idx) => ({
        name: item.querySelector('.assetName').value.trim() || `资产${idx + 1}`,
        currentValue: item.querySelector('.currentValue').value,
        targetRatio: item.querySelector('.targetRatio').value,
        buyFeeRate: item.querySelector('.buyFeeRate').value,
        sellFeeRate: item.querySelector('.sellFeeRate').value,
        currentPrice: item.querySelector('.currentPrice').value,
    }));
}

function saveDataFromDom() {
    saveDataToStorage(collectAssetsFromDom());
}

function saveDataToStorage(assets) {
    const normalized = assets.map(a => ({
        name: String(a.name || ''),
        currentValue: String(a.currentValue == null ? '' : a.currentValue),
        targetRatio: String(a.targetRatio == null ? '' : a.targetRatio),
        buyFeeRate: String(a.buyFeeRate == null ? '0' : a.buyFeeRate),
        sellFeeRate: String(a.sellFeeRate == null ? '0' : a.sellFeeRate),
        currentPrice: String(a.currentPrice == null ? '' : a.currentPrice),
    }));
    safeStorage.set(STORAGE_KEY, JSON.stringify({ assetCount: normalized.length, assets: normalized }));
}

function loadStoredData() {
    try {
        const raw = safeStorage.get(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed.assetCount) {
            document.getElementById('assetCount').value = parsed.assetCount;
        }
        createAssetInputs(parsed.assets);
    } catch (e) {
        console.error('加载本地存储失败：', e);
    }
}

function clearStoredData() {
    if (confirm('确定清空所有保存数据？')) {
        safeStorage.remove(STORAGE_KEY);
        location.reload();
    }
}

/* 把界面上的输入交给 core.js 校验并转成整数。
 * 界面的字段名是给人看的（currentValue / targetRatio / buyFeeRate），
 * core.js 的字段名是给公式用的（current / ratioPct / buyFeePct），这里做一次翻译。
 */
function readAssetsFromDom() {
    const mapped = collectAssetsFromDom().map(a => ({
        name: a.name,
        current: a.currentValue,
        ratioPct: a.targetRatio,
        buyFeePct: a.buyFeeRate,
        sellFeePct: a.sellFeeRate,
        price: a.currentPrice,
    }));
    return Core.readAssets(mapped);
}

function calculateRebalance() {
    const items = document.querySelectorAll('.asset-item');
    if (!items || items.length === 0) return alert('请先生成资产输入项');

    const parsed = readAssetsFromDom();
    if (!parsed.ok) return alert(parsed.error);

    const result = Core.computeRebalance(parsed.assets);
    if (!result.ok) return alert(result.error);

    rebalanceResults = result.rows;
    convertResults = Core.generateConvertPlan(rebalanceResults);
    renderRebalanceResult(result.totalCents);
    renderConvertPlan();
}

function renderRebalanceResult(totalCents) {
    document.getElementById('totalAsset').innerHTML =
        `总资产　<strong>${fmtMoney(totalCents / 100)} 元</strong>`;

    /* 列定义只写一遍：桌面端的表头、手机卡片的每一行标签（data-label）、
     * 单元格内容都从这张表生成，避免三处各写一份、改了这里忘了那里。
     * dashWhenIdle = 这一列在「无操作」时显示破折号，不留 0.00。
     */
    const cols = [
        { title: '资产名称', text: r => esc(r.name) },
        { title: '当前市值(元)', text: r => fmtMoney(r.current) },
        { title: '目标市值(元)', text: r => fmtMoney(r.target) },
        { title: '操作', text: r => r.action, tone: true },
        { title: '交易金额(元)', text: r => fmtMoney(r.amount), tone: true, dashWhenIdle: true },
        { title: '手续费(元)', text: r => fmtMoney(r.fee), dashWhenIdle: true },
        { title: '实际现金流(元)', text: r => fmtMoney(r.cash), tone: true, dashWhenIdle: true },
        { title: '份额(份)', text: r => esc(r.shares) },
    ];

    let html = '<tr class="head-row">' + cols.map(c => `<th>${c.title}</th>`).join('') + '</tr>';

    rebalanceResults.forEach(r => {
        const cls = r.action === '卖出' ? 'sell' : (r.action === '买入' ? 'buy' : '');
        const idle = r.action === '无';
        html += '<tr>' + cols.map(c => {
            const value = (c.dashWhenIdle && idle) ? '—' : c.text(r);
            const klass = c.tone ? ` class="${cls}"` : '';
            return `<td data-label="${c.title}"${klass}>${value}</td>`;
        }).join('') + '</tr>';
    });
    document.getElementById('resultTable').innerHTML = html;

    // 一句话总结：钱够不够
    const sellCash = rebalanceResults.filter(r => r.action === '卖出').reduce((s, r) => s + r.cashCents, 0);
    const buyCash = rebalanceResults.filter(r => r.action === '买入').reduce((s, r) => s + r.cashCents, 0);
    const gap = buyCash - sellCash;
    const summary = gap > 0
        ? `卖出到账 ${fmtMoney(sellCash / 100)} 元，买入需掏 ${fmtMoney(buyCash / 100)} 元，<span style="color:var(--red);font-weight:600;">还差 ${fmtMoney(gap / 100)} 元需要额外投入</span>`
        : gap < 0
            ? `卖出到账 ${fmtMoney(sellCash / 100)} 元，买入需掏 ${fmtMoney(buyCash / 100)} 元，<span style="color:var(--green);font-weight:600;">富余 ${fmtMoney(-gap / 100)} 元可留在手上</span>`
            : `卖出到账与买入支出正好相等：${fmtMoney(sellCash / 100)} 元，不用额外掏钱`;
    document.getElementById('cashSummary').innerHTML = summary;

    document.getElementById('resultArea').style.display = 'block';
}

function renderConvertPlan() {
    const cols = [
        { title: '卖出资产', text: r => esc(r['卖出资产']) },
        { title: '卖出金额(元)', text: r => fmtMoney(r['卖出金额(元)']) },
        { title: '卖出份额(份)', text: r => esc(r['卖出份额(份)']), style: 'color:var(--red);font-weight:600;' },
        { title: '买入资产', text: r => esc(r['买入资产']) },
        { title: '买入金额(元)', text: r => fmtMoney(r['买入金额(元)']) },
        { title: '转换状态', text: r => esc(r['转换状态']), status: true },
    ];

    let html = '<tr class="head-row">' + cols.map(c => `<th>${c.title}</th>`).join('') + '</tr>';
    convertResults.forEach(r => {
        const statusColor = r['转换状态'] === '需额外注入资金' ? 'color:var(--red);font-weight:600;' :
                            r['转换状态'] === '内部资金匹配' ? 'color:var(--green);font-weight:600;' :
                            'color:var(--ink-faint);font-weight:600;';
        html += '<tr>' + cols.map(c => {
            const style = c.status ? statusColor : (c.style || '');
            return `<td data-label="${c.title}"${style ? ` style="${style}"` : ''}>${c.text(r)}</td>`;
        }).join('') + '</tr>';
    });
    document.getElementById('convertTable').innerHTML = html;
    document.getElementById('convertArea').style.display = 'block';
}

/* 把工作簿交到用户手上。两种环境走完全不同的路：
 *
 * 网页版：XLSX.writeFile 走 Blob + 合成一个 <a download> 点击，浏览器正常下载。
 * APK 里：这条路是死的（2026-11-03 真机实测：点了没有任何反应）。
 *   原因是 Capacitor 的 WebViewClient 没有实现下载监听，Blob 下载没人接。
 *   所以改成：写进应用缓存目录 → 调系统分享面板，用户自己选「保存到文件」
 *   或者直接发到微信。文件落在 getCacheDir()（Directory.Cache = 'CACHE'），
 *   res/xml/file_paths.xml 里的 <cache-path path="." /> 已经放行，分享不需要任何权限。
 */
async function saveWorkbook(wb, filename) {
    if (!isNativeApp()) {
        XLSX.writeFile(wb, filename);
        return;
    }
    const data = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
    await handOffNative(data, filename, '保存或发送 Excel', '无法导出 Excel');
}

/* APK 里把一段 base64 写进缓存目录，再交到系统分享面板。Excel 和备份文件共用。 */
async function handOffNative(base64, filename, dialogTitle, failMessage) {
    const Plugins = window.Capacitor.Plugins || {};
    if (!Plugins.Filesystem || !Plugins.Share) {
        return alert(`导出组件未加载，${failMessage}`);
    }
    try {
        const { uri } = await Plugins.Filesystem.writeFile({ path: filename, data: base64, directory: 'CACHE' });
        await Plugins.Share.share({ title: filename, url: uri, dialogTitle });
    } catch (e) {
        // 用户在分享面板点「取消」也会走到这里，那不是错误，别再弹一次吓人
        const msg = String((e && e.message) || e || '');
        if (!/cancel/i.test(msg)) alert(`${failMessage}：` + msg);
    }
}

/* ---- 备份与恢复 ----
 * 数据只在本机 localStorage，换手机就丢。导 Excel 只能带走计算结果，
 * 带不回录入的数据，所以单独做一个 .json 备份（格式见 backup.js）。
 */
function todayStamp() {
    return new Date().toISOString().slice(0, 10);
}

// 中文要按 UTF-8 转成 base64，Capacitor Filesystem 写文件只认 base64
function toBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    const CHUNK = 0x8000;   // 一次太多参数会爆栈
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function downloadFile(text, filename, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBackup() {
    if (typeof Backup === 'undefined') return alert('备份组件未加载，无法备份。');
    const assets = collectAssetsFromDom();
    if (assets.length === 0) return alert('还没有可备份的数据。');
    const text = JSON.stringify(Backup.build({ assets }), null, 2);
    const filename = `再平衡备份_${todayStamp()}.json`;
    if (isNativeApp()) {
        handOffNative(toBase64Utf8(text), filename, '保存或发送备份文件', '无法备份');
    } else {
        downloadFile(text, filename, 'application/json');
    }
}

function pickBackupFile() {
    const input = document.getElementById('backupFileInput');
    if (input) input.click();
}

function readFileText(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error || new Error('读取失败'));
        fr.readAsText(file, 'utf-8');
    });
}

async function importBackupFromInput(input) {
    if (typeof Backup === 'undefined') return alert('备份组件未加载，无法恢复。');
    const file = input && input.files && input.files[0];
    if (!file) return;

    let text;
    try {
        text = await readFileText(file);
    } catch (e) {
        input.value = '';
        return alert('恢复失败：文件读不出来。');
    }
    input.value = '';   // 清掉，才能再次选同一个文件

    const parsed = Backup.parse(text);
    if (!parsed.ok) return alert('恢复失败：' + parsed.error);
    if (!confirm(`确定用这份备份覆盖当前数据吗？\n备份里有 ${parsed.assetCount} 个资产。`)) return;

    safeStorage.set(STORAGE_KEY, JSON.stringify({ assetCount: parsed.assetCount, assets: parsed.assets }));
    document.getElementById('assetCount').value = parsed.assetCount;
    createAssetInputs(parsed.assets);

    // 界面上旧的计算结果是上一份数据的，留着会误导
    document.getElementById('resultArea').style.display = 'none';
    document.getElementById('convertArea').style.display = 'none';

    alert(`已恢复 ${parsed.assetCount} 个资产。核对无误后点「开始计算」。`);
}

function exportExcel(type) {
    if (typeof XLSX === 'undefined') return alert('Excel 库未加载');
    if (type === 'rebalance') {
        const data = rebalanceResults.map(r => ({
            '资产名称': r.name,
            '当前市值(元)': r.current,
            '目标市值(元)': r.target,
            '操作': r.action,
            '交易金额(元)': r.amount,
            '手续费(元)': r.fee,
            '实际现金流(元)': r.cash,
            '份额(份)': r.shares,
            '当前价格(元/份)': r.price,
            '买入费率(%)': r.buyFeePct,
            '卖出费率(%)': r.sellFeePct,
        }));
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, '再平衡结果');
        saveWorkbook(wb, `再平衡结果_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } else {
        const data = convertResults.map(r => ({
            '卖出资产': r['卖出资产'],
            '卖出金额(元)': r['卖出金额(元)'],
            '卖出份额(份)': r['卖出份额(份)'],
            '买入资产': r['买入资产'],
            '买入金额(元)': r['买入金额(元)'],
            '转换状态': r['转换状态'],
        }));
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, '转换方案');
        saveWorkbook(wb, `转换方案_${new Date().toISOString().slice(0, 10)}.xlsx`);
    }
}
