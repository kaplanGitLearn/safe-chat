// Tiny JSON-file storage. Only messages from approved chats are ever saved.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MESSAGES_PER_CHAT = 500;
let dir, configPath, messagesPath;
let config, messages, raw = {}, unread = {}, blocked = {};
let saveTimer = null;

function init(dataDir) {
  dir = dataDir;
  fs.mkdirSync(dir, { recursive: true });
  configPath = path.join(dir, 'config.json');
  messagesPath = path.join(dir, 'messages.json');

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
  messages = fs.existsSync(messagesPath) ? JSON.parse(fs.readFileSync(messagesPath, 'utf8')) : {};
}

function writeConfig() {
  const { _generated, ...toSave } = config;
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), { mode: 0o600 });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(messagesPath, JSON.stringify(messages)), 1000);
}

const getConfig = () => config;
function updateConfig(fn) { fn(config); writeConfig(); }

function addMessage(jid, m, rawMsg) {
  const list = (messages[jid] ||= []);
  if (list.some((x) => x.id === m.id)) return;
  list.push(m);
  if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
  if (m.type !== 'text') (raw[jid] ||= {})[m.id] = rawMsg; // kept in memory for media download
  if (!m.fromMe) unread[jid] = (unread[jid] || 0) + 1;
  scheduleSave();
}

const getMessages = (jid) => messages[jid] || [];
const getRaw = (jid, id) => raw[jid]?.[id];
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
  init, getConfig, updateConfig, addMessage, getMessages, getRaw,
  getUnread, markRead, addBlocked, getBlocked, removeBlocked,
};
