import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";
import { getEnv } from "../env.js";

/**
 * The database, bound per request. The Netlify build exported a single `db`
 * const; here the binding only exists once a request is in flight, so `db` is
 * a getter the ported code calls exactly as it always did — `db.select()...`
 * still reads naturally because the proxy hands every property through to a
 * drizzle instance over the current request's D1 binding.
 */
function make() {
  return drizzle(getEnv().DB, { schema });
}

type DB = ReturnType<typeof make>;

export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    return (make() as unknown as Record<PropertyKey, unknown>)[prop];
  },
});
