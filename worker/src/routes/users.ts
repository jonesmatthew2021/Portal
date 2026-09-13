import type { PortalUser } from "../auth.js";
import { getEnv } from "../env.js";

/**
 * Access grants — who may enter the portal and at what level.
 *
 *   GET    /api/users        the list
 *   POST   /api/users        { name, email, role } — grant access
 *   PATCH  /api/users/:id    { role? , disabled?, name? } — change a grant
 *   DELETE /api/users/:id    remove a grant entirely (their sessions die too)
 *
 * Management and IT run this page. Two lines only IT may cross: creating or
 * changing an IT account is IT's alone, and the last standing IT account can
 * be neither disabled nor demoted — a portal nobody can maintain is a portal
 * lost. Nobody edits their own grant; another holder does, which keeps one
 * compromised session from quietly promoting itself.
 */

const ROLES = new Set(["it", "management", "crew"]);
const now = () => Math.floor(Date.now() / 1000);

const clean = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const cleanEmail = (v: unknown) => {
  const s = clean(v);
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null;
};

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: number;
  created_at: number;
  last_login: number | null;
};

const shown = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  disabled: !!u.disabled,
  createdAt: u.created_at,
  lastLogin: u.last_login,
});

async function itStanding(exceptId?: string): Promise<number> {
  const row = await getEnv()
    .DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'it' AND disabled = 0" + (exceptId ? " AND id != ?1" : ""))
    .bind(...(exceptId ? [exceptId] : []))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export default async (req: Request, actor: PortalUser, id?: string): Promise<Response> => {
  if (actor.role === "crew") {
    return Response.json({ error: "Access grants are managed by Management and IT Help." }, { status: 403 });
  }
  const db = getEnv().DB;

  if (req.method === "GET" && !id) {
    const rows = await db
      .prepare("SELECT id, email, name, role, disabled, created_at, last_login FROM users ORDER BY role, name")
      .all<UserRow>();
    return Response.json((rows.results || []).map(shown), { headers: { "Cache-Control": "no-store" } });
  }

  if (req.method === "POST" && !id) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = clean(body?.name);
    const email = cleanEmail(body?.email);
    const role = clean(body?.role);
    if (!name || !email || !role || !ROLES.has(role)) {
      return Response.json({ error: "A grant needs a name, a working email, and a level." }, { status: 400 });
    }
    if (role === "it" && actor.role !== "it") {
      return Response.json({ error: "Only IT Help can grant IT Help." }, { status: 403 });
    }
    const taken = await db.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
    if (taken) return Response.json({ error: "That email already has a grant." }, { status: 409 });

    const user: UserRow = {
      id: crypto.randomUUID(),
      email,
      name,
      role,
      disabled: 0,
      created_at: now(),
      last_login: null,
    };
    await db
      .prepare("INSERT INTO users (id, email, name, role, disabled, created_at, created_by) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)")
      .bind(user.id, user.email, user.name, user.role, user.created_at, actor.email)
      .run();
    return Response.json(shown(user), { status: 201 });
  }

  if (req.method === "DELETE" && id) {
    const target = await db
      .prepare("SELECT id, email, role FROM users WHERE id = ?1")
      .bind(id)
      .first<{ id: string; email: string; role: string }>();
    if (!target) return Response.json({ error: "That grant is no longer on the portal." }, { status: 404 });
    if (target.email === actor.email) {
      return Response.json({ error: "Your own grant is removed by another holder, not by you." }, { status: 403 });
    }
    if (target.role === "it" && actor.role !== "it") {
      return Response.json({ error: "Only IT Help can remove an IT Help grant." }, { status: 403 });
    }
    if (target.role === "it" && (await itStanding(target.id)) === 0) {
      return Response.json({ error: "That is the last IT Help account — grant IT Help to someone else first." }, { status: 409 });
    }
    await db.batch([
      db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(id),
      db.prepare("DELETE FROM users WHERE id = ?1").bind(id),
    ]);
    return Response.json({ removed: true });
  }

  if (req.method === "PATCH" && id) {
    const target = await db
      .prepare("SELECT id, email, name, role, disabled, created_at, last_login FROM users WHERE id = ?1")
      .bind(id)
      .first<UserRow>();
    if (!target) return Response.json({ error: "That grant is no longer on the portal." }, { status: 404 });
    if (target.id === (actor as PortalUser & { id?: string }).id || target.email === actor.email) {
      return Response.json({ error: "Your own grant is changed by another holder, not by you." }, { status: 403 });
    }
    if (target.role === "it" && actor.role !== "it") {
      return Response.json({ error: "Only IT Help can change an IT Help grant." }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const patch: { role?: string; disabled?: number; name?: string } = {};
    if (body && "role" in body) {
      const role = clean(body.role);
      if (!role || !ROLES.has(role)) return Response.json({ error: "That's not a level the portal has." }, { status: 400 });
      if (role === "it" && actor.role !== "it") {
        return Response.json({ error: "Only IT Help can grant IT Help." }, { status: 403 });
      }
      patch.role = role;
    }
    if (body && "disabled" in body) patch.disabled = body.disabled ? 1 : 0;
    if (body && "name" in body) {
      const name = clean(body.name);
      if (!name) return Response.json({ error: "A grant keeps a name." }, { status: 400 });
      patch.name = name;
    }
    if (!Object.keys(patch).length) return Response.json({ error: "Nothing to change was included." }, { status: 400 });

    // The last standing IT account holds the keys to the machinery; the
    // portal refuses to let it be demoted or switched off.
    const losesIt = target.role === "it" && ((patch.role && patch.role !== "it") || patch.disabled === 1);
    if (losesIt && (await itStanding(target.id)) === 0) {
      return Response.json({ error: "That is the last IT Help account — grant IT Help to someone else first." }, { status: 409 });
    }

    const sets: string[] = [];
    const binds: unknown[] = [];
    let n = 1;
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?${++n}`);
      binds.push(v);
    }
    await db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?1`).bind(id, ...binds).run();
    if (patch.disabled === 1) {
      await db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?1").bind(id).run();
    }
    const after = await db
      .prepare("SELECT id, email, name, role, disabled, created_at, last_login FROM users WHERE id = ?1")
      .bind(id)
      .first<UserRow>();
    return Response.json(shown(after!));
  }

  return new Response("Method not allowed", { status: 405 });
};
