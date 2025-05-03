// src/commands/modify.ts
import { Context, h, Query as KoishiQuery } from 'koishi' // 引入 KoishiQuery
import { Config } from '../config'
import { TABLE_NAME, GLOBAL_GUILD_ID, ImageQAMulti } from '../database'
import { processAndSaveImage } from '../utils'
import { name as pluginName } from '../index'

export function registerModifyCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
  const logger = ctx.logger(pluginName);

  ctx.command(`${pluginName}.modify <id:natural> [...newAnswerContent:text]`, '修改指定ID的图片问答')
    .alias('修改图片回复', 'imgmod', '改图')
    .option('probability', '-p <probability:number> 设置新的回复概率 (0-1)')
    .option('global', '-g, --global 操作所有范围的问答 (需权限 3)', { authority: 3 }) // 修改描述
    .usage(
      h.normalize([
        h.text("修改指定 ID 的图片问答的回答内容或触发概率。\n"),
        h.text("默认修改当前群聊的问答。使用 -g 选项可修改所有范围内的问答 (需要相应权限)。\n"), // 修改描述
        h.text("用法: imgmod [-g] [-p 新概率] "), h.text("<ID>"), h.text(" [新的回答内容...]\n"),
        h.text("必须提供新的回答内容或使用 -p 指定新概率，至少需要修改一项。\n"),
        h.text("回答内容支持特殊语法：\n"),
        h.text("　$$：一个普通的 $ 字符\n"),
        h.text("　$n：换行并分条发送\n"),
        h.text("　$a：@消息发送者\n"),
        h.text("　$m：@机器人自身\n"),
        h.text("　$s：消息发送者的昵称"),
      ]).join('')
    )
    .action(async ({ session, options }, id, newAnswerContent) => {
      if (id === undefined || id <= 0 || !Number.isInteger(id)) {
        return `缺少或无效的参数：问答 ID。用法：imgmod ${options.global ? '-g ' : ''}${options.probability !== undefined ? `-p ${options.probability} ` : ''}${h.text('<ID>')} [新内容]`;
      }

      const isGlobalOperation = !!options.global; // 重命名变量
      const currentGuildId = session.guildId;

      const newAnswerProvided = typeof newAnswerContent === 'string' && newAnswerContent.trim().length > 0;
      const newProbability = options.probability !== undefined ? Number(options.probability) : undefined;

      if (newProbability !== undefined && (isNaN(newProbability) || newProbability < 0 || newProbability > 1)) {
        return '概率必须是 0 到 1 之间的数字。';
      }
      if (!newAnswerProvided && newProbability === undefined) {
        if (typeof newAnswerContent === 'string' && newAnswerContent.length > 0 && newAnswerContent.trim().length === 0) {
          return `操作无效：您提供了只包含空白字符的新回答内容。请提供有效的回答或使用 -p 指定新概率。`;
        }
        return `操作无效：您必须提供新的回答内容或使用 -p 指定新的概率。`;
      }

      let queryFilter: KoishiQuery.Expr<ImageQAMulti>;
      let findScopeText: string;

      if (isGlobalOperation) {
          // -g: 查找所有范围
          queryFilter = { id: id };
          findScopeText = "所有范围";
      } else {
          // 默认: 仅限本群
          if (!currentGuildId) return '修改本群问答需在群聊环境。使用 -g 可操作所有范围的问答。';
          queryFilter = { id: id, guildId: currentGuildId };
          findScopeText = "本群";
      }

      try {
        // 查找记录
        const existingRecords = await ctx.database.get(TABLE_NAME, queryFilter, { limit: 1 }); // 获取完整记录

        if (existingRecords.length === 0) {
            // 如果在本范围找不到，检查全局是否存在（即使未使用-g也检查一下，提供更好提示）
             const existsAnywhereRecords = await ctx.database.get(TABLE_NAME, { id: id }, { limit: 1, fields: ['guildId'] });
             if (existsAnywhereRecords.length > 0) {
                 if(isGlobalOperation){
                    // 如果是全局操作但没找到，说明就是没有
                     return `未找到 ID 为 ${id} 的问答记录。`;
                 } else {
                    // 非全局操作，但在其他地方找到了
                     return `问答 ID ${id} 存在，但不属于本群范围。请使用 -g 选项尝试修改 (需要权限 3)。`;
                 }
             } else {
                 // 哪里都没找到
                 return `未找到 ID 为 ${id} 的问答记录。`;
             }
        }

        const existingRecord = existingRecords[0];
        // 确定记录的实际范围文本
        const recordScopeText = existingRecord.guildId === GLOBAL_GUILD_ID ? "全局" : `群组 ${existingRecord.guildId}`;


        const updateData: Partial<ImageQAMulti> = {};
        let updateDescriptionParts: string[] = [];
        let actualAnswerUpdate = false;
        let actualProbabilityUpdate = false;

        // 处理新回答内容 (逻辑不变)
        if (newAnswerProvided) {
          const parsedElements = h.parse(newAnswerContent);
          const processedNewAnswerElements: h[] = [];
          for (const element of h.normalize(parsedElements)) {
            if (element.type === 'img' && element.attrs.src && !element.attrs.src.startsWith('file://')) {
              try {
                const { localUri } = await processAndSaveImage(ctx, element.attrs.src, element, 'answer', resolvedStoragePath);
                processedNewAnswerElements.push(h.image(localUri));
              } catch (imgProcessingError) {
                logger.error(`[修改] 处理新回答图片失败 (ID: ${id}): ${imgProcessingError.message}`);
                return `修改失败：处理新回答中的图片时出错 (${imgProcessingError.message})。`;
              }
            } else if (element.type !== 'text' || element.attrs.content?.trim()) {
              processedNewAnswerElements.push(element);
            }
          }

          if (processedNewAnswerElements.length === 0) return '错误：处理后的新回答内容为空。';
          const finalSerializedAnswer = processedNewAnswerElements.map(el => el.toString()).join('');

          if (finalSerializedAnswer !== existingRecord.answer) {
            updateData.answer = finalSerializedAnswer; actualAnswerUpdate = true;
            let answerPreview = finalSerializedAnswer.replace(/<image src="file:.*?\/?>/g, '[本地图片]');
            answerPreview = answerPreview.length > 50 ? answerPreview.substring(0, 50) + '...' : answerPreview;
            updateDescriptionParts.push(`回答内容更新为: ${h.escape(answerPreview)}`);
          }
        }

        // 处理新概率 (逻辑不变)
        if (newProbability !== undefined) {
          if (newProbability !== existingRecord.probability) {
            updateData.probability = newProbability; actualProbabilityUpdate = true;
            updateDescriptionParts.push(`概率从 ${existingRecord.probability} 修改为 ${newProbability}`);
          }
        }

        if (!actualAnswerUpdate && !actualProbabilityUpdate) {
          let reason = "";
          if (newAnswerProvided && newProbability !== undefined) reason = "提供的新回答和新概率与当前记录相同。";
          else if (newAnswerProvided) reason = "提供的新回答与当前记录相同。";
          else if (newProbability !== undefined) reason = "提供的新概率与当前记录相同。";
          return `问答 ID ${id} (${recordScopeText}) 未作修改。${reason}`;
        }

        // 执行更新，确保使用记录的原始 id 和 guildId 来定位
        await ctx.database.set(TABLE_NAME, { id: existingRecord.id, guildId: existingRecord.guildId }, updateData);
        logger.info(`[修改] 成功修改记录 ID ${id} (实际记录范围: ${recordScopeText}, 操作触发范围: ${findScopeText})`);
        return `成功修改问答 ID ${id} (记录位于 ${recordScopeText})。\n${updateDescriptionParts.join('\n')}`;

      } catch (error) {
        logger.error(`[修改] 修改记录 ID ${id} (搜索范围: ${findScopeText}) 失败: ${error.message}`);
        return `修改失败：数据库操作出错。`;
      }
    });
}