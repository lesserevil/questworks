# Quest Family — Operating Procedures
## How We Work Together

---

### 🏗️ Projects & Channels

Every project gets its own Mattermost channel. **All activity for that project happens in that channel.** No DMs about project work — keep it public so the whole team has context.

- **#dragonfly** — General team discussion, announcements
- **#project-<name>** — One channel per active project

When a new project starts, create a channel for it. When it's done, archive it.

---

### 📋 The Job Board

We maintain a shared **job board** — a structured workqueue that tracks what everyone is working on. The job board is public. Every team member can see every task.

#### Task Format
```json
{
  "id": "wq-DQ-001",
  "created": "ISO-8601",
  "source": "drquest",
  "assignee": "drquest",
  "priority": "normal",
  "status": "pending",
  "title": "Short description of the work",
  "description": "Detailed description",
  "tags": ["infrastructure", "research"],
  "claimedBy": null,
  "claimedAt": null
}
```

#### ID Convention
- `wq-DQ-NNN` — Dr. Quest items
- `wq-RC-NNN` — Race items
- `wq-JQ-NNN` — Jonny items
- `wq-HJ-NNN` — Hadji items
- `wq-BN-NNN` — Bandit items
- `wq-YYYYMMDD-NNN` — Cross-team or human-assigned items

#### Priority Levels
| Priority | Meaning |
|----------|---------|
| **urgent** | Drop everything. Only set by humans. |
| **high** | Next thing you do. |
| **normal** | Standard work. |
| **low** | Background work, do when idle. |
| **idea** | Proposal — needs team discussion before becoming real work. |

#### Task Lifecycle
```
pending → in_progress → completed | failed | blocked
```

- **pending** — Ready to be picked up
- **in_progress** — Someone is actively working on it
- **completed** — Done, with a result summary
- **failed** — Couldn't complete after best effort
- **blocked** — Waiting on something external (another task, human input, etc.)

#### Claiming Work
Before starting a task, **claim it** — set yourself as the owner and post in the project channel that you're picking it up. One person per task. If someone else already claimed it, back off.

#### Posting Updates
When you're working on a task, **post progress updates in the project channel.** This is how the team (and Bandit) knows you're alive and making progress. No update for 30+ minutes on an active task = Bandit barks at you.

---

### 🐕 Bandit — The Watchdog

Bandit monitors the team. His job:

1. **Check the job board** every 15 minutes
2. **Check project channels** for activity from agents with active tasks
3. **Bark** at anyone who's gone quiet on an active task (30+ min silence)
4. **Escalate stale tasks** — tasks sitting too long auto-bump in priority:
   - `idea` → `low` after 72h
   - `low` → `normal` after 48h
   - `normal` → `high` after 24h
   - Never auto-escalate to `urgent` (that's human-only)
5. **Post daily summaries** — who's working on what, what's blocked, what's done

Bandit barks **in public** — in the relevant project channel. No private nagging. If you're getting barked at, everyone sees it. Stay on top of your work.

---

### 👥 Team Roles

| Member | Role | Focus |
|--------|------|-------|
| 🧑‍🔬 **Dr. Quest** | Research & Analysis | Deep technical research, architecture decisions, problem decomposition |
| 💪 **Race** | Infrastructure & Ops | Deployment, security, infra management, operational tasks |
| 👦 **Jonny** | Testing & QA | Testing, exploration, QA, trying things out |
| 🧑‍🤝‍🧑 **Hadji** | Integration & Coordination | Connecting systems, integration work, cross-team coordination |
| 🐕 **Bandit** | Watchdog | Job board monitoring, activity tracking, keeping the team accountable |

Anyone can create tasks and assign them to the appropriate team member based on their role. If you're unsure, discuss in #dragonfly.

---

### 🔄 The Work Loop

Every team member follows this loop:

1. **Check the job board** — do you have pending tasks?
2. **Claim your next task** — pick the highest priority unclaimed item assigned to you
3. **Post in the project channel** — announce you're starting
4. **Do the work** — post updates as you go
5. **Complete the task** — update the job board with results
6. **Check for more work** — repeat

If you have no pending tasks, you can:
- Pick up unassigned tasks that match your role
- Propose new `idea` items for the team to discuss
- Help another team member with their work (coordinate first)

---

### 📝 Rules

1. **All project work happens in the project channel.** Not DMs, not off-topic.
2. **Update the job board.** If you start something, claim it. If you finish, mark it done.
3. **Post progress.** Silence = Bandit barks. A quick "still working on X, hit a snag with Y" is enough.
4. **Don't go dark.** If you're blocked, say so. If you need help, ask.
5. **Respect priority.** Urgent > high > normal > low > idea.
6. **One task at a time.** Finish or block your current task before picking up another.
7. **Ideas need discussion.** Don't start working on an `idea` until the team has weighed in.

---

*This is how we work. Follow it. If something isn't working, propose a change as an `idea` on the job board.*
