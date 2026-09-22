/* AI Checker — the Admin tab of that name.
 *
 * Spliced into source/index.html by the build, so there is no import or
 * export here: by the time it runs it is the same one file it always was.
 * The shell holds the theme, the shared components and the state; this
 * holds what is only this tab's. See tools/source.mjs.
 */
function AiChecker({ log }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);   // staged for the next question
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");            // what it is reading on the portal
  const [reading, setReading] = useState(false);   // opening a dropped workbook
  const [error, setError] = useState(null);
  const endRef = useRef(null);
  const boxRef = useRef(null);
  const pickRef = useRef(null);

  // Keep the newest words in view while an answer is arriving, but only when
  // the reader is already at the bottom — someone scrolled up to re-read an
  // earlier answer shouldn't be dragged back down by the stream.
  React.useEffect(() => {
    const box = boxRef.current;
    if (!box || !endRef.current) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (nearBottom) endRef.current.scrollIntoView({ block: "nearest" });
  }, [messages]);

  const attach = async (list) => {
    const picked = Array.from(list || []);
    if (!picked.length) return;
    setError(null);
    setReading(true);
    const staged = [...files];
    for (const f of picked) {
      const kind = aiAttachKind(f);
      if (!kind) {
        setError(`${f.name} ${AI_ATTACH_REJECTED}`);
        continue;
      }
      if (staged.length >= AI_ATTACH_MAX_FILES) {
        setError(`A question carries up to ${AI_ATTACH_MAX_FILES} files. Send these, then attach the rest to a follow-up.`);
        break;
      }
      // A spreadsheet is read here and goes up as the text of its sheets, so it
      // is measured by what the browser will open rather than by what the
      // request carries.
      if (kind.sheet) {
        if (f.size > AI_SHEET_MAX_BYTES) {
          setError(`${f.name} is too big to open here — spreadsheets are limited to ${Math.floor(AI_SHEET_MAX_BYTES / 1024 / 1024)}MB.`);
          continue;
        }
        try {
          staged.push({ name: f.name, type: kind.type, size: f.size, text: await aiSheetText(f) });
        } catch (e) {
          setError(`${f.name} couldn't be read as a spreadsheet: ${e.message || e}`);
        }
        continue;
      }
      const total = staged.reduce((n, x) => n + (x.data ? x.size : 0), 0) + f.size;
      if (f.size > AI_ATTACH_MAX_BYTES || total > AI_ATTACH_MAX_BYTES) {
        setError(`Images and PDFs are limited to ${Math.floor(AI_ATTACH_MAX_BYTES / 1024 / 1024)}MB per question, and ${f.name} takes it past that. Send it on its own, or use a smaller copy.`);
        continue;
      }
      try {
        staged.push({ name: f.name, type: kind.type, size: f.size, data: await readFileAsB64(f) });
      } catch (e) {
        setError(e.message || String(e));
      }
    }
    setFiles(staged);
    setReading(false);
  };

  // The messages as sent up: everything said, plus as much attachment data as
  // one request can carry, newest first. Sheet text is budgeted apart from the
  // bytes, since it costs the request something quite different. Older files
  // fall back to name-only markers so the model knows they existed even once
  // their contents are gone.
  const payloadFrom = (history) => {
    let left = AI_ATTACH_PAYLOAD_BUDGET;
    let sheetLeft = AI_SHEET_PAYLOAD_BUDGET;
    const out = history.map((m) => ({ role: m.role, content: m.content, attachments: m.attachments }));
    for (let i = out.length - 1; i >= 0; i--) {
      if (!out[i].attachments || !out[i].attachments.length) continue;
      out[i] = {
        ...out[i],
        attachments: out[i].attachments.map((f) => {
          if (f.text) {
            if (f.text.length <= sheetLeft) { sheetLeft -= f.text.length; return { name: f.name, type: f.type, text: f.text }; }
            return { name: f.name, type: f.type };
          }
          if (f.data && f.data.length <= left) { left -= f.data.length; return { name: f.name, type: f.type, data: f.data }; }
          return { name: f.name, type: f.type };
        }),
      };
    }
    return out;
  };

  const send = async () => {
    const q = input.trim();
    if ((!q && !files.length) || busy) return;
    const mine = { role: "user", content: q };
    if (files.length) mine.attachments = files;
    const history = [...messages, mine];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setFiles([]);
    setBusy(true);
    setStep("");
    setError(null);
    const line = q || files.map((f) => f.name).join(", ");
    log("AI Checker", files.length ? `Question with ${files.length} file${files.length > 1 ? "s" : ""} put to the AI` : "Question put to the AI",
      line.slice(0, 90) + (line.length > 90 ? "..." : ""));

    try {
      // The question is written down on the server and answered by a background
      // worker, which has fifteen minutes where this request has sixty seconds.
      const started = await askChecker({ messages: payloadFrom(history) });
      if (!started.jobId) throw new Error("The AI didn't take the question. Ask again.");

      // The server sets the worker going itself unless the portal's password
      // protection turned its own call away — then it says where, and this
      // browser, which has the password answer, starts it instead.
      if (started.startPath) await startAnalysisWorker(started.startPath, started.jobId, "question");

      // The answer is read out of the job a few words at a time, so it still
      // types itself out however long the model takes over it.
      const answer = await readCheckerAnswer(
        started.jobId,
        (sofar) => setMessages([...history, { role: "assistant", content: sofar }]),
        (line) => setStep(line),
      );
      setMessages([...history, { role: "assistant", content: answer }]);
    } catch (e) {
      setError(e.message || String(e));
      // The question stays in the thread so it can be sent again; only the
      // empty answer bubble comes off.
      setMessages(history);
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  return (
    <div>
      <SectionHead title="AI Checker" meta={messages.length ? `${messages.filter((m) => m.role === "user").length} asked this visit` : "Ask anything"} />
      <div style={{ fontFamily: T.body, fontSize: 14, color: T.muted, marginBottom: 18, lineHeight: 1.6 }}>
        Ask the AI whatever you want — check a calculation, draft a message, explain a procedure,
        or hand it something to read: paste text in, or attach a file and ask about it. It takes
        images, PDFs and Excel spreadsheets (XLSX, XLSM, XLS, CSV) — drag them onto the box below
        or use the button. A spreadsheet is opened here and its sheets go up as rows the AI can read.
        It can also see the portal: the roster, notes, correspondence, comments, the crew matrix,
        every file that has been uploaded and every certificate on file — including the scans
        themselves — along with the answers the portal's own checks have already produced. So you can
        ask it about a person, a document or a date and it will go and look. It reads the portal and
        never changes anything on it, and it can't run the checks on the other pages — it reads the
        answers those pages have already made, and will tell you when one is old.
        The conversation isn't kept: it belongs to this browser, this visit, and the server
        holds a question only for as long as it takes to answer it.
      </div>

      {messages.length > 0 && (
        <div ref={boxRef} style={{ background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 2,
          padding: 16, marginBottom: 14, maxHeight: "55vh", overflowY: "auto" }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              marginBottom: i === messages.length - 1 ? 0 : 12 }}>
              <div style={{ maxWidth: "82%", borderRadius: 2, padding: "10px 13px",
                background: m.role === "user" ? T.accentSoft : T.raised,
                border: `1px solid ${m.role === "user" ? "transparent" : T.rule}` }}>
                <div style={{ marginBottom: 5 }}>
                  <Eyebrow color={m.role === "user" ? T.accent : T.teal}>{m.role === "user" ? "You" : "AI"}</Eyebrow>
                </div>
                {m.attachments && m.attachments.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: m.content ? 7 : 0 }}>
                    {m.attachments.map((f, j) => (
                      <Chip key={j} fg={T.accent} bg={T.panel}>{f.text ? "▦" : "📎"} {f.name}</Chip>
                    ))}
                  </div>
                )}
                <div style={{ ...tx.para, fontSize: 14,
                  ...(!m.content && busy ? { color: T.muted, fontStyle: "italic" } : null) }}>
                  {m.content || (busy && i === messages.length - 1 && m.role === "assistant" ? (step || "Thinking...") : "")}
                </div>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      {error && (
        <div style={{ background: T.bRedBg, border: `1px solid ${T.bRed}`, borderRadius: 2, padding: "10px 13px",
          marginBottom: 14, fontFamily: T.body, fontSize: 14, color: T.bRed }}>
          {error}
        </div>
      )}

      {/* Files can be dropped anywhere on the box below, or picked with the
          button in it. Nothing is filtered on the way in: everything dropped
          goes to attach(), which says by name what it can't take. */}
      <DropSpot onFiles={attach} disabled={busy || reading}
        style={{ background: T.panel, border: `1px solid ${T.rule}`, padding: 16 }}>
        <div style={{ marginBottom: 11 }}><Eyebrow color={T.accent}>{messages.length ? "Ask a follow-up" : "Ask the AI"}</Eyebrow></div>
        <div style={{ display: "grid", gap: 10 }}>
          <textarea className="um-in" rows={3} value={input} disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            style={{ resize: "vertical", lineHeight: 1.55 }}
            placeholder="Anything at all. Enter sends it; Shift+Enter starts a new line." />
          {files.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {files.map((f, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 7,
                  background: T.raised, border: `1px solid ${T.rule}`, borderRadius: 2, padding: "5px 9px",
                  fontFamily: T.mono, fontSize: 11, color: T.text }}>
                  {f.text ? "▦" : "📎"} {f.name}
                  <span style={{ color: T.muted }}>
                    {f.text
                      ? `${Math.max(1, Math.round(f.text.length / 1000))}k of rows`
                      : f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(f.size / 1024))}KB`}
                  </span>
                  <button className="um-btn" disabled={busy} title={`Remove ${f.name}`}
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    style={{ background: "transparent", color: T.muted, padding: 0, fontSize: 13, lineHeight: 1 }}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Button onClick={send} disabled={busy || reading || (!input.trim() && !files.length)}>{busy ? "Answering..." : "Ask"}</Button>
            <input ref={pickRef} type="file" multiple accept={AI_ATTACH_ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => { attach(e.target.files); e.target.value = ""; }} />
            <Button variant="quiet" disabled={busy || reading || files.length >= AI_ATTACH_MAX_FILES}
              onClick={() => pickRef.current && pickRef.current.click()}>
              {reading ? "Reading the file..." : "Attach a file"}
            </Button>
            {messages.length > 0 && !busy && (
              <Button variant="quiet" onClick={() => { setMessages([]); setFiles([]); setError(null); }}>Start over</Button>
            )}
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
              or drop files anywhere on this box
            </span>
            <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 11, color: T.muted }}>
              Answers come from an AI and can be wrong — check anything that matters.
            </span>
          </div>
        </div>
      </DropSpot>
    </div>
  );
}
