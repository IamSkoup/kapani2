import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {el,busy,field} from '../public/js/ui.js';
const dom=new JSDOM('<!doctype html><body></body>');
globalThis.document=dom.window.document;
globalThis.Node=dom.window.Node;
test('untrusted publication and filename strings remain text',()=>{
 const attack='<img src=x onerror="alert(1)"><script>steal()</script>';
 const node=el('p',{},attack);
 assert.equal(node.textContent,attack);assert.equal(node.querySelectorAll('script,img').length,0);
});
test('busy restores nested accessible content after a failed request',async()=>{
 const label=el('strong',{},'Отправить'),button=el('button',{},label);
 await assert.rejects(busy(button,async()=>{assert.equal(button.disabled,true);throw Error('offline')}));
 assert.equal(button.disabled,false);assert.equal(button.firstChild,label);
});
test('busy preserves deliberate post-request label and exhausted state',async()=>{
 const button=el('button',{},'Загрузить ещё');await busy(button,async()=>{button.textContent='Начало истории';button.dataset.exhausted='true';});
 assert.equal(button.textContent,'Начало истории');assert.equal(button.disabled,true);
});
test('form fields have unique linked labels and preserve literal content',()=>{
 const f=el('form'),first=field(f,'Описание','bio','textarea','<b>Текст</b>'),second=field(f,'Название','name');
 assert.notEqual(first.id,second.id);assert.equal(f.querySelector('label').htmlFor,first.id);assert.equal(first.value,'<b>Текст</b>');assert.equal(first.querySelector('b'),null);
});
