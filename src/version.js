'use strict';

// 版本号唯一来源：根 package.json（CLI 工具/服务器统一从这里读取）。
// 升级流程：改根 package.json 的 version → app/package.json 与 app/package-lock.json 同步
// （app 是独立 npm 包，version 不从这里读取）→ 跑测试（末尾断言会校验 README 断言数快照）
// → 更新 README 特性快照与发布 checklist。
const VERSION = require('../package.json').version;

module.exports = { VERSION };
