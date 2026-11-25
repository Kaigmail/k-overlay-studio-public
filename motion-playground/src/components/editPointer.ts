/** One captured editing gesture. The initial pointer is the only one allowed to finish it. */
export function editPointer(
  pointerId: number, move: (event: PointerEvent) => void, finish: (commit: boolean) => void,
) {
  const update = (event: PointerEvent) => { if (event.pointerId === pointerId) move(event); };
  const up = (event: PointerEvent) => { if (event.pointerId === pointerId) close(true); };
  const cancel = (event: PointerEvent) => { if (event.pointerId === pointerId) close(false); };
  const blur = () => close(false);
  const key = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(false);
  };
  const close = (commit: boolean) => {
    window.removeEventListener("pointermove", update);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", blur);
    window.removeEventListener("keydown", key, true);
    finish(commit);
  };
  window.addEventListener("pointermove", update);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", blur);
  window.addEventListener("keydown", key, true);
  return close;
}
