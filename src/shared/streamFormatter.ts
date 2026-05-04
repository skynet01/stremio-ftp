export const DEFAULT_STREAM_NAME_TEMPLATE = "FTP {stream.serverPrefix}{stream.quality}";
export const DEFAULT_STREAM_DESCRIPTION_TEMPLATE = "{stream.serverName}{tools.newLine}{stream.filename}{tools.newLine}{stream.size::bytes}";

export type StreamFormatterContext = {
  config?: Record<string, unknown>;
  addon: {
    name: string;
    [key: string]: unknown;
  };
  service?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  debug?: Record<string, unknown>;
  stream: {
    mediaId: number;
    serverId: number | null;
    serverName: string;
    serverPrefix: string;
    filename: string;
    path: string;
    extension: string;
    quality: string;
    size: number | null;
    deliveryMode: string;
    videoTags: string;
    visualTags: string[];
    encode: string;
    audioTags: string[];
    audioChannels: string[];
    [key: string]: unknown;
  };
};

type TemplateKind = "name" | "description";

const REMOVE_LINE = "\u0000REMOVE_LINE\u0000";
const CONDITIONALS = new Set(["istrue", "isfalse", "exists"]);
const OPERATORS = new Set(["and", "or", "xor"]);

const SMALL_CAPS: Record<string, string> = {
  a: "ᴀ",
  b: "ʙ",
  c: "ᴄ",
  d: "ᴅ",
  e: "ᴇ",
  f: "ғ",
  g: "ɢ",
  h: "ʜ",
  i: "ɪ",
  j: "ᴊ",
  k: "ᴋ",
  l: "ʟ",
  m: "ᴍ",
  n: "ɴ",
  o: "ᴏ",
  p: "ᴘ",
  q: "ϙ",
  r: "ʀ",
  s: "ꜱ",
  t: "ᴛ",
  u: "ᴜ",
  v: "ᴠ",
  w: "ᴡ",
  x: "х",
  y: "ʏ",
  z: "ᴢ",
};

export function renderStreamTemplate(template: string | null | undefined, context: StreamFormatterContext, kind: TemplateKind): string {
  const fallback = kind === "name" ? DEFAULT_STREAM_NAME_TEMPLATE : DEFAULT_STREAM_DESCRIPTION_TEMPLATE;
  const rendered = renderTemplate(template?.trim() || fallback, context);
  const normalized = kind === "name" ? normalizeName(rendered) : normalizeDescription(rendered);
  if (normalized) return normalized;
  const fallbackRendered = renderTemplate(fallback, context);
  return kind === "name" ? normalizeName(fallbackRendered) : normalizeDescription(fallbackRendered);
}

export function streamExtension(filename: string) {
  const match = filename.match(/(\.[^./\\]+)$/);
  return match ? match[1] : "";
}

export function streamVideoTagList(filename: string) {
  return tagList([
    [/\bimax\b/i, "IMAX"],
    [/\b(?:dv|dovi|dolby[ ._-]?vision)\b/i, "DV"],
    [/\bhdr10\+\b/i, "HDR10+"],
    [/\bhdr10\b/i, "HDR10"],
    [/\bhdr\b/i, "HDR"],
    [/\bremux\b/i, "Remux"],
  ], filename);
}

export function streamVideoTags(filename: string) {
  const visualTags = streamVideoTagList(filename).map((tag) => (tag === "DV" ? "Dolby Vision" : tag));
  const remux = visualTags.includes("Remux") ? ["Remux"] : [];
  return [...visualTags.filter((tag) => tag !== "Remux"), streamEncode(filename), ...remux].filter(Boolean).join(" ");
}

export function streamEncode(filename: string) {
  return tagList([
    [/\b(?:h[ ._-]?265|x265|hevc)\b/i, "HEVC"],
    [/\b(?:h[ ._-]?264|x264|avc)\b/i, "AVC"],
    [/\bav1\b/i, "AV1"],
  ], filename)[0] ?? "";
}

export function streamAudioTagList(filename: string) {
  return tagList([
    [/\batmos\b/i, "Atmos"],
    [/\btruehd\b/i, "TrueHD"],
    [/\bdts[ ._-]?x\b/i, "DTS-X"],
    [/\bdts[ ._-]?hd(?:[ ._-]?ma)?\b/i, "DTS-HD MA"],
    [/\bdts\b/i, "DTS"],
    [/\b(?:e[ ._-]?ac[ ._-]?3|ddp|dd\+)\b/i, "DD+"],
    [/\bac[ ._-]?3\b/i, "DD"],
    [/\baac\b/i, "AAC"],
    [/\bflac\b/i, "FLAC"],
  ], filename);
}

export function streamAudioTags(filename: string) {
  return [...streamAudioTagList(filename), ...streamAudioChannels(filename)].join(" ");
}

export function streamAudioChannels(filename: string) {
  return tagList([
    [/\b7\.1\b/i, "7.1"],
    [/\b5\.1\b/i, "5.1"],
    [/\b2\.0\b/i, "2.0"],
  ], filename);
}

export function formatStreamBytes(bytes: number | null | undefined, concise = false): string {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = unit >= 3 && value < 10 ? 1 : 0;
  const formatted = concise ? value.toFixed(precision).replace(/\.0$/, "") : value.toFixed(precision);
  return concise ? `${formatted}${units[unit]}` : `${formatted} ${units[unit]}`;
}

function renderTemplate(template: string, context: StreamFormatterContext): string {
  let output = "";
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== "{") {
      output += template[index];
      continue;
    }
    const end = findFormatterEnd(template, index + 1);
    if (end === -1) {
      output += template[index];
      continue;
    }
    output += renderExpression(template.slice(index + 1, end), context);
    index = end;
  }
  return output;
}

function renderExpression(expression: string, context: StreamFormatterContext): string {
  const trimmed = expression.trim();
  if (trimmed === "tools.newLine") return "\n";
  if (trimmed === "tools.removeLine") return REMOVE_LINE;

  const conditional = splitConditional(trimmed);
  if (conditional) {
    const branch = evaluateCondition(conditional.condition, context) ? conditional.trueBranch : conditional.falseBranch;
    return renderTemplate(branch, context);
  }

  const [path, ...modifiers] = splitTopLevel(trimmed, "::").map((part) => part.trim());
  const value = applyModifiers(valueAtPath(path, context), modifiers);
  return stringifyValue(value);
}

function splitConditional(expression: string): { condition: string; trueBranch: string; falseBranch: string } | null {
  const bracket = findTopLevelChar(expression, "[");
  if (bracket === -1 || !expression.endsWith("]")) return null;
  const branches = splitTopLevel(expression.slice(bracket + 1, -1), "||");
  if (branches.length !== 2) return null;
  return {
    condition: expression.slice(0, bracket),
    trueBranch: unquote(branches[0].trim()),
    falseBranch: unquote(branches[1].trim()),
  };
}

function evaluateCondition(condition: string, context: StreamFormatterContext) {
  const tokens = splitTopLevel(condition, "::").map((part) => part.trim()).filter(Boolean);
  if (!tokens.length) return false;

  let index = 0;
  let result = evaluateClause(tokens, index, context);
  index += result.consumed;

  while (index < tokens.length) {
    const operator = tokens[index];
    if (!OPERATORS.has(operator)) {
      index += 1;
      continue;
    }
    const next = evaluateClause(tokens, index + 1, context);
    if (operator === "and") result.value = result.value && next.value;
    if (operator === "or") result.value = result.value || next.value;
    if (operator === "xor") result.value = result.value !== next.value;
    index += 1 + next.consumed;
  }

  return result.value;
}

function evaluateClause(tokens: string[], start: number, context: StreamFormatterContext): { value: boolean; consumed: number } {
  const path = tokens[start];
  let value = valueAtPath(path, context);
  let consumed = 1;
  let conditionSeen = false;
  let conditionResult = truthy(value);

  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (OPERATORS.has(token) || looksLikePath(token)) break;
    consumed += 1;

    const conditional = evaluateConditionalModifier(value, token);
    if (conditional !== null) {
      const previousConditionSeen = conditionSeen;
      conditionSeen = true;
      conditionResult =
        previousConditionSeen && (token === "istrue" || token === "isfalse") ? evaluateConditionalModifier(conditionResult, token) ?? conditional : conditional;
      continue;
    }

    value = applyModifier(value, token);
  }

  return { value: conditionSeen ? conditionResult : truthy(value), consumed };
}

function valueAtPath(path: string, context: StreamFormatterContext): unknown {
  const parts = path.split(".");
  if (parts.length !== 2) return "";
  const [root, key] = parts;

  if (root === "config" && key === "addonName") return context.addon.name;
  if (root === "stream" && key === "container") return String(context.stream.extension || "").replace(/^\./, "");
  if (root === "stream" && key === "resolution") return context.stream.quality;
  if (root === "stream" && key === "videoTags") return context.stream.videoTags;
  if (root === "stream" && key === "folderSize") return context.stream.size;

  const rootValue = rootObject(root, context);
  return rootValue?.[key] ?? "";
}

function rootObject(root: string, context: StreamFormatterContext): Record<string, unknown> | null {
  if (root === "addon") return context.addon;
  if (root === "stream") return context.stream;
  if (root === "config") return context.config ?? {};
  if (root === "service") return context.service ?? {};
  if (root === "metadata") return context.metadata ?? {};
  if (root === "debug") return context.debug ?? {};
  return {};
}

function applyModifiers(value: unknown, modifiers: string[]): unknown {
  let current = value;
  for (const modifier of modifiers) {
    current = applyModifier(current, modifier);
  }
  return current;
}

function applyModifier(value: unknown, modifier: string): unknown {
  const trimmed = modifier.trim();
  if (!trimmed) return value;
  if (trimmed === "upper") return stringifyValue(value).toUpperCase();
  if (trimmed === "lower") return stringifyValue(value).toLowerCase();
  if (trimmed === "smallcaps") return smallCaps(stringifyValue(value));
  if (trimmed === "title") return titleCase(stringifyValue(value));
  if (trimmed === "length") return Array.isArray(value) ? value.length : stringifyValue(value).length;
  if (trimmed === "reverse") return Array.isArray(value) ? [...value].reverse() : [...stringifyValue(value)].reverse().join("");
  if (trimmed === "sort" || trimmed === "lsort") return Array.isArray(value) ? [...value].sort() : value;
  if (trimmed === "rsort") return Array.isArray(value) ? [...value].sort().reverse() : value;
  if (trimmed === "first") return Array.isArray(value) ? value[0] ?? "" : stringifyValue(value)[0] ?? "";
  if (trimmed === "last") return Array.isArray(value) ? value.at(-1) ?? "" : stringifyValue(value).at(-1) ?? "";
  if (trimmed === "string") return stringifyValue(value);
  if (["bytes", "bytes10", "bytes2", "rbytes", "rbytes10", "rbytes2"].includes(trimmed)) return formatStreamBytes(Number(value));
  if (["sbytes", "sbytes10", "sbytes2"].includes(trimmed)) return formatStreamBytes(Number(value), true);
  if (["bitrate", "rbitrate", "sbitrate"].includes(trimmed)) return formatBitrate(Number(value));
  if (trimmed === "time") return formatSeconds(Number(value));
  if (trimmed === "hex") return Number(value).toString(16);
  if (trimmed === "octal") return Number(value).toString(8);
  if (trimmed === "binary") return Number(value).toString(2);

  const call = parseCall(trimmed);
  if (call?.name === "replace") return stringifyValue(value).split(call.args[0] ?? "").join(call.args[1] ?? "");
  if (call?.name === "truncate") return truncate(stringifyValue(value), Number(call.args[0]));
  if (call?.name === "join") return Array.isArray(value) ? value.map(stringifyValue).filter(Boolean).join(call.args[0] ?? ", ") : stringifyValue(value);
  if (call?.name === "slice" && Array.isArray(value)) return value.slice(Number(call.args[0] ?? 0), call.args[1] === undefined ? undefined : Number(call.args[1]));

  return value;
}

function evaluateConditionalModifier(value: unknown, modifier: string): boolean | null {
  if (CONDITIONALS.has(modifier)) {
    if (modifier === "exists") return exists(value);
    if (modifier === "istrue") return value === true;
    if (modifier === "isfalse") return value === false;
  }
  const operator = modifier.match(/^(>=|<=|>|<|=|~|\$|\^)(.*)$/);
  if (!operator) return null;
  const expected = operator[2];
  const actual = stringifyValue(value);
  if (operator[1] === "=") return Array.isArray(value) ? value.map(stringifyValue).includes(expected) : actual === expected;
  if (operator[1] === "~") return Array.isArray(value) ? value.map(stringifyValue).some((item) => item.includes(expected)) : actual.includes(expected);
  if (operator[1] === "$") return actual.startsWith(expected);
  if (operator[1] === "^") return actual.endsWith(expected);
  const left = Number(value);
  const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator[1] === ">=") return left >= right;
  if (operator[1] === "<=") return left <= right;
  if (operator[1] === ">") return left > right;
  if (operator[1] === "<") return left < right;
  return null;
}

function findFormatterEnd(template: string, start: number) {
  let quote: string | null = null;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = start; index < template.length; index += 1) {
    const char = template[index];
    if (quote) {
      if (char === "\\" && index + 1 < template.length) index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (char === "}" && bracketDepth === 0 && parenDepth === 0) return index;
  }
  return -1;
}

function findTopLevelChar(value: string, needle: string) {
  let quote: string | null = null;
  let parenDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && index + 1 < value.length) index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (char === needle && parenDepth === 0) return index;
  }
  return -1;
}

function splitTopLevel(value: string, separator: string) {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && index + 1 < value.length) index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (bracketDepth === 0 && parenDepth === 0 && value.startsWith(separator, index)) {
      parts.push(value.slice(start, index));
      index += separator.length - 1;
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parseCall(modifier: string): { name: string; args: string[] } | null {
  const open = modifier.indexOf("(");
  if (open === -1 || !modifier.endsWith(")")) return null;
  return {
    name: modifier.slice(0, open),
    args: splitTopLevel(modifier.slice(open + 1, -1), ",").map((arg) => unquote(arg.trim())),
  };
}

function unquote(value: string) {
  const unwrapped =
    (value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value;
  return unwrapped.replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\'/g, "'");
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(stringifyValue).filter(Boolean).join(" ");
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function truthy(value: unknown) {
  if (typeof value === "boolean") return value;
  return exists(value);
}

function exists(value: unknown) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function looksLikePath(value: string) {
  return /^(stream|addon|config|service|metadata|debug)\.[A-Za-z0-9_]+$/.test(value);
}

function normalizeName(value: string): string {
  return removeMarkedLines(value).replace(/[ \t]+/g, " ").replace(/\s+-\s+$/g, "").trim();
}

function normalizeDescription(value: string): string {
  return removeMarkedLines(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function removeMarkedLines(value: string) {
  return value
    .split(/\r?\n/)
    .filter((line) => !line.includes(REMOVE_LINE))
    .join("\n");
}

function titleCase(value: string): string {
  return value.replace(/\b([a-z])/gi, (letter) => letter.toUpperCase());
}

function smallCaps(value: string) {
  return value.replace(/[A-Za-z]/g, (letter) => SMALL_CAPS[letter.toLowerCase()] ?? letter);
}

function truncate(value: string, length: number) {
  if (!Number.isFinite(length) || length <= 0 || value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

function formatBitrate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} Kbps`;
  return `${value} bps`;
}

function formatSeconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function tagList(patterns: Array<[RegExp, string]>, value: string) {
  const seen = new Set<string>();
  for (const [pattern, label] of patterns) {
    if (pattern.test(value)) seen.add(label);
  }
  return Array.from(seen);
}
