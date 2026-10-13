const assert = require('node:assert/strict');
const {
  hashPassword,
  verifyPassword,
  validateUsername,
  validatePassword,
  userFromBody,
  normalizeUsername,
  parsePasswordHash
} = require('../src/admin-users');

async function main() {
  // 哈希格式与可解析性
  const hash = hashPassword('correct-horse');
  const parts = hash.split('$');
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts.length, 6);
  assert.ok(parsePasswordHash(hash), '自己生成的哈希必须可解析');

  // 正确密码通过、错误密码失败
  assert.equal(verifyPassword('correct-horse', hash), true);
  assert.equal(verifyPassword('wrong-horse', hash), false);
  assert.equal(verifyPassword('', hash), false);

  // 无效哈希不崩溃
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'plaintext-hash'), false);
  assert.equal(verifyPassword('x', 'scrypt$abc'), false);

  // 同一密码两次哈希不同（随机盐）
  assert.notEqual(hashPassword('same-pass'), hashPassword('same-pass'));

  // 用户名校验
  assert.equal(validateUsername('  admin  '), 'admin');
  assert.equal(normalizeUsername('a  b'), 'a b');
  assert.throws(() => validateUsername('ab'), /至少 3 个字符/);
  assert.throws(() => validateUsername('a'.repeat(33)), /最多 32 个字符/);
  assert.throws(() => validateUsername('bad user!'), /只能包含/);

  // 密码校验
  assert.throws(() => validatePassword('short'), /至少 8 个字符/);
  assert.throws(() => validatePassword('has space'), /空白字符/);

  // userFromBody：新建必须带密码
  const created = userFromBody({ username: 'admin', password: 'secret123' });
  assert.equal(created.username, 'admin');
  assert.ok(created.passwordHash.startsWith('scrypt$'));
  assert.equal(created.enabled, true);
  assert.throws(() => userFromBody({ username: 'admin' }), /必须设置密码/);
  assert.throws(() => userFromBody({ username: 'ad', password: 'secret123' }), /至少 3 个字符/);

  // 编辑：留空密码表示保留旧哈希
  const edited = userFromBody({ username: 'admin' }, created);
  assert.equal(edited.passwordHash, created.passwordHash, '留空密码应保留原哈希');
  assert.equal(edited.id, created.id, '编辑保留 ID');
  assert.equal(edited.createdAt, created.createdAt);

  // 编辑：提供新密码则更换哈希
  const rotated = userFromBody({ username: 'admin', password: 'newsecret456' }, created);
  assert.notEqual(rotated.passwordHash, created.passwordHash);
  assert.equal(verifyPassword('newsecret456', rotated.passwordHash), true);
  assert.equal(verifyPassword('secret123', rotated.passwordHash), false);

  // requireLocalLogin 归一化与保留；旧配置中的 remoteMode 字段被忽略
  const { normalizeAdminAuth } = require('../src/config');
  assert.equal(normalizeAdminAuth({ requireLocalLogin: true }).requireLocalLogin, true);
  assert.equal(normalizeAdminAuth({}).requireLocalLogin, false, '缺省为 false');
  assert.equal(normalizeAdminAuth({ requireLocalLogin: 'yes' }).requireLocalLogin, false, '非布尔值不生效');
  assert.equal(normalizeAdminAuth({ remoteMode: 'password', requireLocalLogin: true }).remoteMode, undefined, '旧 remoteMode 字段已移除');

  console.log('admin-users 单元测试全部通过');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
