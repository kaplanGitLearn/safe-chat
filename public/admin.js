const $ = (id) => document.getElementById(id);
let config = { allowedContacts: [], allowedGroups: [] };

async function start() {
  const { role } = await api('/api/me');
  if (role !== 'parent') { $('login').classList.remove('hidden'); return; }
  $('login').classList.add('hidden');
  $('panel').classList.remove('hidden');
  await Promise.all([refreshStatus(), refreshConfig(), refreshBlocked()]);
  io().on('status', refreshStatus);
  setInterval(refreshStatus, 15000);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: { role: 'parent', password: $('pw').value } });
    start();
  } catch (err) { $('loginError').textContent = err.message; }
});
$('logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };

const STATUS_TEXT = { open: 'מחובר', qr: 'ממתין לסריקת קוד QR', connecting: 'מתחבר...', closed: 'מנותק, מנסה שוב...' };

async function refreshStatus() {
  const s = await api('/api/admin/status');
  const label = STATUS_TEXT[s.connection] || s.connection;
  $('status').innerHTML = '';
  $('status').append(el('span', { class: 'status ' + (s.connection === 'open' ? 'open' : 'other') }, label),
    s.me ? el('span', { class: 'hint' }, '  ' + s.me.id.split(':')[0].split('@')[0]) : '');
  $('qrBox').classList.toggle('hidden', !s.qr);
  if (s.qr) $('qr').src = s.qr;
}

async function refreshConfig() {
  config = await api('/api/admin/config');
  const list = (items, type) => items.length
    ? items.map((x) => el('div', { class: 'list-item' },
        el('div', {}, x.name, el('small', {}, x.jid.split('@')[0])),
        el('button', { class: 'danger', onclick: () => removeItem(type, x.jid) }, 'הסרה')))
    : [el('p', { class: 'hint' }, 'אין עדיין')];
  $('contacts').replaceChildren(...list(config.allowedContacts, 'contacts'));
  $('groups').replaceChildren(...list(config.allowedGroups, 'groups'));
}

async function removeItem(type, jid) {
  if (!confirm('להסיר?')) return;
  await api(`/api/admin/${type}/${encodeURIComponent(jid)}`, { method: 'DELETE' });
  refreshConfig();
}

async function addContact(phone, name) {
  await api('/api/admin/contacts', { method: 'POST', body: { phone, name } });
  await Promise.all([refreshConfig(), refreshBlocked()]);
}

async function addGroup(jid, name) {
  await api('/api/admin/groups', { method: 'POST', body: { jid, name } });
  await Promise.all([refreshConfig(), refreshBlocked()]);
}

$('contactForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await addContact($('cPhone').value, $('cName').value);
    $('cPhone').value = ''; $('cName').value = '';
  } catch (err) { alert(err.message); }
});

$('loadGroupsBtn').onclick = async () => {
  try {
    const groups = await api('/api/admin/groups');
    const approved = new Set(config.allowedGroups.map((g) => g.jid));
    $('allGroups').replaceChildren(...groups.map((g) => el('div', { class: 'list-item' },
      el('div', {}, g.name, el('small', {}, `${g.size} משתתפים`)),
      approved.has(g.jid)
        ? el('span', { class: 'hint' }, 'מאושרת ✓')
        : el('button', { onclick: () => addGroup(g.jid, g.name).then(() => $('loadGroupsBtn').click()) }, 'אישור'))));
  } catch (err) { alert(err.message); }
};

async function refreshBlocked() {
  const items = await api('/api/admin/blocked');
  $('blocked').replaceChildren(...(items.length ? items.map((b) => {
    const isGroup = b.jid.endsWith('@g.us');
    const label = (b.name || '') + (isGroup ? ' (קבוצה)' : '');
    return el('div', { class: 'list-item' },
      el('div', {}, label || b.jid.split('@')[0], el('small', {}, `${b.jid.split('@')[0]} · ${b.count} הודעות`)),
      el('button', { class: 'secondary', onclick: () => isGroup
        ? addGroup(b.jid, b.name || b.jid)
        : addContact('+' + b.jid.split('@')[0], b.name) }, 'אישור'));
  }) : [el('p', { class: 'hint' }, 'אין')]));
}
$('loadBlockedBtn').onclick = refreshBlocked;

$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/admin/passwords', { method: 'POST', body: { parentPassword: $('newParent').value, childPin: $('newPin').value } });
  $('newParent').value = ''; $('newPin').value = '';
  alert('נשמר');
});

$('unlinkBtn').onclick = async () => {
  if (!confirm('לנתק את המכשיר המקושר? יהיה צורך לסרוק QR מחדש.')) return;
  await api('/api/admin/logout-whatsapp', { method: 'POST' });
  setTimeout(refreshStatus, 3000);
};

start();
