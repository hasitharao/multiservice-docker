#!/usr/bin/env sh
# Creates random passwords in ./secrets/ (only if they don't exist yet).
# Run:  sh scripts/generate-secrets.sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p secrets

gen() {
  file="secrets/$1.txt"
  if [ -f "$file" ]; then
    echo "keep   $file (already exists)"
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24 > "$file"
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$file"
  fi
  # 644 on purpose: with Docker Compose, file secrets are bind-mounted, so the
  # container user (node, redis, mongodb...) needs read access to the host file.
  # The secrets/ folder is git-ignored, so these never reach your repository.
  chmod 644 "$file"
  echo "create $file"
}

gen mongo_root_password
gen redis_password
