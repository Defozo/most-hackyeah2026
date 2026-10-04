# Testy MOST

## Wyniki referencyjne

Weryfikacja z 4 października 2026 r. na Node.js 24.13.0 i pnpm 10.33.0:

| Kontrola | Wynik |
| --- | --- |
| Instalacja z przypiętym lockfile | Przeszła |
| Kontrola typów | Przeszła |
| Budowanie aplikacji i pakietu offline | Przeszło |
| Testy domeny, API, klienta i pakietu | 188/188 |
| Pełny przepływ HTTP na izolowanej bazie | 33/33 |

Kontrole dotyczą syntetycznego scenariusza. Nie korzystają z kont użytkowników ani płatnych integracji.

## Powtarzanie prób

```powershell
pnpm typecheck
pnpm test
pnpm build-offline
pnpm exec tsx ops/verify-live.ts
pnpm exec playwright install chromium
pnpm test:e2e
pnpm exec tsx ops/verify-local-browser.ts
pnpm benchmark:worker
pnpm exec tsx ops/benchmark-availability.ts
pnpm compare-offline
```

Próby HTTP i przeglądarki tworzą własne konta i bazy. Porty: 8091 dla E2E, 8092 dla HTTP i 8095 dla lokalnej próby offline. Przed uruchomieniem pozostaw je wolne. Narzędzia zapisują wyniki bieżącego przebiegu w lokalnym `artifacts/`.

Próba offline sprawdza podpisany pakiet, wyłączenie serwera, ponowny start aplikacji, lokalne planowanie i wykonanie, eksport oraz uzgodnienie po utracie odpowiedzi. `pnpm seed-demo` zapisuje wersjonowany plik scenariusza do importu, bez nadpisywania organizacji.

## Budżet obliczeń

Domyślny limit pracy solvera wynosi 5 s. Czas całego żądania obejmuje dodatkowo importy i inicjalizację WASM. Wynik `feasible` oznacza plan sprawdzony przez walidator, bez dowodu optimum. Dla złożonego modelu może to być pusty plan z jawnym niedoborem usług. W referencyjnej próbie 24 usług przy limicie 5 s zachowano właśnie taki wynik; nie jest on dowodem niewykonalności modelu. Użytkownik może wydłużyć budżet lub sprawdzić własny plan.

Funkcjonalna próba pełnego przepływu offline korzysta z jawnie wybranego budżetu 30 s. Wydajność na docelowym urządzeniu należy mierzyć osobno.

## Urządzenia i próba wdrożeniowa

Przebieg funkcjonalny emulatora Android przeszedł 11/11 kontroli. Końcowy odbiór wizualny i sprawdzenie fizycznego telefonu nie zostały ukończone. Zgodność z czytnikami ekranu, powiększeniem i wymaganiami kontrastu wymaga odrębnej weryfikacji; nie deklarujemy pełnej zgodności dostępnościowej.

`pnpm test:android` wymaga emulatora Android z Chrome i ADB. Domyślny AVD to `MOST_Verification_API_36`; polecenie korzysta z portu 8093 i ponownie uruchamia Chrome. `ADB_PATH` określa program ADB, a `MOST_ANDROID_SERIAL` pozwala jawnie wskazać inny emulator. Skrypt odmawia uruchomienia na fizycznym telefonie. Testuj na instancji przeznaczonej do tej próby.

Przed użyciem operacyjnym sprawdź urządzenia, lokalną sieć, zasilanie, rzeczywisty model i procedury właścicieli usług. [Protokół próby wdrożeniowej](USER-STUDY.md) opisuje zadania dla uczestników. Badania użytkowników i pomiary pracy organizacji nie były podstawą powyższych wyników automatycznych.
