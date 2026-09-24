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
import { todayThere } from "../src/lib/analysis.js";
import sync, { runSync, heldBackLine } from "../src/routes/sync.js";
import { graphWaits } from "../src/files/store.js";
import { fakeBucket, portalDb, graphLibrary, sharepointEnv, wranglerVars, keptRow, type FakeFile } from "./helpers.js";

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

/* ------------------------------------------------------------------------ *
 * The sync's own rules, where the listing does not matter: the R2 bucket
 * in memory stands in for the library.
 * ------------------------------------------------------------------------ */
/** The bucket holding these files, and the env pointed at it and the books. */
const bucketOf = (portal: ReturnType<typeof portalDb>, seed: Record<string, string>) => {
  const bucket = fakeBucket(seed, ["opms", "removed", "opms/Brenton - OPMS", "matrices/skills", "roster/shift-allocation"]);
  setEnv({ DB: portal.db, FILES: bucket, FILE_STORE: "r2" } as never);
  return bucket;
};
const row = (portal: ReturnType<typeof portalDb>, id: string) => portal.rows.find((r) => r.id === id)!;
/** What the sync wrote on the books - the documents table, by either road. */
const bookWrites = (portal: ReturnType<typeof portalDb>) =>
  portal.db.asked.filter((a) => /^(insert into|update|delete from) "documents"/.test(a.sql) || /^(INSERT INTO|UPDATE|DELETE FROM) documents/.test(a.sql));

test("R2: a file new to a crew folder is registered as that man's, by SharePoint sync, filed today", async () => {
  const portal = booksOf([]);
  bucketOf(portal, { "opms/Brenton - OPMS/new ticket.pdf": "scan!!" });
  const out = await runSync("Import new files");
  assert.deepEqual(out.registered.map((r) => [r.key, r.person]), [["opms/Brenton - OPMS/new ticket.pdf", "EVANS, Brenton"]]);
  assert.equal(portal.rows.length, 1);
  const taken = portal.rows[0];
  assert.deepEqual(
    [taken.category, taken.bucket, taken.folder, taken.person, taken.uploadedBy, taken.filedOn, taken.filename, taken.sizeBytes, taken.contentType],
    ["certificate", "evans-brenton", "evans-brenton", "EVANS, Brenton", "SharePoint sync", todayThere(), "new ticket.pdf", 6, "application/pdf"],
  );
  assert.deepEqual(out.people, [{ folder: "evans-brenton", name: "EVANS, Brenton" }], "and his folder is on the list of whose folders the office keeps");
  assert.equal(lastRun(portal).registered, 1);
});

test("R2: the same name and size under the same man at a new address is the file moved - the row follows it, nothing is taken on twice, nothing is missing", async () => {
  const portal = booksOf([certRow("c1", "opms/Brenton - OPMS/master.pdf")]);
  // The office renamed his folder to his name; the file is the same six bytes.
  bucketOf(portal, { "opms/EVANS, Brenton/master.pdf": "scan!!" });
  const out = await runSync("Import new files");
  assert.equal(out.followed, 1, "one file followed");
  assert.deepEqual(out.registered, [], "not taken on twice");
  assert.deepEqual(out.missing, [], "and not missing from where it was");
  assert.equal(row(portal, "c1").blobKey, "opms/EVANS, Brenton/master.pdf", "the row points at the new address");
  assert.equal(row(portal, "c1").removedAt, null);
  assert.equal(portal.rows.length, 1);
});

test("Graph: a row with no size on record and a listing that names none never match - the file is taken on new and the old row goes missing", async () => {
  const portal = booksOf([certRow("c1", "opms/Brenton - OPMS/master.pdf", { sizeBytes: null })]);
  // Same name under the same man at a new address, and neither side knows a size.
  const graph = libraryOf(portal, [{ path: `${OPMS}/EVANS, Brenton/master.pdf` }]);
  try {
    const out = await runSync("Import new files");
    assert.equal(out.followed, 0, "an unknown size is never a match");
    assert.deepEqual(out.registered.map((r) => r.key), ["opms/EVANS, Brenton/master.pdf"]);
    assert.deepEqual(out.missing.map((m) => m.id), ["c1"]);
    assert.equal(out.mirrored, 1);
    assert.ok(row(portal, "c1").removedAt, "the old row is off the books");
    assert.equal(portal.rows.find((r) => r.blobKey === "opms/EVANS, Brenton/master.pdf")!.sizeBytes, 0, "the new row records no size as 0");
  } finally {
    graph.restore();
  }
});

test("R2: a file renamed in the library is taken on under its new name, and its old row goes missing and off the books", async () => {
  const portal = booksOf([certRow("c1", "opms/Brenton - OPMS/master.pdf")]);
  bucketOf(portal, { "opms/Brenton - OPMS/Master ticket.pdf": "scan!!" });
  const out = await runSync("Import new files");
  assert.deepEqual(out.registered.map((r) => r.key), ["opms/Brenton - OPMS/Master ticket.pdf"]);
  assert.deepEqual(out.missing.map((m) => m.key), ["opms/Brenton - OPMS/master.pdf"]);
  assert.equal(out.mirrored, 1);
  assert.equal(out.followed, 0);
  assert.ok(row(portal, "c1").removedAt);
  assert.equal(row(portal, "c1").removedBy, "SharePoint sync");
  assert.deepEqual([lastRun(portal).registered, lastRun(portal).missing], [1, 1]);
});

test("R2: missing is a live row under a walked folder whose file is gone - not one the walk never covered, and not a single document its folder still holds", async () => {
  const portal = booksOf([
    certRow("c1", "opms/Brenton - OPMS/gone.pdf"),
    { ...certRow("n1", "uploads/n1"), category: "note", folder: null, person: null },
    { ...keptRow("sk1", "matrices/skills/SKILLS.xlsx"), category: "skills-matrix", removedAt: null, keptInPlace: null },
  ]);
  bucketOf(portal, { "matrices/skills/SKILLS.xlsx": "the skills matrix" });
  const out = await runSync("Import new files");
  assert.deepEqual(out.missing, [{ id: "c1", key: "opms/Brenton - OPMS/gone.pdf", filename: "gone.pdf", category: "certificate", checksum: "sum-c1" }]);
  assert.equal(row(portal, "n1").removedAt, null, "a folder the walk never covers says nothing about its files");
  assert.equal(row(portal, "sk1").removedAt, null, "the skills matrix is in its folder, so it is not missing");
  assert.deepEqual(out.leftAlone, [], "…and, already on the books, it is nobody's candidate");
});

test("R2: a row written off whose file the folder still holds comes back - unless it was kept in place, or a live row already holds the address", async () => {
  const portal = booksOf([
    certRow("r1", "opms/Brenton - OPMS/back.pdf", { removedAt: 5, removedBy: "SharePoint sync" }),
    { ...keptRow("r2", "roster/shift-allocation/SHIFT.xlsx"), category: "shift-allocation" },
    certRow("r3", "opms/Brenton - OPMS/twice.pdf", { removedAt: 5, removedBy: "Matthew" }),
    certRow("c3", "opms/Brenton - OPMS/twice.pdf", { createdAt: 9 }),
  ]);
  bucketOf(portal, {
    "opms/Brenton - OPMS/back.pdf": "scan!!",
    "roster/shift-allocation/SHIFT.xlsx": "theirs",
    "opms/Brenton - OPMS/twice.pdf": "scan!!",
  });
  const out = await runSync("Import new files");
  assert.equal(out.returned, 1, "one row back on the books");
  assert.deepEqual([row(portal, "r1").removedAt, row(portal, "r1").removedBy], [null, null], "the same row it always was, live again");
  assert.equal(row(portal, "r2").removedAt, 5, "the office's file kept in place was taken off on purpose, and stays off");
  assert.equal(row(portal, "r3").removedAt, 5, "one address, one live row: the wiped-and-re-uploaded twin stays off");
  assert.equal(row(portal, "c3").removedAt, null);
  assert.deepEqual(out.registered, [], "nothing taken on: the files are all on the books");
  assert.deepEqual(out.adopted, [], "the office's kept-in-place file is not adopted again either");
});

test("R2: two live rows on one address - the one with a reading is kept, else the newer, and the other goes back to removed", async () => {
  const portal = booksOf([
    certRow("read", "opms/Brenton - OPMS/one.pdf", { readAt: 10, createdAt: 1 }),
    certRow("unread", "opms/Brenton - OPMS/one.pdf", { createdAt: 9 }),
    certRow("older", "opms/Brenton - OPMS/two.pdf", { createdAt: 1 }),
    certRow("newer", "opms/Brenton - OPMS/two.pdf", { createdAt: 5 }),
  ]);
  bucketOf(portal, { "opms/Brenton - OPMS/one.pdf": "scan!!", "opms/Brenton - OPMS/two.pdf": "scan!!" });
  await runSync("Import new files");
  assert.equal(row(portal, "read").removedAt, null, "the row with a reading stays");
  assert.ok(row(portal, "unread").removedAt, "its newer twin without one goes");
  assert.equal(row(portal, "unread").removedBy, "the same file is already on the books");
  assert.equal(row(portal, "newer").removedAt, null, "with no reading either side, the newer stays");
  assert.ok(row(portal, "older").removedAt);
  assert.equal(row(portal, "older").removedBy, "the same file is already on the books");
});

test("R2: a file gone from the folder comes off the books, and the portal's reading of it goes with it", async () => {
  const portal = booksOf(
    [certRow("c1", "opms/Brenton - OPMS/gone.pdf"), certRow("c2", "opms/Brenton - OPMS/here.pdf")],
    { "r1/sum-c1.json": { version: "r1", readable: true }, "r1/sum-c2.json": { version: "r1", readable: true } },
  );
  bucketOf(portal, { "opms/Brenton - OPMS/here.pdf": "scan!!" });
  const out = await runSync("hourly schedule");
  assert.equal(out.mirrored, 1);
  assert.ok(row(portal, "c1").removedAt, "off the books");
  assert.equal(row(portal, "c1").removedBy, "SharePoint sync");
  assert.equal(row(portal, "c1").blobKey, "opms/Brenton - OPMS/gone.pdf", "the row still names where the file was: there are no bytes to park");
  assert.ok(!portal.blobs.has("certificate-readings|r1/sum-c1.json"), "what the portal read off the file is gone with it");
  assert.ok(portal.blobs.has("certificate-readings|r1/sum-c2.json"), "the other reading is untouched");
  assert.equal(row(portal, "c2").removedAt, null);
  assert.deepEqual([lastRun(portal).missing, lastRun(portal).error], [1, null]);
});

test("R2: a single document the portal has none of, with one candidate in its folder, is adopted as the office's own file", async () => {
  const portal = booksOf([]);
  bucketOf(portal, { "matrices/skills/SKILLS MATRIX.xlsx": "the skills matrix" });
  const out = await runSync("Import new files");
  assert.deepEqual(out.adopted, [{ category: "skills-matrix", key: "matrices/skills/SKILLS MATRIX.xlsx" }]);
  assert.deepEqual(out.leftAlone, []);
  const taken = portal.rows.find((r) => r.category === "skills-matrix")!;
  assert.deepEqual(
    [taken.adoptedFromFolder, taken.uploadedBy, taken.filedOn, taken.filename, taken.blobKey],
    [1, "SharePoint sync", todayThere(), "SKILLS MATRIX.xlsx", "matrices/skills/SKILLS MATRIX.xlsx"],
    "the office's file: marked so, never to be moved",
  );
  assert.equal(lastRun(portal).adopted, 1);
});

test("R2: two candidates for a single document are left alone, and the why says so", async () => {
  const portal = booksOf([]);
  bucketOf(portal, { "matrices/skills/SKILLS.xlsx": "one", "matrices/skills/SKILLS (2).xlsx": "two" });
  const out = await runSync("Import new files");
  assert.deepEqual(out.adopted, []);
  assert.deepEqual(out.leftAlone.map((l) => ({ ...l, found: [...l.found].sort() })), [{
    category: "skills-matrix", label: "skills matrix",
    found: ["matrices/skills/SKILLS (2).xlsx", "matrices/skills/SKILLS.xlsx"],
    why: "more than one candidate — upload the right one through the portal",
  }]);
  assert.equal(portal.rows.length, 0, "nothing taken on");
  assert.equal(lastRun(portal).leftAlone, 1);
});

test("R2: a candidate beside a live single document is left alone, and the why says a current one is on the portal", async () => {
  const portal = booksOf([{ ...keptRow("sk1", "matrices/skills/SKILLS.xlsx"), category: "skills-matrix", removedAt: null, keptInPlace: null }]);
  bucketOf(portal, { "matrices/skills/SKILLS.xlsx": "current", "matrices/skills/SKILLS v2.xlsx": "newer" });
  const out = await runSync("Import new files");
  assert.deepEqual(out.adopted, []);
  assert.deepEqual(out.leftAlone, [{
    category: "skills-matrix", label: "skills matrix",
    found: ["matrices/skills/SKILLS v2.xlsx"],
    why: "a current one is already on the portal — replace it through the portal if this newer file should take over",
  }]);
  assert.equal(row(portal, "sk1").removedAt, null, "the live one stands");
  assert.equal(portal.rows.length, 1);
});

/* ------------------------------------------------------------------------ *
 * The route itself.
 * ------------------------------------------------------------------------ */
test("R2, the route: GET is the survey only - it writes nothing, takes no lease and leaves no record", async () => {
  const portal = booksOf([certRow("c1", "opms/Brenton - OPMS/gone.pdf")]);
  bucketOf(portal, { "opms/Brenton - OPMS/new.pdf": "scan!!" });
  const res = await sync(new Request("http://portal/api/sync"));
  assert.equal(res.status, 200);
  const out = (await res.json()) as { newCertificates: { key: string }[]; missing: { id: string }[]; note: string };
  assert.deepEqual(out.newCertificates.map((c) => c.key), ["opms/Brenton - OPMS/new.pdf"], "it says what it would take on");
  assert.deepEqual(out.missing.map((m) => m.id), ["c1"], "and what is gone");
  assert.equal(out.note, "Survey only — POST /api/sync to take these onto the portal's books.");
  assert.deepEqual(bookWrites(portal), [], "nothing written on the books");
  assert.equal(row(portal, "c1").removedAt, null);
  assert.equal(portal.rows.length, 1);
  assert.equal(portal.blobs.get("sync|last-run"), undefined, "no record: nothing was applied");
  assert.equal(portal.blobs.get("sync|round-lease"), undefined, "no lease: nothing was written");
});

test("the route: anything but GET and POST is 405", async () => {
  const portal = booksOf([]);
  bucketOf(portal, {});
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const res = await sync(new Request("http://portal/api/sync", { method }));
    assert.equal(res.status, 405, method);
  }
  assert.deepEqual(portal.db.asked, [], "the database was not even asked");
});

test("R2, the route: a survey that falls over is 502 with the error, and last-run carries it with zero counts", async () => {
  const portal = booksOf([certRow("c1", "opms/Brenton - OPMS/master.pdf")]);
  bucketOf(portal, { "opms/Brenton - OPMS/master.pdf": "scan!!" });
  const prepare = portal.db.prepare;
  portal.db.prepare = (sql: string) => {
    if (/^select .+ from "documents"$/.test(sql)) throw new Error("D1 is having a bad morning");
    return prepare(sql);
  };
  const res = await post("Update portal");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "D1 is having a bad morning" });
  const record = lastRun(portal);
  assert.deepEqual(
    { ...record, at: 0 },
    { at: 0, by: "Update portal", registered: 0, adopted: 0, missing: 0, leftAlone: 0, error: "D1 is having a bad morning" },
  );
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).until, 0, "the lease was given back");
});

test("R2, the route: a good run's record carries the counts, who asked, when, and no error", async () => {
  const portal = booksOf([certRow("c1", "opms/Brenton - OPMS/gone.pdf")]);
  bucketOf(portal, { "opms/Brenton - OPMS/new.pdf": "scan!!", "matrices/skills/A.xlsx": "a", "matrices/skills/B.xlsx": "b" });
  const before = Date.now();
  const res = await post("Import new files");
  assert.equal(res.status, 200);
  const record = lastRun(portal);
  assert.ok(record.at >= before && record.at <= Date.now(), "stamped when it began");
  assert.deepEqual(
    { ...record, at: 0 },
    { at: 0, by: "Import new files", registered: 1, adopted: 0, missing: 1, leftAlone: 1, error: null },
  );
  assert.equal(JSON.parse(portal.blobs.get("sync|round-lease")!).until, 0, "the lease was given back");
});
