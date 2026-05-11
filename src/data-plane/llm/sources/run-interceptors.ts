import type { StreamExecuteResult } from "../shared/errors/result.ts";

export type SourceRun<TEvent> = () => Promise<StreamExecuteResult<TEvent>>;

export type SourceInterceptor<TContext, TEvent> = (
  ctx: TContext,
  run: SourceRun<TEvent>,
) => Promise<StreamExecuteResult<TEvent>>;

export const runSourceInterceptors = async <TContext, TEvent>(
  ctx: TContext,
  interceptors: readonly SourceInterceptor<TContext, TEvent>[],
  attempt: SourceRun<TEvent>,
): Promise<StreamExecuteResult<TEvent>> => {
  const run = (index: number): Promise<StreamExecuteResult<TEvent>> =>
    index < interceptors.length
      ? interceptors[index](ctx, () => run(index + 1))
      : attempt();

  return await run(0);
};
