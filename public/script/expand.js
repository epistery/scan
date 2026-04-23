/**
 * ExpandResult — Shared tabbed detail view for search result cards.
 * Used by both index.html (search) and discovery.html.
 *
 * Each page calls ExpandResult.init({ cache, fetchManifest }) once,
 * then uses onclick="ExpandResult.toggle('id')" in card templates.
 */
const ExpandResult = (function () {
  let _expandId = null;
  let _eventCache = {};
  let _aceEditor = null;
  let _aceLoaded = false;
  let _config = { cache: {}, fetchManifest: null };

  // ---- Shared result helpers (moved from page scripts) ----

  function getTrustBadge(r) {
    if (r.trustScore != null) {
      const score = r.trustScore;
      if (score >= 75) return '<span class="badge badge-verified">Verified</span>';
      if (score >= 50) return '<span class="badge badge-trusted">Trusted</span>';
      if (score >= 25) return '<span class="badge badge-claimed">Claimed</span>';
      if (score >= 1)  return '<span class="badge badge-discovered">Discovered</span>';
      return '<span class="badge badge-open">Open</span>';
    }
    if (r.signature?.verified) return '<span class="badge badge-verified">Verified</span>';
    if (r.signature?.signed)   return '<span class="badge badge-signed">Signed</span>';
    return '<span class="badge badge-open">Open</span>';
  }

  function renderSignalDots(signals) {
    if (!signals) return '';
    const names = ['manifest','selfSigned','hashValid','contractExists','domainBinding','dnsVerified','platform'];
    const dots = names.map(n => {
      const on = signals[n]?.present;
      return `<span class="signal-dot ${on ? 'on' : 'off'}" title="${n}"></span>`;
    }).join('');
    return `<span class="signal-dots">${dots}</span>`;
  }

  function renderCapabilities(caps) {
    if (!caps) return '';
    const available = [];
    for (const [key, val] of Object.entries(caps)) {
      if (val && (val === true || val.available)) {
        available.push(key);
      }
    }
    if (available.length === 0) return '';
    return `<div class="result-capabilities">${available.map(c => `<span class="cap-tag">${escapeHtml(c)}</span>`).join('')}</div>`;
  }

  // ---- Wallet helpers ----

  const NATIVE_CURRENCY = {
    polygon: 'MATIC', ethereum: 'ETH', sepolia: 'ETH',
    'polygon-amoy': 'MATIC', japanopenchain: 'JOC'
  };

  function formatBalance(weiStr, decimals) {
    decimals = decimals || 18;
    const num = Number(weiStr) / Math.pow(10, decimals);
    if (num === 0) return '0';
    if (num < 0.001 && num > 0) return num.toExponential(2);
    return num.toFixed(4).replace(/\.?0+$/, '');
  }

  // ---- Tab configuration per entity type ----

  function getTabsForType(r) {
    const type = r.type || 'AIDiscovery';
    if (type === 'Wallet' || type === 'Contract') {
      return [
        { id: 'overview', label: 'Overview' },
        { id: 'activity', label: 'Activity' },
        { id: 'manifest', label: 'Raw' }
      ];
    }
    if (type === 'MCPService') {
      return [
        { id: 'overview', label: 'Overview' },
        { id: 'manifest', label: 'Manifest' }
      ];
    }
    return [
      { id: 'overview', label: 'Overview' },
      { id: 'trust',    label: 'Trust' },
      { id: 'activity', label: 'Activity' },
      { id: 'manifest', label: 'Manifest' }
    ];
  }

  // ---- Core expand/collapse ----

  function toggle(entityId) {
    // Collapse if same
    if (_expandId === entityId) {
      closeExpand();
      return;
    }
    // Collapse previous
    closeExpand();

    const card = document.getElementById('card-' + entityId);
    if (!card) return;

    const r = _config.cache[entityId];
    if (!r) return;

    _expandId = entityId;

    const panel = document.createElement('div');
    panel.className = 'expand-panel';
    panel.id = 'expand-panel';

    const tabs = getTabsForType(r);
    panel.innerHTML = renderTabs(tabs) + '<div class="expand-body" id="expand-body"></div>';
    card.appendChild(panel);

    switchTab(tabs[0].id, entityId);
  }

  function closeExpand() {
    const panel = document.getElementById('expand-panel');
    if (panel) panel.remove();
    _expandId = null;
    // Clean up ACE instance
    if (_aceEditor) {
      _aceEditor.destroy();
      _aceEditor = null;
    }
  }

  // ---- Tab bar ----

  function renderTabs(tabs) {
    const items = tabs.map(t =>
      `<button class="expand-tab" data-tab="${t.id}" onclick="ExpandResult.switchTab('${t.id}','${escapeAttr(_expandId)}')">${t.label}</button>`
    ).join('');
    return `<div class="expand-tabs">${items}</div>`;
  }

  function switchTab(tabId, entityId) {
    // Update active tab button
    const panel = document.getElementById('expand-panel');
    if (!panel) return;
    panel.querySelectorAll('.expand-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    const body = document.getElementById('expand-body');
    if (!body) return;

    const r = _config.cache[entityId];
    if (!r) { body.innerHTML = '<p>No data</p>'; return; }

    switch (tabId) {
      case 'overview':
        body.innerHTML = renderOverviewTab(r);
        break;
      case 'trust':
        body.innerHTML = renderTrustTab(r);
        break;
      case 'activity':
        if (r.type === 'Wallet' || r.type === 'Contract') {
          body.innerHTML = '<div style="text-align:center;padding:1rem;color:#999;">Loading transfers...</div>';
          renderWalletActivityTab(r).then(html => { body.innerHTML = html; });
        } else {
          body.innerHTML = '<div style="text-align:center;padding:1rem;color:#999;">Loading activity...</div>';
          renderActivityTab(entityId).then(html => { body.innerHTML = html; });
        }
        break;
      case 'manifest':
        body.innerHTML = '<div style="text-align:center;padding:1rem;color:#999;">Loading manifest...</div>';
        renderManifestTab(entityId).then(html => {
          body.innerHTML = html;
          initAce(entityId);
        });
        break;
    }
  }

  // ---- Tab renderers ----

  function renderOverviewTab(r) {
    let html = '';

    // Organization
    if (r.name || r.domain) {
      html += '<div class="expand-section">';
      html += '<div class="expand-section-title">Organization</div>';
      if (r.name) html += `<div><strong>${escapeHtml(r.name)}</strong></div>`;
      if (r.domain) html += `<div><a href="https://${escapeHtml(r.domain)}" target="_blank" rel="noopener">${escapeHtml(r.domain)}</a></div>`;
      if (r.mission) html += `<div style="margin-top:0.3rem;color:#555;">${escapeHtml(r.mission)}</div>`;
      html += '</div>';
    }

    // Concepts
    if (r.concepts && r.concepts.length > 0) {
      html += '<div class="expand-section">';
      html += '<div class="expand-section-title">Concepts</div>';
      html += `<div class="result-concepts">${r.concepts.map(c => `<span class="concept-tag">${escapeHtml(c)}</span>`).join('')}</div>`;
      html += '</div>';
    }

    // Applications
    if (r.applications && r.applications.length > 0) {
      html += '<div class="expand-section">';
      html += '<div class="expand-section-title">Applications</div>';
      r.applications.forEach(app => {
        html += `<div><strong>${escapeHtml(app.name)}</strong>`;
        if (app.description) html += ` &mdash; ${escapeHtml(app.description)}`;
        if (app.url) html += ` <a href="${escapeHtml(app.url)}" target="_blank" rel="noopener" style="font-size:0.82rem;color:#3498db;">[link]</a>`;
        html += '</div>';
      });
      html += '</div>';
    }

    // People
    if (r.people && r.people.length > 0) {
      html += '<div class="expand-section">';
      html += '<div class="expand-section-title">People</div>';
      r.people.forEach(p => {
        html += `<div>${escapeHtml(p.name)}`;
        if (p.role) html += ` <span style="color:#999;">(${escapeHtml(p.role)})</span>`;
        html += '</div>';
      });
      html += '</div>';
    }

    // Capabilities
    if (r.capabilities) {
      const caps = renderCapabilities(r.capabilities);
      if (caps) {
        html += '<div class="expand-section">';
        html += '<div class="expand-section-title">Capabilities</div>';
        html += caps;
        html += '</div>';
      }
    }

    // Identity / metadata
    const metaParts = [];
    if (r.signature?.digitalName) metaParts.push(`<strong>Identity:</strong> ${escapeHtml(r.signature.digitalName)}`);
    if (r.discoveryMethod) metaParts.push(`<strong>Discovery:</strong> ${escapeHtml(r.discoveryMethod)}`);
    if (r.lastChecked) metaParts.push(`<strong>Last checked:</strong> ${new Date(r.lastChecked).toLocaleDateString()}`);
    if (r.indexedAt) metaParts.push(`<strong>Indexed:</strong> ${new Date(r.indexedAt).toLocaleDateString()}`);

    if (metaParts.length > 0) {
      html += '<div class="expand-section">';
      html += '<div class="expand-section-title">Metadata</div>';
      html += metaParts.map(m => `<div style="font-size:0.85rem;color:#666;">${m}</div>`).join('');
      html += '</div>';
    }

    // MCP-specific info
    if (r.mcpService) {
      const mcp = r.mcpService;
      html += '<div class="expand-section">';
      html += '<div class="expand-section-title">MCP Service</div>';
      if (mcp.tools_count) html += `<div>${mcp.tools_count} tool${mcp.tools_count === 1 ? '' : 's'} available</div>`;
      if (mcp.reachable != null) html += `<div>Status: ${mcp.reachable ? 'Live' : 'Offline'}</div>`;
      if (mcp.detail_url && r.domain) html += `<div><a href="https://${escapeHtml(r.domain)}${escapeHtml(mcp.detail_url)}" target="_blank" rel="noopener" style="color:#7c3aed;">Service details</a></div>`;
      html += '</div>';
    }

    // Wallet / Contract info
    if (r.type === 'Wallet' || r.type === 'Contract') {
      // Address
      html += '<div class="expand-section">';
      html += '<div class="expand-section-title">Address</div>';
      html += `<div style="font-family:monospace;font-size:0.85rem;overflow-wrap:anywhere;">${escapeHtml(r.name)}</div>`;
      if (r.chain) html += `<span class="badge badge-chain badge-chain-${escapeAttr(r.chain)}">${escapeHtml(r.chain)}</span>`;
      html += '</div>';

      // Balance
      if (r.balance != null) {
        html += '<div class="expand-section">';
        html += '<div class="expand-section-title">Balance</div>';
        html += `<div class="wallet-balance">${escapeHtml(r.balanceFormatted || '0')}</div>`;
        html += '</div>';
      }

      // Token balances
      if (r.tokens && r.tokens.length > 0) {
        html += '<div class="expand-section">';
        html += '<div class="expand-section-title">Tokens</div>';
        html += '<table class="token-list"><thead><tr><th>Token</th><th>Balance</th></tr></thead><tbody>';
        for (const t of r.tokens) {
          html += `<tr><td>${escapeHtml(t.symbol)}</td><td>${escapeHtml(t.balanceFormatted)}</td></tr>`;
        }
        html += '</tbody></table>';
        html += '</div>';
      }

      // Transaction count
      if (r.transactionCount != null) {
        html += '<div class="expand-section">';
        html += '<div class="expand-section-title">Activity</div>';
        html += `<div>${r.transactionCount.toLocaleString()} transaction${r.transactionCount === 1 ? '' : 's'}</div>`;
        html += '</div>';
      }

      // Contract metadata
      if (r.contractMeta) {
        html += '<div class="expand-section">';
        html += '<div class="expand-section-title">Contract Info</div>';
        if (r.contractMeta.owner) html += `<div><strong>Owner:</strong> <span style="font-family:monospace;font-size:0.82rem;">${escapeHtml(r.contractMeta.owner)}</span></div>`;
        if (r.contractMeta.domain) html += `<div><strong>Domain:</strong> ${escapeHtml(r.contractMeta.domain)}</div>`;
        if (r.contractMeta.version) html += `<div><strong>Version:</strong> ${escapeHtml(r.contractMeta.version)}</div>`;
        html += '</div>';
      }
    }

    return html || '<div style="padding:1rem;color:#999;">No overview data available.</div>';
  }

  function renderTrustTab(r) {
    let html = '';

    // Trust score summary
    const score = r.trustScore;
    if (score != null) {
      html += '<div class="expand-section">';
      html += `<div class="expand-section-title">Trust Score: ${score}</div>`;
      html += getTrustBadge(r);
      html += '</div>';
    }

    // Signal breakdown
    if (r.signals) {
      const signalMeta = {
        manifest:       { label: 'Manifest',        weight: 10, desc: 'Has /.well-known/ai manifest' },
        selfSigned:     { label: 'Self-Signed',      weight: 5,  desc: 'Manifest contains a signature' },
        hashValid:      { label: 'Hash Valid',        weight: 15, desc: 'Content hash matches manifest data' },
        contractExists: { label: 'Contract',          weight: 20, desc: 'On-chain identity contract exists' },
        domainBinding:  { label: 'Domain Binding',    weight: 20, desc: 'Contract binds to this domain' },
        dnsVerified:    { label: 'DNS Verified',       weight: 20, desc: 'DNS TXT record confirms identity' },
        platform:       { label: 'Platform',           weight: 10, desc: 'Recognized platform integration' }
      };

      html += '<div class="expand-section">';
      html += '<div class="expand-section-title">Signal Breakdown</div>';
      html += '<table class="signal-table"><thead><tr><th>Signal</th><th>Weight</th><th>Status</th><th>Description</th></tr></thead><tbody>';

      for (const [name, meta] of Object.entries(signalMeta)) {
        const signal = r.signals[name];
        const present = signal?.present;
        const statusClass = present ? 'on' : 'off';
        const statusLabel = present ? 'Yes' : 'No';
        html += `<tr>
          <td>${meta.label}</td>
          <td>${meta.weight}</td>
          <td><span class="signal-dot ${statusClass}" style="display:inline-block;vertical-align:middle;margin-right:4px;"></span>${statusLabel}</td>
          <td style="color:#888;">${meta.desc}</td>
        </tr>`;
      }
      html += '</tbody></table>';
      html += '</div>';
    } else {
      html += '<div style="padding:1rem;color:#999;">No trust signal data available.</div>';
    }

    return html;
  }

  async function renderActivityTab(entityId) {
    // Check cache
    if (_eventCache[entityId]) return formatEvents(_eventCache[entityId]);

    try {
      const res = await fetch(`/api/events?entityId=${encodeURIComponent(entityId)}&limit=25`);
      const data = await res.json();
      const events = data.events || [];
      _eventCache[entityId] = events;
      return formatEvents(events);
    } catch (err) {
      return `<div style="padding:1rem;color:#c0392b;">Error loading activity: ${escapeHtml(err.message)}</div>`;
    }
  }

  function formatEvents(events) {
    if (events.length === 0) {
      return '<div style="padding:1rem;color:#999;">No activity recorded.</div>';
    }
    let html = '<div class="event-list">';
    events.forEach(ev => {
      const date = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '';
      const type = ev.type || 'event';
      const chain = ev.chain || '';
      html += `<div class="event-item">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <strong>${escapeHtml(type)}</strong>
          <span style="font-size:0.78rem;color:#aaa;">${escapeHtml(date)}</span>
        </div>`;
      if (chain) html += `<div style="font-size:0.78rem;color:#999;">Chain: ${escapeHtml(chain)}</div>`;
      if (ev.txHash) html += `<div style="font-size:0.78rem;color:#999;overflow-wrap:anywhere;">Tx: ${escapeHtml(ev.txHash)}</div>`;
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  const TX_EXPLORERS = {
    ethereum: 'https://etherscan.io',
    polygon: 'https://polygonscan.com',
    sepolia: 'https://sepolia.etherscan.io',
    'polygon-amoy': 'https://amoy.polygonscan.com',
    japanopenchain: 'https://explorer.japanopenchain.org'
  };

  async function renderWalletActivityTab(r) {
    let html = '';
    const address = r.name;
    const explorer = TX_EXPLORERS[r.chain];

    // Transaction count summary
    html += '<div class="expand-section">';
    html += '<div class="expand-section-title">Summary</div>';
    const count = r.transactionCount || 0;
    html += `<div>${count.toLocaleString()} total transaction${count === 1 ? '' : 's'}`;
    if (explorer) html += ` &mdash; <a href="${explorer}/address/${escapeHtml(address)}" target="_blank" rel="noopener" style="color:#3498db;">view on explorer</a>`;
    html += '</div></div>';

    // Fetch recent transfers
    try {
      const res = await fetch('/api/search/address/' + encodeURIComponent(address) + '/activity');
      const data = await res.json();
      const transfers = data.transfers || [];

      if (transfers.length > 0) {
        html += '<div class="expand-section">';
        html += '<div class="expand-section-title">Recent Token Transfers</div>';
        html += '<div class="event-list">';
        for (const tx of transfers) {
          const dir = tx.direction === 'sent' ? 'Sent' : 'Received';
          const dirColor = tx.direction === 'sent' ? '#c0392b' : '#27ae60';
          const counterparty = tx.direction === 'sent' ? tx.to : tx.from;
          const truncParty = counterparty.slice(0, 6) + '...' + counterparty.slice(-4);
          const txExplorer = TX_EXPLORERS[tx.chain];
          const txLink = txExplorer
            ? `<a href="${txExplorer}/tx/${escapeHtml(tx.transactionHash)}" target="_blank" rel="noopener" style="color:#3498db;font-size:0.75rem;">view tx</a>`
            : '';

          html += `<div class="event-item">
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <span><strong style="color:${dirColor}">${dir}</strong> ${escapeHtml(tx.valueFormatted)}</span>
              <span style="font-size:0.75rem;color:#aaa;">block ${tx.blockNumber.toLocaleString()}</span>
            </div>
            <div style="font-size:0.78rem;color:#999;">
              ${tx.direction === 'sent' ? 'to' : 'from'}
              <span style="font-family:monospace;">${escapeHtml(truncParty)}</span>
              on ${escapeHtml(tx.chain)}
              ${txLink}
            </div>
          </div>`;
        }
        html += '</div></div>';
      } else {
        html += '<div style="padding:0.5rem 0;color:#999;font-size:0.85rem;">No token transfers in recent blocks.</div>';
      }
    } catch (err) {
      html += `<div style="padding:0.5rem 0;color:#c0392b;font-size:0.85rem;">Error loading transfers: ${escapeHtml(err.message)}</div>`;
    }

    return html;
  }

  async function renderManifestTab(entityId) {
    try {
      // Lazy-load ACE
      if (!_aceLoaded) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.6/ace.min.js';
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
        _aceLoaded = true;
      }

      // Fetch manifest via page-specific function
      let data = _config.cache[entityId];
      if (_config.fetchManifest) {
        try {
          data = await _config.fetchManifest(entityId);
        } catch (e) {
          // Fall back to cached result object
        }
      }

      const aceId = 'ace-' + entityId.replace(/\W/g, '-');
      // Store data in a temp slot for initAce to pick up
      _pendingAceData = data;
      return `<div class="ace-container" id="${aceId}"></div>`;
    } catch (err) {
      return `<div style="padding:1rem;color:#c0392b;">Error loading manifest: ${escapeHtml(err.message)}</div>`;
    }
  }

  let _pendingAceData = null;

  function initAce(entityId) {
    const aceId = 'ace-' + entityId.replace(/\W/g, '-');
    const container = document.getElementById(aceId);
    if (!container || !window.ace) return;

    if (_aceEditor) {
      _aceEditor.destroy();
      _aceEditor = null;
    }

    _aceEditor = window.ace.edit(aceId);
    _aceEditor.setTheme('ace/theme/monokai');
    _aceEditor.session.setMode('ace/mode/json');
    _aceEditor.setReadOnly(true);
    _aceEditor.setShowPrintMargin(false);
    _aceEditor.session.setUseWrapMode(true);
    _aceEditor.renderer.setShowGutter(true);
    _aceEditor.setValue(JSON.stringify(_pendingAceData || {}, null, 2), -1);
    _pendingAceData = null;
  }

  // ---- Init ----

  function init(config) {
    _config = Object.assign(_config, config);
  }

  // ---- Public API ----
  return {
    init,
    toggle,
    closeExpand,
    switchTab,
    getTrustBadge,
    renderSignalDots,
    renderCapabilities,
    formatBalance,
    NATIVE_CURRENCY
  };
})();
