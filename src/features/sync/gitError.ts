function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientGitNetworkError(error: unknown): boolean {
  return /timed? out|timeout|schannel|ssl|tls|could not resolve host|failed to connect|connection (?:was )?(?:reset|closed)|network is unreachable|unable to access/i.test(
    messageOf(error)
  );
}

export function isUncertainGitAuthError(error: unknown): boolean {
  return /the token in (?:keyring|default) is invalid/i.test(messageOf(error));
}

export function isMissingRemoteRefError(error: unknown): boolean {
  return /couldn.t find remote ref/i.test(messageOf(error));
}

export function describeGitIndexLockError(error: unknown): string | null {
  const message = messageOf(error);
  if (!/index\.lock\b/i.test(message) || !/file exists|another git process|already exists/i.test(message)) return null;
  const path = /["']([^"'\r\n]*index\.lock)["']/i.exec(message)?.[1] ?? ".git/index.lock";
  return `Git 索引锁已存在，可能有 Git 操作正在运行或上次中断留下残留锁。锁文件：${path}。请先确认没有 Git 操作运行，再手动删除该锁文件（不要删除 index），然后重试；若在第四步失败，重新点击「完成接入」。`;
}

export function describeGitError(error: unknown): string {
  const message = messageOf(error);
  const lock = describeGitIndexLockError(message);
  if (lock) return lock;
  if (isUncertainGitAuthError(message)) {
    return `GitHub 认证状态检查失败（暂不能确认 Token 已失效，可能是网络或系统凭据暂时不可用）：${message}`;
  }
  if (
    /authentication failed|could not read username|http (?:401|403)|access denied|permission denied|repository not found/i.test(
      message
    )
  ) {
    return `认证失败：${message}`;
  }
  if (isTransientGitNetworkError(message)) return `与 GitHub 网络连接失败：${message}`;
  return message;
}
