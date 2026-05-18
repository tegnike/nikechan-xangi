# xangi

> **A**I **N**EON **G**ENESIS **I**NTELLIGENCE

Claude Code / Codex / Gemini CLI をバックエンドに、Discord から利用できる AI アシスタント。

## Features

- 🤖 マルチバックエンド対応（Claude Code / Codex / Gemini CLI）
- 💬 Discord 対応
- 👤 シングルユーザー設計
- 🐳 Docker対応（コンテナ隔離環境）
- 📚 スキルシステム（スラッシュコマンド対応）
- 🐙 GitHub CLI（gh）対応
- ⏰ スケジューラー機能（cron / 単発 / 起動時タスク）
- 🚀 常駐プロセスモードで高速応答
- 💾 セッション永続化（再起動後も会話継続）

## アーキテクチャ

![Architecture](docs/images/architecture.png)

## Quick Start（Docker）

### 1. 環境変数設定

```bash
cp .env.example .env
```

**最低限の設定（.env）:**
```bash
# Discord Bot Token（必須）
DISCORD_TOKEN=your_discord_bot_token

# 許可ユーザーID（必須）
DISCORD_ALLOWED_USER=123456789012345678
```

> 💡 作業ディレクトリはデフォルトで `./workspace` を使用。変更する場合は `WORKSPACE_PATH` を設定。

> 💡 Discord Bot の作成方法・IDの調べ方は [Discord セットアップ](docs/discord-setup.md) を参照

### 2. 起動

```bash
docker compose up xangi -d --build
```

### 3. Claude Code 認証

```bash
docker exec -it xangi claude
```

表示されたURLをブラウザで開いて認証してください。

### 4. 動作確認

Discord で bot にメンションして話しかけてください。

## 使い方

### 基本
- `@xangi 質問内容` - メンションで反応
- 専用チャンネル設定時はメンション不要

### 主なコマンド

| コマンド | 説明 |
|----------|------|
| `/new` | 新しいセッションを開始 |
| `/clear` | セッション履歴をクリア |
| `/settings` | 現在の設定を表示 |
| `!schedule` | スケジューラー（定期実行・リマインダー） |
| `!discord` | Discord操作（チャンネル送信・検索） |

詳細は [使い方ガイド](docs/usage.md) を参照してください。

## ローカル実行

Docker を使わずにホストで直接実行する方法。

```bash
# Node.js 22+ と使用するAI CLIが必要
# Claude Code: curl -fsSL https://claude.ai/install.sh | bash
# Codex CLI:   npm install -g @openai/codex
# Gemini CLI:  npm install -g @google/gemini-cli

npm install
npm run build
npm start

# 開発時
npm run dev
```

### 自動再起動

xangi は `/restart` コマンドで再起動できます。自動復帰にはプロセスマネージャが必要です。

```bash
# pm2 を使う場合
npm install -g pm2
pm2 start "npm start" --name xangi
pm2 restart xangi  # 手動再起動
pm2 logs xangi     # ログ確認
```

## 環境変数

### 必須

| 変数 | 説明 |
|------|------|
| `DISCORD_TOKEN` | Discord Bot Token |
| `DISCORD_ALLOWED_USER` | 許可ユーザーID |

### オプション

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `AGENT_BACKEND` | エージェントバックエンド（`claude-code` / `codex` / `gemini`） | `claude-code` |
| `WORKSPACE_PATH` | 作業ディレクトリ（ホストのパス） | `./workspace` |
| `AUTO_REPLY_CHANNELS` | メンションなしで応答するチャンネルID（カンマ区切り） | - |
| `AGENT_MODEL` | 使用するモデル | - |
| `SKIP_PERMISSIONS` | デフォルトで許可スキップ | `false` |
| `TIMEOUT_MS` | タイムアウト（ミリ秒） | `300000` |
| `MAX_PROCESSES` | 同時実行プロセス数の上限 | `10` |
| `IDLE_TIMEOUT_MS` | アイドルプロセスの自動終了時間（ミリ秒） | `1800000`（30分） |
| `GH_TOKEN` | GitHub CLI用トークン | - |
| `NIKECHAN_X_WORKER_SELF_TWEET_ENABLED` | `/self-tweet` を独立 `nikechan-x-worker` 経由にする | `false` |
| `NIKECHAN_X_WORKER_URL` | worker HTTP endpoint。設定時は `POST /workflow` を使う | - |
| `NIKECHAN_X_WORKER_COMMAND` | worker CLI command。HTTP未設定時に使う | `nikechan-x-worker` |
| `NIKECHAN_X_WORKER_ARGS` | worker CLI args。`{json}` が WorkflowRequest に置換される | `run --json {json}` |
| `NIKECHAN_X_WORKER_CWD` | worker CLI の作業ディレクトリ | xangi の cwd |

全ての環境変数は [設計ドキュメント](docs/design.md) を参照してください。

### nikechan-x-worker self-tweet

`NIKECHAN_X_WORKER_SELF_TWEET_ENABLED=true` の場合、xangi は Discord/scheduler/approval UI だけを担当し、`/self-tweet` の案生成と修正は `nikechan-x-worker` に委譲します。

Discord から一回だけ情報源タイプを固定する場合は `/self-tweet news` のように指定できます。対応値は `presence`, `daily_life`, `tech`, `news`, `memory`, `random` です。指定しない場合は前回タイプから自動ローテーションします。

Discord で表示された案に対して、番号承認・見送り・修正指示を返信できます。修正指示は `WorkflowRequest.context.feedback` として worker に再送され、Hermes が再生成します。現段階では worker 側の X 投稿は dry-run 専用なので、承認しても xangi は実投稿しません。

## ドキュメント

- [使い方ガイド](docs/usage.md) - 詳細な使い方
- [Discord セットアップ](docs/discord-setup.md) - Bot作成・ID確認方法
- [Slack セットアップ](docs/slack-setup.md) - Slack連携（非推奨）
- [設計ドキュメント](docs/design.md) - アーキテクチャ・全環境変数・マウント設定

## Acknowledgments

xangi のコンセプトは [OpenClaw](https://github.com/openclaw/openclaw) に影響を受けています。

## License

MIT
