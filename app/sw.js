importScripts("./version.js");

const APP_VERSION = globalThis.HEXABLOOM_VERSION || "dev";
const CACHE_PREFIX = "hexabloom";
const CACHE_NAME = `${CACHE_PREFIX}-${APP_VERSION}`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./main.js",
  "./model.js",
  "./storage.js",
  "./sync.js",
  "./config.js",
  "./version.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];
const APP_SHELL_URLS = new Set(APP_SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll([...APP_SHELL_URLS]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith(`${CACHE_PREFIX}-`) && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, new URL("./index.html", self.registration.scope).href));
    return;
  }

  if (isAppShellRequest(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

function isAppShellRequest(url) {
  const clean = cleanUrl(url);
  return APP_SHELL_URLS.has(clean);
}

async function networkFirst(request, fallbackUrl = "") {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = cleanUrl(new URL(request.url));

  try {
    const response = await fetch(new Request(request, { cache: "no-store" }));
    if (response.ok) await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = cleanUrl(new URL(request.url));
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(cacheKey, response.clone());
  return response;
}

function cleanUrl(url) {
  const copy = new URL(url.href);
  copy.hash = "";
  copy.search = "";
  return copy.href;
}
