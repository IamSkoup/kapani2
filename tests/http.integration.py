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
for a in accounts:
 r=requests.post(BASE+'/auth/v1/token?grant_type=password',json={'email':a['email'],'password':a['password']},headers={'apikey':KEY},timeout=25)
 assert r.status_code==200,('Auth login',r.status_code,r.json().get('msg'))
 data=r.json();assert data['user']['id']==a['id'];a['token']=data['access_token'];a['refresh']=data['refresh_token']
report('Four real Auth password sign-ins')
alice,bob,doctor,mayor=accounts
rpc=lambda a,name,body:api(a,'POST','/rest/v1/rpc/'+name,body)
wallet=lambda a:api(a,'GET','/rest/v1/accounts?kind=eq.wallet')[0]['balance']
for a in (alice,bob,doctor):rpc(mayor,'municipal_grant',{'p_user':a['id'],'p_amount':1000000,'p_key':str(uuid.uuid4()),'p_reason':'Изолированная проверка платформы, тестовый счёт'})
alice_before=wallet(alice)
before=alice_before+wallet(bob)
key=str(uuid.uuid4());payload={'p_recipient':bob['username'],'p_amount':12345,'p_key':key}
with concurrent.futures.ThreadPoolExecutor(2) as pool:
 tx=list(pool.map(lambda _:rpc(alice,'transfer',payload),range(2)))
assert tx[0]==tx[1] and wallet(alice)==alice_before-12345 and wallet(alice)+wallet(bob)==before
report('Concurrent duplicate transfer: single debit and money conservation')
assert api(alice,'GET','/rest/v1/accounts?owner_id=eq.'+bob['id'])==[]
r=api(alice,'PATCH','/rest/v1/accounts?owner_id=eq.'+alice['id'],{'balance':999999999},expected=(401,403))
api(alice,'POST','/rest/v1/user_roles',{'user_id':alice['id'],'role':'mayor'},expected=(401,403))
report('HTTP RLS: foreign wallets hidden, balance write and role escalation denied')
c=rpc(alice,'open_direct',{'p_user':bob['id']});mid=str(uuid.uuid4())
rpc(alice,'send_message',{'p_id':mid,'p_conversation':c,'p_body':'QA: private message'})
assert len(api(bob,'GET','/rest/v1/messages?id=eq.'+mid))==1
assert api(doctor,'GET','/rest/v1/messages?id=eq.'+mid)==[]
api(doctor,'POST','/rest/v1/rpc/send_message',{'p_id':str(uuid.uuid4()),'p_conversation':c,'p_body':'Unauthorized'},expected=(400,401,403))
report('HTTP RLS: private message visible to participant only')
l=api(doctor,'POST','/rest/v1/listings',{'seller_id':doctor['id'],'title':'QA last unit','description':'Тестовый товар, не предназначен для торговли','price':1500,'stock':1})[0]
def buy(a):
 h={'apikey':KEY,'Authorization':'Bearer '+a['token']}
 r=requests.post(BASE+'/rest/v1/rpc/purchase',json={'p_listing':l['id'],'p_quantity':1,'p_key':str(uuid.uuid4())},headers=h,timeout=25)
 return a,r
with concurrent.futures.ThreadPoolExecutor(2) as pool:purchases=list(pool.map(buy,[alice,bob]))
winners=[(a,r) for a,r in purchases if r.status_code==200]
assert len(winners)==1 and sum(r.status_code==400 for _,r in purchases)==1
winner,response=winners[0];order=response.json();assert api(winner,'GET','/rest/v1/listings?id=eq.'+l['id'])[0]['stock']==0
report('Concurrent final-unit purchases: exactly one order succeeds')
rpc(doctor,'order_action',{'p_order':order,'p_action':'accept'})
rpc(winner,'order_action',{'p_order':order,'p_action':'cancel'})
balance=wallet(winner);rpc(winner,'order_action',{'p_order':order,'p_action':'cancel'});assert wallet(winner)==balance
assert api(winner,'GET','/rest/v1/listings?id=eq.'+l['id'])[0]['stock']==1
report('Order refund and repeated cancellation are idempotent')
r=requests.post(BASE+'/auth/v1/token?grant_type=refresh_token',json={'refresh_token':alice['refresh']},headers={'apikey':KEY},timeout=25)
assert r.status_code==200 and r.json()['user']['id']==alice['id']
report('Auth refresh restores the same account')
Path(__file__).with_name('http-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'project':'svxgjisrkagmqjamnexp','tests':results,'limitations':['QA accounts seeded via SQL, not the public signup form','No email delivery, browser session or Storage coverage in this suite']},ensure_ascii=False,indent=2))
