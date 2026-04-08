// QRコード生成ツール - script.js
// qr-code-styling ライブラリ（MIT License）を使用してQRコードを生成・カスタマイズする

// === 状態管理 ===
// アプリケーション全体の設定を1つのオブジェクトで管理する
const DEFAULT_STATE = {
  type: 'url',
  data: {},
  ecLevel: 'M',
  dotColor: '#000000',
  bgColor: '#ffffff',
  dotStyle: 'square',
  cornerDotStyle: 'square',
  cornerSquareStyle: 'square',
  logoDataUrl: null,
  logoSize: 30,
};

let state = structuredClone(DEFAULT_STATE);
let qrInstance = null;
// デバウンス用タイマーID
let renderTimer = null;

// === QRデータ文字列生成 ===
// タイプに応じたQRコード用文字列を組み立てる
function buildQrString(s) {
  switch (s.type) {
    case 'url':
      return s.data.url || '';

    case 'text':
      return s.data.text || '';

    case 'wifi': {
      // Wi-Fi QRコード形式: WIFI:T:WPA;S:SSID;P:PASSWORD;;
      const { ssid = '', password = '', encryption = 'WPA', hidden = false } = s.data;
      const h = hidden ? 'H:true;' : '';
      const p = encryption === 'nopass' ? '' : escapeWifi(password);
      return `WIFI:T:${encryption};S:${escapeWifi(ssid)};P:${p};${h};`;
    }

    case 'vcard': {
      // vCard 3.0 形式で連絡先情報を組み立てる
      const d = s.data;
      const fn = [d.lastname, d.firstname].filter(Boolean).join(' ');
      const lines = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `N:${d.lastname || ''};${d.firstname || ''};;;`,
        fn ? `FN:${fn}` : 'FN:',
        d.org     ? `ORG:${d.org}`           : null,
        d.title   ? `TITLE:${d.title}`       : null,
        d.tel     ? `TEL:${d.tel}`           : null,
        d.email   ? `EMAIL:${d.email}`       : null,
        d.vcardUrl ? `URL:${d.vcardUrl}`      : null,
        d.address ? `ADR:;;${d.address};;;;` : null,
        d.note    ? `NOTE:${d.note}`         : null,
        'END:VCARD',
      ];
      return lines.filter(Boolean).join('\n');
    }

    case 'email': {
      // mailto: URI スキーム
      const { to = '', subject = '', body = '' } = s.data;
      const params = [];
      if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
      if (body)    params.push(`body=${encodeURIComponent(body)}`);
      return `mailto:${to}${params.length ? '?' + params.join('&') : ''}`;
    }

    case 'sms': {
      // sms: URI スキーム
      const { to = '', body: smsBody = '' } = s.data;
      return `sms:${to}${smsBody ? '?body=' + encodeURIComponent(smsBody) : ''}`;
    }

    default:
      return '';
  }
}

// Wi-Fi文字列のエスケープ: 特殊文字をバックスラッシュでエスケープ
function escapeWifi(str) {
  return (str || '').replace(/[;,:\\"]/g, c => '\\' + c);
}

// === オプションオブジェクト生成（DRY） ===
// QRCodeStyling に渡すオプションを状態から生成する
function buildOptions(size = 300) {
  const opts = {
    width: size,
    height: size,
    type: 'canvas',
    data: buildQrString(state) || ' ', // 空文字列だとエラーになるためスペースを入れる
    dotsOptions: {
      color: state.dotColor,
      type: state.dotStyle,
    },
    backgroundOptions: {
      color: state.bgColor,
    },
    cornersSquareOptions: {
      type: state.cornerSquareStyle,
    },
    cornersDotOptions: {
      type: state.cornerDotStyle,
    },
    qrOptions: {
      errorCorrectionLevel: state.ecLevel,
    },
  };

  // ロゴが設定されている場合のみ imageOptions を追加する
  if (state.logoDataUrl) {
    opts.image = state.logoDataUrl;
    opts.imageOptions = {
      crossOrigin: 'anonymous',
      margin: 4,
      imageSize: state.logoSize / 100,
    };
  } else {
    opts.image = '';
    opts.imageOptions = { crossOrigin: 'anonymous', margin: 4 };
  }

  return opts;
}

// === QRコード初期化・描画 ===
// ページ初回ロード時にQRCodeStylingインスタンスを生成してDOMに追加する
function initQr() {
  qrInstance = new QRCodeStyling(buildOptions(300));
  qrInstance.append(document.getElementById('qr-canvas-wrap'));
}

// デバウンス処理: 連続入力時に描画を150ms遅延させてパフォーマンスを改善する
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderQr, 150);
}

// QRコードを更新しデータ量表示も更新する
function renderQr() {
  const qrString = buildQrString(state);
  const charCount = qrString.length;

  // データ量カウントと警告表示
  document.getElementById('qr-char-count').textContent = charCount;
  // QRコードv40・ECレベルL時の最大容量2953文字を基準に警告
  document.getElementById('qr-warning').style.display = charCount > 2953 ? 'inline' : 'none';

  qrInstance.update(buildOptions(300));
}

// === タブ切り替え ===
// タイプタブをクリックした時にアクティブなパネルを切り替える
function switchType(type) {
  state.type = type;

  // タブのアクティブ状態を更新
  document.querySelectorAll('.type-tab').forEach(tab => {
    const isActive = tab.dataset.type === type;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // パネルの表示・非表示を切り替える
  document.querySelectorAll('.type-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${type}`);
  });

  scheduleRender();
}

// === 入力バインド ===
// 各入力フィールドの変更を state.data に反映させる汎用関数
function bindInput(id, key, event = 'input') {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener(event, () => {
    // チェックボックスは checked プロパティ、それ以外は value を使う
    state.data[key] = el.type === 'checkbox' ? el.checked : el.value;
    scheduleRender();
  });
}

// 全入力フィールドにイベントリスナーを設定する
function setupInputBindings() {
  // タブクリック
  document.querySelectorAll('.type-tab').forEach(tab =>
    tab.addEventListener('click', () => switchType(tab.dataset.type))
  );

  // URL タブ
  bindInput('url-input', 'url');

  // テキスト タブ
  bindInput('text-input', 'text');

  // Wi-Fi タブ
  bindInput('wifi-ssid', 'ssid');
  bindInput('wifi-password', 'password');
  bindInput('wifi-encryption', 'encryption', 'change');
  bindInput('wifi-hidden', 'hidden', 'change');

  // vCard タブ（フィールド名を一括バインド）
  ['lastname', 'firstname', 'org', 'title', 'tel', 'email', 'address', 'note'].forEach(k =>
    bindInput(`vcard-${k}`, k)
  );
  bindInput('vcard-url', 'vcardUrl');

  // メール タブ
  bindInput('email-to', 'to');
  bindInput('email-subject', 'subject');
  bindInput('email-body', 'body');

  // SMS タブ
  bindInput('sms-to', 'to');
  bindInput('sms-body', 'body');

  // エラー訂正レベル
  document.querySelectorAll('input[name="ec-level"]').forEach(radio =>
    radio.addEventListener('change', () => {
      state.ecLevel = radio.value;
      scheduleRender();
    })
  );

  // Wi-Fiパスワード表示切替ボタン
  document.getElementById('toggle-wifi-pass').addEventListener('click', () => {
    const pw = document.getElementById('wifi-password');
    pw.type = pw.type === 'password' ? 'text' : 'password';
  });
}

// === カラー同期 ===
// カラーピッカーとHEXテキスト入力を双方向に同期する
function bindColorSync(pickerId, hexId, stateKey) {
  const picker = document.getElementById(pickerId);
  const hex    = document.getElementById(hexId);

  // カラーピッカー → HEXテキストへ反映
  picker.addEventListener('input', () => {
    hex.value      = picker.value;
    state[stateKey] = picker.value;
    scheduleRender();
  });

  // HEXテキスト → カラーピッカーへ反映（有効な6桁HEXのみ）
  hex.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) {
      picker.value   = hex.value;
      state[stateKey] = hex.value;
      scheduleRender();
    }
  });
}

// === ドット形状 ===
// ドット形状ボタンのクリックイベントを設定する
function setupShapeOptions() {
  document.querySelectorAll('#dot-shape-options .shape-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      // 全ボタンのアクティブ状態をリセット
      document.querySelectorAll('#dot-shape-options .shape-opt').forEach(o => {
        o.classList.remove('active');
        o.setAttribute('aria-pressed', 'false');
      });
      opt.classList.add('active');
      opt.setAttribute('aria-pressed', 'true');
      state.dotStyle = opt.dataset.value;
      scheduleRender();
    });
  });

  document.getElementById('corner-dot-style').addEventListener('change', e => {
    state.cornerDotStyle = e.target.value;
    scheduleRender();
  });

  document.getElementById('corner-square-style').addEventListener('change', e => {
    state.cornerSquareStyle = e.target.value;
    scheduleRender();
  });
}

// === ロゴ埋め込み ===
// ロゴのアップロード・ドラッグ&ドロップ・削除・サイズ変更を設定する
function setupLogo() {
  const logoFile  = document.getElementById('logo-file');
  const uploadBtn = document.getElementById('logo-upload-btn');
  const dropZone  = document.getElementById('logo-drop-zone');
  const removeBtn = document.getElementById('logo-remove-btn');
  const sizeEl    = document.getElementById('logo-size');

  // ボタンクリックでファイル選択ダイアログを開く
  uploadBtn.addEventListener('click', () => logoFile.click());

  // ファイル選択時に読み込む
  logoFile.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) loadLogoFile(file);
  });

  // ドラッグ&ドロップ対応
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadLogoFile(file);
  });

  // ロゴ削除ボタン
  removeBtn.addEventListener('click', () => {
    state.logoDataUrl = null;
    logoFile.value = '';
    document.getElementById('logo-preview-wrap').style.display = 'none';
    document.getElementById('logo-size-group').style.display   = 'none';
    scheduleRender();
  });

  // ロゴサイズスライダー
  sizeEl.addEventListener('input', () => {
    state.logoSize = +sizeEl.value;
    document.getElementById('logo-size-val').textContent = state.logoSize;
    scheduleRender();
  });
}

// ファイルをDataURLに変換してstateに保存する
function loadLogoFile(file) {
  // ファイルサイズ制限: 2MB
  if (file.size > 2 * 1024 * 1024) {
    alert('ファイルサイズは2MB以下にしてください');
    return;
  }

  const reader = new FileReader();
  reader.onload = ev => {
    state.logoDataUrl = ev.target.result;
    document.getElementById('logo-preview-img').src          = ev.target.result;
    document.getElementById('logo-preview-wrap').style.display = 'flex';
    document.getElementById('logo-size-group').style.display   = 'block';
    scheduleRender();
  };
  reader.readAsDataURL(file);
}

// === エクスポート ===
// PNG・SVGダウンロードボタンのイベントを設定する
function setupExport() {
  document.getElementById('export-png-btn').addEventListener('click', () => {
    const size = +document.querySelector('input[name="export-size"]:checked').value;
    // エクスポート用に別インスタンスを生成してダウンロードする
    const exportInstance = new QRCodeStyling({ ...buildOptions(size), type: 'canvas' });
    exportInstance.download({ name: 'qrcode', extension: 'png' });
  });

  document.getElementById('export-svg-btn').addEventListener('click', () => {
    const size = +document.querySelector('input[name="export-size"]:checked').value;
    // SVGエクスポート時はtypeをsvgに変更する
    const exportInstance = new QRCodeStyling({ ...buildOptions(size), type: 'svg' });
    exportInstance.download({ name: 'qrcode', extension: 'svg' });
  });
}

// === URL共有 ===
// 現在の設定をURLパラメータにエンコードしてクリップボードにコピーする

// stateをURLSearchParamsにエンコードする
function encodeToUrl(s) {
  const params = new URLSearchParams();
  params.set('t',  s.type);
  params.set('ec', s.ecLevel);
  params.set('dc', s.dotColor.replace('#', ''));
  params.set('bc', s.bgColor.replace('#', ''));
  params.set('ds', s.dotStyle);
  params.set('cs', s.cornerSquareStyle);
  params.set('cd', s.cornerDotStyle);
  params.set('ls', s.logoSize);

  // データフィールドはプレフィックス "d_" を付けて格納する
  Object.entries(s.data).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '' && v !== false) {
      params.set(`d_${k}`, v);
    }
  });

  const url = new URL(window.location.href);
  url.search = params.toString();
  return url.toString();
}

// URLパラメータからstateを復元する
function decodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  // パラメータが存在しない場合はnullを返す
  if (!params.has('t')) return null;

  const s = structuredClone(DEFAULT_STATE);
  s.type              = params.get('t')  || 'url';
  s.ecLevel           = params.get('ec') || 'M';
  s.dotColor          = '#' + (params.get('dc') || '000000');
  s.bgColor           = '#' + (params.get('bc') || 'ffffff');
  s.dotStyle          = params.get('ds') || 'square';
  s.cornerSquareStyle = params.get('cs') || 'square';
  s.cornerDotStyle    = params.get('cd') || 'square';
  s.logoSize          = +params.get('ls') || 30;

  // d_ プレフィックスのパラメータをdataオブジェクトに復元する
  for (const [key, val] of params.entries()) {
    if (key.startsWith('d_')) s.data[key.slice(2)] = val;
  }

  return s;
}

function setupShare() {
  document.getElementById('share-url-btn').addEventListener('click', () => {
    const url = encodeToUrl(state);
    // Clipboard API が使える場合はコピー、フォールバックでpromptを表示
    navigator.clipboard.writeText(url)
      .then(() => {
        const msg = document.getElementById('share-copied-msg');
        msg.style.display = 'inline';
        setTimeout(() => { msg.style.display = 'none'; }, 2000);
      })
      .catch(() => prompt('URLをコピーしてください', url));
  });
}

// === UI → state 反映（URL共有復元時） ===
// URLから復元したstateをUIの各フォームフィールドに反映させる
function applyStateToUI(s) {
  // カラーピッカーとHEXテキストを同期
  document.getElementById('dot-color').value     = s.dotColor;
  document.getElementById('dot-color-hex').value = s.dotColor;
  document.getElementById('bg-color').value      = s.bgColor;
  document.getElementById('bg-color-hex').value  = s.bgColor;

  // エラー訂正レベルのラジオボタンを選択
  const ecEl = document.querySelector(`input[name="ec-level"][value="${s.ecLevel}"]`);
  if (ecEl) ecEl.checked = true;

  // ドット形状ボタンのアクティブ状態を更新
  document.querySelectorAll('#dot-shape-options .shape-opt').forEach(o => {
    const isActive = o.dataset.value === s.dotStyle;
    o.classList.toggle('active', isActive);
    o.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  // コーナー形状セレクト
  document.getElementById('corner-dot-style').value    = s.cornerDotStyle;
  document.getElementById('corner-square-style').value = s.cornerSquareStyle;

  // ロゴサイズスライダー
  document.getElementById('logo-size').value           = s.logoSize;
  document.getElementById('logo-size-val').textContent = s.logoSize;

  // タイプ別フィールドにデータを反映させるマッピング
  const map = {
    url:   [['url-input', 'url']],
    text:  [['text-input', 'text']],
    wifi:  [['wifi-ssid', 'ssid'], ['wifi-password', 'password'], ['wifi-encryption', 'encryption'], ['wifi-hidden', 'hidden']],
    vcard: ['lastname', 'firstname', 'org', 'title', 'tel', 'email', 'address', 'note'].map(k => [`vcard-${k}`, k]).concat([['vcard-url', 'vcardUrl']]),
    email: [['email-to', 'to'], ['email-subject', 'subject'], ['email-body', 'body']],
    sms:   [['sms-to', 'to'], ['sms-body', 'body']],
  };

  (map[s.type] || []).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!s.data[key];
    else el.value = s.data[key] || '';
  });
}

// === 初期化 ===
// DOMContentLoaded後に全機能を初期化する
function init() {
  // QRコードインスタンスを生成してDOMに追加
  initQr();

  // 各種イベントリスナーを設定
  setupInputBindings();
  bindColorSync('dot-color', 'dot-color-hex', 'dotColor');
  bindColorSync('bg-color',  'bg-color-hex',  'bgColor');
  setupShapeOptions();
  setupLogo();
  setupExport();
  setupShare();

  // URLパラメータから設定を復元する（共有URL経由のアクセス）
  const fromUrl = decodeFromUrl();
  if (fromUrl) {
    state = fromUrl;
    switchType(state.type);
    applyStateToUI(state);
  } else {
    // デフォルトでサイトURLをセット
    state.data.url = 'https://kiricab.github.io/';
    document.getElementById('url-input').value = state.data.url;
  }

  // 初回レンダリング
  renderQr();
}

document.addEventListener('DOMContentLoaded', init);
