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
  imageFilename?: string; // 问题图片本地文件名 (用于存储和 'query' 命令)
  answer: string;         // 回答内容 (序列化的 Element 数组)
  probability: number;    // 触发概率 (0-1)
  creatorId: string;      // 创建者用户ID
  createdAt: Date;        // 创建时间
}

// --- 常量 ---
const TABLE_NAME = 'image_qa_multi';
const DEFAULT_IMAGE_STORAGE_DIR_NAME = 'imgqa_images'; // 默认图片存储目录名
const GLOBAL_GUILD_ID = '';                   // 全局问答的 guildId 标识
const BATCH_SIZE_FOR_CLEAR = 1000;            // clear 命令数据库查询分页大小
const MIN_HASH_PREFIX_LENGTH = 4;             // imgdelall 命令最短哈希前缀要求
const KNOWN_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']; // 清理命令识别的图片扩展名

// --- 插件配置 ---
export interface Config {
  storagePath: string; // 图片存储路径
}

export const Config: Schema<Config> = Schema.object({
  storagePath: Schema.string()
    .description(`图片存储路径。可以是绝对路径，也可以是相对于 Koishi 数据目录 (data) 的相对路径。`)
    .default(DEFAULT_IMAGE_STORAGE_DIR_NAME),
})

// --- 辅助函数 ---

/** 按概率从带权重的项目列表中随机选择一项 (若总概率>1则归一化) */
function selectWeightedRandom<T extends { probability: number }>(items: T[]): T | null {
  if (!items?.length) return null;
  const validItems = items.filter(item => item.probability > 0);
  if (!validItems.length) return null;

  let totalProb = validItems.reduce((sum, item) => sum + item.probability, 0);
  const useNormalizedProb = totalProb > 1;
  const targetProb = useNormalizedProb ? 1 : totalProb;
  const randomNum = Math.random() * targetProb;

  let cumulativeProb = 0;
  for (const item of validItems) {
    const currentProb = useNormalizedProb ? (item.probability / totalProb) : item.probability;
    cumulativeProb += currentProb;
    if (randomNum < cumulativeProb) {
      return item;
    }
  }
  return validItems[validItems.length - 1]; // 处理浮点精度或边界情况
}

/** 确保目录存在，如果不存在则创建 */
async function ensureDirExists(dirPath: string, logger: ReturnType<Context['logger']>) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') { // 忽略目录已存在的错误
      logger.error(`创建目录失败: ${dirPath}`, error);
      throw error;
    }
  }
}

/** 基于 MIME 类型、文件名或 URL 猜测文件扩展名 */
function guessExtension(mimeType?: string, filename?: string): string {
  if (filename) {
    const urlMatch = filename.match(/^https?:\/\/.+?(\.\w+)(?:[?#]|$)/i);
    const fileMatch = filename.match(/\.(\w+)$/);
    const ext = (urlMatch?.[1] || fileMatch?.[1])?.toLowerCase().replace(/^\./, '');
    // 简单校验是否是常见图片扩展名
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
  return '.png'; // 默认使用 .png
}

/** 下载、计算哈希、保存图片，并返回哈希、文件名和本地 file:// URI */
async function processAndSaveImage(
  ctx: Context,
  imageUrl: string,
  imageElement: h | undefined, // 用于猜测扩展名
  purpose: 'question' | 'answer', // 用于日志记录
  imageStoragePath: string // 保存目录
): Promise<{ hash: string; filename: string; localUri: string }> {
  const logger = ctx.logger(name);
  let buffer: Buffer;
  let hash: string;
  let filename: string;
  let localImagePath: string;
  let absolutePath: string;

  try {
    const response = await ctx.http.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    buffer = Buffer.from(response);
    if (buffer.length === 0) throw new Error(`下载得到空文件`);
  } catch (error) {
    logger.error(`[图片处理] 下载 ${purpose} 图片 (${imageUrl}) 失败: ${error.message}`);
    throw new Error(`下载${purpose === 'question' ? '问题' : '回答'}图片失败`);
  }

  hash = createHash('md5').update(buffer).digest('hex');
  const ext = guessExtension(imageElement?.attrs.type, imageElement?.attrs.file || imageUrl);
  filename = `${hash}${ext}`;
  localImagePath = path.join(imageStoragePath, filename);
  absolutePath = path.resolve(localImagePath);

  // 检查文件是否已存在，不存在则保存
  try {
    await fs.access(localImagePath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      try {
        await ensureDirExists(imageStoragePath, logger);
        await fs.writeFile(localImagePath, buffer);
        logger.info(`[图片处理] 已保存新的 ${purpose} 图片: ${filename}`);
      } catch (writeError) {
        logger.error(`[图片处理] 写入 ${purpose} 图片 (${filename}) 失败: ${writeError.message}`);
        throw new Error(`保存${purpose === 'question' ? '问题' : '回答'}图片文件失败`);
      }
    } else {
      logger.error(`[图片处理] 检查 ${purpose} 图片 (${filename}) 状态失败: ${e.message}`);
      throw new Error(`检查${purpose === 'question' ? '问题' : '回答'}图片文件状态失败`);
    }
  }

  // 生成 file:// URI (处理 Windows 路径)
  const fileUriPath = path.sep === '\\' ? '/' + absolutePath.replace(/\\/g, '/') : absolutePath;
  const localUri = 'file://' + fileUriPath;

  return { hash, filename, localUri };
}

// --- 主要插件逻辑 ---
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name);
  const dataDirPath = path.join(ctx.baseDir, 'data');
  // 解析并确认最终的图片存储路径
  const resolvedStoragePath = path.isAbsolute(config.storagePath)
    ? config.storagePath
    : path.join(dataDirPath, config.storagePath);

  // 插件启动时确保图片存储目录存在
  ctx.on('ready', async () => {
    try {
      await ensureDirExists(resolvedStoragePath, logger);
      logger.info(`图片存储目录已确认: ${resolvedStoragePath}`);
    } catch {
      logger.warn(`无法保证图片存储目录 '${resolvedStoragePath}' 可访问。插件功能可能受影响。`);
    }
  });

  // 扩展数据库表
  ctx.model.extend(TABLE_NAME, {
    id: 'unsigned', guildId: 'string', imageHash: 'string',
    imageFilename: 'string', answer: 'text', probability: 'double',
    creatorId: 'string', createdAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['guildId', 'imageHash'] });

  // --- 消息监听器 ---
  ctx.on('message', async (session) => {
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

  // --- 管理命令 ---

  // 添加/更新图片问答
  ctx.command(`${name}.add [...answerElements:el]`, '添加图片问答', { authority: 1 })
    .alias('添加图片回复', 'imgadd', '教图')
    .option('probability', '-p <probability:number> 回复概率 (0-1, 默认 1.0)，概率总和大于1会进行归一化', { fallback: 1.0 })
    .option('global', '-g, --global 设为全局问答 (需权限 3)', { authority: 3 })
    .usage(
      h.normalize([
        h.text("使用此命令回复一张图片作为问题，来添加问答。\n"),
        h.text("用法: imgadd [-p 概率] [-g] "), h.text("<回复内容...>\n"),
        h.text("特殊语法（在回复内容中使用）：\n"),
        h.text("　$$：一个普通的 $ 字符\n"),
        h.text("　$n：换行并分条发送\n"),
        h.text("　$a：@消息发送者\n"),
        h.text("　$m：@机器人自身\n"),
        h.text("　$s：消息发送者的昵称"),
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

      const isGlobal = !!options.global;
      const currentGuildId = session.guildId;
      if (!isGlobal && !currentGuildId) return '添加本群问答需在群聊环境中使用。使用 -g 选项可添加全局问答。';
      const targetGuildId = isGlobal ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobal ? "全局" : `本群`;

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
        questionImageHash = questionImageData.hash;
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
              logger.error(`[教学] 处理回答图片失败: ${imgProcessingError.message}`);
              return `添加/更新失败：处理回答中的图片时出错 (${imgProcessingError.message})。`;
            }
          } else if (element.type !== 'text' || element.attrs.content?.trim()) { // 保留非空文本和其他元素
            processedAnswerElements.push(element);
          }
        }

        if (processedAnswerElements.length === 0) return '处理后的回答内容为空。';
        const serializedAnswer = processedAnswerElements.map(el => el.toString()).join('');

        // 查询是否存在相同问答
        const existingEntries = await ctx.database.get(TABLE_NAME, {
          guildId: targetGuildId, imageHash: questionImageHash,
        }, { fields: ['id', 'answer', 'probability'] });

        const exactMatch = existingEntries.find(e => e.answer === serializedAnswer);

        if (exactMatch) { // 存在完全相同的问答
          if (exactMatch.probability === probability) {
            return `对于此问题图片，在 ${scopeText} 已存在完全相同的回答及概率 (ID: ${exactMatch.id})。无需操作。`;
          } else { // 仅更新概率
            await ctx.database.set(TABLE_NAME, { id: exactMatch.id }, { probability });
            const count = await ctx.database.eval(TABLE_NAME, row => $.count(row.id), { guildId: targetGuildId, imageHash: questionImageHash });
            return `操作成功：已将 ${scopeText} 问答 ID ${exactMatch.id} 的概率从 ${exactMatch.probability} 更新为 ${probability}。\n此问题在 ${scopeText} 共有 ${Number(count)} 个回答。`;
          }
        } else { // 创建新记录
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

  // 查看图片问答列表
  ctx.command(`${name}.list`, '查看图片问答列表')
    .alias('图片回复列表', 'imglist', '图列')
    .option('page', '-p <page:natural> 页码 (从 1 开始)', { fallback: 1 })
    .option('size', '-s <size:natural> 每页条数', { fallback: 10 })
    .option('globalOnly', '-G, --global-only 仅显示全局问答')
    .option('guildOnly', '--guild-only 仅显示本群问答 (需在群内使用)')
    .option('all', '-a, --all 查看所有范围的问答 (需权限 3)', { authority: 3 })
    .usage(
      h.normalize([
        h.text("查看已添加的图片问答。\n"),
        h.text("显示本群及全局问答，在私聊中仅显示全局问答。\n"),
        h.text("可以使用选项筛选范围：-G (仅全局), --guild-only (仅本群), -a (所有,需权限)。\n"),
        h.text("用法: imglist [-p 页码] [-s 条数] [范围选项]"),
      ]).join('')
    )
    .action(async ({ session, options }) => {
      const currentGuildId = session.guildId;
      if (options.all && (options.guildOnly || options.globalOnly)) return '不能同时使用 --all 和 --guild-only 或 --global-only 选项。';
      if (options.guildOnly && !currentGuildId) return '使用 --guild-only 选项需要在群聊环境中使用。';
      if (options.globalOnly && options.guildOnly) return '不能同时使用 --global-only 和 --guild-only 选项。';

      const limit = Math.max(1, Number(options.size));
      const offset = (Math.max(1, Number(options.page)) - 1) * limit;

      const query: Query.Expr<ImageQAMulti> = {};
      let scopeDescription = "";
      let filterInfo = "";

      // 构建查询条件和描述文本
      if (options.all) {
        scopeDescription = "所有范围"; filterInfo = ' (所有范围)';
      } else if (options.globalOnly) {
        query.guildId = GLOBAL_GUILD_ID; scopeDescription = "全局"; filterInfo = ' (仅全局)';
      } else if (options.guildOnly) {
        query.guildId = currentGuildId!; scopeDescription = `本群`; filterInfo = ' (仅本群)';
      } else { // 默认情况
        if (currentGuildId) { // 群聊中：本群+全局
          query.$or = [{ guildId: currentGuildId }, { guildId: GLOBAL_GUILD_ID }];
          scopeDescription = `本群及全局`; filterInfo = ' (本群及全局)';
        } else { // 私聊中：仅全局
          query.guildId = GLOBAL_GUILD_ID; scopeDescription = "全局"; filterInfo = ' (全局)';
        }
      }

      try {
        const list = await ctx.database.get(TABLE_NAME, query, {
          limit, offset, fields: ['id', 'guildId', 'imageHash', 'answer', 'probability'],
          sort: { guildId: 'asc', imageHash: 'asc', id: 'asc' } // 稳定排序
        });
        const total = await ctx.database.eval(TABLE_NAME, (row) => $.count(row.id), query);
        const totalNum = Number(total);

        if (totalNum === 0) return `在 ${scopeDescription} 范围内还没有任何图片问答。`;

        const output = list.map(item => {
          let displayAnswer = item.answer.replace(/<image.*?>/g, '[图片]');
          displayAnswer = displayAnswer.length > 30 ? displayAnswer.substring(0, 30) + '...' : displayAnswer;
          const scopeLabel = item.guildId === GLOBAL_GUILD_ID ? '全局' : `群`;
          return `ID:${item.id} | hash:${item.imageHash.substring(0, 8)} | [${scopeLabel}] | P:${item.probability} | A:${h.escape(displayAnswer)}`;
        }).join('\n');

        const totalPages = Math.ceil(totalNum / limit);
        const pageInfo = `第 ${options.page}/${totalPages} 页，共 ${totalNum} 条`;

        return `${scopeDescription} 图片问答列表：\n${output}\n\n${pageInfo}${filterInfo}\n(使用 imgget ${h.text('<ID>')} 可查询问答的问题图片)`;

      } catch (dbError) {
        logger.error(`[列表] 查询数据库出错: ${dbError.message}`);
        return '查询问答列表时数据库出错。';
      }
    });

  // 删除指定ID的图片问答
  ctx.command(`${name}.delete <IDs:string>`, '删除指定ID的图片问答')
    .alias('删除图片回复', 'imgdel', '删图')
    .option('global', '-g, --global 删除全局问答 (需权限 3)', { authority: 3 })
    .usage(
      h.normalize([
        h.text("删除指定 ID 的图片问答。可以一次提供多个 ID，用逗号分隔。\n"),
        h.text("默认删除当前群聊的问答。使用 -g 选项可删除全局问答 (需要相应权限)。\n"),
        h.text("用法：imgdel [-g] "), h.text("<ID1,ID2,...>"),
      ]).join('')
    )
    .action(async ({ session, options }, idsString) => {
      const isGlobalDelete = !!options.global;
      const currentGuildId = session.guildId;
      if (!isGlobalDelete && !currentGuildId) return '删除本群问答需在群聊环境。使用 -g 可删除全局问答。';
      const targetGuildId = isGlobalDelete ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobalDelete ? "全局" : "本群";

      if (!idsString) return `缺少参数：问答 ID。用法：imgdel ${isGlobalDelete ? '-g ' : ''}${h.text('<ID1,ID2,...>')}`;

      // 解析并验证 ID
      const potentialIds = idsString.split(',').map(s => s.trim()).filter(Boolean);
      const validIds: number[] = [];
      const invalidInputs: string[] = [];
      potentialIds.forEach(idStr => {
        const num = parseInt(idStr, 10);
        if (Number.isInteger(num) && num > 0) validIds.push(num);
        else invalidInputs.push(idStr);
      });

      if (invalidInputs.length > 0) return `输入包含无效ID: ${invalidInputs.join(', ')}。ID 应为正整数。`;
      if (validIds.length === 0) return '未提供有效的问答 ID。';

      try {
        const recordsToDelete = await ctx.database.get(TABLE_NAME, {
          id: { $in: validIds }, guildId: targetGuildId,
        }, { fields: ['id'] });

        const idsToDelete = recordsToDelete.map(r => r.id);
        const idsNotFoundInScope = validIds.filter(id => !idsToDelete.includes(id));

        if (idsToDelete.length === 0) {
          return `指定的 ID (${validIds.join(', ')}) 在 ${scopeText} 范围内均未找到。`;
        }

        const result = await ctx.database.remove(TABLE_NAME, { id: { $in: idsToDelete }, guildId: targetGuildId });
        logger.info(`[删除] 已删除 ${result.removed} 条 ${scopeText} 记录 (IDs: ${idsToDelete.join(', ')})`);

        let response = `已成功删除 ${scopeText} ${result.removed} 条问答 (ID: ${idsToDelete.join(', ')})。`;
        if (idsNotFoundInScope.length > 0) {
          response += `\n以下请求的 ID 未在 ${scopeText} 找到或已被删除: ${idsNotFoundInScope.join(', ')}。`;
        }
        return response;

      } catch (error) {
        logger.error(`[删除] 删除记录失败 (请求IDs: ${validIds.join(',')}, 范围: ${scopeText}): ${error.message}`);
        return `删除失败：数据库操作出错。`;
      }
    });

  // 删除指定问题哈希(或前缀)对应的所有问答
  ctx.command(`${name}.delete.all <hashPrefix:string>`, '删除指定问题哈希(或前缀)对应的所有问答')
    .alias('删除图片全部回复', 'imgdelall', '删全图', '清图')
    .option('global', '-g, --global 删除全局问答 (需权限 3)', { authority: 3 })
    .usage(
      h.normalize([
        h.text("删除指定问题图片哈希（或其前缀）对应的所有回答。\n"),
        h.text("默认删除当前群聊的问答。使用 -g 选项可删除全局问答 (需要相应权限)。\n"),
        h.text(`为安全起见，哈希前缀至少需要 ${MIN_HASH_PREFIX_LENGTH} 位十六进制字符。\n`),
        h.text("如果前缀匹配到多个不同的完整哈希，操作将取消并提示。\n"),
        h.text("用法: imgdelall [-g] "), h.text("<哈希或前缀>"),
      ]).join('')
    )
    .action(async ({ session, options }, hashPrefix) => {
      const isGlobalDelete = !!options.global;
      const currentGuildId = session.guildId;
      if (!isGlobalDelete && !currentGuildId) return '删除本群问答需在群聊环境。使用 -g 可删除全局问答。';
      const targetGuildId = isGlobalDelete ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobalDelete ? "全局" : `本群`;

      if (!hashPrefix) return `缺少参数：哈希或前缀。用法：imgdelall ${isGlobalDelete ? '-g ' : ''}${h.text('<哈希或前缀>')} (至少 ${MIN_HASH_PREFIX_LENGTH} 位)`;
      const targetHashPrefix = hashPrefix.trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(targetHashPrefix)) return `哈希前缀格式无效，应仅包含十六进制字符 (0-9, a-f)。`;
      if (targetHashPrefix.length < MIN_HASH_PREFIX_LENGTH) return `哈希前缀过短，至少需要 ${MIN_HASH_PREFIX_LENGTH} 个十六进制字符以确保安全。`;

      try {
        // 查询匹配前缀的记录，获取不同的完整哈希 (安全检查)
        const queryPrefix = { guildId: targetGuildId, imageHash: { $regex: `^${targetHashPrefix}` } };
        const matchingRecords = await ctx.database.get(TABLE_NAME, queryPrefix, { fields: ['imageHash'] });
        const distinctHashes = [...new Set(matchingRecords.map(r => r.imageHash))];

        if (distinctHashes.length === 0) {
          return `在 ${scopeText} 未找到问题哈希以 '${targetHashPrefix}' 开头的问答。`;
        } else if (distinctHashes.length === 1) { // 精确匹配
          const fullHashToDelete = distinctHashes[0];
          const deleteQuery = { guildId: targetGuildId, imageHash: fullHashToDelete };
          const result = await ctx.database.remove(TABLE_NAME, deleteQuery);
          logger.info(`[删全图] 已删除 ${result.removed} 条记录 (哈希: ${fullHashToDelete}, 范围: ${scopeText}, 前缀触发: ${targetHashPrefix})`);
          return `已成功删除 ${scopeText} 范围内，问题哈希 ${fullHashToDelete.substring(0, 12)}... (由前缀 '${targetHashPrefix}' 唯一确定) 的全部 ${result.removed} 条问答。`;
        } else { // 匹配到多个哈希，取消操作
          const maxHashesToList = 5;
          const hashList = distinctHashes.map(h => `- ${h.substring(0, 12)}...`).slice(0, maxHashesToList).join('\n');
          let response = `找到 ${distinctHashes.length} 个不同的问题哈希匹配前缀 "${targetHashPrefix}"：\n${hashList}`;
          if (distinctHashes.length > maxHashesToList) response += `\n(还有 ${distinctHashes.length - maxHashesToList} 个未显示)`;
          response += `\n\n为防止误删，操作已取消。请提供更长或完整的哈希以唯一确定目标。`;
          return response;
        }
      } catch (error) {
        logger.error(`[删全图] 处理哈希前缀 ${targetHashPrefix} 时出错 (范围: ${scopeText}): ${error.message}`);
        return `操作失败：处理哈希前缀时数据库出错。`;
      }
    });

  // 查询问答ID对应的问题图片
  ctx.command(`${name}.query <ID:natural>`, '查询问答ID对应的问题图片')
    .alias('查询问答图片', 'imgget', '查图', '图ID')
    .option('global', '-g, --global 查看任意范围的问答 (需权限 3)', { authority: 3 })
    .usage(
      h.normalize([
        h.text("根据问答 ID 查询并发送其对应的问题图片。\n"),
        h.text("在群聊中会查找本群及全局问答，在私聊中仅查找全局问答。使用 -g 可查询所有范围 (需要权限)。\n"),
        h.text("用法：imgget [-g] "), h.text("<ID>"),
      ]).join('')
    )
    .action(async ({ session, options }, id) => {
      if (id === undefined || id <= 0 || !Number.isInteger(id)) return `缺少或无效的参数：问答 ID (应为正整数)。用法：imgget ${options.global ? '-g ' : ''}${h.text('<ID>')}`;
      const currentGuildId = session.guildId;

      try {
        let query: Query.Expr<ImageQAMulti>;
        let searchDescription: string;

        if (options.global) {
          // 使用 -g: 搜索所有范围
          query = { id: id };
          searchDescription = "所有范围";
        } else {
          // 默认: 搜索当前可访问范围
          const potentialGuildIds = currentGuildId ? [currentGuildId, GLOBAL_GUILD_ID] : [GLOBAL_GUILD_ID];
          query = { id: id, guildId: { $in: potentialGuildIds } };
          searchDescription = currentGuildId ? "本群及全局" : "全局";
        }

        const records = await ctx.database.get(TABLE_NAME, query);

        if (!records.length) {
          if (options.global) {
            return `未找到 ID 为 ${id} 的图片问答记录。`;
          } else {
            // 检查该 ID 是否存在于其他范围
            const existsAnywhere = await ctx.database.get(TABLE_NAME, { id: id }, { limit: 1, fields: ['guildId'] });
            if (existsAnywhere.length > 0) {
              return `问答 ID ${id} 存在，但不属于您当前可访问的范围 (${searchDescription})。尝试使用 -g 选项查询 (需要权限 3)。`;
            } else {
              return `未找到 ID 为 ${id} 的图片问答记录。`;
            }
          }
        }

        // 优先选择本群记录 (如果未使用 -g 且在群聊中)
        const record = (!options.global && currentGuildId)
          ? records.find(r => r.guildId === currentGuildId) || records[0]
          : records[0];

        const scopeText = record.guildId === GLOBAL_GUILD_ID
          ? "全局"
          : (record.guildId === currentGuildId ? "本群" : `群组 ${record.guildId}`);

        const filename = record.imageFilename;
        const imageHash = record.imageHash;
        const hashPrefix = imageHash ? imageHash.substring(0, 8) : '未知';

        if (!filename) {
          return `找到 ${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...)，但数据库记录中缺少关联的问题图片文件名信息。`;
        }

        // 尝试访问本地图片文件
        const localImagePath = path.join(resolvedStoragePath, filename);
        try {
          await fs.access(localImagePath); // 检查文件存在性
          const absolutePath = path.resolve(localImagePath);
          const fileUriPath = path.sep === '\\' ? '/' + absolutePath.replace(/\\/g, '/') : absolutePath;
          const fileUri = 'file://' + fileUriPath;

          await session.send(h.normalize([
            h.text(`${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...) 的问题图片 (${h.escape(filename)}):`),
            h.image(fileUri)
          ]));
          return;

        } catch (fileError) {
          if (fileError.code === 'ENOENT') {
            logger.warn(`[查询] 问题图片文件未找到 (ID: ${id}, 文件: ${filename}, 范围: ${scopeText})`);
            return `找到 ${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...)，但其对应的问题图片文件 (${h.escape(filename)}) 在存储路径 (${config.storagePath}) 中未找到。`;
          } else {
            logger.error(`[查询] 访问问题图片文件出错 (ID: ${id}, 文件: ${filename}, 范围: ${scopeText}): ${fileError.message}`);
            return `找到 ${scopeText} 问答 ID ${id}，但在访问其图片文件 (${h.escape(filename)}) 时服务器遇到错误。`;
          }
        }
      } catch (dbError) {
        logger.error(`[查询] 查询数据库出错 (ID: ${id}, 使用-g: ${!!options.global}): ${dbError.message}`);
        return `查询问答 ID ${id} 时数据库发生错误。`;
      }
    });

  // 清理本地存储中未被引用的图片
  ctx.command(`${name}.clear`, '清理本地存储中未被引用的图片', { authority: 3 })
    .alias('清理图片缓存', 'imgclear')
    .option('confirm', '-y, --confirm 必须确认执行此危险操作')
    .usage(
      h.normalize([
        h.text(`扫描配置的图片存储目录 (${config.storagePath})，并删除数据库中不再引用的图片文件。\n`),
        h.text("此操作会永久删除文件且不可逆，请务必谨慎！\n"),
        h.text("需要权限等级 3，并且必须使用 -y 或 --confirm 选项确认执行。\n"),
        h.text("用法: imgclear -y"),
      ]).join('')
    )
    .action(async ({ session, options }) => {
      if (!options.confirm) return '危险操作！此命令会永久删除本地图片文件。请添加 -y 或 --confirm 选项确认执行清理。';

      logger.info(`[清理] 开始清理 '${resolvedStoragePath}' 目录中未引用的图片...`);
      session.send(`正在扫描数据库记录和本地图片文件 (${resolvedStoragePath})，请稍候...`).catch(logger.warn);

      const referencedFilenames = new Set<string>();
      let filesOnDisk: string[] = [];
      let deletedCount = 0;
      let failedToDelete: { filename: string; error: string }[] = [];
      let skippedCount = 0; // 跳过的非图片文件或目录

      try {
        // 1: 扫描数据库，收集引用的文件名
        logger.info('[清理] 阶段 1: 查询数据库引用的文件名...');
        let offset = 0;
        while (true) {
          const batch = await ctx.database.get(TABLE_NAME, {}, {
            limit: BATCH_SIZE_FOR_CLEAR, offset, fields: ['id', 'imageFilename', 'answer']
          });
          if (batch.length === 0) break;

          for (const record of batch) {
            if (record.imageFilename) referencedFilenames.add(record.imageFilename);
            // 解析回答内容，提取本地图片文件名
            if (record.answer) {
              try {
                h.select(h.parse(record.answer), 'img').forEach(img => {
                  const src = img.attrs.src;
                  if (src?.startsWith('file://')) {
                    try {
                      const url = new URL(src);
                      let imagePath = decodeURIComponent(url.pathname);
                      // 处理 Windows 路径: file:///C:/... -> C:/...
                      if (process.platform === 'win32' && imagePath.match(/^\/[a-zA-Z]:\//)) {
                        imagePath = imagePath.substring(1);
                      }
                      const filename = path.basename(imagePath);
                      if (filename) referencedFilenames.add(filename);
                    } catch (uriError) {
                      logger.warn(`[清理] 解析回答中的图片URI失败 (ID: ${record.id}, URI: ${src}): ${uriError.message}`);
                    }
                  }
                });
              } catch (parseError) {
                logger.warn(`[清理] 解析回答内容失败 (ID: ${record.id}): ${parseError.message}`);
              }
            }
          }
          offset += batch.length;
        }
        logger.info(`[清理] 阶段 1: 完成，发现 ${referencedFilenames.size} 个唯一引用的本地文件名。`);

        // 2: 读取本地存储目录
        logger.info(`[清理] 阶段 2: 读取本地目录 '${resolvedStoragePath}'...`);
        try {
          await ensureDirExists(resolvedStoragePath, logger);
          filesOnDisk = await fs.readdir(resolvedStoragePath);
          logger.info(`[清理] 阶段 2: 本地找到 ${filesOnDisk.length} 个文件或目录。`);
        } catch (readDirError) {
          if (readDirError.code === 'ENOENT') {
            logger.info(`[清理] 目录 '${resolvedStoragePath}' 不存在，无需清理。`);
            return `配置的图片存储目录 (${resolvedStoragePath}) 不存在，无需清理。`;
          }
          logger.error(`[清理] 读取存储目录失败: ${readDirError.message}`); throw readDirError;
        }

        // 3: 对比并删除未引用文件
        logger.info(`[清理] 阶段 3: 对比并删除未引用的图片文件...`);
        const filesToDelete = filesOnDisk.filter(filename => !referencedFilenames.has(filename));

        if (filesToDelete.length === 0) {
          logger.info('[清理] 没有找到可清理的未引用图片文件。');
          return '扫描完成，没有找到可清理的未引用图片文件。';
        }
        logger.info(`[清理] 发现 ${filesToDelete.length} 个可能未引用的文件，开始过滤和删除...`);

        for (const filename of filesToDelete) {
          const filePath = path.join(resolvedStoragePath, filename);
          try {
            const stats = await fs.stat(filePath);
            // 跳过目录和非已知图片扩展名的文件
            if (!stats.isFile() || !KNOWN_IMAGE_EXTENSIONS.includes(path.extname(filename).toLowerCase())) {
              skippedCount++; continue;
            }
            await fs.unlink(filePath); // 删除文件
            deletedCount++;
          } catch (deleteError) {
            logger.error(`[清理] 删除文件 ${filePath} 失败: ${deleteError.message}`);
            failedToDelete.push({ filename, error: deleteError.message });
          }
        }

        // 4: 生成报告
        logger.info(`[清理] 完成。删除: ${deletedCount}, 失败: ${failedToDelete.length}, 跳过: ${skippedCount}`);
        let report = `图片清理完成 (${resolvedStoragePath})！\n`;
        report += `- 数据库共引用 ${referencedFilenames.size} 个本地文件。\n`;
        report += `- 本地扫描到 ${filesOnDisk.length} 项。\n`;
        report += `- 成功删除未引用图片 ${deletedCount} 个。`;
        if (skippedCount > 0) report += `\n- 跳过 ${skippedCount} 个非图片文件或目录。`;
        if (failedToDelete.length > 0) report += `\n- 删除失败 ${failedToDelete.length} 个 (详情见控制台日志)。`;
        return report;

      } catch (error) {
        logger.error(`[清理] 清理过程中发生严重错误: ${error.message}`, error.stack);
        return `清理过程中发生严重错误，操作可能未完全执行。详情请查看控制台日志。`;
      }
    });

  // 修改指定ID的图片问答
  ctx.command(`${name}.modify <id:natural> [...newAnswerContent:text]`, '修改指定ID的图片问答')
    .alias('修改图片回复', 'imgmod', '改图')
    .option('probability', '-p <probability:number> 设置新的回复概率 (0-1)')
    .option('global', '-g, --global 修改全局问答 (需权限 3)', { authority: 3 })
    .usage(
      h.normalize([
        h.text("修改指定 ID 的图片问答的回答内容或触发概率。\n"),
        h.text("使用 -g 选项可修改全局问答 (需要相应权限)。\n"),
        h.text("用法: imgmod [-g] [-p 新概率] "), h.text("<ID>"), h.text(" [新的回答内容...]\n"),
        h.text("必须提供新的回答内容或使用 -p 指定新概率，至少需要修改一项。\n"),
        h.text("回答内容支持特殊语法：\n"),
        h.text("　$$：一个普通的 $ 字符\n"),
        h.text("　$n：换行并分条发送\n"),
        h.text("　$a：@消息发送者\n"),
        h.text("　$m：@机器人自身\n"),
        h.text("　$s：消息发送者的昵称"),
      ]).join('')
    )
    .action(async ({ session, options }, id, newAnswerContent) => {
      if (id === undefined || id <= 0 || !Number.isInteger(id)) {
        return `缺少或无效的参数：问答 ID。用法：imgmod ${options.global ? '-g ' : ''}${options.probability !== undefined ? `-p ${options.probability} ` : ''}${h.text('<ID>')} [新内容]`;
      }

      const isGlobalMod = !!options.global;
      const currentGuildId = session.guildId;
      if (!isGlobalMod && !currentGuildId) return '修改本群问答需在群聊环境。使用 -g 可修改全局问答。';
      const targetGuildId = isGlobalMod ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobalMod ? "全局" : "本群";

      const newAnswerProvided = typeof newAnswerContent === 'string' && newAnswerContent.trim().length > 0;
      const newProbability = options.probability !== undefined ? Number(options.probability) : undefined;

      if (newProbability !== undefined && (isNaN(newProbability) || newProbability < 0 || newProbability > 1)) {
        return '概率必须是 0 到 1 之间的数字。';
      }
      if (!newAnswerProvided && newProbability === undefined) {
          if (typeof newAnswerContent === 'string' && newAnswerContent.length > 0 && newAnswerContent.trim().length === 0) {
              return `操作无效：您提供了只包含空白字符的新回答内容。请提供有效的回答或使用 -p 指定新概率。`;
          }
          return `操作无效：您必须提供新的回答内容或使用 -p 指定新的概率。`;
      }

      try {
        const existingRecords = await ctx.database.get(TABLE_NAME, {
          id: id, guildId: targetGuildId,
        }, { limit: 1 });
        const existingRecord = existingRecords.length > 0 ? existingRecords[0] : null;

        if (!existingRecord) {
          const existsAnywhereRecords = await ctx.database.get(TABLE_NAME, { id: id }, { limit: 1, fields: ['guildId'] });
          if (existsAnywhereRecords.length > 0) {
            return `问答 ID ${id} 存在，但不属于 ${scopeText} 范围。`;
          } else {
            return `未找到 ID 为 ${id} 的 ${scopeText} 问答记录。`;
          }
        }

        const updateData: Partial<ImageQAMulti> = {};
        let updateDescriptionParts: string[] = [];
        let actualAnswerUpdate = false;
        let actualProbabilityUpdate = false;

        // 处理新回答内容
        if (newAnswerProvided) {
          const parsedElements = h.parse(newAnswerContent);
          const processedNewAnswerElements: h[] = [];
          for (const element of h.normalize(parsedElements)) {
            if (element.type === 'img' && element.attrs.src && !element.attrs.src.startsWith('file://')) {
              try {
                const { localUri } = await processAndSaveImage(ctx, element.attrs.src, element, 'answer', resolvedStoragePath);
                processedNewAnswerElements.push(h.image(localUri));
              } catch (imgProcessingError) {
                logger.error(`[修改] 处理新回答图片失败: ${imgProcessingError.message}`);
                return `修改失败：处理新回答中的图片时出错 (${imgProcessingError.message})。`;
              }
            } else if (element.type !== 'text' || element.attrs.content?.trim()) {
              processedNewAnswerElements.push(element);
            }
          }

          if (processedNewAnswerElements.length === 0) return '错误：处理后的新回答内容为空。';
          const finalSerializedAnswer = processedNewAnswerElements.map(el => el.toString()).join('');

          if (finalSerializedAnswer !== existingRecord.answer) {
            updateData.answer = finalSerializedAnswer; actualAnswerUpdate = true;
            let answerPreview = finalSerializedAnswer.replace(/<image src="file:.*?\/?>/g, '[本地图片]');
            answerPreview = answerPreview.length > 50 ? answerPreview.substring(0, 50) + '...' : answerPreview;
            updateDescriptionParts.push(`回答内容更新为: ${h.escape(answerPreview)}`);
          }
        }

        // 处理新概率
        if (newProbability !== undefined) {
          if (newProbability !== existingRecord.probability) {
            updateData.probability = newProbability; actualProbabilityUpdate = true;
            updateDescriptionParts.push(`概率从 ${existingRecord.probability} 修改为 ${newProbability}`);
          }
        }

        if (!actualAnswerUpdate && !actualProbabilityUpdate) {
          let reason = "";
          if (newAnswerProvided && newProbability !== undefined) reason = "提供的新回答和新概率与当前记录相同。";
          else if (newAnswerProvided) reason = "提供的新回答与当前记录相同。";
          else if (newProbability !== undefined) reason = "提供的新概率与当前记录相同。";
          return `问答 ID ${id} (${scopeText}) 未作修改。${reason}`;
        }

        // 执行更新
        await ctx.database.set(TABLE_NAME, { id: id, guildId: targetGuildId }, updateData);
        return `成功修改问答 ID ${id} (${scopeText})。\n${updateDescriptionParts.join('\n')}`;

      } catch (error) {
        logger.error(`[修改] 修改记录 ID ${id} (范围: ${scopeText}) 失败: ${error.message}`);
        return `修改失败：数据库操作出错。`;
      }
    });

} // apply 函数结束

// --- END OF FILE index.ts ---