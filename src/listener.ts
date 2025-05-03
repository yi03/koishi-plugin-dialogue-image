// src/listener.ts
import { Context, h, Session } from 'koishi';
import { createHash } from 'crypto';
import { Buffer } from 'buffer';
import { Jimp } from 'jimp';
import { TABLE_NAME, GLOBAL_GUILD_ID, ImageQAMulti } from './database';
import { selectWeightedRandom, isGif } from './utils';
import { name as pluginName } from './index';

export function registerMessageListener(ctx: Context) {
  const logger = ctx.logger(pluginName);

  ctx.on('message', async (session: Session) => {
    if (session.userId === session.selfId || !session.content) {
      return;
    }
    const normalizedElements = h.normalize(session.elements || []);
    if (normalizedElements.length !== 1 || (normalizedElements[0].type !== 'img' && normalizedElements[0].type !== 'face')) {
      return;
    }

    const currentGuildId = session.guildId;
    let imageUrl: string | undefined;
    const firstElement = normalizedElements[0];

    // 提取图片 URL
    if (firstElement.type === 'img') {
      imageUrl = firstElement.attrs.src;
    } else if (firstElement.type === 'face') {
      const imgChild = firstElement.children?.find(child => child.type === 'img');
      imageUrl = imgChild?.attrs.src || firstElement.attrs.url || firstElement.attrs.src;
    }

    if (!imageUrl) {
      logger.warn(`未能提取图片 URL: ${JSON.stringify(firstElement)}`); // 可选保留，用于排查奇怪的元素结构
      return;
    }

    let imageIdentifierHash: string | undefined;
    let hashType: 'MD5' | 'pHash' | 'Unknown' = 'Unknown';
    let buffer: Buffer | undefined;

    try {
      // 下载图片
      const arrayBuffer = await ctx.http.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      buffer = Buffer.from(arrayBuffer);

      if (!buffer || buffer.length === 0) {
        logger.warn('下载的图片为空: %s', imageUrl);
        return;
      }

      // 计算图片哈希 (GIF 用 MD5, 其他尝试 pHash)
      if (isGif(buffer)) {
        imageIdentifierHash = createHash('md5').update(buffer).digest('hex');
        hashType = 'MD5';
      } else {
        try {
          const JimpInstance = (Jimp as any)?.default || Jimp;
          if (typeof JimpInstance?.read !== 'function') {
            logger.error('Jimp.read 不可用！请检查依赖。');
            return; // 无法处理
          }
          const image = await JimpInstance.read(buffer);
          imageIdentifierHash = image.hash(16); // 计算 pHash
        } catch (jimpError) {
          logger.warn('计算 pHash 失败 (%s): %c', imageUrl, jimpError.message);
          return; // pHash 失败则不继续
        }
        hashType = 'pHash';
      }
    } catch (error) {
      // 处理下载或哈希计算过程中的错误
      logger.warn('处理图片时出错 (%s): %c', imageUrl, error.message);
      return;
    }

    if (!imageIdentifierHash) {
      logger.warn('未能计算图片哈希 %s. 类型: %s.', imageUrl, hashType);
      return;
    }
    try {
      // 数据库查询 (群组优先, 然后全局)
      let guildResults: ImageQAMulti[] = [];
      let globalResults: ImageQAMulti[] = [];

      if (currentGuildId) {
        guildResults = await ctx.database.get(TABLE_NAME, { guildId: currentGuildId, imageHash: imageIdentifierHash });
      }
      globalResults = await ctx.database.get(TABLE_NAME, { guildId: GLOBAL_GUILD_ID, imageHash: imageIdentifierHash });

      const combinedResults = [...guildResults, ...globalResults];

      if (combinedResults.length > 0) {
        const validItems = combinedResults.filter(item => item.probability > 0);
        if (!validItems.length) return; // 找到匹配但无有效回复

        // 概率判定
        const totalProb = validItems.reduce((sum, item) => sum + item.probability, 0);
        const triggerRoll = Math.random();
        const triggerThreshold = Math.min(totalProb, 1.0);

        if (triggerRoll < triggerThreshold) {
          const selectedAnswerData = selectWeightedRandom(validItems);
          if (!selectedAnswerData) {
            // logger.warn(`概率满足但未能选出回复项`); // 可选保留
            return;
          }

          // 解析并发送回复
          const rawAnswer = selectedAnswerData.answer;
          const allMessageParts: h[][] = [];
          let currentMessageElements: h[] = [];
          let currentTextBuffer = '';

          const senderName = session.author?.name || session.author?.nick || session.username || session.userId || '用户';
          const senderGroupNick = session.author?.nick || session.author?.name || session.username || session.userId || '成员';
          const botName: string = session.bot.user?.name || session.bot.user?.nick || session.selfId;

          const parsedAnswerElements = h.parse(rawAnswer);

          const flushTextBuffer = () => {
            if (currentTextBuffer) {
              let processedText = currentTextBuffer;
              processedText = processedText.replace(/\$\$/g, '@@TEMP_DOLLAR@@');
              processedText = processedText.replace(/(?<!\\)\$s/g, senderName);
              processedText = processedText.replace(/(?<!\\)\$g/g, senderGroupNick);
              processedText = processedText.replace(/@@TEMP_DOLLAR@@/g, '$');
              currentMessageElements.push(...h.parse(processedText));
              currentTextBuffer = '';
            }
          };

          for (const element of parsedAnswerElements) {
            if (element.type === 'text' && element.attrs.content) {
              let content = element.attrs.content;
              const regex = /(\$a)|(\$m)|(\$n)/g;
              let lastIndex = 0;
              let match: RegExpExecArray | null;

              while ((match = regex.exec(content)) !== null) {
                if (match.index > lastIndex) {
                  currentTextBuffer += content.substring(lastIndex, match.index);
                }
                flushTextBuffer();

                if (match[1] === '$a') {
                  currentMessageElements.push(h.at(session.userId, { name: senderName }));
                } else if (match[2] === '$m') {
                  currentMessageElements.push(h.at(session.selfId, { name: botName }));
                } else if (match[3] === '$n') {
                  if (currentMessageElements.length > 0) {
                    allMessageParts.push([...currentMessageElements]);
                  }
                  currentMessageElements = [];
                }
                lastIndex = regex.lastIndex;
              }
              if (lastIndex < content.length) {
                currentTextBuffer += content.substring(lastIndex);
              }
            } else {
              flushTextBuffer();
              currentMessageElements.push(element);
            }
          }
          flushTextBuffer();
          if (currentMessageElements.length > 0) {
            allMessageParts.push(currentMessageElements);
          }

          // 依次发送所有消息段
          for (const messagePart of allMessageParts) {
            if (messagePart.length > 0) {
              try {
                await session.send(h.normalize(messagePart));
              } catch (sendError) {
                logger.error('发送消息段失败: %c', sendError.message);
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error('数据库查询或发送回复时出错 (%s %s): %c', hashType, imageIdentifierHash?.substring(0, 8), error.message);
    }
  });
}