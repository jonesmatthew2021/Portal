/**
 * The hourly round, piece by piece, against a database and a file store
 * that live in this file.
 *
 * The round puts the certificates' dates on the crew matrix and writes the
 * office's CREW QUALIFICATION EXPIRY workbook by itself, with nobody
 * watching. Every case here is a way that could go wrong quietly: a
 * certificate filed under one spelling claiming nothing, a workbook lost
 * halfway through a replace, a date cleared on its first sighting, the
 * portal making a folder in the library.
 *
 *   npx tsx --test tests/round.test.ts      (or: node tools/check.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setEnv } from "../src/env.js";
import { compareMatrix } from "../src/routes/analyse.js";
import { relocateToRemovedBlob } from "../src/db/documents.js";
import { asKnownPerson } from "../../source/shared/names.js";

/* ------------------------------------------------------------------------ *
 * A D1 that answers from a table of statements.
 *
 * `answer` is given the SQL and its bound values and hands back what the
 * real database would: rows for a select, a change count for a write. What
 * it is not asked about it refuses, so a test cannot pass on a query nobody
 * thought about. Drizzle's own reads go through .raw(), which is refused
 * outright - the code under test reads with plain statements.
 * ------------------------------------------------------------------------ */
type Answer = { results?: unknown[]; changes?: number };
type Asked = { sql: string; args: unknown[] };

function fakeDb(answer: (sql: string, args: unknown[]) => Answer | undefined, asked: Asked[] = []) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    async all() {
      asked.push({ sql, args });
      const a = answer(sql, args);
      if (!a) throw new Error("the test's database was not told how to answer: " + sql.slice(0, 80));
      return { results: a.results || [], meta: { changes: a.changes || 0 } };
    },
    async first() {
      const { results } = await this.all();
      return results[0] ?? null;
    },
    async run() {
      asked.push({ sql, args });
      const a = answer(sql, args);
      if (!a) throw new Error("the test's database was not told how to answer: " + sql.slice(0, 80));
      return { results: a.results || [], meta: { changes: a.changes || 0 } };
    },
    async raw() {
      throw new Error("drizzle reads are not faked here");
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    asked,
  };
}

/* ------------------------------------------------------------------------ *
 * An R2 bucket in memory, which is what fileStore() drives when FILE_STORE
 * is "r2". It writes down every folder a write would have had to make -
 * the office's library is SharePoint, where a write into a folder that is
 * not there makes the folder, and the portal is not allowed to make one.
 * `failOn` makes the nth write throw, for the tests that pull the floor
 * out halfway through.
 * ------------------------------------------------------------------------ */
function fakeBucket(seed: Record<string, string>, folders: string[] = ["opms", "removed"]) {
  const bytes = new Map<string, Uint8Array>();
  const have = new Set(folders);
  const made: string[] = [];
  let writes = 0;
  const enc = new TextEncoder();
  Object.entries(seed).forEach(([k, v]) => bytes.set(k, enc.encode(v)));
  const bucket = {
    made,
    failOn: 0,
    text: (key: string) => { const b = bytes.get(key); return b ? new TextDecoder().decode(b) : null; },
    keys: () => [...bytes.keys()].sort(),
    async get(key: string) {
      const b = bytes.get(key);
      return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), body: null } : null;
    },
    async put(key: string, value: ArrayBuffer | Uint8Array) {
      writes++;
      if (bucket.failOn && writes === bucket.failOn) throw new Error("the library refused the write");
      const folder = key.split("/").slice(0, -1).join("/");
      if (folder && !have.has(folder)) { have.add(folder); made.push(folder); }
      bytes.set(key, new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)));
    },
    async delete(key: string) { bytes.delete(key); },
    async head(key: string) { const b = bytes.get(key); return b ? { size: b.length } : null; },
    async list(opts: { prefix?: string }) {
      const objects = [...bytes.entries()]
        .filter(([k]) => k.startsWith(opts.prefix || ""))
        .map(([k, v]) => ({ key: k, size: v.length, uploaded: new Date(0) }));
      return { objects, truncated: false };
    },
  };
  return bucket;
}

/* The one reading these tests need: a Master ticket printed in Kachin's
   name and filed, as the office files it, under "bILLY". */
const reading = {
  version: "r1", at: "", model: "", readable: true,
  holderName: "Kachin Sittiyos", certificateTitle: "Master <500GT", issuer: "AMSA",
  issuedOn: "2026-02-17", expiresOn: "2031-02-17", neverExpires: false,
  qualCode: "QL-01", codeConfidence: "high", notes: null,
};
const billysTicket = {
  id: "c1", category: "certificate", bucket: "billy", blobKey: "opms/Billy - OPMS/master.pdf",
  filename: "master.pdf", contentType: "application/pdf", sizeBytes: 100, title: null,
  uploadedBy: null, tag: null, source: null, party: null, rank: null, swing: null,
  filedOn: "2026-09-01", sessionId: null, person: "bILLY", folder: "billy",
  qualCode: "QL-01", expiresOn: null, checksum: "abc", createdAt: 1, removedAt: null, removedBy: null,
};

const certificatesDb = () => fakeDb((sql) => {
  if (/FROM documents WHERE category = 'certificate'/.test(sql)) return { results: [billysTicket] };
  if (/SELECT key, value FROM blobs/.test(sql)) return { results: [{ key: "r1/abc.json", value: JSON.stringify(reading) }] };
  if (/SELECT value FROM blobs/.test(sql)) return { results: [] };
  if (/UPDATE documents/.test(sql)) return { changes: 1 };
  return undefined;
});

const matrix = {
  cols: [["QL-01", "Master", "Qualifications"]] as [string, string, string][],
  rows: [["SITTIYOS, Kachin", "Cook", "", [""]]] as [string, string, string, string[]][],
};

test("a certificate filed under an alias claims the register's row", async () => {
  setEnv({ DB: certificatesDb(), FILE_STORE: "r2" } as never);
  const nameOf = asKnownPerson([{ name: "SITTIYOS, Kachin", aliases: ["bILLY"] }]);
  const out = await compareMatrix(matrix, null, nameOf);
  assert.deepEqual(out.claimed, ["SITTIYOS, KACHIN::QL-01"], "the claim is keyed by the register's name");
  assert.deepEqual(out.settled, [{ person: "SITTIYOS, Kachin", code: "QL-01", value: "2031-02-17" }],
    "the date settles on the row under the row's own name");
  assert.equal(out.notes.length, 0, "nothing to note: the alias is the man");
});

test("without a register the route compares names as they are", async () => {
  setEnv({ DB: certificatesDb(), FILE_STORE: "r2" } as never);
  const out = await compareMatrix(matrix, null);
  assert.deepEqual(out.claimed, [], "bILLY is not on this matrix");
  assert.equal(out.notes[0]?.kind, "not-on-matrix");
});

/* ------------------------------------------------------------------------ *
 * Removed copies are parked flat. The portal makes no folders.
 * ------------------------------------------------------------------------ */
test("a removed copy is parked flat under removed/, and no folder is made", async () => {
  const bucket = fakeBucket({ "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx": "old workbook" });
  setEnv({ DB: fakeDb(() => undefined), FILES: bucket, FILE_STORE: "r2" } as never);
  const row = {
    id: "tm1", category: "training-matrix", blobKey: "opms/20260901 - CREW QUALIFICATION EXPIRY.xlsx",
    filename: "20260901 - CREW QUALIFICATION EXPIRY.xlsx",
  };
  const parked = await relocateToRemovedBlob(row as never);
  assert.equal(parked, "removed/tm1 - 20260901 - CREW QUALIFICATION EXPIRY.xlsx", "one file straight under removed/");
  assert.equal(bucket.text(parked), "old workbook", "the bytes went with it");
  assert.equal(bucket.text(row.blobKey), null, "and the live name is free");
  assert.deepEqual(bucket.made, [], "no folder was made for it");
});
