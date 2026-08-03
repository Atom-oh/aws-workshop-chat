import { useState } from "react";

// A thin draggable divider between two flex panes. `onResize` receives the pointer's per-move
// delta (not the total), so the caller just adds it to whatever width state it owns — this
// component holds no width itself, it only reports movement.
export default function Resizer({ onResize }: { onResize: (deltaX: number) => void }) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setActive(true);
    let lastX = e.clientX;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      const delta = ev.clientX - lastX;
      lastX = ev.clientX;
      onResize(delta);
    }
    function onUp() {
      setActive(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ width: 17, flex: "none", cursor: "col-resize", position: "relative" }}
    >
      <div
        style={{
          position: "absolute", left: 8, top: 0, bottom: 0, width: 1,
          background: hover || active ? "#FF9900" : "rgba(255,255,255,.09)",
          transition: active ? "none" : "background 120ms",
        }}
      />
    </div>
  );
}
