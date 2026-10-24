'use strict';

exports.baseName=function(name){
  var s=String(name||'image').replace(/[\\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/g,'');
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)){s='_'+s;}
  s=s.slice(0,120);if(/[\uD800-\uDBFF]$/.test(s)){s=s.slice(0,-1);}
  return s.replace(/[. ]+$/g,'')||'image';
};

// Preview and saving share the same sanitization for the complete name.
exports.normalizeName=function(value){
  return String(value||'').replace(/^\s+|\s+$/g,'').replace(/\.png$/i,'').replace(/\s+$/g,'');
};
exports.nameFor=function(prefix,layerName){
  return exports.baseName(String(prefix||'')+String(layerName||'image'));
};

// Reserve filenames exclusively, so existing exports can never be overwritten.
exports.save=function(fs,path,png,directory,name,data){
  if(!directory||!fs.existsSync(directory)||!fs.statSync(directory).isDirectory()){
    throw new Error('导出目录不可用，请重新选择目录。');
  }
  var measured=png.parse(data),base=exports.baseName(name),file,fd=null,n;
  for(n=1;n<=10000;n++){
    file=path.join(directory,base+(n===1?'':'-'+n)+'.png');
    try{fd=fs.openSync(file,'wx');break;}catch(e){if(e.code!=='EEXIST'){throw e;}}
  }
  if(fd===null){throw new Error('同名文件太多，请清理目录或修改对象名称。');}
  try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;}
  catch(e){if(fd!==null){try{fs.closeSync(fd);}catch(ignore){}}try{fs.unlinkSync(file);}catch(ignore2){}throw e;}
  return {path:file,width:measured.width,height:measured.height};
};
