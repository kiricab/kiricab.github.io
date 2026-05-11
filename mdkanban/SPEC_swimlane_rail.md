# mdkanban スイムレーンUI リファクタ仕様書 — サイドレール方式（48px）

## 目的・概要
スイムレーン表示時の左端ヘッダ列が現状 168px と広く、レーン名の右側および各カード行の左端にカード1枚分近い余白を生んでいる。本リファクタでは、ヘッダ列を **48px幅の縦長サイドレール** に再設計し、レーン名を回転表示することで、横方向のスペース効率を大きく改善する。既存機能（折りたたみ・名前変更・追加・削除・ドラッグ並び替え）は壊さずそのまま維持する。

このドキュメントは、`mdkanban/SPEC.md`（本ツールの全体仕様）の **スイムレーン領域に対する差分仕様** として位置づける。

## スコープ
- 影響範囲: スイムレーンモード（`.kanban-board.has-swimlanes`）のみ。通常モード（`lanes:` 無し）は変更しない。
- 対象ファイル:
  - `/Users/masa/Documents/develop/tools/kiricab.github.io/mdkanban/style.css`（L1163〜L1611 のスイムレーン関連ブロック）
  - `/Users/masa/Documents/develop/tools/kiricab.github.io/mdkanban/script.js`（`renderSwimlaneBoard` / `renderSwimlaneRow` / `renderAddLaneControl` / `startLaneRename`）

---

## ビジュアル仕様

### 幅・グリッド
| 項目 | 現状 | 変更後 |
|---|---|---|
| `.swimlane-row` の grid-template-columns 先頭 | `168px` | **`48px`** |
| `.kanban-column-headers`（has-swimlanes時）の grid-template-columns 先頭 | `168px` | **`48px`** |
| `.swimlane-header` の width | `168px` | **`48px`** |
| `.swimlane-add-wrap` の width | `168px` | **`48px`** |
| 列幅（300px）・列ギャップ（0.75rem） | 変更なし | 変更なし |
| sticky left: 0 / z-index: 4 | 維持 | 維持 |

### コーナーセル（"レーン" ラベル）
- 48px に「レーン」テキストは収まらないため、`::before { content: "レーン" }` を **削除または空文字** にして空セルにする。
- 役割は「カード列ヘッダ行の左端にレール幅と同じ空セルを確保する」のみ。

### レーン名の回転表示
- `transform: rotate(-90deg)`（**左90度回転 = 下から上に読む**）。
- フォントは横書きを維持し、`writing-mode` は使用しない。`white-space: nowrap`。
- 回転後の収まりを確保するためにラッパー（`.swimlane-name`）の幅・高さを入れ替える前提でレイアウトする（レール内部で「縦長の細長い箱」として配置）。
- アルファベット・日本語混在を許容。
- 長すぎるレーン名は `text-overflow: ellipsis` で省略する。
- フォントサイズ: 0.85rem 前後（現状 0.9rem から微調整）。フォントウェイトは現状維持（600）。
- 「未分類」レーン（`.is-default-lane`）でも回転表示する。

### ヘッダ内縦積み構成（上→下）
レール内に **上から下へ** 以下の4要素を縦に積む：

1. **ドラッグハンドル `⋮⋮`**（最上部・小）
   - 現状の `.swimlane-collapse-btn::before` で表現されているグリップを、レーンヘッダ上端に配置し直す。
   - 折りたたみトグルと統合してもよい（「上端ヒット領域 = グリップ表示 + 折りたたみクリック」一体型）。
2. **折りたたみトグル `▼`**（クリックで折りたたみ。現状の `.swimlane-toggle`）
   - 折りたたみ時は現状どおり `transform: rotate(-90deg)` で `▶` 相当に。
3. **回転レーン名**（中央・主要素）
   - レール内で最大の縦領域を占めるメイン要素。
4. **カード件数バッジ**（最下部・小。現状の `.swimlane-count`）
   - 円形バッジ（径 22〜26px 程度）でレール下端に配置。

### カラー・ボーダー（現状維持）
- 背景: `var(--kanban-col-bg)`、ボーダー: `var(--kanban-col-border)`、左端アクセント: `border-left: 4px solid var(--primary-color)`。
- ホバー: `var(--card-color)` 背景、`var(--primary-color)` ボーダー、薄い `box-shadow`。
- 「未分類」レーン: 左端ボーダーがダッシュ・透明背景・`var(--gray-text-color)` 文字色。
- ドロップターゲット時: `box-shadow: 0 0 0 2px var(--primary-color) inset`。

### 管理ボタン（▲▼✎🗑）のフローティング表示
- 通常時: **非表示**（`opacity: 0; pointer-events: none;` または `visibility: hidden`）。
- レーンヘッダ `:hover` / `:focus-within`: **右側にフローティング表示**。
  - 配置: `position: absolute; left: 100%; top: 0;`（レール右隣に出す）
  - レイアウト: 横並び4ボタン（`display: flex; flex-direction: row;`）
  - 背景: `var(--card-color)`、ボーダー: `var(--kanban-col-border)`、`border-radius: 6px`、軽い `box-shadow`。
  - z-index はカード（z:1）と sticky ヘッダ（z:4）の上に出す（z:6 程度）。
- タッチ環境（`@media (hover: none)`）: **常時表示**。実装は以下のいずれかでよい（開発者判断）:
  - レール内に縦スタックで収める
  - レール下に追加ブロックとして縦/横並びで表示
- ボタンサイズ・色は現状の `.swimlane-action-btn` を踏襲（30×30、ホバーで `--secondary-color` 背景・`--primary-color` 文字色、削除ボタンのみ赤系）。

### インライン名前変更時の一時拡張
- `startLaneRename` 突入時のみ、対象 `.swimlane-header` を `48px → 168px` 程度に **一時拡張**（クラス付与で切替、例: `.is-renaming`）。
- 拡張中は **横書き入力**（`.swimlane-name` の rotate を解除）。
- 確定（Enter）/ キャンセル（Esc）/ blur で 48px に戻す。
- 拡張中は同行のカードグリッドは押し出されず、レール下に重なる **オーバーレイ表示**（`position: absolute` + 背景塗り）でもよい — どちらでも良いが、編集が終わったら必ず元の48pxに戻ること。

---

## DOM構造の変更点

既存の DOM 構造は **基本的に維持** する。クラス名・要素ネスト・属性（`data-lane-name` / `aria-expanded` / `aria-label`）は変更しない。ただし以下の構造調整は許容する:

- `.swimlane-collapse-btn` 内の `<span class="swimlane-toggle">` / `<span class="swimlane-name">` / `<span class="swimlane-count">` の **並び順は CSS の `order` または DOM の並べ替えで調整可**（最終的に上→下: ハンドル/トグル → 名前 → カウント の縦並びになればよい）。
- 管理ボタン群 `.swimlane-actions` は `.swimlane-header` 直下のまま（`position: absolute` で右へフローティングするため、親の `.swimlane-header` に `position: relative` を付与）。
- ハンドル `⋮⋮` を `::before` 疑似要素のままにするか、トグルボタンの中に独立した `<span class="swimlane-grip">` を持たせるかは開発者判断。

---

## 影響を受けるCSSクラス一覧

| クラス | 主な変更内容 |
|---|---|
| `.kanban-board.has-swimlanes .kanban-column-headers` | `grid-template-columns` の先頭値を `168px → 48px` |
| `.swimlane-corner` | `::before { content: "レーン" }` を削除し空セル化。`padding` も整理。 |
| `.swimlane-row` | `grid-template-columns` の先頭値を `168px → 48px` |
| `.swimlane-header` | `width: 168px → 48px`。`flex-direction: column` を維持しつつ、内部要素を「ハンドル → トグル → 回転名 → カウント」の順に縦積み。`position: relative` を付与（管理ボタンの絶対配置基準）。`padding` は左右ほぼゼロ・上下のみに調整。 |
| `.swimlane-name` | `transform: rotate(-90deg)` を付与、回転後に縦長領域へ収まるサイズ・配置に再定義。`text-overflow: ellipsis; white-space: nowrap` 維持。 |
| `.swimlane-toggle` | サイズ微調整（レール幅48pxに収まるよう）。折りたたみ時 rotate は維持。 |
| `.swimlane-collapse-btn` | `flex-direction: column`、レール内縦積みレイアウトに変更。`::before`（グリップ）の位置を上端へ。 |
| `.swimlane-count` | レール下端配置・円形バッジ寄りのサイズに調整（径 22〜26px、`font-size: 0.7rem` 前後）。 |
| `.swimlane-actions` | 通常時非表示。`position: absolute; left: 100%; top: 0`、横並び。`opacity` トランジションでフェードイン。 |
| `.swimlane-header:hover > .swimlane-actions` / `:focus-within` | `opacity: 1; pointer-events: auto;` で表示。 |
| `@media (hover: none) .swimlane-actions` | 常時表示・タッチ向けレイアウト。 |
| `.swimlane-action-btn` | サイズ・色は維持。 |
| `.swimlane-rename-input` | 編集モード専用に幅・回転解除を再定義。 |
| `.swimlane-header.is-renaming`（新規） | レール幅を `168px` に一時拡張。`.swimlane-name` の rotate を解除し横書き表示。 |
| `.is-default-lane > .swimlane-header` | レール幅48pxにそのまま適用（ダッシュボーダー・控えめ色を維持）。 |
| `.swimlane-add-wrap` | `width: 168px → 48px`、sticky left: 0 維持。 |
| `.swimlane-add-btn` | レール幅48pxに収まる縦長スタイルに調整（テキスト「+ レーン追加」は回転 or `+` のみ表示にしてホバーでツールチップ。**実装方針は開発者判断**。本仕様の最低要件は「48px幅で機能が損なわれないこと」）。 |
| `.swimlane-add-form` | 入力フォーム表示時はレールから外して `position: absolute` でレール右側にポップする等、48pxに収まらない要素はフローティング表示にする。 |

---

## 影響を受けるJS関数一覧

DOM構造は基本維持なので、JS の変更は **最小限** で済むはず。以下のみ調整余地あり:

| 関数 | 想定される変更 |
|---|---|
| `renderSwimlaneRow`（script.js L963〜L1104） | `.swimlane-collapse-btn` 内の span 並び順の調整、または `.swimlane-grip` 用 span の追加（CSS の `order` で吸収できるなら不要）。 |
| `startLaneRename`（要該当箇所確認） | 編集突入時に `.swimlane-header` に `is-renaming` クラスを付与、確定/キャンセル/blur 時に外す処理を追加。 |
| `renderAddLaneControl` / `showAddLaneForm` | 「+ レーン追加」ボタンを48px幅で機能させるための DOM/属性調整。フォーム表示時にフローティングさせる場合は配置ロジック追加。 |
| その他（`attachLaneHeaderDnDHandlers` / `toggleLaneCollapsed` / `moveLane` / `requestDeleteLane` / `attachColumnDnDHandlers`） | **変更なし**。DOM 構造とイベントハンドラの接続は維持される前提。 |

---

## アクセシビリティ要件

- `aria-label` は現状維持: 折りたたみトグル `${laneDisplay} レーンの折りたたみを切替`、各管理ボタンも現状の文言を維持。
- `aria-expanded` の付与とトグルも現状維持。
- `aria-hidden` を `swimlane-corner` と装飾要素（グリップ等）に維持。
- **回転されたレーン名のスクリーンリーダー読み上げ**: `transform: rotate` は読み上げに影響しないため、テキスト内容そのままで読み上げ可能であること。`aria-label` を別途指定する必要はない。
- **キーボード操作**:
  - Tab で折りたたみトグルにフォーカス可能、Enter/Space で折りたたみ切替。
  - フォーカス時に `:focus-within` が効き、管理ボタン群が表示されること（マウスホバーが使えないキーボードユーザーの導線確保）。
  - 管理ボタン群へも Tab で順次到達可能。
  - レーン名編集モード（`startLaneRename`）に入った直後、入力欄に自動フォーカスし、Esc でキャンセル / Enter で確定 が現状どおり動くこと。
- **コントラスト**: 回転されたテキストでもライト/ダーク両テーマで `var(--text-color)` / `var(--gray-text-color)` を使い、WCAG AA（4.5:1）相当を維持。
- **フォーカスリング**: `:focus-visible` の `outline` は現状維持（折りたたみトグル・管理ボタン・入力欄）。回転要素の上に出るアウトラインも視認できること。
- **フローティング管理ボタンのヒット領域**: `position: absolute` でレール外に出るが、レール本体の hover 状態を解除する `mouseleave` でフローティングが消えてクリックできない事故を起こさないこと（`.swimlane-header:hover` の判定がフローティング上にも効くよう、ボタン群を `.swimlane-header` の子要素として保持する）。

---

## 既存機能の非破壊確認チェックリスト

リファクタ完了時、以下が **すべて引き続き動作すること**:

- [ ] **折りたたみ**: トグルクリック / Enter / Space で `.is-collapsed` クラスが付与され、`.swimlane-row` が非表示になる。再クリックで復帰。`▼` が `▶` 相当に回転する。
- [ ] **レーン名インライン編集**: `✎` ボタン または トグル ダブルクリックで編集モード突入、入力欄にフォーカス。Enter で確定、Esc / blur でキャンセル。編集中はレール幅が一時拡張され、確定後 48px に戻る。
- [ ] **レーン追加**: 「+ レーン追加」ボタンから入力フォーム展開、確定でレーン末尾追加。`lanes:` 未宣言ファイルでも初回追加で `lanes:` が新規生成される（既存仕様）。
- [ ] **レーン削除**: `🗑` ボタンで削除確認 → 削除実行（既存の `requestDeleteLane`）。
- [ ] **レーン並び替え（ボタン）**: `▲▼` ボタンで上下移動、先頭/末尾で disabled。
- [ ] **レーン並び替え（ドラッグ）**: ヘッダドラッグで他レーンの上にドロップ → 順序変更。`is-lane-drop-target` ハイライトが出る。
- [ ] **カードDnD**: カードを別レーン・別列のセルにドラッグ&ドロップで移動できる（`attachColumnDnDHandlers` の動作）。
- [ ] **「未分類」レーン**: `.is-default-lane` の控えめスタイル（ダッシュボーダー・透明背景）が48pxレールでも維持される。カード0件時はレーン非表示の現状仕様を維持。
- [ ] **横スクロール時の sticky**: ボードを横スクロールしてもレーンヘッダがレール位置に張り付き続ける（`position: sticky; left: 0`）。
- [ ] **フィルタ連動**: `matchesFilter` で絞り込んだ件数がカウントバッジに正しく反映される。
- [ ] **コンソールエラーなし**: 上記操作いずれもブラウザコンソールにエラー・警告を出さない。

---

## レスポンシブ・タッチ環境

- **デスクトップ（hover あり）**: 管理ボタンは hover/focus-within でフローティング表示。
- **タッチ環境（`@media (hover: none)`）**: 管理ボタンは常時可視（レール内縦スタック または レール下追加ブロック）。タップ単発で発火するように `:hover` 依存の表示制御を切り替える。
- **モバイル幅（〜640px）**: 横スクロールでカンバンを閲覧する前提（mdkanban の既存仕様 = PC優先）。レール幅48pxはモバイルでも変更しない（カードを少しでも広く見せる目的が成立するため）。
- **タッチでのレーン並び替え**: HTML5 DnD はタッチ未対応のため、`▲▼` ボタンでの並び替えがタッチ環境の主導線になる（現状仕様どおり）。

---

## ライト/ダークテーマ両対応の確認項目

- [ ] **ライトテーマ**: レール背景 `var(--kanban-col-bg)`、テキスト `var(--text-color)`、ホバー時の浮き上がり（`box-shadow`）が視認できる。
- [ ] **ダークテーマ**（`body[data-theme="dark"]`）: 同 CSS 変数を使うため自動追従。`.swimlane:hover` / `.swimlane-header:hover` のダーク用オーバーライドが現状維持で効く。
- [ ] **回転レーン名のコントラスト**: 両テーマで4.5:1以上。
- [ ] **「未分類」レーン**: 両テーマでダッシュボーダーと控えめ文字色（`var(--gray-text-color)`）が破綻しない。
- [ ] **ドロップターゲットハイライト**: `is-lane-drop-target` の primary-color インセット影が両テーマで識別可能。
- [ ] **フローティング管理ボタンの背景**: `var(--card-color)` を使い、両テーマでレール本体と区別がつく。
- [ ] **フォーカスリング**: `var(--primary-color)` のアウトラインが両テーマで視認可能。

---

## 受け入れ基準

- [ ] **AC1**: スイムレーンモードで、レール幅が 48px になっている（DevTools で `.swimlane-header` を選択し computed `width` が `48px`）。
- [ ] **AC2**: レーン名が左90度回転（下から上に読む方向）で表示され、長いレーン名は省略記号で切り詰められる。
- [ ] **AC3**: レール内に上から「ハンドル `⋮⋮` / 折りたたみ `▼` / 回転レーン名 / カウントバッジ」の4要素が縦に並ぶ。
- [ ] **AC4**: 管理ボタン群（▲▼✎🗑）はレーンヘッダにマウスを乗せていない時は非表示で、ホバー / Tabフォーカスでレール右隣にフローティング表示される。
- [ ] **AC5**: タッチ環境（`hover: none` メディアクエリ）では管理ボタンが常時表示される。
- [ ] **AC6**: `✎` ボタン または トグルダブルクリックで編集モードに入ると、レール幅が一時的に拡張され、入力欄が横書きで表示される。確定または Esc で48pxに戻る。
- [ ] **AC7**: ボードを横スクロールしてもレーンヘッダがレール位置に張り付き続ける（sticky 維持）。
- [ ] **AC8**: 折りたたみ・追加・削除・名前変更・カードDnD・レーン並び替え（ボタン/ドラッグ）が引き続き動作する。
- [ ] **AC9**: ライト/ダーク両テーマでレイアウトが破綻せず、コントラストが維持される。
- [ ] **AC10**: ブラウザコンソールにエラー・警告を出さない。

---

## スコープ外（このリファクタでは扱わない）

- 通常モード（`lanes:` 無し）の見た目変更
- 列幅（300px）・列ギャップ（0.75rem）の変更
- カード本体のスタイル変更
- レーン追加フォームの UX 全面刷新（48pxに収めるための最小調整は含むが、フローやバリデーションは現状維持）
- `SPEC.md` 本体の更新（本ドキュメントは差分仕様として独立配置）

---

## 開発者向け引き継ぎサマリ

- 編集対象: `mdkanban/style.css`（L1163〜L1611）/ `mdkanban/script.js`（`renderSwimlaneRow` 周辺、`startLaneRename`、`renderAddLaneControl`）
- 主要な数値変更: `168px → 48px`（4箇所: `.swimlane-row` / `.kanban-column-headers` / `.swimlane-header` / `.swimlane-add-wrap`）
- 新規CSSクラス候補: `.swimlane-header.is-renaming`（編集中の一時拡張）
- DOM構造はクラス名・属性とも維持を優先。要素並びの変更は CSS の `order` で吸収可能なら JS は触らない。
- フローティング管理ボタンの基準点: `.swimlane-header { position: relative }` を新たに付与し、`.swimlane-actions { position: absolute; left: 100% }`。
- 確認が必要な未確定事項: 無し（仕様確定済み）。
- Playwright での動作確認時のスクリーンショット観点: ライト/ダーク・hover前/hover後・編集モード突入時・モバイル幅（375px）・横スクロール時 sticky。
