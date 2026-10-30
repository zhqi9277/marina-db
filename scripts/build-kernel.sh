#!/bin/sh
# Build marina's Linux kernel (6.12 LTS). The VMM only boots this image.
# On macOS this starts the marina-kernel Lima instance and compiles there.
set -eu

VERSION="${MARINA_KERNEL_VERSION:-6.12.113}"
REPO=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
FRAGMENT="$REPO/runtime-os/kernel/marina.fragment"
REQUIRED="$REPO/runtime-os/kernel/required.txt"
OUT="$REPO/dist/kernel"
URL="https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${VERSION}.tar.xz"

if [ "$(uname -s)" != "Linux" ]; then
  if ! command -v limactl >/dev/null 2>&1; then
    echo "error: the kernel builds on Linux. Install Lima, or run this script on Linux." >&2
    exit 1
  fi
  if limactl list | awk '$1=="marina-kernel" { found=1 } END { exit !found }'; then
    limactl start marina-kernel
  else
    limactl start --name=marina-kernel --yes --mount-type=virtiofs \
      --mount "${REPO}:w" template:debian-12
  fi
  exec limactl shell marina-kernel -- bash -lc "sudo apt-get update && sudo apt-get install -y build-essential bc bison flex libssl-dev libelf-dev curl xz-utils ca-certificates && exec bash '$REPO/scripts/build-kernel.sh'"
fi

arch=$(uname -m)
case "$arch" in
  aarch64|arm64) KARCH=arm64; TARGET=Image; IMAGE="arch/arm64/boot/Image" ;;
  x86_64) KARCH=x86; TARGET=bzImage; IMAGE="arch/x86/boot/bzImage" ;;
  *) echo "error: unsupported architecture $arch" >&2; exit 1 ;;
esac

WORKDIR="${MARINA_KERNEL_WORKDIR:-$HOME/marina-kernel}"
SRC="$WORKDIR/linux-$VERSION"
mkdir -p "$WORKDIR" "$OUT"

if [ ! -f "$SRC/Makefile" ]; then
  tarball="$WORKDIR/linux-$VERSION.tar.xz"
  if [ ! -f "$tarball" ]; then
    curl -fL --retry 3 -o "$tarball.partial" "$URL"
    mv "$tarball.partial" "$tarball"
  fi
  tar -xJf "$tarball" -C "$WORKDIR"
fi

make -C "$SRC" ARCH="$KARCH" tinyconfig
# merge_config.sh writes .config in the current directory, so run it inside the tree
(
  cd "$SRC"
  ./scripts/kconfig/merge_config.sh -m .config "$FRAGMENT"
  make ARCH="$KARCH" olddefconfig
)

missing=""
while read -r name; do
  case "$name" in ''|\#*) continue ;; esac
  if ! grep -q "^CONFIG_${name}=y$" "$SRC/.config"; then
    missing="$missing CONFIG_$name"
  fi
done < "$REQUIRED"
if [ -n "$missing" ]; then
  echo "error: kernel config dropped required options:$missing" >&2
  exit 1
fi

jobs=$(nproc 2>/dev/null || echo 2)
make -C "$SRC" ARCH="$KARCH" -j"$jobs" vmlinux "$TARGET"

cp "$SRC/vmlinux" "$OUT/vmlinux"
cp "$SRC/$IMAGE" "$OUT/$(basename "$IMAGE")"
cp "$SRC/.config" "$OUT/config"
printf '%s\n' "$VERSION" > "$OUT/version"
echo "kernel $VERSION ($KARCH) -> $OUT"
