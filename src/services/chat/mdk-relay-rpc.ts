import { MDK_RUNTIME_RPC_SCHEMA_VERSION } from './mdk-runtime-rpc';

export interface MdkRelayProbeRequest {
  readonly endpoints: readonly string[];
  readonly id: number;
  readonly method: 'relay_publish_probe';
  readonly requiredAcks: number;
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
}

export interface MdkRelayCatchUpProbeRequest {
  readonly endpoints: readonly string[];
  readonly id: number;
  readonly method: 'relay_catch_up_probe';
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
}

export interface MdkRelayStateProbeRequest {
  readonly acceptedEndpoint: string;
  readonly id: number;
  readonly method: 'relay_state_probe';
  readonly rejectedEndpoint: string;
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
  readonly storageKey: Uint8Array;
}

export interface MdkRelayProbeInfo {
  readonly acceptedCount: number;
  readonly eventId: string;
  readonly failedCount: number;
  readonly failureCodes: readonly string[];
  readonly metRequiredAcks: boolean;
  readonly relayVector: 'failed' | 'passed';
  readonly requiredAcks: number;
}

export interface MdkRelayProbeSuccessResponse {
  readonly id: number;
  readonly ok: true;
  readonly result: MdkRelayProbeInfo;
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
}

export interface MdkRelayProbeErrorResponse {
  readonly error: {
    readonly code: 'invalid_request' | 'runtime_unavailable';
    readonly message: string;
  };
  readonly id: number;
  readonly ok: false;
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
}

export type MdkRelayProbeResponse =
  MdkRelayProbeErrorResponse | MdkRelayProbeSuccessResponse;

export interface MdkRelayCatchUpProbeInfo {
  readonly completedCount: number;
  readonly eventCount: number;
  readonly failedCount: number;
  readonly failureCodes: readonly string[];
  readonly maxSourceCount: number;
  readonly relayVector: 'failed' | 'passed';
}

export interface MdkRelayCatchUpProbeSuccessResponse {
  readonly id: number;
  readonly ok: true;
  readonly result: MdkRelayCatchUpProbeInfo;
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
}

export type MdkRelayCatchUpProbeResponse =
  MdkRelayProbeErrorResponse | MdkRelayCatchUpProbeSuccessResponse;

export interface MdkRelayStateProbeInfo {
  readonly confirmedEpoch: number;
  readonly confirmedTransition: 'confirmed';
  readonly durableGenerations: readonly number[];
  readonly pendingPublishRecovered: boolean;
  readonly recoveredEventAvailable: boolean;
  readonly rollbackEpoch: number;
  readonly rollbackTransition: 'rolled_back';
  readonly stateVector: 'passed';
}

export interface MdkRelayStateProbeSuccessResponse {
  readonly id: number;
  readonly ok: true;
  readonly result: MdkRelayStateProbeInfo;
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
}

export type MdkRelayStateProbeResponse =
  MdkRelayProbeErrorResponse | MdkRelayStateProbeSuccessResponse;

export function isMdkRelayProbeRequest(
  value: unknown,
): value is MdkRelayProbeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Partial<MdkRelayProbeRequest>;
  return (
    typeof request.id === 'number' &&
    request.method === 'relay_publish_probe' &&
    request.schemaVersion === MDK_RUNTIME_RPC_SCHEMA_VERSION &&
    Array.isArray(request.endpoints) &&
    request.endpoints.every((endpoint) => typeof endpoint === 'string') &&
    typeof request.requiredAcks === 'number'
  );
}

export function isMdkRelayCatchUpProbeRequest(
  value: unknown,
): value is MdkRelayCatchUpProbeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Partial<MdkRelayCatchUpProbeRequest>;
  return (
    typeof request.id === 'number' &&
    request.method === 'relay_catch_up_probe' &&
    request.schemaVersion === MDK_RUNTIME_RPC_SCHEMA_VERSION &&
    Array.isArray(request.endpoints) &&
    request.endpoints.every((endpoint) => typeof endpoint === 'string')
  );
}

export function isMdkRelayStateProbeRequest(
  value: unknown,
): value is MdkRelayStateProbeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Partial<MdkRelayStateProbeRequest>;
  return (
    typeof request.id === 'number' &&
    request.method === 'relay_state_probe' &&
    request.schemaVersion === MDK_RUNTIME_RPC_SCHEMA_VERSION &&
    typeof request.acceptedEndpoint === 'string' &&
    typeof request.rejectedEndpoint === 'string' &&
    request.storageKey instanceof Uint8Array &&
    request.storageKey.length === 32
  );
}

export function isMdkRelayProbeResponse(
  value: unknown,
): value is MdkRelayProbeResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { id?: unknown }).id !== 'number' ||
    (value as { schemaVersion?: unknown }).schemaVersion !==
      MDK_RUNTIME_RPC_SCHEMA_VERSION ||
    typeof (value as { ok?: unknown }).ok !== 'boolean'
  ) {
    return false;
  }
  const response = value as Partial<MdkRelayProbeResponse> & {
    result?: Partial<MdkRelayProbeInfo>;
  };
  if (response.ok === false) {
    return (
      typeof response.error === 'object' &&
      response.error !== null &&
      (response.error.code === 'invalid_request' ||
        response.error.code === 'runtime_unavailable') &&
      typeof response.error.message === 'string'
    );
  }
  const result = response.result;
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof result.acceptedCount === 'number' &&
    /^[0-9a-f]{64}$/u.test(result.eventId ?? '') &&
    typeof result.failedCount === 'number' &&
    Array.isArray(result.failureCodes) &&
    result.failureCodes.every((code) => typeof code === 'string') &&
    typeof result.metRequiredAcks === 'boolean' &&
    (result.relayVector === 'failed' || result.relayVector === 'passed') &&
    typeof result.requiredAcks === 'number'
  );
}

export function isMdkRelayCatchUpProbeResponse(
  value: unknown,
): value is MdkRelayCatchUpProbeResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { id?: unknown }).id !== 'number' ||
    (value as { schemaVersion?: unknown }).schemaVersion !==
      MDK_RUNTIME_RPC_SCHEMA_VERSION ||
    typeof (value as { ok?: unknown }).ok !== 'boolean'
  ) {
    return false;
  }
  const response = value as Partial<MdkRelayCatchUpProbeResponse> & {
    result?: Partial<MdkRelayCatchUpProbeInfo>;
  };
  if (response.ok === false) {
    return (
      typeof response.error === 'object' &&
      response.error !== null &&
      (response.error.code === 'invalid_request' ||
        response.error.code === 'runtime_unavailable') &&
      typeof response.error.message === 'string'
    );
  }
  const result = response.result;
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof result.completedCount === 'number' &&
    typeof result.eventCount === 'number' &&
    typeof result.failedCount === 'number' &&
    Array.isArray(result.failureCodes) &&
    result.failureCodes.every((code) => typeof code === 'string') &&
    typeof result.maxSourceCount === 'number' &&
    (result.relayVector === 'failed' || result.relayVector === 'passed')
  );
}

export function isMdkRelayStateProbeResponse(
  value: unknown,
): value is MdkRelayStateProbeResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { id?: unknown }).id !== 'number' ||
    (value as { schemaVersion?: unknown }).schemaVersion !==
      MDK_RUNTIME_RPC_SCHEMA_VERSION ||
    typeof (value as { ok?: unknown }).ok !== 'boolean'
  ) {
    return false;
  }
  const response = value as Partial<MdkRelayStateProbeResponse> & {
    result?: Partial<MdkRelayStateProbeInfo>;
  };
  if (response.ok === false) {
    return (
      typeof response.error === 'object' &&
      response.error !== null &&
      (response.error.code === 'invalid_request' ||
        response.error.code === 'runtime_unavailable') &&
      typeof response.error.message === 'string'
    );
  }
  const result = response.result;
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof result.confirmedEpoch === 'number' &&
    result.confirmedTransition === 'confirmed' &&
    Array.isArray(result.durableGenerations) &&
    result.durableGenerations.every((generation) =>
      Number.isSafeInteger(generation),
    ) &&
    typeof result.pendingPublishRecovered === 'boolean' &&
    typeof result.recoveredEventAvailable === 'boolean' &&
    typeof result.rollbackEpoch === 'number' &&
    result.rollbackTransition === 'rolled_back' &&
    result.stateVector === 'passed'
  );
}
