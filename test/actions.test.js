// End-to-end test of message actions against a pretend WhatsApp (SAFECHAT_FAKE_WA=1).
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const B = `http://localhost:${PORT}`;
let cookie = '';
let server;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safechat-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    parentPassword: 'parent123', childPin: '1234', sessionSecret: 'x'.repeat(64),
    allowedContacts: [{ jid: '972541111111@s.whatsapp.net', name: 'אמא' }, { jid: '972542222222@s.whatsapp.net', name: 'סבתא' }],
    allowedGroups: [{ jid: '1-2@g.us', name: 'כיתה' }],
  }));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, SAFECHAT_FAKE_WA: '1', DATA_DIR: dir, PORT: String(PORT) }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(B + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  await new Promise((r) => setTimeout(r, 300)); // let the pretend WhatsApp "connect"
});
test.after(() => server?.kill());

test('child message actions', async () => {
  const j=(o)=>JSON.stringify(o);
  async function call(method,path,body){const r=await fetch(B+path,{method,headers:{'Content-Type':'application/json',cookie},body:body&&j(body)});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];const t=await r.text();try{return {s:r.status,b:JSON.parse(t)}}catch{return {s:r.status,b:t}}}
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const MOM='972541111111@s.whatsapp.net', GRAN='972542222222@s.whatsapp.net', STRANGER='972549999999@s.whatsapp.net';
  const msgs=async(jid)=>(await call('GET',`/api/chats/${encodeURIComponent(jid)}/messages`)).b;
  const ok=(c,label)=>assert.ok(c,label);
    await call('POST','/api/login',{role:'child',password:'1234'});
    const inc=(await call('POST','/api/dev/incoming',{jid:MOM,message:{conversation:'שלום מאמא'},pushName:'אמא'})).b;
    await call('POST','/api/dev/incoming',{jid:STRANGER,message:{conversation:'זר'}});
    await sleep(150);
    let m=await msgs(MOM); ok(m.length===1&&m[0].text==='שלום מאמא','incoming from approved contact stored');
    ok((await call('GET',`/api/chats/${encodeURIComponent(STRANGER)}/messages`)).s===403,'stranger chat forbidden');
    // reply
    await call('POST',`/api/chats/${encodeURIComponent(MOM)}/messages`,{text:'תשובה',replyTo:inc.key.id}); await sleep(150);
    m=await msgs(MOM); const reply=m.find(x=>x.text==='תשובה'); ok(reply&&reply.quoted&&reply.quoted.id===inc.key.id&&reply.quoted.fromMe===false,'reply quotes original');
    ok(m.filter(x=>x.text==='תשובה').length===1,'sent message not duplicated by echo');
    // react
    await call('POST',`/api/chats/${encodeURIComponent(MOM)}/messages/${inc.key.id}/react`,{emoji:'❤️'}); await sleep(150);
    m=await msgs(MOM); ok(m[0].reactions&&m[0].reactions.me==='❤️','own reaction applied');
    await call('POST','/api/dev/incoming',{jid:MOM,message:{reactionMessage:{key:{remoteJid:MOM,id:reply.id,fromMe:true},text:'👍'}}}); await sleep(150);
    m=await msgs(MOM); ok(m.find(x=>x.id===reply.id).reactions?.[MOM]==='👍','incoming reaction applied');
    // star
    await call('POST',`/api/chats/${encodeURIComponent(MOM)}/messages/${inc.key.id}/star`,{starred:true});
    const st=(await call('GET','/api/starred')).b; ok(st.length===1&&st[0].message.id===inc.key.id,'starred list');
    // forward to grandma and to stranger (stranger must be dropped)
    let r=await call('POST',`/api/chats/${encodeURIComponent(MOM)}/messages/${inc.key.id}/forward`,{to:[GRAN,STRANGER]}); await sleep(150);
    const g=await msgs(GRAN); ok(r.s===200&&g.length===1&&g[0].forwarded&&g[0].text==='שלום מאמא','forward to approved chat, marked forwarded');
    r=await call('POST',`/api/chats/${encodeURIComponent(MOM)}/messages/${inc.key.id}/forward`,{to:[STRANGER]}); ok(r.s===400,'forward to unapproved chat refused');
    // delete for everyone: not allowed on someone else's message
    r=await call('DELETE',`/api/chats/${encodeURIComponent(MOM)}/messages/${inc.key.id}?everyone=1`); ok(r.s===403,'cannot delete others\' message for everyone');
    r=await call('DELETE',`/api/chats/${encodeURIComponent(MOM)}/messages/${reply.id}?everyone=1`); await sleep(150);
    m=await msgs(MOM); ok(m.find(x=>x.id===reply.id).deleted===true,'own message deleted for everyone');
    // incoming revoke + edit
    const e2=(await call('POST','/api/dev/incoming',{jid:MOM,message:{conversation:'טעות'}})).b; await sleep(100);
    await call('POST','/api/dev/incoming',{jid:MOM,message:{protocolMessage:{type:14,key:{remoteJid:MOM,id:e2.key.id},editedMessage:{conversation:'מתוקן'}}}}); await sleep(150);
    m=await msgs(MOM); let e=m.find(x=>x.id===e2.key.id); ok(e.text==='מתוקן'&&e.edited,'incoming edit applied');
    await call('POST','/api/dev/incoming',{jid:MOM,message:{protocolMessage:{type:0,key:{remoteJid:MOM,id:e2.key.id}}}}); await sleep(150);
    m=await msgs(MOM); ok(m.find(x=>x.id===e2.key.id).deleted,'incoming delete-for-everyone applied');
    // delete for me
    await call('DELETE',`/api/chats/${encodeURIComponent(MOM)}/messages/${e2.key.id}`); m=await msgs(MOM); ok(!m.find(x=>x.id===e2.key.id),'delete for me removes it');
    // calls
    await call('POST','/api/dev/incoming',{jid:MOM,call:{video:false}}); await call('POST','/api/dev/incoming',{jid:STRANGER,call:{}}); await sleep(150);
    m=await msgs(MOM); ok(m.some(x=>x.type==='call'),'missed call from approved contact shown');
    // reaction in unapproved chat is ignored (no crash)
    await call('POST','/api/dev/incoming',{jid:STRANGER,message:{reactionMessage:{key:{id:'x'},text:'👍'}}});
    void ('chats:',(await call('GET','/api/chats')).b.map(c=>c.name+':'+(c.lastMessage?.type||'-')).join(', '));
});

test('child sends a photo and a voice message', async () => {
  const ffmpeg = require('ffmpeg-static');
  const { execFileSync } = require('node:child_process');
  const make = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args, 'pipe:1'], { maxBuffer: 1 << 24 });
  // What Chrome's recorder produces (webm/opus), and a small JPEG photo.
  const webm = make(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libopus', '-f', 'webm']);
  const jpeg = make(['-f', 'lavfi', '-i', 'color=c=red:s=320x240', '-frames:v', '1', '-f', 'mjpeg']);
  const MOM = '972541111111@s.whatsapp.net';
  const STRANGER = '972549999999@s.whatsapp.net';
  const up = (jid, query, type, body) => fetch(`${B}/api/chats/${encodeURIComponent(jid)}/media?${query}`, { method: 'POST', headers: { 'Content-Type': type, cookie }, body });

  let r = await up(MOM, 'kind=image&caption=' + encodeURIComponent('תמונה מהטיול'), 'image/jpeg', jpeg);
  assert.strictEqual(r.status, 200, 'photo upload');
  r = await up(MOM, 'kind=voice&seconds=3', 'audio/webm;codecs=opus', webm);
  assert.strictEqual(r.status, 200, 'voice upload: ' + (await r.text()));
  assert.strictEqual((await up(STRANGER, 'kind=image', 'image/jpeg', jpeg)).status, 403, 'no sending to unapproved chats');
  assert.strictEqual((await up(MOM, 'kind=image', 'text/html', Buffer.from('<b>x</b>'))).status, 400, 'only real image types');

  await new Promise((res) => setTimeout(res, 200));
  const msgs = await (await fetch(`${B}/api/chats/${encodeURIComponent(MOM)}/messages`, { headers: { cookie } })).json();
  const photo = msgs.find((m) => m.type === 'image' && m.fromMe);
  const voice = msgs.find((m) => m.type === 'audio' && m.fromMe);
  assert.ok(photo && photo.text === 'תמונה מהטיול', 'photo stored with caption');
  assert.ok(voice && voice.ptt && voice.seconds === 3, 'voice note stored with length');
  assert.strictEqual(msgs.filter((m) => m.type === 'audio').length, 1, 'voice note not duplicated');

  const img = await fetch(`${B}/api/media/${encodeURIComponent(MOM)}/${photo.id}`, { headers: { cookie } });
  assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
  const ogg = Buffer.from(await (await fetch(`${B}/api/media/${encodeURIComponent(MOM)}/${voice.id}`, { headers: { cookie } })).arrayBuffer());
  assert.strictEqual(ogg.subarray(0, 4).toString(), 'OggS', 'voice converted to ogg for WhatsApp');
  const part = await fetch(`${B}/api/media/${encodeURIComponent(MOM)}/${voice.id}`, { headers: { cookie, range: 'bytes=0-99' } });
  assert.strictEqual(part.status, 206, 'range requests for the audio player');
  assert.strictEqual((await part.arrayBuffer()).byteLength, 100);
});

