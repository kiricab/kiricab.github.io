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
    density: 'mdkanban.density'
  };

  const SAMPLE_MD = `---
kanban-plugin: basic
---

# 春のリリース計画

## TODO

- [ ] ロゴ刷新 #design @2026-05-10
  - [ ] 案出し
  - [ ] レビュー会
- [ ] OGP画像生成 #seo
- [ ] アクセシビリティ点検 #a11y @2026-05-15

## Doing

- [ ] ドキュメント整備 @2026-04-25
  詳細はこちらを参照: [社内Wiki](https://example.com)
- [ ] パフォーマンス計測 #perf

## Done

- [x] 仕様書作成 #planning
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
    cardModalTitle: $('card-modal-title'),
    cardModalBody: $('card-modal-body')
  };

  // -------- 状態 --------
  const state = {
    board: null,         // パース結果
    activeTagFilter: null,
    fileName: '',
    lastFocusBeforeModal: null
  };

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
   * 戻り値: { frontmatter: {...}, body: string }
   */
  function extractFrontmatter(md) {
    const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { frontmatter: {}, body: md };
    const yamlBody = m[1];
    const fm = {};
    yamlBody.split(/\r?\n/).forEach(line => {
      const kv = line.match(/^\s*([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
      if (kv) {
        let val = kv[2].trim();
        // クォートを外す
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        fm[kv[1]] = val;
      }
    });
    return { frontmatter: fm, body: md.slice(m[0].length) };
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
  function parseKanban(md) {
    const { frontmatter, body } = extractFrontmatter(md);
    const lines = body.replace(/\r\n/g, '\n').split('\n');

    const result = {
      title: frontmatter.title || '',
      columns: [],
      warnings: []
    };

    let currentColumn = null;
    /** トップレベルカードの参照スタック。直近の親カード本文行を蓄積する */
    let currentCard = null;
    let currentCardBaseIndent = 0;
    let currentCardBodyLines = [];
    /** H2が1度でも出現したか（フォールバック判定用） */
    let sawH2 = false;
    /** カードに紐付く本文（段落・コード等）の蓄積を flush */
    function flushCardBody() {
      if (currentCard && currentCardBodyLines.length) {
        currentCard.bodyParts.push(currentCardBodyLines.join('\n'));
        currentCardBodyLines = [];
      }
    }

    /** 入力テキストからメタ情報を抽出してカード化 */
    function buildCard(rawTitle, checked) {
      const tags = [];
      const tagRe = /(?:^|\s)#([A-Za-z0-9_\-぀-ヿ㐀-鿿]+)/g;
      let mt;
      while ((mt = tagRe.exec(rawTitle)) !== null) {
        if (!tags.includes(mt[1])) tags.push(mt[1]);
      }
      // @YYYY-MM-DD（最初の1個のみ採用）
      const due = rawTitle.match(/(?:^|\s)@(\d{4}-\d{2}-\d{2})\b/);
      const dueDate = due ? due[1] : null;
      // タイトル文字列はメタ表記もそのまま残す（ユーザーの記述を尊重・モーダルで使用）
      return {
        title: rawTitle.trim(),
        // 表示用クリーンタイトル（タグ・期限を除去）
        displayTitle: rawTitle
          .replace(/(?:^|\s)#[A-Za-z0-9_\-぀-ヿ㐀-鿿]+/g, ' ')
          .replace(/(?:^|\s)@\d{4}-\d{2}-\d{2}\b/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
        checked,
        tags,
        dueDate,
        subtasks: [],
        bodyParts: [] // 後で詳細用Markdownに結合する素片
      };
    }

    // H2より前の浮いた箇条書きを集める「未分類」列
    let unsortedColumn = null;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const line = rawLine; // 原文を保持
      const trimmed = line.trim();

      // H1 → ボードタイトル
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1 && !line.startsWith('##')) {
        if (!result.title) result.title = h1[1].trim();
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

    return result;
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

    // 列
    els.kanbanBoard.innerHTML = '';
    for (const col of board.columns) {
      const colEl = document.createElement('div');
      colEl.className = 'kanban-column';
      colEl.setAttribute('role', 'listitem');

      const header = document.createElement('div');
      header.className = 'kanban-column-header';
      const colCount = col.cards.filter(c => matchesFilter(c)).length;
      header.innerHTML = `<span class="kanban-column-title">${escapeHtml(col.name)}</span><span class="kanban-column-count">${colCount}</span>`;
      colEl.appendChild(header);

      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'kanban-column-cards';

      for (const card of col.cards) {
        if (!matchesFilter(card)) continue;
        const cardEl = document.createElement('article');
        cardEl.className = 'kanban-card';
        if (card.checked === true) cardEl.classList.add('is-done');
        cardEl.setAttribute('tabindex', '0');
        cardEl.setAttribute('role', 'button');
        cardEl.setAttribute('aria-label', `カード: ${card.displayTitle || card.title}`);

        const titleEl = document.createElement('p');
        titleEl.className = 'kanban-card-title';
        titleEl.textContent = card.displayTitle || card.title;
        cardEl.appendChild(titleEl);

        // 詳細表示モード時の本文プレビュー
        if (card.bodyParts.length > 0) {
          const previewEl = document.createElement('p');
          previewEl.className = 'kanban-card-preview';
          // 最初の段落（または最初の80文字）
          const firstPara = card.bodyParts.join(' ').replace(/\s+/g, ' ').trim();
          previewEl.textContent = firstPara.slice(0, 120);
          cardEl.appendChild(previewEl);
        }

        const metaEl = document.createElement('div');
        metaEl.className = 'kanban-card-meta';
        metaEl.innerHTML = buildBadgeHtml(card);
        cardEl.appendChild(metaEl);

        // タグバッジクリックでフィルタ（カードクリックには伝播させない）
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

        cardEl.addEventListener('click', () => openCardModal(card));
        cardEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            openCardModal(card);
          }
        });

        cardsWrap.appendChild(cardEl);
      }

      colEl.appendChild(cardsWrap);
      els.kanbanBoard.appendChild(colEl);
    }
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
    els.cardModalTitle.textContent = card.displayTitle || card.title;

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

    // メタバッジ（モーダル下部にも掲出したいが、現状は body の上にも入れる）
    // チェックボックスは読み込み専用扱い
    els.cardModalBody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.disabled = true;
    });

    // メタバッジ追加
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

    els.cardModal.hidden = false;
    // フォーカス移動
    setTimeout(() => els.cardModalClose.focus(), 0);
    document.addEventListener('keydown', handleModalKeydown);
  }

  function closeCardModal() {
    els.cardModal.hidden = true;
    els.cardModalBody.innerHTML = '';
    document.removeEventListener('keydown', handleModalKeydown);
    if (state.lastFocusBeforeModal && typeof state.lastFocusBeforeModal.focus === 'function') {
      state.lastFocusBeforeModal.focus();
    }
  }

  function handleModalKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeCardModal();
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
      loadMarkdown(text, file.name || '');
    };
    reader.readAsText(file, 'UTF-8');
  }

  function loadMarkdown(text, fileName) {
    clearStatus();
    state.activeTagFilter = null;
    els.tagFilterBar.hidden = true;
    els.activeTagDisplay.textContent = '';

    if (text == null || text.trim() === '') {
      showStatus('ファイルが空です', 'error');
      return;
    }

    let board;
    try {
      board = parseKanban(text);
    } catch (e) {
      showStatus('Markdownのパースに失敗しました', 'error');
      return;
    }

    const totalCards = board.columns.reduce((sum, c) => sum + c.cards.length, 0);
    if (board.columns.length === 0 || (totalCards === 0 && board.columns.length === 0)) {
      showStatus('カンバン化できる要素が見つかりません', 'error');
      return;
    }

    state.board = board;
    state.fileName = fileName;
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

    renderBoard();
    showStatus(`${board.columns.length}列・${totalCards}枚を表示中`, 'success');
  }

  function loadSample() {
    loadMarkdown(SAMPLE_MD, 'サンプル.md');
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
    window.addEventListener('drop', (e) => {
      dragCounter = 0;
      dz.classList.remove('drag-over');
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
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
    } catch (e) { /* noop */ }
    applyTheme(savedTheme);
    applyDensity(savedDensity);

    // イベント
    els.openFileBtn.addEventListener('click', () => els.fileInput.click());
    els.dropzoneOpenBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      els.fileInput.click();
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

    els.cardModalClose.addEventListener('click', closeCardModal);
    els.cardModalBackdrop.addEventListener('click', closeCardModal);

    setupDragDrop();
    maybeOfferRestore();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
