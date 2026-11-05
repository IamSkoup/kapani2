from qa_support import *
alice,bob,doctor,mayor=login_all();pid=str(uuid.uuid4())
place={'p_id':pid,'p_title':'QA публичный объект','p_description':'Временная проверка прав карты','p_address':'QA техническая точка','p_latitude':52.62,'p_longitude':38.5,'p_active':True}
api(alice,'POST','/rest/v1/rpc/save_map_place',place,expected=(400,403))
rpc(mayor,'save_map_place',place)
bounds={'p_south':52,'p_west':38,'p_north':53,'p_east':39,'p_search':'QA публичный'}
points=rpc(alice,'map_points',bounds);point=next(x for x in points if x['id']==pid)
assert set(point)=={'id','kind','title','address','latitude','longitude','href'}
assert not any(x['id']==pid for x in rpc(alice,'map_points',{**bounds,'p_north':52.1}))
report('Mayor creates public point; resident receives only public fields within requested bounds')
place['p_active']=False;rpc(mayor,'save_map_place',place)
assert not any(x['id']==pid for x in rpc(alice,'map_points',bounds))
assert api(alice,'GET','/rest/v1/map_places?id=eq.'+pid)==[]
report('Hidden place disappears from map and resident table reads; fixture retained')
Path(__file__).with_name('map-results.json').write_text(json.dumps({'ran_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'tests':results,'limitations':['Browser tile rendering and hardware geolocation not part of this API suite','Search covers stored public names and addresses, not an external geocoder']},ensure_ascii=False,indent=2))
