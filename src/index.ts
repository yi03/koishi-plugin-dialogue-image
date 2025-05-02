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

// --- 常量 ---
const TABLE_NAME = 'image_qa_multi';
const DEFAULT_IMAGE_STORAGE_DIR_NAME = 'imgqa_images';
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

/** 按概率从带权重的项目列表中随机选择一项 (若总概率>1则会标准化) */
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
  // 处理浮点数精度问题，保底返回最后一个有效项
  return validItems[validItems.length - 1];
}

/** 确保目录存在 */
async function ensureDirExists(dirPath: string, logger: ReturnType<Context['logger']>) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      logger.error(`创建目录失败: ${dirPath}`, error);
      throw error; // 向上抛出非 EEXIST 错误
    }
    // 如果是 EEXIST 错误，说明目录已存在，是正常情况，无需处理
  }
}

/** 基于 MIME 类型、文件名或 URL 猜测文件扩展名 */
function guessExtension(mimeType?: string, filename?: string): string {
  // 优先从文件名或URL中提取
  if (filename) {
    const urlMatch = filename.match(/^https?:\/\/.+?(\.\w+)(?:[?#]|$)/i); // 匹配 URL 中的扩展名
    const fileMatch = filename.match(/\.(\w+)$/); // 匹配普通文件名中的扩展名
    const ext = (urlMatch?.[1] || fileMatch?.[1])?.toLowerCase().replace(/^\./, ''); // 取第一个匹配到的，转小写，去点
    if (ext && /^(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(ext)) { // 检查是否是已知图片扩展名
      return `.${ext}`;
    }
  }
  // 其次尝试从 MIME 类型推断
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

/** 下载、计算哈希、保存图片，并返回哈希、文件名和本地 URI */
async function processAndSaveImage(
  ctx: Context,
  imageUrl: string,
  imageElement: h | undefined, // 用于获取可能的 MIME 类型或原始文件名
  purpose: 'question' | 'answer', // 用于日志区分
  imageStoragePath: string
): Promise<{ hash: string; filename: string; localUri: string }> {
  const logger = ctx.logger(name);
  let buffer: Buffer;
  let hash: string;
  let filename: string;
  let localImagePath: string;
  let absolutePath: string;

  // 下载图片
  try {
    const response = await ctx.http.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    buffer = Buffer.from(response);
    if (buffer.length === 0) throw new Error(`下载得到空文件`);
  } catch (error) {
    logger.error(`[图片处理] 下载 ${purpose} 图片失败 (${imageUrl}): ${error.message}`);
    throw new Error(`下载${purpose}图片失败`);
  }

  // 计算哈希和生成文件名
  hash = createHash('md5').update(buffer).digest('hex');
  const ext = guessExtension(imageElement?.attrs.type, imageElement?.attrs.file || imageUrl);
  filename = `${hash}${ext}`;
  localImagePath = path.join(imageStoragePath, filename);
  absolutePath = path.resolve(localImagePath); // 获取绝对路径用于 file:// URI

  // 检查文件是否已存在，不存在则写入
  try {
    await fs.access(localImagePath); // 尝试访问，如果成功则文件已存在
  } catch (e) {
    if (e.code === 'ENOENT') { // 文件不存在
      try {
        await ensureDirExists(imageStoragePath, logger); // 确保目录存在
        await fs.writeFile(localImagePath, buffer); // 写入文件
        logger.info(`[图片处理] 保存新 ${purpose} 图片: ${filename}`);
      } catch (writeError) {
        logger.error(`[图片处理] 写入 ${purpose} 图片 (${filename}) 失败: ${writeError.message}`);
        throw new Error(`保存${purpose}图片文件失败`);
      }
    } else { // 其他访问错误
      logger.error(`[图片处理] 检查 ${purpose} 图片 (${filename}) 状态失败: ${e.message}`);
      throw new Error(`检查${purpose}图片文件状态失败`);
    }
  }

  // 生成本地 file:// URI
  // 需要处理 Windows 路径（反斜杠转正斜杠，并加前缀/）
  const fileUriPath = path.sep === '\\' ? '/' + absolutePath.replace(/\\/g, '/') : absolutePath;
  const localUri = 'file://' + fileUriPath;

  return { hash, filename, localUri };
}

// --- 主要插件逻辑 ---
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name);
  // 解析并确认图片存储路径
  const dataDirPath = path.join(ctx.baseDir, 'data');
  const resolvedStoragePath = path.isAbsolute(config.storagePath)
    ? config.storagePath
    : path.join(dataDirPath, config.storagePath);

  // 插件启动时确保目录存在
  ctx.on('ready', async () => {
    try {
      await ensureDirExists(resolvedStoragePath, logger);
      logger.info(`图片存储目录已确认: ${resolvedStoragePath}`);
    } catch {
      logger.warn(`无法保证图片存储目录 '${resolvedStoragePath}' 可访问或可写。`);
    }
  });

  // 扩展数据库表
  ctx.model.extend(TABLE_NAME, {
    id: 'unsigned',
    guildId: 'string',
    imageHash: 'string',
    imageFilename: 'string', // 存储问题图片的文件名，方便查询
    answer: 'text',
    probability: 'double',
    creatorId: 'string',
    createdAt: 'timestamp',
  }, {
    primary: 'id', // 主键
    autoInc: true, // 自增
    indexes: ['guildId', 'imageHash'] // 索引提高查询效率
  });

  // --- 消息监听器 (核心回复逻辑) ---
  ctx.on('message', async (session) => {
    // 忽略机器人自己、无内容、非单图片消息
    if (session.userId === session.selfId || !session.content) return;
    const normalizedElements = h.normalize(session.elements || []);
    if (normalizedElements.length !== 1 || normalizedElements[0].type !== 'img') return;

    const imgElement = normalizedElements[0];
    const imageUrl = imgElement.attrs.src;
    if (!imageUrl) return; // 无法获取图片 URL

    const currentGuildId = session.guildId;
    let hash: string | undefined;

    try {
      // 1. 获取图片哈希
      const arrayBuffer = await ctx.http.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) return; // 忽略空图片
      hash = createHash('md5').update(buffer).digest('hex');

      // 2. 查询数据库 (合并本群和全局结果)
      let guildResults: ImageQAMulti[] = [];
      if (currentGuildId) {
        guildResults = await ctx.database.get(TABLE_NAME, { guildId: currentGuildId, imageHash: hash });
      }
      const globalResults = await ctx.database.get(TABLE_NAME, { guildId: GLOBAL_GUILD_ID, imageHash: hash });
      const combinedResults = [...guildResults, ...globalResults]; // 本群结果优先（如果概率相同）

      // 3. 如果有匹配结果，按概率选择一个回答
      if (combinedResults.length > 0) {
        const selectedAnswerData = selectWeightedRandom(combinedResults);
        if (!selectedAnswerData) return; // 没有选中的（可能都是0概率）

        const matchScope = selectedAnswerData.guildId === GLOBAL_GUILD_ID ? 'global' : 'guild';
        logger.info(`[消息监听] 触发问答 ID ${selectedAnswerData.id} (范围: ${matchScope}, 哈希: ${hash.substring(0, 8)}...)`);

        // 4. 解析并发送回答
        const rawAnswer = selectedAnswerData.answer;
        const allMessageParts: h[][] = []; // 用于存储被 $n 分割的消息段
        let currentMessageElements: h[] = []; // 当前消息段的元素
        let currentTextBuffer = ''; // 临时存储文本内容，合并处理
        const senderName = session.author?.name || session.author?.nick || session.username || session.userId || '用户';
        const botName: string = session.bot.user?.name || session.bot.user?.nick || session.selfId;
        const parsedAnswerElements = h.parse(rawAnswer); // 解析存储的序列化回答

        // 冲洗文本缓冲区，将其内容转换为 h 元素并添加到当前消息段
        const flushTextBuffer = () => {
          if (currentTextBuffer) {
            // 使用 h.parse 处理可能存在的 Koishi 特殊语法（如 CQ 码）
            currentMessageElements.push(...h.parse(currentTextBuffer));
            currentTextBuffer = '';
          }
        };

        // 遍历解析后的元素，处理特殊变量
        for (const element of parsedAnswerElements) {
          if (element.type === 'text' && element.attrs.content) {
            let content = element.attrs.content;
            // 正则匹配特殊变量 $$ $a $s $m $n (注意避免匹配转义的 \\$)
            const regex = /(\$\$)|(?<!\\)\$a|(?<!\\)\$s|(?<!\\)\$m|(?<!\\)\$n/g;
            let lastIndex = 0;
            let match: RegExpExecArray | null;

            while ((match = regex.exec(content)) !== null) {
              // 添加匹配前的普通文本到缓冲区
              if (match.index > lastIndex) currentTextBuffer += content.substring(lastIndex, match.index);

              // 处理匹配到的特殊变量
              if (match[1] === '$$') currentTextBuffer += '$'; // $$ -> $
              else if (match[0] === '$a') { flushTextBuffer(); currentMessageElements.push(h.at(session.userId, { name: senderName })); } // @发送者
              else if (match[0] === '$s') currentTextBuffer += senderName; // 发送者昵称
              else if (match[0] === '$m') { flushTextBuffer(); currentMessageElements.push(h.at(session.selfId, { name: botName })); } // @机器人
              else if (match[0] === '$n') { // 换行并分条发送
                flushTextBuffer();
                if (currentMessageElements.length > 0) allMessageParts.push([...currentMessageElements]); // 保存上一段
                currentMessageElements = []; // 开始新段
              }
              lastIndex = regex.lastIndex;
            }
            // 添加最后一个匹配后的剩余文本
            if (lastIndex < content.length) currentTextBuffer += content.substring(lastIndex);
          } else {
            // 非文本元素，先冲洗文本缓冲区，再直接添加该元素
            flushTextBuffer();
            currentMessageElements.push(element);
          }
        }
        // 处理循环结束后可能剩余的文本缓冲区
        flushTextBuffer();
        // 将最后一段消息添加到列表
        if (currentMessageElements.length > 0) allMessageParts.push(currentMessageElements);

        // 5. 分条发送处理后的消息段
        for (const messagePart of allMessageParts) {
          if (messagePart.length > 0) {
            try {
              await session.send(h.normalize(messagePart)); // 发送前再次 normalize
            } catch (sendError) {
              logger.error(`[消息监听] 发送消息段出错: ${sendError.message}`);
            }
          }
        }
        return; // 已处理，结束
      }
    } catch (error) {
      logger.error(`[消息监听] 处理图片问答时出错 (哈希: ${hash?.substring(0, 8) ?? '未知'}): ${error.message}`);
      // 不向用户发送错误信息，避免干扰
    }
  });

  // --- 管理命令 ---

  // 添加/更新图片问答
  ctx.command(`${name}.add [...answerElements:el]`, '添加图片问答', { authority: 1 })
    .alias('添加图片回复', 'imgadd', '教图')
    .option('probability', '-p <probability:number> 回复概率 (0-1, 默认 1.0)', { fallback: 1.0 })
    .option('global', '-g, --global 设为全局问答 (需权限 3)', { authority: 3 })
    .usage(
      h.normalize([
        h.text("使用此命令回复一张图片作为问题，来添加或更新问答。\n"),
        h.text("用法: imgadd <回复内容...> [-p 概率] [-g]\n"),
        h.text("特殊语法: $$ ($), $n (换行分条), $a (@发送者), $s (发送者昵称), $m (@自己)"),
      ]).join('')
    )
    .action(async ({ session, options }, answerElements: h[]) => {
      // 校验环境和权限
      const isGlobal = !!options.global;
      const currentGuildId = session.guildId;
      if (!isGlobal && !currentGuildId) return '添加本群问答需在群聊环境中使用。使用 -g 选项可添加全局问答。';
      const targetGuildId = isGlobal ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobal ? "全局" : `本群`;

      // 校验输入
      if (!session.quote) return '请回复一张图片作为问题来添加/更新问答。';
      const quotedImages = h.select(session.quote.elements || [], 'img');
      if (!quotedImages.length) return '回复的消息中没有找到图片(问题)。';
      if (quotedImages.length > 1) session.send('提示：检测到多张问题图片，将使用第一张。').catch(logger.warn);

      const probability = Number(options.probability);
      if (isNaN(probability) || probability < 0 || probability > 1) return '概率必须是 0 到 1 之间的数字。';

      // 自动过滤掉引用消息本身的内容，避免误操作
      let cleanedAnswerElements: h[] = h.normalize(answerElements || []);
      if (session.quote && session.quote.elements) {
        const quoteElements = h.normalize(session.quote.elements);
        const quoteElementStrings = new Set(quoteElements.map(el => el.toString()));
        cleanedAnswerElements = cleanedAnswerElements.filter(el => !quoteElementStrings.has(el.toString()));
      }
      if (cleanedAnswerElements.length === 0) {
          return '回答内容不能为空，或者您输入的回答与引用的消息完全相同已被自动过滤。';
      }

      const questionImageElement = quotedImages[0];
      const questionImageUrl = questionImageElement.attrs.src;
      if (!questionImageUrl) return '无法获取问题图片的地址。';

      try {
        // 处理问题图片
        const { hash: questionImageHash, filename: questionImageFilename } = await processAndSaveImage(
          ctx, questionImageUrl, questionImageElement, 'question', resolvedStoragePath
        );

        // 处理回答中的图片 (下载并替换为本地 URI)
        const processedAnswerElements: h[] = [];
        for (const element of cleanedAnswerElements) {
          if (element.type === 'img' && element.attrs.src && !element.attrs.src.startsWith('file://')) {
            try {
              const { localUri } = await processAndSaveImage(ctx, element.attrs.src, element, 'answer', resolvedStoragePath);
              processedAnswerElements.push(h.image(localUri)); // 替换为本地图片元素
            } catch (imgProcessingError) {
              logger.error(`[教学] 处理回答图片失败: ${imgProcessingError.message}`);
              return `添加/更新失败：处理回答中的图片时出错 (${imgProcessingError.message})。`;
            }
          } else if (element.type !== 'text' || element.attrs.content?.trim()) {
            // 保留非空文本和其他非图片元素
            processedAnswerElements.push(element);
          }
        }

        if (processedAnswerElements.length === 0) return '处理后的回答内容为空（可能只包含无效图片链接或空文本）。';
        const serializedAnswer = processedAnswerElements.map(el => el.toString()).join('');

        // 检查数据库中是否已存在相同问答
        const existingEntries = await ctx.database.get(TABLE_NAME, {
          guildId: targetGuildId, imageHash: questionImageHash,
        }, { fields: ['id', 'answer', 'probability'] });

        const exactMatch = existingEntries.find(e => e.answer === serializedAnswer);

        if (exactMatch) { // 回答完全相同
          if (exactMatch.probability === probability) {
            return `对于此问题图片，在 ${scopeText} 已存在完全相同的回答及概率 (ID: ${exactMatch.id})。无需操作。`;
          } else {
            // 更新概率
            await ctx.database.set(TABLE_NAME, { id: exactMatch.id }, { probability });
            const count = await ctx.database.eval(TABLE_NAME, row => $.count(row.id), { guildId: targetGuildId, imageHash: questionImageHash });
            return `操作成功：已将 ${scopeText} 问答 ID ${exactMatch.id} 的概率从 ${exactMatch.probability} 更新为 ${probability}。\n此问题在 ${scopeText} 共有 ${Number(count)} 个回答。`;
          }
        } else { // 新增回答
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
        // 根据错误类型提供更友好的用户提示
        const userErrorMessage = error.message.includes('下载') || error.message.includes('保存') || error.message.includes('处理')
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
        h.text("默认: 群聊显示本群及全局, 私聊仅显示全局。\n"),
        h.text("选项: -G (仅全局), --guild-only (仅本群), -a (所有,需权限)。\n"),
        h.text("用法: imglist [-p 页码] [-s 条数] [范围选项]"),
      ]).join('')
    )
    .action(async ({ session, options }) => {
      // 处理选项冲突和环境限制
      const currentGuildId = session.guildId;
      if (options.all && (options.guildOnly || options.globalOnly)) return '不能同时使用 --all 和 --guild-only 或 --global-only 选项。';
      if (options.guildOnly && !currentGuildId) return '使用 --guild-only 选项需要在群聊环境中使用。';
      if (options.globalOnly && options.guildOnly) return '不能同时使用 --global-only 和 --guild-only 选项。';

      const limit = Math.max(1, Number(options.size));
      const offset = (Math.max(1, Number(options.page)) - 1) * limit;

      // 构建数据库查询条件
      const query: Query.Expr<ImageQAMulti> = {};
      let scopeDescription = ""; // 用于用户反馈
      let filterInfo = ""; // 用于分页信息后缀

      if (options.all) {
        // 无需添加 guildId 条件，查询所有
        scopeDescription = "所有范围"; filterInfo = ' (所有范围)';
      } else if (options.globalOnly) {
        query.guildId = GLOBAL_GUILD_ID;
        scopeDescription = "全局"; filterInfo = ' (仅全局)';
      } else if (options.guildOnly) {
        query.guildId = currentGuildId!; // 已在前面校验过 currentGuildId 存在
        scopeDescription = `本群`; filterInfo = ' (仅本群)';
      } else {
        // 默认行为
        if (currentGuildId) {
          // 群聊中，查询本群或全局
          query.$or = [{ guildId: currentGuildId }, { guildId: GLOBAL_GUILD_ID }];
          scopeDescription = `本群及全局`; filterInfo = ' (本群及全局)';
        } else {
          // 私聊中，仅查询全局
          query.guildId = GLOBAL_GUILD_ID;
          scopeDescription = "全局"; filterInfo = ' (全局)';
        }
      }

      try {
        // 查询数据和总数
        const list = await ctx.database.get(TABLE_NAME, query, {
          limit, offset,
          fields: ['id', 'guildId', 'imageHash', 'answer', 'probability'], // 只选择需要的字段
          sort: { guildId: 'asc', imageHash: 'asc', id: 'asc' } // 排序保证分页稳定
        });
        const total = await ctx.database.eval(TABLE_NAME, (row) => $.count(row.id), query);
        const totalNum = Number(total);

        if (totalNum === 0) return `在 ${scopeDescription} 范围内还没有任何图片问答。`;

        // 格式化输出
        const output = list.map(item => {
          let displayAnswer = item.answer.replace(/<image.*?>/g, '[图片]'); // 隐藏图片细节
          displayAnswer = displayAnswer.length > 30 ? displayAnswer.substring(0, 30) + '...' : displayAnswer;
          const scopeLabel = item.guildId === GLOBAL_GUILD_ID ? '全局' : `群`;
          return `ID:${item.id} | hash:${item.imageHash.substring(0, 8)} | [${scopeLabel}] | P:${item.probability} | A:${h.escape(displayAnswer)}`;
        }).join('\n');

        const totalPages = Math.ceil(totalNum / limit);
        const pageInfo = `第 ${options.page}/${totalPages} 页，共 ${totalNum} 条`;

        return `${scopeDescription} 图片问答列表：\n${output}\n\n${pageInfo}${filterInfo}\n(使用 imgget <ID> 可查询问答的问题图片)`;

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
        h.text("删除指定 ID 的图片问答 (多个 ID 用逗号分隔)。\n"),
        h.text("默认删除本群问答，-g 删除全局问答 (需权限)。\n"),
        h.text("用法：imgdel <ID1,ID2,...> [-g]"),
      ]).join('')
    )
    .action(async ({ session, options }, idsString) => {
      // 确定范围和校验环境
      const isGlobalDelete = !!options.global;
      const currentGuildId = session.guildId;
      if (!isGlobalDelete && !currentGuildId) return '删除本群问答需在群聊环境。使用 -g 可删除全局问答。';
      const targetGuildId = isGlobalDelete ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobalDelete ? "全局" : "本群";

      // 解析和验证 ID
      if (!idsString) return `缺少参数：问答 ID。用法：imgdel ${h.text('<ID1,ID2,...>')} ${isGlobalDelete ? '-g' : ''}`;
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
        // 查询待删除记录是否存在于目标范围
        const recordsToDelete = await ctx.database.get(TABLE_NAME, {
          id: { $in: validIds }, guildId: targetGuildId,
        }, { fields: ['id'] }); // 只需 id 字段

        const idsToDelete = recordsToDelete.map(r => r.id);
        const idsNotFoundInScope = validIds.filter(id => !idsToDelete.includes(id));

        if (idsToDelete.length === 0) {
          return `指定的 ID (${validIds.join(', ')}) 在 ${scopeText} 范围内均未找到。`;
        }

        // 执行删除
        const result = await ctx.database.remove(TABLE_NAME, { id: { $in: idsToDelete }, guildId: targetGuildId });
        logger.info(`[删除] 已删除 ${result.removed} 条 ${scopeText} 记录 (IDs: ${idsToDelete.join(', ')})`);

        // 构造反馈信息
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
        h.text("删除指定问题图片哈希(或其前缀)对应的所有回答。\n"),
        h.text("默认删除本群问答，-g 删除全局问答 (需权限)。\n"),
        h.text(`哈希前缀至少需要 ${MIN_HASH_PREFIX_LENGTH} 位十六进制字符。\n`),
        h.text("若前缀匹配多个不同哈希，操作将取消。\n"),
        h.text("用法: imgdelall <哈希或前缀> [-g]"),
      ]).join('')
    )
    .action(async ({ session, options }, hashPrefix) => {
      // 确定范围和校验环境
      const isGlobalDelete = !!options.global;
      const currentGuildId = session.guildId;
      if (!isGlobalDelete && !currentGuildId) return '删除本群问答需在群聊环境。使用 -g 可删除全局问答。';
      const targetGuildId = isGlobalDelete ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobalDelete ? "全局" : `本群`;

      // 校验哈希前缀
      if (!hashPrefix) return `缺少参数：哈希或前缀。用法：imgdelall ${h.text('<哈希或前缀>')} ${isGlobalDelete ? '-g' : ''} (至少 ${MIN_HASH_PREFIX_LENGTH} 位)`;
      const targetHashPrefix = hashPrefix.trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(targetHashPrefix)) return `哈希前缀格式无效，应仅包含十六进制字符 (0-9, a-f)。`;
      if (targetHashPrefix.length < MIN_HASH_PREFIX_LENGTH) return `哈希前缀过短，至少需要 ${MIN_HASH_PREFIX_LENGTH} 个十六进制字符。`;

      try {
        // 查询匹配前缀的所有记录的 imageHash
        const queryPrefix = { guildId: targetGuildId, imageHash: { $regex: `^${targetHashPrefix}` } }; // 使用正则匹配前缀
        const matchingRecords = await ctx.database.get(TABLE_NAME, queryPrefix, { fields: ['imageHash'] }); // 只需 imageHash
        const distinctHashes = [...new Set(matchingRecords.map(r => r.imageHash))]; // 获取去重后的完整哈希列表

        if (distinctHashes.length === 0) {
          return `在 ${scopeText} 未找到问题哈希以 '${targetHashPrefix}' 开头的问答。`;
        } else if (distinctHashes.length === 1) {
          // 只有一个匹配的完整哈希，安全，执行删除
          const fullHashToDelete = distinctHashes[0];
          const deleteQuery = { guildId: targetGuildId, imageHash: fullHashToDelete };
          const result = await ctx.database.remove(TABLE_NAME, deleteQuery);
          logger.info(`[删全图] 已删除 ${result.removed} 条记录 (哈希: ${fullHashToDelete}, 范围: ${scopeText}, 前缀触发: ${targetHashPrefix})`);
          return `已成功删除 ${scopeText} 范围内，问题哈希 ${fullHashToDelete.substring(0, 12)}... (由前缀 '${targetHashPrefix}' 唯一确定) 的全部 ${result.removed} 条问答。`;
        } else {
          // 匹配到多个不同的完整哈希，为防止误删，取消操作并提示
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
    .usage(
      h.normalize([
        h.text("根据问答 ID 查询并发送其对应的问题图片。\n"),
        h.text("群聊查本群及全局，私聊查全局。\n"),
        h.text("用法：imgget <ID>"),
      ]).join('')
    )
    .action(async ({ session }, id) => {
      if (id === undefined || id <= 0 || !Number.isInteger(id)) return `缺少或无效的参数：问答 ID (应为正整数)。用法：imgget ${h.text('<ID>')}`;

      const currentGuildId = session.guildId;
      try {
        // 确定查询范围 (群聊查本群和全局，私聊只查全局)
        const potentialGuildIds = currentGuildId ? [currentGuildId, GLOBAL_GUILD_ID] : [GLOBAL_GUILD_ID];
        const records = await ctx.database.get(TABLE_NAME, { id: id, guildId: { $in: potentialGuildIds } });

        if (!records.length) {
          // 检查记录是否存在于其他范围
          const existsAnywhere = await ctx.database.get(TABLE_NAME, { id: id }, { limit: 1, fields: ['guildId'] });
          if (existsAnywhere.length > 0) {
            return `问答 ID ${id} 存在，但不属于您当前可访问的范围 (本群或全局)。`;
          } else {
            return `未找到 ID 为 ${id} 的图片问答记录。`;
          }
        }

        // 优先返回本群记录（如果存在且在群聊中查询）
        const record = records.find(r => r.guildId === currentGuildId) || records[0];
        const scopeText = record.guildId === GLOBAL_GUILD_ID ? "全局" : "本群";
        const filename = record.imageFilename;
        const imageHash = record.imageHash;
        const hashPrefix = imageHash ? imageHash.substring(0, 8) : '未知';

        if (!filename) {
          return `找到 ${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...)，但数据库记录中缺少关联的问题图片文件名信息。`;
        }

        // 尝试访问并发送本地图片
        const localImagePath = path.join(resolvedStoragePath, filename);
        try {
          await fs.access(localImagePath); // 检查文件是否存在
          const absolutePath = path.resolve(localImagePath);
          const fileUriPath = path.sep === '\\' ? '/' + absolutePath.replace(/\\/g, '/') : absolutePath;
          const fileUri = 'file://' + fileUriPath;

          await session.send(h.normalize([
            h.text(`${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...) 的问题图片 (${h.escape(filename)}):`),
            h.image(fileUri) // 发送本地图片
          ]));
          return; // 成功发送后结束

        } catch (fileError) {
          if (fileError.code === 'ENOENT') {
            logger.warn(`[查询] 问题图片文件未找到 (ID: ${id}, 文件: ${filename})`);
            return `找到 ${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...)，但其对应的问题图片文件 (${h.escape(filename)}) 在存储路径 (${config.storagePath}) 中未找到。`;
          } else {
            logger.error(`[查询] 访问问题图片文件出错 (ID: ${id}, 文件: ${filename}): ${fileError.message}`);
            return `找到 ${scopeText} 问答 ID ${id}，但在访问其图片文件 (${h.escape(filename)}) 时服务器遇到错误。`;
          }
        }
      } catch (dbError) {
        logger.error(`[查询] 查询数据库出错 (ID: ${id}): ${dbError.message}`);
        return `查询问答 ID ${id} 时数据库发生错误。`;
      }
    });

  // 清理本地存储中未被引用的图片
  ctx.command(`${name}.clear`, '清理本地存储中未被引用的图片', { authority: 3 })
    .alias('清理图片缓存', 'imgclear')
    .option('confirm', '-y, --confirm 必须确认执行此危险操作')
    .usage(
      h.normalize([
        h.text(`扫描图片存储目录 (${config.storagePath})，删除数据库未引用的图片。\n`),
        h.text("警告：此操作不可逆！\n"),
        h.text("需要权限 3，且必须使用 -y 或 --confirm 确认。\n"),
        h.text("用法: imgclear -y"),
      ]).join('')
    )
    .action(async ({ session, options }) => {
      if (!options.confirm) return '危险操作！此命令会永久删除本地图片文件。请添加 -y 或 --confirm 选项确认执行清理。';

      logger.info(`[清理] 开始清理 '${resolvedStoragePath}' 目录中未引用的图片...`);
      session.send(`正在扫描数据库记录和本地图片文件 (${resolvedStoragePath})，过程可能较长，请稍候...`).catch(logger.warn);

      const referencedFilenames = new Set<string>(); // 存储数据库引用的所有本地文件名
      let filesOnDisk: string[] = []; // 存储本地目录下的所有文件名
      let deletedCount = 0; // 成功删除计数
      let failedToDelete: { filename: string; error: string }[] = []; // 删除失败列表
      let skippedCount = 0; // 跳过计数 (非图片文件或目录)

      try {
        // 阶段 1: 扫描数据库，收集所有引用的本地文件名
        logger.info('[清理] 阶段 1: 查询数据库引用的文件名...');
        let offset = 0;
        let totalProcessed = 0;
        while (true) {
          const batch = await ctx.database.get(TABLE_NAME, {}, {
            limit: BATCH_SIZE_FOR_CLEAR, offset, fields: ['id', 'imageFilename', 'answer'] // 需要 imageFilename 和 answer
          });
          if (batch.length === 0) break; // 没有更多数据

          for (const record of batch) {
            // 添加问题图片的文件名
            if (record.imageFilename) referencedFilenames.add(record.imageFilename);
            // 解析回答内容，查找 file:// 协议的图片
            if (record.answer) {
              try {
                const answerElements = h.parse(record.answer);
                h.select(answerElements, 'img').forEach(img => {
                  const src = img.attrs.src;
                  if (src?.startsWith('file://')) {
                    try {
                      const url = new URL(src); // 解析 file URI
                      let imagePath = decodeURIComponent(url.pathname); // 解码路径
                      // 处理 Windows 路径 (移除开头的斜杠)
                      if (process.platform === 'win32' && imagePath.match(/^\/[a-zA-Z]:\//)) {
                        imagePath = imagePath.substring(1);
                      }
                      const filename = path.basename(imagePath); // 提取文件名
                      if (filename) referencedFilenames.add(filename);
                    } catch (uriError) {
                      logger.warn(`[清理] 解析回答中的 file URI (${src}) 失败 (ID: ${record.id}): ${uriError.message}`);
                    }
                  }
                });
              } catch (parseError) {
                 logger.warn(`[清理] 解析回答失败 (ID: ${record.id}): ${parseError.message}`);
              }
            }
          }
          offset += batch.length;
          totalProcessed += batch.length;
          // 打印进度日志，避免长时间无反馈
          if (totalProcessed > 0 && totalProcessed % (BATCH_SIZE_FOR_CLEAR * 5) === 0) {
            logger.info(`[清理] 阶段 1: 已处理 ${totalProcessed} 条数据库记录...`);
          }
        }
        logger.info(`[清理] 阶段 1: 完成，发现 ${referencedFilenames.size} 个唯一引用的本地文件名。`);

        // 阶段 2: 读取本地存储目录下的所有文件和目录名
        logger.info(`[清理] 阶段 2: 读取本地目录 '${resolvedStoragePath}'...`);
        try {
          await ensureDirExists(resolvedStoragePath, logger); // 确保目录存在
          filesOnDisk = await fs.readdir(resolvedStoragePath);
          logger.info(`[清理] 阶段 2: 本地找到 ${filesOnDisk.length} 个文件或目录。`);
        } catch (readDirError) {
          if (readDirError.code === 'ENOENT') {
            logger.info(`[清理] 目录 '${resolvedStoragePath}' 不存在，无需清理。`);
            return `配置的图片存储目录 (${resolvedStoragePath}) 不存在，无需清理。`;
          }
          logger.error(`[清理] 读取存储目录失败: ${readDirError.message}`); throw readDirError; // 抛出其他读取错误
        }

        // 阶段 3: 对比并删除未被引用的、且是已知图片类型的文件
        logger.info(`[清理] 阶段 3: 对比并删除未引用的图片文件...`);
        const filesToDeletePotentially = filesOnDisk.filter(filename => !referencedFilenames.has(filename));
        if (filesToDeletePotentially.length === 0) {
          logger.info('[清理] 没有找到可能未引用的文件。');
          return '扫描完成，没有找到可清理的未引用图片文件。';
        }
        logger.info(`[清理] 发现 ${filesToDeletePotentially.length} 个可能未引用的文件，开始检查并删除...`);

        for (const filename of filesToDeletePotentially) {
          const filePath = path.join(resolvedStoragePath, filename);
          try {
            const stats = await fs.stat(filePath); // 获取文件状态
            if (!stats.isFile()) { // 跳过目录
              skippedCount++;
              continue;
            }
            const ext = path.extname(filename).toLowerCase(); // 获取小写扩展名
            if (!KNOWN_IMAGE_EXTENSIONS.includes(ext)) { // 跳过非已知图片扩展名
              skippedCount++;
              continue;
            }
            // 确认是文件且是图片类型，执行删除
            await fs.unlink(filePath);
            deletedCount++;
            if (deletedCount > 0 && deletedCount % 100 === 0) logger.info(`[清理] 阶段 3: 已删除 ${deletedCount} 个...`);
          } catch (deleteError) {
            if (deleteError.code !== 'ENOENT') { // 如果删除时文件已不存在，则忽略错误
                logger.error(`[清理] 删除文件 ${filePath} 失败: ${deleteError.message}`);
                failedToDelete.push({ filename, error: deleteError.message });
            }
          }
        }

        // 阶段 4: 生成并发送报告
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
        h.text("默认修改本群问答，-g 修改全局问答 (需权限)。\n"),
        h.text("用法: imgmod <ID> [新的回答内容...] [-p 新概率]\n"),
        h.text("必须提供新回答内容 或 使用 -p 指定新概率。\n"),
        h.text("回答内容支持特殊语法 (同 imgadd)。"),
      ]).join('')
    )
    .action(async ({ session, options }, id, newAnswerContent) => {
      // 校验 ID
      if (id === undefined || id <= 0 || !Number.isInteger(id)) {
        return `缺少或无效的参数：问答 ID。用法：imgmod ${h.text('<ID>')} [新内容] [-p 概率] [-g]`;
      }

      // 确定范围和校验环境
      const isGlobalMod = !!options.global;
      const currentGuildId = session.guildId;
      if (!isGlobalMod && !currentGuildId) return '修改本群问答需在群聊环境。使用 -g 可修改全局问答。';
      const targetGuildId = isGlobalMod ? GLOBAL_GUILD_ID : currentGuildId!;
      const scopeText = isGlobalMod ? "全局" : "本群";

      // 校验输入：必须提供新回答或新概率
      const newAnswerProvided = typeof newAnswerContent === 'string' && newAnswerContent.trim().length > 0;
      const newProbability = options.probability !== undefined ? Number(options.probability) : undefined;

      if (newProbability !== undefined && (isNaN(newProbability) || newProbability < 0 || newProbability > 1)) {
        return '概率必须是 0 到 1 之间的数字。';
      }
      if (!newAnswerProvided && newProbability === undefined) {
        // 检查是否提供了仅包含空白的回答
        if (typeof newAnswerContent === 'string' && newAnswerContent.length > 0 && newAnswerContent.trim().length === 0) {
           return `操作无效：您提供了只包含空白字符的新回答内容。请提供有效的回答或使用 -p 指定新概率。`;
        }
        return `操作无效：您必须提供新的回答内容或使用 -p 指定新的概率。`;
      }

      try {
        // 查询目标记录
        const existingRecords = await ctx.database.get(TABLE_NAME, {
          id: id, guildId: targetGuildId,
        }, { limit: 1 }); // 限制为1条，因为 ID 在 guildId 内应唯一
        const existingRecord = existingRecords.length > 0 ? existingRecords[0] : null;

        if (!existingRecord) {
          // 检查记录是否存在于其他范围
          const existsAnywhereRecords = await ctx.database.get(TABLE_NAME, { id: id }, { limit: 1, fields: ['guildId'] });
          if (existsAnywhereRecords.length > 0) {
            return `问答 ID ${id} 存在，但不属于 ${scopeText} 范围。`;
          } else {
            return `未找到 ID 为 ${id} 的 ${scopeText} 问答记录。`;
          }
        }

        const updateData: Partial<ImageQAMulti> = {}; // 准备更新的数据
        let updateDescriptionParts: string[] = []; // 用于生成成功消息
        let actualAnswerUpdate = false; // 标记回答是否实际改变
        let actualProbabilityUpdate = false; // 标记概率是否实际改变

        // 处理新回答内容（如果提供）
        if (newAnswerProvided) {
          const parsedElements = h.parse(newAnswerContent);
          const processedNewAnswerElements: h[] = [];
          // 处理新回答中的图片
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

          if (processedNewAnswerElements.length === 0) {
            return '错误：处理后的新回答内容为空。';
          }
          const finalSerializedAnswer = processedNewAnswerElements.map(el => el.toString()).join('');

          // 仅当新回答与旧回答不同时才更新
          if (finalSerializedAnswer !== existingRecord.answer) {
            updateData.answer = finalSerializedAnswer; actualAnswerUpdate = true;
            let answerPreview = finalSerializedAnswer.replace(/<image src="file:.*?\/?>/g, '[本地图片]');
            answerPreview = answerPreview.length > 50 ? answerPreview.substring(0, 50) + '...' : answerPreview;
            updateDescriptionParts.push(`回答内容更新为: ${h.escape(answerPreview)}`);
          }
        }

        // 处理新概率（如果提供）
        if (newProbability !== undefined) {
          // 仅当新概率与旧概率不同时才更新
          if (newProbability !== existingRecord.probability) {
            updateData.probability = newProbability; actualProbabilityUpdate = true;
            updateDescriptionParts.push(`概率从 ${existingRecord.probability} 修改为 ${newProbability}`);
          }
        }

        // 如果没有任何实际改变，则不执行数据库操作
        if (!actualAnswerUpdate && !actualProbabilityUpdate) {
          let reason = "";
          if (newAnswerProvided && newProbability !== undefined) reason = "提供的新回答和新概率与当前记录相同。";
          else if (newAnswerProvided) reason = "提供的新回答与当前记录相同。";
          else if (newProbability !== undefined) reason = "提供的新概率与当前记录相同。";
          return `问答 ID ${id} (${scopeText}) 未作修改。${reason}`;
        }

        // 执行数据库更新
        await ctx.database.set(TABLE_NAME, { id: id, guildId: targetGuildId }, updateData);
        return `成功修改问答 ID ${id} (${scopeText})。\n${updateDescriptionParts.join('\n')}`;

      } catch (error) {
        logger.error(`[修改] 修改记录 ID ${id} (范围: ${scopeText}) 失败: ${error.message}`);
        return `修改失败：数据库操作出错。`;
      }
    });

} // apply 函数结束

// --- END OF FILE index.ts ---