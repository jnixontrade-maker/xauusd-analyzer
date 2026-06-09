// Service Worker — handles push notifications when app is closed
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-64.png',
    vibrate: [200, 100, 200],
    tag: 'xauusd-signal',
    renotify: true,
    data: {
      signal:     data.signal,
      confidence: data.confidence,
      entry:      data.entry,
      sl:         data.sl,
      tp1:        data.tp1,
      tp2:        data.tp2,
      url:        '/'
    },
    actions: [
      { action: 'view',    title: '📊 View Chart' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ]
  };

  e.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow('/');
    })
  );
});
