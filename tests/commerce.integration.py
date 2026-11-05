from qa_support import *
alice,bob,doctor,mayor=login_all()
bs=api(alice,'GET','/rest/v1/businesses?owner_id=eq.'+alice['id']+'&status=eq.active')
assert bs,'QA business required';b=bs[0];pid=str(uuid.uuid4())
product={'p_id':pid,'p_business':b['id'],'p_title':'QA последняя единица','p_description':'Проверка реального каталога и резерва','p_price':123,'p_stock':1,'p_active':True}
api(bob,'POST','/rest/v1/rpc/save_business_product',product,expected=(400,403))
rpc(alice,'save_business_product',product)
base={'p_business':b['id'],'p_items':[{'product_id':pid,'quantity':1}],'p_expected_total':123,'p_comment':'QA самовывоз'}
api(bob,'POST','/rest/v1/rpc/checkout_business',{**base,'p_expected_total':1,'p_key':str(uuid.uuid4())},expected=(400,403))
report('Foreign catalogue changes and substituted checkout prices rejected')
keys={a['id']:str(uuid.uuid4()) for a in(bob,doctor)}
def buy(a):
 try:return(a,rpc(a,'checkout_business',{**base,'p_key':keys[a['id']]}))
 except AssertionError as e:
  assert 'Stock unavailable' in str(e);return(a,None)
with concurrent.futures.ThreadPoolExecutor(2)as pool:outcomes=list(pool.map(buy,(bob,doctor)))
assert sum(o is not None for _,o in outcomes)==1
buyer,oid=next((a,o)for a,o in outcomes if o);other=doctor if buyer is bob else bob
assert rpc(buyer,'checkout_business',{**base,'p_key':keys[buyer['id']]})==oid
assert api(other,'GET','/rest/v1/business_orders?id=eq.'+oid)==[]
assert api(other,'GET','/rest/v1/business_order_items?order_id=eq.'+oid)==[]
assert api(other,'GET','/rest/v1/business_order_history?order_id=eq.'+oid)==[]
report('Concurrent last-stock checkout has one winner; replay and private order isolation pass')
api(buyer,'POST','/rest/v1/rpc/business_order_action',{'p_order':oid,'p_action':'receive'},expected=(400,403))
api(other,'POST','/rest/v1/rpc/business_order_action',{'p_order':oid,'p_action':'accept'},expected=(400,403))
rpc(alice,'business_order_action',{'p_order':oid,'p_action':'accept'});rpc(alice,'business_order_action',{'p_order':oid,'p_action':'ready'})
balance=lambda:api(alice,'GET','/rest/v1/accounts?id=eq.'+b['account_id'])[0]['balance']
before=balance()
with concurrent.futures.ThreadPoolExecutor(2)as pool:states=list(pool.map(lambda _:rpc(buyer,'business_order_action',{'p_order':oid,'p_action':'receive'}),range(2)))
assert states==['completed','completed'] and balance()==before+123
assert len(api(buyer,'GET','/rest/v1/task_events?kind=eq.purchase_completed&entity_id=eq.'+oid))==1
report('Only buyer confirms ready order; concurrent receipt pays business once and records task event')
product['p_stock']=1;rpc(alice,'save_business_product',product)
oid2=rpc(buyer,'checkout_business',{**base,'p_key':str(uuid.uuid4())})
rpc(buyer,'business_order_action',{'p_order':oid2,'p_action':'dispute','p_reason':'QA спор о получении товара'})
api(alice,'POST','/rest/v1/rpc/business_order_action',{'p_order':oid2,'p_action':'refund_dispute','p_reason':'Самостоятельное разрешение спора'},expected=(400,403))
wallet=lambda:api(buyer,'GET','/rest/v1/accounts?kind=eq.wallet')[0]['balance']
before=wallet();decision={'p_order':oid2,'p_action':'refund_dispute','p_reason':'QA подтверждённый возврат покупателю'}
with concurrent.futures.ThreadPoolExecutor(2)as pool:states=list(pool.map(lambda _:rpc(mayor,'business_order_action',decision),range(2)))
assert states==['cancelled','cancelled'] and wallet()==before+123
assert api(alice,'GET','/rest/v1/business_products?id=eq.'+pid)[0]['stock']==1
report('Dispute resolution requires independent mayor, returns funds and stock exactly once')
product['p_active']=False;rpc(alice,'save_business_product',product)
Path(__file__).with_name('commerce-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['Pickup only; delivery not connected','Completed-order returns and partial refunds not implemented','QA product disabled; orders, evidence and financial history retained']},ensure_ascii=False,indent=2))
