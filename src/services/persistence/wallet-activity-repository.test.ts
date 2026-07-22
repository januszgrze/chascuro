import { webcrypto } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  clearableSecretText,
  createWalletOperation,
  federationId,
  msats,
  operationId,
} from '../../domain';
import {
  EncryptedRecordStore,
  encryptedRecordStorageId,
} from './encrypted-record-store';
import {
  WalletActivityRepository,
  operationRecordId,
  secretRecordId,
} from './wallet-activity-repository';
import { walletOperationRecordSchema } from './schemas/wallet-operation-record';
import {
  PAYMENT_DEDUP_INDEX_RECORD_ID,
  paymentDedupIndexRecordSchema,
} from './schemas/payment-dedup-index-record';
import { walletSecretRecordSchema } from './schemas/wallet-secret-record';
import { MemoryVaultStore } from './vault-store';

const TEST_CRYPTO = webcrypto as unknown as Crypto;

function operation(status: 'pending' | 'settled', updatedAtMs: number) {
  return createWalletOperation({
    key: {
      federationId: federationId('fed-a'),
      operationId: operationId('operation-a'),
    },
    kind: 'ecash_send',
    direction: 'outgoing',
    status,
    amountMsats: msats(5_000n),
    createdAtMs: 1_000,
    updatedAtMs,
    schemaVersion: 2,
    adapterVersion: 'test-adapter',
  });
}

async function repository() {
  const storage = new MemoryVaultStore();
  const store = await EncryptedRecordStore.create({
    storage,
    passphrase: 'correct horse battery staple',
    crypto: TEST_CRYPTO,
    vaultOptions: { iterations: 1 },
  });
  return {
    storage,
    store,
    repository: new WalletActivityRepository(store),
  };
}

describe('WalletActivityRepository', () => {
  it('round-trips bigint operation records through an encrypted index', async () => {
    const harness = await repository();
    const current = operation('pending', 2_000);

    await harness.repository.upsertOperation(current);

    expect(await harness.repository.listOperations()).toEqual([current]);
    expect(await harness.repository.getOperation(current.key)).toEqual(current);
  });

  it('does not allow persisted terminal activity to regress', async () => {
    const harness = await repository();
    const settled = operation('settled', 3_000);
    await harness.repository.upsertOperation(settled);

    await harness.repository.upsertOperation(operation('pending', 4_000));

    expect(await harness.repository.getOperation(settled.key)).toMatchObject({
      status: 'settled',
      updatedAtMs: 3_000,
    });
  });

  it('preserves locally persisted metadata when SDK reconciliation advances status', async () => {
    const harness = await repository();
    const rich = createWalletOperation({
      ...operation('pending', 2_000),
      expiresAtMs: 60_000,
      localDescription: 'Coffee reimbursement',
      secretRecordRef: 'secret:lightning-invoice:operation-a',
    });
    await harness.repository.upsertOperation(rich);

    const sparseSdkObservation = createWalletOperation({
      key: rich.key,
      kind: rich.kind,
      direction: rich.direction,
      status: 'settled',
      amountMsats: rich.amountMsats,
      createdAtMs: rich.createdAtMs,
      updatedAtMs: 3_000,
    });
    await harness.repository.upsertOperation(sparseSdkObservation);

    expect(await harness.repository.getOperation(rich.key)).toMatchObject({
      status: 'settled',
      expiresAtMs: 60_000,
      localDescription: 'Coffee reimbursement',
      secretRecordRef: 'secret:lightning-invoice:operation-a',
    });
  });

  it('keeps bearer payloads in a separate encrypted secret record', async () => {
    const harness = await repository();
    const current = operation('pending', 2_000);
    const rawSecret = 'fedimint-ecash:5000:fed-a:secret';
    const secret = clearableSecretText(rawSecret);
    await harness.repository.upsertOperation(current);
    await harness.repository.putSecret('ecash-export', current.key, secret);

    const activityEnvelope = await harness.storage.get(
      encryptedRecordStorageId(
        'primary-wallet',
        walletOperationRecordSchema.kind,
        operationRecordId(current.key),
      ),
    );
    const secretEnvelope = await harness.storage.get(
      encryptedRecordStorageId(
        'primary-wallet',
        walletSecretRecordSchema.kind,
        secretRecordId('ecash-export', current.key),
      ),
    );

    expect(JSON.stringify(activityEnvelope)).not.toContain(rawSecret);
    expect(JSON.stringify(secretEnvelope)).not.toContain(rawSecret);
    const restored = await harness.repository.getSecret(
      'ecash-export',
      current.key,
    );
    expect(restored?.reveal()).toBe(rawSecret);
    restored?.clear();
  });

  it('persists ecash redemption fingerprints only inside the encrypted index', async () => {
    const harness = await repository();
    const current = operation('pending', 2_000);
    const fingerprint = 'sha256:high-entropy-fingerprint';

    expect(
      await harness.repository.hasEcashRedemptionFingerprint(fingerprint),
    ).toBe(false);
    await harness.repository.recordEcashRedemptionFingerprint(
      fingerprint,
      current.key,
      2_000,
    );

    expect(
      await harness.repository.hasEcashRedemptionFingerprint(fingerprint),
    ).toBe(true);
    const envelope = await harness.storage.get(
      encryptedRecordStorageId(
        'primary-wallet',
        paymentDedupIndexRecordSchema.kind,
        PAYMENT_DEDUP_INDEX_RECORD_ID,
      ),
    );
    expect(JSON.stringify(envelope)).not.toContain(fingerprint);
  });

  it('reserves an ecash fingerprint before submission and replaces the pending marker', async () => {
    const harness = await repository();
    const current = operation('pending', 2_000);
    const fingerprint = 'sha256:reserved-fingerprint';

    await harness.repository.reserveEcashRedemptionFingerprint(
      fingerprint,
      current.key.federationId,
      1_500,
    );
    expect(
      await harness.repository.hasEcashRedemptionFingerprint(fingerprint),
    ).toBe(true);

    await harness.repository.recordEcashRedemptionFingerprint(
      fingerprint,
      current.key,
      2_000,
    );
    const index = await harness.store.get(
      paymentDedupIndexRecordSchema,
      PAYMENT_DEDUP_INDEX_RECORD_ID,
    );
    expect(index?.payload.ecashRedemptions).toEqual([
      {
        fingerprint,
        federationId: 'fed-a',
        operationId: 'operation-a',
        submittedAtMs: 2_000,
      },
    ]);
  });
});
