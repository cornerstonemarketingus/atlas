import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import test from "node:test";
import {inflateSync} from "node:zlib";
const read=path=>readFileSync(new URL("../"+path,import.meta.url));
const hash=data=>createHash("sha256").update(data).digest("hex");
const manifest=JSON.parse(read("icon-manifest.json"));
function png(path,size){const value=read(path);assert.equal(value.subarray(0,8).toString("hex"),"89504e470d0a1a0a");assert.equal(value.readUInt32BE(16),size,path);assert.equal(value.readUInt32BE(20),size,path);return value;}
test("iOS store icon is a real opaque 1024px RGB PNG referenced by the catalog",()=>{
 const catalog=JSON.parse(read("ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json"));const image=catalog.images.find(image=>image.size==="1024x1024");assert.ok(image);
 const value=png("ios/App/App/Assets.xcassets/AppIcon.appiconset/"+image.filename,1024);assert.equal(value[25],2,"Apple store icon must have no alpha channel");
});
test("all Android launcher densities and adaptive foregrounds exist at native resolution",()=>{
 for(const [density,scale]of [["mdpi",1],["hdpi",1.5],["xhdpi",2],["xxhdpi",3],["xxxhdpi",4]]){
 const prefix="android/app/src/main/res/mipmap-"+density+"/";png(prefix+"ic_launcher.png",48*scale);png(prefix+"ic_launcher_round.png",48*scale);const foreground=png(prefix+"ic_launcher_foreground.png",108*scale);assert.equal(foreground[25],6,"adaptive foreground must retain transparency");
 }
 assert.match(read("android/app/src/main/res/values/ic_launcher_background.xml").toString(),/#080F1E/);
});
test("native artwork provenance catches stale source or modified PNGs across platforms",()=>{
 const source=readFileSync(new URL("../../apps/web/public/favicon.svg",import.meta.url),"utf8").replace(/\r\n/gu,"\n");assert.equal(manifest.sourceSha256,hash(source));assert.equal(manifest.files.length,16);assert.equal(new Set(manifest.files.map(file=>file.path)).size,16);
 for(const file of manifest.files)assert.equal(hash(png(file.path,file.size)),file.sha256,file.path);
});

function rgbPixels(value) {
 const chunks=[];let offset=8;
 while(offset<value.length){const length=value.readUInt32BE(offset);if(value.toString("ascii",offset+4,offset+8)==="IDAT")chunks.push(value.subarray(offset+8,offset+8+length));offset+=length+12;}
 const width=value.readUInt32BE(16),height=value.readUInt32BE(20),stride=width*3,raw=inflateSync(Buffer.concat(chunks)),pixels=Buffer.alloc(stride*height);
 let source=0;
 for(let y=0;y<height;y++){const filter=raw[source++];for(let x=0;x<stride;x++){
 const left=x>=3?pixels[y*stride+x-3]:0,above=y?pixels[(y-1)*stride+x]:0,upperLeft=y&&x>=3?pixels[(y-1)*stride+x-3]:0;
 let prediction=0;if(filter===1)prediction=left;else if(filter===2)prediction=above;else if(filter===3)prediction=Math.floor((left+above)/2);else if(filter===4){const p=left+above-upperLeft,a=Math.abs(p-left),b=Math.abs(p-above),c=Math.abs(p-upperLeft);prediction=a<=b&&a<=c?left:b<=c?above:upperLeft;}else assert.equal(filter,0);
 pixels[y*stride+x]=(raw[source++]+prediction)&255;
 }}
 return (x,y)=>[...pixels.subarray((Math.floor(y*height)*width+Math.floor(x*width))*3,(Math.floor(y*height)*width+Math.floor(x*width))*3+3)];
}
test("rasterized vector preserves cyan strokes and unfilled negative space",()=>{
 const path=manifest.files.find(file=>file.path.startsWith("ios/")).path;const at=rgbPixels(png(path,1024));
 for(const point of [[0.05,0.05],[0.5,0.53],[0.5,0.75]])assert.deepEqual(at(...point),[8,15,30],"Atlas negative space must inherit fill=none");
 assert.deepEqual(at(0.5,0.25),[103,232,249]);
});
