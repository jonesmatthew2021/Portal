/**
 * The worker that runs the OPMS comparison.
 *
 * Holding a whole OPMS export against a whole crew and every certificate on file
 * is one long question to the model — minutes, not seconds — and a request that
 * waits for it is cut off by the platform at sixty seconds and reaches the portal
 * as a 504 with nothing in it. So `/api/analyse` writes the job down and calls
 * this, which is a background function and has fifteen minutes; what came of it
 * is written to the job record, and the portal asks after it until it is there.
 *
 * The client is answered 202 the moment this starts, so nothing here is returned
 * to anybody. Nothing is thrown either: the platform retries a background
 * function that fails, and the same long question put a second time is worse than
 * a failure an admin can read.
 */

import type { Config } from "@netlify/functions";
import { runOpmsJob } from "../../lib/opms.js";

export default async (req: Request) => {
  let jobId = "";
  try {
    const body = (await req.json()) as { jobId?: unknown };
    if (typeof body?.jobId === "string") jobId = body.jobId;
  } catch {
    jobId = "";
  }

  if (!jobId) {
    console.error("opms-run was called without a job to run.");
    return;
  }

  try {
    await runOpmsJob(jobId);
  } catch (e) {
    // runOpmsJob writes its own failures down, so this is the store itself being
    // unreachable. There is nowhere left to record it but the function log.
    console.error(`opms-run couldn't finish job ${jobId}:`, e);
  }
};

export const config: Config = {
  background: true,
};
