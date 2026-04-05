// ==================== Customer Page JS ====================
(function () {
  'use strict';

  const STORAGE_KEY = 'photoqueue_my_queue';
  const MINUTES_PER_PERSON = 2;

  const $ = (id) => document.getElementById(id);

  // DOM refs — Views
  const joinSection = $('joinSection');
  const waitingSection = $('waitingSection');
  const servingSection = $('servingSection');
  const calledOverlay = $('calledOverlay');
  const almostReadyOverlay = $('almostReadyOverlay');
  const btnDismissAlmostReady = $('btnDismissAlmostReady');

  // Connection
  const connectionStatus = $('connectionStatus');
  const connectionText = $('connectionText');

  // Join
  const btnMinus = $('btnMinus');
  const btnPlus = $('btnPlus');
  const personCountEl = $('personCount');
  const timeEstimateEl = $('timeEstimate');
  const btnJoin = $('btnJoin');

  // Waiting
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

  // Serving
  const servingQueueNumber = $('servingQueueNumber');
  const servingProgressBar = $('servingProgressBar');
  const servingTimeLeft = $('servingTimeLeft');
  const btnNewQueue = $('btnNewQueue');

  // Called overlay
  const calledQueueNumber = $('calledQueueNumber');
  const btnDismissCalled = $('btnDismissCalled');

  // ==================== State ====================
  let personCount = 1;
  let myQueue = null;     // { id, number, groupSize, totalMinutes, createdDate }
  let latestState = null;
  let currentView = 'join'; // 'join' | 'waiting' | 'serving'
  let isReconnecting = false;
  let hasSeenAlmostReadyPopup = false;

  // Server time sync
  let serverTimeOffset = 0;
  function getServerNow() { return Date.now() + serverTimeOffset; }

  // Tick countdown every second (client-side)
  setInterval(() => {
    if (latestState) {
      if (currentView === 'waiting') updateCountdown();
      if (currentView === 'serving') updateServingTimer();
    }
  }, 1000);

  // ==================== Views ====================
  function showView(view) {
    currentView = view;
    joinSection.classList.toggle('hidden', view !== 'join');
    waitingSection.classList.toggle('hidden', view !== 'waiting');
    servingSection.classList.toggle('hidden', view !== 'serving');
  }

  function showJoinView() {
    showView('join');
    hasSeenAlmostReadyPopup = false;
  }

  function showWaitingView() {
    showView('waiting');
    if (myQueue) {
      myQueueNumber.textContent = myQueue.number;
      myGroupSize.textContent = myQueue.groupSize;
      myTotalMinutes.textContent = myQueue.totalMinutes;
    }
  }

  function showServingView() {
    showView('serving');
    if (myQueue) {
      servingQueueNumber.textContent = '#' + myQueue.number;
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
          if (res.status === 'serving') {
            showServingView();
          } else {
            showWaitingView();
          }
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
    if (state.serverTimestamp) {
      serverTimeOffset = state.serverTimestamp - Date.now();
    }
    latestState = state;
    handleStateUpdate(state);
  });

  socket.on('queue:warning', (data) => {
    if (currentView === 'waiting') {
      showWarning(data.estimatedMinutes);
    }
  });

  socket.on('queue:called', (data) => {
    if (currentView === 'waiting') {
      calledQueueNumber.textContent = data.queueNumber;
      calledOverlay.classList.remove('hidden');
    }
  });

  socket.on('queue:dayReset', () => {
    clearMyQueue();
    showJoinView();
    showToast('วันใหม่! คิวถูกรีเซ็ตอัตโนมัติ');
  });

  // ==================== State Handler ====================
  function handleStateUpdate(state) {
    if (!state || !myQueue) {
      // No queue → just update display
      if (currentView === 'waiting' || currentView === 'serving') {
        // Verify our queue still exists
        if (myQueue) verifyMyQueue();
      }
      return;
    }

    // Check: am I in the waiting list?
    const myIdx = state.waitingQueues.findIndex(q => q.id === myQueue.id);

    // Check: am I currently being served?
    const amServing = state.currentQueue && state.currentQueue.id === myQueue.id;

    // Check: am I gone (completed/cancelled)?
    const amGone = myIdx === -1 && !amServing;

    if (amGone) {
      // Queue completed or cancelled
      if (currentView === 'serving') {
        // Was serving, now done → clear and go to join
        clearMyQueue();
        showJoinView();
        showToast('ถ่ายรูปเสร็จเรียบร้อย! 🌸');
      } else if (currentView === 'waiting') {
        // Was waiting but got removed → should not happen normally
        clearMyQueue();
        showJoinView();
      }
      return;
    }

    if (amServing && currentView === 'waiting') {
      // Just got called! Show overlay
      calledQueueNumber.textContent = myQueue.number;
      calledOverlay.classList.remove('hidden');
    }

    if (amServing && currentView === 'serving') {
      updateServingTimer();
    }

    // Update waiting view stats
    if (currentView === 'waiting') {
      updateWaitingDisplay(state, myIdx);
    }
  }

  // ==================== Waiting Display ====================
  function updateWaitingDisplay(state, myIdx) {
    // Current serving
    if (state.currentQueue) {
      currentQueueDisplay.textContent = state.currentQueue.number;
      currentQueueDetails.textContent = `${state.currentQueue.groupSize} คน · ${state.currentQueue.totalMinutes} นาที`;
    } else {
      currentQueueDisplay.textContent = '—';
      currentQueueDetails.textContent = 'ยังไม่เริ่ม';
    }

    // Stats
    statTotal.textContent = state.totalWaiting;
    statDone.textContent = state.completedToday;

    if (myIdx !== -1) {
      statAhead.textContent = myIdx;

      // If first in line and no one is being served → show immediate ready
      if (myIdx === 0 && !state.currentQueue) {
        warningBox.classList.remove('hidden');
        warningText.textContent = 'คิวถัดไปเป็นคิวของคุณ! เตรียมตัวได้เลย';
        countdownTime.textContent = 'เตรียมตัว!';
        countdownTime.classList.add('urgent');
      }
    } else {
      statAhead.textContent = '0';
    }

    renderQueueList(state);
    updateCountdown();
  }

  function updateCountdown() {
    if (!latestState || !myQueue || currentView !== 'waiting') return;

    const myIdx = latestState.waitingQueues.findIndex(q => q.id === myQueue.id);
    if (myIdx === -1) return;

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
      countdownTime.textContent = 'เตรียมตัว!';
      countdownTime.classList.add('urgent');
    } else {
      const mins = Math.floor(total);
      const secs = Math.floor((total - mins) * 60);
      countdownTime.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
      countdownTime.classList.toggle('urgent', est <= 5);
    }

    // Warning
    if (est <= 10 || myIdx === 0) {
      warningBox.classList.remove('hidden');
      if (myIdx === 0) {
        warningText.textContent = est <= 1
          ? 'คิวถัดไปเป็นของคุณ! เตรียมตัวเลย'
          : `อีก ~${est} นาทีถึงคิวของคุณ เตรียมตัวได้เลย`;
      } else {
        warningText.textContent = `อีกประมาณ ${est} นาทีจะถึงคิวของคุณ`;
      }
    } else {
      warningBox.classList.add('hidden');
    }

    // 2-Minute Popup logic (show exactly once if est <= 2)
    if (est <= 2 && !hasSeenAlmostReadyPopup) {
      // Don't show if the shop is completely empty and we are #1 (because we get auto-called)
      if (!(myIdx === 0 && !latestState.currentQueue)) {
        hasSeenAlmostReadyPopup = true;
        almostReadyOverlay.classList.remove('hidden');
        if (window.navigator.vibrate) window.navigator.vibrate([200, 100, 200]);
      }
    }
  }

  // ==================== Serving Timer (gentle, not pressuring) ====================
  function updateServingTimer() {
    if (!latestState || !latestState.currentQueue || !latestState.currentQueue.startedAt) return;
    if (latestState.currentQueue.id !== (myQueue && myQueue.id)) return;

    const elapsedMs = getServerNow() - latestState.currentQueue.startedAt;
    const allocatedMs = latestState.currentQueue.totalMinutes * 60 * 1000;

    // Show gentle progress — NOT a countdown, just elapsed
    const progress = Math.min(100, (elapsedMs / allocatedMs) * 100);
    servingProgressBar.style.width = progress + '%';

    const elapsedMins = Math.floor(elapsedMs / 60000);
    const elapsedSecs = Math.floor((elapsedMs % 60000) / 1000);

    // Gentle message, not pressuring
    if (progress < 80) {
      servingTimeLeft.textContent = `ถ่ายมาแล้ว ${elapsedMins}:${String(elapsedSecs).padStart(2, '0')} นาที`;
    } else {
      servingTimeLeft.textContent = `เกือบครบเวลาแล้ว 🌟`;
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

  // ==================== Verify queue exists ====================
  function verifyMyQueue() {
    if (!myQueue) return;
    socket.emit('queue:check', { queueId: myQueue.id }, (res) => {
      if (!res || !res.exists) {
        clearMyQueue();
        showJoinView();
      }
    });
  }

  // ==================== Toast ====================
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

  function updateConnectionStatus(connected) {
    connectionStatus.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
    connectionText.textContent = connected ? 'เชื่อมต่อแล้ว' : 'กำลังเชื่อมต่อ...';
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
        showWaitingView();

        // If estimated wait time is 0 (first in line, no one serving)
        if (res.queue.estimatedMinutes <= 0) {
          warningBox.classList.remove('hidden');
          warningText.textContent = 'คุณเป็นคิวแรก! เตรียมตัวได้เลย';
          countdownTime.textContent = 'เตรียมตัว!';
          countdownTime.classList.add('urgent');
        }
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

  let cancelConfirmTimer = null;
  btnCancel.addEventListener('click', () => {
    if (!myQueue) return;
    
    if (!btnCancel.classList.contains('confirming')) {
      btnCancel.classList.add('confirming');
      btnCancel.innerHTML = '⚠️ กดย้ำอีกครั้งเพื่อยืนยันการยกเลิก';
      cancelConfirmTimer = setTimeout(() => {
        btnCancel.classList.remove('confirming');
        btnCancel.innerHTML = '❌ ยกเลิกคิวของฉัน';
      }, 3000);
      return;
    }

    clearTimeout(cancelConfirmTimer);
    btnCancel.classList.remove('confirming');
    btnCancel.innerHTML = '❌ ยกเลิกคิวของฉัน';

    socket.emit('queue:cancel', { queueId: myQueue.id }, (res) => {
      if (res && res.success) {
        clearMyQueue();
        showJoinView();
        personCount = 1;
        updatePersonCount();
      }
    });
  });

  // Called overlay → Acknowledge → Go to serving view
  btnDismissCalled.addEventListener('click', () => {
    calledOverlay.classList.add('hidden');
    showServingView();
  });

  // Almost Ready overlay → Dismiss
  btnDismissAlmostReady.addEventListener('click', () => {
    almostReadyOverlay.classList.add('hidden');
  });

  // New queue button (from serving view) - End turn early
  let newQueueConfirmTimer = null;
  btnNewQueue.addEventListener('click', () => {
    if (!btnNewQueue.classList.contains('confirming')) {
      btnNewQueue.classList.add('confirming');
      btnNewQueue.innerHTML = '⚠️ กดยืนยันว่าเสร็จแล้วอีกครั้ง';
      newQueueConfirmTimer = setTimeout(() => {
        btnNewQueue.classList.remove('confirming');
        btnNewQueue.innerHTML = '🎫 รับคิวใหม่';
      }, 3000);
      return;
    }

    clearTimeout(newQueueConfirmTimer);
    btnNewQueue.classList.remove('confirming');
    btnNewQueue.innerHTML = '⏳ กำลังออกจากคิว...';

    if (myQueue) {
      // Tell the server we are done, so it can call the next person
      socket.emit('queue:customerComplete', { queueId: myQueue.id }, () => {
        clearMyQueue();
        showJoinView();
        personCount = 1;
        updatePersonCount();
        btnNewQueue.innerHTML = '🎫 รับคิวใหม่';
      });
    } else {
      clearMyQueue();
      showJoinView();
      personCount = 1;
      updatePersonCount();
      btnNewQueue.innerHTML = '🎫 รับคิวใหม่';
    }
  });

  // Re-verify when user comes back to tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && myQueue) {
      verifyMyQueue();
    }
  });

  // ==================== Init ====================
  const saved = loadMyQueue();
  if (saved) {
    myQueue = saved;
    showWaitingView(); // Will be corrected by reconnect callback
  } else {
    showJoinView();
  }
  updatePersonCount();
})();
