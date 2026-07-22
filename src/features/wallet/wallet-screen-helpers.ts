import { useEffect, useState } from 'react';

import {
  isTerminalOperationStatus,
  type OperationKey,
  type WalletOperation,
} from '../../domain';

export function operationLabel(operation: WalletOperation): string {
  switch (operation.kind) {
    case 'ecash_receive':
      return 'Ecash received';
    case 'ecash_send':
      return 'Ecash sent';
    case 'lightning_receive':
      return 'Lightning received';
    case 'lightning_send':
      return 'Lightning sent';
    case 'federation_join':
      return 'Federation joined';
    case 'unknown':
      return 'Wallet operation';
  }
}

export const ACTIVITY_PAGE_SIZE = 20;

export const INACTIVITY_TIMEOUT_OPTIONS = Object.freeze([
  { ms: 60_000, label: '1 minute' },
  { ms: 5 * 60_000, label: '5 minutes' },
  { ms: 15 * 60_000, label: '15 minutes' },
  { ms: 30 * 60_000, label: '30 minutes' },
  { ms: null, label: 'Never' },
]);

export const BACKGROUND_TIMEOUT_OPTIONS = Object.freeze([
  { ms: 5_000, label: '5 seconds' },
  { ms: 30_000, label: '30 seconds' },
  { ms: 60_000, label: '1 minute' },
  { ms: 5 * 60_000, label: '5 minutes' },
  { ms: null, label: 'Never' },
]);

export function findOperation(
  operations: readonly WalletOperation[],
  key: OperationKey,
): WalletOperation | undefined {
  return operations.find(
    (operation) =>
      operation.key.federationId === key.federationId &&
      operation.key.operationId === key.operationId,
  );
}

export function useCurrentTime(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    const update = () => setNowMs(Date.now());
    const initialUpdate = window.setTimeout(update, 0);
    const interval = window.setInterval(update, 1_000);
    return () => {
      window.clearTimeout(initialUpdate);
      window.clearInterval(interval);
    };
  }, [active]);

  return nowMs;
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds
        .toString()
        .padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function lightningInvoiceUnavailableTitle(
  operation: WalletOperation | undefined,
): string {
  if (operation?.status === 'settled') {
    return 'Invoice paid.';
  }
  if (operation?.status === 'cancelled') {
    return 'Invoice cancelled.';
  }
  if (operation?.status === 'failed') {
    return 'Invoice failed.';
  }
  return 'Invoice expired or no longer payable.';
}

export function isSecretRecoveryRelevant(
  operation: WalletOperation,
  nowMs: number,
): boolean {
  if (operation.kind === 'ecash_send') {
    return operation.status !== 'refunded';
  }

  return (
    operation.kind === 'lightning_receive' &&
    !isTerminalOperationStatus(operation.status) &&
    operation.expiresAtMs !== undefined &&
    nowMs < operation.expiresAtMs
  );
}

export function formatOperationDirection(operation: WalletOperation): string {
  const direction =
    operation.direction ??
    (operation.kind === 'ecash_receive' ||
    operation.kind === 'lightning_receive'
      ? 'incoming'
      : operation.kind === 'ecash_send' || operation.kind === 'lightning_send'
        ? 'outgoing'
        : operation.kind === 'federation_join'
          ? 'neutral'
          : 'unknown');
  return direction.replaceAll('_', ' ');
}

export function formatOperationStatus(
  status: WalletOperation['status'],
): string {
  return status.replaceAll('_', ' ');
}

export function timeoutSelectValue(value: number | null): string {
  return value === null ? 'never' : value.toString(10);
}

export function parseTimeoutSelectValue(value: string): number | null {
  if (value === 'never') {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 5_000 ? parsed : null;
}
