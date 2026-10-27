/* 特征测试（characterization tests）第二版
 *
 * 第一版锁的是改造前 index.html 的浮点行为，用来证明「抽取 core.js」这一步没改数。
 * 现在数字模型换成了整数分 + 基点 + 最大余数法，第一版里那些浮点原值失去了意义。
 *
 * 这个文件现在锁的是**不应该再变**的东西：
 *   - 输入整理的兜底规则
 *   - 报错文案
 *   - 转换规划的行数与列名（Excel 导出和界面表头都依赖它）
 *
 * 凡是行为**有意改变**的地方，写在 core.defects.test.js 里。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

const raw = (o) => Object.assign(
    { name: 'A', current: '10000', ratioPct: '100', buyFeePct: '0', sellFeePct: '0', price: '10' }, o);

const readOne = (o) => {
    const r = Core.readAssets([raw(o)]);
    assert.equal(r.ok, true, r.error);
    return r.assets[0];
};

/* ---------------- 输入整理 ---------------- */

test('名字留空时用「资产N」补位，前后空格去掉', () => {
    assert.equal(readOne({ name: '  ' }).name, '资产1');
    assert.equal(readOne({ name: ' 现金 ' }).name, '现金');
});

test('当前市值填不出来要报错（不再悄悄当 0）', () => {
    assert.equal(Core.readAssets([raw({ current: 'abc' })]).ok, false);
    // 但完全留空仍然当作 0，沿用旧行为
    assert.equal(readOne({ current: '' }).currentCents, 0);
});

test('费率留空当作 0', () => {
    assert.equal(readOne({ buyFeePct: '' }).buyFeeBp, 0);
    assert.equal(readOne({ sellFeePct: '' }).sellFeeBp, 0);
});

test('价格保留 4 位小数，超出部分四舍五入', () => {
    assert.equal(readOne({ price: '1.23456' }).priceUnit, 12346);
    assert.equal(readOne({ price: '2' }).priceUnit, 20000);
});

test('比例按基点存：50% → 5000bp，33.33% → 3333bp', () => {
    assert.equal(readOne({ ratioPct: '50' }).ratioBp, 5000);
    assert.equal(readOne({ ratioPct: '33.33' }).ratioBp, 3333);
});

/* ---------------- 主计算 ---------------- */

const THREE_WAY = [
    raw({ name: 'A', current: '10000', ratioPct: '33', buyFeePct: '0.5', price: '1.5' }),
    raw({ name: 'B', current: '20000', ratioPct: '34', buyFeePct: '0', price: '2.5' }),
    raw({ name: 'C', current: '30000', ratioPct: '33', buyFeePct: '1', price: '3.5' }),
];

test('三资产：方向、金额、手续费、份额', () => {
    const { assets } = Core.readAssets(THREE_WAY);
    const r = Core.computeRebalance(assets);
    assert.equal(r.ok, true);
    assert.equal(r.totalCents, 6000000);
    assert.equal(r.totalAsset, 60000);

    const byName = Object.fromEntries(r.rows.map(x => [x.name, x]));
    // A：买 9800，费率 0.5% → 手续费 49，实际掏 9849
    assert.equal(byName.A.action, '买入');
    assert.equal(byName.A.targetCents, 1980000);
    assert.equal(byName.A.amountCents, 980000);
    assert.equal(byName.A.feeCents, 4900);
    assert.equal(byName.A.cashCents, 984900);
    assert.equal(byName.A.shares, '6533.33');
    // B：买 400，费率 0
    assert.equal(byName.B.action, '买入');
    assert.equal(byName.B.amountCents, 40000);
    assert.equal(byName.B.cashCents, 40000);
    // C：卖 10200，卖出费率默认 0
    assert.equal(byName.C.action, '卖出');
    assert.equal(byName.C.amountCents, 1020000);
    assert.equal(byName.C.cashCents, 1020000);
    assert.equal(byName.C.shares, '2914.29');
});

test('每行保留四位价格与两位费率的字符串形式（导出 Excel 靠它）', () => {
    const { assets } = Core.readAssets(THREE_WAY);
    const r = Core.computeRebalance(assets);
    assert.equal(r.rows[0].price, '1.5000');
    assert.equal(r.rows[0].buyFeePct, '0.50');
    assert.equal(r.rows[0].sellFeePct, '0.00');
});

test('目标比例合计不是 100% 时拒绝计算，并报出实际合计', () => {
    const { assets } = Core.readAssets([
        raw({ name: 'A', current: '10000', ratioPct: '33' }),
        raw({ name: 'B', current: '15000', ratioPct: '33' }),
        raw({ name: 'C', current: '20000', ratioPct: '33' }),
    ]);
    const r = Core.computeRebalance(assets);
    assert.equal(r.ok, false);
    assert.equal(r.error, '目标配置比例之和=99.00%，应为100%');
});

test('比例合计在 ±0.1% 以内算通过', () => {
    const ok = Core.computeRebalance(Core.readAssets([raw({ ratioPct: '100.1' })]).assets);
    assert.equal(ok.ok, true);
    const bad = Core.computeRebalance(Core.readAssets([raw({ ratioPct: '100.2' })]).assets);
    assert.equal(bad.ok, false);
});

test('总资产为 0 时拒绝计算', () => {
    const { assets } = Core.readAssets([raw({ current: '0', ratioPct: '100' })]);
    const r = Core.computeRebalance(assets);
    assert.equal(r.ok, false);
    assert.equal(r.error, '总资产为0');
});

test('已经平衡时所有行都是「无」，不做无意义的买卖', () => {
    const { assets } = Core.readAssets([
        raw({ name: 'A', current: '100', ratioPct: '50' }),
        raw({ name: 'B', current: '100', ratioPct: '50' }),
    ]);
    const r = Core.computeRebalance(assets);
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows.map(x => x.action), ['无', '无']);
    assert.deepEqual(r.rows.map(x => x.shares), ['-', '-']);
});

/* ---------------- 转换规划 ---------------- */

test('转换规划：卖家按顺序喂饱买家，每行 6 列', () => {
    const { assets } = Core.readAssets(THREE_WAY);
    const r = Core.computeRebalance(assets);
    const plan = Core.generateConvertPlan(r.rows);

    assert.equal(plan.length, 3);
    assert.deepEqual(plan[0], {
        '卖出资产': 'C', '卖出金额(元)': 9849, '卖出份额(份)': '2814.00',
        '买入资产': 'A', '买入金额(元)': 9849, '转换状态': '内部资金匹配',
    });
    assert.deepEqual(plan[1], {
        '卖出资产': 'C', '卖出金额(元)': 351, '卖出份额(份)': '100.29',
        '买入资产': 'B', '买入金额(元)': 351, '转换状态': '内部资金匹配',
    });
    // 卖的钱不够覆盖 A 的手续费 → 差额要另外掏
    assert.deepEqual(plan[2], {
        '卖出资产': '外部资金', '卖出金额(元)': 49, '卖出份额(份)': '—',
        '买入资产': 'B', '买入金额(元)': 49, '转换状态': '需额外注入资金',
    });
});

test('转换规划：没人卖也没人买时给出「无需转换」一行', () => {
    const plan = Core.generateConvertPlan([
        { name: 'A', action: '无' },
        { name: 'B', action: '无' },
    ]);
    assert.deepEqual(plan, [{
        '卖出资产': '无', '卖出金额(元)': 0, '卖出份额(份)': '—',
        '买入资产': '无', '买入金额(元)': 0, '转换状态': '无需转换',
    }]);
});

test('转换规划：只卖不买时，全部记为剩余卖出资金', () => {
    const plan = Core.generateConvertPlan([
        { name: 'A', action: '卖出', cashCents: 10000, sellFeeBp: 0, priceUnit: 100000 },
    ]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]['转换状态'], '剩余卖出资金（可提现/备用）');
    assert.equal(plan[0]['卖出金额(元)'], 100);
    assert.equal(plan[0]['卖出份额(份)'], '10.00');
});

test('转换规划：只买不卖时，全部记为需额外注入资金', () => {
    const plan = Core.generateConvertPlan([
        { name: 'A', action: '买入', cashCents: 51000 },
    ]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]['转换状态'], '需额外注入资金');
    assert.equal(plan[0]['卖出资产'], '外部资金');
    assert.equal(plan[0]['买入金额(元)'], 510);
});
