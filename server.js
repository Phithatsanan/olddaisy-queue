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
  // Returns YYYY-MM-DD in Bangkok time
  const d = getBangkokDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getBangkokTimestamp() {
  return getBangkokDate().getTime();
}

// ==================== Queue State ====================
let state = {
  nextQueueNumber: 1,
  currentQueue: null,
  currentStartedAt: null,
  waitingQueues: [],
  completedToday: 0,
  lastResetDate: null,    // YYYY-MM-DD of last auto-reset
  serverStartedAt: null,  // When server started (for uptime display)
};

// ==================== Persistence ====================
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveState() {
  ensureDataDir();
  try {
    const toSave = {
      nextQueueNumber: state.nextQueueNumber,
      currentQueue: state.currentQueue,
      currentStartedAt: state.currentStartedAt,
      waitingQueues: state.waitingQueues,
      completedToday: state.completedToday,
      lastResetDate: state.lastResetDate,
      savedAt: Date.now(),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    console.error('⚠️ Failed to save state:', err.message);
  }
}

function loadState() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      // Only load if saved today (prevent loading stale data from previous day)
      const today = getBangkokDateString();
      if (raw.lastResetDate === today) {
        state.nextQueueNumber = raw.nextQueueNumber || 1;
        state.currentQueue = raw.currentQueue || null;
        state.currentStartedAt = raw.currentStartedAt || null;
        state.waitingQueues = raw.waitingQueues || [];
        state.completedToday = raw.completedToday || 0;
        state.lastResetDate = raw.lastResetDate;
        console.log(`📂 Loaded ${state.waitingQueues.length} waiting queues from today's data.`);
      } else {
        console.log(`📂 Found old data from ${raw.lastResetDate || 'unknown'}, starting fresh for ${today}.`);
        resetForNewDay();
      }
    } else {
      resetForNewDay();
    }
  } catch (err) {
    console.error('⚠️ Failed to load state:', err.message);
    resetForNewDay();
  }
}

// ==================== Daily Reset ====================
function resetForNewDay() {
  const today = getBangkokDateString();
  console.log(`🔄 Resetting queue for new day: ${today}`);
  state.nextQueueNumber = 1;
  state.currentQueue = null;
  state.currentStartedAt = null;
  state.waitingQueues = [];
  state.completedToday = 0;
  state.lastResetDate = today;
  saveState();
}

function checkDailyReset() {
  const today = getBangkokDateString();
  if (state.lastResetDate !== today) {
    // Notify all clients before reset
    io.emit('queue:dayReset', {
      message: 'ระบบรีเซ็ตคิวสำหรับวันใหม่อัตโนมัติ',
      newDate: today,
    });
    resetForNewDay();
    broadcastState();
  }
}

// ==================== Queue Helpers ====================
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function calcEstimatedMinutes(queueIndex) {
  let total = 0;

  // Time remaining for current serving queue
  if (state.currentQueue && state.currentStartedAt) {
    const elapsed = (Date.now() - state.currentStartedAt) / 60000;
    const remaining = Math.max(0, state.currentQueue.totalMinutes - elapsed);
    total += remaining;
  }

  // Sum of queues before this index
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
    } : null,
    waitingQueues: queues,
    totalWaiting: queues.length,
    totalEstimatedMinutes: queues.length > 0 ? calcEstimatedMinutes(queues.length) : 0,
    completedToday: state.completedToday,
    minutesPerPerson: MINUTES_PER_PERSON,
    serverDate: getBangkokDateString(),
    serverTime: getBangkokDate().toLocaleTimeString('th-TH', { timeZone: TZ }),
    lastResetDate: state.lastResetDate,
  };
}

// ==================== Auto-Advance ====================
function advanceToNext() {
  // Complete current if exists
  if (state.currentQueue) {
    state.currentQueue.status = 'completed';
    state.completedToday++;
    console.log(`✅ Queue #${state.currentQueue.number} auto-completed`);
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

  // Notify the customer it's their turn
  io.to(next.socketId).emit('queue:called', {
    queueNumber: next.number,
    message: `ถึงคิวของคุณแล้ว! คิวหมายเลข ${next.number}`,
  });

  console.log(`📢 Auto-calling queue #${next.number}`);
  return next;
}

function checkAutoAdvance() {
  if (!state.currentQueue || !state.currentStartedAt) return false;

  const elapsedMs = Date.now() - state.currentStartedAt;
  const allocatedMs = state.currentQueue.totalMinutes * 60 * 1000;

  if (elapsedMs >= allocatedMs) {
    advanceToNext();
    return true;
  }
  return false;
}

function broadcastState() {
  const publicState = buildPublicState();
  io.emit('queue:state', publicState);

  // Check for warnings (≤ 10 minutes)
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

// ==================== Static Files ====================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== REST API ====================

// QR Code endpoint — uses public URL from headers or BASE_URL env
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
      width: 400,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
    res.json({ url, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin PIN verification
app.get('/api/verify-pin', (req, res) => {
  const pin = req.query.pin;
  if (pin === ADMIN_PIN) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'PIN ไม่ถูกต้อง' });
  }
});

// Health check (keeps Render from sleeping if pinged)
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

  // Check daily reset on each connection
  checkDailyReset();

  // Send initial state
  socket.emit('queue:state', buildPublicState());

  // ---------- Customer: Join Queue ----------
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
    const est = calcEstimatedMinutes(idx);

    if (callback) {
      callback({
        success: true,
        queue: {
          id: queue.id,
          number: queue.number,
          groupSize: queue.groupSize,
          totalMinutes: queue.totalMinutes,
          estimatedMinutes: est,
          createdDate: queue.createdDate,
        },
      });
    }

    console.log(`📋 Queue #${queue.number} joined (${size} people, ~${queue.totalMinutes} min)`);
    broadcastState();
  });

  // ---------- Customer/Admin: Cancel Queue ----------
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

  // ---------- Admin: Call Next Queue (manual skip/advance) ----------
  socket.on('queue:callNext', (data, callback) => {
    checkDailyReset();

    if (state.waitingQueues.length === 0 && !state.currentQueue) {
      if (callback) callback({ success: false, message: 'ไม่มีคิวที่รออยู่' });
      return;
    }

    const next = advanceToNext();
    if (next) {
      console.log(`📢 Admin manually called queue #${next.number}`);
      if (callback) callback({ success: true, queue: next });
    } else {
      if (callback) callback({ success: false, message: 'ไม่มีคิวถัดไป' });
    }
    broadcastState();
  });

  // ---------- Admin: Complete Current Queue (finish early) ----------
  socket.on('queue:complete', (data, callback) => {
    if (state.currentQueue) {
      // Complete current and auto-advance to next
      const next = advanceToNext();
      console.log('✅ Admin completed queue early' + (next ? `, auto-called #${next.number}` : ''));
      if (callback) callback({ success: true });
      broadcastState();
    } else {
      if (callback) callback({ success: false, message: 'ไม่มีคิวที่กำลังให้บริการ' });
    }
  });

  // ---------- Admin: Reset All Queues ----------
  socket.on('queue:reset', (data, callback) => {
    state.nextQueueNumber = 1;
    state.currentQueue = null;
    state.currentStartedAt = null;
    state.waitingQueues = [];
    state.completedToday = 0;
    state.lastResetDate = getBangkokDateString();
    saveState();
    console.log('🔄 All queues reset by admin');
    if (callback) callback({ success: true });
    broadcastState();
  });

  // ---------- Customer: Reconnect (reopen browser) ----------
  socket.on('queue:reconnect', ({ queueId, createdDate }, callback) => {
    const today = getBangkokDateString();

    // If the queue is from a different day, it's stale
    if (createdDate && createdDate !== today) {
      if (callback) callback({ success: false, reason: 'stale', message: 'คิวจากวันก่อน กรุณารับคิวใหม่' });
      return;
    }

    // Look in waiting queues
    const q = state.waitingQueues.find(q => q.id === queueId);
    if (q) {
      q.socketId = socket.id; // Update socket for notifications
      saveState();
      if (callback) callback({ success: true, queue: q, status: 'waiting' });
      return;
    }

    // Check if currently being served
    if (state.currentQueue && state.currentQueue.id === queueId) {
      state.currentQueue.socketId = socket.id;
      saveState();
      if (callback) callback({ success: true, queue: state.currentQueue, status: 'serving' });
      return;
    }

    // Not found
    if (callback) callback({ success: false, reason: 'not_found', message: 'ไม่พบคิว อาจถูกยกเลิกหรือเสร็จแล้ว' });
  });

  // ---------- Customer: Check queue validity ----------
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

// ==================== Periodic Tasks ====================

// Every 5 seconds: check auto-advance + broadcast state
setInterval(() => {
  checkAutoAdvance();
  broadcastState();
}, 5000);

// Check for daily reset every minute
setInterval(() => {
  checkDailyReset();
}, 60000);

// ==================== Start Server ====================
loadState();
state.serverStartedAt = Date.now();

server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   🌼 OldDaisy Queue System Started!          ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  🌐 Local:    http://localhost:${PORT}         ║`);
  console.log(`║  📱 Network:  http://${localIP}:${PORT}    ║`);
  console.log(`║  🔧 Admin:    http://localhost:${PORT}/admin   ║`);
  console.log(`║  📅 Date:     ${getBangkokDateString()} (Bangkok)   ║`);
  console.log(`║  🔑 PIN:      ${ADMIN_PIN}                          ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
