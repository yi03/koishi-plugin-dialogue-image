// src/commands/query.ts
import { Context, h, Session, Query as KoishiQuery } from 'koishi'
import { Config } from '../config'
import { TABLE_NAME, GLOBAL_GUILD_ID, ImageQAMulti } from '../database'
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Jimp } from 'jimp';
import { isGif } from '../utils';
import { name as pluginName } from '../index'

/**
 * 从 URL 获取图片 Buffer。
 */
async function getImageBufferFromUrl(ctx: Context, url: string): Promise<Buffer | null> {
    const logger = ctx.logger(`${pluginName}/util/image`);
    try {
        if (!url) throw new Error('URL is empty or invalid');

        if (url.startsWith('file://')) {
            const filePath = decodeURIComponent(url.startsWith('file:///') ? url.substring(8) : url.substring(7));
            const resolvedPath = path.resolve(filePath);
            return await fs.readFile(resolvedPath);
        }
        else if (url.startsWith('http://') || url.startsWith('https://')) {
            const response = await ctx.http.get(url, {
                timeout: 10000,
                responseType: 'arraybuffer'
            });
            return Buffer.from(response);
        }
        else if (url.startsWith('data:image/')) {
            const base64Data = url.split(',')[1];
            if (base64Data) {
                return Buffer.from(base64Data, 'base64');
            } else {
                throw new Error('Invalid base64 data URI format');
            }
        }
        else {
            throw new Error(`Unsupported image URL scheme: ${url.substring(0, 50)}...`);
        }
    } catch (error) {
        logger.warn('获取图片 Buffer 失败 (%s): %c', url, error.message);
        return null;
    }
}


/**
 * 处理根据 ID 查询问答的逻辑。
 */
async function handleIdQuery(session: Session, options: any, id: number, ctx: Context, config: Config, resolvedStoragePath: string) {
    const logger = ctx.logger(`${pluginName}/query/id`);
    const currentGuildId = session.guildId;

    try {
        let query: KoishiQuery.Expr<ImageQAMulti>;
        let searchDescription: string;

        if (options.global) {
            query = { id: id };
            searchDescription = "所有范围";
        } else {
            const potentialGuildIds = currentGuildId ? [currentGuildId, GLOBAL_GUILD_ID] : [GLOBAL_GUILD_ID];
            query = { id: id, guildId: { $in: potentialGuildIds } };
            searchDescription = currentGuildId ? "本群及全局" : "全局";
        }

        const records = await ctx.database.get(TABLE_NAME, query);

        if (!records.length) {
            const existsAnywhereQuery: KoishiQuery.Expr<ImageQAMulti> = { id: id };
            const existsAnywhere = await ctx.database.get(TABLE_NAME, existsAnywhereQuery, { limit: 1, fields: ['guildId'] });

            if (existsAnywhere.length > 0 && !options.global) {
                return `问答 ID ${id} 存在，但不属于您当前可访问的范围 (${searchDescription})。尝试使用 -g 选项查询 (需要权限 3)。`;
            } else {
                return `未找到 ID 为 ${id} 的图片问答记录。`;
            }
        }

        const record = (!options.global && currentGuildId)
            ? records.find(r => r.guildId === currentGuildId) || records[0]
            : records[0];

        const scopeText = record.guildId === GLOBAL_GUILD_ID
            ? "全局"
            : (record.guildId === currentGuildId ? "本群" : `群组 ${record.guildId}`);
        const imageHash = record.imageHash;
        const hashPrefix = imageHash ? imageHash.substring(0, 8) : '未知';
        const filename = record.imageFilename;

        if (!filename) {
            logger.warn(`记录 (ID: ${id}, 范围: ${scopeText}) 缺少 imageFilename`);
            return `找到 ${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...)，但数据库记录中缺少关联的问题图片文件名信息。`;
        }

        const localImagePath = path.join(resolvedStoragePath, filename);
        try {
            await fs.access(localImagePath);
            const absolutePath = path.resolve(localImagePath);
            const fileUriPath = path.sep === '\\' ? '/' + absolutePath.replace(/\\/g, '/') : absolutePath;
            const fileUri = 'file://' + fileUriPath;

            await session.send(h.normalize([
                h.text(`${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...) 的问题图片 (${h.escape(filename)}):`),
                h.image(fileUri)
            ]));
            return; // 成功发送后返回

        } catch (fileError) {
            if (fileError.code === 'ENOENT') {
                // logger.warn(`问题图片文件未找到 (ID: ${id}, 文件: ${filename}, 路径: ${localImagePath})`); // 可选保留
                return `找到 ${scopeText} 问答 ID ${id} (QHash: ${hashPrefix}...)，但其对应的问题图片文件 (${h.escape(filename)}) 在存储路径中未找到。`;
            } else {
                logger.error('访问问题图片文件出错 (ID: %s, 文件: %s): %c', id, filename, fileError.message);
                return `找到 ${scopeText} 问答 ID ${id}，但在访问其图片文件 (${h.escape(filename)}) 时服务器遇到错误。`;
            }
        }
    } catch (dbError) {
        logger.error('查询数据库出错 (ID: %s): %c', id, dbError.message);
        return `查询问答 ID ${id} 时数据库发生错误。`;
    }
}

/**
 * 处理根据引用图片查询问答的逻辑。
 */
async function handleImageQuery(session: Session, options: any, imageUrl: string, ctx: Context, config: Config) {
    const logger = ctx.logger(`${pluginName}/query/image`);
    const currentGuildId = session.guildId;

    // 1. 获取图片 Buffer
    const imageBuffer = await getImageBufferFromUrl(ctx, imageUrl);
    if (!imageBuffer) {
        return `无法获取或处理引用的图片数据。请确保图片可访问或格式受支持。`;
    }

    // 2. 计算哈希
    let imageHash: string;
    let hashType: 'md5' | 'phash';
    try {
        if (isGif(imageBuffer)) {
            hashType = 'md5';
            imageHash = crypto.createHash('md5').update(imageBuffer).digest('hex');
        } else {
            hashType = 'phash';
            try {
                if (typeof Jimp === 'undefined' || typeof Jimp.read !== 'function') {
                    throw new Error('Jimp library is not available or not loaded correctly.');
                }
                const image = await Jimp.read(imageBuffer);
                imageHash = image.hash(16); // 使用 base 16
            } catch (jimpError) {
                logger.error('使用 Jimp 计算 pHash 失败: %c', jimpError.message);
                if (jimpError.message?.includes('Unsupported MIME type') || jimpError.message?.includes('Could not find MIME') || jimpError.message?.includes('Decoder')) {
                    return `无法处理引用的图片格式 (Jimp 不支持)，无法计算 pHash。`;
                } else if (jimpError.message?.includes('Jimp library is not available')) {
                    return `[内部错误] Jimp 库未正确加载，无法计算 pHash。`;
                }
                return `处理引用图片时出错 (Jimp 错误)，无法计算 pHash。`;
            }
        }
        if (!imageHash) {
            throw new Error(`未能成功计算图片哈希 (${hashType})`);
        }

    } catch (hashError) {
        logger.error('计算哈希过程中发生错误: %c', hashError.message);
        return `计算引用图片的哈希值时发生错误。`;
    }

    const hashPrefix = imageHash.substring(0, 8);

    // 3. 构建数据库查询
    try {
        let query: KoishiQuery.Expr<ImageQAMulti>;
        let searchDescription: string;

        if (options.global) {
            query = { imageHash: imageHash };
            searchDescription = "所有范围";
        } else {
            const potentialGuildIds = currentGuildId ? [currentGuildId, GLOBAL_GUILD_ID] : [GLOBAL_GUILD_ID];
            query = { imageHash: imageHash, guildId: { $in: potentialGuildIds } };
            searchDescription = currentGuildId ? "本群及全局" : "全局";
        }

        // 4. 查询数据库
        const records = await ctx.database.get(TABLE_NAME, query);

        // 5. 处理结果
        if (!records.length) {
            const existsAnywhereQuery: KoishiQuery.Expr<ImageQAMulti> = { imageHash: imageHash };
            const existsAnywhere = await ctx.database.get(TABLE_NAME, existsAnywhereQuery, { limit: 1, fields: ['guildId'] });

            if (existsAnywhere.length > 0 && !options.global) {
                return `图片 (QHash: ${hashPrefix}... 类型: ${hashType}) 存在关联问答，但不属于您当前可访问的范围 (${searchDescription})。尝试使用 -g 选项查询 (需要权限 3)。`;
            } else {
                return `未找到与此图片 (QHash: ${hashPrefix}... 类型: ${hashType}) 关联的问答记录。`;
            }
        }

        // 6. 格式化并发送回答列表
        const answers = records.map((record, index) => {
            const scopeText = record.guildId === GLOBAL_GUILD_ID
                ? "全局"
                : (record.guildId === currentGuildId ? "本群" : `群组 ${record.guildId}`);
            const answerPreview = record.answer.length > 100 ? record.answer.substring(0, 97) + '...' : record.answer;
            return `${index + 1}. [${scopeText}, ID: ${record.id}] ${h.escape(answerPreview)}`;
        });

        await session.send(h.normalize([
            h.text(`查询图片 (QHash: ${hashPrefix}... 类型: ${hashType}) 找到以下 ${records.length} 个回答 (${searchDescription}范围):\n`),
            h.text(answers.join('\n'))
        ]));
        return; // 成功发送后返回

    } catch (dbError) {
        logger.error('查询数据库出错 (QHash: %s, Type: %s): %c', hashPrefix, hashType, dbError.message);
        return `根据图片查询问答时数据库发生错误。`;
    }
}


/**
 * 注册查询命令。
 */
export function registerQueryCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
    const baseLogger = ctx.logger(pluginName);

    ctx.command(`${pluginName}.query [target:text]`, '查询图片问答的问题图片或回答列表')
        .alias('查询问答', 'imgquery', '查问答')
        .option('global', '-g, --global 查看任意范围的问答 (需权限 3)', { authority: 3 })
        .usage( // 参照 imgadd 风格修改 Usage 说明
            h.normalize([
                h.text("查询图片问答信息，可根据 ID 查询问题图片，或根据图片查询回答列表。\n"),
                h.text(`用法1 (根据 ID 查问题图片):\n`),
                h.text(`  ${pluginName}.query <ID> [-g]\n`),
                h.text(`  示例: ${pluginName}.query 123\n`),
                h.text(`用法2 (根据图片查回答列表):\n`),
                h.text(`  [回复包含问题的图片] ${pluginName}.query [-g]\n`),
                h.text(`  示例: (回复一张图片) ${pluginName}.query\n`),
                h.text("选项说明:\n"),
                h.text("  -g, --global: 查询所有范围的问答 (需要权限 3)。\n"),
            ]).join('')
        )
        .action(async ({ session, options, args }) => {
            const target = args[0];
            const quote = session.quote;

            let imageUrl: string | undefined;
            let isQueryingByImage = false;

            // 检查引用消息中是否有图片
            const quotedImageElement = quote?.elements?.find(e => e.type === 'image');
            if (quotedImageElement) {
                imageUrl = quotedImageElement.attrs.src || quotedImageElement.attrs.url;
                if (imageUrl) {
                    isQueryingByImage = true;
                }
            }

            // 检查参数是否像图片标签 (作为备用)
            if (!isQueryingByImage && target && typeof target === 'string' && target.trim().startsWith('<img')) {
                const srcMatch = target.match(/src="([^"]+)"/);
                const urlMatch = target.match(/url="([^"]+)"/);
                imageUrl = srcMatch?.[1] || urlMatch?.[1];
                if (imageUrl) {
                    isQueryingByImage = true;
                }
            }

            // 执行查询
            if (isQueryingByImage && imageUrl) {
                // 执行图片查询
                return await handleImageQuery(session, options, imageUrl, ctx, config);
            }
            else if (target && !isQueryingByImage) {
                // 尝试将参数作为 ID 处理
                const id = parseInt(target, 10);
                if (id > 0 && Number.isInteger(id)) {
                    // 执行 ID 查询
                    return await handleIdQuery(session, options, id, ctx, config, resolvedStoragePath);
                } else {
                    return h.normalize([
                        h.text(`无效的参数：${h.escape(target)}。`),
                        h.text(`请输入有效的问答 ID (正整数) 或通过引用图片进行查询。\n\n`),
                        h.text('参见帮助信息：'),
                        h.text(`\`help ${pluginName}.query\``)
                    ]).join('');
                }
            }
            else {
                // 缺少有效参数或引用
                return h.normalize([
                    h.text(`缺少参数或无法识别引用的图片。`),
                    h.text(`请提供问答 ID 或引用一张图片进行查询。\n\n`),
                    h.text('参见帮助信息：'),
                    h.text(`\`help ${pluginName}.query\``)
                ]).join('');
            }
        });
}
