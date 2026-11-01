# Inside garciaml/brainqcnetcpu: random slice predictions written as
# predict_all_axes.py logs them, summarized by the original
# transform_log_to_csv.py with each method and area count. The cases
# (test/summary-cases.json) hold the summaries to their files.
import json, os, random, subprocess, sys, tempfile
import numpy as np

out = sys.argv[1]
rng = random.Random(20261030)
tables = [{'x': [1] * 101 + [0] * 99, 'y': [0, 1] * 50, 'z': [1] * 7 + [0] * 13}]
for _ in range(23):
    density = rng.random()
    tables.append({axis: [int(rng.random() < density) for _ in range(rng.randint(7, 230))] for axis in 'xyz'})
cases = []
for preds in tables:
    for method, areas in [('percentage', 3), ('mean', 3), ('median', 3), ('mean', 2), ('percentage', 5), ('median', 7)]:
        if any(int((len(p) - 1) / areas) <= 1 for p in preds.values()):
            continue
        d = tempfile.mkdtemp()
        rows = [(p, s, a) for a in 'xyz' for s, p in enumerate(preds[a])]
        rng.shuffle(rows)
        predictions = [r[0] for r in rows]
        share = [round(predictions.count(0) / len(predictions), 2), round(predictions.count(1) / len(predictions), 2)]
        lines = [str(0) + ' ' + str(r) for r in rows] + [
            'Slices predicted 1:' + str([r[1] for r in rows if r[0] > 0]),
            'Corresponding axes: ' + str([r[2] for r in rows if r[0] > 0]),
            'Predicted median: ' + str(np.median(predictions)),
            'Predicted mean: ' + str(np.mean(predictions)),
            'Repartition of predictions: ' + str(share[0] * 100) + ' percent of slices predicted label 0; ' + str(share[1] * 100) + ' percent of slices predicted label 1.',
            'Processing time: 12.3456',
        ]
        open(os.path.join(d, 'global_analysis.log'), 'w').write('\n'.join(lines) + '\n')
        subprocess.run(['venv/bin/python3', 'transform_log_to_csv.py', '-indir', d, '-subid', 'sub-01', '-method', method, '-n_areas', str(areas)], check=True, cwd='/app')
        names = ['table.csv', 'tot_df.csv', 'x_results_locally.csv', 'y_results_locally.csv', 'z_results_locally.csv']
        cases.append({'preds': {a: ''.join(map(str, p)) for a, p in preds.items()}, 'method': method, 'areas': areas,
                      'files': {n: open(os.path.join(d, n)).read() for n in names}})
json.dump(cases, open(out, 'w'))
print(len(cases))
