import { getEnv } from "../env.js";
import { fromReal } from "../files/store.js";
import { certFolderFor, opmsFolderName } from "./documents.js";
import { canonicalPersonName } from "./person-name.js";
import { PORTAL_ROW_ID } from "./schema.js";

/**
 * Where the crew's certificates are, as Crew Details says.
 *
 * Two things are set on that page and both are answered here.
 *
 * The certificate location is the one folder in the library the crew's own
 * folders sit in. Until it was settable this was "opms" and nothing else, and
 * that is still what is used where nobody has said otherwise - so a portal
 * that has never been near the button carries on exactly as it did.
 *
 * A man's own folder is set against him on his row, for the folder whose name
 * does not say whose it is. "Kyle", "PK", "Chris - OPMS" - the sync reads a
 * folder name and works out the man, and where it cannot, this is where the
 * answer was written down. What is written down here beats what is worked out,
 * always: that is the whole point of having been asked.
 *
 * Crew Details picks folders out of the library itself, so what it saves is a
 * real library path - "OPMS Documents/Kyle". The rest of the portal speaks its
 * own keys - "opms/Kyle". fromReal is the one translation between the two, so
 * both are turned into keys here and nothing further in has to know.
 */

export type ManInAFolder = {
  /** The portal's token for him, which is what a document is filed under. */
  token: string;
  /** His name, written the one way the portal writes names. */
  person: string;
  /** The folder, as a portal key: "opms/Kyle". */
  key: string;
};

export type CertHome = {
  /** The key prefix the crew's folders sit under, no trailing slash. */
  home: string;
  /** Everybody Crew Details has pointed at a folder of his own. */
  assigned: ManInAFolder[];
  /** Whose folder this is, where Crew Details has said so. */
  manIn: (folderKey: string) => ManInAFolder | null;
  /** Where this man's certificates are written: the folder Crew Details gave
   *  him, or the one his certificates are already in. Null where neither is
   *  known — nothing is written to a folder nobody has pointed at. */
  prefixFor: (token: string) => string | null;
};

type StatePerson = { name?: string; certFolder?: string };

/** The portal's shared record, or nothing if it cannot be read. A setting that
 *  cannot be read is not an error - it is a portal nobody has set it on. */
async function sharedState(): Promise<{ certRoot?: string; people?: StatePerson[] } | null> {
  try {
    const row = await getEnv()
      .DB.prepare("SELECT data FROM portal_state WHERE id = ?1")
      .bind(PORTAL_ROW_ID)
      .first<{ data: string }>();
    return row ? JSON.parse(row.data) : null;
  } catch (e) {
    console.error("the certificate location couldn't be read:", e);
    return null;
  }
}

/**
 * A real library path as the portal's own key.
 *
 * With a slash on the end before it is translated, and the slash taken off
 * after. The map is a map of folders — "opms/" to "United Operations Team/OPMS
 * Documents/" — and a folder written without its slash matches none of them,
 * so "United Operations Team/OPMS Documents" came back untranslated and the
 * portal went looking for a folder of that name inside its own. The slash is
 * what makes a folder a folder.
 */
export const asKey = (realPath: string) => {
  const clean = String(realPath || "").replace(/^\/+|\/+$/g, "");
  return clean ? fromReal(clean + "/").replace(/\/+$/, "") : "";
};

export async function certHome(): Promise<CertHome> {
  const state = await sharedState();
  const root = asKey(state?.certRoot || "");
  const home = root || "opms";

  const assigned: ManInAFolder[] = [];
  for (const p of state?.people || []) {
    const key = asKey(p.certFolder || "");
    if (!key) continue;
    const person = canonicalPersonName(p.name || "");
    if (!person) continue;
    assigned.push({ token: certFolderFor(person), person, key });
  }

  const byKey = new Map(assigned.map((a) => [a.key.toLowerCase(), a]));
  const byToken = new Map(assigned.map((a) => [a.token, a]));

  /* Where each man's certificates already are, read off the certificates
     themselves. Most of the crew have never been pointed at a folder by hand
     and do not need to be - the sync found their folder years ago and their
     papers have been going into it ever since. */
  const settled = await foldersInUse();

  return {
    home,
    assigned,
    manIn: (folderKey) => byKey.get(String(folderKey || "").toLowerCase()) || null,
    /* Never invented.
     *
     * This used to fall back to the man's name under the certificate location,
     * which meant that filing a certificate for somebody the library had no
     * folder for quietly made one - and the library filled up with near-empty
     * folders for people who already had a folder under another name. The
     * caller is told there is nowhere to put it instead, and asks. */
    prefixFor: (token) => byToken.get(token)?.key || settled.get(token) || null,
  };
}

/**
 * The folder each person's certificates are actually in, by their token.
 *
 * The commonest one wins, because a man whose papers are spread over two
 * folders has one real folder and one accident, and the accident is not where
 * the next certificate should go.
 */
async function foldersInUse(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const rows = await getEnv()
      .DB.prepare(
        "SELECT folder, blob_key AS blobKey FROM documents " +
          "WHERE category = 'certificate' AND removed_at IS NULL AND folder IS NOT NULL",
      )
      .all<{ folder: string; blobKey: string }>();

    const tally = new Map<string, Map<string, number>>();
    for (const r of rows.results || []) {
      const cut = String(r.blobKey || "").lastIndexOf("/");
      if (cut < 1) continue;
      const where = r.blobKey.slice(0, cut);
      if (!tally.has(r.folder)) tally.set(r.folder, new Map());
      const seen = tally.get(r.folder)!;
      seen.set(where, (seen.get(where) || 0) + 1);
    }
    for (const [token, seen] of tally) {
      const best = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) out.set(token, best[0]);
    }
  } catch (e) {
    console.error("the folders in use couldn't be read:", e);
  }
  return out;
}
