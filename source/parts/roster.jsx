/* Roster — the swing board and its editor, the swing compliance and day
 * grid, the crew-roster workbook, the timeline and the roster page, and the
 * shift matrix.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state (and the
 * swing dates, which the areas read too); this holds what is only this
 * page's. See tools/source.mjs.
 */

/* ==================================================================== */
/*  Crew Rosters — who is onboard now, who is on the off swing           */
/* ==================================================================== */

/* The two watches. Nobody works both, and plenty of people are onboard without
   being on either — day workers, and anyone whose watch isn't settled yet. */
const SHIFTS = [{ id: "day", label: "Day" }, { id: "night", label: "Night" }];

/**
 * Which side of the board somebody is on.
 *
 * The board says where everybody is, and nothing is worked out.
 *
 * It used to fall back on the pattern - the crew whose turn the calendar said
 * it was got shown onboard - so a portal nobody had set up still opened
 * looking right. That was before Update swings from roster existed. Now the
 * allocations are read off the roster when management asks for it, and a board
 * that has not been generated is a board with nothing on it, not a guess: the
 * pattern quietly moving people on and off as the weeks roll over is exactly
 * what the allocations are supposed to stop doing.
 */
const boardSide = (p, board) => {
  if (!p.active) return "off";
  const held = board && board.side ? board.side[p.id] : null;
  return held === "on" || held === "off" ? held : "off";
};

// Whether a swing has been allocated at all - anybody written down as onboard.
const boardGenerated = (board) =>
  !!board && !!board.side && Object.values(board.side).some((v) => v === "on");

const boardShift = (p, board) => (board && board.shift ? board.shift[p.id] || "" : "");

/**
 * The board written out in full, ready to be changed.
 *
 * Anything still being taken from the pattern is written down as it stands
 * first, so that a change to one person doesn't leave everybody else to drift
 * when the calendar rolls over to the next swing.
 */
function settledBoard(people, board) {
  const side = { ...((board && board.side) || {}) };
  people.forEach((p) => { if (p.active) side[p.id] = boardSide(p, board); });
  return { side, shift: { ...((board && board.shift) || {}) } };
}

/**
 * Somebody on the roster, added or changed.
 *
 * Crew is the swing they belong to when the vessel is running to pattern. It is
 * left blank for anyone who isn't on a rotation — a fill-in flown up for one
 * trip, or somebody shore-based — because those people are moved by hand and
 * are not carried across by a crew change.
 */
function PersonEditor({ person, onSave, onRemove, onCancel, matrix, onRank }) {
  // The rank is the position the crew matrix holds against them; saving
  // writes it there, and every page that reads it follows.
  const [rank, setRank] = useState((matrix && matrix.rank) || "");
  const [f, setF] = useState({
    name: person.name || "",
    dept: person.dept || DEPT_ORDER[0],
    crew: person.crew || "",
    active: person.active !== false,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const name = f.name.trim();

  return (
    <div style={{ background: T.panel, border: `1px solid ${T.accent}`, borderRadius: 2,
      padding: "15px 17px", marginBottom: 22 }}>
      <div style={{ marginBottom: 13 }}>
        <Eyebrow color={T.accent}>{person.id ? `Edit ${person.name}` : "Add crew member"}</Eyebrow>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 13 }}>
        <div style={{ flex: "1 1 220px" }}>
          <Field label="Name">
            <input className="um-in" value={f.name} onChange={set("name")}
              placeholder="The name the crew use for them" />
          </Field>
        </div>
        <div style={{ flex: "1 1 160px" }}>
          <ChoiceField label="Department">
            <Choices value={f.dept} onPick={(v) => setF({ ...f, dept: v })} options={DEPT_ORDER} compact />
          </ChoiceField>
        </div>
        <div style={{ flex: "1 1 160px" }}>
          <ChoiceField label="Swing">
            <Choices value={f.crew} onPick={(v) => setF({ ...f, crew: v })} compact
              options={[{ value: "", label: "Not on a rotation" },
                ...SWINGS.map((s) => ({ value: s.letter, label: s.name }))]} />
          </ChoiceField>
        </div>
      </div>

      {matrix ? (
        <div style={{ marginBottom: 13 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 260px" }}>
              <ChoiceField label={matrix.name
                ? `Rank / position — on the matrix as ${matrix.name}`
                : "Rank / position — saving adds them to the crew matrix"}>
                <Choices value={rank} compact onPick={(v) => setRank(v)}
                  options={matrix.options.map((p) => ({ value: p, label: p }))} />
              </ChoiceField>
            </div>
            <div style={{ flex: "0 1 220px" }}>
              <Field label="Or type a new one">
                <input className="um-in" value={rank} onChange={(e) => setRank(e.target.value)} />
              </Field>
            </div>
          </div>
        </div>
      ) : null}

      <label style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 15,
        fontFamily: T.body, fontSize: 13.5, color: T.text, cursor: "pointer" }}>
        <input type="checkbox" checked={f.active}
          onChange={(e) => setF({ ...f, active: e.target.checked })} />
        On the roster. Turn this off for somebody who has left — they keep their history and can be
        put back at any time, and they are never shown onboard.
      </label>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button writes onClick={() => {
            if (!name) return;
            const canon = canonicalName(name);
            const r = rank.trim();
            if (matrix && onRank && r && r !== (matrix.rank || "")) {
              onRank(matrix.name, r, canon);
            }
            // The rank decides the roster's own grouping too — the department
            // follows it, so one save applies the rank everywhere at once.
            const dept = r ? deptForRank(r) : f.dept;
            onSave({ ...person, ...f, dept, name: canon, crew: f.crew || null });
          }}
          disabled={!name}>
          {person.id ? "Save" : "Add to the roster"}
        </Button>
        {person.id && (
          <Button writes variant="ghost" onClick={() => onRemove(person)}
            title="Take them off the roster altogether. Turning them off above keeps the record instead.">
            Remove
          </Button>
        )}
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}


function canonicalName(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
  if (!s) return s;
  const word = (w) => w.split(/([-'])/).map((p) =>
    p === "-" || p === "'" ? p : p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p).join("");
  let last, firsts;
  if (s.includes(",")) {
    const [l, ...rest] = s.split(",");
    last = l.trim(); firsts = rest.join(",").trim();
  } else {
    const parts = s.split(" ");
    if (parts.length === 1) return word(parts[0]);
    /* Which half is the surname, where no comma says so. A word in capitals is
       the surname wherever it has been put - that is how the office writes
       them, and it is the only thing in "Evgeny EVDOKIMOV" that says which way
       round it goes. Failing that the last word is taken, which is how a name
       is written in English more often than not. The worker reads a folder name
       by the same rule, so both halves of the portal land on the one form. */
    const shouted = parts.findIndex((w) => w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w));
    const at = shouted >= 0 ? shouted : parts.length - 1;
    last = parts[at]; firsts = parts.filter((_, i) => i !== at).join(" ");
  }
  const first = firsts.split(" ").filter(Boolean).map(word).join(" ");
  return first ? `${last.toUpperCase()}, ${first}` : last.toUpperCase();
}

/* The two swings the vessel runs to. The roster has always held A and B against
   each person and everything else in the portal reads that letter, so the letter
   is still what is written down — the names are what the office calls them
   and what the crew see, from the vessel file. */
const SWINGS = [
  { letter: "A", name: VESSEL.swings.labels.A, colour: T.accent },
  { letter: "B", name: VESSEL.swings.labels.B, colour: T.bYellow },
];

const swingNamed = (letter) => (SWINGS.find((s) => s.letter === letter) || {}).name || `Swing ${letter}`;
/* The crew's name on the roster, by the swing's id - the swing's label with
   "Swing" taken off, the way the worker says it (lib/portal.ts). A roster
   row carries the id; the file lists the ids and the labels in the same
   order, A then B. An id the file does not carry is shown as it is. */
const SWING_CREW_WORD = Object.fromEntries(VESSEL.swings.ids.map((id, i) =>
  [id, String((SWINGS[i] || {}).name || id).replace(/^Swing\s+/i, "")]));
const swingCrewWord = (id) => SWING_CREW_WORD[id] || id;
const swingCrewCalled = (id) => (SWING_CREW_WORD[id] ? SWING_CREW_WORD[id] + " crew" : id);



// Which of the roster's departments a rank belongs to. Order matters: a chief
// officer is deck and a chief engineer is not, and both start the same way.
const DEPT_FOR_RANK = [
  [/master|skipper|coxswain/i, "Masters"],
  [/engineer|c\/e|\beto\b|electrician|oiler|motorman|greaser/i, "Engineers"],
  [/officer|mate|c\/o|navigat/i, "DECK OFFICERS"],
  [/cook|chef|steward|galley/i, "Chefs"],
];

const deptForRank = (rank) => {
  const hit = DEPT_FOR_RANK.find(([re]) => re.test(rank || ""));
  return hit ? hit[1] : "GPH";
};






/**
 * Who on the roster each name on a list answers to.
 *
 * The list has people's full names on it and the roster carries the name the
 * crew use, so the two are matched the same way a dropped certificate folder is.
 * A name that fits nobody is a newcomer; a name that fits somebody already
 * claimed is left to the first, rather than putting one person on the list twice.
 */
function matchSwingList(entries, people) {
  const names = entries.map((e) => e.name);
  const claimed = new Map(); // person id -> the name the document used
  const taken = new Set();

  people.filter((p) => p.active).forEach((p) => {
    const hit = matchRoster(p.name, names);
    if (hit && !taken.has(hit)) { taken.add(hit); claimed.set(p.id, hit); }
  });

  return { claimed, newcomers: entries.filter((e) => !taken.has(e.name)) };
}

/**
 * The crew rosters page: two columns, and the two things that move people
 * between them.
 *
 * What was here before was the roster the calendar says we should be running —
 * eight swings across the page, worked out from the anchor date. It was never
 * what anybody wanted to know. The question is who is on the vessel now and
 * which watch they are on, and the answer to that is not a calculation: people
 * swap, come out early, stay an extra week, and a fill-in is flown up for one
 * trip. So the board is held as what somebody put there, and the two ordinary
 * ways it moves — a crew change, and the swing lists the office sends — are a
 * button each.
 *
 * Who belongs to which swing is not worked out here either. Each swing's crew
 * arrives as a document, and each is shown exactly as it was written.
 */
/* The rank headings the swing board is read under, in the order a swing list
   is written: bridge first, engine room after, galley last. A person's rank is
   the position the matrix holds against their name — the roster's departments
   are too broad for this page, where a Chief Engineer and an Assistant
   Engineer are different lines on the list. */
/* Where a position sits in the order the vessel is manned in, read off
   * RANK_GROUPS below: masters, deck officers, engineers, GPH, cooks. A
   * position the list does not recognise goes to the end rather than to the
   * top, because an unknown rank is not a senior one.
   *
   * Module level because the crew matrix and the swing board both sort by it,
   * and two copies of an order like this is two orders waiting to disagree.
   */
const rankGroupAt = (position) => {
  const i = RANK_GROUPS.findIndex(([, re]) => re.test(String(position || "")));
  return i < 0 ? RANK_GROUPS.length : i;
};

/* The headings and what each one matches, from the vessel file: a heading and
   the pattern a position must match to sit under it, made case-blind here.
   One berth can have two names - the office's matrix says "Assistant
   Engineer" and a vessel's own list of ranks may say "JUNIOR ENGINEER", and
   they are the same man - so a heading's pattern names both, rather than the
   junior engineers falling through to "Other", which is what they did. */
const RANK_GROUPS = VESSEL.rankGroups.map(([heading, pattern]) => [heading, new RegExp(pattern, "i")]);

function CrewRosters({ people, setPeople, board, setBoard, log, currentUser, viewSwing, overrides, onShowNow, readOnly, asAt }) {
  // Swing Compliance shows the board to read it against the certificates, not
  // to work on it - the crew are moved on the Roster page.
  const admin = isAdmin(currentUser) && !readOnly;
  const { swingLists, setSwingLists, swingDates, swingBoards, setSwingBoards, quals: MATRIX, setQuals } = usePortal();

  // The roster is typed in shorthand — "Arthur", "Ruwan" — but the crew have
  // one full name each on the matrix, so that is the name shown: whoever a
  // shorthand answers to unambiguously wears their matrix name here. A name
  // the matrix can't place stays as typed. Two entries that resolve to the
  // same person — or two identical placeholders — are flagged as duplicates.
  const fullNames = useMemo(() => {
    const names = MATRIX.rows.map((r) => r[0]);
    const m = {};
    // A name already in SURNAME, First form is shown exactly as stored. The
    // matrix match only fills out old shorthand entries ("Alan") — it must
    // never swallow a new person who shares a given name with somebody.
    people.forEach((p) => {
      m[p.id] = p.name.includes(",") ? p.name : (matchRoster(p.name, names) || p.name);
    });
    return m;
  }, [people, MATRIX]);
  const fullName = (p) => fullNames[p.id] || p.name;
  const isDup = useMemo(() => {
    const counts = {};
    people.filter((p) => p.active).forEach((p) => {
      const k = (fullNames[p.id] || p.name).trim().toUpperCase();
      counts[k] = (counts[k] || 0) + 1;
    });
    return (p) => (counts[(fullNames[p.id] || p.name).trim().toUpperCase()] || 0) > 1;
  }, [people, fullNames]);

  // Which rank heading each person sits under: the matrix's position for their
  // name, read against RANK_GROUPS. Anyone the matrix can't place keeps their
  // roster department as the heading instead of dropping off the page.
  const rankGroup = useMemo(() => {
    const posByName = Object.fromEntries(MATRIX.rows.map((r) => [r[0], r[1] || ""]));
    const m = {};
    people.forEach((p) => {
      const pos = posByName[fullNames[p.id]] || "";
      const hit = RANK_GROUPS.find(([, re]) => re.test(pos));
      m[p.id] = hit ? hit[0] : null;
    });
    return m;
  }, [people, fullNames, MATRIX]);
  const groupOf = (p) => rankGroup[p.id] || p.dept;
  const lists = swingLists || { A: null, B: null };
  const [sub, setSub] = useState("board");
  const [editing, setEditing] = useState(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);

  const crew = people.filter((p) => p.active);
  const onboard = crew.filter((p) => boardSide(p, board) === "on");
  const off = crew.filter((p) => boardSide(p, board) === "off");
  const gone = people.filter((p) => !p.active);

  /* A coming swing picked on the compliance cards above is shown with a board
     of its own, kept against the swing number — the same side-and-shift shape
     as the live board, and worked with the same buttons: people put on and off
     the swing, watches set, crew added and removed. Anyone that swing's board
     doesn't mention yet follows the rotation and its one-off changes, and
     nothing done here touches the live board — who is on the vessel today is
     the swingBoard, and only the swingBoard. A pick that isn't ahead of today
     (the swing that is on, or one gone stale while the page sat open) is the
     board itself. */
  const looking = viewSwing != null && viewSwing > currentSwingIndex();
  const ahead = looking ? swingWithDates(viewSwing, swingDates) : null;
  const aheadHeld = looking ? (swingBoards || {})[viewSwing] || { side: {}, shift: {} } : null;
  const aheadSide = (p) => {
    if (!p.active) return "off";
    const held = (aheadHeld.side || {})[p.id];
    return held === "on" || held === "off" ? held : "off";
  };
  /* Read as at a day - Swing Compliance asks for today - somebody whose own
     days have finished, or havent started, is ashore rather than onboard.
     Left off, the board is the board: everyone on the swing, so they can be
     worked on. */
  const dayWindows = (looking ? (aheadHeld || {}).window : (board || {}).window) || {};
  const aboardOn = (p) => {
    if (!asAt) return true;
    const w = dayWindows[p.id];
    if (!w || !w.from || !w.to) return true;
    return asAt >= w.from && asAt < w.to;
  };
  const sideOf = (p) => {
    const side = looking ? aheadSide(p) : boardSide(p, board);
    return side === "on" && !aboardOn(p) ? "off" : side;
  };
  const shiftOf = (p) => (looking ? (aheadHeld.shift || {})[p.id] || "" : boardShift(p, board));

  /* A change to the picked swing's board, with the board written out in full
     first — the same settling the live board gets, so moving one person can't
     leave everybody else drifting with the rotation. Boards for swings already
     gone are dropped on the way through rather than kept forever. */
  const putAhead = (change) => {
    setSwingBoards((all) => {
      const held = (all || {})[viewSwing] || { side: {}, shift: {} };
      const out = { side: {}, shift: { ...(held.shift || {}) } };
      people.forEach((p) => {
        if (!p.active) return;
        const h = (held.side || {})[p.id];
        out.side[p.id] = h === "on" || h === "off" ? h : "off";
      });
      change(out);
      const next = {};
      Object.keys(all || {}).forEach((k) => { if (Number(k) > currentSwingIndex()) next[k] = all[k]; });
      next[viewSwing] = out;
      return next;
    });
  };

  const shownOn = crew.filter((p) => sideOf(p) === "on");
  const shownOff = crew.filter((p) => sideOf(p) !== "on");

  const onDay = shownOn.filter((p) => shiftOf(p) === "day").length;
  const onNight = shownOn.filter((p) => shiftOf(p) === "night").length;
  const noWatch = shownOn.length - onDay - onNight;

  // Every rank heading in the order above, with the department of anyone the
  // matrix can't place on the end rather than dropped off the page.
  const rankNames = RANK_GROUPS.map(([g]) => g);
  const depts = [
    ...rankNames,
    ...Array.from(new Set(crew.filter((p) => !rankGroup[p.id]).map((p) => p.dept)))
      .filter((d) => !rankNames.includes(d)).sort(),
  ];

  const savePerson = (updated) => {
    if (updated.id) {
      const before = people.find((p) => p.id === updated.id);
      const diffs = ["name", "dept", "crew", "active"]
        .filter((k) => before[k] !== updated[k])
        .map((k) => `${k}: ${before[k] ?? "—"} → ${updated[k] ?? "—"}`);
      setPeople(people.map((p) => (p.id === updated.id ? updated : p)));
      if (diffs.length) log("Crew Rosters", `Updated ${before.name}`, diffs.join(", "));
    } else {
      const p = { ...updated, id: "p-" + Date.now() };
      setPeople([...people, p]);
      // Somebody added while a coming swing is on screen was added FOR that
      // swing, so they go straight onto it — the live board is left alone.
      if (looking) putAhead((b) => { b.side[p.id] = "on"; });
      log("Crew Rosters", `Added ${p.name} to the roster`,
        `${p.dept}, ${p.crew ? "Crew " + p.crew : "not on rotation"}${looking ? ` · onto ${swingLabel(ahead)}` : ""}`);
    }
    setEditing(null);
  };

  const removePerson = (p) => {
    setPeople(people.filter((x) => x.id !== p.id));
    log("Crew Rosters", `Removed ${p.name} from the roster`, `${p.dept}`);
    setEditing(null);
  };

  /* An ad hoc move: this person, to the other column, now. On a coming swing
     the move lands on that swing's own board; the live board is untouched. */
  const move = (p, side) => {
    if (looking) {
      putAhead((b) => { b.side[p.id] = side; });
      log("Crew Rosters", `${p.name} moved ${side === "on" ? "onto" : "off"} ${swingLabel(ahead)}`,
        `Crew ${ahead.crew} · ${p.dept}`);
      return;
    }
    setBoard((b) => {
      const next = settledBoard(people, b);
      next.side[p.id] = side;
      return next;
    });
    log("Crew Rosters", `${p.name} moved to the ${side === "on" ? "onboard" : "off"} swing`, p.dept);
  };

  /* Which watch somebody is on while they are here. Pressing the one they are
     already on takes it off again, for a person whose watch isn't settled yet.
     On a coming swing the watch is written on that swing's board. */
  const chooseShift = (p, shift) => {
    const next = shiftOf(p) === shift ? "" : shift;
    if (looking) {
      putAhead((b) => { if (next) b.shift[p.id] = next; else delete b.shift[p.id]; });
      log("Crew Rosters", next ? `${p.name} on the ${next} shift` : `${p.name}'s shift cleared`,
        `${swingLabel(ahead)} · ${p.dept}`);
      return;
    }
    setBoard((b) => {
      const out = settledBoard(people, b);
      if (next) out.shift[p.id] = next; else delete out.shift[p.id];
      return out;
    });
    log("Crew Rosters", next ? `${p.name} on the ${next} shift` : `${p.name}'s shift cleared`, p.dept);
  };

  /* A crew change. Everyone onboard goes ashore and the off swing comes on.
     Only people on a rotation are carried across: a fill-in or somebody
     shore-based belongs to neither swing, so they stay where they were put and
     are moved by hand. */
  const goingAshore = onboard.filter((p) => p.crew);
  const comingOn = off.filter((p) => p.crew);

  const switchSwings = () => {
    setBoard((b) => {
      const next = settledBoard(people, b);
      goingAshore.forEach((p) => { next.side[p.id] = "off"; });
      comingOn.forEach((p) => { next.side[p.id] = "on"; });
      return next;
    });
    log("Crew Rosters", "Switched the swings",
      `${goingAshore.length} ashore · ${comingOn.length} onboard`);
    setConfirmSwitch(false);
    setSub("board");
  };

  /**
   * A swing list, applied.
   *
   * The document is kept whole and shown as it was written — that is the swing.
   * The roster is then brought into line with it so the board, the compliance
   * check and everything else are talking about the same people: anybody the
   * list names is on that swing, anybody new to the roster is added under the
   * rank the document gave them, and anybody who was on the swing and isn't on
   * the new list is left on the roster with no swing against them rather than
   * deleted. They are still crew; they are just not on that rotation.
   */
  const applySwingList = ({ letter, filename, entries }) => {
    const { claimed, newcomers } = matchSwingList(entries, people);
    const stamp = Date.now();

    const kept = people.map((p) => {
      if (claimed.has(p.id)) return p.crew === letter ? p : { ...p, crew: letter };
      if (p.crew === letter) return { ...p, crew: null };
      return p;
    });
    const added = newcomers.map((e, i) => ({
      id: `p-${stamp}-${i}`,
      name: e.name,
      dept: deptForRank(e.rank),
      crew: letter,
      active: true,
    }));

    setPeople([...kept, ...added]);
    setSwingLists({ ...lists, [letter]: { filename, uploaded: new Date().toISOString().slice(0, 10), entries } });
    log("Crew Rosters", `${swingNamed(letter)} set from a list`,
      `${filename} · ${entries.length} crew · ${added.length} new to the roster`);
  };

  const TABS = [
    { id: "board", label: "Onboard and off swing" },
    ...(admin ? [{ id: "switch", label: "Switch swings" }] : []),
  ];

  const shiftButton = (p, id, label) => {
    const on = shiftOf(p) === id;
    const fg = id === "day" ? T.bYellow : T.accent;
    const bg = id === "day" ? T.bYellowBg : T.accentSoft;
    return (
      <button key={id} className="um-btn" disabled={!admin} onClick={() => chooseShift(p, id)}
        title={admin ? `Put ${p.name} on the ${id} shift` : ""}
        style={{ background: on ? bg : "transparent", color: on ? fg : T.muted,
          border: `1px solid ${on ? fg : T.rule}`, borderRadius: 2, padding: "5px 9px",
          fontSize: 10, fontWeight: 700, cursor: admin ? "pointer" : "default" }}>
        {label}
      </button>
    );
  };

  const row = (p, side) => (
    <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      padding: "9px 0", borderBottom: `1px solid ${T.rule}` }}>
      <button className="um-btn" onClick={() => admin && setEditing(p)} disabled={!admin}
        style={{ background: "transparent", color: T.text, padding: 0, letterSpacing: 0,
          textTransform: "none", textAlign: "left", flex: "1 1 130px", minWidth: 0,
          cursor: admin ? "pointer" : "default" }}>
        <span style={{ fontFamily: T.body, fontSize: 15, fontWeight: 600 }}>{fullName(p)}</span>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginLeft: 8 }}>
          {p.crew ? p.crew : "—"}
        </span>
        {isDup(p) && (
          <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, background: T.bOrangeBg,
            color: T.bOrange, padding: "2px 6px", borderRadius: 2, marginLeft: 8, whiteSpace: "nowrap" }}
            title="Another roster entry answers to this same name — press the name to edit or remove one of them">
            DUPLICATE
          </span>
        )}
      </button>

      {side === "on" && (
        <div style={{ display: "flex", gap: 5 }}>
          {SHIFTS.map((s) => shiftButton(p, s.id, s.label))}
        </div>
      )}

      {admin && (
        <button className="um-btn" onClick={() => move(p, side === "on" ? "off" : "on")}
          title={side === "on" ? `Send ${p.name} to the off swing` : `Bring ${p.name} onboard`}
          style={{ background: "transparent", color: T.muted, border: `1px solid ${T.rule}`,
            borderRadius: 2, padding: "5px 9px", fontSize: 10, fontWeight: 700 }}>
          {side === "on" ? "Send ashore" : "Bring onboard"}
        </button>
      )}
    </div>
  );

  const column = (title, list, side, colour, blurb) => (
    <div style={{ flex: "1 1 330px", minWidth: 0, background: T.panel, border: `1px solid ${T.rule}`,
      borderTop: `4px solid ${colour}`, borderRadius: 2, padding: "14px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <Eyebrow color={colour}>{title}</Eyebrow>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}>{list.length}</span>
      </div>
      <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, lineHeight: 1.6, marginTop: 7 }}>
        {blurb}
      </div>

      {list.length === 0 ? (
        <Empty>Nobody.</Empty>
      ) : (
        depts.map((d) => {
          const group = list.filter((p) => groupOf(p) === d);
          if (!group.length) return null;
          return (
            <div key={d} style={{ marginTop: 16 }}>
              <Eyebrow>{d}</Eyebrow>
              {group.map((p) => row(p, side))}
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <div>
      <SectionHead title="Swing Roster"
        meta={looking
          ? `${swingLabel(ahead)} · Crew ${ahead.crew} · ${shownOn.length} on the swing · ${shownOff.length} off`
          : `${shownOn.length} onboard · ${shownOff.length} off swing`} />

      {/* The swing lists are what the crew came here to read, so the tabs are
          shown to everybody. Only an admin gets the crew change on the end of
          them, and only an admin gets the upload buttons on the lists page. */}
      <div className="um-scroll" style={{ display: "flex", gap: 6, margin: "16px 0 22px", paddingBottom: 2 }}>
        {TABS.map((x) => {
          const on = sub === x.id;
          return (
            <button key={x.id} className="um-btn um-tab" onClick={() => { setSub(x.id); setConfirmSwitch(false); }}
              style={{ background: on ? T.accent : T.panel, color: on ? "#FFF" : T.muted,
                border: `1px solid ${on ? T.accent : T.rule}`, fontSize: 11, fontWeight: 700,
                padding: "9px 14px", borderRadius: 2 }}>
              {x.label}
            </button>
          );
        })}
      </div>

      {sub === "board" && (
        <>
          {/* The look ahead is said out loud rather than worn quietly — a board
              that has silently stopped being today's is how somebody gets sent
              ashore on the wrong swing. */}
          {looking && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
              gap: 12, flexWrap: "wrap", background: T.panel, border: `1px solid ${T.rule}`,
              borderLeft: `4px solid ${T.accent}`, borderRadius: 2, padding: "12px 15px",
              marginBottom: 16 }}>
              <span style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.6,
                flex: "1 1 260px" }}>
                Working on <strong style={{ fontWeight: 700 }}>Crew {ahead.crew} ·{" "}
                {swingLabel(ahead)}</strong> — picked on the cards above. Watches set here, crew
                moved on or off, and anyone added belong to this swing only; the live board — who
                is on the vessel today — is untouched. Anyone not moved by hand follows the
                rotation.
              </span>
              <Button variant="quiet" onClick={onShowNow}>Back to the swing that is on</Button>
            </div>
          )}

          {admin && (
            <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
              <Button writes onClick={() => setEditing({})}>Add crew member</Button>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.muted }}>
                {onDay} on days · {onNight} on nights
                {noWatch ? ` · ${noWatch} without a watch` : ""}
              </span>
            </div>
          )}

          {editing && admin && (
            <PersonEditor person={editing} onSave={savePerson} onRemove={removePerson}
              onCancel={() => setEditing(null)}
              matrix={(() => {
                const names = MATRIX.rows.map((r) => r[0]);
                const name = editing.name ? matchRoster(editing.name, names) : null;
                const row = name ? MATRIX.rows.find((r) => r[0] === name) : null;
                return {
                  name,
                  rank: row ? String(row[1] || "") : "",
                  options: Array.from(new Set(MATRIX.rows.map((r) => String(r[1] || "").trim()).filter(Boolean))),
                };
              })()}
              onRank={(matrixName, value, personName) => {
                const rows = MATRIX.rows.map((row) => [row[0], row[1], row[2], (row[3] || []).slice()]);
                if (matrixName) {
                  const i = rows.findIndex((r) => r[0] === matrixName);
                  if (i < 0) return;
                  const before = rows[i][1] || "—";
                  if (before === value) return;
                  rows[i][1] = value;
                  setQuals({ cols: MATRIX.cols, rows });
                  log("Crew Matrix", `${matrixName}'s rank changed`, `${before} → ${value}`);
                } else {
                  // Not on the matrix yet: the rank puts them there — one
                  // empty row, which the readings and spreadsheets fill in
                  // from here on. From that moment the checker, the swing
                  // pages and the shift checks all know them.
                  rows.push([personName, value, "", MATRIX.cols.map(() => "")]);
                  setQuals({ cols: MATRIX.cols, rows });
                  log("Crew Matrix", `${personName} added to the crew matrix`, `Rank ${value}`);
                }
              }} />
          )}

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
            {column("Onboard swing", shownOn, "on", T.green,
              looking
                ? "Rostered onto this swing. Set each one to days or nights, or send them off it — this swing only, the live board keeps reading today."
                : admin
                  ? "On the vessel now. Set each one to days or nights, or send them to the off swing."
                  : "On the vessel now.")}
            {column("Off swing", shownOff, "off", T.muted,
              looking
                ? "Not rostered onto this swing. Bring anyone onto it who is filling in or swapping on."
                : admin
                  ? "Ashore. Bring anyone onboard who has come out early or is filling in."
                  : "Ashore.")}
          </div>

          {gone.length > 0 && !looking && (
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, lineHeight: 1.7, marginTop: 18 }}>
              Not on the roster at the moment: {gone.map((p) => fullName(p)).join(", ")}.
              {admin ? " Add them back from Add crew member." : ""}
            </div>
          )}
        </>
      )}

      {sub === "switch" && admin && (
        <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.accent}`,
          borderRadius: 2, padding: "15px 17px" }}>
          <Eyebrow color={T.accent}>Switch swings</Eyebrow>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.7, marginTop: 10 }}>
            Crew change. Everyone on the onboard swing goes to the off swing, and the off swing comes
            onboard. Only people on a rotation are carried across — a fill-in or anybody without a crew
            letter stays where they are and is moved by hand.
          </div>

          <div style={{ background: T.raised, borderRadius: 2, padding: "11px 13px", margin: "14px 0",
            fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.7 }}>
            <div><strong style={{ fontWeight: 600 }}>Going ashore ({goingAshore.length}):</strong>{" "}
              {goingAshore.length ? goingAshore.map((p) => fullName(p)).join(", ") : "nobody"}</div>
            <div style={{ marginTop: 6 }}><strong style={{ fontWeight: 600 }}>Coming onboard ({comingOn.length}):</strong>{" "}
              {comingOn.length ? comingOn.map((p) => fullName(p)).join(", ") : "nobody"}</div>
          </div>

          {confirmSwitch ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontFamily: T.body, fontSize: 13.5, color: T.text }}>
                Switch them now?
              </span>
              <Button writes onClick={switchSwings}>Yes — switch the swings</Button>
              <Button variant="quiet" onClick={() => setConfirmSwitch(false)}>Cancel</Button>
            </div>
          ) : (
            <Button writes onClick={() => setConfirmSwitch(true)}
              disabled={!goingAshore.length && !comingOn.length}>
              Switch the swings
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/* ==================================================================== */
/*  Swing compliance                                                     */
/* ==================================================================== */

/* The roster and the matrix are each fine on their own and the question nobody
   could answer was the one across both of them: of the people rostered onto the
   next swing, who turns up with something expired, missing, or running out while
   they are onboard. The roster carries the name the crew use ("Alan") and the
   matrix carries the name on the certificate ("SMITH, Alan"), so the two are
   matched the same way a dropped certificate folder is - and anyone the match
   isn't sure about is reported as unchecked rather than guessed at and passed. */
/* A section of the swing page, always open: the title, the verdict beside it,
   and the content underneath. The header still carries the numbers so the page
   reads top to bottom without a click. */
function FoldSection({ title, meta, tone = T.accent, children, boxRef, right }) {
  return (
    <div ref={boxRef} style={{ background: T.panel, border: `1px solid ${T.rule}`,
      borderLeft: `4px solid ${tone}`, borderRadius: 2, marginBottom: 10, scrollMarginTop: 12 }}>
      <div style={{ padding: "13px 15px", display: "flex", gap: 10, alignItems: "baseline",
        flexWrap: "wrap" }}>
        <span style={{ fontFamily: T.display, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em",
          textTransform: "uppercase", color: tone }}>{title}</span>
        <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, flex: 1, minWidth: 160 }}>{meta}</span>
        {right}
      </div>
      {children != null && <div style={{ padding: "0 15px 15px" }}>{children}</div>}
    </div>
  );
}

function SwingCompliance({ people, overrides, at, setAt, roster, onOpenSwing, cardsOnly, compact, rosterOpen }) {
  const [rosterShown, setRosterShown] = useState(!!rosterOpen);
  const { shiftAnalysis: heldShift } = usePortal();
  const { quals: QUALS, swingDates, setSwingDates, log, certDates, swingBoard, swingBoards } = usePortal();
  const validityFor = useValidityLookup();
  const k0 = currentSwingIndex();
  // The swing onboard now and the five coming, each carrying the office's dates
  // where somebody has given them and the four-week pattern's where nobody has.
  const swings = useMemo(
    () => Array.from({ length: SWING_LOOKAHEAD + 1 }, (_, i) => swingWithDates(k0 + i, swingDates)),
    [k0, swingDates],
  );

  const today = todayISO();
  const names = useMemo(() => QUALS.rows.map((r) => r[0]), [QUALS]);
  const rowByName = useMemo(() => Object.fromEntries(QUALS.rows.map((r) => [r[0], r])), [QUALS]);

  // Who on the roster is who on the matrix. Worked out once for the roster
  // rather than once per swing, because it is the same answer every time.
  const matched = useMemo(
    () => Object.fromEntries(people.map((p) => [p.id, matchRoster(p.name, names)])),
    [people, names],
  );

  const checkSwing = (s) => {
    /* The swing that is on is read off the live board — the same answer the
       roster below gives — so a crew change made with Switch swings, or anyone
       moved on or off by hand, is what this page checks the moment it happens.
       A coming swing is read off its own allocation and nothing else: one
       that has not been generated has nobody on it, which is what the page
       then says, rather than filling it in from the rotation. */
    const live = s.k <= k0;
    const held = live ? null : (swingBoards || {})[s.k];
    const sideFor = (p) => {
      if (live) return boardSide(p, swingBoard);
      const h = held && held.side ? held.side[p.id] : null;
      return h === "on" || h === "off" ? h : "off";
    };
    /* Somebody put on for part of the swing only - joining late, gone home
       early, filling in for a fortnight - is onboard for their own days and
       nobody else's. This page says who is actually onboard, so the swing that
       is on is read against today and a coming one against its own dates. */
    const windows = (live ? (swingBoard || {}).window : (held || {}).window) || {};
    const aboard = (p) => {
      const w = windows[p.id];
      if (!w || !w.from || !w.to) return true;
      return live ? today >= w.from && today < w.to : w.from < s.flyHome && w.to > s.flyOut;
    };
    const onboard = people.filter((p) => p.active && sideFor(p) === "on" && aboard(p));
    /* A Switch swings pressed before the pattern's changeover puts the other
       crew onboard while the pattern still says this swing is the old letter.
       The card wears the letter of the crew actually on, so the label and the
       names under it can't disagree. */
    let swing = s;
    if (live) {
      const tally = {};
      onboard.forEach((p) => { if (p.crew) tally[p.crew] = (tally[p.crew] || 0) + 1; });
      const worn = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      if (worn && worn !== s.crew) swing = { ...s, crew: worn };
    }
    const unchecked = [];
    const checked = onboard.map((p) => {
      const row = rowByName[matched[p.id]];
      if (!row) { unchecked.push(p); return null; }
      const items = itemsFor(row, QUALS);
      // Read against the swing rather than against today: a ticket that runs out
      // three days before they fly out is a problem for that swing even though it
      // is valid now, and one that runs out while they are onboard is worse.
      const before = items.filter((x) => x.band.date && x.band.date < s.start);
      const during = items.filter((x) => x.band.date && x.band.date >= s.start && x.band.date <= s.end);
      const notHeld = items.filter((x) => x.band.key === "not");
      const unknown = items.filter((x) => x.band.key === "unknown");
      return {
        person: p, name: row[0], position: row[1],
        blockers: [...before, ...notHeld], during, unknown,
      };
    }).filter(Boolean);

    return {
      swing, unchecked, checked,
      blocked: checked.filter((c) => c.blockers.length),
      watch: checked.filter((c) => !c.blockers.length && c.during.length),
      clear: checked.filter((c) => !c.blockers.length && !c.during.length),
    };
  };

  const results = useMemo(() => swings.map(checkSwing), [swings, people, overrides, QUALS, matched, swingBoard, swingBoards]);
  const here = results.find((r) => r.swing.k === at) || results[0];

  /* ---- The dates the swings are read against -------------------------- */

  // What is in the boxes, which is what was typed rather than what the check
  // ended up using: a date being typed passes through half-written values, and a
  // box that snapped back to the pattern's date on the way through would be
  // impossible to type into.
  const typed = (k, which) => ((swingDates || {})[k] || {})[which] || swingAt(k)[which];
  const wasGiven = (k) => {
    const d = (swingDates || {})[k];
    return !!(d && d.flyOut && d.flyHome);
  };
  // A pair that reads backwards is left out of the check rather than used, and
  // is said on screen — the alternative is a swing quietly checked against dates
  // that make no sense.
  const backwards = (k) => {
    const d = (swingDates || {})[k] || {};
    return !!(d.flyOut && d.flyHome && d.flyHome <= d.flyOut);
  };
  // One date on its own says nothing about where the swing ends, so it is not
  // used either — and a box left blank is worth a sentence rather than silence.
  const partial = (k) => {
    const d = (swingDates || {})[k];
    return !!d && (!d.flyOut || !d.flyHome);
  };

  const setDate = (k, which, value) => {
    setSwingDates((d) => {
      const now = { ...(d || {}) };
      const base = swingAt(k);
      // Both dates are seeded from the pattern the first time one is touched, so
      // giving only the day out doesn't leave the other end of the swing blank.
      now[k] = { flyOut: base.flyOut, flyHome: base.flyHome, ...(now[k] || {}), [which]: value };
      return now;
    });
    setAt(k);
  };

  const usePattern = (k) => {
    setSwingDates((d) => { const now = { ...(d || {}) }; delete now[k]; return now; });
    log("Swings", "Swing dates cleared",
      `${swingLabel(swingAt(k))} follows the four-week pattern again`);
  };

  // Dates are typed a keystroke at a time, so the history is written when the
  // box is left and only if what is in it actually moved.
  const beforeEdit = useRef(null);
  const startEdit = (k) => { beforeEdit.current = JSON.stringify((swingDates || {})[k] || null); };
  const endEdit = (k) => {
    const after = JSON.stringify((swingDates || {})[k] || null);
    if (after === beforeEdit.current) return;
    beforeEdit.current = after;
    if (!wasGiven(k) || backwards(k)) return;
    const s = swingWithDates(k, swingDates);
    log("Swings", "Swing dates set",
      `Crew ${s.crew} · out ${fmtDate(s.flyOut)}, home ${fmtDate(s.flyHome)}`);
  };

  // Where the picked swing starts being read: the roster when this page carries
  // one, the detail tiles otherwise — so picking a card can bring it into view.
  const rosterRef = useRef(null);
  const detailRef = useRef(null);

  // Clicking anywhere on a card shows that swing below — the roster switches to
  // that swing's crew and the compliance details follow. The whole card is the
  // target, not just the button. The boxes and buttons on the card are left to
  // do their own jobs: focusing a date box to type into it shouldn't drag the
  // page down.
  const pick = (k, e) => {
    if (e.target.closest("input, button, select, textarea, label")) return;
    setAt(k);
    if (onOpenSwing) onOpenSwing(k);
  };

  /* One swing as a card: the dates it is read against, in boxes that can be
     typed into, and what the check made of it. The same card does both columns —
     the only thing that separates the swing that is on from the ones coming is
     which column it is in. */
  const card = (r) => {
    const k = r.swing.k;
    const on = k === at;
    const bad = r.blocked.length;
    const given = wasGiven(k);
    const bust = backwards(k);
    const half = partial(k);
    if (compact) {
      return (
        <div key={k} className="um-swingcard" onClick={() => setAt(k)}
          style={{ background: on ? T.accentSoft : T.panel, border: `1px solid ${on ? T.accent : T.rule}`,
          borderLeft: `4px solid ${bad ? T.bRed : T.teal}`, borderRadius: 2, padding: "10px 12px",
          cursor: "pointer", minWidth: 0 }}>
          <div style={{ fontFamily: T.display, fontSize: 14, fontWeight: 700, color: T.text, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis" }}>
            {swingLabel(r.swing)}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 3 }}>
            Crew {r.swing.crew} · {r.checked.length + r.unchecked.length} rostered
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
            {k === k0 && <Chip fg={T.accent} bg={T.accentSoft}>On now</Chip>}
            <Chip fg={bad ? T.bRed : T.teal} bg={bad ? T.bRedBg : T.raised}>
              {bad ? `${bad} not clear` : "All clear"}
            </Chip>
          </div>
        </div>
      );
    }
    return (
      <div key={k} className="um-swingcard" onClick={(e) => pick(k, e)}
        style={{ background: T.panel, border: `1px solid ${on ? T.accent : T.rule}`,
        borderLeft: `4px solid ${bad ? T.bRed : T.teal}`, borderRadius: 2, padding: "13px 15px",
        marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
          gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontFamily: T.display, fontSize: 15, fontWeight: 700, color: T.text }}>
            {swingLabel(r.swing)}
          </span>
          <span style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            {k === k0 && <Chip fg={T.accent} bg={T.accentSoft}>On now</Chip>}
            <Chip fg={bad ? T.bRed : T.teal} bg={bad ? T.bRedBg : T.raised}>
              {bad ? `${bad} not clear` : "All clear"}
            </Chip>
          </span>
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.muted, marginTop: 4 }}>
          Crew {r.swing.crew} · {r.checked.length + r.unchecked.length} rostered
          {r.watch.length > 0 && ` · ${r.watch.length} expiring onboard`}
          {r.unchecked.length > 0 && ` · ${r.unchecked.length} unchecked`}
        </div>

        <div className="um-g2" style={{ gap: 8, marginTop: 10 }}>
          <Field label="Flies out">
            <input className="um-in" type="date" value={typed(k, "flyOut")}
              onFocus={() => startEdit(k)} onBlur={() => endEdit(k)}
              onChange={(e) => setDate(k, "flyOut", e.target.value)} />
          </Field>
          <Field label="Flies home">
            <input className="um-in" type="date" value={typed(k, "flyHome")}
              onFocus={() => startEdit(k)} onBlur={() => endEdit(k)}
              onChange={(e) => setDate(k, "flyHome", e.target.value)} />
          </Field>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
          gap: 10, flexWrap: "wrap", marginTop: 9 }}>
          <span style={{ fontFamily: T.body, fontSize: 12, lineHeight: 1.5, flex: "1 1 190px",
            color: bust || half ? T.bRed : T.muted }}>
            {bust
              ? "The day home is on or before the day out, so this swing is still being read against the pattern."
              : half
                ? "Both dates are needed. Until then this swing is read against the pattern."
                : given
                  ? `Onboard ${fmtDate(r.swing.start)} to ${fmtDate(r.swing.end)}.`
                  : "From the four-week pattern. Type the office's dates over it."}
          </span>
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(given || half || bust) && <Button writes variant="quiet" onClick={() => usePattern(k)}>Use the pattern</Button>}
            <Button variant={on ? "ghost" : "quiet"} onClick={() => setAt(k)}>
              {on ? "Shown below" : "Show below"}
            </Button>
          </span>
        </div>
      </div>
    );
  };

  const tile = (label, value, colour) => (
    <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `3px solid ${colour}`,
      borderRadius: 2, padding: "10px 13px", flex: "1 1 130px" }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ fontFamily: T.display, fontSize: 25, fontWeight: 700, color: colour, marginTop: 5, lineHeight: 1 }}>{value}</div>
    </div>
  );

  const asPDF = () => ({
    title: `Swing compliance · ${swingLabel(here.swing)}`,
    subtitle: `${VESSEL.name} ${VESSEL.nameAccent} · Crew ${here.swing.crew} · `
      + `fly out ${fmtDate(here.swing.flyOut)}, home ${fmtDate(here.swing.flyHome)} · `
      + `${here.checked.length + here.unchecked.length} rostered · ${here.blocked.length} not clear · `
      + `${here.watch.length} expiring onboard · ${here.unchecked.length} unchecked`,
    filename: `swing-compliance-${here.swing.start}.pdf`,
    empty: "Everyone rostered onto this swing is clear.",
    groups: [...here.blocked, ...here.watch].map((c) => ({
      heading: c.name,
      meta: `${c.position} · ${c.blockers.length} to fix before the swing · ${c.during.length} expiring onboard`,
      items: [...c.blockers, ...c.during].map(pdfLineIn({ person: c.name, dates: certDates, validityFor })),
    })),
  });

  const cards = (
    <div style={{ marginBottom: 18 }}>
      <div style={{ marginBottom: 8 }}>
        <Eyebrow color={T.accent}>Swings · on now and the next {SWING_LOOKAHEAD}</Eyebrow>
      </div>
      <div className={compact ? "um-swing6" : "um-swing3"}>
        {results.map(card)}
      </div>
    </div>
  );
  if (cardsOnly) return cards;

  return (
    <div>
      {cards}

      {/* The roster, showing the picked swing's crew — the board as it stands
          when the swing that is on is picked, a look ahead when a coming one
          is. It sits right under the cards because it is what a click on them
          changes first; the compliance details read against it follow. */}
      {roster && (
        <FoldSection boxRef={rosterRef} title="Roster"
          meta={`${here.checked.length + here.unchecked.length} onboard ${swingLabel(here.swing)}`}
          right={<Button variant={rosterShown ? "ghost" : "quiet"} onClick={() => setRosterShown(!rosterShown)}>
            {rosterShown ? "Hide roster" : "Show roster"}
          </Button>}>
          {rosterShown ? roster : null}
        </FoldSection>
      )}

      <FoldSection boxRef={detailRef} title="Who's clear, who isn't"
        tone={here.blocked.length ? T.bRed : T.teal}
        meta={`${here.blocked.length} not clear · ${here.watch.length} expiring onboard · ${here.clear.length} clear` +
          (here.unchecked.length ? ` · ${here.unchecked.length} not on the matrix` : "")}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, marginTop: 4 }}>
          {tile("Rostered onboard", here.checked.length + here.unchecked.length, T.accent)}
          {tile("Clear to sail", here.clear.length, T.teal)}
          {tile("Not clear", here.blocked.length, T.bRed)}
          {tile("Expiring onboard", here.watch.length, T.bOrange)}
          {tile("Not on the matrix", here.unchecked.length, T.muted)}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "flex-start",
          gap: 12, flexWrap: "wrap" }}>
          <DownloadPDF build={asPDF} variant="quiet" />
        </div>
      </FoldSection>

      {/* The bottom of the page is the second question the swing is checked
          against — whether the swing carries the certificates the office's
          shift allocation guideline requires of each shift. What each person
          is carrying is in the counts above and in the PDF. */}
      {(() => {
        const c = heldShift && heldShift.check && heldShift.check.counts;
        const shortN = c ? Number(c.short) || 0 : 0;
        const meta = c
          ? `${Number(c.met) || 0} requirements met · ${shortN} short · ${Number(c.unclear) || 0} unclear` +
            (heldShift.swing ? ` · read for ${heldShift.swing}` : "")
          : "the office's guideline hasn't been compared against this crew yet — run it below";
        return (
          <FoldSection title="Certificates required by shift"
            tone={c ? (shortN ? T.bRed : T.teal) : T.accent} meta={meta}>
            <SwingShiftAllocation here={here} />
          </FoldSection>
        );
      })()}

      {/* The last word on the page: one button that checks the picked swing
          whole — roster against spreadsheets and certificates — and writes the
          answer down for everyone. */}
      <FoldSection title="Swing report">
        <GenerateSwingCompliance results={results} here={here} setAt={setAt} />
      </FoldSection>
    </div>
  );
}

/* The swing page in the order it is read: the compliance cards first, the
   roster under them showing whichever swing is picked, the details after. The
   picked swing lives here rather than in either component, because a click on
   a card has to move both — the compliance reading and the crew shown under
   it. The cards fall back to the swing that is on when the pick goes stale
   (a changeover passing while the page is open), and the roster reads any
   pick that isn't ahead of today as the live board, so the two can't drift. */
/* One swing, day by day — the window that opens from a swing card's Adhoc
   changes button on the Roster page. Every crew member on the swing is a row,
   every day of the swing a column; a filled cell is a day they are onboard,
   coloured by the watch they keep. A person's own joining and fly-home days
   are typed against their row; somebody can be brought on for part of the
   swing underneath. An archived swing opens the same way, read-only. */
const GRID_DAY = "#F2C14E", GRID_NIGHT = "#3F7FD1", GRID_NONE = "#9AA5B1";
const isoShift = (iso, n) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
const WEEKDAY_LETTER = ["S", "M", "T", "W", "T", "F", "S"];
const ARCHIVE_YEARS = 5;

/* The swing that is on, as it stands right now: who is onboard, on which
   watch, from which day to which. Written under its swing number whenever it
   changes, so that when the swing ends this is the record kept of it. */
function swingSnapshot(k, people, board, swingDates, quals) {
  const s = swingWithDates(k, swingDates);
  const names = quals.rows.map((r) => r[0]);
  const pos = Object.fromEntries(quals.rows.map((r) => [r[0], r[1] || ""]));
  const rows = (people || []).filter((p) => p.active && boardSide(p, board) === "on").map((p) => {
    const name = p.name.includes(",") ? p.name : (matchRoster(p.name, names) || p.name);
    const w = ((board && board.window) || {})[p.id] || {};
    return { id: p.id, name, position: pos[name] || p.dept || "", crew: p.crew || "",
      shift: ((board && board.shift) || {})[p.id] || "", from: w.from || s.flyOut, to: w.to || s.flyHome };
  });
  return { k, crew: s.crew, flyOut: s.flyOut, flyHome: s.flyHome, rows };
}

function SwingDayGrid({ k, people, board, setBoard, overrides, log, onClose, snapshot }) {
  const { swingDates, swingBoards, setSwingBoards, quals: MATRIX } = usePortal();
  const readOnly = !!snapshot;
  const swing = snapshot ? { ...swingAt(snapshot.k), crew: snapshot.crew, flyOut: snapshot.flyOut, flyHome: snapshot.flyHome } : swingWithDates(k, swingDates);
  const looking = !readOnly && k > currentSwingIndex();
  const held = readOnly ? {} : looking ? (swingBoards || {})[k] || { side: {}, shift: {}, window: {} } : (board || {});
  const today = todayISO();
  const days = [];
  for (let d = swing.flyOut; d < swing.flyHome; d = isoShift(d, 1)) days.push(d);
  const lastDay = days[days.length - 1];

  const names = useMemo(() => MATRIX.rows.map((r) => r[0]), [MATRIX]);
  const posByName = useMemo(() => Object.fromEntries(MATRIX.rows.map((r) => [r[0], r[1] || ""])), [MATRIX]);
  const fullName = (p) => (p.name.includes(",") ? p.name : (matchRoster(p.name, names) || p.name));
  const positionOf = (p) => posByName[fullName(p)] || p.dept || "";
  const groupIndexOf = (position) => {
    const i = RANK_GROUPS.findIndex(([, re]) => re.test(position));
    return i < 0 ? RANK_GROUPS.length : i;
  };

  /* Read off the allocation and nowhere else. A swing nobody has generated
     shows nobody, and says so, rather than showing whoever the calendar's
     rotation would have had aboard. */
  const sideOf = (p) => {
    if (!p.active) return "off";
    const h = (held.side || {})[p.id];
    return h === "on" || h === "off" ? h : "off";
  };
  const generated = boardGenerated(looking ? held : board);
  const shiftOf = (p) => (held.shift || {})[p.id] || "";
  const windowOf = (p) => (held.window || {})[p.id] || null;
  const outOf = (p) => (windowOf(p) || {}).from || swing.flyOut;
  const homeOf = (p) => (windowOf(p) || {}).to || swing.flyHome;

  const crew = readOnly || !generated ? [] : people.filter((p) => p.active);
  const byRank = (a, b) => groupIndexOf(a.position) - groupIndexOf(b.position) || a.name.localeCompare(b.name);
  const rows = readOnly
    ? [...snapshot.rows].map((r) => ({ ...r, key: r.id })).sort(byRank)
    : crew.filter((p) => sideOf(p) === "on")
        .map((p) => ({ key: p.id, p, name: fullName(p), position: positionOf(p), crew: p.crew || "",
          shift: shiftOf(p), from: outOf(p), to: homeOf(p) }))
        .sort(byRank);
  const offSwing = crew.filter((p) => sideOf(p) !== "on")
    .sort((a, b) => groupIndexOf(positionOf(a)) - groupIndexOf(positionOf(b)) || fullName(a).localeCompare(fullName(b)));
  const partial = rows.filter((r) => r.from !== swing.flyOut || r.to !== swing.flyHome).length;

  /* Every change writes the board out in full first, so moving one person
     can't leave everybody else drifting with the rotation. */
  const write = (change) => {
    if (looking) {
      setSwingBoards((all) => {
        const was = (all || {})[k] || { side: {}, shift: {}, window: {} };
        const out = { side: {}, shift: { ...(was.shift || {}) }, window: { ...(was.window || {}) } };
        people.forEach((p) => {
          if (!p.active) return;
          const h = (was.side || {})[p.id];
          out.side[p.id] = h === "on" || h === "off" ? h : "off";
        });
        change(out);
        const next = {};
        Object.keys(all || {}).forEach((key) => { if (Number(key) > currentSwingIndex()) next[key] = all[key]; });
        next[k] = out;
        return next;
      });
    } else {
      setBoard((b) => {
        const out = { ...settledBoard(people, b), window: { ...((b && b.window) || {}) } };
        change(out);
        return out;
      });
    }
  };

  const setWindow = (p, from, to) => {
    if (!from || !to || to <= from) return;
    write((b) => {
      if (from === swing.flyOut && to === swing.flyHome) delete b.window[p.id];
      else b.window[p.id] = { from, to };
    });
    log("Roster", `${fullName(p)} on ${swingLabel(swing)}`, `joins ${fmtDate(from)}, home ${fmtDate(to)}`);
  };
  const offSwingNow = (p) => {
    write((b) => { b.side[p.id] = "off"; delete b.window[p.id]; });
    log("Roster", `${fullName(p)} off ${swingLabel(swing)}`, "");
  };
  const bringOn = (p, from, to) => {
    write((b) => {
      b.side[p.id] = "on";
      if (from === swing.flyOut && to === swing.flyHome) delete b.window[p.id];
      else b.window[p.id] = { from, to };
    });
    log("Roster", `${fullName(p)} onto ${swingLabel(swing)}`, `joins ${fmtDate(from)}, home ${fmtDate(to)}`);
  };

  const colourOf = (shift) => (shift === "day" ? GRID_DAY : shift === "night" ? GRID_NIGHT : GRID_NONE);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(22,50,74,0.55)", overflowY: "auto", padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderTop: `6px solid ${readOnly ? T.muted : looking ? T.accent : T.teal}`,
        borderRadius: 4, margin: "0 auto", maxWidth: 1800, padding: "18px 22px 24px" }} className="um-modal">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.display, fontSize: 24, fontWeight: 700, color: T.text }}>
                {swingLabel(swing)} · crew {swing.crew}
              </span>
              {readOnly && <Chip fg={T.muted} bg={T.raised}>Archived</Chip>}
            </div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted, marginTop: 4 }}>
              {rows.length} onboard · {partial === 0 ? "everyone the whole swing" : `${partial} for part of it`}
              {readOnly ? " · as it stood when the swing ended" : " · type a person's own joining and fly-home days to change them"}
            </div>
          </div>
          <a onClick={onClose} style={{ cursor: "pointer", fontFamily: T.display, fontSize: 22, color: T.muted, lineHeight: 1, padding: "2px 6px" }}>×</a>
        </div>

        <div className="um-scroll">
          <table className="um-daygrid">
            <thead>
              <tr>
                <th className="um-daygrid-name">Crew</th>
                {days.map((d) => (
                  <th key={d} className={d === today ? "um-daygrid-today" : ""} title={fmtDate(d)}>
                    <span style={{ display: "block" }}>{WEEKDAY_LETTER[new Date(d + "T00:00:00Z").getUTCDay()]}</span>
                    <span style={{ display: "block" }}>{d.slice(8)}</span>
                  </th>
                ))}
                <th className="um-daygrid-dates">Joins</th>
                <th className="um-daygrid-dates">Flies home</th>
                {!readOnly && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <GridRow key={r.key} row={r} days={days} today={today} swing={swing} lastDay={lastDay}
                  colour={colourOf(r.shift)} readOnly={readOnly}
                  offSwing={offSwing} fullName={fullName} positionOf={positionOf}
                  others={rows.filter((x) => x.key !== r.key && (x.from !== swing.flyOut || x.to !== swing.flyHome))}
                  onCover={bringOn}
                  onWindow={(from, to) => setWindow(r.p, from, to)}
                  onWhole={() => setWindow(r.p, swing.flyOut, swing.flyHome)}
                  onOff={() => offSwingNow(r.p)} />
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={days.length + 4} style={{ fontFamily: T.body, fontSize: 13, color: T.muted, padding: 14 }}>
                  {readOnly ? "Nobody was recorded on this swing." : "Nobody is on this swing yet."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, marginTop: 10, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ width: 14, height: 11, background: GRID_DAY, display: "inline-block", borderRadius: 2 }} /> days ·
          <span style={{ width: 14, height: 11, background: GRID_NIGHT, display: "inline-block", borderRadius: 2 }} /> nights ·
          <span style={{ width: 14, height: 11, background: GRID_NONE, display: "inline-block", borderRadius: 2 }} /> onboard, no watch set · blank is ashore
        </div>

        {!readOnly && (
          <PartSwing swing={swing} lastDay={lastDay} offSwing={offSwing} fullName={fullName} positionOf={positionOf} onBring={bringOn} />
        )}
      </div>
    </div>
  );
}

function GridRow({ row, days, today, swing, lastDay, colour, readOnly, offSwing, fullName, positionOf, others, onCover, onWindow, onWhole, onOff }) {
  const { name, position, crew, from: out, to: home } = row;
  const [o, setO] = useState(out);
  const [h, setH] = useState(home);
  // The days this person isn't onboard, at either end of the swing — the
  // gaps somebody else covers. A gap that somebody's own part-swing stay
  // already fills isn't asked about again: the pair is complete.
  const gaps = [
    ...(out > swing.flyOut ? [{ id: "before", from: swing.flyOut, to: out }] : []),
    ...(home < swing.flyHome ? [{ id: "after", from: home, to: swing.flyHome }] : []),
  ].filter((g) => !(others || []).some((w) => w.from <= g.from && w.to >= g.to));
  const [cover, setCover] = useState({});
  React.useEffect(() => { setO(out); setH(home); }, [out, home]);
  const backwards = !!o && !!h && h <= o;
  const whole = out === swing.flyOut && home === swing.flyHome;
  // A date picked from the calendar is applied the moment it is complete,
  // not only when the box is left.
  const commit = (nextO, nextH) => {
    if (!nextO || !nextH || nextH <= nextO) return;
    if (nextO === out && nextH === home) return;
    onWindow(nextO, nextH);
  };
  const covered = (d) => d >= out && d < home;
  const cells = days.map((d) => {
    const on = covered(d);
    return <td key={d} className={`um-daygrid-cell${d === today ? " um-daygrid-today" : ""}`}
      style={{ background: on ? colour : "transparent" }} title={`${name} · ${fmtDate(d)} · ${on ? "onboard" : "ashore"}`} />;
  });
  const who = (
    <th className="um-daygrid-name">
      <div style={{ fontFamily: T.body, fontSize: 13.5, fontWeight: 600, color: T.accent }}>{name}</div>
      <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{position}{crew ? ` · ${crew}` : ""}</div>
    </th>
  );
  if (readOnly) {
    return (
      <tr>
        {who}
        {cells}
        <td style={{ fontFamily: T.mono, fontSize: 11.5, color: T.text }}>{fmtDate(out)}</td>
        <td style={{ fontFamily: T.mono, fontSize: 11.5, color: T.text }}>{fmtDate(home)}</td>
      </tr>
    );
  }
  return (
    <>
      <tr>
        {who}
        {cells}
        <td><input className="um-in" type="date" value={o} min={swing.flyOut} max={lastDay}
          onChange={(e) => { setO(e.target.value); commit(e.target.value, h); }} onBlur={() => commit(o, h)} /></td>
        <td><input className="um-in" type="date" value={h} min={isoShift(swing.flyOut, 1)} max={swing.flyHome}
          onChange={(e) => { setH(e.target.value); commit(o, e.target.value); }} onBlur={() => commit(o, h)} /></td>
        <td style={{ whiteSpace: "nowrap" }}>
          {!whole && <Button writes variant="quiet" onClick={onWhole}>Whole swing</Button>}{" "}
          <Button writes variant="quiet" onClick={onOff}>Off swing</Button>
        </td>
      </tr>
      {backwards && (
        <tr><td colSpan={days.length + 4} style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, padding: "2px 8px 8px" }}>
          The day home is on or before the joining day, so nothing was changed.
        </td></tr>
      )}
      {gaps.map((g) => (
        <tr key={g.id}>
          <td colSpan={days.length + 4} style={{ padding: "6px 8px 10px", textAlign: "left", background: T.raised }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text }}>
                Covered {fmtDate(g.from)} to {fmtDate(g.to)} by
              </span>
              <select className="um-in" style={{ width: "auto", minWidth: 260 }} value={cover[g.id] || ""}
                onChange={(e) => setCover({ ...cover, [g.id]: e.target.value })}>
                <option value="">Choose…</option>
                {offSwing.map((p) => <option key={p.id} value={p.id}>{fullName(p)} — {positionOf(p)}</option>)}
              </select>
              <Button writes variant="ghost" disabled={!cover[g.id]}
                onClick={() => { const p = offSwing.find((x) => String(x.id) === cover[g.id]); if (p) { onCover(p, g.from, g.to); setCover({ ...cover, [g.id]: "" }); } }}>
                Add for those days
              </Button>
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

function PartSwing({ swing, lastDay, offSwing, fullName, positionOf, onBring }) {
  const [who, setWho] = useState("");
  const [o, setO] = useState(swing.flyOut);
  const [h, setH] = useState(swing.flyHome);
  const backwards = !!o && !!h && h <= o;
  return (
    <div style={{ background: T.raised, border: `1px solid ${T.rule}`, borderRadius: 3, padding: "16px 18px", marginTop: 18 }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "3 1 420px", fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.6,
          background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 3, padding: "12px 14px" }}>
          Bring somebody on for part of this swing — filling in, coming out late, or swapping with someone going home early. They share the seat of whoever holds it for the rest of the swing.
        </div>
        <div style={{ flex: "1 1 240px" }}>
          <Field label="Who">
            <select className="um-in" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Choose…</option>
              {offSwing.map((p) => <option key={p.id} value={p.id}>{fullName(p)} — {positionOf(p)}</option>)}
            </select>
          </Field>
        </div>
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14 }}>
        <Field label="Joins">
          <input className="um-in" type="date" value={o} min={swing.flyOut} max={lastDay} onChange={(e) => setO(e.target.value)} />
        </Field>
        <Field label="Flies home">
          <input className="um-in" type="date" value={h} min={isoShift(swing.flyOut, 1)} max={swing.flyHome} onChange={(e) => setH(e.target.value)} />
        </Field>
        <div style={{ paddingBottom: 1 }}>
          <Button writes variant="ghost" disabled={!who || backwards || !o || !h}
            onClick={() => { const p = offSwing.find((x) => String(x.id) === who); if (p) { onBring(p, o, h); setWho(""); } }}>
            Bring onboard for those days
          </Button>
        </div>
        {backwards && <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed }}>The day home is on or before the joining day.</span>}
      </div>
    </div>
  );
}

/* The office's crew roster workbook, read as the portal keeps it.
 *
 * The workbook seeds the roster; from then on the roster is the portal's own,
 * changed here with buttons and shared like everything else. The sheet that
 * matters when loading is Swings — one row per person per swing — and the
 * workbook's own On board each swing sheet gives the swings themselves.
 * Dates come out of Excel as a count of days, turned back into dates here.
 */
const EXCEL_EPOCH_DAYS = 25569;
function excelDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 20000 || n > 80000) {
    return /^\d{4}-\d{2}-\d{2}/.test(String(v || "")) ? String(v).slice(0, 10) : null;
  }
  return new Date(Math.round((n - EXCEL_EPOCH_DAYS) * 86400000)).toISOString().slice(0, 10);
}

const swingKeyOf = (s) => s.on + "|" + s.off;
const daysBetween = (on, off) => Math.round((new Date(off) - new Date(on)) / 86400000);

// The swing a person's days sit inside — or the one they overlap most, where
// the dates were changed for them.
function bestSwingKey(r, spine) {
  let best = null, most = 0;
  for (const s of spine) {
    const from = r.on > s.on ? r.on : s.on;
    const to = r.off < s.off ? r.off : s.off;
    const days = daysBetween(from, to);
    if (days > most) { most = days; best = s; }
  }
  return best ? swingKeyOf(best) : null;
}

async function readCrewRoster(record) {
  const XLSX = await loadXLSX();
  const resp = await fetch(record.url);
  if (!resp.ok) throw new Error("The roster on file couldn't be downloaded (" + resp.status + ").");
  const wb = XLSX.read(await resp.arrayBuffer(), { type: "array" });
  const name = wb.SheetNames.find((n) => /swing/i.test(n) && !/on board/i.test(n));
  if (!name) throw new Error("That workbook has no Swings sheet in it.");
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });

  const head = (grid[0] || []).map((c) => String(c).trim().toUpperCase());
  const at = (want) => head.findIndex((h) => h === want);
  const cCrew = at("CREW"), cRank = at("RANK"), cName = at("NAME");
  const cOn = at("SIGN ON"), cOff = at("SIGN OFF"), cNote = at("NOTES");
  // Who a relief hand is standing in for. Its own column rather than a note,
  // so it is still plain in ten years to anyone who opens the workbook.
  const cCover = at("COVERING FOR");
  if (cName < 0 || cOn < 0 || cOff < 0) throw new Error("The Swings sheet doesn't carry the columns this reads.");

  // The swings themselves, off the workbook's own sheet.
  const spine = [];
  const boardName = wb.SheetNames.find((n) => /on board/i.test(n));
  if (boardName) {
    const board = XLSX.utils.sheet_to_json(wb.Sheets[boardName], { header: 1, defval: "" });
    const bHead = (board[0] || []).map((c) => String(c).trim().toUpperCase());
    const bCrew = bHead.indexOf("CREW"), bOn = bHead.indexOf("SIGN ON"), bOff = bHead.indexOf("SIGN OFF");
    if (bOn >= 0 && bOff >= 0) {
      for (const b of board.slice(1)) {
        const on = excelDate(b[bOn]), off = excelDate(b[bOff]);
        if (!on || !off) continue;
        const crew = String(b[bCrew] || "").trim();
        const had = spine.find((x) => x.on === on && x.off === off);
        // A swing both crews have a hand in is written twice; the plain letter wins.
        if (had) { if (crew && !crew.includes("/") && had.crew.includes("/")) had.crew = crew; continue; }
        spine.push({ on, off, crew });
      }
      spine.sort((a, b) => a.on.localeCompare(b.on));
    }
  }

  const rows = [];
  for (const r of grid.slice(1)) {
    const person = String(r[cName] || "").replace(/\s+/g, " ").trim();
    const on = excelDate(r[cOn]);
    const off = excelDate(r[cOff]);
    if (!person || !on || !off) continue;
    rows.push({
      crew: String(r[cCrew] || "").trim(),
      rank: String(r[cRank] || "").trim(),
      name: person,
      on, off,
      days: daysBetween(on, off),
      note: cNote >= 0 ? String(r[cNote] || "").trim() : "",
      covers: cCover >= 0 ? String(r[cCover] || "").replace(/\s+/g, " ").trim() : "",
    });
  }
  if (!rows.length) throw new Error("Nothing on the Swings sheet could be read as a swing.");
  rows.forEach((r, i) => { r.id = "r" + (i + 1); r.swing = bestSwingKey(r, spine); });

  // Who the office calls relief or cover, off the Crew Roster sheet's own
  // RELIEF / COVER rows — names are matched whole, so a bare "JACK" in that
  // block never drags a Jack somebody-else out of his crew.
  const relief = [];
  const gridName = wb.SheetNames.find((n) => /crew roster/i.test(n));
  if (gridName) {
    const cr = XLSX.utils.sheet_to_json(wb.Sheets[gridName], { header: 1, defval: "" });
    for (const r of cr) {
      const a = String(r[0] || "").replace(/\s+/g, " ").trim().toUpperCase();
      if (!/^RELIEF/.test(a)) continue;
      const rank = String(r[1] || "").replace(/\s+/g, " ").trim().toUpperCase();
      const who = String(r[2] || "").replace(/\s+/g, " ").trim().toUpperCase();
      if (!who || rank === "RANK" || /^ROLE|^WHOSE|^\d+$/.test(rank) || /^WHOSE|^\d+$/.test(who)) continue;
      relief.push({ name: who, rank });
    }
  }

  return { at: todayISO(), filename: record.filename, rows, spine, relief };
}

/* The roster written back into the workbook on file, and only into it.
 *
 * The Swings sheet is rebuilt from the portal's roster — every stint a row,
 * the dates as Excel keeps them — and every other sheet, colour and formula
 * in the workbook is left byte for byte as it was. The DAYS column becomes
 * plain numbers, so the calc chain is dropped and Excel told to work the
 * formulas out afresh when it next opens the file.
 */
const rosterColAt = (i) => {
  let n = i + 1, s = "";
  while (n) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
const rosterXmlSafe = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* The roster as it stands, written into the office's workbook and filed back
 * to SharePoint - the same file, replaced, with every other sheet untouched.
 *
 * It is here rather than on the Roster page because the Roster page is not the
 * only thing that changes the roster: taking a crew member off the portal
 * changes it too, and the workbook has to follow either way.
 */
async function fileRosterWorkbook(crewRoster, plan, role) {
  if (!crewRoster || !crewRoster.url || !plan) return null;
  const resp = await fetch(crewRoster.url);
  if (!resp.ok) throw new Error("The roster workbook couldn't be downloaded (" + resp.status + "). Nothing was saved.");
  const blob = await saveRosterWorkbook(await resp.arrayBuffer(), plan);
  const file = new File([blob], crewRoster.filename, { type: XLSX_MIME });
  const up = await uploadSingleDocument(file, "crew-roster",
    { uploadedBy: role, filedOn: todayISO(), session: SESSION }, "replace");
  return up.record || null;
}

async function saveRosterWorkbook(buf, plan) {
  if (!zipCapable()) throw new Error("This browser can't rewrite the workbook. Chrome, Edge, Firefox or Safari can. Nothing was saved.");
  const entries = readZip(buf);
  const wbPart = partOf(entries, "xl/workbook.xml");
  const relsPart = partOf(entries, "xl/_rels/workbook.xml.rels");
  if (!wbPart || !relsPart) throw new Error("The roster on file is not laid out like a .xlsx inside. Nothing was saved.");
  const workbookXml = await partText(wbPart);
  const relsXml = await partText(relsPart);
  const date1904 = /date1904="(1|true)"/.test(workbookXml);

  const sheets = [...workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
    .map((m) => ({ name: m[1], rid: m[2] }));
  const swingsSheet = sheets.find((s) => /swing/i.test(s.name) && !/on board/i.test(s.name));
  if (!swingsSheet) throw new Error("The workbook has no Swings sheet to save into. Nothing was saved.");
  const rel = relsXml.match(new RegExp('Id="' + swingsSheet.rid + '"[^>]*Target="([^"]+)"'));
  if (!rel) throw new Error("The Swings sheet couldn't be placed inside the workbook. Nothing was saved.");
  const path = "xl/" + rel[1].replace(/^\/+/, "").replace(/^xl\//, "");
  const sheetPart = partOf(entries, path);
  if (!sheetPart) throw new Error("The Swings sheet is missing from the workbook. Nothing was saved.");
  const oldXml = await partText(sheetPart);

  // The dates keep the sheet's own date dress, sampled from a cell that has it.
  const styled = oldXml.match(/<c r="D[2-9]\d*" s="(\d+)"[^>]*><v>/);
  const dateStyle = styled ? styled[1] : null;
  const epoch = date1904 ? "1904-01-01" : "1899-12-30";
  const serial = (d) => daysBetween(epoch, d);

  const rows = (plan.rows || []).slice().sort((a, b) =>
    a.on.localeCompare(b.on) || String(a.crew || "").localeCompare(String(b.crew || ""))
    || rosterRankAt(a.rank) - rosterRankAt(b.rank) || a.name.localeCompare(b.name));
  const head = ["CREW", "RANK", "NAME", "SIGN ON", "SIGN OFF", "DAYS", "WHERE THIS CAME FROM", "NOTES", "COVERING FOR"];
  const str = (ref, v) => (v === "" || v == null) ? ""
    : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + rosterXmlSafe(v) + "</t></is></c>";
  const num = (ref, v, s) => '<c r="' + ref + '"' + (s ? ' s="' + s + '"' : "") + "><v>" + v + "</v></c>";

  let data = '<row r="1">' + head.map((h, i) => str(rosterColAt(i) + "1", h)).join("") + "</row>";
  rows.forEach((r, i) => {
    const n = i + 2;
    data += '<row r="' + n + '">'
      + str("A" + n, r.crew || "") + str("B" + n, r.rank || "") + str("C" + n, r.name || "")
      + num("D" + n, serial(r.on), dateStyle) + num("E" + n, serial(r.off), dateStyle)
      + num("F" + n, r.days || daysBetween(r.on, r.off), null)
      + str("G" + n, "Crew portal") + str("H" + n, r.note || "")
      + str("I" + n, r.covers || "")
      + "</row>";
  });

  let xml = /<sheetData\/>/.test(oldXml)
    ? oldXml.replace(/<sheetData\/>/, "<sheetData>" + data + "</sheetData>")
    : oldXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, "<sheetData>" + data + "</sheetData>");
  xml = xml.replace(/<dimension[^>]*\/>/, '<dimension ref="A1:I' + (rows.length + 1) + '"/>');

  await setPartText(sheetPart, xml);

  /* "On board each swing" counts each swing's hands by rank. It is worked out
     from the very rows written above, so the two cannot come to disagree -
     until now it was left exactly as the office first wrote it, and went
     quietly out of date the moment anybody was moved.

     One line per crew on each swing, which is how the office writes it: a
     swing both crews have a hand in says so on two lines. The last column,
     which counted how many of each swing came from the four-week cycle rather
     than the travel roster, is a note about where the workbook was first built
     from; the roster is kept here now, so there is nothing true to put in it. */
  const onBoard = sheets.find((sh) => /on board/i.test(sh.name));
  if (onBoard) {
    const obRel = relsXml.match(new RegExp('Id="' + onBoard.rid + '"[^>]*Target="([^"]+)"'));
    const obPath = obRel ? "xl/" + obRel[1].replace(/^\/+/, "").replace(/^xl\//, "") : null;
    const obPart = obPath ? partOf(entries, obPath) : null;
    if (obPart) {
      const obOld = await partText(obPart);
      const obStyled = obOld.match(/<c r="B[2-9]\d*" s="(\d+)"[^>]*><v>/);
      const obDate = obStyled ? obStyled[1] : dateStyle;

      const BUCKETS = [
        ["MASTER", /^MASTER/], ["C/O", /^CHIEF OFFICER/], ["2/O", /^SECOND OFFICER/],
        ["CH ENG", /^CHIEF ENGINEER/], ["1ST ENG", /^FIRST ENGINEER/],
        ["JNR ENG", /^JUNIOR ENGINEER/], ["GPH", /^GPH/], ["COOK", /^COOK/],
      ];
      const obHead = ["CREW", "SIGN ON", "SIGN OFF", ...BUCKETS.map((b) => b[0]),
        "NO RANK", "TOTAL", "OF WHICH FROM THE CYCLE"];

      const lines = [];
      ((plan.spine || []).slice().sort((a, b) => a.on.localeCompare(b.on))).forEach((sp) => {
        const here = rows.filter((r) => r.on < sp.off && r.off > sp.on);
        const byCrew = new Map();
        here.forEach((r) => {
          const c = String(r.crew || "").trim().toUpperCase() || "OTHER";
          if (!byCrew.has(c)) byCrew.set(c, []);
          byCrew.get(c).push(r);
        });
        [...byCrew.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([crew, mine]) => {
          const counts = BUCKETS.map(([, re]) => mine.filter((r) => re.test(String(r.rank || "").toUpperCase())).length);
          const named = counts.reduce((a, b) => a + b, 0);
          lines.push({ crew, on: sp.on, off: sp.off, counts, none: mine.length - named, total: mine.length });
        });
      });

      let obData = '<row r="1">' + obHead.map((h, i) => str(rosterColAt(i) + "1", h)).join("") + "</row>";
      lines.forEach((l, i) => {
        const n = i + 2;
        let cells = str("A" + n, l.crew)
          + num("B" + n, serial(l.on), obDate) + num("C" + n, serial(l.off), obDate);
        l.counts.forEach((v, j) => { if (v) cells += num(rosterColAt(3 + j) + n, v, null); });
        if (l.none) cells += num(rosterColAt(11) + n, l.none, null);
        cells += num(rosterColAt(12) + n, l.total, null);
        obData += '<row r="' + n + '">' + cells + "</row>";
      });

      let obXml = /<sheetData\/>/.test(obOld)
        ? obOld.replace(/<sheetData\/>/, "<sheetData>" + obData + "</sheetData>")
        : obOld.replace(/<sheetData>[\s\S]*?<\/sheetData>/, "<sheetData>" + obData + "</sheetData>");
      obXml = obXml.replace(/<dimension[^>]*\/>/, '<dimension ref="A1:N' + (lines.length + 1) + '"/>');
      await setPartText(obPart, obXml);
    }
  }

  /* The Crew Roster sheet: the wall chart, a day to a column.
   *
   * It was left as the office first drew it - names down the side, days across
   * the top, and every square between them empty. A picture of nothing, going
   * further out of date with every change.
   *
   * It is drawn from the roster now, and drawn as DATA rather than as colour.
   * Each square carries a letter saying what that day is, so the sheet can be
   * read years from now by anyone or anything that opens it, with no way of
   * knowing what a shade of green was once meant to signify:
   *
   *     O  signs on      X  on board      F  signs off      R  relief or cover
   *
   * The colours are laid on top for a person reading it at a glance, and are
   * the workbook's own - the office had already defined them, so nothing is
   * added to the file's palette. A key is written at the foot of the sheet,
   * saying what the letters mean and where the record of truth lives, so the
   * sheet explains itself without this note or anybody who remembers it.
   *
   * The first four rows are the office's own - title, months, day numbers,
   * weekday letters - and are left exactly as they are. Which day each column
   * stands for is read from the sheet itself, off the span written in E1, so
   * if the office ever redraws the chart the roster follows it rather than
   * writing over the top of a chart it has misread. If that line cannot be
   * read, the grid is left alone and the rest of the save still stands. */
  const gridSheet = sheets.find((sh) => /crew roster/i.test(sh.name));
  if (gridSheet) {
    const gRel = relsXml.match(new RegExp('Id="' + gridSheet.rid + '"[^>]*Target="([^"]+)"'));
    const gPath = gRel ? "xl/" + gRel[1].replace(/^\/+/, "").replace(/^xl\//, "") : null;
    const gPart = gPath ? partOf(entries, gPath) : null;
    if (gPart) {
      const gOld = await partText(gPart);

      // Which day the first day column stands for, off the sheet's own header.
      const sstPart = partOf(entries, "xl/sharedStrings.xml");
      const sst = sstPart
        ? [...(await partText(sstPart)).matchAll(/<si>([\s\S]*?)<\/si>/g)]
            .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""))
        : [];
      const spanCell = gOld.match(/<c r="E1"[^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/);
      const spanText = spanCell ? sst[Number(spanCell[1])] || "" : "";
      const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const span = spanText.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
      const monthAt = span ? MONTHS.indexOf(span[2].slice(0, 3).toLowerCase()) : -1;

      if (span && monthAt >= 0) {
        const pad = (v) => String(v).padStart(2, "0");
        const gridFrom = span[3] + "-" + pad(monthAt + 1) + "-" + pad(span[1]);
        const FIRST_DAY_COL = 5;                       // column E
        const lastCol = 491;                           // the chart's last day column
        const colFor = (d) => FIRST_DAY_COL + daysBetween(gridFrom, d);

        // The workbook's own colours, already in its palette.
        const ON_STYLE = "5", BOARD_STYLE = "4", OFF_STYLE = "6", CHANGED_STYLE = "7", RELIEF_STYLE = "10";
        const mark = (ref, v, st) =>
          '<c r="' + ref + '" s="' + st + '" t="inlineStr"><is><t>' + v + "</t></is></c>";
        const plain = (ref, v, st) => (v === "" || v == null) ? ""
          : '<c r="' + ref + '"' + (st ? ' s="' + st + '"' : "")
            + ' t="inlineStr"><is><t xml:space="preserve">' + rosterXmlSafe(v) + "</t></is></c>";

        // Who stands where, reckoned the way the roster page reckons it.
        const reliefNames = new Set(((plan.relief) || []).map((r) => String(r.name).toUpperCase()));
        const roleOf = new Map(((plan.relief) || []).map((r) => [String(r.name).toUpperCase(), r.rank || ""]));
        const isRelief = (nm) => reliefNames.has(String(nm || "").replace(/\s+/g, " ").trim().toUpperCase());
        const swingOn = (d) => (plan.spine || []).find((sp) => sp.on <= d && d < sp.off) || null;

        const folk = new Map();
        rows.forEach((r) => {
          if (!folk.has(r.name)) folk.set(r.name, { name: r.name, rank: r.rank, tally: {}, covers: {}, stints: [] });
          const p = folk.get(r.name);
          p.stints.push(r);
          const c = String(r.crew || "").trim().toUpperCase() || "OTHER";
          p.tally[c] = (p.tally[c] || 0) + 1;
          const sp = swingOn(r.on);
          const sc = sp ? String(sp.crew || "").trim().toUpperCase() : "";
          if (sc === "ALPHA" || sc === "BRAVO") p.covers[sc] = (p.covers[sc] || 0) + 1;
          if (rosterRankAt(r.rank) < rosterRankAt(p.rank)) p.rank = r.rank;
        });
        const all = [...folk.values()].map((p) => ({
          ...p,
          crew: Object.keys(p.tally).sort((a, b) => p.tally[b] - p.tally[a])[0] || "OTHER",
          covered: Object.keys(p.covers).sort((a, b) => p.covers[b] - p.covers[a])[0] || "ALPHA",
          cover: isRelief(p.name),
        }));
        const byRank = (a, b) => rosterRankAt(a.rank) - rosterRankAt(b.rank) || a.name.localeCompare(b.name);

        const blocks = [];
        ["ALPHA", "BRAVO"].forEach((crew) => {
          const own = all.filter((p) => !p.cover && p.crew === crew).sort(byRank);
          const cover = all.filter((p) => p.cover && p.covered === crew).sort(byRank);
          if (own.length) blocks.push({ head: crew + " CREW", relief: false, people: own });
          if (cover.length) blocks.push({ head: "RELIEF / COVER", relief: true, people: cover });
        });
        const placed = new Set(blocks.flatMap((b) => b.people.map((p) => p.name)));
        const rest = all.filter((p) => !placed.has(p.name)).sort(byRank);
        if (rest.length) blocks.push({ head: "OTHER", relief: false, people: rest });

        // The office's own first four rows, kept exactly as they are.
        const head4 = [...gOld.matchAll(/<row[^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>/g)]
          .filter((m) => Number(m[1]) <= 4).map((m) => m[0]).join("");

        let n = 4;
        let body = "";
        blocks.forEach((b) => {
          n++;
          body += '<row r="' + n + '">'
            + plain("A" + n, b.head, "15")
            + (b.relief ? plain("B" + n, "ROLE COVERED", "15") + plain("C" + n, "NAME", "15") : "")
            + "</row>";
          b.people.forEach((p) => {
            n++;
            let cells = plain("A" + n, b.relief ? "RELIEF / COVER" : p.crew, "16")
              + plain("B" + n, (b.relief ? (roleOf.get(p.name.toUpperCase()) || p.rank) : p.rank) || "", "16")
              + plain("C" + n, p.name, "34");
            const done = new Set();
            p.stints.forEach((st) => {
              const sp = st.swing ? (plan.spine || []).find((x) => swingKeyOf(x) === st.swing) : swingOn(st.on);
              let d = st.on, guard = 0;
              while (d <= st.off && guard++ < 900) {
                const col = colFor(d);
                if (col >= FIRST_DAY_COL && col <= lastCol && !done.has(col)) {
                  done.add(col);
                  const ref = rosterColAt(col - 1) + n;
                  if (d === st.on) cells += mark(ref, "O", sp && st.on !== sp.on ? CHANGED_STYLE : ON_STYLE);
                  else if (d === st.off) cells += mark(ref, "F", sp && st.off !== sp.off ? CHANGED_STYLE : OFF_STYLE);
                  else cells += mark(ref, b.relief ? "R" : "X", b.relief ? RELIEF_STYLE : BOARD_STYLE);
                }
                d = isoShift(d, 1);
              }
            });
            body += '<row r="' + n + '">' + cells + "</row>";
          });
        });

        // A key, so the sheet says what it means without anybody to explain it.
        const key = [
          "KEY - written by the crew portal, " + todayISO(),
          "O = signs on.  X = on board.  F = signs off.  R = relief or cover on board.",
          "A sign on or off shown in red is not that swing's own changeover day.",
          "The Swings sheet is the record: it carries every name with exact sign on and sign off dates.",
          "This chart is drawn from it, so the two cannot disagree. Both are rewritten together when the roster is saved.",
        ];
        n++;
        key.forEach((line) => { n++; body += '<row r="' + n + '">' + plain("A" + n, line, null) + "</row>"; });

        let gXml = /<sheetData\/>/.test(gOld)
          ? gOld.replace(/<sheetData\/>/, "<sheetData>" + head4 + body + "</sheetData>")
          : gOld.replace(/<sheetData>[\s\S]*?<\/sheetData>/, "<sheetData>" + head4 + body + "</sheetData>");
        gXml = gXml.replace(/<dimension[^>]*\/>/, '<dimension ref="A1:RW' + n + '"/>');
        await setPartText(gPart, gXml);
      }
    }
  }

  await dropCalcChain(entries);
  await setPartText(wbPart, recalcOnOpen(workbookXml));
  return writeZip(entries);
}

/* The roster laid out swing by swing: the workbook's swings, each carrying
   whoever is signed onto it. A swing with nobody on it yet still shows, so
   crew can be put onto it. */

const ROSTER_RANKS = VESSEL.rosterRanks;
const rosterRankAt = (rank) => {
  const up = String(rank || "").toUpperCase().trim();
  const i = ROSTER_RANKS.findIndex((r) => up === r || up.startsWith(r));
  return i < 0 ? ROSTER_RANKS.length : i;
};

// The roster's own word for a matrix position, so somebody added from the
// crew list lands under the right heading.
function rosterRankFor(position) {
  const p = String(position || "").toUpperCase();
  if (/CHIEF ENGINEER|ENGINEER CLASS 1/.test(p)) return "CHIEF ENGINEER";
  if (/FIRST ENGINEER|1ST ENG/.test(p)) return "FIRST ENGINEER";
  if (/ASSISTANT ENGINEER|JUNIOR ENGINEER/.test(p)) return "JUNIOR ENGINEER";
  if (/CHIEF OFFICER|CHIEF MATE/.test(p)) return "CHIEF OFFICER";
  if (/SECOND (MATE|OFFICER)/.test(p)) return "SECOND OFFICER";
  if (/MASTER/.test(p)) return "MASTER";
  if (/GPH|GENERAL PURPOSE/.test(p)) return "GPH";
  if (/COOK|CHEF/.test(p)) return "COOK";
  return String(position || "").toUpperCase() || "OTHER";
}

/* One person's days on a swing, edited in place. A date applies the moment it
   is picked, the same way the swing day grid works. */
const RT_ON = "#41B8D5";
const RT_BOARD = "#92D050";
const RT_OFF = "#FFC000";
const RT_RELIEF = "#D883C9";
const RT_CELL = 13;

// A day cell carries its colour and nothing else, and the five colours in play
// each keep one style object between them - twenty thousand fresh ones a
// redraw was work for its own sake.
const RT_BG = {};
const bgOf = (hex) => RT_BG[hex] || (RT_BG[hex] = { background: hex });
const RT_NO_DAYS = new Map();

function RosterTimeline({ plan, admin, onStint, onBlank, onPerson, onDates, onRange, onDeleteRange, rankFor, sortBy }) {
  const spine = (plan && plan.spine) || [];
  const rows = (plan && plan.rows) || [];
  const today = todayISO();
  const frame = useRef(null);

  const swingByKey = useMemo(() => {
    const m = new Map();
    spine.forEach((s) => m.set(s.on + "|" + s.off, s));
    return m;
  }, [plan]);

  // Every day the roster covers, first sign-on to last sign-off, and never
  // further out than a year from today. The workbook is written further ahead
  // than that, but those months are not being worked to yet. The days beyond
  // the year are only hidden - the swings themselves are untouched, and go
  // back to the spreadsheet whole when the roster is saved.
  const days = useMemo(() => {
    if (!spine.length && !rows.length) return [];
    let a = null, b = null;
    [...spine, ...rows].forEach((r) => {
      if (!a || r.on < a) a = r.on;
      if (!b || r.off > b) b = r.off;
    });
    const stop = isoShift(today, 365);
    if (b > stop) b = stop;
    if (!a || !b || a > b) return [];
    const out = [];
    for (let d = a; d <= b; d = isoShift(d, 1)) out.push(d);
    return out;
  }, [plan]);

  // Opens with today in the second week of view, not at September's far end.
  React.useEffect(() => {
    const el = frame.current;
    if (!el || !days.length) return;
    const at = days.indexOf(today);
    if (at > 0) el.scrollLeft = Math.max(0, (at - 7) * RT_CELL);
  }, [days.length]);

  // The table ends at the bottom of the window, so the page never scrolls -
  // the crew scroll inside the table and its slider stays put underneath.
  const [tallest, setTallest] = React.useState(null);
  React.useEffect(() => {
    document.body.classList.add("um-tight");
    let pending = 0;
    const fit = () => {
      const el = frame.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      // What has to sit under the table - the gap down to the footer, the
      // footer itself, and the page's own padding beneath it - is measured off
      // those three pieces. Measuring it off the height of the page instead
      // looks right and isn't: once the page is shorter than the screen, the
      // page counts the empty window as part of itself, and the sum comes back
      // saying the table should be exactly the size it already is. That is why
      // it sat still through a zoom.
      let below = 40;
      const foot = document.querySelector("footer");
      if (foot) {
        const fb = foot.getBoundingClientRect();
        const cont = foot.parentElement;
        const pad = cont ? cont.getBoundingClientRect().bottom - fb.bottom : 0;
        below = (fb.top - box.bottom) + fb.height + Math.max(0, pad);
      }
      const want = Math.max(150, Math.round(window.innerHeight - (box.top + window.scrollY) - below));
      setTallest((was) => (was !== null && Math.abs(was - want) <= 1 ? was : want));
    };
    // Zoom changes the size of the window in the units the page is laid out in,
    // so it arrives as a resize; the viewport and the page itself are watched
    // too, for the zooms and reflows that come by another road.
    //
    // The wait is kept on a timer rather than on the next drawn frame. A tab
    // sitting in the background is never drawn, so a frame booked there is
    // never called back - and the booking left standing would swallow every
    // later change. Zoom on a tab you have stepped away from and come back to,
    // and the table would have sat the whole thing out.
    let late = 0;
    const soon = () => {
      clearTimeout(pending);
      clearTimeout(late);
      // Twice: once the moment it settles, and again after, since a zoom can
      // reflow in stages and the second look costs nothing when it agrees.
      pending = setTimeout(fit, 60);
      late = setTimeout(fit, 320);
    };
    soon();
    window.addEventListener("resize", soon);
    const seen = window.visualViewport;
    if (seen) { seen.addEventListener("resize", soon); seen.addEventListener("scroll", soon); }
    const watch = new ResizeObserver(soon);
    watch.observe(document.documentElement);
    return () => {
      document.body.classList.remove("um-tight");
      window.removeEventListener("resize", soon);
      if (seen) { seen.removeEventListener("resize", soon); seen.removeEventListener("scroll", soon); }
      watch.disconnect();
      clearTimeout(pending);
      clearTimeout(late);
    };
  }, []);

  const reliefNames = useMemo(
    () => new Set(((plan && plan.relief) || []).map((r) => String(r.name).toUpperCase())),
    [plan],
  );
  /* Who is standing in for whom, off the roster's own rows. The office's
     RELIEF / COVER list says so for the hands it knows; anybody put on here to
     cover somebody says so themselves, and is read as relief the same way. */
  const coverFor = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => { if (r.covers) m.set(r.name, r.covers); });
    return m;
  }, [plan]);
  const rankOfPerson = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => { if (r.rank && !m.has(r.name)) m.set(r.name, r.rank); });
    return m;
  }, [plan]);
  const isRelief = (name) => reliefNames.has(String(name || "").replace(/\s+/g, " ").trim().toUpperCase())
    || coverFor.has(name);

  // The role the office's own RELIEF / COVER list says they are standing in for.
  const reliefRole = useMemo(
    () => new Map(((plan && plan.relief) || []).map((r) => [String(r.name).toUpperCase(), r.rank || ""])),
    [plan],
  );
  const roleCovered = (name) => {
    const standingIn = coverFor.get(name);
    if (standingIn) return rankOfPerson.get(standingIn) || "";
    return reliefRole.get(String(name || "").replace(/\s+/g, " ").trim().toUpperCase()) || "";
  };

  /* Take hold of the day a person signs on or off and pull it along the
     table, or sweep across empty days to put someone on for just those days.
     Letting go without moving opens the panel, the way a plain click always
     did. */
  const [drag, setDrag] = useState(null);
  React.useEffect(() => {
    if (!drag) return;
    const d = drag;
    const up = () => {
      setDrag(null);
      if (d.kind === "new") {
        const a = d.anchor < d.at ? d.anchor : d.at;
        const b = d.anchor < d.at ? d.at : d.anchor;
        if (a === b) { if (d.swing) onBlank(d.person, d.swing); }
        else if (onRange) onRange(d.person, a, b);
        return;
      }
      if (d.at === d.from) { onStint(d.row); return; }
      if (!onDates) return;
      if (d.kind === "on" && d.at < d.row.off) onDates(d.row, d.at, d.row.off);
      else if (d.kind === "off" && d.at > d.row.on) onDates(d.row, d.row.on, d.at);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [drag]);

  // A stint as the hand currently holds it, so the colours follow the drag.
  const effective = (st) => {
    if (!drag || !drag.row || drag.row.id !== st.id) return st;
    if (drag.kind === "on" && drag.at < st.off) return { ...st, on: drag.at };
    if (drag.kind === "off" && drag.at > st.on) return { ...st, off: drag.at };
    return st;
  };

  const sweeping = (p, d) => {
    if (!drag || drag.kind !== "new" || drag.person.name !== p.name) return false;
    const a = drag.anchor < drag.at ? drag.anchor : drag.at;
    const b = drag.anchor < drag.at ? drag.at : drag.anchor;
    return d >= a && d <= b;
  };

  /* One line per person. Whoever the office's own RELIEF / COVER list names
     sits in a Relief / cover block under the crew whose swings they cover;
     everyone else sits with their own crew. */
  const blocks = useMemo(() => {
    const people = new Map();
    rows.forEach((r) => {
      if (!people.has(r.name)) people.set(r.name, { name: r.name, rank: r.rank, tally: {}, covers: {}, stints: [] });
      const p = people.get(r.name);
      p.stints.push(r);
      const c = String(r.crew || "").trim().toUpperCase() || "OTHER";
      p.tally[c] = (p.tally[c] || 0) + 1;
      const sw = r.swing && swingByKey.get(r.swing);
      if (sw) {
        const sc = String(sw.crew || "").trim().toUpperCase();
        if (sc === "ALPHA" || sc === "BRAVO") p.covers[sc] = (p.covers[sc] || 0) + 1;
      }
      if (rosterRankAt(r.rank) < rosterRankAt(p.rank)) p.rank = r.rank;
    });
    // The Swings sheet leaves a rank out here and there - it says "(not
    // stated)" against one hand today. The crew matrix knows everyone's
    // position, so it answers where the sheet doesn't. A rank the office did
    // write is never overruled, and the fill-in happens here rather than at
    // the drawing, so the line sorts among its own rank as well as reading as
    // one.
    const vague = (r) => {
      const t = String(r || "").trim();
      return !t || /^\(.*\)$/.test(t) || /not stated|unknown|tbc|tba|n\/a/i.test(t);
    };
    const list = [...people.values()].map((p) => {
      const crews = Object.keys(p.tally).sort((a, b) => p.tally[b] - p.tally[a]);
      const covered = Object.keys(p.covers).sort((a, b) => p.covers[b] - p.covers[a])[0] || "ALPHA";
      const rank = vague(p.rank) && rankFor ? (rankFor(p.name) || p.rank) : p.rank;
      return { ...p, rank, crew: crews[0] || "OTHER", coverOnly: isRelief(p.name), covered };
    });
    /* Either way round, within each crew block.
     *
     * By rank is the order the vessel is manned in - master, chief officer,
     * second officer, the engineers down, GPH, cook - which is how a roster is
     * read when the question is who is covering what. By surname is how it is
     * read when the question is where one particular person is, and looking for
     * a name in rank order means knowing their rank first.
     *
     * Names are written LASTNAME, First, so sorting the name sorts the surname
     * and no separate parsing is needed. */
    const byRank = (a, b) => rosterRankAt(a.rank) - rosterRankAt(b.rank) || a.name.localeCompare(b.name);
    const byName = (a, b) => a.name.localeCompare(b.name);
    const order = sortBy === "name" ? byName : byRank;
    const out = [];
    ["ALPHA", "BRAVO"].forEach((crew) => {
      const own = list.filter((p) => !p.coverOnly && p.crew === crew).sort(order);
      const cover = list.filter((p) => p.coverOnly && p.covered === crew).sort(order);
      if (own.length) out.push({ label: swingCrewCalled(crew), people: own, of: crew });
      if (cover.length) out.push({ label: "Relief / cover", people: cover, relief: true, of: crew });
    });
    const placed = new Set(out.flatMap((b) => b.people.map((p) => p.name)));
    const rest = list.filter((p) => !placed.has(p.name)).sort(order);
    if (rest.length) out.push({ label: "Other", people: rest, of: "OTHER" });

    /* Each crew counts from one, and the relief standing in for that crew
       carries on from where the crew left off - so the last number against a
       team is how many hands it has aboard, cover included. */
    const counted = {};
    out.forEach((b) => {
      const key = b.of || "OTHER";
      b.people = b.people.map((p) => ({ ...p, no: (counted[key] = (counted[key] || 0) + 1) }));
    });
    return out;
  }, [plan, sortBy]);

  /* Each person's days worked out once from their own stints, rather than
     asking the question again for every square of the table - a stint knows
     the days it covers, so only those are walked. The first stint to claim a
     day keeps it, which is the order the squares were read in before. */
  const dayCells = useMemo(() => {
    const out = new Map();
    blocks.forEach((g) => g.people.forEach((p) => {
      const mine = new Map();
      const relief = isRelief(p.name);
      p.stints.forEach((raw) => {
        const st = effective(raw);
        const swing = (raw.swing && swingByKey.get(raw.swing)) || null;
        const onOff = swing && st.on !== swing.on;
        const offOff = swing && st.off !== swing.off;
        let d = st.on, guard = 0;
        while (d <= st.off && guard++ < 900) {
          if (!mine.has(d)) {
            if (d === st.on) mine.set(d, { bg: onOff ? T.bRed : RT_ON, word: onOff ? "signs on — not the swing's day" : "signs on", row: raw, edge: "on" });
            else if (d === st.off) mine.set(d, { bg: offOff ? T.bRed : RT_OFF, word: offOff ? "signs off — not the swing's day" : "signs off", row: raw, edge: "off" });
            else mine.set(d, { bg: relief ? RT_RELIEF : RT_BOARD, word: relief ? "onboard — relief / cover" : "onboard", row: raw, edge: null });
          }
          d = isoShift(d, 1);
        }
      });
      out.set(p.name, mine);
    }));
    return out;
  }, [blocks, drag]);

  const cellFor = (p, day) => (dayCells.get(p.name) || RT_NO_DAYS).get(day) || null;

  const swingForDay = (d) => spine.find((s) => s.on <= d && d < s.off) || null;

  const months = useMemo(() => {
    const out = [];
    days.forEach((d) => {
      const label = new Date(d + "T00:00:00").toLocaleDateString("en-AU", { month: "short", year: "2-digit" });
      const last = out[out.length - 1];
      if (last && last.label === label) last.n++;
      else out.push({ label, n: 1 });
    });
    return out;
  }, [days]);

  /* One pair of handlers for the table instead of a pair on each of its
     twenty thousand cells: the square under the pointer says which day it is,
     and the line it sits on says whose day it is. */
  const peopleByName = useMemo(() => {
    const m = new Map();
    blocks.forEach((g) => g.people.forEach((p) => m.set(p.name, p)));
    return m;
  }, [blocks]);

  // The lines and the days in the order they are drawn, so a block picked out
  // can be held as two corners rather than a list of squares.
  const flatNames = useMemo(() => {
    const out = [];
    blocks.forEach((g) => g.people.forEach((p) => out.push(p.name)));
    return out;
  }, [blocks]);
  const flatAt = useMemo(() => new Map(flatNames.map((n, i) => [n, i])), [flatNames]);
  const dayAt = useMemo(() => new Map(days.map((d, i) => [d, i])), [days]);

  const picked = useRef(null);   // the block standing picked out
  const picking = useRef(null);  // the block being swept out under the hand
  const live = useRef({});
  live.current = { days, flatNames, onDeleteRange, onStint };

  /* The tint is laid on the squares themselves rather than kept as something
     the table is drawn from. Sweeping a block out touches only the squares at
     its edges; drawing the table again for every square the hand passes over
     would be twenty thousand squares a step. */
  const paintPick = (sel) => {
    const root = frame.current;
    if (!root) return;
    root.querySelectorAll("td.um-tl-p").forEach((td) => td.classList.remove("um-tl-p"));
    if (!sel) return;
    for (let i = sel.i0; i <= sel.i1; i++) {
      const tr = root.querySelector('tr[data-i="' + i + '"]');
      if (!tr) continue;
      const lead = tr.cells.length - days.length;
      for (let k = sel.k0; k <= sel.k1; k++) {
        const td = tr.cells[lead + k];
        if (td) td.classList.add("um-tl-p");
      }
    }
  };

  /* A run of days marked out down the page, to follow a column by eye. It is
     a guide and nothing else - it holds nothing and deletes nothing. Like the
     picked block, it is laid on the squares themselves, since drawing the
     table again for every day the hand passes over is not something a hand
     can wait for. */
  const ruled = useRef(null);
  const ruling = useRef(null);

  const paintCols = (sel) => {
    const root = frame.current;
    if (!root) return;
    root.querySelectorAll(".um-tl-col, .um-tl-col-a, .um-tl-col-z")
      .forEach((el) => el.classList.remove("um-tl-col", "um-tl-col-a", "um-tl-col-z"));
    if (!sel) return;
    const mark = (el, k) => {
      el.classList.add("um-tl-col");
      if (k === sel.k0) el.classList.add("um-tl-col-a");
      if (k === sel.k1) el.classList.add("um-tl-col-z");
    };
    root.querySelectorAll("th[data-k]").forEach((th) => {
      const k = Number(th.getAttribute("data-k"));
      if (k >= sel.k0 && k <= sel.k1) mark(th, k);
    });
    const body = root.querySelector("table tbody");
    if (!body) return;
    for (const tr of body.rows) {
      if (!tr.hasAttribute("data-i")) continue;
      const lead = tr.cells.length - days.length;
      for (let k = sel.k0; k <= sel.k1; k++) {
        const td = tr.cells[lead + k];
        if (td) mark(td, k);
      }
    }
  };

  const headDown = (e) => {
    const th = e.target && e.target.closest ? e.target.closest("th[data-k]") : null;
    if (!th) return;
    e.preventDefault();
    const k = Number(th.getAttribute("data-k"));
    if (isNaN(k)) return;
    // The same single day pressed again puts the guide away.
    const had = ruled.current;
    if (had && had.k0 === k && had.k1 === k) {
      ruled.current = null;
      paintCols(null);
      return;
    }
    ruling.current = { k0: k, k };
    paintCols({ k0: k, k1: k });
  };

  const headOver = (e) => {
    const r = ruling.current;
    if (!r) return;
    const th = e.target && e.target.closest ? e.target.closest("th[data-k]") : null;
    if (!th) return;
    const k = Number(th.getAttribute("data-k"));
    if (isNaN(k) || k === r.k) return;
    r.k = k;
    paintCols({ k0: Math.min(r.k0, k), k1: Math.max(r.k0, k) });
  };

  const spread = (s) => ({
    i0: Math.min(s.i0, s.i), i1: Math.max(s.i0, s.i),
    k0: Math.min(s.k0, s.k), k1: Math.max(s.k0, s.k),
  });

  React.useEffect(() => {
    const up = () => {
      const r = ruling.current;
      if (r) {
        ruling.current = null;
        ruled.current = { k0: Math.min(r.k0, r.k), k1: Math.max(r.k0, r.k) };
      }
      const s = picking.current;
      if (!s) return;
      picking.current = null;
      if (!s.moved) {
        // A press that went nowhere is the plain click it has always been.
        paintPick(null);
        if (s.row) live.current.onStint(s.row);
        return;
      }
      picked.current = spread(s);
      paintPick(picked.current);
    };
    const key = (e) => {
      if (e.key === "Escape" && ruled.current) { ruled.current = null; paintCols(null); }
      const sel = picked.current;
      if (!sel) return;
      if (e.key === "Escape") { picked.current = null; paintPick(null); return; }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = e.target;
      const tag = el && el.tagName ? el.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select" || (el && el.isContentEditable)) return;
      e.preventDefault();
      const L = live.current;
      const names = new Set();
      for (let i = sel.i0; i <= sel.i1; i++) if (L.flatNames[i]) names.add(L.flatNames[i]);
      const from = L.days[sel.k0], to = L.days[sel.k1];
      picked.current = null;
      paintPick(null);
      if (names.size && from && to && L.onDeleteRange) L.onDeleteRange(names, from, to);
    };
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key);
    };
  }, []);

  const cellUnder = (e) => {
    const td = e.target && e.target.closest ? e.target.closest("td[data-d]") : null;
    if (!td || !td.parentElement) return null;
    const p = peopleByName.get(td.parentElement.getAttribute("data-p") || "");
    return p ? { td, p, d: td.getAttribute("data-d") } : null;
  };

  const freeSwing = (p, d) => {
    const sw = swingForDay(d);
    if (!sw) return null;
    const taken = p.stints.some((st) =>
      (st.swing && st.swing === swingKeyOf(sw)) || (st.on < sw.off && st.off > sw.on));
    return taken ? null : sw;
  };

  const tableDown = (e) => {
    if (!admin) return;
    const at = cellUnder(e);
    if (!at) return;
    e.preventDefault();
    if (picked.current) { picked.current = null; paintPick(null); }
    const c = cellFor(at.p, at.d);
    // Held by the middle of a bar, or with shift down, the hand picks days out
    // instead of moving them; the two ends still move the day they stand for.
    if (e.shiftKey || (c && !c.edge)) {
      const i = Number(at.td.parentElement.getAttribute("data-i"));
      const k = dayAt.get(at.d);
      if (i >= 0 && k !== undefined) {
        picking.current = { i0: i, k0: k, i, k, row: c ? c.row : null, moved: false };
        paintPick({ i0: i, i1: i, k0: k, k1: k });
        return;
      }
    }
    if (c) setDrag({ kind: c.edge || "mid", row: c.row, from: at.d, at: at.d });
    else setDrag({ kind: "new", person: at.p, anchor: at.d, at: at.d, swing: freeSwing(at.p, at.d) });
  };

  // What a square says is written when it is pointed at, so twenty thousand
  // sentences are never written out for the one that gets read.
  const tableOver = (e) => {
    const at = cellUnder(e);
    if (!at) return;
    const s = picking.current;
    if (s) {
      const i = Number(at.td.parentElement.getAttribute("data-i"));
      const k = dayAt.get(at.d);
      if (i < 0 || k === undefined || (i === s.i && k === s.k)) return;
      s.i = i; s.k = k; s.moved = true;
      paintPick(spread(s));
      return;
    }
    const c = cellFor(at.p, at.d);
    if (c) {
      at.td.title = at.p.name + " · " + fmtDate(at.d) + " · " + c.word
        + (c.edge ? " — drag to change the day"
          : admin ? " — drag to pick days out, then Delete" : "");
    } else if (admin) {
      const sw = freeSwing(at.p, at.d);
      at.td.title = "Drag across the days to put " + at.p.name + " on"
        + (sw ? ", or click for " + fmtDate(sw.on) + " – " + fmtDate(sw.off) : "");
    }
    if (drag) setDrag((x) => {
      if (!x || x.at === at.d) return x;
      if (x.kind === "new" && x.person.name !== at.p.name) return x;
      return { ...x, at: at.d };
    });
  };

  const swatch = (bg, word) => (
    <span key={word} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 12, height: 12, borderRadius: 2, background: bg, flex: "none" }} />
      <span style={{ fontFamily: T.body, fontSize: 12, color: T.muted }}>{word}</span>
    </span>
  );

  const headCell = { fontFamily: T.display, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
    textTransform: "uppercase", color: T.muted, textAlign: "left", padding: "3px 5px" };

  const groupCell = { fontFamily: T.display, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.09em",
    textTransform: "uppercase", color: T.accent, background: T.raised, padding: "4px 5px",
    borderTop: "1px solid " + T.rule, whiteSpace: "nowrap" };

  return (
    <div style={{ background: T.panel, border: "1px solid " + T.rule, borderRadius: 2,
      padding: "13px 15px", marginBottom: 0 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        {swatch(RT_ON, "Sign on")}
        {swatch(RT_BOARD, "On board")}
        {swatch(RT_OFF, "Sign off")}
        {swatch(T.bRed, "Changed day")}
        {swatch(RT_RELIEF, "Relief / cover")}
      </div>

      <div className={"um-timeline" + (drag ? " um-tl-drag" : "") + (admin ? " um-tl-can" : "")}
        ref={frame} style={tallest ? { maxHeight: tallest } : undefined}>
        <table onMouseDown={tableDown} onMouseOver={tableOver}>
          <thead>
            <tr className="um-tl-r1">
              <th className="um-tl-crew" style={{ width: 52, minWidth: 52 }} />
              <th className="um-tl-rank" style={{ width: 100, minWidth: 100 }} />
              <th className="um-tl-name" style={{ width: 190, minWidth: 190 }} />
              {months.map((m) => (
                <th key={m.label} colSpan={m.n} style={{ fontFamily: T.display, fontSize: 10.5,
                  fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: T.accent,
                  borderBottom: "1px solid " + T.rule, borderLeft: "1px solid " + T.rule,
                  height: 22, boxSizing: "border-box", padding: "3px 0",
                  textAlign: "left", paddingLeft: 5, whiteSpace: "nowrap" }}>
                  {m.label}
                </th>
              ))}
            </tr>
            <tr className="um-tl-r2" onMouseDown={headDown} onMouseOver={headOver}>
              <th className="um-tl-rank um-tl-rankwide" colSpan={2} rowSpan={2}
                style={{ ...headCell, width: 152, minWidth: 152 }}>Rank</th>
              <th className="um-tl-name" rowSpan={2} style={{ ...headCell, width: 190, minWidth: 190 }}>Name</th>
              {days.map((d, k) => (
                <th key={d} data-k={k} className={d === today ? "um-daygrid-today" : ""}
                  style={{ width: RT_CELL, minWidth: RT_CELL, height: 12, fontFamily: T.mono, fontSize: 8,
                    color: T.muted, padding: 0, fontWeight: 400, lineHeight: "12px" }} title={fmtDate(d)}>
                  {Number(d.slice(8))}
                </th>
              ))}
            </tr>
            <tr className="um-tl-r3" onMouseDown={headDown} onMouseOver={headOver}>
              {days.map((d, k) => {
                const wd = new Date(d + "T00:00:00").getDay();
                const end = wd === 0 || wd === 6;
                return (
                  <th key={d} data-k={k} className={d === today ? "um-daygrid-today" : ""}
                    style={{ width: RT_CELL, minWidth: RT_CELL, height: 12, fontFamily: T.mono, fontSize: 8,
                      color: end ? T.accent : T.muted, padding: 0, fontWeight: end ? 700 : 400,
                      lineHeight: "12px", borderBottom: "1px solid " + T.rule }} title={fmtDate(d)}>
                    {"SMTWTFS"[wd]}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {blocks.map((g, gi) => (
              <React.Fragment key={g.label + gi}>
                <tr>
                  {g.relief ? (
                    <td className="um-tl-crew" colSpan={3}
                      style={{ ...groupCell, boxShadow: "inset -1px 0 0 " + T.rule }}>Relief / cover</td>
                  ) : (
                    <td className="um-tl-crew" colSpan={3}
                      style={{ ...groupCell, boxShadow: "inset -1px 0 0 " + T.rule }}>{g.label}</td>
                  )}
                  <td colSpan={days.length} style={{ background: T.raised, borderTop: "1px solid " + T.rule }} />
                </tr>
                {g.people.map((p) => {
                  const mine = dayCells.get(p.name) || RT_NO_DAYS;
                  return (
                  <tr key={p.name} className="um-row" data-p={p.name} data-i={flatAt.get(p.name)}>
                    <td className="um-tl-rank um-tl-rankwide" colSpan={2}
                      style={{ fontFamily: T.mono, fontSize: 10, color: T.muted,
                      padding: "2px 5px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      maxWidth: 152, borderTop: "1px solid " + T.rule }}>
                      {p.no}. {(g.relief && roleCovered(p.name)) || p.rank}
                    </td>
                    <td className="um-tl-name"
                      onClick={admin ? () => onPerson(p) : undefined}
                      title={admin ? "Open " + p.name : undefined}
                      style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600,
                      color: T.text, padding: "2px 5px", whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis", maxWidth: 190, borderTop: "1px solid " + T.rule,
                      cursor: admin ? "pointer" : undefined }}>{p.name}</td>
                    {days.map((d) => {
                      const c = mine.get(d);
                      let cls = c ? (c.edge ? "um-tl-d um-tl-f um-tl-g" : "um-tl-d um-tl-f") : "um-tl-d";
                      if (d === today) cls += " um-daygrid-today";
                      return (
                        <td key={d} className={cls} data-d={d}
                          style={c ? bgOf(c.bg) : (!c && sweeping(p, d)) ? bgOf(RT_ON) : undefined} />
                      );
                    })}
                  </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* Somebody new to the roster, put straight onto a swing — chosen off the crew
   list, or typed in for a relief hand the matrix doesn't carry. */
/* Where the roster is short a hand.
 *
 * A gap is a day when a crew has fewer of a rank aboard than that crew
 * usually carries. "Usually" is the roster's own answer, not a number typed
 * in somewhere: for each crew and rank, the commonest daily strength across
 * all of that crew's swings. A rank the crew mostly does without is therefore
 * not missing when it is absent, and one that is always two is short the day
 * it is one.
 *
 * Only swings still to come are looked at - a gap in a swing already sailed
 * is history, not work.
 */
function rosterGaps(plan) {
  const spine = (plan && plan.spine) || [];
  const rows = (plan && plan.rows) || [];
  if (!spine.length || !rows.length) return [];
  const today = todayISO();

  const rankOf = (r) => String(r.rank || "").replace(/\s+/g, " ").trim().toUpperCase() || "(no rank)";
  const crewKey = (sp) => String(sp.crew || "").trim().toUpperCase();

  // Which crew each hand belongs to, by the weight of their own days.
  const weight = new Map();
  rows.forEach((r) => {
    const c = String(r.crew || "").trim().toUpperCase();
    if (c !== "ALPHA" && c !== "BRAVO") return;
    if (!weight.has(r.name)) weight.set(r.name, {});
    const t = weight.get(r.name);
    t[c] = (t[c] || 0) + 1;
  });
  const crewOf = new Map();
  weight.forEach((t, name) => crewOf.set(name, Object.keys(t).sort((a, b) => t[b] - t[a])[0]));

  const ranks = [...new Set(rows.map(rankOf))];
  const aboardOn = (d) => rows.filter((r) => r.on <= d && d <= r.off);
  const countOn = (d) => {
    const c = {};
    ranks.forEach((k) => { c[k] = 0; });
    aboardOn(d).forEach((r) => { c[rankOf(r)] = (c[rankOf(r)] || 0) + 1; });
    return c;
  };

  // Every day of every swing, counted once and kept.
  const daysOf = (sp) => {
    const out = [];
    let d = sp.on, guard = 0;
    while (d <= sp.off && guard++ < 900) { out.push(d); d = isoShift(d, 1); }
    return out;
  };
  const seen = new Map();
  spine.forEach((sp) => daysOf(sp).forEach((d) => { if (!seen.has(d)) seen.set(d, countOn(d)); }));

  // What each crew usually carries: the commonest daily strength per rank.
  const spread = new Map();
  spine.forEach((sp) => {
    const crew = crewKey(sp);
    if (crew !== "ALPHA" && crew !== "BRAVO") return;
    daysOf(sp).forEach((d) => {
      const c = seen.get(d) || {};
      ranks.forEach((k) => {
        const key = crew + "|" + k;
        if (!spread.has(key)) spread.set(key, {});
        const t = spread.get(key);
        const n = c[k] || 0;
        t[n] = (t[n] || 0) + 1;
      });
    });
  });
  const usual = new Map();
  spread.forEach((t, key) => {
    const best = Object.keys(t).map(Number).sort((a, b) => t[b] - t[a] || b - a)[0];
    usual.set(key, best || 0);
  });

  // Who is standing in for whom, so an absence with cover reads differently.
  const coversWho = new Map();
  rows.forEach((r) => { if (r.covers) coversWho.set(r.name, r.covers); });

  const found = [];
  spine.filter((sp) => sp.off > today).sort((a, b) => a.on.localeCompare(b.on)).forEach((sp) => {
    const crew = crewKey(sp);
    if (crew !== "ALPHA" && crew !== "BRAVO") return;
    const days = daysOf(sp);
    ranks.forEach((k) => {
      const want = usual.get(crew + "|" + k) || 0;
      if (!want) return;
      // Contiguous runs of days short of that strength.
      let run = null;
      const close = () => {
        if (!run) return;
        // Who of this crew, at this rank, is not aboard on the first short day.
        const there = new Set(aboardOn(run.from).map((r) => r.name));
        const away = [...new Set(rows.filter((r) => rankOf(r) === k && crewOf.get(r.name) === crew)
          .map((r) => r.name))].filter((nm) => !there.has(nm));
        const helped = away.filter((nm) => [...coversWho.entries()].some(([who, forWhom]) =>
          forWhom === nm && there.has(who)));
        found.push({ ...run, crew, rank: k, want, swing: sp, away, helped });
        run = null;
      };
      days.forEach((d) => {
        const have = (seen.get(d) || {})[k] || 0;
        if (have < want) {
          if (run && run.have === have) run.to = d;
          else { close(); run = { from: d, to: d, have }; }
        } else close();
      });
      close();
    });
  });
  return found;
}

function RosterNewPerson({ names, positions, spine, onRoster, onAdd, onClose }) {
  const [who, setWho] = useState("");
  const [typed, setTyped] = useState("");
  const [rank, setRank] = useState("GPH");
  const [covers, setCovers] = useState("");
  const [swingKey, setSwingKey] = useState(() => {
    const today = todayISO();
    const here = spine.find((s) => s.on <= today && today < s.off) || spine[0];
    return here ? here.on + "|" + here.off : "";
  });
  const swing = spine.find((s) => s.on + "|" + s.off === swingKey) || null;
  const name = typed.trim() ? canonicalName(typed.trim()) : who;
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 200px" }}>
        <Field label="Who">
          <select className="um-in" value={who} onChange={(e) => { setWho(e.target.value); setTyped(""); }}>
            <option value="">Choose…</option>
            {names.map((n) => (
              <option key={n} value={n}>{n}{positions[n] ? " — " + positions[n] : ""}</option>
            ))}
          </select>
        </Field>
      </div>
      <div style={{ flex: "1 1 170px" }}>
        <Field label="Or type a name">
          <input className="um-in" value={typed} placeholder="First name and surname"
            onChange={(e) => { setTyped(e.target.value); if (e.target.value.trim()) setWho(""); }} />
        </Field>
      </div>
      {typed.trim() !== "" && (
        <div style={{ flex: "0 1 170px" }}>
          <Field label="Rank">
            <select className="um-in" value={rank} onChange={(e) => setRank(e.target.value)}>
              {ROSTER_RANKS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        </div>
      )}
      <div style={{ flex: "1 1 200px" }}>
        <Field label="Covering for">
          <select className="um-in" value={covers} onChange={(e) => setCovers(e.target.value)}>
            <option value="">Nobody — a swing of their own</option>
            {(onRoster || []).filter((p) => p.name !== name).map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <div style={{ flex: "1 1 200px" }}>
        <Field label="Swing">
          <select className="um-in" value={swingKey} onChange={(e) => setSwingKey(e.target.value)}>
            {spine.map((s) => (
              <option key={s.on + "|" + s.off} value={s.on + "|" + s.off}>
                {fmtDate(s.on)} – {fmtDate(s.off)}{s.crew ? " · " + s.crew : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Button writes variant="ghost" disabled={!name || !swing}
        onClick={() => onAdd({ name, rank: typed.trim() ? rank : rosterRankFor(positions[who] || ""),
          crew: swing.crew, on: swing.on, off: swing.off, key: swingKey, covers })}>
        Onto the swing
      </Button>
      <Button variant="quiet" onClick={onClose}>Cancel</Button>
    </div>
  );
}

/* The Roster: the portal's own, seeded from the office's workbook and changed
   on the table itself from then on. */
function RosterListPage() {
  const { admin, crewRoster, setCrewRoster, rosterPlan, setRosterPlan, quals: QUALS, log, role } = usePortal();
  const [savingRoster, setSavingRoster] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [tableEdit, setTableEdit] = useState(null);
  /* Which way the roster is read. Rank is the order the vessel is manned in and
     the way it is read when the question is who covers what; surname is the way
     it is read when the question is where one particular person is. Remembered,
     because whichever somebody uses they use every time. */
  const [sortBy, setSortBy] = useRemembered("roster-sort", "rank",
    (v) => v === "rank" || v === "name");
  const asked = useRef(false);

  const names = useMemo(() => QUALS.rows.map((r) => r[0]), [QUALS]);
  const positions = useMemo(() => Object.fromEntries(QUALS.rows.map((r) => [r[0], r[1] || ""])), [QUALS]);

  /* The crew matrix writes a name the other way about - "KEELEY, Finn" where
     the roster says "FINN KEELEY" - so the two are matched on the words they
     share rather than letter for letter. Two words must agree before anyone
     is called a match, and where two people on the matrix fit equally well
     nobody is chosen: a rank guessed wrong is worse than a rank left blank. */
  const matrixRank = useMemo(() => {
    const wordsOf = (t) => String(t || "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
    const held = QUALS.rows.map((r) => ({ words: wordsOf(r[0]), position: r[1] || "" }));
    return (who) => {
      const want = new Set(wordsOf(who));
      let best = null, tied = false;
      for (const one of held) {
        const shared = one.words.filter((w) => want.has(w)).length;
        if (shared < 2) continue;
        if (!best || shared > best.shared) { best = { shared, position: one.position }; tied = false; }
        else if (shared === best.shared) tied = true;
      }
      return best && !tied ? rosterRankFor(best.position) : "";
    };
  }, [QUALS]);

  /* Reading the spreadsheet again takes the office's word for everything it
     has to say - but a hand put on here that the spreadsheet has never heard
     of is not something it has anything to say about, and used to be lost.
     Those stay. They are only gone when somebody takes them off, which is
     what Remove from the roster is for.

     A hand the spreadsheet does know is left to the spreadsheet: it is the
     office's document, and on those it has the last word. Saving the roster
     writes everyone into it, so after a save there is nothing left to carry. */
  const load = async (why) => {
    if (!crewRoster || !crewRoster.url || busy) return;
    setBusy(true); setErr("");
    try {
      const plan = await readCrewRoster(crewRoster);
      const held = (rosterPlan && rosterPlan.rows) || [];
      const inSheet = new Set(plan.rows.map((r) => r.name));
      const ours = held.filter((r) => r.source === "portal" && !inSheet.has(r.name));
      if (ours.length) {
        plan.rows = [...plan.rows, ...ours];
        plan.rows.forEach((r, i) => { if (!r.id) r.id = "r" + (i + 1); });
        plan.spine = plan.spine || [];
        plan.edited = true;
        plan.updatedAt = todayISO();
      }
      setRosterPlan(plan);
      const kept = new Set(ours.map((r) => r.name));
      if (why === "pressed") {
        log("Roster", "Roster loaded from the spreadsheet",
          crewRoster.filename + " · " + plan.rows.length + " swing entries"
          + (kept.size ? " · kept " + [...kept].join(", ") + ", added here" : ""));
      }
    } catch (e) {
      setErr(e.message || String(e));
    }
    setBusy(false);
  };

  // The workbook seeds the roster exactly once — a roster already held is
  // never overwritten without the button below being pressed.
  React.useEffect(() => {
    if (asked.current || rosterPlan || !crewRoster || !crewRoster.url) return;
    asked.current = true;
    load("opened");
  }, [rosterPlan, crewRoster]);

  const change = (mutate, what, detail) => {
    setRosterPlan((plan) => {
      if (!plan) return plan;
      const next = {
        ...plan,
        rows: (plan.rows || []).map((r, i) => (r.id ? r : { ...r, id: "r" + (i + 1) })),
        edited: true,
        updatedAt: todayISO(),
      };
      mutate(next);
      return next;
    });
    if (what) log("Roster", what, detail || "");
  };

  const setDates = (row, s, on, off) => {
    if (!on || !off || off <= on) return;
    if (on === row.on && off === row.off) return;
    change((p) => {
      p.rows = p.rows.map((r) => (r.id === row.id
        ? { ...r, on, off, days: daysBetween(on, off), note: "", swing: r.swing || (s && s.key) || null }
        : r));
    }, row.name + "'s days changed", "signs on " + fmtDate(on) + ", off " + fmtDate(off));
  };

  // Days swept out on the table become a stint of exactly those days, tied to
  // whichever swing they start in.
  const addRange = (p, on, off) => {
    const s = ((rosterPlan && rosterPlan.spine) || []).find((x) => x.on <= on && on < x.off) || null;
    change((plan) => {
      // Days swept out for a hand already standing in for somebody are still
      // days standing in for them, so the marking comes along.
      const standingIn = (plan.rows.find((r) => r.name === p.name && r.covers) || {}).covers || "";
      plan.rows = [...plan.rows, {
        id: "r" + Date.now(), source: "portal", covers: standingIn,
        crew: (s && s.crew) || p.crew || "", rank: p.rank, name: p.name,
        on, off, days: daysBetween(on, off), note: "", swing: s ? swingKeyOf(s) : null,
      }];
    }, p.name + " onto the roster", fmtDate(on) + " – " + fmtDate(off));
  };

  /* Days picked out on the table and taken off. A stint that sits wholly
     inside the block goes; one that runs past an edge is trimmed back to it;
     and a block punched through the middle of a stint leaves the two ends
     behind, as two stints. */
  const deleteRange = (names, from, to) => {
    change((plan) => {
      const out = [];
      plan.rows.forEach((r) => {
        if (!names.has(r.name) || r.off < from || r.on > to) { out.push(r); return; }
        const left = r.on < from, right = r.off > to;
        if (!left && !right) return;
        if (left) {
          const off = isoShift(from, -1);
          out.push({ ...r, off, days: daysBetween(r.on, off), note: "" });
        }
        if (right) {
          const on = isoShift(to, 1);
          out.push({ ...r, id: left ? "r" + Date.now() + "x" + out.length : r.id,
            on, days: daysBetween(on, r.off), note: "" });
        }
      });
      plan.rows = out;
    }, "Days taken off the roster",
      fmtDate(from) + " – " + fmtDate(to) + " · " + [...names].join(", "));
  };

  // Everyone the roster carries, and which crew their own days say they are
  // in - the same reckoning the table groups them by, so the list and the
  // blocks can never disagree about where somebody stands.
  const onRoster = useMemo(() => {
    const tallies = new Map();
    ((rosterPlan && rosterPlan.rows) || []).forEach((r) => {
      if (!tallies.has(r.name)) tallies.set(r.name, {});
      const t = tallies.get(r.name);
      const c = String(r.crew || "").trim().toUpperCase() || "OTHER";
      t[c] = (t[c] || 0) + 1;
    });
    return [...tallies.entries()]
      .map(([name, t]) => ({ name, crew: Object.keys(t).sort((a, b) => t[b] - t[a])[0] || "OTHER" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rosterPlan]);

  const crewOf = (name) => (onRoster.find((p) => p.name === name) || {}).crew || "OTHER";

  // A crew member in the wrong team moves across with their days intact -
  // every swing they hold changes crew with them, rather than being taken off
  // the roster and put back on.
  const moveCrew = (name, crew) => {
    change((plan) => {
      plan.rows = plan.rows.map((r) => (r.name === name ? { ...r, crew } : r));
    }, name + " moved to " + swingCrewWord(crew) + " crew");
  };

  const dropPerson = (row) => {
    change((p) => { p.rows = p.rows.filter((r) => r.id !== row.id); },
      row.name + " off the swing", fmtDate(row.on) + " – " + fmtDate(row.off));
  };

  const removePerson = (name) => {
    change((p) => { p.rows = p.rows.filter((r) => r.name !== name); },
      name + " removed from the roster");
  };

  // Everything as it stands, written into the workbook and filed back to
  // SharePoint - the same file, replaced, with every other sheet untouched.
  const saveRoster = async () => {
    if (!crewRoster || !crewRoster.url || !rosterPlan || savingRoster) return;
    setSavingRoster(true); setErr("");
    try {
      const record = await fileRosterWorkbook(crewRoster, rosterPlan, role);
      if (record) setCrewRoster(record);
      setRosterPlan((p) => (p ? { ...p, edited: false, filename: crewRoster.filename, savedAt: todayISO() } : p));
      log("Roster", "Roster saved to the spreadsheet", crewRoster.filename);
    } catch (e) {
      setErr(e.message || String(e));
    }
    setSavingRoster(false);
  };

  const addNamed = (t) => {
    change((p) => {
      p.rows = [...p.rows, {
        id: "r" + Date.now(), source: "portal",
        crew: t.crew, rank: t.rank, name: t.name, covers: t.covers || "",
        on: t.on, off: t.off, days: daysBetween(t.on, t.off), note: "", swing: t.key,
      }];
    }, t.name + " onto the swing", fmtDate(t.on) + " – " + fmtDate(t.off));
  };

  if (!crewRoster && !rosterPlan) {
    return (
      <>
        <SectionHead title="Roster" />
        <Empty>No crew roster is on file. Upload it under Documents.</Empty>
      </>
    );
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <SectionHead title="Roster"
          meta={rosterPlan
            ? ((rosterPlan.spine || []).length + " swings · " + (rosterPlan.edited
                ? "held on the portal · changed " + fmtDate(rosterPlan.updatedAt || rosterPlan.at)
                : (rosterPlan.filename || "")))
            : (crewRoster ? crewRoster.filename : "")} />
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
          {rosterPlan && (
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted,
                textTransform: "uppercase", letterSpacing: "0.08em" }}>Sort by</span>
              <NameSelect value={sortBy} onPick={setSortBy} width={150} options={[
                { value: "rank", label: "Rank" },
                { value: "name", label: "Surname" },
              ]} />
            </span>
          )}
          {admin && rosterPlan && crewRoster && (
            <Button writes disabled={savingRoster || !rosterPlan.edited} onClick={saveRoster}>
              {savingRoster ? "Saving…" : "Save roster"}
            </Button>
          )}
          {admin && rosterPlan && (
            <Button writes onClick={() => setTableEdit(tableEdit && tableEdit.kind === "new" ? null : { kind: "new" })}>
              Add crew member
            </Button>
          )}
          {admin && rosterPlan && (
            <Button variant="quiet" writes
              onClick={() => setTableEdit(tableEdit && tableEdit.kind === "pick" ? null : { kind: "pick" })}>
              Move or remove crew
            </Button>
          )}
          {rosterPlan && (
            <Button variant="quiet"
              onClick={() => setTableEdit(tableEdit && tableEdit.kind === "gaps" ? null : { kind: "gaps" })}>
              Find gaps
            </Button>
          )}
          {admin && crewRoster && (confirmLoad ? (
            <>
              <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed }}>
                Replace the roster with the spreadsheet? Crew added here are kept; other changes are not.
              </span>
              <Button writes onClick={() => { setConfirmLoad(false); load("pressed"); }}>Replace it</Button>
              <Button variant="quiet" onClick={() => setConfirmLoad(false)}>Keep as is</Button>
            </>
          ) : (
            <Button variant="quiet" writes disabled={busy}
              onClick={() => (rosterPlan && rosterPlan.edited ? setConfirmLoad(true) : load("pressed"))}>
              {busy ? "Reading…" : "Load from the spreadsheet"}
            </Button>
          ))}
        </span>
      </div>

      {err && (
        <div style={{ background: T.panel, border: "1px solid " + T.rule, borderLeft: "4px solid " + T.bRed,
          borderRadius: 2, padding: "12px 15px", marginBottom: 12, fontFamily: T.body, fontSize: 13, color: T.text }}>
          {err}
        </div>
      )}

      {!rosterPlan && !err && <Empty>{busy ? "Reading the roster…" : "The roster hasn't been loaded yet."}</Empty>}

      {rosterPlan && (
        <RosterTimeline plan={rosterPlan} admin={admin} sortBy={sortBy}
          onPerson={(p) => setTableEdit({ kind: "person", name: p.name })}
          onStint={(row) => setTableEdit({ kind: "stint", id: row.id, name: row.name, on: row.on })}
          onDates={(row, on, off) => setDates(row, { key: row.swing }, on, off)}
          onRange={addRange}
          onDeleteRange={deleteRange}
          rankFor={matrixRank}
          onBlank={(p, s) => setTableEdit({ kind: "add", name: p.name, rank: p.rank, crew: s.crew,
            on: s.on, off: s.off, key: s.on + "|" + s.off })} />
      )}

      {(admin || (tableEdit && tableEdit.kind === "gaps")) && tableEdit && (() => {
        const rows = (rosterPlan && rosterPlan.rows) || [];
        const row = tableEdit.kind === "stint"
          ? rows.find((r) => (tableEdit.id ? r.id === tableEdit.id : r.name === tableEdit.name && r.on === tableEdit.on)) || null
          : null;
        if (tableEdit.kind === "stint" && !row) return null;
        return (
          <div style={{ position: "fixed", left: "50%", top: 90, transform: "translateX(-50%)", zIndex: 80,
            background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.accent,
            borderRadius: 3, padding: "14px 18px", boxShadow: "0 6px 24px rgba(18,41,61,0.25)",
            width: "min(620px, 94vw)" }}>
            {tableEdit.kind === "gaps" ? (() => {
              const gaps = rosterGaps(rosterPlan);
              return (
                <>
                  <div style={{ fontFamily: T.display, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>
                    {gaps.length ? gaps.length + " gap" + (gaps.length === 1 ? "" : "s") + " on the roster" : "No gaps on the roster"}
                  </div>
                  <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, marginBottom: 12 }}>
                    A day a crew is short of a rank it usually carries, swings still to come only.
                  </div>
                  <div style={{ maxHeight: "46vh", overflowY: "auto", marginBottom: 12 }}>
                    {gaps.map((g, i) => (
                      <div key={i} style={{ fontFamily: T.body, fontSize: 13, color: T.text,
                        padding: "7px 0", borderTop: i ? "1px solid " + T.rule : "none", lineHeight: 1.6 }}>
                        <span style={{ fontWeight: 700 }}>
                          {g.from === g.to ? fmtDate(g.from) : fmtDate(g.from) + " – " + fmtDate(g.to)}
                        </span>
                        {" · " + swingCrewWord(g.crew) + " · "}
                        <span style={{ fontFamily: T.mono, fontSize: 11.5 }}>{g.rank}</span>
                        {" — " + g.have + " aboard where " + g.want + " is usual."}
                        {g.away.length > 0 && (
                          <span style={{ color: T.muted }}>
                            {" Away: " + g.away.join(", ") + "."}
                            {g.helped.length > 0 && " Covered: " + g.helped.join(", ") + "."}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  <Button onClick={() => setTableEdit(null)}>Close</Button>
                </>
              );
            })() : tableEdit.kind === "pick" ? (
              <>
                <div style={{ fontFamily: T.display, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 10 }}>
                  Move or remove crew
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <Field label="Crew member">
                    <select className="um-in" defaultValue=""
                      onChange={(e) => e.target.value && setTableEdit({ kind: "person", name: e.target.value })}>
                      <option value="">Choose…</option>
                      {onRoster.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name} — {swingCrewWord(p.crew)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button variant="quiet" onClick={() => setTableEdit(null)}>Cancel</Button>
                </div>
              </>
            ) : tableEdit.kind === "person" ? (() => {
              const now = crewOf(tableEdit.name);
              const other = now === "ALPHA" ? "BRAVO" : "ALPHA";
              return (
                <>
                  <div style={{ fontFamily: T.display, fontSize: 15, fontWeight: 700, color: T.text }}>
                    {tableEdit.name}
                  </div>
                  <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, marginBottom: 12 }}>
                    {swingCrewCalled(now)}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Button writes variant="ghost"
                      onClick={() => { moveCrew(tableEdit.name, other); setTableEdit(null); }}>
                      Move to {swingCrewWord(other)} crew
                    </Button>
                    <span style={{ flex: 1 }} />
                    {tableEdit.sure ? (
                      <>
                        <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed }}>
                          Take {tableEdit.name} off every swing on the roster?
                        </span>
                        <Button writes onClick={() => { removePerson(tableEdit.name); setTableEdit(null); }}>
                          Remove them
                        </Button>
                        <Button variant="quiet" onClick={() => setTableEdit({ ...tableEdit, sure: false })}>
                          Keep them
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button variant="quiet" onClick={() => setTableEdit({ ...tableEdit, sure: true })}>
                          Remove from the roster
                        </Button>
                        <Button onClick={() => setTableEdit(null)}>Close</Button>
                      </>
                    )}
                  </div>
                </>
              );
            })() : tableEdit.kind === "new" ? (
              <RosterNewPerson names={names} positions={positions} spine={(rosterPlan && rosterPlan.spine) || []}
                onRoster={onRoster}
                onAdd={(t) => { addNamed(t); setTableEdit(null); }}
                onClose={() => setTableEdit(null)} />
            ) : tableEdit.kind === "stint" ? (
              <>
                <div style={{ fontFamily: T.display, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 8 }}>
                  {row.name}
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <Field label="Signs on">
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                      <button type="button" className="um-nudge"
                        onClick={() => setDates(row, { key: row.swing }, isoShift(row.on, -1), row.off)}>−</button>
                      <input className="um-in" type="date" value={row.on}
                        onChange={(e) => setDates(row, { key: row.swing }, e.target.value, row.off)} />
                      <button type="button" className="um-nudge"
                        onClick={() => setDates(row, { key: row.swing }, isoShift(row.on, 1), row.off)}>+</button>
                    </span>
                  </Field>
                  <Field label="Signs off">
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                      <button type="button" className="um-nudge"
                        onClick={() => setDates(row, { key: row.swing }, row.on, isoShift(row.off, -1))}>−</button>
                      <input className="um-in" type="date" value={row.off}
                        onChange={(e) => setDates(row, { key: row.swing }, row.on, e.target.value)} />
                      <button type="button" className="um-nudge"
                        onClick={() => setDates(row, { key: row.swing }, row.on, isoShift(row.off, 1))}>+</button>
                    </span>
                  </Field>
                  <Button writes variant="quiet" onClick={() => { dropPerson(row); setTableEdit(null); }}>
                    Off this swing
                  </Button>
                  <Button onClick={() => setTableEdit(null)}>Done</Button>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontFamily: T.body, fontSize: 13.5, color: T.text }}>
                  {tableEdit.name} onto {fmtDate(tableEdit.on)} – {fmtDate(tableEdit.off)}?
                </span>
                <Button writes variant="ghost" onClick={() => { addNamed(tableEdit); setTableEdit(null); }}>Onto this swing</Button>
                <Button variant="quiet" onClick={() => setTableEdit(null)}>Cancel</Button>
              </div>
            )}
          </div>
        );
      })()}
    </>
  );
}

/* The Roster on a page of its own: the same board Swing Compliance carries,
   for when the job is moving crew rather than checking them. The picker holds
   the same six swings the compliance cards do — the live board for the swing
   on now, a coming swing's own board for any other, so ad hoc changes land on
   that swing only. */
/* The swing cards, filled in from the roster when somebody asks for it.
 *
 * Nothing here happens by itself. The roster is the office's working document
 * and moves all day; the allocations are what the compliance checks are read
 * against, so they follow the roster only when management says so, and say so
 * knowing it will overwrite what is there.
 */
function GenerateAllocations({ people, log }) {
  const { rosterPlan, swingDates, setSwingDates, swingBoards, setSwingBoards,
    quals: QUALS, admin } = usePortal();
  const [asking, setAsking] = useState(false);
  const [work, setWork] = useState(null);
  const names = useMemo(() => QUALS.rows.map((r) => r[0]), [QUALS]);

  const spine = (rosterPlan && rosterPlan.spine) || [];
  const ready = admin && spine.length > 0;

  const run = async () => {
    setAsking(false);
    const rows = (rosterPlan && rosterPlan.rows) || [];
    const k0 = currentSwingIndex();
    const ks = Array.from({ length: SWING_LOOKAHEAD + 1 }, (_, i) => k0 + i);

    /* The roster names a person the way the office writes them; the crew list
       names them its own way. Both are matched against the crew matrix, which
       is the one list they are both trying to be, and anybody the matrix
       cannot place is reported rather than guessed at. */
    const byMatrix = new Map();
    people.forEach((p) => { const m = matchRoster(p.name, names); if (m) byMatrix.set(m, p); });
    const personFor = (who) => { const m = matchRoster(who, names); return m ? byMatrix.get(m) || null : null; };

    const dates = { ...(swingDates || {}) };
    const boards = { ...(swingBoards || {}) };
    const strangers = new Set();
    let placed = 0, matchedSwings = 0;

    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      setWork({ pct: Math.round((i / (ks.length + 1)) * 100), note: "Swing " + (i + 1) + " of " + ks.length });
      await new Promise((r) => setTimeout(r, 90));

      // The roster swing sharing the most days with this one.
      const base = swingAt(k);
      let best = null;
      for (const sp of spine) {
        const from = sp.on > base.flyOut ? sp.on : base.flyOut;
        const to = sp.off < base.flyHome ? sp.off : base.flyHome;
        if (to <= from) continue;
        const shared = daysBetween(from, to);
        if (!best || shared > best.shared) best = { sp, shared };
      }
      if (!best) continue;
      const sp = best.sp;
      matchedSwings++;

      const letter = /ALPHA/i.test(sp.crew || "") ? "A" : /BRAVO/i.test(sp.crew || "") ? "B" : null;
      dates[k] = { flyOut: sp.on, flyHome: sp.off, ...(letter ? { crew: letter } : {}) };

      const side = {}, windows = {};
      const aboard = new Set();
      for (const r of rows) {
        if (!(r.on < sp.off && r.off > sp.on)) continue;
        const who = personFor(r.name);
        if (!who) { strangers.add(r.name); continue; }
        side[who.id] = "on";
        aboard.add(who.id);
        // On for part of the swing only - joined late, home early, filling in.
        if (r.on > sp.on || r.off < sp.off) windows[who.id] = { from: r.on, to: r.off };
        placed++;
      }
      people.forEach((p) => { if (p.active && !aboard.has(p.id)) side[p.id] = "off"; });
      boards[k] = { ...(boards[k] || {}), side, window: windows, shift: (boards[k] || {}).shift || {} };
    }

    setWork({ pct: 100, note: "Saving" });
    await new Promise((r) => setTimeout(r, 140));
    setSwingDates(dates);
    setSwingBoards(boards);
    log("Swings", "Swings updated from the roster",
      matchedSwings + " swings · " + placed + " placements"
      + (strangers.size ? " · " + strangers.size + " not on the crew list" : ""));
    setWork({ done: true, pct: 100, swings: matchedSwings, placed, strangers: [...strangers] });
  };

  if (!admin) return null;
  const panel = {
    position: "fixed", left: "50%", top: 120, transform: "translateX(-50%)", zIndex: 90,
    background: T.panel, border: "1px solid " + T.rule, borderTop: "4px solid " + T.accent,
    borderRadius: 3, padding: "16px 20px", boxShadow: "0 6px 24px rgba(18,41,61,0.25)",
    width: "min(560px, 94vw)",
  };

  return (
    <>
      <Button writes disabled={!ready || !!work} onClick={() => setAsking(true)}>
        {work && !work.done ? "Working…" : "Update swings from roster"}
      </Button>

      {asking && (
        <div style={panel}>
          <div style={{ fontFamily: T.display, fontSize: 15, fontWeight: 700, color: T.bRed, marginBottom: 8 }}>
            Warning
          </div>
          <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, marginBottom: 14, lineHeight: 1.6 }}>
            This will possibly alter swing allocations. Do you want to proceed?
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button writes variant="solid" onClick={run}>Yes</Button>
            <Button variant="quiet" onClick={() => setAsking(false)}>No</Button>
          </div>
        </div>
      )}

      {work && (
        <div style={panel}>
          <div style={{ fontFamily: T.display, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 10 }}>
            {work.done ? "Swings updated" : "Updating swings"}
          </div>
          {!work.done && (
            <>
              <div style={{ fontFamily: T.mono, fontSize: 26, color: T.accent, marginBottom: 6 }}>
                {work.pct}%
              </div>
              <div style={{ height: 6, background: T.raised, borderRadius: 3, overflow: "hidden", marginBottom: 10 }}>
                <div style={{ width: work.pct + "%", height: "100%", background: T.accent, transition: "width .2s" }} />
              </div>
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.muted }}>{work.note}</div>
            </>
          )}
          {work.done && (
            <>
              <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.7, marginBottom: 12 }}>
                {work.swings} swing{work.swings === 1 ? "" : "s"} taken from the roster,
                {" "}{work.placed} place{work.placed === 1 ? "" : "s"} filled.
                {work.strangers.length > 0 && (
                  <> Not on the crew list, so left out: {work.strangers.join(", ")}.</>
                )}
              </div>
              <Button onClick={() => setWork(null)}>Close</Button>
            </>
          )}
        </div>
      )}
    </>
  );
}

/* How each requirement verdict the shift allocation check hands back is worn on
   the page. The order is the reading order: where the swing is short first, what
   couldn't be settled next, what is met last. */
const SHIFT_STATUS = {
  "short": { label: "Short", fg: () => T.bRed, bg: () => T.bRedBg, rank: 0 },
  "unclear": { label: "Unclear", fg: () => T.muted, bg: () => T.raised, rank: 1 },
  "met": { label: "Met", fg: () => T.teal, bg: () => T.raised, rank: 2 },
};

/* The two shifts the results are broken up into, and the hours each one runs.
   A requirement the sheet gives as "both" — one number each shift must meet
   alike — is shown under each shift; one the sheet doesn't split at all falls
   to the whole-swing group underneath. */
const SHIFT_GROUP_TAKES = {
  day: (s) => s === "day" || s === "both",
  night: (s) => s === "night" || s === "both",
  swing: (s) => s !== "day" && s !== "night" && s !== "both",
};
// The titles and the hours are the vessel file's; which requirements each
// group takes is the rule above, by the group's id.
const SHIFT_GROUPS = VESSEL.shift.groups.map((g) => ({ ...g, takes: SHIFT_GROUP_TAKES[g.id] }));

/* ==================================================================== */
/*  The office's shift allocation matrix — the positions each shift      */
/*  carries                                                             */
/* ==================================================================== */

/* The matrix the office keeps is an establishment rather than a roster: it
   names the vessel's positions and the shift each one stands. The Master, the
   Second Mate, the Assistant Engineer and the GPH are carried on both shifts;
   the two Chief Officers split them, A on Shift 1 and B on Shift 2, and so do
   the two Shift Primary Engineers — one berth on each shift, filled by
   whichever of the Chief Engineer and the First Engineer stands that watch;
   and the Cook is allocated to neither — a day worker. Shift 1 is the day shift, 1200 – 2400, and Shift 2 is
   the night shift, 2400 – 1200.

   Every one of these positions is on the Swing Compliance page whether the
   swing carries anybody in it or not, so a berth nobody is standing reads as a
   berth nobody is standing rather than as a row that quietly isn't there. */
const SHIFT_MATRIX_VESSEL = VESSEL.shift.vesselCode;

/* Positions are pooled by title, because the roster and the training matrix
   write them their own way: the matrix carries "Chief Officer - Unlimited" and
   "Chief Officer - 100m" against names, and both are Chief Officers on the
   office's sheet. The two Chief Officer berths differ only in the shift they
   stand, so they share a pool and are told apart by the watch set on the
   roster; the two Shift Primary Engineer berths work the same way, taking the
   Chief Engineer and the First Engineer whichever watch each stands. A title
   no pool claims is a position the office matrix doesn't carry,
   and it keeps a row of its own underneath rather than being forced into one. */
// Each pool and the pattern a normalised title must match to fall in it, from
// the vessel file. Titles reach here lower-cased (normTitle), so the patterns
// are matched as written.
const SHIFT_MATRIX_POOLS = VESSEL.shift.pools.map(({ pool, is }) => {
  const re = new RegExp(is);
  return { pool, is: (t) => re.test(t) };
});

/* The matrix itself, in the order the office writes it (the vessel file's
   establishment). "shifts" is which of the two the position is allocated to —
   both, one, or neither for the Cook. */
const SHIFT_MATRIX = VESSEL.shift.establishment;

// Which pool a position title falls in, or null where the office matrix carries
// no such position.
const shiftMatrixPool = (title) => {
  const t = normTitle(title);
  if (!t) return null;
  const hit = SHIFT_MATRIX_POOLS.find((p) => p.is(t));
  return hit ? hit.pool : null;
};

// The sheet's own words for a position's allocation, so the page reads as the
// office matrix does: "Shift 1 / Shift 2", "Shift 1", or "N/A".
const SHIFT_SHEET_WORD = VESSEL.shift.sheetWords;
const shiftMatrixWords = (shifts) =>
  shifts.length === 0 ? "N/A" : shifts.map((s) => SHIFT_SHEET_WORD[s]).join(" / ");

/* The little row of slots in the results table: one circle per holder the sheet
   asks for, filled for each one the swing's crew carries, hollow red where the
   swing is short. Holders past the requirement hang on as a "+n". A requirement
   written as words rather than a count, or one asking for more than ten, gets no
   slots — the numbers in the columns beside it already say it. */
function ShiftMeter({ required, have }) {
  const need = parseInt(required, 10);
  const got = Number(have);
  if (!Number.isFinite(need) || need <= 0 || need > 10 || have == null || !Number.isFinite(got)) return null;
  const filled = Math.min(Math.max(got, 0), need);
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center", verticalAlign: "middle" }}>
      {Array.from({ length: need }, (_, i) => (
        <span key={i} style={{ width: 9, height: 9, borderRadius: "50%", flex: "none",
          background: i < filled ? T.teal : "transparent",
          border: `1.5px solid ${i < filled ? T.teal : T.bRed}` }} />
      ))}
      {got > need && (
        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, marginLeft: 2 }}>+{got - need}</span>
      )}
    </span>
  );
}

/**
 * The office's shift allocation guideline against what the crew rostered onto
 * the swing shown on the Swing Compliance page hold on the training matrix.
 *
 * The guideline carries no names. It says how many holders of certain training
 * matrix items every shift — day and night — must have, for this swing and the
 * swings after it. So the comparison is against what the crew hold rather than
 * the roster: each rostered person goes up with the items they hold valid
 * across the swing, what runs out while they are onboard, and the watch they
 * are on, and the answer comes back requirement by requirement. What a person
 * holds is the training matrix overlaid with the certificates on file, so a
 * certificate filed after the matrix last moved counts on its own — no matrix
 * run or regenerated spreadsheet stands between filing a scan and comparing.
 *
 * The office's shift allocation matrix is listed above the comparison: every
 * position the vessel carries and the shift each one stands — the Master,
 * Second Mate, Assistant Engineer and GPH on both, the two Chief Officers split
 * A on Shift 1 and B on Shift 2, the Chief Engineer on Shift 1, the First
 * Engineer on Shift 2, and the Cook on neither — with the names filling each
 * berth this swing and the watch they stand. All of them are on the page
 * whether anybody is in them or not, so a berth nobody is standing reads as
 * exactly that, and anybody standing a shift their position isn't allocated to
 * is marked. The guideline names positions as often as it names numbers, so the
 * manning it is read against is there whether a comparison has been run or not —
 * it comes off the matrix, the roster and the office's allocation rather than
 * the model. A position the office matrix doesn't carry keeps a line of its own
 * underneath rather than being folded into one.
 *
 * One sheet is kept — the latest the office sent — and uploading a newer one
 * replaces it, like every other office document on the portal. The answer is
 * shared, so it is on the page for whoever opens it next — and the server keeps
 * it against the sheet and the crew standing it was made from, so asking again
 * with nothing changed costs nothing.
 */
function SwingShiftAllocation({ here }) {
  const { shiftAllocation, setShiftAllocation, shiftAnalysis, setShiftAnalysis,
    quals: QUALS, certificates, certDates, swingBoard, swingBoards, log, role } = usePortal();
  // How long each item stays valid, off the skills matrix — the same
  // lookup the certification screens carry, so the column reads alike here.
  const validityFor = useValidityLookup();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The run is watched from a window over the page, like every other analysis:
  // null | { phase: "sheet" } | { phase: "comparing", waited } | { phase: "failed", message }.
  const [run_, setRun] = useState(null);
  const [hidden, setHidden] = useState(false);
  // Which requirement's names-and-dates table is open, as "group-item-i".
  const [openReq, setOpenReq] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  const pulled = useRef(false);

  const running = !!run_ && run_.phase !== "failed";

  // How far through the run is. The whole thing is one question to the model, so
  // there is no count to track — the figure climbs with the wait instead, and
  // stops short of the top rather than claiming an end it can't see.
  const pct = !run_ || run_.phase === "failed" ? 0
    : run_.phase === "sheet" ? 8
    : Math.min(95, 12 + Math.round(((run_.waited || 0) / 120) * 83));

  React.useEffect(() => {
    if (!running) return;
    const tick = () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [running]);

  // Each rostered person's standing, read against the swing's own dates: an
  // item is only counted when it holds for the whole swing, and one that runs
  // out onboard is sent up as exactly that. The watch comes off the roster
  // board where one has been set.
  const start = here.swing.start || here.swing.flyOut;
  const end = here.swing.end || here.swing.flyHome;
  const rowByName = Object.fromEntries(QUALS.rows.map((r) => [r[0], r]));

  // What the certificates on file say, by person and matrix code. The matrix
  // usually carries this already — filing a certificate sets the update run
  // going on its own — but a scan filed a moment ago, or one whose run stopped
  // partway, is still a document on the portal, and the comparison reads it
  // directly rather than waiting on any run or regenerated spreadsheet. A
  // certificate can only add an item or push its date out; it never reads an
  // item down below what the matrix says.
  const certHeld = {};
  (certificates || []).forEach((c) => {
    const code = String(c.qualCode || "").trim().toUpperCase();
    const who = String(c.person || "").trim().toUpperCase();
    if (!code || !who) return;
    const held = !!noExpiryPeriod(code);
    const date = !held && /^\d{4}-\d{2}-\d{2}/.test(String(c.expires || "")) ? String(c.expires).slice(0, 10) : null;
    if (!held && !date) return; // a scan with no expiry read off it settles nothing
    const m = certHeld[who] || (certHeld[who] = {});
    const so = m[code];
    if (!so || (!so.held && (held || (date && (!so.date || date > so.date))))) m[code] = { held, date };
  });

  // One person's items: their matrix row overlaid with their filed
  // certificates, the later standing winning per item.
  const standingFor = (name) => {
    const merged = {};
    (rowByName[name] ? itemsFor(rowByName[name], QUALS) : []).forEach((x) => {
      merged[x.code] = { held: x.band.key === "held", date: x.band.date || null };
    });
    Object.entries(certHeld[String(name || "").trim().toUpperCase()] || {}).forEach(([code, so]) => {
      const cur = merged[code];
      if (!cur || (!cur.held && (so.held || (so.date && (!cur.date || so.date > cur.date))))) merged[code] = so;
    });
    return Object.entries(merged);
  };

  // The watch each person is on comes off the board the swing is read from —
  // the live board for the swing that is on, the swing's own board for a
  // coming one worked ahead on the roster above.
  const watchBoard = here.swing.k > currentSwingIndex()
    ? (swingBoards || {})[here.swing.k] || null
    : swingBoard;
  const watchOf = (p) => (watchBoard && watchBoard.shift && watchBoard.shift[p.id]) || null;
  const payload = {
    swing: {
      label: swingLabel(here.swing), crew: here.swing.crew,
      flyOut: here.swing.flyOut, flyHome: here.swing.flyHome,
    },
    items: QUALS.cols.map((c) => `${c[0]} ${c[1]}`),
    // The office's own shift allocation matrix — every position the vessel
    // carries and the shift each one stands. A requirement that names positions
    // rather than a number is read against this, so "Chief Officer" on Shift 1
    // means the (A) berth and on Shift 2 the (B) one, and the Cook stands
    // neither shift.
    positions: SHIFT_MATRIX.map((m) => ({
      position: `${SHIFT_MATRIX_VESSEL} ${m.label}`,
      shift: m.shifts.length === 2 ? "both" : m.shifts.length === 1 ? m.shifts[0] : "neither",
      allocated: shiftMatrixWords(m.shifts),
    })),
    crew: [
      ...here.checked.map((c) => {
        const items = standingFor(c.name);
        return {
          name: c.name, position: c.position, shift: watchOf(c.person),
          holds: items.filter(([, so]) => so.held || (so.date && so.date > end)).map(([code]) => code),
          expiring: items.filter(([, so]) => so.date && so.date >= start && so.date <= end)
            .map(([code, so]) => ({ item: code, runsOut: so.date })),
        };
      }),
      ...here.unchecked.map((p) => ({ name: p.name, position: null, dept: p.dept, shift: watchOf(p), holds: null, expiring: [] })),
    ],
  };

  // An answer somebody else already ran is picked up off the server once, so the
  // page doesn't open blank on a browser that wasn't the one that pressed the
  // button before the shared state had carried it over.
  React.useEffect(() => {
    if (shiftAnalysis || !shiftAllocation || pulled.current) return;
    pulled.current = true;
    analyse({ action: "shift-state" })
      .then((res) => {
        if (res && res.analysis && res.analysis.check) {
          setShiftAnalysis({
            at: res.analysis.at, by: "", sheet: res.analysis.sheet || null,
            swing: null, check: res.analysis.check, problems: [],
          });
        }
      })
      .catch(() => {}); // Nothing held is a fine answer; the button is right there.
  }, [shiftAllocation, shiftAnalysis]);

  const run = async (fresh) => {
    if (!shiftAllocation || busy) return;
    setBusy(true); setErr(""); setHidden(false);
    startedAt.current = Date.now();
    setRun({ phase: "sheet" });
    try {
      const { text, problem } = await matrixSheetText(shiftAllocation);

      // The comparison is one long question to the model, and a request that
      // waited for it was cut off by the platform partway — the 504 this button
      // used to hand back. So the server writes the run down as a job, and it is
      // asked after until the answer is there. A question already answered — the
      // same sheet, the same crew standing — comes back on the first call with
      // no job at all.
      setRun({ phase: "comparing", waited: 0 });
      let res = await analyse({ action: "shift-check", text, crew: payload, force: fresh });
      if (res && res.pending && res.jobId) {
        // The server sets the worker going itself unless the portal's password
        // protection turned its own call away — then it says where, and the
        // browser, which has the password answer, starts it instead.
        if (res.startPath) await startAnalysisWorker(res.startPath, res.jobId);
        res = await waitForAnalysisJob("shift-job", res.jobId, (waited) =>
          setRun({ phase: "comparing", waited }));
      }

      const counts = (res.check && res.check.counts) || {};
      const toFix = ["short", "unclear"]
        .reduce((n, k) => n + (Number(counts[k]) || 0), 0);
      setShiftAnalysis({
        at: res.at || new Date().toISOString(),
        by: role,
        sheet: res.sheet || null,
        swing: payload.swing.label,
        // Who was onboard when the answer was reached, so a crew change
        // afterwards can't pass as this crew's standing.
        crew: payload.crew.map((c) => c.name).sort(),
        check: res.check || null,
        problems: problem ? [problem] : [],
      });
      log("Swings", "Shift allocation compared",
        `${payload.swing.label} · ${shiftAllocation.filename} · ${toFix ? `${toFix} to look at` : "all requirements met"}`);
      setRun(null);
    } catch (e) {
      const message = e.message || String(e);
      setErr(message);
      // The window comes back if it had been put away — a run that stopped is
      // the one thing worth interrupting for. Closing it leaves the same message
      // under the buttons.
      setHidden(false);
      setRun({ phase: "failed", message });
    }
    setBusy(false);
  };

  const held = (shiftAnalysis && shiftAnalysis.check) || null;
  // An answer made before this check read the sheet as a guideline has no
  // requirements list. It is about a question no longer asked, so it reads as
  // nothing held rather than as a swing with every requirement met.
  const check = held && (held.readable === false || Array.isArray(held.requirements)) ? held : null;
  // One answer is kept and it is shared, so it stays put while the cards above
  // switch swings. Which swing it was made for is written on it; when that
  // isn't the swing picked above, it is said out loud rather than the old
  // answer quietly passing as this swing's.
  const madeFor = (shiftAnalysis && shiftAnalysis.swing) || "";
  // An answer is this swing's only while the crew it was reached against are
  // the crew onboard. Somebody sent ashore or brought on since leaves it
  // standing for a crew that isn't the one on the vessel, so it is said out
  // loud rather than read as current.
  const countedCrew = Array.isArray(shiftAnalysis && shiftAnalysis.crew) ? shiftAnalysis.crew : null;
  const aboardNow = [...here.checked.map((c) => c.name), ...here.unchecked.map((p) => p.name)].sort();
  const crewMoved = !!(check && countedCrew && countedCrew.join("|") !== aboardNow.join("|"));
  const stale = !!(check && madeFor && madeFor !== swingLabel(here.swing));
  // The lists come back from a model, so a missing key or the wrong shape is
  // something to render around rather than throw on.
  const reqs = (Array.isArray(check && check.requirements) ? check.requirements : [])
    .map((r) => ({ ...r, verdict: SHIFT_STATUS[r.status] || SHIFT_STATUS.unclear }))
    .sort((a, b) => a.verdict.rank - b.verdict.rank);
  const notes = Array.isArray(check && check.notes) ? check.notes : [];
  const caveats = Array.isArray(shiftAnalysis && shiftAnalysis.problems) ? shiftAnalysis.problems : [];
  const wrong = reqs.filter((r) => r.verdict.rank < 2).length;
  const nShort = reqs.filter((r) => r.verdict === SHIFT_STATUS.short).length;
  const nUnclear = reqs.filter((r) => r.verdict === SHIFT_STATUS.unclear).length;
  const nMet = reqs.length - nShort - nUnclear;

  // The results table's cell dress, named once so the header and every row agree.
  const th = { fontFamily: T.display, fontSize: 11, fontWeight: 700, letterSpacing: "0.09em",
    textTransform: "uppercase", color: T.muted, textAlign: "left", padding: "8px 11px",
    borderBottom: `1px solid ${T.rule}`, whiteSpace: "nowrap" };
  const td = { fontFamily: T.body, fontSize: 13, color: T.text, padding: "9px 11px",
    borderTop: `1px solid ${T.rule}`, verticalAlign: "middle" };

  /* ---- who was counted, and what their certificate says ------------------ */
  /* The answer names the crew it counted and nothing more. What stands behind
     each name is already on the portal, so the opened row is filled in here
     rather than asked of the model: the certificate's issue date, the date it
     runs out, how long the item stays valid, and a way straight into the scan
     on file. The standing is worked the same way the comparison worked it — the
     matrix cell, pushed out by a certificate filed since where that says later
     — so the dates on the line are the dates the verdict was reached on. */

  // Names are held against the matrix as they are written, then with the
  // punctuation and casing taken out, then with the parts in any order — the
  // model is asked for the matrix's own spelling, and "Ryan STEWART" for
  // "STEWART, Ryan" shouldn't cost a line its dates.
  const nameKey = (s_) => normTitle(s_).split(" ").filter(Boolean).sort().join(" ");
  const rowByNorm = {};
  const rowByParts = {};
  QUALS.rows.forEach((r) => {
    rowByNorm[normTitle(r[0])] = r;
    rowByParts[nameKey(r[0])] = r;
  });
  const matrixRowFor = (who) =>
    rowByName[who] || rowByNorm[normTitle(who)] || rowByParts[nameKey(who)] || null;

  // The matrix columns one requirement names. The sheet writes an item the way
  // the matrix does — code then title — and a requirement can list alternatives,
  // so every column the row names is matched: by code where one is written, by
  // title where it isn't.
  const colsForItem = (item) => {
    const up = String(item || "").toUpperCase();
    const norm = normTitle(item);
    const found = [];
    QUALS.cols.forEach((c, i) => {
      const code = String(c[0] || "").trim().toUpperCase();
      const title = normTitle(c[1]);
      const byCode = !!code
        && new RegExp(`(^|[^A-Z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9]|$)`).test(up);
      // Short titles match too much of the sheet's own wording to be trusted.
      const byTitle = title.length >= 8 && norm.includes(title);
      if (byCode || byTitle) found.push({ code: c[0], title: c[1], i });
    });
    return found;
  };

  // One line per name counted: the item they hold it under, their position, the
  // validity period, the two dates, and the scan. Where a requirement lists
  // alternatives, the line carries the one that made them count.
  const countedLines = (r) => {
    const cols = colsForItem(r.item);
    return (Array.isArray(r.holders) ? r.holders : []).map((who) => {
      const row = matrixRowFor(who);
      const name = row ? row[0] : who;
      const filed = certHeld[String(name).trim().toUpperCase()] || {};
      const options = cols.map((c) => {
        const band = row ? bandFor(row[3][c.i]) : null;
        const so = filed[String(c.code).trim().toUpperCase()] || null;
        const read = certDateFor(certDates, name, c.code);
        // The latest date anything on the portal holds for this item — the
        // matrix cell, the certificate filed against it, or the reading of the
        // scan itself.
        const expires = [band && band.date, so && so.date, read && read.expires]
          .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(String(d || "")))
          .map((d) => String(d).slice(0, 10))
          .sort()
          .pop() || null;
        return {
          code: c.code, title: c.title,
          band: expires ? bandFor(expires) : band,
          neverExpires: !!noExpiryPeriod(c.code) || !!(so && so.held) || !!(band && band.key === "held"),
          issued: (read && read.issued) || null,
          expires,
          validity: validityFor({ code: c.code, title: c.title }),
          url: certLinkFor(certDates, certificates, name, c.code),
        };
      });
      // An item held for good first, then the one running out latest — the
      // standing that carried the requirement.
      const rank = (o) => (o.neverExpires ? 0 : o.expires ? 1 : o.band ? 2 : 3);
      const best = options.slice().sort((a, b) =>
        rank(a) - rank(b) || String(b.expires || "").localeCompare(String(a.expires || "")))[0] || null;
      return {
        who: name, position: row ? row[1] : null, onMatrix: !!row,
        code: best ? best.code : null, title: best ? best.title : null,
        band: best ? best.band : null, neverExpires: !!(best && best.neverExpires),
        issued: best ? best.issued : null, expires: best ? best.expires : null,
        validity: best ? best.validity : null, url: best ? best.url : null,
      };
    });
  };

  // The headings the counted lines sit under, and the dress each line shares
  // with the certification screens' own holder lists.
  const cHead = { fontFamily: T.display, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em",
    textTransform: "uppercase", color: T.muted, minWidth: 78 };
  const cLine = { display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
    padding: "5px 0", borderBottom: `1px solid ${T.rule}` };

  /* ---- the shift allocation matrix, position by position ------------------ */
  /* The guideline names positions as often as it names numbers — "GPH", "Any
     Position", "Chief Officer or Second Mate" — and a requirement counts only
     the positions it names. So the office's own shift allocation matrix is laid
     out beside it: every position it carries and the shift each one stands, the
     Master, Second Mate, Assistant Engineer and GPH on both, the two Chief
     Officers split A on Shift 1 and B on Shift 2, the Chief Engineer on Shift 1
     and the First Engineer on Shift 2, and the Cook on neither. All nine are on
     the page whether the swing carries anybody in them or not, so a berth
     nobody is standing reads as exactly that.

     Who fills each one is worked off the roster and the matrix rather than asked
     of the model: the position is the one the training matrix writes against the
     person's name, the watch is the one set on the roster above, and for anyone
     the matrix doesn't carry the roster's own department stands in, said as that
     rather than passed off as a rank. A position the office matrix doesn't carry
     keeps a line of its own underneath rather than being folded into one. */
  const onboardCrew = [
    ...here.checked.map((c) => ({ id: c.person.id, name: c.name,
      rank: c.position || null, onMatrix: true, watch: watchOf(c.person) })),
    ...here.unchecked.map((p) => ({ id: p.id, name: p.name,
      rank: p.dept || null, onMatrix: false, watch: watchOf(p) })),
  ];

  // The two shifts, as the office matrix names them and as the vessel works
  // them, and the column for anyone without a watch. A watch is set on the
  // roster; anyone without one counts toward the swing as a whole rather than
  // toward either shift, which is the same way the comparison itself treats
  // them.
  const WATCHES = [
    { id: "day", title: "Day Shift", sheet: "Shift 1", hours: "1200 – 2400" },
    { id: "night", title: "Night Shift", sheet: "Shift 2", hours: "2400 – 1200" },
    { id: null, title: "No watch set", sheet: null, hours: null },
  ];
  const inWatch = (list, w) =>
    list.filter((c) => (w ? c.watch === w : c.watch !== "day" && c.watch !== "night"));

  /* Everybody onboard sorted into the office matrix's positions by the title
     written against their name. Two spellings that differ only in casing or
     punctuation are the one position, and a title the matrix doesn't carry is
     kept aside for a line of its own under the matrix. */
  const pooled = {};
  const extraRows = [];
  const extraAt = {};
  onboardCrew.forEach((c) => {
    const label = c.rank || "No position given";
    const pool = c.rank ? shiftMatrixPool(label) : null;
    if (pool) { (pooled[pool] || (pooled[pool] = [])).push(c); return; }
    const key = normTitle(label) || label.toLowerCase();
    let row = extraAt[key];
    if (!row) {
      row = extraAt[key] = { key, label, named: !!c.rank, fromMatrix: !!(c.onMatrix && c.rank),
        onMatrixSheet: false, shifts: [], crew: [] };
      extraRows.push(row);
    }
    if (!row.fromMatrix && c.onMatrix && c.rank) { row.label = label; row.fromMatrix = true; }
    row.crew.push(c);
  });

  /* One line per position on the office matrix, in the matrix's own order. A
     berth stood on one shift takes the crew standing that watch — which is what
     tells Chief Officer (A) from Chief Officer (B) — and where a pool has a
     berth on each shift, anybody in it without a watch set fills neither and is
     said once, against the first of the two, so nobody is counted twice. */
  const matrixRows = SHIFT_MATRIX.map((m) => {
    const pool = pooled[m.pool] || [];
    const berths = SHIFT_MATRIX.filter((x) => x.pool === m.pool);
    const split = berths.length > 1;
    const firstOfPool = berths[0].key === m.key;
    const mine = !split ? pool : pool.filter((c) =>
      m.shifts.includes(c.watch) || (firstOfPool && !berths.some((b) => b.shifts.includes(c.watch))));
    const day = mine.filter((c) => c.watch === "day");
    const night = mine.filter((c) => c.watch === "night");
    const none = mine.filter((c) => c.watch !== "day" && c.watch !== "night");
    return { key: m.key, label: m.label, pool: m.pool, shifts: m.shifts, onMatrixSheet: true, split,
      fromMatrix: true, named: true, day, night, none, crew: mine };
  });
  const rankRows = [...matrixRows, ...extraRows];

  /* The certifications the guideline requires of each position, read off the
     comparison's own requirement list: a requirement counts on a row when the
     positions it names include this one (or it names any position), and when
     its shift is the row's own, or covers both. Nothing until a comparison has
     been run — the requirements are the sheet's words, read by the model, and
     inventing them here would be guessing at the office's document. */
  const isAnyPosition = (r) => {
    const who = String(r.positions || "").trim();
    return !who || /\bany\b/i.test(who);
  };
  // Requirements naming a position sit on that position's row; the ones that
  // count anybody are said once above the table instead of on every row. A
  // day and a night entry asking the same of the same item fold into one
  // "per shift" line.
  const reqsFor = (row) => {
    if (!row.onMatrixSheet || !reqs.length) return [];
    return reqs.filter((r) => {
      if (isAnyPosition(r)) return false;
      if ((r.shift === "day" || r.shift === "night") && row.shifts.length && !row.shifts.includes(r.shift)) return false;
      const pools = String(r.positions).split(/,|\/|\bor\b|\band\b|&/i).map((x) => shiftMatrixPool(x)).filter(Boolean);
      return pools.includes(row.pool);
    });
  };
  const reqSay = (r, perShift) => {
    const n = String(r.required || "").trim();
    const count = /^\d+$/.test(n) ? (Number(n) > 1 || perShift ? ` × ${n}` : "") : "";
    return `${r.item}${count}${perShift ? " per shift" : r.shift === "day" ? " (Shift 1)" : r.shift === "night" ? " (Shift 2)" : ""}`;
  };
  const foldShifts = (list) => {
    const byItem = {};
    list.forEach((r) => { (byItem[r.item] || (byItem[r.item] = [])).push(r); });
    const out = [];
    Object.values(byItem).forEach((group) => {
      const day = group.find((r) => r.shift === "day");
      const night = group.find((r) => r.shift === "night");
      if (day && night && String(day.required).trim() === String(night.required).trim()) {
        out.push(reqSay(day, true));
        group.filter((r) => r !== day && r !== night).forEach((r) => out.push(reqSay(r)));
      } else group.forEach((r) => out.push(reqSay(r)));
    });
    return out;
  };
  const swingReqs = foldShifts(reqs.filter(isAnyPosition));

  // A berth the matrix allocates that nobody is standing, and anybody standing a
  // shift their position isn't allocated to — the two things worth saying out
  // loud above the table.
  const rowOn = (row, w) => (w === "day" ? row.day : w === "night" ? row.night : row.none) || [];
  const unfilled = matrixRows.reduce((n, r) =>
    n + r.shifts.filter((w) => rowOn(r, w).length === 0).length, 0);
  const offAllocation = (row) => (row.onMatrixSheet ? ["day", "night"] : [])
    .filter((w) => !row.shifts.includes(w) && rowOn(row, w).length > 0);
  const misplaced = matrixRows.reduce((n, r) =>
    n + offAllocation(r).reduce((m, w) => m + rowOn(r, w).length, 0), 0);

  const onboardTotals = Object.fromEntries(
    WATCHES.map((w) => [w.id || "none", inWatch(onboardCrew, w.id).length]));
  const noWatch = onboardTotals.none || 0;

  return (
    <div>
      {/* The sheet the comparison runs against, and the spot a newer one goes. */}
      <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.teal}`,
        borderRadius: 2, padding: "13px 15px", marginBottom: 10 }}>
        <Eyebrow color={T.teal}>The sheet on file</Eyebrow>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
          gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          <div style={{ minWidth: 0, flex: "1 1 200px" }}>
            <div style={{ fontFamily: T.body, fontSize: 13, wordBreak: "break-word",
              color: shiftAllocation ? T.text : T.muted }}>
              {shiftAllocation ? shiftAllocation.filename : "No shift allocation sheet has been filed yet."}
            </div>
            {shiftAllocation && (
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 2 }}>
                {shiftAllocation.uploaded ? `${fmtDate(shiftAllocation.uploaded)} · ` : ""}{shiftAllocation.size}
              </div>
            )}
          </div>
          <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {shiftAllocation && shiftAllocation.url && <OpenLink url={shiftAllocation.url} />}
            <SingleDocumentUpload
              category="shift-allocation"
              noun="shift allocation sheet"
              eyebrow="Shift allocation sheet"
              blurb="One sheet is kept on the portal — the latest the office sent. It is a guideline rather than a crew list: how many holders of certain certificates each shift must carry, for this swing and the ones after it. The comparison on the Swings page runs against whichever is on file."
              current={shiftAllocation || null}
              onFiled={(record) => {
                setShiftAllocation(record);
                // A new sheet makes the old answer about a document that is no
                // longer on the portal, so it goes with it.
                setShiftAnalysis(null);
              }}
              logAction="Shift allocation sheet uploaded"
              label={shiftAllocation ? "Upload a newer sheet" : "Upload the sheet"}
            />
          </span>
        </div>
      </div>

      {/* The berth manning now lives inside each shift's own column below,
          so the page reads shift by shift rather than as a second wide table.
          The counts worth shouting stay here, one line. */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <Chip fg={T.accent} bg={T.raised}>{onboardCrew.length} onboard · {swingLabel(here.swing)}</Chip>
        {unfilled > 0 && (
          <Chip fg={T.bRed} bg={T.bRedBg}>{unfilled} berth{unfilled === 1 ? "" : "s"} unfilled</Chip>
        )}
        {misplaced > 0 && (
          <Chip fg={T.bOrange} bg={T.bOrangeBg}>{misplaced} standing a shift the matrix doesn't allocate</Chip>
        )}
        {noWatch > 0 && <Chip fg={T.bOrange} bg={T.bOrangeBg}>{noWatch} no watch set</Chip>}
      </div>

      {/* The comparison reads the guideline against what the crew hold — the
          training matrix overlaid with the certificates on file, so a scan
          filed a moment ago counts without a matrix run or a regenerated
          spreadsheet in between. A sheet on file is all it needs. */}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <Button writes onClick={() => run(!!check)} disabled={!shiftAllocation || busy}>
          {busy
            ? (run_ && run_.phase === "sheet" ? "Reading the sheet..." : "Comparing...")
            : check ? (stale ? "Compare this swing" : "Compare again") : "Compare with AI"}
        </Button>
        {shiftAnalysis && !busy && (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
            Last run {new Date(shiftAnalysis.at).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
            {shiftAnalysis.by ? ` · ${shiftAnalysis.by}` : ""}
            {shiftAnalysis.swing ? ` · against ${shiftAnalysis.swing}` : ""}
          </span>
        )}
      </div>

      {/* A run takes a minute or two and is watched from a window over the page,
          like every other analysis: the figure and the clock both climb while
          the server works. It can be put away — the run carries on either way. */}
      {run_ && !hidden && (
        <AnalysisWindow
          eyebrow="Comparing the shift allocation sheet"
          pct={pct}
          elapsed={elapsed}
          failed={run_.phase === "failed"}
          message={run_.message}
          failNote="Nothing on the portal has changed. The sheet and the roster are both still here, so it can be run again."
          body={<>
            {run_.phase === "sheet" && "Opening the sheet on file."}
            {run_.phase === "comparing" && ((run_.waited || 0) > 20
              ? "Holding the guideline against the rostered crew's training matrix standing. It is one long question over the whole swing and it runs on the server, so it takes a minute or two."
              : "Holding the guideline against the rostered crew's training matrix standing.")}
          </>}
          note="Leave the page open. The comparison runs on the server, so a dropped connection doesn't lose it — the answer is picked up when the page asks again."
          onHide={() => setHidden(true)}
          onClose={() => setRun(null)}
        />
      )}

      {err && (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.bRed, lineHeight: 1.6, marginBottom: 10 }}>{err}</div>
      )}
      {caveats.map((p, i) => (
        <div key={i} style={{ fontFamily: T.body, fontSize: 12.5, color: T.bOrange, lineHeight: 1.6, marginBottom: 10 }}>{p}</div>
      ))}

      {!check ? (
        <Empty>
          {shiftAllocation
            ? "Not compared yet. The AI reads the guideline on file — how many holders of each certificate every shift must carry — against what this swing's crew hold: the training matrix, overlaid with the certificates on file."
            : "Upload the office's shift allocation sheet and the AI checks each shift of this swing carries the certificates it requires."}
        </Empty>
      ) : check.readable === false ? (
        <div style={{ background: T.panel, border: `1px solid ${T.rule}`, borderLeft: `3px solid ${T.bRed}`,
          borderRadius: 2, padding: "13px 15px" }}>
          <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.7 }}>
            The sheet couldn't be read. {check.reason || ""}
          </div>
        </div>
      ) : (
        <>
          {crewMoved && !stale && (
            <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
              borderLeft: `4px solid ${T.bOrange}`, borderRadius: 2, padding: "12px 15px",
              marginBottom: 10 }}>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6 }}>
                The crew onboard has changed since this was compared — press
                "Compare again" to read the guideline against who is onboard now.
              </span>
            </div>
          )}
          {stale && (
            <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
              borderLeft: `4px solid ${T.bOrange}`, borderRadius: 2, padding: "12px 15px",
              marginBottom: 10 }}>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6 }}>
                This answer was made against{" "}
                <strong style={{ fontWeight: 700 }}>{madeFor}</strong>. The swing picked above is{" "}
                <strong style={{ fontWeight: 700 }}>{swingLabel(here.swing)}</strong> — press
                "Compare this swing" and the guideline is read against its crew instead.
              </span>
            </div>
          )}
          <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
            borderLeft: `4px solid ${wrong ? T.bRed : T.teal}`, borderRadius: 2,
            padding: "13px 15px", marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
              gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.6, flex: "1 1 220px" }}>
                {check.headline || (wrong ? "The swing doesn't meet the guideline everywhere." : "The swing meets the guideline.")}
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {nShort > 0 && <Chip fg={T.bRed} bg={T.bRedBg}>{nShort} short</Chip>}
                {nUnclear > 0 && <Chip fg={T.muted} bg={T.raised}>{nUnclear} unclear</Chip>}
                {reqs.length > 0 && <Chip fg={T.teal} bg={T.raised}>{nMet} met</Chip>}
                {reqs.length === 0 && (
                  <Chip fg={wrong ? T.bRed : T.teal} bg={wrong ? T.bRedBg : T.raised}>
                    {wrong ? `${wrong} to look at` : "All met"}
                  </Chip>
                )}
              </span>
            </div>
            {nShort > 0 && (() => {
              const where = SHIFT_GROUPS.filter((g) =>
                reqs.some((r) => g.takes(r.shift) && r.verdict === SHIFT_STATUS.short &&
                  (g.id === "swing" || r.shift !== "swing")))
                .map((g) => g.title);
              return where.length ? (
                <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.bRed, marginTop: 5 }}>
                  Short on: {where.join(" and ")}.
                </div>
              ) : null;
            })()}
            {check.what && (
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, marginTop: 5 }}>{check.what}</div>
            )}
          </div>

          {/* The verdicts broken up by shift: Day Shift (1200 – 2400) first,
              Night Shift (2400 – 1200) under it, and anything the sheet didn't
              split by shift in a whole-swing group at the end. A requirement
              with one number each shift must meet alike sits under both shifts.
              Within a group the rows read short first. The stripe and the
              status chip say how a row stands, the two counts say by how much,
              and the circles draw it — one per holder the sheet asks for,
              filled for each the swing carries. Who was counted sits in the
              open under every row — a line per name, with the certificate's
              issue date, when it runs out, how long the item stays valid and a
              way into the scan on file — followed by the sentence the model
              wrote about the row, so the tables stay tables. */}
          {reqs.length > 0 && (
            <>
              {/* One compact row per requirement: the item, the circles, the
                  verdict, and who was counted in a muted line — with the full
                  dates-and-scans table behind Names & dates for whoever wants
                  it. The whole-swing rules sit first, full width; the two
                  shifts sit side by side, each carrying its own berth manning
                  underneath, so a shift is read top to bottom in one place. */}
              {(() => {
                const reqRow = (g, r, i) => {
                  const key = `${g.id}-${r.item || ""}-${i}`;
                  const openThis = openReq === key;
                  const holders = Array.isArray(r.holders) ? r.holders : [];
                  return (
                    <React.Fragment key={key}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                        padding: "8px 12px", borderTop: `1px solid ${T.rule}` }}>
                        <span style={{ flex: "1 1 190px", minWidth: 0 }}>
                          <span style={{ fontFamily: T.body, fontSize: 12.5, fontWeight: 600, color: T.text }}>{r.item}</span>
                          <span style={{ display: "block", fontFamily: T.mono, fontSize: 10, color: T.muted, marginTop: 1 }}>
                            {[r.positions, r.shift === "both" && g.id !== "swing" ? "each shift alike" : null,
                              /^\d+$/.test(String(r.required || "").trim()) ? `${r.required} required` : null]
                              .filter(Boolean).join(" · ") || (r.required || "")}
                          </span>
                        </span>
                        <ShiftMeter required={r.required} have={r.have} />
                        <Chip fg={r.verdict.fg()} bg={r.verdict.bg()}>
                          {r.verdict.label}{r.have != null && /^\d+$/.test(String(r.required || "").trim())
                            ? ` · ${r.have} of ${String(r.required).trim()}` : ""}
                        </Chip>
                        {(holders.length > 0 || r.detail) && (
                          <button className="um-btn" onClick={() => setOpenReq(openThis ? null : key)}
                            style={{ background: "transparent", color: T.muted, fontSize: 9.5,
                              fontWeight: 700, padding: "2px 0" }}>
                            {openThis ? "Close" : "Names & dates"}
                          </button>
                        )}
                        {(holders.length > 0 || r.detail) && (
                          <span style={{ width: "100%", display: "flex", flexDirection: "column",
                            gap: 4, alignItems: "flex-start", lineHeight: 1.5, paddingLeft: 2, marginTop: 2 }}>
                            {holders.map((who, n) => {
                              const dress = holderCircle(r, n);
                              return (
                                <span key={`${who}-${n}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ width: 11, height: 11, borderRadius: "50%", flex: "none",
                                    border: `2px solid ${dress.colour}`,
                                    background: dress.solid ? dress.colour : "transparent" }} />
                                  <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.text }}>{who}</span>
                                </span>
                              );
                            })}
                            {r.detail && r.verdict !== SHIFT_STATUS.met ? (
                              <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>{r.detail}</span>
                            ) : null}
                          </span>
                        )}
                      </div>
                      {openThis && (
                        <div style={{ padding: "6px 12px 10px", background: T.raised }}>
                          {holders.length > 0 && (
                            <>
                              <div style={{ display: "flex", gap: 10, alignItems: "baseline",
                                padding: "4px 0", borderBottom: `2px solid ${T.rule}` }}>
                                <span style={{ ...cHead, minWidth: 46 }}>Item</span>
                                <span style={{ ...cHead, flex: 1, minWidth: 160 }}>Crew member</span>
                                <span style={cHead}>Issue date</span>
                                <span style={cHead}>Expiry date</span>
                                <span style={{ ...cHead, textAlign: "right" }}>Certificate</span>
                              </div>
                              {countedLines(r).map((h, n) => (
                                <div key={`${h.who}-${n}`} style={cLine}>
                                  <span style={{ fontFamily: T.mono, fontSize: 10, color: h.code ? T.accent : T.muted,
                                    minWidth: 46 }}>{h.code || "—"}</span>
                                  <span style={{ flex: 1, minWidth: 160, fontFamily: T.body, fontSize: 12.5,
                                    fontWeight: 600, color: T.text }}>{h.who}</span>
                                  <DateCols issued={h.issued} expires={h.expires} />
                                  <CertCell url={h.url} person={h.who} code={h.code} title={h.title} />
                                </div>
                              ))}
                            </>
                          )}
                          {r.detail && (
                            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, opacity: 0.9,
                              lineHeight: 1.6, marginTop: holders.length ? 8 : 0 }}>{r.detail}</div>
                          )}
                        </div>
                      )}
                    </React.Fragment>
                  );
                };

                const groupBox = (g, full) => {
                  const rows = reqs.filter((r) => g.takes(r.shift));
                  const gShort = rows.filter((r) => r.verdict === SHIFT_STATUS.short).length;
                  const manned = g.id !== "swing"
                    ? matrixRows.filter((r) => r.shifts.includes(g.id))
                    : [];
                  const alsoStanding = g.id !== "swing"
                    ? [
                        ...matrixRows.filter((r) => r.onMatrixSheet && !r.shifts.includes(g.id))
                          .flatMap((r) => rowOn(r, g.id).map((c) => `${c.name} (${r.label} — allocated ${shiftMatrixWords(r.shifts)})`)),
                        ...extraRows.flatMap((r) => rowOn(r, g.id).map((c) => r.named ? `${c.name} (${r.label})` : c.name)),
                      ]
                    : [];
                  if (rows.length === 0 && manned.length === 0) return null;
                  return (
                    <div key={g.id} style={{ background: T.panel, border: `1px solid ${T.rule}`,
                      borderRadius: 2, marginBottom: full ? 10 : 0, overflow: "hidden" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
                        gap: 10, flexWrap: "wrap", padding: "10px 12px",
                        borderBottom: `2px solid ${gShort ? T.bRed : T.teal}` }}>
                        <span style={{ display: "flex", gap: 9, alignItems: "baseline", flexWrap: "wrap" }}>
                          <Eyebrow color={gShort ? T.bRed : T.teal}>{g.title}</Eyebrow>
                          <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>
                            {g.id === "swing" ? "any shift counts"
                              : `${g.id === "day" ? "Shift 1" : "Shift 2"} · ${g.hours} · ${inWatch(onboardCrew, g.id).length} standing`}
                          </span>
                        </span>
                        {gShort > 0
                          ? <Chip fg={T.bRed} bg={T.bRedBg}>{gShort} short</Chip>
                          : rows.length > 0 && <Chip fg={T.teal} bg={T.raised}>all met</Chip>}
                      </div>
                      {rows.length > 0 && (
                        <div style={{ padding: "3px 12px 2px", fontFamily: T.display, fontSize: 9.5,
                          fontWeight: 700, letterSpacing: "0.11em", textTransform: "uppercase", color: T.muted }}>
                          Must carry
                        </div>
                      )}
                      {rows.map((r, i) => reqRow(g, r, i))}
                      {manned.length > 0 && (
                        <>
                          <div style={{ padding: "8px 12px 2px", fontFamily: T.display, fontSize: 9.5,
                            fontWeight: 700, letterSpacing: "0.11em", textTransform: "uppercase", color: T.muted }}>
                            Standing this shift
                          </div>
                          {manned.map((row) => {
                            const names = rowOn(row, g.id);
                            const otherSide = g.id === "day" ? "night" : "day";
                            const elsewhere = names.length === 0 ? rowOn(row, otherSide) : [];
                            return (
                              <div key={row.key} style={{ display: "flex", gap: 10, alignItems: "baseline",
                                flexWrap: "wrap", padding: "5px 12px", borderTop: `1px solid ${T.rule}` }}>
                                <span style={{ fontFamily: T.display, fontSize: 10.5, fontWeight: 700,
                                  letterSpacing: "0.07em", textTransform: "uppercase", minWidth: 118,
                                  color: names.length ? T.text : T.bRed }}>{row.label}</span>
                                <span style={{ flex: 1, fontFamily: T.body, fontSize: 12.5,
                                  color: names.length ? T.text : T.bRed }}>
                                  {names.length
                                    ? names.map((c) => c.name).join(" · ")
                                    : elsewhere.length
                                      ? `Nobody standing — ${elsewhere.map((c) => c.name).join(", ")} ${elsewhere.length === 1 ? "is" : "are"} on ${otherSide}s`
                                      : "Nobody standing — berth unfilled"}
                                </span>
                              </div>
                            );
                          })}
                          {alsoStanding.length > 0 && (
                            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
                              padding: "5px 12px", borderTop: `1px solid ${T.rule}` }}>
                              <span style={{ fontFamily: T.display, fontSize: 10.5, fontWeight: 700,
                                letterSpacing: "0.07em", textTransform: "uppercase", minWidth: 118, color: T.bOrange }}>
                                Also standing
                              </span>
                              <span style={{ flex: 1, fontFamily: T.body, fontSize: 12.5, color: T.text }}>
                                {alsoStanding.join(" · ")}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                };

                const swingGroup = SHIFT_GROUPS.find((g) => g.id === "swing");
                return (
                  <>
                    {groupBox(swingGroup, true)}
                    <div className="um-swing2" style={{ display: "grid", gap: 10, marginBottom: 10,
                      gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))" }}>
                      {SHIFT_GROUPS.filter((g) => g.id !== "swing").map((g) => groupBox(g, false))}
                    </div>
                    {noWatch > 0 && (
                      <div style={{ background: T.panel, border: `1px solid ${T.rule}`,
                        borderLeft: `4px solid ${T.bOrange}`, borderRadius: 2, padding: "9px 13px",
                        marginBottom: 10, fontFamily: T.body, fontSize: 12.5, color: T.text }}>
                        <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.bOrange,
                          letterSpacing: "0.06em", marginRight: 8 }}>NO WATCH SET</span>
                        {inWatch(onboardCrew, null).map((c) => c.rank ? `${c.name} (${c.rank})` : c.name).join(" · ")}
                        {" — they count toward the swing but toward neither shift until a watch is set on the roster."}
                      </div>
                    )}
                  </>
                );
              })()}
            </>
          )}

          {notes.length > 0 && (
            <div style={{ background: T.raised, borderRadius: 2, padding: "10px 13px", marginTop: 10 }}>
              <div style={{ marginBottom: 6 }}><Eyebrow>What the reading itself said</Eyebrow></div>
              {notes.map((n, i) => (
                <div key={i} style={{ fontFamily: T.body, fontSize: 12.5, color: T.muted, lineHeight: 1.7 }}>{n}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
