const app=document.querySelector('#app'), dialog=document.querySelector('#dialog');
let state,registration=false,dragId=null,noticeTimer;
const collapsed=new Set();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brand='<span class="brand"><img src="/mark.svg" alt="">Чеклист</span>';
function theme(){return document.documentElement.dataset.theme;}
document.documentElement.dataset.theme=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
const btn=(label,action,cls='soft',id='')=>`<button type="button" class="${cls}" data-act="${action}" data-id="${id}">${label}</button>`;
const themeButton=()=>btn(theme()==='dark'?'☀ Светлая тема':'☾ Тёмная тема','theme');
function notice(s){clearTimeout(noticeTimer);document.querySelector('#notice').textContent=s;noticeTimer=setTimeout(()=>document.querySelector('#notice').textContent='',4000);}
async function api(action,body){
  const res=await fetch('/api/'+action,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json();
  if(!res.ok)throw Object.assign(new Error(data.error),{status:res.status});
  return data;
}
async function refresh(){
  try{state=await api('state');}catch(e){if(e.status!==401)throw e;state=null;if(dialog.open)dialog.close();}
  render();
}
function field(label,name,value='',type='text',attrs=''){
  return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
}
const description=value=>`<label>Описание<textarea name="description" rows="3" maxlength="5000">${esc(value)}</textarea></label>`;
function select(label,name,items,value,empty){
  return `<label>${label}<select name="${name}">${options(items,value,empty)}</select></label>`;
}
function options(items,value,empty){
  return (empty?`<option value="">${empty}</option>`:'')+items.map(i=>`<option value="${i.id}" ${i.id===value?'selected':''}>${esc(i.name)}</option>`).join('');
}
function renderAuth(){
  const title=registration?'Создать аккаунт':'Вход в Чеклист';
  app.innerHTML=`<div class="auth"><section class="poster">${brand}<h2>Проекты<br>и задачи</h2><div class="illustration" aria-label="Пример чеклиста"><div class="sample"><small>Пример проекта</small><strong>Запуск продукта</strong><div><span>✓</span>Собрать требования</div><div><span>✓</span>Подготовить макеты</div><div><span class="pending"></span>Проверить прототип</div><div class="meter"><i style="width:67%"></i></div></div></div></section><section class="access"><div class="bar">${brand}${themeButton()}</div><div class="authform"><div class="tabs">${btn('Вход','loginTab',registration?'':'on')}${btn('Регистрация','registerTab',registration?'on':'')}</div><h1>${title}</h1><form class="form" id="auth">${registration?field('Имя','name','','text','autocomplete="name" required maxlength="100"'):''}${field('Email','email','','email','autocomplete="email" required maxlength="254"')}${field(registration?'Пароль · от 8 символов':'Пароль','password','','password',`required maxlength="256" autocomplete="${registration?'new':'current'}-password" ${registration?'minlength="8"':''}`)}<div class="error" role="alert"></div><button class="primary">${registration?'Зарегистрироваться':'Войти'}</button></form></div></section></div>`;
}
const route=()=>location.hash.slice(1);
const currentProject=()=>state?.projects.find(p=>route()==='project/'+p.id);
function empty(title,detail,action,label){return `<section class="panel blank"><div class="folder">▤</div><h2>${title}</h2><p>${detail}</p>${btn(label,action,'primary')}</section>`;}
function dashboard(){
  const cards=state.projects.map(p=>{
    const tasks=state.tasks.filter(t=>t.project===p.id),done=tasks.filter(t=>t.done).length;
    return `<button class="card" data-act="openProject" data-id="${p.id}"><span class="folder">▤</span><h2>${esc(p.name)}</h2><p>${esc(p.description)}</p><div class="bar"><span>Выполнено</span><span>${done} / ${tasks.length}</span></div><div class="meter"><i style="width:${tasks.length?100*done/tasks.length:0}%"></i></div></button>`;
  });
  return heading('Мои проекты','',cards.length?btn('＋ Проект','project','primary'):'')+(cards.length?`<div class="cards">${cards.join('')}</div>`:empty('Первый проект','Создайте проект, чтобы добавить задачи и объединить их в группы.','project','Создать проект'));
}
function heading(title,desc,actions){return `<div class="head bar"><div><h1>${esc(title)}</h1>${desc?`<p>${esc(desc)}</p>`:''}</div><div class="actions">${actions}</div></div>`;}
function taskRow(t){
  const priority=state.priorities.find(p=>p.id===t.priority);
  return `<div class="task ${t.done?'done':''}" draggable="true" data-task="${t.id}"><span class="grip" aria-hidden="true">⠿</span><input type="checkbox" data-toggle="${t.id}" aria-label="Выполнено: ${esc(t.name)}" ${t.done?'checked':''}>${btn(esc(t.name),'task','taskname',t.id)}${priority?`<span class="tag"><i class="dot" style="background:${priority.color}"></i>${esc(priority.name)}</span>`:''}${t.deadline?`<small>${t.deadline.split('-').reverse().join('.')}</small>`:''}</div>`;
}
function projectView(p){
  const tasks=state.tasks.filter(t=>t.project===p.id),groups=state.groups.filter(g=>g.project===p.id);
  const root=tasks.filter(t=>t.grp===null);
  return heading(p.name,p.description,btn('＋ Группа','group')+btn('＋ Задача','task','primary'))+`<div class="list"><section class="panel" data-drop=""><div class="bar prio"><b>Задачи проекта</b><small>${tasks.filter(t=>t.done).length} / ${tasks.length}</small></div>${root.map(taskRow).join('')||'<p class="prio">В корне проекта пока нет задач.</p>'}</section>`+groups.map(g=>{
    const items=tasks.filter(t=>t.grp===g.id);
    return `<details data-group="${g.id}" data-drop="${g.id}" ${collapsed.has(g.id)?'':'open'}><summary>${esc(g.name)} <small>· ${items.length}</small></summary><div class="groupbody">${items.map(taskRow).join('')}${btn('＋ Задача в группе','groupTask','smallbtn',g.id)}</div></details>`;
  }).join('')+'</div>';
}
function priorities(){
  return heading('Приоритеты','',btn('＋ Приоритет','priority','primary'))+`<div class="list">${state.priorities.map(p=>`<div class="panel prio bar"><span class="row"><i class="dot" style="background:${p.color}"></i>${esc(p.name)}</span>${btn('Изменить','priority','smallbtn',p.id)}</div>`).join('')}</div>`;
}
function render(){
  if(!state)return renderAuth();
  const p=currentProject(),pr=route()==='priorities';
  app.innerHTML=`<div class="layout"><aside>${brand}<nav class="navlist">${btn('▦　Проекты','home','nav '+(pr?'':'on'))}${btn('◉　Приоритеты','pri','nav '+(pr?'on':''))}</nav><div class="profile"><div class="account"><span class="avatar">${esc(Array.from(state.user.name)[0])}</span><b>${esc(state.user.name)}</b></div>${btn('Выйти','logout','nav')}</div></aside><section class="workspace"><div class="top bar"><span>${p?btn('Мои проекты','home','smallbtn')+' / Проект':'Рабочее пространство'}</span>${themeButton()}</div><div class="content">${p?projectView(p):pr?priorities():dashboard()}</div></section></div>`;
}
function editor(kind,id,grp){
  const p=currentProject(), object=(kind==='task'?state.tasks:kind==='priority'?state.priorities:[]).find(x=>x.id===id)||{};
  const project=object.project||p?.id;
  const titles={task:id?'Изменить задачу':'Новая задача',group:'Новая группа',priority:id?'Изменить приоритет':'Новый приоритет',project:'Новый проект'};
  let fields=field('Название','name',object.name,'text','required maxlength="180" autofocus');
  if(kind==='task')fields+=select('Проект','project',state.projects,project)+select('Группа','grp',state.groups.filter(g=>g.project===project),object.grp||grp,'Без группы')+`<div class="two">${select('Приоритет','priority',state.priorities,object.priority,'Без приоритета')}${field('Дедлайн','deadline',object.deadline,'date')}</div>`+description(object.description);
  if(kind==='project')fields+=description('');
  if(kind==='priority')fields+=field('Цвет','color',object.color||'#7364c5','color');
  let order='';
  if(kind==='task'&&id){
    const siblings=state.tasks.filter(t=>t.project===project&&t.grp===object.grp);
    const i=siblings.findIndex(t=>t.id===id);
    order='<div class="actions">'+(i>0?btn('↑ Выше','up','smallbtn',id):'')+(i<siblings.length-1?btn('↓ Ниже','down','smallbtn',id):'')+'</div>';
  }
  dialog.innerHTML=`<h2 id="dt">${titles[kind]}</h2><form class="form" data-kind="${kind}" data-id="${id||''}">${fields}${order}<div class="error" role="alert"></div><div class="actions">${btn('Отмена','close')}<button class="primary">Сохранить</button></div></form>`;
  dialog.setAttribute('aria-labelledby','dt');dialog.showModal();
}
async function act(action,id){
  if(action==='theme'){document.documentElement.dataset.theme=theme()==='dark'?'light':'dark';localStorage.setItem('theme',theme());document.querySelectorAll('[data-act=theme]').forEach(b=>b.textContent=theme()==='dark'?'☀ Светлая тема':'☾ Тёмная тема');return;}
  if(action==='close')return dialog.close();
  if(action==='loginTab'||action==='registerTab'){registration=action==='registerTab';return render();}
  if(action==='home'||action==='pri'||action==='openProject'){location.hash=action==='home'?'projects':action==='pri'?'priorities':'project/'+id;return;}
  if(action==='logout'){await api('logout',{});location.hash='';await refresh();return;}
  if(action==='up'||action==='down'){
    const t=state.tasks.find(x=>x.id===id),siblings=state.tasks.filter(x=>x.grp===t.grp&&x.project===t.project),i=siblings.indexOf(t);
    await api('move',{id,grp:t.grp,before:siblings[action==='up'?i-1:i+2]?.id??null});dialog.close();await refresh();return;
  }
  if(action==='groupTask')return editor('task',null,id);
  editor(action,id);
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(b)act(b.dataset.act,Number(b.dataset.id)||null).catch(err=>notice(err.message));});
document.addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target,button=f.querySelector('button:not([type=button])');
  button.disabled=true;const data=Object.fromEntries(new FormData(f));
  try{
    if(f.id==='auth')await api(registration?'register':'login',data);
    else{
      for(const k of ['grp','project','priority'])if(k in data)data[k]=Number(data[k])||null;
      if(f.dataset.id)data.id=Number(f.dataset.id);
      if(f.dataset.kind==='group')data.project=currentProject().id;
      const result=await api(f.dataset.kind,data);
      dialog.close();
      if(f.dataset.kind==='project')location.hash='project/'+result.id;
      if(f.dataset.kind==='task')location.hash='project/'+data.project;
    }
    await refresh();
  }catch(err){f.querySelector('.error').textContent=err.message;}finally{button.disabled=false;}
});
document.addEventListener('change',async e=>{
  const el=e.target;
  if(el.name==='project'&&dialog.open)el.form.elements.grp.innerHTML=options(state.groups.filter(g=>g.project===Number(el.value)),null,'Без группы');
  if(el.dataset.toggle){el.disabled=true;try{await api('toggle',{id:Number(el.dataset.toggle),done:el.checked});await refresh();}catch(err){el.checked=!el.checked;el.disabled=false;notice(err.message);}}
});
app.addEventListener('toggle',e=>{if(e.target.matches('details[data-group]')){const id=Number(e.target.dataset.group);if(e.target.open)collapsed.delete(id);else collapsed.add(id);}},true);
app.addEventListener('dragstart',e=>{const row=e.target.closest('[data-task]');if(row){dragId=Number(row.dataset.task);e.dataTransfer.setData('text/plain',String(dragId));e.dataTransfer.effectAllowed='move';}});
app.addEventListener('dragover',e=>{const target=e.target.closest('[data-task],[data-drop]');if(dragId&&target){e.preventDefault();app.querySelector('.over')?.classList.remove('over');target.classList.add('over');}});
app.addEventListener('dragend',()=>{dragId=null;app.querySelector('.over')?.classList.remove('over');});
app.addEventListener('drop',async e=>{
  const zone=e.target.closest('[data-drop]');if(!dragId||!zone)return;e.preventDefault();
  const id=dragId,before=Number(e.target.closest('[data-task]')?.dataset.task)||null;
  if(id!==before)try{await api('move',{id,before,grp:Number(zone.dataset.drop)||null});await refresh();}catch(err){notice(err.message);}
});
window.addEventListener('hashchange',render);
refresh().catch(err=>{app.textContent=err.message;});
