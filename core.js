/* core.js —— 纯计算逻辑。
 *
 * 这里不碰 DOM、不碰 localStorage、不碰 XLSX，只吃输入、吐结果。
 * 好处：Node 里能直接 require 进来跑测试，手机上跑的还是同一份代码。
 *
 * 浏览器：当普通 <script> 加载，暴露全局 Core。
 * Node：  require('./core.js')
 *
 * 数字模型（这是整个文件的地基）：
 *   金额一律用整数「分」        —— 钱不能用小数存，0.1+0.2 那种误差会变成 1 分钱的缺口
 *   比例一律用整数「基点」      —— 100% = 10000bp，1% = 100bp，0.01% = 1bp
 *   价格一律用整数「万分之一元」—— 1.2345 元 = 12345
 *
 * 只要全部是整数，加减乘除的结果就能一分不差地对上账。
 */
var Core = (function () {
    'use strict';

    const BPS = 10000;            // 100% 的基点值
    const CENTS_PER_YUAN = 100;   // 1 元 = 100 分
    const PRICE_SCALE = 10000;    // 价格精度：万分之一元
    // 目标市值乘以基点不能超过 2^53，否则整数运算会失真
    const MAX_TOTAL_CENTS = 9e11; // 90 亿元

    /* scale 必须是 10 的整数次幂，返回小数点后位数；否则 -1 */
    function decimalsOf(scale) {
        if (!Number.isSafeInteger(scale) || scale < 1) return -1;
        let s = scale, d = 0;
        while (s > 1) {
            if (s % 10 !== 0) return -1;
            s /= 10;
            d++;
        }
        return d;
    }

    /* 把十进制字符串按 scale 放大成整数，多出来的位四舍五入。
     * 返回 null 表示「这不是个数」。
     *
     * 为什么不用 Number(x) * scale：
     *   10.075 * 100 在 double 里是 1007.4999999999999，乘完再取整会少一分。
     *   这里全程按字符切片，不经过浮点乘法，误差为零。
     */
    function parseScaledInt(value, scale) {
        if (value === null || value === undefined) return null;
        const s = String(value).trim();
        if (!s) return null;

        const digits = decimalsOf(scale);
        if (digits < 0) return null;

        const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
        if (!m) return null;                       // 1e3、abc、1,000 之类一律拒绝
        const intPart = m[2] || '';
        let frac = m[3] || '';
        if (intPart === '' && frac === '') return null;   // 只有一个 "."

        const sign = m[1] === '-' ? -1 : 1;
        let roundUp = false;
        if (frac.length > digits) {
            roundUp = frac.charAt(digits) >= '5';
            frac = frac.slice(0, digits);
        }
        frac = frac.padEnd(digits, '0');

        const n = Number(intPart + frac) + (roundUp ? 1 : 0);
        if (!Number.isSafeInteger(n)) return null;
        return sign * n;
    }

    /* 默认目标比例：把 100% 尽量平均分，分不尽的整数个百分点补给前面几个。
     * 关键在于「合计必须正好 100%」——旧代码每个都取 round(100/n)，
     * 3 个资产会得到 33+33+33=99%，第一次点计算就报错。
     */
    function defaultRatioBp(n) {
        const count = Math.max(1, Math.floor(n) || 1);
        const base = Math.floor(100 / count);
        const extra = 100 - base * count;
        const out = [];
        for (let i = 0; i < count; i++) {
            out.push((base + (i < extra ? 1 : 0)) * 100);
        }
        return out;
    }

    /* 把界面上的原始输入整理成计算用的整数，顺便把填错的拦下来。
     * 返回 { ok: true, assets } 或 { ok: false, error }
     */
    function readAssets(list) {
        const rows = Array.isArray(list) ? list : [];
        if (rows.length === 0) return { ok: false, error: '请至少填一个资产' };

        const assets = [];
        for (let i = 0; i < rows.length; i++) {
            const raw = rows[i] || {};
            const at = `第 ${i + 1} 行`;
            const name = String(raw.name == null ? '' : raw.name).trim() || `资产${i + 1}`;
            const where = `${at}（${name}）`;

            // 市值：留空当作 0（沿用旧行为），但填了负数就是错
            const currentCents = raw.current === '' || raw.current === null || raw.current === undefined
                ? 0
                : parseScaledInt(raw.current, CENTS_PER_YUAN);
            if (currentCents === null) return { ok: false, error: `${where}：当前市值不是数字` };
            if (currentCents < 0) return { ok: false, error: `${where}：当前市值不能是负数` };

            const ratioBp = parseScaledInt(raw.ratioPct, 100);
            if (ratioBp === null) return { ok: false, error: `${where}：目标配置比例没填或不是数字` };
            if (ratioBp < 0) return { ok: false, error: `${where}：目标配置比例不能是负数` };

            const buyFeeBp = parseScaledInt(raw.buyFeePct === '' ? '0' : raw.buyFeePct, 100);
            if (buyFeeBp === null) return { ok: false, error: `${where}：买入费率不是数字` };
            if (buyFeeBp < 0 || buyFeeBp >= BPS) return { ok: false, error: `${where}：买入费率要在 0 到 100 之间` };

            const sellFeeBp = parseScaledInt(raw.sellFeePct === '' ? '0' : raw.sellFeePct, 100);
            if (sellFeeBp === null) return { ok: false, error: `${where}：卖出费率不是数字` };
            if (sellFeeBp < 0 || sellFeeBp >= BPS) return { ok: false, error: `${where}：卖出费率要在 0 到 100 之间` };

            const priceUnit = parseScaledInt(raw.price, PRICE_SCALE);
            if (priceUnit === null) return { ok: false, error: `${where}：当前价格没填或不是数字` };
            if (priceUnit <= 0) return { ok: false, error: `${where}：当前价格必须大于 0` };

            assets.push({ name, currentCents, ratioBp, buyFeeBp, sellFeeBp, priceUnit });
        }
        return { ok: true, assets };
    }

    /* 最大余数法：把 total 按 weights 分配，保证分出来的和正好等于 total。
     *
     * 先各自取整（floor），剩下的零头按小数部分从大到小，一个个补一分。
     * 这样既公平，又绝对不丢钱、不凭空造钱。
     */
    function allocate(total, weights) {
        const wsum = weights.reduce((a, b) => a + b, 0);
        if (wsum <= 0) return weights.map(() => 0);

        const out = [];
        const rests = [];
        let assigned = 0;
        weights.forEach((w, i) => {
            const exact = total * w / wsum;
            const base = Math.floor(exact);
            out[i] = base;
            assigned += base;
            rests.push({ i, rest: exact - base });
        });

        let left = total - assigned;
        rests.sort((a, b) => b.rest - a.rest || a.i - b.i);
        for (let k = 0; left > 0; k++, left--) {
            out[rests[k % rests.length].i] += 1;
        }
        return out;
    }

    /* 金额（分）换算成份额：现金 ÷ 单价。
     * 分 / 100 = 元；万分之一元 / 10000 = 元。所以分子是 cents * 100。
     */
    function sharesOf(cents, priceUnit) {
        return cents * CENTS_PER_YUAN / priceUnit;
    }

    /* 再平衡主计算。
     * 输入：readAssets() 给出的 assets
     * 输出：{ ok: false, error } 或 { ok: true, totalCents, rows }
     */
    function computeRebalance(assets) {
        const list = Array.isArray(assets) ? assets : [];
        if (list.length === 0) return { ok: false, error: '请至少填一个资产' };

        const sumBp = list.reduce((s, a) => s + a.ratioBp, 0);
        if (Math.abs(sumBp - BPS) > 10) {   // 容差 10bp = 0.1%
            return { ok: false, error: `目标配置比例之和=${(sumBp / 100).toFixed(2)}%，应为100%` };
        }

        const totalCents = list.reduce((s, a) => s + a.currentCents, 0);
        if (totalCents <= 0) return { ok: false, error: '总资产为0' };
        if (totalCents > MAX_TOTAL_CENTS) return { ok: false, error: '总资产过大（超过 90 亿元），无法精确计算' };

        // 比例合计允许有 0.1% 的容差，分配时按实际合计归一，保证目标市值合计不差分
        const targets = allocate(totalCents, list.map(a => a.ratioBp));

        const rows = list.map((a, i) => {
            const targetCents = targets[i];
            const diffCents = a.currentCents - targetCents;   // 正数 = 该卖，负数 = 该买

            let action = '无';
            let amountCents = 0;
            let feeCents = 0;
            let cashCents = 0;
            let shares = '-';

            if (diffCents > 0) {
                action = '卖出';
                amountCents = diffCents;
                feeCents = Math.round(amountCents * a.sellFeeBp / BPS);
                cashCents = amountCents - feeCents;           // 到手
                shares = sharesOf(amountCents, a.priceUnit).toFixed(2);   // 份额按毛额算，不扣费
            } else if (diffCents < 0) {
                action = '买入';
                amountCents = -diffCents;
                feeCents = Math.round(amountCents * a.buyFeeBp / BPS);
                cashCents = amountCents + feeCents;           // 实掏
                shares = sharesOf(amountCents, a.priceUnit).toFixed(2);
            }

            return {
                name: a.name,
                currentCents: a.currentCents,
                targetCents,
                diffCents,
                buyFeeBp: a.buyFeeBp,
                sellFeeBp: a.sellFeeBp,
                priceUnit: a.priceUnit,
                action,
                amountCents,
                feeCents,
                cashCents,
                shares,
                // 给界面和 Excel 用的显示字符串
                current: a.currentCents / CENTS_PER_YUAN,
                target: targetCents / CENTS_PER_YUAN,
                amount: amountCents / CENTS_PER_YUAN,
                fee: feeCents / CENTS_PER_YUAN,
                cash: cashCents / CENTS_PER_YUAN,
                price: (a.priceUnit / PRICE_SCALE).toFixed(4),
                buyFeePct: (a.buyFeeBp / 100).toFixed(2),
                sellFeePct: (a.sellFeeBp / 100).toFixed(2),
            };
        });

        return { ok: true, totalCents, totalAsset: totalCents / CENTS_PER_YUAN, rows };
    }

    /* 转换规划：把卖出的钱配给要买的资产。
     *
     * 关键：配对用的单位是「现金」，不是「市值」。
     *   卖 10000 元、费率 0.5% → 到手 9950，这 9950 才是能拿去买东西的钱。
     *   买 10000 元、费率 0.5% → 要掏 10050。
     * 按毛额配对会漏掉手续费，账对不上。
     *
     * 贪心：按买入行的先后顺序，一个卖家喂饱一个买家再下一个。
     * 每一行固定 6 列，导出 Excel 时直接就是表头。
     */
    function generateConvertPlan(rebalanceData) {
        const rows = Array.isArray(rebalanceData) ? rebalanceData : [];

        const sellers = rows.filter(r => r.action === '卖出')
            .map(r => ({ name: r.name, remaining: r.cashCents, priceUnit: r.priceUnit, sellFeeBp: r.sellFeeBp }));

        const buyers = rows.filter(r => r.action === '买入')
            .map(r => ({ name: r.name, remaining: r.cashCents, priceUnit: r.priceUnit }));

        const plan = [];

        sellers.forEach(seller => {
            while (seller.remaining > 0) {
                const buyer = buyers.find(b => b.remaining > 0);
                if (!buyer) break;
                const transfer = Math.min(seller.remaining, buyer.remaining);
                // 这段现金对应卖掉多少市值：现金 ÷ (1 - 卖出费率)
                const gross = seller.sellFeeBp >= BPS
                    ? transfer
                    : Math.round(transfer * BPS / (BPS - seller.sellFeeBp));
                plan.push({
                    '卖出资产': seller.name,
                    '卖出金额(元)': transfer / CENTS_PER_YUAN,
                    '卖出份额(份)': sharesOf(gross, seller.priceUnit).toFixed(2),
                    '买入资产': buyer.name,
                    '买入金额(元)': transfer / CENTS_PER_YUAN,
                    '转换状态': '内部资金匹配',
                });
                seller.remaining -= transfer;
                buyer.remaining -= transfer;
            }
        });

        // 卖的钱不够覆盖买+费 → 差额要另外掏
        buyers.forEach(buyer => {
            if (buyer.remaining > 0) {
                plan.push({
                    '卖出资产': '外部资金',
                    '卖出金额(元)': buyer.remaining / CENTS_PER_YUAN,
                    '卖出份额(份)': '—',
                    '买入资产': buyer.name,
                    '买入金额(元)': buyer.remaining / CENTS_PER_YUAN,
                    '转换状态': '需额外注入资金',
                });
            }
        });

        // 卖多了的钱留在手上
        sellers.forEach(seller => {
            if (seller.remaining > 0) {
                const gross = seller.sellFeeBp >= BPS
                    ? seller.remaining
                    : Math.round(seller.remaining * BPS / (BPS - seller.sellFeeBp));
                plan.push({
                    '卖出资产': seller.name,
                    '卖出金额(元)': seller.remaining / CENTS_PER_YUAN,
                    '卖出份额(份)': sharesOf(gross, seller.priceUnit).toFixed(2),
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

    return {
        BPS, PRICE_SCALE, CENTS_PER_YUAN,
        parseScaledInt, defaultRatioBp, readAssets, allocate,
        sharesOf, computeRebalance, generateConvertPlan,
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Core;
