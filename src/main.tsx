import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';

import { WalletApp, type WalletAppProps } from './app/App';
import type { FakeChatScenario } from './services/chat/fake-chat-service';
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/geist/700.css';
import '@fontsource/geist-mono/500.css';
import './styles.css';

registerSW({
  immediate: true,
  onNeedRefresh() {
    window.dispatchEvent(new Event('wallet-pwa-update-available'));
  },
});

if (import.meta.env.VITE_MARMOT_RUNTIME_PROBE === 'true') {
  window.__marmotRuntimeProbe = async (storageKeyHex: string) => {
    if (!/^[0-9a-f]{64}$/iu.test(storageKeyHex)) {
      throw new Error('The Marmot runtime probe requires a 32-byte hex key.');
    }
    const { probeMdkRuntime } =
      await import('./services/chat/mdk-runtime-client');
    const storageKey = Uint8Array.from(
      storageKeyHex.match(/.{2}/gu) ?? [],
      (byte) => Number.parseInt(byte, 16),
    );
    try {
      return await probeMdkRuntime(storageKey);
    } finally {
      storageKey.fill(0);
    }
  };
  window.__marmotRelayProbe = async (
    endpoints: readonly string[],
    requiredAcks: number,
  ) => {
    const { probeMdkRelayPublish } =
      await import('./services/chat/mdk-relay-probe-client');
    return probeMdkRelayPublish(endpoints, requiredAcks);
  };
  window.__marmotRelayCatchUpProbe = async (endpoints: readonly string[]) => {
    const { probeMdkRelayCatchUp } =
      await import('./services/chat/mdk-relay-probe-client');
    return probeMdkRelayCatchUp(endpoints);
  };
  window.__marmotRelayStateProbe = async (
    acceptedEndpoint: string,
    rejectedEndpoint: string,
    storageKeyHex: string,
  ) => {
    if (!/^[0-9a-f]{64}$/iu.test(storageKeyHex)) {
      throw new Error(
        'The Marmot relay state probe requires a 32-byte hex key.',
      );
    }
    const { probeMdkRelayState } =
      await import('./services/chat/mdk-relay-probe-client');
    const storageKey = Uint8Array.from(
      storageKeyHex.match(/.{2}/gu) ?? [],
      (byte) => Number.parseInt(byte, 16),
    );
    try {
      return await probeMdkRelayState(
        acceptedEndpoint,
        rejectedEndpoint,
        storageKey,
      );
    } finally {
      storageKey.fill(0);
    }
  };
  window.__marmotTwoProfileProbe = async (command) => {
    const { runMdkTwoProfileCommand } =
      await import('./services/chat/mdk-two-profile-client');
    return runMdkTwoProfileCommand(command);
  };
}

const root = document.getElementById('root');

if (root === null) {
  throw new Error('Application root is missing.');
}

void bootstrapWalletApp(root);

async function bootstrapWalletApp(container: HTMLElement): Promise<void> {
  const chatDependencies = await resolveChatDependencies();
  createRoot(container).render(<WalletApp {...chatDependencies} />);
}

async function resolveChatDependencies(): Promise<Partial<WalletAppProps>> {
  const mode = import.meta.env.VITE_CHAT_MODE ?? 'off';
  if (mode !== 'off' && mode !== 'fake' && mode !== 'mdk') {
    throw new Error('VITE_CHAT_MODE must be off, fake, or mdk.');
  }
  if (
    mode === 'fake' &&
    import.meta.env.PROD &&
    import.meta.env.MODE !== 'e2e'
  ) {
    throw new Error('Fake chat cannot be included in a production build.');
  }
  if (mode === 'off') {
    return {};
  }
  const [{ EncryptedChatSessionLifecycle }, { ChatController }] =
    await Promise.all([
      import('./services/chat/chat-session-lifecycle'),
      import('./services/chat/chat-controller'),
    ]);
  const service =
    mode === 'fake'
      ? new (await import('./services/chat/fake-chat-service')).FakeChatService(
          {
            scenario: readFakeChatScenario(),
          },
        )
      : new (await import('./services/chat/mdk-chat-service')).MdkChatService({
          relayEndpoints: readMarmotRelayEndpoints(),
        });
  return {
    chatLifecycle: new EncryptedChatSessionLifecycle({ service }),
    chatController: new ChatController(service),
  };
}

function readMarmotRelayEndpoints(): readonly string[] {
  const endpoints = (import.meta.env.VITE_MARMOT_RELAYS ?? '')
    .split(',')
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
  if (endpoints.length < 1 || endpoints.length > 8) {
    throw new Error(
      'VITE_CHAT_MODE=mdk requires 1–8 comma-separated VITE_MARMOT_RELAYS.',
    );
  }
  for (const endpoint of endpoints) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('VITE_MARMOT_RELAYS contains an invalid URL.');
    }
    const insecureLocalhost =
      import.meta.env.MODE === 'e2e' &&
      import.meta.env.VITE_MARMOT_ALLOW_INSECURE_LOCALHOST === 'true' &&
      url.protocol === 'ws:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (url.protocol !== 'wss:' && !insecureLocalhost) {
      throw new Error('Marmot relay endpoints must use wss://.');
    }
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error(
        'Marmot relay endpoints cannot contain credentials or query data.',
      );
    }
  }
  return Object.freeze(endpoints);
}

function readFakeChatScenario(): FakeChatScenario {
  const known = new Set<string>([
    'empty',
    'setup-required',
    'two-groups',
    'pending-invite',
    'offline',
    'duplicate-reordered',
    'removed-member',
    'degraded-storage',
    'retryable-publish-failure',
  ]);
  const requested =
    new URLSearchParams(window.location.search).get('chat') ?? '';
  return known.has(requested) ? (requested as FakeChatScenario) : 'two-groups';
}
