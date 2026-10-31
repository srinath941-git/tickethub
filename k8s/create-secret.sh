#!/usr/bin/env bash
# Creates the application secret. Run once on the control plane; never commit real values.
set -euo pipefail
DB_PASSWORD="${DB_PASSWORD:-ChangeMe@123}"
kubectl -n tickets create secret generic tickethub-secret \
  --from-literal=POSTGRES_DB=ticketdb \
  --from-literal=POSTGRES_USER=ticketuser \
  --from-literal=POSTGRES_PASSWORD="${DB_PASSWORD}" \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)"
