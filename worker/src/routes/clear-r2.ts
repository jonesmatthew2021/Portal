import { getEnv } from "../env.js";

/**
 * Emptying the R2 copy, once SharePoint is the store of record.
 *
 * The company's requirement is that crew certificates live in SharePoint,
 * not third-party storage — so after the migration is verified serving, this
 * clears the R2 bucket. Refused outright unless FILE_STORE is sharepoint:
 * while R2 is the live store, emptying it would be destroying the portal's
 * files, not tidying a spare copy.
 *
 * POST /api/clear-r2 → { deleted, remaining } — call until remaining is 0.
 * Deletes go in R2's own bulk batches, so a call clears up to a thousand.
 */
export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const env = getEnv();
  if ((env.FILE_STORE || "r2") !== "sharepoint") {
    return Response.json(
      { error: "FILE_STORE is not sharepoint — emptying R2 now would destroy the live files, not a spare copy." },
      { status: 409 },
    );
  }

  const page = await env.FILES.list({ limit: 1000 });
  const keys = page.objects.map((o) => o.key);
  if (keys.length) await env.FILES.delete(keys);

  const after = await env.FILES.list({ limit: 1 });
  return Response.json({
    deleted: keys.length,
    remaining: after.objects.length > 0 || after.truncated ? "more" : 0,
  });
};
