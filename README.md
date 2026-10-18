# opencode-tiny-goal

A tiny goal plugin for [opencode](https://opencode.ai) 2.x.

Type `/goal <what to do>` and the agent keeps working until the goal is done. When it stops early, the plugin reminds it with one short line. When it is busy with a subagent or a shell command, the plugin stays quiet.

- **Small.** One short line in the system prompt, one short reminder. No big instruction blocks repeated every turn.
- **The agent is in control.** It can finish, reword, pause or wait on its own goal through a `goal` tool.
- **No nagging.** No reminders while a subagent or a shell command is running, and a circuit breaker stops reminder loops.
- **No dependencies.** Plain TypeScript, loaded by opencode directly.

Targets **opencode 2.x only**. Tested on 2.0.31.

## Install

```bash
opencode plugin add opencode-tiny-goal
```

or straight from GitHub:

```bash
opencode plugin add git+https://github.com/Ciyoxe/opencode-tiny-goal.git
```

This adds the plugin to your global opencode config. Restart opencode afterwards.

## Usage

| Command | Effect |
| --- | --- |
| `/goal <text>` | Set the goal and start working on it |
| `/goal` or `/goal status` | Show the current goal |
| `/goal pause` | Stop reminders without dropping the goal |
| `/goal resume` | Start reminders again |
| `/goal clear` | Drop the goal |

The control commands never start a model turn. They only leave a short note in the session.

### What the agent can do

The agent gets a `goal` tool with these actions:

| Action | Meaning |
| --- | --- |
| `done` | The goal is achieved. Reminders stop. |
| `set` | Replace the goal text with a clearer one. |
| `pause` / `resume` | For the rare case where reminders get in the way, such as needing a decision from you. |
| `wait` | Hold reminders for up to N minutes (max 30 by default), for waiting on something the plugin cannot see. |

## How it works

- **Active goal.** One short line is added to the system prompt of the session you set the goal in. Subagents don't see it.
- **Reminder.** When the agent finishes a turn without finishing the goal, the plugin sends: `[goal] Not done yet: <goal>. Continue, or call goal(done) if it's achieved.`
- **Background work.** No reminders while a subagent session is working or while a shell command started by the session is still running. When they finish, the plugin checks again.
- **Circuit breaker.** If 5 reminders in a row lead to no tool call, the goal is paused and a note says so. Tool calls from subagents count as progress, calls to the `goal` tool do not.
- **Failures and interrupts.** After a failed or interrupted run, the plugin stops reminding until you write a message again.
- **Memory only.** Goals live in memory and are gone after opencode restarts.

## Options

Options go in the plugin entry of your opencode config. Use the object form:

```json
{
    "plugins": [
        {
            "package": "opencode-tiny-goal",
            "options": {
                "maxUnansweredReminders": 5,
                "maxWaitMinutes": 30
            }
        }
    ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `maxUnansweredReminders` | `5` | Reminders in a row without a tool call before the goal is paused |
| `maxWaitMinutes` | `30` | Longest time the agent can hold reminders back with `wait` |

## Caveats

opencode 2.x plugins are still young, and the published plugin types lag behind what the runtime provides. This plugin relies on runtime behaviour I checked on opencode 2.0.31, so a later release may break it. Please open an issue if it does.

Tested against a real opencode: setting a goal, reminders after an early stop, the `goal` tool, the control commands, waiting for a long-running command, installing from a Git source, and options.

Covered only by automated tests, not yet by a real run: subagents, background shell commands, and interrupting with Esc.

## Development

```bash
npm install
npm test            # unit and behaviour tests against a fake opencode
npm run typecheck
```

Running opencode inside this repository loads the plugin from `.opencode/plugins/goal.ts`. Set `GOAL_DEBUG=/path/to/file` to write a debug log of the events the plugin sees.

## License

[WTFPL](LICENSE) — do what the fuck you want to.
