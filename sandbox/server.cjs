'use strict';
// Isolated static UI simulator: no production modules, credentials, database or API proxy.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const routes=new Map([
 ['/', ['index.html','text/html; charset=utf-8']],['/engine',['index.html','text/html; charset=utf-8']],['/login',['index.html','text/html; charset=utf-8']],
 ['/assets/control.js',['control.js','application/javascript; charset=utf-8']],['/assets/control.css',['control.css','text/css; charset=utf-8']],
 ['/assets/fixtures.js',['fixtures.js','application/javascript; charset=utf-8']],['/assets/sandbox.css',['sandbox.css','text/css; charset=utf-8']],
 ['/assets/parity.css',['parity.css','text/css; charset=utf-8']],
 ['/assets/admin-ops.css',['admin-ops.css','text/css; charset=utf-8']]
]);
function sandboxCopy(source){return source.replaceAll('PostgreSQL','browser fixtures')
 .replace('Overview from persistent database. Integrations are not yet connected.','Synthetic browser data only. No production connections.')
 .replace('Data backed by browser fixtures unless marked otherwise','SIMULATION ONLY: edits stay in this browser tab')
 .replace('Published page/policy content is available at /info/{slug}.','Publishing is simulated in this browser tab.')
 .replace('This is published at /robots.txt.','Robots.txt configuration is simulated.')
 .replace('Maintenance applies to published information pages only.','Maintenance is simulated; no real website is affected.')
 .replaceAll('Playground Control Center','Playground UI Sandbox')
 .replace('<a class="btn ghost" href="/security">Change Password / MFA</a>','<span class="btn ghost" title="No real account in sandbox">Security unavailable in sandbox</span>')
 .replace('src="\'+apiBase+\'deep/games/\'+E(id)+\'/image?at=\'+Date.now()+\'"','src="\'+E(g.image||\'\')+\'"');}
const forbidden=['DATABASE_URL','SESSION_SECRET','GAMEOPS_BRIDGE_KEYS','GAMEOPS_BRIDGE_SECRET','ADMIN_PASSWORD','DEV_ACCESS_KEY_SHA256'];
function createServer(){
 if(forbidden.some(key=>process.env[key]))throw Error('Sandbox must not receive production credentials');
 return http.createServer((req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end('Read-only static sandbox');return;}
  let p;try{p=new URL(req.url,'http://sandbox.invalid').pathname;}catch{res.writeHead(400);res.end('Invalid URL');return;}
  if(p==='/health'){res.setHeader('Content-Type','application/json');res.end(req.method==='HEAD'?'':JSON.stringify({status:'ok',mode:'isolated-ui-sandbox',version:'sandbox-1.2.0',productionConnected:false,apiEnabled:false}));return;}
  if(p==='/robots.txt'){res.setHeader('Content-Type','text/plain');res.end('User-agent: *\nDisallow: /\n');return;}
  const entry=routes.get(p);if(!entry){res.writeHead(404);res.end('Not found. No API, authentication or database is exposed by this simulator.');return;}
  let bytes=fs.readFileSync(path.join(__dirname,'public',entry[0]));if(entry[0]==='control.js')bytes=Buffer.from(sandboxCopy(bytes.toString('utf8')));
  res.setHeader('Content-Type',entry[1]);res.setHeader('Content-Length',bytes.length);res.end(req.method==='HEAD'?undefined:bytes);
 });
}
if(require.main===module){const s=createServer();s.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Isolated UI sandbox ready; no production connections'));process.once('SIGTERM',()=>s.close());}
module.exports={createServer};
