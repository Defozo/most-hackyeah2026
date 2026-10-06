# Publiczna demonstracja MOST

[Film i prezentacja](https://hackyeah-2026-projekty.defozo.chatgpt.site/#defence) są dostępne niezależnie od uruchomienia backendu. Dawny adres `phones-hwy-punch-contributing.trycloudflare.com` nie rozwiązywał się w DNS podczas sprawdzenia 6 października 2026. Poniższa instrukcja opisuje uruchomienie własnej demonstracji.

Przy uruchomieniu własnego tunelu skrypt zapisuje jego aktualny adres i wynik testu w lokalnym pliku `DEMO_ACCESS.json`. Wejście `/demo` tworzy własną syntetyczną organizację, administratora ćwiczenia i sesję przeglądarki. Nie wymaga konta odwiedzającego ani współdzielonego hasła. Przydziały, meldunki i czynności innych odwiedzających nie wchodzą do tego ćwiczenia.

## Uruchomienie i restart

```powershell
pnpm install --frozen-lockfile
pwsh -File ops/start-public-demo.ps1 -Rebuild
pnpm exec tsx ops/verify-public-demo.ts
```

Skrypt pobiera oficjalny plik cloudflared i porównuje SHA-256 z metadanymi wydania. Buduje osobny publiczny pakiet, uruchamia tunel, serwer i nadzorcę jako ukryte procesy. Jedynym sekretem wstrzykiwanym przez psst jest `MOST_SIGNING_PRIVATE_KEY`. Dane demonstracji trafiają do `data/public-demo`, a logi i identyfikatory własnych procesów do `artifacts/private/public-demo`. Skrypt odmawia przejęcia zajętego portu 8127. Przed ponownym startem należy sprawdzić właściciela tego portu i identyfikatory MOST, a potem zatrzymać wyłącznie te procesy, które mają być zastąpione.

Nadzorca (`ops/maintain-public-demo.ps1`) sprawdza proces tunelu i gotowość API co 15 sekund. Po trzech nieudanych próbach API wznawia wyłącznie rozpoznany proces MOST na istniejącej bazie. Cloudflared sam ponawia zerwane połączenia. Jeżeli zakończy się cały proces tunelu, nadzorca uruchamia nowy, zapisuje nowy adres w `DEMO_ACCESS.json` i oznacza `linkUpdateRequired: true` oraz `passed: false`. W takim przypadku opublikowane wcześniej adresy nie zmieniają się automatycznie: potrzebna jest ponowna weryfikacja i aktualizacja zgłoszenia. Plik `artifacts/private/public-demo/stop-supervisor` kończy nadzór bez zatrzymywania serwera i tunelu. Przed kolejnym uruchomieniem nadzoru należy usunąć ten znacznik.

Quick Tunnel jest dostępem demonstracyjnym. Wymaga działającego hosta, procesu serwera, tunelu i połączenia internetowego hosta. Nowy tunel ma nowy adres; po jego restarcie należy ponownie sprawdzić demo i zaktualizować odsyłacze. Tryb nie jest wdrożeniem operacyjnym. Dokumentacja dostawcy: [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Wersja publiczna powstaje w `artifacts/private/public-demo/web-release`, z manifestem w `artifacts/public-demo-release-manifest.json`. Jej Service Worker wyłącza `/demo` i `/materialy` z obsługi nawigacji PWA. Pozostałe pliki aplikacji, lokalny WASM i procedury podlegają pełnemu przygotowaniu pakietu offline.

## Izolacja i limity

- Publiczny tryb API jest domyślnie wyłączony. Pierwszy start wymaga pustego, osobnego katalogu danych. Nie można włączyć go na bazie istniejącej organizacji.
- Sesje otrzymują losowe identyfikatory i cookies `Secure`, `HttpOnly`, `SameSite=Strict`. Komendy przechodzą te same kontrole organizacji, uprawnień, Origin i CSRF co zwykła instalacja.
- Start ćwiczenia ma limit 30 żądań na minutę dla anonimowego wejścia i maksymalnie 1000 organizacji w tej instalacji. Reverse proxy kończy połączenie na localhost; anonimowe wejścia współdzielą jego limit. Uwierzytelnieni użytkownicy mają osobne budżety API. Odpowiedź 429 zawiera czas ponowienia.
- Publiczny proces nie otrzymuje kluczy modeli ani importu sieciowego. Logowanie hasłem i bootstrap są w tym trybie wyłączone. Dane mają charakter syntetyczny.
- `/materialy/` udostępnia wyłącznie `output/public`. Fastify obsługuje typy MIME i żądania Range dla filmu. Sekrety, bazy i katalogi robocze nie należą do katalogu publikacji.

## Sprawdzenie publicznej ścieżki

`ops/verify-public-demo.ts` uruchamia czystą przeglądarkę przez publiczny HTTPS, oblicza 310 i 220 usługominut, przygotowuje pakiet, odłącza sieć, przeładowuje aplikację i ponownie liczy 220. Następnie wraca online, zatwierdza trzy czynności, przyjmuje zadanie i sprawdza izolację drugiego odwiedzającego. Budżet obliczeń tego testu wynosi 30 s. Raport znajduje się w `artifacts/public-demo-verification.json`; nie zastępuje wcześniejszych pomiarów budżetu 5 s.
