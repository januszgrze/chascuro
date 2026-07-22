import { bech32 } from '@scure/base';

const HEX_32 = /^[0-9a-f]{64}$/u;

export interface ParsedChatAddress {
  readonly address: string;
  readonly fingerprint: string;
  readonly publicKeyHex: string;
}

export function chatAddressFromPublicKey(
  publicKeyHex: string,
): ParsedChatAddress {
  const normalized = publicKeyHex.toLowerCase();
  if (!HEX_32.test(normalized)) throw new TypeError('Invalid chat public key.');
  const bytes = Uint8Array.from(normalized.match(/.{2}/gu)!, (value) =>
    Number.parseInt(value, 16),
  );
  return Object.freeze({
    address: bech32.encode('npub', bech32.toWords(bytes), false),
    fingerprint: fingerprint(normalized),
    publicKeyHex: normalized,
  });
}

export function parseChatAddress(value: string): ParsedChatAddress {
  const normalized = value.trim().toLowerCase();
  if (HEX_32.test(normalized)) return chatAddressFromPublicKey(normalized);
  try {
    const decoded = bech32.decode(normalized, false);
    if (decoded.prefix !== 'npub') throw new TypeError('Not an npub.');
    const bytes = bech32.fromWords(decoded.words);
    if (bytes.length !== 32) throw new TypeError('Wrong npub length.');
    const publicKeyHex = [...bytes]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return chatAddressFromPublicKey(publicKeyHex);
  } catch {
    throw new TypeError('Invalid chat address.');
  }
}

function fingerprint(publicKeyHex: string): string {
  return publicKeyHex.slice(0, 32).toUpperCase().match(/.{4}/gu)!.join(' ');
}
