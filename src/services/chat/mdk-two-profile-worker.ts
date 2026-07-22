/// <reference lib="webworker" />

import { BrowserNostrRelayClient } from './mdk-relay-client';
import type {
  MdkTwoProfileResult,
  MdkTwoProfileWorkerRequest,
  MdkTwoProfileWorkerResponse,
} from './mdk-two-profile-rpc';
import {
  closeWasiProfile,
  createWasiProfileGroup,
  createWasiProfileKeyPackage,
  ingestWasiProfileEvents,
  joinWasiProfileWelcome,
  openWasiProfile,
  readWasiProfileStatus,
  resolveWasiProfileGroup,
  sendWasiProfileText,
} from './mdk-wasi-host';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const relay = new BrowserNostrRelayClient({
  allowInsecureLocalhost: import.meta.env.MODE === 'e2e',
});
let commandQueue: Promise<void> = Promise.resolve();
let relayEndpoint: string | undefined;
let relayGroup: string | undefined;
let relayRecipient: string | undefined;

function endpoint(): string {
  if (relayEndpoint === undefined) {
    throw new Error('The two-profile runtime is not open.');
  }
  return relayEndpoint;
}

function recipient(): string {
  if (relayRecipient === undefined) {
    throw new Error('The two-profile recipient identity is not open.');
  }
  return relayRecipient;
}

function group(): string {
  if (relayGroup === undefined) {
    throw new Error('The two-profile group routing identity is not open.');
  }
  return relayGroup;
}

async function publish(eventId: string, eventJson: string): Promise<void> {
  const report = await relay.publish({
    endpoints: [endpoint()],
    eventId,
    eventJson,
    requiredAcks: 1,
  });
  if (!report.metRequiredAcks) {
    throw new Error('The local relay did not acknowledge the Marmot event.');
  }
}

async function catchUp(kind: number): Promise<readonly string[]> {
  const filter: Record<string, unknown> = { kinds: [kind], limit: 256 };
  if (kind === 1_059) filter['#p'] = [recipient()];
  if (kind === 445) filter['#h'] = [group()];
  const report = await relay.catchUp({
    endpoints: [endpoint()],
    filtersJson: JSON.stringify([filter]),
    timeoutMs: import.meta.env.MODE === 'e2e' ? 1_000 : undefined,
  });
  if (report.failed.length !== 0 || report.completed.length !== 1) {
    throw new Error('The local relay catch-up did not complete.');
  }
  return report.events.map(({ eventJson }) => eventJson);
}

async function processCommand(
  request: MdkTwoProfileWorkerRequest,
): Promise<void> {
  try {
    const { command } = request;
    let result: MdkTwoProfileResult;
    switch (command.method) {
      case 'open': {
        relayEndpoint = command.relayEndpoint;
        try {
          result = await openWasiProfile(command.storageKey, command.role);
        } finally {
          command.storageKey.fill(0);
        }
        break;
      }
      case 'publish_key_package': {
        const prepared = await createWasiProfileKeyPackage();
        await publish(prepared.eventId, prepared.eventJson);
        result = prepared;
        break;
      }
      case 'create_group': {
        const keyPackages = await catchUp(30_443);
        const keyPackage = keyPackages.at(-1);
        if (keyPackage === undefined) {
          throw new Error('No Marmot KeyPackage was available from the relay.');
        }
        const prepared = await createWasiProfileGroup(keyPackage, endpoint());
        let accepted = false;
        try {
          await publish(prepared.eventId, prepared.eventJson);
          accepted = true;
        } finally {
          result = await resolveWasiProfileGroup(accepted);
        }
        break;
      }
      case 'join': {
        const welcomes = await catchUp(1_059);
        const welcome = welcomes.at(-1);
        if (welcome === undefined) {
          throw new Error('No Marmot Welcome was available from the relay.');
        }
        result = await joinWasiProfileWelcome(welcome);
        break;
      }
      case 'send': {
        const prepared = await sendWasiProfileText(command.content);
        await publish(prepared.eventId, prepared.eventJson);
        result = prepared;
        break;
      }
      case 'sync': {
        result = await ingestWasiProfileEvents(await catchUp(445));
        break;
      }
      case 'status': {
        result = await readWasiProfileStatus();
        break;
      }
      case 'close': {
        const status = await readWasiProfileStatus();
        closeWasiProfile();
        relayEndpoint = undefined;
        relayGroup = undefined;
        relayRecipient = undefined;
        result = status;
        break;
      }
    }
    if (command.method !== 'close') {
      relayGroup = result.routingGroupId ?? undefined;
      relayRecipient = result.nostrPubkey;
    }
    const response: MdkTwoProfileWorkerResponse = {
      id: request.id,
      ok: true,
      result,
    };
    workerScope.postMessage(response);
  } catch (error) {
    const response: MdkTwoProfileWorkerResponse = {
      error: {
        message:
          error instanceof Error
            ? error.message
            : 'The two-profile MDK command failed.',
      },
      id: request.id,
      ok: false,
    };
    workerScope.postMessage(response);
  }
}

workerScope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data as MdkTwoProfileWorkerRequest;
  commandQueue = commandQueue.then(
    () => processCommand(request),
    () => processCommand(request),
  );
});
