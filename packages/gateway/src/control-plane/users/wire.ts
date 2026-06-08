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

// Raw shape: capability flags round-trip exactly as persisted.
export const userToRawWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  upstreamIds: user.upstreamIds,
  canViewGlobalTelemetry: user.canViewGlobalTelemetry,
  createdAt: user.createdAt,
  deletedAt: user.deletedAt,
});
