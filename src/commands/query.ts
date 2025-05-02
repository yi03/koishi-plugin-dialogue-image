// src/commands/query.ts
import { Context, h, Query as KoishiQuery } from 'koishi' // Renamed Query to avoid conflict with DOM Query type
import { Config } from '../config'
import { TABLE_NAME, GLOBAL_GUILD_ID, ImageQAMulti } from '../database'
import { promises as fs } from 'fs';
import path from 'path';
import { name as pluginName } from '../index'

export function registerQueryCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
    const logger = ctx.logger(pluginName);

    ctx.command(`${pluginName}.query <ID:natural>`, '查询问答ID对应的问题图片')
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
                let query: KoishiQuery.Expr<ImageQAMulti>;
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
                    return; // 成功发送后返回 undefined

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
}
