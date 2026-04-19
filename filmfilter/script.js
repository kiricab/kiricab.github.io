/**
 * filmfilter/script.js
 * フィルム風フィルター ツール
 * Canvas API によるピクセル操作でフィルム調の色調・粒子感を再現する。
 * 完全クライアントサイド処理。外部ライブラリ不使用。
 */

'use strict';

// ============================================================
// 1. プリセット定義
//    各プリセットはコードネームのみ。実在商品名は一切含まない。
// ============================================================

/**
 * @typedef {Object} Preset
 * @property {string}   id       - コードネーム（例: "FJ-400P"）
 * @property {string}   category - "color-negative" | "reversal" | "monochrome"
 * @property {string}   label    - UI表示ラベル
 * @property {Function} curves   - (r, g, b) => {r, g, b}  トーンカーブ適用関数
 * @property {{r,g,b}}  highlights - ハイライトに加算するRGB値
 * @property {{r,g,b}}  shadows    - シャドウに加算するRGB値
 * @property {number}   saturation - 彩度調整量 (-100〜100)
 * @property {number}   grain      - 粒子感強度 (0〜100 相当 0〜25px加算範囲)
 * @property {number}   vignette   - ビネット強度 (0〜1)
 * @property {boolean}  [mono]     - モノクロプリセットかどうか
 * @property {number}   [contrast] - コントラスト補正量 (-100〜100)
 */

/** @type {Preset[]} */
const PRESETS = [
    // ---- カラーネガ ----
    {
        id: 'FJ-400P',
        category: 'color-negative',
        label: 'FJ-400P',
        curves: (r, g, b) => ({
            r: clamp(r * 0.95 + 5),
            g: clamp(g * 1.02),
            b: clamp(b * 1.05 + 3),
        }),
        highlights: { r: 0, g: 5, b: 12 },
        shadows:    { r: -3, g: 3, b: 8 },
        saturation: 0,
        grain: 8,
        vignette: 0.15,
    },
    {
        id: 'FJ-160N',
        category: 'color-negative',
        label: 'FJ-160N',
        curves: (r, g, b) => ({
            r: clamp(r * 0.92 + 4),
            g: clamp(g * 0.98 + 3),
            b: clamp(b * 1.0 + 2),
        }),
        highlights: { r: -2, g: 2, b: 4 },
        shadows:    { r: -2, g: 1, b: 3 },
        saturation: -10,
        grain: 5,
        vignette: 0.10,
    },
    {
        id: 'FJ-X400',
        category: 'color-negative',
        label: 'FJ-X400',
        curves: (r, g, b) => ({
            r: clamp(r * 1.05),
            g: clamp(g * 1.08),
            b: clamp(b * 0.96),
        }),
        highlights: { r: 6, g: 2, b: -4 },
        shadows:    { r: 4, g: -2, b: 0 },
        saturation: 15,
        grain: 14,
        vignette: 0.18,
        contrast: 10,
    },
    {
        id: 'KD-G400',
        category: 'color-negative',
        label: 'KD-G400',
        curves: (r, g, b) => ({
            r: clamp(r * 1.10 + 8),
            g: clamp(g * 1.04 + 4),
            b: clamp(b * 0.88),
        }),
        highlights: { r: 12, g: 8, b: -8 },
        shadows:    { r: 8, g: 4, b: -6 },
        saturation: 5,
        grain: 10,
        vignette: 0.20,
    },
    {
        id: 'KD-P160',
        category: 'color-negative',
        label: 'KD-P160',
        curves: (r, g, b) => ({
            r: clamp(r * 1.04 + 6),
            g: clamp(g * 0.98 + 5),
            b: clamp(b * 0.96 + 4),
        }),
        highlights: { r: 6, g: 3, b: 0 },
        shadows:    { r: 5, g: 2, b: -2 },
        saturation: -15,
        grain: 4,
        vignette: 0.12,
    },
    {
        id: 'KD-E100',
        category: 'color-negative',
        label: 'KD-E100',
        curves: (r, g, b) => ({
            r: clamp(r * 1.12),
            g: clamp(g * 1.0),
            b: clamp(b * 1.14),
        }),
        highlights: { r: 8, g: 0, b: 10 },
        shadows:    { r: 4, g: -2, b: 6 },
        saturation: 30,
        grain: 3,
        vignette: 0.22,
        contrast: 15,
    },

    // ---- リバーサル ----
    {
        id: 'FJ-V50',
        category: 'reversal',
        label: 'FJ-V50',
        curves: (r, g, b) => ({
            r: clamp(r * 1.08),
            g: clamp(g * 1.10),
            b: clamp(b * 0.94),
        }),
        highlights: { r: 4, g: 6, b: -6 },
        shadows:    { r: -6, g: -4, b: -8 },
        saturation: 35,
        grain: 5,
        vignette: 0.28,
        contrast: 25,
    },
    {
        id: 'FJ-P100F',
        category: 'reversal',
        label: 'FJ-P100F',
        curves: (r, g, b) => ({
            r: clamp(r * 1.0),
            g: clamp(g * 1.0),
            b: clamp(b * 1.04 + 2),
        }),
        highlights: { r: 0, g: 0, b: 6 },
        shadows:    { r: -2, g: -2, b: 2 },
        saturation: 5,
        grain: 3,
        vignette: 0.12,
    },
    {
        id: 'FJ-A100F',
        category: 'reversal',
        label: 'FJ-A100F',
        curves: (r, g, b) => ({
            r: clamp(r * 1.02 + 6),
            g: clamp(g * 0.98 + 4),
            b: clamp(b * 0.96 + 3),
        }),
        highlights: { r: 8, g: 4, b: 2 },
        shadows:    { r: 4, g: 2, b: 0 },
        saturation: -12,
        grain: 4,
        vignette: 0.10,
        contrast: -10,
    },
    {
        id: 'KD-E100V',
        category: 'reversal',
        label: 'KD-E100V',
        curves: (r, g, b) => ({
            r: clamp(r * 1.03 + 3),
            g: clamp(g * 1.0),
            b: clamp(b * 1.06 + 2),
        }),
        highlights: { r: 4, g: 0, b: 8 },
        shadows:    { r: 2, g: -1, b: 4 },
        saturation: 8,
        grain: 4,
        vignette: 0.15,
    },

    // ---- モノクロ ----
    {
        id: 'FJ-A100',
        category: 'monochrome',
        label: 'FJ-A100',
        mono: true,
        curves: (r, g, b) => {
            // 輝度重み: R*0.299 + G*0.587 + B*0.114
            const lum = clamp(r * 0.299 + g * 0.587 + b * 0.114);
            // 滑らかな階調（S字弱め）
            const v = gammaAdjust(lum, 1.02);
            return { r: v, g: v, b: v };
        },
        highlights: { r: 0, g: 0, b: 0 },
        shadows:    { r: 0, g: 0, b: 0 },
        saturation: -100,
        grain: 3,
        vignette: 0.08,
    },
    {
        id: 'KD-TX400',
        category: 'monochrome',
        label: 'KD-TX400',
        mono: true,
        curves: (r, g, b) => {
            const lum = clamp(r * 0.299 + g * 0.587 + b * 0.114);
            // コントラスト強め（S字カーブ）
            const v = sCurve(lum, 1.4);
            return { r: v, g: v, b: v };
        },
        highlights: { r: 0, g: 0, b: 0 },
        shadows:    { r: 0, g: 0, b: 0 },
        saturation: -100,
        grain: 22,
        vignette: 0.25,
        contrast: 20,
    },
    {
        id: 'KD-TM400',
        category: 'monochrome',
        label: 'KD-TM400',
        mono: true,
        curves: (r, g, b) => {
            const lum = clamp(r * 0.299 + g * 0.587 + b * 0.114);
            const v = sCurve(lum, 1.1);
            return { r: v, g: v, b: v };
        },
        highlights: { r: 0, g: 0, b: 0 },
        shadows:    { r: 0, g: 0, b: 0 },
        saturation: -100,
        grain: 10,
        vignette: 0.14,
    },
    {
        id: 'KD-TM100',
        category: 'monochrome',
        label: 'KD-TM100',
        mono: true,
        curves: (r, g, b) => {
            const lum = clamp(r * 0.299 + g * 0.587 + b * 0.114);
            // 非常に滑らかで精緻な階調
            const v = clamp(lum * 1.0);
            return { r: v, g: v, b: v };
        },
        highlights: { r: 0, g: 0, b: 0 },
        shadows:    { r: 0, g: 0, b: 0 },
        saturation: -100,
        grain: 2,
        vignette: 0.06,
    },
    {
        id: 'KD-TX1600',
        category: 'monochrome',
        label: 'KD-TX1600',
        mono: true,
        curves: (r, g, b) => {
            const lum = clamp(r * 0.299 + g * 0.587 + b * 0.114);
            // ハードなS字・暗部が深く落ちる
            const v = sCurve(lum, 1.8);
            return { r: v, g: v, b: v };
        },
        highlights: { r: 0, g: 0, b: 0 },
        shadows:    { r: 0, g: 0, b: 0 },
        saturation: -100,
        grain: 45,
        vignette: 0.35,
        contrast: 30,
    },
];

// ============================================================
// 2. ユーティリティ関数
// ============================================================

/** 値を 0〜255 にクランプ */
function clamp(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
}

/** S字トーンカーブ（強度 strength: 1.0=直線, 2.0=強いS字） */
function sCurve(v, strength) {
    const x = v / 255;
    // ロジスティック関数ベースのS字
    const center = 0.5;
    const k = 10 * (strength - 1) + 1;
    const sig = 1 / (1 + Math.exp(-k * (x - center)));
    const sigMin = 1 / (1 + Math.exp(-k * (0 - center)));
    const sigMax = 1 / (1 + Math.exp(-k * (1 - center)));
    const normalized = (sig - sigMin) / (sigMax - sigMin);
    return clamp(normalized * 255);
}

/** ガンマ補正 */
function gammaAdjust(v, gamma) {
    return clamp(Math.pow(v / 255, 1 / gamma) * 255);
}

/**
 * HSL -> RGB 変換
 * h: 0-360, s: 0-1, l: 0-1
 * returns {r, g, b} 0-255
 */
function hslToRgb(h, s, l) {
    if (s === 0) {
        const v = clamp(l * 255);
        return { r: v, g: v, b: v };
    }
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if      (h < 60)  { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    return {
        r: clamp((r + m) * 255),
        g: clamp((g + m) * 255),
        b: clamp((b + m) * 255),
    };
}

/**
 * RGB -> HSL 変換
 * r, g, b: 0-255
 * returns {h: 0-360, s: 0-1, l: 0-1}
 */
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s;
    const l = (max + min) / 2;
    if (max === min) {
        h = 0; s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if      (max === r) { h = ((g - b) / d + (g < b ? 6 : 0)) * 60; }
        else if (max === g) { h = ((b - r) / d + 2) * 60; }
        else                { h = ((r - g) / d + 4) * 60; }
    }
    return { h, s, l };
}

/** 彩度調整（satAdjust: -100〜100） */
function adjustSaturation(r, g, b, satAdjust) {
    if (satAdjust === 0) return { r, g, b };
    const { h, s, l } = rgbToHsl(r, g, b);
    const newS = Math.max(0, Math.min(1, s + satAdjust / 100));
    return hslToRgb(h, newS, l);
}

/**
 * ビネット強度を計算（中心からの距離 dx, dy: -1〜1 に正規化）
 * @returns {number} 暗化係数（1.0 = 変化なし, 0.0 = 完全黒）
 */
function vignetteCoeff(dx, dy, strength) {
    if (strength === 0) return 1.0;
    const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
    // 周辺が暗くなるよう二乗で効かせる
    const factor = 1 - strength * Math.pow(dist, 2);
    return Math.max(0, factor);
}

/**
 * 線形補間（lerp）
 * 原画素と加工後画素をフィルター強度（0〜1）で混合する
 */
function lerp(a, b, t) {
    return a + (b - a) * t;
}

/** 露出調整（-100〜100 → 乗数） */
function exposureMultiplier(ev) {
    return Math.pow(2, ev / 50);
}

/** コントラスト調整（-100〜100 → ルックアップテーブル適用） */
function applyContrast(v, con) {
    if (con === 0) return v;
    const factor = (259 * (con + 255)) / (255 * (259 - con));
    return clamp(factor * (v - 128) + 128);
}

/** ハイライト/シャドウ補正（対象ピクセルの輝度に応じて按分） */
function highlightShadowAdjust(v, lum, hlAdj, shAdj) {
    const t = lum / 255; // 0=暗部, 1=明部
    const hl = hlAdj * t;         // 明部に強く効く
    const sh = shAdj * (1 - t);   // 暗部に強く効く
    return clamp(v + hl + sh);
}

// ============================================================
// 3. メインフィルター処理
// ============================================================

/**
 * 画像データにプリセット＋微調整を適用してフィルター済みデータを返す。
 * @param {ImageData} srcData   - 元画像データ
 * @param {Preset}    preset    - 選択中プリセット
 * @param {Object}    adjusts   - スライダー値
 * @returns {ImageData}
 */
function applyFilter(srcData, preset, adjusts) {
    const { width, height, data } = srcData;
    const dst = new ImageData(width, height);
    const dstData = dst.data;

    // スライダー値を変数に展開
    const ev       = adjusts.exposure;    // -100〜100
    const con      = adjusts.contrast;   // -100〜100
    const sat      = adjusts.saturation; // -100〜100
    const temp     = adjusts.temperature;// -100〜100（青↔黄）
    const tint     = adjusts.tint;       // -100〜100（緑↔マゼンタ）
    const hlSlider = adjusts.highlights; // -100〜100
    const shSlider = adjusts.shadows;    // -100〜100
    const grainStr = adjusts.grain;      // 0〜100
    const vigStr   = adjusts.vignette;   // 0〜100
    const strength = adjusts.strength;   // 0〜100

    const evMul    = exposureMultiplier(ev);
    const vigCoef  = vigStr / 100;       // 0〜1
    const halfW    = width  / 2;
    const halfH    = height / 2;
    // ノイズ幅（グレイン 0-100 → 最大加算幅 0-40px）
    const grainAmp = grainStr * 0.40;
    // フィルター強度（0〜1）
    const filterT  = strength / 100;

    // プリセット内蔵のコントラスト補正値
    const presetCon = preset.contrast || 0;

    for (let y = 0; y < height; y++) {
        // ビネット計算用 dy（-1〜1 に正規化）
        const dy = (y - halfH) / halfH;

        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            let r = data[i], g = data[i + 1], b = data[i + 2];

            // 1. トーンカーブ（プリセット適用）
            const curved = preset.curves(r, g, b);
            r = curved.r; g = curved.g; b = curved.b;

            // 2. スプリットトーニング（ハイライト/シャドウ色調）
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const lumT = lum / 255;
            r = clamp(r + preset.highlights.r * lumT      + preset.shadows.r * (1 - lumT));
            g = clamp(g + preset.highlights.g * lumT      + preset.shadows.g * (1 - lumT));
            b = clamp(b + preset.highlights.b * lumT      + preset.shadows.b * (1 - lumT));

            // 3. 彩度（プリセット + スライダー）
            const totalSat = (preset.mono ? -100 : preset.saturation) + sat;
            if (!preset.mono) {
                const satResult = adjustSaturation(r, g, b, totalSat);
                r = satResult.r; g = satResult.g; b = satResult.b;
            } else {
                // モノクロ: 輝度に変換
                const mono = clamp(0.299 * r + 0.587 * g + 0.114 * b);
                r = mono; g = mono; b = mono;
            }

            // 4. 色温度（temp > 0 で黄→R+G↑, B↓ / temp < 0 で青↓→B↑）
            if (temp !== 0) {
                const t = temp / 100;
                r = clamp(r + t * 20);
                g = clamp(g + t * 10);
                b = clamp(b - t * 20);
            }

            // 5. 色被り（tint > 0 でマゼンタ, < 0 で緑）
            if (tint !== 0) {
                const ti = tint / 100;
                r = clamp(r + ti * 15);
                g = clamp(g - ti * 15);
                b = clamp(b + ti * 10);
            }

            // 6. 露出
            r = clamp(r * evMul);
            g = clamp(g * evMul);
            b = clamp(b * evMul);

            // 7. コントラスト（プリセット分 + スライダー分）
            const totalCon = Math.max(-100, Math.min(100, presetCon + con));
            r = applyContrast(r, totalCon);
            g = applyContrast(g, totalCon);
            b = applyContrast(b, totalCon);

            // 8. ハイライト/シャドウ
            const lumNow = 0.299 * r + 0.587 * g + 0.114 * b;
            r = highlightShadowAdjust(r, lumNow, hlSlider * 0.5, shSlider * 0.5);
            g = highlightShadowAdjust(g, lumNow, hlSlider * 0.5, shSlider * 0.5);
            b = highlightShadowAdjust(b, lumNow, hlSlider * 0.5, shSlider * 0.5);

            // 9. 粒子感（ノイズ加算）
            if (grainAmp > 0) {
                const noise = (Math.random() - 0.5) * 2 * grainAmp;
                if (preset.mono) {
                    // モノクロ: 輝度ノイズのみ
                    r = clamp(r + noise); g = clamp(g + noise); b = clamp(b + noise);
                } else {
                    // カラー: 弱い色ノイズ（各チャンネル独立、ただし弱めに）
                    r = clamp(r + noise * 0.7);
                    g = clamp(g + (Math.random() - 0.5) * 2 * grainAmp * 0.7);
                    b = clamp(b + noise * 0.7);
                }
            }

            // 10. フィルター強度（原画素との線形補間）
            if (filterT < 1) {
                r = Math.round(lerp(data[i],     r, filterT));
                g = Math.round(lerp(data[i + 1], g, filterT));
                b = Math.round(lerp(data[i + 2], b, filterT));
            }

            // 11. ビネット（中心から周辺を暗くする）
            if (vigCoef > 0) {
                const dx = (x - halfW) / halfW;
                const vc = vignetteCoeff(dx, dy, vigCoef);
                r = clamp(r * vc);
                g = clamp(g * vc);
                b = clamp(b * vc);
            }

            dstData[i]     = r;
            dstData[i + 1] = g;
            dstData[i + 2] = b;
            dstData[i + 3] = data[i + 3]; // アルファはそのまま
        }
    }
    return dst;
}

// ============================================================
// 4. サムネイル生成
// ============================================================

/**
 * プリセットのサムネイル用Canvasを生成する。
 * 元画像を小さいオフスクリーンCanvasで描画してフィルターを適用。
 * @param {HTMLImageElement} img
 * @param {Preset} preset
 * @returns {HTMLCanvasElement}
 */
function createThumbCanvas(img, preset) {
    const THUMB_W = 110, THUMB_H = 70;
    const oc = document.createElement('canvas');
    oc.width = THUMB_W; oc.height = THUMB_H;
    const ctx = oc.getContext('2d');
    ctx.drawImage(img, 0, 0, THUMB_W, THUMB_H);

    const imageData = ctx.getImageData(0, 0, THUMB_W, THUMB_H);
    // サムネイルはデフォルトパラメータのみ適用（スライダーは初期値）
    const defaultAdjusts = {
        exposure: 0, contrast: 0,
        saturation: 0, temperature: 0, tint: 0,
        highlights: 0, shadows: 0,
        grain: preset.grain,
        vignette: Math.round(preset.vignette * 100),
        strength: 100,
    };
    const filtered = applyFilter(imageData, preset, defaultAdjusts);
    ctx.putImageData(filtered, 0, 0);
    return oc;
}

// ============================================================
// 5. UI 管理
// ============================================================

/** DOMContentLoaded 以降に実行 */
document.addEventListener('DOMContentLoaded', () => {

    // --- DOM 参照 ---
    const uploadSection  = document.getElementById('upload-section');
    const uploadArea     = document.getElementById('upload-area');
    const fileInput      = document.getElementById('file-input');
    const previewSection = document.getElementById('preview-section');
    const filterSection  = document.getElementById('filter-section');
    const adjustSection  = document.getElementById('adjust-section');
    const actionSection  = document.getElementById('action-section');
    const spinner        = document.getElementById('spinner');
    const toast          = document.getElementById('toast');

    // プレビュー Canvas（スライドモード）
    const slideWrap      = document.getElementById('slide-wrap');
    const previewCanvas  = document.getElementById('preview-canvas');
    const previewCtx     = previewCanvas.getContext('2d');
    const sliderHandle   = document.getElementById('slider-handle');

    // プレビュー Canvas（トグルモード）
    const toggleWrap     = document.getElementById('toggle-wrap');
    const toggleCanvas   = document.getElementById('toggle-canvas');
    const toggleCtx      = toggleCanvas.getContext('2d');

    // 比較モードボタン
    const btnSlide       = document.getElementById('btn-slide');
    const btnToggle      = document.getElementById('btn-toggle');
    const btnShowOrig    = document.getElementById('btn-show-original');
    const btnChangeImage = document.getElementById('btn-change-image');

    // プリセットグリッド
    const presetGrid     = document.getElementById('preset-grid');
    const tabBtns        = document.querySelectorAll('.tab-btn');

    // 微調整スライダー
    const collapseBtn    = document.getElementById('collapse-btn');
    const adjustBody     = document.getElementById('adjust-body');
    const slSaturation   = document.getElementById('sl-saturation');

    // ダウンロード / リセット
    const downloadBtn    = document.getElementById('download-btn');
    const resetBtn       = document.getElementById('reset-btn');
    const resetSlidersBtn = document.getElementById('reset-sliders-btn');

    // スライダー一覧（id → key の対応）
    const SLIDER_KEYS = [
        'exposure', 'contrast', 'saturation', 'temperature', 'tint',
        'highlights', 'shadows', 'grain', 'vignette', 'strength',
    ];

    // --- 状態変数 ---
    let originalImage   = null;  // HTMLImageElement（元画像）
    let originalData    = null;  // ImageData（元画像ピクセル）
    let filteredData    = null;  // ImageData（フィルター済みピクセル）
    let selectedPreset  = PRESETS[0];
    let currentCategory = 'color-negative';
    let compareMode     = 'slide'; // 'slide' | 'toggle'
    let sliderRatio     = 0.5;    // スライドモードの分割位置（0〜1）
    let isDragging      = false;
    let renderRequested = false;

    /** 現在のスライダー値をオブジェクトとして取得 */
    function getAdjusts() {
        const out = {};
        SLIDER_KEYS.forEach(key => {
            out[key] = parseInt(document.getElementById(`sl-${key}`).value, 10);
        });
        return out;
    }

    /** スライダーの表示値を更新 */
    function updateSliderLabel(key) {
        const val = document.getElementById(`sl-${key}`).value;
        document.getElementById(`val-${key}`).textContent = val;
    }

    /** 全スライダーを初期値（プリセット既定値）にリセット */
    function resetSliders(preset) {
        document.getElementById('sl-exposure').value   = 0;
        document.getElementById('sl-contrast').value   = 0;
        document.getElementById('sl-saturation').value = 0;
        document.getElementById('sl-temperature').value = 0;
        document.getElementById('sl-tint').value       = 0;
        document.getElementById('sl-highlights').value = 0;
        document.getElementById('sl-shadows').value    = 0;
        document.getElementById('sl-grain').value      = preset ? preset.grain : 0;
        document.getElementById('sl-vignette').value   = preset ? Math.round(preset.vignette * 100) : 0;
        document.getElementById('sl-strength').value   = 100;
        SLIDER_KEYS.forEach(updateSliderLabel);
    }

    // ---- トースト ----
    let toastTimer = null;
    function showToast(msg, isError = false) {
        toast.textContent = msg;
        toast.className = 'toast show' + (isError ? ' error' : '');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2500);
    }

    // ---- スピナー ----
    function showSpinner() { spinner.hidden = false; }
    function hideSpinner() { spinner.hidden = true; }

    // ============================================================
    // 6. 画像読み込み
    // ============================================================

    /** File オブジェクトを受け取って画像を読み込む */
    function loadImageFile(file) {
        if (!file || !file.type.startsWith('image/')) {
            showToast('対応していないファイル形式です（JPG・PNG・WebPのみ）', true);
            return;
        }
        showSpinner();
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                originalImage = img;
                // 元画像データをオフスクリーンCanvasから抽出（長辺2000px制限）
                const maxSide = 2000;
                let w = img.naturalWidth, h = img.naturalHeight;
                if (Math.max(w, h) > maxSide) {
                    const scale = maxSide / Math.max(w, h);
                    w = Math.round(w * scale);
                    h = Math.round(h * scale);
                }
                const oc = document.createElement('canvas');
                oc.width = w; oc.height = h;
                const octx = oc.getContext('2d');
                octx.drawImage(img, 0, 0, w, h);
                originalData = octx.getImageData(0, 0, w, h);

                // UI を表示
                uploadSection.hidden = true;
                previewSection.hidden = false;
                filterSection.hidden  = false;
                adjustSection.hidden  = false;
                actionSection.hidden  = false;

                // プリセットのデフォルト値でスライダーをリセット
                resetSliders(selectedPreset);

                // プリセットサムネイルを生成
                buildPresetGrid(img, currentCategory);

                // フィルター適用
                requestRender();
                hideSpinner();
            };
            img.onerror = () => {
                hideSpinner();
                showToast('画像の読み込みに失敗しました', true);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    // ============================================================
    // 7. プリセットグリッド構築
    // ============================================================

    function buildPresetGrid(img, category) {
        presetGrid.innerHTML = '';
        const filtered = PRESETS.filter(p => p.category === category);
        filtered.forEach(preset => {
            const card = document.createElement('div');
            card.className = 'preset-card' + (preset.id === selectedPreset.id ? ' selected' : '');
            card.setAttribute('role', 'radio');
            card.setAttribute('aria-checked', preset.id === selectedPreset.id ? 'true' : 'false');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', preset.label);

            // サムネイルCanvas
            const thumbCanvas = createThumbCanvas(img, preset);
            thumbCanvas.className = 'preset-thumb-canvas';
            thumbCanvas.setAttribute('aria-hidden', 'true');
            card.appendChild(thumbCanvas);

            // ラベル
            const nameSpan = document.createElement('span');
            nameSpan.className = 'preset-name';
            nameSpan.textContent = preset.label;
            card.appendChild(nameSpan);

            // クリック / キーボード
            const selectPreset = () => {
                selectedPreset = preset;
                // モノクロ時は彩度スライダー無効化
                slSaturation.disabled = !!preset.mono;
                // 粒子感・ビネットをプリセット値にリセット
                document.getElementById('sl-grain').value   = preset.grain;
                document.getElementById('sl-vignette').value = Math.round(preset.vignette * 100);
                updateSliderLabel('grain');
                updateSliderLabel('vignette');
                // 選択状態を更新
                presetGrid.querySelectorAll('.preset-card').forEach(c => {
                    c.classList.remove('selected');
                    c.setAttribute('aria-checked', 'false');
                });
                card.classList.add('selected');
                card.setAttribute('aria-checked', 'true');
                requestRender();
            };
            card.addEventListener('click', selectPreset);
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPreset(); }
            });

            presetGrid.appendChild(card);
        });
    }

    // ============================================================
    // 8. レンダリング（フィルター適用 + Canvas描画）
    // ============================================================

    /** フィルター適用を要求（RAF でまとめて実行） */
    function requestRender() {
        if (renderRequested) return;
        renderRequested = true;
        requestAnimationFrame(render);
    }

    function render() {
        renderRequested = false;
        if (!originalData) return;

        const adjusts = getAdjusts();
        filteredData = applyFilter(originalData, selectedPreset, adjusts);

        if (compareMode === 'slide') {
            drawSlideComparison();
        } else {
            drawToggleCanvas(false);
        }
    }

    /**
     * スライド比較モード描画
     * 左半分に元画像、右半分にフィルター済み画像を表示
     */
    function drawSlideComparison() {
        const w = originalData.width, h = originalData.height;
        previewCanvas.width  = w;
        previewCanvas.height = h;

        // 元画像を描く
        const tempOrig = document.createElement('canvas');
        tempOrig.width = w; tempOrig.height = h;
        tempOrig.getContext('2d').putImageData(originalData, 0, 0);

        // フィルター済みを描く
        const tempFilt = document.createElement('canvas');
        tempFilt.width = w; tempFilt.height = h;
        tempFilt.getContext('2d').putImageData(filteredData, 0, 0);

        const splitX = Math.round(w * sliderRatio);

        // 左: 元画像
        previewCtx.drawImage(tempOrig, 0, 0);
        // 右: フィルター済み（clip）
        previewCtx.save();
        previewCtx.beginPath();
        previewCtx.rect(splitX, 0, w - splitX, h);
        previewCtx.clip();
        previewCtx.drawImage(tempFilt, 0, 0);
        previewCtx.restore();

        // 仕切り線（細い白線）
        previewCtx.save();
        previewCtx.strokeStyle = 'rgba(255,255,255,0.9)';
        previewCtx.lineWidth = 2;
        previewCtx.beginPath();
        previewCtx.moveTo(splitX, 0);
        previewCtx.lineTo(splitX, h);
        previewCtx.stroke();
        previewCtx.restore();

        // スライダーハンドルの位置を更新（transform を明示的にセットしてズレを防ぐ）
        sliderHandle.style.left = (sliderRatio * 100) + '%';
        sliderHandle.style.transform = 'translateX(-50%)';
        sliderHandle.setAttribute('aria-valuenow', Math.round(sliderRatio * 100));
    }

    /** トグルモード描画 */
    function drawToggleCanvas(showOrig) {
        const w = originalData.width, h = originalData.height;
        toggleCanvas.width  = w;
        toggleCanvas.height = h;
        toggleCtx.putImageData(showOrig ? originalData : filteredData, 0, 0);
    }

    // ============================================================
    // 9. スライドドラッグ操作
    // ============================================================

    function onSlideStart(e) {
        isDragging = true;
        e.preventDefault();
    }

    function onSlideMove(e) {
        if (!isDragging) return;
        const rect = slideWrap.getBoundingClientRect();
        let clientX = e.touches ? e.touches[0].clientX : e.clientX;
        sliderRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        drawSlideComparison();
    }

    function onSlideEnd() { isDragging = false; }

    // スライドCanvasラッパーへのイベント（ハンドルだけでなくCanvas全体でドラッグ可能）
    slideWrap.addEventListener('mousedown',  onSlideStart);
    window.addEventListener('mousemove',     onSlideMove);
    window.addEventListener('mouseup',       onSlideEnd);
    slideWrap.addEventListener('touchstart', onSlideStart, { passive: false });
    window.addEventListener('touchmove',     onSlideMove,  { passive: false });
    window.addEventListener('touchend',      onSlideEnd);

    // ============================================================
    // 10. 比較モード切替
    // ============================================================

    btnSlide.addEventListener('click', () => {
        compareMode = 'slide';
        btnSlide.classList.add('active'); btnSlide.setAttribute('aria-pressed', 'true');
        btnToggle.classList.remove('active'); btnToggle.setAttribute('aria-pressed', 'false');
        slideWrap.hidden  = false;
        toggleWrap.hidden = true;
        btnShowOrig.hidden = true;
        requestRender();
    });

    btnToggle.addEventListener('click', () => {
        compareMode = 'toggle';
        btnToggle.classList.add('active'); btnToggle.setAttribute('aria-pressed', 'true');
        btnSlide.classList.remove('active'); btnSlide.setAttribute('aria-pressed', 'false');
        slideWrap.hidden  = true;
        toggleWrap.hidden = false;
        btnShowOrig.hidden = false;
        requestRender();
    });

    // 長押しで元画像を表示
    btnShowOrig.addEventListener('mousedown',  () => drawToggleCanvas(true));
    btnShowOrig.addEventListener('mouseup',    () => drawToggleCanvas(false));
    btnShowOrig.addEventListener('mouseleave', () => drawToggleCanvas(false));
    btnShowOrig.addEventListener('touchstart', () => drawToggleCanvas(true),  { passive: true });
    btnShowOrig.addEventListener('touchend',   () => drawToggleCanvas(false));

    // ============================================================
    // 11. スライダーイベント
    // ============================================================

    // 大きい画像でもUIが固まらないよう 80ms の debounce でフィルター処理を間引く
    let sliderDebounceTimer = null;
    function debouncedRender() {
        if (sliderDebounceTimer) clearTimeout(sliderDebounceTimer);
        sliderDebounceTimer = setTimeout(() => {
            sliderDebounceTimer = null;
            requestRender();
        }, 80);
    }

    SLIDER_KEYS.forEach(key => {
        const el = document.getElementById(`sl-${key}`);
        el.addEventListener('input', () => {
            updateSliderLabel(key);
            debouncedRender();
        });
    });

    // 折りたたみ
    collapseBtn.addEventListener('click', () => {
        const collapsed = adjustBody.classList.toggle('collapsed');
        collapseBtn.textContent = collapsed ? '展開する ▼' : '折りたたむ ▲';
        collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    });

    // スライダーリセット
    resetSlidersBtn.addEventListener('click', () => {
        resetSliders(selectedPreset);
        requestRender();
    });

    // ============================================================
    // 12. カテゴリータブ
    // ============================================================

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => { b.classList.remove('active'); });
            btn.classList.add('active');
            currentCategory = btn.dataset.category;
            // カテゴリーが変わったら最初のプリセットを選択
            const firstInCategory = PRESETS.find(p => p.category === currentCategory);
            if (firstInCategory) {
                selectedPreset = firstInCategory;
                slSaturation.disabled = !!firstInCategory.mono;
                resetSliders(firstInCategory);
            }
            buildPresetGrid(originalImage, currentCategory);
            requestRender();
        });
    });

    // ============================================================
    // 13. アップロードイベント
    // ============================================================

    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) loadImageFile(e.target.files[0]);
        fileInput.value = ''; // 同じファイルを再選択できるようリセット
    });

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('drag-over');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('drag-over');
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) loadImageFile(file);
    });

    // 「別の画像を選ぶ」ボタン
    btnChangeImage.addEventListener('click', () => {
        // UIをリセットして最初の状態に戻す
        originalImage = null; originalData = null; filteredData = null;
        previewSection.hidden = true;
        filterSection.hidden  = true;
        adjustSection.hidden  = true;
        actionSection.hidden  = true;
        uploadSection.hidden  = false;
        fileInput.value = '';
    });

    // ============================================================
    // 14. ダウンロード
    // ============================================================

    downloadBtn.addEventListener('click', () => {
        if (!filteredData) return;

        // 出力用Canvasに filteredData を描画してJPEGでダウンロード
        const oc = document.createElement('canvas');
        oc.width  = filteredData.width;
        oc.height = filteredData.height;
        oc.getContext('2d').putImageData(filteredData, 0, 0);

        // ファイル名: filmfilter_プリセットID_日付時刻.jpg
        const now  = new Date();
        const pad  = n => String(n).padStart(2, '0');
        const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
        const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const filename = `filmfilter_${selectedPreset.id}_${date}_${time}.jpg`;

        const link = document.createElement('a');
        link.download = filename;
        link.href = oc.toDataURL('image/jpeg', 0.92);
        link.click();
        showToast('保存しました');
    });

    // ============================================================
    // 15. リセット
    // ============================================================

    resetBtn.addEventListener('click', () => {
        // 画像未アップロード時はnullエラーを防ぐためガード
        if (!originalImage) return;
        selectedPreset  = PRESETS[0];
        currentCategory = 'color-negative';
        tabBtns.forEach(b => {
            const isFirst = b.dataset.category === 'color-negative';
            b.classList.toggle('active', isFirst);
        });
        slSaturation.disabled = false;
        resetSliders(selectedPreset);
        buildPresetGrid(originalImage, currentCategory);
        requestRender();
    });

});
