import { isCopilotAccountType, type CopilotAccountType } from '@floway-dev/provider-copilot';

export interface CopilotUpstreamUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

export interface CopilotUpstreamConfig {
  githubToken: string;
  accountType: CopilotAccountType;
  user: CopilotUpstreamUser;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type FieldErrorBuilder = (field: string, expected: string) => Error;

export const stringField = (value: unknown, field: string, err: FieldErrorBuilder): string => {
  if (typeof value !== 'string') throw err(field, 'a string');
  return value;
};

export const nonEmptyStringField = (value: unknown, field: string, err: FieldErrorBuilder): string => {
  const str = stringField(value, field, err).trim();
  if (str === '') throw err(field, 'a non-empty string');
  return str;
};

export const nullableStringField = (value: unknown, field: string, err: FieldErrorBuilder): string | null => {
  if (value !== null && typeof value !== 'string') throw err(field, 'a string or null');
  return value;
};

export const integerField = (value: unknown, field: string, err: FieldErrorBuilder): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw err(field, 'an integer');
  return value;
};

export const copilotUserField = (value: unknown, err: FieldErrorBuilder): CopilotUpstreamUser => {
  if (!isRecord(value)) throw err('user', 'an object');
  return {
    login: stringField(value.login, 'user.login', err),
    avatar_url: stringField(value.avatar_url, 'user.avatar_url', err),
    name: nullableStringField(value.name, 'user.name', err),
    id: integerField(value.id, 'user.id', err),
  };
};

export const copilotConfigField = (value: unknown, err: FieldErrorBuilder): CopilotUpstreamConfig => {
  if (!isRecord(value)) throw err('config', 'an object');
  if (!isCopilotAccountType(value.accountType)) {
    throw err('config.accountType', 'one of individual, business, enterprise');
  }
  return {
    githubToken: nonEmptyStringField(value.githubToken, 'githubToken', err),
    accountType: value.accountType,
    user: copilotUserField(value.user, err),
  };
};
