from qa_support import *
quote_id=os.environ['KAPANI_QA_TAXI_QUOTE']
a=accounts[0]
r=requests.post(BASE+'/auth/v1/token?grant_type=password',json={'email':a['email'],'password':a['password']},headers={'apikey':KEY});assert r.status_code==200;a['token']=r.json()['access_token']
q=api(a,'GET','/rest/v1/taxi_quotes?id=eq.'+quote_id)[0];assert q['provider']=='qa-http-fixture-not-road-validation'
wallet=lambda:api(a,'GET','/rest/v1/accounts?kind=eq.wallet')[0]['balance']
before=wallet()
with concurrent.futures.ThreadPoolExecutor(2)as pool:rides=list(pool.map(lambda _:rpc(a,'request_taxi',{'p_quote':quote_id}),range(2)))
assert rides[0]==rides[1] and wallet()==before-q['amount']
report('Concurrent real HTTP requests reserve one fare for one ride')
api(a,'PATCH','/rest/v1/taxi_quotes?id=eq.'+quote_id,{'amount':1},expected=(401,403))
api(a,'POST','/rest/v1/rpc/store_taxi_quote',{'p_user':a['id'],'p_pickup_lat':52.6,'p_pickup_lng':38.5,'p_dropoff_lat':52.61,'p_dropoff_lng':38.51,'p_distance':10,'p_duration':1,'p_provider':'forged','p_geometry':{}},expected=(401,403,404))
report('Resident cannot edit quote price or call privileged quote creation')
with concurrent.futures.ThreadPoolExecutor(2)as pool:states=list(pool.map(lambda _:rpc(a,'taxi_action',{'p_ride':rides[0],'p_action':'cancel','p_reason':'QA отмена тестовой поездки'}),range(2)))
assert states==['cancelled','cancelled'] and wallet()==before
report('Concurrent cancellation returns reserve exactly once after committed requests')
r=requests.post(BASE+'/functions/v1/kapani-route',json={'pickup_lat':52.6,'pickup_lng':38.5,'dropoff_lat':52.61,'dropoff_lng':38.51},headers={'apikey':KEY,'Authorization':'Bearer '+a['token']},timeout=30)
assert r.status_code==503 and 'не подключён' in r.json()['error']
report('Deployed routing endpoint explicitly refuses pricing without configured road provider')
Path(__file__).with_name('taxi-http-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['Route is explicitly synthetic QA fixture, not a road provider verification','Cancelled ride, quote and ledger retained','Driver lifecycle covered separately by real database rollback test, not two-browser end-to-end']},ensure_ascii=False,indent=2))
