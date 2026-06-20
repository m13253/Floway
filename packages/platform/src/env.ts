export type EnvGetter = (name: string) => string;

let _getEnv: EnvGetter | null = null;

export const initEnv = (fn: EnvGetter): void => {
  _getEnv = fn;
};

export const getEnv = (name: string): string => {
  if (!_getEnv) throw new Error('Env not initialized — call initEnv() first');
  return _getEnv(name);
};

// Same lookup as `getEnv`, but with a fallback for variables the operator is
// allowed to leave unset. The underlying EnvGetter throws on "missing" — this
// helper translates that throw into the supplied default so callers don't
// reinvent `process.env[name] ?? default` outside the env contract.
export const getEnvOptional = (name: string, defaultValue: string): string => {
  if (!_getEnv) throw new Error('Env not initialized — call initEnv() first');
  try {
    return _getEnv(name);
  } catch {
    return defaultValue;
  }
};
