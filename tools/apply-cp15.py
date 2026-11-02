import base64,zlib,json,hashlib,pathlib,subprocess
PAYLOAD=''.join(pathlib.Path('tools/cp15-part-'+str(i)+'.txt').read_text().strip() for i in range(5))
assert hashlib.sha256(PAYLOAD.encode()).hexdigest()=='d6aff56584553493a95abd4045c1069a91037d1727d0e29bda1f18a077cd600d'
ROWS=json.loads(zlib.decompress(base64.b64decode(PAYLOAD)))
for row in ROWS:
 p=pathlib.Path(row['path'])
 assert not p.is_absolute() and '..' not in p.parts
 assert p.parts[0] in {'engine','public','tests','sources','server.js','package.json','package-lock.json'}
 if row['base']:
  old=p.read_bytes();assert hashlib.sha1(('blob '+str(len(old))+'\0').encode()+old).hexdigest()==row['base'],str(p)
  subprocess.run(['git','apply','--check','--whitespace=nowarn'],input=row['patch'].encode(),check=True)
  subprocess.run(['git','apply','--whitespace=nowarn'],input=row['patch'].encode(),check=True)
 else:
  assert not p.exists(),str(p)
  p.parent.mkdir(parents=True,exist_ok=True);p.write_text(row['content'])
 assert hashlib.sha256(p.read_bytes()).hexdigest()==row['sha256'],str(p)
 print(str(p),row['sha256'])
