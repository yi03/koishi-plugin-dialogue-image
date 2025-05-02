// src/utils.ts
import { Context, h } from 'koishi'
import { createHash } from 'crypto'
import { Buffer } from 'buffer'
import { promises as fs } from 'fs';
import path from 'path';
import { URL } from 'url'; // 用于解析 file:// URI
import { name as pluginName } from './index'

/** 按概率从带权重的项目列表中随机选择一项 (若总概率>1则归一化) */
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
  return validItems[validItems.length - 1]; // 处理浮点精度或边界情况
}

/** 确保目录存在，如果不存在则创建 */
export async function ensureDirExists(dirPath: string, logger: ReturnType<Context['logger']>) {
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
export function guessExtension(mimeType?: string, filename?: string): string {
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
export async function processAndSaveImage(
  ctx: Context,
  imageUrl: string,
  imageElement: h | undefined, // 用于猜测扩展名
  purpose: 'question' | 'answer', // 用于日志记录
  imageStoragePath: string // 保存目录
): Promise<{ hash: string; filename: string; localUri: string }> {
  const logger = ctx.logger(pluginName); // 使用导入的插件名
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
