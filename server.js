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
const BASE_URL = process.env.BASE_URL || null; // e.g. https://olddaisy-queue.onrender.com
const MINUTES_PER_PERSON = 2;
const WARNING_MINUTES = 10;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'queue.json');

// ==================== Queue State ====================
let state = {
  nextQueueNumber: 1,
  currentQueue: null,       // Queue object currently being served
  currentStartedAt: null,   // Timestamp when current queue started
  waitingQueues: [],         // Array of queue objects waiting
  completedToday: 0,
};

// Queue object shape:
// { id, number, groupSize, totalMinutes, status, createdAt, socketId }
// status: 'waiting' | 'called' | 'serving' | 'completed' | 'cancelled'

// ==================== Persistence ====================
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveState() {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save state:', err.message);
  }
}

function loadState() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      state = { ...state, ...raw };
      console.log(`📂 Loaded ${state.waitingQueues.length} waiting queues from disk.`);
    }
  } catch (err) {
    console.error('Failed to load state:', err.message);
  }
}

// ==================== Queue Helpers ====================
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function calcEstimatedMinutes(queueIndex) {
  // Sum of all queues before this index + current serving remaining
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
  };
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

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// QR Code endpoint
app.get('/api/qr', async (req, res) => {
  try {
    let url;
    if (BASE_URL) {
      url = BASE_URL;
    } else {
      // Auto-detect from request headers (works on reverse proxies & direct)
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

// ==================== Socket.IO ====================
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Send initial state
  socket.emit('queue:state', buildPublicState());

  // Customer joins queue
  socket.on('queue:join', ({ groupSize }, callback) => {
    const size = Math.max(1, Math.min(20, parseInt(groupSize) || 1));
    const queue = {
      id: generateId(),
      number: state.nextQueueNumber++,
      groupSize: size,
      totalMinutes: size * MINUTES_PER_PERSON,
      status: 'waiting',
      createdAt: Date.now(),
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
        },
      });
    }

    console.log(`📋 Queue #${queue.number} joined (${size} people, ~${queue.totalMinutes} min)`);
    broadcastState();
  });

  // Cancel queue
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

  // Admin: Call next queue
  socket.on('queue:callNext', (data, callback) => {
    // If currently serving, complete it first
    if (state.currentQueue) {
      state.currentQueue.status = 'completed';
      state.completedToday++;
    }

    if (state.waitingQueues.length === 0) {
      state.currentQueue = null;
      state.currentStartedAt = null;
      saveState();
      if (callback) callback({ success: false, message: 'ไม่มีคิวที่รออยู่' });
      broadcastState();
      return;
    }

    const next = state.waitingQueues.shift();
    next.status = 'serving';
    state.currentQueue = next;
    state.currentStartedAt = Date.now();
    saveState();

    // Notify the customer
    io.to(next.socketId).emit('queue:called', {
      queueNumber: next.number,
      message: `ถึงคิวของคุณแล้ว! คิวหมายเลข ${next.number}`,
    });

    console.log(`📢 Calling queue #${next.number}`);
    if (callback) callback({ success: true, queue: next });
    broadcastState();
  });

  // Admin: Complete current queue (without calling next)
  socket.on('queue:complete', (data, callback) => {
    if (state.currentQueue) {
      state.currentQueue.status = 'completed';
      state.completedToday++;
      state.currentQueue = null;
      state.currentStartedAt = null;
      saveState();
      console.log('✅ Current queue completed');
      if (callback) callback({ success: true });
      broadcastState();
    } else {
      if (callback) callback({ success: false, message: 'ไม่มีคิวที่กำลังให้บริการ' });
    }
  });

  // Admin: Reset all queues
  socket.on('queue:reset', (data, callback) => {
    state.nextQueueNumber = 1;
    state.currentQueue = null;
    state.currentStartedAt = null;
    state.waitingQueues = [];
    state.completedToday = 0;
    saveState();
    console.log('🔄 All queues reset');
    if (callback) callback({ success: true });
    broadcastState();
  });

  // Update socket ID when customer reconnects
  socket.on('queue:reconnect', ({ queueId }, callback) => {
    const q = state.waitingQueues.find(q => q.id === queueId);
    if (q) {
      q.socketId = socket.id;
      saveState();
      if (callback) callback({ success: true, queue: q });
    } else if (state.currentQueue && state.currentQueue.id === queueId) {
      state.currentQueue.socketId = socket.id;
      saveState();
      if (callback) callback({ success: true, queue: state.currentQueue });
    } else {
      if (callback) callback({ success: false });
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// ==================== Periodic Broadcast ====================
setInterval(() => {
  broadcastState();
}, 5000);

// ==================== Start Server ====================
loadState();
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
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   📸 Photo Queue System Started!         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  🌐 Local:   http://localhost:${PORT}      ║`);
  console.log(`║  📱 Network: http://${localIP}:${PORT}  ║`);
  console.log(`║  🔧 Admin:   http://localhost:${PORT}/admin ║`);
  console.log(`║  🔑 PIN:     ${ADMIN_PIN}                       ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
