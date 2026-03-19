// Chat UI — single-page HTML app with multi-session support

export const chatHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copilot Bridge</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; }

  /* Sidebar */
  .sidebar { width: 260px; background: #16213e; border-right: 1px solid #2a2a4a; display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar-header { padding: 16px; border-bottom: 1px solid #2a2a4a; }
  .sidebar-header h2 { font-size: 16px; color: #7c83ff; }
  .new-session-btn { width: 100%; margin-top: 10px; padding: 8px; background: #7c83ff; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .new-session-btn:hover { background: #6a70e0; }
  .session-list { flex: 1; overflow-y: auto; padding: 8px; }
  .session-item { padding: 10px 12px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; font-size: 13px; }
  .session-item:hover { background: #1a1a3e; }
  .session-item.active { background: #2a2a5e; border-left: 3px solid #7c83ff; }
  .session-item .name { font-weight: 600; }
  .session-item .meta { font-size: 11px; color: #888; margin-top: 2px; }

  /* Main area */
  .main { flex: 1; display: flex; flex-direction: column; }
  .messages { flex: 1; overflow-y: auto; padding: 20px; }
  .empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: #555; font-size: 18px; }
  .msg { margin-bottom: 16px; max-width: 85%; }
  .msg.user { margin-left: auto; }
  .msg.assistant { margin-right: auto; }
  .msg .bubble { padding: 12px 16px; border-radius: 12px; line-height: 1.5; font-size: 14px; word-wrap: break-word; }
  .msg.user .bubble { background: #7c83ff; color: white; border-bottom-right-radius: 4px; }
  .msg.assistant .bubble { background: #2a2a4a; color: #e0e0e0; border-bottom-left-radius: 4px; }
  .msg.assistant .bubble pre { background: #1a1a2e; padding: 10px; border-radius: 6px; overflow-x: auto; margin: 8px 0; font-size: 13px; }
  .msg.assistant .bubble code { font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 13px; }
  .msg.assistant .bubble p { margin-bottom: 8px; }
  .msg.assistant .bubble ul, .msg.assistant .bubble ol { margin: 8px 0 8px 20px; }
  .msg.assistant .bubble table { border-collapse: collapse; margin: 8px 0; width: 100%; }
  .msg.assistant .bubble th, .msg.assistant .bubble td { border: 1px solid #444; padding: 6px 10px; text-align: left; font-size: 13px; }
  .msg.assistant .bubble th { background: #1a1a2e; }
  .msg.assistant .bubble h1, .msg.assistant .bubble h2, .msg.assistant .bubble h3 { margin: 12px 0 6px; }
  .msg .time { font-size: 11px; color: #666; margin-top: 4px; }
  .msg.user .time { text-align: right; }
  .thinking { color: #7c83ff; font-style: italic; padding: 12px; }
  .thinking::after { content: ''; animation: dots 1.5s infinite; }
  @keyframes dots { 0% { content: '.'; } 33% { content: '..'; } 66% { content: '...'; } }

  /* Input area */
  .input-area { padding: 16px 20px; border-top: 1px solid #2a2a4a; background: #16213e; }
  .input-row { display: flex; gap: 10px; }
  .input-row textarea { flex: 1; padding: 12px; background: #1a1a2e; color: #e0e0e0; border: 1px solid #2a2a4a; border-radius: 8px; font-size: 14px; font-family: inherit; resize: none; min-height: 48px; max-height: 200px; }
  .input-row textarea:focus { outline: none; border-color: #7c83ff; }
  .send-btn { padding: 12px 24px; background: #7c83ff; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; align-self: flex-end; }
  .send-btn:hover { background: #6a70e0; }
  .send-btn:disabled { background: #444; cursor: not-allowed; }

  /* Mobile */
  @media (max-width: 768px) {
    .sidebar { width: 200px; }
    .msg { max-width: 95%; }
  }
  @media (max-width: 480px) {
    body { flex-direction: column; }
    .sidebar { width: 100%; height: auto; max-height: 120px; flex-direction: row; }
    .sidebar-header { display: none; }
    .session-list { display: flex; overflow-x: auto; padding: 8px; gap: 6px; }
    .session-item { white-space: nowrap; flex-shrink: 0; }
  }
</style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-header">
      <h2>🤖 Copilot Bridge</h2>
      <button class="new-session-btn" onclick="newSession()">+ New Session</button>
    </div>
    <div class="session-list" id="sessionList"></div>
  </div>
  <div class="main">
    <div class="messages" id="messages">
      <div class="empty-state" id="emptyState">Create or select a session to start</div>
    </div>
    <div class="input-area">
      <div class="input-row">
        <textarea id="input" placeholder="Type a message..." rows="1"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,200)+'px'"></textarea>
        <button class="send-btn" id="sendBtn" onclick="send()">Send</button>
      </div>
    </div>
  </div>

<script>
let sessions = [];
let currentSessionId = null;
let chatHistory = {}; // sessionId -> [{role, content, time}]

async function api(path, body) {
  const opts = body ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) } : {};
  const res = await fetch(path, opts);
  return res.json();
}

async function loadSessions() {
  const data = await api('/api/sessions');
  sessions = data.sessions || [];
  renderSessions();
}

function renderSessions() {
  const el = document.getElementById('sessionList');
  el.innerHTML = sessions.map(s => {
    const active = s.id === currentSessionId ? 'active' : '';
    const ago = timeAgo(s.lastUsed);
    return '<div class="session-item ' + active + '" onclick="selectSession(\\'' + s.id + '\\')">'
      + '<div class="name">' + esc(s.name) + '</div>'
      + '<div class="meta">' + s.messageCount + ' msgs · ' + ago + '</div>'
      + '</div>';
  }).join('');
}

async function newSession() {
  const name = prompt('Session name (optional):') || undefined;
  const data = await api('/api/sessions', { name });
  if (data.session) {
    sessions.unshift(data.session);
    chatHistory[data.session.id] = [];
    selectSession(data.session.id);
  }
}

function selectSession(id) {
  currentSessionId = id;
  if (!chatHistory[id]) chatHistory[id] = [];
  renderSessions();
  renderMessages();
  document.getElementById('input').focus();
}

function renderMessages() {
  const el = document.getElementById('messages');
  const empty = document.getElementById('emptyState');
  const msgs = chatHistory[currentSessionId] || [];

  if (!currentSessionId) {
    el.innerHTML = '<div class="empty-state">Create or select a session to start</div>';
    return;
  }
  if (msgs.length === 0) {
    el.innerHTML = '<div class="empty-state">Send a message to get started</div>';
    return;
  }

  el.innerHTML = msgs.map(m => {
    const cls = m.role === 'user' ? 'user' : 'assistant';
    return '<div class="msg ' + cls + '"><div class="bubble">' + m.html + '</div><div class="time">' + fmtTime(m.time) + '</div></div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function send() {
  const input = document.getElementById('input');
  const prompt = input.value.trim();
  if (!prompt || !currentSessionId) return;

  input.value = '';
  input.style.height = 'auto';

  const msgs = chatHistory[currentSessionId];
  msgs.push({ role: 'user', html: esc(prompt), time: new Date().toISOString() });
  renderMessages();

  // Show thinking indicator
  const el = document.getElementById('messages');
  el.innerHTML += '<div class="thinking" id="thinking">Thinking</div>';
  el.scrollTop = el.scrollHeight;

  document.getElementById('sendBtn').disabled = true;

  try {
    const data = await api('/api/chat', { sessionId: currentSessionId, prompt });
    document.getElementById('thinking')?.remove();

    if (data.error) {
      msgs.push({ role: 'assistant', html: '<strong>Error:</strong> ' + esc(data.error), time: new Date().toISOString() });
    } else {
      msgs.push({ role: 'assistant', html: renderMarkdown(data.response), time: new Date().toISOString() });
      if (data.session) {
        const idx = sessions.findIndex(s => s.id === data.session.id);
        if (idx >= 0) sessions[idx] = data.session;
        renderSessions();
      }
    }
  } catch (err) {
    document.getElementById('thinking')?.remove();
    msgs.push({ role: 'assistant', html: '<strong>Error:</strong> ' + esc(err.message), time: new Date().toISOString() });
  }

  document.getElementById('sendBtn').disabled = false;
  renderMessages();
}

function renderMarkdown(text) {
  // Basic markdown → HTML
  let html = esc(text);
  // Code blocks
  html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\\/li>)/gs, '<ul>$1</ul>');
  // Line breaks
  html = html.replace(/\\n/g, '<br>');
  return html;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

loadSessions();
</script>
</body>
</html>`;
