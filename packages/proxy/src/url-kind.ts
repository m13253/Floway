// Best-effort proxy-kind label derived from the URL scheme alone. Used by
// the dashboard's settings card to colour-code a row without dragging in
// the dial-time TLS stack that the full `parseProxyUri` pulls. The output
// is a short uppercase label, never null — callers render it directly.
//
// Pure function, no SocketDial / TLS dependencies. Adding a new protocol =
// add a parser branch in `url.ts` and a case here.

export const kindFromUri = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'PROXY';
  }
  switch (parsed.protocol) {
  case 'http:': return 'HTTP';
  case 'https:': return 'HTTPS';
  case 'socks5:': return 'SOCKS5';
  case 'ss:': {
    // ss2022 ciphers begin with `2022-blake3-`; the userinfo carries either
    // `method:password` (legacy SS) or the same with a 2022 cipher prefix.
    const userinfo = decodeURIComponent(parsed.username);
    return userinfo.startsWith('2022-blake3-') ? 'SS-2022' : 'SS';
  }
  case 'trojan:': return 'TROJAN';
  case 'vless:': {
    // REALITY uses `security=reality`; vless-over-WS uses `type=ws`. Anything
    // else falls back to the bare protocol label.
    const security = parsed.searchParams.get('security');
    const transport = parsed.searchParams.get('type');
    if (security === 'reality') return 'REALITY';
    if (transport === 'ws') return 'VLESS-WS';
    return 'VLESS';
  }
  default: return parsed.protocol.replace(/:$/, '').toUpperCase();
  }
};
