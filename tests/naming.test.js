'use strict';
// Run the real panel handlers against a simulated CEP/Photoshop host.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const outputFiles = require('../com.align4.export/js/output-files');

function panel() {
  const nodes = {}, timers = new Map(), queries = [], saved = [];
  let selected = 'A', tick = 0, dir = 0;
  function node() {
    return {value:'', textContent:'', listeners:{}, appendChild(){}, removeChild(){},
      addEventListener(type, callback){this.listeners[type]=callback;}, focus(){},
      fire(type){if(this.listeners[type]) this.listeners[type]();}};
  }
  function meta(token = selected) {return {ok:true, token, name:'PS-' + token, kind:'图层', revision:'1'};}
  const bridge = {evalScript(script, callback) {
    if(script === 'Align4.selectionToken()') {
      // Capture selection at query time, but deliver later to exercise races.
      const result = meta(); queries.push(() => callback(JSON.stringify(result)));
    } else if(script === 'Align4.describeSelection()') callback(JSON.stringify(meta()));
    else if(script.startsWith('Align4.startNative(')) callback('{"ok":true}');
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
    window.testPanel={syncNaming:syncNaming,detect:detect,quickExport:quickExport,
      configure:function(o){fs=o.fs;path=o.path;os=o.os;png=o.png;pngWait=o.pngWait;
        outputFiles=o.outputFiles;outputDirectory='/exports';
        info={token:'A',name:'PS-A',width:4,height:4,revision:'1'};cache={data:'png'};
        el.width.value=4;el.height.value=4;syncNaming(info);},
      state:function(){return {name:el.exportName.value,token:namingToken,request:quickRequest};}};
  }());`;
  vm.runInContext(source,context);
  const api = context.window.testPanel;
  api.configure({path, os:{tmpdir:()=>'/tmp'},
    fs:{mkdtempSync:()=>'/tmp/mock-'+(++dir),existsSync:()=>false},
    png:{pad:()=>Buffer.from('png')},
    pngWait:{wait(options,directory,callback){callback(null,{data:'png',measured:{width:4,height:4,depth:8,color:6}});}},
    outputFiles:{...outputFiles,save(fs,path,png,directory,name){saved.push(name);return {path:directory+'/'+name+'.png',width:4,height:4};}}
  });
  return {api,nodes,saved,select(token){selected=token;},
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
