import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {recordingPanel} from '../public/js/recorder.js';
const dom=new JSDOM('<body></body>');globalThis.document=dom.window.document;globalThis.Node=dom.window.Node;globalThis.isSecureContext=true;
let latest,stopped=0,attached=[];
class Recorder{
 static isTypeSupported(){return true;}
 constructor(){latest=this;this.state='inactive';}
 start(){this.state='recording';}
 pause(){this.state='paused';}
 resume(){this.state='recording';}
 stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['recording'])});this.onstop?.();}
}
globalThis.MediaRecorder=Recorder;
const stream=()=>({getTracks:()=>[{stop(){stopped++;}}]});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>stream()}}});
const button=(panel,name)=>[...panel.element.querySelectorAll('button')].find(b=>b.textContent===name);
test('recording requires explicit preview attachment and supports pause and discard',async()=>{
 const panel=recordingPanel(file=>attached.push(file));
 try{
  await button(panel,'Начать запись').onclick();assert.equal(latest.state,'recording');
  button(panel,'Пауза').onclick();assert.equal(latest.state,'paused');
  button(panel,'Продолжить').onclick();assert.equal(latest.state,'recording');
  button(panel,'Прослушать / посмотреть').onclick();assert.equal(attached.length,0);assert.equal(stopped,1);
  assert.equal(button(panel,'Прикрепить запись').disabled,false);
  button(panel,'Прикрепить запись').onclick();assert.equal(attached.length,1);assert.equal(attached[0].type,'audio/webm');
  await button(panel,'Начать запись').onclick();button(panel,'Отменить запись').onclick();assert.equal(attached.length,1);assert.equal(button(panel,'Прикрепить запись').disabled,true);
 }finally{panel.dispose();}
});
test('late microphone permission after leaving chat immediately releases tracks',async()=>{
 let resolve;navigator.mediaDevices.getUserMedia=()=>new Promise(r=>resolve=r);
 const before=stopped,panel=recordingPanel(()=>assert.fail('must not attach'));
 const starting=button(panel,'Начать запись').onclick();panel.dispose();resolve(stream());await starting;
 assert.equal(stopped,before+1);assert.equal(button(panel,'Прикрепить запись').disabled,true);
});
