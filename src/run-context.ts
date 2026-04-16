import { join } from 'path';

export interface AgentExtraEnvOptions {
  workdir?: string;
  entrypoint: string;
  platform: 'discord' | 'slack';
  channelId: string;
  conversationId?: string;
  scheduleId?: string;
}

export function resolveDataDir(workdir?: string): string {
  return process.env.DATA_DIR || join(workdir || process.cwd(), '.xangi');
}

export function buildAgentExtraEnv(options: AgentExtraEnvOptions): Record<string, string> {
  const conversationId = options.conversationId || options.channelId;
  const env: Record<string, string> = {
    XANGI_DATA_DIR: resolveDataDir(options.workdir),
    XANGI_ENTRYPOINT: options.entrypoint,
    XANGI_PLATFORM: options.platform,
    XANGI_CHANNEL_ID: options.channelId,
    XANGI_CONVERSATION_KEY: `${options.platform}:${conversationId}`,
  };

  if (options.scheduleId) {
    env.XANGI_SCHEDULE_ID = options.scheduleId;
  }

  return env;
}
