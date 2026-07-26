# Chascuro multi-federation Lightning plan and implementation status

## Revised product scope

Chascuro will add one onboarding option for joining multiple federations, then
show the connected federations and their balances in the existing advanced
Network settings panel. Multi-federation payment behavior remains behind the
existing wallet service boundary, with no other UI changes.

The implemented milestone:

- let the user manually join a small set of federations during onboarding;
- remove the Observer catalogue and every Observer dependency;
- add an “Add another federation” option to onboarding;
- add a read-only connected-federation list to advanced Network settings;
- keep the home, receive, send, and activity flows unchanged;
- follow the Fedimint SDK's client-per-federation model, using a stable SDK
  client name for each federation;
- choose one federation whenever a new Lightning invoice is created; and
- pay an outgoing Lightning invoice from one federation that can cover the
  complete amount and fee.

Cross-federation partial MPP is not part of the implemented milestone. The
installed SDK has no partial-payment RPC, so the MPP phases below remain a
future protocol roadmap rather than dormant application code.

This is not the original broader pooled-wallet product. Federation discovery,
federation-management UI, exposure controls, automatic rebalancing, and an
interactive federation-management screen remain outside this plan.

## Scope clarifications

### Multiple federations during onboarding

Reuse the existing invite entry, federation preview, and trust-confirmation
screens for every federation. After a successful join, the onboarding-ready
step offers:

- **Add another federation**, which returns to the existing invite screen; and
- **Go to wallet**, which completes onboarding.

The user may continue with one federation or add up to three. Every additional
federation must pass the same preview, network, module, and trust checks as the
first. Reject duplicate federation IDs and mixed Bitcoin networks before
joining. Persist each successful join before returning to the invite screen so
a reload cannot lose an SDK client that has already been created.

Outside onboarding, the only planned UI change is the read-only list of
connected federations and balances in advanced Network settings. Do not add
post-onboarding federation management or selection.

### Existing non-Lightning behavior

Keep the current ecash and Lightning choices in the wallet UI exactly as they
are. The portfolio exposes a combined balance through the existing balance
field.

Ecash, chat payments, and on-chain actions remain single-federation operations
and are not split across federations. For this phase, preserve their current
primary-federation behavior. This creates a known temporary limitation: the
combined balance can exceed the amount spendable by the ecash action. If the
primary federation cannot cover an ecash spend, return the existing
insufficient-funds error even if the portfolio total is sufficient. A later
change can refine this behavior without expanding the present Lightning scope.

## SDK compatibility gap and required prerequisite

The idea is possible within the intended architecture. The limitation is in
the public API of the SDK version currently installed by Chascuro, not in the
underlying named-client or Wasm design.

The intended SDK model is one named client per joined federation. Chascuro
should use that model instead of inventing a second federation database or
running one browser worker per federation.

The installed `@fedimint/core@0.1.3` cannot safely construct more than one
client-scoped wallet on a shared worker through its public API:

- `WalletDirector.createWallet()` constructs a wallet using the default client
  name.
- `FedimintWallet.open(clientName)` and `joinFederation(..., clientName)` can
  send a different name to the worker, but the wallet's balance, Lightning,
  mint, federation, recovery, and on-chain services remain bound to the name
  passed to the constructor.
- `FedimintWallet.cleanup()` closes the shared transport/worker, so it is not a
  per-federation close operation.

The worker RPC already understands named clients, so this does not require a
new Chascuro wallet architecture. For this fixed onboarding portfolio, the
minimum missing SDK surface is a way to construct every child wallet and its
services with the requested client name.

The current SDK main branch still has the same `createWallet()` limitation, and
its multiple-federations guide is currently a placeholder. An older reference
wallet uses legacy `listClients`, `openWallet`, and `getWallet` helpers from
`@fedimint/core-web`; those are not the API Chascuro currently depends on.

Do not work around this by opening the same OPFS database from multiple workers.
Before portfolio work, either upgrade to a released SDK that fixes client
scoping or contribute/use a narrowly pinned SDK change that provides:

```ts
interface MultiClientWalletDirector {
  createWallet(clientName: string): Promise<FedimintWallet>;
}
```

The exact API name may follow the upstream SDK. Chascuro can reopen the known
client names from its encrypted portfolio, cancel every child subscription at
lock, and clean up the shared transport once for the entire session. Client
listing and per-client close APIs are useful future SDK additions, but they are
not prerequisites while federation removal and post-onboarding management are
out of scope.

The required behavior is:

- every child service is constructed with the same client name used to
  join/open it;
- all clients share one initialized director, worker, mnemonic, and SDK
  database;
- child wallets do not individually call `cleanup()` while other clients are
  active;
- final session cleanup terminates the worker only after all subscriptions are
  stopped; and
- balances and operation subscriptions cannot leak between named clients.

## Target architecture

```mermaid
flowchart TD
    I["Repeated invite entry during onboarding"] --> P["Encrypted federation portfolio"]
    P --> M["Portfolio wallet service"]
    M --> U["Existing WalletService contract"]
    U --> UI["Existing wallet UI plus read-only federation details"]
    M --> R["Lightning receive router"]
    M --> S["Single-source Lightning send selector"]
    R --> O["One federation per invoice"]
    S --> F["One full payment when possible"]
    F -. "future protocol work" .-> B["Durable partial-MPP batch"]
```

The UI continues to call the existing `createInvoice`, `quotePayment`, and
`pay` methods. Federation selection and MPP coordination remain below that
boundary.

## Release gate: prove the SDK multi-client lifecycle

The application adapter now constructs named clients through the pinned SDK's
`testing` export because the public director cannot do so. Before treating this
implementation as release-ready, add a repeatable integration test that proves
one SDK database and one worker can:

1. join two regtest federations using two stable UUID client names;
2. list or reopen both clients after a worker restart;
3. read distinct balances from both clients;
4. create an invoice from either client;
5. receive operation updates only from the addressed client; and
6. close the whole session without leaving a database or worker locked.

Add this to `test:e2e:sdk` or a new focused SDK test command. Until it passes
with the pinned SDK version, multi-client restart and OPFS lifecycle behavior
remain unproven release risks.

## Phase 1: add the encrypted federation portfolio

Replace the persisted single `activeFederation` field with a versioned
portfolio while retaining a designated primary federation for legacy
single-federation actions and the unchanged settings display.

```ts
interface FederationPortfolio {
  readonly primaryFederationId: FederationId;
  readonly federations: readonly ActiveFederation[];
}
```

Requirements:

- migrate the existing profile by wrapping `activeFederation` in a one-entry
  portfolio;
- after each successful onboarding join, let the user either add another
  federation through the existing invite/review screens or continue to the
  wallet;
- allow one to three portfolio entries during onboarding;
- assign and persist one stable UUID SDK client name per federation;
- reject duplicate federation IDs and duplicate client names;
- require all entries to use the same Bitcoin network;
- keep raw invite codes out of the persisted portfolio;
- open all known clients under the existing exclusive wallet-session lock;
- stop all child subscriptions before closing the shared SDK transport;
- ignore callbacks from an older locked or disposed generation; and
- preserve the current pending-join durability rules for every manual join.

Introduce a portfolio-backed implementation behind the existing
`WalletService` interface. Limit React changes to the onboarding-ready action,
its state-machine transition, and the connected-federation summaries exposed in
the existing advanced Network panel.

`OperationKey` already includes `federationId + operationId`; preserve that
identity for all child operations. Aggregate only at the portfolio boundary,
never by discarding the child federation ID.

## Phase 2: route incoming Lightning invoices

Each invoice remains a normal invoice created by exactly one federation and
one gateway.

When `createInvoice` is called:

1. refresh the balance of every open federation client;
2. if the combined balance is zero, select the primary federation;
3. otherwise score every client using projected post-receive allocation and
   break ties deterministically by federation ID;
4. require Lightning support on the selected federation;
5. refresh that client's gateway cache, prefer a valid vetted gateway and
   otherwise select the first valid gateway returned by `listGateways()`, then
   bind the request to that gateway explicitly;
6. call `createInvoice` exactly once through that federation and gateway; and
7. return the existing `LightningReceive` shape to the UI.

For equal target weights, a suitable base score is the projected deviation
from the equal allocation after adding the invoice amount. This naturally sends
successive receives toward the least-funded federation without adding user
configuration.

Safety rules:

- once an invoice is returned to the UI, it never changes federation;
- do not fall back to another federation or create a second invoice when
  balance refresh, gateway selection, invoice creation, or invoice lifecycle
  handling fails;
- never replace or redirect an already presented invoice;
- restore the chosen client when recovering an encrypted invoice;
- do not redistribute funds after receipt; and
- do not use catalogue ratings or cached third-party health data.

The current receive screen and its props must not change.

## Phase 3: validate receive routing

Unit tests:

- equal and unequal balances;
- deterministic tie-breaking;
- an all-zero portfolio selecting the primary federation;
- missing Lightning module;
- no usable gateway;
- selected-route failure creating no second invoice;
- no fallback after presentation;
- profile migration and duplicate rejection; and
- stale-session callbacks being ignored.

SDK/regtest tests:

- invoices can be created through both named clients;
- repeated receives move balances toward the target allocation;
- restart restores the client associated with a pending invoice; and
- locking cancels unfinished selection/invoice work without killing a future
  unlock.

Milestone: repeated incoming Lightning payments are distributed across the
federations joined during onboarding with no changes to the receive UI.

## Phase 4: add partial-MPP capability end to end

NUT-15 is a Cashu specification, so this implementation should be described as
“NUT-15-inspired” unless Fedimint adopts a compatible specification. The useful
pattern is:

1. quote the same BOLT11 invoice at multiple issuers/gateways with an explicit
   partial amount;
2. ensure partial amounts sum exactly to the invoice amount; and
3. submit all partial payments concurrently so the Lightning receiver releases
   the shared preimage only when the complete MPP arrives.

The installed Fedimint SDK exposes only full-invoice payment. The current
Fedimint gateway Lightning trait also pays a complete invoice and has no
partial-amount argument. This phase therefore requires a separately testable
change through the whole stack:

- web SDK and Wasm RPC;
- Fedimint Lightning client;
- funded outgoing contract calculation;
- gateway request and capability advertisement; and
- supported Lightning backends.

The protocol must carry:

- the original invoice and payment hash;
- the shard amount in millisats;
- the invoice total amount in millisats;
- a stable batch ID and shard ID;
- a hard per-shard and total fee ceiling;
- an advertised minimum shard amount;
- an idempotency key; and
- enough invoice data for the Lightning backend's MPP/payment-address rules.

Do not assume all gateways support this. Partial MPP is eligible only when every
selected client/gateway explicitly advertises and successfully quotes it.

This phase belongs behind a regtest-only feature flag until refund, retry,
expiry, and crash behavior are proven. No production fallback may reinterpret
a partial-MPP request as a full-invoice payment.

## Phase 5: outgoing Lightning planner

Keep the existing parse and confirmation UI. `quotePayment` becomes a portfolio
quote:

1. prefer one healthy federation that can cover the full amount and fee;
2. use partial MPP only when no eligible single federation can pay;
3. use the fewest shards necessary;
4. prefer spending from over-allocated federations;
5. request and validate every partial quote before returning one combined quote
   to the UI; and
6. bind the confirmed quote to the invoice fingerprint, complete shard plan,
   gateway identities, expiries, and total maximum fee.

Every plan must prove:

- shard amounts sum exactly to the invoice amount;
- each federation covers its shard plus its maximum fee;
- every shard satisfies its gateway minimum;
- every selected gateway advertises compatible partial MPP;
- all quotes remain valid through confirmation;
- total maximum fees fit the user's existing fee limit; and
- the output is deterministic for the same inputs.

Do not add arbitrary payment-size thresholds for the number of federations.
Liquidity, fees, capability, and the “fewest shards” rule are sufficient.

## Phase 6: durable MPP batch coordinator

The current wallet API and activity UI expect one outgoing operation. Persist
one parent payment batch and keep its federation shards as internal child
operations.

```ts
interface LightningPaymentBatch {
  readonly batchId: string;
  readonly invoiceFingerprint: PaymentFingerprint;
  readonly amountMsats: Msats;
  readonly maximumFeeMsats: Msats;
  readonly state: LightningBatchState;
  readonly shards: readonly LightningPaymentShard[];
}
```

Suggested states:

```text
draft -> quoted -> confirmed -> dispatching -> settling -> settled
                                      |             |
                                      v             v
                                 reconciling -> refunding -> refunded/failed
```

After the existing UI confirmation:

1. persist the confirmed batch and all shard IDs;
2. submit all quoted partial payments concurrently;
3. persist every returned federation operation ID;
4. reconcile every ambiguous child before retrying;
5. derive the parent state from all children and the shared preimage; and
6. expose one synthetic/parent `lightning_send` operation through the existing
   activity contract.

Critical rules:

- persist before and after every non-idempotent external side effect;
- never start a full-invoice fallback after any shard may have been dispatched;
- retry only operations whose SDK/gateway contract is demonstrably idempotent;
- treat the receiver's valid preimage as proof of payment settlement;
- continue reconciling and refunding incomplete child contracts after the
  preimage is known;
- never report an unknown child as failed merely to make the parent terminal;
  and
- retain enough encrypted state to resume after lock, reload, or crash.

The original plan's separate `preparePartialPayment` and
`dispatchPartialPayment` stages are not assumed. Add such a two-phase protocol
only if the Fedimint client and gateway explicitly implement it; NUT-15 itself
does not require that API.

## Phase 7: MPP validation and release gates

Planner tests:

- one federation can pay, so MPP is not used;
- two and three federation splits;
- exact millisat summation;
- insufficient aggregate funds;
- per-gateway minimum shard amounts;
- quote expiry;
- total fee ceiling;
- unsupported gateway exclusion; and
- deterministic planning.

Coordinator/regtest tests:

- two independent Lightning backends complete one MPP invoice;
- all children return the same preimage;
- one shard fails before dispatch;
- one shard becomes ambiguous during dispatch;
- wallet reload during dispatch and settlement;
- quote expiry between confirmation and submission;
- delayed contract cancellation/refund;
- duplicate submission with the same batch/shard IDs;
- no full-payment fallback after partial dispatch; and
- the unchanged UI shows one outgoing payment, not one row per shard.

Release gates:

- pin the exact SDK, Fedimint client, gateway, and Lightning backend revisions;
- update `THREAT_MODEL.md` with multi-client OPFS and MPP failure modes;
- keep fake-wallet tests separate from protocol claims;
- complete live regtest testing with at least two federations and two gateways;
- obtain independent review of batch idempotency, preimage handling, and refund
  recovery; and
- continue to prohibit real-funds use until existing recovery gates and these
  new gates pass.

## Explicit non-goals

- Observer API or any federation catalogue;
- post-onboarding federation-management or federation-selection UI;
- UI changes beyond onboarding and the read-only advanced Network details;
- splitting an incoming invoice across federations;
- background fund redistribution;
- configurable allocation weights or exposure limits;
- automatic federation replacement/removal;
- splitting ecash or chat payments across federations;
- changing guardian consensus; and
- claiming Fedimint NUT-15 compatibility without an adopted Fedimint protocol.

## Implemented-milestone acceptance criteria

The current milestone is complete when:

1. onboarding lets the user manually join one to three federations using the
   existing invite preview and trust flow;
2. all joined named SDK clients reopen safely from one wallet session;
3. advanced Network settings show all connected federations and balances, with
   no other post-onboarding UI changes;
4. each new Lightning receive is deterministically assigned to one eligible
   federation and remains bound to it;
5. a normal outgoing payment uses one federation whenever possible;
6. an invoice that no single federation can fund fails with insufficient
   balance rather than drafting or dispatching an unsupported split payment;
7. crash/reload reconciliation preserves each operation's federation identity;
   and
8. live two-federation restart, receive, and gateway-failure cases pass before
   any real-funds claim.

Phases 4–7 define separate future acceptance criteria for partial MPP. They do
not describe behavior currently shipped by Chascuro.
