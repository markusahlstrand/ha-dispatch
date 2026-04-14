/**
 * Dashboard UI — served as a single HTML page.
 *
 * Phase 1: vanilla JS + Tailwind CDN, single-file, no build step for the UI.
 * Phase 2+: swap for a proper React/Svelte bundle in dist/public/.
 *
 * Views:
 *  - Flow list (home)
 *  - Flow detail (config + run history + manual trigger)
 *  - Setup wizard (discovery → review → save mapping)
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
  @keyframes pulse-dot { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }
  .pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }
</style>
</head>
<body class="bg-gray-50 min-h-screen">
<div class="max-w-6xl mx-auto p-4 sm:p-6">
  <header class="mb-8 flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-gray-900">HA Dispatch</h1>
      <p class="text-gray-500 mt-1">Durable automation for Home Assistant</p>
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
  time(ms) {
    const d = new Date(ms);
    return d.toLocaleString();
  },
  ago(ms) {
    const diff = Date.now() - ms;
    const s = Math.floor(diff/1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s/60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m/60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h/24) + 'd ago';
  },
  status(s) {
    const colors = { success: 'bg-green-100 text-green-700', error: 'bg-red-100 text-red-700', noop: 'bg-gray-100 text-gray-600' };
    return '<span class="px-2 py-0.5 rounded text-xs font-medium ' + (colors[s] || 'bg-gray-100') + '">' + s + '</span>';
  },
};

async function api(path, opts) {
  const res = await fetch('/api' + path, opts);
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
      text.textContent = 'Connected to HA';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-red-500 pulse-dot';
      text.textContent = 'Disconnected';
    }
  } catch (e) {
    const dot = document.getElementById('conn-dot');
    dot.className = 'w-2 h-2 rounded-full bg-red-500 pulse-dot';
    document.getElementById('conn-text').textContent = 'API unreachable';
  }
}

async function renderFlowList() {
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
      </div>
    \`;
  }).join('');

  view.innerHTML = '<div class="grid md:grid-cols-2 gap-4">' + cards + '</div>';
}

async function renderFlowDetail(id) {
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
      <td class="py-2 text-xs text-gray-600 truncate max-w-md">\${r.summary ?? ''}</td>
    </tr>
  \`).join('');

  view.innerHTML = \`
    <div class="mb-6">
      <a href="#/" class="text-sm text-blue-600 hover:underline">← All flows</a>
    </div>
    <div class="flex items-start justify-between mb-6">
      <div>
        <h2 class="text-xl font-bold">\${flow.name}</h2>
        <p class="text-gray-500 text-sm mt-1">\${flow.description}</p>
      </div>
      <div class="flex gap-2">
        \${needsSetup ? '<button onclick="startSetup(\\\'' + id + '\\\')" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">Setup</button>' : ''}
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
        \${(flow.mapping ?? []).length === 0
          ? '<p class="text-sm text-gray-400">No mapping yet</p>'
          : '<ul class="text-sm space-y-1">' + flow.mapping.map(m => '<li class="flex justify-between"><span class="text-gray-500">' + m.role + '</span><span class="font-mono text-xs">' + m.entityId + '</span></li>').join('') + '</ul>'}
      </div>
    </div>

    <div class="card">
      <h3 class="font-semibold mb-3">Run history</h3>
      \${runs ? '<table class="w-full text-sm"><thead><tr class="text-xs text-gray-400"><th class="text-left py-1">When</th><th class="text-left py-1">Status</th><th class="text-left py-1">Summary</th></tr></thead><tbody>' + runs + '</tbody></table>' : '<p class="text-sm text-gray-400">No runs yet</p>'}
    </div>
  \`;
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
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run now';
  }
}

async function startSetup(id) {
  view.innerHTML = '<div class="card"><h3 class="font-semibold mb-3">Scanning Home Assistant...</h3><div class="text-sm text-gray-500">Looking for energy devices</div></div>';
  const { candidates } = await api('/flows/' + id + '/discover', { method: 'POST' });

  const rows = Object.entries(candidates).map(([role, opts]) => {
    const top = opts[0];
    const label = role.replace(/_/g, ' ');
    if (!top) return '<tr><td class="py-2 text-gray-500">' + label + '</td><td class="text-sm text-gray-400">not found</td><td></td></tr>';
    return '<tr class="border-t border-gray-100"><td class="py-2 text-gray-500 text-sm">' + label + '</td><td class="py-2 font-mono text-xs">' + top.entityId + '</td><td class="py-2 text-xs text-gray-400">' + Math.round(top.confidence*100) + '%</td></tr>';
  }).join('');

  view.innerHTML = \`
    <div class="mb-6">
      <a href="#/flow/\${id}" class="text-sm text-blue-600 hover:underline">← Back</a>
    </div>
    <div class="card">
      <h3 class="font-semibold mb-3">Found these devices</h3>
      <table class="w-full mb-4">\${rows}</table>
      <button onclick="confirmMapping('\${id}', \${JSON.stringify(candidates).replace(/"/g,'&quot;')})" class="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700">Confirm & enable</button>
    </div>
  \`;
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

function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/flow/')) {
    renderFlowDetail(hash.slice(7));
  } else {
    renderFlowList();
  }
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
