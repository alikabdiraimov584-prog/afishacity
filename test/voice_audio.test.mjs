// Подготовка звука перед отправкой в SpeechKit. Ошибка здесь не видна глазом:
// она проявляется как «агент плохо распознаёт», поэтому проверяется числами.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const src=readFileSync(new URL("../public/voice.js",import.meta.url),"utf8");
const body=src.slice(src.indexOf("const TARGET_RATE"),src.indexOf("const WORKLET"));
const {downsample,toPcm16,rms}=new Function(body+"; return {downsample,toPcm16,rms}")();

test("понижение частоты даёт ожидаемую длину", () => {
  const input=new Float32Array(48000).fill(0.5);
  const out=downsample(input,48000,16000);
  assert.equal(out.length,16000,"секунда звука остаётся секундой");
  assert.ok(Math.abs(out[100]-0.5)<1e-6,"постоянный сигнал не искажается");
});

test("усреднение окна, а не прореживание", () => {
  // Чередование +1/-1: при взятии каждого третьего отсчёта получился бы
  // постоянный сигнал, при усреднении — близкий к нулю.
  const input=new Float32Array(300);
  for(let i=0;i<input.length;i++)input[i]=i%2?1:-1;
  const out=downsample(input,48000,16000);
  const peak=Math.max(...Array.from(out,Math.abs));
  assert.ok(peak<0.7,`прореживание дало бы 1, получили ${peak.toFixed(2)}`);
});

test("частота не повышается", () => {
  const input=new Float32Array(100).fill(0.25);
  assert.equal(downsample(input,8000,16000).length,100,"апсемплинг не нужен и не делается");
});

test("перевод в 16-битный PCM сохраняет форму и границы", () => {
  const chunks=[new Float32Array([0,0.5,-0.5,1,-1,2,-2])];
  const pcm=toPcm16(chunks,16000);
  assert.equal(pcm.length,7);
  assert.equal(pcm[0],0);
  assert.equal(pcm[3],32767,"единица — максимум");
  assert.equal(pcm[4],-32768,"минус единица — минимум");
  assert.equal(pcm[5],32767,"выход за диапазон обрезается, а не переполняется");
  assert.equal(pcm[6],-32768);
  assert.ok(pcm instanceof Int16Array);
});

test("несколько кусков склеиваются по порядку", () => {
  const pcm=toPcm16([new Float32Array([1,1]),new Float32Array([-1,-1])],16000);
  assert.deepEqual(Array.from(pcm),[32767,32767,-32768,-32768]);
});

test("громкость считается как среднеквадратичное", () => {
  assert.equal(rms(new Float32Array([0,0,0,0])),0);
  assert.ok(Math.abs(rms(new Float32Array([1,-1,1,-1]))-1)<1e-9);
  assert.ok(rms(new Float32Array([0.1,-0.1]))<0.2,"тишина остаётся тишиной");
});

test("секунда речи укладывается в предел короткого распознавания", () => {
  // 16 кГц × 2 байта × 25 с = 800 КБ, предел SpeechKit — мегабайт.
  const bytes=16000*2*25;
  assert.ok(bytes<1024*1024,`${Math.round(bytes/1024)} КБ должно быть меньше 1024 КБ`);
});

test("порог тишины и предел записи согласованы", () => {
  const silence=Number(/const SILENCE_MS=(\d+)/.exec(src)[1]);
  const max=Number(/const MAX_MS=(\d+)/.exec(src)[1]);
  const min=Number(/const MIN_MS=(\d+)/.exec(src)[1]);
  assert.ok(min<silence,"запись не должна обрываться раньше, чем распознана тишина");
  assert.ok(silence<max);
  const bytesAtMax=(max/1000)*16000*2;
  assert.ok(bytesAtMax<1024*1024,
    `при пределе ${max} мс выйдет ${Math.round(bytesAtMax/1024)} КБ, а SpeechKit берёт до 1024 КБ`);
});
