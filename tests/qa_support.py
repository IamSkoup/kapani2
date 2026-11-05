"""Explicit QA accounts only. Never put the credentials file in public/ or an archive.
Run with KAPANI_QA_CREDENTIALS=/absolute/private/accounts.json python tests/http.integration.py.
Fixtures are retained; this script does not delete user data.
"""
import os,json,re,uuid,time,concurrent.futures
from pathlib import Path
import urllib.request,urllib.error
class HttpClient:
 @staticmethod
 def request(method,url,json=None,headers=None,timeout=25):
  import json as codec
  from types import SimpleNamespace
  headers={'Content-Type':'application/json',**(headers or {})}
  req=urllib.request.Request(url,data=codec.dumps(json).encode() if json is not None else None,headers=headers,method=method)
  try: response=urllib.request.urlopen(req,timeout=timeout)
  except urllib.error.HTTPError as e: response=e
  content=response.read();status=response.status;text=content.decode()
  return SimpleNamespace(status_code=status,content=content,text=text,json=lambda:codec.loads(text))
 @classmethod
 def post(cls,url,**kwargs):return cls.request('POST',url,**kwargs)
requests=HttpClient()
BASE='https://svxgjisrkagmqjamnexp.supabase.co'
CONFIG=(Path(__file__).parents[1]/'public/js/config.js').read_text()
KEY=re.search(r'publishableKey\s*:\s*["\']([^"\']+)["\']',CONFIG).group(1)
accounts=json.loads(Path(os.environ['KAPANI_QA_CREDENTIALS']).read_text())
assert len(accounts)==4 and all(a['email'].endswith('@example.invalid') and a['username'].startswith('qa_') for a in accounts)
results=[]
def report(name):
 results.append({'name':name,'passed':True});print('PASS '+name,flush=True)
def api(a,method,path,data=None,expected=(200,201,204)):
 h={'apikey':KEY,'Authorization':'Bearer '+a['token'],'Content-Type':'application/json','Prefer':'return=representation'}
 r=requests.request(method,BASE+path,json=data,headers=h,timeout=25)
 assert r.status_code in expected,(path,r.status_code,r.text[:300])
 return r.json() if r.content else None

def login_all():
 for a in accounts:
  r=requests.post(BASE+'/auth/v1/token?grant_type=password',json={'email':a['email'],'password':a['password']},headers={'apikey':KEY},timeout=25)
  assert r.status_code==200,('Auth login',r.status_code)
  data=r.json();assert data['user']['id']==a['id'];a['token']=data['access_token'];a['refresh']=data['refresh_token']
 return accounts

def rpc(a,name,body):return api(a,'POST','/rest/v1/rpc/'+name,body)
