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

router.get("/add-session", (req, res) => {
  res.redirect("/dashboard?tab=add");
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
.platform-badge{font-size:0.75rem;background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:12px;padding:3px 10px}
.tabs{background:#161b22;border-bottom:1px solid #30363d;display:flex;gap:0;padding:0 32px}
.tab{padding:12px 20px;font-size:0.9rem;color:#8b949e;cursor:pointer;border-bottom:3px solid transparent;text-decoration:none;display:inline-block;transition:color .2s}
.tab:hover{color:#e6edf3}
.tab.active{color:#58a6ff;border-bottom-color:#58a6ff;font-weight:600}
.tab.setup-tab{color:#d29922}
.tab.setup-tab.active{color:#d29922;border-bottom-color:#d29922}
.tab.add-tab{color:#3fb950}
.tab.add-tab.active{color:#3fb950;border-bottom-color:#3fb950}
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
.sid-wrap{background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:20px;margin-bottom:20px;position:relative}
.sid-label{font-size:0.75rem;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.sid-box{background:#010409;border:1px solid #30363d;border-radius:8px;padding:16px 14px;font-family:monospace;font-size:0.78rem;color:#58a6ff;word-break:break-all;max-height:120px;overflow-y:auto;line-height:1.5;user-select:all;cursor:text}
.sid-actions{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.btn{padding:8px 18px;border-radius:8px;border:none;cursor:pointer;font-size:0.85rem;font-weight:600;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-blue{background:#1f6feb;color:#fff}
.btn-green{background:#238636;color:#fff}
.btn-orange{background:#d29922;color:#000}
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
/* Setup tab */
.setup-form{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px;margin-bottom:20px}
.setup-form h2{font-size:1rem;color:#e6edf3;margin-bottom:6px}
.setup-form p{font-size:0.85rem;color:#8b949e;margin-bottom:20px}
.form-group{margin-bottom:18px}
.form-group label{display:block;font-size:0.8rem;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
.form-group input,.form-group select{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 14px;color:#e6edf3;font-size:0.9rem;outline:none;transition:border .2s}
.form-group input:focus,.form-group select:focus{border-color:#58a6ff}
.form-group input::placeholder{color:#484f58}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.platform-section{background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:18px;margin-bottom:18px}
.platform-section h3{font-size:0.85rem;color:#e6edf3;margin-bottom:12px;display:flex;align-items:center;gap:6px}
.alert{padding:12px 16px;border-radius:8px;font-size:0.85rem;margin-bottom:16px}
.alert-warn{background:#3a2f0b;border:1px solid #d29922;color:#d29922}
.alert-success{background:#1a3a2a;border:1px solid #3fb950;color:#3fb950}
.alert-info{background:#0d2040;border:1px solid #1f6feb;color:#58a6ff}
.setup-result{margin-top:14px;font-size:0.85rem;min-height:24px}
.toggle-section{cursor:pointer;user-select:none}
.toggle-section .chevron{transition:transform .2s;display:inline-block}
.toggle-section.open .chevron{transform:rotate(90deg)}
.hidden{display:none}
</style>
</head>
<body>
<div class="header">
  <span style="font-size:1.5rem">⚡</span>
  <h1>IgniteBot Dashboard</h1>
  <span class="platform-badge" id="platformBadge">detecting...</span>
  <span class="status" id="connBadge">LIVE</span>
  <span class="refresh" id="lastUpdate"></span>
</div>

<div class="tabs">
  <a class="tab ${activeTab === "overview" ? "active" : ""}" href="/dashboard?tab=overview">📊 Overview</a>
  <a class="tab ${activeTab === "session" ? "active" : ""}" href="/dashboard?tab=session">🔑 Session ID</a>
  <a class="tab setup-tab ${activeTab === "setup" ? "active" : ""}" href="/dashboard?tab=setup">⚙️ Setup</a>
  <a class="tab add-tab ${activeTab === "add" ? "active" : ""}" href="/dashboard?tab=add">➕ Add Session</a>
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
        <button class="btn btn-orange" onclick="window.location='/dashboard?tab=setup'">⚙️ Push to Heroku</button>
      </div>
    </div>

    <div class="section" style="background:#0d1117;border-color:#21262d">
      <h2 style="font-size:0.9rem;margin-bottom:14px">📖 How to use your Session ID</h2>
      <div class="steps">
        <div class="step"><div class="step-num">1</div><div class="step-text">Click <strong>Copy Session ID</strong> above to copy the full <code>NEXUS-MD:~...</code> string</div></div>
        <div class="step"><div class="step-num">2</div><div class="step-text"><strong>Heroku:</strong> Use the <strong>Setup tab</strong> to auto-push your config vars with just your Heroku API key</div></div>
        <div class="step"><div class="step-num">3</div><div class="step-text"><strong>Railway / Render:</strong> Go to Variables → add <code>SESSION_ID</code> and paste</div></div>
        <div class="step"><div class="step-num">4</div><div class="step-text"><strong>Replit:</strong> Go to Secrets → add <code>SESSION_ID</code> and paste. On the next restart the bot will auto-connect without scanning</div></div>
        <div class="step"><div class="step-num">5</div><div class="step-text"><strong>Universal support:</strong> Any valid Baileys session is accepted — <code>NEXUS-MD</code>, raw JSON, base64, a Pastebin/GitHub Gist URL, or sessions from other Baileys-based bots</div></div>
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

<!-- SETUP TAB -->
<div id="tabSetup" style="display:${activeTab === "setup" ? "block" : "none"}">

  <div id="setupBanner" class="alert alert-warn" style="display:none">
    ⚠️ <strong>Bot not connected</strong> — fill in your details below to get started.
  </div>

  <!-- QUICK SETUP -->
  <div class="setup-form">
    <h2>🚀 Quick Setup</h2>
    <p>Fill in your details — the bot will connect and optionally push all config vars to Heroku automatically.</p>

    <div class="form-row">
      <div class="form-group">
        <label>📱 Owner Phone Number</label>
        <input type="tel" id="setupPhone" placeholder="254706535581 (no + sign)" />
        <div style="font-size:0.75rem;color:#484f58;margin-top:4px">Country code + number, no spaces or + symbol</div>
      </div>
      <div class="form-group">
        <label>🤖 Bot Name</label>
        <input type="text" id="setupBotname" placeholder="NEXUS-MD" value="NEXUS-MD" />
      </div>
    </div>

    <div class="form-group">
      <label>🔑 Session ID</label>
      <input type="text" id="setupSessionId" placeholder="NEXUS-MD:~... (get it from nexs-session-1.replit.app)" />
      <div style="font-size:0.75rem;color:#484f58;margin-top:4px">
        Don't have one? <a href="https://nexs-session-1.replit.app" target="_blank" style="color:#58a6ff">Get a free session ID here →</a>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label>🚫 Bad Words (comma-separated)</label>
        <input type="text" id="setupBadword" placeholder="fuck,pussy,slut,bitch" value="fuck,pussy,slut,bitch,cock,stupid" />
        <div style="font-size:0.75rem;color:#484f58;margin-top:4px">Members sending these words will be kicked</div>
      </div>
      <div class="form-group">
        <label>📋 Menu Type</label>
        <select id="setupMenuType">
          <option value="VIDEO">VIDEO — animated video menu</option>
          <option value="IMAGE">IMAGE — static image menu</option>
          <option value="LINK">LINK — text link menu</option>
        </select>
      </div>
    </div>

    <!-- Platform selector -->
    <div class="form-group">
      <label>🌍 Deployment Platform</label>
      <select id="setupPlatform" onchange="onPlatformChange()">
        <option value="local">Local / Replit / VPS (apply session only)</option>
        <option value="heroku">Heroku (auto-push all config vars)</option>
      </select>
    </div>

    <!-- Heroku-specific fields (shown only when Heroku selected) -->
    <div id="herokuFields" class="platform-section hidden">
      <h3>🟣 Heroku Configuration</h3>
      <div class="alert alert-warn" style="margin-bottom:14px">
        ⚠️ <strong>Disable GitHub auto-deploy on Heroku</strong> — Go to your Heroku app → <em>Deploy</em> tab → <em>Automatic deploys</em> → click <strong>Disable Automatic Deploys</strong>. Every code push to GitHub triggers a Heroku restart mid-connection, which can wipe the active WhatsApp session before it is saved.
      </div>
      <div class="form-row">
        <div class="form-group" style="margin-bottom:0">
          <label>Heroku API Key</label>
          <input type="password" id="herokuApiKey" placeholder="Your Heroku API key" />
          <div style="font-size:0.75rem;color:#484f58;margin-top:4px">
            <a href="https://dashboard.heroku.com/account" target="_blank" style="color:#58a6ff">Get it from Account Settings →</a>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label>Heroku App Name</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="herokuAppName" placeholder="your-app-name" style="flex:1" />
            <button class="btn btn-gray" onclick="fetchHerokuApps()" title="Auto-detect apps" style="padding:8px 12px;white-space:nowrap">🔍 Find</button>
          </div>
        </div>
      </div>
      <div id="herokuAppList" style="margin-top:10px;font-size:0.8rem;color:#8b949e"></div>
      <div style="margin-top:12px">
        <div class="form-row">
          <div class="form-group" style="margin-bottom:0">
            <label style="text-transform:none;letter-spacing:0">NODE_ENV</label>
            <input type="text" id="cfgNodeEnv" value="production" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label style="text-transform:none;letter-spacing:0">PAIR_SITE_URL</label>
            <input type="text" id="cfgPairSite" value="https://nexs-session-1.replit.app" />
          </div>
        </div>
      </div>
    </div>

    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-green" onclick="applySetup()">✅ Apply Setup</button>
      <button class="btn btn-gray" onclick="clearSetup()">🗑 Clear</button>
      <button class="btn btn-blue" onclick="forceReconnect()" id="reconnectBtn">🔄 Force Reconnect</button>
    </div>

    <div class="setup-result" id="setupResult"></div>
  </div>

  <!-- Platform Info -->
  <div class="setup-form">
    <h2>🌍 Platform Detection</h2>
    <p>Detected deployment environment and status.</p>
    <div class="info-grid" id="platformInfoGrid">
      <div class="info-item"><div class="label">Platform</div><div class="val" id="piPlatform">—</div></div>
      <div class="info-item"><div class="label">Bot Status</div><div class="val" id="piBotStatus">—</div></div>
      <div class="info-item"><div class="label">Heroku App</div><div class="val" id="piHerokuApp">—</div></div>
      <div class="info-item"><div class="label">Mode</div><div class="val" id="piMode">—</div></div>
    </div>
  </div>

  <!-- Manual Heroku form filler -->
  <div class="setup-form">
    <h2>📋 Heroku Deploy Form Auto-Fill</h2>
    <p>Generate the exact values to paste when deploying to Heroku via the deploy button form.</p>
    <div class="alert alert-info" style="margin-bottom:16px">
      ℹ️ Fill the Quick Setup fields above first, then click Generate to get pre-filled Heroku config var values.
    </div>
    <button class="btn btn-blue" onclick="generateHerokuFill()">📋 Generate Heroku Config Values</button>
    <div id="herokuFillOutput" style="margin-top:16px"></div>
  </div>

</div><!-- /tabSetup -->

<!-- ADD SESSION TAB -->
<div id="tabAdd" style="display:${activeTab === "add" ? "block" : "none"}">

  <div class="setup-form">
    <h2>➕ Add Session / Deploy New App</h2>
    <p>Create a brand-new Heroku app with your bot config, or just apply a session to this running bot. Fill in the fields below and click <strong>Deploy App</strong>.</p>
  </div>

  <!-- App Name + Region -->
  <div class="setup-form">
    <h2 style="margin-bottom:6px">🏷 App Details</h2>
    <p>Leave the app name blank and Heroku will auto-generate one.</p>

    <div class="form-row">
      <div class="form-group">
        <label>App Name</label>
        <input type="text" id="addAppName" placeholder="my-nexus-bot (optional)" />
        <div style="font-size:0.75rem;color:#484f58;margin-top:4px">Lowercase letters, numbers, and hyphens only</div>
      </div>
      <div class="form-group">
        <label>Heroku API Key <span style="color:#f85149">*</span></label>
        <input type="password" id="addHerokuKey" placeholder="Your Heroku API key" />
        <div style="font-size:0.75rem;color:#484f58;margin-top:4px">
          <a href="https://dashboard.heroku.com/account" target="_blank" style="color:#58a6ff">Get it from Account Settings →</a>
        </div>
      </div>
    </div>

    <!-- Location -->
    <div class="form-group">
      <label>Location</label>
      <p style="font-size:0.82rem;color:#8b949e;margin-bottom:12px">Choose a Common Runtime region for this app.</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;align-items:center;gap:12px;background:#0d1117;border:2px solid #388bfd;border-radius:8px;padding:14px 18px;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.9rem">
          <input type="radio" name="addRegion" value="us" checked style="accent-color:#388bfd;width:16px;height:16px" />
          <span style="flex:1"><strong style="color:#e6edf3">Common Runtime</strong><br><span style="font-size:0.78rem;color:#8b949e">CEDAR</span></span>
          <span style="font-size:1.2rem">🇺🇸</span><span style="color:#8b949e">United States</span>
        </label>
        <label style="display:flex;align-items:center;gap:12px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 18px;cursor:pointer;text-transform:none;letter-spacing:0;font-size:0.9rem" id="euRegionLabel">
          <input type="radio" name="addRegion" value="eu" style="accent-color:#388bfd;width:16px;height:16px" onchange="updateRegionStyle()" />
          <span style="flex:1"><strong style="color:#e6edf3">Common Runtime</strong><br><span style="font-size:0.78rem;color:#8b949e">CEDAR</span></span>
          <span style="font-size:1.2rem">🇮🇪</span><span style="color:#8b949e">Europe</span>
        </label>
      </div>
    </div>
  </div>

  <!-- Resources info -->
  <div class="setup-form">
    <h2 style="margin-bottom:6px">📦 Resources</h2>
    <p style="font-size:0.85rem;color:#8b949e;margin-bottom:16px">These resources will be provisioned when the app deploys. Heroku resources are prorated to the second — you only pay for the resources you use.</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px 16px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:1.2rem">🌐</span>
          <div><div style="font-size:0.9rem;color:#e6edf3">web</div><div style="font-size:0.78rem;color:#8b949e">Standard-1X dyno</div></div>
        </div>
        <span style="color:#8b949e;font-size:0.85rem">~$0.035/hour</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px 16px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:1.2rem">🐘</span>
          <div><div style="font-size:0.9rem;color:#e6edf3">Heroku Postgres</div><div style="font-size:0.78rem;color:#8b949e">Essential 0 add-on</div></div>
        </div>
        <span style="color:#8b949e;font-size:0.85rem">~$0.007/hour</span>
      </div>
    </div>
  </div>

  <!-- Config Vars -->
  <div class="setup-form">
    <h2 style="margin-bottom:6px">⚙️ Config Vars</h2>
    <p style="font-size:0.85rem;color:#8b949e;margin-bottom:20px">These are the environment variables set on your new Heroku app. Required fields must be filled.</p>

    <div class="form-group">
      <label>ADMIN_NUMBERS <span style="color:#f85149;font-size:0.75rem;background:#3a1a1a;padding:2px 6px;border-radius:4px;margin-left:4px">Required</span></label>
      <div style="font-size:0.78rem;color:#8b949e;margin-bottom:6px">Your WhatsApp number WITHOUT the + sign. This makes you the bot owner. Example: 254706535581. Multiple owners: 254706535581,254781346242</div>
      <input type="tel" id="addAdminNumbers" placeholder="254706535581" />
    </div>

    <div class="form-group">
      <label>SESSION_ID <span style="color:#f85149;font-size:0.75rem;background:#3a1a1a;padding:2px 6px;border-radius:4px;margin-left:4px">Required</span></label>
      <div style="font-size:0.78rem;color:#8b949e;margin-bottom:6px">Your WhatsApp session ID. Don't have one? <a href="https://nexs-session-1.replit.app" target="_blank" style="color:#58a6ff">Get a free session ID here →</a></div>
      <input type="text" id="addSessionId" placeholder="NEXUS-MD:~..." />
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-gray" style="font-size:0.78rem;padding:6px 12px" onclick="fillAddSessionFromBot()">📋 Use current bot session</button>
        <button class="btn btn-gray" style="font-size:0.78rem;padding:6px 12px" onclick="window.open('https://nexs-session-1.replit.app','_blank')">🌐 Get session ID</button>
      </div>
    </div>

    <div class="form-group">
      <label>BOTNAME</label>
      <div style="font-size:0.78rem;color:#8b949e;margin-bottom:6px">Your bot display name shown in menus and messages.</div>
      <input type="text" id="addBotname" value="NEXUS-MD" placeholder="NEXUS-MD" />
    </div>

    <div class="form-group">
      <label>DATABASE_URL</label>
      <div style="font-size:0.78rem;color:#8b949e;margin-bottom:6px">PostgreSQL connection string — automatically filled in by the Heroku Postgres add-on above. Leave this blank.</div>
      <input type="text" id="addDatabaseUrl" placeholder="(auto-filled by Heroku Postgres — leave blank)" disabled style="opacity:0.5;cursor:not-allowed" />
    </div>

    <div class="form-group">
      <label>BAD_WORD</label>
      <div style="font-size:0.78rem;color:#8b949e;margin-bottom:6px">Comma-separated list of words that will get a member kicked from the group.</div>
      <input type="text" id="addBadword" value="fuck,pussy,slut,bitch,cock,stupid" placeholder="fuck,pussy,slut,bitch" />
    </div>

    <div class="form-group">
      <label>MENU_TYPE</label>
      <div style="font-size:0.78rem;color:#8b949e;margin-bottom:6px">How the bot serves the .menu command.</div>
      <select id="addMenuType">
        <option value="VIDEO">VIDEO — animated video menu</option>
        <option value="IMAGE">IMAGE — static image menu</option>
        <option value="LINK">LINK — text link menu</option>
      </select>
    </div>

    <div class="form-group">
      <label>PAIR_SITE_URL</label>
      <div style="font-size:0.78rem;color:#8b949e;margin-bottom:6px">External pairing site for generating Session IDs.</div>
      <input type="text" id="addPairSite" value="https://nexs-session-1.replit.app" />
    </div>

    <div style="margin-top:24px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-green" style="padding:12px 28px;font-size:1rem" onclick="deployHerokuApp()">🚀 Deploy App</button>
      <button class="btn btn-blue" onclick="applyAddSessionLocal()">⚡ Apply Session to This Bot Only</button>
      <button class="btn btn-gray" onclick="clearAddForm()">🗑 Clear</button>
    </div>

    <div id="addResult" style="margin-top:18px;font-size:0.88rem;min-height:24px;line-height:1.7"></div>
  </div>

  <!-- Success box (hidden until deploy) -->
  <div id="addSuccessBox" style="display:none" class="setup-form">
    <h2 style="color:#3fb950;margin-bottom:10px">✅ App Deployed!</h2>
    <div class="info-grid">
      <div class="info-item"><div class="label">App Name</div><div class="val" id="addSuccessName" style="color:#3fb950">—</div></div>
      <div class="info-item"><div class="label">App URL</div><div class="val" id="addSuccessUrl" style="font-size:0.9rem">—</div></div>
    </div>
    <div class="alert alert-success" style="margin-top:14px">
      ✅ Your Heroku app is deploying. It may take 2-3 minutes to come online. Visit the URL above once it's ready.
    </div>
    <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-blue" onclick="window.open(document.getElementById('addSuccessUrl').textContent,'_blank')">🌐 Open App</button>
      <a class="btn btn-gray" href="https://dashboard.heroku.com" target="_blank">🟣 Heroku Dashboard</a>
    </div>
  </div>

</div><!-- /tabAdd -->

<div class="toast" id="toast"></div>

<script>
function toast(msg, color) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = color || '#238636';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ---- PLATFORM DETECTION ----
let platformInfo = {};
async function loadPlatform() {
  try {
    const d = await fetch('/api/platform').then(r=>r.json());
    platformInfo = d;
    const badge = document.getElementById('platformBadge');
    if (badge) badge.textContent = (d.icon||'') + ' ' + (d.platform||'Unknown');

    const connBadge = document.getElementById('connBadge');
    if (connBadge) {
      connBadge.textContent = d.botStatus === 'connected' ? 'ONLINE' : (d.waitingForSession ? 'SETUP NEEDED' : 'OFFLINE');
      connBadge.style.background = d.botStatus === 'connected' ? '#238636' : (d.waitingForSession ? '#d29922' : '#b62324');
      connBadge.style.color = '#fff';
    }

    // Setup tab info
    const piPlatform = document.getElementById('piPlatform');
    const piBotStatus = document.getElementById('piBotStatus');
    const piHerokuApp = document.getElementById('piHerokuApp');
    const piMode = document.getElementById('piMode');
    if (piPlatform) piPlatform.textContent = (d.icon||'') + ' ' + (d.platform||'Unknown');
    if (piBotStatus) {
      piBotStatus.innerHTML = d.botStatus === 'connected'
        ? '<span class="status-dot dot-green"></span>Connected'
        : (d.waitingForSession ? '<span class="status-dot dot-yellow"></span>Waiting for session' : '<span class="status-dot dot-red"></span>Disconnected');
    }
    if (piHerokuApp) piHerokuApp.textContent = d.herokuAppName || (d.isHeroku ? 'Unknown' : 'N/A');
    if (piMode) piMode.textContent = d.isPanel ? 'Panel Mode' : (d.isHeroku ? 'Heroku Cloud' : 'Cloud / VPS');

    // Auto-select platform in dropdown
    const platSel = document.getElementById('setupPlatform');
    if (platSel && d.isHeroku) {
      platSel.value = 'heroku';
      onPlatformChange();
      if (d.herokuAppName) {
        const appInp = document.getElementById('herokuAppName');
        if (appInp && !appInp.value) appInp.value = d.herokuAppName;
      }
    }

    // Show banner if no session
    const banner = document.getElementById('setupBanner');
    if (banner && d.waitingForSession) banner.style.display = 'block';

    // Pre-fill phone from bot if connected
    const phoneInp = document.getElementById('setupPhone');
    if (phoneInp && !phoneInp.value) {
      const sess = await fetch('/api/session').then(r=>r.json()).catch(()=>null);
      if (sess?.phone) phoneInp.value = sess.phone.replace('@s.whatsapp.net','').replace(':','');
    }
  } catch(e) {}
}

// ---- SESSION TAB ----
let currentSID = null;
async function loadSession() {
  try {
    const r = await fetch('/api/session');
    const d = await r.json();
    currentSID = d.sessionId;
    const box = document.getElementById('sessionIdBox');
    if (box) {
      if (d.sessionId) {
        box.textContent = d.sessionId;
        box.style.color = '#58a6ff';
      } else {
        box.textContent = '⏳ Session not ready — pair the bot first then refresh.';
        box.style.color = '#d29922';
      }
    }
    const connEl = document.getElementById('sConnected');
    if (connEl) {
      connEl.innerHTML = d.connected
        ? '<span class="status-dot dot-green"></span>Connected'
        : '<span class="status-dot dot-red"></span>Disconnected';
    }
    const phoneEl = document.getElementById('sPhone');
    if (phoneEl) phoneEl.textContent = d.phone ? '+' + d.phone.replace('@s.whatsapp.net','').replace(':','') : '—';

    // Pre-fill session ID in setup form
    const setupSid = document.getElementById('setupSessionId');
    if (setupSid && !setupSid.value && d.sessionId) setupSid.value = d.sessionId;
  } catch(e) {
    const box = document.getElementById('sessionIdBox');
    if (box) box.textContent = '❌ Error loading session.';
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

// ---- SETUP TAB ----
function onPlatformChange() {
  const v = document.getElementById('setupPlatform').value;
  document.getElementById('herokuFields').classList.toggle('hidden', v !== 'heroku');
}

async function fetchHerokuApps() {
  const apiKey = (document.getElementById('herokuApiKey').value||'').trim();
  const listEl = document.getElementById('herokuAppList');
  if (!apiKey) { listEl.textContent = '⚠️ Enter your Heroku API key first.'; listEl.style.color='#d29922'; return; }
  listEl.textContent = '⏳ Fetching apps...'; listEl.style.color='#8b949e';
  try {
    const r = await fetch('/api/heroku/apps?apiKey=' + encodeURIComponent(apiKey));
    const d = await r.json();
    if (d.ok && d.apps.length) {
      listEl.innerHTML = 'Found apps: ' + d.apps.map(a =>
        \`<a href="#" style="color:#58a6ff;margin-right:8px" onclick="document.getElementById('herokuAppName').value='\${a.name}';return false">\${a.name}</a>\`
      ).join('');
      listEl.style.color='#8b949e';
    } else if (d.ok) {
      listEl.textContent = 'No apps found on this account.';
    } else {
      listEl.textContent = '❌ ' + (d.error||'Unknown error');
      listEl.style.color='#f85149';
    }
  } catch(e) {
    listEl.textContent = '❌ Network error: ' + e.message;
    listEl.style.color='#f85149';
  }
}

async function forceReconnect() {
  const btn = document.getElementById('reconnectBtn');
  const resultEl = document.getElementById('setupResult');
  if (btn) btn.disabled = true;
  resultEl.innerHTML = '<span style="color:#8b949e">⏳ Sending reconnect signal...</span>';
  try {
    const r = await fetch('/api/reconnect', { method: 'POST', headers: {'Content-Type':'application/json'} });
    const d = await r.json();
    if (d.ok) {
      resultEl.innerHTML = '<span style="color:#3fb950">✅ ' + d.message + ' — watch the console logs.</span>';
      toast('🔄 Reconnecting...', '#1f6feb');
    } else {
      resultEl.innerHTML = '<span style="color:#d29922">⚠️ ' + d.message + '</span>';
    }
  } catch(e) {
    resultEl.innerHTML = '<span style="color:#f85149">❌ Network error: ' + e.message + '</span>';
  } finally {
    if (btn) setTimeout(() => { btn.disabled = false; }, 3000);
  }
}

async function applySetup() {
  const phone = (document.getElementById('setupPhone').value||'').replace(/\\D/g,'').trim();
  const sessionId = (document.getElementById('setupSessionId').value||'').trim();
  const botname = (document.getElementById('setupBotname').value||'NEXUS-MD').trim();
  const badword = (document.getElementById('setupBadword').value||'').trim();
  const menuType = (document.getElementById('setupMenuType').value||'VIDEO').trim();
  const platform = document.getElementById('setupPlatform').value;
  const resultEl = document.getElementById('setupResult');

  if (!sessionId) { resultEl.innerHTML='<span style="color:#f85149">⚠️ Session ID is required.</span>'; return; }

  resultEl.innerHTML = '<span style="color:#8b949e">⏳ Applying session to bot...</span>';

  // Step 1: apply session to local bot
  try {
    const r = await fetch('/session', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ session: sessionId })
    });
    const d = await r.json();
    if (!d.ok && d.error) {
      resultEl.innerHTML = '<span style="color:#f85149">❌ Session error: ' + d.error + '</span>';
      return;
    }
    resultEl.innerHTML = '<span style="color:#3fb950">✅ Session applied — bot reconnecting...</span>';
    toast('✅ Session applied!', '#238636');
  } catch(e) {
    resultEl.innerHTML = '<span style="color:#f85149">❌ Network error: ' + e.message + '</span>';
    return;
  }

  // Step 2: push to Heroku if selected
  if (platform === 'heroku') {
    const apiKey = (document.getElementById('herokuApiKey').value||'').trim();
    const appName = (document.getElementById('herokuAppName').value||'').trim();
    if (!apiKey || !appName) {
      resultEl.innerHTML += '<br><span style="color:#d29922">⚠️ Enter Heroku API key and app name to push config vars.</span>';
      return;
    }
    resultEl.innerHTML += '<br><span style="color:#8b949e">⏳ Pushing config vars to Heroku...</span>';
    const vars = {
      SESSION: sessionId,
      SESSION_ID: sessionId,
      BOTNAME: botname,
    };
    if (phone) { vars.ADMIN_NUMBERS = phone; }
    if (badword) vars.BAD_WORD = badword;
    vars.MENU_TYPE = menuType;
    vars.HEROKU_API = apiKey;
    const nodeEnv = (document.getElementById('cfgNodeEnv').value||'production').trim();
    const pairSite = (document.getElementById('cfgPairSite').value||'').trim();
    if (nodeEnv) vars.NODE_ENV = nodeEnv;
    if (pairSite) vars.PAIR_SITE_URL = pairSite;

    try {
      const r = await fetch('/api/heroku/config', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ apiKey, appName, vars })
      });
      const d = await r.json();
      if (d.ok) {
        resultEl.innerHTML += '<br><span style="color:#3fb950">✅ Heroku config vars updated on <strong>' + appName + '</strong>! The dyno will restart automatically.</span>';
        toast('✅ Heroku updated!', '#238636');
      } else {
        resultEl.innerHTML += '<br><span style="color:#f85149">❌ Heroku error: ' + (d.error||'Unknown') + '</span>';
      }
    } catch(e) {
      resultEl.innerHTML += '<br><span style="color:#f85149">❌ Network error: ' + e.message + '</span>';
    }
  }
}

function clearSetup() {
  ['setupPhone','setupSessionId','herokuApiKey','herokuAppName','setupBadword'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const bn = document.getElementById('setupBotname');
  if (bn) bn.value = 'NEXUS-MD';
  document.getElementById('setupResult').innerHTML = '';
  document.getElementById('herokuAppList').innerHTML = '';
}

function generateHerokuFill() {
  const phone = (document.getElementById('setupPhone').value||'').replace(/\\D/g,'').trim();
  const sessionId = (document.getElementById('setupSessionId').value||'').trim();
  const botname = (document.getElementById('setupBotname').value||'NEXUS-MD').trim();
  const apiKey = (document.getElementById('herokuApiKey').value||'').trim();
  const out = document.getElementById('herokuFillOutput');

  if (!phone && !apiKey) {
    out.innerHTML = '<span style="color:#d29922">⚠️ Fill in at least your phone number above first.</span>';
    return;
  }

  const deployRows = [
    { key: 'HEROKU_API', val: apiKey || '(your Heroku API key from dashboard.heroku.com/account)', label: 'Heroku API Key' },
    { key: 'ADMIN_NUMBERS', val: phone || '(your WhatsApp number without +)', label: 'Owner Phone' },
    { key: 'SESSION_ID', val: sessionId || '(get from nexs-session-1.replit.app or Session ID tab)', label: 'Session ID' },
    { key: 'DATABASE_URL', val: '(auto-filled by Heroku Postgres add-on — leave blank)', label: 'Database URL' },
    { key: 'BOTNAME', val: botname, label: 'Bot Name' },
  ];

  const postDeploySession = sessionId
    ? \`<span style="color:#3fb950;font-family:monospace">.setvar SESSION=\${sessionId}</span>\`
    : \`<span style="color:#8b949e;font-family:monospace">.setvar SESSION=NEXUS-MD:~...&lt;your-session-id&gt;</span>\`;

  out.innerHTML = \`
    <p style="font-size:0.82rem;color:#8b949e;margin:0 0 10px">
      The Heroku deploy form only shows these 4 fields — everything else is pre-configured automatically.
    </p>
    <div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;overflow:hidden;margin-bottom:14px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;padding:10px 14px;font-size:0.75rem;color:#8b949e;text-transform:uppercase;border-bottom:1px solid #30363d">Field</th>
          <th style="text-align:left;padding:10px 14px;font-size:0.75rem;color:#8b949e;text-transform:uppercase;border-bottom:1px solid #30363d">Value to paste</th>
          <th style="padding:10px 14px;border-bottom:1px solid #30363d"></th>
        </tr></thead>
        <tbody>
          \${deployRows.map(r => \`<tr>
            <td style="padding:10px 14px;font-family:monospace;color:#79c0ff;font-size:0.85rem;border-bottom:1px solid #21262d;white-space:nowrap">\${r.key}</td>
            <td style="padding:10px 14px;font-family:monospace;font-size:0.78rem;color:#e6edf3;word-break:break-all;border-bottom:1px solid #21262d">\${r.val}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #21262d;white-space:nowrap">
              \${r.val.startsWith('(') ? '' : \`<button class="btn btn-gray" style="padding:4px 10px;font-size:0.75rem" onclick="navigator.clipboard.writeText('\${r.val.replace(/'/g,\\"\\\\'\\")}');toast('Copied!')">Copy</button>\`}
            </td>
          </tr>\`).join('')}
        </tbody>
      </table>
    </div>
    <div style="background:#161b22;border:1px solid #388bfd44;border-radius:8px;padding:14px">
      <p style="margin:0 0 8px;font-size:0.85rem;color:#79c0ff;font-weight:600">📱 Step 2 — Connect WhatsApp after deploy</p>
      <p style="margin:0 0 8px;font-size:0.82rem;color:#c9d1d9">
        Once your Heroku app is running, get a session ID from
        <a href="https://nexs-session-1.replit.app" target="_blank" style="color:#58a6ff">nexs-session-1.replit.app</a>
        then send this command to the bot (or paste via the Heroku Config Vars page):
      </p>
      <div style="background:#0d1117;border-radius:6px;padding:10px 14px;font-size:0.85rem">
        \${postDeploySession}
      </div>
      \${sessionId ? \`<p style="margin:8px 0 0;font-size:0.78rem;color:#3fb950">✅ Your session ID is already filled in above — just copy and send it to the bot!</p>\` : ''}
    </div>
  \`;
}

// ---- ADD SESSION TAB ----
function updateRegionStyle() {
  const radios = document.querySelectorAll('input[name="addRegion"]');
  radios.forEach(r => {
    const label = r.closest('label');
    if (r.checked) {
      label.style.border = '2px solid #388bfd';
      label.style.background = '#0d1117';
    } else {
      label.style.border = '1px solid #30363d';
      label.style.background = '#161b22';
    }
  });
}

// Wire up region radios after DOM loads
document.querySelectorAll('input[name="addRegion"]').forEach(r => r.addEventListener('change', updateRegionStyle));

async function fillAddSessionFromBot() {
  try {
    const d = await fetch('/api/session').then(r => r.json());
    if (d.sessionId) {
      document.getElementById('addSessionId').value = d.sessionId;
      toast('✅ Session filled from bot!', '#238636');
    } else {
      toast('⚠️ No active session yet — pair the bot first.', '#d29922');
    }
    if (d.phone) {
      const phone = d.phone.replace('@s.whatsapp.net', '').replace(':', '').replace(/\\D/g, '');
      const adminEl = document.getElementById('addAdminNumbers');
      if (adminEl && !adminEl.value) adminEl.value = phone;
    }
  } catch(e) {
    toast('❌ Could not load session: ' + e.message, '#b62324');
  }
}

async function deployHerokuApp() {
  const apiKey    = (document.getElementById('addHerokuKey').value || '').trim();
  const appName   = (document.getElementById('addAppName').value || '').trim();
  const region    = document.querySelector('input[name="addRegion"]:checked')?.value || 'us';
  const admin     = (document.getElementById('addAdminNumbers').value || '').replace(/\\D/g, '').trim();
  const sessionId = (document.getElementById('addSessionId').value || '').trim();
  const botname   = (document.getElementById('addBotname').value || 'NEXUS-MD').trim();
  const badword   = (document.getElementById('addBadword').value || '').trim();
  const menuType  = (document.getElementById('addMenuType').value || 'VIDEO');
  const pairSite  = (document.getElementById('addPairSite').value || '').trim();
  const resultEl  = document.getElementById('addResult');

  if (!apiKey) { resultEl.innerHTML = '<span style="color:#f85149">❌ Heroku API key is required.</span>'; return; }
  if (!admin)  { resultEl.innerHTML = '<span style="color:#f85149">❌ ADMIN_NUMBERS is required.</span>'; return; }
  if (!sessionId) { resultEl.innerHTML = '<span style="color:#f85149">❌ SESSION_ID is required.</span>'; return; }

  resultEl.innerHTML = '<span style="color:#8b949e">⏳ Creating Heroku app… this may take 15-30 seconds…</span>';
  document.getElementById('addSuccessBox').style.display = 'none';

  const vars = {
    ADMIN_NUMBERS: admin,
    SESSION_ID: sessionId,
    SESSION: sessionId,
    BOTNAME: botname,
    MENU_TYPE: menuType,
    HEROKU_API: apiKey,
  };
  if (badword) vars.BAD_WORD = badword;
  if (pairSite) vars.PAIR_SITE_URL = pairSite;

  try {
    const r = await fetch('/api/heroku/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, appName: appName || undefined, region, vars }),
    });
    const d = await r.json();
    if (d.ok) {
      resultEl.innerHTML = \`<span style="color:#3fb950">✅ App <strong>\${d.appName}</strong> created! Config vars pushed. Dyno is starting…</span>\`;
      toast('✅ Heroku app deployed!', '#238636');
      document.getElementById('addSuccessName').textContent = d.appName;
      document.getElementById('addSuccessUrl').textContent = d.webUrl;
      document.getElementById('addSuccessBox').style.display = 'block';
    } else {
      resultEl.innerHTML = '<span style="color:#f85149">❌ Heroku error: ' + (d.error || 'Unknown') + '</span>';
    }
  } catch(e) {
    resultEl.innerHTML = '<span style="color:#f85149">❌ Network error: ' + e.message + '</span>';
  }
}

async function applyAddSessionLocal() {
  const sessionId = (document.getElementById('addSessionId').value || '').trim();
  const resultEl  = document.getElementById('addResult');
  if (!sessionId) { resultEl.innerHTML = '<span style="color:#f85149">❌ Enter a Session ID first.</span>'; return; }
  resultEl.innerHTML = '<span style="color:#8b949e">⏳ Applying session to this bot…</span>';
  try {
    const r = await fetch('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionId }),
    });
    const d = await r.json();
    if (d.ok || !d.error) {
      resultEl.innerHTML = '<span style="color:#3fb950">✅ Session applied — bot is reconnecting. Check the Overview tab for status.</span>';
      toast('✅ Session applied!', '#238636');
    } else {
      resultEl.innerHTML = '<span style="color:#f85149">❌ ' + (d.error || 'Unknown error') + '</span>';
    }
  } catch(e) {
    resultEl.innerHTML = '<span style="color:#f85149">❌ Network error: ' + e.message + '</span>';
  }
}

function clearAddForm() {
  ['addAppName','addHerokuKey','addAdminNumbers','addSessionId','addBadword'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const bn = document.getElementById('addBotname');
  if (bn) bn.value = 'NEXUS-MD';
  document.getElementById('addResult').innerHTML = '';
  document.getElementById('addSuccessBox').style.display = 'none';
  // reset region to US
  const usRadio = document.querySelector('input[name="addRegion"][value="us"]');
  if (usRadio) { usRadio.checked = true; updateRegionStyle(); }
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

// Init
loadPlatform();
const activeTab = '${activeTab}';
if (activeTab === 'session') {
  loadSession();
  setInterval(loadSession, 15000);
} else if (activeTab === 'setup') {
  loadSession();
  setInterval(loadPlatform, 10000);
} else if (activeTab === 'add') {
  // Pre-fill session from bot if available
  fillAddSessionFromBot();
  setInterval(loadPlatform, 15000);
} else {
  loadOverview();
  setInterval(loadOverview, 10000);
}
</script>
</body>
</html>`;
}

module.exports = router;
