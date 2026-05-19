// Markdown ⇔ board モデルの変換層（純粋関数）。
// パース: parseKanban (extractFrontmatter, reparseTitleMeta を含む)
// シリアライズ: serializeBoard
// 補助: assignIds, buildCardMarkdownForModal
//
// 完全保証: frontmatter / H1 / H2 / チェック状態 / #tag / @日付 / サブタスク / F12 メタコメント
// ベストエフォート: bodyParts段落の空行数、コードブロック内の空白構造

import { LANE_NAME_CHARS, CARD_META_RE } from './constants.js';
import { indentWidth, yamlScalarValue } from './utils.js';
import { resetCardIdCounter, nextCardId } from './state.js';

/**
 * frontmatter (---で囲まれたYAML風ブロック) を切り出す。
 * 戻り値:
 *   {
 *     frontmatter: { [key]: stringValue },
 *     lanes: string[] | null,
 *     hasLanesKey: boolean,
 *     autoCheckColumns: string[] | null,
 *     hasAutoCheckColumnsKey: boolean,
 *     otherKeysRaw: string,
 *     body: string,
 *     frontmatterRaw: string
 *   }
 */
export function extractFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) {
    return {
      frontmatter: {},
      lanes: null,
      hasLanesKey: false,
      autoCheckColumns: null,
      hasAutoCheckColumnsKey: false,
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
  let hasAutoCheckColumnsKey = false;
  let autoCheckArr = null;
  let inAutoCheckBlock = false;

  function unquote(val) {
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      return val.slice(1, -1);
    }
    return val;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inLanesBlock) {
      const itemMatch = line.match(/^\s+-\s+(.*)$/);
      if (itemMatch) {
        const val = unquote(itemMatch[1].trim());
        if (val !== '' && !lanesArr.includes(val)) lanesArr.push(val);
        continue;
      }
      inLanesBlock = false;
      if (line.trim() === '') continue;
    }
    if (inAutoCheckBlock) {
      const itemMatch = line.match(/^\s+-\s+(.*)$/);
      if (itemMatch) {
        const val = unquote(itemMatch[1].trim());
        if (val !== '' && !autoCheckArr.includes(val)) autoCheckArr.push(val);
        continue;
      }
      inAutoCheckBlock = false;
      if (line.trim() === '') continue;
    }

    const lanesHeader = line.match(/^lanes\s*:\s*(.*)$/);
    if (lanesHeader) {
      hasLanesKey = true;
      lanesArr = lanesArr || [];
      const inlineVal = lanesHeader[1].trim();
      if (inlineVal === '' || inlineVal === '[]') {
        inLanesBlock = (inlineVal === '');
      } else {
        const flow = inlineVal.match(/^\[(.*)\]$/);
        if (flow) {
          flow[1].split(',').forEach(part => {
            const v = unquote(part.trim());
            if (v !== '' && !lanesArr.includes(v)) lanesArr.push(v);
          });
        }
        inLanesBlock = false;
      }
      continue;
    }

    const autoCheckHeader = line.match(/^auto-check-columns\s*:\s*(.*)$/);
    if (autoCheckHeader) {
      hasAutoCheckColumnsKey = true;
      autoCheckArr = autoCheckArr || [];
      const inlineVal = autoCheckHeader[1].trim();
      if (inlineVal === '' || inlineVal === '[]') {
        inAutoCheckBlock = (inlineVal === '');
      } else {
        const flow = inlineVal.match(/^\[(.*)\]$/);
        if (flow) {
          flow[1].split(',').forEach(part => {
            const v = unquote(part.trim());
            if (v !== '' && !autoCheckArr.includes(v)) autoCheckArr.push(v);
          });
        }
        inAutoCheckBlock = false;
      }
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (kv) {
      const val = unquote(kv[2].trim());
      fm[kv[1]] = val;
      otherLines.push(line);
      continue;
    }
    otherLines.push(line);
  }

  while (otherLines.length && otherLines[otherLines.length - 1].trim() === '') {
    otherLines.pop();
  }

  return {
    frontmatter: fm,
    lanes: hasLanesKey ? lanesArr : null,
    hasLanesKey,
    autoCheckColumns: hasAutoCheckColumnsKey ? autoCheckArr : null,
    hasAutoCheckColumnsKey,
    otherKeysRaw: otherLines.join('\n'),
    body: md.slice(m[0].length),
    frontmatterRaw: m[0]
  };
}

/**
 * カード生タイトル文字列から lane / tags / dueDate / displayTitle を抽出する。
 *   - swimlaneMode=true  : `#lane/X` を専用記法として認識し、tags に混入させず displayTitle から除去する
 *   - swimlaneMode=false : `#lane/X` を通常のタグバッジ（tag 値 = `lane/X`）として扱い、displayTitle に残す
 */
export function reparseTitleMeta(rawTitle, swimlaneMode) {
  let lane = '';
  let displayTitle = rawTitle;
  const tags = [];

  if (swimlaneMode) {
    const laneRe = new RegExp(`(?:^|\\s)#lane\\/([${LANE_NAME_CHARS}]+)`);
    const laneMatch = rawTitle.match(laneRe);
    lane = laneMatch ? laneMatch[1] : '';
    const tagRe = new RegExp(`(?:^|\\s)#(?!lane\\/)([${LANE_NAME_CHARS}]+)`, 'g');
    let mt;
    while ((mt = tagRe.exec(rawTitle)) !== null) {
      if (!tags.includes(mt[1])) tags.push(mt[1]);
    }
    displayTitle = rawTitle
      .replace(new RegExp(`(?:^|\\s)#lane\\/[${LANE_NAME_CHARS}]+(?:\\/[${LANE_NAME_CHARS}]+)*`, 'g'), ' ')
      .replace(new RegExp(`(?:^|\\s)#[${LANE_NAME_CHARS}]+`, 'g'), ' ')
      .replace(/(?:^|\s)@\d{4}-\d{2}-\d{2}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    const tagRe = new RegExp(`(?:^|\\s)#([${LANE_NAME_CHARS}]+(?:\\/[${LANE_NAME_CHARS}]+)*)`, 'g');
    let mt;
    while ((mt = tagRe.exec(rawTitle)) !== null) {
      if (!tags.includes(mt[1])) tags.push(mt[1]);
    }
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

/**
 * 列・カードに連番IDを振る。永続化はしないが、DnDのドロップ時に
 * カードを一意に識別するために使う（再パース毎に振り直す）。
 */
export function assignIds(board) {
  resetCardIdCounter();
  board.columns.forEach((col, ci) => {
    col.id = `col-${ci}`;
    col.cards.forEach((card) => {
      card.id = `c-${nextCardId()}`;
    });
  });
}

/**
 * パース：見出し/箇条書き/段落をブロック単位に切り出してカンバン構造を作る。
 *
 * 戻り値: { title, columns: [{ name, cards }], warnings: string[], frontmatterRaw, ... }
 * cardの構造: { title, displayTitle, tags, lane, dueDate, checked, subtasks, bodyParts, createdAt, updatedAt }
 */
export function parseKanban(md) {
  const fmInfo = extractFrontmatter(md);
  const { frontmatter, body, frontmatterRaw, hasLanesKey, otherKeysRaw } = fmInfo;
  const lanesWhitelist = hasLanesKey ? (fmInfo.lanes || []) : null;
  const autoCheckColumnsRaw = fmInfo.hasAutoCheckColumnsKey ? (fmInfo.autoCheckColumns || []) : null;
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  const result = {
    title: frontmatter.title || '',
    columns: [],
    warnings: [],
    frontmatterRaw: frontmatterRaw || '',
    hasLanesKey: !!hasLanesKey,
    lanesWhitelist: lanesWhitelist ? [...lanesWhitelist] : null,
    autoCheckColumns: autoCheckColumnsRaw ? [...autoCheckColumnsRaw] : [],
    otherFrontmatterRaw: otherKeysRaw || ''
  };

  let currentColumn = null;
  let currentCard = null;
  let currentCardBaseIndent = 0;
  let currentCardBodyLines = [];
  let sawH2 = false;
  let sawH1 = false;

  function flushCardBody() {
    if (currentCard && currentCardBodyLines.length) {
      currentCard.bodyParts.push(currentCardBodyLines.join('\n'));
      currentCardBodyLines = [];
    }
  }

  function buildCard(rawTitle, checked) {
    const swimlaneMode = !!hasLanesKey;
    const card = reparseTitleMeta(rawTitle, swimlaneMode);
    card.checked = checked;
    card.subtasks = [];
    card.bodyParts = [];
    // F12: メタコメント無しカードはタイムスタンプを null のまま保持
    card.createdAt = null;
    card.updatedAt = null;
    return card;
  }

  let unsortedColumn = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine;
    const trimmed = line.trim();

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

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      sawH2 = true;
      flushCardBody();
      currentCard = null;
      currentColumn = { name: h2[1].trim(), cards: [] };
      result.columns.push(currentColumn);
      continue;
    }

    const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bullet) {
      const indent = indentWidth(bullet[1]);
      const itemText = bullet[3];
      const cb = itemText.match(/^\[( |x|X)\]\s+(.*)$/);
      const checked = cb ? (cb[1].toLowerCase() === 'x') : null;
      const text = cb ? cb[2] : itemText;

      if (currentCard && indent > currentCardBaseIndent) {
        flushCardBody();
        currentCard.subtasks.push({
          title: text.trim(),
          checked: cb ? checked : false
        });
        continue;
      }

      flushCardBody();
      const card = buildCard(text, checked);
      if (currentColumn) {
        currentColumn.cards.push(card);
      } else {
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

    if (currentCard) {
      if (trimmed === '') {
        if (currentCardBodyLines.length) {
          currentCard.bodyParts.push(currentCardBodyLines.join('\n'));
          currentCardBodyLines = [];
        }
        continue;
      }
      const lineIndent = indentWidth(rawLine);
      if (lineIndent > currentCardBaseIndent || lineIndent >= 2) {
        const metaMatch = trimmed.match(CARD_META_RE);
        if (metaMatch) {
          if (currentCardBodyLines.length) {
            currentCard.bodyParts.push(currentCardBodyLines.join('\n'));
            currentCardBodyLines = [];
          }
          if (metaMatch[1] === 'Created') currentCard.createdAt = metaMatch[2];
          else currentCard.updatedAt = metaMatch[2];
          continue;
        }
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
      flushCardBody();
      currentCard = null;
    }
  }

  flushCardBody();

  if (!sawH2) {
    if (unsortedColumn && unsortedColumn.cards.length > 0) {
      unsortedColumn.name = 'カード';
      result.columns.push(unsortedColumn);
      result.warnings.push('## 見出しが見つからなかったため、すべてのカードを1列にまとめました');
    }
  } else {
    if (unsortedColumn && unsortedColumn.cards.length > 0) {
      result.columns.unshift(unsortedColumn);
    }
  }

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
  } else {
    result.lanes = [{ id: 'lane-default', name: '' }];
  }
  result.useSwimlanes = true;

  // F2-A-6: 現在の columns に存在しないカラム名は黙って除去（孤児エントリの自動掃除）
  if (result.autoCheckColumns && result.autoCheckColumns.length > 0) {
    const validColNames = new Set(result.columns.map(c => c.name));
    result.autoCheckColumns = result.autoCheckColumns.filter(n => validColNames.has(n));
  }

  // F2: 自動チェック対象カラムに所属する全カードの checked を強制 true に同期する（同期型）。
  if (result.autoCheckColumns && result.autoCheckColumns.length > 0) {
    const autoSet = new Set(result.autoCheckColumns);
    result.columns.forEach(col => {
      if (autoSet.has(col.name)) {
        col.cards.forEach(c => { c.checked = true; });
      }
    });
  }

  assignIds(result);
  return result;
}

// ---------- シリアライズ（内部分割） ----------

/**
 * frontmatter ブロック（`---` 含む）を返す。
 * - 他キー: board.otherFrontmatterRaw を末尾空白を除去して貼り戻す
 * - lanes: 未分類レーン（name=''）を除く順序で出力。空配列ならキーごと省略
 * - auto-check-columns: 配列が非空のときのみ出力
 * - 全部空なら frontmatter ブロックごと省略（空文字を返す）
 */
function serializeFrontmatter(board) {
  const otherRaw = (board.otherFrontmatterRaw || '').replace(/\s+$/, '');
  const realLanes = (board.lanes || []).filter(l => l.name !== '');
  const hasLanes = !!board.hasLanesKey && realLanes.length > 0;
  const autoCheckCols = Array.isArray(board.autoCheckColumns) ? board.autoCheckColumns.slice() : [];
  const hasAutoCheck = autoCheckCols.length > 0;
  const otherLines = otherRaw ? otherRaw.split('\n') : [];
  if (otherLines.length === 0 && !hasLanes && !hasAutoCheck) return '';

  const out = ['---\n'];
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
  if (hasAutoCheck) {
    out.push('auto-check-columns:\n');
    for (const name of autoCheckCols) {
      out.push(`  - ${yamlScalarValue(name)}\n`);
    }
  }
  out.push('---\n\n');
  return out.join('');
}

/**
 * 1枚のカードを Markdown 行群に変換して push する（インプレース）。
 * - lanes: 宣言があるファイルは `#lane/X` を一度全削除し、card.lane があれば末尾に付け直す
 * - lanes: 宣言が無いファイルは card.title の `#lane/X` をそのまま貼り戻す（従来通り）
 */
function serializeCard(card, board, out) {
  let prefix;
  if (card.checked === true) prefix = '- [x] ';
  else if (card.checked === false) prefix = '- [ ] ';
  else prefix = '- ';

  let serializedTitle = card.title;
  if (board.hasLanesKey) {
    const laneStripRe = new RegExp(`(?:^|\\s)#lane\\/[${LANE_NAME_CHARS}]+(?:\\/[${LANE_NAME_CHARS}]+)*`, 'g');
    serializedTitle = serializedTitle.replace(laneStripRe, ' ').replace(/\s+/g, ' ').trim();
    if (card.lane) {
      serializedTitle = serializedTitle ? `${serializedTitle} #lane/${card.lane}` : `#lane/${card.lane}`;
    }
  }
  out.push(`${prefix}${serializedTitle}\n`);

  card.subtasks.forEach((s) => {
    const sp = s.checked ? '- [x] ' : '- [ ] ';
    out.push(`  ${sp}${s.title}\n`);
  });

  card.bodyParts.forEach((part, idx) => {
    const indented = part.split('\n').map((ln) => ln.length ? `  ${ln}` : '').join('\n');
    out.push(`${indented}\n`);
    if (idx < card.bodyParts.length - 1) {
      out.push('\n');
    }
  });

  // F12: タイムスタンプは最下部固定。null は出さない。
  if (card.createdAt) out.push(`  <!-- Created: ${card.createdAt} -->\n`);
  if (card.updatedAt) out.push(`  <!-- Updated: ${card.updatedAt} -->\n`);
}

/** 1列分（`## 名前` + 全カード）の Markdown を out に push する。 */
function serializeColumn(col, board, isLast, out) {
  out.push(`## ${col.name}\n\n`);
  col.cards.forEach((card) => serializeCard(card, board, out));
  if (!isLast) out.push('\n');
}

/**
 * board を Markdown 文字列に再シリアライズする。
 * 完全保証: frontmatter / H1 / H2 / チェック状態 / #tag / @日付 / サブタスク / F12 メタ
 * ベストエフォート: bodyParts段落の空行数、コードブロック内の空白構造。
 */
export function serializeBoard(board) {
  const out = [];
  const fmStr = serializeFrontmatter(board);
  if (fmStr) out.push(fmStr);
  if (board.title) out.push(`# ${board.title}\n\n`);
  board.columns.forEach((col, colIdx) => {
    serializeColumn(col, board, colIdx === board.columns.length - 1, out);
  });
  // 連続改行を最大2個（=空行1個）までに切り詰める（保険）
  return out.join('').replace(/\n{3,}/g, '\n\n');
}

/**
 * モーダル詳細表示用に、カード本文（bodyParts）部分のみを Markdown として返す。
 * サブタスクは含めない（モーダル側でリストとして組み立てるため）。
 */
export function buildCardMarkdownForModal(card) {
  let md = '';
  if (card.bodyParts.length > 0) {
    md += card.bodyParts.join('\n\n') + '\n\n';
  }
  return md;
}
