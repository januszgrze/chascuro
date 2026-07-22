#!/bin/sh
set -eu

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

# libsqlite3-sys 0.30.1 predates Rust's wasm32-wasi -> wasm32-wasip1 target
# rename. Its bundled-SQLite build therefore needs the current WASI libc
# sysroot supplied explicitly. We keep SQLite in memory and persist its
# encrypted serialized image through narrow Worker imports, so the legacy
# filesystem VFS is deliberately not enabled.
if [ -n "${WASI_SYSROOT:-}" ]; then
  wasi_sysroot="$WASI_SYSROOT"
elif [ -d /opt/homebrew/opt/wasi-libc/share/wasi-sysroot ]; then
  wasi_sysroot=/opt/homebrew/opt/wasi-libc/share/wasi-sysroot
elif [ -d /usr/local/opt/wasi-libc/share/wasi-sysroot ]; then
  wasi_sysroot=/usr/local/opt/wasi-libc/share/wasi-sysroot
else
  wasi_sysroot=""
fi

if [ -n "$wasi_sysroot" ]; then
  export CFLAGS_wasm32_wasip1="--sysroot=$wasi_sysroot -USQLITE_THREADSAFE -DSQLITE_THREADSAFE=0 -DLONGDOUBLE_TYPE=double -DSQLITE_TEMP_STORE=3 ${CFLAGS_wasm32_wasip1:-}"
fi

export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.90.0}"

exec cargo "$@"
