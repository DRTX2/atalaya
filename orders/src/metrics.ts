// A minimal Prometheus text-format registry (counters only): enough for the agent and for humans.
export class Counters {
  private values = new Map<string, number>();
  private readonly help: Record<string, string>;
  constructor(help: Record<string, string>) {
    this.help = help; // no parameter properties: Node runs this file with type stripping only
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1) {
    const key = name + JSON.stringify(Object.entries(labels).sort());
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  get(name: string, labels: Record<string, string> = {}): number {
    return this.values.get(name + JSON.stringify(Object.entries(labels).sort())) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, help] of Object.entries(this.help)) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      let any = false;
      for (const [key, value] of this.values) {
        if (!key.startsWith(name + '[')) continue;
        any = true;
        const labels = (JSON.parse(key.slice(name.length)) as [string, string][]).map(([k, v]) => `${k}="${v}"`).join(',');
        lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
      }
      if (!any) lines.push(`${name} 0`);
    }
    return lines.join('\n') + '\n';
  }
}

/** Reads one counter's total (all label sets summed) from Prometheus text. */
export function counterTotal(text: string, name: string): number {
  return text.split('\n').filter((l) => l.startsWith(name + ' ') || l.startsWith(name + '{')).reduce((sum, l) => sum + Number(l.trim().split(/\s+/).at(-1)), 0);
}
