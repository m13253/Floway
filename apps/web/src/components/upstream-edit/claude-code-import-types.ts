// Shared types for the Claude Code import UI. ClaudeCodeConfigPanel
// orchestrates the PKCE + credentials.json paste flow and
// ClaudeCodeImportTabs renders the two-tab paste area; both consume the
// same upstream PKCE response shape and the same tab discriminator,
// hoisted here so the parent and child cannot drift.

export interface ClaudeCodePkceStartResult {
  authorize_url: string;
  expires_in_seconds: number;
}

export type ClaudeCodeImportTab = 'credentials_json' | 'callback';
