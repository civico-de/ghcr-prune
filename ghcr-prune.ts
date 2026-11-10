// Prune container package versions of a GitHub organisation in GHCR. Dry run unless --apply.
//
//   node ghcr-prune.ts --org <org> (--repo <owner/name> | --package <name>...)
//     --keep-newest <n> --min-age-days <d> [--keep-tag <regex>]... [--keep-refs <file|->]...
//     [--apply --max-delete <n>]
//
// Decisions go to stdout as JSON lines, counts to stderr. Token: $GITHUB_TOKEN or `gh auth token`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type Version = { id: number; digest: string; updated: string; tags: string[] };
export type Rules = { keepTags: RegExp[]; keepNewest: number; minAgeDays: number; refs: Set<string>; now: Date };
export type Decision = Version & { keep: boolean; reason: string };

const DAY = 86_400_000;

/** `<path>@sha256:<hex>` for every digest reference in a text; a `:tag` before the digest is dropped. */
export function refsIn(text: string): string[] {
  return [...text.matchAll(/([A-Za-z0-9._/-]+?)(?::[A-Za-z0-9_][A-Za-z0-9._-]*)?@(sha256:[0-9a-f]{64})/g)].map((m) => `${m[1]}@${m[2]}`);
}

/** A reference names a package when its path is the package name or ends in `/<name>`. */
function pinned(refs: Set<string>, pkg: string, digest: string): boolean {
  for (const r of refs) {
    const at = r.lastIndexOf("@");
    const path = r.slice(0, at);
    if (r.slice(at + 1) === digest && (path === pkg || path.endsWith(`/${pkg}`))) return true;
  }
  return false;
}

/** Versions kept on their own merit, digest → reason. Later rules overwrite the reason only. */
export function roots(pkg: string, versions: Version[], rules: Rules): Map<string, string> {
  const keep = new Map<string, string>();
  const tagged = versions.filter((v) => v.tags.length).sort((a, b) => b.updated.localeCompare(a.updated));
  for (const v of tagged.slice(0, rules.keepNewest)) keep.set(v.digest, "newest");
  for (const v of tagged) {
    const t = v.tags.find((tag) => rules.keepTags.some((re) => re.test(tag)));
    if (t) keep.set(v.digest, `tag ${t}`);
  }
  for (const v of versions) {
    if (rules.now.getTime() - Date.parse(v.updated) < rules.minAgeDays * DAY) keep.set(v.digest, "young");
    if (pinned(rules.refs, pkg, v.digest)) keep.set(v.digest, "referenced");
  }
  return keep;
}

/** Adds every manifest reachable from a kept index; childrenOf returns an index's entries. */
export async function close(keep: Map<string, string>, childrenOf: (digest: string) => Promise<string[]>) {
  const queue = [...keep.keys()];
  for (let d = queue.shift(); d; d = queue.shift()) {
    for (const c of await childrenOf(d)) {
      if (!keep.has(c)) {
        keep.set(c, `child of ${d.slice(0, 19)}`);
        queue.push(c);
      }
    }
  }
  return keep;
}

const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
type Index = { manifests?: { digest: string; mediaType?: string }[] };

/** Manifests an index lists; cache exports list layer blobs there, which are not versions. */
export function childDigests(m: Index): string[] {
  return (m.manifests ?? []).filter((e) => !e.mediaType || MANIFESTS.includes(e.mediaType)).map((e) => e.digest);
}

export function decide(versions: Version[], keep: Map<string, string>): Decision[] {
  return versions.map((v) => ({ ...v, keep: keep.has(v.digest), reason: keep.get(v.digest) ?? "unreferenced" }));
}

type Args = { org: string; repo?: string; packages: string[]; rules: Rules; apply: boolean; maxDelete: number };

export function parse(argv: string[], read: (f: string) => string, now = new Date()): Args {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      org: { type: "string" },
      repo: { type: "string" },
      package: { type: "string", multiple: true },
      "keep-newest": { type: "string" },
      "min-age-days": { type: "string" },
      "keep-tag": { type: "string", multiple: true },
      "keep-refs": { type: "string", multiple: true },
      apply: { type: "boolean", default: false },
      "max-delete": { type: "string" },
    },
  });
  const missing = [
    !a.org && "--org",
    !a.repo && !a.package?.length && "--repo or --package",
    a["keep-newest"] === undefined && "--keep-newest",
    a["min-age-days"] === undefined && "--min-age-days",
    a.apply && a["max-delete"] === undefined && "--max-delete (with --apply)",
  ].filter(Boolean);
  if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  const int = (name: string, s: string | undefined, min: number) => {
    const n = /^\d+$/.test(s ?? "") ? Number(s) : Number.NaN;
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer ≥ ${min}`);
    return n;
  };
  const refs = new Set<string>();
  for (const f of a["keep-refs"] ?? []) {
    const found = refsIn(read(f));
    if (!found.length) throw new Error(`--keep-refs ${f} names no <image>@sha256 digest`);
    for (const r of found) refs.add(r);
  }
  return {
    org: a.org as string,
    repo: a.repo,
    packages: a.package ?? [],
    rules: {
      keepTags: (a["keep-tag"] ?? []).map((t) => new RegExp(t)),
      keepNewest: int("--keep-newest", a["keep-newest"], 1),
      minAgeDays: int("--min-age-days", a["min-age-days"], 0),
      refs,
      now,
    },
    apply: a.apply as boolean,
    maxDelete: a.apply ? int("--max-delete", a["max-delete"], 1) : Number.POSITIVE_INFINITY,
  };
}

function token(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("set GITHUB_TOKEN or run `gh auth login`");
  return r.stdout.trim();
}

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} → ${res.status} ${await res.text()}`);
  return res;
}


export async function run(argv: string[], read: (f: string) => string) {
  const args = parse(argv, read);
  const tok = token();
  const api = { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json" };
  const paged = async <T>(path: string): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const url = `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
      const batch = (await (await call(url, { headers: api })).json()) as T[];
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  };

  let packages = args.packages;
  if (args.repo) {
    const all = await paged<{ name: string; repository?: { full_name: string } }>(`/orgs/${args.org}/packages?package_type=container`);
    packages = [...packages, ...all.filter((p) => p.repository?.full_name === args.repo).map((p) => p.name)];
  }
  if (!packages.length) throw new Error(`no container packages linked to ${args.repo}`);

  // Decide every package before deleting anything, so a failed manifest read deletes nothing.
  const plans: { pkg: string; decisions: Decision[] }[] = [];
  for (const pkg of [...new Set(packages)].sort()) {
    const enc = encodeURIComponent(pkg);
    type Raw = { id: number; name: string; updated_at: string; metadata: { container: { tags: string[] } } };
    const raw = await paged<Raw>(`/orgs/${args.org}/packages/container/${enc}/versions`);
    const versions = raw.map((v) => ({ id: v.id, digest: v.name, updated: v.updated_at, tags: v.metadata.container.tags }));
    const scope = encodeURIComponent(`repository:${args.org}/${pkg}:pull`);
    const basic = Buffer.from(`token:${tok}`).toString("base64");
    const reg = ((await (await call(`https://ghcr.io/token?service=ghcr.io&scope=${scope}`, { headers: { Authorization: `Basic ${basic}` } })).json()) as { token: string }).token;
    const childrenOf = async (digest: string) => {
      const m = (await (await call(`https://ghcr.io/v2/${args.org}/${pkg}/manifests/${digest}`, { headers: { Authorization: `Bearer ${reg}`, Accept: MANIFESTS.join(", ") } })).json()) as Index;
      return childDigests(m);
    };
    plans.push({ pkg, decisions: decide(versions, await close(roots(pkg, versions, args.rules), childrenOf)) });
  }

  let deleted = 0;
  let pending = 0;
  for (const { pkg, decisions } of plans) {
    let n = 0;
    for (const d of decisions) {
      let action = "keep";
      if (!d.keep) {
        n++;
        if (!args.apply) action = "would-delete";
        else if (deleted >= args.maxDelete) { action = "deferred"; pending++; }
        else {
          await call(`https://api.github.com/orgs/${args.org}/packages/container/${encodeURIComponent(pkg)}/versions/${d.id}`, { method: "DELETE", headers: api });
          action = "deleted";
          deleted++;
        }
      }
      console.log(JSON.stringify({ package: pkg, ...d, action }));
    }
    console.error(`${pkg.padEnd(32)} keep=${String(decisions.length - n).padStart(5)} prune=${n}`);
  }
  console.error(args.apply
    ? `deleted ${deleted} versions${pending ? `, ${pending} deferred to the next run (--max-delete ${args.maxDelete})` : ""}`
    : `would delete ${plans.reduce((s, p) => s + p.decisions.filter((d) => !d.keep).length, 0)} versions (dry run)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), (f) => readFileSync(f === "-" ? 0 : f, "utf8")).catch((e: Error) => {
    console.error(`ghcr-prune: ${e.message}`);
    process.exit(1);
  });
}
