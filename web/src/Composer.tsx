import { useEffect, useRef } from "react";
import { useLocale } from "./i18n";

// Enter sends, Shift+Enter inserts a newline — except while an IME composition is still in
// progress (Korean/Japanese/Chinese input): the Enter that confirms the current syllable block
// fires as a normal "Enter" keydown too, so without the isComposing guard the first Enter both
// confirms the composition AND sends, dropping/duplicating the last character.
export default function Composer({
  value,
  onChange,
  onSend,
  onPaste,
  onAttachFiles,
  placeholder,
  extra,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onAttachFiles?: (files: FileList) => void;
  placeholder: string;
  extra?: React.ReactNode;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div style={{ border: "1px solid rgba(255,255,255,.14)", borderRadius: 12, background: "rgba(255,255,255,.04)", padding: "10px 12px" }}>
      {extra}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        style={{
          width: "100%", border: "none", outline: "none", resize: "none", background: "transparent",
          color: "#fff", font: "400 13.5px/1.5 inherit", padding: 0,
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <span style={{ fontSize: 11.5, color: "rgba(255,255,255,.45)" }}>{t("Enter로 보내기 · Shift+Enter로 줄바꿈 · `code` · ```코드블록```")}</span>
        <div style={{ display: "flex", gap: 8 }}>
          {onAttachFiles && (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files?.length) onAttachFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                title={t("파일 첨부")}
                style={{ height: 30, width: 30, border: "1px solid rgba(255,255,255,.14)", borderRadius: 999, background: "transparent", color: "rgba(255,255,255,.7)", cursor: "pointer", fontSize: 14 }}
              >
                📎
              </button>
            </>
          )}
          <button
            onClick={onSend}
            style={{ height: 30, padding: "0 14px", border: 0, borderRadius: 999, background: "#FF9900", color: "#0F1B2D", font: "700 12.5px/1 inherit", cursor: "pointer" }}
          >
            {t("보내기")}
          </button>
        </div>
      </div>
    </div>
  );
}
