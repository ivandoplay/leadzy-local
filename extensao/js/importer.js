(function () {
  (async () => {
    // console.log('[importer] importando wapi.js');
    await import('/js/wapi.js');
  })().catch(console.error);
})();
