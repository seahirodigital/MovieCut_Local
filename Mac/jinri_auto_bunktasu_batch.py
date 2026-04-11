from __future__ import annotations

import asyncio
import sys
from pathlib import Path


MAC_DIR = Path(__file__).resolve().parent
PROJECT_DIR = MAC_DIR.parent
if str(MAC_DIR) not in sys.path:
    sys.path.insert(0, str(MAC_DIR))
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

import jinri_autocut_batch as autocut
import server


SOURCE_ROOT = Path("/Users/user/Downloads/JINRI_mac/0.元データ/自動分割")
OUTPUT_ROOT = Path("/Users/user/Downloads/JINRI_mac/1.カット後/分割カット後")


def build_split_output_dir(source_path: Path) -> Path:
    relative_path = source_path.relative_to(SOURCE_ROOT)
    output_dir = OUTPUT_ROOT / relative_path.parent / build_output_file_stem(source_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def build_output_file_stem(source_path: Path) -> str:
    stem = source_path.stem
    if "_@" in stem:
        return stem.split("_@", 1)[0]
    return stem


def format_duration_label(seconds: float) -> str:
    total_seconds = int(seconds)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, second = divmod(remainder, 60)
    total_minutes = hours * 60 + minutes
    return f"{total_minutes:02d}{second:02d}"


def build_split_output_path(output_dir: Path, source_path: Path, clip: dict) -> Path:
    start_label = format_duration_label(float(clip["start"]))
    end_label = format_duration_label(float(clip["end"]))
    suffix = source_path.suffix if autocut.EXPORT_MODE == "copy" and source_path.suffix else ".mp4"
    base_name = f"{build_output_file_stem(source_path)}_{start_label}-{end_label}{suffix}"
    return autocut.ensure_unique_path(output_dir / base_name)


def delete_source_video(source_path: Path) -> bool:
    resolved_source = source_path.resolve()
    resolved_root = SOURCE_ROOT.resolve()

    if resolved_root not in resolved_source.parents:
        raise RuntimeError(f"削除対象が入力元フォルダ配下ではありません: {resolved_source}")
    if not resolved_source.is_file():
        raise RuntimeError(f"削除対象ファイルが見つかりません: {resolved_source}")

    resolved_source.unlink()
    return True


async def export_split_clip(
    file_path: Path,
    clip: dict,
    clip_index: int,
    clip_total: int,
    output_dir: Path,
) -> dict:
    output_path = build_split_output_path(output_dir, file_path, clip)
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
        fps=autocut.DEFAULT_EXPORT_SETTINGS["fps"],
        video_bitrate=autocut.NORMALIZED_VIDEO_BITRATE,
        audio_bitrate=autocut.DEFAULT_EXPORT_SETTINGS["audio_bitrate"],
        export_mode=autocut.EXPORT_MODE,
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


async def process_video(file_path: Path, video_index: int, video_total: int) -> dict:
    relative_path = file_path.relative_to(SOURCE_ROOT)
    output_dir = build_split_output_dir(file_path)

    print("=" * 72)
    print(f"[{video_index}/{video_total}] {relative_path}")
    print(f"  分割保存先: {output_dir}")

    try:
        clips = await autocut.detect_clips(file_path)
        print(f"  検出クリップ数: {len(clips)}")

        if not clips:
            print("  出力対象が見つからなかったため、この動画はスキップします。")
            return {
                "file_name": str(relative_path),
                "detected": 0,
                "exported": 0,
                "errors": 0,
                "source_deleted": False,
            }

        exported_paths: list[Path] = []
        error_count = 0

        for clip_index, clip in enumerate(clips, start=1):
            result = await export_split_clip(file_path, clip, clip_index, len(clips), output_dir)
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
            print("  書き出しに成功したクリップがないため、元動画は削除しません。")
            return {
                "file_name": str(relative_path),
                "detected": len(clips),
                "exported": 0,
                "errors": max(1, error_count),
                "source_deleted": False,
            }

        if len(exported_paths) < len(clips):
            print(
                f"  警告: {len(clips)} 本のうち {len(exported_paths)} 本だけ成功したため、"
                "元動画は削除しません。"
            )
            return {
                "file_name": str(relative_path),
                "detected": len(clips),
                "exported": len(exported_paths),
                "errors": max(1, error_count),
                "source_deleted": False,
            }

        deleted_source = delete_source_video(file_path)
        if deleted_source:
            print(f"  元動画を削除しました: {file_path}")

        return {
            "file_name": str(relative_path),
            "detected": len(clips),
            "exported": len(exported_paths),
            "errors": error_count,
            "source_deleted": deleted_source,
        }
    except Exception as error:
        print(f"  処理エラー: {error}")
        return {
            "file_name": str(relative_path),
            "detected": 0,
            "exported": 0,
            "errors": 1,
            "source_deleted": False,
        }
    finally:
        server.analysis_state_by_file.pop(str(file_path), None)


async def main() -> int:
    print("JINRI mac 一括自動分割カット")
    print(f"入力元: {SOURCE_ROOT}")
    print(f"出力先: {OUTPUT_ROOT}")
    print("-" * 72)
    print(f"自動検出設定: {autocut.DEFAULT_DETECT_SETTINGS}")
    print(f"書き出し設定: {autocut.DEFAULT_EXPORT_SETTINGS}")
    print("-" * 72)

    if not SOURCE_ROOT.is_dir():
        print("入力フォルダが見つかりません。")
        return 1

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    video_files = autocut.get_video_files(SOURCE_ROOT)

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
    total_deleted = sum(1 for item in summaries if item.get("source_deleted"))

    print("=" * 72)
    print("一括分割処理が完了しました。")
    print(f"動画数: {len(video_files)}")
    print(f"検出クリップ総数: {total_detected}")
    print(f"分割保存成功総数: {total_exported}")
    print(f"元動画削除数: {total_deleted}")
    print(f"エラー総数: {total_errors}")
    print(f"保存先: {OUTPUT_ROOT}")

    return 0 if total_errors == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\n処理を中断しました。")
        raise SystemExit(130)
