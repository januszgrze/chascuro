declare const msatsBrand: unique symbol;

/**
 * A non-negative millisatoshi amount.
 *
 * The brand prevents an arbitrary bigint from being passed to APIs that expect
 * a validated wallet amount. Persist this value with serializeMsats rather than
 * JSON.stringify, which does not support bigint values.
 */
export type Msats = bigint & { readonly [msatsBrand]: 'Msats' };

export const MSATS_PER_SAT = 1_000n;
export const MAX_MSATS = (1n << 64n) - 1n;

const UNSIGNED_INTEGER = /^[0-9]+$/;
const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;

function assertMsatsRange(value: bigint): void {
  if (value < 0n) {
    throw new RangeError('Amount must not be negative.');
  }

  if (value > MAX_MSATS) {
    throw new RangeError('Amount exceeds the supported range.');
  }
}

function parseUnsignedInteger(value: string): bigint {
  const normalized = value.trim();

  if (!UNSIGNED_INTEGER.test(normalized)) {
    throw new TypeError('Amount must be a whole, non-negative integer.');
  }

  return BigInt(normalized);
}

export function msats(value: bigint): Msats {
  assertMsatsRange(value);
  return value as Msats;
}

export function satsToMsats(value: bigint): Msats {
  if (value < 0n) {
    throw new RangeError('Amount must not be negative.');
  }

  if (value > MAX_MSATS / MSATS_PER_SAT) {
    throw new RangeError('Amount exceeds the supported range.');
  }

  return msats(value * MSATS_PER_SAT);
}

/**
 * Parses a user-entered, whole-satoshi amount. Fractional sats are rejected so
 * callers must make any sub-satoshi behavior explicit.
 */
export function parseSats(value: string): Msats {
  return satsToMsats(parseUnsignedInteger(value));
}

/**
 * Parses a user-entered payment amount and rejects zero. Balance and fee
 * helpers continue to use the non-negative `Msats` domain because zero is
 * meaningful for those values.
 */
export function parsePositiveSats(value: string): Msats {
  const amount = parseSats(value);
  if (amount === 0n) {
    throw new RangeError('Payment amount must be greater than zero.');
  }
  return amount;
}

export function parseMsats(value: string): Msats {
  return msats(parseUnsignedInteger(value));
}

export function serializeMsats(value: Msats): string {
  return value.toString(10);
}

/**
 * Reads the canonical decimal-string representation used in persisted data.
 * Non-canonical forms such as leading zeroes are rejected.
 */
export function deserializeMsats(value: string): Msats {
  if (!CANONICAL_UNSIGNED_INTEGER.test(value)) {
    throw new TypeError('Stored amount is not a canonical integer.');
  }

  return msats(BigInt(value));
}

export function msatsToSatsExact(value: Msats): bigint {
  if (value % MSATS_PER_SAT !== 0n) {
    throw new RangeError('Amount contains fractional satoshis.');
  }

  return value / MSATS_PER_SAT;
}

/**
 * Formats millisatoshis as a base-10 satoshi value without locale-dependent
 * separators and without discarding sub-satoshi precision.
 */
export function formatMsatsAsSats(value: Msats): string {
  const wholeSats = value / MSATS_PER_SAT;
  const remainder = value % MSATS_PER_SAT;

  if (remainder === 0n) {
    return wholeSats.toString(10);
  }

  const fractionalSats = remainder
    .toString(10)
    .padStart(3, '0')
    .replace(/0+$/, '');

  return `${wholeSats.toString(10)}.${fractionalSats}`;
}

export function addMsats(left: Msats, right: Msats): Msats {
  return msats(left + right);
}

export function subtractMsats(left: Msats, right: Msats): Msats {
  if (right > left) {
    throw new RangeError('Amount subtraction would be negative.');
  }

  return msats(left - right);
}
