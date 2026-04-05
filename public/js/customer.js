// ==================== Customer Page JS ====================
(function () {
  'use strict';

  const STORAGE_KEY = 'photoqueue_my_queue';
  const MINUTES_PER_PERSON = 2;

  // ==================== DOM Elements ====================
  const $ = (id) => document.getElementById(id);

  const connectionStatus = $('connectionStatus');
  const connectionText = $('connectionText');

  // Join
  const joinSection = $('joinSection');
  const btnMinus = $('btnMinus');
  const btnPlus = $('btnPlus');
  const personCountEl = $('personCount');
  const timeEstimateEl = $('timeEstimate');
  const btnJoin = $('btnJoin');

  // My Queue
  const myQueueSection = $('myQueueSection');
  const myQueueNumber = $('myQueueNumber');
  const myGroupSize = $('myGroupSize');
  const myTotalMinutes = $('myTotalMinutes');

  // Warning
  const warningBox = $('warningBox');
  const warningText = $('warningText');

  // Countdown
  const countdownTime = $('countdownTime');

  // Current
  const currentQueueDisplay = $('currentQueueDisplay');
  const currentQueueDetails = $('currentQueueDetails');

  // Stats
  const statAhead = $('statAhead');
  const statTotal = $('statTotal');
  const statDone = $('statDone');

  // Queue list
  const queueListCustomer = $('queueListCustomer');

  // Cancel
  const btnCancel = $('btnCancel');

  // Called overlay
  const calledOverlay = $('calledOverlay');
  const calledQueueNumber = $('calledQueueNumber');
  const btnDismissCalled = $('btnDismissCalled');

  // ==================== State ====================
  let personCount = 1;
  let myQueue = null; // { id, number, groupSize, totalMinutes, createdDate }
  let latestState = null;
  let warningShown = false;
  let calledAcknowledged = false;
  let isReconnecting = false;

  // ==================== Socket.IO ====================
  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });

  socket.on('connect', () => {
    updateConnectionStatus(true);

    // Try to reconnect existing queue
    const saved = loadMyQueue();
    if (saved && !isReconnecting) {
      isReconnecting = true;
      socket.emit('queue:reconnect', {
        queueId: saved.id,
        createdDate: saved.createdDate || null,
      }, (res) => {
        isReconnecting = false;
        if (res && res.success) {
          myQueue = saved;
          showMyQueueView();
        } else {
          // Queue is gone (server restarted, new day, cancelled, etc.)
          clearMyQueue();
          showJoinView();
          if (res && res.reason === 'stale') {
            showToast('คิวจากวันก่อนถูกรีเซ็ตแล้ว กรุณารับคิวใหม่');
          }
        }
      });
    }
  });

  socket.on('disconnect', () => {
    updateConnectionStatus(false);
  });

  socket.on('reconnect', () => {
    // On reconnect, re-verify the queue
    const saved = loadMyQueue();
    if (saved) {
      socket.emit('queue:check', { queueId: saved.id }, (res) => {
        if (!res || !res.exists) {
          clearMyQueue();
          showJoinView();
        }
      });
    }
  });

  socket.on('queue:state', (state) => {
    latestState = state;
    updateDisplay(state);
  });

  socket.on('queue:warning', (data) => {
    if (!warningShown) {
      warningShown = true;
      showWarning(data.estimatedMinutes);
      playNotificationSound();
    }
  });

  socket.on('queue:called', (data) => {
    if (!calledAcknowledged) {
      showCalledOverlay(data.queueNumber);
      playCalledSound();
    }
  });

  // Daily reset notification
  socket.on('queue:dayReset', (data) => {
    clearMyQueue();
    showJoinView();
    showToast('วันใหม่! ระบบรีเซ็ตคิวอัตโนมัติ');
  });

  // ==================== UI Functions ====================
  function updateConnectionStatus(connected) {
    connectionStatus.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
    connectionText.textContent = connected ? 'เชื่อมต่อแล้ว' : 'กำลังเชื่อมต่อ...';
  }

  function showJoinView() {
    joinSection.classList.remove('hidden');
    myQueueSection.classList.add('hidden');
  }

  function showMyQueueView() {
    joinSection.classList.add('hidden');
    myQueueSection.classList.remove('hidden');
    if (myQueue) {
      myQueueNumber.textContent = myQueue.number;
      myGroupSize.textContent = myQueue.groupSize;
      myTotalMinutes.textContent = myQueue.totalMinutes;
    }
  }

  function showToast(message) {
    // Simple toast notification
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: rgba(255,200,87,0.15); border: 1px solid rgba(255,200,87,0.4);
      color: #ffc857; padding: 12px 24px; border-radius: 100px;
      font-size: 0.9rem; font-weight: 600; z-index: 2000;
      animation: slideUp 0.3s ease-out; backdrop-filter: blur(10px);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function updateDisplay(state) {
    if (!state) return;

    // Current serving
    if (state.currentQueue) {
      currentQueueDisplay.textContent = state.currentQueue.number;
      currentQueueDetails.textContent = `${state.currentQueue.groupSize} คน · ${state.currentQueue.totalMinutes} นาที`;
    } else {
      currentQueueDisplay.textContent = '—';
      currentQueueDetails.textContent = 'ยังไม่มีคิว';
    }

    // Stats
    statTotal.textContent = state.totalWaiting;
    statDone.textContent = state.completedToday;

    // If I have a queue, calculate my position
    if (myQueue) {
      const myIdx = state.waitingQueues.findIndex(q => q.id === myQueue.id);
      if (myIdx !== -1) {
        const est = state.waitingQueues[myIdx].estimatedMinutes;
        statAhead.textContent = myIdx;
        // Countdown
        if (est <= 0) {
          countdownTime.textContent = 'ใกล้ถึงคิวแล้ว!';
          countdownTime.classList.add('urgent');
        } else {
          countdownTime.textContent = `~${est} นาที`;
          countdownTime.classList.toggle('urgent', est <= 10);
        }

        // Warning box
        if (est <= 10) {
          warningBox.classList.remove('hidden');
          warningText.textContent = est <= 1
            ? 'เตรียมตัวเลย! คิวของคุณกำลังจะถึง!'
            : `อีกประมาณ ${est} นาทีจะถึงคิวของคุณ เตรียมตัวลงมาถ่ายได้เลย!`;
        } else {
          warningBox.classList.add('hidden');
        }
      } else {
        // Check if I'm being served
        if (state.currentQueue && state.currentQueue.id === myQueue.id) {
          statAhead.textContent = '0';
          countdownTime.textContent = 'ถึงคิวแล้ว!';
          countdownTime.classList.add('urgent');
          warningBox.classList.remove('hidden');
          warningText.textContent = '🎉 ถึงคิวของคุณแล้ว! กรุณามาที่หน้าร้าน';
        } else {
          // Queue completed or cancelled — verify with server
          socket.emit('queue:check', { queueId: myQueue.id }, (res) => {
            if (!res || !res.exists) {
              clearMyQueue();
              showJoinView();
            }
          });
        }
      }
    }

    // Render queue list
    renderQueueList(state);
  }

  function renderQueueList(state) {
    if (!state.waitingQueues || state.waitingQueues.length === 0) {
      queueListCustomer.innerHTML = `
        <div style="text-align: center; padding: 24px; color: var(--text-muted);">
          ไม่มีคิวรออยู่ตอนนี้
        </div>
      `;
      return;
    }

    queueListCustomer.innerHTML = state.waitingQueues.map((q) => {
      const isMine = myQueue && q.id === myQueue.id;
      return `
        <div class="queue-item-customer ${isMine ? 'is-mine' : ''}">
          <span class="q-number">${isMine ? '⭐ ' : ''}#${q.number}</span>
          <span class="q-people">👥 ${q.groupSize} คน</span>
          <span class="q-time">~${q.estimatedMinutes} นาที</span>
        </div>
      `;
    }).join('');
  }

  function showWarning(minutes) {
    warningBox.classList.remove('hidden');
    warningText.textContent = `อีกประมาณ ${minutes} นาทีจะถึงคิวของคุณ เตรียมตัวลงมาถ่ายได้เลย!`;
  }

  function showCalledOverlay(queueNumber) {
    calledQueueNumber.textContent = queueNumber;
    calledOverlay.classList.remove('hidden');
  }

  function hideCalledOverlay() {
    calledOverlay.classList.add('hidden');
    calledAcknowledged = true;
  }

  // ==================== Sound ====================
  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) { /* Audio not supported */ }
  }

  function playCalledSound() {
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
    } catch (e) { /* Audio not supported */ }
  }

  // ==================== Persistence (localStorage) ====================
  function saveMyQueue(queue) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch (e) { /* Storage not available */ }
  }

  function loadMyQueue() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Check if the data is from today (Bangkok time)
        // Compare with server date on next state update
        return parsed;
      }
    } catch (e) { /* Storage not available */ }
    return null;
  }

  function clearMyQueue() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* Storage not available */ }
    myQueue = null;
    warningShown = false;
    calledAcknowledged = false;
  }

  // ==================== Events ====================
  btnMinus.addEventListener('click', () => {
    if (personCount > 1) {
      personCount--;
      updatePersonCount();
    }
  });

  btnPlus.addEventListener('click', () => {
    if (personCount < 20) {
      personCount++;
      updatePersonCount();
    }
  });

  function updatePersonCount() {
    personCountEl.textContent = personCount;
    timeEstimateEl.textContent = `${personCount * MINUTES_PER_PERSON} นาที`;
  }

  btnJoin.addEventListener('click', () => {
    // Prevent double-click
    if (btnJoin.disabled) return;
    btnJoin.disabled = true;
    btnJoin.innerHTML = '<span class="spinner" style="width:20px;height:20px;border-width:2px;"></span> กำลังรับคิว...';

    socket.emit('queue:join', { groupSize: personCount }, (res) => {
      btnJoin.disabled = false;
      btnJoin.innerHTML = '🎫 รับคิว';

      if (res && res.success) {
        myQueue = res.queue;
        saveMyQueue(myQueue);
        showMyQueueView();
        playNotificationSound();
      } else {
        showToast('ไม่สามารถรับคิวได้ กรุณาลองใหม่');
      }
    });

    // Timeout fallback — if server doesn't respond in 5s
    setTimeout(() => {
      if (btnJoin.disabled) {
        btnJoin.disabled = false;
        btnJoin.innerHTML = '🎫 รับคิว';
        showToast('เชื่อมต่อช้า กรุณาลองใหม่');
      }
    }, 5000);
  });

  btnCancel.addEventListener('click', () => {
    if (!myQueue) return;
    if (!confirm('ต้องการยกเลิกคิวของคุณใช่ไหม?')) return;

    socket.emit('queue:cancel', { queueId: myQueue.id }, (res) => {
      if (res && res.success) {
        clearMyQueue();
        showJoinView();
        personCount = 1;
        updatePersonCount();
      } else {
        showToast('ไม่สามารถยกเลิกคิวได้');
      }
    });
  });

  btnDismissCalled.addEventListener('click', () => {
    hideCalledOverlay();
  });

  // ==================== Visibility Change ====================
  // When user comes back to the tab, re-verify the queue
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && myQueue) {
      socket.emit('queue:check', { queueId: myQueue.id }, (res) => {
        if (!res || !res.exists) {
          clearMyQueue();
          showJoinView();
          showToast('คิวของคุณหมดอายุแล้ว');
        }
      });
    }
  });

  // ==================== Init ====================
  const saved = loadMyQueue();
  if (saved) {
    myQueue = saved;
    showMyQueueView();
  } else {
    showJoinView();
  }

  updatePersonCount();
})();
