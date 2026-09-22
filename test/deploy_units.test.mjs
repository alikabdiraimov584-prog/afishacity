// Юнит-файлы systemd и установщик. Ошибка здесь не ловится ничем: systemd
// молча игнорирует ключ не в той секции, а несогласованные числа выясняются
// только тогда, когда боевая машина уже встала.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const unit=(name)=>readFileSync(new URL(`../deploy/${name}`,import.meta.url),"utf8");
const sections=(text)=>{
  const out={};let cur="";
  for(const raw of text.split("\n")){
    const line=raw.trim();
    if(line.startsWith("#")||!line)continue;
    const s=/^\[(\w+)\]$/.exec(line);
    if(s){cur=s[1];out[cur]=out[cur]||[];continue}
    if(cur)out[cur].push(line);
  }
  return out;
};
const val=(lines,key)=>{
  const hit=(lines||[]).find(l=>l.startsWith(key+"="));
  return hit?hit.slice(key.length+1):null;
};
const mb=(v)=>v&&/^(\d+)M$/.test(v)?Number(RegExp.$1):null;
const heapFlag=(exec)=>/--max-old-space-size=(\d+)/.test(exec)?Number(RegExp.$1):null;

const UNITS=["free.service","free-snapshot.service"];

test("предел кучи задан явно у обеих служб", () => {
  // Без флага V8 берёт под кучу примерно половину физической памяти: измерено —
  // на машине с 16 ГБ потолок 8240 МБ. На боевом сервере с 956 МБ это ~470 МБ
  // на КАЖДЫЙ процесс, то есть сервер и сборка вдвоём имеют право занять всю
  // память до ядра, nginx и sshd.
  for(const u of UNITS){
    const exec=val(sections(unit(u)).Service,"ExecStart");
    assert.ok(heapFlag(exec),`${u}: у node нет --max-old-space-size`);
  }
});

test("потолок кучи помещается под предел памяти службы", () => {
  // V8 добавляет к --max-old-space-size своё: 160 даёт 208 МБ, 256 даёт 304 МБ.
  // Если MemoryMax окажется ниже, служба будет убита своей же клеткой раньше,
  // чем V8 соберёт мусор, — и это будет выглядеть как случайные падения.
  const real=(flag)=>Math.round(flag*1.1875)+16;      // проверено замером на 160 и 256
  for(const u of UNITS){
    const svc=sections(unit(u)).Service;
    const ceiling=real(heapFlag(val(svc,"ExecStart")));
    const max=mb(val(svc,"MemoryMax")),high=mb(val(svc,"MemoryHigh"));
    assert.ok(max,`${u}: нет MemoryMax`);
    assert.ok(max>ceiling+64,`${u}: MemoryMax ${max} МБ не оставляет запаса над кучей ~${ceiling} МБ`);
    assert.ok(high&&high<max,`${u}: MemoryHigh должен быть мягче MemoryMax`);
  }
});

test("обе службы вместе помещаются в память боевой машины", () => {
  // 956 МБ всего. Сверх служб на машине живут ядро, nginx и sshd — если им не
  // останется, до сервера будет не достучаться ровно тогда, когда это нужно.
  const total=UNITS.reduce((a,u)=>a+mb(val(sections(unit(u)).Service,"MemoryMax")),0);
  assert.ok(total<=760,`жёсткие пределы в сумме ${total} МБ — на систему остаётся меньше 200 МБ`);
});

test("ограничитель перезапусков стоит в той секции, где systemd его читает", () => {
  // StartLimitIntervalSec в [Service] systemd молча игнорирует: он пишет
  // «Unknown key name» и продолжает. Замысел при этом пропадает целиком.
  for(const u of UNITS){
    const s=sections(unit(u));
    for(const key of ["StartLimitIntervalSec","StartLimitBurst"]){
      assert.equal(val(s.Service,key),null,`${u}: ${key} в [Service] не читается`);
    }
  }
  const snap=sections(unit("free-snapshot.service"));
  assert.ok(val(snap.Unit,"StartLimitBurst"),"у сборки должен быть предел числа заходов");
});

test("установщик не падает из-за необязательной подкачки", () => {
  // На контейнерной виртуализации ядро подкачку не даёт, и swapon отказывает.
  // При set -e это обрывало бы установку до выкладки кода и служб.
  const sh=readFileSync(new URL("../deploy/install.sh",import.meta.url),"utf8");
  // Комментарии выбрасываем: они объясняют, как было раньше, и их упоминания
  // старых путей не должны выглядеть как сам код.
  const block=sh.slice(sh.indexOf("Подкачка:"),sh.indexOf("node_major()"))
    .split("\n").filter(l=>!/^\s*#/.test(l)).join("\n");
  assert.match(block,/set -e/.test(sh)?/if mkswap[^\n]*&& swapon/:/swapon/,
    "swapon должен стоять под if, а не голой командой");
  assert.ok(!/^\s*mkswap -q \/swapfile >\/dev\/null && swapon \/swapfile\s*$/m.test(block),
    "голая цепочка с swapon обрывает скрипт при отказе ядра");
  assert.match(block,/rm -f \/swapfile/,"неудавшийся файл подкачки надо убирать, а не оставлять гигабайт впустую");
  // На свежих Ubuntu /etc/sysctl.conf нет: дописывание в него печатало ошибку
  // и заводило файл, которого в системе быть не должно.
  assert.ok(!/sysctl\.conf/.test(block),"настройки ядра пишутся в /etc/sysctl.d, а не в /etc/sysctl.conf");
  assert.match(block,/sysctl\.d\/99-free\.conf/,"свой файл настроек видно как наш и легко убрать");
});
