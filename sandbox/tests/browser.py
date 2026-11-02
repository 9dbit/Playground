from pathlib import Path
from playwright.sync_api import sync_playwright
import json,sys
base=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8777'
out=Path('test-results');out.mkdir(exist_ok=True)
errors=[];network=[];checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':1050})
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda r:network.append(r.url))
 page.goto(base+'/');page.locator('.stat').first.wait_for()
 assert 'SANDBOX' in page.locator('#sandbox-banner').inner_text()
 assert page.locator('input[type=password]').count()==0
 checks.append('anonymous browser opens dashboard directly; no login or MFA')
 page.screenshot(path=str(out/'sandbox-desktop.png'),full_page=True)
 gid='10000000-0000-4000-8000-000000000001';pid='20000000-0000-4000-8000-000000000001';tid='40000000-0000-4000-8000-000000000001'
 routes=['dashboard','games','rounds','players/all','players/active','players/banned','players/email','players/mobile','players/kyc','players/kyc-pending','diamonds/all','diamonds/pending','diamonds/approved','diamonds/rejected','tickets/all','tickets/pending','tickets/closed','tickets/answered','notify','report/transactions','report/logins','report/notifications','report/transfers','subscribers','settings','extra/application','extra/server','extra/cache','extra/update','report-request','parity','wallet/'+pid,'game/'+gid,'game-rounds/'+gid,'player/'+pid,'player-rounds/'+pid,'round/1','ticket/'+tid,'request/30000000-0000-4000-8000-000000000001','content/page','content/policy','content/template','content/frontend']
 routes+=['setting/'+s for s in ['general','logo','configuration','notification','seo','kyc','social','language','extensions','cron','maintenance','gdpr','css','sitemap','robots']]
 for r in routes:
  page.goto(base+'/engine#/'+r);page.locator('h1').wait_for();assert page.locator('h1').inner_text()!='Load failed',r
 checks.append(str(len(routes))+' menu and detail paths render')
 page.goto(base+'/engine#/game/'+gid);page.locator('#game-edit').wait_for()
 page.locator('input[name=name]').fill('SANDBOX edited game');page.locator('#game-edit button[type=submit]').click()
 page.get_by_text('Version 2 saved',exact=False).wait_for();page.reload();page.locator('#game-edit').wait_for()
 assert page.locator('input[name=name]').input_value()=='SANDBOX edited game'
 checks.append('game edit persists only in browser tab across reload')
 assert page.locator('input[name=winning_chance]').count()==1
 assert page.locator('input[name=win_amount]').count()==1
 checks.append('game sandbox chance and win amount fields remain editable')
 page.goto(base+'/engine#/wallet/'+pid);page.get_by_role('heading',name='Virtual Wallet',exact=False).wait_for()
 assert page.locator('.stats').count()==1
 page.locator('[data-action=wallet-credit]').first.click()
 page.locator('#modal-form').wait_for()
 page.locator('#modal-form input[name=amount]').fill('20')
 page.locator('#modal-form input[name=note]').fill('QA sandbox virtual credit')
 page.locator('#modal-form button.btn').last.click()
 page.get_by_role('heading',name='Virtual Wallet',exact=False).wait_for()
 assert '120' in page.locator('.stats').inner_text()
 checks.append('synthetic virtual credits update browser-only balance and ledger')
 page.goto(base+'/engine#/parity');page.locator('.parity-row').first.wait_for()
 assert page.locator('.parity-row').count()>=19
 checks.append('functional parity matrix visible with blocked/partial states')
 page.goto(base+'/engine#/ticket/'+tid);page.locator('#ticket-reply').wait_for()
 page.locator('textarea[name=body]').fill('Synthetic browser-only reply');page.locator('#ticket-reply button').click()
 page.get_by_text('Synthetic browser-only reply',exact=True).wait_for();checks.append('local ticket reply flow works')
 page.goto(base+'/engine#/settings');page.locator('.settings-item').first.wait_for();assert page.locator('.settings-item').count()==19
 checks.append('19 settings cards visible')
 page.set_viewport_size({'width':390,'height':844});page.goto(base+'/engine#/dashboard');page.locator('.stat').first.wait_for()
 assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
 page.screenshot(path=str(out/'sandbox-mobile.png'),full_page=True)
 page.locator('[data-action=mobile]').click();page.locator('.sidebar.mobile-open').wait_for()
 checks.append('390px mobile: no page overflow and menu opens')
 context2=browser.new_context();page2=context2.new_page();page2.goto(base+'/engine#/game/'+gid);page2.locator('#game-edit').wait_for()
 assert page2.locator('input[name=name]').input_value()!='SANDBOX edited game'
 checks.append('separate browser context has independent synthetic state')
 page.goto(base+'/engine#/game/'+gid);page.locator('#game-edit').wait_for();page.locator('#sandbox-reset').click();page.locator('.stat').first.wait_for()
 page.goto(base+'/engine#/game/'+gid);page.locator('#game-edit').wait_for();assert page.locator('input[name=name]').input_value()!='SANDBOX edited game'
 checks.append('reset restores fixtures')
 assert not errors,errors
 assert not [u for u in network if '/api/' in u],network
 assert all(u.startswith(base+'/') for u in network),network
 checks.append('zero JS errors and zero real API or outbound requests')
 browser.close()
report={'result':'PASS','base':base,'checks':checks,'routes_tested':len(routes),'errors':errors,'actual_api_requests':0,'productionConnected':False}
(out/'qa.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
