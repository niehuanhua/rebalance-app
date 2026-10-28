// 打安卓安装包（debug 版，手机可以直接装）。
//
// 前提：先跑过 `npm run android:sync`，把网页产物同步进 android/app/src/main/assets/public。
// `npm run android:apk` 会一次性把 sync 和 build 都跑完。
//
// 为什么要这个脚本而不直接敲 ./gradlew：Gradle 需要知道 JDK 和 Android SDK 在哪，
// 而这两样都装在 ~/android-dev/ 下面（不在这台机器的常规位置），
// 每次手动 export 环境变量太容易忘。写死在这里，一条命令就出包。
//
// 用法：node scripts/build-apk.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = path.join(ROOT, 'android');

// 允许用环境变量覆盖；不设就用这台机器装好的位置
const JAVA_HOME = process.env.JAVA_HOME
  || '/Users/niehuanhuan/android-dev/jdk/jdk-17.0.20.1+1/Contents/Home';
const ANDROID_HOME = process.env.ANDROID_HOME
  || '/Users/niehuanhuan/android-dev/sdk';

for (const [label, dir] of [['JDK', JAVA_HOME], ['Android SDK', ANDROID_HOME]]) {
  if (!existsSync(dir)) {
    throw new Error(`${label} 找不到：${dir}\n位置变了的话，用环境变量 JAVA_HOME / ANDROID_HOME 指定。`);
  }
}

// local.properties 是 Gradle 找 SDK 的入口，git 里没有它（每台机器路径不同），缺了就补
const localProps = path.join(ANDROID_DIR, 'local.properties');
if (!existsSync(localProps)) {
  writeFileSync(localProps, `sdk.dir=${ANDROID_HOME}\n`);
  console.log(`已创建 local.properties：sdk.dir=${ANDROID_HOME}`);
}

const env = {
  ...process.env,
  JAVA_HOME,
  ANDROID_HOME,
  ANDROID_SDK_ROOT: ANDROID_HOME,
  // Gradle 下载依赖需要走网络，这行只是让它别弹交互式许可确认
  GRADLE_OPTS: '-Dorg.gradle.jvmargs=-Xmx2g',
};

const gradlew = path.join(ANDROID_DIR, 'gradlew');
console.log('开始打包（第一次会下载 Gradle 8.2.1 和依赖，约 5–10 分钟；之后每次 20 秒左右）…');

const res = spawnSync(gradlew, ['assembleDebug', '--no-daemon', '--console=plain'], {
  cwd: ANDROID_DIR,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (res.error) throw res.error;
if (res.status !== 0) throw new Error(`Gradle 打包失败（退出码 ${res.status}），上面是它的输出。`);

const apk = path.join(ANDROID_DIR, 'app/build/outputs/apk/debug/app-debug.apk');
if (!existsSync(apk)) throw new Error(`Gradle 说成功了，但没找到 ${apk}`);

const dist = path.join(ROOT, 'dist');
mkdirSync(dist, { recursive: true });
const out = path.join(dist, 'rebalance-debug.apk');
copyFileSync(apk, out);

const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`\n安装包已生成：${out}（${mb} MB）`);
console.log('装到手机：把文件传到手机点击安装，或连上数据线后跑');
console.log(`  ${ANDROID_HOME}/platform-tools/adb install -r "${out}"`);
