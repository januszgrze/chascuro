import { describe, expect, it, vi } from 'vitest';

import {
  approveFederationJoin,
  candidateId,
  confirmEcashRedeem,
  confirmEcashSpend,
  confirmLightningQuote,
  msats,
  sensitiveInput,
} from '../../domain';
import { FakeWalletService } from './fake-wallet-service';

describe('FakeWalletService', () => {
  it('requires preview and an approval before joining', async () => {
    const service = new FakeWalletService({
      latencyMs: 0,
      idFactory: () => '00000000-0000-4000-8000-000000000001',
      clock: () => 1_000,
    });
    await service.open();

    await expect(
      service.federation.join({
        candidateId: candidateId('missing'),
      } as never),
    ).rejects.toMatchObject({ code: 'candidate_expired' });

    const candidate = await service.federation.preview(
      sensitiveInput('fedimint invite code'),
    );
    expect(candidate.guardianOrigins).toEqual([
      'wss://guardian-1.demo.invalid',
      'wss://guardian-2.demo.invalid',
      'wss://guardian-3.demo.invalid',
      'wss://guardian-4.demo.invalid',
    ]);
    const approval = approveFederationJoin(candidate, 1_000);
    const federation = await service.federation.join(approval);

    expect(federation.federationId).toBe(candidate.federationId);
    expect(service.getSnapshot().balanceMsats).toBe(msats(25_000_000n));
  });

  it('deduplicates a double join submission', async () => {
    let nextId = 0;
    const service = new FakeWalletService({
      latencyMs: 5,
      idFactory: () => `id-${++nextId}`,
      clock: () => 1_000,
    });
    await service.open();
    const candidate = await service.federation.preview(
      sensitiveInput('fedimint invite code'),
    );
    const approval = approveFederationJoin(candidate, 1_000);

    const first = service.federation.join(approval);
    const second = service.federation.join(approval);

    await expect(first).resolves.toEqual(await second);
    expect(nextId).toBe(2);
  });

  it('clears candidates and ignores late join completion on close', async () => {
    const service = new FakeWalletService({
      latencyMs: 20,
      idFactory: vi
        .fn()
        .mockReturnValueOnce('candidate')
        .mockReturnValueOnce('client'),
      clock: () => 1_000,
    });
    await service.open();
    const candidate = await service.federation.preview(
      sensitiveInput('fedimint invite code'),
    );
    const approval = approveFederationJoin(candidate, 1_000);
    const joining = service.federation.join(approval);

    await service.close();

    await expect(joining).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.getSnapshot().lifecycle).toBe('closed');
    expect(service.getSnapshot().activeFederation).toBeUndefined();
  });

  it('subscribes immediately and removes listeners', async () => {
    const service = new FakeWalletService({ latencyMs: 0 });
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await service.open();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('creates clearable identity material without exposing words in JSON', async () => {
    const service = new FakeWalletService({ latencyMs: 0 });
    await service.open();

    const mnemonic = await service.identity.createMnemonic();
    expect(mnemonic.wordCount).toBe(12);
    expect(JSON.stringify({ mnemonic })).not.toContain('abandon');
    const words = mnemonic.reveal();
    mnemonic.clear();
    expect(() => mnemonic.reveal()).toThrow();

    await service.identity.setMnemonic(words);
    const restored = await service.identity.revealMnemonic('settings-backup');
    expect(restored.reveal()).toEqual(words);
    restored.clear();
  });

  it('drives ecash export, cancellation, parsing, and redemption states', async () => {
    const service = await createJoinedService({
      latencyMs: 0,
      autoSettlePayments: false,
    });
    const spend = await service.ecash.createSpend(
      confirmEcashSpend(
        {
          amountMsats: msats(5_000n),
          includeFederationInvite: true,
        },
        1_000,
      ),
    );
    const rawNotes = spend.notes.reveal();

    expect(JSON.stringify({ notes: spend.notes })).not.toContain(rawNotes);
    expect(spend.operation.status).toBe('pending');
    expect(service.getSnapshot().balanceMsats).toBe(msats(24_995_000n));

    const preview = await service.ecash.parse(sensitiveInput(rawNotes));
    expect(preview).toMatchObject({
      amountMsats: msats(5_000n),
      compatible: true,
    });
    const redeem = await service.ecash.redeem(
      confirmEcashRedeem(preview, 1_000),
    );
    expect(redeem.operation.kind).toBe('ecash_receive');

    await service.ecash.requestCancellation(spend.operation.key.operationId);
    await Promise.resolve();
    expect(await service.operations.get(spend.operation.key)).toMatchObject({
      status: 'refunded',
    });
    spend.notes.clear();
  });

  it('quotes and deduplicates simulated Lightning payments', async () => {
    const service = await createJoinedService({
      latencyMs: 0,
      autoSettlePayments: false,
    });
    const receive = await service.lightning.createInvoice({
      amountMsats: msats(20_000n),
      description: 'Test invoice',
      expirySeconds: 600,
    });
    const invoice = sensitiveInput(receive.invoice.reveal());
    const preview = await service.lightning.parseInvoice(invoice);
    const quote = await service.lightning.quotePayment({
      preview,
      maximumFeeMsats: msats(5_000n),
    });
    const confirmed = confirmLightningQuote(quote, preview.fingerprint, 1_000);

    const first = await service.lightning.pay(confirmed);
    const second = await service.lightning.pay(confirmed);

    expect(second.operationId).toBe(first.operationId);
    expect(first.operation).toMatchObject({
      kind: 'lightning_send',
      status: 'pending',
      feeMsats: quote.feeMsats,
    });
    expect(
      JSON.stringify(service.getSnapshot().operations, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(invoice);
    receive.invoice.clear();
  });

  it('reports deterministic recovery progress', async () => {
    const service = new FakeWalletService({ latencyMs: 0, clock: () => 9000 });
    await service.open();
    await service.identity.createMnemonic();
    const listener = vi.fn();
    const unsubscribe = service.recovery.subscribe(listener);

    await expect(service.recovery.waitForCompletion()).resolves.toEqual({
      completedAtMs: 9000,
      recoveredModules: 2,
      pendingOperationsReconciled: 0,
    });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'complete' }),
    );
    unsubscribe();
  });
});

async function createJoinedService(options: {
  latencyMs: number;
  autoSettlePayments: boolean;
}): Promise<FakeWalletService> {
  let nextId = 0;
  const service = new FakeWalletService({
    ...options,
    clock: () => 1_000,
    idFactory: () => `id-${++nextId}`,
  });
  await service.open();
  const candidate = await service.federation.preview(
    sensitiveInput('fedimint invite code'),
  );
  await service.federation.join(approveFederationJoin(candidate, 1_000));
  return service;
}
