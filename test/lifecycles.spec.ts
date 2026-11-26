// The declared lifecycles (ARCH.md §16 #105, docs/state-machines.md): every status column that moves has its moves in
// src/lib/lifecycles.ts and nowhere else.
import { describe, expect, it } from 'vitest';
import doc from '../docs/state-machines.md?raw';
import { BORROW_REQUEST, canMove, CONNECTION, diagram, fromSql, LIFECYCLES, RECOMMENDATION, terminal } from '../src/lib/lifecycles';

const dbSources = import.meta.glob('../src/db/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('the lifecycle tables', () => {
  for (const l of LIFECYCLES) {
    describe(l.column, () => {
      it('moves only between its own states, and every move changes something', () => {
        for (const [event, move] of Object.entries(l.moves)) {
          expect(l.states, event).toContain(move.to);
          expect(move.from.length, event).toBeGreaterThan(0);
          for (const from of move.from) {
            expect(l.states, event).toContain(from);
            expect(from, `${event} would leave ${from} where it is`).not.toBe(move.to);
          }
        }
      });

      it('reaches every state from where a row starts', () => {
        const reached = new Set<string>(l.initial);
        for (let grew = true; grew; ) {
          grew = false;
          for (const move of Object.values(l.moves)) {
            if (move.from.some((f) => reached.has(f)) && !reached.has(move.to)) {
              reached.add(move.to);
              grew = true;
            }
          }
        }
        expect([...reached].sort()).toEqual([...l.states].sort());
      });

      it('has an end: at least one state no move leaves', () => {
        expect(terminal(l).length).toBeGreaterThan(0);
      });

      it('is drawn in docs/state-machines.md exactly as declared', () => {
        expect(doc).toContain('```mermaid\n' + diagram(l) + '\n```');
      });
    });
  }

  it('says what each move guards', () => {
    expect(fromSql(BORROW_REQUEST.moves.theyLent)).toBe("('pending', 'withdrawn')");
    expect(canMove(BORROW_REQUEST.moves.theyLent, 'withdrawn')).toBe(true);
    expect(canMove(BORROW_REQUEST.moves.decline, 'withdrawn')).toBe(false);
    expect(canMove(RECOMMENDATION.moves.want, 'dismissed')).toBe(false);
    expect(canMove(CONNECTION.moves.confirm, 'awaiting_them')).toBe(false);
    expect(terminal(BORROW_REQUEST).sort()).toEqual(['accepted', 'declined']);
  });

  it('refuses anything but a plain status into SQL', () => {
    expect(() => fromSql({ from: ["open') OR 1=1 --"], to: 'open', why: '' })).toThrow();
  });
});

describe('statements in src/db', () => {
  it('never write a declared status by hand: the value comes from the lifecycle', () => {
    const tables = LIFECYCLES.map((l) => l.column.split('.')[0]!);
    const found: string[] = [];
    for (const [file, source] of Object.entries(dbSources)) {
      if (file.endsWith('/schema.ts')) continue;
      // drizzle: .update(s.connections).set({ …, status: 'active' | someVariable, … })
      for (const m of source.matchAll(/\.update\(s\.(\w+)\)\s*\.set\(\{([^}]*)\}/g)) {
        const status = /\bstatus:\s*([^,\n}]+)/.exec(m[2]!)?.[1]?.trim();
        if (status && !/^[A-Z_]+\.moves\.\w+\.to$|^(move|lend|confirmed|theyLent|want)\.to$/.test(status)) found.push(`${file}: ${m[1]} → ${status}`);
      }
      // raw SQL: UPDATE borrow_requests SET …, status = 'accepted' | ?n …
      for (const m of source.matchAll(/UPDATE\s+(\w+)\s+SET\s+([^`;]*?)\bWHERE\b/gi)) {
        if (!tables.includes(m[1]!)) continue;
        const status = /\bstatus\s*=\s*('[^']*'|\?\d*|\$\{[^}]*\})/.exec(m[2]!)?.[1];
        if (status && !/^'\$\{\w+\.to\}'$/.test(status)) found.push(`${file}: ${m[1]} → ${status}`);
      }
    }
    expect(found).toEqual([]);
  });
});
