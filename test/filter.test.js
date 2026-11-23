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
