from qa_support import *
from datetime import datetime,timedelta,timezone
alice,bob,doctor,mayor=login_all()
id=str(uuid.uuid4());data={'p_id':id,'p_category':'village','p_title':'QA черновик','p_body':'Тестовая публикация проверки доступа','p_publish':False}
api(alice,'POST','/rest/v1/rpc/save_news',data,expected=(400,403))
rpc(mayor,'save_news',data)
assert api(alice,'GET','/rest/v1/news?id=eq.'+id)==[]
news=api(mayor,'GET','/rest/v1/news?id=eq.'+id)[0]
api(alice,'POST','/rest/v1/rpc/message_history',{'p_conversation':news['discussion_id']},expected=(400,403))
report('Resident cannot publish, read draft or open its discussion')
data['p_publish']=True;rpc(mayor,'save_news',data)
assert len(api(alice,'GET','/rest/v1/news?id=eq.'+id))==1
assert rpc(alice,'view_news',{'p_id':id})==1 and rpc(alice,'view_news',{'p_id':id})==1
msg=rpc(alice,'send_message_media',{'p_id':str(uuid.uuid4()),'p_conversation':news['discussion_id'],'p_body':'QA обсуждение'})
rpc(alice,'mark_conversation_read',{'p_conversation':news['discussion_id'],'p_message':msg['id']})
report('Published news is readable, views deduplicate, discussion accepts messages')
rpc(mayor,'archive_news',{'p_id':id})
api(alice,'POST','/rest/v1/rpc/message_history',{'p_conversation':news['discussion_id']},expected=(400,403))
assert all(c['id']!=news['discussion_id'] for c in rpc(alice,'conversation_list',{}))
report('Archiving revokes discussion access even for former participants')
eid=str(uuid.uuid4());start=datetime.now(timezone.utc)+timedelta(days=10)
event={'p_id':eid,'p_title':'QA последнее место','p_description':'Тестовое событие без настоящих участников','p_start':start.isoformat(),'p_end':(start+timedelta(hours=2)).isoformat(),'p_until':(start-timedelta(hours=1)).isoformat(),'p_capacity':1}
api(alice,'POST','/rest/v1/rpc/create_event',event,expected=(400,403));assert rpc(mayor,'create_event',event)==eid
assert rpc(mayor,'create_event',event)==eid

def join(a):
 r=requests.post(BASE+'/rest/v1/rpc/join_event',json={'p_id':eid},headers={'apikey':KEY,'Authorization':'Bearer '+a['token']});return a,r.status_code
with concurrent.futures.ThreadPoolExecutor(2)as pool:out=list(pool.map(join,[alice,bob]))
assert sum(code in(200,204) for _,code in out)==1 and sum(code==400 for _,code in out)==1
winner=next(a for a,code in out if code in(200,204));rpc(winner,'join_event',{'p_id':eid});assert len(api(winner,'GET','/rest/v1/event_participants?event_id=eq.'+eid))==1
report('Concurrent final-seat registration admits exactly one resident, retry is safe')
rpc(mayor,'event_action',{'p_id':eid,'p_status':'cancelled','p_result':'Завершение технической проверки'})
api(doctor,'POST','/rest/v1/rpc/join_event',{'p_id':eid},expected=(400,403))
report('Cancelled event rejects registration')
Path(__file__).with_name('publishing-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['No browser editor or event-result UI verification yet','QA news archived and event cancelled; history retained']},ensure_ascii=False,indent=2))
