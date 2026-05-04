export const DEFAULT_STREAM_NAME_TEMPLATE = "FTP {stream.serverPrefix}{stream.quality}";
export const DEFAULT_STREAM_DESCRIPTION_TEMPLATE = "{stream.serverName}{tools.newLine}{stream.filename}{tools.newLine}{stream.size::bytes}";

export type StreamFormatterContext = {
  addon: {
    name: string;
  };
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
  };
};

type TemplateKind = "name" | "description";

const TOKEN_PATTERN = /\{([^{}]+)\}/g;

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

export function formatStreamBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return "";
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function renderTemplate(template: string, context: StreamFormatterContext): string {
  return template.replace(TOKEN_PATTERN, (_match, expression: string) => {
    if (expression === "tools.newLine") return "\n";
    const [path, ...modifiers] = expression.split("::").map((part) => part.trim());
    const value = valueAtPath(path, context);
    return applyModifiers(value, modifiers);
  });
}

function valueAtPath(path: string, context: StreamFormatterContext): unknown {
  const parts = path.split(".");
  if (parts.length !== 2) return "";
  const [root, key] = parts as ["addon" | "stream", string];
  if (root !== "addon" && root !== "stream") return "";
  return (context[root] as Record<string, unknown>)[key] ?? "";
}

function applyModifiers(value: unknown, modifiers: string[]): string {
  let current = stringifyValue(value);
  for (const modifier of modifiers) {
    if (modifier === "upper") current = current.toUpperCase();
    if (modifier === "lower") current = current.toLowerCase();
    if (modifier === "title") current = titleCase(current);
    if (modifier === "bytes") current = formatStreamBytes(Number(value));
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function normalizeName(value: string): string {
  return value.replace(/[ \t]+/g, " ").replace(/\s+-\s+$/g, "").trim();
}

function normalizeDescription(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function titleCase(value: string): string {
  return value.replace(/\b([a-z])/gi, (letter) => letter.toUpperCase());
}
