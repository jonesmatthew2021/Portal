/* The portal's service worker: keeps the last-loaded portal readable when
   the link drops.

   At sea the link goes, and a page opened then showed nothing. This worker
   keeps one copy of the page, of React, React DOM and the fonts, and of
   the last good answer to the four calls the page reads by (/api/me,
   /api/state, /api/files, /api/sync/last), each stamped with the time it
   was fetched so the page can say how old what it shows is. Network first,
   always: the copy is used only when the network fails or has not answered
   in NETWORK_WAIT_MS, and every good answer replaces the copy - so a deploy
   is picked up the moment the link is up, and a stale page is never
   preferred to a live one. Nothing else is ever kept: file bytes, the CDN
   scripts, the fauna app and every write go straight to the network and,
   offline, fail as they always did.

   Built into worker/assets/sw.js by worker/scripts/build-assets.mjs, which
   writes the build's stamp in as VERSION and folds source/shared/offline-
   rules.js in at the marker below. A new build is a new worker with a new
   cache; on taking over it deletes every other cache, carrying the four
   kept answers across so there is never a moment with nothing to read. A
   worker left over from years ago, which once served a months-old page,
   goes the same way: its caches are not this build's.

   The rules themselves (what is kept, under what name, when a copy is
   worth keeping) are in offline-rules.js and proved by
   tools/client-rules.test.mjs. This file only does the work. */

const VERSION = "__BUILD_VERSION__";

/* @offline-rules */

const NAME = cacheName(VERSION);
const ORIGIN = self.location.origin;
const VENDOR = [
  "/vendor/react.production.min.js",
  "/vendor/react-dom.production.min.js",
];

/* A copy of an answer, stamped with the time it was fetched. The body is
   read whole so the stamp can be set on a fresh Response: an answer's own
   headers cannot be changed. */
async function stamped(answer) {
  const headers = new Headers(answer.headers);
  headers.set(FETCHED_AT_HEADER, new Date().toISOString());
  return new Response(await answer.arrayBuffer(), { status: answer.status, statusText: answer.statusText, headers });
}

/* Keeps a good answer under its key. A live /api/me for somebody other
   than the person whose copies are kept clears the kept answers first, so
   nobody reads the last person's portal offline. */
async function keep(cache, kind, key, answer) {
  if (!keepable(kind, answer.status, answer.headers)) return;
  const copy = await stamped(answer);
  if (key === "/api/me") {
    const before = await cache.match(key);
    const kept = before ? await before.clone().json().catch(() => null) : null;
    const live = await copy.clone().json().catch(() => null);
    if (anotherPerson(kept, live)) await Promise.all(KEPT_APIS.map((k) => cache.delete(k)));
  }
  await cache.put(key, copy);
}

/* Fetches and keeps one address, and says nothing if it cannot: what is
   kept at install is a head start, not a condition of installing. */
async function fetchAndKeep(cache, kind, key) {
  try {
    await keep(cache, kind, key, await fetch(key, { credentials: "same-origin" }));
  } catch (e) {}
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(NAME);
    await Promise.all([
      fetchAndKeep(cache, "page", "/"),
      fetchAndKeep(cache, "api", "/api/me"),
      ...VENDOR.map((key) => fetchAndKeep(cache, "vendor", key)),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const mine = await caches.open(NAME);
    for (const name of await caches.keys()) {
      if (name === NAME) continue;
      // The kept answers are the crew's data, not this build's code: they
      // come across, so a deploy does not leave a phone with nothing to
      // read until its next poll. What this build has already kept wins.
      const old = await caches.open(name);
      for (const key of KEPT_APIS) {
        const kept = await old.match(key);
        if (kept && !(await mine.match(key))) await mine.put(key, kept);
      }
      await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

/* Everything kept goes: the page's word on sign-out, and the sign-out
   address itself in case the word never arrived. */
const forget = () => caches.delete(NAME);

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === FORGET_MESSAGE) event.waitUntil(forget());
});

/* Network first: the network's answer if it comes in time, else the kept
   copy, else whatever the network finally says (its failure included, so
   the page sees exactly what it saw before this worker existed). A good
   answer refreshes the copy even when the wait was lost, so the next
   look is current. */
async function networkFirst(event, kind) {
  const key = cacheKey(event.request.url);
  const cache = await caches.open(NAME);
  const fromNetwork = fetch(event.request).then(async (answer) => {
    await keep(cache, kind, key, answer.clone());
    return answer;
  });
  event.waitUntil(fromNetwork.catch(() => {}));
  const wait = new Promise((done) => setTimeout(() => done(null), NETWORK_WAIT_MS));
  const answer = await Promise.race([fromNetwork.catch(() => null), wait]);
  if (answer) return answer;
  const kept = await cache.match(key);
  if (kept) return kept;
  return fromNetwork;
}

/* The kept copy first: a build's React and fonts never change under it. */
async function cacheFirst(event) {
  const cache = await caches.open(NAME);
  const kept = await cache.match(event.request);
  if (kept) return kept;
  const answer = await fetch(event.request);
  if (keepable("vendor", answer.status, answer.headers)) await cache.put(event.request, answer.clone());
  return answer;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode === "navigate" && cacheKey(request.url) === "/logout") {
    event.waitUntil(forget());
    return;
  }
  const kind = cacheable(request.method, request.url, ORIGIN);
  if (!kind) return;               // the browser does what it always did
  event.respondWith(kind === "vendor" ? cacheFirst(event) : networkFirst(event, kind));
});
