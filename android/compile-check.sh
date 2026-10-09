#!/usr/bin/env bash
# Controleert zonder Android-bouwgereedschap of de app-code compileert: javac tegen de API-stubs van Android 34
# (android.jar uit het SDK-platform) plus een stub voor LambdaMetafactory (in een echte build herschrijft D8 lambda's).
#   ANDROID_JAR=/pad/naar/android.jar android/compile-check.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
JAR="${ANDROID_JAR:-/home/claude/tools/android-34.jar}"
LMF="${LMF_DIR:-/home/claude/tools/lmf}"
OUT="$HERE/build/compile-check"
rm -rf "$OUT"; mkdir -p "$OUT/stubs-src/nl/eigencloud/app" "$OUT/classes"
cat > "$OUT/stubs-src/nl/eigencloud/app/R.java" <<'J'
package nl.eigencloud.app;
public final class R { public static final class drawable { public static final int ic_notify = 0x7f010000; } }
J
cat > "$OUT/stubs-src/nl/eigencloud/app/BuildConfig.java" <<'J'
package nl.eigencloud.app;
public final class BuildConfig { public static final String VERSION_NAME = "0.0.0"; public static final int VERSION_CODE = 1; public static final String UPDATE_REPO = "x/y"; }
J
set +e
javac -Xlint:all -Xlint:-options -Xlint:-deprecation -Werror -source 8 -target 8 -bootclasspath "$JAR:$LMF" -encoding UTF-8 -d "$OUT/classes" \
  $(find "$HERE/core/src/main/java" "$HERE/app/src/main/java" "$OUT/stubs-src" -name '*.java') > "$OUT/javac.log" 2>&1
rc=$?
set -e
grep -v '^Picked up' "$OUT/javac.log" || true
if [ $rc -ne 0 ]; then echo "FAIL compile-check"; exit 1; fi
echo "PASS compile-check (app + kern tegen Android API 34)"
