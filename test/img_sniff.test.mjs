// Тип картинки — по первым байтам: CDN отдают «image/jpg» и octet-stream,
// а под видом картинки может прийти страница или SVG со скриптом.
import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV="test";
const {sniffImage}=await import("../server.mjs");
import {looksLikePhoto} from "../photos.mjs";

test("тип картинки определяется по байтам, а не по заголовку", () => {
  const pad=(b)=>Buffer.concat([Buffer.from(b),Buffer.alloc(16)]);
  assert.equal(sniffImage(pad([0xFF,0xD8,0xFF,0xE0])),"image/jpeg");
  assert.equal(sniffImage(pad([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])),"image/png");
  assert.equal(sniffImage(Buffer.concat([Buffer.from("RIFF"),Buffer.alloc(4),Buffer.from("WEBPVP8 ")])),"image/webp");
  assert.equal(sniffImage(Buffer.from("<!doctype html><html><body>hi</body></html>")),null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')),null);
});

test("og:image «null» и аватары соцсетей — не фото места", () => {
  assert.equal(looksLikePhoto("https://www.rakbank.ae/null"),false);
  assert.equal(looksLikePhoto("https://linktr.ee/og/image/danialstar.jpg"),false);
  assert.equal(looksLikePhoto("https://www.linkedin.com/posts/ten11-coffee"),false);
  assert.equal(looksLikePhoto("https://zuma.example/images/dining-room.jpg"),true);
});
