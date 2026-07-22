import { expect, test } from '@playwright/test';

const RELAY = 'ws://127.0.0.1:4877';

test('publishes Rust-produced Marmot events through bounded Worker relay I/O', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain(
    'ws://127.0.0.1:4877',
  );
  await expect(
    page.evaluate(
      (endpoint) =>
        new Promise<string>((resolve, reject) => {
          const socket = new WebSocket(endpoint);
          socket.addEventListener(
            'open',
            () => {
              socket.close(1000, 'preflight complete');
              resolve('opened');
            },
            { once: true },
          );
          socket.addEventListener(
            'error',
            () => reject(new Error('Page WebSocket preflight failed.')),
            { once: true },
          );
        }),
      `${RELAY}/preflight`,
    ),
  ).resolves.toBe('opened');

  const probe = async (paths: readonly string[], requiredAcks: number) =>
    page.evaluate(
      async ({ endpoints, requiredAcks }) => {
        if (window.__marmotRelayProbe === undefined) {
          throw new Error('The Marmot relay probe is not installed.');
        }
        return window.__marmotRelayProbe(endpoints, requiredAcks);
      },
      {
        endpoints: paths.map((path) => `${RELAY}/${path}`),
        requiredAcks,
      },
    );
  const catchUp = async (paths: readonly string[]) =>
    page.evaluate(
      async (endpoints) => {
        if (window.__marmotRelayCatchUpProbe === undefined) {
          throw new Error('The Marmot relay catch-up probe is not installed.');
        }
        return window.__marmotRelayCatchUpProbe(endpoints);
      },
      paths.map((path) => `${RELAY}/${path}`),
    );

  const accepted = await probe(['accept'], 1);
  expect(accepted, browserErrors.join('\n')).toMatchObject({
    acceptedCount: 1,
    failedCount: 0,
    failureCodes: [],
    metRequiredAcks: true,
    relayVector: 'passed',
    requiredAcks: 1,
  });
  expect(accepted.eventId).toMatch(/^[0-9a-f]{64}$/u);

  await expect(probe(['accept', 'reject'], 1)).resolves.toMatchObject({
    acceptedCount: 1,
    failedCount: 1,
    failureCodes: ['publish_rejected'],
    metRequiredAcks: true,
    relayVector: 'passed',
    requiredAcks: 1,
  });
  await expect(probe(['accept', 'reject'], 2)).resolves.toMatchObject({
    acceptedCount: 1,
    failedCount: 1,
    failureCodes: ['publish_rejected'],
    metRequiredAcks: false,
    relayVector: 'failed',
    requiredAcks: 2,
  });
  await expect(probe(['malformed'], 1)).resolves.toMatchObject({
    acceptedCount: 0,
    failureCodes: ['invalid_response'],
    metRequiredAcks: false,
    relayVector: 'failed',
  });
  await expect(probe(['duplicate'], 1)).resolves.toMatchObject({
    acceptedCount: 1,
    failedCount: 0,
    metRequiredAcks: true,
  });
  await expect(probe(['delayed'], 1)).resolves.toMatchObject({
    acceptedCount: 1,
    failedCount: 0,
    metRequiredAcks: true,
  });

  const deduplicated = await catchUp(['catchup', 'catchup-duplicate']);
  expect(deduplicated).toMatchObject({
    completedCount: 2,
    failedCount: 0,
    failureCodes: [],
    maxSourceCount: 2,
    relayVector: 'passed',
  });
  expect(deduplicated.eventCount).toBeGreaterThan(0);
  await expect(catchUp(['catchup-empty'])).resolves.toMatchObject({
    completedCount: 1,
    eventCount: 0,
    failedCount: 0,
    relayVector: 'passed',
  });
  await expect(catchUp(['catchup-reordered'])).resolves.toMatchObject({
    completedCount: 1,
    eventCount: deduplicated.eventCount,
    failedCount: 0,
    relayVector: 'passed',
  });
  await expect(catchUp(['catchup-delayed'])).resolves.toMatchObject({
    completedCount: 1,
    eventCount: deduplicated.eventCount,
    failedCount: 0,
    relayVector: 'passed',
  });
  await expect(catchUp(['catchup-malformed'])).resolves.toMatchObject({
    completedCount: 0,
    failedCount: 1,
    failureCodes: ['invalid_response'],
    relayVector: 'failed',
  });
  await expect(catchUp(['catchup-conflict'])).resolves.toMatchObject({
    completedCount: 0,
    failedCount: 1,
    failureCodes: ['conflicting_event'],
    relayVector: 'failed',
  });
  await expect(catchUp(['catchup-closed'])).resolves.toMatchObject({
    completedCount: 0,
    failedCount: 1,
    failureCodes: ['subscription_closed'],
    relayVector: 'failed',
  });
  await expect(catchUp(['catchup-silent'])).resolves.toMatchObject({
    completedCount: 0,
    failedCount: 1,
    failureCodes: ['subscription_timeout'],
    relayVector: 'failed',
  });

  const state = await page.evaluate(
    async ({ acceptedEndpoint, rejectedEndpoint }) => {
      if (window.__marmotRelayStateProbe === undefined) {
        throw new Error('The Marmot relay state probe is not installed.');
      }
      return window.__marmotRelayStateProbe(
        acceptedEndpoint,
        rejectedEndpoint,
        '34'.repeat(32),
      );
    },
    {
      acceptedEndpoint: `${RELAY}/accept`,
      rejectedEndpoint: `${RELAY}/reject`,
    },
  );
  expect(state).toMatchObject({
    confirmedEpoch: 3,
    confirmedTransition: 'confirmed',
    pendingPublishRecovered: true,
    recoveredEventAvailable: true,
    rollbackEpoch: 3,
    rollbackTransition: 'rolled_back',
    stateVector: 'passed',
  });
  expect(state.durableGenerations).toHaveLength(7);
  expect(
    state.durableGenerations.every(
      (generation, index) =>
        index === 0 || generation > state.durableGenerations[index - 1]!,
    ),
  ).toBe(true);
  expect(
    browserErrors.filter(
      (message) =>
        !(
          message.includes('Content-Security-Policy') &&
          message.includes('font-src') &&
          message.includes('data:font/')
        ) &&
        !(
          message.startsWith("Loading the font 'data:font/") &&
          message.includes(
            `Content Security Policy directive: "font-src 'self'"`,
          )
        ),
    ),
  ).toEqual([]);
});
