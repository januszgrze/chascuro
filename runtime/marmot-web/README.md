# Marmot Web Runtime

This app-owned Rust workspace compiles the real Marmot MDK engine for the
browser. MDK is consumed unchanged from the exact Git revision recorded in
`Cargo.toml` and `Cargo.lock`.

The workspace owns browser platform integration only:

- a `wasm-bindgen` RPC entry point;
- a dedicated module-worker host;
- durable encrypted SQLite/OPFS storage;
- browser Nostr WebSocket transport;
- account/session lifecycle composition.

It must not reimplement MLS or Marmot protocol state transitions.

## Initial verification

```sh
./scripts/cargo-wasm.sh test -p marmot-web-wasm
./scripts/cargo-wasm.sh test --locked --workspace
./scripts/cargo-wasm.sh check --locked -p marmot-web-wasm --target wasm32-unknown-unknown
./scripts/cargo-wasm.sh check --locked -p marmot-web-wasi-engine --target wasm32-wasip1
./scripts/build-wasm.sh
```

The reproducible packaging command expects the reviewed tool versions:

```sh
cargo install wasm-pack --version 0.13.1 --locked
cargo install wasm-bindgen-cli --version 0.2.126 --locked
```

The wrapper selects a Wasm-capable LLVM clang for C dependencies such as
`secp256k1-sys`. Set `WASM_CC` and `WASM_AR` explicitly when LLVM is installed
elsewhere.

The build emits two Worker-local modules:

- a `wasm-bindgen` transport/parity module targeting
  `wasm32-unknown-unknown`;
- a real-engine reactor targeting `wasm32-wasip1`, because unmodified MDK uses
  `std::time::Instant` and Rust deliberately supplies no clock on
  `wasm32-unknown-unknown`.

The app-owned TypeScript WASI host supplies standard clock, secure randomness,
empty environment, and diagnostic imports. It exposes no filesystem or network
capability. Its separate `marmot_storage` imports accept an app-supplied
32-byte database key and provide synchronous access to two encrypted OPFS
checkpoint slots. The key is not persisted with those slots. This keeps MDK
unmodified while letting its normal `std::time` implementation run in the
browser Worker.

Native workspace tests cross-peel browser output with the exact upstream
`transport-nostr-peeler` in both directions. The upstream crate is not patched
or compiled into the browser modules.

From the repository root, `npm run build:marmot-browser` builds the Rust module
and a production-mode Vite bundle containing a lazy module Worker. Run
`npm run test:e2e:marmot-runtime` to execute the transport vectors plus two
real MDK engines through create, publish rollback, retry invite, bidirectional
messages, and leave inside Chromium.

The runtime persists complete MDK/OpenMLS storage aggregates as an atomically
updated SQLite image, encrypts that image with XChaCha20-Poly1305, and commits
it through alternating flushed OPFS slots. Run
`npm run test:e2e:marmot-runtime:cross-browser` for the capability-aware
Firefox/WebKit matrix. Chromium is the currently proven target; Firefox reload
and Playwright WebKit OPFS support remain release gates.

Generated files under `pkg/` and Cargo build output under `target/` are ignored.
