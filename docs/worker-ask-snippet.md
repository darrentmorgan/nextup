# Worker ask snippet

Paste this into a worker brief or dispatch template, for workers that have an ask tool (for example `ask_darren` from `plugin/hooks/elicit/demo/`):

> When you are blocked on a decision only Darren can make, call the ask tool once instead of asking in chat. One question, 2 to 4 options, recommended option first. Never put a key, token or password in a question. Then continue with the answer. If the answer is cancelled, stop and report that you are blocked.

Coverage is thin by design: a question typed into chat is not seen by Next up. Only workers that call the ask tool raise a card.
