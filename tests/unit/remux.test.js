"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const lib = require("../../extensao/js/local-bootstrap.js");
const ogg = require("../lib/ogg");

const FIX = path.resolve(__dirname, "../fixtures");
const read = (f) => new Uint8Array(fs.readFileSync(path.join(FIX, f)));

// Ogg usa a variante NÃO refletida do CRC-32 (poly 0x04C11DB7, init 0, sem xor
// final) — diferente do zlib/ethernet, cujo valor para "123456789" é 0xCBF43926.
function oggCrcBitwise(data) {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

test("CRC32 confere com implementação bit a bit independente", () => {
  const entradas = [
    new TextEncoder().encode("123456789"),
    new Uint8Array(0),
    new Uint8Array([0x00, 0xff, 0x10, 0x7f, 0x80]),
    read("mono.webm").slice(0, 512),
  ];
  for (const e of entradas) {
    assert.strictEqual(lib.crc32(e), oggCrcBitwise(e), "divergência no CRC");
  }
  assert.strictEqual(lib.crc32(new TextEncoder().encode("123456789")), 0x89a1897f);
});

test("CRC32 do módulo confere com os CRCs gravados pelo ffmpeg", () => {
  // parsePages recalcula o CRC de cada página e compara com o campo gravado.
  // O arquivo de referência foi gerado por outra implementação (ffmpeg), então
  // isto é um teste cruzado real.
  const pages = ogg.parsePages(read("mono-ref.ogg"));
  assert.ok(pages.length > 3);
});

for (const nome of ["mono", "stereo", "live"]) {
  test(`remux ${nome}: Ogg estruturalmente válido`, () => {
    const out = lib.webmOpusToOgg(read(`${nome}.webm`));
    const v = ogg.validateOgg(out);
    assert.strictEqual(v.head.channels, nome === "stereo" ? 2 : 1);
    assert.ok(v.audio.length > 10, `poucos pacotes: ${v.audio.length}`);
  });

  test(`remux ${nome}: pacotes Opus idênticos ao gabarito do ffmpeg`, () => {
    const nosso = ogg.audioPackets(ogg.parsePages(lib.webmOpusToOgg(read(`${nome}.webm`))));
    const ref = ogg.audioPackets(ogg.parsePages(read(`${nome}-ref.ogg`)));

    assert.strictEqual(
      nosso.length,
      ref.length,
      `${nome}: quantidade de pacotes difere (nosso ${nosso.length}, ffmpeg ${ref.length})`
    );

    for (let i = 0; i < ref.length; i++) {
      assert.deepStrictEqual(
        Buffer.from(nosso[i]),
        Buffer.from(ref[i]),
        `${nome}: pacote ${i} difere do ffmpeg`
      );
    }
  });

  test(`remux ${nome}: duração e granulepos coerentes`, () => {
    const dur = { mono: 2, stereo: 2, live: 3 }[nome];
    const v = ogg.validateOgg(lib.webmOpusToOgg(read(`${nome}.webm`)));
    const segundos = Number(v.finalGranule / 48000n);
    assert.ok(
      Math.abs(segundos - dur) < 0.15,
      `${nome}: duração ${segundos.toFixed(3)}s, esperado ~${dur}s`
    );
  });
}

test("entrada já em Ogg passa intacta", async () => {
  const entrada = read("mono-ref.ogg");
  const blob = new Blob([entrada], { type: "audio/ogg" });
  const out = new Uint8Array(await (await lib.toOgg(blob)).arrayBuffer());
  assert.deepStrictEqual(Buffer.from(out), Buffer.from(entrada));
});

test("arquivo que não é webm nem ogg não quebra (devolve original)", async () => {
  const falso = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41]);
  const blob = new Blob([falso], { type: "audio/mp4" });
  const out = await lib.toOgg(blob);
  assert.strictEqual(out.size, falso.length);
});

test("webm truncado não lança exceção", async () => {
  const inteiro = read("mono.webm");
  const blob = new Blob([inteiro.slice(0, 900)], { type: "audio/webm" });
  const out = await lib.toOgg(blob);
  assert.ok(out.size > 0, "devolveu algo mesmo truncado");
});

test("webm com bytes corrompidos no meio não lança exceção", async () => {
  const b = read("mono.webm").slice();
  for (let i = 400; i < 1200; i += 7) b[i] = 0xff;
  const out = await lib.toOgg(new Blob([b], { type: "audio/webm" }));
  assert.ok(out.size > 0);
});

test("blob vazio não derruba o fluxo", async () => {
  const out = await lib.toOgg(new Blob([], { type: "audio/webm" }));
  assert.ok(out.size >= 0);
});

test("remux é determinístico no conteúdo (mesmos pacotes, serial diferente)", () => {
  const a = ogg.audioPackets(ogg.parsePages(lib.webmOpusToOgg(read("mono.webm"))));
  const b = ogg.audioPackets(ogg.parsePages(lib.webmOpusToOgg(read("mono.webm"))));
  assert.strictEqual(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.deepStrictEqual(Buffer.from(a[i]), Buffer.from(b[i]));
});
