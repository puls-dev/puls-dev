export const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Puls Importer</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: radial-gradient(ellipse at 70% 0%, #0f0a2e 0%, #030712 55%);
    }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
    #btn-save:disabled { opacity: .45; cursor: not-allowed; }

    /* ── Tree connector lines ──────────────────────────────────────────────── */
    .tree ul {
      list-style-type: none;
      margin: 0;
      padding: 0;
      padding-left: 20px;
      position: relative;
    }
    .tree > ul {
      padding-left: 0;
    }
    .tree ul li {
      position: relative;
    }
    .tree ul li::before {
      content: '';
      position: absolute;
      top: 0;
      left: -10px;
      border-left: 1px solid #1e293b;
      height: 100%;
      width: 1px;
    }
    .tree ul li:last-child::before {
      height: 14px;
    }
    .tree ul li::after {
      content: '';
      position: absolute;
      top: 14px;
      left: -10px;
      border-top: 1px solid #1e293b;
      width: 10px;
      height: 1px;
    }
    .collapsed-content {
      display: none !important;
    }
  </style>
</head>
<body class="text-slate-100 h-screen overflow-hidden flex flex-col select-none">

<!-- Header -->
<header class="h-14 shrink-0 border-b border-slate-800/80 bg-slate-950/70 backdrop-blur flex items-center justify-between px-5 z-20">
  <div class="flex items-center gap-3">
    <div class="h-7 w-7 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-sm shadow-md shadow-indigo-500/30">P</div>
    <div>
      <h1 class="text-sm font-bold leading-none bg-gradient-to-r from-indigo-200 to-purple-300 bg-clip-text text-transparent">Puls Importer</h1>
      <p class="text-[10px] text-slate-500 leading-none mt-0.5">Interactive Cloud Migration</p>
    </div>
  </div>
  <div id="scan-status" class="flex items-center gap-2 text-[11px]">
    <span id="scan-spinner" class="relative flex h-2 w-2 mr-1">
      <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
      <span class="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
    </span>
    <span id="scan-providers" class="flex items-center gap-2 text-slate-400"></span>
  </div>
</header>

<!-- Layout -->
<main class="flex-1 flex overflow-hidden">

  <!-- Left Sidebar: Actions & Config -->
  <aside class="w-72 shrink-0 border-r border-slate-800/60 bg-slate-950/30 flex flex-col justify-between">
    <div class="p-4 space-y-4">
      <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Configuration</h2>

      <!-- Strategy -->
      <div class="space-y-1.5">
        <label class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Output Layout</label>
        <select id="strategy" class="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors">
          <option value="By Tier">By Tier — network / db / compute stacks</option>
          <option value="Flat File">Flat File — single infra.ts</option>
        </select>
      </div>

      <!-- Quick Actions -->
      <div class="space-y-1.5 border-t border-slate-800/60 pt-3">
        <label class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Adoption Selection</label>
        <div class="flex gap-2">
          <button id="btn-all" class="flex-1 text-[11px] bg-slate-900 border border-slate-800 hover:border-indigo-500 py-1.5 rounded-lg text-slate-300 font-medium transition-colors">Adopt All</button>
          <button id="btn-none" class="flex-1 text-[11px] bg-slate-900 border border-slate-800 hover:border-slate-700 py-1.5 rounded-lg text-slate-500 hover:text-slate-400 font-medium transition-colors">Deselect All</button>
        </div>
        <p class="text-[10px] text-slate-600 mt-1">Adopted resources: <span id="selected-count" class="font-semibold text-indigo-400">0</span></p>
      </div>
    </div>

    <!-- Action footer -->
    <div class="p-4 border-t border-slate-800/60 bg-slate-950/60">
      <button id="btn-save" disabled
        class="w-full bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold py-2.5 rounded-xl text-sm transition-all shadow-lg shadow-indigo-500/10 hover:shadow-indigo-500/20">
        Select resources to begin
      </button>
    </div>
  </aside>

  <!-- Center Panel: Grouped Resource Tree -->
  <section class="flex-1 flex flex-col bg-slate-950/10 overflow-hidden">
    <div class="p-5 border-b border-slate-800/60 flex items-center justify-between shrink-0">
      <div>
        <h2 class="text-lg font-bold text-slate-100">Resource Groups</h2>
        <p class="text-xs text-slate-500 mt-0.5">Browse by service type · click to inspect · check to adopt</p>
      </div>
      <div class="flex items-center gap-3">
        <!-- Search -->
        <div class="relative w-56">
          <input id="tree-search" type="text" placeholder="filter resources…" spellcheck="false"
            class="w-full bg-slate-900 border border-slate-800 rounded-lg pl-3.5 pr-8 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors">
        </div>

        <!-- Expansion controls -->
        <button id="btn-expand-all" class="text-xs bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 font-semibold px-3.5 py-1.5 rounded-lg transition-colors">Expand All</button>
        <button id="btn-collapse-all" class="text-xs bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 font-semibold px-3.5 py-1.5 rounded-lg transition-colors">Collapse All</button>
      </div>
    </div>

    <!-- Scrollable Tree Container -->
    <div class="flex-1 overflow-y-auto p-4">
      <div class="tree max-w-4xl mx-auto">
        <ul id="tree-root">
          <li class="text-slate-500 text-xs italic p-4">Scanning resources…</li>
        </ul>
      </div>
    </div>
  </section>

  <!-- Right Sidebar: Inspector -->
  <aside class="w-72 shrink-0 border-l border-slate-800/60 bg-slate-950/30 flex flex-col">
    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Inspector</h2>

      <div id="inspector" class="hidden space-y-3">
        <div class="border-t border-slate-800 pt-3">
          <div class="flex items-center justify-between mb-2">
            <span id="inspect-badge" class="text-[9px] font-bold tracking-wider px-2 py-0.5 rounded uppercase"></span>
            <div class="flex items-center gap-1.5">
              <input type="checkbox" id="inspect-adopt" class="accent-indigo-500 cursor-pointer">
              <label for="inspect-adopt" class="text-[10px] font-semibold text-indigo-400 cursor-pointer select-none">Adopt</label>
            </div>
          </div>
          <h3 id="inspect-name" class="text-sm font-semibold text-slate-100 truncate"></h3>
          <div class="flex items-center justify-between mt-1">
            <span id="inspect-id" class="text-[10px] text-slate-500 font-mono"></span>
            <span id="inspect-provider" class="text-[9px] text-slate-600 font-mono uppercase"></span>
          </div>
        </div>
        <div class="space-y-1.5">
          <label class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">TS Property Name</label>
          <input id="inspect-rename" type="text" spellcheck="false"
            class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-indigo-300 font-mono focus:outline-none focus:border-indigo-500 transition-colors">
        </div>
        <div class="space-y-1.5 border-t border-slate-800/60 pt-3">
          <label class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Direct Connections</label>
          <div id="inspect-deps-list" class="space-y-1 max-h-24 overflow-y-auto"></div>
        </div>
        <div id="inspect-props" class="text-[10px] text-slate-500 space-y-1 bg-slate-900/40 border border-slate-800/60 rounded-lg p-2.5 max-h-44 overflow-y-auto"></div>
      </div>

      <div id="inspector-hint" class="text-[11px] text-slate-600 text-center py-6 border border-dashed border-slate-800 rounded-xl">
        Select a resource in the tree to inspect details
      </div>
    </div>
  </aside>

</main>

<!-- Toast container -->
<div id="toast-root" class="fixed bottom-6 inset-x-0 flex justify-center pointer-events-none z-50"></div>

<script>
(function() {
  const token = new URLSearchParams(location.search).get('token');

  // ── State ──────────────────────────────────────────────────────────────────
  const allResources  = [];
  const selectedIds   = new Set();
  const renames       = {};
  let   activeId      = null;
  const scanProviders = {};

  // ── Type label mapping ──────────────────────────────────────────────────────
  const TYPE_LABELS = {
    'AWS.S3':              'S3 Buckets',
    'AWS.EC2':             'EC2 Instances',
    'AWS.RDS':             'RDS Instances',
    'AWS.CloudFront':      'CloudFront Distributions',
    'AWS.Route53':         'Route53 Zones',
    'AWS.Lambda':          'Lambda Functions',
    'AWS.ECS':             'ECS Services',
    'AWS.EKS':             'EKS Clusters',
    'DO.Droplet':          'Droplets',
    'DO.Firewall':         'Firewalls',
    'DO.LoadBalancer':     'Load Balancers',
    'DO.Database':         'Managed Databases',
    'DO.Kubernetes':       'Kubernetes Clusters',
    'DO.Volume':           'Volumes',
    'Proxmox.VM':          'Virtual Machines',
    'Proxmox.Template':    'Templates',
    'HCloud.Server':       'Servers',
    'HCloud.Volume':       'Volumes',
    'HCloud.Network':      'Networks',
    'HCloud.LoadBalancer': 'Load Balancers',
    'HCloud.Firewall':     'Firewalls',
  };

  function getTypeLabel(type) {
    return TYPE_LABELS[type] || (type.split('.').pop() || type) + 's';
  }

  // ── Grouped tree ──────────────────────────────────────────────────────────
  const TIER_ORDER = { network: 0, database: 1, compute: 2 };

  function buildGroupedTree(resources, searchQuery) {
    const q = (searchQuery || '').toLowerCase().trim();
    const groups = {};
    resources.forEach(res => {
      if (q && !res.name.toLowerCase().includes(q) && !res.type.toLowerCase().includes(q)) return;
      if (!groups[res.type]) {
        groups[res.type] = { type: res.type, label: getTypeLabel(res.type), tier: res.tier, resources: [] };
      }
      groups[res.type].resources.push(res);
    });
    return Object.values(groups).sort((a, b) => {
      const td = (TIER_ORDER[a.tier] ?? 3) - (TIER_ORDER[b.tier] ?? 3);
      return td !== 0 ? td : a.label.localeCompare(b.label);
    });
  }

  function rebuildTree() {
    const treeRoot = document.getElementById('tree-root');
    treeRoot.innerHTML = '';
    const searchQuery = document.getElementById('tree-search').value;
    const groups = buildGroupedTree(allResources, searchQuery);
    if (groups.length === 0) {
      treeRoot.innerHTML = '<li class="text-slate-500 text-xs italic p-4">' +
        (allResources.length ? 'No results for that filter.' : 'No resources discovered yet.') +
        '</li>';
      return;
    }
    groups.forEach(group => treeRoot.appendChild(renderTypeGroup(group)));
  }

  function renderTypeGroup(group) {
    const li = document.createElement('li');
    li.className = 'select-none mb-px';

    // ── Group header ────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer hover:bg-slate-800/30 transition-colors';

    const toggleSpan = document.createElement('span');
    toggleSpan.className = 'group-toggle w-4 h-4 flex items-center justify-center text-slate-500 font-mono text-[10px] shrink-0';
    const collapsed = group.resources.length > 10;
    toggleSpan.textContent = collapsed ? '▶' : '▼';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'text-xs font-semibold text-slate-200 flex-1';
    labelSpan.textContent = group.label;

    const countBadge = document.createElement('span');
    countBadge.className = 'text-[10px] bg-slate-800 text-slate-500 px-1.5 py-0.5 rounded font-mono tabular-nums';
    countBadge.textContent = group.resources.length;

    const groupCb = document.createElement('input');
    groupCb.type = 'checkbox';
    groupCb.className = 'accent-indigo-500 shrink-0 cursor-pointer';
    groupCb.setAttribute('data-group-type', group.type);
    const selCount = group.resources.filter(r => selectedIds.has(String(r.id))).length;
    groupCb.checked     = selCount === group.resources.length && group.resources.length > 0;
    groupCb.indeterminate = selCount > 0 && selCount < group.resources.length;
    groupCb.addEventListener('click', (e) => {
      e.stopPropagation();
      const allSel = group.resources.every(r => selectedIds.has(String(r.id)));
      group.resources.forEach(r => {
        if (allSel) selectedIds.delete(String(r.id));
        else        selectedIds.add(String(r.id));
      });
      refreshCheckboxes(); updateGenerateButton(); saveSession();
    });

    header.appendChild(toggleSpan);
    header.appendChild(labelSpan);
    header.appendChild(countBadge);
    header.appendChild(groupCb);

    // ── Resource list ───────────────────────────────────────────────────────
    const ul = document.createElement('ul');
    if (collapsed) ul.classList.add('collapsed-content');
    group.resources.forEach(res => ul.appendChild(renderResourceRow(res)));

    header.addEventListener('click', (e) => {
      if (e.target === groupCb) return;
      ul.classList.toggle('collapsed-content');
      toggleSpan.textContent = ul.classList.contains('collapsed-content') ? '▶' : '▼';
    });

    li.appendChild(header);
    li.appendChild(ul);
    return li;
  }

  function renderResourceRow(res) {
    const li = document.createElement('li');
    li.className = 'select-none';

    const row = document.createElement('div');
    row.className = 'flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-slate-900/60 cursor-pointer transition-colors border border-transparent';
    row.setAttribute('data-id', res.id);
    if (String(activeId) === String(res.id)) row.className += ' bg-indigo-600/10 border-indigo-500/20';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'accent-indigo-500 shrink-0 cursor-pointer';
    cb.checked = selectedIds.has(String(res.id));
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cb.checked) selectedIds.add(String(res.id));
      else            selectedIds.delete(String(res.id));
      refreshCheckboxes(); updateGenerateButton(); saveSession();
    });

    const tierDot = document.createElement('span');
    tierDot.className = 'w-2 h-2 rounded-full shrink-0 ' +
      (res.tier === 'network'  ? 'bg-blue-500'    :
       res.tier === 'database' ? 'bg-emerald-500' :
                                 'bg-purple-500');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'text-xs text-slate-200 truncate flex-1';
    nameSpan.textContent = res.name;

    const propSpan = document.createElement('span');
    propSpan.className = 'text-[10px] text-indigo-400 font-mono truncate leading-none prop-label shrink-0';
    propSpan.textContent = renames[res.id] || res.propertyName;

    row.appendChild(cb);
    row.appendChild(tierDot);
    row.appendChild(nameSpan);
    row.appendChild(propSpan);

    row.addEventListener('click', (e) => {
      if (e.target === cb) return;
      document.querySelectorAll('.tree [data-id]').forEach(el => el.classList.remove('bg-indigo-600/10', 'border-indigo-500/20'));
      row.classList.add('bg-indigo-600/10', 'border-indigo-500/20');
      inspectResource(String(res.id));
    });

    li.appendChild(row);
    return li;
  }

  function focusNode(id) {
    activeId = id;
    const nodeEl = document.querySelector('[data-id="' + id + '"]');
    if (nodeEl) {
      // Expand any collapsed group ancestor
      let parentUl = nodeEl.parentElement?.parentElement;
      while (parentUl && parentUl.tagName === 'UL') {
        if (parentUl.classList.contains('collapsed-content')) {
          parentUl.classList.remove('collapsed-content');
          const toggle = parentUl.previousElementSibling?.querySelector('.group-toggle');
          if (toggle) toggle.textContent = '▼';
        }
        parentUl = parentUl.parentElement?.parentElement;
      }
      document.querySelectorAll('.tree [data-id]').forEach(el => el.classList.remove('bg-indigo-600/10', 'border-indigo-500/20'));
      nodeEl.classList.add('bg-indigo-600/10', 'border-indigo-500/20');
      nodeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    inspectResource(id);
  }

  document.getElementById('btn-expand-all').addEventListener('click', () => {
    document.querySelectorAll('.tree ul').forEach(ul => ul.classList.remove('collapsed-content'));
    document.querySelectorAll('.tree .group-toggle').forEach(s => { s.textContent = '▼'; });
  });

  document.getElementById('btn-collapse-all').addEventListener('click', () => {
    document.querySelectorAll('.tree ul').forEach(ul => ul.classList.add('collapsed-content'));
    document.querySelectorAll('.tree .group-toggle').forEach(s => { s.textContent = '▶'; });
  });

  document.getElementById('tree-search').addEventListener('input', rebuildTree);

  // ── Inspector ──────────────────────────────────────────────────────────────
  function inspectResource(id) {
    activeId = id;
    const res = allResources.find(r => String(r.id) === id);
    if (!res) return;
    document.getElementById('inspector-hint').classList.add('hidden');
    document.getElementById('inspector').classList.remove('hidden');

    const badge = document.getElementById('inspect-badge');
    badge.textContent = res.type;
    badge.className = 'text-[9px] font-bold tracking-wider px-2 py-0.5 rounded uppercase ' +
      (res.tier === 'network'  ? 'bg-blue-900/50 text-blue-300'    :
       res.tier === 'database' ? 'bg-emerald-900/50 text-emerald-300' :
                                 'bg-violet-900/50 text-violet-300');

    document.getElementById('inspect-adopt').checked = selectedIds.has(id);
    document.getElementById('inspect-provider').textContent = res.provider;
    document.getElementById('inspect-name').textContent = res.name;
    document.getElementById('inspect-id').textContent = 'id: ' + res.id;
    document.getElementById('inspect-rename').value = renames[id] || res.propertyName;

    const depsContainer = document.getElementById('inspect-deps-list');
    depsContainer.innerHTML = '';
    const connectedIds = new Set();

    allResources.forEach(other => {
      if (String(other.id) === id) return;
      let linked = false;

      // VPC / subnet membership
      if (res.original?.vpc_uuid === other.id || res.original?.vpcId === other.id || res.original?.subnetId === other.id) linked = true;
      if (other.original?.vpc_uuid === id  || other.original?.vpcId === id  || other.original?.subnetId === id)  linked = true;

      // CloudFront → Route53 / S3
      if (res.type === 'AWS.CloudFront') {
        const aliases = res.original?.aliases || [];
        const origins = res.original?.origins || [];
        if (other.type === 'AWS.Route53' && aliases.some(a => a.endsWith(other.name.replace(/\\.$/, '')))) linked = true;
        if (other.type === 'AWS.S3'      && origins.some(o => o.domainName && o.domainName.includes(other.name))) linked = true;
      }
      if (other.type === 'AWS.CloudFront') {
        const aliases = other.original?.aliases || [];
        const origins = other.original?.origins || [];
        if (res.type === 'AWS.Route53' && aliases.some(a => a.endsWith(res.name.replace(/\\.$/, '')))) linked = true;
        if (res.type === 'AWS.S3'      && origins.some(o => o.domainName && o.domainName.includes(res.name))) linked = true;
      }

      // DO.Firewall ↔ DO.Droplet
      if (res.type === 'DO.Firewall' && other.type === 'DO.Droplet') {
        if ((res.original?.dropletIds || []).some(d => String(d) === String(other.id))) linked = true;
      }
      if (other.type === 'DO.Firewall' && res.type === 'DO.Droplet') {
        if ((other.original?.dropletIds || []).some(d => String(d) === String(res.id))) linked = true;
      }

      if (linked) connectedIds.add(String(other.id));
    });

    if (connectedIds.size === 0) {
      depsContainer.innerHTML = '<p class="text-[10px] text-slate-600 italic">No direct connections</p>';
    } else {
      connectedIds.forEach(otherId => {
        const other = allResources.find(r => String(r.id) === otherId);
        if (!other) return;
        const btn = document.createElement('button');
        btn.className = 'w-full text-left text-[10px] text-indigo-400 hover:text-indigo-300 truncate hover:underline bg-transparent border-none p-0 cursor-pointer py-0.5 block';
        btn.innerHTML = '🔗 <span class="text-slate-500 font-mono text-[9px]">[' + other.type + ']</span> ' + other.name;
        btn.addEventListener('click', (e) => { e.stopPropagation(); focusNode(otherId); });
        depsContainer.appendChild(btn);
      });
    }

    const propsEl = document.getElementById('inspect-props');
    propsEl.innerHTML = '';
    if (res.original) {
      Object.entries(res.original).forEach(([k, v]) => {
        if (typeof v === 'object' && v !== null) return;
        const p = document.createElement('p');
        p.innerHTML = '<span class="text-slate-600">' + k + ':</span> ' + v;
        propsEl.appendChild(p);
      });
    }
  }

  document.getElementById('inspect-adopt').addEventListener('change', (e) => {
    if (!activeId) return;
    if (e.target.checked) selectedIds.add(String(activeId));
    else                  selectedIds.delete(String(activeId));
    refreshCheckboxes(); updateGenerateButton(); saveSession();
  });

  document.getElementById('inspect-rename').addEventListener('input', (e) => {
    if (!activeId) return;
    const sanitized = e.target.value.replace(/[^a-zA-Z0-9]/g, '_').replace(/^([0-9])/, '_$1');
    renames[activeId] = sanitized;
    const row = document.querySelector('.tree [data-id="' + activeId + '"]');
    if (row) { const lbl = row.querySelector('.prop-label'); if (lbl) lbl.textContent = sanitized || ''; }
    saveSession();
  });

  function addStandaloneCard(res) {
    allResources.push(res);
    rebuildTree();
    refreshCheckboxes();
  }

  function addGroupCard(group) {
    group.resources.forEach(res => allResources.push(res));
    rebuildTree();
    refreshCheckboxes();
  }

  function refreshCheckboxes() {
    document.getElementById('selected-count').textContent = selectedIds.size;
    const adoptCb = document.getElementById('inspect-adopt');
    if (activeId && adoptCb) adoptCb.checked = selectedIds.has(String(activeId));

    // Individual resource rows
    document.querySelectorAll('.tree [data-id] input[type="checkbox"]').forEach(cb => {
      const row = cb.closest('[data-id]');
      if (row) cb.checked = selectedIds.has(String(row.getAttribute('data-id')));
    });

    // Group header checkboxes
    document.querySelectorAll('[data-group-type]').forEach(cb => {
      const type   = cb.getAttribute('data-group-type');
      const bucket = allResources.filter(r => r.type === type);
      const sel    = bucket.filter(r => selectedIds.has(String(r.id))).length;
      cb.checked      = sel === bucket.length && bucket.length > 0;
      cb.indeterminate = sel > 0 && sel < bucket.length;
    });
  }

  // ── All / None ─────────────────────────────────────────────────────────────
  document.getElementById('btn-all').addEventListener('click', () => {
    allResources.forEach(r => selectedIds.add(String(r.id)));
    refreshCheckboxes(); updateGenerateButton(); saveSession();
  });
  document.getElementById('btn-none').addEventListener('click', () => {
    selectedIds.clear();
    refreshCheckboxes(); updateGenerateButton(); saveSession();
  });

  // ── Generate button ────────────────────────────────────────────────────────
  function updateGenerateButton() {
    const btn = document.getElementById('btn-save');
    const n = selectedIds.size;
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? 'Select resources to begin' : 'Generate ' + n + ' resource' + (n !== 1 ? 's' : '') + '  →';
  }

  document.getElementById('btn-save').addEventListener('click', async () => {
    const btn = document.getElementById('btn-save');
    btn.textContent = 'Writing files…';
    btn.disabled = true;
    try {
      const r = await fetch('/api/save?token=' + token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedIds: Array.from(selectedIds),
          renames,
          strategy: document.getElementById('strategy').value,
        }),
      });
      if (r.ok) {
        const { count } = await r.json();
        toast('✅  ' + count + ' file' + (count !== 1 ? 's' : '') + ' written to infra/ — you can close this tab', false);
        btn.textContent = 'Done ✓';
      } else {
        toast('❌  ' + await r.text(), true);
        btn.disabled = false;
        updateGenerateButton();
      }
    } catch (err) {
      toast('❌  Network error: ' + err.message, true);
      btn.disabled = false;
      updateGenerateButton();
    }
  });

  // ── Toast ──────────────────────────────────────────────────────────────────
  function toast(msg, isError) {
    const el = document.createElement('div');
    el.className = 'pointer-events-auto px-5 py-3 rounded-xl text-xs font-semibold shadow-2xl border transition-opacity duration-300 ' +
      (isError ? 'bg-red-950 border-red-800 text-red-200' : 'bg-emerald-950 border-emerald-800 text-emerald-200');
    el.textContent = msg;
    document.getElementById('toast-root').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 350); }, 5000);
  }

  // ── Scan Status ────────────────────────────────────────────────────────────
  function updateScanStatus(data) {
    if (data.provider) {
      if (!scanProviders[data.provider]) scanProviders[data.provider] = { status: 'pending', count: 0 };
      scanProviders[data.provider].status = data.status;
      if (data.count !== undefined) scanProviders[data.provider].count = data.count;
      if (data.status === 'error' && data.message) toast('Scan failed for ' + data.provider + ': ' + data.message, true);
    }
    document.getElementById('scan-providers').innerHTML = Object.entries(scanProviders).map(([name, info]) => {
      const icon  = info.status === 'done' ? '✓' : info.status === 'scanning' ? '⠸' : info.status === 'error' ? '✗' : '·';
      const count = info.count > 0 ? ' <span class="text-slate-600">(' + info.count + ')</span>' : '';
      const cls   = info.status === 'done' ? 'text-emerald-400' : info.status === 'error' ? 'text-red-400' : info.status === 'scanning' ? 'text-indigo-400' : 'text-slate-700';
      return '<span class="' + cls + '">' + icon + ' ' + name + count + '</span>';
    }).join('<span class="text-slate-800 mx-1">·</span>');
  }

  // ── Session ────────────────────────────────────────────────────────────────
  async function saveSession() {
    await fetch('/api/session?token=' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedIds: Array.from(selectedIds), renames, strategy: document.getElementById('strategy').value }),
    }).catch(() => {});
  }

  async function loadSession() {
    try {
      const r = await fetch('/api/session?token=' + token);
      if (!r.ok) return;
      const data = await r.json();
      if (data.selectedIds?.length) {
        data.selectedIds.forEach(id => selectedIds.add(String(id)));
        if (data.renames)   Object.assign(renames, data.renames);
        if (data.strategy)  document.getElementById('strategy').value = data.strategy;
        rebuildTree(); refreshCheckboxes(); updateGenerateButton();
        toast('Session restored — ' + selectedIds.size + ' resource' + (selectedIds.size !== 1 ? 's' : '') + ' pre-selected', false);
      }
    } catch {}
  }

  // ── SSE ────────────────────────────────────────────────────────────────────
  const sse = new EventSource('/api/stream?token=' + token);
  sse.addEventListener('progress', e => updateScanStatus(JSON.parse(e.data)));
  sse.addEventListener('group',    e => addGroupCard(JSON.parse(e.data)));
  sse.addEventListener('resource', e => addStandaloneCard(JSON.parse(e.data)));
  sse.addEventListener('done', async () => {
    sse.close();
    document.getElementById('scan-spinner').classList.add('hidden');
    Object.keys(scanProviders).forEach(p => { if (scanProviders[p].status !== 'error') scanProviders[p].status = 'done'; });
    updateScanStatus({});
    rebuildTree();
    await loadSession();
  });
})();
</script>
</html>`;
