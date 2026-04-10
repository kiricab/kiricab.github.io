/**
 * あみだくじ生成ツール
 * 参加者名と結果ラベルを入力し、SVGアニメーションでくじを表示する
 */

document.addEventListener('DOMContentLoaded', () => {

    // ─── 定数 ────────────────────────────────────────────────────────────────

    // SVGレイアウト用パディング・サイズ
    const PADDING_TOP    = 60;
    const PADDING_BOTTOM = 60;
    const PADDING_LEFT   = 50;
    const PADDING_RIGHT  = 50;
    const COL_WIDTH      = 80;  // 縦線同士の間隔
    const ROW_HEIGHT     = 28;  // 行の高さ（横線の間隔）

    // 横線密度の確率と行数計算関数
    const DENSITY_PROB = { low: 0.35, medium: 0.5, high: 0.65 };
    const DENSITY_ROWS = {
        low:    (n) => n * 3,
        medium: (n) => n * 5,
        high:   (n) => n * 8,
    };

    // 経路アニメーション用カラーパレット（参加者ごとに異なる色を割り当て）
    const PATH_COLORS = [
        '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
        '#1abc9c', '#e67e22', '#e91e63', '#00bcd4', '#8bc34a'
    ];

    // SVGネームスペース
    const SVG_NS = 'http://www.w3.org/2000/svg';

    // ─── アプリケーション状態 ─────────────────────────────────────────────

    const state = {
        participants: [],        // 参加者名の配列
        results: [],             // 結果ラベルの配列
        density: 'medium',       // 横線密度設定
        seed: 0,                 // 乱数シード（URL共有・再現に使用）
        amida: null,             // 生成されたあみだ構造体
        paths: [],               // 各参加者の経路データ
        animationId: null,       // requestAnimationFrameのID
        animating: false,        // アニメーション実行中フラグ
        resultLabelEls: [],      // SVG結果ラベル要素
    };

    // ─── DOM参照 ─────────────────────────────────────────────────────────────

    const participantsInput  = document.getElementById('participants-input');
    const resultsInput       = document.getElementById('results-input');
    const participantsCount  = document.getElementById('participants-count');
    const resultsCount       = document.getElementById('results-count');
    const inputError         = document.getElementById('input-error');
    const generateBtn        = document.getElementById('generate-btn');
    const inputSection       = document.getElementById('input-section');
    const amidaSection       = document.getElementById('amida-section');
    const amidaContainer     = document.getElementById('amida-container');
    const amidaSvg           = document.getElementById('amida-svg');
    const startBtn           = document.getElementById('start-btn');
    const skipBtn            = document.getElementById('skip-btn');
    const retryBtn           = document.getElementById('retry-btn');
    const copyUrlBtn         = document.getElementById('copy-url-btn');
    const resultListSection  = document.getElementById('result-list-section');
    const resultList         = document.getElementById('result-list');
    const densityBtns        = document.querySelectorAll('.density-btn');

    // ─── ユーティリティ ───────────────────────────────────────────────────────

    /**
     * テキストを改行で分割し、trim・空行除去した配列を返す
     * @param {string} text
     * @returns {string[]}
     */
    function parseLines(text) {
        return text.split('\n').map(s => s.trim()).filter(s => s.length > 0);
    }

    /**
     * LCGアルゴリズムによるシード付き疑似乱数生成器を返す
     * 同じシードを与えると毎回同じ乱数列を生成するため、URL共有による再現が可能
     * @param {number} seed 32bit符号なし整数
     * @returns {() => number} 0以上1未満の乱数を返す関数
     */
    function createRng(seed) {
        let s = (seed ^ 0x5A3C96AD) >>> 0;
        return function () {
            s = (Math.imul(1664525, s) + 1013904223) >>> 0;
            return s / 4294967296;
        };
    }

    /**
     * RNGを使ったFisher-Yatesシャッフル（再現性あり）
     * @param {Array} arr
     * @param {() => number} rng
     * @returns {Array}
     */
    function shuffleWithRng(arr, rng) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ─── バリデーション ───────────────────────────────────────────────────────

    /**
     * 入力値を検証し、バリデーション結果を返す
     * @returns {{ valid: boolean, participants: string[], results: string[], errorMsg: string }}
     */
    function validateInputs() {
        const participants = parseLines(participantsInput.value);
        const results      = parseLines(resultsInput.value);
        const n = participants.length;
        const m = results.length;

        if (n < 2) {
            return { valid: false, participants, results, errorMsg: '参加者は2名以上入力してください。' };
        }
        if (n > 10) {
            return { valid: false, participants, results, errorMsg: '参加者は10名以内で入力してください。' };
        }
        if (m === 0) {
            return { valid: false, participants, results, errorMsg: '結果ラベルを入力してください。' };
        }
        if (m !== n) {
            return {
                valid: false,
                participants,
                results,
                errorMsg: `結果ラベルの数（${m}個）が参加者数（${n}名）と一致していません。`,
            };
        }

        return { valid: true, participants, results, errorMsg: '' };
    }

    /**
     * カウント表示・エラー表示・生成ボタン状態を更新する
     */
    function updateUI() {
        const pLines = parseLines(participantsInput.value);
        const rLines = parseLines(resultsInput.value);

        participantsCount.textContent = `${pLines.length}名入力中`;
        resultsCount.textContent      = `${rLines.length}個入力中`;

        const { valid, errorMsg } = validateInputs();

        if (valid) {
            inputError.hidden = true;
            inputError.textContent = '';
        } else if (pLines.length > 0 || rLines.length > 0) {
            // 何か入力されている場合のみエラーを表示
            inputError.hidden = false;
            inputError.textContent = errorMsg;
        } else {
            inputError.hidden = true;
        }

        generateBtn.disabled = !valid;
    }

    // ─── あみだ構造生成 ───────────────────────────────────────────────────────

    /**
     * あみだくじの横線配置をランダムに生成する
     * 隣接する縦線を繋ぐ横線が重ならないよう、各行でシャッフルしながら配置する
     *
     * @param {number} n       縦線の本数（参加者数）
     * @param {number} rows    行数
     * @param {string} density 密度キー ('low'|'medium'|'high')
     * @returns {{ n: number, rows: number, horizontals: Array<{row: number, col: number}> }}
     */
    function generateAmidaStructure(n, rows, density, rng) {
        const prob        = DENSITY_PROB[density];
        const horizontals = [];

        for (let row = 0; row < rows; row++) {
            const indices  = shuffleWithRng([...Array(n - 1).keys()], rng);
            const usedCols = new Set();

            for (const col of indices) {
                if (!usedCols.has(col) && !usedCols.has(col - 1) && !usedCols.has(col + 1)) {
                    if (rng() < prob) {
                        horizontals.push({ row, col });
                        usedCols.add(col);
                    }
                }
            }
        }

        return { n, rows, horizontals };
    }

    // ─── 経路追跡 ─────────────────────────────────────────────────────────────

    /**
     * 全参加者の経路をSVG座標列として計算する
     *
     * @param {{ n: number, rows: number, horizontals: Array<{row: number, col: number}> }} amida
     * @returns {Array<{ svgPoints: Array<{x: number, y: number}>, startIndex: number, endIndex: number }>}
     */
    function traceAllPaths(amida) {
        const { n, rows, horizontals } = amida;

        // 高速検索用のハッシュマップを構築: "row-col" → true
        const hMap = new Map();
        for (const { row, col } of horizontals) {
            hMap.set(`${row}-${col}`, true);
        }

        // SVG座標変換ヘルパー
        const xOf     = (col) => PADDING_LEFT + col * COL_WIDTH;
        const yTop    = (row) => PADDING_TOP + row * ROW_HEIGHT;
        const yMid    = (row) => PADDING_TOP + row * ROW_HEIGHT + ROW_HEIGHT / 2;
        const yBottom = (row) => PADDING_TOP + (row + 1) * ROW_HEIGHT;

        const paths = [];

        for (let start = 0; start < n; start++) {
            let cur = start;
            const points = [];

            // 1. 参加者ラベルからの接続点（ラベル直下）
            points.push({ x: xOf(cur), y: PADDING_TOP / 2 });
            // 2. 縦線の上端
            points.push({ x: xOf(cur), y: PADDING_TOP });

            // 3. 各行を上から下へ辿る
            for (let row = 0; row < rows; row++) {
                // 右方向の横線チェック（cur列とcur+1列を繋ぐ）
                if (hMap.has(`${row}-${cur}`)) {
                    // 横線の中心Y座標へ移動してから右の縦線へ
                    points.push({ x: xOf(cur),     y: yMid(row) });
                    points.push({ x: xOf(cur + 1), y: yMid(row) });
                    cur++;
                }
                // 左方向の横線チェック（cur-1列とcur列を繋ぐ）
                else if (cur > 0 && hMap.has(`${row}-${cur - 1}`)) {
                    // 横線の中心Y座標へ移動してから左の縦線へ
                    points.push({ x: xOf(cur),     y: yMid(row) });
                    points.push({ x: xOf(cur - 1), y: yMid(row) });
                    cur--;
                }
                // 行の終端（次の行の上端）へ縦移動
                points.push({ x: xOf(cur), y: yBottom(row) });
            }

            // 4. 結果ラベルへの接続点（縦線下端から少し下）
            points.push({
                x: xOf(cur),
                y: PADDING_TOP + rows * ROW_HEIGHT + PADDING_BOTTOM / 2,
            });

            paths.push({ svgPoints: points, startIndex: start, endIndex: cur });
        }

        return paths;
    }

    // ─── SVG構築 ─────────────────────────────────────────────────────────────

    /**
     * SVG要素を生成してDOMに描画する
     * 描画順: 縦線 → 横線 → 参加者ラベル → 結果ラベル → 経路（polyline）
     *
     * @param {{ n: number, rows: number, horizontals: Array }} amida
     * @param {string[]} participants
     * @param {string[]} results       結果ラベル（インデックス順そのまま下端に配置）
     * @param {Array}    paths
     */
    function buildSVG(amida, participants, results, paths) {
        const { n, rows, horizontals } = amida;

        // SVG全体のサイズ計算
        const width  = PADDING_LEFT + (n - 1) * COL_WIDTH + PADDING_RIGHT;
        const height = PADDING_TOP  + rows * ROW_HEIGHT   + PADDING_BOTTOM;

        // SVG属性を設定
        amidaSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        amidaSvg.setAttribute('width', width);
        amidaSvg.setAttribute('height', height);
        // 既存の子要素をクリア
        while (amidaSvg.firstChild) {
            amidaSvg.removeChild(amidaSvg.firstChild);
        }

        // コンテナのmin-widthを設定してはみ出し時にスクロール可能にする
        amidaContainer.style.minWidth = width + 'px';

        const xOf = (col) => PADDING_LEFT + col * COL_WIDTH;

        // ── 1. 縦線を描画 ──────────────────────────────────────────────────
        for (let i = 0; i < n; i++) {
            const line = document.createElementNS(SVG_NS, 'line');
            line.setAttribute('class', 'v-line');
            line.setAttribute('x1', xOf(i));
            line.setAttribute('y1', PADDING_TOP);
            line.setAttribute('x2', xOf(i));
            line.setAttribute('y2', PADDING_TOP + rows * ROW_HEIGHT);
            amidaSvg.appendChild(line);
        }

        // ── 2. 横線を描画 ──────────────────────────────────────────────────
        for (const { row, col } of horizontals) {
            const yMid = PADDING_TOP + row * ROW_HEIGHT + ROW_HEIGHT / 2;
            const line = document.createElementNS(SVG_NS, 'line');
            line.setAttribute('class', 'h-line');
            line.setAttribute('x1', xOf(col));
            line.setAttribute('y1', yMid);
            line.setAttribute('x2', xOf(col + 1));
            line.setAttribute('y2', yMid);
            amidaSvg.appendChild(line);
        }

        // ── 3. 参加者ラベルを描画（縦線上端） ──────────────────────────────
        for (let i = 0; i < n; i++) {
            const text = document.createElementNS(SVG_NS, 'text');
            text.setAttribute('class', 'participant-label');
            text.setAttribute('x', xOf(i));
            text.setAttribute('y', PADDING_TOP / 2 - 4);
            text.textContent = participants[i];
            amidaSvg.appendChild(text);
        }

        // ── 4. 結果ラベルを描画（縦線下端、results配列のインデックス順） ────
        state.resultLabelEls = [];
        for (let i = 0; i < n; i++) {
            const text = document.createElementNS(SVG_NS, 'text');
            text.setAttribute('class', 'result-label');
            text.setAttribute('x', xOf(i));
            text.setAttribute('y', PADDING_TOP + rows * ROW_HEIGHT + PADDING_BOTTOM - 8);
            text.textContent = results[i];
            amidaSvg.appendChild(text);
            state.resultLabelEls.push(text);
        }

        // ── 5. 経路（polyline）を描画（アニメーション前はopacity=0） ────────
        for (let i = 0; i < paths.length; i++) {
            const { svgPoints } = paths[i];
            const pointsStr = svgPoints.map(p => `${p.x},${p.y}`).join(' ');

            const polyline = document.createElementNS(SVG_NS, 'polyline');
            polyline.setAttribute('class', 'path-line');
            polyline.setAttribute('data-index', i);
            polyline.setAttribute('points', pointsStr);
            polyline.setAttribute('stroke', PATH_COLORS[i % PATH_COLORS.length]);
            polyline.setAttribute('fill', 'none');
            polyline.style.opacity = '0';
            amidaSvg.appendChild(polyline);
        }
    }

    // ─── アニメーション ───────────────────────────────────────────────────────

    /** 1人あたりのアニメーション時間(ms) */
    const DURATION_PER_PERSON = 10000;

    /**
     * SVGのY座標（線形進行）をスクリーン座標に変換してスクロール追従する
     * easingとは独立した線形progressを受け取ることで一定速度を実現する
     * @param {number} linearProgress 0〜1の線形進行値
     */
    let _lastScrollTarget = -1;
    function scrollAtLinearProgress(linearProgress) {
        const svgRect = amidaSvg.getBoundingClientRect();
        const viewBox = amidaSvg.viewBox.baseVal;
        if (!viewBox || viewBox.height === 0) return;

        // SVG全体の高さを線形補間してY座標を求める
        const svgY   = viewBox.height * linearProgress;
        const scaleY = svgRect.height / viewBox.height;
        const pageY  = svgRect.top + window.scrollY + svgY * scaleY;
        // アニメーション中の点をビューポートの上40%付近に置く
        const target = Math.max(0, pageY - window.innerHeight * 0.4);

        // 変化が小さい場合はスキップ（過剰なスクロール呼び出しを防止）
        if (Math.abs(target - _lastScrollTarget) < 8) return;
        _lastScrollTarget = target;
        window.scrollTo({ top: target, behavior: 'smooth' });
    }

    /**
     * 全経路を1人ずつ順番にアニメーションで描画する
     * stroke-dashoffset + requestAnimationFrame（smoothstep easing）
     */
    function startAnimation() {
        startBtn.disabled = true;
        skipBtn.disabled  = false;
        state.animating   = true;
        _lastScrollTarget = -1;

        const pathElements = Array.from(amidaSvg.querySelectorAll('.path-line'));
        let currentIndex = 0;

        /** 次の参加者のアニメーションを開始する */
        function animateNext() {
            if (!state.animating) return;

            if (currentIndex >= pathElements.length) {
                // 全員完了
                state.animating  = false;
                skipBtn.disabled = true;
                revealResultLabels();
                showResults();
                return;
            }

            const el  = pathElements[currentIndex];
            const len = el.getTotalLength();
            el.style.opacity          = '1';
            el.style.strokeDasharray  = String(len);
            el.style.strokeDashoffset = String(len);

            let startTime = null;

            function frame(timestamp) {
                if (!state.animating) return;

                if (!startTime) startTime = timestamp;
                const elapsed  = timestamp - startTime;
                const progress = Math.min(elapsed / DURATION_PER_PERSON, 1);

                // smoothstep easing
                const eased = progress * progress * (3 - 2 * progress);
                const drawn = len * eased;
                el.style.strokeDashoffset = String(len - drawn);

                // スクロール追従: easing非依存の線形progressで一定速度スクロール
                scrollAtLinearProgress(progress);

                if (progress < 1) {
                    state.animationId = requestAnimationFrame(frame);
                } else {
                    currentIndex++;
                    animateNext();
                }
            }

            state.animationId = requestAnimationFrame(frame);
        }

        animateNext();
    }

    /**
     * アニメーションをスキップして即座に全経路を表示する
     */
    function skipAnimation() {
        if (state.animationId) {
            cancelAnimationFrame(state.animationId);
            state.animationId = null;
        }
        state.animating = false;

        // 全経路を即表示
        const pathElements = amidaSvg.querySelectorAll('.path-line');
        pathElements.forEach(el => {
            const len = el.getTotalLength();
            el.style.opacity          = '1';
            el.style.strokeDasharray  = String(len);
            el.style.strokeDashoffset = '0';
        });

        skipBtn.disabled = true;
        revealResultLabels();
        showResults();
    }

    /**
     * SVGの結果ラベルを表示する（アニメーション完了 or スキップ時）
     */
    function revealResultLabels() {
        state.resultLabelEls.forEach(el => { el.style.opacity = '1'; });
    }

    /**
     * 結果一覧セクションを表示し、各参加者の結果をリスト化する
     */
    function showResults() {
        skipBtn.disabled = true;
        resultListSection.hidden = false;

        // 既存のリストをクリア
        resultList.innerHTML = '';

        // 各参加者の結果を生成（pathsのendIndexで結果配列を引く）
        state.paths.forEach((path, i) => {
            const participantName = state.participants[path.startIndex];
            const resultName      = state.results[path.endIndex];
            const color           = PATH_COLORS[i % PATH_COLORS.length];

            const li = document.createElement('li');

            // 色付きドット
            const dot = document.createElement('span');
            dot.className         = 'result-dot';
            dot.style.backgroundColor = color;
            dot.setAttribute('aria-hidden', 'true');

            // 参加者名
            const nameSpan = document.createElement('span');
            nameSpan.className   = 'result-participant';
            nameSpan.textContent = participantName;

            // 矢印
            const arrow = document.createElement('span');
            arrow.className   = 'result-arrow';
            arrow.textContent = '→';
            arrow.setAttribute('aria-hidden', 'true');

            // 結果
            const valueSpan = document.createElement('span');
            valueSpan.className   = 'result-value';
            valueSpan.textContent = resultName;

            li.appendChild(dot);
            li.appendChild(nameSpan);
            li.appendChild(arrow);
            li.appendChild(valueSpan);
            resultList.appendChild(li);
        });

        // 結果セクションにスムーズスクロール
        resultListSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ─── URL共有 ─────────────────────────────────────────────────────────────

    /**
     * 現在の状態をbase64エンコードしてURLを生成する
     * UTF-8文字（日本語名）を安全にエンコードするため encodeURIComponent を使用
     * @returns {string}
     */
    function buildShareUrl() {
        const data = {
            p: state.participants,
            r: state.results,
            d: state.density,
            s: state.seed,
        };
        const encoded = btoa(encodeURIComponent(JSON.stringify(data)));
        const url = new URL(window.location.href);
        url.search = '';
        url.searchParams.set('v', encoded);
        return url.toString();
    }

    /**
     * URLをコピーしてボタンにフィードバックを表示する
     */
    function copyUrl() {
        const url = buildShareUrl();
        navigator.clipboard.writeText(url).then(() => {
            const original = copyUrlBtn.textContent;
            copyUrlBtn.textContent = 'コピーしました！';
            copyUrlBtn.disabled = true;
            setTimeout(() => {
                copyUrlBtn.textContent = original;
                copyUrlBtn.disabled = false;
            }, 2000);
        }).catch(() => {
            // clipboard API非対応時のフォールバック
            prompt('以下のURLをコピーしてください', url);
        });
    }

    /**
     * URLクエリパラメータから状態を復元し、あみだを生成する
     */
    function restoreFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const v = params.get('v');
        if (!v) return;
        try {
            const data = JSON.parse(decodeURIComponent(atob(v)));
            if (!Array.isArray(data.p) || !Array.isArray(data.r) || typeof data.s !== 'number') return;

            participantsInput.value = data.p.join('\n');
            resultsInput.value      = data.r.join('\n');

            const density = ['low', 'medium', 'high'].includes(data.d) ? data.d : 'medium';
            state.density = density;
            densityBtns.forEach(btn => {
                btn.classList.toggle('active', btn.dataset.density === density);
            });

            updateUI();
            generate(data.s);
        } catch (_) {
            // 不正なパラメータは無視
        }
    }

    // ─── メイン処理 ───────────────────────────────────────────────────────────

    /**
     * あみだくじを生成してSVGを描画する
     * @param {number} [forceSeed] URL復元時に指定するシード値
     */
    function generate(forceSeed) {
        const { valid, participants, results, errorMsg } = validateInputs();
        if (!valid) {
            inputError.hidden = false;
            inputError.textContent = errorMsg;
            return;
        }

        state.participants = participants;
        state.results      = results;
        // 新規生成はランダムシード、URL復元時は指定シードを使用
        state.seed = (forceSeed !== undefined) ? (forceSeed >>> 0) : (Math.random() * 0xFFFFFFFF >>> 0);

        const n    = participants.length;
        const rows = DENSITY_ROWS[state.density](n);
        const rng  = createRng(state.seed);

        state.amida = generateAmidaStructure(n, rows, state.density, rng);
        state.paths = traceAllPaths(state.amida);
        buildSVG(state.amida, state.participants, state.results, state.paths);

        inputSection.hidden      = true;
        amidaSection.hidden      = false;
        resultListSection.hidden = true;

        startBtn.disabled    = false;
        skipBtn.disabled     = true;
        copyUrlBtn.disabled  = false;
        copyUrlBtn.textContent = 'URLをコピー';

        amidaSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /**
     * 入力画面に戻りやり直す
     */
    function reset() {
        if (state.animationId) {
            cancelAnimationFrame(state.animationId);
            state.animationId = null;
        }
        state.animating = false;

        amidaSection.hidden      = true;
        resultListSection.hidden = true;
        inputSection.hidden      = false;

        while (amidaSvg.firstChild) {
            amidaSvg.removeChild(amidaSvg.firstChild);
        }
        amidaContainer.style.minWidth = '';

        state.amida          = null;
        state.paths          = [];
        state.resultLabelEls = [];
        _lastScrollTarget    = -1;

        // URLパラメータをクリア
        history.replaceState(null, '', window.location.pathname);

        inputSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ─── イベントリスナー登録 ─────────────────────────────────────────────────

    participantsInput.addEventListener('input', updateUI);
    resultsInput.addEventListener('input', updateUI);

    densityBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            densityBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.density = btn.dataset.density;
        });
    });

    generateBtn.addEventListener('click', () => generate());
    startBtn.addEventListener('click', startAnimation);
    skipBtn.addEventListener('click', skipAnimation);
    retryBtn.addEventListener('click', reset);
    copyUrlBtn.addEventListener('click', copyUrl);

    // 初期UI設定 & URL復元
    updateUI();
    restoreFromUrl();
});
