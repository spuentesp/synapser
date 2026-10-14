import { createContext, useContext } from 'react'

export type Lang = 'es' | 'en'

const dict = {
  es: {
    run: 'Corrida', swarm: 'Enjambre', timeline: 'Línea de tiempo', why: 'Por qué', cost: 'Costo',
    coordination: 'Coordinación', approvals: 'Aprobaciones', integrity: 'Integridad',
    live: 'En vivo', replay: 'Reproducción', noRuns: 'No hay corridas en este directorio de estado.',
    verified: 'Cadena verificada', broken: 'Cadena rota', events: 'eventos', head: 'cabeza', tasks: 'tareas',
    waitingOn: 'espera a', holds: 'retiene', observed: 'observado en Zoanthrope', steps: 'pasos',
    searches: 'búsquedas', unknownCost: 'sin precio', evidence: 'evidencia', seq: 'seq', time: 'hora',
    kind: 'tipo', summary: 'resumen', pickAction: 'Elige una acción para ver por qué cambió',
    chain: 'Cadena declarada', asserted: 'Lo que el agente afirmó (no es evidencia)',
    mission: 'Misión', task: 'Tarea', runs: 'Corridas de agente', action: 'Acción', files: 'Archivos',
    validations: 'Validaciones', linkedBy: 'atribución', approve: 'Aprobar', reject: 'Rechazar',
    actor: 'Tu nombre', noApprovals: 'No hay compuertas pendientes.',
    staleDigest: 'El plan cambió: esta aprobación ya no vale. Actualiza.', decided: 'Registrado en el ledger',
    wastedRuns: 'Corridas desperdiciadas', byProfile: 'Por perfil', byTask: 'Por tarea', byModel: 'Por modelo',
    waits: 'esperas', waitMs: 'tiempo de espera', stale: 'vistas rancias', recoveries: 'recuperaciones',
    actions: 'acciones', verifyNow: 'Verificar de nuevo', download: 'Descargar exportación',
    howVerify: 'Verificación fuera de línea', gaps: 'huecos declarados', alerts: 'alertas',
    delegations: 'delegaciones', filter: 'Filtrar…', all: 'Todos', close: 'Cerrar', tokens: 'tokens', usd: 'USD',
    unknownNote: 'Costo desconocido: nunca se suma como 0', allRuns: 'corridas', stateLabel: 'estado',
    plan: 'plan', loading: 'Cargando…', error: 'Error', gate: 'Compuerta', planDigest: 'digest del plan',
    empty: 'Sin datos todavía',
    showCode: 'Código para el agente', codeNote: 'Dáselo al agente SOLO si apruebas: es lo que le permite relayar tu OK por MCP.',
    gateStart: 'Inicio del workflow', gateStep: 'Paso del plan', gateCondition: 'Condición', gateEffect: 'Efecto', gateIntervention: 'Intervención del asesor',
  },
  en: {
    run: 'Run', swarm: 'Swarm', timeline: 'Timeline', why: 'Why', cost: 'Cost',
    coordination: 'Coordination', approvals: 'Approvals', integrity: 'Integrity',
    live: 'Live', replay: 'Replay', noRuns: 'No runs in this state directory.',
    verified: 'Chain verified', broken: 'Chain broken', events: 'events', head: 'head', tasks: 'tasks',
    waitingOn: 'waiting on', holds: 'holds', observed: 'observed in Zoanthrope', steps: 'steps',
    searches: 'searches', unknownCost: 'no price', evidence: 'evidence', seq: 'seq', time: 'time',
    kind: 'kind', summary: 'summary', pickAction: 'Pick an action to see why it changed',
    chain: 'Declared chain', asserted: 'What the agent asserted (not evidence)',
    mission: 'Mission', task: 'Task', runs: 'Agent runs', action: 'Action', files: 'Files',
    validations: 'Validations', linkedBy: 'attribution', approve: 'Approve', reject: 'Reject',
    actor: 'Your name', noApprovals: 'No pending gates.',
    staleDigest: 'The plan changed: this approval no longer applies. Refresh.', decided: 'Recorded on the ledger',
    wastedRuns: 'Wasted runs', byProfile: 'By profile', byTask: 'By task', byModel: 'By model',
    waits: 'waits', waitMs: 'wait time', stale: 'stale views', recoveries: 'recoveries',
    actions: 'actions', verifyNow: 'Verify again', download: 'Download export',
    howVerify: 'Offline verification', gaps: 'declared gaps', alerts: 'alerts',
    delegations: 'delegations', filter: 'Filter…', all: 'All', close: 'Close', tokens: 'tokens', usd: 'USD',
    unknownNote: 'Unknown cost is never summed as 0', allRuns: 'runs', stateLabel: 'state',
    plan: 'plan', loading: 'Loading…', error: 'Error', gate: 'Gate', planDigest: 'plan digest',
    empty: 'No data yet',
    showCode: 'Code for the agent', codeNote: 'Give it to the agent ONLY if you approve: it is what lets it relay your OK over MCP.',
    gateStart: 'Workflow start', gateStep: 'Plan step', gateCondition: 'Condition', gateEffect: 'Effect', gateIntervention: 'Advisor intervention',
  },
} as const

export type Key = keyof (typeof dict)['es']

export const STATUS_LABEL: Record<Lang, Record<string, string>> = {
  es: { planned: 'planificada', waiting_approval: 'espera aprobación', ready: 'lista', running: 'ejecutando', waiting: 'esperando', validating: 'validando', done: 'hecha', failed: 'falló', cancelled: 'cancelada' },
  en: { planned: 'planned', waiting_approval: 'awaiting approval', ready: 'ready', running: 'running', waiting: 'waiting', validating: 'validating', done: 'done', failed: 'failed', cancelled: 'cancelled' },
}

export interface I18n {
  lang: Lang
  t: (k: Key) => string
  setLang: (l: Lang) => void
}
export const I18nContext = createContext<I18n>({ lang: 'es', t: (k) => dict.es[k], setLang: () => {} })
export const useI18n = (): I18n => useContext(I18nContext)
export const makeT = (lang: Lang) => (k: Key): string => dict[lang][k]
