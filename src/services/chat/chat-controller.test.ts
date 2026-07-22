import { describe, expect, it, vi } from 'vitest';

import { conversationId } from '../../domain';
import { ChatController } from './chat-controller';
import { FakeChatService } from './fake-chat-service';

describe('ChatController', () => {
  it('deduplicates duplicate state-advancing submissions', async () => {
    const service = new FakeChatService({
      scenario: 'two-groups',
      latencyMs: 5,
    });
    await service.open({
      storageKey: new Uint8Array(32),
      signal: new AbortController().signal,
    });
    const send = vi.spyOn(service, 'sendMessage');
    const controller = new ChatController(service);
    controller.start();
    const id = conversationId('conversation-primary');
    const abort = new AbortController();
    const first = controller.sendMessage(id, 'one submission', abort.signal);
    const second = controller.sendMessage(id, 'one submission', abort.signal);

    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ text: 'one submission' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(controller.getState().busy).toEqual([]);
  });

  it('ignores service callbacks after stop and sanitizes public errors', async () => {
    const service = new FakeChatService({
      scenario: 'removed-member',
      latencyMs: 5,
    });
    await service.open({
      storageKey: new Uint8Array(32),
      signal: new AbortController().signal,
    });
    const controller = new ChatController(service);
    controller.start();
    const before = controller.getState().snapshot;
    const work = controller.sendMessage(
      conversationId('conversation-primary'),
      'not allowed',
      new AbortController().signal,
    );
    controller.stop();
    await expect(work).rejects.toMatchObject({ code: 'removed_member' });
    expect(controller.getState().snapshot).toBe(before);
    expect(controller.getState().error).toBeUndefined();
    await expect(
      controller.synchronize(new AbortController().signal),
    ).rejects.toThrow('Chat is locked.');
  });
});
