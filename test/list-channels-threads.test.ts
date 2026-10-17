/**
 * list_channels lists a guild's live threads, from the guild's channel cache
 * as it does its channels: the gateway keeps the threads there (GUILD_CREATE,
 * THREAD_LIST_SYNC and the thread events), so listing them fetches nothing
 * that could bypass the freshness rule (refetchChannel). An archived thread
 * isn't listed, nor a stale one, and the channel filter admits a thread
 * through its parent. A thread's label is its `discord:<guild>:<thread>` id,
 * since names don't address threads: a `#name (Guild)` label would not
 * resolve, or would resolve to a channel of the same name.
 *
 * The guild is built with discord.js's own managers, as in
 * registration-lifecycle.test.ts.
 */
import { it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';

const G = '100000000000000001';
const P = '100000000000000002';
const Q = '100000000000000003';
const BOT = '100000000000000004';
const U = '100000000000000005';
const TH = '100000000000000006';
const TQ = '100000000000000007';
const idOf = (channelId: string) => `discord:${G}:${channelId}`;
const bot = { id: BOT, username: 'bot', discriminator: '0', avatar: null };
const channelData = (id: string, name: string) => ({ id, guild_id: G, type: ChannelType.GuildText, name, parent_id: null });
const threadData = (id: string, name: string, parent: string, archived = false) => ({
  id, guild_id: G, type: ChannelType.PublicThread, name, parent_id: parent, owner_id: U,
  thread_metadata: { archived, auto_archive_duration: 60, archive_timestamp: new Date().toISOString(), locked: false },
});

/** A guild with channels P (`general`) and Q (`planning`), and the given
 *  threads, under the given channel filter. */
function fixture(t: TestContext, opts: {
  threads: Array<Record<string, unknown>>;
  guildChannels?: string[];
}) {
  const adapter = new DiscordAdapter({
    token: 'unused',
    ...(opts.guildChannels ? { guildChannels: { [G]: opts.guildChannels } } : {}),
  });
  const client = adapter.rawClient as any;
  t.after(() => client.destroy());
  client.user = client.users._add({ ...bot, bot: true });
  const guild = client.guilds._add({
    id: G, name: 'Guild', owner_id: BOT, roles: [],
    channels: [channelData(P, 'general'), channelData(Q, 'planning')],
  });
  guild.members._add({ user: bot, roles: [] });
  for (const thread of opts.threads) client.channels._add(thread);
  const get = t.mock.method(client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
  return { adapter, client, get };
}

it('list_channels lists live threads from the cache, typed and labelled by id, and fetches nothing', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P)] });
  const listed = await f.adapter.listChannels(G);
  assert.deepEqual(listed.map((c) => c.id).sort(), [P, Q, TH].sort());
  const thread = listed.find((c) => c.id === TH)!;
  assert.equal(thread.type, 'thread');
  assert.equal(thread.name, 'topic');
  assert.equal(thread.parentId, P);
  assert.equal(thread.label, idOf(TH));
  assert.equal(f.get.mock.callCount(), 0, 'no REST call: the gateway keeps the threads in the cache');
});

it("a thread named like a channel is listed by a label that resolves to the thread, not the channel", async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'planning', P)] });
  const listed = await f.adapter.listChannels(G);
  const thread = listed.find((c) => c.id === TH)!;
  const resolved = f.adapter.resolveChannelRef(thread.label);
  assert.ok(resolved.ok, `thread label ${thread.label} did not resolve`);
  assert.equal(resolved.id, TH);
  // Every listed label round-trips to its own entry.
  for (const c of listed) {
    const r = f.adapter.resolveChannelRef(c.label);
    assert.ok(r.ok && r.id === c.id, `${c.label} should resolve to ${c.id}`);
  }
  assert.equal(listed.find((c) => c.id === Q)?.label, '#planning (Guild)', "the channel keeps its name label");
});

it('list_channels leaves out an archived thread', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P), threadData(TQ, 'done', P, true)] });
  const ids = (await f.adapter.listChannels(G)).map((c) => c.id);
  assert.ok(ids.includes(TH));
  assert.ok(!ids.includes(TQ));
});

it('list_channels admits a thread through its parent, as the channel filter does', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'allowed', P), threadData(TQ, 'hidden', Q)], guildChannels: [P] });
  const ids = (await f.adapter.listChannels(G)).map((c) => c.id);
  assert.deepEqual(ids.sort(), [P, TH].sort());
});

it('list_channels leaves out a thread still stale when its fetch fails', async (t) => {
  const f = fixture(t, { threads: [threadData(TH, 'topic', P)] });
  (f.adapter as any).markStale(TH, G);
  const ids = (await f.adapter.listChannels(G)).map((c) => c.id);
  assert.equal(f.adapter.isStale(TH), true);
  assert.deepEqual(ids.sort(), [P, Q].sort());
});
