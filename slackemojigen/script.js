document.addEventListener('DOMContentLoaded', () => {
    const textInput = document.getElementById('text-input');
    const fontSelect = document.getElementById('font-select');
    const colorPicker = document.getElementById('color-picker');
    const bgcolorPicker = document.getElementById('bgcolor-picker');
    const transparentBg = document.getElementById('transparent-bg');
    const stretchText = document.getElementById('stretch-text');
    const canvas = document.getElementById('preview-canvas');
    const downloadBtn = document.getElementById('download-btn');
    const ctx = canvas.getContext('2d');

    const fonts = {
        'M PLUS Rounded 1c': "'M PLUS Rounded 1c', sans-serif",
        'Noto Sans JP': "'Noto Sans JP', sans-serif",
        'Noto Serif JP': "'Noto Serif JP', serif",
        'Yusei Magic': "'Yusei Magic', cursive",
        'DotGothic16': "'DotGothic16', sans-serif",
        'Mochiy Pop P One': "'Mochiy Pop P One', sans-serif",
        'RocknRoll One': "'RocknRoll One', sans-serif",
        'Kiwi Maru': "'Kiwi Maru', serif",
    };

    // Google Fontsを動的にロード
    const fontFamilies = [
        'M+PLUS+Rounded+1c:wght@400;700',
        'Noto+Sans+JP:wght@400;700',
        'Noto+Serif+JP:wght@400;700',
        'Yusei+Magic',
        'DotGothic16',
        'Mochiy+Pop+P+One',
        'RocknRoll+One',
        'Kiwi+Maru'
    ];
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${fontFamilies.join('&family=')}&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
    
    // フォント選択肢を生成
    for (const name in fonts) {
        const option = document.createElement('option');
        option.value = fonts[name];
        option.textContent = name;
        fontSelect.appendChild(option);
    }
    
    
    async function drawCanvas() {
        const text = textInput.value;
        const font = fontSelect.value;
        
        // フォントの読み込みを待つ
        await document.fonts.load(`128px ${font}`);

        const color = colorPicker.value;
        const bgColor = bgcolorPicker.value;
        const isTransparent = transparentBg.checked;
        const isStretched = stretchText.checked;
        const align = 'center';
        const size = 128;
        canvas.width = size;
        canvas.height = size;

        console.log(font)

        ctx.clearRect(0, 0, size, size);

        if (!isTransparent) {
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, size, size);
        }

        ctx.fillStyle = color;
        ctx.textAlign = align;
        ctx.textBaseline = 'middle';

        const lines = text.split('\n');
        if (text === '') return;

        const padding = 10;
        const maxTextWidth = size - padding * 2;
        const maxTextHeight = size - padding * 2;

        let fontSize = 100; // 初期フォントサイズ

        // 最適なフォントサイズを見つける
        while (fontSize > 5) {
            ctx.font = `bold ${fontSize}px ${font}`;
            const metrics = lines.map(line => ctx.measureText(line));
            const maxWidth = Math.max(...metrics.map(m => m.width));
            const totalHeight = fontSize * lines.length * 1.1;

            if (maxWidth <= maxTextWidth && totalHeight <= maxTextHeight) {
                break; // 収まるサイズが見つかった
            }
            fontSize -= 1;
        }
        
        ctx.font = `bold ${fontSize}px ${font}`;
        
        const lineHeight = fontSize * 1.1;
        const metrics = lines.map(line => ctx.measureText(line));
        const unscaledBlockWidth = Math.max(...metrics.map(m => m.width));
        const unscaledBlockHeight = lines.length * lineHeight;

        let yScale = 1;

        // Determine block-level vertical scaling
        // if (isStretched && unscaledBlockWidth >= maxTextWidth - 1 && unscaledBlockHeight < maxTextHeight) {
        if (isStretched) {
            yScale = maxTextHeight / unscaledBlockHeight;
        }

        const totalHeightOfBaselines = (lines.length - 1) * lineHeight;
        const blockCenterX = size / 2;
        const blockCenterY = size / 2;

        let x;
        if (align === 'left') {
            x = padding;
        } else if (align === 'right') {
            x = size - padding;
        } else {
            x = size / 2;
        }

        ctx.save(); // Save initial state

        // Apply block-level vertical scaling
        ctx.translate(blockCenterX, blockCenterY);
        ctx.scale(1, yScale);
        ctx.translate(-blockCenterX, -blockCenterY);

        const startY = blockCenterY - totalHeightOfBaselines / 2;

        // Draw each line, applying line-specific horizontal scaling if needed
        lines.forEach((line, index) => {
            const lineWidth = metrics[index].width;
            let lineXScale = 1;

            // Check if horizontal stretching should be applied to this line
            // if (isStretched && unscaledBlockHeight >= maxTextHeight - 1 && lineWidth < maxTextWidth && lineWidth > 0) {
            if (isStretched) {
                lineXScale = maxTextWidth / lineWidth;
            }

            ctx.save(); // Save state before line-specific scaling

            // Apply line-specific horizontal scaling
            ctx.translate(x, 0);
            ctx.scale(lineXScale, 1);
            ctx.translate(-x, 0);

            ctx.fillText(line, x, startY + index * lineHeight);

            ctx.restore(); // Restore state after drawing the line
        });

        ctx.restore(); // Restore initial state
    }

    textInput.addEventListener('input', drawCanvas);
    fontSelect.addEventListener('change', drawCanvas);
    colorPicker.addEventListener('input', drawCanvas);
    bgcolorPicker.addEventListener('input', drawCanvas);
    transparentBg.addEventListener('change', drawCanvas);
    stretchText.addEventListener('change', drawCanvas);

    downloadBtn.addEventListener('click', () => {
        const text = textInput.value.replace(/\n/g, '_');
        const link = document.createElement('a');
        link.download = `${text || 'emoji'}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    });

    function toggleBgColorPicker() {
        bgcolorPicker.disabled = transparentBg.checked;
    }

    transparentBg.addEventListener('change', toggleBgColorPicker);

    // 初期状態で実行
    toggleBgColorPicker();

    // フォントの読み込みを待ってから初期描画
    document.fonts.ready.then(() => {
        drawCanvas();
    });
});
