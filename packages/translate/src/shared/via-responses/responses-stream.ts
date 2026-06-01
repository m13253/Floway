import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export type ResponsesEvent<TType extends ResponsesStreamEvent['type']> = Extract<ResponsesStreamEvent, { type: TType }>;

export const responsesPartKey = (outputIndex: number, partIndex: number): string => `${outputIndex}:${partIndex}`;
