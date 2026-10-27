/* core.js —— 纯计算逻辑。
 *
 * 这里不碰 DOM、不碰 localStorage、不碰 XLSX，只吃数字、吐数字。
 * 好处：Node 里能直接 require 进来跑测试，手机上跑的还是同一份代码。
 *
 * 浏览器：当普通 <script> 加载，暴露全局 Core。
 * Node：  require('./core.js')
 *
 * 注意：这一版是「原样搬家」，算术跟改造前的 index.html 完全一致，
 * 目的是先用特征测试把现状钉死，之后再改数字模型时才知道哪里变了。
 */
var Core = (function () {
    'use strict';

    const round2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

    /* 把界面上的原始输入（都是字符串）整理成计算用的数字。
     * 这里的兜底规则是从旧代码原样搬过来的，包括：
     *   - 价格填 0 或填不出来 → 当成 0.0001（旧行为，待改造）
     *   - 手续费填不出来 → 当成 0
     *   - 比例填不出来 → 保留 NaN（旧行为，会穿透到结果里，待改造）
     */
    function parseAsset(raw, idx) {
        const name = String(raw.name == null ? '' : raw.name).trim() || `资产${idx + 1}`;
        const current = parseFloat(raw.current) || 0;
        const ratioPct = parseFloat(raw.ratioPct);
        const feeRaw = parseFloat(raw.feePct);
        const feePct = isNaN(feeRaw) ? 0 : feeRaw;
        const price = parseFloat(parseFloat(raw.price).toFixed(4)) || 0.0001;
        return { name, current, ratioPct, feePct, price };
    }

    /* 再平衡主计算。
     * 输入：assets，每个是 { name, current, ratioPct, feePct, price }
     * 输出：{ ok: false, error } 或 { ok: true, totalAsset, rows }
     */
    function computeRebalance(assets) {
        const totalRatio = assets.reduce((s, a) => s + (isNaN(a.ratioPct) ? 0 : a.ratioPct), 0);
        if (Math.abs(totalRatio - 100) > 0.1) {
            return { ok: false, error: `目标配置比例之和=${totalRatio.toFixed(2)}%，应为100%` };
        }

        const totalAsset = assets.reduce((s, a) => s + a.current, 0);
        if (totalAsset < 0.01) {
            return { ok: false, error: '总资产为0' };
        }

        const rows = assets.map(a => {
            const ratio = a.ratioPct / 100;
            const target = totalAsset * ratio;
            const diff = a.current - target;
            const fee = a.feePct / 100;

            let action = '无';
            let amount = 0;
            let shares = '-';

            if (diff > 0.01) {
                action = '卖出';
                amount = round2(diff);
                shares = (amount / a.price).toFixed(2);
            } else if (diff < -0.01) {
                action = '买入';
                const netBuy = Math.abs(diff);
                amount = round2(netBuy * (1 + fee));
                shares = (netBuy / a.price).toFixed(2);
            }

            return {
                name: a.name,
                current: round2(a.current),
                target: round2(target),
                feePct: a.feePct.toFixed(2),
                price: a.price.toFixed(4),
                action,
                amount,
                shares,
            };
        });

        return { ok: true, totalAsset, rows };
    }

    /* 转换规划：把卖出的钱配给要买的资产。
     * 贪心：按买入行的先后顺序，一个卖家喂饱一个买家再下一个。
     * 每一行有 6 列，导出 Excel 时直接就是表头。
     */
    function generateConvertPlan(rebalanceData, assetsRaw) {
        // 卖出金额（正数）
        const sellers = rebalanceData.filter(r => r.action === '卖出')
            .map(s => ({
                name: s.name,
                available: s.amount,
                remaining: s.amount,
                price: parseFloat(s.price),
            }));

        // 资金匹配按「含手续费的实际花费」对账，避免漏算需补的资金
        const buyers = rebalanceData.filter(r => r.action === '买入')
            .map(b => {
                const raw = assetsRaw ? assetsRaw.find(a => a.name === b.name) : null;
                const fee = raw ? raw.feePct / 100 : 0;
                // 买入实际要花的现金 = 含手续费的总金额（b.amount 已是 netBuy*(1+fee)）
                const totalCost = b.amount;
                return { name: b.name, remaining: totalCost, totalCost, fee, price: parseFloat(b.price) };
            });

        const plan = [];

        // 先把卖出的钱在内部配对
        sellers.forEach(seller => {
            while (seller.remaining > 0 && buyers.some(b => b.remaining > 0)) {
                const buyer = buyers.find(b => b.remaining > 0);
                const transfer = Math.min(seller.remaining, buyer.remaining);
                plan.push({
                    '卖出资产': seller.name,
                    '卖出金额(元)': round2(transfer),
                    '卖出份额(份)': (transfer / seller.price).toFixed(2),
                    '买入资产': buyer.name,
                    '买入金额(元)': round2(transfer),
                    '转换状态': '内部资金匹配',
                });
                seller.remaining -= transfer;
                buyer.remaining -= transfer;
            }
        });

        // 还不够的钱要另外掏
        buyers.forEach(buyer => {
            if (buyer.remaining > 0.01) {
                plan.push({
                    '卖出资产': '外部资金',
                    '卖出金额(元)': round2(buyer.remaining),
                    '卖出份额(份)': '—',
                    '买入资产': buyer.name,
                    '买入金额(元)': round2(buyer.remaining),
                    '转换状态': '需额外注入资金',
                });
            }
        });

        // 卖多了的钱留在手上
        sellers.forEach(seller => {
            if (seller.remaining > 0.01) {
                plan.push({
                    '卖出资产': seller.name,
                    '卖出金额(元)': round2(seller.remaining),
                    '卖出份额(份)': (seller.remaining / seller.price).toFixed(2),
                    '买入资产': '无',
                    '买入金额(元)': 0,
                    '转换状态': '剩余卖出资金（可提现/备用）',
                });
            }
        });

        return plan.length ? plan : [{
            '卖出资产': '无', '卖出金额(元)': 0, '卖出份额(份)': '—',
            '买入资产': '无', '买入金额(元)': 0, '转换状态': '无需转换',
        }];
    }

    return { round2, parseAsset, computeRebalance, generateConvertPlan };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Core;
