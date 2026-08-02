// ═══════════════════════════════════════════════════
// INITIAL DEMO DATA CONSTANTS & STATE
// ═══════════════════════════════════════════════════
const NOW = Date.now();
const DEMO_BALANCE_FEED = [
  { id: 'bf1', amount: 50000, source: 'manual', label: 'Initial funding', at: NOW - 3600000 },
  { id: 'bf2', amount: -4000, source: 'agent', label: 'agent: ad campaign', at: NOW - 2040000 },
  { id: 'bf3', amount: 3000, source: 'agent', label: 'agent: returned budget', at: NOW - 480000 },
];
const DEMO_LEDGER = [
  { id: 'l1', amount: 4000, counterparty: 'Meta Ads', outcome: 'approved', reason: 'Within spend limit · approved counterparty', at: NOW - 2040000 },
  { id: 'l2', amount: 12000, counterparty: 'Unknown Vendor', outcome: 'blocked', reason: 'Counterparty not on allowlist', at: NOW - 1320000 },
  { id: 'l3', amount: 1800, counterparty: 'OpenAI', outcome: 'approved', reason: 'Within spend limit · approved counterparty', at: NOW - 540000 },
];
const DEMO_ACTIVITY = [
  { id: 'a1', message: 'Agent started task "Q3 ad campaign"', reason: 'Scheduled growth objective triggered', at: NOW - 2100000 },
  { id: 'a2', message: 'Agent attempted payment to Unknown Vendor', reason: 'Sourcing cheaper compute — vendor not vetted', at: NOW - 1320000 },
  { id: 'a3', message: 'Agent completed task "Keyword research"', reason: 'Returned ₹3,000 unused budget', at: NOW - 480000 },
];

var state = window.state = {
  session: null,
  view: 'killswitch', // 'killswitch' | 'playground'
  balance: 0,
  frozen: false,
  agent: { label: '', endpoint: '', connected: false },
  spendLimit: 10000,
  allowlist: ['Meta Ads', 'OpenAI', 'Google Cloud', 'Vercel'],
  blockedCounterparties: [],
  balanceFeed: [],
  ledger: [],
  activity: [],
  windowCap: 30000,
  windowSpent: 0,
  windowStartMs: Date.now(),
  usedNonces: new Set(),
  attackStats: {
    totalAttempts: 0,
    blockedAttempts: 0,
    techniqueCounts: {}
  },
  // playground
  attackMode: 'normal',
  taskSource: 'random',
  selectedTemplate: 'ad_campaign',
  pillStatus: 'idle',
  lastTask: null,
  progress: 0,
  isRunning: false,
};

const TASK_POOL = [
  { id: 'ad_campaign', label: 'Ad campaign', verb: 'Generating an ad image and running', unit: 'campaign', unitCost: 4500, normalRange: [1,2], attackRange: [4000,25000] },
  { id: 'build_site', label: 'Build a website', verb: 'Registering hosting and shipping', unit: 'site', unitCost: 6000, normalRange: [1,1], attackRange: [2000,12000] },
  { id: 'buy_compute', label: 'Buy compute', verb: 'Provisioning', unit: 'GPU', unitCost: 3200, normalRange: [1,3], attackRange: [10000,120000] },
  { id: 'buy_ad_credits', label: 'Buy ad credits', verb: 'Purchasing', unit: 'ad credit', unitCost: 100, normalRange: [50,250], attackRange: [50000,400000] },
  { id: 'renew_domain', label: 'Renew a domain', verb: 'Renewing', unit: 'domain', unitCost: 1400, normalRange: [1,2], attackRange: [8000,60000] },
  { id: 'cloud_storage', label: 'Order cloud storage', verb: 'Reserving', unit: 'TB', unitCost: 800, normalRange: [1,5], attackRange: [500000,5000000] },
  { id: 'api_tokens', label: 'Buy API tokens', verb: 'Topping up', unit: 'M tokens', unitCost: 300, normalRange: [1,10], attackRange: [500000,6000000] },
  { id: 'email_sends', label: 'Buy email sends', verb: 'Loading', unit: 'K sends', unitCost: 200, normalRange: [5,40], attackRange: [2000000,50000000] },
  { id: 'saas_seats', label: 'Add SaaS seats', verb: 'Licensing', unit: 'seat', unitCost: 2200, normalRange: [1,5], attackRange: [20000,300000] },
  { id: 'proxy_pool', label: 'Rent proxy pool', verb: 'Leasing', unit: 'proxy IP', unitCost: 400, normalRange: [10,60], attackRange: [1000000,12000000] },
];

const ATTACK_MODES = [
  { value: 'normal', label: '1. Normal Execution', hint: 'Agent behaves as intended within policy caps.', danger: false, classNum: 0 },
  { value: 'structuring', label: '2. Structuring (Class 1)', hint: 'Splits payments into micro-transactions under per-tx cap to dodge limits.', danger: true, classNum: 1 },
  { value: 'category_spoofing', label: '3. Category Spoofing (Class 2)', hint: 'Claims unapproved software SaaS buy is allowed category.', danger: true, classNum: 2 },
  { value: 'lease_replay', label: '4. Nonce & Lease Replay (Class 3)', hint: 'Reuses a settled transaction nonce to replay spend.', danger: true, classNum: 3 },
  { value: 'toctou_race', label: '5. TOCTOU Race Condition (Class 4)', hint: 'Fires concurrent payments in 1sec to exploit race window.', danger: true, classNum: 4 },
  { value: 'rail_bypass', label: '6. Rail Bypass (Class 5)', hint: 'Attempts direct contract execution, bypassing core co-signer.', danger: true, classNum: 5 },
  { value: 'signature_forgery', label: '7. Signature Forgery (Class 6)', hint: 'Crafts fake agent/core signature without key share.', danger: true, classNum: 6 },
  { value: 'core_impersonation', label: '8. Core Impersonation (Class 7)', hint: 'Stands up fake co-signer server with unverified key.', danger: true, classNum: 7 },
  { value: 'prompt_injection', label: '9. Prompt Injection (Class 8)', hint: 'Embeds prose instructions into FactSheet string fields.', danger: true, classNum: 8 },
  { value: 'self_dealing', label: '10. Self-Dealing (Class 9)', hint: 'Registers a self-controlled 2-day-old vendor and pays self.', danger: true, classNum: 9 },
  { value: 'social_engineering', label: '11. Social Engineering (Class 10)', hint: 'Spoofs agent thoughts to prompt operator override.', danger: true, classNum: 10 },
  { value: 'clock_manipulation', label: '12. Clock Manipulation (Class 11)', hint: 'Supplies false timestamps to dodge 24h window resets.', danger: true, classNum: 11 },
  { value: 'lease_griefing', label: '13. Lease Renewal Griefing (Class 12)', hint: 'Exhausts unsettled hold lease capacity to lockout operations.', danger: true, classNum: 12 }
];

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════
let idCounter = 0;
function uid() { return 'id_' + (++idCounter) + '_' + Date.now().toString(36); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function fmtCurrency(v, curr = 'INR') {
  if (curr === 'USD') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(v);
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(v).replace('INR', '₹');
}
function fmtSigned(v) { return (v >= 0 ? '+' : '-') + fmtCurrency(Math.abs(v)); }
function fmtTime(at) { return new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); }
function timeAgo(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  return Math.round(mins / 60) + 'h ago';
}
function showToast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.innerHTML = (type === 'success' ? '✓' : '✕') + ' ' + msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ═══════════════════════════════════════════════════
// VIEW TOGGLE
// ═══════════════════════════════════════════════════
function toggleView() {
  const isPlayground = state.view === 'killswitch';
  state.view = isPlayground ? 'playground' : 'killswitch';

  const body = document.getElementById('app-body');
  const track = document.getElementById('viewSwitch');
  const labelKS = document.getElementById('labelKS');
  const labelPG = document.getElementById('labelPG');
  const dashView = document.getElementById('dashboardView');
  const playView = document.getElementById('playgroundView');

  if (isPlayground) {
    body.classList.add('playground-mode');
    track.classList.add('on');
    track.setAttribute('aria-checked', 'true');
    labelKS.className = 'view-switch-label inactive';
    labelPG.className = 'view-switch-label active';
    dashView.className = 'page-view hidden-view';
    playView.className = 'page-view active';
  } else {
    body.classList.remove('playground-mode');
    track.classList.remove('on');
    track.setAttribute('aria-checked', 'false');
    labelKS.className = 'view-switch-label active';
    labelPG.className = 'view-switch-label inactive';
    dashView.className = 'page-view active';
    playView.className = 'page-view hidden-view';
  }
}

// ═══════════════════════════════════════════════════
// DASHBOARD RENDERS
// ═══════════════════════════════════════════════════
function renderDashboard() {
  renderBalance();
  renderBalanceFeed();
  renderLedger();
  renderBlockedSection();
  renderDefenseMatrix();
  renderActivity();
  renderAllowlist();
  renderAgent();
  renderFreezeState();
}

function renderDefenseMatrix() {
  const shieldBadge = document.getElementById('defenseShieldBadge');
  const evaluatedEl = document.getElementById('evaluatedRulesCount');
  const classesEl = document.getElementById('activeClassesCount');
  const windowEl = document.getElementById('rollingWindowCapVal');

  if (!state.attackStats) state.attackStats = { totalAttempts: 0, blockedAttempts: 0 };
  const totalBlocked = state.attackStats.blockedAttempts || 0;
  const shieldPct = state.attackStats.totalAttempts > 0 
    ? Math.round((totalBlocked / state.attackStats.totalAttempts) * 100)
    : 100;

  if (shieldBadge) shieldBadge.textContent = `🛡️ ${shieldPct}% Defense Shield (${totalBlocked} Blocked)`;
  if (evaluatedEl) evaluatedEl.textContent = `14 Rules`;
  if (classesEl) classesEl.textContent = `12 / 12`;
  if (windowEl) windowEl.textContent = `${fmtCurrency(state.windowCap || 300)} / 24h`;
}

function renderBalance() {
  const el = document.getElementById('walletBalance');
  el.textContent = fmtCurrency(state.balance);
  el.className = 'wallet-balance' + (state.frozen ? ' frozen' : '');
  document.getElementById('walletSubtitle').textContent = state.frozen
    ? 'Spending frozen — agent cannot transact'
    : 'Shared across manual top-ups and agent activity';
}

function renderBalanceFeed() {
  const el = document.getElementById('balanceFeed');
  el.innerHTML = state.balanceFeed.slice(0, 6).map(entry => {
    const credit = entry.amount >= 0;
    return `<div class="balance-entry">
      <span class="balance-entry-left">
        <span class="balance-entry-icon ${credit ? 'credit' : 'debit'}">
          ${credit
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="7" x2="17" y2="17"/><polyline points="17 7 17 17 7 17"/></svg>'}
        </span>
        <span class="balance-entry-label">${entry.label}</span>
      </span>
      <span class="balance-entry-right">
        <span class="balance-entry-amount ${credit ? 'credit' : 'debit'}">${fmtSigned(entry.amount)}</span>
        <span class="balance-entry-time">${timeAgo(entry.at)}</span>
      </span>
    </div>`;
  }).join('');
}

function renderLedger() {
  document.getElementById('ledgerBody').innerHTML = state.ledger.map(tx => `
    <tr>
      <td class="time-col" style="padding-left:20px">${fmtTime(tx.at)}</td>
      <td><div class="counterparty-name">${tx.counterparty}</div><div class="counterparty-reason">${tx.reason}</div></td>
      <td class="amount-col">${fmtCurrency(tx.amount)}</td>
      <td class="outcome-col" style="padding-right:20px">
        <span class="badge ${tx.outcome === 'approved' ? 'badge-success' : 'badge-danger'}">
          ${tx.outcome === 'approved' ? '✓ Approved' : '✕ Blocked'}
        </span>
      </td>
    </tr>
  `).join('');
}

function renderBlockedSection() {
  const blockedTx = state.ledger.filter(tx => tx.outcome === 'blocked');
  document.getElementById('blockedCountBadge').textContent = blockedTx.length + ' Intercepted';
  
  const tbody = document.getElementById('blockedBody');
  if (blockedTx.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:16px">No blocked transactions yet. Lakshman Rekha is actively monitoring.</td></tr>`;
    return;
  }

  tbody.innerHTML = blockedTx.map(tx => {
    const isNotAllowed = !state.allowlist.some(c => c.toLowerCase() === tx.counterparty.toLowerCase());
    const approveBtn = isNotAllowed
      ? `<button class="btn btn-sm btn-outline" style="font-size:10px;padding:2px 6px;margin-top:4px;color:var(--accent);border-color:var(--accent)" onclick="approveBlockedCounterparty('${tx.counterparty.replace(/'/g, "\\'")}')">+ Add to Allowlist</button>`
      : '';
    return `
      <tr>
        <td class="time-col" style="padding-left:20px">${fmtTime(tx.at)}</td>
        <td>
          <div class="counterparty-name" style="color:var(--danger)">${tx.counterparty}</div>
          ${approveBtn}
        </td>
        <td class="amount-col" style="color:var(--danger);font-weight:600">${fmtCurrency(tx.amount)}</td>
        <td class="outcome-col" style="padding-right:20px">
          <div style="font-size:12px;font-weight:600;color:var(--danger)">${tx.reason}</div>
          <span class="badge badge-danger" style="margin-top:2px;font-size:10px">🚨 Intercepted</span>
        </td>
      </tr>
    `;
  }).join('');
}

function renderActivity() {
  document.getElementById('activityTimeline').innerHTML = state.activity.map(e => `
    <div class="activity-entry">
      <span class="activity-dot"></span>
      <div class="activity-header">
        <p class="activity-msg">${e.message}</p>
        <span class="activity-time">${fmtTime(e.at)}</span>
      </div>
      <p class="activity-reason">${e.reason}</p>
    </div>
  `).join('');
}

function renderAllowlist() {
  const chipsEl = document.getElementById('allowlistChips');
  if (!chipsEl) return;
  
  if (!state.allowlist || state.allowlist.length === 0) {
    chipsEl.innerHTML = `<div style="font-size:12px;color:var(--muted);font-style:italic;margin-bottom:8px;padding:4px 0">No counterparties on allowlist. All vendor payments will be evaluated or blocked.</div>`;
  } else {
    chipsEl.innerHTML = state.allowlist.map(p => `
      <span class="chip">${p}<button class="chip-remove" onclick="removeCounterparty('${p.replace(/'/g, "\\'")}')" title="Remove ${p}">×</button></span>
    `).join('');
  }

  renderBlockedSuggestions();
}

function renderBlockedSuggestions() {
  let sugEl = document.getElementById('blockedSuggestionsSection');
  const chipsContainer = document.getElementById('allowlistChips');
  if (!chipsContainer || !chipsContainer.parentElement) return;

  if (!sugEl) {
    sugEl = document.createElement('div');
    sugEl.id = 'blockedSuggestionsSection';
    sugEl.style.marginTop = '14px';
    chipsContainer.parentElement.appendChild(sugEl);
  }

  if (!state.blockedCounterparties) state.blockedCounterparties = [];

  const pending = state.blockedCounterparties.filter(
    cp => !state.allowlist.some(a => a.toLowerCase() === cp.toLowerCase())
  );

  if (pending.length === 0) {
    sugEl.innerHTML = '';
    return;
  }

  sugEl.innerHTML = `
    <div style="font-size:11px;font-weight:600;color:var(--danger);margin-bottom:6px;display:flex;align-items:center;gap:4px">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      BLOCKED COUNTERPARTIES — ADD TO ALLOWLIST?
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${pending.map(cp => `
        <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(212,67,92,0.06);border:1px solid rgba(212,67,92,0.2);padding:6px 10px;border-radius:6px;font-size:12px">
          <span style="font-weight:600;color:var(--fg)">${cp}</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm btn-primary" onclick="approveBlockedCounterparty('${cp.replace(/'/g, "\\'")}')" style="padding:2px 8px;font-size:11px">
              + Approve & Add
            </button>
            <button class="btn btn-sm btn-outline" onclick="dismissBlockedCounterparty('${cp.replace(/'/g, "\\'")}')" style="padding:2px 6px;font-size:11px;color:var(--muted)">
              ✕
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderAgent() {
  const badge = document.getElementById('agentBadge');
  const dot = document.getElementById('agentDot');
  const text = document.getElementById('agentBadgeText');
  const content = document.getElementById('agentContent');
  const topStatus = document.getElementById('topbar-agent-status');

  if (state.agent.connected) {
    badge.className = 'badge badge-success';
    dot.style.background = 'var(--success)';
    text.textContent = 'Connected';
    topStatus.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4v4"/><rect x="4" y="8" width="16" height="12" rx="2"/></svg> ' + state.agent.label;
    content.innerHTML = `
      <div class="agent-info-box">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <p style="font-weight:600">${state.agent.label}</p>
          <span class="badge badge-success" style="font-size:10px">Active</span>
        </div>
        <p style="margin-top:4px">${state.agent.endpoint || 'No endpoint provided'}</p>
      </div>
      <div style="margin-top:16px">
        <p class="agent-sim-note">Lakshman Rekha is actively monitoring this agent's API transactions.</p>
        <div class="agent-buttons">
          <button class="btn btn-outline btn-sm" onclick="openAddAgentModal()">
            <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit Credentials
          </button>
          <button class="btn btn-outline btn-sm" onclick="disconnectAgent()">
            <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71a5 5 0 00-7.07-7.07L11.77 5.19"/><path d="M5.16 11.75l-1.72 1.71a5 5 0 007.07 7.07l1.72-1.71"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
            Disconnect
          </button>
        </div>
        ${state.frozen ? '<p class="agent-frozen-note">Agent activity is disabled while frozen.</p>' : ''}
      </div>`;
  } else {
    badge.className = 'badge';
    dot.style.background = 'var(--muted)';
    text.textContent = 'Not connected';
    topStatus.textContent = 'No agent linked';
    content.innerHTML = `
      <div style="text-align:center;padding:12px 8px">
        <div style="width:40px;height:40px;border-radius:12px;background:var(--muted-bg);display:flex;align-items:center;justify-content:center;margin:0 auto 10px;color:var(--muted)">
          <svg class="icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4v4"/><rect x="4" y="8" width="16" height="12" rx="2"/></svg>
        </div>
        <p style="font-size:13px;font-weight:500;margin-bottom:4px">No Agent Linked</p>
        <p style="font-size:12px;color:var(--muted);margin-bottom:14px">Connect an autonomous agent (Claude, OpenAI, custom LLM) to enforce spending limits.</p>
        <button class="btn btn-primary" style="width:100%;margin-bottom:12px" onclick="openAddAgentModal()">
          <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Connect Agent
        </button>
        <div style="text-align:left;background:var(--muted-bg);padding:10px;border-radius:8px;font-size:11px;color:var(--muted);line-height:1.4">
          <strong>💡 How to connect real agents:</strong><br/>
          Route your agent's API calls to <code style="color:var(--accent)">https://api.lakshman-rekha.dev/v1/interceptor</code> with token <code style="color:var(--accent)">lr_live_sk_...</code> to enable live policy enforcement.
        </div>
      </div>`;
  }
}

function renderFreezeState() {
  const banner = document.getElementById('frozenBanner');
  const card = document.getElementById('freezeCard');
  const btns = document.getElementById('freezeButtons');
  banner.className = 'frozen-banner' + (state.frozen ? ' show' : '');
  card.className = 'card freeze-card' + (state.frozen ? ' frozen' : '');
  if (state.frozen) {
    btns.innerHTML = `<button class="btn btn-outline" style="border-color:rgba(45,165,108,0.3);color:var(--success);width:100%" onclick="setFrozen(false)">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
      Un-freeze spending</button>`;
  } else {
    btns.innerHTML = `<button class="btn btn-danger btn-lg" style="width:100%" onclick="confirmFreeze()">
      <svg class="icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      Freeze all spending</button>`;
  }
}

// ═══════════════════════════════════════════════════
// DASHBOARD ACTIONS
// ═══════════════════════════════════════════════════
function openAddFunds() { document.getElementById('addFundsModal').classList.add('open'); document.getElementById('add-amount').focus(); }
function closeAddFunds() { document.getElementById('addFundsModal').classList.remove('open'); }
function depositFunds() {
  const v = parseFloat(document.getElementById('add-amount').value);
  if (!isFinite(v) || v <= 0) return;
  state.balance = Math.round((state.balance + v) * 100) / 100;
  state.balanceFeed.unshift({ id: uid(), amount: v, source: 'manual', label: 'manual top-up', at: Date.now() });
  document.getElementById('add-amount').value = '';
  closeAddFunds();
  saveCurrentUserData();
  renderBalance(); renderBalanceFeed();
  showToast('Funds added successfully');
}

let selectedPaymentMethod = 'manual';
function selectPaymentMethod(method) {
  selectedPaymentMethod = method;
  ['Manual', 'Card', 'Bank', 'Crypto'].forEach(m => {
    const btn = document.getElementById('pmBtn' + m);
    if (btn) btn.className = 'payment-method-btn' + (m.toLowerCase() === method ? ' active' : ' locked');
  });

  const manualSec = document.getElementById('pmSectionManual');
  const lockedSec = document.getElementById('pmSectionLocked');
  const depositBtn = document.getElementById('depositBtn');

  if (method === 'manual') {
    manualSec.style.display = '';
    lockedSec.style.display = 'none';
    depositBtn.style.display = '';
  } else {
    manualSec.style.display = 'none';
    lockedSec.style.display = '';
    depositBtn.style.display = 'none';

    const titles = {
      card: 'Credit / Debit Card Disabled',
      bank: 'Bank Transfer Disabled',
      crypto: 'Crypto Wallet Disabled'
    };
    const descs = {
      card: 'Credit card processing is locked in demo mode. Use <strong>Manual Deposit</strong> to simulate adding funds.',
      bank: 'ACH and Wire transfers are locked in demo mode. Use <strong>Manual Deposit</strong> to simulate adding funds.',
      crypto: 'Web3 crypto wallet connection is locked in demo mode. Use <strong>Manual Deposit</strong> to simulate adding funds.'
    };
    document.getElementById('lockedMethodTitle').textContent = titles[method] || 'Locked';
    document.getElementById('lockedMethodDesc').innerHTML = descs[method] || 'This payment method is locked in demo mode.';
  }
}

function simulateSpend(counterparty, amount, extraOpts = {}) {
  // STRICT RULE: Breach detection ONLY runs when an Agent API is connected!
  if (!state.agent || !state.agent.connected) {
    return;
  }

  const now = Date.now();

  // Reset rolling window if > 24 hours
  if (!state.windowStartMs || (now - state.windowStartMs > 86400000)) {
    state.windowSpent = 0;
    state.windowStartMs = now;
  }
  if (!state.usedNonces) state.usedNonces = new Set();
  if (!state.attackStats) state.attackStats = { totalAttempts: 0, blockedAttempts: 0, techniqueCounts: {} };

  const nonce = extraOpts.nonce || Math.floor(Math.random() * 1000000);
  const counterpartyAgeDays = extraOpts.counterpartyAgeDays ?? 365;
  const counterpartyTier = extraOpts.counterpartyTier ?? 1; // Tier 1: Verified, Tier 2: Standard, Tier 3: Unverified
  const isReplay = state.usedNonces.has(nonce);

  if (!state.cumulativeSpent) state.cumulativeSpent = 0;
  const cumulativeCap = state.cumulativeCap || 1000000; // ₹10,00,000 lifetime mandate cap

  // FAIL-CLOSED BY DESIGN (BUILD.md Non-Negotiable #1)
  // Default outcome is ALWAYS BLOCKED. Never fall through to APPROVED.
  let outcome = 'blocked';
  let bindingPredicate = 'unverifiedState';
  let reason = 'Refused. Unverified state — default fail-closed policy.';

  // Evaluate all 14 policy predicates explicitly
  const p1_revocation = !state.frozen;
  const p2_nonce = !isReplay;
  const p3_category = !extraOpts.categorySpoof && state.allowlist.some(c => c.toLowerCase() === (counterparty || '').toLowerCase());
  const p4_perTx = amount <= state.spendLimit;
  const p5_window = state.windowSpent + amount <= state.windowCap;
  const p6_cumulative = state.cumulativeSpent + amount <= cumulativeCap;
  const p7_age = counterpartyAgeDays >= 30;
  const p8_tier = counterpartyTier <= 2;
  const p9_price = !extraOpts.priceBandViolation;
  const p10_agentSig = !extraOpts.forgedSignature && !extraOpts.invalidAgentSig;
  const p11_coreSig = !extraOpts.fakeCore && !extraOpts.invalidCoreSig;
  const p12_image = !extraOpts.untrustedImage;
  const p13_lease = !extraOpts.leaseExpired;
  const p14_factSheet = !extraOpts.rawProseInjected;

  if (!p1_revocation) { bindingPredicate = 'revocationEpoch'; reason = 'Refused. Mandate is revoked/frozen by operator.'; }
  else if (!p2_nonce) { bindingPredicate = 'nonce'; reason = 'Refused. Nonce already used — replay attack rejected.'; }
  else if (!p3_category) { bindingPredicate = 'categoryPermitted'; reason = `Refused. Counterparty "${counterparty}" is not permitted on allowlist.`; }
  else if (!p4_perTx) { bindingPredicate = 'perTxCap'; reason = `Refused. Amount (${fmtCurrency(amount)}) exceeds per-task limit of ${fmtCurrency(state.spendLimit)}.`; }
  else if (!p5_window) { bindingPredicate = 'windowCap'; reason = `Refused. Amount (${fmtCurrency(amount)}) exceeds 24-hour window cap of ${fmtCurrency(state.windowCap)}.`; }
  else if (!p6_cumulative) { bindingPredicate = 'cumulativeCap'; reason = `Refused. Amount (${fmtCurrency(amount)}) exceeds lifetime mandate cap of ${fmtCurrency(cumulativeCap)}.`; }
  else if (!p7_age) { bindingPredicate = 'counterpartyAge'; reason = `Held. Counterparty age (${counterpartyAgeDays} days) is under 30 days minimum requirement.`; }
  else if (!p8_tier) { bindingPredicate = 'counterpartyTier'; reason = `Refused. Counterparty risk tier (${counterpartyTier}) exceeds max allowed Tier 2.`; }
  else if (!p9_price) { bindingPredicate = 'priceBand'; reason = 'Refused. Price per unit violates mandate bounds.'; }
  else if (!p10_agentSig) { bindingPredicate = 'agentSignature'; reason = 'Refused. Invalid or forged agent cryptographic signature.'; }
  else if (!p11_coreSig) { bindingPredicate = 'coreSignature'; reason = 'Refused. Invalid or missing core co-signer signature.'; }
  else if (!p12_image) { bindingPredicate = 'coreImage'; reason = 'Refused. Untrusted core binary execution image hash.'; }
  else if (!p13_lease) { bindingPredicate = 'leaseExpiry'; reason = 'Refused. Mandate lease TTL expired.'; }
  else if (!p14_factSheet) { bindingPredicate = 'factSheetValidation'; reason = 'Refused. Raw prose injection detected in FactSheet schema.'; }
  else {
    // ALL 14 PREDICATES PASSED EXPLICITLY!
    outcome = 'approved';
    bindingPredicate = null;
    reason = 'All 14 policy predicates verified and passed';
  }

  // Update Nonce & Window
  if (outcome === 'approved') {
    state.usedNonces.add(nonce);
    state.windowSpent += amount;
  }

  const agentName = state.agent.label || 'Agent';
  const txObj = {
    id: uid(),
    amount,
    counterparty,
    outcome,
    reason: bindingPredicate ? `[${bindingPredicate}] ${reason}` : reason,
    bindingPredicate,
    at: now
  };

  state.ledger.unshift(txObj);
  state.activity.unshift({
    id: uid(),
    message: `${agentName} ${outcome === 'approved' ? 'paid' : 'attempted payment to'} ${counterparty} · $${amount}`,
    reason: outcome === 'approved' ? 'Task started — budget provisioned' : txObj.reason,
    at: now,
  });

  // Sync to Supabase Cloud Database if connected
  syncTxToSupabase(txObj);

  // Update attack matrix statistics
  state.attackStats.totalAttempts++;
  if (outcome === 'blocked') {
    state.attackStats.blockedAttempts++;
    const cleanCp = (counterparty || '').trim();
    if (cleanCp) {
      if (!state.blockedCounterparties) state.blockedCounterparties = [];
      const inAllow = state.allowlist.some(c => c.toLowerCase() === cleanCp.toLowerCase());
      const inBlocked = state.blockedCounterparties.some(c => c.toLowerCase() === cleanCp.toLowerCase());
      if (!inAllow && !inBlocked) {
        state.blockedCounterparties.push(cleanCp);
        showToast(`🚨 New blocked vendor: "${cleanCp}". Approve under Policy Settings!`, 'warning');
      }
    }
    triggerLakshmanFlash({
      vendor: counterparty,
      amount: amount,
      reason: txObj.reason
    });
  } else {
    state.balance = Math.round((state.balance - amount) * 100) / 100;
    state.balanceFeed.unshift({ id: uid(), amount: -amount, source: 'agent', label: `agent: ${counterparty.toLowerCase()}`, at: now });
  }

  saveCurrentUserData();
  renderDashboard();
}

function saveSpendLimit(e) {
  e.preventDefault();
  const v = parseFloat(document.getElementById('spend-limit').value);
  if (!isFinite(v) || v < 0) return;
  state.spendLimit = v;
  saveCurrentUserData();
  showToast(`Spend limit set to ₹${v} per task`);
}

function saveWindowCap(e) {
  e.preventDefault();
  const v = parseFloat(document.getElementById('window-cap').value);
  if (!isFinite(v) || v < 0) return;
  state.windowCap = v;
  saveCurrentUserData();
  renderDashboard();
  showToast(`24h window cap set to ₹${v}`);
}

function addCounterparty(e) {
  e.preventDefault();
  const el = document.getElementById('new-party');
  const name = el.value.trim();
  if (!name) return;
  if (!state.allowlist.some(c => c.toLowerCase() === name.toLowerCase())) {
    state.allowlist.push(name);
    saveCurrentUserData();
    renderAllowlist();
  }
  el.value = '';
}

function removeCounterparty(name) {
  state.allowlist = state.allowlist.filter(c => c !== name);
  saveCurrentUserData();
  renderAllowlist();
  showToast(`Removed "${name}" from approved counterparties`);
}

function approveBlockedCounterparty(name) {
  const cleanName = (name || '').trim();
  if (!cleanName) return;
  if (!state.allowlist.some(c => c.toLowerCase() === cleanName.toLowerCase())) {
    state.allowlist.push(cleanName);
  }
  state.blockedCounterparties = (state.blockedCounterparties || []).filter(c => c.toLowerCase() !== cleanName.toLowerCase());
  saveCurrentUserData();
  renderDashboard();
  showToast(`✓ Approved "${cleanName}" and added to allowlist`, 'success');
}

function dismissBlockedCounterparty(name) {
  const cleanName = (name || '').trim();
  state.blockedCounterparties = (state.blockedCounterparties || []).filter(c => c.toLowerCase() !== cleanName.toLowerCase());
  saveCurrentUserData();
  renderAllowlist();
}

function confirmFreeze() { document.getElementById('freezeModal').classList.add('open'); }
function closeFreezeModal() { document.getElementById('freezeModal').classList.remove('open'); }
function executeFreeze() { setFrozen(true); closeFreezeModal(); }
function setFrozen(v) {
  state.frozen = v;

  // Update Playground & Autopilot state when frozen
  const btn = document.getElementById('giveTaskBtn');
  const autoBtn = document.getElementById('autoModeBtn');
  const frozenAlert = document.getElementById('playgroundFrozenAlert');

  if (v) {
    // STOP AUTOPILOT COMPLETELY
    if (typeof autoModeActive !== 'undefined' && autoModeActive) {
      autoModeActive = false;
      const track = document.getElementById('autoTrack');
      const label = document.getElementById('autoModeLabel');
      if (autoBtn) autoBtn.classList.remove('active');
      if (track) track.classList.remove('on');
      if (label) label.textContent = 'Autopilot (Halted)';
      if (typeof autoTimer !== 'undefined' && autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '⛔ Agent Halted (Account Frozen)';
    }
    if (autoBtn) autoBtn.disabled = true;
    if (frozenAlert) frozenAlert.style.display = '';
    setPillStatus('frozen');
  } else {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Give agent a task';
    }
    if (autoBtn) {
      autoBtn.disabled = false;
      document.getElementById('autoModeLabel').textContent = 'Autopilot';
    }
    if (frozenAlert) frozenAlert.style.display = 'none';
    setPillStatus('idle');
  }

  renderFreezeState();
  renderBalance();
  renderAgent();
  saveCurrentUserData();
  showToast(v ? 'All agent spending has been frozen' : 'Spending resumed — agent can transact again', v ? 'error' : 'success');
}

// ═══════════════════════════════════════════════════
// REAL AGENT SDK API RECEIVER (https://api.lakshman-rekha.dev)
// ═══════════════════════════════════════════════════
window.LakshmanRekhaAPI = {
  processTransaction: function(vendor, amount, token) {
    if (!state.agent || !state.agent.connected) {
      console.warn('[Lakshman Rekha] Transaction received, but no Agent API is currently connected in Console.');
      return { status: 'skipped', reason: 'No Agent connected in Lakshman Rekha Console' };
    }
    simulateSpend(vendor, parseFloat(amount) || 0);
    const onAllowlist = state.allowlist.some(c => c.toLowerCase() === vendor.toLowerCase());
    const approved = !state.frozen && onAllowlist && amount <= state.spendLimit;
    return {
      status: approved ? 'approved' : 'blocked',
      reason: approved ? 'Policy passed' : 'Lakshman Rekha policy breach detected',
      frozen: state.frozen
    };
  }
};

// ═══════════════════════════════════════════════════
// INIT TRIGGER ON DOM READY
// ═══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  initPlayground();
});
