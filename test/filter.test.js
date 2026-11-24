const test = require('node:test');
const assert = require('node:assert');
const { isAllowed, phoneToJid, describeMessage } = require('../lib/filter');

const cfg = {
  allowedContacts: [{ jid: '972541234567@s.whatsapp.net', name: 'Mom' }],
  allowedGroups: [{ jid: '12345-678@g.us', name: 'Class' }],
};

test('allowed contact and group pass', () => {
  assert.ok(isAllowed('972541234567@s.whatsapp.net', cfg));
  assert.ok(isAllowed('12345-678@g.us', cfg));
});

test('everything else is blocked', () => {
  assert.ok(!isAllowed('972500000000@s.whatsapp.net', cfg));
  assert.ok(!isAllowed('99999@g.us', cfg));
  assert.ok(!isAllowed('status@broadcast', cfg));
  assert.ok(!isAllowed('123@newsletter', cfg));
  assert.ok(!isAllowed('', cfg));
});

test('phone normalization', () => {
  assert.strictEqual(phoneToJid('054-123-4567'), '972541234567@s.whatsapp.net');
  assert.strictEqual(phoneToJid('+972 54 123 4567'), '972541234567@s.whatsapp.net');
  assert.strictEqual(phoneToJid('00972541234567'), '972541234567@s.whatsapp.net');
  assert.strictEqual(phoneToJid('abc'), null);
});

test('describeMessage handles text and images', () => {
  const base = { key: { id: '1', fromMe: false }, messageTimestamp: 1700000000, pushName: 'Dan' };
  assert.strictEqual(describeMessage({ ...base, message: { conversation: 'hi' } }).text, 'hi');
  const img = describeMessage({ ...base, message: { imageMessage: { caption: 'look' } } });
  assert.strictEqual(img.type, 'image');
  assert.strictEqual(describeMessage({ ...base, message: { reactionMessage: {} } }), null);
});

test('LID chats map back to approved phone numbers', () => {
  const { resolveChatJid } = require('../lib/filter');
  const c = { allowedContacts: [{ jid: '972541234567@s.whatsapp.net', lid: '111222@lid' }], allowedGroups: [] };
  // WhatsApp sent the phone number alongside the LID
  assert.strictEqual(resolveChatJid({ remoteJid: '999@lid', senderPn: '972541234567@s.whatsapp.net' }, c), '972541234567@s.whatsapp.net');
  // Only the LID, but we learned it earlier
  assert.strictEqual(resolveChatJid({ remoteJid: '111222@lid' }, c), '972541234567@s.whatsapp.net');
  // Unknown LID stays as-is and is blocked
  assert.strictEqual(resolveChatJid({ remoteJid: '555@lid' }, c), '555@lid');
  assert.ok(!isAllowed('555@lid', c));
  assert.ok(isAllowed('111222@lid', c));
  // Normal phone-number chats are untouched
  assert.strictEqual(resolveChatJid({ remoteJid: '972541234567@s.whatsapp.net' }, c), '972541234567@s.whatsapp.net');
});
