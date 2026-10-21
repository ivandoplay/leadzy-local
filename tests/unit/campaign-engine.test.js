"use strict";

/**
 * Motor de disparo em massa — testes de lógica pura.
 * Sem navegador, sem WhatsApp: só entra dado, sai decisão.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const E = require("../../extensao/js/campaign-engine.js");

/** RNG determinístico, para que os testes não dependam de sorte. */
function rngFixo(valor) {
  return () => valor;
}
function rngSequencia(valores) {
  let i = 0;
  return () => valores[i++ % valores.length];
}

/* ===========================================================================
 * NÚMEROS
 * ======================================================================== */

test("normaliza telefone brasileiro com e sem DDI", () => {
  const casos = [
    ["11999998888", "5511999998888"],
    ["5511999998888", "5511999998888"],
    ["(11) 99999-8888", "5511999998888"],
    ["+55 11 99999-8888", "5511999998888"],
    ["11 99999-8888", "5511999998888"],
    ["011 99999-8888", "5511999998888"],
    ["+55 (21) 98888-7777", "5521988887777"],
    ["85 91234-5678", "5585912345678"],
  ];
  for (const [entrada, esperado] of casos) {
    assert.strictEqual(E.normalizarNumero(entrada).e164, esperado, `falhou: ${entrada}`);
  }
});

test("recusa números inválidos com motivo", () => {
  const casos = [
    ["", "vazio"],
    ["abc", "sem dígitos"],
    ["000", "só zeros"],
    ["123", "curto demais"],
    ["11333344444", "celular deve começar com 9"], // 11 dígitos, 3º dígito != 9
    ["10999998888", "DDD inválido"], // DDD 10 não existe
  ];
  for (const [entrada, motivo] of casos) {
    const r = E.normalizarNumero(entrada);
    assert.strictEqual(r.ok, false, `deveria recusar: ${entrada}`);
    if (motivo) assert.strictEqual(r.motivo, motivo, `motivo errado para ${entrada}`);
  }
});

test("aceita todos os DDDs válidos e recusa os inexistentes", () => {
  const validos = ["11", "21", "31", "47", "61", "71", "85", "99"];
  const invalidos = ["10", "20", "23", "25", "26", "30", "36", "39", "40", "56", "60", "70", "80", "90"];
  for (const ddd of validos) {
    assert.strictEqual(E.dddValido(ddd), true, `DDD ${ddd} deveria ser válido`);
  }
  for (const ddd of invalidos) {
    assert.strictEqual(E.dddValido(ddd), false, `DDD ${ddd} deveria ser inválido`);
  }
});

test("lista colada misturada: extrai certos, separa errados e tira duplicados", () => {
  const texto = [
    "(11) 99999-8888",
    "+55 21 98888-7777",
    "11999998888", // duplicado do primeiro
    "123", // inválido
    "31 98888-7777, 41 99999-0000; 85 91234-5678",
  ].join("\n");

  const r = E.lerLista(texto);
  assert.deepStrictEqual(r.validos.map((v) => v.numero), [
    "5511999998888",
    "5521988887777",
    "5531988887777",
    "5541999990000",
    "5585912345678",
  ]);
  assert.strictEqual(r.invalidos.length, 1);
  assert.strictEqual(r.invalidos[0].entrada, "123");
  assert.strictEqual(r.duplicados, 1);
});

test("lista vazia não explode", () => {
  for (const v of ["", "   ", null, undefined]) {
    const r = E.lerLista(v);
    assert.deepStrictEqual(r.validos, []);
    assert.strictEqual(r.total, 0);
  }
});

test("converte para o chatId do WhatsApp", () => {
  assert.strictEqual(E.paraChatId("5511999998888"), "5511999998888@c.us");
});

/* ===========================================================================
 * TEXTO — fixo, spintax, rotação
 * ======================================================================== */

test("spintax escolhe dentro das opções", () => {
  assert.strictEqual(E.resolverSpintax("{a|b|c}", rngFixo(0)), "a");
  assert.strictEqual(E.resolverSpintax("{a|b|c}", rngFixo(0.5)), "b");
  assert.strictEqual(E.resolverSpintax("{a|b|c}", rngFixo(0.99)), "c");
});

test("spintax aninhado é resolvido por completo", () => {
  const saida = E.resolverSpintax("Oi {nome|{amigo|cliente}}, tudo bem?", rngFixo(0.9));
  assert.strictEqual(saida.includes("{"), false, `sobrou chave: ${saida}`);
  assert.strictEqual(saida.includes("}"), false);
});

test("spintax com chave desbalanceada não entra em loop", () => {
  const saida = E.resolverSpintax("texto {sem fechar", rngFixo(0));
  assert.strictEqual(typeof saida, "string");
});

test("conta as variações possíveis do spintax", () => {
  assert.strictEqual(E.contarSpintax("sem variacao"), 1);
  assert.strictEqual(E.contarSpintax("{a|b}"), 2);
  assert.strictEqual(E.contarSpintax("{a|b|c}"), 3);
  assert.strictEqual(E.contarSpintax("{a|b} e {c|d}"), 4);
  assert.strictEqual(E.contarSpintax("{a|{b|c}}"), 3);
});

test("modo fixo devolve sempre o mesmo texto", () => {
  const cfg = { modo: "fixo", textoFixo: "Olá, tudo bem?" };
  for (const i of [0, 1, 5, 99]) {
    assert.strictEqual(E.montarTexto(cfg, i, rngFixo(0.3)), "Olá, tudo bem?");
  }
});

test("modo rotação embaralha cada volta e não repete em sequência", () => {
  // Antes era `lista[i % n]` = A,B,C,A,B,C — ciclo perfeito, fácil de detectar.
  const cfg = { modo: "rotacao", rotacao: ["A", "B", "C"], _ordem: null };
  const rng = (() => {
    let k = 0;
    const vals = [0.7, 0.2, 0.9, 0.4, 0.1, 0.6];
    return () => vals[k++ % vals.length];
  })();

  const saida = [];
  for (let i = 0; i < 9; i++) saida.push(E.montarTexto(cfg, i, rng));

  // cada volta de 3 contém as 3 mensagens exatamente uma vez
  for (let v = 0; v < 3; v++) {
    const bloco = saida.slice(v * 3, v * 3 + 3).sort();
    assert.deepStrictEqual(bloco, ["A", "B", "C"], `volta ${v + 1} incompleta: ${bloco}`);
  }

  // nenhuma repetição imediata
  for (let i = 1; i < saida.length; i++) {
    assert.notStrictEqual(saida[i], saida[i - 1], `repetiu "${saida[i]}" na posição ${i}`);
  }

  // e não é o ciclo fixo antigo
  assert.notDeepStrictEqual(saida, ["A", "B", "C", "A", "B", "C", "A", "B", "C"]);
});

test("rotação ignora entradas vazias", () => {
  const cfg = { modo: "rotacao", rotacao: ["A", "", "  ", "B"], _ordem: null };
  const saida = [0, 1].map(() => E.montarTexto(cfg, 0, rngFixo(0)));
  assert.deepStrictEqual(saida.sort(), ["A", "B"]);
});

test("embaralhar devolve todos os itens, sem perder nem duplicar", () => {
  const base = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = E.embaralhar(base, Math.random);
  assert.strictEqual(out.length, base.length);
  assert.deepStrictEqual(out.slice().sort((a, b) => a - b), base);
  assert.deepStrictEqual(base, [1, 2, 3, 4, 5, 6, 7, 8], "não pode alterar o original");
});

/* ===========================================================================
 * HOMOGLIFOS
 * ======================================================================== */

test("homoglifos trocam letras por caracteres visualmente iguais", () => {
  const saida = E.aplicarHomoglifos("Ola pessoal", 100, rngFixo(0));
  assert.notStrictEqual(saida, "Ola pessoal", "deveria ter trocado algo");
  // continua "parecendo" o mesmo texto
  assert.strictEqual(saida.length, "Ola pessoal".length, "não pode mudar o tamanho");
});

test("homoglifos com intensidade 0 não alteram nada", () => {
  assert.strictEqual(E.aplicarHomoglifos("Ola pessoal", 0, rngFixo(0)), "Ola pessoal");
});

test("homoglifos não corrompem URLs", () => {
  const saida = E.aplicarHomoglifos("acesse https://exemplo.com/ok", 100, rngFixo(0));
  assert.ok(saida.includes("https://exemplo.com/ok"), `URL quebrada: ${saida}`);
});

test("homoglifos deixam o texto visualmente equivalente (mesmo comprimento, sem espaços extras)", () => {
  const original = "Promoção especial para você hoje";
  const saida = E.aplicarHomoglifos(original, 100, rngFixo(0));
  assert.strictEqual(saida.length, original.length);
  assert.strictEqual(saida.replace(/\s/g, "").length, original.replace(/\s/g, "").length);
});

/* ===========================================================================
 * INVISÍVEIS
 * ======================================================================== */

test("gera exatamente a quantidade pedida de invisíveis", () => {
  for (const n of [0, 1, 4, 8]) {
    assert.strictEqual(E.gerarCaudaInvisivel(n, true, rngFixo(0)).length, n);
  }
});

test("invisíveis não ocupam espaço visível (largura zero ou espaço fino)", () => {
  const cauda = E.gerarCaudaInvisivel(6, true, rngFixo(0));
  const permitidos = new Set(E.INVISIVEIS);
  for (const ch of cauda) {
    assert.ok(permitidos.has(ch), `caractere inesperado: U+${ch.codePointAt(0).toString(16)}`);
  }
});

test("modo sem espaço usa só caracteres de largura zero", () => {
  const cauda = E.gerarCaudaInvisivel(6, false, rngFixo(0.99));
  assert.ok(!cauda.includes("\u200A"), "não deveria usar hair space");
  assert.ok(!cauda.includes("\u2009"), "não deveria usar thin space");
});

test("quantidade é limitada para não virar texto absurdo", () => {
  assert.strictEqual(E.gerarCaudaInvisivel(999, true, rngFixo(0)).length, 12);
  assert.strictEqual(E.gerarCaudaInvisivel(-5, true, rngFixo(0)).length, 0);
});

test("transformarTexto aplica homoglifos e invisíveis juntos", () => {
  const saida = E.transformarTexto("Ola", { homoglifos: true, invisiveis: true, invisiveisQtd: 4 }, rngFixo(0));
  assert.ok(saida.length > "Ola".length + 1, "esperava homoglifos + cauda");
});

/* ===========================================================================
 * RITMO
 * ======================================================================== */

test("inteiroEntre respeita os limites", () => {
  assert.strictEqual(E.inteiroEntre(8, 12, rngFixo(0)), 8);
  assert.strictEqual(E.inteiroEntre(8, 12, rngFixo(0.999)), 12);
  const v = E.inteiroEntre(8, 12, Math.random);
  assert.ok(v >= 8 && v <= 12, `fora da faixa: ${v}`);
});

test("intervalo invertido não quebra (min > max)", () => {
  assert.strictEqual(E.inteiroEntre(12, 8, rngFixo(0)), 8);
});

test("plano cobre todos os contatos exatamente uma vez", () => {
  const plano = E.planejarRitmo(25, { intervaloMin: 20, intervaloMax: 45, loteMin: 8, loteMax: 12, pausaLoteMin: 5, pausaLoteMax: 10 }, rngFixo(0));
  const envios = plano.filter((p) => p.tipo === "envio");
  assert.strictEqual(envios.length, 25);
  assert.deepStrictEqual(
    envios.map((e) => e.indice),
    Array.from({ length: 25 }, (_, i) => i),
    "índices fora de ordem ou repetidos"
  );
});

test("respeita o tamanho de lote configurado", () => {
  const plano = E.planejarRitmo(30, { intervaloMin: 1, intervaloMax: 2, loteMin: 10, loteMax: 10, pausaLoteMin: 1, pausaLoteMax: 1 }, rngFixo(0));
  const pausas = plano.filter((p) => p.tipo === "pausa-lote");
  assert.strictEqual(pausas.length, 2, "30 mensagens em lotes de 10 = 2 pausas");
});

test("intervalo entre mensagens fica dentro da faixa configurada", () => {
  const plano = E.planejarRitmo(20, { intervaloMin: 20, intervaloMax: 45, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 }, Math.random);
  for (const p of plano.filter((x) => x.tipo === "espera")) {
    assert.ok(p.ms >= 20000 && p.ms <= 45000, `intervalo fora da faixa: ${p.ms}`);
  }
});

test("pausa entre lotes fica em minutos", () => {
  const plano = E.planejarRitmo(6, { intervaloMin: 1, intervaloMax: 1, loteMin: 3, loteMax: 3, pausaLoteMin: 5, pausaLoteMax: 10 }, rngFixo(0));
  const pausa = plano.find((p) => p.tipo === "pausa-lote");
  assert.ok(pausa.ms >= 300000 && pausa.ms <= 600000, `pausa fora da faixa: ${pausa.ms}`);
});

test("um único contato não gera pausa nem espera", () => {
  const plano = E.planejarRitmo(1, { intervaloMin: 20, intervaloMax: 45, loteMin: 8, loteMax: 12, pausaLoteMin: 5, pausaLoteMax: 10 }, rngFixo(0));
  assert.strictEqual(plano.length, 1);
  assert.strictEqual(plano[0].tipo, "envio");
});

/* ===========================================================================
 * MÍDIA POR PASTA
 * ======================================================================== */

const pastas = [
  { id: "p1", nome: "Áudios A", tipo: "audio", itens: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] },
  { id: "p2", nome: "Áudios B", tipo: "audio", itens: [{ id: "b1" }, { id: "b2" }] },
  { id: "p3", nome: "Imagens", tipo: "imagem", itens: [{ id: "i1" }] },
];

test("escolhe um item de CADA pasta", () => {
  const escolhas = E.escolherMidias(pastas, rngFixo(0));
  assert.strictEqual(escolhas.length, 3);
  assert.deepStrictEqual(escolhas.map((e) => e.item.id), ["a1", "b1", "i1"]);
});

test("pastas vazias são ignoradas", () => {
  const comVazia = pastas.concat([{ id: "p4", nome: "Vazia", tipo: "audio", itens: [] }]);
  assert.strictEqual(E.escolherMidias(comVazia, rngFixo(0)).length, 3);
});

test("variação: com rng diferente escolhe arquivos diferentes", () => {
  const a = E.escolherMidias(pastas, rngFixo(0)).map((e) => e.item.id);
  const b = E.escolherMidias(pastas, rngFixo(0.9)).map((e) => e.item.id);
  assert.notDeepStrictEqual(a, b, "deveria variar entre envios");
});

/* ===========================================================================
 * CAMPANHA — estado e controles
 * ======================================================================== */

function campanhaExemplo(n = 5) {
  const contatos = Array.from({ length: n }, (_, i) => ({
    numero: "55119999900" + String(i).padStart(2, "0"),
    bruto: String(i),
  }));
  return E.criarCampanha({
    nome: "Teste",
    contatos,
    texto: { modo: "fixo", textoFixo: "Oi" },
  });
}

test("cria campanha com todos os contatos pendentes", () => {
  const c = campanhaExemplo(5);
  assert.strictEqual(c.status, E.STATUS.RASCUNHO);
  assert.strictEqual(c.contatos.length, 5);
  assert.ok(c.contatos.every((x) => x.status === E.ITEM.PENDENTE));
});

test("progresso começa zerado e termina em 100%", () => {
  const c = campanhaExemplo(4);
  assert.strictEqual(E.progresso(c).percentual, 0);

  E.iniciar(c);
  for (let i = 0; i < 4; i++) {
    E.marcarEnviando(c, i);
    E.marcarEnviado(c, i);
  }
  const p = E.progresso(c);
  assert.strictEqual(p.percentual, 100);
  assert.strictEqual(p.enviados, 4);
});

test("pausar e retomar mudam o status corretamente", () => {
  const c = campanhaExemplo(3);
  E.iniciar(c);
  assert.strictEqual(c.status, E.STATUS.EXECUTANDO);
  E.pausar(c);
  assert.strictEqual(c.status, E.STATUS.PAUSADA);
  E.retomar(c);
  assert.strictEqual(c.status, E.STATUS.EXECUTANDO);
});

test("pausar campanha que não está rodando não faz nada", () => {
  const c = campanhaExemplo(3);
  E.pausar(c);
  assert.strictEqual(c.status, E.STATUS.RASCUNHO);
});

test("cancelar marca os pendentes como pulados e preserva os enviados", () => {
  const c = campanhaExemplo(5);
  E.iniciar(c);
  E.marcarEnviando(c, 0);
  E.marcarEnviado(c, 0);
  E.cancelar(c);

  assert.strictEqual(c.status, E.STATUS.CANCELADA);
  assert.strictEqual(c.contatos[0].status, E.ITEM.ENVIADO, "quem recebeu continua enviado");
  assert.strictEqual(c.contatos[1].status, E.ITEM.PULADO);
  assert.strictEqual(E.progresso(c).enviados, 1);
});

test("proximoPendente pula os já enviados", () => {
  const c = campanhaExemplo(3);
  E.marcarEnviando(c, 0);
  E.marcarEnviado(c, 0);
  const prox = E.proximoPendente(c);
  assert.strictEqual(prox.indice, 1);
});

test("proximoPendente devolve null quando acabou", () => {
  const c = campanhaExemplo(2);
  for (let i = 0; i < 2; i++) {
    E.marcarEnviando(c, i);
    E.marcarEnviado(c, i);
  }
  assert.strictEqual(E.proximoPendente(c), null);
});

test("falha é registrada com erro e pode ser reprocessada", () => {
  const c = campanhaExemplo(2);
  E.marcarEnviando(c, 0);
  E.marcarFalhou(c, 0, "número não existe");

  assert.strictEqual(c.contatos[0].status, E.ITEM.FALHOU);
  assert.strictEqual(c.contatos[0].erro, "número não existe");
  assert.strictEqual(c.contatos[0].tentativas, 1);

  assert.strictEqual(E.reprocessarFalhas(c), 1);
  assert.strictEqual(c.contatos[0].status, E.ITEM.PENDENTE);
  assert.strictEqual(c.contatos[0].erro, null);
});

/* --- edição durante a campanha ---------------------------------------- */

test("remove da fila só quem ainda não recebeu", () => {
  const c = campanhaExemplo(4);
  // fora de execução: a remoção é permitida
  E.marcarEnviando(c, 0);
  E.marcarEnviado(c, 0);
  E.marcarEnviando(c, 1);
  E.marcarEnviado(c, 1);

  // tenta remover o contato 1 (já enviado) e o 2 (pendente)
  const removidos = E.removerPendentes(c, [c.contatos[1].numero, c.contatos[2].numero]);

  assert.strictEqual(removidos, 1, "só o pendente pode sair");
  assert.strictEqual(c.contatos.length, 3);
  assert.ok(
    c.contatos.some((x) => x.status === E.ITEM.ENVIADO && x.numero === "5511999990001"),
    "quem já recebeu não pode ser removido"
  );
});

test("remover sem filtro limpa toda a fila pendente", () => {
  const c = campanhaExemplo(5);
  E.marcarEnviando(c, 0);
  E.marcarEnviado(c, 0);
  assert.strictEqual(E.removerPendentes(c), 4);
  assert.strictEqual(c.contatos.length, 1);
});

test("índices são reindexados depois de remover", () => {
  const c = campanhaExemplo(3);
  E.removerPendentes(c, [c.contatos[0].numero]);
  assert.deepStrictEqual(c.contatos.map((x) => x.indice), [0, 1]);
});

test("editar conteúdo troca texto e opções sem tocar no que já foi enviado", () => {
  const c = campanhaExemplo(2);
  E.iniciar(c);
  E.marcarEnviando(c, 0);
  E.marcarEnviado(c, 0);

  E.editarConteudo(c, {
    texto: { modo: "fixo", textoFixo: "Novo texto" },
    opcoes: { homoglifos: true, invisiveis: true, invisiveisQtd: 4 },
  });

  assert.strictEqual(c.texto.textoFixo, "Novo texto");
  assert.strictEqual(c.opcoes.homoglifos, true);
  assert.strictEqual(c.contatos[0].status, E.ITEM.ENVIADO, "quem recebeu não muda");
});

/* --- relatório -------------------------------------------------------- */

test("relatório separa enviados, falhas e pulados", () => {
  const c = campanhaExemplo(4);
  E.iniciar(c);
  E.marcarEnviando(c, 0);
  E.marcarEnviado(c, 0);
  E.marcarEnviando(c, 1);
  E.marcarFalhou(c, 1, "sem whatsapp");
  E.cancelar(c);

  const rel = E.gerarRelatorio(c);
  assert.strictEqual(rel.resumo.enviados, 1);
  assert.strictEqual(rel.resumo.falharam, 1);
  assert.strictEqual(rel.resumo.pulados, 2);
  assert.strictEqual(rel.enviados[0].numero, "5511999990000");
  assert.strictEqual(rel.falhas[0].erro, "sem whatsapp");
});

test("CSV do relatório tem cabeçalho e uma linha por contato", () => {
  const c = campanhaExemplo(3);
  const csv = E.relatorioCSV(c);
  const linhas = csv.split("\n");
  assert.strictEqual(linhas[0], "#,numero,status,enviado_em,erro,tentativas");
  assert.strictEqual(linhas.length, 4);
});

test("toda linha do CSV tem o mesmo número de colunas do cabeçalho", () => {
  // O cabeçalho declarava 5 colunas e as linhas tinham 6 valores: os dados
  // saíam deslocados no Excel.
  const c = campanhaExemplo(4);
  E.marcarEnviando(c, 0);
  E.marcarEnviado(c, 0);
  E.marcarEnviando(c, 1);
  E.marcarFalhou(c, 1, 'falha, com vírgula');

  const linhas = E.relatorioCSV(c).split("\n");
  const totalColunas = (linha) => {
    // conta vírgulas respeitando campos entre aspas
    let n = 1, dentro = false;
    for (const ch of linha) {
      if (ch === '"') dentro = !dentro;
      else if (ch === "," && !dentro) n++;
    }
    return n;
  };

  const esperado = totalColunas(linhas[0]);
  assert.strictEqual(esperado, 6, "cabeçalho deve declarar 6 colunas");
  linhas.slice(1).forEach((l, i) => {
    assert.strictEqual(totalColunas(l), esperado, `linha ${i + 1} desalinhada: ${l}`);
  });

  // a primeira coluna é a posição, e o número vem depois
  assert.match(linhas[1], /^0,5511/);
});

test("CSV escapa vírgula e aspas no campo de erro", () => {
  const c = campanhaExemplo(1);
  E.marcarEnviando(c, 0);
  E.marcarFalhou(c, 0, 'erro, com "aspas"');
  const linha = E.relatorioCSV(c).split("\n")[1];
  assert.ok(linha.includes('"erro, com ""aspas"""'), `não escapou: ${linha}`);
});

/* ===========================================================================
 * MONTAGEM E VALIDAÇÃO
 * ======================================================================== */

test("montarEnvio junta texto + uma mídia de cada pasta", () => {
  const c = E.criarCampanha({
    contatos: [{ numero: "5511999998888", bruto: "x" }],
    texto: { modo: "fixo", textoFixo: "Oi" },
    pastas,
  });
  const partes = E.montarEnvio(c, 0, rngFixo(0));
  assert.strictEqual(partes.filter((p) => p.tipo === "texto").length, 1);
  assert.strictEqual(partes.filter((p) => p.tipo === "audio").length, 2, "duas pastas de áudio");
  assert.strictEqual(partes.filter((p) => p.tipo === "imagem").length, 1);
});

test("campanha só de mídia (sem texto) é válida", () => {
  const c = E.criarCampanha({
    contatos: [{ numero: "5511999998888", bruto: "x" }],
    texto: { modo: "fixo", textoFixo: "" },
    pastas,
  });
  assert.strictEqual(E.validar(c).ok, true);
});

test("campanha vazia é recusada", () => {
  const c = E.criarCampanha({ contatos: [], texto: { modo: "fixo", textoFixo: "Oi" } });
  const v = E.validar(c);
  assert.strictEqual(v.ok, false);
  assert.ok(v.erros.some((e) => /lista está vazia/i.test(e)));
});

test("sem texto e sem mídia é recusado", () => {
  const c = E.criarCampanha({
    contatos: [{ numero: "5511999998888", bruto: "x" }],
    texto: { modo: "fixo", textoFixo: "   " },
    pastas: [],
  });
  const v = E.validar(c);
  assert.strictEqual(v.ok, false);
  assert.ok(v.erros.some((e) => /nada para enviar/i.test(e)));
});

test("intervalo invertido é recusado com mensagem clara", () => {
  const c = campanhaExemplo(2);
  c.ritmo = { intervaloMin: 50, intervaloMax: 10, loteMin: 8, loteMax: 12, pausaLoteMin: 5, pausaLoteMax: 10 };
  const v = E.validar(c);
  assert.strictEqual(v.ok, false);
  assert.ok(v.erros.some((e) => /intervalo mínimo/i.test(e)));
});

test("rotação só com entradas vazias é recusada", () => {
  const c = E.criarCampanha({
    contatos: [{ numero: "5511999998888", bruto: "x" }],
    texto: { modo: "rotacao", rotacao: ["", "  "] },
  });
  assert.strictEqual(E.validar(c).ok, false);
});

test("rotação com uma entrada válida passa", () => {
  const c = E.criarCampanha({
    contatos: [{ numero: "5511999998888", bruto: "x" }],
    texto: { modo: "rotacao", rotacao: ["Oi", ""] },
  });
  assert.strictEqual(E.validar(c).ok, true);
});

/* ===========================================================================
 * INTEGRAÇÃO: dois envios nunca saem idênticos com as proteções ligadas
 * ======================================================================== */

test("com homoglifos+invisíveis ligados, textos iguais ficam diferentes", () => {
  const opcoes = { homoglifos: true, homoglifosIntensidade: 100, invisiveis: true, invisiveisQtd: 4 };
  const a = E.transformarTexto("Ola tudo bem", opcoes, rngSequencia([0.1, 0.9, 0.3, 0.7, 0.5]));
  const b = E.transformarTexto("Ola tudo bem", opcoes, rngSequencia([0.8, 0.2, 0.6, 0.4, 0.95]));
  assert.notStrictEqual(a, b, "as duas mensagens ficaram idênticas");
});


/* ===========================================================================
 * TRAVAS DE SEGURANÇA
 * ======================================================================== */

test("conta falhas consecutivas e zera ao enviar", () => {
  const c = campanhaExemplo(4);

  E.marcarFalhou(c, 0, "erro 1");
  assert.strictEqual(c.estatisticas.falhasConsecutivas, 1);
  E.marcarFalhou(c, 1, "erro 2");
  assert.strictEqual(c.estatisticas.falhasConsecutivas, 2);

  E.marcarEnviado(c, 2);
  assert.strictEqual(c.estatisticas.falhasConsecutivas, 0, "sucesso zera a sequência");
});

test("devePausarPorFalhas dispara no limite configurado", () => {
  const c = campanhaExemplo(10);
  c.protecoes = { pausarAposFalhas: 3, limiteDiario: 0 };

  E.marcarFalhou(c, 0, "x");
  E.marcarFalhou(c, 1, "x");
  assert.strictEqual(E.devePausarPorFalhas(c), false);

  E.marcarFalhou(c, 2, "x");
  assert.strictEqual(E.devePausarPorFalhas(c), true);
});

test("trava de falhas desligada (0) nunca pausa", () => {
  const c = campanhaExemplo(10);
  c.protecoes = { pausarAposFalhas: 0, limiteDiario: 0 };
  for (let i = 0; i < 10; i++) E.marcarFalhou(c, i, "x");
  assert.strictEqual(E.devePausarPorFalhas(c), false);
});

test("conta envios do dia e respeita o limite diário", () => {
  const c = campanhaExemplo(10);
  c.protecoes = { pausarAposFalhas: 0, limiteDiario: 3 };

  assert.strictEqual(E.limiteDiarioAtingido(c), false);
  for (let i = 0; i < 3; i++) E.marcarEnviado(c, i);

  assert.strictEqual(c.estatisticas.enviadosHoje, 3);
  assert.strictEqual(E.limiteDiarioAtingido(c), true);
});

test("limite diário zero significa sem limite", () => {
  const c = campanhaExemplo(5);
  c.protecoes = { pausarAposFalhas: 0, limiteDiario: 0 };
  for (let i = 0; i < 5; i++) E.marcarEnviado(c, i);
  assert.strictEqual(E.limiteDiarioAtingido(c), false);
});

test("a contagem diária zera quando muda o dia", () => {
  const c = campanhaExemplo(5);
  c.protecoes = { pausarAposFalhas: 0, limiteDiario: 2 };
  E.marcarEnviado(c, 0);
  E.marcarEnviado(c, 1);
  assert.strictEqual(E.limiteDiarioAtingido(c), true);

  // simula virada de dia
  c.estatisticas.dia = "2020-01-01";
  assert.strictEqual(E.limiteDiarioAtingido(c), false);
  assert.strictEqual(c.estatisticas.enviadosHoje, 0);
});

test("campanha antiga sem estatísticas não quebra", () => {
  const c = campanhaExemplo(2);
  delete c.estatisticas;
  delete c.protecoes;

  assert.strictEqual(E.limiteDiarioAtingido(c), false);
  assert.strictEqual(E.devePausarPorFalhas(c), false);
  E.marcarEnviado(c, 0);
  assert.strictEqual(c.estatisticas.enviadosHoje, 1);
});

test("proteções negativas são recusadas na validação", () => {
  const c = campanhaExemplo(2);
  c.protecoes = { pausarAposFalhas: -1, limiteDiario: -5 };
  const v = E.validar(c);
  assert.strictEqual(v.ok, false);
  assert.ok(v.erros.some((e) => /negativo/i.test(e)));
});

/* ===========================================================================
 * INTEGRIDADE DO ESTADO (auditoria)
 *
 * Os quatro casos abaixo reproduzem bugs encontrados numa revisão estática
 * e confirmados com execução: identidade por índice, CSV desalinhado,
 * validação assimétrica de DDI e rotação com lista editada.
 * ======================================================================== */

test("remover um contato durante o envio não marca o contato errado", () => {
  const c = campanhaExemplo(4);
  const emVoo = E.proximoPendente(c);
  const numeroEmVoo = emVoo.numero;

  // a lista muda enquanto o envio está no ar
  E.removerPendentes(c, [numeroEmVoo]);

  const marcado = E.marcarEnviado(c, emVoo);
  assert.strictEqual(marcado, null, "o contato removido não pode ser marcado em outro lugar");

  const enviados = c.contatos.filter((x) => x.status === "enviado");
  assert.deepStrictEqual(enviados, [], "ninguém pode aparecer como enviado");
});

test("reordenar a lista durante o envio mantém o resultado no contato certo", () => {
  const c = campanhaExemplo(3);
  const emVoo = E.proximoPendente(c);

  const porNumero = {};
  c.contatos.forEach((x) => (porNumero[x.numero] = x));
  const novaOrdem = [c.contatos[2].numero, c.contatos[0].numero, c.contatos[1].numero];
  c.contatos = novaOrdem.map((n, i) => {
    const item = porNumero[n];
    item.indice = i;
    return item;
  });

  const marcado = E.marcarEnviado(c, emVoo);
  assert.strictEqual(marcado.numero, emVoo.numero, "marcou o contato errado");
});

test("contato sem id recebe um id na primeira vez que é usado", () => {
  const c = campanhaExemplo(2);
  c.contatos.forEach((x) => delete x.id);

  const plano = E.montarEnvio(c, c.contatos[0]);
  assert.ok(plano.length > 0);
  assert.ok(c.contatos[0].id, "deveria ganhar um id");
  assert.notStrictEqual(c.contatos[0].id, c.contatos[1].id);
});

test("normalizar campanha conserta dados antigos e interrompidos", () => {
  const antiga = {
    id: "velha",
    status: "executando",
    contatos: [
      { numero: "5511999990001", status: "enviando" },
      { numero: "5511999990002", status: "enviado" },
    ],
  };

  const c = E.normalizarCampanha(antiga);

  assert.strictEqual(c.status, "pausada", "executando sem executor vira pausada");
  assert.strictEqual(c.interrompida, true);
  assert.strictEqual(c.contatos[0].status, "desconhecido", "envio interrompido é ambíguo");
  assert.strictEqual(c.contatos[1].status, "enviado");
  assert.ok(c.contatos.every((x) => x.id), "todo contato ganha id");
  assert.ok(c.protecoes, "proteções padrão criadas");
  assert.ok(c.estatisticas, "estatísticas padrão criadas");
  assert.ok(Array.isArray(c.texto.rotacao));
});

test("normalizar não mexe no que já está certo", () => {
  const c = campanhaExemplo(2);
  const antes = JSON.stringify(c.contatos.map((x) => x.numero));
  const d = E.normalizarCampanha(c);
  assert.strictEqual(d.contatos.length, 2);
  assert.strictEqual(JSON.stringify(d.contatos.map((x) => x.numero)), antes);
  assert.strictEqual(d.status, "rascunho");
  assert.notStrictEqual(d.interrompida, true);
});

test("DDI e nono dígito seguem a mesma regra", () => {
  // 11 dígitos sem o 9 na terceira posição não é celular, tenha DDI ou não
  const comDDI = E.normalizarNumero("5511234567890");
  const semDDI = E.normalizarNumero("11234567890");

  assert.strictEqual(comDDI.ok, false, "DDI não pode aceitar o que o formato nacional recusa");
  assert.strictEqual(semDDI.ok, false);
  assert.strictEqual(comDDI.motivo, semDDI.motivo, "mesmo motivo nos dois caminhos");

  assert.strictEqual(E.normalizarNumero("5511999990001").ok, true);
  assert.strictEqual(E.normalizarNumero("551133334444").ok, true, "fixo de 10 dígitos é válido");
});

test("rotação se reinicia quando os textos mudam no meio da campanha", () => {
  const cfg = { modo: "rotacao", rotacao: ["A", "B", "C"], _ordem: null };
  const rng = (() => {
    let k = 0;
    const v = [0.7, 0.2, 0.9, 0.4, 0.1, 0.6];
    return () => v[k++ % v.length];
  })();

  // consome uma volta e meia para deixar _ordem parcialmente gasta
  E.montarTexto(cfg, 0, rng);
  assert.ok(cfg._ordem && cfg._ordem.length >= 0);

  // usuário apaga o texto "C"
  cfg.rotacao = ["A", "B"];

  const saida = [];
  for (let i = 0; i < 6; i++) saida.push(E.montarTexto(cfg, 0, rng));

  assert.ok(!saida.includes("C"), "texto removido não pode aparecer");
  assert.ok(
    saida.every((x) => x === "A" || x === "B"),
    `saiu coisa estranha: ${JSON.stringify(saida)}`
  );
  for (let i = 1; i < saida.length; i++) {
    assert.notStrictEqual(saida[i], saida[i - 1], "não deve repetir em sequência");
  }
});

test("o plano de envio é congelado: reprocessar não troca o arquivo", () => {
  const c = campanhaExemplo(1);
  c.pastas = [
    {
      id: "p1",
      nome: "Áudios",
      tipo: "audio",
      itens: [
        { id: "a1", nome: "1.ogg", tipo: "audio" },
        { id: "a2", nome: "2.ogg", tipo: "audio" },
      ],
    },
  ];

  const plano1 = E.montarEnvio(c, c.contatos[0], () => 0);
  const idEscolhido = plano1[1].arquivo.id;

  // simula falha da mídia e novo sorteio no reprocessamento
  E.marcarParte(c.contatos[0], plano1[1].chave, "falhou", "erro");
  const plano2 = E.montarEnvio(c, c.contatos[0], () => 0.99); // rng que escolheria outro

  assert.strictEqual(plano2[1].arquivo.id, idEscolhido, "o arquivo tem de ser o mesmo");
});

test("reprocessar envia só a parte que falhou, não o texto de novo", () => {
  const c = campanhaExemplo(1);
  c.pastas = [
    { id: "p1", nome: "Áudios", tipo: "audio", itens: [{ id: "a1", nome: "1.ogg", tipo: "audio" }] },
  ];

  const contato = c.contatos[0];
  const plano = E.montarEnvio(c, contato, () => 0);

  // texto saiu, áudio falhou
  E.marcarParte(contato, "texto", "enviado");
  E.marcarParte(contato, plano[1].chave, "falhou", "arquivo sumiu");

  assert.strictEqual(E.envioCompleto(contato), false);

  const pendentes = E.partesPendentes(contato);
  assert.strictEqual(pendentes.length, 1, "só uma parte deve ser reenviada");
  assert.notStrictEqual(pendentes[0].chave, "texto", "o texto NÃO pode ser reenviado");
  assert.strictEqual(pendentes[0].tipo, "audio");
});

test("reprocessar falhas não ressuscita envio ambíguo", () => {
  const c = campanhaExemplo(2);
  E.marcarDesconhecido(c, c.contatos[0], "sem resposta em 60s");
  E.marcarFalhou(c, c.contatos[1], "número inválido");

  assert.strictEqual(c.contatos[0].status, "desconhecido");

  const n = E.reprocessarFalhas(c);

  assert.strictEqual(n, 1, "só a falha confirmada volta para a fila");
  assert.strictEqual(c.contatos[0].status, "desconhecido");
  assert.strictEqual(c.contatos[1].status, "pendente");
});

test("contadores e progresso incluem o estado desconhecido", () => {
  const c = campanhaExemplo(4);
  E.marcarEnviado(c, c.contatos[0]);
  E.marcarFalhou(c, c.contatos[1], "erro");
  E.marcarDesconhecido(c, c.contatos[2], "timeout");

  const p = E.progresso(c);
  assert.strictEqual(p.enviados, 1);
  assert.strictEqual(p.falharam, 1);
  assert.strictEqual(p.desconhecidos, 1);
  assert.strictEqual(p.pendentes, 1);
  assert.strictEqual(p.processados, 3, "desconhecido conta como processado");
  assert.strictEqual(p.percentual, 75);
});


/* ===========================================================================
 * POLÍTICA DA FILA (ACHADO 3)
 * ======================================================================== */

test("a fila não pode ser alterada durante a execução", () => {
  const c = campanhaExemplo(4);
  E.iniciar(c);

  assert.strictEqual(E.podeAlterarFila(c), false);

  const removidos = E.removerPendentes(c, [c.contatos[0].numero]);
  assert.strictEqual(removidos, 0, "o motor precisa recusar por conta própria");
  assert.strictEqual(c.contatos.length, 4, "ninguém pode ser removido");
});

test("a fila volta a aceitar alteração ao pausar, finalizar ou cancelar", () => {
  const c = campanhaExemplo(3);

  E.iniciar(c);
  assert.strictEqual(E.podeAlterarFila(c), false);

  E.pausar(c);
  assert.strictEqual(E.podeAlterarFila(c), true, "pausado permite administrar a fila");

  E.iniciar(c);
  E.cancelar(c);
  assert.strictEqual(E.podeAlterarFila(c), true);

  E.iniciar(c);
  E.finalizar(c);
  assert.strictEqual(E.podeAlterarFila(c), true);
});

test("a remoção recusada não altera índices nem status", () => {
  const c = campanhaExemplo(3);
  E.iniciar(c);
  E.marcarEnviando(c, 0);
  E.marcarEnviado(c, 0);

  const antes = c.contatos.map((x) => ({ id: x.id, indice: x.indice, status: x.status }));
  E.removerPendentes(c, [c.contatos[1].numero]);
  const depois = c.contatos.map((x) => ({ id: x.id, indice: x.indice, status: x.status }));

  assert.deepStrictEqual(depois, antes);
});

/* ===========================================================================
 * NONO DÍGITO — a mesma linha em duas grafias
 * ======================================================================== */

test("celular brasileiro tem as duas grafias, com o 9 primeiro", () => {
  // o caso real: 5586981638438 (com 9) x 558681638438 (sem 9)
  assert.deepEqual(E.variantesNumero("5586981638438"), [
    "5586981638438",
    "558681638438",
  ]);
  assert.deepEqual(E.variantesNumero("558681638438"), [
    "5586981638438",
    "558681638438",
  ]);
});

test("a forma sem o 9 também é tentada primeiro com o 9", () => {
  assert.deepEqual(E.variantesNumero("5511999998888"), [
    "5511999998888",
    "551199998888",
  ]);
});

test("fixo e número de outro país têm uma grafia só", () => {
  // assinante começando em 2–5 é fixo: não existe variante com 9
  assert.deepEqual(E.variantesNumero("558633224455"), ["558633224455"]);
  assert.deepEqual(E.variantesNumero("5586322244"), ["5586322244"]);
  assert.deepEqual(E.variantesNumero("14155552671"), ["14155552671"]);
});

test("variantes não inventam número a partir de lixo", () => {
  assert.deepEqual(E.variantesNumero(""), [""]);
  assert.deepEqual(E.variantesNumero(null), [""]);
});

test("as duas grafias levam ao mesmo destino lógico, em chatIds diferentes", () => {
  const [com9, sem9] = E.variantesNumero("5586981638438");
  assert.equal(E.paraChatId(com9), "5586981638438@c.us");
  assert.equal(E.paraChatId(sem9), "558681638438@c.us");
});
