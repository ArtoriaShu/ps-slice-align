'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const zlib=require('node:zlib');
const png=require('../com.align4.export/js/png-padding');
const encoder=require('../com.align4.export/js/superpng');
const files=require('../com.align4.export/js/output-files');

function image(width,height,tag){
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const rows=Buffer.alloc((width*4+1)*height);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),png.chunk('IHDR',header),
    png.chunk('tEXt',Buffer.from('encoder\0'+tag)),png.chunk('IDAT',zlib.deflateSync(rows)),png.chunk('IEND',Buffer.alloc(0))]);
}

function environment(t,run){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'align4-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {fs,path,png,os:{tmpdir:()=>root},host(script,callback){
    const args=JSON.parse('['+script.slice(script.indexOf('(')+1,-1)+']');
    run(args,callback,root);
  },root};
}
function encode(o,data,enabled=true){return new Promise(resolve=>encoder.encode(o,data,enabled,(error,data)=>resolve({error,data})));}

test('SuperPNG receives padded dimensions; final bytes and collision numbering survive publication',async t=>{
  const converted=image(8,4,'SuperPNG');
  const o=environment(t,([input,output],callback)=>{
    const measured=png.parse(fs.readFileSync(input));assert.equal(measured.width,8);assert.equal(measured.height,4);
    fs.writeFileSync(output,converted);callback({ok:true});
  });
  const padded=png.pad(image(5,3,'native'),8,4,'center');
  const result=await encode(o,padded);assert.ifError(result.error);assert.deepEqual(result.data,converted);
  assert.deepEqual(fs.readdirSync(o.root),[],'conversion temporaries removed');
  fs.writeFileSync(path.join(o.root,'名称.png'),'existing');
  const saved=files.save(fs,path,png,o.root,'名称',result.data);
  assert.equal(path.basename(saved.path),'名称-2.png');assert.deepEqual(fs.readFileSync(saved.path),converted);
  assert.equal(fs.readFileSync(path.join(o.root,'名称.png'),'utf8'),'existing');
});

test('disabled option returns the original bytes without invoking Photoshop',async()=>{
  const data=image(4,4,'native');const result=await encode({},data,false);
  assert.ifError(result.error);assert.equal(result.data,data);
});

test('missing SuperPNG reports failure and cleans temporary files',async t=>{
  const o=environment(t,(args,callback)=>callback({ok:false,message:'plugin missing'}));
  const result=await encode(o,image(4,4,'native'));
  assert.match(result.error.message,/plugin missing/);assert.equal(result.data,undefined);
  assert.deepEqual(fs.readdirSync(o.root),[]);
});

for(const kind of ['wrong size','truncated','interlaced']){
  test('reject '+kind+' output before publication',async t=>{
    const o=environment(t,([input,output],callback)=>{
      let data=image(kind==='wrong size'?8:4,4,'SuperPNG');
      if(kind==='truncated')data=data.subarray(0,data.length-12);
      if(kind==='interlaced'){
        const parsed=png.parse(data),header=Buffer.from(parsed.header);header[12]=1;
        data=Buffer.concat([data.subarray(0,8),png.chunk('IHDR',header),data.subarray(33)]);
      }
      fs.writeFileSync(output,data);callback({ok:true});
    });
    const result=await encode(o,image(4,4,'native'));assert.ok(result.error);assert.deepEqual(fs.readdirSync(o.root),[]);
  });
}

test('host timeout retains in-flight temporary files instead of deleting them',async t=>{
  const o=environment(t,(args,callback)=>callback({ok:false,code:'ALIGN4_HOST_TIMEOUT',message:'timeout'}));
  const result=await encode(o,image(4,4,'native'));
  assert.match(result.error.message,/临时目录已保留/);
  assert.equal(fs.readdirSync(o.root).length,1);
});

function photoshop(fail){
  const original={name:'original PSD'},created=new Set(['input.png']),descriptors=[];
  let closed=0;
  const app={documents:[original],activeDocument:original,displayDialogs:'original dialogs',
    open(file,mode){assert.equal(mode,'built-in PNG');return {close(save){assert.equal(save,'discard');closed++;}};}};
  function File(name){this.name=name;}
  Object.defineProperty(File.prototype,'exists',{get(){return created.has(this.name);}});
  function Descriptor(){this.values={};descriptors.push(this);}
  for(const method of ['putInteger','putBoolean','putEnumerated','putObject','putPath']){
    Descriptor.prototype[method]=function(key,...values){this.values[key]=values;};
  }
  const context=vm.createContext({app,File,ActionDescriptor:Descriptor,charIDToTypeID:s=>s,stringIDToTypeID:s=>s,
    OpenDocumentType:{PNG:'built-in PNG'},DialogModes:{NO:'no dialogs'},SaveOptions:{DONOTSAVECHANGES:'discard'},
    executeAction(command,desc,dialogs){
      assert.equal(command,'save');assert.notEqual(app.activeDocument,original);assert.equal(dialogs,'no dialogs');
      if(fail)throw Error('SuperPNG unavailable');created.add(desc.values['In  '][0].name);
    }});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../com.align4.export/host/host.jsx'),'utf8'),context);
  return {app,original,descriptors,created,closed:()=>closed,convert:()=>JSON.parse(context.Align4.convertSuperPNG('input.png','output.png'))};
}

test('host uses exact SuperPNG settings and restores the original PSD and dialogs',()=>{
  const h=photoshop(false);assert.equal(h.convert().ok,true);
  const [options,save]=h.descriptors;
  assert.equal(save.values['As  '][0],'fnord SuperPNG');
  assert.deepEqual(options.values.pngC,[9]);assert.deepEqual(options.values.pngF,[248]);assert.deepEqual(options.values.pngS,[0]);
  assert.deepEqual(options.values.pngA,['alfT','alfT']);
  for(const [key,value] of Object.entries({pngQ:false,pngX:true,pngI:false,pngM:true}))assert.deepEqual(options.values[key],[value]);
  assert.equal(h.closed(),1);assert.equal(h.app.activeDocument,h.original);assert.equal(h.app.displayDialogs,'original dialogs');
});

test('host restores PSD and dialogs even when the SuperPNG save command fails',()=>{
  const h=photoshop(true);const result=h.convert();assert.equal(result.ok,false);assert.match(result.message,/SuperPNG unavailable/);
  assert.equal(h.closed(),1);assert.equal(h.app.activeDocument,h.original);assert.equal(h.app.displayDialogs,'original dialogs');
});

test('host refuses an existing output before opening any temporary document',()=>{
  const h=photoshop(false);h.created.add('output.png');assert.equal(h.convert().ok,false);
  assert.equal(h.closed(),0);assert.equal(h.app.activeDocument,h.original);
});

test('full panel startup loads the encoder and persists the SuperPNG checkbox across restarts',t=>{
  const storage=new Map(),logs=fs.mkdtempSync(path.join(os.tmpdir(),'align4-logtest-'));
  process.env.ALIGN4_LOG_DIR=logs;t.after(()=>{delete process.env.ALIGN4_LOG_DIR;fs.rmSync(logs,{recursive:true,force:true});});
  function boot(){
    const nodes={};
    function node(){return {value:'',textContent:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},appendChild(){}};}
    const context=vm.createContext({JSON,Date,Error,
      document:{getElementById(id){return nodes[id]||(nodes[id]=node());},createElement:node,addEventListener(){}},
      window:{addEventListener(){},setTimeout(){return 1;},clearTimeout(){},cep_node:{require},
        localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
        __adobe_cep__:{getSystemPath:()=>path.resolve(__dirname,'../com.align4.export'),resizeContent(){},
          addEventListener(){},dispatchEvent(){},evalScript(script,callback){
            assert.equal(script,'Align4.eventIDs()');callback('{"ok":true,"events":[]}');
          }}}
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../com.align4.export/js/panel.js'),'utf8'),context);
    assert.doesNotMatch(nodes.status.textContent,/模块未加载/);
    assert.equal(nodes.version.textContent,'v1.12.0');
    return nodes.superPNG;
  }
  let checkbox=boot();assert.equal(checkbox.checked,false);
  checkbox.checked=true;checkbox.listeners.change();assert.equal(storage.get('align4-superpng'),'1');
  checkbox=boot();assert.equal(checkbox.checked,true);
  checkbox.checked=false;checkbox.listeners.change();assert.equal(boot().checked,false);
  const written=fs.readdirSync(logs);assert.equal(written.length,1);
  assert.match(fs.readFileSync(path.join(logs,written[0]),'utf8'),/panel\.start/);
});
