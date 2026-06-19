<script setup lang="ts">

import CopilotDeviceFlow from './CopilotDeviceFlow.vue';
import CopilotInfo from './CopilotInfo.vue';
import type { CopilotQuotaSnapshot, UpstreamRecord } from '../../api/types.ts';

type CopilotUpstreamRecord = Extract<UpstreamRecord, { provider: 'copilot' }>;

defineProps<{
  record: CopilotUpstreamRecord | null;
  initialQuota?: CopilotQuotaSnapshot | null;
  initialQuotaError?: string | null;
  // Operator's current edit-form proxy_fallback_list. Forwarded into the
  // device-flow poll so the GitHub-side calls (poll, user lookup,
  // account-type detection) honor the in-progress chain.
  proxyFallbackList: string[];
}>();

defineEmits<{ completed: [upstream: UpstreamRecord | undefined] }>();
</script>

<template>
  <CopilotInfo
    v-if="record"
    :upstream-id="record.id"
    :config="record.config"
    :initial-quota="initialQuota"
    :initial-quota-error="initialQuotaError"
  />
  <CopilotDeviceFlow v-else :proxy-fallback-list="proxyFallbackList" @completed="u => $emit('completed', u)" />
</template>
