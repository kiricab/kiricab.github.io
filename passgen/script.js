document.addEventListener('DOMContentLoaded', () => {
    // DOM要素の取得
    const generateBtn = document.getElementById('generate-btn');
    const passwordGrid = document.getElementById('password-grid');
    const lengthBtns = document.querySelectorAll('.length-btn');
    const customLengthInput = document.getElementById('custom-length');
    const passwordCountInput = document.getElementById('password-count');
    const includeUppercase = document.getElementById('include-uppercase');
    const includeLowercase = document.getElementById('include-lowercase');
    const includeNumbers = document.getElementById('include-numbers');
    const includeSymbols = document.getElementById('include-symbols');
    const randomSeedInput = document.getElementById('random-seed');
    const symbolsDetailGrid = document.getElementById('symbols-detail-grid');
    const copyLinkBtn = document.getElementById('copy-link-btn');

    const CHARSETS = {
        UPPERCASE: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        LOWERCASE: 'abcdefghijklmnopqrstuvwxyz',
        NUMBERS: '0123456789'
    };
    const ALL_SYMBOLS = "!@#$%^&*()[]{}<>_+-=,.|?;:'`~";
    const DEFAULT_SYMBOLS = "!@#$%^&*()[]{}<>_+-=,.|?;:'`~";
    let currentLength = 8;

    function createSymbolCheckboxes() {
        symbolsDetailGrid.innerHTML = '';
        for (const symbol of ALL_SYMBOLS) {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'symbol-checkbox';
            checkbox.value = symbol;
            if (DEFAULT_SYMBOLS.includes(symbol)) {
                checkbox.checked = true;
            }
            const span = document.createElement('span');
            span.textContent = symbol;
            label.appendChild(checkbox);
            label.appendChild(span);
            symbolsDetailGrid.appendChild(label);
        }
    }

    lengthBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            lengthBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentLength = parseInt(btn.dataset.length, 10);
            customLengthInput.value = '';
        });
    });

    customLengthInput.addEventListener('input', () => {
        lengthBtns.forEach(b => b.classList.remove('active'));
        const customValue = parseInt(customLengthInput.value, 10);
        if (customValue >= 4 && customValue <= 64) {
            currentLength = customValue;
        }
    });
    
    includeSymbols.addEventListener('change', (e) => {
        symbolsDetailGrid.classList.toggle('hidden', !e.target.checked);
    });

    generateBtn.addEventListener('click', () => {
        updateQueryFromSettings();
        generatePasswords();
    });
    
    function applySettingsFromQuery() {
        const params = new URLSearchParams(window.location.search);
        if (!params.has('c')) return;
        try {
            const base64String = params.get('c').replace(/ /g, '+');
            const jsonString = atob(base64String);
            const settings = JSON.parse(jsonString);
            currentLength = settings.length || 8;
            updateLengthUI(currentLength);
            passwordCountInput.value = settings.count || 20;
            randomSeedInput.value = settings.seed || '';
            includeUppercase.checked = settings.upper ?? true;
            includeLowercase.checked = settings.lower ?? true;
            includeNumbers.checked = settings.nums ?? true;
            includeSymbols.checked = typeof settings.syms === 'string';
            if (includeSymbols.checked) {
                const symbolCheckboxes = document.querySelectorAll('.symbol-checkbox');
                symbolCheckboxes.forEach(cb => {
                    cb.checked = settings.syms.includes(cb.value);
                });
            }
        } catch (e) {
            console.error("URLパラメータの解析に失敗しました:", e);
        }
    }

    function updateQueryFromSettings() {
        const seed = randomSeedInput.value;
        if (!seed) {
            history.pushState({}, '', window.location.pathname);
            copyLinkBtn.disabled = true;
            copyLinkBtn.title = window.translations.passgen_seed_disabled_tooltip || "ランダムシードを入力すると有効になります";
            return;
        }
        const settings = {
            length: currentLength,
            count: parseInt(passwordCountInput.value, 10),
            upper: includeUppercase.checked,
            lower: includeLowercase.checked,
            nums: includeNumbers.checked,
            syms: includeSymbols.checked 
                ? Array.from(document.querySelectorAll('.symbol-checkbox:checked')).map(cb => cb.value).join('')
                : false,
            seed: seed,
        };
        const jsonString = JSON.stringify(settings);
        const base64String = btoa(jsonString);
        history.pushState({}, '', `${window.location.pathname}?c=${base64String}`);
        copyLinkBtn.disabled = false;
        copyLinkBtn.title = window.translations.passgen_copy_link_tooltip || "設定を反映したリンクをコピー";
    }

    function generatePasswords() {
        passwordGrid.innerHTML = '';
        const length = currentLength;
        const count = Math.min(1000, Math.max(1, parseInt(passwordCountInput.value, 10) || 20));
        updateGridColumns(length);
        const selectedCharsets = [];
        if (includeUppercase.checked) selectedCharsets.push(CHARSETS.UPPERCASE);
        if (includeLowercase.checked) selectedCharsets.push(CHARSETS.LOWERCASE);
        if (includeNumbers.checked) selectedCharsets.push(CHARSETS.NUMBERS);
        if (includeSymbols.checked) {
            const customSymbols = Array.from(document.querySelectorAll('.symbol-checkbox:checked')).map(cb => cb.value).join('');
            if (customSymbols.length === 0) { alert(window.translations.passgen_alert_select_symbol || '使用する記号を少なくとも1つ選択してください。'); return; }
            selectedCharsets.push(customSymbols);
        }
        if (selectedCharsets.length === 0) { alert(window.translations.passgen_alert_select_charset || '少なくとも1つの文字種を選択してください。'); return; }
        if (length < selectedCharsets.length) { alert(window.translations.passgen_alert_length_mismatch.replace('{count}', selectedCharsets.length) || `パスワードの長さは、選択した文字種の数 (${selectedCharsets.length}) 以上に設定してください。`); return; }
        const charPool = selectedCharsets.join('');
        const seed = randomSeedInput.value;
        const rng = seed ? new LCG(seed) : null;
        for (let i = 0; i < count; i++) {
            let passwordChars = [];
            selectedCharsets.forEach(charset => {
                const randomIndex = rng ? Math.floor(rng.next() * charset.length) : Math.floor(getCryptoRandom() * charset.length);
                passwordChars.push(charset[randomIndex]);
            });
            const remainingLength = length - passwordChars.length;
            for (let j = 0; j < remainingLength; j++) {
                const randomIndex = rng ? Math.floor(rng.next() * charPool.length) : Math.floor(getCryptoRandom() * charPool.length);
                passwordChars.push(charPool[randomIndex]);
            }
            shuffleArray(passwordChars, rng);
            const password = passwordChars.join('');
            createPasswordItem(password);
        }
    }

    copyLinkBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(window.location.href).then(() => {
            const originalText = copyLinkBtn.innerHTML;
            copyLinkBtn.textContent = window.translations.passgen_copy_complete || 'コピー完了!';
            setTimeout(() => { copyLinkBtn.innerHTML = originalText; }, 2000);
        }).catch(err => console.error(window.translations.passgen_copy_link_error || "リンクのコピーに失敗しました", err));
    });

    randomSeedInput.addEventListener('input', updateQueryFromSettings);
    
    function updateGridColumns(length) {
        passwordGrid.classList.remove('cols-1', 'cols-2', 'cols-4', 'cols-5');
        if (length > 32) passwordGrid.classList.add('cols-1');
        else if (length > 16) passwordGrid.classList.add('cols-2');
        else if (length > 10) passwordGrid.classList.add('cols-4');
        else passwordGrid.classList.add('cols-5');
    }

    function getCryptoRandom() {
        const array = new Uint32Array(1);
        window.crypto.getRandomValues(array);
        return array[0] / 4294967296;
    }
    
    function shuffleArray(array, rng) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = rng ? Math.floor(rng.next() * (i + 1)) : Math.floor(getCryptoRandom() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    function createPasswordItem(password) {
        const item = document.createElement('div');
        item.className = 'password-item';
        item.textContent = password;
        const tooltip = document.createElement('span');
        tooltip.className = 'tooltip';
        tooltip.textContent = window.translations.passgen_copied_tooltip || 'コピーしました！';
        item.appendChild(tooltip);
        item.addEventListener('click', () => {
            navigator.clipboard.writeText(password).then(() => {
                item.classList.add('copied');
                setTimeout(() => item.classList.remove('copied'), 1500);
            }).catch(err => console.error(window.translations.passgen_copy_error || 'クリップボードへのコピーに失敗しました: ', err));
        });
        passwordGrid.appendChild(item);
    }
    
    class LCG {
        constructor(seed) {
            this.a = 1664525; this.c = 1013904223; this.m = Math.pow(2, 32);
            if (typeof seed !== 'string' || seed.length === 0) { this.seed = Math.floor(getCryptoRandom() * this.m); return; }
            let hash = 5381;
            for (let i = 0; i < seed.length; i++) { hash = (((hash << 5) + hash) + seed.charCodeAt(i))|0; }
            this.seed = hash >>> 0;
        }
        next() { this.seed = (this.a * this.seed + this.c) % this.m; return this.seed / this.m; }
    }

    function updateLengthUI(length) {
        let isPreset = false;
        lengthBtns.forEach(btn => {
            if (parseInt(btn.dataset.length, 10) === length) {
                btn.classList.add('active');
                isPreset = true;
            } else {
                btn.classList.remove('active');
            }
        });
        customLengthInput.value = isPreset ? '' : length;
    }

    // --- 初期化処理 ---
    createSymbolCheckboxes();
    applySettingsFromQuery();
    includeSymbols.dispatchEvent(new Event('change'));
    updateQueryFromSettings();
    generatePasswords();
});
