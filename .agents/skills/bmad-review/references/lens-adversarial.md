# Adversarial Lens

Conduct a review of the provided content.
Look for what's missing, not only what's wrong.
Report what is real — never pad to look thorough.
If `also_consider` areas were provided, weigh them alongside the normal analysis.
If the content is empty, stop and say so.
If you have zero findings, stop and say so — an empty list is a valid review.

## Findings shape

Emit each finding with the canonical fields:

- `location` — where in the content (file:line for code, section or heading for documents, "general" when it spans the whole artifact)
- `trigger_condition` — the problem, in one line
- `guard_snippet` — the concrete fix or improvement
- `potential_consequence` — what goes wrong if it ships unaddressed

No severity, priority, or ranking.
