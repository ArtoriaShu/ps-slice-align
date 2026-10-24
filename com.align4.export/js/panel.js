(function () {
  'use strict';
  var ids=['kind','name','original','status','width','height','align','anchor','padding','export','refresh','result','diagnose','debug','folder','directory','quick','addPreset','presets','presetCount','report','reportIcon','reportTitle','reportSummary','reportSize','reportList','reportDetails','restoreSize','directoryName','presetPrev','presetNext','presetPage','prefix','clearPrefix','fileName','exportName','resetName','canvas','canvasFolder','canvasDirectory','canvasDirectoryName'],el={};
  ids.forEach(function(id){el[id]=document.getElementById(id);});
  var rules=window.Align4Rules,bridge=window.__adobe_cep__,fs,path,os,png,pngWait,outputFiles,canvasExporter,outputDirectory='',canvasDirectory='',choosingFolder=false,presets=[],presetViews=[],presetPage=0,presetPageSize=(window.innerHeight&&window.innerHeight>=580)?3:2,quickRequest=null,canvasRequest=null,lastCanvas=null,lastExport=null,Buffer;
  var info=null,cache=null,dirty=false,editSequence=0,sequence=0,rendering=false,saving=false,checking=false,pending=false,pendingForce=false;
  var namingToken=null,nameSource='',nameEdited=false;
  var timer=null,eventMap={},registered=[],listeners=[],owned=[],retained=[],activeJob=null,lastNative=null,lastFailure=null,closing=false,extensionId='com.align4.export.panel',appId='PHXS',windowSizeRequest=null;
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
  function host(script,callback,timeout){
    if(!bridge){callback({ok:false,message:'请从 Photoshop 中打开插件。'});return;}
    var delivered=false,watchdog=timeout===0?null:window.setTimeout(function(){deliver({ok:false,code:'ALIGN4_HOST_TIMEOUT',message:'Photoshop 脚本在 25 秒内未响应，已停止等待。可查看诊断信息或重启 PS 后重试。'});},25000);
    function deliver(r){if(delivered){return;}delivered=true;if(watchdog!==null){window.clearTimeout(watchdog);}if(!closing){callback(r);}}
    try{bridge.evalScript(script,function(raw){var r;try{r=JSON.parse(raw);}catch(e){r={ok:false,message:'宿主脚本连接失败，请重启 Photoshop。'};}deliver(r);});}
    catch(e){if(delivered){throw e;}deliver({ok:false,message:String(e.message||e)});}
  }
  function normalizedName(){return outputFiles?outputFiles.normalizeName(el.exportName.value):String(el.exportName.value||'');}
  function syncNaming(meta){
    if(namingToken!==meta.token){namingToken=meta.token;nameEdited=false;}
    nameSource=outputFiles.normalizeName(meta.name);
    if(!nameEdited){el.exportName.value=nameSource;}
  }
  function sourceDescription(){
    el.original.textContent='原始尺寸 '+info.width+' × '+info.height+' px';el.original.title=el.original.textContent;
  }
  function controls(){
    var blocked=rendering||saving||checking||pending||choosingFolder||!!quickRequest||!!canvasRequest;
    el.refresh.disabled=blocked;el.diagnose.disabled=false;el.folder.disabled=blocked;
    var nameMissing=!!namingToken&&!normalizedName();
    var quickBlocked=saving||choosingFolder||!!quickRequest||!!canvasRequest||nameMissing;
    el.quick.disabled=!outputDirectory||quickBlocked;el.canvas.disabled=!canvasDirectory||!canvasExporter||saving||choosingFolder||!!quickRequest||!!canvasRequest;setText(el.canvas,canvasRequest?'整图导出中…':'导出整个画布 ↗');el.addPreset.disabled=blocked;
    el.presetCount.textContent=presets.length;el.canvasFolder.disabled=blocked;
    el.canvasDirectoryName.textContent=canvasDirectory?(path.basename(canvasDirectory)||canvasDirectory):'先添加目录';el.canvasDirectoryName.title=canvasDirectory;el.canvasDirectory.textContent=canvasDirectory||'与右侧切图目录独立';el.canvasDirectory.title=canvasDirectory;el.canvasFolder.textContent=canvasDirectory?'更换':'＋ 添加';el.canvas.title=canvasDirectory?'导出完整画布到 '+canvasDirectory:'请先在上方添加整图目录';
    setText(el.quick,quickRequest?'导出中…':outputDirectory?'导出切图 ↗':'先选择导出目录');el.quick.title=outputDirectory;el.directoryName.textContent=outputDirectory?(path.basename(outputDirectory)||outputDirectory):'先选择导出目录';el.directoryName.title=outputDirectory;
    var pageCount=Math.max(1,Math.ceil(presets.length/presetPageSize));el.presetPrev.disabled=blocked||presetPage===0;el.presetNext.disabled=blocked||presetPage>=pageCount-1;el.presetPage.textContent=(presetPage+1)+' / '+pageCount;
    presetViews.forEach(function(v){v.quick.disabled=quickBlocked;v.name.disabled=blocked;v.remove.disabled=blocked;});
    el.align.disabled=!info||blocked;el.export.disabled=!info||!outputDirectory||blocked||nameMissing||!rules.valid(Number(el.width.value),Number(el.height.value),info.width,info.height);
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
  function clean(dir){
    if(!dir||owned.indexOf(dir)<0||retained.indexOf(dir)>=0||(activeJob&&activeJob.dir===dir)){return;}
    function remove(p){if(!fs.existsSync(p)){return;}var s=fs.lstatSync(p);if(s.isDirectory()&&!s.isSymbolicLink()){fs.readdirSync(p).forEach(function(n){remove(path.join(p,n));});fs.rmdirSync(p);}else{fs.unlinkSync(p);}}
    try{remove(dir);owned.splice(owned.indexOf(dir),1);}catch(e){}
  }
  function schedule(force){
    if(canvasRequest){pending=true;pendingForce=pendingForce||!!force;return;}
    if(closing||saving||choosingFolder){return;}pending=true;pendingForce=pendingForce||!!force;controls();
    if(document.hidden){return;}if(timer!==null){window.clearTimeout(timer);}
    timer=window.setTimeout(function(){timer=null;if(rendering||checking){return;}var f=pendingForce;pending=false;pendingForce=false;detect(f);},220);
  }
  function settle(){rendering=false;checking=false;controls();if(pending&&!saving){schedule(pendingForce);}if(quickRequest&&!quickRequest.running){window.setTimeout(drainQuick,0);}if(canvasRequest&&!canvasRequest.running){window.setTimeout(drainCanvas,0);}}
  function fail(text){message(text,'error');el.result.textContent=text;showReport({message:text});}
  function invalidate(){info=null;namingToken=null;nameSource='';nameEdited=false;el.exportName.value='';el.original.textContent='未取得原生 PNG 的实际尺寸';el.width.value='';el.height.value='';}
  function detect(force,after){
    if(closing){return;}if(rendering||checking){pending=true;pendingForce=pendingForce||force;return;}
    checking=true;controls();
    host('Align4.describeSelection()',function(meta){
      if(!meta.ok){invalidate();pending=false;pendingForce=false;settle();fail(meta.message);if(after){after(false);}return;}
      syncNaming(meta);
      if(!force&&lastFailure&&lastFailure.token===meta.token){settle();fail(lastFailure.message);if(after){after(false);}return;}
      // Selection notifications are hints. They are not evidence of a new layer.
      if(cache&&info&&meta.token===info.token&&!force){
        if(meta.revision!=null&&info.revision!=null&&meta.revision!==info.revision){dirty=true;}
        info.name=meta.name;sourceDescription();
        settle();if(after){after(true);}return;
      }
      lastFailure=null;var requestEdit=editSequence;
      checking=false;rendering=true;controls();el.kind.textContent=meta.kind;el.name.textContent=meta.name;el.name.title=meta.name;message('正在读取选中对象的尺寸…','working');
      function complete(error,result,dir,current){
        activeJob=null;
        if(error&&(error.code==='ALIGN4_HOST_TIMEOUT'||error.code==='ALIGN4_PNG_TIMEOUT')){retained.push(dir);}
        clean(dir);if(closing){return;}
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
      function attempt(number){
        var dir;
        try{dir=fs.mkdtempSync(path.join(os.tmpdir(),'align4-native-'));owned.push(dir);}
        catch(e){lastNative={phase:'failed',error:String(e.message||e)};finishNative(e,null,dir);return;}
        activeJob={dir:dir,wait:null};lastNative={attempt:number,phase:'command',directory:dir,token:meta.token};
        host('Align4.startNative('+quote(meta.token)+','+quote(dir)+')',function(r){
          if(closing){return;}
          if(!r.ok){var error=new Error(r.message);error.code=r.code;finishNative(error,null,dir);return;}
          lastNative.phase='waiting';
          activeJob.wait=pngWait.wait({fs:fs,path:path,png:png,now:Date.now,setTimeout:function(fn,delay){return window.setTimeout(fn,delay);},clearTimeout:function(id){window.clearTimeout(id);}},dir,function(error,result){
            if(error&&error.code==='ALIGN4_TEMP_MISSING'&&number===1&&!closing){
              // A real selection change cancels recovery; duplicate callbacks do not.
              host('Align4.describeSelection()',function(current){
                if(current.ok&&current.token===meta.token&&!(meta.revision!=null&&current.revision!=null&&meta.revision!==current.revision)){
                  activeJob=null;clean(dir);message('临时目录丢失，正在重建并重试一次…');attempt(2);
                }else{finishNative(error,null,dir);}
              });return;
            }
            if(error&&error.code==='ALIGN4_TEMP_MISSING'){error.message='临时导出目录再次丢失，已停止等待。请复制诊断信息反馈。';}
            finishNative(error,result,dir);
          });
        });
      }
      attempt(1);
    });
  }
  function uniqueDirectories(list){
    var seen={},out=[];
    list.forEach(function(d){var key=String(d.path||'').replace(/[\\/]+$/,'').toLowerCase();if(key&&!Object.prototype.hasOwnProperty.call(seen,key)){seen[key]=true;out.push({path:d.path,name:d.name||path.basename(d.path)||d.path});}});return out;
  }
  function writeTargets(list,w,h,token,prefix,name,done){
    saving=true;controls();message('正在保存到 '+list.length+' 个目录…','working');
    host('Align4.describeSelection()',function(current){
      var successes=[],errors=[];
      try{
        if(!current.ok||current.token!==token||dirty||(info.revision!=null&&current.revision!=null&&info.revision!==current.revision)){throw new Error('选择或内容已改变，请重新检测后导出。');}
        if(!name){throw new Error('请填写导出名称。');}
        var data=png.pad(cache.data,w,h,el.anchor.value),exportName=outputFiles.nameFor(prefix,name);
        list.forEach(function(directory){
          try{var output=outputFiles.save(fs,path,png,directory.path,exportName,data);output.directory=directory.path;output.label=directory.name;successes.push(output);}
          catch(e){errors.push({directory:directory.path,label:directory.name,message:String(e.message||e)});}
        });
      }catch(e){errors.push({directory:'',message:String(e.message||e)});}
      lastExport={name:info?info.name:'',prefix:prefix,fileName:successes.length?path.basename(successes[0].path):'',width:w,height:h,successes:successes,errors:errors};saving=false;if(done){done();}controls();
      el.result.textContent=successes.map(function(r){return '已导出 '+r.width+' × '+r.height+' px：'+r.path;}).concat(errors.map(function(e){return '失败：'+(e.directory?e.directory+'：':'')+e.message;})).join('\n');
      showReport(lastExport);
      message(errors.length?'已保存 '+successes.length+' 个目录，失败 '+errors.length+' 项。':'已导出到 '+successes.length+' 个目录。',errors.length?'error':'ok');
      if(pending){schedule(false);}
    });
  }
  function save(){
    if(!info||!cache||!outputDirectory||rendering||checking||saving||pending||choosingFolder||quickRequest||canvasRequest){return;}
    var token=info.token,w=Number(el.width.value),h=Number(el.height.value),directory=outputDirectory,prefix=String(el.prefix.value||''),name=normalizedName();
    if(!name){fail('请填写导出名称。');return;}
    detect(true,function(ok){
      if(!ok){return;}
      if(!info||info.token!==token||!rules.valid(w,h,info.width,info.height)){controls();fail('对象或真实尺寸已改变，请检查尺寸后重新导出。');return;}
      writeTargets([{path:directory}],w,h,token,prefix,name);
    });
  }
  function abortQuick(text){quickRequest=null;controls();fail(text);if(pending){schedule(false);}}
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
      writeTargets(request.directories,w,h,request.token,request.prefix,name,function(){quickRequest=null;});
    });
  }
  function quickExport(directories){
    if(quickRequest||canvasRequest||saving||choosingFolder||closing){return;}
    var list=uniqueDirectories(directories);if(!list.length){fail('请先选择或添加导出目录。');return;}
    var request={directories:list,prefix:String(el.prefix.value||''),name:normalizedName(),nameOwner:namingToken,owner:info?info.token:null,width:Number(el.width.value),height:Number(el.height.value),ready:false,running:false};
    quickRequest=request;controls();
    host('Align4.selectionToken()',function(current){
      if(!current.ok){abortQuick(current.message);return;}request.token=current.token;
      if(request.nameOwner!==request.token){request.name=null;}else if(!request.name){abortQuick('请填写导出名称。');return;}
      if(request.owner!==request.token){request.width=0;request.height=0;}
      request.ready=true;drainQuick();
    });
  }
  function endCanvas(error,record){
    canvasRequest=null;controls();if(closing){return;}
    if(error){fail('整个画布导出未完成：'+String(error.message||error));}
    else{lastExport=record;showReport(record);message(record.errors.length?'整图已保存 '+record.successes.length+' 个目录，失败 '+record.errors.length+' 项。':'整个画布已导出：'+record.width+' × '+record.height+' px。',record.errors.length?'error':'ok');}
    if(pending){schedule(false);}
  }
  function drainCanvas(){
    var request=canvasRequest;
    if(!request||!request.ready||request.running||rendering||checking||saving||choosingFolder||quickRequest||closing){return;}
    if(timer!==null){window.clearTimeout(timer);timer=null;}pending=false;pendingForce=false;request.running=true;
    message('正在导出整个画布，不受选中图层影响…','working');controls();
    request.job=canvasExporter.run({fs:fs,path:path,os:os,png:png,pngWait:pngWait,outputFiles:outputFiles,rules:rules,host:host,now:Date.now,
      setTimeout:function(fn,delay){return window.setTimeout(fn,delay);},clearTimeout:function(id){window.clearTimeout(id);},getEditSequence:function(){return editSequence;}},request,endCanvas);
    lastCanvas=request.job.state;
  }
  function quickCanvas(){
    if(canvasRequest||quickRequest||saving||choosingFolder||closing){return;}
    if(!canvasDirectory){fail('请先在左下方添加整图导出目录。');return;}
    var request={directories:[{path:canvasDirectory}],prefix:String(el.prefix.value||''),name:normalizedName()||null,anchor:el.anchor.value,ready:false,running:false};
    canvasRequest=request;controls();
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
  el.refresh.addEventListener('click',function(){if(timer!==null){window.clearTimeout(timer);timer=null;}pending=false;pendingForce=false;detect(true);});
  el.width.addEventListener('input',controls);el.width.addEventListener('change',controls);el.height.addEventListener('input',controls);el.height.addEventListener('change',controls);el.anchor.addEventListener('change',controls);
  function persistPrefix(){try{window.localStorage.setItem('align4-filename-prefix',el.prefix.value);}catch(e){}controls();}
  // Older CEP/IME combinations may deliver compositionend or keyup without input.
  // Each route reads the live field; no host render or manual refresh is required.
  function commitName(){nameEdited=true;controls();}
  ['input','change','compositionend','keyup','blur'].forEach(function(type){
    el.prefix.addEventListener(type,persistPrefix);
    el.exportName.addEventListener(type,commitName);
  });
  el.resetName.addEventListener('click',function(){if(el.resetName.disabled){return;}nameEdited=false;el.exportName.value=nameSource;controls();el.exportName.focus();});
  el.clearPrefix.addEventListener('click',function(){if(el.clearPrefix.disabled){return;}el.prefix.value='';persistPrefix();el.prefix.focus();});
  el.align.addEventListener('click',function(){if(info){el.width.value=rules.ceil4(Math.max(info.width,Number(el.width.value)||0));el.height.value=rules.ceil4(Math.max(info.height,Number(el.height.value)||0));controls();}});
  el.export.addEventListener('click',save);el.canvas.addEventListener('click',quickCanvas);
  el.diagnose.addEventListener('click',function(){
    function show(r){el.debug.hidden=false;el.debug.value=JSON.stringify({host:r,measured:info?{name:info.name,width:info.width,height:info.height,depth:cache.depth,color:cache.color}:null,dirty:dirty,nativeJob:lastNative,state:{rendering:rendering,checking:checking,pending:pending,notifications:sequence},rulesLoaded:!!(rules&&rules.valid&&rules.ceil4),target:{width:el.width.value,height:el.height.value},lastFailure:lastFailure,outputDirectory:outputDirectory,canvasDirectory:canvasDirectory,filenamePrefix:el.prefix.value,exportName:el.exportName.value,namingToken:namingToken,fileNamePreview:el.fileName.textContent,presets:presets,quickQueued:!!quickRequest,canvasQueued:!!canvasRequest,canvasJob:lastCanvas,lastExport:lastExport,windowSizeRequest:windowSizeRequest},null,2);el.debug.focus();el.debug.select();}
    show({message:'正在取得 Photoshop 信息；上方任务状态已可复制。'});host('Align4.diagnose()',show);
  });
  function dispatch(type,id){bridge.dispatchEvent(JSON.stringify({type:type,scope:'APPLICATION',extensionId:extensionId,appId:appId,data:String(id)}));}
  function onEvent(event){
    var data;try{data=typeof event.data==='object'?event.data:JSON.parse(String(event.data).replace(/^ver\d+,/,''));}catch(e){return;}
    var id=String(data.eventID||data.eventId||data.eventid);if(!Object.prototype.hasOwnProperty.call(eventMap,id)){return;}
    if(eventMap[id]){if(/"_ref"\s*:\s*"application"/.test(JSON.stringify(data))){return;}dirty=true;editSequence++;if(!rendering&&!saving){controls();}return;}
    if(saving){sequence++;pending=true;return;}sequence++;schedule(false);
  }
  function onDocument(){if(!saving){sequence++;schedule(false);}}
  function register(){
    try{if(bridge.getExtensionId){extensionId=bridge.getExtensionId()||extensionId;}if(bridge.getHostEnvironment){appId=JSON.parse(bridge.getHostEnvironment()).appId||appId;}
      var type='com.adobe.PhotoshopJSONCallback'+extensionId;bridge.addEventListener(type,onEvent);listeners.push([type,onEvent]);bridge.addEventListener('documentAfterActivate',onDocument);listeners.push(['documentAfterActivate',onDocument]);
      host('Align4.eventIDs()',function(r){if(!r.ok){fail(r.message);return;}r.events.forEach(function(e){eventMap[String(e.id)]=!!e.edit;dispatch('com.adobe.PhotoshopRegisterEvent',e.id);registered.push(e.id);});schedule(false);});
    }catch(e){fail('自动识别注册失败，可点击检测。'+String(e.message||e));}
  }
  function cleanup(){closing=true;if(canvasRequest&&canvasRequest.job){canvasRequest.job.cancel();}if(activeJob&&activeJob.wait){activeJob.wait.cancel();}if(timer!==null){window.clearTimeout(timer);}registered.forEach(function(id){try{dispatch('com.adobe.PhotoshopUnRegisterEvent',id);}catch(e){}});listeners.forEach(function(e){try{bridge.removeEventListener(e[0],e[1]);}catch(x){}});owned.slice().forEach(clean);}
  window.addEventListener('beforeunload',cleanup);document.addEventListener('visibilitychange',function(){if(!document.hidden){schedule(false);}});
  try{
    var rq=window.cep_node&&window.cep_node.require?window.cep_node.require:window.require;if(!rq&&typeof require==='function'){rq=require;}if(!rq){throw new Error('CEP Node 未启用。');}
    fs=rq('fs');path=rq('path');os=rq('os');Buffer=rq('buffer').Buffer;
    var base=decodeURI(bridge.getSystemPath('extension')).replace(/^file:\/\//,'');if(/^\/[A-Za-z]:/.test(base)){base=base.slice(1);}
    rules=window.Align4Rules||rq(path.join(base,'js','rules.js'));if(!rules||typeof rules.valid!=='function'||typeof rules.ceil4!=='function'){throw new Error('尺寸计算模块未正确加载。');}window.Align4Rules=rules;
    png=rq(path.join(base,'js','png-padding.js'));pngWait=rq(path.join(base,'js','native-png-wait.js'));outputFiles=rq(path.join(base,'js','output-files.js'));canvasExporter=rq(path.join(base,'js','canvas-export.js'));try{outputDirectory=window.localStorage.getItem('align4-export-directory')||'';canvasDirectory=window.localStorage.getItem('align4-canvas-directory')||'';el.prefix.value=(window.localStorage.getItem('align4-filename-prefix')||'').slice(0,32);}catch(e){}el.directory.textContent=outputDirectory||'尚未选择目录';el.directory.title=outputDirectory;try{var savedPresets=JSON.parse(window.localStorage.getItem('align4-directory-presets')||'[]');if(Array.isArray(savedPresets)){savedPresets.forEach(function(p){if(p&&typeof p.path==='string'&&p.path){presets.push({path:p.path,name:typeof p.name==='string'?p.name:path.basename(p.path)});}});}}catch(e){}renderPresets();restoreSize(false);controls();register();
  }catch(e){controls();fail('文件处理模块未加载，请重启 PS 并确认新版安装成功。'+String(e.message||e));}
}());
