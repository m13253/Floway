export type StoredResponsesItemsDiagnosticKind =
  | 'not_found'
  | 'affinity_conflict'
  | 'unsupported_stored_item_type'
  | 'unsatisfied_forcing_affinity'
  | 'unsupported_item_reference';

export interface StoredResponsesItemsDiagnostic {
  kind: StoredResponsesItemsDiagnosticKind;
  status: number;
  message: string;
  type: 'invalid_request_error' | 'internal_error';
  param: string | null;
  code: string | null;
  itemIds?: readonly string[];
  upstreamIds?: readonly string[];
  body: {
    error: {
      message: string;
      type: 'invalid_request_error' | 'internal_error';
      param: string | null;
      code: string | null;
    };
  };
}

export const throwStoredResponsesItemsDiagnostic = (diagnostic: StoredResponsesItemsDiagnostic): never => {
  throw new Error(diagnostic.message);
};

export const createStoredResponsesItemNotFoundDiagnostic = (itemId: string): StoredResponsesItemsDiagnostic =>
  diagnostic({
    kind: 'not_found',
    status: 404,
    message: `Item with id '${itemId}' not found.`,
    type: 'invalid_request_error',
    param: 'input',
    code: null,
    itemIds: [itemId],
  });

export const createStoredResponsesAffinityConflictDiagnostic = (upstreamIds: readonly string[]): StoredResponsesItemsDiagnostic =>
  diagnostic({
    kind: 'affinity_conflict',
    status: 400,
    message: 'Stored Responses items in this request refer to incompatible upstreams.',
    type: 'invalid_request_error',
    param: 'input',
    code: 'responses_item_affinity_conflict',
    upstreamIds,
  });

export const createUnsupportedStoredResponsesItemTypeDiagnostic = (itemType: string, itemId: string): StoredResponsesItemsDiagnostic =>
  diagnostic({
    kind: 'unsupported_stored_item_type',
    status: 500,
    message: `Stored Responses item '${itemId}' has unsupported item type '${itemType}'.`,
    type: 'internal_error',
    param: null,
    code: 'unsupported_stored_responses_item_type',
    itemIds: [itemId],
  });

export const createUnsatisfiedStoredResponsesForcingAffinityDiagnostic = (upstreamId: string): StoredResponsesItemsDiagnostic =>
  diagnostic({
    kind: 'unsatisfied_forcing_affinity',
    status: 400,
    message: 'Stored Responses items in this request require an upstream that is not available for the selected model.',
    type: 'invalid_request_error',
    param: 'input',
    code: 'responses_item_forcing_affinity_unavailable',
    upstreamIds: [upstreamId],
  });

export const createUnsupportedStoredResponsesItemReferenceDiagnostic = (upstreamId: string): StoredResponsesItemsDiagnostic =>
  diagnostic({
    kind: 'unsupported_item_reference',
    status: 400,
    message: 'Stored Responses item_reference requires an upstream that supports Responses item references.',
    type: 'invalid_request_error',
    param: 'input',
    code: 'responses_item_reference_unsupported',
    upstreamIds: [upstreamId],
  });

const diagnostic = (
  input: Omit<StoredResponsesItemsDiagnostic, 'body'>,
): StoredResponsesItemsDiagnostic => ({
  ...input,
  body: {
    error: {
      message: input.message,
      type: input.type,
      param: input.param,
      code: input.code,
    },
  },
});
