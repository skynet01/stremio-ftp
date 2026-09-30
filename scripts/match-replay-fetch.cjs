/**
 * Fetches the TMDB requests that scripts/match-replay-check.ts reported as uncached, inside the production container
 * so the TMDB key never leaves the server. Reads a JSON array of request keys (path?query without api_key) on stdin and
 * prints { key: { status, body } } with bodies trimmed to what the matcher reads. Merge the output into the cache file.
 *
 *   ssh oracle 'cat > /tmp/f.cjs && docker cp /tmp/f.cjs stremio-ftp:/tmp/f.cjs' < scripts/match-replay-fetch.cjs
 *   ssh oracle 'docker exec -i stremio-ftp node /tmp/f.cjs' < /tmp/tmdb-missing.json > /tmp/tmdb-fetched.json
 */
const keys = JSON.parse(require("fs").readFileSync(0, "utf8"));
const apiKey = process.env.TMDB_API_KEY;
const pick = (r) => r && ({ id: r.id, title: r.title, name: r.name, original_title: r.original_title, original_name: r.original_name,
  release_date: r.release_date, first_air_date: r.first_air_date, genre_ids: r.genre_ids });
function trim(body) {
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body.results) && !body.titles) return { results: body.results.map(pick) };
  if (body.movie_results || body.tv_results) return { movie_results: (body.movie_results || []).map(pick), tv_results: (body.tv_results || []).map(pick) };
  if ("imdb_id" in body) return { imdb_id: body.imdb_id };
  return body;
}
const out = {};
let next = 0;
async function worker() {
  while (next < keys.length) {
    const key = keys[next++];
    for (let attempt = 0; attempt < 5; attempt++) {
      const url = `https://api.themoviedb.org${key}${key.includes("?") && !key.endsWith("?") ? "&" : ""}api_key=${apiKey}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
        out[key] = { status: res.status, body: res.ok ? trim(await res.json()) : {} };
        break;
      } catch { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); }
    }
  }
}
Promise.all(Array.from({ length: 6 }, worker)).then(() => { process.stderr.write(`fetched ${Object.keys(out).length}/${keys.length}\n`); process.stdout.write(JSON.stringify(out)); });
