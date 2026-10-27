/* 特征测试（characterization tests）
 *
 * 目的：把「现在的正确行为」逐条钉死。
 * 这些数字是从改造前的 index.html 里跑出来的原值——只要它们还在，
 * 说明抽 core.js 这一步没有改变任何计算结果。
 *
 * 之后改数字模型（整数分、基点、最大余数法）时，
 * 凡是行为**应该变**的地方，会单独写在 core.defects.test.js 里，
 * 这个文件只锁「不许变」的部分。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

/* ---------------- 输入整理 ---------------- */

test('parseAsset：名字留空时用「资产N」补位', () => {
    assert.equal(Core.parseAsset({ name: '  ', current: 1, ratioPct: 1, feePct: 0, price: 1 }, 2).name, '资产3');
    assert.equal(Core.parseAsset({ name: ' 现金 ', current: 1, ratioPct: 1, feePct: 0, price: 1 }, 0).name, '现金');
});

test('parseAsset：当前市值填不出来时当作 0', () => {
    assert.equal(Core.parseAsset({ name: 'A', current: '', ratioPct: 1, feePct: 0, price: 1 }, 0).current, 0);
    assert.equal(Core.parseAsset({ name: 'A', current: 'abc', ratioPct: 1, feePct: 0, price: 1 }, 0).current, 0);
    assert.equal(Core.parseAsset({ name: 'A', current: '1234.56', ratioPct: 1, feePct: 0, price: 1 }, 0).current, 1234.56);
});

test('parseAsset：买入费率填不出来时当作 0', () => {
    assert.equal(Core.parseAsset({ name: 'A', current: 1, ratioPct: 1, feePct: '', price: 1 }, 0).feePct, 0);
    assert.equal(Core.parseAsset({ name: 'A', current: 1, ratioPct: 1, feePct: '0.5', price: 1 }, 0).feePct, 0.5);
});

test('parseAsset：价格保留 4 位小数，超出部分四舍五入', () => {
    assert.equal(Core.parseAsset({ name: 'A', current: 1, ratioPct: 1, feePct: 0, price: '1.23456' }, 0).price, 1.2346);
    assert.equal(Core.parseAsset({ name: 'A', current: 1, ratioPct: 1, feePct: 0, price: '2' }, 0).price, 2);
});

test('parseAsset：比例填不出来时保留 NaN（这样总和校验才拦得住）', () => {
    assert.ok(Number.isNaN(Core.parseAsset({ name: 'A', current: 1, ratioPct: '', feePct: 0, price: 1 }, 0).ratioPct));
});

/* ---------------- 主计算 ---------------- */

const TWO_WAY = [
    { name: 'A', current: 242992.69, ratioPct: 50, feePct: 0, price: 1.2345 },
    { name: 'B', current: 688939.38, ratioPct: 50, feePct: 0, price: 2.3456 },
];

const THREE_WAY = [
    { name: 'A', current: 10000, ratioPct: 33, feePct: 0.5, price: 1.5 },
    { name: 'B', current: 20000, ratioPct: 34, feePct: 0, price: 2.5 },
    { name: 'C', current: 30000, ratioPct: 33, feePct: 1, price: 3.5 },
];

test('五五开：总资产、目标市值、买卖方向与金额', () => {
    const r = Core.computeRebalance(TWO_WAY);
    assert.equal(r.ok, true);
    assert.equal(r.totalAsset, 931932.0700000001); // 浮点求和的真实结果，改造时会变成整数分

    const [a, b] = r.rows;
    assert.deepEqual(
        { name: a.name, current: a.current, target: a.target, action: a.action, amount: a.amount, shares: a.shares },
        { name: 'A', current: 242992.69, target: 465966.04, action: '买入', amount: 222973.35, shares: '180618.34' }
    );
    assert.deepEqual(
        { name: b.name, current: b.current, target: b.target, action: b.action, amount: b.amount, shares: b.shares },
        { name: 'B', current: 688939.38, target: 465966.04, action: '卖出', amount: 222973.34, shares: '95060.26' }
    );
});

test('三资产：买入金额含手续费，卖出金额等于差额', () => {
    const r = Core.computeRebalance(THREE_WAY);
    assert.equal(r.totalAsset, 60000);

    const byName = Object.fromEntries(r.rows.map(x => [x.name, x]));
    // A：净买 9800，费率 0.5% → 实际掏 9849
    assert.equal(byName.A.action, '买入');
    assert.equal(byName.A.target, 19800);
    assert.equal(byName.A.amount, 9849);
    assert.equal(byName.A.shares, '6533.33'); // 份额按净买额算，不含费
    // B：净买 400，费率 0 → 400
    assert.equal(byName.B.action, '买入');
    assert.equal(byName.B.amount, 400);
    // C：卖出 10200
    assert.equal(byName.C.action, '卖出');
    assert.equal(byName.C.amount, 10200);
});

test('每行保留四位价格与两位费率的字符串形式（导出 Excel 靠它）', () => {
    const r = Core.computeRebalance(THREE_WAY);
    assert.equal(r.rows[0].price, '1.5000');
    assert.equal(r.rows[0].feePct, '0.50');
});

test('目标比例合计不是 100% 时拒绝计算，并报出实际合计', () => {
    const r = Core.computeRebalance([
        { name: 'A', current: 10000, ratioPct: 33, feePct: 0.5, price: 1 },
        { name: 'B', current: 15000, ratioPct: 33, feePct: 0.5, price: 1.5 },
        { name: 'C', current: 20000, ratioPct: 33, feePct: 0.5, price: 2 },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.error, '目标配置比例之和=99.00%，应为100%');
});

test('比例合计在 ±0.1 以内算通过（旧容差，保持不动）', () => {
    assert.equal(Core.computeRebalance([{ name: 'A', current: 100, ratioPct: 100.1, feePct: 0, price: 10 }]).ok, true);
    assert.equal(Core.computeRebalance([{ name: 'A', current: 100, ratioPct: 100.2, feePct: 0, price: 10 }]).ok, false);
});

test('总资产为 0 时拒绝计算', () => {
    const r = Core.computeRebalance([{ name: 'A', current: 0, ratioPct: 100, feePct: 0, price: 1 }]);
    assert.equal(r.ok, false);
    assert.equal(r.error, '总资产为0');
});

test('偏差不超过 1 分钱时不动（显示为「无」）', () => {
    const r = Core.computeRebalance([
        { name: 'A', current: 100, ratioPct: 50, feePct: 0, price: 10 },
        { name: 'B', current: 100.01, ratioPct: 50, feePct: 0, price: 10 },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.rows[0].action, '无');
    assert.equal(r.rows[1].action, '无');
});

/* ---------------- 转换规划 ---------------- */

test('转换规划：卖家按顺序喂饱买家，每行 6 列', () => {
    const r = Core.computeRebalance(THREE_WAY);
    const plan = Core.generateConvertPlan(r.rows, THREE_WAY);

    assert.equal(plan.length, 3);
    assert.deepEqual(plan[0], {
        '卖出资产': 'C', '卖出金额(元)': 9849, '卖出份额(份)': '2814.00',
        '买入资产': 'A', '买入金额(元)': 9849, '转换状态': '内部资金匹配',
    });
    assert.deepEqual(plan[1], {
        '卖出资产': 'C', '卖出金额(元)': 351, '卖出份额(份)': '100.29',
        '买入资产': 'B', '买入金额(元)': 351, '转换状态': '内部资金匹配',
    });
    // 卖的钱不够覆盖手续费 → 差额要另外掏
    assert.deepEqual(plan[2], {
        '卖出资产': '外部资金', '卖出金额(元)': 49, '卖出份额(份)': '—',
        '买入资产': 'B', '买入金额(元)': 49, '转换状态': '需额外注入资金',
    });
});

test('转换规划：没人卖也没人买时给出「无需转换」一行', () => {
    const rows = [
        { name: 'A', current: 100, action: '无', amount: 0, price: '10.0000' },
        { name: 'B', current: 100, action: '无', amount: 0, price: '10.0000' },
    ];
    const plan = Core.generateConvertPlan(rows, []);
    assert.deepEqual(plan, [{
        '卖出资产': '无', '卖出金额(元)': 0, '卖出份额(份)': '—',
        '买入资产': '无', '买入金额(元)': 0, '转换状态': '无需转换',
    }]);
});

test('转换规划：只卖不买时，全部记为剩余卖出资金', () => {
    const rows = [{ name: 'A', current: 200, action: '卖出', amount: 100, price: '10.0000' }];
    const plan = Core.generateConvertPlan(rows, rows);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]['转换状态'], '剩余卖出资金（可提现/备用）');
    assert.equal(plan[0]['卖出金额(元)'], 100);
    assert.equal(plan[0]['卖出份额(份)'], '10.00');
});

test('转换规划：只买不卖时，全部记为需额外注入资金', () => {
    const rows = [{ name: 'A', current: 100, action: '买入', amount: 510, price: '5.0000' }];
    const assets = [{ name: 'A', feePct: 2 }];
    const plan = Core.generateConvertPlan(rows, assets);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]['转换状态'], '需额外注入资金');
    assert.equal(plan[0]['卖出资产'], '外部资金');
    assert.equal(plan[0]['买入金额(元)'], 510);
});
