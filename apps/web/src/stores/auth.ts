import { useLocalStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed } from 'vue';

export interface AuthUser {
  id: number;
  username: string;
  isAdmin: boolean;
  canViewGlobalTelemetry: boolean;
  upstreamIds: string[] | null;
}

export interface AuthIdentity {
  token: string;
  user: AuthUser;
}

const STORAGE_KEY = 'floway-auth';

export const useAuthStore = defineStore('auth', () => {
  const identity = useLocalStorage<AuthIdentity | null>(STORAGE_KEY, null, {
    serializer: {
      read: raw => {
        if (!raw) return null;
        try {
          return JSON.parse(raw) as AuthIdentity;
        } catch {
          return null;
        }
      },
      write: value => value === null ? '' : JSON.stringify(value),
    },
  });

  const isAuthenticated = computed(() => identity.value !== null);
  const isAdmin = computed(() => identity.value?.user.isAdmin === true);
  const authToken = computed(() => identity.value?.token ?? null);
  const currentUser = computed(() => identity.value?.user ?? null);
  const canViewGlobalTelemetry = computed(() => identity.value?.user.canViewGlobalTelemetry === true);

  const setAuth = (next: AuthIdentity) => { identity.value = next; };
  const updateUser = (next: AuthUser) => {
    if (!identity.value) return;
    identity.value = { token: identity.value.token, user: next };
  };
  const clearAuth = () => { identity.value = null; };

  return {
    identity,
    isAuthenticated,
    isAdmin,
    authToken,
    currentUser,
    canViewGlobalTelemetry,
    setAuth,
    updateUser,
    clearAuth,
  };
});
