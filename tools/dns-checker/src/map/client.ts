export const MAP_CSS = String.raw`
:root{color-scheme:light dark;--bg:#f5f6f8;--panel:#fff;--text:#14171c;--muted:#5f6876;--border:#d9dde3;--sea:#e3ecf5;--land:#c9d1db;--match:#1a9b52;--differ:#d93a3a;--error:#9a4fd1;--accent:#2b6cdf}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#181c22;--text:#e6e9ee;--muted:#98a1ae;--border:#2b313a;--sea:#12202f;--land:#2c3745;--match:#3ccf7a;--differ:#ff6262;--error:#c58cf2;--accent:#6ea2ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:14px 18px;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;border-bottom:1px solid var(--border);background:var(--panel)}
h1{font-size:17px;margin:0}
.sub{color:var(--muted);font-size:13px}
.controls{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto;align-items:center}
button,select{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer}
button[aria-pressed=true]{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:baseline}
.s-match{--c:var(--match)}.s-differ{--c:var(--differ)}.s-error{--c:var(--error)}
.dot{background:var(--c)}
main{align-items:start;display:grid;grid-template-columns:minmax(0,3fr) minmax(300px,2fr);gap:14px;padding:14px 18px}
@media (max-width:860px){main{grid-template-columns:1fr;padding:10px}header{padding:10px}.controls{margin-left:0}}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.card h2{font-size:13px;margin:0;padding:8px 12px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
#mapwrap{position:relative;background:var(--sea);touch-action:none}
#map{display:block;width:100%;height:auto;cursor:grab;max-height:70vh}
#map.drag{cursor:grabbing}
.land{fill:var(--land)}
.marker{fill:var(--c);stroke:var(--panel);stroke-width:1.5;cursor:pointer;vector-effect:non-scaling-stroke}
.marker.active{stroke:var(--text);stroke-width:3}
.marker.hidden{display:none}
.zoom{position:absolute;right:8px;top:8px;display:flex;flex-direction:column;gap:4px}
.zoom button{width:30px;padding:2px 0}
#tip{position:fixed;z-index:10;max-width:320px;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 10px;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;display:none;font-size:13px;word-break:break-word}
#tip.pinned{pointer-events:auto}
#tip b{display:block}
#tip .k{color:var(--muted)}
.tablewrap{max-height:70vh;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{position:sticky;top:0;background:var(--panel);color:var(--muted);font-weight:600}
tr.row{cursor:pointer}
tr.row:hover,tr.row.active{background:color-mix(in srgb,var(--accent) 12%,transparent)}
td.ans{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.badge{color:var(--c);font-weight:600;white-space:nowrap}
.empty{padding:12px;color:var(--muted)}
.any{padding:0 0 4px}
`;

export const MAP_SCRIPT = String.raw`
(function(){
var report=JSON.parse(document.getElementById('data').textContent);
var W=report.world.width,H=report.world.height;
var LAT_TOP=84,LAT_BOT=-58;
var home={x:0,y:(90-LAT_TOP)/180*H,w:W,h:(LAT_TOP-LAT_BOT)/180*H};
var view={x:home.x,y:home.y,w:home.w,h:home.h};
var state={gi:0,filter:'all',active:null};
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function ttl(r){return r.answers.length?Math.min.apply(null,r.answers.map(function(a){return a.ttl})):null}
function label(r){return r.location?r.resolver+' ('+r.location.city+', '+r.location.countryCode+')':r.resolver}
function group(){return report.groups[state.gi]}
function visible(r){return state.filter==='all'||r.status===state.filter}
function tipHtml(r){
 var h='<b>'+esc(label(r))+'</b>';
 h+='<span class="k">status</span> <span class="s-'+r.status+'" style="color:var(--c)">'+r.status+'</span><br>';
 if(r.ips.length)h+='<span class="k">resolver IPs</span> '+esc(r.ips.join(', '))+'<br>';
 if(r.error)h+='<span class="k">error</span> '+esc(r.error)+'<br>';
 if(r.attempts>1)h+='<span class="k">attempts</span> '+r.attempts+'<br>';
 else h+='<span class="k">answers</span> '+(r.answers.length?esc(r.answers.map(function(a){return a.value}).join(', ')):'no records')+'<br>';
 var t=ttl(r);if(t!==null)h+='<span class="k">TTL</span> '+t+'s<br>';
 h+='<span class="k">transport</span> '+esc(r.transport);
 return h;
}
function project(r){return {x:(r.location.lon+180)/360*W,y:(90-r.location.lat)/180*H}}
function layout(rows){
 var seen={},out=[];
 rows.forEach(function(r,i){
  if(!r.location)return;
  var p=project(r),k=r.location.lat+','+r.location.lon,n=seen[k]=(seen[k]||0)+1;
  if(n>1){var a=(n-1)*2.4,d=3+(n>4?2:0);p={x:p.x+Math.cos(a)*d,y:p.y+Math.sin(a)*d}}
  out.push({i:i,p:p});
 });
 return out;
}
function setView(){
 var vb=view.x+' '+view.y+' '+view.w+' '+view.h;
 $('map').setAttribute('viewBox',vb);
 var k=view.w/W;
 var ms=document.querySelectorAll('.marker');
 for(var i=0;i<ms.length;i++)ms[i].setAttribute('r',(5*Math.max(k,0.12)).toFixed(2));
}
function render(){
 var g=group(),rows=g.rows;
 var counts={all:rows.length,match:0,differ:0,error:0};
 rows.forEach(function(r){counts[r.status]++});
 ['all','match','differ','error'].forEach(function(s){
  var b=$('f-'+s);b.setAttribute('aria-pressed',state.filter===s?'true':'false');
  b.querySelector('.n').textContent=counts[s];
 });
 $('ref').textContent=(g.referenceKind==='expected'?'expected: ':'majority: ')+(g.reference.join(', ')||'no records');
 var lay=layout(rows),m='';
 lay.forEach(function(l){
  var r=rows[l.i];
  m+='<circle class="marker s-'+r.status+(visible(r)?'':' hidden')+(state.active===l.i?' active':'')+'" data-i="'+l.i+'" cx="'+l.p.x.toFixed(2)+'" cy="'+l.p.y.toFixed(2)+'" r="5"></circle>';
 });
 $('markers').innerHTML=m;
 var t='',a='',na=0;
 rows.forEach(function(r,i){
  if(!visible(r))return;
  var ans=r.error?esc(r.error):(r.answers.length?esc(r.answers.map(function(x){return x.value}).join(', ')):'no records');
  var tr='<tr class="row s-'+r.status+(state.active===i?' active':'')+'" data-i="'+i+'"><td>'+esc(label(r))+'</td><td class="ans">'+ans+'</td><td><span class="badge"><span class="dot"></span>'+r.status+'</span></td><td>'+(ttl(r)===null?'-':ttl(r))+'</td></tr>';
  if(r.location)t+=tr;else{a+=tr;na++}
 });
 $('tbody').innerHTML=t||'<tr><td colspan="4" class="empty">No located resolvers match this filter.</td></tr>';
 $('any').style.display=rows.some(function(r){return !r.location})?'':'none';
 $('abody').innerHTML=a||'<tr><td colspan="4" class="empty">None for this filter.</td></tr>';
 setView();
}
function showTip(i,x,y,pin){
 var tip=$('tip');tip.innerHTML=tipHtml(group().rows[i]);tip.style.display='block';
 tip.classList.toggle('pinned',!!pin);
 var w=tip.offsetWidth,h=tip.offsetHeight;
 tip.style.left=Math.max(6,Math.min(x+14,window.innerWidth-w-6))+'px';
 tip.style.top=Math.max(6,Math.min(y+14,window.innerHeight-h-6))+'px';
}
function hideTip(){$('tip').style.display='none'}
function select(i,x,y){state.active=state.active===i?null:i;render();if(state.active!==null)showTip(i,x,y,true);else hideTip()}
document.addEventListener('mouseover',function(e){
 var t=e.target.closest&&e.target.closest('[data-i]');
 if(t&&state.active===null)showTip(+t.getAttribute('data-i'),e.clientX,e.clientY,false);
});
document.addEventListener('mousemove',function(e){
 var t=e.target.closest&&e.target.closest('[data-i]');
 if(t&&state.active===null)showTip(+t.getAttribute('data-i'),e.clientX,e.clientY,false);
});
document.addEventListener('mouseout',function(e){if(state.active===null&&e.target.closest&&e.target.closest('[data-i]'))hideTip()});
document.addEventListener('click',function(e){
 var t=e.target.closest&&e.target.closest('[data-i]');
 if(t&&!moved){select(+t.getAttribute('data-i'),e.clientX,e.clientY);return}
 if(!e.target.closest('#tip')&&!moved&&state.active!==null){state.active=null;hideTip();render()}
});
['all','match','differ','error'].forEach(function(s){
 $('f-'+s).addEventListener('click',function(){state.filter=s;state.active=null;hideTip();render()});
});
var sel=$('type');
report.groups.forEach(function(g,i){var o=document.createElement('option');o.value=i;o.textContent=g.type;sel.appendChild(o)});
sel.style.display=report.groups.length>1?'':'none';
sel.addEventListener('change',function(){state.gi=+sel.value;state.active=null;hideTip();render()});
function zoom(f,cx,cy){
 var nw=Math.max(home.w/40,Math.min(home.w,view.w*f)),nh=nw*home.h/home.w;
 view.x+= (view.w-nw)*cx;view.y+=(view.h-nh)*cy;view.w=nw;view.h=nh;clamp();setView();
}
function clamp(){
 view.x=Math.max(0,Math.min(W-view.w,view.x));
 view.y=Math.max(0,Math.min(H-view.h,view.y));
}
$('zin').addEventListener('click',function(){zoom(0.6,.5,.5)});
$('zout').addEventListener('click',function(){zoom(1/0.6,.5,.5)});
$('zreset').addEventListener('click',function(){view={x:home.x,y:home.y,w:home.w,h:home.h};setView()});
var map=$('map');
map.addEventListener('wheel',function(e){
 e.preventDefault();var b=map.getBoundingClientRect();
 zoom(e.deltaY<0?0.8:1.25,(e.clientX-b.left)/b.width,(e.clientY-b.top)/b.height);
},{passive:false});
var drag=null,moved=false;
map.addEventListener('pointerdown',function(e){drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};moved=false});
window.addEventListener('pointermove',function(e){
 if(!drag)return;var b=map.getBoundingClientRect();
 var dx=e.clientX-drag.x,dy=e.clientY-drag.y;
 if(Math.abs(dx)+Math.abs(dy)>4){moved=true;map.classList.add('drag');hideTip()}
 if(moved){view.x=drag.vx-dx/b.width*view.w;view.y=drag.vy-dy/b.height*view.h;clamp();setView()}
});
window.addEventListener('pointerup',function(){drag=null;map.classList.remove('drag');setTimeout(function(){moved=false},0)});
$('title').textContent=report.domain;
$('gen').textContent='checked '+report.generatedAt;
render();
})();
`;
