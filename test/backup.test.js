/* 备份文件（导入 / 导出）的纯逻辑测试。
 *
 * 背景：APK 的 AndroidManifest 里 allowBackup="false"，数据只在本机 localStorage，
 * 换手机就全丢。所以加了「备份到文件 / 从文件恢复」。
 *
 * backup.js 跟 core.js 一样：不碰 DOM、不碰 localStorage，只吃字符串吐对象。
 * 好处是 Node 里能直接测，手机上跑的是同一份代码。
 *
 * 解析这一侧是「外部输入」，必须当成敌意数据对待：
 * 用户可能选错文件（选成 Excel、选成照片）、文件可能被改过、
 * 版本可能来自未来的版本。每一条都要有明确的中文错误，不许抛异常炸到界面上。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Backup = require('../backup.js');

const NOW = new Date('2026-11-06T10:00:00Z');

const SAMPLE = {
    assetCount: 2,
    assets: [
        { name: '沪深300', currentValue: '120000', targetRatio: '60', buyFeeRate: '0.50', sellFeeRate: '0', currentPrice: '4.1234' },
        { name: '债券基金', currentValue: '80000', targetRatio: '40', buyFeeRate: '0.10', sellFeeRate: '0.05', currentPrice: '1.0500' },
    ],
};

/* ---------------- 生成备份 ---------------- */

test('备份内容：带格式标识、版本和导出时间', () => {
    const b = Backup.build(SAMPLE, NOW);
    assert.equal(b.format, 'rebalance-backup');
    assert.equal(b.formatVersion, 1);
    assert.equal(b.app, '资产再平衡计算器');
    assert.equal(b.exportedAt, '2026-11-06T10:00:00.000Z');
    assert.equal(b.assetCount, 2);
    assert.equal(b.assets.length, 2);
});

test('备份内容：字段原样保留，不做四舍五入', () => {
    const b = Backup.build(SAMPLE, NOW);
    assert.equal(b.assets[0].currentValue, '120000');
    assert.equal(b.assets[0].currentPrice, '4.1234');
    assert.equal(b.assets[1].sellFeeRate, '0.05');
});

/* ---------------- 往返：备份 → 解析 ---------------- */

test('往返：导出的备份能原样恢复', () => {
    const text = JSON.stringify(Backup.build(SAMPLE, NOW));
    const r = Backup.parse(text);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.assets, SAMPLE.assets);
    assert.equal(r.assetCount, 2);
});

test('往返：名字里有中文、引号、尖括号也不会坏', () => {
    const tricky = {
        assetCount: 1,
        assets: [{ name: '「稳健」<混合>&"债基"', currentValue: '1', targetRatio: '100', buyFeeRate: '0', sellFeeRate: '0', currentPrice: '1' }],
    };
    const r = Backup.parse(JSON.stringify(Backup.build(tricky, NOW)));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.assets[0].name, '「稳健」<混合>&"债基"');
});

/* ---------------- 拒绝错误的输入：每一条都要有中文理由 ---------------- */

test('拒绝：根本不是 JSON（比如选成了 Excel）', () => {
    const r = Backup.parse('PK\u0003\u0004 this is a zip');
    assert.equal(r.ok, false);
    assert.match(r.error, /JSON/);
});

test('拒绝：空文件 / 只有空白', () => {
    assert.equal(Backup.parse('').ok, false);
    assert.equal(Backup.parse('   \n\t ').ok, false);
});

test('拒绝：JSON 是数组或字符串，不是对象', () => {
    assert.equal(Backup.parse('[1,2,3]').ok, false);
    assert.equal(Backup.parse('"hello"').ok, false);
    assert.equal(Backup.parse('null').ok, false);
});

test('拒绝：不是本软件的备份文件（缺 format 标识）', () => {
    const r = Backup.parse(JSON.stringify({ foo: 'bar' }));
    assert.equal(r.ok, false);
    assert.match(r.error, /备份/);
});

test('拒绝：来自更新版本的备份', () => {
    const b = Backup.build(SAMPLE, NOW);
    b.formatVersion = 99;
    const r = Backup.parse(JSON.stringify(b));
    assert.equal(r.ok, false);
    assert.match(r.error, /版本/);
});

test('拒绝：资产列表缺失或为空', () => {
    const b = Backup.build(SAMPLE, NOW);
    delete b.assets;
    assert.equal(Backup.parse(JSON.stringify(b)).ok, false);

    b.assets = [];
    const r = Backup.parse(JSON.stringify(b));
    assert.equal(r.ok, false);
    assert.match(r.error, /资产/);
});

test('拒绝：资产数量超过上限 50', () => {
    const b = Backup.build(SAMPLE, NOW);
    b.assets = Array.from({ length: 51 }, (_, i) => SAMPLE.assets[i % 2]);
    const r = Backup.parse(JSON.stringify(b));
    assert.equal(r.ok, false);
    assert.match(r.error, /50/);
});

test('拒绝：资产不是对象', () => {
    const b = Backup.build(SAMPLE, NOW);
    b.assets = ['a', null, 3];
    const r = Backup.parse(JSON.stringify(b));
    assert.equal(r.ok, false);
    assert.match(r.error, /资产/);
});

/* ---------------- 宽容的地方：缺字段给默认值，不整份作废 ---------------- */

test('宽容：资产缺字段时补成界面认识的默认值', () => {
    const r = Backup.parse(JSON.stringify({
        format: 'rebalance-backup',
        formatVersion: 1,
        assets: [{ name: '现金' }],
    }));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.assets[0], {
        name: '现金',
        currentValue: '',
        targetRatio: '',
        buyFeeRate: '0',
        sellFeeRate: '0',
        currentPrice: '',
    });
});

test('宽容：没有名字的资产按顺序叫「资产N」', () => {
    const r = Backup.parse(JSON.stringify({
        format: 'rebalance-backup',
        formatVersion: 1,
        assets: [{ currentValue: '1' }, { currentValue: '2' }],
    }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.assets[0].name, '资产1');
    assert.equal(r.assets[1].name, '资产2');
});

test('宽容：数字直接存成数字也能读（老备份 / 手改的文件）', () => {
    const r = Backup.parse(JSON.stringify({
        format: 'rebalance-backup',
        formatVersion: 1,
        assets: [{ name: 'A', currentValue: 100, targetRatio: 50, buyFeeRate: 0.5, sellFeeRate: 0, currentPrice: 1.5 }],
    }));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.assets[0], {
        name: 'A',
        currentValue: '100',
        targetRatio: '50',
        buyFeeRate: '0.5',
        sellFeeRate: '0',
        currentPrice: '1.5',
    });
});

test('assetCount 以实际资产数为准，不信文件里写的那个数', () => {
    const b = Backup.build(SAMPLE, NOW);
    b.assetCount = 99;
    const r = Backup.parse(JSON.stringify(b));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.assetCount, 2);
});
