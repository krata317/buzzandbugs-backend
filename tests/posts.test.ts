import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import {
  bearer,
  createPost,
  createReply,
  createUser,
  getApp,
  richDoc,
  vote,
} from './helpers/app.js';
import {
  openAiModerationProvider,
  setModerationProviderForTests,
} from '../src/modules/moderation/provider.js';

const approveEverything = {
  name: 'test-approve',
  isConfigured: () => true,
  check: async () => ({ flagged: false, categories: {}, scores: {} }),
};

describe('buzz posts', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    setModerationProviderForTests(openAiModerationProvider);
  });

  it('creates a post with a shareable url that does not contain the username', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'author' });

    const created = await createPost(app, author.token, {
      title: 'Shipping a backend',
      text: 'A long body that belongs in the detail view.',
    });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${created.id}` });
    expect(detail.statusCode).toBe(200);

    const body = detail.json().data;
    expect(body.title).toBe('Shipping a backend');
    expect(body.content.type).toBe('doc');
    expect(body.url).toContain(`/posts/${created.id}`);
    expect(body.url).not.toContain('author');
    expect(body.author.username).toBe('author');
  });

  it('returns excerpts in the feed and full content in the detail endpoint', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'excerpt' });
    const longText = 'word '.repeat(200);

    await createPost(app, author.token, { title: 'Long read', text: longText });

    const feed = await app.inject({ method: 'GET', url: '/api/v1/feed' });
    expect(feed.statusCode).toBe(200);
    const item = feed.json().data[0];
    expect(item.excerpt.length).toBeLessThanOrEqual(281);
    expect(item.content).toBeUndefined();

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${item.id}` });
    expect(detail.json().data.content).toBeDefined();
  });

  it('rejects unsupported rich text nodes, unsafe links and bad font sizes', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'richtext' });

    const badNode = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: {
        title: 'Bad',
        content: { type: 'doc', content: [{ type: 'script', attrs: { src: 'x' } }] },
      },
    });
    expect(badNode.statusCode).toBe(400);

    const badLink = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: {
        title: 'Bad link',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'click',
                  marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                },
              ],
            },
          ],
        },
      },
    });
    expect(badLink.statusCode).toBe(400);

    const badSize = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: {
        title: 'Bad size',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'big',
                  marks: [{ type: 'fontSize', attrs: { size: '900px' } }],
                },
              ],
            },
          ],
        },
      },
    });
    expect(badSize.statusCode).toBe(400);

    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: {
        title: 'Good',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
                {
                  type: 'text',
                  text: ' link',
                  marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
                },
              ],
            },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
                },
              ],
            },
          ],
        },
      },
    });
    expect(good.statusCode).toBe(201);
  });

  it('requires a title and a body for normal posts', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'required' });

    const noBody = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: { title: 'Only a title' },
    });
    expect(noBody.statusCode).toBe(400);

    const noTitle = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: { content: richDoc('body') },
    });
    expect(noTitle.statusCode).toBe(400);
  });

  it('lets the author edit and delete a post, and keeps the score unchanged', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'editor' });
    const reader = await createUser({ username: 'reader' });

    const post = await createPost(app, author.token, { title: 'Before', text: 'Old body' });
    await vote(app, reader.token, post.id, 1);

    setModerationProviderForTests(approveEverything);
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/posts/${post.id}`,
      headers: bearer(author.token),
      payload: { title: 'After', content: richDoc('New body') },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().data.title).toBe('After');
    expect(edit.json().data.isEdited).toBe(true);
    expect(edit.json().data.score).toBe(1);

    const strangerEdit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/posts/${post.id}`,
      headers: bearer(reader.token),
      payload: { title: 'Hijacked' },
    });
    expect(strangerEdit.statusCode).toBe(403);

    const deletion = await app.inject({
      method: 'DELETE',
      url: `/api/v1/posts/${post.id}`,
      headers: bearer(author.token),
    });
    expect(deletion.statusCode).toBe(200);

    const gone = await app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it('refuses an edit that fails the content check', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'flagged' });
    const post = await createPost(app, author.token, { title: 'Fine', text: 'Body' });

    setModerationProviderForTests({
      name: 'test-flag',
      isConfigured: () => true,
      check: async () => ({ flagged: true, categories: { hate: true }, scores: { hate: 0.99 } }),
    });

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/posts/${post.id}`,
      headers: bearer(author.token),
      payload: { content: richDoc('Something bad') },
    });
    expect(edit.statusCode).toBe(422);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}` });
    expect(detail.json().data.title).toBe('Fine');
  });

  it('stores mention ids and renders the current display name', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'mentioner' });
    const mentioned = await createUser({ username: 'mentioned', displayName: 'Old Name' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: {
        title: 'Hello there',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Hi ' },
                { type: 'mention', attrs: { id: mentioned.id } },
              ],
            },
          ],
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const postId = create.json().data.id as string;

    await prisma.user.update({ where: { id: mentioned.id }, data: { displayName: 'New Name' } });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` });
    const node = detail.json().data.content.content[0].content[1];
    expect(node.type).toBe('mention');
    expect(node.attrs.id).toBe(mentioned.id);
    expect(node.attrs.label).toBe('New Name');

    const stored = await prisma.post.findUnique({ where: { id: postId } });
    expect(JSON.stringify(stored?.content)).not.toContain('Old Name');
    // The feed renders the stored excerpt, so a mention must survive as @username there.
    expect(stored?.excerpt).toContain('@mentioned');

    const notification = await prisma.notification.findFirst({
      where: { userId: mentioned.id, type: 'mention' },
    });
    expect(notification).toBeTruthy();
  });

  it('returns posts in strict reverse-chronological order regardless of follows', async () => {
    const app = await getApp();
    const viewer = await createUser({ username: 'viewer' });
    const followed = await createUser({ username: 'followed' });
    const stranger = await createUser({ username: 'stranger' });

    await createPost(app, stranger.token, { title: 'Stranger 1', text: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createPost(app, followed.token, { title: 'Followed 1', text: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createPost(app, stranger.token, { title: 'Stranger 2', text: 'c' });

    const follow = await app.inject({
      method: 'POST',
      url: '/api/v1/users/followed/follow',
      headers: bearer(viewer.token),
    });
    expect(follow.statusCode).toBe(200);

    const feed = await app.inject({
      method: 'GET',
      url: '/api/v1/feed',
      headers: bearer(viewer.token),
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.json().data.map((post: { title: string }) => post.title)).toEqual([
      'Stranger 2',
      'Followed 1',
      'Stranger 1',
    ]);

    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v1/feed?limit=2',
      headers: bearer(viewer.token),
    });
    const cursor = page1.json().meta.nextCursor as string;
    expect(cursor).toBeTruthy();

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/feed?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: bearer(viewer.token),
    });

    const ids = [...page1.json().data, ...page2.json().data].map((post: { id: string }) => post.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(3);
  });

  it('creates a repost that references the original and hides it after deletion', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'original' });
    const reposter = await createUser({ username: 'reposter' });

    const original = await createPost(app, author.token, {
      title: 'Original',
      text: 'Original body',
    });

    const repost = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(reposter.token),
      payload: { title: 'My take', content: richDoc('Worth reading'), repostOfId: original.id },
    });
    expect(repost.statusCode).toBe(201);
    const repostId = repost.json().data.id as string;

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${repostId}` });
    expect(detail.json().data.kind).toBe('REPOST');
    expect(detail.json().data.repostOf.id).toBe(original.id);
    expect(detail.json().data.repostOf.available).toBe(true);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/posts/${original.id}`,
      headers: bearer(author.token),
    });

    const afterDeletion = await app.inject({ method: 'GET', url: `/api/v1/posts/${repostId}` });
    expect(afterDeletion.statusCode).toBe(200);
    expect(afterDeletion.json().data.repostOf.available).toBe(false);
    expect(afterDeletion.json().data.repostOf.title).toBe('');
  });

  it('changes and retracts a vote without corrupting the score', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'voted' });
    const voter = await createUser({ username: 'voter' });
    const post = await createPost(app, author.token, { title: 'Vote', text: 'Body' });

    const up = await vote(app, voter.token, post.id, 1);
    expect(up.json().data).toEqual({ score: 1, viewerVote: 1 });

    const down = await vote(app, voter.token, post.id, -1);
    expect(down.json().data).toEqual({ score: -1, viewerVote: -1 });

    const retract = await vote(app, voter.token, post.id, 0);
    expect(retract.json().data).toEqual({ score: 0, viewerVote: 0 });

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.score).toBe(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${post.id}`,
      headers: bearer(voter.token),
    });
    expect(detail.json().data.viewerVote).toBe(0);
  });

  it('keeps the score consistent under concurrent votes', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'popular' });
    const post = await createPost(app, author.token, { title: 'Concurrent', text: 'Body' });

    const voters = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createUser({ username: `voter${index}` })),
    );

    const results = await Promise.all(voters.map((voter) => vote(app, voter.token, post.id, 1)));
    expect(results.every((response) => response.statusCode === 200)).toBe(true);

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.score).toBe(8);

    const voteRows = await prisma.vote.count({ where: { postId: post.id } });
    expect(voteRows).toBe(8);

    // Repeated identical votes are idempotent and must not inflate the score.
    await Promise.all(voters.map((voter) => vote(app, voter.token, post.id, 1)));
    const afterRepeat = await prisma.post.findUnique({ where: { id: post.id } });
    expect(afterRepeat?.score).toBe(8);
  });

  it('supports nested replies and enforces the ten reply limit transactionally', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'rootposter' });
    const replier = await createUser({ username: 'replier' });
    const post = await createPost(app, author.token, { title: 'Replies', text: 'Body' });

    const first = await createReply(app, replier.token, post.id, 'first');
    const nested = await createReply(app, replier.token, post.id, 'nested', first.id);

    const replies = await app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}/replies` });
    expect(replies.json().data.length).toBe(2);
    const nestedDto = replies.json().data.find((reply: { id: string }) => reply.id === nested.id);
    expect(nestedDto.depth).toBe(2);

    const remaining = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/posts/${post.id}/replies`,
          headers: bearer(replier.token),
          payload: { content: richDoc(`extra ${index}`) },
        }),
      ),
    );

    const created = remaining.filter((response) => response.statusCode === 201);
    const rejected = remaining.filter((response) => response.statusCode === 429);
    expect(created.length).toBe(8);
    expect(rejected.length).toBe(4);

    const total = await prisma.reply.count({
      where: { postId: post.id, authorId: replier.id, deletedAt: null },
    });
    expect(total).toBe(10);

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.replyCount).toBe(10);

    const deletion = await app.inject({
      method: 'DELETE',
      url: `/api/v1/replies/${nested.id}`,
      headers: bearer(replier.token),
    });
    expect(deletion.statusCode).toBe(200);

    const afterDelete = await createReply(app, replier.token, post.id, 'freed slot');
    expect(afterDelete.id).toBeTruthy();
  });

  it('limits each user to five posts per hour including reposts', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'spammy' });
    const original = await createUser({ username: 'target' });
    const targetPost = await createPost(app, original.token, { title: 'Target', text: 'Body' });

    for (let index = 0; index < 5; index += 1) {
      await createPost(app, author.token, { title: `Post ${index}`, text: 'Body' });
    }

    const sixth = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: { title: 'Sixth', content: richDoc('Body') },
    });
    expect(sixth.statusCode).toBe(429);

    const repost = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: { title: 'Repost', repostOfId: targetPost.id },
    });
    expect(repost.statusCode).toBe(429);
  });

  it('applies blocking to replies, votes, reposts, follows and mentions', async () => {
    const app = await getApp();
    const blocker = await createUser({ username: 'blocker' });
    const blocked = await createUser({ username: 'blocked' });

    const post = await createPost(app, blocker.token, { title: 'Mine', text: 'Body' });
    await createPost(app, blocked.token, { title: 'Theirs', text: 'Body' });

    const block = await app.inject({
      method: 'POST',
      url: '/api/v1/users/blocker/block',
      headers: bearer(blocked.token),
    });
    expect(block.statusCode).toBe(200);

    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/replies`,
      headers: bearer(blocked.token),
      payload: { content: richDoc('hello') },
    });
    expect(reply.statusCode).toBe(403);

    const reaction = await vote(app, blocked.token, post.id, 1);
    expect(reaction.statusCode).toBe(403);

    const repost = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(blocked.token),
      payload: { title: 'Repost', repostOfId: post.id },
    });
    expect(repost.statusCode).toBe(403);

    const follow = await app.inject({
      method: 'POST',
      url: '/api/v1/users/blocker/follow',
      headers: bearer(blocked.token),
    });
    expect(follow.statusCode).toBe(403);

    const mention = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(blocked.token),
      payload: {
        title: 'Mention attempt',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'hey ' },
                { type: 'mention', attrs: { id: blocker.id } },
              ],
            },
          ],
        },
      },
    });
    expect(mention.statusCode).toBe(403);

    const feed = await app.inject({
      method: 'GET',
      url: '/api/v1/feed',
      headers: bearer(blocker.token),
    });
    expect(feed.json().data.some((item: { title: string }) => item.title === 'Theirs')).toBe(false);
  });
});
