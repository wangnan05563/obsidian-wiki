import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VaultService } from '../vault/vault-service.js';

// 注册 Vault 管理路由。
//   POST /api/vault/init   初始化 Vault 目录结构
//
// install.ps1 已覆盖命令行初始化，此 API 提供程序化初始化能力（如 Web 向导）。
// 使用已注入的 vault 实例（与 index.ts 中构造的是同一个），保证一致性。
export function registerVaultRoute(app: FastifyInstance, vault: VaultService) {
  app.post('/api/vault/init', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await vault.init();
      return reply.send({ ok: true, vaultPath: vault.getVaultPath() });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
