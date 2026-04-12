"""
Movie AutoCut - Python バックエンドサーバー
=============================================
FFmpegを使った音声波形解析・音量急変検出・動画圧縮・クリップ切り出しを提供する。
HTML UI (movie-autocut.html) と連携して動作する。
"""

import os
import sys
import json
import math
import struct
import asyncio
import tempfile
import subprocess
import time
import threading
import shutil
import wave
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# ===== FFmpegパスの自動検出 =====
def find_ffmpeg():
    """FFmpegのパスを検出する（imageio-ffmpeg経由 or システムPATH）"""
    # まずシステムPATHを確認
    import shutil
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return ffmpeg_path
    
    # imageio-ffmpegのバンドル版を使用
    try:
        import imageio_ffmpeg
        ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
        if ffmpeg_path and os.path.exists(ffmpeg_path):
            return ffmpeg_path
    except ImportError:
        pass
    
    raise RuntimeError(
        "FFmpegが見つかりません。\n"
        "以下のいずれかの方法でインストールしてください:\n"
        "  1. pip install imageio-ffmpeg\n"
        "  2. FFmpegを公式サイトからダウンロードしてPATHに追加\n"
        "     https://ffmpeg.org/download.html"
    )

def find_ffprobe():
    """FFprobeのパスを検出する"""
    import shutil
    ffprobe_path = shutil.which("ffprobe")
    if ffprobe_path:
        return ffprobe_path
    
    # FFmpegと同じディレクトリにあるか確認
    ffmpeg_path = find_ffmpeg()
    ffmpeg_dir = os.path.dirname(ffmpeg_path)
    for name in ["ffprobe", "ffprobe.exe"]:
        candidate = os.path.join(ffmpeg_dir, name)
        if os.path.exists(candidate):
            return candidate
    
    # imageio-ffmpegにはffprobeが含まれないので、ffmpegで代用する場合もある
    return None

FFMPEG = find_ffmpeg()
FFPROBE = find_ffprobe()

print(f"[OK] FFmpeg: {FFMPEG}")
if FFPROBE:
    print(f"[OK] FFprobe: {FFPROBE}")
else:
    print("[WARN] FFprobeが見つかりません（一部機能が制限されます）")

# ===== FastAPI アプリケーション =====
app = FastAPI(title="Movie AutoCut Backend")

# CORS設定
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 作業ディレクトリ
BASE_DIR = Path(__file__).parent.resolve()
TEMP_DIR = BASE_DIR / "temp"
TEMP_DIR.mkdir(exist_ok=True)
NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}
REVIEW_REJECT_DIR = Path.home() / "Downloads" / "Jinricp" / "削除"
def get_env_path(env_name: str, default_path: Path) -> Path:
    configured_path = os.getenv(env_name)
    if configured_path:
        return Path(configured_path).expanduser()
    return default_path


def get_default_media_root() -> Path:
    return get_env_path(
        "MOVIE_AUTOCUT_MEDIA_ROOT",
        Path.home() / "Downloads" / "Jinricp",
    )


def get_default_auto_export_source_dir() -> Path:
    return get_env_path(
        "MOVIE_AUTOCUT_AUTO_EXPORT_SOURCE_DIR",
        get_default_media_root() / "自動抽出",
    )


def get_default_auto_export_output_dir() -> Path:
    return get_env_path(
        "MOVIE_AUTOCUT_AUTO_EXPORT_OUTPUT_DIR",
        get_default_media_root() / "自動抽出後",
    )


def get_default_review_reject_dir() -> Path:
    return get_env_path(
        "MOVIE_AUTOCUT_REVIEW_REJECT_DIR",
        get_default_media_root() / "削除",
    )


def get_default_review_ok_dir() -> Path:
    return get_env_path(
        "MOVIE_AUTOCUT_REVIEW_OK_DIR",
        get_default_auto_export_output_dir() / "SNSで採用",
    )


def get_default_jinri_root() -> Path:
    return get_env_path(
        "MOVIE_AUTOCUT_JINRI_ROOT",
        Path.home() / "Downloads" / "JINRI_mac",
    )


REVIEW_REJECT_DIR = get_default_review_reject_dir()
REVIEW_OK_DIR = get_default_review_ok_dir()
REVIEW_MOVE_FAILURE_LOG = TEMP_DIR / "review_move_failures.log"

# WebSocket接続の管理
active_connections: list[WebSocket] = []

# 現在処理中のファイル情報を保持
analysis_state_by_file = {}
active_video_stream_counts: dict[str, int] = {}
video_stream_lock = threading.Lock()
queued_review_reject_tasks: dict[str, asyncio.Task] = {}
review_reject_task_lock = threading.Lock()
export_state_lock = threading.Lock()
active_export_state = {
    "active": False,
    "stop_requested": False,
    "process": None,
    "current_clip": 0,
    "total_clips": 0,
    "message": "",
}


# ===== ユーティリティ =====

def format_time(seconds: float) -> str:
    """秒数を MM:SS.S 形式に変換"""
    mins = int(seconds // 60)
    secs = seconds % 60
    return f"{mins}:{secs:04.1f}"

def get_video_duration(file_path: str) -> float:
    """FFmpegで動画の長さを取得"""
    cmd = [
        FFMPEG, "-i", file_path,
        "-hide_banner"
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    # stderrからDuration情報を抽出
    for line in result.stderr.split("\n"):
        if "Duration:" in line:
            parts = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = parts.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    
    raise ValueError("動画の長さを取得できませんでした")


def get_analysis_state(file_path: str) -> dict:
    state = analysis_state_by_file.get(file_path)
    if state is None:
        state = {
            "duration": 0,
            "waveform_data": None,
            "detected_spikes": [],
        }
        analysis_state_by_file[file_path] = state
    return state


def build_unique_destination_path(destination_dir: Path, original_name: str) -> Path:
    candidate = destination_dir / original_name
    if not candidate.exists():
        return candidate

    stem = Path(original_name).stem
    suffix = Path(original_name).suffix
    counter = 1
    while True:
        candidate = destination_dir / f"{stem}_{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def append_review_move_failure(source_path: str, destination_dir: str, error_message: str):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with REVIEW_MOVE_FAILURE_LOG.open("a", encoding="utf-8") as log_file:
        log_file.write(
            f"[{timestamp}] {source_path} -> {destination_dir}\n"
            f"{error_message}\n\n"
        )


def normalize_managed_path(file_path: str | Path) -> str:
    return str(Path(file_path).resolve())


def normalize_dialog_selection(selected_path: str) -> str:
    return os.path.normpath(selected_path)


def get_dropped_file_search_roots() -> list[Path]:
    roots = [
        get_default_auto_export_source_dir(),
        get_default_auto_export_output_dir(),
        REVIEW_OK_DIR,
        REVIEW_REJECT_DIR,
        get_default_jinri_root(),
        Path.home() / "Downloads",
    ]
    unique_roots = []
    seen = set()
    for root in roots:
        try:
            resolved = root.expanduser().resolve()
        except Exception:
            continue
        if resolved in seen or not resolved.is_dir():
            continue
        seen.add(resolved)
        unique_roots.append(resolved)
    return unique_roots


def find_dropped_file_matches(file_name: str, file_size: int | None = None) -> list[str]:
    safe_name = Path(str(file_name or "")).name
    if not safe_name:
        return []

    matches = []
    for root in get_dropped_file_search_roots():
        try:
            candidates = root.rglob(safe_name)
        except Exception:
            continue

        for candidate in candidates:
            try:
                if not candidate.is_file():
                    continue
                if file_size is not None and file_size >= 0 and candidate.stat().st_size != file_size:
                    continue
                matches.append(str(candidate.resolve()))
            except Exception:
                continue

    return sorted(set(matches))


def prepare_dialog_root(root) -> None:
    root.withdraw()
    try:
        root.lift()
    except Exception:
        pass
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass
    try:
        root.update_idletasks()
        root.update()
    except Exception:
        pass


def increment_active_video_stream(file_path: str | Path):
    normalized_path = normalize_managed_path(file_path)
    with video_stream_lock:
        active_video_stream_counts[normalized_path] = active_video_stream_counts.get(normalized_path, 0) + 1


def decrement_active_video_stream(file_path: str | Path):
    normalized_path = normalize_managed_path(file_path)
    with video_stream_lock:
        current_count = active_video_stream_counts.get(normalized_path, 0)
        if current_count <= 1:
            active_video_stream_counts.pop(normalized_path, None)
        else:
            active_video_stream_counts[normalized_path] = current_count - 1


def get_active_video_stream_count(file_path: str | Path) -> int:
    normalized_path = normalize_managed_path(file_path)
    with video_stream_lock:
        return active_video_stream_counts.get(normalized_path, 0)


async def wait_for_video_release(file_path: str | Path, timeout_sec: float = 2.5, poll_interval_sec: float = 0.08) -> int:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        active_count = get_active_video_stream_count(file_path)
        if active_count <= 0:
            return 0
        await asyncio.sleep(poll_interval_sec)
    return get_active_video_stream_count(file_path)


async def execute_review_file_move(
    file_path: str | Path,
    target_directory: str | Path,
    *,
    destination_name: str | None = None,
    require_original_name: bool = False,
) -> dict:
    normalized_path = normalize_managed_path(file_path)
    source_path = Path(normalized_path)
    destination_dir = Path(target_directory).expanduser()
    normalized_destination_dir = normalize_managed_path(destination_dir)
    last_error = None

    destination_dir.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 45.0

    while time.monotonic() < deadline:
        if not source_path.exists():
            return {
                "success": True,
                "already_missing": True,
                "moved_from_path": normalized_path,
                "target_directory": normalized_destination_dir,
                "moved_name": destination_name or source_path.name,
            }

        active_count = await wait_for_video_release(source_path, timeout_sec=0.8, poll_interval_sec=0.08)
        if active_count > 0:
            last_error = RuntimeError(f"動画配信ストリームが {active_count} 件残っています")
            await asyncio.sleep(0.25)
            continue

        try:
            if destination_name:
                destination_path = destination_dir / destination_name
                if require_original_name and destination_path.exists():
                    raise FileExistsError(f"元の場所に同名ファイルが既にあります: {destination_path}")
                if not require_original_name and destination_path.exists():
                    destination_path = build_unique_destination_path(destination_dir, destination_name)
            else:
                destination_path = build_unique_destination_path(destination_dir, source_path.name)

            await asyncio.to_thread(shutil.move, str(source_path), str(destination_path))
            normalized_destination_path = normalize_managed_path(destination_path)
            for stale_path in {
                str(source_path),
                normalized_path,
                str(destination_path),
                normalized_destination_path,
            }:
                analysis_state_by_file.pop(stale_path, None)

            return {
                "success": True,
                "already_missing": False,
                "moved_from_path": normalized_path,
                "moved_to_path": normalized_destination_path,
                "target_directory": normalized_destination_dir,
                "moved_name": destination_path.name,
            }
        except FileNotFoundError:
            return {
                "success": True,
                "already_missing": True,
                "moved_from_path": normalized_path,
                "target_directory": normalized_destination_dir,
                "moved_name": destination_name or source_path.name,
            }
        except FileExistsError:
            raise
        except PermissionError as e:
            last_error = e
            await asyncio.sleep(0.25)
        except OSError as e:
            last_error = e
            await asyncio.sleep(0.25)

    raise RuntimeError(str(last_error or "移動先フォルダへの移動がタイムアウトしました"))


async def process_review_reject_move(file_path: str, target_directory: str):
    normalized_path = normalize_managed_path(file_path)
    destination_dir = Path(target_directory)

    try:
        await execute_review_file_move(normalized_path, destination_dir)
    except Exception as e:
        append_review_move_failure(
            normalized_path,
            str(destination_dir),
            str(e),
        )
    finally:
        with review_reject_task_lock:
            queued_review_reject_tasks.pop(normalized_path, None)


def queue_review_reject_move(file_path: str | Path, target_directory: str | Path) -> str:
    normalized_path = normalize_managed_path(file_path)
    normalized_target_directory = normalize_managed_path(target_directory)
    with review_reject_task_lock:
        existing_task = queued_review_reject_tasks.get(normalized_path)
        if existing_task and not existing_task.done():
            return "already_queued"

        queued_review_reject_tasks[normalized_path] = asyncio.create_task(
            process_review_reject_move(normalized_path, normalized_target_directory)
        )
    return "queued"


async def run_process_capture(cmd: list[str]) -> tuple[int, bytes, bytes]:
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    return process.returncode, stdout or b"", stderr or b""


def begin_export_session(total_clips: int) -> bool:
    with export_state_lock:
        if active_export_state["active"]:
            return False
        active_export_state.update({
            "active": True,
            "stop_requested": False,
            "process": None,
            "current_clip": 0,
            "total_clips": total_clips,
            "message": "",
        })
    return True


def finish_export_session():
    with export_state_lock:
        active_export_state.update({
            "active": False,
            "stop_requested": False,
            "process": None,
            "current_clip": 0,
            "total_clips": 0,
            "message": "",
        })


def is_export_stop_requested() -> bool:
    with export_state_lock:
        return bool(active_export_state["stop_requested"])


def update_export_session_status(current_clip: int, total_clips: int, message: str):
    with export_state_lock:
        active_export_state["current_clip"] = current_clip
        active_export_state["total_clips"] = total_clips
        active_export_state["message"] = message


def set_active_export_process(process):
    with export_state_lock:
        active_export_state["process"] = process


def clear_active_export_process(process=None):
    with export_state_lock:
        current_process = active_export_state["process"]
        if process is None or current_process is process:
            active_export_state["process"] = None


def request_export_stop() -> tuple[bool, bool]:
    with export_state_lock:
        if not active_export_state["active"]:
            return False, False

        active_export_state["stop_requested"] = True
        process = active_export_state["process"]

    if process is None:
        return True, False

    try:
        if process.returncode is None:
            process.terminate()
            return True, True
    except ProcessLookupError:
        pass
    except Exception:
        return True, False

    return True, False


async def run_managed_export_process(cmd: list[str]) -> tuple[int, bytes, bytes, bool]:
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    set_active_export_process(process)
    try:
        stdout, stderr = await process.communicate()
    finally:
        clear_active_export_process(process)

    return process.returncode, stdout or b"", stderr or b"", is_export_stop_requested()


def parse_export_video_mode(video_bitrate: str | int) -> tuple[str, int | None]:
    raw_value = str(video_bitrate).strip().lower()
    if raw_value in {"copy", "no-compress", "nocompress", "no_compress"}:
        return "copy", None

    try:
        return "reencode", max(1, int(float(raw_value)))
    except ValueError as e:
        raise ValueError(f"映像ビットレートの指定が不正です: {video_bitrate}") from e


def build_export_output_filename(source_path: Path, start: float, end: float, export_mode: str) -> str:
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    start_sec = int(start)
    end_sec = int(end)
    suffix = source_path.suffix if export_mode == "copy" and source_path.suffix else ".mp4"
    return f"{timestamp}_{start_sec:02d}-{end_sec:02d}{suffix}"


def build_export_command(
    file_path: str,
    start: float,
    duration_sec: float,
    output_path: str,
    fps: int,
    video_bitrate: int | None,
    audio_bitrate: int,
    export_mode: str,
) -> list[str]:
    if export_mode == "copy":
        copy_cmd = [
            FFMPEG, "-y",
            "-ss", str(start),
            "-i", file_path,
            "-t", str(duration_sec),
            "-c", "copy",
            "-avoid_negative_ts", "make_zero",
        ]
        if Path(output_path).suffix.lower() in {".mp4", ".mov", ".m4v"}:
            copy_cmd.extend(["-movflags", "+faststart"])
        copy_cmd.append(output_path)
        return copy_cmd

    return [
        FFMPEG, "-y",
        "-ss", str(start),
        "-i", file_path,
        "-t", str(duration_sec),
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level", "4.2",
        "-preset", "veryslow",
        "-pix_fmt", "yuv420p",
        "-b:v", f"{video_bitrate}k",
        "-maxrate", f"{video_bitrate}k",
        "-bufsize", f"{video_bitrate*2}k",
        "-r", str(fps),
        "-c:a", "aac",
        "-b:a", f"{audio_bitrate}k",
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        output_path,
    ]


def quote_concat_file_path(file_path: str) -> str:
    normalized_path = Path(file_path).expanduser().as_posix()
    escaped_path = normalized_path.replace("'", r"'\''")
    return f"file '{escaped_path}'\n"


async def write_concat_list_file(file_paths: list[str]) -> str:
    temp_fd, concat_list_path = tempfile.mkstemp(prefix="concat_", suffix=".txt", dir=str(TEMP_DIR))
    with os.fdopen(temp_fd, "w", encoding="utf-8") as concat_file:
        for file_path in file_paths:
            concat_file.write(quote_concat_file_path(file_path))
    return concat_list_path


async def broadcast_export_progress(
    message: str,
    percent: float,
    current_clip: int,
    total_clips: int,
    phase: str,
):
    update_export_session_status(current_clip, total_clips, message)
    await broadcast_progress(
        message,
        percent,
        "export_progress",
        {
            "current_clip": current_clip,
            "total_clips": total_clips,
            "phase": phase,
        },
    )


def build_waveform_data(raw_path: str, sample_rate: int, samples_per_second: int = 10) -> list[dict]:
    raw_data = np.fromfile(raw_path, dtype=np.int16)
    audio_data = raw_data.astype(np.float32) / 32768.0
    samples_per_point = sample_rate // samples_per_second
    total_points = len(audio_data) // samples_per_point

    waveform = []
    for i in range(total_points):
        start = i * samples_per_point
        end = min(start + samples_per_point, len(audio_data))
        chunk = audio_data[start:end]
        if len(chunk) > 0:
            waveform.append({
                "min": float(np.min(chunk)),
                "max": float(np.max(chunk))
            })
        else:
            waveform.append({"min": 0.0, "max": 0.0})

    return waveform


async def broadcast_progress(
    message: str,
    percent: float,
    msg_type: str = "progress",
    extra: dict | None = None,
):
    """全WebSocketクライアントに進捗を送信"""
    payload = {
        "type": msg_type,
        "message": message,
        "percent": round(percent, 1)
    }
    if extra:
        payload.update(extra)

    data = json.dumps(payload)
    for ws in active_connections:
        try:
            await ws.send_text(data)
        except Exception:
            pass


# ===== API エンドポイント =====

@app.get("/")
async def serve_html():
    """HTMLファイルを配信"""
    html_path = BASE_DIR / "movie-autocut.html"
    return FileResponse(html_path, media_type="text/html", headers=NO_CACHE_HEADERS.copy())


@app.get("/app.js")
async def serve_app_js():
    """メインJavaScriptファイルを配信"""
    js_path = BASE_DIR / "app.js"
    return FileResponse(js_path, media_type="application/javascript", headers=NO_CACHE_HEADERS.copy())


@app.get("/review")
async def serve_review_html():
    """高速判定ページを配信"""
    html_path = BASE_DIR / "review.html"
    return FileResponse(html_path, media_type="text/html", headers=NO_CACHE_HEADERS.copy())


@app.get("/review.js")
async def serve_review_js():
    """高速判定ページ用のJavaScriptを配信"""
    js_path = BASE_DIR / "review.js"
    return FileResponse(js_path, media_type="application/javascript", headers=NO_CACHE_HEADERS.copy())


@app.post("/api/analyze")
async def analyze_audio(file_path: str = Form(...)):
    """
    音声波形解析 API
    FFmpegで音声をPCM抽出 → NumPyで波形データ(min/max)を計算
    """
    if not os.path.exists(file_path):
        return JSONResponse({"error": f"ファイルが見つかりません: {file_path}"}, status_code=400)
    
    try:
        # 動画の長さを取得
        duration = get_video_duration(file_path)
        state = get_analysis_state(file_path)
        state["duration"] = duration
        
        await broadcast_progress("音声抽出中...", 5)
        
        # FFmpegで音声をPCM (raw) として抽出
        # サンプリングレート8000Hzで十分（波形表示用）
        SAMPLE_RATE = 8000
        temp_fd, wav_path = tempfile.mkstemp(prefix="audio_", suffix=".raw", dir=str(TEMP_DIR))
        os.close(temp_fd)
        
        cmd = [
            FFMPEG, "-y",
            "-i", file_path,
            "-vn",                    # 映像なし
            "-ac", "1",               # モノラル
            "-ar", str(SAMPLE_RATE),  # サンプリングレート
            "-f", "s16le",            # 16bit signed little endian
            "-acodec", "pcm_s16le",   # PCM
            wav_path
        ]
        
        try:
            returncode, _, stderr = await run_process_capture(cmd)
            if returncode != 0:
                error_text = stderr.decode("utf-8", errors="replace")
                return JSONResponse({"error": f"髻ｳ螢ｰ謚ｽ蜃ｺ縺ｫ螟ｱ謨・ {error_text[:500]}"}, status_code=500)

            await broadcast_progress("豕｢蠖｢繝・・繧ｿ險育ｮ嶺ｸｭ...", 40)
            waveform = await asyncio.to_thread(build_waveform_data, wav_path, SAMPLE_RATE)
            state["waveform_data"] = waveform

            await broadcast_progress("隗｣譫仙ｮ御ｺ・", 100)

            return JSONResponse({
                "success": True,
                "duration": duration,
                "waveform": waveform,
                "sample_rate": 10,
                "total_points": len(waveform)
            })
        finally:
            try:
                os.remove(wav_path)
            except OSError:
                pass

        returncode, _, stderr = await run_process_capture(cmd)

        if returncode != 0:
            error_text = stderr.decode("utf-8", errors="replace")
            results.append({
                "clip": i + 1,
                "success": False,
                "error": error_text[:200]
            })
            await broadcast_progress(f"クリップ {i+1} でエラー発生", (i / len(clips)) * 100, "error")
            return JSONResponse({"error": "legacy analyze path should not run"}, status_code=500)

        file_size = os.path.getsize(output_path)
        results.append({
            "clip": i + 1,
            "success": True,
            "path": output_path,
            "filename": output_filename,
            "size_mb": round(file_size / (1024 * 1024), 2)
        })
        await broadcast_progress(
            f"繧ｯ繝ｪ繝・・ {i+1} 螳御ｺ・({output_filename})",
            ((i + 1) / len(clips)) * 100,
            "clip_done"
        )
        return JSONResponse({"error": "legacy analyze path should not run"}, status_code=500)

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        
        _, stderr = process.communicate()
        
        if process.returncode != 0:
            error_text = stderr.decode("utf-8", errors="replace")
            return JSONResponse({"error": f"音声抽出に失敗: {error_text[:500]}"}, status_code=500)
        
        await broadcast_progress("波形データ計算中...", 40)
        
        # PCMデータを読み込み
        raw_data = np.fromfile(wav_path, dtype=np.int16)
        
        # 正規化 (-1.0 ～ 1.0)
        audio_data = raw_data.astype(np.float32) / 32768.0
        
        # 波形データを生成（1秒あたり10ポイント）
        SAMPLES_PER_SECOND = 10
        samples_per_point = SAMPLE_RATE // SAMPLES_PER_SECOND
        total_points = len(audio_data) // samples_per_point
        
        waveform = []
        for i in range(total_points):
            start = i * samples_per_point
            end = min(start + samples_per_point, len(audio_data))
            chunk = audio_data[start:end]
            
            if len(chunk) > 0:
                waveform.append({
                    "min": float(np.min(chunk)),
                    "max": float(np.max(chunk))
                })
            else:
                waveform.append({"min": 0.0, "max": 0.0})
        
        current_state["waveform_data"] = waveform
        
        # 一時ファイルを削除
        try:
            os.remove(wav_path)
        except OSError:
            pass
        
        await broadcast_progress("解析完了!", 100)
        
        return JSONResponse({
            "success": True,
            "duration": duration,
            "waveform": waveform,
            "sample_rate": SAMPLES_PER_SECOND,
            "total_points": len(waveform)
        })
        
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/detect-spikes")
async def detect_spikes(
    file_path: str = Form(...),
    loud_threshold_db: float = Form(-38),
    duration_sec: float = Form(1.0),
    min_gap: float = Form(35.0),
    clip_duration: float = Form(32.0),
):
    """
    音量継続検出 API
    閾値(X)以上の音が、指定秒数(Y)維持されたポイントを検出してZ秒切り出す
    """
    state = get_analysis_state(file_path)
    if state["waveform_data"] is None:
        resp = await analyze_audio(file_path)
        if hasattr(resp, 'status_code') and resp.status_code != 200:
            return resp
        state = get_analysis_state(file_path)
    
    waveform = state["waveform_data"]
    duration = state["duration"]
    
    if not waveform:
        return JSONResponse({"error": "波形データがありません"}, status_code=400)
    
    await broadcast_progress("音量条件に一致する箇所を検出中...", 10)
    
    # 閾値をリニアスケールに変換
    loud_threshold = 10 ** (loud_threshold_db / 20)
    
    # サンプリングレートと必要な連続サンプル数
    waveform_sample_rate = len(waveform) / duration if duration > 0 else 10
    duration_samples = max(1, int(duration_sec * waveform_sample_rate))
    min_gap_samples = int(min_gap * waveform_sample_rate)
    
    spike_moments = []
    last_detection_sample = -min_gap_samples * 2
    continuous_loud_samples = 0
    
    for i in range(len(waveform)):
        point = waveform[i]
        # そのサンプルの絶対的な最大振幅
        amplitude = max(abs(point.get("min", 0)), abs(point.get("max", 0)))
        
        if amplitude >= loud_threshold:
            continuous_loud_samples += 1
        else:
            continuous_loud_samples = 0
            
        # 指定秒数以上連続して大きな音が出ているか？
        if continuous_loud_samples >= duration_samples:
            gap = i - last_detection_sample
            if gap > min_gap_samples:
                # 連続し始めた開始位置（秒数）を計算
                start_sample = i - duration_samples + 1
                time_in_seconds = start_sample / waveform_sample_rate
                
                spike_moments.append(time_in_seconds)
                last_detection_sample = i
                
                # 次の検出までリセットして確実にmin_gap待たせる
                continuous_loud_samples = 0
                
        if i % 1000 == 0:
            progress = 10 + (i / len(waveform)) * 80
            await broadcast_progress(f"検出中... {i}/{len(waveform)}", progress)
    
    state["detected_spikes"] = spike_moments
    
    # クリップを生成
    clips = []
    for start_time in spike_moments:
        end_time = min(start_time + clip_duration, duration)
        if end_time - start_time > 0.5:
            clips.append({"start": round(start_time, 3), "end": round(end_time, 3)})
    
    await broadcast_progress(f"検出完了! {len(spike_moments)}箇所", 100)
    
    return JSONResponse({
        "success": True,
        "spikes": spike_moments,
        "clips": clips,
        "count": len(spike_moments)
    })


def _calculate_rms(segment: list) -> float:
    """波形セグメントのRMS値を計算"""
    if not segment:
        return 0.0
    
    total = 0.0
    for point in segment:
        amplitude = max(abs(point["min"]), abs(point["max"]))
        total += amplitude * amplitude
    
    return math.sqrt(total / len(segment))


async def export_clips_internal(
    file_path: str,
    clips_json: str,
    output_dir: str,
    fps: int,
    video_bitrate: str,
    audio_bitrate: int,
):
    if not os.path.exists(file_path):
        return JSONResponse({"error": f"ファイルが見つかりません: {file_path}"}, status_code=400)

    try:
        clips = json.loads(clips_json)
    except json.JSONDecodeError:
        return JSONResponse({"error": "クリップ情報の形式が不正です"}, status_code=400)

    if not clips:
        return JSONResponse({"error": "クリップがありません"}, status_code=400)

    if not output_dir or not os.path.isdir(output_dir):
        output_dir = str(Path(file_path).parent)

    try:
        export_mode, normalized_video_bitrate = parse_export_video_mode(video_bitrate)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    if not begin_export_session(len(clips)):
        return JSONResponse({"error": "別の書き出し処理が進行中です。停止または完了を待ってください"}, status_code=409)

    source_path = Path(file_path)
    results = []
    cancelled = False

    try:
        for i, clip in enumerate(clips):
            if is_export_stop_requested():
                cancelled = True
                break

            start = clip["start"]
            end = clip["end"]
            duration_sec = end - start
            current_clip = i + 1
            total_clips = len(clips)

            await broadcast_export_progress(
                f"クリップ {current_clip}/{total_clips} を書き出し中... ({format_time(start)} → {format_time(end)})",
                (i / total_clips) * 100,
                current_clip,
                total_clips,
                "encoding",
            )

            output_filename = build_export_output_filename(source_path, start, end, export_mode)
            output_path = os.path.join(output_dir, output_filename)
            cmd = build_export_command(
                file_path=file_path,
                start=start,
                duration_sec=duration_sec,
                output_path=output_path,
                fps=fps,
                video_bitrate=normalized_video_bitrate,
                audio_bitrate=audio_bitrate,
                export_mode=export_mode,
            )

            returncode, _, stderr, was_cancelled = await run_managed_export_process(cmd)

            if was_cancelled:
                cancelled = True
                break

            if returncode != 0:
                error_text = stderr.decode("utf-8", errors="replace")
                results.append({
                    "clip": current_clip,
                    "success": False,
                    "error": error_text[:200]
                })
                await broadcast_progress(
                    f"クリップ {current_clip} でエラー発生",
                    (i / total_clips) * 100,
                    "error",
                    {
                        "current_clip": current_clip,
                        "total_clips": total_clips,
                        "phase": "error",
                    },
                )
                continue

            file_size = os.path.getsize(output_path)
            results.append({
                "clip": current_clip,
                "success": True,
                "path": output_path,
                "filename": output_filename,
                "size_mb": round(file_size / (1024 * 1024), 2),
                "export_mode": export_mode,
            })
            await broadcast_progress(
                f"クリップ {current_clip} 完了 ({output_filename})",
                (current_clip / total_clips) * 100,
                "clip_done",
                {
                    "current_clip": current_clip,
                    "total_clips": total_clips,
                    "phase": "clip_done",
                },
            )
    finally:
        finish_export_session()

    if cancelled:
        completed_count = len([result for result in results if result.get("success")])
        await broadcast_progress(
            f"書き出しを停止しました ({completed_count}/{len(clips)} 完了)",
            (completed_count / len(clips)) * 100 if clips else 0,
            "export_progress",
            {
                "current_clip": completed_count,
                "total_clips": len(clips),
                "phase": "cancelled",
            },
        )
        return JSONResponse({
            "success": True,
            "cancelled": True,
            "results": results,
            "output_dir": output_dir,
        })

    await broadcast_progress(
        "全クリップの書き出しが完了しました!",
        100,
        "export_progress",
        {
            "current_clip": len(clips),
            "total_clips": len(clips),
            "phase": "complete",
        },
    )

    return JSONResponse({
        "success": True,
        "results": results,
        "output_dir": output_dir
    })


@app.post("/api/export-clips")
async def export_clips(
    file_path: str = Form(...),
    clips_json: str = Form(...),
    output_dir: str = Form(""),
    fps: int = Form(30),
    video_bitrate: str = Form("4500"),
    audio_bitrate: int = Form(128),
):
    """
    動画クリップ切り出し API
    FFmpegでフレーム精度の切り出しを実行
    """
    return await export_clips_internal(
        file_path=file_path,
        clips_json=clips_json,
        output_dir=output_dir,
        fps=fps,
        video_bitrate=video_bitrate,
        audio_bitrate=audio_bitrate,
    )


@app.post("/api/export-clips-async")
async def export_clips_async(
    file_path: str = Form(...),
    clips_json: str = Form(...),
    output_dir: str = Form(""),
    fps: int = Form(30),
    video_bitrate: str = Form("4500"),
    audio_bitrate: int = Form(128),
):
    return await export_clips_internal(
        file_path=file_path,
        clips_json=clips_json,
        output_dir=output_dir,
        fps=fps,
        video_bitrate=video_bitrate,
        audio_bitrate=audio_bitrate,
    )


@app.post("/api/export-stop")
async def export_stop():
    stop_requested, signal_sent = request_export_stop()
    if not stop_requested:
        return JSONResponse({"success": False, "error": "停止できる書き出し処理がありません"}, status_code=409)

    with export_state_lock:
        snapshot_total = int(active_export_state.get("total_clips", 0) or 0)
        snapshot_current = int(active_export_state.get("current_clip", 0) or 0)
    await broadcast_progress(
        "書き出し停止を要求しました...",
        (snapshot_current / snapshot_total) * 100 if snapshot_total else 0,
        "export_progress",
        {
            "current_clip": snapshot_current,
            "total_clips": snapshot_total,
            "phase": "stopping",
        },
    )
    return JSONResponse({"success": True, "signal_sent": signal_sent})


@app.post("/api/merge-videos")
async def merge_videos(
    file_paths_json: str = Form(...),
    output_dir: str = Form(""),
    merge_mode: str = Form("auto"),
):
    try:
        raw_paths = json.loads(file_paths_json)
    except json.JSONDecodeError:
        return JSONResponse({"error": "結合対象の動画一覧の形式が不正です"}, status_code=400)

    if not isinstance(raw_paths, list) or len(raw_paths) < 2:
        return JSONResponse({"error": "2本以上の動画を指定してください"}, status_code=400)

    file_paths = [str(Path(path).expanduser()) for path in raw_paths if str(path).strip()]
    if len(file_paths) < 2:
        return JSONResponse({"error": "2本以上の動画を指定してください"}, status_code=400)

    for file_path in file_paths:
        if not os.path.isfile(file_path):
            return JSONResponse({"error": f"動画ファイルが見つかりません: {file_path}"}, status_code=400)

    if not output_dir or not os.path.isdir(output_dir):
        output_dir = str(Path(file_paths[0]).parent)

    merge_mode = str(merge_mode or "auto").strip().lower()
    source_suffixes = {Path(path).suffix.lower() for path in file_paths if Path(path).suffix}
    output_suffix = ".mp4"
    if merge_mode == "copy" and len(source_suffixes) == 1:
        output_suffix = next(iter(source_suffixes))

    output_filename = f"{time.strftime('%Y%m%d_%H%M%S')}_merged{output_suffix}"
    output_path = os.path.join(output_dir, output_filename)
    concat_list_path = await write_concat_list_file(file_paths)

    try:
        await broadcast_progress(f"{len(file_paths)}本の動画結合を準備中...", 5)

        copy_cmd = [
            FFMPEG, "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", concat_list_path,
            "-c", "copy",
            output_path,
        ]
        returncode, _, stderr = await run_process_capture(copy_cmd)
        merge_method = "copy"

        if returncode != 0 and merge_mode != "copy":
            await broadcast_progress("結合形式を調整して再処理中...", 45)
            output_path = os.path.join(output_dir, f"{time.strftime('%Y%m%d_%H%M%S')}_merged.mp4")
            encode_cmd = [
                FFMPEG, "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", concat_list_path,
                "-c:v", "libx264",
                "-preset", "medium",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-movflags", "+faststart",
                output_path,
            ]
            returncode, _, stderr = await run_process_capture(encode_cmd)
            merge_method = "reencode"

        if returncode != 0:
            error_text = stderr.decode("utf-8", errors="replace")
            return JSONResponse({"error": f"動画結合に失敗しました: {error_text[:500]}"}, status_code=500)

        merged_size = os.path.getsize(output_path)
        await broadcast_progress("動画結合が完了しました!", 100)
        return JSONResponse({
            "success": True,
            "output_path": output_path,
            "output_filename": os.path.basename(output_path),
            "output_dir": output_dir,
            "file_count": len(file_paths),
            "size_mb": round(merged_size / (1024 * 1024), 2),
            "merge_method": merge_method,
        })
    finally:
        try:
            os.remove(concat_list_path)
        except OSError:
            pass


@app.post("/api/compress")
async def compress_video(
    file_path: str = Form(...),
    output_dir: str = Form(...),
    resolution: str = Form("720"),
    video_bitrate: int = Form(2500),
    audio_bitrate: int = Form(100),
    start_time: float = Form(0),
    end_time: float = Form(0)
):
    """
    動画圧縮 API
    FFmpegによる本格的なH.264圧縮
    """
    if not os.path.exists(file_path):
        return JSONResponse({"error": f"ファイルが見つかりません: {file_path}"}, status_code=400)
    
    # 出力先
    if not output_dir or not os.path.isdir(output_dir):
        output_dir = str(Path(file_path).parent)
    
    # 動画情報取得
    duration = get_video_duration(file_path)
    if end_time < 0:
        end_time = duration
    
    compress_duration = end_time - start_time
    
    await broadcast_progress("圧縮準備中...", 5)
    
    # 出力ファイル名
    base_name = Path(file_path).stem
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    start_sec = int(start_time)
    end_sec = int(end_time)
    output_filename = f"{base_name}_compressed_{start_sec}-{end_sec}s_{timestamp}.mp4"
    output_path = os.path.join(output_dir, output_filename)
    
    # 解像度フィルター
    vf_filters = []
    if resolution != "original":
        target_height = int(resolution)
        # 偶数に揃える
        vf_filters.append(f"scale=-2:{target_height}")
    
    # FFmpegコマンド構築 (X/Twitter互換・超高圧縮設定)
    cmd = [
        FFMPEG, "-y",
        "-ss", str(start_time),
        "-i", file_path,
        "-t", str(compress_duration),
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level", "4.2",
        "-preset", "veryslow",
        "-pix_fmt", "yuv420p",
        "-b:v", f"{video_bitrate}k",
        "-maxrate", f"{video_bitrate}k",
        "-bufsize", f"{video_bitrate * 2}k",
        "-c:a", "aac",
        "-b:a", f"{audio_bitrate}k",
        "-movflags", "+faststart",
        "-progress", "pipe:1",  # 進捗出力
    ]
    
    if vf_filters:
        cmd.extend(["-vf", ",".join(vf_filters)])
    
    cmd.append(output_path)
    
    await broadcast_progress("圧縮開始...", 10)
    
    # 進捗を取得しながら実行
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    
    # 進捗解析 (stdoutの progress出力を解析)
    if process.stdout:
        while True:
            raw_line = await process.stdout.readline()
            if not raw_line:
                break
            line = raw_line.decode("utf-8", errors="replace").strip()
            if line.startswith("out_time_ms="):
                try:
                    out_time_us = int(line.split("=")[1])
                    current_sec = out_time_us / 1_000_000
                    progress = min(95, 10 + (current_sec / compress_duration) * 85)
                    await broadcast_progress(
                        f"圧縮中... {current_sec:.1f}秒 / {compress_duration:.1f}秒",
                        progress,
                        "compress_progress"
                    )
                except (ValueError, ZeroDivisionError):
                    pass
    
    await process.wait()
    
    if process.returncode != 0:
        stderr_bytes = await process.stderr.read() if process.stderr else b""
        stderr_text = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else "荳肴・縺ｪ繧ｨ繝ｩ繝ｼ"
        return JSONResponse({"error": f"蝨ｧ邵ｮ縺ｫ螟ｱ謨・ {stderr_text[:500]}"}, status_code=500)

    if process.returncode != 0:
        stderr_text = process.stderr.read() if process.stderr else "不明なエラー"
        return JSONResponse({"error": f"圧縮に失敗: {stderr_text[:500]}"}, status_code=500)
    
    # 結果
    original_size = os.path.getsize(file_path)
    compressed_size = os.path.getsize(output_path)
    reduction = (1 - compressed_size / original_size) * 100 if original_size > 0 else 0
    
    await broadcast_progress("圧縮完了!", 100)
    
    return JSONResponse({
        "success": True,
        "output_path": output_path,
        "output_filename": output_filename,
        "original_size_mb": round(original_size / (1024 * 1024), 2),
        "compressed_size_mb": round(compressed_size / (1024 * 1024), 2),
        "reduction_percent": round(reduction, 1),
        "duration": compress_duration,
    })


@app.post("/api/video-info")
async def get_video_info(file_path: str = Form(...)):
    """動画の基本情報を取得"""
    if not os.path.exists(file_path):
        return JSONResponse({"error": f"ファイルが見つかりません: {file_path}"}, status_code=400)
    
    try:
        duration = get_video_duration(file_path)
        file_size = os.path.getsize(file_path)
        
        return JSONResponse({
            "success": True,
            "duration": duration,
            "file_size_mb": round(file_size / (1024 * 1024), 2),
            "file_name": os.path.basename(file_path),
            "file_path": file_path,
        })
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/open-folder")
async def open_folder(path: str):
    """フォルダをファイルエクスプローラーで開く"""
    folder = Path(path)
    if folder.is_file():
        folder = folder.parent
    
    if not folder.exists():
        return JSONResponse({"error": "フォルダが存在しません"}, status_code=400)
    
    try:
        if sys.platform == "win32":
            os.startfile(str(folder))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            opener = shutil.which("xdg-open")
            if not opener:
                return JSONResponse({"error": "このOSではフォルダを開くコマンドが見つかりません"}, status_code=501)
            subprocess.Popen([opener, str(folder)])
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    return JSONResponse({"success": True})


@app.get("/api/app-config")
async def get_app_config():
    return JSONResponse({
        "platform": sys.platform,
        "review_ok_dir": str(REVIEW_OK_DIR),
        "review_reject_dir": str(REVIEW_REJECT_DIR),
        "auto_export_source_dir": str(get_default_auto_export_source_dir()),
        "auto_export_output_dir": str(get_default_auto_export_output_dir()),
    })


@app.post("/api/resolve-dropped-files")
async def resolve_dropped_files(file_metadata_json: str = Form(...)):
    try:
        file_metadata = json.loads(file_metadata_json)
    except json.JSONDecodeError:
        return JSONResponse({"error": "ドロップファイル情報の形式が不正です"}, status_code=400)

    if not isinstance(file_metadata, list):
        return JSONResponse({"error": "ドロップファイル情報は配列で指定してください"}, status_code=400)

    resolved_paths = []
    unresolved = []
    ambiguous = []

    for item in file_metadata[:1000]:
        if not isinstance(item, dict):
            continue

        file_name = Path(str(item.get("name") or "")).name
        if not file_name:
            continue

        raw_size = item.get("size")
        try:
            file_size = int(raw_size) if raw_size is not None else None
        except (TypeError, ValueError):
            file_size = None

        matches = find_dropped_file_matches(file_name, file_size)
        if len(matches) == 1:
            resolved_paths.append(matches[0])
        elif len(matches) > 1:
            ambiguous.append({"name": file_name, "matches": matches[:10]})
        else:
            unresolved.append(file_name)

    return JSONResponse({
        "success": True,
        "paths": resolved_paths,
        "unresolved": unresolved,
        "ambiguous": ambiguous,
        "search_roots": [str(path) for path in get_dropped_file_search_roots()],
    })


@app.get("/api/dialog/open-file")
async def dialog_open_file():
    """ネイティブのファイル選択ダイアログを開き、選択されたパスを返す"""
    import tkinter as tk
    from tkinter import filedialog
    
    root = tk.Tk()
    prepare_dialog_root(root)
    root.withdraw()        # メインウィンドウを非表示
    root.attributes("-topmost", True)  # 最前面に表示
    
    file_path = filedialog.askopenfilename(
        title="動画ファイルを選択",
        filetypes=[
            ("動画ファイル", "*.mp4 *.mov *.avi *.mkv *.wmv *.flv *.webm *.m4v *.ts *.mts"),
            ("すべてのファイル", "*.*"),
        ]
    )
    root.destroy()
    
    if file_path:
        # Windowsのパス区切りに統一
        file_path = normalize_dialog_selection(file_path)
        return JSONResponse({"success": True, "path": file_path})
    else:
        return JSONResponse({"success": False, "path": ""})


@app.get("/api/dialog/open-files")
async def dialog_open_files():
    """ネイティブの複数ファイル選択ダイアログを開き、選択された動画パス一覧を返す"""
    import tkinter as tk
    from tkinter import filedialog

    root = None
    try:
        root = tk.Tk()
        prepare_dialog_root(root)

        file_paths = filedialog.askopenfilenames(
            title="判定する動画ファイルを複数選択",
            filetypes=[
                ("動画ファイル", "*.mp4 *.mov *.avi *.mkv *.wmv *.flv *.webm *.m4v *.ts *.mts"),
                ("すべてのファイル", "*.*"),
            ]
        )

        normalized_paths = [normalize_dialog_selection(path) for path in file_paths if path]
        return JSONResponse({
            "success": len(normalized_paths) > 0,
            "paths": normalized_paths,
        })
    except Exception as e:
        return JSONResponse({"success": False, "paths": [], "error": str(e)}, status_code=500)
    finally:
        if root is not None:
            root.destroy()


@app.get("/api/dialog/open-directory")
async def dialog_open_directory():
    """ネイティブのフォルダ選択ダイアログを開き、選択されたパスを返す"""
    import tkinter as tk
    from tkinter import filedialog

    root = None
    try:
        root = tk.Tk()
        prepare_dialog_root(root)

        dir_path = filedialog.askdirectory(
            parent=root,
            title="フォルダを選択",
            mustexist=True,
        )

        if dir_path:
            dir_path = normalize_dialog_selection(dir_path)
            return JSONResponse({"success": True, "path": dir_path})
        return JSONResponse({"success": False, "path": ""})
    except Exception as e:
        return JSONResponse({"success": False, "path": "", "error": str(e)}, status_code=500)
    finally:
        if root is not None:
            root.destroy()


@app.post("/api/delete-file")
async def delete_file(file_path: str = Form(...)):
    """指定された動画ファイルを削除フォルダへ移動する"""
    return await review_move_file(file_path=file_path, target_directory=str(REVIEW_REJECT_DIR))


@app.post("/api/review/move-file")
async def review_move_file(
    file_path: str = Form(...),
    target_directory: str = Form(...),
    destination_name: str = Form(None),
):
    """指定された動画ファイルを任意の移動先フォルダへ移動する"""
    path = Path(file_path)
    target_text = str(target_directory or "").strip()
    if not target_text:
        return JSONResponse({"error": "移動先フォルダが未設定です"}, status_code=400)

    destination_dir = Path(target_text).expanduser()

    if path.exists() and not path.is_file():
        return JSONResponse({"error": f"ファイルではありません: {file_path}"}, status_code=400)

    if destination_dir.exists() and not destination_dir.is_dir():
        return JSONResponse({"error": f"移動先がフォルダではありません: {target_directory}"}, status_code=400)

    normalized_path = normalize_managed_path(path)
    normalized_destination_dir = normalize_managed_path(destination_dir)

    if path.exists() and normalize_managed_path(path.parent) == normalized_destination_dir:
        return JSONResponse({"error": "元ファイルと同じフォルダは指定できません"}, status_code=400)

    if not path.exists():
        return JSONResponse({
            "success": True,
            "already_missing": True,
            "moved_from_path": normalized_path,
            "target_directory": normalized_destination_dir,
            "moved_name": path.name,
        })

    try:
        result = await execute_review_file_move(path, destination_dir, destination_name=destination_name)
        result["queued"] = False
        result["queue_state"] = "completed" if not result.get("already_missing") else "already_missing"
        return JSONResponse(result)
    except FileExistsError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/review/restore-file")
async def review_restore_file(
    moved_file_path: str = Form(...),
    original_path: str = Form(...),
):
    """移動済み動画を元のパスへ戻す"""
    moved_path = Path(moved_file_path)
    original_target_path = Path(original_path).expanduser()
    original_text = str(original_path or "").strip()
    if not original_text:
        return JSONResponse({"error": "元のファイルパスが未設定です"}, status_code=400)

    if moved_path.exists() and not moved_path.is_file():
        return JSONResponse({"error": f"戻し元がファイルではありません: {moved_file_path}"}, status_code=400)

    if original_target_path.exists() and not original_target_path.is_file():
        return JSONResponse({"error": f"元の復元先がファイルではありません: {original_path}"}, status_code=400)

    normalized_moved_path = normalize_managed_path(moved_path)
    normalized_original_path = normalize_managed_path(original_target_path)

    if moved_path.exists() and normalized_moved_path == normalized_original_path:
        return JSONResponse({
            "success": True,
            "already_restored": True,
            "restored_path": normalized_original_path,
            "restored_name": original_target_path.name,
        })

    if original_target_path.exists() and normalized_moved_path != normalized_original_path:
        return JSONResponse(
            {"error": f"元の場所に同名ファイルが既にあります: {normalized_original_path}"},
            status_code=409,
        )

    if not moved_path.exists():
        if original_target_path.exists():
            return JSONResponse({
                "success": True,
                "already_restored": True,
                "restored_path": normalized_original_path,
                "restored_name": original_target_path.name,
            })
        return JSONResponse({"error": f"戻し元ファイルが見つかりません: {moved_file_path}"}, status_code=404)

    try:
        result = await execute_review_file_move(
            moved_path,
            original_target_path.parent,
            destination_name=original_target_path.name,
            require_original_name=True,
        )
        return JSONResponse({
            "success": True,
            "already_restored": False,
            "moved_from_path": result.get("moved_from_path", normalized_moved_path),
            "restored_path": result.get("moved_to_path", normalized_original_path),
            "restored_name": result.get("moved_name", original_target_path.name),
        })
    except FileExistsError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ===== WebSocket エンドポイント =====

@app.websocket("/ws/progress")
async def websocket_progress(websocket: WebSocket):
    """進捗通知用のWebSocket"""
    await websocket.accept()
    active_connections.append(websocket)
    
    try:
        while True:
            # クライアントからのメッセージを待つ（接続維持用）
            data = await websocket.receive_text()
            # pingにはpongで応答
            if data == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in active_connections:
            active_connections.remove(websocket)


from fastapi import Request

# ===== 動画ファイルの配信（ブラウザでの再生用） =====

@app.get("/api/video")
async def serve_video(path: str, request: Request):
    """動画ファイルをストリーム配信（Range対応で大容量動画のシークを高速化）"""
    if not os.path.exists(path):
        return JSONResponse({"error": "ファイルが見つかりません"}, status_code=404)

    file_path = Path(path)
    normalized_path = normalize_managed_path(file_path)
    file_size = os.path.getsize(file_path)
    range_header = request.headers.get("Range")
    base_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    }

    increment_active_video_stream(normalized_path)
    try:
        if range_header:
            try:
                range_value = range_header.replace("bytes=", "", 1)
                start_text, end_text = range_value.split("-", 1)
                start = int(start_text) if start_text else 0
                end = int(end_text) if end_text else file_size - 1
                start = max(0, min(start, file_size - 1))
                end = max(start, min(end, file_size - 1))
            except Exception:
                return JSONResponse({"error": "無効なRangeヘッダーです"}, status_code=416)

            chunk_size = end - start + 1
            with open(file_path, "rb") as f:
                f.seek(start)
                chunk = f.read(chunk_size)

            headers = base_headers.copy()
            headers.update({
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(len(chunk)),
            })
            return Response(
                content=chunk,
                status_code=206,
                headers=headers,
                media_type="video/mp4",
            )

        with open(file_path, "rb") as f:
            data = f.read()

        headers = base_headers.copy()
        headers["Content-Length"] = str(len(data))
        return Response(
            content=data,
            headers=headers,
            media_type="video/mp4",
        )
    finally:
        decrement_active_video_stream(normalized_path)


# ===== メインエントリーポイント =====

if __name__ == "__main__":
    HOST = "127.0.0.1"
    PORT = 8765
    
    print("=" * 60)
    print("Movie AutoCut - Python Backend Server")
    print("=" * 60)
    print(f"Server URL: http://{HOST}:{PORT}")
    print(f"Work Directory: {BASE_DIR}")
    print(f"FFmpeg: {FFMPEG}")
    print("=" * 60)

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
