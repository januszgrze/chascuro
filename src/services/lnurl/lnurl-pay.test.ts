import { bech32 } from '@scure/base';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { msats, sensitiveInput } from '../../domain';
import { BrowserLnurlPayResolver } from './lnurl-pay';

const DESCRIPTION_HASH_TAG = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.indexOf('h');
const METADATA =
  '[["text/plain","Coffee for Alice"],["text/identifier","alice@example.com"]]';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function payRequest(overrides: Record<string, unknown> = {}) {
  return {
    callback: 'https://pay.example/callback?existing=yes',
    minSendable: 1_000,
    maxSendable: 100_000,
    metadata: METADATA,
    tag: 'payRequest',
    ...overrides,
  };
}

function encodeLnurl(url: string): string {
  return bech32.encode(
    'lnurl',
    bech32.toWords(new TextEncoder().encode(url)),
    false,
  );
}

async function boundInvoice(
  amountMsats: bigint,
  metadata = METADATA,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(metadata)),
  );
  const hashWords = bech32.toWords(digest);
  return bech32.encode(
    `lntb${(amountMsats * 10n).toString()}p`,
    [
      ...Array<number>(7).fill(0),
      DESCRIPTION_HASH_TAG,
      1,
      20,
      ...hashWords,
      ...Array<number>(104).fill(0),
    ],
    false,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserLnurlPayResolver', () => {
  it('resolves a Lightning Address into an opaque display-safe offer', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(payRequest(), {
        status: 503,
      }),
    );
    const resolver = new BrowserLnurlPayResolver({
      fetchFn,
      createId: () => 'offer-one',
      now: () => 1_000,
    });

    const offer = await resolver.resolve(sensitiveInput('alice@EXAMPLE.com'));

    expect(offer).toMatchObject({
      offerId: 'lnurl-offer-one',
      destination: 'alice@example.com',
      domain: 'example.com',
      description: 'Coffee for Alice',
      minSendableMsats: 1_000n,
      maxSendableMsats: 100_000n,
      expiresAtMs: 301_000,
    });
    expect(offer).not.toHaveProperty('callback');
    expect(offer).not.toHaveProperty('metadataRaw');
    expect(fetchFn).toHaveBeenCalledWith(
      new URL('https://example.com/.well-known/lnurlp/alice'),
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    );
  });

  it('supports bech32 and raw lnurlp targets', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(payRequest())));
    const resolver = new BrowserLnurlPayResolver({
      fetchFn,
      createId: () => String(fetchFn.mock.calls.length),
    });

    await resolver.resolve(
      sensitiveInput(encodeLnurl('https://pay.example/start?q=1')),
    );
    await resolver.resolve(sensitiveInput('lnurlp://pay.example/start?q=2'));

    expect(fetchFn.mock.calls[0]?.[0]).toEqual(
      new URL('https://pay.example/start?q=1'),
    );
    expect(fetchFn.mock.calls[1]?.[0]).toEqual(
      new URL('https://pay.example/start?q=2'),
    );
  });

  it('requests a bound invoice without exposing or losing callback query parameters', async () => {
    const invoice = await boundInvoice(21_000n);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(payRequest()))
      .mockResolvedValueOnce(
        jsonResponse({
          pr: invoice,
          successAction: { tag: 'message', message: 'Thanks!' },
        }),
      );
    const resolver = new BrowserLnurlPayResolver({
      fetchFn,
      createId: () => 'bound',
    });
    const offer = await resolver.resolve(sensitiveInput('alice@example.com'));

    const result = await resolver.requestInvoice(offer.offerId, msats(21_000n));

    const callback = fetchFn.mock.calls[1]?.[0] as URL;
    expect(callback.searchParams.get('existing')).toBe('yes');
    expect(callback.searchParams.getAll('amount')).toEqual(['21000']);
    expect(result).toMatchObject({
      invoice,
      offer: { offerId: offer.offerId },
      successAction: { tag: 'message', message: 'Thanks!' },
    });
  });

  it('uses the exact fixed millisatoshi amount when no keypad amount is supplied', async () => {
    const invoice = await boundInvoice(1n);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(payRequest({ minSendable: 1, maxSendable: 1 })),
      )
      .mockResolvedValueOnce(jsonResponse({ pr: invoice }));
    const resolver = new BrowserLnurlPayResolver({
      fetchFn,
      createId: () => 'fixed',
    });
    const offer = await resolver.resolve(sensitiveInput('alice@example.com'));

    await expect(resolver.requestInvoice(offer.offerId)).resolves.toMatchObject(
      {
        offer: { fixedAmountMsats: 1n },
      },
    );
    expect((fetchFn.mock.calls[1]?.[0] as URL).searchParams.get('amount')).toBe(
      '1',
    );
  });

  it('accepts only same-callback-host HTTPS success links', async () => {
    const invoice = await boundInvoice(2_000n);
    const acceptedFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(payRequest()))
      .mockResolvedValueOnce(
        jsonResponse({
          pr: invoice,
          successAction: {
            tag: 'url',
            description: 'View receipt',
            url: 'https://pay.example/receipt?id=1',
          },
        }),
      );
    const accepted = new BrowserLnurlPayResolver({
      fetchFn: acceptedFetch,
      createId: () => 'url-accepted',
    });
    const acceptedOffer = await accepted.resolve(
      sensitiveInput('alice@example.com'),
    );

    await expect(
      accepted.requestInvoice(acceptedOffer.offerId, msats(2_000n)),
    ).resolves.toMatchObject({
      successAction: {
        tag: 'url',
        description: 'View receipt',
        url: 'https://pay.example/receipt?id=1',
      },
    });

    const rejected = new BrowserLnurlPayResolver({
      fetchFn: vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(payRequest()))
        .mockResolvedValueOnce(
          jsonResponse({
            pr: invoice,
            successAction: {
              tag: 'url',
              description: 'View receipt',
              url: 'https://other.example/receipt',
            },
          }),
        ),
      createId: () => 'url-rejected',
    });
    const rejectedOffer = await rejected.resolve(
      sensitiveInput('alice@example.com'),
    );

    await expect(
      rejected.requestInvoice(rejectedOffer.offerId, msats(2_000n)),
    ).rejects.toMatchObject({ code: 'lnurl_invalid_response' });
  });

  it.each([
    [{ status: 'ERROR', reason: 'user not found' }, 'lnurl_service_error'],
    [payRequest({ tag: 'withdrawRequest' }), 'lnurl_invalid_response'],
    [
      payRequest({ minSendable: 2_000, maxSendable: 1_000 }),
      'lnurl_invalid_response',
    ],
    [
      payRequest({ metadata: '[["text/long-desc","Missing plain"]]' }),
      'lnurl_invalid_response',
    ],
    [
      payRequest({ metadata: '[["text/plain","No identifier"]]' }),
      'lnurl_invalid_response',
    ],
  ])('fails closed on invalid pay responses', async (response, code) => {
    const resolver = new BrowserLnurlPayResolver({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(response)),
    });

    await expect(
      resolver.resolve(sensitiveInput('alice@example.com')),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    'lnurlp://localhost/pay',
    'lnurlp://[::1]/pay',
    'lnurlp://[fd00::1]/pay',
    'lnurlp://0.0.0.0/pay',
    'lnurlp://127.0.0.1/pay',
    'lnurlp://100.64.0.1/pay',
    'lnurlp://192.168.1.10/pay',
  ])('rejects local-network targets: %s', async (target) => {
    const fetchFn = vi.fn();
    const resolver = new BrowserLnurlPayResolver({ fetchFn });

    await expect(
      resolver.resolve(sensitiveInput(target)),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects out-of-range, expired, mismatched, and unsupported callback invoices', async () => {
    let now = 1_000;
    const wrongAmount = await boundInvoice(9_000n);
    const validAmount = await boundInvoice(2_000n);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(payRequest()))
      .mockResolvedValueOnce(jsonResponse({ pr: wrongAmount }))
      .mockResolvedValueOnce(
        jsonResponse({
          pr: validAmount,
          successAction: { tag: 'aes', ciphertext: 'secret' },
        }),
      );
    const resolver = new BrowserLnurlPayResolver({
      fetchFn,
      now: () => now,
      createId: () => 'checks',
      offerTtlMs: 100,
    });
    const offer = await resolver.resolve(sensitiveInput('alice@example.com'));

    await expect(
      resolver.requestInvoice(offer.offerId, msats(999n)),
    ).rejects.toMatchObject({ code: 'lnurl_amount_out_of_range' });
    await expect(
      resolver.requestInvoice(offer.offerId, msats(2_000n)),
    ).rejects.toMatchObject({ code: 'lnurl_invoice_mismatch' });
    await expect(
      resolver.requestInvoice(offer.offerId, msats(2_000n)),
    ).rejects.toMatchObject({ code: 'lnurl_unsupported_success_action' });

    now = 1_100;
    await expect(
      resolver.requestInvoice(offer.offerId, msats(2_000n)),
    ).rejects.toMatchObject({ code: 'lnurl_offer_expired' });
  });

  it('rejects oversized responses before JSON parsing', async () => {
    const resolver = new BrowserLnurlPayResolver({
      fetchFn: vi.fn().mockResolvedValue(
        new Response('{}', {
          headers: { 'content-length': '1000' },
        }),
      ),
      maxResponseBytes: 100,
    });

    await expect(
      resolver.resolve(sensitiveInput('alice@example.com')),
    ).rejects.toMatchObject({ code: 'lnurl_invalid_response' });
  });

  it('maps timeout and opaque browser fetch failures distinctly', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const resolver = new BrowserLnurlPayResolver({ fetchFn, timeoutMs: 10 });
    const pending = resolver.resolve(sensitiveInput('alice@example.com'));
    const timedOut = expect(pending).rejects.toMatchObject({
      code: 'request_timed_out',
    });

    await vi.advanceTimersByTimeAsync(10);
    await timedOut;

    vi.useRealTimers();
    const unreachable = new BrowserLnurlPayResolver({
      fetchFn: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    });
    await expect(
      unreachable.resolve(sensitiveInput('alice@example.com')),
    ).rejects.toMatchObject({ code: 'lnurl_unreachable' });
  });
});
