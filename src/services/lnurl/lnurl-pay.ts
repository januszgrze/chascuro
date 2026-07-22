import { bech32 } from '@scure/base';

import {
  classifyWalletInput,
  lnurlPayOfferId,
  MAX_MSATS,
  MSATS_PER_SAT,
  msats,
  parseBolt11Binding,
  sensitiveInput,
  WalletError,
  type LnurlPayOffer,
  type LnurlPayOfferId,
  type LnurlSuccessAction,
  type Msats,
  type SensitiveInput,
} from '../../domain';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_OFFER_TTL_MS = 5 * 60 * 1000;
const MAX_LNURL_LENGTH = 4_096;
const MAX_ACTIVE_OFFERS = 8;
const MAX_SUCCESS_ACTION_CHARACTERS = 144;

export interface LnurlResolvedInvoice {
  readonly invoice: SensitiveInput;
  readonly offer: LnurlPayOffer;
  readonly successAction?: LnurlSuccessAction;
}

export interface LnurlPayResolver {
  resolve(input: SensitiveInput, signal?: AbortSignal): Promise<LnurlPayOffer>;
  requestInvoice(
    offerId: LnurlPayOfferId,
    amountMsats?: Msats,
    signal?: AbortSignal,
  ): Promise<LnurlResolvedInvoice>;
  clear(): void;
}

export interface BrowserLnurlPayResolverDependencies {
  fetchFn?: typeof fetch;
  now?: () => number;
  createId?: () => string;
  crypto?: Pick<Crypto, 'subtle'>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  offerTtlMs?: number;
}

interface StoredOffer {
  readonly offer: LnurlPayOffer;
  readonly callback: URL;
  readonly metadataRaw: string;
}

interface ResolvedTarget {
  readonly url: URL;
  readonly destination: string;
  readonly domain: string;
  readonly lightningAddress?: string;
}

export class BrowserLnurlPayResolver implements LnurlPayResolver {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly crypto: Pick<Crypto, 'subtle'>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly offerTtlMs: number;
  private readonly offers = new Map<LnurlPayOfferId, StoredOffer>();

  constructor(dependencies: BrowserLnurlPayResolverDependencies = {}) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.now = dependencies.now ?? Date.now;
    this.createId =
      dependencies.createId ?? (() => globalThis.crypto.randomUUID());
    this.crypto = dependencies.crypto ?? globalThis.crypto;
    this.timeoutMs = positiveInteger(
      dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'LNURL request timeout',
    );
    this.maxResponseBytes = positiveInteger(
      dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'LNURL response limit',
    );
    this.offerTtlMs = positiveInteger(
      dependencies.offerTtlMs ?? DEFAULT_OFFER_TTL_MS,
      'LNURL offer lifetime',
    );
  }

  async resolve(
    input: SensitiveInput,
    signal?: AbortSignal,
  ): Promise<LnurlPayOffer> {
    const target = resolveTarget(input);
    const body = await this.fetchJson(target.url, signal);
    const callback = readSecureUrl(body.callback, 'lnurl_invalid_response');
    const minSendableMsats = readSendableAmount(body.minSendable);
    const maxSendableMsats = readSendableAmount(body.maxSendable);
    if (
      body.tag !== 'payRequest' ||
      minSendableMsats > maxSendableMsats ||
      typeof body.metadata !== 'string'
    ) {
      throw new WalletError('lnurl_invalid_response');
    }

    const metadata = parseMetadata(body.metadata);
    if (target.lightningAddress !== undefined) {
      const identifier = metadata.find(
        ([type]) => type === 'text/identifier' || type === 'text/email',
      )?.[1];
      if (
        typeof identifier !== 'string' ||
        identifier.toLowerCase() !== target.lightningAddress
      ) {
        throw new WalletError('lnurl_invalid_response');
      }
    }

    const description = metadata.find(([type]) => type === 'text/plain')?.[1];
    if (typeof description !== 'string' || description.trim().length === 0) {
      throw new WalletError('lnurl_invalid_response');
    }
    const fixedAmountMsats =
      minSendableMsats === maxSendableMsats ? minSendableMsats : undefined;
    if (
      fixedAmountMsats === undefined &&
      ceilDiv(minSendableMsats, MSATS_PER_SAT) >
        maxSendableMsats / MSATS_PER_SAT
    ) {
      throw new WalletError('lnurl_invalid_response');
    }

    this.clearExpiredOffers();
    while (this.offers.size >= MAX_ACTIVE_OFFERS) {
      const oldest = this.offers.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.offers.delete(oldest);
    }
    const offerId = lnurlPayOfferId(`lnurl-${this.createId()}`);
    const expiresAtMs = this.now() + this.offerTtlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new WalletError('lnurl_invalid_response');
    }
    const offer: LnurlPayOffer = Object.freeze({
      offerId,
      destination: target.destination,
      domain: target.domain,
      description: description.trim().slice(0, 512),
      minSendableMsats,
      maxSendableMsats,
      ...(fixedAmountMsats === undefined ? {} : { fixedAmountMsats }),
      expiresAtMs,
    });
    this.offers.set(
      offerId,
      Object.freeze({ offer, callback, metadataRaw: body.metadata }),
    );
    return offer;
  }

  async requestInvoice(
    offerId: LnurlPayOfferId,
    amountMsats?: Msats,
    signal?: AbortSignal,
  ): Promise<LnurlResolvedInvoice> {
    this.clearExpiredOffers();
    const stored = this.offers.get(offerId);
    if (stored === undefined || stored.offer.expiresAtMs <= this.now()) {
      throw new WalletError('lnurl_offer_expired');
    }
    const amount = amountMsats ?? stored.offer.fixedAmountMsats;
    if (
      amount === undefined ||
      amount < stored.offer.minSendableMsats ||
      amount > stored.offer.maxSendableMsats
    ) {
      throw new WalletError('lnurl_amount_out_of_range');
    }

    const callback = new URL(stored.callback);
    callback.searchParams.set('amount', amount.toString(10));
    const body = await this.fetchJson(callback, signal);
    if (typeof body.pr !== 'string') {
      throw new WalletError('lnurl_invalid_response');
    }
    const invoice = sensitiveInput(body.pr);
    const binding = parseBolt11Binding(invoice);
    const expectedHash = new Uint8Array(
      await this.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(stored.metadataRaw),
      ),
    );
    if (
      binding?.amountMsats !== amount ||
      !equalBytes(binding.descriptionHash, expectedHash)
    ) {
      throw new WalletError('lnurl_invoice_mismatch');
    }

    const successAction = parseSuccessAction(
      body.successAction,
      stored.callback,
    );
    return Object.freeze({
      invoice,
      offer: stored.offer,
      ...(successAction === undefined ? {} : { successAction }),
    });
  }

  clear(): void {
    this.offers.clear();
  }

  private clearExpiredOffers(): void {
    const now = this.now();
    for (const [offerId, stored] of this.offers) {
      if (stored.offer.expiresAtMs <= now) {
        this.offers.delete(offerId);
      }
    }
  }

  private async fetchJson(
    url: URL,
    parentSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    parentSignal?.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new DOMException('LNURL request timed out.', 'TimeoutError'),
      );
    }, this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const text = await readBoundedText(response, this.maxResponseBytes);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new WalletError('lnurl_invalid_response');
      }
      const record = asRecord(body);
      if (record === undefined) {
        throw new WalletError('lnurl_invalid_response');
      }
      if (record.status === 'ERROR') {
        throw new WalletError('lnurl_service_error');
      }
      return record;
    } catch (error) {
      if (error instanceof WalletError) {
        throw error;
      }
      if (parentSignal?.aborted) {
        throw parentSignal.reason ?? new DOMException('Aborted.', 'AbortError');
      }
      if (timedOut) {
        throw new WalletError('request_timed_out');
      }
      throw new WalletError('lnurl_unreachable');
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', forwardAbort);
    }
  }
}

function resolveTarget(input: SensitiveInput): ResolvedTarget {
  const classified = classifyWalletInput(input);
  switch (classified.kind) {
    case 'lightning_address': {
      const [username, rawDomain] = classified.input.split('@');
      const domain = rawDomain.toLowerCase();
      if (domain.endsWith('.onion')) {
        throw new WalletError('unsupported_feature');
      }
      const url = readSecureUrl(
        `https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`,
        'invalid_input',
      );
      return Object.freeze({
        url,
        destination: `${username}@${domain}`,
        domain,
        lightningAddress: `${username}@${domain}`,
      });
    }
    case 'lnurl': {
      const decoded = /^lnurlp:\/\//i.test(classified.input)
        ? `https://${classified.input.slice('lnurlp://'.length)}`
        : decodeLnurl(classified.input);
      const url = readSecureUrl(decoded, 'invalid_input');
      return Object.freeze({
        url,
        destination: url.hostname,
        domain: url.hostname,
      });
    }
    default:
      throw new WalletError('invalid_input');
  }
}

function decodeLnurl(input: string): string {
  if (input.length > MAX_LNURL_LENGTH) {
    throw new WalletError('invalid_input');
  }
  try {
    const decoded = bech32.decode(input, false);
    if (decoded.prefix !== 'lnurl') {
      throw new TypeError('Unexpected LNURL prefix.');
    }
    const bytes = bech32.fromWords(decoded.words);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WalletError('invalid_input');
  }
}

function readSecureUrl(
  value: unknown,
  errorCode: 'invalid_input' | 'lnurl_invalid_response',
): URL {
  if (typeof value !== 'string' || value.length > 8_192) {
    throw new WalletError(errorCode);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WalletError(errorCode);
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    isLocalHostname(url.hostname)
  ) {
    throw new WalletError(errorCode);
  }
  return url;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized === '[::1]'
  ) {
    return true;
  }
  // URL implementations retain square brackets around IPv6 hostnames. Reject
  // every literal IPv6 target rather than risk accepting an alternate spelling
  // of a loopback, link-local, unique-local, or IPv4-mapped address.
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return true;
  }
  const octets = normalized.split('.').map(Number);
  if (
    octets.length !== 4 ||
    !octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    )
  ) {
    return false;
  }
  return (
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 &&
      ((octets[1] === 0 && (octets[2] === 0 || octets[2] === 2)) ||
        octets[1] === 168)) ||
    (octets[0] === 198 &&
      (octets[1] === 18 ||
        octets[1] === 19 ||
        (octets[1] === 51 && octets[2] === 100))) ||
    (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
    octets[0] >= 224
  );
}

function readSendableAmount(value: unknown): Msats {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    BigInt(value) > MAX_MSATS
  ) {
    throw new WalletError('lnurl_invalid_response');
  }
  return msats(BigInt(value));
}

function parseMetadata(value: string): ReadonlyArray<readonly unknown[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WalletError('lnurl_invalid_response');
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length >= 2 &&
        typeof entry[0] === 'string',
    )
  ) {
    throw new WalletError('lnurl_invalid_response');
  }
  return parsed;
}

function parseSuccessAction(
  value: unknown,
  callback: URL,
): LnurlSuccessAction | undefined {
  if (value === undefined) {
    return undefined;
  }
  const action = asRecord(value);
  if (action?.tag === 'message' && validActionText(action.message)) {
    return Object.freeze({ tag: 'message', message: action.message });
  }
  if (
    action?.tag === 'url' &&
    validActionText(action.description) &&
    typeof action.url === 'string'
  ) {
    const url = readSecureUrl(action.url, 'lnurl_invalid_response');
    if (url.hostname !== callback.hostname) {
      throw new WalletError('lnurl_invalid_response');
    }
    return Object.freeze({
      tag: 'url',
      description: action.description,
      url: url.toString(),
    });
  }
  if (typeof action?.tag === 'string') {
    throw new WalletError('lnurl_unsupported_success_action');
  }
  throw new WalletError('lnurl_invalid_response');
}

function validActionText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Array.from(value).length <= MAX_SUCCESS_ACTION_CHARACTERS &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return (
        (codePoint <= 0x1f &&
          codePoint !== 0x09 &&
          codePoint !== 0x0a &&
          codePoint !== 0x0d) ||
        codePoint === 0x7f
      );
    })
  );
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(maximumBytes)
  ) {
    throw new WalletError('lnurl_invalid_response');
  }
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new WalletError('lnurl_invalid_response');
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}
