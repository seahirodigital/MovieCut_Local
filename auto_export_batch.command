#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

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
echo "[*] 自動抽出一括出力を開始します..."
echo

"$VENV_PYTHON" auto_export_batch.py
