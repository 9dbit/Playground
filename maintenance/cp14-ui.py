from pathlib import Path
import subprocess
ROOT=Path.cwd()
BASE='3e9dad5f010aa830ba4930d1d85cd793c25deb2c'
def original(f):return subprocess.check_output(['git','show',BASE+':'+f],cwd=ROOT,text=True)
def rep(s,a,b):
 if s.count(a)!=1:raise Exception('Expected unique '+a[:100]+' '+str(s.count(a)))
 return s.replace(a,b)
s=original('public/control.js')
assert (ROOT/'public/control.js').read_text()==s,'UI source drift'
s=rep(s,"Playground · Engine v0.7<br>Source: Checkpoint 06 audit","Playground · Engine v0.14<br>CP14 backend repairs")
s=rep(s,"const data=await r.json().catch(()=>({error:'Invalid server response'}));if(!r.ok)throw Error(data.error||'Request failed');return data}","const data=await r.json().catch(()=>({error:'Invalid server response'}));if(!r.ok){const error=Error(data.error||'Request failed');error.status=r.status;error.code=data.code;throw error}return data}")
s=rep(s,"async function players(state){","async function players(state,page=1){")
s=rep(s,"const q=await api(apiBase+'deep/players?state='+encodeURIComponent(state||'all'));","const pageNumber=/^[1-9][0-9]*$/.test(String(page))?Math.min(10000,Number(page)):1;\n const q=await api(apiBase+'deep/players?state='+encodeURIComponent(state||'all')+'&page='+pageNumber+'&limit=25');")
a="table(['Player','Game','Rounds','Local Status','Last Seen','Detail'],q.items.map(x=>[link(x.player_ref,'player/'+x.id),E(x.game),n(x.rounds),badge(x.local_status),fmt(x.last_seen),link('Details →','player/'+x.id)]));"
s=rep(s,a,a[:-1]+"+pageControls(q,next=>'players/'+(state||'all')+'/'+next);")
s=rep(s,"if(a==='players')return players(b||'all');","if(a==='players')return players(b||'all',c||1);")
s=rep(s,"'<form id=\"setting-save\" class=\"panel\" data-key=\"'+E(key)+'\"><h2>Configuration</h2>'+formFields(fields)+","(record?.validationErrors?.length?notice('Existing configuration needs correction: '+record.validationErrors.join('; '),'warn'):'')+\n '<form id=\"setting-save\" class=\"panel\" data-key=\"'+E(key)+'\" data-version=\"'+E(record?.version??0)+'\"><h2>Configuration</h2>'+formFields(fields)+")
a="if(form.id==='setting-save'){await api(apiBase+'settings/'+form.dataset.key,'PUT',{value:v});toast('Settings saved');if(form.dataset.key==='general')applyTheme(v);return render()}"
b="if(form.id==='setting-save'){\n   for(const name of ['per_page','interval_minutes'])if(name in v)v[name]=Number(v[name]);\n   await api(apiBase+'settings/'+form.dataset.key,'PUT',{value:v,expected_version:Number(form.dataset.version)});\n   toast('Settings saved with version check');if(form.dataset.key==='general')applyTheme(v);return render()}"
s=rep(s,a,b)
a=" }catch(err){toast('Save error: '+err.message)}\n});"
b=""" }catch(err){
  toast('Save error: '+err.message);
  if(form.id==='setting-save'&&(err.status===409||err.status===428)){
   form.querySelector('.settings-conflict')?.remove();
   const warning=document.createElement('div');warning.className='notice warn settings-conflict';warning.setAttribute('role','alert');
   warning.textContent='Not saved. Your edits remain in this form. Another session changed these settings. ';
   const reload=document.createElement('button');reload.type='button';reload.className='btn ghost';reload.dataset.action='refresh';reload.textContent='Reload latest (discard these edits)';warning.appendChild(reload);form.prepend(warning);
  }
 }
});"""
s=rep(s,a,b)
s=rep(s,"Published page/policy content is available at /info/{slug}.","Published content has a unique type-specific URL: /info/page/{slug} or /info/policy/{slug}.")
a="table(['Title','Slug','Status','Version','Modified','Action'],q.items.map(x=>[link(x.title,'content-edit/'+kind+'/'+x.id),E(x.slug),badge(x.status),n(x.version),fmt(x.updated_at),link('Edit →','content-edit/'+kind+'/'+x.id)]));"
b="table(['Title','Slug','Status','Version','Modified','Public Page','Action'],q.items.map(x=>[link(x.title,'content-edit/'+kind+'/'+x.id),E(x.slug),badge(x.status),n(x.version),fmt(x.updated_at),(['page','policy'].includes(kind)&&x.status==='published'?'<a class=\"link\" target=\"_blank\" rel=\"noopener noreferrer\" href=\"/info/'+E(kind)+'/'+E(x.slug)+'\">Open public page</a>':'Not published'),link('Edit →','content-edit/'+kind+'/'+x.id)]));"
s=rep(s,a,b)
(ROOT/'public/control.js').write_text(s)
s=original('public/engine.js');a=s.index('function settingsForm(){');b=s.index('function system()',a)
s=s[:a]+'''function settingsForm(){
 const id=page.replace('setting-','');
 return head('Versioned Settings','Use the current editor to avoid overwriting another session.','')+'<div class="note">The legacy editor is read-only. Typed validation and optimistic version checks are required.</div><a class="btn" href="/engine#/setting-'+E(id)+'">Open current editor</a>'.replace('/setting-','/setting/');
}
'''+s[b:]
(ROOT/'public/engine.js').write_text(s)
s=original('tests/deep-routes.test.js')
s=s.replace(" deep.mount(app,{pool:{},audit:async()=>{}});"," deep.mount(app,{pool:{},audit:async()=>{}});\n require('../engine/public-content').mount(app,{pool:{}});")
s=s.replace("body:{data:'data:text/plain;base64,AAAA'}},res,()=>{throw Error('Unexpected next')}","body:{data:'data:text/plain;base64,AAAA'}},res,error=>{assert.equal(error.status,400);res.status(error.status).json({error:error.message})}")
(ROOT/'tests/deep-routes.test.js').write_text(s)
p=ROOT/'.github/workflows/cp14-repair.yml';s=p.read_text();s=s.replace('    timeout-minutes: 15','    timeout-minutes: 15\n    defaults:\n      run:\n        shell: bash');s=s.replace('      - run: npm install --no-audit --no-fund','      - run: npm ci --no-audit --no-fund');s=s.replace('      - name: Full application regression','      - run: npm install --no-save playwright@1.56.1\n      - run: npx playwright install --with-deps chromium\n      - name: Full application regression\n        env:\n          CP14_BROWSER: "true"');p.write_text(s)
p=ROOT/'.github/workflows/checks.yml';s=p.read_text().replace('npm install --no-audit --no-fund','npm ci --no-audit --no-fund');p.write_text(s)
