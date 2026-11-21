#!/usr/bin/env bash
# Compile the verified source archive into the requested prefix.
set -euo pipefail

# Keep compiler/library lookup separate from the runner's other toolchains.
export PATH="${MARINA_BUILD_PATH:+$MARINA_BUILD_PATH:}/usr/bin:/bin:/usr/sbin:/sbin"
unset PKG_CONFIG_PATH PKG_CONFIG_LIBDIR PKG_CONFIG_SYSROOT_DIR \
      CPPFLAGS CFLAGS CXXFLAGS LDFLAGS LIBS CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH \
      CMAKE_PREFIX_PATH CMAKE_INCLUDE_PATH CMAKE_LIBRARY_PATH ACLOCAL_PATH \
      CC CXX AR AS LD NM RANLIB MAKEFLAGS MFLAGS MAKEOVERRIDES CONFIG_SITE \
      LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_INSERT_LIBRARIES

ENGINE=$1
ARCHIVE=$2
PREFIX=$3
LIBEVENT_ARCHIVE=${4:-}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
SRC="$WORK/src"
mkdir -p "$SRC" "$PREFIX"
tar -xf "$ARCHIVE" -C "$SRC" --strip-components=1

case "$ENGINE" in
  redis)
    ( cd "$SRC" && make -j"$JOBS" MALLOC=libc PREFIX="$PREFIX" install )
    ;;
  memcached)
    mkdir -p "$WORK/libevent"
    tar -xf "$LIBEVENT_ARCHIVE" -C "$WORK/libevent" --strip-components=1
    ( cd "$WORK/libevent" && ./configure --prefix="$WORK/libevent-prefix" --disable-openssl --disable-shared \
        && make -j"$JOBS" && make install )
    ( cd "$SRC" && ./configure --prefix="$PREFIX" --with-libevent="$WORK/libevent-prefix" --disable-tls \
        && make -j"$JOBS" && make install )
    cp "$WORK/libevent/LICENSE" "$PREFIX/LICENSE-libevent"
    ;;
  postgres)
    ( cd "$SRC" && ./configure --prefix="$PREFIX" --without-readline --without-zlib --without-icu \
        && make -j"$JOBS" && make install )
    ;;
  mariadb)
    ssl_args=(-DWITH_SSL=system)
    if [ "$(uname -s)" = Darwin ]; then
      ssl=${MARINA_OPENSSL_ROOT:?set MARINA_OPENSSL_ROOT to the OpenSSL 3 development prefix}
      ssl_args+=("-DWITH_SSL=$ssl" "-DOPENSSL_INCLUDE_DIR=$ssl/include" \
        "-DOPENSSL_SSL_LIBRARY=$ssl/lib/libssl.a" "-DOPENSSL_CRYPTO_LIBRARY=$ssl/lib/libcrypto.a" \
        '-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local')
    fi
    cmake -S "$SRC" -B "$WORK/build" -DCMAKE_INSTALL_PREFIX="$PREFIX" \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_NAME_DIR=@rpath -DCMAKE_MACOSX_RPATH=ON \
      -DWITH_UNIT_TESTS=OFF -DCONC_WITH_SSL=OPENSSL -DWITH_PCRE=bundled "${ssl_args[@]}" \
      -DPLUGIN_COLUMNSTORE=NO -DPLUGIN_S3=NO -DPLUGIN_MROONGA=NO \
      -DPLUGIN_ROCKSDB=NO -DPLUGIN_TOKUDB=NO -DWITH_WSREP=OFF
    cmake --build "$WORK/build" --parallel "$JOBS"
    cmake --install "$WORK/build"
    if [ -n "${ssl:-}" ] && [ -f "$ssl/LICENSE.txt" ]; then
      cp "$ssl/LICENSE.txt" "$PREFIX/LICENSE-OpenSSL"
    fi
    ;;
  *)
    echo "no source build for $ENGINE" >&2
    exit 1
    ;;
esac

for name in LICENSE LICENSE.txt COPYING COPYING.txt COPYRIGHT NOTICE; do
  if [ -f "$SRC/$name" ]; then cp "$SRC/$name" "$PREFIX/$name"; fi
done
