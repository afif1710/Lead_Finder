/* Runs in Maps' MAIN world. Google's lazy interaction controllers need mouse
   events created in the page realm. This bridge only activates a temporarily
   marked button or listing link; it does not read or export business data. */
(() => {
  "use strict";
  if (globalThis.__mapsLeadFinderActivation) return;
  globalThis.__mapsLeadFinderActivation = true;
  document.addEventListener("mlf:activate-button", event => {
    const node = event.target;
    if (!node || !["BUTTON", "A"].includes(node.tagName) || node.getAttribute("data-mlf-activate") !== "true") return;
    node.removeAttribute("data-mlf-activate");
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, button: 0 }));
    }
    node.click();
  });
})();
