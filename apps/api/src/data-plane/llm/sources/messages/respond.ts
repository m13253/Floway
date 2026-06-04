// Re-export stub: respond.ts has been relocated to the per-protocol
// `data-plane/llm/messages/` directory. The legacy `sources/messages/`
// traits module still imports from this path; remove the stub once those
// modules move alongside.
export * from '../../messages/respond.ts';
