const fs = require('node:fs');
const path = require('node:path');

function prepareUserData(appData) {
  const target = path.join(appData, 'Sakura-AI-Gateway Electron');
  if (fs.existsSync(target)) return target;
  // 旧名称仅用于一次性迁移。完整复制后原子切换，保留旧目录且不覆盖已有新配置。
  const legacy = ['Local Model Gateway Electron', 'local-model-gateway-electron']
    .map((name) => path.join(appData, name)).find((directory) => fs.existsSync(directory));
  if (!legacy) {
    fs.mkdirSync(target, { recursive: true });
    return target;
  }
  const staging = fs.mkdtempSync(path.join(appData, '.sakura-ai-gateway-migrate-'));
  try {
    fs.cpSync(legacy, staging, { recursive: true, errorOnExist: true, force: false });
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

module.exports = { prepareUserData };