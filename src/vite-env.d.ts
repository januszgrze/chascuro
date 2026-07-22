/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_MARMOT_RUNTIME_PROBE?: 'true' | 'false';
  readonly VITE_WALLET_MODE?: 'fake' | 'fedimint';
  readonly VITE_TEST_WALLET_BYPASS?: 'true' | 'false';
  readonly VITE_CHAT_MODE?: 'off' | 'fake' | 'mdk';
  readonly VITE_MARMOT_RELAYS?: string;
  readonly VITE_MARMOT_ALLOW_INSECURE_LOCALHOST?: 'true' | 'false';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  __marmotRuntimeProbe?: (
    storageKeyHex: string,
  ) => Promise<import('./services/chat/mdk-runtime-rpc').MdkRuntimeInfo>;
  __marmotRelayProbe?: (
    endpoints: readonly string[],
    requiredAcks: number,
  ) => Promise<import('./services/chat/mdk-relay-rpc').MdkRelayProbeInfo>;
  __marmotRelayCatchUpProbe?: (
    endpoints: readonly string[],
  ) => Promise<
    import('./services/chat/mdk-relay-rpc').MdkRelayCatchUpProbeInfo
  >;
  __marmotRelayStateProbe?: (
    acceptedEndpoint: string,
    rejectedEndpoint: string,
    storageKeyHex: string,
  ) => Promise<import('./services/chat/mdk-relay-rpc').MdkRelayStateProbeInfo>;
  __marmotTwoProfileProbe?: (
    command: import('./services/chat/mdk-two-profile-rpc').MdkTwoProfileCommand,
  ) => Promise<
    import('./services/chat/mdk-two-profile-rpc').MdkTwoProfileResult
  >;
}
