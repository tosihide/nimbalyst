#!/usr/bin/env bash
#
# Build Linux deb (and AppImage) packages inside the official electron-builder
# Docker image. The image is based on Ubuntu 20.04 so generated binaries link
# against an old glibc and therefore run on Ubuntu 22.04 / 24.04 / 26.04 and
# all current Debian / Mint / Pop!_OS releases.
#
# Output: packages/electron/release/*.deb and *.AppImage on the host.
#
# Requirements: Docker only. Works on macOS, Windows (WSL/Git Bash), Linux.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
IMAGE="electronuserland/builder:20"

echo "==> Repository root: $REPO_ROOT"
echo "==> Using image:     $IMAGE"

# Pull the image (no-op if already cached).
docker pull "$IMAGE"

# Run electron-builder inside the container. Mount the repo as /project and
# keep node_modules inside named volumes so host-built (e.g. macOS / arm64)
# native modules don't clash with the Linux build.
docker run --rm -t \
  -v "$REPO_ROOT":/project \
  -v nimbalyst-linux-root-node-modules:/project/node_modules \
  -v nimbalyst-linux-electron-node-modules:/project/packages/electron/node_modules \
  -v nimbalyst-linux-runtime-node-modules:/project/packages/runtime/node_modules \
  -v nimbalyst-linux-cache-electron:/root/.cache/electron \
  -v nimbalyst-linux-cache-electron-builder:/root/.cache/electron-builder \
  -w /project \
  --user root \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    echo "==> Node:           $(node --version)"
    echo "==> npm:            $(npm --version)"
    echo "==> dpkg-deb:       $(dpkg-deb --version | head -n1)"
    echo "==> Installing dependencies"
    npm ci --no-audit --no-fund
    echo "==> Building Linux packages (deb + AppImage, x64 + arm64)"
    cd packages/electron
    npm run build:linux
    echo "==> Fixing ownership of output for host user"
    chown -R '"$(id -u)"':'"$(id -g)"' release || true
  '

echo
echo "==> Done. Artifacts:"
ls -lh "$REPO_ROOT/packages/electron/release/" | grep -E '\.(deb|AppImage)$' || true
