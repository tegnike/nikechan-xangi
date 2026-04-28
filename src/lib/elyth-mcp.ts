import { readFileSync } from 'fs';
import { join } from 'path';
import { McpStdioClient } from './mcp-stdio.js';

const WORKDIR = process.env.WORKSPACE_PATH || process.cwd();

interface McpConfig {
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
}

export class ElythMcpClient {
  private client?: McpStdioClient;

  async getInformation(): Promise<unknown> {
    return unwrapToolResult(
      await this.call('get_information', {
        include: [
          'timeline',
          'today_topic',
          'trends',
          'hot_aitubers',
          'active_aitubers',
          'my_metrics',
          'notifications',
          'elyth_news',
        ],
        timeline_limit: 10,
        notifications_limit: 10,
      })
    );
  }

  async getMyPosts(limit = 5): Promise<unknown> {
    return unwrapToolResult(await this.call('get_my_posts', { limit }));
  }

  async createPost(content: string): Promise<unknown> {
    return unwrapToolResult(await this.call('create_post', { content }));
  }

  async createReply(content: string, replyToId: string): Promise<unknown> {
    return unwrapToolResult(
      await this.call('create_reply', {
        content,
        reply_to_id: replyToId,
      })
    );
  }

  async likePost(postId: string): Promise<unknown> {
    return unwrapToolResult(await this.call('like_post', { post_id: postId }));
  }

  async followAituber(handle: string): Promise<unknown> {
    return unwrapToolResult(await this.call('follow_aituber', { handle }));
  }

  async markNotificationsRead(notificationIds: string[]): Promise<unknown> {
    if (!notificationIds.length) return null;
    return unwrapToolResult(
      await this.call('mark_notifications_read', {
        notification_ids: notificationIds,
      })
    );
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) {
      const config = loadElythMcpConfig();
      this.client = new McpStdioClient(config.command, config.args, {
        cwd: WORKDIR,
        env: config.env,
        name: 'elyth',
        requestTimeoutMs: 60000,
      });
    }
    return this.client.callTool(name, args);
  }
}

function loadElythMcpConfig(): { command: string; args: string[]; env: Record<string, string> } {
  const raw = readFileSync(join(WORKDIR, '.mcp.json'), 'utf-8');
  const config = JSON.parse(raw) as McpConfig;
  const elyth = config.mcpServers?.elyth;
  if (!elyth?.command) {
    throw new Error('ELYTH MCP server is not configured in .mcp.json');
  }
  return {
    command: elyth.command,
    args: elyth.args ?? [],
    env: elyth.env ?? {},
  };
}

function unwrapToolResult(result: unknown): unknown {
  const record = asRecord(result);
  if (!record) return result;

  if ('structuredContent' in record && record.structuredContent !== undefined) {
    return record.structuredContent;
  }

  const content = record.content;
  if (Array.isArray(content)) {
    const textParts = content
      .map((item) => {
        const itemRecord = asRecord(item);
        return typeof itemRecord?.text === 'string' ? itemRecord.text : '';
      })
      .filter(Boolean);
    const text = textParts.join('\n').trim();
    if (!text) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
