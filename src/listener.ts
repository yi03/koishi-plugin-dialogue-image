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
    // 忽略机器人自身消息或空内容
    if (session.userId === session.selfId || !session.content) {
      return;
    }
    // 仅处理包含单个图片或表情的消息
    const normalizedElements = h.normalize(session.elements || []);
    if (normalizedElements.length !== 1 || (normalizedElements[0].type !== 'img' && normalizedElements[0].type !== 'face')) {
      return;
    }

    const currentGuildId = session.guildId;
    let imageUrl: string | undefined;
    const firstElement = normalizedElements[0];

    // --- 提取图片 URL ---
    if (firstElement.type === 'img') {
      imageUrl = firstElement.attrs.src;
    } else if (firstElement.type === 'face') {
      const imgChild = firstElement.children?.find(child => child.type === 'img');
      imageUrl = imgChild?.attrs.src || firstElement.attrs.url || firstElement.attrs.src;
    }

    if (!imageUrl) {
      logger.warn(`[图片问答] 未能提取图片 URL: ${JSON.stringify(firstElement)}`);
      return;
    }

    let imageIdentifierHash: string | undefined;
    let hashType: 'MD5' | 'pHash' | 'Unknown' = 'Unknown';
    let buffer: Buffer | undefined;

    try {
      // --- 下载图片 ---
      const arrayBuffer = await ctx.http.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      buffer = Buffer.from(arrayBuffer);

      if (!buffer || buffer.length === 0) {
        logger.warn('[图片问答] 下载的图片为空');
        return;
      }

      // --- 计算图片哈希 (GIF 用 MD5, 其他尝试 pHash) ---
      if (isGif(buffer)) {
        imageIdentifierHash = createHash('md5').update(buffer).digest('hex');
        hashType = 'MD5';
      } else {
        try {
          // Jimp 可能通过 `import Jimp from 'jimp'` 导入，检查 default
          const JimpInstance = (Jimp as any)?.default || Jimp;
          if (typeof JimpInstance?.read !== 'function') {
            logger.error('[图片问答] Jimp.read 不可用！请检查依赖。');
            return; // 无法处理
          }
          const image = await JimpInstance.read(buffer);
          imageIdentifierHash = image.hash(16); // 计算 pHash (base64)
        } catch (jimpError) {
          logger.warn(`[图片问答] 计算 pHash 失败 (可能是不支持的格式或 Jimp 问题): ${jimpError.message}. URL: ${imageUrl}`);
          return; // pHash 失败则不继续
        }
        hashType = 'pHash';
      }
    } catch (error) {
      // 处理下载或哈希计算过程中的错误
      if (error.message?.includes('getaddrinfo ENOTFOUND') || error.message?.includes('timeout') || error.name === 'TimeoutError' || error.response?.status) {
        logger.warn(`[图片问答] 下载图片失败 ${imageUrl}: ${error.message}${error.response?.status ? ` (状态: ${error.response.status})` : ''}`);
      } else {
        logger.error(`[图片问答] 处理图片时出错 ${imageUrl}: ${error.message}`);
      }
      return;
    }

    if (!imageIdentifierHash) {
      logger.warn(`[图片问答] 未能计算图片哈希 ${imageUrl}. 类型: ${hashType}.`);
      return;
    }
    try {
      // --- 数据库查询 (群组优先, 然后全局) ---
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

        // --- 概率判定 ---
        const totalProb = validItems.reduce((sum, item) => sum + item.probability, 0);
        const triggerRoll = Math.random();
        const triggerThreshold = Math.min(totalProb, 1.0); // 总概率上限为 1

        if (triggerRoll < triggerThreshold) {
          const selectedAnswerData = selectWeightedRandom(validItems);
          if (!selectedAnswerData) {
            logger.warn(`[图片问答] 概率满足但未能选出回复项`);
            return;
          }

          // --- 解析并发送回复 ---
          const rawAnswer = selectedAnswerData.answer;
          const allMessageParts: h[][] = []; // 用于存储分段消息 ([[$n]])
          let currentMessageElements: h[] = []; // 当前消息段的元素
          let currentTextBuffer = ''; // 临时存储文本内容以进行变量替换

          // 获取发送者和机器人的名称
          const senderName = session.author?.name || session.author?.nick || session.username || session.userId || '用户';
          const senderGroupNick = session.author?.nick || session.author?.name || session.username || session.userId || '成员'; // 在群组中可能不同
          const botName: string = session.bot.user?.name || session.bot.user?.nick || session.selfId;

          const parsedAnswerElements = h.parse(rawAnswer);

          // 刷新文本缓冲区: 进行变量替换并添加到当前消息段
          const flushTextBuffer = () => {
            if (currentTextBuffer) {
              let processedText = currentTextBuffer;
              // 转义 $$ -> @@TEMP_DOLLAR@@, 替换 $s, $g, 转回 @@TEMP_DOLLAR@@ -> $
              processedText = processedText.replace(/\$\$/g, '@@TEMP_DOLLAR@@');
              processedText = processedText.replace(/(?<!\\)\$s/g, senderName);      // $s -> 发送者昵称/名称
              processedText = processedText.replace(/(?<!\\)\$g/g, senderGroupNick); // $g -> 发送者群名片/昵称/名称 (优先群名片)
              processedText = processedText.replace(/@@TEMP_DOLLAR@@/g, '$');
              currentMessageElements.push(...h.parse(processedText)); // 解析处理后的文本
              currentTextBuffer = '';
            }
          };

          // 遍历解析后的元素
          for (const element of parsedAnswerElements) {
            if (element.type === 'text' && element.attrs.content) {
              // 处理文本内容中的特殊变量: $a, $m, $n
              let content = element.attrs.content;
              const regex = /(\$a)|(\$m)|(\$n)/g; // 匹配 $a, $m, $n
              let lastIndex = 0;
              let match: RegExpExecArray | null;

              while ((match = regex.exec(content)) !== null) {
                // 将变量前的文本加入缓冲区
                if (match.index > lastIndex) {
                  currentTextBuffer += content.substring(lastIndex, match.index);
                }
                // 刷新缓冲区 (处理 $s, $g) 并将处理结果添加到当前消息段
                flushTextBuffer();

                // 处理特殊变量
                if (match[1] === '$a') { // $a -> @用户
                  currentMessageElements.push(h.at(session.userId, { name: senderName }));
                } else if (match[2] === '$m') { // $m -> @机器人
                  currentMessageElements.push(h.at(session.selfId, { name: botName }));
                } else if (match[3] === '$n') { // $n -> 换行 (开始新消息段)
                  if (currentMessageElements.length > 0) {
                    allMessageParts.push([...currentMessageElements]); // 保存当前段
                  }
                  currentMessageElements = []; // 开始新段
                }
                lastIndex = regex.lastIndex;
              }
              // 处理最后一个变量后的文本
              if (lastIndex < content.length) {
                currentTextBuffer += content.substring(lastIndex);
              }
            } else {
              // 非文本元素直接处理之前的文本缓冲区, 然后添加该元素
              flushTextBuffer();
              currentMessageElements.push(element);
            }
          }
          // 处理循环结束后剩余的文本缓冲区
          flushTextBuffer();
          // 添加最后的消息段 (如果非空)
          if (currentMessageElements.length > 0) {
            allMessageParts.push(currentMessageElements);
          }

          // 依次发送所有消息段
          for (const messagePart of allMessageParts) {
            if (messagePart.length > 0) {
              try {
                await session.send(h.normalize(messagePart));
              } catch (sendError) {
                logger.error(`[图片问答] 发送消息段失败: ${sendError.message}`);
              }
            }
          }
          // 成功发送后结束处理
        }
      }
    } catch (error) {
      logger.error(`[图片问答] 数据库查询或发送回复时出错 (${hashType} ${imageIdentifierHash?.substring(0, 8)}): ${error.message}\n${error.stack}`);
    }
  });
}