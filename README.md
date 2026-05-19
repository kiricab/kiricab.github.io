# kiricab.github.io

ブラウザ完結型の日本語向け Web ユーティリティツール集。すべての処理はクライアントサイドで完結し、ログイン不要・サーバー送信なし。GitHub Pages でホストしている。

公開先: https://kiricab.github.io/

## 収録ツール

| ディレクトリ | 概要 |
|---|---|
| [`passgen/`](./passgen/) | 文字種・シード指定に対応したパスワード生成ツール |
| [`slackemojigen/`](./slackemojigen/) | Canvas API と Google Fonts による Slack 絵文字ジェネレーター |
| [`diff/`](./diff/) | サイドバイサイド表示のテキスト差分ツール |
| [`colorpallet/`](./colorpallet/) | 配色ハーモニーモード・LocalStorage 保存・PNG/JSON エクスポート対応のカラーパレット生成 |
| [`mdkanban/`](./mdkanban/) | Obsidian Kanban 互換 Markdown をカンバンボードとして表示・編集 |

## サイト情報

| ページ | 概要 |
|---|---|
| [`about/`](./about/) | このサイトについて（運営方針・収録ツール一覧） |
| [`privacy/`](./privacy/) | プライバシーポリシー |
| [`terms/`](./terms/) | 利用規約 |
| [`contact/`](./contact/) | お問い合わせ（GitHub Issues） |

## ローカルでの動作確認

ビルド手順・パッケージマネージャは不要。各ツールの `index.html` をブラウザで直接開けばよい。

**ただし `mdkanban` のみ ES Modules を採用しているため `file://` では動かない。** リポジトリのルートで HTTP サーバーを起動して開く:

```sh
python3 -m http.server 8000
# その後 http://127.0.0.1:8000/mdkanban/ を開く
```

他のツールは `file://` で開いても動作する。

## デプロイ

`main` ブランチへのプッシュがそのまま GitHub Pages へのデプロイとなる。
