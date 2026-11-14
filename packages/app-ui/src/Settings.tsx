import { useEffect, useState } from "react"
import type { ReactElement } from "react"
import { AiProviderKind, aiDestination, aiSettingsSchema, DEFAULT_AI_MODEL } from "@walkdiff/review-model"
import type { AiConnectionResult, AiSettings, AppSettings, CheckId, CheckStatus, SettingsView } from "@walkdiff/review-model"
import { loadSettings, saveSettings, testAiConnection } from "./api.ts"

const LOCAL_MODEL_EXAMPLE = "http://localhost:11434/v1"

export function Settings(): ReactElement {
  const [view, setView] = useState<SettingsView>()
  const [draft, setDraft] = useState<AppSettings>()
  const [problem, setProblem] = useState<string>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    loadSettings()
      .then((loaded) => {
        setView(loaded)
        setDraft(loaded.settings)
      })
      .catch((error: unknown) => setProblem(messageOf(error)))
  }, [])

  if (view === undefined || draft === undefined) {
    return <main className="page">{problem === undefined ? <p className="empty">Loading settings…</p> : <p className="problem">{problem}</p>}</main>
  }

  const change = (next: AppSettings): void => {
    setDraft(next)
    setSaved(false)
    setProblem(undefined)
  }
  const save = async (): Promise<boolean> => {
    try {
      const updated = await saveSettings(draft)
      setView(updated)
      setSaved(true)
      setProblem(undefined)
      return true
    } catch (error: unknown) {
      setProblem(messageOf(error))
      return false
    }
  }

  return (
    <main className="page settings">
      <h1>Settings</h1>
      <p className="settings-lede">These are your own preferences, saved on this machine. A repository's <code>.walkdiff.json</code> can still forbid AI review or limit where its code goes.</p>

      <ChecksSection checks={view.checks} disabled={draft.disabledChecks} onChange={(disabledChecks) => change({ ...draft, disabledChecks })} />
      <AiSection ai={draft.ai} view={view} onChange={(ai) => change({ ...draft, ai })} onSave={save} />
      <PrivacySection settings={draft} checks={view.checks} offline={view.offline} anthropicBaseUrl={view.anthropicBaseUrl ?? undefined} />

      <div className="settings-actions">
        <button type="button" className="primary" onClick={() => void save()}>
          Save settings
        </button>
        {saved && <span className="settings-saved">✓ Saved. New reviews and refreshes will use these.</span>}
        {problem !== undefined && <span className="problem">{problem}</span>}
      </div>
    </main>
  )
}

interface ChecksSectionProps {
  readonly checks: readonly CheckStatus[]
  readonly disabled: readonly CheckId[]
  readonly onChange: (disabled: readonly CheckId[]) => void
}

function ChecksSection({ checks, disabled, onChange }: ChecksSectionProps): ReactElement {
  const toggle = (id: CheckId, on: boolean): void => onChange(on ? disabled.filter((other) => other !== id) : [...disabled, id])
  return (
    <section className="settings-card" aria-labelledby="settings-checks">
      <h2 id="settings-checks">Checks</h2>
      <p className="settings-hint">A check you turn off shows in every report as a check that didn't run. Built-in rules for secrets and risky code always run.</p>
      <ul className="check-list">
        {checks.map((check) => (
          <CheckRow key={check.id} check={check} on={!disabled.includes(check.id)} onToggle={(on) => toggle(check.id, on)} />
        ))}
      </ul>
    </section>
  )
}

function CheckRow({ check, on, onToggle }: { readonly check: CheckStatus; readonly on: boolean; readonly onToggle: (on: boolean) => void }): ReactElement {
  const missing = check.installed === false
  return (
    <li className="check-row">
      <label className="check-label">
        <input type="checkbox" checked={on} onChange={(event) => onToggle(event.target.checked)} />
        <span>
          <strong>{check.name}</strong>
          <span className="check-purpose">{check.purpose}</span>
          {check.sends !== null && <span className="check-sends">{check.sends}</span>}
        </span>
      </label>
      {missing && on && (
        <span className="check-missing">
          Not installed: <code>{check.install}</code>
        </span>
      )}
      {check.installed === true && on && <span className="check-ready">✓ Ready</span>}
    </li>
  )
}

interface AiSectionProps {
  readonly ai: AiSettings
  readonly view: SettingsView
  readonly onChange: (ai: AiSettings) => void
  readonly onSave: () => Promise<boolean>
}

function AiSection({ ai, view, onChange, onSave }: AiSectionProps): ReactElement {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AiConnectionResult>()
  const compatible = ai.provider === AiProviderKind.OpenAiCompatible
  const validation = aiSettingsSchema.safeParse(ai)
  const destination = validation.success ? aiDestination(validation.data, view.anthropicBaseUrl ?? undefined) : undefined
  const update = (next: AiSettings): void => {
    setResult(undefined)
    onChange(next)
  }
  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(undefined)
    try {
      if (await onSave()) setResult(await testAiConnection())
    } catch (error: unknown) {
      setResult({ ok: false, message: messageOf(error) })
    } finally {
      setTesting(false)
    }
  }
  return (
    <section className="settings-card" aria-labelledby="settings-ai">
      <h2 id="settings-ai">AI review</h2>
      <p className="settings-hint">AI review is optional. It never runs unless you ask for it on a review or turn it on below.</p>

      <div className="settings-field">
        <label htmlFor="ai-provider">Provider</label>
        <select
          id="ai-provider"
          value={ai.provider}
          onChange={(event) => {
            const provider = event.target.value === AiProviderKind.OpenAiCompatible ? AiProviderKind.OpenAiCompatible : AiProviderKind.Anthropic
            update({ ...ai, provider, model: provider === AiProviderKind.Anthropic ? DEFAULT_AI_MODEL : "", baseUrl: provider === AiProviderKind.Anthropic ? null : (ai.baseUrl ?? "") })
          }}
        >
          <option value={AiProviderKind.Anthropic}>Anthropic</option>
          <option value={AiProviderKind.OpenAiCompatible}>OpenAI-compatible (OpenAI, other services, local models)</option>
        </select>
      </div>

      {compatible && (
        <div className="settings-field">
          <label htmlFor="ai-base-url">Address</label>
          <input id="ai-base-url" type="url" value={ai.baseUrl ?? ""} placeholder={LOCAL_MODEL_EXAMPLE} onChange={(event) => update({ ...ai, baseUrl: event.target.value })} />
        </div>
      )}

      <div className="settings-field">
        <label htmlFor="ai-model">Model</label>
        <input id="ai-model" type="text" value={ai.model} placeholder={compatible ? "llama3.2" : DEFAULT_AI_MODEL} onChange={(event) => update({ ...ai, model: event.target.value })} />
      </div>

      <div className="settings-field">
        <label htmlFor="ai-budget">Prompt limit (tokens)</label>
        <input id="ai-budget" type="number" min={1} step={1000} value={ai.maxInputTokens} onChange={(event) => update({ ...ai, maxInputTokens: Number(event.target.value) })} />
      </div>

      <KeyStatus compatible={compatible} keys={view.aiKeys} isLocal={destination?.isLocal ?? false} />
      {!compatible && view.anthropicBaseUrl !== null && <RedirectedWarning address={view.anthropicBaseUrl} />}

      <label className="settings-check">
        <input type="checkbox" checked={ai.enabledByDefault} onChange={(event) => update({ ...ai, enabledByDefault: event.target.checked })} />
        Tick AI review by default on new reviews
      </label>

      {!validation.success && <p className="problem">{validation.error.issues.at(0)?.message}</p>}

      <div className="settings-test">
        <button type="button" disabled={testing || !validation.success} onClick={() => void test()}>
          {testing ? "Testing…" : "Save and test connection"}
        </button>
        {result !== undefined && <span className={result.ok ? "settings-saved" : "problem"}>{result.message}</span>}
      </div>
    </section>
  )
}

function RedirectedWarning({ address }: { readonly address: string }): ReactElement {
  return (
    <p className="settings-warning" role="alert">
      <strong>Your code and API key won't go to Anthropic.</strong> <code>ANTHROPIC_BASE_URL</code> in this app's environment sends them to <code>{address}</code>. If you didn't mean that, unset it and restart the app.
    </p>
  )
}

function KeyStatus({ compatible, keys, isLocal }: { readonly compatible: boolean; readonly keys: SettingsView["aiKeys"]; readonly isLocal: boolean }): ReactElement {
  const variable = compatible ? "WALKDIFF_AI_API_KEY" : "ANTHROPIC_API_KEY"
  const available = compatible ? keys.openaiCompatible : keys.anthropic
  return (
    <p className="settings-key">
      {available ? (
        <>
          ✓ <code>{variable}</code> is set.
        </>
      ) : compatible && isLocal ? (
        <>A local model usually needs no key. If yours does, set <code>{variable}</code>.</>
      ) : compatible ? (
        <>
          No key found. Set <code>{variable}</code> and restart the app.
        </>
      ) : (
        <>
          <code>{variable}</code> isn't set. Set it and restart the app, or use an <code>ant auth login</code> profile.
        </>
      )}{" "}
      Keys stay in your environment, and aren't saved by Walkdiff.
    </p>
  )
}

interface Destination {
  readonly where: string
  readonly what: string
  readonly when: string
}

function PrivacySection({ settings, checks, offline, anthropicBaseUrl }: { readonly settings: AppSettings; readonly checks: readonly CheckStatus[]; readonly offline: boolean; readonly anthropicBaseUrl: string | undefined }): ReactElement {
  const rows = destinationsFor(settings, checks, offline, anthropicBaseUrl)
  return (
    <section className="settings-card" aria-labelledby="settings-privacy">
      <h2 id="settings-privacy">What leaves this machine</h2>
      <p className="settings-hint">
        With the settings above.{offline ? " The app was started with --offline, so OSV and Semgrep are skipped." : ""}
        {aiStaysLocal(settings) && " AI review uses a model on this machine, so it sends nothing out."}
      </p>
      <table className="privacy-table">
        <thead>
          <tr>
            <th scope="col">Where</th>
            <th scope="col">What</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.where}>
              <td>{row.where}</td>
              <td>{row.what}</td>
              <td>{row.when}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function aiStaysLocal(settings: AppSettings): boolean {
  const parsed = aiSettingsSchema.safeParse(settings.ai)
  return parsed.success && aiDestination(parsed.data).isLocal
}

function destinationsFor(settings: AppSettings, checks: readonly CheckStatus[], offline: boolean, anthropicBaseUrl: string | undefined): Destination[] {
  const active = (id: CheckId): boolean => !offline && !settings.disabledChecks.includes(id) && checks.find((check) => check.id === id)?.installed !== false
  const osv = active("osvDatabase") || active("osvScanner")
  const parsed = aiSettingsSchema.safeParse(settings.ai)
  const destination = parsed.success ? aiDestination(parsed.data, anthropicBaseUrl) : undefined
  return [
    { where: "The PR's host", what: "Your token, if the host is trusted, to read the PR and its code", when: "Every review" },
    ...(osv ? [{ where: "OSV", what: "Names and versions of changed dependencies, including private package names unless listed in .walkdiff.json", when: "When dependencies change" }] : []),
    ...(active("dependencyTrust") ? [{ where: "OSV, npm, PyPI and crates.io", what: "Names of new direct dependencies, unless listed as private in .walkdiff.json", when: "When a PR adds a dependency" }] : []),
    ...(active("npmReleases") ? [{ where: "npm", what: "Names and versions of upgraded npm packages, unless listed as private in .walkdiff.json", when: "When a PR upgrades npm packages" }] : []),
    ...(active("semgrep") ? [{ where: "Semgrep registry", what: "A rule download; your code isn't uploaded", when: "Every review" }] : []),
    ...(destination !== undefined && !destination.isLocal
      ? [{ where: destination.label, what: "The changed code, and the PR's title and description, with known credential formats redacted", when: settings.ai.enabledByDefault ? "Reviews with AI ticked, which is the default" : "Only reviews with AI ticked" }]
      : []),
  ]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
