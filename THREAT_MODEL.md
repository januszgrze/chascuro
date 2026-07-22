# Chascuro Threat Model

## Protected assets

- Wallet mnemonic and recovery material.
- SDK-owned client database and e-cash notes.
- Federation invite codes, invoices, preimages, and exported bearer notes.
- App-owned profile, federation selection, activity, and secret records.
- The in-memory record-store keyring while the wallet is unlocked.
- The independent Marmot Nostr identity secret, MLS group state, KeyPackages,
  Welcomes, message plaintext, and exact-event retry outbox.

## Trust boundaries

- The browser page and Fedimint Wasm worker share an origin but have separate
  memory and persistence boundaries.
- The app encrypts its own IndexedDB records. It does not encrypt or interpret
  the SDK-owned OPFS database.
- Federation guardians and Lightning gateways are external custodial/network
  dependencies. Previewing metadata is not proof that they are trustworthy.
- QR camera input, pasted text, federation invites, ecash notes, and BOLT11
  invoices are untrusted inputs.
- A compromised browser, extension, device, origin dependency, or unlocked page
  can access secrets visible in that session.
- The Marmot product Worker is same-origin but owns a separate memory boundary.
  The unmodified MDK 0.9.4 Rust engine performs MLS operations in Wasm; the
  app-owned TypeScript host supplies bounded OPFS and relay adapters.
- Nostr relays are untrusted stores and transports. They observe endpoints,
  timing, event kinds, public keys, routing tags, sizes, and availability even
  though message content and MLS state remain encrypted.

## Current controls

- The wallet fails closed when secure context, Web Crypto, IndexedDB, OPFS,
  service worker, or Web Locks capabilities are unavailable.
- App-owned Version 2 storage uses PBKDF2-SHA-256 and AES-GCM for a
  passphrase-wrapped keyring, then a fresh secret and IV for each independently
  authenticated encrypted record.
- Migration from the legacy profile verifies Version 2 read-back before
  deleting the old record and can resume from a migration marker.
- Generic activity contains sanitized operation metadata only. Persisted ecash
  exports and invoices use separate encrypted secret records; a failed
  post-creation write is explicitly surfaced as memory-only rather than
  destroying the only bearer copy.
- Unlock acquires an exclusive origin-scoped Web Lock before decryption or SDK
  open. The owner is released only after SDK close and record-store lock.
- Locking aborts application work, closes the wallet service, waits for queued
  activity persistence, drops the record-store session, and ignores callbacks
  from an older generation.
- The encrypted automatic-lock policy is configurable, with defaults of five
  minutes of inactivity and thirty seconds in the background. Clock rollback
  and unavailable visibility state fail closed.
- Federation preview and join are separate service calls. Join requires an
  approval bound to the candidate the user reviewed.
- Preview shows sanitized guardian origins and blocks unknown networks and
  missing mint support. Mainnet additionally requires an explicit
  acknowledgement that recovery is unvalidated and funds may be lost. A
  sanitized encrypted marker makes a submitted join recoverable when SDK
  success outruns profile persistence.
- Payment confirmation objects are bound to parsed input fingerprints, amounts,
  fees, and expiry so stale UI state cannot be resubmitted as a new intent.
- Concurrent submissions share one controller request. Ecash redemption
  fingerprints are retained only in an encrypted deduplication index.
- Operation coordination deduplicates subscriptions/reconciliation, rejects
  terminal-state regressions, and tears down listeners deterministically.
- Mnemonics and bearer payloads use bounded clearable wrappers, are excluded
  from snapshots and generic errors, and are cleared on the main navigation and
  lock paths. JavaScript memory clearing remains best-effort.
- QR scanning starts only after an explicit user action, prefers the rear
  camera, stops after one candidate, and never submits the result automatically.
- Logs accept allowlisted event codes and coarse error classes only.
- The service worker precaches static build output and defines no runtime
  federation, invoice, e-cash, or payment cache.
- CSP disallows third-party scripts and regular `unsafe-eval`. It permits only
  `wasm-unsafe-eval` for the Fedimint engine. `connect-src` allows HTTPS/WSS
  because arbitrary guardian origins are discovered from invite codes at
  runtime; executable content, frames, fonts, forms, and workers remain
  same-origin.
- The destructive `ERASE` flow closes the SDK, removes the exact
  `fedimint.db` OPFS entry, clears app records and caches, and unregisters
  service workers. It reports failure if any required step fails.
- Chat keys are generated independently from wallet recovery material. The
  database key and identity secret are stored only in the encrypted chat
  namespace, copied into the Worker only while unlocked, and wiped on handoff,
  lock, and disposal on a best-effort basis.
- MDK SQLite images are authenticated and encrypted before alternating OPFS
  checkpoint commits. Wrong keys, corruption, torn writes, partial quota
  writes, and future schema versions fail closed or retain the prior committed
  generation.
- React receives sanitized chat DTOs and opaque conversation IDs only. Group
  IDs, routing tags, KeyPackages, Welcomes, raw relay events, and retry payloads
  stay behind the encrypted service/Worker boundary and never enter URLs.
- Every state-advancing operation is serialized and addressed to an explicit
  MDK group. Failed relay publication retains the exact already-created event
  in a bounded encrypted outbox, preventing stale-state regeneration on retry.
- Relay input has strict URL, frame, event, response, count, and timeout bounds;
  conflicting copies fail closed and arbitrary relay error text is discarded.
- Foreground synchronization is bounded and disabled while hidden. Wallet lock
  quiesces chat before Worker close and record-store lock. The wallet's Web Lock
  also prevents a second cooperating tab from opening chat storage.
- The service worker precaches static MDK Worker/Wasm artifacts but never chat
  identities, invites, messages, relay responses, or application records. A
  waiting update is prompted and does not silently replace the active session.

## Known limitations and release gates

- JavaScript cannot guarantee that secret memory is physically zeroed.
- Vault encryption protects app-owned data at rest, not secrets visible to a
  compromised page, extension, browser, or device while unlocked.
- The SDK-owned OPFS database is outside app-vault encryption. Its sensitive
  record layout and browser-at-rest protections have not been independently
  audited.
- Web Locks prevents concurrent cooperating instances on the same origin; it is
  not protection against a compromised same-origin script.
- Code-only federation discovery broadens network egress to secure HTTPS/WSS
  origins. A compromised same-origin application could therefore transmit data
  to an attacker-controlled secure endpoint even though it still cannot load
  third-party executable code.
- Fake mode tests application behavior only and must never be mistaken for live
  wallet validation.
- SDK 0.1.3 does not provide a hard maximum-fee submission argument. The adapter
  derives a quote from the selected gateway's recognized fee schedule, binds
  confirmation and submission to that exact gateway, and fails closed for
  unknown schedules. A malicious or changing gateway could still return a
  higher post-submission fee, so tiny live fee validation remains a release
  gate.
- Live ecash cancellation/refund and outgoing-payment identifier semantics are
  not proven.
- Clean-profile recovery is not proven, and the installed join path does not
  expose a verified recovery-start sequence. Real-adapter restore input fails
  closed rather than importing words into an unproven flow. This is a stop-ship
  gate.
- Lightning invoice secrets are removed after terminal state. Exported ecash is
  retained through ambiguous/settled states because SDK redemption semantics
  are not yet proven; erase remains the guaranteed local deletion path.
- Exact OPFS deletion is unit-tested but has not been verified after erasing a
  joined, funded test wallet.
- Marmot chat currently has no identity/MLS backup, device transfer, or
  multi-device recovery. Erase or loss of browser storage permanently loses
  local chat identity and history; the UI labels the feature experimental and
  requires explicit consent.
- MLS protects message contents and group authenticity, not relay-visible
  metadata or endpoint correlation. A compromised unlocked origin can still
  read plaintext and keys before encryption or after decryption.
- Chromium is the completed local browser target. Safari compatibility,
  real-device soak testing, storage/transport fuzzing, MDK upgrade rehearsal,
  and independent review remain release gates in WP8 or the dedicated Safari
  pass. Firefox is outside the agreed scope.
- A named test federation, deployment/browser matrix, accessibility audit, and
  independent security review are still required before a beta or real-money
  decision.
