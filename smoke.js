'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

const errors = [];

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 640,
    height: 80,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(`console[${level}]: ${message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    errors.push(`did-fail-load ${code}: ${desc}`);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html')).then(() => {
    const usage = {
      provider: 'codex', source: 'oauth', plan: 'Codex Pro',
      sessionUsed: 35, weeklyUsed: 62,
      sessionReset: new Date(Date.now() + 7200e3).toISOString(),
      weeklyReset: new Date(Date.now() + 5 * 86400e3).toISOString(),
      codeReviewRemaining: 64, resetCredits: 2, creditsRemaining: 76.5,
      updatedAt: new Date().toISOString(),
      daily: Array.from({ length: 14 }, (_, i) => ({
        day: `2026-09-${String(i + 1).padStart(2, '0')}`,
        credits: 5 + ((i * 7) % 40),
      })),
    };
    const state = { bridge: 'XQZ 已连接', bridgeConnected: true, flip: false, mirror: false, helperReady: true };
    const sys = {
      cpu: { usage: 23.4, cores: 10, model: 'Apple M4' },
      load: [1.2, 0.9, 0.7],
      mem: { total: 17179869184, used: 9663676416, free: 2155872256, active: 4294967296, wired: 3221225472, compressed: 1073741824 },
      disk: { total: 500107862016, used: 214748364800, free: 285359497216 },
      net: { down: 12500000, up: 3125000, iface: 'en1', historyDown: Array.from({ length: 40 }, (_, i) => 3e6 + i * 2e5), historyUp: Array.from({ length: 40 }, () => 1e6) },
      host: { name: 'younde-mac', release: '24.6.0', arch: 'arm64', uptime: 175200 },
      sampledAt: Date.now(),
    };
    const ext = {
      ip: '8.216.57.27', isp: 'Alibaba (US)', org: 'Alibaba.com', country: 'Japan',
      countryCode: 'JP', region: 'Tokyo', city: 'Tokyo', timezone: 'Asia/Tokyo',
      status: 'success', fetchedAt: Date.now(),
      lan: { iface: 'en1', ip: '192.168.110.89', gateway: '192.168.110.1', dns: '192.168.110.1', ssid: '' },
      host: { name: 'younde-mac' },
    };
    win.webContents.send('usage', usage);
    win.webContents.send('state', state);
    win.webContents.send('sys', sys);
    win.webContents.send('ext', ext);
    return win.webContents.executeJavaScript(
      `new Promise(r => setTimeout(() => r({
        remain5h: document.getElementById('r5h').textContent,
        remainWeek: document.getElementById('rweek').textContent,
        pill: document.getElementById('pill-text').textContent,
        subtitle: document.getElementById('subtitle').textContent,
        trendNodes: document.getElementById('trend').children.length,
        cpuPct: document.getElementById('cpuPct').textContent,
        memUsed: document.getElementById('memUsed').textContent,
        diskFree: document.getElementById('diskFree').textContent,
        netDown: document.getElementById('netDown').textContent,
        netSparkNodes: document.getElementById('netSpark').children.length,
        extIp: document.getElementById('extIp').textContent,
        extGeo: document.getElementById('extGeo').textContent,
        lanIp: document.getElementById('lanIp').textContent,
        tabs: document.querySelectorAll('.tab').length,
      })), 900)`,
    );
  }).then((result) => {
    console.log('DOM_RESULT ' + JSON.stringify(result, null, 0));
    if (errors.length) {
      console.error('RENDERER_ERRORS\n' + errors.join('\n'));
      app.exit(1);
    } else {
      app.exit(0);
    }
  }).catch((err) => {
    console.error('SMOKE_FAIL: ' + err.message);
    app.exit(1);
  });
});