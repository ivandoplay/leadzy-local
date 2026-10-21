/**
 * Tema escuro para a página de disparo em massa.
 *
 * As telas de `options.html` seguem a preferência salva em `isDarkMode`
 * (chave gravada pelo próprio app quando o usuário escolhe "Tema escuro" no
 * menu do usuário). Esta página é um HTML separado, com CSS próprio, e não
 * herdava nada disso: quem usava o app no escuro abria o disparo e levava uma
 * tela branca na cara.
 *
 * Este arquivo só aplica/remove a classe `dark` no <html>. As cores ficam em
 * `css/campaigns.css`, nos mesmos valores de `css/options.css`, para as duas
 * telas nunca divergirem de paleta.
 *
 * Carregado no <head>, antes do CSS pintar, para reduzir o piscar branco.
 */
(function () {
  "use strict";

  var RAIZ = document.documentElement;

  function aplicar(escuro) {
    RAIZ.classList.toggle("dark", !!escuro);
    RAIZ.setAttribute("data-tema", escuro ? "escuro" : "claro");
    // o Chrome pinta as barras de rolagem e campos nativos conforme isto
    RAIZ.style.colorScheme = escuro ? "dark" : "light";
  }

  try {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;

    chrome.storage.local.get(["isDarkMode"], function (dados) {
      void (chrome.runtime && chrome.runtime.lastError);
      aplicar(dados && dados.isDarkMode);
    });

    // acompanha a troca de tema feita em outra aba, sem precisar recarregar
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (mudancas, area) {
        if (area !== "local" || !mudancas.isDarkMode) return;
        aplicar(mudancas.isDarkMode.newValue);
      });
    }
  } catch (e) {
    // sem storage (teste isolado, arquivo aberto direto): fica no claro
  }
})();
