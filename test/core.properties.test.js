/* 性质测试（property-based）
 *
 * 不指定具体数字，只要求随机生成的输入永远满足几条铁律。
 * 人工挑用例总有漏网之鱼，这几条一跑就是两千组。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

// 固定种子的线性同余发生器：同样的种子永远跑出同样的用例，失败可复现
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1103515245 + 12345) >>> 0;
        return s / 4294967296;
    };
}

function randomCase(rand) {
    const n = 2 + Math.floor(rand() * 5);           // 2~6 个资产
    const fees = ['0', '0', '0.1', '0.15', '0.5', '1', '1.5'];
    const pick = arr => arr[Math.floor(rand() * arr.length)];

    // 先随机分比例，再把零头补到第一个，保证合计正好 100%
    const shares = Array.from({ length: n }, () => Math.floor(rand() * 10000));
    const sum = shares.reduce((a, b) => a + b, 0) || 1;
    const bp = shares.map(x => Math.floor(x * 10000 / sum));
    bp[0] += 10000 - bp.reduce((a, b) => a + b, 0);

    return bp.map((ratioBp, i) => ({
        name: `资产${i + 1}`,
        current: (Math.floor(rand() * 2000000) / 100).toFixed(2),
        ratioPct: (ratioBp / 100).toFixed(2),
        buyFeePct: pick(fees),
        sellFeePct: pick(fees),
        price: (Math.floor(rand() * 500000) / 10000 + 0.0001).toFixed(4),
    }));
}

test('两千组随机输入：目标市值合计不差分、差额合计为 0', () => {
    const rand = rng(20261028);
    let checked = 0;

    for (let k = 0; k < 2000; k++) {
        const { ok, assets, error } = Core.readAssets(randomCase(rand));
        assert.equal(ok, true, error);

        const r = Core.computeRebalance(assets);
        assert.equal(r.ok, true, r.error);

        const targetSum = r.rows.reduce((s, x) => s + x.targetCents, 0);
        assert.equal(targetSum, r.totalCents, `第 ${k} 组：目标市值合计对不上`);

        const diffSum = r.rows.reduce((s, x) => s + x.diffCents, 0);
        assert.equal(diffSum, 0, `第 ${k} 组：差额合计不为 0`);

        // 卖出毛额 == 买入毛额（差额合计为 0），所以现金收支差正好等于两边手续费之和的负数
        const cashSum = r.rows.reduce((s, x) =>
            s + (x.action === '卖出' ? x.cashCents : x.action === '买入' ? -x.cashCents : 0), 0);
        const feeSum = r.rows.reduce((s, x) => s + x.feeCents, 0);
        assert.equal(cashSum + feeSum || 0, 0, `第 ${k} 组：现金收支和手续费对不上`);

        r.rows.forEach(x => {
            assert.ok(Number.isSafeInteger(x.targetCents), `第 ${k} 组：目标市值不是整数分`);
            assert.ok(Number.isSafeInteger(x.cashCents), `第 ${k} 组：现金流不是整数分`);
            if (x.action === '买入') {
                assert.equal(x.cashCents, x.amountCents + x.feeCents);
                assert.ok(!x.shares.startsWith('-'), `第 ${k} 组：买入份额算成了负数`);
            }
            if (x.action === '卖出') {
                assert.equal(x.cashCents, x.amountCents - x.feeCents);
                assert.ok(x.cashCents >= 0);
            }
        });

        checked++;
    }
    assert.equal(checked, 2000);
});

test('两千组随机输入：转换规划能对上账，不会凭空造钱', () => {
    const rand = rng(987654321);

    for (let k = 0; k < 2000; k++) {
        const { assets } = Core.readAssets(randomCase(rand));
        const r = Core.computeRebalance(assets);
        const plan = Core.generateConvertPlan(r.rows);

        const sellCash = r.rows.filter(x => x.action === '卖出').reduce((s, x) => s + x.cashCents, 0);
        const buyCash = r.rows.filter(x => x.action === '买入').reduce((s, x) => s + x.cashCents, 0);

        const matched = plan.filter(p => p['转换状态'] === '内部资金匹配')
            .reduce((s, p) => s + Math.round(p['买入金额(元)'] * 100), 0);
        const inject = plan.filter(p => p['转换状态'] === '需额外注入资金')
            .reduce((s, p) => s + Math.round(p['买入金额(元)'] * 100), 0);
        const leftover = plan.filter(p => p['转换状态'] === '剩余卖出资金（可提现/备用）')
            .reduce((s, p) => s + Math.round(p['卖出金额(元)'] * 100), 0);

        assert.equal(matched + inject, buyCash, `第 ${k} 组：买入的钱没凑够`);
        assert.equal(matched + leftover, sellCash, `第 ${k} 组：卖出的钱对不上`);
        // 卖得比买得多只会有剩余，买得比卖得多只会有注资，两者不会同时出现
        assert.ok(inject === 0 || leftover === 0, `第 ${k} 组：同时出现注资和剩余`);
    }
});
