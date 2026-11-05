import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const base=resolve('public');
test('all application module imports resolve inside the static package',()=>{
 for(const f of readdirSync('public/js').filter(f=>f.endsWith('.js'))){
  const path=resolve('public/js',f),source=readFileSync(path,'utf8');
  for(const [,relative]of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)){
   const target=resolve(dirname(path),relative);assert.ok(target.startsWith(base+'/'));assert.ok(existsSync(target),`${f} imports missing ${relative}`);
  }
 }
});
test('service worker precache contains only existing static files',()=>{
 const source=readFileSync('public/sw.js','utf8'),array=source.match(/const FILES = (\[[\s\S]*?\]);/)[1];
 const files=JSON.parse(array.replace(/,\s*]/g,']'));
 for(const f of files){assert.ok(!f.includes('supabase.co'));assert.ok(existsSync(resolve(base,f)),`Missing precache ${f}`);}
});
test('install manifest contains valid raster icon files and relative scope',()=>{
 const manifest=JSON.parse(readFileSync('public/manifest.webmanifest','utf8'));assert.equal(manifest.scope,'./');assert.equal(manifest.start_url,'./');
 for(const size of ['192x192','512x512'])assert.ok(manifest.icons.some(i=>i.sizes===size&&existsSync(resolve(base,i.src))));
});
