import { useEffect, useRef, useState } from "react";
import { useLocale } from "./i18n";
import { COLORS } from "./theme";

// Inline editor that replaces a message's rendered body while its author is editing it. Shared
// by Chat.tsx and Operator.tsx. Same key contract as Composer.tsx: Enter saves, Shift+Enter
// inserts a newline, and the isComposing guard keeps the Enter that confirms a
// Korean/Japanese/Chinese IME composition from also saving. Escape cancels.
export default function EditBox({ initial, onSave, onCancel }: {
  initial: string;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);

  async function save() {
    if (saving) return;
    if (!value.trim() || value === initial) return onCancel();
    setSaving(true);
    try {
      await onSave(value);
    } finally {
      setSaving(false);
    }
  }

  return (
    // Rows are clickable (they open the thread) — clicks inside the editor must not bubble.
    <div onClick={(e) => e.stopPropagation()} style={{ border: `1px solid ${COLORS.lineStrong}`, borderRadius: 10, background: COLORS.fill, padding: "8px 10px", cursor: "auto" }}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        style={{
          width: "100%", border: "none", outline: "none", resize: "none", background: "transparent",
          color: COLORS.text, font: "400 13.5px/1.5 inherit", padding: 0,
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
        <button onClick={onCancel} style={{ height: 26, padding: "0 12px", border: `1px solid ${COLORS.lineStrong}`, borderRadius: 999, background: "transparent", color: COLORS.fg2, font: "500 12px/1 inherit", cursor: "pointer" }}>
          {t("취소")}
        </button>
        <button onClick={save} disabled={saving} style={{ height: 26, padding: "0 12px", border: 0, borderRadius: 999, background: COLORS.orange, color: COLORS.onAccent, font: "700 12px/1 inherit", cursor: "pointer", opacity: saving ? 0.6 : 1 }}>
          {t("저장")}
        </button>
      </div>
    </div>
  );
}

export function EditedMark() {
  const { t } = useLocale();
  return <span style={{ fontSize: 11, color: COLORS.dim }}>({t("수정됨")})</span>;
}
