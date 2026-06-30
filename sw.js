// ─── Service Worker حقيقي (ملف مستقل بدل Blob) ──────────────────────────────
const CACHE_NAME = 'noc-pwa-v2';
const DB_KEY = 'noc_alarms_v1';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(() => Promise.resolve()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME && k !== DB_KEY).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch: خدمة الصفحة من الكاش ─────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/noc-alarm-data-save')) {
    e.respondWith(
      e.request.json().then(async data => {
        const cache = await caches.open(DB_KEY);
        await cache.put('/noc-alarm-data', new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' }
        }));
        return new Response('ok');
      })
    );
    return;
  }

  if (!e.request.url.startsWith(self.location.origin)) {
    e.respondWith(fetch(e.request).catch(() => new Response('')));
    return;
  }

  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(e.request);
      const fetchPromise = fetch(e.request).then(resp => {
        if (resp && resp.status === 200) cache.put(e.request, resp.clone());
        return resp;
      }).catch(() => null);
      return cached || fetchPromise;
    })
  );
});

// استقبال رسالة لحفظ المنبهات
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SAVE_ALARMS') {
    self._alarmsData = e.data.payload;
  }
});

// فحص دوري (Periodic Background Sync) — مدعوم جزئياً فقط على كروم أندرويد للتطبيقات المثبّتة
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-alarms') {
    e.waitUntil(checkAndFireAlarms());
  }
});

// فحص عبر Push حقيقي — السيرفر يرسل بيانات الإشعار جاهزة بالـ payload
self.addEventListener('push', e => {
  let data = null;
  try { data = e.data ? e.data.json() : null; } catch (err) { data = null; }

  if (data && data.title) {
    e.waitUntil(
      self.registration.showNotification(data.title, {
        body: data.body || '',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        vibrate: [300, 100, 300, 100, 300],
        requireInteraction: true,
        tag: data.tag || 'noc-alarm',
        data: { url: self.location.origin, isFuel: !!data.isFuel }
      })
    );
  } else {
    // توافق رجعي: لو الـ push بدون بيانات، افحص الكاش المحلي كخطة بديلة
    e.waitUntil(checkAndFireAlarms());
  }
});

// ─── شبكة أمان: Backup Sync اختياري عند توفره ───────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'check-alarms-once') {
    e.waitUntil(checkAndFireAlarms());
  }
});

// ─── منطق فحص المنبهات ───────────────────────────────────────────────────────
async function checkAndFireAlarms() {
  let payload;
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length > 0) return; // التطبيق مفتوح، الـ JS الأصلي يتولى الأمر

    const cache = await caches.open(DB_KEY);
    const resp = await cache.match('/noc-alarm-data');
    if (!resp) return;
    payload = await resp.json();
  } catch (e) { return; }

  if (!payload) return;
  const { alarms, states, fuelStart } = payload;
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();
  const dayMs = new Date(now).setHours(0, 0, 0, 0);

  for (const a of alarms) {
    if (!states[a.id]) continue;
    if (a.fuelAlarm) {
      const start = new Date(fuelStart);
      start.setHours(0, 0, 0, 0);
      const diff = Math.floor((dayMs - start.getTime()) / 86400000);
      if (diff < 0 || (diff % 5) !== 4) continue;
    }
    if (a.hour !== h || a.min !== m) continue;

    const title = a.fuelAlarm ? '⛽ تنبيه حصة البنزين' : '🔔 تنبيه وجبة';
    const body = a.fuelAlarm ? '⛽ غداً يوم استلام حصة البنزين!' : (a.icon + ' ' + a.desc);
    await self.registration.showNotification(title, {
      body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: [300, 100, 300, 100, 300],
      requireInteraction: true,
      tag: a.id,
      data: { url: self.location.origin, isFuel: !!a.fuelAlarm }
    });
  }
}

// فتح التطبيق عند الضغط على الإشعار وإرسال أمر تشغيل الصوت
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const notifData = e.notification.data || {};
  const isFuel = notifData.isFuel || false;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async cs => {
      let client;
      if (cs.length > 0) {
        client = cs[0];
        await client.focus();
      } else {
        client = await self.clients.openWindow(notifData.url || './');
        await new Promise(r => setTimeout(r, 1500));
      }
      if (client) client.postMessage({ type: 'PLAY_ALARM_SOUND', isFuel });
    })
  );
});
