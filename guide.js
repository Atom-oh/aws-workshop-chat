"use strict";

// Reading and navigation work without JavaScript; this adds copy controls and a current section.
const copyStatus = document.querySelector(".copy-status");
let statusTimeout;

for (const block of document.querySelectorAll("pre")) {
  const code = block.querySelector("code");
  if (!code) continue;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.textContent = "복사";
  button.setAttribute("aria-label", "명령어 복사");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      copyStatus.textContent = "명령어를 복사했습니다.";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      copyStatus.textContent = "명령어를 선택했습니다. Ctrl+C 또는 ⌘C로 복사하세요.";
    }
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => { copyStatus.textContent = ""; }, 4000);
  });
  block.append(button);
}

const navLinks = [...document.querySelectorAll(".sidebar > a")];
const sections = navLinks.map((link) => document.querySelector(link.getAttribute("href")));
let scrollPending = false;
function updateCurrentSection() {
  let active = sections[0];
  const offset = window.innerWidth <= 760 ? 160 : 115;
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= offset) active = section;
  }
  for (const link of navLinks) {
    if (link.getAttribute("href") === `#${active.id}`) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
  scrollPending = false;
}
window.addEventListener("scroll", () => {
  if (!scrollPending) {
    scrollPending = true;
    requestAnimationFrame(updateCurrentSection);
  }
}, { passive: true });
window.addEventListener("resize", updateCurrentSection);
updateCurrentSection();

// Include expandable instructions in print, then restore the reader's choices.
let printOpenedDetails = [];
window.addEventListener("beforeprint", () => {
  printOpenedDetails = [...document.querySelectorAll("details:not([open])")];
  for (const details of printOpenedDetails) details.open = true;
});
window.addEventListener("afterprint", () => {
  for (const details of printOpenedDetails) details.open = false;
  printOpenedDetails = [];
});
