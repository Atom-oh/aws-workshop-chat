# SSM Broadcast + Central Poller — Out of Scope for This Implementation

> **This is a design guide, not implemented code.** The original spec (`docs/SPEC-workshop-chat.md`
> §5) called for a central poller that discovers vended team accounts via AWS Organizations,
> creates Cognito users, and pushes credentials cross-account via SSM `PutParameter`. That flow
> does not exist anywhere in this codebase — no Organizations API calls, no `AssumeRole`, no
> `@aws-sdk/client-ssm` dependency. It was dropped in favor of a simpler model: the app generates
> its own synthetic participant IDs at deploy time (`app/src/auth/credentials.ts`), and the
> operator distributes join links via the console's roster (`GET /api/operator/roster`) or the
> `gen-links` CLI (`scripts/gen-links.ts`).
>
> This document preserves §5's design in full so a future integration with Workshop Studio's
> real account-vending platform has a starting point, rather than starting from nothing. Read
> the **Preconditions** section first — §14 of the spec left three open questions that this
> design depends on, unanswered.

## Why this was dropped

- The synthetic-ID model (§14-3 in the plan history) removes the need to ever call
  `sts:AssumeRole` into a participant's account, which removes an entire cross-account trust
  relationship this app would otherwise have needed at deploy time.
- No email/name/real-account-ID collection (§3.1) is satisfied either way, but the synthetic-ID
  path satisfies it *without* needing Organizations discovery to work at all — it doesn't care
  whether team accounts exist yet, are reachable, or expose `sts:GetCallerIdentity` from inside
  the lab environment.
- The operator's roster/CSV/QR distribution (`app/src/routes/operator.ts`) already solves "get a
  join link to N participants" without SSM. It requires a human distribution step (Slack, chat,
  a slide) instead of `aws ssm get-parameter` running unattended inside every team account — a
  real tradeoff, not a wash, but one this implementation accepted deliberately.

## Preconditions (spec §14 — unresolved)

Before building this, get real answers to:

1. Can the team-account list be obtained via `organizations:ListAccounts`, or must the operator
   inject the list as a deploy parameter?
2. Is the Central → team-account `AssumeRole` role name fixed by the workshop platform, or does
   each workshop choose it?
3. Is the participant's lab environment (IDE/instance) actually *inside* the team account, such
   that `aws sts get-caller-identity` from that environment resolves to the account this app
   would be discovering? If the lab environment is somewhere else, the whole self-identification
   premise in §5.4's join script breaks.

None of these were answered before this implementation pivoted to synthetic IDs. Answer them
before reviving this design — guessing wrong on #3 in particular means participants get a join
script that identifies the wrong account.

---

## Original spec, §5, preserved verbatim

### 5. 참가자 참여 경로 (가장 중요한 요구사항)

**목표: 참가자 타이핑 0회. 링크 클릭 한 번.**
비밀번호를 사람이 옮겨 적는 설계는 500명 규모에서 반드시 실패한다.

#### 5.1 신원 등록: 중앙 생성 → 하위 push (방향 주의)

비밀번호는 **중앙이 생성해서 팀 계정으로 내려보낸다.** 팀 스택이 생성해서 중앙이 read-back 하는 반대 방향은 채택하지 않는다.
(이유: 변경 감지 로직, 크로스어카운트 KMS 복호화 읽기, 진실 원천 이중화가 모두 사라진다.)

```
[중앙 poller]  팀 계정 목록 확인 (Organizations ListAccounts 또는 파라미터로 주입된 계정 목록)
            → Cognito에 미등록인 계정 발견
            → 랜덤 크리덴셜 생성
            → AdminCreateUser + AdminSetUserPassword(permanent)   ※ FORCE_CHANGE_PASSWORD 플로우 회피
            → 해당 팀 계정에 AssumeRole → SSM PutParameter (SecureString)
                 /workshop/chat/credentials
[팀 CFN]     이 앱과 관련해 아무것도 하지 않는다
```

- **멱등성 필수.** 상태 비교는 "Cognito에 이 username이 있는가" 한 줄로 끝나야 한다.
- username = 팀 번호 또는 계정 ID (배포 파라미터로 선택).

#### 5.2 하이브리드: push + reconcile

- **푸시 경로(선택):** 팀 CFN Custom Resource가 중앙 등록 API를 직접 호출 → 지연 0.
  실패해도 팀 스택은 이를 무시한다(`ShouldFail=false` 취급).
- **리컨실 경로(필수):** poller가 **2분 틱**으로 누락분만 메꾼다. 30초는 불필요하게 짧다.
- 늦게 벤딩되는 팀도 자동 합류해야 한다. CFN 간 직접 의존은 금지.

#### 5.3 poller 구현 요구사항

- **계정별 병렬화 필수.** 순차 처리는 500계정에서 한 바퀴가 수 분~수십 분이 된다.
  Step Functions Map(동시성 20~30) 또는 Lambda fan-out 중 하나를 선택하고 이유를 README에 남긴다.
- `AdminCreateUser` 스로틀링 대비 **지수 백오프 + 다음 틱 재시도.** 멱등이므로 자연 복구된다.
- CloudWatch 메트릭 **1개**를 반드시 publish: `RegisteredTeams / DiscoveredAccounts`.
  운영자가 워크샵 시작 전에 보는 유일한 숫자다.

#### 5.4 참가자 측 조인 스크립트 (전원에게 동일한 SSM 문서 1회 브로드캐스트)

```bash
CRED=$(aws ssm get-parameter --name /workshop/chat/credentials \
       --with-decryption --query Parameter.Value --output text)
JOIN="https://<cf-domain>/j?t=$(printf '%s' "$CRED" | base64 | tr -d '\n')"
echo "채팅 참여: $JOIN" | tee ~/JOIN_CHAT.txt
```

- 터미널 출력은 스크롤에 묻히므로 `~/JOIN_CHAT.txt`에도 반드시 쓴다.
- `/j` 는 `t`를 검증하고 세션 쿠키를 심은 뒤 앱으로 리다이렉트한다.
- **폴백 경로 필수:** SSM 에이전트가 안 붙은 참가자는 반드시 1~2명 나온다.
  로그인 화면에 계정 ID + 공용 패스프레이즈(예: `woori-1030`, 슬라이드에 크게 표시) 수동 입력 경로를 남긴다.
  개인별 비밀번호 수동 입력은 500명 규모에서 관리 불가이므로 폴백은 **공용 패스프레이즈 1개**로 한다.
- 첫 로그인 시 계정 ID를 세션에 **sticky binding** 한다. 팀 실습이면 같은 계정 다중 세션을 허용하고 `...7391-2` 로 표시한다.
- 배포 산출물로 조인 URL의 **QR 코드 이미지**를 함께 생성한다(모바일 참가자용).

---

## What this implementation built instead

For comparison, the actual join path (§5.4's UX goal, different §5.1–5.3 mechanism):

- `infra/lambda/credentials-handler.ts` — a CFN Custom Resource, not a poller. Runs once per
  `cdk deploy`/`cdk deploy` re-run, deriving `count` participant IDs from a single seed
  (`app/src/auth/credentials.ts`'s `deriveParticipantId`/`derivePassword`) and calling
  `AdminCreateUser`/`AdminSetUserPassword` idempotently — re-running at the same count creates
  nothing; raising it creates exactly the delta (proven in `app/test/credentials.test.ts`).
- No SSM anywhere. The operator console (`GET /api/operator/roster`, `.../roster.csv`,
  `.../roster/:index/qr.png`) re-derives every participant's join link on demand from the same
  seed, and `scripts/gen-links.ts` does the same from the command line for distribution before
  the console is even reachable.
- The `/j?t=<token>` one-click path and the shared-passphrase fallback are unchanged from §5.4 —
  those two UX requirements survived the mechanism swap intact.
