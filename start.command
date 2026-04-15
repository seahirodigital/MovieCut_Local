#!/bin/bash
set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ "$(uname -s)" = "Darwin" ] && [ -x "${SCRIPT_DIR}/Mac/start.command" ]; then
  exec "${SCRIPT_DIR}/Mac/start.command"
fi

START_URL="${START_URL:-http://127.0.0.1:8765/}"
SERVER_PID=""

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

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

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
VENV_DIR="venv-macos-py${VENV_SUFFIX}"

echo "[*] 使用する Python: ${BOOTSTRAP_PYTHON} (${BOOTSTRAP_VERSION})"
echo "[*] 使用する仮想環境: ${SCRIPT_DIR}/${VENV_DIR}"

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

echo "[*] 依存関係をインストールします..."
if ! "$VENV_PYTHON" -m pip install -r requirements.txt; then
  die "依存関係のインストールに失敗しました。上のログを確認してください。"
fi

echo
echo "[*] サーバーを起動します..."
echo "[*] ブラウザは自動で開きます。"
echo "[*] 終了するには Ctrl+C を押してください。"
echo

"$VENV_PYTHON" server.py &
SERVER_PID=$!

if [ "${MOVIE_AUTOCUT_SKIP_BROWSER:-0}" != "1" ]; then
  BROWSER_OPENED=0
  for _ in $(seq 1 60); do
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      set +e
      wait "$SERVER_PID"
      SERVER_EXIT_CODE=$?
      set -e
      die "サーバーが起動途中で終了しました。終了コード: ${SERVER_EXIT_CODE}"
    fi

    if curl --silent --fail --max-time 2 "$START_URL" >/dev/null 2>&1; then
      if ! open "$START_URL"; then
        echo "[WARN] ブラウザを自動で開けませんでした: $START_URL"
      fi
      BROWSER_OPENED=1
      break
    fi

    sleep 0.5
  done

  if [ "$BROWSER_OPENED" -eq 0 ]; then
    echo "[WARN] サーバー応答待ちがタイムアウトしました。手動で開いてください: $START_URL"
  fi
fi

set +e
wait "$SERVER_PID"
SERVER_EXIT_CODE=$?
set -e
trap - EXIT INT TERM

if [ "$SERVER_EXIT_CODE" -ne 0 ] && [ "$SERVER_EXIT_CODE" -ne 130 ]; then
  die "サーバーが異常終了しました。終了コード: ${SERVER_EXIT_CODE}"
fi

exit 0
