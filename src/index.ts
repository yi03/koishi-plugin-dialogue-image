// --- START OF FILE index.ts ---

import { Context, Schema, Session, h, Tables, $, Element, Query, Row } from 'koishi'
import { createHash } from 'crypto'
import { Buffer } from 'buffer'
import { promises as fs } from 'fs';
import path from 'path';
import { URL } from 'url'; // 用于解析 file:// URI

// --- 插件信息 ---
export const name = 'imgqa'
export const using = ['database', 'http']

// --- 数据库扩展 ---
declare module 'koishi' {
  interface Tables {
    image_qa_multi: ImageQAMulti // 图片问答数据表
  }
}
// 图片问答数据结构
export interface ImageQAMulti {
  id: number;           // 自增主键
  guildId: string;        // 群组ID ('' 代表全局作用域)
  imageHash: string;      // 问题图片的MD5哈希
  imageFilename?: string; // 问题图片本地文件名 (用于 'query' 命令等)
  answer: string;         // 回答内容 (序列化的 Element 数组)
  probability: number;    // 触发概率 (0-1)
  creatorId: string;      // 创建者用户ID
  createdAt: Date;        // 创建时间
}

// --- 插件配置 (当前无需配置) ---
export interface Config { }
export const Config: Schema<Config> = Schema.object({})

// --- 常量 ---
const TABLE_NAME = 'image_qa_multi';          // 数据库表名
const IMAGE_STORAGE_DIR_NAME = 'imgqa_images'; // 图片本地存储目录名 (位于 Koishi data 目录)
const GLOBAL_GUILD_ID = '';                   // 全局问答的 guildId 标识
const BATCH_SIZE_FOR_CLEAR = 1000;            // clear 命令数据库查询分页大小
const MIN_HASH_PREFIX_LENGTH = 4;             // imgdelall 命令最短哈希前缀要求
// 清理命令中识别的图片扩展名 (应与 guessExtension 逻辑大致匹配)
const KNOWN_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'];

// --- 辅助函数 ---

/**
 * 从带权重的项目列表中按概率随机选择一项。
 * 如果总概率 > 1，则进行归一化处理。
 * @param items 带 probability 属性的对象数组
 * @returns 选中的项目或 null
 */
function selectWeightedRandom<T extends { probability: number }>(items: T[]): T | null {
  if (!items?.length) return null;
  // 过滤掉概率无效的项目
  const validItems = items.filter(item => item.probability > 0);
  if (!validItems.length) return null;

  // 计算总概率，判断是否需要归一化
  let totalProb = validItems.reduce((sum, item) => sum + item.probability, 0);
  const useNormalizedProb = totalProb > 1;
  const targetProb = useNormalizedProb ? 1 : totalProb; // 目标总概率 (1 或 实际总概率)
  const randomNum = Math.random() * targetProb; // 在目标范围内生成随机数

  let cumulativeProb = 0;
  for (const item of validItems) {
    // 使用归一化概率或原始概率
    const currentProb = useNormalizedProb ? (item.probability / totalProb) : item.probability;
    cumulativeProb += currentProb;
    if (randomNum < cumulativeProb) {
      return item; // 命中当前项
    }
  }
  // 由于浮点数精度问题，可能无法精确命中，返回最后一项作为回退
  return validItems[validItems.length - 1];
}

/**
 * 确保指定目录存在，如果不存在则创建。
 * @param dirPath 目录路径
 * @param logger Koishi logger 实例
 */
async function ensureDirExists(dirPath: string, logger: ReturnType<Context['logger']>) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    // 如果目录已存在 (EEXIST)，则忽略错误，否则记录并抛出其他错误
    if (error.code !== 'EEXIST') {
      logger.error(`创建目录失败: ${dirPath}`, error);
      throw error;
    }
  }
}

/**
 * 基于 MIME 类型、文件名或 URL 猜测文件扩展名。
 * 优先从文件名/URL获取，其次MIME，最后默认.png。
 * @param mimeType 可选的 MIME 类型
 * @param filename 可选的文件名或 URL
 * @returns 文件扩展名 (带.)
 */
function guessExtension(mimeType?: string, filename?: string): string {
  if (filename) {
    // 尝试从 URL 或文件名提取扩展名 (不区分大小写)
    const urlMatch = filename.match(/^https?:\/\/.+?(\.\w+)(?:[?#]|$)/i);
    const fileMatch = filename.match(/\.(\w+)$/);
    const ext = (urlMatch?.[1] || fileMatch?.[1])?.toLowerCase().replace(/^\./, ''); // 获取原始扩展名 (无.)
    // 校验是否为常见图片类型，避免如 '.php?a=1' 误判为 '.php'
    if (ext && /^(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(ext)) {
      return `.${ext}`;
    }
  }
  if (mimeType) {
    const lowerMime = mimeType.toLowerCase();
    if (lowerMime.includes('jpeg') || lowerMime.includes('jpg')) return '.jpg';
    if (lowerMime.includes('png')) return '.png';
    if (lowerMime.includes('gif')) return '.gif';
    if (lowerMime.includes('webp')) return '.webp';
    if (lowerMime.includes('bmp')) return '.bmp';
    if (lowerMime.includes('tiff')) return '.tiff';
  }
  return '.png'; // 默认回退为 .png
}

/**
 * 下载、计算哈希、保存图片（如果本地不存在），并返回哈希、本地文件名和 file:// URI。
 * @param ctx Koishi Context
 * @param imageUrl 图片的原始URL
 * @param imageElement 原始图片元素 (用于获取MIME类型、文件名等信息)
 * @param purpose 用于日志记录的目的 ('question' 或 'answer')
 * @returns Promise 包含哈希、本地文件名和本地 file:// URI 的对象
 * @throws 如果下载、哈希或保存过程中发生错误
 */
async function processAndSaveImage(
  ctx: Context,
  imageUrl: string,
  imageElement: h | undefined,
  purpose: 'question' | 'answer'
): Promise<{ hash: string; filename: string; localUri: string }> {
  const logger = ctx.logger(name);
  const imageStoragePath = path.join(ctx.baseDir, 'data', IMAGE_STORAGE_DIR_NAME);
  let buffer: Buffer;
  let hash: string;
  let filename: string;
  let localImagePath: string;
  let absolutePath: string;

  // 1. 下载图片
  try {
    // 设置超时时间，防止请求卡死
    const response = await ctx.http.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    buffer = Buffer.from(response);
    if (buffer.length === 0) throw new Error(`下载得到空文件`);
  } catch (error) {
    logger.error(`[图片处理] 下载 ${purpose} 图片 (${imageUrl.substring(0, 60)}...) 出错: ${error.message}`, error);
    throw new Error(`下载${purpose}图片失败`);
  }

  // 2. 计算哈希和文件名
  hash = createHash('md5').update(buffer).digest('hex');
  // 尝试从元素属性或URL猜测扩展名
  const ext = guessExtension(imageElement?.attrs.type, imageElement?.attrs.file || imageUrl);
  filename = `${hash}${ext}`;
  localImagePath = path.join(imageStoragePath, filename);
  absolutePath = path.resolve(localImagePath); // 获取绝对路径用于 file:// URI

  // 3. 检查文件是否存在，仅在不存在时写入
  try {
    await fs.access(localImagePath); // 检查文件是否可访问 (存在)
    // logger.debug(`[图片处理] ${purpose} 图片已存在: ${filename}`); // 文件已存在，无需操作
  } catch (e) {
    // 如果文件不存在 (ENOENT)
    if (e.code === 'ENOENT') {
      try {
        await ensureDirExists(imageStoragePath, logger); // 确保目标目录存在
        await fs.writeFile(localImagePath, buffer);     // 写入文件
        logger.info(`[图片处理] 保存新 ${purpose} 图片: ${filename} (源: ${imageUrl.substring(0, 60)}...)`);
      } catch (writeError) {
        logger.error(`[图片处理] 写入 ${purpose} 图片 (${filename}) 时出错: ${writeError.message}`);
        throw new Error(`保存${purpose}图片文件失败`);
      }
    } else {
      // 其他文件访问错误 (例如权限问题)
      logger.error(`[图片处理] 检查 ${purpose} 图片 (${filename}) 状态时出错: ${e.message}`);
      throw new Error(`检查${purpose}图片文件状态失败`);
    }
  }

  // 4. 生成适用于 Koishi h.image 的 file:// URI
  // 正确处理 Windows 盘符路径 (如 C:\...)，转换为 /C:/...
  const fileUriPath = path.sep === '\\' ? '/' + absolutePath.replace(/\\/g, '/') : absolutePath;
  const localUri = 'file://' + fileUriPath;

  return { hash, filename, localUri };
}

// --- 主要插件逻辑 ---
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name);
  const imageStoragePath = path.join(ctx.baseDir, 'data', IMAGE_STORAGE_DIR_NAME);

  // --- 初始化与模型定义 ---
  ctx.on('ready', async () => {
    try {
      await ensureDirExists(imageStoragePath, logger);
      logger.info(`图片存储目录 '${IMAGE_STORAGE_DIR_NAME}' 已确认或创建。`);
    } catch {
      // 如果 ensureDirExists 中发生无法忽略的错误，它会自行记录
      logger.warn(`无法保证图片存储目录 '${imageStoragePath}' 可访问，图片相关功能可能受限。`);
    }
  });

  // 定义数据库表结构
  ctx.model.extend(TABLE_NAME, {
    id: 'unsigned',         // 自增主键
    guildId: 'string',      // 群组 ID, ''=全局
    imageHash: 'string',    // 问题图片 MD5
    imageFilename: 'string',// 问题图片本地文件名 (可选, 用于查询等)
    answer: 'text',         // 回答内容 (序列化 h 元素)
    probability: 'double',  // 触发概率 (0-1)
    creatorId: 'string',    // 创建者 UID
    createdAt: 'timestamp', // 创建时间
  }, {
    primary: 'id',
    autoInc: true,
    // 索引对查询性能至关重要
    indexes: ['guildId', 'imageHash'],
  });

  // --- 消息监听器 (核心触发逻辑) ---
  ctx.on('message', async (session) => {
    // 忽略机器人自己发的消息、无内容消息、无图片消息
    if (session.userId === session.selfId || !session.content) return;
    const imageElements = h.select(session.elements, 'img');
    if (!imageElements.length) return;

    const currentGuildId = session.guildId;
    // 暂时只处理消息中的第一张图片作为问题
    const imgElement = imageElements[0];
    const imageUrl = imgElement.attrs.src;
    if (!imageUrl) {
      logger.warn(`[消息监听] 收到图片元素但缺少 'src' 属性，已跳过。`);
      return;
    }

    let hash: string;
    try {
      // 1. 获取图片并计算哈希 (必须下载以保证哈希准确性)
      // 注意：每次收到图片都需要下载来计算哈希，因为无法保证URL的持久性或唯一性
      const arrayBuffer = await ctx.http.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) {
          logger.warn(`[消息监听] 下载图片得到空文件: ${imageUrl.substring(0,60)}...`);
          return;
      }
      hash = createHash('md5').update(buffer).digest('hex');

      // 2. 查询数据库 (优先查询本群，其次查询全局)
      let results: ImageQAMulti[] = [];
      let matchScope = 'none'; // 记录匹配来源：'guild', 'global', 'none'

      // 如果在群聊环境，先查本群
      if (currentGuildId) {
        results = await ctx.database.get(TABLE_NAME, { guildId: currentGuildId, imageHash: hash });
        if (results.length > 0) matchScope = 'guild';
      }
      // 如果本群没有找到，或者不在群聊环境，则查询全局
      if (results.length === 0) {
        results = await ctx.database.get(TABLE_NAME, { guildId: GLOBAL_GUILD_ID, imageHash: hash });
        if (results.length > 0) matchScope = 'global';
      }

      // 3. 如果找到匹配项，按概率选择一个回答
      if (results.length > 0) {
        const selectedAnswerData = selectWeightedRandom(results);
        // 如果没有选出有效答案 (例如所有概率为0或随机选择失败)
        if (!selectedAnswerData) return;

        logger.info(`[消息监听] 触发问答 ID ${selectedAnswerData.id} (范围: ${matchScope}, 哈希: ${hash.substring(0, 8)}..., 群: ${currentGuildId ?? '私聊'})`);

        // 4. 解析并处理回答内容中的特殊语法 ($a, $s, $m, $n, $$)
        const rawAnswer = selectedAnswerData.answer;
        const allMessageParts: h[][] = []; // 用于存储被 $n 分割的多个消息段
        let currentMessageElements: h[] = []; // 当前正在构建的消息段
        let currentTextBuffer = ''; // 用于累积文本内容，处理特殊语法
        // 获取发送者和机器人的名称，提供回退
        const senderName = session.author?.name || session.author?.nick || session.username || session.userId || '用户';
        const botName: string = session.bot.user?.name || session.bot.user?.nick || session.selfId;

        const parsedAnswerElements = h.parse(rawAnswer); // 先将存储的字符串解析为元素数组

        // 将累积的文本缓冲区转换为 h.text 元素并添加到当前消息段
        const flushTextBuffer = () => {
          if (currentTextBuffer) {
            // 使用 h.parse 处理可能存在的转义字符，然后合并
            currentMessageElements.push(...h.parse(currentTextBuffer));
            currentTextBuffer = '';
          }
        };

        for (const element of parsedAnswerElements) {
          if (element.type === 'text' && element.attrs.content) {
            let content = element.attrs.content;
            // 正则匹配特殊语法: $$、$a、$s、$m、$n (使用 (?<!\\) 避免匹配已被转义的，如 \\$a)
            const regex = /(\$\$)|(?<!\\)\$a|(?<!\\)\$s|(?<!\\)\$m|(?<!\\)\$n/g;
            let lastIndex = 0; // 记录上一次匹配结束的位置
            let match: RegExpExecArray | null;

            while ((match = regex.exec(content)) !== null) {
              // 添加匹配前的普通文本到缓冲区
              if (match.index > lastIndex) currentTextBuffer += content.substring(lastIndex, match.index);

              // 处理匹配到的特殊语法
              if (match[1] === '$$') currentTextBuffer += '$'; // $$ 替换为单个 $
              else if (match[0] === '$a') { flushTextBuffer(); currentMessageElements.push(h.at(session.userId, { name: senderName })); } // @发送者
              else if (match[0] === '$s') currentTextBuffer += senderName; // 发送者昵称
              else if (match[0] === '$m') { flushTextBuffer(); currentMessageElements.push(h.at(session.selfId, { name: botName })); } // @机器人
              else if (match[0] === '$n') { // 换条消息发送
                flushTextBuffer(); // 处理完当前缓冲区
                if (currentMessageElements.length > 0) allMessageParts.push([...currentMessageElements]); // 保存当前消息段
                currentMessageElements = []; // 开始新的消息段
              }
              lastIndex = regex.lastIndex; // 更新下次匹配的起始位置
            }
            // 添加最后一个匹配项之后的普通文本
            if (lastIndex < content.length) currentTextBuffer += content.substring(lastIndex);

          } else {
            // 非文本元素或内容为空的文本元素
            flushTextBuffer(); // 先处理文本缓冲区
            currentMessageElements.push(element); // 直接添加非文本元素
          }
        }
        flushTextBuffer(); // 处理循环结束后剩余的文本缓冲区
        if (currentMessageElements.length > 0) allMessageParts.push(currentMessageElements); // 保存最后一段消息

        // 5. 依次发送所有消息段
        for (const messagePart of allMessageParts) {
          if (messagePart.length > 0) {
            try {
              // 发送前 normalize 以确保格式正确
              await session.send(h.normalize(messagePart));
            } catch (sendError) {
              logger.error(`[消息监听] 发送消息段出错: ${sendError.message}`);
              // 可以选择是继续发送后续段落还是停止
            }
          }
        }
        return; // 成功处理，结束监听器函数的执行

      } // end if (results.length > 0)
    } catch (error) {
      logger.error(`[消息监听] 处理图片问答时出错 (哈希: ${hash?.substring(0,8) ?? '未知'}, 源URL: ${imageUrl.substring(0, 60)}..., 群: ${currentGuildId ?? '私聊'}): ${error.message}`);
      // 一般不建议向用户发送错误提示，避免刷屏
    }
  });

  // --- 管理命令 ---

  // 添加/更新图片问答 (imgqa.teach)
  ctx.command(`${name}.teach`, '添加图片问答 (可设全局)', { authority: 1 })
    .alias('添加图片回复', 'imgadd', '教图')
    .option('probability', '-p <probability:number> 回复概率 (0-1, 默认 1.0)，若概率总和超过 1 将被标准化。', { fallback: 1.0 })
    .option('global', '-g, --global 设为全局问答 (需权限 3)', { authority: 3 })
    .usage(
      `使用此命令回复一张图片来添加或更新问答。\n` +
      `用法: imgadd <回复内容> [-p 概率] [-g]\n` +
      `特殊语法：$$ (普通$), $n (分条发送), $a (@发送者), $s (发送者昵称), $m (@机器人)`
    )
    .action(async ({ session, options }) => {
      const isGlobal = !!options.global; // 标记是否设为全局
      const currentGuildId = session.guildId; // 当前群组ID

      // 检查作用域和执行环境
      if (!isGlobal && !currentGuildId) return '添加本群问答需在群聊环境中使用。使用 -g 选项可添加全局问答。';
      // 确定目标 guildId (全局用空字符串，否则用当前群号)
      const targetGuildId = isGlobal ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobal ? "全局" : `本群`; // 用于反馈消息

      // 检查输入格式：是否回复了消息，回复的消息中是否有图片
      if (!session.quote) return '请回复一张图片作为问题来添加/更新问答。';
      const quotedImages = h.select(session.quote.elements || [], 'img');
      if (!quotedImages.length) return '回复的消息中没有找到图片(问题)。';

      // 校验概率值
      const probability = Number(options.probability);
      if (isNaN(probability) || probability < 0 || probability > 1) return '概率必须是 0 到 1 之间的数字。';

      // 如果回复了多张图，提示用户并使用第一张
      if (quotedImages.length > 1) session.send('提示：检测到多张问题图片，将使用第一张。').catch(logger.warn);
      const questionImageElement = quotedImages[0];
      const questionImageUrl = questionImageElement.attrs.src;
      if (!questionImageUrl) return '无法获取问题图片的地址。';

      let questionImageHash: string;
      let questionImageFilename: string;

      try {
        // 1. 处理问题图片 (下载、计算哈希、保存到本地)
        const questionImageData = await processAndSaveImage(ctx, questionImageUrl, questionImageElement, 'question');
        questionImageHash = questionImageData.hash;
        questionImageFilename = questionImageData.filename; // 保存文件名，用于 query 命令

        // 2. 提取并处理回答内容 (移除命令调用部分)
        let answerInputElements: h[] = h.normalize(session.elements || []); // 获取用户输入的回答内容
        if (answerInputElements.length > 0) {
          let firstElement = answerInputElements[0];
          // 情况 1: 处理开头的 @机器人
          if (firstElement.type === 'at' && firstElement.attrs.id === session.selfId && answerInputElements.length > 1) {
            answerInputElements.shift(); // 移除@元素
            firstElement = answerInputElements[0]; // 重新评估第一个元素
          }
          // 情况 2: 处理命令名称 (可能在 @机器人 被移除后)
          if (firstElement?.type === 'text' && firstElement.attrs.content) {
            const content = firstElement.attrs.content.trimStart();
            const commandName = session.argv?.command?.name; // 获取主命令名
            const commandAliases = Object.keys(session.argv?.command?._aliases || {}); // 获取所有别名
            const allCommandNames = [commandName, ...commandAliases].filter(Boolean); // 合并并过滤无效值

            for (const cmd of allCommandNames) {
              if (content.toLowerCase().startsWith(cmd.toLowerCase())) {
                const charAfterCommand = content[cmd.length];
                // 确保命令后是空格或字符串结尾，避免误删部分内容
                if (charAfterCommand === undefined || /\s/.test(charAfterCommand)) {
                  const remainingContent = content.substring(cmd.length).trimStart();
                  if (remainingContent) {
                    // 更新第一个文本元素的内容
                    firstElement.attrs.content = remainingContent;
                  } else {
                    // 如果命令后没有内容，则移除该文本元素
                    answerInputElements.shift();
                  }
                  break; // 找到并处理了命令，退出循环
                }
              }
            }
          }
        }
        // 在处理后再次 normalize
        answerInputElements = h.normalize(answerInputElements);

        // 3. 处理回答中的图片 (下载、保存、替换为 file:// URI)
        const processedAnswerElements: h[] = [];
        for (const element of answerInputElements) {
          // 只处理外部图片 (http/https)，保留已是 file:// 的本地图片
          if (element.type === 'img' && element.attrs.src && !element.attrs.src.startsWith('file://')) {
            try {
              // 下载、保存回答中的图片，获取本地 URI
              const { localUri } = await processAndSaveImage(ctx, element.attrs.src, element, 'answer');
              processedAnswerElements.push(h.image(localUri)); // 使用本地 URI 替换原 src
            } catch (imgProcessingError) {
              logger.error(`[教学] 处理回答图片失败: ${imgProcessingError.message}`);
              return `添加/更新失败：处理回答中的图片时出错 (${imgProcessingError.message})。`;
            }
          } else if (element.type !== 'text' || element.attrs.content?.trim()) {
            // 添加非图片元素 或 内容不为空的文本元素
            processedAnswerElements.push(element);
          }
        }

        // 回答内容不能为空
        if (processedAnswerElements.length === 0) return '回答内容不能为空。';

        // 4. 序列化最终的回答元素数组为字符串，用于存储
        const serializedAnswer = processedAnswerElements.map(el => el.toString()).join('');

        // 5. 数据库操作：检查是否存在完全相同的问答，然后更新或创建
        const existingEntries = await ctx.database.get(TABLE_NAME, {
          guildId: targetGuildId,
          imageHash: questionImageHash,
        }, { fields: ['id', 'answer', 'probability'] }); // 只查询必要的字段

        // 查找是否有回答内容和目标回答完全一样的记录
        const exactMatch = existingEntries.find(e => e.answer === serializedAnswer);

        if (exactMatch) {
            // 完全相同的问答已存在
            if (exactMatch.probability === probability) {
                // 连概率都一样，无需操作
                return `对于此问题图片，在 ${scopeText} 已存在完全相同的回答及概率 (ID: ${exactMatch.id})。无需操作。`;
            } else {
                // 回答相同，但概率不同 -> 更新概率
                await ctx.database.set(TABLE_NAME, { id: exactMatch.id }, { probability });
                // 获取更新后该问题在本范围内的回答总数
                const count = await ctx.database.eval(TABLE_NAME, row => $.count(row.id), { guildId: targetGuildId, imageHash: questionImageHash });
                return `操作成功：已将 ${scopeText} 问答 ID ${exactMatch.id} 的概率从 ${exactMatch.probability} 更新为 ${probability}。\n此问题在 ${scopeText} 共有 ${Number(count)} 个回答。`;
            }
        } else {
            // 新的问答或对同一图片的不同回答 -> 创建新记录
            const createdRecord = await ctx.database.create(TABLE_NAME, {
                guildId: targetGuildId,
                imageHash: questionImageHash,
                imageFilename: questionImageFilename, // 存储问题图片的文件名
                answer: serializedAnswer,
                probability: probability,
                creatorId: session.userId, // 记录创建者
                createdAt: new Date(),     // 记录创建时间
            });
            // 获取创建后该问题在本范围内的回答总数
            const count = await ctx.database.eval(TABLE_NAME, row => $.count(row.id), { guildId: targetGuildId, imageHash: questionImageHash });
            // 生成一个安全的回答预览 (替换本地图片标签，并截断)
            let answerPreview = serializedAnswer.replace(/<image src="file:.*?\/?>/g, '[本地图片]');
            answerPreview = answerPreview.length > 50 ? answerPreview.substring(0, 50) + '...' : answerPreview;
            return `新问答添加成功 (ID: ${createdRecord.id})。\n范围: ${scopeText}\nQHash: ${questionImageHash.substring(0, 8)}...\n回答预览: ${h.escape(answerPreview)}\n概率: ${probability}\n此问题在 ${scopeText} 现有 ${Number(count)} 个回答。`;
        }
      } catch (error) {
        logger.error(`[教学] 添加/更新问答时出错 (范围: ${scopeText}, 群: ${currentGuildId}): ${error.message}`, error);
        // 根据错误信息内容向用户提供稍微具体的反馈
        const userErrorMessage = error.message.includes('下载') || error.message.includes('保存') || error.message.includes('处理')
          ? '处理图片时出错'
          : '内部错误';
        return `添加/更新失败：发生错误 (${userErrorMessage})。`;
      }
    });

  // 查看图片问答列表 (imgqa.list)
  ctx.command(`${name}.list`, '查看图片问答列表')
    .alias('图片回复列表', 'imglist', '图列')
    .option('page', '-p <page:natural> 页码 (从 1 开始)', { fallback: 1 })
    .option('size', '-s <size:natural> 每页条数', { fallback: 10 })
    .option('globalOnly', '-G, --global-only 仅显示全局问答')
    .option('guildOnly', '--guild-only 仅显示本群问答 (需在群内使用)')
    .option('all', '-a, --all 查看所有范围的问答 (需权限 3)', { authority: 3 })
    .usage(
      `查看图片问答列表。\n`+
      `默认显示本群+全局（如果在群内）或仅全局（如果在私聊）。可用 -G (仅全局), --guild-only (仅本群), -a (所有,需权限) 筛选。\n`+
      `用法: imglist [-p 页码] [-s 条数] [范围选项]`
    )
    .action(async ({ session, options }) => {
      const currentGuildId = session.guildId;

      // 校验选项组合的合法性
      if (options.all && (options.guildOnly || options.globalOnly)) return '不能同时使用 --all 和 --guild-only 或 --global-only 选项。';
      if (options.guildOnly && !currentGuildId) return '使用 --guild-only 选项需要在群聊环境中使用。';
      if (options.globalOnly && options.guildOnly) return '不能同时使用 --global-only 和 --guild-only 选项。';

      // 处理分页参数
      const limit = Math.max(1, Number(options.size));
      const offset = (Math.max(1, Number(options.page)) - 1) * limit;

      // 根据选项构建数据库查询条件
      const query: Query.Expr<ImageQAMulti> = {};
      let scopeDescription = ""; // 用于反馈消息中的范围描述
      let filterInfo = ""; // 用于反馈消息页脚的过滤信息

      if (options.all) {
        // 查看所有，不需要 guildId 过滤器
        scopeDescription = "所有范围";
        filterInfo = ' (所有范围)';
      } else if (options.globalOnly) {
        query.guildId = GLOBAL_GUILD_ID;
        scopeDescription = "全局";
        filterInfo = ' (仅全局)';
      } else if (options.guildOnly) {
        // 已经在前面检查过 currentGuildId 存在
        query.guildId = currentGuildId!;
        scopeDescription = `本群 (${currentGuildId})`;
        filterInfo = ' (仅本群)';
      } else {
        // 默认情况：如果在群内，查询本群+全局；如果在私聊，仅查询全局
        if (currentGuildId) {
          query.$or = [{ guildId: currentGuildId }, { guildId: GLOBAL_GUILD_ID }];
          scopeDescription = `本群 (${currentGuildId}) 及全局`;
          filterInfo = ' (本群及全局)';
        } else {
          query.guildId = GLOBAL_GUILD_ID;
          scopeDescription = "全局";
          filterInfo = ' (全局)';
        }
      }

      try {
        // 查询数据列表
        const list = await ctx.database.get(TABLE_NAME, query, {
          limit, offset,
          fields: ['id', 'guildId', 'imageHash', 'answer', 'probability'], // 仅选择需要的字段
          sort: { guildId: 'asc', imageHash: 'asc', id: 'asc' } // 定义排序规则，保证结果稳定
        });

        // 查询总条数 (注意 eval 的用法)
        const total = await ctx.database.eval(TABLE_NAME, (row) => $.count(row.id), query);
        const totalNum = Number(total); // 结果需要转为数字

        if (totalNum === 0) return `在 ${scopeDescription} 范围内还没有任何图片问答。`;

        // 格式化输出列表
        const output = list.map(item => {
          // 创建安全的回答预览 (替换图片标签，截断)
          let displayAnswer = item.answer.replace(/<image.*?>/g, '[图片]');
          displayAnswer = displayAnswer.length > 30 ? displayAnswer.substring(0, 30) + '...' : displayAnswer;
          // 显示范围标签
          const scopeLabel = item.guildId === GLOBAL_GUILD_ID ? '全局' : `群:${item.guildId.substring(0, 6)}..`;
          // 格式化单条记录
          return `ID:${item.id} | hash:${item.imageHash.substring(0, 8)} | [${scopeLabel}] | P:${item.probability} | A:${h.escape(displayAnswer)}`;
        }).join('\n');

        // 计算总页数并生成页脚信息
        const totalPages = Math.ceil(totalNum / limit);
        const pageInfo = `第 ${options.page}/${totalPages} 页，共 ${totalNum} 条`;

        return `${scopeDescription} 图片问答列表：\n${output}\n\n${pageInfo}${filterInfo}\n(使用 imgget <ID> 可查询问答的问题图片)`;

      } catch (dbError) {
        logger.error(`[列表] 查询数据库出错: ${dbError.message}`);
        return '查询问答列表时数据库出错。';
      }
    });

  // 删除指定ID(可批量) (imgqa.delete)
  ctx.command(`${name}.delete <IDs:string>`, '删除指定ID(可批量,逗号分隔)的图片问答')
    .alias('删除图片回复', 'imgdel', '删图')
    .option('global', '-g, --global 删除全局问答 (需权限 3)', { authority: 3 })
    .usage(
      `删除指定ID(可批量,逗号分隔)的问答。\n` +
      `默认删除本群。使用 -g 删除全局问答 (需权限)。\n` +
      `用法：imgdel <ID1,ID2,...> [-g]`
    )
    .action(async ({ session, options }, idsString) => {
      const isGlobalDelete = !!options.global;
      const currentGuildId = session.guildId;

      // 校验作用域和环境
      if (!isGlobalDelete && !currentGuildId) return '删除本群问答需在群聊环境。使用 -g 可删除全局问答。';
      const targetGuildId = isGlobalDelete ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobalDelete ? "全局" : "本群";

      if (!idsString) return `缺少参数：问答 ID。用法：imgdel <ID1,ID2,...> ${isGlobalDelete ? '-g' : ''}`;

      // 解析并验证输入的 ID 字符串
      const potentialIds = idsString.split(',').map(s => s.trim()).filter(Boolean);
      const validIds: number[] = [];
      const invalidInputs: string[] = [];
      potentialIds.forEach(idStr => {
        const num = parseInt(idStr, 10);
        if (Number.isInteger(num) && num > 0) { // ID 必须是正整数
          validIds.push(num);
        } else {
          invalidInputs.push(idStr);
        }
      });

      if (invalidInputs.length > 0) return `输入包含无效ID: ${invalidInputs.join(', ')}。ID 应为正整数。`;
      if (validIds.length === 0) return '未提供有效的问答 ID。';

      try {
        // 在执行删除前，先查询这些 ID 在目标作用域内实际存在哪些
        const recordsToDelete = await ctx.database.get(TABLE_NAME, {
          id: { $in: validIds },    // ID 在提供的列表中
          guildId: targetGuildId, // 且属于目标作用域
        }, { fields: ['id'] }); // 只需要 id 字段用于确认

        const idsToDelete = recordsToDelete.map(r => r.id); // 实际将要删除的 ID 列表
        const idsNotFoundInScope = validIds.filter(id => !idsToDelete.includes(id)); // 提供的 ID 中未在目标作用域找到的列表

        if (idsToDelete.length === 0) {
            // 如果所有提供的有效 ID 在目标作用域内都找不到
            return `指定的 ID (${validIds.join(', ')}) 在 ${scopeText} 范围内均未找到。`;
        }

        // 执行删除操作
        const result = await ctx.database.remove(TABLE_NAME, { id: { $in: idsToDelete }, guildId: targetGuildId });
        logger.info(`[删除] 已删除 ${result.removed} 条 ${scopeText} 记录 (IDs: ${idsToDelete.join(', ')}, 范围ID: ${targetGuildId})`);

        // 构建反馈消息
        let response = `已成功删除 ${scopeText} ${result.removed} 条问答 (ID: ${idsToDelete.join(', ')})。`;
        if (idsNotFoundInScope.length > 0) {
          response += `\n以下请求的 ID 未在 ${scopeText} 找到或已被删除: ${idsNotFoundInScope.join(', ')}。`;
        }
        return response;

      } catch (error) {
        logger.error(`[删除] 删除记录失败 (请求IDs: ${validIds.join(',')}, 范围ID: ${targetGuildId}): ${error.message}`);
        return `删除失败：数据库操作出错。`;
      }
    });

  // 删除指定哈希前缀对应的所有问答 (imgqa.delete.all)
  ctx.command(`${name}.delete.all <hashPrefix:string>`, '删除指定问题哈希(或前缀)对应的所有问答')
    .alias('删除图片全部回复', 'imgdelall', '删全图', '清图')
    .option('global', '-g, --global 删除全局问答 (需权限 3)', { authority: 3 })
    .usage(
      `删除指定问题哈希(或其前缀)对应的所有问答。\n` +
      `默认删除本群，使用 -g 删除全局 (需权限)。\n` +
      `为安全起见，至少需提供 ${MIN_HASH_PREFIX_LENGTH} 位十六进制哈希前缀。\n` +
      `用法: imgdelall <哈希或前缀> [-g]`
    )
    .action(async ({ session, options }, hashPrefix) => {
      const isGlobalDelete = !!options.global;
      const currentGuildId = session.guildId;

      // 校验作用域和环境
      if (!isGlobalDelete && !currentGuildId) return '删除本群问答需在群聊环境。使用 -g 可删除全局问答。';
      const targetGuildId = isGlobalDelete ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobalDelete ? "全局" : `本群`;

      // 校验哈希前缀输入
      if (!hashPrefix) return `缺少参数：哈希或前缀。用法：imgdelall <哈希或前缀> ${isGlobalDelete ? '-g' : ''} (至少 ${MIN_HASH_PREFIX_LENGTH} 位)`;
      const targetHashPrefix = hashPrefix.trim().toLowerCase(); // 标准化输入

      if (!/^[0-9a-f]+$/.test(targetHashPrefix)) return `哈希前缀格式无效，应仅包含十六进制字符 (0-9, a-f)。`;
      if (targetHashPrefix.length < MIN_HASH_PREFIX_LENGTH) return `哈希前缀过短，至少需要 ${MIN_HASH_PREFIX_LENGTH} 个十六进制字符以确保安全。`;

      try {
        // 查询所有匹配该哈希前缀的记录 (仅需 imageHash 字段用于判断)
        const queryPrefix = { guildId: targetGuildId, imageHash: { $regex: `^${targetHashPrefix}` } }; // 使用 $regex 进行前缀匹配
        const matchingRecords = await ctx.database.get(TABLE_NAME, queryPrefix, { fields: ['imageHash'] });

        // 获取匹配到的不重复的完整哈希值列表
        const distinctHashes = [...new Set(matchingRecords.map(r => r.imageHash))];

        if (distinctHashes.length === 0) {
            // 没有找到任何匹配项
            return `在 ${scopeText} 未找到问题哈希以 '${targetHashPrefix}' 开头的问答。`;
        } else if (distinctHashes.length === 1) {
            // 前缀唯一确定了一个哈希 - 安全，可以删除
            const fullHashToDelete = distinctHashes[0];
            const deleteQuery = { guildId: targetGuildId, imageHash: fullHashToDelete };
            const result = await ctx.database.remove(TABLE_NAME, deleteQuery);
            logger.info(`[删全图] 已删除 ${result.removed} 条记录 (哈希: ${fullHashToDelete}, 范围ID: ${targetGuildId}, 前缀触发: ${targetHashPrefix})`);
            return `已成功删除 ${scopeText} 范围内，问题哈希 ${fullHashToDelete.substring(0, 12)}... (由前缀 '${targetHashPrefix}' 唯一确定) 的全部 ${result.removed} 条问答。`;
        } else {
            // 前缀匹配到多个不同的哈希 - 不安全，取消操作并提示用户
            const maxHashesToList = 5; // 最多列出几个哈希示例
            const hashList = distinctHashes.map(h => `- ${h.substring(0, 12)}...`).slice(0, maxHashesToList).join('\n');
            let response = `找到 ${distinctHashes.length} 个不同的问题哈希匹配前缀 "${targetHashPrefix}"：\n${hashList}`;
            if (distinctHashes.length > maxHashesToList) response += `\n(还有 ${distinctHashes.length - maxHashesToList} 个未显示)`;
            response += `\n\n为防止误删，操作已取消。请提供更长或完整的哈希以唯一确定目标。`;
            return response;
        }
      } catch (error) {
        logger.error(`[删全图] 处理哈希前缀 ${targetHashPrefix} 时出错 (范围ID: ${targetGuildId}): ${error.message}`);
        return `操作失败：处理哈希前缀时数据库出错。`;
      }
    });

  // 查询问答ID对应的问题图片 (imgqa.query)
  ctx.command(`${name}.query <ID:natural>`, '查询问答ID对应的问题图片 (本群或全局)')
    .alias('查询问答图片', 'imgget', '查图', '图ID')
    .usage(
      `查询指定ID问答的问题图片。\n` +
      `会查找本群及全局范围（如果在群内），或仅全局范围（如果在私聊）。\n` +
      `用法：imgget <ID>`
    )
    .action(async ({ session }, id) => {
      // 校验 ID 参数是否为正整数
      if (id === undefined || id <= 0 || !Number.isInteger(id)) return `缺少或无效的参数：问答 ID (应为正整数)。用法：imgget <ID>`;
      const currentGuildId = session.guildId;

      try {
        // 定义查询范围：当前群组ID（如果存在）和全局ID
        const potentialGuildIds = currentGuildId ? [currentGuildId, GLOBAL_GUILD_ID] : [GLOBAL_GUILD_ID];
        // 查询指定 ID 且在允许范围内的记录
        const records = await ctx.database.get(TABLE_NAME, { id: id, guildId: { $in: potentialGuildIds } });

        if (!records.length) {
            // 如果在允许范围内未找到，检查该 ID 是否存在于其他范围
            const existsAnywhere = await ctx.database.get(TABLE_NAME, { id: id }, { limit: 1, fields: ['guildId'] });
            if (existsAnywhere.length > 0) {
                // ID 存在，但不在当前用户可访问的范围
                return `问答 ID ${id} 存在，但不属于您当前可访问的范围 (本群或全局)。`;
            } else {
                // ID 完全不存在
                return `未找到 ID 为 ${id} 的图片问答记录。`;
            }
        }

        // 如果在群聊且全局和本群都有该ID (理论上不太可能，因为ID是自增主键)，优先选择本群的记录
        const record = records.find(r => r.guildId === currentGuildId) || records[0];
        const scopeText = record.guildId === GLOBAL_GUILD_ID ? "全局" : "本群";
        const filename = record.imageFilename; // 获取记录中保存的文件名
        const imageHash = record.imageHash;
        const hashPrefix = imageHash ? imageHash.substring(0, 8) : '未知'; // 哈希前缀用于显示

        // 检查数据库记录中是否有关联的文件名
        if (!filename) {
            return `找到 ${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...)，但数据库记录中缺少关联的问题图片文件名信息。可能是在旧版本添加的记录。`;
        }

        // 构建本地图片文件的完整路径
        const localImagePath = path.join(imageStoragePath, filename);
        try {
            // 检查本地文件是否实际存在
            await fs.access(localImagePath);

            // 构建用于发送图片的 file:// URI
            const absolutePath = path.resolve(localImagePath);
            // 处理 Windows 路径
            const fileUriPath = path.sep === '\\' ? '/' + absolutePath.replace(/\\/g, '/') : absolutePath;
            const fileUri = 'file://' + fileUriPath;

            // 发送包含图片和信息的回复
            await session.send(h.normalize([
                h.text(`${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...) 的问题图片 (${h.escape(filename)}):`), // h.escape 防止文件名中的特殊字符
                h.image(fileUri) // 发送图片
            ]));
            return; // 成功完成，无需返回文本消息

        } catch (fileError) {
            // 处理文件访问错误
            if (fileError.code === 'ENOENT') {
                // 文件不存在
                logger.warn(`[查询] 问题图片文件未找到 (ID: ${id}, 范围: ${scopeText}, 文件: ${filename})`);
                return `找到 ${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...)，但其对应的问题图片文件 (${h.escape(filename)}) 在服务器存储中未找到。可能已被清理或移动。`;
            } else {
                // 其他文件系统错误 (如权限)
                logger.error(`[查询] 访问问题图片文件出错 (ID: ${id}, 文件: ${filename}): ${fileError.message}`);
                return `找到 ${scopeText} 问答 ID ${id}，但在访问其图片文件 (${h.escape(filename)}) 时服务器遇到错误。`;
            }
        }
      } catch (dbError) {
        logger.error(`[查询] 查询数据库出错 (ID: ${id}): ${dbError.message}`);
        return `查询问答 ID ${id} 时数据库发生错误。`;
      }
    });

  // 清理未引用的图片 (imgqa.clear)
  ctx.command(`${name}.clear`, '清理本地存储中未被引用的图片', { authority: 3 })
    .alias('清理图片缓存', 'imgclear')
    .option('confirm', '-y, --confirm 必须确认执行此危险操作')
    .usage(
      `扫描图片存储目录，删除数据库中不再引用的图片文件。\n` +
      `此操作不可逆，请谨慎！需要权限 3 且必须使用 -y 确认。\n` +
      `用法: imgclear -y`
    )
    .action(async ({ session, options }) => {
      // 必须有确认选项才能执行
      if (!options.confirm) return '危险操作！此命令会永久删除本地图片文件。请添加 -y 或 --confirm 选项确认执行清理。';

      logger.info('[清理] 开始清理未引用的图片...');
      // 提示用户操作正在进行
      session.send('正在扫描数据库记录和本地图片文件，这可能需要一些时间，请稍候...').catch(logger.warn);

      const referencedFilenames = new Set<string>(); // 存储数据库中引用的所有本地文件名
      let filesOnDisk: string[] = [];                // 存储存储目录下的所有文件名
      let deletedCount = 0;                          // 成功删除的文件计数
      let failedToDelete: { filename: string; error: string }[] = []; // 删除失败的文件列表
      let skippedCount = 0;                          // 跳过的非图片文件或目录计数

      try {
        // --- 阶段 1: 扫描数据库，收集所有引用的本地文件名 ---
        logger.info('[清理] 阶段 1: 查询数据库引用的图片文件名...');
        let offset = 0;
        let totalProcessed = 0;
        while (true) {
          // 分批查询数据库，避免一次性加载过多数据导致内存问题
          const batch = await ctx.database.get(TABLE_NAME, {}, {
            limit: BATCH_SIZE_FOR_CLEAR, offset,
            fields: ['id', 'imageFilename', 'answer'] // 添加 'id' 字段用于错误日志记录
          });
          if (batch.length === 0) break; // 没有更多记录了

          for (const record of batch) {
            // 添加问题图片的本地文件名 (如果存在)
            if (record.imageFilename) referencedFilenames.add(record.imageFilename);

            // 解析回答内容，查找其中的 file:// 图片引用
            if (record.answer) {
              try {
                const answerElements = h.parse(record.answer);
                h.select(answerElements, 'img').forEach(img => {
                  const src = img.attrs.src;
                  // 只关心由本插件生成的本地文件 URI
                  if (src?.startsWith('file://')) {
                    try {
                      const url = new URL(src);
                      // 解码 URI 路径并提取文件名
                      // 需要处理 Windows 路径 (如 /C:/...)
                      let imagePath = decodeURIComponent(url.pathname);
                       if (process.platform === 'win32' && imagePath.match(/^\/[a-zA-Z]:\//)) {
                           // 移除 Windows 路径开头的斜杠
                           imagePath = imagePath.substring(1);
                       }
                      const filename = path.basename(imagePath);
                      if (filename) referencedFilenames.add(filename);
                    } catch (uriError) {
                      // 解析单个 URI 失败不应中断整个过程，记录警告
                      logger.warn(`[清理] 解析回答中的 file URI (${src}) 失败: ${uriError.message}`);
                    }
                  }
                });
              } catch (parseError) {
                 // 解析某条记录的回答失败，记录警告并继续处理其他记录
                logger.warn(`[清理] 解析问答记录 answer 失败 (附近记录 ID 可能为 ${record.id ?? '未知'}, 片段: ${record.answer.substring(0, 50)}...): ${parseError.message}`);
              }
            }
          }
          offset += batch.length;
          totalProcessed += batch.length;
          // 对于大型数据库，定期打印进度日志
          if (totalProcessed > 0 && totalProcessed % (BATCH_SIZE_FOR_CLEAR * 10) === 0) {
            logger.info(`[清理] 阶段 1: 已处理 ${totalProcessed} 条数据库记录...`);
          }
        }
        logger.info(`[清理] 阶段 1: 数据库扫描完成，共发现 ${referencedFilenames.size} 个唯一引用的本地图片文件名。`);

        // --- 阶段 2: 读取本地存储目录下的所有文件/目录 ---
        logger.info(`[清理] 阶段 2: 读取本地存储目录 '${imageStoragePath}'...`);
        try {
          await ensureDirExists(imageStoragePath, logger); // 确保目录存在，否则 readdir 会报错
          filesOnDisk = await fs.readdir(imageStoragePath);
          logger.info(`[清理] 阶段 2: 本地存储目录找到 ${filesOnDisk.length} 个文件或目录。`);
        } catch (readDirError) {
          if (readDirError.code === 'ENOENT') {
              // 如果存储目录本身就不存在，则无需清理
              logger.info('[清理] 图片存储目录不存在，无需清理。');
              return '图片存储目录不存在，无需清理。';
          }
          // 其他读取目录错误，需要抛出
          logger.error(`[清理] 读取存储目录 '${imageStoragePath}' 失败: ${readDirError.message}`);
          throw readDirError;
        }

        // --- 阶段 3: 对比并删除未被引用的文件 ---
        logger.info(`[清理] 阶段 3: 对比并删除未引用的图片文件...`);
        // 找出在磁盘上但不在引用集合中的文件
        const filesToDelete = filesOnDisk.filter(filename => !referencedFilenames.has(filename));

        if (filesToDelete.length === 0) {
            logger.info('[清理] 没有找到可清理的未引用图片文件。');
            return '扫描完成，没有找到可清理的未引用图片文件。';
        }
        logger.info(`[清理] 发现 ${filesToDelete.length} 个文件可能未被数据库引用，开始尝试删除...`);

        for (const filename of filesToDelete) {
          const filePath = path.join(imageStoragePath, filename);
          try {
            // 在删除前做额外的安全检查
            const stats = await fs.stat(filePath);
            // 仅删除文件，跳过目录
            if (!stats.isFile()) {
                // logger.debug(`[清理] 跳过非文件项: ${filename}`);
                skippedCount++;
                continue;
            }
            // （可选但推荐）仅删除已知图片扩展名的文件，防止误删其他数据
            const ext = path.extname(filename).toLowerCase();
            if (!KNOWN_IMAGE_EXTENSIONS.includes(ext)) {
                // logger.debug(`[清理] 跳过非图片文件: ${filename}`);
                skippedCount++;
                continue;
            }

            // 执行删除
            await fs.unlink(filePath);
            deletedCount++;
            // 定期打印删除进度
            if (deletedCount > 0 && deletedCount % 100 === 0) {
              logger.info(`[清理] 阶段 3: 已删除 ${deletedCount} 个未引用文件...`);
            }

          } catch (deleteError) {
            // 记录删除失败的文件和原因，然后继续处理下一个
            logger.error(`[清理] 删除文件 ${filename} 失败: ${deleteError.message}`);
            failedToDelete.push({ filename, error: deleteError.message });
          }
        } // 结束遍历待删除文件

        // --- 阶段 4: 报告结果 ---
        logger.info(`[清理] 清理操作完成。成功删除: ${deletedCount}, 删除失败: ${failedToDelete.length}, 跳过: ${skippedCount}`);
        let report = `图片清理完成！\n`;
        report += `- 数据库共引用 ${referencedFilenames.size} 个本地文件。\n`;
        report += `- 本地存储扫描到 ${filesOnDisk.length} 项。\n`;
        report += `- 成功删除未引用图片 ${deletedCount} 个。`;
        if (skippedCount > 0) report += `\n- 跳过 ${skippedCount} 个非图片文件或目录。`;
        if (failedToDelete.length > 0) {
          report += `\n- 删除失败 ${failedToDelete.length} 个 (详情请查看控制台日志)。`;
          logger.warn(`[清理] 有 ${failedToDelete.length} 个文件删除失败，文件名及原因已记录在上方日志。`);
        }
        return report;

      } catch (error) {
        logger.error(`[清理] 清理过程中发生严重错误: ${error.message}`, error.stack);
        return `清理过程中发生严重错误，操作可能未完全执行。详情请查看控制台日志。`;
      }
    });

} // apply 函数结束

// --- END OF FILE index.ts ---