'use strict';

// Deliver a result once. Consumer callbacks must never be caught as read errors.
exports.wait = function (options, directory, callback) {
  var fs=options.fs,path=options.path,png=options.png,started=options.now(),timer=null,finished=false,lastError='';
  function finish(error,result){
    if(finished){return;}finished=true;if(timer!==null){options.clearTimeout(timer);timer=null;}
    callback(error,result);
  }
  function scan(dir,depth){
    var out=[];if(depth>4){return out;}
    fs.readdirSync(dir).forEach(function(name){
      var file=path.join(dir,name),stat;
      try{stat=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT'){return;}throw e;}
      if(stat.isDirectory()&&!stat.isSymbolicLink()){out=out.concat(scan(file,depth+1));}
      else if(stat.isFile()&&/\.png$/i.test(name)){out.push(file);}
    });return out;
  }
  function poll(){
    timer=null;if(finished){return;}var result=null,error=null;
    try{
      if(!fs.existsSync(directory)){
        error=new Error('临时导出目录已丢失。');error.code='ALIGN4_TEMP_MISSING';
      }else{
        var files=scan(directory,0);
        if(files.length>1){error=new Error(options.multipleMessage||'原生导出了多个 PNG，请每次只选一个对象。');}
        else if(files.length===1){var data=fs.readFileSync(files[0]);result={file:files[0],data:data,measured:png.parse(data)};}
      }
    }catch(e){
      lastError=String(e.message||e);
      if(!fs.existsSync(directory)){error=new Error('临时导出目录已丢失。');error.code='ALIGN4_TEMP_MISSING';}
      else if(e.code&&e.code!=='ENOENT'&&e.code!=='EBUSY'&&e.code!=='EPERM'){error=e;}
    }
    // Deliberately outside try: a caller exception cannot restart a completed job.
    if(error||result){finish(error,result);return;}
    if(options.now()-started>=20000){
      error=new Error('原生快速导出在 20 秒内没有生成完整 PNG。'+(lastError?'文件读取信息：'+lastError:'导出目录存在，但未发现完整 PNG。'));
      error.code='ALIGN4_PNG_TIMEOUT';finish(error);return;
    }
    timer=options.setTimeout(poll,100);
  }
  // Defer the first read so callers can register the job before completion.
  timer=options.setTimeout(poll,0);
  return {cancel:function(){finished=true;if(timer!==null){options.clearTimeout(timer);timer=null;}}};
};
