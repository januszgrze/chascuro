import type { ChatAvailability, FederationCandidate } from '../domain';
import type { ChatController } from '../services/chat/chat-controller';
import type { ChatSessionLifecycle } from '../services/chat/chat-session-lifecycle';
import type { LnurlPayResolver } from '../services/lnurl';
import type { WalletDataEraseReport } from '../services/persistence/erase-wallet-data';
import type { WalletSecuritySettings } from '../services/persistence/schemas/wallet-settings-record';
import type { VaultOptions } from '../services/persistence/vault';
import type { VaultStore } from '../services/persistence/vault-store';
import type {
  CapabilityName,
  CapabilityReport,
} from '../services/security/capabilities';
import type {
  WalletService,
  WalletServiceKind,
  WalletSnapshot,
} from '../services/wallet';

export const MIN_PASSPHRASE_LENGTH = 4;

export type WalletAppPhase =
  | 'booting'
  | 'unsupported'
  | 'setup'
  | 'locked'
  | 'opening'
  | 'identity'
  | 'invite'
  | 'review'
  | 'home'
  | 'locking';

export type WalletAppAction =
  | 'setup'
  | 'unlock'
  | 'identity-create'
  | 'identity-restore'
  | 'backup-confirm'
  | 'preview'
  | 'join'
  | 'refresh'
  | 'erase'
  | 'lock';

export interface WalletAppState {
  readonly phase: WalletAppPhase;
  readonly serviceKind: WalletServiceKind;
  readonly disposableTestWallet: boolean;
  readonly walletSnapshot: WalletSnapshot;
  readonly chatAvailability: ChatAvailability;
  readonly chat?: ChatController;
  readonly missingCapabilities: readonly CapabilityName[];
  readonly candidate?: FederationCandidate;
  readonly securitySettings: WalletSecuritySettings;
  readonly busy?: WalletAppAction;
  readonly error?: string;
  readonly eraseReport?: WalletDataEraseReport;
}

export type WalletFeatureResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface WalletAppDependencies {
  walletService?: WalletService;
  walletServiceFactory?: (kind?: WalletServiceKind) => WalletService;
  vaultStore?: VaultStore;
  capabilityReport?: CapabilityReport;
  vaultOptions?: VaultOptions;
  now?: () => number;
  walletDataEraser?: (
    storage: VaultStore,
  ) => Promise<WalletDataEraseReport | void>;
  chatLifecycle?: ChatSessionLifecycle;
  chatController?: ChatController;
  walletOwner?: WalletOwnership;
  inactivityLock?: SessionInactivityLock;
  visibilitySource?: WalletVisibilitySource | null;
  disposableTestWallet?: boolean;
  lnurlPayResolver?: LnurlPayResolver;
}

export interface WalletOwnership {
  acquire(): Promise<void>;
  release(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SessionInactivityLock {
  arm(): number;
  disarm(): void;
  dispose(): void;
  configure?(settings: {
    inactivityTimeoutMs: number | null;
    backgroundTimeoutMs: number | null;
  }): void;
}

export interface WalletVisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: EventListener): void;
  removeEventListener(type: 'visibilitychange', listener: EventListener): void;
}
