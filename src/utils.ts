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
 */
export function selectWeightedRandom<T extends { probability: number }>(items: T[]): T | null {
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
  // 处理浮点精度或边界情况
  return validItems[validItems.length - 1];
}

/**
 * 确保指定目录存在，如果不存在则递归创建。
 */
export async function ensureDirExists(dirPath: string, logger: ReturnType<Context['logger']>) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      logger.error('创建目录 %s 失败: %c', dirPath, error);
      throw error;
    }
  }
}

/**
 * 根据 MIME 类型或文件名猜测图片扩展名。
 */
export function guessExtension(mimeType?: string, filenameOrUrl?: string): string {
  if (mimeType) {
    const lowerMime = mimeType.toLowerCase();
    if (lowerMime === 'image/jpeg') return '.jpg';
    if (lowerMime === 'image/png') return '.png';
    if (lowerMime === 'image/gif') return '.gif';
    if (lowerMime === 'image/webp') return '.webp';
    if (lowerMime === 'image/bmp') return '.bmp';
    if (lowerMime === 'image/tiff') return '.tiff';
  }
  if (filenameOrUrl) {
    const urlMatch = filenameOrUrl.match(/^https?:\/\/.+?(\.\w+)(?:[?#]|$)/i);
    const fileMatch = filenameOrUrl.match(/\.(\w+)$/);
    const ext = (urlMatch?.[1] || fileMatch?.[1])?.toLowerCase().replace(/^\./, '');
    if (ext && /^(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(ext)) {
      return `.${ext}`;
    }
  }
  return '.png'; // 默认 .png
}

/**
 * 检查 Buffer 是否为 GIF 文件。
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
 * 下载图片，计算哈希 (GIF 用 MD5，其他尝试 pHash)，并保存到本地。
 * 返回图片的哈希值、本地文件名和 file:// URI。
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
  let actualExt: string;

  try {
    const response = await ctx.http.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
    buffer = Buffer.from(response);
    if (buffer.length === 0) throw new Error(`下载得到空文件`);

    if (isGif(buffer)) {
      hashType = 'md5';
      imageHash = createHash('md5').update(buffer).digest('hex');
      actualExt = '.gif';
    } else {
      hashType = 'phash';
      try {
        if (typeof Jimp === 'undefined' || typeof Jimp.read !== 'function') {
          logger.error('Jimp 或 Jimp.read 不可用！');
          throw new Error('Jimp is not available');
        }
        const image = await Jimp.read(buffer);
        imageHash = image.hash(16); // 计算 pHash
        const mimeType = image.mime;
        actualExt = guessExtension(mimeType, imageElement?.attrs.file || imageUrl);
      } catch (jimpError) {
        logger.error('使用 Jimp 处理非 GIF 图片失败 (%s): %c', imageUrl, jimpError.message);
        if (jimpError.message?.includes('Unsupported MIME type') || jimpError.message?.includes('Could not find MIME') || jimpError.message?.includes('Decoder') || jimpError.message === 'Jimp is not available') {
          logger.warn('图片格式不受 Jimp 支持或 Jimp 不可用 (%s), 无法生成 pHash 或确定扩展名。', imageUrl);
        }
        throw new Error(`无法处理非 GIF 图片 (Jimp 失败): ${jimpError.message}`);
      }
    }

    if (!imageHash || !actualExt) {
      throw new Error(`未能计算哈希或确定扩展名 (Hash: ${imageHash}, Ext: ${actualExt})`);
    }

  } catch (error) {
    logger.error('处理 %s 图片 (%s) 失败: %c', purpose, imageUrl, error.message);
    throw new Error(`处理${purpose === 'question' ? '问题' : '回答'}图片失败: ${error.message}`);
  }

  filename = `${imageHash}${actualExt}`;
  localImagePath = path.join(imageStoragePath, filename);
  absolutePath = path.resolve(localImagePath);

  try {
    await fs.access(localImagePath);
    // 文件已存在，无需操作
  } catch (e) {
    if (e.code === 'ENOENT') {
      try {
        await ensureDirExists(imageStoragePath, logger);
        await fs.writeFile(localImagePath, buffer);
      } catch (writeError) {
        logger.error('写入 %s 图片 (%s) 失败: %c', purpose, filename, writeError.message);
        throw new Error(`保存${purpose === 'question' ? '问题' : '回答'}图片文件失败`);
      }
    } else {
      logger.error('检查 %s 图片 (%s) 状态失败: %c', purpose, filename, e.message);
      throw new Error(`检查${purpose === 'question' ? '问题' : '回答'}图片文件状态失败`);
    }
  }

  const fileUriPath = path.sep === '\\' ? '/' + absolutePath.replace(/\\/g, '/') : absolutePath;
  const localUri = 'file://' + fileUriPath;

  return { imageHash, filename, localUri };
}