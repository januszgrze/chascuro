export type RecoveryPhase =
  'idle' | 'checking' | 'recovering' | 'complete' | 'failed';

export interface RecoveryStatus {
  readonly phase: RecoveryPhase;
  readonly completed: number;
  readonly total?: number;
  readonly messageCode?:
    | 'checking_modules'
    | 'recovering_modules'
    | 'reconciling_operations'
    | 'complete'
    | 'failed';
}

export interface RecoveryResult {
  readonly completedAtMs: number;
  readonly recoveredModules: number;
  readonly pendingOperationsReconciled: number;
}

export type RecoveryListener = (status: RecoveryStatus) => void;

export function recoveryStatus(
  input: RecoveryStatus,
): Readonly<RecoveryStatus> {
  if (
    !Number.isSafeInteger(input.completed) ||
    input.completed < 0 ||
    (input.total !== undefined &&
      (!Number.isSafeInteger(input.total) ||
        input.total < 0 ||
        input.completed > input.total))
  ) {
    throw new RangeError('Recovery progress is invalid.');
  }

  return Object.freeze({ ...input });
}
