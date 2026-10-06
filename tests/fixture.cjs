function fixture(scenario = 'normal') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Maps fixture</title><style>body{font:14px Arial;background:#eef4f0;margin:24px}input{padding:12px;width:350px}[role=feed]{height:240px;width:430px;overflow:auto;background:white}[role=article]{height:100px;border-bottom:1px solid #ddd;padding:10px}h1{font-size:24px}</style></head><body>
  <input id="searchboxinput" value="painter in Dubai"><div id="list" role="feed"></div><div id="detail" role="main" hidden></div>
  <script>
  const scenario = ${JSON.stringify(scenario)};
  const compact = scenario.startsWith('compact');
  const list = document.querySelector('#list');
  const detail = document.querySelector('#detail');
  const original = location.href;
  window.detailOpens = [];
  const businesses = [
    { id:'branchA', name:'Same name', phone:'050 706 4831' },
    { id:'branchB', name:'Same name', phone:'050 706 4832', site:'https://facebook.com/branch?x=%2F' },
    { id:'branchC', name:'مصمم, "دبي"', site:'https://example.test/Exact?Q=%2F' },
    { id:'branchD', name:'Unknown site', phone:'050 706 4833', unknown:true },
    { id:'branchE', name:'No phone or website' },
    { id:'branchF', name:'Advertisement', phone:'050 706 4834', ad:true },
    { id:'branchA', name:'Same name', phone:'050 706 4831' }
  ].filter((_, index) => scenario !== 'compact-failed' || index === 0);
  let loaded = 0;
  function addBatch() {
    const total = scenario === 'slow' ? 3 : Math.min(businesses.length, loaded + 3);
    while (loaded < total) {
      const b = businesses[loaded++];
      const card = document.createElement('div'); card.setAttribute('role','article');
      card.dataset.fixtureId = b.id;
      if (compact) card.className = 'Nv2PK THOPZb CpccDe';
      if (b.ad) { const badge=document.createElement('button'); badge.dataset.url='https://adssettings.google.com/aboutthisad?source=maps'; badge.textContent='إعلان'; card.append(badge); }
      const a = document.createElement('a'); a.href = '/maps/place/' + b.name.replace(/[^a-z]/gi,'') + '/data=!1s' + b.id; a.setAttribute('aria-label', scenario === 'blank' ? '' : b.name);
      let pressed = false;
      a.addEventListener('mousedown',()=>{pressed=true;});
      a.onclick = e => { e.preventDefault(); if(scenario==='compact-activation' && !pressed)return; pressed=false;open(b,a.href); }; card.append(a);
      if (scenario !== 'blank') { const name = document.createElement('div'); name.className = 'fontHeadlineSmall'; name.textContent = b.name; card.append(name); }
      const category = document.createElement('span'); category.dataset.category = 'Painter'; category.textContent = 'Painter'; card.append(category);
      if (b.phone && !compact) { const phone = document.createElement('span'); phone.className='UsdlK'; phone.textContent=b.phone; card.append(phone); }
      if (b.site && !compact) { const site=document.createElement('a'); site.dataset.value='Website'; site.href=b.site; site.textContent='موقع'; card.append(site); }
      if (b.unknown && !compact) { const button=document.createElement('button'); button.dataset.value='Website'; button.textContent='موقع'; card.append(button); }
      list.append(card);
    }
    if (loaded === businesses.length && scenario !== 'slow') { const end=document.createElement('div'); end.dataset.endOfList='true'; end.textContent='نهاية'; list.append(end); }
  }
  function open(b, href) {
    window.detailOpens.push(b.id); history.pushState({},'',href); list.hidden = true; detail.hidden = false; detail.replaceChildren();
    const h=document.createElement('h1'); h.textContent=b.name; detail.append(h);
    const category=document.createElement('button'); category.dataset.itemId='category'; category.textContent='Painter'; detail.append(category);
    function hydrateContacts() {
      if (compact) { const address=document.createElement('button'); address.dataset.itemId='address'; address.textContent='1 Street'; detail.append(address); }
      if (b.phone) { const p=document.createElement('button'); p.dataset.itemId='phone:tel:'+(scenario==='failed' ? b.phone : '+971 '+b.phone.substring(1)); p.textContent=scenario==='failed' ? b.phone : '+971 '+b.phone.substring(1); detail.append(p); }
      if (b.unknown || b.site) { const a=document.createElement('a'); a.dataset.itemId='authority'; a.href=b.site || 'https://instagram.com/exact?x=%2F'; a.textContent='موقع'; detail.append(a); }
    }
    if (scenario === 'compact-late') {
      setTimeout(hydrateContacts, 500);
      if (window.detailOpens.length === 1) setTimeout(()=>{addBatch();addBatch();},100);
    } else if (scenario !== 'compact-failed') hydrateContacts();
    if (scenario === 'compact-recycled' && window.detailOpens.length === 1) {
      setTimeout(()=>{
        for (const [oldId,newId] of [['branchB','branchC'],['branchC','branchB']]) {
          const reused=list.querySelector('[data-fixture-id="'+oldId+'"] a');
          const replacement=businesses.find(item=>item.id===newId);
          reused.href='/maps/place/'+replacement.name.replace(/[^a-z]/gi,'')+'/data=!1s'+replacement.id;
          reused.setAttribute('aria-label',replacement.name);
          reused.onclick=e=>{e.preventDefault();open(replacement,reused.href);};
        }
      },100);
    }
    const back=document.createElement('button'); back.setAttribute('jsaction','pane.backToList'); back.textContent='رجوع'; back.onclick=()=>{history.replaceState({},'',original); detail.hidden=true;list.hidden=false;};detail.append(back);
  }
  if (scenario === 'single') { history.replaceState({},'','/maps/place/Single/data=!1ssingle'); const h=document.createElement('h1');h.textContent='Single business';detail.append(h);detail.hidden=false;list.remove(); }
  else if (scenario === 'zero') { list.remove(); const p=document.createElement('p');p.dataset.noResults='true';p.textContent='لا توجد نتائج';document.body.append(p); }
  else if (scenario === 'consent') { list.remove(); const form=document.createElement('form');form.action='https://consent.google.com/save';document.body.append(form); }
  else if (scenario === 'layout') list.remove();
  else { addBatch(); let pending=false; list.addEventListener('scroll',()=>{if(!pending && loaded < businesses.length && scenario!=='slow'){pending=true;setTimeout(()=>{addBatch();pending=false;},180)}}); }
  </script></body></html>`;
}
module.exports = { fixture };
