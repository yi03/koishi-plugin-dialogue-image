// src/config.ts
import { Schema } from 'koishi'

export const DEFAULT_IMAGE_STORAGE_DIR_NAME = 'imgqa_images'; // 默认图片存储目录名

// --- 插件配置 ---
export interface Config {
  storagePath: string; // 图片存储路径
}

export const Config: Schema<Config> = Schema.object({
  storagePath: Schema.string()
    .description(`图片存储路径。可以是绝对路径，也可以是相对于 Koishi 数据目录 (data) 的相对路径。`)
    .default(DEFAULT_IMAGE_STORAGE_DIR_NAME),
})
