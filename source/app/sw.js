/* The portal's service worker: keeps the last-loaded portal readable when
   the link drops.

   At sea the link goes, and a page opened then showed nothing. This worker
   keeps one copy of the page, of React, React DOM and the fonts, and of
   the last good answer to the four calls the page reads by (/api/me,
   /api/state, /api/files, /api/sync/last), each stamped with the time it
   was fetched so the page can say how old what it shows is. Network first,
   always: the copy is used only when the network fails or has not started
   answering in networkWait(kind, key), and every good answer replaces the copy -
   so a deploy is picked up the moment the link is up, and a stale page is
   never preferred to a live one. Nothing else is ever kept: file bytes,
   the CDN scripts, the fauna app and every write go straight to the
   network and, offline, fail as they always did.

   Built into worker/assets/sw.js by worker/scripts/build-assets.mjs, which
   writes the build's stamp in as VERSION and folds source/shared/offline-
   rules.js in at the marker below. A new build is a new worker with a new
   cache; on taking over it deletes every other cache, carrying the four
   kept answers across from an earlier build's cache (and only from one of
   those) so there is never a moment with nothing to read. A worker left
   over from years ago, which once served a months-old page, goes the same
   way: its caches are not this build's, and nothing in them is carried.

   The rules themselves (what is kept, under what name, when a copy is
   worth keeping, when everything kept must go) are in offline-rules.js and
   proved by tools/client-rules.test.mjs, which also runs this file against
   a pretend network. This file only does the work. */

const VERSION = "__BUILD_VERSION__";

/* @offline-rules */

const NAME = cacheName(VERSION);
const ORIGIN = self.location.origin;
/* React, React DOM and the fonts, as the build found them under
   source/vendor: kept at install, so the first visit's fonts - fetched
   before this worker stood in front of the page - are there offline too. */
const VENDOR = __VENDOR_FILES__;

/* A copy of an answer, stamped with the time it was fetched. The body is
   read whole so the stamp can be set on a fresh Response: an answer's own
   headers cannot be changed. The body read here is the decoded one, so the
   edge's Content-Encoding and Content-Length come off the copy - left on,
   the browser would try to decode the kept page a second time. */
async function stamped(answer) {
  const headers = new Headers(answer.headers);
  headers.set(FETCHED_AT_HEADER, new Date().toISOString());
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(await answer.arrayBuffer(), { status: answer.status, statusText: answer.statusText, headers });
}

/* The crew's answers go: the page and the four kept calls. The vendor
   files stay - they are this build's code, not anybody's data. */
const forgetKept = (cache) => Promise.all([...KEPT_APIS, "/"].map((k) => cache.delete(k)));

/* Keeps a good answer under its key. A live /api/me for somebody other
   than the person whose copies are kept clears the kept answers first, so
   nobody reads the last person's portal offline; and an answer that says
   the sign-in is over (forgetsOn) clears them and keeps nothing. */
async function keep(cache, kind, key, answer) {
  if (forgetsOn(kind, answer.status, answer.headers)) { await forgetKept(cache); return; }
  if (!keepable(kind, answer.status, answer.headers)) return;
  const copy = await stamped(answer);
  if (key === "/api/me") {
    const before = await cache.match(key);
    const kept = before ? await before.clone().json().catch(() => null) : null;
    const live = await copy.clone().json().catch(() => null);
    if (anotherPerson(kept, live)) await forgetKept(cache);
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

/* What is kept at install is a head start, not a condition of installing:
   a cache the phone will not give (openCache null) means the worker
   installs with nothing kept and the page reads from the network, plain.
   Before this the install failed on the cache, the worker went redundant,
   and the browser registered it again - and failed again - on every page
   load, so that phone never read offline.

   Who is signed in is never asked here. An install runs on whatever
   cookie the device holds at that instant, and the browser finds a deploy
   on a navigation this worker handles - the sign-in POST and the sign-out
   included - so the new build installed while the old worker was still
   sending the code or the sign-out on: asked then, /api/me answered the
   last person, whose cookie the 303 had not yet replaced or revoked, and
   they were kept in the new cache, which nothing ever forgot. The first
   build's head start on /api/me is the page's to give: once this worker
   takes control the page asks /api/me again, from a boot the server has
   already answered as the cookie's person, and that answer is kept the
   ordinary way. On a deploy the person's copy comes across from the
   earlier build's cache on taking over (carry). */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await openCache();
    if (cache) {
      await Promise.all([
        fetchAndKeep(cache, "page", "/"),
        ...VENDOR.map((key) => fetchAndKeep(cache, "vendor", key)),
      ]);
    }
    await self.skipWaiting();
  })());
});

/* The kept answers are the crew's data, not a build's code: they come
   across from an earlier build's cache, so a deploy does not leave a phone
   with nothing to read until its next poll. Only a stamped copy comes
   (anything else is not one of this worker's), what this build has
   already kept wins, and nothing comes from a cache whose /api/me is a
   different person from the one this build has already kept - the last
   person's document must not land in the next person's cache. */
async function carry(old, mine) {
  const who = async (cache) => {
    const kept = await cache.match("/api/me");
    return kept ? await kept.clone().json().catch(() => null) : null;
  };
  const [was, am] = await Promise.all([who(old), who(mine)]);
  if (am && anotherPerson(was, am)) return;
  for (const key of KEPT_APIS) {
    const kept = await old.match(key);
    if (kept && isCachedAnswer(kept.headers) && !(await mine.match(key))) await mine.put(key, kept);
  }
}

/* The open page is claimed whatever the caches do: with the phone's
   storage gone the carry and the clearing fail, and the page would
   otherwise be left uncontrolled until its next navigation. */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const mine = await caches.open(NAME);
      for (const name of await caches.keys()) {
        if (name === NAME) continue;
        if (earlierPortalCache(name, NAME)) await carry(await caches.open(name), mine);
        await caches.delete(name);
      }
    } catch (e) {}
    await self.clients.claim();
  })());
});

/* Everything kept goes: the page's word on sign-out, and the sign-out
   address itself in case the word never arrived. */
const forget = () => caches.delete(NAME);

/* The sign-out and the sign-in's completing request (forgetsBefore) are
   answered by this worker itself: what is kept goes first, then the
   request is sent on and the server's answer - the 303 the browser
   follows - handed back as it is. Answered here rather than left to the
   browser with the deletes running alongside, because the deletes must be
   done before the browser follows the 303 and the page opens: on a
   sign-in it opens for the new person and asks /api/me at once, and a
   copy still kept then was the last person's. The sign-out takes the
   whole cache, as its word from the page does; a sign-in takes the crew's
   answers and leaves the build's own files, which the new person's page
   needs too. The cache failing never fails the request (openCache).

   A sign-in answered is also told to every open portal tab (SIGNED_IN_
   MESSAGE): a tab already open as the last person would otherwise poll
   and save under the new cookie while still calling itself the last
   person, for as long as it stayed open. Told, it asks the server who
   this is (proveIdentity) and reloads as them. Told after the answer is
   in, so the cookie is already the new one when the tab asks; a tab that
   cannot be told is no worse off than before. */
async function forgetThen(what, request) {
  try {
    if (what === "signOut") await forget();
    else { const cache = await openCache(); if (cache) await forgetKept(cache); }
  } catch (e) {}
  const answer = await fetch(request);
  if (what === "signIn") {
    try {
      (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
        .forEach((tab) => tab.postMessage({ type: SIGNED_IN_MESSAGE }));
    } catch (e) {}
  }
  return answer;
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === FORGET_MESSAGE) event.waitUntil(forget());
});

/* Network first: the network's answer if it starts coming in time, else
   the kept copy, else whatever the network finally says (its failure
   included, so the page sees exactly what it saw before this worker
   existed). The race is on the fetch itself - it settles when the headers
   are in, and the body then streams to the page at the link's own speed -
   never on the copy being kept, which reads the whole body first: raced on
   that, a slow link would lose to the timer every poll and a connected
   portal would be shown its kept copy and go read only. The copy is kept
   in the background, so a good answer refreshes it even when the wait was
   lost and the next look is current. */
/* This build's cache, or null when the phone will not give one: storage
   full or corrupted, caches.open rejecting. Then there is nothing to read
   from or keep in, and the request goes to the network plain. The cache
   failing must never fail the request: before this, a phone whose storage
   had gone showed "Couldn't reach the portal" with the link up, on every
   navigation and every poll, until the worker was unregistered. The
   reads below are guarded the same way, as the keeps already were. */
async function openCache() {
  try {
    return await caches.open(NAME);
  } catch (e) {
    return null;
  }
}

async function networkFirst(event, kind) {
  const key = cacheKey(event.request.url);
  const cache = await openCache();
  if (!cache) return fetch(event.request);
  const fromNetwork = fetch(event.request);
  // The clone is taken the moment the answer is in, before the page has
  // started reading the body: this handler was set first, so it runs first.
  event.waitUntil(fromNetwork.then((answer) => keep(cache, kind, key, answer.clone())).catch(() => {}));
  const wait = new Promise((done) => setTimeout(() => done(null), networkWait(kind, key)));
  const answer = await Promise.race([fromNetwork.catch(() => null), wait]);
  if (answer) return answer;
  const kept = await cache.match(key).catch(() => null);
  if (kept) return kept;
  return fromNetwork;
}

/* The kept copy first: a build's React and fonts never change under it. */
async function cacheFirst(event) {
  const cache = await openCache();
  if (!cache) return fetch(event.request);
  const kept = await cache.match(event.request).catch(() => null);
  if (kept) return kept;
  const answer = await fetch(event.request);
  // A copy that cannot be kept (storage full) is still the live file.
  if (keepable("vendor", answer.status, answer.headers)) await cache.put(event.request, answer.clone()).catch(() => {});
  return answer;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const goes = forgetsBefore(request.method, request.url, ORIGIN);
  if (goes) {
    event.respondWith(forgetThen(goes, request));
    return;
  }
  const kind = cacheable(request.method, request.url, ORIGIN);
  if (!kind) return;               // the browser does what it always did
  event.respondWith(kind === "vendor" ? cacheFirst(event) : networkFirst(event, kind));
});
