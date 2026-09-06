'use strict';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

let current = null;
let currentSys = null;
let currentExt = null;

// ---------------------------------------------------------------- scale

function resize() {
  const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  $('viewport').style.transform = `scale(${scale})`;
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- helpers

const pad = (n) => String(n).padStart(2, '0');

function isoDate(value) {
  return value ? new Date(value) : null;
}

function timeHMS(date) {
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : '--';
}

function resetText(date) {
  if (!date) return '重置 --';
  const seconds = Math.max(0, (date.getTime() - Date.now()) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟后`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分后`;
  return `${Math.floor(seconds / 86400)} 天 ${Math.floor((seconds % 86400) / 3600)} 小时后`;
}

function shortDay(day) {
  return day && day.length >= 10 ? `${day.slice(5, 7)}/${day.slice(8, 10)}` : '--';
}

function colorForUsage(used) {
  return used >= 90 ? '#e5484d' : used >= 70 ? '#f29139' : '#2f74eb';
}

function fmtBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '--';
  const b = Math.max(0, bytes);
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
}

function rateParts(bytesPerSecond) {
  const bits = Math.max(0, bytesPerSecond || 0) * 8;
  if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2).replace(/\.?0+$/, ''), unit: 'Gb/s' };
  if (bits >= 1e6) return { value: (bits / 1e6).toFixed(2).replace(/\.?0+$/, ''), unit: 'Mb/s' };
  if (bits >= 1e3) return { value: (bits / 1e3).toFixed(1), unit: 'Kb/s' };
  return { value: String(Math.round(bits)), unit: 'b/s' };
}

function fmtRate(bytesPerSecond) {
  const p = rateParts(bytesPerSecond);
  return `${p.value} ${p.unit}`;
}

function fmtUptime(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '--';
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
}

function macVersion(release) {
  const m = String(release || '').match(/^(\d+)\.(\d+)/);
  if (!m) return release || '--';
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return `macOS ${major - 4}.${minor}`;
}

function svgEl(name, attrs) {
  const el = document.createElementNS(NS, name);
  for (const key in attrs) el.setAttribute(key, String(attrs[key]));
  return el;
}

// ---------------------------------------------------------------- tabs

function switchTab(name) {
  if (!['codex', 'sys', 'net'].includes(name)) return;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  window.monitor.setTab(name);
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

window.addEventListener('keydown', (e) => {
  const active = document.querySelector('.tab.active');
  const tabs = ['codex', 'sys', 'net'];
  let current = active ? tabs.indexOf(active.dataset.tab) : 0;
  if (e.key === 'ArrowRight') { current = (current + 1) % tabs.length; switchTab(tabs[current]); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { current = (current - 1 + tabs.length) % tabs.length; switchTab(tabs[current]); e.preventDefault(); }
  else if (['1', '2', '3'].includes(e.key)) { switchTab(tabs[Number(e.key) - 1]); }
});

// ---------------------------------------------------------------- usage (Codex)

function renderQuota(idPrefix, used, broken) {
  const color = colorForUsage(used);
  const usedPct = Math.max(0, Math.min(100, used));
  const remain = Math.max(0, 100 - usedPct);
  const remainEl = $(`r${idPrefix}`);
  const usedEl = $(`u${idPrefix}`);
  const fillEl = $(`f${idPrefix}`);
  if (broken) {
    remainEl.textContent = '暂无数据';
    remainEl.style.color = '#677b93';
    usedEl.textContent = '已用 --';
    usedEl.style.color = '#677b93';
    fillEl.style.width = '0';
    fillEl.style.background = '#e5ecf4';
  } else {
    remainEl.textContent = `剩余 ${Math.round(remain)}%`;
    remainEl.style.color = color;
    usedEl.textContent = `已用 ${Math.round(usedPct)}%`;
    usedEl.style.color = color;
    fillEl.style.width = `${usedPct}%`;
    fillEl.style.background = color;
  }
}

function renderTrend(daily, broken) {
  const svg = $('trend');
  svg.innerHTML = '';
  const W = 780;
  const H = 300;
  const P = { l: 12, r: 12, t: 10, b: 24 };
  const values = (daily || []).map((row) => Number(row.credits) || 0);
  if (broken || values.length === 0) {
    const text = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#677b93', 'font-size': '24', 'font-weight': 600, 'font-family': '-apple-system, "PingFang SC", sans-serif' });
    text.textContent = broken ? '等待 CodexBar' : '等待历史数据';
    svg.append(text);
    $('axis-left').textContent = '--';
    $('axis-right').textContent = '--';
    $('axis-peak').textContent = '--';
    return;
  }
  for (let i = 0; i <= 3; i++) {
    const y = P.t + (H - P.t - P.b) * (i / 3);
    svg.append(svgEl('line', { x1: P.l, y1: y, x2: W - P.r, y2: y, stroke: '#e5ecf4', 'stroke-width': 1 }));
  }
  const maximum = Math.max(1, ...values) * 1.12;
  const n = values.length;
  const points = values.map((value, index) => {
    const x = n === 1 ? W / 2 : P.l + (W - P.l - P.r) * (index / (n - 1));
    const y = P.t + (H - P.t - P.b) * (1 - Math.min(1, value / maximum));
    return [x, y];
  });
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i][0]} ${points[i][1]}`;
  svg.append(svgEl('path', { d, fill: 'none', stroke: '#2f74eb', 'stroke-width': 4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const last = points[points.length - 1];
  svg.append(svgEl('circle', { cx: last[0], cy: last[1], r: 8, fill: '#2f74eb' }));
  $('axis-left').textContent = shortDay(daily[0] && daily[0].day);
  $('axis-right').textContent = shortDay(daily[n - 1] && daily[n - 1].day);
  $('axis-peak').textContent = `峰值 ${(maximum / 1.12).toFixed(1)}`;
}

function live() {
  const u = current;
  if (!u) return;
  $('s5h').textContent = resetText(isoDate(u.sessionReset));
  $('sweek').textContent = resetText(isoDate(u.weeklyReset));
  $('up5h').textContent = `更新 ${timeHMS(isoDate(u.updatedAt))}`;
  $('upweek').textContent = `更新 ${timeHMS(isoDate(u.updatedAt))}`;
}

function applyUsage(payload) {
  current = payload;
  const broken = Boolean(payload.error);

  $('banner').style.display = broken ? 'block' : 'none';
  $('banner').textContent = broken ? payload.error : '';

  renderQuota('5h', Number(payload.sessionUsed) || 0, broken);
  renderQuota('week', Number(payload.weeklyUsed) || 0, broken);
  renderTrend(payload.daily, broken);

  $('review').textContent = payload.codeReviewRemaining != null
    ? `剩余 ${Math.round(payload.codeReviewRemaining)}%`
    : '暂无数据';

  $('resetCredits').textContent = `可用 ${payload.resetCredits || 0} 次`;
  $('extraCredits').textContent = payload.creditsRemaining != null
    ? Number(payload.creditsRemaining).toFixed(1)
    : '--';

  $('subtitle').textContent = `数据来自 CodexBar · ${payload.plan || 'Codex'} · ${String(payload.source || '--').toUpperCase()}`;
  live();
}

// ---------------------------------------------------------------- 系统视图

function drawSpark(svg, series, color) {
  svg.innerHTML = '';
  const W = 620;
  const H = 110;
  const values = (series || []).map((v) => Math.max(0, Number(v) || 0));
  if (values.length < 2) {
    const text = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#9aa9bd', 'font-size': '16', 'font-family': '-apple-system, "PingFang SC", sans-serif' });
    text.textContent = '采集中…';
    svg.append(text);
    return;
  }
  const maximum = Math.max(1, ...values) * 1.12;
  const n = values.length;
  const points = values.map((value, index) => {
    const x = (W * index) / (n - 1);
    const y = H - (H - 6) * Math.min(1, value / maximum);
    return [x, y];
  });
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i][0]} ${points[i][1]}`;
  svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

function renderSys(p) {
  if (!p || !p.cpu) return;
  const cpu = Math.max(0, Math.min(100, p.cpu.usage));

  $('cpuPct').textContent = cpu.toFixed(1);
  $('cpuBar').style.width = `${cpu}%`;
  $('cpuBar').style.background = colorForUsage(cpu);
  $('cpuCores').textContent = `${p.cpu.cores} 核 · 负载 ${(p.load || [0, 0, 0]).map((x) => x.toFixed(2)).join(' / ')}`;
  $('loadAvg').textContent = `主机 ${p.host && p.host.name || '--'}`;
  $('cpuModel').textContent = p.cpu.model.split(' @')[0] || '--';

  if (p.mem) {
    const memPct = (p.mem.used / Math.max(1, p.mem.total)) * 100;
    $('memPct').textContent = memPct.toFixed(0);
    $('memBar').style.width = `${memPct}%`;
    $('memBar').style.background = colorForUsage(memPct);
    $('memUsed').textContent = `${fmtBytes(p.mem.used)} / ${fmtBytes(p.mem.total)}`;
    $('memBreakdown').textContent = `活动 ${fmtBytes(p.mem.active)} · 有线 ${fmtBytes(p.mem.wired)} · 压缩 ${fmtBytes(p.mem.compressed)} · 释放 ${fmtBytes(p.mem.free)}`;
  }

  if (p.disk) {
    const diskPct = (p.disk.used / Math.max(1, p.disk.total)) * 100;
    $('diskUsed').textContent = `使用 ${fmtBytes(p.disk.used)}`;
    $('diskPct').textContent = `${diskPct.toFixed(1)}%`;
    $('diskBar').style.width = `${diskPct}%`;
    $('diskBar').style.background = colorForUsage(diskPct);
    $('diskFree').textContent = `可用 ${fmtBytes(p.disk.free)} / 共 ${fmtBytes(p.disk.total)}`;
    $('diskFooter').textContent = `${macVersion(p.host && p.host.release)} · ${p.host && p.host.arch} · 已运行 ${fmtUptime(p.host && p.host.uptime)}`;
  }

  if (p.net) {
    $('netDown').textContent = fmtRate(p.net.down);
    $('netUp').textContent = fmtRate(p.net.up);
    $('netIface').textContent = `接口 ${p.net.iface || '--'}`;
    drawSpark($('netSpark'), p.net.historyDown, '#2f74eb');
  }
}

// ---------------------------------------------------------------- 网络视图

function renderExt(p) {
  if (!p) return;
  $('extIp').textContent = p.ip || '--';
  $('extIsp').textContent = p.isp ? `ISP ${p.isp}` : 'ISP --';
  $('extOrg').textContent = p.org || p.as || '';
  const geo = [p.city, p.region, p.country].filter(Boolean).join(' · ');
  $('extGeo').textContent = geo || '位置 --';
  $('extTimezone').textContent = p.timezone || '';
  $('extStatus').textContent = p.status || '';
  $('extStatus').style.color = p.ip ? '#1bb17d' : '#e5484d';
  const when = p.fetchedAt ? `${timeHMS(new Date(p.fetchedAt))}` : '未获取';
  $('extTime').textContent = `获取于 ${when}`;
  $('extFootAt').textContent = `最近更新 ${when}`;

  if (p.lan) {
    $('lanIp').textContent = p.lan.ip || '--';
    $('lanIface').textContent = p.lan.iface || '';
    $('lanHost').textContent = p.host && p.host.name || '--';
    $('lanGw').textContent = p.lan.gateway ? `网关 ${p.lan.gateway}` : '网关 --';
    $('dnsList').textContent = p.lan.dns || '--';
    $('ssidList').textContent = p.lan.ssid || '（非 Wi-Fi 连接）';
  }
}

// ---------------------------------------------------------------- state

function applyState(payload) {
  const pill = $('pill');
  pill.classList.toggle('on', Boolean(payload.bridgeConnected));
  $('pill-text').textContent = payload.bridge || '未检测到 XQZ';
  document.body.style.transform = payload.flip ? 'scaleX(-1)' : '';
  const guide = $('mirror-guide');
  if (guide) guide.hidden = !payload.mirror;
  const primaryGuide = $('primary-guide');
  if (primaryGuide) primaryGuide.hidden = !payload.primaryConflict;
}

// ---------------------------------------------------------------- wiring

window.monitor.onUsage(applyUsage);
window.monitor.onState(applyState);
window.monitor.onSys((p) => { currentSys = p; renderSys(p); });
window.monitor.onExt((p) => { currentExt = p; renderExt(p); });
window.monitor.onTab(switchTab);
setInterval(live, 30_000);

$('refreshExt').addEventListener('click', () => { window.monitor.refreshExternal(); });
$('mirror-help').addEventListener('click', () => window.monitor.openDisplaysSettings());
$('mirror-close').addEventListener('click', () => { $('mirror-guide').hidden = true; });
$('primary-help').addEventListener('click', () => window.monitor.openDisplaysSettings());
$('primary-close').addEventListener('click', () => { $('primary-guide').hidden = true; });