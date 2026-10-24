'use strict';

// Full-document export has its own identity and PNG; it never borrows layer bounds/cache.
exports.run=function(o,request,callback){
  var finished=false,waiter=null,directory=null,meta=null,editAtStart=null;
  var state={phase:'describe',attempt:0,directory:null,token:request.token,error:null,retained:false};
  function quote(s){return JSON.stringify(s).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
  function remove(p){
    if(!p||!o.fs.existsSync(p)){return;}
    var stat=o.fs.lstatSync(p);
    if(stat.isDirectory()&&!stat.isSymbolicLink()){o.fs.readdirSync(p).forEach(function(n){remove(o.path.join(p,n));});o.fs.rmdirSync(p);}else{o.fs.unlinkSync(p);}
  }
  function clean(){try{remove(directory);}catch(ignore){}}
  function finish(error,record,retain){
    if(finished){return;}finished=true;if(waiter){waiter.cancel();}
    state.phase=error?'failed':'complete';state.error=error?String(error.message||error):null;state.retained=!!retain;
    if(!retain){clean();}callback(error,record);
  }
  function call(script,done){o.host(script,function(r){if(!finished){done(r);}});}
  function changed(current){
    return !current.ok||current.token!==meta.token||current.width!==meta.width||current.height!==meta.height||
      (meta.revision!=null&&current.revision!=null?meta.revision!==current.revision:o.getEditSequence()!==editAtStart);
  }
  function verify(done){
    state.phase='verify';call('Align4.describeDocument()',function(current){
      if(changed(current)){finish(new Error(current.ok?'画布或内容在导出过程中改变，已停止保存，请重新导出。':current.message));return;}
      done();
    });
  }
  function save(result){
    var record;
    try{
      if(result.measured.width!==meta.width||result.measured.height!==meta.height){throw new Error('原生输出尺寸与整个画布不一致，未保存。此文档可能使用了画板；本按钮要求单张完整画布。');}
      var w=o.rules.ceil4(result.measured.width),h=o.rules.ceil4(result.measured.height);
      if(!o.rules.valid(w,h,result.measured.width,result.measured.height)){throw new Error('画布尺寸超出支持范围。');}
      var name=request.name===null?o.outputFiles.normalizeName(meta.name):request.name;
      if(!name){throw new Error('请先在面板填写导出名称。');}
      var data=o.png.pad(result.data,w,h,request.anchor),exportName=o.outputFiles.nameFor(request.prefix,name);
      record={scope:'canvas',name:meta.name,width:w,height:h,originalWidth:meta.width,originalHeight:meta.height,prefix:request.prefix,fileName:'',successes:[],errors:[]};
      state.phase='saving';
      request.directories.forEach(function(target){
        try{var output=o.outputFiles.save(o.fs,o.path,o.png,target.path,exportName,data);output.directory=target.path;output.label=target.name;record.successes.push(output);}
        catch(e){record.errors.push({directory:target.path,label:target.name,message:String(e.message||e)});}
      });
      if(record.successes.length){record.fileName=o.path.basename(record.successes[0].path);}
    }catch(e){finish(e);return;}
    finish(null,record);
  }
  function attempt(number){
    state.attempt=number;state.phase='command';
    try{directory=o.fs.mkdtempSync(o.path.join(o.os.tmpdir(),'align4-canvas-'));state.directory=directory;}
    catch(e){finish(e);return;}
    call('Align4.startNativeCanvas('+quote(meta.token)+','+quote(directory)+')',function(started){
      if(!started.ok){finish(new Error(started.message),null,started.code==='ALIGN4_HOST_TIMEOUT');return;}
      state.phase='waiting';
      waiter=o.pngWait.wait({fs:o.fs,path:o.path,png:o.png,now:o.now,setTimeout:o.setTimeout,clearTimeout:o.clearTimeout,
        multipleMessage:'原生整图导出生成了多个 PNG（可能含多个画板），已停止保存。本按钮只导出单张完整画布。'},directory,function(error,result){
        waiter=null;
        if(error){
          if(error.code==='ALIGN4_TEMP_MISSING'&&number===1){verify(function(){clean();attempt(2);});return;}
          if(error.code==='ALIGN4_TEMP_MISSING'){error.message='整图临时目录再次丢失，已停止导出。';}
          finish(error,null,error.code==='ALIGN4_PNG_TIMEOUT');return;
        }
        verify(function(){save(result);});
      });
    });
  }
  call('Align4.describeDocument()',function(current){
    if(!current.ok||current.token!==request.token){finish(new Error(current.ok?'当前文档已改变，请重新点击导出整个画布。':current.message));return;}
    meta=current;editAtStart=o.getEditSequence();attempt(1);
  });
  return {state:state,cancel:function(){
    if(finished){return;}finished=true;if(waiter){waiter.cancel();}
    // The native command may still be writing. Do not delete its destination.
    state.retained=!!directory;state.phase='cancelled';
  }};
};
