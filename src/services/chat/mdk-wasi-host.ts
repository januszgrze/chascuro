import engineModuleUrl from '../../../runtime/marmot-web/pkg/marmot_web_wasi_engine.wasm?url';

const WASI_ESUCCESS = 0;
const WASI_ENOSYS = 52;
const WASI_CLOCK_REALTIME = 0;

interface MarmotWasiExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly open_product_profile: () => number;
  readonly open_two_profile: (role: number) => number;
  readonly prepare_relay_publish: () => number;
  readonly profile_create_group: () => number;
  readonly profile_advance_convergence: () => number;
  readonly profile_ingest_events: () => number;
  readonly profile_ingest_product_events: () => number;
  readonly profile_join_welcome: () => number;
  readonly profile_key_package_event: () => number;
  readonly profile_leave: () => number;
  readonly profile_resolve_auto_publish: (accepted: number) => number;
  readonly profile_resolve_group: (accepted: number) => number;
  readonly profile_send_text: () => number;
  readonly profile_send_product_text: () => number;
  readonly profile_status: () => number;
  readonly recover_interrupted_relay_publish: () => number;
  readonly resolve_relay_publish: (accepted: number) => number;
  readonly run_engine_vector: () => number;
  readonly engine_vector_result_ptr: () => number;
  readonly engine_vector_result_len: () => number;
}

export interface WasiRelayPublishPreparation {
  readonly eventId: string;
  readonly eventJson: string;
  readonly pendingGeneration: number;
  readonly storageImageBytes: number;
}

export interface WasiRelayPublishResolution {
  readonly accepted: boolean;
  readonly epoch: number;
  readonly groupName: string;
  readonly stateTransition: 'confirmed' | 'rolled_back';
  readonly storageGeneration: number;
  readonly storageImageBytes: number;
}

export interface WasiRelayPublishRecovery {
  readonly pendingPublishRecovered: true;
  readonly storageGeneration: number;
  readonly storageImageBytes: number;
}

export interface WasiProfileStatus {
  readonly epoch: number;
  readonly groupCount: number;
  readonly groupId: string | null;
  readonly memberCount: number;
  readonly nostrPubkey: string;
  readonly pendingPublishRecovered: boolean;
  readonly role: 'alice' | 'bob';
  readonly routingGroupId: string | null;
  readonly groups: readonly WasiProfileGroupStatus[];
  readonly storageGeneration: number;
}

export interface WasiProfileGroupStatus {
  readonly epoch: number;
  readonly groupId: string;
  readonly memberCount: number;
  readonly routingGroupId: string;
}

export interface WasiProfileEvent extends WasiProfileStatus {
  readonly eventId: string;
  readonly eventJson: string;
  readonly storageImageBytes: number;
}

export interface WasiProfileIngest extends WasiProfileStatus {
  readonly received: readonly string[];
  readonly storageImageBytes: number;
}

export interface WasiProductReceivedMessage {
  readonly groupId: string;
  readonly id: string;
  readonly sender: string;
  readonly createdAt: number;
  readonly content: string;
}

export interface WasiProductProfileIngest extends Omit<
  WasiProfileStatus,
  'role'
> {
  readonly received: readonly WasiProductReceivedMessage[];
  readonly storageImageBytes: number;
}

export interface WasiProfileAutoPublish extends Omit<
  WasiProfileStatus,
  'role'
> {
  readonly autoPublish: boolean;
  readonly eventId?: string;
  readonly eventJson?: string;
  readonly storageImageBytes?: number;
}

interface EngineFailure {
  readonly error: string;
}

let enginePromise: Promise<MarmotWasiExports> | undefined;
let closeEngineStorage: (() => void) | undefined;
let clearEngineCommandInput: (() => void) | undefined;
let setEngineCommandInput: ((input: Uint8Array) => void) | undefined;

/**
 * Executes the real MDK engine in a WASI reactor. WASI supplies the standard
 * monotonic/realtime clocks that `std::time` intentionally omits from
 * `wasm32-unknown-unknown`; the module remains fully local to this Worker.
 */
export async function runWasiEngineVector(
  suppliedStorageKey: Uint8Array,
): Promise<unknown> {
  if (suppliedStorageKey.length !== 32) {
    throw new Error('The MDK runtime requires a 32-byte chat database key.');
  }
  const storageKey = suppliedStorageKey.slice();
  const engine = await initializeEngine(storageKey);
  try {
    const status = engine.run_engine_vector();
    const pointer = engine.engine_vector_result_ptr();
    const length = engine.engine_vector_result_len();
    const result = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(engine.memory.buffer, pointer, length).slice(),
      ),
    ) as unknown;

    if (status !== 0) {
      const message = isEngineFailure(result)
        ? result.error
        : 'The WASI MDK engine vector failed.';
      throw new Error(message);
    }
    return result;
  } finally {
    closeEngineStorage?.();
    closeEngineStorage = undefined;
    enginePromise = undefined;
    storageKey.fill(0);
  }
}

export async function prepareWasiRelayPublish(
  suppliedStorageKey: Uint8Array,
): Promise<WasiRelayPublishPreparation> {
  if (suppliedStorageKey.length !== 32) {
    throw new Error('The MDK runtime requires a 32-byte chat database key.');
  }
  const storageKey = suppliedStorageKey.slice();
  try {
    const engine = await initializeEngine(storageKey);
    return readEngineResult<WasiRelayPublishPreparation>(
      engine,
      engine.prepare_relay_publish(),
      'The WASI MDK relay preparation failed.',
    );
  } catch (error) {
    closeWasiEngine();
    throw error;
  } finally {
    storageKey.fill(0);
  }
}

export async function resolveWasiRelayPublish(
  accepted: boolean,
): Promise<WasiRelayPublishResolution> {
  if (enginePromise === undefined) {
    throw new Error('The WASI MDK relay runtime is not open.');
  }
  const engine = await enginePromise;
  try {
    return readEngineResult<WasiRelayPublishResolution>(
      engine,
      engine.resolve_relay_publish(accepted ? 1 : 0),
      'The WASI MDK relay resolution failed.',
    );
  } finally {
    closeWasiEngine();
  }
}

export async function recoverWasiRelayPublish(
  suppliedStorageKey: Uint8Array,
): Promise<WasiRelayPublishRecovery> {
  if (suppliedStorageKey.length !== 32) {
    throw new Error('The MDK runtime requires a 32-byte chat database key.');
  }
  const storageKey = suppliedStorageKey.slice();
  try {
    const engine = await initializeEngine(storageKey);
    return readEngineResult<WasiRelayPublishRecovery>(
      engine,
      engine.recover_interrupted_relay_publish(),
      'The WASI MDK relay recovery failed.',
    );
  } finally {
    closeWasiEngine();
    storageKey.fill(0);
  }
}

export function abandonWasiRelayPublish(): void {
  closeWasiEngine();
}

export async function openWasiProfile(
  suppliedStorageKey: Uint8Array,
  role: 'alice' | 'bob',
): Promise<WasiProfileStatus> {
  if (suppliedStorageKey.length !== 32) {
    throw new Error('The MDK runtime requires a 32-byte chat database key.');
  }
  const storageKey = suppliedStorageKey.slice();
  try {
    const engine = await initializeEngine(storageKey);
    return readEngineResult<WasiProfileStatus>(
      engine,
      engine.open_two_profile(role === 'alice' ? 0 : 1),
      'The WASI MDK browser profile could not be opened.',
    );
  } catch (error) {
    closeWasiEngine();
    throw error;
  } finally {
    storageKey.fill(0);
  }
}

export async function openWasiProductProfile(
  suppliedStorageKey: Uint8Array,
  suppliedIdentitySecret: Uint8Array,
): Promise<Omit<WasiProfileStatus, 'role'>> {
  if (
    suppliedStorageKey.length !== 32 ||
    suppliedIdentitySecret.length !== 32
  ) {
    throw new Error('The MDK runtime requires independent 32-byte chat keys.');
  }
  const storageKey = suppliedStorageKey.slice();
  const identitySecret = suppliedIdentitySecret.slice();
  try {
    const engine = await initializeEngine(storageKey, identitySecret);
    return readEngineResult<Omit<WasiProfileStatus, 'role'>>(
      engine,
      engine.open_product_profile(),
      'The WASI MDK product profile could not be opened.',
    );
  } catch (error) {
    closeWasiEngine();
    throw error;
  } finally {
    storageKey.fill(0);
    identitySecret.fill(0);
  }
}

export async function createWasiProfileKeyPackage(): Promise<WasiProfileEvent> {
  const engine = await requireOpenEngine();
  return readEngineResult<WasiProfileEvent>(
    engine,
    engine.profile_key_package_event(),
    'The WASI MDK KeyPackage could not be created.',
  );
}

export async function createWasiProfileGroup(
  keyPackageEventJson: string,
  relayEndpoint: string,
): Promise<WasiProfileEvent> {
  return callProfileCommand<WasiProfileEvent>(
    { keyPackageEventJson, relayEndpoint },
    (engine) => engine.profile_create_group(),
    'The WASI MDK group could not be created.',
  );
}

export async function resolveWasiProfileGroup(
  accepted: boolean,
): Promise<WasiProfileStatus & { readonly accepted: boolean }> {
  const engine = await requireOpenEngine();
  return readEngineResult<WasiProfileStatus & { readonly accepted: boolean }>(
    engine,
    engine.profile_resolve_group(accepted ? 1 : 0),
    'The WASI MDK group publication could not be resolved.',
  );
}

export async function leaveWasiProductProfile(
  groupId: string,
): Promise<WasiProfileEvent> {
  return callProfileCommand<WasiProfileEvent>(
    { groupId },
    (engine) => engine.profile_leave(),
    'The WASI MDK leave proposal could not be created.',
  );
}

export async function advanceWasiProductProfileConvergence(
  groupId: string,
): Promise<WasiProfileAutoPublish> {
  return callProfileCommand<WasiProfileAutoPublish>(
    { groupId },
    (engine) => engine.profile_advance_convergence(),
    'The WASI MDK convergence tick failed.',
  );
}

export async function resolveWasiProductProfileAutoPublish(
  accepted: boolean,
): Promise<Omit<WasiProfileStatus, 'role'> & { readonly accepted: boolean }> {
  const engine = await requireOpenEngine();
  return readEngineResult<
    Omit<WasiProfileStatus, 'role'> & { readonly accepted: boolean }
  >(
    engine,
    engine.profile_resolve_auto_publish(accepted ? 1 : 0),
    'The WASI MDK convergence publication could not be resolved.',
  );
}

export async function joinWasiProfileWelcome(
  eventJson: string,
): Promise<WasiProfileStatus> {
  return callProfileCommand<WasiProfileStatus>(
    { eventJson },
    (engine) => engine.profile_join_welcome(),
    'The WASI MDK Welcome could not be joined.',
  );
}

export async function sendWasiProfileText(
  content: string,
): Promise<WasiProfileEvent> {
  return callProfileCommand<WasiProfileEvent>(
    { content },
    (engine) => engine.profile_send_text(),
    'The WASI MDK message could not be created.',
  );
}

export async function sendWasiProductProfileText(
  groupId: string,
  content: string,
  createdAt: number,
): Promise<WasiProfileEvent> {
  return callProfileCommand<WasiProfileEvent>(
    { groupId, content, createdAt },
    (engine) => engine.profile_send_product_text(),
    'The WASI MDK message could not be created.',
  );
}

export async function ingestWasiProfileEvents(
  events: readonly string[],
): Promise<WasiProfileIngest> {
  return callProfileCommand<WasiProfileIngest>(
    { events },
    (engine) => engine.profile_ingest_events(),
    'The WASI MDK events could not be ingested.',
  );
}

export async function ingestWasiProductProfileEvents(
  groupId: string,
  events: readonly string[],
): Promise<WasiProductProfileIngest> {
  return callProfileCommand<WasiProductProfileIngest>(
    { groupId, events },
    (engine) => engine.profile_ingest_product_events(),
    'The WASI MDK events could not be ingested.',
  );
}

export async function readWasiProfileStatus(): Promise<WasiProfileStatus> {
  const engine = await requireOpenEngine();
  return readEngineResult<WasiProfileStatus>(
    engine,
    engine.profile_status(),
    'The WASI MDK profile status could not be read.',
  );
}

export function closeWasiProfile(): void {
  closeWasiEngine();
}

function closeWasiEngine(): void {
  clearEngineCommandInput?.();
  clearEngineCommandInput = undefined;
  setEngineCommandInput = undefined;
  closeEngineStorage?.();
  closeEngineStorage = undefined;
  enginePromise = undefined;
}

async function requireOpenEngine(): Promise<MarmotWasiExports> {
  if (enginePromise === undefined) {
    throw new Error('The WASI MDK browser profile is not open.');
  }
  return enginePromise;
}

async function callProfileCommand<Result>(
  input: unknown,
  invoke: (engine: MarmotWasiExports) => number,
  fallbackMessage: string,
): Promise<Result> {
  const engine = await requireOpenEngine();
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  try {
    if (setEngineCommandInput === undefined) {
      throw new Error('The WASI MDK profile input bridge is unavailable.');
    }
    setEngineCommandInput(encoded);
    return readEngineResult<Result>(engine, invoke(engine), fallbackMessage);
  } finally {
    clearEngineCommandInput?.();
    encoded.fill(0);
  }
}

function readEngineResult<Result>(
  engine: MarmotWasiExports,
  status: number,
  fallbackMessage: string,
): Result {
  const pointer = engine.engine_vector_result_ptr();
  const length = engine.engine_vector_result_len();
  const result = JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(engine.memory.buffer, pointer, length).slice(),
    ),
  ) as unknown;
  if (status !== 0) {
    throw new Error(isEngineFailure(result) ? result.error : fallbackMessage);
  }
  return result as Result;
}

function initializeEngine(
  storageKey: Uint8Array,
  identitySecret?: Uint8Array,
): Promise<MarmotWasiExports> {
  enginePromise ??= instantiateEngine(storageKey, identitySecret);
  return enginePromise;
}

async function instantiateEngine(
  storageKey: Uint8Array,
  identitySecret?: Uint8Array,
): Promise<MarmotWasiExports> {
  const state: { memory?: WebAssembly.Memory } = {};
  let commandInput = new Uint8Array();
  const storage = await openMarmotOpfsStorage();
  const view = (): DataView => {
    if (state.memory === undefined) {
      throw new Error('The WASI MDK engine memory is not initialized.');
    }
    return new DataView(state.memory.buffer);
  };
  const bytes = (): Uint8Array => {
    if (state.memory === undefined) {
      throw new Error('The WASI MDK engine memory is not initialized.');
    }
    return new Uint8Array(state.memory.buffer);
  };

  const wasi = {
    clock_time_get(
      clockId: number,
      _precision: bigint,
      timestampPointer: number,
    ): number {
      const milliseconds =
        clockId === WASI_CLOCK_REALTIME ? Date.now() : performance.now();
      view().setBigUint64(
        timestampPointer,
        BigInt(Math.floor(milliseconds * 1_000_000)),
        true,
      );
      return WASI_ESUCCESS;
    },
    environ_get(): number {
      return WASI_ESUCCESS;
    },
    environ_sizes_get(countPointer: number, sizePointer: number): number {
      view().setUint32(countPointer, 0, true);
      view().setUint32(sizePointer, 0, true);
      return WASI_ESUCCESS;
    },
    fd_write(
      _fileDescriptor: number,
      iovecsPointer: number,
      iovecsLength: number,
      writtenPointer: number,
    ): number {
      let written = 0;
      for (let index = 0; index < iovecsLength; index += 1) {
        written += view().getUint32(iovecsPointer + index * 8 + 4, true);
      }
      view().setUint32(writtenPointer, written, true);
      return WASI_ESUCCESS;
    },
    fd_close(): number {
      return WASI_ENOSYS;
    },
    fd_fdstat_get(): number {
      return WASI_ENOSYS;
    },
    fd_fdstat_set_flags(): number {
      return WASI_ENOSYS;
    },
    fd_filestat_get(): number {
      return WASI_ENOSYS;
    },
    fd_filestat_set_size(): number {
      return WASI_ENOSYS;
    },
    fd_prestat_get(): number {
      return WASI_ENOSYS;
    },
    fd_prestat_dir_name(): number {
      return WASI_ENOSYS;
    },
    fd_read(): number {
      return WASI_ENOSYS;
    },
    fd_seek(): number {
      return WASI_ENOSYS;
    },
    fd_sync(): number {
      return WASI_ENOSYS;
    },
    path_create_directory(): number {
      return WASI_ENOSYS;
    },
    path_filestat_get(): number {
      return WASI_ENOSYS;
    },
    path_filestat_set_times(): number {
      return WASI_ENOSYS;
    },
    path_open(): number {
      return WASI_ENOSYS;
    },
    path_readlink(): number {
      return WASI_ENOSYS;
    },
    path_remove_directory(): number {
      return WASI_ENOSYS;
    },
    path_unlink_file(): number {
      return WASI_ENOSYS;
    },
    poll_oneoff(): number {
      // The reactor performs its short convergence delay against the hosted
      // monotonic clock, so it never blocks through WASI poll_oneoff.
      return WASI_ENOSYS;
    },
    proc_exit(code: number): never {
      throw new Error(`The WASI MDK engine exited with status ${code}.`);
    },
    random_get(bufferPointer: number, bufferLength: number): number {
      const target = bytes().subarray(
        bufferPointer,
        bufferPointer + bufferLength,
      );
      for (let offset = 0; offset < target.length; offset += 65_536) {
        crypto.getRandomValues(target.subarray(offset, offset + 65_536));
      }
      return WASI_ESUCCESS;
    },
  } satisfies Record<string, WebAssembly.ImportValue>;

  const marmotStorage = {
    command_input_len(): number {
      return commandInput.length;
    },
    command_input_read(destination: number, capacity: number): number {
      if (
        capacity < commandInput.length ||
        destination < 0 ||
        destination + commandInput.length > bytes().length
      ) {
        return -1;
      }
      bytes().set(commandInput, destination);
      return commandInput.length;
    },
    storage_key_read(destination: number, capacity: number): number {
      if (
        capacity < storageKey.length ||
        destination < 0 ||
        destination + storageKey.length > bytes().length
      ) {
        return -1;
      }
      bytes().set(storageKey, destination);
      return storageKey.length;
    },
    identity_secret_read(destination: number, capacity: number): number {
      if (
        identitySecret === undefined ||
        capacity < identitySecret.length ||
        destination < 0 ||
        destination + identitySecret.length > bytes().length
      ) {
        return -1;
      }
      bytes().set(identitySecret, destination);
      return identitySecret.length;
    },
    slot_len(slot: number): number {
      return storage.slotLength(slot);
    },
    slot_read(slot: number, destination: number, capacity: number): number {
      return storage.readSlot(slot, bytes(), destination, capacity);
    },
    slot_write(slot: number, source: number, length: number): number {
      return storage.writeSlot(slot, bytes(), source, length);
    },
  } satisfies Record<string, WebAssembly.ImportValue>;

  try {
    const response = await fetch(engineModuleUrl);
    if (!response.ok) {
      throw new Error('The WASI MDK engine module could not be fetched.');
    }
    const instantiated = await WebAssembly.instantiate(
      await response.arrayBuffer(),
      {
        marmot_storage: marmotStorage,
        wasi_snapshot_preview1: wasi,
      },
    );
    const exports = instantiated.instance.exports as MarmotWasiExports;
    state.memory = exports.memory;
    clearEngineCommandInput = (): void => {
      commandInput.fill(0);
      commandInput = new Uint8Array();
    };
    setEngineCommandInput = (input): void => {
      commandInput.fill(0);
      commandInput = input.slice();
    };
    closeEngineStorage = (): void => storage.close();
    return exports;
  } catch (error) {
    commandInput.fill(0);
    storage.close();
    throw error;
  }
}

interface MarmotOpfsStorage {
  close(): void;
  readSlot(
    slot: number,
    wasmMemory: Uint8Array,
    destination: number,
    capacity: number,
  ): number;
  slotLength(slot: number): number;
  writeSlot(
    slot: number,
    wasmMemory: Uint8Array,
    source: number,
    length: number,
  ): number;
}

async function openMarmotOpfsStorage(): Promise<MarmotOpfsStorage> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('marmot-mdk-runtime', {
    create: true,
  });
  const lockFile = await directory.getFileHandle('account-device.lock', {
    create: true,
  });
  const lockHandle = await lockFile.createSyncAccessHandle();
  const handles: FileSystemSyncAccessHandle[] = [];
  try {
    for (const name of [
      'account-device-slot-0.bin',
      'account-device-slot-1.bin',
    ]) {
      const file = await directory.getFileHandle(name, { create: true });
      handles.push(await file.createSyncAccessHandle());
    }
  } catch (error) {
    for (const accessHandle of handles) {
      accessHandle.close();
    }
    lockHandle.close();
    throw error;
  }

  const handle = (slot: number): FileSystemSyncAccessHandle | undefined =>
    Number.isInteger(slot) && slot >= 0 && slot < handles.length
      ? handles[slot]
      : undefined;

  return {
    close(): void {
      for (const accessHandle of handles) {
        accessHandle.close();
      }
      lockHandle.close();
    },
    readSlot(slot, wasmMemory, destination, capacity): number {
      try {
        const accessHandle = handle(slot);
        const size = accessHandle?.getSize();
        if (
          accessHandle === undefined ||
          size === undefined ||
          capacity < size ||
          destination < 0 ||
          destination + size > wasmMemory.length
        ) {
          return -1;
        }
        return accessHandle.read(
          wasmMemory.subarray(destination, destination + size),
          { at: 0 },
        );
      } catch {
        return -1;
      }
    },
    slotLength(slot): number {
      try {
        return handle(slot)?.getSize() ?? -1;
      } catch {
        return -1;
      }
    },
    writeSlot(slot, wasmMemory, source, length): number {
      try {
        const accessHandle = handle(slot);
        if (
          accessHandle === undefined ||
          length <= 0 ||
          source < 0 ||
          source + length > wasmMemory.length
        ) {
          return -1;
        }
        accessHandle.truncate(0);
        const written = accessHandle.write(
          wasmMemory.subarray(source, source + length),
          { at: 0 },
        );
        if (written !== length) {
          return -1;
        }
        accessHandle.truncate(length);
        accessHandle.flush();
        return 0;
      } catch {
        return -1;
      }
    },
  };
}

function isEngineFailure(value: unknown): value is EngineFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}
