// src/listener.ts
import { Context, h, Session, $ } from 'koishi'
import { createHash } from 'crypto'
import { Buffer } from 'buffer'
import { TABLE_NAME, GLOBAL_GUILD_ID, ImageQAMulti } from './database'
import { selectWeightedRandom } from './utils'
import { name as pluginName } from './index'

export function registerMessageListener(ctx: Context) {
  const logger = ctx.logger(pluginName);

  ctx.on('message', async (session: Session) => {
    // 忽略机器人自身、空消息、非纯图片消息
    if (session.userId === session.selfId || !session.content) return;
    const normalizedElements = h.normalize(session.elements || []);
    if (normalizedElements.length !== 1 || normalizedElements[0].type !== 'img') return;

    const imgElement = normalizedElements[0];
    const currentGuildId = session.guildId;
    const imageUrl = imgElement.attrs.src;
    if (!imageUrl) return;

    let hash: string | undefined;
    try {
      // 下载并计算图片哈希
      const arrayBuffer = await ctx.http.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) return; // 忽略空图片
      hash = createHash('md5').update(buffer).digest('hex');

    } catch (error) {
      logger.warn(`[消息监听] 处理传入图片 ${imageUrl} 失败: ${error.message}`);
      return;
    }

    try {
      // 查询匹配的问答记录 (优先本群，然后全局)
      let guildResults: ImageQAMulti[] = [];
      let globalResults: ImageQAMulti[] = [];

      if (currentGuildId) {
        guildResults = await ctx.database.get(TABLE_NAME, { guildId: currentGuildId, imageHash: hash });
      }
      globalResults = await ctx.database.get(TABLE_NAME, { guildId: GLOBAL_GUILD_ID, imageHash: hash });

      const combinedResults = [...guildResults, ...globalResults];

      if (combinedResults.length > 0) {
        const validItems = combinedResults.filter(item => item.probability > 0);
        if (!validItems.length) return; // 没有有效概率的项，不触发

        const totalProb = validItems.reduce((sum, item) => sum + item.probability, 0);
        const triggerRoll = Math.random();

        // 进行触发判断 (如果 totalProb >= 1, 则必定触发)
        if (triggerRoll < Math.min(totalProb, 1.0)) {
          const selectedAnswerData = selectWeightedRandom(validItems);
          if (!selectedAnswerData) {
            logger.warn(`[消息监听] 触发判断通过但未选定回答 (Hash: ${hash.substring(0, 8)}, Roll: ${triggerRoll}, TotalProb: ${totalProb})`);
            return;
          }

          const matchScope = selectedAnswerData.guildId === GLOBAL_GUILD_ID ? '全局' : '本群';
          logger.info(`[消息监听] 触发问答 ID ${selectedAnswerData.id} (范围: ${matchScope}, 哈希: ${hash.substring(0, 8)}..., 概率: ${selectedAnswerData.probability})`);

          // 解析并处理回答内容
          const rawAnswer = selectedAnswerData.answer;
          const allMessageParts: h[][] = [];
          let currentMessageElements: h[] = [];
          let currentTextBuffer = '';
          const senderName = session.author?.name || session.author?.nick || session.username || session.userId || '用户';
          const botName: string = session.bot.user?.name || session.bot.user?.nick || session.selfId;
          const parsedAnswerElements = h.parse(rawAnswer);

          const flushTextBuffer = () => {
            if (currentTextBuffer) {
              currentMessageElements.push(...h.parse(currentTextBuffer));
              currentTextBuffer = '';
            }
          };

          // 遍历解析后的元素，处理特殊代码和图片
          for (const element of parsedAnswerElements) {
            if (element.type === 'text' && element.attrs.content) {
              let content = element.attrs.content;
              // 使用正则表达式匹配特殊代码 ($$, $a, $s, $m, $n)
              const regex = /(\$\$)|(?<!\\)\$a|(?<!\\)\$s|(?<!\\)\$m|(?<!\\)\$n/g;
              let lastIndex = 0;
              let match: RegExpExecArray | null;
              while ((match = regex.exec(content)) !== null) {
                // 添加匹配前的文本
                if (match.index > lastIndex) currentTextBuffer += content.substring(lastIndex, match.index);
                // 处理特殊代码
                if (match[1] === '$$') currentTextBuffer += '$'; // $$ -> $
                else if (match[0] === '$a') { flushTextBuffer(); currentMessageElements.push(h.at(session.userId, { name: senderName })); } // $a -> @发送者
                else if (match[0] === '$s') currentTextBuffer += senderName; // $s -> 发送者昵称
                else if (match[0] === '$m') { flushTextBuffer(); currentMessageElements.push(h.at(session.selfId, { name: botName })); } // $m -> @机器人
                else if (match[0] === '$n') { // $n -> 分条发送
                  flushTextBuffer();
                  if (currentMessageElements.length > 0) allMessageParts.push([...currentMessageElements]);
                  currentMessageElements = [];
                }
                lastIndex = regex.lastIndex;
              }
              // 添加最后一个匹配后的文本
              if (lastIndex < content.length) currentTextBuffer += content.substring(lastIndex);
            } else {
              flushTextBuffer();
              currentMessageElements.push(element);
            }
          }
          flushTextBuffer(); // 处理末尾剩余的文本
          if (currentMessageElements.length > 0) allMessageParts.push(currentMessageElements);

          // 分条发送所有消息段
          for (const messagePart of allMessageParts) {
            if (messagePart.length > 0) {
              try {
                await session.send(h.normalize(messagePart));
              } catch (sendError) {
                logger.error(`[消息监听] 发送消息段出错: ${sendError.message}`);
              }
            }
          }
          return; // 已处理，退出
        } else {
          logger.debug(`[消息监听] 图片 ${hash.substring(0, 8)}... 匹配到问答，但未达到触发阈值 (Roll: ${triggerRoll.toFixed(2)}, TotalProb: ${totalProb.toFixed(2)})`);
          return;
        }
      }
      // 没有匹配的问答，不执行任何操作
    } catch (error) {
      logger.error(`[消息监听] 处理图片问答数据库查询或发送时出错 (哈希: ${hash?.substring(0, 8) ?? '未知'}): ${error.message}`);
    }
  });
}
