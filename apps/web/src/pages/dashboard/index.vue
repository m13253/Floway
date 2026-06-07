<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();

onMounted(() => {
  void router.replace('/dashboard/settings');
});
</script>

<template>
  <div class="grid place-items-center py-12 text-sm text-gray-500">Redirecting…</div>
</template>
