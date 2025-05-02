// src/commands/delete.ts
import { Context, h } from 'koishi'
import { Config } from '../config'
import { TABLE_NAME, GLOBAL_GUILD_ID } from '../database'
import { name as pluginName } from '../index'

export function registerDeleteCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
    const logger = ctx.logger(pluginName);

    ctx.command(`${pluginName}.delete <IDs:string>`, '删除指定ID的图片问答')
        .alias('删除图片回复', 'imgdel', '删图')
        .option('global', '-g, --global 删除全局问答 (需权限 3)', { authority: 3 })
        .usage(
            h.normalize([
                h.text("删除指定 ID 的图片问答。可以一次提供多个 ID，用逗号分隔。\n"),
                h.text("默认删除当前群聊的问答。使用 -g 选项可删除全局问答 (需要相应权限)。\n"),
                h.text("用法：imgdel [-g] "), h.text("<ID1,ID2,...>"),
            ]).join('')
        )
        .action(async ({ session, options }, idsString) => {
            const isGlobalDelete = !!options.global;
            const currentGuildId = session.guildId;
            if (!isGlobalDelete && !currentGuildId) return '删除本群问答需在群聊环境。使用 -g 可删除全局问答。';
            const targetGuildId = isGlobalDelete ? GLOBAL_GUILD_ID : currentGuildId!;
            const scopeText = isGlobalDelete ? "全局" : "本群";

            if (!idsString) return `缺少参数：问答 ID。用法：imgdel ${isGlobalDelete ? '-g ' : ''}${h.text('<ID1,ID2,...>')}`;

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

            try {
                const recordsToDelete = await ctx.database.get(TABLE_NAME, {
                    id: { $in: validIds }, guildId: targetGuildId,
                }, { fields: ['id'] });

                const idsToDelete = recordsToDelete.map(r => r.id);
                const idsNotFoundInScope = validIds.filter(id => !idsToDelete.includes(id));

                if (idsToDelete.length === 0) {
                    return `指定的 ID (${validIds.join(', ')}) 在 ${scopeText} 范围内均未找到。`;
                }

                const result = await ctx.database.remove(TABLE_NAME, { id: { $in: idsToDelete }, guildId: targetGuildId });
                logger.info(`[删除] 已删除 ${result.removed} 条 ${scopeText} 记录 (IDs: ${idsToDelete.join(', ')})`);

                let response = `已成功删除 ${scopeText} ${result.removed} 条问答 (ID: ${idsToDelete.join(', ')})。`;
                if (idsNotFoundInScope.length > 0) {
                    response += `\n以下请求的 ID 未在 ${scopeText} 找到或已被删除: ${idsNotFoundInScope.join(', ')}。`;
                }
                return response;

            } catch (error) {
                logger.error(`[删除] 删除记录失败 (请求IDs: ${validIds.join(',')}, 范围: ${scopeText}): ${error.message}`);
                return `删除失败：数据库操作出错。`;
            }
        });
}
