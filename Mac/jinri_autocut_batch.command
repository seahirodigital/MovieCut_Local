#!/bin/bash
# =============================================
# JINRI mac 一括自動不要部カット
# =============================================
# Mac/jinri_autocut_batch.py を macOS 環境で実行する。
# 仮想環境は OneDrive 同期対象外のローカル領域に作成する。
# =============================================

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${MAC_DIR}/.." && pwd)"
LOCAL_STATE_DIR="/Users/user/Library/Application Support/Movie_AutoCut"

echo "========================================"
echo "  JINRI mac 一括自動不要部カット"
echo "========================================"
echo

if command -v python3 >/dev/null 2>&1; then
  if [ -x "/opt/homebrew/bin/python3" ]; then
    BOOTSTRAP_PYTHON="/opt/homebrew/bin/python3"
  elif [ -x "/usr/local/bin/python3" ]; then
    BOOTSTRAP_PYTHON="/usr/local/bin/python3"
  else
    BOOTSTRAP_PYTHON="python3"
  fi
elif command -v python >/dev/null 2>&1; then
  BOOTSTRAP_PYTHON="python"
else
  echo "[ERROR] Python が見つかりません。python3 をインストールしてください。"
  exit 1
fi

VENV_SUFFIX="$("$BOOTSTRAP_PYTHON" -c 'import sys; print(f"{sys.version_info[0]}{sys.version_info[1]}")')"
VENV_DIR="${LOCAL_STATE_DIR}/venv-macos-py${VENV_SUFFIX}"

mkdir -p "${LOCAL_STATE_DIR}"

if [ ! -x "${VENV_DIR}/bin/python3" ] && [ ! -x "${VENV_DIR}/bin/python" ]; then
  echo "[*] 仮想環境を作成します..."
  "$BOOTSTRAP_PYTHON" -m venv "${VENV_DIR}"
  echo "[OK] 仮想環境を作成しました。"
fi

VENV_PYTHON="${VENV_DIR}/bin/python3"
if [ ! -x "$VENV_PYTHON" ]; then
  VENV_PYTHON="${VENV_DIR}/bin/python"
fi

echo "[*] 使用する Python: ${VENV_PYTHON}"
echo "[*] 仮想環境の保存先: ${VENV_DIR}"
echo "[*] 依存関係をインストールします..."
"$VENV_PYTHON" -m pip install --disable-pip-version-check -r "${PROJECT_DIR}/requirements.txt"

echo
echo "[注意] 最終動画の保存に成功した元動画は削除されます。"
echo
echo "[*] JINRI mac 一括自動不要部カットを開始します..."
echo

set +e
"$VENV_PYTHON" "${MAC_DIR}/jinri_autocut_batch.py"
BATCH_EXIT_CODE=$?
set -e

echo
if [ "$BATCH_EXIT_CODE" -eq 0 ]; then
  echo "[OK] JINRI mac 一括自動不要部カットは正常終了しました。"
else
  echo "[ERROR] JINRI mac 一括自動不要部カットが失敗しました。終了コード: ${BATCH_EXIT_CODE}"
fi

if [ -t 0 ]; then
  printf "\nEnter キーを押すと終了します..."
  read -r _
fi

exit "$BATCH_EXIT_CODE"
