/**
 * The 模型能力 settings page: one grouped editor over the llm-pi-ai user layer.
 *
 * Data flows through the inject face (a bound settings scope + translate), so
 * this file value-imports no other plugin. The body remounts per namespace
 * revision: the mirror fold after a save arrives as a new revision, which is
 * the fresh parse — local draft state never has to merge server truth.
 *
 * @module dsh-reasoning-tiers/CapabilitiesPage
 */
import type { ReactNode } from 'react'
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { CountField, ImageMode, ModelDraft, PathOp, ProviderDraft } from './capabilities.ts'
import { buildMutateOps, countPresets, countValue, draftsKey, invalidField, parseProviders, presetLabel, presetListId } from './capabilities.ts'

/** Raw snapshot face the bound settings scope serves (structurally typed). */
export interface CapabilitiesSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
}

/** What the section's inject face hands the page. */
export interface CapabilitiesFace {
  scope: {
    getSnapshot(): CapabilitiesSnapshot
    subscribe(listener: () => void): () => void
    mutate(ops: readonly PathOp[], expectedRevision?: number): Promise<void>
  }
  t: (key: string) => string
}

type Message = { readonly route: string; readonly kind: 'ok' | 'conflict' | 'error'; readonly text: string }

/** The settings-page entry: subscribes the scope and remounts the body per revision. */
export function CapabilitiesPage(props: CapabilitiesFace): ReactNode {
  const snapshot = useSyncExternalStore(props.scope.subscribe, props.scope.getSnapshot, props.scope.getSnapshot)
  return <CapabilitiesBody key={String(snapshot.revision ?? 'none')} {...props} snapshot={snapshot} />
}

function CapabilitiesBody(props: CapabilitiesFace & { snapshot: CapabilitiesSnapshot }): ReactNode {
  const { scope, t, snapshot } = props
  const providers = parseProviders(snapshot.value, snapshot.user)
  const [drafts, setDrafts] = useState<Record<string, readonly ModelDraft[]>>({})
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState<Message | undefined>(undefined)
  const writable = snapshot.writable && snapshot.status === 'ready'

  const rowsOf = useCallback((p: ProviderDraft) => drafts[p.route] ?? p.models, [drafts])
  const dirtyOf = useCallback((p: ProviderDraft) => draftsKey(rowsOf(p)) !== draftsKey(p.models), [rowsOf])

  const update = useCallback((route: string, rows: readonly ModelDraft[]) => {
    setDrafts((prev) => ({ ...prev, [route]: rows }))
  }, [])

  const save = useCallback(
    async (p: ProviderDraft) => {
      const rows = rowsOf(p)
      if (rows.some((row) => row.id.trim() === '')) {
        setMessage({ route: p.route, kind: 'error', text: t('modelIdRequired') })
        return
      }
      if (rows.some((row) => invalidField(row) !== undefined)) {
        setMessage({ route: p.route, kind: 'error', text: t('invalidNumber') })
        return
      }
      setBusy(p.route)
      setMessage(undefined)
      try {
        await scope.mutate(
          buildMutateOps({ ...p, models: rows.map((row) => ({ ...row, id: row.id.trim() })) }),
          snapshot.revision,
        )
        setMessage({ route: p.route, kind: 'ok', text: t('saved') })
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        setMessage({
          route: p.route,
          kind: /conflict|revision|stale/i.test(text) ? 'conflict' : 'error',
          text: `${t('saveFailed')}: ${text}`,
        })
      } finally {
        setBusy(undefined)
      }
    },
    [rowsOf, scope, snapshot.revision, t],
  )

  const numberCell = useCallback(
    (p: ProviderDraft, index: number, draft: ModelDraft, field: 'contextText' | 'maxText', label: string) => {
      const kind: CountField = field === 'contextText' ? 'context' : 'max'
      const invalid = invalidField(draft) === kind
      // Naming the step a typed value lands on, so the decimal/binary choice is
      // visible rather than guessed from a bare number.
      const numeric = countValue(draft[field])
      const step = numeric === undefined ? undefined : presetLabel(numeric, kind)
      return (
        <input
          className={`dsh-rt-cap-input${invalid ? ' dsh-rt-cap-invalid' : ''}`}
          inputMode="numeric"
          list={presetListId(kind)}
          placeholder={t('inheritMark')}
          title={step === undefined ? label : `${label} · ${step}`}
          value={draft[field]}
          disabled={!writable}
          onChange={(event) =>
            update(p.route, rowsOf(p).map((row, i) => (i === index ? { ...row, [field]: event.target.value } : row)))
          }
        />
      )
    },
    [rowsOf, t, update, writable],
  )

  return (
    <div>
      <PresetOptions field="context" />
      <PresetOptions field="max" />
      {!snapshot.writable && <p className="dsh-rt-cap-hint">{t('readOnlyHint')}</p>}
      {snapshot.writable && <p className="dsh-rt-cap-hint">{t('restartHint')}</p>}
      {providers.map((p) => {        const rows = rowsOf(p)
        const dirty = dirtyOf(p)
        return (
          <fieldset key={p.route} className="dsh-rt-cap-group" disabled={!writable || busy === p.route}>
            <legend className="dsh-rt-cap-title">
              {p.route}
              <span className="dsh-rt-cap-tag">{p.hasModelsList ? t('declaredHint') : t('overridesHint')}</span>
            </legend>
            {rows.length === 0 && <p className="dsh-rt-cap-empty">{t('catalogEmpty')}</p>}
            {rows.length > 0 && (
              <table className="dsh-rt-cap-table">
                <thead>
                  <tr>
                    <th>id</th>
                    <th>{t('contextWindow')}</th>
                    <th>{t('maxTokens')}</th>
                    <th>{t('imageInput')}</th>
                    {p.hasModelsList ? null : <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${index}:${row.id}`}>
                      <td>
                        {p.hasModelsList ? (
                          row.id
                        ) : (
                          <input
                            className="dsh-rt-cap-input"
                            placeholder={t('modelIdPlaceholder')}
                            value={row.id}
                            disabled={!writable}
                            onChange={(event) =>
                              update(p.route, rows.map((r, i) => (i === index ? { ...r, id: event.target.value } : r)))
                            }
                          />
                        )}
                      </td>
                      <td>{numberCell(p, index, row, 'contextText', t('contextWindow'))}</td>
                      <td>{numberCell(p, index, row, 'maxText', t('maxTokens'))}</td>
                      <td>
                        <select
                          value={row.image}
                          disabled={!writable}
                          onChange={(event) =>
                            update(p.route, rows.map((r, i) => (i === index ? { ...r, image: event.target.value as ImageMode } : r)))
                          }
                        >
                          <option value="inherit">{t('imageInherit')}</option>
                          <option value="on">{t('imageOn')}</option>
                          <option value="off">{t('imageOff')}</option>
                        </select>
                      </td>
                      {p.hasModelsList ? null : (
                        <td>
                          <button
                            type="button"
                            disabled={!writable}
                            onClick={() => update(p.route, rows.filter((_, i) => i !== index))}
                          >
                            {t('remove')}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="dsh-rt-cap-actions">
              {!p.hasModelsList && (
                <button
                  type="button"
                  disabled={!writable || busy === p.route}
                  onClick={() =>
                    update(p.route, [...rows, { id: '', contextText: '', maxText: '', image: 'inherit', raw: {} }])
                  }
                >
                  {t('addOverride')}
                </button>
              )}
              <button
                type="button"
                disabled={!writable || busy === p.route || !dirty}
                onClick={() => {
                  void save(p)
                }}
              >
                {busy === p.route ? t('saving') : t('save')}
              </button>
              {dirty && <span className="dsh-rt-cap-msg">{t('unsavedHint')}</span>}
              {message?.route === p.route && <span className={`dsh-rt-cap-msg ${message.kind}`}>{message.text}</span>}
            </div>
          </fieldset>
        )
      })}
    </div>
  )
}

/**
 * One shared quick-pick list: mounted once per field for the whole page and
 * referenced by every row's `list` attribute through the same
 * {@link presetListId} call, so the two sides cannot drift.
 */
function PresetOptions({ field }: { field: CountField }): ReactNode {
  return (
    <datalist id={presetListId(field)}>
      {countPresets(field).map((preset) => (
        <option key={preset.value} value={String(preset.value)}>
          {preset.label}
        </option>
      ))}
    </datalist>
  )
}
