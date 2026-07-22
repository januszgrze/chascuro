export type SafeEventCode =
  | 'app_started'
  | 'wallet_opened'
  | 'wallet_locked'
  | 'federation_preview_started'
  | 'federation_preview_finished'
  | 'federation_join_started'
  | 'federation_join_finished'
  | 'balance_refresh_started'
  | 'balance_refresh_finished'
  | 'operation_rejected';

export type SafeErrorClass =
  | 'aborted'
  | 'invalid_input'
  | 'network'
  | 'storage'
  | 'unsupported'
  | 'wallet'
  | 'unknown';

export interface SafeLogEntry {
  code: SafeEventCode;
  errorClass?: SafeErrorClass;
  result?: 'failure' | 'success';
}

export type SafeLogSink = (entry: Readonly<SafeLogEntry>) => void;

export interface SafeLogger {
  event(entry: SafeLogEntry): void;
}

export function createSafeLogger(sink: SafeLogSink = () => {}): SafeLogger {
  return {
    event(entry) {
      sink(
        Object.freeze({
          code: entry.code,
          ...(entry.errorClass === undefined
            ? {}
            : { errorClass: entry.errorClass }),
          ...(entry.result === undefined ? {} : { result: entry.result }),
        }),
      );
    },
  };
}

export function classifyError(error: unknown): SafeErrorClass {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'aborted';
  }

  if (error instanceof DOMException) {
    if (
      error.name === 'QuotaExceededError' ||
      error.name === 'InvalidStateError'
    ) {
      return 'storage';
    }

    if (error.name === 'NetworkError') {
      return 'network';
    }
  }

  return 'unknown';
}
