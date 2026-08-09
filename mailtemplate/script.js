/* メールテンプレート作成ツール
 * 完全クライアントサイド。外部ライブラリ・外部通信なし。
 */
(function () {
    'use strict';

    // ==================== 定数 ====================
    var STORAGE_KEY = 'mailtemplate_v1';
    var SCHEMA_VERSION = 1;
    var MAX_TEMPLATES = 50;
    var MAILTO_WARN_LEN = 1800;
    var MAX_IMPORT_BYTES = 2 * 1024 * 1024;
    var PREVIEW_DEBOUNCE_MS = 150;
    var AUTO_DETECT_DEBOUNCE_MS = 600;

    var VAR_PATTERN = '\\{\\{([^}\\n]{1,40})\\}\\}';

    var VAR_TYPES = [
        { value: 'text', label: '1行テキスト' },
        { value: 'email', label: 'メールアドレス' },
        { value: 'textarea', label: '複数行テキスト' },
        { value: 'select', label: '選択肢' },
        { value: 'date', label: '日付（自動計算）' }
    ];

    /* 変数ブロックとフロートメニューを効かせる入力欄。
       kind ごとに使える変数の型が変わる（宛先はメールアドレスのみ等） */
    var FIELD_SPECS = [
        { id: 'edit-to', field: 'to', highlightId: 'to-highlight', warnId: 'edit-to-warn', kind: 'address', label: '宛先 To', multiline: false },
        { id: 'edit-cc', field: 'cc', highlightId: 'cc-highlight', warnId: 'edit-cc-warn', kind: 'address', label: 'Cc', multiline: false },
        { id: 'edit-bcc', field: 'bcc', highlightId: 'bcc-highlight', warnId: 'edit-bcc-warn', kind: 'address', label: 'Bcc', multiline: false },
        { id: 'edit-subject', field: 'subject', highlightId: 'subject-highlight', kind: 'subject', label: '件名', multiline: false },
        { id: 'edit-body', field: 'body', highlightId: 'body-highlight', kind: 'body', label: '本文', multiline: true }
    ];

    /* 欄の種類ごとに許す変数の型。
       宛先はメールアドレスのみ。件名は改行が入ると壊れるので複数行テキストを禁止 */
    var FIELD_KIND_TYPES = {
        address: ['email'],
        subject: ['text', 'email', 'select', 'date'],
        body: ['text', 'email', 'textarea', 'select', 'date']
    };

    function fieldKindAllowsType(kind, type) {
        var allowed = FIELD_KIND_TYPES[kind];
        return !allowed || allowed.indexOf(type) >= 0;
    }

    /** 使われている欄すべてで許される型に寄せる。
        自動認識が欄の制約に反する型を付けてしまうと、書いた直後に
        保存できない状態になってしまうため必ず通す */
    function clampTypeForKinds(type, kinds) {
        var ok = kinds.every(function (k) { return fieldKindAllowsType(k, type); });
        if (ok) return type;
        if (kinds.indexOf('address') !== -1) return 'email';
        return 'text';
    }

    var DATE_BASES = [
        { value: 'today', label: '今日' },
        { value: 'tomorrow', label: '明日' },
        { value: 'yesterday', label: '昨日' },
        { value: 'monthStart', label: '今月の初日' },
        { value: 'monthEnd', label: '今月の末日' },
        { value: 'nextMonthStart', label: '翌月の初日' },
        { value: 'nextMonthEnd', label: '翌月の末日' }
    ];

    var DATE_UNITS = [
        { value: 'day', label: '日' },
        { value: 'businessDay', label: '営業日（土日を除く）' },
        { value: 'month', label: 'か月' }
    ];

    var DATE_FORMATS = [
        'YYYY年M月D日(ddd)',
        'YYYY/MM/DD',
        'YYYY-MM-DD',
        'M月D日',
        'YYYY年M月',
        'HH:mm'
    ];

    /* 変数名から種類・書式・基準日を推定するルール。上から順に最初に一致したものを使う。
       推定結果は必ず UI 上で変更できるようにすること。
       「担当」「毎日」などへの誤爆を避けるため、単独の「日」は末尾一致に限る */
    var NAMING_RULES = [
        // --- 日付（相対指定を伴うもの）---
        { test: /期限|締切|〆切|納期/, reason: '日付（期限）',
          v: { type: 'date', base: 'today', offset: 5, offsetUnit: 'businessDay', format: 'M月D日(ddd)' } },
        { test: /前月|先月|対象月|請求月/, reason: '日付（前月）',
          v: { type: 'date', base: 'today', offset: -1, offsetUnit: 'month', format: 'YYYY年M月' } },
        { test: /翌月|来月/, reason: '日付（翌月）',
          v: { type: 'date', base: 'today', offset: 1, offsetUnit: 'month', format: 'YYYY年M月' } },
        { test: /月末/, reason: '日付（月末）',
          v: { type: 'date', base: 'monthEnd', offset: 0, offsetUnit: 'day', format: 'YYYY年M月D日(ddd)' } },
        { test: /月初/, reason: '日付（月初）',
          v: { type: 'date', base: 'monthStart', offset: 0, offsetUnit: 'day', format: 'YYYY年M月D日(ddd)' } },
        // --- 日付（書式違い）---
        { test: /時刻|時間/, reason: '日付（時刻）',
          v: { type: 'date', base: 'today', offset: 0, offsetUnit: 'day', format: 'HH:mm' } },
        { test: /曜日/, reason: '日付（曜日）',
          v: { type: 'date', base: 'today', offset: 0, offsetUnit: 'day', format: 'ddd' } },
        { test: /年月$|^年月/, reason: '日付（年月）',
          v: { type: 'date', base: 'today', offset: 0, offsetUnit: 'day', format: 'YYYY年M月' } },
        { test: /月$/, reason: '日付（年月）',
          v: { type: 'date', base: 'today', offset: 0, offsetUnit: 'day', format: 'YYYY年M月' } },
        { test: /日付|年月日|日$/, reason: '日付',
          v: { type: 'date', base: 'today', offset: 0, offsetUnit: 'day', format: 'YYYY年M月D日(ddd)' } },
        // --- 日付以外 ---
        { test: /メール|メアド|アドレス|mail/i, reason: 'メールアドレス',
          v: { type: 'email', placeholder: '例: taro@example.com' } },
        { test: /部署|部門|区分|種別|カテゴリ|担当部/, reason: '選択肢', v: { type: 'select' } },
        { test: /備考|補足|詳細|メモ|本文|内容|コメント|理由/, reason: '複数行テキスト', v: { type: 'textarea' } },
        { test: /金額|価格|料金|費用|単価|合計/, reason: '1行テキスト（金額）',
          v: { type: 'text', placeholder: '例: 120,000' } }
    ];

    /** 変数名から既定の設定を推定する。一致しなければ 1 行テキスト */
    function guessVariableSpec(name) {
        var s = String(name == null ? '' : name);
        var spec = { type: 'text' };
        if (!s) return spec;
        for (var i = 0; i < NAMING_RULES.length; i++) {
            if (NAMING_RULES[i].test.test(s)) {
                var r = NAMING_RULES[i];
                var out = { reason: r.reason };
                for (var k in r.v) { if (Object.prototype.hasOwnProperty.call(r.v, k)) out[k] = r.v[k]; }
                return out;
            }
        }
        return spec;
    }

    // メールクライアント互換のため引用符なしのフォントスタックを使う
    var FONT_STACKS = {
        'sans-serif': '-apple-system, BlinkMacSystemFont, Hiragino Kaku Gothic ProN, Meiryo, sans-serif',
        'serif': 'Hiragino Mincho ProN, Yu Mincho, MS PMincho, serif',
        'monospace': 'SFMono-Regular, Menlo, Consolas, monospace',
        'meiryo': 'Meiryo, Hiragino Kaku Gothic ProN, sans-serif'
    };

    var DEFAULT_STYLE = {
        fontFamily: 'sans-serif',
        fontSize: '14px',
        color: '#333333',
        background: '#ffffff',
        lineHeight: '1.7',
        linkColor: '#1e3a8a',
        maxWidth: '600px',
        customCss: ''
    };

    var WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
    var DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // ==================== 汎用ユーティリティ ====================
    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function uid() {
        return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
            switch (c) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                default: return '&#39;';
            }
        });
    }

    /** 要素生成ヘルパー。テキストは常に textContent 経由で入れる（XSS 対策） */
    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                var v = attrs[k];
                if (v == null || v === false) return;
                if (k === 'class') node.className = v;
                else if (k === 'text') node.textContent = v;
                else if (v === true) node.setAttribute(k, '');
                else node.setAttribute(k, v);
            });
        }
        if (children) {
            (Array.isArray(children) ? children : [children]).forEach(function (c) {
                if (c == null) return;
                node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
            });
        }
        return node;
    }

    function clearNode(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function buildSelect(options, selected, attrs) {
        var sel = el('select', attrs);
        options.forEach(function (opt) {
            var o = el('option', { value: opt.value, text: opt.label });
            if (opt.value === selected) o.selected = true;
            sel.appendChild(o);
        });
        return sel;
    }

    // ==================== 日付 ====================
    function formatDate(date, pattern) {
        var p = pattern || 'YYYY/MM/DD';
        var map = {
            YYYY: String(date.getFullYear()),
            YY: String(date.getFullYear()).slice(-2),
            MM: pad2(date.getMonth() + 1),
            M: String(date.getMonth() + 1),
            DD: pad2(date.getDate()),
            D: String(date.getDate()),
            ddd: WEEKDAY_JA[date.getDay()],
            HH: pad2(date.getHours()),
            mm: pad2(date.getMinutes())
        };
        // 長いトークンを先に判定する順序で並べる（MM より前に M を置かない）
        return p.replace(/YYYY|YY|MM|M|DD|D|ddd|HH|mm/g, function (token) {
            return map[token];
        });
    }

    function resolveBaseDate(base, now) {
        var d = new Date(now.getTime());
        switch (base) {
            case 'tomorrow': d.setDate(d.getDate() + 1); break;
            case 'yesterday': d.setDate(d.getDate() - 1); break;
            case 'monthStart': d.setDate(1); break;
            case 'monthEnd': d.setMonth(d.getMonth() + 1, 0); break;
            case 'nextMonthStart': d.setMonth(d.getMonth() + 1, 1); break;
            case 'nextMonthEnd': d.setMonth(d.getMonth() + 2, 0); break;
            default: break; // today
        }
        return d;
    }

    /** 土日をスキップして n 営業日を加減する（祝日は非対応） */
    function addBusinessDays(date, n) {
        var d = new Date(date.getTime());
        if (!n) return d;
        var step = n > 0 ? 1 : -1;
        var remaining = Math.abs(n);
        var guard = 0;
        while (remaining > 0 && guard < 100000) {
            d.setDate(d.getDate() + step);
            var w = d.getDay();
            if (w !== 0 && w !== 6) remaining--;
            guard++;
        }
        return d;
    }

    /** 月加算。月末日を超える場合はその月の末日に丸める */
    function addMonths(date, n) {
        var d = new Date(date.getTime());
        var day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + n);
        var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, lastDay));
        return d;
    }

    /** 日付変数の値を計算する */
    function resolveAutoVariable(v, now) {
        var base = resolveBaseDate(v.base || 'today', now || new Date());
        var offset = parseInt(v.offset, 10);
        if (isNaN(offset)) offset = 0;
        var target = base;
        if (offset !== 0) {
            if (v.offsetUnit === 'businessDay') target = addBusinessDays(base, offset);
            else if (v.offsetUnit === 'month') target = addMonths(base, offset);
            else {
                target = new Date(base.getTime());
                target.setDate(target.getDate() + offset);
            }
        }
        return formatDate(target, v.format || 'YYYY年M月D日(ddd)');
    }

    function describeAutoVariable(v) {
        var baseLabel = '今日';
        DATE_BASES.forEach(function (b) { if (b.value === (v.base || 'today')) baseLabel = b.label; });
        var offset = parseInt(v.offset, 10);
        if (isNaN(offset)) offset = 0;
        if (offset === 0) return baseLabel + ' / 書式 ' + (v.format || '');
        var unitLabel = '日';
        DATE_UNITS.forEach(function (u) { if (u.value === (v.offsetUnit || 'day')) unitLabel = u.label; });
        var dir = offset > 0 ? '後' : '前';
        return baseLabel + ' の ' + Math.abs(offset) + unitLabel + dir + ' / 書式 ' + (v.format || '');
    }

    function rfc5322Date(d) {
        var tzMin = -d.getTimezoneOffset();
        var sign = tzMin >= 0 ? '+' : '-';
        var abs = Math.abs(tzMin);
        return DAY_EN[d.getDay()] + ', ' + pad2(d.getDate()) + ' ' + MONTH_EN[d.getMonth()] + ' ' +
            d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
            ' ' + sign + pad2(Math.floor(abs / 60)) + pad2(abs % 60);
    }

    // ==================== 変数展開 ====================
    /** テキスト中の {{...}} を出現順に列挙する（重複除去済み） */
    function detectVariables(text) {
        var out = [];
        if (!text) return out;
        var re = new RegExp(VAR_PATTERN, 'g');
        var m;
        while ((m = re.exec(text)) !== null) {
            var key = m[1].trim();
            if (key && out.indexOf(key) === -1) out.push(key);
        }
        return out;
    }

    /** 定義済みの値だけを差し込む。未定義の {{...}} はそのまま残す */
    function applyVariables(str, values) {
        if (!str) return '';
        var re = new RegExp(VAR_PATTERN, 'g');
        return String(str).replace(re, function (full, raw) {
            var key = raw.trim();
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                return values[key] == null ? '' : String(values[key]);
            }
            return full;
        });
    }

    /** ヘッダ行に入る値から改行を除く。
        改行が残ると .eml 生成時に潰される一方でプレビューには出てしまい、
        画面と実際の送信結果が食い違うため、展開の段階で揃えておく */
    function singleLine(str) {
        return String(str == null ? '' : str).replace(/[\r\n]+/g, ' ');
    }

    /** テンプレート全体を差し込み展開した結果を返す */
    function renderTemplate(tpl, values) {
        return {
            to: singleLine(applyVariables(tpl.to, values)),
            cc: singleLine(applyVariables(tpl.cc, values)),
            bcc: singleLine(applyVariables(tpl.bcc, values)),
            subject: singleLine(applyVariables(tpl.subject, values)),
            body: applyVariables(tpl.body, values)
        };
    }

    // ==================== HTML 生成 ====================
    /** エスケープ済み文字列中の URL をリンクにする */
    function linkify(escaped) {
        return escaped.replace(/https?:\/\/[^\s<>"']+/g, function (url) {
            // 文末の句読点や閉じ括弧は URL から外す
            var trimmed = url.replace(/[.,;:)\]】」』]+$/, '');
            var tail = url.slice(trimmed.length);
            return '<a href="' + trimmed + '">' + trimmed + '</a>' + tail;
        });
    }

    function inlineText(line) {
        return linkify(escapeHtml(line));
    }

    function blockToHtml(block) {
        var lines = block.split('\n');
        var out = [];
        var listBuf = [];
        var textBuf = [];
        function flushList() {
            if (!listBuf.length) return;
            out.push('<ul style="margin:0 0 1em;padding-left:1.5em">' + listBuf.join('') + '</ul>');
            listBuf = [];
        }
        function flushText() {
            if (!textBuf.length) return;
            out.push('<p style="margin:0 0 1em">' + textBuf.join('<br>') + '</p>');
            textBuf = [];
        }
        lines.forEach(function (line) {
            if (/^\s*-\s+/.test(line)) {
                flushText();
                listBuf.push('<li>' + inlineText(line.replace(/^\s*-\s+/, '')) + '</li>');
            } else {
                flushList();
                textBuf.push(inlineText(line));
            }
        });
        flushList();
        flushText();
        return out.join('');
    }

    /** プレーンテキスト本文を HTML 本文に変換する */
    function textToHtml(text) {
        var normalized = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
        var blocks = normalized.split(/\n{2,}/);
        var html = [];
        blocks.forEach(function (block) {
            if (!block.replace(/\s/g, '')) return;
            html.push(blockToHtml(block));
        });
        return html.join('\n');
    }

    /** style 由来の値を CSS に埋める前に検証する。危険な文字を含む場合は既定値へ */
    function safeCssValue(value, fallback) {
        var s = String(value == null ? '' : value).trim();
        if (!s) return fallback;
        if (/[<>{};"'\\]/.test(s)) return fallback;
        return s;
    }

    /** 生 CSS の "<" を除去して </style> によるブレイクアウトを防ぐ（子セレクタの ">" は残す） */
    function sanitizeCss(css) {
        return String(css == null ? '' : css).replace(/</g, ' ');
    }

    function normalizeStyle(style) {
        var s = style || {};
        return {
            fontFamily: FONT_STACKS[s.fontFamily] ? s.fontFamily : DEFAULT_STYLE.fontFamily,
            fontSize: safeCssValue(s.fontSize, DEFAULT_STYLE.fontSize),
            color: safeCssValue(s.color, DEFAULT_STYLE.color),
            background: safeCssValue(s.background, DEFAULT_STYLE.background),
            lineHeight: safeCssValue(s.lineHeight, DEFAULT_STYLE.lineHeight),
            linkColor: safeCssValue(s.linkColor, DEFAULT_STYLE.linkColor),
            maxWidth: safeCssValue(s.maxWidth, DEFAULT_STYLE.maxWidth),
            customCss: typeof s.customCss === 'string' ? s.customCss : ''
        };
    }

    function buildWrapperStyle(style) {
        return [
            'font-family:' + FONT_STACKS[style.fontFamily],
            'font-size:' + style.fontSize,
            'line-height:' + style.lineHeight,
            'color:' + style.color,
            'background-color:' + style.background,
            'max-width:' + style.maxWidth,
            'margin:0 auto',
            'padding:16px',
            'word-break:break-word'
        ].join(';');
    }

    /** iframe プレビュー・クリップボード・.eml に共通で使う HTML ドキュメントを組み立てる */
    function buildHtmlDocument(bodyHtml, rawStyle) {
        var style = normalizeStyle(rawStyle);
        var custom = sanitizeCss(style.customCss);
        var css = 'a{color:' + style.linkColor + '}';
        if (custom.trim()) css += '\n' + custom;
        return '<!DOCTYPE html>\n' +
            '<html lang="ja">\n<head>\n<meta charset="UTF-8">\n' +
            '<style>\n' + css + '\n</style>\n</head>\n' +
            '<body style="margin:0;background-color:' + escapeHtml(style.background) + '">\n' +
            '<div style="' + escapeHtml(buildWrapperStyle(style)) + '">\n' +
            bodyHtml + '\n</div>\n</body>\n</html>';
    }

    // ==================== mailto / .eml ====================
    function buildMailto(rendered) {
        var params = [];
        if (rendered.cc) params.push('cc=' + encodeURIComponent(rendered.cc));
        if (rendered.bcc) params.push('bcc=' + encodeURIComponent(rendered.bcc));
        if (rendered.subject) params.push('subject=' + encodeURIComponent(rendered.subject));
        if (rendered.body) params.push('body=' + encodeURIComponent(rendered.body));
        // アドレス部は @ と , をそのまま残したほうが各クライアントの互換性が高い
        var to = encodeURIComponent(rendered.to || '').replace(/%40/g, '@').replace(/%2C/g, ',');
        return 'mailto:' + to + (params.length ? '?' + params.join('&') : '');
    }

    function bytesToBase64(bytes) {
        var bin = '';
        var CHUNK = 0x8000;
        for (var i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }

    function utf8ToBase64(str) {
        return bytesToBase64(new TextEncoder().encode(String(str == null ? '' : str)));
    }

    function wrapBase64(b64) {
        return (b64.match(/.{1,76}/g) || []).join('\r\n');
    }

    /** ヘッダ値を MIME encoded-word（UTF-8 Base64）にする。ASCII のみならそのまま */
    function encodeMimeWord(str) {
        var s = String(str == null ? '' : str).replace(/[\r\n]+/g, ' ');
        if (!s) return '';
        if (/^[\x20-\x7E]*$/.test(s)) return s;
        var bytes = new TextEncoder().encode(s);
        var words = [];
        var i = 0;
        while (i < bytes.length) {
            var end = Math.min(i + 45, bytes.length);
            // UTF-8 の途中（継続バイト 10xxxxxx）で切らないよう手前まで戻す
            while (end > i + 1 && end < bytes.length && (bytes[end] & 0xC0) === 0x80) end--;
            words.push('=?UTF-8?B?' + bytesToBase64(bytes.subarray(i, end)) + '?=');
            i = end;
        }
        return words.join('\r\n ');
    }

    function sanitizeHeaderValue(str) {
        return String(str == null ? '' : str).replace(/[\r\n]+/g, ' ').trim();
    }

    /** RFC 5322 準拠の最小 .eml（multipart/alternative）を組み立てる */
    function buildEml(rendered, htmlDocument) {
        var boundary = '----=_MailTemplate_' + uid().replace(/[^0-9a-z]/gi, '');
        var lines = [];
        lines.push('MIME-Version: 1.0');
        lines.push('Date: ' + rfc5322Date(new Date()));
        if (rendered.to) lines.push('To: ' + sanitizeHeaderValue(rendered.to));
        if (rendered.cc) lines.push('Cc: ' + sanitizeHeaderValue(rendered.cc));
        if (rendered.bcc) lines.push('Bcc: ' + sanitizeHeaderValue(rendered.bcc));
        lines.push('Subject: ' + encodeMimeWord(rendered.subject));
        lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
        lines.push('');
        lines.push('This is a multi-part message in MIME format.');
        lines.push('');
        lines.push('--' + boundary);
        lines.push('Content-Type: text/plain; charset="UTF-8"');
        lines.push('Content-Transfer-Encoding: base64');
        lines.push('');
        lines.push(wrapBase64(utf8ToBase64(rendered.body)));
        lines.push('');
        lines.push('--' + boundary);
        lines.push('Content-Type: text/html; charset="UTF-8"');
        lines.push('Content-Transfer-Encoding: base64');
        lines.push('');
        lines.push(wrapBase64(utf8ToBase64(htmlDocument)));
        lines.push('');
        lines.push('--' + boundary + '--');
        lines.push('');
        return lines.join('\r\n');
    }

    // ==================== ダウンロード / クリップボード ====================
    function downloadBlob(content, filename, mime) {
        var blob = new Blob([content], { type: mime });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    }

    function copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        // フォールバック: 一時的な textarea + execCommand
        return new Promise(function (resolve, reject) {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'absolute';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                var ok = document.execCommand('copy');
                document.body.removeChild(ta);
                if (ok) resolve(); else reject(new Error('execCommand failed'));
            } catch (e) {
                reject(e);
            }
        });
    }

    /** HTML と プレーンテキストの両方をクリップボードへ書き込む */
    function copyRichText(htmlDocument, plainText) {
        if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write && window.isSecureContext) {
            var item;
            try {
                item = new ClipboardItem({
                    'text/html': new Blob([htmlDocument], { type: 'text/html' }),
                    'text/plain': new Blob([plainText], { type: 'text/plain' })
                });
            } catch (e) {
                return copyToClipboard(htmlDocument);
            }
            return navigator.clipboard.write([item]).catch(function () {
                return copyToClipboard(htmlDocument);
            });
        }
        return copyToClipboard(htmlDocument);
    }

    // ==================== トースト ====================
    var toastEl = null;
    var toastTimer = null;
    function hideToast() {
        toastEl.classList.remove('is-visible');
        setTimeout(function () { toastEl.hidden = true; }, 250);
    }

    /** opts: { actionLabel, onAction } を渡すと取り消しボタン付きになる */
    function showToast(message, opts) {
        if (!toastEl) return;
        clearNode(toastEl);
        toastEl.appendChild(el('span', { text: message }));
        var hasAction = opts && opts.actionLabel && typeof opts.onAction === 'function';
        if (hasAction) {
            var btn = el('button', { type: 'button', class: 'toast-action', text: opts.actionLabel });
            btn.addEventListener('click', function () {
                if (toastTimer) clearTimeout(toastTimer);
                hideToast();
                opts.onAction();
            });
            toastEl.appendChild(btn);
        }
        toastEl.hidden = false;
        requestAnimationFrame(function () { toastEl.classList.add('is-visible'); });
        if (toastTimer) clearTimeout(toastTimer);
        // 取り消せる通知は押す時間が要るので長めに出す
        toastTimer = setTimeout(hideToast, hasAction ? 7000 : 3000);
    }

    // ==================== データモデル ====================
    function normalizeVariable(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var key = String(raw.key == null ? '' : raw.key).trim().slice(0, 40);
        if (!key) return null;
        var type = ['text', 'email', 'textarea', 'select', 'date'].indexOf(raw.type) >= 0 ? raw.type : 'text';
        var v = {
            key: key,
            label: String(raw.label == null || raw.label === '' ? key : raw.label).slice(0, 60),
            type: type,
            required: raw.required === true,
            default: String(raw.default == null ? '' : raw.default).slice(0, 2000),
            placeholder: String(raw.placeholder == null ? '' : raw.placeholder).slice(0, 120)
        };
        if (type === 'select') {
            v.options = Array.isArray(raw.options)
                ? raw.options.map(function (o) { return String(o == null ? '' : o).slice(0, 120); }).filter(function (o) { return o !== ''; })
                : [];
            if (v.default && v.options.indexOf(v.default) === -1) v.options.unshift(v.default);
        }
        if (type === 'date') {
            v.base = DATE_BASES.some(function (b) { return b.value === raw.base; }) ? raw.base : 'today';
            var off = parseInt(raw.offset, 10);
            v.offset = isNaN(off) ? 0 : Math.max(-999, Math.min(999, off));
            v.offsetUnit = DATE_UNITS.some(function (u) { return u.value === raw.offsetUnit; }) ? raw.offsetUnit : 'day';
            v.format = String(raw.format == null || raw.format === '' ? 'YYYY年M月D日(ddd)' : raw.format).slice(0, 60);
            v.required = false;
        }
        return v;
    }

    function normalizeTemplate(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var name = String(raw.name == null ? '' : raw.name).trim().slice(0, 60);
        if (!name) return null;
        var seen = {};
        var variables = (Array.isArray(raw.variables) ? raw.variables : [])
            .map(normalizeVariable)
            .filter(function (v) {
                if (!v) return false;
                if (seen[v.key]) return false;   // キーは一意
                seen[v.key] = true;
                return true;
            });
        var t = {
            id: String(raw.id || uid()),
            name: name,
            to: String(raw.to == null ? '' : raw.to).slice(0, 500),
            cc: String(raw.cc == null ? '' : raw.cc).slice(0, 500),
            bcc: String(raw.bcc == null ? '' : raw.bcc).slice(0, 500),
            subject: String(raw.subject == null ? '' : raw.subject).slice(0, 300),
            body: String(raw.body == null ? '' : raw.body).slice(0, 20000),
            htmlMode: raw.htmlMode === 'manual' ? 'manual' : 'auto',
            bodyHtml: String(raw.bodyHtml == null ? '' : raw.bodyHtml).slice(0, 20000),
            style: normalizeStyle(raw.style),
            variables: variables,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
        };
        migrateFieldTypeRules(t);
        return t;
    }

    /** その変数がどの欄で使われているかを返す */
    function fieldKindsUsingVariable(t, key) {
        var token = '{{' + key + '}}';
        var kinds = {};
        FIELD_SPECS.forEach(function (s) {
            if (String(t[s.field] || '').indexOf(token) !== -1) kinds[s.kind] = true;
        });
        if (String(t.bodyHtml || '').indexOf(token) !== -1) kinds.body = true;
        return Object.keys(kinds);
    }

    /* 欄ごとの型制限に合うよう既存データを矯正する。
       ここで直さずに保存だけ止めると、規則より前に作られたテンプレートが
       編集も保存もできなくなって詰むため、読み込み時に必ず通す。
       戻り値は矯正した変数名の一覧。 */
    function migrateFieldTypeRules(t) {
        var fixed = [];
        t.variables.forEach(function (v) {
            var kinds = fieldKindsUsingVariable(t, v.key);
            if (!kinds.length) return;
            var violates = kinds.some(function (k) { return !fieldKindAllowsType(k, v.type); });
            if (!violates) return;
            var before = v.type;
            if (kinds.indexOf('address') !== -1) {
                v.type = 'email';
            } else if (kinds.indexOf('subject') !== -1 && v.type === 'textarea') {
                v.type = 'text';
            }
            if (v.type !== before) {
                delete v.options;
                fixed.push(v.key);
            }
        });
        return fixed;
    }

    function createEmptyTemplate() {
        var now = Date.now();
        return {
            id: uid(),
            name: '',
            to: '',
            cc: '',
            bcc: '',
            subject: '',
            body: '',
            htmlMode: 'auto',
            bodyHtml: '',
            style: normalizeStyle(null),
            variables: [],
            createdAt: now,
            updatedAt: now
        };
    }

    function cloneTemplate(tpl) {
        return JSON.parse(JSON.stringify(tpl));
    }

    // ==================== ストレージ ====================
    function loadStore() {
        var raw = null;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            state.storageAvailable = false;
            return [];
        }
        if (!raw) return [];
        try {
            var obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object' || !Array.isArray(obj.templates)) return [];
            return obj.templates.map(normalizeTemplate).filter(Boolean).slice(0, MAX_TEMPLATES);
        } catch (e) {
            return [];
        }
    }

    function saveStore() {
        if (!state.storageAvailable) return false;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                schemaVersion: SCHEMA_VERSION,
                templates: state.templates
            }));
            return true;
        } catch (e) {
            // 容量超過など。データは破棄せず、利用者に対処を促す
            showToast('保存に失敗しました。不要なテンプレートを削除するかエクスポートしてください');
            return false;
        }
    }

    function storeSizeBytes() {
        try {
            return new TextEncoder().encode(JSON.stringify({
                schemaVersion: SCHEMA_VERSION,
                templates: state.templates
            })).length;
        } catch (e) {
            return 0;
        }
    }

    // ==================== サンプルテンプレート ====================
    function sampleTemplates() {
        return [
            {
                name: 'ビジネス挨拶メール',
                to: '{{担当者メール}}',
                subject: '{{件名補足}}のご連絡',
                body: '{{取引先名}}\n{{担当者名}}様\n\nいつも大変お世話になっております。\n{{自社名}}の{{差出人名}}です。\n\n{{本文}}\n\nご不明な点がございましたら、お気軽にお申し付けください。\n引き続きどうぞよろしくお願いいたします。\n\n----------------------------------\n{{自社名}} {{差出人名}}\n----------------------------------',
                variables: [
                    { key: '取引先名', label: '取引先名', type: 'text', required: true, default: '', placeholder: '例: 株式会社〇〇' },
                    { key: '担当者名', label: '担当者名', type: 'text', required: true, default: '', placeholder: '例: 山田' },
                    { key: '担当者メール', label: '担当者メールアドレス', type: 'email', required: false, default: '', placeholder: '例: yamada@example.com' },
                    { key: '件名補足', label: '件名の用件', type: 'text', required: true, default: '', placeholder: '例: 打ち合わせ日程' },
                    { key: '本文', label: '本文', type: 'textarea', required: true, default: '' },
                    { key: '自社名', label: '自社名', type: 'text', required: false, default: '' },
                    { key: '差出人名', label: '差出人名', type: 'text', required: false, default: '' }
                ]
            },
            {
                name: '月次報告メール',
                to: '',
                subject: '{{対象月}}分 月次報告書のご送付',
                body: '{{取引先名}}\n{{担当部署}} ご担当者様\n\nいつもお世話になっております。\n{{送付日}}時点の月次報告書をお送りいたします。\n\n- 対象期間: {{対象月}}\n- 添付: 月次報告書（PDF）\n\nご確認のうえ、{{確認期限}}までにご不明点をお知らせいただけますと幸いです。\n\nよろしくお願いいたします。',
                variables: [
                    { key: '取引先名', label: '取引先名', type: 'text', required: true, default: '', placeholder: '例: 株式会社〇〇' },
                    { key: '担当部署', label: '担当部署', type: 'select', options: ['営業部', '開発部', '管理部'], default: '営業部' },
                    { key: '対象月', label: '対象月', type: 'date', base: 'today', offset: -1, offsetUnit: 'month', format: 'YYYY年M月' },
                    { key: '送付日', label: '送付日', type: 'date', base: 'today', offset: 0, offsetUnit: 'day', format: 'YYYY年M月D日(ddd)' },
                    { key: '確認期限', label: '確認期限', type: 'date', base: 'today', offset: 5, offsetUnit: 'businessDay', format: 'M月D日(ddd)' }
                ]
            },
            {
                name: '日程調整メール',
                to: '',
                subject: '{{用件}}の日程調整のお願い',
                body: '{{取引先名}}\n{{担当者名}}様\n\nお世話になっております。\n{{用件}}につきまして、下記の候補日でご都合はいかがでしょうか。\n\n- {{第1候補}} 10:00〜11:00\n- {{第2候補}} 14:00〜15:00\n- {{第3候補}} 16:00〜17:00\n\nいずれもご都合が合わない場合は、ご希望の日時をお知らせください。\n{{備考}}\n\nお手数をおかけしますが、よろしくお願いいたします。',
                variables: [
                    { key: '取引先名', label: '取引先名', type: 'text', required: true, default: '' },
                    { key: '担当者名', label: '担当者名', type: 'text', required: true, default: '' },
                    { key: '用件', label: '用件', type: 'text', required: true, default: '', placeholder: '例: 次期案件のお打ち合わせ' },
                    { key: '第1候補', label: '第1候補日', type: 'date', base: 'today', offset: 3, offsetUnit: 'businessDay', format: 'M月D日(ddd)' },
                    { key: '第2候補', label: '第2候補日', type: 'date', base: 'today', offset: 4, offsetUnit: 'businessDay', format: 'M月D日(ddd)' },
                    { key: '第3候補', label: '第3候補日', type: 'date', base: 'today', offset: 5, offsetUnit: 'businessDay', format: 'M月D日(ddd)' },
                    { key: '備考', label: '備考', type: 'textarea', required: false, default: '' }
                ]
            }
        ].map(normalizeTemplate).filter(Boolean);
    }

    // ==================== 状態 ====================
    var state = {
        templates: [],
        storageAvailable: true,
        activeTab: 'use',
        useTemplateId: null,
        inputs: {},        // 差し込み欄の現在値（key -> string）
        overrides: {},     // 日付変数の手動上書きフラグ（key -> boolean）
        touched: {},       // blur 済みフラグ（key -> boolean）
        outputFormat: 'text',
        htmlSubTab: 'preview',
        editing: null,     // 編集中テンプレートの複製
        editingIsNew: false,
        dirty: false,
        pendingImport: null,
        varDialogMode: 'create',    // 'create' | 'edit'
        varDialogOriginalKey: null, // 編集モードで改名を検出するための元のキー
        activeToken: null,          // キャレットがかかっている変数
        activeFieldId: null,        // その変数がある入力欄の id
        varDialogFieldKind: 'body', // ダイアログを開いた元の欄の種類（型の制限に使う）
        pendingRange: null,         // ダイアログを開いた時点の選択範囲（inert 対策）
        pendingFieldId: null,       // ダイアログを開いた元の入力欄
        floatOriginFieldId: null,   // フロートを出した入力欄（Escape の戻り先）
        floatOriginRange: null,     // フロートを出した時点の選択範囲
        floatDismissedAt: null      // Escape で閉じたときの選択位置
    };

    // ==================== DOM 参照 ====================
    var dom = {};
    function cacheDom() {
        [
            'storage-warning', 'use-empty', 'load-samples-btn', 'goto-edit-btn', 'use-main',
            'use-template-select', 'use-variables', 'use-no-variables', 'use-undefined-warn',
            'pv-to', 'pv-cc', 'pv-cc-row', 'pv-bcc', 'pv-bcc-row', 'pv-subject',
            'pv-subtabs', 'pv-body-text', 'pv-html-preview-wrap', 'pv-frame', 'pv-html-source',
            'copy-body-btn', 'copy-subject-btn', 'copy-to-btn', 'mailto-btn', 'eml-btn', 'action-note',
            'new-template-btn', 'edit-template-list', 'edit-empty', 'editor-card', 'editor-title', 'editor-form',
            'edit-name', 'edit-name-error', 'edit-to', 'edit-to-warn',
            'edit-cc', 'edit-cc-warn', 'edit-bcc', 'edit-bcc-warn', 'edit-subject',
            'insert-var-chips', 'edit-body', 'body-highlight',
            'to-highlight', 'cc-highlight', 'bcc-highlight', 'subject-highlight',
            'var-float', 'var-float-label', 'var-float-make', 'var-float-edit', 'var-float-delete',
            'var-dialog', 'var-dialog-title', 'var-dialog-key', 'var-dialog-key-error',
            'var-dialog-label', 'var-dialog-type', 'var-dialog-guess', 'var-dialog-token',
            'var-dialog-kind-note', 'var-dialog-date-block', 'var-dialog-base', 'var-dialog-offset',
            'var-dialog-offset-unit', 'var-dialog-format-preset', 'var-dialog-format',
            'var-dialog-date-preview', 'var-dialog-select-block', 'var-dialog-options',
            'var-dialog-required', 'var-dialog-required-note', 'var-dialog-ok', 'var-dialog-cancel',
            'var-type-warn',
            'edit-variables', 'edit-variables-empty', 'add-variable-btn',
            'manual-html-wrap', 'edit-body-html', 'style-font', 'style-size', 'style-line-height',
            'style-max-width', 'style-color', 'style-background', 'style-link-color', 'style-custom-css',
            'edit-frame', 'save-template-btn', 'discard-template-btn', 'dirty-note',
            'data-stats', 'export-all-btn', 'import-file', 'import-btn', 'import-choice',
            'import-choice-title', 'import-merge-btn', 'import-replace-btn', 'import-cancel-btn',
            'import-error', 'data-template-list', 'data-empty', 'clear-all-btn', 'toast'
        ].forEach(function (id) {
            var node = document.getElementById(id);
            // 取り違えを早期に気づけるようにする。ここを黙って通すと
            // 後段のハンドラ内で undefined 参照になり原因が追いにくい
            if (!node && window.console) console.warn('[mailtemplate] 要素が見つかりません: #' + id);
            dom[id] = node;
        });
        toastEl = dom['toast'];
    }

    // ==================== タブ ====================
    function getTabButtons() {
        return Array.prototype.slice.call(document.querySelectorAll('#main-tabs .tab-btn'));
    }

    function switchTab(name, focusButton) {
        if (state.activeTab === name) return;
        // 編集中に未保存の変更があれば確認
        if (state.activeTab === 'edit' && state.dirty) {
            if (!window.confirm('未保存の変更があります。破棄して移動しますか？')) return;
            state.editing = null;
            state.editingIsNew = false;
            setDirty(false);
            renderEditTab();
        }
        state.activeTab = name;
        getTabButtons().forEach(function (btn) {
            var isActive = btn.getAttribute('data-tab') === name;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            btn.tabIndex = isActive ? 0 : -1;
            if (isActive && focusButton) btn.focus();
        });
        ['use', 'edit', 'data'].forEach(function (key) {
            var panel = document.getElementById('tab-' + key);
            if (!panel) return;
            panel.classList.toggle('active', key === name);
            panel.hidden = key !== name;
        });
        if (name === 'data') renderDataTab();
        if (name === 'use') renderUseTab();
    }

    function initTabs() {
        var buttons = getTabButtons();
        buttons.forEach(function (btn, idx) {
            btn.addEventListener('click', function () {
                switchTab(btn.getAttribute('data-tab'), false);
            });
            btn.addEventListener('keydown', function (e) {
                var next = null;
                if (e.key === 'ArrowRight') next = buttons[(idx + 1) % buttons.length];
                else if (e.key === 'ArrowLeft') next = buttons[(idx - 1 + buttons.length) % buttons.length];
                else if (e.key === 'Home') next = buttons[0];
                else if (e.key === 'End') next = buttons[buttons.length - 1];
                if (!next) return;
                e.preventDefault();
                switchTab(next.getAttribute('data-tab'), true);
            });
        });
    }

    // ==================== タブ1: 使う ====================
    function getCurrentTemplate() {
        for (var i = 0; i < state.templates.length; i++) {
            if (state.templates[i].id === state.useTemplateId) return state.templates[i];
        }
        return null;
    }

    /** テンプレート切り替え時に差し込み欄の初期値を作る */
    function resetInputs(tpl) {
        state.inputs = {};
        state.overrides = {};
        state.touched = {};
        if (!tpl) return;
        var now = new Date();
        tpl.variables.forEach(function (v) {
            if (v.type === 'date') {
                state.inputs[v.key] = resolveAutoVariable(v, now);
                state.overrides[v.key] = false;
            } else if (v.type === 'select') {
                state.inputs[v.key] = v.default || (v.options && v.options[0]) || '';
            } else {
                state.inputs[v.key] = v.default || '';
            }
        });
    }

    function renderUseTab() {
        var hasTemplates = state.templates.length > 0;
        dom['use-empty'].hidden = hasTemplates;
        dom['use-main'].hidden = !hasTemplates;
        if (!hasTemplates) return;

        if (!getCurrentTemplate()) {
            state.useTemplateId = state.templates[0].id;
            resetInputs(state.templates[0]);
        }

        var select = dom['use-template-select'];
        clearNode(select);
        state.templates.forEach(function (tpl) {
            var o = el('option', { value: tpl.id, text: tpl.name });
            if (tpl.id === state.useTemplateId) o.selected = true;
            select.appendChild(o);
        });

        renderVariableInputs();
        updatePreview();
    }

    function renderVariableInputs() {
        var tpl = getCurrentTemplate();
        var wrap = dom['use-variables'];
        clearNode(wrap);
        if (!tpl) return;

        dom['use-no-variables'].hidden = tpl.variables.length > 0;

        tpl.variables.forEach(function (v) {
            wrap.appendChild(buildVariableInput(v));
        });
    }

    function buildVariableInput(v) {
        var inputId = 'usevar-' + encodeURIComponent(v.key);
        var errorId = inputId + '-error';
        var block = el('div', { class: 'field-block var-input-block' });

        var label = el('label', { for: inputId });
        label.appendChild(document.createTextNode(v.label || v.key));
        if (v.required) label.appendChild(el('span', { class: 'req', text: ' *', 'aria-label': '必須' }));
        block.appendChild(label);

        var control;
        if (v.type === 'textarea') {
            control = el('textarea', { id: inputId, rows: '4', placeholder: v.placeholder || '' });
            control.value = state.inputs[v.key] || '';
        } else if (v.type === 'select') {
            control = el('select', { id: inputId });
            (v.options || []).forEach(function (opt) {
                var o = el('option', { value: opt, text: opt });
                if (opt === state.inputs[v.key]) o.selected = true;
                control.appendChild(o);
            });
        } else if (v.type === 'date') {
            control = el('input', { type: 'text', id: inputId, autocomplete: 'off' });
            control.value = state.inputs[v.key] || '';
            control.readOnly = !state.overrides[v.key];
            control.classList.toggle('is-readonly', !state.overrides[v.key]);
        } else if (v.type === 'email') {
            // 端末で適切なキーボードが出るよう意味のある型を使う
            control = el('input', {
                type: 'email', id: inputId, inputmode: 'email', autocomplete: 'email',
                placeholder: v.placeholder || '例: taro@example.com'
            });
            control.value = state.inputs[v.key] || '';
        } else {
            control = el('input', { type: 'text', id: inputId, autocomplete: 'off', placeholder: v.placeholder || '' });
            control.value = state.inputs[v.key] || '';
        }
        if (v.required) control.setAttribute('aria-required', 'true');
        control.setAttribute('data-var-key', v.key);
        block.appendChild(control);

        if (v.type === 'date') {
            var overrideId = inputId + '-override';
            var row = el('div', { class: 'override-row' });
            var cb = el('input', { type: 'checkbox', id: overrideId, 'data-override-key': v.key });
            cb.checked = !!state.overrides[v.key];
            row.appendChild(cb);
            row.appendChild(el('label', { for: overrideId, text: '上書きする' }));
            row.appendChild(el('span', { class: 'auto-hint', text: describeAutoVariable(v) }));
            block.appendChild(row);
        }

        var err = el('p', { class: 'field-error', id: errorId, role: 'alert' });
        err.hidden = true;
        block.appendChild(err);
        return block;
    }

    function validateVariable(v) {
        var inputId = 'usevar-' + encodeURIComponent(v.key);
        var err = document.getElementById(inputId + '-error');
        if (!err) return true;
        var value = (state.inputs[v.key] || '').trim();
        if (v.required && !value && state.touched[v.key]) {
            err.textContent = (v.label || v.key) + 'を入力してください';
            err.hidden = false;
            return false;
        }
        // メールアドレスは緩く確認するだけ。既存の宛先チェックと同じ厳しさに揃え、
        // 送信自体は止めない（社内の独自アドレス等を弾かないため）
        if (v.type === 'email' && value && state.touched[v.key] && value.indexOf('@') === -1) {
            err.textContent = (v.label || v.key) + 'はメールアドレスの形式ではないようです（そのまま使えます）';
            err.hidden = false;
            return true;
        }
        err.hidden = true;
        err.textContent = '';
        return !(v.required && !value);
    }

    function validateAllVariables() {
        var tpl = getCurrentTemplate();
        if (!tpl) return true;
        var ok = true;
        tpl.variables.forEach(function (v) {
            if (!validateVariable(v)) ok = false;
        });
        return ok;
    }

    var previewTimer = null;
    function schedulePreview() {
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(updatePreview, PREVIEW_DEBOUNCE_MS);
    }

    function buildRendered() {
        var tpl = getCurrentTemplate();
        if (!tpl) return null;
        var rendered = renderTemplate(tpl, state.inputs);
        var innerHtml;
        if (tpl.htmlMode === 'manual' && tpl.bodyHtml) {
            // 手書き HTML は利用者自身が書いたものをそのまま使う（表示は sandbox iframe 内）
            innerHtml = applyVariables(tpl.bodyHtml, state.inputs);
        } else {
            innerHtml = textToHtml(rendered.body);
        }
        rendered.html = buildHtmlDocument(innerHtml, tpl.style);
        return rendered;
    }

    function updatePreview() {
        var tpl = getCurrentTemplate();
        if (!tpl) return;
        var rendered = buildRendered();
        var isHtml = state.outputFormat === 'html';

        dom['pv-to'].textContent = rendered.to || '（未設定）';
        dom['pv-subject'].textContent = rendered.subject || '（未設定）';
        dom['pv-cc'].textContent = rendered.cc;
        dom['pv-bcc'].textContent = rendered.bcc;
        dom['pv-cc-row'].hidden = !rendered.cc;
        dom['pv-bcc-row'].hidden = !rendered.bcc;

        dom['pv-subtabs'].hidden = !isHtml;
        dom['pv-body-text'].hidden = isHtml;
        dom['pv-html-preview-wrap'].hidden = !isHtml || state.htmlSubTab !== 'preview';
        dom['pv-html-source'].hidden = !isHtml || state.htmlSubTab !== 'source';

        if (isHtml) {
            dom['pv-frame'].srcdoc = rendered.html;
            dom['pv-html-source'].textContent = rendered.html;
        } else {
            dom['pv-body-text'].textContent = rendered.body;
        }

        // 未定義変数の警告
        var defined = {};
        tpl.variables.forEach(function (v) { defined[v.key] = true; });
        var all = detectVariables([tpl.to, tpl.cc, tpl.bcc, tpl.subject, tpl.body, tpl.bodyHtml].join('\n'));
        var missing = all.filter(function (k) { return !defined[k]; });
        if (missing.length) {
            dom['use-undefined-warn'].textContent =
                'テンプレートに定義されていない変数があります: ' + missing.map(function (k) { return '{{' + k + '}}'; }).join(' ') +
                '（そのまま出力されます。「作成・編集」タブで変数を追加できます）';
            dom['use-undefined-warn'].hidden = false;
        } else {
            dom['use-undefined-warn'].hidden = true;
        }

        updateActionAvailability(rendered);
    }

    function updateActionAvailability(rendered) {
        var isHtml = state.outputFormat === 'html';
        var notes = [];
        // disabled 属性ではなく aria-disabled を使い、キーボード利用者にも理由を届けられるようにする
        dom['mailto-btn'].setAttribute('aria-disabled', isHtml ? 'true' : 'false');
        dom['mailto-btn'].classList.toggle('is-disabled', isHtml);
        if (isHtml) {
            dom['mailto-btn'].setAttribute('aria-describedby', 'action-note');
            notes.push('HTML 出力時は「メールアプリで開く」を利用できません（mailto: はプレーンテキスト本文しか渡せない仕様のため）。「.eml ファイルをダウンロード」か「本文をコピー」をご利用ください。');
        } else {
            dom['mailto-btn'].removeAttribute('aria-describedby');
            var url = buildMailto(rendered);
            if (url.length > MAILTO_WARN_LEN) {
                notes.push('本文が長いため、メールアプリによっては内容が途中で切れる可能性があります（現在 ' + url.length + ' 文字）。コピーまたは .eml のご利用をおすすめします。');
            }
        }
        dom['action-note'].textContent = notes.join(' ');
        dom['action-note'].hidden = notes.length === 0;
    }

    function initUseTab() {
        dom['use-template-select'].addEventListener('change', function () {
            state.useTemplateId = this.value;
            var tpl = getCurrentTemplate();
            resetInputs(tpl);
            renderVariableInputs();
            updatePreview();
        });

        // 差し込み欄（動的生成）への委譲
        dom['use-variables'].addEventListener('input', function (e) {
            var key = e.target.getAttribute && e.target.getAttribute('data-var-key');
            if (!key) return;
            state.inputs[key] = e.target.value;
            schedulePreview();
        });
        dom['use-variables'].addEventListener('change', function (e) {
            var target = e.target;
            var overrideKey = target.getAttribute && target.getAttribute('data-override-key');
            if (overrideKey) {
                state.overrides[overrideKey] = target.checked;
                var tpl = getCurrentTemplate();
                var variable = null;
                if (tpl) {
                    tpl.variables.forEach(function (v) { if (v.key === overrideKey) variable = v; });
                }
                // 上書きを解除したら自動計算値に戻す
                if (!target.checked && variable) {
                    state.inputs[overrideKey] = resolveAutoVariable(variable, new Date());
                }
                renderVariableInputs();
                updatePreview();
                return;
            }
            var key = target.getAttribute && target.getAttribute('data-var-key');
            if (key) {
                state.inputs[key] = target.value;
                updatePreview();
            }
        });
        dom['use-variables'].addEventListener('focusout', function (e) {
            var key = e.target.getAttribute && e.target.getAttribute('data-var-key');
            if (!key) return;
            state.touched[key] = true;
            var tpl = getCurrentTemplate();
            if (!tpl) return;
            tpl.variables.forEach(function (v) { if (v.key === key) validateVariable(v); });
        });

        Array.prototype.forEach.call(document.querySelectorAll('input[name="output-format"]'), function (radio) {
            radio.addEventListener('change', function () {
                if (!radio.checked) return;
                state.outputFormat = radio.value;
                updatePreview();
            });
        });

        var subtabButtons = Array.prototype.slice.call(dom['pv-subtabs'].querySelectorAll('.tab-btn'));
        subtabButtons.forEach(function (btn, idx) {
            btn.addEventListener('click', function () { selectSubTab(btn.getAttribute('data-subtab'), subtabButtons, false); });
            btn.addEventListener('keydown', function (e) {
                var next = null;
                if (e.key === 'ArrowRight') next = subtabButtons[(idx + 1) % subtabButtons.length];
                else if (e.key === 'ArrowLeft') next = subtabButtons[(idx - 1 + subtabButtons.length) % subtabButtons.length];
                if (!next) return;
                e.preventDefault();
                selectSubTab(next.getAttribute('data-subtab'), subtabButtons, true);
            });
        });

        dom['load-samples-btn'].addEventListener('click', function () {
            var samples = sampleTemplates();
            state.templates = state.templates.concat(samples).slice(0, MAX_TEMPLATES);
            state.useTemplateId = state.templates[0].id;
            resetInputs(getCurrentTemplate());
            saveStore();
            renderAll();
            showToast('サンプルテンプレートを ' + samples.length + ' 件読み込みました');
        });

        dom['goto-edit-btn'].addEventListener('click', function () { switchTab('edit', true); });

        dom['copy-body-btn'].addEventListener('click', onCopyBody);
        dom['copy-subject-btn'].addEventListener('click', function () {
            var rendered = buildRendered();
            if (!rendered) return;
            copyToClipboard(rendered.subject).then(function () { showToast('件名をコピーしました'); },
                function () { showToast('コピーに失敗しました'); });
        });
        dom['copy-to-btn'].addEventListener('click', function () {
            var rendered = buildRendered();
            if (!rendered) return;
            copyToClipboard(rendered.to).then(function () { showToast('宛先をコピーしました'); },
                function () { showToast('コピーに失敗しました'); });
        });
        dom['mailto-btn'].addEventListener('click', onOpenMailto);
        dom['eml-btn'].addEventListener('click', onDownloadEml);
    }

    function selectSubTab(name, buttons, focus) {
        state.htmlSubTab = name;
        buttons.forEach(function (btn) {
            var isActive = btn.getAttribute('data-subtab') === name;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            btn.tabIndex = isActive ? 0 : -1;
            if (isActive && focus) btn.focus();
        });
        updatePreview();
    }

    function onCopyBody() {
        var rendered = buildRendered();
        if (!rendered) return;
        validateAllVariables();
        if (state.outputFormat === 'html') {
            copyRichText(rendered.html, rendered.body).then(function () {
                showToast('HTML 本文をコピーしました');
            }, function () {
                showToast('コピーに失敗しました');
            });
        } else {
            copyToClipboard(rendered.body).then(function () { showToast('本文をコピーしました'); },
                function () { showToast('コピーに失敗しました'); });
        }
    }

    function onOpenMailto() {
        if (state.outputFormat === 'html') {
            showToast('HTML 出力時は mailto: を利用できません。.eml のダウンロードかコピーをご利用ください');
            return;
        }
        var rendered = buildRendered();
        if (!rendered) return;
        var url = buildMailto(rendered);
        if (url.length > MAILTO_WARN_LEN) {
            var msg = 'メール本文が長いため（' + url.length + ' 文字）、メールアプリ側で内容が途中で切れる可能性があります。\n' +
                'このまま開きますか？（キャンセルして「本文をコピー」や「.eml ダウンロード」を使うこともできます）';
            if (!window.confirm(msg)) return;
        }
        window.location.href = url;
    }

    function safeFileName(name, ext) {
        var base = String(name || 'mail').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40);
        if (!base) base = 'mail';
        return base + ext;
    }

    function onDownloadEml() {
        var tpl = getCurrentTemplate();
        var rendered = buildRendered();
        if (!tpl || !rendered) return;
        var eml = buildEml(rendered, rendered.html);
        downloadBlob(eml, safeFileName(tpl.name, '.eml'), 'message/rfc822');
        showToast('.eml ファイルをダウンロードしました');
    }

    // ==================== タブ2: 作成・編集 ====================
    function setDirty(flag) {
        state.dirty = flag;
        dom['dirty-note'].hidden = !flag;
    }

    function renderEditTab() {
        var list = dom['edit-template-list'];
        clearNode(list);
        dom['edit-empty'].hidden = state.templates.length > 0;

        state.templates.forEach(function (tpl) {
            var li = el('li', { class: 'tpl-item' });
            li.appendChild(el('span', { class: 'tpl-item-name', text: tpl.name }));
            var meta = el('span', { class: 'tpl-item-meta', text: '変数 ' + tpl.variables.length + ' 件' });
            li.appendChild(meta);
            var actions = el('div', { class: 'tpl-item-actions' });
            actions.appendChild(el('button', {
                type: 'button', class: 'btn btn-ghost btn-sm', 'data-act': 'edit', 'data-id': tpl.id,
                text: '編集', 'aria-label': tpl.name + ' を編集'
            }));
            actions.appendChild(el('button', {
                type: 'button', class: 'btn btn-ghost btn-sm', 'data-act': 'duplicate', 'data-id': tpl.id,
                text: '複製', 'aria-label': tpl.name + ' を複製'
            }));
            actions.appendChild(el('button', {
                type: 'button', class: 'btn btn-danger btn-sm', 'data-act': 'delete', 'data-id': tpl.id,
                text: '削除', 'aria-label': tpl.name + ' を削除'
            }));
            li.appendChild(actions);
            list.appendChild(li);
        });

        dom['editor-card'].hidden = !state.editing;
        if (state.editing) fillEditorForm();
    }

    function fillEditorForm() {
        var t = state.editing;
        dom['editor-title'].textContent = state.editingIsNew ? 'テンプレートを新規作成' : 'テンプレートを編集';
        dom['edit-name'].value = t.name;
        dom['edit-to'].value = t.to;
        dom['edit-cc'].value = t.cc;
        dom['edit-bcc'].value = t.bcc;
        dom['edit-subject'].value = t.subject;
        dom['edit-body'].value = t.body;
        dom['edit-body-html'].value = t.bodyHtml;
        Array.prototype.forEach.call(document.querySelectorAll('input[name="html-mode"]'), function (r) {
            r.checked = r.value === t.htmlMode;
        });
        dom['manual-html-wrap'].hidden = t.htmlMode !== 'manual';
        dom['style-font'].value = t.style.fontFamily;
        dom['style-size'].value = t.style.fontSize;
        dom['style-line-height'].value = t.style.lineHeight;
        dom['style-max-width'].value = t.style.maxWidth;
        dom['style-color'].value = /^#[0-9a-f]{6}$/i.test(t.style.color) ? t.style.color : '#333333';
        dom['style-background'].value = /^#[0-9a-f]{6}$/i.test(t.style.background) ? t.style.background : '#ffffff';
        dom['style-link-color'].value = /^#[0-9a-f]{6}$/i.test(t.style.linkColor) ? t.style.linkColor : '#1e3a8a';
        dom['style-custom-css'].value = t.style.customCss;
        renderEditorVariables();
        renderInsertChips();
        renderAllFieldHighlights();
        updateVarFloat();
        updateEditPreview();
        validateAllAddressFields();
    }

    function renderInsertChips() {
        var wrap = dom['insert-var-chips'];
        clearNode(wrap);
        if (!state.editing || !state.editing.variables.length) return;
        wrap.appendChild(el('span', { class: 'chip-row-label', text: '本文に挿入:' }));
        state.editing.variables.forEach(function (v) {
            wrap.appendChild(el('button', {
                type: 'button', class: 'chip', 'data-insert-key': v.key,
                text: '{{' + v.key + '}}', 'aria-label': v.key + ' を本文に挿入'
            }));
        });
    }

    /* ==================== {{}} の自動認識 ====================
       閉じ括弧が揃った完全な {{名前}} だけを対象にし、打鍵の途中で
       中途半端な変数が量産されないようデバウンスしてから登録する。
       取り消せるようトーストに「元に戻す」を出す。 */
    var autoDetectTimer = null;
    function scheduleAutoDetect() {
        if (autoDetectTimer) clearTimeout(autoDetectTimer);
        autoDetectTimer = setTimeout(autoDetectVariables, AUTO_DETECT_DEBOUNCE_MS);
    }

    function autoDetectVariables() {
        autoDetectTimer = null;
        var t = state.editing;
        if (!t) return;
        var defined = {};
        t.variables.forEach(function (v) { defined[v.key] = true; });
        var missing = detectVariables([t.to, t.cc, t.bcc, t.subject, t.body, t.bodyHtml].join('\n'))
            .filter(function (k) { return !defined[k]; });
        if (!missing.length) return;

        var added = [];
        missing.forEach(function (key) {
            var spec = guessVariableSpec(key);
            // 書かれた欄で使える型に寄せる（宛先ならメールアドレス等）
            spec.type = clampTypeForKinds(spec.type, fieldKindsUsingVariable(t, key));
            var raw = { key: key, label: key, type: spec.type, required: false, placeholder: spec.placeholder || '' };
            if (spec.type === 'date') {
                raw.base = spec.base || 'today';
                raw.offset = spec.offset != null ? spec.offset : 0;
                raw.offsetUnit = spec.offsetUnit || 'day';
                raw.format = spec.format || 'YYYY年M月D日(ddd)';
            }
            var v = normalizeVariable(raw);
            if (v) { t.variables.push(v); added.push(v); }
        });
        if (!added.length) return;

        setDirty(true);
        refreshEditorAfterVarChange();
        var names = added.map(function (v) { return '{{' + v.key + '}}'; }).join('、');
        var typeNote = added.length === 1 ? '（' + varTypeLabel(added[0].type) + '）' : '';
        showToast(names + ' を差し込み変数として追加しました' + typeNote, {
            actionLabel: '元に戻す',
            onAction: function () {
                var keys = {};
                added.forEach(function (v) { keys[v.key] = true; });
                t.variables = t.variables.filter(function (v) { return !keys[v.key]; });
                setDirty(true);
                refreshEditorAfterVarChange();
                showToast('追加を取り消しました');
            }
        });
    }

    function varTypeLabel(type) {
        var label = type;
        VAR_TYPES.forEach(function (t) { if (t.value === type) label = t.label; });
        return label;
    }

    // ==================== 変数化ダイアログ ====================
    /** 変数名として使える形に整える。normalizeVariable の 40 字上限に合わせる */
    function sanitizeVarKey(raw) {
        return String(raw == null ? '' : raw)
            .replace(/[{}]/g, '')
            .replace(/[\r\n\t]+/g, ' ')
            .trim()
            .slice(0, 40);
    }

    /* ==================== フロートメニューの位置計算 ====================
       textarea は選択範囲の画面座標を直接取れないので、同じ文字送りの
       ミラー要素に本文の先頭〜対象位置までを流し込み、末尾に置いた目印を測る。
       スタイルは実行時に textarea から写すので、CSS を変えてもズレない。 */
    var measureMirror = null;
    var MIRROR_STYLE_PROPS = [
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
        'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'boxSizing',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'
    ];

    function measureTextareaPoint(ta, index) {
        if (!measureMirror) {
            measureMirror = el('div', { class: 'measure-mirror', 'aria-hidden': 'true' });
            document.body.appendChild(measureMirror);
        }
        var cs = getComputedStyle(ta);
        MIRROR_STYLE_PROPS.forEach(function (p) { measureMirror.style[p] = cs[p]; });
        measureMirror.style.width = cs.width;

        clearNode(measureMirror);
        measureMirror.appendChild(document.createTextNode(ta.value.slice(0, index)));
        var probe = el('span', { text: '​' });
        measureMirror.appendChild(probe);

        var pr = probe.getBoundingClientRect();
        var mr = measureMirror.getBoundingClientRect();
        var tr = ta.getBoundingClientRect();
        return {
            left: tr.left + (pr.left - mr.left) - ta.scrollLeft,
            top: tr.top + (pr.top - mr.top) - ta.scrollTop,
            bottom: tr.top + (pr.bottom - mr.top) - ta.scrollTop
        };
    }

    /** アンカー矩形（ビューポート座標）にフロートを寄せる。上に入らなければ下へ反転する */
    function positionVarFloat(anchor) {
        var bar = dom['var-float'];
        // どの欄からでも使えるよう、位置はフォームを基準に算出する
        var er = dom['editor-form'].getBoundingClientRect();
        var bw = bar.offsetWidth;
        var bh = bar.offsetHeight;
        var GAP = 8;

        // タッチ環境では OS の選択メニューが選択の上に出やすいので下側を優先する
        var preferBelow = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        var topAbove = anchor.top - er.top - bh - GAP;
        var topBelow = anchor.bottom - er.top + GAP;
        var top = preferBelow ? topBelow : topAbove;
        if (!preferBelow && topAbove < 0) top = topBelow;
        if (preferBelow && topBelow + bh > er.height && topAbove >= 0) top = topAbove;

        var left = anchor.left - er.left - bw / 2;
        left = Math.max(0, Math.min(left, er.width - bw));
        bar.style.left = Math.round(left) + 'px';
        bar.style.top = Math.round(top) + 'px';
    }

    /** いま操作対象になっている入力欄の定義を返す */
    function getActiveFieldSpec() {
        var a = document.activeElement;
        var found = null;
        FIELD_SPECS.forEach(function (s) { if (dom[s.id] === a) found = s; });
        return found;
    }

    function getFieldSpecById(id) {
        var found = null;
        FIELD_SPECS.forEach(function (s) { if (s.id === id) found = s; });
        return found;
    }

    /** 選択の有無・キャレット位置に応じてフロートを出し分ける */
    function updateVarFloat() {
        var bar = dom['var-float'];
        if (!bar) return;
        // メニュー内を操作している最中に消さない
        if (bar.contains(document.activeElement)) return;

        var spec = getActiveFieldSpec();
        if (!state.editing || !spec) { clearActiveToken(); hideVarFloat(); return; }

        var input = dom[spec.id];
        var hasSelection = input.selectionStart !== input.selectionEnd;
        var token = hasSelection ? null : tokenAtCaret(input.value, input.selectionStart);

        var prev = state.activeToken;
        var prevField = state.activeFieldId;
        state.activeToken = token;
        state.activeFieldId = token ? spec.id : null;
        if (JSON.stringify(prev) !== JSON.stringify(token) || prevField !== state.activeFieldId) {
            if (prevField && prevField !== state.activeFieldId) renderFieldHighlight(getFieldSpecById(prevField));
            renderFieldHighlight(spec);
        }

        if (!hasSelection && !token) { hideVarFloat(); return; }

        // Escape で閉じたあとは、選択位置が変わるまで出し直さない
        var sig = spec.id + ':' + input.selectionStart + ':' + input.selectionEnd;
        if (state.floatDismissedAt === sig) { hideVarFloat(); return; }
        state.floatDismissedAt = null;

        var declared = token && state.editing.variables.some(function (v) { return v.key === token.key; });
        dom['var-float-make'].hidden = !hasSelection;
        dom['var-float-edit'].hidden = !token || !declared;
        dom['var-float-delete'].hidden = !token;
        dom['var-float-label'].textContent = token ? '{{' + token.key + '}}' : '';
        dom['var-float-label'].hidden = !token;

        bar.hidden = false;
        // メニュー内から Escape したときに戻る先と、押された時に使う選択範囲。
        // クリックで欄が blur するので、この時点で控えておく
        state.floatOriginFieldId = spec.id;
        state.floatOriginRange = { start: input.selectionStart, end: input.selectionEnd };
        // 変数上のときはブロックの実測値を、選択中は選択終端を基準にする
        var anchor;
        if (token) {
            var span = dom[spec.highlightId].querySelector('.var-token.is-active');
            if (span) {
                var r = span.getBoundingClientRect();
                anchor = { left: r.left + r.width / 2, top: r.top, bottom: r.bottom };
            }
        }
        if (!anchor) {
            var p = measureTextareaPoint(input, input.selectionEnd);
            anchor = { left: p.left, top: p.top, bottom: p.bottom };
        }
        positionVarFloat(anchor);
    }

    function clearActiveToken() {
        if (!state.activeToken) return;
        var prevField = state.activeFieldId;
        state.activeToken = null;
        state.activeFieldId = null;
        if (prevField) renderFieldHighlight(getFieldSpecById(prevField));
    }

    function hideVarFloat() {
        if (dom['var-float']) dom['var-float'].hidden = true;
    }

    /** Escape での明示的な打ち消し。同じ選択位置では出し直さない。
        メニュー内から呼ばれるとフォーカスが外れているので、出した元の欄を使う */
    function dismissVarFloat() {
        var spec = getActiveFieldSpec() || getFieldSpecById(state.floatOriginFieldId);
        if (spec) {
            var input = dom[spec.id];
            state.floatDismissedAt = spec.id + ':' + input.selectionStart + ':' + input.selectionEnd;
        }
        hideVarFloat();
    }

    // ==================== 本文のブロック表示 ====================
    /** 本文中の {{...}} の位置一覧を返す */
    function findTokens(text) {
        var re = new RegExp(VAR_PATTERN, 'g');
        var list = [];
        var m;
        while ((m = re.exec(text)) !== null) {
            list.push({ start: m.index, end: m.index + m[0].length, key: m[1].trim(), raw: m[0] });
        }
        return list;
    }

    /** キャレットが変数の内側にあるときだけ返す。
        両端（`{{` の左・`}}` の右）は除外する。含めると入力直後や
        変数の直前で打鍵しているときに毎回フロートが出てしまうため */
    function tokenAtCaret(text, pos) {
        var found = null;
        findTokens(text).forEach(function (t) {
            if (pos > t.start && pos < t.end) found = t;
        });
        return found;
    }

    /** 入力欄の背後の層に、変数をブロックとして描画する */
    function renderFieldHighlight(spec) {
        if (!spec) return;
        var layer = dom[spec.highlightId];
        var input = dom[spec.id];
        if (!layer || !input) return;
        var text = input.value;
        var declared = {};
        if (state.editing) state.editing.variables.forEach(function (v) { declared[v.key] = true; });

        var active = state.activeFieldId === spec.id ? state.activeToken : null;
        clearNode(layer);
        var pos = 0;
        findTokens(text).forEach(function (t) {
            if (t.start > pos) layer.appendChild(document.createTextNode(text.slice(pos, t.start)));
            var cls = 'var-token';
            if (!declared[t.key]) cls += ' is-undeclared';
            if (active && active.start === t.start && active.end === t.end) cls += ' is-active';
            layer.appendChild(el('span', { class: cls, text: t.raw }));
            pos = t.end;
        });
        // 複数行では末尾の改行だけだと最終行の高さが出ないので番兵を足す
        layer.appendChild(document.createTextNode(text.slice(pos) + (spec.multiline ? '\n' : '')));
        layer.scrollTop = input.scrollTop;
        layer.scrollLeft = input.scrollLeft;
    }

    function renderAllFieldHighlights() {
        FIELD_SPECS.forEach(renderFieldHighlight);
    }

    /** その変数の記述を1か所削除する。どこにも残らなければ定義も消す */
    function deleteActiveToken() {
        var token = state.activeToken;
        var spec = getFieldSpecById(state.activeFieldId);
        if (!token || !spec || !state.editing) return;
        var input = dom[spec.id];
        var text = input.value;
        input.value = text.slice(0, token.start) + text.slice(token.end);
        state.editing[spec.field] = input.value;
        input.focus();
        input.setSelectionRange(token.start, token.start);
        state.activeToken = null;
        state.activeFieldId = null;

        // どこにも残っていなければ定義も削除する
        var key = token.key;
        var t = state.editing;
        var stillUsed = detectVariables([t.to, t.cc, t.bcc, t.subject, t.body, t.bodyHtml].join('\n'))
            .indexOf(key) !== -1;
        var removedDef = false;
        if (!stillUsed) {
            var before = t.variables.length;
            t.variables = t.variables.filter(function (v) { return v.key !== key; });
            removedDef = t.variables.length !== before;
        }
        setDirty(true);
        refreshEditorAfterVarChange();
        showToast(removedDef
            ? '{{' + key + '}} を削除しました（差し込み変数の設定も削除）'
            : '{{' + key + '}} を1か所削除しました');
    }

    function showVarDialog() {
        var dlg = dom['var-dialog'];
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');   // showModal 非対応環境でも最低限開く
        dom['var-dialog-key'].focus();
        dom['var-dialog-key'].select();
    }

    /** 新規作成モード。確定すると指定の欄へ挿入される。
        呼び出し元が欄と範囲を渡すこと（フロート経由だと activeElement は
        ボタンに移っていて当てにならないため） */
    function openVarDialog(seedName, fieldSpec, range) {
        if (!state.editing) return;
        var key = sanitizeVarKey(seedName);
        state.varDialogMode = 'create';
        state.varDialogOriginalKey = null;
        fieldSpec = fieldSpec || getActiveFieldSpec() || getFieldSpecById('edit-body');
        var input = dom[fieldSpec.id];
        // showModal() は背後を inert にする。その際 入力欄の選択が失われる
        // ことがあるので、開いた時点の欄と範囲を控えて確定時に使う
        state.varDialogFieldKind = fieldSpec.kind;
        state.pendingFieldId = fieldSpec.id;
        state.pendingRange = range || { start: input.selectionStart, end: input.selectionEnd };

        var guess = guessVariableSpec(key);
        dom['var-dialog-title'].textContent = '差し込み変数にする';
        dom['var-dialog-ok'].textContent = fieldSpec.label + 'に挿入して追加';
        dom['var-dialog-key'].value = key;
        dom['var-dialog-label'].value = '';
        dom['var-dialog-required'].checked = false;
        var applied = fillVarDialogTypes(fieldSpec.kind, guess.type);
        syncVarDialogGuess(applied === guess.type ? guess.reason : '');
        setVarDialogDateFields(guess.type === 'date' ? guess : null);
        setVarDialogOptions([]);
        syncVarDialogType();
        syncVarDialogToken();
        showVarDialogError('');
        showVarDialog();
    }

    /** 既存変数の編集モード。確定しても挿入はしない（名前変更は全箇所へ反映） */
    function openVarDialogForEdit(key) {
        if (!state.editing) return;
        var v = null;
        state.editing.variables.forEach(function (x) { if (x.key === key) v = x; });
        if (!v) return;
        state.varDialogMode = 'edit';
        state.varDialogOriginalKey = v.key;

        // その変数が使われている欄すべての制限を満たす型だけを出す
        var kinds = fieldKindsUsingVariable(state.editing, v.key);
        var kind = kinds.indexOf('address') !== -1 ? 'address'
            : (kinds.indexOf('subject') !== -1 ? 'subject' : 'body');
        state.varDialogFieldKind = kind;
        state.pendingFieldId = null;
        state.pendingRange = null;

        dom['var-dialog-title'].textContent = '差し込み変数を編集';
        dom['var-dialog-ok'].textContent = '変更を保存';
        dom['var-dialog-key'].value = v.key;
        dom['var-dialog-label'].value = v.label === v.key ? '' : v.label;
        dom['var-dialog-required'].checked = !!v.required;
        fillVarDialogTypes(kind, v.type);
        syncVarDialogGuess('');
        setVarDialogDateFields(v.type === 'date' ? v : null);
        setVarDialogOptions(v.options || []);
        syncVarDialogType();
        syncVarDialogToken();
        showVarDialogError('');
        showVarDialog();
    }

    /** 日付欄へ値を流し込む。null なら命名ルールの既定に戻す */
    function setVarDialogDateFields(src) {
        var s = src || {};
        dom['var-dialog-base'].value = s.base || 'today';
        dom['var-dialog-offset'].value = s.offset != null ? s.offset : 0;
        dom['var-dialog-offset-unit'].value = s.offsetUnit || 'day';
        dom['var-dialog-format'].value = s.format || 'YYYY年M月D日(ddd)';
    }

    function setVarDialogOptions(list) {
        dom['var-dialog-options'].value = (list || []).join('\n');
    }

    /** ダイアログの日付設定から計算結果を出して見せる */
    function updateVarDialogDatePreview() {
        var out = dom['var-dialog-date-preview'];
        if (!out) return;
        if (dom['var-dialog-type'].value !== 'date') { out.hidden = true; return; }
        var v = {
            base: dom['var-dialog-base'].value,
            offset: dom['var-dialog-offset'].value,
            offsetUnit: dom['var-dialog-offset-unit'].value,
            format: dom['var-dialog-format'].value
        };
        out.textContent = describeAutoVariable(v) + ' → ' + resolveAutoVariable(v, new Date());
        out.hidden = false;
    }

    function closeVarDialog() {
        var dlg = dom['var-dialog'];
        if (typeof dlg.close === 'function' && dlg.open) dlg.close();
        else dlg.removeAttribute('open');
        state.varDialogMode = 'create';
        state.varDialogOriginalKey = null;
    }

    /** 開いた欄で使える型だけをプルダウンに並べる。
        すでに選ばれている型が使えない場合は先頭へ寄せる */
    function fillVarDialogTypes(kind, preferred) {
        var sel = dom['var-dialog-type'];
        clearNode(sel);
        var allowed = VAR_TYPES.filter(function (t) { return fieldKindAllowsType(kind, t.value); });
        allowed.forEach(function (t) { sel.appendChild(el('option', { value: t.value, text: t.label })); });
        var ok = allowed.some(function (t) { return t.value === preferred; });
        sel.value = ok ? preferred : (allowed[0] ? allowed[0].value : 'text');
        // 選べる型が1つしかないなら操作させない（理由は下の注記で示す）
        sel.disabled = allowed.length <= 1;
        var note = dom['var-dialog-kind-note'];
        if (note) {
            if (kind === 'address') {
                note.textContent = '宛先で使う変数はメールアドレス型に固定されます。';
                note.hidden = false;
            } else if (kind === 'subject') {
                note.textContent = '件名は改行を含められないため、複数行テキストは選べません。';
                note.hidden = false;
            } else {
                note.hidden = true;
            }
        }
        return sel.value;
    }

    function syncVarDialogToken() {
        var key = sanitizeVarKey(dom['var-dialog-key'].value);
        dom['var-dialog-token'].textContent = '{{' + (key || '変数名') + '}}';
    }

    function syncVarDialogGuess(reason) {
        var note = dom['var-dialog-guess'];
        if (!reason) {
            note.hidden = true;
            note.textContent = '';
            return;
        }
        note.textContent = '変数名から「' + reason + '」と判定しました。変更できます。';
        note.hidden = false;
    }

    /** 種類に応じて追加の設定欄を出し分ける。
        日付型は normalizeVariable が required=false を強制するので UI 側も揃える */
    function syncVarDialogType() {
        var type = dom['var-dialog-type'].value;
        var isDate = type === 'date';
        var cb = dom['var-dialog-required'];
        cb.disabled = isDate;
        if (isDate) cb.checked = false;
        dom['var-dialog-required-note'].hidden = !isDate;
        dom['var-dialog-date-block'].hidden = !isDate;
        dom['var-dialog-select-block'].hidden = type !== 'select';
        updateVarDialogDatePreview();
    }

    function showVarDialogError(msg) {
        var err = dom['var-dialog-key-error'];
        err.textContent = msg || '';
        err.hidden = !msg;
    }

    /** ダイアログの入力から変数オブジェクトを組み立てる。日付の既定は命名ルールから採る */
    function buildVariableFromDialog(key, base) {
        var type = dom['var-dialog-type'].value;
        var spec = guessVariableSpec(key);
        var raw = {
            key: key,
            label: dom['var-dialog-label'].value.trim() || key,
            type: type,
            required: dom['var-dialog-required'].checked,
            placeholder: (base && base.placeholder) || spec.placeholder || ''
        };
        // 選択肢・日付はダイアログで指定した内容をそのまま使う
        if (type === 'select') {
            raw.options = dom['var-dialog-options'].value.split('\n')
                .map(function (s) { return s.trim(); })
                .filter(function (s) { return s !== ''; });
            if (!raw.options.length && base && base.options) raw.options = base.options;
        }
        if (type === 'date') {
            raw.base = dom['var-dialog-base'].value;
            raw.offset = dom['var-dialog-offset'].value;
            raw.offsetUnit = dom['var-dialog-offset-unit'].value;
            raw.format = dom['var-dialog-format'].value.trim() || 'YYYY年M月D日(ddd)';
        }
        return normalizeVariable(raw);
    }

    function confirmVarDialog() {
        if (!state.editing) return;
        var key = sanitizeVarKey(dom['var-dialog-key'].value);
        var isEdit = state.varDialogMode === 'edit';
        var originalKey = state.varDialogOriginalKey;

        if (!key) {
            showVarDialogError('変数名を入力してください');
            dom['var-dialog-key'].focus();
            return;
        }
        var duplicate = state.editing.variables.some(function (v) {
            return v.key === key && !(isEdit && v.key === originalKey);
        });
        if (duplicate) {
            showVarDialogError('その名前の変数は既にあります。別の名前にしてください。');
            dom['var-dialog-key'].focus();
            return;
        }

        if (isEdit) {
            var idx = -1;
            state.editing.variables.forEach(function (v, i) { if (v.key === originalKey) idx = i; });
            if (idx < 0) { closeVarDialog(); return; }
            // 型を変えた場合、旧設定をそのまま引き継ぐと齟齬が出るので同型のときだけ引き継ぐ
            var prev = state.editing.variables[idx];
            var carry = prev.type === dom['var-dialog-type'].value ? prev : null;
            var updated = buildVariableFromDialog(key, carry);
            if (!updated) { showVarDialogError('この変数名は使用できません'); return; }
            state.editing.variables[idx] = updated;
            if (key !== originalKey) renameVariableEverywhere(originalKey, key);
            closeVarDialog();
            setDirty(true);
            refreshEditorAfterVarChange();
            showToast('変数「' + key + '」を更新しました');
            return;
        }

        var variable = buildVariableFromDialog(key, null);
        if (!variable) {
            showVarDialogError('この変数名は使用できません');
            return;
        }
        state.editing.variables.push(variable);
        var range = state.pendingRange;
        var targetSpec = getFieldSpecById(state.pendingFieldId) || getFieldSpecById('edit-body');
        closeVarDialog();
        // 控えておいた範囲を置換する（範囲が無ければキャレット位置に挿入）
        insertAtRange(dom[targetSpec.id], '{{' + key + '}}', range);
        state.editing[targetSpec.field] = dom[targetSpec.id].value;
        setDirty(true);
        refreshEditorAfterVarChange();
        showToast('{{' + key + '}} を追加しました');
    }

    /** 変数名の変更を宛先・件名・本文すべてに反映する */
    function renameVariableEverywhere(oldKey, newKey) {
        var t = state.editing;
        var from = '{{' + oldKey + '}}';
        var to = '{{' + newKey + '}}';
        ['to', 'cc', 'bcc', 'subject', 'body', 'bodyHtml'].forEach(function (f) {
            if (typeof t[f] !== 'string' || t[f].indexOf(from) === -1) return;
            t[f] = t[f].split(from).join(to);
        });
        // 表示中の入力欄へ反映
        [['edit-to', 'to'], ['edit-cc', 'cc'], ['edit-bcc', 'bcc'],
         ['edit-subject', 'subject'], ['edit-body', 'body'], ['edit-body-html', 'bodyHtml']].forEach(function (p) {
            if (dom[p[0]]) dom[p[0]].value = t[p[1]] || '';
        });
    }

    /** 変数が増減・改名したあとの再描画をひとまとめにする */
    function refreshEditorAfterVarChange() {
        renderEditorVariables();
        renderInsertChips();
        renderAllFieldHighlights();
        updateVarTypeWarnings();
        updateVarFloat();
        scheduleEditPreview();
    }

    function renderEditorVariables() {
        var wrap = dom['edit-variables'];
        clearNode(wrap);
        var vars = state.editing ? state.editing.variables : [];
        dom['edit-variables-empty'].hidden = vars.length > 0;
        vars.forEach(function (v, idx) {
            wrap.appendChild(buildVariableRow(v, idx, vars.length));
        });
    }

    function labeledField(labelText, control) {
        var block = el('div', { class: 'field-block' });
        block.appendChild(el('label', { for: control.id, text: labelText }));
        block.appendChild(control);
        return block;
    }

    function buildVariableRow(v, idx, total) {
        var prefix = 'var-' + idx + '-';
        var row = el('div', { class: 'var-row', 'data-idx': String(idx) });

        var head = el('div', { class: 'var-row-head' });
        head.appendChild(el('span', { class: 'var-row-title', text: '変数 ' + (idx + 1) + '：' + (v.key || '（未設定）') }));
        var actions = el('div', { class: 'var-row-actions' });
        var upBtn = el('button', { type: 'button', class: 'btn-icon', 'data-act': 'up', 'data-idx': String(idx), text: '↑', 'aria-label': (v.key || '変数 ' + (idx + 1)) + ' を上へ移動' });
        if (idx === 0) upBtn.disabled = true;
        var downBtn = el('button', { type: 'button', class: 'btn-icon', 'data-act': 'down', 'data-idx': String(idx), text: '↓', 'aria-label': (v.key || '変数 ' + (idx + 1)) + ' を下へ移動' });
        if (idx === total - 1) downBtn.disabled = true;
        var delBtn = el('button', { type: 'button', class: 'btn-icon btn-icon-danger', 'data-act': 'remove', 'data-idx': String(idx), text: '×', 'aria-label': (v.key || '変数 ' + (idx + 1)) + ' を削除' });
        actions.appendChild(upBtn);
        actions.appendChild(downBtn);
        actions.appendChild(delBtn);
        head.appendChild(actions);
        row.appendChild(head);

        var grid = el('div', { class: 'var-row-grid' });

        var keyInput = el('input', { type: 'text', id: prefix + 'key', maxlength: '40', autocomplete: 'off', 'data-idx': String(idx), 'data-field': 'key' });
        keyInput.value = v.key;
        grid.appendChild(labeledField('キー（本文中の {{名前}}）', keyInput));

        var labelInput = el('input', { type: 'text', id: prefix + 'label', maxlength: '60', autocomplete: 'off', 'data-idx': String(idx), 'data-field': 'label' });
        labelInput.value = v.label;
        grid.appendChild(labeledField('ラベル（入力欄の見出し）', labelInput));

        var typeSelect = buildSelect(VAR_TYPES, v.type, { id: prefix + 'type', 'data-idx': String(idx), 'data-field': 'type' });
        grid.appendChild(labeledField('種類', typeSelect));

        if (v.type === 'date') {
            var baseSelect = buildSelect(DATE_BASES, v.base, { id: prefix + 'base', 'data-idx': String(idx), 'data-field': 'base' });
            grid.appendChild(labeledField('基準日', baseSelect));

            var offsetInput = el('input', { type: 'number', id: prefix + 'offset', min: '-999', max: '999', step: '1', inputmode: 'numeric', 'data-idx': String(idx), 'data-field': 'offset' });
            offsetInput.value = String(v.offset);
            grid.appendChild(labeledField('オフセット（マイナスで過去）', offsetInput));

            var unitSelect = buildSelect(DATE_UNITS, v.offsetUnit, { id: prefix + 'unit', 'data-idx': String(idx), 'data-field': 'offsetUnit' });
            grid.appendChild(labeledField('オフセットの単位', unitSelect));

            var presetOptions = DATE_FORMATS.map(function (f) { return { value: f, label: f }; });
            presetOptions.push({ value: '__custom__', label: 'カスタム（自由入力）' });
            var presetValue = DATE_FORMATS.indexOf(v.format) >= 0 ? v.format : '__custom__';
            var presetSelect = buildSelect(presetOptions, presetValue, { id: prefix + 'formatPreset', 'data-idx': String(idx), 'data-field': 'formatPreset' });
            grid.appendChild(labeledField('書式プリセット', presetSelect));

            var formatInput = el('input', { type: 'text', id: prefix + 'format', maxlength: '60', autocomplete: 'off', 'data-idx': String(idx), 'data-field': 'format' });
            formatInput.value = v.format;
            grid.appendChild(labeledField('書式（YYYY / MM / M / DD / D / ddd / HH / mm）', formatInput));
        } else {
            var reqId = prefix + 'required';
            var reqBlock = el('div', { class: 'field-block checkbox-block' });
            var reqRow = el('div', { class: 'override-row' });
            var reqInput = el('input', { type: 'checkbox', id: reqId, 'data-idx': String(idx), 'data-field': 'required' });
            reqInput.checked = !!v.required;
            reqRow.appendChild(reqInput);
            reqRow.appendChild(el('label', { for: reqId, text: '必須にする' }));
            reqBlock.appendChild(reqRow);
            grid.appendChild(reqBlock);

            if (v.type === 'select') {
                var optionsArea = el('textarea', { id: prefix + 'options', rows: '3', 'data-idx': String(idx), 'data-field': 'options', placeholder: '1行に1つの選択肢' });
                optionsArea.value = (v.options || []).join('\n');
                grid.appendChild(labeledField('選択肢（改行区切り）', optionsArea));
            }

            var defaultControl;
            if (v.type === 'textarea') {
                defaultControl = el('textarea', { id: prefix + 'default', rows: '3', 'data-idx': String(idx), 'data-field': 'default' });
            } else {
                defaultControl = el('input', { type: 'text', id: prefix + 'default', autocomplete: 'off', 'data-idx': String(idx), 'data-field': 'default' });
            }
            defaultControl.value = v.default || '';
            grid.appendChild(labeledField('初期値', defaultControl));

            if (v.type === 'text') {
                var phInput = el('input', { type: 'text', id: prefix + 'placeholder', maxlength: '120', autocomplete: 'off', 'data-idx': String(idx), 'data-field': 'placeholder' });
                phInput.value = v.placeholder || '';
                grid.appendChild(labeledField('入力例（プレースホルダ）', phInput));
            }
        }

        row.appendChild(grid);

        if (v.type === 'date') {
            row.appendChild(el('p', { class: 'field-hint', text: '現在の計算結果: ' + resolveAutoVariable(v, new Date()) }));
        }
        return row;
    }

    function startEditing(tpl, isNew) {
        state.editing = tpl;
        state.editingIsNew = !!isNew;
        setDirty(false);
        renderEditTab();
        dom['editor-card'].hidden = false;
        dom['edit-name'].focus();
    }

    function initEditTab() {
        dom['new-template-btn'].addEventListener('click', function () {
            if (state.templates.length >= MAX_TEMPLATES) {
                showToast('テンプレートは最大 ' + MAX_TEMPLATES + ' 件までです');
                return;
            }
            if (state.dirty && !window.confirm('未保存の変更があります。破棄して新規作成しますか？')) return;
            startEditing(createEmptyTemplate(), true);
        });

        dom['edit-template-list'].addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
            if (!btn) return;
            var act = btn.getAttribute('data-act');
            var id = btn.getAttribute('data-id');
            var tpl = null;
            state.templates.forEach(function (t) { if (t.id === id) tpl = t; });
            if (!tpl) return;

            if (act === 'edit') {
                if (state.dirty && !window.confirm('未保存の変更があります。破棄して別のテンプレートを編集しますか？')) return;
                startEditing(cloneTemplate(tpl), false);
            } else if (act === 'duplicate') {
                if (state.templates.length >= MAX_TEMPLATES) {
                    showToast('テンプレートは最大 ' + MAX_TEMPLATES + ' 件までです');
                    return;
                }
                var copy = cloneTemplate(tpl);
                copy.id = uid();
                copy.name = (tpl.name + ' のコピー').slice(0, 60);
                copy.createdAt = Date.now();
                copy.updatedAt = Date.now();
                state.templates.push(copy);
                saveStore();
                renderAll();
                showToast('テンプレートを複製しました');
            } else if (act === 'delete') {
                if (!window.confirm('「' + tpl.name + '」を削除します。よろしいですか？')) return;
                state.templates = state.templates.filter(function (t) { return t.id !== id; });
                if (state.editing && state.editing.id === id) {
                    state.editing = null;
                    setDirty(false);
                }
                if (state.useTemplateId === id) {
                    state.useTemplateId = state.templates.length ? state.templates[0].id : null;
                    resetInputs(getCurrentTemplate());
                }
                saveStore();
                renderAll();
                showToast('テンプレートを削除しました');
            }
        });

        // 基本情報・本文
        [['edit-name', 'name'], ['edit-to', 'to'], ['edit-cc', 'cc'], ['edit-bcc', 'bcc'],
         ['edit-subject', 'subject'], ['edit-body', 'body'], ['edit-body-html', 'bodyHtml']].forEach(function (pair) {
            dom[pair[0]].addEventListener('input', function () {
                if (!state.editing) return;
                state.editing[pair[1]] = this.value;
                setDirty(true);
                scheduleAutoDetect();
                var fieldSpec = getFieldSpecById(pair[0]);
                if (fieldSpec) renderFieldHighlight(fieldSpec);
                if (pair[1] === 'name') validateName(false);
                validateAddressField(fieldSpec);
                scheduleEditPreview();
            });
        });
        dom['edit-name'].addEventListener('blur', function () { validateName(true); });

        // 変数チップ
        dom['insert-var-chips'].addEventListener('click', function (e) {
            var target = e.target;
            if (!target || !target.getAttribute) return;
            var key = target.getAttribute('data-insert-key');
            if (key) insertAtCursor(dom['edit-body'], '{{' + key + '}}');
        });

        // フロートメニューの出し入れ。宛先・件名・本文すべてで同じ挙動にする
        FIELD_SPECS.forEach(function (spec) {
            var input = dom[spec.id];
            if (!input) return;
            // キーボード選択（Shift+矢印）でも select が飛ぶ
            ['select', 'keyup', 'mouseup', 'input', 'focus', 'click'].forEach(function (evt) {
                input.addEventListener(evt, updateVarFloat);
            });
            input.addEventListener('scroll', function () {
                dom[spec.highlightId].scrollTop = this.scrollTop;
                dom[spec.highlightId].scrollLeft = this.scrollLeft;
                updateVarFloat();
            });
            // フォーカスが外れたら閉じる。ただしメニュー自身や別の入力欄へ
            // 移った場合は残す（移動先が出し直したものを消さないため）
            input.addEventListener('blur', function () {
                setTimeout(function () {
                    if (dom['var-float'].contains(document.activeElement)) return;
                    if (getActiveFieldSpec()) return;
                    hideVarFloat();
                }, 0);
            });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && !dom['var-float'].hidden) {
                    e.stopPropagation();
                    dismissVarFloat();
                }
            });
        });
        window.addEventListener('resize', function () {
            if (!dom['var-float'].hidden) updateVarFloat();
        });

        // メニューの操作
        dom['var-float-make'].addEventListener('click', function () {
            // クリックでフォーカスがこのボタンへ移るため activeElement は当てにできない。
            // メニューを出した時点の欄と選択範囲を使う
            var spec = getFieldSpecById(state.floatOriginFieldId);
            var range = state.floatOriginRange;
            if (!spec || !range) return;
            var seed = dom[spec.id].value.slice(range.start, range.end);
            openVarDialog(seed, spec, range);
            hideVarFloat();
        });
        dom['var-float-edit'].addEventListener('click', function () {
            if (state.activeToken) openVarDialogForEdit(state.activeToken.key);
            hideVarFloat();
        });
        dom['var-float-delete'].addEventListener('click', function () {
            deleteActiveToken();
            hideVarFloat();
        });
        dom['var-float'].addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var spec = getFieldSpecById(state.floatOriginFieldId) || getFieldSpecById('edit-body');
            dismissVarFloat();
            dom[spec.id].focus();
        });
        dom['var-float'].addEventListener('focusout', function () {
            setTimeout(function () {
                var a = document.activeElement;
                if (!getActiveFieldSpec() && !dom['var-float'].contains(a)) hideVarFloat();
            }, 0);
        });

        // 変数化ダイアログ
        DATE_BASES.forEach(function (b) {
            dom['var-dialog-base'].appendChild(el('option', { value: b.value, text: b.label }));
        });
        DATE_UNITS.forEach(function (u) {
            dom['var-dialog-offset-unit'].appendChild(el('option', { value: u.value, text: u.label }));
        });
        DATE_FORMATS.forEach(function (f) {
            dom['var-dialog-format-preset'].appendChild(el('option', { value: f, text: f }));
        });
        dom['var-dialog-key'].addEventListener('input', function () {
            syncVarDialogToken();
            showVarDialogError('');
        });
        dom['var-dialog-type'].addEventListener('change', function () {
            syncVarDialogType();
            syncVarDialogGuess('');   // 手で変えたら推定の説明は消す
        });
        ['var-dialog-base', 'var-dialog-offset', 'var-dialog-offset-unit', 'var-dialog-format']
            .forEach(function (id) {
                dom[id].addEventListener('input', updateVarDialogDatePreview);
                dom[id].addEventListener('change', updateVarDialogDatePreview);
            });
        dom['var-dialog-format-preset'].addEventListener('change', function () {
            dom['var-dialog-format'].value = this.value;
            updateVarDialogDatePreview();
        });
        dom['var-dialog-ok'].addEventListener('click', confirmVarDialog);
        dom['var-dialog-cancel'].addEventListener('click', closeVarDialog);
        dom['var-dialog'].addEventListener('close', function () {
            state.varDialogMode = 'create';
            state.varDialogOriginalKey = null;
        });
        // Enter で確定。IME 変換中の Enter は拾わない
        dom['var-dialog'].addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
            // 選択肢欄では改行を入れられるようにする
            if (e.target && e.target.tagName === 'TEXTAREA') return;
            e.preventDefault();
            confirmVarDialog();
        });

        dom['add-variable-btn'].addEventListener('click', function () {
            if (!state.editing) return;
            var n = state.editing.variables.length + 1;
            var key = '変数' + n;
            var existing = {};
            state.editing.variables.forEach(function (v) { existing[v.key] = true; });
            while (existing[key]) { n++; key = '変数' + n; }
            state.editing.variables.push(normalizeVariable({ key: key, label: key, type: 'text' }));
            setDirty(true);
            refreshEditorAfterVarChange();
        });

        // 変数行（動的生成）への委譲
        dom['edit-variables'].addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
            if (!btn || !state.editing) return;
            var idx = parseInt(btn.getAttribute('data-idx'), 10);
            var vars = state.editing.variables;
            if (isNaN(idx) || idx < 0 || idx >= vars.length) return;
            var act = btn.getAttribute('data-act');
            if (act === 'up' && idx > 0) {
                var tmp = vars[idx - 1]; vars[idx - 1] = vars[idx]; vars[idx] = tmp;
            } else if (act === 'down' && idx < vars.length - 1) {
                var tmp2 = vars[idx + 1]; vars[idx + 1] = vars[idx]; vars[idx] = tmp2;
            } else if (act === 'remove') {
                vars.splice(idx, 1);
            } else {
                return;
            }
            setDirty(true);
            refreshEditorAfterVarChange();
        });

        dom['edit-variables'].addEventListener('input', function (e) {
            handleVariableFieldChange(e.target, false);
        });
        dom['edit-variables'].addEventListener('change', function (e) {
            handleVariableFieldChange(e.target, true);
        });

        // HTML 出力設定
        Array.prototype.forEach.call(document.querySelectorAll('input[name="html-mode"]'), function (radio) {
            radio.addEventListener('change', function () {
                if (!radio.checked || !state.editing) return;
                state.editing.htmlMode = radio.value;
                dom['manual-html-wrap'].hidden = radio.value !== 'manual';
                setDirty(true);
                updateEditPreview();
            });
        });

        [['style-font', 'fontFamily'], ['style-size', 'fontSize'], ['style-line-height', 'lineHeight'],
         ['style-max-width', 'maxWidth'], ['style-color', 'color'], ['style-background', 'background'],
         ['style-link-color', 'linkColor'], ['style-custom-css', 'customCss']].forEach(function (pair) {
            dom[pair[0]].addEventListener('input', function () {
                if (!state.editing) return;
                state.editing.style[pair[1]] = this.value;
                setDirty(true);
                scheduleEditPreview();
            });
        });

        dom['editor-form'].addEventListener('submit', function (e) {
            e.preventDefault();
            saveEditing();
        });

        dom['discard-template-btn'].addEventListener('click', function () {
            if (state.dirty && !window.confirm('編集内容を破棄します。よろしいですか？')) return;
            state.editing = null;
            state.editingIsNew = false;
            setDirty(false);
            renderEditTab();
        });

        window.addEventListener('beforeunload', function (e) {
            if (!state.dirty) return;
            e.preventDefault();
            e.returnValue = '';
        });
    }

    function handleVariableFieldChange(target, isChange) {
        if (!state.editing || !target.getAttribute) return;
        var field = target.getAttribute('data-field');
        if (!field) return;
        var idx = parseInt(target.getAttribute('data-idx'), 10);
        var vars = state.editing.variables;
        if (isNaN(idx) || idx < 0 || idx >= vars.length) return;
        var v = vars[idx];
        var needsRerender = false;

        if (field === 'type') {
            if (!isChange) return;
            // 種類変更時は該当種類のフィールドを作り直す
            vars[idx] = normalizeVariable({ key: v.key, label: v.label, type: target.value, required: v.required, default: '' });
            needsRerender = true;
        } else if (field === 'formatPreset') {
            if (!isChange) return;
            if (target.value !== '__custom__') {
                v.format = target.value;
                needsRerender = true;
            }
        } else if (field === 'required') {
            v.required = target.checked;
        } else if (field === 'options') {
            v.options = target.value.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
        } else if (field === 'offset') {
            var n = parseInt(target.value, 10);
            v.offset = isNaN(n) ? 0 : n;
        } else if (field === 'key') {
            v.key = target.value.replace(/[{}\n]/g, '').slice(0, 40);
            if (target.value !== v.key) target.value = v.key;
        } else {
            v[field] = target.value;
        }

        setDirty(true);
        if (needsRerender) renderEditorVariables();
        renderInsertChips();
        renderAllFieldHighlights();
        updateVarTypeWarnings();   // 型を変えた直後にその場で気づけるようにする
        scheduleEditPreview();
    }

    function insertAtCursor(textarea, text) {
        insertAtRange(textarea, text, null);
    }

    /** range を渡すとその範囲を置換する。null なら現在のキャレット位置を使う */
    function insertAtRange(textarea, text, range) {
        var start = range ? range.start
            : (textarea.selectionStart != null ? textarea.selectionStart : textarea.value.length);
        var end = range ? range.end
            : (textarea.selectionEnd != null ? textarea.selectionEnd : textarea.value.length);
        var value = textarea.value;
        textarea.value = value.slice(0, start) + text + value.slice(end);
        var pos = start + text.length;
        textarea.focus();
        textarea.setSelectionRange(pos, pos);
        // input イベントを発火させて状態へ反映
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /* 欄ごとの型制限に違反している変数を洗い出す。
       同じ変数を宛先と本文で共用する場合はメールアドレス型に固定される。 */
    function findFieldTypeViolations(t) {
        var out = [];
        t.variables.forEach(function (v) {
            fieldKindsUsingVariable(t, v.key).forEach(function (kind) {
                if (fieldKindAllowsType(kind, v.type)) return;
                var spec = null;
                FIELD_SPECS.forEach(function (s) {
                    if (s.kind !== kind || spec) return;
                    if (String(t[s.field] || '').indexOf('{{' + v.key + '}}') !== -1) spec = s;
                });
                out.push({
                    key: v.key, type: v.type, kind: kind,
                    where: spec ? spec.label : kind,
                    fixTo: kind === 'address' ? 'email' : 'text'
                });
            });
        });
        return out;
    }

    function describeViolation(x) {
        var typeLabel = varTypeLabel(x.type);
        var fixLabel = varTypeLabel(x.fixTo);
        return '変数「' + x.key + '」は' + x.where + 'で使われているため、'
            + typeLabel + 'のままにはできません。' + fixLabel + 'に変えるか、'
            + x.where + 'からこの変数を外してください。';
    }

    /** ステップ3で型を変えた直後に気づけるよう、その場で知らせる */
    function updateVarTypeWarnings() {
        var box = dom['var-type-warn'];
        if (!box || !state.editing) return;
        var list = findFieldTypeViolations(state.editing);
        clearNode(box);
        box.hidden = !list.length;
        list.forEach(function (x) { box.appendChild(el('p', { text: describeViolation(x) })); });
    }

    function validateName(showError) {
        var name = dom['edit-name'].value.trim();
        var err = dom['edit-name-error'];
        if (!name) {
            if (showError) {
                err.textContent = 'テンプレート名を入力してください';
                err.hidden = false;
            }
            return false;
        }
        err.hidden = true;
        err.textContent = '';
        return true;
    }

    /** 宛先の形式チェックは緩く、警告のみ（変数記法・カンマ区切りを許容する） */
    /** To / Cc / Bcc の形式チェック。緩く警告するだけで保存は妨げない */
    function validateAddressField(spec) {
        if (!spec || spec.kind !== 'address') return;
        var warn = dom[spec.warnId];
        if (!warn) return;
        var raw = dom[spec.id].value.trim();
        if (!raw) {
            warn.hidden = true;
            return;
        }
        // 宛先で使える変数はメールアドレス型に限られるので、変数部分は
        // アドレスとみなす。ここで 'x' に潰すと必ず警告が出てしまう
        var stripped = raw.replace(new RegExp(VAR_PATTERN, 'g'), 'x@example.com');
        var suspicious = stripped.split(',').map(function (s) { return s.trim(); })
            .filter(function (s) { return s && s.indexOf('@') === -1; });
        if (suspicious.length) {
            warn.textContent = spec.label + 'にメールアドレスの形式でない指定があります: '
                + suspicious.join(', ') + '（そのまま保存できます）';
            warn.hidden = false;
        } else {
            warn.hidden = true;
        }
    }

    function validateAllAddressFields() {
        FIELD_SPECS.forEach(function (s) {
            if (s.kind === 'address') validateAddressField(s);
        });
    }

    function saveEditing() {
        if (!state.editing) return;
        if (!validateName(true)) {
            dom['edit-name'].focus();
            return;
        }
        var keys = {};
        var dupKey = null;
        state.editing.variables.forEach(function (v) {
            if (!v.key) return;
            if (keys[v.key]) dupKey = v.key;
            keys[v.key] = true;
        });
        if (dupKey) {
            showToast('変数キー「' + dupKey + '」が重複しています');
            return;
        }
        // 欄ごとの型制限。原因と直し方を示し、該当の変数行へフォーカスを送る
        var violations = findFieldTypeViolations(state.editing);
        if (violations.length) {
            updateVarTypeWarnings();
            var first = violations[0];
            var idx = -1;
            state.editing.variables.forEach(function (v, i) { if (v.key === first.key && idx < 0) idx = i; });
            var sel = document.getElementById('var-' + idx + '-type');
            if (sel) { sel.scrollIntoView({ block: 'center' }); sel.focus(); }
            showToast(describeViolation(first));
            return;
        }
        var normalized = normalizeTemplate(state.editing);
        if (!normalized) {
            showToast('保存できませんでした。テンプレート名を確認してください');
            return;
        }
        normalized.updatedAt = Date.now();

        var existingIndex = -1;
        state.templates.forEach(function (t, i) { if (t.id === normalized.id) existingIndex = i; });
        if (existingIndex >= 0) {
            normalized.createdAt = state.templates[existingIndex].createdAt;
            state.templates[existingIndex] = normalized;
        } else {
            if (state.templates.length >= MAX_TEMPLATES) {
                showToast('テンプレートは最大 ' + MAX_TEMPLATES + ' 件までです');
                return;
            }
            state.templates.push(normalized);
        }

        state.editing = null;
        state.editingIsNew = false;
        setDirty(false);
        if (!state.useTemplateId || state.useTemplateId === normalized.id) {
            state.useTemplateId = normalized.id;
            resetInputs(normalized);
        }
        saveStore();
        renderAll();
        showToast('テンプレートを保存しました');
    }

    var editPreviewTimer = null;
    function scheduleEditPreview() {
        if (editPreviewTimer) clearTimeout(editPreviewTimer);
        editPreviewTimer = setTimeout(updateEditPreview, PREVIEW_DEBOUNCE_MS);
    }

    function updateEditPreview() {
        if (!state.editing) return;
        var t = state.editing;
        // 編集プレビューでは初期値または {{key}} のまま表示する
        var values = {};
        t.variables.forEach(function (v) {
            if (v.type === 'date') values[v.key] = resolveAutoVariable(v, new Date());
            else if (v.default) values[v.key] = v.default;
            else if (v.type === 'select' && v.options && v.options.length) values[v.key] = v.options[0];
        });
        var body = applyVariables(t.body, values);
        var inner = (t.htmlMode === 'manual' && t.bodyHtml) ? applyVariables(t.bodyHtml, values) : textToHtml(body);
        dom['edit-frame'].srcdoc = buildHtmlDocument(inner, t.style);
    }

    // ==================== タブ3: データ管理 ====================
    function renderDataTab() {
        var bytes = storeSizeBytes();
        var kb = (bytes / 1024).toFixed(1);
        dom['data-stats'].textContent = '保存件数: ' + state.templates.length + ' / ' + MAX_TEMPLATES + ' 件　概算使用容量: ' + kb + ' KB';

        var list = dom['data-template-list'];
        clearNode(list);
        dom['data-empty'].hidden = state.templates.length > 0;
        state.templates.forEach(function (tpl) {
            var li = el('li', { class: 'tpl-item' });
            li.appendChild(el('span', { class: 'tpl-item-name', text: tpl.name }));
            var actions = el('div', { class: 'tpl-item-actions' });
            actions.appendChild(el('button', {
                type: 'button', class: 'btn btn-ghost btn-sm', 'data-export-id': tpl.id,
                text: '⤓ エクスポート', 'aria-label': tpl.name + ' を JSON でエクスポート'
            }));
            li.appendChild(actions);
            list.appendChild(li);
        });
    }

    function exportPayload(templates) {
        return JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            templates: templates
        }, null, 2);
    }

    function todayStamp() {
        var d = new Date();
        return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate());
    }

    function initDataTab() {
        dom['export-all-btn'].addEventListener('click', function () {
            if (!state.templates.length) {
                showToast('エクスポートできるテンプレートがありません');
                return;
            }
            downloadBlob(exportPayload(state.templates), 'mailtemplate-' + todayStamp() + '.json', 'application/json');
            showToast('全テンプレートをエクスポートしました');
        });

        dom['data-template-list'].addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('button[data-export-id]') : null;
            if (!btn) return;
            var id = btn.getAttribute('data-export-id');
            var tpl = null;
            state.templates.forEach(function (t) { if (t.id === id) tpl = t; });
            if (!tpl) return;
            downloadBlob(exportPayload([tpl]), safeFileName(tpl.name, '-' + todayStamp() + '.json'), 'application/json');
            showToast('「' + tpl.name + '」をエクスポートしました');
        });

        dom['import-btn'].addEventListener('click', function () {
            dom['import-file'].click();
        });

        dom['import-file'].addEventListener('change', function () {
            var file = this.files && this.files[0];
            this.value = '';
            if (!file) return;
            hideImportError();
            if (file.size > MAX_IMPORT_BYTES) {
                showImportError('ファイルサイズが上限を超えています（2MB まで）');
                return;
            }
            var reader = new FileReader();
            reader.onload = function () {
                var text = reader.result;
                if (typeof text !== 'string') {
                    showImportError('テキストファイルとして読み込めませんでした');
                    return;
                }
                handleImportText(text);
            };
            reader.onerror = function () {
                showImportError('ファイルの読み込みに失敗しました');
            };
            reader.readAsText(file, 'UTF-8');
        });

        dom['import-merge-btn'].addEventListener('click', function () { applyImport('merge'); });
        dom['import-replace-btn'].addEventListener('click', function () { applyImport('replace'); });
        dom['import-cancel-btn'].addEventListener('click', function () {
            state.pendingImport = null;
            dom['import-choice'].hidden = true;
        });

        dom['clear-all-btn'].addEventListener('click', function () {
            if (!state.templates.length) {
                showToast('削除するテンプレートがありません');
                return;
            }
            if (!window.confirm('保存されているテンプレートをすべて削除します。この操作は取り消せません。よろしいですか？')) return;
            state.templates = [];
            state.editing = null;
            setDirty(false);
            state.useTemplateId = null;
            resetInputs(null);
            saveStore();
            renderAll();
            showToast('すべてのテンプレートを削除しました');
        });
    }

    function showImportError(msg) {
        dom['import-error'].textContent = msg;
        dom['import-error'].hidden = false;
        dom['import-choice'].hidden = true;
        state.pendingImport = null;
    }

    function hideImportError() {
        dom['import-error'].hidden = true;
        dom['import-error'].textContent = '';
    }

    function handleImportText(text) {
        var obj;
        try {
            obj = JSON.parse(text);
        } catch (e) {
            showImportError('JSON として解析できませんでした。ファイルが壊れている可能性があります。');
            return;
        }
        if (!obj || typeof obj !== 'object' || !Array.isArray(obj.templates)) {
            showImportError('このツールのエクスポート形式ではありません（templates 配列が見つかりません）。');
            return;
        }
        if (obj.schemaVersion !== SCHEMA_VERSION) {
            showImportError('対応していないデータ形式です（schemaVersion: ' + String(obj.schemaVersion) + '、対応: ' + SCHEMA_VERSION + '）。');
            return;
        }
        var templates = obj.templates.map(normalizeTemplate).filter(Boolean);
        if (!templates.length) {
            showImportError('読み込めるテンプレートが含まれていませんでした。');
            return;
        }
        state.pendingImport = templates;
        dom['import-choice-title'].textContent = templates.length + ' 件のテンプレートを読み込みます。既存データへの反映方法を選んでください。';
        dom['import-choice'].hidden = false;
        dom['import-merge-btn'].focus();
    }

    function applyImport(mode) {
        var incoming = state.pendingImport;
        if (!incoming) return;
        if (mode === 'replace') {
            if (state.templates.length && !window.confirm('既存のテンプレートをすべて置き換えます。よろしいですか？')) return;
            state.templates = incoming.slice(0, MAX_TEMPLATES);
        } else {
            var existingIds = {};
            state.templates.forEach(function (t) { existingIds[t.id] = true; });
            incoming.forEach(function (t) {
                if (state.templates.length >= MAX_TEMPLATES) return;
                // ID 衝突時は新しい ID を採番して別テンプレートとして追加
                if (existingIds[t.id]) t.id = uid();
                existingIds[t.id] = true;
                state.templates.push(t);
            });
        }
        state.pendingImport = null;
        dom['import-choice'].hidden = true;
        state.editing = null;
        setDirty(false);
        if (!getCurrentTemplate()) {
            state.useTemplateId = state.templates.length ? state.templates[0].id : null;
            resetInputs(getCurrentTemplate());
        }
        saveStore();
        renderAll();
        showToast(mode === 'replace' ? 'テンプレートを置き換えました' : 'テンプレートを追加しました');
    }

    // ==================== 初期化 ====================
    function renderAll() {
        renderUseTab();
        renderEditTab();
        renderDataTab();
    }

    function init() {
        cacheDom();
        state.templates = loadStore();
        if (!state.storageAvailable) {
            dom['storage-warning'].hidden = false;
        }
        if (state.templates.length) {
            state.useTemplateId = state.templates[0].id;
            resetInputs(state.templates[0]);
        }
        initTabs();
        initUseTab();
        initEditTab();
        initDataTab();
        renderAll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
