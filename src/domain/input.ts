import { sensitiveInput, type SensitiveInput } from './payments';

export const MAX_WALLET_INPUT_BYTES = 64 * 1024;

export type ClassifiedInputKind =
  | 'federation_invite'
  | 'ecash'
  | 'bolt11'
  | 'lightning_address'
  | 'lnurl'
  | 'unsupported';

export interface ClassifiedInput {
  readonly kind: ClassifiedInputKind;
  readonly input: SensitiveInput;
}

const BOLT11_PREFIX = /^(lnbc|lntb|lntbs|lnbcrt)[0-9a-z]+$/i;
const LNURL_PREFIX = /^lnurl1[02-9ac-hj-np-z]+$/i;
const LIGHTNING_ADDRESS_USER = /^[a-z0-9._-]+(?:\+[a-z0-9._-]+)?$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const FEDERATION_INVITE_PREFIX = /^(fed1|fedi:|fedimint-invite:)/i;
const ECASH_PREFIX = /^(fedimint|fedimint-ecash:)/i;

/**
 * Performs only a bounded lexical classification. The relevant wallet service
 * must still parse and validate the payload before any preview is shown.
 */
export function classifyWalletInput(value: string): ClassifiedInput {
  const original = sensitiveInput(value, MAX_WALLET_INPUT_BYTES);
  const unwrapped = /^lightning:/i.test(original)
    ? original.slice(original.indexOf(':') + 1)
    : original;
  const input = sensitiveInput(unwrapped, MAX_WALLET_INPUT_BYTES);

  let kind: ClassifiedInputKind = 'unsupported';
  if (BOLT11_PREFIX.test(input)) {
    kind = 'bolt11';
  } else if (LNURL_PREFIX.test(input) || /^lnurlp:\/\//i.test(input)) {
    kind = 'lnurl';
  } else if (isLightningAddress(input)) {
    kind = 'lightning_address';
  } else if (FEDERATION_INVITE_PREFIX.test(input)) {
    kind = 'federation_invite';
  } else if (ECASH_PREFIX.test(input)) {
    kind = 'ecash';
  }

  return Object.freeze({ kind, input });
}

function isLightningAddress(value: string): boolean {
  const separator = value.lastIndexOf('@');
  if (
    separator <= 0 ||
    separator !== value.indexOf('@') ||
    !LIGHTNING_ADDRESS_USER.test(value.slice(0, separator))
  ) {
    return false;
  }
  const domain = value.slice(separator + 1);
  const labels = domain.split('.');
  return (
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL.test(label)) &&
    labels.at(-1)!.length >= 2
  );
}
