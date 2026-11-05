import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('activation removes only obsolete caches in its own Pages scope',async()=>{
 const listeners={},removed=[];
 const context={URL,self:{registration:{scope:'https://iamskoup.github.io/kapani2/'},addEventListener:(name,fn)=>listeners[name]=fn},caches:{keys:async()=>['kapani-/kapani2/-v21','kapani-/kapani2/-v22','kapani-/kapani/-v21','kapani-shell-v21','other'],delete:async k=>removed.push(k)}};
 vm.runInNewContext(readFileSync('public/sw.js','utf8'),context);
 let done;listeners.activate({waitUntil:p=>done=p});await done;
 assert.deepEqual(removed,['kapani-/kapani2/-v21']);
});
