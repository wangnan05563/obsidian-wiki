import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import type { VaultService } from '../vault/vault-service.js';

export function registerSchemaRoutes(app: FastifyInstance, vault: VaultService) {
  app.get('/api/schema', async (_request, reply) => {
    try {
      const content = await vault.readFile('SCHEMA.md');
      return reply.send({ content });
    } catch (err: unknown) {
      return reply.code(404).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.put('/api/schema', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { content?: string };
    if (!body || typeof body.content !== 'string') {
      return reply.code(400).send({ error: '请求体须含 content 字段' });
    }
    try {
      const full = path.resolve(vault.getVaultPath(), 'SCHEMA.md');
      await fs.writeFile(full, body.content, 'utf8');
      return reply.send({ ok: true });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}