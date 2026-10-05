import { expect, test } from 'bun:test';
import { buildRegieReportListExportRows } from './regieReportList.ts';

const date = new Date('2026-10-04T12:00:00Z');
const report = (id, projectId, autoId = 1) => ({
  id, projectId, autoId, day: date, createdAt: date,
  summary: 'Zusatzarbeiten', products: [], specialRecords: [], workHours: [],
});

test('resolves each project once and keeps report order and project-relative numbers', async () => {
  const calls = [];
  const reports = [report('b1', 'b'), report('a1', 'a'), report('b2', 'b', 2)];
  const rows = await buildRegieReportListExportRows(reports, async id => {
    calls.push(id);
    return `Projekt ${id}`;
  });
  expect(calls).toEqual(['b', 'a']);
  expect(rows.map(row => row.id)).toEqual(['b1', 'a1', 'b2']);
  expect(rows.map(row => row.autoId)).toEqual([1, 1, 2]);
  expect(rows.map(row => row.projectTitle)).toEqual(['Projekt b', 'Projekt a', 'Projekt b']);
  expect(rows[0].day).toBe(date);
  expect(rows[0].summary).toBe('Zusatzarbeiten');
  expect(reports[0]).not.toHaveProperty('projectTitle');
  expect(rows[0]).not.toHaveProperty('totalHours');
});

test('does not request projects for an empty listing', async () => {
  const rows = await buildRegieReportListExportRows([], async () => {
    throw new Error('unexpected project request');
  });
  expect(rows).toEqual([]);
});

test('propagates project errors instead of silently exporting incomplete context', async () => {
  await expect(buildRegieReportListExportRows([report('r1', 'p1')], async () => {
    throw new Error('Projekt konnte nicht geladen werden');
  })).rejects.toThrow('Projekt konnte nicht geladen werden');
});
