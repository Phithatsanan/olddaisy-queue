// ==================== Admin Page JS ====================
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // DOM refs
  const connectionStatus = $('connectionStatus');
  const connectionText = $('connectionText');
  const pinScreen = $('pinScreen');
  const pinDigits = [0, 1, 2, 3].map(i => $('pin' + i));
  const pinError = $('pinError');
  const btnLogin = $('btnLogin');
  const adminDashboard = $('adminDashboard');
  const adminDate = $('adminDate');
  const btnLogout = $('btnLogout');
  const adminStatCurrent = $('adminStatCurrent');
  const adminStatWaiting = $('adminStatWaiting');
  const adminStatTime = $('adminStatTime');
  const adminStatDone = $('adminStatDone');
  const btnCallNext = $('btnCallNext');
  const btnComplete = $('btnComplete');
  const btnReset = $('btnReset');
  const currentBanner = $('currentBanner');
  const noCurrentBanner = $('noCurrentBanner');
  const adminCurrentNumber = $('adminCurrentNumber');
  const adminCurrentInfo = $('adminCurrentInfo');
  const adminCurrentTimer = $('adminCurrentTimer');
  const waitingCount = $('waitingCount');
  const queueTableBody = $('queueTableBody');
  const queueTableWrapper = $('queueTableWrapper');
  const emptyQueue = $('emptyQueue');
  const qrImageContainer = $('qrImageContainer');
  const qrUrl = $('qrUrl');
  const resetModal = $('resetModal');
  const btnResetCancel = $('btnResetCancel');
  const btnResetConfirm = $('btnResetConfirm');

  // ==================== State ====================
  let isAuthenticated = false;
  let latestState = null;
  let serverTimeOffset = 0;

  function getServerNow() { return Date.now() + serverTimeOffset; }

  // Tick every second for queue timer (client-side only)
  setInterval(() => {
    if (isAuthenticated && latestState && latestState.currentQueue && latestState.currentQueue.startedAt) {
      const elapsedMs = getServerNow() - latestState.currentQueue.startedAt;
      const allocatedMs = latestState.currentQueue.totalMinutes * 60 * 1000;
      const remainingMs = Math.max(0, allocatedMs - elapsedMs);
      const totalSecs = Math.floor(remainingMs / 1000);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;

      if (remainingMs <= 0) {
        adminCurrentTimer.textContent = 'Overtime';
        adminCurrentTimer.classList.add('overtime');
        adminCurrentTimer.classList.remove('urgent');
      } else {
        adminCurrentTimer.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
        adminCurrentTimer.classList.remove('overtime');
        adminCurrentTimer.classList.toggle('urgent', remainingMs < 30000);
      }
    }
    updateDate();
  }, 1000);

  // ==================== Auth ====================
  const AUTH_KEY = 'photoqueue_admin_auth';

  function checkSavedAuth() {
    try {
      if (sessionStorage.getItem(AUTH_KEY) === 'true') {
        isAuthenticated = true;
        showDashboard();
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ==================== PIN ====================
  pinDigits.forEach((input, idx) => {
    input.addEventListener('input', (e) => {
      if (e.target.value && idx < 3) pinDigits[idx + 1].focus();
      btnLogin.disabled = pinDigits.map(d => d.value).join('').length < 4;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && idx > 0) pinDigits[idx - 1].focus();
    });
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const paste = (e.clipboardData || window.clipboardData).getData('text').slice(0, 4);
      paste.split('').forEach((c, i) => { if (pinDigits[i]) pinDigits[i].value = c; });
      btnLogin.disabled = paste.length < 4;
    });
  });

  btnLogin.addEventListener('click', async () => {
    const pin = pinDigits.map(d => d.value).join('');
    if (pin.length < 4) return;
    btnLogin.disabled = true;
    btnLogin.innerHTML = 'Verifying...';
    try {
      const res = await fetch(`/api/verify-pin?pin=${encodeURIComponent(pin)}`);
      const data = await res.json();
      if (data.success) {
        isAuthenticated = true;
        try { sessionStorage.setItem(AUTH_KEY, 'true'); } catch (e) {}
        showDashboard();
      } else {
        pinError.textContent = 'Invalid PIN';
        pinDigits.forEach(d => { d.value = ''; });
        pinDigits[0].focus();
      }
    } catch (err) {
      pinError.textContent = 'Connection Error';
    }
    btnLogin.disabled = false;
    btnLogin.innerHTML = 'Login';
  });

  pinDigits[3].addEventListener('keydown', (e) => { if (e.key === 'Enter') btnLogin.click(); });

  btnLogout.addEventListener('click', () => {
    try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
    isAuthenticated = false;
    pinScreen.style.display = '';
    adminDashboard.classList.add('hidden');
    pinDigits.forEach(d => { d.value = ''; });
    pinError.textContent = '';
    pinDigits[0].focus();
  });

  // ==================== Dashboard ====================
  function showDashboard() {
    pinScreen.style.display = 'none';
    adminDashboard.classList.remove('hidden');
    updateDate();
    loadQR();
  }

  function updateDate() {
    if (latestState && latestState.serverDate) {
      const parts = latestState.serverDate.split('-');
      const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      adminDate.textContent = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
  }

  function showAdminToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification toast-admin';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ==================== Socket.IO ====================
  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });

  socket.on('connect', () => updateConnectionStatus(true));
  socket.on('disconnect', () => updateConnectionStatus(false));

  socket.on('queue:state', (state) => {
    if (state.serverTimestamp) serverTimeOffset = state.serverTimestamp - Date.now();
    latestState = state;
    if (isAuthenticated) updateDashboard(state);
  });

  socket.on('queue:dayReset', () => {
    if (isAuthenticated) {
      showAdminToast('New day! Queue reset automatically.');
      updateDate();
    }
  });

  function updateConnectionStatus(connected) {
    connectionStatus.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
    connectionText.textContent = connected ? 'Connected' : 'Connecting...';
  }

  // ==================== Update Dashboard ====================
  function updateDashboard(state) {
    if (!state) return;
    adminStatCurrent.textContent = state.currentQueue ? '#' + state.currentQueue.number : '—';
    adminStatWaiting.textContent = state.totalWaiting;
    adminStatTime.textContent = state.totalEstimatedMinutes;
    adminStatDone.textContent = state.completedToday;

    if (state.currentQueue) {
      currentBanner.classList.remove('hidden');
      noCurrentBanner.classList.add('hidden');
      adminCurrentNumber.textContent = '#' + state.currentQueue.number;
      adminCurrentInfo.textContent = `${state.currentQueue.groupSize} ppl · ${state.currentQueue.totalMinutes} min`;
    } else {
      currentBanner.classList.add('hidden');
      noCurrentBanner.classList.remove('hidden');
    }

    renderQueueTable(state);
    btnCallNext.disabled = state.totalWaiting === 0;
    btnComplete.disabled = !state.currentQueue;
    updateDate();
  }

  function renderQueueTable(state) {
    waitingCount.textContent = state.totalWaiting;
    if (!state.waitingQueues || state.waitingQueues.length === 0) {
      queueTableWrapper.classList.add('hidden');
      emptyQueue.classList.remove('hidden');
      return;
    }
    queueTableWrapper.classList.remove('hidden');
    emptyQueue.classList.add('hidden');
    queueTableBody.innerHTML = state.waitingQueues.map((q) => `
      <tr>
        <td><span class="q-num">#${q.number}</span></td>
        <td><span class="q-people">${q.groupSize} ppl</span></td>
        <td class="q-time">${q.totalMinutes} min</td>
        <td class="q-time">~${q.estimatedMinutes} min</td>
        <td class="q-actions"><button class="btn btn-danger btn-sm" onclick="cancelQueue('${q.id}',${q.number})">X</button></td>
      </tr>
    `).join('');
  }

  // ==================== Actions ====================
  let callNextTimer = null;
  btnCallNext.addEventListener('click', () => {
    if (!btnCallNext.classList.contains('confirming')) {
      btnCallNext.classList.add('confirming');
      btnCallNext.innerHTML = 'Press again to Call';
      callNextTimer = setTimeout(() => {
        btnCallNext.classList.remove('confirming');
        btnCallNext.innerHTML = 'Call Next';
      }, 3000);
      return;
    }

    clearTimeout(callNextTimer);
    btnCallNext.classList.remove('confirming');
    btnCallNext.innerHTML = 'Calling...';
    btnCallNext.disabled = true;
    socket.emit('queue:callNext', {}, (res) => {
      btnCallNext.disabled = false;
      btnCallNext.innerHTML = 'Call Next';
      if (!res || !res.success) {
        if (res && res.message) showAdminToast(res.message);
      }
    });
  });

  let completeTimer = null;
  btnComplete.addEventListener('click', () => {
    if (!btnComplete.classList.contains('confirming')) {
      btnComplete.classList.add('confirming');
      btnComplete.innerHTML = 'Press again to Finish';
      completeTimer = setTimeout(() => {
        btnComplete.classList.remove('confirming');
        btnComplete.innerHTML = 'Finish Turn';
      }, 3000);
      return;
    }

    clearTimeout(completeTimer);
    btnComplete.classList.remove('confirming');
    btnComplete.innerHTML = 'Finishing...';
    btnComplete.disabled = true;
    socket.emit('queue:complete', {}, (res) => {
      btnComplete.disabled = false;
      btnComplete.innerHTML = 'Finish Turn';
      if (!res || !res.success) {
        if (res && res.message) showAdminToast(res.message);
      }
    });
  });

  btnReset.addEventListener('click', () => resetModal.classList.remove('hidden'));
  btnResetCancel.addEventListener('click', () => resetModal.classList.add('hidden'));
  btnResetConfirm.addEventListener('click', () => {
    socket.emit('queue:reset', {}, () => resetModal.classList.add('hidden'));
  });

  window.cancelQueue = function (queueId, number) {
    if (!confirm(`Cancel queue #${number}?`)) return;
    socket.emit('queue:cancel', { queueId });
  };

  // ==================== QR ====================
  async function loadQR() {
    try {
      const res = await fetch('/api/qr');
      const data = await res.json();
      qrImageContainer.innerHTML = `<img src="${data.qrDataUrl}" alt="QR Code" />`;
      qrUrl.textContent = data.url;
    } catch (err) {
      qrImageContainer.innerHTML = '<p style="color:var(--accent-red);">Failed to generate QR Code</p>';
    }
  }

  // ==================== Init ====================
  if (!checkSavedAuth()) pinDigits[0].focus();
})();
