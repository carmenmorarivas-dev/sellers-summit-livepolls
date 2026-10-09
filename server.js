// Sellers Summit - LivePolls
// Live-polling server: presenter screen + phone respondent page + live sync.
// State persisted in SQLite so a server restart during the event does not wipe answers.
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || null; // set once hosted publicly
// Presenter passcode: protects the "ask question / stop / clear" controls once public.
const PRESENTER_CODE = process.env.PRESENTER_CODE || 'summit2026';
// Where the data file lives. On Render, point this at the mounted disk.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'livepolls.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Simple JSON file store (pure JS, no native build needed) ----
// Shape: { session_id, question, active, answers: [{id, text, ts}] }
let store = {
  session_id: nanoid(8),
  question: 'Welcome! Waiting for the first question...',
  active: false,
  answers: []
};

function loadStore() {
  try {
    if (fs.existsSync(DB_PATH)) {
      store = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Could not read data file, starting fresh:', err.message);
  }
}

let saveTimer = null;
function saveStore() {
  // Debounced write so a burst of answers does not hammer the disk.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(store));
    } catch (err) {
      console.error('Could not write data file:', err.message);
    }
  }, 300);
}

loadStore();

function publicState() {
  return {
    id: store.session_id,
    question: store.question,
    active: store.active,
    answers: store.answers
  };
}

function broadcastState() {
  io.emit('state', publicState());
}

function requireCode(req, res) {
  const code = (req.body && req.body.code) || req.get('x-presenter-code');
  if (code !== PRESENTER_CODE) {
    res.status(403).json({ error: 'Wrong presenter passcode' });
    return false;
  }
  return true;
}

// ---- Routes ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});

app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'respond.html'));
});

app.get('/api/qrcode', async (req, res) => {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const joinUrl = `${base}/join`;
  try {
    const png = await QRCode.toBuffer(joinUrl, { width: 400, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'Could not generate QR code' });
  }
});

app.get('/api/join-url', (req, res) => {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ joinUrl: `${base}/join` });
});

app.get('/api/state', (req, res) => {
  res.json(publicState());
});

// Presenter starts a new question (passcode-protected)
app.post('/api/question', (req, res) => {
  if (!requireCode(req, res)) return;
  const { question } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question text is required' });
  }
  store.session_id = nanoid(8);
  store.question = question.trim();
  store.active = true;
  store.answers = []; // fresh question => fresh answers
  saveStore();
  broadcastState();
  res.json(publicState());
});

app.post('/api/stop', (req, res) => {
  if (!requireCode(req, res)) return;
  store.active = false;
  saveStore();
  broadcastState();
  res.json(publicState());
});

app.post('/api/clear', (req, res) => {
  if (!requireCode(req, res)) return;
  store.answers = [];
  saveStore();
  broadcastState();
  res.json(publicState());
});

// Respondent submits an answer (no passcode -- audience is anonymous)
app.post('/api/answer', (req, res) => {
  if (!store.active) {
    return res.status(409).json({ error: 'This question is not accepting answers right now' });
  }
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Please enter an answer' });
  }
  const clean = text.trim().slice(0, 200);
  store.answers.push({ id: nanoid(6), text: clean, ts: Date.now() });
  saveStore();
  broadcastState();
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('state', publicState());
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`Sellers Summit - LivePolls running on port ${PORT}`);
});
