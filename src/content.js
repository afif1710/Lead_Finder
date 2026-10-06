(() => {
  "use strict";
  const app = globalThis.MapsLeadFinder;
  if (app.initialized) return;
  app.initialized = true;
  let runner;
  const panel = new app.Panel({ start: options => runner.start(options), stop: () => runner.stop(), download: () => runner.download() });
  runner = new app.Runner(panel);
  app.runner = runner;
  app.panel = panel;
  panel.prefill(app.utils.searchText());
  let query = app.utils.committedQuery();
  let input = app.utils.searchText();
  let hadFeed = !!app.extractor.findFeed();
  let navigationTimer;
  function inspectNavigation() {
    if (!document.body.contains(panel.host)) document.body.append(panel.host);
    if (!location.pathname.startsWith("/maps")) {
      runner.stop("The Maps page changed. Download your collected listings before leaving this tab.");
      panel.host.hidden = true;
      return;
    }
    panel.host.hidden = false;
    const nextQuery = app.utils.committedQuery();
    const nextInput = app.utils.searchText();
    const feed = app.extractor.findFeed();
    if (runner.running) {
      if (runner.internalNavigation) {
        const currentPlace = location.pathname.includes("/maps/place/") ? app.utils.placeKey(location.href) : "";
        if (currentPlace && runner.allowedPlace && currentPlace !== runner.allowedPlace) runner.stop("A different place was opened. Your collected listings are ready to download.");
        if (nextQuery && runner.initialQuery && nextQuery !== runner.initialQuery) runner.stop("The Maps search changed. Your previous run is ready to download; click Start to collect this search.");
      } else if (nextInput !== runner.initialInput || (nextQuery && runner.initialQuery && nextQuery !== runner.initialQuery)) {
        runner.stop("The Maps search changed. Your previous run is ready to download; click Start to collect this search.");
      } else if (location.pathname.includes("/maps/place/") && !runner.initialURL.includes("/maps/place/")) {
        runner.stop("A place was opened during the run. Your collected listings are ready to download.");
      }
      if (!runner.internalNavigation) hadFeed = !!feed;
      return;
    }
    if ((nextQuery && nextQuery !== query) || (nextInput !== input && !!feed) || (!hadFeed && feed && !runner.results.size)) {
      panel.prefill(nextInput || nextQuery, query !== nextQuery || input !== nextInput);
      if (runner.options && runner.results.size) panel.status("New search ready. You can download the previous run, or click Start to collect this search.");
      else panel.status("Check the profession and city, then click Start.");
    }
    query = nextQuery;
    input = nextInput;
    hadFeed = !!feed;
  }
  navigationTimer = setInterval(inspectNavigation, app.config.timing.navigationPoll);
  window.addEventListener("pagehide", () => { runner.stop(); clearInterval(navigationTimer); }, { once: true });
  chrome.runtime.onMessage.addListener(message => { if (message.type === "MLF_SHOW_PANEL") panel.show(); });
})();
