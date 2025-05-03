// src/commands/delete.ts
import { Context, h, Query as KoishiQuery } from 'koishi' // 引入 KoishiQuery
import { Config } from '../config'
import { TABLE_NAME, GLOBAL_GUILD_ID, ImageQAMulti } from '../database' // 引入 ImageQAMulti
import { name as pluginName } from '../index'

export function registerDeleteCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
    const logger = ctx.logger(pluginName);

    ctx.command(`${pluginName}.delete <IDs:string>`, '删除指定ID的图片问答')
        .alias('删除图片回复', 'imgdel', '删图')
        .option('global', '-g, --global 操作所有范围的问答 (需权限 3)', { authority: 3 }) // 修改描述
        .usage(
            h.normalize([
                h.text("删除指定 ID 的图片问答。可以一次提供多个 ID，用逗号分隔。\n"),
                h.text("默认删除当前群聊的问答。使用 -g 选项可操作所有范围内的问答 (需要相应权限)。\n"), // 修改描述
                h.text("用法：imgdel [-g] "), h.text("<ID1,ID2,...>"),
            ]).join('')
        )
        .action(async ({ session, options }, idsString) => {
            const isGlobalOperation = !!options.global; // 重命名变量
            const currentGuildId = session.guildId;

            if (!idsString) return `缺少参数：问答 ID。用法：imgdel ${isGlobalOperation ? '-g ' : ''}${h.text('<ID1,ID2,...>')}`;

            // 解析并验证 ID
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

            let queryFilter: KoishiQuery.Expr<ImageQAMulti>;
            let scopeText: string;
            let findScopeText: string; // 用于查找时描述范围

            if (isGlobalOperation) {
                // -g: 查找所有范围
                queryFilter = { id: { $in: validIds } };
                scopeText = "所有范围";
                findScopeText = "所有范围";
            } else {
                // 默认: 仅限本群
                if (!currentGuildId) return '删除本群问答需在群聊环境。使用 -g 可操作所有范围的问答。';
                queryFilter = { id: { $in: validIds }, guildId: currentGuildId };
                scopeText = "本群";
                findScopeText = "本群";
            }

            try {
                // 查找实际存在的记录
                // 即使是全局操作，我们也需要先确认这些ID是否存在，以及哪些存在
                const recordsToDelete = await ctx.database.get(TABLE_NAME, queryFilter, { fields: ['id', 'guildId'] }); // 获取 guildId 以备日志或更详细反馈

                const idsToDelete = recordsToDelete.map(r => r.id);
                const idsNotFoundOrOutOfScope = validIds.filter(id => !idsToDelete.includes(id));

                if (idsToDelete.length === 0) {
                     // 如果一个都没找到，提供更精确的提示
                    if (isGlobalOperation) {
                         return `指定的 ID (${validIds.join(', ')}) 在所有范围中均未找到。`;
                    } else {
                         // 检查这些 ID 是否存在于其他地方
                         const existsAnywhere = await ctx.database.get(TABLE_NAME, { id: { $in: idsNotFoundOrOutOfScope } }, { fields: ['id'] });
                         if (existsAnywhere.length > 0) {
                             return `指定的 ID (${validIds.join(', ')}) 在本群未找到，但至少有一个存在于其他范围。请使用 -g 操作 (需要权限)。`;
                         } else {
                             return `指定的 ID (${validIds.join(', ')}) 在本群范围内均未找到。`;
                         }
                    }
                }

                // 执行删除
                // 如果是全局操作，删除查询不应包含 guildId 限制
                // 如果是本群操作，删除查询最好还是加上 guildId 限制以防万一（虽然理论上idsToDelete已经是本群的了）
                let removeQuery: KoishiQuery.Expr<ImageQAMulti> = { id: { $in: idsToDelete } };
                if (!isGlobalOperation) {
                    removeQuery.guildId = currentGuildId!;
                }

                const result = await ctx.database.remove(TABLE_NAME, removeQuery);
                const finalScopeText = isGlobalOperation ? "所有相关范围" : "本群"; // 删除操作影响的范围描述
                logger.info(`[删除] 已删除 ${result.removed} 条记录 (IDs: ${idsToDelete.join(', ')}, 操作范围: ${finalScopeText})`);

                let response = `已成功删除 ${result.removed} 条问答 (ID: ${idsToDelete.join(', ')})。`;
                if (idsNotFoundOrOutOfScope.length > 0) {
                    response += `\n以下请求的 ID 未找到或不在查询范围 (${findScopeText}) 内: ${idsNotFoundOrOutOfScope.join(', ')}。`;
                    // 如果是非全局操作且有未找到的ID，可以提示全局查找的可能性
                    if (!isGlobalOperation) {
                         const existsAnywhere = await ctx.database.get(TABLE_NAME, { id: { $in: idsNotFoundOrOutOfScope } }, { fields: ['id'] });
                         if (existsAnywhere.length > 0) {
                            response += ` (其中部分 ID 可能存在于其他范围，可尝试使用 -g 操作)`;
                         }
                    }
                }
                return response;

            } catch (error) {
                logger.error(`[删除] 删除记录失败 (请求IDs: ${validIds.join(',')}, 查询范围: ${findScopeText}): ${error.message}`);
                return `删除失败：数据库操作出错。`;
            }
        });
}