export type ChatErrorCode =
  | 'locked'
  | 'offline'
  | 'relay_unavailable'
  | 'storage_unavailable'
  | 'storage_corrupt'
  | 'identity_unavailable'
  | 'invite_invalid'
  | 'group_out_of_sync'
  | 'unsupported_message'
  | 'removed_member'
  | 'invalid_input'
  | 'internal';

const PUBLIC_CHAT_MESSAGES: Readonly<Record<ChatErrorCode, string>> =
  Object.freeze({
    locked: 'Chat is locked.',
    offline: 'Chat is offline. Try again when a connection is available.',
    relay_unavailable: 'Chat relays are temporarily unavailable.',
    storage_unavailable: 'Chat storage is unavailable.',
    storage_corrupt: 'Chat data could not be opened safely.',
    identity_unavailable: 'A chat identity is not available.',
    invite_invalid: 'This chat invitation is invalid or expired.',
    group_out_of_sync:
      'This conversation needs to synchronize before continuing.',
    unsupported_message: 'This message type is not supported.',
    removed_member: 'You are no longer a member of this conversation.',
    invalid_input: 'Check the chat details and try again.',
    internal: 'Chat could not complete that request.',
  });

export class ChatError extends Error {
  readonly code: ChatErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ChatErrorCode,
    options: ErrorOptions & { readonly retryable?: boolean } = {},
  ) {
    super(PUBLIC_CHAT_MESSAGES[code], options);
    this.name = 'ChatError';
    this.code = code;
    this.retryable = options.retryable ?? isRetryableChatError(code);
  }
}

export interface PublicChatError {
  readonly code: ChatErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export function publicChatError(code: ChatErrorCode): PublicChatError {
  return Object.freeze({
    code,
    message: PUBLIC_CHAT_MESSAGES[code],
    retryable: isRetryableChatError(code),
  });
}

export function toPublicChatError(error: unknown): PublicChatError {
  return error instanceof ChatError
    ? Object.freeze({
        code: error.code,
        message: PUBLIC_CHAT_MESSAGES[error.code],
        retryable: error.retryable,
      })
    : publicChatError('internal');
}

function isRetryableChatError(code: ChatErrorCode): boolean {
  return (
    code === 'offline' ||
    code === 'relay_unavailable' ||
    code === 'group_out_of_sync' ||
    code === 'internal'
  );
}
