/** Claude Code子プロセス用の環境変数を返す（ネスト検出を回避） */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}
