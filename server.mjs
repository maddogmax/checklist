import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const hashPassword = promisify(scrypt);
const db = new DatabaseSync(process.env.DB_PATH || '/data/checklist.db');
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL,email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,name TEXT NOT NULL,description TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,project INTEGER NOT NULL REFERENCES projects ON DELETE CASCADE,name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS priorities(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,name TEXT NOT NULL,color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,project INTEGER NOT NULL REFERENCES projects ON DELETE CASCADE,grp INTEGER REFERENCES groups ON DELETE SET NULL,priority INTEGER REFERENCES priorities ON DELETE SET NULL,name TEXT NOT NULL,description TEXT NOT NULL,deadline TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,pos INTEGER NOT NULL);`);
const sql = query => db.prepare(query);
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function string(value,max,required=false){
  if(typeof value!=='string'||value.trim().length>max||(required&&!value.trim()))fail('Проверьте заполненные поля.');
  return value.trim();
}
function owned(table,id,user){
  const row=Number.isSafeInteger(id)&&sql('SELECT * FROM '+table+' WHERE id=? AND user_id=?').get(id,user);
  if(!row)fail('Запись не найдена.',404);
  return row;
}
function transaction(fn){
  db.exec('BEGIN IMMEDIATE');
  try{const result=fn(); db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
}
function sessionToken(req){
  const raw=(req.headers.cookie||'').match(/(?:^|; )__Host-checklist=([a-f0-9]{64})(?:;|$)/)?.[1]||'';
  return digest(raw);
}
function digest(s){return createHash('sha256').update(s).digest('hex');}
const attempts=new Map();
function limit(ip){
  const now=Date.now(), bucket=attempts.get(ip);
  if(!bucket||bucket.until<now) attempts.set(ip,{n:1,until:now+600000});
  else if(++bucket.n>40)fail('Слишком много попыток. Попробуйте позже.',429);
}
setInterval(()=>{for(const [ip,b] of attempts)if(b.until<Date.now())attempts.delete(ip);
sql('DELETE FROM sessions WHERE expires<?').run(Date.now());},600000).unref();
async function auth(action,b,req,res){
  limit(req.headers['x-forwarded-for']?.split(',').at(-1)?.trim()||req.socket.remoteAddress);
  const email=string(b.email,254,true).toLowerCase(),password=b.password;
  if(typeof password!=='string'||password.length>256)fail('Проверьте пароль.');
  let user=sql('SELECT * FROM users WHERE email=?').get(email);
  if(action==='register'){
    const name=string(b.name,100,true);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8)fail('Введите email и пароль длиной от 8 символов.');
    const salt=randomBytes(16).toString('hex'),hash=(await hashPassword(password,salt,64)).toString('hex');
    user=transaction(()=>{
      if(sql('SELECT id FROM users WHERE email=?').get(email))fail('Этот email уже зарегистрирован.',409);
      const id=Number(sql('INSERT INTO users(name,email,salt,hash) VALUES(?,?,?,?)').run(name,email,salt,hash).lastInsertRowid);
      for(const [label,color] of [['Обычный','#6875ca'],['Высокий','#d88a32'],['Срочный','#cf5268']])sql('INSERT INTO priorities(user_id,name,color) VALUES(?,?,?)').run(id,label,color);
      return {id};
    });
  }else{
    const hash=await hashPassword(password,user?.salt||'invalid-address',64);
    if(!user||!timingSafeEqual(hash,Buffer.from(user.hash,'hex')))fail('Проверьте email и пароль.',401);
  }
  const token=randomBytes(32).toString('hex');
  sql('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),user.id,Date.now()+2592000000);
  res.setHeader('Set-Cookie','__Host-checklist='+token+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
  return {ok:true};
}
function change(action,b,u){
  if(action==='toggle'){
    owned('tasks',b.id,u);
    sql('UPDATE tasks SET done=? WHERE id=?').run(b.done===true?1:0,b.id);
    return;
  }
  if(action==='move'){
    const t=owned('tasks',b.id,u);
    if(b.grp!==null&&owned('groups',b.grp,u).project!==t.project)fail('Проверьте группу.');
    const ids=sql('SELECT id FROM tasks WHERE project=? AND grp IS ? AND id!=? ORDER BY pos,id').all(t.project,b.grp,b.id).map(x=>x.id);
    const at=b.before===null?ids.length:ids.indexOf(b.before);
    if(at<0)fail('Список изменился. Обновите страницу.');
    ids.splice(at,0,b.id);
    ids.forEach((id,i)=>sql('UPDATE tasks SET pos=?,grp=? WHERE id=?').run(i,b.grp,id));
    return;
  }
  const table={project:'projects',group:'groups',priority:'priorities',task:'tasks'}[action];
  if(!['projects','groups','priorities','tasks'].includes(table))fail('Неизвестное действие.',404);
  const old=b.id==null?null:owned(table,b.id,u);
  const fields={name:string(b.name,180,true)};
  if(action==='project'||action==='task')fields.description=string(b.description||'',5000);
  if(action==='priority'){
    if(!/^#[0-9a-f]{6}$/i.test(b.color))fail('Некорректный цвет.');
    fields.color=b.color;
  }
  if(action==='task'||action==='group')fields.project=owned('projects',b.project,u).id;
  if(action==='group'&&old&&old.project!==fields.project)fail('Группа принадлежит другому проекту.');
  if(action==='task'){
    fields.grp=b.grp==null?null:owned('groups',b.grp,u).id;
    if(fields.grp&&owned('groups',fields.grp,u).project!==fields.project)fail('Выберите группу этого проекта.');
    fields.priority=b.priority==null?null:owned('priorities',b.priority,u).id;
    fields.deadline=string(b.deadline||'',10);
    if(fields.deadline && (!/^\d{4}-\d{2}-\d{2}$/.test(fields.deadline)||!Number.isFinite(Date.parse(fields.deadline))||new Date(fields.deadline).toISOString().slice(0,10)!==fields.deadline))fail('Проверьте дату.');
    if(!old||old.project!==fields.project||old.grp!==fields.grp)fields.pos=sql('SELECT COALESCE(MAX(pos),-1)+1 AS n FROM tasks WHERE project=? AND grp IS ?').get(fields.project,fields.grp).n;
  }
  const keys=Object.keys(fields),values=Object.values(fields);
  if(old)sql('UPDATE '+table+' SET '+keys.map(k=>k+'=?').join(',')+' WHERE id=?').run(...values,old.id);
  else return {id:Number(sql('INSERT INTO '+table+'(user_id,'+keys.join(',')+') VALUES(?,'+keys.map(()=>'?').join(',')+')').run(u,...values).lastInsertRowid)};
}
const assets=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']],['/mark.svg',['mark.svg','image/svg+xml']]].map(([path,[file,mime]])=>[path,[readFileSync(new URL('./public/'+file,import.meta.url)),mime]]));
http.createServer(async(req,res)=>{
  const path=req.url.split('?')[0];
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
    if(req.method==='GET'&&assets.has(path)){
      const [data,mime]=assets.get(path);res.setHeader('Content-Type',mime+'; charset=utf-8');return res.end(data);
    }
    res.setHeader('Content-Type','application/json; charset=utf-8');
    const user=sql('SELECT u.id,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(sessionToken(req),Date.now());
    if(req.method==='GET'&&path==='/api/state'){
      if(!user)fail('Войдите в аккаунт.',401);
      const state={user};
      for(const table of ['projects','groups','priorities','tasks'])state[table]=sql('SELECT * FROM '+table+' WHERE user_id=? ORDER BY '+(table==='tasks'?'pos,id':'id')).all(user.id);
      return res.end(JSON.stringify(state));
    }
    if(req.method!=='POST'||!path.startsWith('/api/'))fail('Не найдено.',404);
    if(req.headers['content-type']!=='application/json')fail('Требуется JSON.',415);
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>32768)fail('Слишком много данных.',413);chunks.push(chunk);}
    let b;try{b=JSON.parse(Buffer.concat(chunks));}catch{fail('Некорректный JSON.');}
    if(!b||typeof b!=='object'||Array.isArray(b))fail('Некорректные данные.');
    const action=path.slice(5);
    let result;
    if(['login','register'].includes(action))result=await auth(action,b,req,res);
    else{
      if(!user)fail('Войдите в аккаунт.',401);
      if(action==='logout'){sql('DELETE FROM sessions WHERE token=?').run(sessionToken(req));res.setHeader('Set-Cookie','__Host-checklist=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');}
      else result=transaction(()=>change(action,b,user.id));
    }
    res.end(JSON.stringify(result||{ok:true}));
  }catch(e){if(!e.status)console.error('Request failure',e.name);res.statusCode=e.status||500;res.end(JSON.stringify({error:e.status?e.message:'Ошибка сервера.'}));}
}).listen(8080,'0.0.0.0');
