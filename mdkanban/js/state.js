// 状態モジュール: もとの 14 フィールドの `state` バッグを 6 スライスに分割した。
// 各スライスはプレーンなオブジェクトで、関心ごと（コンテンツ・UI・編集・設定・ファイル・自動保存）
// に対応する。書き手と読み手を明確にする目的のための分割なので、ランタイムでは引き続きミューテーブル。
//
// 書き手・読み手の意図:
//   boardState   write: io / markdown / actions   read: render
//   uiState      write: render(タグフィルタ) / actions(折りたたみ等) / theme(popover) read: render
//   editingState write: actions / dnd            read: render / events / dnd
//   settingsState write: theme(hide-checked)     read: render / utils
//   fileState    write: io / autosave / actions   read: io / autosave / events
//   autosaveState write: autosave                read: autosave / io
//
// なお、テーマ・密度は body[data-theme] / body data-density に直接書かれており、
// JS の状態としては保持しない。

import { HIDE_CHECKED_DEFAULT_DAYS } from './constants.js';

/** ボードコンテンツ・最終シリアライズ済み Markdown など */
export const boardState = {
  /** パース済みのカンバンボード（null = 未読み込み） */
  current: null,
  /** 最後にシリアライズした Markdown（保存系で使い回し） */
  serializedMarkdown: null,
  /** 集中モード: SEO 詳細を初回ボード読込時に1度だけ自動で畳む */
  seoAutoCollapsed: false
};

/** UI 状態（タグフィルタ・折りたたみ・一時 reveal など） */
export const uiState = {
  /** 現在絞り込み中のタグ名（null で絞り込みなし） */
  activeTagFilter: null,
  /** 折りたたみ中の lane 名（LocalStorage と同期） */
  collapsedLanes: new Set(),
  /** F1: 折りたたみ中のカラム名（LocalStorage と同期・ファイル横断） */
  collapsedColumns: new Set(),
  /** 一時 reveal: カラム名単位の per-column reveal（リロードでリセット） */
  revealedHiddenColumns: new Set(),
  /** 一時 reveal: ツールバーの「今だけ全て表示」（リロードでリセット） */
  showHiddenGlobal: false,
  /** hide-checked ポップオーバーの開閉状態 */
  hideCheckedPopoverOpen: false
};

/** 編集状態・DnD 状態・モーダル状態 */
export const editingState = {
  /**
   * インライン編集状態: { cardId, mode: 'inline', isNew: boolean, originalTitle: string }
   * モーダル編集状態:    { cardId, mode: 'modal' }
   */
  editing: null,
  /** モーダルが開いているカードの参照 */
  currentModalCard: null,
  /** モーダルを開く前にフォーカスのあった要素（閉じた後に戻す） */
  lastFocusBeforeModal: null,
  /** DnD中: { cardId, fromColIdx, fromCardIdx, fromLane } */
  dragging: null,
  /** dragend → 短時間 click が走る端末向けに、N ms 以内のclickを無視するためのタイムスタンプ */
  suppressClickUntil: 0
};

/** ユーザー設定（永続） */
export const settingsState = {
  /** F13: チェック済みカード自動非表示の閾値。0 以下で機能 OFF。永続。 */
  hideCheckedAfterDays: HIDE_CHECKED_DEFAULT_DAYS
};

/** ファイル接続状態（現在開いているファイル名・FSA ハンドル・未保存フラグ） */
export const fileState = {
  fileName: '',
  /** FSA経由で取得した FileSystemFileHandle（未取得時 null） */
  fileHandle: null,
  /** DnD・編集後の未保存フラグ */
  dirty: false
};

/** 自動保存系（タイマー ID・現在ステータス・インジケータ消去用タイマー） */
export const autosaveState = {
  /** setTimeout のID（debounce 用） */
  timer: null,
  /** 'idle' | 'saving' | 'saved' | 'error' */
  status: 'idle',
  /** 「✓ 保存済み」消去用 setTimeout */
  pendingHide: null
};

// ---------- カード ID カウンター ----------
// パース毎にリセットし、それ以外ではカードを増やすごとにインクリメントする。
let cardIdCounter = 0;
export function nextCardId() { cardIdCounter += 1; return cardIdCounter; }
export function resetCardIdCounter() { cardIdCounter = 0; }
export function currentCardIdCounter() { return cardIdCounter; }
