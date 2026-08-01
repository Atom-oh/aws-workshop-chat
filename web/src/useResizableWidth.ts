import { useEffect, useState } from "react";

// Persists to localStorage so a dragged width survives a reload — not required, cheap once
// state exists.
export function useResizableWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return saved >= min && saved <= max ? saved : initial;
  });

  useEffect(() => {
    localStorage.setItem(key, String(width));
  }, [key, width]);

  function onResize(deltaX: number) {
    setWidth((w) => Math.min(max, Math.max(min, w + deltaX)));
  }

  return [width, onResize] as const;
}
