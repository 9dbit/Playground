'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=path.join(root,'audit-results');
const reportPath=path.join(out,'CP13_BACKEND_AUDIT.json');
const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
const files=report.sourceHashes.map(x=>x.file);
const extra='engine/security-crypto.js';
const bytes=fs.readFileSync(path.join(root,extra));
const actual=crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
assert.equal(actual,'20c96b183646c722593f5fab0144f934c3d993d5');
fs.writeFileSync(path.join(out,'inspected-source',extra),bytes);
report.sourceHashes.push({file:extra,blob:actual});files.push(extra);
const rows=[];
for(const file of files){
 const text=fs.readFileSync(path.join(root,file),'utf8');
 // Require a complete string literal followed by a comma. '/assets/' + filename
 // is not a route literal and must not produce a false duplicate finding.
 for(const m of text.matchAll(/app\.(get|post|put|patch|delete)\((['"])([^'"]+)\2\s*,/g)){
  rows.push({file,method:m[1].toUpperCase(),path:m[3],line:text.slice(0,m.index).split('\n').length});
 }
}
const groups=new Map();
for(const r of rows){const key=r.method+' '+r.path.replace(/:[^/]+/g,':param');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
const duplicates=[...groups.entries()].filter(([,r])=>r.length>1).map(([route,registrations])=>({route,registrations}));
report.routeInventory={mode:'static_complete_string_literals',literalRegistrations:rows.length,
 note:'Excludes generated asset paths and the bridge PATH constant. Duplicate registration is a candidate; game-log shadowing was separately reproduced over HTTP.',duplicateGroups:duplicates};
fs.writeFileSync(path.join(out,'route-inventory.json'),JSON.stringify({routes:rows,...report.routeInventory},null,2));
fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
console.log('CP13_SOURCE_INVENTORY '+JSON.stringify({inspectedBackendFiles:files.length,literalRegistrations:rows.length,duplicateGroups:duplicates.length}));
