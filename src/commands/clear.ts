// src/commands/clear.ts
import { Context, h } from 'koishi'
import { Config } from '../config'
import { TABLE_NAME, BATCH_SIZE_FOR_CLEAR, KNOWN_IMAGE_EXTENSIONS } from '../database'
import { ensureDirExists } from '../utils'
import { promises as fs } from 'fs';
import path from 'path';
import { URL } from 'url';
import { name as pluginName } from '../index'

export function registerClearCommand(ctx: Context, config: Config, resolvedStoragePath: string) {
    const logger = ctx.logger(pluginName);

    ctx.command(`${pluginName}.clear`, '清理本地存储中未被引用的图片', { authority: 3 })
        .alias('清理图片缓存', 'imgclear')
        .option('confirm', '-y, --confirm 必须确认执行此危险操作')
        .usage(
            h.normalize([
                h.text(`扫描配置的图片存储目录 (${config.storagePath})，并删除数据库中不再引用的图片文件。\n`),
                h.text("此操作会永久删除文件且不可逆，请务必谨慎！\n"),
                h.text("需要权限等级 3，并且必须使用 -y 或 --confirm 选项确认执行。\n"),
                h.text("用法: imgclear -y"),
            ]).join('')
        )
        .action(async ({ session, options }) => {
            if (!options.confirm) return '危险操作！此命令会永久删除本地图片文件。请添加 -y 或 --confirm 选项确认执行清理。';

            logger.info(`[清理] 开始清理 '${resolvedStoragePath}' 目录中未引用的图片...`);
            session.send(`正在扫描数据库记录和本地图片文件 (${resolvedStoragePath})，请稍候...`).catch(logger.warn);

            const referencedFilenames = new Set<string>();
            let filesOnDisk: string[] = [];
            let deletedCount = 0;
            let failedToDelete: { filename: string; error: string }[] = [];
            let skippedCount = 0; // 跳过的非图片文件或目录

            try {
                // 1: 扫描数据库，收集引用的文件名
                logger.info('[清理] 阶段 1: 查询数据库引用的文件名...');
                let offset = 0;
                while (true) {
                    const batch = await ctx.database.get(TABLE_NAME, {}, {
                        limit: BATCH_SIZE_FOR_CLEAR, offset, fields: ['id', 'imageFilename', 'answer']
                    });
                    if (batch.length === 0) break;

                    for (const record of batch) {
                        if (record.imageFilename) referencedFilenames.add(record.imageFilename);
                        // 解析回答内容，提取本地图片文件名
                        if (record.answer) {
                            try {
                                h.select(h.parse(record.answer), 'img').forEach(img => {
                                    const src = img.attrs.src;
                                    if (src?.startsWith('file://')) {
                                        try {
                                            const url = new URL(src);
                                            let imagePath = decodeURIComponent(url.pathname);
                                            // 处理 Windows 路径: file:///C:/... -> C:/...
                                            if (process.platform === 'win32' && imagePath.match(/^\/[a-zA-Z]:\//)) {
                                                imagePath = imagePath.substring(1);
                                            }
                                            const filename = path.basename(imagePath);
                                            if (filename) referencedFilenames.add(filename);
                                        } catch (uriError) {
                                            logger.warn(`[清理] 解析回答中的图片URI失败 (ID: ${record.id}, URI: ${src}): ${uriError.message}`);
                                        }
                                    }
                                });
                            } catch (parseError) {
                                logger.warn(`[清理] 解析回答内容失败 (ID: ${record.id}): ${parseError.message}`);
                            }
                        }
                    }
                    offset += batch.length;
                }
                logger.info(`[清理] 阶段 1: 完成，发现 ${referencedFilenames.size} 个唯一引用的本地文件名。`);

                // 2: 读取本地存储目录
                logger.info(`[清理] 阶段 2: 读取本地目录 '${resolvedStoragePath}'...`);
                try {
                    await ensureDirExists(resolvedStoragePath, logger); // 确保目录存在
                    filesOnDisk = await fs.readdir(resolvedStoragePath);
                    logger.info(`[清理] 阶段 2: 本地找到 ${filesOnDisk.length} 个文件或目录。`);
                } catch (readDirError) {
                    if (readDirError.code === 'ENOENT') {
                        logger.info(`[清理] 目录 '${resolvedStoragePath}' 不存在，无需清理。`);
                        return `配置的图片存储目录 (${resolvedStoragePath}) 不存在，无需清理。`;
                    }
                    logger.error(`[清理] 读取存储目录失败: ${readDirError.message}`); throw readDirError;
                }

                // 3: 对比并删除未引用文件
                logger.info(`[清理] 阶段 3: 对比并删除未引用的图片文件...`);
                const filesToDelete = filesOnDisk.filter(filename => !referencedFilenames.has(filename));

                if (filesToDelete.length === 0) {
                    logger.info('[清理] 没有找到可清理的未引用图片文件。');
                    return '扫描完成，没有找到可清理的未引用图片文件。';
                }
                logger.info(`[清理] 发现 ${filesToDelete.length} 个可能未引用的文件，开始过滤和删除...`);

                for (const filename of filesToDelete) {
                    const filePath = path.join(resolvedStoragePath, filename);
                    try {
                        const stats = await fs.stat(filePath);
                        // 跳过目录和非已知图片扩展名的文件
                        if (!stats.isFile() || !KNOWN_IMAGE_EXTENSIONS.includes(path.extname(filename).toLowerCase())) {
                            skippedCount++; continue;
                        }
                        await fs.unlink(filePath); // 删除文件
                        deletedCount++;
                    } catch (deleteError) {
                        if (deleteError.code !== 'ENOENT') { // Ignore files that might have been deleted between readdir and unlink
                            logger.error(`[清理] 删除文件 ${filePath} 失败: ${deleteError.message}`);
                            failedToDelete.push({ filename, error: deleteError.message });
                        }
                    }
                }

                // 4: 生成报告
                logger.info(`[清理] 完成。删除: ${deletedCount}, 失败: ${failedToDelete.length}, 跳过: ${skippedCount}`);
                let report = `图片清理完成 (${resolvedStoragePath})！\n`;
                report += `- 数据库共引用 ${referencedFilenames.size} 个本地文件。\n`;
                report += `- 本地扫描到 ${filesOnDisk.length} 项。\n`;
                report += `- 成功删除未引用图片 ${deletedCount} 个。`;
                if (skippedCount > 0) report += `\n- 跳过 ${skippedCount} 个非图片文件或目录。`;
                if (failedToDelete.length > 0) report += `\n- 删除失败 ${failedToDelete.length} 个 (详情见控制台日志)。`;
                return report;

            } catch (error) {
                logger.error(`[清理] 清理过程中发生严重错误: ${error.message}`, error.stack);
                return `清理过程中发生严重错误，操作可能未完全执行。详情请查看控制台日志。`;
            }
        });
}
