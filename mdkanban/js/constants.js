// 定数モジュール: マジックナンバー・LocalStorage / IndexedDB のキー・共通正規表現
// 数値リテラルや状態キーの単一の正典。新規導入はここに名前付きで追加する。

// ファイル読み込みサイズの上限（5MB）。これを超える .md は拒否する。
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

// LocalStorage キー一覧（ファイル横断・全ボード共通の永続化）
export const STORAGE_KEYS = {
  content: 'mdkanban.lastContent',
  fileName: 'mdkanban.lastFileName',
  theme: 'mdkanban.theme',
  density: 'mdkanban.density',
  collapsedLanes: 'mdkanban.collapsedLanes',
  // F1: 折りたたみ中のカラム名（ファイル横断・全ボード共通の永続化）
  collapsedColumns: 'mdkanban.collapsedColumns',
  // F13: チェック済みカードを updatedAt から N 日経過したら自動非表示。
  //   number; 既定 7。0（および非正値）で機能 OFF。永続。
  hideCheckedAfterDays: 'mdkanban.hideCheckedAfterDays'
};

// F13: チェック済みカード自動非表示の既定値・許容範囲
export const HIDE_CHECKED_DEFAULT_DAYS = 7;
export const HIDE_CHECKED_MAX_DAYS = 365;

// IndexedDB: 直近に開いた FileSystemFileHandle を保存する。
// localStorage には JSON 不可な FSA ハンドルを格納できないため IDB を使う。
export const IDB_DB_NAME = 'mdkanban';
export const IDB_STORE = 'handles';
export const IDB_HANDLE_KEY = 'lastHandle';

// スイムレーン用の lane 名・タグ抽出に使う共通 character class（既存タグの記法と揃える）。
export const LANE_NAME_CHARS = 'A-Za-z0-9_\\-぀-ヿ㐀-鿿';
// デフォルトレーン（lane 未指定カードが集まる行）の表示名
export const DEFAULT_LANE_DISPLAY_NAME = '未分類';

// F12: カードの作成日時 / 最終更新日時を HTML コメントで md に保存する形式。
//   `<!-- Created: YYYY-MM-DD HH:mm:ss -->` / `<!-- Updated: ... -->`
//   秒は後方互換のため省略可（読み込み時）。書き出しは常に秒付き。
export const CARD_META_RE = /^<!--\s*(Created|Updated):\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s*-->$/;

// 自動保存のデバウンス（変更後この時間が経つと FSA / LS へ書き戻す）
export const AUTOSAVE_DEBOUNCE_MS = 800;
// DnD 直後の click 誤発火を抑制する時間窓（dragend から N ms 以内の click を無視）
export const POST_DND_CLICK_SUPPRESS_MS = 120;
// トースト自動消去時間（成功・警告）／（エラー）
export const TOAST_AUTO_HIDE_MS = 3500;
export const TOAST_ERROR_HIDE_MS = 6000;
// 自動保存ステータス「保存しました」表示のホールド時間
export const AUTOSAVE_SAVED_HOLD_MS = 1500;
// 自動保存致命エラー表示のホールド時間
export const AUTOSAVE_FATAL_HIDE_MS = 2500;
