/**
 * The SharePoint sync (src/routes/sync.ts), rule by rule, against a
 * database and a library that live in the test.
 *
 * The sync is what keeps the portal's books and the team's folders saying
 * the same thing, and the one time it got a bad view of the library it
 * wrote off 791 certificates in a pass. Every case here is a way the books
 * could quietly drift from the folders, or be written off over a listing
 * that went wrong: a folder renamed, a page Graph refused, a walk cut
 * short, two rows on one file, a reading left behind after its file went.
 *
 * The listing matters to some of these and not to others. Where it does,
 * the library is Graph answered by hand (graphLibrary in helpers.ts) with
 * the real folder layout from wrangler.toml; where it does not, the R2
 * bucket in memory. Each title says which.
 *
 *   npx tsx --test tests/sync.test.ts      (or: node tools/check.mjs, which
 *   runs this through rules.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setEnv } from "../src/env.js";
import sync, { runSync } from "../src/routes/sync.js";
import { graphWaits } from "../src/files/store.js";
import { portalDb, graphLibrary, sharepointEnv, wranglerVars, type FakeFile } from "./helpers.js";

/* The library's real folders (wrangler.toml): "opms/" is OPMS Documents,
   and a man's certificates sit in a folder of his own inside it. */
const OPMS = "United Operations Team/OPMS Documents";
const BRENTON = `${OPMS}/Brenton - OPMS`;

/** A certificate row on the books, as the sync reads them: Brenton's, by
 *  the token his folder reads as. */
const certRow = (id: string, key: string, over: Record<string, unknown> = {}) => ({
  id, category: "certificate", bucket: "evans-brenton", blobKey: key, filename: key.split("/").pop(),
  contentType: "application/pdf", sizeBytes: 6, title: null, uploadedBy: "Matthew", tag: null, source: null,
  party: null, rank: null, swing: null, filedOn: "2026-09-01", sessionId: null, person: "EVANS, Brenton",
  folder: "evans-brenton", qualCode: null, expiresOn: null, checksum: "sum-" + id, createdAt: 1,
  removedAt: null, removedBy: null, adoptedFromFolder: null, keptInPlace: null, readAt: null, ...over,
});

/** The portal's books: these rows, these readings, and a shared document
 *  that names no certificate location - so the home is "opms", as it is
 *  on a portal nobody has set it on. */
const booksOf = (rows: Record<string, unknown>[], readings: Record<string, unknown> = {}) =>
  portalDb({ people: [], quals: { cols: [], rows: [] } }, rows, readings);

/** The library answered by hand, laid out as wrangler.toml lays it out,
 *  and the worker's env pointed at it and at these books. */
const libraryOf = (portal: ReturnType<typeof portalDb>, files: FakeFile[], pageSize?: number) => {
  const graph = graphLibrary(new Set(["United Operations Team", OPMS]), { files, pageSize });
  setEnv({ DB: portal.db, ...sharepointEnv(wranglerVars()) } as never);
  return graph;
};

/** The waits the driver asked for, written down instead of waited. */
const recordedWaits = () => {
  const sleeps: number[] = [];
  const real = graphWaits.sleep;
  graphWaits.sleep = async (ms) => { sleeps.push(ms); };
  return { sleeps, restore: () => { graphWaits.sleep = real; } };
};

const post = (by = "Import new files") => sync(new Request("http://portal/api/sync", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by }),
}));
const lastRun = (portal: ReturnType<typeof portalDb>) => JSON.parse(portal.blobs.get("sync|last-run") || "null");

/* ------------------------------------------------------------------------ *
 * The driver: a call Graph turns away is made again, and one it keeps
 * turning away fails the survey out loud.
 * ------------------------------------------------------------------------ */
test("Graph: a 429 on page two of a crew folder is asked again after the wait Graph named, and every file is seen", async () => {
  const portal = booksOf([]);
  const files: FakeFile[] = [1, 2, 3, 4, 5].map((n) => ({ path: `${BRENTON}/ticket ${n}.pdf`, size: 10 + n }));
  const graph = libraryOf(portal, files, 2);
  const waits = recordedWaits();
  try {
    // The second page of Brenton's folder, once: throttled, come back in three.
    graph.fault({ status: 429, retryAfter: 3 }, (folder, skip) => folder === BRENTON && skip === 2);
    const out = await runSync("Import new files");
    assert.deepEqual(
      out.registered.map((r) => r.key).sort(),
      files.map((f) => `opms/Brenton - OPMS/${f.path.split("/").pop()}`),
      "all five taken on, under the portal's own keys",
    );
    assert.deepEqual(
      graph.listings.filter((l) => l.folder === BRENTON).map((l) => l.skip),
      [0, 2, 2, 4],
      "three pages and the one asked again - no more",
    );
    assert.deepEqual(waits.sleeps, [3000], "one wait, the three seconds Graph named");
    assert.equal(lastRun(portal).error, null);
  } finally {
    waits.restore();
    graph.restore();
  }
});

test("Graph: four 503s in a row fail the survey - 502, the error on last-run with zero counts, and nothing off the books", async () => {
  const portal = booksOf([certRow("c1", "opms/Brenton - OPMS/master.pdf")]);
  const graph = libraryOf(portal, [{ path: `${BRENTON}/master.pdf`, size: 6 }]);
  const waits = recordedWaits();
  try {
    graph.fault({ status: 503 }, (folder) => folder === OPMS, 4);
    const res = await post();
    assert.equal(res.status, 502);
    const said = (await res.json()) as { error: string };
    assert.match(said.error, /^SharePoint answered 503 4 times for GET \/drives\/d1\/root:\/United Operations Team\/OPMS Documents:\/children/);
    assert.deepEqual(waits.sleeps, [1000, 2000, 4000], "three waits of its own, since Graph named none");
    const record = lastRun(portal);
    assert.equal(record.error, said.error, "the same sentence on the record");
    assert.deepEqual(
      [record.by, record.registered, record.adopted, record.missing, record.leftAlone],
      ["Import new files", 0, 0, 0, 0],
    );
    assert.equal(portal.rows[0].removedAt, null, "the row is still live");
    assert.equal(portal.rows.length, 1, "and nothing was registered");
  } finally {
    waits.restore();
    graph.restore();
  }
});
