// Tiny JSON-file storage. Only messages from approved chats are ever saved.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BufferJSON } = require('@whiskeysockets/baileys');

const MAX_MESSAGES_PER_CHAT = 500;
let dir, configPath, messagesPath, rawPath;
let config, messages, raw = {}, unread = {}, blocked = {};
let saveTimer = null;

function init(dataDir) {
  dir = dataDir;
  fs.mkdirSync(dir, { recursive: true });
  configPath = path.join(dir, 'config.json');
  messagesPath = path.join(dir, 'messages.json');
  rawPath = path.join(dir, 'raw.json');

  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config._generated;
  } else {
    config = {
      parentPassword: process.env.PARENT_PASSWORD || crypto.randomBytes(6).toString('base64url'),
      childPin: process.env.CHILD_PIN || String(crypto.randomInt(1000, 10000)),
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      allowedContacts: [],
      allowedGroups: [],
    };
    writeConfig();
    config._generated = true;
  }
  // Web Push keys (added later than the rest of the config, so fill them in on upgrade)
  if (!config.vapid) {
    config.vapid = require('web-push').generateVAPIDKeys();
    config.pushSubscriptions = [];
    writeConfig();
  }
  messages = readJson(messagesPath, {});
  raw = readJson(rawPath, {}, BufferJSON.reviver);
}

function readJson(file, fallback, reviver) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'), reviver) : fallback;
  } catch (e) {
    console.error(`could not read ${file}:`, e.message);
    return fallback;
  }
}

function writeConfig() {
  const { _generated, ...toSave } = config;
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), { mode: 0o600 });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(messagesPath, JSON.stringify(messages));
    fs.writeFileSync(rawPath, JSON.stringify(raw, BufferJSON.replacer));
  }, 1000);
}

const getConfig = () => config;
function updateConfig(fn) { fn(config); writeConfig(); }

// Returns false when the message is already stored (duplicate event).
function addMessage(jid, m, rawMsg) {
  const list = (messages[jid] ||= []);
  if (list.some((x) => x.id === m.id)) return false;
  list.push(m);
  if (list.length > MAX_MESSAGES_PER_CHAT) {
    for (const old of list.splice(0, list.length - MAX_MESSAGES_PER_CHAT)) delete raw[jid]?.[old.id];
  }
  // The original WhatsApp message is kept for media download, forwarding and replies.
  if (rawMsg?.message) (raw[jid] ||= {})[m.id] = { key: rawMsg.key, message: rawMsg.message, messageTimestamp: rawMsg.messageTimestamp };
  if (!m.fromMe) unread[jid] = (unread[jid] || 0) + 1;
  scheduleSave();
  return true;
}

const getMessages = (jid) => messages[jid] || [];
const getMessage = (jid, id) => (messages[jid] || []).find((x) => x.id === id);
const getRaw = (jid, id) => raw[jid]?.[id];

// Apply a change to one stored message; returns the updated message (or null if not found).
function updateMessage(jid, id, fn) {
  const m = getMessage(jid, id);
  if (!m) return null;
  fn(m);
  scheduleSave();
  return m;
}

function removeMessage(jid, id) {
  const list = messages[jid] || [];
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  delete raw[jid]?.[id];
  scheduleSave();
  return true;
}

function getStarred() {
  const out = [];
  for (const [jid, list] of Object.entries(messages)) {
    for (const m of list) if (m.starred && !m.deleted) out.push({ jid, message: m });
  }
  return out.sort((a, b) => b.message.timestamp - a.message.timestamp);
}

const getUnread = (jid) => unread[jid] || 0;
const markRead = (jid) => { unread[jid] = 0; };

function addBlocked(jid, name) {
  const b = (blocked[jid] ||= { jid, name: '', count: 0 });
  b.count++;
  b.last = Date.now();
  if (name) b.name = name;
}
const getBlocked = () => Object.values(blocked).sort((a, b) => b.last - a.last);
const removeBlocked = (jid) => { delete blocked[jid]; };

function addSubscription(sub) {
  updateConfig((c) => {
    c.pushSubscriptions = (c.pushSubscriptions || []).filter((x) => x.endpoint !== sub.endpoint);
    c.pushSubscriptions.push(sub);
  });
}
function removeSubscription(endpoint) {
  updateConfig((c) => { c.pushSubscriptions = (c.pushSubscriptions || []).filter((x) => x.endpoint !== endpoint); });
}

module.exports = {
  addSubscription, removeSubscription,
  init, getConfig, updateConfig, addMessage, getMessages, getMessage, getRaw,
  updateMessage, removeMessage, getStarred,
  getUnread, markRead, addBlocked, getBlocked, removeBlocked,
};
