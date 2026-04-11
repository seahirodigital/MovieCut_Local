"""
Movie AutoCut - macOS 専用サーバーラッパー
=============================================
親ディレクトリの server.py をそのまま読み込み、
macOS で問題となるダイアログ / 動画配信 / レビュー波形の経路だけを
Mac 専用実装で差し替える。

【方式】
raw ASGI ミドルウェアで対象エンドポイントへのリクエストを
ルートハンドラに到達する *前に* 横取りし、
Mac 専用レスポンスを返す。

※ BaseHTTPMiddleware ではなく raw ASGI を使用する理由:
  BaseHTTPMiddleware はレスポンスボディ全体をメモリに読み込むため、
  /api/video のような大容量ストリーミング配信を破壊してしまう。
  raw ASGI ミドルウェアはレスポンスをバッファしないため安全。
"""

import sys
import asyncio
import json
import mimetypes
import shutil
import time
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import Form
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

# ===== 親ディレクトリをインポートパスに追加 =====
PARENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PARENT_DIR))

# 元の server.py から FastAPI アプリとユーティリティを読み込む
from server import (  # noqa: E402
    NO_CACHE_HEADERS,
    app,
    decrement_active_video_stream,
    increment_active_video_stream,
    normalize_dialog_selection,
)
import uvicorn  # noqa: E402

from starlette.responses import Response as StarletteResponse, StreamingResponse  # noqa: E402


# =====================================================================
#  osascript (AppleScript) ヘルパー
# =====================================================================

async def _run_osascript(script: str) -> tuple[int, str, str]:
    """
    osascript を非同期サブプロセスで実行する。
    ユーザーがダイアログ操作中でもサーバーはブロックされない。
    """
    process = await asyncio.create_subprocess_exec(
        "osascript", "-e", script,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await process.communicate()
    stdout = (stdout_bytes or b"").decode("utf-8", errors="replace").strip()
    stderr = (stderr_bytes or b"").decode("utf-8", errors="replace").strip()
    return process.returncode or 0, stdout, stderr


def _json_response(data: dict, status_code: int = 200) -> StarletteResponse:
    """ミドルウェアから直接返せる JSON レスポンスを組み立てる"""
    return StarletteResponse(
        content=json.dumps(data, ensure_ascii=False),
        status_code=status_code,
        media_type="application/json",
    )


def _text_response(
    text: str,
    media_type: str,
    status_code: int = 200,
    headers: dict | None = None,
) -> StarletteResponse:
    """テキストレスポンスを no-cache 付きで返す"""
    merged_headers = NO_CACHE_HEADERS.copy()
    if headers:
        merged_headers.update(headers)
    return StarletteResponse(
        content=text,
        status_code=status_code,
        media_type=media_type,
        headers=merged_headers,
    )


def _read_utf8_text(file_path: Path) -> str:
    return file_path.read_text(encoding="utf-8")


def _guess_media_type(file_path: Path) -> str:
    guessed_type, _ = mimetypes.guess_type(str(file_path))
    if guessed_type:
        return guessed_type

    extension_map = {
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".m4v": "video/x-m4v",
        ".mts": "video/mp2t",
        ".ts": "video/mp2t",
    }
    return extension_map.get(file_path.suffix.lower(), "application/octet-stream")


def _get_query_param(scope: Scope, name: str) -> str:
    raw_query = scope.get("query_string", b"")
    if not raw_query:
        return ""
    parsed = parse_qs(raw_query.decode("utf-8", errors="replace"), keep_blank_values=True)
    values = parsed.get(name)
    if not values:
        return ""
    return values[-1]


def _get_header(scope: Scope, header_name: str) -> str:
    target = header_name.lower().encode("latin-1")
    for key, value in scope.get("headers", []):
        if key.lower() == target:
            return value.decode("latin-1")
    return ""


def _parse_byte_range(range_header: str, file_size: int) -> tuple[int, int]:
    if not range_header or "=" not in range_header:
        raise ValueError("Range ヘッダーが不正です")

    unit, raw_range = range_header.split("=", 1)
    if unit.strip().lower() != "bytes":
        raise ValueError("bytes Range のみ対応しています")
    if "," in raw_range:
        raise ValueError("複数 Range は未対応です")

    start_text, end_text = raw_range.split("-", 1)
    if start_text == "":
        suffix_length = int(end_text)
        if suffix_length <= 0:
            raise ValueError("Range の末尾長が不正です")
        start = max(0, file_size - suffix_length)
        end = file_size - 1
    else:
        start = int(start_text)
        end = int(end_text) if end_text else file_size - 1

    if start < 0 or start >= file_size:
        raise ValueError("Range 開始位置が不正です")

    end = min(end, file_size - 1)
    if end < start:
        raise ValueError("Range 終了位置が不正です")

    return start, end


def _iter_file_bytes(file_path: Path, start: int = 0, end: int | None = None, chunk_size: int = 1024 * 1024):
    with file_path.open("rb") as file_obj:
        file_obj.seek(start)
        remaining = None if end is None else (end - start + 1)

        while True:
            if remaining is not None and remaining <= 0:
                break

            read_size = chunk_size if remaining is None else min(chunk_size, remaining)
            chunk = file_obj.read(read_size)
            if not chunk:
                break

            yield chunk

            if remaining is not None:
                remaining -= len(chunk)


# =====================================================================
#  各ダイアログの macOS 実装
# =====================================================================

async def _handle_open_file() -> StarletteResponse:
    """macOS ネイティブの単一ファイル選択ダイアログ"""
    script = '''
        try
            set videoFile to (choose file with prompt "動画ファイルを選択" of type {"mp4", "mov", "avi", "mkv", "wmv", "flv", "webm", "m4v", "ts", "mts"})
            return POSIX path of videoFile
        on error number -128
            return ""
        end try
    '''
    try:
        returncode, stdout, stderr = await _run_osascript(script)
        if returncode != 0 or not stdout:
            return _json_response({"success": False, "path": ""})
        file_path = normalize_dialog_selection(stdout)
        return _json_response({"success": True, "path": file_path})
    except Exception as e:
        return _json_response({"success": False, "path": "", "error": str(e)}, 500)


async def _handle_open_files() -> StarletteResponse:
    """macOS ネイティブの複数ファイル選択ダイアログ"""
    script = '''
        try
            set fileList to (choose file with prompt "判定する動画ファイルを複数選択" of type {"mp4", "mov", "avi", "mkv", "wmv", "flv", "webm", "m4v", "ts", "mts"} with multiple selections allowed)
            set output to ""
            repeat with f in fileList
                set output to output & POSIX path of f & linefeed
            end repeat
            return output
        on error number -128
            return ""
        end try
    '''
    try:
        returncode, stdout, stderr = await _run_osascript(script)
        if returncode != 0 or not stdout:
            return _json_response({"success": False, "paths": []})
        paths = [
            normalize_dialog_selection(p)
            for p in stdout.strip().split("\n")
            if p.strip()
        ]
        return _json_response({"success": len(paths) > 0, "paths": paths})
    except Exception as e:
        return _json_response({"success": False, "paths": [], "error": str(e)}, 500)


async def _handle_open_directory() -> StarletteResponse:
    """macOS ネイティブのフォルダ選択ダイアログ"""
    script = '''
        try
            set selectedFolder to (choose folder with prompt "フォルダを選択")
            return POSIX path of selectedFolder
        on error number -128
            return ""
        end try
    '''
    try:
        returncode, stdout, stderr = await _run_osascript(script)
        if returncode != 0 or not stdout:
            return _json_response({"success": False, "path": ""})
        dir_path = normalize_dialog_selection(stdout)
        return _json_response({"success": True, "path": dir_path})
    except Exception as e:
        return _json_response({"success": False, "path": "", "error": str(e)}, 500)


# =====================================================================
#  ダイアログ系パスのディスパッチテーブル
# =====================================================================

_DIALOG_DISPATCH = {
    "/api/dialog/open-file": _handle_open_file,
    "/api/dialog/open-files": _handle_open_files,
    "/api/dialog/open-directory": _handle_open_directory,
}

APP_JS_PATH = PARENT_DIR / "app.js"
APP_MAC_PATCH_PATH = Path(__file__).with_name("app_mac_patch.js")
REVIEW_JS_PATH = PARENT_DIR / "review.js"
REVIEW_MAC_PATCH_PATH = Path(__file__).with_name("review_mac_patch.js")
MAC_EXPORT_MERGE_WORKDIR_PREFIX = ".movie_autocut_export_merge_"


async def _serve_dialog(handler, scope: Scope, receive: Receive, send: Send) -> None:
    response = await handler()
    await response(scope, receive, send)


async def _serve_patched_javascript(
    scope: Scope,
    receive: Receive,
    send: Send,
    original_path: Path,
    patch_path: Path,
    label: str,
) -> None:
    """親の JavaScript に Mac 用パッチを追記して返す"""
    method = scope.get("method", "GET").upper()
    if method not in {"GET", "HEAD"}:
        response = _text_response(
            "Method Not Allowed",
            media_type="text/plain; charset=utf-8",
            status_code=405,
            headers={"Allow": "GET, HEAD"},
        )
        await response(scope, receive, send)
        return

    try:
        original_source = _read_utf8_text(original_path)
        patch_source = _read_utf8_text(patch_path)
        combined_source = f"{original_source}\n\n/* Mac 専用パッチ: {patch_path.name} */\n{patch_source}\n"
        headers = {"Content-Length": str(len(combined_source.encode('utf-8')))}
        if method == "HEAD":
            response = StarletteResponse(
                content=b"",
                status_code=200,
                media_type="application/javascript",
                headers={**NO_CACHE_HEADERS, **headers},
            )
        else:
            response = _text_response(
                combined_source,
                media_type="application/javascript",
                headers=headers,
            )
    except Exception as e:
        response = _json_response({"error": f"{label} の読み込みに失敗しました: {e}"}, 500)

    await response(scope, receive, send)


async def _serve_app_js(scope: Scope, receive: Receive, send: Send) -> None:
    await _serve_patched_javascript(
        scope,
        receive,
        send,
        original_path=APP_JS_PATH,
        patch_path=APP_MAC_PATCH_PATH,
        label="app.js",
    )


async def _serve_review_js(scope: Scope, receive: Receive, send: Send) -> None:
    await _serve_patched_javascript(
        scope,
        receive,
        send,
        original_path=REVIEW_JS_PATH,
        patch_path=REVIEW_MAC_PATCH_PATH,
        label="review.js",
    )


async def _serve_video(scope: Scope, receive: Receive, send: Send) -> None:
    """
    Mac ブラウザ向けに動画を直接 FileResponse で返す。
    Why:
      - Starlette の FileResponse は HEAD / Range / ストリーミングを自然に扱える
      - 親 server.py の全件 read() を避け、巨大動画でも安定させる
      - 拡張子ごとの MIME を返して .mov などの再生互換性を上げる
    """
    method = scope.get("method", "GET").upper()
    if method not in {"GET", "HEAD"}:
        response = _text_response(
            "Method Not Allowed",
            media_type="text/plain; charset=utf-8",
            status_code=405,
            headers={"Allow": "GET, HEAD"},
        )
        await response(scope, receive, send)
        return

    path_text = _get_query_param(scope, "path")
    if not path_text:
        response = _json_response({"error": "path パラメータがありません"}, 400)
        await response(scope, receive, send)
        return

    file_path = Path(path_text)
    if not file_path.exists():
        response = _json_response({"error": "ファイルが見つかりません"}, 404)
        await response(scope, receive, send)
        return
    if not file_path.is_file():
        response = _json_response({"error": "指定パスがファイルではありません"}, 400)
        await response(scope, receive, send)
        return

    media_type = _guess_media_type(file_path)
    headers = NO_CACHE_HEADERS.copy()
    headers.update({
        "Accept-Ranges": "bytes",
    })

    file_size = file_path.stat().st_size
    range_header = _get_header(scope, "range")

    if range_header:
        try:
            start, end = _parse_byte_range(range_header, file_size)
        except ValueError:
            response = StarletteResponse(
                content=b"",
                status_code=416,
                media_type=media_type,
                headers={**headers, "Content-Range": f"bytes */{file_size}"},
            )
            await response(scope, receive, send)
            return

        partial_length = end - start + 1
        partial_headers = headers.copy()
        partial_headers.update({
            "Content-Length": str(partial_length),
            "Content-Range": f"bytes {start}-{end}/{file_size}",
        })

        if method == "HEAD":
            response = StarletteResponse(
                content=b"",
                status_code=206,
                media_type=media_type,
                headers=partial_headers,
            )
            await response(scope, receive, send)
            return

        response = StreamingResponse(
            _iter_file_bytes(file_path, start=start, end=end),
            status_code=206,
            media_type=media_type,
            headers=partial_headers,
        )
    else:
        full_headers = headers.copy()
        full_headers["Content-Length"] = str(file_size)

        if method == "HEAD":
            response = StarletteResponse(
                content=b"",
                status_code=200,
                media_type=media_type,
                headers=full_headers,
            )
            await response(scope, receive, send)
            return

        response = StreamingResponse(
            _iter_file_bytes(file_path),
            status_code=200,
            media_type=media_type,
            headers=full_headers,
        )

    increment_active_video_stream(file_path)
    try:
        await response(scope, receive, send)
    finally:
        decrement_active_video_stream(file_path)


def _resolve_mac_export_merge_base_dir(base_dir: str, source_file_path: str) -> Path:
    candidate_base = Path(str(base_dir or "").strip()).expanduser()
    if str(candidate_base).strip() and candidate_base.is_dir():
        return candidate_base.resolve()

    source_path = Path(str(source_file_path or "").strip()).expanduser()
    if str(source_path).strip() and source_path.is_file():
        return source_path.resolve().parent

    raise ValueError("保存先フォルダを特定できませんでした")


def _is_mac_export_merge_workdir(path: Path) -> bool:
    return path.is_dir() and path.name.startswith(MAC_EXPORT_MERGE_WORKDIR_PREFIX)


@app.post("/api/mac/create-export-merge-workdir")
async def create_mac_export_merge_workdir(
    base_dir: str = Form(""),
    source_file_path: str = Form(""),
):
    try:
        resolved_base_dir = _resolve_mac_export_merge_base_dir(base_dir, source_file_path)
    except ValueError as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=400)

    timestamp = time.strftime("%Y%m%d_%H%M%S")
    work_dir = resolved_base_dir / f"{MAC_EXPORT_MERGE_WORKDIR_PREFIX}{timestamp}_{int(time.time() * 1000) % 1000:03d}"
    work_dir.mkdir(parents=False, exist_ok=False)

    return JSONResponse({
        "success": True,
        "path": str(work_dir),
        "base_dir": str(resolved_base_dir),
    })


@app.post("/api/mac/remove-export-merge-workdir")
async def remove_mac_export_merge_workdir(
    work_dir: str = Form(...),
    base_dir: str = Form(""),
):
    work_path = Path(str(work_dir or "").strip()).expanduser()
    if not str(work_path).strip():
        return JSONResponse({"success": False, "error": "作業フォルダの指定がありません"}, status_code=400)
    if not work_path.exists():
        return JSONResponse({"success": True, "removed": False, "path": str(work_path)})
    if not _is_mac_export_merge_workdir(work_path):
        return JSONResponse({"success": False, "error": f"削除対象が Mac 一時作業フォルダではありません: {work_path}"}, status_code=400)

    resolved_work_path = work_path.resolve()
    if base_dir:
        try:
            resolved_base_dir = Path(base_dir).expanduser().resolve()
        except OSError:
            return JSONResponse({"success": False, "error": f"保存先フォルダの解決に失敗しました: {base_dir}"}, status_code=400)
        if resolved_work_path.parent != resolved_base_dir:
            return JSONResponse({"success": False, "error": "作業フォルダの親ディレクトリが保存先と一致しません"}, status_code=400)

    shutil.rmtree(resolved_work_path)
    return JSONResponse({"success": True, "removed": True, "path": str(resolved_work_path)})


@app.post("/api/mac/promote-export-merge-output")
async def promote_mac_export_merge_output(
    source_path: str = Form(...),
    base_dir: str = Form(...),
):
    source_file = Path(str(source_path or "").strip()).expanduser()
    target_base_dir = Path(str(base_dir or "").strip()).expanduser()

    if not str(source_file).strip():
        return JSONResponse({"success": False, "error": "移動元ファイルの指定がありません"}, status_code=400)
    if not str(target_base_dir).strip():
        return JSONResponse({"success": False, "error": "保存先フォルダの指定がありません"}, status_code=400)
    if not source_file.is_file():
        return JSONResponse({"success": False, "error": f"移動元ファイルが見つかりません: {source_file}"}, status_code=400)
    if not target_base_dir.is_dir():
        return JSONResponse({"success": False, "error": f"保存先フォルダが見つかりません: {target_base_dir}"}, status_code=400)
    if not _is_mac_export_merge_workdir(source_file.parent):
        return JSONResponse({"success": False, "error": "移動元が Mac 一時作業フォルダではありません"}, status_code=400)

    resolved_source = source_file.resolve()
    resolved_base_dir = target_base_dir.resolve()
    destination_path = resolved_base_dir / resolved_source.name

    if destination_path.exists():
        return JSONResponse({"success": False, "error": f"同名ファイルがすでに存在します: {destination_path}"}, status_code=409)

    moved_path = Path(shutil.move(str(resolved_source), str(destination_path)))
    return JSONResponse({
        "success": True,
        "source_path": str(resolved_source),
        "output_path": str(moved_path.resolve()),
    })


# =====================================================================
#  Raw ASGI ミドルウェア
# =====================================================================
# BaseHTTPMiddleware を使わない理由:
#   BaseHTTPMiddleware はレスポンスボディ全体をメモリにバッファする。
#   /api/video のような大容量動画ストリーミング (Range 対応) が破壊される。
#   raw ASGI ミドルウェアならレスポンスを一切バッファしないため安全。

class MacDialogMiddleware:
    """Mac 専用 API 差し替えを行う ASGI ミドルウェア"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # HTTP リクエストのみ処理（WebSocket 等はそのまま通す）
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/api/video":
                await _serve_video(scope, receive, send)
                return
            if path == "/app.js":
                await _serve_app_js(scope, receive, send)
                return
            if path == "/review.js":
                await _serve_review_js(scope, receive, send)
                return
            handler = _DIALOG_DISPATCH.get(path)
            if handler is not None:
                await _serve_dialog(handler, scope, receive, send)
                return

        # ダイアログ以外: 元のアプリへそのまま転送（バッファなし）
        await self.app(scope, receive, send)


# ミドルウェアを登録
# add_middleware は LIFO 順で実行される（最後に追加 = 最初に実行）
app.add_middleware(MacDialogMiddleware)


# =====================================================================
#  メインエントリーポイント
# =====================================================================

if __name__ == "__main__":
    HOST = "127.0.0.1"
    PORT = 8765

    print("=" * 60)
    print("Movie AutoCut - macOS Backend Server")
    print("=" * 60)
    print(f"Server URL: http://{HOST}:{PORT}")
    print(f"プロジェクトディレクトリ: {PARENT_DIR}")
    print("ダイアログ: osascript (AppleScript) via raw ASGI ミドルウェア")
    print("=" * 60)

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
