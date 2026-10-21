/* ============================================================================
 * Motor de disparo em massa — lógica pura
 * ----------------------------------------------------------------------------
 * Não toca no DOM nem no WhatsApp. Tudo aqui é determinístico e testável:
 * entram dados, saem decisões. Quem executa é a UI (campaigns-ui.js), que fala
 * com o barramento do wapi dentro da aba do WhatsApp Web.
 *
 * Roda no navegador e no Node (para os testes).
 * ========================================================================== */

(function (raiz, fabrica) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = fabrica();
  } else {
    raiz.LZCampanha = fabrica();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ==========================================================================
   * 1. NÚMEROS
   * ======================================================================== */

  // DDDs válidos no Brasil (Anatel). 20-28, 31-35, 37-38, 41-49,
  // 51-55, 61-69, 71-79, 81-89, 91-99.
  function dddValido(ddd) {
    var n = parseInt(ddd, 10);
    if (isNaN(n) || n < 11) return false;
    if (n >= 11 && n <= 19) return true;
    // Sudeste: 21,22,24,27,28 (23,25,26 não existem)
    if (n === 21 || n === 22 || n === 24 || n === 27 || n === 28) return true;
    if (n >= 31 && n <= 35) return true;
    if (n === 37 || n === 38) return true;
    if (n >= 41 && n <= 49) return true;
    if (n >= 51 && n <= 55) return true;
    if (n >= 61 && n <= 69) return true;
    if (n >= 71 && n <= 79) return true;
    if (n >= 81 && n <= 89) return true;
    if (n >= 91 && n <= 99) return true;
    return false;
  }

  /**
   * Normaliza um telefone para o formato que o WhatsApp usa (só dígitos,
   * com DDI 55 na frente). Devolve { ok, e164, motivo }.
   */
  function normalizarNumero(bruto) {
    if (bruto === null || bruto === undefined) return { ok: false, motivo: "vazio" };
    var texto = String(bruto).trim();
    if (!texto) return { ok: false, motivo: "vazio" };

    // tira tudo o que não é dígito (parênteses, hífen, +, espaço)
    var d = texto.replace(/\D/g, "");
    if (!d) return { ok: false, motivo: "sem dígitos" };

    // remove zeros à esquerda (tronco/operadora)
    d = d.replace(/^0+/, "");
    if (!d) return { ok: false, motivo: "só zeros" };

    // já vem com DDI 55
    if (d.length >= 12 && d.indexOf("55") === 0) {
      var resto = d.slice(2);
      if (resto.length < 10 || resto.length > 11) {
        return { ok: false, motivo: "tamanho inválido após DDI" };
      }
      if (!dddValido(resto.slice(0, 2))) return { ok: false, motivo: "DDD inválido" };
      // mesma regra do caminho sem DDI: celular de 11 dígitos começa com 9.
      // Sem esta checagem, "5511234567890" era aceito e "11234567890" não.
      if (resto.length === 11 && resto.charAt(2) !== "9") {
        return { ok: false, motivo: "celular deve começar com 9" };
      }
      return { ok: true, e164: d };
    }

    // sem DDI: DDD(2) + 8 ou 9 dígitos
    if (d.length === 10 || d.length === 11) {
      if (!dddValido(d.slice(0, 2))) return { ok: false, motivo: "DDD inválido" };
      if (d.length === 11 && d.charAt(2) !== "9") {
        return { ok: false, motivo: "celular deve começar com 9" };
      }
      return { ok: true, e164: "55" + d };
    }

    if (d.length < 10) return { ok: false, motivo: "curto demais" };
    return { ok: false, motivo: "formato não reconhecido" };
  }

  // Quebra de registros: quebra de linha, vírgula, ponto e vírgula ou pipe.
  var SEPARADORES = /[\r\n,;|]+/;

  /**
   * Lê uma lista colada pelo usuário.
   *
   * Aceita um por linha, ou separados por vírgula/ponto-e-vírgula/pipe.
   * Dentro de um mesmo pedaço, se houver mais de um número separado por
   * espaço ("11 99999-8888 21 98888-7777"), tenta cada parte.
   * Duplicados são descartados mantendo o primeiro.
   */
  function lerLista(texto) {
    var validos = [];
    var invalidos = [];
    var vistos = Object.create(null);
    var duplicados = 0;

    if (!texto || !String(texto).trim()) {
      return { validos: validos, invalidos: invalidos, duplicados: 0, total: 0 };
    }

    function registrar(entrada) {
      var r = normalizarNumero(entrada);
      if (!r.ok) {
        invalidos.push({ entrada: entrada, motivo: r.motivo });
        return;
      }
      if (vistos[r.e164]) {
        duplicados++;
        return;
      }
      vistos[r.e164] = true;
      validos.push({ bruto: String(entrada).trim(), numero: r.e164 });
    }

    // Extrai candidatos a telefone de um texto solto, aceitando qualquer
    // combinação de parênteses, espaços, hífens e pontos entre os grupos.
    var CANDIDATO = /(?:\+?55[\s._-]*)?\(?\d{2}\)?[\s._-]*\d{4,5}[\s._-]*\d{4}/g;

    var pedacos = String(texto).split(SEPARADORES);

    for (var i = 0; i < pedacos.length; i++) {
      var pedaco = pedacos[i].trim();
      if (!pedaco) continue;

      CANDIDATO.lastIndex = 0;
      var achados = pedaco.match(CANDIDATO);

      if (!achados || !achados.length) {
        registrar(pedaco);
        continue;
      }

      // o que sobra fora dos candidatos não pode conter dígitos
      var sobra = pedaco.replace(CANDIDATO, " ").replace(/[\s.,;:()+-]/g, "");
      if (/\d/.test(sobra)) registrar(sobra);

      for (var j = 0; j < achados.length; j++) registrar(achados[j]);
    }

    return {
      validos: validos,
      invalidos: invalidos,
      duplicados: duplicados,
      total: validos.length + invalidos.length + duplicados,
    };
  }

  /**
   * Formas válidas do MESMO número, na ordem em que devem ser tentadas.
   *
   * Celular brasileiro circula em duas formas depois do DDD:
   *
   *   com o nono dígito  55 86 98163-8438  (padrão desde 2012)
   *   sem o nono dígito  55 86  8163-8438  (registros anteriores)
   *
   * A primeira tentativa é sempre a forma COM o 9. Se o WhatsApp recusar o
   * número, o envio tenta a forma SEM o 9 antes de marcar falha — o número é
   * o mesmo, só a grafia que o servidor conhece muda.
   *
   * Fixo (assinante começando em 2–5) e número de outro país têm uma forma só.
   */
  function variantesNumero(e164) {
    var d = String(e164 == null ? "" : e164).replace(/\D/g, "");
    if (!/^55\d{10,11}$/.test(d)) return [d];

    var ddd = d.slice(2, 4);
    var assinante = d.slice(4);

    // já veio com o 9: tenta com 9, depois sem
    if (assinante.length === 9 && assinante.charAt(0) === "9") {
      return ["55" + ddd + assinante, "55" + ddd + assinante.slice(1)];
    }

    // veio sem o 9, mas é celular (assinante antigo começa em 6–9):
    // tenta primeiro a forma moderna, com o 9
    if (assinante.length === 8 && /^[6-9]/.test(assinante)) {
      return ["55" + ddd + "9" + assinante, "55" + ddd + assinante];
    }

    return [d];
  }

  /** Converte para o chatId que o wapi espera. */
  function paraChatId(e164) {
    return String(e164).replace(/\D/g, "") + "@c.us";
  }

  /* ==========================================================================
   * 2. TEXTO — fixo, spintax e rotação
   * ======================================================================== */

  /**
   * Resolve spintax: {a|b|c} escolhe uma opção.
   * Suporta aninhamento. Ignora chaves desbalanceadas.
   */
  function resolverSpintax(texto, rng) {
    var r = rng || Math.random;
    var s = String(texto == null ? "" : texto);
    var limite = 50; // proteção contra loop

    while (s.indexOf("{") !== -1 && limite-- > 0) {
      // acha o bloco mais interno (sem chaves dentro)
      var abre = -1;
      var achou = false;

      for (var i = 0; i < s.length; i++) {
        if (s[i] === "{") {
          abre = i;
        } else if (s[i] === "}" && abre !== -1) {
          var corpo = s.slice(abre + 1, i);
          if (corpo.indexOf("{") !== -1) continue; // não é o interno
          var opcoes = corpo.split("|");
          var escolha = opcoes[Math.floor(r() * opcoes.length) % opcoes.length];
          s = s.slice(0, abre) + escolha + s.slice(i + 1);
          achou = true;
          break;
        }
      }
      if (!achou) break;
    }
    return s;
  }

  /**
   * Conta quantas variações o spintax gera (para mostrar na UI).
   * Grupos no mesmo nível multiplicam; ramificações de um grupo somam.
   */
  function contarSpintax(texto) {
    var s = String(texto == null ? "" : texto);

    function contarTrecho(str, ini, fim) {
      var total = 1;
      var i = ini;
      while (i < fim) {
        if (str[i] === "{") {
          // acha o fechamento correspondente
          var nivel = 1;
          var j = i + 1;
          while (j < fim && nivel > 0) {
            if (str[j] === "{") nivel++;
            else if (str[j] === "}") nivel--;
            j++;
          }
          if (nivel !== 0) {
            i++;
            continue; // chave sem par: ignora
          }
          // quebra as ramificações no nível de cima
          var soma = 0;
          var inicioRamo = i + 1;
          var nivel2 = 0;
          for (var k = i + 1; k < j - 1; k++) {
            if (str[k] === "{") nivel2++;
            else if (str[k] === "}") nivel2--;
            else if (str[k] === "|" && nivel2 === 0) {
              soma += contarTrecho(str, inicioRamo, k);
              inicioRamo = k + 1;
            }
          }
          soma += contarTrecho(str, inicioRamo, j - 1);
          total *= soma;
          i = j;
        } else {
          i++;
        }
      }
      return total;
    }

    return contarTrecho(s, 0, s.length);
  }

  /** Fisher-Yates com rng injetável (testável). */
  function embaralhar(lista, rng) {
    var r = rng || Math.random;
    var a = lista.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1)) % (i + 1);
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /**
   * Próximo texto da rotação.
   *
   * Antes era `lista[indice % n]` — ciclo perfeito A,B,C,A,B,C, que é
   * justamente o padrão que filtro anti-spam procura. Agora cada volta é
   * embaralhada e nenhuma mensagem se repete em sequência.
   */
  function proximaRotacao(config, rng) {
    var r = rng || Math.random;
    var lista = (config.rotacao || []).filter(function (t) {
      return t && String(t).trim();
    });
    if (!lista.length) return "";

    // Se os textos mudaram, a ordem guardada aponta para posições que não
    // existem mais. Reconstruímos em vez de confiar no índice antigo.
    var assinatura = lista.length + ":" + lista.join("\u0001");
    if (config._assinatura !== assinatura) {
      config._assinatura = assinatura;
      config._ordem = null;
      config._ultimo = null;
    }

    if (!config._ordem || !config._ordem.length) {
      config._ordem = embaralhar(
        lista.map(function (_, i) {
          return i;
        }),
        r
      );
      // não repete a última enviada logo no começo da nova volta
      if (
        config._ultimo !== null &&
        config._ultimo !== undefined &&
        config._ordem.length > 1 &&
        config._ordem[0] === config._ultimo
      ) {
        var t = config._ordem[0];
        config._ordem[0] = config._ordem[1];
        config._ordem[1] = t;
      }
    }

    var idx = config._ordem.shift();
    config._ultimo = idx;
    return lista[idx];
  }

  /**
   * Monta o texto de UM envio.
   * modo: "fixo" usa textoFixo; "spintax" resolve; "rotacao" escolhe da lista.
   */
  function montarTexto(config, indice, rng) {
    var r = rng || Math.random;
    var base = "";

    if (config.modo === "rotacao") {
      base = proximaRotacao(config, r);
      if (!base) return "";
      if (config.spintaxNaRotacao) base = resolverSpintax(base, r);
    } else if (config.modo === "spintax") {
      base = resolverSpintax(config.textoFixo || "", r);
    } else {
      base = config.textoFixo || "";
    }

    return base;
  }

  /* ==========================================================================
   * 3. HOMOGLIFOS
   * --------------------------------------------------------------------------
   * Troca letras latinas por caracteres de outros alfabetos visualmente
   * idênticos (cirílico/grego). Diminui a chance de o texto bater com listas
   * de spam sem mudar o que a pessoa lê.
   * ======================================================================== */

  var HOMOGLIFOS = {
    a: ["\u0430", "\uFF41"], // а cirílico, ａ largura total
    c: ["\u0441"],           // с cirílico
    e: ["\u0435"],           // е cirílico
    o: ["\u043E", "\u03BF"], // о cirílico, ο grego
    p: ["\u0440"],           // р cirílico
    x: ["\u0445"],           // х cirílico
    y: ["\u0443"],           // у cirílico
    i: ["\u0456"],           // і cirílico
    s: ["\u0455"],           // ѕ cirílico
    j: ["\u0458"],           // ј cirílico
    h: ["\u04BB"],           // һ cirílico
    A: ["\u0410"],           // А
    B: ["\u0412"],           // В
    C: ["\u0421"],           // С
    E: ["\u0415"],           // Е
    H: ["\u041D"],           // Н
    K: ["\u041A"],           // К
    M: ["\u041C"],           // М
    O: ["\u041E"],           // О
    P: ["\u0420"],           // Р
    T: ["\u0422"],           // Т
    X: ["\u0425"],           // Х
  };

  // Não mexe dentro de URLs/telefones, para não quebrar links.
  function aplicarHomoglifos(texto, intensidade, rng) {
    var r = rng || Math.random;
    var pct = typeof intensidade === "number" ? Math.max(0, Math.min(100, intensidade)) : 100;
    if (pct === 0) return texto;

    var s = String(texto == null ? "" : texto);
    var saida = "";
    var dentroDeLink = false;

    for (var i = 0; i < s.length; i++) {
      var ch = s[i];

      // marca trechos de URL para não corromper
      if (ch === "h" && s.slice(i, i + 4) === "http") dentroDeLink = true;
      if (/\s/.test(ch)) dentroDeLink = false;

      var alts = HOMOGLIFOS[ch];
      if (!dentroDeLink && alts && r() * 100 < pct) {
        saida += alts[Math.floor(r() * alts.length) % alts.length];
      } else {
        saida += ch;
      }
    }
    return saida;
  }

  /* ==========================================================================
   * 4. CARACTERES INVISÍVEIS
   * --------------------------------------------------------------------------
   * Colados no fim da mensagem. Não aparecem na bolha, mas fazem o texto ser
   * único — mesma leitura, hash diferente.
   * ======================================================================== */

  var INVISIVEIS = [
    "\u200B", // zero width space
    "\u200C", // zero width non-joiner
    "\u200D", // zero width joiner
    "\u2060", // word joiner
    "\uFEFF", // zero width no-break space
    "\u200A", // hair space  <- "espaço que existe mas quase não se vê"
    "\u2009", // thin space
    "\u2063", // invisible separator
  ];

  var INVISIVEIS_SEM_ESPACO = ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u2063"];

  /**
   * Gera a cauda invisível.
   * comEspaco=true usa também hair/thin space (a pessoa sente o espaço ao
   * digitar, mas não vê).
   */
  function gerarCaudaInvisivel(quantidade, comEspaco, rng) {
    var r = rng || Math.random;
    var n = Math.max(0, Math.min(12, parseInt(quantidade, 10) || 0));
    if (!n) return "";

    var pool = comEspaco ? INVISIVEIS : INVISIVEIS_SEM_ESPACO;
    var saida = "";
    for (var i = 0; i < n; i++) {
      saida += pool[Math.floor(r() * pool.length) % pool.length];
    }
    return saida;
  }

  /** Aplica todas as transformações de texto de um envio. */
  function transformarTexto(texto, opcoes, rng) {
    var r = rng || Math.random;
    var o = opcoes || {};
    var s = String(texto == null ? "" : texto);

    if (o.homoglifos) s = aplicarHomoglifos(s, o.homoglifosIntensidade, r);

    if (o.invisiveis) {
      // a cauda vai no fim, depois dos homoglifos (senão some no meio)
      s = s + gerarCaudaInvisivel(o.invisiveisQtd, o.invisiveisComEspaco, r);
    }

    return s;
  }

  /* ==========================================================================
   * 5. RITMO — intervalos e lotes
   * ======================================================================== */

  function inteiroEntre(min, max, rng) {
    var r = rng || Math.random;
    var a = Math.ceil(Math.min(min, max));
    var b = Math.floor(Math.max(min, max));
    if (b <= a) return a;
    return a + Math.floor(r() * (b - a + 1));
  }

  /**
   * Planeja o ritmo de uma campanha com N contatos.
   * Devolve a lista de passos: { tipo: "envio"|"pausa"|"pausa-lote", indice, ... }
   *
   * regras:
   *   intervaloMin/Max      segundos entre mensagens
   *   loteMin/Max           mensagens por lote
   *   pausaLoteMin/Max      minutos entre lotes
   */
  function planejarRitmo(quantidade, ritmo, rng) {
    var r = rng || Math.random;
    var cfg = ritmo || {};
    var passos = [];
    var enviados = 0;
    var restantes = quantidade;

    while (restantes > 0) {
      var tamanhoLote = Math.min(
        restantes,
        inteiroEntre(
          cfg.loteMin != null ? cfg.loteMin : 1,
          cfg.loteMax != null ? cfg.loteMax : 1,
          r
        )
      );

      for (var i = 0; i < tamanhoLote; i++) {
        if (enviados > 0) {
          passos.push({
            tipo: "espera",
            ms:
              inteiroEntre(
                cfg.intervaloMin != null ? cfg.intervaloMin : 0,
                cfg.intervaloMax != null ? cfg.intervaloMax : 0,
                r
              ) * 1000,
          });
        }
        passos.push({ tipo: "envio", indice: enviados });
        enviados++;
      }

      restantes -= tamanhoLote;

      if (restantes > 0) {
        passos.push({
          tipo: "pausa-lote",
          ms:
            Math.round(
              (cfg.pausaLoteMin != null ? cfg.pausaLoteMin : 0) +
                r() *
                  ((cfg.pausaLoteMax != null ? cfg.pausaLoteMax : 0) -
                    (cfg.pausaLoteMin != null ? cfg.pausaLoteMin : 0))
            ) * 60000,
        });
      }
    }

    return passos;
  }

  /** Quanto tempo o plano leva (ms). */
  function duracaoEstimada(passos) {
    return passos.reduce(function (t, p) {
      return t + (p.ms || 0);
    }, 0);
  }

  /* ==========================================================================
   * 6. MÍDIA POR PASTA
   * --------------------------------------------------------------------------
   * Cada pasta é um conjunto de arquivos do mesmo tipo. Por envio, o sistema
   * escolhe UM arquivo de CADA pasta. Duas pastas de áudio -> dois áudios.
   * ======================================================================== */

  /**
   * Escolhe um item de cada pasta.
   * Devolve [{ pastaId, pastaNome, tipo, item }]
   */
  function escolherMidias(pastas, rng) {
    var r = rng || Math.random;
    var escolhas = [];
    var lista = pastas || [];

    for (var i = 0; i < lista.length; i++) {
      var p = lista[i];
      if (!p || !p.itens || !p.itens.length) continue;
      var idx = Math.floor(r() * p.itens.length) % p.itens.length;
      escolhas.push({
        pastaId: p.id,
        pastaNome: p.nome,
        tipo: p.tipo,
        item: p.itens[idx],
      });
    }
    return escolhas;
  }

  /* ==========================================================================
   * 7. CAMPANHA — estado, controles e relatório
   * ======================================================================== */

  var STATUS = {
    RASCUNHO: "rascunho",
    EXECUTANDO: "executando",
    PAUSADA: "pausada",
    FINALIZADA: "finalizada",
    CANCELADA: "cancelada",
  };

  var ITEM = {
    PENDENTE: "pendente",
    ENVIANDO: "enviando",
    ENVIADO: "enviado",
    FALHOU: "falhou",
    PULADO: "pulado",
    // O WhatsApp pode ter recebido a mensagem e a confirmação se perdeu
    // (timeout). Não é falha nem sucesso: reenviar pode duplicar.
    DESCONHECIDO: "desconhecido",
  };

  function hoje() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Identificador curto e estável, usado para achar o contato depois. */
  function novoIdContato() {
    return (
      "k" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function novoId() {
    return "camp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Cria uma campanha. `contatos` é a saída de lerLista().validos.
   */
  function criarCampanha(config) {
    var c = config || {};
    var contatos = (c.contatos || []).map(function (x, i) {
      return {
        indice: i,
        numero: x.numero,
        bruto: x.bruto,
        nome: x.nome || "",
        status: ITEM.PENDENTE,
        tentativas: 0,
        erro: null,
        enviadoEm: null,
      };
    });

    return {
      id: c.id || novoId(),
      nome: c.nome || "Campanha sem nome",
      status: STATUS.RASCUNHO,
      criadaEm: new Date().toISOString(),
      atualizadaEm: new Date().toISOString(),
      texto: c.texto || { modo: "fixo", textoFixo: "", rotacao: [] },
      opcoes: c.opcoes || {
        homoglifos: false,
        homoglifosIntensidade: 100,
        invisiveis: false,
        invisiveisQtd: 4,
        invisiveisComEspaco: true,
      },
      ritmo: c.ritmo || {
        intervaloMin: 20,
        intervaloMax: 45,
        loteMin: 8,
        loteMax: 12,
        pausaLoteMin: 5,
        pausaLoteMax: 10,
      },
      pastas: c.pastas || [],
      // Travas de segurança. 0 = desligado.
      protecoes: c.protecoes || {
        pausarAposFalhas: 5, // pausa sozinho se N envios seguidos falharem
        limiteDiario: 0, // máximo de mensagens por dia
      },
      estatisticas: c.estatisticas || {
        dia: hoje(),
        enviadosHoje: 0,
        falhasConsecutivas: 0,
      },
      contatos: contatos,
      cursor: 0,
      iniciadaEm: null,
      finalizadaEm: null,
    };
  }

  function contarPorStatus(campanha) {
    var m = {
      pendente: 0,
      enviando: 0,
      enviado: 0,
      falhou: 0,
      pulado: 0,
      desconhecido: 0,
      total: campanha.contatos.length,
    };
    campanha.contatos.forEach(function (c) {
      m[c.status] = (m[c.status] || 0) + 1;
    });
    return m;
  }

  function progresso(campanha) {
    var m = contarPorStatus(campanha);
    // "desconhecido" conta como processado: não volta para a fila sozinho
    var processados = m.enviado + m.falhou + m.pulado + m.desconhecido;
    return {
      total: m.total,
      processados: processados,
      percentual: m.total ? Math.round((processados / m.total) * 100) : 0,
      enviados: m.enviado,
      falharam: m.falhou,
      pulados: m.pulado,
      desconhecidos: m.desconhecido,
      pendentes: m.pendente,
    };
  }

  /* --- controles ------------------------------------------------------- */

  function iniciar(campanha) {
    if (campanha.status === STATUS.EXECUTANDO) return campanha;
    campanha.status = STATUS.EXECUTANDO;
    if (!campanha.iniciadaEm) campanha.iniciadaEm = new Date().toISOString();
    campanha.atualizadaEm = new Date().toISOString();
    return campanha;
  }

  function pausar(campanha) {
    if (campanha.status !== STATUS.EXECUTANDO) return campanha;
    campanha.status = STATUS.PAUSADA;
    campanha.atualizadaEm = new Date().toISOString();
    return campanha;
  }

  function retomar(campanha) {
    if (campanha.status !== STATUS.PAUSADA) return campanha;
    campanha.status = STATUS.EXECUTANDO;
    campanha.atualizadaEm = new Date().toISOString();
    return campanha;
  }

  function cancelar(campanha, motivo) {
    campanha.status = STATUS.CANCELADA;
    campanha.finalizadaEm = new Date().toISOString();
    campanha.atualizadaEm = campanha.finalizadaEm;
    campanha.contatos.forEach(function (c) {
      if (c.status === ITEM.PENDENTE) {
        c.status = ITEM.PULADO;
        c.erro = motivo || "campanha cancelada";
      }
    });
    return campanha;
  }

  function finalizar(campanha) {
    campanha.status = STATUS.FINALIZADA;
    campanha.finalizadaEm = new Date().toISOString();
    campanha.atualizadaEm = campanha.finalizadaEm;
    return campanha;
  }

  /** Próximo contato pendente, respeitando o cursor. */
  function proximoPendente(campanha) {
    for (var i = campanha.cursor; i < campanha.contatos.length; i++) {
      if (campanha.contatos[i].status === ITEM.PENDENTE) {
        campanha.cursor = i;
        return campanha.contatos[i];
      }
    }
    // varre do começo (itens que voltaram a ser pendentes por edição)
    for (var j = 0; j < campanha.cursor; j++) {
      if (campanha.contatos[j].status === ITEM.PENDENTE) {
        campanha.cursor = j;
        return campanha.contatos[j];
      }
    }
    return null;
  }

  function marcarEnviando(campanha, idOuIndice) {
    var c = buscarContato(campanha, idOuIndice);
    if (!c) return null;
    c.status = ITEM.ENVIANDO;
    c.tentativas++;
    return c;
  }

  /**
   * Acha um contato por id estável.
   *
   * O índice da posição NÃO serve como identidade: durante uma campanha a
   * lista pode ser editada, e o índice de um contato muda. Aceita índice só
   * para compatibilidade com dados antigos.
   */
  function buscarContato(campanha, idOuIndice) {
    if (!campanha || !campanha.contatos) return null;
    if (idOuIndice === null || idOuIndice === undefined) return null;

    // aceitar o próprio objeto (caminho mais direto, sem depender de id)
    if (typeof idOuIndice === "object") {
      if (idOuIndice.id) {
        var achado = campanha.contatos.filter(function (c) {
          return c && c.id === idOuIndice.id;
        })[0];
        if (achado) return achado;
      }
      return campanha.contatos.indexOf(idOuIndice) === -1 ? null : idOuIndice;
    }

    var porId = campanha.contatos.filter(function (c) {
      return c && c.id === idOuIndice;
    })[0];
    if (porId) return porId;

    if (typeof idOuIndice === "number") {
      return campanha.contatos[idOuIndice] || null;
    }
    return null;
  }

  function marcarEnviado(campanha, idOuIndice) {
    var c = buscarContato(campanha, idOuIndice);
    if (!c) return null;
    c.status = ITEM.ENVIADO;
    c.erro = null;
    c.enviadoEm = new Date().toISOString();

    var e = estatisticas(campanha);
    e.enviadosHoje++;
    e.falhasConsecutivas = 0;

    campanha.atualizadaEm = c.enviadoEm;
    return c;
  }

  /** Garante o objeto de estatísticas, zerando o dia quando virou. */
  function estatisticas(campanha) {
    if (!campanha.estatisticas) {
      campanha.estatisticas = { dia: hoje(), enviadosHoje: 0, falhasConsecutivas: 0 };
    }
    if (campanha.estatisticas.dia !== hoje()) {
      campanha.estatisticas.dia = hoje();
      campanha.estatisticas.enviadosHoje = 0;
    }
    return campanha.estatisticas;
  }

  function limiteDiarioAtingido(campanha) {
    var limite = (campanha.protecoes && campanha.protecoes.limiteDiario) || 0;
    if (!limite) return false;
    return estatisticas(campanha).enviadosHoje >= limite;
  }

  function devePausarPorFalhas(campanha) {
    var n = (campanha.protecoes && campanha.protecoes.pausarAposFalhas) || 0;
    if (!n) return false;
    return estatisticas(campanha).falhasConsecutivas >= n;
  }

  function marcarFalhou(campanha, idOuIndice, erro) {
    var c = buscarContato(campanha, idOuIndice);
    if (!c) return null;
    c.status = ITEM.FALHOU;
    c.erro = String(erro || "erro desconhecido").slice(0, 300);

    estatisticas(campanha).falhasConsecutivas++;

    campanha.atualizadaEm = new Date().toISOString();
    return c;
  }

  /**
   * Resultado ambíguo: a mensagem pode ter sido entregue.
   *
   * Ocorre quando o envio estoura o tempo sem resposta. Tratar como falha
   * levaria a reenviar e duplicar; tratar como sucesso esconderia o problema.
   * Fica num estado próprio, que só o usuário resolve.
   */
  function marcarDesconhecido(campanha, idOuIndice, motivo) {
    var c = buscarContato(campanha, idOuIndice);
    if (!c) return null;
    c.status = ITEM.DESCONHECIDO;
    c.erro = String(motivo || "sem confirmação do WhatsApp").slice(0, 300);
    c.enviadoEm = c.enviadoEm || null;
    campanha.atualizadaEm = new Date().toISOString();
    return c;
  }

  /* --- edição durante a campanha --------------------------------------- */

  /**
   * A fila pode ser alterada agora?
   *
   * Política única para TODA ação que muda quem vai receber: remover contato,
   * remover pendentes, reconstruir a lista. Durante a execução a resposta é
   * sempre não — o índice e o plano de envio de um contato em trânsito
   * dependem da fila como ela estava.
   */
  function podeAlterarFila(campanha) {
    if (!campanha) return false;
    return campanha.status !== STATUS.EXECUTANDO;
  }

  /** Remove da fila tudo o que ainda não foi enviado. */
  function removerPendentes(campanha, numeros) {
    // segunda barreira, independente da interface
    if (!podeAlterarFila(campanha)) return 0;

    var alvo = null;
    if (numeros) {
      alvo = Object.create(null);
      numeros.forEach(function (n) {
        alvo[String(n).replace(/\D/g, "")] = true;
      });
    }

    var removidos = 0;
    campanha.contatos = campanha.contatos.filter(function (c) {
      var naoEnviado = c.status === ITEM.PENDENTE || c.status === ITEM.FALHOU;
      if (!naoEnviado) return true;
      if (alvo && !alvo[c.numero]) return true;
      removidos++;
      return false;
    });

    // reindexa
    campanha.contatos.forEach(function (c, i) {
      c.indice = i;
    });
    campanha.cursor = 0;
    campanha.atualizadaEm = new Date().toISOString();
    return removidos;
  }

  /**
   * Edita o conteúdo da campanha. Só afeta quem ainda não recebeu; quem já
   * recebeu mantém o que foi enviado.
   */
  function editarConteudo(campanha, patch) {
    if (patch.texto) campanha.texto = patch.texto;
    if (patch.opcoes) campanha.opcoes = patch.opcoes;
    if (patch.ritmo) campanha.ritmo = patch.ritmo;
    if (patch.pastas) campanha.pastas = patch.pastas;
    if (patch.nome) campanha.nome = patch.nome;
    campanha.atualizadaEm = new Date().toISOString();
    return campanha;
  }

  /** Recoloca os que falharam na fila. */
  function reprocessarFalhas(campanha) {
    var n = 0;
    campanha.contatos.forEach(function (c) {
      // O que ficou ambíguo NÃO volta sozinho: reenviar pode duplicar.
      if (c.status === ITEM.FALHOU) {
        c.status = ITEM.PENDENTE;
        c.erro = null;
        // as partes que já foram enviadas continuam marcadas, então o
        // reprocessamento manda só o texto ou só a mídia que faltou
        n++;
      }
    });
    if (n) {
      campanha.cursor = 0;
      campanha.atualizadaEm = new Date().toISOString();
    }
    return n;
  }

  /* --- relatório -------------------------------------------------------- */

  function gerarRelatorio(campanha) {
    var p = progresso(campanha);
    var inicio = campanha.iniciadaEm ? new Date(campanha.iniciadaEm).getTime() : null;
    var fim = campanha.finalizadaEm ? new Date(campanha.finalizadaEm).getTime() : Date.now();

    return {
      id: campanha.id,
      nome: campanha.nome,
      status: campanha.status,
      inicio: campanha.iniciadaEm,
      fim: campanha.finalizadaEm,
      duracaoMs: inicio ? fim - inicio : 0,
      resumo: p,
      enviados: campanha.contatos
        .filter(function (c) {
          return c.status === ITEM.ENVIADO;
        })
        .map(function (c) {
          return { numero: c.numero, em: c.enviadoEm };
        }),
      falhas: campanha.contatos
        .filter(function (c) {
          return c.status === ITEM.FALHOU;
        })
        .map(function (c) {
          return { numero: c.numero, erro: c.erro, tentativas: c.tentativas };
        }),
      pulados: campanha.contatos
        .filter(function (c) {
          return c.status === ITEM.PULADO;
        })
        .map(function (c) {
          return { numero: c.numero, motivo: c.erro };
        }),
    };
  }

  /** Relatório em CSV (para abrir no Excel). */
  function relatorioCSV(campanha) {
    // O cabeçalho tinha 5 colunas e as linhas 6 valores: tudo saía deslocado
    // no Excel. Agora a primeira coluna é "#", declarada no cabeçalho.
    var colunas = ["#", "numero", "status", "enviado_em", "erro", "tentativas"];
    var linhas = [colunas.join(",")];

    var campo = function (v) {
      var txt = v === null || v === undefined ? "" : String(v);
      return /[",;\n]/.test(txt) ? '"' + txt.replace(/"/g, '""') + '"' : txt;
    };

    // índice pela posição do laço: o indexOf anterior era O(n²) e travava
    // a exportação em listas grandes
    campanha.contatos.forEach(function (c, i) {
      linhas.push(
        [i, c.numero, c.status, c.enviadoEm || "", c.erro || "", c.tentativas || 0]
          .map(campo)
          .join(",")
      );
    });

    return linhas.join("\n");
  }

  /* ==========================================================================
   * 8. MONTAGEM DO ENVIO
   * ======================================================================== */

  /**
   * O que precisa ser enviado para UM contato: texto + uma mídia de cada pasta.
   * Devolve [{ tipo:"texto", conteudo }] ou
   *          [{ tipo:"audio"|"imagem"|"documento", arquivo }, ...]
   */
  /**
   * O que precisa ser enviado para UM contato: texto + uma mídia de cada pasta.
   *
   * O plano é CONGELADO no primeiro envio (`contato.envio`). Sem isso, um
   * reprocessamento depois de falha parcial sorteava outro arquivo e reenviava
   * o texto inteiro — a pessoa recebia a mesma mensagem duas vezes.
   *
   * Cada parte tem uma chave estável e um status próprio:
   *   { chave: "texto", tipo, status: "pendente"|"enviado"|"falhou"|"desconhecido" }
   */
  function montarEnvio(campanha, contatoOuIndice, rng) {
    var r = rng || Math.random;

    var contato =
      contatoOuIndice && typeof contatoOuIndice === "object"
        ? contatoOuIndice
        : buscarContato(campanha, contatoOuIndice);

    if (!contato) return [];

    // Todo contato precisa de id: é o que permite achar o registro certo
    // quando a resposta chega depois de a lista ter mudado.
    if (!contato.id) contato.id = novoIdContato();

    // plano já montado: devolve como está (com os status atuais)
    if (contato.envio && contato.envio.length) return contato.envio;

    var indice = campanha.contatos.indexOf(contato);
    var plano = [];

    var texto = montarTexto(campanha.texto, indice < 0 ? 0 : indice, r);
    if (texto && texto.trim()) {
      plano.push({
        chave: "texto",
        tipo: "texto",
        status: ITEM.PENDENTE,
        conteudo: transformarTexto(texto, campanha.opcoes, r),
      });
    }

    escolherMidias(campanha.pastas, r).forEach(function (m) {
      plano.push({
        chave: "midia:" + String(m.pastaId),
        tipo: m.tipo,
        status: ITEM.PENDENTE,
        arquivo: m.item,
        pastaNome: m.pastaNome,
      });
    });

    contato.envio = plano;
    return plano;
  }

  /** Marca o resultado de UMA parte (texto ou uma mídia). */
  function marcarParte(contato, chave, status, motivo) {
    if (!contato || !contato.envio) return null;
    var parte = contato.envio.filter(function (p) {
      return p.chave === chave;
    })[0];
    if (!parte) return null;

    parte.status = status;
    if (motivo) parte.erro = String(motivo).slice(0, 300);
    return parte;
  }

  /** Partes que ainda precisam ser enviadas (tudo que não deu certo). */
  function partesPendentes(contato) {
    if (!contato || !contato.envio) return [];
    return contato.envio.filter(function (p) {
      return p.status !== ITEM.ENVIADO;
    });
  }

  /** O contato está completamente enviado? */
  function envioCompleto(contato) {
    if (!contato || !contato.envio || !contato.envio.length) return false;
    return contato.envio.every(function (p) {
      return p.status === ITEM.ENVIADO;
    });
  }

  /**
   * Conserta uma campanha carregada do storage.
   *
   * Dados antigos (ou gravados por uma versão anterior) podem não ter id nos
   * contatos, podem vir sem as proteções e podem ter ficado com status
   * "executando" de uma aba que foi fechada. Aqui tudo é reconciliado.
   */
  function normalizarCampanha(c) {
    if (!c || typeof c !== "object") return null;

    if (!c.texto) c.texto = { modo: "fixo", textoFixo: "", rotacao: [] };
    if (!Array.isArray(c.texto.rotacao)) c.texto.rotacao = [];
    if (!c.opcoes) c.opcoes = {};
    if (!Array.isArray(c.pastas)) c.pastas = [];
    if (!Array.isArray(c.contatos)) c.contatos = [];
    if (!c.ritmo) c.ritmo = {};
    if (!c.protecoes) c.protecoes = { pausarAposFalhas: 5, limiteDiario: 0 };
    if (!c.estatisticas) c.estatisticas = { dia: hoje(), enviadosHoje: 0, falhasConsecutivas: 0 };
    if (typeof c.cursor !== "number" || c.cursor < 0) c.cursor = 0;

    c.contatos.forEach(function (item, i) {
      if (!item || typeof item !== "object") return;
      if (!item.id) item.id = novoIdContato();
      item.indice = i;
      if (!item.status) item.status = ITEM.PENDENTE;
      if (typeof item.tentativas !== "number") item.tentativas = 0;

      // estava sendo enviado quando a aba morreu: o resultado é desconhecido
      if (item.status === ITEM.ENVIANDO) {
        item.status = ITEM.DESCONHECIDO;
        item.erro = "a página foi fechada durante o envio";
      }

      if (item.envio && !Array.isArray(item.envio)) delete item.envio;
    });

    // nenhuma aba está executando ao carregar: "executando" é sempre resíduo
    if (c.status === STATUS.EXECUTANDO) {
      c.status = STATUS.PAUSADA;
      c.interrompida = true;
    }

    return c;
  }

  /** Valida a configuração antes de deixar iniciar. */
  function validar(campanha) {
    var erros = [];

    if (!campanha.contatos.length) erros.push("A lista está vazia.");

    var temTexto =
      campanha.texto.modo === "rotacao"
        ? (campanha.texto.rotacao || []).some(function (t) {
            return String(t || "").trim();
          })
        : String(campanha.texto.textoFixo || "").trim();

    var temMidia = (campanha.pastas || []).some(function (p) {
      return p.itens && p.itens.length;
    });

    if (!temTexto && !temMidia) {
      erros.push("Nada para enviar: escreva um texto ou adicione mídia em alguma pasta.");
    }

    var rit = campanha.ritmo || {};
    if (rit.intervaloMin > rit.intervaloMax) erros.push("Intervalo mínimo maior que o máximo.");
    if (rit.loteMin > rit.loteMax) erros.push("Lote mínimo maior que o máximo.");
    if (rit.pausaLoteMin > rit.pausaLoteMax) erros.push("Pausa mínima maior que a máxima.");
    if ((rit.loteMin || 0) < 1) erros.push("Lote mínimo precisa ser pelo menos 1.");

    var prot = campanha.protecoes || {};
    if ((prot.pausarAposFalhas || 0) < 0) erros.push("O limite de falhas não pode ser negativo.");
    if ((prot.limiteDiario || 0) < 0) erros.push("O limite diário não pode ser negativo.");

    return { ok: erros.length === 0, erros: erros };
  }

  return {
    // números
    normalizarNumero: normalizarNumero,
    lerLista: lerLista,
    paraChatId: paraChatId,
    variantesNumero: variantesNumero,
    dddValido: dddValido,
    // texto
    resolverSpintax: resolverSpintax,
    contarSpintax: contarSpintax,
    montarTexto: montarTexto,
    proximaRotacao: proximaRotacao,
    embaralhar: embaralhar,
    aplicarHomoglifos: aplicarHomoglifos,
    gerarCaudaInvisivel: gerarCaudaInvisivel,
    transformarTexto: transformarTexto,
    HOMOGLIFOS: HOMOGLIFOS,
    INVISIVEIS: INVISIVEIS,
    // ritmo
    inteiroEntre: inteiroEntre,
    planejarRitmo: planejarRitmo,
    duracaoEstimada: duracaoEstimada,
    // mídia
    escolherMidias: escolherMidias,
    // campanha
    STATUS: STATUS,
    ITEM: ITEM,
    criarCampanha: criarCampanha,
    contarPorStatus: contarPorStatus,
    progresso: progresso,
    iniciar: iniciar,
    pausar: pausar,
    retomar: retomar,
    cancelar: cancelar,
    finalizar: finalizar,
    proximoPendente: proximoPendente,
    buscarContato: buscarContato,
    marcarDesconhecido: marcarDesconhecido,
    marcarParte: marcarParte,
    partesPendentes: partesPendentes,
    envioCompleto: envioCompleto,
    normalizarCampanha: normalizarCampanha,
    novoIdContato: novoIdContato,
    marcarEnviando: marcarEnviando,
    marcarEnviado: marcarEnviado,
    marcarFalhou: marcarFalhou,
    removerPendentes: removerPendentes,
    editarConteudo: editarConteudo,
    reprocessarFalhas: reprocessarFalhas,
    podeAlterarFila: podeAlterarFila,
    montarEnvio: montarEnvio,
    validar: validar,
    estatisticas: estatisticas,
    hoje: hoje,
    limiteDiarioAtingido: limiteDiarioAtingido,
    devePausarPorFalhas: devePausarPorFalhas,
    gerarRelatorio: gerarRelatorio,
    relatorioCSV: relatorioCSV,
  };
});
