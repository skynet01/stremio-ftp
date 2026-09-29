const STOP_WORDS = new Set(["the"]);

// Letters that Unicode decomposition does not reduce to ASCII.
const TRANSLITERATIONS: Record<string, string> = {
  æ: "",
  Æ: "", // Keep the established catalog spelling for "Æon Flux" ("on flux").
  œ: "oe",
  Œ: "OE",
  ø: "o",
  Ø: "O",
  ß: "ss",
  ẞ: "SS",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "TH",
  ł: "l",
  Ł: "L",
  ı: "i",
};
const TRANSLITERATION_PATTERN = new RegExp(`[${Object.keys(TRANSLITERATIONS).join("")}]`, "g");
// Two or more single letters each followed by a dot ("S.H.I.E.L.D.", "E.T.", "A.I."),
// optionally ending in one more letter without a dot.
const DOTTED_ACRONYM_PATTERN = /(?<![a-z0-9])(?:[a-z]\.){2,}(?:[a-z](?![a-z0-9]))?/gi;

/** Folds accents and ligatures to ASCII ("Æon" -> "Aeon", "Shōgun" -> "Shogun"). */
export function foldToAscii(input: string): string {
  return input
    .replace(TRANSLITERATION_PATTERN, (letter) => TRANSLITERATIONS[letter] ?? letter)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
}

/** Joins dotted acronyms ("S.H.I.E.L.D." -> "SHIELD ") while keeping a separator after them. */
export function collapseDottedAcronyms(input: string): string {
  return input.replace(DOTTED_ACRONYM_PATTERN, (acronym) => `${acronym.replace(/\./g, "")}${acronym.endsWith(".") ? " " : ""}`);
}

export function normalizeTitle(input: string): string {
  return collapseDottedAcronyms(foldToAscii(input.replace(/\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i, "")))
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
