// Хранилище FREE на встроенной SQLite (node:sqlite, Node 22+). Без внешних зависимостей.
// Профиль пользователя, сохранённое, план, история вечеров, события для обучения вкуса,
// история диалогов и общие планы по ссылке.
import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";

export const TASTE_DIMS=["romantic","quiet","trendy","luxury","hidden","late","family","work","active","culture","music","nightlife","outdoors"];
// Вес события при обучении вкуса: бронь говорит о предпочтении больше, чем просмотр.
const EVENT_WEIGHT={book:0.5,save:0.35,plan_add:0.3,select:0.25,share:0.2,dismiss:-0.15};

const SCHEMA=`
create table if not exists users(id integer primary key, tg_id integer unique, anon_id text unique, first_name text, created_at text not null, last_seen text not null);
create table if not exists profiles(user_id integer primary key references users(id), taste text not null default '{}', saved text not null default '[]', plan text not null default '[]', updated_at text not null);
create table if not exists evenings(id text primary key, user_id integer not null references users(id), title text, date text, plan text not null, created_at text not null);
create index if not exists evenings_user on evenings(user_id, created_at desc);
create table if not exists events(id integer primary key, user_id integer not null references users(id), type text not null, payload text, ts text not null);
create index if not exists events_user on events(user_id, ts desc);
create table if not exists conversations(id text primary key, user_id integer, messages text not null, updated_at integer not null);
create table if not exists shared_plans(id text primary key, rec text not null, created_at text not null);
`;

function now(){return new Date().toISOString()}
function clampTaste(t){const o={};for(const k of TASTE_DIMS){const v=Number(t?.[k]);o[k]=Number.isFinite(v)?Math.max(-5,Math.min(5,Math.round(v*100)/100)):0}return o}
function parse(s,fallback){try{return JSON.parse(s)}catch{return fallback}}

export function openStore(file=":memory:"){
  if(file!==":memory:")mkdirSync(dirname(file),{recursive:true});
  const db=new DatabaseSync(file);
  db.exec("pragma journal_mode=wal; pragma synchronous=normal;");
  db.exec(SCHEMA);
  const q={
    userByTg:db.prepare("select * from users where tg_id=?"),
    userByAnon:db.prepare("select * from users where anon_id=?"),
    userById:db.prepare("select * from users where id=?"),
    insUser:db.prepare("insert into users(tg_id,anon_id,first_name,created_at,last_seen) values(?,?,?,?,?)"),
    touch:db.prepare("update users set last_seen=?, first_name=coalesce(?,first_name) where id=?"),
    linkAnon:db.prepare("update users set tg_id=? where id=? and tg_id is null"),
    profile:db.prepare("select * from profiles where user_id=?"),
    upsertProfile:db.prepare("insert into profiles(user_id,taste,saved,plan,updated_at) values(?,?,?,?,?) on conflict(user_id) do update set taste=excluded.taste,saved=excluded.saved,plan=excluded.plan,updated_at=excluded.updated_at"),
    insEvening:db.prepare("insert into evenings(id,user_id,title,date,plan,created_at) values(?,?,?,?,?,?)"),
    evenings:db.prepare("select id,title,date,plan,created_at from evenings where user_id=? order by created_at desc limit ?"),
    delEvening:db.prepare("delete from evenings where id=? and user_id=?"),
    insEvent:db.prepare("insert into events(user_id,type,payload,ts) values(?,?,?,?)"),
    countEvents:db.prepare("select type, count(*) as n from events where user_id=? group by type"),
    conv:db.prepare("select * from conversations where id=?"),
    upsertConv:db.prepare("insert into conversations(id,user_id,messages,updated_at) values(?,?,?,?) on conflict(id) do update set messages=excluded.messages,updated_at=excluded.updated_at,user_id=coalesce(excluded.user_id,conversations.user_id)"),
    sweepConv:db.prepare("delete from conversations where updated_at<?"),
    lastConv:db.prepare("select id from conversations where user_id=? order by updated_at desc limit 1"),
    insShared:db.prepare("insert into shared_plans(id,rec,created_at) values(?,?,?)"),
    shared:db.prepare("select rec from shared_plans where id=?"),
    pruneShared:db.prepare("delete from shared_plans where id in (select id from shared_plans order by created_at desc limit -1 offset ?)")
  };

  function ensureProfile(userId){
    let p=q.profile.get(userId);
    if(!p){q.upsertProfile.run(userId,"{}","[]","[]",now());p=q.profile.get(userId)}
    return p;
  }
  function profileOut(p){return {taste:clampTaste(parse(p.taste,{})),saved:parse(p.saved,[]),plan:parse(p.plan,[]),updated_at:p.updated_at}}

  return {
    db,
    // Идентификация: пользователь Telegram (tg_id) или анонимный клиент (anon_id из localStorage).
    // Если аноним потом открыл через Telegram с тем же клиентом — профили склеиваются.
    user({tg_id=null,anon_id=null,first_name=null}={}){
      const ts=now();
      let u=tg_id?q.userByTg.get(tg_id):null;
      if(!u&&anon_id){u=q.userByAnon.get(anon_id);if(u&&tg_id){q.linkAnon.run(tg_id,u.id);u=q.userById.get(u.id)}}
      if(!u){
        if(!tg_id&&!anon_id)return null;
        const r=q.insUser.run(tg_id,anon_id,first_name,ts,ts);u=q.userById.get(r.lastInsertRowid);
      }else q.touch.run(ts,first_name,u.id);
      return {id:u.id,tg_id:u.tg_id,anon_id:u.anon_id,first_name:first_name||u.first_name,created_at:u.created_at};
    },
    getProfile(userId){return profileOut(ensureProfile(userId))},
    updateProfile(userId,{taste,saved,plan}={}){
      const p=ensureProfile(userId);
      const next={taste:taste!==undefined?clampTaste(taste):parse(p.taste,{}),saved:Array.isArray(saved)?saved.slice(0,200):parse(p.saved,[]),plan:Array.isArray(plan)?plan.slice(0,50):parse(p.plan,[])};
      q.upsertProfile.run(userId,JSON.stringify(next.taste),JSON.stringify(next.saved),JSON.stringify(next.plan),now());
      return this.getProfile(userId);
    },
    // Обучение вкуса: событие с «ДНК» места сдвигает веса к выраженным чертам этого места.
    learn(userId,type,dna={},payload={}){
      q.insEvent.run(userId,type,JSON.stringify({...payload,dna}),now());
      const w=EVENT_WEIGHT[type];
      if(!w||!dna||typeof dna!=="object")return this.getProfile(userId).taste;
      const p=ensureProfile(userId),taste=clampTaste(parse(p.taste,{}));
      for(const k of TASTE_DIMS){const v=Number(dna[k]);if(!Number.isFinite(v))continue;taste[k]+=w*(v-50)/50}
      const t=clampTaste(taste);
      q.upsertProfile.run(userId,JSON.stringify(t),p.saved,p.plan,now());
      return t;
    },
    stats(userId){const o={};for(const r of q.countEvents.all(userId))o[r.type]=r.n;return o},
    addEvening(userId,plan,{title=null,date=null}={}){
      const id=randomUUID().replace(/-/g,"").slice(0,12);
      const slim={...plan,stops:(plan.stops||[]).map(s=>({...s,alternatives:[]}))};
      q.insEvening.run(id,userId,title,date,JSON.stringify(slim),now());return id;
    },
    evenings(userId,limit=10){return q.evenings.all(userId,limit).map(r=>({id:r.id,title:r.title,date:r.date,created_at:r.created_at,plan:parse(r.plan,null)}))},
    removeEvening(userId,id){return q.delEvening.run(id,userId).changes>0},
    // История диалога с моделью
    getConversation(id,ttlMs){const c=id?q.conv.get(id):null;if(!c)return null;if(ttlMs&&Date.now()-c.updated_at>ttlMs)return null;return {id:c.id,user_id:c.user_id,messages:parse(c.messages,[])}},
    setConversation(id,messages,userId=null){q.upsertConv.run(id,userId,JSON.stringify(messages),Date.now())},
    sweepConversations(ttlMs){return q.sweepConv.run(Date.now()-ttlMs).changes},
    lastConversationId(userId){return q.lastConv.get(userId)?.id||null},
    // Общие планы по ссылке
    setShared(id,rec){q.insShared.run(id,JSON.stringify(rec),now());q.pruneShared.run(5000)},
    getShared(id){const r=q.shared.get(id);return r?parse(r.rec,null):null},
    close(){db.close()}
  };
}
