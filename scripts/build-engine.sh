#!/usr/bin/env bash
# Compile the verified source archive into the requested prefix.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

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

OHOS_SDK=${MARINA_OHOS_SDK_NATIVE:-}
if [ -n "$OHOS_SDK" ]; then
  case "$ENGINE" in
    redis|memcached|postgres|qdrant|mariadb) ;;
    *) echo "no HarmonyOS source build for $ENGINE" >&2; exit 1 ;;
  esac
  OHOS_SDK=$(cd "$OHOS_SDK" && pwd)
  if [ ! -x "$OHOS_SDK/llvm/bin/clang" ] || [ ! -d "$OHOS_SDK/sysroot" ]; then
    echo 'MARINA_OHOS_SDK_NATIVE must point to the native directory of the HarmonyOS SDK' >&2
    exit 1
  fi
  PREFIX=$(cd "$PREFIX" && pwd)
  export OHOS_SDK PATH="$OHOS_SDK/llvm/bin:$PATH"
  cat > "$WORK/ohos-clang" <<'EOF'
#!/bin/sh
compiler=${0##*/}
exec "${compiler#ohos-}" --target=aarch64-linux-ohos --sysroot="$OHOS_SDK/sysroot" "$@"
EOF
  chmod +x "$WORK/ohos-clang"
  export CC="$WORK/ohos-clang" AR=llvm-ar RANLIB=llvm-ranlib
fi

case "$ENGINE" in
  redis)
    (
      cd "$SRC"
      if [ -n "$OHOS_SDK" ]; then
        # The HarmonyOS SDK lacks GNU process-title globals and pthread cancellation.
        patch -f -p1 < "$SCRIPT_DIR/redis-openharmony.patch"
        make -j"$JOBS" CC="$CC" AR="$AR" RANLIB="$RANLIB" \
          uname_S=Linux uname_M=aarch64 MALLOC=libc USE_SYSTEMD=no OPTIMIZATION=-O2 \
          PREFIX="$PREFIX" install
      else
        make -j"$JOBS" MALLOC=libc PREFIX="$PREFIX" install
      fi
    )
    ;;
  memcached)
    mkdir -p "$WORK/libevent"
    tar -xf "$LIBEVENT_ARCHIVE" -C "$WORK/libevent" --strip-components=1
    (
      cd "$WORK/libevent"
      event_args=(--prefix="$WORK/libevent-prefix" --disable-openssl --disable-shared)
      if [ -n "$OHOS_SDK" ]; then
        event_args+=(--host=aarch64-linux-musl --build="$(sh build-aux/config.guess)" --disable-samples)
      fi
      ./configure "${event_args[@]}"
      make -j"$JOBS"
      make install
    )
    (
      cd "$SRC"
      case "$ARCHIVE" in
        */memcached-1.5.*.tar.gz)
          # This series uses -Werror with declarations deprecated by current compilers.
          export CFLAGS='-O2 -fcommon -Wno-error=deprecated-declarations -Wno-error=strict-prototypes -Wno-error=unused-but-set-variable'
          # The stray comment terminator prevents the htonll probe from finding macOS's macro.
          sed -i.bak 's|^#include <inttypes\.h> \*/$|#include <inttypes.h>|' configure
          rm configure.bak
          if [ -f authfile.c ]; then
            sed -i.bak '/^#include "authfile\.h"$/i\
#include "config.h"
' authfile.c
            rm authfile.c.bak
          fi
          ;;
      esac
      if [ -n "$OHOS_SDK" ]; then
        CPPFLAGS="-I$WORK/libevent-prefix/include" LDFLAGS="-L$WORK/libevent-prefix/lib" \
          ./configure --prefix="$PREFIX" --host=aarch64-linux-musl --build="$(sh config.guess)" --disable-tls
      else
        ./configure --prefix="$PREFIX" --with-libevent="$WORK/libevent-prefix" --disable-tls
      fi
      make -j"$JOBS"
      make install
    )
    cp "$WORK/libevent/LICENSE" "$PREFIX/LICENSE-libevent"
    ;;
  postgres)
    (
      cd "$SRC"
      pg_args=(--prefix="$PREFIX" --without-readline --without-zlib --without-icu)
      if [ -n "$OHOS_SDK" ]; then
        pg_args+=(--host=aarch64-linux-musl --build="$(sh config/config.guess)")
      fi
      ./configure "${pg_args[@]}"
      if [ -n "$OHOS_SDK" ]; then
        make -j"$JOBS" 'rpathdir=$$ORIGIN/../lib'
        make 'rpathdir=$$ORIGIN/../lib' install
      else
        make -j"$JOBS"
        make install
      fi
    )
    ;;
  qdrant)
    if [ -z "$OHOS_SDK" ]; then
      echo 'set MARINA_OHOS_SDK_NATIVE to build Qdrant from source for HarmonyOS' >&2
      exit 1
    fi
    (
      cd "$SRC"
      patch -f -p1 < "$SCRIPT_DIR/qdrant-openharmony.patch"
      ln -s ohos-clang "$WORK/ohos-clang++"
      export PATH="$OHOS_SDK/build-tools/cmake/bin:$PATH"
      export CC_aarch64_unknown_linux_ohos="$CC"
      export CXX_aarch64_unknown_linux_ohos="$WORK/ohos-clang++"
      export AR_aarch64_unknown_linux_ohos="$OHOS_SDK/llvm/bin/llvm-ar"
      export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER="$CC"
      unset CC AR RANLIB
      target=aarch64-unknown-linux-ohos
      cargo build --locked --release --bin qdrant --target "$target" -j "$JOBS"
      mkdir -p "$PREFIX/bin"
      cp "${CARGO_TARGET_DIR:-target}/$target/release/qdrant" "$PREFIX/bin/"
    )
    ;;
  milvus)
    mkdir -p "$PREFIX/bin" "$PREFIX/lib" "$PREFIX/configs"
    (
      cd "$SRC"
      patch -f -F0 -p1 < "$SCRIPT_DIR/milvus-local.patch"
      export GIT_CONFIG_GLOBAL="$WORK/milvus-git-config"
      export GOFLAGS=-buildvcs=false
      make milvus MILVUS_VERSION="${MARINA_BUILD_VERSION:?missing Milvus version}" \
        BUILD_TAGS="v$MARINA_BUILD_VERSION"
    )
    cp "$SRC/bin/milvus" "$PREFIX/bin/"
    for lib_dir in "$SRC"/internal/core/output/lib "$SRC"/internal/core/output/lib64 "$SRC"/cmake_build/lib; do
      for library in "$lib_dir"/*.so* "$lib_dir"/*.dylib*; do
        if [ -f "$library" ] && [ ! -e "$PREFIX/lib/${library##*/}" ]; then
          cp -a "$library" "$PREFIX/lib/"
        fi
      done
    done
    cp "$SRC/configs/milvus.yaml" "$PREFIX/configs/"
    cat > "$PREFIX/configs/marina-etcd.yaml" <<'YAML'
listen-client-urls: http://127.0.0.1:0
listen-peer-urls: http://127.0.0.1:0
YAML
    ;;
  mariadb)
    maria_options=(-DWITH_UNIT_TESTS=OFF -DWITH_PCRE=bundled
      -DPLUGIN_COLUMNSTORE=NO -DPLUGIN_S3=NO -DPLUGIN_MROONGA=NO -DPLUGIN_CONNECT=NO
      -DPLUGIN_ROCKSDB=NO -DPLUGIN_TOKUDB=NO -DWITH_WSREP=OFF)
    maria_args=(-DWITH_SSL=system)
    if [ -n "$OHOS_SDK" ]; then
      ssl=$(cd "${MARINA_OPENSSL_ROOT:?set MARINA_OPENSSL_ROOT to the HarmonyOS OpenSSL prefix}" && pwd)
      ncurses=$(cd "${MARINA_OHOS_NCURSES_ROOT:?set MARINA_OHOS_NCURSES_ROOT to the HarmonyOS ncurses prefix}" && pwd)
      export PATH="$OHOS_SDK/build-tools/cmake/bin:$PATH"
      patch -f -d "$SRC" -p1 < "$SCRIPT_DIR/mariadb-openharmony.patch"
      (
        unset CC AR RANLIB
        cmake -S "$SRC" -B "$WORK/host-tools" -DCMAKE_BUILD_TYPE=Release \
          -DWITH_SSL=bundled -DWITH_ZLIB=bundled -DWITH_NUMA=OFF "${maria_options[@]}"
        cmake --build "$WORK/host-tools" --parallel "$JOBS" \
          --target comp_err comp_sql gen_lex_hash gen_lex_token
      )
      export CPATH="$ncurses/include/ncursesw:$ncurses/include"
      maria_args=("-DCMAKE_TOOLCHAIN_FILE=$OHOS_SDK/build/cmake/ohos.toolchain.cmake"
        -DOHOS_ARCH=arm64-v8a -DOHOS_STL=c++_static
        "-DIMPORT_EXECUTABLES=$WORK/host-tools/import_executables.cmake"
        '-DCMAKE_INSTALL_RPATH=$ORIGIN/../lib;$ORIGIN/..' -DENABLE_DTRACE=OFF -DWITH_NUMA=OFF
        -DWITHOUT_DYNAMIC_PLUGINS=ON -DPLUGIN_DAEMON_EXAMPLE=NO
        "-DWITH_SSL=$ssl" "-DOPENSSL_INCLUDE_DIR=$ssl/include"
        "-DOPENSSL_SSL_LIBRARY=$ssl/lib/libssl.a" "-DOPENSSL_CRYPTO_LIBRARY=$ssl/lib/libcrypto.a"
        "-DCURSES_INCLUDE_PATH=$ncurses/include/ncursesw"
        "-DCURSES_LIBRARY=$ncurses/lib/libncursesw.a" "-DCURSES_CURSES_LIBRARY=$ncurses/lib/libncursesw.a"
        -DWITH_ZLIB=bundled)
    elif [ "$(uname -s)" = Darwin ]; then
      ssl=${MARINA_OPENSSL_ROOT:?set MARINA_OPENSSL_ROOT to the OpenSSL 3 development prefix}
      sdk=$(xcrun --sdk macosx --show-sdk-path)
      maria_args=("-DCMAKE_OSX_SYSROOT=$sdk" "-DCMAKE_C_COMPILER=$(xcrun --sdk macosx --find clang)" \
        "-DCMAKE_CXX_COMPILER=$(xcrun --sdk macosx --find clang++)" -DWITH_ZLIB=bundled \
        '-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local' \
        "-DWITH_SSL=$ssl" "-DOPENSSL_INCLUDE_DIR=$ssl/include" \
        "-DOPENSSL_SSL_LIBRARY=$ssl/lib/libssl.a" "-DOPENSSL_CRYPTO_LIBRARY=$ssl/lib/libcrypto.a")
    fi
    cmake -S "$SRC" -B "$WORK/build" -DCMAKE_INSTALL_PREFIX="$PREFIX" \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_NAME_DIR=@rpath -DCMAKE_MACOSX_RPATH=ON \
      -DCONC_WITH_SSL=OPENSSL "${maria_options[@]}" "${maria_args[@]}"
    cmake --build "$WORK/build" --parallel "$JOBS"
    cmake --install "$WORK/build"
    if [ -n "${ssl:-}" ] && [ -f "$ssl/LICENSE.txt" ]; then
      cp "$ssl/LICENSE.txt" "$PREFIX/LICENSE-OpenSSL"
    fi
    if [ -n "${ncurses:-}" ] && [ -f "$ncurses/COPYING" ]; then
      cp "$ncurses/COPYING" "$PREFIX/LICENSE-ncurses"
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
