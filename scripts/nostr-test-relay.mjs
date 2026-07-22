import { WebSocketServer } from 'ws';

const portArgument = process.argv.indexOf('--port');
const port =
  portArgument >= 0
    ? Number.parseInt(process.argv[portArgument + 1] ?? '', 10)
    : 4877;
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('The local Nostr relay port is invalid.');
}

const server = new WebSocketServer({
  host: '127.0.0.1',
  maxPayload: 1_048_576,
  port,
});
const retainedEvents = [];

function matchesFilter(event, filter) {
  if (
    Array.isArray(filter.ids) &&
    !filter.ids.some((prefix) =>
      typeof prefix === 'string' ? event.id.startsWith(prefix) : false,
    )
  ) {
    return false;
  }
  if (
    Array.isArray(filter.authors) &&
    !filter.authors.some((prefix) =>
      typeof prefix === 'string' ? event.pubkey.startsWith(prefix) : false,
    )
  ) {
    return false;
  }
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (Number.isInteger(filter.since) && event.created_at < filter.since) {
    return false;
  }
  if (Number.isInteger(filter.until) && event.created_at > filter.until) {
    return false;
  }
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const tagName = key.slice(1);
    if (
      !event.tags.some((tag) => tag[0] === tagName && values.includes(tag[1]))
    ) {
      return false;
    }
  }
  return true;
}

function filteredEvents(events, filters) {
  const selected = [];
  const seen = new Set();
  for (const filter of filters) {
    let matches = events.filter((event) => matchesFilter(event, filter));
    if (Number.isInteger(filter.limit) && filter.limit >= 0) {
      matches = matches.slice(-filter.limit);
    }
    for (const event of matches) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      selected.push(event);
    }
  }
  return selected;
}

function retainEvent(event) {
  if (retainedEvents.some((retained) => retained.id === event.id)) return;
  retainedEvents.push(event);
  if (retainedEvents.length > 32) retainedEvents.shift();
}

server.on('connection', (socket, request) => {
  const mode = new URL(
    request.url ?? '/',
    `ws://127.0.0.1:${port}`,
  ).pathname.slice(1);
  socket.on('message', (bytes, isBinary) => {
    if (isBinary || bytes.length > 1_048_576) {
      socket.close(1003, 'text frames only');
      return;
    }
    let frame;
    try {
      frame = JSON.parse(bytes.toString('utf8'));
    } catch {
      socket.close(1007, 'invalid JSON');
      return;
    }
    const send = (value) => socket.send(JSON.stringify(value));
    if (Array.isArray(frame) && frame[0] === 'REQ') {
      const subscriptionId = frame[1];
      const filters = frame.slice(2);
      if (
        typeof subscriptionId !== 'string' ||
        subscriptionId.length === 0 ||
        subscriptionId.length > 64 ||
        filters.length === 0 ||
        filters.some(
          (filter) =>
            typeof filter !== 'object' ||
            filter === null ||
            Array.isArray(filter),
        )
      ) {
        socket.close(1008, 'invalid subscription');
        return;
      }
      const matchingEvents = filteredEvents(retainedEvents, filters);
      const sendEvents = (events) => {
        for (const event of events) {
          send(['EVENT', subscriptionId, event]);
        }
      };
      switch (mode) {
        case 'catchup-empty':
          send(['EOSE', subscriptionId]);
          break;
        case 'catchup-malformed':
          send(['EVENT', subscriptionId, 'invalid event']);
          break;
        case 'catchup-conflict': {
          const event = matchingEvents[0];
          if (event !== undefined) {
            send(['EVENT', subscriptionId, event]);
            send([
              'EVENT',
              subscriptionId,
              { ...event, content: `${event.content}-conflict` },
            ]);
          }
          send(['EOSE', subscriptionId]);
          break;
        }
        case 'catchup-duplicate':
          for (const event of matchingEvents) {
            send(['EVENT', subscriptionId, event]);
            send(['EVENT', subscriptionId, event]);
          }
          send(['EOSE', subscriptionId]);
          break;
        case 'catchup-reordered':
          sendEvents([...matchingEvents].reverse());
          send(['EOSE', subscriptionId]);
          break;
        case 'catchup-delayed':
          setTimeout(() => {
            sendEvents(matchingEvents);
            send(['EOSE', subscriptionId]);
          }, 75);
          break;
        case 'catchup-silent':
          break;
        case 'catchup-closed':
          send(['CLOSED', subscriptionId, 'relay-private reason']);
          break;
        default:
          sendEvents(matchingEvents);
          send(['EOSE', subscriptionId]);
      }
      return;
    }
    if (
      Array.isArray(frame) &&
      frame[0] === 'CLOSE' &&
      typeof frame[1] === 'string'
    ) {
      return;
    }
    const event =
      Array.isArray(frame) && frame[0] === 'EVENT' ? frame[1] : undefined;
    const eventId =
      typeof event === 'object' &&
      event !== null &&
      typeof event.id === 'string' &&
      /^[0-9a-f]{64}$/u.test(event.id) &&
      typeof event.pubkey === 'string' &&
      /^[0-9a-f]{64}$/u.test(event.pubkey) &&
      Number.isInteger(event.created_at) &&
      event.created_at >= 0 &&
      Number.isInteger(event.kind) &&
      event.kind >= 0 &&
      event.kind <= 65_535 &&
      Array.isArray(event.tags) &&
      event.tags.every(
        (tag) =>
          Array.isArray(tag) && tag.every((value) => typeof value === 'string'),
      ) &&
      typeof event.content === 'string' &&
      typeof event.sig === 'string' &&
      event.sig.length === 128
        ? event.id
        : undefined;
    if (eventId === undefined) {
      socket.close(1008, 'invalid event');
      return;
    }

    switch (mode) {
      case 'reject':
        send(['OK', eventId, false, 'relay-private rejection details']);
        break;
      case 'malformed':
        send(['OK', eventId, 'yes', 'invalid boolean']);
        break;
      case 'duplicate':
        retainEvent(event);
        send(['OK', eventId, true, '']);
        send(['OK', eventId, true, '']);
        break;
      case 'delayed':
        retainEvent(event);
        setTimeout(() => send(['OK', eventId, true, '']), 75);
        break;
      case 'silent':
        break;
      default:
        retainEvent(event);
        send(['OK', eventId, true, '']);
    }
  });
});
server.on('error', (error) => {
  console.error(`Local Nostr relay error: ${error.message}`);
});

const close = () => {
  for (const client of server.clients) client.terminate();
  server.close(() => process.exit(0));
};
process.once('SIGINT', close);
process.once('SIGTERM', close);

await new Promise((resolve) => server.once('listening', resolve));
console.log(`Local Nostr relay listening on ws://127.0.0.1:${port}`);
