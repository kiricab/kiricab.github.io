/**
 * 印鑑ジェネレーター
 * Canvas APIを使ってブラウザ上で印影画像を生成する。
 * 丸印（二重円）・角印（二重矩形）に対応し、縦書き文字を描画する。
 */

document.addEventListener('DOMContentLoaded', () => {

    // --- DOM要素の取得 ---
    const sealTextInput = document.getElementById('seal-text');
    const fontSelect = document.getElementById('font-select');
    const tiltSlider = document.getElementById('tilt-slider');
    const tiltValueDisplay = document.getElementById('tilt-value-display');
    const customTiltArea = document.getElementById('custom-tilt-area');
    const canvas = document.getElementById('seal-canvas');
    const previewPlaceholder = document.getElementById('preview-placeholder');
    const downloadBtn = document.getElementById('download-btn');
    const ctx = canvas.getContext('2d');

    // --- 状態管理 ---
    const state = {
        text: '',
        shape: 'circle',        // 'circle' | 'square'
        borderStyle: 'single',  // 'single' | 'double'
        textDirection: 'vertical', // 'vertical' | 'horizontal'
        tiltMode: '0',          // '0' | '-15' | 'custom'
        customAngle: 0,         // カスタム時の角度（度）
        color: '#c0392b',       // 朱色デフォルト
        font: "'Noto Serif JP', serif",
        size: 300,              // キャンバスサイズ（px）
    };

    // --- Google Fontsを動的に読み込む（OFLライセンス） ---
    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700&family=Noto+Sans+JP:wght@400;700&display=swap';
    document.head.appendChild(fontLink);

    // ========================================
    // 印鑑描画メイン関数
    // ========================================
    async function drawSeal() {
        const text = state.text.trim();

        // テキスト未入力時はキャンバスを非表示にしてプレースホルダーを表示
        if (!text) {
            canvas.style.display = 'none';
            previewPlaceholder.style.display = '';
            downloadBtn.disabled = true;
            downloadBtn.setAttribute('aria-disabled', 'true');
            return;
        }

        // キャンバスサイズを設定
        const size = state.size;
        // 傾きによってはみ出しを防ぐため、描画領域を少し広く取る
        const angleRad = getCurrentAngleRad();
        // 傾き分だけ余白を追加（最大45°の場合でも収まるよう対角線長を計算）
        const diagonal = Math.ceil(size * Math.sqrt(2));
        canvas.width = diagonal;
        canvas.height = diagonal;

        // フォントの読み込みを待つ
        await document.fonts.load(`bold ${size * 0.3}px ${state.font}`);

        // キャンバスをクリア（透過背景のためclearRectのみ）
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // キャンバス中央を基準に回転変換
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(angleRad);
        // 回転後は (0,0) が印鑑の中心になる

        // 印のスタイルに応じて枠と文字を描画
        if (state.shape === 'circle') {
            drawCircleSeal(ctx, size, text);
        } else {
            drawSquareSeal(ctx, size, text);
        }

        ctx.restore();

        // キャンバスを表示してプレースホルダーを非表示
        canvas.style.display = 'block';
        previewPlaceholder.style.display = 'none';
        downloadBtn.disabled = false;
        downloadBtn.removeAttribute('aria-disabled');
    }

    // ========================================
    // 丸印の描画（縦書き文字）
    // ========================================
    function drawCircleSeal(ctx, size, text) {
        const radius = size / 2;
        ctx.strokeStyle = state.color;

        let textAreaRadius;

        if (state.borderStyle === 'double') {
            // 二重円
            const outerLineWidth = size * 0.035;
            const innerLineWidth = size * 0.025;
            const gapBetweenCircles = size * 0.04;
            const outerRadius = radius - outerLineWidth / 2;
            const innerRadius = outerRadius - outerLineWidth / 2 - gapBetweenCircles - innerLineWidth / 2;

            ctx.lineWidth = outerLineWidth;
            ctx.beginPath();
            ctx.arc(0, 0, outerRadius, 0, Math.PI * 2);
            ctx.stroke();

            ctx.lineWidth = innerLineWidth;
            ctx.beginPath();
            ctx.arc(0, 0, innerRadius, 0, Math.PI * 2);
            ctx.stroke();

            textAreaRadius = innerRadius - innerLineWidth / 2 - size * 0.03;
        } else {
            // 単一線
            const lineWidth = size * 0.04;
            const circleRadius = radius - lineWidth / 2;

            ctx.lineWidth = lineWidth;
            ctx.beginPath();
            ctx.arc(0, 0, circleRadius, 0, Math.PI * 2);
            ctx.stroke();

            textAreaRadius = circleRadius - lineWidth / 2 - size * 0.03;
        }

        drawText(ctx, text, textAreaRadius * 2, textAreaRadius * 2, size);
    }

    // ========================================
    // 角印の描画（縦書き / 横書き文字）
    // ========================================
    function drawSquareSeal(ctx, size, text) {
        ctx.strokeStyle = state.color;

        let textArea;

        if (state.borderStyle === 'double') {
            // 二重矩形
            const outerLineWidth = size * 0.035;
            const innerLineWidth = size * 0.025;
            const gapBetweenRects = size * 0.04;

            const outerHalf = size / 2 - outerLineWidth / 2;
            ctx.lineWidth = outerLineWidth;
            ctx.strokeRect(-outerHalf, -outerHalf, outerHalf * 2, outerHalf * 2);

            const innerHalf = outerHalf - outerLineWidth / 2 - gapBetweenRects - innerLineWidth / 2;
            ctx.lineWidth = innerLineWidth;
            ctx.strokeRect(-innerHalf, -innerHalf, innerHalf * 2, innerHalf * 2);

            textArea = (innerHalf - innerLineWidth / 2 - size * 0.03) * 2;
        } else {
            // 単一線
            const lineWidth = size * 0.04;
            const half = size / 2 - lineWidth / 2;

            ctx.lineWidth = lineWidth;
            ctx.strokeRect(-half, -half, half * 2, half * 2);

            textArea = (half - lineWidth / 2 - size * 0.03) * 2;
        }

        drawText(ctx, text, textArea, textArea, size);
    }

    // ========================================
    // 文字描画（縦書き / 横書きを切り替え）
    // ========================================
    function drawText(ctx, text, areaWidth, areaHeight, sealSize) {
        if (state.textDirection === 'horizontal') {
            drawHorizontalText(ctx, text, areaWidth, areaHeight, sealSize);
        } else {
            drawVerticalText(ctx, text, areaWidth, areaHeight, sealSize);
        }
    }

    // 縦書き: 1文字ずつY座標をずらして縦に並べる
    function drawVerticalText(ctx, text, areaWidth, areaHeight, sealSize) {
        const chars = [...text];
        const charCount = chars.length;
        if (charCount === 0) return;

        ctx.fillStyle = state.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        let fontSize = Math.floor(areaHeight / charCount);
        fontSize = Math.min(fontSize, Math.floor(areaWidth * 0.85));
        fontSize = Math.max(fontSize, 8);

        ctx.font = `bold ${fontSize}px ${state.font}`;

        const totalHeight = fontSize * charCount;
        const startY = -totalHeight / 2 + fontSize / 2;

        chars.forEach((char, i) => {
            ctx.fillText(char, 0, startY + i * fontSize);
        });
    }

    // 横書き: 文字を1行で横に並べる
    function drawHorizontalText(ctx, text, areaWidth, areaHeight, sealSize) {
        const chars = [...text];
        const charCount = chars.length;
        if (charCount === 0) return;

        ctx.fillStyle = state.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 横方向に全文字を収めるようフォントサイズを決定
        let fontSize = Math.floor(areaWidth / charCount);
        fontSize = Math.min(fontSize, Math.floor(areaHeight * 0.85));
        fontSize = Math.max(fontSize, 8);

        ctx.font = `bold ${fontSize}px ${state.font}`;

        const totalWidth = fontSize * charCount;
        const startX = -totalWidth / 2 + fontSize / 2;

        chars.forEach((char, i) => {
            ctx.fillText(char, startX + i * fontSize, 0);
        });
    }

    // ========================================
    // 現在の傾き角度をラジアンで返す
    // ========================================
    function getCurrentAngleRad() {
        let deg = 0;
        if (state.tiltMode === '-15') {
            deg = -15;
        } else if (state.tiltMode === 'custom') {
            deg = state.customAngle;
        }
        return (deg * Math.PI) / 180;
    }

    // ========================================
    // イベントリスナーの設定
    // ========================================

    // テキスト入力
    sealTextInput.addEventListener('input', () => {
        state.text = sealTextInput.value;
        drawSeal();
    });

    // ボタングループ（スタイル・傾き・サイズ）
    document.querySelectorAll('.btn-option').forEach(btn => {
        btn.addEventListener('click', () => {
            const group = btn.dataset.group;
            const value = btn.dataset.value;

            // 同グループのactiveを解除
            document.querySelectorAll(`.btn-option[data-group="${group}"]`).forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-pressed', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-pressed', 'true');

            // 状態更新
            if (group === 'shape') {
                state.shape = value;
            } else if (group === 'border') {
                state.borderStyle = value;
            } else if (group === 'direction') {
                state.textDirection = value;
            } else if (group === 'tilt') {
                state.tiltMode = value;
                // カスタムスライダーの表示切り替え
                if (value === 'custom') {
                    customTiltArea.hidden = false;
                } else {
                    customTiltArea.hidden = true;
                }
            } else if (group === 'size') {
                state.size = parseInt(value, 10);
            }

            drawSeal();
        });
    });

    // カスタム傾きスライダー
    tiltSlider.addEventListener('input', () => {
        state.customAngle = parseInt(tiltSlider.value, 10);
        tiltValueDisplay.textContent = state.customAngle;
        drawSeal();
    });

    // 書体選択
    fontSelect.addEventListener('change', () => {
        state.font = fontSelect.value;
        drawSeal();
    });

    // 色見本ボタン
    document.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            // activeクラスを移動
            document.querySelectorAll('.color-swatch').forEach(s => {
                s.classList.remove('active');
                s.setAttribute('aria-pressed', 'false');
            });
            swatch.classList.add('active');
            swatch.setAttribute('aria-pressed', 'true');

            state.color = swatch.dataset.color;
            // カラーピッカーの値も同期
            document.getElementById('color-picker').value = rgbToHex(state.color);
            drawSeal();
        });
    });

    // カラーピッカー
    const colorPicker = document.getElementById('color-picker');
    colorPicker.addEventListener('input', () => {
        state.color = colorPicker.value;
        // 色見本のactiveを全解除
        document.querySelectorAll('.color-swatch').forEach(s => {
            s.classList.remove('active');
            s.setAttribute('aria-pressed', 'false');
        });
        drawSeal();
    });

    // ========================================
    // ダウンロード処理
    // 透過背景のPNGを生成してダウンロード
    // ========================================
    downloadBtn.addEventListener('click', () => {
        if (!state.text.trim()) return;

        const link = document.createElement('a');
        link.download = 'inkan.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
    });

    // ========================================
    // ユーティリティ関数
    // ========================================

    /**
     * CSS色文字列（#rrggbb形式またはCSSカラー名）をhex値に変換する補助関数
     * カラーピッカーへの値設定に使用
     */
    function rgbToHex(color) {
        // すでに#rrggbb形式の場合はそのまま返す
        if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
        // それ以外は一時的にCanvasで解釈させてhexに変換
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 1;
        tempCanvas.height = 1;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.fillStyle = color;
        tempCtx.fillRect(0, 0, 1, 1);
        const [r, g, b] = tempCtx.getImageData(0, 0, 1, 1).data;
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    // ========================================
    // 初期描画
    // フォント読み込み完了後に初期状態で描画を試みる
    // ========================================
    canvas.style.display = 'none';

    document.fonts.ready.then(() => {
        drawSeal();
    });

});
