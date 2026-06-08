<script setup lang="ts">
import { Button } from '@floway-dev/ui';

defineProps<{ username: string; roleLabel: string }>();
defineEmits<{ 'change-password': [] }>();
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in">
    <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">My Account</span>
    <div class="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p class="text-sm text-white">{{ username }}</p>
        <p class="text-xs text-gray-500">{{ roleLabel }}</p>
      </div>
      <Button variant="secondary" @click="$emit('change-password')">Change my password</Button>
    </div>
  </div>
</template>
