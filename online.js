/* Moe Wiggly Studio · modo online (Supabase Realtime)
   Se carga DESPUÉS del script principal y comparte su ámbito (doc, cur, view, F, pos, change…).
   Sincroniza por operaciones: cada cambio local se compara con un "espejo" (mir) y solo se envía la diferencia.
   Trazos en curso → Broadcast (efímero). Estado persistente → tabla room_ops vía RPC push_ops (los nuevos lo reciben al entrar). */
(()=>{'use strict';
const C=window.MOE_ONLINE||{},LSK='moeWigglyUsername',SDK='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const O=window.Online={on:false,loading:false};
let sb,me,room=null,roster=[],ch=null,dbch=null,mir=null,seen=new Set(),lastSeq=0,out=[],sent=new Set(),flushing=false,PS=null,tmr=[],peers=new Map(),lp=[-999,-999],wait=false,view_='menu',FM={max:5,mine:false},tokN=0,cT=0,curI=null,curSent=0,lastAct=null,down=false,downSince=0,hbBusy=false,hbQ=0,dirty=false,dirtyL=false,tick=0,memName='';
const tokP=Math.random().toString(36).slice(2,8),tok=()=>tokP+(++tokN),newId=()=>nid()+Math.random().toString(36).slice(2,6);
const clean=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,24);
const getName=()=>{let v='';try{v=localStorage.getItem(LSK)||''}catch{}return clean(v||memName)};
const setNameLS=v=>{memName=v;try{localStorage.setItem(LSK,v)}catch{}};
const col=c=>/^#[0-9a-f]{6}$/i.test(c)?c:'#8e8e93';
const ERR={room_not_found:'No existe ninguna sala con ese código.',bad_password:'Contraseña incorrecta.',room_closed:'Esa sala está cerrada.',room_full:'La sala está llena: ha alcanzado su máximo de participantes (nunca más de cinco).',too_many_rooms:'Ya tienes 3 salas abiertas. Cierra alguna antes de crear otra.',not_authenticated:'No se pudo identificar este navegador. Recarga la página.',bad_name:'Pon un nombre a la sala.'};
const errMsg=e=>{const m=String((e&&e.message)||e);for(const k in ERR)if(m.includes(k))return ERR[k];return/fetch|network|Failed/i.test(m)?'Sin conexión con el servidor. Inténtalo de nuevo.':'Error: '+m.slice(0,120)};
const P=()=>$('#opan');

/* ---------- conexión ---------- */
const loadSdk=()=>window.supabase?Promise.resolve():new Promise((ok,ko)=>{const s=document.createElement('script');s.src=SDK;s.onload=ok;s.onerror=()=>ko(new Error('No se pudo cargar la biblioteca de Supabase (¿sin conexión?)'));document.head.append(s)});
async function init(){if(sb)return;
 if(!C.url||!C.key||/PEGA|AQUI|YOUR/i.test(C.key))throw new Error('Falta la clave pública de Supabase en online-config.js');
 await loadSdk();const c=supabase.createClient(C.url,C.key,{auth:{persistSession:true,autoRefreshToken:true},realtime:{params:{eventsPerSecond:20}}});
 let{data:{session}}=await c.auth.getSession();
 if(!session){const r=await c.auth.signInAnonymously();if(r.error)throw r.error;session=r.data.session}   // identidad anónima: sin registro ni correo
 me=session.user.id;c.realtime.setAuth(session.access_token);c.auth.onAuthStateChange((_,s)=>{if(s)c.realtime.setAuth(s.access_token)});sb=c}
async function rpc(n,a){const{data,error}=await sb.rpc(n,a);if(error)throw error;return data}

/* ---------- nombre de usuario temporal ---------- */
function askName(cur){return new Promise(res=>{const d=document.createElement('div');d.className='dlg';
 d.innerHTML='<div class="dc glass"><svg viewBox="0 0 24 24" style="display:block;margin:2px auto 8px;width:34px;height:34px"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg><b style="display:block;text-align:center">Tu nombre de usuario</b><p>Se guardará en este navegador. Es solo un nombre visible para los demás: no hace falta cuenta ni correo.</p><input class="di" maxlength="24" placeholder="Tu nombre" autocomplete="off" spellcheck="false"><small class="er" style="display:block;min-height:16px;color:#ff453a"></small><div class="db"></div></div>';
 const i=d.querySelector('input'),er=d.querySelector('.er'),bx=d.querySelector('.db');i.value=cur||'';
 const done=v=>{d.classList.remove('on');setTimeout(()=>d.remove(),350);res(v)},ok=()=>{const v=clean(i.value);if(!v){er.textContent='Escribe un nombre: no puede estar vacío.';i.focus();return}setNameLS(v);done(v)};
 [['Cancelar','',()=>done(null)],['Continuar','pri',ok]].forEach(([t,c,f])=>{const b=document.createElement('button');b.className='btn '+c;b.textContent=t;b.onclick=f;bx.append(b)});
 i.onkeydown=e=>{if(e.key==='Enter')ok();if(e.key==='Escape')done(null)};i.oninput=()=>er.textContent='';d.onpointerdown=e=>{if(e.target===d)done(null)};
 document.body.append(d);requestAnimationFrame(()=>{d.classList.add('on');i.focus();i.select()})})}
const need=async()=>getName()||await askName('');
async function rename(){const n=await askName(getName());if(!n)return;if(room){if(ch)ch.track({n,t:Date.now()});hbNow()}draw()}

/* ---------- diferencias locales → operaciones ---------- */
function LO(a,k,p){if(k==='la'){if(!a.some(l=>l.id===p.l.id))a.splice(Math.min(p.at,a.length),0,{...p.l})}
 else if(k==='lu'){const l=a.find(l=>l.id===p.id);if(l)Object.assign(l,p.f)}
 else if(k==='lx'){const i=a.findIndex(l=>l.id===p.id);if(i>=0)a.splice(i,1)}
 else if(k==='lo'){const m=new Map(a.map(l=>[l.id,l])),n=p.ids.filter(i=>m.has(i)).map(i=>m.get(i));a.forEach(l=>{if(!n.includes(l))n.push(l)});a.length=0;a.push(...n)}}
function diff(){const L=lyr(),ops=[],cm=new Map(L.map(l=>[l.id,l])),om=new Map(mir.layers.map(l=>[l.id,l])),la=[],lu=[],lx=[];
 L.forEach((l,i)=>{const o=om.get(l.id);if(!o){l.u=l.u||me;la.push({k:'la',p:{l:{...l},at:i}})}else{const f={};for(const k of['name','vis','lock','op'])if(l[k]!==o[k])f[k]=l[k];if(Object.keys(f).length)lu.push({k:'lu',p:{id:l.id,f}})}});
 for(const l of mir.layers)if(!cm.has(l.id))lx.push({k:'lx',p:{id:l.id}});
 const a=mir.layers.filter(l=>cm.has(l.id)).map(l=>l.id).join(),b=L.filter(l=>om.has(l.id)).map(l=>l.id).join(),lo=a!==b?[{k:'lo',p:{ids:L.map(l=>l.id)}}]:[];
 const m={};for(const k of['bg','w','h'])if(doc[k]!==mir[k])m[k]=doc[k];
 const sn=new Set(),add=[],ns=new Map();
 for(const s of doc.strokes){if(s.live){sn.add(s.i);ns.set(s.i,s.layer);continue}if(s===cur){if(s.i)sn.add(s.i);continue}
  const o=s.i&&mir.s.get(s.i);
  if(!s.i||sn.has(s.i)||(o!==undefined&&o!==s.layer)){s.i=newId();s.u=me;delete s.q}   // sin id, duplicado (duplicar capa) o cambiado de capa (combinar) → trazo nuevo
  sn.add(s.i);ns.set(s.i,s.layer);if(!mir.s.has(s.i)||mir.s.get(s.i)===undefined)add.push(s)}
 const del=[...mir.s.keys()].filter(i=>!sn.has(i));
 mir.layers=L.map(l=>({...l}));for(const k in m)mir[k]=m[k];mir.s=ns;
 ops.push(...la);if(Object.keys(m).length)ops.push({k:'meta',p:m});if(del.length)ops.push({k:'d',p:{ids:del}});
 for(const s of add){const p={...s};delete p.q;delete p.live;delete p.t;ops.push({k:'s',p})}
 ops.push(...lu,...lo,...lx);return ops}
function localDiff(){if(!O.on||O.loading||!room)return;const ops=diff();if(!ops.length)return;for(const o of ops){o.p._c=tok();sent.add(o.p._c)}out.push(...ops);flush()}
async function flush(){if(flushing||!room)return;flushing=true;
 try{while(out.length&&room){let n=0,sz=0;for(;n<out.length&&n<100;n++){sz+=JSON.stringify(out[n]).length;if(sz>350000&&n>0)break}
  const batch=out.slice(0,n);
  try{await rpc('push_ops',{p_room:room.id,p_ops:batch})}catch(e){if(/op_too_large|bad_ops/.test(String(e.message))&&n>1){for(const o of batch){try{await rpc('push_ops',{p_room:room.id,p_ops:[o]})}catch(e2){if(/op_too_large|bad_ops/.test(String(e2.message)))toast('Un trazo era demasiado grande y no se pudo compartir.');else throw e2}}}
   else if(/op_too_large|bad_ops/.test(String(e.message)))toast('Un trazo era demasiado grande y no se pudo compartir.');else throw e}
  out.splice(0,n)}}
 catch(e){if(/room_closed|not_member|room_not_found/.test(String(e.message)))hbNow();else setTimeout(flush,3000)}
 finally{flushing=false}}

/* ---------- operaciones remotas → documento ---------- */
function applyOp(k,p,id){
 if(k==='M'){doc.layers=p.layers.map(l=>({...l}));mir.layers=p.layers.map(l=>({...l}));for(const f of['bg','w','h']){doc[f]=p[f];mir[f]=p[f]}fit();try{bgI.value=doc.bg}catch{}dirtyL=true}
 else if(k==='meta'){let fw=0;for(const f of['bg','w','h'])if(f in p){doc[f]=p[f];mir[f]=p[f];if(f!=='bg')fw=1}if(fw)fit();try{bgI.value=doc.bg}catch{}}
 else if(k==='s'){const i=doc.strokes.findIndex(x=>x.i===p.i),s={...p,q:id};delete s._c;if(i>=0)doc.strokes[i]=s;else doc.strokes.push(s);mir.s.set(s.i,s.layer)}
 else if(k==='d'){const S=new Set(p.ids);doc.strokes=doc.strokes.filter(s=>!S.has(s.i));S.forEach(i=>mir.s.delete(i))}
 else{LO(doc.layers||(doc.layers=[]),k,p);LO(mir.layers,k,p);dirtyL=true;if(k==='lx'){doc.strokes=doc.strokes.filter(s=>s.layer!==p.id);for(const[i,l]of[...mir.s])if(l===p.id)mir.s.delete(i)}}}
function applyRow(r){if(seen.has(r.id))return;seen.add(r.id);lastSeq=Math.max(lastSeq,r.id);const p=r.p||{},c=p._c;
 if(c&&sent.has(c)){sent.delete(c);if(r.k==='s'){const s=doc.strokes.find(x=>x.i===p.i);if(s)s.q=r.id}dirty=true;return}   // eco de mi propia operación: solo fija el orden
 try{applyOp(r.k,p,r.id)}catch(e){console.warn('op',e)}dirty=true}
const byQ=(a,b)=>(a.q==null?1e18:a.q)-(b.q==null?1e18:b.q);
function flushApply(){if(!dirty)return;dirty=false;doc.strokes.sort(byQ);lyr();sync();if(dirtyL){dirtyL=false;if(p5.classList.contains('on'))listL()}draw()}
async function catchup(){if(!room)return;let from=Math.max(0,lastSeq-200),more=true;
 while(more&&room){const{data,error}=await sb.from('room_ops').select('id,user_id,k,p').eq('room_id',room.id).gt('id',from).order('id').limit(500);if(error)throw error;data.forEach(applyRow);more=data.length===500;if(data.length)from=data[data.length-1].id}
 flushApply()}

/* ---------- efímero: trazos en curso y cursores (Broadcast) ---------- */
const bc=(ev,p)=>{if(ch&&ch.state==='joined')ch.send({type:'broadcast',event:ev,payload:{...p,u:me}})};
function liveTick(){if(!room||down||!cur||!cur.pts||!cur.pts.length)return;if(!cur.i){cur.i=newId();cur.u=me}if(curI!==cur.i){curI=cur.i;curSent=0}
 if(cur.pts.length>curSent){const h=curSent?undefined:{layer:cur.layer,brush:cur.brush,color:cur.color,size:cur.size,alpha:cur.alpha,mode:cur.mode,amp:cur.amp,speed:cur.speed,wl:cur.wl,irr:cur.irr,env:cur.env,seed:cur.seed,erase:cur.erase};bc('live',{i:cur.i,h,p:cur.pts.slice(curSent)});curSent=cur.pts.length}}
function onLive(m){if(!m||m.u===me||typeof m.i!=='string'||!Array.isArray(m.p))return;let s=doc.strokes.find(x=>x.i===m.i);
 if(!s){if(!m.h||mir.s.has(m.i))return;s={...m.h,i:m.i,u:m.u,live:1,pts:[]};doc.strokes.push(s);mir.s.set(s.i,s.layer)}
 if(!s.live)return;for(const p of m.p)if(Array.isArray(p)&&p.length>=4)s.pts.push(p);s.t=performance.now();D=1}
function onCur(m){if(!m||m.u===me||typeof m.u!=='string')return;let p=peers.get(m.u);
 if(!p){const el=document.createElement('div');el.className='pc';el.innerHTML='<i></i><span></span>';$('#oc').append(el);p={el,lb:el.querySelector('span'),t0:performance.now(),x:-1,y:-1,t:0};peers.set(m.u,p)}
 p.x=+m.x;p.y=+m.y;p.t=performance.now()}
function loop(){if(!O.on)return;const now=performance.now(),r=cv.getBoundingClientRect(),s=F*view.z;
 for(const[u,p]of peers){const m=roster.find(x=>x.u===u),vis=m&&p.x>=0&&now-p.t<5000;p.el.style.display=vis?'':'none';if(!vis)continue;
  const x=r.left+r.width/2+view.x+(p.x*doc.w-doc.w/2)*s,y=r.top+r.height/2+view.y+(p.y*doc.h-doc.h/2)*s;
  p.el.style.transform=`translate(${x}px,${y}px)`;p.el.style.setProperty('--c',col(m.color));p.lb.textContent=m.name;p.el.classList.toggle('nm',Math.hypot(x-lp[0],y-lp[1])<30||now-p.t0<2500)}
 requestAnimationFrame(loop)}
cv.addEventListener('pointermove',e=>{lp=[e.clientX,e.clientY];if(!O.on)return;const n=performance.now();if(n-cT<120)return;cT=n;const[x,y]=pos(e);bc('cur',{x:+(x/doc.w).toFixed(4),y:+(y/doc.h).toFixed(4)})});   // coordenadas relativas al lienzo
cv.addEventListener('pointerdown',e=>{lp=[e.clientX,e.clientY]});
cv.addEventListener('pointerleave',()=>{if(O.on)bc('cur',{x:-1,y:-1})});

/* ---------- latido y lista de participantes ---------- */
function setRoster(l){roster=l;const b=$('#bO');b.classList.add('live');b.querySelector('.bg').textContent=l.length;
 for(const[u,p]of[...peers])if(!l.some(m=>m.u===u)){p.el.remove();peers.delete(u)}draw()}
const hbSoon=()=>{clearTimeout(hbQ);hbQ=setTimeout(hbNow,400)};
async function hbNow(){if(!room||hbBusy)return;hbBusy=true;
 try{lastAct=doc.act;const r=await rpc('heartbeat',{p_room:room.id,p_name:getName(),p_layer:doc.act||null});if(!room)return;if(r.kicked){leave('full');return}if(r.closed){leave('closed');return}setRoster(r.members)}
 catch(e){if(/not_member|room_not_found/.test(String(e.message)))leave('gone')}finally{hbBusy=false}}

/* ---------- canales ---------- */
function connect(){
 ch=sb.channel('room:'+room.id,{config:{private:true,broadcast:{self:false},presence:{key:me}}});   // privado: lo autorizan las políticas de realtime.messages
 ch.on('broadcast',{event:'cur'},({payload})=>onCur(payload)).on('broadcast',{event:'live'},({payload})=>onLive(payload)).on('broadcast',{event:'hint'},hbSoon)
  .on('presence',{event:'sync'},hbSoon)
  .on('presence',{event:'join'},({key,newPresences})=>{if(key!==me&&newPresences&&newPresences[0])toast((clean(newPresences[0].n)||'Alguien')+' se ha conectado',2000)})
  .on('presence',{event:'leave'},({key,leftPresences})=>{if(room&&key!==me&&leftPresences&&leftPresences[0])toast((clean(leftPresences[0].n)||'Alguien')+' se ha desconectado',2000)})
  .subscribe(s=>{if(!room)return;if(s==='SUBSCRIBED'){ch.track({n:getName(),t:Date.now()});onUp()}else if(s==='CHANNEL_ERROR'||s==='TIMED_OUT'||s==='CLOSED')onDown()});
 dbch=sb.channel('db:'+room.id)
  .on('postgres_changes',{event:'INSERT',schema:'public',table:'room_ops',filter:'room_id=eq.'+room.id},p=>{applyRow(p.new);flushApply()})
  .on('postgres_changes',{event:'UPDATE',schema:'public',table:'rooms',filter:'id=eq.'+room.id},p=>{if(p.new&&p.new.closed)hbNow()})   // se confirma contra el servidor
  .subscribe(s=>{if(room&&s==='SUBSCRIBED')catchup().catch(()=>{})})}
function onUp(){if(down){down=false;toast('Conexión restablecida',2000);draw()}catchup().catch(()=>{});flush();hbNow()}
function onDown(){if(!down){down=true;downSince=Date.now();toast('Conexión perdida. Reintentando…',3000);draw()}}
function closeCh(){for(const c of[ch,dbch])if(c)sb.removeChannel(c);ch=dbch=null}
function teardown(){tmr.forEach(clearInterval);tmr=[];clearTimeout(hbQ);closeCh()}

/* ---------- entrar / salir ---------- */
async function enter(r){
 try{await saveNow()}catch{}                                   // se guarda el proyecto personal antes de entrar
 PS={d:{layers:doc.layers,act:doc.act,strokes:doc.strokes,bg:doc.bg,w:doc.w,h:doc.h},u:undo,r:redo};
 room={id:r.room_id,code:r.code,name:r.name,max:r.max_players,host:r.host_id};roster=[];down=false;
 undo=[];redo=[];Object.assign(doc,{strokes:[],layers:null,act:null});mir={s:new Map(),layers:[],bg:doc.bg,w:doc.w,h:doc.h};seen=new Set();lastSeq=0;out=[];sent.clear();O.on=true;O.loading=true;
 try{await catchup()}catch(e){O.loading=false;await leave('error');throw e}
 O.loading=false;localDiff();connect();$('#st').textContent='En línea · '+room.name.slice(0,24);sync();D=1;
 tmr.push(setInterval(liveTick,150),setInterval(()=>{tick++;const n=Date.now(),now=performance.now();
  if(tick%20===0||(doc.act!==lastAct&&tick%2===0))hbNow();
  if(down&&n-downSince>20000){downSince=n;closeCh();connect()}   // si Supabase no recupera el canal solo, se reconstruye
  if(doc.strokes.some(s=>s.live&&now-(s.t||0)>6000)){doc.strokes=doc.strokes.filter(s=>{if(s.live&&now-(s.t||0)>6000){mir.s.delete(s.i);return false}return true});D=1}},1000));
 requestAnimationFrame(loop);hbNow();draw()}
async function leave(why){const r=room;if(!r)return;room=null;O.on=false;O.loading=false;teardown();
 if(why==='left'){try{await rpc('leave_room',{p_room:r.id})}catch{}}
 let saved=false;if((why==='closed'||why==='gone'||why==='full')&&doc.strokes.some(s=>!s.live)){try{await saveCopy(r);saved=true}catch{}}
 for(const[,p]of peers)p.el.remove();peers.clear();out=[];sent.clear();roster=[];
 if(PS){Object.assign(doc,PS.d);undo=PS.u;redo=PS.r;PS=null}
 try{bgI.value=doc.bg}catch{}fit();sync();D=1;if(p5.classList.contains('on'))listL();
 $('#st').textContent='Guardado';$('#bO').classList.remove('live');view_='menu';draw();
 const cp=saved?' Se guardó una copia del dibujo en Proyectos.':'';
 toast(why==='closed'?'La sala se ha cerrado (la cerró el anfitrión o caducó).'+cp:why==='hosted'?'Has cerrado la sala.':why==='full'?'Tu plaza fue ocupada mientras estabas desconectado: la sala está llena.'+cp:why==='gone'?'Ya no formas parte de la sala.'+cp:why==='error'?'No se pudo cargar la sala.':'Has salido de la sala.',4200)}
async function saveCopy(r){const o=document.createElement('canvas');o.width=160;o.height=Math.round(160*doc.h/doc.w);render(o.getContext('2d'),0,160/doc.w,0,doc.w,doc.h);
 await tx('pj','readwrite',s=>s.put({id:nid(),name:('Sala: '+r.name).slice(0,60),mod:Date.now(),thumb:o.toDataURL('image/jpeg',.7),doc:{strokes:doc.strokes.filter(s=>!s.live),layers:doc.layers,act:doc.act,bg:doc.bg,w:doc.w,h:doc.h}}))}
async function closeRoom(){const a=await ask({t:'¿Cerrar la sala?',m:'Todos los participantes serán expulsados. Se guardará una copia en tus proyectos.',ok:'Cerrar sala',okc:'red'});if(a.r!=='ok')return;
 try{await rpc('close_room',{p_room:room.id});bc('hint',{});await saveCopy(room);toast('Copia guardada en Proyectos',1800)}catch(e){toast(errMsg(e));return}leave('hosted')}

/* ---------- crear / unirse ---------- */
async function doCreate(n,pw){
 const r=await rpc('create_room',{p_name:n,p_pass:pw||null,p_max:FM.max,p_user_name:getName()});
 let layers,strokes=[];if(FM.mine){layers=lyr().map(l=>({...l,u:me}));strokes=doc.strokes.filter(s=>!s.live).map(s=>{const c={...s,u:me,i:newId()};delete c.q;return c})}
 else layers=[{id:nid(),name:'Capa 1',vis:1,lock:0,op:1,u:me}];
 await rpc('push_ops',{p_room:r.room_id,p_ops:[{k:'M',p:{bg:doc.bg,w:doc.w,h:doc.h,layers}}]});
 for(let i=0;i<strokes.length;){let j=i,sz=0;while(j<strokes.length&&j-i<100&&sz<300000)sz+=JSON.stringify(strokes[j++]).length;await rpc('push_ops',{p_room:r.room_id,p_ops:strokes.slice(i,j).map(p=>({k:'s',p}))});i=j}
 await enter(r)}
async function doJoin(code,pw){const r=await rpc('join_room',{p_code:code,p_pass:pw||null,p_user_name:getName()});await enter(r)}
async function run(fn){if(wait)return;wait=true;msg('');try{await init();await fn()}catch(e){msg(errMsg(e))}finally{wait=false}}

/* ---------- panel ---------- */
const msg=t=>{const e=P().querySelector('.er');if(e)e.textContent=t||''};
function togglePanel(o){const p=P();if(o===undefined)o=!p.classList.contains('open');p.classList.toggle('open',o);if(o){closeSheet();draw()}}
const inp=(p,ph,o={})=>{const i=document.createElement('input');i.className='di';i.placeholder=ph;Object.assign(i,o);p.append(i);return i};
const note=(p,t)=>{const e=document.createElement('p');e.style.cssText='color:var(--mu);font-size:12px';e.textContent=t;p.append(e)};
const errEl=p=>{const e=document.createElement('small');e.className='er';e.style.cssText='display:block;min-height:16px;color:#ff453a;margin:2px 0';p.append(e)};
function who(p){const d=document.createElement('div');d.className='who';d.innerHTML='<span>Tu nombre: <b></b></span>';d.querySelector('b').textContent=getName()||'—';const b=document.createElement('button');b.textContent='Cambiar';b.onclick=rename;d.append(b);p.append(d)}
async function go(v){if(!await need())return;view_=v;draw()}
const layerName=id=>{const l=(doc.layers||[]).find(x=>x.id===id);return l?l.name:''};
function draw(){const p=P();if(!p||!p.classList.contains('open'))return;const keep=p.scrollTop;p.innerHTML='';
 if(room){hd(p,'Sala');const n=document.createElement('b');n.style.fontSize='17px';n.textContent=room.name;p.append(n);
  const cd=document.createElement('div');cd.className='cd';cd.innerHTML='<code></code>';cd.firstChild.textContent=room.code;const cb=document.createElement('button');cb.className='btn';cb.style.width='auto';cb.textContent='Copiar';
  cb.onclick=async()=>{try{await navigator.clipboard.writeText(room.code);toast('Código copiado',1400)}catch{const r=document.createRange();r.selectNodeContents(cd.firstChild);const s=getSelection();s.removeAllRanges();s.addRange(r);toast('Selecciona y copia el código',2000)}};cd.append(cb);p.append(cd);
  hd(p,roster.length+'/'+room.max+' jugadores'+(down?' · reconectando…':''));
  for(const m of roster){const d=document.createElement('div');d.className='pr';d.innerHTML='<i></i><span></span><small></small>';d.firstChild.style.background=col(m.color);d.querySelector('span').textContent=m.name+(m.u===me?' (tú)':'');
   if(m.host){const e=document.createElement('em');e.textContent='Anfitrión';e.className='hb';d.querySelector('span').append(' ',e)}d.querySelector('small').textContent=layerName(m.layer);p.append(d)}
  who(p);btn(p,'Guardar copia local',async()=>{try{await saveCopy(room);toast('Copia guardada en Proyectos',1800)}catch{toast('No se pudo guardar la copia')}});
  btn(p,'Abandonar sala',()=>{togglePanel(false);leave('left')});if(room.host===me)btn(p,'Cerrar sala (para todos)',closeRoom,'red');
  note(p,'Tus ajustes de pincel son solo tuyos. Los proyectos locales se restauran al salir.');return}
 hd(p,view_==='create'?'Crear sala':view_==='join'?'Unirse a una sala':'Dibujar con amigos');
 if(view_==='menu'){btn(p,'Crear sala',()=>go('create'),'pri');btn(p,'Unirse a una sala',()=>go('join'));note(p,'Hasta 5 personas dibujando a la vez. Sin cuentas ni instalación.');who(p)}
 else{const bk=btn(p,'‹ Volver',()=>{view_='menu';draw()});bk.style.width='auto';who(p);
  if(view_==='create'){const n=inp(p,'Nombre de la sala',{maxLength:60}),pw=inp(p,'Contraseña (opcional)',{type:'password',maxLength:72,autocomplete:'new-password'});
   hd(p,'Máximo de participantes');chips(p,[[2,'2'],[3,'3'],[4,'4'],[5,'5']],FM,'max');
   if(doc.strokes.length){hd(p,'Lienzo inicial');chips(p,[[false,'En blanco'],[true,'Mi dibujo actual']],FM,'mine')}
   errEl(p);btn(p,'Crear sala',()=>{const v=n.value.trim();if(!v)return msg('Pon un nombre a la sala.');run(()=>doCreate(v,pw.value))},'pri')}
  else{const c=inp(p,'Código de invitación',{maxLength:8,autocapitalize:'characters',spellcheck:false,autocomplete:'off'}),pw=inp(p,'Contraseña (si la sala la tiene)',{type:'password',maxLength:72,autocomplete:'off'});
   c.style.letterSpacing='.12em';c.oninput=()=>c.value=c.value.toUpperCase().replace(/[^A-Z0-9]/g,'');errEl(p);
   btn(p,'Entrar',()=>{if(c.value.length<8)return msg('El código tiene 8 caracteres.');run(()=>doJoin(c.value,pw.value))},'pri')}}
 p.scrollTop=keep}

/* ---------- integración con la app existente (sin sustituir su motor de dibujo) ---------- */
const _save=save,_saveNow=saveNow,_apply=apply;
save=function(){if(O.on){localDiff();return}_save()};                         // en sala no se pisa el proyecto personal
saveNow=async function(){if(O.on)return;return _saveNow()};
apply=function(s){if(!O.on)return _apply(s);                                  // deshacer/rehacer solo afecta a MIS trazos
 const ids=new Set(s.strokes.map(x=>x.i)),has=new Set(doc.strokes.map(x=>x.i));
 const keep=doc.strokes.filter(x=>!(x.u===me&&!x.live&&!ids.has(x.i))),back=s.strokes.filter(x=>x.u===me&&x.i&&!has.has(x.i)).map(x=>{const c={...x};delete c.q;return c});
 const layers=(s.layers||lyr()).map(l=>({...l})).concat(lyr().filter(l=>l.u&&l.u!==me&&!(s.layers||[]).some(x=>x.id===l.id)).map(l=>({...l})));
 _apply({...s,strokes:keep.concat(back),layers,act:s.act})};
$('#p4').addEventListener('click',e=>{if(O.on&&e.target.closest('button')&&!/tutorial/i.test(e.target.textContent)){e.stopPropagation();e.preventDefault();toast('Estás en una sala: sal de ella para gestionar tus proyectos.')}},true);
$('#bO').onclick=()=>togglePanel();
document.addEventListener('pointerdown',e=>{if(P().classList.contains('open')&&!e.target.closest('#opan,#bO,.dlg'))togglePanel(false)},true);
addEventListener('keydown',e=>{if(e.key==='Escape')togglePanel(false)});
document.addEventListener('visibilitychange',()=>{if(room&&!document.hidden){hbNow();catchup().catch(()=>{})}});
})();
