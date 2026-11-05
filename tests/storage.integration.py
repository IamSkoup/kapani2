"""Real Storage JWT/RLS tests; fixtures retained, no deletion."""
from qa_support import *
alice,bob,outsider,mayor=login_all()
c=rpc(alice,'open_direct',{'p_user':bob['id']})
body=b'Kapani QA private attachment\n'
u=rpc(alice,'reserve_upload',{'p_id':str(uuid.uuid4()),'p_conversation':c,'p_filename':'qa.txt','p_mime':'text/plain','p_size':len(body)})
url=BASE+'/storage/v1/object/'+u['bucket']+'/'+u['path']
def raw(a,method,url,body=None,mime='text/plain'):
 req=urllib.request.Request(url,data=body,method=method,headers={'apikey':KEY,'Authorization':'Bearer '+a['token'],'Content-Type':mime})
 try:r=urllib.request.urlopen(req,timeout=25)
 except urllib.error.HTTPError as e:r=e
 return r.status,r.read()
status,response=raw(alice,'POST',url,body);assert status==200,('upload',status,response.decode()[:250])
report('Authenticated upload with reserved size and type')
api(bob,'POST','/storage/v1/object/sign/'+u['bucket']+'/'+u['path'],{'expiresIn':60},expected=(400,403,404))
report('Unsent draft attachment hidden even from conversation participant')
mid=str(uuid.uuid4());payload={'p_id':mid,'p_conversation':c,'p_body':'QA attachment','p_uploads':[u['id']]}
m=rpc(alice,'send_message_media',payload);m2=rpc(alice,'send_message_media',payload);assert m['id']==m2['id']
report('Attachment message persists and retries without duplication')
signed=api(bob,'POST','/storage/v1/object/sign/'+u['bucket']+'/'+u['path'],{'expiresIn':60})
assert 'signedURL' in signed
status,data=raw(bob,'GET',BASE+'/storage/v1'+signed['signedURL']);assert status==200 and data==body
report('Participant can download private file through expiring signed URL')
api(outsider,'POST','/storage/v1/object/sign/'+u['bucket']+'/'+u['path'],{'expiresIn':60},expected=(400,403,404))
status,_=raw(outsider,'GET',BASE+'/storage/v1/object/authenticated/'+u['bucket']+'/'+u['path']);assert status in(400,403,404)
assert api(outsider,'GET','/rest/v1/uploads?id=eq.'+u['id'])==[]
report('Nonparticipant cannot read metadata, sign or download attachment')
status,_=raw(alice,'PUT',url,b'Changed');assert status in(400,403,404)
report('Published attachment bytes cannot be replaced')
for mime,name,size in [('text/html','bad.html',10),('image/png','bad.svg',10),('image/png','bad.png',20971521)]:
 api(alice,'POST','/rest/v1/rpc/reserve_upload',{'p_id':str(uuid.uuid4()),'p_conversation':c,'p_filename':name,'p_mime':mime,'p_size':size},expected=(400,403))
report('Unsupported MIME, wrong extension and oversized file rejected')
rpc(alice,'edit_message',{'p_id':mid,'p_body':'','p_delete':True})
api(bob,'POST','/storage/v1/object/sign/'+u['bucket']+'/'+u['path'],{'expiresIn':60},expected=(400,403,404))
report('Deleted message no longer grants participant a new signed URL')
Path(__file__).with_name('storage-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['MIME metadata checks are not malware scanning','Previously issued signed URLs remain usable until their short expiry','Test file and soft-deleted message retained']},ensure_ascii=False,indent=2))
