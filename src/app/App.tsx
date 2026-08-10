import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  IdentitySetupScreen,
  type IdentityStartMode,
} from '../features/identity/IdentitySetupScreen';
import { FederationInviteScreen } from '../features/onboarding/FederationInviteScreen';
import { FederationReviewScreen } from '../features/onboarding/FederationReviewScreen';
import { ReadyScreen } from '../features/onboarding/ReadyScreen';
import { SetupScreen } from '../features/onboarding/SetupScreen';
import { UnlockScreen } from '../features/onboarding/UnlockScreen';
import { WelcomeScreen } from '../features/onboarding/WelcomeScreen';
import { ChatApp } from '../features/chat/ChatApp';
import { ChatProvider } from '../features/chat/ChatProvider';
import {
  INITIAL_CHAT_LOCATION,
  resolveChatLocation,
  type ChatLocation,
} from '../features/chat/chat-route';
import { ScreenFrame } from '../features/shared/ScreenFrame';
import {
  runViewTransition,
  type ViewTransitionDirection,
} from '../features/shared/screen-transition';
import {
  BootScreen,
  LockingScreen,
  OpeningScreen,
  UnsupportedScreen,
} from '../features/status/StatusScreens';
import { HomeScreen } from '../features/wallet/HomeScreen';
import {
  WalletAppController,
  type WalletAppDependencies,
} from './wallet-app-controller';

export type WalletAppProps = WalletAppDependencies;

const DISPOSABLE_TEST_PASSPHRASE = 'disposable-fedimint-browser-test-wallet';

export function WalletApp(dependencies: WalletAppProps) {
  const [controller] = useState(() => new WalletAppController(dependencies));
  const pendingOnboardingTransition = useRef<
    ViewTransitionDirection | undefined
  >(undefined);
  const subscribe = useMemo(
    () => (listener: () => void) => {
      let previousPhase = controller.getState().phase;
      return controller.subscribe(() => {
        const nextPhase = controller.getState().phase;
        const direction =
          nextPhase !== previousPhase &&
          (nextPhase === 'identity' ||
            nextPhase === 'invite' ||
            nextPhase === 'review' ||
            nextPhase === 'home')
            ? pendingOnboardingTransition.current
            : undefined;
        previousPhase = nextPhase;

        if (direction === undefined) {
          listener();
          return;
        }

        pendingOnboardingTransition.current = undefined;
        runViewTransition(direction, listener);
      });
    },
    [controller],
  );
  const [setupStep, setSetupStep] = useState<'welcome' | 'identity' | 'pin'>(
    'welcome',
  );
  const [identityStartMode, setIdentityStartMode] =
    useState<IdentityStartMode>('choice');
  const [showReady, setShowReady] = useState(false);
  const [chatLocation, setChatLocation] = useState<ChatLocation | null>(null);
  const [restoreChatFocus, setRestoreChatFocus] = useState(false);
  const state = useSyncExternalStore(
    subscribe,
    controller.getState,
    controller.getState,
  );

  async function runOnboardingControllerTransition(
    direction: ViewTransitionDirection,
    update: () => Promise<void>,
  ): Promise<void> {
    pendingOnboardingTransition.current = direction;
    try {
      await update();
    } finally {
      if (pendingOnboardingTransition.current === direction) {
        pendingOnboardingTransition.current = undefined;
      }
    }
  }

  // Reset chat navigation whenever the chat controller identity changes (a new
  // unlocked session, or cleared on lock) so no selection leaks across sessions.
  const [chatBinding, setChatBinding] = useState(state.chat);
  if (chatBinding !== state.chat) {
    setChatBinding(state.chat);
    setChatLocation(null);
  }

  useEffect(() => {
    if (!restoreChatFocus) {
      return;
    }
    const handle = setTimeout(() => setRestoreChatFocus(false), 0);
    return () => clearTimeout(handle);
  }, [restoreChatFocus]);

  useEffect(() => {
    void controller.boot();
    return () => {
      void controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    if (
      !state.disposableTestWallet ||
      state.busy !== undefined ||
      state.error !== undefined
    ) {
      return;
    }

    if (state.phase === 'setup') {
      void controller.setup(DISPOSABLE_TEST_PASSPHRASE);
    } else if (state.phase === 'locked') {
      void controller.unlock(DISPOSABLE_TEST_PASSPHRASE);
    } else if (state.phase === 'identity') {
      void controller.createDisposableTestIdentity();
    }
  }, [
    controller,
    state.busy,
    state.disposableTestWallet,
    state.error,
    state.phase,
  ]);

  const shouldShowWelcome =
    state.phase === 'setup' &&
    !state.disposableTestWallet &&
    setupStep === 'welcome';
  const shouldShowSetupIdentity =
    state.phase === 'setup' &&
    !state.disposableTestWallet &&
    setupStep === 'identity';
  const shouldShowReady = showReady && state.phase === 'home';
  const isOnboardingPhase =
    shouldShowWelcome ||
    shouldShowSetupIdentity ||
    shouldShowReady ||
    state.phase === 'setup' ||
    state.phase === 'identity' ||
    state.phase === 'invite' ||
    state.phase === 'review';
  const isDarkStatusPhase =
    state.phase === 'booting' ||
    state.phase === 'opening' ||
    state.phase === 'locking' ||
    state.phase === 'unsupported';
  const isOnboardingTransitionPhase =
    isOnboardingPhase ||
    (state.phase === 'opening' &&
      pendingOnboardingTransition.current !== undefined);

  let content;
  switch (state.phase) {
    case 'booting':
      content = <BootScreen />;
      break;
    case 'unsupported':
      content = (
        <UnsupportedScreen
          error={state.error}
          missingCapabilities={state.missingCapabilities}
        />
      );
      break;
    case 'setup':
      content = shouldShowWelcome ? (
        <WelcomeScreen
          mode="install"
          error={state.error}
          onInstallConfirmed={() =>
            runViewTransition('forward', () => setSetupStep('identity'))
          }
          onCreate={() => {
            runViewTransition('forward', () => {
              setIdentityStartMode('choice');
              setSetupStep('identity');
            });
          }}
          onRestore={() => {
            runViewTransition('forward', () => {
              setIdentityStartMode('restore');
              setSetupStep('identity');
            });
          }}
        />
      ) : shouldShowSetupIdentity ? (
        <IdentitySetupScreen
          startMode={identityStartMode}
          busy={
            state.busy === 'identity-create' ||
            state.busy === 'identity-restore' ||
            state.busy === 'backup-confirm'
          }
          error={state.error}
          onCreate={() => controller.createIdentity()}
          onConfirmBackup={async () => {
            await controller.confirmIdentityBackup();
            if (controller.getState().error === undefined) {
              runViewTransition('forward', () => setSetupStep('pin'));
            }
          }}
          onRestore={async (words) => {
            await controller.restoreIdentity(words);
            if (controller.getState().error === undefined) {
              runViewTransition('forward', () => setSetupStep('pin'));
            }
          }}
        />
      ) : (
        <SetupScreen
          busy={state.busy === 'setup'}
          error={state.error}
          onSetup={(passphrase) =>
            runOnboardingControllerTransition('forward', () =>
              controller.setup(passphrase),
            )
          }
        />
      );
      break;
    case 'locked':
      content = (
        <UnlockScreen
          busy={state.busy === 'unlock' || state.busy === 'erase'}
          error={state.error}
          onUnlock={(passphrase) => controller.unlock(passphrase)}
          onCreateNewWallet={() => {
            void controller.startNewWalletFromLocked().then((result) => {
              if (result.ok) {
                setSetupStep('welcome');
                setIdentityStartMode('choice');
                setShowReady(false);
              }
            });
          }}
        />
      );
      break;
    case 'opening':
      content = <OpeningScreen />;
      break;
    case 'identity':
      content = (
        <IdentitySetupScreen
          startMode={identityStartMode}
          busy={
            state.busy === 'identity-create' ||
            state.busy === 'identity-restore' ||
            state.busy === 'backup-confirm'
          }
          error={state.error}
          onCreate={() => controller.createIdentity()}
          onConfirmBackup={() =>
            runOnboardingControllerTransition('forward', () =>
              controller.confirmIdentityBackup(),
            )
          }
          onRestore={(words) =>
            runOnboardingControllerTransition('forward', () =>
              controller.restoreIdentity(words),
            )
          }
        />
      );
      break;
    case 'invite':
      content = (
        <FederationInviteScreen
          busy={state.busy === 'preview'}
          error={state.error}
          onPreview={(inviteCode) =>
            runOnboardingControllerTransition('forward', () =>
              controller.previewFederation(inviteCode),
            )
          }
          onLock={() => controller.lock()}
        />
      );
      break;
    case 'review':
      content =
        state.candidate === undefined ? (
          <FederationInviteScreen
            busy={false}
            error={state.error}
            onPreview={(inviteCode) =>
              runOnboardingControllerTransition('forward', () =>
                controller.previewFederation(inviteCode),
              )
            }
            onLock={() => controller.lock()}
          />
        ) : (
          <FederationReviewScreen
            candidate={state.candidate}
            busy={state.busy === 'join'}
            error={state.error}
            onBack={() =>
              runViewTransition('back', () => controller.returnToInvite())
            }
            onJoin={async (trustAcknowledged, mainnetRiskAcknowledged) => {
              setShowReady(true);
              await runOnboardingControllerTransition('forward', () =>
                controller.joinFederation(
                  trustAcknowledged,
                  mainnetRiskAcknowledged,
                ),
              );
              if (controller.getState().phase !== 'home') {
                setShowReady(false);
              }
            }}
            onLock={() => controller.lock()}
          />
        );
      break;
    case 'home':
      content = shouldShowReady ? (
        <ReadyScreen
          onContinue={() =>
            runViewTransition('forward', () => setShowReady(false))
          }
        />
      ) : state.chat !== undefined && chatLocation !== null ? (
        <ChatProvider
          controller={state.chat}
          location={chatLocation}
          onNavigate={(next) => setChatLocation(resolveChatLocation(next))}
          onExit={() => {
            setChatLocation(null);
            setRestoreChatFocus(true);
          }}
          walletPayments={{
            operations: state.walletSnapshot.operations,
            send: (conversationId, amountSats) =>
              controller.sendChatPayment(conversationId, amountSats),
            claim: (paymentId) => controller.claimChatPayment(paymentId),
          }}
        >
          <ChatApp />
        </ChatProvider>
      ) : (
        <HomeScreen
          onOpenChat={
            state.chat !== undefined
              ? () => {
                  setRestoreChatFocus(false);
                  setChatLocation(INITIAL_CHAT_LOCATION);
                }
              : undefined
          }
          autoFocusChat={restoreChatFocus}
          snapshot={state.walletSnapshot}
          securitySettings={state.securitySettings}
          refreshing={state.busy === 'refresh'}
          error={state.error}
          onRefresh={() => controller.refreshBalance()}
          onLock={() => controller.lock()}
          onParseEcash={(rawNotes) => controller.parseEcash(rawNotes)}
          onRedeemEcash={(preview) => controller.redeemEcash(preview)}
          onCreateEcashSpend={(amountSats) =>
            controller.createEcashSpend(amountSats)
          }
          onCreateLightningInvoice={(amountSats, description) =>
            controller.createLightningInvoice(amountSats, description)
          }
          onQuoteLightningPayment={(invoice, maximumFeeSats) =>
            controller.quoteLightningPayment(invoice, maximumFeeSats)
          }
          onResolveLnurlPay={(input) => controller.resolveLnurlPay(input)}
          onQuoteLnurlPayment={(offerId, amountSats, maximumFeeSats) =>
            controller.quoteLnurlPayment(offerId, amountSats, maximumFeeSats)
          }
          onPayLightningQuote={(preview, quote) =>
            controller.payLightningQuote(preview, quote)
          }
          onReconcile={() => controller.reconcileOperations()}
          onRevealMnemonic={() => controller.revealMnemonic()}
          onRecoverEcashExport={(key) => controller.recoverEcashExport(key)}
          onRecoverLightningInvoice={(key) =>
            controller.recoverLightningInvoice(key)
          }
          onUpdateSecuritySettings={(
            inactivityTimeoutMs,
            backgroundTimeoutMs,
          ) =>
            controller.updateSecuritySettings(
              inactivityTimeoutMs,
              backgroundTimeoutMs,
            )
          }
          onErase={async (typedConfirmation) => {
            const result = await controller.eraseWallet(typedConfirmation);
            if (result.ok) {
              setSetupStep('welcome');
              setIdentityStartMode('choice');
              setShowReady(false);
            }
            return result;
          }}
        />
      );
      break;
    case 'locking':
      content = <LockingScreen />;
      break;
  }

  return (
    <ScreenFrame
      serviceKind={state.serviceKind}
      disposableTestWallet={state.disposableTestWallet}
      busy={state.busy !== undefined}
      chrome={
        isOnboardingPhase ||
        state.phase === 'home' ||
        state.phase === 'locked' ||
        isDarkStatusPhase
          ? 'none'
          : 'default'
      }
      surface={shouldShowWelcome || isDarkStatusPhase ? 'dark' : 'light'}
      transition={isOnboardingTransitionPhase ? 'onboarding' : undefined}
    >
      {content}
    </ScreenFrame>
  );
}
