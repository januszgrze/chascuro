const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const DEFAULT_SUBSCRIPTION_TIMEOUT_MS = 10_000;
const MAX_EVENT_BYTES = 1_048_576;
const MAX_FILTER_BYTES = 65_536;
const MAX_FILTERS = 8;
const MAX_SUBSCRIPTION_EVENTS = 1_024;
const MAX_RELAY_ENDPOINTS = 8;
const MAX_RELAY_FRAME_BYTES = 1_048_576;
const MAX_RELAY_URL_BYTES = 2_048;
const NOSTR_EVENT_ID = /^[0-9a-f]{64}$/u;
const NOSTR_PUBLIC_KEY = /^[0-9a-f]{64}$/u;
const NOSTR_SIGNATURE = /^[0-9a-f]{128}$/u;
const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export type RelayPublishFailureCode =
  | 'aborted'
  | 'connection_closed'
  | 'connection_error'
  | 'invalid_response'
  | 'publish_rejected'
  | 'receipt_timeout';

export interface RelayPublishReceipt {
  readonly acceptedAt: number;
  readonly endpoint: string;
}

export interface RelayPublishFailure {
  readonly code: RelayPublishFailureCode;
  readonly endpoint: string;
  readonly message: string;
}

export interface RelayPublishReport {
  readonly accepted: readonly RelayPublishReceipt[];
  readonly failed: readonly RelayPublishFailure[];
  readonly eventId: string;
  readonly metRequiredAcks: boolean;
  readonly requiredAcks: number;
}

export interface RelayPublishRequest {
  readonly endpoints: readonly string[];
  readonly eventId: string;
  /** Canonical signed Nostr event JSON produced and validated by Rust. */
  readonly eventJson: string;
  readonly requiredAcks: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type RelaySubscriptionFailureCode =
  | 'aborted'
  | 'conflicting_event'
  | 'connection_closed'
  | 'connection_error'
  | 'event_limit_exceeded'
  | 'invalid_response'
  | 'subscription_closed'
  | 'subscription_timeout';

export interface RelayReceivedEvent {
  readonly eventId: string;
  /** Signed Nostr event JSON for Rust to authenticate and peel. */
  readonly eventJson: string;
  readonly sourceEndpoints: readonly string[];
}

export interface RelaySubscriptionReceipt {
  readonly completedAt: number;
  readonly endpoint: string;
  readonly eventCount: number;
}

export interface RelaySubscriptionFailure {
  readonly code: RelaySubscriptionFailureCode;
  readonly endpoint: string;
  readonly message: string;
}

export interface RelayCatchUpReport {
  readonly completed: readonly RelaySubscriptionReceipt[];
  readonly events: readonly RelayReceivedEvent[];
  readonly failed: readonly RelaySubscriptionFailure[];
}

export interface RelayCatchUpRequest {
  readonly endpoints: readonly string[];
  /** JSON array of Nostr filters produced by Rust. */
  readonly filtersJson: string;
  readonly maxEvents?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface RelaySocket {
  readonly readyState: number;
  addEventListener(
    type: 'close' | 'error' | 'message' | 'open',
    listener: (event: Event | MessageEvent<unknown>) => void,
  ): void;
  close(code?: number, reason?: string): void;
  removeEventListener(
    type: 'close' | 'error' | 'message' | 'open',
    listener: (event: Event | MessageEvent<unknown>) => void,
  ): void;
  send(data: string): void;
}

export type RelaySocketFactory = (endpoint: string) => RelaySocket;

export interface BrowserNostrRelayClientOptions {
  /** Allows `ws://localhost` only for the deterministic local relay harness. */
  readonly allowInsecureLocalhost?: boolean;
  readonly now?: () => number;
  readonly socketFactory?: RelaySocketFactory;
  readonly subscriptionIdFactory?: () => string;
}

interface CollectedRelayEvent {
  readonly eventId: string;
  readonly eventJson: string;
  readonly fingerprint: string;
  readonly sourceEndpoints: Set<string>;
}

/**
 * Worker-local Nostr relay I/O. It deliberately does not construct, sign,
 * decrypt, or interpret Marmot events; those operations remain in Rust.
 */
export class BrowserNostrRelayClient {
  readonly #allowInsecureLocalhost: boolean;
  readonly #now: () => number;
  readonly #socketFactory: RelaySocketFactory;
  readonly #subscriptionIdFactory: () => string;

  constructor(options: BrowserNostrRelayClientOptions = {}) {
    this.#allowInsecureLocalhost = options.allowInsecureLocalhost ?? false;
    this.#now = options.now ?? Date.now;
    this.#socketFactory =
      options.socketFactory ?? ((endpoint) => new WebSocket(endpoint));
    this.#subscriptionIdFactory =
      options.subscriptionIdFactory ??
      (() => `marmot-${crypto.randomUUID().replaceAll('-', '')}`);
  }

  async publish(request: RelayPublishRequest): Promise<RelayPublishReport> {
    const normalized = this.#validatePublishRequest(request);
    const results = await Promise.all(
      normalized.endpoints.map((endpoint) =>
        this.#publishToEndpoint(
          endpoint,
          normalized.eventId,
          normalized.frame,
          normalized.timeoutMs,
          request.signal,
        ),
      ),
    );
    const accepted = results.filter(
      (result): result is RelayPublishReceipt => 'acceptedAt' in result,
    );
    const failed = results.filter(
      (result): result is RelayPublishFailure => 'code' in result,
    );
    return {
      accepted,
      failed,
      eventId: normalized.eventId,
      metRequiredAcks: accepted.length >= normalized.requiredAcks,
      requiredAcks: normalized.requiredAcks,
    };
  }

  async catchUp(request: RelayCatchUpRequest): Promise<RelayCatchUpReport> {
    const normalized = this.#validateCatchUpRequest(request);
    const collected = new Map<string, CollectedRelayEvent>();
    const results = await Promise.all(
      normalized.endpoints.map((endpoint) =>
        this.#catchUpFromEndpoint(
          endpoint,
          normalized.subscriptionId,
          normalized.frame,
          normalized.maxEvents,
          normalized.timeoutMs,
          collected,
          request.signal,
        ),
      ),
    );
    return {
      completed: results.filter(
        (result): result is RelaySubscriptionReceipt => 'completedAt' in result,
      ),
      events: [...collected.values()].map((event) => ({
        eventId: event.eventId,
        eventJson: event.eventJson,
        sourceEndpoints: [...event.sourceEndpoints].sort(),
      })),
      failed: results.filter(
        (result): result is RelaySubscriptionFailure => 'code' in result,
      ),
    };
  }

  #validatePublishRequest(request: RelayPublishRequest): {
    endpoints: string[];
    eventId: string;
    frame: string;
    requiredAcks: number;
    timeoutMs: number;
  } {
    if (!NOSTR_EVENT_ID.test(request.eventId)) {
      throw new Error('The relay publish event id is invalid.');
    }
    if (
      request.endpoints.length === 0 ||
      request.endpoints.length > MAX_RELAY_ENDPOINTS
    ) {
      throw new Error(
        'The relay endpoint count is outside the supported range.',
      );
    }
    const endpoints = normalizeRelayEndpoints(
      request.endpoints,
      this.#allowInsecureLocalhost,
    );
    if (
      !Number.isInteger(request.requiredAcks) ||
      request.requiredAcks < 1 ||
      request.requiredAcks > endpoints.length
    ) {
      throw new Error('The relay acknowledgement threshold is invalid.');
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('The relay publish timeout is invalid.');
    }
    if (utf8Length(request.eventJson) > MAX_EVENT_BYTES) {
      throw new Error('The relay event exceeds the supported size.');
    }
    const event = parseRustEvent(request.eventJson, request.eventId);
    const frame = JSON.stringify(['EVENT', event]);
    if (utf8Length(frame) > MAX_RELAY_FRAME_BYTES) {
      throw new Error('The relay publish frame exceeds the supported size.');
    }
    return {
      endpoints,
      eventId: request.eventId,
      frame,
      requiredAcks: request.requiredAcks,
      timeoutMs,
    };
  }

  #validateCatchUpRequest(request: RelayCatchUpRequest): {
    endpoints: string[];
    frame: string;
    maxEvents: number;
    subscriptionId: string;
    timeoutMs: number;
  } {
    const endpoints = normalizeRelayEndpoints(
      request.endpoints,
      this.#allowInsecureLocalhost,
    );
    if (utf8Length(request.filtersJson) > MAX_FILTER_BYTES) {
      throw new Error('The relay subscription filters exceed the size limit.');
    }
    let filters: unknown;
    try {
      filters = JSON.parse(request.filtersJson);
    } catch {
      throw new Error('Rust returned invalid relay subscription filters.');
    }
    if (
      !Array.isArray(filters) ||
      filters.length === 0 ||
      filters.length > MAX_FILTERS ||
      filters.some(
        (filter) =>
          typeof filter !== 'object' ||
          filter === null ||
          Array.isArray(filter),
      )
    ) {
      throw new Error('Rust returned unsupported relay subscription filters.');
    }
    const maxEvents = request.maxEvents ?? 256;
    if (
      !Number.isInteger(maxEvents) ||
      maxEvents < 1 ||
      maxEvents > MAX_SUBSCRIPTION_EVENTS
    ) {
      throw new Error('The relay subscription event limit is invalid.');
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_SUBSCRIPTION_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('The relay subscription timeout is invalid.');
    }
    const subscriptionId = this.#subscriptionIdFactory();
    if (!SUBSCRIPTION_ID.test(subscriptionId)) {
      throw new Error('The relay subscription identifier is invalid.');
    }
    const frame = JSON.stringify(['REQ', subscriptionId, ...filters]);
    if (utf8Length(frame) > MAX_RELAY_FRAME_BYTES) {
      throw new Error('The relay subscription frame exceeds the size limit.');
    }
    return { endpoints, frame, maxEvents, subscriptionId, timeoutMs };
  }

  #publishToEndpoint(
    endpoint: string,
    eventId: string,
    frame: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<RelayPublishReceipt | RelayPublishFailure> {
    if (signal?.aborted === true) {
      return Promise.resolve(failure(endpoint, 'aborted'));
    }

    return new Promise((resolve) => {
      let socket: RelaySocket;
      try {
        socket = this.#socketFactory(endpoint);
      } catch {
        resolve(failure(endpoint, 'connection_error'));
        return;
      }
      let settled = false;
      const finish = (
        result: RelayPublishReceipt | RelayPublishFailure,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        try {
          socket.close(1000, 'publish complete');
        } catch {
          // The report is already decided; close failures carry no new state.
        }
        resolve(result);
      };
      const onAbort = (): void => finish(failure(endpoint, 'aborted'));
      const onOpen = (): void => {
        try {
          socket.send(frame);
        } catch {
          finish(failure(endpoint, 'connection_error'));
        }
      };
      const onMessage = (event: Event | MessageEvent<unknown>): void => {
        if (
          !(event instanceof MessageEvent) ||
          typeof event.data !== 'string'
        ) {
          finish(failure(endpoint, 'invalid_response'));
          return;
        }
        if (utf8Length(event.data) > MAX_RELAY_FRAME_BYTES) {
          finish(failure(endpoint, 'invalid_response'));
          return;
        }
        const receipt = parseOkReceipt(event.data, eventId);
        if (receipt === undefined) return;
        if (receipt === 'invalid') {
          finish(failure(endpoint, 'invalid_response'));
        } else if (receipt) {
          finish({ acceptedAt: this.#now(), endpoint });
        } else {
          finish(failure(endpoint, 'publish_rejected'));
        }
      };
      const onError = (): void => finish(failure(endpoint, 'connection_error'));
      const onClose = (): void =>
        finish(failure(endpoint, 'connection_closed'));
      const timer = setTimeout(
        () => finish(failure(endpoint, 'receipt_timeout')),
        timeoutMs,
      );

      signal?.addEventListener('abort', onAbort, { once: true });
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });
  }

  #catchUpFromEndpoint(
    endpoint: string,
    subscriptionId: string,
    frame: string,
    maxEvents: number,
    timeoutMs: number,
    collected: Map<string, CollectedRelayEvent>,
    signal: AbortSignal | undefined,
  ): Promise<RelaySubscriptionReceipt | RelaySubscriptionFailure> {
    if (signal?.aborted === true) {
      return Promise.resolve(subscriptionFailure(endpoint, 'aborted'));
    }

    return new Promise((resolve) => {
      let socket: RelaySocket;
      try {
        socket = this.#socketFactory(endpoint);
      } catch {
        resolve(subscriptionFailure(endpoint, 'connection_error'));
        return;
      }
      let settled = false;
      const seen = new Set<string>();
      const finish = (
        result: RelaySubscriptionReceipt | RelaySubscriptionFailure,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        try {
          socket.send(JSON.stringify(['CLOSE', subscriptionId]));
        } catch {
          // The bounded report is already decided.
        }
        try {
          socket.close(1000, 'subscription complete');
        } catch {
          // The bounded report is already decided.
        }
        resolve(result);
      };
      const onAbort = (): void =>
        finish(subscriptionFailure(endpoint, 'aborted'));
      const onOpen = (): void => {
        try {
          socket.send(frame);
        } catch {
          finish(subscriptionFailure(endpoint, 'connection_error'));
        }
      };
      const onMessage = (event: Event | MessageEvent<unknown>): void => {
        if (
          !(event instanceof MessageEvent) ||
          typeof event.data !== 'string' ||
          utf8Length(event.data) > MAX_RELAY_FRAME_BYTES
        ) {
          finish(subscriptionFailure(endpoint, 'invalid_response'));
          return;
        }
        const parsed = parseSubscriptionFrame(event.data, subscriptionId);
        if (parsed === undefined) return;
        if (parsed === 'invalid') {
          finish(subscriptionFailure(endpoint, 'invalid_response'));
          return;
        }
        if (parsed === 'eose') {
          finish({
            completedAt: this.#now(),
            endpoint,
            eventCount: seen.size,
          });
          return;
        }
        if (parsed === 'closed') {
          finish(subscriptionFailure(endpoint, 'subscription_closed'));
          return;
        }
        const existing = collected.get(parsed.eventId);
        if (existing !== undefined) {
          if (existing.fingerprint !== parsed.fingerprint) {
            finish(subscriptionFailure(endpoint, 'conflicting_event'));
            return;
          }
          existing.sourceEndpoints.add(endpoint);
          seen.add(parsed.eventId);
          return;
        }
        if (collected.size >= maxEvents) {
          finish(subscriptionFailure(endpoint, 'event_limit_exceeded'));
          return;
        }
        collected.set(parsed.eventId, {
          ...parsed,
          sourceEndpoints: new Set([endpoint]),
        });
        seen.add(parsed.eventId);
      };
      const onError = (): void =>
        finish(subscriptionFailure(endpoint, 'connection_error'));
      const onClose = (): void =>
        finish(subscriptionFailure(endpoint, 'connection_closed'));
      const timer = setTimeout(
        () => finish(subscriptionFailure(endpoint, 'subscription_timeout')),
        timeoutMs,
      );

      signal?.addEventListener('abort', onAbort, { once: true });
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });
  }
}

function parseSubscriptionFrame(
  frame: string,
  subscriptionId: string,
):
  | Omit<CollectedRelayEvent, 'sourceEndpoints'>
  | 'closed'
  | 'eose'
  | 'invalid'
  | undefined {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return 'invalid';
  }
  if (!Array.isArray(value)) return 'invalid';
  if (value[0] === 'EVENT') {
    if (value[1] !== subscriptionId) return undefined;
    return parseRelayEvent(value[2]);
  }
  if (value[0] === 'EOSE') {
    return value[1] === subscriptionId ? 'eose' : undefined;
  }
  if (value[0] === 'CLOSED') {
    return value[1] === subscriptionId ? 'closed' : undefined;
  }
  return undefined;
}

function parseRelayEvent(
  value: unknown,
): Omit<CollectedRelayEvent, 'sourceEndpoints'> | 'invalid' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'invalid';
  }
  const event = value as Record<string, unknown>;
  if (
    typeof event.id !== 'string' ||
    !NOSTR_EVENT_ID.test(event.id) ||
    typeof event.pubkey !== 'string' ||
    !NOSTR_PUBLIC_KEY.test(event.pubkey) ||
    !Number.isSafeInteger(event.created_at) ||
    (event.created_at as number) < 0 ||
    !Number.isSafeInteger(event.kind) ||
    (event.kind as number) < 0 ||
    !Array.isArray(event.tags) ||
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((item) => typeof item === 'string'),
    ) ||
    typeof event.content !== 'string' ||
    typeof event.sig !== 'string' ||
    !NOSTR_SIGNATURE.test(event.sig)
  ) {
    return 'invalid';
  }
  const normalized = {
    content: event.content,
    created_at: event.created_at,
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    sig: event.sig,
    tags: event.tags,
  };
  return {
    eventId: event.id,
    eventJson: JSON.stringify(normalized),
    fingerprint: JSON.stringify([
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content,
      event.sig,
    ]),
  };
}

function parseRustEvent(eventJson: string, expectedId: string): object {
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch {
    throw new Error('Rust returned invalid relay event JSON.');
  }
  if (
    typeof event !== 'object' ||
    event === null ||
    Array.isArray(event) ||
    (event as { id?: unknown }).id !== expectedId
  ) {
    throw new Error('Rust returned an inconsistent relay event.');
  }
  return event;
}

function parseOkReceipt(
  frame: string,
  expectedId: string,
): boolean | 'invalid' | undefined {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return 'invalid';
  }
  if (!Array.isArray(value) || value[0] !== 'OK') return undefined;
  if (value[1] !== expectedId) return undefined;
  return value.length >= 3 && typeof value[2] === 'boolean'
    ? value[2]
    : 'invalid';
}

function normalizeRelayEndpoint(
  endpoint: string,
  allowInsecureLocalhost: boolean,
): string {
  if (utf8Length(endpoint) > MAX_RELAY_URL_BYTES) {
    throw new Error('A relay URL exceeds the supported size.');
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('A relay URL is invalid.');
  }
  const localInsecure =
    allowInsecureLocalhost &&
    url.protocol === 'ws:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (
    (url.protocol !== 'wss:' && !localInsecure) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('A relay URL is not permitted.');
  }
  return url.href;
}

function normalizeRelayEndpoints(
  endpoints: readonly string[],
  allowInsecureLocalhost: boolean,
): string[] {
  if (endpoints.length === 0 || endpoints.length > MAX_RELAY_ENDPOINTS) {
    throw new Error('The relay endpoint count is outside the supported range.');
  }
  const normalized = endpoints.map((endpoint) =>
    normalizeRelayEndpoint(endpoint, allowInsecureLocalhost),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('The relay endpoint list contains duplicates.');
  }
  return normalized;
}

function failure(
  endpoint: string,
  code: RelayPublishFailureCode,
): RelayPublishFailure {
  const messages: Record<RelayPublishFailureCode, string> = {
    aborted: 'Relay publication was cancelled.',
    connection_closed: 'The relay closed before acknowledging publication.',
    connection_error: 'The relay connection failed.',
    invalid_response: 'The relay returned an invalid acknowledgement.',
    publish_rejected: 'The relay rejected publication.',
    receipt_timeout: 'The relay did not acknowledge publication in time.',
  };
  return { code, endpoint, message: messages[code] };
}

function subscriptionFailure(
  endpoint: string,
  code: RelaySubscriptionFailureCode,
): RelaySubscriptionFailure {
  const messages: Record<RelaySubscriptionFailureCode, string> = {
    aborted: 'Relay synchronization was cancelled.',
    conflicting_event: 'Relays returned conflicting copies of one event.',
    connection_closed: 'The relay closed before synchronization completed.',
    connection_error: 'The relay connection failed.',
    event_limit_exceeded: 'Relay synchronization exceeded its event limit.',
    invalid_response: 'The relay returned an invalid subscription response.',
    subscription_closed: 'The relay closed the subscription.',
    subscription_timeout: 'Relay synchronization did not finish in time.',
  };
  return { code, endpoint, message: messages[code] };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
