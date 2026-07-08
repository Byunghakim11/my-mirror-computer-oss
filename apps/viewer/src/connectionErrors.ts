export interface ConnectionIssue {
  readonly action: string
  readonly message: string
  readonly retryable: boolean
}

const ISSUES: Record<string, ConnectionIssue> = {
  AGENT_OFFLINE: {
    action: '집 PC에서 에이전트가 실행 중인지 확인하세요.',
    message: '집 PC 에이전트가 오프라인입니다.',
    retryable: true,
  },
  PEER_OFFLINE: {
    action: '집 PC에서 에이전트가 실행 중인지 확인하세요.',
    message: '집 PC 에이전트가 오프라인입니다.',
    retryable: true,
  },
  BUSY: {
    action: '기존 세션을 종료한 뒤 다시 시도하세요.',
    message: '다른 원격 세션이 사용 중입니다.',
    retryable: true,
  },
  SESSION_BUSY: {
    action: '기존 세션을 종료한 뒤 다시 시도하세요.',
    message: '다른 원격 세션이 사용 중입니다.',
    retryable: true,
  },
  EXPIRED: {
    action: '페이지를 새로 열어 새 연결 권한을 받으세요.',
    message: '연결 권한이 만료되었습니다.',
    retryable: false,
  },
  NOT_ALLOWED: {
    action: '집 PC에서 원격 제어 허용 상태를 확인하세요.',
    message: '집 PC가 원격 제어를 허용하지 않았습니다.',
    retryable: false,
  },
  NETWORK_UNREACHABLE: {
    action: '네트워크와 로컬 signaling 서버 상태를 확인하세요.',
    message: '연결 서버에 도달할 수 없습니다.',
    retryable: true,
  },
  RATE_LIMITED: {
    action: '잠시 기다린 뒤 다시 연결하세요.',
    message: '연결 요청이 너무 잦습니다.',
    retryable: true,
  },
  SIGNALING_HANDSHAKE_FAILED: {
    action: 'signaling 서버, 임시 연결 권한, 기존 Viewer 세션을 확인하세요.',
    message: '연결 요청을 열지 못했습니다.',
    retryable: true,
  },
  SESSION_TICKET_FAILED: {
    action: '로그인 세션이 만료됐을 수 있습니다. 페이지를 새로고침해 다시 로그인하세요.',
    message: '연결 권한(세션 티켓)을 발급받지 못했습니다.',
    retryable: true,
  },
  SESSION_REPLACED: {
    action: '이 기기에서 계속 사용하려면 다시 연결하세요.',
    message: '다른 기기·탭에서 접속하여 이 세션이 종료되었습니다.',
    retryable: true,
  },
  WEBRTC_FAILED: {
    action: '잠시 후 다시 연결하세요. 계속 실패하면 방화벽을 확인하세요.',
    message: '화면 전송 연결에 실패했습니다.',
    retryable: true,
  },
}

export function describeConnectionIssue(
  code: string,
  retryableOverride?: boolean,
): ConnectionIssue {
  const issue = ISSUES[code] ?? {
    action: '잠시 후 다시 연결하세요.',
    message: `연결 오류가 발생했습니다. (${code})`,
    retryable: true,
  }
  return retryableOverride === undefined
    ? issue
    : { ...issue, retryable: retryableOverride }
}
