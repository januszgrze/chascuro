import { describe, expect, it } from 'vitest';

import {
  MAX_MSATS,
  addMsats,
  deserializeMsats,
  formatMsatsAsSats,
  msats,
  msatsToSatsExact,
  parseMsats,
  parsePositiveSats,
  parseSats,
  satsToMsats,
  serializeMsats,
  subtractMsats,
} from './money';

describe('money', () => {
  it('converts whole satoshis to branded millisatoshis', () => {
    expect(satsToMsats(21n)).toBe(21_000n);
    expect(parseSats(' 42 ')).toBe(42_000n);
  });

  it('rejects negative, fractional, and overflowing amounts', () => {
    expect(() => msats(-1n)).toThrow(RangeError);
    expect(() => parseSats('1.5')).toThrow(TypeError);
    expect(() => parseSats('-1')).toThrow(TypeError);
    expect(() => satsToMsats(MAX_MSATS / 1_000n + 1n)).toThrow(RangeError);
    expect(() => parseMsats((MAX_MSATS + 1n).toString())).toThrow(RangeError);
  });

  it('requires positive user-entered payment amounts', () => {
    expect(parsePositiveSats('1')).toBe(1_000n);
    expect(() => parsePositiveSats('0')).toThrow(RangeError);
  });

  it('serializes bigint amounts as canonical decimal strings', () => {
    const amount = msats(123_456n);

    expect(serializeMsats(amount)).toBe('123456');
    expect(deserializeMsats('123456')).toBe(amount);
    expect(() => deserializeMsats('00123456')).toThrow(TypeError);
    expect(() => deserializeMsats(' 123456 ')).toThrow(TypeError);
  });

  it('formats satoshis without dropping millisatoshi precision', () => {
    expect(formatMsatsAsSats(msats(0n))).toBe('0');
    expect(formatMsatsAsSats(msats(1_000n))).toBe('1');
    expect(formatMsatsAsSats(msats(1_001n))).toBe('1.001');
    expect(formatMsatsAsSats(msats(1_010n))).toBe('1.01');
    expect(formatMsatsAsSats(msats(1_100n))).toBe('1.1');
  });

  it('only converts to sats exactly when no remainder exists', () => {
    expect(msatsToSatsExact(msats(5_000n))).toBe(5n);
    expect(() => msatsToSatsExact(msats(5_001n))).toThrow(RangeError);
  });

  it('checks overflow and underflow during arithmetic', () => {
    expect(addMsats(msats(1n), msats(2n))).toBe(3n);
    expect(subtractMsats(msats(3n), msats(2n))).toBe(1n);
    expect(() => addMsats(msats(MAX_MSATS), msats(1n))).toThrow(RangeError);
    expect(() => subtractMsats(msats(1n), msats(2n))).toThrow(RangeError);
  });
});
