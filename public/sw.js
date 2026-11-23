'use strict';
// Outlier's service worker. It only shows streak reminders: no fetch handler and no caching,
// so the app itself always comes straight from the server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Outlier', {
    body: d.body || "Today's Daily seven is waiting",
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: d.tag || 'streak',   // a newer reminder replaces an older one rather than stacking up
    data: { url: d.url || '/' },
  }));
});

// Tapping the reminder: bring an open Outlier tab forward (left where it was, in case a game is under way),
// or open the app on the main menu.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (open) { try { return await open.focus(); } catch { /* focus refused: open a fresh one instead */ } }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
