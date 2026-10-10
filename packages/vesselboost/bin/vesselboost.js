#!/usr/bin/env node
import { parseArgs } from 'node:util';
process.env.ORT_DISABLE_TELEMETRY ??= '1';
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      offline: { type: 'boolean' },
      'cache-dir': { type: 'string' },
      threads: { type: 'string' },
      model: { type: 'string' },
      downsample: { type: 'string' },
      'bias-correction': { type: 'boolean' },
      'no-bias-correction': { type: 'boolean' },
      denoise: { type: 'string' },
      overlap: { type: 'string' },
      threshold: { type: 'string' },
      'minimum-component-size': { type: 'string' },
      'brain-extraction': { type: 'string' },
      'brain-threshold': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(`Usage: vesselboost input.nii[.gz] output-directory [options]
       vesselboost download-models [--cache-dir PATH] [--offline]
       vesselboost self-check

--model manual|omelette1|omelette2|t2s
--downsample 1|2|3|4
--bias-correction / --no-bias-correction (default: enabled)
--denoise none|bilateral|nlm-fast|nlm
--overlap 0|0.5|0.75|0.9  --threshold 0.01..0.5
--minimum-component-size N
--brain-extraction none|bet|synthstrip|synthstrip-fast
--brain-threshold 0..1  --threads N  --cache-dir PATH  --offline`);
    process.exit(0);
  }
  const { segment, downloadModels, checkInstallation } = await import('../src/node.js');
  const common = {
    ...(values['cache-dir'] && { cacheDir: values['cache-dir'] }),
    ...(values.offline && { offline: true }),
    onProgress: (text) => console.error(text),
  };
  let report;
  if (positionals.length === 1 && positionals[0] === 'self-check')
    report = await checkInstallation();
  else if (positionals.length === 1 && positionals[0] === 'download-models')
    report = await downloadModels(common);
  else {
    if (positionals.length !== 2)
      throw new Error('Provide an input image and a new output directory');
    if (values['bias-correction'] && values['no-bias-correction'])
      throw new Error('Choose one bias-correction option');
    const mapping = {
      model: 'model',
      downsample: 'downsample',
      denoise: 'denoise',
      overlap: 'overlap',
      threshold: 'threshold',
      'minimum-component-size': 'minimumComponentSize',
      'brain-extraction': 'brainExtraction',
      'brain-threshold': 'brainThreshold',
    };
    const numeric = new Set([
      'downsample',
      'overlap',
      'threshold',
      'minimum-component-size',
      'brain-threshold',
    ]);
    const parameters = Object.fromEntries(
      Object.entries(mapping)
        .filter(([flag]) => values[flag] !== undefined)
        .map(([flag, name]) => [name, numeric.has(flag) ? Number(values[flag]) : values[flag]])
    );
    if (values['no-bias-correction']) parameters.biasCorrection = false;
    if (values['bias-correction']) parameters.biasCorrection = true;
    report = await segment({
      ...common,
      input: positionals[0],
      output: positionals[1],
      parameters,
      ...(values.threads && { threads: Number(values.threads) }),
    });
  }
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
