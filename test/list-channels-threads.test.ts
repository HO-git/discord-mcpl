/**
 * listChannels includes active threads. discord.js's guild.channels.fetch()
 * does not return threads, so they are fetched separately
 * (guild.channels.fetchActiveThreads()) and filtered the same way channels are.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { DiscordAdapter } from '../src/discord-adapter.js';

const channel = (id: string, name: string, parentId: string | null = null) => ({ id, name, type: 0, parentId });
const thread = (id: string, name: string, parentId: string) => ({ id, name, type: 11, parentId });

function makeAdapter(opts: {
  channels: ReturnType<typeof channel>[];
  threads: ReturnType<typeof thread>[] | Error;
  guildChannels?: Record<string, string[]>;
}) {
  const adapter = new DiscordAdapter({ token: 'not-used', guildChannels: opts.guildChannels });
  const internals = adapter as unknown as { client: { destroy(): void } };
  internals.client.destroy();
  const guild = {
    id: 'g1',
    name: 'Test Guild',
    channels: {
      // discord.js's live cache holds threads too; resolveChannelRef reads it.
      cache: new Map<string, unknown>([
        ...opts.channels.map((c) => [c.id, c] as const),
        ...(opts.threads instanceof Error ? [] : opts.threads.map((t) => [t.id, t] as const)),
      ]),
      fetch: async () => new Map(opts.channels.map((c) => [c.id, c])),
      fetchActiveThreads: async () => {
        if (opts.threads instanceof Error) throw opts.threads;
        return { threads: new Map(opts.threads.map((t) => [t.id, t])) };
      },
    },
  };
  internals.client = {
    destroy() {},
    guilds: { fetch: async () => guild, cache: new Map([[guild.id, guild]]) },
    user: { id: 'bot_1', username: 'bot', displayName: 'Bot', bot: true },
  } as never;
  return adapter;
}

describe('listChannels: active threads', () => {
  it('lists active threads alongside channels, typed and labelled', async () => {
    const adapter = makeAdapter({
      channels: [channel('c1', 'general')],
      threads: [thread('t1', 'planning', 'c1')],
    });
    const listed = await adapter.listChannels('g1');
    assert.deepEqual(listed.map((c) => c.id), ['c1', 't1']);
    const t = listed.find((c) => c.id === 't1')!;
    assert.equal(t.type, 'thread');
    assert.equal(t.parentId, 'c1');
    assert.equal(t.label, 'discord:g1:t1');
  });

  // A name-based label (`#planning (Test Guild)`) would be unresolvable for a
  // thread — the resolver excludes threads — or, worse, resolve to a regular
  // channel of the same name and send there. The listed address must reach
  // the thread itself.
  it("gives threads an address that resolves to the thread, not a same-named channel", async () => {
    const adapter = makeAdapter({
      channels: [channel('c1', 'general'), channel('c2', 'planning')],
      threads: [thread('t1', 'planning', 'c1')],
    });
    const listed = await adapter.listChannels('g1');
    const t = listed.find((c) => c.id === 't1')!;
    const resolved = adapter.resolveChannelRef(t.label);
    assert.ok(resolved.ok, `thread label ${t.label} did not resolve`);
    assert.equal(resolved.id, 't1');

    // Every listed label round-trips to its own entry.
    for (const c of listed) {
      const r = adapter.resolveChannelRef(c.label);
      assert.ok(r.ok && r.id === c.id, `${c.label} should resolve to ${c.id}`);
    }
  });

  it('applies the channel filter to threads through their parent', async () => {
    const adapter = makeAdapter({
      channels: [channel('c1', 'general'), channel('c2', 'private')],
      threads: [thread('t1', 'allowed-thread', 'c1'), thread('t2', 'hidden-thread', 'c2')],
      guildChannels: { g1: ['c1'] },
    });
    const ids = (await adapter.listChannels('g1')).map((c) => c.id);
    assert.deepEqual(ids, ['c1', 't1']);
  });

  it('still returns the channels if fetching threads fails', async () => {
    const adapter = makeAdapter({
      channels: [channel('c1', 'general')],
      threads: new Error('Missing Access'),
    });
    const ids = (await adapter.listChannels('g1')).map((c) => c.id);
    assert.deepEqual(ids, ['c1']);
  });
});
