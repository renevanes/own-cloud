#!/usr/bin/env bash
# Compileert de Java-kern (nl.eigencloud.core) en draait alle tests.
#
#   android/core/test.sh
#
# Wat er gebeurt:
#   1. javac --release 11 van src/main (zonder externe bibliotheken) en src/test → android/core/build/
#   2. hulpdiensten op vrije poorten: moto_server (S3), lokale SMTP-servers (Node smtp-server) en één echte
#      Eigen Cloud-cluster-node (Node, CLUSTER_FAST=1)
#   3. scripts/golden.ts maakt vaste testgegevens met de TypeScript-code; de Java-tests vergelijken daarmee
#   4. de Java-tests (elk een main-programma), daarna scripts/golden-verify.ts (TS controleert Java-uitvoer)
#   5. alle gestarte processen worden aan het eind gestopt (per procesgroep van de PID die we zelf startten)
#
# Uitvoer: PASS/FAIL per test; exitcode ≠ 0 als er iets faalt.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BUILD="$HERE/build"
CATALOG="$REPO/android/app/src/main/assets/catalog.json"
JAVA_OPTS=(-Dstdout.encoding=UTF-8 -Dbuild.dir="$BUILD" -Dcatalog.file="$CATALOG")
CP="$BUILD/classes:$BUILD/test-classes"

GROUPS_STARTED=()   # PIDs van procesgroep-leiders die dit script zelf startte (via setsid)
CLUSTER_PID=""

cleanup() {
  for p in "${GROUPS_STARTED[@]}"; do kill -TERM -- "-$p" 2>/dev/null; done
  sleep 2
  for p in "${GROUPS_STARTED[@]}"; do kill -KILL -- "-$p" 2>/dev/null; done
  # De cluster-node draait in een eigen sessie (detached); het hulpscript stopt hem bij SIGTERM,
  # maar voor de zekerheid ook hier, op het PID dat het hulpscript zelf rapporteerde.
  if [ -n "$CLUSTER_PID" ]; then kill -KILL -- "-$CLUSTER_PID" 2>/dev/null; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_for() { # wait_for <seconds> <command...>
  local n=$(( $1 * 5 )); shift
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 0.2; done
  return 1
}

echo "== Compileren"
rm -rf "$BUILD/classes" "$BUILD/test-classes" "$BUILD/java-out"
mkdir -p "$BUILD/classes" "$BUILD/test-classes"
if ! javac --release 11 -Xlint:all -Werror -encoding UTF-8 -d "$BUILD/classes" $(find "$HERE/src/main/java" -name '*.java') > "$BUILD/javac-main.log" 2>&1; then cat "$BUILD/javac-main.log"; echo "FAIL compile (main)"; exit 1; fi
if [ ! -f "$BUILD/classes/nl/eigencloud/core/Json.class" ]; then echo "FAIL compile (main)"; exit 1; fi
if ! javac --release 11 -encoding UTF-8 -cp "$BUILD/classes" -d "$BUILD/test-classes" $(find "$HERE/src/test/java" -name '*.java') > "$BUILD/javac-test.log" 2>&1; then cat "$BUILD/javac-test.log"; echo "FAIL compile (tests)"; exit 1; fi
if [ ! -f "$BUILD/test-classes/nl/eigencloud/core/T.class" ]; then echo "FAIL compile (tests)"; exit 1; fi
echo "PASS compile"

cd "$REPO" || exit 1
npx tsx scripts/export-catalog.ts >/dev/null || { echo "FAIL export-catalog"; exit 1; }

echo "== Hulpdiensten starten"
MOTO_PORT=$(free_port)
setsid moto_server -H 127.0.0.1 -p "$MOTO_PORT" >"$BUILD/moto.log" 2>&1 &
GROUPS_STARTED+=($!)
rm -f "$BUILD/smtp-info.json" "$BUILD/cluster-info.json"
setsid npx tsx scripts/android-smtp-server.ts "$BUILD/smtp-info.json" >"$BUILD/smtp.log" 2>&1 &
GROUPS_STARTED+=($!)
rm -f "$BUILD/dienst-info.json"
setsid npx tsx scripts/android-dienst.ts "$BUILD/dienst-info.json" >"$BUILD/dienst.log" 2>&1 &
GROUPS_STARTED+=($!)
rm -f "$BUILD/github-info.json"
setsid npx tsx scripts/android-github.ts "$BUILD/github-info.json" >"$BUILD/github.log" 2>&1 &
GROUPS_STARTED+=($!)
rm -f "$BUILD/nodig-info.json"
setsid npx tsx scripts/android-nodig.ts "$BUILD/nodig-info.json" >"$BUILD/nodig.log" 2>&1 &
GROUPS_STARTED+=($!)
setsid npx tsx scripts/android-cluster-node.ts "$BUILD/cluster-info.json" >"$BUILD/cluster.log" 2>&1 &
GROUPS_STARTED+=($!)
CLUSTER_HELPER=$!

wait_for 30 port_open "$MOTO_PORT" || { echo "FAIL moto_server start niet"; cat "$BUILD/moto.log"; exit 1; }
wait_for 60 test -s "$BUILD/smtp-info.json" || { echo "FAIL smtp-server start niet"; cat "$BUILD/smtp.log"; exit 1; }
echo "   moto op :$MOTO_PORT, smtp $(cat "$BUILD/smtp-info.json" | head -c 60)…"

FAILED=0
RESULTS=()
run() { # run <naam> <commando...>
  local name=$1; shift
  echo "== $name"
  if "$@" 2>&1 | grep -v '^Picked up'; [ "${PIPESTATUS[0]}" -eq 0 ]; then
    RESULTS+=("PASS $name"); echo "PASS $name"
  else
    RESULTS+=("FAIL $name"); echo "FAIL $name"; FAILED=1
  fi
}
jrun() { local t=$1; shift; run "$t" env "$@" java "${JAVA_OPTS[@]}" -cp "$CP" "nl.eigencloud.core.$t"; }

run golden.ts npx tsx scripts/golden.ts "$BUILD/golden.json"
jrun CryptoGoldenTest      # direct na golden.ts: het rpc-bericht is 60 s geldig
jrun JsonTest
jrun FormatsGoldenTest
jrun CatalogApiTest
jrun ProvidersTest
jrun DnsTest
jrun AdaptersTest
jrun KeyCheckTest MOTO_URL="http://127.0.0.1:$MOTO_PORT"
jrun VaultTest
jrun DeviceVaultTest MOTO_URL="http://127.0.0.1:$MOTO_PORT"
run golden-verify.ts npx tsx scripts/golden-verify.ts "$BUILD"
# Verify time-bound proofs as soon as their three fixture producers have finished.
jrun SmtpTest SMTP_INFO="$BUILD/smtp-info.json"
jrun S3MotoTest MOTO_URL="http://127.0.0.1:$MOTO_PORT"
jrun ConsoleApiTest MOTO_URL="http://127.0.0.1:$MOTO_PORT"
jrun CostsTest MOTO_URL="http://127.0.0.1:$MOTO_PORT"
if wait_for 60 test -s "$BUILD/dienst-info.json"; then
  jrun ConsoleExtrasTest MOTO_URL="http://127.0.0.1:$MOTO_PORT" DIENST_INFO="$BUILD/dienst-info.json"
  DIENST_OK=1
else
  echo "   dienst niet gestart:"; tail -30 "$BUILD/dienst.log"; RESULTS+=("FAIL ConsoleExtrasTest"); FAILED=1; DIENST_OK=0
fi
jrun QuickSetupTest MOTO_URL="http://127.0.0.1:$MOTO_PORT"
jrun AanbiederTest MOTO_URL="http://127.0.0.1:$MOTO_PORT" SMTP_INFO="$BUILD/smtp-info.json"
jrun AanbiederHubTest MOTO_URL="http://127.0.0.1:$MOTO_PORT" SMTP_INFO="$BUILD/smtp-info.json"
if wait_for 60 test -s "$BUILD/nodig-info.json"; then
  jrun BenodigdhedenTest NODIG_INFO="$BUILD/nodig-info.json"
else
  echo "   nep-aanbieders (nodig) niet gestart:"; tail -30 "$BUILD/nodig.log"; RESULTS+=("FAIL BenodigdhedenTest"); FAILED=1
fi
if wait_for 60 test -s "$BUILD/github-info.json"; then
  jrun GitHubTest GITHUB_INFO="$BUILD/github-info.json"
else
  echo "   nep-GitHub niet gestart:"; tail -30 "$BUILD/github.log"; RESULTS+=("FAIL GitHubTest"); FAILED=1
fi
# Langere integratietests volgen pas na de tijdgebonden interoperabiliteitscontrole.
if [ "$DIENST_OK" -eq 1 ]; then
  jrun OverstapTest MOTO_URL="http://127.0.0.1:$MOTO_PORT" DIENST_INFO="$BUILD/dienst-info.json"
else
  RESULTS+=("FAIL OverstapTest"); FAILED=1
fi
# Agenda en foto's op deze telefoon: ICS gelijk aan de cloud, reservekopie/herstel, Takeout, foto-cache.
run telefoon-golden.ts npx tsx scripts/telefoon-golden.ts maak "$BUILD/telefoon-golden.json"
jrun AgendaIcsTest
run telefoon-golden.ts-controle npx tsx scripts/telefoon-golden.ts controleer "$BUILD"
jrun AgendaBackupTest
jrun TakeoutTest
jrun FotoCacheTest
# Gmail op deze telefoon: MIME/HTML/opbouw zonder netwerk, daarna sync tegen een nep-Gmail (IMAP + SMTP) met echte SQLite.
jrun GmailMimeTest
jrun GmailSyncTest SQLITE_BRIDGE="$HERE/src/test/node/sqlite-bridge.cjs"

echo "== Wachten op de cluster-node (leider)"
if wait_for 180 test -s "$BUILD/cluster-info.json"; then
  CLUSTER_PID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$BUILD/cluster-info.json")
  jrun ClusterRpcTest CLUSTER_INFO="$BUILD/cluster-info.json"
else
  echo "   cluster-node niet gestart:"; tail -40 "$BUILD/cluster.log"
  RESULTS+=("FAIL ClusterRpcTest"); echo "FAIL ClusterRpcTest"; FAILED=1
fi

echo
echo "== Resultaat"
for r in "${RESULTS[@]}"; do echo "$r"; done
if [ "$FAILED" -eq 0 ]; then echo "ALLE TESTS GESLAAGD"; else echo "ER ZIJN TESTS MISLUKT"; fi
exit "$FAILED"
