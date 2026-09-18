export function bindEasterEgg() {
  const trigger = document.querySelector("#under-the-surface");
  if (!trigger) return;
  let clicks = 0;
  let last = 0;
  let dialog;
  function close() {
    if (!dialog) return;
    dialog.close();
    dialog.remove();
    dialog = null;
    document.body.classList.remove("voyage-open");
    trigger.focus();
  }
  trigger.addEventListener("click", () => {
    const now = performance.now();
    clicks = now - last < 4000 ? clicks + 1 : 1;
    last = now;
    if (clicks < 5 || dialog) return;
    clicks = 0;
    dialog = document.createElement("dialog");
    dialog.className = "voyage-dialog";
    dialog.setAttribute("aria-label", "Vessel Surfer");
    const closeButton = document.createElement("button");
    closeButton.className = "voyage-close";
    closeButton.textContent = "Close voyage";
    closeButton.onclick = close;
    const frame = document.createElement("iframe");
    frame.title = "Vessel Surfer";
    frame.src = new URL("./_play/vessel/", import.meta.url).href;
    dialog.append(closeButton, frame);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    document.body.append(dialog);
    document.body.classList.add("voyage-open");
    dialog.showModal();
    closeButton.focus();
  });
  window.addEventListener("message", (event) => {
    if (
      event.origin === location.origin &&
      event.source === dialog?.querySelector("iframe")?.contentWindow &&
      event.data?.type === "close-voyage"
    )
      close();
  });
}
