// 把网页产物复制到 www/，Capacitor 只把 www/ 里的东西打进 APK。
//
// 用的是「复制白名单」而不是「排除黑名单」：android/、test/、e2e/、node_modules/
// 一概不在名单里，所以永远进不了安装包。以后在仓库根目录新增文件，
// 想让它进 APK 就必须显式加进 ENTRIES —— 这样漏掉是安全的、不会误打进去。
//
// 注意：sw.js 故意不在名单里。APK 里的页面本身就是本地资源，不需要 Service Worker；
// 反而留着它会让升级后还显示上一版页面（SW 缓存优先）。
import { rm, mkdir, cp, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');

// 缺一个就报错停下，不要静默打出一个缺文件的包
const ENTRIES = [
  'index.html',
  'app.js',
  'core.js',
  'manifest.json',
  'icons',
  'vendor',
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const name of ENTRIES) {
  const src = path.join(root, name);
  try {
    await stat(src);
  } catch {
    throw new Error(`缺少文件：${name}`);
  }
  await cp(src, path.join(out, name), { recursive: true });
}

console.log(`www/ 已生成：${ENTRIES.join(', ')}（不含 sw.js）`);
