document.addEventListener('DOMContentLoaded', () => {
    // DOM要素の取得
    const text1 = document.getElementById('text1');
    const text2 = document.getElementById('text2');
    const diffOutput1 = document.getElementById('diffOutput1');
    const diffOutput2 = document.getElementById('diffOutput2');
    const similarityOutput = document.getElementById('similarityOutput');

    /**
     * 差分比較と類似度計算を実行し、結果を表示する関数
     */
    const performDiff = () => {
        const val1 = text1.value;
        const val2 = text2.value;
        const lines1 = val1.split('\n');
        const lines2 = val2.split('\n');

        // 行単位の差分を生成
        const diffResult = generateDiff(lines1, lines2);
        // 差分結果をレンダリング
        renderDiff(diffResult, diffOutput1, diffOutput2);

        // 類似度を計算して表示
        if (val1.length === 0 && val2.length === 0) {
            similarityOutput.textContent = `類似度: 0.00%`;
        } else {
            const distance = levenshteinDistance(val1, val2);
            const maxLength = Math.max(val1.length, val2.length);
            const similarity = ((maxLength - distance) / maxLength) * 100;
            similarityOutput.textContent = `類似度: ${similarity.toFixed(2)}%`;
        }
    };

    // テキストエリアの入力イベントを監視し、変更があれば自動で差分比較を実行
    text1.addEventListener('input', performDiff);
    text2.addEventListener('input', performDiff);

    // 初期表示時に差分比較と類似度計算を実行
    performDiff();

    /**
     * 2つの文章の行単位の差分を生成する（LCSアルゴリズムに基づく）
     * @param {string[]} lines1 - 最初の文章の行配列
     * @param {string[]} lines2 - 比較する文章の行配列
     * @returns {Array<Object>} 差分結果の配列
     */
    function generateDiff(lines1, lines2) {
        const diff = [];
        // 動的計画法テーブルの初期化
        const dp = Array(lines1.length + 1).fill(0).map(() => Array(lines2.length + 1).fill(0));

        // LCSの長さを計算
        for (let i = 1; i <= lines1.length; i++) {
            for (let j = 1; j <= lines2.length; j++) {
                if (lines1[i - 1] === lines2[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        let i = lines1.length;
        let j = lines2.length;

        // DPテーブルを逆順に辿って差分を構築
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && lines1[i - 1] === lines2[j - 1]) {
                // 行が一致する場合
                diff.unshift({ type: 'unchanged', value1: lines1[i - 1], value2: lines2[j - 1] });
                i--;
                j--;
            } else if (i > 0 && j > 0 && dp[i - 1][j - 1] === dp[i][j]) {
                // 行は一致しないが、LCSの長さが変わらない場合（変更された行）
                diff.unshift({ type: 'changed', value1: lines1[i - 1], value2: lines2[j - 1] });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                // lines2にのみ存在する行（追加された行）
                diff.unshift({ type: 'added', value1: '', value2: lines2[j - 1] });
                j--;
            } else if (i > 0 && (j === 0 || dp[i - 1][j] > dp[i][j - 1])) {
                // lines1にのみ存在する行（削除された行）
                diff.unshift({ type: 'removed', value1: lines1[i - 1], value2: '' });
                i--;
            }
        }
        return diff;
    }

    /**
     * 2つの文字列間のレーベンシュタイン距離（編集距離）を計算する
     * @param {string} s1 - 最初の文字列
     * @param {string} s2 - 比較する文字列
     * @returns {number} レーベンシュタイン距離
     */
    function levenshteinDistance(s1, s2) {
        s1 = s1.toLowerCase();
        s2 = s2.toLowerCase();

        const costs = [];
        for (let i = 0; i <= s1.length; i++) {
            let lastValue = i;
            for (let j = 0; j <= s2.length; j++) {
                if (i === 0) {
                    costs[j] = j;
                } else if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
            if (i > 0) {
                costs[s2.length] = lastValue;
            }
        }
        return costs[s2.length];
    }

    /**
     * 2つの文字列の文字単位の差分を生成する
     * @param {string} text1 - 最初の文字列
     * @param {string} text2 - 比較する文字列
     * @returns {{diff1: Array<Object>, diff2: Array<Object>}} 文字単位の差分結果（左右それぞれの配列）
     */
    function generateCharDiff(text1, text2) {
        const m = text1.length;
        const n = text2.length;
        const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

        // LCSの長さを計算
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (text1[i - 1] === text2[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        const diff1 = []; // text1 (removed)
        const diff2 = []; // text2 (added)

        let i = m;
        let j = n;

        // DPテーブルを逆順に辿って文字単位の差分を構築
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && text1[i - 1] === text2[j - 1]) {
                // 文字が一致する場合
                diff1.unshift({ type: 'unchanged', value: text1[i - 1] });
                diff2.unshift({ type: 'unchanged', value: text2[j - 1] });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                // text2にのみ存在する文字（追加された文字）
                diff1.unshift({ type: 'empty', value: '' }); // text1側には何もない
                diff2.unshift({ type: 'added', value: text2[j - 1] });
                j--;
            } else if (i > 0 && (j === 0 || dp[i - 1][j] > dp[i][j - 1])) {
                // text1にのみ存在する文字（削除された文字）
                diff1.unshift({ type: 'removed', value: text1[i - 1] });
                diff2.unshift({ type: 'empty', value: '' }); // text2側には何もない
                i--;
            }
        }
        return { diff1, diff2 };
    }

    /**
     * 差分結果をHTML要素としてレンダリングする
     * @param {Array<Object>} diffResult - generateDiffから返された行単位の差分結果
     * @param {HTMLElement} outputElement1 - 最初の文章の差分を表示する要素
     * @param {HTMLElement} outputElement2 - 比較する文章の差分を表示する要素
     */
    function renderDiff(diffResult, outputElement1, outputElement2) {
        outputElement1.innerHTML = '';
        outputElement2.innerHTML = '';

        diffResult.forEach(lineDiff => {
            const lineContainer1 = document.createElement('div');
            const lineContainer2 = document.createElement('div');
            lineContainer1.classList.add('diff-line');
            lineContainer2.classList.add('diff-line');

            if (lineDiff.type === 'unchanged') {
                // 変更がない行
                lineContainer1.textContent = lineDiff.value1;
                lineContainer2.textContent = lineDiff.value2;
                lineContainer1.classList.add('unchanged-line');
                lineContainer2.classList.add('unchanged-line');
            } else if (lineDiff.type === 'added') {
                // 追加された行
                lineContainer1.innerHTML = '&nbsp;'; // 左側は空行
                lineContainer1.classList.add('empty-line');

                const { diff1: charDiff1, diff2: charDiff2 } = generateCharDiff('', lineDiff.value2);
                charDiff2.forEach(char => {
                    const span = document.createElement('span');
                    span.textContent = char.value;
                    span.classList.add(char.type === 'added' ? 'added-char' : 'unchanged-char');
                    lineContainer2.appendChild(span);
                });
                lineContainer2.classList.add('added-line');
            } else if (lineDiff.type === 'removed') {
                // 削除された行
                const { diff1: charDiff1, diff2: charDiff2 } = generateCharDiff(lineDiff.value1, '');
                charDiff1.forEach(char => {
                    const span = document.createElement('span');
                    span.textContent = char.value;
                    span.classList.add(char.type === 'removed' ? 'removed-char' : 'unchanged-char');
                    lineContainer1.appendChild(span);
                });
                lineContainer1.classList.add('removed-line');

                lineContainer2.innerHTML = '&nbsp;'; // 右側は空行
                lineContainer2.classList.add('empty-line');
            } else if (lineDiff.type === 'changed') {
                // 変更された行
                // 左側 (元の行) の文字単位の差分
                const { diff1: charDiff1, diff2: charDiff2 } = generateCharDiff(lineDiff.value1, lineDiff.value2);
                charDiff1.forEach(char => {
                    const span = document.createElement('span');
                    span.textContent = char.value;
                    span.classList.add(char.type === 'removed' ? 'removed-char' : 'unchanged-char');
                    lineContainer1.appendChild(span);
                });
                lineContainer1.classList.add('removed-line'); // 変更された行の背景色

                // 右側 (新しい行) の文字単位の差分
                charDiff2.forEach(char => {
                    const span = document.createElement('span');
                    span.textContent = char.value;
                    span.classList.add(char.type === 'added' ? 'added-char' : 'unchanged-char');
                    lineContainer2.appendChild(span);
                });
                lineContainer2.classList.add('added-line'); // 変更された行の背景色
            }
            outputElement1.appendChild(lineContainer1);
            outputElement2.appendChild(lineContainer2);
        });
    }
});
