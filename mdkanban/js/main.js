/* mdkanban — Markdownをカンバンとして表示するビューワー
   外部依存: marked (MIT) / DOMPurify (Apache-2.0 / MPL-2.0)
   すべての処理はブラウザ内で完結。ファイル内容は外部送信しない。 */

import {
  MAX_FILE_SIZE,
  STORAGE_KEYS,
  HIDE_CHECKED_DEFAULT_DAYS,
  HIDE_CHECKED_MAX_DAYS,
  LANE_NAME_CHARS,
  DEFAULT_LANE_DISPLAY_NAME,
  CARD_META_RE,
  AUTOSAVE_DEBOUNCE_MS,
  POST_DND_CLICK_SUPPRESS_MS,
  AUTOSAVE_SAVED_HOLD_MS,
  AUTOSAVE_FATAL_HIDE_MS
} from './constants.js';
import {
  escapeHtml,
  escapeRegExp,
  cssEscape,
  nowLocalTimestamp,
  bumpCardTimestamps,
  formatTimestampLong,
  formatTimestampShort,
  timestampToIsoAttr,
  isCardCheckedHidden,
  indentWidth,
  yamlScalarValue
} from './utils.js';
import { saveHandleToIdb, loadHandleFromIdb, deleteHandleFromIdb } from './idb.js';
import {
  boardState,
  uiState,
  editingState,
  settingsState,
  fileState,
  autosaveState,
  nextCardId,
  resetCardIdCounter
} from './state.js';
import {
  extractFrontmatter,
  reparseTitleMeta,
  parseKanban,
  assignIds,
  serializeBoard,
  buildCardMarkdownForModal
} from './markdown.js';
import { els, showStatus, clearStatus, showToast, announceDnd } from './dom.js';
import {
  applyTheme, applyDensity, toggleTheme, toggleDensity,
  normalizeHideCheckedDays, persistHideCheckedDays, updateHideCheckedToggleLabel,
  openHideCheckedPopover, closeHideCheckedPopover, toggleHideCheckedPopover,
  setupHideCheckedControls
} from './theme.js';
import {
  initAutosave, triggerAutoSave, autoSaveNow,
  setAutoSaveStatus, refreshFileSaveStateUI
} from './autosave.js';

// =====================================================================
// 注: 以下は IIFE を外して main.js に統合した残コード。
// render / dnd / actions / io / events 群は深いセクションマーカーで
// 区切ってある（今後の細粒度モジュール化用）。
// =====================================================================


// IndexedDB ラッパは ./js/idb.js に移動済み（withStore で共通化）。

/**
 * F13: 描画時にカードを「DOM 上で非表示にする」かを総合判定。
 * - 一時 reveal（global / per-column）が立っていれば常に表示
 * - そうでなければ isCardCheckedHidden の結果
 * （state を参照するためここに残す。純粋判定の isCardCheckedHidden は utils.js）
 */
function shouldHideCardByCheck(card, colName) {
  if (uiState.showHiddenGlobal) return false;
  if (colName && uiState.revealedHiddenColumns.has(colName)) return false;
  return isCardCheckedHidden(card, settingsState.hideCheckedAfterDays);
}

// -------- 要素参照は ./js/dom.js に移動済み --------

// -------- 状態 --------
// 状態は ./js/state.js に分離（boardState / uiState / editingState / settingsState / fileState / autosaveState）。
// cardIdCounter も state.js が保持し、`nextCardId()` / `resetCardIdCounter()` で操作する。
// DnD 後 click 抑止のタイムスタンプは editingState.suppressClickUntil に統合した。

// -------- ユーティリティ --------
// 注: escapeHtml / escapeRegExp / cssEscape / タイムスタンプ整形 / indentWidth / yamlScalarValue は
//     ./js/utils.js に移動済み。

/**
 * 通知の単一窓口。すべての成功/警告/エラーは右下の固定トースト領域に出す。
 * インラインの status-area は廃止（描画後にレイアウトシフトを起こすため）。
 * @param {string} message
 * @param {'success'|'warning'|'error'} [type='success']
 * @param {boolean} [autoHide=true] false にすると自動消去しない（パース警告など）
 */
// showStatus / clearStatus / showToast / announceDnd は ./js/dom.js に移動済み

// -------- Markdownパース・シリアライズは ./js/markdown.js に移動済み --------

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
  const board = boardState.current;
  if (!board) return;

  // タイトル
  els.boardTitle.textContent = board.title || '';

  // 統計（F13: hidden カードは「見えている数」から除外し、カラム件数バッジと整合させる）
  let totalCards = 0;
  let visibleCards = 0;
  for (const col of board.columns) {
    totalCards += col.cards.length;
    const colRevealed = uiState.showHiddenGlobal || uiState.revealedHiddenColumns.has(col.name);
    for (const c of col.cards) {
      if (!matchesFilter(c)) continue;
      if (!colRevealed && isCardCheckedHidden(c, settingsState.hideCheckedAfterDays)) continue;
      visibleCards++;
    }
  }
  if (uiState.activeTagFilter) {
    els.boardStats.textContent = `${board.columns.length}列・${visibleCards}枚を表示中（全${totalCards}枚中・タグ #${uiState.activeTagFilter} でフィルタ）`;
  } else {
    els.boardStats.textContent = `${board.columns.length}列・${visibleCards}枚を表示中`;
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
  els.kanbanBoard.style.removeProperty('--mdkanban-col-tracks');
  els.kanbanBoard.style.removeProperty('--mdkanban-add-col-track');
  board.columns.forEach((col, colIdx) => {
      const colEl = document.createElement('div');
      colEl.className = 'kanban-column';
      colEl.setAttribute('role', 'listitem');
      colEl.dataset.colIndex = String(colIdx);
      if (isColumnCollapsed(col.name)) {
        colEl.classList.add('is-collapsed');
      }

      // F1〜F6 対応の共通ヘッダ DOM
      const header = buildColumnHeaderElement(col, colIdx);
      colEl.appendChild(header);

      // 折りたたみ中はカード領域を描画しないが、カードDnDの drop target は本体に置く
      if (isColumnCollapsed(col.name)) {
        const placeholder = document.createElement('div');
        placeholder.className = 'kanban-column-cards-placeholder';
        placeholder.dataset.colIndex = String(colIdx);
        attachCardDropEndOfCellHandlers(placeholder, colIdx, null);
        colEl.appendChild(placeholder);
      }

      if (!isColumnCollapsed(col.name)) {
        const cardsWrap = document.createElement('div');
        cardsWrap.className = 'kanban-column-cards';
        cardsWrap.dataset.colIndex = String(colIdx);

        // F13: タグフィルタ通過カードのうち「checked 自動非表示の本来対象」を数える
        let wouldHideCount = 0;
        col.cards.forEach((card, cardIdx) => {
          if (!matchesFilter(card)) return;
          const wouldHide = isCardCheckedHidden(card, settingsState.hideCheckedAfterDays);
          if (wouldHide) wouldHideCount++;
          // 実描画は reveal 状態と AND を取る
          if (wouldHide && shouldHideCardByCheck(card, col.name)) return;
          const cardEl = createCardElement(card, colIdx, cardIdx);
          if (wouldHide) cardEl.classList.add('is-revealed-hidden');
          cardsWrap.appendChild(cardEl);
        });

        attachColumnDnDHandlers(cardsWrap);
        colEl.appendChild(cardsWrap);
        // F13: hidden 候補が存在するときだけチップを出す。
        //   showHiddenGlobal 中はすべて点線枠で見えているのでチップは出さない（redundant）。
        if (wouldHideCount > 0 && !uiState.showHiddenGlobal) {
          const revealed = uiState.revealedHiddenColumns.has(col.name);
          colEl.appendChild(createHiddenChip(col.name, wouldHideCount, revealed));
        }
        colEl.appendChild(createAddCardButton(colIdx, null));
      }

      els.kanbanBoard.appendChild(colEl);
  });
  // F4: 「+ カラム追加」ボタン
  els.kanbanBoard.appendChild(renderAddColumnControl());
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

  // 編集・削除はカードクリック→モーダルに集約（カード上の per-card アクションは廃止）。
  // 理由: タイトルのみ編集できる ✏️ と業界慣習（Trello/Linear 等）の不整合・タッチでの誤タップ・
  // 視覚ノイズを解消するため。全項目の編集と削除はモーダル内のボタンから行う。

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

  // F12: カード表面の最終更新日時。詳細密度（body[data-density="detailed"]）のときのみ
  //       CSS で表示される。null カードは「—」で出す。
  const tsEl = document.createElement('div');
  tsEl.className = 'kanban-card-timestamp';
  const iso = timestampToIsoAttr(card.updatedAt);
  tsEl.innerHTML = `更新 <time${iso ? ` datetime="${iso}"` : ''}>${escapeHtml(formatTimestampShort(card.updatedAt))}</time>`;
  cardEl.appendChild(tsEl);

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
    if (editingState.dragging || (editingState.suppressClickUntil && performance.now() < editingState.suppressClickUntil)) {
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
  // F1: 折りたたみ状態でも列幅は変えない仕様。全カラムで CSS 変数 --mdkanban-col-expanded-width を参照する
  // （CSS 側で 300px ↔ 260px をメディアクエリで切替）。これにより JS の再描画なしでも
  // ビューポートサイズ変化に追従する。
  const colTracks = board.columns
    .map(() => 'var(--mdkanban-col-expanded-width, 300px)')
    .join(' ');
  els.kanbanBoard.style.setProperty('--mdkanban-col-tracks', colTracks);
  // 「+ カラム追加」ボタン用トラック幅は CSS 側で定義するためインライン指定はしない

  // 上段: 列ヘッダ行（lane ラベル列ぶんの空セル + 各列ヘッダ + 末尾「+ カラム追加」）
  const headerRow = document.createElement('div');
  headerRow.className = 'kanban-column-headers';
  headerRow.setAttribute('role', 'presentation');
  const corner = document.createElement('div');
  corner.className = 'swimlane-corner';
  corner.setAttribute('aria-hidden', 'true');
  headerRow.appendChild(corner);
  board.columns.forEach((col, colIdx) => {
    const header = buildColumnHeaderElement(col, colIdx);
    headerRow.appendChild(header);
  });
  // F4: 列ヘッダ行末尾に「+ カラム追加」ボタン（スイムレーンモード）
  headerRow.appendChild(renderAddColumnControl());
  els.kanbanBoard.appendChild(headerRow);

  // 各 lane の行を描画。未分類レーンは末尾に常時表示する（lanes: 宣言の有無・カード件数に関わらず）。
  // 理由:
  //   - lane タグ無しカードの新規追加 / 既存カードを lane 無しへ戻す DnD の受け皿として常に必要
  //   - 最後の1枚を他レーンへ動かした瞬間に行ごと消える/復活するレイアウトシフトを回避
  //   - 空で邪魔な場合は既存のレーン折りたたみ機能（collapsedLanes）で畳んで永続化できる
  const realLanes = board.lanes.filter(l => l.name !== '');
  const defaultLane = board.lanes.find(l => l.name === '');

  realLanes.forEach((lane, laneIdx) => {
    els.kanbanBoard.appendChild(renderSwimlaneRow(board, lane, laneIdx, realLanes.length));
  });
  if (defaultLane) {
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
  if (uiState.collapsedLanes.has(laneName)) {
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
  toggleBtn.setAttribute('aria-expanded', uiState.collapsedLanes.has(laneName) ? 'false' : 'true');
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

  // F1: 列トラック幅は親 .kanban-board の CSS カスタムプロパティ --mdkanban-col-tracks に
  // renderSwimlaneBoard が設定した値を継承する。インラインで書くとメディアクエリが効かなくなるため避ける。

  // 行（lane × 列ぶんのセル）
  const row = document.createElement('div');
  row.className = 'swimlane-row';

  board.columns.forEach((col, colIdx) => {
    const cellWrap = document.createElement('div');
    cellWrap.className = 'swimlane-cell';
    if (isColumnCollapsed(col.name)) cellWrap.classList.add('is-collapsed');

    // カラム折りたたみ中はカード領域を描画しないが、カードDnDの drop プレースホルダーを置く。
    // セルが属する lane（laneName）を渡し、別 lane から来たカードはこの lane に切り替える。
    if (isColumnCollapsed(col.name)) {
      const placeholder = document.createElement('div');
      placeholder.className = 'kanban-column-cards-placeholder';
      placeholder.dataset.colIndex = String(colIdx);
      placeholder.dataset.lane = laneName;
      attachCardDropEndOfCellHandlers(placeholder, colIdx, laneName);
      cellWrap.appendChild(placeholder);
    }

    if (!isColumnCollapsed(col.name)) {
      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'kanban-column-cards';
      cardsWrap.dataset.colIndex = String(colIdx);
      cardsWrap.dataset.lane = laneName;

      // F13: スイムレーンモードでも同様に hidden 候補を数えてチップを出す。
      //   reveal 状態はカラム単位なので、レーンを跨いで同じ列の全 hidden 候補をカウントする必要がある。
      //   ただし「このセル（lane×col）内で何件か」だけ示すのが直感的なので、セルローカルで数える。
      let wouldHideCount = 0;
      col.cards.forEach((card, cardIdx) => {
        if (card.lane !== laneName) return;
        if (!matchesFilter(card)) return;
        const wouldHide = isCardCheckedHidden(card, settingsState.hideCheckedAfterDays);
        if (wouldHide) wouldHideCount++;
        if (wouldHide && shouldHideCardByCheck(card, col.name)) return;
        const cardEl = createCardElement(card, colIdx, cardIdx);
        if (wouldHide) cardEl.classList.add('is-revealed-hidden');
        cardsWrap.appendChild(cardEl);
      });

      attachColumnDnDHandlers(cardsWrap);
      cellWrap.appendChild(cardsWrap);
      if (wouldHideCount > 0 && !uiState.showHiddenGlobal) {
        const revealed = uiState.revealedHiddenColumns.has(col.name);
        cellWrap.appendChild(createHiddenChip(col.name, wouldHideCount, revealed));
      }
      cellWrap.appendChild(createAddCardButton(colIdx, laneName));
    }
    row.appendChild(cellWrap);
  });
  swimlaneEl.appendChild(row);

  // レーン折りたたみ時の drop 行: 行本体（row）が display:none で隠れるので、
  // 同じ列幅トラックの上に薄い slot を並べる。CSS で .is-collapsed のときだけ可視化される。
  const collapsedRow = document.createElement('div');
  collapsedRow.className = 'swimlane-collapsed-row';
  collapsedRow.setAttribute('aria-hidden', 'true');
  board.columns.forEach((col, colIdx) => {
    const slot = document.createElement('div');
    slot.className = 'swimlane-collapsed-slot';
    slot.dataset.colIndex = String(colIdx);
    slot.dataset.lane = laneName;
    attachCardDropEndOfCellHandlers(slot, colIdx, laneName);
    collapsedRow.appendChild(slot);
  });
  swimlaneEl.appendChild(collapsedRow);

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
  const colName = boardState.current && boardState.current.columns[colIdx] ? boardState.current.columns[colIdx].name : '';
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

/**
 * F13: 「✓ 完了済み N件」チップ。クリックでそのカラムの per-column reveal をトグル。
 *   - revealed=false: 控えめな低コントラスト表示
 *   - revealed=true: 「展開中」アイコン＋ラベル変化（折りたたみ操作になる）
 *   - showHiddenGlobal が ON のときはチップはクリックされても per-column 状態を切替えず、
 *     代わりに「ツールバーの全表示が ON です」を示すツールチップを出す（無効化はしない）。
 */
function createHiddenChip(colName, count, revealed) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kanban-column-hidden-chip';
  if (revealed) btn.classList.add('is-revealed');
  btn.setAttribute('aria-expanded', revealed ? 'true' : 'false');
  btn.setAttribute('aria-label',
    revealed
      ? `完了済みカード ${count} 件を再び隠す`
      : `完了済みカード ${count} 件を表示`);
  const iconSpan = document.createElement('span');
  iconSpan.className = 'kanban-column-hidden-chip-icon';
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.textContent = revealed ? '▲' : '✓';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'kanban-column-hidden-chip-label';
  labelSpan.textContent = revealed
    ? `完了済み ${count} 件を隠す`
    : `完了済み ${count} 件`;
  btn.appendChild(iconSpan);
  btn.appendChild(labelSpan);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (uiState.showHiddenGlobal) {
      // 全表示中は per-column 切替を抑止し、ヒントだけ出す
      btn.title = 'ツールバーの「今だけ全て表示」が ON です';
      return;
    }
    if (uiState.revealedHiddenColumns.has(colName)) {
      uiState.revealedHiddenColumns.delete(colName);
    } else {
      uiState.revealedHiddenColumns.add(colName);
    }
    renderBoard();
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
    if (!boardState.current) return;
    const existing = (boardState.current.lanes || []).map(l => l.name);
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
  const board = boardState.current;
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
  if (!oldName || !boardState.current) return;
  const swimlaneEl = document.querySelector(`.swimlane[data-lane-name="${cssEscape(oldName)}"]`);
  if (!swimlaneEl) return;
  const nameSpan = swimlaneEl.querySelector('.swimlane-name');
  const collapseBtn = swimlaneEl.querySelector('.swimlane-collapse-btn');
  const headerEl = swimlaneEl.querySelector('.swimlane-header');
  if (!nameSpan || !collapseBtn || !headerEl) return;

  // 既存テキストを input に置き換え。collapse ボタンのクリックを抑止するため、
  // 編集中は collapseBtn を無効化する。サイドレール（48px幅）を一時的に拡張するため
  // is-renaming クラスをヘッダに付与し、CSS 側でレール幅を広げて横書き入力欄を表示する。
  collapseBtn.disabled = true;
  headerEl.classList.add('is-renaming');
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
    const existing = (boardState.current.lanes || []).map(l => l.name);
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
  const board = boardState.current;
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
  const board = boardState.current;
  if (!board) return;
  let count = 0;
  board.columns.forEach(col => col.cards.forEach(c => { if (c.lane === name) count++; }));
  const ok = window.confirm(`レーン「${name}」を削除します。所属する ${count} 件のカードは「未分類」レーンに移動されます。よろしいですか？`);
  if (!ok) return;
  deleteLane(name);
}

/** 確認後の削除実行。lanes: 配列から除去 + カードタイトルから #lane/<削除名> 除去 + カードを未分類へ。 */
function deleteLane(name) {
  const board = boardState.current;
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

  // realLanes が0件になったら lanes: キーをファイルから外す（保存時に書き戻されなくなる）。
  // ただし表示上は常にスイムレーン（「未分類」レーン1本のみ）を維持するため、
  // board.lanes は default レーンを残し、useSwimlanes は true のままにする。
  const remainingReal = board.lanes.filter(l => l.name !== '');
  if (remainingReal.length === 0) {
    board.hasLanesKey = false;
    board.lanes = [{ id: 'lane-default', name: '' }];
    // すべてのカードを通常モード相当に正規化（lane='' 維持）。
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
  const board = boardState.current;
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
    // カード DnD と区別するため editingState.dragging はセットしない
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
  const board = boardState.current;
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

/** lane ヘッダの折りたたみ状態をトグルし、LocalStorage へ保存する */
function toggleLaneCollapsed(laneName, swimlaneEl, headerBtn) {
  if (uiState.collapsedLanes.has(laneName)) {
    uiState.collapsedLanes.delete(laneName);
    swimlaneEl.classList.remove('is-collapsed');
    headerBtn.setAttribute('aria-expanded', 'true');
  } else {
    uiState.collapsedLanes.add(laneName);
    swimlaneEl.classList.add('is-collapsed');
    headerBtn.setAttribute('aria-expanded', 'false');
  }
  try {
    localStorage.setItem(STORAGE_KEYS.collapsedLanes, JSON.stringify([...uiState.collapsedLanes]));
  } catch (e) { /* クォータ超過は握りつぶす */ }
}

// ========================================================================
// カラム管理 UI（F1〜F6） — レーン側 (F8-A〜F8-D) と対称構造
// ========================================================================

/** F2: カラム名 colName が自動チェック対象なら true */
function isColumnAutoChecked(colName) {
  if (!boardState.current || !Array.isArray(boardState.current.autoCheckColumns)) return false;
  return boardState.current.autoCheckColumns.includes(colName);
}

/**
 * F2 同期型: 単一カードに対し、所属カラム colName の自動チェック状態を強制反映する。
 * 対象カラム → checked=true、対象外カラム → checked=false。
 * card.checked===null（チェックボックス無し書式）も同期型仕様の自然な帰結として true/false で上書きする。
 */
function syncCardCheckedToColumn(card, colName) {
  if (!card) return;
  card.checked = isColumnAutoChecked(colName);
}

/**
 * F2: 指定カラム配下の全カードの checked を、自動チェック ON/OFF 状態にあわせて一括同期する。
 * F2-A の ON/OFF 切替・F1〜F5 の操作後の防御的再同期にも使う。
 */
function syncColumnAutoCheck(colIdx) {
  if (!boardState.current) return;
  const col = boardState.current.columns[colIdx];
  if (!col) return;
  const target = isColumnAutoChecked(col.name);
  col.cards.forEach(c => {
    // F12: 自動チェック切替で実際に checked が変化したカードのみタイムスタンプを更新する。
    //       無変化のカードまで触らないことで、空ファイルロード後の自動同期等での
    //       不要な dirty 化を避ける（toggleAutoCheckColumn は明示的ユーザー操作）。
    if (c.checked !== target) {
      c.checked = target;
      bumpCardTimestamps(c);
    } else {
      c.checked = target;
    }
  });
}

/** uiState.collapsedColumns を LocalStorage に保存。クォータ超過は握りつぶす。 */
function persistCollapsedColumns() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.collapsedColumns,
      JSON.stringify([...uiState.collapsedColumns])
    );
  } catch (e) { /* noop */ }
}

/** F1: カラム折りたたみのトグル。CSS の状態クラスは renderBoard で再付与するため、ここでは Set 操作のみ。 */
function toggleColumnCollapsed(colName) {
  if (uiState.collapsedColumns.has(colName)) {
    uiState.collapsedColumns.delete(colName);
  } else {
    uiState.collapsedColumns.add(colName);
  }
  persistCollapsedColumns();
  renderBoard();
}

/** F1: 任意カラム名が現在折りたたみ中か */
function isColumnCollapsed(colName) {
  return uiState.collapsedColumns.has(colName);
}

/** カラム名のバリデーション（空・改行・タブ禁止）。レーン名と異なりスペース・記号は許容（F4-3）。 */
function isValidColumnName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed === '') return false;
  if (/[\r\n\t]/.test(name)) return false;
  return true;
}

/** F3: ◀ / ▶ ボタンでカラムを左右に並び替える。delta=-1（左）/ +1（右）。 */
function moveColumn(colName, delta) {
  if (!boardState.current) return;
  const idx = boardState.current.columns.findIndex(c => c.name === colName);
  if (idx === -1) return;
  const next = idx + delta;
  if (next < 0 || next >= boardState.current.columns.length) return;
  const [moved] = boardState.current.columns.splice(idx, 1);
  boardState.current.columns.splice(next, 0, moved);
  reserializeAndPersist();
  markDirty();
  renderBoard();
  announceDnd(`カラム「${colName}」を ${delta < 0 ? '左' : '右'} に移動しました`);
  triggerAutoSave();
}

/** F3: DnD によるカラム並び替え（fromName を toName の位置に挿入）。 */
function reorderColumnByDnD(fromName, toName) {
  if (!boardState.current) return;
  const cols = boardState.current.columns;
  const fromIdx = cols.findIndex(c => c.name === fromName);
  const toIdx = cols.findIndex(c => c.name === toName);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
  const [moved] = cols.splice(fromIdx, 1);
  cols.splice(toIdx, 0, moved);
  const newIdx = boardState.current.columns.findIndex(c => c.name === fromName);
  reserializeAndPersist();
  markDirty();
  renderBoard();
  announceDnd(`カラム「${fromName}」を ${newIdx + 1} 番目に移動しました`);
  triggerAutoSave();
}

/** F4: 末尾にカラムを追加する。重複・空・改行はバリデーション側で弾く想定。 */
function addColumn(name) {
  if (!boardState.current) return;
  if (boardState.current.columns.some(c => c.name === name)) return;
  boardState.current.columns.push({ name, cards: [], id: `col-new-${Date.now()}` });
  reserializeAndPersist();
  markDirty();
  renderBoard();
  announceDnd(`カラム「${name}」を追加しました`);
  triggerAutoSave();
}

/** F6: カラムリネーム本体。auto-check-columns / uiState.collapsedColumns も追従する。 */
function renameColumn(oldName, newName) {
  if (!boardState.current) return;
  if (oldName === newName) return;
  const col = boardState.current.columns.find(c => c.name === oldName);
  if (!col) return;
  if (boardState.current.columns.some(c => c.name === newName)) return;

  col.name = newName;

  // F2-A-7 / F6-7: auto-check-columns 配列内も追従
  if (Array.isArray(boardState.current.autoCheckColumns)) {
    boardState.current.autoCheckColumns = boardState.current.autoCheckColumns.map(n => n === oldName ? newName : n);
  }
  // F6-8: 折りたたみ Set 内も追従
  if (uiState.collapsedColumns.has(oldName)) {
    uiState.collapsedColumns.delete(oldName);
    uiState.collapsedColumns.add(newName);
    persistCollapsedColumns();
  }

  reserializeAndPersist();
  markDirty();
  renderBoard();
  announceDnd(`カラム「${oldName}」を「${newName}」に名前変更しました`);
  triggerAutoSave();
}

/**
 * F5: カラム削除。所属カードがあれば移動先カラムに集約してから除去する。
 * destinationName が null の場合は呼び出し元（モーダル）が決定済み（カード0件のみ）。
 */
function deleteColumn(targetName, destinationName) {
  if (!boardState.current) return;
  const board = boardState.current;
  if (board.columns.length <= 1) return; // 最後のカラムは削除不可（F5-4）
  const targetIdx = board.columns.findIndex(c => c.name === targetName);
  if (targetIdx === -1) return;
  const targetCol = board.columns[targetIdx];
  let movedCount = 0;

  if (destinationName && targetCol.cards.length > 0) {
    const destCol = board.columns.find(c => c.name === destinationName);
    if (!destCol) return;
    // 所属カード全件を移動先末尾に push（card.lane は変更しない＝レーンを保ったまま）
    const cards = targetCol.cards.splice(0, targetCol.cards.length);
    cards.forEach(c => {
      destCol.cards.push(c);
      // F2 同期: 移動先が自動チェック対象なら true、対象外なら false に強制
      c.checked = isColumnAutoChecked(destCol.name);
    });
    movedCount = cards.length;
  }

  // 削除対象カラムを除去
  board.columns.splice(targetIdx, 1);

  // F2-A-8 / F5-9: auto-check-columns から除去。空になればキーごと省略（serializeBoard が判定）
  if (Array.isArray(board.autoCheckColumns)) {
    board.autoCheckColumns = board.autoCheckColumns.filter(n => n !== targetName);
  }

  // F5-5(5): 折りたたみ Set からも除去
  if (uiState.collapsedColumns.has(targetName)) {
    uiState.collapsedColumns.delete(targetName);
    persistCollapsedColumns();
  }

  reserializeAndPersist();
  markDirty();
  renderBoard();
  if (destinationName && movedCount > 0) {
    announceDnd(`カラム「${targetName}」を削除しました（${movedCount} 件のカードを「${destinationName}」に移動）`);
  } else {
    announceDnd(`カラム「${targetName}」を削除しました`);
  }
  triggerAutoSave();
}

/**
 * F2-A: 自動チェック対象カラムのトグル。配列に追加または除去し、所属カードの checked を一括同期。
 */
function toggleAutoCheckColumn(colName) {
  if (!boardState.current) return;
  const board = boardState.current;
  if (!Array.isArray(board.autoCheckColumns)) {
    board.autoCheckColumns = [];
  }
  const idx = board.autoCheckColumns.indexOf(colName);
  if (idx >= 0) {
    board.autoCheckColumns.splice(idx, 1);
  } else {
    board.autoCheckColumns.push(colName);
  }
  // 所属カードの checked を新しい状態にあわせて一括上書き（同期型）
  const colIdx = board.columns.findIndex(c => c.name === colName);
  if (colIdx >= 0) syncColumnAutoCheck(colIdx);
  reserializeAndPersist();
  markDirty();
  renderBoard();
  announceDnd(`カラム「${colName}」の自動チェックを ${idx >= 0 ? 'OFF' : 'ON'} にしました`);
  triggerAutoSave();
}

/** F4: インライン入力フォーム。カラムヘッダ行の末尾に表示する。 */
function showAddColumnForm(wrap, btn) {
  btn.hidden = true;
  const form = document.createElement('div');
  form.className = 'column-add-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'column-add-input';
  input.maxLength = 64;
  input.placeholder = 'カラム名（例: In Progress）';
  input.setAttribute('aria-label', '追加するカラム名');
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn small';
  ok.textContent = '追加';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn small secondary';
  cancel.textContent = 'キャンセル';
  const errMsg = document.createElement('span');
  errMsg.className = 'column-add-error';
  errMsg.setAttribute('aria-live', 'polite');

  const actionsRow = document.createElement('div');
  actionsRow.className = 'column-add-form-actions';
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
    const name = input.value.replace(/[\r\n\t]+/g, ' ').trim();
    if (!isValidColumnName(name)) {
      errMsg.textContent = 'カラム名を入力してください';
      return;
    }
    if (!boardState.current) return;
    if (boardState.current.columns.some(c => c.name === name)) {
      errMsg.textContent = 'すでに存在するカラム名です';
      return;
    }
    addColumn(name);
    // renderBoard 後に DOM ごと差し替わるので close() は不要
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

/** 「+ カラム追加」ボタン＋フォームを内包するラッパ DOM を返す。 */
function renderAddColumnControl() {
  const wrap = document.createElement('div');
  wrap.className = 'column-add-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'column-add-btn';
  btn.textContent = '+ カラム追加';
  btn.setAttribute('aria-label', 'カラムを追加');
  btn.addEventListener('click', () => showAddColumnForm(wrap, btn));
  wrap.appendChild(btn);
  return wrap;
}

/** F6: カラム名インライン編集。折りたたみ中なら編集中だけ一時展開する（AC46）。 */
function startColumnRename(oldName) {
  if (!boardState.current) return;
  const headerEl = document.querySelector(`.kanban-column-header[data-col-name="${cssEscape(oldName)}"]`);
  if (!headerEl) return;

  // 折りたたみ中なら一時的に展開
  const wasCollapsed = uiState.collapsedColumns.has(oldName);
  if (wasCollapsed) {
    uiState.collapsedColumns.delete(oldName);
    // ここでは LocalStorage は触らない（キャンセル時に元に戻すため）
    renderBoard();
    // 描画後の DOM を再取得
    const headerEl2 = document.querySelector(`.kanban-column-header[data-col-name="${cssEscape(oldName)}"]`);
    if (headerEl2) {
      startColumnRenameInternal(oldName, headerEl2, wasCollapsed);
    }
    return;
  }
  startColumnRenameInternal(oldName, headerEl, wasCollapsed);
}

function startColumnRenameInternal(oldName, headerEl, wasCollapsed) {
  const titleEl = headerEl.querySelector('.kanban-column-title');
  if (!titleEl) return;
  headerEl.classList.add('is-renaming');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'column-rename-input';
  input.value = oldName;
  input.maxLength = 64;
  input.setAttribute('aria-label', `${oldName} カラムの新しい名前`);
  titleEl.replaceWith(input);
  setTimeout(() => { input.focus(); input.select(); }, 0);

  let finished = false;
  function commit(toFinalize) {
    if (finished) return;
    const newName = input.value.replace(/[\r\n\t]+/g, ' ').trim();
    if (!toFinalize) {
      // キャンセル: 折りたたみ状態を元に戻して再描画
      finished = true;
      if (wasCollapsed) {
        uiState.collapsedColumns.add(oldName);
        persistCollapsedColumns();
      }
      renderBoard();
      return;
    }
    if (newName === oldName) {
      finished = true;
      if (wasCollapsed) {
        uiState.collapsedColumns.add(oldName);
        persistCollapsedColumns();
      }
      renderBoard();
      return;
    }
    if (!isValidColumnName(newName)) {
      showToast('カラム名は空にできません', 'error');
      return;
    }
    if (boardState.current.columns.some(c => c.name === newName)) {
      showToast('すでに存在するカラム名です', 'error');
      return;
    }
    finished = true;
    // 折りたたみ Set: 旧名で復元する代わりに、renameColumn 内で新名へ移行する
    // wasCollapsed なら、リネーム後の新名で再 add する
    if (wasCollapsed) {
      uiState.collapsedColumns.add(oldName); // renameColumn が拾って oldName→newName に移行する
      persistCollapsedColumns();
    }
    renameColumn(oldName, newName);
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

/**
 * F5: カラム削除リクエスト。所属カード0件なら confirm のみ、1件以上なら専用モーダルを開く。
 */
function requestDeleteColumn(targetName) {
  if (!boardState.current) return;
  if (boardState.current.columns.length <= 1) return; // F5-4 ガード
  const targetCol = boardState.current.columns.find(c => c.name === targetName);
  if (!targetCol) return;
  const cardCount = targetCol.cards.length;
  if (cardCount === 0) {
    const ok = window.confirm(`カラム「${targetName}」を削除します。よろしいですか？`);
    if (!ok) return;
    deleteColumn(targetName, null);
    return;
  }
  openDeleteColumnModal(targetName, cardCount);
}

/** F5: 移動先選択モーダルを表示。フォーカストラップ・Esc・背景クリック対応。 */
function openDeleteColumnModal(targetName, cardCount) {
  if (!boardState.current) return;
  const otherCols = boardState.current.columns.filter(c => c.name !== targetName);
  if (otherCols.length === 0) return; // 念のため

  const lastFocus = document.activeElement;

  // 背景＋ダイアログ
  const overlay = document.createElement('div');
  overlay.className = 'column-delete-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'column-delete-modal-title');

  const backdrop = document.createElement('div');
  backdrop.className = 'column-delete-modal-backdrop';
  overlay.appendChild(backdrop);

  const dialog = document.createElement('div');
  dialog.className = 'column-delete-modal-dialog';

  const titleEl = document.createElement('h2');
  titleEl.id = 'column-delete-modal-title';
  titleEl.className = 'column-delete-modal-title';
  titleEl.textContent = `カラム「${targetName}」を削除`;
  dialog.appendChild(titleEl);

  const desc = document.createElement('p');
  desc.className = 'column-delete-modal-desc';
  desc.textContent = `所属する ${cardCount} 件のカードを別のカラムに移動してから削除します。移動先を選択してください。`;
  dialog.appendChild(desc);

  // 移動先選択 UI（ラジオ）
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'column-delete-modal-radios';
  const legend = document.createElement('legend');
  legend.textContent = '移動先カラム';
  fieldset.appendChild(legend);

  const targetIdx = boardState.current.columns.findIndex(c => c.name === targetName);
  // デフォルト選択: 直前のカラム（先頭なら直後）
  let defaultIdx;
  if (targetIdx > 0) {
    defaultIdx = targetIdx - 1;
  } else {
    defaultIdx = targetIdx + 1;
  }
  const defaultName = boardState.current.columns[defaultIdx] ? boardState.current.columns[defaultIdx].name : otherCols[0].name;

  otherCols.forEach((col) => {
    const label = document.createElement('label');
    label.className = 'column-delete-modal-radio';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'column-delete-destination';
    radio.value = col.name;
    if (col.name === defaultName) radio.checked = true;
    label.appendChild(radio);
    const span = document.createElement('span');
    span.className = 'column-delete-modal-radio-label';
    span.textContent = col.name;
    label.appendChild(span);
    if (isColumnAutoChecked(col.name)) {
      const note = document.createElement('span');
      note.className = 'column-delete-modal-radio-note';
      note.textContent = '※ 自動チェック対象です（移動するカードは [x] になります）';
      label.appendChild(note);
    }
    fieldset.appendChild(label);
  });
  dialog.appendChild(fieldset);

  // フッター
  const footer = document.createElement('div');
  footer.className = 'column-delete-modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn secondary';
  cancelBtn.textContent = 'キャンセル';
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn danger';
  confirmBtn.textContent = '削除して移動';
  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);
  dialog.appendChild(footer);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function close() {
    document.removeEventListener('keydown', onKey);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }
  function confirmDelete() {
    const checked = dialog.querySelector('input[name="column-delete-destination"]:checked');
    if (!checked) return;
    const dest = checked.value;
    close();
    deleteColumn(targetName, dest);
  }
  function onKey(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    } else if (ev.key === 'Enter') {
      // ラジオ上の Enter ではフォーム submit が発生しないので、独自ハンドリング
      if (dialog.contains(document.activeElement) && document.activeElement !== cancelBtn) {
        ev.preventDefault();
        confirmDelete();
      }
    } else if (ev.key === 'Tab') {
      // 簡易フォーカストラップ: 末尾→先頭、先頭→末尾でループ
      const focusables = dialog.querySelectorAll('input, button');
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  }
  backdrop.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', confirmDelete);
  document.addEventListener('keydown', onKey);

  // 初期フォーカス: チェック済みラジオへ
  setTimeout(() => {
    const checked = dialog.querySelector('input[name="column-delete-destination"]:checked');
    if (checked) checked.focus();
    else if (cancelBtn) cancelBtn.focus();
  }, 0);
}

// F3: カラムヘッダ DnD 並び替え用 state（カード DnD・レーン DnD と独立）
let columnDragging = null; // { name, fromIdx }

/** カラムヘッダの DnD イベントを attach する。 */
function attachColumnHeaderDnDHandlers(headerEl, colName, colIdx) {
  headerEl.addEventListener('dragstart', (ev) => {
    // カード／レーンの DnD と区別: 何かしら別の dragging が走っている場合は無視
    if (editingState.dragging || laneDragging) return;
    columnDragging = { name: colName, fromIdx: colIdx };
    headerEl.classList.add('is-dragging-column');
    try {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', `column:${colName}`);
    } catch (e) { /* noop */ }
    ev.stopPropagation();
  });
  headerEl.addEventListener('dragend', () => {
    headerEl.classList.remove('is-dragging-column');
    document.querySelectorAll('.kanban-column-header.is-column-drop-target').forEach(n => n.classList.remove('is-column-drop-target'));
    columnDragging = null;
  });
  headerEl.addEventListener('dragover', (ev) => {
    if (!columnDragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    try { ev.dataTransfer.dropEffect = 'move'; } catch (e) { /* noop */ }
    document.querySelectorAll('.kanban-column-header.is-column-drop-target').forEach(n => n.classList.remove('is-column-drop-target'));
    headerEl.classList.add('is-column-drop-target');
  });
  headerEl.addEventListener('drop', (ev) => {
    if (!columnDragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    const fromName = columnDragging.name;
    const toName = headerEl.dataset.colName;
    if (!toName || fromName === toName) return;
    reorderColumnByDnD(fromName, toName);
  });
}

/**
 * カラムヘッダ DOM を生成する。通常モード／スイムレーンモードで共通利用。
 * - 通常モード: 折りたたみ時はヘッダごと .is-collapsed クラスで縦書き化
 * - スイムレーンモード: 列ヘッダ行の `.kanban-column-header` のみが描画される（カード列はセル側）
 *
 * @param {object} col board.columns[i]
 * @param {number} colIdx 配列インデックス
 * @returns {HTMLElement}
 */
function buildColumnHeaderElement(col, colIdx) {
  const colName = col.name;
  const collapsed = isColumnCollapsed(colName);
  const auto = isColumnAutoChecked(colName);
  // F13: チップに hidden カードは別途まとめて表示するため、件数バッジからは除外する。
  //   ただし global reveal / per-column reveal 中は「いま画面に出ている数」と整合させるため
  //   hidden を加算する（= マッチカード全件）。
  const revealedHere = uiState.showHiddenGlobal || uiState.revealedHiddenColumns.has(colName);
  const visibleCount = col.cards.filter(c => {
    if (!matchesFilter(c)) return false;
    if (revealedHere) return true;
    return !isCardCheckedHidden(c, settingsState.hideCheckedAfterDays);
  }).length;
  const totalCols = boardState.current.columns.length;

  const headerEl = document.createElement('div');
  headerEl.className = 'kanban-column-header';
  headerEl.dataset.colIndex = String(colIdx);
  headerEl.dataset.colName = colName;
  if (collapsed) headerEl.classList.add('is-collapsed');
  if (auto) headerEl.classList.add('is-auto-check');
  // 並び替え用 DnD: カラム数 ≥2 の場合のみ
  if (totalCols >= 2) {
    headerEl.setAttribute('draggable', 'true');
    headerEl.classList.add('is-column-draggable');
    attachColumnHeaderDnDHandlers(headerEl, colName, colIdx);
  }

  // 折りたたみトグル
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'kanban-column-toggle';
  toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggleBtn.setAttribute('aria-label', `${colName} 列の折りたたみを切替`);
  toggleBtn.textContent = collapsed ? '▶' : '▼';
  toggleBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleColumnCollapsed(colName);
  });
  toggleBtn.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      toggleColumnCollapsed(colName);
    }
  });
  headerEl.appendChild(toggleBtn);

  // タイトル span
  const titleEl = document.createElement('span');
  titleEl.className = 'kanban-column-title';
  titleEl.textContent = colName;
  titleEl.setAttribute('title', colName);
  titleEl.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    startColumnRename(colName);
  });
  headerEl.appendChild(titleEl);

  // 自動チェック ON マーカー（メニュー外でも一目で見える表示）
  if (auto) {
    const autoMark = document.createElement('span');
    autoMark.className = 'kanban-column-auto-mark';
    autoMark.setAttribute('aria-hidden', 'true');
    autoMark.textContent = '☑';
    autoMark.title = '自動チェック対象カラム';
    headerEl.appendChild(autoMark);
  }

  // カード件数バッジ
  const countEl = document.createElement('span');
  countEl.className = 'kanban-column-count';
  countEl.textContent = String(visibleCount);
  headerEl.appendChild(countEl);

  // 操作メニュー（◀ ▶ ✎ ☑ 🗑） — レーンの .swimlane-actions と対称
  const actions = document.createElement('div');
  actions.className = 'kanban-column-actions';

  const leftBtn = document.createElement('button');
  leftBtn.type = 'button';
  leftBtn.className = 'kanban-column-action-btn is-left';
  leftBtn.setAttribute('aria-label', `${colName} 列を左に移動`);
  leftBtn.title = '左に移動';
  leftBtn.textContent = '◀';
  leftBtn.disabled = (colIdx <= 0);
  leftBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    moveColumn(colName, -1);
  });

  const rightBtn = document.createElement('button');
  rightBtn.type = 'button';
  rightBtn.className = 'kanban-column-action-btn is-right';
  rightBtn.setAttribute('aria-label', `${colName} 列を右に移動`);
  rightBtn.title = '右に移動';
  rightBtn.textContent = '▶';
  rightBtn.disabled = (colIdx >= totalCols - 1);
  rightBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    moveColumn(colName, +1);
  });

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'kanban-column-action-btn is-edit';
  editBtn.setAttribute('aria-label', `${colName} 列の名前を変更`);
  editBtn.title = '名前を変更';
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    startColumnRename(colName);
  });

  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'kanban-column-action-btn is-auto';
  autoBtn.setAttribute('aria-label', `${colName} 列の自動チェックを切替`);
  autoBtn.setAttribute('aria-pressed', auto ? 'true' : 'false');
  autoBtn.title = auto ? '自動チェック ON（クリックで OFF）' : '自動チェック OFF（クリックで ON）';
  autoBtn.textContent = '☑';
  if (auto) autoBtn.classList.add('is-active');
  autoBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleAutoCheckColumn(colName);
  });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'kanban-column-action-btn is-delete';
  delBtn.setAttribute('aria-label', `${colName} 列を削除`);
  delBtn.title = totalCols <= 1 ? 'カラムは1つ以上必要です' : '削除';
  delBtn.textContent = '🗑';
  delBtn.disabled = (totalCols <= 1);
  delBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    requestDeleteColumn(colName);
  });

  actions.appendChild(leftBtn);
  actions.appendChild(rightBtn);
  actions.appendChild(editBtn);
  actions.appendChild(autoBtn);
  actions.appendChild(delBtn);
  headerEl.appendChild(actions);

  return headerEl;
}

function matchesFilter(card) {
  if (!uiState.activeTagFilter) return true;
  return card.tags.includes(uiState.activeTagFilter);
}

function applyTagFilter(tag) {
  uiState.activeTagFilter = tag;
  els.tagFilterBar.hidden = false;
  els.activeTagDisplay.textContent = `#${tag}`;
  renderBoard();
}

function clearTagFilter() {
  uiState.activeTagFilter = null;
  els.tagFilterBar.hidden = true;
  els.activeTagDisplay.textContent = '';
  renderBoard();
}

// -------- カード詳細モーダル --------
// buildCardMarkdownForModal は ./js/markdown.js に移動済み。

/** card.subtasks からモーダル用のサブタスク section 要素を生成して返す。0件なら null。 */
function buildSubtasksSection(card) {
  if (!card.subtasks || card.subtasks.length === 0) return null;
  const section = document.createElement('div');
  section.className = 'card-modal-subtasks';
  const heading = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = 'サブタスク';
  heading.appendChild(strong);
  section.appendChild(heading);
  const ul = document.createElement('ul');
  card.subtasks.forEach(s => {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!s.checked;
    cb.disabled = true;
    li.appendChild(cb);
    li.appendChild(document.createTextNode(' ' + s.title));
    ul.appendChild(li);
  });
  section.appendChild(ul);
  return section;
}

function openCardModal(card) {
  editingState.lastFocusBeforeModal = document.activeElement;
  editingState.currentModalCard = card;
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
  // サブタスクは DOMPurify による input type 剥奪を避けるため、ここで直接 DOM を組み立てて追加する。
  const subtasksSection = buildSubtasksSection(card);
  if (subtasksSection) {
    els.cardModalBody.appendChild(subtasksSection);
  }
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

  // F12: 作成日時・最終更新日時のメタ行をモーダル末尾に追加。
  //       既存ファイル由来のメタ無しカードは両方 '—' を表示する。
  const timestampsEl = document.createElement('div');
  timestampsEl.className = 'card-modal-timestamps';
  const createdIso = timestampToIsoAttr(card.createdAt);
  const updatedIso = timestampToIsoAttr(card.updatedAt);
  timestampsEl.innerHTML =
    `<span>作成: <time${createdIso ? ` datetime="${createdIso}"` : ''}>${escapeHtml(formatTimestampLong(card.createdAt))}</time></span>` +
    `<span class="sep" aria-hidden="true">·</span>` +
    `<span>更新: <time${updatedIso ? ` datetime="${updatedIso}"` : ''}>${escapeHtml(formatTimestampLong(card.updatedAt))}</time></span>`;
  els.cardModalBody.appendChild(timestampsEl);
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

/** モーダル編集モードへ入る。card のタイトル／本文／サブタスクを編集フォームに流し込む。
 *  タイトル文字列からは `#lane/X` と `@YYYY-MM-DD` を取り除き、専用セレクト／入力に分離する。
 *  カラム選択肢は board.columns 全件、レーン選択肢は board.lanes（スイムレーンモード時のみ）。 */
function enterModalEditMode() {
  const card = editingState.currentModalCard;
  if (!card) return;
  editingState.editing = { cardId: card.id, mode: 'modal' };
  // 背面カードの DnD を抑止（F9-8 / AC49）
  setCardDraggable(card.id, false);
  const swimlaneMode = !!(boardState.current && boardState.current.hasLanesKey);
  // タイトルは「#lane/X」「@YYYY-MM-DD」を除いた本文＋#tag のみで提示
  if (els.cmeTitle) els.cmeTitle.value = buildTitleForEdit(card, swimlaneMode);
  if (els.cmeBody) els.cmeBody.value = (card.bodyParts && card.bodyParts.length)
    ? card.bodyParts.join('\n\n')
    : '';
  populateModalLaneSelect(card, swimlaneMode);
  populateModalColumnSelect(card);
  if (els.cmeDue) els.cmeDue.value = card.dueDate || '';
  rebuildSubtaskEditList(card.subtasks || []);
  setModalEditMode(true);
  setTimeout(() => { if (els.cmeTitle) els.cmeTitle.focus(); }, 0);
}

/** タイトル原文から `#lane/X` と `@YYYY-MM-DD` を除いた編集用文字列を返す。
 *  swimlaneMode=false の場合は `#lane/X` を通常タグ扱いとして残す。 */
function buildTitleForEdit(card, swimlaneMode) {
  let s = card.title || '';
  if (swimlaneMode) {
    s = s.replace(new RegExp(`(?:^|\\s)#lane\\/[${LANE_NAME_CHARS}]+(?:\\/[${LANE_NAME_CHARS}]+)*`, 'g'), ' ');
  }
  s = s.replace(/(?:^|\s)@\d{4}-\d{2}-\d{2}\b/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** モーダル「レーン」セレクトを再構築。スイムレーンモードでない場合はフィールドごと隠す。 */
function populateModalLaneSelect(card, swimlaneMode) {
  if (!els.cmeLane || !els.cmeFieldLane) return;
  if (!swimlaneMode) {
    els.cmeFieldLane.hidden = true;
    els.cmeLane.innerHTML = '';
    return;
  }
  els.cmeFieldLane.hidden = false;
  els.cmeLane.innerHTML = '';
  const lanes = (boardState.current && boardState.current.lanes) ? boardState.current.lanes : [];
  lanes.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.name;
    opt.textContent = l.name === '' ? DEFAULT_LANE_DISPLAY_NAME : l.name;
    els.cmeLane.appendChild(opt);
  });
  els.cmeLane.value = card.lane || '';
}

/** モーダル「カラム」セレクトを再構築。値は colIdx（数値文字列）。 */
function populateModalColumnSelect(card) {
  if (!els.cmeColumn) return;
  els.cmeColumn.innerHTML = '';
  const cols = (boardState.current && boardState.current.columns) ? boardState.current.columns : [];
  cols.forEach((c, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = c.name;
    els.cmeColumn.appendChild(opt);
  });
  const loc = findCardLocation(card.id);
  if (loc) els.cmeColumn.value = String(loc.colIdx);
}

/** ユーザー入力のタイトル本体／レーン／期限から保存用の生タイトル文字列を組み立てる。
 *  ユーザーがタイトル欄に手で `#lane/X` や `@YYYY-MM-DD` を残しても二重にならないよう先に除去する。 */
function buildTitleForSave(rawInputTitle, lane, due, swimlaneMode) {
  let s = (rawInputTitle || '').replace(/[\r\n]+/g, ' ');
  s = s.replace(/(?:^|\s)@\d{4}-\d{2}-\d{2}\b/g, ' ');
  if (swimlaneMode) {
    s = s.replace(new RegExp(`(?:^|\\s)#lane\\/[${LANE_NAME_CHARS}]+(?:\\/[${LANE_NAME_CHARS}]+)*`, 'g'), ' ');
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (swimlaneMode && lane) {
    s = s ? `${s} #lane/${lane}` : `#lane/${lane}`;
  }
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) {
    s = s ? `${s} @${due}` : `@${due}`;
  }
  return s;
}

/** モーダル編集モードを破棄して閲覧モードへ戻す（変更は反映しない）。
 *  新規カード（isNew）の場合は board からカードを除去し、モーダルごと閉じる（中身が無いため閲覧モードに戻しても空）。 */
function cancelModalEditMode() {
  const cardId = editingState.editing && editingState.editing.cardId;
  const isNew = !!(editingState.editing && editingState.editing.isNew);
  editingState.editing = null;
  if (cardId) setCardDraggable(cardId, true);
  if (isNew) {
    const loc = findCardLocation(cardId);
    if (loc) loc.col.cards.splice(loc.cardIdx, 1);
    closeCardModal();
    renderBoard();
    return;
  }
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
  if (!editingState.editing || editingState.editing.mode !== 'modal') return;
  const card = editingState.currentModalCard;
  if (!card) return;
  let loc = findCardLocation(card.id);
  if (!loc) {
    cancelModalEditMode();
    return;
  }
  const swimlaneMode = !!(boardState.current && boardState.current.hasLanesKey);
  const titleInput = (els.cmeTitle ? els.cmeTitle.value : card.title)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  // 新規カードかつタイトル空 → 破棄（インライン編集と同じ挙動）。永続化はせずモーダルを閉じる。
  if (editingState.editing.isNew && titleInput === '') {
    loc.col.cards.splice(loc.cardIdx, 1);
    editingState.editing = null;
    closeCardModal();
    renderBoard();
    return;
  }
  // 専用フィールドからレーン／カラム／期限を取得し、保存用の生タイトル文字列に合成する。
  const selectedLane = (swimlaneMode && els.cmeLane) ? (els.cmeLane.value || '') : '';
  const selectedDue = (els.cmeDue && els.cmeDue.value) ? els.cmeDue.value : '';
  const selectedColIdxRaw = els.cmeColumn ? parseInt(els.cmeColumn.value, 10) : NaN;
  const selectedColIdx = (Number.isFinite(selectedColIdxRaw)
    && selectedColIdxRaw >= 0
    && selectedColIdxRaw < boardState.current.columns.length)
      ? selectedColIdxRaw
      : loc.colIdx;
  const newTitle = buildTitleForSave(titleInput, selectedLane, selectedDue, swimlaneMode);

  // カラム変更があれば board 上で移動（末尾に挿入）。loc を再取得する。
  if (selectedColIdx !== loc.colIdx) {
    const fromCol = boardState.current.columns[loc.colIdx];
    const [moved] = fromCol.cards.splice(loc.cardIdx, 1);
    boardState.current.columns[selectedColIdx].cards.push(moved);
    loc = findCardLocation(card.id);
    if (!loc) {
      cancelModalEditMode();
      return;
    }
  }

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

  // F2 同期: モーダル編集確定時も所属カラムの自動チェック状態で強制再評価（カラム移動は起きないが防御的）
  syncCardCheckedToColumn(loc.card, loc.col.name);

  // F12: タイトル・本文・サブタスクの編集はカードの最終更新日時を更新する。
  //       既存ファイル由来のメタ無しカードでは createdAt も同時に現在時刻で埋まる。
  bumpCardTimestamps(loc.card);

  editingState.editing = null;
  reserializeAndPersist();
  markDirty();
  renderBoard();
  // 保存はそのモーダル編集セッションの terminal action。閲覧モーダルへ留まらずに
  // ボードへ戻す（インライン編集確定の挙動と一貫させる）。
  //   - editingState.editing は既に null にしてあるので closeCardModal の「未保存破棄」分岐には入らない
  //   - editingState.lastFocusBeforeModal によりフォーカスは編集元（カード or 追加ボタン）に戻る
  closeCardModal();
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
  let pendingNewCardId = null;
  if (editingState.editing && editingState.editing.mode === 'modal') {
    setCardDraggable(editingState.editing.cardId, true);
    if (editingState.editing.isNew) pendingNewCardId = editingState.editing.cardId;
    editingState.editing = null;
  }
  els.cardModal.hidden = true;
  els.cardModalBody.innerHTML = '';
  setModalEditMode(false);
  editingState.currentModalCard = null;
  document.removeEventListener('keydown', handleModalKeydown);
  // 新規カードを未保存のまま閉じた場合は board から取り除いて再描画
  if (pendingNewCardId) {
    const loc = findCardLocation(pendingNewCardId);
    if (loc) {
      loc.col.cards.splice(loc.cardIdx, 1);
      renderBoard();
    }
  }
  if (editingState.lastFocusBeforeModal && typeof editingState.lastFocusBeforeModal.focus === 'function') {
    editingState.lastFocusBeforeModal.focus();
  }
}

function handleModalKeydown(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    // 編集モード中は編集破棄のみ、閲覧モードならモーダル閉じる
    if (editingState.editing && editingState.editing.mode === 'modal') {
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
 * 上書きしてしまう誤動作を防ぐため、デフォルトで fileState.fileHandle を null にクリアする。
 * FSA経由でハンドル付きで開く場合のみ、第3引数 { fileHandle } を渡して再代入する。
 *
 * @param {string} text Markdown 本文
 * @param {string} fileName 表示用ファイル名
 * @param {object} [opts]
 * @param {FileSystemFileHandle|null} [opts.fileHandle=null] FSA経由のハンドル。指定しなければハンドル無効化
 */
function loadMarkdown(text, fileName, opts) {
  clearStatus();
  uiState.activeTagFilter = null;
  els.tagFilterBar.hidden = true;
  els.activeTagDisplay.textContent = '';

  if (text == null || text.trim() === '') {
    // ハンドルが残ったままだと「保存」で空ファイルが上書きされかねないのでここでも明示クリア
    fileState.fileHandle = null;
    updateSaveControlsVisibility();
    showStatus('ファイルが空です', 'error');
    return;
  }

  let board;
  try {
    board = parseKanban(text);
  } catch (e) {
    fileState.fileHandle = null;
    updateSaveControlsVisibility();
    showStatus('Markdownのパースに失敗しました', 'error');
    return;
  }

  const totalCards = board.columns.reduce((sum, c) => sum + c.cards.length, 0);
  if (board.columns.length === 0 || (totalCards === 0 && board.columns.length === 0)) {
    fileState.fileHandle = null;
    updateSaveControlsVisibility();
    showStatus('カンバン化できる要素が見つかりません', 'error');
    return;
  }

  // 新しいboard内容に切り替えるタイミングで、原則として fileHandle はクリアする。
  // FSA経由（readFileWithHandle）から呼ばれた場合のみ opts.fileHandle で再代入される。
  const nextHandle = (opts && Object.prototype.hasOwnProperty.call(opts, 'fileHandle'))
    ? opts.fileHandle
    : null;
  fileState.fileHandle = nextHandle;
  // ハンドルを IDB に永続化（または削除）して、次回リロード時の自動保存復帰に備える。
  if (nextHandle) saveHandleToIdb(nextHandle);
  else deleteHandleFromIdb();

  boardState.current = board;
  fileState.fileName = fileName;
  boardState.serializedMarkdown = text;
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
  // ファイルが開かれている状態をbodyに反映し、ヘッダの非表示制御に使う
  document.body.classList.add('has-board');

  // 集中モード: 初回ボード読込時に SEO 詳細セクションを畳む。
  // ページセッション内で 1 度だけ自動操作し、以降のユーザー操作は尊重する。
  if (!boardState.seoAutoCollapsed) {
    const seoDetails = document.querySelector('.seo-content-details');
    if (seoDetails) seoDetails.open = false;
    boardState.seoAutoCollapsed = true;
  }

  // 新規ロード時は dirty 状態と自動保存ステータスをリセット
  clearDirty();
  if (autosaveState.timer) {
    clearTimeout(autosaveState.timer);
    autosaveState.timer = null;
  }
  if (autosaveState.pendingHide) {
    clearTimeout(autosaveState.pendingHide);
    autosaveState.pendingHide = null;
  }
  setAutoSaveStatus('idle');
  updateSaveControlsVisibility();

  renderBoard();
  // 読み込み完了の通知はトーストでは出さない: ファイル名・列/枚数はヘッダに常時表示されており、
  // ボードが描画されたこと自体が成功フィードバックとして十分（重複通知の回避）。
}

/**
 * 新規ボードを作成する。FSA の showSaveFilePicker で保存先ファイルを必ず指定させ、
 * デフォルトカラム（Todo / Doing / Done）入りのテンプレートを書き込んでから開く。
 * Done カラムは自動チェック ON をデフォルトとする（auto-check-columns に含める）。
 * FSA 未対応ブラウザではボタンが無効化されているため通常呼ばれないが、念のためガードする。
 */
async function createNewBoardFlow() {
  if (!('showSaveFilePicker' in window)) return;
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: 'kanban.md',
      types: [{
        description: 'Markdown',
        accept: { 'text/markdown': ['.md', '.markdown'] }
      }]
    });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    showStatus('保存先を指定できませんでした: ' + (e && e.message ? e.message : e), 'error');
    return;
  }

  const rawName = handle.name || 'kanban.md';
  const baseTitle = rawName.replace(/\.(md|markdown)$/i, '') || '新規ボード';
  const template = `---\nauto-check-columns:\n  - Done\n---\n\n# ${baseTitle}\n\n## Todo\n\n## Doing\n\n## Done\n`;

  loadMarkdown(template, rawName, { fileHandle: handle });
  updateSaveControlsVisibility();
  // 直後に1回 autoSaveNow を呼んでテンプレートをディスクへ書き込み、保存先を実体化する
  try { await autoSaveNow(); } catch (_) { /* 失敗してもUI表示は続行 */ }
}

// -------- カードDnD（列間移動・列内並び替え） --------

/** 列のすべてのドロップインジケーター・ハイライトを除去 */
function clearAllDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach(n => n.remove());
  document.querySelectorAll('.kanban-column-cards.is-drop-target').forEach(n => {
    n.classList.remove('is-drop-target');
  });
  document.querySelectorAll('.is-card-drop-target').forEach(n => {
    n.classList.remove('is-card-drop-target');
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
  if (!boardState.current || !boardState.current.columns[colIdx]) return 0;
  return boardState.current.columns[colIdx].cards.length;
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
    editingState.dragging = { cardId, fromColIdx, fromCardIdx, fromLane };
    cardEl.classList.add('is-dragging');
    // 折りたたみカラム／レーンの drop プレースホルダーを可視化するためのフラグ
    if (els.kanbanBoard) els.kanbanBoard.classList.add('is-card-dragging');
    try {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', cardId);
    } catch (e) { /* IE等対策（実害なし） */ }
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('is-dragging');
    if (els.kanbanBoard) els.kanbanBoard.classList.remove('is-card-dragging');
    clearAllDropIndicators();
    editingState.dragging = null;
    // dragend 直後にブラウザが click を発火させる場合があるため、120ms間 click を抑止する。
    editingState.suppressClickUntil = performance.now() + POST_DND_CLICK_SUPPRESS_MS;
  });
}

/** 列のカード領域側のDnDイベント（dragover/drop/dragleave） */
function attachColumnDnDHandlers(cardsWrapEl) {
  cardsWrapEl.addEventListener('dragover', (ev) => {
    // カードのDnDのみ受け付ける（ファイルDnDは別系統で扱う）
    if (!editingState.dragging) return;
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
    if (!editingState.dragging) return;
    const related = ev.relatedTarget;
    if (related && cardsWrapEl.contains(related)) return;
    cardsWrapEl.classList.remove('is-drop-target');
    cardsWrapEl.querySelectorAll('.drop-indicator').forEach(n => n.remove());
  });

  cardsWrapEl.addEventListener('drop', (ev) => {
    if (!editingState.dragging) return;
    ev.preventDefault();
    const { absoluteIndex } = getDropPosition(cardsWrapEl, ev.clientY);
    const toColIdx = parseInt(cardsWrapEl.dataset.colIndex, 10);
    // スイムレーンモード時のみ data-lane が付与されている。それ以外は null。
    const toLane = Object.prototype.hasOwnProperty.call(cardsWrapEl.dataset, 'lane')
      ? cardsWrapEl.dataset.lane
      : null;
    const { cardId, fromColIdx, fromCardIdx, fromLane } = editingState.dragging;
    moveCard(fromColIdx, fromCardIdx, toColIdx, absoluteIndex, cardId, fromLane, toLane);
    clearAllDropIndicators();
    editingState.dragging = null;
  });
}

/**
 * 折りたたみ中のカラム本体／レーン行に置く drop プレースホルダー用ハンドラ。
 * 落としたカードは指定セル（colIdx × laneNameOrNull）の末尾に追加する。
 * - 通常モード: laneNameOrNull=null を渡し、card.lane は触らない
 * - スイムレーンモードでカラム折りたたみ時: ドラッグ元 lane を維持したいので、呼び出し側で laneName=null を渡せばここで fromLane を採用する
 * - スイムレーンモードでレーン折りたたみ時: 呼び出し側で laneName=<対象レーン> を渡す（lane 切替）
 */
function attachCardDropEndOfCellHandlers(el, colIdx, laneNameOrNull) {
  el.addEventListener('dragover', (ev) => {
    if (!editingState.dragging) return; // カードDnD中のみ反応（列／レーン並び替えは別系統）
    ev.preventDefault();
    ev.stopPropagation();
    try { ev.dataTransfer.dropEffect = 'move'; } catch (e) { /* noop */ }
    el.classList.add('is-card-drop-target');
  });
  el.addEventListener('dragleave', (ev) => {
    if (!editingState.dragging) return;
    const related = ev.relatedTarget;
    if (related && el.contains(related)) return;
    el.classList.remove('is-card-drop-target');
  });
  el.addEventListener('drop', (ev) => {
    if (!editingState.dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    el.classList.remove('is-card-drop-target');
    const board = boardState.current;
    if (!board) return;
    const toCol = board.columns[colIdx];
    if (!toCol) return;
    const { cardId, fromColIdx, fromCardIdx, fromLane } = editingState.dragging;
    const useSwimlanes = !!board.useSwimlanes;
    let toLane;
    if (!useSwimlanes) {
      toLane = null;
    } else if (laneNameOrNull !== null && laneNameOrNull !== undefined) {
      toLane = laneNameOrNull;
    } else {
      toLane = fromLane || '';
    }
    const targetIndex = toCol.cards.length; // moveCard は cards.length 以上を「末尾シグナル」として解釈する
    moveCard(fromColIdx, fromCardIdx, colIdx, targetIndex, cardId, fromLane, toLane);
    clearAllDropIndicators();
    editingState.dragging = null;
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
  const board = boardState.current;
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

  // F2 同期: 移動先カラムの自動チェック設定にあわせて card.checked を強制上書き。
  // 対象カラム → true、対象外 → false（card.checked===null も同期型仕様で true/false に確定）。
  syncCardCheckedToColumn(card, toCol.name);

  // F12: 列移動・レーン移動・同列内並び替えはいずれも「カードの状態が変わった」とみなして
  //       最終更新日時を更新する。既存メタ無しカードはここで createdAt も埋まる。
  bumpCardTimestamps(card);

  // 同 lane に居なくなった lane が空になっても board.lanes は維持する（折りたたみ状態保持等のため）。
  // ただしデフォルトレーン（''）が完全に消えたケースは useSwimlanes 維持のままで問題ない。

  // シリアライズしてLocalStorage反映＋dirty化
  const serialized = serializeBoard(board);
  boardState.serializedMarkdown = serialized;
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
  if (!boardState.current) return null;
  for (let ci = 0; ci < boardState.current.columns.length; ci++) {
    const col = boardState.current.columns[ci];
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
  const swimlaneMode = !!(boardState.current && boardState.current.hasLanesKey);
  const meta = reparseTitleMeta(rawTitle, swimlaneMode);
  card.title = meta.title;
  card.displayTitle = meta.displayTitle;
  card.tags = meta.tags;
  card.dueDate = meta.dueDate;
  // 厳密モード: 未列挙 lane は「未分類」（''）に正規化する。lanes: は自動追記しない（F8-A 経由のみ）。
  if (swimlaneMode) {
    const validNames = new Set((boardState.current.lanes || []).map(l => l.name).filter(n => n !== ''));
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
  if (editingState.editing) {
    // 別カード編集中なら、まず確定して進める
    commitInlineEdit(true);
  }
  const loc = findCardLocation(cardId);
  if (!loc) return;
  const cardEl = document.querySelector(`.kanban-card[data-card-id="${cardId}"]`);
  if (!cardEl) return;
  const titleEl = cardEl.querySelector('.kanban-card-title');
  if (!titleEl) return;

  editingState.editing = {
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
    if (!editingState.editing || editingState.editing.cardId !== cardId) return;
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
 *   新規カードかつ空タイトルなら破棄（boardState.current から取り除く）。
 */
function commitInlineEdit(silent) {
  if (!editingState.editing || editingState.editing.mode !== 'inline') return;
  const { cardId, isNew } = editingState.editing;
  const loc = findCardLocation(cardId);
  if (!loc) {
    editingState.editing = null;
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
    editingState.editing = null;
    renderBoard();
    return;
  }

  // 通常確定: メタ情報を再抽出して反映。
  // 厳密モード: lanes: ホワイトリスト未列挙の `#lane/X` は自動追記しない（reparseCardMetaFromTitle で正規化）。
  const titleChanged = newTitle !== loc.card.title;
  if (titleChanged) {
    reparseCardMetaFromTitle(loc.card, newTitle, loc.card.checked);
  }
  // F2 同期: 編集確定時も所属カラムの自動チェック状態で checked を強制上書き（防御的再評価）
  syncCardCheckedToColumn(loc.card, loc.col.name);
  // F12: タイトル変更時のみ更新日時を更新（変更が無いときの blur 確定では触らない）。
  if (titleChanged) {
    bumpCardTimestamps(loc.card);
  }
  editingState.editing = null;
  reserializeAndPersist();
  markDirty();
  renderBoard();
  triggerAutoSave();
}

/** インライン編集を破棄して元のタイトルに戻す。 */
function cancelInlineEdit() {
  if (!editingState.editing || editingState.editing.mode !== 'inline') return;
  const { cardId, isNew } = editingState.editing;
  editingState.editing = null;
  if (isNew) {
    // 新規カードを破棄。addNewCard は永続化していないので dirty 化はしない。
    const loc = findCardLocation(cardId);
    if (loc) loc.col.cards.splice(loc.cardIdx, 1);
  }
  renderBoard();
}

/**
 * 新規カードを colIdx 列（lane 指定があればそのレーン）の末尾に追加し、
 * 即座にカード編集モーダルを開く。タイトル空のまま保存／キャンセル／モーダル閉じで破棄される。
 */
function addNewCard(colIdx, laneName) {
  if (!boardState.current || !boardState.current.columns[colIdx]) return;
  // 編集中の他カードがあれば先に確定
  if (editingState.editing) {
    if (editingState.editing.mode === 'inline') commitInlineEdit(true);
    else if (editingState.editing.mode === 'modal') commitModalEditMode();
  }
  const newCardSeq = nextCardId();
  // F2: 追加先カラムが自動チェック対象なら初期 checked=true
  const targetColName = boardState.current.columns[colIdx] ? boardState.current.columns[colIdx].name : '';
  const initialChecked = isColumnAutoChecked(targetColName);
  // F12: 新規カードは作成日時 = 更新日時 = 現在時刻。タイトル空でキャンセル破棄された場合は
  //      boardState.current に残らないため、メタコメントの書き出しも発生しない。
  const nowTs = nowLocalTimestamp();
  const newCard = {
    id: `c-${newCardSeq}-new`,
    title: '',
    displayTitle: '',
    checked: initialChecked,
    tags: [],
    lane: (laneName === null || laneName === undefined) ? '' : laneName,
    dueDate: null,
    subtasks: [],
    bodyParts: [],
    createdAt: nowTs,
    updatedAt: nowTs
  };
  boardState.current.columns[colIdx].cards.push(newCard);
  // 新規 lane が発生する可能性は無い（既存 lane へ追加）が、useSwimlanes 維持。
  renderBoard();
  // 新規作成モーダルを開き、即座に編集モードへ。
  // 保存／キャンセル／モーダル閉じで「タイトル空なら破棄」になるよう editingState.editing.isNew をマークする。
  openCardModal(newCard);
  enterModalEditMode();
  if (editingState.editing && editingState.editing.mode === 'modal') {
    editingState.editing.isNew = true;
  }
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

/** 現在の board をシリアライズして boardState.serializedMarkdown と localStorage を更新する。 */
function reserializeAndPersist() {
  if (!boardState.current) return;
  const md = serializeBoard(boardState.current);
  boardState.serializedMarkdown = md;
  try {
    localStorage.setItem(STORAGE_KEYS.content, md);
  } catch (e) { /* クォータ超過は握りつぶす */ }
}

// -------- 自動保存（F11） は ./js/autosave.js に移動済み --------

// -------- 保存・書き戻し --------

// dirty-marker は常に DOM 上に残し data-hidden + aria-hidden で見た目だけ切替。
// hidden 属性（display:none）はカプセル内のレイアウトシフト原因になるため使わない。
// save-status と同一スロットを共有するため、表示判定は refreshFileSaveStateUI() に集約。
function markDirty() {
  fileState.dirty = true;
  refreshFileSaveStateUI();
  updateSaveControlsVisibility();
}

function clearDirty() {
  fileState.dirty = false;
  refreshFileSaveStateUI();
}

/** 保存系UI（保存・DL・コピー）の表示制御。
 *  - メニュー内 DL/Copy: hasBoard 時に表示（バックアップ手段）
 *  - ツールバー昇格 DL/Copy: 非FSA環境かつ hasBoard の時のみヘッダに常時露出
 *    （auto-save が無いので保存手段として moment-to-moment primary）
 *  - 保存ボタン: FSAサポート＆ハンドル取得済みの時のみ（メニュー内、任意の手動保存）。 */
function updateSaveControlsVisibility() {
  const hasBoard = !!boardState.current;
  const hasFsa = 'showSaveFilePicker' in window;
  // メニュー内 DL/Copy（バックアップ用、hasBoard なら常時利用可）
  if (els.downloadBtn) els.downloadBtn.hidden = !hasBoard;
  if (els.copyBtn) els.copyBtn.hidden = !hasBoard;
  // 非FSA環境では DL/Copy をヘッダに昇格して常時表示
  if (els.toolbarDownloadBtn) els.toolbarDownloadBtn.hidden = !(hasBoard && !hasFsa);
  if (els.toolbarCopyBtn) els.toolbarCopyBtn.hidden = !(hasBoard && !hasFsa);
  // 保存ボタンは FSAサポート＆ハンドル取得済みのみ
  const canSaveInPlace = hasBoard && hasFsa && !!fileState.fileHandle;
  if (els.saveBtn) els.saveBtn.hidden = !canSaveInPlace;
  // 再読み込みボタンも保存と同じ条件: ハンドルがあるときだけ意味を持つ
  if (els.toolbarReloadBtn) els.toolbarReloadBtn.hidden = !canSaveInPlace;
}

/** Markdownを現在のboardからシリアライズして取得 */
function getCurrentMarkdown() {
  if (!boardState.current) return '';
  if (boardState.serializedMarkdown != null) return boardState.serializedMarkdown;
  const md = serializeBoard(boardState.current);
  boardState.serializedMarkdown = md;
  return md;
}

/** ダウンロード（全ブラウザ） */
function downloadMarkdown() {
  if (!boardState.current) return;
  const md = getCurrentMarkdown();
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileState.fileName || 'kanban.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showStatus('Markdownをダウンロードしました', 'success');
}

/** クリップボードへコピー（execCommandへフォールバック） */
async function copyMarkdown() {
  if (!boardState.current) return;
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
  if (!fileState.fileHandle || !boardState.current) return;
  // 予約された自動保存があれば前倒しで実行するため一旦キャンセル
  if (autosaveState.timer) {
    clearTimeout(autosaveState.timer);
    autosaveState.timer = null;
  }
  await autoSaveNow();
}

/**
 * 現在のハンドル経由でディスクから .md を再読み込みする。外部エディタでの編集を反映する用途。
 * - 読み取り権限を要求（自動保存のため readwrite で取得しておくと以降の autosave も即有効化）
 * - ディスクの内容が現在のシリアライズ済み Markdown と一致するなら何もしない（無音）
 * - 異なる場合: dirty 状態ならユーザーに確認してから loadMarkdown で差し替える
 * - silent=true のときは権限ダイアログを出さず、queryPermission が granted の場合だけ反映
 */
async function refreshFromDisk(opts) {
  const silent = !!(opts && opts.silent);
  const handle = fileState.fileHandle;
  if (!handle) return;
  try {
    let perm = 'granted';
    if (handle.queryPermission) {
      perm = await handle.queryPermission({ mode: 'readwrite' });
    }
    if (perm !== 'granted') {
      if (silent) return;
      if (handle.requestPermission) {
        perm = await handle.requestPermission({ mode: 'readwrite' });
      }
      if (perm !== 'granted') {
        showStatus('読み取り権限が許可されませんでした', 'error');
        return;
      }
    }
    const file = await handle.getFile();
    const text = await file.text();
    if (text === boardState.serializedMarkdown) {
      // 差分なし: silent 経路では何も出さない。明示クリックの場合だけ「変更なし」を案内。
      if (!silent) showStatus('ディスクの内容は最新と同じです', 'success');
      return;
    }
    // 差分あり: dirty なら破棄確認、そうでなければそのまま反映
    if (fileState.dirty && !silent) {
      const ok = window.confirm('未保存の変更があります。破棄してディスクの内容で上書きしますか？');
      if (!ok) return;
    }
    loadMarkdown(text, fileState.fileName || file.name, { fileHandle: handle });
    if (!silent) showStatus('ディスクの内容で再読み込みしました', 'success');
  } catch (e) {
    if (silent) return;
    showStatus('再読み込みに失敗しました: ' + (e && e.message ? e.message : e), 'error');
  }
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
    // ハンドルは readFileWithHandle 経由で loadMarkdown に渡し、内部で fileState.fileHandle に再代入する。
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
    // ハンドルは loadMarkdown 内で fileState.fileHandle に再代入され、保存ボタンが表示される。
    loadMarkdown(text, file.name || '', { fileHandle: handle || null });
    updateSaveControlsVisibility();
  };
  reader.onerror = () => showStatus('テキストファイルとして読み込めませんでした', 'error');
  reader.readAsText(file, 'UTF-8');
}


// -------- テーマ・密度 / hide-checked は ./js/theme.js に移動済み --------

// -------- 自動復元 --------
/**
 * リロード時、前回の lastContent があれば確認なしで自動復元する。
 * IDB に FileSystemFileHandle が残っていれば自動保存先として再アタッチし、
 * 最初のユーザー操作（編集→自動保存）のタイミングで requestPermission が走るようにする。
 * 権限プロンプトはブラウザの仕様上、user activation を必要とするためここでは発行しない。
 */
async function autoRestoreIfPossible() {
  let saved, savedName;
  try {
    saved = localStorage.getItem(STORAGE_KEYS.content);
    savedName = localStorage.getItem(STORAGE_KEYS.fileName);
  } catch (e) { return; }
  if (!saved || saved.trim() === '') return;

  // 念のため復元バナーは隠す（旧バージョンとの互換のため DOM 自体は残してある）。
  if (els.restoreBanner) els.restoreBanner.hidden = true;

  const savedHandle = await loadHandleFromIdb();
  if (savedHandle) {
    // ハンドル付きで復元: 以降の編集で autoSaveNow が requestPermission を実施し、
    //                   許可されれば変更が同じファイルへ自動保存される。
    loadMarkdown(saved, savedName || '', { fileHandle: savedHandle });
    // 既に権限が残っているまれなケース（インストール済みPWA等）では
    // 外部編集された .md をリロード直後に silent で取り込む。通常タブでは何も起きない。
    refreshFromDisk({ silent: true });
  } else {
    loadMarkdown(saved, savedName || '');
  }
}

// -------- 初期化 --------
function init() {
  // autosave モジュールへ依存関数を注入（循環 import を避けるための DI）
  initAutosave({ getCurrentMarkdown, clearDirty, updateSaveControlsVisibility });
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
        uiState.collapsedLanes = new Set(arr.filter(v => typeof v === 'string'));
      }
    }
    // F1: カラムの折りたたみ状態を復元
    const collapsedColsRaw = localStorage.getItem(STORAGE_KEYS.collapsedColumns);
    if (collapsedColsRaw) {
      const arr = JSON.parse(collapsedColsRaw);
      if (Array.isArray(arr)) {
        uiState.collapsedColumns = new Set(arr.filter(v => typeof v === 'string'));
      }
    }
    // F13: チェック済みカード自動非表示の閾値を復元（不正値は既定 7 日に戻す）
    const hideDaysRaw = localStorage.getItem(STORAGE_KEYS.hideCheckedAfterDays);
    if (hideDaysRaw !== null) {
      settingsState.hideCheckedAfterDays = normalizeHideCheckedDays(hideDaysRaw);
    }
  } catch (e) { /* noop（不正JSON等は無視して空のまま） */ }
  applyTheme(savedTheme);
  applyDensity(savedDensity);
  setupHideCheckedControls(renderBoard);

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
  if (els.emptyOpenBtn) els.emptyOpenBtn.addEventListener('click', openFileEntry);
  if (els.newBoardBtn) els.newBoardBtn.addEventListener('click', createNewBoardFlow);
  if (els.emptyNewBtn) els.emptyNewBtn.addEventListener('click', createNewBoardFlow);
  if (els.toolbarReloadBtn) els.toolbarReloadBtn.addEventListener('click', () => refreshFromDisk());

  // FSA 未対応ブラウザでは「新規作成」を無効化（保存先指定ができないため）
  if (!('showSaveFilePicker' in window)) {
    const unsupportedTitle = '新規作成は Chrome / Edge など File System Access API 対応ブラウザでのみ利用できます';
    if (els.newBoardBtn) {
      els.newBoardBtn.disabled = true;
      els.newBoardBtn.title = unsupportedTitle;
    }
    if (els.emptyNewBtn) {
      els.emptyNewBtn.disabled = true;
      els.emptyNewBtn.title = unsupportedTitle;
    }
    if (els.emptyFsaNote) els.emptyFsaNote.hidden = false;
  }

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

  // ツールバー昇格 DL/Copy（非FSA環境）: 既存ハンドラに委譲
  if (els.toolbarDownloadBtn) els.toolbarDownloadBtn.addEventListener('click', downloadMarkdown);
  if (els.toolbarCopyBtn) els.toolbarCopyBtn.addEventListener('click', copyMarkdown);

  // ===== オーバーフローメニュー =====
  // ⋮ クリックでメニュー開閉。外側クリック・Escape でクローズ。
  // メニュー項目クリックでメニュー自動クローズ（hide-checked-toggle はネストポップオーバーを持つので例外）。
  if (els.overflowMenuToggle && els.overflowMenu) {
    const openMenu = () => {
      els.overflowMenu.hidden = false;
      els.overflowMenuToggle.setAttribute('aria-expanded', 'true');
    };
    const closeMenu = () => {
      els.overflowMenu.hidden = true;
      els.overflowMenuToggle.setAttribute('aria-expanded', 'false');
      // メニュー閉じる時はネストの hide-checked-popover も閉じる
      if (uiState.hideCheckedPopoverOpen && typeof closeHideCheckedPopover === 'function') {
        closeHideCheckedPopover();
      }
    };
    els.overflowMenuToggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (els.overflowMenu.hidden) openMenu(); else closeMenu();
    });
    // 外側クリックで閉じる（hide-checked-popover の内側クリックは外側扱いしない）
    document.addEventListener('click', (ev) => {
      if (els.overflowMenu.hidden) return;
      if (els.overflowMenu.contains(ev.target)) return;
      if (els.overflowMenuToggle.contains(ev.target)) return;
      closeMenu();
    });
    // Escape で閉じる
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !els.overflowMenu.hidden) {
        // ネストポップオーバーが開いている時は、そちらを先に閉じる
        if (uiState.hideCheckedPopoverOpen && typeof closeHideCheckedPopover === 'function') {
          closeHideCheckedPopover();
          return;
        }
        closeMenu();
        els.overflowMenuToggle.focus();
      }
    });
    // メニュー項目クリックで自動クローズ（hide-checked-toggle 以外）
    els.overflowMenu.querySelectorAll('.overflow-menu-item').forEach((item) => {
      if (item.id === 'hide-checked-toggle') return; // ネストポップオーバーは保持
      item.addEventListener('click', () => {
        // 元のクリックハンドラ実行後にメニュー閉じる（同フレームで OK）
        setTimeout(closeMenu, 0);
      });
    });
  }

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

  // 編集フォームの implicit form submission を抑止する。
  // タイトル <input type="text"> がフォーム内に1つあるため、Enter で既定の form submit が走り、
  // モーダル状態を破棄したままページが遷移してしまうのを防ぐ（保険）。
  if (els.cardModalEditForm) {
    els.cardModalEditForm.addEventListener('submit', (ev) => ev.preventDefault());
    // Cmd/Ctrl + Enter はどのフィールドからでも保存（Slack / GitHub Issue 慣習）。
    // IME 変換中の Enter は二段ガード（isComposing / keyCode 229）で除外する。
    els.cardModalEditForm.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      if (ev.isComposing || ev.keyCode === 229) return;
      if (!(ev.metaKey || ev.ctrlKey)) return;
      ev.preventDefault();
      commitModalEditMode();
    });
  }

  // タイトル欄: Enter で保存して閉じる（インラインタイトル編集と同じ慣習）。
  // タイトルは1行のみで、本文は別 textarea のため Enter を保存に割り当てる。
  if (els.cmeTitle) {
    els.cmeTitle.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      if (ev.isComposing || ev.keyCode === 229) return;
      // Cmd/Ctrl 修飾は上のフォームレベルハンドラに任せる（二重発火回避）
      if (ev.metaKey || ev.ctrlKey) return;
      ev.preventDefault();
      commitModalEditMode();
    });
  }

  // モーダル削除ボタン（閲覧モード時のみ可視）
  if (els.cardModalDeleteBtn) {
    els.cardModalDeleteBtn.addEventListener('click', () => {
      const card = editingState.currentModalCard;
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
    if (!fileState.dirty) return;
    // 自動保存が成功直後（saved）なら警告しない
    if (autosaveState.status === 'saved') return;
    ev.preventDefault();
    // 標準のレガシー仕様: returnValue を設定するとブラウザのデフォルト確認ダイアログが出る
    ev.returnValue = '';
  });

  autoRestoreIfPossible();
  updateSaveControlsVisibility();
}


// ---------- 起動 ----------
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
