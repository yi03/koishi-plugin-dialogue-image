// src/commands/index.ts
import { Context } from 'koishi';
// 从上级目录导入 Config 类型
import { Config } from '../config';
// 从同级目录导入各个命令的注册函数
import { registerAddCommand } from './add';
import { registerListCommand } from './list';
import { registerDeleteCommand } from './delete';
import { registerDeleteAllCommand } from './deleteAll';
import { registerQueryCommand } from './query';
import { registerClearCommand } from './clear';
import { registerModifyCommand } from './modify';

export function registerCommands(ctx: Context, config: Config, resolvedStoragePath: string) {
    registerAddCommand(ctx, config, resolvedStoragePath);
    registerListCommand(ctx, config, resolvedStoragePath);
    registerDeleteCommand(ctx, config, resolvedStoragePath);
    registerDeleteAllCommand(ctx, config, resolvedStoragePath);
    registerQueryCommand(ctx, config, resolvedStoragePath);
    registerClearCommand(ctx, config, resolvedStoragePath);
    registerModifyCommand(ctx, config, resolvedStoragePath);
}