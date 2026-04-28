import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpStdioClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, PendingRequest>();
  private initialized = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      requestTimeoutMs?: number;
      name?: string;
    } = {}
  ) {}

  async start(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[mcp:${this.options.name ?? this.command}] ${text}`);
    });
    this.proc.on('close', (code) => {
      const error = new Error(`MCP server closed with code ${code}`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.proc = undefined;
      this.initialized = false;
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'xangi',
        version: '0.1.0',
      },
    });
    this.notify('notifications/initialized');
    this.initialized = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.initialized) await this.start();
    return this.request('tools/call', {
      name,
      arguments: args,
    });
  }

  async listTools(): Promise<unknown> {
    if (!this.initialized) await this.start();
    return this.request('tools/list');
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = undefined;
    proc.kill('SIGTERM');
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc) throw new Error('MCP server is not started');

    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    this.writeMessage(payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.proc) throw new Error('MCP server is not started');
    const payload: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    };
    this.writeMessage(payload);
  }

  private writeMessage(payload: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.proc) throw new Error('MCP server is not started');
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) return;

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.handleMessage(line);
    }
  }

  private handleMessage(body: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(body) as JsonRpcResponse;
    } catch {
      console.error(`[mcp:${this.options.name ?? this.command}] invalid JSON response`);
      return;
    }

    if (typeof response.id !== 'number') return;
    const request = this.pending.get(response.id);
    if (!request) return;

    clearTimeout(request.timer);
    this.pending.delete(response.id);

    if (response.error) {
      request.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
    } else {
      request.resolve(response.result);
    }
  }
}
