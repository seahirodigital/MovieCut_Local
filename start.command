#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

START_URL="${START_URL:-http://127.0.0.1:8765/}"

if command -v python3 >/dev/null 2>&1; then
  BOOTSTRAP_PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  BOOTSTRAP_PYTHON="python"
else
  echo "Python が見つかりません。python3 をインストールしてください。"
  exit 1
fi

if [ ! -x "venv/bin/python3" ] && [ ! -x "venv/bin/python" ]; then
  echo "[*] 仮想環境を作成します..."
  "$BOOTSTRAP_PYTHON" -m venv venv
  echo "[OK] 仮想環境を作成しました。"
fi

VENV_PYTHON="venv/bin/python3"
if [ ! -x "$VENV_PYTHON" ]; then
  VENV_PYTHON="venv/bin/python"
fi

echo "[*] 依存関係をインストールします..."
"$VENV_PYTHON" -m pip install -r requirements.txt -q

echo
echo "[*] サーバーを起動します..."
echo "[*] ブラウザは自動で開きます。"
echo "[*] 終了するには Ctrl+C を押してください。"
echo

if [ "${MOVIE_AUTOCUT_SKIP_BROWSER:-0}" != "1" ]; then
  (
    for _ in $(seq 1 60); do
      if curl --silent --fail --max-time 2 "$START_URL" >/dev/null 2>&1; then
        open "$START_URL"
        exit 0
      fi
      sleep 0.5
    done
    open "$START_URL"
  ) &
fi

"$VENV_PYTHON" server.py
