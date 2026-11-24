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

const webpush = require('web-push');
const store = require('./lib/store');
const { isAllowed, resolveChatJid, phoneToJid, describeMessage, unwrap } = require('./lib/filter');

const PORT = process.env.PORT || 3000;
const FAKE_WA = process.env.SAFECHAT_FAKE_WA === '1'; // development only: pretend WhatsApp
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });
store.init(DATA_DIR);

const { vapid } = store.getConfig();
webpush.setVapidDetails('mailto:safechat@localhost', vapid.publicKey, vapid.privateKey);

// Recent events, shown in the parent panel so problems can be diagnosed without a terminal.
const diagLog = [];
function diag(text) {
  diagLog.push({ t: Date.now(), text });
  if (diagLog.length > 80) diagLog.shift();
  console.log('[diag]', text);
}

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

// Brute-force protection: after too many wrong passwords, lock that address (and, as a
// backstop against many addresses, the whole role) for a while.
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // key -> { count, until }
function isLocked(key) {
  const f = failures.get(key);
  return f && f.until > Date.now();
}
function recordFailure(key, max) {
  const f = failures.get(key) || { count: 0, until: 0 };
  if (f.until && f.until <= Date.now()) { f.count = 0; f.until = 0; }
  f.count++;
  if (f.count >= max) f.until = Date.now() + LOCK_MS;
  failures.set(key, f);
}

app.set('trust proxy', 'loopback'); // real client IP when running behind Caddy

app.post('/api/login', (req, res) => {
  const { role, password } = req.body || {};
  const ipKey = `ip:${req.ip}`;
  const roleKey = `role:${role}`;
  if (isLocked(ipKey) || isLocked(roleKey)) {
    return res.status(429).json({ error: 'יותר מדי ניסיונות. נסה שוב בעוד 15 דקות' });
  }
  const cfg = store.getConfig();
  const expected = role === 'parent' ? cfg.parentPassword : role === 'child' ? cfg.childPin : null;
  if (!expected || !safeEqual(password || '', expected)) {
    recordFailure(ipKey, 5);
    recordFailure(roleKey, 30);
    return res.status(401).json({ error: 'סיסמה שגויה' });
  }
  failures.delete(ipKey);
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

// Ask WhatsApp for the contact's hidden LID so messages addressed that way still match.
async function lookupLid(jid) {
  if (wa.state !== 'open' || !jid.endsWith('@s.whatsapp.net')) return { known: false };
  try {
    const [r] = (await wa.sock.onWhatsApp(jid)) || [];
    const lid = await wa.sock.signalRepository.lidMapping.getLIDForPN(jid).catch(() => null);
    return { known: true, exists: !!r?.exists, lid: lid ? jidNormalizedUser(lid) : null };
  } catch (e) {
    diag(`בדיקת מספר נכשלה: ${e.message}`);
    return { known: false };
  }
}

app.post('/api/admin/contacts', requireRole('parent'), async (req, res) => {
  const { phone, name } = req.body || {};
  // Approving straight from the blocked list passes the exact WhatsApp id.
  const direct = req.body?.jid;
  const jid = direct && /@(s\.whatsapp\.net|lid)$/.test(direct) ? direct : phoneToJid(phone);
  if (!jid) return res.status(400).json({ error: 'מספר טלפון לא תקין' });
  const info = await lookupLid(jid);
  const label = (name || '').trim() || phone || jid.split('@')[0];
  store.updateConfig((c) => {
    c.allowedContacts = c.allowedContacts.filter((x) => x.jid !== jid);
    c.allowedContacts.push({ jid, name: label, ...(jid.endsWith('@lid') ? { lid: jid } : info.lid ? { lid: info.lid } : {}) });
  });
  store.removeBlocked(jid);
  if (info.lid) store.removeBlocked(info.lid);
  diag(`איש קשר נוסף: ${label} (${jid.split('@')[0]})` + (info.lid ? ' · מזהה פנימי נשמר' : ''));
  broadcastChats();
  res.json({ ok: true, warning: info.known && !info.exists ? 'שים לב: נראה שהמספר הזה לא רשום בוואטסאפ' : null });
});

app.get('/api/admin/diag', requireRole('parent'), (req, res) => {
  const cfg = store.getConfig();
  res.json({
    connection: wa.state,
    subscriptions: (cfg.pushSubscriptions || []).length,
    contacts: cfg.allowedContacts.map((c) => ({ name: c.name, jid: c.jid, hasLid: !!c.lid })),
    log: diagLog.slice().reverse(),
  });
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

// ----- Push notifications -----
app.get('/api/push/key', requireRole('child'), (req, res) => res.json({ key: store.getConfig().vapid.publicKey }));

app.post('/api/push/subscribe', requireRole('child'), (req, res) => {
  const sub = req.body;
  diag('הטלפון של הילד אישר קבלת התראות');
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return res.status(400).json({ error: 'bad subscription' });
  store.addSubscription({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  res.json({ ok: true });
});

const MEDIA_LABELS = {
  image: '📷 תמונה', video: '🎥 סרטון', audio: '🎤 הודעה קולית', sticker: '🙂 סטיקר',
  document: '📄 מסמך', location: '📍 מיקום', contact: '👤 איש קשר',
};

function notifyChild(jid, m) {
  const cfg = store.getConfig();
  const chat = [...cfg.allowedContacts, ...cfg.allowedGroups].find((c) => c.jid === jid);
  const isGroup = jid.endsWith('@g.us');
  const body = m.type === 'text' ? m.text : [MEDIA_LABELS[m.type], m.text].filter(Boolean).join(' ');
  const payload = JSON.stringify({
    title: chat?.name || 'הודעה חדשה',
    body: isGroup && m.senderName ? `${m.senderName}: ${body}` : body,
    jid,
  });
  const subs = cfg.pushSubscriptions || [];
  if (!subs.length) diag('לא נשלחה התראה: אין מכשיר שאישר קבלת התראות');
  for (const sub of subs) {
    webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24, urgency: 'high' })
      .then(() => diag('התראה נשלחה לטלפון'))
      .catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) store.removeSubscription(sub.endpoint);
        diag(`שליחת התראה נכשלה (${err.statusCode || err.message})`);
      });
  }
}

app.get('/api/chats', requireRole('child'), (req, res) => res.json(allowedChats()));

app.get('/api/chats/:jid/messages', requireRole('child'), (req, res) => {
  const { jid } = req.params;
  if (!isAllowed(jid, store.getConfig())) return res.status(403).json({ error: 'forbidden' });
  store.markRead(jid);
  res.json(store.getMessages(jid));
});

function requireConnection(res, what) {
  if (wa.state === 'open') return true;
  diag(`הילד ניסה ${what}, אבל אין חיבור לוואטסאפ (מצב: ${wa.state})`);
  res.status(409).json({ error: 'אין חיבור לוואטסאפ כרגע' });
  return false;
}

// The original WhatsApp message for a stored one (rebuilt for text if the original wasn't kept).
function rawFor(jid, m) {
  return store.getRaw(jid, m.id) || {
    key: { remoteJid: jid, id: m.id, fromMe: m.fromMe, ...(m.sender ? { participant: m.sender } : {}) },
    message: { conversation: m.text || '' },
    messageTimestamp: m.timestamp,
  };
}

const keyFor = (jid, m) => ({ remoteJid: jid, id: m.id, fromMe: m.fromMe, ...(m.sender ? { participant: m.sender } : {}) });

function emitUpdate(jid, m) {
  io.to('child').emit('message-update', { jid, message: m });
  broadcastChats();
}

function isMyJid(j) {
  const u = wa.sock?.user;
  if (!j || !u) return false;
  const n = jidNormalizedUser(j);
  return n === jidNormalizedUser(u.id) || (!!u.lid && n === jidNormalizedUser(u.lid));
}

function enrichQuoted(jid, m) {
  if (!m?.quoted) return m;
  const orig = store.getMessage(jid, m.quoted.id);
  m.quoted.fromMe = orig ? orig.fromMe : isMyJid(m.quoted.sender) || (!m.quoted.sender && !m.fromMe);
  if (orig?.senderName) m.quoted.senderName = orig.senderName;
  return m;
}

// Store and show a message the child just sent, without waiting for WhatsApp's echo.
function recordSent(jid, sent) {
  const m = sent && enrichQuoted(jid, describeMessage(sent));
  if (m && store.addMessage(jid, m, sent)) {
    io.to('child').emit('message', { jid, message: m });
    broadcastChats();
  }
}

// Every message action below checks that the chat is approved.
function allowedChat(req, res) {
  const { jid } = req.params;
  if (!isAllowed(jid, store.getConfig())) { res.status(403).json({ error: 'forbidden' }); return null; }
  return jid;
}

function storedMessage(req, res) {
  const jid = allowedChat(req, res);
  if (!jid) return null;
  const m = store.getMessage(jid, req.params.id);
  if (!m) { res.status(404).json({ error: 'not found' }); return null; }
  return { jid, m };
}

app.post('/api/chats/:jid/messages', requireRole('child'), async (req, res) => {
  const jid = allowedChat(req, res);
  if (!jid) return;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  if (!requireConnection(res, 'לשלוח הודעה')) return;
  const replyTo = req.body?.replyTo && store.getMessage(jid, req.body.replyTo);
  try {
    const sent = await wa.sock.sendMessage(jid, { text }, replyTo ? { quoted: rawFor(jid, replyTo) } : {});
    recordSent(jid, sent);
    diag(`הילד שלח הודעה אל ${jid.split('@')[0]}`);
    res.json({ ok: true });
  } catch (e) {
    diag(`שליחת הודעה של הילד נכשלה: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chats/:jid/messages/:id/react', requireRole('child'), async (req, res) => {
  const found = storedMessage(req, res);
  if (!found) return;
  const { jid, m } = found;
  const emoji = String(req.body?.emoji || '');
  if (!requireConnection(res, 'להגיב להודעה')) return;
  try {
    await wa.sock.sendMessage(jid, { react: { text: emoji, key: keyFor(jid, m) } });
    applyReaction(jid, m.id, 'me', emoji);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stars are private to SafeChat (they don't sync back to the phone).
app.post('/api/chats/:jid/messages/:id/star', requireRole('child'), (req, res) => {
  const found = storedMessage(req, res);
  if (!found) return;
  const m = store.updateMessage(found.jid, found.m.id, (x) => { x.starred = !!req.body?.starred; });
  emitUpdate(found.jid, m);
  res.json({ ok: true });
});

app.get('/api/starred', requireRole('child'), (req, res) => {
  const cfg = store.getConfig();
  res.json(store.getStarred().filter((s) => isAllowed(s.jid, cfg)));
});

// ?everyone=1 deletes for everyone (only the child's own messages); otherwise only from SafeChat.
app.delete('/api/chats/:jid/messages/:id', requireRole('child'), async (req, res) => {
  const found = storedMessage(req, res);
  if (!found) return;
  const { jid, m } = found;
  if (req.query.everyone === '1') {
    if (!m.fromMe) return res.status(403).json({ error: 'אפשר למחוק לכולם רק הודעות שלך' });
    if (!requireConnection(res, 'למחוק הודעה')) return;
    try {
      await wa.sock.sendMessage(jid, { delete: keyFor(jid, m) });
      markDeleted(jid, m.id);
      diag(`הילד מחק לכולם הודעה בצ'אט ${jid.split('@')[0]}`);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  } else {
    store.removeMessage(jid, m.id);
    io.to('child').emit('message-removed', { jid, id: m.id });
    broadcastChats();
  }
  res.json({ ok: true });
});

// Forwarding only works into other approved chats.
app.post('/api/chats/:jid/messages/:id/forward', requireRole('child'), async (req, res) => {
  const found = storedMessage(req, res);
  if (!found) return;
  const { jid, m } = found;
  const cfg = store.getConfig();
  const targets = [].concat(req.body?.to || []).filter((t) => isAllowed(t, cfg));
  if (!targets.length) return res.status(400).json({ error: 'לא נבחר צ\'אט' });
  if (m.deleted) return res.status(400).json({ error: 'ההודעה נמחקה' });
  if (!requireConnection(res, 'להעביר הודעה')) return;
  try {
    for (const to of targets) recordSent(to, await wa.sock.sendMessage(to, { forward: rawFor(jid, m) }));
    diag(`הילד העביר הודעה ל-${targets.length} צ'אטים`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Development only (SAFECHAT_FAKE_WA=1): simulate messages and calls arriving from other phones.
if (FAKE_WA) {
  app.post('/api/dev/incoming', (req, res) => {
    const { jid, message, key, pushName, call } = req.body || {};
    if (call) {
      wa.sock.ev.emit('call', [{ id: 'C' + Date.now(), from: jid, status: 'offer', isVideo: !!call.video, date: new Date() }]);
      return res.json({ ok: true });
    }
    res.json(wa.sock.incoming(jid, message, { key, pushName }));
  });
}

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
  const { version } = FAKE_WA ? {} : await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const sock = FAKE_WA ? require('./lib/fake-wa').makeFakeSocket() : makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['SafeChat', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    // Lets WhatsApp re-send our messages if a recipient's phone couldn't decrypt them.
    getMessage: async (key) => {
      const jid = jidNormalizedUser(key.remoteJid || '');
      return store.getRaw(jid, key.id)?.message || undefined;
    },
    syncFullHistory: false,
  });
  wa.sock = sock;
  wa.state = 'connecting';

  sock.ev.on('creds.update', saveCreds);

  // SafeChat can't take WhatsApp calls, so calls are declined (otherwise they would ring on the
  // parent's phone). Calls from approved contacts show up in the chat as a missed call.
  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      if (call.status !== 'offer') continue;
      try { await sock.rejectCall(call.id, call.from); } catch (e) { logger.warn({ err: e.message }, 'reject call failed'); }
      const cfg = store.getConfig();
      let jid = jidNormalizedUser(call.isGroup && call.groupJid ? call.groupJid : (call.callerPn || call.from));
      if (jid.endsWith('@lid')) jid = jidNormalizedUser(resolveChatJid({ remoteJid: jid }, cfg));
      if (!isAllowed(jid, cfg)) { diag(`נדחתה שיחה ממספר לא מאושר (${jid.split('@')[0]})`); continue; }
      const m = {
        id: `call-${call.id}`, fromMe: false, sender: null, senderName: '', type: 'call',
        text: call.isVideo ? 'שיחת וידאו שלא נענתה' : 'שיחה קולית שלא נענתה',
        timestamp: Math.floor((call.date?.getTime?.() || Date.now()) / 1000),
      };
      if (store.addMessage(jid, m)) {
        io.to('child').emit('message', { jid, message: m });
        broadcastChats();
        notifyChild(jid, { ...m, text: '📞 ' + m.text });
        diag(`שיחה נכנסת מ-${jid.split('@')[0]} נדחתה והוצגה לילד כשיחה שלא נענתה`);
      }
    }
  });

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
      diag('מחובר לוואטסאפ');
      backfillLids();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      wa.state = 'closed';
      diag(`החיבור לוואטסאפ נסגר (קוד ${code ?? '?'}), מתחבר מחדש`);
      if (code === DisconnectReason.loggedOut) {
        console.log('[whatsapp] logged out - clearing session, a new QR will be generated');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }
      setTimeout(connectWhatsApp, 3000);
    }
    io.to('parent').emit('status', wa.state);
  });

  // WhatsApp tells us which hidden LID belongs to which phone number; remember it for approved contacts.
  sock.ev.on('lid-mapping.update', (pairs) => {
    for (const { lid, pn } of [].concat(pairs || [])) rememberLid(lid, pn);
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    const cfg = store.getConfig();
    let changed = false;
    for (const msg of messages) {
      let jid = jidNormalizedUser(resolveChatJid(msg.key, cfg));
      if (jid.endsWith('@lid')) {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
        if (pn) { rememberLid(jid, pn); jid = jidNormalizedUser(pn); }
      }
      if (!jid || jid === 'status@broadcast' || !msg.message) continue;
      // Learn the hidden LID of approved contacts whenever WhatsApp tells us both ids.
      const alt = msg.key.remoteJidAlt || msg.key.senderLid;
      if (msg.key.remoteJid?.endsWith('@lid')) rememberLid(msg.key.remoteJid, jid);
      else if (alt?.endsWith('@lid')) rememberLid(alt, jid);

      const who = `${msg.pushName || ''} (${jid.split('@')[0]}${jid.endsWith('@lid') ? ', מזהה פנימי' : ''})`;
      if (!isAllowed(jid, cfg)) {
        // Not approved: never shown to the child. Remember it for the parent.
        if (!msg.key.fromMe) {
          store.addBlocked(jid, msg.pushName || '');
          if (type === 'notify') diag(`נחסמה הודעה מ-${who}`);
        }
        continue;
      }
      if (handleSpecialMessage(jid, msg)) continue;
      if (type === 'notify') diag(`${msg.key.fromMe ? 'נשלחה הודעה אל' : 'התקבלה הודעה מ'}-${who}`);
      const m = enrichQuoted(jid, describeMessage(msg));
      if (!m || !store.addMessage(jid, m, msg)) continue; // skip duplicates (e.g. our own sent messages)
      io.to('child').emit('message', { jid, message: m });
      if (!m.fromMe && type === 'notify') notifyChild(jid, m);
      changed = true;
    }
    if (changed) broadcastChats();
  });
}

function applyReaction(jid, id, who, emoji) {
  const m = store.updateMessage(jid, id, (x) => {
    x.reactions ||= {};
    if (emoji) x.reactions[who] = emoji;
    else delete x.reactions[who];
  });
  if (m) emitUpdate(jid, m);
}

function markDeleted(jid, id) {
  const m = store.updateMessage(jid, id, (x) => {
    x.deleted = true;
    x.text = '';
    delete x.quoted;
    delete x.reactions;
  });
  if (m) emitUpdate(jid, m);
}

// Reactions, deletions and edits arrive as special messages that change an earlier one.
function handleSpecialMessage(jid, msg) {
  const body = unwrap(msg.message);
  const who = msg.key.fromMe ? 'me' : (msg.key.participant || jid);
  if (body?.reactionMessage) {
    const r = body.reactionMessage;
    if (r.key?.id) applyReaction(jid, r.key.id, who, r.text || '');
    return true;
  }
  const p = body?.protocolMessage;
  if (p?.key?.id && p.type === 0) { // REVOKE: "deleted for everyone"
    markDeleted(jid, p.key.id);
    return true;
  }
  if (p?.key?.id && p.type === 14 && p.editedMessage) { // MESSAGE_EDIT
    const edited = describeMessage({ key: p.key, message: p.editedMessage, messageTimestamp: msg.messageTimestamp });
    const m = edited && store.updateMessage(jid, p.key.id, (x) => { x.text = edited.text; x.edited = true; });
    if (m) emitUpdate(jid, m);
    return true;
  }
  return !!p; // other protocol messages are internal to WhatsApp
}

function rememberLid(lid, pn) {
  if (!lid || !pn || !lid.endsWith('@lid')) return;
  lid = jidNormalizedUser(lid);
  pn = jidNormalizedUser(pn);
  const c = store.getConfig().allowedContacts.find((x) => x.jid === pn);
  if (c && c.lid !== lid) store.updateConfig(() => { c.lid = lid; });
}

// Contacts approved before LID support (or while offline) get their LID looked up once connected.
async function backfillLids() {
  for (const c of store.getConfig().allowedContacts.filter((x) => !x.lid && x.jid.endsWith('@s.whatsapp.net'))) {
    const info = await lookupLid(c.jid);
    if (info.lid) store.updateConfig(() => { c.lid = info.lid; });
    if (info.known && !info.exists) diag(`המספר של ${c.name} לא נמצא בוואטסאפ`);
  }
}

connectWhatsApp().catch((e) => console.error('[whatsapp] failed to start', e));

server.listen(PORT, process.env.HOST || "0.0.0.0", () => {
  const cfg = store.getConfig();
  console.log(`SafeChat running on http://localhost:${PORT}`);
  if (cfg._generated) {
    console.log('First run - generated credentials (change them in the parent panel):');
    console.log('  parent password:', cfg.parentPassword);
    console.log('  child PIN:      ', cfg.childPin);
  }
});
