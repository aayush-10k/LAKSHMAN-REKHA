// SUPABASE DATABASE & AUTH INTEGRATION
const DEFAULT_SUPABASE_URL = 'https://mddtbwbrfotglqzhprzq.supabase.co';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZHRid2JyZm90Z2xxemhwcnpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MDU5OTcsImV4cCI6MjEwMTE4MTk5N30.t34Kwl4aEp0UP1Pfvu4zv_5mVfxSQhtNO1D92qUeEqU';
let supabaseClient = null;

function initSupabase() {
  const url = localStorage.getItem('lakshman_supabase_url') || DEFAULT_SUPABASE_URL;
  const key = localStorage.getItem('lakshman_supabase_key') || DEFAULT_SUPABASE_KEY;
  const badge = document.getElementById('supabaseStatusBadge');

  if (url && key && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(url, key);
      if (badge) {
        badge.style.borderColor = 'rgba(45,165,108,0.4)';
        badge.style.color = 'var(--success)';
        badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:var(--success)"></span> ⚡ Supabase Cloud Live';
      }
    } catch(e) {
      console.error('Supabase init error:', e);
    }
  } else if (badge) {
    badge.style.borderColor = 'var(--border)';
    badge.style.color = 'var(--muted)';
    badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:var(--muted)"></span> ⚡ Config Supabase';
  }
}

function openSupabaseModal() {
  document.getElementById('supabaseModal').classList.add('open');
  const url = localStorage.getItem('lakshman_supabase_url') || DEFAULT_SUPABASE_URL;
  const key = localStorage.getItem('lakshman_supabase_key') || DEFAULT_SUPABASE_KEY;
  document.getElementById('supabase-url').value = url;
  document.getElementById('supabase-key').value = key;
}

function closeSupabaseModal() {
  document.getElementById('supabaseModal').classList.remove('open');
}

function saveSupabaseConfig(e) {
  if (e) e.preventDefault();
  const url = (document.getElementById('supabase-url').value || '').trim();
  const key = (document.getElementById('supabase-key').value || '').trim();

  if (url && key) {
    localStorage.setItem('lakshman_supabase_url', url);
    localStorage.setItem('lakshman_supabase_key', key);
    initSupabase();
    closeSupabaseModal();
    showToast('Supabase Cloud connected successfully!', 'success');
  } else {
    localStorage.removeItem('lakshman_supabase_url');
    localStorage.removeItem('lakshman_supabase_key');
    supabaseClient = null;
    initSupabase();
    closeSupabaseModal();
    showToast('Supabase config cleared — running in local mode', 'error');
  }
}

// Sync breaches to Supabase DB
async function syncBreachToSupabase(details) {
  if (!supabaseClient) return;
  try {
    await supabaseClient.from('breaches').insert([
      { vendor: details.vendor, amount: details.amount, reason: details.reason }
    ]);
  } catch(e) {}
}

// Sync transactions to Supabase DB
async function syncTxToSupabase(tx) {
  if (!supabaseClient) return;
  try {
    await supabaseClient.from('transactions').insert([
      { counterparty: tx.counterparty, amount: tx.amount, outcome: tx.outcome, reason: tx.reason }
    ]);
  } catch(e) {}
}
