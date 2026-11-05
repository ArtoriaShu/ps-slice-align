'use strict';
// Run the real panel handlers against a simulated CEP/Photoshop host.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const outputFiles = require('../com.align4.export/js/output-files');

function panel(options = {}) {
  const nodes = {}, timers = new Map(), queries = [], saved = [], encodings = [], commands = [];
  let selected = 'A', tick = 0, dir = 0;
  function node() {
    return {value:'', textContent:'', listeners:{}, appendChild(){}, removeChild(){},
      addEventListener(type, callback){this.listeners[type]=callback;}, focus(){},
      fire(type){if(this.listeners[type]) this.listeners[type]();}};
  }
  function meta(token = selected) {return {ok:true, token, name:'PS-' + token, kind:'图层', revision:'1'};}
  const bridge = {evalScript(script, callback) {
    commands.push(script);
    if(script === 'Align4.selectionToken()') {
      // Capture selection at query time, but deliver later to exercise races.
      const result = meta(); queries.push(() => callback(JSON.stringify(result)));
    } else if(script === 'Align4.describeSelection()') callback(JSON.stringify(meta()));
    else if(script === 'Align4.describeDocument()') callback(JSON.stringify({...meta('canvas'),width:4,height:4}));
    else if(script.startsWith('Align4.startNative(')||script.startsWith('Align4.startNativeCanvas(')) callback('{"ok":true}');
    else throw Error(script);
  }};
  const context = vm.createContext({
    window:{__adobe_cep__:bridge, Align4Rules:require('../com.align4.export/js/rules'),
      addEventListener(){}, setTimeout(fn, delay){timers.set(++tick,{fn,delay});return tick;},
      clearTimeout(id){timers.delete(id);}},
    document:{hidden:false, getElementById(id){return nodes[id]||(nodes[id]=node());},
      createElement:node, addEventListener(){}},
    JSON, Date, Error
  });
  let source = fs.readFileSync(path.join(__dirname,'../com.align4.export/js/panel.js'),'utf8');
  source = source.slice(0,source.lastIndexOf('  try{\n    var rq=')) + `
    window.testPanel={syncNaming:syncNaming,detect:detect,quickExport:quickExport,save:save,quickCanvas:quickCanvas,startPolling:startPolling,onEvent:onEvent,cleanup:cleanup,
      configure:function(o){fs=o.fs;path=o.path;os=o.os;png=o.png;pngWait=o.pngWait;
        outputFiles=o.outputFiles;superPNG=o.superPNG;canvasExporter=o.canvasExporter;canvasDirectory='/canvas';outputDirectory='/exports';eventMap={'1':false,'2':true};
        info={token:'A',name:'PS-A',width:4,height:4,revision:'1'};cache={data:'png'};
        el.width.value=4;el.height.value=4;syncNaming(info);},
      state:function(){return {name:el.exportName.value,token:namingToken,request:quickRequest};}};
  }());`;
  vm.runInContext(source,context);
  const api = context.window.testPanel;
  api.configure({path, os:{tmpdir:()=>'/tmp'},
    superPNG:{encode(o,data,enabled,callback){encodings.push(data);options.encode?options.encode(callback):callback(null,'SuperPNG bytes');}},
    canvasExporter:require('../com.align4.export/js/canvas-export'),
    fs:{mkdtempSync:()=>'/tmp/mock-'+(++dir),existsSync:()=>false},
    png:{pad:()=>Buffer.from('png')},
    pngWait:{wait(options,directory,callback){callback(null,{data:'png',measured:{width:4,height:4,depth:8,color:6}});}},
    outputFiles:{...outputFiles,save(fs,path,png,directory,name,data){saved.push(name);if(options.superPNG)assert.equal(data,'SuperPNG bytes');return {path:directory+'/'+name+'.png',width:4,height:4};}}
  });
  nodes.superPNG.checked=!!options.superPNG;
  return {api,nodes,saved,encodings,commands,select(token){selected=token;},
    poll(){const entry=[...timers].find(([,v])=>v.delay>=1200&&v.delay<25000);assert.ok(entry);timers.delete(entry[0]);entry[1].fn();},
    hidden(value){context.document.hidden=value;},
    edit(value,type='input'){nodes.exportName.value=value;nodes.exportName.fire(type);},
    reply(index=0){assert.ok(queries.length);queries.splice(index,1)[0]();},
    flush(){let count=0;while(true){const entry=[...timers].find(([,v])=>v.delay<1000);if(!entry)break;
      assert.ok(++count<50,'timer loop');timers.delete(entry[0]);entry[1].fn();}},
    queryCount:()=>queries.length};
}

test('switch layer, type, and export immediately without refresh', () => {
  const p=panel();p.select('B');p.edit('自定义-B');
  p.api.quickExport([{path:'/exports'}]);
  assert.equal(p.queryCount(),1,'export waits for name ownership');
  p.reply();p.reply();p.flush();
  assert.deepEqual(p.saved,['自定义-B']);
  assert.equal(p.nodes.exportName.value,'自定义-B');
});

test('metadata arriving before the name query must preserve the draft', () => {
  const p=panel();p.select('B');p.edit('custom');
  p.api.syncNaming({token:'B',name:'PS-B'});
  assert.equal(p.nodes.exportName.value,'custom');
  p.reply();p.flush();
  assert.equal(p.nodes.exportName.value,'custom');
});

test('an old custom name is not reused after a later selection change', () => {
  const p=panel();p.edit('custom-A');p.reply();p.select('B');
  p.nodes.exportName.fire('blur');p.nodes.exportName.fire('keyup');
  assert.equal(p.queryCount(),0,'non-edit events must not rebind the name');
  p.api.quickExport([{path:'/exports'}]);p.reply();p.flush();
  assert.deepEqual(p.saved,['PS-B']);
});

test('out of order query replies cannot replace the latest edit', () => {
  const p=panel();p.edit('custom-A');p.select('B');p.edit('custom-B','compositionend');
  p.reply(1);p.reply();p.flush();
  p.api.quickExport([{path:'/exports'}]);p.reply();p.flush();
  assert.deepEqual(p.saved,['custom-B']);
});

test('selection changing while name ownership is pending clears the stale draft', () => {
  const p=panel();p.edit('custom-A');p.select('B');
  p.api.syncNaming({token:'B',name:'PS-B'});p.reply();p.flush();
  assert.equal(p.nodes.exportName.value,'PS-B');
});

test('explicitly cleared name stays empty on a newly selected layer', () => {
  const p=panel();p.select('B');p.edit('');p.reply();p.flush();
  p.api.quickExport([{path:'/exports'}]);p.reply();p.flush();
  assert.deepEqual(p.saved,[]);
  assert.match(p.nodes.status.textContent,/填写导出名称/);
});

test('a selection change after clicking export cannot save the wrong layer', () => {
  const p=panel();p.select('B');p.edit('custom-B');p.reply();
  p.api.quickExport([{path:'/exports'}]);p.select('C');p.reply();p.flush();
  assert.deepEqual(p.saved,[]);
  assert.match(p.nodes.status.textContent,/选择已改变/);
});

test('reset to layer name cancels an outstanding custom-name query', () => {
  const p=panel();p.edit('custom-A');p.nodes.resetName.fire('click');
  p.reply();p.flush();
  p.api.quickExport([{path:'/exports'}]);p.reply();p.flush();
  assert.deepEqual(p.saved,['PS-A']);
});

for(const route of ['quick','manual','canvas']){
  test(route+' export routes padded data through SuperPNG before saving',()=>{
    const p=panel({superPNG:true});
    if(route==='quick'){p.api.quickExport([{path:'/preset'}]);p.reply();}
    else if(route==='manual')p.api.save();
    else p.api.quickCanvas();
    p.flush();assert.equal(p.encodings.length,1);assert.equal(p.saved.length,1);
    assert.equal(p.encodings[0].toString(),'png');
  });
}

test('queued export snapshots the SuperPNG option and keeps controls locked until encoding finishes',()=>{
  let complete;
  const p=panel({superPNG:true,encode(callback){complete=callback;}});
  p.api.quickExport([{path:'/preset'}]);
  p.nodes.superPNG.checked=false; // Programmatic change simulates stale UI state.
  p.reply();p.flush();assert.equal(p.encodings.length,1);
  assert.equal(p.saved.length,0);assert.equal(p.nodes.quick.disabled,true);assert.equal(p.nodes.superPNG.disabled,true);
  complete(null,'SuperPNG bytes');p.flush();assert.equal(p.saved.length,1);assert.equal(p.nodes.superPNG.disabled,false);
});

test('SuperPNG failure does not publish ordinary PNG as a successful export',()=>{
  const p=panel({superPNG:true,encode(callback){callback(Error('SuperPNG missing'));}});
  p.api.quickExport([{path:'/preset'}]);p.reply();p.flush();
  assert.equal(p.saved.length,0);assert.match(p.nodes.result.textContent,/SuperPNG missing/);
  assert.equal(p.nodes.quick.disabled,false);
});

test('source selection changes during SuperPNG conversion prevent final publication',()=>{
  let complete;
  const p=panel({superPNG:true,encode(callback){complete=callback;}});
  p.api.quickExport([{path:'/preset'}]);p.reply();p.flush();p.select('B');
  complete(null,'SuperPNG bytes');p.flush();assert.equal(p.saved.length,0);
  assert.match(p.nodes.result.textContent,/选择或内容已改变/);
});

test('canvas conversion failure produces no final file',()=>{
  const p=panel({superPNG:true,encode(callback){callback(Error('canvas SuperPNG failed'));}});
  p.api.quickCanvas();p.flush();assert.equal(p.saved.length,0);
  assert.match(p.nodes.status.textContent,/canvas SuperPNG failed/);
});

test('ordinary canvas export skips SuperPNG',()=>{
  const p=panel();p.api.quickCanvas();p.flush();
  assert.equal(p.encodings.length,0);assert.equal(p.saved.length,1);
});

test('selection polling recovers lost notifications without starting native PNG export',()=>{
  const p=panel();p.api.startPolling();p.select('B');p.poll();
  assert.equal(p.nodes.name.textContent,'PS-B');assert.equal(p.nodes.exportName.value,'PS-B');
  p.select('C');p.poll();assert.equal(p.nodes.name.textContent,'PS-C');
  assert.equal(p.commands.filter(s=>s.startsWith('Align4.startNative')).length,0);
});

test('typing and refresh only query metadata; target size survives repeated polling',()=>{
  const p=panel();p.select('B');p.api.detect(false);p.edit('custom-B');p.reply();p.flush();
  p.nodes.width.value=100;p.nodes.height.value=104;p.nodes.refresh.fire('click');
  p.api.startPolling();p.poll();p.poll();
  assert.equal(p.nodes.width.value,100);assert.equal(p.nodes.height.value,104);
  assert.equal(p.nodes.exportName.value,'custom-B');
  assert.equal(p.commands.filter(s=>s.startsWith('Align4.startNative')).length,0);
});

test('event bursts coalesce and update selection without rendering',()=>{
  const p=panel();p.select('B');
  for(let i=0;i<100;i++)p.api.onEvent({data:'ver1,{"eventID":1}'});
  p.flush();assert.equal(p.nodes.name.textContent,'PS-B');
  assert.equal(p.commands.filter(s=>s==='Align4.describeSelection()').length,1);
  assert.equal(p.commands.filter(s=>s.startsWith('Align4.startNative')).length,0);
});

test('polling pauses while hidden or converting SuperPNG',()=>{
  let complete;const p=panel({superPNG:true,encode(callback){complete=callback;}});
  p.api.startPolling();p.hidden(true);p.poll();assert.equal(p.commands.length,0);
  p.hidden(false);p.api.quickExport([{path:'/preset'}]);p.reply();p.flush();
  const count=p.commands.length;p.poll();assert.equal(p.commands.length,count);
  complete(null,'SuperPNG bytes');p.flush();assert.equal(p.saved.length,1);
});

test('manual size export works after lightweight recognition without prior rendering',()=>{
  const p=panel();p.select('B');p.api.detect(false);
  p.nodes.width.value=8;p.nodes.height.value=8;p.api.save();p.flush();
  assert.deepEqual(p.saved,['PS-B']);
  assert.equal(p.commands.filter(s=>s.startsWith('Align4.startNative(')).length,1);
});

test('quick export preserves a target size entered after lightweight recognition',()=>{
  const p=panel();p.select('B');p.api.detect(false);
  p.nodes.width.value=100;p.nodes.height.value=104;
  p.api.quickExport([{path:'/preset'}]);p.reply();p.flush();
  assert.equal(p.nodes.width.value,100);assert.equal(p.nodes.height.value,104);
  assert.deepEqual(p.saved,['PS-B']);
});
