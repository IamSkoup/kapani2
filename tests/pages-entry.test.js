import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';
test('branch Pages entry preserves auth query and hash within kapani2',()=>{
 let destination;
 vm.runInNewContext(readFileSync('redirect.js','utf8'),{URL,location:{href:'https://iamskoup.github.io/kapani2/?code=test#recovery',search:'?code=test',hash:'#recovery',replace:x=>destination=x}});
 assert.equal(destination,'https://iamskoup.github.io/kapani2/public/?code=test#recovery');
 assert.ok(existsSync('.nojekyll'));
});
