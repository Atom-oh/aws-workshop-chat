import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "ko" | "en";

// Keyed by the original Korean string (not an invented id) — every UI string is written in
// Korean at the call site as `t("...")`, so a translation that hasn't been added yet just
// falls back to showing the Korean text, in either locale. Cheap to keep in sync: grep for
// `t("` calls not covered here.
const DICT: Record<string, string> = {
  // Nav / shared chrome
  "채널": "Channels",
  "도우미": "Assistant",
  "AI 도우미": "AI Assistant",
  "질문 보드": "Questions",
  "AI 도우미 로그": "AI Assistant Log",
  "랩 가이드 문서": "Lab Guide Docs",
  "참여 현황": "Attendance",
  "운영자 전용": "Operator only",
  "로그아웃": "Log out",
  "운영자": "Operator",
  "운영자만 접근할 수 있습니다.": "Only the operator can access this page.",

  // Composer
  "메시지 입력 (붙여넣기 또는 📎로 파일 첨부)": "Type a message (paste an image or attach a file with 📎)",
  "답글 작성": "Write a reply",
  "운영자로 답변…": "Reply as operator…",
  "랩 가이드에 대해 질문하기": "Ask about the lab guide",
  "질문으로 등록": "Post as a question",
  "파일 첨부": "Attach file",
  "보내기": "Send",
  "Enter로 보내기 · Shift+Enter로 줄바꿈 · `code` · ```코드블록```": "Enter to send · Shift+Enter for a newline · `code` · ```code block```",

  // Chat (participant)
  "현재 랩 스텝": "Current lab step",
  "답변은 본인에게만 표시됩니다 · 랩 가이드에 대해 질문하세요": "Answers are visible only to you · ask about the lab guide",
  "아직 질문한 내용이 없습니다.": "You haven't asked anything yet.",
  "답변 생성 중…": "Generating answer…",
  "도움됨": "Helpful",
  "가이드에 없음": "Not in the guide",
  "참고": "References",
  "스레드": "Thread",
  "업보트": "Upvote",
  "해결로 표시": "Mark resolved",
  "📌 공지로 올리기": "📌 Post as announcement",
  "삭제": "Delete",
  "해결": "Resolved",
  "미해결": "Open",
  "아직 답변이 없습니다.": "No replies yet.",
  "링크 복사": "Copy link",
  "링크를 복사했습니다": "Link copied",

  // Operator console
  "Workshop Chat · 운영자": "Workshop Chat · Operator",
  "지금 내보내기": "Export now",
  "내보내는 중…": "Exporting…",
  "다운로드": "Download",
  "마지막 내보내기": "Last export",
  "아직 없음": "Never",
  "업보트 순 · 미해결이 위로 고정됩니다": "Sorted by upvotes · open questions pinned to the top",
  "전체": "All",
  "업보트 상위": "Top upvoted",
  "표시할 질문이 없습니다.": "No questions to show.",
  "메시지 삭제": "Delete message",
  "아직 입장 안 한 참가자": "Not yet joined",
  "확인": "View",
  "질문이 없습니다.": "No questions.",
  "아직 AI 쿼리가 없습니다.": "No AI queries yet.",
  "참가자가 랩 가이드에서 찾지 못한 것의 목록입니다. 엑셀": "A list of what participants couldn't find in the lab guide. Exported as-is to the",
  "시트로 그대로 내보내집니다.": "sheet in the xlsx export.",
  "쿼리": "queries",
  "토큰 사용": "tokens used",
  "매칭 문서 없음": "no matching docs",
  "가이드에 없음 → 사람이 답할 것": "Not in the guide → needs a human answer",
  "랩 가이드 문서 · AI 컨텍스트": "Lab Guide Docs · AI Context",
  "여기 올린 문서만 AI 도우미의 답변 근거로 주입됩니다.": "Only documents uploaded here are injected as context for the AI assistant.",
  "마지막 재인덱싱": "Last reindex",
  "지금 재인덱싱": "Reindex now",
  "사용 중 문서": "active docs",
  "랩 가이드 문서를 여기에 끌어다 놓기": "Drop lab guide documents here",
  "파일 선택": "Choose files",
  "문서": "Document",
  "크기": "Size",
  "상태": "Status",
  "업로드된 문서가 없습니다.": "No documents uploaded.",
  "사용 중": "Active",
  "제외": "Excluded",
  "참여 현황 · 아직 입장 안 한 참가자": "Attendance · not yet joined",
  "입장하지 않은 참가자는 조인 링크를 재전송하세요.": "Resend the join link to participants who haven't joined.",
  "예상 참가자": "Expected",
  "입장 완료": "Joined",
  "미입장": "Not joined",
  "참가자 ID": "Participant ID",
  "링크 재전송": "Resend link",
  "모든 참가자가 입장했습니다.": "Everyone has joined.",
  "워크샵 계정은 언젠가 삭제됩니다. 종료 전 xlsx를 반드시 다운로드하세요.":
    "Workshop accounts will eventually be deleted. Be sure to download the xlsx before it ends.",
  "xlsx 내보내기 완료": "xlsx export complete",
  "해결로 표시했습니다": "Marked resolved",
  "메시지를 삭제했습니다": "Message deleted",
  "문서를 삭제했습니다": "Document deleted",
  "재인덱싱을 시작했습니다": "Reindexing started",
  "업로드 완료 · 재인덱싱이 필요합니다": "Upload complete · reindexing required",
  "조인 링크를 재전송했습니다": "join link resent",
  "step": "step",
  "오류": "Error",
  "읽기 전용": "Read-only",
  "질문 검색": "Search questions",
  "참가자 ID 뒷자리 노출": "Show last digits of participant ID",
  "ID 표시": "Show IDs",
  "답변 없음 — 지금 답해야 함": "No reply yet — needs a response",
  "아카이브 · 읽기 전용": "Archived · read-only",
  "이 채널은 아카이브되어 읽기 전용입니다.": "This channel is archived and read-only.",
  "프롬프트 주입 사용량": "Prompt-injection usage",
  "업로드 실패": "upload failed",
  "프로젝터 가시성 테마 전환": "Toggle projector-visibility theme",
  "프로젝터 모드": "Projector mode",
  "다크 모드": "Dark mode",
  "로그인 링크 복사": "Copy login link",
  "참가자에게 보이지 않음": "not visible to participants",

  // Login
  "참가자 간에는 익명입니다. 운영자는 참가자에게 발급된 참가자 ID를 확인할 수 있습니다.":
    "Participants are anonymous to each other. The operator can look up the participant ID issued to each participant.",
  "ID (참가자 ID 또는 운영자 아이디)": "ID (participant ID or operator username)",
  "없음": "None",
  "최대 50MB, 이미지는 3.75MB": "max 50MB, images 3.75MB",
  "운영": "Ops",
  "비밀번호": "Password",
  "입장": "Enter",
};

function detectDefault(): Locale {
  const saved = localStorage.getItem("wc:locale");
  if (saved === "ko" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

interface LocaleCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (ko: string) => string;
}

const LocaleContext = createContext<LocaleCtx>({ locale: "ko", setLocale: () => {}, t: (ko) => ko });

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(detectDefault);
  useEffect(() => {
    localStorage.setItem("wc:locale", locale);
  }, [locale]);
  const t = (ko: string) => (locale === "en" ? DICT[ko] ?? ko : ko);
  return <LocaleContext.Provider value={{ locale, setLocale, t }}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}

export function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  return (
    <button
      onClick={() => setLocale(locale === "ko" ? "en" : "ko")}
      title="Language / 언어"
      style={{
        height: 30, padding: "0 11px", border: "1px solid rgba(255,255,255,.2)", borderRadius: 999,
        background: "transparent", color: "#fff", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
      }}
    >
      {locale === "ko" ? "EN" : "한국어"}
    </button>
  );
}
