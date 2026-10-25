Job-Watch (läuft alle 30 Minuten). Zweck: Thomas über abgekoppelte Langzeit-Tasks (xapient-job) auf dem Laufenden halten, da diese keinen Heartbeat auslösen.

1. Prüfe mit `xapient-job list`, welche Jobs den Status `running` haben.
2. Wenn KEIN Job `running` ist: antworte exakt `NOOP` (dann wird nichts gesendet).
3. Wenn Jobs laufen: für jeden laufenden Job EINE kurze Zeile — Name, Laufzeit und die letzte aussagekräftige Fortschrittszeile aus `xapient-job log <name> 12` (z. B. aktuelles Backtest-Ergebnis/Schritt). Höhlenmensch-kurz, keine langen Logs, keine Tabellen.
4. Fertige/gestoppte Jobs NICHT melden — deren Ergebnis meldet der jeweilige Auftrag selbst.
