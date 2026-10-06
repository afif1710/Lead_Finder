(() => {
  "use strict";
  const app = globalThis.MapsLeadFinder;
  const { sleep, waitFor, clean, placeKey, visible } = app.utils;
  const E = app.extractor;
  const S = app.config.selectors;
  const T = app.config.timing;
  class Runner {
    constructor(panel) {
      this.panel = panel;
      this.results = new Map();
      this.options = null;
      this.running = false;
      this.warnings = new Set();
      this.stopReason = "";
    }
    stop(reason = "Stopped. Your collected listings are ready to download.") {
      if (!this.running) return;
      this.stopReason = reason;
      this.controller.abort();
    }
    warn(message) { this.warnings.add(message); this.panel.warning([...this.warnings].join(" ")); }
    records() {
      let unresolved = 0;
      const records = [...this.results.values()].filter(record => record.name).map(record => {
        const formatted = app.phone.format(record.rawPhone, this.rule);
        if (formatted.unresolved) unresolved++;
        return { key: record.key, name: record.name, category: record.category, phone: formatted.value, website: record.website, websiteAmbiguous: record.websiteAmbiguous };
      });
      return { records, unresolved };
    }
    updateCounts() {
      const records = [...this.results.values()].filter(record => record.name);
      this.panel.counts(records.length, records.filter(record => !record.website && !record.websiteAmbiguous).length);
    }
    collect(feed) {
      const pending = [];
      for (const item of E.cards(feed)) {
        const extracted = E.extractCard(item);
        if (extracted.ad) { this.ads.add(extracted.key); continue; }
        let record = this.results.get(extracted.key);
        if (record) {
          for (const field of ["name", "category", "rawPhone", "website"]) if (!record[field] && extracted[field]) record[field] = extracted[field];
          if (!record.detailChecked) {
            for (const field of ["needsDetail", "needsContactDetails", "websiteNeedsConfirmation", "websiteAmbiguous"]) record[field] ||= extracted[field];
          }
          if (record.website) { record.websiteAmbiguous = false; record.websiteNeedsConfirmation = false; }
        } else {
          record = extracted;
          this.results.set(record.key, record);
        }
        if (!this.rule && app.phone.international(record.rawPhone)) {
          this.rule = app.phone.infer(record.rawPhone, record.rawPhone);
          if (this.rule) this.panel.detected(this.rule.callingCode);
        }
        pending.push({ record, link: item.link });
      }
      this.updateCounts();
      return pending;
    }
    async detail(record, link, feed, signal) {
      if (!link.isConnected || placeKey(link.href) !== record.key) return null;
      const originalURL = location.href;
      const originalScroll = feed.scrollTop;
      let navigated = false;
      this.internalNavigation = true;
      this.allowedPlace = record.key;
      try {
        this.panel.status(`Checking details for ${record.name || "a listing"}…`);
        app.utils.activate(link);
        navigated = true;
        let detail = await waitFor(() => {
          const result = E.details(record.name);
          return result?.ready && (!record.needsContactDetails || result.contactsReady) ? result : null;
        }, T.detailTimeout, signal);
        if (detail) {
          // Details hydrate incrementally. Wait only while requested data is absent.
          const expectsPhone = !!record.rawPhone || record.needsContactDetails;
          if (!detail.rawPhone && expectsPhone || !detail.website && record.websiteAmbiguous) {
            detail = await waitFor(() => {
              const result = E.details(record.name);
              return result && (expectsPhone ? result.rawPhone : true) && (record.websiteAmbiguous ? result.website : true) ? result : null;
            }, 1500, signal) || detail;
          }
          if (!this.rule && !this.manualCode && detail.rawPhone) {
            this.rule = app.phone.infer(record.rawPhone, detail.rawPhone);
            if (this.rule) this.panel.detected(this.rule.callingCode);
          }
          for (const field of ["name", "category", "rawPhone", "website"]) if (detail[field]) record[field] = detail[field];
          const confirmedAbsence = record.websiteNeedsConfirmation && detail.contactsReady && !detail.websiteAmbiguous;
          record.websiteAmbiguous = !!detail.websiteAmbiguous || !!record.websiteAmbiguous && !detail.website && !confirmedAbsence;
          record.websiteNeedsConfirmation = !!record.websiteNeedsConfirmation && !confirmedAbsence && !detail.website;
          record.needsContactDetails = false;
          record.detailChecked = true;
          record.needsDetail = false;
        } else {
          this.warn("Some listing details did not load. Their missing fields remain blank.");
          record.detailChecked = true;
        }
        return detail;
      } finally {
        // Never undo the user's navigation. An intentional Stop is safe to restore.
        const userChanged = this.stopReason && !this.stopReason.startsWith("Stopped.");
        if (navigated && !userChanged) {
          const back = [...document.querySelectorAll(S.back)].find(visible);
          if (back) app.utils.activate(back);
          else if (location.href !== originalURL) history.back();
          try {
            let lastActivation = Date.now();
            const restored = await waitFor(() => {
              const candidate = E.findFeed();
              const stillOpen = E.details(record.name);
              const originalPlace = originalURL.includes('/maps/place/') ? placeKey(originalURL) : '';
              const currentPlace = location.pathname.includes('/maps/place/') ? placeKey(location.href) : '';
              const originalView = currentPlace === originalPlace;
              // Maps may lazily initialize the close-button controller on its
              // first interaction. Retry while this same detail remains open.
              if (back?.isConnected && (stillOpen || currentPlace === record.key) && Date.now() - lastActivation >= 400) {
                app.utils.activate(back);
                lastActivation = Date.now();
              }
              return candidate && candidate.querySelector(S.placeLink) && !stillOpen && originalView ? candidate : null;
            }, signal.aborted ? 1000 : T.detailTimeout, signal.aborted ? undefined : signal);
            if (restored) restored.scrollTop = originalScroll;
            else if (!signal.aborted) throw new Error("Maps did not return to the results list. The collected listings can still be downloaded. Return to your search and run again.");
          } finally { this.internalNavigation = false; this.allowedPlace = ""; }
        } else { this.internalNavigation = false; this.allowedPlace = ""; }
      }
    }
    async enrich(pending, feed, signal) {
      for (const { record } of pending) {
        if (signal.aborted) throw app.utils.abortError();
        const sample = !this.manualCode && !this.rule && !this.sampleAttempted && !!record.rawPhone;
        const needsDetail = record.needsDetail && !record.detailChecked;
        if (!sample && !needsDetail) continue;
        // Maps can replace or recycle cards while a detail panel is open.
        // Resolve the current link by place identity before each navigation.
        const currentFeed = E.findFeed() || feed;
        const current = E.cards(currentFeed).find(({ link }) => placeKey(link.href) === record.key);
        if (!current) continue;
        const local = record.rawPhone;
        if (sample) this.sampleAttempted = true;
        const detail = await this.detail(record, current.link, currentFeed, signal);
        if (sample && detail?.rawPhone) {
          this.rule = app.phone.infer(local, detail.rawPhone);
          if (this.rule) this.panel.detected(this.rule.callingCode);
        }
        this.updateCounts();
      }
    }
    async start(options) {
      if (this.running) return;
      if (!E.findFeed() && (document.querySelector(S.consent)
        || [...document.querySelectorAll(S.noResults)].some(visible)
        || location.pathname.includes("/maps/place/") && [...document.querySelectorAll(S.detailHeading)].some(visible))) {
        this.panel.status(E.issue());
        return;
      }
      let manualCode;
      try {
        if (!options.profession || !options.city) throw new Error("Fill in the profession and city before starting. These become the CSV columns and file name.");
        manualCode = app.phone.code(options.countryCode);
      } catch (error) { this.panel.warning(error.message); return; }
      this.options = Object.freeze({ ...options });
      this.manualCode = manualCode;
      this.rule = manualCode ? { callingCode: manualCode, source: "manual" } : null;
      this.sampleAttempted = false;
      this.results.clear();
      this.ads = new Set();
      this.warnings.clear();
      this.stopReason = "";
      this.internalNavigation = false;
      this.initialQuery = app.utils.committedQuery();
      this.initialInput = app.utils.searchText();
      this.initialURL = location.href;
      this.controller = new AbortController();
      const signal = this.controller.signal;
      this.running = true;
      this.panel.running(true);
      this.panel.warning("");
      this.panel.counts(0, 0);
      this.panel.status("Waiting for the Maps results list…");
      const started = Date.now();
      let finished = false;
      try {
        let feed = await waitFor(() => {
          const candidate = E.findFeed();
          if (!candidate && (document.querySelector(S.consent) || [...document.querySelectorAll(S.noResults)].some(visible))) throw new Error(E.issue());
          return candidate;
        }, T.initialTimeout, signal);
        if (!feed) throw new Error(E.issue());
        let idle = 0;
        let emptyPasses = 0;
        while (!signal.aborted) {
          if (Date.now() - started > T.maxRun) {
            this.warn("This run reached the 10-minute limit. A slow connection or changed layout may have prevented completion; download the partial results or try again.");
            break;
          }
          feed = E.findFeed();
          if (!feed) {
            feed = await waitFor(() => E.findFeed(), T.detailTimeout, signal);
            if (!feed) throw new Error("The results list disappeared. Your collected listings are ready to download. Return to your search and try again.");
          }
          const previous = this.results.size;
          const pending = this.collect(feed);
          if (!pending.length) emptyPasses++; else emptyPasses = 0;
          const blank = [...this.results.values()].filter(record => !record.name).length;
          if (this.results.size >= 3 && blank / this.results.size > 0.5) throw new Error("Google Maps layout may have changed: most business names could not be read. Update the selectors before relying on this export.");
          await this.enrich(pending, feed, signal);
          feed = E.findFeed() || feed;
          if (this.results.size > previous) idle = 0;
          const end = [...feed.querySelectorAll(S.end)].some(visible);
          if (end && pending.length) {
            // Opening details can replace the list or load its final batch.
            // Read any new cards before accepting the end marker.
            const unseen = E.cards(feed).some(({ link }) => {
              const key = placeKey(link.href);
              const record = this.results.get(key);
              return !this.ads.has(key) && (!record || record.needsDetail && !record.detailChecked);
            });
            if (unseen) continue;
            finished = true;
            break;
          }
          const beforeScroll = feed.scrollTop;
          const height = feed.scrollHeight;
          feed.scrollTop = Math.min(height, beforeScroll + Math.max(400, feed.clientHeight * 0.85));
          this.panel.status("Collecting listings and loading more results…");
          await sleep(T.scrollSettle, signal);
          const grew = feed.scrollHeight > height;
          const moved = feed.scrollTop > beforeScroll + 1;
          const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 8;
          if (!grew && (atBottom || !moved) && this.results.size === previous) {
            if (![...feed.querySelectorAll(S.busy)].some(visible)) idle++;
            else idle = 0;
            if (idle >= T.idleAttempts) {
              if (!this.results.size && emptyPasses) throw new Error(this.ads.size ? "Only sponsored listings were found. Try a different profession or city." : E.issue());
              this.warn("No new listings loaded after several retries. This may be the end of the list or a slow connection; try again if the count seems low.");
              finished = true;
              break;
            }
            // A fresh scroll event gives Maps another chance after delayed responses.
            feed.scrollTop = Math.max(0, feed.scrollTop - 2);
            feed.scrollTop = feed.scrollHeight;
            await sleep(T.idleRetry, signal);
          }
        }
        if (!this.results.size) throw new Error("No business listings were found. Try a different profession or city, and check that Maps shows a results list.");
        if (!signal.aborted) this.panel.status(`${finished ? "Finished" : "Partial run"}. ${this.records().records.length} listings collected. Maps usually shows at most about 120 results per search; use narrower searches for more coverage.`);
      } catch (error) {
        if (error.name === "AbortError") this.panel.status(this.stopReason || "Stopped. Your collected listings are ready to download.");
        else this.panel.status(error.message || "Something went wrong while reading Maps. You can download the listings already collected and try again.");
      } finally {
        const { records, unresolved } = this.records();
        if (unresolved) this.warn(`${unresolved} phone number${unresolved === 1 ? "" : "s"} could not be converted to international format and remain as shown. ${manualCode ? "Check the country code and rerun." : "Enter a country code and run again."}`);
        const ambiguous = [...this.results.values()].filter(record => record.websiteAmbiguous).length;
        if (ambiguous) this.warn(`${ambiguous} website link${ambiguous === 1 ? "" : "s"} could not be read. These listings are excluded from the businesses-without-website export.`);
        this.running = false;
        this.panel.running(false);
        this.panel.downloadable(records.length > 0 || signal.aborted);
        this.updateCounts();
      }
    }
    download() {
      if (this.running || !this.options) return;
      try {
        const records = this.records().records.filter(record => !(this.options.onlyWithoutWebsite && record.websiteAmbiguous));
        app.csv.download(records, this.options);
      } catch { this.panel.warning("The CSV download could not start. Check your browser's download settings and click Download CSV again."); }
    }
  }
  app.Runner = Runner;
})();
