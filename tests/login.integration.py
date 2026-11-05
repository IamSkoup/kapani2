from qa_support import *
a=accounts[0]
def login(identifier,password):return requests.post(BASE+'/functions/v1/kapani-login',json={'identifier':identifier,'password':password},headers={'apikey':KEY},timeout=30)
r=login(a['username'],a['password']);assert r.status_code==200,('nickname login',r.status_code,r.text[:200]);s=r.json();assert set(s)=={'access_token','refresh_token'}
a['token']=s['access_token'];assert api(a,'GET','/auth/v1/user')['id']==a['id']
report('Deployed Edge Function authenticates nickname against real Supabase Auth')
r=login(a['email'],a['password']);assert r.status_code==200
report('Email login also authenticates without exposing lookup response')
unknown=login('qa_missing_'+uuid.uuid4().hex[:12],'wrong-password');wrong=login(a['username'],'wrong-password')
assert unknown.status_code==wrong.status_code==401 and unknown.json()==wrong.json()
api(a,'POST','/rest/v1/rpc/prepare_login',{'p_identifier':a['username'],'p_account_hash':'a'*64,'p_network_hash':'b'*64},expected=(401,403,404))
report('Unknown and incorrect credentials share response; residents cannot call private email lookup')
Path(__file__).with_name('login-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['No SMTP registration/recovery delivery checked','CAPTCHA challenge UI is not configured','Direct Auth endpoints retain separate provider rate limits; Edge limiter covers this entry point']},ensure_ascii=False,indent=2))
