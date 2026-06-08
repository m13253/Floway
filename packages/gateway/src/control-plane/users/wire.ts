import type { User } from '../../repo/types.ts';

// Effective shape exposed to the dashboard via /auth/me and login: admin
// implies canViewGlobalTelemetry, so callers see one composite capability
// instead of having to OR the flags themselves.
export const userToEffectiveWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewGlobalTelemetry: user.isAdmin || user.canViewGlobalTelemetry,
  upstreamIds: user.upstreamIds,
});

// Raw shape exposed via /api/users for the admin editor: the two capability
// flags round-trip exactly as persisted so the admin can toggle them
// independently.
export const userToRawWire = (u: User) => ({
  id: u.id,
  username: u.username,
  isAdmin: u.isAdmin,
  upstreamIds: u.upstreamIds,
  canViewGlobalTelemetry: u.canViewGlobalTelemetry,
  createdAt: u.createdAt,
  deletedAt: u.deletedAt,
});
