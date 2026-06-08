import { describe, expect, it } from 'vitest';

import { defaultsFor, formKindOf, isValidPort, isValidUuid, switchKind } from './proxy-form-defaults.ts';
import { formatProxyUri, parseProxyUri } from '@floway-dev/proxy/url';

describe('formKindOf', () => {
  it('splits http into http and https by tls flag', () => {
    expect(formKindOf({ kind: 'http', tls: false, host: 'h', port: 1, name: 'h:1' })).toBe('http');
    expect(formKindOf({ kind: 'http', tls: true, host: 'h', port: 1, name: 'h:1' })).toBe('https');
  });

  it('passes other kinds through verbatim', () => {
    expect(formKindOf({ kind: 'socks5', host: 'h', port: 1, name: 'h:1' })).toBe('socks5');
    expect(formKindOf({ kind: 'vless-ws', host: 'h', port: 1, name: 'h:1', uuid: 'u', path: '/' })).toBe('vless-ws');
  });
});

describe('defaultsFor', () => {
  const ctx = { host: 'srv', port: 0, name: 'srv:0' };

  it('seeds shadowsocks with an aead method', () => {
    const c = defaultsFor('ss', ctx);
    expect(c.kind).toBe('ss');
    expect(c).toMatchObject({ method: 'aes-256-gcm', password: '' });
  });

  it('seeds reality with empty required fields the operator must supply', () => {
    const c = defaultsFor('reality', ctx);
    expect(c).toMatchObject({ kind: 'reality', uuid: '', publicKey: '', serverName: '' });
  });

  it('chooses canonical default ports per kind when current is 0', () => {
    expect(defaultsFor('http', ctx).port).toBe(8080);
    expect(defaultsFor('https', ctx).port).toBe(443);
    expect(defaultsFor('socks5', ctx).port).toBe(1080);
    expect(defaultsFor('ss', ctx).port).toBe(8388);
    expect(defaultsFor('reality', ctx).port).toBe(443);
  });

  it('keeps the existing port when one was already typed', () => {
    expect(defaultsFor('http', { ...ctx, port: 31280 }).port).toBe(31280);
  });
});

describe('switchKind', () => {
  it('preserves host, port, name across the swap and resets kind-specific fields', () => {
    const before = parseProxyUri('vless://aaaa-uuid@h:443?type=tcp&security=tls&sni=h#mine');
    const after = switchKind(before, 'trojan');
    expect(after).toEqual({
      kind: 'trojan',
      host: 'h',
      port: 443,
      name: 'mine',
      password: '',
    });
  });
});

describe('round-trip through formatProxyUri', () => {
  it('a freshly seeded HTTP config formats and parses back without loss', () => {
    const c = defaultsFor('http', { host: 'p.example.com', port: 0, name: 'p.example.com:8080' });
    const uri = formatProxyUri(c);
    expect(parseProxyUri(uri)).toEqual(c);
  });

  it('a freshly seeded VLESS-WS config formats and parses back without loss', () => {
    const c = defaultsFor('vless-ws', { host: 'h', port: 443, name: 'h:443' });
    // Insert a UUID so VLESS dialing-time validation would accept it; the
    // URL grammar itself does not reject empty UUIDs, but we want a realistic
    // round-trip.
    const filled = { ...c, uuid: '00000000-0000-0000-0000-000000000000' };
    const uri = formatProxyUri(filled);
    expect(parseProxyUri(uri)).toEqual(filled);
  });
});

describe('isValidUuid', () => {
  it('accepts canonical hyphenated and unhyphenated forms', () => {
    expect(isValidUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isValidUuid('00000000000000000000000000000000')).toBe(true);
  });

  it('rejects wrong length and non-hex chars', () => {
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('zzzzzzzz-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('isValidPort', () => {
  it('accepts integers in [1, 65535]', () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(443)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it('rejects 0, negatives, fractions, and overflow', () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(443.5)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
  });
});
