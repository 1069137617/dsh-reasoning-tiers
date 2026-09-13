/** Scoped styles for the capabilities page. @module dsh-reasoning-tiers/styles */
const STYLE_ID = 'dsh-reasoning-tiers-capabilities'

const CSS = `
.dsh-rt-cap-group{border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:12px;margin:0 0 16px}
.dsh-rt-cap-title{font-weight:600;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.dsh-rt-cap-tag{font-size:11px;opacity:.6;font-weight:400}
.dsh-rt-cap-table{width:100%;border-collapse:collapse}
.dsh-rt-cap-table th{text-align:left;font-weight:500;opacity:.7;padding:4px 8px}
.dsh-rt-cap-table td{padding:4px 8px;border-top:1px solid rgba(128,128,128,.2)}
.dsh-rt-cap-input{width:110px}
.dsh-rt-cap-invalid{border-color:#d33 !important}
.dsh-rt-cap-actions{margin-top:8px;display:flex;gap:8px;align-items:center}
.dsh-rt-cap-msg{font-size:12px}
.dsh-rt-cap-msg.ok{color:#2a7}
.dsh-rt-cap-msg.conflict{color:#d70}
.dsh-rt-cap-msg.error{color:#d33}
.dsh-rt-cap-hint{font-size:12px;opacity:.65;margin:2px 0 8px}
.dsh-rt-cap-empty{opacity:.65;padding:8px 4px}
`

/** Append the stylesheet once; returns a disposer for ctx.effect. */
export function injectStyles(): () => void {
  if (document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}
