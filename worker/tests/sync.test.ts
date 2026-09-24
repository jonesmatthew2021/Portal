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
import sync, { runSync, heldBackLine } from "../src/routes/sync.js";
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
const libraryOf = (portal: ReturnType<typeof portalDb>, files: FakeFile[], opts: { pageSize?: number; folders?: string[] } = {}) => {
  const graph = graphLibrary(new Set(opts.folders || ["United Operations Team", OPMS]), { files, pageSize: opts.pageSize });
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
  const graph = libraryOf(portal, files, { pageSize: 2 });
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

/* ------------------------------------------------------------------------ *
 * The home itself: a certificate location the library no longer has is a
 * fault, never an empty folder.
 * ------------------------------------------------------------------------ */
test("Graph: the certificate home renamed in the library fails the survey by name, and nothing is marked missing", async () => {
  const portal = booksOf(
    [certRow("c1", "opms/Brenton - OPMS/master.pdf")],
    { "r1/sum-c1.json": { version: "r1", readable: true, expiresOn: "2031-02-17" } },
  );
  // The office renamed OPMS Documents; Brenton's file is under the new name.
  const graph = libraryOf(portal, [{ path: `United Operations Team/OPMS Docs/Brenton - OPMS/master.pdf`, size: 6 }],
    { folders: ["United Operations Team"] });
  try {
    const res = await post("Update portal");
    assert.equal(res.status, 502);
    const said = (await res.json()) as { error: string };
    assert.equal(said.error, "the folder United Operations Team/OPMS Documents is not in the library");
    const record = lastRun(portal);
    assert.equal(record.error, said.error, "the same sentence on the record");
    assert.equal(record.by, "Update portal");
    assert.deepEqual(graph.listings, [], "the walk never began");
    assert.equal(portal.rows[0].removedAt, null, "the row is still live");
    assert.ok(portal.blobs.has("certificate-readings|r1/sum-c1.json"), "and its reading is still there");
  } finally {
    graph.restore();
  }
});

/* ------------------------------------------------------------------------ *
 * The hold-back guard. A listing cut short - a page whose @odata.nextLink
 * went missing - looks to the driver like a folder with fewer files in
 * it, and the guard in apply is all that stands between that and the
 * books: nothing is mirrored off when the missing are more than
 * max(25, 10% of the live rows the walk covered). At the boundary the
 * code reads ">", so exactly that many is mirrored and one more is held.
 * ------------------------------------------------------------------------ */
/** `n` of Brenton's certificates on the books, all `n` in his folder, and
 *  his folder's listing cut short so only the first `seen` are listed. */
const cutShort = (n: number, seen: number) => {
  const rows = Array.from({ length: n }, (_, i) => certRow(`c${i}`, `opms/Brenton - OPMS/ticket ${i}.pdf`));
  const portal = booksOf(rows);
  const graph = libraryOf(portal, rows.map((r) => ({ path: `${BRENTON}/${r.filename}`, size: 6 })), { pageSize: seen });
  graph.fault({ cut: true }, (folder, skip) => folder === BRENTON && skip === 0);
  return { portal, graph };
};

test("Graph, listing cut short: 25 missing of 100 live are mirrored off (25 is not more than 25)", async () => {
  const { portal, graph } = cutShort(100, 75);
  try {
    const out = await runSync("hourly schedule");
    assert.equal(out.missing.length, 25);
    assert.equal(out.mirrored, 25, "at the boundary the files come off the books");
    assert.equal(out.heldBack, 0);
    assert.equal(portal.rows.filter((r) => r.removedAt).length, 25);
    assert.equal(lastRun(portal).error, null, "nothing to say on the record");
    assert.equal(lastRun(portal).missing, 25);
  } finally {
    graph.restore();
  }
});

test("Graph, listing cut short: 26 missing of 100 live are held, and the record says so in one sentence", async () => {
  const { portal, graph } = cutShort(100, 74);
  try {
    const out = await runSync("hourly schedule");
    assert.equal(out.missing.length, 26);
    assert.equal(out.mirrored, 0, "one over the boundary and nothing comes off");
    assert.equal(out.heldBack, 26);
    assert.equal(portal.rows.filter((r) => r.removedAt).length, 0, "every row still live");
    assert.equal(lastRun(portal).error, heldBackLine(26), "the sentence the SharePoint page shows");
    assert.equal(lastRun(portal).error, "26 on the books but not in the folders is too many to be believed in one pass, so nothing was taken off the books.");
    assert.equal(lastRun(portal).missing, 26);
  } finally {
    graph.restore();
  }
});

test("Graph, listing cut short: with 400 live the line is 10% - 40 missing mirrored, 41 held", async () => {
  const forty = cutShort(400, 360);
  try {
    const out = await runSync("hourly schedule");
    assert.equal(out.missing.length, 40);
    assert.equal(out.mirrored, 40, "40 is not more than 10% of 400");
    assert.equal(forty.portal.rows.filter((r) => r.removedAt).length, 40);
    assert.equal(lastRun(forty.portal).error, null);
  } finally {
    forty.graph.restore();
  }
  const fortyOne = cutShort(400, 359);
  try {
    const out = await runSync("hourly schedule");
    assert.equal(out.missing.length, 41);
    assert.equal(out.mirrored, 0, "41 is more than 10% of 400, so nothing comes off");
    assert.equal(out.heldBack, 41);
    assert.equal(fortyOne.portal.rows.filter((r) => r.removedAt).length, 0);
    assert.equal(lastRun(fortyOne.portal).error, heldBackLine(41));
  } finally {
    fortyOne.graph.restore();
  }
});
