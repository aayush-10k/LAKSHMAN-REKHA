# SETUP.md — From Empty Repo to Everyone Working

Read this once, all three of you, before anyone types anything.

**Where you are:** empty GitHub repo, nothing else.
**Where this gets you:** all three able to start A1 / B1 / C1 in parallel without stepping on each other.

Roles from BUILD.md Part 6:
- **Person A** — contracts, crypto, policy core
- **Person B** — agents, simulation, services
- **Person C** — frontend, product, demo

---

## PART 1 — INSTALL (all three, on your own machine)

Install these, then run the verify command. If a verify command errors, fix it before moving on — a broken tool now becomes a mystery bug later.

| Tool | Install | Verify |
|---|---|---|
| **Node.js 20+** | nodejs.org, LTS installer | `node -v` → v20.x or higher |
| **pnpm** | `npm install -g pnpm` | `pnpm -v` → 9.x |
| **Git** | git-scm.com | `git --version` |
| **VS Code** | code.visualstudio.com | opens |
| **Python 3.11+** | python.org | `python3 --version` |
| **Docker Desktop** | docker.com | `docker --version` |

**Person A also needs Foundry:**
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
forge --version
```
(On Windows, do this inside WSL2. Solidity tooling on native Windows will waste your time.)

**Person B also needs:**
```bash
pip install uv          # fast Python package manager
uv --version
```

### Tell git who you are (all three, once)

```bash
git config --global user.name "Your Name"
git config --global user.email "your@email.com"
```

Use the same email as your GitHub account, or your commits won't show up as yours — and the organisers review commit history, so this matters.

### VS Code extensions (all three)

- **GitLens** — shows you who wrote each line and what branch you're on
- **ESLint**, **Prettier**
- A: **Solidity** (Nomic Foundation)
- B: **Python** (Microsoft)
- C: **Tailwind CSS IntelliSense**

---

## PART 2 — PERSON A: SCAFFOLD THE REPO (do this alone, once)

**Only Person A does this.** B and C wait. If two people scaffold, you get a mess that takes an hour to untangle.

### 2.1 Clone the empty repo

```bash
cd ~/projects          # or wherever you keep code
git clone https://github.com/YOUR-ORG/lakshman-rekha.git
cd lakshman-rekha
```

### 2.2 Create the folder skeleton

```bash
mkdir -p apps/web apps/core/src/{policy,lease,signing,explain,api,events}
mkdir -p apps/agents/{shopper,adversary,extractor} apps/vendorsim
mkdir -p contracts/{src,test,script}
mkdir -p packages/contracts-abi docs

# git ignores empty folders, so drop a placeholder in each
find apps contracts packages docs -type d -empty -exec touch {}/.gitkeep \;
```

### 2.3 Create the root files

**`.gitignore`** — get this right before your first commit. Committing `node_modules` or a `.env` is painful to undo.

```gitignore
node_modules/
.pnpm-store/
dist/
build/
.next/
out/

.env
.env.local
.env.*.local
*.key
*.pem

contracts/out/
contracts/cache/
contracts/broadcast/

__pycache__/
*.pyc
.venv/
venv/

.DS_Store
.vscode/settings.json
*.log
```

**`pnpm-workspace.yaml`**
```yaml
packages:
  - 'apps/web'
  - 'apps/core'
  - 'packages/*'
```

**`package.json`**
```json
{
  "name": "lakshman-rekha",
  "private": true,
  "scripts": {
    "dev:web": "pnpm --filter web dev",
    "dev:core": "pnpm --filter core dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  },
  "packageManager": "pnpm@9.0.0"
}
```

**`.env.example`** — the template. Real secrets go in `.env`, which is gitignored. **Never put a real key in `.env.example`.**
```bash
# Chain
BASE_SEPOLIA_RPC=https://sepolia.base.org
DEPLOYER_PRIVATE_KEY=
BASESCAN_API_KEY=

# Models
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Database
DATABASE_URL=

# Core
CORE_SIGNER_PRIVATE_KEY=
LEASE_TTL_MS=5000
```

**`README.md`**
```markdown
# Lakshman Rekha

Spend enforcement for autonomous AI agents.
InnovaHack Chapter 1 · Round 2 · FinTech PS2

## Docs
- `BUILD.md` — the full build plan
- `docs/API.md` — frozen interfaces. Read before writing code.
- `SETUP.md` — first-time setup

## Run locally
```bash
pnpm install
cp .env.example .env    # fill it in
pnpm dev:web
```

## Demo credentials
(filled in before submission)
```

### 2.4 Copy in the docs

Put `BUILD.md` and `SETUP.md` at the root, and `API.md` in `docs/`.

### 2.5 First commit and push

```bash
git add .
git commit -m "chore: scaffold monorepo, docs, and workspace config"
git branch -M main
git push -u origin main
```

### 2.6 GitHub settings — Person A, in the browser

1. **Settings → Collaborators → Add people**
   - Add B and C
   - **Add `aadityajauhari01@gmail.com`** — submission requirement, do it now
2. **Settings → Branches → Add branch protection rule**
   - Branch name pattern: `main`
   - ✅ Require a pull request before merging
   - ✅ Require approvals: **1**
   - ❌ Leave "Require status checks" off for now
   - This means: **nobody can push straight to main.** That's deliberate — it's what stops one person accidentally overwriting everyone.

### 2.7 Tell B and C it's ready

---

## PART 3 — PERSON B AND C: GET SET UP

```bash
cd ~/projects
git clone https://github.com/YOUR-ORG/lakshman-rekha.git
cd lakshman-rekha
pnpm install
cp .env.example .env
code .
```

Then **read `docs/API.md`**. Not skim — read. It's the only thing connecting your work to the other two.

---

## PART 4 — HOW GIT WORKS FOR US (the mental model)

Skip this if you already know git. Otherwise it's worth four minutes.

**`main` is the shared, always-working version.** Nobody edits it directly.

**A branch is your private copy.** You make one, work in it, and when your piece works you ask for it to be merged into `main`. Meanwhile the other two are doing the same in their own branches, and nobody sees each other's half-finished code.

Picture it:

```
main     ●───●───────●───────●───────●
          \         /       /       /
a/contracts ●──●──●        /       /        ← A's work, merged in
b/agents          ●──●──●─┘       /         ← B's work, merged in
c/console                  ●──●──●          ← C's work, merged in
```

**Why not all work on main?** Because you'd overwrite each other constantly, and one person's broken code would break the other two immediately.

### Branch naming

| Person | Prefix | Examples |
|---|---|---|
| A | `a/` | `a/policy-module`, `a/lease-issuer` |
| B | `b/` | `b/shopper-agent`, `b/attack-library` |
| C | `c/` | `c/design-system`, `c/decision-panel` |

One branch per *task*, not per person. Finish `a/policy-module`, merge it, then start `a/lease-issuer`. Small branches merge easily; a branch open for two days becomes a conflict nightmare.

---

## PART 5 — YOUR DAILY LOOP

Memorise this. It's five commands and it covers 95% of what you'll do.

### Starting a new piece of work

```bash
git checkout main          # go to the shared version
git pull                   # get everyone else's latest work
git checkout -b a/policy-module    # make your branch and switch to it
```

**`git pull` before making a branch is the single most important habit here.** Skip it and you branch from stale code, then hit conflicts later.

### While working

Commit every time something works. Not at the end of the day.

```bash
git add .
git commit -m "feat(contracts): add revocationEpoch check to validate()"
```

Push to GitHub a few times a day so your work isn't only on your laptop:

```bash
git push -u origin a/policy-module     # first push on this branch
git push                               # every push after
```

### When the piece is done

```bash
git push
```
Then in the browser: **Pull requests → New pull request → base `main` ← compare `a/policy-module` → Create.**

Tag one teammate for review. They click **Files changed**, glance at it, approve. Then **Merge pull request** → **Delete branch**.

### After someone merges anything

```bash
git checkout main
git pull
```

Do this a few times a day. Staying close to `main` is how you avoid painful merges.

### If you're mid-work and main has moved

```bash
git checkout main
git pull
git checkout a/policy-module
git merge main
```

Now your branch has everyone's latest work. If there's a conflict, see Part 7 — it'll be small because you did this often.

---

## PART 6 — WHO OWNS WHICH FILES

This is what actually prevents conflicts. Git conflicts happen when two people edit *the same file*. So don't.

| Path | Owner | Others |
|---|---|---|
| `contracts/**` | **A** | don't touch |
| `apps/core/src/policy/`, `lease/`, `signing/`, `explain/` | **A** | don't touch |
| `apps/agents/**`, `apps/vendorsim/**` | **B** | don't touch |
| `apps/core/src/api/`, `events/` | **B** | don't touch |
| `apps/web/**` | **C** | don't touch |
| `docs/API.md` | **shared** | all three must agree — see below |
| `packages/contracts-abi/**` | **shared** | announce in chat first |
| root configs, `.env.example` | **A** | ask A |

**If you need a change in someone else's folder, message them.** Don't do it yourself, even if it's one line. Ten seconds of typing turns into thirty minutes of untangling.

**`docs/API.md` is the exception that bites.** All three of you will want to edit it. Rule: announce in chat before you touch it, make the edit small, push it immediately, tell the others to pull. Never sit on an uncommitted API.md change.

### ⚠️ Claude Code specifically

Claude Code will happily edit files across the whole repo. That's how you get a conflict in someone else's folder without noticing.

Start every session with:

> I'm on the [A/B/C] workstream. Read BUILD.md and docs/API.md.
> Only edit files under [your folders from the table above].
> If you think a change is needed outside those paths, tell me instead of doing it.

And before you commit: `git status`. If files outside your folders are listed, undo them:
```bash
git restore path/to/file/you/didnt/mean/to/touch
```

---

## PART 7 — THE FIVE WAYS YOU'LL BREAK IT

### 1. You committed a `.env` or an API key
Serious — anyone can read your repo history. Do this:
```bash
git rm --cached .env
git commit -m "chore: remove env from tracking"
git push
```
Then **rotate the key** — regenerate it on the provider's site. Removing it from the repo doesn't un-leak it; it's already in the history.

### 2. You committed on `main` by accident
```bash
git branch a/my-work        # save your commits onto a new branch
git reset --hard origin/main  # put main back to normal
git checkout a/my-work      # continue on the branch
```

### 3. You want to undo the last commit but keep the code
```bash
git reset --soft HEAD~1
```
Code stays, commit disappears. Safe.

### 4. `git push` was rejected
Someone pushed to your branch before you. Fix:
```bash
git pull --rebase
git push
```
**Never `git push --force`.** It can delete a teammate's work permanently. If you think you need it, ask the group first.

### 5. You have no idea what state you're in
```bash
git status              # which branch, what's changed
git log --oneline -10   # last 10 commits
git branch              # all branches, * marks yours
```
`git status` answers almost every "what's happening" question. Run it constantly.

---

## PART 8 — MERGE CONFLICTS

It's going to happen. It isn't a disaster.

You'll see:
```
CONFLICT (content): Merge conflict in apps/core/src/api/index.ts
```

Open the file. You'll find:
```
<<<<<<< HEAD
const ttl = 5000;
=======
const ttl = 3000;
>>>>>>> main
```

Top block is yours, bottom block is theirs. **Decide which is right** — or write a third version — then delete all three marker lines (`<<<<<<<`, `=======`, `>>>>>>>`).

Then:
```bash
git add .
git commit -m "merge: resolve ttl conflict"
```

**If you're unsure which version is right, ask the other person.** Guessing here is how a working feature silently disappears.

VS Code shows "Accept Current / Accept Incoming / Accept Both" buttons above the conflict — those are usually easier than editing by hand.

---

## PART 9 — PHASE 0 CHECKLIST

Do these together, in one sitting, before splitting up.

**All three in a call, sharing screens:**

- [ ] A scaffolded and pushed; B and C cloned successfully
- [ ] All three ran `pnpm install` with no errors
- [ ] All three have a `.env` (can be mostly empty for now)
- [ ] Branch protection is on — test it: A tries `git push` on main and gets rejected
- [ ] `aadityajauhari01@gmail.com` added as collaborator
- [ ] **All three read `docs/API.md` §1, §3, §11 out loud**
- [ ] All three explicitly agree: **no string fields ever get added to `FactSheet`**
- [ ] Agree on money = integer paise. Say the number out loud: ₹9,400 is `940000`
- [ ] Agree who owns which folders (Part 6)
- [ ] Copy the fixtures from API.md §11 into `packages/contracts-abi/fixtures.ts` and commit them — C needs these to start
- [ ] Each person creates their first branch and pushes one trivial commit, so you've all done the loop once before it matters

**Practice run — everyone does this now, together:**
```bash
git checkout main && git pull
git checkout -b a/hello           # your own prefix
echo "hello from A" >> notes.txt
git add . && git commit -m "chore: practice commit"
git push -u origin a/hello
```
Open a PR, get it approved, merge it, delete the branch, then `git checkout main && git pull`.

Doing this once with a throwaway file means the first *real* PR isn't also the first time you've used the workflow.

- [ ] All three completed the practice run

### Then split

- **A → A1** (`a/inrx-token`)
- **B → B1** (`b/vendor-sim`)
- **C → C1** (`c/design-system`)

C is not blocked on anyone — the fixtures are already in the repo.

---

## PART 10 — CHEAT SHEET

Pin this somewhere.

```bash
# start something new
git checkout main && git pull && git checkout -b a/thing

# save progress (do this often)
git add . && git commit -m "feat(scope): what you did"

# back it up to GitHub
git push                      # or: git push -u origin a/thing (first time)

# get everyone's latest into your branch
git checkout main && git pull && git checkout a/thing && git merge main

# where am I, what's going on
git status
git log --oneline -10
git branch

# undo last commit, keep the code
git reset --soft HEAD~1

# throw away changes to one file
git restore path/to/file
```

**Commit message format:**
```
feat(contracts): add revocationEpoch check
fix(core): default to REFUSED on unexpected state
test(agents): assert all 12 attack classes blocked
chore(web): add tailwind config
docs(api): add priceBandZ range
```

Prefixes: `feat` new thing · `fix` bug · `test` tests · `chore` setup/config · `docs` documentation.

**Three rules that prevent most problems:**
1. `git pull` on main before starting anything
2. Only edit files you own
3. Small branches, merged the same day

---

## IF YOU GET STUCK

`git status` first, always. Then paste its output into Claude Code and say what you were trying to do.

**Don't run commands you found online without understanding them.** `git reset --hard`, `git push --force`, and `git rebase` can permanently delete work. If a Stack Overflow answer contains one of those, ask the group before running it.

Nothing in git is truly lost until you force-push. Almost every mistake is recoverable — stay calm and check `git status`.