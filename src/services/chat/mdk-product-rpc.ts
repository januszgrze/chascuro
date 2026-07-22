export interface MdkProductStatus {
  readonly epoch: number;
  readonly groupCount: number;
  readonly groupId: string | null;
  readonly memberCount: number;
  readonly nostrPubkey: string;
  readonly pendingPublishRecovered: boolean;
  readonly routingGroupId: string | null;
  readonly groups: readonly MdkProductGroupStatus[];
  readonly storageGeneration: number;
}

export interface MdkProductGroupStatus {
  readonly epoch: number;
  readonly groupId: string;
  readonly memberCount: number;
  readonly routingGroupId: string;
}

export interface MdkProductInvite {
  readonly id: string;
  readonly receivedAt: number;
}

export interface MdkProductReceivedMessage {
  readonly groupId: string;
  readonly id: string;
  readonly sender: string;
  readonly createdAt: number;
  readonly content: string;
}

export interface MdkProductResult extends MdkProductStatus {
  readonly eventId?: string;
  readonly eventJson?: string;
  readonly invites?: readonly MdkProductInvite[];
  readonly published?: boolean;
  readonly received?: readonly MdkProductReceivedMessage[];
}

export type MdkProductCommand =
  | {
      readonly method: 'open';
      readonly relayEndpoints: readonly string[];
      readonly storageKey: Uint8Array;
      readonly identitySecret: Uint8Array;
    }
  | { readonly method: 'initialize_identity' }
  | {
      readonly method: 'create_conversation';
      readonly targetPubkey: string;
    }
  | { readonly method: 'list_invites' }
  | { readonly method: 'accept_invite'; readonly inviteId: string }
  | { readonly method: 'leave'; readonly groupId: string }
  | {
      readonly method: 'send';
      readonly groupId: string;
      readonly content: string;
      readonly createdAt: number;
    }
  | {
      readonly method: 'retry';
      readonly eventId: string;
      readonly eventJson: string;
    }
  | { readonly method: 'sync'; readonly groupId: string }
  | { readonly method: 'status' }
  | { readonly method: 'close' };

export interface MdkProductWorkerRequest {
  readonly id: number;
  readonly command: MdkProductCommand;
}

export type MdkProductWorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: MdkProductResult;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: { readonly code: string };
    };
