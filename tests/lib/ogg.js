/**
 * Leitor Ogg independente — usado só nos testes, para verificar o que a
 * extensão produz. Não compartilha código com js/local-bootstrap.js de
 * propósito: se os dois concordarem, é porque o arquivo é válido de verdade.
 */

"use strict";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/** Lê todos os campos de uma página Ogg, validando capture pattern e CRC. */
function parsePages(buf) {
  const b = new Uint8Array(buf);
  const pages = [];
  let p = 0;

  while (p < b.length) {
    if (b.length - p < 27) throw new Error(`página truncada no offset ${p}`);
    if (b[p] !== 0x4f || b[p + 1] !== 0x67 || b[p + 2] !== 0x67 || b[p + 3] !== 0x53) {
      throw new Error(`capture pattern inválido no offset ${p}`);
    }
    if (b[p + 4] !== 0) throw new Error("versão Ogg diferente de 0");

    const headerType = b[p + 5];

    let granule = 0n;
    for (let i = 0; i < 8; i++) granule |= BigInt(b[p + 6 + i]) << BigInt(8 * i);

    const serial = b[p + 14] | (b[p + 15] << 8) | (b[p + 16] << 16) | (b[p + 17] << 24);
    const seq = b[p + 18] | (b[p + 19] << 8) | (b[p + 20] << 16) | (b[p + 21] << 24);
    const storedCrc = (b[p + 22] | (b[p + 23] << 8) | (b[p + 24] << 16) | (b[p + 25] << 24)) >>> 0;
    const segCount = b[p + 26];

    const segs = b.slice(p + 27, p + 27 + segCount);
    let payloadSize = 0;
    for (const s of segs) payloadSize += s;

    const pageEnd = p + 27 + segCount + payloadSize;
    if (pageEnd > b.length) throw new Error(`payload da página passa do fim do arquivo (offset ${p})`);

    // CRC é calculado com o campo zerado
    const copy = b.slice(p, pageEnd);
    copy[22] = 0;
    copy[23] = 0;
    copy[24] = 0;
    copy[25] = 0;
    const calc = crc32(copy);
    if (calc !== storedCrc) {
      throw new Error(`CRC inválido na página ${seq}: esperado ${storedCrc}, calculado ${calc}`);
    }

    const payload = b.slice(p + 27 + segCount, pageEnd);

    // segmentos -> pacotes (um pacote termina quando o segmento < 255)
    const packets = [];
    let acc = 0;
    let start = 0;
    for (const s of segs) {
      acc += s;
      if (s < 255) {
        packets.push(payload.slice(start, acc));
        start = acc;
      }
    }

    pages.push({ headerType, granule, serial, seq, packets, payloadSize });
    p = pageEnd;
  }

  return pages;
}

/** Pacotes de áudio (todos menos OpusHead e OpusTags). */
function audioPackets(pages) {
  const all = [];
  for (const pg of pages) for (const pk of pg.packets) all.push(pk);
  return all.slice(2);
}

function readOpusHead(packet) {
  if (packet.length < 19) throw new Error("OpusHead curto");
  const magic = String.fromCharCode(...packet.slice(0, 8));
  if (magic !== "OpusHead") throw new Error(`magic inválido: ${magic}`);
  return {
    version: packet[8],
    channels: packet[9],
    preSkip: packet[10] | (packet[11] << 8),
    inputRate: packet[12] | (packet[13] << 8) | (packet[14] << 16) | (packet[15] << 24),
    mappingFamily: packet[18],
  };
}

function readOpusTags(packet) {
  const magic = String.fromCharCode(...packet.slice(0, 8));
  if (magic !== "OpusTags") throw new Error(`magic inválido: ${magic}`);
  const len = packet[8] | (packet[9] << 8) | (packet[10] << 16) | (packet[11] << 24);
  return { vendor: String.fromCharCode(...packet.slice(12, 12 + len)) };
}

/** Validações estruturais completas. Lança se algo estiver errado. */
function validateOgg(buf) {
  const pages = parsePages(buf);
  if (!pages.length) throw new Error("nenhuma página");

  const head = readOpusHead(pages[0].packets[0]);
  if (head.version !== 1) throw new Error("versão do OpusHead != 1");
  if (head.channels < 1 || head.channels > 2) throw new Error("canais inválidos");
  if (head.inputRate !== 48000) throw new Error(`input rate != 48000 (${head.inputRate})`);
  if (!(pages[0].headerType & 0x02)) throw new Error("primeira página não é BOS");

  const tags = readOpusTags(pages[0].packets[1] || pages[1].packets[0]);
  if (!tags.vendor) throw new Error("OpusTags sem vendor");

  // numeração e serial contínuos
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].seq !== i) throw new Error(`sequência quebrada: página ${i} tem seq ${pages[i].seq}`);
    if (pages[i].serial !== pages[0].serial) throw new Error("serial inconsistente");
  }

  // granulepos monotônico não-decrescente
  for (let i = 1; i < pages.length; i++) {
    if (pages[i].granule < pages[i - 1].granule) {
      throw new Error(`granulepos regrediu na página ${i}`);
    }
  }

  const last = pages[pages.length - 1];
  if (!(last.headerType & 0x04)) throw new Error("última página não é EOS");

  const audio = audioPackets(pages);
  if (!audio.length) throw new Error("nenhum pacote de áudio");

  return { pages, head, tags, audio, finalGranule: last.granule };
}

module.exports = { parsePages, validateOgg, audioPackets, readOpusHead, readOpusTags, crc32 };
