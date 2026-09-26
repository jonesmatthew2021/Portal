import { getEnv } from "../env.js";
import type { PortalUser } from "../auth.js";
import { askJson, errorLine } from "../lib/analysis.js";
import { readDocument } from "../lib/shared-state.js";
import { vessel } from "../vessel.js";
import { PIECE_MAX_BYTES, minutesText, meetingTitle } from "../../../source/shared/meeting.js";

/**
 * The safety meeting, recorded on the Vessel Safety Meeting Minutes page
 * (source/parts/safety-meeting.jsx) and written out here.
 *
 *   POST /api/meeting/transcribe   one piece of the sound (a 16 kHz mono
 *                                  WAV of about a minute, cut on the page
 *                                  by the rules in source/shared/meeting.js)
 *                                  -> { text }
 *   POST /api/meeting/minutes      { transcript, date, chair } -> { text }:
 *                                  the minutes, laid out as the plain text
 *                                  the page shows for correcting
 *
 * The speech-to-text is Cloudflare's own (Workers AI, the AI binding in
 * wrangler.toml): on this account, no other key or bill. The minutes are the
 * model's, through the same door the certificate readings go through
 * (askJson in lib/analysis.ts), so a refusal is said in the same words.
 * Management and IT logins only - the crew rule in authz.ts lets no crew
 * POST reach here.
 */

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

export const WHISPER = "@cf/openai/whisper-large-v3-turbo" as const;
export const MINUTES_MODEL = "claude-opus-5";

export const NO_SPEECH_TO_TEXT =
  "Speech-to-text is not switched on for this deploy yet - the worker has no AI binding (wrangler.toml).";

type Person = { name?: unknown; active?: unknown };

/** The names the speech-to-text is told to expect, so a crew member's name
 *  comes out spelt as the register spells it: the vessel and everyone on
 *  the strength, in the short prompt the model takes. */
export function hearingPrompt(people: Person[], vesselName: string): string {
  const names = (people || [])
    .filter((p) => p && typeof p.name === "string" && p.active !== false)
    .map((p) => String(p.name).trim())
    .filter(Boolean)
    .slice(0, 40);
  return `A vessel safety meeting aboard ${vesselName}.` + (names.length ? ` Crew: ${names.join(", ")}.` : "");
}

/** Base64 of the bytes, a slice at a time - btoa over a whole minute of
 *  sound in one call would overflow the stack. */
export function base64Of(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** One piece heard by Workers AI: the words, trimmed. */
export async function transcribePiece(bytes: ArrayBuffer, prompt: string): Promise<string> {
  const ai = getEnv().AI;
  if (!ai) throw new Error(NO_SPEECH_TO_TEXT);
  const heard = (await ai.run(WHISPER, {
    audio: base64Of(new Uint8Array(bytes)),
    task: "transcribe",
    language: "en",
    // Silence is skipped before the model hears it: a quiet stretch is
    // where it makes words up.
    vad_filter: true,
    initial_prompt: prompt,
  })) as { text?: unknown };
  return typeof heard?.text === "string" ? heard.text.trim() : "";
}

const vesselName = () => `${vessel.name} ${vessel.nameAccent}`.trim();

async function crewOnTheBooks(): Promise<Person[]> {
  const cur = await readDocument().catch(() => null);
  const people = (cur?.doc as { people?: unknown } | undefined)?.people;
  return Array.isArray(people) ? (people as Person[]) : [];
}

/* ----------------------------------------------------------- the minutes --- */

export const MINUTES_SYSTEM = `You write the minutes of a vessel safety meeting from its transcript. The transcript was made by speech-to-text from a recording: names may be misspelt (the crew register is given - use its spellings), and some words will be wrong.

Write what was said, in plain English, in the third person and the past tense. Do not add anything the transcript does not say. Where the transcript leaves something unclear - who spoke, a name, a number, whether an action was agreed - say so under "toCheck" rather than guessing.

Answer with one JSON object and nothing else:
{
  "present": ["name (rank where said)"],
  "apologies": ["name"],
  "items": [
    {
      "heading": "a few words naming the item",
      "discussion": "what was raised and said about it, in one to four sentences",
      "decided": "what was decided, or null",
      "actions": [{ "what": "the thing to be done", "who": "who took it on, or null", "when": "by when, as said, or null" }]
    }
  ],
  "nextMeeting": "when the next meeting is, as said, or null",
  "toCheck": ["what the transcript did not make clear, one line each"]
}`;

/**
 * The minutes, from the transcript: the model's JSON laid out as the text
 * the page shows. A partial answer (the model cut off) is kept and said.
 */
export async function writeMinutes(opts: { transcript: string; title: string; chair: string; date: string; people: Person[] }) {
  const register = opts.people
    .filter((p) => p && typeof p.name === "string" && p.active !== false)
    .map((p) => String(p.name).trim())
    .filter(Boolean);
  const { json: minutes, truncated } = await askJson({
    model: MINUTES_MODEL,
    system: MINUTES_SYSTEM,
    content: [{
      type: "text",
      text: `Meeting: ${opts.title}, aboard ${vesselName()}, chaired by ${opts.chair || "the Master"}, ${opts.date}.\n`
        + (register.length ? `Crew register: ${register.join("; ")}.\n` : "")
        + `\nTranscript:\n${opts.transcript}`,
    }],
    maxTokens: 16000,
    effort: "high",
    timeoutMs: 240000,
    keepPartial: true,
  });
  const text = minutesText(minutes, { title: opts.title, chair: opts.chair });
  return { minutes, text: truncated ? text + "\n(The minutes stopped partway - the model ran out of room. Check the end.)\n" : text, truncated };
}

/* --------------------------------------------------------------- routes --- */

export default async (req: Request, user: PortalUser, path: string): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (path === "/api/meeting/transcribe") {
    const bytes = await req.arrayBuffer();
    if (!bytes.byteLength) return json({ error: "Nothing was sent to write out." }, 400);
    if (bytes.byteLength > PIECE_MAX_BYTES) {
      return json({ error: `That piece is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; a piece is under ${PIECE_MAX_BYTES / (1024 * 1024)} MB.` }, 413);
    }
    try {
      const text = await transcribePiece(bytes, hearingPrompt(await crewOnTheBooks(), vesselName()));
      return json({ text });
    } catch (e) {
      const said = errorLine(e);
      return json({ error: said === NO_SPEECH_TO_TEXT ? said : `The speech-to-text couldn't hear that piece: ${said}` }, 502);
    }
  }

  if (path === "/api/meeting/minutes") {
    const body = (await req.json().catch(() => null)) as { transcript?: unknown; date?: unknown; chair?: unknown } | null;
    const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
    if (!transcript) return json({ error: "Nothing was heard, so there are no minutes to write." }, 400);
    const date = typeof body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : new Date().toISOString().slice(0, 10);
    const chair = typeof body?.chair === "string" && body.chair.trim() ? body.chair.trim() : user.name;
    try {
      const { text, truncated } = await writeMinutes({ transcript, title: meetingTitle(date), chair, date, people: await crewOnTheBooks() });
      return json({ text, truncated });
    } catch (e) {
      return json({ error: errorLine(e) }, 502);
    }
  }

  return json({ error: `No such endpoint: ${path}` }, 404);
};
