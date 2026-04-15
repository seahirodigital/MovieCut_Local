# OCR 検証結果と固定仕様

## 目的

`/Users/user/Downloads/JINRI_mac/100.OCR検証` に保存されている動画を対象に、動画フレーム内の韓国語テキスト `벗어` を Apple Vision OCR で検出し、採用動画を `/Users/user/Downloads/JINRI_mac/100.OCR検証/採用` へ移動できるかを検証した。

## 検証結果

検証対象は次の 3 本。

- `/Users/user/Downloads/JINRI_mac/100.OCR検証/pandaclass_20260226_1625_0810-0844.mp4`
- `/Users/user/Downloads/JINRI_mac/100.OCR検証/pandaclass_20260226_1625_2328-2402.mp4`
- `/Users/user/Downloads/JINRI_mac/100.OCR検証/pandaclass_20260226_1625_3053-3127.mp4`

比較結果。

| 条件 | 採用判定 | 結果 |
| --- | ---: | --- |
| 動画先頭20%のみ + `벗어` 1.5秒以上 | 1 / 3 | 正解 2 / 3 に届かない |
| 動画先頭20%のみ + `벗어` 0.5秒以上 | 2 / 3 | 正解数には合うが、1フレーム検出でも通るため誤検出に弱い |
| 動画全体 + `벗어` 1.5秒以上 | 2 / 3 | 正解数には合うが、全体 OCR は処理時間が長い |

## 判定漏れの原因

`/Users/user/Downloads/JINRI_mac/100.OCR検証/pandaclass_20260226_1625_3053-3127.mp4` は、`벗어` の継続表示が動画先頭20%の境界付近から始まる。

この動画の 20% 地点は約 7.064 秒。従来の「先頭20%までしか OCR しない」条件では、`7.0秒` の単発検出だけで打ち切られるため、1.5秒継続として判定できなかった。

つまり、問題は「先頭20%を見る」という方針そのものではなく、20%地点で OCR を打ち切るため、境界付近から始まる文字の継続確認ができないこと。

## 固定する判定仕様

採用する固定仕様は次の通り。

1. 判定開始位置は動画先頭20%以内に限定する。
2. ただし、継続確認のために 20% 地点から追加で 1.5 秒だけ OCR する。
3. `벗어` の検出セグメント開始時刻が動画先頭20%以内であること。
4. その検出セグメントが 1.5 秒以上続くこと。
5. 条件を満たした動画だけ `/Users/user/Downloads/JINRI_mac/100.OCR検証/採用` へ移動する。
6. JSON ログは `/Users/user/Downloads/JINRI_mac/100.OCR検証/JSON保存` へ保存する。

## この仕様にする理由

動画全体を OCR すれば正解数は合うが、処理時間が長くなる。今回の目的は、動画の冒頭付近で出る `벗어` を採用判定に使うことなので、動画全体を読む必要は薄い。

一方で、先頭20%で完全に打ち切ると、20%境界付近から始まった `벗어` の継続時間を確認できない。そこで「判定開始は20%以内」に限定しつつ、「継続確認だけ追加1.5秒ぶん見る」方式にする。

この方式なら、処理範囲を最小限に保ちながら、`벗어` が境界付近で始まる動画も正しく拾える。

## 実装ファイル

- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Movie_AutoCut/MovieCut_Local/Mac/movie_vision_ocr_betsuo_move.py`
- `/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Movie_AutoCut/MovieCut_Local/Mac/movie_vision_ocr_betsuo_move.command`

## 実行方法

通常実行。

```bash
/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Movie_AutoCut/MovieCut_Local/Mac/movie_vision_ocr_betsuo_move.command
```

動画を移動せずに判定だけ確認する場合。

```bash
/Users/user/Library/CloudStorage/OneDrive-個人用/開発/Movie_AutoCut/MovieCut_Local/Mac/movie_vision_ocr_betsuo_move.command --dry-run
```
