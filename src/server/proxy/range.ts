export type ByteRange = { start: number; end: number; size: number };

export function parseRangeHeader(header: string | undefined, totalSize: number | null): ByteRange | null {
  if (!header || totalSize === null) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const totalEnd = totalSize - 1;
  if (match[1] === "" && match[2] === "") return null;
  if (match[1] === "") {
    const suffixSize = Number(match[2]);
    if (!Number.isInteger(suffixSize) || suffixSize <= 0) return null;
    const size = Math.min(suffixSize, totalSize);
    const start = totalSize - size;
    return { start, end: totalEnd, size };
  }

  const start = Number(match[1]);
  const hasExplicitEnd = match[2] !== "";
  const requestedEnd = hasExplicitEnd ? Number(match[2]) : totalEnd;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= totalSize
  ) {
    return null;
  }
  const end = Math.min(requestedEnd, totalEnd);
  return { start, end, size: end - start + 1 };
}
