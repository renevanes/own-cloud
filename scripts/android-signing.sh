#!/usr/bin/env bash
set -euo pipefail
task_signing_dir="${1:-${XDG_STATE_HOME:-$HOME/.local/state}/eigen-cloud/signing}"
umask 077
mkdir -p "$task_signing_dir"
task_signing_file="$task_signing_dir/release.jks"
if [ -e "$task_signing_file" ]; then echo "Er bestaat al een sleutel op $task_signing_file; niets gewijzigd."; exit 1; fi
read -r -s -p "Nieuw wachtwoord voor de ondertekensleutel: " task_signing_password
echo
if [ ${#task_signing_password} -lt 16 ]; then echo "Gebruik minimaal 16 tekens."; exit 1; fi
export EIGEN_SIGNING_PASSWORD="$task_signing_password"
keytool -genkeypair -keystore "$task_signing_file" -storetype PKCS12 -alias eigen-release \
  -storepass:env EIGEN_SIGNING_PASSWORD -keypass:env EIGEN_SIGNING_PASSWORD \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Eigen Cloud, OU=Release, O=Eigen Cloud"
unset EIGEN_SIGNING_PASSWORD task_signing_password
echo "Nieuwe sleutel: $task_signing_file. Bewaar hem veilig buiten GitHub; configureer de vier CI-secrets."
