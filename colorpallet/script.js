/* --------- utility: color conversions & helpers --------- */
// clamp helper
const clamp = (v,a,b)=>Math.min(Math.max(v,a),b);

// convert HSL(0-360,0-100,0-100) -> hex
function hslToRgb(h,s,l){
  s/=100; l/=100;
  const k = n => (n + h/30) % 12;
  const a = s * Math.min(l,1-l);
  const f = n => l - a * Math.max(-1, Math.min(k(n)-3, Math.min(9-k(n),1)));
  return [Math.round(255*f(0)), Math.round(255*f(8)), Math.round(255*f(4))];
}
function rgbToHex(r,g,b){
  return "#" + [r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();
}
function hexToRgb(hex){
  hex = hex.replace('#','');
  if(hex.length===3) hex = hex.split('').map(c=>c+c).join('');
  const n = parseInt(hex,16);
  return [(n>>16)&255, (n>>8)&255, n&255];
}
function rgbToHsl(r,g,b){
  r/=255;g/=255;b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h=0, s=0, l=(max+min)/2;
  if(max!==min){
    const d = max-min;
    s = l>0.5?d/(2-max-min):d/(max+min);
    switch(max){
      case r: h = (g-b)/d + (g<b?6:0); break;
      case g: h = (b-r)/d + 2; break;
      case b: h = (r-g)/d + 4; break;
    }
    h *= 60;
  }
  return [Math.round(h), Math.round(s*100), Math.round(l*100)];
}
function formatColor(hex, fmt){
  const [r,g,b] = hexToRgb(hex);
  if(fmt==='hex') return hex.toUpperCase();
  if(fmt==='rgb') return `rgb(${r}, ${g}, ${b})`;
  if(fmt==='hsl') {
    const [h,s,l] = rgbToHsl(r,g,b);
    return `hsl(${h}, ${s}%, ${l}%)`;
  }
  return hex;
}

// random int
const randInt = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;

// generate base random hex via HSL
function randHexFromHSL(){
  const h = randInt(0,359);
  const s = randInt(50,85);
  const l = randInt(30,60);
  const [r,g,b] = hslToRgb(h,s,l);
  return rgbToHex(r,g,b);
}

// generate palettes by harmony
function generatePalette(mode= 'random', count=5){
  if(mode === 'random'){
    return Array.from({length:count}, ()=>randHexFromHSL());
  }
  // derive via HSL base
  const baseH = randInt(0,359);
  const baseS = randInt(40,80);
  const baseL = randInt(35,65);
  const hues = [];
  if(mode === 'analogous'){
    const step = 20;
    const start = baseH - step*2;
    for(let i=0;i<count;i++) hues.push((start + i*step + 360)%360);
  } else if(mode === 'complementary'){
    // two halves
    const comp = (baseH+180)%360;
    hues.push(baseH, (baseH+30)%360, comp, (comp+30)%360, (baseH+330)%360);
  } else if(mode === 'triadic'){
    const a = baseH, b = (baseH+120)%360, c = (baseH+240)%360;
    hues.push(a, (a+30)%360, b, (b+30)%360, c);
  } else if(mode === 'monochrome'){
    for(let i=0;i<count;i++){
      const dl = -18 + i*(36/(count-1));
      hues.push(baseH);
    }
  } else {
    return Array.from({length:count}, ()=>randHexFromHSL());
  }
  // map hues to hex with slight variance in sat/lum
  const palette = hues.map((h,i)=>{
    const s = clamp(baseS + randInt(-8,8), 35, 90);
    let l = clamp(baseL + (i - Math.floor(count/2))*6 + randInt(-6,6), 18, 80);
    const [r,g,b] = hslToRgb(h,s,l);
    return rgbToHex(r,g,b);
  });
  return palette;
}

/* --------- DOM & state --------- */
const paletteEl = document.getElementById('palette');
const generateBtn = document.getElementById('generateBtn');
const harmonySel = document.getElementById('harmony');
const fmtSel = document.getElementById('fmt');
const saveBtn = document.getElementById('saveBtn');
const exportPNG = document.getElementById('exportPNG');
const shareBtn = document.getElementById('shareBtn');
const savedList = document.getElementById('savedList');
const exportJSON = document.getElementById('exportJSON');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
const clearAll = document.getElementById('clearAll');

const lockIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-lock"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
const unlockIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-unlock"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></path></svg>`;

let state = {
  colors: ['#111111','#222222','#333333','#434343','#555555'],
  locks: [false,false,false,false,false]
};

// apply palette to DOM
function renderPalette(){
  paletteEl.innerHTML = '';
  const fmt = fmtSel.value;
  state.colors.forEach((hex, idx)=>{
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = hex;
    sw.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-end;height:100%;">
        <div style="flex:1"></div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;gap:8px;align-items:center" class="meta">
            <div class="left">
              <button class="icon-btn" data-copy="${idx}" title="Copy">${fmt==='hex' ? hex.toUpperCase() : formatColor(hex,fmt)}</button>
            </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="icon-btn lock ${state.locks[idx] ? 'locked' : ''}" data-lock="${idx}" title="Lock/Unlock">${state.locks[idx] ? lockIcon : unlockIcon}</button>
      </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="code">${formatColor(hex,fmt)}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.8)">${getContrastText(hex)}</div>
          </div>
        </div>
      </div>
    `;
    // add click handlers
    paletteEl.appendChild(sw);
  });

  // add event listeners for new buttons
  paletteEl.querySelectorAll('[data-copy]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      const i = +btn.getAttribute('data-copy');
      const fmt = fmtSel.value;
      const text = formatColor(state.colors[i], fmt);
      await navigator.clipboard.writeText(text).catch(()=>{});
      btn.innerText = 'Copied';
      setTimeout(()=> btn.innerText = (fmt==='hex'? state.colors[i].toUpperCase() : formatColor(state.colors[i],fmt)), 900);
    });
  });
  paletteEl.querySelectorAll('[data-lock]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const i = +btn.getAttribute('data-lock');
      state.locks[i] = !state.locks[i];
      renderPalette();
    });
  });

  updatePreview();
}

// basic contrast text (light/dark)
function getContrastText(hex){
  const [r,g,b] = hexToRgb(hex);
  // luminance
  const lum = (0.299*r + 0.587*g + 0.114*b);
  return lum > 150 ? 'dark' : 'light';
}

// generate keeping locked colors
function regenerate(){
  const mode = harmonySel.value;
  const newColors = generatePalette(mode, state.colors.length);
  state.colors = state.colors.map((c,i)=> state.locks[i] ? c : newColors[i]);
  renderPalette();
}

// initial load: check URL query param for colors
function loadFromQuery(){
  const q = new URLSearchParams(window.location.search);
  if(q.has('colors')){
    const v = q.get('colors').split(',').map(s => '#'+s.replace('#',''));
    if(v.length>0){
      state.colors = v.slice(0,5).concat(Array(5).fill('#ffffff')).slice(0,5);
    }
  } else {
    state.colors = generatePalette('random',5);
  }
}
loadFromQuery();
renderPalette();

/* --------- handlers --------- */
generateBtn.addEventListener('click', ()=> {
  // randomize unlocked. If none unlocked, regenerate all.
  const unlocked = state.locks.some(l=>!l);
  if(!unlocked){
    state.locks = [false,false,false,false,false];
  }
  regenerate();
});

fmtSel.addEventListener('change', ()=> renderPalette());
harmonySel.addEventListener('change', ()=> regenerate());

// preview update
function updatePreview(){
  const colors = state.colors;
  document.getElementById('previewCard').style.background = `linear-gradient(180deg, ${colors[0]}33, ${colors[1]}22)`;
  document.getElementById('previewTitle').style.color = colors[0];
  document.getElementById('previewText').style.color = colors[2];
  const btn = document.getElementById('previewButton');
  btn.style.background = colors[1];
  btn.style.color = getContrastText(colors[1])==='light' ? '#fff' : '#111';
  document.getElementById('previewCard2').style.background = colors[4]+'22';
  document.getElementById('previewAvatar').style.background = colors[0];
  document.getElementById('previewName').style.color = colors[1];
  document.getElementById('previewMeta').style.color = colors[3];
  document.getElementById('previewDesc').style.color = colors[2];

  // Update bar chart preview
  document.getElementById('previewBarChart').style.background = colors[0]+'22';
  const barHeights = [80, 60, 40, 70, 50]; // サンプルの高さ
  for (let i = 0; i < 5; i++) {
    const bar = document.getElementById(`bar${i + 1}`);
    if (bar) {
      bar.style.backgroundColor = colors[i];
      bar.style.height = `${barHeights[i]}%`;
    }
  }
}

/* --------- saving & localStorage --------- */
const STORAGE_KEY = 'colormix.saved';
function loadSaved(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(!raw) return [];
  try { return JSON.parse(raw); } catch(e){ return []; }
}
function savePalette(name, colors){
  const arr = loadSaved();
  arr.unshift({id:Date.now(), name: name||`Palette ${new Date().toLocaleString()}`, colors});
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(0,50)));
  renderSaved();
}
function renderSaved(){
  const list = loadSaved();
  savedList.innerHTML = '';
  if(list.length===0){
    savedList.innerHTML = `<div style="color:var(--muted)">No saved palettes yet.</div>`;
    return;
  }
  list.forEach(item=>{
    const el = document.createElement('div');
    el.className = 'saved-card';
    el.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center">
        <div style="display:flex;gap:6px;flex:1">
          ${item.colors.map(c=>`<div style="width:50px;height:50px;border-radius:6px;background:${c};box-shadow:inset 0 -4px 10px rgba(0,0,0,0.2)"></div>`).join('')}
        </div>
        <div class="saved-card-actions">
          <button class="small" data-load="${item.id}">Load</button>
          <button class="small" data-del="${item.id}">Del</button>
        </div>
      </div>
      <div style="color:var(--muted);font-size:13px">${item.name}</div>
    `;
    savedList.appendChild(el);
  });
  // events
  savedList.querySelectorAll('[data-load]').forEach(btn=>{
    btn.addEventListener('click', ()=> {
      const id = +btn.getAttribute('data-load');
      const arr = loadSaved();
      const it = arr.find(x=>x.id===id);
      if(it){
        state.colors = it.colors.slice(0,5);
        state.locks = [false,false,false,false,false];
        renderPalette();
        window.scrollTo({top:0,behavior:'smooth'});
      }
    });
  });
  savedList.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = +btn.getAttribute('data-del');
      let arr = loadSaved().filter(x=>x.id!==id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
      renderSaved();
    });
  });
}
renderSaved();

saveBtn.addEventListener('click', ()=>{
  const name = prompt('保存名を入力してください（省略可）');
  savePalette(name, state.colors.slice());
});

/* --------- export PNG --------- */
exportPNG.addEventListener('click', ()=>{
  const w = 1000, h = 400;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  // background
  const g = ctx.createLinearGradient(0,0,w,h);
  g.addColorStop(0,'#071025'); g.addColorStop(1,'#07121a');
  ctx.fillStyle = g; ctx.fillRect(0,0,w,h);

  // draw palette rectangles
  const pad = 40;
  const gap = 18;
  const swW = (w - pad*2 - gap*4)/5;
  state.colors.forEach((hex,i)=>{
    const x = pad + i*(swW + gap);
    const y = 80;
    ctx.fillStyle = hex; ctx.fillRect(x,y,swW,swW);
    // draw text
    ctx.fillStyle = '#FFF'; // 文字色を白に固定
    ctx.font = 'bold 22px Inter, sans-serif';
    ctx.fillText(hex.toUpperCase(), x+10, y + swW + 30);
  });

  // title
  ctx.fillStyle = '#fff'; ctx.font = '700 28px Inter, sans-serif';
  ctx.fillText('ColorMix Palette', pad, 40);

  const url = c.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = 'colormix-palette.png'; a.click();
});

/* --------- share URL --------- */
shareBtn.addEventListener('click', ()=>{
  const clean = state.colors.map(c=>c.replace('#','')).join(',');
  const u = new URL(window.location.href);
  u.searchParams.set('colors', clean);
  navigator.clipboard.writeText(u.toString()).then(()=> {
    alert('共有用URLをクリップボードにコピーしました');
  }).catch(()=> {
    prompt('コピーできません。以下のURLを手動でコピーしてください', u.toString());
  });
});

/* --------- export/import JSON --------- */
exportJSON.addEventListener('click', ()=>{
  const data = loadSaved();
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'colormix-palettes.json';
  a.click();
});
importBtn.addEventListener('click', ()=> importFile.click());
importFile.addEventListener('change', (e)=>{
  const f = e.target.files[0];
  if(!f) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    try{
      const parsed = JSON.parse(ev.target.result);
      if(Array.isArray(parsed)){
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed.slice(0,200)));
        renderSaved();
        alert('インポート完了');
      } else alert('不正なファイルです');
    }catch(err){ alert('読み込みに失敗しました'); }
  };
  reader.readAsText(f);
});

clearAll.addEventListener('click', ()=>{
  if(confirm('保存済みパレットをすべて削除しますか？')) {
    localStorage.removeItem(STORAGE_KEY);
    renderSaved();
  }
});

/* --------- init: try to read from query param and saved --------- */
// If query present, it was already handled on loadFromQuery.
// otherwise show loaded saved first if exists
(function init(){
  const q = new URLSearchParams(window.location.search);
  if(!q.has('colors')){
    const saved = loadSaved();
    if(saved.length>0){
      // do nothing: keep current generated palette. Optionally load newest
    }
  }
})();

/* --------- accessibility hint: keyboard generate (space) --------- */
document.addEventListener('keydown', (e)=>{
  if(e.code === 'Space' && !['INPUT','TEXTAREA','SELECT','BUTTON'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    generateBtn.classList.add('active');
    regenerate();
    setTimeout(()=> generateBtn.classList.remove('active'), 150);
  }
});
