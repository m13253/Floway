import type { User } from '../../repo/types.ts';

// Effective shape: admin implies canViewGlobalTelemetry, so callers see one
// composite capability instead of having to OR the flags themselves.
export const userToEffectiveWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewGlobalTelemetry: user.isAdmin || user.canViewGlobalTelemetry,
  upstreamIds: user.upstreamIds,
});

// Raw shape (admin list): includes createdAt for sort/display; the effective
// shape omits it.
export const userToRawWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewGlobalTelemetry: user.canViewGlobalTelemetry,
  upstreamIds: user.upstreamIds,
  createdAt: user.createdAt,
});
