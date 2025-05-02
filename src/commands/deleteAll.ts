// src/commands/deleteAll.ts
import { Context, h } from 'koishi'
import { Config } from '../config'
import { TABLE_NAME, GLOBAL_GUILD_ID, MIN_HASH_PREFIX_LENGTH } from '../database'
import { name as pluginName } from '../index'

export function registerDeleteAllCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
    const logger = ctx.logger(pluginName);

    ctx.command(`${pluginName}.delete.all <hashPrefix:string>`, '删除指定问题哈希(或前缀)对应的所有问答')
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
}
