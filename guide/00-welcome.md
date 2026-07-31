# 워크샵 가이드 (샘플)

이 파일은 자리 표시용 랩 가이드입니다. 배포 전에 `guide/` 폴더의 내용을 실제 워크샵 콘텐츠로
교체하세요 — CDK의 `GuideDeployment` (infra/lib/workshop-chat-stack.ts)가 이 폴더 전체를 S3
가이드 버킷의 `guide/` 프리픽스로 업로드하고, Bedrock Knowledge Base(또는 리전 폴백 시 AI 챗의
프롬프트 주입 경로)가 이 내용을 사용합니다.

## 예시 섹션

- Step 1: 환경 설정
- Step 2: 첫 번째 리소스 생성
- Step 3: 정리

AI 챗에 "Step 2에서 무엇을 해야 하나요?"라고 물어보면 이 문서를 근거로 답변합니다.
