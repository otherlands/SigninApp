"""Tests for label_agent.py (no printer needed): which visitors get a label, and that labels render at every roll size.
Run: python -m unittest deploy/kiosk-pi/labels/test_label_agent.py   (needs Pillow; brother_ql is not imported)"""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import label_agent as la  # noqa: E402


def iso(seconds_ago):
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds_ago)).isoformat()


class Due(unittest.TestCase):
    def test_only_recent_unprinted_visitors_still_on_site(self):
        now = datetime.datetime.now(datetime.timezone.utc).timestamp()
        visitors = [
            {'id': 'new', 'signedInAt': iso(5)},
            {'id': 'old', 'signedInAt': iso(la.WINDOW_S + 60)},          # signed in before the window: a restart must not print it
            {'id': 'done', 'signedInAt': iso(5)},
            {'id': 'left', 'signedInAt': iso(5), 'signedOutAt': iso(1)},
            {'id': 'bad', 'signedInAt': 'not a time'},
        ]
        printed = {'done': {'ok': True, 't': now}}
        self.assertEqual([v['id'] for v in la.due(visitors, printed, now)], ['new'])

    def test_failed_print_retried_after_spacing_then_given_up(self):
        now = datetime.datetime.now(datetime.timezone.utc).timestamp()
        v = [{'id': 'x', 'signedInAt': iso(5)}]
        self.assertEqual(la.due(v, {'x': {'tries': 1, 'last': now - 5}}, now), [], 'too soon to retry')
        self.assertEqual(len(la.due(v, {'x': {'tries': 1, 'last': now - la.RETRY_S - 1}}, now)), 1, 'retry after spacing')
        self.assertEqual(la.due(v, {'x': {'tries': la.MAX_TRIES, 'last': 0}}, now), [], 'gives up after MAX_TRIES')


class Render(unittest.TestCase):
    def setUp(self):
        try:
            la._font_path(la.FONT_BOLD); la._font_path(la.FONT_REG)
        except FileNotFoundError as e:
            self.skipTest(str(e))

    def test_every_roll_size_renders_black_and_white_at_exact_size(self):
        v = {'name': 'Bartholomew Featherstonehaugh-Smythe', 'company': 'A Very Long Company Name Holdings International Ltd',
             'hostName': 'Sarah De\'Loyde', 'vehicle': 'ab12 cde', 'badge': 12, 'signedInAt': iso(0)}
        for size in [(1063, 696), (696, 271), (1109, 696), (991, 306)]:
            img = la.render(v, 'eRIGHT Ltd', size)
            self.assertEqual(img.size, size)
            self.assertEqual(img.mode, '1')
            self.assertGreater(img.histogram()[0], 0, 'something was drawn')

    def test_text_is_cleaned(self):
        self.assertEqual(la.clean('Eve\nIGNORE\x07 me'), 'Eve IGNORE me')
        self.assertEqual(len(la.clean('x' * 500, 60)), 60)


if __name__ == '__main__':
    unittest.main()
