
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { certHome } from "../db/cert-home.js";
import {
  fileStore,
  liveSingleFileExists,
  purgeDocument,
  removeDocument,
  restoreDocument,
  singleFileCategory,
  type DocumentRow,
} from "../db/documents.js";

// Keep the original filename on the way out, including non-ASCII characters,
// without letting it break the header.
function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Only the browser session that filed a document — or the portal's own admin
// accounts, the only ones the front end ever lets reach someone else's file
// from here — can remove, restore, edit or purge it. `session` is sent back on
// these requests the same way `by` already is, and `admin` the same way the
// client already decides who gets to see the button for it; a row filed before
// either check existed carries no session at all, and is left open rather than
// locked out of its own portal.
function ownershipError(row: DocumentRow, params: URLSearchParams) {
  if (!row.sessionId) return null;
  if (params.get("admin") === "1") return null;
  if (params.get("session") === row.sessionId) return null;
  return Response.json(
    {
      error: "That file was filed from a different browser session, so it can't be changed from this one.",
    },
    { status: 403 },
  );
}

export default async (req: Request, context: { params: { id: string } }) => {
  const { id } = context.params;
  const [row] = await db.select().from(documents).where(eq(documents.id, id));

  if (!row) {
    return new Response("That file is no longer on the portal.", { status: 404 });
  }

  // Removing a file takes it out of the portal but keeps it, so that a wrong
  // click, or a certificate replaced by a renewal, can be undone. Destroying it
  // is a separate ask, made from the list of files already removed.
  if (req.method === "DELETE") {
    const url = new URL(req.url);

    const denied = ownershipError(row, url.searchParams);
    if (denied) return denied;

    const single = singleFileCategory(row.category);

    // The training matrix and the skills matrix are required at all times, so
    // the live copy of either can't be taken out on its own — that would leave
    // the portal running against a document it hasn't got. Replacing one is an
    // upload, which files the new one and removes this in the same step.
    if (single && single.required && !row.removedAt) {
      return Response.json(
        {
          error: `The ${single.label} is required at all times, so it can't be removed on its own. Upload a newer ${single.label} to replace it — the one on file now is kept in the removed list.`,
        },
        { status: 409 },
      );
    }

    if (url.searchParams.get("purge") === "1") {
      if (!row.removedAt) {
        return Response.json(
          { error: "Remove the file from the portal first, then delete it for good." },
          { status: 409 },
        );
      }
      await purgeDocument(row);
      return new Response(null, { status: 204 });
    }

    const removed = await removeDocument(row, url.searchParams.get("by"));
    return Response.json({ removed: true, id: removed.id, filename: removed.filename });
  }

  if (req.method === "PATCH") {
    const denied = ownershipError(row, new URL(req.url).searchParams);
    if (denied) return denied;

    // Two things arrive as a PATCH: an edit to a certificate's details, which
    // carries a JSON body, and a restore of a removed file, which carries none.
    let body: Record<string, unknown> | null = null;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }

    // Editing what a certificate is filed as — the matrix code it answers to,
    // the date it expires, its title. The file itself is never touched: the
    // details sit on the row, and correcting them is how a certificate typed in
    // wrong on the day is put right without uploading it again.
    if (body && body.edit && typeof body.edit === "object") {
      if (row.category !== "certificate") {
        return Response.json(
          { error: "Only crew certificates can be edited this way." },
          { status: 400 },
        );
      }

      const edit = body.edit as Record<string, unknown>;
      const clean = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

      const patch: { qualCode?: string | null; expiresOn?: string | null; title?: string | null } = {};
      if ("qualCode" in edit) patch.qualCode = clean(edit.qualCode);
      if ("title" in edit) patch.title = clean(edit.title);
      if ("expiresOn" in edit) {
        const d = clean(edit.expiresOn);
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return Response.json(
            { error: "The expiry date has to be a whole date, as YYYY-MM-DD." },
            { status: 400 },
          );
        }
        patch.expiresOn = d;
      }

      if (!Object.keys(patch).length) {
        return Response.json({ error: "Nothing to change was included." }, { status: 400 });
      }

      const [updated] = await db
        .update(documents)
        .set(patch)
        .where(eq(documents.id, row.id))
        .returning();

      return Response.json({
        edited: true,
        id: updated.id,
        qualCode: updated.qualCode,
        expiresOn: updated.expiresOn,
        title: updated.title,
      });
    }

    // The portal shows one of each of these — the current one — so putting an
    // old one back while a current one is filed would restore a row nothing
    // displays. Say why rather than appearing to do nothing.
    const single = singleFileCategory(row.category);
    if (single && (await liveSingleFileExists(row.category))) {
      return Response.json(
        {
          error: `There is already a current ${single.label}. Remove that one first, then restore this.`,
        },
        { status: 409 },
      );
    }

    // Where his certificates go back to, if he has nothing else on file to
    // point at: the folder Crew Details names, or the one the rest of his are
    // in. Undefined where neither is known, and restoreDocument then puts it
    // back where it came from rather than anywhere new.
    const home = (row.folder ? (await certHome()).prefixFor(row.folder) : null) || undefined;
    const restored = await restoreDocument(row, home);
    return Response.json({
      restored: true,
      category: restored.category,
      bucket: restored.bucket,
      id: restored.id,
      filename: restored.filename,
    });
  }

  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await fileStore().get(row.blobKey, { type: "stream" });
  if (!body) {
    return new Response("That file is no longer on the portal.", { status: 404 });
  }

  return new Response(body, {
    headers: {
      "Content-Type": row.contentType || "application/octet-stream",
      "Content-Disposition": contentDisposition(row.filename),
      "Cache-Control": "private, max-age=300",
      // Defense-in-depth alongside the content-type allowlist enforced at
      // upload: even a row filed before that allowlist existed can't have its
      // stored type sniffed into something the browser will run.
      "X-Content-Type-Options": "nosniff",
    },
  });
};

