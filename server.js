const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1412';
const BASE_URL = process.env.BASE_URL || null;
const MINUTES_PER_PERSON = 2;
const WARNING_MINUTES = 10;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'queue.json');
const TZ = 'Asia/Bangkok';

// ==================== Timezone Helpers ====================
function getBangkokDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function getBangkokDateString() {
  const d = getBangkokDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ==================== Queue State ====================
let state = {
  nextQueueNumber: 1,
  currentQueue: null,
  currentStartedAt: null,
  waitingQueues: [],
  completedToday: 0,
  lastResetDate: null,
};

let autoAdvanceTimer = null; // setTimeout ref for auto-advance

// ==================== Persistence ====================
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveState() {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      nextQueueNumber: state.nextQueueNumber,
      currentQueue: state.currentQueue,
      currentStartedAt: state.currentStartedAt,
      waitingQueues: state.waitingQueues,
      completedToday: state.completedToday,
      lastResetDate: state.lastResetDate,
      savedAt: Date.now(),
    }, null, 2), 'utf-8');
  } catch (err) {
    console.error('⚠️ Save failed:', err.message);
  }
}

function loadState() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      const today = getBangkokDateString();
      if (raw.lastResetDate === today) {
        state.nextQueueNumber = raw.nextQueueNumber || 1;
        state.currentQueue = raw.currentQueue || null;
        state.currentStartedAt = raw.currentStartedAt || null;
        state.waitingQueues = raw.waitingQueues || [];
        state.completedToday = raw.completedToday || 0;
        state.lastResetDate = raw.lastResetDate;
        console.log(`📂 Loaded ${state.waitingQueues.length} queues from today.`);
      } else {
        console.log(`📂 Old data from ${raw.lastResetDate || '?'}, resetting.`);
        resetForNewDay();
      }
    } else {
      resetForNewDay();
    }
  } catch (err) {
    console.error('⚠️ Load failed:', err.message);
    resetForNewDay();
  }
}

// ==================== Daily Reset ====================
function resetForNewDay() {
  const today = getBangkokDateString();
  console.log(`🔄 Reset for: ${today}`);
  state.nextQueueNumber = 1;
  state.currentQueue = null;
  state.currentStartedAt = null;
  state.waitingQueues = [];
  state.completedToday = 0;
  state.lastResetDate = today;
  clearAutoAdvanceTimer();
  saveState();
}

function checkDailyReset() {
  const today = getBangkokDateString();
  if (state.lastResetDate !== today) {
    io.emit('queue:dayReset', { message: 'วันใหม่! ระบบรีเซ็ตคิวอัตโนมัติ', newDate: today });
    resetForNewDay();
    broadcastState();
    return true;
  }
  return false;
}

// ==================== Queue Helpers ====================
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function calcEstimatedMinutes(queueIndex) {
  let total = 0;
  if (state.currentQueue && state.currentStartedAt) {
    const elapsed = (Date.now() - state.currentStartedAt) / 60000;
    const remaining = Math.max(0, state.currentQueue.totalMinutes - elapsed);
    total += remaining;
  }
  for (let i = 0; i < queueIndex; i++) {
    total += state.waitingQueues[i].totalMinutes;
  }
  return Math.ceil(total);
}

function buildPublicState() {
  const queues = state.waitingQueues.map((q, i) => ({
    id: q.id,
    number: q.number,
    groupSize: q.groupSize,
    totalMinutes: q.totalMinutes,
    estimatedMinutes: calcEstimatedMinutes(i),
    status: q.status,
    createdAt: q.createdAt,
  }));

  let currentRemaining = null;
  if (state.currentQueue && state.currentStartedAt) {
    const elapsed = (Date.now() - state.currentStartedAt) / 60000;
    currentRemaining = Math.max(0, state.currentQueue.totalMinutes - elapsed);
  }

  return {
    currentQueue: state.currentQueue ? {
      id: state.currentQueue.id,
      number: state.currentQueue.number,
      groupSize: state.currentQueue.groupSize,
      totalMinutes: state.currentQueue.totalMinutes,
      remainingMinutes: currentRemaining,
      startedAt: state.currentStartedAt,
    } : null,
    waitingQueues: queues,
    totalWaiting: queues.length,
    totalEstimatedMinutes: queues.length > 0 ? calcEstimatedMinutes(queues.length) : 0,
    completedToday: state.completedToday,
    minutesPerPerson: MINUTES_PER_PERSON,
    serverDate: getBangkokDateString(),
    serverTimestamp: Date.now(),
    lastResetDate: state.lastResetDate,
  };
}

// Broadcast current state to all clients — called ONLY on state changes
function broadcastState() {
  const publicState = buildPublicState();
  io.emit('queue:state', publicState);

  // Send targeted warnings
  state.waitingQueues.forEach((q, i) => {
    const est = calcEstimatedMinutes(i);
    if (est <= WARNING_MINUTES && q.status === 'waiting') {
      io.to(q.socketId).emit('queue:warning', {
        queueNumber: q.number,
        estimatedMinutes: est,
      });
    }
  });
}

// ==================== Auto-Advance (Timer-based, not polling) ====================
function clearAutoAdvanceTimer() {
  if (autoAdvanceTimer) {
    clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = null;
  }
}

function scheduleAutoAdvance() {
  clearAutoAdvanceTimer();

  if (!state.currentQueue || !state.currentStartedAt) return;

  const elapsedMs = Date.now() - state.currentStartedAt;
  const allocatedMs = state.currentQueue.totalMinutes * 60 * 1000;
  const remainingMs = allocatedMs - elapsedMs;

  if (remainingMs <= 0) {
    // Already expired — advance now
    advanceToNext();
    broadcastState();
    return;
  }

  // Schedule for when time runs out (+ 500ms buffer to avoid race)
  autoAdvanceTimer = setTimeout(() => {
    if (state.currentQueue && state.currentStartedAt) {
      const elapsed = Date.now() - state.currentStartedAt;
      const allocated = state.currentQueue.totalMinutes * 60 * 1000;
      if (elapsed >= allocated) {
        console.log(`⏰ Auto-advance triggered for queue #${state.currentQueue.number}`);
        advanceToNext();
        broadcastState();
      }
    }
  }, remainingMs + 500);

  console.log(`⏰ Auto-advance scheduled in ${Math.round(remainingMs / 1000)}s for queue #${state.currentQueue.number}`);
}

function advanceToNext() {
  clearAutoAdvanceTimer();

  if (state.currentQueue) {
    state.currentQueue.status = 'completed';
    state.completedToday++;
    console.log(`✅ Queue #${state.currentQueue.number} completed`);
  }

  if (state.waitingQueues.length === 0) {
    state.currentQueue = null;
    state.currentStartedAt = null;
    saveState();
    return null;
  }

  const next = state.waitingQueues.shift();
  next.status = 'serving';
  state.currentQueue = next;
  state.currentStartedAt = Date.now();
  saveState();

  io.to(next.socketId).emit('queue:called', {
    queueNumber: next.number,
    message: `ถึงคิวของคุณแล้ว! คิวหมายเลข ${next.number}`,
  });

  console.log(`📢 Now serving queue #${next.number}`);
  scheduleAutoAdvance();
  return next;
}

// ==================== Static Files ====================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ==================== REST API ====================
app.get('/api/qr', async (req, res) => {
  try {
    let url;
    if (BASE_URL) {
      url = BASE_URL;
    } else {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      url = `${proto}://${host}`;
    }
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 400, margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
    res.json({ url, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/verify-pin', (req, res) => {
  const pin = req.query.pin;
  if (pin === ADMIN_PIN) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'PIN ไม่ถูกต้อง' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    date: getBangkokDateString(),
    queues: state.waitingQueues.length,
    uptime: process.uptime(),
  });
});

// ==================== Socket.IO ====================
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);
  checkDailyReset();
  socket.emit('queue:state', buildPublicState());

  // ---------- Customer: Join ----------
  socket.on('queue:join', ({ groupSize }, callback) => {
    checkDailyReset();
    const size = Math.max(1, Math.min(20, parseInt(groupSize) || 1));
    const queue = {
      id: generateId(),
      number: state.nextQueueNumber++,
      groupSize: size,
      totalMinutes: size * MINUTES_PER_PERSON,
      status: 'waiting',
      createdAt: Date.now(),
      createdDate: getBangkokDateString(),
      socketId: socket.id,
    };
    state.waitingQueues.push(queue);
    saveState();

    const idx = state.waitingQueues.length - 1;
    if (callback) {
      callback({
        success: true,
        queue: {
          id: queue.id,
          number: queue.number,
          groupSize: queue.groupSize,
          totalMinutes: queue.totalMinutes,
          estimatedMinutes: calcEstimatedMinutes(idx),
          createdDate: queue.createdDate,
        },
      });
    }
    console.log(`📋 Queue #${queue.number} joined (${size} ppl, ~${queue.totalMinutes} min)`);
    broadcastState();
  });

  // ---------- Cancel ----------
  socket.on('queue:cancel', ({ queueId }, callback) => {
    const idx = state.waitingQueues.findIndex(q => q.id === queueId);
    if (idx !== -1) {
      const removed = state.waitingQueues.splice(idx, 1)[0];
      removed.status = 'cancelled';
      saveState();
      console.log(`❌ Queue #${removed.number} cancelled`);
      if (callback) callback({ success: true });
      broadcastState();
    } else {
      if (callback) callback({ success: false, message: 'ไม่พบคิว' });
    }
  });

  // ---------- Admin: Call Next (manual skip) ----------
  socket.on('queue:callNext', (data, callback) => {
    checkDailyReset();
    if (state.waitingQueues.length === 0 && !state.currentQueue) {
      if (callback) callback({ success: false, message: 'ไม่มีคิวที่รออยู่' });
      return;
    }
    const next = advanceToNext();
    if (next) {
      if (callback) callback({ success: true, queue: next });
    } else {
      if (callback) callback({ success: false, message: 'ไม่มีคิวถัดไป' });
    }
    broadcastState();
  });

  // ---------- Admin: Complete (finish early) ----------
  socket.on('queue:complete', (data, callback) => {
    if (state.currentQueue) {
      const next = advanceToNext();
      console.log('✅ Admin finished early' + (next ? `, now #${next.number}` : ''));
      if (callback) callback({ success: true });
      broadcastState();
    } else {
      if (callback) callback({ success: false, message: 'ไม่มีคิวที่กำลังให้บริการ' });
    }
  });

  // ---------- Admin: Reset ----------
  socket.on('queue:reset', (data, callback) => {
    state.nextQueueNumber = 1;
    state.currentQueue = null;
    state.currentStartedAt = null;
    state.waitingQueues = [];
    state.completedToday = 0;
    state.lastResetDate = getBangkokDateString();
    clearAutoAdvanceTimer();
    saveState();
    console.log('🔄 All queues reset by admin');
    if (callback) callback({ success: true });
    broadcastState();
  });

  // ---------- Customer: Reconnect ----------
  socket.on('queue:reconnect', ({ queueId, createdDate }, callback) => {
    const today = getBangkokDateString();
    if (createdDate && createdDate !== today) {
      if (callback) callback({ success: false, reason: 'stale' });
      return;
    }
    const q = state.waitingQueues.find(q => q.id === queueId);
    if (q) {
      q.socketId = socket.id;
      saveState();
      if (callback) callback({ success: true, queue: q, status: 'waiting' });
      return;
    }
    if (state.currentQueue && state.currentQueue.id === queueId) {
      state.currentQueue.socketId = socket.id;
      saveState();
      if (callback) callback({ success: true, queue: state.currentQueue, status: 'serving' });
      return;
    }
    if (callback) callback({ success: false, reason: 'not_found' });
  });

  // ---------- Customer: Check ----------
  socket.on('queue:check', ({ queueId }, callback) => {
    const inWaiting = state.waitingQueues.find(q => q.id === queueId);
    const isCurrent = state.currentQueue && state.currentQueue.id === queueId;
    if (callback) {
      callback({
        exists: !!(inWaiting || isCurrent),
        status: isCurrent ? 'serving' : inWaiting ? 'waiting' : 'gone',
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
  });
});

// ==================== Periodic: Daily reset check only (every 60s) ====================
setInterval(() => { checkDailyReset(); }, 60000);

// ==================== Start ====================
loadState();
scheduleAutoAdvance(); // Resume timer if server restarted mid-queue

server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
    }
  }
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   🌼 OldDaisy Queue System                     ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║  🌐 http://localhost:${PORT}                      ║`);
  console.log(`║  📱 http://${localIP}:${PORT}                 ║`);
  console.log(`║  📅 ${getBangkokDateString()} (Bangkok)              ║`);
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
});
