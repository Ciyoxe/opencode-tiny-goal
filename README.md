# opencode-tiny-goal

Give opencode a goal, and it keeps working until the goal is done.

Works with **opencode 2.x** (tested on 2.0.32).

## Install

```bash
opencode plugin add opencode-tiny-goal
```

Then restart opencode.

## Use

Type `/goal` followed by what you want done:

```
/goal make all tests pass
```

opencode starts working. If it stops before the goal is done, the plugin sends it a short reminder to continue. It stays quiet while opencode is busy with a subagent, and after a subagent finishes it waits for the main agent to pick up the result before pushing again. A command the agent just started, with nothing else called after it, holds reminders back for up to `maxShellMinutes` (5 by default). After that window, or once the agent moves on, reminders keep coming. A push that goes unanswered while a command still runs is repeated at most once per window — after several, the goal pauses like any other ignored goal. No quiet state lasts forever: every reason to hold reminders back expires.

| Command | What it does |
| --- | --- |
| `/goal <text>` | Set a goal and start working |
| `/goal` | Show the current goal |
| `/goal pause` | Stop reminders, keep the goal |
| `/goal resume` | Start reminders again |
| `/goal clear` | Drop the goal |

opencode can also finish, reword or pause the goal on its own when it needs to.

If reminders get ignored 5 times in a row, the goal is paused automatically. Use `/goal resume` to continue.

After a failed or interrupted run the plugin goes quiet, and starts pushing again when you write or when a later run succeeds.

Goals are saved, so they survive a restart of opencode. After a restart the plugin does not wake anything up by itself. The goal carries on the next time you write in that session.

## Settings (optional)

```json
{
    "plugins": [
        {
            "package": "opencode-tiny-goal",
            "options": { "maxUnansweredReminders": 5, "maxWaitMinutes": 30, "maxShellMinutes": 5 }
        }
    ]
}
```

- `maxUnansweredReminders`: how many ignored reminders before the goal is paused (default 5)
- `maxWaitMinutes`: the longest a wait — or a session that keeps looking busy — can hold reminders back (default 30)
- `maxShellMinutes`: the window for a command the agent just started, and how often an ignored push may repeat (default 5)

## Good to know

opencode 2.x plugins are new, and a future opencode update may break this plugin. If it does, please open an issue.

## Development

```bash
npm install
npm test
```

## License

[WTFPL](LICENSE)
