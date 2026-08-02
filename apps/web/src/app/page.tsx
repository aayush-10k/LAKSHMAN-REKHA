'use client';

import React, { useEffect } from 'react';
import { useWriteContract } from 'wagmi';

// Include the raw HTML of the body from project3
const rawHtml = `
  <!-- ═══════════════════════════════════════════════════ -->
  <!-- SINGLE FIXED UNMOVED VIEW SWITCH                   -->
  <!-- ═══════════════════════════════════════════════════ -->
  <div class="view-switch-wrapper" id="switchWrapper">
    <span class="view-switch-label active" id="labelKS">Lakshman Rekha</span>
    <button class="view-switch-track" id="viewSwitch" role="switch" aria-checked="false" aria-label="Toggle between Lakshman Rekha and Agent Playground" onclick="toggleView()">
      <span class="view-switch-thumb">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="color:var(--primary)">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    </button>
    <span class="view-switch-label inactive" id="labelPG">Agent Playground</span>
  </div>

  <!-- ═══════════════════════════════════════════════════ -->
  <!-- VIEW 1: LAKSHMAN REKHA DASHBOARD                   -->
  <!-- ═══════════════════════════════════════════════════ -->
  <div class="page-view active" id="dashboardView">
    <!-- Auth Screen -->
    <div id="auth-screen">
      <div class="auth-glow"></div>
      <div class="auth-box">
        <div class="auth-header">
          <div class="auth-logo">
            <svg class="icon-xl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <h1>Lakshman Rekha Console</h1>
          <p>The trust and enforcement boundary for your autonomous agents.</p>
        </div>
        <div class="card">
          <div style="padding:24px">
            <div id="loginForm">
              <div style="margin-bottom:20px">
                <h2 style="font-size:17px;font-weight:500">Log in</h2>
                <p style="font-size:13px;color:var(--muted);margin-top:4px">Welcome back. Enter your username and password.</p>
              </div>
              <div id="authErrorMsg" style="display:none;padding:10px 12px;border-radius:8px;background:rgba(212,67,92,0.1);border:1px solid rgba(212,67,92,0.3);color:var(--danger);font-size:12px;margin-bottom:14px"></div>
              <form class="auth-form" onsubmit="handleLogin(event)">
                <div><label class="label" for="login-username">Username or Email</label><input class="input-field" id="login-username" placeholder="e.g. demo" value="demo" required /></div>
                <div><label class="label" for="login-password">Password</label><input class="input-field" id="login-password" type="password" placeholder="••••••••" value="123" required /></div>
                <button type="submit" class="btn btn-primary" style="width:100%">Log in</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="fillDemoUser()" style="width:100%;margin-top:4px;gap:6px">
                  🔑 Fill Demo Credentials (demo / 123)
                </button>
              </form>
              <p class="auth-footer" style="margin-top:16px">Don't have an account? <a onclick="showSignup()">Sign up</a></p>
            </div>
            <div id="signupForm" style="display:none">
              <div style="margin-bottom:20px">
                <h2 style="font-size:17px;font-weight:500">Create account</h2>
                <p style="font-size:13px;color:var(--muted);margin-top:4px">Choose a username to set up your enforcement account.</p>
              </div>
              <div id="signupErrorMsg" style="display:none;padding:10px 12px;border-radius:8px;background:rgba(212,67,92,0.1);border:1px solid rgba(212,67,92,0.3);color:var(--danger);font-size:12px;margin-bottom:14px"></div>
              <form class="auth-form" onsubmit="handleSignup(event)">
                <div><label class="label" for="signup-username">Username</label><input class="input-field" id="signup-username" placeholder="e.g. alex" required /></div>
                <div><label class="label" for="signup-name">Display Name</label><input class="input-field" id="signup-name" placeholder="Alex Rivers" required /></div>
                <div><label class="label" for="signup-password">Password</label><input class="input-field" id="signup-password" type="password" placeholder="••••••••" required /></div>
                <div><label class="label" for="signup-confirm">Confirm Password</label><input class="input-field" id="signup-confirm" type="password" placeholder="••••••••" required /></div>
                <button type="submit" class="btn btn-primary" style="width:100%">Create account</button>
              </form>
              <p class="auth-footer" style="margin-top:16px">Already have an account? <a onclick="showLogin()">Log in</a></p>
            </div>
          </div>
        </div>
        <p style="margin-top:16px;text-align:center;font-size:11px;color:var(--muted)">
          Demo Credentials: <strong>demo / 123</strong>
        </p>
      </div>
    </div>

    <!-- Dashboard -->
    <div id="dashboard-screen" style="display:none">
      <div class="topbar">
        <div class="topbar-inner">
          <div class="topbar-brand">
            <div class="topbar-logo">
              <svg class="icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div class="topbar-text">
              <p>Lakshman Rekha</p>
              <p id="topbar-agent-status">No agent linked</p>
            </div>
          </div>
          <div class="topbar-center">
            <div id="defenseShieldBadge" class="badge badge-success">
              🛡️ 100% Defense Shield (0 Blocked)
            </div>
          </div>
          <div class="topbar-right">
            <button class="btn btn-ghost" onclick="showSupabaseModal()">
              <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
              Cloud DB
            </button>
            <span class="breach-counter-badge" id="breachBadge">
              🛡️ Intercepted: <span id="breachCount">0</span>
            </span>
            <div class="topbar-user" id="topbar-user">Demo User</div>
            <button class="btn btn-outline btn-sm" onclick="handleLogout()">Log out</button>
          </div>
        </div>
      </div>
      
      <!-- Frozen Banner -->
      <div class="frozen-banner" id="frozenBanner">
        <div class="frozen-banner-inner">
          <p>
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            Account is frozen. Agent capabilities suspended.
          </p>
          <button class="btn btn-sm" onclick="executeUnfreeze()">Un-freeze Now</button>
        </div>
      </div>

      <div class="dashboard-main">
        <div class="dashboard-heading">
          <h1>Owner Console</h1>
          <p>Manage agent spending caps, review holding queue, and configure policies.</p>
        </div>

        <div class="dashboard-grid">
          <!-- Left Column -->
          <div class="dashboard-left">
            <div class="card">
              <div class="card-header">
                <span class="card-title">
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                  Agent Balance
                </span>
                <button class="btn btn-secondary btn-sm" onclick="showAddFunds()">Add funds</button>
              </div>
              <div class="card-content">
                <div class="wallet-balance" id="walletBalance">₹0.00</div>
                <div class="wallet-subtitle" id="walletSubtitle">Shared across manual top-ups and agent activity</div>
                <div class="balance-feed">
                  <div class="balance-feed-title">Recent Activity</div>
                  <div class="balance-feed-list" id="balanceFeed"></div>
                </div>
              </div>
            </div>

            <div class="card freeze-card" id="freezeCard">
              <div class="card-header">
                <span class="card-title">
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  Emergency Kill Switch
                </span>
              </div>
              <div class="card-content">
                <p class="freeze-desc">Instantly revoke the agent\\'s cryptographic mandate. Blocks all future transactions and cancels pending ones.</p>
                <div style="display:flex;gap:10px">
                  <button class="btn btn-danger" style="flex:1" onclick="showFreezeModal()" id="btnFreeze">FREEZE AGENT</button>
                  <!-- We will inject the React Wagmi button here dynamically -->
                  <div id="react-revoke-btn-container" style="flex:1"></div>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card-header"><span class="card-title">Agent Connection</span></div>
              <div class="card-content">
                <div class="agent-info-box" id="agentInfoBox">
                  <p>Not Connected</p>
                  <p>Awaiting developer keys.</p>
                </div>
                <p class="agent-frozen-note" id="agentFrozenNote" style="display:none">
                  Agent connection is currently frozen.
                </p>
                <div class="agent-buttons" style="margin-top:16px">
                  <button class="btn btn-primary" onclick="showAgentDevModal()">Get API Keys</button>
                  <button class="btn btn-outline" onclick="disconnectAgent()">Disconnect</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Right Column -->
          <div class="dashboard-right">
            <div class="card">
              <div class="card-header"><span class="card-title">Live Transaction Ledger</span></div>
              <div class="card-content" style="padding:0">
                <div class="ledger-scroll">
                  <table class="ledger-table">
                    <thead><tr><th>Time</th><th>Counterparty / Vendor</th><th style="text-align:right">Amount</th><th style="text-align:right">Outcome</th></tr></thead>
                    <tbody id="ledgerBody"></tbody>
                  </table>
                </div>
              </div>
            </div>

            <div class="dashboard-right-row">
              <div class="card" style="flex:1">
                <div class="card-header"><span class="card-title">Smart Policy Simulator</span></div>
                <div class="card-content">
                  <div class="policy-form">
                    <div class="policy-row">
                      <div style="flex:1">
                        <label class="label">Per-Transaction Limit</label>
                        <div class="input-dollar"><input class="input-field" type="number" id="polTxLimit" value="10000" onchange="updatePolicy()" /></div>
                      </div>
                      <div style="flex:1">
                        <label class="label">24h Rolling Window Cap</label>
                        <div class="input-dollar"><input class="input-field" type="number" id="polWindowCap" value="30000" onchange="updatePolicy()" /></div>
                      </div>
                    </div>
                    <div>
                      <label class="label">Category Allowlist</label>
                      <div class="allowlist-chips" id="allowlistChips"></div>
                      <div style="display:flex;gap:8px">
                        <input class="input-field" id="newCategory" placeholder="e.g. AWS" onkeypress="if(event.key==='Enter')addCategory()" />
                        <button class="btn btn-secondary" onclick="addCategory()">Add</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="card" style="flex:1">
                <div class="card-header"><span class="card-title">Activity Log</span></div>
                <div class="card-content" style="padding:16px 20px">
                  <div class="activity-scroll">
                    <div class="activity-timeline" id="activityTimeline"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Agent Playground -->
    <div class="page-view hidden-view" id="playgroundView">
      <div class="playground-container">
        <div class="playground-box">
          <div class="playground-header">
            <h1>Agent Simulator</h1>
            <p>Run simulated objectives. Watch the agent evaluate quotes, forge payments, or get intercepted by Lakshman Rekha.</p>
          </div>
          
          <div class="card">
            <div class="card-content" style="padding-top:20px">
              <div style="display:flex;justify-content:space-between;align-items:flex-end">
                <div>
                  <label class="label">Agent Status</label>
                  <div class="status-pill pill-idle" id="pgStatusPill">
                    <div class="status-dot-wrapper"><div class="status-dot"></div><div class="status-dot-ping"></div></div>
                    <span id="pgStatusText">Idle · Waiting for task</span>
                  </div>
                </div>
                <div style="margin-bottom:20px">
                  <span id="autoModeCount" style="font-size:12px;color:var(--muted);margin-right:8px;font-variant-numeric:tabular-nums;display:none">0 runs</span>
                </div>
              </div>

              <!-- Task Selector -->
              <div style="margin-bottom:20px">
                <label class="label" style="display:flex;justify-content:space-between">
                  Objective Template
                  <span style="font-weight:400;color:var(--muted);font-size:11px">Randomizes vendor & amount</span>
                </label>
                <div class="task-tabs">
                  <button class="task-tab active" id="tabRandom" onclick="setTaskSource('random')">Random Template</button>
                  <button class="task-tab" id="tabManual" onclick="setTaskSource('manual')">Select Manual</button>
                </div>
                <div class="task-list" id="taskList" style="display:none"></div>
              </div>

              <!-- Attack Mode Selector -->
              <div>
                <label class="label">Agent Behavior</label>
                <div class="mode-list" id="modeList"></div>
              </div>
              
              <!-- Progress -->
              <div class="progress-section" id="pgProgressSection" style="opacity:0">
                <div class="progress-header">
                  <span class="progress-label" id="pgProgressLabel">Running task...</span>
                  <span class="progress-pct" id="pgProgressPct">0%</span>
                </div>
                <div class="progress-track">
                  <div class="progress-fill normal" id="pgProgressFill" style="width:0%"></div>
                </div>
                <div class="last-task-info" id="lastTaskInfo"></div>
              </div>
              
              <!-- Auto Mode Settings -->
              <div class="auto-mode-section">
                <button class="auto-mode-toggle" id="autoModeToggle" onclick="toggleAutoMode()">
                  <div class="auto-dot" id="autoModeDot"></div>
                  <span>Rogue Mode: Continuous Attacks</span>
                </button>
                <div class="auto-stats" id="autoStats">
                  <span>Speed: <strong>0.5s</strong></span>
                  <div class="stat-divider"></div>
                  <span>Blocked: <strong class="stat-value" id="autoBlockedStat" style="color:var(--danger)">0</strong></span>
                  <div class="stat-divider"></div>
                  <span>Breached: <strong class="stat-value" id="autoBreachedStat">0</strong></span>
                </div>
              </div>

              <!-- Start Button -->
              <div style="margin-top:24px">
                <button class="btn btn-primary btn-lg" id="btnStartTask" style="width:100%" onclick="startPlaygroundTask()">
                  Start Single Simulation
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modals -->
    <!-- Add Funds Modal -->
    <div class="modal-overlay" id="addFundsModal">
      <div class="modal-box">
        <div class="modal-header"><h3>Add Funds</h3><p>Mock deposit to the agent\\'s shared wallet.</p></div>
        <div class="modal-body">
          <label class="label">Amount to add</label>
          <div class="input-dollar"><input class="input-field" type="number" id="fundAmount" value="5000" /></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeAddFunds()">Cancel</button>
          <button class="btn btn-primary" onclick="executeAddFunds()">Deposit Funds</button>
        </div>
      </div>
    </div>

    <!-- Agent Dev Modal -->
    <div class="modal-overlay" id="agentDevModal">
      <div class="modal-box" style="max-width:540px">
        <div class="modal-header">
          <h3 style="display:flex;align-items:center;gap:8px;color:var(--accent)">
            <span>💻</span> Agent API Credentials
          </h3>
          <p>Use these credentials to connect real AI agents.</p>
        </div>
        <div class="modal-body">
          <div style="margin-top:14px">
            <pre id="devCodeBox" style="background:#0e1017;color:#80caff;padding:12px;border-radius:8px;font-family:monospace;font-size:11px;overflow-x:auto;line-height:1.5;max-height:160px">API KEY: lr_live_sk_892374982374</pre>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeAgentDevModal()">Close</button>
        </div>
      </div>
    </div>

    <!-- Freeze Modal -->
    <div class="modal-overlay" id="freezeModal">
      <div class="modal-box">
        <div class="modal-header">
          <h3 style="color:var(--danger)">Freeze all spending?</h3>
          <p>This immediately blocks every agent-initiated payment.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeFreezeModal()">Cancel</button>
          <button class="btn btn-danger" onclick="executeFreeze()">Yes, freeze now</button>
        </div>
      </div>
    </div>

    <!-- Supabase Modal -->
    <div class="modal-overlay" id="supabaseModal">
      <div class="modal-box" style="max-width:480px">
        <div class="modal-header">
          <h3 style="color:var(--success)">Supabase Cloud DB</h3>
        </div>
        <div class="modal-body">
          <form class="auth-form" id="supabaseForm" onsubmit="saveSupabaseConfig(event)">
            <div><label class="label">Project URL</label><input class="input-field" id="supabase-url" /></div>
            <div style="margin-top:12px"><label class="label">Anon Key</label><input class="input-field" id="supabase-key" type="password" /></div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeSupabaseModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveSupabaseConfig(event)">Connect</button>
        </div>
      </div>
    </div>

    <!-- Lakshman Overlay -->
    <div class="lakshman-overlay" id="lakshmanOverlay" onclick="dismissLakshmanFlash()">
      <div class="lakshman-grid"></div>
      <div class="lakshman-laser-line"></div>
      <div class="lakshman-alert-box" onclick="event.stopPropagation()">
        <div style="font-size:36px;margin-bottom:8px">🚨 🛑 🚨</div>
        <h2 class="lakshman-title">LAKSHMAN REKHA BREACH DETECTED</h2>
        <p class="lakshman-subtitle">MALICIOUS AGENT TRANSACTION INTERCEPTED</p>
        <div class="lakshman-details">
          <div class="lakshman-detail-row"><span class="lakshman-detail-label">Target Vendor</span><span class="lakshman-detail-val" id="flashVendor">Unknown Vendor</span></div>
          <div class="lakshman-detail-row"><span class="lakshman-detail-label">Intercepted Amount</span><span class="lakshman-detail-val danger" id="flashAmount">$450.00</span></div>
          <div class="lakshman-detail-row"><span class="lakshman-detail-label">Reason</span><span class="lakshman-detail-val" id="flashReason" style="color:#ffb3c6">Exceeds limit</span></div>
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn btn-outline" style="flex:1;border-color:rgba(255,255,255,0.2);color:#fff" onclick="dismissLakshmanFlash()">Keep Frozen</button>
          <button class="btn btn-primary" style="flex:1;background:var(--success);border-color:var(--success);color:#fff" onclick="unfreezeFromFlash()">Un-freeze Now</button>
        </div>
      </div>
    </div>
    
    <div class="toast-container" id="toastContainer"></div>
`;

// Extract scripts logic using dangerouslySetInnerHTML
export default function ConsolePage() {
    const { writeContract, isPending } = useWriteContract();
    
    // Minimal integration with wagmi (based on console/page.tsx)
    const POLICY_MODULE_ADDRESS = '0x933bb10252ec2b133f28b7d5edf1d303c3384d87';
    const revokeAbi = [{ type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const;

    const handleRevoke = () => {
        writeContract({
            address: POLICY_MODULE_ADDRESS,
            abi: revokeAbi,
            functionName: 'revoke',
        });
    };

    // Inject scripts dynamically (avoids hydration mismatch from next/script in dangerouslySetInnerHTML tree)
    useEffect(() => {
        function loadScript(src: string, onload?: () => void) {
            // Avoid double-loading
            if (document.querySelector(`script[src="${src}"]`)) {
                if (onload) onload();
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.async = false;
            if (onload) s.onload = onload;
            document.body.appendChild(s);
        }
        // Load supabase first, then bundle (order matters)
        loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', () => {
            loadScript('/js/bundle.js');
        });
    }, []);

    // Revoke button injection after scripts load
    useEffect(() => {
        const container = document.getElementById('react-revoke-btn-container');
        if (container) {
            container.innerHTML = `<button id="wagmiRevokeBtn" class="btn btn-danger" style="width:100%;border:1px solid #d4435c;background:transparent;color:#d4435c">${isPending ? 'Revoking on Chain...' : 'Revoke on Chain (Wagmi)'}</button>`;
            const btn = document.getElementById('wagmiRevokeBtn');
            if (btn) btn.onclick = handleRevoke;
        }
    }, [isPending, handleRevoke]);

    return (
        <div id="app-body-wrapper" className="playground-mode">
            <div dangerouslySetInnerHTML={{ __html: rawHtml }} />
        </div>
    );
}
