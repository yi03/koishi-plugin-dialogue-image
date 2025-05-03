// src/utils.ts
import { Context, h } from 'koishi';
import { createHash } from 'crypto';
import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { name as pluginName } from './index';

/**
 * 根据权重从项目列表中随机选择一项。
 * 如果总概率 > 1，则进行归一化后再选择。
 * @param items 包含 probability 属性的对象数组
 * @returns 选中的项目或 null (如果列表为空或无有效项目)
 */
export function selectWeightedRandom<T extends { probability: number }>(items: T[]): T | null {
  if (!items?.length) return null;
  const validItems = items.filter(item => item.probability > 0);
  if (!validItems.length) return null;

  let totalProb = validItems.reduce((sum, item) => sum + item.probability, 0);
  const useNormalizedProb = totalProb > 1;
  const targetProb = useNormalizedProb ? 1 : totalProb; // 目标总概率，用于随机数范围
  const randomNum = Math.random() * targetProb;

  let cumulativeProb = 0;
  for (const item of validItems) {
    const currentProb = useNormalizedProb ? (item.probability / totalProb) : item.probability;
    cumulativeProb += currentProb;
    if (randomNum < cumulativeProb) {
      return item;
    }
  }
  // 处理浮点精度或边界情况，返回最后一个有效项
  return validItems[validItems.length - 1];
}

/**
 * 确保指定目录存在，如果不存在则递归创建。
 * @param dirPath 目录路径
 * @param logger Koishi logger 实例
 */
export async function ensureDirExists(dirPath: string, logger: ReturnType<Context['logger']>) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') { // 忽略目录已存在的错误
      logger.error(`创建目录失败: ${dirPath}`, error);
      throw error; // 重新抛出非 EEXIST 错误
    }
  }
}

export function guessExtension(mimeType?: string, filenameOrUrl?: string): string {
  if (mimeType) {
    const lowerMime = mimeType.toLowerCase();
    if (lowerMime === 'image/jpeg') return '.jpg';
    if (lowerMime === 'image/png') return '.png';
    if (lowerMime === 'image/gif') return '.gif'; // 虽然我们提前处理了GIF，但这里保持完整
    if (lowerMime === 'image/webp') return '.webp';
    if (lowerMime === 'image/bmp') return '.bmp';
    if (lowerMime === 'image/tiff') return '.tiff';
  }
  // 如果没有 mime 或无法识别，再尝试从 URL/文件名获取 (作为备用)
  if (filenameOrUrl) {
    const urlMatch = filenameOrUrl.match(/^https?:\/\/.+?(\.\w+)(?:[?#]|$)/i);
    const fileMatch = filenameOrUrl.match(/\.(\w+)$/);
    const ext = (urlMatch?.[1] || fileMatch?.[1])?.toLowerCase().replace(/^\./, '');
    if (ext && /^(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(ext)) {
      return `.${ext}`;
    }
  }
  // 最终默认
  return '.png';
}

/**
 * 检查 Buffer 是否以 GIF 文件签名开头。
 * @param buffer 图片文件 Buffer
 * @returns 如果是 GIF 返回 true，否则 false
 */
export function isGif(buffer: Buffer): boolean {
  if (buffer.length < 6) {
    return false;
  }
  // GIF87a or GIF89a
  const signature = buffer.toString('hex', 0, 6);
  return signature === '474946383761' || signature === '474946383961';
}


/**
 * 下载图片，计算其哈希值 (GIF 使用 MD5，其他尝试 pHash)，
 * 并将图片保存到本地指定路径（如果尚不存在）。
 * 返回图片的哈希值、本地文件名和 file:// URI。
 *
 * @param ctx Koishi Context
 * @param imageUrl 图片的 URL
 * @param imageElement 原始消息中的图片元素 (h 对象)，用于辅助猜测扩展名
 * @param purpose 图片用途 ('question' 或 'answer')，仅用于日志
 * @param imageStoragePath 图片存储的基础目录路径
 * @returns 包含 imageHash, filename, localUri 的对象
 * @throws 如果下载、哈希计算或保存过程中发生错误
 */
export async function processAndSaveImage(
  ctx: Context,
  imageUrl: string,
  imageElement: h | undefined,
  purpose: 'question' | 'answer',
  imageStoragePath: string
): Promise<{ imageHash: string; filename: string; localUri: string }> {
  const logger = ctx.logger(pluginName);
  let buffer: Buffer;
  let imageHash: string;
  let hashType: 'md5' | 'phash';
  let filename: string;
  let localImagePath: string;
  let absolutePath: string;
  let actualExt: string; // 用于存储最终确定的扩展名
  try {
    const response = await ctx.http.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
    buffer = Buffer.from(response);
    if (buffer.length === 0) throw new Error(`下载得到空文件`);

    // 步骤 1: 使用 isGif 快速检查 GIF
    if (isGif(buffer)) {
      hashType = 'md5';
      imageHash = createHash('md5').update(buffer).digest('hex');
      actualExt = '.gif'; // GIF 扩展名确定
      logger.debug(`[图片处理] 检测到 GIF (通过签名), 计算 MD5: ${imageHash}, 扩展名: ${actualExt}`);
    } else {
      // 步骤 2: 对于非 GIF，尝试用 Jimp 读取并计算 pHash
      hashType = 'phash';
      try {
        if (typeof Jimp === 'undefined' || typeof Jimp.read !== 'function') {
          logger.error(`[图片处理] Jimp 或 Jimp.read 不可用！`);
          throw new Error('Jimp is not available');
        }
        const image = await Jimp.read(buffer); // 尝试读取
        imageHash = image.hash(16); // 计算 pHash

        // 步骤 3: 读取成功后，使用 image.mime 确定准确的扩展名
        const mimeType = image.mime; // 获取 Jimp 检测到的 MIME
        actualExt = guessExtension(mimeType, imageElement?.attrs.file || imageUrl); // 使用 MIME 优先确定扩展名
      } catch (jimpError) {
        logger.error(`[图片处理] 使用 Jimp 处理非 GIF 图片失败 (${imageUrl}): ${jimpError.message}`);
        if (jimpError.message?.includes('Unsupported MIME type') || jimpError.message?.includes('Could not find MIME') || jimpError.message?.includes('Decoder') || jimpError.message === 'Jimp is not available') {
          logger.warn(`[图片处理] 图片格式不受 Jimp 支持或 Jimp 不可用: ${imageUrl}. 无法生成 pHash 或确定扩展名.`);
        }
        // 抛出错误，因为无法处理此图片
        throw new Error(`无法处理非 GIF 图片 (Jimp 失败): ${jimpError.message}`);
      }
    }

    if (!imageHash || !actualExt) {
      throw new Error(`未能计算哈希或确定扩展名 (Hash: ${imageHash}, Ext: ${actualExt})`);
    }

  } catch (error) {
    logger.error(`[图片处理] 处理 ${purpose} 图片 (${imageUrl}) 失败: ${error.message}`);
    throw new Error(`处理${purpose === 'question' ? '问题' : '回答'}图片失败: ${error.message}`);
  }

  // 使用哈希值和猜测的扩展名生成文件名
  filename = `${imageHash}${actualExt}`;
  localImagePath = path.join(imageStoragePath, filename);
  absolutePath = path.resolve(localImagePath);

  // 检查文件是否已存在，不存在则保存
  try {
    await fs.access(localImagePath);
    logger.debug(`[图片处理] ${purpose} 图片已存在 (基于 ${hashType}): ${filename}`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      try {
        await ensureDirExists(imageStoragePath, logger);
        await fs.writeFile(localImagePath, buffer);
      } catch (writeError) {
        logger.error(`[图片处理] 写入 ${purpose} 图片 (${filename}) 失败: ${writeError.message}`);
        throw new Error(`保存${purpose === 'question' ? '问题' : '回答'}图片文件失败`);
      }
    } else {
      logger.error(`[图片处理] 检查 ${purpose} 图片 (${filename}) 状态失败: ${e.message}`);
      throw new Error(`检查${purpose === 'question' ? '问题' : '回答'}图片文件状态失败`);
    }
  }

  const fileUriPath = path.sep === '\\' ? '/' + absolutePath.replace(/\\/g, '/') : absolutePath;
  const localUri = 'file://' + fileUriPath;

  return { imageHash, filename, localUri };
}
