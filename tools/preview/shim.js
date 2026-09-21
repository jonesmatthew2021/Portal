<script>
/* ============================ TEST PREVIEW ============================ */
/* Answers the portal's own API calls from the crew-data snapshot taken   */
/* with the archive, so the portal runs and saves without a server.       */
(() => {
  const SNAPSHOT = __SNAPSHOT__;
  const FILE_ROWS = __FILE_ROWS__;
  // When preview.html sits in the archive folder, the real documents sit right
  // next to it under documents/ — so a file's link can point straight at the
  // copy on disk and open in a new tab, exactly as it would on the live portal.
  const fileHref = (row) =>
    row.path ? "documents/" + row.path.split("/").map(encodeURIComponent).join("/") : "/api/files/" + row.id;

  const mem = {
    rev: SNAPSHOT.rev,
    data: SNAPSHOT.data,
    rows: FILE_ROWS.map((r) => ({ ...r })),
  };

  const SINGLE = {
    "training-matrix": { label: "training matrix", required: true },
    "skills-matrix": { label: "skills matrix", required: true },
    "validity-matrix": { label: "validity matrix", required: false },
    "opms-sheet": { label: "OPMS sheet", required: false },
    "shift-allocation": { label: "shift allocation", required: false },
    "certificate-sheet": { label: "certificate sheet", required: false },
  };

  const humanSize = (b) =>
    b >= 1024 * 1024 ? (b / (1024 * 1024)).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";

  // Mirrors toRecord() in worker/src/routes/files.ts.
  const toRecord = (row) => {
    const common = {
      id: row.id,
      filename: row.filename,
      size: humanSize(row.sizeBytes || 0),
      url: fileHref(row),
      session: row.sessionId ?? null,
      stored: true,
    };
    if (row.category === "note")
      return { ...common, rank: row.rank ?? null, swing: row.swing ?? null, by: row.uploadedBy ?? null, uploaded: row.filedOn ?? null };
    if (row.category === "correspondence")
      return { ...common, kind: "email", party: row.party ?? null, tag: row.tag ?? null, title: row.title ?? null, postedBy: row.uploadedBy ?? null, date: row.filedOn ?? null };
    if (row.category === "matrix")
      return { ...common, by: row.uploadedBy ?? null, uploaded: row.filedOn ?? null };
    if (row.category === "certificate")
      return { ...common, person: row.person ?? null, folder: row.folder ?? null, path: row.blobKey ?? null, qualCode: row.qualCode ?? null, title: row.title ?? null, expires: row.expiresOn ?? null, checksum: row.checksum ?? null, by: row.uploadedBy ?? null, uploaded: row.filedOn ?? null };
    if (SINGLE[row.category])
      return { ...common, path: row.blobKey ?? null, title: row.title ?? null, by: row.uploadedBy ?? null, uploaded: row.filedOn ?? null };
    return { ...common, title: row.title ?? null, from: row.source ?? null, tag: row.tag ?? null, date: row.filedOn ?? null };
  };

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const text = (s, status = 200) => new Response(s, { status });

  const uuid = () =>
    crypto.randomUUID ? crypto.randomUUID() : "prev-" + Math.random().toString(36).slice(2) + Date.now();

  const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth" }).format(new Date());

  const field = (form, name) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  const slug = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown";

  async function handleState(req) {
    if (req.method === "GET") return json({ rev: mem.rev, data: mem.data });
    if (req.method !== "PUT") return text("Method not allowed", 405);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "The change couldn't be read." }, 400);
    }
    const base = Number(body.rev);
    if (!Number.isInteger(base) || base < 0)
      return json({ error: "Missing the revision this change was based on." }, 400);
    if (body.data === null || typeof body.data !== "object")
      return json({ error: "The change didn't contain anything to save." }, 400);
    if (base !== mem.rev && !(base === 0 && mem.rev === 0))
      return json({ conflict: true, rev: mem.rev, data: mem.data }, 409);
    mem.data = body.data;
    mem.rev = base === 0 ? 1 : mem.rev + 1;
    return json({ rev: mem.rev });
  }

  async function handleFiles(req, url) {
    if (req.method === "GET") {
      const wantRemoved = url.searchParams.get("removed") === "1";
      const rows = mem.rows
        .filter((r) => (wantRemoved ? r.removedAt : !r.removedAt))
        .sort((a, b) =>
          String(wantRemoved ? b.removedAt : b.createdAt || "").localeCompare(
            String(wantRemoved ? a.removedAt : a.createdAt || ""),
          ),
        );
      return json(
        rows.map((row) => ({
          category: row.category,
          bucket: row.bucket ?? null,
          record: toRecord(row),
          ...(wantRemoved
            ? { removedAt: row.removedAt, removedBy: row.removedBy ?? null, person: row.person ?? null, title: row.title ?? null }
            : null),
        })),
      );
    }
    if (req.method !== "POST") return text("Method not allowed", 405);

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "No file was included." }, 400);

    const category = field(form, "category") || "document";
    const single = SINGLE[category];
    const id = uuid();
    const now = new Date().toISOString();

    const row = {
      id,
      category,
      bucket: field(form, "bucket"),
      blobKey: (category === "certificate" ? "certification/" : "uploads/") + id,
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      title: field(form, "title"),
      uploadedBy: field(form, "uploadedBy"),
      tag: field(form, "tag"),
      source: field(form, "source"),
      party: field(form, "party"),
      rank: field(form, "rank"),
      swing: field(form, "swing"),
      filedOn: field(form, "filedOn") || todayISO(),
      sessionId: field(form, "session"),
      createdAt: now,
      removedAt: null,
      removedBy: null,
    };

    if (category === "certificate") {
      const person = field(form, "person") || "Unknown";
      row.person = person;
      row.folder = slug(person);
      row.bucket = row.folder;
      row.qualCode = field(form, "qualCode");
      row.expiresOn = field(form, "expiresOn");
    }
    if (single) {
      for (const r of mem.rows) {
        if (r.category === category && !r.removedAt) {
          r.removedAt = now;
          r.removedBy = row.uploadedBy || "replaced";
        }
      }
    }

    mem.rows.unshift(row);
    return json({ category: row.category, bucket: row.bucket, record: toRecord(row) }, 201);
  }

  async function handleFile(req, url, id) {
    const row = mem.rows.find((r) => r.id === id);
    if (!row) return text("That file is no longer on the portal.", 404);

    if (req.method === "DELETE") {
      const single = SINGLE[row.category];
      if (single && single.required && !row.removedAt)
        return json(
          { error: "The " + single.label + " is required at all times, so it can't be removed on its own. Upload a newer " + single.label + " to replace it." },
          409,
        );
      if (url.searchParams.get("purge") === "1") {
        if (!row.removedAt) return json({ error: "Remove the file from the portal first, then delete it for good." }, 409);
        mem.rows = mem.rows.filter((r) => r.id !== id);
        return new Response(null, { status: 204 });
      }
      row.removedAt = new Date().toISOString();
      row.removedBy = url.searchParams.get("by") || null;
      return json({ removed: true, id: row.id, filename: row.filename });
    }

    if (req.method === "PATCH") {
      let body = null;
      try {
        body = await req.json();
      } catch {}
      if (body && body.edit && typeof body.edit === "object") {
        if (row.category !== "certificate") return json({ error: "Only crew certificates can be edited this way." }, 400);
        const clean = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
        if ("qualCode" in body.edit) row.qualCode = clean(body.edit.qualCode);
        if ("title" in body.edit) row.title = clean(body.edit.title);
        if ("expiresOn" in body.edit) {
          const d = clean(body.edit.expiresOn);
          if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d))
            return json({ error: "The expiry date has to be a whole date, as YYYY-MM-DD." }, 400);
          row.expiresOn = d;
        }
        return json({ edited: true, id: row.id, qualCode: row.qualCode ?? null, expiresOn: row.expiresOn ?? null, title: row.title ?? null });
      }
      const single = SINGLE[row.category];
      if (single && mem.rows.some((r) => r.category === row.category && !r.removedAt))
        return json({ error: "There is already a current " + single.label + ". Remove that one first, then restore this." }, 409);
      row.removedAt = null;
      row.removedBy = null;
      return json({ restored: true, category: row.category, bucket: row.bucket ?? null, id: row.id, filename: row.filename });
    }

    // GET — a file filed in the snapshot opens straight from the documents/
    // folder beside this page; only something uploaded inside this preview
    // session has no copy on disk to open.
    return text(
      "This file was added inside the test preview, so there's no saved copy of it to open — on the live portal it would.",
      404,
    );
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    const url = new URL(req.url, location.href);
    // On Windows, a page opened from disk resolves "/api/state" with the drive
    // letter kept in front ("/C:/api/state") — strip it so the routes match on
    // every machine.
    const p = url.pathname.replace(/^\/[A-Za-z]:/, "");
    try {
      if (p === "/api/state") return await handleState(req);
      if (p === "/api/files") return await handleFiles(req, url);
      const m = p.match(/^\/api\/files\/([^/]+)$/);
      if (m) return await handleFile(req, url, decodeURIComponent(m[1]));
      /* Update documentation does a round of the library before it shows
         anything. There is no library behind the preview, so it is answered
         with an empty round: nothing arrived, nothing went, nothing moved.
         That is enough for everything the round leads to - the crew names, the
         matrix items, the file names - to come up and be looked at. */
      if (p === "/api/sync")
        return json({ registered: [], mirrored: 0, followed: 0, moved: [], removed: [] });
      if (p === "/api/rename-file" || p === "/api/rename")
        return json({ error: "Renaming moves the file in SharePoint, so it only runs on the live portal." }, 503);
      if (p === "/api/analyse" || p === "/api/ai-checker" || p === "/api/archive")
        return json(
          { error: "This runs on the live server, so it isn't available in the test preview — everything else here works." },
          503,
        );
    } catch (e) {
      return json({ error: "Preview error: " + (e && e.message ? e.message : e) }, 500);
    }
    return realFetch(input, init);
  };

  // A quiet ribbon so this window is never mistaken for the live portal.
  addEventListener("DOMContentLoaded", () => {
    const el = document.createElement("div");
    el.textContent =
      "TEST PREVIEW \u2014 crew data snapshot (rev " +
      SNAPSHOT.rev +
      "). Changes save only inside this window and reset when it closes.";
    el.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#8a5a00;color:#fff;" +
      "font:600 12px/1.6 system-ui,sans-serif;text-align:center;padding:3px 10px;pointer-events:none;opacity:.92";
    document.body.appendChild(el);
  });
})();
/* ====================================================================== */
</script>
