# Chascuro

A Fedimint wallet with experimental Marmot chat. Chascuro is a mobile-first PWA
with encrypted local application records,
SDK-backed identity setup, federation onboarding, ecash, Lightning receive and
bounded Lightning pay flows (including payer-selected LNURL-pay and Lightning
Address amounts), durable activity, lifecycle locking, QR tools, and destructive
erasure.

The optional experimental chat product runs pinned, unmodified Rust MDK 0.9.4
inside a same-origin Worker/Wasm runtime. Its current product UI supports real
identity, invites, text groups, QR address scanning, and Fedimint ecash cards.

The app is ready only for a named tiny-funds compatibility phase; no live wallet
flow has passed yet. Normal development and production use the real Fedimint
adapter. A clearly labelled deterministic simulation is available only through
an explicit command, and production rejects fake mode. A production build is
not evidence that live payments or recovery work.

## Start locally

Use Node 24 LTS:

```sh
npm install
npm run dev
```

Open the URL shown by Vite. `npm run dev` uses the real Fedimint SDK. The
deterministic development simulation is available only when explicitly
requested with `npm run dev:fake`.

For repeated federation compatibility tests, a disposable real-SDK wallet can
skip passphrase entry and mnemonic display/confirmation:

```sh
npm run dev:test-wallet
```

This mode uses a public fixed local passphrase, generates and immediately
discards the mnemonic display, and shows a persistent no-recovery warning. It
is development-only and must be used unfunded or with sats you expect to lose.
Clear the localhost site's data before switching an existing wallet into this
mode.

## Combined wallet + chat production-mode build

Supply one to eight credential-free secure Marmot relays and run:

```sh
VITE_MARMOT_RELAYS=wss://relay.example npm run build:production-chat
```

This builds the Wasm runtime, enables the real MDK service, and verifies that
required MDK assets are present while fake chat data is absent. The resulting
PWA is still experimental: there is no chat backup/device transfer, no saved
contact book, and no live real-Fedimint in-chat ecash test yet. Do not treat the
production-mode build name as a real-money release claim.

Use a fresh browser profile and only a deliberately tiny amount for the first
mainnet Lightning receive/pay checks. Recovery has not passed live validation.

## Verification

Install the pinned Playwright browser once:

```sh
npx playwright install chromium
```

Then run:

```sh
npm run check
npm run test:e2e
npm run test:e2e:sdk
```

The SDK smoke suite uses the real production adapter without joining a
federation. It verifies worker initialization, SDK mnemonic generation, OPFS
database creation, and federation-onboarding readiness in Chromium.

An opt-in live compatibility suite is available after selecting a test
federation:

```sh
export FEDIMINT_TEST_INVITE='...'
npm run test:e2e:live
```

Keep the invite outside source control. The app derives guardian endpoints from
the code, permits only secure HTTPS/WSS connections, previews their sanitized
origins, and still requires explicit trust confirmation before joining.

## Implemented safety boundary

- React does not import the Fedimint SDK; all SDK access is behind a
  framework-neutral wallet service.
- In-chat ecash uses that same wallet service. React sees only amount, status,
  direction, and operation identifiers; bearer notes travel inside the
  MLS-encrypted MDK payload and remain in encrypted wallet/chat records.
- App-owned profile, activity, index, and secret records use an encrypted
  Version 2 store with a passphrase-wrapped keyring and independent record
  envelopes.
- Persisted ecash and invoice copies use encrypted records separate from
  sanitized activity. A post-creation storage failure remains visibly
  memory-only so the only bearer copy is not destroyed.
- Encrypted activity reloads locally. Active-federation unlock, visibility
  resume, and manual refresh request SDK reconciliation, and adapter tests
  reattach restored streams; live pending-state behavior remains unverified.
- Unlock requires exclusive origin-scoped Web Lock ownership. Inactivity and
  background timers lock the wallet and reject late callbacks.
- The PWA precaches same-origin build assets only and has no runtime
  payment/API cache.
- Production fake mode is rejected. Real Lightning send selects an exact
  gateway, derives a pre-payment fee from its recognized fee schedule, binds
  confirmation to that quote, and fails closed if the schedule is unknown.
- Lightning Addresses and LNURL-pay targets resolve directly over HTTPS to an
  expiring opaque offer. The callback invoice must match the exact selected
  amount and metadata hash before it can enter the normal quote/pay flow.
- Mainnet joining requires a separate experimental acknowledgement that
  recovery has not been validated and funds may be lost. Unknown-network and
  missing-mint invites remain blocked.
- Erase closes the SDK, removes the exact SDK-owned `fedimint.db` OPFS entry,
  clears app records and caches, and unregisters service workers.

## Release blockers

Do not use real funds until all of the following are complete:

- a named federation, Bitcoin network, deployment host, and test-fund source
  are selected;
- live preview, join/reopen, ecash, Lightning receive, and operation
  reconciliation pass;
- clean-profile recovery succeeds repeatedly on a second profile/device;
- SDK-owned storage erasure is verified after a joined live wallet;
- accessibility/browser/deployment testing and an independent security review
  pass;
- live Lightning receive and pay pass with a tiny amount, including validation
  that the selected gateway's returned fee does not exceed its quote;
- representative Lightning Address/LNURL services pass deployed-browser CORS
  testing and a tiny payer-selected payment.

For the security boundary, known limitations, and vulnerability-reporting
process, see the [threat model](THREAT_MODEL.md) and
[security policy](SECURITY.md).
