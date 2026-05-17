#!/usr/bin/env bash
# exit on error
set -o errexit

echo "==> Installing backend dependencies..."
npm install

echo "==> Installing frontend dependencies..."
npm install --prefix frontend

echo "==> Building frontend assets..."
npm run build --prefix frontend

echo "==> Build complete!"
