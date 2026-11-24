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
