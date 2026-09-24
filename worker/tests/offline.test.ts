/**
 * The offline reading, on the worker's side: the service worker and the
 * vendor files are public and carry the headers the service worker needs,
 * the page is marked as the page and the sign-in form is not, /api/state
 * still answers no-store (the service worker decides what is kept, never
 * the browser's cache), and the assets build wrote the worker with its
 * version and the vendor files as they are in source/vendor.
 *
 *   npx tsx --test tests/offline.test.ts      (or: node tools/check.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gate, publicPath } from "../src/auth.js";
import { assetHeaders, withAssetHeaders } from "../src/lib/offline.js";
import state from "../src/routes/state.js";
import { setEnv } from "../src/env.js";
import { fakeDb } from "./helpers.js";
import worker from "../src/index.js";
import { crewStateView } from "../src/authz.js";
import { forgetsOn, keepable, PAGE_HEADER } from "../../source/shared/offline-rules.js";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(WORKER, "..");
const ask = (path: string) => gate(new Request("https://portal.example" + path), path);

test("the service worker and the vendor files are fetched outside any sign-in", async () => {
  for (const path of ["/sw.js", "/vendor/react.production.min.js", "/vendor/react-dom.production.min.js",
    "/vendor/fonts/archivo-narrow-latin-700-normal.woff2"]) {
    assert.equal(publicPath(path), true, path + " is public");
    const { barred, user } = await ask(path);
    assert.equal(barred, null, path + " passes the gate with no session");
    assert.equal(user, null);
  }
  assert.equal(publicPath("/vendor"), false, "only files under /vendor/ are public, not the folder's name");
  assert.equal(publicPath("/api/state"), false);
});

test("the page without a session is still the sign-in form, and /api without one is 401", async () => {
  const page = await ask("/");
  assert.ok(page.barred, "no session: the sign-in form stands in for the page");
  assert.equal(page.barred!.status, 200);
  assert.match(page.barred!.headers.get("Content-Type") || "", /text\/html/);
  assert.equal(page.barred!.headers.get(PAGE_HEADER), null, "…and it does not carry the page's mark");
  assert.equal(keepable("page", page.barred!.status, page.barred!.headers), false,
    "so the service worker never keeps the sign-in form as the page");
  assert.equal(forgetsOn("page", page.barred!.status, page.barred!.headers), true,
    "…and, seeing it where the page should be, lets go of everything it kept: nobody is signed in on this device");
  const api = await ask("/api/state");
  assert.equal(api.barred!.status, 401);
  assert.equal(keepable("api", api.barred!.status, api.barred!.headers), false, "a refused call is never kept");
  assert.equal(forgetsOn("api", api.barred!.status, api.barred!.headers), true,
    "…and clears the kept answers: a sign-in that is over online is over offline too");
});

test("/sw.js is served no-cache and allowed the whole site; the page carries its mark; nothing else changes", () => {
  assert.deepEqual(assetHeaders("/sw.js"), { "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
  assert.deepEqual(assetHeaders("/"), { [PAGE_HEADER]: "portal" });
  assert.deepEqual(assetHeaders("/vendor/react.production.min.js"), {});
  assert.deepEqual(assetHeaders("/fauna/"), {});
  assert.deepEqual(assetHeaders("/crew-list-form.html"), {});

  const asset = new Response("// worker", { status: 200, headers: { "Content-Type": "text/javascript", ETag: "\"abc\"" } });
  const served = withAssetHeaders("/sw.js", asset);
  assert.equal(served.headers.get("Cache-Control"), "no-cache");
  assert.equal(served.headers.get("Service-Worker-Allowed"), "/");
  assert.equal(served.headers.get("Content-Type"), "text/javascript", "the asset layer's own headers stay");
  assert.equal(served.headers.get("ETag"), "\"abc\"");
  assert.equal(served.status, 200);

  const page = withAssetHeaders("/", new Response("<html>", { headers: { "Content-Type": "text/html" } }));
  assert.equal(keepable("page", page.status, page.headers), true, "the page as the worker serves it is kept");

  const untouched = new Response("bytes");
  assert.equal(withAssetHeaders("/vendor/react.production.min.js", untouched), untouched, "an answer with nothing to add is passed through as is");
});

test("/api/state still answers no-store: keeping a copy is the service worker's decision, not the browser cache's", async () => {
  const db = fakeDb((sql) => (/SELECT data, rev FROM portal_state/.test(sql) ? { results: [{ data: "{\"people\":[]}", rev: 7 }] } : undefined));
  setEnv({ DB: db } as never);
  const answer = await state(new Request("https://portal.example/api/state"));
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await answer.json(), { rev: 7, data: { people: [] } });
});

test("the assets build wrote the service worker with its version, the rules folded in, and the vendor files as they are", () => {
  const built = join(WORKER, "assets", "sw.js");
  assert.ok(existsSync(built), "worker/assets/sw.js is missing - run: node tools/build.mjs");
  const sw = readFileSync(built, "utf8");
  const version = /^const VERSION = "([0-9a-f]{32})";$/m.exec(sw);
  assert.ok(version, "the worker carries the build's stamp as its VERSION");
  assert.equal(sw.includes("__BUILD_VERSION__"), false);
  assert.equal(sw.includes("/* @offline-rules */"), false, "the rules marker was replaced");
  assert.ok(sw.includes("/* ---- source/shared/offline-rules.js ---- */"), "the rules are folded in under their header");
  assert.ok(/^function cacheable\(/m.test(sw), "…with the export taken off, as the page has them");
  assert.equal(/^\s*export\b/m.test(sw), false, "no export reaches the worker: it is a plain script");
  assert.ok(/^import /m.test(sw) === false);
  // The install fetches only the vendor files - the build's own code -
  // and never asks who is signed in nor for the page: it runs on whatever
  // cookie the device holds at that instant, mid sign-out included. The
  // page gives the first kept /api/me and the first kept page itself.
  assert.equal(sw.includes('fetchAndKeep(cache, "api"'), false, "the shipped worker's install never fetches an API answer");
  assert.equal(sw.includes('fetchAndKeep(cache, "page"'), false, "…nor the page");
  assert.ok(sw.includes("SIGNED_IN_MESSAGE"), "…and tells the open tabs when a sign-in is answered");
  // A copy fetched before a forget is never kept after it: every forget
  // bumps the era, and a keep from an earlier era is dropped.
  assert.ok(/^let era = 0;$/m.test(sw), "the shipped worker carries the era a forget bumps");
  const vendorList = /^const VENDOR = (\[.*\]);$/m.exec(sw);
  assert.ok(vendorList, "the worker carries the list of vendor files it keeps at install");
  const kept = JSON.parse(vendorList![1]) as string[];
  assert.ok(kept.includes("/vendor/react.production.min.js") && kept.includes("/vendor/react-dom.production.min.js"));
  assert.equal(kept.filter((p) => p.endsWith(".woff2")).length, 18, "…the eighteen fonts among them: latin and latin-ext, three families, three weights");
  assert.equal(kept.some((p) => p.endsWith(".txt")), false, "…and not the licences");
  // The version is a hash of the compiled page and every file the worker
  // keeps, the fonts included: the vendor files are served from the cache
  // first and only a new version refetches them, so a font replaced under
  // the same name must make a new version or the old one is served for ever.
  const stamp = createHash("md5").update(readFileSync(join(WORKER, "assets", "index.html")));
  for (const p of kept) stamp.update(readFileSync(join(WORKER, "assets", ...p.slice(1).split("/"))));
  assert.equal(version![1], stamp.digest("hex"), "the version is the hash of the page and every kept vendor file, the fonts included");
  // The worker file parses as a script. Compiled, never run: it reads
  // self.location at the top, which only a browser has.
  assert.doesNotThrow(() => new Function(sw), "worker/assets/sw.js does not parse");

  const walk = (dir: string, rel = ""): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name), rel + d.name + "/") : [rel + d.name]);
  const source = join(REPO, "source", "vendor");
  const assets = join(WORKER, "assets", "vendor");
  const files = walk(source);
  assert.ok(files.includes("react.production.min.js") && files.includes("react-dom.production.min.js"));
  assert.equal(files.filter((f) => f.endsWith(".woff2")).length, 18, "three families, three weights each, latin and latin-ext");
  assert.deepEqual(walk(assets).sort(), files.sort(), "the assets carry exactly the files source/vendor has");
  for (const f of files) {
    assert.equal(Buffer.compare(readFileSync(join(source, f)), readFileSync(join(assets, f))), 0, "worker/assets/vendor/" + f + " is byte for byte source/vendor/" + f);
  }
});

/* ------------------------------------------------------------------------ *
 * The crew's copy of the document. GET /api/state hands the whole document
 * to every signed-in grant, and a crew phone keeps that answer offline.
 * Crew never see Crew Details, so the two boxes the round fills there -
 * each man's MSIC number and date of birth - and the round's note of what
 * it put in them leave the server only for management and IT.
 * ------------------------------------------------------------------------ */

const SID = "a".repeat(48);
type Grant = { id: string; email: string; name: string; role: "it" | "management" | "crew" };
const CREW: Grant = { id: "u1", email: "deckhand@example.com", name: "Alan Deckhand", role: "crew" };
const MANAGER: Grant = { id: "u2", email: "master@example.com", name: "Matthew", role: "management" };
const IT: Grant = { id: "u3", email: "it@example.com", name: "IT Help", role: "it" };

/** The document with one man's boxes filled by the round and another's
 *  typed by hand, and the round's note of what it filled. */
const boxesDoc = () => ({
  people: [
    { id: "p1", name: "EVANS, Brenton", rank: "Master", msic: "MSIC 1111", dob: "1980-03-10" },
    { id: "p2", name: "SITTIYOS, Kachin", rank: "Deckhand", msic: "TYPED 2", dob: "1975-05-05" },
  ],
  particularsFromCert: { p1: { msic: "MSIC 1111", dob: "1980-03-10", was: { msic: ["MSIC 0001"] } } },
  comments: [{ id: "c1", text: "hello" }],
  quals: { cols: [], rows: [] },
});

/** A portal whose one row holds `doc` at revision 3, signed in as `user`. */
function signedInPortal(doc: Record<string, unknown>, user: Grant) {
  const state = { data: JSON.stringify(doc), rev: 3 };
  const db = fakeDb((sql, args) => {
    if (/FROM sessions s/.test(sql)) return { results: [user] };
    if (/PRAGMA table_info/.test(sql)) return { results: [{ name: "adopted_from_folder" }, { name: "kept_in_place" }, { name: "evidence_kind" }] };
    if (/SELECT data, rev FROM portal_state/.test(sql)) return { results: [{ ...state }] };
    if (/SELECT data FROM portal_state/.test(sql)) return { results: [{ data: state.data }] };
    if (/UPDATE portal_state SET data/.test(sql)) {
      if (args[3] !== state.rev) return { changes: 0 };
      state.data = String(args[1]); state.rev++;
      return { changes: 1 };
    }
    if (/portal_state_history/.test(sql)) return { results: [], changes: 1 };
    return undefined;
  });
  const env = { DB: db };
  setEnv(env as never);
  const ask = (method: string, body?: unknown) => worker.fetch(new Request("https://portal.example/api/state", {
    method, headers: { cookie: "portal_session=" + SID, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env as never);
  return { state, ask, doc: () => JSON.parse(state.data) };
}

test("a crew login's GET /api/state carries no man's MSIC number or date of birth, nor the round's note of them; management and IT get the whole document", async () => {
  const crew = signedInPortal(boxesDoc(), CREW);
  const answer = await crew.ask("GET");
  assert.equal(answer.status, 200);
  const got = (await answer.json()) as { rev: number; data: Record<string, unknown> };
  assert.equal(got.rev, 3);
  assert.deepEqual(got.data.people, [
    { id: "p1", name: "EVANS, Brenton", rank: "Master" },
    { id: "p2", name: "SITTIYOS, Kachin", rank: "Deckhand" },
  ], "the filled boxes and the typed ones alike are not there");
  assert.equal("particularsFromCert" in got.data, false, "nor what the round put in them");
  assert.deepEqual(got.data.comments, [{ id: "c1", text: "hello" }], "the rest of the document is as it is");
  assert.equal(keepable("api", answer.status, answer.headers), true,
    "this answer is the one a crew phone keeps offline, so the kept copy never holds them either");

  for (const who of [MANAGER, IT]) {
    const theirs = signedInPortal(boxesDoc(), who);
    const whole = (await (await theirs.ask("GET")).json()) as { data: Record<string, unknown> };
    assert.deepEqual(whole.data, boxesDoc(), who.role + " reads the document as it is");
  }
});

test("the crew's copy is the same document with only the three taken off, and a document without them is untouched", () => {
  const text = JSON.stringify(boxesDoc());
  const view = JSON.parse(crewStateView(7, text));
  const { particularsFromCert: _f, ...rest } = boxesDoc();
  assert.deepEqual(view, { ...rest, people: rest.people.map(({ msic: _m, dob: _d, ...p }) => p) });
  const plain = JSON.stringify({ people: [{ name: "EVANS, Brenton" }], comments: [] });
  assert.equal(crewStateView(8, plain), plain, "nothing to take off: the same bytes go out");
  assert.equal(crewStateView(9, "not json {"), "{}", "a document that will not parse hands crew nothing rather than everything");
  // People that are not a list, and a person that is not a record, are left as they are.
  assert.equal(crewStateView(10, JSON.stringify({ people: "odd" })), JSON.stringify({ people: "odd" }));
  assert.equal(crewStateView(11, JSON.stringify({ people: [null, 3, { msic: "X" }] })), JSON.stringify({ people: [null, 3, {}] }));
});

test("a crew save cannot blank or change a man's MSIC number or date of birth, or the round's note of them; a management save can", async () => {
  const crew = signedInPortal(boxesDoc(), CREW);
  // The tab's document, as crew were handed it: no boxes and no note - and
  // then with the boxes made up, which a page could only do if tampered with.
  const sent = boxesDoc();
  for (const p of sent.people as Record<string, unknown>[]) { delete p.msic; delete p.dob; }
  delete (sent as Record<string, unknown>).particularsFromCert;
  sent.comments = [{ id: "c1", text: "hello" }, { id: "c2", text: "a comment" }];
  const saved = await crew.ask("PUT", { rev: 3, data: sent });
  assert.equal(saved.status, 200, await saved.text());
  assert.deepEqual(crew.doc().people, boxesDoc().people, "every box is as it was");
  assert.deepEqual(crew.doc().particularsFromCert, boxesDoc().particularsFromCert);
  assert.deepEqual(crew.doc().comments, sent.comments, "the comment went in");

  const forged = boxesDoc();
  (forged.people[0] as Record<string, unknown>).msic = "MSIC 9999";
  (forged.people[1] as Record<string, unknown>).dob = "";
  (forged as Record<string, unknown>).particularsFromCert = { p2: { msic: "TYPED 2" } };
  const again = await crew.ask("PUT", { rev: 4, data: forged });
  assert.equal(again.status, 200);
  assert.deepEqual(crew.doc().people, boxesDoc().people, "different ones sent: the stored values are as they were");
  assert.deepEqual(crew.doc().particularsFromCert, boxesDoc().particularsFromCert);

  // A crew save on a stale revision is answered with the crew's copy too.
  const stale = await crew.ask("PUT", { rev: 3, data: sent });
  assert.equal(stale.status, 409);
  const back = (await stale.json()) as { conflict: boolean; data: Record<string, unknown> };
  assert.equal(back.conflict, true);
  assert.equal("particularsFromCert" in back.data, false, "the conflict's copy of the document is the crew's copy");
  assert.equal("msic" in (back.data.people as Record<string, unknown>[])[0], false);

  const mgmt = signedInPortal(boxesDoc(), MANAGER);
  const changed = boxesDoc();
  (changed.people[0] as Record<string, unknown>).msic = "MSIC 2222";
  (changed as Record<string, unknown>).particularsFromCert = { p1: { msic: "MSIC 2222" } };
  const ok = await mgmt.ask("PUT", { rev: 3, data: changed });
  assert.equal(ok.status, 200);
  assert.equal(mgmt.doc().people[0].msic, "MSIC 2222", "management's save changes the box");
  assert.deepEqual(mgmt.doc().particularsFromCert, { p1: { msic: "MSIC 2222" } });
});

test("a crew login is never handed a man's printed medical limitation", () => {
  /* The round reads any limitation printed on a certificate ("fit for
     particular duties only", MO76 s 7(1)(b)) and the date of the examination
     (s 16(1)) and puts them in certDates, which is shared document state - so
     without this they went to every crew login and were kept on every crew
     phone offline. They are shown on the certificate viewer, to management,
     and nowhere else. */
  const doc = {
    people: [{ id: "p1", name: "EVANS, Brenton" }],
    certDates: {
      at: "2026-09-25T00:00:00.000Z",
      map: {
        "EVANS, BRENTON::QL-17": {
          issued: "2026-06-05", expires: "2028-06-02", url: "/api/files/med",
          assessedOn: "2026-06-02", conditions: "Fit for particular duties only",
        },
        "EVANS, BRENTON::QL-01": { issued: null, expires: "2031-05-26", conditions: null },
      },
      covers: { "EVANS, BRENTON::QL-03": { kind: "extension", until: "2026-11-25" } },
    },
  };
  const view = JSON.parse(crewStateView(21, JSON.stringify(doc))) as typeof doc;
  const cells = view.certDates.map as Record<string, Record<string, unknown>>;
  assert.deepEqual(cells["EVANS, BRENTON::QL-17"], { issued: "2026-06-05", expires: "2028-06-02", url: "/api/files/med" },
    "the dates crew read are the matrix; the words off the face of the document are not");
  assert.equal("conditions" in cells["EVANS, BRENTON::QL-01"], false, "not even where the document printed none");
  assert.deepEqual(view.certDates.covers, doc.certDates.covers, "and the covers are left as they are");

  const plain = JSON.stringify({ certDates: { map: { "A::QL-01": { expires: "2031-05-26" } } } });
  assert.equal(crewStateView(22, plain), plain, "nothing to take off: the same bytes go out");
  const odd = JSON.stringify({ certDates: { map: { "A::QL-01": null } }, people: [] });
  assert.equal(crewStateView(23, odd), odd, "and a cell that is not a record is left as it is");
});
