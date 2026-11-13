'use strict';
// Offline name translation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const t = require('../com.align4.export/js/translate');

const DATA = path.resolve(__dirname, '../com.align4.export/data');
const builtin = t.loadGlossary(fs.readFileSync(path.join(DATA, 'glossary.csv'), 'utf8'));
const dict = JSON.parse(fs.readFileSync(path.join(DATA, 'dict.json'), 'utf8')).words;
function translator(user = {}) { return t.create({user: () => user, builtin, dict}); }

test('glossary CSV: BOM, quotes, comments, "-" drops a word, first row wins', () => {
  const map = t.loadGlossary('﻿中文,英文\n# 注释,x\n按钮,btn\n按钮,button\n"装饰,图",Deco Thing\n的,-\n空,\n');
  assert.deepEqual(map, {'按钮': 'btn', '装饰,图': 'Deco_Thing', '的': ''}, 'English keeps its case; spaces become _');
});

test('built-in glossary is well-formed', () => {
  assert.ok(Object.keys(builtin).length > 400);
  for (const [zh, en] of Object.entries(builtin)) assert.match(en, /^([a-z0-9]+(_[a-z0-9]+)*)?$/, zh);
});

test('typical slice names', () => {
  const tr = translator();
  for (const [zh, en] of [['按钮/确认', 'btn_confirm'], ['聊天系统/装饰图_02', 'chat_deco_02'], ['图标/搜索_选中', 'icon_search_selected'],
    ['按钮/按钮_按下', 'btn_pressed'], ['头像框_金色', 'avatar_frame_gold'], ['btn确认', 'btn_confirm'], ['好友列表条目背景', 'friend_list_item_bg']]) {
    assert.equal(tr.translate(zh).text, en, zh);
  }
});

test('glossary words beat dictionary words; the dictionary fills gaps and is marked', () => {
  const r = translator().translate('头像闪光');
  assert.equal(r.text, 'avatar_flash');
  assert.deepEqual(r.parts.map(p => p.source), ['builtin', 'dict']);
});

test('unknown words stay in Chinese (no pinyin) and are marked', () => {
  const r = translator().translate('按钮_䶮䶮');
  assert.equal(r.text, 'btn_䶮䶮'); assert.equal(r.complete, false);
  assert.equal(r.parts[1].source, 'none');
  assert.equal(translator().translate('图').text, '图', 'a name made only of dropped words is kept');
});

test('the user glossary has top priority, including whole-name entries', () => {
  const tr = translator({'确认': 'ok', '聊天系统装饰图': 'chat_bubble_deco'});
  assert.equal(tr.translate('按钮/确认').text, 'btn_ok');
  assert.equal(tr.translate('聊天系统装饰图').text, 'chat_bubble_deco');
});

test('learning: changed words are learned one by one when the word count matches', () => {
  assert.deepEqual(translator().learn('头像闪光', 'avatar_shine'), [['闪光', 'shine']]);
  assert.deepEqual(translator().learn('按钮_䶮䶮', 'btn_cute'), [['䶮䶮', 'cute']]);
});

test('learning: a restructured name is learned as a whole-name entry; no-ops learn nothing', () => {
  assert.deepEqual(translator().learn('聊天系统装饰图', 'chat_bubble_deco'), [['聊天系统装饰图', 'chat_bubble_deco']]);
  assert.deepEqual(translator().learn('按钮/确认', 'btn_confirm'), []);
  assert.deepEqual(translator().learn('按钮_䶮䶮', 'btn_䶮䶮䶮'), [], 'Chinese is never learned as a translation');
});

test('English mixed into a Chinese name keeps its case', () => {
  assert.equal(translator().translate('BtnOK确认').text, 'BtnOK_confirm');
});

test('a mixed English/Chinese correction is learned so the whole name comes back', () => {
  const user = {}, tr = t.create({user: () => user, builtin, dict: {}});
  assert.equal(tr.translate('Btn确认').text, 'Btn_confirm');
  tr.learn('Btn确认', 'Button_ok').forEach(([k, v]) => { user[k] = v; });
  assert.equal(tr.translate('Btn确认').text, 'Button_ok');
});

test('typed English and learned English use the same format (first and next export match)', () => {
  assert.equal(t.cleanEnglish('confirm button'), 'confirm_button');
  assert.equal(t.cleanEnglish('confirm-button'), 'confirm_button');
  const pairs = translator().learn('确认', 'confirm button');
  const user = t.loadGlossary(pairs.map(t.csvLine).join('\n'));
  assert.equal(translator(user).translate('确认').text, t.cleanEnglish('confirm button'));
});

test('changing several words at once is learned as the whole name, not word by word', () => {
  assert.deepEqual(translator().learn('按钮/确认', 'confirm_button'), [['按钮/确认', 'confirm_button']]);
  assert.deepEqual(translator().learn('头像闪光', 'shine_avatar'), [['头像闪光', 'shine_avatar']]);
});
