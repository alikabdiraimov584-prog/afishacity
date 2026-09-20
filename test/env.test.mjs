import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseDotenv,loadDotenv} from "../env.mjs";

test("parseDotenv: комментарии, кавычки, export и пробелы", () => {
  const {vars,bad}=parseDotenv([
    "# комментарий",
    "",
    "HOST=127.0.0.1",
    "export PORT = 3000",
    'NAME="Москва вечером"',
    "EMPTY=",
    "URL=https://example.com/a=b"
  ].join("\n"));
  assert.deepEqual(bad,[]);
  assert.equal(vars.get("HOST"),"127.0.0.1");
  assert.equal(vars.get("PORT"),"3000");
  assert.equal(vars.get("NAME"),"Москва вечером");
  assert.equal(vars.get("EMPTY"),"");
  assert.equal(vars.get("URL"),"https://example.com/a=b");
});

test("parseDotenv: строки без КЛЮЧ=значение попадают в bad с номерами", () => {
  const {vars,bad}=parseDotenv([
    "8960892007:AAEoIbxTJKLB",   // 1: токен вставлен без имени переменной
    "systemctl restart free",     // 2: команда, а не настройка
    "TELEGRAM_BOT_TOKEN=123:abc", // 3
    "=безымянный"                 // 4
  ].join("\n"));
  assert.deepEqual(bad,[1,2,4]);
  assert.equal(vars.size,1);
  assert.equal(vars.get("TELEGRAM_BOT_TOKEN"),"123:abc");
});

test("loadDotenv: окружение важнее файла, пустое значение заполняется", () => {
  const dir=mkdtempSync(join(tmpdir(),"free-env-"));
  const file=join(dir,".env");
  writeFileSync(file,"HOST=1.2.3.4\nTELEGRAM_BOT_TOKEN=из-файла\nмусор\n");
  const env={HOST:"0.0.0.0",TELEGRAM_BOT_TOKEN:""};
  const {loaded,bad}=loadDotenv(file,env);
  assert.equal(env.HOST,"0.0.0.0");
  assert.equal(env.TELEGRAM_BOT_TOKEN,"из-файла");
  assert.deepEqual(loaded,["TELEGRAM_BOT_TOKEN"]);
  assert.deepEqual(bad,[3]);
});

test("loadDotenv: отсутствующий файл не ломает запуск", () => {
  assert.deepEqual(loadDotenv("/nope/nowhere/.env",{}),{loaded:[],bad:[]});
});
