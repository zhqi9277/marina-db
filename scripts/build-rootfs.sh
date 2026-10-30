#!/bin/sh
# Userspace for marina's kernel. Database engines install in this Linux,
# so every host OS gets the same install/start/exec behavior.
set -eu

REPO=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT="$REPO/dist/rootfs.img"
NODE_VERSION="${NODE_VERSION:-22.21.0}"
GO_VERSION="${GO_VERSION:-1.22.12}"

if [ "$(uname -s)" != "Linux" ]; then
  if ! command -v limactl >/dev/null 2>&1; then
    echo "error: the rootfs is built on Linux. Install Lima, or run this script there." >&2
    exit 1
  fi
  if limactl list | awk '$1=="marina-kernel" { found=1 } END { exit !found }'; then
    limactl start marina-kernel
  else
    limactl start --name=marina-kernel --yes --mount-type=virtiofs \
      --mount "${REPO}:w" template:debian-12
  fi
  exec limactl shell marina-kernel -- bash -lc "sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y debootstrap e2fsprogs curl ca-certificates xz-utils tar gzip && exec sudo --preserve-env=NODE_VERSION,GO_VERSION bash '$REPO/scripts/build-rootfs.sh'"
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "error: build-rootfs.sh needs root (it debootstraps a Linux)." >&2
  exit 1
fi

case "$(uname -m)" in
  aarch64|arm64) DEB_ARCH=arm64; NODE_ARCH=arm64; GOARCH=arm64 ;;
  x86_64) DEB_ARCH=amd64; NODE_ARCH=x64; GOARCH=amd64 ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

WORKDIR="${MARINA_ROOTFS_WORKDIR:-/var/tmp/marina-rootfs}"
ROOT="$WORKDIR/tree"
rm -rf "$ROOT"
mkdir -p "$ROOT" "$REPO/dist"

debootstrap --variant=minbase --arch="$DEB_ARCH" bookworm "$ROOT" http://deb.debian.org/debian

chroot "$ROOT" apt-get update
chroot "$ROOT" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  iproute2 isc-dhcp-client ca-certificates curl xz-utils tar gzip \
  make gcc g++ libc6-dev pkg-config libssl-dev
chroot "$ROOT" apt-get clean
rm -rf "$ROOT/var/lib/apt/lists/"* "$ROOT/usr/share/doc" "$ROOT/usr/share/man" "$ROOT/usr/share/locale"

node_tar="$WORKDIR/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
if [ ! -f "$node_tar" ]; then
  curl -fL --retry 3 -o "$node_tar.partial" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  mv "$node_tar.partial" "$node_tar"
fi
tar -xJf "$node_tar" -C "$ROOT/usr/local" --strip-components=1

if ! command -v go >/dev/null 2>&1 || ! go version | grep -q 'go1\.2'; then
  go_tar="$WORKDIR/go${GO_VERSION}.linux-${GOARCH}.tar.gz"
  if [ ! -f "$go_tar" ]; then
    curl -fL --retry 3 -o "$go_tar.partial" "https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz"
    mv "$go_tar.partial" "$go_tar"
  fi
  rm -rf "$WORKDIR/go"
  tar -xzf "$go_tar" -C "$WORKDIR"
  export PATH="$WORKDIR/go/bin:$PATH"
fi

mkdir -p "$ROOT/opt/marina/bin" "$ROOT/var/lib/marina"
tar -C "$REPO" -cf - \
  --exclude .git --exclude runtime --exclude node_modules --exclude dist --exclude runtime-os \
  bin src package.json assets README.md \
  | tar -C "$ROOT/opt/marina" -xf -

(
  cd "$REPO/runtime-os"
  CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" go build -ldflags '-s -w' -o "$ROOT/opt/marina/bin/marina-init" ./cmd/marina-init
  CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" go build -ldflags '-s -w' -o "$ROOT/opt/marina/bin/marina-agent" ./cmd/marina-agent
)

cat > "$ROOT/opt/marina/bin/marina" <<'EOF'
#!/bin/sh
export MARINA_HOME=/var/lib/marina
export MARINA_INSIDE_LINUX=1
exec /usr/local/bin/node /opt/marina/bin/marina.js "$@"
EOF
chmod 755 "$ROOT/opt/marina/bin/marina" "$ROOT/opt/marina/bin/marina-init" "$ROOT/opt/marina/bin/marina-agent"
ln -sfn /opt/marina/bin/marina-init "$ROOT/sbin/init"
ln -sfn /var/lib/marina/engines "$ROOT/opt/marina/engines"
mkdir -p "$ROOT/etc"
ln -sfn /var/lib/marina/etc "$ROOT/etc/marina"
printf 'marina\n' > "$ROOT/etc/hostname"
printf '127.0.0.1 localhost marina\n' > "$ROOT/etc/hosts"

rm -f "$OUT"
truncate -s 4G "$OUT"
mkfs.ext4 -F -L marina -d "$ROOT" "$OUT"
echo "rootfs -> $OUT"
