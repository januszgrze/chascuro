/// <reference lib="webworker" />

import initMdkWasm, {
  relay_publish_fixture as relayPublishFixtureJson,
  relay_subscription_filters as relaySubscriptionFiltersJson,
  runtime_info as runtimeInfoJson,
} from '../../../runtime/marmot-web/pkg/marmot_web_wasm.js';

import {
  MDK_RUNTIME_RPC_SCHEMA_VERSION,
  parseMdkRuntimeInfo,
  type MdkRuntimeErrorResponse,
  type MdkRuntimeInfoRequest,
  type MdkRuntimeRequest,
  type MdkRuntimeResponse,
} from './mdk-runtime-rpc';
import {
  abandonWasiRelayPublish,
  prepareWasiRelayPublish,
  recoverWasiRelayPublish,
  resolveWasiRelayPublish,
  runWasiEngineVector,
} from './mdk-wasi-host';
import { BrowserNostrRelayClient } from './mdk-relay-client';
import {
  isMdkRelayCatchUpProbeRequest,
  isMdkRelayProbeRequest,
  isMdkRelayStateProbeRequest,
  type MdkRelayCatchUpProbeResponse,
  type MdkRelayProbeResponse,
  type MdkRelayStateProbeResponse,
} from './mdk-relay-rpc';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let runtimePromise: Promise<void> | undefined;
let commandQueue: Promise<void> = Promise.resolve();

function initializeRuntime(): Promise<void> {
  runtimePromise ??= initMdkWasm().then(() => undefined);
  return runtimePromise;
}

function invalidRequest(id: number): MdkRuntimeErrorResponse {
  return {
    id,
    ok: false,
    schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
    error: {
      code: 'invalid_request',
      message: 'The MDK runtime request is invalid.',
    },
  };
}

function isRuntimeInfoRequest(value: unknown): value is MdkRuntimeInfoRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const request = value as Partial<MdkRuntimeRequest>;
  return (
    typeof request.id === 'number' &&
    request.method === 'runtime_info' &&
    request.schemaVersion === MDK_RUNTIME_RPC_SCHEMA_VERSION &&
    request.storageKey instanceof Uint8Array &&
    request.storageKey.length === 32
  );
}

async function processCommand(request: unknown): Promise<void> {
  const id =
    typeof request === 'object' &&
    request !== null &&
    typeof (request as { id?: unknown }).id === 'number'
      ? (request as { id: number }).id
      : 0;

  if (
    !isRuntimeInfoRequest(request) &&
    !isMdkRelayProbeRequest(request) &&
    !isMdkRelayCatchUpProbeRequest(request) &&
    !isMdkRelayStateProbeRequest(request)
  ) {
    workerScope.postMessage(invalidRequest(id));
    return;
  }

  try {
    await initializeRuntime();
    if (isMdkRelayStateProbeRequest(request)) {
      const storageKey = request.storageKey.slice();
      try {
        const baseline = (await runWasiEngineVector(storageKey)) as Record<
          string,
          unknown
        >;
        if (!Number.isSafeInteger(baseline.storageGeneration)) {
          throw new Error('The MDK baseline storage generation is invalid.');
        }
        const relay = new BrowserNostrRelayClient({
          allowInsecureLocalhost: import.meta.env.MODE === 'e2e',
        });

        const confirmedPreparation = await prepareWasiRelayPublish(storageKey);
        const acceptedPublish = await relay.publish({
          endpoints: [request.acceptedEndpoint],
          eventId: confirmedPreparation.eventId,
          eventJson: confirmedPreparation.eventJson,
          requiredAcks: 1,
        });
        if (!acceptedPublish.metRequiredAcks) {
          throw new Error(
            'The relay did not accept the confirmed state probe.',
          );
        }
        const confirmed = await resolveWasiRelayPublish(true);

        const rollbackPreparation = await prepareWasiRelayPublish(storageKey);
        const rejectedPublish = await relay.publish({
          endpoints: [request.rejectedEndpoint],
          eventId: rollbackPreparation.eventId,
          eventJson: rollbackPreparation.eventJson,
          requiredAcks: 1,
        });
        if (rejectedPublish.metRequiredAcks) {
          throw new Error(
            'The relay unexpectedly accepted the rollback probe.',
          );
        }
        const rolledBack = await resolveWasiRelayPublish(false);
        if (
          confirmed.stateTransition !== 'confirmed' ||
          rolledBack.stateTransition !== 'rolled_back'
        ) {
          throw new Error('The MDK relay resolution outcome is inconsistent.');
        }

        const interruptedPreparation =
          await prepareWasiRelayPublish(storageKey);
        const interruptedPublish = await relay.publish({
          endpoints: [request.acceptedEndpoint],
          eventId: interruptedPreparation.eventId,
          eventJson: interruptedPreparation.eventJson,
          requiredAcks: 1,
        });
        if (!interruptedPublish.metRequiredAcks) {
          throw new Error(
            'The relay did not accept the interrupted state probe.',
          );
        }
        abandonWasiRelayPublish();
        const recovered = await recoverWasiRelayPublish(storageKey);
        const catchUp = await relay.catchUp({
          endpoints: [request.acceptedEndpoint],
          filtersJson: relaySubscriptionFiltersJson(),
          timeoutMs: import.meta.env.MODE === 'e2e' ? 500 : undefined,
        });
        const recoveredEventAvailable = catchUp.events.some(
          ({ eventId }) => eventId === interruptedPreparation.eventId,
        );
        const durableGenerations = [
          baseline.storageGeneration,
          confirmedPreparation.pendingGeneration,
          confirmed.storageGeneration,
          rollbackPreparation.pendingGeneration,
          rolledBack.storageGeneration,
          interruptedPreparation.pendingGeneration,
          recovered.storageGeneration,
        ] as number[];
        if (
          !durableGenerations.every(
            (generation, index) =>
              index === 0 || generation > durableGenerations[index - 1]!,
          ) ||
          !recoveredEventAvailable
        ) {
          throw new Error('The relay state checkpoint sequence is invalid.');
        }
        const response: MdkRelayStateProbeResponse = {
          id: request.id,
          ok: true,
          result: {
            confirmedEpoch: confirmed.epoch,
            confirmedTransition: confirmed.stateTransition,
            durableGenerations,
            pendingPublishRecovered: recovered.pendingPublishRecovered,
            recoveredEventAvailable,
            rollbackEpoch: rolledBack.epoch,
            rollbackTransition: rolledBack.stateTransition,
            stateVector: 'passed',
          },
          schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
        };
        workerScope.postMessage(response);
      } finally {
        abandonWasiRelayPublish();
        storageKey.fill(0);
        request.storageKey.fill(0);
      }
      return;
    }
    if (isMdkRelayCatchUpProbeRequest(request)) {
      const report = await new BrowserNostrRelayClient({
        allowInsecureLocalhost: import.meta.env.MODE === 'e2e',
      }).catchUp({
        endpoints: request.endpoints,
        filtersJson: relaySubscriptionFiltersJson(),
        timeoutMs: import.meta.env.MODE === 'e2e' ? 500 : undefined,
      });
      const response: MdkRelayCatchUpProbeResponse = {
        id: request.id,
        ok: true,
        result: {
          completedCount: report.completed.length,
          eventCount: report.events.length,
          failedCount: report.failed.length,
          failureCodes: report.failed.map(({ code }) => code),
          maxSourceCount: Math.max(
            0,
            ...report.events.map(
              ({ sourceEndpoints }) => sourceEndpoints.length,
            ),
          ),
          relayVector: report.failed.length === 0 ? 'passed' : 'failed',
        },
        schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
      };
      workerScope.postMessage(response);
      return;
    }
    if (isMdkRelayProbeRequest(request)) {
      const fixture = JSON.parse(relayPublishFixtureJson()) as {
        eventId?: unknown;
        eventJson?: unknown;
      };
      if (
        typeof fixture.eventId !== 'string' ||
        typeof fixture.eventJson !== 'string'
      ) {
        throw new Error('Rust returned an invalid relay fixture.');
      }
      const report = await new BrowserNostrRelayClient({
        allowInsecureLocalhost: import.meta.env.MODE === 'e2e',
      }).publish({
        endpoints: request.endpoints,
        eventId: fixture.eventId,
        eventJson: fixture.eventJson,
        requiredAcks: request.requiredAcks,
      });
      const response: MdkRelayProbeResponse = {
        id: request.id,
        ok: true,
        result: {
          acceptedCount: report.accepted.length,
          eventId: report.eventId,
          failedCount: report.failed.length,
          failureCodes: report.failed.map(({ code }) => code),
          metRequiredAcks: report.metRequiredAcks,
          relayVector: report.metRequiredAcks ? 'passed' : 'failed',
          requiredAcks: report.requiredAcks,
        },
        schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
      };
      workerScope.postMessage(response);
      return;
    }
    const buildInfo = JSON.parse(runtimeInfoJson()) as Record<string, unknown>;
    const storageKey = request.storageKey.slice();
    let engineVector: Record<string, unknown>;
    try {
      engineVector = (await runWasiEngineVector(storageKey)) as Record<
        string,
        unknown
      >;
    } finally {
      storageKey.fill(0);
      request.storageKey.fill(0);
    }
    const response: MdkRuntimeResponse = {
      id: request.id,
      ok: true,
      schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
      result: parseMdkRuntimeInfo({ ...buildInfo, ...engineVector }),
    };
    workerScope.postMessage(response);
  } catch {
    const response: MdkRuntimeErrorResponse = {
      id: request.id,
      ok: false,
      schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
      error: {
        code: 'runtime_unavailable',
        message: 'The MDK runtime could not be started.',
      },
    };
    workerScope.postMessage(response);
  }
}

workerScope.addEventListener(
  'message',
  (event: MessageEvent<unknown>): void => {
    const request = event.data;
    commandQueue = commandQueue.then(
      () => processCommand(request),
      () => processCommand(request),
    );
  },
);
