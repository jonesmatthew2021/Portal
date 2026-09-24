/* Portways Documentation — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
function CrewListFormPage({ people }) {
  const { swingLists, swingDates, swingBoards } = usePortal();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [opened, setOpened] = useState(null);

  // Everyone on any swing list, one entry per person — the same names the
  // Swing Compliance page shows.
  const swingCrew = useMemo(() => {
    const seen = new Set(); const out = [];
    Object.keys(swingLists || {}).sort().forEach((k) => {
      (((swingLists || {})[k] || {}).entries || []).forEach((e) => {
        const name = String(e.name || "").trim();
        if (!name || seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());
        out.push({ name, rank: e.rank || "" });
      });
    });
    return out;
  }, [swingLists]);

  // First name + surname, lowercased — how a portal name ("Alan Smith")
  // finds its form entry ("Alan James SMITH") whatever the middle names.
  const keyOf = (n) => {
    const w = String(n || "").toLowerCase().replace(/[^a-z\s'-]/g, " ").trim().split(/\s+/);
    return w.length ? w[0] + " " + w[w.length - 1] : "";
  };

  const open = async () => {
    setBusy(true); setErr(""); setOpened(null);
    // The tab is opened in the same breath as the click — a browser only
    // allows a new tab from the click itself, and the fetch below would
    // spend that permission. A browser that refuses a new tab altogether
    // gets the form in this tab instead, with Back returning to the portal.
    const win = window.open("", "_blank");
    try {
      // Beside the portal on the live site; under source/ on the local server.
      let res = await fetch("crew-list-form.html");
      if (!res.ok) res = await fetch("source/crew-list-form.html");
      if (!res.ok) throw new Error("The form template (crew-list-form.html) isn't on the server.");
      let html = await res.text();

      const readList = (re) => {
        const m = re.exec(html);
        try { return m ? JSON.parse(m[1]) : []; } catch (e) { return []; }
      };

      // The form's own crew list, kept for SAMS numbers and position wording.
      const held = {};
      readList(/const CREW=(\[.*?\]);/).forEach((c) => {
        const k = keyOf(c.n); if (k && !held[k]) held[k] = c;
      });

      const crew = swingCrew.map(({ name, rank }) => {
        const was = held[keyOf(name)];
        return was ? { s: was.s, n: was.n, p: was.p }
          : { s: "", n: name, p: RANK_TO_PORTWAYS[rank] || rank || "" };
      }).sort((a, b) => a.n.localeCompare(b.n));
      if (!crew.length) throw new Error("The swing lists are empty — there is nobody to put on the form.");
      html = html.replace(/const CREW=\[.*?\];/, "const CREW=" + JSON.stringify(crew) + ";");

      // The designated crew-change days: the form's own list plus every
      // fly-out date the portal holds, oldest first.
      const dates = readList(/const CREW_CHANGE_DATES=(\[.*?\]);/);
      Object.values(swingDates || {}).forEach((s) => {
        const d = s && s.flyOut;
        if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && dates.indexOf(d) < 0) dates.push(d);
      });
      dates.sort();
      html = html.replace(/const CREW_CHANGE_DATES=\[.*?\];/, "const CREW_CHANGE_DATES=" + JSON.stringify(dates) + ";");

      // -- the planned crew list: who flies out at the next crew change ------
      // The swing after the one onboard now. Its crew letter names the joining
      // swing list, its fly-out day is the crew-change date, and its board —
      // where one has been worked on the roster — says who stands which watch.
      const k1 = currentSwingIndex() + 1;
      const sw = swingWithDates(k1, swingDates);
      const joining = ((((swingLists || {})[sw.crew]) || {}).entries || [])
        .map((e) => ({ name: String(e.name || "").trim(), rank: String(e.rank || "") }))
        .filter((e) => e.name);
      const board = (swingBoards || {})[k1] || null;
      const watchFor = (name) => {
        const person = (people || []).find((p) => p && keyOf(p.name) === keyOf(name));
        const w = person && board && board.shift ? board.shift[person.id] : "";
        // The form's AM watch is the 2400-1200 shift — the portal's night.
        return w === "night" ? "AM" : w === "day" ? "PM" : "";
      };
      const samsFor = (name) => { const c = crew.find((x) => keyOf(x.n) === keyOf(name)); return c ? c.s : ""; };

      // The form's fixed rows, in the order it draws them. `take` is matched
      // against the swing list's rank wording, loosely on purpose. Someone
      // whose watch the board knows goes to that watch's row; otherwise the
      // pair fills in order and the watches are swapped on the form if wrong.
      const SLOTS = [
        { i: 0, take: ["master"], watch: "AM" }, { i: 1, take: ["master"], watch: "PM" },
        { i: 2, take: ["chief mate", "chief officer"], watch: "AM" }, { i: 3, take: ["chief mate", "chief officer"], watch: "PM" },
        { i: 4, take: ["2nd mate", "second mate"], watch: "AM" }, { i: 5, take: ["2nd mate", "second mate"], watch: "PM" },
        { i: 6, take: ["chief engineer"] }, { i: 7, take: ["1st engineer", "first engineer"] },
        { i: 8, take: ["assistant engineer", "junior engineer"], watch: "AM" },
        { i: 9, take: ["assistant engineer", "junior engineer"], watch: "PM" },
        { i: 10, take: ["gph"], watch: "AM" }, { i: 11, take: ["gph"], watch: "PM" },
        { i: 12, take: ["gph"], watch: "AM" }, { i: 13, take: ["gph"], watch: "PM" },
        { i: 16, take: ["cook"] },
      ];
      // The form's own eligibility, read off the copy itself, so nobody is
      // pressed into a row the form would refuse — its Chief Mate Unlimited
      // slot takes only the SAMS numbers on Portways' CMU list, and the rest
      // go by the Portways position wording each person carries.
      const cmuSet = (() => {
        const m2 = /const CMU_SET=new Set\((\[.*?\])\)/.exec(html);
        try { return new Set(m2 ? JSON.parse(m2[1]) : []); } catch (e) { return new Set(); }
      })();
      const mayFill = (c, sl) => {
        if (!c) return false;
        if (sl.i <= 1) return c.p === "Master";
        if (sl.i === 2) return cmuSet.has(c.s);
        if (sl.i === 3) return c.p === "Chief Officer";
        if (sl.i <= 5) return c.p === "Second Mate" || c.p === "Chief Officer";
        if (sl.i === 6) return c.p === "Chief Engineer";
        if (sl.i === 7) return c.p === "First Engineer";
        if (sl.i <= 9) return ["Assistant Engineer", "First Engineer", "Chief Engineer"].indexOf(c.p) >= 0;
        if (sl.i <= 13) return c.p !== "Cook";
        return c.p === "Cook";
      };

      const fill = {};
      const unplaced = [];
      joining.forEach((e) => {
        const r = e.rank.toLowerCase();
        const c = crew.find((x) => keyOf(x.n) === keyOf(e.name)) || null;
        // Someone without a SAMS number goes in through the form's own
        // "Other (not listed)" route, which every row accepts.
        const entry = c && c.s ? { s: c.s } : { other: e.name };
        const cand = SLOTS.filter((sl) => !fill[sl.i]
          && sl.take.some((t) => r === t || r.includes(t) || t.includes(r))
          && (entry.other ? true : mayFill(c, sl)));
        const w = watchFor(e.name);
        const slot = (w && cand.find((sl) => sl.watch === w)) || cand[0];
        if (slot) { fill[slot.i] = entry(); return; }
        // The two flexible rows take the overflow — extra GPHs and engineers.
        if (r.includes("gph") || r.includes("engineer") || r.includes("eto")) {
          const fi = [14, 15].find((i) => !fill[i]);
          if (fi != null) { fill[fi] = Object.assign({ pos: r.includes("gph") ? "GPH" : "Assistant Engineer" }, entry); return; }
        }
        unplaced.push(e.name);
      });

      // Pressed into the page by a script that runs once and takes itself out
      // of the document — the form's own Save editable copy keeps the choices,
      // never the script. A copy already carrying saved work is left alone.
      const boot = {
        fields: { partnership: VESSEL.portways.partnership, vessel: VESSEL.portways.vessel, changedate: sw.flyOut },
        fill,
      };
      const bootScript = "\n<scr" + "ipt>\n"
        + "/* Written by the crew portal as this copy was opened: it presses the\n"
        + "   same dropdowns a person would, once, then removes itself - a saved\n"
        + "   copy carries the choices, not this script. */\n"
        + "(function(){\n"
        + "  var el = document.currentScript; if (el) el.remove();\n"
        + "  if (document.getElementById('pwSavedState')) return;\n"
        + "  var BOOT = " + JSON.stringify(boot).replace(/</g, "\\u003c") + ";\n"
        + "  function setVal(input, v){ if(!input||!v) return; input.value=v;\n"
        + "    input.dispatchEvent(new Event('input',{bubbles:true}));\n"
        + "    input.dispatchEvent(new Event('change',{bubbles:true})); }\n"
        + "  function go(){ try{\n"
        + "    setVal(document.getElementById('partnership'), BOOT.fields.partnership);\n"
        + "    setVal(document.getElementById('vessel'), BOOT.fields.vessel);\n"
        + "    setVal(document.getElementById('changedate'), BOOT.fields.changedate);\n"
        + "    var body = document.getElementById('plannedBody'); if(!body) return;\n"
        + "    Object.keys(BOOT.fill).forEach(function(i){\n"
        + "      var row = body.children[Number(i)]; if(!row) return;\n"
        + "      var f = BOOT.fill[i];\n"
        + "      if (f.pos){ var ps = row.querySelector('select.r-pos'); if (ps) setVal(ps, f.pos); }\n"
        + "      var nm = row.querySelector('.r-name'); if (!nm) return;\n"
        + "      if (f.s){ setVal(nm, f.s); }\n"
        + "      else if (f.other){ setVal(nm, '__other__'); var ot = row.querySelector('.r-name-other'); if (ot) setVal(ot, f.other); }\n"
        + "    });\n"
        + "  }catch(e){} }\n"
        + "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();\n"
        + "})();\n"
        + "</scr" + "ipt>\n";
      html = html.indexOf("</body>") >= 0 ? html.replace("</body>", bootScript + "</body>") : html + bootScript;

      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      if (win) {
        win.location = url;
        setTimeout(() => URL.revokeObjectURL(url), 120000);
        setOpened({ crew: crew.length, sams: crew.filter((c) => c.s).length,
          swing: `${sw.crew} · flying out ${fmtDate(sw.flyOut)}`,
          placed: Object.keys(fill).length, joining: joining.length, unplaced });
      } else {
        window.location.assign(url);
        return;
      }
    } catch (e) {
      try { if (win) win.close(); } catch (x) {}
      setErr(String((e && e.message) || e));
    }
    setBusy(false);
  };

  return (
    <div>
      <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.accent}`,
        borderRadius: 2, padding: "16px 18px", marginBottom: 14 }}>
        <Eyebrow color={T.accent}>Portways form</Eyebrow>
        <div style={{ fontFamily: T.body, fontSize: 15, fontWeight: 700, color: T.text, marginTop: 8 }}>
          Crew List &amp; Shift Allocation
        </div>
        <div style={{ marginTop: 12 }}>
          <Button onClick={open} disabled={busy || !swingCrew.length}>
            {busy ? "Preparing..." : "Open the form with today's crew"}
          </Button>
        </div>
        {opened && (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bGreen, marginTop: 8 }}>
            Opened with {opened.crew} crew in the name lists ({opened.sams} with their SAMS number)
            and the planned crew list filled with swing {opened.swing} — {opened.placed} of
            {" "}{opened.joining} placed in their position rows.
            {opened.unplaced.length > 0 && ` No row could be picked for ${opened.unplaced.join(", ")} — add them on the form by hand.`}
          </div>
        )}
        {err && (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginTop: 8 }}>{err}</div>
        )}
        {!swingCrew.length && (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, marginTop: 8 }}>
            The swing lists are empty, so there is nobody to put on the form yet — fill them in on
            Swings first.
          </div>
        )}
      </div>
    </div>
  );
}
