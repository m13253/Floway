// Buffered "read exactly N bytes" helper for byte-framed consumers on a
// Web Streams reader. Shadowsocks AEAD-2018 and Shadowsocks-2022 both
// walk fixed-size handshake records off a transport reader and need the
// same loop: pull until N bytes are buffered, hand N to the caller, keep
// the rest for the next call. Lives here so any byte-framed consumer on
// a `ReadableStreamDefaultReader<Uint8Array>` can reuse it.

export const makeExactReader = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  label: string,
): ((n: number) => Promise<Uint8Array<ArrayBuffer>>) => {
  let leftover: Uint8Array | undefined;
  return async (n: number): Promise<Uint8Array<ArrayBuffer>> => {
    const out = new Uint8Array(n);
    let got = 0;
    if (leftover?.byteLength) {
      const take = Math.min(n, leftover.byteLength);
      out.set(leftover.subarray(0, take), 0);
      got += take;
      leftover = take < leftover.byteLength ? leftover.subarray(take) : undefined;
    }
    while (got < n) {
      const r = await reader.read();
      if (r.done) throw new Error(`${label}: EOF, want ${n} got ${got}`);
      const need = n - got;
      if (r.value.byteLength <= need) {
        out.set(r.value, got);
        got += r.value.byteLength;
      } else {
        out.set(r.value.subarray(0, need), got);
        leftover = r.value.subarray(need);
        got += need;
      }
    }
    return out;
  };
};
