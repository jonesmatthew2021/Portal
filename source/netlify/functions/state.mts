import type { Config } from "@netlify/functions";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { PORTAL_ROW_ID, portalState } from "../../db/schema.js";

// The portal is one shared workspace, so there is one row.
const ROW_ID = PORTAL_ROW_ID;

// This document holds the roster, notes, matrix references and the change
// history — not file bytes, those go through `/api/files` and its own cap —
// so a few megabytes is already generous for it. The cap exists so nothing can
// push an arbitrarily large payload into the one shared row every browser
// polls.
const MAX_BYTES = 5 * 1024 * 1024;

function humanSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Every browser polls this. Safari on iOS will otherwise answer a repeated GET
// out of its own cache, so a phone can poll all day and be handed the same
// stale copy every time — the crew see nothing anyone else has written.
const NO_STORE = { "Cache-Control": "no-store" };

async function current() {
  const [row] = await db.select().from(portalState).where(eq(portalState.id, ROW_ID));
  return row ?? null;
}

export default async (req: Request) => {
  if (req.method === "GET") {
    const row = await current();
    return Response.json(
      row ? { rev: row.rev, data: row.data } : { rev: 0, data: null },
      { headers: NO_STORE },
    );
  }

  if (req.method !== "PUT") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: { rev?: unknown; data?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "The change couldn't be read." }, { status: 400 });
  }

  const base = Number(body.rev);
  if (!Number.isInteger(base) || base < 0) {
    return Response.json({ error: "Missing the revision this change was based on." }, { status: 400 });
  }
  if (body.data === null || typeof body.data !== "object") {
    return Response.json({ error: "The change didn't contain anything to save." }, { status: 400 });
  }

  const dataSize = new TextEncoder().encode(JSON.stringify(body.data)).length;
  if (dataSize > MAX_BYTES) {
    return Response.json(
      { error: `That change is ${humanSize(dataSize)}. The limit is ${humanSize(MAX_BYTES)}.` },
      { status: 413 },
    );
  }

  // rev 0 means "nobody has saved anything yet" — the first person in seeds the
  // row. If someone beat them to it, nothing is inserted and they get told.
  if (base === 0) {
    const [seeded] = await db
      .insert(portalState)
      .values({ id: ROW_ID, data: body.data, rev: 1 })
      .onConflictDoNothing()
      .returning();

    if (seeded) return Response.json({ rev: seeded.rev });

    const row = await current();
    return Response.json({ conflict: true, rev: row?.rev ?? 0, data: row?.data ?? null }, { status: 409 });
  }

  // The write only lands if the stored revision is still the one this change was
  // built on, so a save can never quietly wipe out one made a moment earlier.
  const [saved] = await db
    .update(portalState)
    .set({ data: body.data, rev: sql`${portalState.rev} + 1`, updatedAt: sql`now()` })
    .where(and(eq(portalState.id, ROW_ID), eq(portalState.rev, base)))
    .returning();

  if (saved) return Response.json({ rev: saved.rev });

  const row = await current();
  return Response.json({ conflict: true, rev: row?.rev ?? 0, data: row?.data ?? null }, { status: 409 });
};

export const config: Config = {
  path: "/api/state",
};
