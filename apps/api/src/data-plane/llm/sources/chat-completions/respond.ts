// Re-export stub: respond.ts has been relocated to the per-protocol
// `data-plane/llm/chat-completions/` directory. The legacy
// `sources/chat-completions/` traits module still imports from this path;
// remove the stub once those modules move alongside.
export * from '../../chat-completions/respond.ts';
