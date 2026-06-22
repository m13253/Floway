// Shared types for the Claude Code import UI. ClaudeCodeConfigPanel
// orchestrates the three import flows (PKCE OAuth, PKCE Setup-Token,
// credentials.json paste) and ClaudeCodeImportTabs renders the tab strip;
// both consume the same authorize-url response shape and the same tab
// discriminator, hoisted here so the parent and child cannot drift.

export interface ClaudeCodeAuthorizeUrlResult {
  authorize_url: string;
}

export type ClaudeCodeImportTab = 'credentials_json' | 'callback' | 'setup_token_callback';
