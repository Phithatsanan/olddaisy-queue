// ==================== Customer Page JS ====================
(function () {
  'use strict';

  const STORAGE_KEY = 'photoqueue_my_queue';
  const MINUTES_PER_PERSON = 2;

  const $ = (id) => document.getElementById(id);

  // DOM refs
  const connectionStatus = $('connectionStatus');
  const connectionText = $('connectionText');
  const joinSection = $('joinSection');
  const btnMinus = $('btnMinus');
  const btnPlus = $('btnPlus');
  const personCountEl = $('personCount');
  const timeEstimateEl = $('timeEstimate');
  const btnJoin = $('btnJoin');
  const myQueueSection = $('myQueueSection');
  const myQueueNumber = $('myQueueNumber');
  const myGroupSize = $('myGroupSize');
  const myTotalMinutes = $('myTotalMinutes');
  const warningBox = $('warningBox');
  const warningText = $('warningText');
  const countdownTime = $('countdownTime');
  const currentQueueDisplay = $('currentQueueDisplay');
  const currentQueueDetails = $('currentQueueDetails');
  const statAhead = $('statAhead');
  const statTotal = $('statTotal');
  const statDone = $('statDone');
  const queueListCustomer = $('queueListCustomer');
  const btnCancel = $('btnCancel');
  const calledOverlay = $('calledOverlay');
  const calledQueueNumber = $('calledQueueNumber');
  const btnDismissCalled = $('btnDismissCalled');

  // ==================== State ====================
  let personCount = 1;
  let myQueue = null;
  let latestState = null;
  let calledAcknowledged = false;
  let isReconnecting = false;

  // ==================== Server time sync ====================
  let serverTimeOffset = 0;

  function getServerNow() {
    return Date.now() + serverTimeOffset;
  }

  // Tick every second to update queue countdown (client-side, no server calls)
  setInterval(() => {
    if (latestState) updateCountdown();
  }, 1000);

  // ==================== Socket.IO ====================
  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });

  socket.on('connect', () => {
    updateConnectionStatus(true);
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
          clearMyQueue();
          showJoinView();
          if (res && res.reason === 'stale') {
            showToast('คิวจากวันก่อนถูกรีเซ็ตแล้ว');
          }
        }
      });
    }
  });

  socket.on('disconnect', () => updateConnectionStatus(false));

  socket.on('queue:state', (state) => {
    // Sync server time offset (once per state update, lightweight)
    if (state.serverTimestamp) {
      serverTimeOffset = state.serverTimestamp - Date.now();
    }
    latestState = state;
    updateDisplay(state);
  });

  socket.on('queue:warning', (data) => {
    showWarning(data.estimatedMinutes);
  });

  socket.on('queue:called', (data) => {
    if (!calledAcknowledged) {
      showCalledOverlay(data.queueNumber);
    }
  });

  socket.on('queue:dayReset', () => {
    clearMyQueue();
    showJoinView();
    showToast('วันใหม่! คิวถูกรีเซ็ตอัตโนมัติ');
  });

  // ==================== UI ====================
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
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
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

    // My position
    if (myQueue) {
      const myIdx = state.waitingQueues.findIndex(q => q.id === myQueue.id);
      if (myIdx !== -1) {
        statAhead.textContent = myIdx;
      } else if (state.currentQueue && state.currentQueue.id === myQueue.id) {
        statAhead.textContent = '0';
      } else {
        // Queue gone — verify
        socket.emit('queue:check', { queueId: myQueue.id }, (res) => {
          if (!res || !res.exists) {
            clearMyQueue();
            showJoinView();
          }
        });
      }
    }

    renderQueueList(state);
    updateCountdown();
  }

  // Client-side countdown (runs every second via clock tick, no server calls)
  function updateCountdown() {
    if (!latestState || !myQueue) return;

    const myIdx = latestState.waitingQueues.findIndex(q => q.id === myQueue.id);

    if (myIdx !== -1) {
      // Calculate real-time estimate
      let total = 0;
      if (latestState.currentQueue && latestState.currentQueue.startedAt) {
        const elapsedMin = (getServerNow() - latestState.currentQueue.startedAt) / 60000;
        total += Math.max(0, latestState.currentQueue.totalMinutes - elapsedMin);
      }
      for (let i = 0; i < myIdx; i++) {
        total += latestState.waitingQueues[i].totalMinutes;
      }
      const est = Math.ceil(total);

      if (est <= 0) {
        countdownTime.textContent = 'ใกล้ถึงคิวแล้ว!';
        countdownTime.classList.add('urgent');
      } else {
        const mins = Math.floor(total);
        const secs = Math.floor((total - mins) * 60);
        countdownTime.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
        countdownTime.classList.toggle('urgent', est <= 10);
      }

      // Warning box
      if (est <= 10) {
        warningBox.classList.remove('hidden');
        warningText.textContent = est <= 1
          ? 'เตรียมตัวเลย! คิวของคุณกำลังจะถึง!'
          : `อีกประมาณ ${est} นาทีจะถึงคิวของคุณ`;
      } else {
        warningBox.classList.add('hidden');
      }

    } else if (latestState.currentQueue && latestState.currentQueue.id === myQueue.id) {
      countdownTime.textContent = 'ถึงคิวแล้ว!';
      countdownTime.classList.add('urgent');
      warningBox.classList.remove('hidden');
      warningText.textContent = '🎉 ถึงคิวของคุณแล้ว! กรุณามาที่หน้าร้าน';
    }
  }

  function renderQueueList(state) {
    if (!state.waitingQueues || state.waitingQueues.length === 0) {
      queueListCustomer.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">ไม่มีคิวรออยู่ตอนนี้</div>';
      return;
    }
    queueListCustomer.innerHTML = state.waitingQueues.map((q) => {
      const isMine = myQueue && q.id === myQueue.id;
      return `<div class="queue-item-customer ${isMine ? 'is-mine' : ''}">
        <span class="q-number">${isMine ? '⭐ ' : ''}#${q.number}</span>
        <span class="q-people">👥 ${q.groupSize} คน</span>
        <span class="q-time">~${q.estimatedMinutes} นาที</span>
      </div>`;
    }).join('');
  }

  function showWarning(minutes) {
    warningBox.classList.remove('hidden');
    warningText.textContent = `อีกประมาณ ${minutes} นาทีจะถึงคิวของคุณ`;
  }

  function showCalledOverlay(queueNumber) {
    calledQueueNumber.textContent = queueNumber;
    calledOverlay.classList.remove('hidden');
  }

  // ==================== Persistence ====================
  function saveMyQueue(queue) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(queue)); } catch (e) {}
  }

  function loadMyQueue() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearMyQueue() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    myQueue = null;
    calledAcknowledged = false;
  }

  // ==================== Events ====================
  btnMinus.addEventListener('click', () => {
    if (personCount > 1) { personCount--; updatePersonCount(); }
  });

  btnPlus.addEventListener('click', () => {
    if (personCount < 20) { personCount++; updatePersonCount(); }
  });

  function updatePersonCount() {
    personCountEl.textContent = personCount;
    timeEstimateEl.textContent = `${personCount * MINUTES_PER_PERSON} นาที`;
  }

  btnJoin.addEventListener('click', () => {
    if (btnJoin.disabled) return;
    btnJoin.disabled = true;
    btnJoin.innerHTML = '⏳ กำลังรับคิว...';

    socket.emit('queue:join', { groupSize: personCount }, (res) => {
      btnJoin.disabled = false;
      btnJoin.innerHTML = '🎫 รับคิว';
      if (res && res.success) {
        myQueue = res.queue;
        saveMyQueue(myQueue);
        showMyQueueView();
      } else {
        showToast('ไม่สามารถรับคิวได้ กรุณาลองใหม่');
      }
    });

    setTimeout(() => {
      if (btnJoin.disabled) {
        btnJoin.disabled = false;
        btnJoin.innerHTML = '🎫 รับคิว';
      }
    }, 5000);
  });

  btnCancel.addEventListener('click', () => {
    if (!myQueue) return;
    if (!confirm('ต้องการยกเลิกคิวใช่ไหม?')) return;
    socket.emit('queue:cancel', { queueId: myQueue.id }, (res) => {
      if (res && res.success) {
        clearMyQueue();
        showJoinView();
        personCount = 1;
        updatePersonCount();
      }
    });
  });

  btnDismissCalled.addEventListener('click', () => {
    calledOverlay.classList.add('hidden');
    calledAcknowledged = true;
  });

  // Re-verify queue when user comes back to tab
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
  if (saved) { myQueue = saved; showMyQueueView(); }
  else { showJoinView(); }
  updatePersonCount();
})();
