#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
workspace_dir="$(dirname "$script_dir")"

if [ -n "${WASM_CC:-}" ]; then
  wasm_cc="$WASM_CC"
elif [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
  wasm_cc=/opt/homebrew/opt/llvm/bin/clang
elif [ -x /usr/local/opt/llvm/bin/clang ]; then
  wasm_cc=/usr/local/opt/llvm/bin/clang
else
  wasm_cc="$(command -v clang)"
fi

if [ -n "${WASM_AR:-}" ]; then
  wasm_ar="$WASM_AR"
elif [ -x "$(dirname "$wasm_cc")/llvm-ar" ]; then
  wasm_ar="$(dirname "$wasm_cc")/llvm-ar"
else
  wasm_ar="$(command -v ar)"
fi

export AR_wasm32_unknown_unknown="$wasm_ar"
export CC_wasm32_unknown_unknown="$wasm_cc"
export AR_wasm32_wasip1="$wasm_ar"
export CC_wasm32_wasip1="$wasm_cc"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"

required_wasm_pack_version="wasm-pack 0.13.1"
actual_wasm_pack_version="$(wasm-pack --version 2>/dev/null || true)"
if [ "$actual_wasm_pack_version" != "$required_wasm_pack_version" ]; then
  echo "Expected $required_wasm_pack_version, found ${actual_wasm_pack_version:-nothing}." >&2
  echo "Install it with: cargo install wasm-pack --version 0.13.1 --locked" >&2
  exit 1
fi

required_bindgen_version="wasm-bindgen 0.2.126"
actual_bindgen_version="$(wasm-bindgen --version 2>/dev/null || true)"
if [ "$actual_bindgen_version" != "$required_bindgen_version" ]; then
  echo "Expected $required_bindgen_version, found ${actual_bindgen_version:-nothing}." >&2
  echo "Install it with: cargo install wasm-bindgen-cli --version 0.2.126 --locked" >&2
  exit 1
fi

cd "$workspace_dir"
wasm-pack build \
  --out-dir ../../pkg \
  --release \
  --target web \
  crates/wasm

"$script_dir/cargo-wasm.sh" build --locked --release -p marmot-web-wasi-engine --target wasm32-wasip1
cp \
  target/wasm32-wasip1/release/marmot_web_wasi_engine.wasm \
  pkg/marmot_web_wasi_engine.wasm
