#!/bin/bash
# =============================================
# Movie AutoCut - macOS 一括自動出力ランチャー
# =============================================
# 親ディレクトリの auto_export_batch.py を macOS 環境で実行する。
# 仮想環境は親ディレクトリ (プロジェクトルート) のものを再利用する。
# =============================================

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

# Mac フォルダ自身のパス
MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
# 親ディレクトリ（プロジェクトルート）
PROJECT_DIR="$(cd "${MAC_DIR}/.." && pwd)"

echo "========================================"
echo "  Movie AutoCut - macOS 一括自動出力"
echo "========================================"
echo

# ===== Python 検出 =====
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
VENV_DIR="${PROJECT_DIR}/venv-macos-py${VENV_SUFFIX}"

# ===== 仮想環境の作成（必要な場合のみ） =====
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
echo "[*] 依存関係をインストールします..."
"$VENV_PYTHON" -m pip install -r "${PROJECT_DIR}/requirements.txt" -q

echo
echo "[*] 自動抽出一括出力を開始します..."
echo

"$VENV_PYTHON" "${PROJECT_DIR}/auto_export_batch.py"
