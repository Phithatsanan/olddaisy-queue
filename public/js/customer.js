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
  let myQueue = null; // { id, number, groupSize, totalMinutes }
  let latestState = null;
  let warningShown = false;
  let calledAcknowledged = false;

  // ==================== Socket.IO ====================
  const socket = io({ reconnection: true, reconnectionDelay: 1000 });

  socket.on('connect', () => {
    updateConnectionStatus(true);
    // Try to reconnect existing queue
    const saved = loadMyQueue();
    if (saved) {
      socket.emit('queue:reconnect', { queueId: saved.id }, (res) => {
        if (res && res.success) {
          myQueue = saved;
          showMyQueueView();
        } else {
          clearMyQueue();
          showJoinView();
        }
      });
    }
  });

  socket.on('disconnect', () => {
    updateConnectionStatus(false);
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

  // ==================== UI Functions ====================
  function updateConnectionStatus(connected) {
    connectionStatus.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
    connectionText.textContent = connected ? 'เชื่อมต่อแล้ว' : 'ขาดการเชื่อมต่อ...';
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
        // My queue is not in waiting list — might be being served or already removed
        // Check if I'm being served
        if (state.currentQueue && state.currentQueue.id === myQueue.id) {
          statAhead.textContent = '0';
          countdownTime.textContent = 'ถึงคิวแล้ว!';
          countdownTime.classList.add('urgent');
          warningBox.classList.remove('hidden');
          warningText.textContent = '🎉 ถึงคิวของคุณแล้ว! กรุณามาที่หน้าร้าน';
        } else {
          // Queue has been completed or cancelled — but we didn't cancel
          // Keep showing if not acknowledged
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
    } catch (e) {
      // Audio not supported
    }
  }

  function playCalledSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
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
    } catch (e) {
      // Audio not supported
    }
  }

  // ==================== Persistence ====================
  function saveMyQueue(queue) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch (e) {
      // Storage not available
    }
  }

  function loadMyQueue() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      // Storage not available
    }
    return null;
  }

  function clearMyQueue() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // Storage not available
    }
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
    btnJoin.disabled = true;
    btnJoin.innerHTML = '<span class="spinner" style="width:20px;height:20px;border-width:2px;"></span> กำลังรับคิว...';

    socket.emit('queue:join', { groupSize: personCount }, (res) => {
      btnJoin.disabled = false;
      btnJoin.innerHTML = '🎫 รับคิว';

      if (res && res.success) {
        myQueue = res.queue;
        saveMyQueue(myQueue);
        showMyQueueView();

        // Play a short confirmation sound
        playNotificationSound();
      } else {
        alert('ไม่สามารถรับคิวได้ กรุณาลองใหม่');
      }
    });
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
        alert('ไม่สามารถยกเลิกคิวได้');
      }
    });
  });

  btnDismissCalled.addEventListener('click', () => {
    hideCalledOverlay();
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
