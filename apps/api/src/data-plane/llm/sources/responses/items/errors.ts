// Diagnostic errors describe two well-defined user-input failures of stored
// Responses item routing.
//
// `not_found` covers both "the id was never stored" and "the gateway holds
// metadata but cannot satisfy the requested `item_reference`". Pre-feature
// clients identify a missing reference by the exact message text below; we
// keep that wording verbatim so the contract is unchanged.
//
// `routing_unavailable` covers requests where stored items name upstreams that
// cannot be reached for the current model (forcing-affinity conflict, or the
// single forcing upstream isn't configured). A single error code is used for
// every variant and the diagnosis goes into `message`.
//
// Data corruption (a stored row whose `item_type` we no longer recognize) is
// NOT a diagnostic: it is an internal invariant break and propagates as a
// plain `Error` to the top-level catch, surfaced as a 5xx upstream error.

export type StoredResponsesItemsDiagnosticKind = 'not_found' | 'routing_unavailable';

export interface StoredResponsesItemsDiagnostic {
  kind: StoredResponsesItemsDiagnosticKind;
  status: number;
  message: string;
  body: {
    error: {
      message: string;
      type: 'invalid_request_error';
      param: string | null;
      code: string | null;
    };
  };
}

export class StoredResponsesItemsDiagnosticError extends Error {
  readonly diagnostic: StoredResponsesItemsDiagnostic;

  constructor(diagnostic: StoredResponsesItemsDiagnostic) {
    super(diagnostic.message);
    this.name = 'StoredResponsesItemsDiagnosticError';
    this.diagnostic = diagnostic;
  }
}

export const throwStoredResponsesItemsDiagnostic = (diagnostic: StoredResponsesItemsDiagnostic): never => {
  throw new StoredResponsesItemsDiagnosticError(diagnostic);
};

// Clients match this "not found" text verbatim against stock OpenAI Responses
// errors, so the message shape must stay byte-stable — do not reword it.
export const createStoredResponsesItemNotFoundDiagnostic = (itemId: string): StoredResponsesItemsDiagnostic =>
  diagnostic({
    kind: 'not_found',
    status: 404,
    message: `Item with id '${itemId}' not found.`,
    param: 'input',
    code: null,
  });

export const createStoredResponsesRoutingUnavailableDiagnostic = (message: string): StoredResponsesItemsDiagnostic =>
  diagnostic({
    kind: 'routing_unavailable',
    status: 400,
    message,
    param: 'input',
    code: 'responses_item_routing_unavailable',
  });

const diagnostic = (
  input: {
    kind: StoredResponsesItemsDiagnosticKind;
    status: number;
    message: string;
    param: string | null;
    code: string | null;
  },
): StoredResponsesItemsDiagnostic => ({
  kind: input.kind,
  status: input.status,
  message: input.message,
  body: {
    error: {
      message: input.message,
      type: 'invalid_request_error',
      param: input.param,
      code: input.code,
    },
  },
});
