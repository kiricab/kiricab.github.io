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
5. `sitemap.xml` を更新する（`lastmod` を当日日付、`changefreq` を `monthly` に設定）
6. ルートの `index.html` にボタンを追加する

### SEOメタデータのチェックリスト（全ページ必須）

1. `<title>` / `<meta name="description">` をツールの固有名詞と用途が伝わる内容にする
2. OGP：`og:type` / `og:url` / `og:title` / `og:description` / `og:site_name` / `og:locale` に加え、共通OG画像を参照する
   - `<meta property="og:image" content="https://kiricab.github.io/common/og-image.svg">`
   - `<meta property="og:image:width" content="1200">` / `<meta property="og:image:height" content="630">`
3. Twitter Card：`twitter:card` は `summary_large_image` を使用し、`twitter:image` にも共通OG画像を指定する
4. `<link rel="canonical">` をそのツールの正規URLに設定する
5. 外部リソース向けに `<link rel="preconnect">` を宣言する（`https://www.googletagmanager.com`、`https://pagead2.googlesyndication.com`、CDN利用時は該当ドメインも）
6. 構造化データ（JSON-LD）を以下のブロックで揃える:
   - `WebApplication`（`applicationCategory` は用途に合うもの：`UtilitiesApplication` / `DesignApplication` / `SecurityApplication` / `MultimediaApplication` 等、`operatingSystem` は `Any`、`image` にも共通OG画像URL）
   - `BreadcrumbList`（ホーム→当該ツールの2段）
   - `FAQPage`（ページ内FAQセクションと対応）
   - `HowTo`（使い方セクションがある場合）
7. 本文中に `seo-content` セクションを設け、最低限「使い方（または解説）」と「よくある質問」を配置する
8. 関連ツールへの内部リンク（本文または FAQ 内で自然に1〜2箇所）を追加し、セッション深度を上げる
