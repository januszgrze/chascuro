import {
  ChatError,
  publicChatError,
  type ChatAvailability,
} from '../../domain';
import {
  EncryptedRecordCorruptError,
  EncryptedRecordStore,
  EncryptedRecordStoreNotFoundError,
  encryptedRecordKeyringStorageId,
} from '../persistence/encrypted-record-store';
import {
  CHAT_IDENTITY_SECRET_RECORD_ID,
  chatIdentitySecretRecordSchema,
} from '../persistence/schemas/chat-identity-secret-record';
import {
  CHAT_PRODUCT_STATE_RECORD_ID,
  chatProductStateRecordSchema,
} from '../persistence/schemas/chat-product-state-record';
import {
  CHAT_SESSION_RECORD_ID,
  chatSessionRecordSchema,
} from '../persistence/schemas/chat-session-record';
import { VaultUnlockError } from '../persistence/vault';
import type { VaultStore } from '../persistence/vault-store';
import type { ChatService } from './chat-service';

export const CHAT_RECORD_NAMESPACE = 'chascuro-chat-v1';

const DISABLED: ChatAvailability = Object.freeze({ status: 'disabled' });

export interface OpenChatSessionInput {
  readonly storage: VaultStore;
  readonly passphrase: string;
  readonly signal: AbortSignal;
}

export interface ChatSessionLifecycle {
  readonly getAvailability: () => ChatAvailability;
  openOrCreate(input: OpenChatSessionInput): Promise<ChatAvailability>;
  quiesce(): void;
  stop(): Promise<void>;
  lock(): void;
  dispose(): Promise<void>;
}

export type ChatLifecycleEvent =
  | 'open_started'
  | 'open_available'
  | 'open_setup_required'
  | 'open_degraded'
  | 'quiesced'
  | 'stopped'
  | 'locked'
  | 'disposed';

export interface ChatLifecycleLogger {
  event(event: ChatLifecycleEvent): void;
}

export interface EncryptedChatSessionLifecycleOptions {
  readonly service: ChatService;
  readonly crypto?: Crypto;
  readonly now?: () => number;
  readonly logger?: ChatLifecycleLogger;
  readonly vaultIterations?: number;
}

export class DisabledChatSessionLifecycle implements ChatSessionLifecycle {
  readonly getAvailability = (): ChatAvailability => DISABLED;
  async openOrCreate(): Promise<ChatAvailability> {
    return DISABLED;
  }
  quiesce(): void {}
  async stop(): Promise<void> {}
  lock(): void {}
  async dispose(): Promise<void> {}
}

export class EncryptedChatSessionLifecycle implements ChatSessionLifecycle {
  private readonly service: ChatService;
  private readonly crypto: Crypto;
  private readonly now: () => number;
  private readonly logger: ChatLifecycleLogger;
  private readonly vaultIterations: number | undefined;
  private records: EncryptedRecordStore | undefined;
  private availability: ChatAvailability = DISABLED;
  private generation = 0;
  private disposed = false;

  constructor(options: EncryptedChatSessionLifecycleOptions) {
    this.service = options.service;
    this.crypto = options.crypto ?? globalThis.crypto;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? { event: () => undefined };
    this.vaultIterations = options.vaultIterations;
  }

  readonly getAvailability = (): ChatAvailability => this.availability;

  async openOrCreate(input: OpenChatSessionInput): Promise<ChatAvailability> {
    if (this.disposed) return this.degraded('internal');
    const generation = ++this.generation;
    this.logger.event('open_started');
    let records: EncryptedRecordStore | undefined;
    let databaseKey: Uint8Array | undefined;
    let identitySecret: Uint8Array | undefined;
    try {
      input.signal.throwIfAborted();
      const keyring = await input.storage.get(
        encryptedRecordKeyringStorageId(CHAT_RECORD_NAMESPACE),
      );
      records =
        keyring === undefined
          ? await EncryptedRecordStore.create({
              storage: input.storage,
              passphrase: input.passphrase,
              namespace: CHAT_RECORD_NAMESPACE,
              crypto: this.crypto,
              now: this.now,
              vaultOptions: { iterations: this.vaultIterations },
            })
          : await EncryptedRecordStore.open({
              storage: input.storage,
              passphrase: input.passphrase,
              namespace: CHAT_RECORD_NAMESPACE,
              crypto: this.crypto,
              now: this.now,
            });
      let session = await records.get(
        chatSessionRecordSchema,
        CHAT_SESSION_RECORD_ID,
      );
      if (session === undefined) {
        const databaseKeyHex = randomHex(this.crypto, 32);
        session = await records.put(
          chatSessionRecordSchema,
          CHAT_SESSION_RECORD_ID,
          {
            formatVersion: 1,
            databaseKeyHex,
            createdAtMs: this.now(),
          },
        );
      }
      let identity = await records.get(
        chatIdentitySecretRecordSchema,
        CHAT_IDENTITY_SECRET_RECORD_ID,
      );
      if (identity === undefined) {
        identity = await records.put(
          chatIdentitySecretRecordSchema,
          CHAT_IDENTITY_SECRET_RECORD_ID,
          {
            formatVersion: 1,
            identitySecretHex: randomHex(this.crypto, 32),
            createdAtMs: this.now(),
          },
        );
      }
      databaseKey = hexToBytes(session.payload.databaseKeyHex);
      identitySecret = hexToBytes(identity.payload.identitySecretHex);
      const availability = await this.service.open({
        storageKey: databaseKey,
        identitySecret,
        stateStore: {
          load: async () =>
            (
              await records!.get(
                chatProductStateRecordSchema,
                CHAT_PRODUCT_STATE_RECORD_ID,
              )
            )?.payload,
          save: async (state) => {
            await records!.put(
              chatProductStateRecordSchema,
              CHAT_PRODUCT_STATE_RECORD_ID,
              state,
            );
          },
        },
        signal: input.signal,
      });
      if (
        generation !== this.generation ||
        this.disposed ||
        input.signal.aborted
      ) {
        this.service.quiesce();
        await this.service.stop().catch(() => undefined);
        this.service.lock();
        records.lock();
        return this.availability;
      }
      this.records?.lock();
      this.records = records;
      this.availability = availability;
      this.logger.event(
        availability.status === 'available'
          ? 'open_available'
          : availability.status === 'setup_required'
            ? 'open_setup_required'
            : 'open_degraded',
      );
      return availability;
    } catch (error) {
      records?.lock();
      this.service.quiesce();
      await this.service.stop().catch(() => undefined);
      this.service.lock();
      if (input.signal.aborted) return this.availability;
      return this.degraded(storageErrorCode(error));
    } finally {
      databaseKey?.fill(0);
      identitySecret?.fill(0);
    }
  }

  quiesce(): void {
    this.generation += 1;
    this.service.quiesce();
    this.logger.event('quiesced');
  }

  async stop(): Promise<void> {
    try {
      await this.service.stop();
    } catch {
      this.degraded('internal');
    } finally {
      this.logger.event('stopped');
    }
  }

  lock(): void {
    this.service.lock();
    this.records?.lock();
    this.records = undefined;
    this.availability = DISABLED;
    this.logger.event('locked');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.quiesce();
    await this.stop();
    this.lock();
    await this.service.dispose().catch(() => undefined);
    this.logger.event('disposed');
  }

  private degraded(
    reason: Extract<ChatAvailability, { status: 'degraded' }>['reason'],
  ): ChatAvailability {
    const publicError = publicChatError(reason);
    this.availability = Object.freeze({
      status: 'degraded',
      reason,
      retryable: publicError.retryable,
    });
    this.logger.event('open_degraded');
    return this.availability;
  }
}

function storageErrorCode(
  error: unknown,
): Extract<ChatAvailability, { status: 'degraded' }>['reason'] {
  if (
    error instanceof EncryptedRecordCorruptError ||
    error instanceof EncryptedRecordStoreNotFoundError ||
    error instanceof VaultUnlockError
  ) {
    return 'storage_corrupt';
  }
  if (error instanceof ChatError) return error.code;
  return 'storage_unavailable';
}

function randomHex(crypto: Crypto, byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  try {
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } finally {
    bytes.fill(0);
  }
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}
