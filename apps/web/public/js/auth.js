// ═══════════════════════════════════════════════════
// REAL AUTHENTICATION & USER MANAGEMENT
// ═══════════════════════════════════════════════════
const DEFAULT_USERS = [
  { username: 'demo', email: 'demo@example.com', name: 'Demo Operator', password: '123' },
  { username: 'ada', email: 'ada@example.com', name: 'Ada Lovelace', password: '123' }
];

function getRegisteredUsers() {
  try {
    const stored = localStorage.getItem('lakshman_users');
    if (stored) {
      const list = JSON.parse(stored);
      if (Array.isArray(list) && list.some(u => (u.username === 'demo' || u.email === 'demo@example.com') && u.password === '123')) {
        return list;
      }
    }
  } catch(e) {}
  localStorage.setItem('lakshman_users', JSON.stringify(DEFAULT_USERS));
  return DEFAULT_USERS;
}

function saveRegisteredUsers(users) {
  try {
    localStorage.setItem('lakshman_users', JSON.stringify(users));
  } catch(e) {}
}

function fillDemoUser() {
  document.getElementById('login-username').value = 'demo';
  document.getElementById('login-password').value = '123';
  const errBox = document.getElementById('authErrorMsg');
  if (errBox) errBox.style.display = 'none';
}

function showLogin() {
  document.getElementById('loginForm').style.display = '';
  document.getElementById('signupForm').style.display = 'none';
  const errBox = document.getElementById('authErrorMsg');
  if (errBox) errBox.style.display = 'none';
}

function showSignup() {
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('signupForm').style.display = '';
  const errBox = document.getElementById('signupErrorMsg');
  if (errBox) errBox.style.display = 'none';
}

function getUserDataKey(username) {
  return 'lakshman_user_data_' + (username || 'guest').toLowerCase();
}

function saveCurrentUserData() {
  if (!state.session || !state.session.username) return;
  const key = getUserDataKey(state.session.username);
  const userRecord = {
    balance: state.balance,
    frozen: state.frozen,
    agent: state.agent,
    spendLimit: state.spendLimit,
    allowlist: state.allowlist,
    blockedCounterparties: state.blockedCounterparties || [],
    balanceFeed: state.balanceFeed,
    ledger: state.ledger,
    activity: state.activity,
    breachCount: breachCount
  };
  try {
    localStorage.setItem(key, JSON.stringify(userRecord));
  } catch(e) {}
}

function loadUserData(username) {
  const uKey = (username || 'guest').toLowerCase();
  const storageKey = getUserDataKey(uKey);

  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored);
      state.balance = parsed.balance ?? 0;
      state.frozen = parsed.frozen ?? false;
      state.agent = parsed.agent || { label: '', endpoint: '', connected: false };
      state.spendLimit = parsed.spendLimit ?? 100;
      state.allowlist = parsed.allowlist ?? ['Meta Ads', 'OpenAI', 'Google Cloud', 'Vercel'];
      state.blockedCounterparties = parsed.blockedCounterparties || [];
      state.balanceFeed = parsed.balanceFeed || [];
      state.ledger = parsed.ledger || [];
      state.activity = parsed.activity || [];
      breachCount = parsed.breachCount || 0;
      document.getElementById('breachCount').textContent = breachCount;
      return;
    }
  } catch(e) {}

  // If new user (no saved state yet):
  const defaultFeed = (typeof DEMO_BALANCE_FEED !== 'undefined') ? DEMO_BALANCE_FEED : [];
  const defaultLedger = (typeof DEMO_LEDGER !== 'undefined') ? DEMO_LEDGER : [];
  const defaultActivity = (typeof DEMO_ACTIVITY !== 'undefined') ? DEMO_ACTIVITY : [];

  if (uKey === 'demo') {
    state.balance = 490;
    state.frozen = false;
    state.agent = { label: '', endpoint: '', connected: false };
    state.spendLimit = 100;
    state.allowlist = ['Meta Ads', 'OpenAI', 'Google Cloud', 'Vercel'];
    state.balanceFeed = [...defaultFeed];
    state.ledger = [...defaultLedger];
    state.activity = [...defaultActivity];
    breachCount = 1;
  } else {
    // Completely FRESH empty account for new registered users!
    state.balance = 0;
    state.frozen = false;
    state.agent = { label: '', endpoint: '', connected: false };
    state.spendLimit = 100;
    state.allowlist = ['Meta Ads', 'OpenAI', 'Google Cloud', 'Vercel'];
    state.balanceFeed = [];
    state.ledger = [];
    state.activity = [];
    breachCount = 0;
  }
  document.getElementById('breachCount').textContent = breachCount;
  saveCurrentUserData();
}

function showDashboardView(name) {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('dashboard-screen').style.display = '';
  document.getElementById('topbar-user').textContent = name;
  renderDashboard();
}

function handleLogin(e) {
  if (e) e.preventDefault();
  const errBox = document.getElementById('authErrorMsg');
  if (errBox) errBox.style.display = 'none';

  const userInput = (document.getElementById('login-username').value || '').trim().toLowerCase();
  const passInput = (document.getElementById('login-password').value || '').trim();

  if (!userInput || !passInput) {
    errBox.textContent = 'Please enter both username and password.';
    errBox.style.display = 'block';
    return;
  }

  // 100% Guaranteed Demo Account Check
  const isDemo = (userInput === 'demo' || userInput === 'demo@example.com');
  if (isDemo && passInput === '123') {
    state.session = { name: 'Demo Operator', username: 'demo' };
    loadUserData('demo');
    showDashboardView('Demo Operator');
    showToast('Welcome back, Demo Operator');
    return;
  }

  // Registered Users Check
  const users = getRegisteredUsers();
  const matchedUser = users.find(u => {
    const uName = (u.username || '').toLowerCase();
    const uEmail = (u.email || '').toLowerCase();
    return (uName === userInput || uEmail === userInput) && u.password === passInput;
  });

  if (matchedUser) {
    state.session = { name: matchedUser.name || matchedUser.username, username: matchedUser.username || matchedUser.name };
    loadUserData(matchedUser.username);
    showDashboardView(matchedUser.name || matchedUser.username);
    showToast('Welcome back, ' + (matchedUser.name || matchedUser.username));
  } else {
    errBox.innerHTML = '❌ Invalid username or password. Click <strong>🔑 Fill Demo Credentials (demo / 123)</strong> to log in.';
    errBox.style.display = 'block';
  }
}

function handleSignup(e) {
  if (e) e.preventDefault();
  const errBox = document.getElementById('signupErrorMsg');
  if (errBox) errBox.style.display = 'none';

  const username = (document.getElementById('signup-username').value || '').trim().toLowerCase();
  const name = (document.getElementById('signup-name').value || '').trim() || username;
  const password = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-confirm').value;

  if (!username || !password || !confirm) {
    errBox.textContent = 'Please fill in all required fields.';
    errBox.style.display = 'block';
    return;
  }

  if (password !== confirm) {
    errBox.textContent = 'Passwords do not match.';
    errBox.style.display = 'block';
    return;
  }

  const users = getRegisteredUsers();
  if (users.some(u => (u.username || '').toLowerCase() === username)) {
    errBox.textContent = 'Username "' + username + '" is already taken. Please choose another username.';
    errBox.style.display = 'block';
    return;
  }

  // Register new user
  const newUser = { username, name, password };
  users.push(newUser);
  saveRegisteredUsers(users);

  // Auto login with fresh empty state!
  state.session = { name: newUser.name, username: newUser.username };
  loadUserData(newUser.username);
  showDashboardView(newUser.name);
  showToast('Account created successfully! Welcome, ' + newUser.name);
}

function handleLogout() {
  state.session = null;
  document.getElementById('auth-screen').style.display = '';
  document.getElementById('dashboard-screen').style.display = 'none';
  showToast('Logged out');
}
