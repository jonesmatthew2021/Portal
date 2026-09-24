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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gate, publicPath } from "../src/auth.js";
import { assetHeaders, withAssetHeaders } from "../src/lib/offline.js";
import state from "../src/routes/state.js";
import { setEnv } from "../src/env.js";
import { fakeDb } from "./helpers.js";
import { keepable, PAGE_HEADER } from "../../source/shared/offline-rules.js";

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
  const api = await ask("/api/state");
  assert.equal(api.barred!.status, 401);
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
  // The worker file parses as a script. Compiled, never run: it reads
  // self.location at the top, which only a browser has.
  assert.doesNotThrow(() => new Function(sw), "worker/assets/sw.js does not parse");

  const walk = (dir: string, rel = ""): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name), rel + d.name + "/") : [rel + d.name]);
  const source = join(REPO, "source", "vendor");
  const assets = join(WORKER, "assets", "vendor");
  const files = walk(source);
  assert.ok(files.includes("react.production.min.js") && files.includes("react-dom.production.min.js"));
  assert.equal(files.filter((f) => f.endsWith(".woff2")).length, 9, "three families, three weights each");
  assert.deepEqual(walk(assets).sort(), files.sort(), "the assets carry exactly the files source/vendor has");
  for (const f of files) {
    assert.equal(Buffer.compare(readFileSync(join(source, f)), readFileSync(join(assets, f))), 0, "worker/assets/vendor/" + f + " is byte for byte source/vendor/" + f);
  }
});
