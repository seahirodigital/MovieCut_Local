#!/bin/bash
# =============================================
# JINRI OCR 検証: 「벗어」継続検出動画を採用へ移動
# =============================================
# 対象:
#   /Users/user/Downloads/JINRI_mac/100.OCR検証
# 採用移動先:
#   /Users/user/Downloads/JINRI_mac/100.OCR検証/採用
# =============================================

set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${MAC_DIR}/.." && pwd)"
LOCAL_STATE_DIR="/Users/user/Library/Application Support/Movie_AutoCut"

pause_before_exit() {
  if [ -t 0 ]; then
    printf "\nEnter キーを押すと終了します..."
    read -r _
  fi
}

die() {
  echo
  echo "[ERROR] $1"
  pause_before_exit
  exit 1
}

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
  die "Python が見つかりません。python3 をインストールしてください。"
fi

if ! "$BOOTSTRAP_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
  BOOTSTRAP_VERSION="$("$BOOTSTRAP_PYTHON" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")')"
  die "Python 3.10 以上が必要です。検出したバージョン: ${BOOTSTRAP_VERSION} (${BOOTSTRAP_PYTHON})"
fi

BOOTSTRAP_VERSION="$("$BOOTSTRAP_PYTHON" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")')"
VENV_SUFFIX="$("$BOOTSTRAP_PYTHON" -c 'import sys; print(f"{sys.version_info[0]}{sys.version_info[1]}")')"
VENV_DIR="${LOCAL_STATE_DIR}/venv-macos-py${VENV_SUFFIX}"

mkdir -p "${LOCAL_STATE_DIR}"

echo "========================================"
echo "  JINRI OCR 検証"
echo "========================================"
echo
echo "[*] 使用する Python: ${BOOTSTRAP_PYTHON} (${BOOTSTRAP_VERSION})"
echo "[*] 使用する仮想環境: ${VENV_DIR}"
echo "[*] 対象: /Users/user/Downloads/JINRI_mac/100.OCR検証"
echo "[*] 採用移動先: /Users/user/Downloads/JINRI_mac/100.OCR検証/採用"
echo

if [ ! -x "${VENV_DIR}/bin/python3" ] && [ ! -x "${VENV_DIR}/bin/python" ]; then
  echo "[*] 仮想環境を作成します..."
  "$BOOTSTRAP_PYTHON" -m venv "${VENV_DIR}" || die "仮想環境の作成に失敗しました。"
  echo "[OK] 仮想環境を作成しました。"
fi

VENV_PYTHON="${VENV_DIR}/bin/python3"
if [ ! -x "$VENV_PYTHON" ]; then
  VENV_PYTHON="${VENV_DIR}/bin/python"
fi

[ -x "$VENV_PYTHON" ] || die "仮想環境の Python が見つかりません。"

echo "[*] 依存関係を確認・インストールします..."
if ! "$VENV_PYTHON" -m pip install --disable-pip-version-check -r "${PROJECT_DIR}/requirements.txt"; then
  die "依存関係のインストールに失敗しました。上のログを確認してください。"
fi

echo
echo "[*] OCR 判定を開始します..."
"$VENV_PYTHON" "${MAC_DIR}/movie_vision_ocr_betsuo_move.py" "$@"
EXIT_CODE=$?

echo
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "[OK] OCR 判定が完了しました。"
else
  echo "[ERROR] OCR 判定でエラーが発生しました。"
fi

pause_before_exit
exit "$EXIT_CODE"
