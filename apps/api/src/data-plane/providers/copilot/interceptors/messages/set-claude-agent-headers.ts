import { parseUserIdMetadata } from './detect-claude-code-metadata.ts';
import { CLAUDE_AGENT_USER_AGENT } from '../../../../../shared/copilot.ts';
import type { MessagesInterceptor } from '../../../../llm/interceptors.ts';

/**
 * When Anthropic Messages traffic comes from the Claude Code SDK proxy, VSCode
 * Copilot Chat re-tags the native Messages upstream call with a different
 * intent + user-agent and drops the `copilot-integration-id` it would otherwise
 * pin to `vscode-chat`. We mirror that tagging only when the planner selected
 * a native Messages target and both halves of the Claude Code
 * `metadata.user_id` fingerprint are present.
 *
 * Detection requires BOTH safetyIdentifier AND sessionId so we never apply
 * the messages-proxy intent to ordinary chat traffic that happens to share
 * one half of the legacy regex.
 *
 * Sentinel: an empty-string value tells `copilotFetch` to delete the named
 * base header — see the loop comment in shared/copilot.ts. We use it to clear
 * `copilot-integration-id` because VSCode Copilot Chat omits that header on
 * Claude Code SDK proxy traffic.
 *
 * Do not put this identity on translated Chat Completions / Responses targets.
 * The real VS Code path forces a Messages API request, and caozhiyuan's gateway
 * applies the same helper only in its `/v1/messages` Copilot caller. Copilot's
 * Chat endpoint treats the full messages-proxy + Claude Code UA + no-integration
 * shape as `integrator: claude-code`, which can hide non-Claude Chat models.
 *
 * References:
 * - https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts#L479-L516
 * - https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/services/copilot/create-messages.ts#L110-L116
 * - https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/services/copilot/create-chat-completions.ts#L45-L61
 */
export const withClaudeAgentHeadersSet: MessagesInterceptor = async (ctx, _request, run) => {
  if (ctx.targetApi !== 'messages') {
    return await run();
  }

  const { safetyIdentifier, sessionId } = parseUserIdMetadata(ctx.payload.metadata?.user_id);
  if (safetyIdentifier && sessionId) {
    ctx.headers['x-interaction-type'] = 'messages-proxy';
    ctx.headers['openai-intent'] = 'messages-proxy';
    ctx.headers['user-agent'] = CLAUDE_AGENT_USER_AGENT;
    ctx.headers['copilot-integration-id'] = '';
  }
  return await run();
};
