/// <reference lib="webworker" />

import { BrowserNostrRelayClient } from './mdk-relay-client';
import type {
  MdkProductCommand,
  MdkProductInvite,
  MdkProductResult,
  MdkProductWorkerRequest,
  MdkProductWorkerResponse,
} from './mdk-product-rpc';
import {
  advanceWasiProductProfileConvergence,
  closeWasiProfile,
  createWasiProfileGroup,
  createWasiProfileKeyPackage,
  ingestWasiProductProfileEvents,
  joinWasiProfileWelcome,
  leaveWasiProductProfile,
  openWasiProductProfile,
  readWasiProfileStatus,
  resolveWasiProfileGroup,
  resolveWasiProductProfileAutoPublish,
  sendWasiProductProfileText,
} from './mdk-wasi-host';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const relay = new BrowserNostrRelayClient({
  allowInsecureLocalhost:
    import.meta.env.MODE === 'e2e' ||
    (import.meta.env.DEV &&
      import.meta.env.VITE_MARMOT_ALLOW_INSECURE_LOCALHOST === 'true'),
});
let commandQueue: Promise<void> = Promise.resolve();
let relayEndpoints: readonly string[] = [];
const relayGroups = new Map<string, string>();
let relayRecipient: string | undefined;

async function processCommand(request: MdkProductWorkerRequest): Promise<void> {
  try {
    const result = await execute(request.command);
    const response: MdkProductWorkerResponse = {
      id: request.id,
      ok: true,
      result,
    };
    workerScope.postMessage(response);
  } catch (error) {
    const response: MdkProductWorkerResponse = {
      id: request.id,
      ok: false,
      error: { code: errorCode(error) },
    };
    workerScope.postMessage(response);
  }
}

async function execute(command: MdkProductCommand): Promise<MdkProductResult> {
  switch (command.method) {
    case 'open': {
      relayEndpoints = [...command.relayEndpoints];
      try {
        return rememberStatus(
          await openWasiProductProfile(
            command.storageKey,
            command.identitySecret,
          ),
        );
      } finally {
        command.storageKey.fill(0);
        command.identitySecret.fill(0);
      }
    }
    case 'initialize_identity': {
      const prepared = await createWasiProfileKeyPackage();
      await publishOrThrow(prepared.eventId, prepared.eventJson);
      return rememberStatus(prepared);
    }
    case 'create_conversation': {
      const report = await catchUp([
        { kinds: [30_443], authors: [command.targetPubkey], limit: 16 },
      ]);
      const keyPackage = newestEvent(
        report.events.map(({ eventJson }) => eventJson),
      );
      if (keyPackage === undefined)
        throw new ProductWorkerError('invite_invalid');
      const prepared = await createWasiProfileGroup(
        keyPackage,
        relayEndpoints[0]!,
      );
      let accepted = false;
      try {
        await publishOrThrow(prepared.eventId, prepared.eventJson);
        accepted = true;
      } finally {
        const result = await resolveWasiProfileGroup(accepted);
        rememberStatus(result);
      }
      return rememberStatus(await readWasiProfileStatus());
    }
    case 'list_invites': {
      const report = await catchUp([
        { kinds: [1_059], '#p': [recipient()], limit: 256 },
      ]);
      const invites = report.events
        .map(({ eventId, eventJson }) => summarizeInvite(eventId, eventJson))
        .sort((left, right) => left.receivedAt - right.receivedAt);
      return { ...rememberStatus(await readWasiProfileStatus()), invites };
    }
    case 'accept_invite': {
      const report = await catchUp([
        {
          ids: [command.inviteId],
          kinds: [1_059],
          '#p': [recipient()],
          limit: 1,
        },
      ]);
      const welcome = report.events.find(
        ({ eventId }) => eventId === command.inviteId,
      )?.eventJson;
      if (welcome === undefined) throw new ProductWorkerError('invite_invalid');
      return rememberStatus(await joinWasiProfileWelcome(welcome));
    }
    case 'leave': {
      routingGroup(command.groupId);
      const prepared = await leaveWasiProductProfile(command.groupId);
      await publishOrThrow(prepared.eventId, prepared.eventJson);
      return rememberStatus(prepared);
    }
    case 'send': {
      routingGroup(command.groupId);
      const prepared = await sendWasiProductProfileText(
        command.groupId,
        command.content,
        command.createdAt,
      );
      const published = await publish(prepared.eventId, prepared.eventJson);
      return {
        ...rememberStatus(prepared),
        eventId: prepared.eventId,
        eventJson: prepared.eventJson,
        published,
      };
    }
    case 'retry': {
      const published = await publish(command.eventId, command.eventJson);
      return {
        ...rememberStatus(await readWasiProfileStatus()),
        eventId: command.eventId,
        published,
      };
    }
    case 'sync': {
      const relayGroup = routingGroup(command.groupId);
      const report = await catchUp([
        { kinds: [445], '#h': [relayGroup], limit: 256 },
      ]);
      const ingested = await ingestWasiProductProfileEvents(
        command.groupId,
        report.events.map(({ eventJson }) => eventJson),
      );
      if (report.events.length === 0) return rememberStatus(ingested);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const convergence = await advanceWasiProductProfileConvergence(
        command.groupId,
      );
      if (!convergence.autoPublish) return rememberStatus(ingested);
      if (
        convergence.eventId === undefined ||
        convergence.eventJson === undefined
      ) {
        throw new ProductWorkerError('internal');
      }
      const published = await publish(
        convergence.eventId,
        convergence.eventJson,
      );
      const resolved = await resolveWasiProductProfileAutoPublish(published);
      if (!published) throw new ProductWorkerError('relay_unavailable');
      return rememberStatus({ ...resolved, received: ingested.received });
    }
    case 'status':
      return rememberStatus(await readWasiProfileStatus());
    case 'close': {
      const status = rememberStatus(await readWasiProfileStatus());
      closeWasiProfile();
      relayEndpoints = [];
      relayGroups.clear();
      relayRecipient = undefined;
      return status;
    }
  }
}

function rememberStatus<T extends MdkProductResult>(result: T): T {
  relayGroups.clear();
  for (const group of result.groups) {
    relayGroups.set(group.groupId, group.routingGroupId);
  }
  relayRecipient = result.nostrPubkey;
  return result;
}

function routingGroup(groupId: string): string {
  const route = relayGroups.get(groupId);
  if (route === undefined) throw new ProductWorkerError('invalid_input');
  return route;
}

function recipient(): string {
  if (relayRecipient === undefined) throw new ProductWorkerError('locked');
  return relayRecipient;
}

async function publish(eventId: string, eventJson: string): Promise<boolean> {
  const report = await relay.publish({
    endpoints: relayEndpoints,
    eventId,
    eventJson,
    requiredAcks: 1,
  });
  return report.metRequiredAcks;
}

async function publishOrThrow(
  eventId: string,
  eventJson: string,
): Promise<void> {
  if (!(await publish(eventId, eventJson))) {
    throw new ProductWorkerError('relay_unavailable');
  }
}

async function catchUp(filters: readonly Record<string, unknown>[]) {
  const report = await relay.catchUp({
    endpoints: relayEndpoints,
    filtersJson: JSON.stringify(filters),
    maxEvents: 256,
  });
  if (
    report.completed.length === 0 ||
    report.failed.length === relayEndpoints.length
  ) {
    throw new ProductWorkerError('relay_unavailable');
  }
  return report;
}

function newestEvent(events: readonly string[]): string | undefined {
  return [...events]
    .map((eventJson) => ({ eventJson, createdAt: eventCreatedAt(eventJson) }))
    .sort((left, right) => right.createdAt - left.createdAt)[0]?.eventJson;
}

function summarizeInvite(eventId: string, eventJson: string): MdkProductInvite {
  return { id: eventId, receivedAt: eventCreatedAt(eventJson) };
}

function eventCreatedAt(eventJson: string): number {
  let value: unknown;
  try {
    value = JSON.parse(eventJson);
  } catch {
    throw new ProductWorkerError('internal');
  }
  const createdAt =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { created_at?: unknown }).created_at
      : undefined;
  if (!Number.isSafeInteger(createdAt) || Number(createdAt) < 0) {
    throw new ProductWorkerError('internal');
  }
  return Number(createdAt);
}

class ProductWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function errorCode(error: unknown): string {
  return error instanceof ProductWorkerError ? error.code : 'internal';
}

workerScope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data as MdkProductWorkerRequest;
  commandQueue = commandQueue.then(
    () => processCommand(request),
    () => processCommand(request),
  );
});
