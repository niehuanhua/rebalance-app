# 浏览器端冒烟测试

`test/` 里那 35 条是 `node --test` 跑的纯逻辑测试，不碰页面。
这里两个是**真浏览器**测试，用 Chrome DevTools Protocol 开真页面、点真按钮、读真表格。

| 文件 | 测什么 |
|---|---|
| `desktop.mjs` | 桌面宽度下的 9 项：默认值、五五开不多 1 分钱、卖出费率、XSS 转义、报错带行号、数量夹 50、刷新后数据还在 |
| `mobile.mjs` | 390×844 手机宽度下的 6 项：没有横向滚动、输入框 ≥16px、按钮 ≥44px、两张结果表变成卡片、切回 1280 恢复表格 |

## 怎么跑

需要两个东西在跑：

```bash
# 1. 静态服务器（仓库根目录）
python3 -m http.server 8123

# 2. 一个开了调试端口的 Chrome
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-rb-test about:blank

# 3. 跑测试
node e2e/desktop.mjs
node e2e/mobile.mjs
```

端口不是默认值就用环境变量：`CDP_BASE=http://127.0.0.1:9333 PAGE_URL=http://127.0.0.1:9000/index.html node e2e/mobile.mjs`

## 注意：Service Worker 会把旧代码喂给你

`sw.js` 对静态资源是**缓存优先**，所以改完 `app.js` 立刻跑测试，
浏览器很可能还在用缓存里的旧文件，测试结果假的。

两个脚本都在开头先注销 Service Worker、删掉全部 cache、清 localStorage，然后再测。
手工验证时也一样：改完代码要么改 `sw.js` 的 `VERSION`，要么先清缓存。
