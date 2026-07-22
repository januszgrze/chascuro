import type { FedimintWallet } from '@fedimint/core';
import { describe, expect, it, vi } from 'vitest';

import {
  clientName,
  confirmLightningQuote,
  federationId,
  msats,
  operationId,
  sensitiveInput,
  type ActiveFederation,
  type OperationKey,
} from '../../domain';
import {
  FedimintWalletService,
  normalizeInternalPayState,
  normalizeLnPayState,
  normalizeLnReceiveState,
  normalizeReissueState,
  normalizeSpendState,
  parseBolt11Header,
  parseGatewayFeePolicy,
  quoteGatewayFee,
  sanitizeFederationPreview,
  sanitizeSdkOperation,
} from './fedimint-wallet-service';

type ReissueState = Parameters<typeof normalizeReissueState>[0];
type SpendState = Parameters<typeof normalizeSpendState>[0];
type LightningReceiveState = Parameters<typeof normalizeLnReceiveState>[0];

interface CapturedStream<State> {
  readonly onState: (state: State) => void;
  readonly onError: (error: string) => void;
  readonly cancel: ReturnType<typeof vi.fn>;
}

type SdkOperationFixture = readonly [
  {
    readonly operation_id: string;
    readonly creation_time: {
      readonly secs_since_epoch: number;
      readonly nanos_since_epoch: number;
    };
  },
  {
    readonly operation_module_kind: string;
    readonly meta: {
      readonly amount: number;
      readonly extra_meta: Record<string, unknown>;
      readonly variant: Record<string, unknown>;
    };
    readonly outcome: {
      readonly outcome: unknown;
    };
  },
];

const activeFederation: ActiveFederation = Object.freeze({
  federationId: federationId('fed-a'),
  displayName: 'Test federation',
  network: 'signet',
  modules: Object.freeze(['ln', 'mint']),
  guardianCount: 3,
  clientName: clientName('dd5135b2-c228-41b7-a4f9-3b6e7afe3088'),
  joinedAtMs: 1_000,
});

function operationFixture(input: {
  operationId?: string;
  moduleKind: string;
  variant: Record<string, unknown>;
  outcome: unknown;
}): SdkOperationFixture {
  return [
    {
      operation_id: input.operationId ?? 'operation-1',
      creation_time: {
        secs_since_epoch: 10,
        nanos_since_epoch: 0,
      },
    },
    {
      operation_module_kind: input.moduleKind,
      meta: {
        amount: 5_000,
        extra_meta: {},
        variant: input.variant,
      },
      outcome: {
        outcome: input.outcome,
      },
    },
  ];
}

function attachSdkWallet(
  service: FedimintWalletService,
  fixture: SdkOperationFixture,
) {
  const reissueStreams: CapturedStream<ReissueState>[] = [];
  const spendStreams: CapturedStream<SpendState>[] = [];
  const lightningReceiveStreams: CapturedStream<LightningReceiveState>[] = [];
  const listOperations = vi.fn().mockResolvedValue([fixture]);
  const getOperation = vi.fn().mockResolvedValue(fixture[1]);

  const wallet = {
    federation: {
      listOperations,
      getOperation,
    },
    mint: {
      subscribeReissueExternalNotes: vi.fn(
        (
          _operationId: string,
          onState: (state: ReissueState) => void,
          onError: (error: string) => void,
        ) => {
          const stream = {
            onState,
            onError,
            cancel: vi.fn(),
          };
          reissueStreams.push(stream);
          return stream.cancel;
        },
      ),
      subscribeSpendNotes: vi.fn(
        (
          _operationId: string,
          onState: (state: SpendState) => void,
          onError: (error: string) => void,
        ) => {
          const stream = {
            onState,
            onError,
            cancel: vi.fn(),
          };
          spendStreams.push(stream);
          return stream.cancel;
        },
      ),
    },
    lightning: {
      subscribeLnReceive: vi.fn(
        (
          _operationId: string,
          onState: (state: LightningReceiveState) => void,
          onError: (error: string) => void,
        ) => {
          const stream = {
            onState,
            onError,
            cancel: vi.fn(),
          };
          lightningReceiveStreams.push(stream);
          return stream.cancel;
        },
      ),
    },
  } as unknown as FedimintWallet;

  Object.assign(service as unknown as Record<string, unknown>, {
    wallet,
    generation: 1,
    snapshot: Object.freeze({
      ...service.getSnapshot(),
      lifecycle: 'ready',
      connection: 'online',
      activeFederation,
    }),
  });

  const key: OperationKey = Object.freeze({
    federationId: activeFederation.federationId,
    operationId: operationId(fixture[0].operation_id),
  });

  return {
    key,
    listOperations,
    getOperation,
    reissueStreams,
    spendStreams,
    lightningReceiveStreams,
  };
}

describe('sanitizeFederationPreview', () => {
  it('extracts only display-safe federation metadata', () => {
    const candidate = sanitizeFederationPreview(
      {
        federation_id: 'federation-1',
        config: {
          global: {
            api_endpoints: {
              0: { url: 'wss://one.example' },
              1: { url: 'wss://two.example' },
            },
            meta: {
              federation_name: 'Community Signet',
              network: 'signet',
            },
          },
          modules: {
            0: { kind: 'mint' },
            1: { kind: 'ln' },
          },
        },
      },
      'candidate-1',
      1_000,
    );

    expect(candidate).toEqual({
      candidateId: 'candidate-1',
      federationId: 'federation-1',
      displayName: 'Community Signet',
      network: 'signet',
      modules: ['ln', 'mint'],
      guardianCount: 2,
      guardianOrigins: ['wss://one.example', 'wss://two.example'],
      expiresAtMs: 1_000,
    });
    expect(candidate).not.toHaveProperty('inviteCode');
  });

  it('finds mainnet inside an array-shaped wallet module config', () => {
    const candidate = sanitizeFederationPreview(
      {
        federation_id: 'federation-mainnet',
        config: {
          global: {
            api_endpoints: {
              0: { url: 'wss://one.example' },
            },
            meta: { federation_name: 'Mainnet Federation' },
          },
          modules: [
            { kind: 'mint', version: 1, config: {} },
            {
              kind: 'wallet',
              version: 1,
              config: { bitcoin_network: 'mainnet' },
            },
          ],
        },
      },
      'candidate-mainnet',
      1_000,
    );

    expect(candidate.network).toBe('bitcoin');
    expect(candidate.modules).toEqual(['mint', 'wallet']);
  });

  it('fails closed when module configs claim conflicting networks', () => {
    const candidate = sanitizeFederationPreview(
      {
        federation_id: 'federation-conflict',
        config: {
          modules: {
            0: { kind: 'mint', config: {} },
            1: { kind: 'wallet', config: { network: 'bitcoin' } },
            2: { kind: 'ln', config: { network: 'signet' } },
          },
        },
      },
      'candidate-conflict',
      1_000,
    );

    expect(candidate.network).toBe('unknown');
  });
});

describe('Fedimint SDK state normalization', () => {
  it('maps exact ecash and Lightning receive states conservatively', () => {
    expect(normalizeReissueState('Created')).toBe('created');
    expect(normalizeReissueState('Issuing')).toBe('pending');
    expect(normalizeReissueState('Done')).toBe('settled');

    expect(normalizeSpendState('UserCanceledProcessing')).toBe('refunding');
    expect(normalizeSpendState('UserCanceledSuccess')).toBe('refunded');
    expect(normalizeSpendState('Refunded')).toBe('refunded');
    expect(normalizeSpendState('Success')).toBe('unknown');

    expect(
      normalizeLnReceiveState({
        waiting_for_payment: { invoice: 'secret', timeout: 60 },
      }),
    ).toBe('awaiting_external_payment');
    expect(normalizeLnReceiveState('awaiting_funds')).toBe('pending');
    expect(normalizeLnReceiveState('claimed')).toBe('settled');
    expect(normalizeLnReceiveState({ canceled: { reason: 'expired' } })).toBe(
      'cancelled',
    );
  });

  it('maps external and internal Lightning payment states conservatively', () => {
    expect(normalizeLnPayState('created')).toBe('pending');
    expect(normalizeLnPayState({ funded: { block_height: 100 } })).toBe(
      'pending',
    );
    expect(
      normalizeLnPayState({ waiting_for_refund: { error_reason: 'private' } }),
    ).toBe('refunding');
    expect(normalizeLnPayState({ success: { preimage: 'secret' } })).toBe(
      'settled',
    );
    expect(
      normalizeLnPayState({ refunded: { gateway_error: 'private' } }),
    ).toBe('refunded');
    expect(normalizeInternalPayState('funding')).toBe('pending');
    expect(normalizeInternalPayState({ preimage: 'secret' })).toBe('settled');
    expect(
      normalizeInternalPayState({ funding_failed: { error: 'private' } }),
    ).toBe('failed');
  });

  it('sanitizes SDK operation logs without carrying secret variants', () => {
    const raw = [
      {
        operation_id: 'operation-1',
        creation_time: {
          secs_since_epoch: 10,
          nanos_since_epoch: 0,
        },
      },
      {
        operation_module_kind: 'ln',
        meta: {
          amount: 5_000,
          extra_meta: {
            secret: 'must-not-cross-boundary',
          },
          variant: {
            pay: {
              invoice: 'lntb1secret',
              gateway_id: 'gateway',
              fee: 100,
              is_internal_payment: false,
              out_point: { txid: 'txid', out_idx: 0 },
            },
          },
        },
        outcome: {
          outcome: {
            waiting_for_refund: {
              error_reason: 'private gateway detail',
            },
          },
        },
      },
    ];

    const operation = sanitizeSdkOperation(raw, federationId('fed-a'), 50_000);
    expect(operation).toMatchObject({
      kind: 'lightning_send',
      direction: 'outgoing',
      status: 'refunding',
      amountMsats: 5_000n,
      feeMsats: 100n,
      createdAtMs: 10_000,
      updatedAtMs: 50_000,
    });
    expect(
      JSON.stringify(operation, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('secret');
  });

  it('keeps generic SDK success conservative for ecash spends', () => {
    for (const outcome of [
      'success',
      'Success',
      { success: { private_notes: 'must-not-cross-boundary' } },
      { Success: { private_notes: 'must-not-cross-boundary' } },
    ]) {
      const operation = sanitizeSdkOperation(
        operationFixture({
          moduleKind: 'mint',
          variant: {
            spend_o_o_b: {
              requested_amount: 5_000,
              oob_notes: 'secret notes',
            },
          },
          outcome,
        }),
        federationId('fed-a'),
        50_000,
      );

      expect(operation).toMatchObject({
        kind: 'ecash_send',
        direction: 'outgoing',
        status: 'unknown',
        createdAtMs: 10_000,
        updatedAtMs: 50_000,
      });
      expect(
        JSON.stringify(operation, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ).not.toContain('secret');
    }
  });
});

describe('Fedimint Lightning payment boundary', () => {
  it('parses BOLT11 timestamps and known gateway fee formats', () => {
    const invoice = testInvoice('lnbc', 1_700_000_000);
    expect(parseBolt11Header(invoice)).toEqual({
      network: 'bitcoin',
      timestampSeconds: 1_700_000_000,
    });
    expect(
      parseGatewayFeePolicy({ base_msat: 1_000, proportional_millionths: 500 }),
    ).toEqual({ baseMsats: 1_000n, partsPerMillion: 500n });
    expect(
      quoteGatewayFee(
        {
          gateway_id: 'gateway-a',
          api: 'https://gateway.example',
          node_pub_key: 'node',
          federation_index: 0,
          route_hints: [],
          fees: { base_msat: 1_000, proportional_millionths: 500 },
        },
        msats(100_000n),
      ),
    ).toBe(1_050n);
  });

  it('quotes an exact gateway and tracks an external Lightning payment', async () => {
    const service = new FedimintWalletService();
    const timestamp = Math.floor(Date.now() / 1000);
    const invoice = testInvoice('lnbc', timestamp);
    const gateway = {
      gateway_id: 'gateway-a',
      api: 'https://gateway.example',
      node_pub_key: 'node',
      federation_index: 0,
      route_hints: [],
      fees: { base_msat: 1_000, proportional_millionths: 1_000 },
    };
    let onPayState:
      ((state: { success: { preimage: string } }) => void) | undefined;
    const payInvoice = vi.fn().mockResolvedValue({
      payment_type: { lightning: 'lightning-operation' },
      contract_id: 'contract-id',
      fee: 1_100,
    });
    const wallet = {
      lightning: {
        updateGatewayCache: vi.fn().mockResolvedValue(undefined),
        listGateways: vi
          .fn()
          .mockResolvedValue([{ info: gateway, vetted: true }]),
        payInvoice,
        subscribeLnPay: vi.fn(
          (
            _id: string,
            onState: (state: { success: { preimage: string } }) => void,
          ) => {
            onPayState = onState;
            return vi.fn();
          },
        ),
      },
    } as unknown as FedimintWallet;
    const director = {
      parseBolt11InvoicePayload: vi.fn().mockResolvedValue({
        amount: 100,
        expiry: 3_600,
        memo: 'Mainnet payment',
      }),
    };
    Object.assign(service as unknown as Record<string, unknown>, {
      wallet,
      director,
      generation: 1,
      snapshot: Object.freeze({
        ...service.getSnapshot(),
        lifecycle: 'ready',
        connection: 'online',
        activeFederation: { ...activeFederation, network: 'unknown' },
      }),
    });

    const preview = await service.lightning.parseInvoice(
      sensitiveInput(invoice),
    );
    expect(director.parseBolt11InvoicePayload).toHaveBeenCalledWith(invoice);
    const quote = await service.lightning.quotePayment({
      preview,
      maximumFeeMsats: msats(2_000n),
    });
    expect(quote).toMatchObject({
      amountMsats: 100_000n,
      feeMsats: 1_100n,
      gatewayId: 'gateway-a',
    });
    const tracked = await service.lightning.pay(
      confirmLightningQuote(quote, preview.fingerprint, Date.now()),
    );
    expect(payInvoice).toHaveBeenCalledWith(invoice, gateway, {});
    expect(tracked.operation).toMatchObject({
      kind: 'lightning_send',
      status: 'pending',
      feeMsats: 1_100n,
      reconciliationCursor: 'lightning:external',
    });

    onPayState?.({ success: { preimage: 'secret' } });
    expect(service.getSnapshot().operations[0]?.status).toBe('settled');
  });
});

function testInvoice(
  prefix: 'lnbc' | 'lntb' | 'lnbcrt',
  timestampSeconds: number,
): string {
  let remaining = timestampSeconds;
  const words = Array.from({ length: 7 }, () => 0);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    words[index] = remaining % 32;
    remaining = Math.floor(remaining / 32);
  }
  const timestamp = words
    .map((word) => 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'[word])
    .join('');
  return `${prefix}1${timestamp}${'q'.repeat(110)}`;
}

describe('Fedimint restored operation subscriptions', () => {
  it('reattaches the SDK stream that matches each restored operation kind', async () => {
    const cases = [
      {
        fixture: operationFixture({
          operationId: 'ecash-receive',
          moduleKind: 'mint',
          variant: { reissuance: { txid: 'txid' } },
          outcome: 'Created',
        }),
        stream: 'reissue',
      },
      {
        fixture: operationFixture({
          operationId: 'ecash-spend',
          moduleKind: 'mint',
          variant: {
            spend_o_o_b: {
              requested_amount: 5_000,
              oob_notes: 'secret notes',
            },
          },
          outcome: 'Created',
        }),
        stream: 'spend',
      },
      {
        fixture: operationFixture({
          operationId: 'lightning-receive',
          moduleKind: 'ln',
          variant: {
            receive: {
              gateway_id: 'gateway',
              invoice: 'secret invoice',
              out_point: { txid: 'txid', out_idx: 0 },
            },
          },
          outcome: {
            waiting_for_payment: {
              invoice: 'secret invoice',
              timeout: 60,
            },
          },
        }),
        stream: 'lightning-receive',
      },
    ] as const;

    for (const testCase of cases) {
      const service = new FedimintWalletService();
      const harness = attachSdkWallet(service, testCase.fixture);
      const listener = vi.fn();
      const unsubscribe = service.operations.subscribe(harness.key, listener);

      await vi.waitFor(() => {
        expect(
          harness.reissueStreams.length +
            harness.spendStreams.length +
            harness.lightningReceiveStreams.length,
        ).toBe(1);
      });
      expect(harness.listOperations).toHaveBeenCalledTimes(1);
      expect(harness.getOperation).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledTimes(1);

      const stream =
        testCase.stream === 'reissue'
          ? harness.reissueStreams[0]
          : testCase.stream === 'spend'
            ? harness.spendStreams[0]
            : harness.lightningReceiveStreams[0];
      expect(stream).toBeDefined();

      unsubscribe();
      unsubscribe();
      expect(stream?.cancel).toHaveBeenCalledTimes(1);
    }
  });

  it('deduplicates SDK streams, retries after disconnect, and rejects late callbacks', async () => {
    const service = new FedimintWalletService();
    const harness = attachSdkWallet(
      service,
      operationFixture({
        operationId: 'restored-spend',
        moduleKind: 'mint',
        variant: {
          spend_o_o_b: {
            requested_amount: 5_000,
            oob_notes: 'secret notes',
          },
        },
        outcome: 'Created',
      }),
    );
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = service.operations.subscribe(
      harness.key,
      firstListener,
    );
    const unsubscribeSecond = service.operations.subscribe(
      harness.key,
      secondListener,
    );

    await vi.waitFor(() => {
      expect(harness.spendStreams).toHaveLength(1);
    });
    expect(harness.listOperations).toHaveBeenCalledTimes(1);
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    const disconnectedStream = harness.spendStreams[0];
    disconnectedStream?.onError('transport disconnected');
    expect(disconnectedStream?.cancel).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().connection).toBe('offline');

    await expect(service.operations.reconcile()).resolves.toMatchObject({
      observed: 1,
      unchanged: 1,
    });
    expect(harness.spendStreams).toHaveLength(2);

    const reconnectedStream = harness.spendStreams[1];
    disconnectedStream?.onState('Refunded');
    expect(firstListener.mock.lastCall?.[0]).toMatchObject({
      status: 'created',
    });

    reconnectedStream?.onState('Success');
    expect(firstListener.mock.lastCall?.[0]).toMatchObject({
      status: 'unknown',
    });
    expect(reconnectedStream?.cancel).not.toHaveBeenCalled();

    reconnectedStream?.onState('Refunded');
    expect(firstListener.mock.lastCall?.[0]).toMatchObject({
      status: 'refunded',
    });
    expect(secondListener.mock.lastCall?.[0]).toMatchObject({
      status: 'refunded',
    });
    expect(reconnectedStream?.cancel).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    unsubscribeSecond();
    expect(reconnectedStream?.cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts a reconciled terminal outcome even if the wall clock moved backward', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      const service = new FedimintWalletService();
      const created = operationFixture({
        operationId: 'clock-rollback-spend',
        moduleKind: 'mint',
        variant: {
          spend_o_o_b: {
            requested_amount: 5_000,
            oob_notes: 'secret notes',
          },
        },
        outcome: 'Created',
      });
      const harness = attachSdkWallet(service, created);
      const listener = vi.fn();
      const unsubscribe = service.operations.subscribe(harness.key, listener);

      await vi.waitFor(() => {
        expect(harness.spendStreams).toHaveLength(1);
      });
      expect(listener.mock.lastCall?.[0]).toMatchObject({
        status: 'created',
        updatedAtMs: 100_000,
      });

      now.mockReturnValue(50_000);
      harness.listOperations.mockResolvedValue([
        operationFixture({
          operationId: 'clock-rollback-spend',
          moduleKind: 'mint',
          variant: {
            spend_o_o_b: {
              requested_amount: 5_000,
              oob_notes: 'secret notes',
            },
          },
          outcome: 'Refunded',
        }),
      ]);

      await expect(service.operations.reconcile()).resolves.toMatchObject({
        updated: 1,
      });
      expect(listener.mock.lastCall?.[0]).toMatchObject({
        status: 'refunded',
        updatedAtMs: 100_000,
      });
      expect(harness.spendStreams[0]?.cancel).toHaveBeenCalledTimes(1);
      unsubscribe();
    } finally {
      now.mockRestore();
    }
  });
});
