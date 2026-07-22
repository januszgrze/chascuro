export const WALLET_ERROR_CODES = [
  'unsupported_environment',
  'crypto_unavailable',
  'storage_unavailable',
  'storage_corrupt',
  'wallet_locked',
  'wallet_busy',
  'invalid_passphrase',
  'invalid_input',
  'invalid_invite_code',
  'candidate_expired',
  'trust_required',
  'mainnet_risk_acknowledgement_required',
  'offline',
  'request_timed_out',
  'federation_unavailable',
  'wrong_network',
  'already_joined',
  'insufficient_balance',
  'invalid_ecash',
  'ecash_wrong_federation',
  'ecash_already_redeemed',
  'invoice_expired',
  'invoice_amount_missing',
  'invoice_wrong_network',
  'lnurl_unreachable',
  'lnurl_invalid_response',
  'lnurl_service_error',
  'lnurl_offer_expired',
  'lnurl_amount_out_of_range',
  'lnurl_invoice_mismatch',
  'lnurl_unsupported_success_action',
  'gateway_unavailable',
  'fee_quote_unavailable',
  'fee_limit_exceeded',
  'recovery_start_unavailable',
  'recovery_failed',
  'backup_unconfirmed',
  'another_wallet_tab_active',
  'erase_failed',
  'operation_reconciliation_required',
  'operation_failed',
  'operation_expired',
  'sdk_unavailable',
  'unsupported_feature',
  'unknown',
] as const;

export type WalletErrorCode = (typeof WALLET_ERROR_CODES)[number];

export type WalletErrorCategory =
  | 'environment'
  | 'security'
  | 'storage'
  | 'lifecycle'
  | 'input'
  | 'network'
  | 'funds'
  | 'operation'
  | 'integration'
  | 'unknown';

export interface PublicWalletError {
  readonly code: WalletErrorCode;
  readonly category: WalletErrorCategory;
  readonly retryable: boolean;
  readonly message: string;
}

type WalletErrorDefinition = Omit<PublicWalletError, 'code'>;

const ERROR_DEFINITIONS = {
  unsupported_environment: {
    category: 'environment',
    retryable: false,
    message: 'This browser environment cannot safely run the wallet.',
  },
  crypto_unavailable: {
    category: 'security',
    retryable: false,
    message: 'Required browser encryption is unavailable.',
  },
  storage_unavailable: {
    category: 'storage',
    retryable: true,
    message: 'Secure wallet storage is unavailable.',
  },
  storage_corrupt: {
    category: 'storage',
    retryable: false,
    message: 'Stored wallet data could not be read safely.',
  },
  wallet_locked: {
    category: 'lifecycle',
    retryable: true,
    message: 'Unlock the wallet to continue.',
  },
  wallet_busy: {
    category: 'lifecycle',
    retryable: true,
    message: 'The wallet is already processing another request.',
  },
  invalid_passphrase: {
    category: 'security',
    retryable: true,
    message: 'The wallet could not be unlocked.',
  },
  invalid_input: {
    category: 'input',
    retryable: true,
    message: 'The entered value is not valid.',
  },
  invalid_invite_code: {
    category: 'input',
    retryable: true,
    message: 'The federation invite code is not valid.',
  },
  candidate_expired: {
    category: 'input',
    retryable: true,
    message: 'The federation preview expired. Preview it again.',
  },
  trust_required: {
    category: 'input',
    retryable: true,
    message: 'Review and acknowledge the federation trust warning first.',
  },
  mainnet_risk_acknowledgement_required: {
    category: 'security',
    retryable: true,
    message:
      'Acknowledge the experimental mainnet and recovery warning before joining.',
  },
  offline: {
    category: 'network',
    retryable: true,
    message: 'The wallet is offline.',
  },
  request_timed_out: {
    category: 'network',
    retryable: true,
    message: 'The request timed out before it completed.',
  },
  federation_unavailable: {
    category: 'network',
    retryable: true,
    message: 'The federation is currently unavailable.',
  },
  wrong_network: {
    category: 'network',
    retryable: false,
    message: 'The federation or payment uses an unsupported Bitcoin network.',
  },
  already_joined: {
    category: 'lifecycle',
    retryable: false,
    message: 'This federation is already joined.',
  },
  insufficient_balance: {
    category: 'funds',
    retryable: false,
    message: 'The wallet balance is insufficient.',
  },
  invalid_ecash: {
    category: 'input',
    retryable: true,
    message: 'The ecash notes are not valid.',
  },
  ecash_wrong_federation: {
    category: 'input',
    retryable: false,
    message: 'The ecash belongs to a different federation.',
  },
  ecash_already_redeemed: {
    category: 'operation',
    retryable: false,
    message: 'These ecash notes have already been redeemed.',
  },
  invoice_expired: {
    category: 'input',
    retryable: false,
    message: 'The Lightning invoice has expired.',
  },
  invoice_amount_missing: {
    category: 'input',
    retryable: false,
    message: 'Amountless Lightning invoices are not supported.',
  },
  invoice_wrong_network: {
    category: 'input',
    retryable: false,
    message: 'The Lightning invoice uses a different Bitcoin network.',
  },
  lnurl_unreachable: {
    category: 'network',
    retryable: true,
    message:
      "Couldn't reach the Lightning address service. It may not support browser wallets.",
  },
  lnurl_invalid_response: {
    category: 'input',
    retryable: false,
    message: 'The Lightning address returned an unexpected response.',
  },
  lnurl_service_error: {
    category: 'input',
    retryable: true,
    message: 'The Lightning address service could not create this payment.',
  },
  lnurl_offer_expired: {
    category: 'input',
    retryable: true,
    message: 'The Lightning address details expired. Resolve it again.',
  },
  lnurl_amount_out_of_range: {
    category: 'input',
    retryable: true,
    message: 'Amount is outside what this Lightning address accepts.',
  },
  lnurl_invoice_mismatch: {
    category: 'security',
    retryable: false,
    message:
      'The Lightning address returned an invoice that did not match this payment.',
  },
  lnurl_unsupported_success_action: {
    category: 'input',
    retryable: false,
    message:
      'This payment requires a follow-up action this wallet does not support.',
  },
  gateway_unavailable: {
    category: 'network',
    retryable: true,
    message: 'No compatible Lightning gateway is available.',
  },
  fee_quote_unavailable: {
    category: 'funds',
    retryable: true,
    message: 'A safe Lightning fee quote is unavailable.',
  },
  fee_limit_exceeded: {
    category: 'funds',
    retryable: false,
    message: 'The Lightning fee exceeds the approved limit.',
  },
  recovery_start_unavailable: {
    category: 'integration',
    retryable: false,
    message: 'This SDK cannot safely start clean-profile wallet recovery yet.',
  },
  recovery_failed: {
    category: 'operation',
    retryable: true,
    message: 'Wallet recovery did not complete.',
  },
  backup_unconfirmed: {
    category: 'security',
    retryable: true,
    message: 'Confirm the recovery backup before accepting funds.',
  },
  another_wallet_tab_active: {
    category: 'lifecycle',
    retryable: true,
    message: 'Close the wallet in the other tab before continuing.',
  },
  erase_failed: {
    category: 'storage',
    retryable: true,
    message: 'The wallet could not erase all local data.',
  },
  operation_reconciliation_required: {
    category: 'operation',
    retryable: true,
    message: 'Refresh the wallet to reconcile pending activity.',
  },
  operation_failed: {
    category: 'operation',
    retryable: true,
    message: 'The wallet operation failed.',
  },
  operation_expired: {
    category: 'operation',
    retryable: true,
    message: 'The wallet operation expired.',
  },
  sdk_unavailable: {
    category: 'integration',
    retryable: true,
    message: 'The wallet engine is unavailable.',
  },
  unsupported_feature: {
    category: 'integration',
    retryable: false,
    message: 'This wallet feature is not supported.',
  },
  unknown: {
    category: 'unknown',
    retryable: false,
    message: 'The wallet encountered an unexpected error.',
  },
} as const satisfies Record<WalletErrorCode, WalletErrorDefinition>;

export function isWalletErrorCode(value: unknown): value is WalletErrorCode {
  return (
    typeof value === 'string' &&
    (WALLET_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function publicWalletError(code: WalletErrorCode): PublicWalletError {
  return Object.freeze({
    code,
    ...ERROR_DEFINITIONS[code],
  });
}

/**
 * Converts errors at an application boundary without copying arbitrary
 * messages, stack traces, or SDK data into public state.
 */
export function toPublicWalletError(value: unknown): PublicWalletError {
  if (value instanceof WalletError) {
    return value.publicError;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    isWalletErrorCode(value.code)
  ) {
    return publicWalletError(value.code);
  }

  return publicWalletError('unknown');
}

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly publicError: PublicWalletError;

  constructor(code: WalletErrorCode) {
    const publicError = publicWalletError(code);
    super(publicError.message);
    this.name = 'WalletError';
    this.code = code;
    this.publicError = publicError;
  }

  toJSON(): PublicWalletError {
    return this.publicError;
  }
}
