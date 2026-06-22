// Single source of truth for everything per-provider the SPA renders:
// label, dropdown subtitle, accent tone, default name suggestion, and the
// inline SVG icon shown in the dropdown / badge. Anywhere the dashboard
// renders a provider chip, tile, or default name suggestion, it consumes
// this table — drift between sites is what motivated consolidating these
// duplicated literal maps in the first place.

import type { UpstreamProviderKind } from '../../api/types.ts';

export type ProviderTone = 'amber' | 'emerald' | 'cyan' | 'violet' | 'rose';

export interface ProviderMeta {
  kind: UpstreamProviderKind;
  label: string;
  subtitle: string;
  tone: ProviderTone;
  defaultName: string;
  // Inner SVG markup (just the `<path>` / `<circle>` children). Consumers
  // wrap it in their own `<svg>` so they can size it per call site.
  iconSvg: string;
}

export const PROVIDER_META: readonly ProviderMeta[] = [
  {
    kind: 'custom',
    label: 'Custom',
    subtitle: 'OpenAI-compatible bearer',
    tone: 'amber',
    defaultName: 'Custom upstream',
    iconSvg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />',
  },
  {
    kind: 'azure',
    label: 'Azure',
    subtitle: 'Azure OpenAI / Foundry',
    tone: 'emerald',
    defaultName: 'Azure AI',
    iconSvg: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />',
  },
  {
    kind: 'copilot',
    label: 'Copilot',
    subtitle: 'GitHub Copilot account',
    tone: 'cyan',
    defaultName: 'GitHub Copilot',
    iconSvg: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />',
  },
  {
    kind: 'codex',
    label: 'Codex',
    subtitle: 'ChatGPT Plus / Pro / Team',
    tone: 'violet',
    defaultName: 'ChatGPT Codex',
    iconSvg: '<path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />',
  },
  {
    kind: 'claude-code',
    label: 'Claude Code',
    subtitle: 'Claude Pro / Max / Team subscription',
    tone: 'rose',
    defaultName: 'Claude Code',
    iconSvg: '<path d="M9 18l6-6-6-6" /><path d="M4 21V3" />',
  },
  {
    kind: 'ollama',
    label: 'Ollama',
    subtitle: 'ollama.com or self-hosted',
    tone: 'rose',
    defaultName: 'Ollama',
    iconSvg: '<path d="M12 2c3.5 0 6 2.5 6 6 0 1.5-.5 3-1.5 4 1 1 1.5 2.5 1.5 4 0 3.5-2.5 6-6 6s-6-2.5-6-6c0-1.5.5-3 1.5-4-1-1-1.5-2.5-1.5-4 0-3.5 2.5-6 6-6z" /><circle cx="10" cy="10" r="0.5" fill="currentColor" /><circle cx="14" cy="10" r="0.5" fill="currentColor" />',
  },
];

export const providerMeta = (kind: UpstreamProviderKind): ProviderMeta => {
  const m = PROVIDER_META.find(p => p.kind === kind);
  if (!m) throw new Error(`Unknown UpstreamProviderKind: ${String(kind)}`);
  return m;
};

const TONE_BADGE_CLASS: Record<ProviderTone, string> = {
  amber: 'border-accent-amber/30 bg-accent-amber/10 text-accent-amber',
  emerald: 'border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald',
  cyan: 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan',
  violet: 'border-accent-violet/30 bg-accent-violet/10 text-accent-violet',
  rose: 'border-accent-rose/30 bg-accent-rose/10 text-accent-rose',
};

export const providerBadgeClass = (kind: UpstreamProviderKind): string =>
  TONE_BADGE_CLASS[providerMeta(kind).tone];

const TONE_SWATCH_CLASS: Record<ProviderTone, string> = {
  amber: 'bg-accent-amber/15 text-accent-amber',
  emerald: 'bg-accent-emerald/15 text-accent-emerald',
  cyan: 'bg-accent-cyan/15 text-accent-cyan',
  violet: 'bg-accent-violet/15 text-accent-violet',
  rose: 'bg-accent-rose/15 text-accent-rose',
};

export const providerSwatchClass = (kind: UpstreamProviderKind): string =>
  TONE_SWATCH_CLASS[providerMeta(kind).tone];
