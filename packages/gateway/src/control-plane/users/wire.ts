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

// Raw shape carries `createdAt` so the admin list can sort/display creation
// time; the effective shape (for /auth/me + login) omits it because the
// dashboard doesn't render the actor's own creation date.
export const userToRawWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewGlobalTelemetry: user.canViewGlobalTelemetry,
  upstreamIds: user.upstreamIds,
  createdAt: user.createdAt,
});
