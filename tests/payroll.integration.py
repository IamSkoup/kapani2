from qa_support import *
alice,bob,doctor,mayor=login_all()
a=api(alice,'POST','/rest/v1/applications',{'applicant_id':alice['id'],'kind':'business','title':'QA зарплатная организация','body':'Техническая проверка выплат и увольнения'})[0]
rpc(mayor,'review_application',{'p_id':a['id'],'p_approve':True,'p_reason':'Отдельная тестовая организация'})
b=api(alice,'GET','/rest/v1/businesses?application_id=eq.'+a['id'])[0]
v=rpc(alice,'create_vacancy',{'p_business':b['id'],'p_title':'QA сотрудник','p_description':'Фиксированная выплата за календарный месяц','p_positions':1,'p_salary':20000})
j=api(bob,'POST','/rest/v1/job_applications',{'vacancy_id':v,'applicant_id':bob['id'],'letter':'Проверка приёма на работу'})[0]
api(bob,'POST','/rest/v1/rpc/review_job',{'p_id':j['id'],'p_accept':True,'p_reason':'Самостоятельный приём запрещён'},expected=(400,403))
rpc(alice,'review_job',{'p_id':j['id'],'p_accept':True,'p_reason':'Тестовая работа согласована'})
api(alice,'POST','/rest/v1/rpc/pay_business_salary',{'p_business':b['id'],'p_user':bob['id']},expected=(400,403))
assert api(alice,'GET','/rest/v1/payroll_payments?business_id=eq.'+b['id'])==[]
report('Business cannot pay salary without funds; failed payment leaves no payroll entry')
key=str(uuid.uuid4());f={'p_business':b['id'],'p_amount':100000,'p_key':key};assert rpc(alice,'fund_business',f)==rpc(alice,'fund_business',f)
wallet=lambda user:api(user,'GET','/rest/v1/accounts?kind=eq.wallet')[0]['balance']
before=wallet(bob)
with concurrent.futures.ThreadPoolExecutor(2)as pool:payments=list(pool.map(lambda _:rpc(alice,'pay_business_salary',{'p_business':b['id'],'p_user':bob['id']}),range(2)))
assert payments[0]==payments[1] and wallet(bob)==before+20000
assert api(alice,'GET','/rest/v1/accounts?id=eq.'+b['account_id'])[0]['balance']==80000
assert api(doctor,'GET','/rest/v1/payroll_payments?business_id=eq.'+b['id'])==[]
report('Concurrent monthly payroll pays once, debits business and credits employee exactly')
rpc(alice,'configure_employee',{'p_business':b['id'],'p_user':bob['id'],'p_position':'QA обработка заказов','p_salary':20000,'p_orders':True,'p_catalog':True,'p_reason':'Проверка выдачи и отзыва полномочий'})
api(doctor,'POST','/rest/v1/rpc/end_employment',{'p_application':j['id'],'p_reason':'Посторонний не может увольнять'},expected=(400,403))
rpc(bob,'end_employment',{'p_application':j['id'],'p_reason':'Завершение проверки трудоустройства'})
rpc(bob,'end_employment',{'p_application':j['id'],'p_reason':'Повтор того же запроса'})
m=api(bob,'GET','/rest/v1/business_members?business_id=eq.'+b['id'])[0]
assert not m['active'] and not m['can_manage_orders'] and not m['can_manage_catalog']
assert api(bob,'GET','/rest/v1/job_applications?id=eq.'+j['id'])[0]['status']=='ended'
assert len(api(bob,'GET','/rest/v1/payroll_payments?business_id=eq.'+b['id']))==1
report('Resignation revokes employee permissions immediately and preserves payment history')
Path(__file__).with_name('payroll-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['Fixed monthly salary only; no prorating or automated debt accrual','Test organization and records retained']},ensure_ascii=False,indent=2))
