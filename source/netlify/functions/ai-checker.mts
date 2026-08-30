import type { Config } from "@netlify/functions";
import { CheckerBusy, readCheckerJob, startCheckerJob, turnsFrom } from "../../lib/checker.js";

/**
 * The AI Checker page on the Admin tab: a free-form conversation with the model.
 *
 * Nothing is answered in this request. Answering is one long question to the
 * model — often with a PDF on it — and a synchronous function is allowed sixty
 * seconds, so a request that waited for the answer was cut off by the platform
 * partway and reached the browser as a bare 504 with nothing in it. That was the
 * error the page used to show.
 *
 * So the question is written down here and handed to the `ai-checker-run`
 * background function, which has fifteen minutes, and the browser asks after it
 * — reading the answer out of the job record as the model writes it, so it still
 * arrives a few words at a time. What the conversation is, what may be attached
 * to it and how it is trimmed all live in `lib/checker.ts`, alongside the worker
 * that runs it.
 *
 * Two things are asked of this endpoint, told apart by what the body carries:
 * a conversation starts a question, and a job id asks how one is getting on.
 */

// Where the worker answers. A background function is called at the address every
// function has rather than a path of its own, so there is nothing to keep in
// step with a route. The portal is told this rather than having it written down
// twice.
const WORKER_PATH = "/.netlify/functions/ai-checker-run";

/**
 * Set the worker going on a question that has been written down.
 *
 * A background function answers the moment it has the request and carries on
 * without it, so this waits for the handover and nothing else.
 *
 * The portal sits behind Netlify's password protection, and the password is
 * asked for at the edge — before a request reaches any function, and of every
 * request that arrives without an answer to it. This call is the portal's own
 * server calling itself, and a server has no browser and no cookie, so left as
 * it was it would be turned away at the door and the question it was meant to
 * start would never be answered. What the browser sent up is therefore sent back
 * down with this one: the handover goes in under the answer whoever is asking
 * has already given.
 *
 * Whether it was picked up is reported rather than thrown, because there is a
 * second way in when this one is refused and the browser knows about it.
 */
async function startWorker(req: Request, jobId: string) {
  let origin = process.env.URL || "";
  try {
    origin = new URL(req.url).origin;
  } catch {
    // Left as the site's own address, which is what a function is given.
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const cookie = req.headers.get("cookie");
  const authorization = req.headers.get("authorization");
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;

  try {
    const res = await fetch(`${origin}${WORKER_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jobId }),
    });
    // Anything but an answer in the two hundreds means the question was never
    // picked up, and a job left sitting at "running" would have the browser
    // asking after an answer that is never coming.
    return res.ok;
  } catch {
    // The site being unreachable from inside itself is the same thing as a
    // refusal as far as the question is concerned: nobody has it.
    return false;
  }
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json({ error: "POST a conversation to ask the AI." }, { status: 405 });
  }

  const body = await req.json().catch(() => null);

  // How a question is getting on. The browser asks for this until the answer is
  // finished, so it says as little as it can: what has been written since the
  // browser last asked, and whether there is more coming. `have` is how much of
  // the answer the browser already holds, so a long answer isn't resent in full
  // several times a second.
  //
  // `step` is the other thing worth sending: the checker reads the portal before
  // it answers, and a question that has it going through the roster, then the
  // certificates, then a scan is a minute in which no words arrive at all. The
  // worker writes down what it is looking at while that is happening, and it is
  // passed straight through so the page can show it. It goes the moment the
  // answer starts arriving and is never part of the answer.
  const jobId = body && typeof body === "object" ? (body as { jobId?: unknown }).jobId : undefined;
  if (typeof jobId === "string" && jobId) {
    const job = await readCheckerJob(jobId);
    if (!job) {
      return Response.json(
        { error: "That question is no longer on the server. Ask it again." },
        { status: 404 },
      );
    }
    const raw = (body as { have?: unknown }).have;
    const have = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    const text = job.text || "";
    return Response.json({
      state: job.state,
      // Where the browser somehow holds more than the server has, nothing is
      // sent rather than a negative slice of the answer.
      text: have >= text.length ? "" : text.slice(have),
      len: text.length,
      ...(job.error ? { error: job.error } : {}),
      ...(job.note ? { note: job.note } : {}),
      ...(job.step ? { step: job.step } : {}),
    });
  }

  const turns = turnsFrom(body);
  if (!turns) {
    return Response.json({ error: "Nothing was asked. Type a question or attach a file and send it." }, { status: 400 });
  }

  // The gateway is checked before the question is written down: a deploy without
  // AI is the one failure that can be said now rather than as an answer that
  // never comes.
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_BASE_URL) {
    return Response.json(
      { error: "AI isn't available on this deploy yet. AI Gateway switches on once the project has a production deploy." },
      { status: 503 },
    );
  }

  let job;
  try {
    job = await startCheckerJob(turns);
  } catch (e) {
    if (e instanceof CheckerBusy) {
      return Response.json(
        { error: "Too many checks are running right now. Wait a moment and try again." },
        { status: 429 },
      );
    }
    return Response.json(
      { error: `The question couldn't be written down: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  // Where the handover was refused — the password protection turning away a call
  // the server made to itself with no answer to give — the question is still
  // written down and good. It is the starting of it that has to happen from the
  // browser instead, which has an answer, so the portal is told where.
  const handedOver = await startWorker(req, job.id);

  return Response.json(
    {
      pending: true,
      jobId: job.id,
      at: job.at,
      ...(handedOver ? {} : { startPath: WORKER_PATH }),
    },
    { status: 202 },
  );
};

export const config: Config = {
  path: "/api/ai-checker",
};
