// Re-export stub: respond.ts has been relocated to the per-protocol
// `data-plane/llm/gemini/` directory. The legacy `sources/gemini/`
// traits module still imports from this path; remove the stub once those
// modules move alongside.
export * from '../../gemini/respond.ts';
