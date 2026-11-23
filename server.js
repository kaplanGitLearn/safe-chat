// SafeChat - a filtered WhatsApp client for kids.
// The server connects to WhatsApp as a "linked device" (like WhatsApp Web)
// and only lets through chats that a parent has approved.

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const store = require('./lib/store');
const { isAllowed, phoneToJid, describeMessage } = require('./lib/filter');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });
store.init(DATA_DIR);

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// ---------- Web server ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessionMiddleware = session({
  secret: store.getConfig().sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 },
});
app.use(sessionMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const requireRole = (role) => (req, res, next) =>
  req.session.role === role ? next() : res.status(401).json({ error: 'unauthorized' });

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.post('/api/login', (req, res) => {
  const { role, password } = req.body || {};
  const cfg = store.getConfig();
  const expected = role === 'parent' ? cfg.parentPassword : role === 'child' ? cfg.childPin : null;
  if (!expected || !safeEqual(password || '', expected)) {
    return res.status(401).json({ error: 'סיסמה שגויה' });
  }
  req.session.role = role;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ role: req.session.role || null }));

// ----- Parent API -----
app.get('/api/admin/status', requireRole('parent'), async (req, res) => {
  res.json({
    connection: wa.state,
    qr: wa.qr ? await QRCode.toDataURL(wa.qr) : null,
    me: wa.sock?.user || null,
  });
});

app.get('/api/admin/config', requireRole('parent'), (req, res) => {
  const cfg = store.getConfig();
  res.json({ allowedContacts: cfg.allowedContacts, allowedGroups: cfg.allowedGroups });
});

app.get('/api/admin/groups', requireRole('parent'), async (req, res) => {
  if (wa.state !== 'open') return res.status(409).json({ error: 'וואטסאפ לא מחובר' });
  try {
    const groups = await wa.sock.groupFetchAllParticipating();
    res.json(Object.values(groups).map((g) => ({ jid: g.id, name: g.subject, size: g.participants?.length || 0 })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recent chats the filter blocked, so the parent can decide whether to approve them.
app.get('/api/admin/blocked', requireRole('parent'), (req, res) => res.json(store.getBlocked()));

app.post('/api/admin/contacts', requireRole('parent'), (req, res) => {
  const { phone, name } = req.body || {};
  const jid = phoneToJid(phone);
  if (!jid) return res.status(400).json({ error: 'מספר טלפון לא תקין' });
  store.updateConfig((c) => {
    c.allowedContacts = c.allowedContacts.filter((x) => x.jid !== jid);
    c.allowedContacts.push({ jid, name: (name || '').trim() || phone });
  });
  store.removeBlocked(jid);
  broadcastChats();
  res.json({ ok: true });
});

app.delete('/api/admin/contacts/:jid', requireRole('parent'), (req, res) => {
  store.updateConfig((c) => { c.allowedContacts = c.allowedContacts.filter((x) => x.jid !== req.params.jid); });
  broadcastChats();
  res.json({ ok: true });
});

app.post('/api/admin/groups', requireRole('parent'), (req, res) => {
  const { jid, name } = req.body || {};
  if (!jid || !jid.endsWith('@g.us')) return res.status(400).json({ error: 'קבוצה לא תקינה' });
  store.updateConfig((c) => {
    c.allowedGroups = c.allowedGroups.filter((x) => x.jid !== jid);
    c.allowedGroups.push({ jid, name: name || jid });
  });
  store.removeBlocked(jid);
  broadcastChats();
  res.json({ ok: true });
});

app.delete('/api/admin/groups/:jid', requireRole('parent'), (req, res) => {
  store.updateConfig((c) => { c.allowedGroups = c.allowedGroups.filter((x) => x.jid !== req.params.jid); });
  broadcastChats();
  res.json({ ok: true });
});

app.post('/api/admin/passwords', requireRole('parent'), (req, res) => {
  const { parentPassword, childPin } = req.body || {};
  store.updateConfig((c) => {
    if (parentPassword && parentPassword.length >= 6) c.parentPassword = parentPassword;
    if (childPin && childPin.length >= 4) c.childPin = childPin;
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout-whatsapp', requireRole('parent'), async (req, res) => {
  try { await wa.sock?.logout(); } catch (_) {}
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true });
});

// ----- Child API -----
function allowedChats() {
  const cfg = store.getConfig();
  return [
    ...cfg.allowedContacts.map((c) => ({ ...c, isGroup: false })),
    ...cfg.allowedGroups.map((g) => ({ ...g, isGroup: true })),
  ].map((c) => {
    const msgs = store.getMessages(c.jid);
    const last = msgs[msgs.length - 1];
    return { ...c, lastMessage: last || null, unread: store.getUnread(c.jid) };
  }).sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
}

app.get('/api/chats', requireRole('child'), (req, res) => res.json(allowedChats()));

app.get('/api/chats/:jid/messages', requireRole('child'), (req, res) => {
  const { jid } = req.params;
  if (!isAllowed(jid, store.getConfig())) return res.status(403).json({ error: 'forbidden' });
  store.markRead(jid);
  res.json(store.getMessages(jid));
});

app.post('/api/chats/:jid/messages', requireRole('child'), async (req, res) => {
  const { jid } = req.params;
  const text = String(req.body?.text || '').trim();
  if (!isAllowed(jid, store.getConfig())) return res.status(403).json({ error: 'forbidden' });
  if (!text) return res.status(400).json({ error: 'empty' });
  if (wa.state !== 'open') return res.status(409).json({ error: 'אין חיבור כרגע' });
  try {
    await wa.sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Media is only served for messages in allowed chats.
app.get('/api/media/:jid/:id', requireRole('child'), async (req, res) => {
  const { jid, id } = req.params;
  if (!isAllowed(jid, store.getConfig())) return res.status(403).end();
  const raw = store.getRaw(jid, id);
  if (!raw) return res.status(404).end();
  try {
    const buf = await downloadMediaMessage(raw, 'buffer', {}, { logger, reuploadRequest: wa.sock.updateMediaMessage });
    const m = raw.message;
    const mime = (m.imageMessage || m.stickerMessage || m.videoMessage || m.audioMessage)?.mimetype || 'application/octet-stream';
    res.set('Content-Type', mime).send(buf);
  } catch (e) {
    res.status(500).end();
  }
});

// ---------- Socket.IO (live updates for the child UI) ----------
io.engine.use(sessionMiddleware);
io.on('connection', (socket) => {
  const role = socket.request.session?.role;
  if (role === 'child') socket.join('child');
  else if (role === 'parent') socket.join('parent');
  else socket.disconnect(true);
});

function broadcastChats() {
  io.to('child').emit('chats', allowedChats());
}

// ---------- WhatsApp connection ----------
const wa = { sock: null, state: 'connecting', qr: null };

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['SafeChat', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  wa.sock = sock;
  wa.state = 'connecting';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      wa.qr = qr;
      wa.state = 'qr';
      console.log('[whatsapp] QR ready - open the parent panel (/admin.html) to scan it');
    }
    if (connection === 'open') {
      wa.qr = null;
      wa.state = 'open';
      console.log('[whatsapp] connected as', sock.user?.id);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      wa.state = 'closed';
      if (code === DisconnectReason.loggedOut) {
        console.log('[whatsapp] logged out - clearing session, a new QR will be generated');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }
      setTimeout(connectWhatsApp, 3000);
    }
    io.to('parent').emit('status', wa.state);
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    const cfg = store.getConfig();
    let changed = false;
    for (const msg of messages) {
      // Newer WhatsApp versions may address 1:1 chats by a hidden "LID" instead of the phone
      // number; map it back to the phone number so the allowlist still matches.
      let remote = msg.key.remoteJid || '';
      if (remote.endsWith('@lid')) remote = msg.key.senderPn || msg.key.remoteJidAlt || remote;
      const jid = jidNormalizedUser(remote);
      if (!jid || jid === 'status@broadcast' || !msg.message) continue;

      if (!isAllowed(jid, cfg)) {
        // Not approved: never shown to the child. Remember it for the parent.
        if (!msg.key.fromMe) store.addBlocked(jid, msg.pushName || '');
        continue;
      }
      const m = describeMessage(msg);
      if (!m) continue;
      store.addMessage(jid, m, msg);
      io.to('child').emit('message', { jid, message: m });
      changed = true;
    }
    if (changed) broadcastChats();
  });
}

connectWhatsApp().catch((e) => console.error('[whatsapp] failed to start', e));

server.listen(PORT, () => {
  const cfg = store.getConfig();
  console.log(`SafeChat running on http://localhost:${PORT}`);
  if (cfg._generated) {
    console.log('First run - generated credentials (change them in the parent panel):');
    console.log('  parent password:', cfg.parentPassword);
    console.log('  child PIN:      ', cfg.childPin);
  }
});
