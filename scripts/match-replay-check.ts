/**
 * Replays the TMDB matcher over an exported catalog corpus with recorded TMDB responses, so a matcher change can be
 * scored against a whole library before release. Nothing is written except the files named below; the corpus and
 * the response cache stay local and are never committed.
 *
 *   npx tsx scripts/match-replay-check.ts --items /tmp/prod-items.json --cache /tmp/tmdb-replay.json
 *     [--missing /tmp/tmdb-missing.json]  write TMDB requests the cache cannot answer (fetch them, then re-run)
 *     [--matcher /path/to/tmdbClient.ts]   score another matcher version instead of the current one
 *     [--out /tmp/match-replay.json]       write every item's outcome for diffing two runs
 *     [--examples 20]                      examples printed per group
 *     [--trace "evil dead"]                print the TMDB requests and answers for items whose key contains this
 *
 * Fill the cache by repeating: run with --missing, fetch those requests with scripts/match-replay-fetch.cjs, merge the
 * result into the cache. A few rounds reach zero uncached requests. Export the items read-only from production:
 *   select catalog_kind, media_kind, parsed_title, parsed_year, alternate_title, alternate_year, source_imdb_id,
 *          meta_id, count(*) n from catalog_enrichment group by 1,2,3,4,5,6,7,8
 * plus the distinct stored metas (meta_id, meta_type, meta_name, release_info).
 *
 * Items file: { rows: [{ catalog_kind, media_kind, parsed_title, parsed_year, alternate_title, alternate_year,
 * source_imdb_id, meta_id, n }], metas: [{ meta_id, meta_type, meta_name, release_info }] }, one row per group of
 * catalog_enrichment rows. Cache file: { "<path>?<query without api_key>": { status, body } }.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CatalogItem, PersistedCatalogMeta } from "../src/server/media/mediaRepository.js";

type ExportRow = {
  catalog_kind: "movie" | "series" | "anime";
  media_kind: "movie" | "series";
  parsed_title: string;
  parsed_year: number | null;
  alternate_title: string | null;
  alternate_year: number | null;
  source_imdb_id: string | null;
  meta_id: string | null;
  n: number;
};
type ExportMeta = { meta_id: string; meta_type: "movie" | "series"; meta_name: string; release_info: string | null };
type CachedResponse = { status: number; body: unknown };
type Item = CatalogItem & { key: string; rows: number; matchedRows: number; storedId: string | null };
type Outcome = { key: string; rows: number; storedId: string | null; storedName: string | null; freshId: string | null; freshName: string | null; finalId: string | null };

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
const itemsPath = args.get("items");
const cachePath = args.get("cache");
if (!itemsPath || !cachePath) throw new Error("--items and --cache are required");
const examples = Number(args.get("examples") ?? 20);

const matcher = await import(pathToFileURL(resolve(args.get("matcher") ?? "src/server/metadata/tmdbClient.ts")).href);
const { rows, metas } = JSON.parse(readFileSync(itemsPath, "utf8")) as { rows: ExportRow[]; metas: ExportMeta[] };
const cache = (existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {}) as Record<string, CachedResponse>;
const metaById = new Map(metas.map((meta) => [meta.meta_id, meta]));

const items = collapseRows(rows);
const missing = new Set<string>();
const trace = args.get("trace");
let tracing = false;
globalThis.fetch = (async (input: URL | RequestInfo) => {
  const key = cacheKey(new URL(String(input)));
  const cached = cache[key];
  if (!cached) missing.add(key);
  if (tracing) console.log(`  ${key} -> ${cached ? JSON.stringify(cached.body).slice(0, 600) : "uncached"}`);
  const status = cached?.status ?? 404;
  return { ok: status >= 200 && status < 300, status, json: async () => cached?.body ?? {} } as Response;
}) as typeof fetch;

const outcomes: Outcome[] = [];
for (const item of items) {
  const catalogKind = item.catalogKind === "anime" ? item.mediaKind : item.catalogKind;
  const stored = storedMeta(item.storedId);
  tracing = Boolean(trace && item.key.includes(trace));
  if (tracing) console.log(item.key);
  const result = await matcher.tmdbCatalogEnrichment(item, "replay-key", catalogKind);
  const fresh = result.status === "matched" ? result.meta : null;
  const choice = stored ? matcher.catalogRecheckChoice(item, stored, fresh, catalogKind) : fresh ? "fresh" : "none";
  outcomes.push({
    key: item.key,
    rows: item.rows,
    storedId: item.storedId,
    storedName: stored?.name ?? null,
    freshId: fresh?.id ?? null,
    freshName: fresh?.name ?? null,
    finalId: choice === "existing" ? item.storedId : choice === "fresh" ? fresh!.id : null,
  });
}

if (args.get("missing")) writeFileSync(args.get("missing")!, JSON.stringify(Array.from(missing)));
if (args.get("out")) writeFileSync(args.get("out")!, JSON.stringify(outcomes));

console.log(`items ${items.length}, rows ${sum(items.map((item) => item.rows))}, uncached TMDB requests ${missing.size}`);
report("Recheck of stored rows (what existing users see)", (outcome) => outcome.finalId);
report("Fresh search only (what a new file gets)", (outcome) => outcome.freshId);

function report(title: string, resultId: (outcome: Outcome) => string | null) {
  const groups = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const id = resultId(outcome);
    const group = outcome.storedId
      ? id === outcome.storedId ? "same match" : id ? "different match" : "lost match"
      : id ? "gained match" : "still unmatched";
    groups.set(group, [...(groups.get(group) ?? []), outcome]);
  }
  console.log(`\n== ${title}`);
  for (const [group, list] of Array.from(groups).sort()) {
    console.log(`${group}: ${list.length} items, ${sum(list.map((outcome) => outcome.rows))} rows`);
    if (group === "same match" || group === "still unmatched") continue;
    for (const outcome of list.sort((a, b) => b.rows - a.rows).slice(0, examples)) {
      const id = resultId(outcome);
      const name = id === outcome.freshId ? outcome.freshName : outcome.storedName;
      console.log(`  ${outcome.rows}\t${outcome.key}\t${outcome.storedName ?? "-"} (${outcome.storedId ?? "-"}) -> ${id ? `${name} (${id})` : "-"}`);
    }
  }
}

function collapseRows(exportRows: ExportRow[]): Item[] {
  const byKey = new Map<string, { row: ExportRow; rows: number; matchedRows: number; votes: Map<string, number> }>();
  for (const row of exportRows) {
    const key = [row.catalog_kind, row.media_kind, row.parsed_title, row.parsed_year ?? "-", row.alternate_title ?? "-", row.source_imdb_id ?? "-"].join("|");
    const entry = byKey.get(key) ?? { row, rows: 0, matchedRows: 0, votes: new Map<string, number>() };
    entry.rows += row.n;
    if (row.alternate_year && (!entry.row.alternate_year || row.alternate_year > entry.row.alternate_year)) entry.row = { ...entry.row, alternate_year: row.alternate_year };
    if (row.meta_id) {
      entry.matchedRows += row.n;
      entry.votes.set(row.meta_id, (entry.votes.get(row.meta_id) ?? 0) + row.n);
    }
    byKey.set(key, entry);
  }
  return Array.from(byKey, ([key, { row, rows: rowCount, matchedRows, votes }]) => ({
    key,
    rows: rowCount,
    matchedRows,
    storedId: Array.from(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    mediaKind: row.media_kind,
    catalogKind: row.catalog_kind,
    parsedTitle: row.parsed_title,
    parsedYear: row.parsed_year,
    imdbId: row.source_imdb_id,
    alternateTitle: row.alternate_title,
    alternateYear: row.alternate_year,
  }));
}

function storedMeta(id: string | null): PersistedCatalogMeta | null {
  const meta = id ? metaById.get(id) : undefined;
  return meta ? { id: meta.meta_id, type: meta.meta_type, name: meta.meta_name, releaseInfo: meta.release_info ?? undefined } : null;
}

function cacheKey(url: URL) {
  const params = Array.from(url.searchParams).filter(([name]) => name !== "api_key").sort(([a], [b]) => a.localeCompare(b));
  return `${url.pathname}?${new URLSearchParams(params).toString()}`;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
