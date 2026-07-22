import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const CHAT_IDENTITY_SECRET_RECORD_ID = 'identity-secret';
export const CHAT_IDENTITY_SECRET_RECORD_KIND = 'chat-identity-secret';

export interface ChatIdentitySecretRecord {
  readonly formatVersion: 1;
  readonly identitySecretHex: string;
  readonly createdAtMs: number;
}

export const chatIdentitySecretRecordSchema: EncryptedRecordSchema<ChatIdentitySecretRecord> =
  Object.freeze({
    kind: CHAT_IDENTITY_SECRET_RECORD_KIND,
    version: 1,
    parse(value: unknown): ChatIdentitySecretRecord {
      if (!isRecord(value))
        throw new TypeError('Invalid chat identity secret.');
      const keys = Object.keys(value).sort();
      if (
        keys.length !== 3 ||
        keys[0] !== 'createdAtMs' ||
        keys[1] !== 'formatVersion' ||
        keys[2] !== 'identitySecretHex' ||
        value.formatVersion !== 1 ||
        typeof value.identitySecretHex !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(value.identitySecretHex) ||
        typeof value.createdAtMs !== 'number' ||
        !Number.isSafeInteger(value.createdAtMs) ||
        value.createdAtMs < 0
      ) {
        throw new TypeError('Invalid chat identity secret.');
      }
      return Object.freeze({
        formatVersion: 1,
        identitySecretHex: value.identitySecretHex,
        createdAtMs: value.createdAtMs,
      });
    },
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
