/* Worksheet Studio service worker.
 *
 * Strategy: precache every app asset at install time, then serve
 * cache-first forever. The app is fully static, so once installed it
 * works with no network at all (airplane mode, no wifi, etc.).
 *
 * Bump CACHE_VERSION whenever any file changes so returning visitors
 * pick up the new build; the activate handler deletes old caches.
 */
'use strict';

const CACHE_VERSION = 'v1';
const CACHE_NAME = 'worksheet-studio-' + CACHE_VERSION;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './css/katex.min.css',
  './css/styles.css',
  './css/fonts/KaTeX_AMS-Regular.woff2',
  './css/fonts/KaTeX_Caligraphic-Bold.woff2',
  './css/fonts/KaTeX_Caligraphic-Regular.woff2',
  './css/fonts/KaTeX_Fraktur-Bold.woff2',
  './css/fonts/KaTeX_Fraktur-Regular.woff2',
  './css/fonts/KaTeX_Main-Bold.woff2',
  './css/fonts/KaTeX_Main-BoldItalic.woff2',
  './css/fonts/KaTeX_Main-Italic.woff2',
  './css/fonts/KaTeX_Main-Regular.woff2',
  './css/fonts/KaTeX_Math-BoldItalic.woff2',
  './css/fonts/KaTeX_Math-Italic.woff2',
  './css/fonts/KaTeX_SansSerif-Bold.woff2',
  './css/fonts/KaTeX_SansSerif-Italic.woff2',
  './css/fonts/KaTeX_SansSerif-Regular.woff2',
  './css/fonts/KaTeX_Script-Regular.woff2',
  './css/fonts/KaTeX_Size1-Regular.woff2',
  './css/fonts/KaTeX_Size2-Regular.woff2',
  './css/fonts/KaTeX_Size3-Regular.woff2',
  './css/fonts/KaTeX_Size4-Regular.woff2',
  './css/fonts/KaTeX_Typewriter-Regular.woff2',
  './js/app.js',
  './js/vendor/html2canvas.min.js',
  './js/vendor/jspdf.umd.min.js',
  './js/vendor/katex.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;
      // Not precached (shouldn't happen for app files): try network,
      // and for page navigations fall back to the cached shell.
      return fetch(event.request).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
