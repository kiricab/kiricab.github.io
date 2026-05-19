// 自動保存（F11）: 800ms デバウンス → FSA に書き込み。
// io.js / actions.js から `getCurrentMarkdown` / `clearDirty` / `updateSaveControlsVisibility`
// を注入してもらうことで循環 import を避ける。各モジュール抽出後に
// main.js から `initAutosave({ ... })` を呼ぶ。

import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_SAVED_HOLD_MS,
  AUTOSAVE_FATAL_HIDE_MS
} from './constants.js';
import { els, showToast } from './dom.js';
import { fileState, autosaveState, boardState } from './state.js';
import { deleteHandleFromIdb } from './idb.js';

let _getCurrentMarkdown = () => '';
let _clearDirty = () => {};
let _updateSaveControlsVisibility = () => {};

/** 注入: io.js / actions.js から関数を渡してもらう。 */
export function initAutosave({ getCurrentMarkdown, clearDirty, updateSaveControlsVisibility }) {
  _getCurrentMarkdown = getCurrentMarkdown;
  _clearDirty = clearDirty;
  _updateSaveControlsVisibility = updateSaveControlsVisibility;
}

/**
 * 変更（DnD・編集・追加・削除）から 800ms デバウンスで自動保存する。
 * - fileState.fileHandle が無ければ何もしない（手動保存対象外）。
 * - 連続呼び出しは最後の呼び出しから 800ms 後に1回だけ実行。
 */
export function triggerAutoSave() {
  if (!fileState.fileHandle) return;
  if (autosaveState.timer) clearTimeout(autosaveState.timer);
  autosaveState.timer = setTimeout(() => {
    autosaveState.timer = null;
    autoSaveNow();
  }, AUTOSAVE_DEBOUNCE_MS);
}

/** 自動保存を即時実行（手動「保存」ボタンや、デバウンス満了時に呼ばれる）。 */
export async function autoSaveNow() {
  if (!fileState.fileHandle || !boardState.current) return;
  if (autosaveState.pendingHide) {
    clearTimeout(autosaveState.pendingHide);
    autosaveState.pendingHide = null;
  }
  setAutoSaveStatus('saving');
  try {
    if (fileState.fileHandle.queryPermission) {
      const perm = await fileState.fileHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && fileState.fileHandle.requestPermission) {
        const req = await fileState.fileHandle.requestPermission({ mode: 'readwrite' });
        if (req !== 'granted') throw new Error('書き込み権限が拒否されました');
      }
    }
    const writable = await fileState.fileHandle.createWritable();
    const md = _getCurrentMarkdown();
    await writable.write(md);
    await writable.close();
    _clearDirty();
    setAutoSaveStatus('saved');
    autosaveState.pendingHide = setTimeout(() => {
      autosaveState.pendingHide = null;
      setAutoSaveStatus('idle');
    }, AUTOSAVE_SAVED_HOLD_MS);
  } catch (e) {
    setAutoSaveStatus('error');
    showToast('⚠ 保存に失敗しました。手動で「💾 保存」ボタンから再試行できます。', 'error');
    const fatal = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'InvalidStateError');
    if (fatal) {
      fileState.fileHandle = null;
      deleteHandleFromIdb();
      _updateSaveControlsVisibility();
      autosaveState.pendingHide = setTimeout(() => {
        autosaveState.pendingHide = null;
        setAutoSaveStatus('idle');
      }, AUTOSAVE_FATAL_HIDE_MS);
    }
  }
}

/** 自動保存ステータスを切り替えてインジケーターに反映 */
export function setAutoSaveStatus(status) {
  autosaveState.status = status;
  const el = els.saveStatus;
  if (!el) return;
  const LABELS = { saving: '💾 保存中…', saved: '✓ 保存済み', error: '⚠ 保存失敗', idle: '' };
  el.dataset.status = status;
  el.textContent = LABELS[status] || '';
  el.setAttribute('aria-hidden', status === 'idle' ? 'true' : 'false');
  refreshFileSaveStateUI();
}

/**
 * dirty と save-status は capsule 左外の同一スロットに重なって配置されているため、
 * 片方だけを opacity:1 にして見せる。
 * 優先順位: error / saving / saved（save-status が非idle）> dirty > なし。
 */
export function refreshFileSaveStateUI() {
  if (!els.dirtyMarker) return;
  const saveActive = autosaveState.status && autosaveState.status !== 'idle';
  const dirtyVisible = !saveActive && !!fileState.dirty;
  els.dirtyMarker.dataset.hidden = dirtyVisible ? 'false' : 'true';
  els.dirtyMarker.setAttribute('aria-hidden', dirtyVisible ? 'false' : 'true');
  if (dirtyVisible) {
    els.dirtyMarker.setAttribute('aria-label', '未保存の変更あり');
  } else {
    els.dirtyMarker.removeAttribute('aria-label');
  }
}
