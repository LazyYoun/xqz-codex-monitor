'use strict';

const {
  app, BrowserWindow, Menu, Tray, screen, nativeImage, shell, ipcMain, Notification, globalShortcut,
} = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------- 系统数据采集

let defaultIface = null;
let lastCpuTimes = os.cpus().map((c) => ({ ...c.times }));
let lastNetCounters = null;
let lastNetAt = Date.now();
const netHistoryDown = [];
const netHistoryUp = [];

function execLines(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

async function detectInterface() {
  const out = await execLines('/sbin/route', ['-n', 'get', 'default']);
  const match = out && out.match(/interface:\s*(\S+)/);
  defaultIface = match ? match[1] : 'en0';
}

function sampleCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  cpus.forEach((c, i) => {
    const t = c.times;
    const p = lastCpuTimes[i] || t;
    idle += t.idle - p.idle;
    total += (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq);
  });
  lastCpuTimes = cpus.map((c) => ({ ...c.times }));
  return {
    usage: total > 0 ? Math.max(0, Math.min(100, ((total - idle) / total) * 100)) : 0,
    cores: cpus.length,
    model: (cpus[0] && cpus[0].model) || '',
  };
}

function sampleDisk() {
  const s = fs.statfsSync('/');
  const total = s.bsize * s.blocks;
  const free = s.bsize * s.bavail;
  return { total, free, used: total - free };
}

async function sampleMem() {
  const total = os.totalmem();
  const out = await execLines('/usr/bin/vm_stat', []);
  const ps = 16384;
  const get = (key) => {
    const match = out && out.match(new RegExp(key + ':\\s+([\\d]+)'));
    return match ? Number(match[1]) * ps : 0;
  };
  const free = get('Pages free');
  const active = get('Pages active');
  const inactive = get('Pages inactive');
  const wired = get('Pages wired down');
  const compressed = get('Pages occupied by compressor');
  return { total, used: total - free, free, active, wired, compressed, inactive };
}

async function sampleNet() {
  if (!defaultIface) return null;
  const out = await execLines('/usr/sbin/netstat', ['-ib', '-I', defaultIface]);
  const link = out && out.split('\n').find((l) => l.includes('<Link'));
  if (!link) return null;
  const cols = link.trim().split(/\s+/);
  return { rx: Number(cols[6]) || 0, tx: Number(cols[9]) || 0 };
}

async function networkTick() {
  const cur = await sampleNet();
  let down = 0;
  let up = 0;
  if (cur && lastNetCounters) {
    const dt = Math.max(1, Date.now() - lastNetAt);
    down = Math.max(0, ((cur.rx - lastNetCounters.rx) * 1000) / dt);
    up = Math.max(0, ((cur.tx - lastNetCounters.tx) * 1000) / dt);
  }
  if (cur) { lastNetCounters = cur; lastNetAt = Date.now(); }
  netHistoryDown.push(down);
  netHistoryUp.push(up);
  if (netHistoryDown.length > 120) netHistoryDown.shift();
  if (netHistoryUp.length > 120) netHistoryUp.shift();
  return { down, up, iface: defaultIface, historyDown: netHistoryDown.slice(), historyUp: netHistoryUp.slice() };
}

async function tickSystem() {
  try {
    const cpu = sampleCpu();
    const [mem, net] = await Promise.all([sampleMem(), networkTick()]);
    let disk = null;
    try { disk = sampleDisk(); } catch { /* keep null */ }
    broadcast('sys', {
      cpu,
      mem,
      disk,
      net,
      load: os.loadavg(),
      host: { name: os.hostname(), release: os.release(), arch: os.arch(), uptime: os.uptime() },
      sampledAt: Date.now(),
    });
  } catch (err) { console.error('[sys] sample failed:', err.message); }
}

async function fetchJSON(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function externalInfo() {
  const host = { name: os.hostname() };
  const lan = { iface: defaultIface || '', ip: '', gateway: '', dns: '', ssid: '' };
  try {
    const ifs = os.networkInterfaces();
    const items = defaultIface && ifs[defaultIface];
    if (items) {
      const item = items.find((i) => i.family === 'IPv4' && !i.internal);
      if (item) lan.ip = item.address;
    }
    const routeOut = await execLines('/sbin/route', ['-n', 'get', 'default']);
    const gw = routeOut && routeOut.match(/gateway:\s*(\S+)/);
    if (gw) lan.gateway = gw[1];
  } catch { /* ignore */ }
  try {
    const dnsOut = await execLines('/usr/sbin/scutil', ['--dns']);
    const set = new Set();
    if (dnsOut) dnsOut.split('\n').forEach((l) => {
      const m = l.match(/nameserver\[\d+\]\s*:\s*(\S+)/);
      if (m) set.add(m[1]);
    });
    lan.dns = Array.from(set).join(' / ');
  } catch { /* ignore */ }
  try {
    const wifiOut = await execLines('/usr/sbin/networksetup', ['-getairportnetwork', defaultIface || 'en0']);
    const m = wifiOut && wifiOut.match(/Current Wi-Fi Network:\s*(.*)/);
    lan.ssid = m ? m[1].trim() : '';
  } catch { /* ignore */ }

  let ip = '';
  try { ip = (await fetchJSON('https://api.ipify.org?format=json')).ip || ''; } catch { /* offline */ }
  let geo = null;
  if (ip) {
    try {
      geo = await fetchJSON(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,regionName,city,isp,org,as,timezone,lat,lon,query`);
    } catch { /* ignore */ }
  }
  broadcast('ext', {
    ip: (geo && geo.query) || ip || '',
    isp: (geo && geo.isp) || '',
    org: (geo && geo.org) || '',
    as: (geo && geo.as) || '',
    country: (geo && geo.country) || '',
    countryCode: (geo && geo.countryCode) || '',
    region: (geo && geo.regionName) || '',
    city: (geo && geo.city) || '',
    timezone: (geo && geo.timezone) || '',
    lat: geo && geo.lat,
    lon: geo && geo.lon,
    status: geo ? geo.status : (ip ? 'ip-only' : '不可用'),
    message: (geo && geo.message) || '',
    fetchedAt: Date.now(),
    lan,
    host,
  });
}

let mainWindow = null;
let previewWindow = null;
let tray = null;
let helper = null;
let restartTimer = null;
let quitting = false;
let polling = false;
const helperLog = [];

const state = {
  bridge: '未检测到 XQZ',
  bridgeConnected: false,
  helperReady: false,
  mirror: false,
  primaryConflict: false,
  flip: false,
  origin: 'CodexBar',
};

// ---------------------------------------------------------------- CodexBar CLI

function cliPath() {
  const candidates = [
    '/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI',
    '/opt/homebrew/bin/codexbar',
    '/usr/local/bin/codexbar',
  ];
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile() && fs.accessSync(p, fs.constants.X_OK) === undefined) return p;
    } catch { /* try next */ }
  }
  return null;
}

function parseUsage(data) {
  const text = String(data || '');
  const root = JSON.parse(text);
  if (!Array.isArray(root)) return null;
  const provider = root.find((entry) => entry && entry.provider === 'codex');
  if (!provider) return null;
  const usage = provider.usage || {};
  const primary = usage.primary || {};
  const secondary = usage.secondary || {};
  const dashboard = provider.openaiDashboard || {};
  const credits = provider.credits || {};

  let codeReviewRemaining = null;
  if (typeof dashboard.codeReviewRemainingPercent === 'number') {
    codeReviewRemaining = dashboard.codeReviewRemainingPercent;
  } else if (dashboard.codeReviewLimit && typeof dashboard.codeReviewLimit.usedPercent === 'number') {
    codeReviewRemaining = Math.max(0, 100 - dashboard.codeReviewLimit.usedPercent);
  }

  const daily = Array.isArray(dashboard.usageBreakdown)
    ? dashboard.usageBreakdown
        .filter((row) => row && typeof row.day === 'string')
        .map((row) => ({ day: row.day, credits: Number(row.totalCreditsUsed) || 0 }))
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
        .slice(-14)
    : [];

  let plan = typeof usage.loginMethod === 'string'
    ? usage.loginMethod.charAt(0).toUpperCase() + usage.loginMethod.slice(1)
    : 'Codex';
  if (typeof dashboard.accountPlan === 'string' && dashboard.accountPlan) plan = dashboard.accountPlan;

  return {
    provider: 'codex',
    source: provider.source || '--',
    plan,
    sessionUsed: Number(primary.usedPercent) || 0,
    weeklyUsed: Number(secondary.usedPercent) || 0,
    sessionReset: primary.resetsAt || null,
    weeklyReset: secondary.resetsAt || null,
    codeReviewRemaining,
    resetCredits:
      usage.codexResetCredits && Number.isFinite(Number(usage.codexResetCredits.availableCount))
        ? Math.max(0, Number(usage.codexResetCredits.availableCount))
        : 0,
    creditsRemaining:
      credits.remaining != null && Number.isFinite(Number(credits.remaining))
        ? Number(credits.remaining)
        : null,
    updatedAt: usage.updatedAt || null,
    daily,
  };
}

function refreshUsage() {
  if (polling) return;
  const cli = cliPath();
  if (!cli) {
    broadcast('usage', { error: '未找到 CodexBar CLI，请安装 CodexBar' });
    return;
  }
  polling = true;
  execFile(
    cli,
    ['usage', '--provider', 'codex', '--format', 'json', '--source', 'auto'],
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      polling = false;
      if (error) {
        const detail = String(stderr || '').trim();
        broadcast('usage', { error: detail || 'CodexBar 返回错误' });
        return;
      }
      try {
        broadcast('usage', parseUsage(stdout));
      } catch (err) {
        broadcast('usage', { error: `无法解析 CodexBar 数据: ${err.message}` });
      }
    },
  );
}

// ---------------------------------------------------------------- USB helper

function helperPath() {
  const candidates = [
    path.join(process.resourcesPath, 'helper', 'xqz-usb-helper'),
    path.join(__dirname, 'helper', 'xqz-usb-helper'),
    path.join(__dirname, '..', 'helper', 'xqz-usb-helper'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function handleHelperLine(line) {
  helperLog.push(line);
  if (helperLog.length > 40) helperLog.shift();
  if (line.startsWith('ready')) {
    state.helperReady = true;
    setBridge('XQZ 已连线 · 准备画面');
  } else if (line.startsWith('waiting:no-device')) {
    state.helperReady = false;
    setBridge('未检测到 XQZ · 请连接 USB-C');
  } else if (line.startsWith('event:disp_off')) {
    if (state.bridgeConnected) setBridge('XQZ 屏幕待机');
  } else if (line.startsWith('event:disp_on')) {
    if (!state.bridgeConnected) setBridge('XQZ 已连线 · 准备画面');
  } else if (line.startsWith('event:flip')) {
    state.flip = !state.flip;
    broadcast('state', state);
  } else if (line.startsWith('error:show-failed') || line.startsWith('error:read-failed') || line.startsWith('error:claim-failed')) {
    state.helperReady = false;
    setBridge('XQZ 断开');
  }
}

function startHelper() {
  if (helper && !helper.killed) return;
  if (quitting) return;
  const bin = helperPath();
  if (!bin) {
    setBridge('缺少 USB helper');
    return;
  }
  helper = spawn(bin, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  helper.on('error', (err) => console.error('[xqz] helper 启动失败:', err.message));
  const onData = (chunk) => {
    String(chunk)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach(handleHelperLine);
  };
  helper.stdout.on('data', onData);
  helper.stderr.on('data', onData);
  helper.on('exit', () => {
    helper = null;
    if (quitting) return;
    state.helperReady = false;
    setBridge('未检测到 XQZ · 请连接 USB-C');
    restartTimer = setTimeout(startHelper, 2000);
  });
}

function stopHelper() {
  quitting = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (helper) {
    try { helper.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- Windows

function isXqzDisplay(display) {
  const label = String(display.label || '').toLowerCase();
  if (label.includes('moni') || label.includes('xqz')) return true;
  if (display.id === screen.getPrimaryDisplay().id) return false;
  const { width, height } = display.bounds;
  if (!width || !height) return false;
  const ratio = width / Math.max(1, height);
  // 仅当非主屏、16:9 且是小尺寸（≤1280×720 级别）时才当作物料屏，避免误套到 4K 大屏。
  return Math.abs(ratio - 16 / 9) < 0.06 && width <= 1500 && height <= 900;
}

function targetDisplay() {
  const displays = screen.getAllDisplays();
  return displays.find(isXqzDisplay) || null;
}

function createWindows() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    frame: false,
    show: false,
    transparent: false,
    backgroundColor: '#f5f8fc',
    enableLargerThanScreen: true,
    resizable: false,
    movable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') mainWindow.hide();
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  previewWindow = new BrowserWindow({
    width: 1024,
    height: 576,
    title: 'XQZ Codex Monitor',
    backgroundColor: '#f5f8fc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  previewWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  previewWindow.on('closed', () => { previewWindow = null; });
}

function setBridge(value, connected = false) {
  if (state.bridge === value && state.bridgeConnected === connected) return;
  state.bridge = value;
  state.bridgeConnected = connected;
  broadcast('state', state);
}

let mirrorNoticeAt = 0;
let primaryNoticeAt = 0;

function placeMainWindow() {
  const displays = screen.getAllDisplays();
  const target = targetDisplay();
  const primary = screen.getPrimaryDisplay();

  // 镜像检测：XQZ 若被 macOS 设为镜像，它会与主屏合并成一个 ≤1280×720 的屏。
  // 此时绝不把浮层盖到主屏，改为提醒并阻止显示，直到用户取消镜像变成独立扩展屏。
  const mirrored = state.helperReady
    && displays.length === 1
    && displays[0].bounds.width <= 1280
    && displays[0].bounds.height <= 720;
  if (mirrored) {
    if (!state.mirror) {
      state.mirror = true;
      if (Date.now() - mirrorNoticeAt > 60000) {
        mirrorNoticeAt = Date.now();
        shell.openExternal('x-apple.systempreferences:com.apple.Displays-Settings.extension');
      }
      setBridge('XQZ 镜像屏 · 请取消「镜像显示器」', false);
    }
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
    broadcast('state', state);
    return 'mirror';
  }
  if (state.mirror) { state.mirror = false; mirrorNoticeAt = 0; }

  // 主屏保护：仪表盘只投到副屏。若 XQZ 被用户设为主屏，绝不覆盖主屏，
  // 隐藏仪表盘并引导把主屏切回大屏幕，否则会挡住桌面与系统设置导致卡住。
  if (target && target.id === primary.id) {
    if (!state.primaryConflict) {
      state.primaryConflict = true;
      if (Date.now() - primaryNoticeAt > 60000) {
        primaryNoticeAt = Date.now();
        shell.openExternal('x-apple.systempreferences:com.apple.Displays-Settings.extension');
      }
      setBridge('XQZ 是主屏 · 请将主屏切回大屏', false);
      notify('XQZ 现在是主显示屏，为避免遮挡已隐藏仪表盘。请在 系统设置 → 显示器 → 排列 中把菜单栏白条拖回大屏幕。');
    }
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
    broadcast('state', state);
    return 'primary';
  }
  if (state.primaryConflict) { state.primaryConflict = false; primaryNoticeAt = 0; }

  if (!target) {
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
    if (state.helperReady) setBridge('XQZ 已连线 · 准备画面', false);
    broadcast('state', state);
    return 'no-display';
  }
  const bounds = target.bounds;
  setBridge('XQZ 已连接 · 显示中', true);
  if (!mainWindow) return 'hidden';
  mainWindow.setBounds(bounds);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.showInactive();
  return 'placed';
}

function notify(body) {
  try {
    new Notification({ title: 'XQZ Codex Monitor', body, silent: true }).show();
  } catch { /* ignore */ }
}

function showPreview() {
  if (previewWindow) {
    previewWindow.show();
    previewWindow.focus();
  }
}

// ---------------------------------------------------------------- Diagnostics

function systemProfilerSpan(flags) {
  return new Promise((resolve) => {
    execFile('/usr/sbin/system_profiler', [...flags, '-detailLevel', 'mini'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? `（system_profiler 失败: ${err.message}）` : stdout);
    });
  });
}

function mirrorWarnings(displayReport) {
  const warnings = [];
  const lines = displayReport.split('\n');
  const moniIndex = lines.findIndex((l) => /Moni Extende|XQZ/i.test(l));
  if (moniIndex >= 0) {
    const block = lines.slice(moniIndex, moniIndex + 12).join('\n');
    if (/(^|\n)\s+Mirror: On/i.test(block)) {
      warnings.push('XQZ 正在和主屏「镜像显示」，需要取消镜像：系统设置 → 显示器 → 排列，取消勾选“镜像显示器”。');
    }
    const res = block.match(/Resolution:\s*(\d+)/);
    if (res && res[1] !== '1280') {
      warnings.push(`XQZ 当前分辨率 ${res[1]}×…，需设为 1280×720 以获得最佳显示。`);
    }
  }
  return warnings;
}

function showDiagnostics() {
  Promise.all([
    systemProfilerSpan(['SPUSBDataType']),
    systemProfilerSpan(['SPDisplaysDataType']),
  ]).then(([usbReport, displayReport]) => {
    const usbOk = /XQZ-IV01/.test(usbReport);
    const screens = screen.getAllDisplays().map((d) => `  - "${d.label || d.id || '?'}" ${d.bounds.width}×${d.bounds.height}@(${d.bounds.x},${d.bounds.y})${d.id === screen.getPrimaryDisplay().id ? ' [主屏]' : ''}`).join('\n');
    const warnings = mirrorWarnings(displayReport);
    const lines = [
      'XQZ-IV01 USB 设备：' + (usbOk ? '已检测到（0x054C:0x0E48）' : '未检测到'),
      '',
      '系统显示器列表：',
      screens || '  （无）',
      '',
      'macOS 显示器详情（摘要）：',
      ...displayReport.split('\n').slice(0, 60),
      '',
      'USB helper 日志（最近）：',
      ...(helperLog.length ? helperLog.slice(-12).map((l) => `  ${l}`) : ['  （helper 未启动）']),
      '',
      'CodexBar CLI：' + (cliPath() ? '可用' : '未找到'),
    ];
    if (warnings.length) lines.unshift('⚠️ ' + warnings.join('\n⚠️ '));
    const win = new BrowserWindow({
      width: 620,
      height: 560,
      title: 'XQZ Codex Monitor 诊断',
      backgroundColor: '#f5f8fc',
      webPreferences: { contextIsolation: true },
    });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
       body{margin:0;font:13px/1.55 -apple-system,"PingFang SC",sans-serif;background:#f5f8fc;color:#122640}
       pre{white-space:pre-wrap;word-break:break-word;padding:16px}
       </style></head><body><pre>${lines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body></html>`));
    win.show();
  });
}

// ---------------------------------------------------------------- Tray

let currentTab = 'codex';
const TABS = ['codex', 'sys', 'net'];
const TAB_LABELS = ['Codex 额度', 'Mac 系统', '网络 & IP'];

function buildTrayMenu() {
  const switchMenu = Menu.buildFromTemplate(
    TABS.map((name, i) => ({
      label: TAB_LABELS[i],
      type: 'radio',
      checked: currentTab === name,
      click: () => broadcast('tab', name),
    })),
  );
  return Menu.buildFromTemplate([
    {
      label: '显示到 XQZ',
      click: () => {
        const result = placeMainWindow();
        if (result === 'no-display') notify('未检测到 XQZ 外接屏：请用 USB-C 线连接 XQZ 的 INPUT 口，保持 App 运行。');
        else if (result === 'mirror') notify('XQZ 正在镜像主屏：请到系统设置 → 显示器 → 排列，取消勾选“镜像显示器”。');
        else if (result === 'primary') notify('XQZ 现在是主屏，仪表盘已隐藏。系统设置 → 显示器 → 排列，把菜单栏白条拖回大屏幕。');
      },
    },
    { label: '隐藏 XQZ 显示', click: () => { if (mainWindow) mainWindow.hide(); } },
    { label: '主屏预览', click: () => showPreview() },
    { label: '切换页面', submenu: switchMenu },
    { label: '刷新额度', click: () => refreshUsage() },
    { label: '刷新外网 IP', click: () => externalInfo() },
    { type: 'separator' },
    { label: '诊断…', click: () => showDiagnostics() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'iconTemplate.png'));
  tray = new Tray(icon.isEmpty()
    ? nativeImage.createEmpty()
    : icon.resize({ width: 18, height: 18 }));
  tray.setToolTip('XQZ Codex Monitor');
  tray.setContextMenu(buildTrayMenu());
}

// ---------------------------------------------------------------- IPC / main

function broadcast(channel, payload) {
  for (const win of [mainWindow, previewWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

ipcMain.on('open-displays', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.Displays-Settings.extension');
});
ipcMain.on('hide-dashboard', () => {
  if (mainWindow) mainWindow.hide();
});
ipcMain.on('refresh-external', () => {
  externalInfo();
});
ipcMain.on('tab-changed', (_event, name) => {
  if (typeof name === 'string' && TABS.includes(name) && currentTab !== name) {
    currentTab = name;
    if (tray) tray.setContextMenu(buildTrayMenu());
  }
});

app.on('will-quit', () => {
  if (globalShortcut) globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();
  createWindows();
  createTray();
  startHelper();
  refreshUsage();
  setInterval(() => refreshUsage(), 60_000);
  setInterval(() => {
    if (mainWindow && !state.bridgeConnected) placeMainWindow();
  }, 2000);
  placeMainWindow();
  screen.on('display-added', () => placeMainWindow());
  screen.on('display-removed', () => placeMainWindow());
  screen.on('display-metrics-changed', () => placeMainWindow());

  detectInterface().then(() => {
    tickSystem();
    externalInfo();
  });
  setInterval(() => tickSystem(), 1000);
  setInterval(() => externalInfo(), 5 * 60 * 1000);

  globalShortcut.register('Command+Shift+X', () => { if (mainWindow) mainWindow.hide(); });
  globalShortcut.register('Command+Shift+S', () => placeMainWindow());
});

app.on('before-quit', () => stopHelper());