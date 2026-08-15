// uuid-v7.ts -- time-ordered identifiers, RFC 9562 section 5.7. Depends on: nothing.

/**
 * UUIDv7 puts a millisecond timestamp in the high bits, so identifiers generated over
 * time land next to each other in a B-tree instead of scattering across it the way v4
 * does. That matters because these ids are primary keys.
 *
 * Generated here rather than by the database's uuidv7() so that the clock and the random
 * source can be replaced in tests, and so a whole transaction can be built in memory
 * before anything is written.
 *
 * Layout: 48 bits unix_ts_ms | 4 bits version | 12 bits rand_a | 2 bits variant | 62 bits rand_b.
 */
export function createUuidV7(
  now: () => number = Date.now,
  randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
): () => string {
  return () => {
    const bytes = new Uint8Array(16);
    bytes.set(randomBytes(16));

    const timestamp = BigInt(now());
    bytes[0] = Number((timestamp >> 40n) & 0xffn);
    bytes[1] = Number((timestamp >> 32n) & 0xffn);
    bytes[2] = Number((timestamp >> 24n) & 0xffn);
    bytes[3] = Number((timestamp >> 16n) & 0xffn);
    bytes[4] = Number((timestamp >> 8n) & 0xffn);
    bytes[5] = Number(timestamp & 0xffn);

    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  };
}

function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}
