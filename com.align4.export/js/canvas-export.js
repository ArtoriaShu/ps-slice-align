'use strict';

// Full-document export has its own identity and PNG; it never borrows layer bounds/cache.
exports.run=function(o,request,callback){
  var finished=false,waiter=null,meta=null,editAtStart=null;
  var state={phase:'describe',attempt:0,directory:null,token:request.token,error:null};
  function quote(s){return JSON.stringify(s).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
  function finish(error,record){
    if(finished){return;}finished=true;if(waiter){waiter.cancel();}
    state.phase=error?'failed':'complete';state.error=error?String(error.message||error):null;callback(error,record);
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
      record={scope:'canvas',encoder:request.superPNG?'SuperPNG':'PNG',name:meta.name,width:w,height:h,originalWidth:meta.width,originalHeight:meta.height,prefix:request.prefix,fileName:'',successes:[],errors:[]};
    }catch(e){finish(e);return;}
    state.phase=request.superPNG?'superpng':'saving';
    o.encodePNG(data,request.superPNG,function(error,encoded){
      if(finished){return;}
      if(error){finish(error);return;}
      verify(function(){
        state.phase='saving';
        request.directories.forEach(function(target){
          try{var output=o.outputFiles.save(o.fs,o.path,o.png,target.path,exportName,encoded);output.directory=target.path;output.label=target.name;record.successes.push(output);}
          catch(e){record.errors.push({directory:target.path,label:target.name,message:String(e.message||e)});}
        });
        if(record.successes.length){record.fileName=o.path.basename(record.successes[0].path);}
        finish(null,record);
      });
    });
  }
  function attempt(){
    state.attempt=1;state.phase='waiting';
    waiter=o.nativeExport.run({fs:o.fs,path:o.path,os:o.os,png:o.png,host:o.host,now:o.now,setTimeout:o.setTimeout,clearTimeout:o.clearTimeout,log:o.log,job:o.job},{
      prefix:'align4-canvas-',label:'整图快速导出',onProgress:o.onProgress,
      script:function(dir){state.directory=dir;return 'Align4.startNativeCanvas('+quote(meta.token)+','+quote(dir)+')';},
      multipleMessage:'原生整图导出生成了多个 PNG（可能含多个画板），已停止保存。本按钮只导出单张完整画布。'},function(error,result){
      waiter=null;if(finished){return;}
      if(result){state.attempt=result.attempt;}
      if(error){finish(error);return;}
      verify(function(){save(result);});
    });
  }
  call('Align4.describeDocument()',function(current){
    if(!current.ok||current.token!==request.token){finish(new Error(current.ok?'当前文档已改变，请重新点击导出整个画布。':current.message));return;}
    meta=current;editAtStart=o.getEditSequence();attempt();
  });
  return {state:state,cancel:function(){
    if(finished){return;}finished=true;if(waiter){waiter.cancel();}
    state.phase='cancelled';
  }};
};
