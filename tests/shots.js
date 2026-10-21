const {launch,sleep}=require('./lib/env');
(async()=>{
  const {ctx,id}=await launch();
  const page=await ctx.newPage();
  await page.setViewportSize({width:1280,height:900});
  await page.goto(`chrome-extension://${id}/campaigns.html`,{waitUntil:"load"});
  await page.waitForFunction(()=>!!window.__LZ_CAMPANHA_UI__,{timeout:20000});
  await sleep(1000);
  await page.evaluate(()=>{
    const C=window.LZCampanha, ui=window.__LZ_CAMPANHA_UI__;
    const c=JSON.parse(JSON.stringify(ui.getCampanha()));
    c.id="captura"; c.nome="Clientes de outubro";
    c.contatos=Array.from({length:24},(_,i)=>({id:"c"+i,indice:i,numero:"5511999"+(100000+i),bruto:"",status:i<5?"enviado":(i===5?"falhou":(i===6?"enviando":"pendente")),tentativas:i===5?2:0,erro:i===5?"sem confirmação do WhatsApp":null,enviadoEm:i<5?Date.now()-60000*(i+1):null}));
    c.texto={modo:"rotacao",rotacao:["Olá, tudo bem?","Oi! Passando para avisar."],textoFixo:""};
    c.pastas=[{id:"p1",nome:"Fotos do produto",tipo:"imagem",itens:[{id:"m1",nome:"foto1.jpg"},{id:"m2",nome:"foto2.jpg"}]}];
    c.status="pausada"; c.cursor=7;
    ui.setCampanha(c);
  });
  await sleep(700);
  await page.screenshot({path:"/home/user/docs/capturas/campanhas-desktop.png"});
  const erros = [];
  page.on("pageerror", e=>erros.push(e.message));
  await page.setViewportSize({width:390,height:844});
  await sleep(400);
  await page.screenshot({path:"/home/user/docs/capturas/campanhas-mobile.png"});
  console.log("erros:", JSON.stringify(erros));
  await ctx.close();
})();
