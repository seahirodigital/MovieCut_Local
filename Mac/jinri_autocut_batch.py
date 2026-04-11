from __future__ import annotations

import asyncio
import json
import shutil
import sys
import time
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent.parent
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

import server


SOURCE_ROOT = Path("/Users/user/Downloads/JINRI_mac/0.元データ/自動不要部カット")
OUTPUT_ROOT = Path("/Users/user/Downloads/JINRI_mac/1.カット後")
WORK_DIR_PREFIX = ".jinri_autocut_work_"

VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".mkv",
    ".avi",
    ".wmv",
    ".m4v",
    ".webm",
    ".flv",
    ".ts",
    ".mts",
}

DEFAULT_DETECT_SETTINGS = {
    "loud_threshold_db": -15.0,
    "duration_sec": 23.0,
    "min_gap": 1.0,
    "clip_duration": 35.0,
}

DEFAULT_EXPORT_SETTINGS = {
    "fps": 30,
    "video_bitrate": "copy",
    "audio_bitrate": 100,
}

EXPORT_MODE, NORMALIZED_VIDEO_BITRATE = server.parse_export_video_mode(
    DEFAULT_EXPORT_SETTINGS["video_bitrate"]
)


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
            for path in directory.rglob("*")
            if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
        ],
        key=lambda path: str(path.relative_to(directory)).lower(),
    )


def ensure_unique_path(base_path: Path) -> Path:
    candidate = base_path
    serial = 2

    while candidate.exists():
        candidate = base_path.with_name(f"{base_path.stem}_{serial}{base_path.suffix}")
        serial += 1

    return candidate


def build_work_dir(output_dir: Path, source_path: Path) -> Path:
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    base_name = f"{WORK_DIR_PREFIX}{source_path.stem}_{timestamp}"
    candidate = output_dir / base_name
    serial = 2

    while candidate.exists():
        candidate = output_dir / f"{base_name}_{serial}"
        serial += 1

    candidate.mkdir(parents=True, exist_ok=False)
    return candidate


def build_clip_output_path(work_dir: Path, source_path: Path, clip_index: int, clip: dict) -> Path:
    start_sec = int(clip["start"])
    end_sec = int(clip["end"])
    suffix = source_path.suffix if EXPORT_MODE == "copy" and source_path.suffix else ".mp4"
    base_path = work_dir / f"{clip_index:03d}_{start_sec:05d}-{end_sec:05d}{suffix}"
    return ensure_unique_path(base_path)


def build_final_output_path(source_path: Path, final_output_dir: Path) -> Path:
    suffix = source_path.suffix if source_path.suffix else ".mp4"
    return ensure_unique_path(final_output_dir / f"{source_path.stem}{suffix}")


async def detect_clips(file_path: Path) -> list[dict]:
    response = await server.detect_spikes(
        file_path=str(file_path),
        **DEFAULT_DETECT_SETTINGS,
    )
    data = response_to_dict(response)

    if getattr(response, "status_code", 200) >= 400 or data.get("success") is False:
        raise RuntimeError(data.get("error") or "自動検出に失敗しました")

    return data.get("clips", [])


async def export_clip(
    file_path: Path,
    clip: dict,
    clip_index: int,
    clip_total: int,
    work_dir: Path,
) -> dict:
    output_path = build_clip_output_path(work_dir, file_path, clip_index, clip)
    start = float(clip["start"])
    end = float(clip["end"])
    duration_sec = max(0.01, end - start)

    print(
        f"    [{clip_index}/{clip_total}] 書き出し中: "
        f"{server.format_time(start)} -> {server.format_time(end)}"
    )

    cmd = server.build_export_command(
        file_path=str(file_path),
        start=start,
        duration_sec=duration_sec,
        output_path=str(output_path),
        fps=DEFAULT_EXPORT_SETTINGS["fps"],
        video_bitrate=NORMALIZED_VIDEO_BITRATE,
        audio_bitrate=DEFAULT_EXPORT_SETTINGS["audio_bitrate"],
        export_mode=EXPORT_MODE,
    )

    returncode, _, stderr = await server.run_process_capture(cmd)

    if returncode != 0:
        error_text = stderr.decode("utf-8", errors="replace").strip()
        return {
            "success": False,
            "clip_index": clip_index,
            "error": error_text[:400],
        }

    file_size_mb = round(output_path.stat().st_size / (1024 * 1024), 2)
    return {
        "success": True,
        "clip_index": clip_index,
        "output_path": output_path,
        "file_size_mb": file_size_mb,
    }


async def merge_exported_clips(
    source_path: Path,
    exported_paths: list[Path],
    final_output_dir: Path,
) -> Path:
    final_output_path = build_final_output_path(source_path, final_output_dir)

    if len(exported_paths) == 1:
        moved_path = Path(shutil.move(str(exported_paths[0]), str(final_output_path)))
        return moved_path

    concat_list_path = Path(await server.write_concat_list_file([str(path) for path in exported_paths]))
    try:
        cmd = [
            server.FFMPEG,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list_path),
            "-c",
            "copy",
        ]

        if final_output_path.suffix.lower() in {".mp4", ".mov", ".m4v"}:
            cmd.extend(["-movflags", "+faststart"])

        cmd.append(str(final_output_path))

        returncode, _, stderr = await server.run_process_capture(cmd)
        if returncode != 0:
            error_text = stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"統合に失敗しました: {error_text[:400]}")

        return final_output_path
    finally:
        try:
            concat_list_path.unlink()
        except FileNotFoundError:
            pass


async def process_video(file_path: Path, video_index: int, video_total: int) -> dict:
    relative_path = file_path.relative_to(SOURCE_ROOT)
    final_output_dir = OUTPUT_ROOT / relative_path.parent
    final_output_dir.mkdir(parents=True, exist_ok=True)
    work_dir = build_work_dir(final_output_dir, file_path)

    print("=" * 72)
    print(f"[{video_index}/{video_total}] {relative_path}")

    try:
        clips = await detect_clips(file_path)
        print(f"  検出クリップ数: {len(clips)}")

        if not clips:
            print("  出力対象が見つからなかったため、この動画はスキップします。")
            return {
                "file_name": str(relative_path),
                "detected": 0,
                "exported": 0,
                "merged": False,
                "errors": 0,
            }

        exported_paths: list[Path] = []
        error_count = 0

        for clip_index, clip in enumerate(clips, start=1):
            result = await export_clip(file_path, clip, clip_index, len(clips), work_dir)
            if result["success"]:
                exported_paths.append(result["output_path"])
                print(
                    f"      完了: {result['output_path'].name} "
                    f"({result['file_size_mb']} MB)"
                )
            else:
                error_count += 1
                print(f"      エラー: {result['error']}")

        if not exported_paths:
            print("  書き出しに成功したクリップがないため、この動画はスキップします。")
            return {
                "file_name": str(relative_path),
                "detected": len(clips),
                "exported": 0,
                "merged": False,
                "errors": max(1, error_count),
            }

        if len(exported_paths) < len(clips):
            print(
                f"  警告: {len(clips)} 本のうち {len(exported_paths)} 本だけ成功したため、"
                "成功分のみ統合します。"
            )

        final_output_path = await merge_exported_clips(file_path, exported_paths, final_output_dir)
        print(f"  保存完了: {final_output_path}")

        return {
            "file_name": str(relative_path),
            "detected": len(clips),
            "exported": len(exported_paths),
            "merged": True,
            "errors": error_count,
            "output_path": str(final_output_path),
        }
    except Exception as error:
        print(f"  処理エラー: {error}")
        return {
            "file_name": str(relative_path),
            "detected": 0,
            "exported": 0,
            "merged": False,
            "errors": 1,
        }
    finally:
        server.analysis_state_by_file.pop(str(file_path), None)
        shutil.rmtree(work_dir, ignore_errors=True)


async def main() -> int:
    print("JINRI mac 一括自動不要部カット")
    print(f"入力元: {SOURCE_ROOT}")
    print(f"出力先: {OUTPUT_ROOT}")
    print("-" * 72)
    print(f"自動検出設定: {DEFAULT_DETECT_SETTINGS}")
    print(f"書き出し設定: {DEFAULT_EXPORT_SETTINGS}")
    print("-" * 72)

    if not SOURCE_ROOT.is_dir():
        print("入力フォルダが見つかりません。")
        return 1

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    video_files = get_video_files(SOURCE_ROOT)

    if not video_files:
        print("対象となる動画ファイルが見つかりませんでした。")
        return 0

    print(f"対象動画数: {len(video_files)}")
    summaries = []

    for video_index, file_path in enumerate(video_files, start=1):
        summaries.append(await process_video(file_path, video_index, len(video_files)))

    total_detected = sum(item["detected"] for item in summaries)
    total_exported = sum(item["exported"] for item in summaries)
    total_merged = sum(1 for item in summaries if item["merged"])
    total_errors = sum(item["errors"] for item in summaries)

    print("=" * 72)
    print("一括処理が完了しました。")
    print(f"動画数: {len(video_files)}")
    print(f"検出クリップ総数: {total_detected}")
    print(f"書き出し成功総数: {total_exported}")
    print(f"最終動画作成数: {total_merged}")
    print(f"エラー総数: {total_errors}")
    print(f"保存先: {OUTPUT_ROOT}")

    return 0 if total_errors == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\n処理を中断しました。")
        raise SystemExit(130)
