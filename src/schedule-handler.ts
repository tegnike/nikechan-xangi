import type { ChatInputCommandInteraction, Message } from 'discord.js';
import {
  Scheduler,
  parseScheduleInput,
  formatScheduleList,
  SCHEDULE_SEPARATOR,
  type Platform,
} from './scheduler.js';
import { splitScheduleContent, getTypeLabel } from './message-utils.js';
import { DISCORD_MAX_LENGTH, DISCORD_SAFE_LENGTH } from './constants.js';

export interface SchedulerConfig {
  enabled: boolean;
  startupEnabled: boolean;
  timezone?: string;
}

export async function handleScheduleCommand(
  interaction: ChatInputCommandInteraction,
  scheduler: Scheduler,
  schedulerConfig?: SchedulerConfig
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  switch (subcommand) {
    case 'add': {
      const input = interaction.options.getString('input', true);
      const parsed = parseScheduleInput(input);
      if (!parsed) {
        await interaction.reply({
          content:
            '❌ 入力を解析できませんでした\n\n' +
            '**対応フォーマット:**\n' +
            '• `30分後 メッセージ` — 相対時間\n' +
            '• `15:00 メッセージ` — 時刻指定\n' +
            '• `毎日 9:00 メッセージ` — 毎日定時\n' +
            '• `毎週月曜 10:00 メッセージ` — 週次\n' +
            '• `cron 0 9 * * * メッセージ` — cron式',
          ephemeral: true,
        });
        return;
      }

      try {
        const targetChannel = parsed.targetChannelId || channelId;
        const schedule = scheduler.add({
          ...parsed,
          channelId: targetChannel,
          platform: 'discord' as Platform,
        });

        const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
        const typeLabel = getTypeLabel(schedule.type, {
          expression: schedule.expression,
          runAt: schedule.runAt,
          intervalMs: schedule.intervalMs,
          isolated: schedule.isolated,
          channelInfo,
          timezone: schedulerConfig?.timezone,
        });

        await interaction.reply(
          `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
        );
      } catch (error) {
        await interaction.reply({
          content: `❌ ${error instanceof Error ? error.message : 'エラーが発生しました'}`,
          ephemeral: true,
        });
      }
      return;
    }

    case 'list': {
      const schedules = scheduler.list();
      const content = formatScheduleList(schedules, schedulerConfig);
      if (content.length <= DISCORD_MAX_LENGTH) {
        await interaction.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        await interaction.reply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      }
      return;
    }

    case 'remove': {
      const id = interaction.options.getString('id', true);
      const removed = scheduler.remove(id);
      await interaction.reply(
        removed ? `🗑️ スケジュール \`${id}\` を削除しました` : `❌ ID \`${id}\` が見つかりません`
      );
      return;
    }

    case 'toggle': {
      const id = interaction.options.getString('id', true);
      const schedule = scheduler.toggle(id);
      if (schedule) {
        const status = schedule.enabled ? '✅ 有効' : '⏸️ 無効';
        await interaction.reply(`${status} に切り替えました: \`${id}\``);
      } else {
        await interaction.reply(`❌ ID \`${id}\` が見つかりません`);
      }
      return;
    }
  }
}

export async function handleScheduleMessage(
  message: Message,
  prompt: string,
  scheduler: Scheduler,
  schedulerConfig?: SchedulerConfig
): Promise<void> {
  const args = prompt.replace(/^!schedule\s*/, '').trim();
  const channelId = message.channel.id;

  // !schedule (引数なし) or !schedule list → 一覧（全件表示）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if (content.length <= DISCORD_MAX_LENGTH) {
      await message.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule remove <id|番号> [番号2] [番号3] ...
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) {
      await message.reply('使い方: `!schedule remove <ID または 番号> [番号2] ...`');
      return;
    }

    const schedules = scheduler.list();
    const deletedIds: string[] = [];
    const errors: string[] = [];

    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) {
            errors.push(`番号 ${num} は範囲外`);
            return null;
          }
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index);

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      } else {
        errors.push(`ID ${target.id} が見つからない`);
      }
    }

    const remaining = scheduler.list();
    let response = '';
    if (deletedIds.length > 0) {
      response += `✅ ${deletedIds.length}件削除しました\n\n`;
    }
    if (errors.length > 0) {
      response += `⚠️ エラー: ${errors.join(', ')}\n\n`;
    }
    response += formatScheduleList(remaining, schedulerConfig);
    if (response.length <= DISCORD_MAX_LENGTH) {
      await message.reply(response.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(response, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule toggle <id|番号>
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) {
      await message.reply('使い方: `!schedule toggle <ID または 番号>`');
      return;
    }

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        await message.reply(`❌ 番号 ${indexNum} は範囲外です（1〜${schedules.length}）`);
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if (schedule) {
      const status = schedule.enabled ? '✅ 有効化' : '⏸️ 無効化';
      const all = scheduler.list(channelId);
      const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
        SCHEDULE_SEPARATOR,
        ''
      );
      await message.reply(`${status}しました: ${targetId}\n\n${listContent}`);
    } else {
      await message.reply(`❌ ID \`${targetId}\` が見つかりません`);
    }
    return;
  }

  // !schedule add <input> or !schedule <input> (addなしでも追加)
  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    await message.reply(
      '❌ 入力を解析できませんでした\n\n' +
        '**対応フォーマット:**\n' +
        '• `!schedule 30分後 メッセージ`\n' +
        '• `!schedule 15:00 メッセージ`\n' +
        '• `!schedule 毎日 9:00 メッセージ`\n' +
        '• `!schedule 毎週月曜 10:00 メッセージ`\n' +
        '• `!schedule cron 0 9 * * * メッセージ`\n' +
        '• `!schedule list` / `!schedule remove <ID>`'
    );
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      isolated: schedule.isolated,
      channelInfo,
      timezone: schedulerConfig?.timezone,
    });

    await message.reply(
      `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
    );
  } catch (error) {
    await message.reply(`❌ ${error instanceof Error ? error.message : 'エラーが発生しました'}`);
  }
}

/** AI応答内の !schedule コマンドを実行 */
export async function executeScheduleFromResponse(
  text: string,
  sourceMessage: Message,
  scheduler: Scheduler,
  schedulerConfig?: SchedulerConfig
): Promise<void> {
  const args = text.replace(/^!schedule\s*/, '').trim();
  const channelId = sourceMessage.channel.id;
  const channel = sourceMessage.channel;

  // list コマンド（全件表示）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if ('send' in channel) {
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // remove コマンド（複数対応）
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) return;

    const schedules = scheduler.list();
    const deletedIds: string[] = [];

    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) return null;
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index);

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      }
    }

    if ('send' in channel && deletedIds.length > 0) {
      const remaining = scheduler.list();
      const content = `✅ ${deletedIds.length}件削除しました\n\n${formatScheduleList(remaining, schedulerConfig)}`;
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // toggle コマンド
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) return;

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        if ('send' in channel) {
          await (channel as { send: (content: string) => Promise<unknown> }).send(
            `❌ 番号 ${indexNum} は範囲外です（1〜${schedules.length}）`
          );
        }
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if ('send' in channel) {
      if (schedule) {
        const status = schedule.enabled ? '✅ 有効化' : '⏸️ 無効化';
        const all = scheduler.list(channelId);
        const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
          SCHEDULE_SEPARATOR,
          ''
        );
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `${status}しました: ${targetId}\n\n${listContent}`
        );
      } else {
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `❌ ID \`${targetId}\` が見つかりません`
        );
      }
    }
    return;
  }

  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    console.log(`[xangi] Failed to parse schedule input: ${input}`);
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      isolated: schedule.isolated,
      channelInfo,
      timezone: schedulerConfig?.timezone,
    });

    if ('send' in channel) {
      await (channel as { send: (content: string) => Promise<unknown> }).send(
        `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
      );
    }
  } catch (error) {
    console.error('[xangi] Failed to add schedule from response:', error);
  }
}
