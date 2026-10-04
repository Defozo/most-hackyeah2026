# Instalacja w LAN i odtworzenie

Rdzeń MOST działa na jednym serwerze uprawnionym do przydzielania zasobów. Syntetyczne demo i instalacja organizacji używają osobnych baz. Nigdy nie promuj kopii, kiedy stary serwer może nadal wydawać przydziały.

## Przygotowanie

1. Zainstaluj przypięty Node.js i pnpm. Wykonaj `pnpm install --frozen-lockfile`, `pnpm build-offline`, `node ops/provision-secrets.mjs`, `psst MOST_SIGNING_PRIVATE_KEY -- pnpm preflight`.
2. Wybierz stały adres oraz nazwę DNS obsługiwaną w lokalnej sieci. Dostarcz HTTPS z certyfikatem zaufanym przez wszystkie urządzenia. Zwykły HTTP po adresie LAN nie zapewnia PWA. Wyjątek localhost służy wyłącznie pracy na tym samym urządzeniu.
3. Najpierw lokalnie, przed wystawieniem reverse proxy, utwórz pierwszego administratora z własnym hasłem. Bootstrap przez proxy jest blokowany. Następnie ustaw `APP_ORIGIN` na dokładny adres HTTPS i uruchom reverse proxy. Ogranicz dostęp do serwera regułami sieci organizacji. Utwórz konta i zakresy uprawnień. Nie używaj hasła testowego.
4. Wprowadź model zatwierdzony przez właścicieli. Dane demonstracji nie zastępują inwentarza ani instrukcji bezpieczeństwa.
5. Zapewnij osobne zasilanie awaryjne serwera i punktu LAN. Zmierz autonomię. Awaria routera zewnętrznego nie może odciąć lokalnego punktu dostępowego.
6. Na każdym urządzeniu otwórz aplikację, zaloguj się, przygotuj pakiet i zaufaj kluczowi zweryfikowanemu wcześniej niezależną drogą. Sprawdź pamięć trwałą i eksport. Zablokuj urządzenie i włącz szyfrowanie systemowe.
7. Wyłącz WAN i sprawdź dwie role przez LAN. Następnie odłącz jedno urządzenie od serwera, zamknij i otwórz aplikację, przelicz zmienioną obsadę, zapisz meldunek i eksport. Po powrocie sprawdź kolejkę i konflikty. Test na komputerze nie potwierdza tych warunków w docelowej sieci.

## Kopia i próba

`pnpm backup backups/<nowa-nazwa>` używa spójnego backupu SQLite. Manifest obejmuje bazę i wskazane niezmienne dowody. Brak pliku lub naruszenie hasha przerywa odbiór kopii. Kopie i nośniki wymagają ochrony oraz retencji ustalonej przez administratora.

`pnpm restore-test backups/<nazwa>` kopiuje dane do oddzielnego katalogu próby, sprawdza SQLite, relacje i dowody. Nadaje nową epokę, unieważnia sesje, wymaga przeglądu kont i blokuje ponowne przydzielanie zasobów do fizycznego uzgodnienia. Sprawdza odczyt incydentu i procedury, obliczenie oraz zapis i ponowny odczyt meldunku. Wynik znajduje się w `artifacts/restore-test.json`.

Próba nie promuje serwera. Promocja wymaga zatrzymania starego autorytetu, sprawdzenia aktualnych kont i ról, stanu zasobów, obowiązujących lokalnych pul i zapasów oraz uzgodnienia urządzeń. Nie powtarzaj automatycznie komend mających możliwy skutek fizyczny. Czas upływu rezerwacji nie potwierdza zwrotu agregatu.

Meldunki po ostatniej kopii mogą zostać utracone. Kolejki i zachowane potwierdzenia urządzeń pomagają ustalić luki, lecz nie zapewniają zerowej utraty. Porównaj aktualny dziennik źródła z kursorem kopii i zapisz zmierzone RPO oraz RTO dla własnej próby.

Automatyczna próba HTTP zachowuje metrykę źródła po dodatkowym meldunku zapisanym już po kopii. Polecenie `pnpm restore-test <katalog-kopii> artifacts/restore-current-source.json` oblicza lukę sekwencji i brakujące meldunki względem tej metryki. Czas technicznego odtworzenia nie obejmuje fizycznego przeglądu ani promocji serwera.
