const $ = (id) => document.getElementById(id);
let chats = [];
let current = null;
let socket = null;

async function start() {
  const { role } = await api('/api/me');
  if (role !== 'child') return showLogin();
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  chats = await api('/api/chats');
  renderChats();
  connectSocket();
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

$('logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
$('backBtn').onclick = () => { current = null; $('app').classList.remove('in-chat'); renderChats(); };

function connectSocket() {
  socket = io();
  socket.on('chats', (list) => { chats = list; renderChats(); });
  socket.on('message', ({ jid, message }) => {
    if (current && current.jid === jid) {
      appendMessage(message);
      api(`/api/chats/${encodeURIComponent(jid)}/messages`).catch(() => {}); // mark read
    }
  });
}

function previewText(m) {
  if (!m) return '';
  const base = m.type === 'text' ? m.text : `${MEDIA_LABELS[m.type] || ''} ${m.text || ''}`;
  return (m.fromMe ? 'את/ה: ' : '') + base;
}

function renderChats() {
  const list = $('chatList');
  list.innerHTML = '';
  if (!chats.length) {
    list.append(el('div', { class: 'empty' }, 'עדיין אין צ\'אטים מאושרים'));
    return;
  }
  for (const c of chats) {
    const unread = current && current.jid === c.jid ? 0 : c.unread;
    list.append(el('div', {
      class: 'chat-item' + (current?.jid === c.jid ? ' active' : ''),
      onclick: () => openChat(c),
    },
      el('div', { class: 'avatar' }, c.isGroup ? '👥' : initials(c.name)),
      el('div', { class: 'chat-meta' },
        el('div', { class: 'chat-name' }, el('span', {}, c.name), el('small', {}, fmtTime(c.lastMessage?.timestamp))),
        el('div', { class: 'chat-preview' },
          el('span', {}, previewText(c.lastMessage)),
          unread ? el('span', { class: 'badge' }, String(unread)) : null),
      )));
  }
}

async function openChat(c) {
  current = c;
  $('placeholder').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  $('app').classList.add('in-chat');
  $('chatTitle').textContent = c.name;
  $('chatAvatar').textContent = c.isGroup ? '👥' : initials(c.name);
  $('messages').innerHTML = '';
  const msgs = await api(`/api/chats/${encodeURIComponent(c.jid)}/messages`);
  msgs.forEach(appendMessage);
  c.unread = 0;
  renderChats();
  $('msgInput').focus();
}

function appendMessage(m) {
  const box = $('messages');
  const body = [];
  if (current.isGroup && !m.fromMe && m.senderName) body.push(el('div', { class: 'who' }, m.senderName));
  if (m.type === 'image' || m.type === 'sticker') {
    body.push(el('img', { src: `/api/media/${encodeURIComponent(current.jid)}/${encodeURIComponent(m.id)}`, alt: '', loading: 'lazy' }));
  } else if (m.type !== 'text') {
    body.push(el('div', { class: 'media-label' }, MEDIA_LABELS[m.type] || m.type));
  }
  if (m.text) body.push(el('div', {}, m.text));
  body.push(el('div', { class: 'time' }, fmtTime(m.timestamp)));
  box.append(el('div', { class: 'bubble' + (m.fromMe ? ' mine' : '') }, ...body));
  box.scrollTop = box.scrollHeight;
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('msgInput').value.trim();
  if (!text || !current) return;
  $('msgInput').value = '';
  try {
    await api(`/api/chats/${encodeURIComponent(current.jid)}/messages`, { method: 'POST', body: { text } });
  } catch (err) {
    alert('ההודעה לא נשלחה: ' + err.message);
    $('msgInput').value = text;
  }
});

start();
