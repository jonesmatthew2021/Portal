import { getEnv } from "../env.js";

/**
 * Where the file bytes live.
 *
 * The portal's index of files is the database; this is only the bytes. Two
 * drivers stand behind one surface:
 *
 *   r2         — Cloudflare's own storage. Free at this portal's size, works
 *                the moment the worker deploys, and what local dev runs on.
 *   sharepoint — the company's Coolibah site, via Microsoft Graph. The
 *                long-term home: certificates live where the company already
 *                keeps documents, and the portal reads and files them there.
 *                Switched on by setting FILE_STORE=sharepoint once IT hands
 *                over the app registration (MS_TENANT_ID, MS_CLIENT_ID and
 *                the MS_CLIENT_SECRET secret).
 *
 * Keys are paths — "certification/evans-brenton/AMSA Medical 2029.pdf" — and
 * mean the same thing in both drivers, so flipping FILE_STORE changes where
 * bytes go and nothing else. The surface is the slice of the old blob API the
 * ported code actually calls.
 */

export type FileStore = {
  get(key: string, opts?: { type?: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  get(key: string, opts: { type: "stream" }): Promise<ReadableStream | null>;
  set(key: string, value: ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
  getMetadata(key: string): Promise<{ key: string; size?: number } | null>;
  /** `modified` is when the library last touched the file, as an ISO
   *  string, where the driver knows; the sync weighs two qualification
   *  expiry sheets by it when neither name carries a date. */
  list(opts?: { prefix?: string }): Promise<{ blobs: { key: string; size?: number; modified?: string }[] }>;
};

/* ---------------------------------------------------------------- R2 ---- */

function r2Store(): FileStore {
  const bucket = () => getEnv().FILES;
  return {
    async get(key: string, opts?: { type?: string }): Promise<any> {
      const obj = await bucket().get(key);
      if (!obj) return null;
      return opts?.type === "stream" ? obj.body : await obj.arrayBuffer();
    },
    async set(key, value) {
      await bucket().put(key, value);
    },
    async delete(key) {
      await bucket().delete(key);
    },
    async getMetadata(key) {
      const head = await bucket().head(key);
      return head ? { key, size: head.size } : null;
    },
    async list(opts) {
      const out: { key: string; size?: number; modified?: string }[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket().list({ prefix: opts?.prefix || "", cursor, limit: 1000 });
        page.objects.forEach((o) => out.push({ key: o.key, size: o.size, modified: o.uploaded ? new Date(o.uploaded).toISOString() : undefined }));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return { blobs: out };
    },
  };
}

/* -------------------------------------------------------- SharePoint ---- */

// The Graph token, site and drive are worth remembering across requests in
// the same isolate — they change on the order of hours, not requests.
let tokenCache: { token: string; expiresAt: number } | null = null;
let driveCache: { driveId: string } | null = null;

async function graphToken(): Promise<string> {
  const env = getEnv();
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  if (!env.MS_TENANT_ID || !env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) {
    throw new Error(
      "SharePoint isn't configured yet — MS_TENANT_ID, MS_CLIENT_ID and the MS_CLIENT_SECRET secret come from the IT provider's app registration.",
    );
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  if (!res.ok) throw new Error(`SharePoint sign-in failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return tokenCache.token;
}

async function graph(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await graphToken();
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
}

/** The document library's drive id, found once from the site and library name. */
async function driveId(): Promise<string> {
  if (driveCache) return driveCache.driveId;
  const env = getEnv();
  const site = await graph(
    `/sites/${env.SHAREPOINT_HOSTNAME}:${env.SHAREPOINT_SITE_PATH}`,
  );
  if (!site.ok) throw new Error(`SharePoint site not reachable (${site.status}): ${await site.text()}`);
  const siteId = ((await site.json()) as { id: string }).id;

  const drives = await graph(`/sites/${siteId}/drives`);
  if (!drives.ok) throw new Error(`SharePoint libraries not readable (${drives.status})`);
  const list = ((await drives.json()) as { value: { id: string; name: string }[] }).value;
  const want = (env.SHAREPOINT_LIBRARY || "Documents").toLowerCase();
  const drive = list.find((d) => d.name.toLowerCase() === want) || list[0];
  if (!drive) throw new Error("The SharePoint site has no document library the portal can use.");
  driveCache = { driveId: drive.id };
  return drive.id;
}

const encodePath = (key: string) => key.split("/").map(encodeURIComponent).join("/");

// Where the portal's keys live in the library. SHAREPOINT_MAP marries the
// portal's filing families to the folders the team already uses in Teams —
// certification/ to Crew Certificate Verifications/, matrices/ to Matrix/,
// and so on — longest prefix first, so a more specific family can point
// somewhere of its own. Anything unmapped (removed copies, working uploads)
// sits under the portal's own SHAREPOINT_ROOT folder. The rest of the portal
// only ever speaks its own keys; the translation lives here and nowhere else.
const rooted = (key: string) => {
  const root = (getEnv().SHAREPOINT_ROOT ?? "Crew Portal").replace(/^\/+|\/+$/g, "");
  return root ? `${root}/${key}` : key;
};

function mappings(): [string, string][] {
  let raw: Record<string, string> = {};
  try {
    raw = getEnv().SHAREPOINT_MAP ? JSON.parse(getEnv().SHAREPOINT_MAP!) : {};
  } catch {
    raw = {};
  }
  const trim = (s: string) => s.replace(/^\/+|\/+$/g, "") + "/";
  return Object.entries(raw)
    .map(([from, to]) => [trim(from), trim(to)] as [string, string])
    .sort((a, b) => b[0].length - a[0].length);
}

/* A folder in the library that belongs to none of the mapped families and sits
   outside the portal's own folder still has to be addressable — the certificate
   location on Crew Details can be set to any folder there is. Such a path keeps
   itself, behind a prefix that says so, and toReal hands it straight back. So
   the round trip holds for every folder in the library rather than only the
   mapped ones; without it a folder picked outside them was quietly re-rooted
   inside the portal's own, where there was nothing, and the sync found nothing
   and said so. */
const ELSEWHERE = "library/";

const toReal = (key: string) => {
  if (key.startsWith(ELSEWHERE)) return key.slice(ELSEWHERE.length);
  for (const [from, to] of mappings()) {
    if (key.startsWith(from)) return to + key.slice(from.length);
  }
  return rooted(key);
};

export const fromReal = (path: string) => {
  for (const [from, to] of mappings()) {
    if (path.startsWith(to)) return from + path.slice(to.length);
  }
  const root = rooted("");
  return root && path.startsWith(root) ? path.slice(root.length) : ELSEWHERE + path;
};

/** Graph's simple upload needs the parent folders to exist; make them, one
 * level at a time. Folders already seen this isolate aren't asked about
 * again — a bulk copy files hundreds of certificates into the same handful
 * of folders, and one existence check per folder is plenty.
 *
 * Only under the portal's own folder (SHAREPOINT_ROOT), though. The rest
 * of the library is the office's - the crew folders, OPMS Documents, the
 * Matrix folder - and a write that would have to make a folder there is
 * refused with the folder named, rather than the library quietly growing
 * one nobody asked for. Every folder that is made is said in the log. */
const ensuredFolders = new Set<string>();
async function ensureFolders(drive: string, key: string) {
  const parts = key.split("/").slice(0, -1);
  const own = rooted("");
  let path = "";
  for (const part of parts) {
    const next = path ? `${path}/${part}` : part;
    if (ensuredFolders.has(`${drive}:${next}`)) { path = next; continue; }
    const there = await graph(`/drives/${drive}/root:/${encodePath(next)}`);
    if (there.status === 404) {
      if (own && !(next + "/").startsWith(own)) {
        throw new Error(`the folder ${next} is not in the library`);
      }
      const parent = path ? `/drives/${drive}/root:/${encodePath(path)}:/children` : `/drives/${drive}/root/children`;
      const made = await graph(parent, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: part, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      });
      if (!made.ok) throw new Error(`SharePoint would not make the folder ${next} (${made.status})`);
      console.log(`made the folder ${next} in the library`);
    }
    ensuredFolders.add(`${drive}:${next}`);
    path = next;
  }
}

function sharepointStore(): FileStore {
  return {
    async get(key: string, opts?: { type?: string }): Promise<any> {
      const res = await graph(`/drives/${await driveId()}/root:/${encodePath(toReal(key))}:/content`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`SharePoint read failed (${res.status}) for ${key}`);
      return opts?.type === "stream" ? res.body : await res.arrayBuffer();
    },
    async set(key, value) {
      const drive = await driveId();
      await ensureFolders(drive, toReal(key));
      const res = await graph(`/drives/${drive}/root:/${encodePath(toReal(key))}:/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: value,
      });
      if (!res.ok) throw new Error(`SharePoint write failed (${res.status}) for ${key}: ${await res.text()}`);
    },
    async delete(key) {
      const res = await graph(`/drives/${await driveId()}/root:/${encodePath(toReal(key))}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`SharePoint delete failed (${res.status}) for ${key}`);
    },
    async getMetadata(key) {
      const res = await graph(`/drives/${await driveId()}/root:/${encodePath(toReal(key))}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`SharePoint check failed (${res.status}) for ${key}`);
      const item = (await res.json()) as { size?: number };
      return { key, size: item.size };
    },
    async list(opts) {
      // Prefixes here are always folder paths ("certification/evans-brenton/").
      // The walk speaks the library's real paths; what goes back out is the
      // portal's own keys, so callers never see the mapping.
      const drive = await driveId();
      const asked = (opts?.prefix || "").replace(/\/+$/, "");
      const prefix = asked ? toReal(asked + "/").replace(/\/+$/, "") : "";
      const out: { key: string; size?: number; modified?: string }[] = [];
      const walk = async (folder: string) => {
        let url: string | null = folder
          ? `/drives/${drive}/root:/${encodePath(folder)}:/children?$top=200`
          : `/drives/${drive}/root/children?$top=200`;
        while (url) {
          const res: Response = await graph(url);
          if (res.status === 404) return;
          if (!res.ok) throw new Error(`SharePoint listing failed (${res.status}) under ${folder || "/"}`);
          const page = (await res.json()) as {
            value: { name: string; folder?: unknown; size?: number; lastModifiedDateTime?: string }[];
            "@odata.nextLink"?: string;
          };
          for (const item of page.value) {
            const path = folder ? `${folder}/${item.name}` : item.name;
            if (item.folder) await walk(path);
            else out.push({ key: fromReal(path), size: item.size, modified: item.lastModifiedDateTime });
          }
          url = page["@odata.nextLink"]
            ? page["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "")
            : null;
        }
      };
      await walk(prefix);
      return { blobs: out };
    },
  };
}

/* ----------------------------------------------------------- browsing -- */

export type SharePointEntry = {
  name: string;
  path: string;
  folder: boolean;
  count?: number;
  size?: number;
  modified?: string;
  downloadUrl?: string;
};

/**
 * One folder of the site's document library, as it really is — real paths,
 * not the portal's keys. What the SharePoint page in Admin walks through.
 * Files carry Graph's short-lived download link so the browser can open
 * them directly.
 */
export async function sharepointBrowse(path: string): Promise<SharePointEntry[]> {
  const drive = await driveId();
  const clean = path.replace(/^\/+|\/+$/g, "");
  const out: SharePointEntry[] = [];
  let url: string | null = clean
    ? `/drives/${drive}/root:/${encodePath(clean)}:/children?$top=500`
    : `/drives/${drive}/root/children?$top=500`;
  while (url) {
    const res: Response = await graph(url);
    if (res.status === 404) throw new Error("That folder isn't in the library any more — go back up and refresh.");
    if (!res.ok) throw new Error(`SharePoint listing failed (${res.status})`);
    const page = (await res.json()) as {
      value: {
        name: string;
        size?: number;
        lastModifiedDateTime?: string;
        folder?: { childCount?: number };
        "@microsoft.graph.downloadUrl"?: string;
      }[];
      "@odata.nextLink"?: string;
    };
    for (const item of page.value) {
      out.push({
        name: item.name,
        path: clean ? `${clean}/${item.name}` : item.name,
        folder: !!item.folder,
        count: item.folder?.childCount,
        size: item.size,
        modified: item.lastModifiedDateTime,
        downloadUrl: item["@microsoft.graph.downloadUrl"],
      });
    }
    url = page["@odata.nextLink"]
      ? page["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "")
      : null;
  }
  out.sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1));
  return out;
}

/* ---------------------------------------------------------- the picker -- */

export function fileStore(): FileStore {
  return (getEnv().FILE_STORE || "r2") === "sharepoint" ? sharepointStore() : r2Store();
}
