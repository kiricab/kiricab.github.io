# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

`kiricab.github.io` はブラウザ完結型のWebユーティリティツール集をホストする静的GitHub Pagesサイト（日本語向け）。すべての処理はクライアントサイドで完結し、バックエンド・ビルドシステム・パッケージマネージャーは存在しない。

## デプロイ

`main` ブランチへのプッシュがそのままGitHub Pagesへのデプロイとなる。ビルド手順は不要。ローカルでの動作確認は各ツールの `index.html` をブラウザで直接開けばよい。

## リポジトリ構成

各ツールは独自のサブディレクトリに `index.html`・`script.js`・`style.css` をまとめた構成：

- `passgen/` — 文字種・シード指定に対応したパスワード生成ツール
- `slackemojigen/` — Canvas APIとGoogle FontsによるSlack絵文字ジェネレーター
- `diff/` — サイドバイサイド表示のテキスト差分ツール
- `colorpallet/` — 配色ハーモニーモード・LocalStorage保存・PNG/JSONエクスポート対応のカラーパレット生成ツール
- `mdeditor/` — WYSIWYGマークダウンエディタ（現在開発中のブランチ：`mdeditor`）
- `common/style.css` — 全ツール共通のCSSカスタムプロパティとベーススタイル

## アーキテクチャパターン

**共通CSSカスタムプロパティ** — 全ツールが `../common/style.css` をインポートしてデザインシステム（`--primary-color: #1e3a8a` など）を参照し、ツール固有のスタイルは各 `style.css` に追記する。

**npmを使わない外部依存** — 外部ライブラリはすべてCDN経由で読み込む `package.json` は存在しない。

**アナリティクス・広告** — 本番ページにはGoogle Analytics（`G-CN3KBWSXRE`）とAdSense（`ca-pub-8141179596557780`）が含まれる。`mdeditor` ツールにはまだ設定されていない。

## 新しいツールを追加する際のチェックリスト

1. `index.html`・`script.js`・`style.css` を格納した新規ディレクトリを作成する
2. `../common/style.css` をツール固有のスタイルシートより先にリンクする
3. 既存の全 `index.html` のフッターナビにリンクを追加する
4. `sitemap.xml` を更新する
5. ルートの `index.html` にボタンを追加する
