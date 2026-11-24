// Service worker: shows notifications for new messages, even when the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (_) { data = { title: 'SafeChat', body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'SafeChat', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: data.jid || 'safechat', // one notification per chat, newest replaces older
    renotify: true,
    data: { jid: data.jid },
    vibrate: [100, 50, 100],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = '/' + (event.notification.data?.jid ? '?chat=' + encodeURIComponent(event.notification.data.jid) : '');
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        c.postMessage({ type: 'open-chat', jid: event.notification.data?.jid });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
