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
  let notified10Min = false;
  let notified2Min = false;
  let notifiedCalled = false;

  // ==================== Notifications ====================
  let swRegistration = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      swRegistration = reg;
    }).catch(err => console.log('SW setup failed', err));
  }

  function requestPushPermission() {
    if ('Notification' in window) {
      if (Notification.permission === 'default' || Notification.permission === 'prompt') {
        Notification.requestPermission().then(perm => {
          if (perm === 'granted') {
            sendSystemNotification('Notifications Enabled ✅', 'We will alert you when your queue is ready.');
          }
        });
      }
    }
  }

  function sendSystemNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      if (swRegistration) {
        swRegistration.showNotification(title, {
          body: body,
          icon: '/img/logo.jpg',
          vibrate: [200, 100, 200]
        });
      } else {
        try { new Notification(title, { body: body, icon: '/img/logo.jpg' }); } catch(e){}
      }
    }
  }

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
      if (window.navigator.vibrate) window.navigator.vibrate([500, 200, 500, 200, 800]); // Long distinct vibration
      if (!notifiedCalled) {
        notifiedCalled = true;
        sendSystemNotification('It is your turn!', `Please come to the storefront now. Queue #${data.queueNumber}`);
      }
    }
  });

  socket.on('queue:dayReset', () => {
    clearMyQueue();
    showJoinView();
    showToast('New day! Queue has been reset.');
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
        showToast('Photo session completed!');
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
      if (window.navigator.vibrate) window.navigator.vibrate([500, 200, 500, 200, 800]);
      if (!notifiedCalled) {
        notifiedCalled = true;
        sendSystemNotification('It is your turn!', `Please come to the storefront now. Queue #${myQueue.number}`);
      }
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
      currentQueueDetails.textContent = `${state.currentQueue.groupSize} ppl · ${state.currentQueue.totalMinutes} min`;
    } else {
      currentQueueDisplay.textContent = '—';
      currentQueueDetails.textContent = 'Not started';
    }

    // Stats
    statTotal.textContent = state.totalWaiting;
    statDone.textContent = state.completedToday;

    if (myIdx !== -1) {
      statAhead.textContent = myIdx;

      // If first in line and no one is being served → show immediate ready
      if (myIdx === 0 && !state.currentQueue) {
        warningBox.classList.remove('hidden');
        warningText.textContent = 'You are next! Get ready.';
        countdownTime.textContent = 'Ready!';
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
      countdownTime.textContent = 'Ready!';
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
          ? 'You are next! Get ready.'
          : `~${est} min until your queue. Get ready!`;
      } else {
        warningText.textContent = `~${est} min until your queue.`;
      }

      if (est <= 10 && est > 2 && !notified10Min) {
        if ('Notification' in window && Notification.permission === 'granted') {
          sendSystemNotification('OLD DAISY CAFE', `Your queue is approaching. ~${est} mins left!`);
          notified10Min = true;
        } else if ('Notification' in window && Notification.permission === 'denied') {
          notified10Min = true;
        }
      }
    } else {
      warningBox.classList.add('hidden');
    }

    // 2-Minute Popup logic (show exactly once if est <= 2)
    if (est <= 2) {
      if (!notified2Min && !(myIdx === 0 && !latestState.currentQueue)) {
        if ('Notification' in window && Notification.permission === 'granted') {
          sendSystemNotification('Almost Ready!', `Your queue is ~${est} mins away. Please prepare to enter!`);
          notified2Min = true;
        } else if ('Notification' in window && Notification.permission === 'denied') {
          notified2Min = true;
        }
      }
      
      if (!hasSeenAlmostReadyPopup && !(myIdx === 0 && !latestState.currentQueue)) {
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
      servingTimeLeft.textContent = `Serving for ${elapsedMins}:${String(elapsedSecs).padStart(2, '0')} min`;
    } else {
      servingTimeLeft.textContent = `Almost complete`;
    }
  }

  function renderQueueList(state) {
    if (!state.waitingQueues || state.waitingQueues.length === 0) {
      queueListCustomer.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">No queues currently waiting</div>';
      return;
    }
    queueListCustomer.innerHTML = state.waitingQueues.map((q) => {
      const isMine = myQueue && q.id === myQueue.id;
      return `<div class="queue-item-customer ${isMine ? 'is-mine' : ''}">
        <span class="q-number">#${q.number}</span>
        <span class="q-people">${q.groupSize} ppl</span>
        <span class="q-time">~${q.estimatedMinutes} min</span>
      </div>`;
    }).join('');
  }

  function showWarning(minutes) {
    warningBox.classList.remove('hidden');
    warningText.textContent = `~${minutes} min until your queue.`;
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
    connectionText.textContent = connected ? 'Connected' : 'Connecting...';
  }

  // ==================== Persistence ====================
  function saveMyQueue(queue) {
    try { 
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queue)); 
      if (queue && queue.id) {
        window.history.replaceState(null, '', '?sq=' + queue.id);
      }
    } catch (e) {}
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
    hasSeenAlmostReadyPopup = false;
    notified10Min = false;
    notified2Min = false;
    notifiedCalled = false;
    try { window.history.replaceState(null, '', window.location.pathname); } catch(e) {}
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
  }

  btnJoin.addEventListener('click', () => {
    if (btnJoin.disabled) return;
    
    // Request push notification permission upon interaction
    requestPushPermission();

    btnJoin.disabled = true;
    btnJoin.innerHTML = 'Receiving...';

    socket.emit('queue:join', { groupSize: personCount }, (res) => {
      btnJoin.disabled = false;
      btnJoin.innerHTML = 'Get Queue';
      if (res && res.success) {
        myQueue = res.queue;
        saveMyQueue(myQueue);
        showWaitingView();

        // If estimated wait time is 0 (first in line, no one serving)
        if (res.queue.estimatedMinutes <= 0) {
          warningBox.classList.remove('hidden');
          warningText.textContent = 'You are next! Get ready.';
          countdownTime.textContent = 'Ready!';
          countdownTime.classList.add('urgent');
        }
      } else {
        showToast('Could not get queue. Please try again.');
      }
    });

    setTimeout(() => {
      if (btnJoin.disabled) {
        btnJoin.disabled = false;
        btnJoin.innerHTML = 'Get Queue';
      }
    }, 5000);
  });

  let cancelConfirmTimer = null;
  btnCancel.addEventListener('click', () => {
    if (!myQueue) return;
    
    if (!btnCancel.classList.contains('confirming')) {
      btnCancel.classList.add('confirming');
      btnCancel.innerHTML = 'Tap again to confirm';
      cancelConfirmTimer = setTimeout(() => {
        btnCancel.classList.remove('confirming');
        btnCancel.innerHTML = 'Cancel My Queue';
      }, 3000);
      return;
    }

    clearTimeout(cancelConfirmTimer);
    btnCancel.classList.remove('confirming');
    btnCancel.innerHTML = 'Cancel My Queue';

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
      btnNewQueue.innerHTML = 'Tap again to finish & clear';
      newQueueConfirmTimer = setTimeout(() => {
        btnNewQueue.classList.remove('confirming');
        btnNewQueue.innerHTML = 'Done / Get New Queue';
      }, 3000);
      return;
    }

    clearTimeout(newQueueConfirmTimer);
    btnNewQueue.classList.remove('confirming');
    btnNewQueue.innerHTML = 'Clearing...';

    if (myQueue) {
      // Tell the server we are done, so it can call the next person
      socket.emit('queue:customerComplete', { queueId: myQueue.id }, () => {
        clearMyQueue();
        showJoinView();
        personCount = 1;
        updatePersonCount();
        btnNewQueue.innerHTML = 'Done / Get New Queue';
      });
    } else {
      clearMyQueue();
      showJoinView();
      personCount = 1;
      updatePersonCount();
      btnNewQueue.innerHTML = 'Done / Get New Queue';
    }
  });

  // Re-verify when user comes back to tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && myQueue) {
      verifyMyQueue();
    }
  });

  // ==================== Init ====================
  const urlParams = new URLSearchParams(window.location.search);
  const sq = urlParams.get('sq');

  if (sq) {
    // Session migration from in-app browser
    myQueue = { id: sq };
    saveMyQueue(myQueue);
    showWaitingView();
  } else {
    const saved = loadMyQueue();
    if (saved) {
      myQueue = saved;
      showWaitingView(); // Will be corrected by reconnect callback
    } else {
      showJoinView();
    }
  }
  updatePersonCount();
})();
