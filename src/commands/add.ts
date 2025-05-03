// src/commands/add.ts
import { Context, h, Session, Element, $ } from 'koishi'
import { Config } from '../config'
import { TABLE_NAME, GLOBAL_GUILD_ID } from '../database'
import { processAndSaveImage } from '../utils'
import { name as pluginName } from '../index'

export function registerAddCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
  const logger = ctx.logger(pluginName);

  ctx.command(`${pluginName}.add [...answerElements:el]`, '添加图片问答', { authority: 1 })
    .alias('添加图片回复', 'imgadd', '教图')
    .option('probability', '-p <probability:number> 回复概率 (0-1, 默认 1.0)，概率总和大于1会进行归一化', { fallback: 1.0 })
    .option('global', '-g, --global 设为全局问答 (需权限 3)', { authority: 3 })
    .option('targetGuild', '-t, --target-guild <guildId:string> 指定目标群组ID添加问答 (需权限 3)', { authority: 3 })
    .usage(
      h.normalize([
        h.text("使用此命令回复一张图片作为问题，来添加问答。\n"),
        h.text(`用法: ${pluginName}.add [-p 概率] [-g | -t <群号>] `), h.text("<回复内容...>\n"),
        h.text("选项说明:\n"),
        h.text("  -p <概率>: 设置此回答的触发概率 (0-1, 默认 1.0)。\n"),
        h.text("  -g, --global: 将问答设为全局生效 (需要权限 3)。\n"),
        h.text("  -t, --target-guild <群号>: 指定将问答添加到特定群组 (需要权限 3)。\n"),
        h.text("  注意: -g 和 -t 选项不能同时使用。\n"),
        h.text("特殊语法（在回复内容中使用）：\n"),
        h.text("　$$：一个普通的 $ 字符\n"),
        h.text("　$n：换行并分条发送\n"),
        h.text("　$a：@消息发送者\n"),
        h.text("　$m：@机器人自身\n"),
        h.text("　$s：消息发送者的昵称\n"), // 修改：修正上一行末尾的逗号为换行
        h.text("　$g：消息发送者在本群的群名片"), // <- 新增：添加 $g 的说明
      ]).join('')
    )
    .action(async ({ session, options }, answerElements: h[]) => {
      // 过滤掉引用消息本身的内容
      let cleanedAnswerElements: h[] = h.normalize(answerElements || []);
      if (session.quote && session.quote.elements) {
        const quoteElements = h.normalize(session.quote.elements);
        const quoteElementStrings = new Set(quoteElements.map(el => el.toString()));
        cleanedAnswerElements = cleanedAnswerElements.filter(el => !quoteElementStrings.has(el.toString()));
      }

      let targetGuildId: string | null = null;
      let scopeText: string = '';

      // 检查互斥选项
      if (options.global && options.targetGuild) {
        return '不能同时使用 --global (-g) 和 --target-guild (-t) 选项。';
      }

      if (options.global) {
        targetGuildId = GLOBAL_GUILD_ID;
        scopeText = '全局';
      } else if (options.targetGuild) {
        if (!options.targetGuild.trim()) {
            return '使用 -t (--target-guild) 选项时，必须提供有效的群组 ID。';
        }
        targetGuildId = options.targetGuild.trim();
        scopeText = `指定群组 (${targetGuildId})`;
      } else {
        targetGuildId = session.guildId;
        if (!targetGuildId) {
          return '请在群聊环境中使用此命令以添加本群问答，或使用 -g 添加全局问答，或使用 -t <群号> 添加到指定群组。';
        }
        scopeText = '本群';
      }

      if (!session.quote) return '请回复一张图片作为问题来添加/更新问答。';
      const quotedImages = h.select(session.quote.elements || [], 'img');
      if (!quotedImages.length) return '回复的消息中没有找到图片(问题)。';

      const probability = Number(options.probability);
      if (isNaN(probability) || probability < 0 || probability > 1) return '概率必须是 0 到 1 之间的数字。';

      if (quotedImages.length > 1) session.send('提示：检测到多张问题图片，将使用第一张。').catch(logger.warn);
      const questionImageElement = quotedImages[0];
      const questionImageUrl = questionImageElement.attrs.src;
      if (!questionImageUrl) return '无法获取问题图片的地址。';

      let questionImageHash: string;
      let questionImageFilename: string;

      try {
        const questionImageData = await processAndSaveImage(ctx, questionImageUrl, questionImageElement, 'question', resolvedStoragePath);
        questionImageHash = questionImageData.imageHash;
        questionImageFilename = questionImageData.filename;

        if (cleanedAnswerElements.length === 0) {
          return '回答内容不能为空，或者您输入的回答与引用的消息完全相同已被自动过滤。';
        }

        // 处理回答内容中的图片
        const processedAnswerElements: h[] = [];
        for (const element of cleanedAnswerElements) {
          if (element.type === 'img' && element.attrs.src && !element.attrs.src.startsWith('file://')) {
            try {
              const { localUri } = await processAndSaveImage(ctx, element.attrs.src, element, 'answer', resolvedStoragePath);
              processedAnswerElements.push(h.image(localUri));
            } catch (imgProcessingError) {
              logger.error(`[教学] 处理回答图片失败 (范围: ${scopeText}): ${imgProcessingError.message}`);
              return `添加/更新失败：处理回答中的图片时出错 (${imgProcessingError.message})。`;
            }
          } else if (element.type !== 'text' || element.attrs.content?.trim()) {
            processedAnswerElements.push(element);
          }
        }

        if (processedAnswerElements.length === 0) return '处理后的回答内容为空。';
        const serializedAnswer = processedAnswerElements.map(el => el.toString()).join('');

        const existingEntries = await ctx.database.get(TABLE_NAME, {
          guildId: targetGuildId,
          imageHash: questionImageHash,
        }, { fields: ['id', 'answer', 'probability'] });

        const exactMatch = existingEntries.find(e => e.answer === serializedAnswer);

        if (exactMatch) {
          if (exactMatch.probability === probability) {
            return `对于此问题图片，在 ${scopeText} 已存在完全相同的回答及概率 (ID: ${exactMatch.id})。无需操作。`;
          } else {
            await ctx.database.set(TABLE_NAME, { id: exactMatch.id }, { probability });
            const count = await ctx.database.eval(TABLE_NAME, row => $.count(row.id), { guildId: targetGuildId, imageHash: questionImageHash });
            return `操作成功：已将 ${scopeText} 问答 ID ${exactMatch.id} 的概率从 ${exactMatch.probability} 更新为 ${probability}。\n此问题在 ${scopeText} 共有 ${Number(count)} 个回答。`;
          }
        } else {
          const createdRecord = await ctx.database.create(TABLE_NAME, {
            guildId: targetGuildId, imageHash: questionImageHash, imageFilename: questionImageFilename,
            answer: serializedAnswer, probability: probability, creatorId: session.userId, createdAt: new Date(),
          });
          const count = await ctx.database.eval(TABLE_NAME, row => $.count(row.id), { guildId: targetGuildId, imageHash: questionImageHash });
          let answerPreview = serializedAnswer.replace(/<image src="file:.*?\/?>/g, '[本地图片]');
          answerPreview = answerPreview.length > 50 ? answerPreview.substring(0, 50) + '...' : answerPreview;
          return `新问答添加成功 (ID: ${createdRecord.id})。\n范围: ${scopeText}\nQHash: ${questionImageHash.substring(0, 8)}...\n回答预览: ${h.escape(answerPreview)}\n概率: ${probability}\n此问题在 ${scopeText} 现有 ${Number(count)} 个回答。`;
        }
      } catch (error) {
        logger.error(`[教学] 添加/更新问答时出错 (范围: ${scopeText}): ${error.message}`, error);
        const userErrorMessage = error.message.includes('下载') || error.message.includes('保存') || error.message.includes('检查')
          ? '处理图片时出错' : '内部错误';
        return `添加/更新失败：发生错误 (${userErrorMessage})。`;
      }
    });
}
