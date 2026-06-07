import type { Context } from 'hono';

export const generateSessionToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

export const extractSessionToken = (c: Context): string | null =>
  c.req.header('x-floway-session') ?? null;
