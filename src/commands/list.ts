// src/commands/list.ts
import { Context, h, $, Query } from 'koishi'
import { Config } from '../config'
import { TABLE_NAME, GLOBAL_GUILD_ID, ImageQAMulti } from '../database'
import { name as pluginName } from '../index'

export function registerListCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
    const logger = ctx.logger(pluginName);

    ctx.command(`${pluginName}.list`, '查看图片问答列表')
        .alias('图片回复列表', 'imglist', '图列')
        .option('page', '-p <page:natural> 页码 (从 1 开始)', { fallback: 1 })
        .option('size', '-s <size:natural> 每页条数', { fallback: 10 })
        .option('globalOnly', '-G, --global-only 仅显示全局问答')
        .option('guildOnly', '--guild-only 仅显示本群问答 (需在群内使用)')
        .option('all', '-a, --all 查看所有范围的问答 (需权限 3)', { authority: 3 })
        .usage(
            h.normalize([
                h.text("查看已添加的图片问答。\n"),
                h.text("显示本群及全局问答，在私聊中仅显示全局问答。\n"),
                h.text("可以使用选项筛选范围：-G (仅全局), --guild-only (仅本群), -a (所有,需权限)。\n"),
                h.text("用法: imglist [-p 页码] [-s 条数] [范围选项]"),
            ]).join('')
        )
        .action(async ({ session, options }) => {
            const currentGuildId = session.guildId;
            if (options.all && (options.guildOnly || options.globalOnly)) return '不能同时使用 --all 和 --guild-only 或 --global-only 选项。';
            if (options.guildOnly && !currentGuildId) return '使用 --guild-only 选项需要在群聊环境中使用。';
            if (options.globalOnly && options.guildOnly) return '不能同时使用 --global-only 和 --guild-only 选项。';

            const limit = Math.max(1, Number(options.size));
            const offset = (Math.max(1, Number(options.page)) - 1) * limit;

            const query: Query.Expr<ImageQAMulti> = {};
            let scopeDescription = "";
            let filterInfo = "";

            // 构建查询条件和描述文本
            if (options.all) {
                scopeDescription = "所有范围"; filterInfo = ' (所有范围)';
            } else if (options.globalOnly) {
                query.guildId = GLOBAL_GUILD_ID; scopeDescription = "全局"; filterInfo = ' (仅全局)';
            } else if (options.guildOnly) {
                query.guildId = currentGuildId!; scopeDescription = `本群`; filterInfo = ' (仅本群)';
            } else { // 默认情况
                if (currentGuildId) { // 群聊中：本群+全局
                    query.$or = [{ guildId: currentGuildId }, { guildId: GLOBAL_GUILD_ID }];
                    scopeDescription = `本群及全局`; filterInfo = ' (本群及全局)';
                } else { // 私聊中：仅全局
                    query.guildId = GLOBAL_GUILD_ID; scopeDescription = "全局"; filterInfo = ' (全局)';
                }
            }

            try {
                const list = await ctx.database.get(TABLE_NAME, query, {
                    limit, offset, fields: ['id', 'guildId', 'imageHash', 'answer', 'probability'],
                    sort: { guildId: 'asc', imageHash: 'asc', id: 'asc' } // 稳定排序
                });
                const total = await ctx.database.eval(TABLE_NAME, (row) => $.count(row.id), query);
                const totalNum = Number(total);

                if (totalNum === 0) return `在 ${scopeDescription} 范围内还没有任何图片问答。`;

                const output = list.map(item => {
                    let displayAnswer = item.answer.replace(/<image.*?>/g, '[图片]');
                    displayAnswer = displayAnswer.length > 30 ? displayAnswer.substring(0, 30) + '...' : displayAnswer;

                    let scopeLabel: string;
                    if (item.guildId === GLOBAL_GUILD_ID) {
                        scopeLabel = '全局';
                    } else if (item.guildId) { // Check if guildId exists and is not the global one
                        scopeLabel = `群${item.guildId}`;
                    } else {
                        scopeLabel = '群未知'; // Fallback if guildId is somehow missing
                    }

                    return `ID:${item.id} | hash:${item.imageHash.substring(0, 6)} | [${scopeLabel}] | P:${item.probability} | A:${h.escape(displayAnswer)}`;
                }).join('\n');

                const totalPages = Math.ceil(totalNum / limit);
                const pageInfo = `第 ${options.page}/${totalPages} 页，共 ${totalNum} 条`;

                return `${scopeDescription} 图片问答列表：\n${output}\n\n${pageInfo}${filterInfo}\n(使用 imgget ${h.text('<ID>')} 可查询问答的问题图片)`;

            } catch (dbError) {
                logger.error(`[列表] 查询数据库出错: ${dbError.message}`);
                return '查询问答列表时数据库出错。';
            }
        });
}
