#!/usr/bin/env bash
# Build Shouldertap.exe for x64 Windows. Prints the path of the built exe.
#
#   scripts/build.sh          dev build talking to localhost ("Shouldertap Debug")
#   scripts/build.sh release  release build talking to production
#
# On Windows this is a plain cargo build. On a Mac it cross-compiles with
# cargo-xwin (cargo install cargo-xwin; brew install llvm lld), and release
# builds use the `cross` profile: GPUI precompiles its Direct3D shaders only
# on a Windows host, so cross-built exes compile them at launch instead.
# Prefer the CI build (.github/workflows/windows.yml) for releases.
set -euo pipefail

cd "$(dirname "$0")/.."
config="${1:-debug}"
target=x86_64-pc-windows-msvc

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    if [[ "$config" == "release" ]]; then profile=release; else profile=dev; fi
    cargo build --profile "$profile" --target "$target" -p shouldertap >&2
    ;;
  *)
    for dir in /opt/homebrew/opt/llvm/bin /opt/homebrew/opt/lld/bin /usr/local/opt/llvm/bin; do
      [[ -d "$dir" ]] && PATH="$dir:$PATH"
    done
    export PATH
    if [[ "$config" == "release" ]]; then profile=cross; else profile=dev; fi
    cargo xwin build --profile "$profile" --target "$target" -p shouldertap >&2
    ;;
esac

dir="$profile"
[[ "$profile" == "dev" ]] && dir=debug
echo "$PWD/target/$target/$dir/Shouldertap.exe"
