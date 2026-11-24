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

// Remove the wrappers WhatsApp puts around some messages (disappearing, view-once, ...).
function unwrap(m) {
  for (let i = 0; m && i < 5; i++) {
    const inner = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension
      || m.documentWithCaptionMessage || m.editedMessage;
    if (!inner?.message) break;
    m = inner.message;
  }
  return m;
}

// The type and visible text of a message body (also used for quoted messages).
function contentOf(m) {
  if (!m) return null;
  if (m.conversation) return { type: 'text', text: m.conversation };
  if (m.extendedTextMessage) return { type: 'text', text: m.extendedTextMessage.text || '' };
  if (m.imageMessage) return { type: 'image', text: m.imageMessage.caption || '' };
  if (m.videoMessage) return { type: 'video', text: m.videoMessage.caption || '' };
  if (m.audioMessage) return { type: 'audio', text: '' };
  if (m.stickerMessage) return { type: 'sticker', text: '' };
  if (m.documentMessage) return { type: 'document', text: m.documentMessage.fileName || '' };
  if (m.locationMessage) return { type: 'location', text: '' };
  if (m.contactMessage) return { type: 'contact', text: m.contactMessage.displayName || '' };
  return null; // reactions, protocol messages, polls etc. are handled elsewhere or ignored
}

function contextInfoOf(m) {
  for (const v of Object.values(m || {})) if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  return null;
}

// Convert a raw WhatsApp message into the small shape the UI needs.
function describeMessage(msg) {
  const m = unwrap(msg.message);
  const content = contentOf(m);
  if (!content) return null;

  const ctx = contextInfoOf(m);
  let quoted = null;
  if (ctx?.stanzaId && ctx.quotedMessage) {
    const q = contentOf(unwrap(ctx.quotedMessage)) || { type: 'text', text: '' };
    quoted = { id: ctx.stanzaId, sender: ctx.participant || null, type: q.type, text: q.text };
  }

  const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || Math.floor(Date.now() / 1000);
  return {
    id: msg.key.id,
    fromMe: !!msg.key.fromMe,
    sender: msg.key.participant || null,
    senderName: msg.pushName || '',
    type: content.type,
    text: content.text,
    timestamp: ts,
    ...(quoted ? { quoted } : {}),
    ...(ctx?.isForwarded ? { forwarded: true } : {}),
  };
}

module.exports = { isAllowed, resolveChatJid, phoneToJid, describeMessage, unwrap, contentOf };
