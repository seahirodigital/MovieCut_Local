from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

import server


SOURCE_DIR = Path(r"C:\Users\HCY\Downloads\Jinricp\自動抽出")
OUTPUT_DIR = Path(r"C:\Users\HCY\Downloads\Jinricp\自動抽出後")
VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".mkv",
    ".avi",
    ".wmv",
    ".m4v",
    ".webm",
}

# movie-autocut.html の初期値に合わせる
DEFAULT_DETECT_SETTINGS = {
    "loud_threshold_db": -15.0,
    "duration_sec": 23.0,
    "min_gap": 1.0,
    "clip_duration": 28.0,
}

DEFAULT_EXPORT_SETTINGS = {
    "fps": 30,
    "video_bitrate": 2500,
    "audio_bitrate": 100,
}


def response_to_dict(response) -> dict:
    if hasattr(response, "body"):
        body = response.body.decode("utf-8")
        return json.loads(body) if body else {}
    if isinstance(response, dict):
        return response
    raise TypeError(f"想定外のレスポンス型です: {type(response)!r}")


def get_video_files(directory: Path) -> list[Path]:
    return sorted(
        [
            path
            for path in directory.iterdir()
            if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
        ],
        key=lambda path: path.name.lower(),
    )


def build_output_path(source_path: Path, clip_index: int, clip: dict) -> Path:
    start_sec = int(clip["start"])
    end_sec = int(clip["end"])
    base_name = f"{source_path.stem}_{clip_index:03d}_{start_sec:04d}-{end_sec:04d}"
    output_path = OUTPUT_DIR / f"{base_name}.mp4"
    serial = 2

    while output_path.exists():
        output_path = OUTPUT_DIR / f"{base_name}_{serial}.mp4"
        serial += 1

    return output_path


async def detect_clips(file_path: Path) -> list[dict]:
    response = await server.detect_spikes(
        file_path=str(file_path),
        **DEFAULT_DETECT_SETTINGS,
    )
    data = response_to_dict(response)

    if getattr(response, "status_code", 200) >= 400 or data.get("success") is False:
        raise RuntimeError(data.get("error") or "自動検出に失敗しました")

    return data.get("clips", [])


async def export_clip(file_path: Path, clip: dict, clip_index: int, clip_total: int) -> dict:
    output_path = build_output_path(file_path, clip_index, clip)
    start = clip["start"]
    end = clip["end"]
    duration_sec = end - start

    print(
        f"    [{clip_index}/{clip_total}] 書き出し中: "
        f"{server.format_time(start)} -> {server.format_time(end)}"
    )

    cmd = [
        server.FFMPEG,
        "-y",
        "-ss",
        str(start),
        "-i",
        str(file_path),
        "-t",
        str(duration_sec),
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-level",
        "4.2",
        "-preset",
        "veryslow",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        f"{DEFAULT_EXPORT_SETTINGS['video_bitrate']}k",
        "-maxrate",
        f"{DEFAULT_EXPORT_SETTINGS['video_bitrate']}k",
        "-bufsize",
        f"{DEFAULT_EXPORT_SETTINGS['video_bitrate'] * 2}k",
        "-r",
        str(DEFAULT_EXPORT_SETTINGS["fps"]),
        "-c:a",
        "aac",
        "-b:a",
        f"{DEFAULT_EXPORT_SETTINGS['audio_bitrate']}k",
        "-movflags",
        "+faststart",
        "-avoid_negative_ts",
        "make_zero",
        str(output_path),
    ]

    returncode, _, stderr = await server.run_process_capture(cmd)

    if returncode != 0:
        error_text = stderr.decode("utf-8", errors="replace").strip()
        return {
            "success": False,
            "clip_index": clip_index,
            "error": error_text[:300],
        }

    file_size_mb = round(output_path.stat().st_size / (1024 * 1024), 2)
    return {
        "success": True,
        "clip_index": clip_index,
        "output_path": str(output_path),
        "file_size_mb": file_size_mb,
    }


async def process_video(file_path: Path, video_index: int, video_total: int) -> dict:
    print("=" * 72)
    print(f"[{video_index}/{video_total}] {file_path.name}")

    try:
        clips = await detect_clips(file_path)
        print(f"  検出クリップ数: {len(clips)}")

        if not clips:
            print("  出力対象が見つからなかったため、この動画はスキップします。")
            return {
                "file_name": file_path.name,
                "detected": 0,
                "exported": 0,
                "errors": 0,
            }

        success_count = 0
        error_count = 0

        for clip_index, clip in enumerate(clips, start=1):
            result = await export_clip(file_path, clip, clip_index, len(clips))
            if result["success"]:
                success_count += 1
                output_name = Path(result["output_path"]).name
                print(
                    f"      完了: {output_name} "
                    f"({result['file_size_mb']} MB)"
                )
            else:
                error_count += 1
                print(f"      エラー: {result['error']}")

        print(
            f"  完了: {success_count}/{len(clips)} クリップを書き出しました。"
        )
        return {
            "file_name": file_path.name,
            "detected": len(clips),
            "exported": success_count,
            "errors": error_count,
        }
    except Exception as error:
        print(f"  処理エラー: {error}")
        return {
            "file_name": file_path.name,
            "detected": 0,
            "exported": 0,
            "errors": 1,
        }
    finally:
        server.analysis_state_by_file.pop(str(file_path), None)


async def main() -> int:
    print("Movie AutoCut 一括自動出力")
    print(f"入力フォルダ: {SOURCE_DIR}")
    print(f"出力フォルダ: {OUTPUT_DIR}")
    print("-" * 72)

    if not SOURCE_DIR.is_dir():
        print("入力フォルダが見つかりません。")
        return 1

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    video_files = get_video_files(SOURCE_DIR)

    if not video_files:
        print("対象となる動画ファイルが見つかりませんでした。")
        return 0

    print(f"対象動画数: {len(video_files)}")
    summaries = []

    for video_index, file_path in enumerate(video_files, start=1):
        summaries.append(await process_video(file_path, video_index, len(video_files)))

    total_detected = sum(item["detected"] for item in summaries)
    total_exported = sum(item["exported"] for item in summaries)
    total_errors = sum(item["errors"] for item in summaries)

    print("=" * 72)
    print("一括処理が完了しました。")
    print(f"動画数: {len(video_files)}")
    print(f"検出クリップ総数: {total_detected}")
    print(f"書き出し成功総数: {total_exported}")
    print(f"エラー総数: {total_errors}")
    print(f"保存先: {OUTPUT_DIR}")

    return 0 if total_errors == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\n処理を中断しました。")
        raise SystemExit(130)
