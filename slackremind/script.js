// Slack /remind ジェネレーター
// すべてクライアントサイド完結。LocalStorage に履歴とお気に入りを保存する。

(function () {
    'use strict';

    // ---------- 定数 ----------
    const STORAGE_KEY = 'slackremind_v1';
    const MAX_HISTORY = 20;

    const MONTH_NAMES = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    // Slackの構文に合わせ、月→日の並び順で配列化
    const WEEKDAY_NAMES_EN = {
        0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
        4: 'Thursday', 5: 'Friday', 6: 'Saturday'
    };
    const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

    const WEEKDAY_JA = {
        0: '日', 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土'
    };

    // ---------- 状態 ----------
    let store = loadStore();
    let activeTab = 'relative';
    let activeHistoryTab = 'history';

    // フィールドごとの touched 状態（初回ロード時のエラー文言抑制用）
    // 一度でも input/change/blur されたフィールドのみ true になる
    const touched = {
        target: false,   // 宛先名（@user / #channel の名前欄）
        body: false,     // 本文
        rel: false,      // 相対時間（数値・単位）
        day: false,      // 今日明日（時刻）
        date: false,     // 日付指定（日付・時刻）
        repeat: false    // 繰り返し（時刻・曜日・日）
    };
    // コピーボタンが押されたら全フィールドを touched 扱いにするフラグ
    let copyAttempted = false;

    function markTouched(key) {
        touched[key] = true;
    }
    function markAllTouched() {
        Object.keys(touched).forEach((k) => { touched[k] = true; });
    }

    // ---------- DOM ----------
    const previewOutputEl = document.getElementById('preview-output');
    const previewExplainEl = document.getElementById('preview-explain');
    const previewErrorEl = document.getElementById('preview-error');
    const copyBtnEl = document.getElementById('copy-btn');
    const toastEl = document.getElementById('toast');

    const targetTypeEls = document.querySelectorAll('input[name="target-type"]');
    const targetNameWrapEl = document.getElementById('target-name-wrap');
    const targetNameEl = document.getElementById('target-name');
    const targetNameLabelEl = document.getElementById('target-name-label');
    const targetPrefixEl = document.getElementById('target-prefix');
    const targetNameErrorEl = document.getElementById('target-name-error');

    const bodyEl = document.getElementById('reminder-body');
    const bodyErrorEl = document.getElementById('body-error');

    const tabBtnEls = document.querySelectorAll('.tab-btn');
    const tabPanelEls = document.querySelectorAll('.tab-panel');

    const relAmountEl = document.getElementById('rel-amount');
    const relUnitEl = document.getElementById('rel-unit');
    const relErrorEl = document.getElementById('rel-error');

    const dayRelEls = document.querySelectorAll('input[name="day-rel"]');
    const dayTimeEl = document.getElementById('day-time');
    const dayErrorEl = document.getElementById('day-error');

    const dateDateEl = document.getElementById('date-date');
    const dateTimeEl = document.getElementById('date-time');
    const dateErrorEl = document.getElementById('date-error');

    const repeatPatternEls = document.querySelectorAll('input[name="repeat-pattern"]');
    const repeatWeeklyWrapEl = document.getElementById('repeat-weekly-wrap');
    const repeatMonthlyWrapEl = document.getElementById('repeat-monthly-wrap');
    const weekdayEls = document.querySelectorAll('input[name="weekday"]');
    const monthlyDayEl = document.getElementById('monthly-day');
    const repeatTimeEl = document.getElementById('repeat-time');
    const repeatErrorEl = document.getElementById('repeat-error');

    const historyListEl = document.getElementById('history-list');
    const favoritesListEl = document.getElementById('favorites-list');
    const historyEmptyEl = document.getElementById('history-empty');
    const historyTabBtnEls = document.querySelectorAll('.history-tab-btn');
    const historyClearBtnEl = document.getElementById('history-clear-btn');
    const settingsCardEl = document.querySelector('.settings-card');

    // ---------- 初期化 ----------
    function init() {
        // 日付の初期値は今日
        const today = new Date();
        dateDateEl.value = formatDateInputValue(today);
        dateDateEl.min = formatDateInputValue(today);

        // イベント
        // 宛先タイプを切り替えると名前欄を出すが、ここでは touched は付けない
        targetTypeEls.forEach((el) => el.addEventListener('change', onTargetTypeChange));
        targetNameEl.addEventListener('input', () => { markTouched('target'); update(); });
        targetNameEl.addEventListener('blur', () => { markTouched('target'); update(); });

        bodyEl.addEventListener('input', () => { markTouched('body'); update(); });
        bodyEl.addEventListener('blur', () => { markTouched('body'); update(); });

        tabBtnEls.forEach((el) => el.addEventListener('click', () => switchTab(el.dataset.tab)));

        relAmountEl.addEventListener('input', () => { markTouched('rel'); update(); });
        relAmountEl.addEventListener('blur', () => { markTouched('rel'); update(); });
        relUnitEl.addEventListener('change', () => { markTouched('rel'); update(); });

        dayRelEls.forEach((el) => el.addEventListener('change', () => { markTouched('day'); update(); }));
        dayTimeEl.addEventListener('input', () => { markTouched('day'); update(); });
        dayTimeEl.addEventListener('blur', () => { markTouched('day'); update(); });

        dateDateEl.addEventListener('input', () => { markTouched('date'); update(); });
        dateDateEl.addEventListener('blur', () => { markTouched('date'); update(); });
        dateTimeEl.addEventListener('input', () => { markTouched('date'); update(); });
        dateTimeEl.addEventListener('blur', () => { markTouched('date'); update(); });

        repeatPatternEls.forEach((el) => el.addEventListener('change', () => { markTouched('repeat'); onRepeatPatternChange(); }));
        weekdayEls.forEach((el) => el.addEventListener('change', () => { markTouched('repeat'); update(); }));
        monthlyDayEl.addEventListener('input', () => { markTouched('repeat'); update(); });
        monthlyDayEl.addEventListener('blur', () => { markTouched('repeat'); update(); });
        repeatTimeEl.addEventListener('input', () => { markTouched('repeat'); update(); });
        repeatTimeEl.addEventListener('blur', () => { markTouched('repeat'); update(); });

        copyBtnEl.addEventListener('click', onCopy);

        historyTabBtnEls.forEach((el) => el.addEventListener('click', () => switchHistoryTab(el.dataset.historyTab)));
        historyClearBtnEl.addEventListener('click', onClearHistory);

        // 初期描画
        onTargetTypeChange();
        onRepeatPatternChange();
        renderHistory();
        update();
    }

    // ---------- イベントハンドラ ----------
    function onTargetTypeChange() {
        const t = getTargetType();
        if (t === 'me') {
            targetNameWrapEl.hidden = true;
        } else {
            targetNameWrapEl.hidden = false;
            if (t === 'user') {
                targetPrefixEl.textContent = '@';
                targetNameLabelEl.textContent = 'ユーザー名';
                targetNameEl.placeholder = '例: alice';
            } else {
                targetPrefixEl.textContent = '#';
                targetNameLabelEl.textContent = 'チャンネル名';
                targetNameEl.placeholder = '例: general';
            }
        }
        update();
    }

    function switchTab(name) {
        activeTab = name;
        tabBtnEls.forEach((btn) => {
            const isActive = btn.dataset.tab === name;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        tabPanelEls.forEach((panel) => {
            const isActive = panel.id === `tab-${name}`;
            panel.classList.toggle('active', isActive);
            panel.hidden = !isActive;
        });
        update();
    }

    function onRepeatPatternChange() {
        const pattern = getRepeatPattern();
        repeatWeeklyWrapEl.hidden = pattern !== 'weekly';
        repeatMonthlyWrapEl.hidden = pattern !== 'monthly';
        update();
    }

    function switchHistoryTab(name) {
        activeHistoryTab = name;
        historyTabBtnEls.forEach((btn) => {
            const isActive = btn.dataset.historyTab === name;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        renderHistory();
    }

    function onClearHistory() {
        if (activeHistoryTab === 'history') {
            if (!confirm('履歴をすべて削除します。よろしいですか？')) return;
            store.history = [];
        } else {
            if (!confirm('お気に入りをすべて削除します。よろしいですか？')) return;
            store.favorites = [];
        }
        saveStore();
        renderHistory();
    }

    // ---------- 入力取得 ----------
    function getTargetType() {
        const checked = document.querySelector('input[name="target-type"]:checked');
        return checked ? checked.value : 'me';
    }

    function getDayRel() {
        const checked = document.querySelector('input[name="day-rel"]:checked');
        return checked ? checked.value : 'today';
    }

    function getRepeatPattern() {
        const checked = document.querySelector('input[name="repeat-pattern"]:checked');
        return checked ? checked.value : 'daily';
    }

    function getSelectedWeekdays() {
        const selected = [];
        weekdayEls.forEach((el) => { if (el.checked) selected.push(parseInt(el.value, 10)); });
        // 月→日の順に並べる
        selected.sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b));
        return selected;
    }

    // 宛先名から記号を除去
    function normalizeTargetName(raw) {
        return (raw || '').trim().replace(/^[@#]+/, '');
    }

    // ---------- 日時フォーマッタ ----------
    // 12時間制 (例: "3pm", "9am", "12:30pm")。0分は "Xam/pm"、それ以外は "X:MMam/pm"。
    function formatTime12(hh, mm) {
        const h = parseInt(hh, 10);
        const m = parseInt(mm, 10);
        if (Number.isNaN(h) || Number.isNaN(m)) return null;
        let displayHour = h % 12;
        if (displayHour === 0) displayHour = 12;
        const suffix = h < 12 ? 'am' : 'pm';
        if (m === 0) return `${displayHour}${suffix}`;
        return `${displayHour}:${String(m).padStart(2, '0')}${suffix}`;
    }

    function parseTimeInput(value) {
        if (!value) return null;
        const parts = value.split(':');
        if (parts.length < 2) return null;
        return { hh: parts[0], mm: parts[1] };
    }

    function ordinalSuffix(n) {
        // 1st, 2nd, 3rd, 4th... 21st, 22nd, 23rd, 24th... 31st
        const v = n % 100;
        if (v >= 11 && v <= 13) return `${n}th`;
        switch (n % 10) {
            case 1: return `${n}st`;
            case 2: return `${n}nd`;
            case 3: return `${n}rd`;
            default: return `${n}th`;
        }
    }

    function formatDateInputValue(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    // 日付指定モード用: "at 3pm on June 1st" / 年付きなら ", 2027"
    function formatDateOn(date, timeStr) {
        const monthName = MONTH_NAMES[date.getMonth()];
        const dayOrd = ordinalSuffix(date.getDate());
        const now = new Date();
        const yearPart = (date.getFullYear() !== now.getFullYear()) ? `, ${date.getFullYear()}` : '';
        return `at ${timeStr} on ${monthName} ${dayOrd}${yearPart}`;
    }

    // ---------- 英語生成 ----------
    // 返り値: { whenEn, whenJa } または { error }
    function buildWhen() {
        switch (activeTab) {
            case 'relative':   return buildRelative();
            case 'day':        return buildDay();
            case 'date':       return buildDate();
            case 'repeat':     return buildRepeat();
            default:           return { error: '日時の指定方法を選んでください' };
        }
    }

    function buildRelative() {
        const raw = relAmountEl.value;
        const n = parseInt(raw, 10);
        if (!raw || Number.isNaN(n) || n < 1) {
            return { error: '1以上の数値を入力してください', target: 'rel' };
        }
        const unit = relUnitEl.value; // minutes / hours / days
        const labelEn = (n === 1) ? unit.slice(0, -1) : unit; // minute / minutes
        const unitJa = { minutes: '分', hours: '時間', days: '日' }[unit];
        return {
            whenEn: `in ${n} ${labelEn}`,
            whenJa: `${n}${unitJa}後に通知されます`
        };
    }

    function buildDay() {
        const parsed = parseTimeInput(dayTimeEl.value);
        if (!parsed) return { error: '時刻を指定してください', target: 'day' };
        const timeStr = formatTime12(parsed.hh, parsed.mm);
        if (!timeStr) return { error: '時刻を指定してください', target: 'day' };

        const dayRel = getDayRel();
        if (dayRel === 'today') {
            return { whenEn: `at ${timeStr} today`, whenJa: `今日の ${timeStr} に通知されます` };
        }
        if (dayRel === 'tomorrow') {
            return { whenEn: `at ${timeStr} tomorrow`, whenJa: `明日の ${timeStr} に通知されます` };
        }
        // 明後日: Slackに直接的なキーワードが無いため日付指定にフォールバック
        const dayafter = new Date();
        dayafter.setDate(dayafter.getDate() + 2);
        return {
            whenEn: formatDateOn(dayafter, timeStr),
            whenJa: `明後日（${dayafter.getFullYear()}年${dayafter.getMonth() + 1}月${dayafter.getDate()}日）の ${timeStr} に通知されます`
        };
    }

    function buildDate() {
        if (!dateDateEl.value) return { error: '日付を指定してください', target: 'date' };
        const parsedTime = parseTimeInput(dateTimeEl.value);
        if (!parsedTime) return { error: '時刻を指定してください', target: 'date' };
        const timeStr = formatTime12(parsedTime.hh, parsedTime.mm);
        if (!timeStr) return { error: '時刻を指定してください', target: 'date' };

        // 入力日付＋時刻を Date に組み立てて過去判定
        const [y, m, d] = dateDateEl.value.split('-').map((s) => parseInt(s, 10));
        const target = new Date(y, m - 1, d, parseInt(parsedTime.hh, 10), parseInt(parsedTime.mm, 10), 0, 0);
        if (Number.isNaN(target.getTime())) return { error: '日付を指定してください', target: 'date' };
        const now = new Date();
        if (target.getTime() <= now.getTime()) {
            return { error: '未来の日時を指定してください', target: 'date' };
        }
        return {
            whenEn: formatDateOn(target, timeStr),
            whenJa: `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日 ${timeStr} に通知されます`
        };
    }

    function buildRepeat() {
        const parsed = parseTimeInput(repeatTimeEl.value);
        if (!parsed) return { error: '時刻を指定してください', target: 'repeat' };
        const timeStr = formatTime12(parsed.hh, parsed.mm);
        if (!timeStr) return { error: '時刻を指定してください', target: 'repeat' };

        const pattern = getRepeatPattern();
        switch (pattern) {
            case 'daily':
                return { whenEn: `every day at ${timeStr}`, whenJa: `毎日 ${timeStr} に繰り返し通知されます` };
            case 'weekday':
                return { whenEn: `every weekday at ${timeStr}`, whenJa: `平日（月〜金）の ${timeStr} に繰り返し通知されます` };
            case 'weekend':
                return { whenEn: `every Saturday, Sunday at ${timeStr}`, whenJa: `週末（土・日）の ${timeStr} に繰り返し通知されます` };
            case 'weekly': {
                const days = getSelectedWeekdays();
                if (days.length === 0) return { error: '曜日を1つ以上選択してください', target: 'repeat' };
                const namesEn = days.map((d) => WEEKDAY_NAMES_EN[d]).join(', ');
                const namesJa = days.map((d) => WEEKDAY_JA[d]).join('・');
                return {
                    whenEn: `every ${namesEn} at ${timeStr}`,
                    whenJa: `毎週${namesJa}曜の ${timeStr} に繰り返し通知されます`
                };
            }
            case 'monthly': {
                const n = parseInt(monthlyDayEl.value, 10);
                if (Number.isNaN(n) || n < 1 || n > 31) {
                    return { error: '1〜31の日付を指定してください', target: 'repeat' };
                }
                return {
                    whenEn: `every ${ordinalSuffix(n)} of the month at ${timeStr}`,
                    whenJa: `毎月${n}日の ${timeStr} に繰り返し通知されます`
                };
            }
            default:
                return { error: 'パターンを選択してください', target: 'repeat' };
        }
    }

    // ---------- バリデーションと組み立て ----------
    // 返り値: 常に partial（部分情報）を含み、ok フラグで完全可否を示す
    function build() {
        clearFieldErrors();

        const errors = {};

        // partial.* は「埋まっていれば値、欠けていれば null」を保持。プレビュー組み立てに使う。
        const partial = {
            targetType: getTargetType(),
            targetStr: null,    // 完成した宛先文字列（例: "me" / "@alice" / "#general"）
            targetDisplay: null,
            body: null,
            whenEn: null,
            whenJa: null
        };

        const targetType = partial.targetType;
        if (targetType === 'me') {
            partial.targetStr = 'me';
            partial.targetDisplay = 'me';
        } else {
            const name = normalizeTargetName(targetNameEl.value);
            if (!name) {
                errors.target = (targetType === 'user')
                    ? '@ユーザー名を入力してください'
                    : '#チャンネル名を入力してください';
            } else if (!/^[A-Za-z0-9._-]+$/.test(name)) {
                errors.target = '半角英数・ハイフン・アンダースコア・ピリオドのみ使用できます';
            } else {
                const prefix = (targetType === 'user') ? '@' : '#';
                partial.targetStr = prefix + name;
                partial.targetDisplay = partial.targetStr;
            }
        }

        const body = bodyEl.value.trim();
        if (!body) {
            errors.body = 'リマインド内容を入力してください';
        } else {
            partial.body = body;
        }

        const when = buildWhen();
        if (when.error) {
            errors.when = { msg: when.error, target: when.target };
        } else {
            partial.whenEn = when.whenEn;
            partial.whenJa = when.whenJa;
        }

        if (Object.keys(errors).length > 0) {
            applyFieldErrors(errors);
            return { ok: false, errors, partial };
        }

        const targetStr = partial.targetStr;
        const targetDisplay = partial.targetDisplay;
        const command = `/remind ${targetStr} to ${body} ${when.whenEn}`;
        const explain = buildExplain(targetType, targetDisplay, body, when.whenJa);
        const html = buildPreviewHtml(targetStr, body, when.whenEn);
        return {
            ok: true,
            command,
            html,
            explain,
            // 状態保存用
            state: {
                targetType,
                targetName: (targetType === 'me') ? '' : normalizeTargetName(targetNameEl.value),
                body,
                tab: activeTab,
                relative: { amount: relAmountEl.value, unit: relUnitEl.value },
                day: { rel: getDayRel(), time: dayTimeEl.value },
                date: { date: dateDateEl.value, time: dateTimeEl.value },
                repeat: {
                    pattern: getRepeatPattern(),
                    weekdays: getSelectedWeekdays(),
                    monthlyDay: monthlyDayEl.value,
                    time: repeatTimeEl.value
                }
            }
        };
    }

    function buildExplain(targetType, targetDisplay, body, whenJa) {
        const who = (targetType === 'me')
            ? '自分'
            : targetDisplay;
        return `${who} に「${truncateForExplain(body)}」を ${whenJa}。`;
    }

    function truncateForExplain(text) {
        const oneLine = text.replace(/\s+/g, ' ');
        if (oneLine.length <= 30) return oneLine;
        return oneLine.slice(0, 30) + '…';
    }

    function buildPreviewHtml(targetStr, body, whenEn) {
        // XSS対策: 全テキストをエスケープしてから組み立てる
        return `<span class="pv-cmd">/remind</span> ` +
            `<span class="pv-target">${escapeHtml(targetStr)}</span> ` +
            `<span class="pv-cmd">to</span> ` +
            `<span class="pv-body">${escapeHtml(body)}</span> ` +
            `<span class="pv-time">${escapeHtml(whenEn)}</span>`;
    }

    // 部分入力を許容するプレビュー組み立て。欠けているセグメントは .pv-missing で表示。
    function buildPartialPreviewHtml(partial) {
        const targetHtml = partial.targetStr
            ? `<span class="pv-target">${escapeHtml(partial.targetStr)}</span>`
            : `<span class="pv-missing">[宛先を入力]</span>`;
        const bodyHtml = partial.body
            ? `<span class="pv-body">${escapeHtml(partial.body)}</span>`
            : `<span class="pv-missing">[本文を入力]</span>`;
        const whenHtml = partial.whenEn
            ? `<span class="pv-time">${escapeHtml(partial.whenEn)}</span>`
            : `<span class="pv-missing">[いつ通知するか指定]</span>`;
        return `<span class="pv-cmd">/remind</span> ` +
            `${targetHtml} ` +
            `<span class="pv-cmd">to</span> ` +
            `${bodyHtml} ` +
            `${whenHtml}`;
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---------- フィールドエラー表示 ----------
    function clearFieldErrors() {
        [targetNameErrorEl, bodyErrorEl, relErrorEl, dayErrorEl, dateErrorEl, repeatErrorEl].forEach((el) => {
            el.textContent = '';
            el.hidden = true;
        });
        previewErrorEl.hidden = true;
        previewErrorEl.textContent = '';
    }

    function applyFieldErrors(errors) {
        // touched 前または copyAttempted 前のフィールドはエラー文言を出さない
        if (errors.target && (touched.target || copyAttempted)) {
            targetNameErrorEl.textContent = errors.target;
            targetNameErrorEl.hidden = false;
        }
        if (errors.body && (touched.body || copyAttempted)) {
            bodyErrorEl.textContent = errors.body;
            bodyErrorEl.hidden = false;
        }
        if (errors.when) {
            const targetMap = {
                rel: relErrorEl, day: dayErrorEl, date: dateErrorEl, repeat: repeatErrorEl
            };
            const el = targetMap[errors.when.target] || null;
            // when 系は、その日時タブに対応する touched キーを参照
            const shouldShow = touched[errors.when.target] || copyAttempted;
            if (el && shouldShow) {
                el.textContent = errors.when.msg;
                el.hidden = false;
            }
        }
    }

    // ---------- 画面更新 ----------
    function update() {
        const result = build();
        if (result.ok) {
            previewOutputEl.innerHTML = result.html;
            previewExplainEl.textContent = result.explain;
            previewErrorEl.hidden = true;
            previewErrorEl.textContent = '';
            copyBtnEl.disabled = false;
            previewOutputEl.dataset.command = result.command;
        } else {
            // 不足セグメントを [宛先を入力] 等として可視化したプレビューを常時表示する
            previewOutputEl.innerHTML = buildPartialPreviewHtml(result.partial);
            previewExplainEl.textContent = '入力を完成させると、ここに解釈が表示されます。';
            // ユーザー操作（コピー押下）由来でないので previewError は赤帯では出さない
            previewOutputEl.dataset.command = '';
        }
    }

    // ---------- コピー ----------
    async function onCopy() {
        // コピー押下時は全フィールドを touched 扱いにし、エラーを表面化させる
        copyAttempted = true;
        markAllTouched();
        const result = build();
        if (!result.ok) {
            // 最初のエラーを上部にも表示
            const firstError = pickFirstErrorMessage(result.errors);
            previewErrorEl.textContent = firstError || '入力に不備があります';
            previewErrorEl.hidden = false;
            showToast('入力を確認してください');
            // プレビューも最新化（pv-missing 反映のため）
            update();
            return;
        }
        try {
            await copyToClipboard(result.command);
            showToast('コピーしました');
            addToHistory(result.command, result.state);
        } catch (e) {
            // クリップボードAPIが使えない場合のフォールバック
            showToast('コピーに失敗しました');
        }
    }

    function pickFirstErrorMessage(errors) {
        if (errors.target) return errors.target;
        if (errors.body) return errors.body;
        if (errors.when) return errors.when.msg;
        return null;
    }

    function copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        // フォールバック: 一時的な textarea + execCommand
        return new Promise((resolve, reject) => {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'absolute';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                ok ? resolve() : reject(new Error('execCommand failed'));
            } catch (e) {
                reject(e);
            }
        });
    }

    // ---------- トースト ----------
    let toastTimer = null;
    function showToast(message) {
        toastEl.textContent = message;
        toastEl.hidden = false;
        // 1フレーム遅延でクラスを付与してフェードイン
        requestAnimationFrame(() => toastEl.classList.add('is-visible'));
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl.classList.remove('is-visible');
            setTimeout(() => { toastEl.hidden = true; }, 250);
        }, 1800);
    }

    // ---------- 履歴・お気に入り ----------
    function loadStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { history: [], favorites: [] };
            const obj = JSON.parse(raw);
            return {
                history: Array.isArray(obj.history) ? obj.history : [],
                favorites: Array.isArray(obj.favorites) ? obj.favorites : []
            };
        } catch (e) {
            return { history: [], favorites: [] };
        }
    }

    function saveStore() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        } catch (e) {
            // 容量超過: 古い履歴を削って再試行
            if (store.history.length > 1) {
                store.history = store.history.slice(0, Math.floor(store.history.length / 2));
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (_) { /* noop */ }
            }
        }
    }

    function addToHistory(command, state) {
        const entry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            command,
            state,
            createdAt: Date.now()
        };
        // 同一コマンドの直近重複は除去
        store.history = store.history.filter((h) => h.command !== command);
        store.history.unshift(entry);
        if (store.history.length > MAX_HISTORY) {
            store.history = store.history.slice(0, MAX_HISTORY);
        }
        saveStore();
        renderHistory();
    }

    function isFavorite(command) {
        return store.favorites.some((f) => f.command === command);
    }

    function toggleFavorite(entry) {
        if (isFavorite(entry.command)) {
            store.favorites = store.favorites.filter((f) => f.command !== entry.command);
            showToast('お気に入りを解除しました');
        } else {
            store.favorites.unshift({ ...entry, id: `fav-${entry.id}` });
            showToast('お気に入りに追加しました');
        }
        saveStore();
        renderHistory();
    }

    function deleteEntry(entry, kind) {
        if (kind === 'history') {
            store.history = store.history.filter((h) => h.id !== entry.id);
        } else {
            store.favorites = store.favorites.filter((f) => f.id !== entry.id);
        }
        saveStore();
        renderHistory();
    }

    function renderHistory() {
        const isHistory = activeHistoryTab === 'history';
        historyListEl.hidden = !isHistory;
        favoritesListEl.hidden = isHistory;

        const list = isHistory ? store.history : store.favorites;
        const targetEl = isHistory ? historyListEl : favoritesListEl;
        targetEl.innerHTML = '';

        if (list.length === 0) {
            historyEmptyEl.hidden = false;
            historyEmptyEl.textContent = isHistory
                ? 'まだ履歴はありません。コピーすると保存されます。'
                : 'まだお気に入りはありません。★ボタンで追加できます。';
            return;
        }
        historyEmptyEl.hidden = true;

        const frag = document.createDocumentFragment();
        list.forEach((entry) => {
            const li = document.createElement('li');
            li.className = 'history-item';

            const cmdBtn = document.createElement('button');
            cmdBtn.type = 'button';
            cmdBtn.className = 'history-item-cmd';
            cmdBtn.textContent = entry.command;
            cmdBtn.title = `${entry.command}\n（クリックでフォームに復元）`;
            cmdBtn.addEventListener('click', () => restoreEntry(entry));

            const favBtn = document.createElement('button');
            favBtn.type = 'button';
            favBtn.className = 'history-item-fav';
            const fav = isFavorite(entry.command);
            favBtn.classList.toggle('is-fav', fav);
            favBtn.textContent = fav ? '★' : '☆';
            favBtn.setAttribute('aria-label', fav ? 'お気に入りから削除' : 'お気に入りに追加');
            favBtn.addEventListener('click', () => toggleFavorite(entry));

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'history-item-del';
            delBtn.textContent = '×';
            delBtn.setAttribute('aria-label', '削除');
            delBtn.addEventListener('click', () => deleteEntry(entry, isHistory ? 'history' : 'favorites'));

            li.appendChild(cmdBtn);
            li.appendChild(favBtn);
            li.appendChild(delBtn);
            frag.appendChild(li);
        });
        targetEl.appendChild(frag);
    }

    function restoreEntry(entry) {
        const s = entry.state;
        if (!s) return;

        // 履歴復元はユーザーが意図して値を入れた状態と同等なので全フィールド touched にする
        markAllTouched();

        // 宛先
        targetTypeEls.forEach((el) => { el.checked = (el.value === s.targetType); });
        targetNameEl.value = s.targetName || '';
        onTargetTypeChange();

        // 本文
        bodyEl.value = s.body || '';

        // タブ
        switchTab(s.tab || 'relative');

        // 相対時間
        if (s.relative) {
            relAmountEl.value = s.relative.amount || '';
            relUnitEl.value = s.relative.unit || 'minutes';
        }
        // 今日明日
        if (s.day) {
            dayRelEls.forEach((el) => { el.checked = (el.value === s.day.rel); });
            dayTimeEl.value = s.day.time || '09:00';
        }
        // 日付指定
        if (s.date) {
            // 過去日付なら今日に上書き（minも更新済み）
            const today = formatDateInputValue(new Date());
            dateDateEl.value = (s.date.date && s.date.date >= today) ? s.date.date : today;
            dateTimeEl.value = s.date.time || '09:00';
        }
        // 繰り返し
        if (s.repeat) {
            repeatPatternEls.forEach((el) => { el.checked = (el.value === s.repeat.pattern); });
            const set = new Set(s.repeat.weekdays || []);
            weekdayEls.forEach((el) => { el.checked = set.has(parseInt(el.value, 10)); });
            monthlyDayEl.value = s.repeat.monthlyDay || 1;
            repeatTimeEl.value = s.repeat.time || '09:00';
            onRepeatPatternChange();
        }

        // ハイライト
        if (settingsCardEl) {
            settingsCardEl.classList.remove('is-flash');
            // リフロー強制
            void settingsCardEl.offsetWidth;
            settingsCardEl.classList.add('is-flash');
        }
        // スクロール
        settingsCardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        update();
    }

    // 起動
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
