#!/usr/bin/env bash
# Bouwt de app- en Caddy-images en zet ze in je eigen object-opslag (images/…),
# zodat nieuwe servers niet afhankelijk zijn van Docker Hub of GitHub.
#   EIGEN_CONFIG=eigen.json scripts/build-images.sh
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -t eigen-cloud:latest .
docker build -t eigen-caddy:latest -f Dockerfile.caddy .
mkdir -p build
docker save eigen-cloud:latest | gzip > build/eigen-cloud.tar.gz
docker save eigen-caddy:latest | gzip > build/eigen-caddy.tar.gz
npx tsx src/cluster/cli.ts upload-images build/eigen-cloud.tar.gz build/eigen-caddy.tar.gz
