// Plan 18 E2 (H2.5): which changes to a tool list break a client. Breaking: a tool removed, a property removed or
// retyped, a new required property. Adding an optional property or a new tool is compatible.
export interface ToolShape {
  name: string;
  inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] };
}

export function breakingChanges(previous: ToolShape[], next: ToolShape[]): string[] {
  const out: string[] = [];
  const now = new Map(next.map((t) => [t.name, t]));
  for (const before of previous) {
    const after = now.get(before.name);
    if (!after) {
      out.push(`tool ${before.name} was removed`);
      continue;
    }
    const oldProps = before.inputSchema?.properties ?? {};
    const newProps = after.inputSchema?.properties ?? {};
    for (const [key, schema] of Object.entries(oldProps)) {
      if (!(key in newProps)) out.push(`${before.name}: property ${key} was removed`);
      else if (newProps[key]?.type !== schema.type) out.push(`${before.name}: property ${key} changed type`);
    }
    const oldRequired = new Set(before.inputSchema?.required ?? []);
    for (const key of after.inputSchema?.required ?? []) if (!oldRequired.has(key)) out.push(`${before.name}: ${key} is now required`);
  }
  return out;
}
