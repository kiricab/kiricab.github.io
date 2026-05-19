// DOM 参照キャッシュ・トースト通知・ライブリージョン。
// 各機能モジュールはここから els / showToast / announceDnd を import する。
//
// `<script type="module">` は defer されるため、本モジュールの top-level で
// `document.getElementById` を実行しても DOM は確実にパース済み。

import { TOAST_AUTO_HIDE_MS, TOAST_ERROR_HIDE_MS } from './constants.js';

const $ = (id) => document.getElementById(id);

export const els = {
  body: document.body,
  fileInput: $('file-input'),
  openFileBtn: $('open-file-btn'),
  newBoardBtn: $('new-board-btn'),
  themeToggle: $('theme-toggle'),
  densityToggle: $('density-toggle'),
  // オーバーフローメニュー
  overflowMenuToggle: $('overflow-menu-toggle'),
  overflowMenu: $('overflow-menu'),
  // 非FSA環境用 ツールバー昇格 DL/Copy
  toolbarReloadBtn: $('toolbar-reload-btn'),
  toolbarDownloadBtn: $('toolbar-download-btn'),
  toolbarCopyBtn: $('toolbar-copy-btn'),
  // F13: 完了済みカード表示設定
  hideCheckedToggle: $('hide-checked-toggle'),
  hideCheckedPopover: $('hide-checked-popover'),
  hcDaysInput: $('hc-days-input'),
  hcRevealAll: $('hc-reveal-all'),
  fileNameDisplay: $('file-name-display'),
  restoreBanner: $('restore-banner'),
  restoreYesBtn: $('restore-yes-btn'),
  restoreNoBtn: $('restore-no-btn'),
  tagFilterBar: $('tag-filter-bar'),
  activeTagDisplay: $('active-tag-display'),
  clearFilterBtn: $('clear-filter-btn'),
  emptyState: $('empty-state'),
  boardSection: $('board-section'),
  boardTitle: $('board-title'),
  boardStats: $('board-stats'),
  kanbanBoard: $('kanban-board'),
  emptyOpenBtn: $('empty-open-btn'),
  emptyNewBtn: $('empty-new-btn'),
  emptyFsaNote: $('empty-fsa-note'),
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
  cmeLane: $('cme-lane'),
  cmeColumn: $('cme-column'),
  cmeDue: $('cme-due'),
  cmeFieldLane: $('cme-field-lane'),
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

/**
 * 通知の単一窓口。すべての成功/警告/エラーは右下の固定トースト領域に出す。
 * @param {string} message
 * @param {'success'|'warning'|'error'} [type='success']
 * @param {boolean} [autoHide=true]
 */
export function showStatus(message, type = 'success', autoHide = true) {
  if (!els.toastArea) return null;
  const div = document.createElement('div');
  div.className = `toast ${type}`.trim();
  div.textContent = message;
  els.toastArea.appendChild(div);
  if (autoHide) {
    setTimeout(() => {
      if (div.parentNode) div.parentNode.removeChild(div);
    }, type === 'error' ? TOAST_ERROR_HIDE_MS : TOAST_AUTO_HIDE_MS);
  }
  return div;
}

export function clearStatus() {
  if (els.toastArea) els.toastArea.innerHTML = '';
}

/** showStatus の薄いラッパ（互換のために残す） */
export function showToast(message, type) {
  return showStatus(message, type || 'success', true);
}

/** ライブリージョンに通知（読み上げソフト向け） */
export function announceDnd(message) {
  if (els.dndLiveRegion) {
    els.dndLiveRegion.textContent = message;
  }
}
