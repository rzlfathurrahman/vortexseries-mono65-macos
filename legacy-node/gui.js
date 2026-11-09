#!/usr/bin/env node
// mono65gui — MONO 65 Clean Hardware Dashboard for macOS
// usage: node gui.js → opens http://127.0.0.1:7878
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Mono65 } = require('./mono65.js');

const PORT = 7878;
const SKIN = path.join(__dirname, 'app/app/skins/theme1');
const LAYOUT = path.join(__dirname, 'app/app/layouts/KB-K102.xml');
const REMAPS_FILE = path.join(__dirname, 'active_remaps.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

let activeRemaps = [];
try {
  if (fs.existsSync(REMAPS_FILE)) {
    activeRemaps = JSON.parse(fs.readFileSync(REMAPS_FILE, 'utf8'));
  }
} catch (e) {
  activeRemaps = [];
}

let appConfig = { osMode: 'mac' };
try {
  if (fs.existsSync(CONFIG_FILE)) {
    appConfig = Object.assign(appConfig, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  }
} catch (e) {
  appConfig = { osMode: 'mac' };
}

const saveRemaps = () => {
  try {
    fs.writeFileSync(REMAPS_FILE, JSON.stringify(activeRemaps, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save remaps:', e.message);
  }
};

const saveConfig = () => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e.message);
  }
};

// key table from KB-K102.xml: code, name, rect x/y/w/h (bitmap pixel space)
const KEYS = (() => {
  const xml = fs.readFileSync(LAYOUT, 'utf8');
  const out = [];
  for (const m of xml.matchAll(/<key\b[^>]*>/g)) {
    const tag = m[0];
    const attr = n => { const r = tag.match(new RegExp(n + '\\s*=\\s*"([^"]*)"')); return r ? r[1] : ''; };
    const rect = attr('rect').split(/\D+/).filter(Boolean).map(Number);
    if (attr('code') && rect.length === 4) {
      out.push({ code: attr('code').toLowerCase(), name: attr('name') || attr('code'), x: rect[0], y: rect[1], w: rect[2], h: rect[3] });
    }
  }
  return out;
})();

// Light modes from official 1033.txt
const LIGHT_MODES = [
  { id: 1, name: 'Steady' },
  { id: 2, name: 'Breathing' },
  { id: 3, name: 'Press & Destroy' },
  { id: 4, name: 'Neon Stream' },
  { id: 5, name: 'Streamer' },
  { id: 6, name: 'Flowing Light & Color' },
  { id: 7, name: 'Dripping Ripples' },
  { id: 8, name: 'Brilliant Point' },
  { id: 9, name: 'Flash Away' },
  { id: 10, name: 'Shadow Disappear' },
  { id: 11, name: 'Ripples Shining' },
  { id: 12, name: 'Rich & Honored' },
  { id: 13, name: 'Marquee Effect' },
  { id: 14, name: 'Rotating Storm' },
  { id: 15, name: 'Serpentine Race' },
  { id: 16, name: 'Stars Twinkle' },
  { id: 17, name: 'Retro Snake' },
  { id: 18, name: 'Diagonal Shift' },
  { id: 19, name: 'Sine Wave' }
];

// extended dst codes 0xE8-0xF9 + useful standalone keys (like ~ / `)
const FUNCS = [
  ['0x35', '` ~ (Tilde)', 'fa-solid fa-tilde'],
  ['0xea', 'Vol +', 'fa-solid fa-volume-high'],
  ['0xe9', 'Vol −', 'fa-solid fa-volume-low'],
  ['0xeb', 'Mute', 'fa-solid fa-volume-xmark'],
  ['0xee', 'Play/Pause', 'fa-solid fa-play'],
  ['0xef', 'Next Track', 'fa-solid fa-forward-step'],
  ['0xed', 'Prev Track', 'fa-solid fa-backward-step'],
  ['0xec', 'Stop', 'fa-solid fa-stop'],
  ['0xe8', 'Multimedia', 'fa-solid fa-photo-film'],
  ['0xf0', 'Email', 'fa-solid fa-envelope'],
  ['0xf1', 'Web Home', 'fa-solid fa-house'],
  ['0xf2', 'Calculator', 'fa-solid fa-calculator'],
  ['0xf6', 'Web Refresh', 'fa-solid fa-rotate-right'],
  ['0xf5', 'Web Stop', 'fa-solid fa-circle-xmark'],
  ['0xf8', 'Favorites', 'fa-solid fa-star'],
  ['0xf9', 'My PC', 'fa-solid fa-desktop'],
];

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MONO 65 Dashboard</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" integrity="sha512-DTOQO9RWCH3ppGqcWaEA1BIZOC6xxalwEsw9c2QQeAIftl+Vegovlnee1c9QX4TctnWMn13TZye+giMm8e2LwA==" crossorigin="anonymous" referrerpolicy="no-referrer" />
  <style>
    * { box-sizing: border-box; }
    :root {
      --bg-base: #090d16;
      --bg-surface: #111726;
      --bg-card: #161e31;
      --border: #232d45;
      --border-focus: #3b82f6;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --success: #10b981;
    }
    body {
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      margin: 0;
      background: var(--bg-base);
      color: var(--text-main);
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 28px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(37, 99, 235, 0.15);
      border: 1px solid rgba(37, 99, 235, 0.3);
      border-radius: 8px;
      color: #60a5fa;
      font-size: 15px;
    }
    .brand h1 {
      font-size: 15px;
      margin: 0;
      font-weight: 600;
      letter-spacing: -0.2px;
      color: var(--text-main);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 500;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.12);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
      margin-left: 8px;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 6px var(--success);
    }
    nav {
      display: flex;
      gap: 4px;
      background: var(--bg-base);
      padding: 3px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    nav button {
      border: 0;
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 500;
      padding: 7px 16px;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.15s ease;
    }
    nav button:hover {
      color: var(--text-main);
    }
    nav button.on {
      background: var(--bg-card);
      color: var(--text-main);
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      border: 1px solid var(--border);
    }
    main {
      padding: 24px;
      max-width: 980px;
      margin: 0 auto;
    }
    .panel {
      display: none;
    }
    .panel.on {
      display: block;
      animation: fadeIn 0.15s ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin: 0 0 16px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Lighting grid */
    .modes-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 20px;
    }
    .mode-btn {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      font-size: 12px;
      text-align: left;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .mode-btn:hover {
      background: #1c2740;
      color: var(--text-main);
      border-color: #3b82f6;
    }
    .mode-btn.on {
      background: rgba(37, 99, 235, 0.2);
      border-color: var(--primary);
      color: #93c5fd;
      font-weight: 600;
    }
    .mode-num {
      font-size: 10px;
      opacity: 0.5;
      font-family: ui-monospace, monospace;
    }

    /* Controls */
    .row {
      display: flex;
      gap: 16px;
      align-items: center;
      flex-wrap: wrap;
    }
    .ctrl-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    label {
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 500;
    }
    select, button.btn {
      font-size: 12px;
      padding: 7px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-main);
      outline: none;
      transition: all 0.15s ease;
    }
    select:focus {
      border-color: var(--primary);
    }
    button.btn {
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-weight: 500;
    }
    button.btn-primary {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
    }
    button.btn-primary:hover {
      background: var(--primary-hover);
    }
    button.btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.35);
      color: #fca5a5;
    }
    button.btn-danger:hover {
      background: var(--danger);
      color: #fff;
    }
    button.btn-subtle {
      background: transparent;
      border-color: transparent;
      color: var(--text-muted);
    }
    button.btn-subtle:hover {
      background: var(--bg-card);
      color: var(--text-main);
      border-color: var(--border);
    }

    /* Keyboard overlay */
    .kbwrap {
      position: relative;
      width: 600px;
      background: #060910;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      margin: 0 auto 16px auto;
    }
    .kbwrap img {
      display: block;
      width: 600px;
    }
    #kbover {
      position: absolute;
      left: 10px;
      top: 10px;
      width: 600px;
      height: 220px;
    }
    #kbover button {
      position: absolute;
      border: 1px solid transparent;
      background: transparent;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.1s ease;
    }
    #kbover button:hover {
      border-color: var(--primary);
      background: rgba(37, 99, 235, 0.25);
    }
    #kbover button.src {
      border-color: #f59e0b;
      background: rgba(245, 158, 11, 0.35);
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.6);
    }
    #kbover button.has-remap {
      border-color: var(--success);
      background: rgba(16, 185, 129, 0.25);
    }
    #kbover button.has-remap::after {
      content: '';
      position: absolute;
      top: 3px;
      right: 3px;
      width: 4px;
      height: 4px;
      background: var(--success);
      border-radius: 50%;
    }

    /* Multimedia / shortcuts */
    .funcs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
      gap: 8px;
    }
    .funcs-grid button {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      height: 64px;
      padding: 6px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      transition: all 0.15s ease;
    }
    .funcs-grid button i {
      font-size: 14px;
      color: #93c5fd;
    }
    .funcs-grid button:hover {
      border-color: var(--primary);
      color: var(--text-main);
      background: #1c2740;
    }

    /* Remap table */
    .remap-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .remap-table th {
      text-align: left;
      padding: 10px 12px;
      background: var(--bg-card);
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      font-weight: 500;
    }
    .remap-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 11px;
      background: var(--bg-base);
      border: 1px solid var(--border);
    }
    .badge.src {
      color: #fbbf24;
      border-color: rgba(251, 191, 36, 0.4);
    }
    .badge.dst {
      color: #34d399;
      border-color: rgba(52, 211, 153, 0.4);
    }

    /* Log terminal */
    #log {
      font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #34d399;
      background: #060910;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      max-height: 100px;
      overflow-y: auto;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-icon"><i class="fa-solid fa-keyboard"></i></div>
      <div>
        <h1>VortexSeries MONO 65</h1>
      </div>
      <span class="status-badge" id="status-badge"><span class="status-dot"></span> Connected</span>
      <div class="os-selector" style="display: flex; gap: 4px; margin-left: 12px; background: var(--bg-base); padding: 2px; border-radius: 6px; border: 1px solid var(--border);">
        <button id="btn-mode-mac" class="btn btn-subtle" style="padding: 3px 10px; font-size: 11px; border-radius: 4px;" onclick="switchOSMode('mac')">
          <i class="fa-brands fa-apple"></i> Mac
        </button>
        <button id="btn-mode-win" class="btn btn-subtle" style="padding: 3px 10px; font-size: 11px; border-radius: 4px;" onclick="switchOSMode('win')">
          <i class="fa-brands fa-windows"></i> Win
        </button>
      </div>
    </div>
    <nav>
      <button id="t-light" class="on" onclick="tab('light')"><i class="fa-solid fa-lightbulb"></i> RGB Backlight</button>
      <button id="t-key" onclick="tab('key')"><i class="fa-solid fa-sliders"></i> Key Remapping</button>
    </nav>
  </header>

  <main>
    <!-- LIGHTING PANEL -->
    <section class="panel on" id="p-light">
      <div class="card">
        <div class="card-title">
          <span>Lighting Effects</span>
          <button class="btn btn-danger" onclick="turnLightOff()"><i class="fa-solid fa-power-off"></i> Turn Off RGB</button>
        </div>
        <div class="modes-grid" id="modes-grid"></div>

        <div class="row" style="border-top: 1px solid var(--border); padding-top: 16px;">
          <div class="ctrl-group">
            <label for="speed"><i class="fa-solid fa-gauge-high"></i> Speed</label>
            <select id="speed">
              <option value="1">1 (Slow)</option>
              <option value="2" selected>2 (Medium)</option>
              <option value="3">3 (Fast)</option>
              <option value="4">4 (Very Fast)</option>
            </select>
          </div>
          <div class="ctrl-group">
            <label for="bri"><i class="fa-solid fa-sun"></i> Brightness</label>
            <select id="bri">
              <option value="1">Level 1 (25%)</option>
              <option value="2">Level 2 (50%)</option>
              <option value="3">Level 3 (75%)</option>
              <option value="4" selected>Level 4 (100%)</option>
            </select>
          </div>
          <button class="btn btn-primary" onclick="applyPreset()"><i class="fa-solid fa-check"></i> Apply Effect</button>
        </div>
      </div>
    </section>

    <!-- KEY REMAP PANEL -->
    <section class="panel" id="p-key">
      <div class="card">
        <div class="card-title">
          <span>Keyboard Layout (65%)</span>
          <span id="remap-slots" style="font-weight: normal; font-size: 11px;">0 / 12 Slots Used</span>
        </div>
        <p style="margin: 0 0 12px 0; color: var(--text-muted); font-size: 12px;">
          Click a physical key (orange) then click a destination key or action below.
        </p>
        <div class="kbwrap">
          <img src="/skin/keyboard/kb_102.png" alt="Layout">
          <div id="kbover"></div>
        </div>
        <div id="selection-bar" style="min-height: 22px; font-size: 12px; color: #60a5fa; font-weight: 500;">
          Select a key on the layout above to begin.
        </div>
      </div>

      <div class="card">
        <div class="card-title">Multimedia & System Actions</div>
        <div class="funcs-grid" id="funcs-grid"></div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Active Remap Table</span>
          <button class="btn btn-subtle" style="font-size: 11px;" onclick="clearAllRemaps()"><i class="fa-solid fa-trash-can"></i> Reset All</button>
        </div>
        <table class="remap-table">
          <thead>
            <tr>
              <th>Physical Key</th>
              <th></th>
              <th>Assigned Action</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="remap-tbody">
            <tr><td colspan="4" style="color: var(--text-muted); text-align: center; padding: 14px;">No custom remaps assigned (factory defaults).</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- STATUS / LOG -->
    <div class="card" style="padding: 14px 18px;">
      <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); display: flex; justify-content: space-between; margin-bottom: 8px;">
        <span><i class="fa-solid fa-terminal"></i> HARDWARE LOG</span>
        <a href="javascript:void(0)" onclick="$('log').textContent=''" style="color: var(--text-muted); text-decoration: none;">Clear</a>
      </div>
      <div id="log">Device communication channel ready.</div>
    </div>
  </main>

  <script>
    const FUNCS = ${JSON.stringify(FUNCS)};
    const KEYS = ${JSON.stringify(KEYS)};
    const LIGHT_MODES = ${JSON.stringify(LIGHT_MODES)};
    let activeRemaps = ${JSON.stringify(activeRemaps)};
    let appConfig = ${JSON.stringify(appConfig)};

    const $ = id => document.getElementById(id);
    const log = t => {
      const el = $('log');
      const time = new Date().toLocaleTimeString();
      el.textContent = '[' + time + '] ' + t + '\\n' + el.textContent;
    };

    function tab(id) {
      for (const p of ['light', 'key']) {
        $('p-' + p).classList.toggle('on', p === id);
        $('t-' + p).classList.toggle('on', p === id);
      }
    }

    // Populate lighting modes
    let currentMode = 1;
    const modesGrid = $('modes-grid');
    modesGrid.innerHTML = LIGHT_MODES.map(m =>
      '<button class="mode-btn ' + (m.id === 1 ? 'on' : '') + '" onclick="selectMode(this, ' + m.id + ')">' +
      '<span>' + m.name + '</span>' +
      '<span class="mode-num">#' + String(m.id).padStart(2, '0') + '</span>' +
      '</button>'
    ).join('');

    function selectMode(btn, m) {
      currentMode = m;
      for (const b of modesGrid.children) b.classList.remove('on');
      btn.classList.add('on');
    }

    async function api(endpoint, body) {
      try {
        const res = await fetch('/api/' + endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : '{}'
        });
        const data = await res.json();
        if (data.ok) {
          log(data.msg || 'Success');
        } else {
          log('ERR: ' + (data.err || 'Failed'));
        }
        return data;
      } catch (e) {
        log('ERR: Connection lost — ' + e.message);
      }
    }

    function applyPreset() {
      api('preset', {
        mode: currentMode,
        speed: +$('speed').value,
        bri: +$('bri').value
      });
    }

    function turnLightOff() {
      api('preset', {
        mode: currentMode,
        speed: 1,
        bri: 0
      });
      log('Sent turn-off signal (brightness 0)...');
    }

    // Key overlays
    const over = $('kbover');
    const keyElements = {};
    for (const k of KEYS) {
      const b = document.createElement('button');
      b.style.cssText = 'left:' + k.x + 'px;top:' + k.y + 'px;width:' + k.w + 'px;height:' + k.h + 'px';
      b.title = k.name + ' (' + k.code + ')';
      b.onclick = () => onKeyClick(k, b);
      over.appendChild(b);
      keyElements[k.code] = b;
    }

    let selectedSrc = null;

    function getKeyName(code) {
      const c = (code || '').toLowerCase();
      const k = KEYS.find(x => x.code === c);
      if (k) return k.name;
      const f = FUNCS.find(x => x[0].toLowerCase() === c);
      if (f) return f[1];
      return code;
    }

    function onKeyClick(k, b) {
      if (!selectedSrc) {
        selectedSrc = k;
        b.classList.add('src');
        $('selection-bar').innerHTML = 'Selected: <strong>' + k.name + ' (' + k.code + ')</strong> — Click a destination key or action.';
      } else {
        if (b.classList.contains('src')) {
          clearSelection();
          return;
        }
        assignRemap(selectedSrc.code, k.code);
        clearSelection();
      }
    }

    function clearSelection() {
      if (selectedSrc && keyElements[selectedSrc.code]) {
        keyElements[selectedSrc.code].classList.remove('src');
      }
      selectedSrc = null;
      $('selection-bar').textContent = 'Select a key on the layout above to begin.';
    }

    // Populate multimedia / function palette using FontAwesome icons
    const funcsGrid = $('funcs-grid');
    funcsGrid.innerHTML = '';
    for (const f of FUNCS) {
      const btn = document.createElement('button');
      btn.title = f[1] + ' (' + f[0] + ')';
      btn.innerHTML = '<i class="' + f[2] + '"></i><span>' + f[1] + '</span>';
      btn.onclick = () => pickFunc(f[0]);
      funcsGrid.appendChild(btn);
    }

    function pickFunc(code) {
      if (!selectedSrc) {
        log('Notice: Select a source key on the keyboard first.');
        return;
      }
      const srcCode = selectedSrc.code;
      clearSelection();
      assignRemap(srcCode, code);
    }

    async function assignRemap(src, dst) {
      src = src.toLowerCase();
      dst = dst.toLowerCase();

      activeRemaps = activeRemaps.filter(p => p[0] !== src);
      if (src !== dst) {
        if (activeRemaps.length >= 12) {
          log('ERR: Hardware limit reached (max 12 slots).');
          return;
        }
        activeRemaps.push([src, dst]);
      }

      renderRemapTable();
      await syncRemapsToDevice();
    }

    async function removeRemap(src) {
      activeRemaps = activeRemaps.filter(p => p[0] !== src.toLowerCase());
      renderRemapTable();
      await syncRemapsToDevice();
    }

    async function clearAllRemaps() {
      if (!confirm('Reset all keys to factory default?')) return;
      activeRemaps = [];
      renderRemapTable();
      await syncRemapsToDevice();
    }

    async function syncRemapsToDevice() {
      log('Writing ' + activeRemaps.length + ' remap entries to keyboard hardware...');
      const res = await api('sync-remaps', { pairs: activeRemaps });
      if (res && res.ok) {
        renderRemapTable();
      }
    }

    function renderRemapTable() {
      const tbody = $('remap-tbody');
      $('remap-slots').textContent = activeRemaps.length + ' / 12 Slots Used';

      for (const k of KEYS) {
        if (keyElements[k.code]) {
          keyElements[k.code].classList.remove('has-remap');
        }
      }
      for (const [src] of activeRemaps) {
        if (keyElements[src]) {
          keyElements[src].classList.add('has-remap');
        }
      }

      if (activeRemaps.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="color: var(--text-muted); text-align: center; padding: 14px;">No custom remaps assigned (factory defaults).</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      for (const [src, dst] of activeRemaps) {
        const tr = document.createElement('tr');
        const srcName = getKeyName(src);
        const dstName = getKeyName(dst);
        tr.innerHTML = '<td><span class="badge src">' + src + '</span> <strong>' + srcName + '</strong></td>' +
          '<td style="color: var(--text-muted);"><i class="fa-solid fa-arrow-right"></i></td>' +
          '<td><span class="badge dst">' + dst + '</span> <strong>' + dstName + '</strong></td>' +
          '<td><button class="btn btn-subtle del-btn" style="padding: 2px 8px; font-size: 11px; color: #ef4444;"><i class="fa-solid fa-xmark"></i></button></td>';
        tr.querySelector('.del-btn').onclick = () => removeRemap(src);
        tbody.appendChild(tr);
      }
    }

    function updateOSModeUI() {
      const isMac = (appConfig.osMode || 'mac') === 'mac';
      const btnMac = $('btn-mode-mac');
      const btnWin = $('btn-mode-win');
      if (isMac) {
        btnMac.style.background = 'rgba(37, 99, 235, 0.25)';
        btnMac.style.color = '#93c5fd';
        btnMac.style.borderColor = 'var(--primary)';
        btnWin.style.background = 'transparent';
        btnWin.style.color = 'var(--text-muted)';
        btnWin.style.borderColor = 'transparent';
      } else {
        btnWin.style.background = 'rgba(37, 99, 235, 0.25)';
        btnWin.style.color = '#93c5fd';
        btnWin.style.borderColor = 'var(--primary)';
        btnMac.style.background = 'transparent';
        btnMac.style.color = 'var(--text-muted)';
        btnMac.style.borderColor = 'transparent';
      }
    }

    async function switchOSMode(targetMode) {
      if (appConfig.osMode === targetMode) return;
      log('Switching keyboard layout to ' + targetMode.toUpperCase() + ' mode...');
      const res = await api('set-os-mode', { mode: targetMode });
      if (res && res.ok) {
        appConfig.osMode = targetMode;
        if (res.activeRemaps) activeRemaps = res.activeRemaps;
        updateOSModeUI();
        renderRemapTable();
      }
    }

    updateOSModeUI();
    renderRemapTable();

    setInterval(async () => {
      try {
        const res = await fetch('/api/ping');
        const data = await res.json();
        $('status-badge').style.display = data.connected ? 'inline-flex' : 'none';
      } catch (e) {}
    }, 5000);
  </script>
</body>
</html>`;

let dev = null, busy = false;

async function device() {
  if (dev) return dev;
  dev = await Mono65.open();
  return dev;
}

const clamp = (v, lo, hi) => Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : null;

const server = http.createServer((req, res) => {
  const done = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    const u = req.url.split('?')[0];
    if (req.method === 'GET' && u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && u.startsWith('/skin/')) {
      const rel = path.normalize(decodeURIComponent(u.slice(6))).replace(/^(\.\.[\/\\])+/, '');
      const file = path.join(SKIN, rel);
      if (!file.startsWith(SKIN) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return done(404, { err: 'skin file not found' });
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      return fs.createReadStream(file).pipe(res);
    }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const b = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};

        if (req.method === 'GET' && u === '/api/ping') {
          return done(200, { connected: true });
        }

        const m = await device();
        if (busy) return done(429, { err: 'busy: device command in progress' });
        busy = true;

        try {
          if (req.method === 'POST' && u === '/api/set-os-mode') {
            const targetMode = b.mode === 'win' ? 'win' : 'mac';
            appConfig.osMode = targetMode;
            saveConfig();

            // Win: 0xe3 (Win) -> 0xe3, 0xe2 (Alt) -> 0xe2 (remove swap)
            // Mac: 0xe3 (physical Win) -> 0xe2 (Alt/Option), 0xe2 (physical Alt) -> 0xe3 (Win/Cmd)
            activeRemaps = activeRemaps.filter(p => p[0] !== '0xe3' && p[0] !== '0xe2');
            if (targetMode === 'mac') {
              activeRemaps.push(['0xe3', '0xe2']); // Win key sends Alt (Option)
              activeRemaps.push(['0xe2', '0xe3']); // Alt key sends Win (Command)
            }
            saveRemaps();

            const parsed = activeRemaps.map(([s, d]) => [parseInt(s, 16), parseInt(d, 16)]);
            const resRemap = await m.remap(parsed);
            if (resRemap && resRemap.err) {
              return done(500, { err: 'OS mode switch warning: ' + JSON.stringify(resRemap.err) });
            }

            return done(200, {
              ok: true,
              msg: targetMode === 'mac'
                ? 'Switched to macOS mode: Win is now Option, Alt is now Command (⌘).'
                : 'Switched to Windows mode: Default Win/Alt key mapping restored.',
              activeRemaps
            });
          }

          if (req.method === 'POST' && u === '/api/status') {
            return done(200, { ok: true, msg: 'status ' + JSON.stringify(await m.version()) });
          }

          if (req.method === 'POST' && u === '/api/preset') {
            const mode = clamp(b.mode, 1, 19);
            const sp = clamp(b.speed, 1, 4);
            const br = clamp(b.bri, 0, 4);
            if (mode === null || sp === null || br === null) {
              return done(400, { err: 'mode 1-19, speed 1-4, brightness 0-4' });
            }
            await m.preset(mode, sp, br);
            const modeName = LIGHT_MODES.find(x => x.id === mode)?.name || mode;
            return done(200, {
              ok: true,
              msg: br === 0 ? 'Backlight turned off' : `Preset "${modeName}" (speed ${sp}, bri ${br}) applied`
            });
          }

          if (req.method === 'POST' && u === '/api/sync-remaps') {
            const rawPairs = b.pairs || [];
            if (!Array.isArray(rawPairs)) return done(400, { err: 'pairs must be an array' });
            if (rawPairs.length > 12) return done(400, { err: 'max 12 pairs' });

            const parsed = [];
            for (const [s, d] of rawPairs) {
              const srcNum = parseInt(s, 16);
              const dstNum = parseInt(d, 16);
              if (isNaN(srcNum) || isNaN(dstNum) || srcNum < 0 || srcNum > 0xff || dstNum < 0 || dstNum > 0xff) {
                return done(400, { err: `Invalid hex pair: ${s} -> ${d}` });
              }
              parsed.push([srcNum, dstNum]);
            }

            activeRemaps = rawPairs.map(([s, d]) => [s.toLowerCase(), d.toLowerCase()]);
            saveRemaps();

            const resRemap = await m.remap(parsed);
            if (resRemap && resRemap.err) {
              return done(500, { err: 'Remap hardware note: ' + JSON.stringify(resRemap.err) });
            }

            return done(200, {
              ok: true,
              msg: parsed.length === 0
                ? 'All keys restored to factory defaults.'
                : `Successfully wrote ${parsed.length} key remaps to hardware!`
            });
          }

          done(404, { err: 'unknown endpoint' });
        } finally {
          busy = false;
        }
      } catch (e) {
        if (res.headersSent) return console.error('output too late:', e.message);
        const msg = /no vendor lane/.test(e.message)
          ? 'MONO 65 hardware not detected — check USB connection'
          : e.message;
        done(500, { err: msg });
      }
    });
  } catch (e) {
    done(500, { err: e.message });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use — run: pkill -f gui.js and retry`);
    process.exit(1);
  }
  console.error(e);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MONO 65 Dashboard ready at: http://127.0.0.1:${PORT}`);
});
