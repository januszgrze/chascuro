export const MDK_RUNTIME_RPC_SCHEMA_VERSION = 1 as const;

export interface MdkRuntimeInfo {
  readonly aliceEpoch: 2;
  readonly aliceReceived: 'hello from browser bob';
  readonly backend: 'rust-mdk';
  readonly bobEpoch: 2;
  readonly bobLeft: true;
  readonly bobReceived: 'hello from browser alice';
  readonly engineVector: 'passed';
  readonly flow: 'create/invite/send/receive/leave';
  readonly mdkRelease: string;
  readonly mdkPreviousStateRecovered: boolean;
  readonly mdkRevision: string;
  readonly mdkStateReload: true;
  readonly publishRollback: true;
  readonly rpcSchemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
  readonly sqliteImageBytes: number;
  readonly sqliteRecovered: 'sqlite-wasi-committed';
  readonly sqliteVector: 'passed';
  readonly storageDurable: 'opfs-encrypted-sqlite-image';
  readonly storageEncryptedAtRest: true;
  readonly storageGeneration: number;
  readonly storageImageBytes: number;
  readonly storageCheckpoints: 5;
  readonly storageTornWriteRecovered: true;
  readonly transportAdapter: 'app-owned-rust';
  readonly transportVector: 'passed';
}

export interface MdkRuntimeInfoRequest {
  readonly id: number;
  readonly method: 'runtime_info';
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
  readonly storageKey: Uint8Array;
}

export type MdkRuntimeRequest = MdkRuntimeInfoRequest;

export interface MdkRuntimeSuccessResponse {
  readonly id: number;
  readonly ok: true;
  readonly result: MdkRuntimeInfo;
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
}

export interface MdkRuntimeErrorResponse {
  readonly error: {
    readonly code: 'invalid_request' | 'runtime_unavailable';
    readonly message: string;
  };
  readonly id: number;
  readonly ok: false;
  readonly schemaVersion: typeof MDK_RUNTIME_RPC_SCHEMA_VERSION;
}

export type MdkRuntimeResponse =
  MdkRuntimeSuccessResponse | MdkRuntimeErrorResponse;

export function parseMdkRuntimeInfo(value: unknown): MdkRuntimeInfo {
  if (!isRecord(value)) {
    throw new Error('MDK runtime returned an invalid information document.');
  }

  if (
    value.backend !== 'rust-mdk' ||
    value.engineVector !== 'passed' ||
    value.flow !== 'create/invite/send/receive/leave' ||
    value.aliceEpoch !== 2 ||
    value.bobEpoch !== 2 ||
    value.aliceReceived !== 'hello from browser bob' ||
    value.bobReceived !== 'hello from browser alice' ||
    value.bobLeft !== true ||
    value.publishRollback !== true ||
    typeof value.mdkRelease !== 'string' ||
    typeof value.mdkPreviousStateRecovered !== 'boolean' ||
    typeof value.mdkRevision !== 'string' ||
    value.mdkStateReload !== true ||
    value.rpcSchemaVersion !== MDK_RUNTIME_RPC_SCHEMA_VERSION ||
    typeof value.sqliteImageBytes !== 'number' ||
    value.sqliteImageBytes < 8_192 ||
    value.sqliteRecovered !== 'sqlite-wasi-committed' ||
    value.sqliteVector !== 'passed' ||
    value.storageDurable !== 'opfs-encrypted-sqlite-image' ||
    value.storageEncryptedAtRest !== true ||
    typeof value.storageGeneration !== 'number' ||
    value.storageGeneration < 2 ||
    typeof value.storageImageBytes !== 'number' ||
    value.storageImageBytes < 8_192 ||
    value.storageCheckpoints !== 5 ||
    value.storageTornWriteRecovered !== true ||
    value.transportAdapter !== 'app-owned-rust' ||
    value.transportVector !== 'passed'
  ) {
    throw new Error('MDK runtime information has an unsupported schema.');
  }

  return {
    aliceEpoch: value.aliceEpoch,
    aliceReceived: value.aliceReceived,
    backend: value.backend,
    bobEpoch: value.bobEpoch,
    bobLeft: value.bobLeft,
    bobReceived: value.bobReceived,
    engineVector: value.engineVector,
    flow: value.flow,
    mdkRelease: value.mdkRelease,
    mdkPreviousStateRecovered: value.mdkPreviousStateRecovered,
    mdkRevision: value.mdkRevision,
    mdkStateReload: value.mdkStateReload,
    publishRollback: value.publishRollback,
    rpcSchemaVersion: value.rpcSchemaVersion,
    sqliteImageBytes: value.sqliteImageBytes,
    sqliteRecovered: value.sqliteRecovered,
    sqliteVector: value.sqliteVector,
    storageDurable: value.storageDurable,
    storageEncryptedAtRest: value.storageEncryptedAtRest,
    storageGeneration: value.storageGeneration,
    storageImageBytes: value.storageImageBytes,
    storageCheckpoints: value.storageCheckpoints,
    storageTornWriteRecovered: value.storageTornWriteRecovered,
    transportAdapter: value.transportAdapter,
    transportVector: value.transportVector,
  };
}

export function isMdkRuntimeResponse(
  value: unknown,
): value is MdkRuntimeResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    value.schemaVersion !== MDK_RUNTIME_RPC_SCHEMA_VERSION ||
    typeof value.ok !== 'boolean'
  ) {
    return false;
  }

  if (value.ok) {
    try {
      parseMdkRuntimeInfo(value.result);
      return true;
    } catch {
      return false;
    }
  }

  return (
    isRecord(value.error) &&
    (value.error.code === 'invalid_request' ||
      value.error.code === 'runtime_unavailable') &&
    typeof value.error.message === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
