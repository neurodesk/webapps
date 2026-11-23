import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import build_container
import prepare


def git(directory, *args):
    return subprocess.run(['git', '-C', str(directory), *args], check=True,
                          capture_output=True, text=True).stdout.strip()


class RepairSets(unittest.TestCase):
    """The CLI set adds the HRF column repair; the source set stays three repairs."""

    def checkout(self):
        root = Path(tempfile.mkdtemp(dir=os.environ.get('TMPDIR')))
        source = root / 'samsrf'
        source.mkdir()
        git(source, 'init', '-q')
        for name, before, _ in prepare.repairs(cli=True):
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            text = path.read_text() if path.exists() else '% fixture\n'
            path.write_text(text + before + '\n')
        git(source, 'add', '.')
        git(source, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture')
        return root, source, {**prepare.SOURCE, 'commit': git(source, 'rev-parse', 'HEAD')}

    def test_cli_repair_keeps_the_doublegamma_column_and_records_hashes(self):
        root, source, pinned = self.checkout()
        with mock.patch.object(prepare, 'SOURCE', pinned):
            prepare.prepare(source, root / 'out', cli=True)
        record = json.loads((root / 'out' / 'source.json').read_text())
        self.assertEqual(record['repairSet'], 'samsrfanalysis-cli')
        paths = [item['path'] for item in record['files']]
        self.assertEqual(paths.count('Fitting/samsrf_fit_prf.m'), 1)
        self.assertEqual(paths.count('Fitting/samsrf_revcor_prf.m'), 1)
        for name in ['Fitting/samsrf_fit_prf.m', 'Fitting/samsrf_revcor_prf.m']:
            text = (source / name).read_text()
            self.assertIn('samsrf_doublegamma(Model.TR, [fP(1:2) 1 1 fP(3) 0 32]) * fP(4);', text)
            self.assertNotIn("32])'", text)
        self.assertTrue(all(item['originalSha256'] != item['patchedSha256'] for item in record['files']))

    def test_source_reference_keeps_its_three_repairs(self):
        root, source, pinned = self.checkout()
        with mock.patch.object(prepare, 'SOURCE', pinned):
            prepare.prepare(source, root / 'out')
        record = json.loads((root / 'out' / 'source.json').read_text())
        self.assertNotIn('repairSet', record)
        self.assertEqual(len(record['files']), 3)
        self.assertIn("32])' * fP(4);", (source / 'Fitting/samsrf_fit_prf.m').read_text())

    def test_the_build_requires_the_cli_set(self):
        for cli in [False, True]:
            with self.subTest(cli=cli):
                root, source, pinned = self.checkout()
                with mock.patch.object(prepare, 'SOURCE', pinned), \
                        mock.patch.object(build_container, 'SOURCE', pinned):
                    prepare.prepare(source, root / 'out', cli=cli)
                    with self.assertRaisesRegex(ValueError, 'SPM' if cli else 'prepare.py --cli'):
                        build_container.verify_source(source, source)

    def test_the_build_records_the_provenance_prepare_wrote(self):
        root, source, pinned = self.checkout()
        spm = root / 'spm'
        spm.mkdir()
        git(spm, 'init', '-q')
        (spm / 'spm.m').write_text('% fixture\n')
        git(spm, 'add', '.')
        git(spm, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture')
        pinned = {**pinned, 'spm': {**pinned['spm'], 'commit': git(spm, 'rev-parse', 'HEAD')}}
        with mock.patch.object(prepare, 'SOURCE', pinned), \
                mock.patch.object(build_container, 'SOURCE', pinned):
            prepare.prepare(source, root / 'out', cli=True)
            built = build_container.verify_source(source, spm)
        self.assertEqual(built, json.loads((root / 'out' / 'source.json').read_text()))
        self.assertIn('Keep the subject-HRF file route a column, as samsrf_doublegamma returns it', built['patches'])

    def test_clean_stage_excludes_git_ignored_files_and_sparse_entries(self):
        root, source, _ = self.checkout()
        # Add a .gitignore rule and an ignored .m file: Git reports clean, but it must not be staged.
        (source / '.gitignore').write_text('ignored_extra.m\n')
        subprocess.run(['git', '-C', str(source), '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.gitignore'], check=True)
        subprocess.run(['git', '-C', str(source), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ignore'], check=True)
        (source / 'ignored_extra.m').write_text('% must not reach MATLAB Compiler\n')
        staged = root / 'staged-samsrf'
        hashes = build_container.stage_clean_tree(source, staged)
        self.assertGreater(len(hashes), 0)
        self.assertFalse((staged / '.git').exists())
        self.assertFalse((staged / 'ignored_extra.m').exists())
        self.assertNotIn('ignored_extra.m', hashes)
        self.assertEqual([p for p in staged.rglob('*') if p.name == '.git'], [])
        for rel in hashes:
            self.assertEqual((staged / rel).read_bytes(), (source / rel).read_bytes())

    def test_clean_stage_handles_sparse_checkout_and_excludes_ignored_files(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
            base = Path(tmp)
            upstream = base / 'spm-upstream'
            upstream.mkdir()
            (upstream / '.gitignore').write_text('local_debug.m\n')
            (upstream / 'spm.m').write_text('% spm\n')
            (upstream / '@gifti').mkdir()
            (upstream / '@gifti' / 'gifti.m').write_text('% gifti\n')
            (upstream / 'toolbox').mkdir()
            (upstream / 'toolbox' / 'left_out.m').write_text('% excluded\n')
            git = ['git', '-C', str(upstream), '-c', 'user.name=t', '-c', 'user.email=t@t']
            subprocess.run(['git', 'init', '-q', str(upstream)], check=True)
            subprocess.run(git + ['add', '.'], check=True)
            subprocess.run(git + ['commit', '-q', '-m', 'init'], check=True)
            sparse = base / 'spm-sparse'
            subprocess.run(['git', 'clone', '-q', '--sparse', str(upstream), str(sparse)], check=True)
            subprocess.run(['git', '-C', str(sparse), 'sparse-checkout', 'init', '--cone'], check=True)
            subprocess.run(['git', '-C', str(sparse), 'sparse-checkout', 'set', '@gifti'], check=True)
            (sparse / 'local_debug.m').write_text('% ignored file must not be staged\n')
            self.assertEqual(subprocess.check_output(['git', '-C', str(sparse), 'status', '--porcelain'], text=True), '')
            staged = base / 'staged-spm'
            hashes = build_container.stage_clean_tree(sparse, staged)
            self.assertEqual(sorted(hashes), ['.gitignore', '@gifti/gifti.m', 'spm.m'])
            self.assertFalse((staged / 'local_debug.m').exists())
            self.assertFalse((staged / 'toolbox').exists())
            # Restoring a cone-excluded tracked file with its committed bytes keeps git status
            # clean and flips its ls-files tag from S to H, so cone enforcement must reject it.
            (sparse / 'toolbox').mkdir()
            (sparse / 'toolbox' / 'left_out.m').write_text('% excluded\n')
            self.assertEqual(subprocess.check_output(['git', '-C', str(sparse), 'status', '--porcelain'], text=True), '')
            with self.assertRaisesRegex(ValueError, 'Sparse-excluded path unexpectedly materialized'):
                build_container.stage_clean_tree(sparse, base / 'staged-spm-leaked')

    def test_clean_stage_allows_nested_sparse_cone_ancestor_files(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
            base = Path(tmp)
            upstream = base / 'nested-upstream'
            (upstream / 'parent' / 'selected').mkdir(parents=True)
            (upstream / 'parent' / 'other').mkdir(parents=True)
            (upstream / 'root.m').write_text('% root\n')
            (upstream / 'parent' / 'shared.m').write_text('% ancestor sibling\n')
            (upstream / 'parent' / 'selected' / 'keep.m').write_text('% selected\n')
            (upstream / 'parent' / 'other' / 'skip.m').write_text('% excluded\n')
            git = ['git', '-C', str(upstream), '-c', 'user.name=t', '-c', 'user.email=t@t']
            subprocess.run(['git', 'init', '-q', str(upstream)], check=True)
            subprocess.run(git + ['add', '.'], check=True)
            subprocess.run(git + ['commit', '-q', '-m', 'init'], check=True)
            sparse = base / 'nested-sparse'
            subprocess.run(['git', 'clone', '-q', '--sparse', str(upstream), str(sparse)], check=True)
            subprocess.run(['git', '-C', str(sparse), 'sparse-checkout', 'init', '--cone'], check=True)
            subprocess.run(['git', '-C', str(sparse), 'sparse-checkout', 'set', 'parent/selected'], check=True)
            staged = base / 'staged-nested'
            hashes = build_container.stage_clean_tree(sparse, staged)
            self.assertEqual(sorted(hashes), ['parent/selected/keep.m', 'parent/shared.m', 'root.m'])
            # Restoring a sibling directory outside parent/selected is still rejected.
            (sparse / 'parent' / 'other').mkdir()
            (sparse / 'parent' / 'other' / 'skip.m').write_text('% excluded\n')
            with self.assertRaisesRegex(ValueError, 'Sparse-excluded path unexpectedly materialized'):
                build_container.stage_clean_tree(sparse, base / 'staged-nested-bad')

    def test_clean_stage_rejects_symlinks_in_source(self):
        root, source, _ = self.checkout()
        target = next(p for p in source.rglob('*') if p.is_file() and '.git' not in p.parts)
        (source / 'linked.m').symlink_to(target)
        subprocess.run(['git', '-C', str(source), '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'linked.m'], check=True)
        with self.assertRaisesRegex(ValueError, 'Symbolic links'):
            build_container.stage_clean_tree(source, root / 'staged-symlink')

    def test_record_base_images_verifies_layer_lineage_and_fails_closed(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
            root = Path(tmp)
            (root / 'runtime').mkdir()
            (root / 'container').mkdir()
            (root / 'runtime' / 'Dockerfile').write_text('FROM mathworks/matlab-deps:r2023b AS base\nRUN echo ok\n')
            (root / 'container' / 'Dockerfile').write_text('FROM --platform=linux/amd64 samsrf-reference-runtime:r2023b\n')
            images = {
                'mathworks/matlab-deps:r2023b': {
                    'id': 'sha256:base', 'repoDigests': ['mathworks/matlab-deps@sha256:1111'],
                    'layers': ['sha256:l1', 'sha256:l2'],
                },
                'samsrf-reference-runtime:r2023b': {
                    'id': 'sha256:rt', 'repoDigests': [],
                    'layers': ['sha256:l1', 'sha256:l2', 'sha256:l3'],
                },
                'samsrf-reference:41ed1e96-r2023b': {
                    'id': 'sha256:app', 'repoDigests': [],
                    'layers': ['sha256:l1', 'sha256:l2', 'sha256:l3', 'sha256:l4'],
                },
            }

            record = build_container.record_base_images(root, inspector=lambda ref: images[ref])
            self.assertEqual(record['dockerfiles'], {
                'runtime': ['mathworks/matlab-deps:r2023b'],
                'container': ['samsrf-reference-runtime:r2023b'],
            })
            self.assertTrue(record['lineageVerified'])
            self.assertEqual(set(record['dockerfileSha256'].keys()), {'runtime', 'container'})
            self.assertEqual(json.loads((root / 'base-images.json').read_text()), record)

            # Stale/replaced mutable tag whose layers are not a prefix of runtime fails closed.
            stale = {**images, 'mathworks/matlab-deps:r2023b': {
                'id': 'sha256:other', 'repoDigests': [], 'layers': ['sha256:l1', 'sha256:different']}}
            with self.assertRaisesRegex(ValueError, 'not a prefix'):
                build_container.record_base_images(root, inspector=lambda ref: stale[ref])

            # Failed/null image lookup fails closed.
            with self.assertRaisesRegex(ValueError, 'Missing Docker image ID'):
                build_container.record_base_images(root, inspector=lambda ref: None)

            # Missing generated Dockerfile fails closed.
            (root / 'runtime' / 'Dockerfile').unlink()
            with self.assertRaisesRegex(ValueError, 'Missing generated Dockerfile'):
                build_container.record_base_images(root, inspector=lambda ref: images[ref])

            # Multi-stage Dockerfile resolving final FROM via an earlier stage alias must
            # validate lineage against that earlier stage's external base, not a later unused base.
            (root / 'runtime' / 'Dockerfile').write_text(
                'FROM base1:r2023b AS s1\nFROM base2:r2023b AS s2\nFROM s1\n')
            multistage = {
                **images,
                'base1:r2023b': {'id': 'sha256:b1', 'repoDigests': [], 'layers': ['sha256:a1']},
                'base2:r2023b': {'id': 'sha256:b2', 'repoDigests': [], 'layers': ['sha256:l1', 'sha256:l2']},
            }
            with self.assertRaisesRegex(ValueError, 'Base image base1:r2023b .* not a prefix'):
                build_container.record_base_images(root, inspector=lambda ref: multistage[ref])
            multistage_ok = {
                **multistage,
                'samsrf-reference-runtime:r2023b': {'id': 'sha256:rt', 'repoDigests': [], 'layers': ['sha256:a1', 'sha256:rt1']},
                'samsrf-reference:41ed1e96-r2023b': {'id': 'sha256:app', 'repoDigests': [], 'layers': ['sha256:a1', 'sha256:rt1', 'sha256:app1']},
            }
            ok = build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])
            self.assertEqual(ok['finalBases']['runtime'], 'base1:r2023b')

            # COPY --from= (including across line continuations) cannot be verified by layer prefix alone.
            (root / 'runtime' / 'Dockerfile').write_text(
                'FROM base1:r2023b AS s1\nFROM base2:r2023b\nCOPY \\\n  --from=s1 /x /x\n')
            with self.assertRaisesRegex(ValueError, 'Unsupported COPY/ADD --from='):
                build_container.record_base_images(root, inspector=lambda ref: multistage[ref])

            # Continued final FROM instruction must be parsed rather than falling back to an earlier stage.
            (root / 'runtime' / 'Dockerfile').write_text(
                'FROM base2:r2023b AS s1\nFROM \\\n  base1:r2023b\n')
            with self.assertRaisesRegex(ValueError, 'Base image base1:r2023b .* not a prefix'):
                build_container.record_base_images(root, inspector=lambda ref: multistage[ref])
            ok_continued = build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])
            self.assertEqual(ok_continued['finalBases']['runtime'], 'base1:r2023b')

            # Custom # escape=` directive is honored for continued instructions too.
            (root / 'runtime' / 'Dockerfile').write_text(
                '# escape=`\nFROM base2:r2023b AS s1\nFROM `\n  base1:r2023b\n')
            ok_backtick = build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])
            self.assertEqual(ok_backtick['finalBases']['runtime'], 'base1:r2023b')

            # Doubled trailing escape ends the instruction (does not swallow the next FROM).
            (root / 'runtime' / 'Dockerfile').write_text(
                'FROM base2:r2023b AS s1\nRUN echo ok\\\\\nFROM base1:r2023b\n')
            ok_doubled = build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])
            self.assertEqual(ok_doubled['finalBases']['runtime'], 'base1:r2023b')

            # Blank lines and comments inside a pending continuation are skipped (BuildKit rule).
            (root / 'runtime' / 'Dockerfile').write_text(
                'FROM base2:r2023b AS s1\nFROM \\\n\n# comment\n  base1:r2023b\n')
            ok_blank = build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])
            self.assertEqual(ok_blank['finalBases']['runtime'], 'base1:r2023b')

            # An unrecognized # key=value comment ends parser directive scanning, so a later
            # # escape=` does not disable backslash continuations.
            (root / 'runtime' / 'Dockerfile').write_text(
                '# unknown=1\n# escape=`\nFROM base2:r2023b AS s1\nFROM \\\n  base1:r2023b\n')
            ok_unknown_dir = build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])
            self.assertEqual(ok_unknown_dir['finalBases']['runtime'], 'base1:r2023b')

            # Recognized # check= directive with internal whitespace keeps scanning active for # escape=`.
            (root / 'runtime' / 'Dockerfile').write_text(
                '# check=skip=JSONArgsRecommended; error=true\n# escape=`\nFROM base2:r2023b AS s1\nFROM `\n  base1:r2023b\n')
            ok_check_ws = build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])
            self.assertEqual(ok_check_ws['finalBases']['runtime'], 'base1:r2023b')

            # Zero-character # check= / # syntax= / # escape= stops directive scanning (BuildKit rule).
            for empty_dir in ('# check=\n', '# syntax=\n', '# escape=\n'):
                (root / 'runtime' / 'Dockerfile').write_text(
                    f'{empty_dir}# escape=`\nFROM base2:r2023b AS s1\nRUN echo ok`\nFROM base1:r2023b\n')
                ok_empty = build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])
                self.assertEqual(ok_empty['finalBases']['runtime'], 'base1:r2023b')

            # Whitespace-only # syntax= / # check= matches BuildKit's (.+) directive value and
            # keeps scanning active, so the following # escape=` takes effect.
            for ws_dir in ('# syntax=   \n', '# check=  \n'):
                (root / 'runtime' / 'Dockerfile').write_text(
                    f'{ws_dir}# escape=`\nFROM base2:r2023b AS s1\nRUN echo ok`\nFROM base1:r2023b\n')
                multistage_b2 = {
                    **multistage_ok,
                    'samsrf-reference-runtime:r2023b': {'id': 'sha256:rt', 'repoDigests': [], 'layers': ['sha256:l1', 'sha256:l2', 'sha256:rt1']},
                    'samsrf-reference:41ed1e96-r2023b': {'id': 'sha256:app', 'repoDigests': [], 'layers': ['sha256:l1', 'sha256:l2', 'sha256:rt1', 'sha256:app1']},
                }
                ok_ws = build_container.record_base_images(root, inspector=lambda ref: multistage_b2[ref])
                self.assertEqual(ok_ws['finalBases']['runtime'], 'base2:r2023b')

            # Whitespace-only, non-ASCII-whitespace, or Unicode line-separator # escape= fails closed.
            for bad_escape in ('# escape=   \n', '# escape=`\u00a0\n', '# escape=`\u0085\n', '# escape=`\u2028\n', '# escape=`\u2029\n'):
                (root / 'runtime' / 'Dockerfile').write_text(f'{bad_escape}FROM base1:r2023b\n')
                with self.assertRaisesRegex(ValueError, 'Unsupported Dockerfile escape directive'):
                    build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])

            # Invalid # escape= value (including multi-token) and duplicate directives fail closed.
            (root / 'runtime' / 'Dockerfile').write_text('# escape=invalid token\nFROM base1:r2023b\n')
            with self.assertRaisesRegex(ValueError, 'Unsupported Dockerfile escape directive'):
                build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])
            (root / 'runtime' / 'Dockerfile').write_text('# check=error=true\n# CHECK=error=false\nFROM base1:r2023b\n')
            with self.assertRaisesRegex(ValueError, 'Duplicate Dockerfile parser directive'):
                build_container.record_base_images(root, inspector=lambda ref: multistage_ok[ref])


if __name__ == '__main__':
    unittest.main()
