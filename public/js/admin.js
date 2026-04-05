// ==================== Admin Page JS ====================
(function () {
  'use strict';

  // ==================== DOM Elements ====================
  const $ = (id) => document.getElementById(id);

  const connectionStatus = $('connectionStatus');
  const connectionText = $('connectionText');

  // PIN
  const pinScreen = $('pinScreen');
  const pinDigits = [0, 1, 2, 3].map(i => $('pin' + i));
  const pinError = $('pinError');
  const btnLogin = $('btnLogin');

  // Dashboard
  const adminDashboard = $('adminDashboard');
  const adminDate = $('adminDate');
  const btnLogout = $('btnLogout');

  // Stats
  const adminStatCurrent = $('adminStatCurrent');
  const adminStatWaiting = $('adminStatWaiting');
  const adminStatTime = $('adminStatTime');
  const adminStatDone = $('adminStatDone');

  // Actions
  const btnCallNext = $('btnCallNext');
  const btnComplete = $('btnComplete');
  const btnReset = $('btnReset');

  // Current banner
  const currentBanner = $('currentBanner');
  const noCurrentBanner = $('noCurrentBanner');
  const adminCurrentNumber = $('adminCurrentNumber');
  const adminCurrentInfo = $('adminCurrentInfo');
  const adminCurrentTimer = $('adminCurrentTimer');

  // Queue table
  const waitingCount = $('waitingCount');
  const queueTableBody = $('queueTableBody');
  const queueTableWrapper = $('queueTableWrapper');
  const emptyQueue = $('emptyQueue');

  // QR
  const qrImageContainer = $('qrImageContainer');
  const qrUrl = $('qrUrl');

  // Reset modal
  const resetModal = $('resetModal');
  const btnResetCancel = $('btnResetCancel');
  const btnResetConfirm = $('btnResetConfirm');

  // ==================== State ====================
  let isAuthenticated = false;
  let latestState = null;
  let timerInterval = null;
  let dateInterval = null;

  // ==================== Auth ====================
  const AUTH_KEY = 'photoqueue_admin_auth';

  function checkSavedAuth() {
    try {
      const saved = sessionStorage.getItem(AUTH_KEY);
      if (saved === 'true') {
        isAuthenticated = true;
        showDashboard();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function saveAuth() {
    try { sessionStorage.setItem(AUTH_KEY, 'true'); } catch (e) {}
  }

  function clearAuth() {
    try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
    isAuthenticated = false;
  }

  // ==================== PIN Input ====================
  pinDigits.forEach((input, idx) => {
    input.addEventListener('input', (e) => {
      const val = e.target.value;
      if (val && idx < 3) {
        pinDigits[idx + 1].focus();
      }
      checkPinComplete();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && idx > 0) {
        pinDigits[idx - 1].focus();
      }
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const paste = (e.clipboardData || window.clipboardData).getData('text').slice(0, 4);
      paste.split('').forEach((char, i) => {
        if (pinDigits[i]) pinDigits[i].value = char;
      });
      checkPinComplete();
    });
  });

  function checkPinComplete() {
    const pin = pinDigits.map(d => d.value).join('');
    btnLogin.disabled = pin.length < 4;
  }

  function getPin() {
    return pinDigits.map(d => d.value).join('');
  }

  btnLogin.addEventListener('click', async () => {
    const pin = getPin();
    if (pin.length < 4) return;

    btnLogin.disabled = true;
    btnLogin.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span> กำลังตรวจสอบ...';

    try {
      const res = await fetch(`/api/verify-pin?pin=${encodeURIComponent(pin)}`);
      const data = await res.json();

      if (data.success) {
        isAuthenticated = true;
        saveAuth();
        showDashboard();
      } else {
        pinError.textContent = '❌ PIN ไม่ถูกต้อง กรุณาลองอีกครั้ง';
        pinDigits.forEach(d => { d.value = ''; });
        pinDigits[0].focus();
        const card = pinScreen.querySelector('.pin-card');
        card.style.animation = 'none';
        card.offsetHeight;
        card.style.animation = 'calledShake 0.3s ease-in-out';
      }
    } catch (err) {
      pinError.textContent = '⚠️ ไม่สามารถเชื่อมต่อ server ได้';
    }

    btnLogin.disabled = false;
    btnLogin.innerHTML = '🔓 เข้าสู่ระบบ';
  });

  pinDigits[3].addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnLogin.click();
  });

  btnLogout.addEventListener('click', () => {
    clearAuth();
    pinScreen.style.display = '';
    adminDashboard.classList.add('hidden');
    pinDigits.forEach(d => { d.value = ''; });
    pinError.textContent = '';
    pinDigits[0].focus();
    if (dateInterval) clearInterval(dateInterval);
  });

  // ==================== Dashboard ====================
  function showDashboard() {
    pinScreen.style.display = 'none';
    adminDashboard.classList.remove('hidden');
    updateDateFromServer();
    loadQR();

    // Auto-update date every 30 seconds
    if (dateInterval) clearInterval(dateInterval);
    dateInterval = setInterval(updateDateFromServer, 30000);
  }

  function updateDateFromServer() {
    // Use server date from latest state if available, otherwise use local
    if (latestState && latestState.serverDate) {
      // Parse server date and format in Thai
      const parts = latestState.serverDate.split('-');
      const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
      adminDate.textContent = d.toLocaleDateString('th-TH', options);
    } else {
      const now = new Date();
      const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
      adminDate.textContent = now.toLocaleDateString('th-TH', options);
    }
  }

  // ==================== Socket.IO ====================
  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });

  socket.on('connect', () => {
    updateConnectionStatus(true);
  });

  socket.on('disconnect', () => {
    updateConnectionStatus(false);
  });

  socket.on('queue:state', (state) => {
    latestState = state;
    if (isAuthenticated) {
      updateDashboard(state);
    }
  });

  socket.on('queue:dayReset', (data) => {
    // Show notification that day has reset
    if (isAuthenticated) {
      showAdminToast('🔄 ระบบรีเซ็ตคิวสำหรับวันใหม่อัตโนมัติ');
      updateDateFromServer();
    }
  });

  function updateConnectionStatus(connected) {
    connectionStatus.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
    connectionText.textContent = connected ? 'เชื่อมต่อแล้ว' : 'กำลังเชื่อมต่อ...';
  }

  function showAdminToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; top: 60px; left: 50%; transform: translateX(-50%);
      background: rgba(59,130,246,0.15); border: 1px solid rgba(59,130,246,0.4);
      color: #3b82f6; padding: 12px 24px; border-radius: 100px;
      font-size: 0.9rem; font-weight: 600; z-index: 2000;
      animation: slideUp 0.3s ease-out; backdrop-filter: blur(10px);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // ==================== Update Dashboard ====================
  function updateDashboard(state) {
    if (!state) return;

    // Stats
    adminStatCurrent.textContent = state.currentQueue ? '#' + state.currentQueue.number : '—';
    adminStatWaiting.textContent = state.totalWaiting;
    adminStatTime.textContent = state.totalEstimatedMinutes;
    adminStatDone.textContent = state.completedToday;

    // Current banner
    if (state.currentQueue) {
      currentBanner.classList.remove('hidden');
      noCurrentBanner.classList.add('hidden');
      adminCurrentNumber.textContent = '#' + state.currentQueue.number;
      adminCurrentInfo.textContent = `👥 ${state.currentQueue.groupSize} คน · ${state.currentQueue.totalMinutes} นาที`;
      updateTimer(state.currentQueue);
    } else {
      currentBanner.classList.add('hidden');
      noCurrentBanner.classList.remove('hidden');
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }

    // Queue table
    renderQueueTable(state);

    // Buttons state
    btnCallNext.disabled = state.totalWaiting === 0;
    btnComplete.disabled = !state.currentQueue;

    // Update date from server
    updateDateFromServer();
  }

  function updateTimer(currentQueue) {
    if (timerInterval) clearInterval(timerInterval);

    function tick() {
      if (!latestState || !latestState.currentQueue) return;
      const remaining = latestState.currentQueue.remainingMinutes;
      if (remaining === null || remaining === undefined) return;

      const totalSeconds = Math.max(0, Math.round(remaining * 60));
      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      adminCurrentTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

      if (remaining <= 0) {
        adminCurrentTimer.classList.add('overtime');
        adminCurrentTimer.textContent = 'เกินเวลา';
      } else {
        adminCurrentTimer.classList.remove('overtime');
      }
    }

    tick();
    timerInterval = setInterval(tick, 1000);
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
        <td><span class="q-people">👥 ${q.groupSize} คน</span></td>
        <td class="q-time">${q.totalMinutes} นาที</td>
        <td class="q-time">~${q.estimatedMinutes} นาที</td>
        <td class="q-actions">
          <button class="btn btn-danger btn-sm" onclick="cancelQueue('${q.id}', ${q.number})">❌</button>
        </td>
      </tr>
    `).join('');
  }

  // ==================== Actions ====================
  btnCallNext.addEventListener('click', () => {
    btnCallNext.disabled = true;
    socket.emit('queue:callNext', {}, (res) => {
      btnCallNext.disabled = false;
      if (res && res.success) {
        playCallSound();
      } else {
        if (res && res.message) showAdminToast(res.message);
      }
    });
  });

  btnComplete.addEventListener('click', () => {
    socket.emit('queue:complete', {}, (res) => {
      if (!res || !res.success) {
        if (res && res.message) showAdminToast(res.message);
      }
    });
  });

  btnReset.addEventListener('click', () => {
    resetModal.classList.remove('hidden');
  });

  btnResetCancel.addEventListener('click', () => {
    resetModal.classList.add('hidden');
  });

  btnResetConfirm.addEventListener('click', () => {
    socket.emit('queue:reset', {}, (res) => {
      resetModal.classList.add('hidden');
    });
  });

  window.cancelQueue = function (queueId, number) {
    if (!confirm(`ยกเลิกคิว #${number} ใช่ไหม?`)) return;
    socket.emit('queue:cancel', { queueId }, (res) => {
      if (!res || !res.success) {
        showAdminToast('ไม่สามารถยกเลิกคิวได้');
      }
    });
  };

  // ==================== QR Code ====================
  async function loadQR() {
    try {
      const res = await fetch('/api/qr');
      const data = await res.json();
      qrImageContainer.innerHTML = `<img src="${data.qrDataUrl}" alt="QR Code" />`;
      qrUrl.textContent = data.url;
    } catch (err) {
      qrImageContainer.innerHTML = '<p style="color: var(--accent-red);">ไม่สามารถสร้าง QR Code ได้</p>';
    }
  }

  // ==================== Sound ====================
  function playCallSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        const start = ctx.currentTime + i * 0.15;
        gain.gain.setValueAtTime(0.3, start);
        gain.gain.exponentialRampToValueAtTime(0.01, start + 0.4);
        osc.start(start);
        osc.stop(start + 0.4);
      });
    } catch (e) {}
  }

  // ==================== Init ====================
  if (!checkSavedAuth()) {
    pinDigits[0].focus();
  }
})();
