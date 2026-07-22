import {
  createVault,
  unlockVault,
  type VaultEnvelope,
  type VaultOptions,
  type VaultSession,
} from './vault';
import type { VaultStore } from './vault-store';

const RECORD_FORMAT_VERSION = 2 as const;
const KEYRING_KIND = 'encrypted-record-store-keyring' as const;
const KEYRING_SECRET_BYTES = 32;
const DEFAULT_NAMESPACE = 'primary-wallet';
const DEFAULT_RECORD_KDF_ITERATIONS = 1;

interface RecordStoreKeyring {
  readonly formatVersion: typeof RECORD_FORMAT_VERSION;
  readonly kind: typeof KEYRING_KIND;
  readonly recordSecret: string;
  readonly createdAtMs: number;
}

interface StoredRecordPayload {
  readonly formatVersion: typeof RECORD_FORMAT_VERSION;
  readonly kind: string;
  readonly id: string;
  readonly schemaVersion: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly payload: unknown;
}

export interface EncryptedRecordSchema<T> {
  readonly kind: string;
  readonly version: number;
  parse(value: unknown): T;
}

export interface EncryptedRecord<T> {
  readonly kind: string;
  readonly id: string;
  readonly schemaVersion: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly payload: T;
}

interface RecordStoreOptions {
  readonly namespace?: string;
  readonly crypto?: Crypto;
  readonly now?: () => number;
  /**
   * The record secret is 256 bits of cryptographic randomness, not a
   * user-chosen password, so record-level PBKDF2 is only being used as the
   * existing vault's key-import boundary. User passphrases retain the vault's
   * normal high iteration count on the keyring envelope.
   */
  readonly recordKdfIterations?: number;
}

export interface CreateEncryptedRecordStoreOptions extends RecordStoreOptions {
  readonly storage: VaultStore;
  readonly passphrase: string;
  readonly vaultOptions?: Pick<VaultOptions, 'iterations'>;
}

export interface OpenEncryptedRecordStoreOptions extends RecordStoreOptions {
  readonly storage: VaultStore;
  readonly passphrase: string;
}

export class EncryptedRecordStoreAlreadyExistsError extends Error {
  constructor() {
    super('Encrypted record store already exists.');
    this.name = 'EncryptedRecordStoreAlreadyExistsError';
  }
}

export class EncryptedRecordStoreNotFoundError extends Error {
  constructor() {
    super('Encrypted record store does not exist.');
    this.name = 'EncryptedRecordStoreNotFoundError';
  }
}

export class EncryptedRecordStoreLockedError extends Error {
  constructor() {
    super('Encrypted record store is locked.');
    this.name = 'EncryptedRecordStoreLockedError';
  }
}

export class EncryptedRecordCorruptError extends Error {
  constructor(options: ErrorOptions = {}) {
    super('Encrypted record is invalid or corrupt.', options);
    this.name = 'EncryptedRecordCorruptError';
  }
}

export class EncryptedRecordWriteError extends Error {
  readonly rollbackFailed: boolean;

  constructor(rollbackFailed: boolean, options: ErrorOptions = {}) {
    super(
      rollbackFailed
        ? 'Encrypted record write failed and could not be rolled back.'
        : 'Encrypted record write could not be verified.',
      options,
    );
    this.name = 'EncryptedRecordWriteError';
    this.rollbackFailed = rollbackFailed;
  }
}

export class EncryptedRecordStore {
  private locked = false;

  private constructor(
    private readonly storage: VaultStore,
    private readonly namespace: string,
    private readonly keyringSession: VaultSession<RecordStoreKeyring>,
    private readonly crypto: Crypto | undefined,
    private readonly now: () => number,
    private readonly recordKdfIterations: number,
  ) {}

  static async create(
    options: CreateEncryptedRecordStoreOptions,
  ): Promise<EncryptedRecordStore> {
    const namespace = validateIdentifier(
      options.namespace ?? DEFAULT_NAMESPACE,
      'namespace',
    );
    const keyringStorageId = encryptedRecordKeyringStorageId(namespace);
    const recordKdfIterations = readPositiveSafeInteger(
      options.recordKdfIterations ?? DEFAULT_RECORD_KDF_ITERATIONS,
      'record KDF iteration count',
    );

    if ((await options.storage.get(keyringStorageId)) !== undefined) {
      throw new EncryptedRecordStoreAlreadyExistsError();
    }

    const now = options.now ?? Date.now;
    const createdAtMs = readTimestamp(now);
    const crypto = requireCrypto(options.crypto);
    const keyring = freezeJson({
      formatVersion: RECORD_FORMAT_VERSION,
      kind: KEYRING_KIND,
      recordSecret: createRecordSecret(crypto),
      createdAtMs,
    }) as RecordStoreKeyring;
    const created = await createVault(
      keyringStorageId,
      options.passphrase,
      keyring,
      {
        crypto,
        iterations: options.vaultOptions?.iterations,
      },
    );

    try {
      await replaceAndVerify(
        options.storage,
        keyringStorageId,
        undefined,
        created.envelope,
        async (storedEnvelope) => {
          const verifiedSession = await unlockVault<RecordStoreKeyring>(
            keyringStorageId,
            options.passphrase,
            storedEnvelope,
            { crypto },
          );
          try {
            const verified = parseKeyring(verifiedSession.read());
            if (!jsonEqual(verified, keyring)) {
              throw new TypeError('Keyring verification mismatch.');
            }
          } finally {
            verifiedSession.lock();
          }
        },
      );
    } catch (error) {
      created.session.lock();
      throw error;
    }

    return new EncryptedRecordStore(
      options.storage,
      namespace,
      created.session,
      crypto,
      now,
      recordKdfIterations,
    );
  }

  static async open(
    options: OpenEncryptedRecordStoreOptions,
  ): Promise<EncryptedRecordStore> {
    const namespace = validateIdentifier(
      options.namespace ?? DEFAULT_NAMESPACE,
      'namespace',
    );
    const keyringStorageId = encryptedRecordKeyringStorageId(namespace);
    const recordKdfIterations = readPositiveSafeInteger(
      options.recordKdfIterations ?? DEFAULT_RECORD_KDF_ITERATIONS,
      'record KDF iteration count',
    );
    const envelope = await options.storage.get(keyringStorageId);
    if (envelope === undefined) {
      throw new EncryptedRecordStoreNotFoundError();
    }

    const session = await unlockVault<RecordStoreKeyring>(
      keyringStorageId,
      options.passphrase,
      envelope,
      { crypto: options.crypto },
    );

    try {
      parseKeyring(session.read());
    } catch (error) {
      session.lock();
      throw new EncryptedRecordCorruptError({ cause: error });
    }

    return new EncryptedRecordStore(
      options.storage,
      namespace,
      session,
      options.crypto,
      options.now ?? Date.now,
      recordKdfIterations,
    );
  }

  get isLocked(): boolean {
    return this.locked;
  }

  storageId(kind: string, id: string): string {
    return encryptedRecordStorageId(this.namespace, kind, id);
  }

  async get<T>(
    schema: EncryptedRecordSchema<T>,
    id: string,
  ): Promise<EncryptedRecord<T> | undefined> {
    this.assertUnlocked();
    validateSchema(schema);
    const validatedId = validateIdentifier(id, 'record ID');
    const storageId = this.storageId(schema.kind, validatedId);
    const envelope = await this.storage.get(storageId);
    if (envelope === undefined) {
      return undefined;
    }

    return this.decryptRecord(schema, validatedId, storageId, envelope);
  }

  async put<T>(
    schema: EncryptedRecordSchema<T>,
    id: string,
    value: unknown,
  ): Promise<EncryptedRecord<T>> {
    this.assertUnlocked();
    validateSchema(schema);
    const validatedId = validateIdentifier(id, 'record ID');
    const parsedPayload = freezeParsedPayload(schema, value);
    const storageId = this.storageId(schema.kind, validatedId);
    const previousEnvelope = await this.storage.get(storageId);
    const previousRecord =
      previousEnvelope === undefined
        ? undefined
        : await this.decryptRecord(
            schema,
            validatedId,
            storageId,
            previousEnvelope,
          );
    const nowMs = readTimestamp(this.now);
    const createdAtMs = previousRecord?.createdAtMs ?? nowMs;
    const updatedAtMs = Math.max(
      nowMs,
      createdAtMs,
      previousRecord?.updatedAtMs ?? 0,
    );
    const storedRecord = freezeJson({
      formatVersion: RECORD_FORMAT_VERSION,
      kind: schema.kind,
      id: validatedId,
      schemaVersion: schema.version,
      createdAtMs,
      updatedAtMs,
      payload: parsedPayload,
    }) as StoredRecordPayload;
    const recordSecret = this.readRecordSecret();
    const created = await createVault(storageId, recordSecret, storedRecord, {
      crypto: this.crypto,
      iterations: this.recordKdfIterations,
    });
    created.session.lock();

    await replaceAndVerify(
      this.storage,
      storageId,
      previousEnvelope,
      created.envelope,
      async (storedEnvelope) => {
        const verified = await this.decryptRecord(
          schema,
          validatedId,
          storageId,
          storedEnvelope,
        );
        if (!jsonEqual(toStoredRecordPayload(verified), storedRecord)) {
          throw new TypeError('Record verification mismatch.');
        }
      },
    );

    return toPublicRecord(schema, storedRecord);
  }

  async delete<T>(
    schema: EncryptedRecordSchema<T>,
    id: string,
  ): Promise<boolean> {
    this.assertUnlocked();
    validateSchema(schema);
    const validatedId = validateIdentifier(id, 'record ID');
    const storageId = this.storageId(schema.kind, validatedId);
    const previousEnvelope = await this.storage.get(storageId);
    if (previousEnvelope === undefined) {
      return false;
    }

    await this.decryptRecord(schema, validatedId, storageId, previousEnvelope);
    await this.storage.delete(storageId);
    if ((await this.storage.get(storageId)) !== undefined) {
      throw new EncryptedRecordWriteError(false);
    }
    return true;
  }

  lock(): void {
    if (!this.locked) {
      this.locked = true;
      this.keyringSession.lock();
    }
  }

  private async decryptRecord<T>(
    schema: EncryptedRecordSchema<T>,
    id: string,
    storageId: string,
    envelope: VaultEnvelope,
  ): Promise<EncryptedRecord<T>> {
    const recordSecret = this.readRecordSecret();
    let session: VaultSession<unknown> | undefined;

    try {
      session = await unlockVault<unknown>(storageId, recordSecret, envelope, {
        crypto: this.crypto,
      });
      const storedRecord = parseStoredRecord(schema, id, session.read());
      return toPublicRecord(schema, storedRecord);
    } catch (error) {
      if (error instanceof EncryptedRecordStoreLockedError) {
        throw error;
      }
      throw new EncryptedRecordCorruptError({ cause: error });
    } finally {
      session?.lock();
    }
  }

  private readRecordSecret(): string {
    this.assertUnlocked();
    try {
      return parseKeyring(this.keyringSession.read()).recordSecret;
    } catch {
      throw new EncryptedRecordStoreLockedError();
    }
  }

  private assertUnlocked(): void {
    if (this.locked) {
      throw new EncryptedRecordStoreLockedError();
    }
  }
}

export function encryptedRecordKeyringStorageId(
  namespace = DEFAULT_NAMESPACE,
): string {
  return `v2:${encodeURIComponent(
    validateIdentifier(namespace, 'namespace'),
  )}:keyring`;
}

export function encryptedRecordStorageId(
  namespace: string,
  kind: string,
  id: string,
): string {
  return `v2:${encodeURIComponent(
    validateIdentifier(namespace, 'namespace'),
  )}:record:${encodeURIComponent(
    validateIdentifier(kind, 'record kind'),
  )}:${encodeURIComponent(validateIdentifier(id, 'record ID'))}`;
}

async function replaceAndVerify(
  storage: VaultStore,
  storageId: string,
  previousEnvelope: Awaited<ReturnType<VaultStore['get']>>,
  nextEnvelope: NonNullable<Awaited<ReturnType<VaultStore['get']>>>,
  verify: (
    storedEnvelope: NonNullable<Awaited<ReturnType<VaultStore['get']>>>,
  ) => Promise<void>,
): Promise<void> {
  let writeCompleted = false;

  try {
    await storage.put(storageId, nextEnvelope);
    writeCompleted = true;
    const storedEnvelope = await storage.get(storageId);
    if (
      storedEnvelope === undefined ||
      !jsonEqual(storedEnvelope, nextEnvelope)
    ) {
      throw new TypeError('Stored envelope verification mismatch.');
    }
    await verify(storedEnvelope);
  } catch (error) {
    if (!writeCompleted) {
      throw error;
    }

    let rollbackFailed = false;
    try {
      if (previousEnvelope === undefined) {
        await storage.delete(storageId);
      } else {
        await storage.put(storageId, previousEnvelope);
      }
      const rolledBack = await storage.get(storageId);
      if (!jsonEqual(rolledBack, previousEnvelope)) {
        rollbackFailed = true;
      }
    } catch {
      rollbackFailed = true;
    }

    throw new EncryptedRecordWriteError(rollbackFailed, { cause: error });
  }
}

function parseKeyring(value: unknown): RecordStoreKeyring {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'formatVersion',
      'kind',
      'recordSecret',
      'createdAtMs',
    ]) ||
    value.formatVersion !== RECORD_FORMAT_VERSION ||
    value.kind !== KEYRING_KIND ||
    typeof value.recordSecret !== 'string' ||
    !isCanonicalBase64Bytes(value.recordSecret, KEYRING_SECRET_BYTES) ||
    !isTimestamp(value.createdAtMs)
  ) {
    throw new TypeError('Unsupported encrypted record keyring.');
  }

  return freezeJson({
    formatVersion: RECORD_FORMAT_VERSION,
    kind: KEYRING_KIND,
    recordSecret: value.recordSecret,
    createdAtMs: value.createdAtMs,
  }) as RecordStoreKeyring;
}

function parseStoredRecord<T>(
  schema: EncryptedRecordSchema<T>,
  id: string,
  value: unknown,
): StoredRecordPayload {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'formatVersion',
      'kind',
      'id',
      'schemaVersion',
      'createdAtMs',
      'updatedAtMs',
      'payload',
    ]) ||
    value.formatVersion !== RECORD_FORMAT_VERSION ||
    value.kind !== schema.kind ||
    value.id !== id ||
    value.schemaVersion !== schema.version ||
    !isTimestamp(value.createdAtMs) ||
    !isTimestamp(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs
  ) {
    throw new TypeError('Unsupported encrypted record.');
  }

  return freezeJson({
    formatVersion: RECORD_FORMAT_VERSION,
    kind: schema.kind,
    id,
    schemaVersion: schema.version,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
    payload: freezeParsedPayload(schema, value.payload),
  }) as StoredRecordPayload;
}

function toPublicRecord<T>(
  schema: EncryptedRecordSchema<T>,
  value: StoredRecordPayload,
): EncryptedRecord<T> {
  return Object.freeze({
    kind: value.kind,
    id: value.id,
    schemaVersion: value.schemaVersion,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
    payload: freezeParsedPayload(schema, value.payload),
  });
}

function toStoredRecordPayload<T>(
  value: EncryptedRecord<T>,
): StoredRecordPayload {
  return {
    formatVersion: RECORD_FORMAT_VERSION,
    kind: value.kind,
    id: value.id,
    schemaVersion: value.schemaVersion,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
    payload: value.payload,
  };
}

function freezeParsedPayload<T>(
  schema: EncryptedRecordSchema<T>,
  value: unknown,
): T {
  const parsed = schema.parse(structuredClone(value));
  assertJsonValue(parsed);
  return freezeJson(structuredClone(parsed)) as T;
}

function validateSchema<T>(schema: EncryptedRecordSchema<T>): void {
  validateIdentifier(schema.kind, 'record kind');
  readPositiveSafeInteger(schema.version, 'schema version');
  if (typeof schema.parse !== 'function') {
    throw new TypeError('Record schema parser is required.');
  }
}

function createRecordSecret(crypto: Crypto): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEYRING_SECRET_BYTES));
  return toBase64(bytes);
}

function requireCrypto(candidate: Crypto | undefined): Crypto {
  const crypto = candidate ?? globalThis.crypto;
  if (crypto?.subtle === undefined) {
    throw new Error('Web Crypto is unavailable.');
  }
  return crypto;
}

function readTimestamp(now: () => number): number {
  const value = now();
  if (!isTimestamp(value)) {
    throw new RangeError('Clock returned an invalid timestamp.');
  }
  return value;
}

function readPositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Invalid ${label}.`);
  }
  return value;
}

function validateIdentifier(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function assertJsonValue(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError('Record payload must contain canonical JSON values.');
    }
    return;
  }

  if (typeof value !== 'object') {
    throw new TypeError('Record payload must be JSON-safe.');
  }

  if (seen.has(value)) {
    throw new TypeError('Record payload must not contain cycles.');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      assertJsonValue(entry, seen);
    }
  } else {
    if (!isPlainRecord(value)) {
      throw new TypeError('Record payload must contain plain objects.');
    }
    for (const entry of Object.values(value)) {
      assertJsonValue(entry, seen);
    }
  }

  seen.delete(value);
}

function freezeJson<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) {
    freezeJson(entry);
  }
  return Object.freeze(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}

function isCanonicalBase64Bytes(value: string, expectedBytes: number): boolean {
  try {
    const binary = atob(value);
    if (binary.length !== expectedBytes) {
      return false;
    }
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return toBase64(bytes) === value;
  } catch {
    return false;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
