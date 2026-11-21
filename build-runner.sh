#!/usr/bin/env sh
# Rebuild browser/runtime/javalab-runner-2.jar from runner-src (needs a local JDK 11+).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD="$ROOT/.build-runner"
rm -rf "$BUILD"
mkdir -p "$BUILD/classes"
javac --release 8 -Xlint:all,-options -cp "$ROOT/browser/runtime/ecj.jar" -d "$BUILD/classes" "$ROOT/runner-src/dev/javalab/Runner.java"
jar --create --date=2000-01-01T00:00:00Z --file "$ROOT/browser/runtime/javalab-runner-2.jar" -C "$BUILD/classes" .
rm -rf "$BUILD"
echo "built browser/runtime/javalab-runner-2.jar"
