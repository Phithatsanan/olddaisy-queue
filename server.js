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

let autoAdvanceTimer = null;

// ==================== Persistence ====================
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveState() {
  ensureDataDir();
  try {
    const dataToSave = {
      nextQueueNumber: state.nextQueueNumber,
      currentQueue: state.currentQueue ? {
        id: state.currentQueue.id,
        number: state.currentQueue.number,
        groupSize: state.currentQueue.groupSize,
        name: state.currentQueue.name || '',
        totalMinutes: state.currentQueue.totalMinutes,
        status: state.currentQueue.status,
        createdAt: state.currentQueue.createdAt,
        createdDate: state.currentQueue.createdDate,
        socketId: state.currentQueue.socketId,
      } : null,
      currentStartedAt: state.currentStartedAt,
      waitingQueues: state.waitingQueues.map(q => ({
        id: q.id,
        number: q.number,
        groupSize: q.groupSize,
        name: q.name || '',
        totalMinutes: q.totalMinutes,
        status: q.status,
        createdAt: q.createdAt,
        createdDate: q.createdDate,
        socketId: q.socketId,
      })),
      completedToday: state.completedToday,
      lastResetDate: state.lastResetDate,
      savedAt: Date.now(),
    };
    // Write to temp file first, then rename (atomic write)
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(dataToSave, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.error('⚠️ Save failed:', err.message);
    // Fallback: try direct write if rename fails
    try {
      const dataToSave = {
        nextQueueNumber: state.nextQueueNumber,
        currentQueue: state.currentQueue,
        currentStartedAt: state.currentStartedAt,
        waitingQueues: state.waitingQueues,
        completedToday: state.completedToday,
        lastResetDate: state.lastResetDate,
        savedAt: Date.now(),
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
    } catch (err2) {
      console.error('⚠️ Fallback save also failed:', err2.message);
    }
  }
}

function loadState() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const rawText = fs.readFileSync(DATA_FILE, 'utf-8');
      if (!rawText || rawText.trim().length === 0) {
        console.log('📂 Empty data file, resetting.');
        resetForNewDay();
        return;
      }
      const raw = JSON.parse(rawText);
      const today = getBangkokDateString();

      // Validate data has lastResetDate
      if (!raw.lastResetDate) {
        console.log('📂 Data missing lastResetDate, resetting.');
        resetForNewDay();
        return;
      }

      if (raw.lastResetDate === today) {
        state.nextQueueNumber = raw.nextQueueNumber || 1;
        state.currentQueue = raw.currentQueue || null;
        state.currentStartedAt = raw.currentStartedAt || null;
        state.completedToday = raw.completedToday || 0;
        state.lastResetDate = raw.lastResetDate;

        // Validate and restore waiting queues
        if (Array.isArray(raw.waitingQueues)) {
          state.waitingQueues = raw.waitingQueues.filter(q => {
            // Ensure each queue has required fields
            return q && q.id && typeof q.number === 'number' && typeof q.groupSize === 'number';
          }).map(q => ({
            id: q.id,
            number: q.number,
            groupSize: q.groupSize,
            name: q.name || '',
            totalMinutes: q.totalMinutes || q.groupSize * MINUTES_PER_PERSON,
            status: q.status || 'waiting',
            createdAt: q.createdAt || Date.now(),
            createdDate: q.createdDate || today,
            socketId: q.socketId || null,
          }));
        } else {
          state.waitingQueues = [];
        }

        // Validate currentQueue
        if (state.currentQueue) {
          if (!state.currentQueue.id || typeof state.currentQueue.number !== 'number') {
            console.log('📂 Invalid currentQueue, clearing.');
            state.currentQueue = null;
            state.currentStartedAt = null;
          } else {
            // Ensure all fields exist
            state.currentQueue = {
              id: state.currentQueue.id,
              number: state.currentQueue.number,
              groupSize: state.currentQueue.groupSize || 1,
              name: state.currentQueue.name || '',
              totalMinutes: state.currentQueue.totalMinutes || (state.currentQueue.groupSize || 1) * MINUTES_PER_PERSON,
              status: state.currentQueue.status || 'serving',
              createdAt: state.currentQueue.createdAt || Date.now(),
              createdDate: state.currentQueue.createdDate || today,
              socketId: state.currentQueue.socketId || null,
            };
          }
        }

        console.log(`📂 Loaded: ${state.waitingQueues.length} waiting, current=#${state.currentQueue ? state.currentQueue.number : 'none'}, completed=${state.completedToday}`);
      } else {
        console.log(`📂 Old data from ${raw.lastResetDate}, resetting for today (${today}).`);
        resetForNewDay();
      }
    } else {
      console.log('📂 No data file, starting fresh.');
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
    if (state.waitingQueues[i]) {
      total += state.waitingQueues[i].totalMinutes;
    }
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

function buildAdminState() {
  const base = buildPublicState();
  // Add name data only for admin
  base.waitingQueues = state.waitingQueues.map((q, i) => ({
    id: q.id,
    number: q.number,
    groupSize: q.groupSize,
    name: q.name || '',
    totalMinutes: q.totalMinutes,
    estimatedMinutes: calcEstimatedMinutes(i),
    status: q.status,
    createdAt: q.createdAt,
  }));
  if (base.currentQueue && state.currentQueue) {
    base.currentQueue.name = state.currentQueue.name || '';
  }
  return base;
}

// Broadcast current state to all clients
function broadcastState() {
  const publicState = buildPublicState();
  const adminState = buildAdminState();

  for (const [id, s] of io.sockets.sockets) {
    if (s.isAdmin) {
      s.emit('queue:state', adminState);
    } else {
      s.emit('queue:state', publicState);
    }
  }

  // Send targeted warnings
  state.waitingQueues.forEach((q, i) => {
    const est = calcEstimatedMinutes(i);
    if (est <= WARNING_MINUTES && q.status === 'waiting') {
      const sock = io.sockets.sockets.get(q.socketId);
      if (sock) {
        sock.emit('queue:warning', {
          queueNumber: q.number,
          estimatedMinutes: est,
        });
      }
    }
  });
}

// ==================== Auto-Advance ====================
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
    advanceToNext();
    broadcastState();
    return;
  }

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

  // Notify the customer whose turn it is
  const sock = io.sockets.sockets.get(next.socketId);
  if (sock) {
    sock.emit('queue:called', {
      queueNumber: next.number,
      message: `ถึงคิวของคุณแล้ว! คิวหมายเลข ${next.number}`,
    });
  }

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
    current: state.currentQueue ? state.currentQueue.number : null,
    completed: state.completedToday,
    uptime: process.uptime(),
  });
});

// ==================== Socket.IO ====================
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);
  socket.isAdmin = false;
  checkDailyReset();
  socket.emit('queue:state', buildPublicState());

  // ---------- Customer: Join ----------
  socket.on('queue:join', ({ groupSize, name }, callback) => {
    try {
      checkDailyReset();
      const size = Math.max(1, Math.min(20, parseInt(groupSize) || 1));
      const customerName = name ? String(name).trim().substring(0, 20) : '';

      const queue = {
        id: generateId(),
        number: state.nextQueueNumber++,
        groupSize: size,
        name: customerName,
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
            name: queue.name,
            totalMinutes: queue.totalMinutes,
            estimatedMinutes: calcEstimatedMinutes(idx),
            createdDate: queue.createdDate,
          },
        });
      }
      console.log(`📋 Queue #${queue.number} joined (${size} ppl, ~${queue.totalMinutes} min)`);

      // Auto-call if no one is currently serving
      if (!state.currentQueue && state.waitingQueues.length === 1) {
        // Don't broadcast yet — wait for auto-call to complete
        setTimeout(() => {
          if (!state.currentQueue && state.waitingQueues.length > 0) {
            const next = advanceToNext();
            if (next) broadcastState();
          }
        }, 1500);
      } else {
        broadcastState();
      }
    } catch (err) {
      console.error('❌ Error in queue:join:', err.message);
      if (callback) callback({ success: false, message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
    }
  });

  // ---------- Cancel ----------
  socket.on('queue:cancel', ({ queueId }, callback) => {
    try {
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
    } catch (err) {
      console.error('❌ Error in queue:cancel:', err.message);
      if (callback) callback({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ---------- Customer: Finish Early ----------
  socket.on('queue:customerComplete', ({ queueId }, callback) => {
    try {
      if (state.currentQueue && state.currentQueue.id === queueId) {
        const next = advanceToNext();
        console.log('✅ Customer finished early' + (next ? `, now #${next.number}` : ''));
        if (callback) callback({ success: true });
        broadcastState();
      } else {
        if (callback) callback({ success: false });
      }
    } catch (err) {
      console.error('❌ Error in queue:customerComplete:', err.message);
      if (callback) callback({ success: false });
    }
  });

  // ---------- Admin: Authenticate Socket (with PIN) ----------
  socket.on('admin:auth', ({ pin } = {}, callback) => {
    try {
      // Validate PIN
      if (pin !== ADMIN_PIN) {
        socket.isAdmin = false;
        if (callback) callback({ success: false, message: 'PIN ไม่ถูกต้อง' });
        return;
      }
      socket.isAdmin = true;
      // Send admin-specific state immediately
      socket.emit('queue:state', buildAdminState());
      if (callback) callback({ success: true });
      console.log(`🔐 Admin authenticated: ${socket.id}`);
    } catch (err) {
      console.error('❌ Error in admin:auth:', err.message);
      if (callback) callback({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ---------- Admin: Call Next (manual skip) ----------
  socket.on('queue:callNext', (data, callback) => {
    try {
      if (!socket.isAdmin) {
        if (callback) callback({ success: false, message: 'ไม่มีสิทธิ์' });
        return;
      }
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
    } catch (err) {
      console.error('❌ Error in queue:callNext:', err.message);
      if (callback) callback({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ---------- Admin: Complete (finish early) ----------
  socket.on('queue:complete', (data, callback) => {
    try {
      if (!socket.isAdmin) {
        if (callback) callback({ success: false, message: 'ไม่มีสิทธิ์' });
        return;
      }
      if (state.currentQueue) {
        const next = advanceToNext();
        console.log('✅ Admin finished early' + (next ? `, now #${next.number}` : ''));
        if (callback) callback({ success: true });
        broadcastState();
      } else {
        if (callback) callback({ success: false, message: 'ไม่มีคิวที่กำลังให้บริการ' });
      }
    } catch (err) {
      console.error('❌ Error in queue:complete:', err.message);
      if (callback) callback({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ---------- Admin: Reset ----------
  socket.on('queue:reset', (data, callback) => {
    try {
      if (!socket.isAdmin) {
        if (callback) callback({ success: false, message: 'ไม่มีสิทธิ์' });
        return;
      }
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
    } catch (err) {
      console.error('❌ Error in queue:reset:', err.message);
      if (callback) callback({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ---------- Customer: Reconnect ----------
  socket.on('queue:reconnect', ({ queueId, createdDate }, callback) => {
    try {
      if (!queueId) {
        if (callback) callback({ success: false, reason: 'invalid' });
        return;
      }

      const today = getBangkokDateString();
      if (createdDate && createdDate !== today) {
        if (callback) callback({ success: false, reason: 'stale' });
        return;
      }

      // Check waiting queues
      const q = state.waitingQueues.find(q => q.id === queueId);
      if (q) {
        q.socketId = socket.id;
        saveState();
        if (callback) callback({
          success: true,
          queue: {
            id: q.id,
            number: q.number,
            groupSize: q.groupSize,
            name: q.name || '',
            totalMinutes: q.totalMinutes,
            createdDate: q.createdDate || today,
          },
          status: 'waiting',
        });
        return;
      }

      // Check current queue
      if (state.currentQueue && state.currentQueue.id === queueId) {
        state.currentQueue.socketId = socket.id;
        saveState();
        if (callback) callback({
          success: true,
          queue: {
            id: state.currentQueue.id,
            number: state.currentQueue.number,
            groupSize: state.currentQueue.groupSize,
            name: state.currentQueue.name || '',
            totalMinutes: state.currentQueue.totalMinutes,
            createdDate: state.currentQueue.createdDate || today,
          },
          status: 'serving',
        });
        return;
      }

      if (callback) callback({ success: false, reason: 'not_found' });
    } catch (err) {
      console.error('❌ Error in queue:reconnect:', err.message);
      if (callback) callback({ success: false, reason: 'error' });
    }
  });

  // ---------- Customer: Check ----------
  socket.on('queue:check', ({ queueId }, callback) => {
    try {
      const inWaiting = state.waitingQueues.find(q => q.id === queueId);
      const isCurrent = state.currentQueue && state.currentQueue.id === queueId;
      if (callback) {
        callback({
          exists: !!(inWaiting || isCurrent),
          status: isCurrent ? 'serving' : inWaiting ? 'waiting' : 'gone',
        });
      }
    } catch (err) {
      console.error('❌ Error in queue:check:', err.message);
      if (callback) callback({ exists: false, status: 'gone' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
  });
});

// ==================== Periodic: Daily reset check (every 60s) ====================
setInterval(() => { checkDailyReset(); }, 60000);

// ==================== Start ====================
loadState();
// Ensure lastResetDate is set
if (!state.lastResetDate) {
  state.lastResetDate = getBangkokDateString();
  saveState();
}
scheduleAutoAdvance();

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
  console.log('║   🌼 Old Daisy Queue System                     ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║  🌐 http://localhost:${PORT}                    ║`);
  console.log(`║  📱 http://${localIP}:${PORT}                   ║`);
  console.log(`║  📅 ${getBangkokDateString()} (Bangkok)         ║`);
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
});