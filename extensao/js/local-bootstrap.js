/* ============================================================================
 * Leadzy — camada local / offline
 * ----------------------------------------------------------------------------
 * A extensão funciona sem `api-userv2.leadzy.com.br` e sem login.
 *
 * COMO FUNCIONA
 *   Roda ANTES do bundle original (popup, options e content script) e faz:
 *     1. Semeia a licença local no chrome.storage.local  -> passa o route guard
 *     2. Intercepta fetch/XHR para os hosts da Leadzy    -> responde localmente
 *
 * O bundle original NÃO é modificado. Para reverter, remova este arquivo do
 * manifest.json, do popup.html e do options.html.
 *
 * Os dados (mensagens, scripts, gatilhos, fluxos, áudios) já viviam em
 * chrome.storage.local e continuam lá. Nada é enviado para fora.
 * ========================================================================== */

(function () {
  "use strict";

  var G = typeof window !== "undefined" ? window : {};
  var L =
    typeof location !== "undefined"
      ? location
      : { protocol: "", href: "http://localhost/", hash: "", pathname: "/" };

  if (G.__LZ_LOCAL_ACTIVE__) return;
  G.__LZ_LOCAL_ACTIVE__ = true;

  var IS_EXTENSION_PAGE = L.protocol === "chrome-extension:";

  /* ==========================================================================
   * CONFIGURAÇÃO — mexa aqui se precisar
   * ======================================================================== */

  var CONFIG = {
    token: "local-offline.leadzy.0000000000.local",

    user: {
      id: "local-user",
      _id: "local-user",
      userId: "local-user",
      name: "Usuário Local",
      fullName: "Usuário Local",
      firstName: "Usuário",
      email: "local@localhost",
      phone: "",
      avatar: "",
      avatarUrl: "",
      photoUrl: "",
      role: "owner",
      isAdmin: true,
      organizationId: "local-org",
      organization: { id: "local-org", name: "Local" },
      status: "ACTIVE",
      createdAt: "2024-01-01T00:00:00.000Z",
    },

    // hasChat: true  -> produto CHAT (mensagens, scripts, gatilhos, fluxos)
    // hasCrm: false  -> mantenha desligado: o CRM chama /tags, /settings/team
    //                   e /notifications, que não existem localmente.
    productLines: {
      hasChat: true,
      hasCrm: false,
      isPro: true,
      activeProducts: ["CHAT"],
    },

    subscriptions: [
      {
        id: "local-sub",
        status: "ACTIVE",
        plan: "CHAT",
        period: "MONTHLY",
        expiresAt: "2099-12-31T23:59:59.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],

    // /convert: "remux" = WebM/Opus -> Ogg/Opus localmente (sem recodificar)
    //           "passthrough" = devolve o arquivo original sem tocar
    convertMode: "remux",

    // O que fazer quando um botão tenta abrir uma página do painel/site da
    // Leadzy (CRM, planos, suporte, ver como funciona...). Essas telas são o
    // produto web deles e não existem localmente.
    //   "block" -> não navega e mostra um aviso discreto  (padrão)
    //   "allow" -> deixa abrir normalmente
    offlineLinks: "block",

    debug: false,
  };

  // Texto do aviso. Fica num só lugar para facilitar trocar.
  var AVISO =
    "Este recurso fica no painel online da Leadzy e não está disponível no modo local.";

  var HOST_RE = /(^|\.)leadzy\.com\.br$/i;

  function log() {
    if (!CONFIG.debug) return;
    var a = Array.prototype.slice.call(arguments);
    a.unshift("[LZ-LOCAL]");
    console.log.apply(console, a);
  }

  function hasStorage() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  /* ==========================================================================
   * 1. LICENÇA LOCAL
   * ======================================================================== */

  function seed() {
    if (!hasStorage()) return;
    // Escrita incondicional: é o caminho mais curto entre carregar o script e
    // o route guard fazer a leitura. Sobrescrever é intencional — neste modo
    // a identidade é sempre a local.
    var patch = {};
    patch.access_token = CONFIG.token;
    patch.me = JSON.stringify(CONFIG.user);
    try {
      chrome.storage.local.set(patch, function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          log("erro ao semear:", chrome.runtime.lastError.message);
        } else {
          log("licença local semeada");
        }
      });
    } catch (e) {
      log("storage indisponível", e);
    }
  }

  seed();

  // Auto-reparo: se a SPA caiu no login antes da semeadura terminar, manda
  // para o dashboard. (As rotas são hash-based: popup.html#/login)
  function selfHeal() {
    if (!IS_EXTENSION_PAGE) return;
    if (!hasStorage()) return;
    chrome.storage.local.get(["access_token"], function (d) {
      if (d && d.access_token && /(^|#\/)login/.test(L.hash)) {
        log("auto-reparo: saindo do login");
        L.replace(L.pathname + "#/dashboard");
      }
    });
  }

  if (IS_EXTENSION_PAGE) setTimeout(selfHeal, 400);

  /* ==========================================================================
   * 2. ROTEADOR DE MOCKS
   * ======================================================================== */

  function jsonResponse(data, status) {
    return {
      status: status || 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    };
  }

  function isLeadzyUrl(url) {
    if (!url) return false;
    var u;
    try {
      u = new URL(url, L.href);
    } catch (e) {
      return false;
    }
    return HOST_RE.test(u.hostname);
  }

  function pathOf(url) {
    try {
      return new URL(url, L.href).pathname;
    } catch (e) {
      return "";
    }
  }

  /**
   * Registro das rotas realmente exercitadas. Serve para a auditoria de
   * cobertura (tests/audit/rotas.js): mostra o que foi respondido por mock
   * explícito e o que caiu no fallback genérico.
   */
  function explicito(resposta) {
    if (resposta && typeof resposta === "object") resposta.__lzExplicito = true;
    return resposta;
  }

  function registrarRota(method, path, origem) {
    if (!G.__LZ_ROUTE_LOG__) G.__LZ_ROUTE_LOG__ = [];
    var log = G.__LZ_ROUTE_LOG__;
    if (log.length >= 500) return;
    log.push({ m: method, p: path, origem: origem });
  }

  var PREFIXOS_DESATIVADOS = [
    "/deals",
    "/contacts",
    "/tickets",
    "/tasks",
    "/pipelines",
    "/products",
    "/remarketing-logs",
    "/connected-numbers",
    "/settings/team",
    "/settings/personal",
    "/trial/",
  ];

  function routeMock(url, method, body) {
    var path = pathOf(url);
    if (!path) return null;
    method = (method || "GET").toUpperCase();
    var resposta = routeMockInterno(path, method, body);
    registrarRota(method, path, resposta && resposta.__lzExplicito ? "mock" : "fallback");
    return resposta;
  }

  function routeMockInterno(path, method, body) {

    /* ---- autenticação ------------------------------------------------- */
    if (path === "/auth/login") {
      return explicito(jsonResponse({
        access_token: CONFIG.token,
        token: CONFIG.token,
        user: CONFIG.user,
      }));
    }
    if (path === "/auth/me" || path === "/users/me" || path === "/me") {
      return explicito(jsonResponse(CONFIG.user));
    }
    if (path === "/auth/logout" || path === "/auth/logout_user") {
      return explicito(jsonResponse({ success: true }));
    }

    /* ---- plano / assinatura ------------------------------------------- */
    if (path === "/plan-features/product-lines") {
      return explicito(jsonResponse(CONFIG.productLines));
    }
    if (path === "/subscriptions" || path === "/subscriptions/active") {
      return explicito(jsonResponse(CONFIG.subscriptions));
    }

    /* ---- killswitches e anúncios: sempre desligados -------------------- */
    if (path.indexOf("/feature-flags/") === 0) {
      return explicito(jsonResponse({ enabled: false }));
    }
    if (path === "/announcements/active") {
      return explicito(jsonResponse([]));
    }
    // Notificações vêm do servidor. Sem servidor, não existe notificação:
    // lista vazia é a resposta correta, não um fallback artificial.
    if (path === "/notifications") {
      return explicito(jsonResponse([]));
    }
    if (/^\/notifications\/[^/]+\/read$/.test(path)) {
      // marcar como lida: não há servidor, não há o que gravar
      return explicito(jsonResponse({ success: true }));
    }

    /* ---- infraestrutura do conversor de áudio -------------------------- */
    // O conversor original faz healthCheck em GET /health e só usa a API se
    // responder 200. Respondemos 200 porque a conversão local está no ar.
    if (path === "/health") {
      return explicito(jsonResponse({ status: "ok", service: "local" }));
    }

    /* ---- conversão de áudio ------------------------------------------- */
    if (path === "/convert") {
      return explicito(handleConvert(body));
    }

    /* ---- rotas do CRM / painel: desativadas de propósito ---------------- */
    // O produto CHAT roda com hasCrm:false. Nenhum destes endpoints é chamado
    // hoje: os botões que os disparariam abrem aba no painel, e isso está
    // bloqueado. Se algum aparecer, a resposta é a mesma do fallback, mas
    // fica marcada como "desativada" em vez de "não mapeada".
    for (var i = 0; i < PREFIXOS_DESATIVADOS.length; i++) {
      if (path.indexOf(PREFIXOS_DESATIVADOS[i]) === 0) {
        // Não simular sucesso: quem chamar isto precisa saber que não existe.
        return explicito(
          jsonResponse(
            { success: false, local: true, desativada: true, rota: path },
            501
          )
        );
      }
    }

    /* ---- qualquer outra rota dos hosts deles --------------------------- */
    // Rede de segurança: nenhum byte sai para os servidores da Leadzy.
    //
    // Antes, uma rota desconhecida recebia [] ou {success:true} — ou seja,
    // fingia ter funcionado. Se uma funcionalidade futura chamasse uma rota
    // não implementada, ela pareceria ter dado certo sem fazer nada.
    //
    // Agora a resposta é 501 explícito, e o teste de cobertura acusa.
    return jsonResponse(
      {
        success: false,
        local: true,
        nao_mapeada: true,
        rota: path,
        metodo: method,
        mensagem: "esta rota não existe na versão local",
      },
      501
    );
  }

  /* ==========================================================================
   * 3. /convert LOCAL
   * ======================================================================== */

  function handleConvert(body) {
    try {
      var file = null;
      if (body && typeof body.get === "function") {
        file = body.get("audio") || body.get("file");
      } else if (typeof Blob !== "undefined" && body instanceof Blob) {
        file = body;
      }

      if (!file) {
        return {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "audio ausente" }),
        };
      }

      if (CONFIG.convertMode === "passthrough") {
        return { status: 200, contentType: "audio/ogg", blobPromise: Promise.resolve(file) };
      }

      return { status: 200, contentType: "audio/ogg", blobPromise: toOgg(file) };
    } catch (e) {
      log("convert falhou:", e);
      return {
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: String((e && e.message) || e) }),
      };
    }
  }

  /**
   * Converte o áudio para Ogg/Opus SEM recodificar.
   *
   * O MediaRecorder do Chrome grava `audio/webm;codecs=opus`. O WhatsApp exige
   * `audio/ogg;codecs=opus`. Como o codec é o mesmo (Opus), basta trocar o
   * container: extraímos os pacotes Opus do WebM e remontamos em Ogg.
   * Sem perda, sem WebAssembly, sem servidor.
   */
  function toOgg(file) {
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);

      if (isOgg(bytes)) {
        log("já é Ogg, sem conversão");
        return new Blob([bytes], { type: "audio/ogg" });
      }

      if (!isWebm(bytes)) {
        console.warn(
          "[LZ-LOCAL] áudio não é webm/opus (provavelmente mp4/aac) — devolvendo original:",
          file.type
        );
        return new Blob([bytes], { type: file.type || "audio/ogg" });
      }

      try {
        var ogg = webmOpusToOgg(bytes);
        if (!ogg || ogg.length < 32) throw new Error("remux vazio");
        log("remux webm->ogg ok:", ogg.length, "bytes");
        return new Blob([ogg], { type: "audio/ogg" });
      } catch (e) {
        console.warn("[LZ-LOCAL] remux falhou, devolvendo original:", (e && e.message) || e);
        return new Blob([bytes], { type: "audio/ogg" });
      }
    });
  }

  function isOgg(b) {
    return b.length > 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53;
  }

  function isWebm(b) {
    return b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  }

  /* ==========================================================================
   * 4. REMUX WebM/Opus -> Ogg/Opus
   * ======================================================================== */

  function readVint(b, p, keepMarker) {
    var first = b[p];
    if (first === undefined) return null;
    var mask = 0x80;
    var len = 1;
    while (len <= 8 && !(first & mask)) {
      mask >>= 1;
      len++;
    }
    if (len > 8) return null;

    var value = keepMarker ? first : first & (mask - 1);
    if (!keepMarker) {
      for (var i = 1; i < len; i++) value = value * 256 + b[p + i];
      if (value === Math.pow(2, 7 * len) - 1) return { value: value, length: len, unknown: true };
    } else {
      for (var j = 1; j < len; j++) value = value * 256 + b[p + j];
    }
    return { value: value, length: len, unknown: false };
  }

  function readUint(b, p, len) {
    var v = 0;
    for (var i = 0; i < len; i++) v = v * 256 + b[p + i];
    return v;
  }

  function findSequence(b, seq, from) {
    var limit = b.length - seq.length;
    for (var i = from; i <= limit; i++) {
      var ok = true;
      for (var j = 0; j < seq.length; j++) {
        if (b[i + j] !== seq[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i << 24;
      for (var j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var crc = 0;
    for (var i = 0; i < bytes.length; i++) {
      crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    }
    return crc >>> 0;
  }

  // Duração (em amostras a 48 kHz) do pacote Opus, lida do TOC byte.
  function opusFrameSamples(toc) {
    var cfg = toc >> 3;
    var frame;
    if (cfg < 12) frame = [480, 960, 1920, 2880][cfg & 3]; // SILK
    else if (cfg < 16) frame = [480, 960][cfg & 1]; // Hybrid
    else frame = [120, 240, 480, 960][cfg & 3]; // CELT
    var code = toc & 3;
    var count = code === 0 ? 1 : 2;
    return frame * count;
  }

  function webmOpusToOgg(bytes) {
    var n = bytes.length;
    var timestampScale = 1000000;
    var opusHead = null;
    var trackNumber = null;
    var packets = [];

    function walk(start, end) {
      var p = start;
      while (p < end) {
        var idV = readVint(bytes, p, true);
        if (!idV) break;
        var sizeV = readVint(bytes, p + idV.length, false);
        if (!sizeV) break;

        var ds = p + idV.length + sizeV.length;

        // Clusters gravados ao vivo usam tamanho desconhecido: vão até o
        // próximo Cluster (ou até o fim).
        if (sizeV.unknown && idV.value === 0x1f43b675) {
          var next = findSequence(bytes, [0x1f, 0x43, 0xb6, 0x75], ds);
          var cEnd = next === -1 ? n : next;
          walkCluster(ds, cEnd);
          p = cEnd;
          if (next === -1) break;
          continue;
        }

        var de = sizeV.unknown ? end : ds + sizeV.value;
        if (de > n) de = n;

        if (idV.value === 0x18538067) walk(ds, de); // Segment
        else if (idV.value === 0x1549a966) walkInfo(ds, de); // Info
        else if (idV.value === 0x1654ae6b) walkTracks(ds, de); // Tracks
        else if (idV.value === 0x1f43b675) walkCluster(ds, de); // Cluster

        if (sizeV.unknown || de <= p) break;
        p = de;
      }
    }

    function walkInfo(start, end) {
      var p = start;
      while (p < end) {
        var idV = readVint(bytes, p, true);
        if (!idV) break;
        var sizeV = readVint(bytes, p + idV.length, false);
        if (!sizeV) break;
        var ds = p + idV.length + sizeV.length;
        var de = ds + sizeV.value;
        if (de > n) de = n;
        if (idV.value === 0x2ad7b1) timestampScale = readUint(bytes, ds, de - ds);
        if (de <= p) break;
        p = de;
      }
    }

    function walkTracks(start, end) {
      var p = start;
      while (p < end) {
        var idV = readVint(bytes, p, true);
        if (!idV) break;
        var sizeV = readVint(bytes, p + idV.length, false);
        if (!sizeV) break;
        var ds = p + idV.length + sizeV.length;
        var de = ds + sizeV.value;
        if (de > n) de = n;

        if (idV.value === 0xae) {
          // TrackEntry
          var q = ds;
          while (q < de) {
            var eid = readVint(bytes, q, true);
            if (!eid) break;
            var esz = readVint(bytes, q + eid.length, false);
            if (!esz) break;
            var eds = q + eid.length + esz.length;
            var ede = eds + esz.value;
            if (ede > n) ede = n;
            if (eid.value === 0xd7) trackNumber = readUint(bytes, eds, ede - eds);
            else if (eid.value === 0x63a2) opusHead = bytes.slice(eds, ede);
            if (ede <= q) break;
            q = ede;
          }
        }

        if (de <= p) break;
        p = de;
      }
    }

    function walkCluster(start, end) {
      var p = start;
      var clusterTs = 0;
      while (p < end) {
        var idV = readVint(bytes, p, true);
        if (!idV) break;
        var sizeV = readVint(bytes, p + idV.length, false);
        if (!sizeV) break;
        var ds = p + idV.length + sizeV.length;
        var de = ds + sizeV.value;
        if (de > n) de = n;

        if (idV.value === 0xe7) {
          clusterTs = readUint(bytes, ds, de - ds);
        } else if (idV.value === 0xa3) {
          readBlock(ds, de, clusterTs);
        } else if (idV.value === 0xa0) {
          var q = ds;
          while (q < de) {
            var bid = readVint(bytes, q, true);
            if (!bid) break;
            var bsz = readVint(bytes, q + bid.length, false);
            if (!bsz) break;
            var bds = q + bid.length + bsz.length;
            var bde = bds + bsz.value;
            if (bde > n) bde = n;
            if (bid.value === 0xa1) readBlock(bds, bde, clusterTs);
            if (bde <= q) break;
            q = bde;
          }
        }

        if (de <= p) break;
        p = de;
      }
    }

    function readBlock(start, end, clusterTs) {
      var tnV = readVint(bytes, start, false);
      if (!tnV) return;
      if (trackNumber !== null && tnV.value !== trackNumber) return;

      var q = start + tnV.length;
      var relTs = (bytes[q] << 8) | bytes[q + 1];
      if (relTs & 0x8000) relTs -= 0x10000;
      q += 2;

      var flags = bytes[q];
      q += 1;

      var lacing = (flags >> 1) & 3;
      var absTs = ((clusterTs + relTs) * timestampScale) / 1e6;

      if (lacing === 0) {
        packets.push({ data: bytes.slice(q, end), ts: absTs });
        return;
      }

      var frameCount = bytes[q] + 1;
      q += 1;
      var sizes = [];
      var total = 0;

      if (lacing === 2) {
        var each = Math.floor((end - q) / frameCount);
        for (var f = 0; f < frameCount; f++) sizes.push(each);
      } else {
        for (var k = 0; k < frameCount - 1; k++) {
          var s = 0;
          if (lacing === 1) {
            while (bytes[q] === 255) {
              s += 255;
              q++;
            }
            s += bytes[q];
            q++;
          } else {
            var v = readVint(bytes, q, false);
            if (!v) break;
            s = v.value;
            q += v.length;
          }
          sizes.push(s);
          total += s;
        }
        var last = end - q - total;
        if (last >= 0) sizes.push(last);
      }

      var pos = q;
      for (var m = 0; m < sizes.length; m++) {
        packets.push({ data: bytes.slice(pos, pos + sizes[m]), ts: absTs });
        pos += sizes[m];
      }
    }

    walk(0, n);

    if (!opusHead || !packets.length) throw new Error("track opus ou pacotes não encontrados");
    return buildOgg(opusHead, packets);
  }

  function buildOgg(srcHead, packets) {
    var channels = srcHead.length > 9 ? srcHead[9] : 1;
    var preSkip = srcHead.length > 11 ? srcHead[10] | (srcHead[11] << 8) : 312;

    var head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // OpusHead
    head[8] = 1;
    head[9] = channels;
    head[10] = preSkip & 0xff;
    head[11] = (preSkip >> 8) & 0xff;
    head[12] = 0x80; // 48000 Hz, little endian
    head[13] = 0xbb;
    head[14] = 0x00;
    head[15] = 0x00;
    head[18] = 0; // mapping family 0

    var vendor = "lz-local";
    var tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // OpusTags
    var tp = 8;
    tags[tp++] = vendor.length & 0xff;
    tags[tp++] = 0;
    tags[tp++] = 0;
    tags[tp++] = 0;
    for (var v = 0; v < vendor.length; v++) tags[tp++] = vendor.charCodeAt(v);
    tags[tp++] = 0;
    tags[tp++] = 0;
    tags[tp++] = 0;
    tags[tp++] = 0;

    var serial = (Math.random() * 0xffffffff) >>> 0;
    var seq = 0;
    var chunks = [];

    function makePage(list, granule, headerType) {
      var segs = [];
      var payloadSize = 0;
      for (var i = 0; i < list.length; i++) {
        var len = list[i].length;
        var segCount = Math.floor(len / 255) + 1;
        for (var s = 0; s < segCount - 1; s++) segs.push(255);
        segs.push(len % 255);
        payloadSize += len;
      }
      if (segs.length > 255) return null;

      var out = new Uint8Array(27 + segs.length + payloadSize);
      out.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
      out[4] = 0;
      out[5] = headerType;

      var g = granule;
      for (var b = 6; b < 14; b++) {
        out[b] = g % 256;
        g = Math.floor(g / 256);
      }

      out[14] = serial & 0xff;
      out[15] = (serial >> 8) & 0xff;
      out[16] = (serial >> 16) & 0xff;
      out[17] = (serial >> 24) & 0xff;
      out[18] = seq & 0xff;
      out[19] = (seq >> 8) & 0xff;
      out[20] = (seq >> 16) & 0xff;
      out[21] = (seq >> 24) & 0xff;
      out[26] = segs.length;

      for (var k = 0; k < segs.length; k++) out[27 + k] = segs[k];

      var off = 27 + segs.length;
      for (var p2 = 0; p2 < list.length; p2++) {
        out.set(list[p2], off);
        off += list[p2].length;
      }

      var crc = crc32(out);
      out[22] = crc & 0xff;
      out[23] = (crc >> 8) & 0xff;
      out[24] = (crc >> 16) & 0xff;
      out[25] = (crc >>> 24) & 0xff;

      seq++;
      return out;
    }

    var h = makePage([head], 0, 0x02);
    if (h) chunks.push(h);
    var t = makePage([tags], 0, 0x00);
    if (t) chunks.push(t);

    var granule = preSkip;
    var buffer = [];

    for (var i = 0; i < packets.length; i++) {
      var pk = packets[i];
      buffer.push(pk.data);
      granule += opusFrameSamples(pk.data[0]);

      var isLast = i === packets.length - 1;
      if (buffer.length >= 50 || isLast) {
        var pg = makePage(buffer, granule, isLast ? 0x04 : 0x00);
        if (pg) chunks.push(pg);
        buffer = [];
      }
    }

    var totalLen = 0;
    for (var c = 0; c < chunks.length; c++) totalLen += chunks[c].length;
    var outBuf = new Uint8Array(totalLen);
    var o = 0;
    for (var d = 0; d < chunks.length; d++) {
      outBuf.set(chunks[d], o);
      o += chunks[d].length;
    }
    return outBuf;
  }

  /* ==========================================================================
   * 5. fetch
   * ======================================================================== */

  var realFetch = G.fetch;

  // Referência ao fetch original, ANTES de qualquer shim. Usada pelos testes
  // para provar que o bloqueio do manifest (declarativeNetRequest) age na
  // camada de rede, e não só no JS.
  if (typeof realFetch === "function") G.__LZ_REAL_FETCH__ = realFetch;

  if (typeof realFetch === "function") {
    G.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();

      if (!isLeadzyUrl(url)) return realFetch.apply(this, arguments);

      var res = routeMock(url, method, init && init.body);
      if (!res) return realFetch.apply(this, arguments);

      var p = res.blobPromise || Promise.resolve(new Blob([res.body || ""], { type: res.contentType }));

      return p.then(function (blob) {
        return new Response(blob, {
          status: res.status,
          statusText: res.status === 200 ? "OK" : "Error",
          headers: { "Content-Type": res.contentType },
        });
      });
    };
  }

  /* ==========================================================================
   * 6. XMLHttpRequest (o axios usa XHR no navegador)
   * ======================================================================== */

  var RealXHR = G.XMLHttpRequest;

  if (typeof RealXHR === "function") {
    function LzXHR() {
      this._real = null;
      this._mock = false;
      this._url = null;
      this._method = "GET";
      this._headers = {};
      this._listeners = {};
      this._respHeaders = {};
      this._aborted = false;

      this.readyState = 0;
      this.status = 0;
      this.statusText = "";
      this.response = null;
      this.responseText = "";
      this.responseType = "";
      this.responseURL = "";
      this.timeout = 0;
      this.withCredentials = false;
      this.upload = { addEventListener: function () {}, removeEventListener: function () {} };

      return new Proxy(this, {
        get: function (t, p) {
          var fromReal = t._real ? t._real[p] : undefined;
          if (fromReal !== undefined) {
            return typeof fromReal === "function" ? fromReal.bind(t._real) : fromReal;
          }
          var own = t[p];
          return typeof own === "function" ? own.bind(t) : own;
        },
        set: function (t, p, v) {
          if (t._real) {
            t._real[p] = v;
            return true;
          }
          t[p] = v;
          return true;
        },
      });
    }

    LzXHR.prototype.open = function (method, url) {
      this._method = (method || "GET").toUpperCase();
      this._url = url;

      if (isLeadzyUrl(url)) {
        this._mock = true;
        this.readyState = 1;
        this._emit("readystatechange");
        return;
      }

      this._mock = false;
      this._real = new RealXHR();
      this._real.open.apply(this._real, arguments);
      var self = this;
      this._real.onreadystatechange = function () {
        self.readyState = self._real.readyState;
        self._emit("readystatechange");
      };
    };

    LzXHR.prototype.setRequestHeader = function (k, v) {
      if (this._real) return this._real.setRequestHeader(k, v);
      this._headers[String(k).toLowerCase()] = v;
    };

    LzXHR.prototype.getAllResponseHeaders = function () {
      if (this._real) return this._real.getAllResponseHeaders();
      var out = "";
      for (var k in this._respHeaders) out += k + ": " + this._respHeaders[k] + "\r\n";
      return out;
    };

    LzXHR.prototype.getResponseHeader = function (name) {
      if (this._real) return this._real.getResponseHeader(name);
      var v = this._respHeaders[String(name).toLowerCase()];
      return v === undefined ? null : v;
    };

    LzXHR.prototype.abort = function () {
      this._aborted = true;
      if (this._real) this._real.abort();
      else this._emit("abort");
    };

    LzXHR.prototype.addEventListener = function (type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    };

    LzXHR.prototype.removeEventListener = function (type, fn) {
      var l = this._listeners[type] || [];
      var i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    };

    LzXHR.prototype._emit = function (type) {
      var ev = { type: type, target: this };
      var h = this["on" + type];
      if (typeof h === "function") h.call(this, ev);
      var l = this._listeners[type] || [];
      for (var i = 0; i < l.length; i++) l[i].call(this, ev);
    };

    LzXHR.prototype.send = function (body) {
      if (!this._mock) return this._real.send(body);

      var self = this;
      var res = routeMock(this._url, this._method, body);

      if (!res) {
        // rota desconhecida: passa para o XHR real
        this._mock = false;
        this._real = new RealXHR();
        this._real.open(this._method, this._url, true);
        for (var h in this._headers) this._real.setRequestHeader(h, this._headers[h]);
        return this._real.send(body);
      }

      function finish(blob, text) {
        if (self._aborted) return;

        self.status = res.status;
        self.statusText = res.status === 200 ? "OK" : "Error";
        self.responseURL = self._url;
        self._respHeaders = {
          "content-type": res.contentType,
          "content-length": String(blob.size),
        };

        var type = self.responseType;
        if (type === "blob") {
          self.response = blob.slice(0, blob.size, res.contentType);
          self.responseText = "";
        } else if (type === "arraybuffer") {
          self.response = null;
          self.responseText = "";
        } else if (type === "json") {
          try {
            self.response = JSON.parse(text);
          } catch (e) {
            self.response = null;
          }
          self.responseText = "";
        } else {
          self.responseText = text;
          self.response = text;
        }

        self.readyState = 4;
        self._emit("readystatechange");
        self._emit("load");
        self._emit("loadend");
      }

      var blobP = res.blobPromise || Promise.resolve(new Blob([res.body || ""], { type: res.contentType }));

      blobP
        .then(function (blob) {
          if (self.responseType === "arraybuffer") {
            return blob.arrayBuffer().then(function (ab) {
              if (self._aborted) return;
              self.status = res.status;
              self.statusText = "OK";
              self.responseURL = self._url;
              self._respHeaders = { "content-type": res.contentType };
              self.response = ab;
              self.responseText = "";
              self.readyState = 4;
              self._emit("readystatechange");
              self._emit("load");
              self._emit("loadend");
            });
          }
          return blob.text().then(function (text) {
            finish(blob, text);
          });
        })
        .catch(function (e) {
          self.status = 500;
          self.readyState = 4;
          self.responseText = String((e && e.message) || e);
          self._emit("readystatechange");
          self._emit("error");
          self._emit("loadend");
        });
    };

    G.XMLHttpRequest = LzXHR;
  }


  /* ==========================================================================
   * 7. NAVEGAÇÃO PARA FORA
   * --------------------------------------------------------------------------
   * Três camadas, da mais forte para a mais amigável:
   *
   *   A. declarativeNetRequest (rules/bloqueio-externo.json, no manifest)
   *      Bloqueia QUALQUER requisição para *.leadzy.com.br, de qualquer
   *      contexto: link, <img>, iframe, formulário, fetch do service worker.
   *      Não dá para burlar por JS, porque age no nível da rede do Chrome.
   *      É a única camada que pega location.assign/replace/href, que são
   *      propriedades unforgeable e NÃO podem ser sobrescritas.
   *
   *   B. Guarda de clique em <a> (aqui)
   *      Impede a navegação e mostra o aviso, em vez da tela de erro do Chrome.
   *
   *   C. Remoção dos links de suporte (aqui)
   *      "Falar com o suporte" e "www.leadzy.com.br" não têm equivalente local:
   *      são removidos do DOM em vez de ficarem como botão morto.
   *
   * O que é FUNÇÃO do produto continua liberado: web.whatsapp.com e
   * api.whatsapp.com/send para o telefone de um contato (abrir conversa).
   * ======================================================================== */

  // Telefone do suporte da Leadzy (constante SUPPORT_WHATSAPP do bundle).
  // Links de WhatsApp para este número são suporte, não função -> removidos.
  var SUPORTE_WHATSAPP = ["5511971907976"];

  // Só estes hosts podem ser abertos a partir da extensão.
  var HOSTS_PERMITIDOS = ["web.whatsapp.com", "api.whatsapp.com"];

  function resolverUrl(valor) {
    if (valor === null || valor === undefined || valor === "") return "";
    var bruto = String(valor).trim();
    if (!bruto) return "";
    if (bruto.charAt(0) === "#") return "";
    try {
      return new URL(bruto, L.href).href;
    } catch (e) {
      return bruto;
    }
  }

  /**
   * Allowlist. Qualquer coisa que não esteja aqui é bloqueada.
   * Antes era o contrário (bloqueava só *.leadzy.com.br), o que deixava
   * qualquer outro domínio passar.
   */
  function urlPermitida(valor) {
    var url = resolverUrl(valor);
    if (!url) return true;

    var baixo = url.toLowerCase();

    // esquemas internos: nunca saem do navegador
    if (/^(chrome-extension|chrome|about|data|blob|javascript|mailto|tel):/.test(baixo)) {
      return true;
    }
    if (baixo.indexOf("devtools:") === 0) return true;

    var host, caminho;
    try {
      var p = new URL(url);
      host = p.hostname.toLowerCase();
      caminho = p.pathname;
    } catch (e) {
      return false;
    }

    if (HOSTS_PERMITIDOS.indexOf(host) === -1) return false;

    // web.whatsapp.com -> o produto em si
    if (host === "web.whatsapp.com") return true;

    // api.whatsapp.com -> só o /send (abrir conversa com um contato)
    if (host === "api.whatsapp.com") {
      if (caminho.indexOf("/send") !== 0) return false;
      var tel = url.match(/[?&]phone=(\d+)/);
      if (tel && SUPORTE_WHATSAPP.indexOf(tel[1]) !== -1) return false; // suporte
      return true;
    }

    return false;
  }

  function deveBloquear(valor) {
    if (CONFIG.offlineLinks === "allow") return false;
    return !urlPermitida(valor);
  }

  var avisoVisivel = false;

  function mostrarAviso(texto) {
    if (typeof document === "undefined" || !document.body) return;
    if (avisoVisivel) return;
    avisoVisivel = true;

    var el = document.createElement("div");
    el.setAttribute("data-lz-aviso", "1");
    el.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:24px",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "max-width:min(420px,90vw)",
      "padding:12px 16px",
      "border-radius:10px",
      "background:#1f2937",
      "color:#fff",
      "font:500 13px/1.45 Inter,system-ui,sans-serif",
      "box-shadow:0 8px 24px rgba(0,0,0,.28)",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity .18s ease",
    ].join(";");
    el.textContent = texto;

    document.body.appendChild(el);
    requestAnimationFrame(function () {
      el.style.opacity = "1";
    });
    setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () {
        el.remove();
        avisoVisivel = false;
      }, 220);
    }, 4200);
  }

  // Nome antigo mantido: o resto do arquivo e os testes usam esta função.
  function bloquearNavegacaoExterna(url) {
    if (CONFIG.offlineLinks === "allow") return false;
    if (!deveBloquear(url)) return false;
    log("navegação externa bloqueada:", url);
    mostrarAviso(AVISO);
    return true;
  }

  /* --- A. window.open (ainda útil: cobre antes do DNR) -------------------- */
  var realOpen = G.open;
  if (typeof realOpen === "function") {
    G.open = function (url) {
      if (url && bloquearNavegacaoExterna(String(url))) return null;
      return realOpen.apply(G, arguments);
    };
  }

  /* --- B. chrome.tabs.create / update ------------------------------------ */
  if (typeof chrome !== "undefined" && chrome.tabs) {
    var realCreate = chrome.tabs.create;
    if (typeof realCreate === "function") {
      chrome.tabs.create = function (props, cb) {
        if (props && props.url && bloquearNavegacaoExterna(String(props.url))) {
          if (cb) cb({});
          return;
        }
        return realCreate.call(chrome.tabs, props, cb);
      };
    }

    var realUpdate = chrome.tabs.update;
    if (typeof realUpdate === "function") {
      chrome.tabs.update = function (id, props, cb) {
        if (props && props.url && bloquearNavegacaoExterna(String(props.url))) {
          if (cb) cb({});
          return;
        }
        return realUpdate.call(chrome.tabs, id, props, cb);
      };
    }
  }

  /* --- C. clique em <a href> (o furo que faltava) ------------------------- */
  function instalarGuardaDeLinks() {
    if (typeof document === "undefined" || !document.addEventListener) return;

    function aoClicar(ev) {
      if (!ev || ev.__lzVisto) return;
      var alvo = ev.target;
      var a = alvo && alvo.closest ? alvo.closest("a[href]") : null;
      if (!a) return;

      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#") return;

      var url = resolverUrl(href);
      if (!deveBloquear(url)) return;

      ev.__lzVisto = true;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      log("link externo bloqueado:", url);
      mostrarAviso(AVISO);
    }

    // capture: roda antes de qualquer handler do Vue
    document.addEventListener("click", aoClicar, true);
    document.addEventListener("auxclick", aoClicar, true); // botão do meio

    // formulário com action externo
    document.addEventListener(
      "submit",
      function (ev) {
        var f = ev.target;
        if (!f || !f.getAttribute) return;
        var acao = f.getAttribute("action");
        if (!acao || !deveBloquear(acao)) return;
        ev.preventDefault();
        ev.stopPropagation();
        log("formulário externo bloqueado:", acao);
        mostrarAviso(AVISO);
      },
      true
    );

    G.__LZ_CLICK_GUARD__ = true;
  }

  /* --- D. remoção dos links de suporte ----------------------------------- */
  // Não têm versão local e não são função: saem do DOM.
  var SELETOR_SUPORTE = [
    'a[href*="leadzy.com.br"]',
    'a[href*="leadzy.com"]',
    'a[href*="api.whatsapp.com/send"][href*="' + SUPORTE_WHATSAPP[0] + '"]',
  ].join(",");

  function removerLinksDeSuporte() {
    if (typeof document === "undefined" || !document.querySelectorAll) return 0;
    var lista = document.querySelectorAll(SELETOR_SUPORTE);
    var n = 0;
    for (var i = 0; i < lista.length; i++) {
      var a = lista[i];
      if (!a.parentNode) continue;
      a.parentNode.removeChild(a);
      n++;
    }
    if (n) log("links de suporte removidos:", n);
    return n;
  }

  function observarLinksDeSuporte() {
    removerLinksDeSuporte();
    if (typeof document === "undefined" || !document.documentElement) return;
    if (typeof MutationObserver === "undefined") return;

    var pendente = false;
    var agendar =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : function (f) {
            return setTimeout(f, 16);
          };

    var obs = new MutationObserver(function (registros) {
      // ignora mutações que só removem (as nossas)
      for (var i = 0; i < registros.length; i++) {
        if (registros[i].addedNodes && registros[i].addedNodes.length) {
          pendente = true;
          break;
        }
      }
      if (!pendente) return;
      pendente = false;
      agendar(function () {
        removerLinksDeSuporte();
      });
    });

    obs.observe(document.documentElement, { childList: true, subtree: true });
    G.__LZ_SUPORTE_OBSERVER__ = obs;
  }

  instalarGuardaDeLinks();
  observarLinksDeSuporte();

  /* ==========================================================================
   * 8. IMAGENS DE SERVIDOR EXTERNO
   * --------------------------------------------------------------------------
   * O carrossel de novidades aponta <img src="https://bucket.leadzy.com.br/...">.
   * Trocamos por um placeholder local transparente antes de o navegador pedir.
   * ======================================================================== */

  var PLACEHOLDER =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
        '<rect width="100%" height="100%" fill="#f1f5f9"/>' +
        '<text x="50%" y="50%" fill="#94a3b8" font-family="Inter,sans-serif" ' +
        'font-size="13" text-anchor="middle" dominant-baseline="middle">imagem do servidor</text>' +
        "</svg>"
    );

  function instalarGuardaDeImagem() {
    if (typeof HTMLImageElement === "undefined") return;
    var proto = HTMLImageElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "src");
    if (!desc || !desc.set) return;

    Object.defineProperty(proto, "src", {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        return desc.get.call(this);
      },
      set: function (valor) {
        if (isLeadzyUrl(String(valor))) {
          log("imagem externa trocada por placeholder:", valor);
          desc.set.call(this, PLACEHOLDER);
          return;
        }
        desc.set.call(this, valor);
      },
    });

    // também cobre srcset
    var descSet = Object.getOwnPropertyDescriptor(proto, "srcset");
    if (descSet && descSet.set) {
      Object.defineProperty(proto, "srcset", {
        configurable: true,
        enumerable: descSet.enumerable,
        get: function () {
          return descSet.get.call(this);
        },
        set: function (valor) {
          if (isLeadzyUrl(String(valor))) return;
          descSet.set.call(this, valor);
        },
      });
    }
  }

  instalarGuardaDeImagem();


  /* ==========================================================================
   * 9. ENTRADA PARA O DISPARO EM MASSA
   * --------------------------------------------------------------------------
   * campaigns.html é uma página nova da extensão. O menu original é do bundle
   * e não pode ser editado, então acrescentamos um item clonando o estilo de
   * um item existente. Se o Vue re-renderizar a barra, repomos o item.
   * ======================================================================== */

  function abrirDisparo() {
    var url = "campaigns.html";
    try {
      url = chrome.runtime.getURL("campaigns.html");
    } catch (e) {}
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: url });
      return;
    }
    if (typeof G.open === "function") {
      var real = realOpen || G.open;
      real.call(G, url, "_blank");
    }
  }

  function instalarMenuDisparo() {
    if (!IS_EXTENSION_PAGE) return false;
    if (!/options\.html$/.test(L.pathname)) return false;
    if (typeof document === "undefined") return false;

    var nav = document.querySelector("nav.lz-nav-tabs");
    if (!nav) return false;
    if (nav.querySelector("[data-lz-disparo]")) return true;

    var modelo = nav.querySelector("button.lz-nav-tab-btn");
    if (!modelo) return false;

    var span = document.createElement("span");
    span.setAttribute("data-lz-disparo", "1");
    span.className = (modelo.parentElement && modelo.parentElement.className) ||
      "relative z-[1] shrink-0";

    var btn = modelo.cloneNode(false);
    btn.textContent = "Disparo em massa";
    btn.removeAttribute("data-tour");
    btn.setAttribute("type", "button");
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      abrirDisparo();
    });

    span.appendChild(btn);
    nav.appendChild(span);
    return true;
  }

  function observarMenuDisparo() {
    if (!IS_EXTENSION_PAGE || !/options\.html$/.test(L.pathname)) return;
    if (typeof document === "undefined" || !document.documentElement) return;
    if (typeof MutationObserver === "undefined") return;

    var tentativas = 0;
    var timer = setInterval(function () {
      tentativas++;
      if (instalarMenuDisparo() || tentativas > 40) clearInterval(timer);
    }, 250);

    var obs = new MutationObserver(function () {
      instalarMenuDisparo();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    G.__LZ_MENU_DISPARO__ = obs;
  }

  observarMenuDisparo();

  log("camada local ativa");


  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      webmOpusToOgg: webmOpusToOgg,
      crc32: crc32,
      toOgg: toOgg,
      routeMock: routeMock,
      registrarRota: registrarRota,
      isLeadzyUrl: isLeadzyUrl,
      bloquearNavegacaoExterna: bloquearNavegacaoExterna,
      urlPermitida: urlPermitida,
      deveBloquear: deveBloquear,
      resolverUrl: resolverUrl,
      removerLinksDeSuporte: removerLinksDeSuporte,
      SUPORTE_WHATSAPP: SUPORTE_WHATSAPP,
      HOSTS_PERMITIDOS: HOSTS_PERMITIDOS,
      PLACEHOLDER: PLACEHOLDER,
      CONFIG: CONFIG,
    };
  }
})();
