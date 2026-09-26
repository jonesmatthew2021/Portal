/* Safety meeting recorder - the Record card at the top of the Vessel Safety
 * Meeting Minutes page. The meeting is recorded on this device (or a
 * recording made on the phone's own recorder is chosen), cut into pieces of
 * about a minute and written out by the worker's speech-to-text, the
 * minutes written by the model and corrected here, and the three files -
 * the minutes as a Word document, the transcript and the recording itself -
 * posted to the page as one line. The rules are source/shared/meeting.js;
 * the worker's half is worker/src/routes/meeting.ts.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * See tools/source.mjs.
 */

/* ==================================================================== */
/*  Kept on the device                                                  */
/* ==================================================================== */

/* Everything recorded is kept in the browser's own store as it is made - a
   piece of sound a minute, and the recording a minute at a time - so a tab
   that closes, a phone that locks or a link that drops partway loses
   nothing: the page offers to write out what was kept. A meeting leaves
   the store only when it has been posted or discarded. */
const MEETING_DB = "portal-meetings";

function meetingDb() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") return rej(new Error("This browser has nowhere to keep a recording."));
    const r = indexedDB.open(MEETING_DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("meetings")) d.createObjectStore("meetings");
      if (!d.objectStoreNames.contains("parts")) d.createObjectStore("parts");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error("The browser's store could not be opened."));
  });
}

async function meetingStore(store, mode, work) {
  const db = await meetingDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode);
    const asked = work(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); res(asked ? asked.result : undefined); };
    tx.onerror = () => { db.close(); rej(tx.error || new Error("The browser's store refused.")); };
    tx.onabort = () => { db.close(); rej(tx.error || new Error("The browser's store refused.")); };
  });
}
const keptPut = (store, key, value) => meetingStore(store, "readwrite", (s) => s.put(value, key));
const keptGet = (store, key) => meetingStore(store, "readonly", (s) => s.get(key));
const keptAll = (store) => meetingStore(store, "readonly", (s) => s.getAll());
const keptDrop = (store, key) => meetingStore(store, "readwrite", (s) => s.delete(key));

const pieceKey = (id, i) => `${id}/piece/${i}`;
const chunkKey = (id, i) => `${id}/chunk/${i}`;

/** A meeting and everything kept for it, gone from the device. */
async function forgetMeeting(meta) {
  if (!meta) return;
  for (let i = 0; i < (meta.pieces || 0); i++) await keptDrop("parts", pieceKey(meta.id, i)).catch(() => {});
  for (let i = 0; i < (meta.chunks || 0); i++) await keptDrop("parts", chunkKey(meta.id, i)).catch(() => {});
  await keptDrop("meetings", meta.id).catch(() => {});
}

/* ==================================================================== */
/*  The sound                                                           */
/* ==================================================================== */

/** All the blocks the microphone handed over, as one run of samples. */
function joinBlocks(blocks, have) {
  const all = new Float32Array(have);
  let at = 0;
  blocks.forEach((b) => { all.set(b, at); at += b.length; });
  return all;
}

/** One piece cut off the front of what the microphone has given so far and
 *  kept - the last one takes everything that is left. */
function cutPiece(cap, last) {
  const all = joinBlocks(cap.buf, cap.have);
  if (!last && all.length < PIECE_SECONDS * cap.rate) return;
  const end = last ? all.length : pieceEnd(all, cap.rate, 0);
  const piece = all.subarray(0, end);
  const rest = all.subarray(end);
  cap.buf = rest.length ? [new Float32Array(rest)] : [];
  cap.have = rest.length;
  const at = cap.cut / cap.rate;
  cap.cut += end;
  cap.meta.seconds = cap.cut / cap.rate;
  // The last half-second of a meeting is the chairs scraping.
  if (last && piece.length < cap.rate / 2 && cap.meta.pieces > 0) return;
  const rate = Math.min(cap.rate, PIECE_RATE);
  const wav = wavBytes(downsample(piece, cap.rate, PIECE_RATE), rate);
  const i = cap.meta.pieces++;
  const meta = { ...cap.meta };
  cap.writes = cap.writes
    .then(() => keptPut("parts", pieceKey(cap.id, i), { at, wav: wav.buffer }))
    .then(() => keptPut("meetings", cap.id, meta));
}

const RECORD_MIMES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
const extOf = (mime) => (/mp4/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : "webm");

/** decodeAudioData the way every browser answers it - some still only by
 *  callback. The bytes are copied first: decoding takes the buffer away. */
const decodeWith = (ctx, buf) =>
  new Promise((res, rej) => {
    let p;
    try { p = ctx.decodeAudioData(buf.slice(0), res, rej); } catch (e) { return rej(e); }
    if (p && typeof p.then === "function") p.then(res, rej);
  });

/** The recording opened and brought to mono at the pieces' rate. */
async function samplesOf(buf) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) throw new Error("This browser can't open a recording.");
  let audio;
  try {
    audio = await decodeWith(new OAC(1, 1, PIECE_RATE), buf);
  } catch (e) {
    audio = await decodeWith(new OAC(1, 1, 44100), buf);
  }
  let mono = audio.getChannelData(0);
  if (audio.numberOfChannels > 1) {
    mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
  }
  const rate = Math.min(audio.sampleRate, PIECE_RATE);
  return { samples: downsample(mono, audio.sampleRate, PIECE_RATE), rate };
}

const mmss = (secs) => {
  const s = Math.max(0, Math.round(secs || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const minutesLong = (secs) => `${Math.max(1, Math.round((secs || 0) / 60))} min`;

const whenWords = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${dayWords(todayISOOf(d))}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const todayISOOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* The link drops partway and fetch says "Failed to fetch": the recording is
   safe on the device, so say so. */
const unreachable = (e) =>
  /fetch|network|load failed/i.test((e && e.message) || "")
    ? "The portal couldn't be reached. The recording is kept on this device - press Write it out when the link is back."
    : (e && e.message) || String(e);

/* ==================================================================== */
/*  The card                                                            */
/* ==================================================================== */

function MeetingRecorder({ onPosted }) {
  const portal = usePortal();
  const [stage, setStage] = useState("idle");   // idle | recording | opening | writing | minutes | review | posting | error
  const [held, setHeld] = useState([]);          // meetings kept on this device and not yet posted
  const [meeting, setMeeting] = useState(null);  // the one in hand
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [minutes, setMinutes] = useState("");
  const [err, setErr] = useState("");
  const [showWords, setShowWords] = useState(false);
  const live = useRef(null);
  const posted = useRef({});
  const fileRef = useRef(null);
  const chair = SESSION_USER.name || "";

  const lookForHeld = async () => {
    try {
      const all = await keptAll("meetings");
      setHeld((all || []).filter((m) => m && m.pieces > 0).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))));
    } catch (e) {
      setHeld([]);
    }
  };
  React.useEffect(() => { lookForHeld(); }, []);

  if (!isAdmin(SESSION_USER)) return null;

  /* ------------------------------------------------------- recording --- */

  const startRecording = async () => {
    setErr("");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
      setErr("This browser can't record. Record on the phone's own recorder and choose the file here.");
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    let ac;
    try { ac = new AC({ sampleRate: PIECE_RATE }); } catch (e) { ac = new AC(); }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      ac.close().catch(() => {});
      setErr("The microphone wasn't allowed. Allow it for this site and press Record again.");
      return;
    }
    await ac.resume().catch(() => {});
    const mime = RECORD_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
    } catch (e) {
      rec = new MediaRecorder(stream);
    }
    const id = "m" + Date.now();
    const meta = { id, startedAt: new Date().toISOString(), mime: rec.mimeType || mime, ext: extOf(rec.mimeType || mime), pieces: 0, chunks: 0, seconds: 0, texts: {} };
    try {
      await keptPut("meetings", id, meta);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      ac.close().catch(() => {});
      setErr(e.message);
      return;
    }
    const cap = { id, meta, ac, stream, rec, rate: ac.sampleRate, buf: [], have: 0, cut: 0, writes: Promise.resolve(), stopped: false, t0: Date.now() };
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const i = meta.chunks++;
      const snap = { ...meta };
      cap.writes = cap.writes.then(() => keptPut("parts", chunkKey(id, i), e.data)).then(() => keptPut("meetings", id, snap));
    };
    const src = ac.createMediaStreamSource(stream);
    // The processor runs only while it is wired to the output; it puts
    // nothing on it, so nothing is heard back.
    const proc = ac.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => {
      if (cap.stopped) return;
      const ch = e.inputBuffer.getChannelData(0);
      cap.buf.push(new Float32Array(ch));
      cap.have += ch.length;
      if (cap.have >= PIECE_SECONDS * cap.rate) cutPiece(cap, false);
    };
    src.connect(proc);
    proc.connect(ac.destination);
    cap.src = src;
    cap.proc = proc;
    rec.start(60000);
    cap.tick = setInterval(() => setSeconds(Math.round((Date.now() - cap.t0) / 1000)), 500);
    live.current = cap;
    setSeconds(0);
    setMeeting(meta);
    setStage("recording");
  };

  const stopRecording = async () => {
    const cap = live.current;
    if (!cap) return;
    live.current = null;
    clearInterval(cap.tick);
    cap.stopped = true;
    try { cutPiece(cap, true); } catch (e) { setErr(e.message); }
    try { cap.proc.disconnect(); cap.src.disconnect(); } catch (e) {}
    await new Promise((res) => {
      if (cap.rec.state === "inactive") return res();
      cap.rec.onstop = res;
      try { cap.rec.stop(); } catch (e) { res(); }
    });
    cap.stream.getTracks().forEach((t) => t.stop());
    cap.ac.close().catch(() => {});
    try {
      await cap.writes;
      const meta = { ...cap.meta };
      await keptPut("meetings", cap.id, meta);
      setMeeting(meta);
      await writeOut(meta);
    } catch (e) {
      setErr(unreachable(e));
      setStage("error");
    }
  };

  /* --------------------------------------------- a recording chosen --- */

  const takeFile = async (file) => {
    setErr("");
    if (!file) return;
    if (file.size > RECORDING_MAX_BYTES) {
      setErr(`${file.name} is ${humanSize(file.size)}. The most a recording can be is ${humanSize(RECORDING_MAX_BYTES)}.`);
      return;
    }
    const id = "m" + Date.now();
    const meta = {
      id, startedAt: new Date(file.lastModified || Date.now()).toISOString(), mime: file.type || "",
      ext: (file.name.split(".").pop() || "m4a").toLowerCase(), name: file.name, chosen: true,
      pieces: 0, chunks: 1, seconds: 0, texts: {},
    };
    setMeeting(meta);
    setStage("opening");
    try {
      await keptPut("parts", chunkKey(id, 0), file);
      const { samples, rate } = await samplesOf(await file.arrayBuffer());
      let start = 0;
      let i = 0;
      while (start < samples.length) {
        const end = pieceEnd(samples, rate, start);
        const piece = samples.subarray(start, end);
        if (piece.length >= rate / 2 || i === 0) {
          await keptPut("parts", pieceKey(id, i), { at: start / rate, wav: wavBytes(piece, rate).buffer });
          i++;
        }
        start = end;
      }
      meta.pieces = i;
      meta.seconds = samples.length / rate;
      await keptPut("meetings", id, meta);
      setMeeting({ ...meta });
      await writeOut({ ...meta });
    } catch (e) {
      setErr(/decod|open/i.test((e && e.message) || "") || (e && e.name === "EncodingError")
        ? `${file.name} couldn't be opened on this device. Try it on a laptop, or record through the portal.`
        : unreachable(e));
      setStage("error");
    }
  };

  /* ------------------------------------------------ writing it out --- */

  const writeOut = async (meta) => {
    setStage("writing");
    setErr("");
    setShowWords(false);
    let texts = { ...(meta.texts || {}) };
    const pieces = [];
    for (let i = 0; i < meta.pieces; i++) {
      const p = await keptGet("parts", pieceKey(meta.id, i));
      if (!p) continue;
      pieces.push({ i, at: p.at });
      if (typeof texts[i] === "string") continue;
      setProgress({ done: i, of: meta.pieces });
      const r = await fetch(`${TRANSCRIBE_API}?piece=${i + 1}&of=${meta.pieces}`, {
        method: "POST", headers: { "Content-Type": "audio/wav" }, body: p.wav,
      });
      const a = await r.json().catch(() => null);
      if (!r.ok) throw new Error((a && a.error) || `The speech-to-text answered ${r.status}.`);
      texts = { ...texts, [i]: String((a && a.text) || "") };
      meta = { ...meta, texts };
      await keptPut("meetings", meta.id, meta);
    }
    setProgress({ done: meta.pieces, of: meta.pieces });
    const words = joinPieces(pieces.map((p) => ({ at: p.at, text: texts[p.i] })));
    setTranscript(words);
    setMeeting(meta);
    if (!words.trim()) throw new Error("Nothing was heard on the recording.");
    setStage("minutes");
    const day = String(meta.startedAt || "").slice(0, 10);
    const r = await fetch(MINUTES_API, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: words, date: day, chair }),
    });
    const a = await r.json().catch(() => null);
    if (!r.ok) throw new Error((a && a.error) || `The minutes couldn't be written (${r.status}).`);
    setMinutes(String((a && a.text) || ""));
    setStage("review");
  };

  const tryAgain = async () => {
    if (!meeting) return;
    try {
      await writeOut(meeting);
    } catch (e) {
      setErr(unreachable(e));
      setStage("error");
    }
  };

  const continueHeld = async (meta) => {
    setMeeting(meta);
    setMinutes("");
    setTranscript("");
    await tryAgainWith(meta);
  };
  const tryAgainWith = async (meta) => {
    try {
      await writeOut(meta);
    } catch (e) {
      setErr(unreachable(e));
      setStage("error");
    }
  };

  const discard = async (meta = meeting) => {
    await forgetMeeting(meta);
    posted.current = {};
    setMeeting(null);
    setMinutes("");
    setTranscript("");
    setErr("");
    setStage("idle");
    lookForHeld();
  };

  /* ------------------------------------------------------ posting --- */

  const post = async () => {
    if (!meeting || !minutes.trim()) return;
    setStage("posting");
    setErr("");
    const day = String(meeting.startedAt || "").slice(0, 10);
    const title = meetingTitle(day);
    const fields = (tag) => ({ category: "document", bucket: "vesselSafety", title, source: `Chaired by ${chair}`, tag, session: SESSION, filedOn: day });
    const done = posted.current;
    try {
      if (!done.minutes) {
        setProgress({ word: "the minutes" });
        const doc = await minutesDocument(minutes, { crc32, deflateRaw, writeZip });
        done.minutes = (await uploadFile(new File([doc], meetingFileName(day, "minutes", "docx"), { type: DOCX_MIME }), fields(MEETING_TAGS.minutes))).record;
      }
      if (!done.transcript) {
        setProgress({ word: "the transcript" });
        const txt = new File([transcriptText(transcript, { title, chair })], meetingFileName(day, "transcript", "txt"), { type: "text/plain" });
        done.transcript = (await uploadFile(txt, fields(MEETING_TAGS.transcript))).record;
      }
      if (!done.recording) {
        setProgress({ word: "the recording" });
        const chunks = [];
        for (let i = 0; i < (meeting.chunks || 0); i++) {
          const c = await keptGet("parts", chunkKey(meeting.id, i));
          if (c) chunks.push(c);
        }
        if (chunks.length) {
          const rec = new File(chunks, meetingFileName(day, "recording", meeting.ext || "webm"), { type: meeting.mime || chunks[0].type || "" });
          done.recording = (await uploadFile(rec, { ...fields(MEETING_TAGS.recording), recording: "1" }, { limit: RECORDING_MAX_BYTES })).record;
        }
      }
      onPosted(done.minutes);
      await forgetMeeting(meeting);
      posted.current = {};
      setMeeting(null);
      setMinutes("");
      setTranscript("");
      setStage("idle");
      lookForHeld();
    } catch (e) {
      setErr(e.message);
      setStage("review");
    }
  };

  /* --------------------------------------------------------- the card --- */

  const box = { background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 2, padding: 22, marginBottom: 22 };
  const line = { fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.6 };
  const quiet = { fontFamily: T.mono, fontSize: 12, color: T.muted };
  const bar = (done, of) => (
    <div style={{ height: 6, background: T.raised, borderRadius: 3, overflow: "hidden", marginTop: 10, maxWidth: 420 }}>
      <div style={{ height: "100%", width: `${of ? Math.round((done / of) * 100) : 0}%`, background: T.accent, transition: "width .3s" }} />
    </div>
  );
  const day = meeting ? String(meeting.startedAt || "").slice(0, 10) : "";

  return (
    <div style={box}>
      <div style={{ marginBottom: 12 }}><Eyebrow color={T.accent}>Record the meeting</Eyebrow></div>

      {stage === "idle" && (
        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Button onClick={startRecording}>
              <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 5, background: "#E5484D", marginRight: 8, verticalAlign: "baseline" }} />
              Record
            </Button>
            <input ref={fileRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac,.mp4" style={{ display: "none" }}
              onChange={(e) => { const x = e.target.files && e.target.files[0]; if (fileRef.current) fileRef.current.value = ""; if (x) takeFile(x); }} />
            <Button variant="ghost" onClick={() => fileRef.current && fileRef.current.click()}>Choose a recording</Button>
          </div>
          {held.length > 0 && (
            <div style={{ marginTop: 16, borderTop: `1px solid ${T.rule}`, paddingTop: 12 }}>
              {held.map((m) => (
                <div key={m.id} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "6px 0" }}>
                  <span style={line}>
                    {m.chosen ? m.name : "Recording"} from {whenWords(m.startedAt)} · {minutesLong(m.seconds)} · {Object.keys(m.texts || {}).length >= m.pieces ? "heard, not yet posted" : "not yet written out"}
                  </span>
                  <Button variant="ghost" onClick={() => continueHeld(m)}>Write it out</Button>
                  <Button variant="quiet" onClick={() => discard(m)}>Discard</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {stage === "recording" && (
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10, fontFamily: T.mono, fontSize: 22, color: T.text }}>
            <span style={{ width: 12, height: 12, borderRadius: 6, background: "#E5484D", animation: "um-blink 1.2s infinite" }} />
            {mmss(seconds)}
          </span>
          <Button onClick={stopRecording}>Stop</Button>
          <span style={quiet}>Recording</span>
        </div>
      )}

      {stage === "opening" && <div style={line}>Opening {meeting && meeting.name ? meeting.name : "the recording"}…</div>}

      {stage === "writing" && (
        <div>
          <div style={line}>Writing out… {progress ? `${Math.min(progress.done + 1, progress.of)} of ${progress.of}` : ""}</div>
          {progress && bar(progress.done, progress.of)}
        </div>
      )}

      {stage === "minutes" && <div style={line}>Writing the minutes…</div>}

      {(stage === "review" || stage === "posting") && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={line}>{meetingTitle(day)} · {minutesLong(meeting && meeting.seconds)}</div>
          <Field label="Minutes">
            <textarea className="um-in" value={minutes} onChange={(e) => setMinutes(e.target.value)} rows={18}
              disabled={stage === "posting"} style={{ fontFamily: T.mono, fontSize: 13, lineHeight: 1.5, resize: "vertical" }} />
          </Field>
          <div>
            <button className="um-btn" onClick={() => setShowWords((s) => !s)}
              style={{ background: "transparent", color: T.accent, fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", padding: 0 }}>
              {showWords ? "Hide the transcript" : "Show the transcript"}
            </button>
            {showWords && (
              <pre style={{ ...quiet, whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", marginTop: 8, padding: 12, background: T.deep, border: `1px solid ${T.rule}`, borderRadius: 2 }}>{transcript}</pre>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Button writes disabled={stage === "posting" || !minutes.trim()} onClick={post}>
              {stage === "posting" ? `Posting ${progress && progress.word ? progress.word : ""}…` : "Post"}
            </Button>
            <Button variant="quiet" disabled={stage === "posting"} onClick={() => discard()}>Discard</Button>
          </div>
        </div>
      )}

      {stage === "error" && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="ghost" onClick={tryAgain}>Try again</Button>
          <Button variant="quiet" onClick={() => discard()}>Discard</Button>
        </div>
      )}

      {err && <div style={{ fontFamily: T.body, fontSize: 13, color: T.bRed, marginTop: 10, lineHeight: 1.6 }}>{err}</div>}
    </div>
  );
}

/** The Transcript and Recording links beside a meeting's minutes. */
function AlsoLink({ label, url }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      style={{ fontFamily: T.display, fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: T.accent, textDecoration: "none" }}>
      {label}
    </a>
  );
}
