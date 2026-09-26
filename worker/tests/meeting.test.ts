/**
 * The safety meeting recorder: the pieces the sound is cut into and the
 * WAV they are sent as, the transcript put back together, the minutes laid
 * out as text and as a Word document, a meeting's three files folded onto
 * one line, and the worker's two routes - the speech-to-text and the
 * minutes.
 *
 *   npx tsx --test tests/meeting.test.ts      (or: node tools/check.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIECE_RATE, PIECE_SECONDS, PIECE_MAX_BYTES, MEETING_TAGS, MINUTES_HEADINGS, DOCX_MIME,
  pieceEnd, downsample, wavBytes, stampOf, joinPieces, minutesText, minutesLines, minutesDocxParts, minutesDocument,
  meetingTitle, meetingFileName, transcriptText, actionLine, meetingRows,
} from "../../source/shared/meeting.js";
import { crc32, deflateRaw, writeZip, readZip, partOf, partText } from "../../source/shared/workbook.js";
import meeting, {
  hearingPrompt, base64Of, transcribePiece, writeMinutes, WHISPER, MINUTES_MODEL, NO_SPEECH_TO_TEXT, MINUTES_SYSTEM,
} from "../src/routes/meeting.js";
import { setEnv, type PortalEnv } from "../src/env.js";
import type { PortalUser } from "../src/auth.js";
import { fakeDb } from "./helpers.js";

/* ------------------------------------------------------------ the sound --- */

/** `seconds` of noise at the rate, quiet between `quietFrom` and `quietTo`. */
function noise(seconds: number, rate: number, quietFrom = -1, quietTo = -1) {
  const out = new Float32Array(Math.round(seconds * rate));
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = i / rate;
    out[i] = t >= quietFrom && t < quietTo ? 0 : (seed / 0x7fffffff - 0.5) * 0.6;
  }
  return out;
}

test("a piece ends a minute on, at the quietest moment of the last ten seconds", () => {
  const rate = PIECE_RATE;
  const gap = noise(70, rate, 55, 55.5);
  const end = pieceEnd(gap, rate, 0);
  assert.ok(end / rate >= 55 && end / rate <= 55.5, `cut at ${end / rate}s, wanted inside the quiet half-second at 55s`);
  // No quiet moment: still within the last ten seconds of the minute.
  const loud = noise(70, rate);
  const at = pieceEnd(loud, rate, 0) / rate;
  assert.ok(at >= PIECE_SECONDS - 10 && at <= PIECE_SECONDS, `cut at ${at}s`);
  // A piece starting later is measured from its own start.
  const later = pieceEnd(gap, rate, 5 * rate) / rate;
  assert.ok(later >= 55 && later <= 65, `cut at ${later}s`);
  // Less than a minute left: the rest is the piece.
  assert.equal(pieceEnd(gap, rate, 30 * rate), gap.length);
  assert.equal(pieceEnd(new Float32Array(100), rate, 0), 100);
});

test("a faster microphone is brought down to the pieces' rate by averaging", () => {
  const fast = new Float32Array(48000);
  for (let i = 0; i < fast.length; i++) fast[i] = i % 3 === 0 ? 0.3 : 0;
  const slow = downsample(fast, 48000, 16000);
  assert.equal(slow.length, 16000);
  assert.ok(Math.abs(slow[10] - 0.1) < 1e-6, "three samples averaged into one");
  const same = new Float32Array(10);
  assert.equal(downsample(same, 16000, 16000), same, "the rate asked for is left alone");
  assert.equal(downsample(same, 8000, 16000), same, "a slower one is not made up");
});

test("the WAV a piece is sent as has its header right and its samples clamped", () => {
  const samples = new Float32Array([0, 1, -1, 0.5, 2, -2]);
  const wav = wavBytes(samples, PIECE_RATE);
  const v = new DataView(wav.buffer);
  const tag = (at: number) => String.fromCharCode(wav[at], wav[at + 1], wav[at + 2], wav[at + 3]);
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(tag(12), "fmt ");
  assert.equal(tag(36), "data");
  assert.equal(v.getUint16(20, true), 1, "PCM");
  assert.equal(v.getUint16(22, true), 1, "mono");
  assert.equal(v.getUint32(24, true), PIECE_RATE);
  assert.equal(v.getUint32(28, true), PIECE_RATE * 2, "bytes a second");
  assert.equal(v.getUint16(34, true), 16, "bits");
  assert.equal(v.getUint32(40, true), samples.length * 2);
  assert.equal(v.getUint32(4, true), 36 + samples.length * 2);
  assert.equal(wav.length, 44 + samples.length * 2);
  assert.equal(v.getInt16(44, true), 0);
  assert.equal(v.getInt16(46, true), 0x7fff);
  assert.equal(v.getInt16(48, true), -0x8000);
  assert.equal(v.getInt16(52, true), 0x7fff, "over full scale is clamped");
  assert.equal(v.getInt16(54, true), -0x8000);
  // A minute at the pieces' rate is well under what the worker takes.
  assert.ok(44 + PIECE_SECONDS * PIECE_RATE * 2 < PIECE_MAX_BYTES);
});

test("the transcript is each piece's words under the minute it began at", () => {
  assert.equal(stampOf(0), "[00:00]");
  assert.equal(stampOf(61.7), "[01:01]");
  assert.equal(stampOf(3600), "[60:00]");
  const words = joinPieces([
    { at: 0, text: "  Right, let's  start.\nFirst item. " },
    { at: 59.4, text: "   " },
    { at: 119.8, text: "Gangway netting." },
  ]);
  assert.equal(words, "[00:00] Right, let's start. First item.\n\n[01:59] Gangway netting.");
  assert.equal(joinPieces([]), "");
});

/* ---------------------------------------------------------- the minutes --- */

const MINUTES = {
  present: ["Alan Smith (Master)", "Bob Jones (Chief Officer)", ""],
  apologies: [],
  items: [
    { heading: "Gangway netting", discussion: "The netting on the port gangway is torn.", decided: "Replace it before the next port call.", actions: [{ what: "Order a new net", who: "Bob Jones", when: "Friday" }] },
    { heading: "Fire drill", discussion: "The drill went well.", decided: null, actions: [] },
  ],
  nextMeeting: "The last Sunday of the month.",
  toCheck: ["Who took the action on the galley extractor - two names were said."],
};

test("the minutes are laid out under the headings, the actions listed twice and nothing added", () => {
  const text = minutesText(MINUTES, { title: "Vessel safety meeting - 26 Sep 2026", chair: "Alan Smith" });
  const lines = text.split("\n");
  assert.equal(lines[0], "Vessel safety meeting - 26 Sep 2026");
  assert.equal(lines[1], "Chaired by Alan Smith");
  assert.ok(text.includes("\nPresent\n- Alan Smith (Master)\n- Bob Jones (Chief Officer)\n"), text);
  assert.ok(!text.includes("Apologies"), "an empty list is left out");
  assert.ok(text.includes("\nItems raised\n1. Gangway netting\nThe netting on the port gangway is torn.\nDecided: Replace it before the next port call.\nAction: Order a new net - Bob Jones, by Friday\n"), text);
  assert.ok(text.includes("\n2. Fire drill\nThe drill went well.\n"), text);
  assert.ok(text.includes("\nActions\n- Order a new net - Bob Jones, by Friday\n"), text);
  assert.ok(text.includes("\nNext meeting\nThe last Sunday of the month.\n"), text);
  assert.ok(text.includes("\nTo check\n- Who took the action on the galley extractor - two names were said.\n"), text);
  assert.ok(!/\n\n\n/.test(text), "never two blank lines together");
  // Nothing heard about: said so, not made up.
  const bare = minutesText({}, { title: "Vessel safety meeting - 1 Oct 2026" });
  assert.ok(bare.includes("\nPresent\n- nobody named\n"), bare);
  assert.ok(bare.includes("\nItems raised\n- none\n"), bare);
  assert.ok(bare.includes("\nActions\n- none\n"), bare);
  assert.ok(!bare.includes("Next meeting"));
  assert.equal(minutesText(null as never, {}).split("\n")[0], "Vessel safety meeting");
  assert.equal(actionLine({ what: "Check the net" }), "Check the net");
  assert.equal(actionLine({ what: "", who: "Bob" }), "");
  assert.equal(actionLine("plain words"), "plain words");
});

test("the minutes as typed read back line by line", () => {
  const text = minutesText(MINUTES, { title: "Vessel safety meeting - 26 Sep 2026", chair: "Alan Smith" });
  const kinds = minutesLines(text).map((l) => l.kind);
  assert.deepEqual(kinds.slice(0, 6), ["title", "sub", "heading", "bullet", "bullet", "heading"]);
  assert.ok(kinds.includes("item"));
  assert.ok(kinds.includes("para"));
  const back = minutesLines("Meeting\n\nPRESENT:\n* Alan\n3) Third item\njust words\n");
  assert.deepEqual(back, [
    { kind: "title", text: "Meeting" },
    { kind: "heading", text: "PRESENT" },
    { kind: "bullet", text: "Alan" },
    { kind: "item", text: "3) Third item" },
    { kind: "para", text: "just words" },
  ]);
  assert.deepEqual(minutesLines(""), []);
  assert.equal(MINUTES_HEADINGS.length, 6);
});

test("the Word document carries the minutes with the headings in bold and the marks escaped", async () => {
  const text = "Vessel safety meeting - 26 Sep 2026\nChaired by Alan Smith\n\nPresent\n- Alan & Bob <both>\n\nItems raised\n1. Netting\nDecided: replace it\nAction: order one - Bob\n";
  const parts = minutesDocxParts(text);
  assert.deepEqual(parts.map((p) => p.name), ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  const doc = parts[2].xml;
  assert.ok(doc.includes("<w:b/><w:sz w:val=\"36\"/></w:rPr><w:t xml:space=\"preserve\">Vessel safety meeting - 26 Sep 2026</w:t>"), "the title in bold");
  assert.ok(doc.includes("<w:i/><w:sz w:val=\"22\"/></w:rPr><w:t xml:space=\"preserve\">Chaired by Alan Smith</w:t>"), "who chaired, in italics");
  assert.ok(doc.includes("<w:b/><w:sz w:val=\"28\"/></w:rPr><w:t xml:space=\"preserve\">Present</w:t>"), "a heading");
  assert.ok(doc.includes("Alan &amp; Bob &lt;both&gt;"), "escaped");
  assert.ok(doc.includes('<w:ind w:left="360" w:hanging="360"/>'), "a bullet is indented");
  assert.ok(doc.includes("<w:b/><w:sz w:val=\"22\"/></w:rPr><w:t xml:space=\"preserve\">Decided: </w:t>"), "Decided in bold");
  assert.ok(doc.includes("<w:b/><w:sz w:val=\"22\"/></w:rPr><w:t xml:space=\"preserve\">Action: </w:t>"), "Action in bold");
  assert.ok(doc.includes("<w:sectPr>"), "a page");
  assert.ok(parts[0].xml.includes("wordprocessingml.document.main+xml"));
  assert.ok(parts[1].xml.includes('Target="word/document.xml"'));

  const blob = await minutesDocument(text, { crc32, deflateRaw, writeZip });
  assert.equal(blob.type, DOCX_MIME);
  const entries = readZip(await blob.arrayBuffer());
  assert.deepEqual(entries.map((e) => e.name), ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  assert.equal(await partText(partOf(entries, "word/document.xml")), doc, "the document, deflated and read back");
});

test("the meeting's names and files", () => {
  assert.equal(meetingTitle("2026-09-26"), "Vessel safety meeting - 26 Sep 2026");
  assert.equal(meetingTitle("2026-01-05T10:14:00.000Z"), "Vessel safety meeting - 5 Jan 2026");
  assert.equal(meetingFileName("2026-09-26", "minutes", "docx"), "Vessel safety meeting 2026-09-26 - minutes.docx");
  assert.equal(meetingFileName("2026-09-26", "recording", "webm"), "Vessel safety meeting 2026-09-26 - recording.webm");
  assert.equal(transcriptText("[00:00] Words.", { title: "Vessel safety meeting - 26 Sep 2026", chair: "Alan Smith" }),
    "Vessel safety meeting - 26 Sep 2026\nChaired by Alan Smith\n\n[00:00] Words.\n");
  assert.equal(transcriptText("Words.", {}), "Vessel safety meeting\n\nWords.\n");
});

test("a meeting's transcript and recording sit on its minutes' line", () => {
  const title = "Vessel safety meeting - 26 Sep 2026";
  const rows = meetingRows([
    { id: "r", title, tag: MEETING_TAGS.recording, url: "/api/files/r" },
    { id: "t", title, tag: MEETING_TAGS.transcript, url: "/api/files/t" },
    { id: "m", title, tag: MEETING_TAGS.minutes, url: "/api/files/m" },
    { id: "x", title: "Something else", tag: "Monthly", url: "/api/files/x" },
    { id: "lone", title: "Vessel safety meeting - 1 Aug 2026", tag: MEETING_TAGS.transcript, url: "/api/files/lone" },
    { id: "m2", title, tag: MEETING_TAGS.minutes, url: "/api/files/m2" },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["m", "x", "lone", "m2"], "the three are one line, in the minutes' place");
  assert.deepEqual((rows[0] as { also: { label: string; doc: { id: string } }[] }).also.map((a) => [a.label, a.doc.id]), [["Recording", "r"], ["Transcript", "t"]]);
  assert.equal((rows[2] as { also?: unknown }).also, undefined, "a transcript with no minutes stays a line of its own");
  assert.equal((rows[3] as { also?: unknown }).also, undefined, "a second minutes for the day is its own line");
  assert.deepEqual(meetingRows([]), []);
  assert.deepEqual(meetingRows(null as never), []);
});

/* ----------------------------------------------------------- the worker --- */

const user = { id: "u1", email: "master@example.com", name: "Alan Smith", role: "management" } as PortalUser;
const post = (path: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request(`https://portal.test${path}`, { method: "POST", body, headers });

/** An env for the routes: no library, a database that has no document, and
 *  whatever else the test hands over. */
function envWith(extra: Partial<PortalEnv> = {}) {
  setEnv({ DB: fakeDb(() => ({ results: [] })) as unknown as D1Database, ...extra } as PortalEnv);
}

test("the speech-to-text is told the vessel and the crew's names", () => {
  const prompt = hearingPrompt([{ name: "Alan Smith" }, { name: " Bob Jones " }, { name: "Gone Man", active: false }, { name: "" }, {}], "TSV Example");
  assert.equal(prompt, "A vessel safety meeting aboard TSV Example. Crew: Alan Smith, Bob Jones.");
  assert.equal(hearingPrompt([], "TSV Example"), "A vessel safety meeting aboard TSV Example.");
  const many = hearingPrompt(Array.from({ length: 60 }, (_, i) => ({ name: `Man ${i}` })), "V");
  assert.equal(many.split(",").length, 40, "the prompt the model takes is short: forty names at most");
});

test("a minute of sound is base64 the way the service wants it", () => {
  const bytes = new Uint8Array(100 * 1024 + 13);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  assert.equal(base64Of(bytes), Buffer.from(bytes).toString("base64"));
  assert.equal(base64Of(new Uint8Array(0)), "");
});

test("a piece is heard by Workers AI with the prompt, and without the binding the page is told", async () => {
  const asked: { model: string; inputs: Record<string, unknown> }[] = [];
  const ai = { run: async (model: string, inputs: Record<string, unknown>) => { asked.push({ model, inputs }); return { text: "  Right, let's start.  " }; } };
  envWith({ AI: ai as unknown as Ai });
  const wav = wavBytes(new Float32Array(160), PIECE_RATE);
  const heard = await transcribePiece(wav.buffer as ArrayBuffer, "A vessel safety meeting aboard TSV Example.");
  assert.equal(heard, "Right, let's start.");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].model, WHISPER);
  assert.equal(asked[0].inputs.audio, Buffer.from(wav).toString("base64"));
  assert.equal(asked[0].inputs.task, "transcribe");
  assert.equal(asked[0].inputs.language, "en");
  assert.equal(asked[0].inputs.vad_filter, true);
  assert.equal(asked[0].inputs.initial_prompt, "A vessel safety meeting aboard TSV Example.");
  // Nothing heard is no words, not a crash.
  ai.run = async () => ({} as { text: string });
  assert.equal(await transcribePiece(wav.buffer as ArrayBuffer, ""), "");

  envWith();
  await assert.rejects(transcribePiece(wav.buffer as ArrayBuffer, ""), (e: Error) => e.message === NO_SPEECH_TO_TEXT);
});

test("POST /api/meeting/transcribe answers the words, and refuses nothing, too much, or a GET", async () => {
  const ai = { run: async () => ({ text: "Gangway netting." }) };
  envWith({ AI: ai as unknown as Ai });
  const wav = wavBytes(new Float32Array(1600), PIECE_RATE);
  const ok = await meeting(post("/api/meeting/transcribe?piece=1&of=3", wav, { "Content-Type": "audio/wav" }), user, "/api/meeting/transcribe");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { text: "Gangway netting." });
  assert.equal(ok.headers.get("Cache-Control"), "no-store");

  const empty = await meeting(post("/api/meeting/transcribe", null), user, "/api/meeting/transcribe");
  assert.equal(empty.status, 400);

  const big = await meeting(post("/api/meeting/transcribe", new Uint8Array(PIECE_MAX_BYTES + 1)), user, "/api/meeting/transcribe");
  assert.equal(big.status, 413);
  assert.match(((await big.json()) as { error: string }).error, /3 MB/);

  const get = await meeting(new Request("https://portal.test/api/meeting/transcribe"), user, "/api/meeting/transcribe");
  assert.equal(get.status, 405);
  const lost = await meeting(post("/api/meeting/nothing", null), user, "/api/meeting/nothing");
  assert.equal(lost.status, 404);

  // The service refusing is said, and is not a crash.
  ai.run = async () => { throw new Error("AiError: 3010: Audio too long"); };
  const no = await meeting(post("/api/meeting/transcribe", wav, { "Content-Type": "audio/wav" }), user, "/api/meeting/transcribe");
  assert.equal(no.status, 502);
  assert.equal(((await no.json()) as { error: string }).error, "The speech-to-text couldn't hear that piece: AiError: 3010: Audio too long");

  envWith();
  const off = await meeting(post("/api/meeting/transcribe", wav, { "Content-Type": "audio/wav" }), user, "/api/meeting/transcribe");
  assert.equal(off.status, 502);
  assert.equal(((await off.json()) as { error: string }).error, NO_SPEECH_TO_TEXT);
});

/** The model answering /v1/messages the way it streams. */
function modelSays(answer: (body: string) => { status: number; body: string }) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/v1/messages")) return realFetch(input, init);
    calls.push(String(init?.body || ""));
    const { status, body } = answer(calls[calls.length - 1]);
    return new Response(body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
const streamed = (json: unknown, stop = "end_turn") =>
  `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify(json) } })}\n\n`
  + `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stop } })}\n\n`;

test("the minutes are asked of the larger model with the transcript and the register, and laid out", async () => {
  envWith({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://model.test" });
  const model = modelSays(() => ({ status: 200, body: streamed(MINUTES) }));
  try {
    const got = await writeMinutes({
      transcript: "[00:00] Right, let's start. The netting on the port gangway is torn.",
      title: "Vessel safety meeting - 26 Sep 2026", chair: "Alan Smith", date: "2026-09-26",
      people: [{ name: "Alan Smith" }, { name: "Bob Jones" }, { name: "Gone Man", active: false }],
    });
    assert.equal(model.calls.length, 1);
    const sent = JSON.parse(model.calls[0]) as { model: string; system: string; messages: { content: { text: string }[] }[]; max_tokens: number };
    assert.equal(sent.model, MINUTES_MODEL);
    assert.equal(sent.system, MINUTES_SYSTEM);
    const text = sent.messages[0].content[0].text;
    assert.ok(text.includes("Meeting: Vessel safety meeting - 26 Sep 2026, aboard "), text);
    assert.ok(text.includes("chaired by Alan Smith, 2026-09-26."), text);
    assert.ok(text.includes("Crew register: Alan Smith; Bob Jones."), "the register's spellings, the man off the strength left out");
    assert.ok(text.endsWith("\nTranscript:\n[00:00] Right, let's start. The netting on the port gangway is torn."), text);
    assert.ok(sent.max_tokens >= 8000, "room for an hour's minutes");
    assert.equal(got.truncated, false);
    assert.ok(got.text.startsWith("Vessel safety meeting - 26 Sep 2026\nChaired by Alan Smith\n\nPresent\n- Alan Smith (Master)\n"), got.text);
    assert.ok(got.text.includes("Action: Order a new net - Bob Jones, by Friday"), got.text);
  } finally {
    model.restore();
  }

  // Cut off partway: what came is kept and said.
  const cut = modelSays(() => ({ status: 200, body: streamed(MINUTES, "max_tokens") }));
  try {
    const got = await writeMinutes({ transcript: "words", title: "T", chair: "C", date: "2026-09-26", people: [] });
    assert.equal(got.truncated, true);
    assert.ok(got.text.endsWith("(The minutes stopped partway - the model ran out of room. Check the end.)\n"), got.text);
  } finally {
    cut.restore();
  }
});

test("POST /api/meeting/minutes wants a transcript, and says why when the model refuses", async () => {
  envWith({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://model.test" });
  const none = await meeting(post("/api/meeting/minutes", JSON.stringify({ transcript: "  " }), { "Content-Type": "application/json" }), user, "/api/meeting/minutes");
  assert.equal(none.status, 400);
  const junk = await meeting(post("/api/meeting/minutes", "not json", { "Content-Type": "application/json" }), user, "/api/meeting/minutes");
  assert.equal(junk.status, 400);

  const model = modelSays((body) => ({ status: 200, body: streamed({ present: [JSON.parse(body).messages[0].content[0].text.includes("chaired by Alan Smith, 2026-09-26.") ? "Alan Smith" : "wrong"] }) }));
  try {
    const ok = await meeting(post("/api/meeting/minutes", JSON.stringify({ transcript: "[00:00] Words.", date: "2026-09-26" }), { "Content-Type": "application/json" }), user, "/api/meeting/minutes");
    assert.equal(ok.status, 200);
    const got = (await ok.json()) as { text: string; truncated: boolean };
    assert.ok(got.text.startsWith("Vessel safety meeting - 26 Sep 2026\nChaired by Alan Smith\n\nPresent\n- Alan Smith\n"), "the signed-in name chairs where none was sent; the date names the meeting");
    assert.equal(got.truncated, false);
  } finally {
    model.restore();
  }

  const credit = modelSays(() => ({ status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }) }));
  try {
    const no = await meeting(post("/api/meeting/minutes", JSON.stringify({ transcript: "Words." }), { "Content-Type": "application/json" }), user, "/api/meeting/minutes");
    assert.equal(no.status, 502);
    const said = ((await no.json()) as { error: string }).error;
    assert.ok(said && !/credit balance is too low/.test(said), `the account's own short sentence, not the API's: ${said}`);
  } finally {
    credit.restore();
  }
});
