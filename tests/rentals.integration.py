from qa_support import *
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
alice,bob,doctor,mayor=login_all()
bid=str(uuid.uuid4());building={'p_id':bid,'p_title':'QA помещение','p_description':'Тестовая виртуальная аренда','p_address':'Тестовая зона','p_daily':1000,'p_active':True}
rpc(mayor,'save_building',building)
start=(datetime.now(ZoneInfo('Europe/Moscow')).date()+timedelta(days=20)).isoformat()
wallet=lambda a:api(a,'GET','/rest/v1/accounts?kind=eq.wallet')[0]['balance']
balances={a['id']:wallet(a)for a in[alice,bob]}
def rent(a):
 payload={'p_building':bid,'p_start':start,'p_days':3,'p_expected_daily':1000,'p_key':str(uuid.uuid4())}
 r=requests.post(BASE+'/rest/v1/rpc/rent_building',json=payload,headers={'apikey':KEY,'Authorization':'Bearer '+a['token']});return a,payload,r
with concurrent.futures.ThreadPoolExecutor(2)as pool:out=list(pool.map(rent,[alice,bob]))
assert sum(r.status_code==200 for _,_,r in out)==1 and sum(r.status_code==400 for _,_,r in out)==1
winner,payload,response=next(x for x in out if x[2].status_code==200);lease=response.json();assert rpc(winner,'rent_building',payload)==lease
assert wallet(winner)==balances[winner['id']]-3000
report('Overlapping concurrent rentals create one lease and debit exactly once')
assert api(doctor,'GET','/rest/v1/leases?id=eq.'+lease)==[]
api(doctor,'POST','/rest/v1/rpc/release_lease',{'p_lease':lease},expected=(400,403))
report('Foreign lease details and cancellation are denied')
key=str(uuid.uuid4());renew={'p_lease':lease,'p_days':2,'p_expected_daily':1000,'p_key':key};assert rpc(winner,'renew_lease',renew)==rpc(winner,'renew_lease',renew)
assert wallet(winner)==balances[winner['id']]-5000
report('Extension charges only once and preserves original payment records')
rpc(winner,'release_lease',{'p_lease':lease});rpc(winner,'release_lease',{'p_lease':lease})
assert wallet(winner)==balances[winner['id']]
assert any(x['id']==bid for x in rpc(winner,'available_buildings',{'p_start':start,'p_days':5}))
report('Cancellation before start returns full reserve once and releases availability')
api(winner,'POST','/rest/v1/rpc/rent_building',{'p_building':bid,'p_start':start,'p_days':3,'p_expected_daily':1,'p_key':str(uuid.uuid4())},expected=(400,403))
assert wallet(winner)==balances[winner['id']]
report('Client cannot substitute a lower rental price')
building['p_active']=False;rpc(mayor,'save_building',building)
Path(__file__).with_name('rentals-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['Lifecycle cron at actual date boundary not yet exercised','Prepaid terms only, no arrears or monthly invoicing','Test property disabled and records retained']},ensure_ascii=False,indent=2))
