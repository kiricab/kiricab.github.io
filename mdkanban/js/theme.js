// テーマ・密度・hide-checked ポップオーバー。
// 永続化は localStorage、状態は uiState / settingsState で保持。
// renderBoard を直接呼びたい場面があるため、呼び側で渡してもらう DI 形式は取らず、
// 動的 import で循環を避ける（render.js も未抽出のため、直接 import 可能）。

import { STORAGE_KEYS, HIDE_CHECKED_DEFAULT_DAYS, HIDE_CHECKED_MAX_DAYS } from './constants.js';
import { els } from './dom.js';
import { uiState, settingsState, boardState } from './state.js';

export function applyTheme(theme) {
  els.body.setAttribute('data-theme', theme);
  els.themeToggle.textContent = theme === 'dark'
    ? '☀️ ライトモードに切替'
    : '🌙 ダークモードに切替';
  els.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'ライトテーマに切替' : 'ダークテーマに切替');
  try { localStorage.setItem(STORAGE_KEYS.theme, theme); } catch (e) { /* noop */ }
}

export function applyDensity(density) {
  els.body.setAttribute('data-density', density);
  els.densityToggle.textContent = density === 'compact'
    ? '▦ 詳細表示に切替'
    : '☰ コンパクト表示に切替';
  els.densityToggle.setAttribute('aria-label', density === 'compact' ? '詳細表示に切替' : 'コンパクト表示に切替');
  els.densityToggle.title = density === 'compact' ? '詳細表示に切替' : 'コンパクト表示に切替';
  try { localStorage.setItem(STORAGE_KEYS.density, density); } catch (e) { /* noop */ }
}

export function toggleTheme() {
  const cur = els.body.getAttribute('data-theme') || 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

export function toggleDensity() {
  const cur = els.body.getAttribute('data-density') || 'compact';
  applyDensity(cur === 'compact' ? 'detailed' : 'compact');
}

// ===== F13: チェック済みカード自動非表示 =====

/** 設定を正規化（0..365 の整数。NaN は既定値）。永続化はしない。 */
export function normalizeHideCheckedDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return HIDE_CHECKED_DEFAULT_DAYS;
  const i = Math.round(n);
  if (i < 0) return 0;
  if (i > HIDE_CHECKED_MAX_DAYS) return HIDE_CHECKED_MAX_DAYS;
  return i;
}

export function persistHideCheckedDays() {
  try {
    localStorage.setItem(STORAGE_KEYS.hideCheckedAfterDays, String(settingsState.hideCheckedAfterDays));
  } catch (e) { /* noop */ }
}

/** トグルボタンの title 属性を現在状態に合わせて更新する。 */
export function updateHideCheckedToggleLabel() {
  if (!els.hideCheckedToggle) return;
  const days = settingsState.hideCheckedAfterDays;
  let t;
  if (days <= 0) {
    t = '完了済みカードを常に表示中（クリックで設定）';
  } else if (uiState.showHiddenGlobal) {
    t = `完了済みカードを今だけ全表示中（通常は${days}日経過で非表示。クリックで設定）`;
  } else {
    t = `完了済みカードを${days}日経過で自動非表示（クリックで設定）`;
  }
  els.hideCheckedToggle.title = t;
}

export function openHideCheckedPopover() {
  if (!els.hideCheckedPopover) return;
  els.hideCheckedPopover.hidden = false;
  uiState.hideCheckedPopoverOpen = true;
  els.hideCheckedToggle.setAttribute('aria-expanded', 'true');
  if (els.hcDaysInput) {
    els.hcDaysInput.value = String(settingsState.hideCheckedAfterDays);
    setTimeout(() => { try { els.hcDaysInput.focus({ preventScroll: true }); } catch (e) {} }, 0);
  }
  if (els.hcRevealAll) els.hcRevealAll.checked = !!uiState.showHiddenGlobal;
}

export function closeHideCheckedPopover() {
  if (!els.hideCheckedPopover) return;
  els.hideCheckedPopover.hidden = true;
  uiState.hideCheckedPopoverOpen = false;
  if (els.hideCheckedToggle) {
    els.hideCheckedToggle.setAttribute('aria-expanded', 'false');
  }
}

export function toggleHideCheckedPopover() {
  if (uiState.hideCheckedPopoverOpen) {
    closeHideCheckedPopover();
  } else {
    openHideCheckedPopover();
  }
}

/**
 * hide-checked ポップオーバーまわりのイベント配線。
 * renderBoard は呼び側から渡してもらう（render.js が未抽出の場面でも循環を避けるため）。
 */
export function setupHideCheckedControls(renderBoard) {
  if (!els.hideCheckedToggle || !els.hideCheckedPopover) return;
  updateHideCheckedToggleLabel();
  els.hideCheckedToggle.setAttribute('aria-expanded', 'false');
  els.hideCheckedToggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleHideCheckedPopover();
  });

  // ポップオーバー内クリックは外側判定から除外
  els.hideCheckedPopover.addEventListener('click', (ev) => ev.stopPropagation());

  // 外側クリック / Esc / 別ボタンクリックで閉じる
  document.addEventListener('click', (ev) => {
    if (!uiState.hideCheckedPopoverOpen) return;
    if (ev.target === els.hideCheckedToggle) return;
    if (els.hideCheckedPopover.contains(ev.target)) return;
    closeHideCheckedPopover();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && uiState.hideCheckedPopoverOpen) {
      ev.stopPropagation();
      closeHideCheckedPopover();
      if (els.hideCheckedToggle) els.hideCheckedToggle.focus();
    }
  });

  // 日数入力の変更を即時反映（debounce 200ms）
  let daysDebounce = null;
  if (els.hcDaysInput) {
    els.hcDaysInput.addEventListener('input', () => {
      if (daysDebounce) clearTimeout(daysDebounce);
      daysDebounce = setTimeout(() => {
        const next = normalizeHideCheckedDays(els.hcDaysInput.value);
        if (next !== settingsState.hideCheckedAfterDays) {
          settingsState.hideCheckedAfterDays = next;
          persistHideCheckedDays();
          updateHideCheckedToggleLabel();
          if (boardState.current) renderBoard();
        }
        if (String(next) !== els.hcDaysInput.value) {
          els.hcDaysInput.value = String(next);
        }
      }, 200);
    });
  }

  // 今だけ全表示トグル
  if (els.hcRevealAll) {
    els.hcRevealAll.addEventListener('change', () => {
      uiState.showHiddenGlobal = !!els.hcRevealAll.checked;
      updateHideCheckedToggleLabel();
      if (boardState.current) renderBoard();
    });
  }

  // F13: 開きっぱなしの画面でも閾値を跨いだら自然に消えるよう、1 分ごとに再描画する。
  setInterval(() => {
    if (!boardState.current) return;
    if (settingsState.hideCheckedAfterDays <= 0) return;
    if (uiState.showHiddenGlobal) return;
    renderBoard();
  }, 60_000);
}
