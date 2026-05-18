#!/usr/bin/env bash
# exit on error
set -o errexit

echo "==> Installing backend dependencies (locked)..."
cd backend && npm ci && cd ..

echo "==> Installing frontend dependencies (locked)..."
npm ci --prefix frontend

echo "==> Building frontend assets..."
npm run build --prefix frontend

echo "==> Running security audit..."
npm audit --prefix backend --audit-level=high || true

echo "==> Build complete!"
