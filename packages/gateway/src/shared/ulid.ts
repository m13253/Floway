// Monotonic ULID generator per the Crockford base32 spec
// (https://github.com/ulid/spec). The 48-bit ms timestamp encodes into the
// first 10 characters; the remaining 16 characters carry 80 bits of
// randomness. Within the same millisecond we increment the random tail
// rather than re-rolling, so ids stay strictly increasing — that property
// is what lets the DumpStore use ULIDs as a lexicographic page cursor.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = 0;
const lastRand = new Uint8Array(RAND_LEN);

const encodeTime = (ms: number): string => {
  let chars = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    chars = ENCODING[ms % 32] + chars;
    ms = Math.floor(ms / 32);
  }
  return chars;
};

const encodeRand = (rand: Uint8Array): string => {
  let chars = '';
  for (let i = 0; i < RAND_LEN; i++) chars += ENCODING[rand[i]!];
  return chars;
};

// Treat `lastRand` as a base-32 big-endian counter and add 1. Overflow past
// the top digit is a once-in-2^80 event; if it happens we let it wrap.
const incrementRand = (): void => {
  for (let i = RAND_LEN - 1; i >= 0; i--) {
    if (lastRand[i]! < 31) { lastRand[i]!++; return; }
    lastRand[i] = 0;
  }
};

export const ulid = (now: number = Date.now()): string => {
  // Treat a backwards clock jump (NTP correction) as a same-millisecond
  // collision: keep lastTime and increment the random tail. Without this,
  // resetting lastTime to a smaller `now` would let the next id encode an
  // earlier timestamp than the previous, breaking the lexicographic ordering
  // the DumpStore relies on for page cursors.
  const ts = now > lastTime ? now : lastTime;
  if (ts === lastTime) {
    incrementRand();
  } else {
    lastTime = ts;
    const fresh = crypto.getRandomValues(new Uint8Array(RAND_LEN));
    for (let i = 0; i < RAND_LEN; i++) lastRand[i] = fresh[i]! & 31;
  }
  return encodeTime(ts) + encodeRand(lastRand);
};
