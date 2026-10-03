import type VaultDigestPlugin from "../main";
import type { Subject } from "../intent/types";

/**
 * Make a dashboard row selectable. Shift-click toggles it in and out of the selection (one or many).
 * A plain click still does what it always did (open the note, tick the box).
 */
export function makeSelectable(el: HTMLElement, subject: Subject, plugin: VaultDigestPlugin) {
  el.addClass("vd-selectable");
  el.dataset.vdKey = subject.key;
  if (plugin.intent.selection.has(subject.key)) el.addClass("is-selected");
  // Without this, shift-click also extends the browser's text selection across the page.
  el.addEventListener("mousedown", (e) => {
    if (e.shiftKey) e.preventDefault();
  });
  el.addEventListener(
    "click",
    (e) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation(); // capture phase: don't also follow the link under the cursor
      plugin.intent.selection.toggle(subject);
    },
    true
  );
}
