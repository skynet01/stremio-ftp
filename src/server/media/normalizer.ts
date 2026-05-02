const STOP_WORDS = new Set(["the"]);

export function normalizeTitle(input: string): string {
  return input
    .replace(/\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i, "")
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/s\.h\.i\.e\.l\.d/gi, "shield")
    .replace(/[\._-]+/g, " ")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part && !STOP_WORDS.has(part))
    .join(" ")
    .trim();
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
