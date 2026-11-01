'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../engine/security-crypto');
const { canAccess } = require('../engine/security-policy');
const { publicAccount } = require('../engine/security');
test('password hashes use independent salts and never store cleartext', async () => {
 const password='A long synthetic test password';
 const [a,b]=await Promise.all([C.passwordHash(password),C.passwordHash(password)]);
 assert.notEqual(a,b);assert.ok(a.startsWith('scrypt$32768$8$3$'));
 assert.equal(a.includes(password),false);assert.equal(await C.passwordVerify(password,a),true);
 assert.equal(await C.passwordVerify('Wrong synthetic password',a),false);
});
test('password bounds are enforced without truncation',async()=>{
 assert.equal(C.passwordValid('x'.repeat(14)),false);assert.equal(C.passwordValid('x'.repeat(129)),false);
 await assert.rejects(C.passwordHash('short'));assert.equal(await C.passwordVerify('x'.repeat(129),'garbage'),false);
 assert.equal(C.passwordValid('different words with spaces'),true);
});
test('unrecognized hash formats and hostile work factors are rejected',async()=>{
 assert.equal(await C.passwordVerify('password','plaintext'),false);
 assert.equal(await C.passwordVerify('password','scrypt$999999999$8$3$'+ 'a'.repeat(32)+'$'+'b'.repeat(128)),false);
});
test('base32 encoding round-trips random 20-byte MFA secrets',()=>{
 for(let i=0;i<20;i++){const b=crypto.randomBytes(20);assert.deepEqual(C.fromBase32(C.base32(b)),b)}
});
const rfcSecret=C.base32(Buffer.from('12345678901234567890'));
for(const [seconds,expected] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']]){
 test('RFC 6238 SHA1 test vector at '+seconds,()=>assert.equal(C.totp(rfcSecret,Math.floor(seconds/30),8),expected));
}
test('TOTP verification rejects reused steps and malformed or old codes',()=>{
 const now=1234567890000,step=Math.floor(now/30000),code=C.totp(rfcSecret,step);
 assert.equal(C.matchTotp(rfcSecret,code,-1,now),step);
 assert.equal(C.matchTotp(rfcSecret,code,step,now),null);
 assert.equal(C.matchTotp(rfcSecret,'abcdef',-1,now),null);
 assert.equal(C.matchTotp(rfcSecret,C.totp(rfcSecret,step-3),-1,now),null);
 assert.equal(C.matchTotp(rfcSecret,C.totp(rfcSecret,step+1),step,now),step+1);
});
test('MFA encryption authenticates ciphertext and account identity',()=>{
 const vault=C.encryption('test master secret, not a production key'.repeat(2)),s=C.base32(crypto.randomBytes(20));
 const box=vault.seal(s,'account-a');assert.equal(vault.open(box,'account-a'),s);
 assert.equal(box.includes(s),false);assert.throws(()=>vault.open(box,'account-b'));
 const parts=box.split('.');const b=Buffer.from(parts[3],'base64url');b[0]^=1;parts[3]=b.toString('base64url');
 assert.throws(()=>vault.open(parts.join('.'),'account-a'));
});
test('recovery codes have 128 bits of random input and account-scoped hashes',()=>{
 const codes=C.recoveryCodes();assert.equal(codes.length,8);assert.equal(new Set(codes).size,8);
 for(const code of codes)assert.match(code,/^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/);
 const master='synthetic-test-master';assert.equal(C.recoveryHash(master,'a',codes[0]),C.recoveryHash(master,'a',codes[0].replaceAll('-','').toLowerCase()));
 assert.notEqual(C.recoveryHash(master,'a',codes[0]),C.recoveryHash(master,'b',codes[0]));
});
test('Viewer and Support cannot escalate through legacy or deep endpoints',()=>{
 for(const role of ['viewer','support']){
  assert.equal(canAccess(role,'POST','/games'),false);
  assert.equal(canAccess(role,'PUT','/deep/games/some-id'),false);
  assert.equal(canAccess(role,'PATCH','/requests/id'),false);
  assert.equal(canAccess(role,'PUT','/settings/general'),false);
 }
 assert.equal(canAccess('support','POST','/deep/tickets/id/replies'),true);
 assert.equal(canAccess('viewer','GET','/players'),false);
 assert.equal(canAccess('viewer','GET','/summary'),true);
});
test('Operator can edit game and content, not identity security or request approvals',()=>{
 assert.equal(canAccess('operator','PUT','/deep/games/id'),true);
 assert.equal(canAccess('operator','POST','/deep/content/page'),true);
 assert.equal(canAccess('operator','POST','/tickets'),false);
 assert.equal(canAccess('operator','GET','/deep/reports/logins'),false);
 assert.equal(canAccess('operator','PATCH','/requests/id'),false);
});
test('unknown API paths and methods fail closed even for Owner',()=>{
 for(const role of ['owner','operator','support','viewer','admin','']){
  assert.equal(canAccess(role,'POST','/future-dangerous-route'),false);
  assert.equal(canAccess(role,'DELETE','/games/id'),false);
 }
 assert.equal(canAccess('owner','GET','/deep/games/id/rounds'),true);
 assert.equal(canAccess('viewer','HEAD','/summary'),true);
});
test('account presentation does not expose authentication secrets',()=>{
 const a=publicAccount({id:'id',username:'owner',display_name:'Owner',role:'owner',status:'active',mfa_enabled:true,must_change_password:false,password_hash:'secret',mfa_secret:'encrypted',raw:'token',recovery_hashes:['private']});
 assert.equal(a.setupRequired,false);
 for(const key of ['password_hash','mfa_secret','raw','recovery_hashes'])assert.equal(key in a,false);
});
