import { runCheckerJob } from "../lib/checker.js";
import { runMatrixCheckJob, runMatrixReadJob } from "../lib/matrix.js";
import { runOpmsJob } from "../lib/opms.js";
import { runShiftJob } from "../lib/shift.js";

/**
 * The long runs, one route: /api/run/:kind with { jobId } in the body.
 *
 * On Netlify each of these was a background function — the endpoint wrote the
 * job down, handed it over, and answered 202. A Cloudflare worker has no
 * background half, but it may work for as long as the caller holds the line —
 * so the browser is the one that calls this (the start endpoints hand it the
 * path as startPath, a second way in the portal has always known), and this
 * request stays open while the run happens. Everything the run learns is
 * written to the job record exactly as before, and the poll endpoints read it
 * from there — including partway through, which is how the AI checker's words
 * arrive as they are written.
 *
 * Nothing is retried here: the same long question put to the model twice is
 * worse than a failure an admin can read, and every runner writes its own
 * failures onto the job record.
 */

const RUNNERS: Record<string, (jobId: string) => Promise<unknown>> = {
  "ai-checker": runCheckerJob,
  "matrix-read": runMatrixReadJob,
  "matrix-check": runMatrixCheckJob,
  opms: runOpmsJob,
  shift: runShiftJob,
};

export default async (req: Request, kind: string) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const runner = RUNNERS[kind];
  if (!runner) {
    return Response.json({ error: `There is no run called "${kind}".` }, { status: 404 });
  }

  let jobId = "";
  try {
    const body = (await req.json()) as { jobId?: unknown };
    if (typeof body?.jobId === "string") jobId = body.jobId;
  } catch {
    jobId = "";
  }
  if (!jobId) {
    return Response.json({ error: "No job was named." }, { status: 400 });
  }

  try {
    await runner(jobId);
  } catch (e) {
    // The runner writes its own failures onto the job record; reaching here
    // means the store itself misbehaved. Said to the caller, since there is a
    // caller to say it to now.
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
  return Response.json({ done: true });
};
