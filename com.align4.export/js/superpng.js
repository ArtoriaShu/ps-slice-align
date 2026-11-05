'use strict';

// Encode the already padded PNG once, then let output-files reserve final names.
// Never pad/re-encode the returned bytes: SuperPNG must be the final encoder.
exports.encode=function(o,data,enabled,callback){
  if(!enabled){callback(null,data);return;}
  var directory=null,input,output,expected;
  function clean(){
    if(!directory){return;}
    try{[input,output].forEach(function(file){if(o.fs.existsSync(file)){o.fs.unlinkSync(file);}});o.fs.rmdirSync(directory);}catch(ignore){}
  }
  function quote(value){return JSON.stringify(value).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
  try{
    expected=o.png.parse(data);
    directory=o.fs.mkdtempSync(o.path.join(o.os.tmpdir(),'align4-superpng-'));
    input=o.path.join(directory,'input.png');output=o.path.join(directory,'output.png');
    o.fs.writeFileSync(input,data,{flag:'wx'});
  }catch(e){clean();callback(e);return;}
  o.host('Align4.convertSuperPNG('+quote(input)+','+quote(output)+')',function(result){
    var error=null,encoded;
    try{
      if(!result.ok){throw new Error('SuperPNG 导出失败：'+(result.message||'请检查 SuperPNG 是否已安装。'));}
      encoded=o.fs.readFileSync(output);
      var measured=o.png.parse(encoded);
      if(measured.width!==expected.width||measured.height!==expected.height||measured.header[12]!==0){throw new Error('SuperPNG 输出尺寸或非交错设置不符，未保存。');}
    }catch(e){error=e;}
    // A timed-out Photoshop command may still own these files.
    if(result.code!=='ALIGN4_HOST_TIMEOUT'){clean();}
    else{error.message+=' 临时目录已保留：'+directory;}
    callback(error,encoded);
  });
};
