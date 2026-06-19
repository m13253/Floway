// Gemini's `:streamGenerateContent` returns one JSON object per frame, framed
// as `data: <json>\n\n` (SSE-shaped but without `event:` labels). This is the
// shared splitter used both by the dump capture path (to materialize each
// frame as a `DumpStreamEvent`) and by the dashboard collect side.

interface ParseGeminiStreamOptions {
  signal?: AbortSignal;
}

export const parseGeminiStream = async function* (
  body: ReadableStream<Uint8Array>,
  options: ParseGeminiStreamOptions = {},
): AsyncGenerator<{ chunk: string }> {
  const reader = body.getReader();
  const { signal } = options;
  const decoder = new TextDecoder();
  let buffer = '';
  let cancelPromise: Promise<void> | undefined;

  const cancelReader = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch(() => {});
    return cancelPromise;
  };

  const cancelReaderOnAbort = () => {
    void cancelReader(signal?.reason);
  };

  const extractChunk = (frame: string): string | null => {
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('data: ')) return line.slice(6);
    }
    return null;
  };

  if (signal?.aborted) {
    await cancelReader(signal.reason);
    return;
  }

  signal?.addEventListener('abort', cancelReaderOnAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const chunk = extractChunk(frame);
        if (chunk !== null) yield { chunk };
        boundary = buffer.indexOf('\n\n');
      }
    }

    if (buffer.length > 0) {
      const chunk = extractChunk(buffer);
      if (chunk !== null) yield { chunk };
    }
  } finally {
    signal?.removeEventListener('abort', cancelReaderOnAbort);
    await (cancelPromise ?? reader.cancel());
  }
};
