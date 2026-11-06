/**
 * internal-sessions.test.mjs — 「内部 worker 会话 → awayNotify 登记」的纯逻辑测试。
 *
 * 这些用例守住四条硬约束（见 lib/internal-sessions.js 头部）：
 *   1. away-notify 未安装 / API 缺失 / 调用抛错 → 静默降级，绝不抛给 worker 创建路径；
 *   2. 增量 + 幂等：重复 register 不会重复声明，release 后不再登记；
 *   3. 服务换实例（away-notify 热重载）→ sync() 丢旧句柄、重新登记；
 *   4. clear() 撤销全部，长期运行不累积。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { InternalSessionClaims, INTERNAL_REASON } from '../lib/internal-sessions.js'

/** 假 awayNotify 服务：记录登记/释放，可注入抛错。 */
function fakeService({ throwOnMark = false } = {}) {
  const calls = []
  const released = []
  return {
    calls,
    released,
    markInternal(sessionId, reason) {
      if (throwOnMark) throw new Error('awayNotify exploded')
      calls.push([sessionId, reason])
      return () => {
        released.push(sessionId)
        return true
      }
    },
  }
}

test('register 登记一次，release 撤销一次（reason 用固定标签）', () => {
  const service = fakeService()
  const registry = new InternalSessionClaims({ service: () => service })

  assert.equal(registry.register('session-w1'), true)
  assert.deepEqual(service.calls, [['session-w1', INTERNAL_REASON]])
  assert.equal(INTERNAL_REASON, 'super-agent-worker')
  assert.equal(registry.size, 1)
  assert.equal(registry.claimed, 1)

  assert.equal(registry.release('session-w1'), true)
  assert.deepEqual(service.released, ['session-w1'])
  assert.equal(registry.size, 0)
  assert.equal(registry.claimed, 0)
});

test('重复 register 幂等：同一会话只向服务声明一次', () => {
  const service = fakeService()
  const registry = new InternalSessionClaims({ service: () => service })
  registry.register('w1')
  registry.register('w1')
  registry.register('w1')
  assert.deepEqual(service.calls, [['w1', INTERNAL_REASON]], '幂等：不能登记出三条声明');
  assert.equal(registry.claimed, 1);
});

test('release 未登记的会话是空操作，重复 release 也只有第一次生效', () => {
  const service = fakeService()
  const registry = new InternalSessionClaims({ service: () => service })
  assert.equal(registry.release('never'), false);
  registry.register('w1')
  assert.equal(registry.release('w1'), true);
  assert.equal(registry.release('w1'), false);
  assert.deepEqual(service.released, ['w1'], '不能重复释放');
});

test('非法 id 不登记', () => {
  const service = fakeService()
  const registry = new InternalSessionClaims({ service: () => service })
  for (const bad of ['', null, 42, undefined]) assert.equal(registry.register(bad), false);
  assert.deepEqual(service.calls, []);
  assert.equal(registry.size, 0);
});

// ── 静默降级 ────────────────────────────────────────────────────────────────

test('away-notify 未安装：register/release 全部静默，不抛', () => {
  const logged = []
  const registry = new InternalSessionClaims({
    service: () => undefined,
    log: (level, message) => logged.push([level, message]),
  })
  assert.doesNotThrow(() => registry.register('w1'));
  assert.equal(registry.size, 1, '仍记入集合，等服务晚到时补登记');
  assert.equal(registry.claimed, 0);
  assert.deepEqual(registry.sync(), 0);
  assert.doesNotThrow(() => registry.release('w1'));
  // 只提示一次，避免每个 worker 刷一行
  registry.register('w2');
  assert.equal(logged.filter(([level]) => level === 'debug').length, 1);
  assert.match(logged[0][1], /awayNotify 不可用/);
});

test('服务没有 markInternal（旧版 away-notify）：静默降级', () => {
  const registry = new InternalSessionClaims({ service: () => ({ version: 1, suppressSession() {} }) });
  assert.doesNotThrow(() => registry.register('w1'));
  assert.equal(registry.size, 1);
  assert.equal(registry.claimed, 0);
});

test('markInternal 抛错：不影响 worker 登记，只记 debug', () => {
  const service = fakeService({ throwOnMark: true })
  const logged = []
  const registry = new InternalSessionClaims({
    service: () => service,
    log: (level, message) => logged.push([level, message]),
  })
  assert.doesNotThrow(() => registry.register('w1'));
  assert.equal(registry.size, 1);
  assert.equal(registry.claimed, 0, '没拿到句柄就不能假装登记成功');
  assert.ok(logged.some(([level, message]) => level === 'debug' && /登记内部会话失败/.test(message)));
});

test('service() 自身抛错也不影响 register', () => {
  const registry = new InternalSessionClaims({
    service: () => {
      throw new Error('service lookup failed')
    },
  })
  assert.doesNotThrow(() => registry.register('w1'));
  assert.equal(registry.claimed, 0);
});

test('release 时第三方 release 抛错不影响调用方', () => {
  const service = {
    markInternal() {
      return () => {
        throw new Error('release exploded')
      }
    },
  }
  const registry = new InternalSessionClaims({ service: () => service })
  registry.register('w1');
  assert.doesNotThrow(() => registry.release('w1'));
  assert.equal(registry.size, 0);
});

// ── 服务晚到 / 换实例 ───────────────────────────────────────────────────────

test('服务晚到：sync() 把活着的会话补登记', () => {
  let service
  const registry = new InternalSessionClaims({ service: () => service })
  registry.register('w1')
  registry.register('w2')
  assert.equal(registry.claimed, 0);

  const late = fakeService()
  service = late
  assert.equal(registry.sync(), 2);
  assert.deepEqual(late.calls.map(([id]) => id).sort(), ['w1', 'w2']);
});

test('服务换实例（away-notify 热重载）：sync() 丢弃旧句柄并重新登记', () => {
  const first = fakeService()
  let current = first
  const registry = new InternalSessionClaims({ service: () => current })
  registry.register('w1');
  assert.equal(first.calls.length, 1);

  const second = fakeService()
  current = second
  assert.equal(registry.sync(), 1, '新实例上应有一条登记');
  assert.deepEqual(second.calls, [['w1', INTERNAL_REASON]]);
  assert.deepEqual(first.released, [], '旧注册表已经没了，不能拿旧句柄去释放');

  registry.release('w1')
  assert.deepEqual(second.released, ['w1'], '释放必须打到当前实例上');
});

test('服务消失后 release 仍然安全（句柄是旧实例的）', () => {
  const service = fakeService()
  let current = service
  const registry = new InternalSessionClaims({ service: () => current })
  registry.register('w1');
  current = undefined
  assert.doesNotThrow(() => registry.release('w1'));
  assert.deepEqual(service.released, ['w1'], '旧句柄的 release 会被调用一次（幂等）');
});

test('clear() 撤销全部登记并清空集合', () => {
  const service = fakeService()
  const registry = new InternalSessionClaims({ service: () => service })
  registry.register('w1')
  registry.register('w2')
  assert.equal(registry.clear(), 2);
  assert.equal(registry.size, 0);
  assert.equal(registry.claimed, 0);
  assert.deepEqual(service.released.sort(), ['w1', 'w2']);
  assert.deepEqual(registry.ids(), []);
});

test('ids() 回显仍然活着的会话', () => {
  const registry = new InternalSessionClaims({ service: () => undefined })
  registry.register('w1')
  registry.register('w2')
  assert.deepEqual(registry.ids().sort(), ['w1', 'w2']);
  registry.release('w1')
  assert.deepEqual(registry.ids(), ['w2']);
});
