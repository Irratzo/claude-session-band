import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { BandInfo, Changes, Limit } from '../types'

const info = atom({ plugin: 'session-band', key: 'info' } as const, null)

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

// "claude-opus-5-5[1m]" -> "Opus 5.5 1M", "opus" -> "Opus"
const prettyModel = (id: string) => {
  const m = /(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d+))?)?/i.exec(id)
  const family = m?.[1]
  if (!m || !family) return id
  const name = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()
  const version = m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ''}` : ''
  return `${name}${version}${/\[1m\]/i.test(id) ? ' 1M' : ''}`
}

const two = (n: number) => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Reset time in local time: "14:10" within a day, else "Mon 09:00".
const resetLabel = (iso: string | null, now: number) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return d.getTime() - now < 24 * 3600 * 1000 ? hm : `${DAYS[d.getDay()]} ${hm}`
}

const level = (pct: number) => (pct < 50 ? 'success' : pct < 80 ? 'warning' : 'error')

const bar = (pct: number, width: number) => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }

// 1. Plan mode's own plan: the transcript carries a "slug", plan mode writes <config>/plans/<slug>.md.
// 2. Else the plan file the conversation names last, e.g. a campaign plan made by an earlier session:
//    the last "~/.claude*/plans/<name>.md" path in the transcript.
// ponytail: reads only the transcript's last 4 MiB; a plan last named before that is missed.
const planFile = async ($: EngineInterface, home: string, configDir: string) => {
  const { transcriptPath } = await $.session.info()
  if (!transcriptPath || !(await $.fs.exists(transcriptPath))) return null
  const { size } = await $.fs.stat(transcriptPath)
  const offset = Math.max(0, size - 4194304)
  const tail = (await $.fs.read(transcriptPath, { offset, length: size - offset })) as string
  const slug = [...tail.matchAll(/"slug":"([^"]+)"/g)].at(-1)?.[1]
  const own = `${configDir}/plans/${slug}.md`
  if (slug && (await $.fs.exists(own))) return own
  const named = [...tail.matchAll(/(\.claude[\w-]*)\/plans\/([\w.-]+\.md)/g)].reverse()
  for (const [, dir, name] of named) {
    const path = `${home}/${dir}/plans/${name}`
    if (dir && name && (await $.fs.exists(path))) return path
  }
  return null
}

const gitInfo = async ($: EngineInterface) => {
  const cwd = await $.session.cwd()
  const r = await $.process.run(
    ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'],
    { cwd, timeoutMs: 5000 },
  ).catch(() => null)
  if (!r || r.exitCode !== 0) return { repo: null, branch: null, worktree: null, changes: null }
  const [top = '', common = '', branch = ''] = r.stdout.trim().split('\n')
  const mainRoot = common.endsWith('/.git') ? common.slice(0, -5) : top
  return {
    repo: basename(mainRoot),
    branch: branch === 'HEAD' ? 'detached' : branch,
    worktree: top !== mainRoot ? basename(top) : null,
    changes: await gitChanges($, cwd),
  }
}

// Files changed, lines +/- against HEAD (staged and unstaged), untracked, conflicts, ahead/behind upstream.
// --no-optional-locks: never take the index lock another session's git may need.
const gitChanges = async ($: EngineInterface, cwd: string): Promise<Changes | null> => {
  const opts = { cwd, timeoutMs: 5000 }
  const [status, numstat] = await Promise.all([
    $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], opts).catch(() => null),
    $.process.run(['git', '--no-optional-locks', 'diff', '--numstat', 'HEAD'], opts).catch(() => null),
  ])
  if (!status || status.exitCode !== 0) return null
  const c: Changes = { files: 0, added: 0, removed: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0 }
  for (const line of status.stdout.split('\n')) {
    const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(line)
    if (ab) { c.ahead = Number(ab[1]); c.behind = Number(ab[2]) }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) c.files += 1
    else if (line.startsWith('u ')) c.conflicts += 1
    else if (line.startsWith('? ')) c.untracked += 1
  }
  for (const line of numstat?.exitCode === 0 ? numstat.stdout.split('\n') : []) {
    const [a, d] = line.split('\t')
    if (a && a !== '-') c.added += Number(a)
    if (d && d !== '-') c.removed += Number(d)
  }
  return c
}

type Step = {
  model: string | null
  effort: string | null
  planPath: string | null
  cacheAt: number | null // when the main loop's last request was sent: the cache lifetime counts from here
  cacheTtlMs: number | null
}

async function refresh($: EngineInterface, step: Step, withPlan = false) {
  const home = (await $.env.get('HOME')) ?? ''
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const profile = basename(configDir).replace(/^\./, '')
  const [model, usage, git, plan, effortSetting, rows] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    gitInfo($),
    withPlan ? planFile($, home, configDir).catch(() => step.planPath) : step.planPath,
    $.settings.read({ key: 'effortLevel' }).catch(() => undefined),
    $.config.list().catch(() => []),
  ])
  // ponytail: finds the effort row by key name; if /config names it otherwise, the last request's effort shows
  const effortRow = rows.find(row => /effort/i.test(row.key))?.value
  const liveEffort = typeof effortRow === 'string' && effortRow !== '' ? effortRow : null
  const limits: Limit[] = usage.rateLimits.map((l: SessionRateLimit) => ({
    kind: l.kind,
    percent: l.percentUsed,
    resetsAt: l.resetsAt ?? null,
  }))
  const next: BandInfo = {
    profile,
    model: prettyModel(step.model ?? model),
    effort: liveEffort ?? step.effort ?? (typeof effortSetting === 'string' ? effortSetting : null),
    contextPercent: usage.context.percent ?? null,
    limits,
    ...git,
    plan: plan ? basename(plan) : null,
    planPath: plan,
    cacheAt: step.cacheAt,
    cacheTtlMs: step.cacheTtlMs,
  }
  step.planPath = plan
  await update($, info, () => next)
}

const duration = (ms: number) => {
  const m = Math.round(ms / 60000)
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

// Prompt cache: "cache 52m" while warm (yellow under 5 min left), "cache cold 2h idle" once expired.
function cacheView(Text: any, at: number | null, ttlMs: number | null, now: number) {
  if (at === null || ttlMs === null) return <Text dimColor>cache –</Text>
  const left = at + ttlMs - now
  return left > 0 ? (
    <Text>
      <Text dimColor>cache </Text>
      <Text color={left < 300000 && ttlMs > 300000 ? 'warning' : 'success'}>◷ {duration(left)}</Text>
    </Text>
  ) : (
    <Text>
      <Text dimColor>cache </Text>
      <Text color="error">cold</Text>
      <Text dimColor> {duration(now - at)} idle</Text>
    </Text>
  )
}

// "✓" when clean, else "● 3 +120 −35 ?2 ✗1", then "⇡1⇣2" when off upstream.
function changesView(Text: any, c: Changes) {
  const isClean = c.files + c.untracked + c.conflicts === 0
  return (
    <Text>
      {isClean ? <Text color="success">✓</Text> : <Text color="warning">● {c.files}</Text>}
      {c.added > 0 ? <Text color="success">{` +${c.added}`}</Text> : null}
      {c.removed > 0 ? <Text color="error">{` −${c.removed}`}</Text> : null}
      {c.untracked > 0 ? <Text dimColor>{` ?${c.untracked}`}</Text> : null}
      {c.conflicts > 0 ? <Text color="error" bold>{` ✗${c.conflicts}`}</Text> : null}
      {c.ahead > 0 ? <Text color="suggestion">{` ⇡${c.ahead}`}</Text> : null}
      {c.behind > 0 ? <Text color="suggestion">{`${c.ahead > 0 ? '' : ' '}⇣${c.behind}`}</Text> : null}
    </Text>
  )
}

export const register: Register = on => {
  // The model and effort actually sent on the main loop's last request.
  const step: Step = { model: null, effort: null, planPath: null, cacheAt: null, cacheTtlMs: null }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($, step, true).catch(() => {})
    $.clock.every(30000, () => refresh($, step).catch(() => {}))
    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    step.model = e.model
    step.effort = e.effort === undefined ? null : String(e.effort)
    const sentAt = await $.clock.now()
    const r = yield* next(e)
    const u = r.usage
    if (u && u.cache_read_input_tokens + u.cache_creation_input_tokens > 0) {
      // A write sets the lifetime (the shorter if both); a pure read keeps the last write's.
      const ttl = (u.ephemeral_5m_input_tokens ?? 0) > 0 ? 300000
        : (u.ephemeral_1h_input_tokens ?? 0) > 0 ? 3600000
        : step.cacheTtlMs ?? 300000
      step.cacheAt = sentAt
      step.cacheTtlMs = ttl
    }
    return r
  })

  // /effort and /model are commands, not /config rows, so config.set never sees them. Drop the
  // last request's value (it would outrank the new setting) and take the level typed, if any;
  // a picker's choice then shows from the saved setting on the next 30 s refresh at the latest.
  on('command.run', async ($, e, next) => {
    const done = await next(e)
    if (e.command === 'effort') {
      const typed = e.args.trim().toLowerCase()
      step.effort = /^(low|medium|high|xhigh|max)$/.test(typed) ? typed : null
    } else if (e.command === 'model') step.model = null
    else return done
    await refresh($, step).catch(() => {})
    // ponytail: the menu may save its pick after the command resolves; re-read shortly after
    for (const ms of [500, 2000, 5000]) $.clock.after(ms, () => refresh($, step).catch(() => {}))
    return done
  })

  // /config changed a setting: redraw now, not after the next reply.
  on('config.set', async ($, e, next) => {
    const done = await next(e)
    await refresh($, step).catch(() => {})
    return done
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, step).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($, step, true).catch(() => {})
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const i = await read($, info)
    if (e.props.hasSurvey || i === null) return next(e)

    const { Box, Link, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const sep = <Text dimColor> │ </Text>
    const isPersonal = /personal/.test(i.profile)

    const ctx =
      i.contextPercent === null ? (
        <Text dimColor>ctx –</Text>
      ) : (
        <Text>
          <Text dimColor>ctx </Text>
          <Text color={level(i.contextPercent)}>
            {bar(i.contextPercent, 10)} {Math.round(i.contextPercent)}%
          </Text>
        </Text>
      )

    const limits = i.limits.length === 0
      ? [<Text key="none" dimColor>limits –</Text>]
      : i.limits.flatMap((l, n) => [
          n > 0 ? <Text key={`s${n}`} dimColor>  </Text> : null,
          <Text key={l.kind}>
            <Text dimColor>{LIMIT_NAMES[l.kind] ?? l.kind} </Text>
            <Text color={level(l.percent)}>{bar(l.percent, 5)} {Math.round(l.percent)}%</Text>
            <Text dimColor> ↻{resetLabel(l.resetsAt, now)}</Text>
          </Text>,
        ]).filter(x => x !== null)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text backgroundColor={isPersonal ? '#7c3aed' : '#b45309'} color="#ffffff" bold>
            {` ${i.profile} `}
          </Text>
          <Text> </Text>
          <Text color="claude" bold>{i.model}</Text>
          <Text dimColor> · </Text>
          <Text color="suggestion">{i.effort ?? 'effort ?'}</Text>
          {sep}
          {ctx}
          {sep}
          {cacheView(Text, i.cacheAt ?? null, i.cacheTtlMs ?? null, now)}
          {sep}
          {limits}
        </Box>
        <Box flexDirection="row">
          <Text dimColor>⎇ </Text>
          <Text bold>{i.repo ?? 'no repo'}</Text>
          {i.branch ? <Text dimColor> ▸ </Text> : null}
          {i.branch ? <Text color="success">{i.branch}</Text> : null}
          {i.worktree ? <Text dimColor>{` (worktree ${i.worktree})`}</Text> : null}
          {i.changes ? <Text> </Text> : null}
          {i.changes ? changesView(Text, i.changes) : null}
          {sep}
          <Text dimColor>▤ plan </Text>
          {i.plan && i.planPath ? (
            // OSC 8 file link: Cmd+click in Herdr opens it with the default .md app
            <Link href={`file://${encodeURI(i.planPath)}`}>
              <Text color="planMode" underline>{i.plan}</Text>
            </Link>
          ) : (
            <Text color="inactive">{i.plan ?? '–'}</Text>
          )}
        </Box>
      </Box>
    )
  })
}
