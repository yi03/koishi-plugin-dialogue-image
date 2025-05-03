// src/database.ts
import { Tables } from 'koishi'

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
  imageHash: string;      // 问题图片的感知哈希 (pHash, hex string)
  imageFilename?: string; // 问题图片本地文件名 (用于存储和 'query' 命令)
  answer: string;         // 回答内容 (序列化的 Element 数组)
  probability: number;    // 触发概率 (0-1)
  creatorId: string;      // 创建者用户ID
  createdAt: Date;        // 创建时间
}

// --- 常量 ---
export const TABLE_NAME = 'image_qa_multi';
export const GLOBAL_GUILD_ID = '';                   // 全局问答的 guildId 标识
export const BATCH_SIZE_FOR_CLEAR = 1000;            // clear 命令数据库查询分页大小
export const MIN_HASH_PREFIX_LENGTH = 4;             // imgdelall 命令最短哈希前缀要求
export const KNOWN_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']; // 清理命令识别的图片扩展名