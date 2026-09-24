import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { canonicaliseCertificate, refileCertificate, relocateToRemovedBlob } from "../db/documents.js";
import { holderOnMatrix, readCertificate } from "./analyse.js";
import { codeFor, equivalences, ModelRefusal, plainLine, readingKey, readingStore, type Reading } from "../lib/analysis.js";
import { imageToPdf } from "../lib/pdf-wrap.js";
import { getEnv } from "../env.js";

/**
 * POST /api/certificates/read-one { id } — one certificate, settled now.
 *
 * The crew upload page's second call: the file just filed is read by the AI
 * on the spot (or its existing reading used), moved to the person it names
 * if it was filed under someone else, and given the one filing name —
 * PERSON - CODE Title.pdf, wrapped as a PDF where it was a photo. What comes
 * back is the file as it now stands, ready to be saved for OPMS.
 */
export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = (await req.json().catch(() => null)) as { id?: unknown; discardUnreadable?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const discardUnreadable = body?.discardUnreadable === true;
  if (!id) return Response.json({ error: "Which certificate?" }, { status: 400 });

  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.category, "certificate"), isNull(documents.removedAt)));
  if (!row) return Response.json({ error: "That certificate isn't on the portal." }, { status: 404 });

  const state = await getEnv().DB.prepare("SELECT data FROM portal_state LIMIT 1").first<{ data: string }>();
  let quals: { cols?: string[][]; rows?: string[][] } = {};
  try {
    quals = JSON.parse(state?.data || "{}")?.quals || {};
  } catch {
    quals = {};
  }
  const codes: [string, string][] = (quals.cols || []).map((c) => [String(c[0]), String(c[1] || "")]);
  const names: string[] = (quals.rows || []).map((r) => String(r[0])).filter(Boolean);
  const titles: Record<string, string> = Object.fromEntries(codes.map(([c, t]) => [c.toUpperCase(), t]));

  const store = readingStore();
  let reading = (await store.get(readingKey(row), { type: "json" })) as Reading | null;
  if (!reading) {
    try {
      reading = await readCertificate(row, codes);
    } catch (e) {
      // Nothing about the account - no credit, the rate, a busy model, the
      // key - is stored against the certificate, and none of it reaches
      // the discard below: the file stays on the books, to be read on the
      // hour once the account is in order, and the phone is told which in
      // one short sentence.
      return Response.json(
        {
          error: e instanceof ModelRefusal ? plainLine(e) : e instanceof Error ? e.message : String(e),
          kind: e instanceof ModelRefusal ? e.kind : null,
        },
        { status: 502 },
      );
    }
    await store.setJSON(readingKey(row), reading);
  }

  // A photo the AI can't make out is taken off the books again when the
  // uploader asked for that (the phone flow) — so a blurred shot never sits
  // in SharePoint, and the person is told to take it again.
  if (!reading.readable && discardUnreadable) {
    const archivedKey = await relocateToRemovedBlob(row);
    await db
      .update(documents)
      .set({ removedAt: new Date(), removedBy: "not clear — retake", blobKey: archivedKey })
      .where(eq(documents.id, row.id));
    await store.delete(readingKey(row));
    return Response.json({
      id: row.id,
      discarded: true,
      readable: false,
      reason: (reading as Reading & { reason?: string }).reason || "The photo isn't clear enough to read.",
    });
  }

  let current = row;
  const holder = reading.readable && reading.holderName ? holderOnMatrix(reading.holderName, names) : null;
  // Whose it is, written on the row. The file stays in the folder the office
  // put it in — see refileCertificate for why it no longer moves.
  if (holder && (current.person || "") !== holder) {
    current = await refileCertificate(current, holder, "");
  }
  const code = String(codeFor(current, reading, await equivalences(), quals.cols || []) || "").trim().toUpperCase();
  const title = code ? titles[code] || "" : "";
  const personName = names.includes(current.person || "") ? current.person : holder;
  if (code && title && personName) {
    const renamed = await canonicaliseCertificate(current, `${personName} - ${code} ${title}`, imageToPdf);
    if (renamed) current = renamed;
  }

  return Response.json({
    id: current.id,
    filename: current.filename,
    url: `/api/files/${current.id}`,
    person: current.person,
    code: code || null,
    title: title || null,
    readable: !!reading.readable,
    holder: reading.holderName || null,
    reason: (reading as Reading & { reason?: string }).reason || null,
  });
};
