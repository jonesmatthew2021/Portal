/**
 * The worker that answers an AI Checker question.
 *
 * A question with a file on it — read this PDF, hold it against what I've
 * pasted — is regularly more than the sixty seconds a synchronous function is
 * allowed, and a request that waits for it is cut off by the platform and
 * reaches the portal as a bare 504 with nothing in it. So `/api/ai-checker`
 * writes the question down and calls this, which is a background function and
 * has fifteen minutes; the answer is written to the job record as the model
 * writes it, and the browser reads it from there as it lands.
 *
 * The client is answered 202 the moment this starts, so nothing here is returned
 * to anybody. Nothing is thrown either: the platform retries a background
 * function that fails, and asking the model the same question a second time is
 * worse than a failure whoever asked can read.
 */

import type { Config } from "@netlify/functions";
import { runCheckerJob } from "../../lib/checker.js";

export default async (req: Request) => {
  let jobId = "";
  try {
    const body = (await req.json()) as { jobId?: unknown };
    if (typeof body?.jobId === "string") jobId = body.jobId;
  } catch {
    jobId = "";
  }

  if (!jobId) {
    console.error("ai-checker-run was called without a question to answer.");
    return;
  }

  try {
    await runCheckerJob(jobId);
  } catch (e) {
    // runCheckerJob writes its own failures down, so this is the store itself
    // being unreachable. There is nowhere left to record it but the function log.
    console.error(`ai-checker-run couldn't finish job ${jobId}:`, e);
  }
};

export const config: Config = {
  background: true,
};
