"""CLI contract for the controlled geometry diagnostic."""
from contextlib import redirect_stderr, redirect_stdout
import io
import unittest
from unittest.mock import patch

import polyshape_controlled


class ControlledCliTests(unittest.TestCase):
    def test_invalid_invocations_fail_with_usage(self):
        for args in ([], ['typo'], ['spec'], ['report', 'root'],
                     ['spec', 'root', 'oracle', 'out', 'extra']):
            with self.subTest(args=args):
                errors = io.StringIO()
                with redirect_stderr(errors), self.assertRaises(SystemExit) as error:
                    polyshape_controlled.main(args)
                self.assertEqual(error.exception.code, 2)
                self.assertIn('usage:', errors.getvalue())

    def test_help_succeeds(self):
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaises(SystemExit) as error:
            polyshape_controlled.main(['--help'])
        self.assertEqual(error.exception.code, 0)
        self.assertIn('spec,report', output.getvalue())

    def test_valid_commands_dispatch_all_paths(self):
        for command in ('spec', 'report'):
            with self.subTest(command=command):
                with patch.object(polyshape_controlled, 'main_' + command) as handler:
                    polyshape_controlled.main([command, 'host dir', 'oracle path', 'out.json'])
                handler.assert_called_once_with('host dir', 'oracle path', 'out.json')


if __name__ == '__main__':
    unittest.main()
