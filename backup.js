/* backup.js —— 备份文件的生成与解析。
 *
 * 这里不碰 DOM、不碰 localStorage、不碰文件系统，只吃字符串吐对象。
 * 好处：Node 里能直接 require 进来跑测试，手机上跑的还是同一份代码。
 *
 * 浏览器：当普通 <script> 加载，暴露全局 Backup。
 * Node：  require('./backup.js')
 *
 * 为什么要有这个文件：APK 的 AndroidManifest 写了 allowBackup="false"，
 * 数据只存在本机 localStorage 里。换手机、卸载重装都会全部丢掉。
 * 导出 Excel 只能导出「计算结果」，不能把录入的数据带回来，
 * 所以单独立一个格式，专门用来搬数据。
 *
 * 解析这一侧是外部输入（用户可能选错文件、文件可能被改过），
 * 一律当成敌意数据：永远不抛异常，只返回 { ok:false, error }。
 */
var Backup = (function () {
    'use strict';

    const FORMAT = 'rebalance-backup';
    const FORMAT_VERSION = 1;
    const APP_NAME = '资产再平衡计算器';
    const MIN_ASSETS = 1;
    const MAX_ASSETS = 50;

    // 备份文件长这样也就几十 KB，超过这个数一定不是我们生成的文件
    const MAX_TEXT_LENGTH = 2 * 1024 * 1024;

    /* 界面上的六个输入框，顺序与 createAssetInputs() 一致。 */
    const FIELDS = ['name', 'currentValue', 'targetRatio', 'buyFeeRate', 'sellFeeRate', 'currentPrice'];

    const DEFAULT_BY_FIELD = {
        name: '',
        currentValue: '',
        targetRatio: '',
        buyFeeRate: '0',
        sellFeeRate: '0',
        currentPrice: '',
    };

    function toText(v, fallback) {
        if (v === undefined || v === null) return fallback;
        return String(v);
    }

    /* 把一个资产对象规整成界面认识的样子：六个字段全是字符串。 */
    function normalizeAsset(raw, index) {
        const a = (raw && typeof raw === 'object') ? raw : {};
        const out = {};
        FIELDS.forEach((k) => { out[k] = toText(a[k], DEFAULT_BY_FIELD[k]); });
        if (out.name.trim() === '') out.name = `资产${index + 1}`;
        return out;
    }

    function normalizeAssets(list) {
        return list.map(normalizeAsset);
    }

    /* 打包成可写进文件的普通对象。now 只为测试可注入。 */
    function build(data, now) {
        const assets = normalizeAssets((data && data.assets) || []);
        return {
            format: FORMAT,
            formatVersion: FORMAT_VERSION,
            app: APP_NAME,
            exportedAt: (now || new Date()).toISOString(),
            assetCount: assets.length,
            assets: assets,
        };
    }

    function fail(error) {
        return { ok: false, error: error };
    }

    /* 解析备份文件正文。成功返回 { ok:true, assetCount, assets }。 */
    function parse(text) {
        if (typeof text !== 'string' || text.trim() === '') {
            return fail('文件是空的，什么都读不到。');
        }
        if (text.length > MAX_TEXT_LENGTH) {
            return fail('文件太大了，不像是备份文件。');
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return fail('这不是备份文件（读不出 JSON）。请选择「再平衡备份_日期.json」。');
        }

        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return fail('这不是本软件的备份文件。');
        }
        if (data.format !== FORMAT) {
            return fail('这不是本软件的备份文件。');
        }

        const ver = data.formatVersion === undefined ? FORMAT_VERSION : data.formatVersion;
        if (!Number.isInteger(ver) || ver < 1) {
            return fail('备份文件的版本号不对，无法读取。');
        }
        if (ver > FORMAT_VERSION) {
            return fail('备份文件来自更新的软件版本，请先升级软件再恢复。');
        }

        if (!Array.isArray(data.assets) || data.assets.length === 0) {
            return fail('备份文件里没有资产数据。');
        }
        if (data.assets.length > MAX_ASSETS) {
            return fail(`备份文件里的资产超过 ${MAX_ASSETS} 个，无法恢复。`);
        }
        const bad = data.assets.find(a => !a || typeof a !== 'object' || Array.isArray(a));
        if (bad !== undefined) {
            return fail('备份文件里的资产数据格式不对。');
        }

        const assets = normalizeAssets(data.assets);
        return { ok: true, assetCount: assets.length, assets: assets };
    }

    return {
        FORMAT, FORMAT_VERSION, APP_NAME, MIN_ASSETS, MAX_ASSETS, FIELDS,
        build, parse, normalizeAssets,
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
