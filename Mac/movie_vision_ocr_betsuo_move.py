#!/usr/bin/env python3
"""
JINRI OCR 検証用: 動画先頭 20% 以内に始まった「벗어」が連続 2 フレーム出た動画を採用へ移動する。

対象:
  /Users/user/Downloads/JINRI_mac/100.OCR検証

採用移動先:
  /Users/user/Downloads/JINRI_mac/100.OCR検証/採用
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any


SOURCE_DIR = Path("/Users/user/Downloads/JINRI_mac/100.OCR検証")
ACCEPT_DIR = Path("/Users/user/Downloads/JINRI_mac/100.OCR検証/採用")
LOG_DIR = Path("/Users/user/Downloads/JINRI_mac/100.OCR検証/JSON保存")
PROGRESS_FILENAME = "ocr_betsuo_progress.json"
TARGET_WORD = "벗어"
SCAN_RATIO = 0.20
SAMPLE_INTERVAL_SEC = 0.5
MIN_CONTINUOUS_SEC = 1.5
CONTINUATION_CONFIRM_SEC = MIN_CONTINUOUS_SEC
REQUIRED_CONSECUTIVE_HITS = 2
CROP_HEIGHT_RATIO = 0.25
VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".m4v",
    ".mkv",
    ".avi",
    ".webm",
    ".wmv",
    ".flv",
    ".ts",
    ".mts",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="動画先頭 20% 以内に始まった「벗어」が連続 2 フレーム出た動画を採用フォルダへ移動します。"
    )
    parser.add_argument("--source-dir", default=str(SOURCE_DIR), help="OCR 対象動画フォルダの完全フルパス")
    parser.add_argument("--accept-dir", default=str(ACCEPT_DIR), help="採用動画の移動先フォルダの完全フルパス")
    parser.add_argument("--log-dir", default=str(LOG_DIR), help="JSON ログ保存先フォルダの完全フルパス")
    parser.add_argument("--target-word", default=TARGET_WORD, help="検出対象ワード")
    parser.add_argument("--sample-interval-sec", type=float, default=SAMPLE_INTERVAL_SEC, help="OCR フレーム抽出間隔秒")
    parser.add_argument("--dry-run", action="store_true", help="動画を移動せず、判定ログだけ出します")
    return parser


def find_tool(tool_name: str) -> str:
    tool_path = shutil.which(tool_name)
    if tool_path:
        return tool_path

    for candidate in (
        Path("/opt/homebrew/bin") / tool_name,
        Path("/usr/local/bin") / tool_name,
        Path("/usr/bin") / tool_name,
    ):
        if candidate.exists() and candidate.is_file():
            return str(candidate)

    raise RuntimeError(f"{tool_name} が見つかりません。/opt/homebrew/bin/{tool_name} または PATH を確認してください。")


def load_vision_modules():
    try:
        import Foundation  # type: ignore
        import Quartz  # type: ignore
        import Vision  # type: ignore
    except ModuleNotFoundError as e:
        raise RuntimeError(
            "Apple Vision OCR 用の PyObjC が見つかりません。"
            " /Users/user/Library/CloudStorage/OneDrive-個人用/開発/Movie_AutoCut/MovieCut_Local/Mac/movie_vision_ocr_betsuo_move.command"
            " を実行すると、/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Movie_AutoCut/MovieCut_Local/requirements.txt"
            " から依存関係を入れ直します。"
        ) from e
    return Foundation, Quartz, Vision


def normalize_for_match(text: str) -> str:
    return "".join(str(text or "").split())


def contains_target_word(text: str, target_word: str) -> bool:
    normalized_text = normalize_for_match(text)
    normalized_target = normalize_for_match(target_word)
    return bool(normalized_target) and normalized_target in normalized_text


class AppleVisionTextRecognizer:
    def __init__(self) -> None:
        self.foundation, self.quartz, self.vision = load_vision_modules()

    def _build_request(self, use_korean_language_hint: bool):
        request = self.vision.VNRecognizeTextRequest.alloc().init()

        if hasattr(self.vision, "VNRequestTextRecognitionLevelAccurate"):
            request.setRecognitionLevel_(self.vision.VNRequestTextRecognitionLevelAccurate)
        if hasattr(request, "setUsesLanguageCorrection_"):
            request.setUsesLanguageCorrection_(False)
        if use_korean_language_hint and hasattr(request, "setRecognitionLanguages_"):
            request.setRecognitionLanguages_(["ko-KR", "ko", "en-US"])

        return request

    def _perform_request(self, cg_image: Any, request: Any) -> None:
        handler = self.vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, {})
        result = handler.performRequests_error_([request], None)

        if isinstance(result, tuple):
            success = bool(result[0])
            error = result[1] if len(result) > 1 else None
        else:
            success = bool(result)
            error = None

        if not success:
            raise RuntimeError(f"Apple Vision OCR の実行に失敗しました: {error}")

    def recognize(self, image_path: Path) -> list[dict[str, Any]]:
        image_url = self.foundation.NSURL.fileURLWithPath_(str(image_path))
        image_source = self.quartz.CGImageSourceCreateWithURL(image_url, None)
        if image_source is None:
            raise RuntimeError(f"OCR 用画像を読み込めませんでした: {image_path}")

        cg_image = self.quartz.CGImageSourceCreateImageAtIndex(image_source, 0, None)
        if cg_image is None:
            raise RuntimeError(f"OCR 用画像を CGImage に変換できませんでした: {image_path}")

        last_error: Exception | None = None
        for use_korean_language_hint in (True, False):
            request = self._build_request(use_korean_language_hint)
            try:
                self._perform_request(cg_image, request)
                return self._collect_texts(request)
            except Exception as e:
                last_error = e

        raise RuntimeError(f"Apple Vision OCR が失敗しました: {last_error}")

    def _collect_texts(self, request: Any) -> list[dict[str, Any]]:
        texts: list[dict[str, Any]] = []
        for observation in request.results() or []:
            try:
                candidates = observation.topCandidates_(3)
            except Exception:
                continue

            for candidate in candidates or []:
                try:
                    raw_text = str(candidate.string())
                except Exception:
                    raw_text = ""

                try:
                    confidence = float(candidate.confidence())
                except Exception:
                    confidence = None

                if raw_text:
                    texts.append({
                        "text": raw_text,
                        "confidence": confidence,
                    })

        return texts


def get_video_duration_sec(ffprobe_path: str, video_path: Path) -> float:
    result = subprocess.run(
        [
            ffprobe_path,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise RuntimeError(f"ffprobe に失敗しました: {result.stderr.strip()}")

    data = json.loads(result.stdout or "{}")
    duration_text = data.get("format", {}).get("duration")
    duration = float(duration_text or 0)
    if duration <= 0:
        raise RuntimeError(f"動画の長さを取得できませんでした: {video_path}")
    return duration


def build_sample_times(
    duration_sec: float,
    scan_ratio: float,
    continuation_confirm_sec: float,
    sample_interval_sec: float,
) -> tuple[list[float], float, float]:
    scan_ratio = min(max(scan_ratio, 0.01), 1.0)
    continuation_confirm_sec = max(0.0, continuation_confirm_sec)
    sample_interval_sec = max(sample_interval_sec, 0.1)
    scan_end_sec = max(0.0, duration_sec * scan_ratio)
    last_extractable_sec = max(0.0, duration_sec - 0.05)
    sample_end_sec = min(scan_end_sec + continuation_confirm_sec, last_extractable_sec)

    times: list[float] = []
    current = 0.0
    while current <= sample_end_sec + 1e-6:
        times.append(round(current, 3))
        current += sample_interval_sec

    if times and sample_end_sec - times[-1] > sample_interval_sec * 0.25:
        times.append(round(sample_end_sec, 3))

    return times, scan_end_sec, sample_end_sec


def extract_frame(ffmpeg_path: str, video_path: Path, time_sec: float, output_path: Path) -> None:
    result = subprocess.run(
        [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{time_sec:.3f}",
            "-i",
            str(video_path),
            "-vf",
            f"crop=iw:ih*{CROP_HEIGHT_RATIO}:0:0",
            "-frames:v",
            "1",
            "-y",
            str(output_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0 or not output_path.exists():
        raise RuntimeError(f"フレーム抽出に失敗しました: {result.stderr.strip()}")


def calculate_detected_segments(
    frame_results: list[dict[str, Any]],
    sample_interval_sec: float,
) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    current_frames: list[dict[str, Any]] = []

    def flush_current() -> None:
        if not current_frames:
            return
        start_sec = float(current_frames[0]["time_sec"])
        end_sec = float(current_frames[-1]["time_sec"])
        duration_sec = len(current_frames) * sample_interval_sec
        segments.append({
            "start_sec": round(start_sec, 3),
            "end_sec": round(end_sec, 3),
            "duration_sec": round(duration_sec, 3),
            "frame_count": len(current_frames),
            "matched_texts": sorted({
                text
                for frame in current_frames
                for text in frame.get("matched_texts", [])
            }),
        })

    for frame in frame_results:
        if frame.get("detected"):
            current_frames.append(frame)
        else:
            flush_current()
            current_frames = []

    flush_current()
    return segments


def unique_destination_path(destination_dir: Path, source_path: Path) -> Path:
    candidate = destination_dir / source_path.name
    if not candidate.exists():
        return candidate

    timestamp = time.strftime("%Y%m%d_%H%M%S")
    for index in range(1, 1000):
        renamed = destination_dir / f"{source_path.stem}_{timestamp}_{index:03d}{source_path.suffix}"
        if not renamed.exists():
            return renamed

    raise RuntimeError(f"同名ファイルの退避名を作れませんでした: {candidate}")


def is_inside_directory(path: Path, directory: Path) -> bool:
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def discover_videos(source_dir: Path, accept_dir: Path) -> list[Path]:
    videos: list[Path] = []
    for path in sorted(source_dir.iterdir()):
        if not path.is_file():
            continue
        if is_inside_directory(path, accept_dir):
            continue
        if path.suffix.lower() in VIDEO_EXTENSIONS:
            videos.append(path)
    return videos


def analyze_video(
    video_path: Path,
    recognizer: AppleVisionTextRecognizer,
    ffmpeg_path: str,
    ffprobe_path: str,
    target_word: str,
    sample_interval_sec: float,
) -> dict[str, Any]:
    duration_sec = get_video_duration_sec(ffprobe_path, video_path)
    sample_times, scan_end_sec, sample_end_sec = build_sample_times(
        duration_sec,
        SCAN_RATIO,
        CONTINUATION_CONFIRM_SEC,
        sample_interval_sec,
    )
    frame_results: list[dict[str, Any]] = []
    accepted_segments: list[dict[str, Any]] = []
    consecutive_hits = 0
    early_stopped = False
    early_stop_reason = ""

    with tempfile.TemporaryDirectory(prefix="movie_vision_ocr_") as temp_dir_text:
        temp_dir = Path(temp_dir_text)
        for frame_index, sample_time in enumerate(sample_times):
            image_path = temp_dir / f"frame_{frame_index:05d}_{sample_time:.3f}.png"
            extract_frame(ffmpeg_path, video_path, sample_time, image_path)
            texts = recognizer.recognize(image_path)
            matched_texts = [
                item["text"]
                for item in texts
                if contains_target_word(str(item.get("text", "")), target_word)
            ]

            frame_result = {
                "time_sec": sample_time,
                "detected": bool(matched_texts),
                "matched_texts": matched_texts,
                "texts": texts,
            }
            frame_results.append(frame_result)

            if frame_result["detected"]:
                consecutive_hits += 1
            else:
                consecutive_hits = 0

            if consecutive_hits >= REQUIRED_CONSECUTIVE_HITS:
                accepted_segments.append({
                    "start_sec": round(sample_time - sample_interval_sec * (REQUIRED_CONSECUTIVE_HITS - 1), 3),
                    "end_sec": round(sample_time, 3),
                    "duration_sec": round(sample_interval_sec * REQUIRED_CONSECUTIVE_HITS, 3),
                    "frame_count": REQUIRED_CONSECUTIVE_HITS,
                    "matched_texts": sorted({
                        text
                        for recent_frame in frame_results[-REQUIRED_CONSECUTIVE_HITS:]
                        for text in recent_frame.get("matched_texts", [])
                    }),
                })
                early_stopped = True
                early_stop_reason = "벗어 が連続 2 フレーム検出されたため、この動画の残り解析を打ち切り"
                break

    segments = calculate_detected_segments(frame_results, sample_interval_sec)

    return {
        "video_path": str(video_path),
        "duration_sec": round(duration_sec, 3),
        "scan_ratio": SCAN_RATIO,
        "scan_end_sec": round(scan_end_sec, 3),
        "sample_end_sec": round(sample_end_sec, 3),
        "continuation_confirm_sec": CONTINUATION_CONFIRM_SEC,
        "crop_height_ratio": CROP_HEIGHT_RATIO,
        "sample_interval_sec": sample_interval_sec,
        "sample_count": len(sample_times),
        "processed_frame_count": len(frame_results),
        "target_word": target_word,
        "required_consecutive_hits": REQUIRED_CONSECUTIVE_HITS,
        "accept_rule": "detected segment starts within first 20 percent and 벗어 appears in 2 consecutive frames",
        "accepted": bool(accepted_segments),
        "early_stopped": early_stopped,
        "early_stop_reason": early_stop_reason,
        "detected_segments": segments,
        "accepted_segments": accepted_segments,
        "frames": frame_results,
    }


def move_if_accepted(
    analysis: dict[str, Any],
    accept_dir: Path,
    dry_run: bool,
) -> dict[str, Any]:
    if not analysis.get("accepted"):
        analysis["action"] = "kept"
        return analysis

    source_path = Path(str(analysis["video_path"]))
    destination_path = unique_destination_path(accept_dir, source_path)
    analysis["destination_path"] = str(destination_path)

    if dry_run:
        analysis["action"] = "dry_run_move_candidate"
        return analysis

    moved_path = shutil.move(str(source_path), str(destination_path))
    analysis["action"] = "moved_to_accept"
    analysis["moved_path"] = str(Path(moved_path).resolve())
    return analysis


def write_log(log_dir: Path, report: dict[str, Any]) -> Path:
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"ocr_betsuo_result_{timestamp}.json"
    log_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return log_path


def get_progress_path(log_dir: Path) -> Path:
    return log_dir / PROGRESS_FILENAME


def load_progress(progress_path: Path) -> dict[str, Any]:
    if not progress_path.exists():
        return {
            "version": 1,
            "updated_at": "",
            "source_dir": "",
            "items": {},
        }

    try:
        return json.loads(progress_path.read_text(encoding="utf-8"))
    except Exception:
        return {
            "version": 1,
            "updated_at": "",
            "source_dir": "",
            "items": {},
        }


def save_progress(progress_path: Path, progress_data: dict[str, Any]) -> None:
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = progress_path.with_suffix(progress_path.suffix + ".tmp")
    temp_path.write_text(json.dumps(progress_data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp_path, progress_path)


def should_skip_video(progress_data: dict[str, Any], video_path: Path) -> tuple[bool, dict[str, Any] | None]:
    item = progress_data.get("items", {}).get(str(video_path))
    if not item:
        return False, None

    status = str(item.get("status", ""))
    if status in {"done", "moved"}:
        return True, item
    return False, item


def update_progress_item(
    progress_data: dict[str, Any],
    video_path: Path,
    *,
    status: str,
    accepted: bool | None = None,
    action: str = "",
    result_log_path: str = "",
    message: str = "",
) -> None:
    progress_data["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    items = progress_data.setdefault("items", {})
    current = dict(items.get(str(video_path), {}))
    current.update({
        "video_path": str(video_path),
        "status": status,
        "accepted": accepted,
        "action": action,
        "result_log_path": result_log_path,
        "message": message,
        "updated_at": progress_data["updated_at"],
    })
    items[str(video_path)] = current


def run(args: argparse.Namespace) -> int:
    source_dir = Path(str(args.source_dir)).expanduser()
    accept_dir = Path(str(args.accept_dir)).expanduser()
    log_dir = Path(str(args.log_dir)).expanduser()
    target_word = str(args.target_word)

    if not source_dir.is_dir():
        raise RuntimeError(f"OCR 対象フォルダが見つかりません: {source_dir}")

    accept_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    progress_path = get_progress_path(log_dir)
    progress_data = load_progress(progress_path)
    progress_data["source_dir"] = str(source_dir)

    ffmpeg_path = find_tool("ffmpeg")
    ffprobe_path = find_tool("ffprobe")
    recognizer = AppleVisionTextRecognizer()
    videos = discover_videos(source_dir, accept_dir)

    report: dict[str, Any] = {
        "source_dir": str(source_dir),
        "accept_dir": str(accept_dir),
        "log_dir": str(log_dir),
        "target_word": target_word,
        "scan_ratio": SCAN_RATIO,
        "continuation_confirm_sec": CONTINUATION_CONFIRM_SEC,
        "crop_height_ratio": CROP_HEIGHT_RATIO,
        "sample_interval_sec": float(args.sample_interval_sec),
        "required_consecutive_hits": REQUIRED_CONSECUTIVE_HITS,
        "accept_rule": "detected segment starts within first 20 percent and 벗어 appears in 2 consecutive frames",
        "dry_run": bool(args.dry_run),
        "progress_path": str(progress_path),
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "video_count": len(videos),
        "moved_count": 0,
        "accepted_count": 0,
        "failed_count": 0,
        "skipped_count": 0,
        "results": [],
    }

    print(f"OCR 対象フォルダ: {source_dir}")
    print(f"採用移動先: {accept_dir}")
    print(f"JSON ログ保存先: {log_dir}")
    print(f"進捗JSON: {progress_path}")
    print(f"対象ワード: {target_word}")
    print(f"OCR 対象帯: 画面上部 {CROP_HEIGHT_RATIO * 100:.1f}%")
    print(f"判定開始範囲: 動画先頭 {SCAN_RATIO * 100:.1f}% 以内")
    print(f"継続確認範囲: 20% 地点から追加 {CONTINUATION_CONFIRM_SEC:.1f} 秒")
    print(f"採用判定: {REQUIRED_CONSECUTIVE_HITS} フレーム連続検出")
    print(f"対象動画数: {len(videos)}")
    print()

    for index, video_path in enumerate(videos, start=1):
        print(f"[{index}/{len(videos)}] 解析中: {video_path}")
        skip_video, progress_item = should_skip_video(progress_data, video_path)
        if skip_video:
            report["skipped_count"] += 1
            skipped_result = {
                "video_path": str(video_path),
                "accepted": bool(progress_item.get("accepted")),
                "action": "skipped_by_progress",
                "progress_status": progress_item.get("status"),
                "progress_updated_at": progress_item.get("updated_at"),
                "progress_result_log_path": progress_item.get("result_log_path", ""),
            }
            report["results"].append(skipped_result)
            print("  スキップ: 進捗JSON上で完了済み")
            continue

        update_progress_item(
            progress_data,
            video_path,
            status="processing",
            action="processing",
            message="OCR 解析を開始",
        )
        save_progress(progress_path, progress_data)

        try:
            analysis = analyze_video(
                video_path=video_path,
                recognizer=recognizer,
                ffmpeg_path=ffmpeg_path,
                ffprobe_path=ffprobe_path,
                target_word=target_word,
                sample_interval_sec=float(args.sample_interval_sec),
            )
            analysis = move_if_accepted(analysis, accept_dir, bool(args.dry_run))
            if analysis.get("accepted"):
                report["accepted_count"] += 1
            if analysis.get("action") == "moved_to_accept":
                report["moved_count"] += 1
                update_progress_item(
                    progress_data,
                    video_path,
                    status="moved",
                    accepted=True,
                    action=str(analysis.get("action", "")),
                    message="採用動画として移動完了",
                )
                print(f"  採用: {analysis.get('moved_path')}")
            elif analysis.get("action") == "dry_run_move_candidate":
                update_progress_item(
                    progress_data,
                    video_path,
                    status="done",
                    accepted=True,
                    action=str(analysis.get("action", "")),
                    message="dry-run で採用候補を確認済み",
                )
                print(f"  採用候補: {analysis.get('destination_path')}")
            else:
                update_progress_item(
                    progress_data,
                    video_path,
                    status="done",
                    accepted=bool(analysis.get("accepted")),
                    action=str(analysis.get("action", "")),
                    message="条件未達のため不採用として確認済み",
                )
                print("  不採用: 条件を満たす継続検出なし")
        except Exception as e:
            report["failed_count"] += 1
            analysis = {
                "video_path": str(video_path),
                "accepted": False,
                "action": "failed",
                "error": str(e),
                "traceback": traceback.format_exc(),
            }
            update_progress_item(
                progress_data,
                video_path,
                status="failed",
                accepted=False,
                action="failed",
                message=str(e),
            )
            print(f"  失敗: {e}")

        report["results"].append(analysis)
        save_progress(progress_path, progress_data)

    report["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    log_path = write_log(log_dir, report)
    for result in report["results"]:
        action = str(result.get("action", ""))
        if action in {"skipped_by_progress"}:
            continue
        video_path_text = str(result.get("video_path", "")).strip()
        if not video_path_text:
            continue
        update_progress_item(
            progress_data,
            Path(video_path_text),
            status=str(progress_data.get("items", {}).get(video_path_text, {}).get("status", "done") or "done"),
            accepted=result.get("accepted"),
            action=action,
            result_log_path=str(log_path),
            message=str(progress_data.get("items", {}).get(video_path_text, {}).get("message", "")),
        )
    save_progress(progress_path, progress_data)
    print()
    print(f"ログ保存先: {log_path}")
    print(f"採用判定: {report['accepted_count']} / {report['video_count']}")
    print(f"移動済み: {report['moved_count']} / {report['video_count']}")
    print(f"スキップ: {report['skipped_count']} / {report['video_count']}")
    print(f"失敗: {report['failed_count']} / {report['video_count']}")
    return 0 if report["failed_count"] == 0 else 1


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        return run(args)
    except KeyboardInterrupt:
        print("\n中断しました。")
        return 130
    except Exception as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
