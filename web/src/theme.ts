// Shared theme — same palette across the operator console and participant chat. Values are CSS
// var() references, not literal colors: the actual color per key lives in style.css's :root /
// body[data-theme="projector"] blocks, so toggling `document.body.dataset.theme` repaints every
// call site below with no code change (see Operator.tsx's `toggleTheme`).
export const COLORS = {
  bg: "var(--c-bg)",
  bgDark: "var(--c-bg-2)",
  bg3: "var(--c-bg-3)",
  border: "rgba(var(--c-w),.09)",
  fill: "var(--c-fill)",
  track: "var(--c-track)",
  lineStrong: "var(--c-line-strong)",
  avatarBg: "var(--c-avatar-bg)",
  text: "var(--c-fg)",
  fg2: "var(--c-fg-2)",
  fg3: "var(--c-fg-3)",
  fg4: "var(--c-fg-4)",
  dim: "var(--c-fg-3)",
  orange: "var(--c-accent)",
  orangeHover: "var(--c-accent-h)",
  orangeText: "var(--c-accent-text)",
  onAccent: "var(--c-on-accent)",
  red: "var(--c-danger)",
  redText: "var(--c-danger-text)",
  teal: "var(--c-ok-solid)",
  tealText: "var(--c-ok)",
  focus: "var(--c-focus)",
  shadow: "var(--c-shadow)",
};
