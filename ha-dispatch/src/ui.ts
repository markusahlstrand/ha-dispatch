/**
 * Dashboard UI.
 *
 * Single-file vanilla JS + Tailwind CDN. Two main views:
 *   #/             chat (default landing)
 *   #/flows        flow list & per-flow detail
 *
 * Phase 2+ swaps this for a proper bundled SPA in dist/public/.
 */

export function dashboardHtml(): string {
  return HTML
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>HA Dispatch</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .card { background: white; border-radius: 0.75rem; border: 1px solid rgb(243 244 246); padding: 1.5rem; }
  .pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }
  @keyframes pulse-dot { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }
  .chip { display: inline-flex; align-items: center; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; cursor: pointer; user-select: none; }
  .chip-off { background: #f3f4f6; color: #4b5563; }
  .chip-on { background: #2563eb; color: #fff; }
  .bubble-user { background: #2563eb; color: #fff; align-self: flex-end; border-bottom-right-radius: 0.25rem; }
  .bubble-assistant { background: #fff; color: #111827; align-self: flex-start; border: 1px solid #f3f4f6; border-bottom-left-radius: 0.25rem; }
  .bubble { padding: 0.6rem 0.85rem; border-radius: 1rem; max-width: 75%; white-space: pre-wrap; line-height: 1.4; }
</style>
</head>
<body class="bg-gray-50 min-h-screen">
<div class="max-w-5xl mx-auto p-4 sm:p-6">
  <header class="mb-6 flex items-center justify-between">
    <div class="flex items-center gap-4">
      <div>
        <h1 class="text-xl font-bold text-gray-900">HA Dispatch</h1>
        <p class="text-xs text-gray-500">Durable, AI-native automation</p>
      </div>
      <nav class="flex gap-1 ml-4">
        <a href="#/" id="tab-chat" class="px-3 py-1.5 rounded text-sm font-medium hover:bg-gray-100">Chat</a>
        <a href="#/flows" id="tab-flows" class="px-3 py-1.5 rounded text-sm font-medium hover:bg-gray-100">Flows</a>
      </nav>
    </div>
    <div class="flex items-center gap-2">
      <div id="conn-dot" class="w-2 h-2 rounded-full bg-gray-400 pulse-dot"></div>
      <span id="conn-text" class="text-sm text-gray-500">—</span>
    </div>
  </header>

  <main id="view"></main>
</div>

<script>
const view = document.getElementById('view');

const fmt = {
  time(ms) { return new Date(ms).toLocaleString(); },
  ago(ms) {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  },
  status(s) {
    const colors = { success: 'bg-green-100 text-green-700', error: 'bg-red-100 text-red-700', noop: 'bg-gray-100 text-gray-600' };
    return '<span class="px-2 py-0.5 rounded text-xs font-medium ' + (colors[s] || 'bg-gray-100') + '">' + s + '</span>';
  },
  esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); },
};

const API_BASE = (() => {
  const p = window.location.pathname;
  return (p.endsWith('/') ? p : p + '/') + 'api';
})();

async function api(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) throw new Error('API ' + path + ' failed: ' + res.status);
  return res.json();
}

async function renderHealth() {
  try {
    const h = await api('/health');
    const dot = document.getElementById('conn-dot');
    const text = document.getElementById('conn-text');
    if (h.connected) {
      dot.className = 'w-2 h-2 rounded-full bg-green-500 pulse-dot';
      text.textContent = h.llm ? 'Connected · ' + h.llm : 'Connected';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-red-500 pulse-dot';
      text.textContent = 'Disconnected from HA';
    }
  } catch (e) {
    document.getElementById('conn-dot').className = 'w-2 h-2 rounded-full bg-red-500 pulse-dot';
    document.getElementById('conn-text').textContent = 'API unreachable';
  }
}

function setActiveTab(name) {
  for (const id of ['tab-chat', 'tab-flows']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.className = 'px-3 py-1.5 rounded text-sm font-medium hover:bg-gray-100';
  }
  const active = document.getElementById('tab-' + name);
  if (active) active.className = 'px-3 py-1.5 rounded text-sm font-medium bg-gray-900 text-white';
}

// ─── CHAT ──────────────────────────────────────────────────

let chatState = { history: [], persona: null, templates: [], llmEnabled: false };

async function renderChat() {
  setActiveTab('chat');
  view.innerHTML = '<div class="text-gray-400">Loading...</div>';
  const data = await api('/chat');
  chatState = data;
  const messages = data.history.length > 0 ? data.history : (data.opening ? [data.opening] : []);
  renderChatShell(messages);
}

function renderChatShell(messages) {
  view.innerHTML = \`
    <div class="card p-0 overflow-hidden flex flex-col" style="height: calc(100vh - 180px); min-height: 480px;">
      <div id="chat-scroll" class="flex-1 overflow-y-auto p-4 flex flex-col gap-3 bg-gray-50"></div>
      <form id="chat-form" class="border-t border-gray-200 bg-white p-3 flex gap-2">
        <input id="chat-input" type="text" placeholder="Type a message..." class="flex-1 px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:border-blue-400" autocomplete="off" />
        <button class="bg-gray-900 text-white px-4 py-2 rounded text-sm hover:bg-gray-800">Send</button>
      </form>
    </div>
    <div class="text-right mt-2"><button onclick="resetChat()" class="text-xs text-gray-400 hover:text-red-600">clear conversation</button></div>
  \`;
  for (const m of messages) appendBubble(m);
  document.getElementById('chat-form').addEventListener('submit', sendMessage);
  document.getElementById('chat-input').focus();
  scrollChat();
}

function appendBubble(msg) {
  const el = document.createElement('div');
  el.className = 'flex flex-col ' + (msg.role === 'user' ? 'items-end' : 'items-start');
  el.innerHTML = '<div class="bubble bubble-' + msg.role + '">' + linkify(fmt.esc(msg.content)) + '</div>';
  document.getElementById('chat-scroll').appendChild(el);
  if (msg.attachments) {
    for (const att of msg.attachments) renderAttachment(att);
  }
  scrollChat();
}

function linkify(s) { return s.replace(/\\n/g, '<br/>'); }

function scrollChat() {
  const el = document.getElementById('chat-scroll');
  if (el) el.scrollTop = el.scrollHeight;
}

function renderAttachment(att) {
  const wrap = document.createElement('div');
  wrap.className = 'self-start max-w-full w-full';
  if (att.kind === 'persona_form') {
    wrap.innerHTML = \`
      <div class="bg-white border border-gray-200 rounded-lg p-3 mt-1">
        <form id="persona-form" class="flex flex-col sm:flex-row gap-2">
          <input name="userName" placeholder="What should I call you?" class="flex-1 px-3 py-2 border border-gray-200 rounded text-sm" />
          <input name="assistantName" placeholder="Name for me?" value="Dispatch" class="flex-1 px-3 py-2 border border-gray-200 rounded text-sm" />
          <button class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">Save</button>
        </form>
      </div>\`;
    document.getElementById('chat-scroll').appendChild(wrap);
    setTimeout(() => {
      const f = document.getElementById('persona-form');
      if (f) f.addEventListener('submit', submitNames);
    }, 0);
  } else if (att.kind === 'inventory_summary') {
    const data = att.data;
    const dom = data.domains.slice(0, 8).map(d => '<span class="chip chip-off">' + d.domain + ' · ' + d.count + '</span>').join(' ');
    const hi = data.highlights.map(h => '<li>' + fmt.esc(h) + '</li>').join('');
    wrap.innerHTML = \`
      <div class="bg-white border border-gray-200 rounded-lg p-4 mt-1">
        <div class="text-xs text-gray-400 uppercase tracking-wide mb-2">What I see</div>
        <div class="text-sm text-gray-700 mb-2">\${data.totalEntities} entities, \${data.automations.length} automations</div>
        <div class="flex flex-wrap gap-1 mb-3">\${dom}</div>
        \${hi ? '<ul class="text-sm text-gray-700 list-disc ml-5">' + hi + '</ul>' : ''}
      </div>\`;
    document.getElementById('chat-scroll').appendChild(wrap);
  } else if (att.kind === 'capability_picker') {
    const tpls = att.data.templates;
    const cards = tpls.map(t => \`
      <label class="cursor-pointer">
        <input type="checkbox" name="tpl" value="\${t.id}" class="peer hidden" />
        <div class="border border-gray-200 peer-checked:border-blue-500 peer-checked:bg-blue-50 rounded-lg p-3 hover:border-gray-300 transition">
          <div class="font-medium text-sm">\${t.name}</div>
          <div class="text-xs text-gray-500 mt-1">\${t.blurb}</div>
        </div>
      </label>\`).join('');
    wrap.innerHTML = \`
      <div class="bg-white border border-gray-200 rounded-lg p-4 mt-1">
        <div class="text-xs text-gray-400 uppercase tracking-wide mb-2">Areas I can help with — pick any that interest you</div>
        <form id="picker-form" class="grid sm:grid-cols-2 gap-2">
          \${cards}
          <div class="sm:col-span-2 mt-2 flex gap-2">
            <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">Save</button>
            <button type="button" onclick="finishOnboarding()" class="text-xs text-gray-400 hover:text-gray-700 px-2">skip</button>
          </div>
        </form>
      </div>\`;
    document.getElementById('chat-scroll').appendChild(wrap);
    setTimeout(() => {
      const f = document.getElementById('picker-form');
      if (f) f.addEventListener('submit', submitInterests);
    }, 0);
  }
}

async function submitNames(ev) {
  ev.preventDefault();
  const form = ev.target;
  const userName = form.elements.userName.value.trim();
  const assistantName = form.elements.assistantName.value.trim() || 'Dispatch';
  if (!userName) return;
  form.querySelector('button').disabled = true;
  try {
    const reply = await api('/chat/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'set_names', userName, assistantName }),
    });
    appendBubble(reply.message);
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function submitInterests(ev) {
  ev.preventDefault();
  const form = ev.target;
  const ids = [...form.querySelectorAll('input[name="tpl"]:checked')].map(i => i.value);
  form.querySelector('button[type="submit"]').disabled = true;
  try {
    const reply = await api('/chat/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'set_interests', templateIds: ids }),
    });
    appendBubble(reply.message);
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function finishOnboarding() {
  try {
    const reply = await api('/chat/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'finish_onboarding' }),
    });
    appendBubble(reply.message);
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function sendMessage(ev) {
  ev.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendBubble({ role: 'user', content: text });
  appendBubble({ role: 'assistant', content: 'thinking…' });
  try {
    const reply = await api('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    // Remove the placeholder
    const scroll = document.getElementById('chat-scroll');
    scroll.removeChild(scroll.lastChild);
    appendBubble(reply.message);
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function resetChat() {
  if (!confirm('Clear conversation history?')) return;
  await api('/chat', { method: 'DELETE' });
  renderChat();
}

// ─── FLOWS (existing, unchanged behavior) ──────────────────

async function renderFlowList() {
  setActiveTab('flows');
  view.innerHTML = '<div class="text-gray-400">Loading...</div>';
  const { flows } = await api('/flows');
  if (flows.length === 0) {
    view.innerHTML = '<div class="card text-center text-gray-500">No flows registered.</div>';
    return;
  }
  const cards = flows.map(f => {
    const last = f.lastRun
      ? '<div class="text-xs text-gray-400 mt-1">Last run: ' + fmt.ago(f.lastRun.startedAt) + ' · ' + fmt.status(f.lastRun.status) + '</div>'
      : '<div class="text-xs text-gray-400 mt-1">Never run</div>';
    const badge = f.hasMapping
      ? '<span class="px-2 py-0.5 rounded text-xs bg-green-100 text-green-700">Ready</span>'
      : '<span class="px-2 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700">Setup needed</span>';
    return \`
      <div class="card cursor-pointer hover:shadow-md transition-shadow" onclick="location.hash='#/flow/\${f.id}'">
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1">
            <h3 class="font-semibold text-gray-900">\${f.name}</h3>
            <p class="text-sm text-gray-500 mt-1">\${f.description}</p>
            \${last}
          </div>
          \${badge}
        </div>
      </div>\`;
  }).join('');
  view.innerHTML = '<div class="grid md:grid-cols-2 gap-4">' + cards + '</div><div id="suggestions"></div>';
  loadSuggestions();
}

async function loadSuggestions() {
  const container = document.getElementById('suggestions');
  if (!container) return;
  try {
    const { suggestions } = await api('/suggestions', { method: 'POST' });
    if (!suggestions || suggestions.length === 0) { container.innerHTML = ''; return; }
    const cards = suggestions.map(s => {
      const c = s.complexity === 'low' ? 'text-green-600' : s.complexity === 'medium' ? 'text-yellow-600' : 'text-red-600';
      return '<div class="card">'
        + '<h4 class="font-semibold text-gray-900">' + fmt.esc(s.name) + '</h4>'
        + '<p class="text-sm text-gray-600 mt-1">' + fmt.esc(s.description) + '</p>'
        + '<p class="text-xs text-gray-500 mt-2 italic">' + fmt.esc(s.rationale) + '</p>'
        + '<div class="text-xs text-gray-400 mt-3">Needs: ' + (s.needs || []).map(fmt.esc).join(' · ') + '</div>'
        + '<div class="text-xs mt-2"><span class="text-gray-500">Value:</span> ' + fmt.esc(s.value) + ' · <span class="' + c + '">' + s.complexity + ' complexity</span></div>'
        + '</div>';
    }).join('');
    container.innerHTML = '<h3 class="text-sm font-semibold text-gray-500 mt-8 mb-3 uppercase tracking-wide">Suggested flows</h3>'
      + '<div class="grid md:grid-cols-2 gap-4">' + cards + '</div>';
  } catch { container.innerHTML = ''; }
}

async function renderFlowDetail(id) {
  setActiveTab('flows');
  view.innerHTML = '<div class="text-gray-400">Loading...</div>';
  const flow = await api('/flows/' + id);
  const needsSetup = (flow.mapping ?? []).length === 0 && id === 'energy-optimizer';
  const configFields = (flow.configSchema ?? []).map(f => {
    const val = (flow.config && flow.config[f.key] !== undefined) ? flow.config[f.key] : (f.default ?? '');
    const input = f.type === 'number'
      ? '<input type="number" name="' + f.key + '" value="' + val + '" class="mt-1 w-full rounded border-gray-300 border px-3 py-2" />'
      : '<input type="text" name="' + f.key + '" value="' + val + '" class="mt-1 w-full rounded border-gray-300 border px-3 py-2" />';
    return '<label class="block mb-3"><span class="text-sm font-medium">' + f.label + '</span>' + input + '</label>';
  }).join('');
  const runs = (flow.lastRuns ?? []).map(r => \`
    <tr class="border-t border-gray-100">
      <td class="py-2 text-xs text-gray-500">\${fmt.time(r.startedAt)}</td>
      <td class="py-2">\${fmt.status(r.status)}</td>
      <td class="py-2 text-xs text-gray-600 truncate max-w-md">\${fmt.esc(r.summary ?? '')}</td>
    </tr>\`).join('');
  view.innerHTML = \`
    <div class="mb-6"><a href="#/flows" class="text-sm text-blue-600 hover:underline">← All flows</a></div>
    <div class="flex items-start justify-between mb-6">
      <div>
        <h2 class="text-xl font-bold">\${flow.name}</h2>
        <p class="text-gray-500 text-sm mt-1">\${flow.description}</p>
      </div>
      <div class="flex gap-2">
        \${needsSetup ? '<button onclick="startSetup(\\'' + id + '\\')" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">Setup</button>' : ''}
        <button onclick="runNow('\${id}')" class="bg-gray-900 text-white px-4 py-2 rounded text-sm hover:bg-gray-800">Run now</button>
      </div>
    </div>
    <div class="grid md:grid-cols-2 gap-4 mb-6">
      <div class="card">
        <h3 class="font-semibold mb-3">Configuration</h3>
        <form id="config-form" onsubmit="saveConfig(event, '\${id}')">
          \${configFields || '<p class="text-sm text-gray-400">No configurable options</p>'}
          \${configFields ? '<button class="mt-2 bg-gray-100 px-4 py-1.5 rounded text-sm hover:bg-gray-200">Save</button>' : ''}
        </form>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Entity mapping</h3>
        \${(flow.mapping ?? []).length === 0 ? '<p class="text-sm text-gray-400">No mapping yet</p>' : '<ul class="text-sm space-y-1">' + flow.mapping.map(m => '<li class="flex justify-between"><span class="text-gray-500">' + m.role + '</span><span class="font-mono text-xs">' + m.entityId + '</span></li>').join('') + '</ul>'}
      </div>
    </div>
    <div class="card">
      <h3 class="font-semibold mb-3">Run history</h3>
      \${runs ? '<table class="w-full text-sm"><thead><tr class="text-xs text-gray-400"><th class="text-left py-1">When</th><th class="text-left py-1">Status</th><th class="text-left py-1">Summary</th></tr></thead><tbody>' + runs + '</tbody></table>' : '<p class="text-sm text-gray-400">No runs yet</p>'}
    </div>\`;
}

async function saveConfig(ev, id) {
  ev.preventDefault();
  const form = ev.target;
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    data[el.name] = el.type === 'number' ? Number(el.value) : el.value;
  }
  await api('/flows/' + id + '/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: data }),
  });
  alert('Saved');
}

async function runNow(id) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Running...';
  try {
    const { result } = await api('/flows/' + id + '/run', { method: 'POST' });
    alert(result.status + ': ' + result.summary);
    renderFlowDetail(id);
  } catch (e) { alert('Error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Run now'; }
}

async function startSetup(id) {
  view.innerHTML = '<div class="card"><h3 class="font-semibold mb-3">Analyzing your Home Assistant setup...</h3><div class="text-sm text-gray-500">Looking for energy devices (this takes a few seconds when an LLM is configured)</div></div>';
  const { candidates, notes, source } = await api('/flows/' + id + '/discover', { method: 'POST' });
  const rows = Object.entries(candidates).map(([role, opts]) => {
    const top = opts[0];
    const label = role.replace(/_/g, ' ');
    if (!top) return '<tr class="border-t border-gray-100"><td class="py-2 text-gray-500 text-sm">' + label + '</td><td class="text-sm text-gray-400">not found</td><td></td></tr>';
    const rationale = top.rationale ? '<div class="text-xs text-gray-500 mt-1">' + fmt.esc(top.rationale) + '</div>' : '';
    return '<tr class="border-t border-gray-100 align-top">'
      + '<td class="py-2 text-gray-600 text-sm font-medium">' + label + '</td>'
      + '<td class="py-2 font-mono text-xs">' + top.entityId + rationale + '</td>'
      + '<td class="py-2 text-xs text-gray-400 whitespace-nowrap">' + Math.round(top.confidence * 100) + '%</td>'
      + '</tr>';
  }).join('');
  const badge = source === 'llm'
    ? '<span class="ml-2 px-2 py-0.5 rounded text-xs bg-purple-100 text-purple-700">AI-analyzed</span>'
    : '<span class="ml-2 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">heuristics</span>';
  const notesBlock = notes ? '<div class="bg-blue-50 border border-blue-100 rounded p-3 text-sm text-blue-900 mb-4">' + fmt.esc(notes) + '</div>' : '';
  view.innerHTML = \`
    <div class="mb-6"><a href="#/flow/\${id}" class="text-sm text-blue-600 hover:underline">← Back</a></div>
    <div class="card">
      <h3 class="font-semibold mb-3">Entity mapping\${badge}</h3>
      \${notesBlock}
      <table class="w-full mb-4">\${rows}</table>
      <button onclick='confirmMapping("\${id}", \${JSON.stringify(candidates)})' class="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700">Confirm & enable</button>
    </div>\`;
}

async function confirmMapping(id, candidates) {
  const mappings = [];
  for (const [role, opts] of Object.entries(candidates)) {
    if (opts[0]) mappings.push({ role, entityId: opts[0].entityId, confidence: opts[0].confidence });
  }
  await api('/flows/' + id + '/mapping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mappings }),
  });
  location.hash = '#/flow/' + id;
}

// ─── ROUTER ────────────────────────────────────────────────

function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/flow/')) renderFlowDetail(hash.slice(7));
  else if (hash === '#/flows') renderFlowList();
  else renderChat();
}

window.addEventListener('hashchange', route);
window.addEventListener('load', () => {
  route();
  renderHealth();
  setInterval(renderHealth, 15000);
});
</script>
</body>
</html>`
