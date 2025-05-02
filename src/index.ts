// src/index.ts
import { Context, Schema } from 'koishi'
import path from 'path';

// 从同级目录导入
import { Config as AppConfig, Config as ConfigSchema } from './config'
import { ImageQAMulti, TABLE_NAME } from './database'
import { ensureDirExists } from './utils'
import { registerMessageListener } from './listener'
// 从同级子目录 commands 导入
import { registerCommands } from './commands'

// --- 插件信息 ---
export const name = 'imgqa' // 插件名称在此定义和导出
export const using = ['database', 'http']

// --- 导出配置接口和 Schema ---
export type Config = AppConfig
export const Config = ConfigSchema

// --- 数据库扩展 ---
declare module 'koishi' {
  interface Tables {
    image_qa_multi: ImageQAMulti
  }
}

// --- 主要插件逻辑 ---
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name); // 使用本文件定义的 name
  const dataDirPath = path.join(ctx.baseDir, 'data');
  const resolvedStoragePath = path.isAbsolute(config.storagePath)
    ? config.storagePath
    : path.join(dataDirPath, config.storagePath);

  ctx.on('ready', async () => {
    try {
      await ensureDirExists(resolvedStoragePath, logger);
      logger.info(`图片存储目录已确认: ${resolvedStoragePath}`);
    } catch {
      logger.warn(`无法保证图片存储目录 '${resolvedStoragePath}' 可访问。插件功能可能受影响。`);
    }
  });

  ctx.model.extend(TABLE_NAME, {
    id: 'unsigned', guildId: 'string', imageHash: 'string',
    imageFilename: 'string', answer: 'text', probability: 'double',
    creatorId: 'string', createdAt: 'timestamp',
  }, { primary: 'id', autoInc: true, indexes: ['guildId', 'imageHash'] });

  // 注册监听器和命令
  registerMessageListener(ctx);
  registerCommands(ctx, config, resolvedStoragePath);

  logger.info('图片问答插件已加载。');
}