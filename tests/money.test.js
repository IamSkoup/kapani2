import test from 'node:test';import assert from 'node:assert/strict';import {parseMoney,formatMoney} from '../public/js/money.js';
test('decimal parsing never uses floating point',()=>{assert.equal(parseMoney('0.29'),'29');assert.equal(parseMoney('100,01'),'10001');assert.equal(parseMoney('999999999.99'),'99999999999')});
test('rejects negative, zero, non-finite and sub-cent values',()=>{for(const x of ['0','-5','NaN','Infinity','1e4','1.001','2.',''])assert.throws(()=>parseMoney(x))});
test('formatting exact signed amounts',()=>{assert.equal(formatMoney('29'),'0,29 К₽');assert.equal(formatMoney('-101'),'−1,01 К₽')});
