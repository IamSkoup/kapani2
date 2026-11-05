import {cpSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
const source=resolve('public'),output=resolve('dist');
rmSync(output,{recursive:true,force:true});
mkdirSync(output,{recursive:true});
cpSync(source,output,{recursive:true,filter:path=>{
 const parts=relative(source,path).split(sep);
 return !parts.some(p=>p.startsWith('.')||p==='__qa'||p==='__layout-test.html');
}});
writeFileSync(resolve(output,'.nojekyll'),'');
console.log('Static Pages package prepared in dist');
