export type MdkTwoProfileRole = 'alice' | 'bob';

export interface MdkTwoProfileStatus {
  readonly epoch: number;
  readonly groupCount: number;
  readonly groupId: string | null;
  readonly memberCount: number;
  readonly nostrPubkey: string;
  readonly pendingPublishRecovered: boolean;
  readonly role: MdkTwoProfileRole;
  readonly routingGroupId: string | null;
  readonly storageGeneration: number;
}

export interface MdkTwoProfileResult extends MdkTwoProfileStatus {
  readonly eventId?: string;
  readonly received?: readonly string[];
}

export type MdkTwoProfileCommand =
  | {
      readonly method: 'open';
      readonly relayEndpoint: string;
      readonly role: MdkTwoProfileRole;
      readonly storageKeyHex: string;
    }
  | { readonly method: 'publish_key_package' }
  | { readonly method: 'create_group' }
  | { readonly method: 'join' }
  | { readonly content: string; readonly method: 'send' }
  | { readonly method: 'sync' }
  | { readonly method: 'status' }
  | { readonly method: 'close' };

export interface MdkTwoProfileWorkerRequest {
  readonly command:
    | (Omit<
        Extract<MdkTwoProfileCommand, { method: 'open' }>,
        'storageKeyHex'
      > & { readonly storageKey: Uint8Array })
    | Exclude<MdkTwoProfileCommand, { method: 'open' }>;
  readonly id: number;
}

export type MdkTwoProfileWorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: MdkTwoProfileResult;
    }
  | {
      readonly error: { readonly message: string };
      readonly id: number;
      readonly ok: false;
    };
