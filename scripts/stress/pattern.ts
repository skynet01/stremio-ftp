// Deterministic file contents: every 4-byte word is a bijective hash of its word index and the file seed,
// so any byte can be regenerated from its position and an offset or ordering error never matches by accident.

function wordAt(wordIndex: number, seed: number) {
  let x = (wordIndex ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function patternBytes(seed: number, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const firstWord = Math.floor(start / 4);
  const lastWord = Math.floor((start + length - 1) / 4);
  const words = new Uint32Array(lastWord - firstWord + 1);
  for (let index = 0; index < words.length; index += 1) words[index] = wordAt(firstWord + index, seed);
  const offset = start - firstWord * 4;
  return Buffer.from(words.buffer, words.byteOffset + offset, length);
}

// Returns the index of the first mismatching byte, or -1 when the chunk matches the file at `start`.
export function firstPatternMismatch(seed: number, start: number, chunk: Buffer): number {
  const expected = patternBytes(seed, start, chunk.length);
  if (expected.equals(chunk)) return -1;
  for (let index = 0; index < chunk.length; index += 1) {
    if (expected[index] !== chunk[index]) return index;
  }
  return -1;
}
