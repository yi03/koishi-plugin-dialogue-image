// src/commands/deleteAll.ts
import { Context, h, Query as KoishiQuery } from 'koishi' // 引入 KoishiQuery
import { Config } from '../config'
import { TABLE_NAME, GLOBAL_GUILD_ID, MIN_HASH_PREFIX_LENGTH, ImageQAMulti } from '../database' // 引入 ImageQAMulti
import { name as pluginName } from '../index'

export function registerDeleteAllCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
    const logger = ctx.logger(pluginName);

    ctx.command(`${pluginName}.delete.all <hashPrefix:string>`, '删除指定问题哈希(或前缀)对应的所有问答')
        .alias('删除图片全部回复', 'imgdelall', '删全图', '清图')
        .option('global', '-g, --global 操作所有范围的问答 (需权限 3)', { authority: 3 }) // 修改描述
        .usage(
            h.normalize([
                h.text("删除指定问题图片哈希（或其前缀）对应的所有回答。\n"),
                h.text("默认删除当前群聊的问答。使用 -g 选项可操作所有范围内的问答 (需要相应权限)。\n"), // 修改描述
                h.text(`为安全起见，哈希前缀至少需要 ${MIN_HASH_PREFIX_LENGTH} 位十六进制字符。\n`),
                h.text("如果前缀匹配到多个不同的完整哈希，操作将取消并提示。\n"),
                h.text("用法: imgdelall [-g] "), h.text("<哈希或前缀>"),
            ]).join('')
        )
        .action(async ({ session, options }, hashPrefix) => {
            const isGlobalOperation = !!options.global; // 重命名变量更清晰
            const currentGuildId = session.guildId;

            let queryPrefix: KoishiQuery.Expr<ImageQAMulti>;
            let scopeText: string;

            if (!hashPrefix) return `缺少参数：哈希或前缀。用法：imgdelall ${isGlobalOperation ? '-g ' : ''}${h.text('<哈希或前缀>')} (至少 ${MIN_HASH_PREFIX_LENGTH} 位)`;
            const targetHashPrefix = hashPrefix.trim().toLowerCase();
            if (!/^[0-9a-f]+$/.test(targetHashPrefix)) return `哈希前缀格式无效，应仅包含十六进制字符 (0-9, a-f)。`;
            if (targetHashPrefix.length < MIN_HASH_PREFIX_LENGTH) return `哈希前缀过短，至少需要 ${MIN_HASH_PREFIX_LENGTH} 个十六进制字符以确保安全。`;

            if (isGlobalOperation) {
                // -g: 搜索所有范围
                queryPrefix = { imageHash: { $regex: `^${targetHashPrefix}` } };
                scopeText = "所有范围";
            } else {
                // 默认: 仅限本群
                if (!currentGuildId) return '删除本群问答需在群聊环境。使用 -g 可操作所有范围的问答。';
                queryPrefix = { guildId: currentGuildId, imageHash: { $regex: `^${targetHashPrefix}` } };
                scopeText = `本群`;
            }

            try {
                // 查询匹配前缀的记录，获取不同的完整哈希 (安全检查)
                // 注意：即使是全局操作，这里的查询也可能跨群组，所以获取 distinct hashes 是合理的
                const matchingRecords = await ctx.database.get(TABLE_NAME, queryPrefix, { fields: ['imageHash'] });
                const distinctHashes = [...new Set(matchingRecords.map(r => r.imageHash))];

                if (distinctHashes.length === 0) {
                    return `在 ${scopeText} 未找到问题哈希以 '${targetHashPrefix}' 开头的问答。`;
                } else if (distinctHashes.length === 1) { // 精确匹配到一个哈希
                    const fullHashToDelete = distinctHashes[0];
                    let deleteQuery: KoishiQuery.Expr<ImageQAMulti>;

                    if (isGlobalOperation) {
                        // -g: 删除所有 guild 中匹配该哈希的记录
                        deleteQuery = { imageHash: fullHashToDelete };
                    } else {
                        // 默认: 仅删除本群中匹配该哈希的记录
                        deleteQuery = { guildId: currentGuildId!, imageHash: fullHashToDelete };
                    }

                    const result = await ctx.database.remove(TABLE_NAME, deleteQuery);
                    const finalScopeText = isGlobalOperation ? "所有范围" : `本群`; // 确认最终的操作范围文本
                    logger.info(`[删全图] 已删除 ${result.removed} 条记录 (哈希: ${fullHashToDelete}, 操作范围: ${finalScopeText}, 前缀触发: ${targetHashPrefix})`);
                    return `已成功删除 ${finalScopeText} 内，问题哈希 ${fullHashToDelete.substring(0, 12)}... (由前缀 '${targetHashPrefix}' 唯一确定) 的全部 ${result.removed} 条问答。`;
                } else { // 匹配到多个哈希，取消操作
                    const maxHashesToList = 5;
                    const hashList = distinctHashes.map(h => `- ${h.substring(0, 12)}...`).slice(0, maxHashesToList).join('\n');
                    let response = `找到 ${distinctHashes.length} 个不同的问题哈希匹配前缀 "${targetHashPrefix}" (在 ${scopeText} 内搜索)：\n${hashList}`;
                    if (distinctHashes.length > maxHashesToList) response += `\n(还有 ${distinctHashes.length - maxHashesToList} 个未显示)`;
                    response += `\n\n为防止误删，操作已取消。请提供更长或完整的哈希以唯一确定目标。`;
                    return response;
                }
            } catch (error) {
                logger.error(`[删全图] 处理哈希前缀 ${targetHashPrefix} 时出错 (搜索范围: ${scopeText}): ${error.message}`);
                return `操作失败：处理哈希前缀时数据库出错。`;
            }
        });
}