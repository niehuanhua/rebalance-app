/* Service worker —— 让页面关掉网络也能打开，并且能被“安装”成独立 App。
 *
 * 策略：
 *   - 打开页面（navigate）：先要网络，拿不到才用缓存。这样改完推送后，手机一打开就是新版。
 *   - 其它静态文件：先用缓存，同时后台悄悄更新。省流量、启动快。
 *
 * 改了这个文件一定要改 VERSION，否则手机上的旧缓存不会被清掉。
 */
const VERSION = 'v1';
const CACHE = `rebalance-${VERSION}`;

// 只要有一个文件 404，整个安装就会失败（缓存是整批写入的）。
// 所以这份清单里的每个路径都必须真实存在。
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './vendor/xlsx.full.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const sameOrigin = new URL(req.url).origin === self.location.origin;
  if (!sameOrigin) return;

  // 打开页面：网络优先
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req, { ignoreSearch: true });
          return cached || caches.match('./index.html');
        })
    );
    return;
  }

  // 静态文件：缓存优先 + 后台更新
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) {
        fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
