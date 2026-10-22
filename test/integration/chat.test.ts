import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffUser, createTestApp, registerUser, TEST_ADMIN, login, type TestContext } from '../helpers/app.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

describe('live chat', () => {
  it('starts one conversation per user and keeps it open', async () => {
    const user = await registerUser(ctx);
    const first = await user.client.post('/api/v1/chat', { subject: 'Butuh bantuan' });
    expect(first.status).toBe(201);
    const second = await user.client.post('/api/v1/chat', { subject: 'Lagi' });
    expect(second.status).toBe(201);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
  });

  it('deduplicates a retried message with the same clientId', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/chat', { subject: 'Retry test' });
    const id = created.body.conversation.id as string;
    const payload = { body: 'Halo', clientId: 'client-abc-123' };
    const first = await user.client.post(`/api/v1/chat/${id}/messages`, payload);
    expect(first.status).toBe(201);
    const again = await user.client.post(`/api/v1/chat/${id}/messages`, payload);
    expect(again.status).toBe(201);
    expect(again.body.message.id).toBe(first.body.message.id);
    const count = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ?', id);
    expect(Number(count?.n)).toBe(1);
  });

  it('lets staff reply and the user read it, while hiding internal notes', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/chat', { subject: 'Deposit' });
    const id = created.body.conversation.id as string;
    await user.client.post(`/api/v1/chat/${id}/messages`, { body: 'Bagaimana deposit?' });

    const staff = await createStaffUser(ctx, 'support');
    const inbox = await staff.client.get('/api/v1/admin/chat');
    expect(inbox.status).toBe(200);
    const row = (inbox.body.conversations as Array<{ id: string }>).find((item) => item.id === id);
    expect(row).toBeTruthy();

    const reply = await staff.client.post(`/api/v1/admin/chat/${id}/messages`, { body: 'Lewat QRIS ya.' });
    expect(reply.status).toBe(201);
    const note = await staff.client.post(`/api/v1/admin/chat/${id}/messages`, {
      body: 'User ini sedang cek manual',
      internal: true,
    });
    expect(note.status).toBe(201);

    const thread = await user.client.get(`/api/v1/chat/${id}/messages`);
    expect(thread.status).toBe(200);
    const bodies = (thread.body.messages as Array<{ body: string }>).map((m) => m.body);
    expect(bodies).toContain('Lewat QRIS ya.');
    expect(bodies).not.toContain('User ini sedang cek manual');
  });

  it("does not let one user read another user's conversation", async () => {
    const owner = await registerUser(ctx);
    const other = await registerUser(ctx);
    const created = await owner.client.post('/api/v1/chat', { subject: 'Privat' });
    const id = created.body.conversation.id as string;
    const res = await other.client.get(`/api/v1/chat/${id}/messages`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHAT_FORBIDDEN');
  });

  it('lets staff change status and priority', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/chat', { subject: 'Prioritas' });
    const id = created.body.conversation.id as string;
    const staff = await login(ctx, TEST_ADMIN.email, TEST_ADMIN.password);
    const priority = await staff.post(`/api/v1/admin/chat/${id}/priority`, { priority: 'high' });
    expect(priority.status).toBe(200);
    expect(priority.body.conversation.priority).toBe('high');
    const status = await staff.post(`/api/v1/admin/chat/${id}/status`, { status: 'closed' });
    expect(status.status).toBe(200);
    expect(status.body.conversation.status).toBe('closed');
    const send = await user.client.post(`/api/v1/chat/${id}/messages`, { body: 'Halo lagi' });
    // a closed thread is read-only: the user is pushed to start a new conversation
    expect(send.status).toBe(403);
  });

  it('rejects empty/oversized messages and unknown conversations', async () => {
    const user = await registerUser(ctx);
    const created = await user.client.post('/api/v1/chat', { subject: 'Validasi' });
    const id = created.body.conversation.id as string;
    const empty = await user.client.post(`/api/v1/chat/${id}/messages`, { body: '   ' });
    expect(empty.status).toBe(400);
    const huge = await user.client.post(`/api/v1/chat/${id}/messages`, { body: 'x'.repeat(2_001) });
    expect(huge.status).toBe(400);
    const unknown = await user.client.post('/api/v1/chat/does-not-exist/messages', { body: 'hi' });
    expect([403, 404]).toContain(unknown.status);
    expect(unknown.body.error.code).toMatch(/CHAT_FORBIDDEN|NOT_FOUND/);
  });
});
