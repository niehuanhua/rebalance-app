/* 缺陷测试 —— 每一条对应一个已知问题，或者一条定好的产品语义。
 * 先写测试（红），再改代码（绿）。
 *
 * 数字模型：
 *   金额一律整数「分」      currentCents / netCents / feeCents / cashCents
 *   比例一律整数「基点」    ratioBp / buyFeeBp / sellFeeBp（100% = 10000bp）
 *   价格一律整数「万分之一元」priceUnit（1.2345 元 → 12345）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

/* ---------------- 小数解析：不许有浮点误差 ---------------- */

test('元和分的换算：10.075 元是 1008 分（旧 round2 给的是 10.07）', () => {
    assert.equal(Core.parseScaledInt('10.075', 100), 1008);
    assert.equal(Core.parseScaledInt('10000.005', 100), 1000001);
    assert.equal(Core.parseScaledInt('0.1', 100), 10);
    assert.equal(Core.parseScaledInt('.5', 100), 50);
    assert.equal(Core.parseScaledInt('12.', 100), 1200);
    assert.equal(Core.parseScaledInt('-5', 100), -500);
});

test('解析不了的输入返回 null，而不是悄悄变成 0', () => {
    assert.equal(Core.parseScaledInt('', 100), null);
    assert.equal(Core.parseScaledInt('  ', 100), null);
    assert.equal(Core.parseScaledInt('abc', 100), null);
    assert.equal(Core.parseScaledInt('1e3', 100), null);
    assert.equal(Core.parseScaledInt(null, 100), null);
    assert.equal(Core.parseScaledInt(undefined, 100), null);
});

test('价格保留 4 位：1.23456 → 12346（万分之一元）', () => {
    assert.equal(Core.parseScaledInt('1.23456', 10000), 12346);
    assert.equal(Core.parseScaledInt('0.0001', 10000), 1);
});

/* ---------------- 默认比例 ---------------- */

test('默认比例：3 个资产是 34/33/33，合计正好 100%（原来是 99%）', () => {
    const bp = Core.defaultRatioBp(3);
    assert.deepEqual(bp, [3400, 3300, 3300]);
    assert.equal(bp.reduce((a, b) => a + b, 0), 10000);
});

test('默认比例：任何资产数合计都是 100%', () => {
    for (let n = 1; n <= 20; n++) {
        const bp = Core.defaultRatioBp(n);
        assert.equal(bp.length, n);
        assert.equal(bp.reduce((a, b) => a + b, 0), 10000, `${n} 个资产合计不是 100%`);
        assert.ok(bp.every(x => Number.isInteger(x) && x >= 0), `${n} 个资产出现了非整数或负数`);
    }
});

/* ---------------- 输入校验 ---------------- */

const raw = (o) => Object.assign(
    { name: 'A', current: '10000', ratioPct: '50', buyFeePct: '0', sellFeePct: '0', price: '10' }, o);

test('比例留空要报错，不能说「合计 99.5%」这种误导话', () => {
    const r = Core.readAssets([
        raw({ name: 'A', ratioPct: '100' }),
        raw({ name: 'B', ratioPct: '' }),
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error, /第 2 行.*比例/);
});

test('价格填 0 要报错，不能偷偷当成 0.0001', () => {
    const r = Core.readAssets([raw({ price: '0' })]);
    assert.equal(r.ok, false);
    assert.match(r.error, /第 1 行.*价格/);
});

test('负价格要报错（原来会算出负份额）', () => {
    const r = Core.readAssets([raw({ price: '-5' })]);
    assert.equal(r.ok, false);
    assert.match(r.error, /第 1 行.*价格/);
});

test('负市值要报错', () => {
    const r = Core.readAssets([raw({ current: '-100' })]);
    assert.equal(r.ok, false);
    assert.match(r.error, /第 1 行.*市值/);
});

test('负费率要报错', () => {
    assert.equal(Core.readAssets([raw({ buyFeePct: '-1' })]).ok, false);
    assert.equal(Core.readAssets([raw({ sellFeePct: '-1' })]).ok, false);
});

test('市值留空当作 0（沿用旧行为，不报错）', () => {
    const r = Core.readAssets([raw({ current: '' }), raw({ name: 'B' })]);
    assert.equal(r.ok, true);
    assert.equal(r.assets[0].currentCents, 0);
});

/* ---------------- 金额守恒 ---------------- */

const TWO_WAY = [
    raw({ name: 'A', current: '242992.69', ratioPct: '50', price: '1.2345' }),
    raw({ name: 'B', current: '688939.38', ratioPct: '50', price: '2.3456' }),
];

test('五五开：卖出与买入金额完全相等，不再凭空多出 0.01 元缺口', () => {
    const { assets } = Core.readAssets(TWO_WAY);
    const r = Core.computeRebalance(assets);
    assert.equal(r.ok, true);

    const sell = r.rows.find(x => x.action === '卖出');
    const buy = r.rows.find(x => x.action === '买入');
    assert.equal(sell.amountCents, 22297335);
    assert.equal(buy.amountCents, 22297335);
    assert.equal(sell.cashCents, buy.cashCents);

    const plan = Core.generateConvertPlan(r.rows);
    assert.equal(plan.some(x => x['转换状态'] === '需额外注入资金'), false, '不该出现需额外注资');
    assert.equal(plan.some(x => x['转换状态'] === '剩余卖出资金（可提现/备用）'), false, '不该出现剩余资金');
});

test('目标市值相加正好等于总资产，一分不差', () => {
    const { assets } = Core.readAssets(TWO_WAY);
    const r = Core.computeRebalance(assets);
    const sum = r.rows.reduce((s, x) => s + x.targetCents, 0);
    assert.equal(sum, r.totalCents);
    assert.equal(r.rows.reduce((s, x) => s + x.diffCents, 0), 0);
});

test('三个资产 34/33/33：目标市值合计仍然不差分', () => {
    const { assets } = Core.readAssets([
        raw({ name: 'A', current: '10001.01', ratioPct: '34' }),
        raw({ name: 'B', current: '20002.02', ratioPct: '33' }),
        raw({ name: 'C', current: '30003.03', ratioPct: '33' }),
    ]);
    const r = Core.computeRebalance(assets);
    assert.equal(r.rows.reduce((s, x) => s + x.targetCents, 0), r.totalCents);
});

/* ---------------- 手续费语义 ---------------- */

test('买入：交易金额、手续费、实际掏现金 是三个数', () => {
    const { assets } = Core.readAssets([
        raw({ name: 'A', current: '5000', ratioPct: '100', buyFeePct: '0.5', price: '2' }),
        raw({ name: 'B', current: '5000', ratioPct: '0', price: '2' }),
    ]);
    const r = Core.computeRebalance(assets);
    const a = r.rows.find(x => x.name === 'A');
    assert.equal(a.amountCents, 500000);     // 买入 5000.00
    assert.equal(a.feeCents, 2500);          // 手续费 25.00
    assert.equal(a.cashCents, 502500);       // 实际掏 5025.00
    assert.equal(a.cashCents, a.amountCents + a.feeCents);
});

test('卖出：默认不收费，填了费率才扣', () => {
    const zero = Core.computeRebalance(Core.readAssets([
        raw({ name: 'A', current: '20000', ratioPct: '50', sellFeePct: '0' }),
        raw({ name: 'B', current: '0', ratioPct: '50' }),
    ]).assets);
    const s0 = zero.rows.find(x => x.name === 'A');
    assert.equal(s0.amountCents, 1000000);
    assert.equal(s0.feeCents, 0);
    assert.equal(s0.cashCents, 1000000);

    const withFee = Core.computeRebalance(Core.readAssets([
        raw({ name: 'A', current: '20000', ratioPct: '50', sellFeePct: '0.5' }),
        raw({ name: 'B', current: '0', ratioPct: '50' }),
    ]).assets);
    const s1 = withFee.rows.find(x => x.name === 'A');
    assert.equal(s1.amountCents, 1000000);
    assert.equal(s1.feeCents, 5000);
    assert.equal(s1.cashCents, 995000);      // 到账少 50
});

test('份额按毛额算：卖出 10000 元、费率 0.5%，份额仍是 10000/单价', () => {
    const { assets } = Core.readAssets([
        raw({ name: 'A', current: '20000', ratioPct: '50', sellFeePct: '0.5', price: '10' }),
        raw({ name: 'B', current: '0', ratioPct: '50', price: '10' }),
    ]);
    const r = Core.computeRebalance(assets);
    const a = r.rows.find(x => x.name === 'A');
    assert.equal(a.shares, '1000.00');
});

/* ---------------- 转换规划 ---------------- */

test('转换规划按「到手的现金」配对，不按毛额', () => {
    const { assets } = Core.readAssets([
        raw({ name: '卖', current: '20000', ratioPct: '50', sellFeePct: '0.5', price: '10' }),
        raw({ name: '买', current: '0', ratioPct: '50', buyFeePct: '0', price: '10' }),
    ]);
    const r = Core.computeRebalance(assets);
    const plan = Core.generateConvertPlan(r.rows);
    const internal = plan.filter(x => x['转换状态'] === '内部资金匹配');
    assert.equal(internal.length, 1);
    // 卖出 10000 毛额，扣 50 手续费，只有 9950 能拿去用
    assert.equal(internal[0]['卖出金额(元)'], 9950);
    assert.equal(internal[0]['买入金额(元)'], 9950);
    // 这 9950 对应的市值仍然是 10000（份额按毛额算）
    assert.equal(internal[0]['卖出份额(份)'], '1000.00');
    // 差的 50 元要另外掏
    const inject = plan.find(x => x['转换状态'] === '需额外注入资金');
    assert.ok(inject, '应该提示还差 50 元');
    assert.equal(inject['买入金额(元)'], 50);
});
