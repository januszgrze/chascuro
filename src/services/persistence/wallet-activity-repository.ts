import {
  clearableSecretText,
  federationId,
  operationId,
  isTerminalOperationStatus,
  transitionOperation,
  type ClearableSecretText,
  type FederationId,
  type OperationKey,
  type WalletOperation,
} from '../../domain';
import type { EncryptedRecordStore } from './encrypted-record-store';
import {
  operationIndexRecordSchema,
  type OperationIndexRecord,
} from './schemas/operation-index-record';
import {
  PAYMENT_DEDUP_INDEX_RECORD_ID,
  paymentDedupIndexRecordSchema,
} from './schemas/payment-dedup-index-record';
import {
  persistWalletOperation,
  restoreWalletOperation,
  walletOperationRecordSchema,
} from './schemas/wallet-operation-record';
import {
  walletSecretRecordSchema,
  type WalletSecretPurpose,
} from './schemas/wallet-secret-record';

const OPERATION_INDEX_ID = 'all';

export class WalletActivityRepository {
  constructor(private readonly store: EncryptedRecordStore) {}

  async upsertOperation(observed: WalletOperation): Promise<WalletOperation> {
    const id = operationRecordId(observed.key);
    const existingRecord = await this.store.get(
      walletOperationRecordSchema,
      id,
    );
    let operation = observed;

    if (existingRecord !== undefined) {
      const existing = restoreWalletOperation(existingRecord.payload);
      const transition = transitionOperation(
        existing,
        observed.status,
        observed.updatedAtMs,
      );
      if (transition.outcome === 'rejected') {
        return existing;
      }
      if (
        transition.outcome === 'duplicate' &&
        observed.updatedAtMs < existing.updatedAtMs
      ) {
        return existing;
      }
      operation = restoreWalletOperation(
        persistWalletOperation({
          ...existing,
          ...definedOperationMetadata(observed),
          createdAtMs: existing.createdAtMs,
          status: transition.operation.status,
          updatedAtMs: Math.max(existing.updatedAtMs, observed.updatedAtMs),
        }),
      );
    }

    await this.store.put(
      walletOperationRecordSchema,
      id,
      persistWalletOperation(operation),
    );
    await this.ensureIndexed(id);
    return operation;
  }

  async getOperation(key: OperationKey): Promise<WalletOperation | undefined> {
    const record = await this.store.get(
      walletOperationRecordSchema,
      operationRecordId(key),
    );
    return record === undefined
      ? undefined
      : restoreWalletOperation(record.payload);
  }

  async listOperations(): Promise<readonly WalletOperation[]> {
    const index = await this.store.get(
      operationIndexRecordSchema,
      OPERATION_INDEX_ID,
    );
    if (index === undefined) {
      return Object.freeze([]);
    }

    const records = await Promise.all(
      index.payload.operationRecordIds.map((id) =>
        this.store.get(walletOperationRecordSchema, id),
      ),
    );
    return Object.freeze(
      records
        .filter((record) => record !== undefined)
        .map((record) => restoreWalletOperation(record.payload))
        .sort(
          (left, right) =>
            right.updatedAtMs - left.updatedAtMs ||
            right.createdAtMs - left.createdAtMs,
        ),
    );
  }

  async putSecret(
    purpose: WalletSecretPurpose,
    key: OperationKey,
    secret: ClearableSecretText,
  ): Promise<void> {
    await this.store.put(
      walletSecretRecordSchema,
      secretRecordId(purpose, key),
      {
        version: 1,
        purpose,
        federationId: key.federationId,
        operationId: key.operationId,
        value: secret.reveal(),
      },
    );
  }

  async getSecret(
    purpose: WalletSecretPurpose,
    key: OperationKey,
  ): Promise<ClearableSecretText | undefined> {
    const record = await this.store.get(
      walletSecretRecordSchema,
      secretRecordId(purpose, key),
    );
    return record === undefined
      ? undefined
      : clearableSecretText(record.payload.value);
  }

  async deleteSecret(
    purpose: WalletSecretPurpose,
    key: OperationKey,
  ): Promise<boolean> {
    return this.store.delete(
      walletSecretRecordSchema,
      secretRecordId(purpose, key),
    );
  }

  async deleteTerminalSecret(
    purpose: WalletSecretPurpose,
    operation: WalletOperation,
  ): Promise<boolean> {
    return isTerminalOperationStatus(operation.status)
      ? this.deleteSecret(purpose, operation.key)
      : false;
  }

  async hasEcashRedemptionFingerprint(fingerprint: string): Promise<boolean> {
    return (
      (await this.getEcashRedemptionOperationKey(fingerprint)) !== undefined
    );
  }

  async getEcashRedemptionOperationKey(
    fingerprint: string,
  ): Promise<OperationKey | undefined> {
    const index = await this.store.get(
      paymentDedupIndexRecordSchema,
      PAYMENT_DEDUP_INDEX_RECORD_ID,
    );
    const entry = index?.payload.ecashRedemptions.find(
      (candidate) => candidate.fingerprint === fingerprint,
    );
    return entry === undefined
      ? undefined
      : Object.freeze({
          federationId: federationId(entry.federationId),
          operationId: operationId(entry.operationId),
        });
  }

  async recordEcashRedemptionFingerprint(
    fingerprint: string,
    key: OperationKey,
    submittedAtMs: number,
  ): Promise<void> {
    const existing = await this.store.get(
      paymentDedupIndexRecordSchema,
      PAYMENT_DEDUP_INDEX_RECORD_ID,
    );
    const withoutFingerprint = (
      existing?.payload.ecashRedemptions ?? []
    ).filter((entry) => entry.fingerprint !== fingerprint);
    await this.store.put(
      paymentDedupIndexRecordSchema,
      PAYMENT_DEDUP_INDEX_RECORD_ID,
      {
        version: 1,
        ecashRedemptions: [
          ...withoutFingerprint,
          {
            fingerprint,
            federationId: key.federationId,
            operationId: key.operationId,
            submittedAtMs,
          },
        ],
      },
    );
  }

  async reserveEcashRedemptionFingerprint(
    fingerprint: string,
    federation: FederationId,
    submittedAtMs: number,
  ): Promise<void> {
    if (await this.hasEcashRedemptionFingerprint(fingerprint)) {
      return;
    }
    await this.recordEcashRedemptionFingerprint(
      fingerprint,
      {
        federationId: federation,
        operationId: operationId(`pending-redemption:${fingerprint}`),
      },
      submittedAtMs,
    );
  }

  private async ensureIndexed(operationId: string): Promise<void> {
    const existing = await this.store.get(
      operationIndexRecordSchema,
      OPERATION_INDEX_ID,
    );
    if (existing?.payload.operationRecordIds.includes(operationId)) {
      return;
    }

    const next: OperationIndexRecord = {
      version: 1,
      operationRecordIds: Object.freeze([
        ...(existing?.payload.operationRecordIds ?? []),
        operationId,
      ]),
    };
    await this.store.put(operationIndexRecordSchema, OPERATION_INDEX_ID, next);
  }
}

function definedOperationMetadata(
  operation: WalletOperation,
): Partial<WalletOperation> {
  return {
    key: operation.key,
    kind: operation.kind,
    status: operation.status,
    createdAtMs: operation.createdAtMs,
    updatedAtMs: operation.updatedAtMs,
    ...(operation.direction === undefined
      ? {}
      : { direction: operation.direction }),
    ...(operation.amountMsats === undefined
      ? {}
      : { amountMsats: operation.amountMsats }),
    ...(operation.feeMsats === undefined
      ? {}
      : { feeMsats: operation.feeMsats }),
    ...(operation.expiresAtMs === undefined
      ? {}
      : { expiresAtMs: operation.expiresAtMs }),
    ...(operation.localDescription === undefined
      ? {}
      : { localDescription: operation.localDescription }),
    ...(operation.guidanceCode === undefined
      ? {}
      : { guidanceCode: operation.guidanceCode }),
    ...(operation.secretRecordRef === undefined
      ? {}
      : { secretRecordRef: operation.secretRecordRef }),
    ...(operation.reconciliationCursor === undefined
      ? {}
      : { reconciliationCursor: operation.reconciliationCursor }),
    ...(operation.schemaVersion === undefined
      ? {}
      : { schemaVersion: operation.schemaVersion }),
    ...(operation.adapterVersion === undefined
      ? {}
      : { adapterVersion: operation.adapterVersion }),
  };
}

export function operationRecordId(key: OperationKey): string {
  return `${encodeURIComponent(key.federationId)}:${encodeURIComponent(
    key.operationId,
  )}`;
}

export function secretRecordId(
  purpose: WalletSecretPurpose,
  key: OperationKey,
): string {
  return `${purpose}:${operationRecordId(key)}`;
}
