/**
 * web/pages.ts — the two HTML surfaces the sidecar serves: the admin PANEL and the
 * signed-out/signed-in ACCEPT_PAGE that turns a share link into a join.
 */
import { CFG } from '../config.ts';
import { state } from '../state.ts';

export const PANEL = () => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${CFG.name} — shared albums</title>
<style>
 body{margin:0;font-family:Inter,-apple-system,sans-serif;background:#101216;color:#e5e7eb;display:grid;place-items:start center;min-height:100vh}
 main{width:min(560px,92vw);padding:40px 0}
 h1{font-size:20px;letter-spacing:-.02em} h1 small{color:#6b7280;font-weight:400}
 .card{background:#1f2229;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;margin:14px 0}
 form{display:flex;gap:8px} input{flex:1;font:inherit;font-size:14px;padding:10px 12px;border-radius:11px;border:1px solid rgba(255,255,255,.12);background:#15171c;color:inherit;outline:none}
 input:focus{border-color:#4250af;box-shadow:0 0 0 3px rgba(66,80,175,.25)}
 button{font:inherit;font-size:14px;font-weight:600;padding:10px 18px;border:0;border-radius:11px;background:#4250af;color:#fff;cursor:pointer}
 .item{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:14px}
 .muted{color:#6b7280} #msg{font-size:13px;margin-top:10px;color:#8b9cf9;min-height:18px}
</style>
<main>
 <h1>🔗 Shared albums <small>· ${CFG.name}</small></h1>
 <div class="card"><b style="font-size:14px">Join an album</b>
  <p class="muted" style="font-size:13px">Paste a share link from another household.</p>
  <form onsubmit="j(event)"><input id="u" placeholder="https://their-server/share/…"><button>Join</button></form>
  <div id="msg"></div></div>
 <div class="card"><b style="font-size:14px">Shared albums</b>
  ${state.mappings.map(m => `<div class="item"><span>${m.albumName}</span><span class="muted">${m.role} · ${(state.peers.find(p => p.pub === m.peer) || {}).name || ''}</span></div>`).join('') || '<p class="muted" style="font-size:13px">None yet.</p>'}</div>
 <div class="card"><b style="font-size:14px">Connected households</b>
  ${state.peers.map(p => `<div class="item"><span>${p.name}</span><span class="muted">${p.url}${p.version ? ` · v${p.version}` : ''}</span></div>`).join('') || '<p class="muted" style="font-size:13px">None yet.</p>'}</div>
</main>
<script>async function j(e){e.preventDefault();const el=document.getElementById('msg');el.textContent='Joining…';
 const r=await fetch('join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:document.getElementById('u').value})});
 const d=await r.json().catch(()=>({error:'failed'}));
 el.textContent=r.ok?('Joined "'+d.album+'" from '+d.from+' — '+d.photos+' photos syncing. It will appear in your app shortly.'):('Error: '+(d.error||r.status));
 if(r.ok)setTimeout(()=>location.reload(),2500)}</script>`;
export const ACCEPT_PAGE = () => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join shared album — ${CFG.name}</title>
<style>
 body{margin:0;font-family:Overpass,Inter,Roboto,-apple-system,sans-serif;background:#f8f9fa;color:#202124;display:grid;place-items:center;min-height:100vh}
 .card{width:min(440px,calc(100vw - 32px));box-sizing:border-box;background:#fff;border:1px solid rgba(0,0,0,.06);border-radius:28px;padding:30px 26px 26px;text-align:center;box-shadow:0 1px 3px rgba(60,64,67,.15),0 8px 28px rgba(60,64,67,.15)}
 .logo{width:56px;height:56px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;background:linear-gradient(135deg,#4250af,#7c3aed);font-size:26px;box-shadow:0 2px 10px rgba(66,80,175,.35)}
 h1{font-size:19px;font-weight:600;margin:0 0 6px;letter-spacing:-.01em} p{color:#5f6368;font-size:13.5px;line-height:1.55;margin:6px 0 18px}
 button{font:inherit;font-size:15px;font-weight:600;padding:12px 36px;border:0;border-radius:999px;background:#4250af;color:#fff;cursor:pointer;transition:filter .15s,box-shadow .15s}
 button:hover{filter:brightness(1.08);box-shadow:0 2px 10px rgba(66,80,175,.4)} button:disabled{opacity:.4;cursor:default;box-shadow:none}
 button.busy{opacity:.85}
 .spin{display:inline-block;width:14px;height:14px;margin-right:9px;vertical-align:-2px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:isa-spin .8s linear infinite}
 @keyframes isa-spin{to{transform:rotate(360deg)}}
 #who{font-size:12.5px;color:#4250af;margin:-6px 0 16px;line-height:1.5} #who a{color:#4250af}
 #out{margin-top:16px;font-size:13px;color:#4250af;min-height:20px;line-height:1.5}
 @media (prefers-color-scheme:dark){
  body{background:#101216;color:#e8eaed}
  .card{background:#1b1f26;border-color:rgba(255,255,255,.08);box-shadow:0 1px 3px rgba(0,0,0,.4),0 10px 32px rgba(0,0,0,.5)}
  p{color:#9aa0a6} #who,#who a,#out{color:#a8c7fa}
  button{background:#a8c7fa;color:#0d1b3d}
 }
</style>
<div class="card"><div class="logo">🔗</div><h1 id="t">Join shared album?</h1>
<p id="d">This will add the album to your account on <b>${CFG.name}</b>. Photos stay on their owners' servers.</p>
<div id="who"></div>
<button id="go" disabled>Accept &amp; join</button><div id="out"></div></div>
<script>
const frag=(()=>{
 try{ if(location.hash.length>1) return JSON.parse(decodeURIComponent(location.hash.slice(1))); }catch{}
 const qp=new URLSearchParams(location.search);
 if(qp.get('h')&&qp.get('k')){ const f={v:1,host:qp.get('h'),scheme:qp.get('s')||'https',key:qp.get('k')};
   history.replaceState({},'',location.pathname); return f; }
 return null;})();
if(!frag||!frag.host||!frag.key){document.getElementById('t').textContent='Invalid or expired invite';document.getElementById('go').style.display='none';}
let ME=null,POLL=null;
function whoami(){return fetch('/api/users/me',{credentials:'include'}).then(r=>r.ok?r.json():null).then(u=>{
 if(u&&u.id){ME=u;clearInterval(POLL);document.getElementById('go').disabled=false;
   document.getElementById('who').textContent='Joining as '+u.name+' — the album is added only to your account.';}
 else if(!ME){document.getElementById('who').innerHTML='<a href="/auth/login" target="_blank">Sign in to your Immich</a> to join — this page will notice once you are signed in.';}
 return u;}).catch(()=>null);}
whoami().then(u=>{if(!u)POLL=setInterval(whoami,2500);});
document.getElementById('go').onclick=async()=>{
 if(!ME)return;
 const go=document.getElementById('go');
 go.disabled=true;go.classList.add('busy');
 go.innerHTML='<span class="spin"></span>Joining — syncing photos…';
 const out=document.getElementById('out');out.textContent='';
 const scheme=frag.scheme||'https';
 const r=await fetch('/sidecar/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:scheme+'://'+frag.host+'/share/'+frag.key,forUserId:ME.id})});
 const d=await r.json().catch(()=>({error:'failed'}));
 if(r.ok){
   // album-specific deeplink: the app registers my.immich.app/albums/<id> (the bare
   // list path is NOT registered and falls through to the web fallback)
   var deep='intent://my.immich.app/albums/'+d.albumId+'#Intent;scheme=https;package=app.alextran.immich;S.browser_fallback_url='+encodeURIComponent('https://my.immich.app/albums/'+d.albumId)+';end';
   out.innerHTML='Joined "'+d.album+'" from '+d.from+'.'+(d.permissions==='view'?'<br><span style="font-size:12px">View-only album: you can look and comment, but photos you add stay on your server.</span>':'')+'<br><br>'+
     '<a id="openapp" style="display:inline-block;background:#4250af;color:#fff;text-decoration:none;font-weight:600;padding:12px 30px;border-radius:999px;opacity:.45;pointer-events:none"><span class="spin"></span>Syncing 0/'+d.photos+'…</a>';
   document.getElementById('go').style.display='none';
   // the deeplink only behaves once the album is real and filled — watch it fill live
   var btn=document.getElementById('openapp'), t0=Date.now();
   var ready=function(){btn.innerHTML='Open in Immich app';btn.style.opacity='1';btn.style.pointerEvents='auto';btn.href=deep;};
   if(!d.photos){ready();}
   else{var iv=setInterval(function(){
     fetch('/api/albums/'+d.albumId+'?withoutAssets=true',{credentials:'include'}).then(function(x){return x.json();}).then(function(a){
       var n=a.assetCount||0;
       btn.innerHTML='<span class="spin"></span>Syncing '+Math.min(n,d.photos)+'/'+d.photos+'…';
       if(n>=d.photos||Date.now()-t0>90000){clearInterval(iv);ready();}
     }).catch(function(){if(Date.now()-t0>90000){clearInterval(iv);ready();}});
   },1500);}
 } else { out.textContent='Error: '+(d.error||r.status); go.disabled=false; go.classList.remove('busy'); go.textContent='Accept & join'; }
};
</script>`;
