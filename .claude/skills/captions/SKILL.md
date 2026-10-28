---
name: captions
description: Caption desk for goofieseyes studio. Writes Facebook and Threads (and sometimes Instagram) captions for scheduled posts marked "needs captions", by looking at their photos and following studio/caption-voice.md, then saves them to the studio. Use when the owner says /captions, "write my captions", or "run the caption desk".
---

# Caption desk

You're writing social captions for goofieseyes, a photographer and creative director. The posts
are already scheduled in the studio (studio.goofieseyes.live) and marked "needs captions". Your
captions go straight into the studio's Queue, where the owner reviews them before they post.

## 1. Read the voice guide
Read `studio/caption-voice.md` in full, every time. It's the source of truth for tone, length,
the invitation at the end, links, and what never to do. If it conflicts with anything below, the
guide wins.

## 2. Pull the posts
Run `node studio/scripts/caption-desk.js pull` from the repo root.
- "Nothing waiting for captions": tell the owner and stop.
- An auth error: the agent token is missing. Say so. On the owner's computer it lives in
  `~/.goofieseyes-studio/agent-token`. In a cloud session it's a network secret for
  `studio.goofieseyes.live` on the environment. Never ask for it to be pasted into chat.
- A photo that fails to download in a cloud session usually means the environment's network
  access doesn't allow `*.public.blob.vercel-storage.com`. Say so and write that post from its
  notes.
- Posts marked **HELD** go out the moment their captions land, so do those first.

## 3. Write each post
For each post, **open every listed image with the Read tool and actually look at it** before
writing. Then use the notes or original Instagram caption as facts, the voice guide for tone, and
the list of recent endings so the invitation is worded freshly.

Write only for the platforms the post lists:
- `facebook`: the full version.
- `threads`: under 500 characters; count them.
- `instagram`: only if the post lists Instagram and has no Instagram link (it didn't come from
  Instagram). Short, art-first, no invitation.

Decide the invitation per post from what's in the photos (creative direction / a shoot /
prints) and say which you chose when you report. Vary the wording across the batch too, not only
against recent posts.

## 4. Save
Write the captions to `caption-desk-out.json` in the system temp folder (the `pull` output names
the folder) as:
```json
[{ "id": "<post id>", "captions": { "facebook": "...", "threads": "..." } }]
```
Then run `node studio/scripts/caption-desk.js push <that file>`. It refuses hashtags and
over-length Threads text; fix anything it reports and push again.

## 5. Report
One short block per post: when it goes out, which invitation you chose, and the first line of the
Facebook caption. Remind the owner they can edit any caption in the studio's Queue before it
posts. Don't paste full captions unless asked.

## Arguments
- `/captions preview`: do steps 1–3 and show the captions in chat **without pushing**. Push only
  when the owner says so.
