// Re-export stub: respond.ts has been relocated to the per-protocol
// `data-plane/llm/responses/` directory. The legacy `sources/responses/`
// traits and websocket modules still import from this path; remove the
// stub once those modules move alongside.
export * from '../../responses/respond.ts';
