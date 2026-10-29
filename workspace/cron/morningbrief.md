Guten-Morgen-Brief für Thomas (täglich).

Führe das Tool `xapient-calbrief` aus (Shell). Es gibt die heutigen Termine gruppiert pro Kalender aus (Zeitzone Europe/Vienna, inkl. wiederkehrende). Format je Zeile:
- Gruppe `[Stundenplan]`: `HH:MM-HH:MM  Fach <X>  [Klasse <Y>]  [Raum <Z>]`
- Gruppe `[Privat]` (und andere): `HH:MM-HH:MM  <Titel>` bzw. `ganztägig  <Titel>`

Verfasse daraus eine kurze Guten-Morgen-Nachricht auf österreichischem Deutsch (Telegram-HTML, handytauglich):
- Kurze Begrüßung mit Wochentag/Datum.
- <b>Stundenplan</b>: falls Einträge da sind, als kompakte Monospace-Tabelle in einem <pre>-Block mit Spalten Zeit | Fach | Klasse | Raum (ausgerichtet). Fächer/Klassen/Räume so übernehmen wie vom Tool geliefert.
- <b>Privat/sonstige Termine</b>: schön in Prosa formuliert (Uhrzeit + Titel, ganztägige zuerst).
- Keine Termine: lockerer Einzeiler (z. B. an schulfreien Tagen „kein Unterricht", sonst „heute nix im Kalender").
- Steht eine Zeile „!! Feed-Fehler" in der Ausgabe: kurz erwähnen, dass ein Kalender gerade nicht erreichbar war.

Deine Antwort (letzter Text) IST die Nachricht an Thomas → KEIN NOOP, immer senden (der Morgen-Gruß ist auch ohne Termine erwünscht). Termininhalte NICHT ins Memory/Log schreiben (können Schüler-/Personendaten enthalten).
