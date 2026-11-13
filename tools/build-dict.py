"""Build com.align4.export/data/dict.json from CC-CEDICT.

Usage:  python3 tools/build-dict.py path/to/cedict_ts.u8

CC-CEDICT: https://www.mdbg.net/chinese/dictionary?page=cc-cedict
License:   CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)

For every simplified-Chinese word it keeps one short English gloss suitable for a
file name ("chat_room", "decoration"), dropping variants, surnames, measure words
and long explanations. The panel uses it only after the user's own glossary and
the built-in UI glossary, and only to fill gaps.
"""
import json
import os
import re
import sys

SKIP_PREFIX = ('variant of', 'old variant', 'archaic variant', 'surname', 'cl:', 'see ', 'see also', 'used in',
               'abbr. for', 'abbr. to', 'erhua variant', 'japanese variant', 'taiwan pr.', 'also pr.', 'also written',
               'radical in chinese', 'kangxi radical', 'pr. ', '(bound form)', 'classifier for', 'm[')
CJK = re.compile(r'^[㐀-鿿]+$')
LINE = re.compile(r'^(\S+) (\S+) \[([^\]]*)\] /(.*)/\s*$')
STOP = {'a', 'an', 'the', 'to', 'of', 'one', 'sth', 'sb', 'someone', 'something', 'etc', 'oneself'}


def gloss_candidates(glosses):
    for g in glosses:
        low = g.strip().lower()
        if not low or low.startswith(SKIP_PREFIX) or 'taiwan pr' in low:
            continue
        low = re.sub(r'\([^)]*\)', ' ', low)          # drop "(literary)", "(of a person)"
        low = re.sub(r'\[[^\]]*\]', ' ', low)
        low = low.split(';')[0].split(',')[0]
        words = [w for w in re.findall(r'[a-z0-9]+', low) if w not in STOP]
        if words:
            yield words


def pick(glosses):
    best = None
    for words in gloss_candidates(glosses):
        if len(words) <= 2:
            return words
        if best is None and len(words) <= 3:
            best = words
    return best


def main(src, out):
    table = {}
    with open(src, encoding='utf-8') as f:
        for line in f:
            if line.startswith('#'):
                continue
            m = LINE.match(line)
            if not m:
                continue
            simp, glosses = m.group(2), m.group(4).split('/')
            if not CJK.match(simp) or len(simp) > 6 or simp in table:
                continue
            words = pick(glosses)
            if words:
                table[simp] = '_'.join(words)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'source': 'CC-CEDICT (CC BY-SA 4.0), https://www.mdbg.net/chinese/dictionary?page=cc-cedict',
                   'words': table}, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    print(len(table), 'entries ->', out, os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    main(sys.argv[1], os.path.join(root, 'com.align4.export', 'data', 'dict.json'))
