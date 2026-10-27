/* app.js —— 界面层。只管读写页面、存本地、导 Excel。
 *
 * 所有算数都在 core.js 里，这里一律调 Core.xxx，
 * 不许自己再写一遍公式——两份实现迟早会跑偏。
 */
const STORAGE_KEY = 'assetRebalanceData_v1';
let rebalanceResults = [];
let convertResults = [];

const fmtMoney = x => Number(x).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

window.onload = function () {
    if (typeof XLSX === 'undefined') {
        alert('Excel 导出库加载失败');
    }
    loadStoredData();
    const container = document.getElementById('assetInputs');
    if (!container || container.innerHTML.trim() === '') createAssetInputs();
};

function createAssetInputs(savedAssets) {
    const count = parseInt(document.getElementById('assetCount').value) || 1;
    const container = document.getElementById('assetInputs');
    container.innerHTML = '';
    const saveArr = [];

    for (let i = 0; i < count; i++) {
        const saved = savedAssets && savedAssets[i] ? savedAssets[i] : null;
        const name = saved ? saved.name : `资产${i + 1}`;
        const buyFeeRate = saved && typeof saved.buyFeeRate !== 'undefined' ? Number(saved.buyFeeRate) : 0.50;
        const targetRatio = saved && typeof saved.targetRatio !== 'undefined' ? Number(saved.targetRatio) : Math.max(0, Math.round(100 / count));
        const currentValue = 10000 + i * 5000;
        const currentPrice = parseFloat((1 + i * 0.5).toFixed(4));

        saveArr.push({ name, targetRatio, buyFeeRate });

        const div = document.createElement('div');
        div.className = 'asset-item';
        div.innerHTML = `
            <h4 style="margin:0 0 8px 0;">第 ${i + 1} 类资产</h4>
            <label>资产名称：</label><input type="text" class="assetName" value="${name}">
            <label>当前市值（元）：</label><input type="number" class="currentValue" min="0" step="0.01" value="${currentValue}">
            <label>目标配置比例（%）：</label><input type="number" class="targetRatio" min="0" max="100" step="0.1" value="${targetRatio}">
            <label>买入手续费率（%）：</label><input type="number" class="buyFeeRate" min="0" step="0.01" value="${buyFeeRate.toFixed(2)}">
            <label>当前价格（元/份）：</label><input type="number" class="currentPrice" min="0.0001" step="0.0001" value="${currentPrice}">
            <div class="tip">注意：这里显示为百分比（例如输入 0.50 表示 0.50%），保存时会以数字形式完整保存。</div>
        `;
        container.appendChild(div);
    }

    saveDataToStorage(saveArr);

    document.querySelectorAll('.asset-item').forEach((item) => {
        const nameInp = item.querySelector('.assetName');
        const ratioInp = item.querySelector('.targetRatio');
        const feeInp = item.querySelector('.buyFeeRate');

        const handleSave = () => {
            const assets = Array.from(document.querySelectorAll('.asset-item')).map((it, j) => {
                const n = it.querySelector('.assetName').value.trim() || `资产${j + 1}`;
                const r = parseFloat(it.querySelector('.targetRatio').value);
                const f = parseFloat(it.querySelector('.buyFeeRate').value);
                return { name: n, targetRatio: isNaN(r) ? 0 : r, buyFeeRate: isNaN(f) ? 0 : f };
            });
            saveDataToStorage(assets);
        };

        nameInp.addEventListener('input', handleSave);
        ratioInp.addEventListener('input', handleSave);
        feeInp.addEventListener('input', handleSave);
    });
}

// 重新生成输入时，保留当前已填的名称/比例/费率
function regenerateAssets() {
    const items = Array.from(document.querySelectorAll('.asset-item')).map((it, j) => ({
        name: it.querySelector('.assetName').value.trim() || `资产${j + 1}`,
        targetRatio: parseFloat(it.querySelector('.targetRatio').value),
        buyFeeRate: parseFloat(it.querySelector('.buyFeeRate').value),
    }));
    createAssetInputs(items);
}

function saveDataToStorage(assets) {
    const normalized = assets.map(a => ({
        name: String(a.name || ''),
        targetRatio: Number(isNaN(a.targetRatio) ? 0 : a.targetRatio),
        buyFeeRate: Number(isNaN(a.buyFeeRate) ? 0 : a.buyFeeRate),
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

/* 把界面上的输入收成一串数字，交给 core.js 算 */
function readAssetsFromDom() {
    const items = document.querySelectorAll('.asset-item');
    return Array.from(items).map((item, idx) => Core.parseAsset({
        name: item.querySelector('.assetName').value,
        current: item.querySelector('.currentValue').value,
        ratioPct: item.querySelector('.targetRatio').value,
        feePct: item.querySelector('.buyFeeRate').value,
        price: item.querySelector('.currentPrice').value,
    }, idx));
}

function calculateRebalance() {
    const items = document.querySelectorAll('.asset-item');
    if (!items || items.length === 0) return alert('请先生成资产输入项');

    const assets = readAssetsFromDom();
    const result = Core.computeRebalance(assets);
    if (!result.ok) return alert(result.error);

    rebalanceResults = result.rows;
    convertResults = Core.generateConvertPlan(rebalanceResults, assets);
    renderRebalanceResult(result.totalAsset);
    renderConvertPlan();
}

function renderRebalanceResult(totalAsset) {
    document.getElementById('totalAsset').innerHTML =
        `总资产　<strong>${fmtMoney(totalAsset)} 元</strong>`;
    const headers = ['资产名称', '当前市值(元)', '目标市值(元)', '买入手续费率(%)', '当前价格(元/份)', '操作类型', '操作金额(元)', '份额(份)'];
    let html = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
    rebalanceResults.forEach(r => {
        const actionClass = r.action === '卖出' ? 'sell' : (r.action === '买入' ? 'buy' : '');
        const amountDisplay = r.action === '无' ? '—' : fmtMoney(r.amount);
        html += `<tr>
            <td>${r.name}</td>
            <td>${fmtMoney(r.current)}</td>
            <td>${fmtMoney(r.target)}</td>
            <td>${r.feePct}</td>
            <td>${r.price}</td>
            <td class="${actionClass}">${r.action}</td>
            <td class="${actionClass}">${amountDisplay}</td>
            <td>${r.shares}</td>
        </tr>`;
    });
    document.getElementById('resultTable').innerHTML = html;
    document.getElementById('resultArea').style.display = 'block';
}

function renderConvertPlan() {
    const headers = ['卖出资产', '卖出金额(元)', '卖出份额(份)', '买入资产', '买入金额(元)', '转换状态'];
    let html = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
    convertResults.forEach(r => {
        const statusColor = r['转换状态'] === '需额外注入资金' ? 'color:var(--red);' :
                            r['转换状态'] === '内部资金匹配' ? 'color:var(--green);' : 'color:var(--ink-faint);';
        html += `<tr>
            <td>${r['卖出资产']}</td>
            <td>${fmtMoney(r['卖出金额(元)'])}</td>
            <td style="color:var(--red);font-weight:600;">${r['卖出份额(份)']}</td>
            <td>${r['买入资产']}</td>
            <td>${fmtMoney(r['买入金额(元)'])}</td>
            <td style="${statusColor}font-weight:600;">${r['转换状态']}</td>
        </tr>`;
    });
    document.getElementById('convertTable').innerHTML = html;
    document.getElementById('convertArea').style.display = 'block';
}

function exportExcel(type) {
    if (typeof XLSX === 'undefined') return alert('Excel 库未加载');
    if (type === 'rebalance') {
        const data = rebalanceResults.map(r => ({
            '资产名称': r.name,
            '当前市值(元)': r.current,
            '目标市值(元)': r.target,
            '买入手续费率(%)': r.feePct,
            '当前价格(元/份)': r.price,
            '操作类型': r.action,
            '操作金额(元)': r.amount,
            '份额(份)': r.shares,
        }));
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, '再平衡结果');
        XLSX.writeFile(wb, `再平衡结果_${new Date().toISOString().slice(0, 10)}.xlsx`);
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
        XLSX.writeFile(wb, `转换方案_${new Date().toISOString().slice(0, 10)}.xlsx`);
    }
}
