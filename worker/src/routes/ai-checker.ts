import { getEnv } from "../env.js";
import { CheckerBusy, readCheckerJob, startCheckerJob, turnsFrom } from "../lib/checker.js";

/**
 * The AI Checker page — ported from the earlier build. The one host
 * difference: there is no background function to hand a question to, so every
 * start answer carries startPath and the browser starts the run itself
 * (/api/run/ai-checker), holding that request open while the answer is
 * written. The poll below reads the words out of the job record as they land,
 * exactly as before.
 */
const WORKER_PATH = "/api/run/ai-checker";

export default async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json({ error: "POST a conversation to ask the AI." }, { status: 405 });
  }

  const body = await req.json().catch(() => null);

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

  const env = getEnv();
  if (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_BASE_URL) {
    return Response.json(
      { error: "AI is not switched on for this deploy yet - set the ANTHROPIC_API_KEY secret on the worker." },
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

  // The browser is always the one that starts the run here.
  return Response.json(
    { pending: true, jobId: job.id, at: job.at, startPath: WORKER_PATH },
    { status: 202 },
  );
};
