#!/usr/bin/env bash
# Build one engine from source and package it with marina's naming convention.
#
#   scripts/build-engine.sh <engine> <version> <outdir>
#   scripts/build-engine.sh redis 7.4.11 dist
#
# Output: <outdir>/<engine>-<version>-<os>-<arch>.tar.gz
#   os   = darwin | linux | windows
#   arch = arm64 | x86_64 (linux) | x64 (windows)
#
# This is what the CI matrix runs; it also works locally so you can produce a
# prebuilt artifact for a platform that has no upstream binary.
set -euo pipefail

ENGINE=${1:?usage: build-engine.sh <engine> <version> <outdir>}
VERSION=${2:?missing version}
OUT=${3:-dist}
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  darwin) OS=darwin ;;
  linux) OS=linux ;;
  mingw*|msys*|cygwin*) OS=windows ;;
  *) echo "unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH=$([ "$OS" = windows ] && echo arm64 || echo arm64) ;;
  *) ARCH=$([ "$OS" = windows ] && echo x64 || echo x86_64) ;;
esac
# linux packages use the GNU triple token
[ "$OS" = linux ] && ARCH=$([ "$(uname -m)" = "aarch64" ] && echo aarch64 || echo x86_64)

JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
SRC="$WORK/src"
PREFIX="$WORK/prefix"
mkdir -p "$SRC" "$PREFIX"

fetch() { # <url> <file>
  echo "→ fetch $1"
  curl -fsSL --retry 3 "$1" -o "$2"
}

case "$ENGINE" in
  redis)
    fetch "https://download.redis.io/releases/redis-${VERSION}.tar.gz" "$WORK/redis.tar.gz"
    tar -xzf "$WORK/redis.tar.gz" -C "$SRC" --strip-components=1
    ( cd "$SRC" && make -j"$JOBS" MALLOC=libc )
    mkdir -p "$PREFIX/bin"
    for b in redis-server redis-cli redis-benchmark redis-check-aof redis-check-rdb redis-sentinel; do
      cp "$SRC/src/$b" "$PREFIX/bin/"
    done
    ;;

  memcached)
    LIBEVENT=2.1.12-stable
    fetch "https://github.com/libevent/libevent/releases/download/release-${LIBEVENT}/libevent-${LIBEVENT}.tar.gz" "$WORK/libevent.tar.gz"
    mkdir -p "$WORK/libevent" && tar -xzf "$WORK/libevent.tar.gz" -C "$WORK/libevent" --strip-components=1
    ( cd "$WORK/libevent" && ./configure --prefix="$WORK/libevent-prefix" --disable-openssl --disable-shared \
        && make -j"$JOBS" && make install )
    fetch "https://memcached.org/files/memcached-${VERSION}.tar.gz" "$WORK/memcached.tar.gz"
    tar -xzf "$WORK/memcached.tar.gz" -C "$SRC" --strip-components=1
    ( cd "$SRC" && ./configure --prefix="$PREFIX" \
        --with-libevent="$WORK/libevent-prefix" --disable-tls \
        && make -j"$JOBS" && make install )
    ;;

  postgres)
    fetch "https://ftp.postgresql.org/pub/source/v${VERSION}/postgresql-${VERSION}.tar.gz" "$WORK/pg.tar.gz"
    tar -xzf "$WORK/pg.tar.gz" -C "$SRC" --strip-components=1
    ( cd "$SRC" && ./configure --prefix="$PREFIX" --without-readline --without-zlib --without-icu \
        && make -j"$JOBS" && make install )
    ;;

  mariadb)
    fetch "https://archive.mariadb.org/mariadb-${VERSION}/source/mariadb-${VERSION}.tar.gz" "$WORK/maria.tar.gz"
    tar -xzf "$WORK/maria.tar.gz" -C "$SRC" --strip-components=1
    cmake -S "$SRC" -B "$WORK/build" -DCMAKE_INSTALL_PREFIX="$PREFIX" \
      -DWITH_UNIT_TESTS=OFF -DWITHOUT_TOKUDB=ON -DPLUGIN_COLUMNSTORE=NO -DPLUGIN_S3=NO
    cmake --build "$WORK/build" -j"$JOBS"
    cmake --install "$WORK/build"
    ;;

  *)
    echo "unknown engine: $ENGINE" >&2
    exit 1
    ;;
esac

# strip build-host paths that would otherwise leak into the artifact
find "$PREFIX" -type f \( -name '*.la' -o -name '*.a' \) -delete 2>/dev/null || true

NAME="${ENGINE}-${VERSION}-${OS}-${ARCH}"
if [ "$OS" = windows ]; then
  ( cd "$PREFIX" && zip -qr "$OUT/$NAME.zip" . )
  echo "$OUT/$NAME.zip"
else
  tar -C "$PREFIX" -czf "$OUT/$NAME.tar.gz" .
  echo "$OUT/$NAME.tar.gz"
fi
