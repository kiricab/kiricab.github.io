// 純関数のユーティリティ集。DOM・グローバル状態に触れない関数のみここに置く。
// （DOM 触る showStatus / showToast / announceDnd は dom.js 抽出時に移管予定）

// ---------- 文字列 / 正規表現 ----------

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 正規表現の特殊文字をエスケープ */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** CSS attribute selector 用エスケープ（簡易版） */
export function cssEscape(s) {
  if (typeof window !== 'undefined' && window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(s);
  }
  return String(s).replace(/["\\]/g, '\\$&');
}

// ---------- タイムスタンプ ----------

/** 現在時刻をローカル `YYYY-MM-DD HH:mm:ss` 文字列で返す。 */
export function nowLocalTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * カードの updatedAt を現在時刻に更新する。
 * createdAt が null のカード（既存 md にメタコメントが無く、本ツール導入前から存在していたカード）は
 * **触らずに null のまま残す**。これにより「作成時刻は不明だが更新は記録できる」状態を
 * 正直に表現し、UI 上は `作成: —` のままになる。新規作成カードは addNewCard 側で
 * createdAt = updatedAt = 現在時刻が初期化されるため、この関数は updatedAt のみ更新すればよい。
 */
export function bumpCardTimestamps(card) {
  if (!card) return;
  card.updatedAt = nowLocalTimestamp();
}

/** モーダル表示用 `YYYY-MM-DD HH:mm` 文字列（秒を切り詰め）。null → '—'。 */
export function formatTimestampLong(s) {
  if (!s) return '—';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::\d{2})?$/);
  return m ? `${m[1]} ${m[2]}` : s;
}

/** カード表面用の短縮表示 `M/D HH:mm`。null → '—'。 */
export function formatTimestampShort(s) {
  if (!s) return '—';
  const m = s.match(/^\d{4}-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/);
  return m ? `${parseInt(m[1], 10)}/${parseInt(m[2], 10)} ${m[3]}` : s;
}

/** `<time datetime="...">` 属性用の ISO 風文字列。値が無ければ ''。 */
export function timestampToIsoAttr(s) {
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)$/);
  return m ? `${m[1]}T${m[2]}` : '';
}

// ---------- F13: チェック済みカード自動非表示判定（純関数） ----------

/**
 * F13: チェック済みカード自動非表示の判定（純粋関数）。
 * - thresholdDays が 0 以下 → 機能 OFF → 常に false
 * - card.checked !== true → false
 * - updatedAt が null（メタ未設定のレガシーカード）→ 「十分古い」と見なし true
 * - それ以外は (now - updatedAt) >= thresholdDays で判定
 *
 * 注: 「カードを実際に DOM から消すか」は呼び出し側で
 *      state.showHiddenGlobal / state.revealedHiddenColumns との AND を取って決める。
 */
export function isCardCheckedHidden(card, thresholdDays) {
  if (!thresholdDays || thresholdDays <= 0) return false;
  if (!card || card.checked !== true) return false;
  if (!card.updatedAt) return true;
  const t = Date.parse(card.updatedAt.replace(' ', 'T'));
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) >= thresholdDays * 86400000;
}

// ---------- Markdown / YAML 補助 ----------

/**
 * 行頭インデント幅を計算（タブ=4スペース換算）。
 */
export function indentWidth(line) {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w++;
    else if (ch === '\t') w += 4;
    else break;
  }
  return w;
}

/**
 * YAML スカラー値の出力エスケープ。
 * 予約文字（`:` `#` `-` 先頭, `'`, `"`, `[`, `]`, `{`, `}`, `,`, `&`, `*`, `!`, `|`, `>`, `?`, `%`, `@`, `\``）
 * を含む場合のみダブルクォートで囲む。レーン名のバリデーションが効いている前提で
 * MVP では基本的にクォート不要だが、保険として実装しておく。
 */
export function yamlScalarValue(s) {
  if (s === '') return '""';
  const needsQuote = /^[\s\-?:,\[\]\{\}#&*!|>'"%@`]|[:#]\s|[\r\n]/.test(s);
  if (!needsQuote) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
