from qa_support import *
alice,bob,doctor,mayor=login_all()
tid=str(uuid.uuid4())
config={'p_id':tid,'p_title':'QA проверяемая публикация','p_description':'Создать публикацию после начала задания для проверки серверного события','p_condition':'post_created','p_cadence':'once','p_target':1,'p_reward':123,'p_subscribers':False}
api(alice,'POST','/rest/v1/rpc/create_task',config,expected=(400,403))
assert rpc(mayor,'create_task',config)==tid
assert rpc(mayor,'create_task',config)==tid
period=next(t for t in rpc(alice,'my_tasks',{}) if t['task_id']==tid)
api(alice,'POST','/rest/v1/rpc/claim_task',{'p_period':period['period_id']},expected=(400,403))
api(alice,'POST','/rest/v1/task_events',{'user_id':alice['id'],'kind':'post_created','entity_id':str(uuid.uuid4())},expected=(401,403))
report('Residents cannot create rewards, forge evidence or claim an incomplete task')
pid=str(uuid.uuid4());api(alice,'POST','/rest/v1/posts',{'id':pid,'author_id':alice['id'],'body':'QA проверка защищённого условия задания','visibility':'private'})
period=next(t for t in rpc(alice,'my_tasks',{}) if t['task_id']==tid)
assert period['progress']==1
wallet=lambda:api(alice,'GET','/rest/v1/accounts?kind=eq.wallet')[0]['balance']
before=wallet()
with concurrent.futures.ThreadPoolExecutor(2) as pool:claims=list(pool.map(lambda _:rpc(alice,'claim_task',{'p_period':period['period_id']}),range(2)))
assert claims[0]==claims[1] and wallet()==before+123
assert len(api(alice,'GET','/rest/v1/task_claims?period_id=eq.'+period['period_id']))==1
report('Concurrent claims create one immutable payment and exactly one wallet credit')
assert api(bob,'GET','/rest/v1/task_claims?user_id=eq.'+alice['id'])==[]
assert api(bob,'GET','/rest/v1/task_events?user_id=eq.'+alice['id'])==[]
api(alice,'PATCH','/rest/v1/task_claims?id=eq.'+claims[0],{'reward':999999},expected=(401,403))
api(mayor,'POST','/rest/v1/rpc/claim_task',{'p_period':period['period_id']},expected=(400,403))
report('Other residents cannot read evidence or payments; neither recipient nor creator can bypass rules')
rpc(mayor,'set_task_active',{'p_id':tid,'p_active':False})
assert not any(t['task_id']==tid for t in rpc(alice,'my_tasks',{}))
assert rpc(alice,'claim_task',{'p_period':period['period_id']})==claims[0]
report('Suspension hides task, retains history, and repeated receipt never pays again')
Path(__file__).with_name('tasks-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['Only publication condition exercised end-to-end in this suite','QA private post, disabled task and ledger retained','No cleanup-job photo workflow or public achievement rankings yet']},ensure_ascii=False,indent=2))
