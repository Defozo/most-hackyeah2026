# MOST: ciągłość lokalnych usług

MOST pomaga koordynatorowi gminy lub punktu pomocy ustalić, co uruchomić najpierw podczas awarii zasilania, łączności lub systemów IT. Łączy zależności usług z dostępnością ludzi, sprzętu i zapasów, wyznacza plan w granicach tych zasobów i prowadzi zespół przez wykonanie oraz osobne sprawdzenie rezultatu.

**DEFOZO SOFTWARE HOUSE | Michał Kiełtyka**

[Film i prezentacja](https://hackyeah-2026-projekty.defozo.chatgpt.site/#defence) · [Uruchomienie lokalne](#uruchomienie-lokalne) · [Projekt w HackTribe](https://hackyeah2026.hacktribe.co/most-ciaglosc-lokalnych-uslug/)

## Do czego służy

Koordynator gminy, punktu pomocy lub lokalnej infrastruktury może opisać usługi, ich minimalną wydajność, zależności, personel, sprzęt i zapasy. MOST pozwala sprawdzić, czy dwa zapasowe kanały łączności nie zależą od tego samego routera, czy jeden agregat nie otrzymał sprzecznych przydziałów oraz jak niepotwierdzona dostępność osoby zmienia wynik planu.

| Decyzja podczas awarii | Wsparcie w MOST |
| --- | --- |
| Który zapasowy wariant rzeczywiście jest niezależny? | Graf pokazuje wspólne zależności, takie jak router lub zasilanie współdzielone przez dwa kanały łączności |
| Komu przydzielić ludzi i sprzęt? | Plan uwzględnia obsadę i wyposażenie w kolejnych przedziałach czasu, zużycie zapasów, minima usług i priorytety |
| Którą niepewną informację sprawdzić najpierw? | Porównanie wariantów dostępności pokazuje wpływ potwierdzenia zasobu na plan i usługominuty; niepotwierdzone zasoby pozostają warunkowe |
| Czy wykonana czynność przywróciła usługę? | Oddzielny test rezultatu ma własny wynik, czas ważności, wersję procedury i dowody |

Model można przygotować z JSON/CSV lub szkiców z dokumentów. Meldunki zachowują
źródło i czas, przydziały wymagają zatwierdzenia, a dziennik pozwala odtworzyć
przebieg decyzji i działań. Ukończenie zadania i potwierdzenie działania usługi
są oddzielnymi krokami.

## Praca po utracie połączenia

Przygotowana PWA przechowuje model, procedury i solver na urządzeniu. Pozwala
przeliczyć lokalną propozycję, zapisać meldunek oraz kontynuować zadania w wcześniej
przyznanej lokalnej puli. Nowe globalne rezerwacje wymagają serwera. Po powrocie
łączności aplikacja uzgadnia kolejkę i pokazuje konflikty, także po odtworzeniu
serwera z kopii. Rdzeń planowania i przygotowane procedury działają bez usługi AI.

Przed użyciem operacyjnym trzeba przygotować i sprawdzić konkretne urządzenia,
potwierdzić zasoby oraz zatwierdzić procedury. Demo ilustruje ten proces na danych
syntetycznych; wynik modelu nie jest potwierdzeniem działania infrastruktury.

## Uruchomienie lokalne

Wymagania: Node.js **24.13.0**, pnpm **10.33.0**, `psst` CLI w PATH. Skrypty `.ps1` wymagają PowerShell **7.2+**. SQLite i Argon2 korzystają z modułów natywnych; gdy gotowe binaria nie są dostępne, instalacja wymaga Pythona i narzędzi kompilacji C++.

```powershell
pnpm install --frozen-lockfile
pnpm build-offline
node ops/provision-secrets.mjs
psst MOST_SIGNING_PRIVATE_KEY -- pnpm preflight
psst MOST_SIGNING_PRIVATE_KEY -- pnpm start
```

Otwórz `http://localhost:8080` i utwórz administratora z własnym hasłem. Nowa instalacja zawiera syntetyczny scenariusz trzech usług. Skrypt klucza zachowuje istniejący sekret w psst; nie wykonuje automatycznej rotacji.

Konfigurację niesekretną opisuje [.env.example](.env.example). Najważniejsze zmienne to `HOST`, `PORT`, `APP_ORIGIN`, `DATA_DIR`, `DEMO_MODE`, `AI_PROVIDER`, `PUBLIC_IMPORT_ENABLED` i `SOLVER_TIME_LIMIT_SECONDS`. Własny plik `.env` można wczytać tak:

```powershell
psst MOST_SIGNING_PRIVATE_KEY -- node --env-file=.env --import tsx apps/api/src/server.ts
```

Klucze przechowuj w psst, poza `.env`, argumentami poleceń i zmiennymi `VITE_*`. Rdzeń działa z `AI_PROVIDER=none` i `PUBLIC_IMPORT_ENABLED=false`. Opcjonalne adaptery Groq i Firecrawl używają `GROQ_API_KEY` oraz `FIRECRAWL_API_KEY`; przekazanie tekstu lub publicznego URL wymaga działania użytkownika. Propozycje integracji nie zmieniają modelu ani przydziałów bez zatwierdzenia.

Tryb deweloperski uruchamia `pnpm dev`. Pracę offline sprawdzaj na zbudowanej aplikacji serwowanej przez API. PWA wymaga HTTPS lub localhost.

## Scenariusz demonstracyjny

1. Uruchom osobną sesję demo i obejrzyj graf. Światłowód i LTE współdzielą router oraz zasilanie.
2. Oblicz plan pełnej obsady. Oczekiwany wynik modelu to **310 z 360 usługominut**; minima trzech usług są osiągalne od 30. minuty.
3. Porównaj wariant trzech osób: **220 usługominut**. Sprawdź wpływ potwierdzenia dostępności Daniela.
4. Zatwierdź plan, przyjmij zadanie, potwierdź warunki i zapisz wykonanie. Następnie przeprowadź osobny test rezultatu.
5. Przygotuj urządzenie, odłącz je od serwera, przelicz lokalny wariant i zapisz meldunek. Po odzyskaniu połączenia uzgodnij zmiany i wyeksportuj dziennik.

Dane i osoby w scenariuszu są syntetyczne. Radio i pompa są symulowane; test rejestru rzeczywiście zapisuje i odczytuje syntetyczne zgłoszenie. Obliczenia są prognozą modelu, a wynik trzeba potwierdzić zgodnie z procedurą danej usługi.

## Wdrożenie i utrzymanie

Ćwiczenie i instalację organizacji uruchamia się osobno:

```powershell
./ops/start.ps1 -Port 8138 -Exercise
./ops/start.ps1 -Port 8139 -Production
```

Ćwiczenie otrzymuje własny katalog danych. Instalacja organizacji zaczyna od pustego modelu w `data/production`, z oddzielnymi kontami, sesjami i rezerwacjami. Przed pracą operacyjną właściciele usług wprowadzają rzeczywiste dane, zatwierdzają procedury i sprawdzają przygotowane urządzenia w swojej sieci. [Instrukcja LAN i odtworzenia](docs/LAN-AND-RECOVERY.md) opisuje HTTPS, konta, zasilanie, kopie i promocję odtworzonego serwera.

```powershell
pnpm backup backups/proba-001
pnpm restore-test backups/proba-001
```

Próba odtworzenia sprawdza spójność bazy i dowodów, nadaje nową epokę i wymaga ponownego uzgodnienia zasobów. Nie zastępuje serwera automatycznie. Kopia obejmuje stan z chwili jej utworzenia.

Podstawowe utrzymanie obejmuje własny host, sieć lokalną, kopie zapasowe, przegląd kont oraz aktualizowanie danych i procedur. Rdzeń nie wymaga płatnych usług AI. Opcjonalne integracje podlegają kosztom i zasadom wybranego dostawcy. [Próba wdrożeniowa](docs/USER-STUDY.md) pomaga ocenić przydatność rozwiązania z docelowymi koordynatorami i wykonawcami.

## Testy i dokumentacja

```powershell
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

[TESTING.md](docs/TESTING.md) zawiera wyniki referencyjne, polecenia dalszych prób oraz zakres weryfikacji telefonu, dostępności i wydajności. Domyślny budżet solvera wynosi 5 s; nie gwarantuje optimum ani znalezienia niepustego planu dla każdego modelu. Dłuższy budżet wymaga jawnego wyboru.

- [Jednostki zasobów i przydziały](docs/MODEL-RESOURCES.md)
- [Walidacja fragmentów modelu](docs/MODEL-FRAGMENTS.md)
- [Utrzymanie publicznej demonstracji](docs/PUBLIC-DEMO.md)
- [Materiały projektu](docs/SUBMISSION.md)
- [Pochodzenie prac i danych](docs/PROVENANCE.md)
- [Źródła i licencje](ATTRIBUTIONS.md)

Kod interfejsu znajduje się w `apps/web`, API w `apps/api`, model w `packages/contracts`, silnik planowania w `packages/engine`, a scenariusz w `packages/scenarios`. Katalogi `tests` i `ops` zawierają testy oraz narzędzia uruchomienia i utrzymania.
