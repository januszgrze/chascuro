import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';

import { parseBolt11Binding } from './lnurl';

const DESCRIPTION_HASH_TAG = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.indexOf('h');

function bindingInvoice(
  prefix: string,
  descriptionHash = Uint8Array.from({ length: 32 }, (_, index) => index),
  duplicateHash = false,
): string {
  const hashWords = bech32.toWords(descriptionHash);
  const field = [DESCRIPTION_HASH_TAG, 1, 20, ...hashWords];
  return bech32.encode(
    prefix,
    [
      ...Array<number>(7).fill(0),
      ...field,
      ...(duplicateHash ? field : []),
      ...Array<number>(104).fill(0),
    ],
    false,
  );
}

describe('BOLT11 LNURL binding parser', () => {
  it('extracts exact millisatoshi amounts and the description hash', () => {
    const hash = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const binding = parseBolt11Binding(bindingInvoice('lntb10n', hash));

    expect(binding?.amountMsats).toBe(1_000n);
    expect(binding?.descriptionHash).toEqual(hash);
    expect(parseBolt11Binding(bindingInvoice('lnbc10p'))?.amountMsats).toBe(1n);
  });

  it('supports amountless invoices but rejects malformed binding fields', () => {
    expect(parseBolt11Binding(bindingInvoice('lntb'))?.amountMsats).toBe(
      undefined,
    );
    expect(parseBolt11Binding(bindingInvoice('lntb10n', undefined, true))).toBe(
      undefined,
    );
    expect(
      parseBolt11Binding(`${bindingInvoice('lntb10n').slice(0, -1)}q`),
    ).toBe(undefined);
  });

  it('rejects sub-millisatoshi and unsupported-network amounts', () => {
    expect(parseBolt11Binding(bindingInvoice('lntb1p'))).toBe(undefined);
    expect(parseBolt11Binding(bindingInvoice('lnzz10n'))).toBe(undefined);
  });
});
