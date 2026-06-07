<script setup lang="ts">
import { OverlayScrollbars, Switch } from '@floway-dev/ui';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

interface WireUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
  canViewGlobalTelemetry: boolean;
  createdAt: string;
  deletedAt: string | null;
}

defineProps<{
  users: WireUser[];
  actorUserId: number;
}>();

defineEmits<{
  'toggle-admin': [user: WireUser];
  'toggle-global-telemetry': [user: WireUser];
  'reset-password': [user: WireUser];
  remove: [user: WireUser];
}>();

const shortDate = (s: string | null | undefined) => s ? dayjs(s).format('MMM D, YYYY') : '';
const fullDateTime = (s: string | null | undefined) => s ? dayjs(s).format('YYYY-MM-DD HH:mm:ss') : '';

const isProtected = (id: number, actor: number) => id === 1 || id === actor;
</script>

<template>
  <OverlayScrollbars>
    <p v-if="users.length === 0" class="text-sm text-gray-500 py-4 text-center">
      No users yet.
    </p>

    <table v-else class="w-full min-w-[760px] text-sm">
      <thead>
        <tr class="border-b border-white/5">
          <th class="text-left py-2 pr-4 pl-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Username</th>
          <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Admin</th>
          <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Global telemetry</th>
          <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Created</th>
          <th class="text-right py-2 pr-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="u in users"
          :key="u.id"
          class="border-b border-white/[0.03]"
        >
          <td class="py-3 pr-4 pl-2">
            <div class="flex items-center gap-2">
              <span class="text-white font-medium truncate">{{ u.username }}</span>
              <span v-if="u.id === 1" class="text-[10px] uppercase tracking-widest text-gray-500">seed</span>
            </div>
          </td>
          <td class="py-3 pr-4">
            <Switch
              :model-value="u.isAdmin"
              :disabled="isProtected(u.id, actorUserId)"
              @update:model-value="$emit('toggle-admin', u)"
            />
          </td>
          <td class="py-3 pr-4">
            <Switch
              :model-value="u.canViewGlobalTelemetry || u.isAdmin"
              :disabled="u.isAdmin"
              @update:model-value="$emit('toggle-global-telemetry', u)"
            />
          </td>
          <td class="py-3 pr-4">
            <span class="text-gray-500 text-xs cursor-default" :title="fullDateTime(u.createdAt)">{{ shortDate(u.createdAt) }}</span>
          </td>
          <td class="py-3 pr-2 text-right">
            <div class="flex items-center justify-end gap-1">
              <button
                class="inline-flex min-h-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors px-2 text-xs"
                title="Reset password"
                @click.stop="$emit('reset-password', u)"
              >
                Reset password
              </button>
              <button
                class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-rose hover:bg-white/[0.04] transition-colors p-1"
                :class="isProtected(u.id, actorUserId) ? 'opacity-30 cursor-not-allowed' : ''"
                :disabled="isProtected(u.id, actorUserId)"
                title="Delete user"
                aria-label="Delete user"
                @click.stop="$emit('remove', u)"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </OverlayScrollbars>
</template>
