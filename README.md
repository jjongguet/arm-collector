# arm-collector

Agent Reliability Monitor(ARM)용 데이터 수집 클라이언트다. Claude Code·Codex 실행의 최소 실행 증거를 수집해 본인의 ARM 서버로 전송한다. raw prompt·소스 코드·출력·절대경로는 수집하지 않으며, allowlist에 등록된 typed metadata만 담아 HTTPS로 보낸다.

## 프라이버시 원칙

- raw prompt·소스/args·출력·절대경로·PII를 저장·전송하지 않는다. 메모리에서 bounded 파싱 후 allowlisted typed metadata(HMAC 식별자 포함)만 로컬 spool과 전송 본문에 남긴다.
- provider(Claude/Codex) 자격증명을 수집·사용하지 않는다.
- 기기 토큰은 서버에 hash만 저장되고, pairing 코드는 1회용이다. revoke 시 즉시 거부된다.
- 로컬 개인 상태 디렉터리는 0700/0600 권한으로 만들고 symlink를 거부한다.

## 설치

Node ≥ 24.15 환경이 필요하다.

```sh
git clone https://github.com/jjongguet/arm-collector.git
cd arm-collector
npm ci
```

## ARM 서버 연결

`--origin`에는 본인이 사용하는 ARM 서버의 정확한 origin을 직접 넣는다. 이 값은 사용자 입력 변수이며 이 저장소에 기본 origin은 내장돼 있지 않다. `--approve-origin` 없이는 어떤 origin과도 연결하지 않는다.

```sh
ARM_STATE="$HOME/.agent-reliability-monitor/private"
ARM_ORIGIN="https://YOUR_MONITOR_ORIGIN"  # 본인 ARM 서버 origin으로 교체

npm run collector -- connect --origin "$ARM_ORIGIN" --approve-origin --dir "$ARM_STATE"
# 출력 JSON의 code를 ARM 웹 대시보드에서 프로젝트를 선택해 승인한 뒤 다음으로 이어진다
npm run collector -- redeem --dir "$ARM_STATE"
npm run collector -- status --dir "$ARM_STATE"
```

## 사용법

### Claude Code 프로젝트 opt-in 설치

`setup`은 변경 사항을 먼저 미리보기로 출력하고, `--apply`를 붙여야 실제로 프로젝트에 Stop hook을 설치한다. hook은 실행마다 이벤트를 표준입력으로 `receive --host claude-code`에 전달하고, `receive`는 이를 로컬 spool에 쌓는다.

```sh
npm run collector -- setup --host claude-code --project /absolute/path/to/your/project           # 미리보기
npm run collector -- setup --host claude-code --project /absolute/path/to/your/project --apply   # 실제 적용
```

### 전송과 상태 확인

spool에 쌓인 이벤트는 opt-in 명령으로만 전송된다.

```sh
npm run collector -- flush --dir "$ARM_STATE"    # spool의 이벤트를 ARM 서버로 전송
npm run collector -- status --dir "$ARM_STATE"   # 연결·spool 상태 확인
```

관측 공백이 있으면 로컬 `report`의 D1·D2도 서버와 같이 `unknown`으로 남는다. 전송 성공이나 같은 기기의 토큰 회전은 공백을 없애지 않는다. 공백이 있는 상태 디렉터리를 다른 기기·프로젝트·origin에 다시 연결하면 이전 수신 확인(ACK)을 재사용하지 않고 새 목적지에 관측 공백을 알린다. 같은 목적지의 재시도는 원래 이벤트 바이트를 유지한다. 새 연결이나 빈 대기열을 과거 관측 복구·현재 온라인·테스트 성공으로 해석하지 않는다.

### Codex opt-in fixture 프로브

Codex는 수동 hook 설치 없이 opt-in exec wrapper로만 실행한다. `codex-fixture`는 통제된 소유 fixture 프로브로, 완료 주장과 실제 테스트 결과의 모순을 의도적으로 만들어 수집 경로를 검증한다.

```sh
npm run collector -- codex-fixture --opt-in --dir "$ARM_STATE"            # 실패 케이스 프로브
npm run collector -- codex-fixture --opt-in --passing --dir "$ARM_STATE"  # 통과 케이스 프로브
```

기타 명령: `report`, `worker --opt-in`, `rotate`, `disconnect`. 전체 목록은 `npm run collector`로 확인한다.

### 고정 ATM 격리 profile

`isolated-test --opt-in --project <owned-worktree>`는 macOS arm64의 고정 Node
24.15.0 바이너리와 Seatbelt로 승인된 ATM 17파일 closure의 전체 테스트 5건만 실행한다.
일반 프로젝트 실행기가 아니며, 보호된 테스트·manifest·source 변경은 거부한다.
읽기·보호된 쓰기·TCP/Unix socket·fork 거부 canary와 cleanup을 실제 확인한다.
`NODE_TAP_ISOLATED_V1`은 일반 Codex 명령 전사와 별개다. `isolatedClaimEvent()`는
동일 프로세스의 진짜 관측·동일 collector·현재 source·30초 freshness만 수용한다.
복제된 JSON·gap·stale·skip은 `unknown`; 5/5 통과도 일반 정확성 보증은 아니다.
CLI 영수증은 모델이 수리를 했거나 테스트를 통과했다고 주장했다는 증거가 아니다.

공개 저장소에 private ATM 소스는 포함하지 않는다. 호스트 검증 시
`ARM_REAL_PROJECT_ROOT`에 명시적으로 소유한 고정 ATM worktree를 지정한다.
없으면 해당 단일 실호스트 테스트가 사유와 함께 skip되며, skip은 실측 완료가 아니다.
`artifacts/source-sync-t04b.json`에는 최종 ARM producer의 7파일 내용 해시를 기록한다.
이는 내용 동기화 증거이며 모델 실행·공개 서비스 출시 인증이 아니다.

## 검증

```sh
npm ci --ignore-scripts
npm run check   # strict tsc --noEmit
npm test        # node --test (core + collector + heldout 40 케이스)
npm run build   # tsc -p tsconfig.build.json → dist/
```

`npm run build`는 `packages/**/*.ts`를 `dist/`로 JavaScript 컴파일한다. 상대 `.ts` import는 `.js`로 재작성되므로 결과물은 Node ≥ 24.15에서 그대로 실행된다. `dist/`는 Git에 커밋하지 않는다.

```sh
node dist/collector/cli.js status --dir "$ARM_STATE"   # 컴파일된 CLI 실행
```

CI(`.github/workflows/ci.yml`)는 `pull_request`와 `main` push에서 `arc-ci` 러너로 위 세 명령만 실행한다. 테스트는 임시 디렉터리 fixture와 대체 `fetch`만 사용하며, 실제 사용자 hook 설치, provider 자격증명 읽기, 실제 ARM 서버 전송을 하지 않는다. CI는 배포나 호스트 데몬/hook 설치를 수행하지 않는다.

## 라이선스

MIT — [LICENSE](LICENSE)
