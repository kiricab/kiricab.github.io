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

**ライセンスポリシー** — 使用するすべての外部ライブラリ・フォント・アセットは **無償かつ商用利用可能なライセンス**（MIT・Apache 2.0・BSD・ISC・CC0・OFL等）でなければならない。GPL・LGPL・有償ライセンス・商用利用に条件が付くライセンスは使用禁止。ライブラリを追加する際は必ずライセンスを確認すること。

**ファビコン** — すべてのページ（ルート・各ツール問わず）は共通ファビコンを参照すること。インラインSVGや独自ファビコンは使用禁止。各ツールは `<link rel="icon" href="../common/favicon.svg">`、ルートは `<link rel="icon" href="common/favicon.svg">` を使用する。

**アナリティクス・広告** — 本番ページにはGoogle Analytics（`G-CN3KBWSXRE`）とAdSense（`ca-pub-8141179596557780`）が含まれる。`mdeditor` ツールにはまだ設定されていない。

## 実装ワークフロー

新しいツールの実装は以下の手順で進める：

1. **planner** がユーザーとコミュニケーションしながら仕様を固め、仕様書を作成する
2. **developer** が仕様書をもとに実装する
3. **evaluator** が実装内容を確認し、仕様を満たしているかを検証する。UIの動作確認はPlaywright MCPを使ってブラウザで実際に操作・スクリーンショット取得を行うこと
4. evaluatorの確認で修正箇所があれば 2. に戻り、**developer** が実装を修正する

以降 2〜3 を繰り返し、すべての仕様を満たしたら実装完了とする。

## 新しいツールを追加する際のチェックリスト

1. `index.html`・`script.js`・`style.css` を格納した新規ディレクトリを作成する
2. `../common/style.css` をツール固有のスタイルシートより先にリンクする
3. ファビコンは `<link rel="icon" href="../common/favicon.svg">` で共通ファイルを参照する
4. 既存の全 `index.html` のフッターナビにリンクを追加する
5. `sitemap.xml` を更新する
6. ルートの `index.html` にボタンを追加する
