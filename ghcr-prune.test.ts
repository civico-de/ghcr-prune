import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Rules, type Version, childDigests, close, decide, parse, refsIn, roots, run } from "./ghcr-prune.ts";

const dg = (c: string) => `sha256:${c.repeat(64)}`;
const v = (id: number, c: string, updated: string, tags: string[] = []): Version => ({ id, digest: dg(c), updated, tags });
const now = new Date("2026-11-10T00:00:00Z");
const rules = (r: Partial<Rules> = {}): Rules => ({ keepTags: [], keepNewest: 1, minAgeDays: 0, refs: new Set(), now, ...r });

// Two builds, each a tagged index with an image and an attestation manifest, an orphaned
// manifest and a cache tag.
const versions = [
  v(1, "1", "2026-11-01", ["6.17-aaa"]), v(2, "2", "2026-11-01"), v(3, "3", "2026-11-01"),
  v(4, "4", "2026-11-07", ["6.19-bbb"]), v(5, "5", "2026-11-07"), v(6, "6", "2026-11-07"),
  v(7, "7", "2026-11-06"),
  v(8, "8", "2026-11-05", ["buildcache"]),
];
const index: Record<string, string[]> = { [dg("1")]: [dg("2"), dg("3")], [dg("4")]: [dg("5"), dg("6")] };
const kept = async (r: Rules, vs = versions) =>
  decide(vs, await close(roots("app", vs, r), async (d) => index[d] ?? [])).filter((d) => d.keep).map((d) => d.id);

describe("refsIn", () => {
  test("finds package@digest anywhere in text, comments included", () =>
    assert.deepEqual(refsIn(`image: ghcr.io/o/app@${dg("a")}  # was app@${dg("b")}`), [`ghcr.io/o/app@${dg("a")}`, `app@${dg("b")}`]));
  test("ignores a bare digest", () => assert.deepEqual(refsIn(`digest: ${dg("a")}`), []));
  test("drops a tag before the digest", () =>
    assert.deepEqual(refsIn(`ghcr.io/o/app:6.19@${dg("a")}`), [`ghcr.io/o/app@${dg("a")}`]));
  test("keeps a nested package path", () =>
    assert.deepEqual(refsIn(`"ghcr.io/o/team/app@${dg("a")}"`), [`ghcr.io/o/team/app@${dg("a")}`]));
});

describe("decisions", () => {
  test("the newest tagged index keeps its children; orphans and old builds go", async () =>
    assert.deepEqual(await kept(rules()), [4, 5, 6]));
  test("a kept tag keeps that version and nothing its index does not list", async () =>
    assert.deepEqual(await kept(rules({ keepTags: [/^buildcache$/] })), [4, 5, 6, 8]));
  test("a referenced old index survives with its children", async () =>
    assert.deepEqual(await kept(rules({ refs: new Set([`app@${dg("1")}`]) })), [1, 2, 3, 4, 5, 6]));
  test("the same digest referenced under another package keeps nothing", async () =>
    assert.deepEqual(await kept(rules({ refs: new Set([`ghcr.io/o/base@${dg("1")}`, `ghcr.io/o/myapp@${dg("1")}`]) })), [4, 5, 6]));
  test("a full image path protects its package", async () =>
    assert.deepEqual(await kept(rules({ refs: new Set([`ghcr.io/o/app@${dg("1")}`]) })), [1, 2, 3, 4, 5, 6]));
  test("a nested package is matched by its full name", async () => {
    const vs = [v(1, "1", "2026-10-01", ["old"]), v(2, "2", "2026-11-01", ["new"])];
    const keep = roots("team/app", vs, rules({ refs: new Set([`ghcr.io/o/team/app@${dg("1")}`]) }));
    assert.deepEqual([...keep.keys()], [dg("2"), dg("1")]);
  });
  test("untagged versions never count towards keep-newest", async () =>
    assert.deepEqual(await kept(rules({ keepNewest: 2 })), [4, 5, 6, 8]));
  test("versions younger than min-age survive, also untagged ones not yet in an index", async () =>
    assert.deepEqual(await kept(rules({ minAgeDays: 5 })), [4, 5, 6, 7]));
  test("a stable tag on a candidate's digest protects the candidate tags with it", async () => {
    const vs = [v(1, "a", "2026-11-01", ["standalone-6.19", "standalone-6.19-" + "a".repeat(40)]), v(2, "b", "2026-11-02", ["standalone-6.19-" + "b".repeat(40)]), v(3, "c", "2026-11-09", ["x"])];
    assert.deepEqual(await kept(rules({ keepTags: [/^[a-z0-9.-]+(?<!-[0-9a-f]{40})$/] }), vs), [1, 3]);
  });
  test("nested indexes are followed", async () => {
    const nested: Record<string, string[]> = { [dg("4")]: [dg("7")], [dg("7")]: [dg("5")] };
    const keep = await close(new Map([[dg("4"), "newest"]]), async (d) => nested[d] ?? []);
    assert.deepEqual([...keep.keys()], [dg("4"), dg("7"), dg("5")]);
  });
});

describe("childDigests", () => {
  test("follows image manifests and nested indexes, not the layer blobs of a cache export", () =>
    assert.deepEqual(childDigests({ manifests: [
      { digest: dg("1"), mediaType: "application/vnd.oci.image.manifest.v1+json" },
      { digest: dg("2"), mediaType: "application/vnd.oci.image.index.v1+json" },
      { digest: dg("3"), mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" },
      { digest: dg("4"), mediaType: "application/vnd.buildkit.cacheconfig.v0" },
    ] }), [dg("1"), dg("2")]));
  test("a plain image manifest has no children", () => assert.deepEqual(childDigests({}), []));
});

describe("parse", () => {
  const base = ["--org", "o", "--repo", "o/r", "--keep-newest", "3", "--min-age-days", "2"];
  const read = (f: string) => (f === "pins" ? `app@${dg("a")}` : "no digests here");
  test("a dry run needs no --max-delete", () => assert.equal(parse(base, read, now).maxDelete, Number.POSITIVE_INFINITY));
  test("lists every missing mandatory flag", () =>
    assert.throws(() => parse(["--apply"], read), /missing --org, --repo or --package, --keep-newest, --min-age-days, --max-delete/));
  test("rejects an empty min-age instead of reading it as 0", () =>
    assert.throws(() => parse([...base.slice(0, 7), ""], read), /--min-age-days must be/));
  test("rejects keep-newest 0", () => assert.throws(() => parse([...base.slice(0, 5), "0", ...base.slice(6)], read), /--keep-newest must be/));
  test("a refs file without a single digest fails instead of protecting nothing", () =>
    assert.throws(() => parse([...base, "--keep-refs", "empty"], read), /names no <image>@sha256/));
  test("collects refs from files", () => assert.ok(parse([...base, "--keep-refs", "pins"], read, now).rules.refs.has(`app@${dg("a")}`)));
});

describe("run against a mocked GitHub", () => {
  // Package "app": a tagged index (1) with children 2 and 3, an old tagged build (4) and an orphan (5).
  const raw = [
    { id: 1, name: dg("1"), updated_at: "2026-11-07T00:00:00Z", metadata: { container: { tags: ["new"] } } },
    { id: 2, name: dg("2"), updated_at: "2026-11-07T00:00:00Z", metadata: { container: { tags: [] } } },
    { id: 3, name: dg("3"), updated_at: "2026-11-07T00:00:00Z", metadata: { container: { tags: [] } } },
    { id: 4, name: dg("4"), updated_at: "2026-10-01T00:00:00Z", metadata: { container: { tags: ["old"] } } },
    { id: 5, name: dg("5"), updated_at: "2026-10-01T00:00:00Z", metadata: { container: { tags: [] } } },
  ];
  const mock = (failManifest = false) => {
    const deletes: string[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const u = String(input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (init?.method === "DELETE") { deletes.push(u.split("/").pop() as string); return new Response(null, { status: 204 }); }
      if (u.includes("/orgs/o/packages?")) return json([{ name: "app", repository: { full_name: "o/r" } }, { name: "other", repository: { full_name: "o/x" } }]);
      if (u.includes("/packages/container/app/versions")) return json(raw);
      if (u.startsWith("https://ghcr.io/token")) return json({ token: "t" });
      if (u.includes("/manifests/")) {
        if (failManifest) return json({ errors: [] }, 500);
        return json(u.endsWith(dg("1")) ? { manifests: [{ digest: dg("2") }, { digest: dg("3") }] } : {});
      }
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    return deletes;
  };
  const quiet = async (f: () => Promise<void>) => {
    const [log, err] = [console.log, console.error];
    const out: string[] = [];
    console.log = (s: string) => out.push(s);
    console.error = () => {};
    try { await f(); } finally { [console.log, console.error] = [log, err]; }
    return out.map((l) => JSON.parse(l));
  };
  const args = ["--org", "o", "--repo", "o/r", "--keep-newest", "1", "--min-age-days", "0"];
  process.env.GITHUB_TOKEN = "x";

  test("a dry run deletes nothing and reports what it would delete", async () => {
    const deletes = mock();
    const out = await quiet(() => run(args, () => ""));
    assert.deepEqual(deletes, []);
    assert.deepEqual(out.filter((d) => d.action === "would-delete").map((d) => d.id), [4, 5]);
  });
  test("apply deletes only unkept versions of the repo's packages, capped by max-delete", async () => {
    const deletes = mock();
    const out = await quiet(() => run([...args, "--apply", "--max-delete", "1"], () => ""));
    assert.deepEqual(deletes, ["4"]);
    assert.deepEqual(out.map((d) => [d.id, d.action]), [[1, "keep"], [2, "keep"], [3, "keep"], [4, "deleted"], [5, "deferred"]]);
  });
  test("an unreadable manifest aborts before any delete", async () => {
    const deletes = mock(true);
    await assert.rejects(quiet(() => run([...args, "--apply", "--max-delete", "9"], () => "")), /→ 500/);
    assert.deepEqual(deletes, []);
  });
});
