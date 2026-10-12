#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/ and run the first-time setup from README.md."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "JavaScript dependencies are missing. Run npm install first."
  exit 1
fi

uv run --project backend --python 3.12 uvicorn server:app --app-dir backend --host 127.0.0.1 --port 8765 &
backend_pid=$!
npm run dev &
frontend_pid=$!

cleanup() {
  kill "$backend_pid" "$frontend_pid" 2>/dev/null || true
  wait "$backend_pid" "$frontend_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

attempt=0
until curl --silent --fail http://127.0.0.1:5173/ >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "The reader did not start. Check the terminal output above."
    exit 1
  fi
  sleep 1
done

if ! open -a "Google Chrome" http://127.0.0.1:5173 2>/dev/null; then
  open http://127.0.0.1:5173
fi

echo "Pagevoice is running. Press Ctrl-C to stop both local services."
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
  sleep 2
done
echo "A local service stopped. Check the terminal output above."
exit 1
