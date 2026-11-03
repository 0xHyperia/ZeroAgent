function zeroAgentSitePreview(appOrigin) {
  if (parent === window) return;
  let channel = "", enabled = false, path = "", selected = null, hovered = null, marks = [];
  const nodes = new Map(), ids = new WeakMap();
  const prefix = location.pathname.match(/^\/v\/[^/]+\//)?.[0];
  if (!prefix) return;
  path = decodeURIComponent(location.pathname.slice(prefix.length));
  const hashText = text => [...text].reduce((n,c) => (Math.imul(n,31)+c.charCodeAt(0))|0,0) >>> 0;
  const hash = hashText(path).toString(36);
  const send = value => channel && parent.postMessage({ type:"zeroagent-site",channel,path,...value },appOrigin);
  const layer = document.createElement("div");
  layer.setAttribute("data-zeroagent-overlay", "");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483645";
  const hover = document.createElement("div"),active = document.createElement("div");
  layer.append(hover,active);
  const style = document.createElement("style");
  style.textContent = "[data-zeroagent-annotating] *{cursor:var(--zeroagent-comment-cursor,pointer)!important}[data-zeroagent-overlay] div{position:absolute;box-sizing:border-box;pointer-events:none;border-radius:2px}[data-zeroagent-overlay] [data-mark]{border:2px dashed #3785f6;background:#3785f61a}[data-zeroagent-overlay] [data-mark]:after{content:'';position:absolute;right:-10px;top:-12px;width:25px;height:25px;background:var(--zeroagent-comment-pin) center/contain no-repeat;filter:drop-shadow(0 2px 3px #0002)}";
  function mount() { if(!layer.isConnected)document.documentElement.append(style,layer); }
  function id(el) {
    if(!ids.has(el)) { const key=`site:${hash}:${hashText(selector(el))}`;ids.set(el,key);nodes.set(key,el); }
    return ids.get(el);
  }
  function findNode(key) {
    if(nodes.get(key)?.isConnected)return nodes.get(key);
    // Immutable build + DOM path gives the same locator after navigation/reload.
    for(const el of [...document.querySelectorAll("body *")].slice(0,6000)) {
      if(!layer.contains(el)&&id(el)===key)return el;
    }
    return null;
  }
  function block(target) {
    if(!(target instanceof Element)||layer.contains(target))return null;
    return target.closest("h1,h2,h3,h4,h5,h6,p,li,td,th,button,a,label,input,img,section,article,[role=button]") || (target===document.body||target===document.documentElement?null:target);
  }
  function selector(el) {
    const parts=[];
    for(let node=el;node&&node!==document.body&&parts.length<24;node=node.parentElement) {
      const tag=node.tagName.toLowerCase();
      const at=[...(node.parentElement?.children||[])].filter(other=>other.tagName===node.tagName).indexOf(node)+1;
      parts.unshift(`${tag}:nth-of-type(${at})`);
    }
    return parts.join(" > ").slice(0,400);
  }
  function rect(el,box) {
    if(!el?.isConnected) { box.style.display="none";return null; }
    const r=el.getBoundingClientRect();
    box.style.cssText=`position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;display:${r.bottom>0&&r.top<innerHeight?"block":"none"}`;
    return r;
  }
  let ticking=false;
  function draw() {
    ticking=false;mount();
    rect(enabled?hovered:null,hover);hover.style.border="1px solid #3785f6";
    const r=rect(enabled?selected:null,active);active.setAttribute("data-mark","");
    for(const item of layer.querySelectorAll("[data-saved]"))item.remove();
    for(const mark of marks.slice(0,20)) {
      if(mark.block.split(":")[1]!==hash)continue;
      const el=findNode(mark.block);if(!el||el===selected&&enabled)continue;
      const box=document.createElement("div");box.setAttribute("data-saved","");box.setAttribute("data-mark","");rect(el,box);layer.append(box);
    }
    if(selected&&enabled&&r)send({event:"position",id:id(selected),x:r.left,y:r.bottom,width:r.width,height:r.height,visible:r.bottom>64&&r.top<innerHeight-20});
  }
  const schedule=()=>{if(!ticking){ticking=true;requestAnimationFrame(draw);}};
  function choose(el) {
    selected=el;const r=el.getBoundingClientRect();
    const quote=(el.innerText||el.textContent||el.getAttribute("alt")||el.getAttribute("aria-label")||el.tagName).trim().slice(0,1500);
    send({event:"selection",id:id(el),quote,selector:selector(el),x:r.left,y:r.bottom,width:r.width,height:r.height,visible:true});schedule();
  }
  addEventListener("message",event=>{
    const data=event.data;
    if(event.source!==parent||event.origin!==appOrigin||data?.type!=="zeroagent-site-command"||typeof data.channel!=="string"||!/^[0-9a-f-]{36}$/.test(data.channel))return;
    if(data.command==="init") { channel=data.channel;send({event:"ready",title:document.title.slice(0,160)}); }
    if(data.channel!==channel)return;
    if(data.command==="mode") {
      enabled=data.enabled===true;document.documentElement.toggleAttribute("data-zeroagent-annotating",enabled);
      if(typeof data.cursor==="string"&&data.cursor.length<2000)document.documentElement.style.setProperty("--zeroagent-comment-cursor",data.cursor);
      if(typeof data.pin==="string"&&data.pin.length<2000)document.documentElement.style.setProperty("--zeroagent-comment-pin",data.pin);
      if(!enabled){selected=null;hovered=null;}schedule();
    }
    if(data.command==="marks"&&Array.isArray(data.marks)) { marks=data.marks.slice(0,20).filter(m=>typeof m.block==="string");schedule(); }
    if(data.command==="navigate"&&typeof data.id==="string") { const el=findNode(data.id);if(el){el.scrollIntoView({block:"center",behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"});choose(el);} }
    if(data.command==="clear"){selected=null;schedule();}
  });
  let dragStart=null,dragged=false,suppressClick=false;
  document.addEventListener("pointerdown",event=>{
    if(!enabled||event.button!==0)return;
    dragStart={el:block(event.target),x:event.clientX,y:event.clientY};dragged=false;
    event.preventDefault();event.stopImmediatePropagation();
  },true);
  document.addEventListener("pointermove",event=>{if(enabled){
    hovered=block(event.target);
    if(dragStart&&Math.hypot(event.clientX-dragStart.x,event.clientY-dragStart.y)>6){
      dragged=true;
      let container=dragStart.el;
      while(container&&!container.contains(hovered))container=container.parentElement;
      if(container&&container!==document.body&&container!==document.documentElement)hovered=container;
    }
    schedule();
  }},true);
  document.addEventListener("pointerup",event=>{
    if(!enabled||!dragStart)return;
    const el=dragged?hovered:dragStart.el;dragStart=null;suppressClick=true;
    event.preventDefault();event.stopImmediatePropagation();if(el)choose(el);
  },true);
  addEventListener("pointercancel",()=>{dragStart=null;});
  document.addEventListener("click",event=>{
    if(enabled) { const el=block(event.target);event.preventDefault();event.stopImmediatePropagation();if(suppressClick)suppressClick=false;else if(el)choose(el);return; }
    const link=event.target instanceof Element?event.target.closest("a[href]"):null;
    if(!link||!channel)return;
    const url=new URL(link.getAttribute("href"),location.href);
    if(url.origin===location.origin&&url.pathname.startsWith(prefix)&&url.pathname!==location.pathname) {
      event.preventDefault();send({event:"navigate",target:decodeURIComponent(url.pathname.slice(prefix.length))});
    }
  },true);
  addEventListener("scroll",schedule,true);addEventListener("resize",schedule);
  new ResizeObserver(schedule).observe(document.documentElement);
  mount();
}
