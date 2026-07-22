import { bech32 } from '@scure/base';

import type { Msats } from './money';
import type { LightningInvoicePreview, LightningQuote } from './payments';

declare const lnurlPayOfferIdBrand: unique symbol;

export type LnurlPayOfferId = string & {
  readonly [lnurlPayOfferIdBrand]: 'LnurlPayOfferId';
};

export interface LnurlPayOffer {
  readonly offerId: LnurlPayOfferId;
  readonly destination: string;
  readonly domain: string;
  readonly description: string;
  readonly minSendableMsats: Msats;
  readonly maxSendableMsats: Msats;
  readonly fixedAmountMsats?: Msats;
  readonly expiresAtMs: number;
}

export type LnurlSuccessAction =
  | {
      readonly tag: 'message';
      readonly message: string;
    }
  | {
      readonly tag: 'url';
      readonly description: string;
      readonly url: string;
    };

export interface LnurlPaymentReview {
  readonly preview: LightningInvoicePreview;
  readonly quote: LightningQuote;
  readonly offer: LnurlPayOffer;
  readonly successAction?: LnurlSuccessAction;
}

export interface Bolt11Binding {
  readonly amountMsats?: Msats;
  readonly descriptionHash: Uint8Array;
}

const BOLT11_SIGNATURE_WORDS = 104;
const BOLT11_TIMESTAMP_WORDS = 7;
const BOLT11_DESCRIPTION_HASH_WORDS = 52;
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const DESCRIPTION_HASH_TAG = BECH32_CHARSET.indexOf('h');

export function lnurlPayOfferId(value: string): LnurlPayOfferId {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError('LNURL-pay offer ID is invalid.');
  }
  return value as LnurlPayOfferId;
}

/**
 * Extracts only the BOLT11 fields needed to bind an LNURL-pay callback to the
 * user's approved amount and the service's exact metadata. The wallet adapter
 * remains responsible for full invoice and signature validation.
 */
export function parseBolt11Binding(invoice: string): Bolt11Binding | undefined {
  try {
    const decoded = bech32.decode(invoice, false);
    const amountMsats = parseBolt11Amount(decoded.prefix);
    const taggedFieldsEnd = decoded.words.length - BOLT11_SIGNATURE_WORDS;
    if (taggedFieldsEnd < BOLT11_TIMESTAMP_WORDS) {
      return undefined;
    }

    let cursor = BOLT11_TIMESTAMP_WORDS;
    let descriptionHash: Uint8Array | undefined;
    while (cursor < taggedFieldsEnd) {
      if (cursor + 3 > taggedFieldsEnd) {
        return undefined;
      }
      const tag = decoded.words[cursor];
      const fieldLength =
        decoded.words[cursor + 1] * 32 + decoded.words[cursor + 2];
      cursor += 3;
      if (cursor + fieldLength > taggedFieldsEnd) {
        return undefined;
      }

      if (tag === DESCRIPTION_HASH_TAG) {
        if (
          descriptionHash !== undefined ||
          fieldLength !== BOLT11_DESCRIPTION_HASH_WORDS
        ) {
          return undefined;
        }
        const bytes = bech32.fromWordsUnsafe(
          decoded.words.slice(cursor, cursor + fieldLength),
        );
        if (bytes === undefined || bytes.length !== 32) {
          return undefined;
        }
        descriptionHash = bytes;
      }
      cursor += fieldLength;
    }

    if (cursor !== taggedFieldsEnd || descriptionHash === undefined) {
      return undefined;
    }
    return Object.freeze({
      ...(amountMsats === undefined ? {} : { amountMsats }),
      descriptionHash,
    });
  } catch {
    return undefined;
  }
}

function parseBolt11Amount(prefix: string): Msats | undefined {
  const amountText = stripBolt11Network(prefix);
  if (amountText === undefined) {
    throw new TypeError('BOLT11 network prefix is unsupported.');
  }
  if (amountText.length === 0) {
    return undefined;
  }
  const match = /^(0|[1-9][0-9]*)([munp]?)$/.exec(amountText);
  if (match === null) {
    throw new TypeError('BOLT11 amount is invalid.');
  }

  const value = BigInt(match[1]);
  const multiplier = match[2];
  let amount: bigint;
  switch (multiplier) {
    case '':
      amount = value * 100_000_000_000n;
      break;
    case 'm':
      amount = value * 100_000_000n;
      break;
    case 'u':
      amount = value * 100_000n;
      break;
    case 'n':
      amount = value * 100n;
      break;
    case 'p':
      if (value % 10n !== 0n) {
        throw new TypeError('BOLT11 amount is below one millisatoshi.');
      }
      amount = value / 10n;
      break;
    default:
      throw new TypeError('BOLT11 amount multiplier is invalid.');
  }

  if (amount < 0n || amount > (1n << 64n) - 1n) {
    throw new RangeError('BOLT11 amount exceeds the supported range.');
  }
  return amount as Msats;
}

function stripBolt11Network(prefix: string): string | undefined {
  for (const network of ['lnbcrt', 'lntbs', 'lntb', 'lnbc']) {
    if (prefix.startsWith(network)) {
      return prefix.slice(network.length);
    }
  }
  return undefined;
}
