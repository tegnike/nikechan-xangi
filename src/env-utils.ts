/** Claude Code子プロセス用の環境変数を返す（ネスト検出を回避） */
export function cleanEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  env.XANGI_SESSION = '1';
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  return env;
}
