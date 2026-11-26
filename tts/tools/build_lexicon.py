#!/usr/bin/env python3
"""Baut tts/lexicon/{de,en}.txt aus den Leipzig-Wortlisten (Wortschatz Leipzig, CC BY 4.0).

Rohdaten (nicht im Repo, ~160 MB):
  https://downloads.wortschatz-leipzig.de/corpora/deu_news_2023_300K.tar.gz
  https://downloads.wortschatz-leipzig.de/corpora/eng_news_2023_300K.tar.gz
Aufruf: python3 -I build_lexicon.py <deu-words.txt> <eng-words.txt> <ausgabe-dir>
  en.txt: englische Woerter (klein), >= EN_MIN Vorkommen.
  de.txt: deutsche Woerter (Schreibung wie im Korpus), nur die, deren Kleinform auch in en.txt steht
          (nur dort muss entschieden werden) -> kleine Datei, wenig RAM.
Bereinigung: englischer Fremdtext in deutschen News ("the", "Meeting", "Morning") faellt aus de.txt,
wenn er im Englischen >= NOISE_RATIO-mal haeufiger ist (relativ). Schwelle so gewaehlt, dass
Kognaten wie global/legal/national/Student deutsch bleiben (die liegen < 50).
"""
import collections
import re
import sys

DE_MIN, EN_MIN, NOISE_RATIO = 2, 3, 50
WORD = re.compile(r"^[^\W\d_]+$")


def load(path):
    c = collections.Counter()
    with open(path, encoding="utf-8", errors="replace") as f:
        for ln in f:
            a = ln.rstrip("\n").split("\t")
            if len(a) == 3 and WORD.match(a[1]):
                c[a[1]] += int(a[2])
    return c


def main(de_path, en_path, out):
    de, en = load(de_path), load(en_path)
    en_low, de_low = collections.Counter(), collections.Counter()
    for w, n in en.items():
        en_low[w.lower()] += n
    for w, n in de.items():
        de_low[w.lower()] += n
    sde, sen = sum(de.values()), sum(en.values())
    en_set = {w for w, n in en_low.items() if n >= EN_MIN}
    noise = {w for w in en_set if de_low[w] and (en_low[w] / sen) / (de_low[w] / sde) >= NOISE_RATIO}
    de_set = {w for w, n in de.items()
              if n >= DE_MIN and w.lower() in en_set and w.lower() not in noise}
    src = "# Quelle: Wortschatz Leipzig {} (CC BY 4.0), erzeugt von tools/build_lexicon.py\n"
    with open(f"{out}/en.txt", "w", encoding="utf-8") as f:
        f.write(src.format("eng_news_2023_300K"))
        f.write("\n".join(sorted(en_set)) + "\n")
    with open(f"{out}/de.txt", "w", encoding="utf-8") as f:
        f.write(src.format("deu_news_2023_300K"))
        f.write("\n".join(sorted(de_set)) + "\n")
    print(f"en={len(en_set)} de={len(de_set)} noise_removed={len(noise)}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
