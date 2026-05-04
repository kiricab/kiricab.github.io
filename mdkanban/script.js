/* mdkanban — Markdownをカンバンとして表示するビューワー
   外部依存: marked (MIT) / DOMPurify (Apache-2.0 / MPL-2.0)
   すべての処理はブラウザ内で完結。ファイル内容は外部送信しない。 */

(() => {
  'use strict';

  // -------- 定数・設定 --------
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  const STORAGE_KEYS = {
    content: 'mdkanban.lastContent',
    fileName: 'mdkanban.lastFileName',
    theme: 'mdkanban.theme',
    density: 'mdkanban.density',
    collapsedLanes: 'mdkanban.collapsedLanes'
  };

  // スイムレーン用の lane 名・タグ抽出に使う共通 character class（既存タグの記法と揃える）。
  const LANE_NAME_CHARS = 'A-Za-z0-9_\\-぀-ヿ㐀-鿿';
  // デフォルトレーン（lane 未指定カードが集まる行）の表示名
  const DEFAULT_LANE_DISPLAY_NAME = '未分類';

  const SAMPLE_MD = `---
kanban-plugin: basic
lanes:
  - バックエンド
  - フロントエンド
---

# 春のリリース計画

## TODO

- [ ] API設計 #lane/バックエンド #design @2026-05-10
  - [ ] エンドポイント洗い出し
  - [ ] レビュー会
- [ ] 画面実装 #lane/フロントエンド #seo
- [ ] アクセシビリティ点検 #a11y @2026-05-15
- [ ] 検証用スクリプト #lane/QA

## Doing

- [ ] ドキュメント整備 #lane/バックエンド @2026-04-25
  詳細はこちらを参照: [社内Wiki](https://example.com)
- [ ] パフォーマンス計測 #perf

## Done

- [x] 仕様書作成 #lane/バックエンド #planning
- [x] 関係者ヒアリング
- [x] キックオフMTG
`;

  // -------- 要素参照 --------
  const $ = (id) => document.getElementById(id);

  const els = {
    body: document.body,
    fileInput: $('file-input'),
    openFileBtn: $('open-file-btn'),
    sampleBtn: $('sample-btn'),
    themeToggle: $('theme-toggle'),
    densityToggle: $('density-toggle'),
    fileNameDisplay: $('file-name-display'),
    restoreBanner: $('restore-banner'),
    restoreYesBtn: $('restore-yes-btn'),
    restoreNoBtn: $('restore-no-btn'),
    statusArea: $('status-area'),
    tagFilterBar: $('tag-filter-bar'),
    activeTagDisplay: $('active-tag-display'),
    clearFilterBtn: $('clear-filter-btn'),
    emptyState: $('empty-state'),
    boardSection: $('board-section'),
    boardTitle: $('board-title'),
    boardStats: $('board-stats'),
    kanbanBoard: $('kanban-board'),
    dropzone: $('dropzone'),
    dropzoneOpenBtn: $('dropzone-open-btn'),
    dropzoneSampleBtn: $('dropzone-sample-btn'),
    cardModal: $('card-modal'),
    cardModalBackdrop: $('card-modal-backdrop'),
    cardModalClose: $('card-modal-close'),
    cardModalCloseBtn: $('card-modal-close-btn'),
    cardModalTitle: $('card-modal-title'),
    cardModalBody: $('card-modal-body'),
    cardModalEditBtn: $('card-modal-edit-btn'),
    cardModalDeleteBtn: $('card-modal-delete-btn'),
    cardModalEditForm: $('card-modal-edit-form'),
    cardModalViewActions: $('card-modal-view-actions'),
    cardModalEditActions: $('card-modal-edit-actions'),
    cmeTitle: $('cme-title'),
    cmeBody: $('cme-body'),
    cmeSubtasks: $('cme-subtasks'),
    cmeAddSubtask: $('cme-add-subtask'),
    cmeSaveBtn: $('cme-save-btn'),
    cmeCancelBtn: $('cme-cancel-btn'),
    saveBtn: $('save-btn'),
    downloadBtn: $('download-btn'),
    copyBtn: $('copy-btn'),
    dirtyMarker: $('dirty-marker'),
    saveStatus: $('save-status'),
    dndLiveRegion: $('dnd-live-region'),
    toastArea: $('toast-area')
  };

  // -------- 状態 --------
  const state = {
    board: null,         // パース結果
    activeTagFilter: null,
    fileName: '',
    lastFocusBeforeModal: null,
    dragging: null,      // DnD中: { cardId, fromColIdx, fromCardIdx, fromLane }
    fileHandle: null,    // FSA経由で取得した FileSystemFileHandle
    dirty: false,        // DnD後の未保存フラグ
    serializedMarkdown: null, // 最後にシリアライズしたMarkdown（保存系で使い回し）
    collapsedLanes: new Set(),  // 折りたたみ中のlane名（LocalStorage と同期）
    // インライン編集状態:
    //   { cardId, mode: 'inline', isNew: boolean, originalTitle: string }
    // モーダル編集状態:
    //   { cardId, mode: 'modal' }
    editing: null,
    autoSaveTimer: null,             // setTimeout のID（debounce）
    autoSaveStatus: 'idle',          // 'idle'|'saving'|'saved'|'error'
    autoSavePendingHide: null,       // 「✓ 保存済み」消去用 setTimeout
    currentModalCard: null           // モーダルが開いているカードの参照
  };

  // カードIDのカウンター（パース毎にリセット）
  let cardIdCounter = 0;

  // DnD直後にclickが誤発火するブラウザ実装差を吸収するための抑制フラグ。
  // dragend → 短時間 click が走る端末向けに、120ms 以内のclickを無視する。
  let suppressClickUntil = 0;

  // -------- ユーティリティ --------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showStatus(message, type = 'success', autoHide = true) {
    const div = document.createElement('div');
    div.className = `status-msg ${type}`;
    div.textContent = message;
    els.statusArea.appendChild(div);
    if (autoHide) {
      setTimeout(() => {
        if (div.parentNode) div.parentNode.removeChild(div);
      }, type === 'error' ? 6000 : 3500);
    }
    return div;
  }

  function clearStatus() {
    els.statusArea.innerHTML = '';
  }

  // -------- Markdownパース（カンバン用） --------

  /**
   * frontmatter (---で囲まれたYAML風ブロック) を切り出す。
   * 戻り値:
   *   {
   *     frontmatter: { [key]: stringValue },   // スカラーキーのみ。lanes: は別途
   *     lanes: string[] | null,                // lanes: キーが「有る」場合のみ配列、無ければ null
   *     hasLanesKey: boolean,                  // lanes: キーの有無（空配列でも true）
   *     otherKeysRaw: string,                  // lanes: 以外の生 YAML 行を join したもの（再シリアライズ時に貼り戻す）
   *     body: string,
   *     frontmatterRaw: string                 // 既存互換用に残すが、再シリアライズでは otherKeysRaw + lanes 配列で再構築する
   *   }
   *
   * lanes: は YAML ブロックスタイル（`- 名前` 形式）でパースする。フロー形式（`[a, b]`）は本ツールが書き出さないので
   * MVP では未対応とし、誤って入っていても他キー扱いで貼り戻す。
   */
  function extractFrontmatter(md) {
    const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) {
      return {
        frontmatter: {},
        lanes: null,
        hasLanesKey: false,
        otherKeysRaw: '',
        body: md,
        frontmatterRaw: ''
      };
    }
    const yamlBody = m[1];
    const lines = yamlBody.split(/\r?\n/);
    const fm = {};
    const otherLines = [];
    let hasLanesKey = false;
    let lanesArr = null;
    let inLanesBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // lanes ブロック解釈中: 直下のインデント `- 名前` 行を集める。
      if (inLanesBlock) {
        const itemMatch = line.match(/^\s+-\s+(.*)$/);
        if (itemMatch) {
          let val = itemMatch[1].trim();
          if ((val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (val !== '' && !lanesArr.includes(val)) {
            lanesArr.push(val);
          }
          continue;
        }
        // 空行や別キーへの遭遇でブロック終了。空行は捨てて他キー側でも保持しない。
        inLanesBlock = false;
        if (line.trim() === '') continue;
        // フォールスルー: 通常行として処理する
      }

      // lanes: で始まる行（値なし or `[..]` フロー形式）
      const lanesHeader = line.match(/^lanes\s*:\s*(.*)$/);
      if (lanesHeader) {
        hasLanesKey = true;
        lanesArr = lanesArr || [];
        const inlineVal = lanesHeader[1].trim();
        if (inlineVal === '' || inlineVal === '[]') {
          // ブロックスタイル開始 もしくは空配列
          inLanesBlock = (inlineVal === '');
        } else {
          // フロー形式 `[a, b, "c"]` を緩くパース（書き出し側はブロック形式に統一）
          const flow = inlineVal.match(/^\[(.*)\]$/);
          if (flow) {
            flow[1].split(',').forEach(part => {
              let v = part.trim();
              if ((v.startsWith('"') && v.endsWith('"')) ||
                  (v.startsWith("'") && v.endsWith("'"))) {
                v = v.slice(1, -1);
              }
              if (v !== '' && !lanesArr.includes(v)) lanesArr.push(v);
            });
          }
          // それ以外（スカラーが直書き）は無視。
          inLanesBlock = false;
        }
        continue;
      }

      // 通常のスカラーキー
      const kv = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
      if (kv) {
        let val = kv[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        fm[kv[1]] = val;
        otherLines.push(line);
        continue;
      }
      // 空行・コメント等は他キー領域に保持（順序維持のため）
      otherLines.push(line);
    }

    // 末尾の連続空行はまとめて除去（再シリアライズで余計な空行が残らないようにする）
    while (otherLines.length && otherLines[otherLines.length - 1].trim() === '') {
      otherLines.pop();
    }

    return {
      frontmatter: fm,
      lanes: hasLanesKey ? lanesArr : null,
      hasLanesKey,
      otherKeysRaw: otherLines.join('\n'),
      body: md.slice(m[0].length),
      frontmatterRaw: m[0]
    };
  }

  /**
   * 行頭インデント幅を計算（タブ=4スペース換算）。
   */
  function indentWidth(line) {
    let w = 0;
    for (const ch of line) {
      if (ch === ' ') w++;
      else if (ch === '\t') w += 4;
      else break;
    }
    return w;
  }

  /**
   * パース：見出し/箇条書き/段落をブロック単位に切り出してカンバン構造を作る。
   *
   * 戻り値:
   * {
   *   title: string,
   *   columns: [{ name, cards: [card] }],
   *   warnings: string[]
   * }
   *
   * cardの構造:
   * { title, checked: bool|null, tags: string[], dueDate: string|null,
   *   subtasks: [{title, checked}], rawBody: string (詳細用Markdown) }
   */
  /**
   * 共通: カード生タイトル文字列から lane / tags / dueDate / displayTitle を抽出する。
   *   - swimlaneMode=true  : `#lane/X` を専用記法として認識し、tags に混入させず displayTitle から除去する
   *   - swimlaneMode=false : `#lane/X` を通常のタグバッジ（tag 値 = `lane/X`）として扱い、displayTitle に残す
   * 戻り値: { title, displayTitle, tags, lane, dueDate }
   */
  function reparseTitleMeta(rawTitle, swimlaneMode) {
    let lane = '';
    let displayTitle = rawTitle;
    const tags = [];

    if (swimlaneMode) {
      // lane 抽出: 最初の `#lane/<名前>` のみ採用。`#lane/foo/bar` は `foo` のみ採用。
      const laneRe = new RegExp(`(?:^|\\s)#lane\\/([${LANE_NAME_CHARS}]+)`);
      const laneMatch = rawTitle.match(laneRe);
      lane = laneMatch ? laneMatch[1] : '';
      // 通常タグ抽出: `#lane/...` は除外
      const tagRe = new RegExp(`(?:^|\\s)#(?!lane\\/)([${LANE_NAME_CHARS}]+)`, 'g');
      let mt;
      while ((mt = tagRe.exec(rawTitle)) !== null) {
        if (!tags.includes(mt[1])) tags.push(mt[1]);
      }
      // displayTitle: lane / 通常タグ / 期限 の順に除去
      displayTitle = rawTitle
        .replace(new RegExp(`(?:^|\\s)#lane\\/[${LANE_NAME_CHARS}]+(?:\\/[${LANE_NAME_CHARS}]+)*`, 'g'), ' ')
        .replace(new RegExp(`(?:^|\\s)#[${LANE_NAME_CHARS}]+`, 'g'), ' ')
        .replace(/(?:^|\s)@\d{4}-\d{2}-\d{2}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } else {
      // 従来モード（`lanes:` キーが無い）:
      //   `#lane/X` は通常のタグバッジとして扱い、tag 値は `lane/X` の形のまま採用する。
      //   ただし AC35 / SPEC L61 / L107 の規定に従い、`#lane/X` は **displayTitle から除去しない**。
      //   通常の `#tag` は二重表示を避けるため従来どおり displayTitle から除去する。
      // タグの char class は通常 `[A-Za-z0-9_\-...]+` で `/` を含まないため、`#foo/bar` 全体を1タグとして拾う専用正規表現で抽出する。
      const tagRe = new RegExp(`(?:^|\\s)#([${LANE_NAME_CHARS}]+(?:\\/[${LANE_NAME_CHARS}]+)*)`, 'g');
      let mt;
      while ((mt = tagRe.exec(rawTitle)) !== null) {
        if (!tags.includes(mt[1])) tags.push(mt[1]);
      }
      // displayTitle:
      //   - `#lane/...` は残す（AC35）
      //   - `#tag`（lane 接頭辞でない通常タグ）は除去
      //   - `@YYYY-MM-DD` 期限は除去
      displayTitle = rawTitle
        .replace(new RegExp(`(?:^|\\s)#(?!lane\\/)[${LANE_NAME_CHARS}]+(?:\\/[${LANE_NAME_CHARS}]+)*`, 'g'), ' ')
        .replace(/(?:^|\s)@\d{4}-\d{2}-\d{2}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const due = rawTitle.match(/(?:^|\s)@(\d{4}-\d{2}-\d{2})\b/);
    const dueDate = due ? due[1] : null;

    return {
      title: rawTitle.trim(),
      displayTitle,
      tags,
      lane,
      dueDate
    };
  }

  function parseKanban(md) {
    const fmInfo = extractFrontmatter(md);
    const { frontmatter, body, frontmatterRaw, hasLanesKey, otherKeysRaw } = fmInfo;
    // lanes: キーが有るときのみホワイトリストとして使う。空配列もホワイトリスト＝0件として扱う。
    const lanesWhitelist = hasLanesKey ? (fmInfo.lanes || []) : null;
    const lines = body.replace(/\r\n/g, '\n').split('\n');

    const result = {
      // 初期値は frontmatter.title。H1が見つかった場合は H1 が優先で上書きする（後述）。
      // SPEC.md F7-5 の「完全保証: H1」と整合させるため、再シリアライズ後も入力時のH1テキストが保たれる。
      title: frontmatter.title || '',
      columns: [],
      warnings: [],
      frontmatterRaw: frontmatterRaw || '',
      // 厳密モード判定用の情報を保持。再シリアライズ／編集 UI で参照する。
      hasLanesKey: !!hasLanesKey,
      lanesWhitelist: lanesWhitelist ? [...lanesWhitelist] : null,
      otherFrontmatterRaw: otherKeysRaw || ''
    };

    let currentColumn = null;
    /** トップレベルカードの参照スタック。直近の親カード本文行を蓄積する */
    let currentCard = null;
    let currentCardBaseIndent = 0;
    let currentCardBodyLines = [];
    /** H2が1度でも出現したか（フォールバック判定用） */
    let sawH2 = false;
    /** H1が一度でも採用されたか（複数あっても最初の1つだけを採用するための専用フラグ）。
     *  「title が空かどうか」では frontmatter.title 由来か H1 由来か判別できないため。 */
    let sawH1 = false;
    /** カードに紐付く本文（段落・コード等）の蓄積を flush */
    function flushCardBody() {
      if (currentCard && currentCardBodyLines.length) {
        currentCard.bodyParts.push(currentCardBodyLines.join('\n'));
        currentCardBodyLines = [];
      }
    }

    /** 入力テキストからメタ情報を抽出してカード化（厳密モード対応） */
    function buildCard(rawTitle, checked) {
      // 厳密モード判定: frontmatter に `lanes:` キーがあれば lane 専用記法として扱う。
      // 無ければ `#lane/X` は通常タグバッジ扱いで displayTitle からも除去しない。
      const swimlaneMode = !!hasLanesKey;
      const card = reparseTitleMeta(rawTitle, swimlaneMode);
      card.checked = checked;
      card.subtasks = [];
      card.bodyParts = [];
      return card;
    }

    // H2より前の浮いた箇条書きを集める「未分類」列
    let unsortedColumn = null;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const line = rawLine; // 原文を保持
      const trimmed = line.trim();

      // H1 → ボードタイトル（frontmatter.title より優先採用）
      // 複数H1がある場合は最初の1つだけ採用（SPEC: 「複数あっても最初の1つのみ採用」）。
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1 && !line.startsWith('##')) {
        if (!sawH1) {
          result.title = h1[1].trim();
          sawH1 = true;
        }
        flushCardBody();
        currentCard = null;
        continue;
      }

      // H2 → 列
      const h2 = line.match(/^##\s+(.+)$/);
      if (h2) {
        sawH2 = true;
        flushCardBody();
        currentCard = null;
        currentColumn = { name: h2[1].trim(), cards: [] };
        result.columns.push(currentColumn);
        continue;
      }

      // 箇条書き判定（- / * / +）
      const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/);
      if (bullet) {
        const indent = indentWidth(bullet[1]);
        const itemText = bullet[3];
        // チェックボックス判定
        const cb = itemText.match(/^\[( |x|X)\]\s+(.*)$/);
        const checked = cb ? (cb[1].toLowerCase() === 'x') : null;
        const text = cb ? cb[2] : itemText;

        // 親カード（トップレベル）かサブタスクかを indent で判定
        if (currentCard && indent > currentCardBaseIndent) {
          // サブタスク（ネスト箇条書き）
          flushCardBody();
          currentCard.subtasks.push({
            title: text.trim(),
            checked: cb ? checked : false // チェックボックス無しのネストはfalse扱い（進捗未完）
          });
          continue;
        }

        // トップレベルカード
        flushCardBody();
        const card = buildCard(text, checked);
        if (currentColumn) {
          currentColumn.cards.push(card);
        } else {
          // H2より前の箇条書き → 「未分類」列
          if (!unsortedColumn) {
            unsortedColumn = { name: '未分類', cards: [] };
          }
          unsortedColumn.cards.push(card);
        }
        currentCard = card;
        currentCardBaseIndent = indent;
        currentCardBodyLines = [];
        continue;
      }

      // 空行・本文段落・コードブロック
      if (currentCard) {
        // 直前カードの「子コンテンツ」として本文行を蓄積
        // ただしインデントが基準より深い、または非箇条書きの場合のみ
        if (trimmed === '') {
          // 空行はカード本文の区切り。蓄積中のものを flush して継続
          if (currentCardBodyLines.length) {
            currentCard.bodyParts.push(currentCardBodyLines.join('\n'));
            currentCardBodyLines = [];
          }
          continue;
        }
        const lineIndent = indentWidth(rawLine);
        if (lineIndent > currentCardBaseIndent || lineIndent >= 2) {
          // インデントを正規化して詰める（先頭の親インデント分を取り除く）
          const stripWidth = currentCardBaseIndent + 2;
          let stripped = rawLine;
          let removed = 0;
          while (removed < stripWidth && (stripped.startsWith(' ') || stripped.startsWith('\t'))) {
            if (stripped.startsWith('\t')) {
              stripped = stripped.slice(1);
              removed += 4;
            } else {
              stripped = stripped.slice(1);
              removed += 1;
            }
          }
          currentCardBodyLines.push(stripped);
          continue;
        }
        // インデント0の通常文 → カード本文の区切れ
        flushCardBody();
        currentCard = null;
      }
      // それ以外（H3〜H6・水平線・通常段落でカード外）は無視。
    }

    // 残った蓄積を flush
    flushCardBody();

    // フォールバック判定: H2が1度も出現しなかった場合
    // この場合は H2 より前に積まれたカード(unsortedColumn) を単一列「カード」として扱い、
    // 警告バナーで利用者に通知する。
    if (!sawH2) {
      if (unsortedColumn && unsortedColumn.cards.length > 0) {
        unsortedColumn.name = 'カード';
        result.columns.push(unsortedColumn);
        result.warnings.push('## 見出しが見つからなかったため、すべてのカードを1列にまとめました');
      }
      // H2もカードも無い場合は columns が空のまま返り、loadMarkdown 側で
      // 「カンバン化できる要素が見つかりません」エラーが表示される。
    } else {
      // H2が1つでもあれば、H2より前に積まれた箇条書きは「未分類」列として先頭に追加
      if (unsortedColumn && unsortedColumn.cards.length > 0) {
        result.columns.unshift(unsortedColumn);
      }
    }

    // 厳密モード（スイムレーン）:
    //   - frontmatter に `lanes:` キーが**有る**場合のみスイムレーンモード。
    //   - lanes: の出現順がそのままレーン表示順。末尾に「未分類」レーン（name=''）を1つ固定で持つ。
    //   - 未列挙 lane 名は「未分類」へ寄せる（card.lane を '' に正規化）。
    //   - frontmatter に `lanes:` キーが**無い**場合は通常モード。buildCard が #lane/X を通常タグ扱いする。
    if (result.hasLanesKey) {
      const lanesList = (result.lanesWhitelist || []).map((name, i) => ({ id: `lane-${i}`, name }));
      lanesList.push({ id: 'lane-default', name: '' });
      result.lanes = lanesList;
      const validNames = new Set(lanesList.map(l => l.name).filter(n => n !== ''));
      result.columns.forEach(col => col.cards.forEach(c => {
        if (c.lane && !validNames.has(c.lane)) {
          c.lane = '';
        }
      }));
      result.useSwimlanes = true;
    } else {
      result.lanes = [];
      result.useSwimlanes = false;
    }

    assignIds(result);
    return result;
  }

  /**
   * 列・カードに連番IDを振る。永続化はしないが、DnDのドロップ時に
   * カードを一意に識別するために使う（再パース毎に振り直す）。
   */
  function assignIds(board) {
    cardIdCounter = 0;
    board.columns.forEach((col, ci) => {
      col.id = `col-${ci}`;
      col.cards.forEach((card) => {
        cardIdCounter += 1;
        card.id = `c-${cardIdCounter}`;
      });
    });
  }

  /**
   * YAML スカラー値の安全な書き出し。`[A-Za-z0-9_\-...]+` で構成された lane 名はクォート不要。
   * 予約文字（`:` `#` `-` 先頭, `'`, `"`, `[`, `]`, `{`, `}`, `,`, `&`, `*`, `!`, `|`, `>`, `?`, `%`, `@`, `\``）
   * を含む場合のみダブルクォートで囲む。レーン名のバリデーションが効いている前提で
   * MVP では基本的にクォート不要だが、保険として実装しておく。
   */
  function yamlScalarValue(s) {
    if (s === '' ) return '""';
    const needsQuote = /^[\s\-?:,\[\]\{\}#&*!|>'"%@`]|[:#]\s|[\r\n]/.test(s);
    if (!needsQuote) return s;
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  /**
   * board を Markdown 文字列に再シリアライズする。
   * 完全保証: frontmatter / H1 / H2 / チェック状態 / #tag / @日付 / サブタスク
   * ベストエフォート: bodyParts段落の空行数、コードブロック内の空白構造。
   */
  function serializeBoard(board) {
    const out = [];
    // 1) frontmatter を再構築する。
    //    - lanes: 以外の他キーは otherFrontmatterRaw（入力時の行順）をそのまま貼り戻す
    //    - lanes: は board.lanes（未分類レーンを除く）の順序通りにブロックスタイルで末尾に追記する
    //    - lanes: が空 → lanes: キーごと省略
    //    - 他キーも空 & lanes: も無し → frontmatter ブロックごと省略
    const otherRaw = (board.otherFrontmatterRaw || '').replace(/\s+$/, ''); // 末尾空白除去
    const realLanes = (board.lanes || []).filter(l => l.name !== '');
    const hasLanes = !!board.hasLanesKey && realLanes.length > 0;
    const otherLines = otherRaw ? otherRaw.split('\n') : [];
    if (otherLines.length > 0 || hasLanes) {
      out.push('---\n');
      if (otherLines.length > 0) {
        out.push(otherLines.join('\n'));
        out.push('\n');
      }
      if (hasLanes) {
        out.push('lanes:\n');
        for (const lane of realLanes) {
          out.push(`  - ${yamlScalarValue(lane.name)}\n`);
        }
      }
      out.push('---\n\n');
    }
    // 2) H1（ボードタイトル）
    if (board.title) {
      out.push(`# ${board.title}\n\n`);
    }
    // 3) 列
    board.columns.forEach((col, colIdx) => {
      out.push(`## ${col.name}\n\n`);
      col.cards.forEach((card) => {
        // 箇条書き先頭。チェックボックスの有無はcard.checkedで分岐
        let prefix;
        if (card.checked === true) prefix = '- [x] ';
        else if (card.checked === false) prefix = '- [ ] ';
        else prefix = '- ';
        // titleはタグ・期限のメタ表記を含む原文を保持している。
        // - スイムレーンモード: `#lane/X` は DnD で書き換わるので既存の `#lane/...` を全削除し、
        //   card.lane が lanes: ホワイトリストに在れば末尾に付け直す。「未分類」（lane=''）の場合は付けない。
        // - 通常モード: `#lane/X` は通常タグとして card.title に含まれているのでそのまま貼り戻す。
        let serializedTitle = card.title;
        if (board.useSwimlanes) {
          const laneStripRe = new RegExp(`(?:^|\\s)#lane\\/[${LANE_NAME_CHARS}]+(?:\\/[${LANE_NAME_CHARS}]+)*`, 'g');
          serializedTitle = serializedTitle.replace(laneStripRe, ' ').replace(/\s+/g, ' ').trim();
          if (card.lane) {
            serializedTitle = serializedTitle ? `${serializedTitle} #lane/${card.lane}` : `#lane/${card.lane}`;
          }
        }
        out.push(`${prefix}${serializedTitle}\n`);

        // サブタスク（2スペースインデント）
        card.subtasks.forEach((s) => {
          const sp = s.checked ? '- [x] ' : '- [ ] ';
          out.push(`  ${sp}${s.title}\n`);
        });

        // bodyParts（段落・コード等）— 各パートを2スペースインデントし、段落間に空行を1個だけ入れる。
        // ※ 末尾には空行を出さない（下の連続改行整形に任せる）。これにより
        //   bodyParts→次のカード／列の間に空行が二重化するのを防ぐ。
        card.bodyParts.forEach((part, idx) => {
          const indented = part.split('\n').map((ln) => ln.length ? `  ${ln}` : '').join('\n');
          out.push(`${indented}\n`);
          // 同一カード内で次の bodyPart があれば、その間に1空行を入れる
          if (idx < card.bodyParts.length - 1) {
            out.push('\n');
          }
        });
      });
      // 列末尾の空行
      if (colIdx < board.columns.length - 1) {
        out.push('\n');
      }
    });

    // 連続改行を最大2個（=空行1個）までに切り詰める。
    // bodyParts の有無や末尾改行の重なりで「\n\n\n+」が出ても安定させるための保険。
    const joined = out.join('');
    return joined.replace(/\n{3,}/g, '\n\n');
  }

  // -------- レンダリング --------

  function classifyDue(dateStr) {
    if (!dateStr) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(dateStr + 'T00:00:00');
    if (isNaN(target.getTime())) return null;
    if (target.getTime() < today.getTime()) return 'overdue';
    if (target.getTime() === today.getTime()) return 'today';
    return 'future';
  }

  function buildBadgeHtml(card) {
    const parts = [];
    // 期限
    if (card.dueDate) {
      const cls = classifyDue(card.dueDate);
      if (cls) {
        parts.push(`<span class="badge due-${cls}" title="期限: ${escapeHtml(card.dueDate)}">📅 ${escapeHtml(card.dueDate)}</span>`);
      }
    }
    // サブタスク進捗
    if (card.subtasks.length > 0) {
      const done = card.subtasks.filter(s => s.checked).length;
      parts.push(`<span class="badge subtask" title="サブタスク進捗">☑ ${done}/${card.subtasks.length}</span>`);
    }
    // タグ
    for (const tag of card.tags) {
      parts.push(`<button type="button" class="badge tag" data-tag="${escapeHtml(tag)}" aria-label="タグ #${escapeHtml(tag)} で絞り込む">#${escapeHtml(tag)}</button>`);
    }
    return parts.join('');
  }

  function renderBoard() {
    const board = state.board;
    if (!board) return;

    // タイトル
    els.boardTitle.textContent = board.title || '';

    // 統計
    let totalCards = 0;
    let visibleCards = 0;
    for (const col of board.columns) {
      totalCards += col.cards.length;
      for (const c of col.cards) {
        if (matchesFilter(c)) visibleCards++;
      }
    }
    if (state.activeTagFilter) {
      els.boardStats.textContent = `${board.columns.length}列・${visibleCards}枚を表示中（全${totalCards}枚中・タグ #${state.activeTagFilter} でフィルタ）`;
    } else {
      els.boardStats.textContent = `${board.columns.length}列・${totalCards}枚を表示中`;
    }

    // 警告は初回パース時だけ出す（フィルタ等の再描画時には重複させない）
    if (board.warnings && board.warnings.length > 0 && !board._warningsShown) {
      for (const w of board.warnings) {
        showStatus(w, 'warning', false);
      }
      board._warningsShown = true;
    }

    // ボードのレイアウトモードに応じて描画分岐:
    //   - 通常モード（useSwimlanes=false）: 列を横に並べる従来表示
    //   - スイムレーンモード: 行=lane × 列の 2D グリッド
    els.kanbanBoard.innerHTML = '';
    if (board.useSwimlanes) {
      els.kanbanBoard.classList.add('has-swimlanes');
      els.kanbanBoard.style.setProperty('--mdkanban-cols', String(board.columns.length));
      renderSwimlaneBoard(board);
      return;
    }

    els.kanbanBoard.classList.remove('has-swimlanes');
    els.kanbanBoard.style.removeProperty('--mdkanban-cols');
    board.columns.forEach((col, colIdx) => {
        const colEl = document.createElement('div');
        colEl.className = 'kanban-column';
        colEl.setAttribute('role', 'listitem');
        colEl.dataset.colIndex = String(colIdx);

        const header = document.createElement('div');
        header.className = 'kanban-column-header';
        const colCount = col.cards.filter(c => matchesFilter(c)).length;
        header.innerHTML = `<span class="kanban-column-title">${escapeHtml(col.name)}</span><span class="kanban-column-count">${colCount}</span>`;
        colEl.appendChild(header);

        const cardsWrap = document.createElement('div');
        cardsWrap.className = 'kanban-column-cards';
        cardsWrap.dataset.colIndex = String(colIdx);

        col.cards.forEach((card, cardIdx) => {
          if (!matchesFilter(card)) return;
          const cardEl = createCardElement(card, colIdx, cardIdx);
          cardsWrap.appendChild(cardEl);
        });

        // DnD: 列のカード領域をドロップ受け付け対象に
        attachColumnDnDHandlers(cardsWrap);

      colEl.appendChild(cardsWrap);
      // 列末尾に「+ カード追加」ボタン
      colEl.appendChild(createAddCardButton(colIdx, null));
      els.kanbanBoard.appendChild(colEl);
    });
    // 通常モードでも「+ レーン追加」エントリポイントを末尾に配置（F8-A-2）。
    // クリック時に lanes: キーが新規生成され、スイムレーンモードへ切り替わる。
    els.kanbanBoard.appendChild(renderAddLaneControl());
  }

  /** カード DOM を1枚生成して返す（通常／スイムレーン両モードで共通利用） */
  function createCardElement(card, colIdx, cardIdx) {
    const cardEl = document.createElement('article');
    cardEl.className = 'kanban-card';
    if (card.checked === true) cardEl.classList.add('is-done');
    cardEl.setAttribute('tabindex', '0');
    cardEl.setAttribute('role', 'button');
    cardEl.setAttribute('aria-label', `カード: ${card.displayTitle || card.title}（ドラッグ可能）`);
    cardEl.setAttribute('draggable', 'true');
    cardEl.dataset.cardId = card.id;
    cardEl.dataset.colIndex = String(colIdx);
    cardEl.dataset.cardIndex = String(cardIdx);

    const titleEl = document.createElement('p');
    titleEl.className = 'kanban-card-title';
    titleEl.textContent = card.displayTitle || card.title;
    cardEl.appendChild(titleEl);

    // 編集・削除アクション（hover/focusで可視化、タッチデバイスでは常時表示）
    const actionsEl = document.createElement('div');
    actionsEl.className = 'card-actions';
    // 編集ボタン
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'card-action-btn is-edit';
    editBtn.setAttribute('aria-label', `カード「${card.displayTitle || card.title || '無題'}」を編集`);
    editBtn.title = '編集';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      startInlineEdit(card.id, false);
    });
    editBtn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        ev.stopPropagation();
        startInlineEdit(card.id, false);
      }
    });
    // 削除ボタン
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'card-action-btn is-delete';
    delBtn.setAttribute('aria-label', `カード「${card.displayTitle || card.title || '無題'}」を削除`);
    delBtn.title = '削除';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      requestDeleteCard(card.id);
    });
    delBtn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        ev.stopPropagation();
        requestDeleteCard(card.id);
      }
    });
    actionsEl.appendChild(editBtn);
    actionsEl.appendChild(delBtn);
    cardEl.appendChild(actionsEl);

    if (card.bodyParts.length > 0) {
      const previewEl = document.createElement('p');
      previewEl.className = 'kanban-card-preview';
      const firstPara = card.bodyParts.join(' ').replace(/\s+/g, ' ').trim();
      previewEl.textContent = firstPara.slice(0, 120);
      cardEl.appendChild(previewEl);
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'kanban-card-meta';
    metaEl.innerHTML = buildBadgeHtml(card);
    cardEl.appendChild(metaEl);

    metaEl.querySelectorAll('.badge.tag').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        applyTagFilter(btn.getAttribute('data-tag'));
      });
      btn.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          ev.stopPropagation();
          applyTagFilter(btn.getAttribute('data-tag'));
        }
      });
    });

    cardEl.addEventListener('click', (ev) => {
      // DnDの直後（dragend から 120ms 以内）または現在ドラッグ中の click は誤発火とみなして抑止。
      if (state.dragging || (suppressClickUntil && performance.now() < suppressClickUntil)) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      openCardModal(card);
    });
    cardEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openCardModal(card);
      }
    });

    attachCardDnDHandlers(cardEl);
    return cardEl;
  }

  /**
   * スイムレーンモードの描画。
   *   - 上段: 列ヘッダ行（左端は空セル「swimlane-corner」）
   *   - 各 lane ごとに `.swimlane > .swimlane-header + .swimlane-row` を出力
   *   - `.swimlane-row` 内の各セル `.kanban-column-cards` には data-col-index と data-lane を付与し、
   *     既存の attachColumnDnDHandlers をそのまま使い回す
   *   - 末尾に「+ レーン追加」コントロール（F8-A）を配置
   */
  function renderSwimlaneBoard(board) {
    // 上段: 列ヘッダ行（lane ラベル列ぶんの空セル + 各列ヘッダ）
    const headerRow = document.createElement('div');
    headerRow.className = 'kanban-column-headers';
    headerRow.setAttribute('role', 'presentation');
    const corner = document.createElement('div');
    corner.className = 'swimlane-corner';
    corner.setAttribute('aria-hidden', 'true');
    headerRow.appendChild(corner);
    board.columns.forEach((col, colIdx) => {
      const header = document.createElement('div');
      header.className = 'kanban-column-header';
      header.dataset.colIndex = String(colIdx);
      const colCount = col.cards.filter(c => matchesFilter(c)).length;
      header.innerHTML = `<span class="kanban-column-title">${escapeHtml(col.name)}</span><span class="kanban-column-count">${colCount}</span>`;
      headerRow.appendChild(header);
    });
    els.kanbanBoard.appendChild(headerRow);

    // 各 lane の行を描画。「未分類」レーンは該当カード0件なら省略。
    const realLanes = board.lanes.filter(l => l.name !== '');
    const defaultLane = board.lanes.find(l => l.name === '');
    const defaultLaneCardCount = defaultLane
      ? board.columns.reduce((s, col) => s + col.cards.filter(c => c.lane === '' && matchesFilter(c)).length, 0)
      : 0;

    realLanes.forEach((lane, laneIdx) => {
      els.kanbanBoard.appendChild(renderSwimlaneRow(board, lane, laneIdx, realLanes.length));
    });
    if (defaultLane && defaultLaneCardCount > 0) {
      els.kanbanBoard.appendChild(renderSwimlaneRow(board, defaultLane, realLanes.length, realLanes.length));
    }

    // 「+ レーン追加」コントロール（F8-A）
    els.kanbanBoard.appendChild(renderAddLaneControl());
  }

  /**
   * 1 レーン分の `.swimlane` DOM を生成して返す。
   * @param {object} board
   * @param {{id:string, name:string}} lane
   * @param {number} laneIdx 表示順 index（real lanes 内）。未分類レーンは realLanes.length が渡る。
   * @param {number} realLaneCount 「未分類」を除いたレーン数（並び替え可否判定用）
   */
  function renderSwimlaneRow(board, lane, laneIdx, realLaneCount) {
    const laneName = lane.name;
    const isDefault = laneName === '';
    const laneDisplay = isDefault ? DEFAULT_LANE_DISPLAY_NAME : laneName;

    // この lane に属するカード総数（フィルタ後）
    let laneCardCount = 0;
    board.columns.forEach(col => {
      col.cards.forEach(c => {
        if (c.lane === laneName && matchesFilter(c)) laneCardCount++;
      });
    });

    const swimlaneEl = document.createElement('div');
    swimlaneEl.className = 'swimlane';
    swimlaneEl.dataset.laneName = laneName;
    if (isDefault) swimlaneEl.classList.add('is-default-lane');
    if (state.collapsedLanes.has(laneName)) {
      swimlaneEl.classList.add('is-collapsed');
    }

    // === レーンヘッダ（折りたたみ＋管理 UI） ===
    const headerEl = document.createElement('div');
    headerEl.className = 'swimlane-header';
    headerEl.setAttribute('aria-label', `${laneDisplay} レーン`);
    if (!isDefault) {
      // 並び替え用 DnD: 「未分類」以外のみ。.swimlane[data-lane-name] 全体に対し draggable を立てる。
      headerEl.setAttribute('draggable', 'true');
      headerEl.classList.add('is-draggable');
      attachLaneHeaderDnDHandlers(headerEl, laneName, laneIdx);
    }

    // 折りたたみトグル
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'swimlane-collapse-btn';
    toggleBtn.setAttribute('aria-expanded', state.collapsedLanes.has(laneName) ? 'false' : 'true');
    toggleBtn.setAttribute('aria-label', `${laneDisplay} レーンの折りたたみを切替`);
    toggleBtn.innerHTML = `<span class="swimlane-toggle" aria-hidden="true">▼</span><span class="swimlane-name">${escapeHtml(laneDisplay)}</span><span class="swimlane-count">${laneCardCount}</span>`;
    toggleBtn.addEventListener('click', () => toggleLaneCollapsed(laneName, swimlaneEl, toggleBtn));
    toggleBtn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggleLaneCollapsed(laneName, swimlaneEl, toggleBtn);
      }
    });
    // ダブルクリックでレーン名インライン編集（F8-D）
    if (!isDefault) {
      toggleBtn.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        startLaneRename(laneName);
      });
    }
    headerEl.appendChild(toggleBtn);

    // 管理アクション群（並び替え矢印 / 編集 / 削除）— 「未分類」には付けない
    if (!isDefault) {
      const actions = document.createElement('div');
      actions.className = 'swimlane-actions';

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'swimlane-action-btn is-up';
      upBtn.setAttribute('aria-label', `${laneDisplay} レーンを上に移動`);
      upBtn.title = '上に移動';
      upBtn.textContent = '▲';
      upBtn.disabled = (laneIdx <= 0);
      upBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        moveLane(laneName, -1);
      });

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'swimlane-action-btn is-down';
      downBtn.setAttribute('aria-label', `${laneDisplay} レーンを下に移動`);
      downBtn.title = '下に移動';
      downBtn.textContent = '▼';
      downBtn.disabled = (laneIdx >= realLaneCount - 1);
      downBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        moveLane(laneName, +1);
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'swimlane-action-btn is-edit';
      editBtn.setAttribute('aria-label', `${laneDisplay} レーンの名前を変更`);
      editBtn.title = 'レーン名を変更';
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        startLaneRename(laneName);
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'swimlane-action-btn is-delete';
      delBtn.setAttribute('aria-label', `${laneDisplay} レーンを削除`);
      delBtn.title = 'レーンを削除';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        requestDeleteLane(laneName);
      });

      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      headerEl.appendChild(actions);
    }
    swimlaneEl.appendChild(headerEl);

    // 行（lane × 列ぶんのセル）
    const row = document.createElement('div');
    row.className = 'swimlane-row';
    board.columns.forEach((col, colIdx) => {
      const cellWrap = document.createElement('div');
      cellWrap.className = 'swimlane-cell';

      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'kanban-column-cards';
      cardsWrap.dataset.colIndex = String(colIdx);
      cardsWrap.dataset.lane = laneName;

      col.cards.forEach((card, cardIdx) => {
        if (card.lane !== laneName) return;
        if (!matchesFilter(card)) return;
        const cardEl = createCardElement(card, colIdx, cardIdx);
        cardsWrap.appendChild(cardEl);
      });

      attachColumnDnDHandlers(cardsWrap);
      cellWrap.appendChild(cardsWrap);
      cellWrap.appendChild(createAddCardButton(colIdx, laneName));
      row.appendChild(cellWrap);
    });
    swimlaneEl.appendChild(row);
    return swimlaneEl;
  }

  /**
   * 「+ レーン追加」コントロール（F8-A）。クリックでインライン入力欄を表示し、
   * 確定で lanes: 配列末尾にレーンを追加する。frontmatter に `lanes:` キーが無いファイルでも
   * このボタン経由で初回追加すると lanes: が新規生成される（=スイムレーンモード有効化）。
   */
  function renderAddLaneControl() {
    const wrap = document.createElement('div');
    wrap.className = 'swimlane-add-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swimlane-add-btn';
    btn.textContent = '+ レーン追加';
    btn.setAttribute('aria-label', 'スイムレーンを追加');
    btn.addEventListener('click', () => showAddLaneForm(wrap, btn));
    wrap.appendChild(btn);
    return wrap;
  }

  /**
   * 「+ カード追加」ボタンを生成して返す。
   * lane が null（=通常モード or lane 未指定）なら lane 情報は付けない。
   */
  function createAddCardButton(colIdx, laneName) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-card-btn';
    btn.textContent = '+ カード追加';
    const colName = state.board && state.board.columns[colIdx] ? state.board.columns[colIdx].name : '';
    const laneLabel = (laneName === null || laneName === undefined)
      ? ''
      : (laneName === '' ? `（${DEFAULT_LANE_DISPLAY_NAME} レーン）` : `（${laneName} レーン）`);
    btn.setAttribute('aria-label', `${colName} 列${laneLabel} にカードを追加`);
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      addNewCard(colIdx, laneName);
    });
    return btn;
  }

  // -------- レーン管理 UI（F8-A〜F8-D） --------

  /** lane 名のバリデーション。空白・特殊文字を弾く。OK なら true。 */
  function isValidLaneName(name) {
    if (!name) return false;
    const re = new RegExp(`^[${LANE_NAME_CHARS}]+$`);
    return re.test(name);
  }

  /**
   * 「+ レーン追加」ボタンをインライン入力欄に差し替え、確定で lanes: 配列末尾にレーンを追加する。
   * frontmatter に `lanes:` キーが無いファイルでも初回追加で hasLanesKey=true に切替える（=スイムレーンモード有効化）。
   * @param {HTMLElement} wrap 元のラッパー DOM。確定後はレンダリング全体が再生成される。
   * @param {HTMLButtonElement} btn 元のボタン
   */
  function showAddLaneForm(wrap, btn) {
    btn.hidden = true;
    const form = document.createElement('div');
    form.className = 'swimlane-add-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'swimlane-add-input';
    input.maxLength = 64;
    input.placeholder = 'レーン名（例: バックエンド）';
    input.setAttribute('aria-label', '追加するレーン名');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn small';
    ok.textContent = '追加';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn small secondary';
    cancel.textContent = 'キャンセル';
    const errMsg = document.createElement('span');
    errMsg.className = 'swimlane-add-error';
    errMsg.setAttribute('aria-live', 'polite');

    const actionsRow = document.createElement('div');
    actionsRow.className = 'swimlane-add-form-actions';
    actionsRow.appendChild(ok);
    actionsRow.appendChild(cancel);

    form.appendChild(input);
    form.appendChild(errMsg);
    form.appendChild(actionsRow);
    wrap.appendChild(form);
    setTimeout(() => input.focus(), 0);

    function close() {
      form.remove();
      btn.hidden = false;
    }

    function commit() {
      const name = input.value.trim();
      if (!isValidLaneName(name)) {
        errMsg.textContent = 'レーン名は英数字／日本語のみ・空白不可で入力してください';
        return;
      }
      if (!state.board) return;
      const existing = (state.board.lanes || []).map(l => l.name);
      if (existing.includes(name)) {
        errMsg.textContent = 'すでに存在するレーン名です';
        return;
      }
      addLane(name);
      // addLane が renderBoard で UI を作り直すためフォームDOMごと消える。明示的な close() は不要。
    }

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      }
    });
    ok.addEventListener('click', commit);
    cancel.addEventListener('click', close);
  }

  /**
   * lanes: 配列末尾にレーンを追加する。lanes: キーが無いファイルでは新規生成（=スイムレーンモード有効化）する。
   */
  function addLane(name) {
    const board = state.board;
    if (!board) return;
    const wasSwimlane = !!board.useSwimlanes;
    const wasLegacy = !board.hasLanesKey;
    if (!board.hasLanesKey) {
      // 新規スイムレーン化: lanes 配列を初期化（未分類レーンも追加）
      board.lanes = [{ id: 'lane-default', name: '' }];
      board.hasLanesKey = true;
      // 既存カードは全て「未分類」（card.lane='') に既定。通常モードでは card.lane は '' になっている前提。
      board.columns.forEach(col => col.cards.forEach(c => { if (typeof c.lane !== 'string') c.lane = ''; }));
    }
    // 末尾の「未分類」レーンの直前に挿入する
    const insertIdx = board.lanes.findIndex(l => l.name === '');
    const newLane = { id: `lane-${Date.now()}`, name };
    if (insertIdx === -1) {
      board.lanes.push(newLane);
      board.lanes.push({ id: 'lane-default', name: '' });
    } else {
      board.lanes.splice(insertIdx, 0, newLane);
    }
    board.useSwimlanes = true;

    // legacy→swimlane 昇格時は、既存カードの tags/displayTitle/lane を swimlane モードで再パースし直す。
    // 元 title の `#lane/X` は swimlane モードではタグ扱いから除外され displayTitle からも消える（AC31）。
    // ただし `lanes:` には自動追記しない（AC60）ため、新規追加レーンに無い `#lane/X` を持つカードは
    // `card.lane=''`（未分類）に集約される。
    if (wasLegacy) {
      const validLaneNameSet = new Set((board.lanes || []).map(l => l.name).filter(n => n !== ''));
      board.columns.forEach(col => col.cards.forEach(c => {
        const meta = reparseTitleMeta(c.title, true);
        c.tags = meta.tags;
        c.displayTitle = meta.displayTitle;
        c.dueDate = meta.dueDate;
        c.lane = (meta.lane && validLaneNameSet.has(meta.lane)) ? meta.lane : '';
      }));
    }

    reserializeAndPersist();
    markDirty();
    renderBoard();
    announceDnd(`レーン「${name}」を追加しました${wasSwimlane ? '' : '（スイムレーンを有効化）'}`);
    triggerAutoSave();
  }

  /** レーン名変更（F8-D）のインライン編集を開始 */
  function startLaneRename(oldName) {
    if (!oldName || !state.board) return;
    const swimlaneEl = document.querySelector(`.swimlane[data-lane-name="${cssEscape(oldName)}"]`);
    if (!swimlaneEl) return;
    const nameSpan = swimlaneEl.querySelector('.swimlane-name');
    const collapseBtn = swimlaneEl.querySelector('.swimlane-collapse-btn');
    if (!nameSpan || !collapseBtn) return;

    // 既存テキストを input に置き換え。collapse ボタンのクリックを抑止するため、
    // 編集中は collapseBtn を無効化する。
    collapseBtn.disabled = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'swimlane-rename-input';
    input.value = oldName;
    input.maxLength = 64;
    input.setAttribute('aria-label', `${oldName} レーンの新しい名前`);
    nameSpan.replaceWith(input);
    setTimeout(() => { input.focus(); input.select(); }, 0);

    let finished = false;
    function commit(toFinalize) {
      if (finished) return;
      const newName = input.value.trim();
      if (!toFinalize) { // cancel
        finished = true;
        renderBoard();
        return;
      }
      if (newName === oldName) {
        finished = true;
        renderBoard();
        return;
      }
      if (!isValidLaneName(newName)) {
        // バリデーション失敗時はそのまま編集継続（フォーカスを戻す）。
        // （アラートは煩雑なのでトースト相当で簡易通知）
        showToast('レーン名は英数字／日本語のみ・空白不可で入力してください', 'error');
        return;
      }
      const existing = (state.board.lanes || []).map(l => l.name);
      if (existing.includes(newName)) {
        showToast('すでに存在するレーン名です', 'error');
        return;
      }
      finished = true;
      renameLane(oldName, newName);
    }
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        commit(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        commit(false);
      }
    });
    input.addEventListener('blur', () => commit(true));
  }

  /** lanes: 配列内の oldName を newName に置換し、所属カードの `#lane/<旧>` も書き換える */
  function renameLane(oldName, newName) {
    const board = state.board;
    if (!board) return;
    const lane = (board.lanes || []).find(l => l.name === oldName);
    if (!lane) return;
    lane.name = newName;
    // 所属カードの lane と title 内の `#lane/<旧>` を一括置換
    const pattern = new RegExp(`(^|\\s)#lane\\/${escapeRegExp(oldName)}(?=$|\\s)`, 'g');
    board.columns.forEach(col => col.cards.forEach(c => {
      if (c.lane === oldName) {
        c.title = c.title.replace(pattern, `$1#lane/${newName}`);
        // title が変わったので UI 用メタを再計算。lane は newName を確定で再代入する。
        const meta = reparseTitleMeta(c.title, true);
        c.displayTitle = meta.displayTitle;
        c.tags = meta.tags;
        c.dueDate = meta.dueDate;
        c.lane = newName;
      }
    }));
    reserializeAndPersist();
    markDirty();
    renderBoard();
    announceDnd(`レーン「${oldName}」を「${newName}」に名前変更しました`);
    triggerAutoSave();
  }

  /** レーン削除リクエスト（確認ダイアログを経て削除を実行） */
  function requestDeleteLane(name) {
    const board = state.board;
    if (!board) return;
    let count = 0;
    board.columns.forEach(col => col.cards.forEach(c => { if (c.lane === name) count++; }));
    const ok = window.confirm(`レーン「${name}」を削除します。所属する ${count} 件のカードは「未分類」レーンに移動されます。よろしいですか？`);
    if (!ok) return;
    deleteLane(name);
  }

  /** 確認後の削除実行。lanes: 配列から除去 + カードタイトルから #lane/<削除名> 除去 + カードを未分類へ。 */
  function deleteLane(name) {
    const board = state.board;
    if (!board) return;
    const idx = board.lanes.findIndex(l => l.name === name);
    if (idx === -1) return;
    let count = 0;
    const stripRe = new RegExp(`(^|\\s)#lane\\/${escapeRegExp(name)}(?:\\/[${LANE_NAME_CHARS}]+)*(?=$|\\s)`, 'g');
    board.columns.forEach(col => col.cards.forEach(c => {
      if (c.lane === name) {
        c.lane = '';
        c.title = c.title.replace(stripRe, '$1').replace(/\s+/g, ' ').trim();
        // displayTitle / tags / dueDate は title が変わったので再計算
        const meta = reparseTitleMeta(c.title, true);
        c.displayTitle = meta.displayTitle;
        c.tags = meta.tags;
        c.dueDate = meta.dueDate;
        count++;
      }
    }));
    board.lanes.splice(idx, 1);

    // realLanes が0件になったら lanes: キーごと削除して従来モードへ戻す
    const remainingReal = board.lanes.filter(l => l.name !== '');
    if (remainingReal.length === 0) {
      board.hasLanesKey = false;
      board.lanes = [];
      board.useSwimlanes = false;
      // すべてのカードを通常モードに正規化（lane='' 維持）。
      // タグ抽出は通常モードロジックで再計算する必要があるため、card.title から再パースし直す。
      board.columns.forEach(col => col.cards.forEach(c => {
        const meta = reparseTitleMeta(c.title, false);
        c.lane = '';
        c.tags = meta.tags;
        c.displayTitle = meta.displayTitle;
        c.dueDate = meta.dueDate;
      }));
    }

    reserializeAndPersist();
    markDirty();
    renderBoard();
    announceDnd(`レーン「${name}」を削除しました（${count} 件のカードを未分類に移動）`);
    triggerAutoSave();
  }

  /** lanes: 配列内のレーンを delta（-1=上 / +1=下）方向へ並び替え。「未分類」は末尾固定。 */
  function moveLane(name, delta) {
    const board = state.board;
    if (!board) return;
    const realLanes = board.lanes.filter(l => l.name !== '');
    const idx = realLanes.findIndex(l => l.name === name);
    if (idx === -1) return;
    const next = idx + delta;
    if (next < 0 || next >= realLanes.length) return;
    // realLanes 内で並び替えてから、末尾に未分類を戻す
    const moved = realLanes.splice(idx, 1)[0];
    realLanes.splice(next, 0, moved);
    const defaultLane = board.lanes.find(l => l.name === '');
    board.lanes = defaultLane ? [...realLanes, defaultLane] : realLanes;
    reserializeAndPersist();
    markDirty();
    renderBoard();
    announceDnd(`レーン「${name}」を ${delta < 0 ? '上' : '下'} に移動しました`);
    triggerAutoSave();
  }

  // -------- レーンヘッダ DnD（F8-C 並び替え） --------
  let laneDragging = null; // { name, fromIdx }

  function attachLaneHeaderDnDHandlers(headerEl, laneName, laneIdx) {
    headerEl.addEventListener('dragstart', (ev) => {
      laneDragging = { name: laneName, fromIdx: laneIdx };
      headerEl.classList.add('is-dragging-lane');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', `lane:${laneName}`);
      } catch (e) { /* noop */ }
      // カード DnD と区別するため state.dragging はセットしない
      ev.stopPropagation();
    });
    headerEl.addEventListener('dragend', () => {
      headerEl.classList.remove('is-dragging-lane');
      document.querySelectorAll('.swimlane.is-lane-drop-target').forEach(n => n.classList.remove('is-lane-drop-target'));
      laneDragging = null;
    });
    headerEl.addEventListener('dragover', (ev) => {
      if (!laneDragging) return;
      // 「未分類」ヘッダはドロップ対象から除外（未分類は末尾固定）
      const targetSwimlane = headerEl.closest('.swimlane');
      if (!targetSwimlane || targetSwimlane.classList.contains('is-default-lane')) return;
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.dataTransfer.dropEffect = 'move'; } catch (e) { /* noop */ }
      document.querySelectorAll('.swimlane.is-lane-drop-target').forEach(n => n.classList.remove('is-lane-drop-target'));
      targetSwimlane.classList.add('is-lane-drop-target');
    });
    headerEl.addEventListener('drop', (ev) => {
      if (!laneDragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      const fromName = laneDragging.name;
      const targetSwimlane = headerEl.closest('.swimlane');
      if (!targetSwimlane || targetSwimlane.classList.contains('is-default-lane')) return;
      const toName = targetSwimlane.dataset.laneName;
      if (fromName === toName) return;
      reorderLaneByDnD(fromName, toName);
    });
  }

  /** DnD で fromName レーンを toName レーンの位置に並び替える */
  function reorderLaneByDnD(fromName, toName) {
    const board = state.board;
    if (!board) return;
    const realLanes = board.lanes.filter(l => l.name !== '');
    const fromIdx = realLanes.findIndex(l => l.name === fromName);
    const toIdx = realLanes.findIndex(l => l.name === toName);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = realLanes.splice(fromIdx, 1);
    realLanes.splice(toIdx, 0, moved);
    const defaultLane = board.lanes.find(l => l.name === '');
    board.lanes = defaultLane ? [...realLanes, defaultLane] : realLanes;
    reserializeAndPersist();
    markDirty();
    renderBoard();
    announceDnd(`レーン「${fromName}」の位置を変更しました`);
    triggerAutoSave();
  }

  /** 正規表現の特殊文字をエスケープ */
  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** CSS attribute selector 用エスケープ（簡易版） */
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  /** lane ヘッダの折りたたみ状態をトグルし、LocalStorage へ保存する */
  function toggleLaneCollapsed(laneName, swimlaneEl, headerBtn) {
    if (state.collapsedLanes.has(laneName)) {
      state.collapsedLanes.delete(laneName);
      swimlaneEl.classList.remove('is-collapsed');
      headerBtn.setAttribute('aria-expanded', 'true');
    } else {
      state.collapsedLanes.add(laneName);
      swimlaneEl.classList.add('is-collapsed');
      headerBtn.setAttribute('aria-expanded', 'false');
    }
    try {
      localStorage.setItem(STORAGE_KEYS.collapsedLanes, JSON.stringify([...state.collapsedLanes]));
    } catch (e) { /* クォータ超過は握りつぶす */ }
  }

  function matchesFilter(card) {
    if (!state.activeTagFilter) return true;
    return card.tags.includes(state.activeTagFilter);
  }

  function applyTagFilter(tag) {
    state.activeTagFilter = tag;
    els.tagFilterBar.hidden = false;
    els.activeTagDisplay.textContent = `#${tag}`;
    renderBoard();
  }

  function clearTagFilter() {
    state.activeTagFilter = null;
    els.tagFilterBar.hidden = true;
    els.activeTagDisplay.textContent = '';
    renderBoard();
  }

  // -------- カード詳細モーダル --------
  function buildCardMarkdownForModal(card) {
    let md = '';
    // 表示タイトル（メタ無し）はモーダルヘッダーで表示するので本文には含めない
    if (card.bodyParts.length > 0) {
      md += card.bodyParts.join('\n\n') + '\n\n';
    }
    if (card.subtasks.length > 0) {
      md += '\n**サブタスク**\n\n';
      for (const s of card.subtasks) {
        md += `- [${s.checked ? 'x' : ' '}] ${s.title}\n`;
      }
    }
    return md;
  }

  function openCardModal(card) {
    state.lastFocusBeforeModal = document.activeElement;
    state.currentModalCard = card;
    // モーダルは常に閲覧モードで開く（編集モードはユーザー操作で切替）
    setModalEditMode(false);
    renderModalView(card);
    els.cardModal.hidden = false;
    setTimeout(() => els.cardModalClose.focus(), 0);
    document.addEventListener('keydown', handleModalKeydown);
  }

  /** モーダル本文（閲覧モード）を card の内容で描画する */
  function renderModalView(card) {
    els.cardModalTitle.textContent = card.displayTitle || card.title || '無題';
    const md = buildCardMarkdownForModal(card);
    let bodyHtml = '';
    if (md.trim()) {
      try {
        const rawHtml = window.marked.parse(md, { gfm: true, breaks: false });
        bodyHtml = window.DOMPurify.sanitize(rawHtml, {
          USE_PROFILES: { html: true },
          ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpeg|gif|svg\+xml|webp);)/i
        });
      } catch (e) {
        bodyHtml = `<p>${escapeHtml(md)}</p>`;
      }
    } else {
      bodyHtml = '<p style="color:var(--gray-text-color)">（このカードには詳細情報がありません）</p>';
    }
    els.cardModalBody.innerHTML = bodyHtml;
    els.cardModalBody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.disabled = true;
    });
    const meta = document.createElement('div');
    meta.className = 'card-modal-meta';
    meta.innerHTML = buildBadgeHtml(card);
    meta.querySelectorAll('.badge.tag').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        applyTagFilter(btn.getAttribute('data-tag'));
        closeCardModal();
      });
    });
    els.cardModalBody.insertBefore(meta, els.cardModalBody.firstChild);
  }

  /**
   * モーダルの編集／閲覧モードを切り替える。
   *   editMode=true  : 編集フォームを出し、閲覧本文を隠す
   *   editMode=false : 閲覧本文を出し、編集フォームを隠す
   */
  function setModalEditMode(editMode) {
    if (els.cardModalEditForm) els.cardModalEditForm.hidden = !editMode;
    if (els.cardModalBody) els.cardModalBody.hidden = !!editMode;
    if (els.cardModalViewActions) els.cardModalViewActions.hidden = !!editMode;
    if (els.cardModalEditActions) els.cardModalEditActions.hidden = !editMode;
    if (els.cardModalEditBtn) els.cardModalEditBtn.hidden = !!editMode;
  }

  /** モーダル編集モードへ入る。card のタイトル／本文／サブタスクを編集フォームに流し込む。 */
  function enterModalEditMode() {
    const card = state.currentModalCard;
    if (!card) return;
    state.editing = { cardId: card.id, mode: 'modal' };
    // 背面カードの DnD を抑止（F9-8 / AC49）
    setCardDraggable(card.id, false);
    if (els.cmeTitle) els.cmeTitle.value = card.title || '';
    if (els.cmeBody) els.cmeBody.value = (card.bodyParts && card.bodyParts.length)
      ? card.bodyParts.join('\n\n')
      : '';
    rebuildSubtaskEditList(card.subtasks || []);
    setModalEditMode(true);
    setTimeout(() => { if (els.cmeTitle) els.cmeTitle.focus(); }, 0);
  }

  /** モーダル編集モードを破棄して閲覧モードへ戻す（変更は反映しない）。 */
  function cancelModalEditMode() {
    const cardId = state.editing && state.editing.cardId;
    state.editing = null;
    if (cardId) setCardDraggable(cardId, true);
    setModalEditMode(false);
  }

  /** 該当 cardId のカード DOM の draggable 属性と is-editing クラスを切り替える。 */
  function setCardDraggable(cardId, draggable) {
    const cardEl = document.querySelector(`.kanban-card[data-card-id="${cardId}"]`);
    if (!cardEl) return;
    cardEl.setAttribute('draggable', draggable ? 'true' : 'false');
    cardEl.classList.toggle('is-editing', !draggable);
  }

  /** モーダル編集モードの変更内容を確定して board へ反映、再描画＆自動保存する。 */
  function commitModalEditMode() {
    // 防御: 編集モードでないときは何もしない（CSSバグ等で誤って保存ボタンが
    // 押されても、空の cme-* フォーム値で既存カードを上書きしないようにする）
    if (!state.editing || state.editing.mode !== 'modal') return;
    const card = state.currentModalCard;
    if (!card) return;
    const loc = findCardLocation(card.id);
    if (!loc) {
      cancelModalEditMode();
      return;
    }
    const newTitle = (els.cmeTitle ? els.cmeTitle.value : card.title)
      .replace(/[\r\n]+/g, ' ')
      .trim();
    // タイトルが空でも編集確定は受け入れる（既存カードを誤って消さないため）。
    // 厳密モード: タイトルに `#lane/新規` が含まれていても lanes: ホワイトリストに自動追記しない。
    // reparseCardMetaFromTitle 側で未列挙 lane は '' に正規化される（カードは「未分類」へ集約される）。
    reparseCardMetaFromTitle(loc.card, newTitle, loc.card.checked);

    // 本文（Markdown）を bodyParts に再構築。空行2つ以上で段落分割（パーサ互換）。
    const rawBody = (els.cmeBody ? els.cmeBody.value : '').replace(/\r\n/g, '\n').trim();
    if (rawBody === '') {
      loc.card.bodyParts = [];
    } else {
      // 空行（連続する \n）で段落単位に分割
      loc.card.bodyParts = rawBody.split(/\n\s*\n+/).map(p => p.replace(/\s+$/, ''));
    }

    // サブタスク
    const subtaskRows = els.cmeSubtasks ? els.cmeSubtasks.querySelectorAll('.cme-subtask-row') : [];
    const newSubtasks = [];
    subtaskRows.forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      const txt = row.querySelector('input[type="text"]');
      const title = (txt ? txt.value : '').trim();
      if (title === '') return; // 空テキストの行は破棄
      newSubtasks.push({ title, checked: !!(cb && cb.checked) });
    });
    loc.card.subtasks = newSubtasks;

    state.editing = null;
    reserializeAndPersist();
    markDirty();
    renderBoard();
    // 閲覧モードに戻して、変更後の card を描画し直す
    state.currentModalCard = loc.card;
    setModalEditMode(false);
    renderModalView(loc.card);
    triggerAutoSave();
  }

  /** モーダル編集モードのサブタスクリストを再構築 */
  function rebuildSubtaskEditList(subtasks) {
    if (!els.cmeSubtasks) return;
    els.cmeSubtasks.innerHTML = '';
    subtasks.forEach(s => addSubtaskRow(s.title, s.checked));
  }

  function addSubtaskRow(title, checked) {
    if (!els.cmeSubtasks) return null;
    const li = document.createElement('li');
    li.className = 'cme-subtask-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.setAttribute('aria-label', 'サブタスクのチェック状態');
    const txt = document.createElement('input');
    txt.type = 'text';
    txt.value = title || '';
    txt.placeholder = 'サブタスクのテキスト';
    txt.setAttribute('aria-label', 'サブタスクのテキスト');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cme-subtask-remove';
    del.textContent = '削除';
    del.setAttribute('aria-label', 'このサブタスクを削除');
    del.addEventListener('click', () => {
      li.remove();
    });
    li.appendChild(cb);
    li.appendChild(txt);
    li.appendChild(del);
    els.cmeSubtasks.appendChild(li);
    return li;
  }

  function closeCardModal() {
    // 編集モードのままモーダル外クリック等で閉じた場合は変更を破棄し、
    // 背面カードの draggable を必ず復元する（F9-8 / AC49）
    if (state.editing && state.editing.mode === 'modal') {
      setCardDraggable(state.editing.cardId, true);
      state.editing = null;
    }
    els.cardModal.hidden = true;
    els.cardModalBody.innerHTML = '';
    setModalEditMode(false);
    state.currentModalCard = null;
    document.removeEventListener('keydown', handleModalKeydown);
    if (state.lastFocusBeforeModal && typeof state.lastFocusBeforeModal.focus === 'function') {
      state.lastFocusBeforeModal.focus();
    }
  }

  function handleModalKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      // 編集モード中は編集破棄のみ、閲覧モードならモーダル閉じる
      if (state.editing && state.editing.mode === 'modal') {
        cancelModalEditMode();
      } else {
        closeCardModal();
      }
    }
  }

  // -------- ファイル読み込み --------
  function readFile(file) {
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      showStatus('ファイルサイズが上限を超えています（5MBまで）', 'error');
      return;
    }
    if (file.size === 0) {
      showStatus('ファイルが空です', 'error');
      return;
    }
    const lower = (file.name || '').toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.markdown')) {
      showStatus('拡張子が .md / .markdown ではありません。テキストとして読み込みます。', 'warning');
    }

    const reader = new FileReader();
    reader.onerror = () => {
      showStatus('テキストファイルとして読み込めませんでした', 'error');
    };
    reader.onload = () => {
      const text = reader.result;
      if (typeof text !== 'string') {
        showStatus('テキストファイルとして読み込めませんでした', 'error');
        return;
      }
      // 非FSA経路（input[type=file]・通常ドロップ）で開いた場合は
      // fileHandle を持ち越さないため、loadMarkdown のデフォルト動作（=null）に任せる。
      loadMarkdown(text, file.name || '');
    };
    reader.readAsText(file, 'UTF-8');
  }

  /**
   * Markdownを読み込んでカンバン描画する。
   *
   * **重要**: 別ファイル（サンプル/復元/別の通常ファイル）由来のテキストを既存のFSAハンドル付きで
   * 上書きしてしまう誤動作を防ぐため、デフォルトで state.fileHandle を null にクリアする。
   * FSA経由でハンドル付きで開く場合のみ、第3引数 { fileHandle } を渡して再代入する。
   *
   * @param {string} text Markdown 本文
   * @param {string} fileName 表示用ファイル名
   * @param {object} [opts]
   * @param {FileSystemFileHandle|null} [opts.fileHandle=null] FSA経由のハンドル。指定しなければハンドル無効化
   */
  function loadMarkdown(text, fileName, opts) {
    clearStatus();
    state.activeTagFilter = null;
    els.tagFilterBar.hidden = true;
    els.activeTagDisplay.textContent = '';

    if (text == null || text.trim() === '') {
      // ハンドルが残ったままだと「保存」で空ファイルが上書きされかねないのでここでも明示クリア
      state.fileHandle = null;
      updateSaveControlsVisibility();
      showStatus('ファイルが空です', 'error');
      return;
    }

    let board;
    try {
      board = parseKanban(text);
    } catch (e) {
      state.fileHandle = null;
      updateSaveControlsVisibility();
      showStatus('Markdownのパースに失敗しました', 'error');
      return;
    }

    const totalCards = board.columns.reduce((sum, c) => sum + c.cards.length, 0);
    if (board.columns.length === 0 || (totalCards === 0 && board.columns.length === 0)) {
      state.fileHandle = null;
      updateSaveControlsVisibility();
      showStatus('カンバン化できる要素が見つかりません', 'error');
      return;
    }

    // 新しいboard内容に切り替えるタイミングで、原則として fileHandle はクリアする。
    // FSA経由（readFileWithHandle）から呼ばれた場合のみ opts.fileHandle で再代入される。
    const nextHandle = (opts && Object.prototype.hasOwnProperty.call(opts, 'fileHandle'))
      ? opts.fileHandle
      : null;
    state.fileHandle = nextHandle;

    state.board = board;
    state.fileName = fileName;
    state.serializedMarkdown = text;
    els.fileNameDisplay.textContent = fileName ? `📄 ${fileName}` : '';

    // LocalStorage保存
    try {
      localStorage.setItem(STORAGE_KEYS.content, text);
      localStorage.setItem(STORAGE_KEYS.fileName, fileName || '');
    } catch (e) {
      // クォータ超過などは握りつぶして表示は続ける
    }

    els.emptyState.hidden = true;
    els.boardSection.hidden = false;
    els.restoreBanner.hidden = true;

    // 新規ロード時は dirty 状態と自動保存ステータスをリセット
    clearDirty();
    if (state.autoSaveTimer) {
      clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = null;
    }
    if (state.autoSavePendingHide) {
      clearTimeout(state.autoSavePendingHide);
      state.autoSavePendingHide = null;
    }
    setAutoSaveStatus('idle');
    updateSaveControlsVisibility();

    renderBoard();
    showStatus(`${board.columns.length}列・${totalCards}枚を表示中`, 'success');
  }

  function loadSample() {
    // サンプルは「別ファイル」相当。loadMarkdown のデフォルト動作で fileHandle が null 化され、
    // FSAで開いていた本物のファイルにサンプル内容が誤上書きされるリスクを断つ。
    loadMarkdown(SAMPLE_MD, 'サンプル.md');
  }

  // -------- カードDnD（列間移動・列内並び替え） --------

  /** ライブリージョンに通知（読み上げソフト向け） */
  function announceDnd(message) {
    if (els.dndLiveRegion) {
      els.dndLiveRegion.textContent = message;
    }
  }

  /** 列のすべてのドロップインジケーター・ハイライトを除去 */
  function clearAllDropIndicators() {
    document.querySelectorAll('.drop-indicator').forEach(n => n.remove());
    document.querySelectorAll('.kanban-column-cards.is-drop-target').forEach(n => {
      n.classList.remove('is-drop-target');
    });
  }

  /**
   * マウスY座標から、列内カードのどの位置に挿入するかを判定し、
   * 該当位置にドロップインジケーター（横線）を挿入して、絶対位置（=card-index）を返す。
   * 戻り値: { absoluteIndex, beforeEl }（beforeEl は null=末尾）
   * フィルタ中は visible card のみが DOM 上にあるため、絶対位置は data-card-index で読む。
   *
   * ※ スイムレーンモードでは cardsWrapEl 内には「同 lane 同列のカードのみ」が入っており、
   *   data-card-index は元の col.cards 全体の中での絶対 index を保持している。
   *   ここでは「直前のカードの絶対 index」または「末尾を表す擬似値」を返し、
   *   moveCard 側で絶対 index に変換し直す。
   */
  function getDropPosition(cardsWrapEl, mouseY) {
    // ドラッグ中カード自身は判定対象から除外
    const cards = Array.from(cardsWrapEl.querySelectorAll('.kanban-card:not(.is-dragging)'));
    if (cards.length === 0) {
      return { absoluteIndex: getColumnTotalCardCount(cardsWrapEl), beforeEl: null };
    }
    for (const c of cards) {
      const rect = c.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (mouseY < midY) {
        // この visible カードの直前に挿入
        const absIdx = parseInt(c.dataset.cardIndex, 10);
        return { absoluteIndex: absIdx, beforeEl: c };
      }
    }
    // 末尾
    return { absoluteIndex: getColumnTotalCardCount(cardsWrapEl), beforeEl: null };
  }

  /** 列の絶対カード総数（フィルタ中の非表示カード含む） */
  function getColumnTotalCardCount(cardsWrapEl) {
    const colIdx = parseInt(cardsWrapEl.dataset.colIndex, 10);
    if (!state.board || !state.board.columns[colIdx]) return 0;
    return state.board.columns[colIdx].cards.length;
  }

  /** カード自体のDnDイベント */
  function attachCardDnDHandlers(cardEl) {
    cardEl.addEventListener('dragstart', (ev) => {
      const cardId = cardEl.dataset.cardId;
      const fromColIdx = parseInt(cardEl.dataset.colIndex, 10);
      const fromCardIdx = parseInt(cardEl.dataset.cardIndex, 10);
      // スイムレーンモード時は祖先要素から lane 名を取得。通常モードでは null（未使用）。
      const swimlaneAncestor = cardEl.closest('.swimlane');
      const fromLane = swimlaneAncestor ? swimlaneAncestor.dataset.laneName : null;
      state.dragging = { cardId, fromColIdx, fromCardIdx, fromLane };
      cardEl.classList.add('is-dragging');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', cardId);
      } catch (e) { /* IE等対策（実害なし） */ }
    });

    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('is-dragging');
      clearAllDropIndicators();
      state.dragging = null;
      // dragend 直後にブラウザが click を発火させる場合があるため、120ms間 click を抑止する。
      suppressClickUntil = performance.now() + 120;
    });
  }

  /** 列のカード領域側のDnDイベント（dragover/drop/dragleave） */
  function attachColumnDnDHandlers(cardsWrapEl) {
    cardsWrapEl.addEventListener('dragover', (ev) => {
      // カードのDnDのみ受け付ける（ファイルDnDは別系統で扱う）
      if (!state.dragging) return;
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = 'move'; } catch (e) { /* noop */ }

      // 既存インジケーターを一旦除去（複数列にまたがる移動でも整合）
      clearAllDropIndicators();
      cardsWrapEl.classList.add('is-drop-target');

      const { beforeEl } = getDropPosition(cardsWrapEl, ev.clientY);
      const indicator = document.createElement('div');
      indicator.className = 'drop-indicator is-active';
      if (beforeEl) {
        cardsWrapEl.insertBefore(indicator, beforeEl);
      } else {
        cardsWrapEl.appendChild(indicator);
      }
    });

    cardsWrapEl.addEventListener('dragleave', (ev) => {
      // 子要素間の移動でも dragleave は発火するため、関連先が列外かどうかで判定
      if (!state.dragging) return;
      const related = ev.relatedTarget;
      if (related && cardsWrapEl.contains(related)) return;
      cardsWrapEl.classList.remove('is-drop-target');
      cardsWrapEl.querySelectorAll('.drop-indicator').forEach(n => n.remove());
    });

    cardsWrapEl.addEventListener('drop', (ev) => {
      if (!state.dragging) return;
      ev.preventDefault();
      const { absoluteIndex } = getDropPosition(cardsWrapEl, ev.clientY);
      const toColIdx = parseInt(cardsWrapEl.dataset.colIndex, 10);
      // スイムレーンモード時のみ data-lane が付与されている。それ以外は null。
      const toLane = Object.prototype.hasOwnProperty.call(cardsWrapEl.dataset, 'lane')
        ? cardsWrapEl.dataset.lane
        : null;
      const { cardId, fromColIdx, fromCardIdx, fromLane } = state.dragging;
      moveCard(fromColIdx, fromCardIdx, toColIdx, absoluteIndex, cardId, fromLane, toLane);
      clearAllDropIndicators();
      state.dragging = null;
    });
  }

  /**
   * board内でカードを移動する。fromCardIdx は移動前の絶対index、
   * targetIndex は移動先の挿入位置（同列内で前方に挿入する場合の補正を内部で行う）。
   *
   * スイムレーンモードでは fromLane / toLane に lane 名が渡る（通常モードではどちらも null）。
   * - 同 lane 同列の subset から得た targetIndex は、その subset 内での「直前カードの絶対 index」または
   *   末尾を表す擬似値（getColumnTotalCardCount=col.cards.length）になっている。
   *   これを col.cards 全体の絶対 index に変換し直してから splice する。
   * - lane が変わる場合は card.lane を toLane に更新し、未登録 lane なら board.lanes に追加する。
   */
  function moveCard(fromColIdx, fromCardIdx, toColIdx, targetIndex, cardId, fromLane, toLane) {
    const board = state.board;
    if (!board) return;
    const fromCol = board.columns[fromColIdx];
    const toCol = board.columns[toColIdx];
    if (!fromCol || !toCol) return;
    // cardIdで保険的に再特定（DOM側の data-card-index と board の同期ズレを防ぐ）
    let realFromIdx = fromCardIdx;
    if (!fromCol.cards[realFromIdx] || fromCol.cards[realFromIdx].id !== cardId) {
      realFromIdx = fromCol.cards.findIndex(c => c.id === cardId);
      if (realFromIdx < 0) return;
    }
    const [card] = fromCol.cards.splice(realFromIdx, 1);

    // lane が変わる場合は card.lane を更新（serializeBoard 側で `#lane/X` に反映される）。
    // 厳密モード: `lanes:` ホワイトリストに無いレーンへの移動は受け付けず「未分類」（''）扱いにする。
    // 「未分類」レーン（toLane=''）に移動した場合は card.lane='' になり、再シリアライズ時に `#lane/X` が除去される。
    const useSwimlanes = !!board.useSwimlanes;
    if (useSwimlanes && toLane !== null && toLane !== undefined) {
      const validLanes = new Set(board.lanes.map(l => l.name));
      card.lane = validLanes.has(toLane) ? toLane : '';
    }

    // 挿入位置の決定:
    //   - 通常モード: targetIndex は col.cards 全体の絶対 index、従来通り
    //   - スイムレーンモード: targetIndex は「同 lane 同列 subset の中での絶対 index」または
    //     末尾を表す擬似値 (col.cards.length)。
    //     → 同 lane 同列カードの絶対 index 配列を作り、そこから挿入位置を逆引きする。
    let insertAt;
    if (!useSwimlanes || toLane === null || toLane === undefined) {
      insertAt = targetIndex;
      // 同列内で「自分より後」に挿入する場合は、splice済みなのでtargetを-1補正
      if (fromColIdx === toColIdx && targetIndex > realFromIdx) {
        insertAt = targetIndex - 1;
      }
    } else {
      // スイムレーンモード: 同 lane 同列の絶対 index 配列（splice後の状態に基づく）
      const sameLaneAbsIdx = [];
      toCol.cards.forEach((c, i) => {
        if (c.lane === toLane) sameLaneAbsIdx.push(i);
      });
      if (targetIndex >= toCol.cards.length) {
        // 「セル末尾」想定: 同 lane 同列の最後尾の次に挿入
        insertAt = sameLaneAbsIdx.length > 0
          ? sameLaneAbsIdx[sameLaneAbsIdx.length - 1] + 1
          : toCol.cards.length;
      } else {
        // targetIndex は「直前のカード（=その位置のカード）の絶対 index」
        // 同 lane subset 内でその index を探し、見つかればその直前位置に挿入
        const found = sameLaneAbsIdx.indexOf(targetIndex);
        if (found >= 0) {
          insertAt = sameLaneAbsIdx[found];
        } else {
          // フィルタや lane 違いで targetIndex が subset に無い場合のフォールバック:
          // sameLaneAbsIdx の中で targetIndex 以上の最初の要素位置を採用、
          // それも無ければ subset 末尾の次。
          const greater = sameLaneAbsIdx.find(i => i >= targetIndex);
          if (greater !== undefined) {
            insertAt = greater;
          } else {
            insertAt = sameLaneAbsIdx.length > 0
              ? sameLaneAbsIdx[sameLaneAbsIdx.length - 1] + 1
              : toCol.cards.length;
          }
        }
      }
    }
    insertAt = Math.max(0, Math.min(insertAt, toCol.cards.length));
    toCol.cards.splice(insertAt, 0, card);

    // 同 lane に居なくなった lane が空になっても board.lanes は維持する（折りたたみ状態保持等のため）。
    // ただしデフォルトレーン（''）が完全に消えたケースは useSwimlanes 維持のままで問題ない。

    // シリアライズしてLocalStorage反映＋dirty化
    const serialized = serializeBoard(board);
    state.serializedMarkdown = serialized;
    try {
      localStorage.setItem(STORAGE_KEYS.content, serialized);
    } catch (e) { /* クォータ超過は握りつぶす */ }

    markDirty();

    // 再描画
    renderBoard();

    // a11yアナウンス（lane 名が空＝未分類はその表記で読み上げる）
    const title = card.displayTitle || card.title || 'カード';
    const colName = toCol.name;
    let message;
    if (useSwimlanes && toLane !== null && toLane !== undefined) {
      const laneDisplay = toLane === '' ? DEFAULT_LANE_DISPLAY_NAME : toLane;
      // 同 lane 同列内での 1-based 順位を計算
      const orderInLane = toCol.cards
        .slice(0, insertAt + 1)
        .filter(c => c.lane === toLane).length;
      message = `${title} を ${laneDisplay} レーンの ${colName} 列の ${orderInLane} 番目に移動しました`;
    } else {
      message = `${title} を ${colName} 列の ${insertAt + 1} 番目に移動しました`;
    }
    announceDnd(message);

    // FSA ハンドルがあれば自動保存をデバウンス起動
    triggerAutoSave();
  }

  // -------- カード編集（F9）／追加・削除（F10） --------

  /**
   * board 内から cardId に一致するカードを探し、
   * { card, colIdx, cardIdx } を返す。見つからなければ null。
   */
  function findCardLocation(cardId) {
    if (!state.board) return null;
    for (let ci = 0; ci < state.board.columns.length; ci++) {
      const col = state.board.columns[ci];
      for (let ki = 0; ki < col.cards.length; ki++) {
        if (col.cards[ki].id === cardId) {
          return { card: col.cards[ki], colIdx: ci, cardIdx: ki, col };
        }
      }
    }
    return null;
  }

  /**
   * カード単体の生タイトル文字列からメタ情報（lane / tags / dueDate / displayTitle）を再抽出する。
   * モーダル編集確定時にも使う。bodyParts と subtasks は別経路で更新される。
   * 既存 buildCard の lane/tag/displayTitle 抽出ロジックと完全に同じ仕様。
   */
  function reparseCardMetaFromTitle(card, rawTitle, checked) {
    // モード判定: 現在の board に lanes: キーが有るかどうかで `#lane/X` の解釈を切替
    const swimlaneMode = !!(state.board && state.board.hasLanesKey);
    const meta = reparseTitleMeta(rawTitle, swimlaneMode);
    card.title = meta.title;
    card.displayTitle = meta.displayTitle;
    card.tags = meta.tags;
    card.dueDate = meta.dueDate;
    // 厳密モード: 未列挙 lane は「未分類」（''）に正規化する。lanes: は自動追記しない（F8-A 経由のみ）。
    if (swimlaneMode) {
      const validNames = new Set((state.board.lanes || []).map(l => l.name).filter(n => n !== ''));
      card.lane = (meta.lane && validNames.has(meta.lane)) ? meta.lane : '';
    } else {
      // 通常モード: card.lane は使わない（`#lane/X` は通常タグとして tags に含まれている）
      card.lane = '';
    }
    if (typeof checked !== 'undefined') card.checked = checked;
  }

  /**
   * カードのインライン編集を開始する。
   *   - 対象カードのタイトル要素を <textarea> に差し替え、フォーカスを移す
   *   - draggable=false にして DnD と競合しないようにする
   *   - Enter で確定、Esc で破棄、blur でも確定（ただし新規カードかつ空タイトルなら破棄）
   *   - IME 確定 Enter は無視（isComposing 判定）
   */
  function startInlineEdit(cardId, isNew) {
    if (state.editing) {
      // 別カード編集中なら、まず確定して進める
      commitInlineEdit(true);
    }
    const loc = findCardLocation(cardId);
    if (!loc) return;
    const cardEl = document.querySelector(`.kanban-card[data-card-id="${cardId}"]`);
    if (!cardEl) return;
    const titleEl = cardEl.querySelector('.kanban-card-title');
    if (!titleEl) return;

    state.editing = {
      cardId,
      mode: 'inline',
      isNew: !!isNew,
      originalTitle: loc.card.title
    };
    cardEl.classList.add('is-editing');
    cardEl.setAttribute('draggable', 'false');

    // textarea へ差し替え
    const ta = document.createElement('textarea');
    ta.className = 'card-title-edit';
    ta.value = loc.card.title || '';
    ta.rows = 1;
    ta.setAttribute('aria-label', 'カードタイトルを編集');
    ta.dataset.cardId = cardId;
    titleEl.replaceWith(ta);

    // 高さを内容にあわせて調整
    const autoresize = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    };
    autoresize();
    ta.addEventListener('input', autoresize);

    // キー操作。F9-2: Enter は常に確定（Shift+Enter も同様）。タイトルは1行のみで改行不可。
    ta.addEventListener('keydown', (ev) => {
      // IME変換中の Enter は確定しない
      if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        commitInlineEdit(false);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelInlineEdit();
      }
    });
    ta.addEventListener('blur', () => {
      // editing 状態が他経路で解除された場合は何もしない
      if (!state.editing || state.editing.cardId !== cardId) return;
      commitInlineEdit(false);
    });

    // フォーカス＆全選択
    setTimeout(() => {
      ta.focus();
      ta.select();
    }, 0);
  }

  /**
   * インライン編集を確定する。
   *   silent=true なら textarea を取り出さず DOM 状態だけクリアして再描画。
   *   新規カードかつ空タイトルなら破棄（state.board から取り除く）。
   */
  function commitInlineEdit(silent) {
    if (!state.editing || state.editing.mode !== 'inline') return;
    const { cardId, isNew } = state.editing;
    const loc = findCardLocation(cardId);
    if (!loc) {
      state.editing = null;
      return;
    }
    let newTitle = loc.card.title;
    if (!silent) {
      const ta = document.querySelector(`.card-title-edit[data-card-id="${cardId}"]`);
      if (ta) {
        // タイトル内の改行は禁止（MVP仕様）。スペース化する。
        newTitle = ta.value.replace(/[\r\n]+/g, ' ').trim();
      }
    }

    // 新規カードかつ空 → 破棄。addNewCard は永続化していないので
    // dirty 化や自動保存は行わない（state は addNewCard 直前の状態に戻る）
    if (isNew && newTitle === '') {
      loc.col.cards.splice(loc.cardIdx, 1);
      state.editing = null;
      renderBoard();
      return;
    }

    // 通常確定: メタ情報を再抽出して反映。
    // 厳密モード: lanes: ホワイトリスト未列挙の `#lane/X` は自動追記しない（reparseCardMetaFromTitle で正規化）。
    if (newTitle !== loc.card.title) {
      reparseCardMetaFromTitle(loc.card, newTitle, loc.card.checked);
    }
    state.editing = null;
    reserializeAndPersist();
    markDirty();
    renderBoard();
    triggerAutoSave();
  }

  /** インライン編集を破棄して元のタイトルに戻す。 */
  function cancelInlineEdit() {
    if (!state.editing || state.editing.mode !== 'inline') return;
    const { cardId, isNew } = state.editing;
    state.editing = null;
    if (isNew) {
      // 新規カードを破棄。addNewCard は永続化していないので dirty 化はしない。
      const loc = findCardLocation(cardId);
      if (loc) loc.col.cards.splice(loc.cardIdx, 1);
    }
    renderBoard();
  }

  /**
   * 新規カードを colIdx 列（lane 指定があればそのレーン）の末尾に追加し、
   * 即座にインライン編集モードに入る。空タイトルで blur されると破棄される。
   */
  function addNewCard(colIdx, laneName) {
    if (!state.board || !state.board.columns[colIdx]) return;
    // 編集中の他カードがあれば先に確定
    if (state.editing) {
      commitInlineEdit(true);
    }
    cardIdCounter += 1;
    const newCard = {
      id: `c-${cardIdCounter}-new`,
      title: '',
      displayTitle: '',
      checked: false,    // 既定は未完了チェックボックス（- [ ] ...）
      tags: [],
      lane: (laneName === null || laneName === undefined) ? '' : laneName,
      dueDate: null,
      subtasks: [],
      bodyParts: []
    };
    state.board.columns[colIdx].cards.push(newCard);
    // 新規 lane が発生する可能性は無い（既存 lane へ追加）が、useSwimlanes 維持。
    renderBoard();
    // 描画後にその cardId へインライン編集モードを発動
    startInlineEdit(newCard.id, true);
  }

  /** カード削除のリクエスト（確認ダイアログを経て削除を実行）。 */
  function requestDeleteCard(cardId) {
    const loc = findCardLocation(cardId);
    if (!loc) return;
    const title = loc.card.displayTitle || loc.card.title || '無題';
    const ok = window.confirm(`カード「${title}」を削除します。よろしいですか？`);
    if (!ok) return;
    deleteCard(cardId);
  }

  /** 確認後の削除実行。再シリアライズ・自動保存・a11yアナウンスまで行う。 */
  function deleteCard(cardId) {
    const loc = findCardLocation(cardId);
    if (!loc) return;
    const title = loc.card.displayTitle || loc.card.title || '無題';
    loc.col.cards.splice(loc.cardIdx, 1);
    reserializeAndPersist();
    markDirty();
    renderBoard();
    announceDnd(`カード「${title}」を削除しました`);
    triggerAutoSave();
  }

  /** 現在の board をシリアライズして state.serializedMarkdown と localStorage を更新する。 */
  function reserializeAndPersist() {
    if (!state.board) return;
    const md = serializeBoard(state.board);
    state.serializedMarkdown = md;
    try {
      localStorage.setItem(STORAGE_KEYS.content, md);
    } catch (e) { /* クォータ超過は握りつぶす */ }
  }

  // -------- 自動保存（F11） --------

  /**
   * 変更（DnD・編集・追加・削除）から800msデバウンスで自動保存する。
   * - state.fileHandle が無ければ何もしない（手動保存対象外）。
   * - 連続呼び出しは最後の呼び出しから 800ms 後に1回だけ実行。
   */
  function triggerAutoSave() {
    if (!state.fileHandle) return;
    if (state.autoSaveTimer) {
      clearTimeout(state.autoSaveTimer);
    }
    state.autoSaveTimer = setTimeout(() => {
      state.autoSaveTimer = null;
      autoSaveNow();
    }, 800);
  }

  /** 自動保存を即時実行（手動「保存」ボタンや、デバウンス満了時に呼ばれる）。 */
  async function autoSaveNow() {
    if (!state.fileHandle || !state.board) return;
    if (state.autoSavePendingHide) {
      clearTimeout(state.autoSavePendingHide);
      state.autoSavePendingHide = null;
    }
    setAutoSaveStatus('saving');
    try {
      // 権限再要求（初回はユーザー操作が必要）
      if (state.fileHandle.queryPermission) {
        const perm = await state.fileHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted' && state.fileHandle.requestPermission) {
          const req = await state.fileHandle.requestPermission({ mode: 'readwrite' });
          if (req !== 'granted') {
            throw new Error('書き込み権限が拒否されました');
          }
        }
      }
      const writable = await state.fileHandle.createWritable();
      const md = getCurrentMarkdown();
      await writable.write(md);
      await writable.close();
      clearDirty();
      setAutoSaveStatus('saved');
      // 1.5秒後に idle へ戻してインジケーターを隠す
      state.autoSavePendingHide = setTimeout(() => {
        state.autoSavePendingHide = null;
        setAutoSaveStatus('idle');
      }, 1500);
    } catch (e) {
      setAutoSaveStatus('error');
      // エラー時はトーストで案内（dirty フラグは維持）
      showToast('⚠ 保存に失敗しました。手動で「💾 保存」ボタンから再試行できます。', 'error');
      // 権限剥がれ等で継続不能なら fileHandle をクリアし、DL/コピーへフォールバック
      const fatal = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'InvalidStateError');
      if (fatal) {
        state.fileHandle = null;
        updateSaveControlsVisibility();
        // インジケーター非表示
        state.autoSavePendingHide = setTimeout(() => {
          state.autoSavePendingHide = null;
          setAutoSaveStatus('idle');
        }, 2500);
      }
    }
  }

  /** 自動保存ステータスを切り替えてインジケーターに反映 */
  function setAutoSaveStatus(status) {
    state.autoSaveStatus = status;
    const el = els.saveStatus;
    if (!el) return;
    el.classList.remove('is-saving', 'is-saved', 'is-error');
    if (status === 'saving') {
      el.textContent = '💾 保存中…';
      el.classList.add('is-saving');
      el.hidden = false;
    } else if (status === 'saved') {
      el.textContent = '✓ 保存済み';
      el.classList.add('is-saved');
      el.hidden = false;
    } else if (status === 'error') {
      el.textContent = '⚠ 保存失敗';
      el.classList.add('is-error');
      el.hidden = false;
    } else {
      // idle
      el.textContent = '';
      el.hidden = true;
    }
  }

  /** 右下トースト */
  function showToast(message, type) {
    if (!els.toastArea) return;
    const div = document.createElement('div');
    div.className = `toast ${type || ''}`.trim();
    div.textContent = message;
    els.toastArea.appendChild(div);
    setTimeout(() => {
      if (div.parentNode) div.parentNode.removeChild(div);
    }, type === 'error' ? 5000 : 3000);
  }

  // -------- 保存・書き戻し --------

  function markDirty() {
    state.dirty = true;
    if (els.dirtyMarker) els.dirtyMarker.hidden = false;
    updateSaveControlsVisibility();
  }

  function clearDirty() {
    state.dirty = false;
    if (els.dirtyMarker) els.dirtyMarker.hidden = true;
  }

  /** 保存系UI（保存・DL・コピー）の表示制御 */
  function updateSaveControlsVisibility() {
    const hasBoard = !!state.board;
    if (els.downloadBtn) els.downloadBtn.hidden = !hasBoard;
    if (els.copyBtn) els.copyBtn.hidden = !hasBoard;
    // 保存ボタンは FSAサポート＆ハンドル取得済みのみ
    const canSaveInPlace = hasBoard && ('showOpenFilePicker' in window) && !!state.fileHandle;
    if (els.saveBtn) els.saveBtn.hidden = !canSaveInPlace;
  }

  /** Markdownを現在のboardからシリアライズして取得 */
  function getCurrentMarkdown() {
    if (!state.board) return '';
    if (state.serializedMarkdown != null) return state.serializedMarkdown;
    const md = serializeBoard(state.board);
    state.serializedMarkdown = md;
    return md;
  }

  /** ダウンロード（全ブラウザ） */
  function downloadMarkdown() {
    if (!state.board) return;
    const md = getCurrentMarkdown();
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.fileName || 'kanban.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showStatus('Markdownをダウンロードしました', 'success');
  }

  /** クリップボードへコピー（execCommandへフォールバック） */
  async function copyMarkdown() {
    if (!state.board) return;
    const md = getCurrentMarkdown();
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
        ok = true;
      }
    } catch (e) { /* fallthrough */ }
    if (!ok) {
      // フォールバック: 一時textareaに置いてexecCommand('copy')
      const ta = document.createElement('textarea');
      ta.value = md;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch (e) { ok = false; }
      document.body.removeChild(ta);
    }
    if (ok) {
      showStatus('Markdownをクリップボードにコピーしました', 'success');
    } else {
      showStatus('コピーに失敗しました。ダウンロードをご利用ください。', 'error');
    }
  }

  /**
   * File System Access API: 元ファイルへ上書き保存（手動）。
   * デバウンスをスキップして即時実行する。失敗時は autoSaveNow と同じく
   * トースト＆ステータス表示で案内する。
   */
  async function saveToFile() {
    if (!state.fileHandle || !state.board) return;
    // 予約された自動保存があれば前倒しで実行するため一旦キャンセル
    if (state.autoSaveTimer) {
      clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = null;
    }
    await autoSaveNow();
  }

  /** File System Access API でファイルを開く（Chromium系のみ） */
  async function openFileViaPicker() {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'Markdown',
          accept: { 'text/markdown': ['.md', '.markdown'] }
        }],
        multiple: false,
        excludeAcceptAllOption: false
      });
      if (!handle) return;
      const file = await handle.getFile();
      // ハンドルは readFileWithHandle 経由で loadMarkdown に渡し、内部で state.fileHandle に再代入する。
      readFileWithHandle(file, handle);
    } catch (e) {
      // ユーザーがダイアログをキャンセル（AbortError）した場合は何もしない
      if (e && e.name !== 'AbortError') {
        showStatus('ファイルを開けませんでした: ' + (e && e.message ? e.message : e), 'error');
      }
    }
  }

  /**
   * FSA経由のファイルを読み込む。
   * loadMarkdown は既定で fileHandle をクリアするので、引数経由でハンドルを明示的に渡し直す。
   */
  function readFileWithHandle(file, handle) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      showStatus('ファイルサイズが上限を超えています（5MBまで）', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      if (typeof text !== 'string') {
        showStatus('テキストファイルとして読み込めませんでした', 'error');
        return;
      }
      // FSA経路：読み込んだテキストとハンドルをセットでloadMarkdownへ。
      // ハンドルは loadMarkdown 内で state.fileHandle に再代入され、保存ボタンが表示される。
      loadMarkdown(text, file.name || '', { fileHandle: handle || null });
      updateSaveControlsVisibility();
    };
    reader.onerror = () => showStatus('テキストファイルとして読み込めませんでした', 'error');
    reader.readAsText(file, 'UTF-8');
  }

  // -------- ドラッグ&ドロップ --------
  function setupDragDrop() {
    const dz = els.dropzone;

    // ページ全体でデフォルトドロップを抑止
    ['dragover', 'drop'].forEach(ev => {
      window.addEventListener(ev, (e) => {
        // ドロップゾーン外でもファイルドロップを受け付ける
        if (e.target.closest && e.target.closest('input[type="file"]')) return;
        e.preventDefault();
      });
    });

    // ページ全体ドラッグ中はドロップゾーンをハイライト
    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragCounter++;
      dz.classList.add('drag-over');
    });
    window.addEventListener('dragleave', () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) dz.classList.remove('drag-over');
    });
    window.addEventListener('drop', async (e) => {
      dragCounter = 0;
      dz.classList.remove('drag-over');
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      // FSA対応ブラウザはハンドル取得を試みる（失敗してもファイル自体は読み込む）
      let handle = null;
      try {
        if (e.dataTransfer.items && e.dataTransfer.items[0] && e.dataTransfer.items[0].getAsFileSystemHandle) {
          handle = await e.dataTransfer.items[0].getAsFileSystemHandle();
          if (handle && handle.kind !== 'file') handle = null;
        }
      } catch (err) { /* ハンドル取得失敗時は通常のファイル読み込みにフォールバック */ }
      if (handle) {
        try {
          const file = await handle.getFile();
          // ハンドルは readFileWithHandle 経由で loadMarkdown に渡す（先に state.fileHandle を直接代入しない）。
          readFileWithHandle(file, handle);
          return;
        } catch (err) { /* fallthrough */ }
      }
      readFile(e.dataTransfer.files[0]);
    });

    dz.addEventListener('click', () => els.fileInput.click());
    dz.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        els.fileInput.click();
      }
    });
  }

  // -------- テーマ・密度 --------
  function applyTheme(theme) {
    els.body.setAttribute('data-theme', theme);
    els.themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
    els.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'ライトテーマに切替' : 'ダークテーマに切替');
    try { localStorage.setItem(STORAGE_KEYS.theme, theme); } catch (e) { /* noop */ }
  }

  function applyDensity(density) {
    els.body.setAttribute('data-density', density);
    els.densityToggle.textContent = density === 'compact' ? '▦' : '☰';
    els.densityToggle.setAttribute('aria-label', density === 'compact' ? '詳細表示に切替' : 'コンパクト表示に切替');
    els.densityToggle.title = density === 'compact' ? '詳細表示に切替' : 'コンパクト表示に切替';
    try { localStorage.setItem(STORAGE_KEYS.density, density); } catch (e) { /* noop */ }
  }

  function toggleTheme() {
    const cur = els.body.getAttribute('data-theme') || 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }

  function toggleDensity() {
    const cur = els.body.getAttribute('data-density') || 'compact';
    applyDensity(cur === 'compact' ? 'detailed' : 'compact');
  }

  // -------- 復元提案 --------
  function maybeOfferRestore() {
    let saved, savedName;
    try {
      saved = localStorage.getItem(STORAGE_KEYS.content);
      savedName = localStorage.getItem(STORAGE_KEYS.fileName);
    } catch (e) { return; }
    if (!saved || saved.trim() === '') return;

    const label = savedName ? `「${savedName}」` : '前回のファイル';
    document.getElementById('restore-banner-msg').textContent =
      `${label}を復元できます。復元しますか？`;
    els.restoreBanner.hidden = false;

    els.restoreYesBtn.addEventListener('click', () => {
      // 復元バナー経由はFSAハンドル未取得（lastContentが別ファイル由来の可能性あり）。
      // loadMarkdown のデフォルト動作で fileHandle=null となり、保存ボタンは非表示になる。
      loadMarkdown(saved, savedName || '');
    }, { once: true });
    els.restoreNoBtn.addEventListener('click', () => {
      els.restoreBanner.hidden = true;
    }, { once: true });
  }

  // -------- 初期化 --------
  function init() {
    // ライブラリ存在確認
    if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') {
      showStatus('Markdownレンダリング用ライブラリの読み込みに失敗しました。ネットワーク接続をご確認ください。', 'error', false);
    } else {
      // marked: GFMをデフォルトに、生HTMLは出さない（DOMPurifyで再度サニタイズ）
      window.marked.setOptions({
        gfm: true,
        breaks: false,
        headerIds: false,
        mangle: false
      });
    }

    // 設定の復元
    let savedTheme = 'light';
    let savedDensity = 'compact';
    try {
      savedTheme = localStorage.getItem(STORAGE_KEYS.theme) || 'light';
      savedDensity = localStorage.getItem(STORAGE_KEYS.density) || 'compact';
      // スイムレーンの折りたたみ状態を JSON 配列として復元
      const collapsedRaw = localStorage.getItem(STORAGE_KEYS.collapsedLanes);
      if (collapsedRaw) {
        const arr = JSON.parse(collapsedRaw);
        if (Array.isArray(arr)) {
          state.collapsedLanes = new Set(arr.filter(v => typeof v === 'string'));
        }
      }
    } catch (e) { /* noop（不正JSON等は無視して空のまま） */ }
    applyTheme(savedTheme);
    applyDensity(savedDensity);

    // ファイルを開くハンドラ: FSA対応ブラウザは showOpenFilePicker 経由、それ以外は input[type=file]
    function openFileEntry() {
      if ('showOpenFilePicker' in window) {
        openFileViaPicker();
      } else {
        els.fileInput.click();
      }
    }

    // イベント
    els.openFileBtn.addEventListener('click', openFileEntry);
    els.dropzoneOpenBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openFileEntry();
    });
    els.sampleBtn.addEventListener('click', loadSample);
    els.dropzoneSampleBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      loadSample();
    });
    els.fileInput.addEventListener('change', (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (f) readFile(f);
      // 同じファイルを再選択できるようリセット
      ev.target.value = '';
    });

    els.themeToggle.addEventListener('click', toggleTheme);
    els.densityToggle.addEventListener('click', toggleDensity);
    els.clearFilterBtn.addEventListener('click', clearTagFilter);

    // 保存系
    if (els.saveBtn) els.saveBtn.addEventListener('click', saveToFile);
    if (els.downloadBtn) els.downloadBtn.addEventListener('click', downloadMarkdown);
    if (els.copyBtn) els.copyBtn.addEventListener('click', copyMarkdown);

    els.cardModalClose.addEventListener('click', closeCardModal);
    els.cardModalBackdrop.addEventListener('click', closeCardModal);
    if (els.cardModalCloseBtn) els.cardModalCloseBtn.addEventListener('click', closeCardModal);

    // モーダル編集モードの開閉・確定・キャンセル
    if (els.cardModalEditBtn) els.cardModalEditBtn.addEventListener('click', enterModalEditMode);
    if (els.cmeCancelBtn) els.cmeCancelBtn.addEventListener('click', cancelModalEditMode);
    if (els.cmeSaveBtn) els.cmeSaveBtn.addEventListener('click', commitModalEditMode);
    if (els.cmeAddSubtask) els.cmeAddSubtask.addEventListener('click', () => {
      const li = addSubtaskRow('', false);
      const input = li && li.querySelector('input[type="text"]');
      if (input) input.focus();
    });

    // モーダル削除ボタン（閲覧モード時のみ可視）
    if (els.cardModalDeleteBtn) {
      els.cardModalDeleteBtn.addEventListener('click', () => {
        const card = state.currentModalCard;
        if (!card) return;
        const title = card.displayTitle || card.title || '無題';
        const ok = window.confirm(`カード「${title}」を削除します。よろしいですか？`);
        if (!ok) return;
        const cardId = card.id;
        closeCardModal();
        deleteCard(cardId);
      });
    }

    // 未保存変更がある状態でのページ離脱確認
    // F11-6 / AC51: 自動保存が完了して保存済み状態であれば beforeunload は出さない。
    // dirty かつ（自動保存中／自動保存失敗／そもそも自動保存対象外でハンドル無し）のときのみ警告。
    window.addEventListener('beforeunload', (ev) => {
      if (!state.dirty) return;
      // 自動保存が成功直後（saved）なら警告しない
      if (state.autoSaveStatus === 'saved') return;
      ev.preventDefault();
      // 標準のレガシー仕様: returnValue を設定するとブラウザのデフォルト確認ダイアログが出る
      ev.returnValue = '';
    });

    setupDragDrop();
    maybeOfferRestore();
    updateSaveControlsVisibility();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
