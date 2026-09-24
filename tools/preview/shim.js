<script>
/* ============================ TEST PREVIEW ============================ */
/* Answers the portal's own API calls from the crew-data snapshot taken   */
/* with the archive, so the portal runs and saves without a server.       */
(() => {
  // The page shows its honour-system name picker only under this shim
  // (showPicker in source/index.html reads the flag): on the live site a
  // failed /api/me is a link that is down, never a way in.
  window.__PORTAL_PREVIEW__ = true;
  const SNAPSHOT = __SNAPSHOT__;
  const FILE_ROWS = __FILE_ROWS__;
  // The vessel file, written in by the build: the shim sits outside the
  // page's own script and cannot see the page's VESSEL.
  const VESSEL = __VESSEL__;
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

  const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: VESSEL.timezone }).format(new Date());

  /* Flags on the preview's address put it in a state the live portal
     would only reach on a bad day, so the lines for that day can be looked
     at: ?reading=credit (the reading stops for credit), ?hourly=credit
     (the last hour stopped for credit), ?backup=missing (the backup folder
     is not in the library), ?sync=held (the last import found too many
     files gone to believe and held the write-off). The out-of-credit sentence is the one in
     source/shared/reading-lines.js, written here again because this shim
     runs outside the page's own script; a check holds the two the same. */
  const flag = (name) => { try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; } };
  /* ?reminders=sent (or =failed, or =unanswered): the weekly reminder
     emails switched on and their last week's record, sent this Monday at
     07:10 - or with one address refused, or one send given up on unanswered
     - so the SharePoint page's reminder line can be looked at. Without the
     flag the setting is the document's, off by default. */
  const reminderFlag = ["sent", "failed", "unanswered"].includes(flag("reminders"));
  if (reminderFlag && mem.data) {
    mem.data = { ...mem.data, reminders: { on: true, days: 90, weekday: 1, hour: 7 } };
  }
  const fakeReminder = () => {
    if (!reminderFlag) return null;
    const at = new Date(); at.setDate(at.getDate() - ((at.getDay() + 6) % 7)); at.setHours(7, 10, 0, 0);
    return { day: todayISO(), at: at.getTime(), window: 90, own: 6, summary: 3,
      failed: flag("reminders") === "failed" ? ["someone@example.com"] : [],
      unanswered: flag("reminders") === "unanswered" ? ["someone@example.com"] : [], skipped: null, error: null };
  };
  /* ?particulars=1: the document as the round leaves it once it has
     filled the first two men's MSIC number and date of birth from their
     certificates - the boxes on Crew Details carrying the values and the
     note of what the certificates put there. The preview has no worker and
     no readings, so there is no round to run here: this is what one leaves
     behind, so the boxes can be looked at and typed over. */
  if (flag("particulars") === "1" && mem.data && Array.isArray(mem.data.people)) {
    const filled = [["MSIC 0123456", "1980-03-10"], ["MSIC 0654321", "1975-05-05"]];
    const fromCert = { ...(mem.data.particularsFromCert || {}) };
    let n = 0;
    const people = mem.data.people.map((p) => {
      if (n >= filled.length || !p || !p.name || p.id == null) return p;
      const [msic, dob] = filled[n++];
      fromCert[String(p.id)] = { msic, dob };
      return { ...p, msic, dob };
    });
    mem.data = { ...mem.data, people, particularsFromCert: fromCert };
  }
  const OUT_OF_CREDIT = "Out of credit — top it up at console.anthropic.com";
  /* ?offline=1: the four answers the service worker keeps come back the
     way it hands them back when the link is down - stamped with the time
     they were fetched, here two hours ago - so the badge's line and the
     held-down controls can be looked at. The header is the one in
     source/shared/offline-rules.js (FETCHED_AT_HEADER), written here
     again because this shim runs outside the page; a rule test holds the
     two the same. With the flag, /api/me is answered too (as the IT
     account, which the live portal would answer from its kept copy), so
     the page boots the way it does at sea rather than through the picker. */
  const OFFLINE_STAMP_HEADER = "X-Portal-Fetched-At";
  // One stamp, set when the page opens: a kept copy was fetched once, so
  // the badge's line stands still rather than ticking forward every poll.
  const OFFLINE_STAMP = new Date(Date.now() - 2 * 60 * 60000).toISOString();
  const stamped = (answer) => {
    if (flag("offline") === "1") answer.headers.set(OFFLINE_STAMP_HEADER, OFFLINE_STAMP);
    return answer;
  };
  // The nightly backup's record: landed this morning, or, under
  // ?backup=missing, refused because the folder is not in the library.
  const fakeBackup = () => {
    const at = new Date(); at.setHours(2, 10, 0, 0);
    return flag("backup") === "missing"
      ? { day: null, at: at.getTime(), name: null, bytes: 0, rev: null, counts: {},
        error: "the folder United Operations Team/Backups is not in the library" }
      : { day: todayISO(), at: at.getTime(), name: "Crew Portal backup " + todayISO() + ".json", bytes: 3251200,
        rev: mem.rev, counts: { documents: mem.rows.length, users: 12, readings: 900, fauna: 3 }, error: null };
  };
  const fakeHourly = () => ({
    at: Date.now() - 20 * 60000, durationMs: 41000, read: 0, refiled: 0, syncError: null,
    readError: flag("hourly") === "credit" ? OUT_OF_CREDIT : null, readStopped: null, readTried: true,
    applied: 0, cleared: 0, written: 0, workbook: null, leftAsTyped: 0, held: null,
    roundError: null, roundSkipped: null, workbookProblem: null, validityProblem: null, equivalenceProblem: null,
  });

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
      // Only what is read gets the offline stamp: a save is never a kept copy.
      const kept = (answer) => (req.method === "GET" ? stamped(answer) : answer);
      if (p === "/api/me" && flag("offline") === "1") {
        return kept(json({ name: VESSEL.it.name, email: "", role: "it", fitToSail: "" }));
      }
      if (p === "/api/state") return kept(await handleState(req));
      if (p === "/api/files") return kept(await handleFiles(req, url));
      const m = p.match(/^\/api\/files\/([^/]+)$/);
      if (m) return await handleFile(req, url, decodeURIComponent(m[1]));
      /* Update documentation does a round of the library before it shows
         anything. There is no library behind the preview, so it is answered
         with an empty round: nothing arrived, nothing went, nothing moved.
         That is enough for everything the round leads to - the crew names, the
         matrix items, the file names - to come up and be looked at. */
      if (p === "/api/sync")
        return json({ registered: [], mirrored: 0, followed: 0, moved: [], removed: [] });
      /* The hourly round's last outcome: the preview has no cron, so nothing
         has run and the page says so. */
      if (p === "/api/sync/last") return kept(json({ sync: null, hourly: flag("hourly") ? fakeHourly() : null, running: false, holder: null }));
      /* The SharePoint page's listing: no library behind the preview, so
         an empty folder, and the hour's and the import's lines only under
         their flags. */
      if (p === "/api/sharepoint")
        return json({ path: url.searchParams.get("path") || "", entries: [],
          lastSync: flag("sync") === "held"
            ? { at: Date.now() - 20 * 60000, by: "hourly schedule", registered: 2, adopted: 0, missing: 26, leftAlone: 0, heldBack: 26, error: null }
            : null,
          lastHourly: flag("hourly") ? fakeHourly() : null, lastBackup: fakeBackup(), lastReminder: fakeReminder() });
      /* The round from the page: nothing has run, there are no rules to
         keep, and the round itself writes the office's workbook, which is
         a live-portal job. */
      if (p === "/api/round/progress") return json({ pct: 0, word: "No round has run yet", done: true, running: false, holder: null });
      if (p === "/api/round/prepare") return json({ equivalences: 0, validity: false, problem: null });
      if (p === "/api/round") return json({ error: "The round only runs on the live portal." }, 503);
      /* The undo list. The preview keeps no history, so the one version it
         holds is the whole list, and putting a version back is a live-portal
         job. */
      if (p === "/api/state/history") {
        const d = mem.data || {};
        const rows = (d.quals && d.quals.rows) || [];
        const dated = rows.reduce((n, r) => n + (r[3] || []).filter((v) => /^d{4}-d{2}-d{2}/.test(String(v || ""))).length, 0);
        return json({ revisions: [{ rev: mem.rev, savedAt: Date.now(), savedBy: "Preview",
          crew: (d.people || []).length, matrixRows: rows.length, datedCells: dated }] });
      }
      if (p === "/api/state/restore")
        return json({ error: "Putting a version back only runs on the live portal." }, 503);
      if (p === "/api/rename-file" || p === "/api/rename")
        return json({ error: "Renaming moves the file in SharePoint, so it only runs on the live portal." }, 503);
      /* The round from the page reads the new certificates and refiles them
         through /api/analyse before it starts the server's round. The preview
         holds no readings and moves no files, so both are answered as already
         done - every certificate read, nothing to refile - and the round
         itself is the 503 above, which the window shows as it is. Every
         other analysis is a live-server job. */
      if (p === "/api/analyse") {
        const body = await req.clone().json().catch(() => null);
        const action = body && body.action;
        if (action === "extract") {
          const total = mem.rows.filter((r) => r.category === "certificate" && !r.removedAt).length;
          // Under ?reading=credit the first batch is the account saying no,
          // so the round's window and the badge show that line.
          if (flag("reading") === "credit")
            return json({ read: 0, total, remaining: total, attempted: Math.min(3, total), extracted: 0, failures: [],
              stopped: { kind: "credit", line: OUT_OF_CREDIT } });
          return json({ read: total, total, remaining: 0, extracted: 0, failures: [], stopped: null });
        }
        if (action === "refile") return json({ moved: [], remaining: 0 });
      }
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
