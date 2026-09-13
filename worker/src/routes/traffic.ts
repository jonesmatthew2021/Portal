import type { PortalUser } from "../auth.js";
import { getEnv } from "../env.js";

/**
 * The sign-in book — GET /api/login-events.
 *
 * Everything auth.ts records: code requests, unknown addresses probing the
 * door, wrong codes, lockouts, sign-ins, sign-outs, and refused actions.
 * The Access grants page reads this to answer "is anyone gaining illegal
 * access?" — a run of unknown_email or code_wrong from one address is
 * someone trying their luck. Management and IT only; the book itself is
 * trimmed to ninety days.
 */

const now = () => Math.floor(Date.now() / 1000);

type EventRow = {
  ts: number;
  kind: string;
  email: string | null;
  ip: string | null;
  country: string | null;
  ua: string | null;
  detail: string | null;
};

export default async (req: Request, actor: PortalUser): Promise<Response> => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  if (actor.role === "crew") {
    return Response.json({ error: "The sign-in traffic is read by Management and IT Help." }, { status: 403 });
  }

  const db = getEnv().DB;

  // Sweep anything past ninety days each time the book is opened.
  await db.prepare("DELETE FROM login_events WHERE ts < ?1").bind(now() - 90 * 86400).run();

  const weekAgo = now() - 7 * 86400;
  const [latest, counts] = await db.batch([
    db.prepare(
      "SELECT ts, kind, email, ip, country, ua, detail FROM login_events ORDER BY ts DESC LIMIT 200",
    ),
    db.prepare(
      "SELECT kind, COUNT(*) AS n FROM login_events WHERE ts >= ?1 GROUP BY kind",
    ).bind(weekAgo),
  ]);

  const week: Record<string, number> = {};
  for (const row of (counts.results || []) as { kind: string; n: number }[]) {
    week[row.kind] = row.n;
  }

  return Response.json(
    {
      events: (latest.results || []) as EventRow[],
      week,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};
