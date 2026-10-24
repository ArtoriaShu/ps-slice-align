'use strict';
// Lossless PNG padding: no canvas, alpha premultiplication or image scaling.
var zlib=require('zlib'), Buffer=require('buffer').Buffer;
var SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]), MAX_RAW=128*1024*1024, table=[];
for(var i=0;i<256;i++){var c=i;for(var k=0;k<8;k++){c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);}table[i]=c>>>0;}
function crc(bytes){var c=0xffffffff;for(var i=0;i<bytes.length;i++){c=table[(c^bytes[i])&255]^(c>>>8);}return(c^0xffffffff)>>>0;}
function chunk(type,bytes){var out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length,0);out.write(type,4,4,'ascii');bytes.copy(out,8);out.writeUInt32BE(crc(out.slice(4,out.length-4)),out.length-4);return out;}
function parse(input){
    if(input.length<33||!input.slice(0,8).equals(SIGNATURE)){throw new Error('输出尚未成为完整 PNG。');}
    var chunks=[],offset=8,ended=false;
    while(offset+12<=input.length){
        var n=input.readUInt32BE(offset),end=offset+12+n;if(end>input.length){throw new Error('PNG 尚未写完。');}
        var type=input.toString('ascii',offset+4,offset+8),data=input.slice(offset+8,offset+8+n);
        if(crc(input.slice(offset+4,offset+8+n))!==input.readUInt32BE(offset+8+n)){throw new Error('PNG 校验不符或仍在写入。');}
        chunks.push({type:type,data:data,original:input.slice(offset,end)});offset=end;if(type==='IEND'){ended=true;break;}
    }
    if(!ended||offset!==input.length||!chunks.length||chunks[0].type!=='IHDR'||chunks[0].data.length!==13){throw new Error('PNG 结构不完整。');}
    var h=chunks[0].data,w=h.readUInt32BE(0),height=h.readUInt32BE(4);
    if(!w||!height||w>30000||height>30000){throw new Error('PNG 宽高不在支持范围内。');}
    return{width:w,height:height,depth:h[8],color:h[9],header:h,chunks:chunks};
}
function paeth(a,b,c){var p=a+b-c,x=Math.abs(p-a),y=Math.abs(p-b),z=Math.abs(p-c);return x<=y&&x<=z?a:(y<=z?b:c);}
function pad(input,width,height,anchor){
    var p=parse(input);
    if(!isFinite(width)||!isFinite(height)||width%1||height%1||width<p.width||height<p.height||width>30000||height>30000||width%4||height%4){throw new Error('宽高只能增加，并且必须是 4 的倍数。');}
    if(anchor!=='center'&&anchor!=='topLeft'){throw new Error('无效的图像位置。');}
    if(width===p.width&&height===p.height){return input;}
    if((p.depth!==8&&p.depth!==16)||(p.color!==2&&p.color!==6)||p.header[10]!==0||p.header[11]!==0||p.header[12]!==0){throw new Error('PNG 补边需要 RGB/RGBA、8/16 位、非交错格式。请反馈原生快速导出的设置。');}
    var sample=p.depth/8,channels=p.color===6?4:3,pixelBytes=channels*sample,rowBytes=p.width*pixelBytes,outRowBytes=width*4*sample;
    if((rowBytes+1)*p.height>MAX_RAW||(outRowBytes+1)*height>MAX_RAW){throw new Error('图像超过补边内存限额（128 MiB 原始像素）。');}
    var idat=[],transparent=null;
    p.chunks.forEach(function(item){if(item.type==='IDAT'){idat.push(item.data);}if(item.type==='tRNS'){transparent=item.data;}if(item.type==='acTL'){throw new Error('暂不支持动画 PNG。');}});
    var raw=zlib.inflateSync(Buffer.concat(idat));if(raw.length!==(rowBytes+1)*p.height){throw new Error('PNG 像素数据长度不正确。');}
    var pixels=Buffer.alloc(rowBytes*p.height);
    for(var y=0;y<p.height;y++){
        var filter=raw[y*(rowBytes+1)],start=y*rowBytes;if(filter>4){throw new Error('PNG 行滤波格式无效。');}
        for(var x=0;x<rowBytes;x++){
            var a=x>=pixelBytes?pixels[start+x-pixelBytes]:0,b=y?pixels[start-rowBytes+x]:0,c=y&&x>=pixelBytes?pixels[start-rowBytes+x-pixelBytes]:0;
            var predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);
            pixels[start+x]=(raw[y*(rowBytes+1)+1+x]+predictor)&255;
        }
    }
    var left=anchor==='center'?Math.floor((width-p.width)/2):0,top=anchor==='center'?Math.floor((height-p.height)/2):0,output=Buffer.alloc((outRowBytes+1)*height);
    for(var y=0;y<p.height;y++){
        var destination=(y+top)*(outRowBytes+1)+1+left*4*sample;
        if(channels===4){pixels.copy(output,destination,y*rowBytes,(y+1)*rowBytes);}
        else{for(var x=0;x<p.width;x++){
            var src=y*rowBytes+x*pixelBytes,dest=destination+x*4*sample;pixels.copy(output,dest,src,src+pixelBytes);
            var isTransparent=transparent&&transparent.length===6;
            for(var c=0;c<3&&isTransparent;c++){var v=sample===1?pixels[src+c]:pixels.readUInt16BE(src+c*2);if(v!==transparent.readUInt16BE(c*2)){isTransparent=false;}}
            if(sample===1){output[dest+3]=isTransparent?0:255;}else{output.writeUInt16BE(isTransparent?0:65535,dest+6);}
        }}
    }
    var header=Buffer.from(p.header);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[9]=6;
    var encoded=[SIGNATURE,chunk('IHDR',header)];
    p.chunks.forEach(function(item){if(['IHDR','IDAT','IEND','tRNS','PLTE','bKGD','sBIT'].indexOf(item.type)<0){encoded.push(item.original);}});
    encoded.push(chunk('IDAT',zlib.deflateSync(output,{level:1})),chunk('IEND',Buffer.alloc(0)));
    var result=Buffer.concat(encoded),checked=parse(result);if(checked.width!==width||checked.height!==height){throw new Error('补边后尺寸核对失败。');}return result;
}
module.exports={parse:parse,pad:pad,crc:crc,chunk:chunk};
