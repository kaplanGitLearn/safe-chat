const $ = (id) => document.getElementById(id);
let chats = [];
let current = null;
let socket = null;
let lastRendered = null; // last message shown, for grouping bubbles and day separators

const PERSON_SVG = '<svg viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-10 2.67-10 6v4h20v-4c0-3.33-4.67-6-10-6z"/></svg>';
const GROUP_SVG = '<svg viewBox="0 0 24 24"><path d="M16 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm-8 0a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm0 2c-2.7 0-8 1.34-8 4v3h16v-3c0-2.66-5.3-4-8-4zm8 0c-.29 0-.62.02-.97.05C16.19 13.9 17 15.04 17 17v3h7v-3c0-2.66-5.3-4-8-4z"/></svg>';
const TICK_SVG = '<svg viewBox="0 0 16 11"><path d="M11.07.65 4.2 7.52 1.43 4.75.36 5.82 4.2 9.66l7.94-7.94z"/></svg>';
const SENDER_COLORS = ['#e542a3', '#1f7aec', '#d3396d', '#7f66ff', '#029d00', '#fa6533', '#c4532d', '#a62c71', '#3bb5a2', '#8b7add'];

function avatar(isGroup) {
  const a = el('div', { class: 'avatar' + (isGroup ? ' group' : '') });
  a.innerHTML = isGroup ? GROUP_SVG : PERSON_SVG;
  return a;
}

function senderColor(id) {
  let h = 0;
  for (const ch of id || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length];
}

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'היום';
  if (d.toDateString() === yest.toDateString()) return 'אתמול';
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
}

const clock = (ts) => new Date(ts * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

// ---------- Startup / login ----------
async function start() {
  const { role } = await api('/api/me');
  if (role !== 'child') return showLogin();
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  chats = await api('/api/chats');
  renderChats();
  connectSocket();
  setupNotifications();
  const wanted = new URLSearchParams(location.search).get('chat');
  if (wanted) openChatByJid(wanted);
}

function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: { role: 'child', password: $('pin').value } });
    $('pin').value = '';
    start();
  } catch (err) {
    $('loginError').textContent = err.message;
  }
});

$('logoutBtn').onclick = async () => {
  if (!confirm('לצאת מהחשבון?')) return;
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
};

function closeChat() {
  current = null;
  $('app').classList.remove('in-chat');
  $('chatView').classList.add('hidden');
  $('placeholder').classList.remove('hidden');
  history.replaceState(null, '', '/');
  renderChats();
}
$('backBtn').onclick = () => history.state?.chat ? history.back() : closeChat();
// Android back button closes the open chat instead of leaving the app
window.addEventListener('popstate', () => { if (current) closeChat(); });

// ---------- Live updates ----------
function connectSocket() {
  socket = io();
  socket.on('chats', (list) => { chats = list; renderChats(); });
  socket.on('message', ({ jid, message }) => {
    if (current && current.jid === jid) {
      appendMessage(message);
      api(`/api/chats/${encodeURIComponent(jid)}/messages`).catch(() => {}); // mark read
    }
  });
  // Reload data when coming back to the app (phone may have slept)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    chats = await api('/api/chats').catch(() => chats);
    renderChats();
    if (current) openChat(current, true);
  });
}

// ---------- Chat list ----------
function previewText(m) {
  if (!m) return '';
  const base = m.type === 'text' ? m.text : `${MEDIA_LABELS[m.type] || ''} ${m.text || ''}`;
  const who = m.fromMe ? 'את/ה: ' : (m.senderName && m.sender ? m.senderName + ': ' : '');
  return who + base;
}

function renderChats() {
  const list = $('chatList');
  list.innerHTML = '';
  if (!chats.length) {
    list.append(el('div', { class: 'empty' }, 'עדיין אין צ\'אטים. בקש מההורים להוסיף אנשי קשר.'));
    return;
  }
  for (const c of chats) {
    const unread = current && current.jid === c.jid ? 0 : c.unread;
    list.append(el('div', {
      class: 'chat-item' + (current?.jid === c.jid ? ' active' : '') + (unread ? ' has-unread' : ''),
      onclick: () => openChat(c),
    },
      avatar(c.isGroup),
      el('div', { class: 'chat-meta' },
        el('div', { class: 'chat-name' }, el('span', {}, c.name), el('small', {}, fmtTime(c.lastMessage?.timestamp))),
        el('div', { class: 'chat-preview' },
          el('span', {}, previewText(c.lastMessage)),
          unread ? el('span', { class: 'badge' }, String(unread)) : null),
      )));
  }
}

// ---------- Conversation ----------
function openChatByJid(jid) {
  const c = chats.find((x) => x.jid === jid);
  if (c) openChat(c);
}

async function openChat(c, refreshOnly = false) {
  const wasOpen = current?.jid === c.jid;
  current = c;
  if (!refreshOnly) {
    $('placeholder').classList.add('hidden');
    $('chatView').classList.remove('hidden');
    $('app').classList.add('in-chat');
    $('chatTitle').textContent = c.name;
    $('chatSubtitle').textContent = c.isGroup ? 'קבוצה' : '';
    $('chatAvatar').replaceWith(Object.assign(avatar(c.isGroup), { id: 'chatAvatar' }));
    if (!wasOpen && !history.state?.chat) history.pushState({ chat: c.jid }, '', '?chat=' + encodeURIComponent(c.jid));
  }
  const msgs = await api(`/api/chats/${encodeURIComponent(c.jid)}/messages`);
  $('messages').innerHTML = '';
  lastRendered = null;
  msgs.forEach(appendMessage);
  c.unread = 0;
  renderChats();
  if (!refreshOnly && window.innerWidth > 760) $('msgInput').focus();
}

function appendMessage(m) {
  const box = $('messages');
  const day = dayLabel(m.timestamp);
  if (!lastRendered || dayLabel(lastRendered.timestamp) !== day) {
    box.append(el('div', { class: 'day' }, day));
    lastRendered = null;
  }
  const first = !lastRendered || lastRendered.fromMe !== m.fromMe || lastRendered.sender !== m.sender;
  const body = [];
  if (current.isGroup && !m.fromMe && first && m.senderName) {
    const who = el('div', { class: 'who' }, m.senderName);
    who.style.color = senderColor(m.sender);
    body.push(who);
  }
  if (m.type === 'image' || m.type === 'sticker') {
    body.push(el('img', { src: `/api/media/${encodeURIComponent(current.jid)}/${encodeURIComponent(m.id)}`, alt: '', loading: 'lazy' }));
  } else if (m.type !== 'text') {
    body.push(el('div', { class: 'media-label' }, MEDIA_LABELS[m.type] || m.type));
  }
  if (m.text) body.push(el('span', {}, m.text));
  const meta = el('span', { class: 'meta' }, clock(m.timestamp));
  if (m.fromMe) {
    const t = el('span'); t.innerHTML = TICK_SVG; meta.append(t);
  }
  body.push(meta);
  const cls = ['bubble', m.fromMe ? 'mine' : '', first ? 'first' : '', m.type === 'sticker' ? 'sticker' : ''].filter(Boolean).join(' ');
  box.append(el('div', { class: cls }, ...body));
  lastRendered = m;
  box.scrollTop = box.scrollHeight;
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('msgInput').value.trim();
  if (!text || !current) return;
  $('msgInput').value = '';
  $('msgInput').focus();
  try {
    await api(`/api/chats/${encodeURIComponent(current.jid)}/messages`, { method: 'POST', body: { text } });
  } catch (err) {
    alert('ההודעה לא נשלחה: ' + err.message);
    $('msgInput').value = text;
  }
});

// ---------- Notifications ----------
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribePush(reg) {
  const { key } = await api('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
}

async function setupNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const reg = await navigator.serviceWorker.register('/sw.js');
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-chat' && e.data.jid) openChatByJid(e.data.jid);
  });
  const banner = $('notifBanner');
  if (Notification.permission === 'granted') {
    subscribePush(reg).catch((e) => console.warn('push subscribe failed', e));
  } else if (Notification.permission === 'default') {
    banner.classList.remove('hidden');
    banner.onclick = async () => {
      const perm = await Notification.requestPermission();
      banner.classList.add('hidden');
      if (perm === 'granted') await subscribePush(reg).catch((e) => alert('הפעלת ההתראות נכשלה: ' + e.message));
    };
  }
}

start();
