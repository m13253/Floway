import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

export const traverseTranslation = async <SP, TP, SE, TE>(
  payload: SP,
  translate: (p: SP) => { target: TP; events: (e: AsyncIterable<ProtocolFrame<TE>>) => AsyncIterable<ProtocolFrame<SE>> },
  innerAttempt: (translated: TP) => Promise<ExecuteResult<ProtocolFrame<TE>>>,
): Promise<ExecuteResult<ProtocolFrame<SE>>> => {
  const trip = translate(payload)
  const inner = await innerAttempt(trip.target)
  if (inner.type !== 'events') return inner
  return { ...inner, events: trip.events(inner.events) }
}
