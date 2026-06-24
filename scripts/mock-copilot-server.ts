// Mock Copilot upstream for testing Floway's Fast Mode plumbing end-to-end
// without an account that actually has fast-model permission.
//
// What it does:
//   * Listens on `127.0.0.1:18800` (override with PORT env var).
//   * Serves the three Copilot endpoints the Floway provider hits:
//       GET  /copilot_internal/v2/token   — returns a fake token + redirects
//                                            the data plane back at this
//                                            mock via `endpoints.api`.
//       GET  /models                      — returns a catalog with the
//                                            `claude-opus-4.6 / .6-fast /
//                                            .7 / claude-haiku-4.5` shape
//                                            real Copilot would surface.
//       POST /v1/messages                 — returns a minimal Messages SSE
//                                            stream regardless of body
//                                            (the gateway is the side that
//                                            knows about fast-mode stamping).
//
// How to use:
//
//   1. Start the mock:
//        pnpm run mock:copilot
//      (which runs `jiti scripts/mock-copilot-server.ts`).
//
//   2. Patch ONE line in `packages/provider-copilot/src/auth.ts` so the
//      token exchange goes to this server instead of api.github.com:
//
//        - const resp = await fetcher('https://api.github.com/copilot_internal/v2/token', {
//        + const resp = await fetcher('http://127.0.0.1:18800/copilot_internal/v2/token', {
//
//      The patch is local-only; revert with
//        git checkout packages/provider-copilot/src/auth.ts
//      after smoke-testing.
//
//   3. Start the Node-mode gateway in a separate terminal:
//        pnpm run dev:node
//
//   4. Create a Copilot upstream via the dashboard at http://localhost:5174.
//      Any string works for the GitHub token field — the mock accepts
//      everything. Once saved, the gateway will mint a fake Copilot token
//      from this mock on first use and cache it.
//
//   5. Exercise the gateway with curl (replace KEY with an api key you
//      issued from the dashboard):
//
//        curl -N http://localhost:8788/v1/messages \
//          -H "x-api-key: $KEY" \
//          -H "anthropic-version: 2023-06-01" \
//          -H "content-type: application/json" \
//          -d '{
//            "model": "claude-opus-4-6",
//            "max_tokens": 32,
//            "speed": "fast",
//            "messages": [{"role": "user", "content": "hi"}]
//          }'
//
//      Expected: a streaming Messages response with
//      `usage.speed: "fast"` stamped onto message_start and
//      message_delta. Without `speed: "fast"` the same call should
//      come back without the field. With `speed: "fast"` on
//      `claude-haiku-4-5` you should see a 400 invalid_request_error
//      before the mock is ever hit.

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 18800);
const HOST = process.env.HOST ?? '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

const FAKE_TOKEN = 'mock-copilot-token';

const TOKEN_PAYLOAD = {
  token: FAKE_TOKEN,
  // 2030-01-01 — far enough out that no test session expires it.
  expires_at: 1893456000,
  refresh_in: 1800,
  endpoints: { api: BASE_URL },
};

const MODELS_PAYLOAD = {
  object: 'list',
  data: [
    {
      id: 'claude-opus-4.6',
      name: 'Claude Opus 4.6',
      display_name: 'Claude Opus 4.6',
      version: '1',
      supported_endpoints: ['/v1/messages'],
      capabilities: {
        type: 'chat',
        limits: {
          max_context_window_tokens: 200_000,
          max_prompt_tokens: 168_000,
          max_output_tokens: 32_000,
        },
      },
    },
    {
      id: 'claude-opus-4.6-fast',
      name: 'Claude Opus 4.6 (fast)',
      display_name: 'Claude Opus 4.6 (fast)',
      version: '1',
      supported_endpoints: ['/v1/messages'],
      capabilities: {
        type: 'chat',
        limits: {
          max_context_window_tokens: 200_000,
          max_prompt_tokens: 168_000,
          max_output_tokens: 16_000,
        },
      },
    },
    {
      id: 'claude-opus-4.7',
      name: 'Claude Opus 4.7',
      display_name: 'Claude Opus 4.7',
      version: '1',
      supported_endpoints: ['/v1/messages'],
      capabilities: {
        type: 'chat',
        limits: {
          max_context_window_tokens: 200_000,
          max_prompt_tokens: 168_000,
          max_output_tokens: 32_000,
        },
      },
    },
    {
      id: 'claude-haiku-4.5',
      name: 'Claude Haiku 4.5',
      display_name: 'Claude Haiku 4.5',
      version: '1',
      supported_endpoints: ['/v1/messages'],
      capabilities: {
        type: 'chat',
        limits: {
          max_context_window_tokens: 200_000,
          max_prompt_tokens: 168_000,
          max_output_tokens: 16_000,
        },
      },
    },
  ],
};

const sseLine = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const buildMessagesStream = (model: string): string => {
  const messageId = `msg_mock_${Date.now().toString(36)}`;
  // Two greetings: the fast variant says so explicitly so a manual tester
  // can eyeball which raw model the gateway selected. The mock never
  // sends `usage.speed` itself — that's what the gateway is supposed to
  // stamp on the way out.
  const isFast = model.endsWith('-fast');
  const greeting = isFast ? 'hello from the -fast variant' : 'hello from the base variant';

  return (
    sseLine('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    })
    + sseLine('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
    + sseLine('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: greeting },
    })
    + sseLine('content_block_stop', { type: 'content_block_stop', index: 0 })
    + sseLine('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: greeting.length },
    })
    + sseLine('message_stop', { type: 'message_stop' })
    + 'data: [DONE]\n\n'
  );
};

const readJsonBody = (req: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE_URL);
  const stamp = new Date().toISOString();

  if (req.method === 'GET' && url.pathname === '/copilot_internal/v2/token') {
    console.log(`[${stamp}] token-exchange → minting ${FAKE_TOKEN}, endpoints.api=${BASE_URL}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(TOKEN_PAYLOAD));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/models') {
    console.log(`[${stamp}] /models → returning ${MODELS_PAYLOAD.data.length} entries`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(MODELS_PAYLOAD));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    let body: { model?: string; speed?: string } | null = null;
    try {
      body = (await readJsonBody(req)) as { model?: string; speed?: string } | null;
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `bad json: ${(err as Error).message}` } }));
      return;
    }
    const requestedModel = body?.model ?? '<missing>';
    // Surface a server-side check that the gateway's strip actually worked.
    // If `speed` is still on the wire here, the boundary chain regressed.
    const speedOnWire = body?.speed ?? null;
    console.log(`[${stamp}] /v1/messages → model=${requestedModel} speed-on-wire=${JSON.stringify(speedOnWire)}`);

    if (speedOnWire !== null) {
      console.warn(`  ⚠️  speed field reached the mock — withSpeedFast did not strip it.`);
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(buildMessagesStream(requestedModel));
    return;
  }

  console.log(`[${stamp}] ${req.method} ${url.pathname} → 404`);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    error: 'not_found',
    hint: 'mock supports GET /copilot_internal/v2/token, GET /models, POST /v1/messages',
  }));
});

server.listen(PORT, HOST, () => {
  console.log(`Mock Copilot upstream listening at ${BASE_URL}`);
  console.log('Patch packages/provider-copilot/src/auth.ts:');
  console.log(`  s|https://api.github.com/copilot_internal/v2/token|${BASE_URL}/copilot_internal/v2/token|`);
  console.log('Then start the gateway with `pnpm run dev:node` and create a Copilot upstream via the admin API.');
});
