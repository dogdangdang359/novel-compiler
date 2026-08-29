'use strict';

// 命令行解析辅助：带值选项（--reader/--model/--out/--from 等）的缺值统一检查。
// 各 CLI 工具共用，避免每个工具各自实现缺值判定（旧实现只有 --reader 有检查，
// 其他带值选项缺值时静默得到 undefined——如 --canon 缺值会被静默当成"无基线"）。

/**
 * 取选项值：args[i+1] 作为值。缺值（选项在末尾，或下一个参数是另一选项）时报错退出 2。
 * @param {string[]} args 完整参数数组
 * @param {number} i 当前选项在 args 中的下标
 * @param {string} flag 选项名（用于报错文案，如 '--model'）
 * @param {string} [hint] 期望值提示（如 '<webnovel|genre|published>'），缺省不显示
 * @returns {string} 选项值（调用方自行 i++ 跳过值）
 */
function takeValue(args, i, flag, hint) {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`✗ ${flag} 缺少参数值${hint ? `（${flag} ${hint}）` : ''}`);
    process.exit(2);
  }
  return v;
}

module.exports = { takeValue };
