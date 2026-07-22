import { describe, expect, it } from 'vitest';

import {
  WALLET_ERROR_CODES,
  WalletError,
  isWalletErrorCode,
  publicWalletError,
  toPublicWalletError,
} from './wallet-error';

describe('public wallet errors', () => {
  it('defines a safe public value for every allowlisted code', () => {
    for (const code of WALLET_ERROR_CODES) {
      const error = publicWalletError(code);

      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(typeof error.retryable).toBe('boolean');
      expect(Object.isFrozen(error)).toBe(true);
    }
  });

  it('recognizes only allowlisted error codes', () => {
    expect(isWalletErrorCode('offline')).toBe(true);
    expect(isWalletErrorCode('raw_sdk_failure')).toBe(false);
    expect(isWalletErrorCode(undefined)).toBe(false);
  });

  it('drops arbitrary messages when normalizing boundary errors', () => {
    const secret = 'sensitive-invite-code';
    const normalized = toPublicWalletError({
      code: 'federation_unavailable',
      message: secret,
      stack: secret,
    });

    expect(normalized.code).toBe('federation_unavailable');
    expect(JSON.stringify(normalized)).not.toContain(secret);
  });

  it('maps unknown errors to a non-retryable generic error', () => {
    const secret = 'raw SDK error containing secret material';
    const normalized = toPublicWalletError(new Error(secret));

    expect(normalized).toEqual(publicWalletError('unknown'));
    expect(normalized.message).not.toContain(secret);
  });

  it('serializes WalletError using only its public taxonomy', () => {
    const error = new WalletError('invalid_invite_code');

    expect(error.code).toBe('invalid_invite_code');
    expect(JSON.parse(JSON.stringify(error))).toEqual(
      publicWalletError('invalid_invite_code'),
    );
  });
});
