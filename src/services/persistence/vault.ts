const ENVELOPE_VERSION = 1 as const;
const DEFAULT_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface VaultEnvelope {
  version: typeof ENVELOPE_VERSION;
  kdf: {
    name: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    salt: string;
  };
  cipher: {
    name: 'AES-GCM';
    iv: string;
  };
  ciphertext: string;
}

export interface VaultOptions {
  iterations?: number;
  crypto?: Crypto;
}

export interface CreatedVault<T> {
  envelope: VaultEnvelope;
  session: VaultSession<T>;
}

export class VaultUnlockError extends Error {
  constructor() {
    super('Unable to unlock wallet.');
    this.name = 'VaultUnlockError';
  }
}

export class VaultSession<T> {
  private key: CryptoKey | undefined;
  private currentValue: T | undefined;

  constructor(
    key: CryptoKey,
    value: T,
    private readonly recordId: string,
    private readonly salt: Uint8Array,
    private readonly iterations: number,
    private readonly crypto: Crypto,
  ) {
    this.key = key;
    this.currentValue = value;
  }

  read(): T {
    if (this.key === undefined || this.currentValue === undefined) {
      throw new Error('Vault session is locked.');
    }

    return structuredClone(this.currentValue);
  }

  async seal(value: T): Promise<VaultEnvelope> {
    if (this.key === undefined) {
      throw new Error('Vault session is locked.');
    }

    const envelope = await encryptWithKey(
      this.crypto,
      this.key,
      this.recordId,
      this.salt,
      this.iterations,
      value,
    );
    this.currentValue = structuredClone(value);
    return envelope;
  }

  lock(): void {
    this.key = undefined;
    this.currentValue = undefined;
  }
}

export async function createVault<T>(
  recordId: string,
  passphrase: string,
  value: T,
  options: VaultOptions = {},
): Promise<CreatedVault<T>> {
  const crypto = requireCrypto(options.crypto);
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  validateInputs(recordId, passphrase, iterations);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(crypto, passphrase, salt, iterations);
  const envelope = await encryptWithKey(
    crypto,
    key,
    recordId,
    salt,
    iterations,
    value,
  );

  return {
    envelope,
    session: new VaultSession(
      key,
      structuredClone(value),
      recordId,
      salt,
      iterations,
      crypto,
    ),
  };
}

export async function unlockVault<T>(
  recordId: string,
  passphrase: string,
  envelope: VaultEnvelope,
  options: Pick<VaultOptions, 'crypto'> = {},
): Promise<VaultSession<T>> {
  const crypto = requireCrypto(options.crypto);

  try {
    validateInputs(recordId, passphrase, envelope.kdf.iterations);
    validateEnvelope(envelope);

    const salt = fromBase64(envelope.kdf.salt);
    const iv = fromBase64(envelope.cipher.iv);
    const ciphertext = fromBase64(envelope.ciphertext);
    const key = await deriveKey(
      crypto,
      passphrase,
      salt,
      envelope.kdf.iterations,
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ownedBuffer(iv),
        additionalData: ownedBuffer(additionalData(recordId)),
      },
      key,
      ownedBuffer(ciphertext),
    );
    const value = JSON.parse(new TextDecoder().decode(plaintext)) as T;

    return new VaultSession(
      key,
      value,
      recordId,
      salt,
      envelope.kdf.iterations,
      crypto,
    );
  } catch {
    throw new VaultUnlockError();
  }
}

async function encryptWithKey<T>(
  crypto: Crypto,
  key: CryptoKey,
  recordId: string,
  salt: Uint8Array,
  iterations: number,
  value: T,
): Promise<VaultEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ownedBuffer(iv),
      additionalData: ownedBuffer(additionalData(recordId)),
    },
    key,
    ownedBuffer(plaintext),
  );

  return {
    version: ENVELOPE_VERSION,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt: toBase64(salt),
    },
    cipher: {
      name: 'AES-GCM',
      iv: toBase64(iv),
    },
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

async function deriveKey(
  crypto: Crypto,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    ownedBuffer(new TextEncoder().encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: ownedBuffer(salt),
      iterations,
    },
    material,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt'],
  );
}

function additionalData(recordId: string): Uint8Array {
  return new TextEncoder().encode(
    `fedimint-wallet:v${ENVELOPE_VERSION}:${recordId}`,
  );
}

function validateEnvelope(envelope: VaultEnvelope): void {
  if (
    envelope.version !== ENVELOPE_VERSION ||
    envelope.kdf.name !== 'PBKDF2' ||
    envelope.kdf.hash !== 'SHA-256' ||
    envelope.cipher.name !== 'AES-GCM'
  ) {
    throw new Error('Unsupported vault envelope.');
  }
}

function validateInputs(
  recordId: string,
  passphrase: string,
  iterations: number,
): void {
  if (recordId.length === 0 || passphrase.length === 0) {
    throw new Error('Vault inputs are required.');
  }

  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error('Invalid KDF iteration count.');
  }
}

function requireCrypto(candidate: Crypto | undefined): Crypto {
  const crypto = candidate ?? globalThis.crypto;

  if (crypto?.subtle === undefined) {
    throw new Error('Web Crypto is unavailable.');
  }

  return crypto;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
