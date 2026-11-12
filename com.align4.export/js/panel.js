(function () {
  'use strict';
  var ids=['kind','name','original','status','width','height','align','anchor','padding','export','refresh','result','diagnose','debug','folder','directory','quick','addPreset','presets','presetCount','report','reportIcon','reportTitle','reportSummary','reportSize','reportList','reportDetails','restoreSize','directoryName','presetPrev','presetNext','presetPage','prefix','clearPrefix','fileName','exportName','resetName','canvas','canvasFolder','canvasDirectory','canvasDirectoryName','superPNG','version','logPanel','logList','logClose','logCopy','logFolder','logVerbose','logNote'],el={};
  ids.forEach(function(id){el[id]=document.getElementById(id);});
  var VERSION='1.12.0',rules=window.Align4Rules,bridge=window.__adobe_cep__,fs,path,os,env={},png,nativeExport,diagnostics,loggerModule,outputFiles,canvasExporter,superPNG,outputDirectory='',canvasDirectory='',choosingFolder=false,presets=[],presetViews=[],presetPage=0,presetPageSize=(window.innerHeight&&window.innerHeight>=580)?3:2,quickRequest=null,canvasRequest=null,lastCanvas=null,lastExport=null,Buffer;
  var info=null,cache=null,dirty=false,editSequence=0,sequence=0,rendering=false,saving=false,checking=false,pending=false,pendingForce=false;
  var namingToken=null,nameSource='',nameEdited=false,nameDraft=null,nameValue='';
  var logger={debug:function(){},info:function(){},warn:function(){},error:function(){},entries:function(){return [];},onEntry:function(){},file:function(){return null;},dir:null},jobId=0,job=null,jobStarted=0,lastSelectionLogged=null;
  var timer=null,pollTimer=null,pollDelay=1200,eventMap={},registered=[],listeners=[],activeJob=null,lastNative=null,lastFailure=null,closing=false,extensionId='com.align4.export.panel',appId='PHXS',windowSizeRequest=null;
  function setText(node,text){if(node.textContent!==text){node.textContent=text;}}
  function message(text,kind){el.status.textContent=text;el.status.title=text;el.status.className='status '+(kind||((rendering||saving)?'working':''));}
  function showReport(record){
    var success=record.successes||[],errors=record.errors||[],state=record.message?'error':errors.length?(success.length?'partial':'error'):'success';
    el.report.hidden=false;el.report.className='report '+state;
    el.reportIcon.textContent=state==='success'?'✓':state==='partial'?'!':'×';
    el.reportTitle.textContent=record.message?'操作未完成':state==='success'?(record.scope==='canvas'?'整图已导出':'已导出'):state==='partial'?'部分已导出':'导出失败';
    el.reportSummary.textContent=record.message||(((record.fileName||record.name)?(record.fileName||record.name)+' · ':'')+'成功 '+success.length+' 个目录'+(errors.length?'，失败 '+errors.length+' 个':''));
    el.reportSummary.title=el.reportSummary.textContent;el.reportDetails.disabled=!(success.length||errors.length);el.reportList.hidden=true;el.reportDetails.textContent='详情';
    el.reportSize.textContent=record.width&&record.height?record.width+' × '+record.height:'';
    while(el.reportList.firstChild){el.reportList.removeChild(el.reportList.firstChild);}
    function row(title,detail,ok,directory){
      var item=document.createElement('div'),icon=document.createElement('span'),copy=document.createElement('div'),name=document.createElement('p'),location=document.createElement('p');
      item.className='report-item'+(ok?'':' failed');icon.className='report-item-icon';icon.textContent=ok?'✓':'×';copy.className='report-item-copy';name.className='report-file';name.textContent=title;name.title=title;location.className='report-path';location.textContent=detail;location.title=detail;
      copy.appendChild(name);copy.appendChild(location);item.appendChild(icon);item.appendChild(copy);
      if(ok&&directory){var open=document.createElement('button');open.className='report-open';open.textContent='打开 ↗';open.title='打开保存目录';open.addEventListener('click',function(){host('Align4.openFolder('+quote(directory)+')',function(r){if(!r.ok){message(r.message,'error');}});});item.appendChild(open);}
      el.reportList.appendChild(item);
    }
    success.forEach(function(output){row(path.basename(output.path),output.path,true,output.directory||path.dirname(output.path));});
    errors.forEach(function(error){row(error.label||error.directory||'未保存',error.message,false);});
    presetViews.forEach(function(v){v.row.className='preset'+(success.some(function(o){return String(o.directory||path.dirname(o.path)).toLowerCase()===String(v.directory).toLowerCase();})?' active':'');});
  }
  function quote(v){return JSON.stringify(v).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
  var QUIET=/^Align4\.(describeSelection|selectionToken)\(/;
  function host(script,callback,timeout){
    if(!bridge){callback({ok:false,message:'请从 Photoshop 中打开插件。'});return;}
    var name=script.slice(0,script.indexOf('(')),t0=Date.now(),quiet=QUIET.test(script),inner=callback;
    callback=function(r){
      var ms=Date.now()-t0;
      if(!r||!r.ok){if(!(r&&r.cancelled)){logger.warn('host',name+' 失败（'+ms+'ms）',{code:r&&r.code,message:r&&r.message},job);}}
      else if(!quiet||ms>1000){logger.debug('host',name+' 完成（'+ms+'ms）',undefined,job);}
      inner(r);
    };
    var delivered=false,watchdog=timeout===0?null:window.setTimeout(function(){deliver({ok:false,code:'ALIGN4_HOST_TIMEOUT',message:'Photoshop 脚本在 25 秒内未响应，已停止等待。可查看诊断信息或重启 PS 后重试。'});},25000);
    function deliver(r){if(delivered){return;}delivered=true;if(watchdog!==null){window.clearTimeout(watchdog);}if(!closing){callback(r);}}
    try{bridge.evalScript(script,function(raw){var r;try{r=JSON.parse(raw);}catch(e){r={ok:false,message:'宿主脚本连接失败，请重启 Photoshop。'};}deliver(r);});}
    catch(e){if(delivered){throw e;}deliver({ok:false,message:String(e.message||e)});}
  }
  function normalizedName(){return outputFiles?outputFiles.normalizeName(el.exportName.value):String(el.exportName.value||'');}
  function syncNaming(meta){
    if(namingToken!==meta.token||nameDraft){
      namingToken=meta.token;
      // A draft belongs to the selection observed when typing, not the last
      // rendered thumbnail. Keep it while that lightweight query is pending.
      nameEdited=!!nameDraft&&(nameDraft.pending||nameDraft.token===meta.token);
      if(!nameEdited){nameDraft=null;}
    }
    nameSource=outputFiles.normalizeName(meta.name);
    if(!nameEdited){el.exportName.value=nameSource;nameValue=el.exportName.value;}
  }
  function sourceDescription(){
    el.original.textContent='原始尺寸 '+info.width+' × '+info.height+' px';el.original.title=el.original.textContent;
  }
  function controls(){
    var blocked=rendering||saving||checking||pending||choosingFolder||!!quickRequest||!!canvasRequest;
    el.superPNG.disabled=blocked;el.refresh.disabled=blocked;el.diagnose.disabled=false;el.folder.disabled=blocked;
    var nameMissing=!!namingToken&&!normalizedName();
    var quickBlocked=saving||choosingFolder||!!quickRequest||!!canvasRequest||nameMissing;
    el.quick.disabled=!outputDirectory||quickBlocked;el.canvas.disabled=!canvasDirectory||!canvasExporter||saving||choosingFolder||!!quickRequest||!!canvasRequest;setText(el.canvas,canvasRequest?'整图导出中…':'导出整个画布 ↗');el.addPreset.disabled=blocked;
    el.presetCount.textContent=presets.length;el.canvasFolder.disabled=blocked;
    el.canvasDirectoryName.textContent=canvasDirectory?(path.basename(canvasDirectory)||canvasDirectory):'先添加目录';el.canvasDirectoryName.title=canvasDirectory;el.canvasDirectory.textContent=canvasDirectory||'与右侧切图目录独立';el.canvasDirectory.title=canvasDirectory;el.canvasFolder.textContent=canvasDirectory?'更换':'＋ 添加';el.canvas.title=canvasDirectory?'导出完整画布到 '+canvasDirectory:'请先在上方添加整图目录';
    setText(el.quick,quickRequest?'导出中…':outputDirectory?'导出切图 ↗':'先选择导出目录');el.quick.title=outputDirectory;el.directoryName.textContent=outputDirectory?(path.basename(outputDirectory)||outputDirectory):'先选择导出目录';el.directoryName.title=outputDirectory;
    var pageCount=Math.max(1,Math.ceil(presets.length/presetPageSize));el.presetPrev.disabled=blocked||presetPage===0;el.presetNext.disabled=blocked||presetPage>=pageCount-1;el.presetPage.textContent=(presetPage+1)+' / '+pageCount;
    presetViews.forEach(function(v){v.quick.disabled=quickBlocked;v.name.disabled=blocked;v.remove.disabled=blocked;});
    el.align.disabled=!info||blocked;el.export.disabled=!namingToken||!outputDirectory||blocked||nameMissing||!rules.valid(Number(el.width.value),Number(el.height.value),info?info.width:1,info?info.height:1);
    el.width.disabled=blocked;el.height.disabled=blocked;el.anchor.disabled=blocked;
    // Metadata notifications can arrive as focus returns from the CEP text editor.
    // Keep typing intact during the debounce/query; lock only real render/save work.
    var namingBlocked=rendering||saving||choosingFolder||!!quickRequest||!!canvasRequest;
    el.prefix.disabled=namingBlocked;el.clearPrefix.disabled=namingBlocked||!el.prefix.value;
    el.exportName.disabled=namingBlocked||!namingToken;el.resetName.disabled=namingBlocked||!namingToken||el.exportName.value===nameSource;
    el.fileName.textContent=namingToken&&outputFiles?(nameMissing?'请填写导出名称':outputFiles.nameFor(el.prefix.value,normalizedName())+'.png'):'选择对象后显示文件名';
    el.fileName.title=el.fileName.textContent+'；同名文件保留并自动追加编号。';
    var sourceSize=document.getElementById('sourceSize'),targetSize=document.getElementById('targetSize');
    if(sourceSize){sourceSize.textContent=info?info.width+' × '+info.height:'— × —';}
    if(targetSize){targetSize.textContent=info?rules.ceil4(Math.max(info.width,Number(el.width.value)||0))+' × '+rules.ceil4(Math.max(info.height,Number(el.height.value)||0)):'— × —';}
    if(!info||blocked){return;}
    if(nameMissing){message('请填写导出名称，再点击导出。','warning');return;}
    var w=Number(el.width.value),h=Number(el.height.value);
    if(!rules.valid(w,h,info.width,info.height)){message('一键导出将向上补齐为 '+rules.ceil4(Math.max(w||0,info.width))+' × '+rules.ceil4(Math.max(h||0,info.height))+' px。','warning');el.padding.textContent='新增透明边缘，不缩放图像。';}
    else{var p=rules.padding(w,h,info.width,info.height,el.anchor.value);message(dirty?'内容已更新，导出时会重新读取。':'尺寸就绪，保持图像大小。',dirty?'warning':'ok');el.padding.textContent='透明留白：左 '+p.left+' / 右 '+p.right+' / 上 '+p.top+' / 下 '+p.bottom+' px。';}
  }
  function schedule(force){
    if(canvasRequest){pending=true;pendingForce=pendingForce||!!force;return;}
    if(closing||saving||choosingFolder){return;}pending=true;pendingForce=pendingForce||!!force;controls();
    if(document.hidden){return;}if(timer!==null){return;}
    timer=window.setTimeout(function(){timer=null;if(rendering||checking){return;}var f=pendingForce;pending=false;pendingForce=false;detect(f);},220);
  }
  function settle(){rendering=false;checking=false;controls();if(pending&&!saving){schedule(pendingForce);}if(quickRequest&&!quickRequest.running){window.setTimeout(drainQuick,0);}if(canvasRequest&&!canvasRequest.running){window.setTimeout(drainCanvas,0);}}
  function fail(text){logger.error('fail',text,undefined,job);message(text,'error');el.result.textContent=text;showReport({message:text});}
  function startJob(kind,data){
    job=++jobId;jobStarted=Date.now();
    logger.info('export.start','开始'+kind,data,job);
  }
  function endJob(result){
    if(job===null){return;}
    logger.info('export.end',result+'，总用时 '+((Date.now()-jobStarted)/1000).toFixed(1)+'s',undefined,job);job=null;
  }
  function progress(p){
    var s=Math.round(p.elapsed/1000);
    message('等待 Photoshop 生成 PNG… '+s+' 秒'+(p.attempts>1?'（已自动重发 '+(p.attempts-1)+' 次）':'')+(p.fileSeen?'，文件写入中':''),'working');
  }
  function invalidate(){info=null;namingToken=null;nameSource='';nameEdited=false;nameDraft=null;nameValue='';el.exportName.value='';el.original.textContent='未取得原生 PNG 的实际尺寸';el.width.value='';el.height.value='';}
  function detect(force,after){
    if(closing){return;}if(!force&&(saving||canvasRequest||choosingFolder)){return;}if(rendering||checking){pending=true;pendingForce=pendingForce||force;return;}
    checking=true;controls();
    host('Align4.describeSelection()',function(meta){
      if(!meta.ok){pollDelay=5000;invalidate();pending=false;pendingForce=false;settle();if(force){fail(meta.message);}else{message(meta.message,'warning');}if(after){after(false);}return;}
      pollDelay=1200;
      var selectionChanged=namingToken!==meta.token;
      if(lastSelectionLogged!==meta.token){lastSelectionLogged=meta.token;logger.info('selection','选中 '+meta.kind+'「'+meta.name+'」',{token:meta.token,revision:meta.revision});}
      syncNaming(meta);
      el.kind.textContent=meta.kind;el.name.textContent=meta.name;el.name.title=meta.name;
      // Selection tracking must never invoke Generator. Actual dimensions are
      // measured only for an explicit export, from the resulting PNG.
      if(!force){
        if(!info||info.token!==meta.token){
          info=null;cache=null;dirty=false;if(selectionChanged){el.width.value='';el.height.value='';}
          el.original.textContent='已识别当前对象，导出时读取实际尺寸';
          el.padding.textContent='可填写目标尺寸；实际尺寸在导出时校验。';
        }else{
          if(meta.revision!=null&&info.revision!=null&&meta.revision!==info.revision){dirty=true;}
          info.name=meta.name;sourceDescription();
        }
        settle();if(!info){message('已识别，可直接输入名称并导出。','ok');}if(after){after(true);}return;
      }
      lastFailure=null;var requestEdit=editSequence;
      checking=false;rendering=true;controls();el.kind.textContent=meta.kind;el.name.textContent=meta.name;el.name.title=meta.name;message('正在读取选中对象的尺寸…','working');
      function complete(error,result,dir,current){
        activeJob=null;if(closing){return;}
        if(!current.ok||current.token!==meta.token){
          dirty=true;settle();if(after){after(false);}
          if(current.ok){schedule(false);}else{lastFailure={token:meta.token,message:current.message};invalidate();fail(current.message);}return;
        }
        if(!error){
          var revisionKnown=meta.revision!=null&&current.revision!=null;
          if((revisionKnown&&meta.revision!==current.revision)||(!revisionKnown&&requestEdit!==editSequence)){
            error=new Error('内容在原生渲染期间改变，请停止编辑后点击检测。');
          }
        }
        if(error){
          lastNative.phase='failed';lastNative.error=error.message;
          lastFailure={token:meta.token,message:error.message};
          if(!info||info.token!==meta.token){invalidate();}dirty=true;settle();fail(error.message);if(after){after(false);}return;
        }
        var same=info&&info.token===meta.token&&info.width===result.measured.width&&info.height===result.measured.height;
        cache={data:result.data,depth:result.measured.depth,color:result.measured.color};
        info=current;info.width=result.measured.width;info.height=result.measured.height;dirty=false;
        if(!same){el.width.value=info.width;el.height.value=info.height;el.result.textContent='';}
        syncNaming(current);sourceDescription();settle();if(after){after(true);}
      }
      function finishNative(error,result,dir){
        if(closing){return;}
        if(error&&error.code==='ALIGN4_HOST_TIMEOUT'){
          pending=false;pendingForce=false;if(timer!==null){window.clearTimeout(timer);timer=null;}
          complete(error,null,dir,meta);return;
        }
        // Verify actual selection and history once after rendering. Native export
        // can emit slct/activation notifications without changing either one.
        var observed=sequence;lastNative.phase='verifying';
        host('Align4.describeSelection()',function(current){
          if(sequence===observed){
            pending=false;pendingForce=false;if(timer!==null){window.clearTimeout(timer);timer=null;}
          }
          lastNative.phase=error?'failed':'complete';lastNative.error=error?error.message:null;
          complete(error,result,dir,current);
        });
      }
      function attempt(){
        lastNative={phase:'waiting',token:meta.token};
        activeJob=nativeExport.run({fs:fs,path:path,os:os,png:png,host:host,now:Date.now,log:logger,job:job,
          setTimeout:function(fn,delay){return window.setTimeout(fn,delay);},clearTimeout:function(id){window.clearTimeout(id);}},{
          prefix:'align4-native-',label:'快速导出',
          script:function(dir){return 'Align4.startNative('+quote(meta.token)+','+quote(dir)+')';},
          onProgress:progress},function(error,result){
          if(closing){return;}
          if(activeJob){lastNative.attempts=activeJob.state.attempts;lastNative.elapsed=activeJob.state.elapsed;lastNative.directories=activeJob.state.directories;}
          finishNative(error,result,null);
        });
      }
      attempt();
    });
  }
  function uniqueDirectories(list){
    var seen={},out=[];
    list.forEach(function(d){var key=String(d.path||'').replace(/[\\/]+$/,'').toLowerCase();if(key&&!Object.prototype.hasOwnProperty.call(seen,key)){seen[key]=true;out.push({path:d.path,name:d.name||path.basename(d.path)||d.path});}});return out;
  }
  function encodePNG(data,enabled,callback){
    if(!enabled){callback(null,data);return;}
    message('正在使用 SuperPNG 保存…','working');var t0=Date.now();logger.info('superpng','开始 SuperPNG 编码',{bytes:data.length},job);
    superPNG.encode({fs:fs,path:path,os:os,png:png,host:host},data,true,function(error,encoded){
      if(error){logger.error('superpng','SuperPNG 失败（'+(Date.now()-t0)+'ms）',{message:String(error.message||error)},job);}
      else{logger.info('superpng','SuperPNG 完成（'+(Date.now()-t0)+'ms）',{bytes:encoded&&encoded.length},job);}
      callback(error,encoded);
    });
  }
  function writeTargets(list,w,h,token,prefix,name,done,useSuperPNG){
    saving=true;controls();message('正在保存到 '+list.length+' 个目录…','working');
    host('Align4.describeSelection()',function(current){
      var successes=[],errors=[];
      try{
        if(!current.ok||current.token!==token||dirty||(info.revision!=null&&current.revision!=null&&info.revision!==current.revision)){throw new Error('选择或内容已改变，请重新检测后导出。');}
        if(!name){throw new Error('请填写导出名称。');}
        var t0=Date.now(),data=png.pad(cache.data,w,h,el.anchor.value),exportName=outputFiles.nameFor(prefix,name);
        logger.info('pad','补边到 '+w+'×'+h+'（'+(Date.now()-t0)+'ms）',{anchor:el.anchor.value},job);
      }catch(e){finish(e);return;}
      encodePNG(data,useSuperPNG,function(error,encoded){
        if(error){finish(error);return;}
        // SuperPNG temporarily activates its own PNG document. Check the source
        // again only after the host has restored the original document.
        if(useSuperPNG){host('Align4.describeSelection()',function(latest){
          if(!latest.ok||latest.token!==token||(current.revision!=null&&latest.revision!=null&&current.revision!==latest.revision)){finish(new Error('SuperPNG 保存期间选择或内容已改变，未写入目标目录。'));return;}
          publish(encoded);
        });}else{publish(encoded);}
      });
      function publish(encoded){
        list.forEach(function(directory){
          try{var output=outputFiles.save(fs,path,png,directory.path,exportName,encoded);output.directory=directory.path;output.label=directory.name;successes.push(output);logger.info('write','已写入 '+output.path,{width:output.width,height:output.height},job);}
          catch(e){errors.push({directory:directory.path,label:directory.name,message:String(e.message||e)});logger.error('write','写入失败 '+directory.path,{message:String(e.message||e)},job);}
        });
        finish();
      }
      function finish(error){
        if(error){errors.push({directory:'',message:String(error.message||error)});}
        if(error){logger.error('export','导出失败：'+String(error.message||error),undefined,job);}
        endJob(successes.length&&!errors.length?'成功':'结束（成功 '+successes.length+'，失败 '+errors.length+'）');
        lastExport={name:info?info.name:'',encoder:useSuperPNG?'SuperPNG':'PNG',prefix:prefix,fileName:successes.length?path.basename(successes[0].path):'',width:w,height:h,successes:successes,errors:errors};saving=false;if(done){done();}controls();
        el.result.textContent=successes.map(function(r){return '已导出 '+r.width+' × '+r.height+' px：'+r.path;}).concat(errors.map(function(e){return '失败：'+(e.directory?e.directory+'：':'')+e.message;})).join('\n');
        showReport(lastExport);
        message(errors.length?'已保存 '+successes.length+' 个目录，失败 '+errors.length+' 项。':'已导出到 '+successes.length+' 个目录。',errors.length?'error':'ok');
        if(pending){schedule(false);}
      }
    });
  }
  function save(){
    if(!namingToken||!outputDirectory||rendering||checking||saving||pending||choosingFolder||quickRequest||canvasRequest){return;}
    var token=namingToken,w=Number(el.width.value),h=Number(el.height.value),directory=outputDirectory,prefix=String(el.prefix.value||''),name=normalizedName(),useSuperPNG=!!el.superPNG.checked;
    if(!name){fail('请填写导出名称。');return;}
    startJob('按填写尺寸导出',{directory:directory,name:name,prefix:prefix,width:w,height:h,superPNG:useSuperPNG});
    detect(true,function(ok){
      if(!ok){endJob('未完成');}
      if(!ok){return;}
      if(!info||info.token!==token||!rules.valid(w,h,info.width,info.height)){controls();fail('对象或真实尺寸已改变，请检查尺寸后重新导出。');endJob('未完成');return;}
      writeTargets([{path:directory}],w,h,token,prefix,name,null,useSuperPNG);
    });
  }
  function abortQuick(text){quickRequest=null;controls();fail(text);endJob('未完成');if(pending){schedule(false);}}
  function drainQuick(){
    var request=quickRequest;if(!request||!request.ready||request.running||rendering||checking||saving||choosingFolder||closing){return;}
    if(timer!==null){window.clearTimeout(timer);timer=null;}pending=false;pendingForce=false;request.running=true;
    detect(true,function(ok){
      if(!ok){abortQuick(lastFailure?lastFailure.message:'选择或内容已改变，一键导出未完成，请重新点击。');return;}
      if(!info||info.token!==request.token){abortQuick('选择已改变，请重新点击一键导出。');return;}
      var w=rules.ceil4(Math.max(info.width,request.width||0)),h=rules.ceil4(Math.max(info.height,request.height||0));
      if(!rules.valid(w,h,info.width,info.height)){abortQuick('自定义尺寸超出范围，请检查宽高后重试。');return;}
      el.width.value=w;el.height.value=h;
      var name=request.name===null?outputFiles.normalizeName(info.name):request.name;
      writeTargets(request.directories,w,h,request.token,request.prefix,name,function(){quickRequest=null;},request.superPNG);
    });
  }
  function quickExport(directories){
    if(quickRequest||canvasRequest||saving||choosingFolder||closing){return;}
    var list=uniqueDirectories(directories);if(!list.length){fail('请先选择或添加导出目录。');return;}
    var request={directories:list,superPNG:!!el.superPNG.checked,prefix:String(el.prefix.value||''),name:normalizedName(),nameOwner:namingToken,owner:info?info.token:namingToken,width:Number(el.width.value),height:Number(el.height.value),ready:false,running:false};
    var draft=nameDraft;
    quickRequest=request;controls();startJob('切图导出',{directories:list.map(function(d){return d.path;}),name:request.name,prefix:request.prefix,width:request.width,height:request.height,superPNG:request.superPNG});
    whenNameBound(draft,function(){
      if(draft&&draft.error){abortQuick(draft.error);return;}
      if(draft){request.nameOwner=draft.token;}
      host('Align4.selectionToken()',function(current){
        if(!current.ok){abortQuick(current.message);return;}request.token=current.token;
        if(request.nameOwner!==request.token){request.name=null;}else if(!request.name){abortQuick('请填写导出名称。');return;}
        if(request.owner!==request.token){request.width=0;request.height=0;}
        request.ready=true;drainQuick();
      });
    });
  }
  function endCanvas(error,record){
    canvasRequest=null;controls();if(closing){return;}
    if(error){logger.error('export','整图导出失败：'+String(error.message||error),undefined,job);endJob('未完成');}
    else{(record.successes||[]).forEach(function(o){logger.info('write','已写入 '+o.path,{width:o.width,height:o.height},job);});endJob(record.errors.length?'部分失败':'成功');}
    if(error){fail('整个画布导出未完成：'+String(error.message||error));}
    else{lastExport=record;showReport(record);message(record.errors.length?'整图已保存 '+record.successes.length+' 个目录，失败 '+record.errors.length+' 项。':'整个画布已导出：'+record.width+' × '+record.height+' px。',record.errors.length?'error':'ok');}
    if(pending){schedule(false);}
  }
  function drainCanvas(){
    var request=canvasRequest;
    if(!request||!request.ready||request.running||rendering||checking||saving||choosingFolder||quickRequest||closing){return;}
    if(timer!==null){window.clearTimeout(timer);timer=null;}pending=false;pendingForce=false;request.running=true;
    message('正在导出整个画布，不受选中图层影响…','working');controls();
    request.job=canvasExporter.run({fs:fs,path:path,os:os,png:png,nativeExport:nativeExport,log:logger,job:job,onProgress:progress,outputFiles:outputFiles,encodePNG:encodePNG,rules:rules,host:host,now:Date.now,
      setTimeout:function(fn,delay){return window.setTimeout(fn,delay);},clearTimeout:function(id){window.clearTimeout(id);},getEditSequence:function(){return editSequence;}},request,endCanvas);
    lastCanvas=request.job.state;
  }
  function quickCanvas(){
    if(canvasRequest||quickRequest||saving||choosingFolder||closing){return;}
    if(!canvasDirectory){fail('请先在左下方添加整图导出目录。');return;}
    var request={directories:[{path:canvasDirectory}],superPNG:!!el.superPNG.checked,prefix:String(el.prefix.value||''),name:normalizedName()||null,anchor:el.anchor.value,ready:false,running:false};
    canvasRequest=request;controls();startJob('整图导出',{directory:canvasDirectory,superPNG:request.superPNG});
    host('Align4.describeDocument()',function(meta){
      if(!meta.ok){endCanvas(new Error(meta.message));return;}
      request.token=meta.token;request.ready=true;drainCanvas();
    });
  }
  function persistPresets(){try{window.localStorage.setItem('align4-directory-presets',JSON.stringify(presets));}catch(e){}}
  function renderPresets(){
    while(el.presets.firstChild){el.presets.removeChild(el.presets.firstChild);}presetViews=[];
    if(!presets.length){var empty=document.createElement('p');empty.className='preset-empty';empty.textContent='添加常用目录，每个目录都有独立的一键导出按钮。';el.presets.appendChild(empty);}
    presetPage=Math.min(presetPage,Math.max(0,Math.ceil(presets.length/presetPageSize)-1));
    presets.slice(presetPage*presetPageSize,(presetPage+1)*presetPageSize).forEach(function(p){
      var row=document.createElement('div'),top=document.createElement('div'),name=document.createElement('input'),quick=document.createElement('button'),remove=document.createElement('button'),label=document.createElement('p');
      row.className='preset';top.className='preset-row';
      name.type='text';name.value=p.name;name.className='preset-name';name.title='可修改快捷目录名称';
      quick.className='preset-quick';quick.textContent='一键导出 ↗';quick.title=p.path;
      remove.className='preset-remove';remove.textContent='×';remove.title='移除快捷目录';
      label.className='preset-path';label.textContent=path.basename(p.path)||p.path;label.title=p.path;
      name.addEventListener('change',function(){p.name=String(name.value).replace(/^\s+|\s+$/g,'')||path.basename(p.path)||p.path;name.value=p.name;persistPresets();});
      quick.addEventListener('click',function(){quickExport([{path:p.path,name:p.name}]);});
      remove.addEventListener('click',function(){presets=presets.filter(function(item){return item!==p;});persistPresets();renderPresets();controls();});
      [name,quick,remove].forEach(function(c){top.appendChild(c);});row.appendChild(top);row.appendChild(label);el.presets.appendChild(row);presetViews.push({row:row,directory:p.path,quick:quick,name:name,remove:remove});
    });
  }
  el.presetPrev.addEventListener('click',function(){if(presetPage>0){presetPage--;renderPresets();controls();}});
  el.presetNext.addEventListener('click',function(){if(presetPage<Math.ceil(presets.length/presetPageSize)-1){presetPage++;renderPresets();controls();}});
  window.addEventListener('resize',function(){var size=window.innerHeight&&window.innerHeight>=580?3:2;if(size!==presetPageSize){presetPageSize=size;renderPresets();controls();}});
  el.reportDetails.addEventListener('click',function(){el.reportList.hidden=!el.reportList.hidden;el.reportDetails.textContent=el.reportList.hidden?'详情':'收起';});
  function restoreSize(notify){
    windowSizeRequest={width:760,height:620,requested:false};
    try{if(!bridge||typeof bridge.resizeContent!=='function'){throw new Error('当前宿主没有提供窗口调整接口。');}bridge.resizeContent(760,620);windowSizeRequest.requested=true;if(notify){message('已请求恢复默认大小 760 × 620。','ok');}}
    catch(e){windowSizeRequest.error=String(e.message||e);if(notify){message('尺寸调整未完成，可将面板浮动后再试。','warning');}}
  }
  el.restoreSize.addEventListener('click',function(){restoreSize(true);});
  el.canvasFolder.addEventListener('click',function(){
    if(choosingFolder||rendering||checking||saving||quickRequest||canvasRequest){return;}choosingFolder=true;controls();
    host('Align4.chooseFolder('+quote(canvasDirectory)+')',function(r){
      choosingFolder=false;
      if(r.ok){canvasDirectory=r.path;try{window.localStorage.setItem('align4-canvas-directory',canvasDirectory);}catch(e){}}
      controls();if(!r.ok&&!r.cancelled){fail(r.message);}schedule(false);
    },0);
  });
  el.quick.addEventListener('click',function(){quickExport([{path:outputDirectory}]);});
  el.addPreset.addEventListener('click',function(){
    if(choosingFolder||rendering||checking||saving||quickRequest||canvasRequest){return;}choosingFolder=true;controls();
    host('Align4.chooseFolder('+quote(outputDirectory)+')',function(r){
      choosingFolder=false;
      if(r.ok){var key=String(r.path).replace(/[\\/]+$/,'').toLowerCase(),exists=presets.some(function(p){return String(p.path).replace(/[\\/]+$/,'').toLowerCase()===key;});
        if(!exists){presets.push({path:r.path,name:path.basename(r.path)||r.path});presetPage=Math.floor((presets.length-1)/presetPageSize);persistPresets();renderPresets();}
      }
      controls();if(!r.ok&&!r.cancelled){fail(r.message);}schedule(false);
    },0);
  });
  el.folder.addEventListener('click',function(){
    if(choosingFolder||rendering||checking||saving||quickRequest||canvasRequest){return;}choosingFolder=true;controls();
    host('Align4.chooseFolder('+quote(outputDirectory)+')',function(r){
      choosingFolder=false;
      if(r.ok){outputDirectory=r.path;el.directory.textContent=outputDirectory;el.directory.title=outputDirectory;try{window.localStorage.setItem('align4-export-directory',outputDirectory);}catch(e){}}
      controls();if(!r.ok&&!r.cancelled){fail(r.message);}schedule(false);
    },0);
  });
  el.refresh.addEventListener('click',function(){if(timer!==null){window.clearTimeout(timer);timer=null;}pending=false;pendingForce=false;detect(false);});
  el.width.addEventListener('input',controls);el.width.addEventListener('change',controls);el.height.addEventListener('input',controls);el.height.addEventListener('change',controls);el.anchor.addEventListener('change',controls);
  el.superPNG.addEventListener('change',function(){try{window.localStorage.setItem('align4-superpng',el.superPNG.checked?'1':'0');}catch(e){}controls();});
  function persistPrefix(){try{window.localStorage.setItem('align4-filename-prefix',el.prefix.value);}catch(e){}controls();}
  // Older CEP/IME combinations may deliver compositionend or keyup without input.
  // Each route reads the live field; no host render or manual refresh is required.
  function whenNameBound(draft,callback){if(draft&&draft.pending){draft.waiters.push(callback);}else{callback();}}
  function commitName(){
    // blur/keyup also fire without edits. Never attach an old layer's name to
    // a new selection merely because focus returned to the panel.
    if(el.exportName.value===nameValue){return;}
    nameValue=el.exportName.value;nameEdited=true;
    var draft={pending:true,token:null,error:null,waiters:[]};nameDraft=draft;controls();
    host('Align4.selectionToken()',function(current){
      draft.pending=false;draft.token=current.ok?current.token:null;draft.error=current.ok?null:current.message;
      if(nameDraft===draft){
        if(!current.ok){message(current.message,'error');}
        else{schedule(false);}
      }
      draft.waiters.forEach(function(callback){callback();});draft.waiters=[];
    });
  }
  ['input','change','compositionend','keyup','blur'].forEach(function(type){
    el.prefix.addEventListener(type,persistPrefix);
    el.exportName.addEventListener(type,commitName);
  });
  el.resetName.addEventListener('click',function(){if(el.resetName.disabled){return;}nameEdited=false;nameDraft=null;el.exportName.value=nameSource;nameValue=el.exportName.value;controls();el.exportName.focus();});
  el.clearPrefix.addEventListener('click',function(){if(el.clearPrefix.disabled){return;}el.prefix.value='';persistPrefix();el.prefix.focus();});
  el.align.addEventListener('click',function(){if(info){el.width.value=rules.ceil4(Math.max(info.width,Number(el.width.value)||0));el.height.value=rules.ceil4(Math.max(info.height,Number(el.height.value)||0));controls();}});
  el.export.addEventListener('click',save);el.canvas.addEventListener('click',quickCanvas);
  function panelState(){
    return {measured:info?{name:info.name,width:info.width,height:info.height,depth:cache&&cache.depth,color:cache&&cache.color}:null,dirty:dirty,nativeJob:lastNative,
      state:{rendering:rendering,checking:checking,saving:saving,pending:pending,notifications:sequence},target:{width:el.width.value,height:el.height.value},lastFailure:lastFailure,
      outputDirectory:outputDirectory,canvasDirectory:canvasDirectory,filenamePrefix:el.prefix.value,exportName:el.exportName.value,fileNamePreview:el.fileName.textContent,
      presets:presets,quickQueued:!!quickRequest,canvasQueued:!!canvasRequest,canvasJob:lastCanvas,lastExport:lastExport,superPNG:!!el.superPNG.checked,windowSizeRequest:windowSizeRequest};
  }
  // ---- Log panel ----
  var logOpen=false;
  function logLine(entry){
    var row=document.createElement('div');row.className='log-row log-'+entry.level;
    row.textContent=loggerModule?loggerModule.format(entry,false):entry.message;row.title=row.textContent;return row;
  }
  function renderLog(){
    if(!logOpen){return;}
    while(el.logList.firstChild){el.logList.removeChild(el.logList.firstChild);}
    var list=logger.entries(el.logVerbose.checked?'debug':'info').slice(-400);
    if(!list.length){var empty=document.createElement('p');empty.className='log-empty';empty.textContent='暂无记录。执行一次导出后，这里会逐步显示每个环节及用时。';el.logList.appendChild(empty);}
    list.forEach(function(e){el.logList.appendChild(logLine(e));});
    el.logList.scrollTop=el.logList.scrollHeight;
  }
  function setLogOpen(open){logOpen=open;el.logPanel.hidden=!open;if(open){el.logNote.textContent=logger.file()?'日志文件：'+logger.file():'日志仅保存在内存中';el.logNote.title=el.logNote.textContent;renderLog();}}
  function copyText(text){
    var area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.left='-9999px';
    document.body.appendChild(area);area.select();var ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(area);return ok;
  }
  function buildDiagnostics(done){
    host('Align4.environment()',function(environment){
      var generator;try{generator=diagnostics.generatorSection({fs:fs,path:path,env:env},80);}catch(e){generator='读取失败：'+String(e.message||e);}
      done(diagnostics.bundle({version:VERSION,environment:environment,state:panelState(),entries:logger.entries('debug').slice(-600),generator:generator,logFile:logger.file()}));
    });
  }
  el.diagnose.addEventListener('click',function(){setLogOpen(!logOpen);});
  el.logClose.addEventListener('click',function(){setLogOpen(false);});
  el.logVerbose.addEventListener('change',renderLog);
  el.logCopy.addEventListener('click',function(){
    if(!diagnostics){fail('诊断模块未加载。');return;}
    el.logCopy.disabled=true;setText(el.logCopy,'正在收集…');
    buildDiagnostics(function(text){
      el.logCopy.disabled=false;
      if(copyText(text)){setText(el.logCopy,'已复制 ✓');message('诊断信息已复制，可直接粘贴发送。','ok');}
      else{setText(el.logCopy,'复制诊断信息');el.debug.hidden=false;el.debug.value=text;el.debug.focus();el.debug.select();message('自动复制失败，请在弹出的文本框中按 Ctrl+C。','warning');}
      window.setTimeout(function(){setText(el.logCopy,'复制诊断信息');},2500);
    });
  });
  el.logFolder.addEventListener('click',function(){
    if(!logger.dir){fail('日志目录不可用。');return;}
    host('Align4.openFolder('+quote(logger.dir)+')',function(r){if(!r.ok){fail(r.message);}});
  });
  function setupLogging(rq){
    try{env=rq('process').env||{};}catch(e){env={};}
    var dir=env.ALIGN4_LOG_DIR||path.join(env.APPDATA||os.tmpdir(),'Align4Export','logs');
    logger=loggerModule.create({fs:fs,path:path,dir:dir,keepDays:7});
    logger.onEntry(function(entry){
      if(!logOpen){return;}
      if(entry.level==='debug'&&!el.logVerbose.checked){return;}
      var empty=el.logList.querySelector&&el.logList.querySelector('.log-empty');if(empty){el.logList.removeChild(empty);}
      el.logList.appendChild(logLine(entry));el.logList.scrollTop=el.logList.scrollHeight;
    });
    window.addEventListener('error',function(e){logger.error('script','面板脚本错误：'+(e&&e.message),{file:e&&e.filename,line:e&&e.lineno,stack:e&&e.error&&e.error.stack});});
    var host_=bridge&&bridge.getHostEnvironment?(function(){try{return JSON.parse(bridge.getHostEnvironment());}catch(e){return null;}}()):null;
    logger.info('panel.start','面板启动 v'+VERSION,{app:host_&&host_.appVersion,locale:host_&&host_.appLocale,os:os.platform()+' '+os.release(),logWriteError:logger.writeError()});
    var swept=nativeExport.sweep({fs:fs,path:path,os:os,now:Date.now},3600000);
    if(swept){logger.info('temp.sweep','清理了 '+swept+' 个过期临时目录');}
  }
  function dispatch(type,id){bridge.dispatchEvent(JSON.stringify({type:type,scope:'APPLICATION',extensionId:extensionId,appId:appId,data:String(id)}));}
  function onEvent(event){
    var data;try{data=typeof event.data==='object'?event.data:JSON.parse(String(event.data).replace(/^ver\d+,/,''));}catch(e){return;}
    var id=String(data.eventID||data.eventId||data.eventid);if(!Object.prototype.hasOwnProperty.call(eventMap,id)){return;}
    if(eventMap[id]){if(/"_ref"\s*:\s*"application"/.test(JSON.stringify(data))){return;}dirty=true;editSequence++;if(!rendering&&!saving){schedule(false);}return;}
    if(saving){sequence++;pending=true;return;}sequence++;schedule(false);
  }
  function onDocument(){if(!saving){sequence++;schedule(false);}}
  function startPolling(){
    if(closing||pollTimer!==null){return;}
    pollTimer=window.setTimeout(function(){
      pollTimer=null;
      if(!document.hidden&&!rendering&&!checking&&!saving&&!choosingFolder&&!quickRequest&&!canvasRequest&&timer===null){detect(false);}
      startPolling();
    },pollDelay);
  }
  function register(){
    try{if(bridge.getExtensionId){extensionId=bridge.getExtensionId()||extensionId;}if(bridge.getHostEnvironment){appId=JSON.parse(bridge.getHostEnvironment()).appId||appId;}
      var type='com.adobe.PhotoshopJSONCallback'+extensionId;bridge.addEventListener(type,onEvent);listeners.push([type,onEvent]);bridge.addEventListener('documentAfterActivate',onDocument);listeners.push(['documentAfterActivate',onDocument]);
      host('Align4.eventIDs()',function(r){if(!r.ok){fail(r.message);return;}r.events.forEach(function(e){eventMap[String(e.id)]=!!e.edit;dispatch('com.adobe.PhotoshopRegisterEvent',e.id);registered.push(e.id);});schedule(false);});
    }catch(e){fail('自动识别注册失败，可点击检测。'+String(e.message||e));}
  }
  function cleanup(){closing=true;if(pollTimer!==null){window.clearTimeout(pollTimer);pollTimer=null;}if(canvasRequest&&canvasRequest.job){canvasRequest.job.cancel();}if(activeJob){activeJob.cancel();}if(timer!==null){window.clearTimeout(timer);}registered.forEach(function(id){try{dispatch('com.adobe.PhotoshopUnRegisterEvent',id);}catch(e){}});listeners.forEach(function(e){try{bridge.removeEventListener(e[0],e[1]);}catch(x){}});}
  window.addEventListener('beforeunload',cleanup);document.addEventListener('visibilitychange',function(){if(!document.hidden){schedule(false);}});
  try{
    var rq=window.cep_node&&window.cep_node.require?window.cep_node.require:window.require;if(!rq&&typeof require==='function'){rq=require;}if(!rq){throw new Error('CEP Node 未启用。');}
    fs=rq('fs');path=rq('path');os=rq('os');Buffer=rq('buffer').Buffer;
    var base=decodeURI(bridge.getSystemPath('extension')).replace(/^file:\/\//,'');if(/^\/[A-Za-z]:/.test(base)){base=base.slice(1);}
    rules=window.Align4Rules||rq(path.join(base,'js','rules.js'));if(!rules||typeof rules.valid!=='function'||typeof rules.ceil4!=='function'){throw new Error('尺寸计算模块未正确加载。');}window.Align4Rules=rules;
    png=rq(path.join(base,'js','png-padding.js'));nativeExport=rq(path.join(base,'js','native-export.js'));diagnostics=rq(path.join(base,'js','diagnostics.js'));loggerModule=rq(path.join(base,'js','logger.js'));setupLogging(rq);outputFiles=rq(path.join(base,'js','output-files.js'));canvasExporter=rq(path.join(base,'js','canvas-export.js'));superPNG=rq(path.join(base,'js','superpng.js'));try{el.superPNG.checked=window.localStorage.getItem('align4-superpng')==='1';outputDirectory=window.localStorage.getItem('align4-export-directory')||'';canvasDirectory=window.localStorage.getItem('align4-canvas-directory')||'';el.prefix.value=(window.localStorage.getItem('align4-filename-prefix')||'').slice(0,32);}catch(e){}el.directory.textContent=outputDirectory||'尚未选择目录';el.directory.title=outputDirectory;try{var savedPresets=JSON.parse(window.localStorage.getItem('align4-directory-presets')||'[]');if(Array.isArray(savedPresets)){savedPresets.forEach(function(p){if(p&&typeof p.path==='string'&&p.path){presets.push({path:p.path,name:typeof p.name==='string'?p.name:path.basename(p.path)});}});}}catch(e){}setText(el.version,'v'+VERSION);renderPresets();restoreSize(false);controls();register();startPolling();
  }catch(e){controls();fail('文件处理模块未加载，请重启 PS 并确认新版安装成功。'+String(e.message||e));}
}());
