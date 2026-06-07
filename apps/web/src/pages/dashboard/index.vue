<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';

// `/dashboard` resolves to the Settings tab — the My Account panel there is
// visible to every identity, and admin-only sections light up for admins.
const router = useRouter();

onMounted(() => {
  void router.replace('/dashboard/settings');
});
</script>

<template>
  <div class="grid place-items-center py-12 text-sm text-gray-500">Redirecting…</div>
</template>
