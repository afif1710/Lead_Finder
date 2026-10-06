(() => {
  "use strict";
  const app = globalThis.MapsLeadFinder;
  class Panel {
    constructor(callbacks) {
      this.host = document.createElement("maps-lead-finder");
      this.host.id = "maps-lead-finder";
      const root = this.host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = app.panelStyle;
      root.append(style);
      const panel = document.createElement("section");
      panel.className = "panel";
      panel.setAttribute("aria-label", "Maps Lead Finder");
      // Static markup only. Scraped text is always assigned through textContent/value.
      panel.innerHTML = `<header><div class="brand"><span class="mark" aria-hidden="true">↗</span><div><h2>Maps Lead Finder</h2><p class="tagline">Search · collect · export</p></div></div><button class="collapse" type="button" aria-label="Collapse panel" aria-expanded="true">−</button></header>
        <div class="body"><p class="intro">Turn this Maps search into a CSV.</p><div class="fields">
          <label>Profession<input id="profession" type="text" placeholder="interior designer" autocomplete="off" maxlength="160"></label>
          <label>City<input id="city" type="text" placeholder="Dubai" autocomplete="off" maxlength="160"></label>
          <label>Country code<input id="code" type="text" placeholder="Auto-detect, or enter +971" autocomplete="off" maxlength="4" inputmode="tel" aria-describedby="code-hint"></label>
        </div><p class="hint" id="code-hint">Leave blank to detect once per search.</p>
        <label class="checkbox"><input id="filter" type="checkbox"><span>Only businesses without a website</span></label>
        <div class="stats" aria-live="polite" aria-atomic="true"><strong id="count">0</strong><span>listings found</span><span class="subcount"><span id="without">0</span> without website</span></div>
        <p class="status" role="status">Search on Maps, check the fields, then click Start.</p><p class="warning" role="alert"></p>
        <div class="buttons"><button id="start" class="primary" type="button">Start</button><button id="stop" class="stop" type="button" hidden>Stop</button><button id="download" class="secondary" type="button" hidden>Download CSV</button></div>
        <p class="footer">Local only · Your data stays in this tab</p></div>`;
      root.append(panel);
      this.root = root;
      this.panel = panel;
      this.$ = selector => root.querySelector(selector);
      this.$("#start").addEventListener("click", () => callbacks.start(this.options()));
      this.$("#stop").addEventListener("click", callbacks.stop);
      this.$("#download").addEventListener("click", callbacks.download);
      this.$(".collapse").addEventListener("click", () => this.collapse(!panel.classList.contains("collapsed")));
      document.body.append(this.host);
    }
    options() {
      return { profession: this.$("#profession").value.trim(), city: this.$("#city").value.trim(), countryCode: this.$("#code").value.trim(), onlyWithoutWebsite: this.$("#filter").checked };
    }
    prefill(query, resetCountry = false) {
      const fields = app.utils.splitSearch(query);
      this.$("#profession").value = fields.profession;
      this.$("#city").value = fields.city;
      if (resetCountry) this.$("#code").value = "";
      this.$("#code-hint").textContent = "Leave blank to detect once per search.";
    }
    running(value) {
      for (const input of this.root.querySelectorAll("input")) input.disabled = value;
      this.$("#start").hidden = value;
      this.$("#stop").hidden = !value;
      this.$("#download").disabled = value;
      if (value) this.$("#download").hidden = true;
    }
    downloadable(value) { this.$("#download").hidden = !value; }
    status(text) { this.$(".status").textContent = text; }
    warning(text) { this.$(".warning").textContent = text; }
    counts(count, without) { this.$("#count").textContent = count; this.$("#without").textContent = without; }
    detected(code) { this.$("#code-hint").textContent = `Detected +${code} for this run. Enter a code above to override on the next run.`; }
    collapse(value) {
      this.panel.classList.toggle("collapsed", value);
      this.$(".collapse").textContent = value ? "+" : "−";
      this.$(".collapse").setAttribute("aria-expanded", String(!value));
      this.$(".collapse").setAttribute("aria-label", value ? "Expand panel" : "Collapse panel");
    }
    show() { this.collapse(false); this.$("#start").focus(); }
  }
  app.Panel = Panel;
})();
