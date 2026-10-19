/* DENTYAR V100 diagnostic probe. No login, password, auth token, patient data, or database writes. */
(function(){
  'use strict';
  const WORKER='https://dentyar-sync-relay.dentyar-cloudflare.workers.dev';
  const DB='https://dentyar-458d9-default-rtdb.europe-west1.firebasedatabase.app';
  const NS='dentyar-458d9-default-rtdb';
  const nativeFetch=window.__dentyarProbeNativeFetch || window.fetch.bind(window);
  const timeoutMs=8000;
  function el(tag, styles){const n=document.createElement(tag);Object.assign(n.style,styles||{});return n;}
  const btn=el('button',{position:'fixed',right:'10px',bottom:'12px',zIndex:'2147483647',background:'#b91c1c',color:'#fff',border:'2px solid #fff',borderRadius:'18px',padding:'9px 13px',font:'bold 13px sans-serif',boxShadow:'0 2px 8px #555'});
  btn.textContent='PROBE';
  const panel=el('div',{position:'fixed',inset:'8% 4% 8% 4%',zIndex:'2147483647',background:'#fff',color:'#111',border:'2px solid #334155',borderRadius:'12px',padding:'12px',overflow:'auto',display:'none',direction:'rtl',textAlign:'right',font:'14px/1.7 sans-serif',boxShadow:'0 4px 18px #333'});
  const head=el('div',{display:'flex',justifyContent:'space-between',alignItems:'center',gap:'8px'});
  const title=el('strong');title.textContent='آزمون تشخیصی اتصال دنت‌یار';
  const close=el('button',{padding:'5px 10px'});close.textContent='بستن';
  head.append(title,close);panel.append(head);
  const intro=el('p');intro.textContent='VPN را خاموش کنید و «اجرای آزمون» را بزنید. هیچ رمز، توکن یا اطلاعات بیمار ارسال یا نمایش داده نمی‌شود.';panel.append(intro);
  const run=el('button',{padding:'9px 12px',background:'#0f766e',color:'#fff',border:'0',borderRadius:'7px',fontWeight:'bold'});run.textContent='اجرای آزمون';panel.append(run);
  const status=el('pre',{whiteSpace:'pre-wrap',overflowWrap:'anywhere',background:'#f1f5f9',padding:'10px',borderRadius:'8px',font:'13px/1.7 monospace'});status.textContent='آماده آزمون';panel.append(status);
  const note=el('p');note.textContent='پس از پایان، از همین صفحه عکس بگیرید و بفرستید.';panel.append(note);
  function showPanel(e){if(e){if(e.cancelable)e.preventDefault();e.stopPropagation();}panel.style.setProperty('display','block','important');panel.style.setProperty('visibility','visible','important');panel.style.setProperty('pointer-events','auto','important');return false;}function hidePanel(e){if(e){if(e.cancelable)e.preventDefault();e.stopPropagation();}panel.style.setProperty('display','none','important');return false;}btn.setAttribute('type','button');close.setAttribute('type','button');btn.style.setProperty('pointer-events','auto','important');btn.style.setProperty('touch-action','manipulation','important');btn.style.setProperty('user-select','none','important');panel.style.setProperty('pointer-events','auto','important');btn.onclick=showPanel;btn.onpointerup=showPanel;btn.ontouchend=showPanel;close.onclick=hidePanel;close.ontouchend=hidePanel;document.addEventListener('click',function(e){if(e.target===btn||btn.contains(e.target))showPanel(e);if(e.target===close||close.contains(e.target))hidePanel(e);},true);document.documentElement.append(btn,panel);
  async function request(url, label, inspect){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const res=await nativeFetch(url,{method:'GET',cache:'no-store',credentials:'omit',redirect:'manual',signal:controller.signal,headers:{'Accept':'application/json,text/plain,*/*'}});
      let body='';try{body=(await res.text()).slice(0,12000);}catch(_){}
      let extra='';
      if(inspect){const m=body.match(/["']h["']\s*:\s*["']([^"'\s]+)["']/i);if(m){try{extra='؛ میزبان h: '+new URL(/^https?:\/\//i.test(m[1])?m[1]:'https://'+m[1]).hostname;}catch(_){extra='؛ مقدار h دریافت شد';}}else if(/pLPCommand|start|error/i.test(body)){extra='؛ پاسخ handshake دریافت شد، h قابل استخراج نبود';}}
      return label+': HTTP '+res.status+(res.type==='opaqueredirect'?' (redirect مخفی)':'')+extra;
    }catch(e){return label+': شکست اتصال ('+(e&&e.name==='AbortError'?'timeout':String(e&&e.message||e).slice(0,100))+')';}
    finally{clearTimeout(timer);}
  }
  run.onclick=async()=>{
    run.disabled=true;status.textContent='آزمون در حال اجراست…';
    const results=[];
    results.push(await request(WORKER+'/health/firebase','۱) دسترسی گوشی به Worker'));
    results.push(await request(WORKER+'/.lp?start=t&ser=314159&cb=314159&v=5&ns='+encodeURIComponent(NS),'۲) handshake از مسیر Worker',true));
    results.push(await request(DB+'/.lp?start=t&ser=271828&cb=271828&v=5&ns='+encodeURIComponent(NS),'۳) handshake مستقیم Firebase',true));
    results.push(await request(WORKER+'/__dentyar_probe_no_such_record__.json?ns='+encodeURIComponent(NS),'۴) مسیر Worker تا RTDB'));
    results.push(await request(DB+'/__dentyar_probe_no_such_record__.json','۵) دسترسی مستقیم RTDB'));
    status.textContent=results.join('\n\n')+'\n\nشناسه آزمون: '+new Date().toISOString()+'\nاین آزمون تشخیصی است؛ نتیجه به‌تنهایی اثبات همگام‌سازی کامل نیست.';
    run.disabled=false;
  };
})();