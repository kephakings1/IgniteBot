const express = require("express");
const router = express.Router();
const analytics = require("../lib/analytics");
const { getProducts } = require("../lib/store");
const { getAllBookings } = require("../lib/booking");
const { getBroadcastHistory } = require("../lib/broadcast");

router.get("/dashboard", (req, res) => {
  const tab = req.query.tab || "overview";
  res.send(getDashboardHTML(tab));
});

router.get("/api/stats", async (req, res) => {
  const stats = await analytics.getStats();
  const topCommands = await analytics.getTopCommands(10);
  const hourly = await analytics.getHourlyChart();
  res.json({ stats, topCommands, hourly });
});

router.get("/api/products", (req, res) => {
  res.json(getProducts());
});

router.get("/api/bookings", (req, res) => {
  res.json(getAllBookings().slice(0, 20));
});

router.get("/api/broadcasts", (req, res) => {
  res.json(getBroadcastHistory());
});

function getDashboardHTML(activeTab) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IgniteBot Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 32px;display:flex;align-items:center;gap:12px}
.header h1{font-size:1.4rem;color:#58a6ff;flex:1}
.header .status{font-size:0.8rem;background:#1f6feb;color:#fff;border-radius:12px;padding:3px 10px}
.tabs{background:#161b22;border-bottom:1px solid #30363d;display:flex;gap:0;padding:0 32px}
.tab{padding:12px 20px;font-size:0.9rem;color:#8b949e;cursor:pointer;border-bottom:3px solid transparent;text-decoration:none;display:inline-block;transition:color .2s}
.tab:hover{color:#e6edf3}
.tab.active{color:#58a6ff;border-bottom-color:#58a6ff;font-weight:600}
.container{max-width:1200px;margin:0 auto;padding:24px 32px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px}
.card h3{font-size:0.78rem;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.card .value{font-size:2rem;font-weight:700;color:#58a6ff}
.card .sub{font-size:0.8rem;color:#8b949e;margin-top:4px}
.section{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:20px}
.section h2{font-size:1rem;color:#e6edf3;margin-bottom:16px;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:0.78rem;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;padding:8px 12px;border-bottom:1px solid #30363d}
td{padding:10px 12px;border-bottom:1px solid #21262d;font-size:0.9rem}
tr:last-child td{border-bottom:none}
.bar{height:8px;background:#1f6feb;border-radius:4px;margin-top:4px}
.badge{display:inline-block;padding:2px 8px;border-radius:8px;font-size:0.75rem;font-weight:600}
.badge.confirmed{background:#1a3a2a;color:#3fb950}
.badge.pending{background:#3a2f0b;color:#d29922}
.badge.cancelled{background:#3a1a1a;color:#f85149}
.refresh{font-size:0.8rem;color:#8b949e}
/* Session ID tab */
.sid-wrap{background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:20px;margin-bottom:20px;position:relative}
.sid-label{font-size:0.75rem;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.sid-box{background:#010409;border:1px solid #30363d;border-radius:8px;padding:16px 14px;font-family:monospace;font-size:0.78rem;color:#58a6ff;word-break:break-all;max-height:120px;overflow-y:auto;line-height:1.5;user-select:all;cursor:text}
.sid-actions{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.btn{padding:8px 18px;border-radius:8px;border:none;cursor:pointer;font-size:0.85rem;font-weight:600;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-blue{background:#1f6feb;color:#fff}
.btn-green{background:#238636;color:#fff}
.btn-gray{background:#21262d;color:#e6edf3;border:1px solid #30363d}
.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot-green{background:#3fb950}
.dot-red{background:#f85149}
.dot-yellow{background:#d29922}
.info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:20px}
.info-item{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px}
.info-item .label{font-size:0.75rem;color:#8b949e;text-transform:uppercase;margin-bottom:6px}
.info-item .val{font-size:1.1rem;font-weight:600}
.steps{counter-reset:step}
.step{display:flex;gap:14px;margin-bottom:16px;align-items:flex-start}
.step-num{background:#1f6feb;color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:700;flex-shrink:0;margin-top:2px}
.step-text{font-size:0.9rem;color:#e6edf3;line-height:1.5}
.step-text code{background:#21262d;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:0.82rem;color:#79c0ff}
.toast{position:fixed;bottom:24px;right:24px;background:#238636;color:#fff;padding:10px 20px;border-radius:8px;font-size:0.85rem;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999}
.toast.show{opacity:1}
</style>
</head>
<body>
<div class="header">
  <span style="font-size:1.5rem">⚡</span>
  <h1>IgniteBot Dashboard</h1>
  <span class="status" id="connBadge">LIVE</span>
  <span class="refresh" id="lastUpdate"></span>
</div>

<div class="tabs">
  <a class="tab ${activeTab === "overview" ? "active" : ""}" href="/dashboard?tab=overview">📊 Overview</a>
  <a class="tab ${activeTab === "session" ? "active" : ""}" href="/dashboard?tab=session">🔑 Session ID</a>
</div>

<div class="container">

<!-- OVERVIEW TAB -->
<div id="tabOverview" style="display:${activeTab === "overview" ? "block" : "none"}">
  <div class="grid" id="statsGrid">
    <div class="card"><h3>📨 Total Messages</h3><div class="value" id="totalMessages">-</div><div class="sub">All time</div></div>
    <div class="card"><h3>⚙️ Commands Used</h3><div class="value" id="totalCommands">-</div><div class="sub">All time</div></div>
    <div class="card"><h3>👥 Unique Users</h3><div class="value" id="uniqueUsers">-</div><div class="sub">Distinct contacts</div></div>
    <div class="card"><h3>⏱ Uptime</h3><div class="value" id="uptime">-</div><div class="sub">Minutes running</div></div>
  </div>

  <div class="section">
    <h2>📈 Activity (Last 24 Hours)</h2>
    <div id="chartBars" style="display:flex;gap:4px;align-items:flex-end;height:60px;margin-top:8px"></div>
    <div id="chartLabels" style="display:flex;gap:4px;margin-top:4px;font-size:0.7rem;color:#8b949e"></div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
    <div class="section">
      <h2>🏆 Top Commands</h2>
      <table>
        <thead><tr><th>Command</th><th>Uses</th><th>Bar</th></tr></thead>
        <tbody id="commandTable"></tbody>
      </table>
    </div>
    <div class="section">
      <h2>🕐 Recent Activity</h2>
      <table>
        <thead><tr><th>Time</th><th>User</th><th>Action</th></tr></thead>
        <tbody id="activityTable"></tbody>
      </table>
    </div>
  </div>

  <div class="section" style="margin-top:20px">
    <h2>📅 Recent Bookings</h2>
    <table>
      <thead><tr><th>#</th><th>Service</th><th>Date</th><th>Time</th><th>Status</th></tr></thead>
      <tbody id="bookingsTable"></tbody>
    </table>
  </div>

  <div class="section" style="margin-top:20px">
    <h2>📢 Broadcast History</h2>
    <table>
      <thead><tr><th>Message</th><th>Sent</th><th>Failed</th><th>Time</th></tr></thead>
      <tbody id="broadcastTable"></tbody>
    </table>
  </div>
</div>

<!-- SESSION ID TAB -->
<div id="tabSession" style="display:${activeTab === "session" ? "block" : "none"}">
  <div class="info-grid" id="sessionInfoGrid">
    <div class="info-item">
      <div class="label">Status</div>
      <div class="val" id="sConnected"><span class="status-dot dot-yellow"></span>Checking...</div>
    </div>
    <div class="info-item">
      <div class="label">Phone Number</div>
      <div class="val" id="sPhone">—</div>
    </div>
    <div class="info-item">
      <div class="label">Session Format</div>
      <div class="val" style="color:#3fb950">Universal (any Baileys bot)</div>
    </div>
  </div>

  <div class="section">
    <h2>🔑 Your Session ID</h2>
    <p style="font-size:0.85rem;color:#8b949e;margin-bottom:16px">
      This is your bot's session ID in <strong style="color:#58a6ff">NEXUS-MD</strong> format.
      Copy and save it — paste it as the <code style="background:#21262d;padding:2px 6px;border-radius:4px;font-family:monospace">SESSION_ID</code>
      environment variable on Heroku, Railway, Render or Replit to keep your bot online.
    </p>

    <div class="sid-wrap">
      <div class="sid-label">Session ID (NEXUS-MD format)</div>
      <div class="sid-box" id="sessionIdBox">⏳ Loading session...</div>
      <div class="sid-actions">
        <button class="btn btn-blue" onclick="copySID()">📋 Copy Session ID</button>
        <button class="btn btn-gray" onclick="refreshSID()">🔄 Refresh</button>
        <a class="btn btn-green" href="/session" target="_blank">🔗 Pairing Page</a>
      </div>
    </div>

    <div class="section" style="background:#0d1117;border-color:#21262d">
      <h2 style="font-size:0.9rem;margin-bottom:14px">📖 How to use your Session ID</h2>
      <div class="steps">
        <div class="step"><div class="step-num">1</div><div class="step-text">Click <strong>Copy Session ID</strong> above to copy the full <code>NEXUS-MD:~...</code> string</div></div>
        <div class="step"><div class="step-num">2</div><div class="step-text"><strong>Heroku:</strong> Go to your app → Settings → Config Vars → add <code>SESSION_ID</code> and paste</div></div>
        <div class="step"><div class="step-num">3</div><div class="step-text"><strong>Railway / Render:</strong> Go to Variables → add <code>SESSION_ID</code> and paste</div></div>
        <div class="step"><div class="step-num">4</div><div class="step-text"><strong>Replit:</strong> Go to Secrets → add <code>SESSION_ID</code> and paste. On the next restart the bot will auto-connect without scanning</div></div>
        <div class="step"><div class="step-num">5</div><div class="step-text"><strong>Universal support:</strong> Any valid Baileys session is accepted — <code>NEXUS-MD</code>, raw JSON, base64, a Pastebin/GitHub Gist URL, or sessions from other Baileys-based bots</div></div>
        <div class="step"><div class="step-num">6</div><div class="step-text"><strong>Load from URL:</strong> POST <code>/session/url</code> with <code>{"{"} "url": "https://..." {"}"}</code> to load a session from any public URL</div></div>
      </div>
    </div>

    <div class="section" style="background:#0d1117;border-color:#21262d;margin-top:16px">
      <h2 style="font-size:0.9rem;margin-bottom:10px">🔌 Load session from a URL</h2>
      <p style="font-size:0.8rem;color:#8b949e;margin-bottom:12px">Paste any public URL that returns session data (Pastebin, GitHub Gist, direct file link, API endpoint, etc.)</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="sessionUrlInput" type="url" placeholder="https://pastebin.com/XxXxXx  or  https://gist.github.com/..." style="flex:1;min-width:200px;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 12px;color:#c9d1d9;font-size:0.85rem" />
        <button class="btn btn-blue" onclick="loadSessionFromUrl()">📡 Load</button>
      </div>
      <div id="sessionUrlResult" style="margin-top:8px;font-size:0.8rem;color:#8b949e"></div>
    </div>
  </div>
</div>

</div><!-- /container -->

<div class="toast" id="toast"></div>

<script>
function toast(msg, color) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = color || '#238636';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ---- SESSION TAB ----
let currentSID = null;
async function loadSession() {
  try {
    const r = await fetch('/api/session');
    const d = await r.json();
    currentSID = d.sessionId;
    const box = document.getElementById('sessionIdBox');
    if (d.sessionId) {
      box.textContent = d.sessionId;
    } else {
      box.textContent = '⏳ Session not ready — pair the bot first then refresh.';
      box.style.color = '#d29922';
    }
    const connEl = document.getElementById('sConnected');
    if (d.connected) {
      connEl.innerHTML = '<span class="status-dot dot-green"></span>Connected';
    } else {
      connEl.innerHTML = '<span class="status-dot dot-red"></span>Disconnected';
    }
    const phoneEl = document.getElementById('sPhone');
    phoneEl.textContent = d.phone ? '+' + d.phone.replace('@s.whatsapp.net','').replace(':','') : '—';

    const badge = document.getElementById('connBadge');
    if (badge) {
      badge.textContent = d.connected ? 'ONLINE' : 'OFFLINE';
      badge.style.background = d.connected ? '#238636' : '#b62324';
    }
  } catch(e) {
    document.getElementById('sessionIdBox').textContent = '❌ Error loading session.';
  }
}

function copySID() {
  if (!currentSID) { toast('No session yet — pair the bot first', '#b62324'); return; }
  navigator.clipboard.writeText(currentSID)
    .then(() => toast('✅ Session ID copied!'))
    .catch(() => {
      const box = document.getElementById('sessionIdBox');
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      toast('Select & copy the text above manually', '#d29922');
    });
}

function refreshSID() { loadSession(); toast('🔄 Refreshed', '#1f6feb'); }

async function loadSessionFromUrl() {
  const input = document.getElementById('sessionUrlInput');
  const result = document.getElementById('sessionUrlResult');
  const url = (input.value || '').trim();
  if (!url) { result.textContent = '⚠️ Please enter a URL first.'; result.style.color='#d29922'; return; }
  result.textContent = '⏳ Loading...'; result.style.color='#8b949e';
  try {
    const r = await fetch('/session/url', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ url }) });
    const d = await r.json();
    if (d.ok) {
      result.textContent = '✅ ' + d.message;
      result.style.color = '#3fb950';
      toast('✅ Session loaded from URL!', '#238636');
      setTimeout(loadSession, 2000);
    } else {
      result.textContent = '❌ ' + (d.error || 'Unknown error');
      result.style.color = '#f85149';
    }
  } catch(e) {
    result.textContent = '❌ Network error: ' + e.message;
    result.style.color = '#f85149';
  }
}

// ---- OVERVIEW TAB ----
async function loadOverview() {
  try {
    const [stats, bookings, broadcasts] = await Promise.all([
      fetch('/api/stats').then(r=>r.json()),
      fetch('/api/bookings').then(r=>r.json()),
      fetch('/api/broadcasts').then(r=>r.json()),
    ]);

    const s = stats.stats;
    const uptime = Math.floor((Date.now() - new Date(s.startTime).getTime()) / 60000);
    document.getElementById('totalMessages').textContent = s.totalMessages || 0;
    document.getElementById('totalCommands').textContent = s.totalCommands || 0;
    document.getElementById('uniqueUsers').textContent = (s.uniqueUsers||[]).length;
    document.getElementById('uptime').textContent = uptime;
    document.getElementById('lastUpdate').textContent = 'Updated: ' + new Date().toLocaleTimeString();

    const topCmds = stats.topCommands;
    const maxVal = topCmds.length ? topCmds[0][1] : 1;
    const cmdHtml = topCmds.map(([cmd,count]) =>
      \`<tr><td>\${cmd}</td><td><b>\${count}</b></td><td><div class="bar" style="width:\${(count/maxVal*100)}%"></div></td></tr>\`
    ).join('');
    document.getElementById('commandTable').innerHTML = cmdHtml || '<tr><td colspan="3" style="color:#8b949e">No commands yet</td></tr>';

    const recent = (s.recentActivity||[]).slice(0,10);
    const actHtml = recent.map(a =>
      \`<tr><td style="color:#8b949e">\${new Date(a.time).toLocaleTimeString()}</td><td>\${a.user}</td><td>\${a.action}</td></tr>\`
    ).join('');
    document.getElementById('activityTable').innerHTML = actHtml || '<tr><td colspan="3" style="color:#8b949e">No activity yet</td></tr>';

    const hourly = stats.hourly;
    const maxH = hourly.length ? Math.max(...hourly.map(h=>h[1]),1) : 1;
    const bars = document.getElementById('chartBars');
    const labels = document.getElementById('chartLabels');
    bars.innerHTML = hourly.map(([h,c]) =>
      \`<div style="flex:1;background:#1f6feb;height:\${Math.max(4,(c/maxH)*56)}px;border-radius:4px 4px 0 0" title="\${h}: \${c} msgs"></div>\`
    ).join('');
    labels.innerHTML = hourly.map(([h]) =>
      \`<div style="flex:1;text-align:center">\${h.slice(11)}h</div>\`
    ).join('');

    const bkHtml = bookings.slice(0,10).map(b =>
      \`<tr><td>#\${b.id}</td><td>\${b.service}</td><td>\${b.date}</td><td>\${b.time}</td><td><span class="badge \${b.status}">\${b.status}</span></td></tr>\`
    ).join('');
    document.getElementById('bookingsTable').innerHTML = bkHtml || '<tr><td colspan="5" style="color:#8b949e">No bookings yet</td></tr>';

    const brHtml = broadcasts.slice(0,5).map(b =>
      \`<tr><td>\${b.message}...</td><td style="color:#3fb950">\${b.sent}</td><td style="color:#f85149">\${b.failed}</td><td style="color:#8b949e">\${new Date(b.time).toLocaleString()}</td></tr>\`
    ).join('');
    document.getElementById('broadcastTable').innerHTML = brHtml || '<tr><td colspan="4" style="color:#8b949e">No broadcasts yet</td></tr>';
  } catch(e) { console.error(e); }
}

// Init based on active tab
const activeTab = '${activeTab}';
if (activeTab === 'session') {
  loadSession();
  setInterval(loadSession, 15000);
} else {
  loadOverview();
  setInterval(loadOverview, 10000);
}
</script>
</body>
</html>`;
}

module.exports = router;
