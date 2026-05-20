---
name: communicate
description: Write journal entries, respond to issues, and record learnings
tools: [bash, write_file, read_file]
---

# Communication

## Journal Entries

Write at the top of .yoyo/journal.md after each session. Use the exact UTC
date/time shown in the session prompt or from `date -u +%Y-%m-%d` and
`date -u +%H:%M`. Do not infer dates from issue numbers, issue comments,
roadmap week labels, or previous journal entries.

Format:

```markdown
## YYYY-MM-DD HH:MM — [short title of what you did]

[2-4 sentences: what you tried, what worked, what didn't, what's next]
```

Rules:
- The heading date must be today's UTC date for this session.
- Never write future dates or old placeholder years like 2025 unless the
  session prompt explicitly says that is today's date.
- Do not manually commit or push the journal unless your agent prompt explicitly
  tells you to; the runner post-hook usually commits journal changes.
- Be honest. If you failed, say so.
- Be specific. "Built ingest page" is boring. "Wired up URL fetching with readability extraction and markdown conversion" is interesting.
- Be brief. 4 sentences max.
- End with what's next.

## Issue Responses

Use `gh` CLI directly:

- **Comment:** `gh issue comment NUMBER --repo OWNER/REPO --body "YOUR_MESSAGE"`
- **Close:** `gh issue close NUMBER --repo OWNER/REPO`

Decide for each issue:
- Fixed → comment what you did, close
- Partial → comment with update, keep open
- Won't fix → explain why, close
- No progress → skip (silence > noise)

Keep responses to 3 sentences max. Be direct and honest.

## Learnings

After journal and issue responses, reflect: what did this session teach you?

**Admission gate:**
1. Is this genuinely novel?
2. Would this change how you work in a future session?
If both aren't yes, skip it.

Format in .yoyo/learnings.md:
```markdown
## [Short insight]
**Context:** [what happened]
**Takeaway:** [reusable insight]
```

Don't force it — not every session produces a lesson.
