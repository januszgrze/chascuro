import { describe, expect, it } from 'vitest';

import { isMdkRuntimeResponse, parseMdkRuntimeInfo } from './mdk-runtime-rpc';

const VALID_INFO = {
  aliceEpoch: 2,
  aliceReceived: 'hello from browser bob',
  backend: 'rust-mdk',
  bobEpoch: 2,
  bobLeft: true,
  bobReceived: 'hello from browser alice',
  engineVector: 'passed',
  flow: 'create/invite/send/receive/leave',
  mdkRelease: 'v0.9.4',
  mdkPreviousStateRecovered: false,
  mdkRevision: 'e391adc133a9b60e420da7a0446f014a180ac8d2',
  mdkStateReload: true,
  publishRollback: true,
  rpcSchemaVersion: 1,
  sqliteImageBytes: 8192,
  sqliteRecovered: 'sqlite-wasi-committed',
  sqliteVector: 'passed',
  storageDurable: 'opfs-encrypted-sqlite-image',
  storageEncryptedAtRest: true,
  storageGeneration: 2,
  storageImageBytes: 8249,
  storageCheckpoints: 5,
  storageTornWriteRecovered: true,
  transportAdapter: 'app-owned-rust',
  transportVector: 'passed',
} as const;

describe('MDK runtime RPC', () => {
  it('accepts the versioned Rust runtime identity', () => {
    expect(parseMdkRuntimeInfo(VALID_INFO)).toEqual(VALID_INFO);
    expect(
      isMdkRuntimeResponse({
        id: 1,
        ok: true,
        result: VALID_INFO,
        schemaVersion: 1,
      }),
    ).toBe(true);
  });

  it('rejects unknown schema versions and malformed responses', () => {
    expect(() =>
      parseMdkRuntimeInfo({ ...VALID_INFO, rpcSchemaVersion: 2 }),
    ).toThrow('unsupported schema');
    expect(
      isMdkRuntimeResponse({
        id: 1,
        ok: false,
        error: { code: 'internal_details', message: 'unsafe' },
        schemaVersion: 1,
      }),
    ).toBe(false);
  });
});
