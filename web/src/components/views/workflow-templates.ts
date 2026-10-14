// Built-in workflow templates (plan 14 Q3.2): four documents with declared parameters. A template only fills the designer's
// form; the person adjusts it, and the server's validator still decides what can be saved. They are not stored: a schema
// for library templates is an open decision.
import type { Key } from '@/lib/i18n'
import type { WorkflowDoc } from './workflow-designer'

export interface TemplateParam {
  name: string
  label: Key
  multiline?: boolean
}

export interface WorkflowTemplate {
  id: 'bounded-change' | 'cited-research' | 'review' | 'migration'
  title: Key
  description: Key
  params: TemplateParam[]
  build: (p: Record<string, string>) => WorkflowDoc
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n').map((x) => x.trim()).filter((x) => x.length > 0)

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'bounded-change',
    title: 'tplBoundedTitle',
    description: 'tplBoundedDescription',
    params: [
      { name: 'title', label: 'designerTitleField' },
      { name: 'scope', label: 'tplParamScope', multiline: true },
      { name: 'command', label: 'designerCommand' },
    ],
    build: (p) => ({
      title: p['title'] ?? '',
      description: `Change only the files in scope and prove the change with the allowlisted check ${p['command'] ?? ''}.`,
      goals: ['The change is made inside the declared scope and its check passes'],
      nonGoals: [{ statement: 'Touch files outside the declared scope' }],
      conditions: [
        { id: 'in-scope', statement: 'The declared files changed', required: true, checker: { kind: 'diff', require: lines(p['scope']) } },
        { id: 'checks-pass', statement: 'The allowlisted check passes', required: true, checker: { kind: 'command', commandId: p['command'] ?? '' } },
      ],
    }),
  },
  {
    id: 'cited-research',
    title: 'tplCitedTitle',
    description: 'tplCitedDescription',
    params: [
      { name: 'title', label: 'designerTitleField' },
      { name: 'topic', label: 'tplParamTopic', multiline: true },
      { name: 'file', label: 'tplParamFile' },
      { name: 'min', label: 'designerMin' },
    ],
    build: (p) => ({
      title: p['title'] ?? '',
      description: `Research ${p['topic'] ?? ''} and write the findings to ${p['file'] ?? ''}, citing only sources retrieved in this run.`,
      goals: [p['topic'] ?? ''].filter((x) => x.trim().length > 0),
      nonGoals: [{ statement: 'Cite a source that was not retrieved in this run' }],
      conditions: [
        { id: 'cited', statement: 'The document cites enough retrieved sources', required: true, checker: { kind: 'citations', file: p['file'] ?? '', min: Number(p['min'] ?? '') } },
      ],
    }),
  },
  {
    id: 'review',
    title: 'tplReviewTitle',
    description: 'tplReviewDescription',
    params: [
      { name: 'title', label: 'designerTitleField' },
      { name: 'target', label: 'tplParamTarget', multiline: true },
      { name: 'profile', label: 'designerProfile' },
      { name: 'rubric', label: 'designerRubric', multiline: true },
    ],
    build: (p) => ({
      title: p['title'] ?? '',
      description: `A reviewer judges the files against the rubric. The reviewed files must not change in this run.`,
      goals: ['A reviewer has judged the files against the rubric'],
      nonGoals: [{ statement: 'Change the reviewed files', guard: { kind: 'diff', forbid: lines(p['target']) } }],
      conditions: [
        // a review is the agent's judgement: secondary evidence, so it is informational rather than required
        { id: 'judged', statement: 'A reviewer judged the files', required: false, checker: { kind: 'review', profile: p['profile'] ?? '', rubric: p['rubric'] ?? '' } },
        { id: 'unchanged', statement: 'The reviewed files are unchanged', required: true, checker: { kind: 'diff', forbid: lines(p['target']) } },
      ],
    }),
  },
  {
    id: 'migration',
    title: 'tplMigrationTitle',
    description: 'tplMigrationDescription',
    params: [
      { name: 'title', label: 'designerTitleField' },
      { name: 'from', label: 'tplParamFrom' },
      { name: 'to', label: 'tplParamTo' },
      { name: 'frozen', label: 'tplParamFrozen', multiline: true },
    ],
    build: (p) => ({
      title: p['title'] ?? '',
      description: `Move ${p['from'] ?? ''} to ${p['to'] ?? ''} without changing the public surface listed in the non-goals.`,
      goals: [`${p['from'] ?? ''} now lives at ${p['to'] ?? ''}`],
      nonGoals: [{ statement: 'Change the public API', guard: { kind: 'diff', forbid: lines(p['frozen']) } }],
      conditions: [
        { id: 'new-place', statement: 'The new location exists', required: true, checker: { kind: 'file', path: p['to'] ?? '', assert: 'exists' } },
        { id: 'old-gone', statement: 'The old location is gone', required: true, checker: { kind: 'file', path: p['from'] ?? '', assert: 'absent' } },
      ],
    }),
  },
]
