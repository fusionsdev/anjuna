#!/usr/bin/env bash
# Assemble the brand Worker's static assets: Astro landing at /, form at /_f/.
set -euo pipefail
cd "$(dirname "$0")"
(cd landing && npx astro build)
mkdir -p brand-worker/public && find brand-worker/public -mindepth 1 -delete
mkdir -p brand-worker/public/_f
cp -r landing/dist/. brand-worker/public/
(cd form-app && npx vite build)
cp -r form-app/dist/. brand-worker/public/_f/
find brand-worker/public -type f | sort
