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
import wave
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
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

print(f"✅ FFmpeg: {FFMPEG}")
if FFPROBE:
    print(f"✅ FFprobe: {FFPROBE}")
else:
    print("⚠️ FFprobeが見つかりません（一部機能が制限されます）")

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

# WebSocket接続の管理
active_connections: list[WebSocket] = []

# 現在処理中のファイル情報を保持
current_state = {
    "file_path": None,
    "duration": 0,
    "waveform_data": None,
    "detected_spikes": [],
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


async def broadcast_progress(message: str, percent: float, msg_type: str = "progress"):
    """全WebSocketクライアントに進捗を送信"""
    data = json.dumps({
        "type": msg_type,
        "message": message,
        "percent": round(percent, 1)
    })
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
    return FileResponse(html_path, media_type="text/html")


@app.get("/app.js")
async def serve_app_js():
    """メインJavaScriptファイルを配信"""
    js_path = BASE_DIR / "app.js"
    return FileResponse(js_path, media_type="application/javascript")


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
        current_state["file_path"] = file_path
        current_state["duration"] = duration
        
        await broadcast_progress("音声抽出中...", 5)
        
        # FFmpegで音声をPCM (raw) として抽出
        # サンプリングレート8000Hzで十分（波形表示用）
        SAMPLE_RATE = 8000
        wav_path = str(TEMP_DIR / "audio_temp.raw")
        
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
    clip_duration: float = Form(40.0),
):
    """
    音量継続検出 API
    閾値(X)以上の音が、指定秒数(Y)維持されたポイントを検出してZ秒切り出す
    """
    if current_state["waveform_data"] is None or current_state["file_path"] != file_path:
        resp = await analyze_audio(file_path)
        if hasattr(resp, 'status_code') and resp.status_code != 200:
            return resp
    
    waveform = current_state["waveform_data"]
    duration = current_state["duration"]
    
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
    
    current_state["detected_spikes"] = spike_moments
    
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


@app.post("/api/export-clips")
async def export_clips(
    file_path: str = Form(...),
    clips_json: str = Form(...),
    output_dir: str = Form(""),
    fps: int = Form(30),
    video_bitrate: int = Form(4500),
    audio_bitrate: int = Form(128),
):
    """
    動画クリップ切り出し API
    FFmpegでフレーム精度の切り出しを実行
    """
    if not os.path.exists(file_path):
        return JSONResponse({"error": f"ファイルが見つかりません: {file_path}"}, status_code=400)
    
    clips = json.loads(clips_json)
    
    if not clips:
        return JSONResponse({"error": "クリップがありません"}, status_code=400)
    
    # 出力先ディレクトリ
    if not output_dir or not os.path.isdir(output_dir):
        output_dir = str(Path(file_path).parent)
    
    base_name = Path(file_path).stem
    results = []
    
    for i, clip in enumerate(clips):
        start = clip["start"]
        end = clip["end"]
        duration_sec = end - start
        
        await broadcast_progress(
            f"クリップ {i+1}/{len(clips)} を書き出し中... ({format_time(start)} → {format_time(end)})",
            (i / len(clips)) * 100
        )
        
        # ファイル名生成
        start_str = f"{int(start // 60):02d}-{int(start % 60):02d}"
        end_str = f"{int(end // 60):02d}-{int(end % 60):02d}"
        output_filename = f"{base_name}_{start_str}_{end_str}_{video_bitrate}kbps.mp4"
        output_path = os.path.join(output_dir, output_filename)
        
        # FFmpegコマンド (軽量化・指定ビットレートに準拠するための最適化)
        cmd = [
            FFMPEG, "-y",
            "-ss", str(start),           # シーク（入力前に置くことで高速化）
            "-i", file_path,
            "-t", str(duration_sec),      # 長さ
            "-c:v", "libx264",           # H.264エンコード
            "-preset", "slow",           # エンコード速度 (遅くすることで圧縮率UP)
            
            # ビットレートを厳格に制限する（Twitter等の軽量化目的のため）
            "-b:v", f"{video_bitrate}k",
            "-maxrate", f"{video_bitrate}k",
            "-bufsize", f"{video_bitrate*2}k",

            "-r", str(fps),              # FPS
            "-c:a", "aac",               # 音声コーデック
            "-b:a", f"{audio_bitrate}k", # 音声ビットレート
            "-movflags", "+faststart",   # Web最適化
            "-avoid_negative_ts", "make_zero",
            output_path
        ]
        
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        _, stderr = process.communicate()
        
        if process.returncode != 0:
            error_text = stderr.decode("utf-8", errors="replace")
            results.append({
                "clip": i + 1,
                "success": False,
                "error": error_text[:200]
            })
            await broadcast_progress(f"クリップ {i+1} でエラー発生", (i / len(clips)) * 100, "error")
        else:
            file_size = os.path.getsize(output_path)
            results.append({
                "clip": i + 1,
                "success": True,
                "path": output_path,
                "filename": output_filename,
                "size_mb": round(file_size / (1024 * 1024), 2)
            })
            await broadcast_progress(
                f"クリップ {i+1} 完了 ({output_filename})",
                ((i + 1) / len(clips)) * 100,
                "clip_done"
            )
    
    await broadcast_progress("全クリップの書き出しが完了しました!", 100)
    
    return JSONResponse({
        "success": True,
        "results": results,
        "output_dir": output_dir
    })


@app.post("/api/compress")
async def compress_video(
    file_path: str = Form(...),
    output_dir: str = Form(""),
    resolution: str = Form("720"),
    crf: int = Form(23),
    video_bitrate: int = Form(2500),
    audio_bitrate: int = Form(128),
    start_time: float = Form(0),
    end_time: float = Form(-1),
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
    
    # FFmpegコマンド構築
    cmd = [
        FFMPEG, "-y",
        "-ss", str(start_time),
        "-i", file_path,
        "-t", str(compress_duration),
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", str(crf),
        "-b:v", f"{video_bitrate}k",
        "-maxrate", f"{int(video_bitrate * 1.5)}k",
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
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        encoding="utf-8",
        errors="replace"
    )
    
    # 進捗解析 (stdoutの progress出力を解析)
    if process.stdout:
        for line in process.stdout:
            line = line.strip()
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
    
    process.wait()
    
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
    
    if sys.platform == "win32":
        os.startfile(str(folder))
    
    return JSONResponse({"success": True})


@app.get("/api/dialog/open-file")
async def dialog_open_file():
    """ネイティブのファイル選択ダイアログを開き、選択されたパスを返す"""
    import tkinter as tk
    from tkinter import filedialog
    
    root = tk.Tk()
    root.withdraw()        # メインウィンドウを非表示
    root.lift()
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
        file_path = file_path.replace("/", "\\")
        return JSONResponse({"success": True, "path": file_path})
    else:
        return JSONResponse({"success": False, "path": ""})


@app.get("/api/dialog/open-directory")
async def dialog_open_directory():
    """ネイティブのフォルダ選択ダイアログを開き、選択されたパスを返す"""
    import tkinter as tk
    from tkinter import filedialog
    
    root = tk.Tk()
    root.withdraw()
    root.lift()
    root.attributes("-topmost", True)
    
    dir_path = filedialog.askdirectory(
        title="保存先フォルダを選択"
    )
    root.destroy()
    
    if dir_path:
        dir_path = dir_path.replace("/", "\\")
        return JSONResponse({"success": True, "path": dir_path})
    else:
        return JSONResponse({"success": False, "path": ""})


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
from fastapi.responses import StreamingResponse

# ===== 動画ファイルの配信（ブラウザでの再生用） =====

@app.get("/api/video")
async def serve_video(path: str, request: Request):
    """動画ファイルをストリーム配信（Range対応で大容量動画のシークを高速化）"""
    if not os.path.exists(path):
        return JSONResponse({"error": "ファイルが見つかりません"}, status_code=404)
    
    file_size = os.path.getsize(path)
    range_header = request.headers.get("Range")
    
    if range_header:
        byte_range = range_header.replace("bytes=", "").split("-")
        start = int(byte_range[0])
        end = int(byte_range[1]) if byte_range[1] else file_size - 1
        
        chunk_size = end - start + 1
        
        def file_iterator():
            with open(path, "rb") as f:
                f.seek(start)
                bytes_read = 0
                while bytes_read < chunk_size:
                    read_size = min(1024 * 1024, chunk_size - bytes_read)  # 1MB chunks
                    data = f.read(read_size)
                    if not data:
                        break
                    bytes_read += len(data)
                    yield data
                    
        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
        }
        return StreamingResponse(
            file_iterator(),
            status_code=206,
            headers=headers,
            media_type="video/mp4"
        )
    else:
        return FileResponse(
            path,
            media_type="video/mp4",
            headers={"Accept-Ranges": "bytes"}
        )


# ===== メインエントリーポイント =====

if __name__ == "__main__":
    import webbrowser
    
    HOST = "127.0.0.1"
    PORT = 8765
    
    print("=" * 60)
    print("🎬 Movie AutoCut - Python Backend Server")
    print("=" * 60)
    print(f"📡 サーバーアドレス: http://{HOST}:{PORT}")
    print(f"📂 作業ディレクトリ: {BASE_DIR}")
    print(f"🔧 FFmpeg: {FFMPEG}")
    print("=" * 60)
    
    # ブラウザを自動で開く
    webbrowser.open(f"http://{HOST}:{PORT}")
    
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
