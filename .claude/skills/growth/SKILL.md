---
name: growth
description: Growth desk for goofieseyes. Studies the Instagram accounts on the owner's watch list (creative directors and agencies a step ahead) to learn how they grow and sell without looking like a business, turns that into plays for goofieseyes, and researches audit requests from goofieseyes.live/audit into draft audits. Use when the owner says /growth, "run the growth desk", "check my watch list", "look up @someone", "give me talking-to-camera ideas", or "any audit requests?".
---

# Growth desk

goofieseyes is a creative director's studio: ideas, shoots and edits for businesses, run by one
person whose Instagram is an artist's account first. This desk helps it grow by studying people
who've done it, and by turning audit requests into clients. It runs only when the owner asks.

The owner sees the desk's work on the studio's **Growth tab** (studio.goofieseyes.live): audit
requests, account lookups, and the tips this desk sends at the end of each `/growth` run.

Everything lives in the **growth folder**, `~/claude-workspace/Sorian Systems/goofieseyes growth/`
(or `GROWTH_DIR`): `watch-list.md`, `playbook.md`, `funnel.md`, `reports/`, `audits/` and `data/`
(raw lookups the script writes). goofieseyes business work belongs in Sorian Systems, so don't put
these in the repo.

## Hard rules
- **Read-only on Instagram.** The desk looks; it never posts, likes, follows, comments or messages
  anyone. Nothing here sends DMs or emails: the owner sends every message.
- **Never handle the agent token.** If the script says it's missing, say where it goes (as the
  caption desk does) and stop. Never ask for it in chat.
- **Ad Library by hand, small.** Ads come from the public Meta Ad Library website
  (facebook.com/ads/library) in the built-in browser, a few businesses per session. Meta's terms
  forbid automated scraping, so never loop over it.
- **Study, don't copy.** Plays describe patterns (structure, rhythm, how the offer is framed), never
  someone's words, footage or captions lifted for goofieseyes.
- **Keep the artist first.** goofieseyes should read as a person making things. Anything that would
  turn the account into an ad feed gets flagged, not recommended.

## /growth  (or /growth watch): study the watch list
1. Read `watch-list.md`, `playbook.md` and the newest file in `reports/`, so this run builds on
   the last one instead of starting over.
2. Run `node studio/scripts/growth-desk.js watch` from the repo root. Each account comes back with
   followers, posting pace, format mix, median engagement, the captions that do business ($ lines)
   and the breakouts (↑ lines: posts at twice the account's median or more).
   - "wasn't found, or it's a personal account": note it in the report; only business and creator
     accounts can be looked up. Suggest the owner check the handle.
   - Engagement is likes + comments. Meta doesn't give views for other people's posts, and some
     accounts hide likes, so compare each account against itself, not against others.
3. For the breakouts and the business posts, open the raw JSON (path printed as `saved:`) and read
   the full captions. Work out, per account:
   - **How they sell without selling:** the share of posts that do business, what the call to
     action sounds like, where the offer lives (bio, link, a comment keyword, a story highlight).
   - **What breaks out:** format, the first line, topic, personal vs. work. Is the breakout a
     personal post that the business rides on?
   - **The bio:** how it leads with the person and still points at the work.
   - **Changes since last time:** compare with earlier files in `data/<username>/`.
4. Look up goofieseyes itself the same way if it's on the list, and compare.
5. Write `reports/<YYYY-MM-DD>.md`: one section per account (numbers, then what you noticed, with
   links to the posts you mean), then **Plays for goofieseyes**: 3–5 specific things to try in
   the next two weeks, each with why (which account and post it came from) and what it would look
   like on goofieseyes. At least one should be a post idea the owner could shoot this week.
6. Update `playbook.md`: add plays that keep showing up across accounts or runs, and mark ones the
   owner tried, with how they did if the owner says. Keep it short; it's the running summary.
   Run `growth-desk.js tips` first: it shows what the owner marked on the Growth tab (tried,
   skip, how it went), so carry those marks into the playbook.
7. Send the tips to the studio's Growth tab, where the owner reads them on their phone. Write
   `reports/<YYYY-MM-DD>.tips.json` and run `growth-desk.js tips reports/<YYYY-MM-DD>.tips.json`
   (path relative to the growth folder, or absolute):
   ```json
   { "report": "2026-11-05",
     "tips": [{ "title": "Open reels on your face, not the work",
                "why": "Jade's three breakouts this month all open on her talking to camera…",
                "idea": "Film 5 seconds of you at the Gravity Vault hang saying why you shot the tiger…",
                "kind": "post",
                "from": [{ "username": "jade.got.curious", "permalink": "https://www.instagram.com/p/…" }] }] }
   ```
   - The list is this run's plays (3–5) plus the playbook plays still worth trying, 10 at most.
     It replaces what's there. Keep a tip's **title exactly the same** across runs, or the
     owner's mark on it is lost.
   - `kind` is `talk` (a talk-to-camera video, see below), `post` (something else to shoot),
     `habit` (rhythm, replies, stories), `offer` (how the business side is framed) or `profile`
     (bio, highlights, link).
   - **Include 2–3 `talk` tips every run.** The owner is strong at artistic, visual work and
     wants to post more of themself talking to camera. Give each one a `script` outline:
     `{ "hook": "the first line, said in the first 2 seconds", "beats": ["2–4 points to hit"],
     "length": "30–45 s" }`. An outline to speak from, not a script to read: short beats in
     the owner's plain voice, about things only they can say (a shoot they did, why a shot works,
     a mistake, an opinion on local business content). Base the shape on watch-list accounts'
     talking posts (how the first line is phrased, how long, how it ends, where the offer comes
     in, if it does), and name that post in `why`.
   - `why` names the account and what it did, in a sentence or two. `idea` is what it looks like
     on goofieseyes, concretely enough to do this week. Patterns, never their captions.
   - Leave out tips the owner marked `skip`, unless something changed.
8. Report in chat: the 3–5 plays and the one or two numbers that matter most. Don't paste the
   whole report.

## /growth talk: talk-to-camera ideas
For when the owner wants something to film now.
1. Run `growth-desk.js tips` to see what's on the Growth tab, and read the newest files in
   `data/` (run `watch` first if they're older than two weeks).
2. Find the watch list's talking videos. The API gives no views or transcripts, and the desk can't
   watch the videos, so work from the captions and formats: reels whose captions read as speech,
   start with "I", "Here's", "Stop", a question or a story, or say "storytime", "my take",
   "lessons", "tips". Say which posts you went on, and that it's from captions, so the owner can
   watch the ones that matter.
3. Write 5 `talk` ideas, as in step 7 above, with `script` outlines. Mix them: one about a real
   goofieseyes shoot, one "why this shot works", one honest or behind-the-scenes, one opinion on
   business content, and one that ends with the soft invitation from `funnel.md`.
4. Add them to the Growth tab: send the current tips plus these together (`tips <file>` replaces
   the list), keeping existing titles unchanged.
5. In chat, give the five titles and opening lines only.

## /growth lookup @username
Run `node studio/scripts/growth-desk.js lookup <username>` and give a short read of the account:
is it worth watching, and what's the one thing to learn from it. If the owner wants it watched, add
`- @username — why` to `watch-list.md`.

## /growth leads: turn audit requests into audits
1. Run `node studio/scripts/growth-desk.js leads`. Nothing new: say so and stop.
2. For each new request:
   - `growth-desk.js lookup <their instagram>` for their posting pace, formats, engagement and
     what breaks out for them.
   - Their website, if they gave one: what they sell, who to, and how video is used (or not).
   - The Ad Library in the built-in browser: search the business name; note whether they run ads
     and what the creative looks like (stock, flyers, real footage). Take one screenshot at most.
3. Write `audits/<business-name>.md` from `funnel.md` → "The audit": what's working, what's
   costing them, three concepts specific to them, and a short script for the owner's walkthrough
   video. Write it to the business owner, in the owner's plain voice: specific, kind, no jargon,
   no hard sell.
4. Mark it: `growth-desk.js lead <id> researched "<one line on what you found>"`.
5. Report: each business, the strongest concept, and that the audit is ready for the owner to record and
   send. When the owner says one's sent, mark it `sent`; after a call, `call`; signed, `client`; dead, `closed`.

## /growth add @username — why
Append the line to `watch-list.md` and run a lookup on it.
