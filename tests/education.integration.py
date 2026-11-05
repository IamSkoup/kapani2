from qa_support import *
alice,bob,doctor,mayor=login_all()
eid=str(uuid.uuid4());config={'p_id':eid,'p_title':'QA внутренний экзамен','p_seconds':600,'p_questions':2,'p_pass':50,'p_fee':100,'p_active':False}
api(alice,'POST','/rest/v1/rpc/save_exam',config,expected=(400,403));rpc(mayor,'save_exam',config)
for n in(1,2):rpc(mayor,'add_exam_question',{'p_id':str(uuid.uuid4()),'p_exam':eid,'p_prompt':'QA вопрос '+str(n),'p_options':['Верный вариант','Неверный вариант'],'p_correct':1,'p_explanation':'Проверка защищённого выставления результата'})
config['p_active']=True;rpc(mayor,'save_exam',config)
wallet=lambda a:api(a,'GET','/rest/v1/accounts?kind=eq.wallet')[0]['balance']
before=wallet(alice);key=str(uuid.uuid4())
with concurrent.futures.ThreadPoolExecutor(2) as pool:attempts=list(pool.map(lambda _:rpc(alice,'start_exam',{'p_exam':eid,'p_key':key}),range(2)))
a=attempts[0];assert a['id']==attempts[1]['id'] and wallet(alice)==before-100
report('Concurrent start creates one attempt and charges once')
api(bob,'POST','/rest/v1/rpc/exam_questions',{'p_attempt':a['id']},expected=(400,403))
api(alice,'POST','/rest/v1/rpc/exam_result',{'p_attempt':a['id']},expected=(400,403))
questions=rpc(alice,'exam_questions',{'p_attempt':a['id']})
assert len(questions)==2 and all('correct_id' not in q for q in questions)
assert all(all(set(o)=={'id','body'} for o in q['options']) for q in questions)
assert api(bob,'GET','/rest/v1/exam_attempts?id=eq.'+a['id'])==[]
report('Correct answers withheld until submit; another resident cannot access attempt')
api(alice,'POST','/rest/v1/rpc/answer_exam',{'p_attempt':a['id'],'p_question':questions[0]['question_id'],'p_option':str(uuid.uuid4())},expected=(400,403))
for i,q in enumerate(questions):rpc(alice,'answer_exam',{'p_attempt':a['id'],'p_question':q['question_id'],'p_option':q['options'][i]['id']})
result=rpc(alice,'submit_exam',{'p_attempt':a['id']});again=rpc(alice,'submit_exam',{'p_attempt':a['id']})
assert result==again and result['score']==1 and result['passed'] is True
api(alice,'POST','/rest/v1/rpc/answer_exam',{'p_attempt':a['id'],'p_question':questions[0]['question_id'],'p_option':questions[0]['options'][0]['id']},expected=(400,403))
api(alice,'PATCH','/rest/v1/exam_attempts?id=eq.'+a['id'],{'score':2},expected=(401,403))
report('Server grades correctly, submit is idempotent, answers and score cannot be changed after finish')
assert len(rpc(alice,'exam_result',{'p_attempt':a['id']}))==2
api(alice,'POST','/rest/v1/rpc/correct_exam_result',{'p_attempt':a['id'],'p_score':2,'p_reason':'Попытка самовольного изменения'},expected=(400,403))
rpc(mayor,'correct_exam_result',{'p_attempt':a['id'],'p_score':2,'p_reason':'Техническая проверка административной корректировки'})
assert len(api(alice,'GET','/rest/v1/exam_adjustments?attempt_id=eq.'+a['id']))==1
report('Administrative correction requires mayor and retains original result')
config['p_active']=False;rpc(mayor,'save_exam',config)
Path(__file__).with_name('education-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['Timeout cron and real browser timer not yet verified','QA exam disabled after testing; history retained']},ensure_ascii=False,indent=2))
