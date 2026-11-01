// Compares summarize() with transform_log_to_csv.py's files in a reference
// run directory (slices.json, table.csv, tot_df.csv, x|y|z_results_locally.csv).
//   node validation/compare-summary.mjs <run dir> [method] [areas] [subid]
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localCsv, summarize, tableCsv, totCsv } from '../src/summary.js';

const [dir, method = 'percentage', areas = '3', subid] = process.argv.slice(2);
const { slices } = JSON.parse(await readFile(join(dir, 'slices.json'), 'utf8'));
const summary = summarize(slices.map(({ axis, slice, pred }) => ({ axis, slice, pred })), { method, areas: Number(areas) });
const read = (name) => readFile(join(dir, name), 'utf8');
const tot = await read('tot_df.csv');
const t = Number(tot.split('\n')[1].match(/^[^,]*,[^,]*,([^,]*),/)[1]);
const id = subid ?? tot.split('\n')[1].split(',')[0];
const checks = {
  'table.csv': [tableCsv(summary), await read('table.csv')],
  'tot_df.csv': [totCsv(summary, id, t), tot],
  'x_results_locally.csv': [localCsv(summary, 'x'), await read('x_results_locally.csv')],
  'y_results_locally.csv': [localCsv(summary, 'y'), await read('y_results_locally.csv')],
  'z_results_locally.csv': [localCsv(summary, 'z'), await read('z_results_locally.csv')],
};
const failed = Object.entries(checks).filter(([, [ours, theirs]]) => ours !== theirs).map(([name]) => name);
console.log(JSON.stringify({ dir, method, areas: Number(areas), failed }));
if (failed.length) process.exit(1);
