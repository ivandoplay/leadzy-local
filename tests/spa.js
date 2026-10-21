const {launch,sleep}=require('/home/user/tests/lib/env');
(async()=>{
  const {ctx,id}=await launch();
  const p=await ctx.newPage();
  await p.setViewportSize({width:390,height:844});
  await p.goto(`chrome-extension://${id}/options.html#/messages`,{waitUntil:"load"});
  await sleep(3000);
  await p.screenshot({path:"/home/user/docs/capturas/ref-mobile.png"});
  const h = await p.evaluate(()=>document.querySelector("header").outerHTML.length);
  console.log("header bytes", h);
  await ctx.close();
})();
