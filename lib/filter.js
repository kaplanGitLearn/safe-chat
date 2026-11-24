// The core rule: a chat is visible only if the parent approved it.

function isAllowed(jid, cfg) {
  if (!jid) return false;
  if (jid.endsWith('@g.us')) return cfg.allowedGroups.some((g) => g.jid === jid);
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) {
    return cfg.allowedContacts.some((c) => c.jid === jid || c.lid === jid);
  }
  return false; // broadcasts, newsletters/channels, status, etc. are always blocked
}

// WhatsApp may identify a 1:1 chat by a hidden "LID" (…@lid) instead of the phone number.
// Map it back to the phone-number JID when we can, so the allowlist matches.
function resolveChatJid(key, cfg) {
  const remote = key.remoteJid || '';
  if (!remote.endsWith('@lid')) return remote;
  const pn = key.senderPn || key.remoteJidAlt || cfg.allowedContacts.find((c) => c.lid === remote)?.jid;
  return pn && pn.endsWith('@s.whatsapp.net') ? pn : remote;
}

// "054-123-4567" / "+972541234567" -> "972541234567@s.whatsapp.net"
function phoneToJid(phone, defaultCountry = process.env.DEFAULT_COUNTRY_CODE || '972') {
  let digits = String(phone || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = defaultCountry + digits.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return null;
  return `${digits}@s.whatsapp.net`;
}

// Convert a raw WhatsApp message into the small shape the UI needs.
function describeMessage(msg) {
  let m = msg.message;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (!m) return null;

  let type = 'text';
  let text = '';
  if (m.conversation) text = m.conversation;
  else if (m.extendedTextMessage) text = m.extendedTextMessage.text;
  else if (m.imageMessage) { type = 'image'; text = m.imageMessage.caption || ''; }
  else if (m.videoMessage) { type = 'video'; text = m.videoMessage.caption || ''; }
  else if (m.audioMessage) { type = 'audio'; }
  else if (m.stickerMessage) { type = 'sticker'; }
  else if (m.documentMessage) { type = 'document'; text = m.documentMessage.fileName || ''; }
  else if (m.locationMessage) { type = 'location'; }
  else if (m.contactMessage) { type = 'contact'; text = m.contactMessage.displayName || ''; }
  else return null; // reactions, protocol messages, polls etc. are ignored

  const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || Math.floor(Date.now() / 1000);
  return {
    id: msg.key.id,
    fromMe: !!msg.key.fromMe,
    sender: msg.key.participant || null,
    senderName: msg.pushName || '',
    type,
    text,
    timestamp: ts,
  };
}

module.exports = { isAllowed, resolveChatJid, phoneToJid, describeMessage };
