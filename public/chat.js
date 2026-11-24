const $ = (id) => document.getElementById(id);
let chats = [];
let current = null;        // open chat
let msgs = [];             // messages of the open chat
let selected = new Set();  // ids of selected messages
let replyTo = null;        // message being replied to
let socket = null;
let ignoreNextPop = false;

const PERSON_SVG = '<svg viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-10 2.67-10 6v4h20v-4c0-3.33-4.67-6-10-6z"/></svg>';
const GROUP_SVG = '<svg viewBox="0 0 24 24"><path d="M16 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm-8 0a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm0 2c-2.7 0-8 1.34-8 4v3h16v-3c0-2.66-5.3-4-8-4zm8 0c-.29 0-.62.02-.97.05C16.19 13.9 17 15.04 17 17v3h7v-3c0-2.66-5.3-4-8-4z"/></svg>';
const TICK_SVG = '<svg viewBox="0 0 16 11"><path d="M11.07.65 4.2 7.52 1.43 4.75.36 5.82 4.2 9.66l7.94-7.94z"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
const BLOCK_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.9-6.31L5.69 16.9A7.9 7.9 0 0 1 4 12zm8 8a7.9 7.9 0 0 1-4.9-1.69L18.31 7.1A8 8 0 0 1 12 20z"/></svg>';
const FWD_SVG = '<svg viewBox="0 0 24 24" class="flip"><path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>';
const CALL_SVG = '<svg viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>';
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const SENDER_COLORS = ['#e542a3', '#1f7aec', '#d3396d', '#7f66ff', '#029d00', '#fa6533', '#c4532d', '#a62c71', '#3bb5a2', '#8b7add'];
MEDIA_LABELS.call = '📞';

const svgEl = (html) => { const s = document.createElement('span'); s.innerHTML = html; return s.firstChild; };
const enc = encodeURIComponent;

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
const bodyText = (m) => (m.type === 'text' || m.type === 'call' ? m.text : [MEDIA_LABELS[m.type], m.text].filter(Boolean).join(' '));

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 2000);
}

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

// ---------- Main menu ----------
$('menuBtn').onclick = (e) => { e.stopPropagation(); $('mainMenu').classList.toggle('hidden'); };
document.addEventListener('click', () => $('mainMenu').classList.add('hidden'));
$('logoutBtn').onclick = async () => {
  if (!confirm('לצאת מהחשבון?')) return;
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
};
$('starredBtn').onclick = () => openStarred(false);

// ---------- Navigation (Android back button closes things instead of leaving the app) ----------
function showPane(name) {
  $('placeholder').classList.toggle('hidden', name !== 'placeholder');
  $('chatView').classList.toggle('hidden', name !== 'chat');
  $('starredView').classList.toggle('hidden', name !== 'starred');
  $('app').classList.toggle('in-chat', name !== 'placeholder');
}

function closeChat() {
  stopRecording(false);
  playingAudio?.pause();
  current = null;
  clearSelection(true);
  setReply(null);
  showPane('placeholder');
  history.replaceState(null, '', '/');
  renderChats();
}

function goBack() {
  if (history.state?.pane) history.back();
  else closeChat();
}
$('backBtn').onclick = goBack;
$('starredBack').onclick = goBack;

window.addEventListener('popstate', () => {
  if (ignoreNextPop) { ignoreNextPop = false; return; }
  if (!$('modal').classList.contains('hidden')) { closeModal(); return; }
  if (selected.size) { clearSelection(true); return; }
  if (history.state?.pane === 'starred') { openStarred(true); return; }
  if (current || !$('starredView').classList.contains('hidden')) closeChat();
});

// ---------- Live updates ----------
function connectSocket() {
  socket = io();
  socket.on('chats', (list) => { chats = list; renderChats(); });
  socket.on('message', ({ jid, message }) => {
    if (current?.jid !== jid) return;
    if (msgs.some((m) => m.id === message.id)) return;
    msgs.push(message);
    renderMessages(true);
    api(`/api/chats/${enc(jid)}/messages`).catch(() => {}); // mark read
  });
  socket.on('message-update', ({ jid, message }) => {
    if (current?.jid !== jid) return;
    const i = msgs.findIndex((m) => m.id === message.id);
    if (i >= 0) { msgs[i] = message; renderMessages(false); }
  });
  socket.on('message-removed', ({ jid, id }) => {
    if (current?.jid !== jid) return;
    msgs = msgs.filter((m) => m.id !== id);
    selected.delete(id);
    renderMessages(false);
    updateSelectionUI();
  });
  // Reload data when coming back to the app (phone may have slept)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    chats = await api('/api/chats').catch(() => chats);
    renderChats();
    if (current) loadMessages(false);
  });
}

// ---------- Chat list ----------
function previewText(m) {
  if (!m) return '';
  if (m.deleted) return '🚫 ההודעה נמחקה';
  const who = m.fromMe ? 'את/ה: ' : (m.senderName && m.sender ? m.senderName + ': ' : '');
  return who + (m.type === 'call' ? '📞 ' : '') + bodyText(m);
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
function openChatByJid(jid, focusId) {
  const c = chats.find((x) => x.jid === jid);
  if (c) openChat(c, focusId);
}

async function openChat(c, focusId) {
  const fromStarred = !$('starredView').classList.contains('hidden');
  if (current?.jid !== c.jid) { clearSelection(true); setReply(null); }
  current = c;
  showPane('chat');
  $('chatTitle').textContent = c.name;
  $('chatSubtitle').textContent = c.isGroup ? 'קבוצה' : '';
  $('chatAvatar').replaceWith(Object.assign(avatar(c.isGroup), { id: 'chatAvatar' }));
  // A regular phone call (the child's SIM) - WhatsApp calls aren't possible through SafeChat.
  const phone = !c.isGroup && c.jid.endsWith('@s.whatsapp.net') ? c.jid.split('@')[0] : null;
  $('callBtn').classList.toggle('hidden', !phone);
  if (phone) $('callBtn').href = 'tel:+' + phone;
  if (fromStarred) history.replaceState({ pane: 'chat', chat: c.jid }, '', '?chat=' + enc(c.jid));
  else if (history.state?.pane !== 'chat') history.pushState({ pane: 'chat', chat: c.jid }, '', '?chat=' + enc(c.jid));
  await loadMessages(true);
  c.unread = 0;
  renderChats();
  if (focusId) jumpTo(focusId);
  else if (window.innerWidth > 760) $('msgInput').focus();
}

async function loadMessages(scrollToEnd) {
  msgs = await api(`/api/chats/${enc(current.jid)}/messages`);
  renderMessages(scrollToEnd);
}

function quoteName(q) {
  if (q.fromMe) return 'את/ה';
  return q.senderName || (current.isGroup ? 'משתתף' : current.name);
}

function buildQuote(q, onclick) {
  const box = el('div', { class: 'quote', ...(onclick ? { onclick } : {}) },
    el('b', {}, quoteName(q)),
    el('span', {}, bodyText(q) || '…'));
  box.style.setProperty('--qcolor', q.fromMe ? 'var(--accent)' : senderColor(q.sender || current.jid));
  return box;
}

function buildBubble(m, first) {
  const body = [];
  if (current.isGroup && !m.fromMe && first && m.senderName) {
    const who = el('div', { class: 'who' }, m.senderName);
    who.style.color = senderColor(m.sender);
    body.push(who);
  }
  if (m.deleted) {
    body.push(el('span', { class: 'deleted' }, svgEl(BLOCK_SVG), m.fromMe ? 'מחקת את ההודעה הזו' : 'ההודעה הזו נמחקה'));
  } else {
    if (m.forwarded) body.push(el('div', { class: 'fwd-label' }, svgEl(FWD_SVG), 'הועברה'));
    if (m.quoted) body.push(buildQuote(m.quoted, (e) => { e.stopPropagation(); if (!selected.size) jumpTo(m.quoted.id); }));
    if (m.type === 'call') {
      body.push(el('span', { class: 'call-line' }, svgEl(CALL_SVG), m.text));
    } else {
      const src = `/api/media/${enc(current.jid)}/${enc(m.id)}`;
      if (m.type === 'image' || m.type === 'sticker') {
        body.push(el('img', { src, alt: '', loading: 'lazy' }));
      } else if (m.type === 'audio') {
        body.push(buildAudio(src, m));
      } else if (m.type === 'video') {
        body.push(el('video', { src, controls: '', preload: 'metadata', playsinline: '' }));
      } else if (m.type !== 'text') {
        body.push(el('div', { class: 'media-label' }, MEDIA_LABELS[m.type] || m.type));
      }
      if (m.text) body.push(el('span', { class: 'text', dir: 'auto' }, m.text));
    }
  }
  const meta = el('span', { class: 'meta' });
  if (m.starred) meta.append(svgEl(STAR_SVG));
  if (m.edited && !m.deleted) meta.append(el('span', {}, 'נערכה'));
  meta.append(clock(m.timestamp));
  if (m.fromMe && !m.deleted && m.type !== 'call') meta.append(svgEl(TICK_SVG));
  body.push(meta);

  const reactions = Object.values(m.reactions || {});
  if (reactions.length && !m.deleted) {
    const uniq = [...new Set(reactions)];
    body.push(el('div', { class: 'reactions' }, uniq.join('') + (reactions.length > 1 ? ' ' + reactions.length : '')));
  }

  const cls = ['bubble', m.fromMe ? 'mine' : '', first ? 'first' : '', m.type === 'sticker' && !m.deleted ? 'sticker' : '',
    reactions.length && !m.deleted ? 'has-reactions' : '', selected.has(m.id) ? 'selected' : ''].filter(Boolean).join(' ');
  const bubble = el('div', { class: cls, 'data-id': m.id }, ...body);
  attachPressHandlers(bubble, m);
  // The row spans the full width so a selected message is highlighted edge to edge, like WhatsApp.
  return el('div', { class: 'row' + (m.fromMe ? ' mine' : '') + (selected.has(m.id) ? ' selected' : ''), 'data-id': m.id }, bubble);
}

function renderMessages(scrollToEnd) {
  const box = $('messages');
  const keep = box.scrollTop;
  box.innerHTML = '';
  let prev = null;
  for (const m of msgs) {
    const day = dayLabel(m.timestamp);
    if (!prev || dayLabel(prev.timestamp) !== day) {
      box.append(el('div', { class: 'day' }, day));
      prev = null;
    }
    const first = !prev || prev.fromMe !== m.fromMe || prev.sender !== m.sender || prev.type === 'call' || m.type === 'call';
    box.append(buildBubble(m, first));
    prev = m;
  }
  box.scrollTop = scrollToEnd ? box.scrollHeight : keep;
  positionReactBar();
}

function jumpTo(id) {
  const row = $('messages').querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (!row) return toast('ההודעה המקורית לא נמצאה');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1500);
}

// ---------- Selecting messages (long press / right click) ----------
// Long press selects. Android may also fire its own "contextmenu" for the same press, and the
// click that ends a long press must not toggle again, so each press is handled at most once.
let press = { handled: false };
function longPress(id) {
  if (press.handled) return;
  press.handled = true;
  toggleSelect(id);
  navigator.vibrate?.(20);
}

function attachPressHandlers(node, m) {
  let timer = null;
  let startX = 0, startY = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.addEventListener('pointerdown', (e) => {
    press = { handled: false };
    if (e.button > 0) return;
    startX = e.clientX; startY = e.clientY;
    timer = setTimeout(() => { timer = null; longPress(m.id); }, 450);
  });
  node.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel(); });
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); longPress(m.id); });
  node.addEventListener('click', () => {
    if (press.handled) return; // the click that ends a long press
    if (selected.size) toggleSelect(m.id);
  });
}

function toggleSelect(id) {
  const wasEmpty = !selected.size;
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  if (wasEmpty && selected.size) history.pushState({ ...history.state, sel: true }, '', location.href);
  if (!selected.size && history.state?.sel) { ignoreNextPop = true; history.back(); }
  renderMessages(false);
  updateSelectionUI();
}

function clearSelection(fromPop) {
  if (!selected.size) return;
  selected.clear();
  if (!fromPop && history.state?.sel) { ignoreNextPop = true; history.back(); }
  if (current) renderMessages(false);
  updateSelectionUI();
}

const selectedMsgs = () => msgs.filter((m) => selected.has(m.id));

function updateSelectionUI() {
  const sel = selectedMsgs();
  const active = sel.length > 0;
  $('selBar').classList.toggle('hidden', !active);
  $('selCount').textContent = active ? String(sel.length) : '';
  const usable = sel.filter((m) => !m.deleted && m.type !== 'call');
  $('actReply').classList.toggle('hidden', !(sel.length === 1 && usable.length === 1));
  $('actForward').classList.toggle('hidden', !(active && usable.length === sel.length));
  $('actCopy').classList.toggle('hidden', !usable.some((m) => m.text));
  $('actStar').classList.toggle('hidden', !usable.length);
  $('actStar').classList.toggle('on', usable.length > 0 && usable.every((m) => m.starred));
  positionReactBar();
}
$('selClose').onclick = () => clearSelection();

function positionReactBar() {
  const bar = $('reactBar');
  const sel = selectedMsgs();
  const m = sel.length === 1 ? sel[0] : null;
  const node = m && $('messages').querySelector(`.bubble[data-id="${CSS.escape(m.id)}"]`);
  if (!m || !node || m.deleted || m.type === 'call') { bar.classList.add('hidden'); return; }
  const mine = m.reactions?.me;
  bar.replaceChildren(...REACTIONS.map((e) => el('button', {
    class: e === mine ? 'on' : '',
    onclick: () => react(m, e === mine ? '' : e),
  }, e)));
  bar.classList.remove('hidden');
  const r = node.getBoundingClientRect();
  const box = $('messages').getBoundingClientRect();
  const top = Math.max(box.top + 6, r.top - bar.offsetHeight - 8);
  let left = (m.fromMe ? r.left : r.right - bar.offsetWidth);
  left = Math.min(Math.max(8, left), window.innerWidth - bar.offsetWidth - 8);
  bar.style.top = top + 'px';
  bar.style.left = left + 'px';
}
$('messages').addEventListener('scroll', () => { if (selected.size) positionReactBar(); });
window.addEventListener('resize', positionReactBar);

async function react(m, emoji) {
  try {
    await api(`/api/chats/${enc(current.jid)}/messages/${enc(m.id)}/react`, { method: 'POST', body: { emoji } });
    clearSelection();
  } catch (err) { toast('התגובה לא נשלחה: ' + err.message); }
}

// ---------- Actions ----------
$('actReply').onclick = () => {
  const [m] = selectedMsgs();
  clearSelection();
  setReply(m);
  $('msgInput').focus();
};

function setReply(m) {
  replyTo = m || null;
  $('replyPreview').classList.toggle('hidden', !m);
  if (!m) return;
  $('replyName').textContent = m.fromMe ? 'את/ה' : (m.senderName || current.name);
  $('replyText').textContent = bodyText(m);
  $('replyPreview').querySelector('.quote').style.setProperty('--qcolor', m.fromMe ? 'var(--accent)' : senderColor(m.sender || current.jid));
}
$('replyCancel').onclick = () => setReply(null);

$('actCopy').onclick = async () => {
  const text = selectedMsgs().filter((m) => m.text && !m.deleted).map((m) => m.text).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(selected.size > 1 ? 'ההודעות הועתקו' : 'ההודעה הועתקה');
  } catch (_) { toast('ההעתקה נכשלה'); }
  clearSelection();
};

$('actStar').onclick = async () => {
  const sel = selectedMsgs().filter((m) => !m.deleted && m.type !== 'call');
  const starred = !sel.every((m) => m.starred);
  const jid = current.jid;
  clearSelection();
  for (const m of sel) {
    await api(`/api/chats/${enc(jid)}/messages/${enc(m.id)}/star`, { method: 'POST', body: { starred } }).catch(() => {});
  }
  toast(starred ? 'סומן בכוכב' : 'הסימון בכוכב הוסר');
};

$('actDelete').onclick = () => {
  const sel = selectedMsgs();
  const twoDays = 2 * 24 * 3600;
  const canEveryone = sel.every((m) => m.fromMe && !m.deleted && m.type !== 'call' && Date.now() / 1000 - m.timestamp < twoDays);
  const jid = current.jid;
  const run = async (everyone) => {
    closeModal();
    clearSelection();
    for (const m of sel) {
      try {
        await api(`/api/chats/${enc(jid)}/messages/${enc(m.id)}${everyone ? '?everyone=1' : ''}`, { method: 'DELETE' });
      } catch (err) { toast('המחיקה נכשלה: ' + err.message); break; }
    }
  };
  openModal(sel.length > 1 ? `למחוק ${sel.length} הודעות?` : 'למחוק את ההודעה?', null, [
    ...(canEveryone ? [{ text: 'מחיקה לכולם', onclick: () => run(true) }] : []),
    { text: 'מחיקה אצלי', onclick: () => run(false) },
    { text: 'ביטול', onclick: closeModal },
  ]);
};

$('actForward').onclick = () => {
  const sel = selectedMsgs();
  const from = current.jid;
  const chosen = new Set();
  const sendBtn = { text: 'שליחה', onclick: async () => {
    if (!chosen.size) return toast('בחר לפחות צ\'אט אחד');
    closeModal();
    clearSelection();
    try {
      for (const m of sel) {
        await api(`/api/chats/${enc(from)}/messages/${enc(m.id)}/forward`, { method: 'POST', body: { to: [...chosen] } });
      }
      toast('ההודעה הועברה');
    } catch (err) { toast('ההעברה נכשלה: ' + err.message); }
  } };
  const list = el('div', { class: 'pick-list' }, ...chats.map((c) => {
    const box = el('input', { type: 'checkbox' });
    box.addEventListener('change', () => { if (box.checked) chosen.add(c.jid); else chosen.delete(c.jid); });
    return el('label', { class: 'pick-item' }, avatar(c.isGroup), el('span', {}, c.name), box);
  }));
  openModal('העברה אל…', list, [{ text: 'ביטול', onclick: closeModal }, sendBtn]);
};

// ---------- Dialog ----------
function openModal(title, bodyNode, buttons) {
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren(...(bodyNode ? [bodyNode] : []));
  $('modalButtons').replaceChildren(...buttons.map((b) => el('button', { class: 'link-btn', onclick: b.onclick }, b.text)));
  $('modal').classList.remove('hidden');
  $('reactBar').classList.add('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); positionReactBar(); }
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

// ---------- Starred messages ----------
async function openStarred(fromPop) {
  $('mainMenu').classList.add('hidden');
  clearSelection(true);
  current = null;
  showPane('starred');
  if (!fromPop) history.pushState({ pane: 'starred' }, '', '/');
  renderChats();
  const items = await api('/api/starred');
  const list = $('starredList');
  if (!items.length) {
    list.replaceChildren(el('div', { class: 'empty' }, 'אין הודעות מסומנות בכוכב.', el('br'), 'לחיצה ארוכה על הודעה ← ⭐ כדי לסמן.'));
    return;
  }
  list.replaceChildren(...items.map(({ jid, message: m }) => {
    const chat = chats.find((c) => c.jid === jid);
    // "sender ◂ chat", like WhatsApp; in a private chat the other person is the chat itself.
    const who = m.fromMe ? 'את/ה' : chat?.isGroup ? (m.senderName || 'משתתף') : '';
    const head = [who, chat?.name].filter(Boolean).join(' ◂ ');
    return el('div', { class: 'starred-item', onclick: () => openChatByJid(jid, m.id) },
      el('div', { class: 'starred-head' }, el('b', {}, head), el('small', {}, fmtTime(m.timestamp))),
      el('div', { class: 'bubble ' + (m.fromMe ? 'mine' : '') }, el('span', { dir: 'auto' }, bodyText(m)), el('span', { class: 'meta' }, svgEl(STAR_SVG), clock(m.timestamp))));
  }));
}

// ---------- Sending ----------
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('msgInput').value.trim();
  if (!text || !current) return;
  const reply = replyTo;
  $('msgInput').value = '';
  updateComposerButtons();
  setReply(null);
  $('msgInput').focus();
  try {
    await api(`/api/chats/${enc(current.jid)}/messages`, { method: 'POST', body: { text, replyTo: reply?.id } });
  } catch (err) {
    alert('ההודעה לא נשלחה: ' + err.message);
    $('msgInput').value = text;
    updateComposerButtons();
    setReply(reply);
  }
});

// ---------- Voice message player ----------
const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
const MIC_SVG = '<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
const fmtDur = (sec) => { sec = Math.max(0, Math.round(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
let playingAudio = null;

function buildAudio(src, m) {
  const audio = new Audio();
  audio.preload = 'none';
  const btn = el('button', { type: 'button', class: 'play-btn', 'aria-label': 'ניגון' });
  btn.innerHTML = PLAY_SVG;
  const bar = el('input', { type: 'range', min: '0', max: '1000', value: '0', class: 'audio-bar', 'aria-label': 'מיקום' });
  const time = el('span', { class: 'audio-time' }, fmtDur(m.seconds));
  const icon = svgEl(MIC_SVG);
  const wrap = el('div', { class: 'audio' + (m.ptt ? ' ptt' : '') }, btn, el('div', { class: 'audio-track' }, bar, time), m.ptt ? el('span', { class: 'audio-mic' }, icon) : null);
  const dur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : m.seconds || 0);
  btn.addEventListener('click', (e) => {
    if (selected.size) return; // tapping while selecting toggles the selection instead
    e.stopPropagation();
    if (!audio.src) audio.src = src;
    if (audio.paused) {
      if (playingAudio && playingAudio !== audio) playingAudio.pause();
      playingAudio = audio;
      audio.play().catch(() => toast('לא ניתן לנגן את ההודעה'));
    } else audio.pause();
  });
  audio.addEventListener('play', () => { btn.innerHTML = PAUSE_SVG; });
  audio.addEventListener('pause', () => { btn.innerHTML = PLAY_SVG; });
  audio.addEventListener('ended', () => { btn.innerHTML = PLAY_SVG; bar.value = 0; time.textContent = fmtDur(dur()); });
  audio.addEventListener('timeupdate', () => {
    const d = dur();
    if (d) bar.value = String(Math.round((audio.currentTime / d) * 1000));
    time.textContent = fmtDur(audio.currentTime || d);
  });
  bar.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't start a long press while scrubbing
  bar.addEventListener('input', () => {
    if (!audio.src) audio.src = src;
    const d = dur();
    if (d) audio.currentTime = (Number(bar.value) / 1000) * d;
  });
  return wrap;
}

// ---------- Composer: send button vs. microphone ----------
function updateComposerButtons() {
  const hasText = $('msgInput').value.trim().length > 0;
  $('sendBtn').classList.toggle('hidden', !hasText);
  $('micBtn').classList.toggle('hidden', hasText);
}
$('msgInput').addEventListener('input', updateComposerButtons);

async function uploadMedia(kind, blob, extra = {}) {
  const jid = current.jid;
  const params = new URLSearchParams({ kind, ...extra });
  if (replyTo) params.set('replyTo', replyTo.id);
  setReply(null);
  toast(kind === 'voice' ? 'שולח הודעה קולית…' : 'שולח תמונה…');
  const res = await fetch(`/api/chats/${enc(jid)}/media?${params}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
}

// ---------- Photos ----------
$('attachBtn').onclick = () => $('fileInput').click();

// Shrink big camera photos before sending (faster, and WhatsApp compresses them anyway).
async function prepareImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

$('fileInput').addEventListener('change', async () => {
  const file = $('fileInput').files[0];
  $('fileInput').value = '';
  if (!file || !current) return;
  let blob;
  try { blob = await prepareImage(file); } catch (_) { return toast('לא ניתן לפתוח את התמונה'); }
  const url = URL.createObjectURL(blob);
  const caption = el('input', { placeholder: 'הוספת כיתוב…', dir: 'auto', class: 'caption-input' });
  const body = el('div', { class: 'image-preview' }, el('img', { src: url, alt: '' }), caption);
  const send = async () => {
    closeModal();
    URL.revokeObjectURL(url);
    try { await uploadMedia('image', blob, { caption: caption.value.trim() }); }
    catch (err) { alert('התמונה לא נשלחה: ' + err.message); }
  };
  caption.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  openModal('שליחת תמונה אל ' + current.name, body, [
    { text: 'ביטול', onclick: () => { closeModal(); URL.revokeObjectURL(url); } },
    { text: 'שליחה', onclick: send },
  ]);
});

// ---------- Voice messages ----------
const MAX_RECORDING_SEC = 300;
let rec = null; // { recorder, stream, chunks, started, timer, send }

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('המכשיר לא תומך בהקלטה');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (_) {
    return alert('אין הרשאה למיקרופון. צריך לאשר גישה למיקרופון בהגדרות של Chrome.');
  }
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  rec = { recorder, stream, chunks: [], started: Date.now(), send: false, jid: current.jid };
  recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  recorder.onstop = async () => {
    const r = rec;
    rec = null;
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    showRecorder(false);
    const seconds = (Date.now() - r.started) / 1000;
    if (!r.send) return;
    if (seconds < 1) return toast('ההקלטה קצרה מדי');
    const blob = new Blob(r.chunks, { type: recorder.mimeType || 'audio/webm' });
    if (current?.jid !== r.jid) return;
    try { await uploadMedia('voice', blob, { seconds: String(Math.round(seconds)) }); }
    catch (err) { alert('ההודעה הקולית לא נשלחה: ' + err.message); }
  };
  recorder.start(250);
  showRecorder(true);
  navigator.vibrate?.(30);
  $('recTime').textContent = '0:00';
  rec.timer = setInterval(() => {
    const sec = (Date.now() - rec.started) / 1000;
    $('recTime').textContent = fmtDur(sec);
    if (sec >= MAX_RECORDING_SEC) stopRecording(true);
  }, 250);
}

function stopRecording(send) {
  if (!rec) return;
  rec.send = send;
  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
}

function showRecorder(on) {
  $('composer').classList.toggle('hidden', on);
  $('recorder').classList.toggle('hidden', !on);
}

$('micBtn').onclick = startRecording;
$('recSend').onclick = () => stopRecording(true);
$('recCancel').onclick = () => stopRecording(false);

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
