// A pretend WhatsApp connection for local development and tests (SAFECHAT_FAKE_WA=1).
// It answers the calls SafeChat makes and echoes sent messages back the way Baileys does.
const { EventEmitter } = require('events');
const crypto = require('crypto');

const ME = '972500000000@s.whatsapp.net';

function makeFakeSocket() {
  const ev = new EventEmitter();
  const now = () => Math.floor(Date.now() / 1000);
  const newId = () => 'FAKE' + crypto.randomBytes(6).toString('hex').toUpperCase();

  function build(jid, content, options = {}) {
    let message;
    if (content.react) message = { reactionMessage: content.react };
    else if (content.delete) message = { protocolMessage: { type: 0, key: content.delete } };
    else if (content.forward) {
      const src = content.forward.message || {};
      const text = src.conversation ?? src.extendedTextMessage?.text;
      message = text !== undefined
        ? { extendedTextMessage: { text, contextInfo: { isForwarded: true, forwardingScore: 1 } } }
        : JSON.parse(JSON.stringify(src));
    } else if (options.quoted) {
      const q = options.quoted;
      message = { extendedTextMessage: { text: content.text, contextInfo: {
        stanzaId: q.key.id, participant: q.key.fromMe ? ME : (q.key.participant || q.key.remoteJid), quotedMessage: q.message,
      } } };
    } else message = { conversation: content.text };
    return { key: { remoteJid: jid, id: newId(), fromMe: true }, message, messageTimestamp: now() };
  }

  const sock = {
    ev,
    user: { id: ME, name: 'Fake' },
    signalRepository: { lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => null } },
    async sendMessage(jid, content, options) {
      const msg = build(jid, content, options);
      setTimeout(() => ev.emit('messages.upsert', { messages: [msg], type: 'append' }), 50);
      return msg;
    },
    async onWhatsApp(jid) { return [{ jid, exists: true }]; },
    async rejectCall() {},
    async groupFetchAllParticipating() { return { '120363000000000001@g.us': { id: '120363000000000001@g.us', subject: 'קבוצת בדיקה', participants: [{}, {}] } }; },
    async logout() {},
    updateMediaMessage: async (m) => m,
    // Simulate something arriving from another phone.
    incoming(jid, message, extra = {}) {
      const msg = { key: { remoteJid: jid, id: newId(), fromMe: false, ...extra.key }, message, messageTimestamp: now(), pushName: extra.pushName || 'בודק' };
      ev.emit('messages.upsert', { messages: [msg], type: 'notify' });
      return msg;
    },
  };
  sock.ev.on = ev.on.bind(ev);
  setTimeout(() => ev.emit('connection.update', { connection: 'open' }), 100);
  return sock;
}

module.exports = { makeFakeSocket };
