#!/usr/bin/env bash
# Canonical environment script for HarmonyOS Native Fabushi / GPUI Telegram (`harmony-telegram`)

export TOOLCHAINS_ROOT="/home/antigravity/toolchains"
export TMPDIR="${TMPDIR:-$TOOLCHAINS_ROOT/tmp}"
export TEMP="$TMPDIR"
export TMP="$TMPDIR"
mkdir -p "$TMPDIR"

export RUSTUP_HOME="$TOOLCHAINS_ROOT/rustup"
export CARGO_HOME="$TOOLCHAINS_ROOT/cargo"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

export OHOS_BASE_SDK_HOME="$TOOLCHAINS_ROOT/ohos-sdk/linux"
export OHOS_SDK_HOME="$OHOS_BASE_SDK_HOME"
export DEVECO_SDK_HOME="$OHOS_BASE_SDK_HOME"
export OHOS_NDK_HOME="$OHOS_BASE_SDK_HOME/20"
export OHOS_SDK_NATIVE="$OHOS_NDK_HOME/native"
export HDC_HOME="$OHOS_NDK_HOME/toolchains"

export HVIGOR_PATH="$TOOLCHAINS_ROOT/ohos-hvigor"
export HVIGOR_USER_HOME="$HVIGOR_PATH/.hvigor"
export NODE_PATH="$HVIGOR_PATH/node_modules"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

export OHOS_SIGNING_DIR="$TOOLCHAINS_ROOT/signing"
export OHOS_SIGN_DIR="$OHOS_SIGNING_DIR"
export OHOS_SIGNING_CONFIG_JSON="$OHOS_SIGNING_DIR/signing-configs.json"
export OHOS_KEYSTORE_P12="$OHOS_SIGNING_DIR/harmonytg.p12"
export OHOS_CERT_FILE="$OHOS_SIGNING_DIR/harmonytg-app.cer"
export OHOS_PROFILE_FILE="$OHOS_SIGNING_DIR/harmonytg-release.p7b"
export OHOS_DEBUG_PROFILE_FILE="$OHOS_SIGNING_DIR/harmonytg-debug.p7b"
export OHOS_KEY_ALIAS="harmonytg-app-key"
export OHOS_KEY_PWD="HarmonyTg@2026!"
export OHOS_STORE_PWD="HarmonyTg@2026!"

export JAVA_TOOL_OPTIONS="-XX:-UsePerfData -Djava.io.tmpdir=$TMPDIR -Djdk.net.hosts.file=$OHOS_SIGNING_DIR/hosts"

# Host & OpenHarmony LLVM NDK cross-compile toolchains for cc / ring / rusqlite / zstd
export HOST_CC="/usr/bin/clang"
export HOST_CXX="/usr/bin/clang++"

export CC_aarch64_unknown_linux_ohos="$OHOS_SDK_NATIVE/llvm/bin/aarch64-unknown-linux-ohos-clang"
export CXX_aarch64_unknown_linux_ohos="$OHOS_SDK_NATIVE/llvm/bin/aarch64-unknown-linux-ohos-clang++"
export AR_aarch64_unknown_linux_ohos="$OHOS_SDK_NATIVE/llvm/bin/llvm-ar"
export RANLIB_aarch64_unknown_linux_ohos="$OHOS_SDK_NATIVE/llvm/bin/llvm-ranlib"
export CFLAGS_aarch64_unknown_linux_ohos="--sysroot=$OHOS_SDK_NATIVE/sysroot -D__MUSL__"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER="$OHOS_SDK_NATIVE/llvm/bin/aarch64-unknown-linux-ohos-clang"

export CC_x86_64_unknown_linux_ohos="$OHOS_SDK_NATIVE/llvm/bin/x86_64-unknown-linux-ohos-clang"
export CXX_x86_64_unknown_linux_ohos="$OHOS_SDK_NATIVE/llvm/bin/x86_64-unknown-linux-ohos-clang++"
export AR_x86_64_unknown_linux_ohos="$OHOS_SDK_NATIVE/llvm/bin/llvm-ar"
export RANLIB_x86_64_unknown_linux_ohos="$OHOS_SDK_NATIVE/llvm/bin/llvm-ranlib"
export CFLAGS_x86_64_unknown_linux_ohos="--sysroot=$OHOS_SDK_NATIVE/sysroot -D__MUSL__"
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_OHOS_LINKER="$OHOS_SDK_NATIVE/llvm/bin/x86_64-unknown-linux-ohos-clang"

case ":$PATH:" in
  *":$CARGO_HOME/bin:"*) ;;
  *) export PATH="$CARGO_HOME/bin:$RUSTUP_HOME/toolchains/stable-x86_64-unknown-linux-gnu/bin:$OHOS_NDK_HOME/toolchains:$HVIGOR_PATH/node_modules/.bin:$PATH" ;;
esac
