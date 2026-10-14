#!/usr/bin/env bash
# Controleert zonder Android-bouwgereedschap of de app-code compileert: javac tegen de API-stubs van Android 34
# (android.jar uit het SDK-platform) en de Java 11-standaardbibliotheek.
#   ANDROID_JAR=/pad/naar/android.jar android/compile-check.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
JAR="${ANDROID_JAR:-${ANDROID_HOME:-$HOME/Android/Sdk}/platforms/android-34/android.jar}"
# Zonder Android SDK (bijv. in de sandbox van een agent): overslaan met een waarschuwing; de CI bouwt de app altijd
# echt (gradle lint + assemble). REQUIRE_ANDROID_JAR=1 maakt een ontbrekende SDK een fout.
if [ ! -f "$JAR" ]; then
  if [ "${REQUIRE_ANDROID_JAR:-}" = "1" ]; then echo "FAIL compile-check: $JAR ontbreekt"; exit 1; fi
  echo "OVERGESLAGEN compile-check: geen android.jar ($JAR). De CI controleert de app."; exit 0
fi
OUT="$HERE/build/compile-check"
rm -rf "$OUT"; mkdir -p "$OUT/stubs-src/nl/eigencloud/app" "$OUT/classes"
cat > "$OUT/stubs-src/nl/eigencloud/app/R.java" <<'J'
package nl.eigencloud.app;
public final class R { public static final class drawable { public static final int ic_notify = 0x7f010000; } }
J
cat > "$OUT/stubs-src/nl/eigencloud/app/BuildConfig.java" <<'J'
package nl.eigencloud.app;
public final class BuildConfig { public static final String VERSION_NAME = "0.0.0"; public static final int VERSION_CODE = 1; public static final String UPDATE_REPO = "x/y"; public static final String UPDATE_IMAGE = "x/y-app"; public static final String DIENST_URL = ""; }
J
set +e
javac -Xlint:all -Xlint:-options -Xlint:-deprecation -Werror --release 11 -classpath "$JAR" -encoding UTF-8 -d "$OUT/classes" \
  $(find "$HERE/core/src/main/java" "$HERE/app/src/main/java" "$OUT/stubs-src" -name '*.java') > "$OUT/javac.log" 2>&1
rc=$?
set -e
grep -v '^Picked up' "$OUT/javac.log" || true
if [ $rc -ne 0 ]; then echo "FAIL compile-check"; exit 1; fi
echo "PASS compile-check (app + kern tegen Android API 34)"
