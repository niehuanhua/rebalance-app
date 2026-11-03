# 归衡配比测算器

用来算「手上的资产该卖多少、该买多少」的一个小工具。纯前端，单页，不需要服务器。

## 现在是什么状态

算法层已经重写完毕：`core.js` 全是整数运算（金额用「分」，比例用「基点」，价格用「万分之一元」），
35 条测试全绿，其中 4000 组是随机生成的输入。界面层 `app.js` 跟着改完了。

手机布局也做完了：窄屏（≤720px）下两张结果表变成一列卡片，输入框占满一行、字号 16px，
按钮至少 44px 高；桌面端仍然是原来的表格，互不影响。

还剩最后一步：打包成 Android APK（这样手机上才没有地址栏）。

## 测试

```bash
node --test                 # 35 条逻辑测试，零依赖
node e2e/desktop.mjs        # 9 项真浏览器冒烟测试（桌面宽度）
node e2e/mobile.mjs         # 6 项真浏览器冒烟测试（390 宽手机）
node e2e/consent.mjs        # 5 项：首启隐私同意弹窗（用 CDP 伪造原生环境）
node e2e/export.mjs         # 6 项：导出 Excel 的两条路（APK 走分享面板、网页走下载）
```

后四个需要先起静态服务器和调试版 Chrome，见 `e2e/README.md`。

## 已经修掉的已知问题

这些都是当初确认存在的，不是猜的：

1. ~~默认 3 个资产时比例是 33/33/33，合计 99%，第一次点「计算」必然报错~~ → 改成 34/33/33，任何数量都正好 100%
2. ~~当前市值和当前价格从来没被保存~~ → 五栏全部存在本机
3. ~~金额用浮点数，`round2` 也不可靠（`10.075` 会算成 `10.07`）~~ → 按字符切片解析，不经过浮点乘法
4. ~~独立四舍五入会丢 1 分钱~~ → 最大余数法分配，目标市值合计和差额合计都精确为 0
5. ~~负价格、负市值、负比例都不拦截~~ → 一律报「第 N 行（名字）：……」
6. ~~卖出侧完全不收手续费~~ → 每个资产一个卖出费率，默认 0
7. ~~资产名会被拼进 HTML~~ → 所有名字先转义再进页面
8. ~~资产数量没有上限~~ → 夹在 1~50
9. ~~APK 里点「导出 Excel」没有任何反应~~ → 安卓 WebView 没实现下载监听，
   `XLSX.writeFile` 那条 Blob + 合成 `<a download>` 的路在壳里是死的。
   现在分两条路：网页版照旧浏览器下载；APK 里改成写进应用缓存目录再调系统分享面板
   （`@capacitor/filesystem` + `@capacitor/share`，不申请任何权限）。

完整的判定过程见 git 提交历史。

## 已经定下来的产品语义

- **买入手续费**：额外掏现金补（不是从卖出款里扣）。界面上会拆成「净买入额 / 手续费 / 实际掏现金」三列，方便核账。
- **卖出手续费**：每个资产一栏，**默认 0**。C 类基金本来免赎回费；A 类或持有不满 7 天的自己填。
- **份额**：只做估算，保留两位小数，不保证能整除到可下单的最小单位。界面会写清楚这一点。

## 开发方式

- 计算逻辑放在 `core.js`，纯函数，不碰 DOM、不碰 localStorage
- 测试用 Node 自带的 `node --test`，零依赖
- 跑测试：`node --test`

## 怎么在手机上用

两种方式，选一个：

**方式一：网页版（免安装）** 打开 Pages 地址 → 浏览器菜单 → 添加到主屏幕。
缺点是荣耀浏览器做出来的快捷方式仍带地址栏（它不实现 PWA 的 standalone 显示）。

**方式二：APK（推荐，没有地址栏、完全离线）**

```bash
npm run android:apk     # 出包 → dist/rebalance-debug.apk
```

然后把 `dist/rebalance-debug.apk` 传到手机点击安装；连了数据线也可以：

```bash
~/android-dev/sdk/platform-tools/adb install -r dist/rebalance-debug.apk
```

打包用的是 Capacitor 6（原生壳），网页代码原样塞进安装包，所以改完代码重新跑一次
`npm run android:apk` 再装一遍即可。环境要求：JDK 17 + Android SDK（路径写死在
`scripts/build-apk.mjs` 里，换机器用环境变量 `JAVA_HOME` / `ANDROID_HOME` 覆盖）。

`www/` 是给 Capacitor 的暂存目录，由 `scripts/stage-www.mjs` 按白名单生成，
**故意不含 `sw.js`**：安装包里的资源本来就是本地的，留着 Service Worker 反而会让
升级后还显示上一版页面。

## 发布（上架用）

### 打正式包

```bash
npm run android:apk:release     # → dist/归衡配比测算器-v<版本号>.apk
```

和 `android:apk`（debug 包）的区别只有一个：签名。正式包用仓库外的密钥签名，
debug 包用 Android 自带的调试密钥——**商店不认调试签名**。

版本号从 `android/app/build.gradle` 里的 `versionName` 读，不要在这两处之外再写一份。
每次提审前把 `versionCode` 加 1（商店靠它判断「新的」）。

### 签名密钥（丢了就再也发不了更新）

| 项 | 值 |
|---|---|
| 密钥文件 | `~/android-dev/keys/guilheng-release.jks`（**在仓库外**） |
| alias | `guilheng` |
| 算法 | RSA 2048，有效期 10000 天 |
| 密码 | 只写在 `android/keystore.properties`（已 gitignore）里，不在这里 |
| SHA-256 指纹 | `33:0C:0E:0C:2F:6A:F1:EE:D4:39:63:A5:52:57:60:BC:33:A5:AF:B1:37:0C:34:0F:3C:32:DD:89:7E:5B:C2:90` |

`android/keystore.properties` 长这样（`storeFile` 用绝对路径）：

```properties
storeFile=/Users/niehuanhuan/android-dev/keys/guilheng-release.jks
storePassword=***
keyAlias=guilheng
keyPassword=***
```

`android/app/build.gradle` 里读这个文件；文件不存在时**不配置签名**，
所以没有密钥的机器跑 `assembleDebug` 仍然正常。

**备份**：`.jks` 文件抄两份到两个不同的物理位置（U 盘 + 另一台设备或加密云盘）。
只要没在商店发布过，丢了密钥重新生成一个即可（代价是重打一次包）；
**一旦发布过，丢了密钥就永远发不了更新**。

### 出包后必查

```bash
BT=~/android-dev/sdk/build-tools/35.0.0
$BT/apksigner verify --print-certs dist/归衡配比测算器-v1.1.0.apk   # 签名者不能是 CN=Android Debug
$BT/zipalign -c -v 4 dist/归衡配比测算器-v1.1.0.apk               # 对齐
$BT/aapt dump permissions dist/归衡配比测算器-v1.1.0.apk           # 不能有 INTERNET
$BT/aapt dump badging dist/归衡配比测算器-v1.1.0.apk | head -3      # 版本号、应用名
```

### 隐私合规

- `privacy.html` 是隐私政策全文，跟 `index.html` 一起打进安装包（在 WebView 里原地打开，不外跳）
- 首次启动弹同意窗，同意之前不写任何业务数据（`app.js` 里的 `window.onload`）
- 同意状态记在 localStorage 的 `privacyConsent_v1`，值是 `granted:v1`；
  隐私政策改版时把 `CONSENT_VALUE` 改成 `granted:v2`，老用户会被重新问一次
- 「清空保存的历史数据」只删业务数据，不动同意记录
- 商店填表要一个公网可访问的隐私政策地址：
  `https://niehuanhua.github.io/rebalance-app/privacy.html`

### 权限

安装包里**一个用户权限都没有**（`INTERNET` 已从 `AndroidManifest.xml` 删掉，
`allowBackup="false"`）。唯一的 `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` 是
AndroidX 给自家组件做的自保护，不是用户权限，会出现在 `aapt dump permissions` 里，属正常。
