import { FakeWalletService } from './fake-wallet-service';
import { FedimintWalletService } from './fedimint-wallet-service';
import type { WalletService, WalletServiceKind } from './wallet-service';

export function createWalletService(
  kind: WalletServiceKind = readConfiguredServiceKind(),
): WalletService {
  return kind === 'fedimint'
    ? new FedimintWalletService()
    : new FakeWalletService();
}

function readConfiguredServiceKind(): WalletServiceKind {
  return resolveWalletServiceKind({
    configured: import.meta.env.VITE_WALLET_MODE,
    production: import.meta.env.PROD,
    mode: import.meta.env.MODE,
  });
}

export function resolveWalletServiceKind(options: {
  readonly configured?: string;
  readonly production: boolean;
  readonly mode: string;
}): WalletServiceKind {
  const { configured, production, mode } = options;
  if (configured === 'fedimint') {
    return 'fedimint';
  }
  if (configured === 'fake') {
    if (production && mode !== 'e2e') {
      throw new Error('Fake wallet mode is unavailable in production builds.');
    }
    return 'fake';
  }

  return mode === 'e2e' || mode === 'test' ? 'fake' : 'fedimint';
}
