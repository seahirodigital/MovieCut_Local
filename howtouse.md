
## サーバーの起動方法
１：手動設定

・start.batをダブルクリックで、自動でサーバーとブラウザ起動

２：自動抽出
a.事前準備：以下に動画を保存
"C:\Users\HCY\Downloads\Jinricp\自動抽出"

b.以下に切り取られた動画が保存
"C:\Users\HCY\Downloads\Jinricp\自動抽出後"

c.自動抽出_一括出力.bat をダブルクリック


削除ボタンを押すと、以下の削除フォルダに移動。
"C:\Users\HCY\Downloads\Jinricp\削除"

# Movie AutoCut 使い方

以下が最新の手順です。下に古いメモが残っていても、このセクションだけ見れば使えます。

## 起動

Windows:
- `C:\Users\HCY\OneDrive\開発\Movie_AutoCut\MovieCut_Local\start.bat` をダブルクリックします。

Mac:
- `/Users/user/OneDrive/開発/Movie_AutoCut/MovieCut_Local/start.command` を実行します。
- Finder から開けない場合は、ターミナルで `chmod +x /Users/user/OneDrive/開発/Movie_AutoCut/MovieCut_Local/start.command` を 1 回だけ実行してから開いてください。

## 一括出力

Windows:
- `C:\Users\HCY\OneDrive\開発\Movie_AutoCut\MovieCut_Local\自動抽出_一括出力.bat` をダブルクリックします。

Mac:
- `/Users/user/OneDrive/開発/Movie_AutoCut/MovieCut_Local/auto_export_batch.command` を実行します。
- Finder から開けない場合は、ターミナルで `chmod +x /Users/user/OneDrive/開発/Movie_AutoCut/MovieCut_Local/auto_export_batch.command` を 1 回だけ実行してください。

## 既定フォルダ

Windows 既定:
- `C:\Users\HCY\Downloads\Jinricp\自動抽出`
- `C:\Users\HCY\Downloads\Jinricp\自動抽出後`
- `C:\Users\HCY\Downloads\Jinricp\削除`

Mac 既定:
- `/Users/user/Downloads/Jinricp/自動抽出`
- `/Users/user/Downloads/Jinricp/自動抽出後`
- `/Users/user/Downloads/Jinricp/削除`

## フォルダを変えたい場合

次の環境変数で上書きできます。

- `MOVIE_AUTOCUT_MEDIA_ROOT`
- `MOVIE_AUTOCUT_AUTO_EXPORT_SOURCE_DIR`
- `MOVIE_AUTOCUT_AUTO_EXPORT_OUTPUT_DIR`
- `MOVIE_AUTOCUT_REVIEW_REJECT_DIR`

`MOVIE_AUTOCUT_MEDIA_ROOT` を設定すると、未指定の各フォルダはその配下を使います。
