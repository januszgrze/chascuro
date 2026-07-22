import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const CHAT_SESSION_RECORD_ID = 'session';
export const CHAT_SESSION_RECORD_KIND = 'chat-session';

export interface ChatSessionRecord {
  readonly formatVersion: 1;
  readonly databaseKeyHex: string;
  readonly createdAtMs: number;
}

export const chatSessionRecordSchema: EncryptedRecordSchema<ChatSessionRecord> =
  Object.freeze({
    kind: CHAT_SESSION_RECORD_KIND,
    version: 1,
    parse(value: unknown): ChatSessionRecord {
      if (!isRecord(value)) throw new TypeError('Invalid chat session record.');
      const keys = Object.keys(value).sort();
      if (
        keys.length !== 3 ||
        keys[0] !== 'createdAtMs' ||
        keys[1] !== 'databaseKeyHex' ||
        keys[2] !== 'formatVersion' ||
        value.formatVersion !== 1 ||
        typeof value.databaseKeyHex !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(value.databaseKeyHex) ||
        typeof value.createdAtMs !== 'number' ||
        !Number.isSafeInteger(value.createdAtMs) ||
        value.createdAtMs < 0
      ) {
        throw new TypeError('Invalid chat session record.');
      }
      return Object.freeze({
        formatVersion: 1,
        databaseKeyHex: value.databaseKeyHex,
        createdAtMs: value.createdAtMs,
      });
    },
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
