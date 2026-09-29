/**
 * Re-parses an exported corpus of indexed files with the current parser and
 * reports what would change. Nothing is written anywhere; the corpus stays
 * local and is never committed.
 *
 *   npx tsx scripts/parse-corpus-check.ts --corpus /tmp/stremio-parse-corpus.jsonl
 *     [--baseline-parser /path/to/old/parser.ts]  compare against an older parser as well
 *     [--examples 6]                              examples printed per group
 *     [--all-matched]                             list every changed matched row
 *
 * Corpus format: one JSON object per line with src, layout, ftp_path, filename,
 * media_kind, catalog_kind, parsed_title, parsed_year, season, episode, imdb_id,
 * status ("matched" | "unmatched" | ...), meta_id, meta_type, meta_name.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { normalizeTitle } from "../src/server/media/normalizer.js";
import { parseMediaPath, type ParseMediaOptions, type ParsedMedia } from "../src/server/media/parser.js";

type CorpusRow = {
  src: string;
  layout: "auto" | "folders" | "flat";
  ftp_path: string;
  filename: string;
  media_kind: "movie" | "series";
  catalog_kind: "movie" | "series" | "anime";
  parsed_title: string | null;
  parsed_year: number | null;
  season: number | null;
  episode: number | null;
  imdb_id: string | null;
  status: string | null;
  meta_id: string | null;
  meta_type: string | null;
  meta_name: string | null;
};

type ParseFn = (ftpPath: string, options?: ParseMediaOptions) => ParsedMedia | null;

type Comparable = {
  mediaKind: string;
  catalogKind: string;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
};

const FIELDS = ["kind", "title", "year", "season", "episode"] as const;
type Field = (typeof FIELDS)[number];

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fromRow(row: CorpusRow): Comparable {
  return {
    mediaKind: row.media_kind,
    catalogKind: row.catalog_kind,
    title: row.parsed_title ?? "",
    year: row.parsed_year,
    season: row.season,
    episode: row.episode,
  };
}

function fromParsed(parsed: ParsedMedia | null): Comparable | null {
  if (!parsed) return null;
  return {
    mediaKind: parsed.mediaKind,
    catalogKind: parsed.catalogKind,
    title: parsed.parsedTitle,
    year: parsed.parsedYear,
    season: parsed.season,
    episode: parsed.episode,
  };
}

function changedFields(before: Comparable, after: Comparable | null): Field[] {
  if (!after) return [...FIELDS];
  const changed: Field[] = [];
  if (before.mediaKind !== after.mediaKind || before.catalogKind !== after.catalogKind) changed.push("kind");
  if (before.title !== after.title) changed.push("title");
  if (before.year !== after.year) changed.push("year");
  if (before.season !== after.season) changed.push("season");
  if (before.episode !== after.episode) changed.push("episode");
  return changed;
}

function describe(value: Comparable | null) {
  if (!value) return "(not parsed)";
  const kind = value.mediaKind === value.catalogKind ? value.mediaKind : `${value.mediaKind}/${value.catalogKind}`;
  const episode = value.season !== null || value.episode !== null ? ` S${value.season ?? "?"}E${value.episode ?? "?"}` : "";
  return `${kind} "${value.title}"${value.year ? ` (${value.year})` : ""}${episode}`;
}

function itemKey(value: Comparable, imdbId: string | null) {
  return [value.catalogKind, imdbId ?? "", value.title.toLowerCase(), value.year ?? ""].join("|");
}

const CONTENT_TYPE_CHOICES: NonNullable<ParseMediaOptions["contentTypes"]>[] = [];
for (const movies of [true, false]) {
  for (const series of [true, false]) {
    for (const anime of [true, false]) CONTENT_TYPE_CHOICES.push({ movies, series, anime });
  }
}

function inferOptions(rows: CorpusRow[], parse: ParseFn): ParseMediaOptions {
  const layout = rows[0]?.layout ?? "auto";
  const sample = rows.length > 3000 ? rows.filter((_, index) => index % Math.ceil(rows.length / 3000) === 0) : rows;
  let best: { options: ParseMediaOptions; score: number } | null = null;
  for (const contentTypes of CONTENT_TYPE_CHOICES) {
    const options: ParseMediaOptions = { contentTypes, libraryLayout: layout };
    let score = 0;
    for (const row of sample) {
      if (changedFields(fromRow(row), fromParsed(parse(row.ftp_path, options))).length === 0) score += 1;
    }
    if (!best || score > best.score) best = { options, score };
  }
  return best!.options;
}

function resolutionYearFixed(row: CorpusRow, after: Comparable | null) {
  if (!row.parsed_year || after?.year === row.parsed_year) return false;
  const year = String(row.parsed_year);
  return new RegExp(`${year}(?:p|i\\b|x\\d)|\\dx${year}`, "i").test(row.filename);
}

function unmatchedPattern(row: CorpusRow, after: Comparable | null, fields: Field[]) {
  if (!after) return "no longer parsed";
  if (resolutionYearFixed(row, after)) return "1 resolution number no longer a year";
  if (after.mediaKind === "series" && (row.media_kind !== "series" || row.season === null || fields.includes("season") || fields.includes("episode"))) {
    return "3 episode format recognised";
  }
  if (fields.includes("year") && !fields.includes("title")) return "2 year changed";
  if (fields.includes("title")) {
    if (/\b(?:19|20)\d{2}\b/.test(row.parsed_title ?? "") && after.year) return "4a year moved out of title";
    if (/(?:^| )(?:[a-z] ){2,}[a-z](?: |$)/.test(row.parsed_title ?? "")) return "4b dotted acronym";
    if (/[^\x00-\x7f]/.test(row.ftp_path)) return "4c non-ASCII transliteration";
    return "4d other title cleaning";
  }
  return `other: ${fields.join("+")}`;
}

async function main() {
  const corpusPath = argValue("--corpus");
  if (!corpusPath) {
    console.error("usage: npx tsx scripts/parse-corpus-check.ts --corpus <file.jsonl> [--baseline-parser <parser.ts>] [--examples N] [--all-matched]");
    process.exit(2);
  }
  const exampleCount = Number(argValue("--examples") ?? 6);
  const listAllMatched = process.argv.includes("--all-matched");
  const baselinePath = argValue("--baseline-parser");
  const baselineParse: ParseFn | null = baselinePath
    ? ((await import(pathToFileURL(resolve(baselinePath)).href)) as { parseMediaPath: ParseFn }).parseMediaPath
    : null;

  const rows = readFileSync(corpusPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CorpusRow);

  const bySource = new Map<string, CorpusRow[]>();
  for (const row of rows) bySource.set(row.src, [...(bySource.get(row.src) ?? []), row]);

  console.log(`Corpus: ${rows.length} rows, ${rows.filter((row) => row.status === "matched").length} matched, ${rows.filter((row) => row.status !== "matched").length} unmatched`);
  console.log("\nInferred parser options per source (best agreement with stored parse):");
  const optionsBySource = new Map<string, ParseMediaOptions>();
  for (const [src, sourceRows] of bySource) {
    const options = inferOptions(sourceRows, baselineParse ?? parseMediaPath);
    optionsBySource.set(src, options);
    const types = options.contentTypes!;
    console.log(`  ${src.padEnd(20)} layout=${options.libraryLayout} movies=${types.movies} series=${types.series} anime=${types.anime} (${sourceRows.length} rows)`);
  }

  let changedVsStored = 0;
  let changedVsBaseline = 0;
  let baselineStale = 0;
  const matchedChanges: Array<{ row: CorpusRow; after: Comparable | null; fields: Field[]; label: string; agreeBefore: boolean; agreeAfter: boolean }> = [];
  const unmatchedChanges: Array<{ row: CorpusRow; after: Comparable | null; pattern: string }> = [];
  const oldKeys = new Set<string>();
  const newKeys = new Set<string>();
  const newKeysByKind = new Map<string, Set<string>>();

  for (const row of rows) {
    const options = optionsBySource.get(row.src)!;
    const before = fromRow(row);
    const after = fromParsed(parseMediaPath(row.ftp_path, options));
    const fields = changedFields(before, after);
    oldKeys.add(`${row.src}#${itemKey(before, row.imdb_id)}`);
    if (after) newKeys.add(`${row.src}#${itemKey(after, row.imdb_id)}`);

    if (baselineParse) {
      const baseline = fromParsed(baselineParse(row.ftp_path, options));
      if (changedFields(before, baseline).length) baselineStale += 1;
      if (baseline && after && changedFields(baseline, after).length) changedVsBaseline += 1;
    }
    if (!fields.length) continue;
    changedVsStored += 1;

    if (row.status === "matched") {
      const metaTitle = normalizeTitle(row.meta_name ?? "");
      const kindLabel = fields.includes("kind") ? `kind ${describeKind(before)}->${after ? describeKind(after) : "none"}` : null;
      const label = [kindLabel, ...fields.filter((field) => field !== "kind")].filter(Boolean).join(" + ");
      matchedChanges.push({
        row,
        after,
        fields,
        label,
        agreeBefore: normalizeTitle(before.title) === metaTitle,
        agreeAfter: Boolean(after && normalizeTitle(after.title) === metaTitle),
      });
    } else {
      unmatchedChanges.push({ row, after, pattern: unmatchedPattern(row, after, fields) });
    }
  }

  for (const key of newKeys) {
    if (oldKeys.has(key)) continue;
    const src = key.split("#")[0];
    newKeysByKind.set(src, (newKeysByKind.get(src) ?? new Set()).add(key));
  }

  console.log(`\nRows whose parse differs from the stored parse: ${changedVsStored} of ${rows.length}`);
  if (baselineParse) {
    console.log(`  of which the baseline parser already disagreed with the stored row (stale rows): ${baselineStale}`);
    console.log(`  rows where the new parser differs from the baseline parser: ${changedVsBaseline}`);
  }
  const newKeyTotal = Array.from(newKeysByKind.values()).reduce((sum, keys) => sum + keys.size, 0);
  console.log(`New enrichment item keys (need one TMDB lookup each): ${newKeyTotal}`);
  for (const [src, keys] of newKeysByKind) console.log(`  ${src.padEnd(20)} ${keys.size}`);

  console.log(`\n=== MATCHED rows with a changed title/year/season/episode/kind: ${matchedChanges.length} ===`);
  const agreeLost = matchedChanges.filter((change) => change.agreeBefore && !change.agreeAfter).length;
  const agreeGained = matchedChanges.filter((change) => !change.agreeBefore && change.agreeAfter).length;
  console.log(`Title equals the normalized TMDB name: lost ${agreeLost}, gained ${agreeGained} (series streams need this equality)`);
  const byLabel = groupBy(matchedChanges, (change) => change.label);
  for (const [label, changes] of sortedGroups(byLabel)) {
    const items = new Set(changes.map((change) => `${change.row.src}#${change.row.parsed_title}|${change.row.parsed_year}`));
    console.log(`\n-- ${label}: ${changes.length} rows, ${items.size} items`);
    const shown = listAllMatched ? changes : distinctBy(changes, (change) => `${change.row.parsed_title}|${change.after?.title}|${change.after?.year}`).slice(0, exampleCount);
    for (const change of shown) {
      console.log(`   ${describe(fromRow(change.row))} -> ${describe(change.after)}  [TMDB: ${change.row.meta_name}]`);
      console.log(`      ${change.row.ftp_path}`);
    }
  }

  console.log(`\n=== UNMATCHED rows with a changed parse: ${unmatchedChanges.length} of ${rows.filter((row) => row.status !== "matched").length} ===`);
  const byPattern = groupBy(unmatchedChanges, (change) => change.pattern);
  for (const [pattern, changes] of Array.from(byPattern).sort(([a], [b]) => a.localeCompare(b))) {
    const items = new Set(changes.map((change) => `${change.row.src}#${change.after ? itemKey(change.after, change.row.imdb_id) : ""}`));
    console.log(`\n-- ${pattern}: ${changes.length} rows, ${items.size} new items`);
    for (const change of distinctBy(changes, (entry) => `${entry.row.parsed_title}|${entry.after?.title}`).slice(0, exampleCount)) {
      console.log(`   ${describe(fromRow(change.row))} -> ${describe(change.after)}`);
      console.log(`      ${change.row.ftp_path}`);
    }
  }
}

function describeKind(value: Comparable) {
  return value.mediaKind === value.catalogKind ? value.mediaKind : `${value.mediaKind}/${value.catalogKind}`;
}

function groupBy<T>(values: T[], keyOf: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function sortedGroups<T>(groups: Map<string, T[]>) {
  return Array.from(groups).sort(([, a], [, b]) => b.length - a.length);
}

function distinctBy<T>(values: T[], keyOf: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

void main();
